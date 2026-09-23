-- Durable inbox for signed GitHub webhook deliveries that must revoke stale
-- review-gate authorization before asynchronous reconciliation completes.
CREATE TABLE IF NOT EXISTS "github_review_gate_deliveries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "delivery_id" text NOT NULL,
  "repo_full_name" text NOT NULL,
  "event_name" text NOT NULL,
  "payload" jsonb NOT NULL,
  "payload_digest" text NOT NULL,
  "status_context" text NOT NULL,
  "reviewer_bot_login" text NOT NULL,
  "base_ref" text NOT NULL,
  "dispatch_event_type" text NOT NULL,
  "expected_app_id" text NOT NULL,
  "expected_installation_id" text NOT NULL,
  "status" text DEFAULT 'queued' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_error" text,
  "last_result" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "delivered_at" timestamp with time zone
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "github_review_gate_deliveries_delivery_id_uq"
  ON "github_review_gate_deliveries" USING btree ("delivery_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "github_review_gate_deliveries_status_due_idx"
  ON "github_review_gate_deliveries" USING btree ("status", "next_attempt_at", "created_at");
