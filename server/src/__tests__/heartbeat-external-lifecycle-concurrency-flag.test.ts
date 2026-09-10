import { describe, expect, it } from "vitest";
import {
  buildK8sRunIsolationDescriptor,
  resolveExternalLifecycleConcurrency,
  resolveHeartbeatPolicyForRuntimeConfig,
  resolveK8sRunIsolationIdentity,
  scopeSessionParamsToIsolation,
  sessionParamsMatchIsolation,
} from "../services/heartbeat.ts";

// Regression coverage for BLO-15959: bounded external-lifecycle concurrency
// must default to the pre-existing one-run-per-agent containment, and only
// admit more when an agent explicitly opts in via `heartbeat.concurrencyEnabled`.
describe("resolveHeartbeatPolicyForRuntimeConfig: concurrencyEnabled", () => {
  it("defaults to disabled when heartbeat config omits it", () => {
    const policy = resolveHeartbeatPolicyForRuntimeConfig({ heartbeat: { maxConcurrentRuns: 5 } });
    expect(policy.concurrencyEnabled).toBe(false);
    expect(policy.maxConcurrentRuns).toBe(5);
  });

  it("defaults to disabled even under the aggressive preset", () => {
    const policy = resolveHeartbeatPolicyForRuntimeConfig({ heartbeat: { preset: "aggressive" } });
    expect(policy.concurrencyEnabled).toBe(false);
  });

  it("honors an explicit true", () => {
    const policy = resolveHeartbeatPolicyForRuntimeConfig({
      heartbeat: { maxConcurrentRuns: 5, concurrencyEnabled: true },
    });
    expect(policy.concurrencyEnabled).toBe(true);
  });

  it("treats a non-boolean value as disabled rather than throwing", () => {
    const policy = resolveHeartbeatPolicyForRuntimeConfig({
      heartbeat: { concurrencyEnabled: "true" as unknown as boolean },
    });
    expect(policy.concurrencyEnabled).toBe(false);
  });
});

describe("resolveExternalLifecycleConcurrency", () => {
  it("caps effective concurrency to exactly 1 by default, regardless of maxConcurrentRuns", () => {
    for (const maxConcurrentRuns of [1, 2, 5, 20, 50]) {
      const result = resolveExternalLifecycleConcurrency({ concurrencyEnabled: false, maxConcurrentRuns });
      expect(result).toEqual({ effectiveMaxConcurrentRuns: 1, concurrencyEnabled: false });
    }
  });

  it("uses maxConcurrentRuns when enabled and under the operational slot ceiling", () => {
    const result = resolveExternalLifecycleConcurrency({ concurrencyEnabled: true, maxConcurrentRuns: 15 });
    expect(result).toEqual({ effectiveMaxConcurrentRuns: 15, concurrencyEnabled: true });
  });

  it("bounds effective concurrency to the operational slot ceiling even when enabled", () => {
    // EXTERNAL_LIFECYCLE_SLOT_CAPACITY is 16; a misconfigured maxConcurrentRuns
    // above that must not exceed the operational ceiling.
    for (const maxConcurrentRuns of [16, 50]) {
      expect(resolveExternalLifecycleConcurrency({ concurrencyEnabled: true, maxConcurrentRuns })).toEqual({
        effectiveMaxConcurrentRuns: 16,
        concurrencyEnabled: true,
      });
    }
  });

  it("never returns less than 1 even for a degenerate maxConcurrentRuns", () => {
    const result = resolveExternalLifecycleConcurrency({ concurrencyEnabled: true, maxConcurrentRuns: 0 });
    expect(result.effectiveMaxConcurrentRuns).toBe(1);
  });

  it("restores the one-run fallback immediately when re-disabled, with no migration or persisted state", () => {
    const enabled = resolveExternalLifecycleConcurrency({ concurrencyEnabled: true, maxConcurrentRuns: 4 });
    expect(enabled.effectiveMaxConcurrentRuns).toBe(4);

    // Flipping the flag off is a pure re-computation from policy — no stored
    // reservation/slot state needs to change for this to take effect.
    const disabledAgain = resolveExternalLifecycleConcurrency({ concurrencyEnabled: false, maxConcurrentRuns: 4 });
    expect(disabledAgain.effectiveMaxConcurrentRuns).toBe(1);
  });
});

