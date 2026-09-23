ALTER TABLE "issue_recovery_actions" ADD COLUMN IF NOT EXISTS "hand_back_residual_reason" text;--> statement-breakpoint
ALTER TABLE "issue_recovery_actions" ADD COLUMN IF NOT EXISTS "hand_back_residual_detail" text;--> statement-breakpoint
ALTER TABLE "issue_recovery_actions" ADD COLUMN IF NOT EXISTS "hand_back_residual_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_recovery_actions_hand_back_residual_idx" ON "issue_recovery_actions" USING btree ("company_id","hand_back_residual_reason") WHERE "hand_back_residual_reason" is not null;
