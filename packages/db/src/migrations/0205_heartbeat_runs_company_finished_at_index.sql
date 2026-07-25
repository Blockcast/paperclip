-- PR-review queue observability bounds recent terminal history by company and
-- completion order. Keep this access path independent of JSONB selectivity so
-- PostgreSQL can stop after the requested detail limit during queue incidents.
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: Drizzle migrations run transactionally, so CONCURRENTLY is unavailable; production can precreate this exact idempotent index online before rollout.
CREATE INDEX IF NOT EXISTS "heartbeat_runs_company_finished_at_desc_idx"
  ON "heartbeat_runs" USING btree (
    "company_id",
    "finished_at" DESC,
    "id" DESC
  )
  WHERE "finished_at" IS NOT NULL;
