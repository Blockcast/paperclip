-- BLO-29312: resolve a run's OUTBOUND retry edge -- the park created because
-- that run ended -- in one indexed lookup:
--
--   SELECT id, status, scheduled_retry_at, scheduled_retry_attempt,
--          scheduled_retry_reason, created_at
--     FROM heartbeat_runs
--    WHERE retry_of_run_id = $1
--    ORDER BY created_at
--    LIMIT 1
--
-- Every persisted scheduled_retry_* column points the other way (it describes
-- the park that produced the row, not one the row's failure produced), so
-- "was this failed run retried?" has only ever been answerable by searching
-- retry_of_run_id in reverse. Nothing indexed that column: the self-referencing
-- FK on it does not create one -- PostgreSQL indexes the referenced side, not
-- the referencing side -- so the lookup was a sequential scan over the whole
-- table. Migration 0208 measured ~219k rows / ~1.8 GB here and it only grows,
-- which is why the question was previously answered by paging the company run
-- list instead, and in practice not answered at all for runs older than a few
-- hours.
--
-- Partial on `retry_of_run_id IS NOT NULL`: only rows that succeed some other
-- run carry a value, and a NULL is never the search key, so excluding them
-- keeps the index proportional to the retry population rather than to all of
-- heartbeat_runs. Trailing created_at lets the LIMIT 1 come straight off the
-- index instead of sorting the (normally one-row, but not uniquely
-- constrained) match set.
--
-- Drizzle migrations are transactional, so CONCURRENTLY is unavailable here and
-- a plain CREATE INDEX would hold a SHARE lock on a large hot table for the
-- whole build, blocking every insert/update/delete against it. The guard below
-- therefore makes online precreation a *required and verified* prerequisite
-- rather than an optional suggestion, exactly as migrations 0205, 0208, 0209,
-- and 0224 do for this same table: a populated database fails the migration
-- with the exact command to run, and a precreated index that does not match
-- this definition is rejected rather than silently accepted. Empty databases
-- (tests, bootstrap) build it inline, where there is nothing to block.
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: guarded below so non-empty databases must precreate the index concurrently.
DO $$
BEGIN
  IF to_regclass('public.heartbeat_runs_retry_successor_idx') IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM pg_index AS index_metadata
      JOIN pg_class AS index_relation
        ON index_relation.oid = index_metadata.indexrelid
      JOIN pg_am AS access_method
        ON access_method.oid = index_relation.relam
      WHERE index_metadata.indexrelid = to_regclass('public.heartbeat_runs_retry_successor_idx')
        AND index_metadata.indrelid = 'public.heartbeat_runs'::regclass
        AND index_metadata.indisvalid
        AND access_method.amname = 'btree'
        AND index_metadata.indnkeyatts = 2
        AND index_metadata.indnatts = 2
        AND ARRAY(
          SELECT pg_get_indexdef(index_metadata.indexrelid, key_position, TRUE)
          FROM generate_series(1, index_metadata.indnkeyatts) AS key_position
          ORDER BY key_position
        ) = ARRAY['retry_of_run_id', 'created_at']
        AND index_metadata.indoption = '0 0'::int2vector
        AND pg_get_expr(index_metadata.indpred, index_metadata.indrelid, TRUE) = 'retry_of_run_id IS NOT NULL'
    )
  THEN
    RAISE EXCEPTION USING
       MESSAGE = 'migration 0230 found an invalid or incorrectly defined prerequisite index',
      HINT = 'Run DROP INDEX CONCURRENTLY IF EXISTS heartbeat_runs_retry_successor_idx; then CREATE INDEX CONCURRENTLY heartbeat_runs_retry_successor_idx ON heartbeat_runs USING btree (retry_of_run_id, created_at) WHERE retry_of_run_id IS NOT NULL; then retry migrations.';
  ELSIF to_regclass('public.heartbeat_runs_retry_successor_idx') IS NULL THEN
    IF EXISTS (SELECT 1 FROM "heartbeat_runs" LIMIT 1) THEN
      RAISE EXCEPTION USING
       MESSAGE = 'migration 0230 requires online index precreation',
        HINT = 'Run CREATE INDEX CONCURRENTLY IF NOT EXISTS heartbeat_runs_retry_successor_idx ON heartbeat_runs USING btree (retry_of_run_id, created_at) WHERE retry_of_run_id IS NOT NULL, then retry migrations.';
    END IF;

    -- Close the gap between the empty-table check and CREATE INDEX without
    -- taking this lock on populated production tables.
    LOCK TABLE "heartbeat_runs" IN SHARE MODE;
    IF EXISTS (SELECT 1 FROM "heartbeat_runs" LIMIT 1) THEN
      RAISE EXCEPTION USING
       MESSAGE = 'migration 0230 requires online index precreation',
        HINT = 'Run CREATE INDEX CONCURRENTLY IF NOT EXISTS heartbeat_runs_retry_successor_idx ON heartbeat_runs USING btree (retry_of_run_id, created_at) WHERE retry_of_run_id IS NOT NULL, then retry migrations.';
    END IF;

    CREATE INDEX "heartbeat_runs_retry_successor_idx"
      ON "heartbeat_runs" USING btree (
        "retry_of_run_id",
        "created_at"
      )
      WHERE "retry_of_run_id" IS NOT NULL;
  END IF;
END
$$;
