/**
 * PEN-5213: `issues.last_activity_at` is now the ONE definition of "last
 * activity on this issue", because the issues-list ORDER BY is served from it
 * instead of recomputing `issueCanonicalLastActivityAtExpr`'s correlated
 * `GREATEST(...)` per candidate row.
 *
 * That repoint is only sound if the column agrees with the expression it
 * replaces. Migration 0076 maintained three of the four arms and left the
 * `activity_log` one unmaintained, so before 0270 the two genuinely disagreed
 * whenever an activity row postdated both `updated_at` and the newest comment.
 *
 * This file proves the repoint is order-preserving rather than assuming it.
 * `CANONICAL_LAST_ACTIVITY_AT` below is the deleted expression, transcribed —
 * every assertion compares the live column against it on the four maintenance
 * paths (issue insert, issue update, comment insert, activity-log insert),
 * plus the exclusion set, statement-level multi-row inserts, monotonicity, and
 * the drift repair.
 *
 * ⚠️ The drift test runs the repair block EXTRACTED FROM THE MIGRATION FILE,
 * not a copy of it. A copy would drift from the shipped SQL silently, which is
 * the exact failure mode this row exists to close.
 */
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const MIGRATION_SUFFIX = "_issues_last_activity_at_from_activity_log.sql";

/**
 * The expression deleted from `server/src/services/issues.ts` by this change:
 * `GREATEST(updated_at, MAX(comment.created_at), MAX(activity.created_at))`
 * with the four local-inbox actions excluded from the activity arm.
 */
const CANONICAL_LAST_ACTIVITY_AT = `
  GREATEST(
    i."updated_at",
    COALESCE((SELECT MAX(c."created_at") FROM "issue_comments" c
              WHERE c."issue_id" = i."id" AND c."company_id" = i."company_id"), to_timestamp(0)),
    COALESCE((SELECT MAX(al."created_at") FROM "activity_log" al
              WHERE al."company_id" = i."company_id"
                AND al."entity_type" = 'issue'
                AND al."entity_id" = i."id"::text
                AND al."action" NOT IN ('issue.read_marked', 'issue.read_unmarked',
                                        'issue.inbox_archived', 'issue.inbox_unarchived')),
             to_timestamp(0))
  )`;

const COMPANY = "11111111-1111-4111-8111-111111111111";
const ISSUE_A = "22222222-2222-4222-8222-222222222222";
const ISSUE_B = "33333333-3333-4333-8333-333333333333";

