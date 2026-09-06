-- Approval-enforcement reconciler (BLO-24631).
--
-- Race backstop for the drift issues raised by
-- server/src/services/approval-enforcement-reconciler.ts. The sweep is a
-- worker-tier singleton but can run on several worker replicas at once, and
-- its raise path is check-then-insert; without this index two replicas that
-- both miss the existing row would each file a duplicate. Mirrors the
-- established recovery-origin indexes (harness_liveness, stale_active_run,
-- ccrotate_capacity, task_watchdog) directly above it.
--
-- Partial on the *open* population only: once the drift issue is done or
-- cancelled a later recurrence of the same approval's drift must be allowed to
-- file a fresh issue.
CREATE UNIQUE INDEX IF NOT EXISTS "issues_active_approval_enforcement_drift_uq"
  ON "issues" ("company_id", "origin_kind", "origin_id")
  WHERE "origin_kind" = 'approval_enforcement_drift'
    AND "origin_id" IS NOT NULL
    AND "hidden_at" IS NULL
    AND "status" NOT IN ('done', 'cancelled');
