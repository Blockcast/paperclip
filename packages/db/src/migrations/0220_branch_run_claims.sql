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
  "release_pending_at" timestamp with time zone,
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
-- 0128_external_runtime_reservations.sql -- including, deliberately, its
-- TWO-PHASE shape.
--
-- The distinction that matters (BLO-21602, Ally round-3 Important #2): a
-- terminal *status* is not a gone *worker*. Cancellation, timeout and
-- interruption are imposed from OUTSIDE the run -- the row goes terminal
-- while the local process or K8s Job is still alive and may still be writing
-- to the branch. Releasing on those immediately hands the branch to a
-- sibling while the previous holder is mid-write, which is the very
-- divergent-commit hazard this table exists to prevent.
--
-- So:
--   * succeeded / failed / error / adapter_failed -- the worker reached this
--     state itself, so it is in teardown and no longer writing. Release now.
--   * cancelled / timed_out / interrupted -- externally imposed. Stamp
--     release_pending_at and KEEP the claim (released_at stays NULL, so the
--     partial unique index still holds the branch). acquireBranchRunClaim
--     supersedes it only once the holder is quiesced (its external runtime
--     reservation is gone) or its lease has expired -- a terminal run renews
--     nothing, so the lease bounds this and the branch cannot deadlock.
CREATE OR REPLACE FUNCTION release_branch_run_claim_for_terminal_run()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status THEN
    IF NEW.status IN ('succeeded', 'failed', 'error', 'adapter_failed') THEN
      UPDATE branch_run_claims
      SET released_at = COALESCE(released_at, NEW.finished_at, now()),
          release_reason = COALESCE(release_reason, NEW.error_code, NEW.status),
          updated_at = now()
      WHERE heartbeat_run_id = NEW.id AND released_at IS NULL;
    ELSIF NEW.status IN ('cancelled', 'interrupted', 'timed_out') THEN
      UPDATE branch_run_claims
      SET release_pending_at = COALESCE(release_pending_at, NEW.finished_at, now()),
          release_reason = COALESCE(release_reason, NEW.error_code, NEW.status),
          updated_at = now()
      WHERE heartbeat_run_id = NEW.id AND released_at IS NULL;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER heartbeat_runs_release_branch_run_claim
AFTER UPDATE OF status ON heartbeat_runs
FOR EACH ROW
EXECUTE FUNCTION release_branch_run_claim_for_terminal_run();
