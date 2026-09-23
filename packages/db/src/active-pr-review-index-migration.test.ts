import { createHash } from "node:crypto";
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { applyPendingMigrations, inspectMigrations } from "./client.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const MIGRATION_FILE = "0236_active_pr_review_dedup.sql";
const INDEX_NAME = "issues_active_pr_review_uq";
const INDEX_DEFINITION =
  `ON issues USING btree (company_id, origin_kind, origin_fingerprint) ` +
  `WHERE origin_kind = 'pr_review' ` +
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

describeEmbeddedPostgres("Active PR review index migration", () => {
  it("requires exact online precreation for a populated issues table", async () => {
    const database = await startEmbeddedPostgresTestDatabase(
      "paperclip-pr-review-index-",
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
      message: "migration 0236 requires online index precreation",
      hint: expect.stringContaining(
        `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ${INDEX_NAME}`,
      ),
    });
    expect(await inspectMigrations(database.connectionString)).toMatchObject({
      status: "needsMigrations",
      pendingMigrations: [MIGRATION_FILE],
    });

    // Precreating exactly the documented index must satisfy the guard. This is
    // what pins `expected_predicate` in the migration to the predicate
    // Postgres actually renders for this DDL; a drifted literal fails here.
    await sql.unsafe(`
      CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ${INDEX_NAME} ${INDEX_DEFINITION}
    `);
    await applyPendingMigrations(database.connectionString);

    expect((await inspectMigrations(database.connectionString)).status).toBe(
      "upToDate",
    );
  }, 60_000);

  it("names pre-existing duplicate active pr_review rows instead of demanding an index that cannot be built", async () => {
    const database = await startEmbeddedPostgresTestDatabase(
      "paperclip-pr-review-index-dupe-",
    );
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, {
      max: 1,
      onnotice: () => {},
    });
    cleanups.push(async () => sql.end());

    // Two unresolved review requests for one (repo, PR) — exactly the fan-out
    // shape this migration exists to stop, so a database that predates the
    // index can legitimately hold it.
    // The index must go first: while it exists it correctly refuses the second
    // row, which is the state a pre-0236 database does not have.
    await sql.unsafe(`
      DROP INDEX ${INDEX_NAME};
      SET session_replication_role = replica;
      INSERT INTO issues (company_id, title, last_activity_at, origin_kind, origin_fingerprint)
      VALUES
        ('11111111-1111-4111-8111-111111111111', 'review #876 at 15a949a4', now(),
         'pr_review', 'pr_review:blockcast/paperclip:876'),
        ('11111111-1111-4111-8111-111111111111', 'review #876 at ad0da2bc', now(),
         'pr_review', 'pr_review:blockcast/paperclip:876');
      SET session_replication_role = origin;
    `);
    await sql`
      DELETE FROM "drizzle"."__drizzle_migrations"
      WHERE "hash" = ${await migrationHash()}
    `;

    // Without this branch the operator is told to precreate the index, that
    // CREATE ... CONCURRENTLY fails on the collision leaving an INVALID index,
    // and the retry then reports a bad index — a loop that never once names
    // the duplicate rows that are the actual cause.
    await expect(
      applyPendingMigrations(database.connectionString),
    ).rejects.toMatchObject({
      message: "migration 0236 found duplicate active pr_review issues",
      hint: expect.stringContaining("pr_review:blockcast/paperclip:876"),
    });
    expect(await inspectMigrations(database.connectionString)).toMatchObject({
      status: "needsMigrations",
      pendingMigrations: [MIGRATION_FILE],
    });

    // Reconciling the duplicate (the losers of a fan-out are resolvable) must
    // then let the documented precreation path succeed.
    await sql`
      UPDATE issues SET status = 'done'
      WHERE title = 'review #876 at 15a949a4'
    `;
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
      "paperclip-pr-review-index-wrong-",
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
      WHERE origin_kind = 'pr_review'
    `);

    await expect(
      applyPendingMigrations(database.connectionString),
    ).rejects.toMatchObject({
      message:
        "migration 0236 found an invalid or incorrectly defined prerequisite index",
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
