-- Numbered 0223 because master reserves 0217-0222 for queued-age, plugin,
-- issue-lock, branch-claim, repair, and parked-disposition migrations.
ALTER TABLE "pipeline_cases" ADD COLUMN IF NOT EXISTS "stage_generation" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "pipeline_case_events" ADD COLUMN IF NOT EXISTS "stage_generation" integer;--> statement-breakpoint
ALTER TABLE "pipeline_automation_executions" ADD COLUMN IF NOT EXISTS "stage_id" uuid;--> statement-breakpoint
ALTER TABLE "pipeline_automation_executions" ADD COLUMN IF NOT EXISTS "stage_generation" integer;--> statement-breakpoint
ALTER TABLE "pipeline_case_issue_links" ADD COLUMN IF NOT EXISTS "attachment_state" text DEFAULT 'attached' NOT NULL;--> statement-breakpoint
ALTER TABLE "pipeline_case_issue_links" DROP CONSTRAINT IF EXISTS "pipeline_case_issue_links_attachment_state_check";--> statement-breakpoint
ALTER TABLE "pipeline_case_issue_links" ADD CONSTRAINT "pipeline_case_issue_links_attachment_state_check" CHECK ("pipeline_case_issue_links"."attachment_state" in ('reserved', 'attached'));--> statement-breakpoint

-- A retired automation link is immutable audit history. New stage attempts get
-- their own row; non-automation links retain the previous uniqueness rule.
DROP INDEX IF EXISTS "pipeline_case_issue_links_case_issue_uq";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pipeline_case_issue_links_case_issue_non_automation_uq" ON "pipeline_case_issue_links" USING btree ("case_id","issue_id") WHERE "pipeline_case_issue_links"."role" <> 'automation';--> statement-breakpoint
DROP INDEX IF EXISTS "pipeline_case_issue_links_case_issue_automation_attempt_uq";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pipeline_case_issue_links_case_automation_attempt_uq" ON "pipeline_case_issue_links" USING btree ("case_id","automation_attempt_id") WHERE "pipeline_case_issue_links"."role" = 'automation' AND "pipeline_case_issue_links"."automation_attempt_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pipeline_case_issue_links_case_issue_automation_without_attempt_uq" ON "pipeline_case_issue_links" USING btree ("case_id","issue_id") WHERE "pipeline_case_issue_links"."role" = 'automation' AND "pipeline_case_issue_links"."automation_attempt_id" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pipeline_automation_executions_case_stage_generation_idx" ON "pipeline_automation_executions" USING btree ("case_id","stage_id","stage_generation");
