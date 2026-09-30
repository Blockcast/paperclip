ALTER TABLE "issue_recovery_actions"
  ADD COLUMN IF NOT EXISTS "non_delivery_sweep_count" integer NOT NULL DEFAULT 0;

ALTER TABLE "issue_recovery_actions"
  ADD COLUMN IF NOT EXISTS "retiring_bound" text;

-- BLO-19124: backfill rows retired before this column existed. Every pre-existing
-- `escalated` row was written by `escalateExpiredWakeHorizons`, which is the only writer of
-- that status on master (`issue-recovery-actions.ts:735`) and sets it solely on burning the
-- creation-anchored horizon — so `timeout_horizon` is what retired all of them.
--
-- Without this they stay `escalated` with a NULL bound, which is a shape no code can repair:
-- the retire paths advance `active -> escalated`, so they match zero rows for a row already
-- there, while `isNull(retiring_bound)` keeps admitting it as a backstop candidate on every
-- future sweep. The row is never retired and `exhaustedSkipped` climbs forever.
--
-- Idempotent by predicate, and it cannot mislabel a row retired by any other bound: the
-- three bounds that are not `timeout_horizon` are all written by code added in this same PR,
-- which has never run against this data.
UPDATE "issue_recovery_actions"
   SET "retiring_bound" = 'timeout_horizon'
 WHERE "status" = 'escalated'
   AND "retiring_bound" IS NULL;
