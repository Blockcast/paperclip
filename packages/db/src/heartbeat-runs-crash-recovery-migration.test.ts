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
const INDEX_NAME = "heartbeat_runs_crash_recovery_pending_idx";
const INDEX_DEFINITION = `ON heartbeat_runs USING btree (finished_at, id)
  WHERE error_code = 'worker_crashed' AND crash_recovery_completed_at IS NULL`;
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

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
}, 60_000);

// BLO-19722: `crash_recovery_completed_at` is the durable marker that startup
// crash recovery selects on, and the partial index is what keeps that select an
// empty probe in steady state. The migration's prerequisite guard compares the
// precreated index against a literal, normalized predicate string, so these
// tests exist mainly to pin that literal against what PostgreSQL actually
// reports — a drift there would fail production migrations with a spurious
// "incorrectly defined prerequisite index".
describeEmbeddedPostgres("heartbeat-run crash recovery marker migration", () => {
  it("adds a nullable marker column that defaults to unrecovered", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-crash-recovery-column-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    cleanups.push(async () => sql.end());

    const [column] = await sql`
      SELECT data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_name = 'heartbeat_runs' AND column_name = 'crash_recovery_completed_at'
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

  it("requires online precreation for a populated heartbeat_runs table", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-crash-recovery-index-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    cleanups.push(async () => sql.end());

    await sql.unsafe(`
      SET session_replication_role = replica;
      INSERT INTO heartbeat_runs (company_id, agent_id)
      VALUES ('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222');
      SET session_replication_role = origin;
      DROP INDEX ${INDEX_NAME};
    `);
    await sql`
      DELETE FROM "drizzle"."__drizzle_migrations"
      WHERE "hash" = ${await migrationHash()}
    `;

    await expect(applyPendingMigrations(database.connectionString)).rejects.toThrow(
      "migration 0208 requires online index precreation",
    );
    expect(await inspectMigrations(database.connectionString)).toMatchObject({
      status: "needsMigrations",
      pendingMigrations: [MIGRATION_FILE],
    });

    // The load-bearing half: an index precreated exactly as the hint instructs
    // must satisfy the guard. This is what pins the normalized predicate
    // literal the migration compares against.
    await sql.unsafe(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS ${INDEX_NAME}
      ${INDEX_DEFINITION}
    `);
    await applyPendingMigrations(database.connectionString);

    expect((await inspectMigrations(database.connectionString)).status).toBe("upToDate");
  }, 60_000);

  it("rejects an incorrectly defined same-name index", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-crash-recovery-wrong-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    cleanups.push(async () => sql.end());

    await sql`
      DELETE FROM "drizzle"."__drizzle_migrations"
      WHERE "hash" = ${await migrationHash()}
    `;
    // Right columns, wrong predicate: this index would silently omit rows the
    // recovery scan must see, so it has to be rejected rather than accepted.
    await sql.unsafe(`
      DROP INDEX ${INDEX_NAME};
      CREATE INDEX ${INDEX_NAME}
      ON heartbeat_runs USING btree (finished_at, id)
      WHERE error_code = 'worker_crashed'
    `);

    await expect(applyPendingMigrations(database.connectionString)).rejects.toMatchObject({
      message: "migration 0208 found an invalid or incorrectly defined prerequisite index",
      hint: expect.stringContaining(`CREATE INDEX CONCURRENTLY ${INDEX_NAME}`),
    });
    expect(await inspectMigrations(database.connectionString)).toMatchObject({
      status: "needsMigrations",
      pendingMigrations: [MIGRATION_FILE],
    });
  }, 60_000);
});
