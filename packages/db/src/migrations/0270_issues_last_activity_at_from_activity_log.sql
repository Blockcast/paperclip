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
-- This migration adds the missing arm and then repairs the drift that
-- accumulated while it was missing. After it, the column IS the definition of
-- "last activity on this issue"; `issueCanonicalLastActivityAtExpr` is deleted
-- in the same change.
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
--> statement-breakpoint

-- ── one-shot drift repair ────────────────────────────────────────────────────
--
-- Re-runs 0076's backfill expression over every issue, in keyset batches by id,
-- and advances the column where it has fallen behind. This is a REPAIR of drift
-- that could only accumulate while the arm above was missing, not a new
-- backfill: it runs after the trigger is armed, so no row can drift back out
-- between the two.
--
-- ⚠️ WHAT THE BATCHING DOES AND DOES NOT BUY. Each migration file runs inside a
-- single transaction, so row locks taken by batch 1 are still held at batch N.
-- The batching bounds statement duration, per-statement memory and WAL record
-- size -- it does NOT shorten lock hold time. It is the same keyset shape 0154
-- uses, and it acquires in ascending `id` order, which is the order every
-- trigger above locks in.
--
-- The guard is `<`, never `<>`: the column is monotone and a disagreement in
-- the other direction (a deleted comment, an activity row removed) is the
-- column being deliberately ahead, not drift.
--
-- `created_at` is in the GREATEST because 0076's backfill has it. It can only
-- matter for a row whose `created_at` postdates its `updated_at`, which no
-- live write path produces; it is kept so this expression stays byte-comparable
-- with the one it re-runs.
DO $$
DECLARE
  last_issue_id uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  next_issue_id uuid;
BEGIN
  LOOP
    next_issue_id := NULL;

    WITH batch AS MATERIALIZED (
      SELECT
        i."id",
        i."company_id",
        i."created_at",
        i."updated_at",
        i."last_activity_at"
      FROM "issues" i
      WHERE i."id" > last_issue_id
      ORDER BY i."id"
      LIMIT 2000
    ),
    computed AS (
      SELECT
        b."id",
        GREATEST(
          b."last_activity_at",
          b."updated_at",
          b."created_at",
          COALESCE(
            (
              SELECT MAX(c."created_at")
              FROM "issue_comments" c
              WHERE c."issue_id" = b."id"
                AND c."company_id" = b."company_id"
            ),
            to_timestamp(0)
          ),
          COALESCE(
            (
              SELECT MAX(al."created_at")
              FROM "activity_log" al
              WHERE al."company_id" = b."company_id"
                AND al."entity_type" = 'issue'
                AND al."entity_id" = b."id"::text
                AND al."action" NOT IN (
                  'issue.read_marked',
                  'issue.read_unmarked',
                  'issue.inbox_archived',
                  'issue.inbox_unarchived'
                )
            ),
            to_timestamp(0)
          )
        ) AS "canonical_at"
      FROM batch b
    ),
    repaired AS (
      UPDATE "issues" AS i
      SET "last_activity_at" = c."canonical_at"
      FROM computed c
      WHERE i."id" = c."id"
        AND i."last_activity_at" < c."canonical_at"
      RETURNING i."id"
    )
    SELECT b."id"
    INTO next_issue_id
    FROM batch b
    LEFT JOIN repaired r ON r."id" = b."id"
    ORDER BY b."id" DESC
    LIMIT 1;

    EXIT WHEN next_issue_id IS NULL;
    last_issue_id := next_issue_id;
  END LOOP;
END $$;
