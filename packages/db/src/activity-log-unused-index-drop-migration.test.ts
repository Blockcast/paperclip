/**
 * BLO-52494: migration 0272 drops two unused activity_log indexes, and must
 * never do it by taking ACCESS EXCLUSIVE on a production-scale activity_log --
 * the lock stall that withdrew 0270 (BLO-51377). Production dropped both
 * online first, which makes the file a no-op there; on any other
 * production-scale table where either is still present it fails closed with
 * the CONCURRENTLY commands. A small table (local, worktree, restored, CI)
 * drops inline.
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

const MIGRATION_FILE = "0272_activity_log_drop_unused_indexes.sql";
const RESPONSIBLE_USER_INDEX = "activity_log_company_responsible_user_created_idx";
const ISSUE_ENTITY_INDEX = "idx_activity_log_issue_entity_created";
const COMPANY = "11111111-1111-4111-8111-111111111111";
// Production's estimate when 0272 was written; the migration's line is 100,000.
const PRODUCTION_RELTUPLES = 3_400_000;

const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
}, 60_000);

async function migrationHash() {
  const content = await fs.promises.readFile(
    new URL(`./migrations/${MIGRATION_FILE}`, import.meta.url),
    "utf8",
  );
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Every migration applied, then 0272 rewound: its journal row deleted and both
 * indexes put back as production had them -- B INVALID, the leftover of a
 * failed CONCURRENTLY build -- with one row seeded, so the next
 * `applyPendingMigrations` re-executes the DO block. `productionScale` sets the
 * planner's row estimate to production's, which is what the migration gates on.
 */
async function startDatabaseWith0272Rewound(prefix: string, { productionScale }: { productionScale: boolean }) {
  const database = await startEmbeddedPostgresTestDatabase(prefix);
  cleanups.push(database.cleanup);
  const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
  cleanups.push(async () => sql.end());

  await applyPendingMigrations(database.connectionString);
  await sql`DELETE FROM "drizzle"."__drizzle_migrations" WHERE "hash" = ${await migrationHash()}`;
  await sql.unsafe(`
    CREATE INDEX ${RESPONSIBLE_USER_INDEX}
      ON activity_log USING btree (company_id, responsible_user_id, created_at);
    CREATE INDEX ${ISSUE_ENTITY_INDEX}
      ON activity_log USING btree (entity_id, created_at DESC) WHERE entity_type = 'issue';
    UPDATE pg_index SET indisvalid = false WHERE indexrelid = '${ISSUE_ENTITY_INDEX}'::regclass;
    SET session_replication_role = replica;
    INSERT INTO activity_log (company_id, actor_id, action, entity_type, entity_id)
      VALUES ('${COMPANY}', 'seed', 'seeded', 'issue', 'seed');
    SET session_replication_role = origin;
  `);
  if (productionScale) {
    await sql`UPDATE pg_class SET reltuples = ${PRODUCTION_RELTUPLES} WHERE oid = 'activity_log'::regclass`;
  }
  return { database, sql };
}

async function activityLogIndexNames(sql: postgres.Sql): Promise<string[]> {
  const rows = await sql<{ indexname: string }[]>`
    SELECT indexname FROM pg_indexes WHERE tablename = 'activity_log' ORDER BY indexname
  `;
  return rows.map((row) => row.indexname);
}

describeEmbeddedPostgres("activity_log unused-index drop migration (0272)", () => {
  it("fails closed on a production-scale table instead of dropping inline", async () => {
    const { database, sql } = await startDatabaseWith0272Rewound("paperclip-0272-prod-", { productionScale: true });

    // MESSAGE, not just HINT: the deploy pre-flight prints only `code: message`.
    await expect(applyPendingMigrations(database.connectionString)).rejects.toMatchObject({
      message: expect.stringMatching(
        new RegExp(`${RESPONSIBLE_USER_INDEX}.*${ISSUE_ENTITY_INDEX}.*DROP INDEX CONCURRENTLY IF EXISTS`),
      ),
      hint: expect.stringContaining(`DROP INDEX CONCURRENTLY IF EXISTS ${RESPONSIBLE_USER_INDEX}`),
    });

    // Failing closed must leave both indexes exactly where they were.
    const names = await activityLogIndexNames(sql);
    expect(names).toContain(RESPONSIBLE_USER_INDEX);
    expect(names).toContain(ISSUE_ENTITY_INDEX);
    expect((await inspectMigrations(database.connectionString)).status).toBe("needsMigrations");
  }, 180_000);

  it("fails closed when only the INVALID index is still present", async () => {
    const { database, sql } = await startDatabaseWith0272Rewound("paperclip-0272-partial-", { productionScale: true });
    await sql.unsafe(`DROP INDEX ${RESPONSIBLE_USER_INDEX}`);

    await expect(applyPendingMigrations(database.connectionString)).rejects.toMatchObject({
      hint: expect.stringContaining(`DROP INDEX CONCURRENTLY IF EXISTS ${ISSUE_ENTITY_INDEX}`),
    });
    expect(await activityLogIndexNames(sql)).toContain(ISSUE_ENTITY_INDEX);
  }, 180_000);

  it("is a no-op on a production-scale table once both indexes were dropped online", async () => {
    const { database, sql } = await startDatabaseWith0272Rewound("paperclip-0272-online-", { productionScale: true });
    // One statement per call: CONCURRENTLY refuses to run inside the implicit
    // transaction a multi-statement string opens.
    await sql.unsafe(`DROP INDEX CONCURRENTLY ${RESPONSIBLE_USER_INDEX}`);
    await sql.unsafe(`DROP INDEX CONCURRENTLY ${ISSUE_ENTITY_INDEX}`);

    await applyPendingMigrations(database.connectionString);

    expect((await inspectMigrations(database.connectionString)).status).toBe("upToDate");
    expect(await sql`SELECT count(*)::int AS n FROM activity_log`).toEqual([{ n: 1 }]);
  }, 180_000);

  it("drops both inline on a small populated table, the INVALID one included", async () => {
    const { database, sql } = await startDatabaseWith0272Rewound("paperclip-0272-small-", { productionScale: false });

    await applyPendingMigrations(database.connectionString);

    expect((await inspectMigrations(database.connectionString)).status).toBe("upToDate");
    const names = await activityLogIndexNames(sql);
    expect(names).not.toContain(RESPONSIBLE_USER_INDEX);
    expect(names).not.toContain(ISSUE_ENTITY_INDEX);
    expect(await sql`SELECT count(*)::int AS n FROM activity_log`).toEqual([{ n: 1 }]);
  }, 180_000);

  it("drops the 0199 index inline on a fresh database", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-0272-fresh-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    cleanups.push(async () => sql.end());

    await applyPendingMigrations(database.connectionString);

    expect((await inspectMigrations(database.connectionString)).status).toBe("upToDate");
    const names = await activityLogIndexNames(sql);
    expect(names).not.toContain(RESPONSIBLE_USER_INDEX);
    expect(names).not.toContain(ISSUE_ENTITY_INDEX);
    // The indexes the live readers use are untouched.
    expect(names).toEqual(
      expect.arrayContaining([
        "activity_log_company_created_idx",
        "activity_log_company_agent_created_idx",
        "idx_activity_log_issue_company_entity_created",
        "idx_activity_log_issue_company_entity_action_created",
      ]),
    );
  }, 180_000);
});
