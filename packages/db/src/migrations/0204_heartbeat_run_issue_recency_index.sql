-- Recovery and liveness paths fetch the newest heartbeat run for one issue
-- through context_snapshot ->> 'issueId'.  The older company/issue index does
-- not cover the recency ordering, so PostgreSQL can choose the company-wide
-- created_at index and detoast/filter thousands of JSONB rows before LIMIT 1.
-- Keep the expression identical to the deployed queries so every legacy
-- callsite benefits without a behavioral change.
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: Drizzle migrations run transactionally, so CONCURRENTLY is unavailable; production can precreate this exact idempotent index online before rollout.
CREATE INDEX IF NOT EXISTS "heartbeat_runs_company_context_issue_created_desc_idx"
  ON "heartbeat_runs" USING btree (
    "company_id",
    (("context_snapshot" ->> 'issueId')),
    "created_at" DESC,
    "id" DESC
  )
  WHERE ("context_snapshot" ->> 'issueId') IS NOT NULL;
