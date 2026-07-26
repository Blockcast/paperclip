-- PR-review queue observability bounds recent terminal history by company and
-- completion order. Keep this access path independent of JSONB selectivity so
-- PostgreSQL can stop after the requested detail limit during queue incidents.
-- Drizzle migrations are transactional, so production must precreate this exact
-- index online. Empty databases can create it safely during bootstrap.
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: guarded below so non-empty databases must precreate the index concurrently.
DO $$
BEGIN
  IF to_regclass('public.heartbeat_runs_company_finished_at_desc_idx') IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM pg_index AS index_metadata
      JOIN pg_class AS index_relation
        ON index_relation.oid = index_metadata.indexrelid
      JOIN pg_am AS access_method
        ON access_method.oid = index_relation.relam
      WHERE index_metadata.indexrelid = to_regclass('public.heartbeat_runs_company_finished_at_desc_idx')
        AND index_metadata.indrelid = 'public.heartbeat_runs'::regclass
        AND index_metadata.indisvalid
        AND access_method.amname = 'btree'
        AND index_metadata.indnkeyatts = 3
        AND index_metadata.indnatts = 3
        AND ARRAY(
          SELECT pg_get_indexdef(index_metadata.indexrelid, key_position, TRUE)
          FROM generate_series(1, index_metadata.indnkeyatts) AS key_position
          ORDER BY key_position
        ) = ARRAY['company_id', 'finished_at', 'id']
        AND index_metadata.indoption = '0 3 3'::int2vector
        AND pg_get_expr(index_metadata.indpred, index_metadata.indrelid, TRUE) = 'finished_at IS NOT NULL'
    )
  THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 0205 found an invalid or incorrectly defined prerequisite index',
      HINT = 'Run DROP INDEX CONCURRENTLY IF EXISTS heartbeat_runs_company_finished_at_desc_idx; then CREATE INDEX CONCURRENTLY heartbeat_runs_company_finished_at_desc_idx ON heartbeat_runs USING btree (company_id, finished_at DESC, id DESC) WHERE finished_at IS NOT NULL; then retry migrations.';
  ELSIF to_regclass('public.heartbeat_runs_company_finished_at_desc_idx') IS NULL THEN
    IF EXISTS (SELECT 1 FROM "heartbeat_runs" LIMIT 1) THEN
      RAISE EXCEPTION USING
        MESSAGE = 'migration 0205 requires online index precreation',
        HINT = 'Run CREATE INDEX CONCURRENTLY IF NOT EXISTS heartbeat_runs_company_finished_at_desc_idx ON heartbeat_runs USING btree (company_id, finished_at DESC, id DESC) WHERE finished_at IS NOT NULL, then retry migrations.';
    END IF;

    -- Close the gap between the empty-table check and CREATE INDEX without
    -- taking this lock on populated production tables.
    LOCK TABLE "heartbeat_runs" IN SHARE MODE;
    IF EXISTS (SELECT 1 FROM "heartbeat_runs" LIMIT 1) THEN
      RAISE EXCEPTION USING
        MESSAGE = 'migration 0205 requires online index precreation',
        HINT = 'Run CREATE INDEX CONCURRENTLY IF NOT EXISTS heartbeat_runs_company_finished_at_desc_idx ON heartbeat_runs USING btree (company_id, finished_at DESC, id DESC) WHERE finished_at IS NOT NULL, then retry migrations.';
    END IF;

    CREATE INDEX "heartbeat_runs_company_finished_at_desc_idx"
      ON "heartbeat_runs" USING btree (
        "company_id",
        "finished_at" DESC,
        "id" DESC
      )
      WHERE "finished_at" IS NOT NULL;
  END IF;
END
$$;
