import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import postgres from "postgres";

/**
 * Regression coverage for the postgres.js queued-write-after-close race
 * (BLO-19583, parent BLO-19578; upstream porsager/postgres#1154).
 *
 * `Connection.write()` buffers sub-1024-byte payloads and flushes them from a
 * `setImmediate(nextWrite)` callback. `closed()` nulls `socket` synchronously
 * when the peer disconnects. A write queued *after* that point therefore ran
 * `socket.write(...)` against `null` inside the immediate — outside every
 * `try/catch` on the stack — so it escaped as an `uncaughtException` and killed
 * paperclip-0:
 *
 *   TypeError: Cannot read properties of null (reading 'write')
 *       at Immediate.nextWrite (postgres/src/connection.js:255:22)
 *       at process.processImmediate (node:internal/timers:504:21)
 *
 * `patches/postgres@3.4.9.patch` guards the dereference and routes the affected
 * query through the driver's normal connection-closed path. Reverting that patch
 * makes the first test below fail with the exact TypeError above.
 *
 * The transport is injected through postgres.js's `socket` option, so these
 * tests need no database and no timing luck.
 */

const int32 = (value: number): Buffer => {
  const buf = Buffer.alloc(4);
  buf.writeInt32BE(value);
  return buf;
};

const message = (type: string, payload: Buffer = Buffer.alloc(0)): Buffer =>
  Buffer.concat([Buffer.from(type, "latin1"), int32(4 + payload.length), payload]);

const AUTHENTICATION_OK = message("R", int32(0));
const READY_FOR_QUERY = message("Z", Buffer.from("I", "latin1"));
const HANDSHAKE = Buffer.concat([AUTHENTICATION_OK, READY_FOR_QUERY]);
/** ParseComplete, BindComplete, NoData, CommandComplete, ReadyForQuery. */
const EMPTY_QUERY_RESULT = Buffer.concat([
  message("1"),
  message("2"),
  message("n"),
  message("C", Buffer.from("SELECT 0\0", "latin1")),
  READY_FOR_QUERY,
]);

/** Minimal stand-in for a connected `net.Socket` speaking just enough protocol. */
class FakeSocket extends EventEmitter {
  readyState = "open";
  host = "127.0.0.1";
  port = 5432;
  /** When false, the fake backend stops answering (simulates a dead peer). */
  responding = true;
  /** Every payload the driver actually flushed, in order. */
  readonly written: Buffer[] = [];
  private greeted = false;

  write(chunk: Buffer, callback?: () => void): boolean {
    this.written.push(Buffer.from(chunk));
    if (this.responding) {
      const reply = this.greeted ? EMPTY_QUERY_RESULT : HANDSHAKE;
      this.greeted = true;
      setImmediate(() => this.emit("data", reply));
    }
    callback?.();
    return true;
  }

  end(): this {
    // A responsive peer answers a FIN by closing too, so `close` follows. A
    // wedged one does not — which is why `closeTimedOut()` cannot rely on
    // `terminate()`'s half-close and calls `destroy()` as well.
    const wasOpen = !this.destroyed;
    this.readyState = "closed";
    if (wasOpen && this.responding) {
      this.destroyed = true;
      setImmediate(() => this.emit("close", false));
    }
    return this;
  }
  /**
   * `net.Socket.destroy()` always emits `close`, asynchronously, even when the
   * peer never answers. That guarantee is the whole reason `closeTimedOut()`
   * calls it rather than relying on `terminate()`'s half-close, so the fake
   * has to reproduce it or the test would pass for the wrong reason.
   */
  destroy(): this {
    const wasOpen = !this.destroyed;
    this.readyState = "closed";
    if (wasOpen) {
      this.destroyed = true;
      setImmediate(() => this.emit("close", false));
    }
    return this;
  }
  private destroyed = false;
  pause(): this {
    return this;
  }
  resume(): this {
    return this;
  }
  setKeepAlive(): this {
    return this;
  }

  /** The backend finally answers a query it had left in flight. */
  respondNow(): void {
    this.emit("data", EMPTY_QUERY_RESULT);
  }

