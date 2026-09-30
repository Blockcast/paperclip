-- Bounds attention-service newer-run lookup by company and agent before the
-- created_at cutoff. Production precreates this index concurrently; bootstrap
-- databases can create it transactionally while empty.
DO $$
BEGIN
  IF to_regclass('public.heartbeat_runs_company_agent_created_at_idx') IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM pg_index AS index_metadata
      JOIN pg_class AS index_relation
        ON index_relation.oid = index_metadata.indexrelid
      JOIN pg_am AS access_method
        ON access_method.oid = index_relation.relam
      WHERE index_metadata.indexrelid = to_regclass('public.heartbeat_runs_company_agent_created_at_idx')
        AND index_metadata.indrelid = 'public.heartbeat_runs'::regclass
        AND index_metadata.indisvalid
        AND index_metadata.indisready
        AND access_method.amname = 'btree'
        AND index_metadata.indnkeyatts = 4
        AND index_metadata.indnatts = 4
        AND ARRAY(
          SELECT pg_get_indexdef(index_metadata.indexrelid, key_position, TRUE)
          FROM generate_series(1, index_metadata.indnkeyatts) AS key_position
          ORDER BY key_position
        ) = ARRAY['company_id', 'agent_id', 'created_at', 'id']
        AND index_metadata.indoption = '0 0 3 3'::int2vector
        AND pg_get_expr(index_metadata.indpred, index_metadata.indrelid, TRUE) IS NULL
    )
  THEN
    RAISE EXCEPTION USING
      MESSAGE = 'migration 0243 found an invalid or incorrectly defined prerequisite index',
      HINT = 'Run DROP INDEX CONCURRENTLY IF EXISTS heartbeat_runs_company_agent_created_at_idx; then CREATE INDEX CONCURRENTLY heartbeat_runs_company_agent_created_at_idx ON heartbeat_runs USING btree (company_id, agent_id, created_at DESC, id DESC); then retry migrations.';
  ELSIF to_regclass('public.heartbeat_runs_company_agent_created_at_idx') IS NULL THEN
    IF EXISTS (SELECT 1 FROM "heartbeat_runs" LIMIT 1) THEN
      RAISE EXCEPTION USING
        MESSAGE = 'migration 0243 requires online index precreation',
        HINT = 'Run CREATE INDEX CONCURRENTLY IF NOT EXISTS heartbeat_runs_company_agent_created_at_idx ON heartbeat_runs USING btree (company_id, agent_id, created_at DESC, id DESC); then retry migrations.';
    END IF;
    LOCK TABLE "heartbeat_runs" IN SHARE MODE;
    IF EXISTS (SELECT 1 FROM "heartbeat_runs" LIMIT 1) THEN
      RAISE EXCEPTION USING
        MESSAGE = 'migration 0243 requires online index precreation',
        HINT = 'Run CREATE INDEX CONCURRENTLY IF NOT EXISTS heartbeat_runs_company_agent_created_at_idx ON heartbeat_runs USING btree (company_id, agent_id, created_at DESC, id DESC); then retry migrations.';
    END IF;
    CREATE INDEX "heartbeat_runs_company_agent_created_at_idx"
      ON "heartbeat_runs" USING btree (
        "company_id",
        "agent_id",
        "created_at" DESC,
        "id" DESC
      );
  END IF;
END
$$;
