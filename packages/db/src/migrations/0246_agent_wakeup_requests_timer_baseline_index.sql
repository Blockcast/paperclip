-- BLO-34578: the heartbeat timer takes its interval baseline from the most
-- recent `source = 'timer'` wakeup request per agent, read once per scheduler
-- pass (`heartbeatSchedulerIntervalMs` defaults to 30s) as
-- `MAX(requested_at) ... WHERE agent_id IN (...) AND source = 'timer'
--  GROUP BY agent_id`.
--
-- The pre-existing `agent_wakeup_requests_agent_requested_idx` is
-- (agent_id, requested_at) and carries no `source` column, so it cannot bound
-- that query: Postgres reads every row for each agent in the list and filters.
-- `agent_wakeup_requests` is the largest table in the schema (the row-count
-- estimate in packages/db/src/table-size-estimates.ts puts it at ~13M) and
-- nothing prunes it — repo-wide there is no DELETE against it — so the work per
-- pass grows for the life of the deployment.
--
-- This index is partial on `source = 'timer'` with `requested_at DESC` leading
-- after `agent_id`, so the MAX for each agent is the first entry under that
-- agent's key and the scan is O(1) per agent regardless of table size. Timer
-- rows are a small minority of the table (one per agent per interval, against
-- one per event wake), so the object stays small and the write cost falls only
-- on the timer's own inserts.
--
-- Drizzle migrations are transactional, so CONCURRENTLY is unavailable here and
-- a plain CREATE INDEX would hold a SHARE lock on a large hot table for the
-- whole build. Same guard as 0208/0217/0237: populated databases must precreate
-- the index online and are failed closed with the exact command; empty
-- databases (tests, bootstrap) build it inline, where there is nothing to block.
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: the populated-table path fails closed and supplies the concurrent command.
DO $$
BEGIN
  IF to_regclass('public.agent_wakeup_requests_timer_baseline_idx') IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
      FROM pg_index AS index_metadata
      JOIN pg_class AS index_relation
        ON index_relation.oid = index_metadata.indexrelid
      JOIN pg_am AS access_method
        ON access_method.oid = index_relation.relam
      WHERE index_metadata.indexrelid = to_regclass('public.agent_wakeup_requests_timer_baseline_idx')
        AND index_metadata.indrelid = 'public.agent_wakeup_requests'::regclass
        AND index_metadata.indisvalid
        AND index_metadata.indisready
        AND access_method.amname = 'btree'
        AND index_metadata.indnkeyatts = 2
        AND index_metadata.indnatts = 2
        AND ARRAY(
          SELECT pg_get_indexdef(index_metadata.indexrelid, key_position, TRUE)
          FROM generate_series(1, index_metadata.indnkeyatts) AS key_position
          ORDER BY key_position
        ) = ARRAY['agent_id', 'requested_at']
        AND index_metadata.indoption = '0 3'::int2vector
        AND trim(regexp_replace(
              coalesce(pg_get_expr(index_metadata.indpred, index_metadata.indrelid, TRUE), ''),
              '\s+', ' ', 'g'))
            = 'source = ''timer''::text'
    )
    THEN
      RAISE EXCEPTION USING
        MESSAGE = 'migration 0246 found an invalid or incorrectly defined timer baseline index',
        HINT = 'Run DROP INDEX CONCURRENTLY IF EXISTS agent_wakeup_requests_timer_baseline_idx; then CREATE INDEX CONCURRENTLY agent_wakeup_requests_timer_baseline_idx ON agent_wakeup_requests USING btree (agent_id, requested_at DESC) WHERE source = ''timer''; then retry migrations.';
    END IF;
  ELSE
    IF EXISTS (SELECT 1 FROM "agent_wakeup_requests" LIMIT 1) THEN
      RAISE EXCEPTION USING
        MESSAGE = 'migration 0246 requires online index precreation',
        HINT = 'Run CREATE INDEX CONCURRENTLY IF NOT EXISTS agent_wakeup_requests_timer_baseline_idx ON agent_wakeup_requests USING btree (agent_id, requested_at DESC) WHERE source = ''timer''; then retry migrations.';
    END IF;

    -- Close the gap between the empty-table check and CREATE INDEX without
    -- taking this lock on a populated production table.
    LOCK TABLE "agent_wakeup_requests" IN SHARE MODE;
    IF EXISTS (SELECT 1 FROM "agent_wakeup_requests" LIMIT 1) THEN
      RAISE EXCEPTION USING
        MESSAGE = 'migration 0246 requires online index precreation',
        HINT = 'Run CREATE INDEX CONCURRENTLY IF NOT EXISTS agent_wakeup_requests_timer_baseline_idx ON agent_wakeup_requests USING btree (agent_id, requested_at DESC) WHERE source = ''timer''; then retry migrations.';
    END IF;

    CREATE INDEX "agent_wakeup_requests_timer_baseline_idx"
      ON "agent_wakeup_requests" USING btree (
        "agent_id",
        "requested_at" DESC
      )
      WHERE "source" = 'timer';
  END IF;
END
$$;
