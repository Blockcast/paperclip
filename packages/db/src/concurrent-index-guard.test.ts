/**
 * BLO-21526: migration 0212 records complete on a populated `heartbeat_runs`
 * table without building `heartbeat_runs_crash_recovery_pending_idx` — it
 * only `RAISE NOTICE`s, and the production migration client suppresses
 * notices (`client.ts`'s `onnotice: () => {}`). Nothing else in the migration
 * runner ever closes that gap, so the deploy-time index build has to be an
 * explicit, verifiable step instead of a comment operators are expected to
 * notice. These tests exercise `ensurePendingConcurrentIndexes` standing in
 * for that step: given the exact "migration recorded complete, index absent"
 * state 0212 leaves behind, it must build the index and fail loudly — never
 * silently — if the build does not leave a valid index in place.
 */
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { applyPendingMigrations } from "./client.js";
import {
  ensurePendingConcurrentIndexes,
  SERIALIZING_LOCK_KEY,
  type ConcurrentIndexSpec,
} from "./concurrent-index-guard.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const INDEX_NAME = "heartbeat_runs_crash_recovery_pending_idx";
const INDEX_DEFINITION =
  "ON heartbeat_runs USING btree (finished_at, id) "
  + "WHERE error_code = 'worker_crashed' AND crash_recovery_completed_at IS NULL";

const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
}, 60_000);

async function seedPopulatedDatabaseWithoutIndex() {
  const database = await startEmbeddedPostgresTestDatabase("paperclip-concurrent-index-guard-");
  cleanups.push(database.cleanup);
  // Applying migrations against an empty database builds 0212's index
  // inline (it is only deferred once the table is populated), so exercising
  // the "populated, index absent" state this guard exists for means
  // populating the table and dropping the index afterward — the same shape
  // migration 0212 itself leaves behind on a real populated deploy.
  await applyPendingMigrations(database.connectionString);

  const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
  cleanups.push(async () => sql.end());
  await sql.unsafe(`
    SET session_replication_role = replica;
    INSERT INTO heartbeat_runs (company_id, agent_id)
    VALUES ('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222');
    SET session_replication_role = origin;
    DROP INDEX ${INDEX_NAME};
  `);

  return { database, sql };
}

