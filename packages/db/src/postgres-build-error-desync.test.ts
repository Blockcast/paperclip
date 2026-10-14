import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import postgres from "postgres";

/**
 * Regression coverage for BLO-45336: a query whose `build()` throws while
 * another query is in flight on the same connection.
 *
 * Upstream `execute()` pushed the query onto `sent` *before* building it, and
 * its catch rejected the in-flight `query` rather than the one that failed. The
 * never-sent query stayed in `sent`, so every later response on that connection
 * was attributed to the query before it -- a permanent off-by-one that surfaced
 * on paperclip-0 as rows with missing fields and
 * `TypeError: Cannot read properties of null (reading 'types')`.
 *
 * `patches/postgres@3.4.9.patch` builds before enqueueing. Reverting that hunk
 * makes the first test fail: A rejects with B's UNDEFINED_VALUE and C never
 * settles. Dropping the catch's `write(Sync)` makes the second one fail: the
 * transaction and the query behind the failing one never settle.
 */

const int32 = (value: number): Buffer => {
  const buf = Buffer.alloc(4);
  buf.writeInt32BE(value);
  return buf;
};

const message = (type: string, payload: Buffer = Buffer.alloc(0)): Buffer =>
  Buffer.concat([Buffer.from(type, "latin1"), int32(4 + payload.length), payload]);

const readyForQuery = (status: "I" | "T"): Buffer => message("Z", Buffer.from(status, "latin1"));

/**
 * Answers each Sync / simple Query in order, after a delay, with a command tag
 * whose row count is the reply's sequence number -- so the test can tell which
 * reply each query was handed.
 */
class PipelineSocket extends EventEmitter {
  readyState = "open";
  host = "127.0.0.1";
  port = 5432;
  private greeted = false;
  private replies = 0;

  /** `status` is the ReadyForQuery transaction byte: "T" inside `sql.begin`. */
  constructor(private readonly status: "I" | "T" = "I") {
    super();
  }

  write(chunk: Buffer, callback?: () => void): boolean {
    if (!this.greeted) {
      this.greeted = true;
      setImmediate(() => this.emit("data", Buffer.concat([message("R", int32(0)), readyForQuery("I")])));
    } else {
      for (let offset = 0; offset < chunk.length; offset += 1 + chunk.readUInt32BE(offset + 1)) {
        const type = String.fromCharCode(chunk[offset]);
        if (type !== "S" && type !== "Q") continue;
        const sequence = ++this.replies;
        setTimeout(
          () => this.emit("data", Buffer.concat([
            message("C", Buffer.from(`SELECT ${sequence}\0`, "latin1")),
            readyForQuery(this.status),
          ])),
          10 * sequence,
        );
      }
    }
    callback?.();
    return true;
  }

  end(): this { return this; }
  destroy(): this { return this; }
  pause(): this { return this; }
  resume(): this { return this; }
  setKeepAlive(): this { return this; }
}

const settle = (query: Promise<{ count: number | null }>) =>
  Promise.race([
    query.then((result) => `count=${result.count}`, (err: { code?: string }) => `rejected ${err.code}`),
    new Promise<string>((resolve) => setTimeout(() => resolve("unsettled"), 1_000)),
  ]);

describe("postgres.js build error during pipelining (BLO-45336)", () => {
  it("rejects only the failing query and keeps the connection in sync", async () => {
    const sql = postgres({
      max: 1,
      fetch_types: false,
      prepare: false,
      idle_timeout: null,
      max_lifetime: null,
      socket: () => new PipelineSocket() as never,
    } as never);
    try {
      // Open the connection first, so the queries below pipeline on a live one
      // rather than queueing behind the handshake. This is reply 1.
      await sql.unsafe("select 0");

      const inFlight = settle(sql.unsafe("select 1"));
      const failing = settle(sql.unsafe("select $1", [undefined as never]));
      const next = settle(sql.unsafe("select 2"));

      expect(await inFlight).toBe("count=2");
      expect(await failing).toBe("rejected UNDEFINED_VALUE");
      expect(await next).toBe("count=3");
    } finally {
      await sql.end({ timeout: 0 });
    }
  });

  it("keeps a transaction moving when the failing query is built with nothing in flight", async () => {
    // max_pipeline: 1 drives the connection to `full`, so inside `sql.begin`
    // later queries queue and are drained only by ReadyForQuery. The failing
    // query is drained onto an idle connection; without the catch's `Sync`
    // no ReadyForQuery follows and every query behind it -- the scope's
    // rollback included -- hangs.
    const sql = postgres({
      max: 1,
      max_pipeline: 1,
      fetch_types: false,
      prepare: false,
      idle_timeout: null,
      max_lifetime: null,
      socket: () => new PipelineSocket("T") as never,
    } as never);
    try {
      let results: string[] = [];
      const tx = sql.begin(async (tx) => {
        results = await Promise.all([
          settle(tx.unsafe("select 1")),
          settle(tx.unsafe("select 2")),
          settle(tx.unsafe("select $1", [undefined as never])),
          settle(tx.unsafe("select 3")),
        ]);
      });
      // The scope rejects with the failing query's error once its rollback ran.
      expect(await settle(tx.then(() => ({ count: null })))).toBe("rejected UNDEFINED_VALUE");
      expect(results).toEqual(["count=2", "count=3", "rejected UNDEFINED_VALUE", "count=5"]);
    } finally {
      await sql.end({ timeout: 0 });
    }
  });
});
