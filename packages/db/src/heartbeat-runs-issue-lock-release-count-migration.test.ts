/**
 * BLO-22060: heartbeat_runs.issue_lock_release_count is the durable mark that
 * makes a stale-lock release stick. The sweep clears the issue row's lock
 * fields, so the issue row cannot carry the count; the run must.
 *
 * Two properties of the migration are load-bearing and asserted here:
 *   - the column is NOT NULL with a server default of 0, so every insert path
 *     gets a usable count without having to name the column;
 *   - pre-existing rows backfill to 0 rather than to the bound, so a run that
 *     is legitimately mid-flight at deploy time is never stranded.
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

// Resolved by suffix rather than hardcoded. This migration has already been
// renumbered four times by rebases (0213 -> 0214 -> 0216 -> 0219); each time, a
// stale literal here would fail the suite with an ENOENT that reads as
// unrelated to the rename.
const MIGRATION_SUFFIX = "_heartbeat_runs_issue_lock_release_count.sql";
const COLUMN_NAME = "issue_lock_release_count";

const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function resolveMigrationFile(): string {
  const migrationsDir = new URL("./migrations/", import.meta.url);
  const matches = fs
    .readdirSync(migrationsDir)
    .filter((file) => file.endsWith(MIGRATION_SUFFIX))
    .sort();
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one migration ending in ${MIGRATION_SUFFIX}, found ${matches.length}: ${matches.join(", ")}`,
    );
  }
  return matches[0]!;
}

const MIGRATION_FILE = resolveMigrationFile();

async function migrationHash(): Promise<string> {
  const content = await fs.promises.readFile(
    new URL(`./migrations/${MIGRATION_FILE}`, import.meta.url),
    "utf8",
  );
  return createHash("sha256").update(content).digest("hex");
}

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
}, 60_000);

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue lock release count migration tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat-run issue lock release count migration", () => {
  it(
    "adds a NOT NULL default-0 counter and backfills pre-existing runs to 0",
    async () => {
      const database = await startEmbeddedPostgresTestDatabase(
        "paperclip-heartbeat-issue-lock-release-count-",
      );
      cleanups.push(database.cleanup);
      const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
      cleanups.push(async () => sql.end());

      // Rewind to the pre-migration shape, then seed a run that predates it.
      // session_replication_role=replica skips the FK checks so the row needs
      // no company/agent fixtures.
      await sql.unsafe(`
        ALTER TABLE heartbeat_runs DROP COLUMN ${COLUMN_NAME};
        SET session_replication_role = replica;
        INSERT INTO heartbeat_runs (id, company_id, agent_id, status, context_snapshot)
        VALUES (
          '33333333-3333-4333-8333-333333333333',
          '11111111-1111-4111-8111-111111111111',
          '22222222-2222-4222-8222-222222222222',
          'scheduled_retry',
          '{}'::jsonb
        );
        SET session_replication_role = origin;
      `);
      await sql`
        DELETE FROM "drizzle"."__drizzle_migrations"
        WHERE "hash" = ${await migrationHash()}
      `;

      expect(await inspectMigrations(database.connectionString)).toMatchObject({
        status: "needsMigrations",
        pendingMigrations: [MIGRATION_FILE],
      });

      await applyPendingMigrations(database.connectionString);
      expect((await inspectMigrations(database.connectionString)).status).toBe("upToDate");

      const columns = await sql<
        { data_type: string; is_nullable: string; column_default: string | null }[]
      >`
        SELECT "data_type", "is_nullable", "column_default"
        FROM "information_schema"."columns"
        WHERE "table_schema" = 'public'
          AND "table_name" = 'heartbeat_runs'
          AND "column_name" = ${COLUMN_NAME}
      `;
      expect(columns).toEqual([
        { data_type: "integer", is_nullable: "NO", column_default: "0" },
      ]);

      // The pre-existing park backfills to 0, not to the bound: it keeps a full
      // adoption budget rather than being stranded by the deploy.
      const seeded = await sql<{ issue_lock_release_count: number }[]>`
        SELECT "issue_lock_release_count"
        FROM "heartbeat_runs"
        WHERE "id" = '33333333-3333-4333-8333-333333333333'
      `;
      expect(seeded).toEqual([{ issue_lock_release_count: 0 }]);

      // A fresh insert that never names the column still gets a usable count.
      await sql.unsafe(`
        SET session_replication_role = replica;
        INSERT INTO heartbeat_runs (id, company_id, agent_id, status, context_snapshot)
        VALUES (
          '44444444-4444-4444-8444-444444444444',
          '11111111-1111-4111-8111-111111111111',
          '22222222-2222-4222-8222-222222222222',
          'queued',
          '{}'::jsonb
        );
        SET session_replication_role = origin;
      `);
      const inserted = await sql<{ issue_lock_release_count: number }[]>`
        SELECT "issue_lock_release_count"
        FROM "heartbeat_runs"
        WHERE "id" = '44444444-4444-4444-8444-444444444444'
      `;
      expect(inserted).toEqual([{ issue_lock_release_count: 0 }]);
    },
    60_000,
  );
});
