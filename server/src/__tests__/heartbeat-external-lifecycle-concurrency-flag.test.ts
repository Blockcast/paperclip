import { describe, expect, it } from "vitest";
import {
  resolveExternalLifecycleConcurrency,
  resolveHeartbeatPolicyForRuntimeConfig,
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
    const result = resolveExternalLifecycleConcurrency({ concurrencyEnabled: true, maxConcurrentRuns: 3 });
    expect(result).toEqual({ effectiveMaxConcurrentRuns: 3, concurrencyEnabled: true });
  });

  it("bounds effective concurrency to the operational slot ceiling even when enabled", () => {
    // EXTERNAL_LIFECYCLE_SLOT_CAPACITY is 5; a misconfigured maxConcurrentRuns
    // above that must not exceed the operational ceiling.
    const result = resolveExternalLifecycleConcurrency({ concurrencyEnabled: true, maxConcurrentRuns: 50 });
    expect(result.effectiveMaxConcurrentRuns).toBe(5);
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
