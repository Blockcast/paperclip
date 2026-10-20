/**
 * BLO-47753: migration 0261 must not build its index inline on a populated
 * cost_events table, and the index must serve the per-issue cost rollup under
 * BOTH plan-cache modes. The generic plan is the one that regressed: without
 * this index it filtered issue_id through cost_events_company_heartbeat_run_idx
 * and was still estimated cheaper than the custom plan's seq scan.
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

const MIGRATION_FILE = "0261_cost_events_company_issue_index.sql";
const INDEX_NAME = "cost_events_company_issue_idx";
const INDEX_DEFINITION = "ON cost_events USING btree (company_id, issue_id)";
const COMPANY = "11111111-1111-4111-8111-111111111111";
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

async function startDatabase(prefix: string) {
  const database = await startEmbeddedPostgresTestDatabase(prefix);
  cleanups.push(database.cleanup);
  const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
  cleanups.push(async () => sql.end());
  return { database, sql };
}

// Shape of production: one dominant company, many issues, every row carrying
// a heartbeat run so the heartbeat-run index is the tempting wrong path.
async function populate(sql: postgres.Sql) {
  await sql.unsafe(`
    SET session_replication_role = replica;
    INSERT INTO cost_events (company_id, agent_id, issue_id, heartbeat_run_id, provider, model, cost_cents, occurred_at)
    SELECT '${COMPANY}', gen_random_uuid(),
           ('00000000-0000-4000-8000-' || lpad((g % 4000)::text, 12, '0'))::uuid,
           gen_random_uuid(), 'anthropic', 'm', 1, now()
    FROM generate_series(1, 60000) AS g;
    SET session_replication_role = origin;
    ANALYZE cost_events;
  `);
}

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
}, 60_000);

describeEmbeddedPostgres("cost_events company/issue index migration", () => {
  it("requires online precreation for a populated cost_events table", async () => {
    const { database, sql } = await startDatabase("paperclip-cost-events-issue-index-");
    await populate(sql);
    await sql.unsafe(`DROP INDEX ${INDEX_NAME}`);
    await sql`DELETE FROM "drizzle"."__drizzle_migrations" WHERE "hash" = ${await migrationHash()}`;

    await expect(applyPendingMigrations(database.connectionString)).rejects.toMatchObject({
      message: "migration 0261 requires online index precreation",
      hint: expect.stringContaining(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${INDEX_NAME}`),
    });
    expect(await inspectMigrations(database.connectionString)).toMatchObject({
      status: "needsMigrations",
      pendingMigrations: [MIGRATION_FILE],
    });

    await sql.unsafe(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${INDEX_NAME} ${INDEX_DEFINITION}`);
    await applyPendingMigrations(database.connectionString);
    expect((await inspectMigrations(database.connectionString)).status).toBe("upToDate");
  }, 120_000);

  it("rejects a same-name index with the wrong definition", async () => {
    const { database, sql } = await startDatabase("paperclip-cost-events-issue-index-wrong-");
    await sql`DELETE FROM "drizzle"."__drizzle_migrations" WHERE "hash" = ${await migrationHash()}`;
    await sql.unsafe(`
      DROP INDEX ${INDEX_NAME};
      CREATE INDEX ${INDEX_NAME} ON cost_events USING btree (issue_id, company_id)
    `);

    await expect(applyPendingMigrations(database.connectionString)).rejects.toMatchObject({
      message: "migration 0261 found an invalid or incorrectly defined cost_events_company_issue_idx",
      hint: expect.stringContaining(`DROP INDEX CONCURRENTLY IF EXISTS ${INDEX_NAME}`),
    });
  }, 60_000);

  it.each(["force_custom_plan", "force_generic_plan"])(
    "serves the per-issue rollup from the index under %s",
    async (mode) => {
      const { sql } = await startDatabase("paperclip-cost-events-issue-index-plan-");
      await populate(sql);
      await sql.unsafe(`SET plan_cache_mode = ${mode}`);
      await sql.unsafe(`
        PREPARE rollup(uuid, uuid, int) AS
          SELECT coalesce(sum(cost_cents), $3)::int FROM cost_events
          WHERE company_id = $1 AND issue_id = $2
      `);
      const rows = await sql.unsafe(
        `EXPLAIN (FORMAT JSON) EXECUTE rollup('${COMPANY}', '00000000-0000-4000-8000-000000000007', 0)`,
      );
      const plan = JSON.stringify(rows[0]["QUERY PLAN"]);
      expect(plan).toContain(INDEX_NAME);
    },
    60_000,
  );
});
