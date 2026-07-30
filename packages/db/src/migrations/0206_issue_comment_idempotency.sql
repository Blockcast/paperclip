ALTER TABLE "issue_comments" ADD COLUMN IF NOT EXISTS "idempotency_key" text;
--> statement-breakpoint
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: Drizzle migrations run transactionally, so CONCURRENTLY is unavailable; the partial index initially contains no rows because the new column is null for every existing comment.
CREATE UNIQUE INDEX IF NOT EXISTS "issue_comments_issue_idempotency_idx"
	ON "issue_comments" USING btree ("issue_id", "idempotency_key")
	WHERE "idempotency_key" IS NOT NULL AND "deleted_at" IS NULL;
