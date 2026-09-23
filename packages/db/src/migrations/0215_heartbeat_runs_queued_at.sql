-- BLO-21116 (Ally review on Blockcast/onprem-k8s#2013): the queued-run-age
-- gauge ages off heartbeat_runs.created_at, so a run promoted out of a long
-- scheduled_retry backoff inherits its full lifetime age instead of the time
-- it actually spent waiting for a dispatch slot. Nullable, no default: a fast
-- metadata-only ADD COLUMN, not a table rewrite. Left null for fresh `queued`
-- inserts -- refreshQueuedRunAgeMetrics falls back to created_at via
-- COALESCE, which is already correct for a brand-new row. Only the specific
-- transitions that put an *existing* row back into `queued` after it was
-- something else stamp this column with the transition's own `now()`.
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "queued_at" timestamp with time zone;

-- Backfill (Ally review, 2026-08-12): a row already sitting at status='queued'
-- when this migration deploys predates both new stamping sites above, so
-- leaving it null would fall back to created_at -- reporting its full
-- lifetime, including any pre-deploy scheduled_retry backoff, as
-- queue-dispatch wait, and could immediately cross the
-- PaperclipQueuedRunStranded threshold the instant the rule goes live.
-- updated_at is not an exact queue-entry timestamp (a row can be updated for
-- reasons other than a requeue), but it is a strictly closer approximation
-- than created_at for any row touched since creation, and it is exact for a
-- row that has never left `queued` at all.
UPDATE "heartbeat_runs" SET "queued_at" = "updated_at" WHERE "status" = 'queued' AND "queued_at" IS NULL;
