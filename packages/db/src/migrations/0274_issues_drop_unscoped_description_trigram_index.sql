-- Drop issues_description_search_idx (gin (description gin_trgm_ops), from 0051).
--
-- 0268 (PEN-3596) added the company-scoped twin issues_company_description_search_idx
-- (gin (company_id, description gin_trgm_ops)) and kept this one on the premise
-- that company-search's `ILIKE ANY(array)` forms need it. They do not:
-- company-search matches `coalesce(issues.description, '') ILIKE ...`, which no
-- trigram index on the bare column serves, and the issues-list search is always
-- company-scoped. A multicolumn GIN index also serves conditions on any subset
-- of its columns, so the twin covers every shape this one did.
--
-- What it cost, measured on production 2026-11-05 (PG 18.4): issues rows are
-- updated ~2/s, mostly non-HOT (updated_at and last_activity_at are indexed), so
-- every update re-appends every trigram of a ~6 KB description to BOTH GIN
-- indexes, and the backend that tips a 4 MB pending list over flushes it inline
-- (1-8 s, holding the row lock). pg_waldump over recent segments put this index
-- alone at 24-35% of ALL WAL, on a database writing ~44 GB of WAL a day whose
-- commits wait on ceph-rbd fsyncs.
--
-- A plain DROP INDEX takes ACCESS EXCLUSIVE on issues and the runner wraps every
-- file in a transaction, so CONCURRENTLY is unavailable here (0272's pattern,
-- BLO-51377). Production dropped it online first (2026-11-05 14:41Z):
--   DROP INDEX CONCURRENTLY IF EXISTS issues_description_search_idx;
-- which makes this file a no-op there. Any other production-scale issues table
-- still carrying it fails closed with that command; a small table drops inline
-- under the runner's lock_timeout and retry. The 10,000-row line sits below
-- production (~58k) and far above any local, worktree, restored or CI database.
DO $$
BEGIN
  IF to_regclass('public.issues_description_search_idx') IS NOT NULL THEN
    IF (SELECT reltuples FROM pg_class WHERE oid = 'public.issues'::regclass) >= 10000 THEN
      -- The dry-run pre-flight prints MESSAGE but not HINT, so MESSAGE carries the remedy.
      RAISE EXCEPTION USING
        MESSAGE = 'migration 0274: drop issues_description_search_idx online first (DROP INDEX CONCURRENTLY IF EXISTS issues_description_search_idx, as its own autocommit statement)',
        HINT = 'Run DROP INDEX CONCURRENTLY IF EXISTS issues_description_search_idx; outside a transaction, then retry migrations.';
    END IF;
    DROP INDEX IF EXISTS "issues_description_search_idx";
  END IF;
END $$;
