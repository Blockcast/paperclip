CREATE INDEX IF NOT EXISTS "execution_workspaces_cleanup_eligible_idx"
  ON "execution_workspaces" ("company_id", "cleanup_eligible_at", "id");

CREATE INDEX IF NOT EXISTS "execution_workspaces_cleanup_owner_run_idx"
  ON "execution_workspaces" (("metadata" ->> 'cleanupOwnerRunId'))
  WHERE "metadata" ->> 'cleanupOwnerRunId' IS NOT NULL;
