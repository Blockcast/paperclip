-- Durable GitHub commit-status delivery outbox.
--
-- PR-review retry exhaustion can need to fail a required GitHub status after
-- the heartbeat run is already terminal. Keep that external write in a durable,
-- idempotent queue so transient GitHub/token failures retry and stale writes
-- can re-check reviewer evidence before changing the commit status.
CREATE TABLE IF NOT EXISTS "github_commit_status_deliveries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "source_run_id" uuid NOT NULL,
  "repo_full_name" text NOT NULL,
  "sha" text NOT NULL,
  "context" text NOT NULL,
  "state" text DEFAULT 'failure' NOT NULL,
  "description" text NOT NULL,
  "target_url" text,
  "pr_number" integer NOT NULL,
  "pr_url" text,
  "status" text DEFAULT 'queued' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_error" text,
  "last_error_kind" text,
  "last_result" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "delivered_at" timestamp with time zone
);--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "github_commit_status_deliveries"
    ADD CONSTRAINT "github_commit_status_deliveries_company_id_companies_id_fk"
    FOREIGN KEY ("company_id") REFERENCES "companies"("id");
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "github_commit_status_deliveries"
    ADD CONSTRAINT "github_commit_status_deliveries_source_run_id_heartbeat_runs_id_fk"
    FOREIGN KEY ("source_run_id") REFERENCES "heartbeat_runs"("id") ON DELETE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "github_commit_status_deliveries_repo_sha_context_uq"
  ON "github_commit_status_deliveries" USING btree ("repo_full_name", "sha", "context");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "github_commit_status_deliveries_status_due_idx"
  ON "github_commit_status_deliveries" USING btree ("status", "next_attempt_at", "created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "github_commit_status_deliveries_source_run_idx"
  ON "github_commit_status_deliveries" USING btree ("source_run_id");
