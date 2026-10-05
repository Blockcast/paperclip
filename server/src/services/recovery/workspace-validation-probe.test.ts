import { describe, expect, it } from "vitest";
import {
  isConfirmedWorkspaceGitHazard,
  WORKSPACE_VALIDATION_RECOVERY_CAUSE,
  workspaceValidationRecoveryCause,
} from "./workspace-validation-probe.js";

// BLO-19924. The decision under test is which workspace-validation parks keep the
// no-wake `manual_repair_required` shape. Getting this wrong in the permissive
// direction (treating a confirmed checkout as inconclusive) would hand a genuinely
// unsafe clone source a retry loop; getting it wrong in the restrictive direction
// (treating an unanswered probe as confirmed) is the defect this fixes — 132 rows
// latched with no wake, no horizon and no attempt budget.
describe("isConfirmedWorkspaceGitHazard", () => {
  it("keeps the manual-repair shape for a CONFIRMED checkout", () => {
    // The hazard the dispatch guard exists for: a real repository under the
    // fallback cwd. Removing it is a repair only a human/agent can perform, so
    // this must NOT be handed back to the bounded-wake path.
    expect(isConfirmedWorkspaceGitHazard({
      reason: "k8s_agent_home_git_bootstrap_unsupported",
      gitProbeState: "checkout",
    })).toBe(true);
  });

  it("does not confirm a probe that failed to reach a verdict", () => {
    expect(isConfirmedWorkspaceGitHazard({
      reason: "k8s_agent_home_git_bootstrap_unsupported",
      gitProbeState: "indeterminate",
    })).toBe(false);
  });

  it("does not confirm the managed-worktree reasons", () => {
    // These carry no gitProbeState at all, and both are produced by helpers that
    // fail OPEN — isGitCheckout is `.catch(() => false)` with no timeout, and
    // inspectManagedGitWorktreeBranch turns each of four git exec failures into a
    // confirmed-sounding reasonCode. Neither can tell a configuration fault from
    // a dead probe, so neither may latch. An earlier revision asserted the
    // opposite here and pinned it as a passing test.
    expect(isConfirmedWorkspaceGitHazard({
      reason: "git_worktree_base_not_git_checkout",
    })).toBe(false);
    expect(isConfirmedWorkspaceGitHazard({
      reason: "git_worktree_branch_incoherence",
    })).toBe(false);
  });

  it("does not confirm a missing or empty payload", () => {
    expect(isConfirmedWorkspaceGitHazard(null)).toBe(false);
    expect(isConfirmedWorkspaceGitHazard(undefined)).toBe(false);
    expect(isConfirmedWorkspaceGitHazard({})).toBe(false);
  });

  it("does not match on a non-string or near-miss probe state", () => {
    // Guards the equality against a widening to a truthiness or substring test,
    // either of which would pull "not_a_checkout" back into the latching bucket.
    expect(isConfirmedWorkspaceGitHazard({ gitProbeState: "not_a_checkout" })).toBe(false);
    expect(isConfirmedWorkspaceGitHazard({ gitProbeState: "CHECKOUT" })).toBe(false);
    expect(isConfirmedWorkspaceGitHazard({ gitProbeState: true })).toBe(false);
  });
});

describe("workspaceValidationRecoveryCause", () => {
  it("keeps the no-wake cause only for a confirmed checkout", () => {
    // `undefined` is not "no opinion" — it is the instruction to fall through to the
    // ordinary stranded cause, which is the only one carrying a wake and an attempt
    // budget. Both heartbeat.ts park sites route through here.
    expect(workspaceValidationRecoveryCause({ gitProbeState: "checkout" }))
      .toBe(WORKSPACE_VALIDATION_RECOVERY_CAUSE);
    expect(workspaceValidationRecoveryCause({ gitProbeState: "indeterminate" })).toBeUndefined();
    // The allowlist direction: an unrecognised reason is unlatched by default, so a
    // park reason added later cannot silently inherit the no-wake shape.
    expect(workspaceValidationRecoveryCause({ reason: "git_worktree_branch_incoherence" }))
      .toBeUndefined();
    expect(workspaceValidationRecoveryCause(null)).toBeUndefined();
  });
});
