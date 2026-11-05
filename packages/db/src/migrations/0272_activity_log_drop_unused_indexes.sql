-- BLO-52494: drop two activity_log indexes that no query uses.
--
-- activity_log holds ~3.4M rows behind 10 indexes (2.9 GB), and every insert
-- maintains all of them. Measured on production 2026-11-04/05 (PG 18.4):
--
-- * activity_log_company_responsible_user_created_idx (company_id,
--   responsible_user_id, created_at), 544 MB, from 0199. Zero index scans and a
--   NULL last_idx_scan since the 2026-11-01 restart; no statement in
--   pg_stat_statements (4.45 days, nothing evicted) filters, sorts, joins or
--   groups on activity_log.responsible_user_id. The column is only written
--   (services/activity-log.ts) and projected, and the company feed route
--   refuses a responsibleUserId parameter (routes/activity.ts allowlist).
--   The responsible-user audit feed 0199 was built for exists upstream
--   (paperclipai/paperclip #9744: server/src/services/agent-action-audit.ts,
--   GET /companies/:companyId/audit/agent-actions) but was never synced into
--   this fork. A sync that brings that feed must re-create this index in a NEW
--   migration registered in PENDING_CONCURRENT_INDEXES: 0199 has already run
--   everywhere, and a git merge of schema/activity_log.ts keeps this deletion
--   without a conflict.
-- * idx_activity_log_issue_entity_created (entity_id, created_at DESC) WHERE
--   entity_type = 'issue', 240 MB. Created out-of-band and in no migration, and
--   INVALID in production (indisvalid = false: a failed CONCURRENTLY build). The
--   planner can never use it, yet indisready kept it maintained on every
--   insert. 0098's idx_activity_log_entity_id_created has the same key.
--
-- A plain DROP INDEX takes ACCESS EXCLUSIVE on activity_log -- the table whose
-- lock stall withdrew 0270 (BLO-51377) -- and the runner wraps every file in a
-- transaction, so CONCURRENTLY is unavailable here. Production therefore dropped
-- both online first (2026-11-05 01:03Z), each as its own autocommit statement:
--   DROP INDEX CONCURRENTLY IF EXISTS activity_log_company_responsible_user_created_idx;
--   DROP INDEX CONCURRENTLY IF EXISTS idx_activity_log_issue_entity_created;
-- which makes this file a no-op there. Any other production-scale table where
-- either index is still present fails closed with those commands, rather than
-- take the lock. A small table -- local, worktree, restored or CI databases --
-- drops inline, bounded by the runner's lock_timeout and retry like 0269. The
-- 100,000-row line sits far below production and far above any of those.
DO $$
BEGIN
  IF to_regclass('public.activity_log_company_responsible_user_created_idx') IS NOT NULL
     OR to_regclass('public.idx_activity_log_issue_entity_created') IS NOT NULL THEN
    IF (SELECT reltuples FROM pg_class WHERE oid = 'public.activity_log'::regclass) >= 100000 THEN
      -- The dry-run pre-flight prints MESSAGE but not HINT, so MESSAGE carries the remedy.
      RAISE EXCEPTION USING
        MESSAGE = 'migration 0272: drop activity_log_company_responsible_user_created_idx and idx_activity_log_issue_entity_created online first (DROP INDEX CONCURRENTLY IF EXISTS <name>, one autocommit statement each)',
        HINT = 'Run DROP INDEX CONCURRENTLY IF EXISTS activity_log_company_responsible_user_created_idx; and DROP INDEX CONCURRENTLY IF EXISTS idx_activity_log_issue_entity_created; as two separate statements outside a transaction, then retry migrations.';
    END IF;
    DROP INDEX IF EXISTS "activity_log_company_responsible_user_created_idx";
    DROP INDEX IF EXISTS "idx_activity_log_issue_entity_created";
  END IF;
END $$;
