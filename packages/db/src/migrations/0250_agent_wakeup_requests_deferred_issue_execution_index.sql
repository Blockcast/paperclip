-- PEN-3734: a wake deferred behind an issue's execution lock is promoted only
-- when a run on that issue finalizes, one per finalization, and the lock is
-- held globally across agents. So one agent's queue wait bounds every other
-- agent's comment-delivery latency on that row — measured at 10h53m on
-- PEN-3164, of which 10h35m was a single foreign run sitting `queued`.
--
-- Nothing could see it. A deferred wake writes no `heartbeat_runs` row, so
-- every seat-side check reads "nothing arrived", and the issue's
-- `lastActivityAt` is ADVANCED by each undelivered comment, so staleness
-- sweeps read the row as freshly healthy. This index backs the gauge that
-- closes that gap:
--
--   MIN(requested_at) ... WHERE status = 'deferred_issue_execution'
--   GROUP BY agent_id
--
-- run by the scrape-metrics collector on a 15s cadence.
--
-- Neither existing index can bound that query.
-- `agent_wakeup_requests_company_agent_status_idx` is
-- (company_id, agent_id, status) and leads with `company_id`, so a
-- status-only predicate cannot probe it; `agent_wakeup_requests_agent_requested_idx`
-- is (agent_id, requested_at) and carries no `status`. Without this index the
-- aggregate is a full scan of the largest table in the schema (~13M rows per
-- packages/db/src/table-size-estimates.ts) that nothing prunes — repo-wide
-- there is no DELETE against it — on a 15s timer, for the life of the
-- deployment.
--
-- Partial on the single status, with `requested_at` ASC after `agent_id` so
-- each agent's MIN is the first entry under that agent's key. The indexed set
-- is bounded by the number of issues under concurrent contention right now,
-- and a row LEAVES the index the moment it is promoted, cancelled or failed,
-- so the object stays tiny regardless of table growth. Write cost falls only
-- on the deferral and promotion transitions, which are already rare.
--
-- Drizzle migrations are transactional, so CONCURRENTLY is unavailable here
-- and a plain CREATE INDEX would hold a SHARE lock on a large hot table for
-- the whole build. Same guard as 0208/0217/0237/0247: populated databases must
-- precreate the index online and are failed closed with the exact command;
-- empty databases (tests, bootstrap) build it inline, where there is nothing
-- to block.
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: the populated-table path fails closed and supplies the concurrent command.
DO $$
BEGIN
  IF to_regclass('public.agent_wakeup_requests_deferred_issue_execution_idx') IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
      FROM pg_index AS index_metadata
      JOIN pg_class AS index_relation
        ON index_relation.oid = index_metadata.indexrelid
      JOIN pg_am AS access_method
        ON access_method.oid = index_relation.relam
      WHERE index_metadata.indexrelid = to_regclass('public.agent_wakeup_requests_deferred_issue_execution_idx')
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
        AND index_metadata.indoption = '0 0'::int2vector
        AND trim(regexp_replace(
              coalesce(pg_get_expr(index_metadata.indpred, index_metadata.indrelid, TRUE), ''),
              '\s+', ' ', 'g'))
            = 'status = ''deferred_issue_execution''::text'
    )
    THEN
      RAISE EXCEPTION USING
        MESSAGE = 'migration 0250 found an invalid or incorrectly defined deferred-issue-execution index',
        HINT = 'Run DROP INDEX CONCURRENTLY IF EXISTS agent_wakeup_requests_deferred_issue_execution_idx; then CREATE INDEX CONCURRENTLY agent_wakeup_requests_deferred_issue_execution_idx ON agent_wakeup_requests USING btree (agent_id, requested_at) WHERE status = ''deferred_issue_execution''; then retry migrations.';
    END IF;
  ELSE
    IF EXISTS (SELECT 1 FROM "agent_wakeup_requests" LIMIT 1) THEN
      RAISE EXCEPTION USING
        MESSAGE = 'migration 0250 requires online index precreation',
        HINT = 'Run CREATE INDEX CONCURRENTLY IF NOT EXISTS agent_wakeup_requests_deferred_issue_execution_idx ON agent_wakeup_requests USING btree (agent_id, requested_at) WHERE status = ''deferred_issue_execution''; then retry migrations.';
    END IF;

    -- Close the gap between the empty-table check and CREATE INDEX without
    -- taking this lock on a populated production table.
    LOCK TABLE "agent_wakeup_requests" IN SHARE MODE;
    IF EXISTS (SELECT 1 FROM "agent_wakeup_requests" LIMIT 1) THEN
      RAISE EXCEPTION USING
        MESSAGE = 'migration 0250 requires online index precreation',
        HINT = 'Run CREATE INDEX CONCURRENTLY IF NOT EXISTS agent_wakeup_requests_deferred_issue_execution_idx ON agent_wakeup_requests USING btree (agent_id, requested_at) WHERE status = ''deferred_issue_execution''; then retry migrations.';
    END IF;

    CREATE INDEX "agent_wakeup_requests_deferred_issue_execution_idx"
      ON "agent_wakeup_requests" USING btree (
        "agent_id",
        "requested_at"
      )
      WHERE "status" = 'deferred_issue_execution';
  END IF;
END
$$;
