-- BLO-29420 - coordinate human-clock reads with touch mutations.
--
-- The digest locks candidate issue rows with FOR NO KEY UPDATE before reading
-- `issue_comments` and `activity_log`. Human-clock mutations take FOR SHARE on
-- the same rows, so whichever transaction reaches the issue lock first defines
-- the snapshot observed by the digest.
--
-- These are statement-level transition-table triggers rather than row-level
-- triggers. They lock every affected issue once and in stable UUID order. That
-- matters for bulk writes: row triggers inherit the input/scan order and can
-- deadlock with the digest's ordered multi-row lock. FOR NO KEY UPDATE is also
-- deliberate. It conflicts with FOR SHARE but remains compatible with the FOR
-- KEY SHARE lock taken by the issue_comments foreign key.

-- The existing per-row comment insert trigger updates parent issues in input
-- order. Replace it with an equivalent statement-level aggregate that locks
-- all parents in stable order before maintaining last_activity_at. Besides
-- preserving that materialized field, this lock coordinates comment inserts
-- (human or otherwise) with the digest snapshot.
DROP TRIGGER IF EXISTS "issue_comments_bump_issue_last_activity_at_trigger" ON "issue_comments";
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "issue_comments_bump_issue_last_activity_at"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM locked_issue."id"
  FROM "issues" AS locked_issue
  INNER JOIN (
    SELECT DISTINCT inserted_comment."issue_id"
    FROM "human_gated_digest_inserted_comments" AS inserted_comment
  ) AS touched_issue
    ON touched_issue."issue_id" = locked_issue."id"
  ORDER BY locked_issue."id"
  FOR NO KEY UPDATE OF locked_issue;

  UPDATE "issues" AS issue
  SET "last_activity_at" = latest_comment."latest_at"
  FROM (
    SELECT
      inserted_comment."issue_id",
      MAX(inserted_comment."created_at") AS "latest_at"
    FROM "human_gated_digest_inserted_comments" AS inserted_comment
    GROUP BY inserted_comment."issue_id"
  ) AS latest_comment
  WHERE issue."id" = latest_comment."issue_id"
    AND issue."last_activity_at" < latest_comment."latest_at";

  RETURN NULL;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER "issue_comments_bump_issue_last_activity_at_trigger"
AFTER INSERT ON "issue_comments"
REFERENCING NEW TABLE AS "human_gated_digest_inserted_comments"
FOR EACH STATEMENT
EXECUTE FUNCTION "issue_comments_bump_issue_last_activity_at"();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "human_gated_digest_lock_inserted_activity_issues"()
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
    FROM "human_gated_digest_inserted_activity" AS activity
    WHERE activity."entity_type" = 'issue'
      AND activity."actor_type" = 'user'
  ) AS touched_issue
    ON touched_issue."company_id" = locked_issue."company_id"
    AND touched_issue."issue_id" = locked_issue."id"
  ORDER BY locked_issue."id"
  FOR SHARE OF locked_issue;

  RETURN NULL;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "human_gated_digest_lock_updated_activity_issues"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM locked_issue."id"
  FROM "issues" AS locked_issue
  INNER JOIN (
    SELECT
      old_activity."company_id",
      CASE
        WHEN pg_input_is_valid(old_activity."entity_id", 'uuid')
          THEN old_activity."entity_id"::uuid
        ELSE NULL
      END AS "issue_id"
    FROM "human_gated_digest_old_activity" AS old_activity
    WHERE old_activity."entity_type" = 'issue'
      AND old_activity."actor_type" = 'user'

    UNION

    SELECT
      new_activity."company_id",
      CASE
        WHEN pg_input_is_valid(new_activity."entity_id", 'uuid')
          THEN new_activity."entity_id"::uuid
        ELSE NULL
      END AS "issue_id"
    FROM "human_gated_digest_new_activity" AS new_activity
    WHERE new_activity."entity_type" = 'issue'
      AND new_activity."actor_type" = 'user'
  ) AS touched_issue
    ON touched_issue."company_id" = locked_issue."company_id"
    AND touched_issue."issue_id" = locked_issue."id"
  ORDER BY locked_issue."id"
  FOR SHARE OF locked_issue;

  RETURN NULL;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "human_gated_digest_lock_deleted_activity_issues"()
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
    FROM "human_gated_digest_deleted_activity" AS activity
    WHERE activity."entity_type" = 'issue'
      AND activity."actor_type" = 'user'
  ) AS touched_issue
    ON touched_issue."company_id" = locked_issue."company_id"
    AND touched_issue."issue_id" = locked_issue."id"
  ORDER BY locked_issue."id"
  FOR SHARE OF locked_issue;

  RETURN NULL;
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS "human_gated_digest_lock_activity_issue_trigger" ON "activity_log";
--> statement-breakpoint

