/**
 * BLO-22094 (Ally review on Blockcast/paperclip#1184): migration 0224 must
 * not build its index inline on a populated heartbeat_runs table.
 *
 * Drizzle migrations are transactional, so CONCURRENTLY is unavailable and a
 * plain CREATE INDEX takes a SHARE lock on this large, high-write table for
 * the whole build, blocking every insert/update/delete against it. `IF NOT
 * EXISTS` makes a rerun idempotent but does nothing about that lock, so the
 * migration instead *requires* the index to be precreated online — and
 * verifies the precreated index actually matches the definition the
 * overdue-scheduled-retry gauge depends on, rather than accepting any index
 * that happens to share the name.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { applyPendingMigrations, inspectMigrations } from "./client.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const MIGRATION_FILE = "0224_heartbeat_runs_overdue_scheduled_retry_index.sql";
const INDEX_NAME = "heartbeat_runs_overdue_scheduled_retry_idx";
const INDEX_DEFINITION =
  `ON heartbeat_runs USING btree (agent_id, scheduled_retry_at) ` +
  `WHERE status = 'scheduled_retry'`;
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

describeEmbeddedPostgres("heartbeat-run overdue scheduled-retry index migration", () => {
  it("requires online precreation for a populated heartbeat_runs table", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-overdue-retry-index-");
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

    await expect(applyPendingMigrations(database.connectionString)).rejects.toMatchObject({
      message: "migration 0224 requires online index precreation",
      hint: expect.stringContaining(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${INDEX_NAME}`),
    });
    expect(await inspectMigrations(database.connectionString)).toMatchObject({
      status: "needsMigrations",
      pendingMigrations: [MIGRATION_FILE],
    });

    // Precreating it online is what unblocks the rollout.
    await sql.unsafe(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS ${INDEX_NAME} ${INDEX_DEFINITION}
    `);
    await applyPendingMigrations(database.connectionString);

    expect((await inspectMigrations(database.connectionString)).status).toBe("upToDate");
  }, 60_000);

  it("rejects an invalid precreated index with repair instructions", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-overdue-retry-invalid-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    cleanups.push(async () => sql.end());

    await sql`
      DELETE FROM "drizzle"."__drizzle_migrations"
      WHERE "hash" = ${await migrationHash()}
    `;
    await sql.unsafe(`
      UPDATE pg_index
      SET indisvalid = FALSE
      WHERE indexrelid = '${INDEX_NAME}'::regclass
    `);

    await expect(applyPendingMigrations(database.connectionString)).rejects.toMatchObject({
      message: "migration 0224 found an invalid or incorrectly defined prerequisite index",
      hint: expect.stringContaining(`DROP INDEX CONCURRENTLY IF EXISTS ${INDEX_NAME}`),
    });
    expect(await inspectMigrations(database.connectionString)).toMatchObject({
      status: "needsMigrations",
      pendingMigrations: [MIGRATION_FILE],
    });
  }, 60_000);

  it("rejects a same-name index that is missing the scheduled_retry_at column", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-overdue-retry-wrong-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    cleanups.push(async () => sql.end());

    await sql`
      DELETE FROM "drizzle"."__drizzle_migrations"
      WHERE "hash" = ${await migrationHash()}
    `;
    await sql.unsafe(`
      DROP INDEX ${INDEX_NAME};
      CREATE INDEX ${INDEX_NAME}
      ON heartbeat_runs USING btree (agent_id)
      WHERE status = 'scheduled_retry'
    `);

    await expect(applyPendingMigrations(database.connectionString)).rejects.toMatchObject({
      message: "migration 0224 found an invalid or incorrectly defined prerequisite index",
      hint: expect.stringContaining(`CREATE INDEX CONCURRENTLY ${INDEX_NAME}`),
    });
    expect(await inspectMigrations(database.connectionString)).toMatchObject({
      status: "needsMigrations",
      pendingMigrations: [MIGRATION_FILE],
    });
  }, 60_000);
});