describe("resolveK8sRunIsolationIdentity: concurrency-aware run isolation (BLO-16842)", () => {
  const base = {
    adapterType: "opencode_k8s" as const,
    runId: "run-123",
    agentId: "agent-abc",
    statelessPrReview: false,
    isWorkspaceIsolated: false,
    persistedExecutionWorkspaceId: null,
  };

  it("keeps shared isolation for a default (effective concurrency 1) coding run", () => {
    expect(resolveK8sRunIsolationIdentity({ ...base, effectiveMaxConcurrentRuns: 1 })).toEqual({
      isolationMode: "shared",
      isolationKey: "agent-shared:agent-abc",
      reservationKey: "agent-shared:agent-abc",
    });
  });

  it("gives per-run isolation to a coding run once effective concurrency exceeds 1", () => {
    expect(resolveK8sRunIsolationIdentity({ ...base, effectiveMaxConcurrentRuns: 2 })).toEqual({
      isolationMode: "run",
      isolationKey: "run:run-123",
      reservationKey: "run:run-123",
    });
  });

  it("does not let concurrency override a deliberate persistent workspace", () => {
    expect(
      resolveK8sRunIsolationIdentity({
        ...base,
        isWorkspaceIsolated: true,
        persistedExecutionWorkspaceId: "ws-9",
        effectiveMaxConcurrentRuns: 3,
      }),
    ).toEqual({ isolationMode: "workspace", isolationKey: "workspace:ws-9", reservationKey: "workspace:ws-9" });
  });

  it("uses per-run isolation when workspace intent has no persisted workspace id yet", () => {
    expect(
      resolveK8sRunIsolationIdentity({
        ...base,
        isWorkspaceIsolated: true,
        persistedExecutionWorkspaceId: null,
        effectiveMaxConcurrentRuns: 2,
      }),
    ).toEqual({ isolationMode: "run", isolationKey: "run:run-123", reservationKey: "run:run-123" });
  });

  it("still uses run isolation for a stateless PR review regardless of concurrency", () => {
    expect(
      resolveK8sRunIsolationIdentity({
        ...base,
        statelessPrReview: true,
        effectiveMaxConcurrentRuns: 1,
      }),
    ).toEqual({ isolationMode: "run", isolationKey: "run:run-123", reservationKey: "run:run-123" });
  });

  it("returns null for non-k8s adapters even under concurrency", () => {
    expect(
      resolveK8sRunIsolationIdentity({ ...base, adapterType: "local", effectiveMaxConcurrentRuns: 5 }),
    ).toBeNull();
  });

  // BLO-16960: PR #719 (BLO-16842) added the concurrency-driven `run:` fallback
  // but only preserved persisted-workspace precedence when `isWorkspaceIsolated`
  // was true. An explicit `reuse_existing` selection of a persisted
  // `shared_workspace`-mode workspace leaves `isWorkspaceIsolated` false, so it
  // silently fell through to `run:<runId>` once effective concurrency exceeded
  // 1 -- discarding the reused checkout. `persistedWorkspaceExplicitlySelected`
  // closes that gap independently of the isolation-mode flag.
  it("preserves an explicitly reused persisted shared_workspace over the concurrency run: fallback", () => {
    expect(
      resolveK8sRunIsolationIdentity({
        ...base,
        isWorkspaceIsolated: false,
        persistedExecutionWorkspaceId: "ws-shared-9",
        persistedWorkspaceExplicitlySelected: true,
        effectiveMaxConcurrentRuns: 3,
      }),
    ).toEqual({ isolationMode: "workspace", isolationKey: "workspace:ws-shared-9", reservationKey: "workspace:ws-shared-9" });
  });

  it("keeps legacy shared isolation for explicit shared_workspace reuse when concurrency is disabled", () => {
    expect(
      resolveK8sRunIsolationIdentity({
        ...base,
        isWorkspaceIsolated: false,
        persistedExecutionWorkspaceId: "ws-shared-9",
        persistedWorkspaceExplicitlySelected: true,
        effectiveMaxConcurrentRuns: 1,
      }),
    ).toEqual({ isolationMode: "shared", isolationKey: "agent-shared:agent-abc", reservationKey: "agent-shared:agent-abc" });
  });

  it("still hands anonymous concurrent siblings distinct run: keys when no workspace was explicitly reused", () => {
    expect(
      resolveK8sRunIsolationIdentity({
        ...base,
        isWorkspaceIsolated: false,
        persistedExecutionWorkspaceId: null,
        persistedWorkspaceExplicitlySelected: false,
        effectiveMaxConcurrentRuns: 3,
      }),
    ).toEqual({ isolationMode: "run", isolationKey: "run:run-123", reservationKey: "run:run-123" });
  });
});

