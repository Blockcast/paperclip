import { describe, expect, it } from "vitest";

import {
  derivePaperclipPrReview,
  isNonPrimaryWorkspaceTarget,
  resolveK8sRunIsolationIdentity,
  resolveProjectPrimaryWorkspaceId,
  selectBindTimeProjectWorkspaceFallbackId,
} from "../services/heartbeat.js";
import {
  resolveProjectIdNeedingWorkspaceFallback,
  resolveWorkspaceWriterTreeKey,
  runUsesStatelessReviewWorkspace,
} from "../services/workspace-writer-key.js";

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

  describe("first run of an un-backfilled issue (BLO-37188)", () => {
    // `issue.projectWorkspaceId` is a RESULT of an issue's first run -- it is
    // backfilled from the realized workspace long after the reservation binds.
    // Keying on it alone therefore returned null on run 1 and left it
    // unexcluded on BOTH branches. The caller now resolves the workspace the
    // late path would pick and passes it as `projectWorkspaceFallbackId`.
    //
    // The property under test is not "run 1 gets a key" -- it is that run 1
    // gets THE SAME key as run 2, since a key that does not match the
    // backfilled run's excludes nothing.
    it("keys run 1 of a shared checkout identically to the backfilled run 2", () => {
      const runOne = resolveWorkspaceWriterTreeKey({
        statelessPrReview: false,
        runResolvesToOwnTree: false,
        usesPerRunScope: false,
        issue: { id: "issue-a", projectWorkspaceId: null },
        projectWorkspaceFallbackId: PW,
      });
      const runTwo = resolveWorkspaceWriterTreeKey({
        statelessPrReview: false,
        runResolvesToOwnTree: false,
        usesPerRunScope: false,
        issue: { id: "issue-a", projectWorkspaceId: PW },
      });

      expect(runOne).toBe(`project-primary:${PW}`);
      expect(runOne).toBe(runTwo);
    });

    it("also closes it on the own-tree branch, restoring BLO-31443 for run 1", () => {
      // The own-tree branch scopes the issue key by workspace, so an
      // un-backfilled run 1 keyed `no-project-workspace:issue-a` while run 2
      // keyed `pw-1:issue-a` -- two runs of ONE issue, one worktree, no
      // exclusion. Same root cause, same fallback fixes it.
      const runOne = resolveWorkspaceWriterTreeKey({
        statelessPrReview: false,
        runResolvesToOwnTree: true,
        usesPerRunScope: false,
        issue: { id: "issue-a", projectWorkspaceId: null },
        projectWorkspaceFallbackId: PW,
      });
      const runTwo = resolveWorkspaceWriterTreeKey({
        statelessPrReview: false,
        runResolvesToOwnTree: true,
        usesPerRunScope: false,
        issue: { id: "issue-a", projectWorkspaceId: PW },
      });

      expect(runOne).toBe(`${PW}:issue-a`);
      expect(runOne).toBe(runTwo);
    });

    it("never lets the fallback override an issue that HAS a workspace", () => {
      // The fallback is creation-order-first, which is only what the late path
      // picks when the issue names nothing. Once the issue names a workspace
      // that is authoritative, so a wrong fallback must not move the key off it.
      for (const runResolvesToOwnTree of [true, false]) {
        expect(resolveWorkspaceWriterTreeKey({
          statelessPrReview: false,
          runResolvesToOwnTree,
          usesPerRunScope: false,
          issue: { id: "issue-a", projectWorkspaceId: OTHER_PW },
          projectWorkspaceFallbackId: PW,
        })).toBe(runResolvesToOwnTree ? `${OTHER_PW}:issue-a` : `project-primary:${OTHER_PW}`);
      }
    });

    it("keeps the two exclusions intact under a fallback", () => {
      // A fallback must not resurrect a key for the two shapes that are
      // tree-unique by construction.
      for (const runResolvesToOwnTree of [true, false]) {
        expect(resolveWorkspaceWriterTreeKey({
          statelessPrReview: true,
          runResolvesToOwnTree,
          usesPerRunScope: false,
          issue: { id: "issue-a", projectWorkspaceId: null },
          projectWorkspaceFallbackId: PW,
        })).toBeNull();
      }
      expect(resolveWorkspaceWriterTreeKey({
        statelessPrReview: false,
        runResolvesToOwnTree: true,
        usesPerRunScope: true,
        issue: { id: "issue-a", projectWorkspaceId: null },
        projectWorkspaceFallbackId: PW,
      })).toBeNull();
    });
  });

  describe("the caller's side of BLO-37188: which runs get a fallback, and which row", () => {
    // Everything above hand-passes `projectWorkspaceFallbackId`. These pin the
    // two halves the dispatch path computes it from, because a fallback that
    // names the wrong row keys a tree the run never lands in -- worse than none.
    const firstRunOfFreshIssue = {
      statelessPrReview: false,
      issueProjectWorkspaceId: null,
      useProjectWorkspace: true,
      executionProjectId: "project-1",
    };

    it("asks for a fallback only for an un-backfilled, non-review, project-workspace run", () => {
      expect(resolveProjectIdNeedingWorkspaceFallback(firstRunOfFreshIssue)).toBe("project-1");
      // Stateless PR review keys null on both branches anyway: no query.
      expect(resolveProjectIdNeedingWorkspaceFallback({
        ...firstRunOfFreshIssue,
        statelessPrReview: true,
      })).toBeNull();
      // Backfilled: the issue's own id is authoritative, a fallback must not move it.
      expect(resolveProjectIdNeedingWorkspaceFallback({
        ...firstRunOfFreshIssue,
        issueProjectWorkspaceId: PW,
      })).toBeNull();
      // `agent_default`: `resolveWorkspaceForRun` gets `useProjectWorkspace:
      // false`, considers no rows, and lands in the agent home.
      expect(resolveProjectIdNeedingWorkspaceFallback({
        ...firstRunOfFreshIssue,
        useProjectWorkspace: false,
      })).toBeNull();
      expect(resolveProjectIdNeedingWorkspaceFallback({
        ...firstRunOfFreshIssue,
        executionProjectId: null,
      })).toBeNull();
    });

    it("names the row the late path tries first, NOT the isPrimary row", () => {
      // The fixture where the two helpers disagree: the earliest row is not the
      // flagged primary. With no preferred id the late path keeps every row a
      // candidate and tries them in creation order, so it lands in the earliest
      // -- and the bind-time key has to name that one.
      const rowsInCreationOrder = [
        { id: "ws-earliest", isPrimary: false },
        { id: "ws-flagged-primary", isPrimary: true },
      ];
      expect(isNonPrimaryWorkspaceTarget({
        preferredProjectWorkspaceId: null,
        rowsInCreationOrder,
      })).toBe(false);
      expect(selectBindTimeProjectWorkspaceFallbackId(rowsInCreationOrder)).toBe("ws-earliest");
      expect(resolveProjectPrimaryWorkspaceId(rowsInCreationOrder)).toBe("ws-flagged-primary");
      expect(selectBindTimeProjectWorkspaceFallbackId([])).toBeNull();
    });
  });

  it("returns null when there is nothing identifying the shared tree", () => {
    // What is LEFT after BLO-37188, and it is a safe case rather than a gap: a
    // run the caller resolved to NO project checkout, so it passes no fallback.
    // The main such shape is `agent_default`, which lands in the agent home
    // rather than any project tree -- and a null key there is correct, because
    // the resolver's `agent-shared:<agentId>` exit already names exactly that
    // equivalence class. A project with zero workspace rows lands here too.
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
      projectWorkspaceFallbackId: null,
    })).toBeNull();
  });
});

