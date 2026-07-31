ALTER TABLE "issue_comments" ADD COLUMN IF NOT EXISTS "idempotency_key" text;
--> statement-breakpoint
ALTER TABLE "issue_comments" ADD COLUMN IF NOT EXISTS "idempotency_processed_at" timestamp with time zone;
--> statement-breakpoint
DROP INDEX IF EXISTS "issue_comments_issue_idempotency_idx";
--> statement-breakpoint
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: Drizzle migrations run transactionally, so CONCURRENTLY is unavailable; the partial index initially contains no rows because the new column is null for every existing comment.
CREATE UNIQUE INDEX IF NOT EXISTS "issue_comments_issue_agent_idempotency_idx"
	ON "issue_comments" USING btree ("issue_id", "author_agent_id", "idempotency_key")
	WHERE "idempotency_key" IS NOT NULL AND "author_agent_id" IS NOT NULL AND "deleted_at" IS NULL;
--> statement-breakpoint
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: Drizzle migrations run transactionally, so CONCURRENTLY is unavailable; the partial index initially contains no rows because the new column is null for every existing comment.
CREATE UNIQUE INDEX IF NOT EXISTS "issue_comments_issue_user_idempotency_idx"
	ON "issue_comments" USING btree ("issue_id", "author_user_id", "idempotency_key")
	WHERE "idempotency_key" IS NOT NULL AND "author_user_id" IS NOT NULL AND "deleted_at" IS NULL;
--> statement-breakpoint
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: Drizzle migrations run transactionally, so CONCURRENTLY is unavailable; the partial index initially contains no rows because the new column is null for every existing comment.
CREATE UNIQUE INDEX IF NOT EXISTS "issue_comments_issue_system_idempotency_idx"
	ON "issue_comments" USING btree ("issue_id", "idempotency_key")
	WHERE "idempotency_key" IS NOT NULL AND "author_agent_id" IS NULL AND "author_user_id" IS NULL AND "deleted_at" IS NULL;
