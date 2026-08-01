import { createHash } from "node:crypto";
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { applyPendingMigrations, inspectMigrations } from "./client.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const MIGRATION_FILE = "0208_heartbeat_runs_crash_recovery_completed.sql";
const COLUMN_NAME = "crash_recovery_completed_at";
const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function migrationHash() {
  const content = await fs.promises.readFile(
    new URL(`./migrations/${MIGRATION_FILE}`, import.meta.url),
    "utf8",
  );
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Rewind `heartbeat_runs` to its genuine pre-0208 physical shape.
 *
 * The previous version of these tests only dropped the journal row (and an
 * index), leaving the column in place — so the "upgrade" it exercised started
 * from an already-upgraded table and could not observe what a real pre-0208
 * database does. Dropping the column as well is what makes the fixture faithful.
 */
async function rewindToPre0208(sql: postgres.Sql) {
  await sql.unsafe(`ALTER TABLE heartbeat_runs DROP COLUMN IF EXISTS ${COLUMN_NAME}`);
  await sql`
    DELETE FROM "drizzle"."__drizzle_migrations"
    WHERE "hash" = ${await migrationHash()}
  `;
}

// BLO-19722: `crash_recovery_completed_at` is the durable marker that startup
// crash recovery selects on. These tests pin the two properties that decide
// whether a production database can actually take this migration: the column is
// a catalog-only nullable ADD COLUMN, and the migration completes on a populated
// table whose schema really does predate the column.
describeEmbeddedPostgres("heartbeat-run crash recovery marker migration", () => {
  it("adds a nullable marker column that defaults to unrecovered", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-crash-recovery-column-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    cleanups.push(async () => sql.end());

    const [column] = await sql`
      SELECT data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_name = 'heartbeat_runs' AND column_name = ${COLUMN_NAME}
    `;
    // Nullable with no default keeps this a catalog-only ADD COLUMN, and makes
    // "recovery has not completed" the state every pre-existing row is already
    // in — no backfill, and no row silently treated as already recovered.
    expect(column).toMatchObject({
      data_type: "timestamp with time zone",
      is_nullable: "YES",
      column_default: null,
    });
  }, 60_000);

  it("upgrades a populated table whose physical schema predates the column", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-crash-recovery-upgrade-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    cleanups.push(async () => sql.end());

    await rewindToPre0208(sql);
    await sql.unsafe(`
      SET session_replication_role = replica;
      INSERT INTO heartbeat_runs (company_id, agent_id)
      VALUES ('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222');
      SET session_replication_role = origin;
    `);

    expect(await inspectMigrations(database.connectionString)).toMatchObject({
      status: "needsMigrations",
      pendingMigrations: [MIGRATION_FILE],
    });

    // The regression this test exists for. An earlier revision of 0208 also
    // created a partial index over this new column and *refused to run* unless
    // an operator had already precreated it with CREATE INDEX CONCURRENTLY.
    // That was impossible: the predicate references a column that does not
    // exist until this migration adds it, and the transactional migration rolled
    // the ADD COLUMN back on refusal — so a populated database could never
    // upgrade. Against that revision this call rejects with "migration 0208
    // requires online index precreation".
    await applyPendingMigrations(database.connectionString);
    expect((await inspectMigrations(database.connectionString)).status).toBe("upToDate");

    const [column] = await sql`
      SELECT is_nullable FROM information_schema.columns
      WHERE table_name = 'heartbeat_runs' AND column_name = ${COLUMN_NAME}
    `;
    expect(column).toMatchObject({ is_nullable: "YES" });

    // The pre-existing row must read as unrecovered, not as already handled.
    const [row] = await sql.unsafe(`SELECT ${COLUMN_NAME} AS marker FROM heartbeat_runs LIMIT 1`);
    expect(row.marker).toBeNull();
  }, 60_000);

  it("creates no index for the marker, keeping the migration lock-free", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-crash-recovery-noindex-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    cleanups.push(async () => sql.end());

    // The startup candidate scan reads this column once per worker boot under a
    // LIMIT, so it does not justify an index — and an index here is what forced
    // the impossible precreation protocol above. Pinning "no index" keeps a
    // future schema change from reintroducing it without revisiting that.
    const indexes = await sql`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'heartbeat_runs' AND indexdef LIKE ${"%" + COLUMN_NAME + "%"}
    `;
    expect(indexes).toHaveLength(0);
  }, 60_000);
});

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
}, 60_000);
