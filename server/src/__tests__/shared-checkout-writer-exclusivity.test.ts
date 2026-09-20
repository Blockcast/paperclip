import { describe, expect, it } from "vitest";

import {
  resolveK8sRunIsolationIdentity,
} from "../services/heartbeat.js";
import { resolveWorkspaceWriterTreeKey } from "../services/workspace-writer-key.js";

/**
 * BLO-19422: two concurrent runs that resolve to the SAME on-disk checkout must
 * not both hold a writer reservation.
 *
 * The single-writer guarantee is an index on `external_runtime_reservations`
 * (`..._active_isolation_writer_idx`) keyed by the reservation key, so the whole
 * property reduces to: do two runs sharing a tree produce the SAME key? These
 * tests assert on the key rather than on the index, because the key derivation
 * is the half that was wrong -- the index has worked correctly throughout.
 *
 * The defect these lock down: every arm of the original predicate required
 * isolation or a git worktree, so a `project_primary` (shared project checkout)
 * run produced a null key and fell through to `run:<runId>` -- unique per run.
 * Two such runs held distinct keys and both wrote one directory.
 */

const PW = "pw-1";
const OTHER_PW = "pw-2";

describe("resolveWorkspaceWriterTreeKey", () => {
  describe("shared project checkout (project_primary) — the BLO-19422 defect", () => {
    it("gives two DIFFERENT issues sharing one project checkout the SAME key", () => {
      // This is the exact measured shape: `shared_workspace` mode, no worktree,
      // two issues, one directory. Before the fix both sides were null.
      const a = resolveWorkspaceWriterTreeKey({
        statelessPrReview: false,
        runResolvesToOwnTree: false,
        usesPerRunScope: false,
        issue: { id: "issue-a", projectWorkspaceId: PW },
      });
      const b = resolveWorkspaceWriterTreeKey({
        statelessPrReview: false,
        runResolvesToOwnTree: false,
        usesPerRunScope: false,
        issue: { id: "issue-b", projectWorkspaceId: PW },
      });

      expect(a).not.toBeNull();
      expect(a).toBe(b);
    });

    it("does NOT key on the issue, so the key cannot vary per issue", () => {
      // Guards the specific wrong fix: reusing the own-tree `pw:issue` form here
      // would look plausible, pass a naive "key is non-null" test, and still let
      // two issues write one tree.
      const key = resolveWorkspaceWriterTreeKey({
        statelessPrReview: false,
        runResolvesToOwnTree: false,
        usesPerRunScope: false,
        issue: { id: "issue-a", projectWorkspaceId: PW },
      });
      expect(key).not.toContain("issue-a");
      expect(key).toBe(`project-primary:${PW}`);
    });

    it("keeps DIFFERENT project workspaces independent", () => {
      const a = resolveWorkspaceWriterTreeKey({
        statelessPrReview: false,
        runResolvesToOwnTree: false,
        usesPerRunScope: false,
        issue: { id: "issue-a", projectWorkspaceId: PW },
      });
      const b = resolveWorkspaceWriterTreeKey({
        statelessPrReview: false,
        runResolvesToOwnTree: false,
        usesPerRunScope: false,
        issue: { id: "issue-a", projectWorkspaceId: OTHER_PW },
      });
      expect(a).not.toBe(b);
    });

    it("still collides when a per_run runScope sits on a NON-worktree strategy", () => {
      // `per_run` appends a run token to the BRANCH, so it only makes a run
      // tree-unique when a worktree is actually cut. Under project_primary no
      // branch is derived, the runs share the base checkout anyway, and
      // excluding them here would reopen the defect for exactly that config.
      const a = resolveWorkspaceWriterTreeKey({
        statelessPrReview: false,
        runResolvesToOwnTree: false,
        usesPerRunScope: true,
        issue: { id: "issue-a", projectWorkspaceId: PW },
      });
      const b = resolveWorkspaceWriterTreeKey({
        statelessPrReview: false,
        runResolvesToOwnTree: false,
        usesPerRunScope: true,
        issue: { id: "issue-b", projectWorkspaceId: PW },
      });
      expect(a).toBe(`project-primary:${PW}`);
      expect(a).toBe(b);
    });
  });

  describe("own tree (worktree / isolated / reused) — unchanged by BLO-19422", () => {
    it("keys on the issue so two issues do NOT serialize", () => {
      const a = resolveWorkspaceWriterTreeKey({
        statelessPrReview: false,
        runResolvesToOwnTree: true,
        usesPerRunScope: false,
        issue: { id: "issue-a", projectWorkspaceId: PW },
      });
      const b = resolveWorkspaceWriterTreeKey({
        statelessPrReview: false,
        runResolvesToOwnTree: true,
        usesPerRunScope: false,
        issue: { id: "issue-b", projectWorkspaceId: PW },
      });
      expect(a).toBe(`${PW}:issue-a`);
      expect(a).not.toBe(b);
    });

    it("collides for two runs of ONE issue (the BLO-31443 guarantee)", () => {
      const of = (id: string) => resolveWorkspaceWriterTreeKey({
        statelessPrReview: false,
        runResolvesToOwnTree: true,
        usesPerRunScope: false,
        issue: { id, projectWorkspaceId: PW },
      });
      expect(of("issue-a")).toBe(of("issue-a"));
    });

    it("does not key a per_run run, which is tree-unique by construction", () => {
      expect(resolveWorkspaceWriterTreeKey({
        statelessPrReview: false,
        runResolvesToOwnTree: true,
        usesPerRunScope: true,
        issue: { id: "issue-a", projectWorkspaceId: PW },
      })).toBeNull();
    });
  });

  it("never keys a stateless PR review, on either branch", () => {
    for (const runResolvesToOwnTree of [true, false]) {
      expect(resolveWorkspaceWriterTreeKey({
        statelessPrReview: true,
        runResolvesToOwnTree,
        usesPerRunScope: false,
        issue: { id: "issue-a", projectWorkspaceId: PW },
      })).toBeNull();
    }
  });

  it("returns null when there is nothing identifying the shared tree", () => {
    // An unscoped run has no project workspace, so there is no shared project
    // checkout to exclude on. Keying it would serialize unrelated runs.
    expect(resolveWorkspaceWriterTreeKey({
      statelessPrReview: false,
      runResolvesToOwnTree: false,
      usesPerRunScope: false,
      issue: null,
    })).toBeNull();
    expect(resolveWorkspaceWriterTreeKey({
      statelessPrReview: false,
      runResolvesToOwnTree: false,
      usesPerRunScope: false,
      issue: { id: "issue-a", projectWorkspaceId: null },
    })).toBeNull();
  });
});

