/**
 * BLO-21460 (2026-08-03 incident follow-up): several migrations guard a
 * partial index required by a hot query and refuse to build it
 * inline on a populated `heartbeat_runs` -- they require an operator to have
 * precreated the exact index online (`CREATE INDEX CONCURRENTLY`) first. That
 * requirement being a manual, easy-to-miss step is what turned migration
 * 0209's rollout into a scheduler crash-loop during the incident: nobody ran
 * the precreation before the deploy applied the migration.
 *
 * `ensureOnlineIndexPrerequisites` closes that gap: called before
 * `applyPendingMigrations` (see `migrate.ts`), it satisfies every pending
 * migration's online-index prerequisite automatically, so an upgrade from a
 * pre-0209 (or pre-0205/pre-0208) state no longer needs any manual database
 * repair. It never overrides a migration's own verification -- each migration
 * still independently re-checks columns/predicate/access-method before
 * trusting the index -- this only removes the manual step of getting a
 * *correct* index into place first.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { applyPendingMigrations, inspectMigrations } from "./client.js";
import { ensureOnlineIndexPrerequisites, ONLINE_INDEX_PREREQUISITES } from "./precreate-online-indexes.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function migrationHash(migrationFile: string) {
  const content = await fs.promises.readFile(
    new URL(`./migrations/${migrationFile}`, import.meta.url),
    "utf8",
  );
  return createHash("sha256").update(content).digest("hex");
}

/** Simulate "the deploy jumped from before this migration to after it": drop
 * its index and mark it pending again on an already-fully-migrated database
 * that already has data in heartbeat_runs -- the exact populated-table state
 * the migration's own guard refuses to build inline on. */
async function rewindMigration(
  sql: postgres.Sql,
  input: { migrationFile: string; indexName: string },
) {
  await sql.unsafe(`DROP INDEX IF EXISTS "${input.indexName}"`);
  await sql`
    DELETE FROM "drizzle"."__drizzle_migrations"
    WHERE "hash" = ${await migrationHash(input.migrationFile)}
  `;
}

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
}, 60_000);

