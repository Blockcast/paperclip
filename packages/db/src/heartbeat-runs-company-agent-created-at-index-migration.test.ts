import { createHash } from "node:crypto";
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { applyPendingMigrations, inspectMigrations } from "./client.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const MIGRATION_FILE = "0243_heartbeat_runs_company_agent_created_at_index.sql";
const INDEX_NAME = "heartbeat_runs_company_agent_created_at_idx";
const INDEX_DEFINITION =
  "ON heartbeat_runs USING btree (company_id, agent_id, created_at DESC, id DESC)";
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
}, 120_000);

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping heartbeat-runs company-agent-created-at migration tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat-runs company-agent-created-at index migration", () => {
  it("handles bootstrap and validates every prerequisite-index shape", async () => {
    const database = await startEmbeddedPostgresTestDatabase(
      "paperclip-heartbeat-company-agent-created-at-index-",
    );
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    cleanups.push(async () => sql.end());
    const hash = await migrationHash();
    const expectPending = async () => {
      expect(await inspectMigrations(database.connectionString)).toMatchObject({
        status: "needsMigrations",
        pendingMigrations: [MIGRATION_FILE],
      });
    };
    const resetMigration = async () => {
      await sql`
        DELETE FROM "drizzle"."__drizzle_migrations"
        WHERE "hash" = ${hash}
      `;
    };
    const expectInvalidIndex = async () => {
      await expect(applyPendingMigrations(database.connectionString)).rejects.toMatchObject({
        message: "migration 0243 found an invalid or incorrectly defined prerequisite index",
        hint: expect.stringContaining(`DROP INDEX CONCURRENTLY IF EXISTS ${INDEX_NAME}`),
      });
      await expectPending();
    };

    // The helper bootstraps from an empty database; rerun 0243 after removing
    // its history to exercise the absent-index/empty-table branch explicitly.
    expect(await sql`SELECT count(*)::int AS count FROM heartbeat_runs`).toEqual([{ count: 0 }]);
    await sql.unsafe(`DROP INDEX ${INDEX_NAME}`);
    await resetMigration();
    await applyPendingMigrations(database.connectionString);
    expect((await inspectMigrations(database.connectionString)).status).toBe("upToDate");

    await sql.unsafe(`
      SET session_replication_role = replica;
      INSERT INTO heartbeat_runs (company_id, agent_id)
      VALUES ('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222');
      SET session_replication_role = origin;
      DROP INDEX ${INDEX_NAME};
    `);
    await resetMigration();
    await expect(applyPendingMigrations(database.connectionString)).rejects.toMatchObject({
      message: "migration 0243 requires online index precreation",
      hint: expect.stringContaining(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${INDEX_NAME}`),
    });
    await expectPending();

    // This is the exact command printed by the migration's remediation hint.
    await sql.unsafe(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${INDEX_NAME} ${INDEX_DEFINITION}`);
    await applyPendingMigrations(database.connectionString);
    expect((await inspectMigrations(database.connectionString)).status).toBe("upToDate");

    for (const flag of ["indisvalid", "indisready"] as const) {
      await resetMigration();
      await sql.unsafe(
        `UPDATE pg_index SET ${flag} = FALSE WHERE indexrelid = '${INDEX_NAME}'::regclass`,
      );
      await expectInvalidIndex();
      await sql.unsafe(
        `UPDATE pg_index SET ${flag} = TRUE WHERE indexrelid = '${INDEX_NAME}'::regclass`,
      );
      await applyPendingMigrations(database.connectionString);
    }

    const invalidDefinitions = [
      "ON heartbeat_runs USING btree (agent_id, company_id, created_at DESC, id DESC)",
      "ON heartbeat_runs USING btree (company_id, agent_id, created_at, id)",
      "ON heartbeat_runs USING btree (company_id, agent_id, created_at DESC, id DESC) WHERE id IS NOT NULL",
    ];
    for (const definition of invalidDefinitions) {
      await resetMigration();
      await sql.unsafe(`DROP INDEX ${INDEX_NAME}; CREATE INDEX ${INDEX_NAME} ${definition}`);
      await expectInvalidIndex();
    }
  }, 120_000);
});
