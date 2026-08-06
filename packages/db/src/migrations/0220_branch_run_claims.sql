CREATE TABLE "branch_run_claims" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "branch_key" text NOT NULL,
  "execution_workspace_id" uuid REFERENCES "execution_workspaces"("id") ON DELETE SET NULL,
  "issue_id" uuid NOT NULL REFERENCES "issues"("id") ON DELETE CASCADE,
  "heartbeat_run_id" uuid NOT NULL REFERENCES "heartbeat_runs"("id") ON DELETE CASCADE,
  "agent_id" uuid NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  "acquired_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "last_renewed_at" timestamp with time zone DEFAULT now() NOT NULL,
  "released_at" timestamp with time zone,
  "release_reason" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- One active claim per branch/PR across ALL issues in a company, not per
-- issue. This is the primitive missing per BLO-21602: a parent and child
-- issue whose runs both resolve to the same execution-workspace branch must
-- collide here even though each holds a perfectly valid issue-scoped
-- checkoutRunId/executionRunId on its own row.
CREATE UNIQUE INDEX "branch_run_claims_active_branch_idx"
  ON "branch_run_claims" ("company_id", "branch_key")
  WHERE "released_at" IS NULL;
CREATE INDEX "branch_run_claims_active_run_idx"
  ON "branch_run_claims" ("heartbeat_run_id")
  WHERE "released_at" IS NULL;
CREATE INDEX "branch_run_claims_active_expiry_idx"
  ON "branch_run_claims" ("expires_at")
  WHERE "released_at" IS NULL;

-- Authoritative release path: fires even if the process holding the claim is
-- killed before it can call releaseBranchRunClaim(), so a dead run can never
-- deadlock the branch. Mirrors
-- release_external_runtime_reservation_for_terminal_run() from
-- 0128_external_runtime_reservations.sql. Uses the same terminal-status set
-- as TERMINAL_HEARTBEAT_RUN_STATUSES (server/src/services/issues.ts) so this
-- stays consistent with the existing issue-lock stale-lock sweeper.
CREATE OR REPLACE FUNCTION release_branch_run_claim_for_terminal_run()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status IN ('succeeded', 'interrupted', 'failed', 'error', 'adapter_failed', 'cancelled', 'timed_out')
     AND OLD.status IS DISTINCT FROM NEW.status THEN
    UPDATE branch_run_claims
    SET released_at = COALESCE(released_at, NEW.finished_at, now()),
        release_reason = COALESCE(release_reason, NEW.error_code, NEW.status),
        updated_at = now()
    WHERE heartbeat_run_id = NEW.id AND released_at IS NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER heartbeat_runs_release_branch_run_claim
AFTER UPDATE OF status ON heartbeat_runs
FOR EACH ROW
EXECUTE FUNCTION release_branch_run_claim_for_terminal_run();
