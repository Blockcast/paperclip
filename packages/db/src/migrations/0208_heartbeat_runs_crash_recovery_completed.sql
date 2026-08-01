-- BLO-19722: durable completion marker for worker-crash recovery.
--
-- `reconcileWorkerCrashedRuns` previously inferred "recovery finished" from the
-- existence of a retry child. That inference is wrong in both directions:
-- recovery deliberately completes *without* a retry when the agent is not
-- invokable (`enqueueProcessLossRetry` suppresses it and releases the issue
-- lock instead), so such a row would be replayed on every startup forever; and
-- the retry is committed *before* the lifecycle-event and agent-finalization
-- steps, so a crash in between made the row vanish from reconciliation while
-- those steps were still unfinished. Recording completion explicitly is the
-- only thing that gets both cases right.
--
-- Nullable, no default, so this is a catalog-only rewrite-free ADD COLUMN.
-- No backfill: `error_code = 'worker_crashed'` is introduced by the same change
-- that adds this column, so there are no pre-existing rows to classify.
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "crash_recovery_completed_at" timestamp with time zone;
--> statement-breakpoint
-- Supports the startup candidate scan, which is bounded by batch size and
-- ordered oldest-first (finished_at, id). The partial predicate keeps the index
-- near-empty: only crash-marked runs still awaiting recovery are members, and
-- stamping the column removes a row from it. Steady state is an empty probe.
-- Drizzle migrations are transactional, so production must precreate this exact
-- index online. Empty databases can create it safely during bootstrap.
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: guarded below so non-empty databases must precreate the index concurrently.
DO $$
BEGIN
  IF to_regclass('public.heartbeat_runs_crash_recovery_pending_idx') IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM pg_index AS index_metadata
      JOIN pg_class AS index_relation
        ON index_relation.oid = index_metadata.indexrelid
      JOIN pg_am AS access_method
        ON access_method.oid = index_relation.relam
      WHERE index_metadata.indexrelid = to_regclass('public.heartbeat_runs_crash_recovery_pending_idx')
        AND index_metadata.indrelid = 'public.heartbeat_runs'::regclass
        AND index_metadata.indisvalid
        AND access_method.amname = 'btree'
        AND index_metadata.indnkeyatts = 2
        AND index_metadata.indnatts = 2
        AND ARRAY(
          SELECT pg_get_indexdef(index_metadata.indexrelid, key_position, TRUE)
          FROM generate_series(1, index_metadata.indnkeyatts) AS key_position
          ORDER BY key_position
        ) = ARRAY['finished_at', 'id']
        AND index_metadata.indoption = '0 0'::int2vector
        -- Compare the predicate paren- and whitespace-insensitively.
        -- `pg_get_expr` renders a two-conjunct predicate without redundant
        -- parentheses on current PostgreSQL but has bracketed conjuncts on
        -- older majors, so pinning the literal exactly would fail migrations on
        -- a version difference alone. Neither paren placement changes meaning
        -- here, and the operand text is still compared strictly.
        AND regexp_replace(
              translate(pg_get_expr(index_metadata.indpred, index_metadata.indrelid, TRUE), '()', ''),
              '\s+', ' ', 'g'
            ) = 'error_code = ''worker_crashed''::text AND crash_recovery_completed_at IS NULL'
    )
  THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 0208 found an invalid or incorrectly defined prerequisite index',
      HINT = 'Run DROP INDEX CONCURRENTLY IF EXISTS heartbeat_runs_crash_recovery_pending_idx; then CREATE INDEX CONCURRENTLY heartbeat_runs_crash_recovery_pending_idx ON heartbeat_runs USING btree (finished_at, id) WHERE error_code = ''worker_crashed'' AND crash_recovery_completed_at IS NULL; then retry migrations.';
  ELSIF to_regclass('public.heartbeat_runs_crash_recovery_pending_idx') IS NULL THEN
    IF EXISTS (SELECT 1 FROM "heartbeat_runs" LIMIT 1) THEN
      RAISE EXCEPTION USING
        MESSAGE = 'migration 0208 requires online index precreation',
        HINT = 'Run CREATE INDEX CONCURRENTLY IF NOT EXISTS heartbeat_runs_crash_recovery_pending_idx ON heartbeat_runs USING btree (finished_at, id) WHERE error_code = ''worker_crashed'' AND crash_recovery_completed_at IS NULL, then retry migrations.';
    END IF;

    -- Close the gap between the empty-table check and CREATE INDEX without
    -- taking this lock on populated production tables.
    LOCK TABLE "heartbeat_runs" IN SHARE MODE;
    IF EXISTS (SELECT 1 FROM "heartbeat_runs" LIMIT 1) THEN
      RAISE EXCEPTION USING
        MESSAGE = 'migration 0208 requires online index precreation',
        HINT = 'Run CREATE INDEX CONCURRENTLY IF NOT EXISTS heartbeat_runs_crash_recovery_pending_idx ON heartbeat_runs USING btree (finished_at, id) WHERE error_code = ''worker_crashed'' AND crash_recovery_completed_at IS NULL, then retry migrations.';
    END IF;

    CREATE INDEX "heartbeat_runs_crash_recovery_pending_idx"
      ON "heartbeat_runs" USING btree (
        "finished_at",
        "id"
      )
      WHERE "error_code" = 'worker_crashed' AND "crash_recovery_completed_at" IS NULL;
  END IF;
END
$$;