  /** Abrupt peer disconnect, i.e. `close` with `hadError === false`. */
  remoteClose(): void {
    this.readyState = "closed";
    this.destroyed = true;
    this.emit("close", false);
  }
}

const nextTick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function drainImmediates(count = 8): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await nextTick();
  }
}

/** Poll `predicate` until it holds, or give up. Returns whether it held. */
async function waitFor(predicate: () => boolean, budgetMs = 1_000): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return predicate();
}

/**
 * Swap vitest's `uncaughtException` handlers out for a recorder, so an escaping
 * throw is asserted on directly instead of tearing down the worker.
 */
function captureUncaughtExceptions(): { errors: Error[]; restore: () => void } {
  const previous = process.listeners("uncaughtException");
  const errors: Error[] = [];
  const recorder = (error: Error): void => {
    errors.push(error);
  };
  process.removeAllListeners("uncaughtException");
  process.on("uncaughtException", recorder);
  return {
    errors,
    restore: () => {
      process.removeListener("uncaughtException", recorder);
      for (const listener of previous) {
        process.on("uncaughtException", listener as (error: Error) => void);
      }
    },
  };
}

/** Shape of the `poolStats()` accessor added by `patches/postgres@3.4.9.patch`. */
type PoolStats = {
  max: number;
  idle: number;
  active: number;
  connecting: number;
  waiting: number;
};

interface Harness {
  sql: ReturnType<typeof postgres>;
  /** The socket backing the most recent connection attempt. */
  currentSocket: () => FakeSocket;
  /** Resolves once the driver's `closed()` has run and nulled its socket. */
  socketClosed: Promise<void>;
  /** Pool queue lengths, from the `poolStats()` accessor added by our patch. */
  poolStats: () => PoolStats;
  shutdown: () => Promise<void>;
}

function createHarness(overrides: Record<string, unknown> = {}): Harness {
  let socket: FakeSocket | null = null;
  let markClosed: () => void = () => {};
  const socketClosed = new Promise<void>((resolve) => {
    markClosed = resolve;
  });

  const sql = postgres({
    max: 1,
    fetch_types: false,
    prepare: false,
    connect_timeout: 5,
    idle_timeout: null,
    // Keep the driver from parking a multi-minute lifetime timer that would
    // otherwise hold the vitest worker's event loop open after the test.
    max_lifetime: null,
    onclose: () => markClosed(),
    // `socket` is a real postgres.js option (src/index.js:495) that supplies the
    // transport; it is simply absent from the package's shipped typings.
    socket: () => {
      socket = new FakeSocket();
      return socket;
    },
    ...overrides,
  } as unknown as Parameters<typeof postgres>[0]);

  return {
    sql,
    currentSocket: () => {
      if (!socket) throw new Error("no socket has been created yet");
      return socket;
    },
    socketClosed,
    poolStats: () => (sql as unknown as { poolStats: () => PoolStats }).poolStats(),
    shutdown: async () => {
      await Promise.race([
        sql.end({ timeout: 0 }).catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 1_000)),
      ]);
    },
  };
}

/** Opens the pooled connection, then reserves it so queries reach `Connection.execute()` directly. */
async function openAndReserve(harness: Harness) {
  await harness.sql`select 1`;
  return harness.sql.reserve();
}