describe("the key reaches the reservation (end-to-end through the resolver)", () => {
  // The key above is only worth anything if `resolveK8sRunIsolationIdentity`
  // actually puts it on `reservationKey` -- that is the field bound to the
  // single-writer index. Asserting the key alone would pass even if the
  // resolver dropped it, which is how the shared-checkout case stayed broken.
  //
  // Parameterized over `effectiveMaxConcurrentRuns` deliberately. An earlier
  // revision hardcoded 3, which exercised only the `> 1` exit and hid a live
  // defect: the resolver DID drop the key at 1, which is the DEFAULT for every
  // external-lifecycle agent (`concurrencyEnabled` is false unless an operator
  // sets it, and `resolveExternalLifecycleConcurrency` then returns a hard 1).
  // The untested branch was the only branch that ships. Any new exit reachable
  // with `isWorkspaceIsolated: false` and no persisted workspace must be
  // exercised here. The other two exits are NOT reachable from this helper --
  // stateless PR review and the persisted-`workspace` exit both need inputs
  // this helper hardcodes; the latter is covered in
  // `heartbeat-external-lifecycle-concurrency-flag.test.ts`.
  const identityFor = (
    runId: string,
    treeKey: string | null,
    opts: { agentId?: string; effectiveMaxConcurrentRuns: number },
  ) =>
    resolveK8sRunIsolationIdentity({
      adapterType: "claude_k8s",
      runId,
      agentId: opts.agentId ?? "agent-1",
      statelessPrReview: false,
      isWorkspaceIsolated: false,
      persistedExecutionWorkspaceId: null,
      effectiveMaxConcurrentRuns: opts.effectiveMaxConcurrentRuns,
      perIssueWorkspaceTreeKey: treeKey,
    });

  const sharedCheckoutKey = (issueId: string) => resolveWorkspaceWriterTreeKey({
    statelessPrReview: false,
    runResolvesToOwnTree: false,
    usesPerRunScope: false,
    issue: { id: issueId, projectWorkspaceId: PW },
  });

  // 1 is the default posture; 3 is an operator who opted into concurrency.
  for (const effectiveMaxConcurrentRuns of [1, 3]) {
    describe(`effectiveMaxConcurrentRuns: ${effectiveMaxConcurrentRuns}`, () => {
      it("two shared-checkout runs land on ONE reservationKey", () => {
        const treeKey = sharedCheckoutKey("issue-a");
        const first = identityFor("run-1", treeKey, { effectiveMaxConcurrentRuns });
        const second = identityFor("run-2", treeKey, { effectiveMaxConcurrentRuns });

        expect(first?.reservationKey).toBe(`workspace-tree:project-primary:${PW}`);
        expect(first?.reservationKey).toBe(second?.reservationKey);
        // isolationKey stays private: it gates saved-session resume and names
        // the run's own roots, so widening it would let a run resume a session
        // that is not under its own sessionRoot. At concurrency 1 it stays
        // agent-scoped, which is what keeps the warm shared home/session roots.
        expect(first?.isolationKey).toBe(
          effectiveMaxConcurrentRuns > 1 ? "run:run-1" : "agent-shared:agent-1",
        );
      });

      it("excludes TWO DIFFERENT AGENTS sharing one project checkout", () => {
        // BLO-19422's headline case, and the one no earlier test covered. The
        // pre-fix keys were `agent-shared:A` / `agent-shared:B` -- distinct,
        // both admitted by the writer index, both writing one directory.
        // Different issues too, because that is the measured shape: the
        // project checkout is shared across issues AND across agents.
        const first = identityFor("run-1", sharedCheckoutKey("issue-a"), {
          agentId: "agent-1",
          effectiveMaxConcurrentRuns,
        });
        const second = identityFor("run-2", sharedCheckoutKey("issue-b"), {
          agentId: "agent-2",
          effectiveMaxConcurrentRuns,
        });

        expect(first?.reservationKey).toBe(second?.reservationKey);
      });

      it("keeps different project workspaces independent across agents", () => {
        // The other half of the contract: serializing runs that do NOT share a
        // directory would be a throughput regression, not a fix.
        const first = identityFor("run-1", `project-primary:${PW}`, {
          agentId: "agent-1",
          effectiveMaxConcurrentRuns,
        });
        const second = identityFor("run-2", `project-primary:${OTHER_PW}`, {
          agentId: "agent-2",
          effectiveMaxConcurrentRuns,
        });

        expect(first?.reservationKey).not.toBe(second?.reservationKey);
      });

      it("excludes an un-backfilled FIRST run against a backfilled one (BLO-37188)", () => {
        // The end-to-end shape of the residual gap: two agents, one shared
        // checkout, and the issue driving run 1 has never resolved a workspace
        // so it carries no `projectWorkspaceId` yet. Run 1 keys off the
        // bind-time fallback, run 2 off the backfilled id, and the reservation
        // must see ONE key -- that is what makes the second run defer instead
        // of writing the tree the first is already in.
        const firstRunOfFreshIssue = resolveWorkspaceWriterTreeKey({
          statelessPrReview: false,
          runResolvesToOwnTree: false,
          usesPerRunScope: false,
          issue: { id: "issue-fresh", projectWorkspaceId: null },
          projectWorkspaceFallbackId: PW,
        });
        const first = identityFor("run-1", firstRunOfFreshIssue, {
          agentId: "agent-1",
          effectiveMaxConcurrentRuns,
        });
        const second = identityFor("run-2", sharedCheckoutKey("issue-b"), {
          agentId: "agent-2",
          effectiveMaxConcurrentRuns,
        });

        expect(first?.reservationKey).toBe(`workspace-tree:project-primary:${PW}`);
        expect(first?.reservationKey).toBe(second?.reservationKey);
      });

      it("regression: a null key leaves both runs writing one tree unexcluded", () => {
        // Pins the pre-fix behaviour as the thing being prevented. If a future
        // change makes resolveWorkspaceWriterTreeKey return null for the shared
        // checkout again, the tests above fail and this one explains why.
        //
        // At concurrency 1 both runs fall back to `agent-shared:<agentId>`, so
        // two runs of ONE agent still collide -- assert across agents, which is
        // the pairing that genuinely goes unexcluded on a null key.
        //
        // This asserts on the RESOLVER given a null key, and stays true after
        // BLO-37188: what that changed is which runs still PRODUCE a null key.
        // It is no longer the un-backfilled issue (see the test above) but a
        // run the caller resolves to no project checkout BEFORE realization
        // (chiefly `agent_default`) -- for which `agent-shared:<agentId>` is the
        // correct class, not a miss. A run whose project rows all fail to
        // realize also lands in the agent home but is NOT null-keyed; see the
        // residuals on `resolveWorkspaceWriterTreeKey`.
        const first = identityFor("run-1", null, {
          agentId: "agent-1",
          effectiveMaxConcurrentRuns,
        });
        const second = identityFor("run-2", null, {
          agentId: "agent-2",
          effectiveMaxConcurrentRuns,
        });
        expect(first?.reservationKey).not.toBe(second?.reservationKey);
      });
    });
  }
});

