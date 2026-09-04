/**
 * BLO-31392: migration 0237 must not build the queued dispatch index inline on a
 * populated heartbeat_runs table, and must reject a same-named index that does
 * not have the definition the dispatcher's plan depends on.
 *
 * The structural check matters more here than for a normal index. This index
 * exists to win a planner comparison against `heartbeat_runs_queued_age_idx`,
 * and it only wins because of three specific properties: the predicate is
 * exactly `status = 'queued'` (so it indexes the same rows as its competitor,
 * though it is wider per entry), the keys
 * are `(created_at, id)` after `agent_id` (so the ORDER BY needs no Sort), and
 * there is nothing else in the tuple (so the scan stays Index Only). An index
 * precreated with, say, `(agent_id, created_at)` would be accepted by a
 * name-only check, silently reintroduce the Sort, and leave BLO-31392 fixed in
 * the migration but broken in production.
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

const MIGRATION_FILE = "0237_heartbeat_runs_agent_queued_dispatch_index.sql";
const INDEX_NAME = "heartbeat_runs_agent_queued_dispatch_idx";
const INDEX_DEFINITION =
  `ON heartbeat_runs USING btree (agent_id, created_at, id) WHERE status = 'queued'`;
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

describeEmbeddedPostgres("heartbeat-run queued dispatch index migration", () => {
  it("requires online precreation for a populated heartbeat_runs table", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-queued-dispatch-index-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    cleanups.push(async () => sql.end());

    await sql.unsafe(`
      SET session_replication_role = replica;
      INSERT INTO heartbeat_runs (company_id, agent_id, status, context_snapshot)
      VALUES ('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', 'queued', '{}'::jsonb);
      SET session_replication_role = origin;
      DROP INDEX ${INDEX_NAME};
    `);
    await sql`
      DELETE FROM "drizzle"."__drizzle_migrations"
      WHERE "hash" = ${await migrationHash()}
    `;

    await expect(applyPendingMigrations(database.connectionString)).rejects.toMatchObject({
      message: "migration 0237 requires online index precreation",
      hint: expect.stringContaining(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${INDEX_NAME}`),
    });
    expect(await inspectMigrations(database.connectionString)).toMatchObject({
      status: "needsMigrations",
      pendingMigrations: [MIGRATION_FILE],
    });

    await sql.unsafe(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${INDEX_NAME} ${INDEX_DEFINITION}`);
    await applyPendingMigrations(database.connectionString);
    expect((await inspectMigrations(database.connectionString)).status).toBe("upToDate");

    const indexes = await sql<{ indexdef: string }[]>`
      SELECT indexdef
      FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = ${INDEX_NAME}
    `;
    expect(indexes).toHaveLength(1);
    expect(indexes[0]?.indexdef).toContain("btree (agent_id, created_at, id)");
    expect(indexes[0]?.indexdef).toContain("WHERE (status = 'queued'::text)");
  }, 60_000);

  it("rejects a same-name index that drops the id tiebreak", async () => {
    // `(agent_id, created_at)` is the plausible mistake: it looks equivalent,
    // still answers the query, and still avoids a Sort on created_at alone. It
    // is wrong for the same reason 0208 spells out — bulk wake fan-out stamps
    // identical created_at values, so the keyset cursor needs `id` in the index
    // to page without skipping or repeating rows at a batch boundary.
    const database = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-queued-dispatch-invalid-");
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
      ON heartbeat_runs USING btree (agent_id, created_at)
      WHERE status = 'queued'
    `);

    await expect(applyPendingMigrations(database.connectionString)).rejects.toMatchObject({
      message: "migration 0237 found an invalid or incorrectly defined queued dispatch index",
      hint: expect.stringContaining(`DROP INDEX CONCURRENTLY IF EXISTS ${INDEX_NAME}`),
    });
  }, 60_000);

  it("rejects a same-name index whose predicate is wider than the dispatch filter", async () => {
    // `status IN ('queued', 'scheduled_retry')` is 0208's predicate, and an
    // index built that way would be a second copy of 0208 rather than the
    // narrow object this migration exists to add. Indexing exactly the same
    // ROWS as heartbeat_runs_queued_age_idx is the whole reason the planner
    // picks this one over it in the generic plan, so a wider predicate is a
    // silent revert.
    const database = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-queued-dispatch-wide-");
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
      ON heartbeat_runs USING btree (agent_id, created_at, id)
      WHERE status IN ('queued', 'scheduled_retry')
    `);

    await expect(applyPendingMigrations(database.connectionString)).rejects.toMatchObject({
      message: "migration 0237 found an invalid or incorrectly defined queued dispatch index",
      hint: expect.stringContaining(`DROP INDEX CONCURRENTLY IF EXISTS ${INDEX_NAME}`),
    });
  }, 60_000);
});
