import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import postgres from "postgres";
import { POSTGRES_END_TIMEOUT_SECONDS, postgresMaxLifetimeSeconds } from "./client.js";

/**
 * Regression coverage for the pool that could not self-heal (BLO-35946, parent
 * BLO-35940).
 *
 * `Connection.end()` does two things in this order:
 *
 *   1. `onend(connection)` — moves the connection to the pool's `ended` queue.
 *      Unconditional. `handler()` (`src/index.js`) draws from `open`, `closed`
 *      and `busy`; it never draws from `ended`.
 *   2. *then* checks whether the connection is quiescent. With a query in
 *      flight it takes a branch that deliberately skips `terminate()` and waits
 *      on a promise resolved only when that query finally drains.
 *
 * So a connection leaves the pool first and decides how to close second, and a
 * query that never completes makes step 2 wait forever — the slot is gone until
 * the process restarts, with the socket still open and the backend orphaned.
 *
 * On 2026-09-24 that cost nine of ten slots on `paperclip-0`: `poolStats()` read
 * `active=1` against 1505 waiters and company-wide dispatch ran on a single
 * connection for 2h15m, until an operator ran `pg_terminate_backend` by hand.
 *
 * `patches/postgres@3.4.9.patch` arms an `end_timeout` watchdog on exactly that
 * waiting branch. On expiry it runs `terminate()` (rejecting the stuck query)
 * and then `socket.destroy()`, which forces the `close` event that puts the
 * connection back in the pool's `closed` queue to be reconnected on demand —
 * the same recovery path the manual `pg_terminate_backend` produced.
 *
 * The transport is injected through postgres.js's `socket` option, so these
 * tests need no database. A wedged peer is modelled directly (`responding =
 * false`) rather than waited for, so there is no timing luck either.
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

/**
 * Minimal stand-in for a connected `net.Socket`.
 *
 * The `end()`/`destroy()` asymmetry is the point and is faithful to Node: both
 * mark the socket closed, but `end()` only sends FIN, so `close` does not fire
 * until the peer answers — which a wedged peer never does. `destroy()` tears
 * the socket down locally and always emits `close`. `Connection.terminate()`
 * calls `end()`, so it alone cannot reclaim a wedged connection; that is why
 * the patch pairs it with an explicit `destroy()`.
 */
class FakeSocket extends EventEmitter {
  readyState = "open";
  host = "127.0.0.1";
  port = 5432;
  /** When false, the fake backend stops answering — a query stalls mid-protocol. */
  responding = true;
  private greeted = false;

  write(chunk: Buffer, callback?: () => void): boolean {
    if (this.responding) {
      const reply = this.greeted ? EMPTY_QUERY_RESULT : HANDSHAKE;
      this.greeted = true;
      setImmediate(() => this.emit("data", reply));
    }
    callback?.();
    return true;
  }

  /**
   * FIN. A live peer answers it and the socket closes; a wedged one never does,
   * so `close` never fires and `terminate()` alone cannot reclaim the slot.
   */
  end(): this {
    this.readyState = "closed";
    if (this.responding) setImmediate(() => this.emit("close", false));
    return this;
  }

  /** Local teardown. Node always follows this with `close`. */
  destroy(): this {
    if (this.readyState === "destroyed") return this;
    this.readyState = "destroyed";
    setImmediate(() => this.emit("close", false));
    return this;
  }

  pause(): this {
    return this;
  }
  resume(): this {
    return this;
  }
  setKeepAlive(): this {
    return this;
  }
}

type PoolStats = {
  max: number;
  idle: number;
  active: number;
  connecting: number;
  waiting: number;
};

/** Connections the pool can still hand to `handler()`. Zero means it is dead. */
const usable = (stats: PoolStats): number => stats.idle + stats.active + stats.connecting;

const MAX_LIFETIME_SECONDS = 0.05;
/** Comfortably longer than the recycle, so the leak is observable in between. */
const END_TIMEOUT_SECONDS = 0.35;

function createHarness(endTimeout: number | null) {
  const sockets: FakeSocket[] = [];
  const sql = postgres({
    max: 1,
    fetch_types: false,
    prepare: false,
    connect_timeout: 5,
    idle_timeout: null,
    // The recycle is what calls end() on a connection whose query has stalled,
    // which is the production path into this bug. Scaled down to milliseconds.
    max_lifetime: MAX_LIFETIME_SECONDS,
    // `end_timeout` is added by patches/postgres@3.4.9.patch; `socket` is a real
    // postgres.js option. Neither is in the package's shipped typings.
    end_timeout: endTimeout,
    socket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  } as unknown as Parameters<typeof postgres>[0]);

  return {
    sql,
    sockets,
    stats: () => (sql as unknown as { poolStats: () => PoolStats }).poolStats(),
    shutdown: async () => {
      await Promise.race([
        sql.end({ timeout: 0 }).catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 1_000)),
      ]);
    },
  };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(5);
  }
  return predicate();
}

