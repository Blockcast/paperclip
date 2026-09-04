-- BLO-21116: make the scrape-time queued-run age aggregate use a queue-only
-- expression index. The queued_at column and its rollout backfill already live
-- in migration 0215 on current master.
--
-- Drizzle migrations run in a transaction, so CREATE INDEX CONCURRENTLY is not
-- available here. A plain index build would take a SHARE lock over the hot
-- heartbeat_runs table. Populated databases must precreate this index online;
-- empty bootstrap databases can build it inline.
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: the populated-table path fails closed and supplies the concurrent command.
DO $$
DECLARE
  normalized_predicate text;
BEGIN
  IF to_regclass('public.heartbeat_runs_queued_age_idx') IS NOT NULL THEN
    SELECT trim(regexp_replace(
             coalesce(pg_get_expr(index_metadata.indpred, index_metadata.indrelid, TRUE), ''),
             '\s+', ' ', 'g'))
      INTO normalized_predicate
      FROM pg_index AS index_metadata
     WHERE index_metadata.indexrelid = to_regclass('public.heartbeat_runs_queued_age_idx');

    IF NOT EXISTS (
      SELECT 1
      FROM pg_index AS index_metadata
      JOIN pg_class AS index_relation
        ON index_relation.oid = index_metadata.indexrelid
      JOIN pg_am AS access_method
        ON access_method.oid = index_relation.relam
      WHERE index_metadata.indexrelid = to_regclass('public.heartbeat_runs_queued_age_idx')
        AND index_metadata.indrelid = 'public.heartbeat_runs'::regclass
        AND index_metadata.indisvalid
        AND access_method.amname = 'btree'
        AND index_metadata.indnkeyatts = 2
        AND index_metadata.indnatts = 2
        AND ARRAY(
          SELECT pg_get_indexdef(index_metadata.indexrelid, key_position, TRUE)
          FROM generate_series(1, index_metadata.indnkeyatts) AS key_position
          ORDER BY key_position
        ) = ARRAY['agent_id', 'COALESCE(queued_at, created_at)']
        AND index_metadata.indoption = '0 0'::int2vector
        AND normalized_predicate = 'status = ''queued''::text'
    )
    THEN
      RAISE EXCEPTION USING
        MESSAGE = 'migration 0217 found an invalid or incorrectly defined queued-age index',
        HINT = 'Run DROP INDEX CONCURRENTLY IF EXISTS heartbeat_runs_queued_age_idx; then CREATE INDEX CONCURRENTLY heartbeat_runs_queued_age_idx ON heartbeat_runs USING btree (agent_id, (coalesce(queued_at, created_at))) WHERE status = ''queued''; then retry migrations.';
    END IF;
  ELSE
    IF EXISTS (SELECT 1 FROM "heartbeat_runs" LIMIT 1) THEN
      RAISE EXCEPTION USING
        MESSAGE = 'migration 0217 requires online index precreation',
        HINT = 'Run CREATE INDEX CONCURRENTLY IF NOT EXISTS heartbeat_runs_queued_age_idx ON heartbeat_runs USING btree (agent_id, (coalesce(queued_at, created_at))) WHERE status = ''queued''; then retry migrations.';
    END IF;

    -- Close the gap between the empty-table check and CREATE INDEX without
    -- taking this lock on a populated production table.
    LOCK TABLE "heartbeat_runs" IN SHARE MODE;
    IF EXISTS (SELECT 1 FROM "heartbeat_runs" LIMIT 1) THEN
      RAISE EXCEPTION USING
        MESSAGE = 'migration 0217 requires online index precreation',
        HINT = 'Run CREATE INDEX CONCURRENTLY IF NOT EXISTS heartbeat_runs_queued_age_idx ON heartbeat_runs USING btree (agent_id, (coalesce(queued_at, created_at))) WHERE status = ''queued''; then retry migrations.';
    END IF;

    CREATE INDEX "heartbeat_runs_queued_age_idx"
      ON "heartbeat_runs" USING btree (
        "agent_id",
        (coalesce("queued_at", "created_at"))
      )
      WHERE "status" = 'queued';
  END IF;
END
$$;
