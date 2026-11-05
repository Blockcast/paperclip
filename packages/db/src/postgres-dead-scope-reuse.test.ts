/**
 * Regression coverage for a postgres.js scope that outlives its connection
 * (BLO-52499 follow-up).
 *
 * When a `sql.begin()` transaction's backend dies (idle-in-transaction timeout,
 * pg_terminate_backend), the driver's pool `onclose` rejects `begin()` and
 * immediately reconnects the SAME `Connection` object for the next caller. The
 * transaction's scope keeps running its callback, and its handler still
 * dispatches to that object. So upstream sends the dead transaction's later
 * queries, and its final ROLLBACK or COMMIT, into whatever session now owns the
 * connection. A ROLLBACK silently discards another caller's writes; a COMMIT
 * commits them early. `sql.reserve()` has the same shape, and its `release()`
 * hands the next owner's connection back to the pool. When nothing has reused
 * the object yet, a parameterized late statement strands the pool slot, and
 * statements parked in the scope's own queue never settle.
 *
 * The connection-level state of the dead session leaked the same way: the next
 * session's startup consumed its stashed FATAL (rejecting an innocent queued
 * query with 57P01), and a statement written between a socket's 'error' and
 * 'close' events stayed in flight forever and wedged the next session. A
 * cursor's continuation wrote into the next session and threw an unhandled
 * rejection.
 *
 * `patches/postgres@3.4.9.patch` binds every begin/reserve scope to the session
 * it started on (`Connection.session`, bumped on close), refuses every later
 * statement with CONNECTION_CLOSED before it can reach the connection, settles
 * the scope's local queue on close, makes a stale `release()` a no-op, and resets
 * the per-session state in `closed()`.
 *
 * Clearing that state removed the dead session's FATAL, which upstream had
 * relied on by accident in three places. The patch fixes each one properly:
 * - a reserve() queued behind the dead connection is handed the reconnected
 *   one;
 * - a cursor loop whose session dies mid-iteration throws instead of ending
 *   early;
 * - a type fetch that dies during startup no longer leaves an unhandled
 *   rejection.
 *
 * Every test here fails on the pre-patch driver, with one exception: the
 * failed-connect reserve() test guards a failure mode that the hand-off fix
 * would otherwise introduce. Each part of the patch is pinned by a test that
 * fails without that part.
 *
 * Most tests kill a backend on a pool of ONE connection, so the next caller is
 * guaranteed to reuse the dead scope's `Connection` object.
 */
import net from "node:net";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
  type EmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();

