ALTER TABLE "issue_comment_effects"
	ADD COLUMN IF NOT EXISTS "next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_comment_effects_status_next_attempt_seq_idx" ON "issue_comment_effects" USING btree ("status","next_attempt_at","seq");
--> statement-breakpoint
DROP INDEX IF EXISTS "issue_comment_effects_status_seq_idx";
