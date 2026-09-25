-- BLO-22094 (Ally review on Blockcast/paperclip#1184): the overdue-scheduled_retry
-- age gauge recomputes live on every unauthenticated /metrics scrape --
--
--   SELECT agent_id, min(scheduled_retry_at) FROM heartbeat_runs
--    WHERE status = 'scheduled_retry' AND scheduled_retry_at < now()
--    GROUP BY agent_id
--
-- Every pre-existing index on this table either leads with company_id or
-- pairs status with created_at/finished_at, and none pairs status with
-- scheduled_retry_at, so this scrape-frequency query had no usable index and
-- fell back to a sequential scan over the whole table -- unbounded work on
-- every scrape as heartbeat_runs history grows, not merely proportional to
-- the tiny handful of rows actually parked in scheduled_retry at any moment
-- (migration 0208 measured ~219k rows / ~1.8 GB with ~850 dispatchable rows
-- at a time; the same skew applies here).
--
-- A partial index restricted to status='scheduled_retry' keeps it small, and
-- leading with agent_id then scheduled_retry_at lets PostgreSQL answer the
-- GROUP BY with a GroupAggregate straight off the index -- rows already
-- arrive ordered by agent_id then ascending due time, so MIN(scheduled_retry_at)
-- per group is the first row PostgreSQL sees for that group, and the
-- `scheduled_retry_at < now()` filter costs nothing extra beyond that same
-- index condition. The on-call runbook query (runbooks/queued-run-stranded.md
-- #overdue-scheduled-retry-blo-22094) filters the same two columns for one
-- agent and orders by scheduled_retry_at, so this index also serves it.
--
-- Drizzle migrations are transactional, so CONCURRENTLY is unavailable here and
-- a plain CREATE INDEX would hold a SHARE lock on a large hot table for the
-- whole build, blocking every insert/update/delete against it. The guard
-- below therefore makes online precreation a *required and verified*
-- prerequisite rather than an optional suggestion, exactly as migrations 0205,
-- 0208, and 0209 do for this same table: a populated database fails the
-- migration with the exact command to run, and a precreated index that does
-- not match this definition is rejected rather than silently accepted. Empty
-- databases (tests, bootstrap) build it inline, where there is nothing to
-- block.
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
      MESSAGE = 'migration 0224 found an invalid or incorrectly defined prerequisite index',
      HINT = 'Run DROP INDEX CONCURRENTLY IF EXISTS heartbeat_runs_overdue_scheduled_retry_idx; then CREATE INDEX CONCURRENTLY heartbeat_runs_overdue_scheduled_retry_idx ON heartbeat_runs USING btree (agent_id, scheduled_retry_at) WHERE status = ''scheduled_retry''; then retry migrations.';
  ELSIF to_regclass('public.heartbeat_runs_overdue_scheduled_retry_idx') IS NULL THEN
    IF EXISTS (SELECT 1 FROM "heartbeat_runs" LIMIT 1) THEN
      RAISE EXCEPTION USING
        MESSAGE = 'migration 0224 requires online index precreation',
        HINT = 'Run CREATE INDEX CONCURRENTLY IF NOT EXISTS heartbeat_runs_overdue_scheduled_retry_idx ON heartbeat_runs USING btree (agent_id, scheduled_retry_at) WHERE status = ''scheduled_retry'', then retry migrations.';
    END IF;

    -- Close the gap between the empty-table check and CREATE INDEX without
    -- taking this lock on populated production tables.
    LOCK TABLE "heartbeat_runs" IN SHARE MODE;
    IF EXISTS (SELECT 1 FROM "heartbeat_runs" LIMIT 1) THEN
      RAISE EXCEPTION USING
        MESSAGE = 'migration 0224 requires online index precreation',
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
