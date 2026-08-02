ALTER TABLE "approvals" ADD COLUMN IF NOT EXISTS "idempotency_key" text;
--> statement-breakpoint
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: Drizzle migrations run transactionally, so CONCURRENTLY is unavailable; the partial index initially contains no rows because the new column is null for every existing approval.
CREATE UNIQUE INDEX IF NOT EXISTS "approvals_company_agent_idempotency_idx"
	ON "approvals" USING btree ("company_id", "requested_by_agent_id", "idempotency_key")
	WHERE "idempotency_key" IS NOT NULL AND "requested_by_agent_id" IS NOT NULL AND "status" IN ('pending', 'revision_requested');
--> statement-breakpoint
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: Drizzle migrations run transactionally, so CONCURRENTLY is unavailable; the partial index initially contains no rows because the new column is null for every existing approval.
CREATE UNIQUE INDEX IF NOT EXISTS "approvals_company_user_idempotency_idx"
	ON "approvals" USING btree ("company_id", "requested_by_user_id", "idempotency_key")
	WHERE "idempotency_key" IS NOT NULL AND "requested_by_user_id" IS NOT NULL AND "status" IN ('pending', 'revision_requested');
--> statement-breakpoint
-- Supports the cheap existence check: filtering pending approvals by requester without
-- reading the payload column. The list endpoint's summary view is the intended caller.
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: Drizzle migrations run transactionally, so CONCURRENTLY is unavailable; the approvals table is small (low hundreds of rows).
CREATE INDEX IF NOT EXISTS "approvals_company_status_requested_by_agent_idx"
	ON "approvals" USING btree ("company_id", "status", "requested_by_agent_id");