/**
 * Open the pool's single connection, then strand a query on it: the peer stops
 * answering, so the query is written and never replied to. That is the state the
 * nine production backends were in (`active`/`ClientRead`, `Parse` received,
 * `Bind` never sent).
 */
async function strandQueryOnOnlyConnection(harness: ReturnType<typeof createHarness>) {
  await harness.sql`select 1`;
  harness.sockets[harness.sockets.length - 1].responding = false;

  // Deliberately not awaited: it is the query that never completes.
  let outcome = "pending";
  void harness.sql`select 1`.then(
    () => {
      outcome = "resolved";
    },
    (error: { code?: string }) => {
      outcome = error.code ?? "unknown";
    },
  );
  return () => outcome;
}

describe("postgres.js pool cannot self-heal from the `ended` queue", () => {
  it("loses the slot permanently when the end() wait is unbounded", async () => {
    // `end_timeout: null` disables the patch's watchdog, which reproduces stock
    // postgres.js. This documents the defect rather than guarding the fix — it
    // passes with or without the patch, and is here so the invariant the next
    // test pins is legible.
    const harness = createHarness(null);
    try {
      const stuckOutcome = await strandQueryOnOnlyConnection(harness);

      // max_lifetime fires -> end() -> onend() moves the only connection to
      // `ended` -> the in-flight query sends it down the waiting branch.
      const left = await waitFor(() => usable(harness.stats()) === 0, 1_000);
      expect(left).toBe(true);

      // The shape the incident was diagnosed from: connections unaccounted for
      // in every queue `handler()` can draw from, and work piling up behind them.
      let queued = false;
      void harness.sql`select 1`.then(
        () => undefined,
        () => undefined,
      );
      await waitFor(() => (queued = harness.stats().waiting > 0), 500);
      expect(queued).toBe(true);
      expect(usable(harness.stats())).toBe(0);

      // Nothing reclaims it: no reconnect is attempted and the stuck query never
      // settles. Only a process restart or a server-side terminate would clear it.
      await sleep(END_TIMEOUT_SECONDS * 1000 * 2);
      expect(usable(harness.stats())).toBe(0);
      expect(harness.sockets).toHaveLength(1);
      expect(stuckOutcome()).toBe("pending");
    } finally {
      await harness.shutdown();
    }
  });

  it("reclaims the slot without operator action once the end() wait is bounded", async () => {
    const harness = createHarness(END_TIMEOUT_SECONDS);
    try {
      const stuckOutcome = await strandQueryOnOnlyConnection(harness);

      // Same starting point: the connection is out of the pool and the pool is
      // dead. Asserted so a test that never reached the defect cannot pass.
      expect(await waitFor(() => usable(harness.stats()) === 0, 1_000)).toBe(true);

      // AC2: recovered with no restart and nothing run against the server. The
      // watchdog terminates the connection, `destroy()` forces `close`, and
      // `onclose` returns it to the pool's `closed` queue to reconnect.
      await expect(harness.sql`select 1`).resolves.toBeDefined();

      // A second socket is the proof it reconnected rather than merely unblocking.
      expect(harness.sockets.length).toBeGreaterThan(1);
      expect(usable(harness.stats())).toBeGreaterThan(0);

      // The stranded query is rejected rather than left hanging forever, so the
      // caller gets an error it can retry instead of a promise that never settles.
      expect(await waitFor(() => stuckOutcome() !== "pending", 500)).toBe(true);
      expect(stuckOutcome()).toBe("CONNECTION_DESTROYED");
    } finally {
      await harness.shutdown();
    }
  });

  it("ships a production pool whose end() wait is bounded and whose recycle is explicit", () => {
    // AC4: both values are set by `createDb` rather than inherited, so the
    // recycle age is readable here instead of only inside the vendored library.
    expect(POSTGRES_END_TIMEOUT_SECONDS).toBeGreaterThan(0);
    for (let i = 0; i < 50; i += 1) {
      const seconds = postgresMaxLifetimeSeconds();
      expect(seconds).toBeGreaterThanOrEqual(30 * 60);
      expect(seconds).toBeLessThanOrEqual(60 * 60);
    }
  });
});
