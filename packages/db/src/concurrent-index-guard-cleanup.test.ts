/**
 * BLO-34039 (Ally review of #1304): `ensurePendingConcurrentIndexes` cleans up
 * in a `finally`. A throw from that cleanup used to replace the original
 * index-build error — destroying the diagnostic naming the offending index —
 * and a throw from the advisory unlock aborted the block before `sql.end()`,
 * leaking the pool into the deploy bootstrap that runs ahead of
 * applyPendingMigrations.
 *
 * These cases mock `postgres` rather than using the embedded-database harness
 * of concurrent-index-guard.test.ts: a cleanup failure needs the server to be
 * gone, and postgres.js transparently reconnects a killed session, so a real
 * database cannot reach this branch deterministically.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensurePendingConcurrentIndexes,
  type ConcurrentIndexSpec,
} from "./concurrent-index-guard.js";

const postgresFactory = vi.hoisted(() => vi.fn());
vi.mock("postgres", () => ({ default: postgresFactory }));

const SPEC: ConcurrentIndexSpec = {
  migration: "9999_blo_34039.sql",
  name: "blo_34039_idx",
  table: "heartbeat_runs",
  requiredColumns: ["id"],
  accessMethod: "btree",
  keyColumns: ["id"],
  keyOptions: [0],
  predicate: "",
  createStatement: "CREATE INDEX CONCURRENTLY IF NOT EXISTS blo_34039_idx ON heartbeat_runs (id)",
  dropStatement: "DROP INDEX CONCURRENTLY IF EXISTS blo_34039_idx",
};

const VALID_INDEX_ROW = {
  indisvalid: true,
  indisready: true,
  indisunique: false,
  indisprimary: false,
  table_schema: "public",
  table_name: SPEC.table,
  access_method: SPEC.accessMethod,
  indnkeyatts: 1,
  indnatts: 1,
  key_columns: [...SPEC.keyColumns],
  key_options: "0",
  predicate: null,
};

const BUILD_ERROR = "index build blew up";
const CLEANUP_ERROR = "connection terminated during cleanup";

/**
 * Minimal stand-in for a postgres.js client: callable as a tagged template,
 * plus `.unsafe()` and `.end()`. Template queries are routed by their text.
 *
 * `indexValidity` answers come from a queue so the pre-build ("absent") and
 * post-build ("valid") reads of the same query can differ.
 */
function fakeSql(options: { buildFails: boolean; indexRows: unknown[][] }) {
  const ended = { count: 0 };
  const indexRows = [...options.indexRows];

  const sql = Object.assign(
    async (strings: TemplateStringsArray) => {
      const query = strings.join(" ");
      if (query.includes("pg_try_advisory_lock")) return [{ locked: true }];
      if (query.includes("information_schema.tables")) {
        return SPEC.requiredColumns.map((column) => ({ table_name: SPEC.table, column_name: column }));
      }
      if (query.includes("pg_index")) return indexRows.shift() ?? [];
      // The advisory unlock is cleanup, and cleanup is what must not escape.
      if (query.includes("pg_advisory_unlock")) throw new Error(CLEANUP_ERROR);
      throw new Error(`unexpected query: ${query}`);
    },
    {
      unsafe: async (text: string) => {
        // Resetting the session timeouts is cleanup; setting them is not.
        if (text === "SET statement_timeout = 0" || text === "SET lock_timeout = 0") {
          throw new Error(CLEANUP_ERROR);
        }
        if (text === SPEC.createStatement && options.buildFails) throw new Error(BUILD_ERROR);
        return [];
      },
      end: async () => {
        ended.count += 1;
      },
    },
  );

  return { sql, ended };
}

describe("ensurePendingConcurrentIndexes cleanup (BLO-34039)", () => {
  beforeEach(() => {
    postgresFactory.mockReset();
  });

  it("surfaces the index-build error, not the cleanup error, and still closes the pool", async () => {
    const { sql, ended } = fakeSql({ buildFails: true, indexRows: [[]] });
    postgresFactory.mockReturnValue(sql);

    await expect(
      ensurePendingConcurrentIndexes("postgres://stub", { specs: [SPEC] }),
    ).rejects.toThrow(BUILD_ERROR);

    expect(ended.count).toBe(1);
  });

  it("does not turn a successful build into a failure when cleanup throws", async () => {
    const { sql, ended } = fakeSql({ buildFails: false, indexRows: [[], [VALID_INDEX_ROW]] });
    postgresFactory.mockReturnValue(sql);

    const results = await ensurePendingConcurrentIndexes("postgres://stub", { specs: [SPEC] });

    expect(results).toEqual([
      { migration: SPEC.migration, name: SPEC.name, table: SPEC.table, action: "created" },
    ]);
    expect(ended.count).toBe(1);
  });
});
