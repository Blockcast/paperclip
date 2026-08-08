-- BLO-19722 / BLO-20822 — Phase B: index for crash-recovery candidates.
--
-- The partial index serves the oldest-first scan of crash-marked runs whose
-- recovery is unfinished. It is a performance optimization: recovery remains
-- correct without it, using a sequential scan.
--
-- CREATE INDEX CONCURRENTLY cannot run in a migration transaction. On populated
-- databases, absence is therefore reported and the index is created online
-- after Phase A has committed. An existing but misdefined index is rejected
-- because it could make the periodic scan's index-presence check misleading.
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: only created inline on an empty table; populated databases use the documented CONCURRENTLY predeploy step.
DO $$
BEGIN
  IF to_regclass('public.heartbeat_runs_crash_recovery_pending_idx') IS NOT NULL THEN
    IF NOT EXISTS (
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
        AND regexp_replace(
              translate(pg_get_expr(index_metadata.indpred, index_metadata.indrelid, TRUE), '()', ''),
              '\s+', ' ', 'g'
            ) = 'error_code = ''worker_crashed''::text AND crash_recovery_completed_at IS NULL'
    ) THEN
      RAISE EXCEPTION USING
        MESSAGE = 'migration 0213 found an invalid or incorrectly defined heartbeat_runs_crash_recovery_pending_idx',
        HINT = 'Run DROP INDEX CONCURRENTLY IF EXISTS heartbeat_runs_crash_recovery_pending_idx; then recreate it with CREATE INDEX CONCURRENTLY heartbeat_runs_crash_recovery_pending_idx ON heartbeat_runs USING btree (finished_at, id) WHERE error_code = ''worker_crashed'' AND crash_recovery_completed_at IS NULL; then retry migrations.';
    END IF;

    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM "heartbeat_runs" LIMIT 1) THEN
    RAISE NOTICE 'migration 0213: heartbeat_runs is populated; skipping inline index build. Create heartbeat_runs_crash_recovery_pending_idx online with CREATE INDEX CONCURRENTLY (see this migration''s header). Recovery is correct without it — the candidate scan degrades to a sequential scan.';
    RETURN;
  END IF;

  LOCK TABLE "heartbeat_runs" IN SHARE MODE;
  IF EXISTS (SELECT 1 FROM "heartbeat_runs" LIMIT 1) THEN
    RAISE NOTICE 'migration 0213: heartbeat_runs became non-empty while acquiring SHARE; skipping inline index build. Create heartbeat_runs_crash_recovery_pending_idx online with CREATE INDEX CONCURRENTLY (see this migration''s header).';
    RETURN;
  END IF;

  CREATE INDEX "heartbeat_runs_crash_recovery_pending_idx"
    ON "heartbeat_runs" USING btree (
      "finished_at",
      "id"
    )
    WHERE "error_code" = 'worker_crashed' AND "crash_recovery_completed_at" IS NULL;
END
$$;
