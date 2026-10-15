-- PEN-3633 / Ally review on Blockcast/paperclip#2750: back the workspace-reuse
-- refusal sweep.
--
-- refreshWorkspaceReuseRefusalMetrics runs, on every scrape-metrics collector
-- tick (15s) on every control-plane replica,
--
--   SELECT ... FROM heartbeat_runs JOIN issues ...
--   WHERE status = 'failed' AND finished_at >= now() - interval '2 hours'
--   ORDER BY finished_at DESC LIMIT 5000
--
-- No existing index can serve that predicate. Every `status`-bearing index on
-- heartbeat_runs leads with `company_id` and this sweep is fleet-wide, so there
-- is no leading-key value to probe with, and PostgreSQL before 18 has no index
-- skip scan. The only other `finished_at` index is
-- heartbeat_runs_crash_recovery_pending_idx, whose `error_code =
-- 'worker_crashed'` predicate these rows do not satisfy.
--
-- Measured 2026-10-15 from the production exporter
-- (pg_heartbeat_runs_access_seq_tup_read / pg_heartbeat_runs_access_seq_scan):
-- heartbeat_runs averages 368,694 rows per sequential scan, and production runs
-- ~2 sequential scans per DAY on it (increase(..._seq_scan[24h]) = 2.0).
-- Unindexed, this sweep alone would add ~8 per minute across the 2 api replicas,
-- over a heap carrying a wide `context_snapshot` jsonb and `error` text. The
-- collector runs its refreshes in series within a non-overlapping 15s tick, so
-- the cost would not stay local to this gauge: a slow scan here delays every
-- refresh after it and holds one of ten pool connections while it runs, which
-- is the contention BLO-33243 moved off the scrape path in the first place.
--
-- Partial on the single status, with `id` after `finished_at` so the LIMIT cut
-- is deterministic among same-instant rows. The indexed set is the failed runs
-- only, and the sweep reads a 2h range of it.
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