/**
 * BLO-42212: a HAND-FILED PR-review row must stop serializing behind the shared
 * `project_primary` writer.
 *
 * The lane shape these lock down: many review rows, all bound to ONE project
 * workspace (the BLO-40317 dispatch workaround), each waking `issue_assigned`
 * so `derivePaperclipPrReview` is null for it. Before the label every one of
 * them produced `project-primary:<pw>` and the lane ran one review at a time.
 */
describe("runUsesStatelessReviewWorkspace (BLO-42212)", () => {
  const REVIEW_LABELS = ["stateless-review"];

  it("is true for a webhook review with no labels at all", () => {
    expect(runUsesStatelessReviewWorkspace({ webhookPrReview: true, issueLabelNames: null })).toBe(true);
  });

  it("is true for a hand-filed row carrying the label and NO webhook context", () => {
    // The whole point: `webhookPrReview` is false here, as it is for every
    // `issue_assigned` review row.
    expect(runUsesStatelessReviewWorkspace({ webhookPrReview: false, issueLabelNames: REVIEW_LABELS }))
      .toBe(true);
  });

  it("is false for an ordinary row, so the exclusion is NOT dropped by default", () => {
    // The failure direction that matters. If this ever returns true for an
    // unlabelled row, every shared-checkout run loses its writer key and
    // BLO-19422 is back.
    expect(runUsesStatelessReviewWorkspace({ webhookPrReview: false, issueLabelNames: ["backend", "infra"] }))
      .toBe(false);
    expect(runUsesStatelessReviewWorkspace({ webhookPrReview: false, issueLabelNames: null })).toBe(false);
  });

  it("does not match a label that merely CONTAINS the marker as a substring", () => {
    expect(
      runUsesStatelessReviewWorkspace({
        webhookPrReview: false,
        issueLabelNames: ["stateless-review-candidate", "needs-stateless-review"],
      }),
    ).toBe(false);
  });

  it("drops the writer key, so two labelled reviews on ONE project workspace stop colliding", () => {
    // End-to-end through the key: this is the measured defect and its fix in
    // one assertion pair. Same project workspace, two different review rows.
    const keyFor = (issueId: string, labelNames: string[]) =>
      resolveWorkspaceWriterTreeKey({
        statelessPrReview: runUsesStatelessReviewWorkspace({
          webhookPrReview: false,
          issueLabelNames: labelNames,
        }),
        runResolvesToOwnTree: false,
        usesPerRunScope: false,
        issue: { id: issueId, projectWorkspaceId: PW },
      });

    // Unlabelled: the measured 2026-10-09 state -- one key, one writer, a
    // serialized lane.
    expect(keyFor("review-a", [])).toBe(`project-primary:${PW}`);
    expect(keyFor("review-a", [])).toBe(keyFor("review-b", []));

    // Labelled: no key at all, because the run no longer lands in that tree.
    expect(keyFor("review-a", REVIEW_LABELS)).toBeNull();
    expect(keyFor("review-b", REVIEW_LABELS)).toBeNull();
  });

  it("keeps the label from leaking into webhook-trusted PR-review context", () => {
    // BLO-9293 guard, stated as a test so the cheap wrong fix is visibly out of
    // bounds: the label may widen ISOLATION and must never make
    // `derivePaperclipPrReview` non-null, because the reviewer-output gate
    // trusts that object's `prAuthorLogin` as signed webhook data. A context
    // that only carries a label-shaped hint must still derive to null.
    //
    // Every fixture carries `githubPrNumber`: without it `derivePaperclipPrReview`
    // returns null at its `prNumber === null` check whatever the label logic
    // does, so a widening on `labels`/`reviewKind` would pass this test
    // unnoticed. The positive control proves the fixture is otherwise complete
    // -- it derives non-null the moment a TRUSTED signal is present.
    const prNumber = { githubPrNumber: 2416 };
    expect(derivePaperclipPrReview({ wakeReason: "issue_assigned", reviewKind: "pr_review", ...prNumber }))
      .not.toBeNull();
    expect(derivePaperclipPrReview({ wakeReason: "issue_assigned", labels: REVIEW_LABELS, ...prNumber })).toBeNull();
    expect(derivePaperclipPrReview({ wakeReason: "issue_assigned", reviewKind: "stateless-review", ...prNumber }))
      .toBeNull();
  });
});
