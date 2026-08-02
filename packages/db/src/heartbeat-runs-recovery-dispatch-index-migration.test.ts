/**
 * BLO-20396 (review follow-up): migration 0209 must not build its index inline
 * on a populated heartbeat_runs table, and must reject a precreated index that
 * does not match the definition the recovery dispatch lane depends on.
 *
 * Same contract as 0208 (see
 * heartbeat-runs-agent-dispatch-index-migration.test.ts), for the partial index
 * that makes the recovery lane's zero-match case an empty index range instead of
 * a filtered walk of the agent's whole queue.
 *
 * The wrong-index case here is the one most likely to happen in practice:
 * precreating with `(agent_id, created_at)` and no `id`, or omitting the
 * jsonb `source` clause from the predicate so the index degenerates into
 * "every queued row" — either silently reintroduces the scan this migration
 * exists to remove, so the guard must reject them rather than accept a
 * same-named index.
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

const MIGRATION_FILE = "0209_heartbeat_runs_recovery_dispatch_index.sql";
const INDEX_NAME = "heartbeat_runs_recovery_dispatch_idx";
const INDEX_DEFINITION =
  `ON heartbeat_runs USING btree (agent_id, created_at, id) `
  + `WHERE status = 'queued' AND (context_snapshot ->> 'source') = 'issue_recovery_action'`;
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

describeEmbeddedPostgres("heartbeat-run recovery dispatch index migration", () => {
  it("requires online precreation for a populated heartbeat_runs table", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-recovery-index-");
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

    await expect(applyPendingMigrations(database.connectionString)).rejects.toMatchObject({
      message: "migration 0209 requires online index precreation",
      hint: expect.stringContaining(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${INDEX_NAME}`),
    });
    expect(await inspectMigrations(database.connectionString)).toMatchObject({
      status: "needsMigrations",
      pendingMigrations: [MIGRATION_FILE],
    });

    // Precreating it online is what unblocks the rollout. This doubles as
    // proof that the guard ACCEPTS the exact command its own hint prints.
    await sql.unsafe(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS ${INDEX_NAME} ${INDEX_DEFINITION}
    `);
    await applyPendingMigrations(database.connectionString);

    expect((await inspectMigrations(database.connectionString)).status).toBe("upToDate");
  }, 60_000);

  it("rejects an invalid precreated index with repair instructions", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-recovery-invalid-");
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
      message: "migration 0209 found an invalid or incorrectly defined prerequisite index",
      hint: expect.stringContaining(`DROP INDEX CONCURRENTLY IF EXISTS ${INDEX_NAME}`),
    });
    expect(await inspectMigrations(database.connectionString)).toMatchObject({
      status: "needsMigrations",
      pendingMigrations: [MIGRATION_FILE],
    });
  }, 60_000);

  it("rejects a same-name index that is missing the id tiebreak column", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-recovery-cols-");
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
      WHERE status = 'queued' AND (context_snapshot ->> 'source') = 'issue_recovery_action'
    `);

    await expect(applyPendingMigrations(database.connectionString)).rejects.toMatchObject({
      message: "migration 0209 found an invalid or incorrectly defined prerequisite index",
      hint: expect.stringContaining(`CREATE INDEX CONCURRENTLY ${INDEX_NAME}`),
    });
    expect(await inspectMigrations(database.connectionString)).toMatchObject({
      status: "needsMigrations",
      pendingMigrations: [MIGRATION_FILE],
    });
  }, 60_000);

  it("rejects a same-name index whose predicate omits the recovery-source clause", async () => {
    // The failure mode with teeth. An index on the right COLUMNS but predicated
    // only on `status = 'queued'` covers every queued row, so the lane's source
    // filter becomes a post-filter again and the zero-match case walks the
    // agent's whole queue — exactly the cost this migration removes, silently
    // restored, under a name that looks correct.
    const database = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-recovery-pred-");
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
      WHERE status = 'queued'
    `);

    await expect(applyPendingMigrations(database.connectionString)).rejects.toMatchObject({
      message: "migration 0209 found an invalid or incorrectly defined prerequisite index",
      hint: expect.stringContaining(`CREATE INDEX CONCURRENTLY ${INDEX_NAME}`),
    });
    expect(await inspectMigrations(database.connectionString)).toMatchObject({
      status: "needsMigrations",
      pendingMigrations: [MIGRATION_FILE],
    });
  }, 60_000);

  it("rejects same-name indexes with broader or wrong recovery predicates", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-recovery-pred-shape-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    cleanups.push(async () => sql.end());

    const invalidPredicates = [
      "status = 'queued' OR (context_snapshot ->> 'source') = 'issue_recovery_action'",
      "status = 'queued' AND (context_snapshot ->> 'source') <> 'issue_recovery_action'",
      "status = 'queued' AND (context_snapshot ->> 'source') = 'issue_recovery_action' AND (context_snapshot ->> 'recoveryActionId') IS NOT NULL",
    ];

    for (const predicate of invalidPredicates) {
      await sql`
        DELETE FROM "drizzle"."__drizzle_migrations"
        WHERE "hash" = ${await migrationHash()}
      `;
      await sql.unsafe(`
        DROP INDEX IF EXISTS ${INDEX_NAME};
        CREATE INDEX ${INDEX_NAME}
        ON heartbeat_runs USING btree (agent_id, created_at, id)
        WHERE ${predicate}
      `);

      await expect(applyPendingMigrations(database.connectionString)).rejects.toMatchObject({
        message: "migration 0209 found an invalid or incorrectly defined prerequisite index",
        hint: expect.stringContaining(`CREATE INDEX CONCURRENTLY ${INDEX_NAME}`),
      });
      expect(await inspectMigrations(database.connectionString)).toMatchObject({
        status: "needsMigrations",
        pendingMigrations: [MIGRATION_FILE],
      });
    }
  }, 90_000);
});