describe("postgres.js queued-write-after-close race", () => {
  it("rejects a write queued after the socket closed, without throwing in the immediate", async () => {
    const harness = createHarness();
    const uncaught = captureUncaughtExceptions();
    try {
      const reserved = await openAndReserve(harness);
      const socket = harness.currentSocket();

      // Kill the peer and wait until closed() has nulled the driver's socket.
      socket.responding = false;
      socket.remoteClose();
      await harness.socketClosed;
      await drainImmediates(2);

      // A reserved handle dispatches straight to Connection.execute(), which
      // only short-circuits on `terminated` — never set by an abrupt close. So
      // this queues setImmediate(nextWrite) against a null socket.
      //
      // Deliberately not awaited: without the patch this query never settles,
      // and awaiting it would surface the regression as an opaque test timeout
      // instead of the assertions below.
      let outcome = "pending";
      void reserved`select 1`.execute().then(
        () => {
          outcome = "resolved";
        },
        (error: { code?: string }) => {
          outcome = error.code ?? "unknown";
        },
      );
      await drainImmediates();

      expect(uncaught.errors.map((error) => error.message)).toEqual([]);
      expect(outcome).toBe("CONNECTION_CLOSED");

      // AC2: the pool must still recover on the next operation.
      await expect(harness.sql`select 1`).resolves.toBeDefined();
    } finally {
      uncaught.restore();
      await harness.shutdown();
    }
  });

  it("cancels a write already queued when the socket closes underneath it", async () => {
    const harness = createHarness();
    const uncaught = captureUncaughtExceptions();
    try {
      const reserved = await openAndReserve(harness);
      const socket = harness.currentSocket();
      socket.responding = false;

      let outcome = "pending";
      void reserved`select 1`.execute().then(
        () => {
          outcome = "resolved";
        },
        (error: { code?: string }) => {
          outcome = error.code ?? "unknown";
        },
      );

      // Let the query dispatch through microtasks so write() has queued its
      // immediate, then close within the same macrotask — before it fires.
      for (let index = 0; index < 20; index += 1) {
        await Promise.resolve();
      }
      socket.remoteClose();
      await drainImmediates();

      expect(uncaught.errors.map((error) => error.message)).toEqual([]);
      expect(outcome).toBe("CONNECTION_CLOSED");
    } finally {
      uncaught.restore();
      await harness.shutdown();
    }
  });
});

/**
 * Regression coverage for the stale write handle that strands a reconnect
 * (BLO-35946; the *trigger* half, where the pool self-heal below is the
 * consequence half).
 *
 * `write()` only schedules a flush when `nextWriteTimer === null`:
 *
 *   nextWriteTimer === null && (nextWriteTimer = setImmediate(nextWrite))
 *
 * `terminate()` and `closed()` both called `clearImmediate(nextWriteTimer)`
 * without resetting the handle to `null`, and `closed()` left `chunk` alone as
 * well. Only `nextWrite()` reset either. The `Connection` object is reused
 * across reconnects and `connected()` writes the StartupMessage through
 * `write()` -- 83 bytes, far under the 1024-byte threshold that flushes
 * eagerly. So if the connection went away between a `write()` and its pending
 * immediate, the next connection's startup packet was buffered and never sent:
 * the socket sat silent until `connect_timeout`, and whatever was left in
 * `chunk` from the previous socket's protocol stream was prepended to it.
 *
 * This is the shape reported on BLO-35940 -- a backend that received `Parse`
 * (over 1024 bytes for a wide SELECT, so flushed eagerly) and never received
 * the much smaller `Bind`/`Execute`/`Sync`, leaving it in `active`/`ClientRead`
 * with `backend_xmin` and `backend_xid` both NULL. It is *a* path into that
 * state, reproduced here; it is not a claim that it is the only one.
 *
 * Both halves of the fix are killed individually by this one test: keep the
 * stale handle and nothing is written at all; clear the handle but keep
 * `chunk` and the startup packet goes out with the stale bytes in front of it.
 */
