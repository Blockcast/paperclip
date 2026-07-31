import { describe, expect, it } from "vitest";
import {
  resolveExternalLifecycleConcurrency,
  resolveHeartbeatPolicyForRuntimeConfig,
  resolveK8sRunIsolationIdentity,
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
    const result = resolveExternalLifecycleConcurrency({ concurrencyEnabled: true, maxConcurrentRuns: 5 });
    expect(result).toEqual({ effectiveMaxConcurrentRuns: 5, concurrencyEnabled: true });
  });

  it("bounds effective concurrency to the operational slot ceiling even when enabled", () => {
    // EXTERNAL_LIFECYCLE_SLOT_CAPACITY is 8; a misconfigured maxConcurrentRuns
    // above that must not exceed the operational ceiling.
    expect(
      resolveExternalLifecycleConcurrency({ concurrencyEnabled: true, maxConcurrentRuns: 8 })
        .effectiveMaxConcurrentRuns,
    ).toBe(8);
    const result = resolveExternalLifecycleConcurrency({ concurrencyEnabled: true, maxConcurrentRuns: 50 });
    expect(result.effectiveMaxConcurrentRuns).toBe(8);
    expect(result.concurrencyEnabled).toBe(true);
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
    });
  });

  it("gives per-run isolation to a coding run once effective concurrency exceeds 1", () => {
    expect(resolveK8sRunIsolationIdentity({ ...base, effectiveMaxConcurrentRuns: 2 })).toEqual({
      isolationMode: "run",
      isolationKey: "run:run-123",
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
    ).toEqual({ isolationMode: "workspace", isolationKey: "workspace:ws-9" });
  });

  it("uses per-run isolation when workspace intent has no persisted workspace id yet", () => {
    expect(
      resolveK8sRunIsolationIdentity({
        ...base,
        isWorkspaceIsolated: true,
        persistedExecutionWorkspaceId: null,
        effectiveMaxConcurrentRuns: 2,
      }),
    ).toEqual({ isolationMode: "run", isolationKey: "run:run-123" });
  });

  it("still uses run isolation for a stateless PR review regardless of concurrency", () => {
    expect(
      resolveK8sRunIsolationIdentity({
        ...base,
        statelessPrReview: true,
        effectiveMaxConcurrentRuns: 1,
      }),
    ).toEqual({ isolationMode: "run", isolationKey: "run:run-123" });
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
    ).toEqual({ isolationMode: "workspace", isolationKey: "workspace:ws-shared-9" });
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
    ).toEqual({ isolationMode: "shared", isolationKey: "agent-shared:agent-abc" });
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
    ).toEqual({ isolationMode: "run", isolationKey: "run:run-123" });
  });
});
