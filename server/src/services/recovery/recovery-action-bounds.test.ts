import { describe, expect, it } from "vitest";
import {
  decideRecoveryAction,
  effectiveMaxAttempts,
  effectiveTimeoutAt,
  planRecoverySweep,
  retryBackoffMs,
  type RecoveryActionBoundsConfig,
} from "./recovery-action-bounds.js";

const config: RecoveryActionBoundsConfig = {
  retryBaseMs: 30 * 60_000,
  retryMaxMs: 6 * 60 * 60_000,
  maxAttempts: 6,
  timeoutMs: 72 * 60 * 60_000,
  perOwnerPerTick: 2,
  perTick: 25,
};

const NOW = new Date("2026-07-31T12:00:00.000Z");

function action(overrides: Partial<{
  attemptCount: number;
  maxAttempts: number | null;
  timeoutAt: Date | null;
  createdAt: Date;
  lastAttemptAt: Date | null;
}> = {}) {
  return {
    attemptCount: 1,
    maxAttempts: 6 as number | null,
    timeoutAt: new Date(NOW.getTime() + 60 * 60_000) as Date | null,
    createdAt: new Date(NOW.getTime() - 60 * 60_000),
    lastAttemptAt: new Date(NOW.getTime() - 60 * 60_000) as Date | null,
    ...overrides,
  };
}

describe("retryBackoffMs", () => {
  it("doubles per attempt and clamps at retryMaxMs", () => {
    expect(retryBackoffMs(1, config)).toBe(30 * 60_000);
    expect(retryBackoffMs(2, config)).toBe(60 * 60_000);
    expect(retryBackoffMs(3, config)).toBe(2 * 60 * 60_000);
    expect(retryBackoffMs(4, config)).toBe(4 * 60 * 60_000);
    // 8h would exceed the 6h ceiling.
    expect(retryBackoffMs(5, config)).toBe(6 * 60 * 60_000);
  });

  it("stays finite for absurd attempt counts", () => {
    expect(Number.isFinite(retryBackoffMs(10_000, config))).toBe(true);
    expect(retryBackoffMs(10_000, config)).toBe(config.retryMaxMs);
  });
});

describe("legacy rows with null bounds", () => {
  // The ~300 actions that predate BLO-19124 all have timeoutAt/maxAttempts
  // NULL. They must become bounded without a backfill migration.
  it("derives a deadline from createdAt when timeoutAt is null", () => {
    const created = new Date("2026-06-10T00:00:00.000Z");
    expect(effectiveTimeoutAt({ timeoutAt: null, createdAt: created }, config)).toEqual(
      new Date(created.getTime() + config.timeoutMs),
    );
  });

  it("falls back to the configured attempt bound when maxAttempts is null", () => {
    expect(effectiveMaxAttempts({ maxAttempts: null }, config)).toBe(6);
  });

  it("expires a seven-week-old legacy action on first sight", () => {
    const legacy = action({
      timeoutAt: null,
      maxAttempts: null,
      createdAt: new Date("2026-06-10T00:00:00.000Z"),
      lastAttemptAt: new Date("2026-06-10T00:00:00.000Z"),
      attemptCount: 1,
    });
    expect(decideRecoveryAction(legacy, NOW, config)).toEqual({
      type: "expire",
      reason: "timeout",
    });
  });
});

