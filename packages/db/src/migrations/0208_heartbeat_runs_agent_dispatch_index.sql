-- BLO-20396: per-agent queued-run dispatch index.
--
-- The dispatcher (server/src/services/heartbeat.ts, startNextQueuedRunForAgent)
-- selects the next runs to start with:
--
--   SELECT * FROM heartbeat_runs
--    WHERE agent_id = $1 AND status = 'queued' [AND created_at >= $cutoff]
--    ORDER BY created_at ASC
--    LIMIT $scanLimit
--
-- Every pre-existing index on this table leads with company_id, and none pairs
-- status with created_at, so this query had no usable index. Postgres fell back
-- to an index scan over heartbeat_runs_company_status_process_started_idx
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
-- the index to those statuses keeps it tiny while covering the whole hot path,
-- and ordering on created_at lets the planner satisfy the ORDER BY ... LIMIT
-- directly from the index instead of sorting wide (~2.8 kB) rows.
--
-- status is kept as an index key (not only in the predicate) so the same index
-- serves the queued-only dispatch query and the
-- status IN ('queued','scheduled_retry') aggregate behind
-- GET /api/companies/:companyId/pr-review-queue.

-- paperclip:migration-safety-ignore large-create-index-not-concurrently: Drizzle migrations run transactionally, so CONCURRENTLY is unavailable; this index is idempotent (IF NOT EXISTS) and production can precreate it online with CREATE INDEX CONCURRENTLY before rollout.
CREATE INDEX IF NOT EXISTS "heartbeat_runs_agent_dispatch_idx"
  ON "heartbeat_runs" USING btree ("agent_id", "status", "created_at")
  WHERE "status" IN ('queued', 'scheduled_retry');
