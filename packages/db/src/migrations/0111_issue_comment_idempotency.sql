ALTER TABLE "issue_comments" ADD COLUMN IF NOT EXISTS "idempotency_key" text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "issue_comments_issue_idempotency_idx"
	ON "issue_comments" USING btree ("issue_id", "idempotency_key")
	WHERE "idempotency_key" IS NOT NULL AND "deleted_at" IS NULL;
