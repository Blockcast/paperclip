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
 * ⚠️ The drift test calls the SHIPPED repair, `repairIssuesLastActivityDrift`,
 * not a copy of its SQL. A copy would drift from the shipped statement
 * silently, which is the exact failure mode this row exists to close.
 *
 * That repair is deliberately NOT in a migration. 0270 armed this trigger and
 * ran the repair in the same statement list, and because
 * `applyPendingMigrationsManually` wraps one migration file in one
 * transaction, the `CREATE TRIGGER`'s SHARE ROW EXCLUSIVE lock on
 * `activity_log` was held for the length of the whole repair -- blocking every
 * insert for 35 minutes on 2026-11-02. The trigger now ships alone in
 * `0271_issues_last_activity_at_activity_log_trigger.sql`; the repair commits
 * per batch from `issues-last-activity-drift-repair.ts`.
 */
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  countIssuesLastActivityDrift,
  repairIssuesLastActivityDrift,
} from "./issues-last-activity-drift-repair.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const TRIGGER_MIGRATION_SUFFIX = "_issues_last_activity_at_activity_log_trigger.sql";

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

/** The trigger migration's top-level statements, with SQL comments stripped. */
function triggerMigrationStatements(): string[] {
  const migrationsDir = new URL("./migrations/", import.meta.url);
  const matches = fs
    .readdirSync(migrationsDir)
    .filter((file) => file.endsWith(TRIGGER_MIGRATION_SUFFIX))
    .sort();
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one migration ending in ${TRIGGER_MIGRATION_SUFFIX}, `
      + `found ${matches.length}: ${matches.join(", ")}`,
    );
  }

  // Split on the breakpoint BEFORE stripping comments: `--> statement-breakpoint`
  // is itself `--`-prefixed, so stripping first would delete every delimiter
  // and collapse the file into one statement.
  return fs
    .readFileSync(new URL(matches[0]!, migrationsDir), "utf8")
    .split(/-->\s*statement-breakpoint/g)
    // Comments go before any structural assertion below, so that *describing*
    // the repair in prose -- which this migration does at length -- cannot trip
    // a check meant to catch the repair being executed.
    .map((part) =>
      part
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .split("\n")
        .map((line) => line.replace(/--.*$/, ""))
        .join("\n")
        .trim())
    .filter((part) => part.length > 0);
}

/**
 * The regression guard for the 2026-11-02 02:41-03:16Z outage.
 *
 * One migration file is one transaction (`applyPendingMigrationsManually`), so
 * anything else in that file is holding the `CREATE TRIGGER`'s SHARE ROW
 * EXCLUSIVE lock on `activity_log` -- which conflicts with the ROW EXCLUSIVE
 * every INSERT takes. 0270 put a 55,903-issue repair in there and blocked
 * every `insert into activity_log` for 35 minutes.
 *
 * `check-migration-safety.ts` does NOT cover this. Its mutation rules key on
 * the MUTATED table's size bucket, and `issues` is bucketed `medium`
 * (1,609 local rows x 250 = 402,250 estimated, under the 1,000,000 `largeRows`
 * threshold), so 0270's loop was never examined -- measured, not assumed:
 * `analyzeMigrationSafety` returns zero findings for 0270's exact bytes.
 * Nothing there models a blocking DDL lock on one table held across bulk DML
 * on another.
 */
describe("the trigger migration stays DDL-only", () => {
  it("runs no DO block", () => {
    for (const statement of triggerMigrationStatements()) {
      expect(statement).not.toMatch(/\bDO\s+\$\$/i);
    }
  });

  it("runs no top-level DML", () => {
    // A CREATE FUNCTION body legitimately contains an UPDATE: it runs per
    // statement over a transition table, not in bulk, and it does not run at
    // migration time at all. Only top-level statements are in scope.
    const topLevel = triggerMigrationStatements()
      .filter((part) => !/^CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\b/i.test(part));

    expect(topLevel.length).toBeGreaterThan(0);
    for (const statement of topLevel) {
      expect(statement).not.toMatch(/^(INSERT|UPDATE|DELETE|MERGE)\b/i);
      expect(statement).toMatch(/^(CREATE|DROP|ALTER|COMMENT)\b/i);
    }
  });
});

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
    "repairs pre-trigger drift with the shipped batched one-shot",
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

      // The dry-run count restates the repair's GREATEST(...) in a second
      // place, which is the "two definitions of last activity" hazard this row
      // exists to remove. Pin them to each other: whatever the count says is
      // drifted must be exactly what the repair then advances.
      const predicted = await countIssuesLastActivityDrift(sql);
      expect(predicted).toBe(beforeRepair.length);

      // batchSize 1 so the keyset cursor has to advance across several
      // batches: a cursor that failed to advance would loop forever, and one
      // advanced by REPAIRED rather than SCANNED rows would re-scan an
      // already-correct row forever. A single-batch run would hide both.
      const firstPass = await repairIssuesLastActivityDrift(sql, { batchSize: 1 });
      expect(firstPass.batches).toBeGreaterThan(1);
      expect(firstPass.repaired).toBe(2);
      expect(firstPass.repaired).toBe(predicted);
      expect(await countIssuesLastActivityDrift(sql)).toBe(0);

      expect(await divergences(sql)).toEqual([]);
      expect((await columnAt(sql, ISSUE_A)).getTime()).toBe(drifted.getTime());

      // Idempotent: a second pass is a no-op, not a second advance.
      const repaired = await columnAt(sql, ISSUE_B);
      const secondPass = await repairIssuesLastActivityDrift(sql, { batchSize: 1 });
      expect(secondPass.repaired).toBe(0);
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
