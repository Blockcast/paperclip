/**
 * BLO-23197: heartbeat_runs.status_only_document_write_refused_at is the durable
 * signal that a run was refused an issue-document write by the status-only
 * recovery guard. `decideSuccessfulRunHandoff` reads it to escalate the
 * corrective wake off a lane that provably cannot land that write — without it
 * the detector falls back to `issues.work_mode`, a proxy that reads `standard`
 * in exactly the deadlocking case.
 *
 * Two properties of the migration are load-bearing and asserted here:
 *   - the column is NULLABLE with no server default, so the ADD COLUMN is
 *     catalog-only on a ~1.8 GB table and "never refused" is representable;
 *   - pre-existing rows stay NULL rather than being backfilled to a timestamp,
 *     so the deploy does not escalate the next corrective wake for every
 *     historical run.
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

// Resolved by suffix rather than hardcoded: this number moves on every rebase
// that lands another migration first, and a stale literal here fails the suite
// with an ENOENT that reads as unrelated to the rename.
const MIGRATION_SUFFIX = "_heartbeat_runs_status_only_document_write_refused.sql";
const COLUMN_NAME = "status_only_document_write_refused_at";

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
    `Skipping embedded Postgres status-only document write refusal migration tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat-run status-only document write refusal migration", () => {
  it(
    "adds a nullable refusal timestamp and leaves pre-existing runs unstamped",
    async () => {
      const database = await startEmbeddedPostgresTestDatabase(
        "paperclip-heartbeat-status-only-doc-refusal-",
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
          'succeeded',
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
        { data_type: "timestamp with time zone", is_nullable: "YES", column_default: null },
      ]);

      // The pre-existing run stays unstamped: it was never refused a document
      // write, so its next corrective wake keeps today's status-only lane
      // rather than being escalated by the deploy itself.
      const seeded = await sql<{ status_only_document_write_refused_at: Date | null }[]>`
        SELECT "status_only_document_write_refused_at"
        FROM "heartbeat_runs"
        WHERE "id" = '33333333-3333-4333-8333-333333333333'
      `;
      expect(seeded).toEqual([{ status_only_document_write_refused_at: null }]);

      // A fresh insert that never names the column is also unstamped, so the
      // escalation is opt-in at the point of refusal and nowhere else.
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
      const inserted = await sql<{ status_only_document_write_refused_at: Date | null }[]>`
        SELECT "status_only_document_write_refused_at"
        FROM "heartbeat_runs"
        WHERE "id" = '44444444-4444-4444-8444-444444444444'
      `;
      expect(inserted).toEqual([{ status_only_document_write_refused_at: null }]);

      // The guard stamps by primary key on every refusal, so a re-refusal must
      // be able to overwrite an existing stamp rather than conflict with it.
      await sql`
        UPDATE "heartbeat_runs"
        SET "status_only_document_write_refused_at" = '2026-09-04T17:00:00Z'
        WHERE "id" = '44444444-4444-4444-8444-444444444444'
      `;
      const stamped = await sql<{ status_only_document_write_refused_at: Date | null }[]>`
        SELECT "status_only_document_write_refused_at"
        FROM "heartbeat_runs"
        WHERE "id" = '44444444-4444-4444-8444-444444444444'
      `;
      expect(stamped[0]?.status_only_document_write_refused_at).toEqual(
        new Date("2026-09-04T17:00:00Z"),
      );
    },
    60_000,
  );
});
