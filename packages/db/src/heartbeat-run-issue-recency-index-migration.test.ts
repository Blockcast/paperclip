import { createHash } from "node:crypto";
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { applyPendingMigrations, inspectMigrations } from "./client.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const MIGRATION_FILE = "0204_heartbeat_run_issue_recency_index.sql";
const INDEX_NAME = "heartbeat_runs_company_context_issue_created_desc_idx";
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
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
}, 60_000);

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping heartbeat-run issue recency index migration tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat-run issue recency index migration", () => {
  it("creates the covering partial index and replays idempotently", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-issue-recency-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    cleanups.push(async () => sql.end());

    const readIndexDefinition = async () => {
      const rows = await sql<{ indexdef: string }[]>`
        SELECT "indexdef"
        FROM "pg_indexes"
        WHERE "schemaname" = 'public'
          AND "tablename" = 'heartbeat_runs'
          AND "indexname" = ${INDEX_NAME}
      `;
      return rows[0]?.indexdef ?? null;
    };

    const definition = await readIndexDefinition();
    expect(definition).toContain(
      "(company_id, ((context_snapshot ->> 'issueId'::text)), created_at DESC, id DESC)",
    );
    expect(definition).toContain("WHERE ((context_snapshot ->> 'issueId'::text) IS NOT NULL)");

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
    expect(await readIndexDefinition()).toBe(definition);
  }, 60_000);
});
