-- PEN-5213: close the one maintenance gap in `issues.last_activity_at`, so the
-- issues-list ORDER BY can be served from the column instead of recomputing a
-- correlated `GREATEST(...)` per candidate row.
--
-- 0076 materialised the column and maintains it from three of the four arms its
-- own backfill computes:
--   1. BEFORE INSERT on issues        -> mirrors updated_at
--   2. BEFORE UPDATE on issues        -> mirrors any updated_at advance
--   3. AFTER INSERT on issue_comments -> bumps to the new comment's created_at
--      (rewritten statement-level, with stable lock ordering, by 0229)
--
-- Nothing bumps it from an `activity_log` insert. 0229 DOES add statement-level
-- AFTER INSERT/UPDATE/DELETE triggers on activity_log, but they are lock
-- ordering (`human_gated_digest_lock_*`) and never touch last_activity_at. So
-- an activity row that postdates both updated_at and the newest comment
-- advances the inline expression and NOT the column -- which is exactly the
-- divergence that made repointing the ORDER BY unsafe.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- ⛔ THIS MIGRATION ARMS THE TRIGGER AND NOTHING ELSE. DO NOT ADD THE DRIFT
-- REPAIR BACK INTO IT.
--
-- Its predecessor (0270, deleted by this change and never committed to any
-- database) armed this same trigger AND ran the whole-table drift repair in the
-- SAME statement list. `applyPendingMigrationsManually` wraps every statement of
-- one migration file in a single `runInTransaction`, so those two shared one
-- lock hold: `CREATE TRIGGER` on activity_log takes SHARE ROW EXCLUSIVE, which
-- conflicts with the ROW EXCLUSIVE every INSERT takes, and the transaction then
-- held it for the length of a 55,903-issue repair reading 3.4M activity rows.
--
-- Production outage 2026-11-02 02:41-03:16Z: every `insert into activity_log`
-- failed `55P03`, every agent run failed in setup, and API writes returned 503
-- after committing (duplicate comments). Each pod was killed by the startup
-- probe at 30 x 10s, Postgres kept the orphaned backend holding the lock, and
-- the next pod queued behind it -- so attempts accumulated faster than
-- MIGRATION_STATEMENT_TIMEOUT_MS (10min) could retire them.
--
-- Note which controls did NOT save it, because they look like they should:
-- MIGRATION_DDL_LOCK_TIMEOUT_MS (3s) bounds how long this migration WAITS to
-- acquire a lock, not how long it HOLDS one. Batching the repair bounded
-- statement duration and WAL record size, and 0270's own comment said so --
-- but row locks taken by batch 1 are still held at batch N inside one
-- transaction, so batching bought nothing that mattered here.
--
-- The repair now lives in `packages/db/src/issues-last-activity-drift-repair.ts`,
-- committed per batch, off the startup path entirely. Run it with
-- `scripts/pen-5213-last-activity-drift-repair.ts`.
-- ─────────────────────────────────────────────────────────────────────────────
--
-- ORDERING IS SAFE WITHOUT THE REPAIR. The trigger is armed first and the
-- repair runs afterwards, which is the only order that cannot lose a row: a row
-- repaired while the arm was still missing could drift straight back out. The
-- reverse -- arm now, repair later -- only ever leaves a row stale, and the
-- column is monotone, so a later repair still converges.
--
-- WHY INSERT ONLY. last_activity_at is monotone non-decreasing by construction
-- (every maintenance path is a `<` guarded bump). An activity_log UPDATE or
-- DELETE can only ever lower the computed maximum, and lowering it would
-- resurrect inbox rows a user already archived -- `inboxVisibleForUserCondition`
-- compares `archived_at >= last_activity_at`. 0076's comment trigger is
-- INSERT-only for the same reason; this matches it deliberately.

-- WRITE AMPLIFICATION, and the reason it is smaller than it looks. Advancing
-- last_activity_at is a non-HOT update (the column is indexed by
-- `issues_company_last_activity_idx`), so this arm is not free. But the bump is
-- guarded by `last_activity_at < latest_at`, and the dominant producer of
-- activity rows writes them in the SAME transaction as the `issues` UPDATE they
-- describe. `now()` is fixed for a transaction, so that activity row carries
-- exactly the `updated_at` the BEFORE UPDATE trigger already mirrored, the
-- guard is false, and no second write happens. The extra write lands only where
-- an activity row genuinely postdates both `updated_at` and the newest comment
-- -- which is precisely the case the column was previously WRONG about.