describeEmbeddedPostgres("ensurePendingConcurrentIndexes", () => {
  it("builds the deferred index migration 0212 leaves absent on a populated table", async () => {
    const { database, sql } = await seedPopulatedDatabaseWithoutIndex();

    const results = await ensurePendingConcurrentIndexes(database.connectionString);

    expect(results).toEqual([
      { name: INDEX_NAME, table: "heartbeat_runs", action: "created" },
    ]);
    const [{ indisvalid }] = await sql<{ indisvalid: boolean }[]>`
      select indisvalid from pg_index where indexrelid = to_regclass(${`public.${INDEX_NAME}`})
    `;
    expect(indisvalid).toBe(true);
  }, 60_000);

  it("is a no-op when the index is already present and valid", async () => {
    const { database, sql } = await seedPopulatedDatabaseWithoutIndex();
    await sql.unsafe(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${INDEX_NAME} ${INDEX_DEFINITION}`);

    const results = await ensurePendingConcurrentIndexes(database.connectionString);

    expect(results).toEqual([
      { name: INDEX_NAME, table: "heartbeat_runs", action: "already-valid" },
    ]);
  }, 60_000);

  it("drops and rebuilds an invalid leftover from a failed online build", async () => {
    const { database, sql } = await seedPopulatedDatabaseWithoutIndex();
    // `CREATE INDEX CONCURRENTLY` that fails partway leaves an invalid index
    // behind rather than rolling back — simulate that leftover directly
    // rather than trying to force a real build failure.
    await sql.unsafe(`CREATE INDEX CONCURRENTLY ${INDEX_NAME} ${INDEX_DEFINITION}`);
    await sql.unsafe(`UPDATE pg_index SET indisvalid = FALSE WHERE indexrelid = '${INDEX_NAME}'::regclass`);

    const results = await ensurePendingConcurrentIndexes(database.connectionString);

    expect(results).toEqual([
      { name: INDEX_NAME, table: "heartbeat_runs", action: "rebuilt" },
    ]);
    const [{ indisvalid }] = await sql<{ indisvalid: boolean }[]>`
      select indisvalid from pg_index where indexrelid = to_regclass(${`public.${INDEX_NAME}`})
    `;
    expect(indisvalid).toBe(true);
  }, 60_000);

  it("throws — rather than reporting success — when the online build does not leave a valid index", async () => {
    const { database } = await seedPopulatedDatabaseWithoutIndex();
    const brokenSpec: ConcurrentIndexSpec = {
      migration: "0212_heartbeat_runs_crash_recovery_index.sql",
      name: INDEX_NAME,
      table: "heartbeat_runs",
      accessMethod: "btree",
      keyColumns: ["finished_at", "id"],
      predicate: "error_code = 'worker_crashed'::text AND crash_recovery_completed_at IS NULL",
      // References a column that does not exist, so the build itself fails
      // and this must surface as a thrown error, not a silently-empty result.
      createStatement:
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${INDEX_NAME} `
        + "ON heartbeat_runs USING btree (finished_at, id) WHERE this_column_does_not_exist IS NULL",
      dropStatement: `DROP INDEX CONCURRENTLY IF EXISTS ${INDEX_NAME}`,
    };

    await expect(
      ensurePendingConcurrentIndexes(database.connectionString, { specs: [brokenSpec] }),
    ).rejects.toThrow();
  }, 60_000);

  it("throws instead of silently trusting a same-named index with a different definition (BLO-21526 review)", async () => {
    const { database, sql } = await seedPopulatedDatabaseWithoutIndex();
    // Same name, same predicate, but the key columns are reversed. Postgres
    // has no notion that this doesn't match what the guard expects -- it is
    // a perfectly valid, ready index -- so only the structural check catches
    // it, and it must not be silently dropped and rebuilt (it could be a
    // legitimate index this check simply doesn't recognize).
    await sql.unsafe(
      `CREATE INDEX CONCURRENTLY ${INDEX_NAME} ON heartbeat_runs USING btree (id, finished_at) ` +
        "WHERE error_code = 'worker_crashed' AND crash_recovery_completed_at IS NULL",
    );

    await expect(ensurePendingConcurrentIndexes(database.connectionString)).rejects.toThrow(
      /does not match migration 0212_heartbeat_runs_crash_recovery_index\.sql's definition/,
    );

    const [{ indisvalid }] = await sql<{ indisvalid: boolean }[]>`
      select indisvalid from pg_index where indexrelid = to_regclass(${`public.${INDEX_NAME}`})
    `;
    expect(indisvalid).toBe(true);
    const [{ indexdef }] = await sql<{ indexdef: string }[]>`
      select indexdef from pg_indexes where indexname = ${INDEX_NAME}
    `;
    expect(indexdef).toContain("(id, finished_at)");
  }, 60_000);

  it("serializes concurrent callers with a session-scoped advisory lock (BLO-21526 review)", async () => {
    const { database } = await seedPopulatedDatabaseWithoutIndex();

    // Simulate a first caller already mid-build by holding the same
    // session-scoped advisory lock ensurePendingConcurrentIndexes takes
    // internally -- from a caller's point of view, a real first caller and
    // this holder connection are indistinguishable, so this exercises the
    // exact serialization the guard promises without depending on Postgres's
    // own CREATE INDEX CONCURRENTLY internals to create a race window (they
    // resolve too fast against this tiny test table to reliably straddle a
    // held-open blocking transaction).
    const holder = postgres(database.connectionString, { max: 1 });
    cleanups.push(async () => holder.end());
    await holder.unsafe(`select pg_advisory_lock(hashtextextended('${SERIALIZING_LOCK_KEY}', 0))`);

    const second = ensurePendingConcurrentIndexes(database.connectionString);

    // While the holder keeps the lock, the second caller must not resolve --
    // race it against a short timer and confirm the timer wins.
    const stillWaiting = Symbol("still-waiting");
    const raceResult = await Promise.race([
      second.then(() => "resolved" as const),
      new Promise((resolve) => setTimeout(() => resolve(stillWaiting), 500)),
    ]);
    expect(raceResult).toBe(stillWaiting);

    await holder.unsafe(`select pg_advisory_unlock(hashtextextended('${SERIALIZING_LOCK_KEY}', 0))`);

    const results = await second;
    expect(results).toEqual([{ name: INDEX_NAME, table: "heartbeat_runs", action: "created" }]);
  }, 60_000);
});
