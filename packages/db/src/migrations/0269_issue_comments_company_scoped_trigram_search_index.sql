-- PEN-3596: company-scope the issue_comments.body trigram index.
--
-- This REVERSES a decision recorded in migration 0268, which declined this
-- index. That decision was correct on the evidence it had and wrong on
-- production's shape; the evidence that overturns it is below.
--
-- WHAT 0268 SAID, AND WHY IT SAID IT.
--
--   "WHY issue_comments.body GETS NO COMPOSITE. It was measured and rejected:
--    it is worth ~11ms [...] It would have cost an 18MB index and a 13.6s
--    build on the largest table in the schema. Not worth the write
--    amplification."
--
-- That 11ms was measured on a seed in which EVERY issue and EVERY comment
-- belonged to ONE company (see the `populate()` helper in
-- issues-list-search-cost-shape.test.ts as it stood then: a single COMPANY
-- constant). Company-scoping an index cannot be worth anything on a corpus
-- with one company in it -- the scoped and un-scoped bitmaps are the same set
-- of rows by construction. The seed could not exhibit the effect the index
-- exists to remove, so the measurement was sound and the inference from it
-- was not.
--
-- WHAT PRODUCTION ACTUALLY DOES. After 0268 deployed (2026-10-30, commit
-- 86bfe2a2), `GET /api/companies/{PEN}/issues?q=…&limit=15` measured:
--
--   q=zzqxwvnomatchzz (no match) ...  0.251s      q=deploy ......  9.877s
--   q=trigram .....................  1.332s      q=statement ... 21.770s / 16.480s
--   no q at all ...................  3.254s
--
-- The search path is genuinely fixed -- a no-match term costs 0.251s where
-- pre-fix it cost ~25s regardless of term. But a COMMON term still costs
-- 16-22s against the 30s role statement_timeout, and the no-`q` row bounds
-- every PEN-scoped operation at 3.254s, so the residual is work on rows that
-- are not PEN's. The three `issues` arms are company-scoped by 0268; the
-- comment arm was not.
--
-- RE-MEASURED ON A SEED THAT CAN SHOW IT. Same harness, but comments spread
-- over 20 companies and bodies at production size (54,300 issues / 236,800
-- comments / ~2KB bodies / term matching 23,680 rows globally and 3,920 in
-- the searched company -- 6.0x cross-company amplification):
--
--   comment arm of the WHERE union, alone .... 571-629ms  ->   82-109ms   (~6x)
--   full list query, production shape ....... 1006-1045ms ->  243-295ms   (~3.8x)
--
-- The ~6x speedup tracks the 6.0x amplification, which is the mechanism
-- stated as a prediction and then observed: `issue_comments_body_search_idx`
-- is not company-scoped, so a BitmapAnd against `issue_comments_company_idx`
-- builds the trigram bitmap for the term across EVERY company before
-- intersecting it. Prefixing company_id (btree_gin lets a scalar lead a GIN
-- index) makes the index cond answer both halves.
--
-- WHY THIS REPLACES THE SINGLE-COLUMN INDEX RATHER THAN JOINING IT -- which
-- is what dissolves 0268's objection. 0268 priced a SECOND GIN index on
-- `body`, the hottest write column in the schema. It is not needed: all five
-- queries in the repo that ILIKE/regex a comment body are ALREADY company-
-- scoped, so the composite serves every one of them and the single-column
-- index has no remaining caller. Measured on the seed above, each shape under
-- the single-column index and then under the composite alone:
--
--   company-search single-pattern CTE ......... 583-641ms ->   94-123ms
--   company-search multi-pattern unnest join . 2340-2777ms -> 1643-1786ms
--   company-search snippet LATERAL ............   10ms     ->   11-15ms  (uses
--                            issue_comments_company_issue_created_at_idx either way)
--   company-search-extract EXISTS, ILIKE ...... 574-658ms ->  104-129ms
--   company-search-extract EXISTS, regex ~* ... 719-733ms ->   98-118ms
--
-- Every consumer is the same or faster and none regresses. Two are worth
-- calling out: the multi-pattern unnest join could not use the single-column
-- index at all (non-constant pattern) and fell back to
-- `issue_comments_company_idx`; it now uses the composite for its company_id
-- half. And the `~*` regex form is indexable for the first time -- pg_trgm
-- serves regex from a GIN index, but only once company_id stops forcing the
-- BitmapAnd. So the GIN-index count on `body` is unchanged at one, the write
-- amplification 0268 declined to pay is still not paid, and the index is
-- 19MB where 0268 predicted 18MB. It built in 55s on that 236,800-comment
-- seed, which is the figure the deploy note below scales from.
--
-- This is NOT coupled to an application version: the composite serves every
-- query the single-column index served, strictly better, so a code rollback
-- does not want the old index back.
--
-- ⚠️ DEPLOY NOTE -- READ BEFORE APPROVING. This index is REGISTERED in
-- PENDING_CONCURRENT_INDEXES, so in practice it is built CONCURRENTLY and the
-- statements below are a no-op. That is deliberate and not optional here:
-- `issue_comments` is the largest table in the schema, it takes a write on
-- every agent comment, and table-size-estimates puts it at ~1.26M rows -- 5.3x
-- the 236,800-comment seed the 55s build above was measured on. A plain,
-- transactional build would hold a SHARE lock and stall comment writes for
-- minutes. `check-migration-safety` flags exactly that
-- (`large-create-index-not-concurrently`), and the flag is right.
--
-- It is registered despite needing an extension, which is what 0268 could not
-- do and why it built in-transaction. The guard now takes `requiredExtensions`
-- and treats a missing one exactly like a missing table or column, so both
-- call sites do the right thing:
--
--   * the pre-deploy CLI (`skipUnavailable: true`) builds it CONCURRENTLY
--     before `helm upgrade` on any database where 0268 has already run --
--     which is every deployed one -- and SKIPS, with a log line, on a fresh
--     database where btree_gin does not exist yet;
--   * the migration runner calls the guard again immediately before this
--     file, outside the transaction, after 0268 has committed btree_gin. So
--     the fresh-database case is covered there, still CONCURRENTLY.
--
-- Either way the statement below finds the index present and only validates it.
-- It follows 0261's shape rather than a bare `IF NOT EXISTS`, which would be a
-- blocking build whenever the guard was bypassed: a populated table with no
-- index RAISEs, carrying the exact CONCURRENTLY command, instead of building
-- one. Only an empty table -- a fresh database, or CI -- builds inline, and it
-- takes a SHARE lock first to close the gap between the emptiness check and
-- the build. A precreated index whose definition does not match is rejected
-- rather than tolerated.
--
-- The DROP is NOT concurrent. It is a catalog update plus a file unlink rather
-- than a scan, so it is fast; it does take a brief ACCESS EXCLUSIVE lock, which
-- the migration session's 15s lock_timeout bounds, and `withMigrationLockRetry`
-- retries. The manual opt-out, if an operator wants both steps off the
-- migration path entirely:
--
--   CREATE EXTENSION IF NOT EXISTS btree_gin;
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS issue_comments_company_body_search_idx
--     ON issue_comments USING gin (company_id, body gin_trgm_ops);
--   DROP INDEX CONCURRENTLY IF EXISTS issue_comments_body_search_idx;
--
CREATE EXTENSION IF NOT EXISTS btree_gin;--> statement-breakpoint
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: the populated-table path fails closed and supplies the concurrent command.
DO $$
BEGIN
  IF to_regclass('public.issue_comments_company_body_search_idx') IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
      FROM pg_index AS index_metadata
      JOIN pg_class AS index_relation
        ON index_relation.oid = index_metadata.indexrelid
      JOIN pg_am AS access_method
        ON access_method.oid = index_relation.relam
      WHERE index_metadata.indexrelid = to_regclass('public.issue_comments_company_body_search_idx')
        AND index_metadata.indrelid = 'public.issue_comments'::regclass
        AND index_metadata.indisvalid
        AND index_metadata.indisready
        AND access_method.amname = 'gin'
        AND index_metadata.indnkeyatts = 2
        AND index_metadata.indnatts = 2
        AND ARRAY(
          SELECT pg_get_indexdef(index_metadata.indexrelid, key_position, TRUE)
          FROM generate_series(1, index_metadata.indnkeyatts) AS key_position
          ORDER BY key_position
        ) = ARRAY['company_id', 'body']
        AND index_metadata.indoption = '0 0'::int2vector
        AND index_metadata.indpred IS NULL
    )
    THEN
      RAISE EXCEPTION USING
        MESSAGE = 'migration 0269 found an invalid or incorrectly defined issue_comments_company_body_search_idx',
        HINT = 'Run DROP INDEX CONCURRENTLY IF EXISTS issue_comments_company_body_search_idx; then CREATE INDEX CONCURRENTLY issue_comments_company_body_search_idx ON issue_comments USING gin (company_id, body gin_trgm_ops); then retry migrations.';
    END IF;
  ELSE
    IF EXISTS (SELECT 1 FROM "issue_comments" LIMIT 1) THEN
      RAISE EXCEPTION USING
        MESSAGE = 'migration 0269 requires online index precreation',
        HINT = 'Run CREATE EXTENSION IF NOT EXISTS btree_gin; CREATE INDEX CONCURRENTLY IF NOT EXISTS issue_comments_company_body_search_idx ON issue_comments USING gin (company_id, body gin_trgm_ops); then retry migrations.';
    END IF;
    -- Close the gap between the empty-table check and CREATE INDEX without
    -- taking this lock on a populated production table.
    LOCK TABLE "issue_comments" IN SHARE MODE;
    IF EXISTS (SELECT 1 FROM "issue_comments" LIMIT 1) THEN
      RAISE EXCEPTION USING
        MESSAGE = 'migration 0269 requires online index precreation',
        HINT = 'Run CREATE EXTENSION IF NOT EXISTS btree_gin; CREATE INDEX CONCURRENTLY IF NOT EXISTS issue_comments_company_body_search_idx ON issue_comments USING gin (company_id, body gin_trgm_ops); then retry migrations.';
    END IF;
    CREATE INDEX "issue_comments_company_body_search_idx"
      ON "issue_comments" USING gin ("company_id", "body" gin_trgm_ops);
  END IF;
END
$$;--> statement-breakpoint
-- Cheap: a catalog update and a file unlink, not a scan. Last, so a failure
-- above never leaves the table with neither index.
DROP INDEX IF EXISTS "issue_comments_body_search_idx";
