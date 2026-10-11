import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ensureManagedCheckoutCanServeClones,
  REMOTE_ORIGIN_PARTIAL_CLONE_FILTER_KEY,
  REMOTE_ORIGIN_PROMISOR_KEY,
} from "../managed-checkout-partial-clone.js";
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

  it("keeps the manual-repair shape for a CONFIRMED branch divergence", () => {
    // BLO-32628 branch containment. `ancestryVerdict: "diverged"` is exit 1 from
    // `git merge-base --is-ancestor` — the probe answered, with two resolved head
    // SHAs on the payload. Deleting this case is what broke the two
    // heartbeat-workspace-branch-containment.test.ts cases on master.
    expect(isConfirmedWorkspaceGitHazard({
      reason: "git_worktree_branch_incoherence",
      provenance: {
        ancestryVerdict: "diverged",
        expectedHeadSha: "a".repeat(40),
        actualHeadSha: "b".repeat(40),
        sameHead: false,
      },
    })).toBe(true);
  });

  it("does not confirm a branch incoherence whose ancestry probe did not answer", () => {
    // `getGitWorktreeBranchAncestryVerdict` maps a missing SHA, a `.catch`ed exec
    // failure and any unexpected exit code all to "unknown". This is the case that
    // makes `reason === "git_worktree_branch_incoherence"` an unsound predicate:
    // same reason, same producer, no verdict.
    expect(isConfirmedWorkspaceGitHazard({
      reason: "git_worktree_branch_incoherence",
      provenance: { ancestryVerdict: "unknown", expectedHeadSha: null, actualHeadSha: null },
    })).toBe(false);
    expect(isConfirmedWorkspaceGitHazard({
      reason: "git_worktree_branch_incoherence",
      provenance: { ancestryVerdict: "ancestor" },
    })).toBe(false);
  });

  it("does not confirm the finalize-path managed-worktree reasons", () => {
    // These carry no gitProbeState AND no provenance, and both are produced by
    // helpers that fail OPEN — isGitCheckout is `.catch(() => false)` with no
    // timeout, and inspectManagedGitWorktreeBranch turns each of four git exec
    // failures into a confirmed-sounding reasonCode. Neither can tell a
    // configuration fault from a dead probe, so neither may latch. Note the
    // second payload shares its `reason` with the confirmed case above: the
    // verdict is the discriminator, not the reason.
    expect(isConfirmedWorkspaceGitHazard({
      reason: "git_worktree_base_not_git_checkout",
    })).toBe(false);
    expect(isConfirmedWorkspaceGitHazard({
      reason: "git_worktree_branch_incoherence",
      managedGitWorktreeBranch: { reasonCode: "branch_mismatch", actualBranchName: null },
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

  it("does not read a verdict off a non-object or array provenance", () => {
    // `provenance` arrives from a persisted resultJson blob, so it is only
    // typed by convention. Guards the lookup against a truthiness test.
    expect(isConfirmedWorkspaceGitHazard({ provenance: "diverged" })).toBe(false);
    expect(isConfirmedWorkspaceGitHazard({ provenance: ["diverged"] })).toBe(false);
    expect(isConfirmedWorkspaceGitHazard({ provenance: null })).toBe(false);
    expect(isConfirmedWorkspaceGitHazard({ ancestryVerdict: "diverged" })).toBe(false);
  });
});

describe("workspaceValidationRecoveryCause", () => {
  it("keeps the no-wake cause only for a positively confirmed hazard", () => {
    // `undefined` is not "no opinion" — it is the instruction to fall through to the
    // ordinary stranded cause, which is the only one carrying a wake and an attempt
    // budget. Both heartbeat.ts park sites route through here.
    expect(workspaceValidationRecoveryCause({ gitProbeState: "checkout" }))
      .toBe(WORKSPACE_VALIDATION_RECOVERY_CAUSE);
    expect(workspaceValidationRecoveryCause({ provenance: { ancestryVerdict: "diverged" } }))
      .toBe(WORKSPACE_VALIDATION_RECOVERY_CAUSE);
    expect(workspaceValidationRecoveryCause({ gitProbeState: "indeterminate" })).toBeUndefined();
    // The allowlist direction: the verdict decides, not the reason, so the same
    // reason falls through whenever no probe answered — and a park reason added
    // later cannot silently inherit the no-wake shape.
    expect(workspaceValidationRecoveryCause({ reason: "git_worktree_branch_incoherence" }))
      .toBeUndefined();
    expect(workspaceValidationRecoveryCause({
      reason: "git_worktree_branch_incoherence",
      provenance: { ancestryVerdict: "unknown" },
    })).toBeUndefined();
    expect(workspaceValidationRecoveryCause(null)).toBeUndefined();
  });
});

describe("managed_checkout_partial_clone_unservable", () => {
  it("is excluded from the no-wake cause on purpose, pinned against the real producer", async () => {
    // A confirmed hazard by construction (`partial_cannot_serve` only when
    // `missing.count > 0`), but excluded deliberately: the no-wake shape is a
    // permanent silent strand, the worst outcome for a mirror a human must
    // repair. It takes the ordinary stranded cause instead. The payload is built
    // from the producer's own evidence, assembled as the throw in
    // `ensureManagedProjectWorkspace` (heartbeat.ts) assembles it, so a producer
    // change that adds `gitProbeState` or `provenance` turns this red.
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "wvp-partial-clone-"));
    try {
      await fs.mkdir(path.join(cwd, ".git"));
      const result = await ensureManagedCheckoutCanServeClones({
        cwd,
        runGit: async (args) => {
          if (args.join(" ") === `config --get ${REMOTE_ORIGIN_PARTIAL_CLONE_FILTER_KEY}`) return "blob:none\n";
          if (args.join(" ") === `config --get ${REMOTE_ORIGIN_PROMISOR_KEY}`) return "true\n";
          throw new Error(`unexpected git ${args.join(" ")}`);
        },
        countMissing: async () => ({ count: 3, truncated: false }),
      });
      expect(result.state).toBe("partial_cannot_serve");

      const payload = {
        reason: "managed_checkout_partial_clone_unservable",
        companyId: "company-1",
        projectId: "project-1",
        repoUrl: "https://example.com/repo.git",
        ...result.evidence,
      };
      expect(payload).not.toHaveProperty("gitProbeState");
      expect(payload).not.toHaveProperty("provenance");
      expect(isConfirmedWorkspaceGitHazard(payload)).toBe(false);
      expect(workspaceValidationRecoveryCause(payload)).toBeUndefined();
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});
