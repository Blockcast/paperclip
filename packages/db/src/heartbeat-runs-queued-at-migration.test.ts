import { createHash } from "node:crypto";
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { applyPendingMigrations, inspectMigrations } from "./client.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const MIGRATION_FILE = "0212_heartbeat_runs_queued_at.sql";
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

describeEmbeddedPostgres("heartbeat-runs queued_at migration", () => {
  it("backfills an already-queued retry from its last durable transition", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-queued-at-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    cleanups.push(async () => sql.end());

    await sql.unsafe(`
      SET session_replication_role = replica;
      INSERT INTO heartbeat_runs (
        id, company_id, agent_id, status, created_at, updated_at
      ) VALUES (
        '11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222',
        '33333333-3333-4333-8333-333333333333',
        'queued',
        '2026-08-04T00:00:00.000Z',
        '2026-08-04T11:58:30.000Z'
      );
      SET session_replication_role = origin;
    `);
    await sql`
      DELETE FROM "drizzle"."__drizzle_migrations"
      WHERE "hash" = ${await migrationHash()}
    `;

    await applyPendingMigrations(database.connectionString);
    expect(await inspectMigrations(database.connectionString)).toMatchObject({ status: "upToDate" });

    const [row] = await sql`
      SELECT queued_at
      FROM heartbeat_runs
      WHERE id = '11111111-1111-4111-8111-111111111111'
    `;
    expect(new Date(String(row?.queued_at)).toISOString()).toBe("2026-08-04T11:58:30.000Z");
  }, 60_000);
});
