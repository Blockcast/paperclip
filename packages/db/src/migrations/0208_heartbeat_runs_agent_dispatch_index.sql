-- BLO-20396: per-agent queued-run dispatch index.
--
-- The dispatcher (server/src/services/heartbeat.ts, startNextQueuedRunForAgent)
-- pages through the queue with a keyset cursor:
--
--   SELECT * FROM heartbeat_runs
--    WHERE agent_id = $1 AND status = 'queued' [AND created_at >= $cutoff]
--      [AND (created_at, id) > ($cursorCreatedAt, $cursorId)]
--    ORDER BY created_at ASC, id ASC
--    LIMIT $batchSize
--
-- Every pre-existing index on this table leads with company_id, and none pairs
-- status with created_at, so this query had no usable index. PostgreSQL fell
-- back to an index scan over heartbeat_runs_company_status_process_started_idx
-- (skipping the leading company_id column), filtered agent_id in the executor,
-- and then sorted the survivors:
--
--   Sort  (actual rows=227)
--     Sort Key: created_at
--     ->  Index Scan using heartbeat_runs_company_status_process_started_idx
--           Index Cond: (status = 'queued')
--           Filter: (agent_id = ...)
--           Rows Removed by Filter: 265
--
-- A partial index is a very good fit here: the table is ~219k rows / ~1.8 GB,
-- but only ~850 rows are in a dispatchable status at any moment. Restricting
-- the index to those statuses keeps it tiny while covering the whole hot path.
--
-- id is a key column, not merely along for the ride: the dispatcher orders by
-- (created_at, id) and seeks with a row-comparison cursor on the same pair, so
-- including it lets the planner satisfy both the ORDER BY and the cursor seek
-- straight from the index, with no Sort node over wide (~2.8 kB) rows. The
-- tiebreak is required for correctness, not only speed — bulk wake fan-out
-- stamps identical created_at values, so paging on created_at alone would skip
-- or repeat rows at a batch boundary.
--
-- status is kept as an index key (not only in the predicate) so the same index
-- serves the queued-only dispatch query and the
-- status IN ('queued','scheduled_retry') aggregate behind
-- GET /api/companies/:companyId/pr-review-queue.
--
-- Drizzle migrations are transactional, so CONCURRENTLY is unavailable here and
-- a plain CREATE INDEX would hold a SHARE lock on a 1.8 GB hot table for the
-- whole build, blocking every insert/update/delete against it. IF NOT EXISTS
-- makes a rerun idempotent but does nothing about that lock. The guard below
-- therefore makes online precreation a *required and verified* prerequisite
-- rather than an optional suggestion: a populated database fails the migration
-- with the exact command to run, and a precreated index that does not match
-- this definition is rejected rather than silently accepted. Empty databases
-- (tests, bootstrap) build it inline, where there is nothing to block.
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: guarded below so non-empty databases must precreate the index concurrently.
DO $$
BEGIN
  IF to_regclass('public.heartbeat_runs_agent_dispatch_idx') IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM pg_index AS index_metadata
      JOIN pg_class AS index_relation
        ON index_relation.oid = index_metadata.indexrelid
      JOIN pg_am AS access_method
        ON access_method.oid = index_relation.relam
      WHERE index_metadata.indexrelid = to_regclass('public.heartbeat_runs_agent_dispatch_idx')
        AND index_metadata.indrelid = 'public.heartbeat_runs'::regclass
        AND index_metadata.indisvalid
        AND access_method.amname = 'btree'
        AND index_metadata.indnkeyatts = 4
        AND index_metadata.indnatts = 4
        AND ARRAY(
          SELECT pg_get_indexdef(index_metadata.indexrelid, key_position, TRUE)
          FROM generate_series(1, index_metadata.indnkeyatts) AS key_position
          ORDER BY key_position
        ) = ARRAY['agent_id', 'status', 'created_at', 'id']
        AND index_metadata.indoption = '0 0 0 0'::int2vector
        AND pg_get_expr(index_metadata.indpred, index_metadata.indrelid, TRUE)
          = 'status = ANY (ARRAY[''queued''::text, ''scheduled_retry''::text])'
    )
  THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 0208 found an invalid or incorrectly defined prerequisite index',
      HINT = 'Run DROP INDEX CONCURRENTLY IF EXISTS heartbeat_runs_agent_dispatch_idx; then CREATE INDEX CONCURRENTLY heartbeat_runs_agent_dispatch_idx ON heartbeat_runs USING btree (agent_id, status, created_at, id) WHERE status IN (''queued'', ''scheduled_retry''); then retry migrations.';
  ELSIF to_regclass('public.heartbeat_runs_agent_dispatch_idx') IS NULL THEN
    IF EXISTS (SELECT 1 FROM "heartbeat_runs" LIMIT 1) THEN
      RAISE EXCEPTION USING
        MESSAGE = 'migration 0208 requires online index precreation',
        HINT = 'Run CREATE INDEX CONCURRENTLY IF NOT EXISTS heartbeat_runs_agent_dispatch_idx ON heartbeat_runs USING btree (agent_id, status, created_at, id) WHERE status IN (''queued'', ''scheduled_retry''), then retry migrations.';
    END IF;

    -- Close the gap between the empty-table check and CREATE INDEX without
    -- taking this lock on populated production tables.
    LOCK TABLE "heartbeat_runs" IN SHARE MODE;
    IF EXISTS (SELECT 1 FROM "heartbeat_runs" LIMIT 1) THEN
      RAISE EXCEPTION USING
        MESSAGE = 'migration 0208 requires online index precreation',
        HINT = 'Run CREATE INDEX CONCURRENTLY IF NOT EXISTS heartbeat_runs_agent_dispatch_idx ON heartbeat_runs USING btree (agent_id, status, created_at, id) WHERE status IN (''queued'', ''scheduled_retry''), then retry migrations.';
    END IF;

    CREATE INDEX "heartbeat_runs_agent_dispatch_idx"
      ON "heartbeat_runs" USING btree (
        "agent_id",
        "status",
        "created_at",
        "id"
      )
      WHERE "status" IN ('queued', 'scheduled_retry');
  END IF;
END
$$;
