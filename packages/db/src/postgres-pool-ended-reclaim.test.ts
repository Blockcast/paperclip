import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import postgres from "postgres";
import { POSTGRES_CLOSE_TIMEOUT_SECONDS } from "./client.js";

/**
 * Regression coverage for the unreclaimable-connection defect (BLO-35946,
 * parent BLO-35940).
 *
 * postgres.js's `Connection.end()` moves a connection into the pool's `ended`
 * queue *before* it checks whether the connection is quiescent:
 *
 *   function end() {
 *     return ending || (
 *       !connection.reserved && onend(connection),            // -> `ended`
 *       !connection.reserved && !initial && !query && sent.length === 0
 *         ? (terminate(), ...)                                // clean close
 *         : ending = new Promise(r => ended = r)              // waits, no close
 *     )
 *   }
 *
 * `handler()` draws connections from `open`, `closed` and `busy` — never
 * `ended` — so the second branch is a one-way door for any connection whose
 * in-flight query never produces a `ReadyForQuery`. On 2026-09-24 nine of ten
 * slots left `paperclip-0`'s pool this way; company-wide dispatch ran on the
 * remaining connection for 2h15m and only `pg_terminate_backend` from an
 * operator session brought the slots back.
 *
 * `patches/postgres@3.4.9.patch` adds a `close_timeout` that bounds that wait
 * and then calls `terminate()`, which is the client-side equivalent of what the
 * operator did: it rejects the in-flight query and closes the socket, so
 * `closed()` lands the connection in `closed`, which `handler()` *does* draw
 * from.
 *
 * Per the repo's mutation rule, the guard has to be individually revertible:
 * dropping `closeTimer.start()` from that branch leaves the follow-up query
 * below permanently pending, and the test reports `"pending"` rather than
 * hanging to a timeout.
 *
 * The transport is injected through postgres.js's `socket` option, so this
 * needs no database and no timing luck.
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
 * A backend that can be told to go quiet mid-query while the socket stays
 * ESTABLISHED — the observed server-side state was `active` / `ClientRead` with
 * both socket queues at 0, i.e. a peer that is connected and simply never
 * answers. Crucially it does *not* emit `close`, because a close would recover
 * the connection through the ordinary reconnect path and there would be nothing
 * to fix.
 */
class StallableSocket extends EventEmitter {
  readyState = "open";
  host = "127.0.0.1";
  port = 5432;
  /** Set before a query to make this backend stop answering. */
  stalled = false;
  private withheld = 0;
  private greeted = false;

  write(chunk: Buffer, callback?: () => void): boolean {
    const reply = this.greeted ? EMPTY_QUERY_RESULT : HANDSHAKE;
    this.greeted = true;
    if (this.stalled) this.withheld += 1;
    else setImmediate(() => this.emit("data", reply));
    callback?.();
    return true;
  }

  /** Let the backend answer everything it withheld, and resume answering. */
  answer(): void {
    this.stalled = false;
    const owed = this.withheld;
    this.withheld = 0;
    for (let index = 0; index < owed; index += 1) {
      setImmediate(() => this.emit("data", EMPTY_QUERY_RESULT));
    }
  }

  /**
   * `terminate()` calls `socket.end(...)` on an open socket. A real socket
   * sends FIN, the peer follows, and `close` fires — which is what runs the
   * driver's `closed()` and hands the connection back to the pool. Model that,
   * asynchronously, or the reclaim never completes.
   */
  end(): this {
    if (this.readyState !== "closed") {
      this.readyState = "closed";
      setImmediate(() => this.emit("close", false));
    }
    return this;
  }
  destroy(): this {
    return this.end();
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

const nextTick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function drainImmediates(count = 8): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await nextTick();
  }
}

/** Short enough to keep the test quick; the production value is asserted separately. */
const TEST_CLOSE_TIMEOUT_SECONDS = 0.3;

type PoolStats = {
  max: number;
  idle: number;
  active: number;
  connecting: number;
  waiting: number;
};

function createHarness() {
  const sockets: StallableSocket[] = [];
  const sql = postgres({
    max: 1,
    fetch_types: false,
    prepare: false,
    connect_timeout: 5,
    idle_timeout: null,
    max_lifetime: null,
    close_timeout: TEST_CLOSE_TIMEOUT_SECONDS,
    // `socket` is a real postgres.js option (src/index.js) that supplies the
    // transport; it is simply absent from the package's shipped typings, as is
    // the patched `close_timeout` above.
    socket: () => {
      const socket = new StallableSocket();
      sockets.push(socket);
      return socket;
    },
  } as unknown as Parameters<typeof postgres>[0]);

  return {
    sql,
    sockets,
    poolStats: (): PoolStats =>
      (sql as unknown as { poolStats: () => PoolStats }).poolStats(),
    /** `sql.close()` ends every connection without setting the pool's own `ending`. */
    closeConnections: () => void (sql as unknown as { close: () => Promise<void> }).close(),
  };
}

/**
 * Report how a promise stands *right now* instead of awaiting it, so a
 * still-wedged pool fails an assertion rather than expiring the test timeout.
 */
