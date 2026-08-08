-- BLO-21116: queued-run observability must measure the current queue stint,
-- not a retry's full lifetime. Fresh queued inserts use created_at; transitions
-- back into queued stamp queued_at in the application.
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "queued_at" timestamp with time zone;
--> statement-breakpoint
-- Rows already queued at rollout predate the explicit transition timestamp.
-- updated_at is the closest durable queue-entry approximation and prevents an
-- old scheduled-retry backoff from immediately looking like a stranded queue.
UPDATE "heartbeat_runs"
SET "queued_at" = GREATEST("updated_at", "created_at")
WHERE "status" = 'queued'
  AND "queued_at" IS NULL;
