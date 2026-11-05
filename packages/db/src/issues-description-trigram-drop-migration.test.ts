/**
 * Migration 0274 drops issues_description_search_idx, which duplicated the
 * company-scoped twin from 0268 and doubled the GIN write cost of every non-HOT
 * issues update. Like 0272 it must never take ACCESS EXCLUSIVE on a
 * production-scale issues table (BLO-51377): production dropped it online
 * first, a production-scale table that still has it fails closed, and a small
 * table drops inline.
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

const MIGRATION_FILE = "0274_issues_drop_unscoped_description_trigram_index.sql";
const DROPPED_INDEX = "issues_description_search_idx";
const TWIN_INDEX = "issues_company_description_search_idx";
// Production's estimate when 0274 was written; the migration's line is 10,000.
const PRODUCTION_RELTUPLES = 58_000;

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

/** Every migration applied, then 0274 rewound: journal row deleted and the index put back. */
async function startDatabaseWith0274Rewound(prefix: string, { productionScale }: { productionScale: boolean }) {
  const database = await startEmbeddedPostgresTestDatabase(prefix);
  cleanups.push(database.cleanup);
  const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
  cleanups.push(async () => sql.end());

  await applyPendingMigrations(database.connectionString);
  await sql`DELETE FROM "drizzle"."__drizzle_migrations" WHERE "hash" = ${await migrationHash()}`;
  await sql.unsafe(`CREATE INDEX ${DROPPED_INDEX} ON issues USING gin (description gin_trgm_ops)`);
  if (productionScale) {
    await sql`UPDATE pg_class SET reltuples = ${PRODUCTION_RELTUPLES} WHERE oid = 'issues'::regclass`;
  }
  return { database, sql };
}

async function issuesIndexNames(sql: postgres.Sql): Promise<string[]> {
  const rows = await sql<{ indexname: string }[]>`
    SELECT indexname FROM pg_indexes WHERE tablename = 'issues' ORDER BY indexname
  `;
  return rows.map((row) => row.indexname);
}

describeEmbeddedPostgres("issues un-scoped description trigram index drop (0274)", () => {
  it("fails closed on a production-scale table instead of dropping inline", async () => {
    const { database, sql } = await startDatabaseWith0274Rewound("paperclip-0274-prod-", { productionScale: true });

    // MESSAGE, not just HINT: the deploy pre-flight prints only `code: message`.
    await expect(applyPendingMigrations(database.connectionString)).rejects.toMatchObject({
      message: expect.stringContaining(`DROP INDEX CONCURRENTLY IF EXISTS ${DROPPED_INDEX}`),
    });
    expect(await issuesIndexNames(sql)).toContain(DROPPED_INDEX);
    expect((await inspectMigrations(database.connectionString)).status).toBe("needsMigrations");
  }, 180_000);

  it("is a no-op on a production-scale table once the index was dropped online", async () => {
    const { database, sql } = await startDatabaseWith0274Rewound("paperclip-0274-online-", { productionScale: true });
    await sql.unsafe(`DROP INDEX CONCURRENTLY ${DROPPED_INDEX}`);

    await applyPendingMigrations(database.connectionString);

    expect((await inspectMigrations(database.connectionString)).status).toBe("upToDate");
  }, 180_000);

  it("drops it inline on a small table and keeps the company-scoped twin", async () => {
    const { database, sql } = await startDatabaseWith0274Rewound("paperclip-0274-small-", { productionScale: false });

    await applyPendingMigrations(database.connectionString);

    expect((await inspectMigrations(database.connectionString)).status).toBe("upToDate");
    const names = await issuesIndexNames(sql);
    expect(names).not.toContain(DROPPED_INDEX);
    expect(names).toContain(TWIN_INDEX);
  }, 180_000);
});
