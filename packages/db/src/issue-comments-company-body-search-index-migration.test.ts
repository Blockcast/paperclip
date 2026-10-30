/**
 * PEN-3596 review: migration 0269's DO block is the backstop that runs when
 * the concurrent-index guard was bypassed, and it is the LAST thing standing
 * between a hand-typed precreate and `DROP INDEX issue_comments_body_search_idx`
 * on the final line of the same migration.
 *
 * The axis that matters here is the operator class, and it is the one a
 * structural check cannot see by accident: `pg_get_indexdef(oid, n, TRUE)`
 * selects attrsOnly mode for a non-zero column number and prints a bare
 * `body` with no opclass, and `indoption` carries sort/NULL flags. So
 * `gin (company_id, body)` -- btree_gin's default `text_ops`, which cannot
 * serve `ILIKE '%...%'` at all, and a plausible slip when hand-typing the
 * CONCURRENTLY command -- is identical to the right index on indnkeyatts,
 * indnatts, access method, key columns AND indoption. Accepting one would
 * drop the only trigram index on the largest table in the schema and restore
 * the scan this migration exists to remove, with no error anywhere.
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

const MIGRATION_FILE = "0269_issue_comments_company_scoped_trigram_search_index.sql";
const INDEX_NAME = "issue_comments_company_body_search_idx";
const REPLACED_INDEX_NAME = "issue_comments_body_search_idx";
const CORRECT_DEFINITION = "ON issue_comments USING gin (company_id, body gin_trgm_ops)";
const COMPANY = "11111111-1111-4111-8111-111111111111";
const ISSUE = "22222222-2222-4222-8222-222222222222";

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
 * Bring the database to the state 0269 actually runs against: every migration
 * applied, then 0269 rewound -- both its journal row and the two index states
 * it owns -- so the next `applyPendingMigrations` re-executes its DO block.
 */
async function startDatabaseWith0269Rewound(prefix: string) {
  const database = await startEmbeddedPostgresTestDatabase(prefix);
  cleanups.push(database.cleanup);
  const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
  cleanups.push(async () => sql.end());

  await applyPendingMigrations(database.connectionString);
  await sql`DELETE FROM "drizzle"."__drizzle_migrations" WHERE "hash" = ${await migrationHash()}`;
  await sql.unsafe(`
    DROP INDEX IF EXISTS ${INDEX_NAME};
    CREATE INDEX IF NOT EXISTS ${REPLACED_INDEX_NAME} ON issue_comments USING gin (body gin_trgm_ops);
  `);
  return { database, sql };
}

async function insertOneComment(sql: postgres.Sql) {
  await sql.unsafe(`
    SET session_replication_role = replica;
    INSERT INTO issue_comments (company_id, issue_id, body) VALUES ('${COMPANY}', '${ISSUE}', 'seed');
    SET session_replication_role = origin;
  `);
}

async function indexNames(sql: postgres.Sql): Promise<string[]> {
  const rows = await sql<{ indexname: string }[]>`
    SELECT indexname FROM pg_indexes WHERE tablename = 'issue_comments' ORDER BY indexname
  `;
  return rows.map((row) => row.indexname);
}

describeEmbeddedPostgres("issue_comments company-scoped trigram index migration (0269)", () => {
  it("rejects a precreated index built with the default operator class", async () => {
    const { database, sql } = await startDatabaseWith0269Rewound("paperclip-0269-opclass-");
    // The mistake: `gin_trgm_ops` omitted, so btree_gin supplies `text_ops`.
    await sql.unsafe(`CREATE INDEX ${INDEX_NAME} ON issue_comments USING gin (company_id, body)`);

    await expect(applyPendingMigrations(database.connectionString)).rejects.toMatchObject({
      message: `migration 0269 found an invalid or incorrectly defined ${INDEX_NAME}`,
      hint: expect.stringContaining(`DROP INDEX CONCURRENTLY IF EXISTS ${INDEX_NAME}`),
    });

    // The whole point of failing here: the DROP on 0269's last line must not
    // have run, so the trigram index this migration replaces is still in place
    // and comment search still has an index to use.
    expect(await indexNames(sql)).toContain(REPLACED_INDEX_NAME);
    expect((await inspectMigrations(database.connectionString)).status).toBe("needsMigrations");
  }, 180_000);

  it("accepts a correctly-opclassed precreate and then drops the single-column index", async () => {
    const { database, sql } = await startDatabaseWith0269Rewound("paperclip-0269-precreate-");
    await insertOneComment(sql);
    await sql.unsafe(`CREATE INDEX ${INDEX_NAME} ${CORRECT_DEFINITION}`);

    await applyPendingMigrations(database.connectionString);

    expect((await inspectMigrations(database.connectionString)).status).toBe("upToDate");
    const names = await indexNames(sql);
    expect(names).toContain(INDEX_NAME);
    expect(names).not.toContain(REPLACED_INDEX_NAME);
  }, 180_000);

  it("requires online precreation rather than building inline on a populated table", async () => {
    const { database, sql } = await startDatabaseWith0269Rewound("paperclip-0269-populated-");
    await insertOneComment(sql);

    await expect(applyPendingMigrations(database.connectionString)).rejects.toMatchObject({
      message: "migration 0269 requires online index precreation",
      hint: expect.stringContaining(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${INDEX_NAME}`),
    });
    // Failing closed must leave the table with the index it already had.
    expect(await indexNames(sql)).toContain(REPLACED_INDEX_NAME);
  }, 180_000);
});