describe("the key reaches the reservation (end-to-end through the resolver)", () => {
  // The key above is only worth anything if `resolveK8sRunIsolationIdentity`
  // actually puts it on `reservationKey` -- that is the field bound to the
  // single-writer index. Asserting the key alone would pass even if the
  // resolver dropped it, which is how the shared-checkout case stayed broken.
  const identityFor = (runId: string, treeKey: string | null) =>
    resolveK8sRunIsolationIdentity({
      adapterType: "claude_k8s",
      runId,
      agentId: "agent-1",
      statelessPrReview: false,
      isWorkspaceIsolated: false,
      persistedExecutionWorkspaceId: null,
      effectiveMaxConcurrentRuns: 3,
      perIssueWorkspaceTreeKey: treeKey,
    });

  it("two shared-checkout runs land on ONE reservationKey", () => {
    const treeKey = resolveWorkspaceWriterTreeKey({
      statelessPrReview: false,
      runResolvesToOwnTree: false,
      usesPerRunScope: false,
      issue: { id: "issue-a", projectWorkspaceId: PW },
    });
    const first = identityFor("run-1", treeKey);
    const second = identityFor("run-2", treeKey);

    expect(first?.reservationKey).toBe(`workspace-tree:project-primary:${PW}`);
    expect(first?.reservationKey).toBe(second?.reservationKey);
    // isolationKey stays run-private: it gates saved-session resume and names
    // the run's own ephemeral roots, so widening it would let a run resume a
    // session that is not under its own sessionRoot.
    expect(first?.isolationKey).not.toBe(second?.isolationKey);
  });

  it("regression: a null key leaves both runs writing one tree unexcluded", () => {
    // Pins the pre-fix behaviour as the thing being prevented. If a future
    // change makes resolveWorkspaceWriterTreeKey return null for the shared
    // checkout again, the test above fails and this one explains why.
    const first = identityFor("run-1", null);
    const second = identityFor("run-2", null);
    expect(first?.reservationKey).not.toBe(second?.reservationKey);
  });
});
