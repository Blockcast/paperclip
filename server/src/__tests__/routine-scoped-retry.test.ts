import { describe, expect, it } from "vitest";

import {
  MAX_TRANSIENT_RETRY_HORIZON_MS,
  clampTransientRetryHorizon,
  resolveRoutineScopedRetry,
} from "../services/ccrotate-capacity-retry.js";

/**
 * BLO-28863. Measured 2026-08-19 against the live fleet: 70% of
 * `transient_failure` retries were pinned 3-5h out to the provider's advertised
 * reset (`penstockAdvertisedResumeAt`, clustering on `:19:59`/`:59:59`), and the
 * worst observed backoff was 23h59m43s on attempt 1 — that value is
 * MAX_TRANSIENT_RETRY_HORIZON_MS binding at its own ceiling, not a missing
 * clamp. Every one of those lands inside the 24h horizon, so the existing clamp
 * is a no-op for exactly the case that loses windows.
 */
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

describe("routine-period awareness of the transient horizon (BLO-28863)", () => {
  it("demonstrates the defect: the flat horizon clamp cannot protect a 6h routine", () => {
    // The failure instant and advertised reset from the lost window below.
    const failedAt = new Date("2026-08-19T00:19:17.166Z");
    const advertised = new Date("2026-08-19T04:50:00.028Z");

    const flat = clampTransientRetryHorizon({ retryNotBefore: advertised, now: failedAt });

    // The flat clamp declines to act — 4.5h is far inside a 24h ceiling ...
    expect(flat.clampedFromIso).toBeNull();
    expect(flat.dueAt.getTime()).toBe(advertised.getTime());
    // ... and a 23h floor, which strands three consecutive 6h windows, is
    // likewise honoured verbatim. This is the assumption BLO-28863 refutes.
    const twentyThreeHours = new Date(failedAt.getTime() + 23 * 60 * 60 * 1000);
    expect(
      clampTransientRetryHorizon({ retryNotBefore: twentyThreeHours, now: failedAt }).clampedFromIso,
    ).toBeNull();
    expect(23 * 60 * 60 * 1000).toBeLessThan(MAX_TRANSIENT_RETRY_HORIZON_MS);
  });

  it("clamps a backoff longer than the owning routine's period back inside it", () => {
    const failedAt = new Date("2026-08-19T04:24:00.000Z");
    // Observed: three attempt-1 retries drew ~24h backoff under a 6h routine.
    const dueAt = new Date("2026-08-20T04:23:00.000Z");

    const result = resolveRoutineScopedRetry({ dueAt, failedAt, routinePeriodMs: SIX_HOURS_MS });

    expect(result.decision).toBe("clamp");
    expect(result.dueAt?.toISOString()).toBe("2026-08-19T10:24:00.000Z");
    expect(result.clampedFromIso).toBe(dueAt.toISOString());
    // The invariant the acceptance criteria names: never later than one period.
    expect(result.dueAt!.getTime() - failedAt.getTime()).toBeLessThanOrEqual(SIX_HOURS_MS);
  });

  it("honours a backoff that already lands inside the period", () => {
    const failedAt = new Date("2026-08-19T00:00:00.000Z");
    const dueAt = new Date("2026-08-19T00:16:00.000Z");

    const result = resolveRoutineScopedRetry({ dueAt, failedAt, routinePeriodMs: SIX_HOURS_MS });

    expect(result.decision).toBe("honour");
    expect(result.dueAt?.getTime()).toBe(dueAt.getTime());
    expect(result.clampedFromIso).toBeNull();
  });

  it("respects the window deadline, which is tighter than the period mid-window", () => {
    // The real BLO-28785 loss: failure 19 minutes into a 00:00Z-06:00Z window.
    // The period budget alone would allow 06:19Z — past the window close.
    const failedAt = new Date("2026-08-19T00:19:17.166Z");
    const windowClosesAt = new Date("2026-08-19T06:00:00.000Z");
    const advertised = new Date("2026-08-19T04:50:00.028Z");

    const inWindow = resolveRoutineScopedRetry({
      dueAt: advertised,
      failedAt,
      routinePeriodMs: SIX_HOURS_MS,
      windowClosesAt,
    });
    // 04:50Z was genuinely inside the window — the schedule was never the bug;
    // the 1h10m dispatch gap was. This retry should be honoured as scheduled.
    expect(inWindow.decision).toBe("honour");

    // But a retry drawn past the close is clamped to the close, not the period.
    const late = resolveRoutineScopedRetry({
      dueAt: new Date("2026-08-19T06:00:39.677Z"),
      failedAt,
      routinePeriodMs: SIX_HOURS_MS,
      windowClosesAt,
    });
    expect(late.decision).toBe("clamp");
    expect(late.dueAt?.toISOString()).toBe(windowClosesAt.toISOString());
  });

  it("abandons rather than strands when no margin is left in the window", () => {
    // A retry that can only wake after its window still costs a run slot and an
    // attempt, delaying every other queued retry — so it must not be scheduled.
    const failedAt = new Date("2026-08-19T06:00:05.000Z");
    const result = resolveRoutineScopedRetry({
      dueAt: new Date("2026-08-19T10:00:00.000Z"),
      failedAt,
      routinePeriodMs: SIX_HOURS_MS,
      windowClosesAt: new Date("2026-08-19T06:00:00.000Z"),
    });

    expect(result.decision).toBe("abandon");
    expect(result.dueAt).toBeNull();
    expect(result.reason).toMatch(/already closed/);
  });

  it("never moves a due time later than what was asked for", () => {
    const failedAt = new Date("2026-08-19T00:00:00.000Z");
    for (const delayMs of [1_000, 60_000, SIX_HOURS_MS - 1, SIX_HOURS_MS, 24 * 60 * 60 * 1000]) {
      const dueAt = new Date(failedAt.getTime() + delayMs);
      const result = resolveRoutineScopedRetry({ dueAt, failedAt, routinePeriodMs: SIX_HOURS_MS });
      if (result.dueAt) expect(result.dueAt.getTime()).toBeLessThanOrEqual(dueAt.getTime());
    }
  });
});
