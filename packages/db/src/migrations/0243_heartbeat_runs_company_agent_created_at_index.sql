-- Bounds attention-service newer-run lookup by company and agent before the
-- created_at cutoff. Production precreates this index concurrently; bootstrap
-- databases can create it transactionally while empty.
DO $$
BEGIN
  IF to_regclass('public.heartbeat_runs_company_agent_created_at_idx') IS NULL THEN
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