type Sql = postgres.Sql;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls until `cond` holds; a bounded stand-in for an event the driver does not expose. */
async function until(cond: () => boolean | Promise<boolean>, what: string) {
  for (let i = 0; i < 200; i++) {
    if (await cond()) return;
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** The pool's queue lengths, exported by patches/postgres@3.4.9.patch (BLO-33243). */
const poolStats = (client: postgres.Sql) =>
  (client as unknown as { poolStats(): { active: number; waiting: number } }).poolStats();

/**
 * Settles with the value, the error's code, or `hung`, so a hang fails an
 * assertion instead of the test timeout. Subscribing dispatches a lazy query
 * and attaches its rejection handler at once.
 */
const within = (p: PromiseLike<unknown>, ms: number) =>
  Promise.race([
    Promise.resolve(p).then(
      (value) => ({ value }),
      (error: { code?: string }) => ({ error: error?.code ?? String(error) }),
    ),
    sleep(ms).then(() => ({ hung: true })),
  ]);

// Long enough for a stale statement, which upstream writes within a few
// microtasks, to reach the socket ahead of the next caller's statement.
const STALE_WRITE_SETTLE_MS = 250;

describe.skipIf(!support.supported)("postgres.js scope that outlives its connection", () => {
  let dbh: EmbeddedPostgresTestDatabase;
  let admin: Sql;
  let sql: Sql;

  beforeAll(async () => {
    dbh = await startEmbeddedPostgresTestDatabase("pg-dead-scope");
    admin = postgres(dbh.connectionString, { max: 1, onnotice: () => {} });
  }, 180_000);

  afterAll(async () => {
    await admin?.end();
    await dbh?.cleanup();
  });

  beforeEach(async () => {
    await admin.unsafe("drop table if exists dead_scope_rows; create table dead_scope_rows (n int)");
    sql = postgres(dbh.connectionString, { max: 1, onnotice: () => {} });
    return async () => {
      await sql.end({ timeout: 5 });
    };
  });

  /** Waits until `pid` is inside pg_sleep(), i.e. its statement is running server-side. */
  const waitForPgSleep = (pid: number) =>
    until(async () => {
      const [{ sleeping }] = await admin<{ sleeping: boolean }[]>`
        select exists (select 1 from pg_stat_activity where pid = ${pid} and wait_event = 'PgSleep') as sleeping
      `;
      return sleeping;
    }, `backend ${pid} to sleep`);

  const rows = async () =>
    (await admin<{ n: number }[]>`select n from dead_scope_rows order by n`).map((row) => row.n);

  /**
   * Opens a transaction, lets Postgres kill its backend while it waits on
   * `gate`, and resolves once `begin()` has rejected. The callback then runs
   * `afterGate` on the dead scope when the test resolves `gate`.
   */
  async function killedTransaction(afterGate: (tx: postgres.TransactionSql) => Promise<unknown>) {
    const gate = deferred();
    const begun = sql.begin(async (tx) => {
      await tx`select set_config('idle_in_transaction_session_timeout', '300', true)`;
      await gate.promise;
      return afterGate(tx);
    });
    await expect(begun).rejects.toThrow();
    return gate;
  }

  /** A reserved connection with an open transaction whose backend has been idle-killed. */
  async function killedReservation() {
    const reserved = await sql.reserve();
    await reserved`select set_config('idle_in_transaction_session_timeout', '300', false)`;
    const [{ pid }] = await reserved<{ pid: number }[]>`select pg_backend_pid() as pid`;
    await reserved.unsafe("begin");
    await waitForBackendGone(pid);
    // The server dropping the backend is not enough: until the driver has run
    // its own close, release() still sees a live reservation. Wait until the
    // pool no longer counts the reserved slot as active.
    await until(() => poolStats(sql).active === 0, "the driver to see the close");
    return reserved;
  }

  it("never sends a dead transaction's ROLLBACK into the next transaction on its reused connection", async () => {
    const gate = await killedTransaction(async () => {
      throw new Error("the dead transaction's callback fails");
    });

    await sql.begin(async (tx) => {
      await tx`insert into dead_scope_rows values (1)`;
      gate.resolve();
      await sleep(STALE_WRITE_SETTLE_MS);
      await tx`insert into dead_scope_rows values (2)`;
    });

    expect(await rows()).toEqual([1, 2]);
  });

  it("never sends a dead transaction's COMMIT into the next transaction on its reused connection", async () => {
    const gate = await killedTransaction(async () => "the dead transaction's callback succeeds");

    await expect(
      sql.begin(async (tx) => {
        await tx`insert into dead_scope_rows values (1)`;
        gate.resolve();
        await sleep(STALE_WRITE_SETTLE_MS);
        await tx`insert into dead_scope_rows values (2)`;
        throw new Error("the next transaction rolls back");
      }),
    ).rejects.toThrow("the next transaction rolls back");

    expect(await rows()).toEqual([]);
  });

  it("refuses a dead transaction's own late query instead of running it on the reused connection", async () => {
    let late: unknown;
    const gate = await killedTransaction(async (tx) => {
      late = await within(tx`insert into dead_scope_rows values (99)`, 2_000);
    });

    await sql.begin(async (tx) => {
      await tx`insert into dead_scope_rows values (1)`;
      gate.resolve();
      await sleep(STALE_WRITE_SETTLE_MS);
      await tx`insert into dead_scope_rows values (2)`;
    });

    expect(late).toEqual({ error: "CONNECTION_CLOSED" });
    expect(await rows()).toEqual([1, 2]);
  });

  it("does not strand the pool slot when a dead transaction issues a parameterized statement", async () => {
    // Parameterized and not yet prepared, so upstream's `c.execute(q) || move(c, full)`
    // parked the socket-less connection in `full`, where nothing ever retrieves it.
    let late: unknown;
    const settled = deferred();
    const gate = await killedTransaction(async (tx) => {
      late = await within(tx`select ${1}::int as x`, 2_000);
      settled.resolve();
    });
    gate.resolve();
    await settled.promise;

    expect(late).toEqual({ error: "CONNECTION_CLOSED" });
    expect(await within(sql`select 1 as x`, 3_000)).toEqual({ value: [{ x: 1 }] });
  });

  it("settles a statement parked in a transaction's local queue when its backend dies", async () => {
    let behind: unknown;
    const settled = deferred();
    void sql
      .begin(async (tx) => {
        const [{ pid }] = await tx<{ pid: number }[]>`select pg_backend_pid() as pid`;
        // Parameterized, so the connection goes `full` and the next statement
        // waits in begin()'s own queue, whose only drain died with the session.
        void tx`select pg_sleep(${3})`.catch(() => {});
        const parked = within(tx`select 2 as x`, 3_000);
        await waitForPgSleep(pid);
        await admin`select pg_terminate_backend(${pid})`;
        behind = await parked;
        settled.resolve();
      })
      .catch(() => {});
    await settled.promise;

    expect(behind).toEqual({ error: "CONNECTION_CLOSED" });
  });

  it("settles a statement parked in a reserved connection's local queue when its backend dies", async () => {
    const reserved = await sql.reserve();
    const [{ pid }] = await reserved<{ pid: number }[]>`select pg_backend_pid() as pid`;
    void reserved`select pg_sleep(${3})`.catch(() => {});
    const parked = within(reserved`select 2 as x`, 3_000);
    await waitForPgSleep(pid);
    await admin`select pg_terminate_backend(${pid})`;

    expect(await parked).toEqual({ error: "CONNECTION_CLOSED" });
    reserved.release();
    expect(await within(sql`select 1 as x`, 3_000)).toEqual({ value: [{ x: 1 }] });
  });

  it("never sends a dead reserved connection's ROLLBACK into the next owner's transaction", async () => {
    const reserved = await killedReservation();

    await sql.begin(async (tx) => {
      await tx`insert into dead_scope_rows values (1)`;
      expect(await within(reserved.unsafe("rollback"), 2_000)).toEqual({ error: "CONNECTION_CLOSED" });
      await sleep(STALE_WRITE_SETTLE_MS);
      await tx`insert into dead_scope_rows values (2)`;
    });

    expect(await rows()).toEqual([1, 2]);
  });

  it("does not hand the next owner's connection back to the pool on a stale release()", async () => {
    const reserved = await killedReservation();

    let unrelated: Promise<unknown> | undefined;
    await expect(
      sql.begin(async (tx) => {
        await tx`insert into dead_scope_rows values (1)`;
        reserved.release();
        // An unrelated pool query. It must wait for this transaction, not run
        // inside it on a connection the stale release() put back in the pool.
        unrelated = sql`insert into dead_scope_rows values (3)`.execute();
        await sleep(STALE_WRITE_SETTLE_MS);
        throw new Error("the owner rolls back");
      }),
    ).rejects.toThrow("the owner rolls back");
    await unrelated;

    expect(await rows()).toEqual([3]);
  });

  it("keeps the pool usable after release() of a reserved connection that died while idle", async () => {
    const reserved = await killedReservation();

    // Nothing has reused the object: upstream pulled it, socket-less, from
    // `closed` into `open`, and every later query failed CONNECTION_CLOSED.
    reserved.release();

    expect(await within(sql`select 1 as x`, 3_000)).toEqual({ value: [{ x: 1 }] });
    expect(await within(sql`select 2 as x`, 3_000)).toEqual({ value: [{ x: 2 }] });
  });

  it("does not reject the next pooled query with the terminated session's error", async () => {
    const [{ pid }] = await sql<{ pid: number }[]>`select pg_backend_pid() as pid`;
    // Parameterized, so the connection goes `full` and `next` waits in the pool backlog.
    const killed = within(sql`select pg_sleep(${5})`, 5_000);
    const next = within(sql`select 42 as x`, 5_000);
    await waitForPgSleep(pid);
    await until(() => poolStats(sql).waiting === 1, "the next query to queue");
    await admin`select pg_terminate_backend(${pid})`;

    expect(await killed).toEqual({ error: "CONNECTION_CLOSED" });
    expect(await next).toEqual({ value: [{ x: 42 }] });
  });

  it("does not offset the next session's first result by rows the dead session had streamed", async () => {
    // Without fetch_types there is no handshake query whose CommandComplete
    // resets the DataRow index, so the user's first query is the first consumer.
    const raw = postgres(dbh.connectionString, { max: 1, fetch_types: false, onnotice: () => {} });
    try {
      const [{ pid }] = await raw<{ pid: number }[]>`select pg_backend_pid() as pid`;
      // Rows wide enough to be flushed one by one; the third one blocks.
      // Parameterized, so the connection goes `full` and `next` waits in the pool backlog.
      const killed = within(
        raw`select n, repeat('x', ${20_000}) as pad, pg_sleep(case when n = 3 then 10 else 0 end)
            from generate_series(1, 4) n`,
        5_000,
      );
      const next = within(raw`select 42 as x`, 5_000);
      // Row 3 is the first to sleep, so rows 1 and 2 are already on the wire.
      await waitForPgSleep(pid);
      await until(() => poolStats(raw).waiting === 1, "the next query to queue");
      await admin`select pg_terminate_backend(${pid})`;

      expect(await killed).toEqual({ error: "CONNECTION_CLOSED" });
      const outcome = await next;
      expect(outcome).toEqual({ value: [{ x: 42 }] });
      expect((outcome as { value: unknown[] }).value).toHaveLength(1);
    } finally {
      await raw.end({ timeout: 5 });
    }
  });

  it("does not fail the queued next caller when a transaction's backend is terminated mid-statement", async () => {
    const started = deferred();
    let pid = 0;
    const begun = within(
      sql.begin(async (tx) => {
        [{ pid }] = await tx<{ pid: number }[]>`select pg_backend_pid() as pid`;
        const sleeping = tx`select pg_sleep(5)`;
        started.resolve();
        await sleeping;
      }),
      5_000,
    );
    await started.promise;
    const queued = within(sql`select 42 as x`, 5_000);
    await waitForPgSleep(pid);
    await until(() => poolStats(sql).waiting === 1, "the next query to queue");
    await admin`select pg_terminate_backend(${pid})`;

    expect(await begun).toEqual({ error: "CONNECTION_CLOSED" });
    expect(await queued).toEqual({ value: [{ x: 42 }] });
  });

  it("does not carry a ROLLBACK written between a socket's 'error' and 'close' into the next session", async () => {
    // On ECONNRESET Node runs microtasks between 'error' and 'close', so the
    // scope's ROLLBACK is written before closed() runs. A proxy that answers
    // with RST produces exactly that.
    const target = new URL(dbh.connectionString);
    const clients = new Set<net.Socket>();
    const proxy = net.createServer((client) => {
      const upstream = net.connect(Number(target.port), target.hostname);
      clients.add(client);
      client.on("error", () => {});
      upstream.on("error", () => {});
      client.pipe(upstream);
      upstream.pipe(client);
      client.on("close", () => {
        clients.delete(client);
        upstream.destroy();
      });
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const viaProxy = new URL(dbh.connectionString);
    viaProxy.hostname = "127.0.0.1";
    viaProxy.port = String((proxy.address() as net.AddressInfo).port);
    const proxied = postgres(viaProxy.toString(), { max: 1, onnotice: () => {} });
    try {
      const [{ pid }] = await proxied<{ pid: number }[]>`select pg_backend_pid() as pid`;
      const begun = proxied.begin(async (tx) => {
        await tx`select pg_sleep(2)`;
      });
      await waitForPgSleep(pid);
      const queued = within(proxied`select 42 as x`, 3_000);
      await until(() => poolStats(proxied).waiting === 1, "the next query to queue");
      for (const client of clients) client.resetAndDestroy();

      await expect(begun).rejects.toMatchObject({ code: "CONNECTION_CLOSED" });
      expect(await queued).toEqual({ value: [{ x: 42 }] });
      expect(await within(proxied`select 1 as x`, 3_000)).toEqual({ value: [{ x: 1 }] });
    } finally {
      await proxied.end({ timeout: 1 });
      proxy.close();
    }
  });

  it("does not raise an unhandled rejection when a cursor loop exits after its backend died", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => void unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const [{ pid }] = await sql<{ pid: number }[]>`select pg_backend_pid() as pid`;
      for await (const batch of sql`select generate_series(1, 100) as n`.cursor(10)) {
        expect(batch).toHaveLength(10);
        await admin`select pg_terminate_backend(${pid})`;
        await waitForBackendGone(pid);
        // Reconnect the slot, so the cursor's continuation resumes against a new session.
        await sql`select 1`.catch(() => {});
        break;
      }
      await sleep(STALE_WRITE_SETTLE_MS);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }

    expect(unhandled).toEqual([]);
  });

  it("errors an ended COPY stream whose backend died instead of leaving it for the next session", async () => {
    await admin.unsafe(`
      create or replace function dead_scope_slow() returns trigger language plpgsql
        as $$ begin perform pg_sleep(3); return new; end $$;
      create trigger dead_scope_slow before insert on dead_scope_rows
        for each row execute function dead_scope_slow()
    `);
    const [{ pid }] = await sql<{ pid: number }[]>`select pg_backend_pid() as pid`;
    const writable = await sql`copy dead_scope_rows from stdin`.writable();
    const outcome = new Promise((resolve) => {
      writable.on("finish", () => resolve("finish"));
      writable.on("error", (error: { code?: string }) => resolve(error.code));
    });
    writable.write("1\n");
    writable.end();
    // The trigger's pg_sleep runs, so the COPY has ended client-side and is in flight.
    await waitForPgSleep(pid);
    expect(await admin`select pg_terminate_backend(${pid}) as t`).toEqual([{ t: true }]);
    await until(() => poolStats(sql).active === 0, "the driver to see the close");
    // Upstream left its `final` for the next session's first CommandComplete to fire as success.
    await within(sql`select 1`, 3_000);

    expect(await within(outcome, 3_000)).toEqual({ value: "CONNECTION_CLOSED" });
  });

  it("throws from a cursor loop whose backend dies while it holds a batch, instead of ending early", async () => {
    // The rejection used to land on next()'s already-resolved promise and clear
    // `active`, so the loop ended cleanly and the rows so far passed for all of
    // them. Upstream only failed loudly by accident, on the dead session's
    // stashed FATAL at the caller's next statement.
    const [{ pid }] = await sql<{ pid: number }[]>`select pg_backend_pid() as pid`;
    let seen = 0;
    const outcome = await (async () => {
      try {
        for await (const batch of sql`select generate_series(1, 100) as n`.cursor(10)) {
          seen += batch.length;
          if (seen === 10) {
            await admin`select pg_terminate_backend(${pid})`;
            await until(() => poolStats(sql).active === 0, "the driver to see the close");
          }
        }
        return "ended";
      } catch (error) {
        return (error as { code?: string }).code;
      }
    })();

    expect(outcome).toBe("CONNECTION_CLOSED");
    expect(seen).toBe(10);
  });

  it("rejects a queued caller with the next session's startup error instead of reconnecting forever", async () => {
    // A leftover `query` made ErrorResponse stash the startup FATAL instead of
    // rejecting `initial` with it, so closed() looped on reconnect.
    const [{ pid }] = await sql<{ pid: number }[]>`select pg_backend_pid() as pid`;
    const killed = within(sql`select pg_sleep(${5})`, 5_000);
    const next = within(sql`select 42 as x`, 5_000);
    await waitForPgSleep(pid);
    await until(() => poolStats(sql).waiting === 1, "the next query to queue");
    const database = new URL(dbh.connectionString).pathname.slice(1);
    // Postgres refuses to disallow connections to the database a session is in.
    const maintenanceUrl = new URL(dbh.connectionString);
    maintenanceUrl.pathname = "/postgres";
    const maintenance = postgres(maintenanceUrl.toString(), { max: 1, onnotice: () => {} });
    try {
      await maintenance.unsafe(`alter database "${database}" allow_connections false`);
      await admin`select pg_terminate_backend(${pid})`;

      expect(await killed).toEqual({ error: "CONNECTION_CLOSED" });
      expect(await next).toEqual({ error: "55000" });
    } finally {
      await maintenance.unsafe(`alter database "${database}" allow_connections true`);
      await maintenance.end({ timeout: 5 });
    }
  });

  it("does not raise an unhandled rejection when a new connection dies during its type fetch", async () => {
    // The startup's array-type query is fire-and-forget, so its rejection had no
    // handler; paperclip's crash guard exits the worker on one.
    const target = new URL(dbh.connectionString);
    const sockets = new Set<net.Socket>();
    let killedTypeFetch = false;
    const proxy = net.createServer((client) => {
      sockets.add(client);
      client.on("error", () => {});
      client.on("close", () => sockets.delete(client));
      const upstream = net.connect(Number(target.port), target.hostname);
      upstream.on("error", () => {});
      client.on("data", (chunk: Buffer) => {
        if (!killedTypeFetch && chunk.includes("typarray")) {
          killedTypeFetch = true;
          client.destroy();
          upstream.destroy();
          return;
        }
        upstream.write(chunk);
      });
      upstream.pipe(client);
      client.on("close", () => upstream.destroy());
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const viaProxy = new URL(dbh.connectionString);
    viaProxy.hostname = "127.0.0.1";
    viaProxy.port = String((proxy.address() as net.AddressInfo).port);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => void unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    // reserve() first, so the type fetch runs with no user query behind it.
    const proxied = postgres(viaProxy.toString(), { max: 1, onnotice: () => {} });
    try {
      const outcome = await within(proxied.reserve(), 5_000);
      expect(killedTypeFetch).toBe(true);
      expect(outcome).toHaveProperty("value");
      (outcome as { value: postgres.ReservedSql }).value.release();
      expect(await within(proxied`select 1 as x`, 3_000)).toEqual({ value: [{ x: 1 }] });
      await sleep(STALE_WRITE_SETTLE_MS);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      await proxied.end({ timeout: 1 });
      for (const socket of sockets) socket.destroy();
      proxy.close();
    }

    expect(unhandled).toEqual([]);
  });

  /**
   * Queues a reserve() behind a busy connection, terminates that connection's
   * backend, and checks the waiter is handed the reconnected connection.
   */
  async function reserveQueuedBehindTerminatedConnection(client: Sql) {
    const [{ pid }] = await client<{ pid: number }[]>`select pg_backend_pid() as pid`;
    const busy = within(client`select pg_sleep(${5})`, 5_000);
    await waitForPgSleep(pid);
    const reserving = within(client.reserve(), 5_000);
    await until(() => poolStats(client).waiting === 1, "the reserve() to queue");
    await admin`select pg_terminate_backend(${pid})`;

    expect(await busy).toEqual({ error: "CONNECTION_CLOSED" });
    const outcome = await reserving;
    // Upstream rejected it only by accident, with the dead session's stashed 57P01.
    expect(outcome).toHaveProperty("value");
    const reserved = (outcome as { value: postgres.ReservedSql }).value;
    expect(await within(reserved`select 7 as x`, 3_000)).toEqual({ value: [{ x: 7 }] });
    reserved.release();
    expect(await within(client`select 1 as x`, 3_000)).toEqual({ value: [{ x: 1 }] });
  }

  it("hands a reserve() queued behind a terminated connection the reconnected one", async () => {
    await reserveQueuedBehindTerminatedConnection(sql);
  });

  it("hands a queued reserve() the reconnected connection without fetch_types too", async () => {
    const raw = postgres(dbh.connectionString, { max: 1, fetch_types: false, onnotice: () => {} });
    try {
      await reserveQueuedBehindTerminatedConnection(raw);
    } finally {
      await raw.end({ timeout: 5 });
    }
  });

  it("serves a cold reserve() without fetch_types", async () => {
    // The handshake returned without calling onopen() for a reserve() trigger, so
    // with no type fetch to finish the startup the connection sat in `connecting`.
    const raw = postgres(dbh.connectionString, { max: 1, fetch_types: false, onnotice: () => {} });
    try {
      const outcome = await within(raw.reserve(), 3_000);
      expect(outcome).toHaveProperty("value");
      (outcome as { value: postgres.ReservedSql }).value.release();
      expect(await within(raw`select 1 as x`, 3_000)).toEqual({ value: [{ x: 1 }] });
    } finally {
      await raw.end({ timeout: 5 });
    }
  });

  it("does not hand a later connection to a reserve() that already failed to connect", async () => {
    // A queued reserve() waiter now stays in the pool's queue until served, so
    // one rejected meanwhile must leave it; otherwise the next reconnect is
    // handed to the dead waiter and the slot is stranded.
    const target = new URL(dbh.connectionString);
    const sockets = new Set<net.Socket>();
    let swallow = true;
    const proxy = net.createServer((client) => {
      sockets.add(client);
      client.on("error", () => {});
      client.on("close", () => sockets.delete(client));
      if (swallow) {
        // Accept the first connection and never answer, so the driver's connect times out.
        swallow = false;
        return;
      }
      const upstream = net.connect(Number(target.port), target.hostname);
      upstream.on("error", () => {});
      client.pipe(upstream);
      upstream.pipe(client);
      client.on("close", () => upstream.destroy());
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const viaProxy = new URL(dbh.connectionString);
    viaProxy.hostname = "127.0.0.1";
    viaProxy.port = String((proxy.address() as net.AddressInfo).port);
    const proxied = postgres(viaProxy.toString(), { max: 1, connect_timeout: 1, onnotice: () => {} });
    try {
      expect(await within(proxied.reserve(), 5_000)).toEqual({ error: "CONNECT_TIMEOUT" });
      expect(await within(proxied`select 1 as x`, 5_000)).toEqual({ value: [{ x: 1 }] });
    } finally {
      await proxied.end({ timeout: 1 });
      for (const socket of sockets) socket.destroy();
      proxy.close();
    }
  });

  async function waitForBackendGone(pid: number) {
    for (let i = 0; i < 100; i++) {
      const [{ alive }] = await admin<{ alive: boolean }[]>`
        select exists (select 1 from pg_stat_activity where pid = ${pid}) as alive
      `;
      // The driver hears the close asynchronously; give it a beat once the
      // server side is gone.
      if (!alive) return sleep(100);
      await sleep(50);
    }
    throw new Error(`backend ${pid} was never terminated`);
  }
});
