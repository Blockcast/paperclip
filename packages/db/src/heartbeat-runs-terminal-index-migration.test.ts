import { createHash } from "node:crypto";
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { applyPendingMigrations, inspectMigrations } from "./client.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const MIGRATION_FILE = "0205_heartbeat_runs_company_finished_at_index.sql";
const INDEX_NAME = "heartbeat_runs_company_finished_at_desc_idx";
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

describeEmbeddedPostgres("heartbeat-run terminal index migration", () => {
  it("requires online precreation for a populated heartbeat_runs table", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-terminal-index-");
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
      "migration 0205 requires online index precreation",
    );
    expect(await inspectMigrations(database.connectionString)).toMatchObject({
      status: "needsMigrations",
      pendingMigrations: [MIGRATION_FILE],
    });

    await sql.unsafe(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS ${INDEX_NAME}
      ON heartbeat_runs USING btree (company_id, finished_at DESC, id DESC)
      WHERE finished_at IS NOT NULL
    `);
    await applyPendingMigrations(database.connectionString);

    expect((await inspectMigrations(database.connectionString)).status).toBe("upToDate");
  }, 60_000);

  it("rejects an invalid precreated index with repair instructions", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-terminal-invalid-");
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
      message: "migration 0205 found an invalid or incorrectly defined prerequisite index",
      hint: expect.stringContaining(`DROP INDEX CONCURRENTLY IF EXISTS ${INDEX_NAME}`),
    });
    expect(await inspectMigrations(database.connectionString)).toMatchObject({
      status: "needsMigrations",
      pendingMigrations: [MIGRATION_FILE],
    });
  }, 60_000);

  it("rejects an incorrectly defined same-name index", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-terminal-wrong-");
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
      ON heartbeat_runs USING btree (company_id, id DESC)
      WHERE finished_at IS NOT NULL
    `);

    await expect(applyPendingMigrations(database.connectionString)).rejects.toMatchObject({
      message: "migration 0205 found an invalid or incorrectly defined prerequisite index",
      hint: expect.stringContaining(`CREATE INDEX CONCURRENTLY ${INDEX_NAME}`),
    });
    expect(await inspectMigrations(database.connectionString)).toMatchObject({
      status: "needsMigrations",
      pendingMigrations: [MIGRATION_FILE],
    });
  }, 60_000);
});
