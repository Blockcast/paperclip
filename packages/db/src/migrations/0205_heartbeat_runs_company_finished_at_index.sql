-- PR-review queue observability bounds recent terminal history by company and
-- completion order. Keep this access path independent of JSONB selectivity so
-- PostgreSQL can stop after the requested detail limit during queue incidents.
-- Drizzle migrations are transactional, so production must precreate this exact
-- index online. Empty databases can create it safely during bootstrap.
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: guarded below so non-empty databases must precreate the index concurrently.
DO $$
BEGIN
  IF to_regclass('public.heartbeat_runs_company_finished_at_desc_idx') IS NULL THEN
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