async function settlement(
  promise: Promise<unknown>,
  withinMs: number,
): Promise<"resolved" | "rejected" | "pending"> {
  return Promise.race([
    promise.then(
      () => "resolved" as const,
      () => "rejected" as const,
    ),
    new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), withinMs)),
  ]);
}

describe("postgres.js pool reclaims a connection stranded in `ended`", () => {
  it("terminates an ending connection whose in-flight query never completes", async () => {
    const harness = createHarness();
    try {
      // Open the pooled connection against a healthy backend.
      await harness.sql`select 1`;
      expect(harness.poolStats()).toMatchObject({ idle: 1, active: 0, waiting: 0 });

      // The backend goes quiet, then a query is dispatched onto it. A
      // postgres.js `Query` is lazy — it reaches the pool only once something
      // subscribes to it or calls `execute()` — so the `.catch()` here is what
      // dispatches, not just error handling. Not awaited: it can only settle
      // once the connection is reclaimed, and `terminate()` settles it by
      // rejecting.
      harness.sockets[0].stalled = true;
      const stalledQuery = harness.sql`select 2`.catch(() => undefined);
      await drainImmediates();

      // Ending a non-quiescent connection is what strands it.
      harness.closeConnections();
      await drainImmediates();

      // The incident's recorded signature: no connection in any queue
      // `handler()` can draw from, and queries piling up behind them. This is
      // the state `PaperclipDbPoolConnectionsLeaked` alerts on.
      const followUp = harness.sql`select 3`.execute();
      await drainImmediates();
      expect(harness.poolStats()).toMatchObject({
        idle: 0,
        active: 0,
        connecting: 0,
        waiting: 1,
      });

      // Past the bound, `terminate()` fires. Without it — revert
      // `closeTimer.start()` — both of these stay "pending" forever.
      await expect(settlement(stalledQuery, 2_000)).resolves.toBe("resolved");
      await expect(settlement(followUp, 2_000)).resolves.toBe("resolved");

      // Reclaimed, not merely unblocked: the pool reconnected onto a fresh
      // socket and is serving again, with no restart and no operator action.
      expect(harness.sockets.length).toBe(2);
      expect(harness.poolStats()).toMatchObject({ idle: 1, waiting: 0 });
      await expect(harness.sql`select 4`).resolves.toBeDefined();
    } finally {
      await Promise.race([
        harness.sql.end({ timeout: 0 }).catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 1_000)),
      ]);
    }
  });

  it("disarms the bound once the connection has actually terminated", async () => {
    // The bound is armed on *every* ending connection that still has a query in
    // flight, and almost all of those end normally: the query finishes, the
    // `ReadyForQuery` arrives, and `terminate()` runs long before the deadline.
    // If the timer is not cancelled there it stays armed against a connection
    // the pool has since reconnected and is serving from — so each ordinary
    // recycle would leave a `POSTGRES_CLOSE_TIMEOUT_SECONDS` bomb behind that
    // kills a healthy connection. Revert `closeTimer.cancel()` in `terminate()`
    // and the socket count below reaches 3.
    const harness = createHarness();
    try {
      await harness.sql`select 1`;

      harness.sockets[0].stalled = true;
      const stalledQuery = harness.sql`select 2`.catch(() => undefined);
      await drainImmediates();

      harness.closeConnections();
      await drainImmediates();

      // The query completes on its own, well inside the bound. That is the
      // path `end()` was waiting for: ReadyForQuery -> terminate() -> close.
      harness.sockets[0].answer();
      await stalledQuery;
      await drainImmediates();

      // The pool reconnects onto a second socket and is healthy again.
      await expect(harness.sql`select 3`).resolves.toBeDefined();
      expect(harness.sockets.length).toBe(2);

      // Sit past the original deadline. Nothing should fire.
      await new Promise((resolve) =>
        setTimeout(resolve, TEST_CLOSE_TIMEOUT_SECONDS * 1000 + 400),
      );
      await expect(harness.sql`select 4`).resolves.toBeDefined();
      expect(harness.sockets.length).toBe(2);
    } finally {
      await Promise.race([
        harness.sql.end({ timeout: 0 }).catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 1_000)),
      ]);
    }
  });

  it("leaves the bound off by default, so the patch changes nothing unasked", () => {
    // `close_timeout: null` is upstream's behaviour. Only `createDb` opts in,
    // which is what keeps this patch from altering any other postgres.js caller
    // in the tree (migrations, embedded-test admin pools, plugins).
    const sql = postgres({ host: "127.0.0.1", port: 1 });
    expect((sql as unknown as { options: { close_timeout: unknown } }).options.close_timeout)
      .toBeNull();
  });

  it("pins the production bound above the asserted 30s role-level statement_timeout", () => {
    // If a query the server would itself have killed could outlive this, the
    // bound would be cutting short work that was about to fail cleanly.
    expect(POSTGRES_CLOSE_TIMEOUT_SECONDS).toBeGreaterThan(30);
  });
});
