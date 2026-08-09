-- BLO-22094: the overdue scheduled-retry age gauge recomputes on every
-- unauthenticated /metrics scrape:
--
--   SELECT agent_id, min(scheduled_retry_at) FROM heartbeat_runs
--    WHERE status = 'scheduled_retry' AND scheduled_retry_at < now()
--    GROUP BY agent_id
--
-- Existing indexes do not pair the scheduled-retry status with its due time,
-- so this scrape-frequency query would otherwise scan historical run rows.
-- The partial index stays small and orders rows by agent then due time, which
-- also serves the runbook's per-agent oldest-overdue query.
--
-- Drizzle migrations are transactional, so CONCURRENTLY is unavailable here.
-- On a populated hot table the index must be created online beforehand; this
-- guard verifies that prerequisite instead of taking a long write-blocking
-- SHARE lock during migration. Empty databases build it inline.
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: guarded below so non-empty databases must precreate the index concurrently.
DO $$
BEGIN
  IF to_regclass('public.heartbeat_runs_overdue_scheduled_retry_idx') IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM pg_index AS index_metadata
      JOIN pg_class AS index_relation
        ON index_relation.oid = index_metadata.indexrelid
      JOIN pg_am AS access_method
        ON access_method.oid = index_relation.relam
      WHERE index_metadata.indexrelid = to_regclass('public.heartbeat_runs_overdue_scheduled_retry_idx')
        AND index_metadata.indrelid = 'public.heartbeat_runs'::regclass
        AND index_metadata.indisvalid
        AND access_method.amname = 'btree'
        AND index_metadata.indnkeyatts = 2
        AND index_metadata.indnatts = 2
        AND ARRAY(
          SELECT pg_get_indexdef(index_metadata.indexrelid, key_position, TRUE)
          FROM generate_series(1, index_metadata.indnkeyatts) AS key_position
          ORDER BY key_position
        ) = ARRAY['agent_id', 'scheduled_retry_at']
        AND index_metadata.indoption = '0 0'::int2vector
        AND pg_get_expr(index_metadata.indpred, index_metadata.indrelid, TRUE) = 'status = ''scheduled_retry''::text'
    )
  THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 0212 found an invalid or incorrectly defined prerequisite index',
      HINT = 'Run DROP INDEX CONCURRENTLY IF EXISTS heartbeat_runs_overdue_scheduled_retry_idx; then CREATE INDEX CONCURRENTLY heartbeat_runs_overdue_scheduled_retry_idx ON heartbeat_runs USING btree (agent_id, scheduled_retry_at) WHERE status = ''scheduled_retry''; then retry migrations.';
  ELSIF to_regclass('public.heartbeat_runs_overdue_scheduled_retry_idx') IS NULL THEN
    IF EXISTS (SELECT 1 FROM "heartbeat_runs" LIMIT 1) THEN
      RAISE EXCEPTION USING
        MESSAGE = 'migration 0212 requires online index precreation',
        HINT = 'Run CREATE INDEX CONCURRENTLY IF NOT EXISTS heartbeat_runs_overdue_scheduled_retry_idx ON heartbeat_runs USING btree (agent_id, scheduled_retry_at) WHERE status = ''scheduled_retry'', then retry migrations.';
    END IF;

    LOCK TABLE "heartbeat_runs" IN SHARE MODE;
    IF EXISTS (SELECT 1 FROM "heartbeat_runs" LIMIT 1) THEN
      RAISE EXCEPTION USING
        MESSAGE = 'migration 0212 requires online index precreation',
        HINT = 'Run CREATE INDEX CONCURRENTLY IF NOT EXISTS heartbeat_runs_overdue_scheduled_retry_idx ON heartbeat_runs USING btree (agent_id, scheduled_retry_at) WHERE status = ''scheduled_retry'', then retry migrations.';
    END IF;

    CREATE INDEX "heartbeat_runs_overdue_scheduled_retry_idx"
      ON "heartbeat_runs" USING btree (
        "agent_id",
        "scheduled_retry_at"
      )
      WHERE "status" = 'scheduled_retry';
  END IF;
END
$$;