// BLO-31443: BLO-31282 (#1610) stopped overriding `workspaceRoot` for a run that
// already had a worktree, which fixed base-checkout contamination but gave up an
// incidental exclusivity property. `run:<runId>` and `workspace:<freshUuid>` are
// both unique per RUN; the worktree they resolve to is keyed by ISSUE under the
// default `per_issue` runScope. So two concurrent runs of one issue held two
// distinct writer keys, both satisfied
// `external_runtime_reservations_active_isolation_writer_idx`, and both wrote the
// same tree.
//
// These assertions are about which KEY is minted, which is the whole of the fix.
// Enforcement is unchanged and covered end-to-end elsewhere: the colliding-key
// path in heartbeat-external-runtime-retry.test.ts already proves a contender
// whose writer key is taken is deferred back to `queued` without dispatching.
describe("resolveK8sRunIsolationIdentity: writer key follows the tree, not the run (BLO-31443)", () => {
  const base = {
    adapterType: "claude_k8s" as const,
    agentId: "agent-abc",
    statelessPrReview: false,
    isWorkspaceIsolated: true,
    persistedWorkspaceExplicitlySelected: false,
  };
  const treeKey = "pws-1:issue-7";

  // AC1, via the reachable mechanism. On the FIRST run of an issue the issue has
  // no persisted `executionWorkspaceId`, so executeRun mints a fresh
  // `randomUUID()` as `plannedExecutionWorkspaceId`. Two runs racing that window
  // therefore carried two different `workspace:<uuid>` keys while resolving to
  // one per-issue worktree. Note this is NOT the mechanism the ticket described
  // (it assumed `run:<runId>` keys); both are covered here.
  it("collides two same-issue runs that each minted their own workspace id", () => {
    const first = resolveK8sRunIsolationIdentity({
      ...base,
      runId: "run-A",
      persistedExecutionWorkspaceId: "fresh-uuid-A",
      perIssueWorkspaceTreeKey: treeKey,
      effectiveMaxConcurrentRuns: 2,
    });
    const second = resolveK8sRunIsolationIdentity({
      ...base,
      runId: "run-B",
      persistedExecutionWorkspaceId: "fresh-uuid-B",
      perIssueWorkspaceTreeKey: treeKey,
      effectiveMaxConcurrentRuns: 2,
    });

    expect(first).toEqual({
      isolationMode: "workspace",
      isolationKey: "workspace:fresh-uuid-A",
      reservationKey: `workspace-tree:${treeKey}`,
    });
    // The reservation keys collide, so the second run serializes...
    expect(second!.reservationKey).toBe(first!.reservationKey);
    // ...while each run keeps its OWN private filesystem identity. That second
    // assertion is the whole point of the two-key split: `isolationKey` derives
    // `tmpRoot` and gates saved-session resume, and `sessionRoot` here is keyed
    // by the per-run `randomUUID()`, so sharing it would let run B resume a
    // session that was never written under run B's own session root.
    expect(second!.isolationKey).not.toBe(first!.isolationKey);
  });

  // AC1, via the mechanism the ticket described. Reachable because
  // `workspaceIsolationRequested` is mode-derived while a worktree is realized
  // from `workspaceStrategy.type` -- an agent-level or issue-level strategy cuts
  // a real worktree with the mode reading non-isolated, so the run lands on the
  // concurrency `run:` branch holding a per-issue tree.
  it("collides two same-issue runs that landed on the concurrency run: branch", () => {
    const identityFor = (runId: string) => resolveK8sRunIsolationIdentity({
      ...base,
      runId,
      isWorkspaceIsolated: false,
      persistedExecutionWorkspaceId: null,
      perIssueWorkspaceTreeKey: treeKey,
      effectiveMaxConcurrentRuns: 2,
    });

    expect(identityFor("run-A")).toEqual({
      isolationMode: "run",
      isolationKey: "run:run-A",
      reservationKey: `workspace-tree:${treeKey}`,
    });
    expect(identityFor("run-B")!.reservationKey).toBe(identityFor("run-A")!.reservationKey);
    // `run` mode gives each run an ephemeral `/runtime-cache/paperclip-runs/
    // <runId>/session` with `storage.session: "ephemeral"`, so the private key
    // must stay per-run or run B is handed a session id whose transcript is not
    // on its disk.
    expect(identityFor("run-B")!.isolationKey).not.toBe(identityFor("run-A")!.isolationKey);
  });

  // AC2 negative control -- BLO-16842 sibling concurrency must survive. Two runs
  // of DIFFERENT issues resolve to different trees, so they must keep distinct
  // keys and both acquire.
  it("keeps distinct keys for concurrent runs of different issues", () => {
    const left = resolveK8sRunIsolationIdentity({
      ...base,
      runId: "run-A",
      persistedExecutionWorkspaceId: "fresh-uuid-A",
      perIssueWorkspaceTreeKey: "pws-1:issue-7",
      effectiveMaxConcurrentRuns: 2,
    });
    const right = resolveK8sRunIsolationIdentity({
      ...base,
      runId: "run-B",
      persistedExecutionWorkspaceId: "fresh-uuid-B",
      perIssueWorkspaceTreeKey: "pws-1:issue-8",
      effectiveMaxConcurrentRuns: 2,
    });

    expect(left!.reservationKey).not.toBe(right!.reservationKey);
  });

  // One issue can hold trees in several repos of a multi-repo project, and those
  // are genuinely independent -- so the key is scoped by project workspace.
  it("keeps distinct keys for one issue across two project workspaces", () => {
    const paperclip = resolveK8sRunIsolationIdentity({
      ...base,
      runId: "run-A",
      persistedExecutionWorkspaceId: "fresh-uuid-A",
      perIssueWorkspaceTreeKey: "pws-paperclip:issue-7",
      effectiveMaxConcurrentRuns: 2,
    });
    const onprem = resolveK8sRunIsolationIdentity({
      ...base,
      runId: "run-B",
      persistedExecutionWorkspaceId: "fresh-uuid-B",
      perIssueWorkspaceTreeKey: "pws-onprem:issue-7",
      effectiveMaxConcurrentRuns: 2,
    });

    expect(paperclip!.reservationKey).not.toBe(onprem!.reservationKey);
  });

  // AC3. A stateless PR review must stay fully run-scoped and ephemeral, so it is
  // filtered ahead of every other branch and no caller can opt it in -- asserted
  // by passing a tree key it must ignore.
  it("never lets a stateless PR review adopt a tree key", () => {
    expect(
      resolveK8sRunIsolationIdentity({
        ...base,
        runId: "run-A",
        statelessPrReview: true,
        persistedExecutionWorkspaceId: null,
        perIssueWorkspaceTreeKey: treeKey,
        effectiveMaxConcurrentRuns: 2,
      }),
    ).toEqual({ isolationMode: "run", isolationKey: "run:run-A", reservationKey: "run:run-A" });
  });

  // AC4 lower bound. `agent-shared:<agentId>` is already STRICTER than per-tree
  // -- one writer per agent -- so substituting a tree key there would LOOSEN it
  // and let a concurrency-1 agent hold two reservations for different issues,
  // inverting BLO-16842's containment. Exclusivity at concurrency 1 comes from
  // the shared key, not from this fix.
  it("leaves the shared concurrency-1 key alone", () => {
    expect(
      resolveK8sRunIsolationIdentity({
        ...base,
        runId: "run-A",
        isWorkspaceIsolated: false,
        persistedExecutionWorkspaceId: null,
        perIssueWorkspaceTreeKey: treeKey,
        effectiveMaxConcurrentRuns: 1,
      }),
    ).toEqual({ isolationMode: "shared", isolationKey: "agent-shared:agent-abc", reservationKey: "agent-shared:agent-abc" });
  });

  // AC2, the other direction -- and this one is a REGRESSION GUARD, not a
  // hypothetical. Substituting the tree key unconditionally broke
  // `heartbeat-external-runtime-retry.test.ts` ("defers a contender whose
  // writer key is already held"): an explicitly reused `workspace:<id>` already
  // names the shared tree, and SEVERAL ISSUES may point at one such workspace,
  // so replacing it with a per-issue key gave two different issues two distinct
  // keys over one tree -- loosening exclusivity in exactly the way this row
  // exists to prevent. Only run-unique keys may be replaced.
  it("never replaces an explicitly reused workspace key, which already names the tree", () => {
    const identityFor = (runId: string, issue: string) =>
      resolveK8sRunIsolationIdentity({
        ...base,
        runId,
        isWorkspaceIsolated: false,
        persistedExecutionWorkspaceId: "shared-ws-1",
        persistedWorkspaceExplicitlySelected: true,
        perIssueWorkspaceTreeKey: `pws-1:${issue}`,
        effectiveMaxConcurrentRuns: 2,
      });

    // The tree key passed in must be ignored outright...
    expect(identityFor("run-A", "issue-7")).toEqual({
      isolationMode: "workspace",
      isolationKey: "workspace:shared-ws-1",
      reservationKey: "workspace:shared-ws-1",
    });
    // ...so two runs of DIFFERENT issues sharing one workspace still collide.
    expect(identityFor("run-B", "issue-8")!.reservationKey).toBe(
      identityFor("run-A", "issue-7")!.reservationKey,
    );
  });

  // `per_run` runScope appends a run token to the branch and hence to the
  // directory, so those runs are already tree-unique and must NOT be made to
  // collide. The caller signals that by passing a null tree key; absent/null must
  // both preserve the pre-BLO-31443 keys exactly.
  it("preserves run-unique keys when the caller supplies no tree key", () => {
    const perRun = resolveK8sRunIsolationIdentity({
      ...base,
      runId: "run-A",
      persistedExecutionWorkspaceId: "ws-9",
      perIssueWorkspaceTreeKey: null,
      effectiveMaxConcurrentRuns: 2,
    });
    const omitted = resolveK8sRunIsolationIdentity({
      ...base,
      runId: "run-A",
      persistedExecutionWorkspaceId: "ws-9",
      effectiveMaxConcurrentRuns: 2,
    });

    expect(perRun).toEqual({ isolationMode: "workspace", isolationKey: "workspace:ws-9", reservationKey: "workspace:ws-9" });
    expect(omitted).toEqual(perRun);
  });

  // `isolationMode` is deliberately untouched, because every filesystem root is
  // derived from it plus `runId`/`persistedExecutionWorkspaceId`. Only the
  // reservation key moves; a mode change here would silently re-point home,
  // session and cache roots.
  it("does not change isolationMode when it substitutes the key", () => {
    for (const [isWorkspaceIsolated, persistedExecutionWorkspaceId, expectedMode] of [
      [true, "fresh-uuid-A", "workspace"],
      [false, null, "run"],
    ] as const) {
      const withTree = resolveK8sRunIsolationIdentity({
        ...base,
        runId: "run-A",
        isWorkspaceIsolated,
        persistedExecutionWorkspaceId,
        perIssueWorkspaceTreeKey: treeKey,
        effectiveMaxConcurrentRuns: 2,
      });
      const withoutTree = resolveK8sRunIsolationIdentity({
        ...base,
        runId: "run-A",
        isWorkspaceIsolated,
        persistedExecutionWorkspaceId,
        effectiveMaxConcurrentRuns: 2,
      });

      expect(withTree!.isolationMode).toBe(expectedMode);
      expect(withTree!.isolationMode).toBe(withoutTree!.isolationMode);
    }
  });

  // `isolationKey` is not read only by the reservation: it is also stamped onto
  // persisted session params and gates saved-session resume
  // (`sessionParamsMatchIsolation`, consumed at the `isolation_mismatch`
  // requeue). So the tree key must NOT reach it -- only `reservationKey`.
  //
  // The first draft of BLO-31443 widened `isolationKey` itself, which flipped
  // that guard from reject to ACCEPT in exactly the branches where it has to
  // reject. Both branches that take the substitution keep a per-run
  // `sessionRoot`: `run` mode roots it at
  // `/runtime-cache/paperclip-runs/<runId>/session` with `storage.session:
  // "ephemeral"`, and the non-explicit `workspace` branch roots it at a
  // `persistedExecutionWorkspaceId` that is a fresh `randomUUID()` per run. A
  // shared key would therefore hand run B run A's `sessionId` against a session
  // directory that has never contained it.
  //
  // This test builds BOTH descriptors through `buildK8sRunIsolationDescriptor`
  // rather than hand-writing their roots. The draft version of this test
  // asserted a literal `sessionRoot: "/s"` for both runs, which gave them one
  // session directory by construction -- assuming away the very thing that made
  // the shared key wrong, so it passed over the defect.
  it("never lets a same-issue run resume a session stamped by an earlier run", () => {
    const descriptorFor = (runId: string, perIssueWorkspaceTreeKey: string | null) =>
      buildK8sRunIsolationDescriptor({
        adapterType: "claude_k8s",
        runId,
        companyId: "company-1",
        agentId: base.agentId,
        taskKey: "issue-7",
        statelessPrReview: false,
        executionWorkspace: {
          cwd: "/paperclip/worktrees/issue-7",
          source: "task_session",
          strategy: "git_worktree",
        },
        persistedExecutionWorkspaceId: null,
        effectiveExecutionWorkspaceMode: "isolated_workspace",
        isolationIdentity: resolveK8sRunIsolationIdentity({
          ...base,
          runId,
          isWorkspaceIsolated: false,
          persistedExecutionWorkspaceId: null,
          perIssueWorkspaceTreeKey,
          effectiveMaxConcurrentRuns: 2,
        }),
      })!;
    const stampOf = (runId: string, tree: string | null) =>
      scopeSessionParamsToIsolation({ sessionId: `session-from-${runId}` }, descriptorFor(runId, tree));

    const runA = descriptorFor("run-A", treeKey);
    const runB = descriptorFor("run-B", treeKey);

    // The premise: with a tree key the two runs really do share one WORKSPACE
    // (that is the fix) while their SESSION storage stays per-run and ephemeral.
    expect(runB.workspaceRoot).toBe(runA.workspaceRoot);
    expect(runB.sessionRoot).not.toBe(runA.sessionRoot);
    expect(runA.storage.session).toBe("ephemeral");

    // So run B must reject run A's session, tree key or not. Accepting it would
    // resume a transcript that is not under run B's `sessionRoot`.
    expect(
      sessionParamsMatchIsolation(stampOf("run-A", treeKey), runB),
    ).toBe(false);

    // Unchanged from before the tree key existed -- the guard is keyed on the
    // run's private identity in both cases.
    expect(
      sessionParamsMatchIsolation(stampOf("run-A", null), descriptorFor("run-B", null)),
    ).toBe(false);

    // ...and the reservation key still collides, which is what serializes them.
    expect(runB.isolationKey).not.toBe(runA.isolationKey);
    expect(
      resolveK8sRunIsolationIdentity({
        ...base,
        runId: "run-B",
        isWorkspaceIsolated: false,
        persistedExecutionWorkspaceId: null,
        perIssueWorkspaceTreeKey: treeKey,
        effectiveMaxConcurrentRuns: 2,
      })!.reservationKey,
    ).toBe(`workspace-tree:${treeKey}`);
  });

  // `tmpRoot` is a hash of `isolationKey`, and Chromium appends its singleton
  // socket path to it. Two same-issue runs must not share it: the reservation
  // serializes them in the normal case, but the deferral is a retry rather than
  // a mutex, so a shared tmp dir would be a second, unguarded collision.
  it("keeps tmpRoot per-run for two same-issue runs", () => {
    const tmpRootFor = (runId: string) =>
      buildK8sRunIsolationDescriptor({
        adapterType: "claude_k8s",
        runId,
        companyId: "company-1",
        agentId: base.agentId,
        taskKey: "issue-7",
        statelessPrReview: false,
        executionWorkspace: {
          cwd: "/paperclip/worktrees/issue-7",
          source: "task_session",
          strategy: "git_worktree",
        },
        persistedExecutionWorkspaceId: null,
        effectiveExecutionWorkspaceMode: "isolated_workspace",
        isolationIdentity: resolveK8sRunIsolationIdentity({
          ...base,
          runId,
          isWorkspaceIsolated: false,
          persistedExecutionWorkspaceId: null,
          perIssueWorkspaceTreeKey: treeKey,
          effectiveMaxConcurrentRuns: 2,
        }),
      })!.tmpRoot;

    expect(tmpRootFor("run-B")).not.toBe(tmpRootFor("run-A"));
  });

  // AC3 regression guard, asserted on the real descriptor rather than on the
  // key alone: a stateless PR review stays fully ephemeral and run-scoped.
  it("keeps a stateless PR review on an ephemeral per-run workspace", () => {
    const descriptor = buildK8sRunIsolationDescriptor({
      adapterType: "claude_k8s",
      runId: "run-A",
      companyId: "company-1",
      agentId: base.agentId,
      taskKey: null,
      statelessPrReview: true,
      executionWorkspace: {
        cwd: "/paperclip/worktrees/issue-7",
        source: "task_session",
        strategy: "git_worktree",
      },
      persistedExecutionWorkspaceId: null,
      effectiveExecutionWorkspaceMode: "isolated_workspace",
      isolationIdentity: resolveK8sRunIsolationIdentity({
        ...base,
        runId: "run-A",
        statelessPrReview: true,
        isWorkspaceIsolated: false,
        persistedExecutionWorkspaceId: null,
        perIssueWorkspaceTreeKey: treeKey,
        effectiveMaxConcurrentRuns: 2,
      }),
    })!;

    expect(descriptor.workspaceRoot).toBe("/runtime-cache/paperclip-runs/run-A/workspace");
    expect(descriptor.storage.workspace).toBe("ephemeral");
    expect(descriptor.isolationKey).toBe("run:run-A");
  });
});