describe("decideRecoveryAction", () => {
  it("waits while the backoff has not elapsed", () => {
    const recent = action({ attemptCount: 1, lastAttemptAt: new Date(NOW.getTime() - 60_000) });
    expect(decideRecoveryAction(recent, NOW, config)).toEqual({ type: "wait" });
  });

  it("re-arms once the backoff has elapsed", () => {
    const due = action({ attemptCount: 1, lastAttemptAt: new Date(NOW.getTime() - 31 * 60_000) });
    expect(decideRecoveryAction(due, NOW, config)).toEqual({ type: "rearm", attempt: 2 });
  });

  it("expires on the attempt bound", () => {
    const exhausted = action({
      attemptCount: 6,
      maxAttempts: 6,
      lastAttemptAt: new Date(NOW.getTime() - 24 * 60 * 60_000),
    });
    expect(decideRecoveryAction(exhausted, NOW, config)).toEqual({
      type: "expire",
      reason: "max_attempts",
    });
  });

  it("expires on the wall clock even when attempts remain", () => {
    const timedOut = action({
      attemptCount: 2,
      timeoutAt: new Date(NOW.getTime() - 1),
      lastAttemptAt: new Date(NOW.getTime() - 24 * 60 * 60_000),
    });
    expect(decideRecoveryAction(timedOut, NOW, config)).toEqual({
      type: "expire",
      reason: "timeout",
    });
  });

  it("prefers timeout over max_attempts when both are breached", () => {
    const both = action({
      attemptCount: 99,
      timeoutAt: new Date(NOW.getTime() - 1),
      lastAttemptAt: new Date(NOW.getTime() - 24 * 60 * 60_000),
    });
    expect(decideRecoveryAction(both, NOW, config)).toEqual({
      type: "expire",
      reason: "timeout",
    });
  });

  it("never returns wait for an action that is already past a bound", () => {
    // A timed-out action whose last attempt was seconds ago must still expire —
    // otherwise backoff could hold an out-of-bounds action alive forever.
    const justAttempted = action({
      attemptCount: 1,
      timeoutAt: new Date(NOW.getTime() - 1),
      lastAttemptAt: new Date(NOW.getTime() - 1_000),
    });
    expect(decideRecoveryAction(justAttempted, NOW, config).type).toBe("expire");
  });
});

describe("planRecoverySweep burst safety", () => {
  function rearmFor(ownerAgentId: string | null, id: number) {
    return {
      action: { id, ownerAgentId },
      decision: { type: "rearm" as const, attempt: 2 },
    };
  }

  it("caps re-arms per owner so one owner cannot be handed N wakes at once", () => {
    // The BLO-19124 burst: 59 recoveries landed on a single owner running
    // maxConcurrentRuns: 3, each with exactly one wake and no second chance.
    const candidates = Array.from({ length: 59 }, (_, index) => rearmFor("owner-a", index));
    const planned = planRecoverySweep(candidates, config);
    expect(planned).toHaveLength(config.perOwnerPerTick);
  });

  it("still makes progress for other owners in the same tick", () => {
    const candidates = [
      ...Array.from({ length: 30 }, (_, index) => rearmFor("owner-a", index)),
      ...Array.from({ length: 30 }, (_, index) => rearmFor("owner-b", 100 + index)),
    ];
    const planned = planRecoverySweep(candidates, config);
    expect(planned.filter((entry) => entry.action.ownerAgentId === "owner-a")).toHaveLength(2);
    expect(planned.filter((entry) => entry.action.ownerAgentId === "owner-b")).toHaveLength(2);
  });

  it("does not throttle expirations, which wake nobody", () => {
    const candidates = Array.from({ length: 20 }, (_, index) => ({
      action: { id: index, ownerAgentId: "owner-a" },
      decision: { type: "expire" as const, reason: "timeout" as const },
    }));
    const planned = planRecoverySweep(candidates, config);
    expect(planned).toHaveLength(20);
  });

  it("honours the global per-tick cap", () => {
    const candidates = Array.from({ length: 100 }, (_, index) => ({
      action: { id: index, ownerAgentId: `owner-${index}` },
      decision: { type: "expire" as const, reason: "timeout" as const },
    }));
    expect(planRecoverySweep(candidates, config)).toHaveLength(config.perTick);
  });

  it("groups unowned actions under a single bucket rather than treating each as its own owner", () => {
    const candidates = Array.from({ length: 10 }, (_, index) => rearmFor(null, index));
    expect(planRecoverySweep(candidates, config)).toHaveLength(config.perOwnerPerTick);
  });
});
