-- Webhook-triggered status deliveries have no heartbeat run or company row.
-- Keep those writes durable in the same outbox instead of logging and losing
-- a failed retired-context overwrite.
ALTER TABLE "github_commit_status_deliveries"
  ALTER COLUMN "company_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "github_commit_status_deliveries"
  ALTER COLUMN "source_run_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "github_commit_status_deliveries"
  ADD COLUMN IF NOT EXISTS "force_write" boolean DEFAULT false NOT NULL;
