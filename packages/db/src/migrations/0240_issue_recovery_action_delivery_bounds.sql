ALTER TABLE "issue_recovery_actions"
  ADD COLUMN IF NOT EXISTS "non_delivery_sweep_count" integer NOT NULL DEFAULT 0;

ALTER TABLE "issue_recovery_actions"
  ADD COLUMN IF NOT EXISTS "retiring_bound" text;