const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function migrationSql(): string {
  const migrationsDir = new URL("./migrations/", import.meta.url);
  const matches = fs
    .readdirSync(migrationsDir)
    .filter((file) => file.endsWith(MIGRATION_SUFFIX))
    .sort();
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one migration ending in ${MIGRATION_SUFFIX}, found ${matches.length}: ${matches.join(", ")}`,
    );
  }
  return fs.readFileSync(new URL(matches[0]!, migrationsDir), "utf8");
}

/** The batched one-shot repair, lifted from the shipped migration. */
function driftRepairStatement(): string {
  const statements = migrationSql()
    .split(/-->\s*statement-breakpoint/g)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const repair = statements.filter((statement) => /^DO \$\$/m.test(statement));
  if (repair.length !== 1) {
    throw new Error(`expected exactly one DO block in the migration, found ${repair.length}`);
  }
  return repair[0]!;
}

type Divergence = { id: string; column_at: Date; canonical_at: Date };

async function divergences(sql: postgres.Sql): Promise<Divergence[]> {
  return (await sql.unsafe(`
    SELECT i."id", i."last_activity_at" AS column_at, ${CANONICAL_LAST_ACTIVITY_AT} AS canonical_at
    FROM "issues" i
    WHERE i."last_activity_at" IS DISTINCT FROM (${CANONICAL_LAST_ACTIVITY_AT})
    ORDER BY i."id"
  `)) as unknown as Divergence[];
}

async function columnAt(sql: postgres.Sql, issueId: string): Promise<Date> {
  const rows = (await sql.unsafe(
    `SELECT "last_activity_at" FROM "issues" WHERE "id" = $1`,
    [issueId],
  )) as unknown as Array<{ last_activity_at: Date }>;
  return rows[0]!.last_activity_at;
}

async function freshDatabase() {
  const database = await startEmbeddedPostgresTestDatabase("paperclip-pen-5213-last-activity-");
  cleanups.push(database.cleanup);
  const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
  cleanups.push(async () => sql.end());
  await sql.unsafe(
    `INSERT INTO "companies" ("id", "name") VALUES ($1, 'pen-5213') ON CONFLICT DO NOTHING`,
    [COMPANY],
  );
  return sql;
}

async function insertIssue(sql: postgres.Sql, id: string, issueNumber: number) {
  // last_activity_at is deliberately NOT named: 0076's BEFORE INSERT trigger
  // fills it from updated_at, and that fill is one of the paths under test.
  await sql.unsafe(
    `INSERT INTO "issues" ("id", "company_id", "issue_number", "title") VALUES ($1, $2, $3, $4)`,
    [id, COMPANY, issueNumber, `issue ${issueNumber}`],
  );
}

async function insertActivity(
  sql: postgres.Sql,
  rows: Array<{ issueId: string; action: string; createdAt: string; actorType?: string }>,
) {
  const values = rows
    .map((_, index) => {
      const base = index * 5;
      return `($${base + 1}::uuid, $${base + 2}::text, $${base + 3}::text, 'issue'::text, $${base + 4}::text, $${base + 5}::timestamptz)`;
    })
    .join(", ");
  await sql.unsafe(
    `INSERT INTO "activity_log" ("company_id", "actor_type", "actor_id", "action", "entity_type", "entity_id", "created_at")
     SELECT v."company_id", v."actor_type", 'pen-5213', v."action", v."entity_type", v."entity_id", v."created_at"
     FROM (VALUES ${values}) AS v("company_id", "actor_type", "action", "entity_type", "entity_id", "created_at")`,
    rows.flatMap((row) => [
      COMPANY,
      row.actorType ?? "agent",
      row.action,
      row.issueId,
      row.createdAt,
    ]),
  );
}

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
}, 120_000);

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping PEN-5213 last_activity_at maintenance tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issues.last_activity_at maintenance (PEN-5213)", () => {
  it(
    "keeps the column equal to the deleted canonical expression across every maintenance path",
    async () => {
      const sql = await freshDatabase();

      // ── path 1: issue insert ───────────────────────────────────────────
      await insertIssue(sql, ISSUE_A, 1);
      expect(await divergences(sql)).toEqual([]);

      // ── path 2: issue update (updated_at advance) ──────────────────────
      await sql.unsafe(
        `UPDATE "issues" SET "title" = 'retitled', "updated_at" = now() + interval '1 minute' WHERE "id" = $1`,
        [ISSUE_A],
      );
      const afterUpdate = await columnAt(sql, ISSUE_A);
      expect(await divergences(sql)).toEqual([]);

      // ── path 3: comment insert ─────────────────────────────────────────
      await sql.unsafe(
        `INSERT INTO "issue_comments" ("company_id", "issue_id", "body", "created_at")
         VALUES ($1, $2, 'hello', now() + interval '2 minutes')`,
        [COMPANY, ISSUE_A],
      );
      const afterComment = await columnAt(sql, ISSUE_A);
      expect(afterComment.getTime()).toBeGreaterThan(afterUpdate.getTime());
      expect(await divergences(sql)).toEqual([]);

      // ── path 4: activity_log insert — THE ARM 0270 ADDS ────────────────
      // Before 0270 this is the assertion that fails: the expression advances
      // and the column does not.
      await insertActivity(sql, [
        {
          issueId: ISSUE_A,
          action: "issue.updated",
          createdAt: new Date(afterComment.getTime() + 60_000).toISOString(),
        },
      ]);
      const afterActivity = await columnAt(sql, ISSUE_A);
      expect(afterActivity.getTime()).toBeGreaterThan(afterComment.getTime());
      expect(await divergences(sql)).toEqual([]);

      // ── the exclusion set: a local-inbox action moves neither side ─────
      await insertActivity(sql, [
        {
          issueId: ISSUE_A,
          action: "issue.read_marked",
          actorType: "user",
          createdAt: new Date(afterActivity.getTime() + 60_000).toISOString(),
        },
      ]);
      expect((await columnAt(sql, ISSUE_A)).getTime()).toBe(afterActivity.getTime());
      expect(await divergences(sql)).toEqual([]);

      // ── monotonicity: a BACKDATED activity row never lowers the column ──
      await insertActivity(sql, [
        {
          issueId: ISSUE_A,
          action: "issue.updated",
          createdAt: new Date(afterActivity.getTime() - 600_000).toISOString(),
        },
      ]);
      expect((await columnAt(sql, ISSUE_A)).getTime()).toBe(afterActivity.getTime());
      expect(await divergences(sql)).toEqual([]);
    },
    180_000,
  );

  it(
    "maintains every issue touched by one multi-row activity_log statement",
    async () => {
      const sql = await freshDatabase();
      await insertIssue(sql, ISSUE_A, 1);
      await insertIssue(sql, ISSUE_B, 2);

      const base = Date.now() + 10 * 60_000;
      // One statement, several issues, several rows per issue, deliberately out
      // of id order — the statement-level trigger has to take the per-issue MAX
      // and lock in stable id order regardless of input order.
      await insertActivity(sql, [
        { issueId: ISSUE_B, action: "issue.updated", createdAt: new Date(base + 1_000).toISOString() },
        { issueId: ISSUE_A, action: "issue.updated", createdAt: new Date(base + 2_000).toISOString() },
        { issueId: ISSUE_B, action: "issue.commented", createdAt: new Date(base + 3_000).toISOString() },
        { issueId: ISSUE_A, action: "issue.read_marked", actorType: "user", createdAt: new Date(base + 9_000).toISOString() },
      ]);

      expect(await divergences(sql)).toEqual([]);
      expect((await columnAt(sql, ISSUE_A)).getTime()).toBe(base + 2_000);
      expect((await columnAt(sql, ISSUE_B)).getTime()).toBe(base + 3_000);
    },
    180_000,
  );

  it(
    "repairs pre-0270 drift with the migration's own batched one-shot",
    async () => {
      const sql = await freshDatabase();
      await insertIssue(sql, ISSUE_A, 1);
      await insertIssue(sql, ISSUE_B, 2);

      // Reproduce the pre-0270 world: activity rows land with the new arm
      // disabled, so the expression advances and the column does not.
      await sql.unsafe(
        `ALTER TABLE "activity_log" DISABLE TRIGGER "activity_log_bump_issue_last_activity_at_trigger"`,
      );
      const drifted = new Date(Date.now() + 20 * 60_000);
      await insertActivity(sql, [
        { issueId: ISSUE_A, action: "issue.updated", createdAt: drifted.toISOString() },
        { issueId: ISSUE_B, action: "issue.status_changed", createdAt: drifted.toISOString() },
      ]);
      await sql.unsafe(
        `ALTER TABLE "activity_log" ENABLE TRIGGER "activity_log_bump_issue_last_activity_at_trigger"`,
      );

      const beforeRepair = await divergences(sql);
      expect(beforeRepair.map((row) => row.id).sort()).toEqual([ISSUE_A, ISSUE_B].sort());

      await sql.unsafe(driftRepairStatement());

      expect(await divergences(sql)).toEqual([]);
      expect((await columnAt(sql, ISSUE_A)).getTime()).toBe(drifted.getTime());

      // Idempotent: a second pass is a no-op, not a second advance.
      const repaired = await columnAt(sql, ISSUE_B);
      await sql.unsafe(driftRepairStatement());
      expect((await columnAt(sql, ISSUE_B)).getTime()).toBe(repaired.getTime());
      expect(await divergences(sql)).toEqual([]);
    },
    180_000,
  );

  it(
    "fires the bump trigger before the digest lock trigger, statement-level",
    async () => {
      const sql = await freshDatabase();
      // Statement triggers fire in NAME order. The bump trigger takes
      // FOR NO KEY UPDATE over a superset of the rows the digest trigger then
      // asks for in FOR SHARE, so every issue lock in the transaction is
      // acquired in one ascending pass. If a rename ever reordered these, two
      // transactions could acquire the same two rows in opposite orders.
      const triggers = (await sql.unsafe(`
        SELECT t."tgname", t."tgtype"
        FROM "pg_trigger" t
        JOIN "pg_class" c ON c."oid" = t."tgrelid"
        WHERE c."relname" = 'activity_log'
          AND NOT t."tgisinternal"
          AND t."tgtype" & 4 = 4
        ORDER BY t."tgname"
      `)) as unknown as Array<{ tgname: string; tgtype: number }>;

      const names = triggers.map((row) => row.tgname);
      expect(names).toContain("activity_log_bump_issue_last_activity_at_trigger");
      expect(names).toContain("human_gated_digest_lock_inserted_activity_issues_trigger");
      expect(names.indexOf("activity_log_bump_issue_last_activity_at_trigger"))
        .toBeLessThan(names.indexOf("human_gated_digest_lock_inserted_activity_issues_trigger"));

      const bump = triggers.find((row) => row.tgname === "activity_log_bump_issue_last_activity_at_trigger")!;
      // TRIGGER_TYPE_ROW is bit 0; a statement-level trigger leaves it clear.
      expect(bump.tgtype & 1).toBe(0);
    },
    180_000,
  );
});