-- ── the missing maintenance arm ──────────────────────────────────────────────
--
-- Statement-level with a transition table, and an explicit ordered lock pass
-- before the UPDATE, reusing 0229's shape so the deadlock discipline is not
-- re-derived. Row-level triggers inherit the input/scan order and can deadlock
-- with the digest's ordered multi-row lock.
--
-- ⚠️ THE LOCK PASS IS DELIBERATELY A SUPERSET OF THE UPDATE SET, and that is
-- load-bearing, not defensive padding. Statement triggers fire in NAME order,
-- so `activity_log_bump_issue_last_activity_at_trigger` runs BEFORE
-- `human_gated_digest_lock_inserted_activity_issues_trigger` on the same
-- INSERT. If this trigger locked only the rows it updates, a transaction would
-- acquire issue locks in two ascending passes over DIFFERENT subsets -- and two
-- such transactions can interleave into a cycle. Concretely, with S the bump
-- set and U the digest set: txn A (S={5}, U={3,5}) takes 5 NO KEY UPDATE, txn B
-- (S={3}, U={3,5}) takes 3 NO KEY UPDATE, then each waits on the other's row in
-- its digest pass. Locking `S ∪ U` here collapses both passes into one
-- ascending acquisition per transaction, because every row the digest trigger
-- then asks for in FOR SHARE is already held in a stronger mode by the same
-- transaction. The cost is that a user-actor `issue.read_marked` row now takes
-- NO KEY UPDATE on its issue where it previously took FOR SHARE, so two
-- concurrent read-marks of the SAME issue serialise. That is a per-user action
-- on a single row; the deadlock it buys out is not.
--
-- The lock pass also runs BEFORE the `last_activity_at < latest_at` guard is
-- evaluated, so a non-excluded AGENT-actor insert now holds NO KEY UPDATE on
-- its issue until commit even when no write follows -- where before this
-- migration it took no issue lock at all. Sharing a transaction with the
-- `issues` UPDATE (the dominant case) that costs nothing, because the lock is
-- already held. Written in its OWN transaction it is a new conflict with the
-- digest's reader. Accepted deliberately: the alternative is to guard first and
-- lock second, which re-opens the two-pass cycle above, and the hold is one
-- row for the length of one short write transaction.
--
-- Every statement below is idempotent (`CREATE OR REPLACE`, `DROP ... IF
-- EXISTS`), so this migration is a no-op against a database that somehow did
-- apply 0270 before it was withdrawn.
CREATE OR REPLACE FUNCTION "activity_log_bump_issue_last_activity_at"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM locked_issue."id"
  FROM "issues" AS locked_issue
  INNER JOIN (
    SELECT DISTINCT
      activity."company_id",
      CASE
        WHEN pg_input_is_valid(activity."entity_id", 'uuid')
          THEN activity."entity_id"::uuid
        ELSE NULL
      END AS "issue_id"
    FROM "activity_log_last_activity_inserted" AS activity
    WHERE activity."entity_type" = 'issue'
      AND (
        activity."actor_type" = 'user'
        OR activity."action" NOT IN (
          'issue.read_marked',
          'issue.read_unmarked',
          'issue.inbox_archived',
          'issue.inbox_unarchived'
        )
      )
  ) AS touched_issue
    ON touched_issue."company_id" = locked_issue."company_id"
    AND touched_issue."issue_id" = locked_issue."id"
  ORDER BY locked_issue."id"
  FOR NO KEY UPDATE OF locked_issue;

  UPDATE "issues" AS issue
  SET "last_activity_at" = latest_activity."latest_at"
  FROM (
    SELECT
      issue_activity."company_id",
      issue_activity."issue_id",
      MAX(issue_activity."created_at") AS "latest_at"
    FROM (
      SELECT
        activity."company_id",
        CASE
          WHEN pg_input_is_valid(activity."entity_id", 'uuid')
            THEN activity."entity_id"::uuid
          ELSE NULL
        END AS "issue_id",
        activity."created_at"
      FROM "activity_log_last_activity_inserted" AS activity
      WHERE activity."entity_type" = 'issue'
        AND activity."action" NOT IN (
          'issue.read_marked',
          'issue.read_unmarked',
          'issue.inbox_archived',
          'issue.inbox_unarchived'
        )
    ) AS issue_activity
    WHERE issue_activity."issue_id" IS NOT NULL
    GROUP BY issue_activity."company_id", issue_activity."issue_id"
  ) AS latest_activity
  WHERE issue."company_id" = latest_activity."company_id"
    AND issue."id" = latest_activity."issue_id"
    AND issue."last_activity_at" < latest_activity."latest_at";

  RETURN NULL;
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS "activity_log_bump_issue_last_activity_at_trigger" ON "activity_log";
--> statement-breakpoint

CREATE TRIGGER "activity_log_bump_issue_last_activity_at_trigger"
AFTER INSERT ON "activity_log"
REFERENCING NEW TABLE AS "activity_log_last_activity_inserted"
FOR EACH STATEMENT
EXECUTE FUNCTION "activity_log_bump_issue_last_activity_at"();