describe("postgres.js reconnect after the connection went away mid-write", () => {
  it("flushes the new connection's startup packet instead of stranding it", async () => {
    const harness = createHarness();
    try {
      await harness.sql`select 1`;
      const first = harness.currentSocket();
      first.responding = false;

      // Dispatch a query and let it reach write(), which buffers the payload
      // and queues setImmediate(nextWrite). Draining microtasks gets the write
      // queued without advancing to the macrotask that would flush it.
      void harness.sql`select 2`.catch(() => undefined);
      for (let index = 0; index < 20; index += 1) {
        await Promise.resolve();
      }
      // Close inside that window, so closed() runs with the immediate pending.
      first.remoteClose();

      // The pool reconnects on a backoff timer rather than an immediate, so
      // wait on the clock for the new socket rather than on setImmediate.
      void harness.sql`select 3`.catch(() => undefined);
      const reconnected = await waitFor(() => harness.currentSocket() !== first, 2_000);
      expect(reconnected).toBe(true);
      await drainImmediates();

      const second = harness.currentSocket();

      // The startup packet reached the socket at all: with the stale handle
      // still non-null, write() never schedules the flush and this is empty.
      expect(second.written.length).toBeGreaterThan(0);

      // ...and it reached it intact. A leftover `chunk` is prepended, so the
      // first four bytes stop being this message's own length and the protocol
      // version stops being 3.0 (196608).
      const startup = second.written[0];
      expect(startup.readInt32BE(0)).toBe(startup.length);
      expect(startup.readInt32BE(4)).toBe(196608);
    } finally {
      await harness.shutdown();
    }
  });
});

/**
 * Regression coverage for the pool that cannot self-heal (BLO-35946, parent
 * BLO-35940).
 *
 * `Connection.end()` calls `onend(connection)` — which moves the connection to
 * the pool's terminal `ended` queue — *before* it checks whether the connection
 * is quiescent. `handler()` draws from `open`, `closed` and `busy`, never from
 * `ended`, so from that moment the slot is out of the pool. When a query is
 * still in flight `end()` takes the branch that deliberately skips
 * `terminate()` and waits instead, and `terminate()` is the only thing that
 * resolves the wait and lets `closed()` -> `onclose` hand the slot back.
 *
 * So a query that never completes leaked its slot permanently, with the
 * server-side backend orphaned in `active`/`ClientRead` where no
 * `statement_timeout`, no `idle_in_transaction_session_timeout` and no TCP
 * keepalive can reap it. On 2026-09-24 that consumed 9 of paperclip-0's 10
 * slots and stalled company-wide run dispatch for 2h15m; recovery needed a
 * manual `pg_terminate_backend`.
 *
 * `close_timeout` (this repo's patch) bounds the wait. The two tests below are
 * the same scenario with the bound on and off, so the second one documents the
 * defect and is the standing negative control for the first.
 *
 * The in-flight-forever state is produced by letting the fake backend go silent
 * mid-query. `end()` is reached by an explicit `sql.close()` once the pool
 * reports the connection busy, rather than by letting `max_lifetime` expire on
 * a timer: both funnel through `Connection.end()`, which is the code under
 * test, but only the explicit call is ordered against the test's own setup. An
 * earlier revision used `max_lifetime: 0.2` and flaked at ~5% under a loaded
 * runner, because the 200ms deadline could land between "go silent" and
 * "dispatch the stuck query" and retire the connection onto a *fresh*,
 * still-answering socket. Measured 0/128 after the change, 9/128 before.
 *
 * Mutation status of the six guards in the patch, measured 2026-09-24 by
 * reverting each alone against this suite:
 *   - `closeTimer.start()` in `end()`            -> killed (test 1)
 *   - `socket.destroy()` in `closeTimedOut()`    -> killed (test 1)
 *   - the write-handle reset in `closed()`       -> killed (reconnect test)
 *   - the write-handle reset in `terminate()`    -> SURVIVES alone
 *   - `closeTimer.cancel()` in `terminate()`  \
 *   - `closeTimer.cancel()` in `closed()`     /  -> killed only as a PAIR (test 3)
 *
 * Two survivors, both for the same reason and both deliberately kept. The
 * cancels mask each other on the path test 3 exercises: either one alone
 * disarms the stale bound there. The write-handle reset in `terminate()` is
 * masked by the one in `closed()`, because a terminated socket normally emits
 * `close` straight afterwards and `closed()` then does the reset. Each is kept
 * because it covers a release path the other does not — `terminate()` without a
 * following `closed()` (a peer that never answers the half-close), and an
 * abrupt peer close with no `terminate()` at all. Do not delete one on the
 * strength of its mutation surviving; the reverted pair is killed in both
 * cases, which is what says the guard is load-bearing.
 */
