import { describe, expect, it } from "vitest";
import {
  isInconclusiveWorkspaceGitProbe,
  WORKSPACE_VALIDATION_RECOVERY_CAUSE,
  workspaceValidationRecoveryCause,
} from "./workspace-validation-probe.js";

// BLO-19924. The decision under test is which workspace-validation parks keep the
// no-wake `manual_repair_required` shape. Getting this wrong in the permissive
// direction (treating a confirmed checkout as inconclusive) would hand a genuinely
// unsafe clone source a retry loop; getting it wrong in the restrictive direction
// (treating an unanswered probe as confirmed) is the defect this fixes — 132 rows
// latched with no wake, no horizon and no attempt budget.
describe("isInconclusiveWorkspaceGitProbe", () => {
  it("returns true only for a probe that failed to reach a verdict", () => {
    expect(isInconclusiveWorkspaceGitProbe({
      reason: "k8s_agent_home_git_bootstrap_unsupported",
      gitProbeState: "indeterminate",
    })).toBe(true);
  });

  it("keeps the manual-repair shape for a CONFIRMED checkout", () => {
    // The hazard the dispatch guard exists for: a real repository under the
    // fallback cwd. Removing it is a repair only a human/agent can perform, so
    // this must NOT be handed back to the bounded-wake path.
    expect(isInconclusiveWorkspaceGitProbe({
      reason: "k8s_agent_home_git_bootstrap_unsupported",
      gitProbeState: "checkout",
    })).toBe(false);
  });

  it("keeps the manual-repair shape for the managed-worktree reasons", () => {
    // These carry no gitProbeState at all — they are configuration faults, not
    // unanswered probes. An `undefined` gitProbeState must not read as inconclusive.
    expect(isInconclusiveWorkspaceGitProbe({
      reason: "git_worktree_base_not_git_checkout",
    })).toBe(false);
    expect(isInconclusiveWorkspaceGitProbe({
      reason: "git_worktree_branch_incoherence",
    })).toBe(false);
  });

  it("does not treat a missing or empty payload as inconclusive", () => {
    expect(isInconclusiveWorkspaceGitProbe(null)).toBe(false);
    expect(isInconclusiveWorkspaceGitProbe(undefined)).toBe(false);
    expect(isInconclusiveWorkspaceGitProbe({})).toBe(false);
  });

  it("does not match on a non-string or near-miss probe state", () => {
    // Guards the equality against a widening to a truthiness or substring test,
    // either of which would pull "not_a_checkout" into the inconclusive bucket.
    expect(isInconclusiveWorkspaceGitProbe({ gitProbeState: "not_a_checkout" })).toBe(false);
    expect(isInconclusiveWorkspaceGitProbe({ gitProbeState: "INDETERMINATE" })).toBe(false);
    expect(isInconclusiveWorkspaceGitProbe({ gitProbeState: true })).toBe(false);
  });
});

describe("workspaceValidationRecoveryCause", () => {
  it("drops the no-wake cause for an unanswered probe and keeps it otherwise", () => {
    // `undefined` is not "no opinion" — it is the instruction to fall through to the
    // ordinary stranded cause, which is the only one carrying a wake and an attempt
    // budget. Both heartbeat.ts park sites route through here.
    expect(workspaceValidationRecoveryCause({ gitProbeState: "indeterminate" })).toBeUndefined();
    expect(workspaceValidationRecoveryCause({ gitProbeState: "checkout" }))
      .toBe(WORKSPACE_VALIDATION_RECOVERY_CAUSE);
    expect(workspaceValidationRecoveryCause(null)).toBe(WORKSPACE_VALIDATION_RECOVERY_CAUSE);
  });
});
