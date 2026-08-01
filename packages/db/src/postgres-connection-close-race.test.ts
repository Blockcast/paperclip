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

  end(): this {
    this.readyState = "closed";
    return this;
  }
  destroy(): this {
    this.readyState = "closed";
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

  /** Abrupt peer disconnect, i.e. `close` with `hadError === false`. */
  remoteClose(): void {
    this.readyState = "closed";
    this.emit("close", false);
  }
}

const nextTick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function drainImmediates(count = 8): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await nextTick();
  }
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

interface Harness {
  sql: ReturnType<typeof postgres>;
  /** The socket backing the most recent connection attempt. */
  currentSocket: () => FakeSocket;
  /** Resolves once the driver's `closed()` has run and nulled its socket. */
  socketClosed: Promise<void>;
  shutdown: () => Promise<void>;
}

function createHarness(): Harness {
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
  } as unknown as Parameters<typeof postgres>[0]);

  return {
    sql,
    currentSocket: () => {
      if (!socket) throw new Error("no socket has been created yet");
      return socket;
    },
    socketClosed,
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
