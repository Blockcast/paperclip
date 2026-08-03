import { createHash } from "node:crypto";
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { applyPendingMigrations, inspectMigrations } from "./client.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const MIGRATION_FILE = "0210_alertmanager_aggregate_creation_dedupe.sql";
const INDEX_NAME = "issues_active_alertmanager_aggregate_creation_uq";
const INDEX_DEFINITION =
  `ON issues USING btree (company_id, origin_kind, origin_fingerprint) ` +
  `WHERE origin_kind = 'plugin:paperclip-plugin-alertmanager' ` +
  `AND origin_fingerprint <> 'default' AND hidden_at IS NULL ` +
  `AND status NOT IN ('done', 'cancelled')`;
const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

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

describeEmbeddedPostgres("Alertmanager aggregate index migration", () => {
  it("requires exact online precreation for a populated issues table", async () => {
    const database = await startEmbeddedPostgresTestDatabase(
      "paperclip-alertmanager-index-",
    );
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, {
      max: 1,
      onnotice: () => {},
    });
    cleanups.push(async () => sql.end());

    await sql.unsafe(`
      SET session_replication_role = replica;
      INSERT INTO issues (company_id, title, last_activity_at)
      VALUES ('11111111-1111-4111-8111-111111111111', 'existing issue', now());
      SET session_replication_role = origin;
      DROP INDEX ${INDEX_NAME};
    `);
    await sql`
      DELETE FROM "drizzle"."__drizzle_migrations"
      WHERE "hash" = ${await migrationHash()}
    `;

    await expect(
      applyPendingMigrations(database.connectionString),
    ).rejects.toMatchObject({
      message: "migration 0210 requires online index precreation",
      hint: expect.stringContaining(
        `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ${INDEX_NAME}`,
      ),
    });
    expect(await inspectMigrations(database.connectionString)).toMatchObject({
      status: "needsMigrations",
      pendingMigrations: [MIGRATION_FILE],
    });

    await sql.unsafe(`
      CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ${INDEX_NAME} ${INDEX_DEFINITION}
    `);
    await applyPendingMigrations(database.connectionString);

    expect((await inspectMigrations(database.connectionString)).status).toBe(
      "upToDate",
    );
  }, 60_000);

  it("rejects an incorrectly defined same-name index", async () => {
    const database = await startEmbeddedPostgresTestDatabase(
      "paperclip-alertmanager-index-wrong-",
    );
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, {
      max: 1,
      onnotice: () => {},
    });
    cleanups.push(async () => sql.end());

    await sql`
      DELETE FROM "drizzle"."__drizzle_migrations"
      WHERE "hash" = ${await migrationHash()}
    `;
    await sql.unsafe(`
      DROP INDEX ${INDEX_NAME};
      CREATE UNIQUE INDEX ${INDEX_NAME}
      ON issues USING btree (company_id, origin_kind, origin_fingerprint)
      WHERE origin_kind = 'plugin:paperclip-plugin-alertmanager'
    `);

    await expect(
      applyPendingMigrations(database.connectionString),
    ).rejects.toMatchObject({
      message:
        "migration 0210 found an invalid or incorrectly defined prerequisite index",
      hint: expect.stringContaining(
        `DROP INDEX CONCURRENTLY IF EXISTS ${INDEX_NAME}`,
      ),
    });
    expect(await inspectMigrations(database.connectionString)).toMatchObject({
      status: "needsMigrations",
      pendingMigrations: [MIGRATION_FILE],
    });
  }, 60_000);
});
