-- Transactional outbox for recovery-owner wakes (BLO-18829).
--
-- Stranded escalation used to call enqueueWakeup inline, before the expected-status
-- CAS that guards the `blocked` transition. A concurrent writer landing between the
-- status re-check and the CAS made the CAS no-op while the wake had already escaped.
-- The wake cannot move after the CAS (no retry path -- reconcileStrandedAssignedIssues
-- does not select `blocked` issues), and enqueueWakeup cannot join the escalation tx
-- (it opens its own transactions on other pooled connections and would block on the
-- escalation's advisory lock). So escalation inserts here on the SAME tx as the status
-- write and a post-commit dispatcher drains it with backoff.
--
-- Hand-authored tail migration, journaled as idx 206 (0204/0205 precedent).
-- The apply path wraps each statement in a SAVEPOINT and swallows duplicate-object
-- errors, so IF NOT EXISTS + the FK guards make this re-apply-safe.
CREATE TABLE IF NOT EXISTS "recovery_wake_outbox" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "seq" bigserial NOT NULL,
  "company_id" uuid NOT NULL,
  "source_issue_id" uuid NOT NULL,
  "recovery_action_id" uuid,
  "agent_id" uuid,
  "recovery_cause" text,
  "wake_options" jsonb NOT NULL,
  "idempotency_key" text NOT NULL,
  "status" text DEFAULT 'queued' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "dispatched_at" timestamp with time zone
);--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "recovery_wake_outbox"
    ADD CONSTRAINT "recovery_wake_outbox_company_id_companies_id_fk"
    FOREIGN KEY ("company_id") REFERENCES "companies"("id");
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "recovery_wake_outbox"
    ADD CONSTRAINT "recovery_wake_outbox_source_issue_id_issues_id_fk"
    FOREIGN KEY ("source_issue_id") REFERENCES "issues"("id") ON DELETE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "recovery_wake_outbox"
    ADD CONSTRAINT "recovery_wake_outbox_agent_id_agents_id_fk"
    FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE SET NULL;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: new empty table; the index build is a no-op at create time.
CREATE UNIQUE INDEX IF NOT EXISTS "recovery_wake_outbox_idempotency_key_uq"
  ON "recovery_wake_outbox" USING btree ("idempotency_key");--> statement-breakpoint
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: new empty table; the index build is a no-op at create time.
CREATE INDEX IF NOT EXISTS "recovery_wake_outbox_claim_idx"
  ON "recovery_wake_outbox" USING btree ("status", "next_attempt_at", "seq");--> statement-breakpoint
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: new empty table; the index build is a no-op at create time.
CREATE INDEX IF NOT EXISTS "recovery_wake_outbox_source_issue_idx"
  ON "recovery_wake_outbox" USING btree ("source_issue_id");
