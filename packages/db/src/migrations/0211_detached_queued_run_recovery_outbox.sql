CREATE TABLE "detached_queued_run_recoveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"source_run_id" uuid NOT NULL,
	"status" text DEFAULT 'detached' NOT NULL,
	"recovery_run_id" uuid,
	"detached_at" timestamp with time zone DEFAULT now() NOT NULL,
	"pending_at" timestamp with time zone,
	"last_attempt_at" timestamp with time zone,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "detached_queued_run_recoveries" ADD CONSTRAINT "detached_queued_run_recoveries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "detached_queued_run_recoveries" ADD CONSTRAINT "detached_queued_run_recoveries_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "detached_queued_run_recoveries" ADD CONSTRAINT "detached_queued_run_recoveries_source_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("source_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "detached_queued_run_recoveries" ADD CONSTRAINT "detached_queued_run_recoveries_recovery_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("recovery_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "detached_queued_run_recoveries_source_run_uq" ON "detached_queued_run_recoveries" USING btree ("source_run_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "detached_queued_run_recoveries_pending_issue_uq" ON "detached_queued_run_recoveries" USING btree ("company_id", "issue_id") WHERE "status" = 'pending';
--> statement-breakpoint
CREATE INDEX "detached_queued_run_recoveries_status_detached_at_idx" ON "detached_queued_run_recoveries" USING btree ("status", "detached_at", "id");
--> statement-breakpoint
CREATE INDEX "detached_queued_run_recoveries_status_pending_at_idx" ON "detached_queued_run_recoveries" USING btree ("status", "last_attempt_at", "pending_at", "id");
--> statement-breakpoint
-- Backfill only from the stale-lock sweeper's server-written audit evidence.
-- Starting from the small queued-run population lets PostgreSQL use the
-- activity_log entity lookup index per issue instead of scanning the full log.
-- A NULL issue pointer by itself is deliberately insufficient evidence.
INSERT INTO "detached_queued_run_recoveries" (
	"company_id",
	"issue_id",
	"source_run_id",
	"status",
	"detached_at",
	"created_at",
	"updated_at"
)
SELECT
	"heartbeat_runs"."company_id",
	"issues"."id",
	"heartbeat_runs"."id",
	'detached',
	max("activity_log"."created_at"),
	max("activity_log"."created_at"),
	max("activity_log"."created_at")
FROM "heartbeat_runs"
INNER JOIN "issues"
	ON "issues"."company_id" = "heartbeat_runs"."company_id"
	AND "issues"."id"::text = "heartbeat_runs"."context_issue_id"
INNER JOIN "activity_log"
	ON "activity_log"."company_id" = "issues"."company_id"
	AND "activity_log"."entity_type" = 'issue'
	AND "activity_log"."entity_id" = "issues"."id"::text
	AND "activity_log"."action" = 'issue.stale_lock_cleared'
	AND "activity_log"."details" ->> 'reason' = 'pre_claim_lock_expired'
	AND "activity_log"."details" ->> 'clearedExecutionRunId' = "heartbeat_runs"."id"::text
WHERE "heartbeat_runs"."status" = 'queued'
	AND "issues"."status" NOT IN ('done', 'cancelled')
	AND "issues"."execution_run_id" IS DISTINCT FROM "heartbeat_runs"."id"
	AND "issues"."checkout_run_id" IS DISTINCT FROM "heartbeat_runs"."id"
GROUP BY "heartbeat_runs"."company_id", "issues"."id", "heartbeat_runs"."id"
ON CONFLICT ("source_run_id") DO NOTHING;
