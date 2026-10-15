-- PEN-3633 / Ally review on Blockcast/paperclip#2750: back the workspace-reuse
-- refusal sweep.
--
-- refreshWorkspaceReuseRefusalMetrics runs, on every scrape-metrics collector
-- tick (15s) on every control-plane replica,
--
--   SELECT context_issue_id, error FROM heartbeat_runs
--   WHERE status = 'failed' AND finished_at >= now() - interval '2 hours'
--     AND error IS NOT NULL AND <refusal markers>
--   ORDER BY finished_at DESC, id DESC LIMIT 5000
--
-- Not because nothing else can serve that predicate. It was first justified
-- that way and the measurement refuted it: every `status`-bearing index on
-- heartbeat_runs leads with `company_id` and this sweep is fleet-wide, but
-- PostgreSQL will still `BitmapAnd` the TRAILING `finished_at` and `status`
-- columns of two of them, which is a bitmap index scan, not a sequential scan.
-- (heartbeat_runs_crash_recovery_pending_idx genuinely cannot serve it -- its
-- `error_code = 'worker_crashed'` predicate excludes these rows.) Production
-- corroborates the planner's preference: increase(pg_heartbeat_runs_access_
-- seq_scan[24h]) = 2.0, i.e. this table is sequentially scanned about twice a
-- DAY, not on a 15s timer.
--
-- This index earns its place on how the two SCALE, measured with
-- EXPLAIN (ANALYZE, BUFFERS) at 60k rows:
--
--   without:  BitmapAnd, one index entry per failed run that has EVER existed
--             (8,572 rows at 60k), 37 buffers on the run side
--   with:     Index Scan Backward, the failed runs inside the 2h window
--             (24 rows), 16 buffers hit + 2 read
--
-- The without-path's cost grows with the table; this one's grows with the
-- window. For scale, the same production exporter reports heartbeat_runs
-- averaging 368,694 rows per sequential scan. The collector runs its refreshes
-- in series within a non-overlapping 15s tick, so the difference does not stay
-- local to this gauge: a slow query delays every refresh after it and holds one
-- of ten pool connections while it runs, which is the contention BLO-33243
-- moved off the scrape path in the first place.
--
-- Partial on the single status, with `id` after `finished_at` so the window,
-- the ORDER BY and the LIMIT cut all come off one backward index scan and the
-- cut is deterministic among same-instant rows.
--
-- Drizzle migrations are transactional, so CONCURRENTLY is unavailable here and
-- a plain CREATE INDEX would hold a SHARE lock on a large hot table for the
-- whole build. Handled the same way as 0208/0217/0226/0230 do for this table:
-- the index is registered in PENDING_CONCURRENT_INDEXES, so the migration
-- runner builds it CONCURRENTLY outside a transaction immediately before
-- applying this file, and `pending-migration-preflight` reports an absent one
-- before `helm upgrade` rather than as a crashloop. The guard below is the
-- backstop for both: a populated database with no index fails the migration
-- carrying the exact command, and a precreated index that does not match this
-- definition is rejected rather than silently accepted. Empty databases
-- (tests, bootstrap) build it inline, where there is nothing to block.
--
-- The gauge is correct without the index -- it degrades to the sequential scan
-- described above -- but "correct, and slow on a shared tick" is the state this
-- file exists to avoid, so the refusal is loud rather than a NOTICE.
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: the populated-table path fails closed and supplies the concurrent command.
DO $$
BEGIN
  IF to_regclass('public.heartbeat_runs_failed_finished_at_idx') IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
      FROM pg_index AS index_metadata
      JOIN pg_class AS index_relation
        ON index_relation.oid = index_metadata.indexrelid
      JOIN pg_am AS access_method
        ON access_method.oid = index_relation.relam
      WHERE index_metadata.indexrelid = to_regclass('public.heartbeat_runs_failed_finished_at_idx')
        AND index_metadata.indrelid = 'public.heartbeat_runs'::regclass
        AND index_metadata.indisvalid
        AND index_metadata.indisready
        AND access_method.amname = 'btree'
        AND index_metadata.indnkeyatts = 2
        AND index_metadata.indnatts = 2
        AND ARRAY(
          SELECT pg_get_indexdef(index_metadata.indexrelid, key_position, TRUE)
          FROM generate_series(1, index_metadata.indnkeyatts) AS key_position
          ORDER BY key_position
        ) = ARRAY['finished_at', 'id']
        AND index_metadata.indoption = '0 0'::int2vector
        AND trim(regexp_replace(
              coalesce(pg_get_expr(index_metadata.indpred, index_metadata.indrelid, TRUE), ''),
              '\s+', ' ', 'g'))
            = 'status = ''failed''::text'
    )
    THEN
      RAISE EXCEPTION USING
        MESSAGE = 'migration 0259 found an invalid or incorrectly defined heartbeat_runs_failed_finished_at_idx',
        HINT = 'Run DROP INDEX CONCURRENTLY IF EXISTS heartbeat_runs_failed_finished_at_idx; then CREATE INDEX CONCURRENTLY heartbeat_runs_failed_finished_at_idx ON heartbeat_runs USING btree (finished_at, id) WHERE status = ''failed''; then retry migrations.';
    END IF;
  ELSE
    IF EXISTS (SELECT 1 FROM "heartbeat_runs" LIMIT 1) THEN
      RAISE EXCEPTION USING
        MESSAGE = 'migration 0259 requires online index precreation',
        HINT = 'Run CREATE INDEX CONCURRENTLY IF NOT EXISTS heartbeat_runs_failed_finished_at_idx ON heartbeat_runs USING btree (finished_at, id) WHERE status = ''failed''; then retry migrations.';
    END IF;

    -- Close the gap between the empty-table check and CREATE INDEX without
    -- taking this lock on a populated production table.
    LOCK TABLE "heartbeat_runs" IN SHARE MODE;
    IF EXISTS (SELECT 1 FROM "heartbeat_runs" LIMIT 1) THEN
      RAISE EXCEPTION USING
        MESSAGE = 'migration 0259 requires online index precreation',
        HINT = 'Run CREATE INDEX CONCURRENTLY IF NOT EXISTS heartbeat_runs_failed_finished_at_idx ON heartbeat_runs USING btree (finished_at, id) WHERE status = ''failed''; then retry migrations.';
    END IF;

    CREATE INDEX "heartbeat_runs_failed_finished_at_idx"
      ON "heartbeat_runs" USING btree (
        "finished_at",
        "id"
      )
      WHERE "status" = 'failed';
  END IF;
END
$$;