DROP TRIGGER IF EXISTS "human_gated_digest_lock_inserted_activity_issues_trigger" ON "activity_log";
--> statement-breakpoint

CREATE TRIGGER "human_gated_digest_lock_inserted_activity_issues_trigger"
AFTER INSERT ON "activity_log"
REFERENCING NEW TABLE AS "human_gated_digest_inserted_activity"
FOR EACH STATEMENT
EXECUTE FUNCTION "human_gated_digest_lock_inserted_activity_issues"();
--> statement-breakpoint

DROP TRIGGER IF EXISTS "human_gated_digest_lock_updated_activity_issues_trigger" ON "activity_log";
--> statement-breakpoint

CREATE TRIGGER "human_gated_digest_lock_updated_activity_issues_trigger"
AFTER UPDATE ON "activity_log"
REFERENCING OLD TABLE AS "human_gated_digest_old_activity"
  NEW TABLE AS "human_gated_digest_new_activity"
FOR EACH STATEMENT
EXECUTE FUNCTION "human_gated_digest_lock_updated_activity_issues"();
--> statement-breakpoint

DROP TRIGGER IF EXISTS "human_gated_digest_lock_deleted_activity_issues_trigger" ON "activity_log";
--> statement-breakpoint

CREATE TRIGGER "human_gated_digest_lock_deleted_activity_issues_trigger"
AFTER DELETE ON "activity_log"
REFERENCING OLD TABLE AS "human_gated_digest_deleted_activity"
FOR EACH STATEMENT
EXECUTE FUNCTION "human_gated_digest_lock_deleted_activity_issues"();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "human_gated_digest_lock_updated_comment_issues"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM locked_issue."id"
  FROM "issues" AS locked_issue
  INNER JOIN (
    SELECT
      old_comment."company_id",
      old_comment."issue_id"
    FROM "human_gated_digest_old_comments" AS old_comment
    WHERE old_comment."deleted_at" IS NULL
      AND (
        old_comment."author_type" = 'user'
        OR (
          old_comment."author_type" IS NULL
          AND old_comment."author_agent_id" IS NULL
          AND old_comment."author_user_id" IS NOT NULL
        )
      )

    UNION

    SELECT
      new_comment."company_id",
      new_comment."issue_id"
    FROM "human_gated_digest_new_comments" AS new_comment
    WHERE new_comment."deleted_at" IS NULL
      AND (
        new_comment."author_type" = 'user'
        OR (
          new_comment."author_type" IS NULL
          AND new_comment."author_agent_id" IS NULL
          AND new_comment."author_user_id" IS NOT NULL
        )
      )
  ) AS touched_issue
    ON touched_issue."company_id" = locked_issue."company_id"
    AND touched_issue."issue_id" = locked_issue."id"
  ORDER BY locked_issue."id"
  FOR SHARE OF locked_issue;

  RETURN NULL;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "human_gated_digest_lock_deleted_comment_issues"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM locked_issue."id"
  FROM "issues" AS locked_issue
  INNER JOIN (
    SELECT DISTINCT
      old_comment."company_id",
      old_comment."issue_id"
    FROM "human_gated_digest_deleted_comments" AS old_comment
    WHERE old_comment."deleted_at" IS NULL
      AND (
        old_comment."author_type" = 'user'
        OR (
          old_comment."author_type" IS NULL
          AND old_comment."author_agent_id" IS NULL
          AND old_comment."author_user_id" IS NOT NULL
        )
      )
  ) AS touched_issue
    ON touched_issue."company_id" = locked_issue."company_id"
    AND touched_issue."issue_id" = locked_issue."id"
  ORDER BY locked_issue."id"
  FOR SHARE OF locked_issue;

  RETURN NULL;
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS "human_gated_digest_lock_comment_issue_trigger" ON "issue_comments";
--> statement-breakpoint

DROP TRIGGER IF EXISTS "human_gated_digest_lock_updated_comment_issues_trigger" ON "issue_comments";
--> statement-breakpoint

CREATE TRIGGER "human_gated_digest_lock_updated_comment_issues_trigger"
AFTER UPDATE ON "issue_comments"
REFERENCING OLD TABLE AS "human_gated_digest_old_comments"
  NEW TABLE AS "human_gated_digest_new_comments"
FOR EACH STATEMENT
EXECUTE FUNCTION "human_gated_digest_lock_updated_comment_issues"();
--> statement-breakpoint

DROP TRIGGER IF EXISTS "human_gated_digest_lock_deleted_comment_issues_trigger" ON "issue_comments";
--> statement-breakpoint

CREATE TRIGGER "human_gated_digest_lock_deleted_comment_issues_trigger"
AFTER DELETE ON "issue_comments"
REFERENCING OLD TABLE AS "human_gated_digest_deleted_comments"
FOR EACH STATEMENT
EXECUTE FUNCTION "human_gated_digest_lock_deleted_comment_issues"();
