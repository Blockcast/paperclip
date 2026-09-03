-- BLO-31392: give the dispatcher's head scan an ordered, index-only path that
-- the GENERIC plan can use.
--
-- The head page (`readQueuedDispatchPage`, server/src/services/heartbeat.ts)
-- runs through a prepared statement. postgres.js prepares by default; only
-- agent_id is bound, and `status = 'queued'` is deliberately a SQL literal.
-- Under plan_cache_mode = auto (production's setting) PostgreSQL costs a custom
-- plan five times, then adopts the generic plan if it is cheaper — and it was:
--
--   Limit  (cost=2.50..2.50 rows=1)
--     ->  Sort   Sort Key: created_at, id
--           ->  Index Scan using heartbeat_runs_queued_age_idx
--                 Index Cond: (agent_id = $1)
--
-- against a custom plan of 5.84 on heartbeat_runs_agent_dispatch_idx with no
-- Sort. Measured on production 2026-09-03 (BLO-31354 AC 3): PREPARE, five
-- EXECUTEs, then EXPLAIN ANALYZE EXECUTE on the 6th and 7th, both stable on the
-- generic plan; force_custom_plan on the same statement in the same session
-- returned the ordered Index Only Scan. So a long-lived pooled connection locks
-- onto the sorting plan and stays there.
--
-- Why 0208's index does not win that comparison. In the generic pass agent_id
-- is unknown, so the row estimate collapses to the table-wide average — about
-- one queued row per agent — and at one row a Sort is almost free. What the
-- planner then compares is mostly index size, and 0217's queued-age index is
-- the smaller object: its predicate is exactly `status = 'queued'`, while
-- 0208's spans `status IN ('queued', 'scheduled_retry')`. 0208's index comment
-- reasons that keeping status a literal protects the dispatch plan; migration
-- 0217 inverted that, because the literal is now precisely what makes the
-- queued-age index applicable. The generic plan's Index Cond is only
-- `(agent_id = $1)` — the status qualifier is absorbed by the index predicate,
-- so nothing bounds the scan by status inside the index either.
--
-- Why the estimate is not the thing to fix. It is ~150x low because agent_id
-- and status are correlated and PostgreSQL multiplies their selectivities.
-- CREATE STATISTICS does correct it, and makes the plan WORSE: with a truthful
-- estimate the sorting path wins by a wider margin. That is recorded in
-- readQueuedDispatchPage ("Deliberately NOT fixed with extended statistics")
-- and was reproduced independently on BLO-31354. The estimate is not the bug.
--
-- Why this is latent rather than urgent, and why it is still worth an index. At
-- the measured production backlog (18 rows) the Sort costs ~0.5 ms. But a Sort
-- cannot emit its first row until it has consumed its whole input, so LIMIT 200
-- stops bounding the work: under a deep queue the dispatcher reads and sorts the
-- agent's ENTIRE backlog to return one page, while holding the strict per-agent
-- start lock. BLO-20736 measured 10,400 rows inspected at depth 5000, and queue
-- depth is exactly what spikes during the incidents this path exists to survive.
-- This index restores the guarantee BLO-20736 was closed on.
--
-- The fix is to stop competing on index size and give the planner an object that
-- is BOTH as narrow as 0217's and ordered. This index has the same predicate as
-- 0217's (`status = 'queued'`) and the same columns as 0209's
-- (agent_id, created_at, id), so:
--
--   * the partial predicate implies the query's status qualifier, so it drops
--     out of the Index Cond exactly as it does for 0217's index;
--   * (created_at, id) are index keys in the ORDER BY's order, so the page is
--     emitted in order with no Sort and the LIMIT truncates the scan;
--   * the projection is (created_at, id) and both are index columns, so the scan
--     stays Index Only.
--
-- It therefore beats the queued-age index for this query on the axes the planner
-- costs, rather than winning a tie-break on index size. HOW DECISIVELY depends
-- entirely on the visibility map, and that qualifier is load-bearing — an
-- earlier draft of this comment claimed unconditional dominance, and direct
-- measurement refuted it. Generic-plan cost of this index vs the queued-age
-- index, same fixture, high agent cardinality and a shallow queue so the
-- generic estimate collapses to 1 row as production's does:
--
--   relallvisible/relpages = 1.00 (freshly vacuumed):  4.30 vs 8.32  -> 48.3%
--   relallvisible/relpages = 0.00 (churning):          8.30 vs 8.32  ->  0.24%
--
-- 0.24% is INSIDE PostgreSQL's 1% STD_FUZZ_FACTOR, i.e. a coin flip, and the
-- churning row is the one that describes production: its plan reported
-- `Heap Fetches: 18` on an 18-row page, so the queued rows — freshly inserted
-- and repeatedly updated by definition — are never all-visible and the
-- index-only discount that produces the 48% margin is never applied to them.
--
-- The reason is structural and no index design escapes it: with agent_id
-- unbound the generic estimate is ~1 row, a Sort over 1 row costs ~0.02, so
-- once the index-only discount is gone the comparison is decided by a rounding
-- error. This index is therefore NECESSARY BUT PROBABLY NOT SUFFICIENT. It
-- strictly improves the object the planner has available — it is smaller than
-- 0208's for this predicate and it is the only one of the three that is both
-- as narrow as 0217's and ordered — but it cannot by itself guarantee the
-- planner picks it in production's regime.
--
-- Making that deterministic requires removing the dependence on the cost
-- comparison, not sharpening it: force a custom plan for this one statement
-- (the CTO measured `force_custom_plan` restoring the ordered scan on the same
-- prepared statement in the same production session), or remove the competitor.
-- Tracked on BLO-31392; do not read a green CI run as evidence that production
-- stopped sorting, and re-measure production's `EXPLAIN (GENERIC_PLAN)` before
-- closing that issue.
--
-- Deliberately NOT done here:
--
--   * Dropping or reshaping 0217's index. It exists for BLO-21116's queue-age
--     monitoring (min(coalesce(queued_at, created_at)) grouped by agent), which
--     this index cannot serve — it carries no queued_at. Folding both into one
--     index with INCLUDE (queued_at) is possible and is the tidier end state,
--     but it changes an object another issue owns and is not needed to fix this.
--   * Pinning plan_cache_mode or disabling prepared statements for this
--     statement. That treats the symptom, leaves the planner without a good
--     path, and would have to be re-reasoned for every future shape of this
--     query.
--
-- 0209's recovery index is left in place and is still the narrower object for
-- the recovery lane's predicate, so that lane keeps its absolute bound.
--
-- Drizzle migrations are transactional, so CONCURRENTLY is unavailable here and
-- a plain CREATE INDEX would hold a SHARE lock on a hot ~1.8 GB table for the
-- whole build. Same guard as 0208/0217: populated databases must precreate the
-- index online and are failed closed with the exact command; empty databases
-- (tests, bootstrap) build it inline, where there is nothing to block.
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: the populated-table path fails closed and supplies the concurrent command.
DO $$
BEGIN
  IF to_regclass('public.heartbeat_runs_agent_queued_dispatch_idx') IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
      FROM pg_index AS index_metadata
      JOIN pg_class AS index_relation
        ON index_relation.oid = index_metadata.indexrelid
      JOIN pg_am AS access_method
        ON access_method.oid = index_relation.relam
      WHERE index_metadata.indexrelid = to_regclass('public.heartbeat_runs_agent_queued_dispatch_idx')
        AND index_metadata.indrelid = 'public.heartbeat_runs'::regclass
        AND index_metadata.indisvalid
        AND access_method.amname = 'btree'
        AND index_metadata.indnkeyatts = 3
        AND index_metadata.indnatts = 3
        AND ARRAY(
          SELECT pg_get_indexdef(index_metadata.indexrelid, key_position, TRUE)
          FROM generate_series(1, index_metadata.indnkeyatts) AS key_position
          ORDER BY key_position
        ) = ARRAY['agent_id', 'created_at', 'id']
        AND index_metadata.indoption = '0 0 0'::int2vector
        AND trim(regexp_replace(
              coalesce(pg_get_expr(index_metadata.indpred, index_metadata.indrelid, TRUE), ''),
              '\s+', ' ', 'g'))
            = 'status = ''queued''::text'
    )
    THEN
      RAISE EXCEPTION USING
        MESSAGE = 'migration 0237 found an invalid or incorrectly defined queued dispatch index',
        HINT = 'Run DROP INDEX CONCURRENTLY IF EXISTS heartbeat_runs_agent_queued_dispatch_idx; then CREATE INDEX CONCURRENTLY heartbeat_runs_agent_queued_dispatch_idx ON heartbeat_runs USING btree (agent_id, created_at, id) WHERE status = ''queued''; then retry migrations.';
    END IF;
  ELSE
    IF EXISTS (SELECT 1 FROM "heartbeat_runs" LIMIT 1) THEN
      RAISE EXCEPTION USING
        MESSAGE = 'migration 0237 requires online index precreation',
        HINT = 'Run CREATE INDEX CONCURRENTLY IF NOT EXISTS heartbeat_runs_agent_queued_dispatch_idx ON heartbeat_runs USING btree (agent_id, created_at, id) WHERE status = ''queued''; then retry migrations.';
    END IF;

    -- Close the gap between the empty-table check and CREATE INDEX without
    -- taking this lock on a populated production table.
    LOCK TABLE "heartbeat_runs" IN SHARE MODE;
    IF EXISTS (SELECT 1 FROM "heartbeat_runs" LIMIT 1) THEN
      RAISE EXCEPTION USING
        MESSAGE = 'migration 0237 requires online index precreation',
        HINT = 'Run CREATE INDEX CONCURRENTLY IF NOT EXISTS heartbeat_runs_agent_queued_dispatch_idx ON heartbeat_runs USING btree (agent_id, created_at, id) WHERE status = ''queued''; then retry migrations.';
    END IF;

    CREATE INDEX "heartbeat_runs_agent_queued_dispatch_idx"
      ON "heartbeat_runs" USING btree (
        "agent_id",
        "created_at",
        "id"
      )
      WHERE "status" = 'queued';
  END IF;
END
$$;