describeEmbeddedPostgres("ensureOnlineIndexPrerequisites", () => {
  it("skips index DDL during an empty-database bootstrap", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-precreate-online-index-empty-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    cleanups.push(async () => sql.end());

    // Recreate the state seen by a fresh database before the first migration:
    // no application tables and no migration journal, while Postgres itself
    // is already available for the deploy-time helper to connect to.
    await sql.unsafe(`
      DROP SCHEMA public CASCADE;
      CREATE SCHEMA public;
      DROP SCHEMA drizzle CASCADE;
    `);

    const results = await ensureOnlineIndexPrerequisites(database.connectionString);
    expect(results).toEqual([]);

    const [table] = await sql<{ exists: boolean }[]>`
      SELECT to_regclass('public.heartbeat_runs') IS NOT NULL AS exists
    `;
    const [index] = await sql<{ exists: boolean }[]>`
      SELECT to_regclass('public.heartbeat_runs_recovery_dispatch_idx') IS NOT NULL AS exists
    `;
    expect(table?.exists).toBe(false);
    expect(index?.exists).toBe(false);

    await applyPendingMigrations(database.connectionString);
    expect((await inspectMigrations(database.connectionString)).status).toBe("upToDate");
  }, 60_000);

  it("precreates a pending migration's index on a populated table so the migration no longer crash-loops", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-precreate-online-index-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    cleanups.push(async () => sql.end());

    const prereq = ONLINE_INDEX_PREREQUISITES.find(
      (entry) => entry.migration === "0209_heartbeat_runs_recovery_dispatch_index.sql",
    )!;

    await sql.unsafe(`
      SET session_replication_role = replica;
      INSERT INTO heartbeat_runs (company_id, agent_id)
      VALUES ('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222');
      SET session_replication_role = origin;
    `);
    await rewindMigration(sql, { migrationFile: prereq.migration, indexName: prereq.indexName });

    // Without precreation this is exactly the incident: the migration refuses
    // to run and the scheduler that calls applyPendingMigrations on startup
    // crash-loops.
    await expect(applyPendingMigrations(database.connectionString)).rejects.toMatchObject({
      message: "migration 0209 requires online index precreation",
    });

    const results = await ensureOnlineIndexPrerequisites(database.connectionString);
    expect(results).toContainEqual({
      migration: prereq.migration,
      indexName: prereq.indexName,
      action: "created",
    });

    // Normal scheduling resumes: migrations apply cleanly with no manual
    // database repair beyond calling this function (which `migrate.ts` now
    // does automatically).
    await applyPendingMigrations(database.connectionString);
    expect((await inspectMigrations(database.connectionString)).status).toBe("upToDate");
  }, 60_000);

  it("is a no-op when the index already exists and is valid", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-precreate-online-index-noop-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    cleanups.push(async () => sql.end());

    const prereq = ONLINE_INDEX_PREREQUISITES.find(
      (entry) => entry.migration === "0209_heartbeat_runs_recovery_dispatch_index.sql",
    )!;
    await sql`
      DELETE FROM "drizzle"."__drizzle_migrations"
      WHERE "hash" = ${await migrationHash(prereq.migration)}
    `;

    // The index from the original successful migration run is already there
    // and valid -- ensureOnlineIndexPrerequisites must recognize that and
    // must not drop/rebuild a perfectly good index.
    const results = await ensureOnlineIndexPrerequisites(database.connectionString);
    expect(results).toContainEqual({
      migration: prereq.migration,
      indexName: prereq.indexName,
      action: "already-valid",
    });

    await applyPendingMigrations(database.connectionString);
    expect((await inspectMigrations(database.connectionString)).status).toBe("upToDate");
  }, 60_000);

  it("self-heals an INVALID leftover index from a previously-interrupted CONCURRENTLY build", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-precreate-online-index-invalid-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    cleanups.push(async () => sql.end());

    const prereq = ONLINE_INDEX_PREREQUISITES.find(
      (entry) => entry.migration === "0209_heartbeat_runs_recovery_dispatch_index.sql",
    )!;
    await sql`
      DELETE FROM "drizzle"."__drizzle_migrations"
      WHERE "hash" = ${await migrationHash(prereq.migration)}
    `;
    // Simulate a CONCURRENTLY build that was interrupted (e.g. the deploy pod
    // was killed mid-build): the index exists but is marked invalid, which
    // Postgres never auto-repairs and a plain rerun of the same
    // `CREATE INDEX CONCURRENTLY IF NOT EXISTS` also will not fix.
    await sql.unsafe(`
      UPDATE pg_index SET indisvalid = FALSE
      WHERE indexrelid = '${prereq.indexName}'::regclass
    `);

    const results = await ensureOnlineIndexPrerequisites(database.connectionString);
    expect(results).toContainEqual({
      migration: prereq.migration,
      indexName: prereq.indexName,
      action: "rebuilt-after-invalid",
    });

    const [row] = await sql<{ indisvalid: boolean }[]>`
      SELECT indisvalid FROM pg_index WHERE indexrelid = to_regclass('public.' || ${prereq.indexName})
    `;
    expect(row?.indisvalid).toBe(true);

    await applyPendingMigrations(database.connectionString);
    expect((await inspectMigrations(database.connectionString)).status).toBe("upToDate");
  }, 60_000);

  it("touches nothing when no pending migration requires online index precreation", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-precreate-online-index-steady-state-");
    cleanups.push(database.cleanup);

    // Fully migrated already (startEmbeddedPostgresTestDatabase's contract) --
    // this must be a fast, empty-result no-op forever after, not a recurring
    // heartbeat_runs scan on every deploy.
    expect((await inspectMigrations(database.connectionString)).status).toBe("upToDate");
    const results = await ensureOnlineIndexPrerequisites(database.connectionString);
    expect(results).toEqual([]);
  }, 60_000);

  it("precreates every pending migration's index in one call for a multi-version upgrade jump", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-precreate-online-index-multi-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    cleanups.push(async () => sql.end());

    await sql.unsafe(`
      SET session_replication_role = replica;
      INSERT INTO heartbeat_runs (company_id, agent_id)
      VALUES ('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222');
      SET session_replication_role = origin;
    `);

    const dispatchPrereq = ONLINE_INDEX_PREREQUISITES.find(
      (entry) => entry.migration === "0208_heartbeat_runs_agent_dispatch_index.sql",
    )!;
    const recoveryPrereq = ONLINE_INDEX_PREREQUISITES.find(
      (entry) => entry.migration === "0209_heartbeat_runs_recovery_dispatch_index.sql",
    )!;
    await rewindMigration(sql, { migrationFile: dispatchPrereq.migration, indexName: dispatchPrereq.indexName });
    await rewindMigration(sql, { migrationFile: recoveryPrereq.migration, indexName: recoveryPrereq.indexName });

    const results = await ensureOnlineIndexPrerequisites(database.connectionString);
    expect(results).toEqual(
      expect.arrayContaining([
        { migration: dispatchPrereq.migration, indexName: dispatchPrereq.indexName, action: "created" },
        { migration: recoveryPrereq.migration, indexName: recoveryPrereq.indexName, action: "created" },
      ]),
    );

    await applyPendingMigrations(database.connectionString);
    expect((await inspectMigrations(database.connectionString)).status).toBe("upToDate");
  }, 60_000);
});
