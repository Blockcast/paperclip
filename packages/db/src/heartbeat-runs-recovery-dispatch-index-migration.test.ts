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
 *
 * The predicate cases go further than "is the clause there at all". A guard
 * that only looks for the canonical predicate's TOKENS is fail-open: an OR
 * instead of the AND, a <> instead of the =, an extra ANDed clause, or a
 * miscased constant all contain every token and all break the lane. Those four
 * are asserted to be rejected, and the canonical predicate is asserted to still
 * be ACCEPTED — the guard has to be exact without being brittle about how
 * PostgreSQL renders the predicate back.
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

  // The predicate guard has to be fail-CLOSED, not "the right tokens appear
  // somewhere". Each of the predicates below contains every token of the
  // canonical one — `status = 'queued'`, the `->> 'source'` extraction and the
  // 'issue_recovery_action' constant — and each is wrong in a way that silently
  // breaks the lane, so a substring-based check accepts them all. They are the
  // regression cases for the canonicalized equality comparison; the last one is
  // also the reason that canonicalization stops short of folding case.
  for (const rejectedPredicate of [
    {
      label: "widens the AND into an OR",
      // Indexes every queued row plus every recovery row: the lane's zero-match
      // case is a filtered walk of the agent's whole queue again.
      predicate:
        `status = 'queued' OR (context_snapshot ->> 'source') = 'issue_recovery_action'`,
      prefix: "paperclip-heartbeat-recovery-or-",
    },
    {
      label: "inverts the source comparison",
      // Indexes the exact complement of the lane: every recovery row this index
      // is supposed to hold is the one row it leaves out.
      predicate:
        `status = 'queued' AND (context_snapshot ->> 'source') <> 'issue_recovery_action'`,
      prefix: "paperclip-heartbeat-recovery-neq-",
    },
    {
      label: "ANDs on an extra clause",
      // The clause 0209 deliberately leaves OUT (see the migration comment):
      // narrowing the index by it makes the index no longer answer the lane's
      // query on its own, and the planner may stop matching it at all.
      predicate:
        `status = 'queued' AND (context_snapshot ->> 'source') = 'issue_recovery_action'`
        + ` AND (context_snapshot ->> 'recoveryActionId') IS NOT NULL`,
      prefix: "paperclip-heartbeat-recovery-extra-",
    },
    {
      label: "miscases the recovery-source constant",
      // `=` on text is case-sensitive, so this predicate matches no row that
      // the lane ever writes: the index builds, stays empty forever, and the
      // planner happily uses it to answer "this agent has no recovery work"
      // with a wrong yes. Canonicalizing must therefore NOT fold case.
      predicate:
        `status = 'queued' AND (context_snapshot ->> 'source') = 'ISSUE_RECOVERY_ACTION'`,
      prefix: "paperclip-heartbeat-recovery-case-",
    },
  ]) {
    it(`rejects a same-name index whose predicate ${rejectedPredicate.label}`, async () => {
      const database = await startEmbeddedPostgresTestDatabase(rejectedPredicate.prefix);
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
        WHERE ${rejectedPredicate.predicate}
      `);

      await expect(applyPendingMigrations(database.connectionString)).rejects.toMatchObject({
        message: "migration 0209 found an invalid or incorrectly defined prerequisite index",
        // Remediation first, then the found-vs-expected canonical predicates:
        // without the latter an operator whose PostgreSQL renders predicates
        // differently would see a blind failure with nothing to compare.
        hint: expect.stringMatching(
          new RegExp(
            `CREATE INDEX CONCURRENTLY ${INDEX_NAME}[\\s\\S]*`
            + `Canonicalized predicate found: [\\s\\S]*expected: `,
          ),
        ),
      });
      expect(await inspectMigrations(database.connectionString)).toMatchObject({
        status: "needsMigrations",
        pendingMigrations: [MIGRATION_FILE],
      });
    }, 60_000);
  }

  it("accepts the canonical predicate however PostgreSQL chooses to render it", async () => {
    // The other side of the fail-closed guard: comparing predicates exactly must
    // not reject an index that IS correct. This precreates the canonical
    // predicate with every rendering degree of freedom the canonicalization
    // exists to erase — redundant parentheses, ragged whitespace, a lowercase
    // `and`, and mixed-case unquoted identifiers — and requires the migration to
    // accept it. The identifier/keyword casing is the load-bearing part: it is
    // what proves the guard can compare case-SENSITIVELY (so the miscased
    // 'ISSUE_RECOVERY_ACTION' constant above is still rejected) without
    // rejecting an operator who simply typed the DDL in a different case.
    const database = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-recovery-ok-");
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
      WHERE ((STATUS = 'queued')
        and (((Context_Snapshot ->> 'source')) = 'issue_recovery_action'))
    `);

    await applyPendingMigrations(database.connectionString);

    expect((await inspectMigrations(database.connectionString)).status).toBe("upToDate");
    // ...and the guard accepted the precreated index rather than replacing it.
    const [precreated] = await sql.unsafe(`
      SELECT pg_get_expr(indpred, indrelid, TRUE) AS predicate
      FROM pg_index
      WHERE indexrelid = '${INDEX_NAME}'::regclass
    `);
    expect(precreated.predicate).toContain("issue_recovery_action");
  }, 60_000);
});