describe("postgres.js pool self-heal after an in-flight query never completes", () => {
  /** How long `end()` waits for the in-flight query before terminating. */
  const CLOSE_TIMEOUT_SECONDS = 0.4;
  /** Comfortably past the bound, and far short of vitest's default test timeout. */
  const RECOVERY_BUDGET_MS = 2_000;

  /**
   * Drives one connection into "retired with a query that will never answer",
   * then reports whether the pool ever serves again.
   */
  async function leakThenProbe(harness: Harness) {
    // Open and settle the pooled connection, so the next query is dispatched
    // onto a live connection rather than racing the handshake.
    await harness.sql`select 1`;

    // The backend goes silent. This query is written and never answered, which
    // is the `active`/`ClientRead` state observed in the incident.
    harness.currentSocket().responding = false;
    let stuckOutcome = "pending";
    const stuck = harness.sql`select 2`.then(
      () => {
        stuckOutcome = "resolved";
      },
      (error: { code?: string }) => {
        stuckOutcome = error.code ?? "unknown";
      },
    );

    // Queries dispatch on a microtask, so end() must not be reached until the
    // connection is genuinely busy — otherwise it finds it quiescent,
    // terminates immediately, and never takes the branch under test.
    expect(await waitFor(() => harness.poolStats().active === 1)).toBe(true);
    // `close()` ends every connection while leaving the pool usable; it is a
    // real postgres.js export (src/index.js:88) missing from the typings.
    void (harness.sql as unknown as { close: () => Promise<void> }).close();

    // end() moved the connection to the `ended` queue. Probing before this
    // point would prove nothing: the connection is still in `busy`, so
    // `handler()` would pipeline the probe onto the same wedged socket instead
    // of queueing it. Draining every drawable queue is exactly the state that
    // made `waiting` climb to 1505 on paperclip-0 while `idle`/`connecting`
    // sat at 0.
    const leaked = await waitFor(() => {
      const stats = harness.poolStats();
      return stats.idle + stats.active + stats.connecting === 0;
    });

    // New work arriving after the slots are gone. Deliberately not awaited
    // directly: without the bound it never settles, and awaiting it would
    // surface the regression as an opaque test timeout instead of an assertion.
    const probe = harness.sql`select 3`.then(
      () => "recovered",
      (error: { code?: string }) => `rejected:${error.code ?? "unknown"}`,
    );
    const recovery = await Promise.race([
      probe,
      new Promise<string>((resolve) => setTimeout(() => resolve("still-leaked"), RECOVERY_BUDGET_MS)),
    ]);

    void stuck;
    return { leaked, recovery, stuckOutcome: () => stuckOutcome };
  }

  it("reclaims the slot once close_timeout expires, with no restart and no operator action", async () => {
    const harness = createHarness({
      max_lifetime: null,
      close_timeout: CLOSE_TIMEOUT_SECONDS,
    });
    try {
      const { leaked, recovery, stuckOutcome } = await leakThenProbe(harness);

      // The scenario actually reproduced: the slot did leave the pool.
      expect(leaked).toBe(true);

      // AC2: the pool serves again on its own.
      expect(recovery).toBe("recovered");

      // The stuck query is failed rather than left hanging, through the
      // driver's own connection-destroyed path.
      expect(stuckOutcome()).toBe("CONNECTION_DESTROYED");

      // AC1/AC2 stated as the pool arithmetic that made the incident legible:
      // every slot is back in a queue `handler()` can draw from, and nothing
      // is queued behind an unavailable connection.
      const stats = harness.poolStats();
      expect(stats.idle + stats.active + stats.connecting).toBe(stats.max);
      expect(stats.waiting).toBe(0);
    } finally {
      await harness.shutdown();
    }
  });

  it("leaks the slot permanently when close_timeout is disabled (the pre-fix behaviour)", async () => {
    // `timer()` returns a no-op pair for a falsy interval, so this is exactly
    // the unbounded `end()` wait as shipped by postgres.js 3.4.9.
    const harness = createHarness({
      max_lifetime: null,
      close_timeout: null,
    });
    try {
      const { leaked, recovery, stuckOutcome } = await leakThenProbe(harness);

      expect(leaked).toBe(true);
      expect(recovery).toBe("still-leaked");
      // Still in flight: nothing ever terminated the connection.
      expect(stuckOutcome()).toBe("pending");

      // The incident's signature: no connection in any drawable queue, and
      // work piling up behind them. On paperclip-0 this read
      // `idle=0, active=1, connecting=0` with `waiting` climbing to 1505.
      const stats = harness.poolStats();
      expect(stats.idle + stats.active + stats.connecting).toBe(0);
      expect(stats.waiting).toBeGreaterThan(0);
    } finally {
      await harness.shutdown();
    }
  });

  /**
   * A retired-with-query-in-flight connection whose query then goes away by
   * `release`, leaving the Connection object to be reused by the next
   * reconnect. Returns the outcome of a query held in flight across the
   * instant the now-stale bound would have fired.
   *
   * This test leaves `max_lifetime` off on purpose: a `max_lifetime`-driven
   * second `end()` would call `closeTimer.start()`, whose own `clearTimeout`
   * would mask a missing cancel and make this pass for the wrong reason.
   *
   * It does assume the backend answers within `close_timeout` of `close()` —
   * if a loaded runner lost that race the bound would fire first and the query
   * would be destroyed rather than resolved. That is asserted on directly
   * (`heldOutcome`), so losing it fails loudly instead of passing vacuously.
   */
  async function releaseThenHoldAcrossDeadline(
    harness: Harness,
    release: (socket: FakeSocket, held: Promise<string>) => Promise<unknown>,
  ) {
    await harness.sql`select 1`;
    const first = harness.currentSocket();

    first.responding = false;
    const held = harness.sql`select 2`.then(
      () => "resolved",
      (error: { code?: string }) => `rejected:${error.code ?? "unknown"}`,
    );
    // Queries dispatch on a microtask, so close() must not be called until the
    // connection is genuinely busy — otherwise end() finds it quiescent,
    // terminates immediately, and never arms the bound this test is about.
    expect(await waitFor(() => harness.poolStats().active === 1)).toBe(true);
    // `close()` ends every connection while leaving the pool usable; it is a
    // real postgres.js export (src/index.js:88) missing from the typings.
    void (harness.sql as unknown as { close: () => Promise<void> }).close();
    expect(await waitFor(() => harness.poolStats().active === 0)).toBe(true);

    const heldOutcome = await release(first, held);

    // Reconnect onto a fresh socket, then hold a query across the instant the
    // stale bound would have fired.
    await harness.sql`select 3`;
    const second = harness.currentSocket();
    expect(second).not.toBe(first);

    second.responding = false;
    let survivorOutcome = "pending";
    void harness.sql`select 4`.then(
      () => {
        survivorOutcome = "resolved";
      },
      (error: { code?: string }) => {
        survivorOutcome = error.code ?? "unknown";
      },
    );

    await new Promise((resolve) => setTimeout(resolve, CLOSE_TIMEOUT_SECONDS * 1000 + 350));
    return { heldOutcome, survivorOutcome: () => survivorOutcome };
  }

  it("disarms the bound when the in-flight query finishes, so it cannot kill the reconnected connection", async () => {
    const harness = createHarness({ max_lifetime: null, close_timeout: CLOSE_TIMEOUT_SECONDS });
    try {
      // The backend answers after all, so `ReadyForQuery` reaches terminate().
      const { heldOutcome, survivorOutcome } = await releaseThenHoldAcrossDeadline(
        harness,
        async (socket, held) => {
          socket.responding = true;
          socket.respondNow();
          return held;
        },
      );

      expect(heldOutcome).toBe("resolved");
      // Still in flight on a healthy connection — nothing terminated it.
      expect(survivorOutcome()).toBe("pending");
    } finally {
      await harness.shutdown();
    }
  });
});
