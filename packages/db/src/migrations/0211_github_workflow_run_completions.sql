-- Durable unique-run accounting for GitHub workflow_run.completed metrics.
--
-- Prometheus counters are per process, but BLO-21078's mass-cancellation alert
-- interprets the summed counter as unique completed workflow runs. GitHub can
-- redeliver one completion to different API replicas, so count only the first
-- successful insert for (workflow_run.id, run_attempt).
CREATE TABLE IF NOT EXISTS "github_workflow_run_completions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workflow_run_id" text NOT NULL,
  "run_attempt" integer DEFAULT 1 NOT NULL,
  "repo_full_name" text,
  "conclusion" text NOT NULL,
  "first_delivery_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "github_workflow_run_completions_run_attempt_uq"
  ON "github_workflow_run_completions" USING btree ("workflow_run_id", "run_attempt");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "github_workflow_run_completions_repo_created_at_idx"
  ON "github_workflow_run_completions" USING btree ("repo_full_name", "created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "github_workflow_run_completions_created_at_idx"
  ON "github_workflow_run_completions" USING btree ("created_at");
