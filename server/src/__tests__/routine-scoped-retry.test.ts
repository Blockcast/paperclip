import { describe, expect, it } from "vitest";

import {
  DISPATCH_LATENESS_P95_MS,
  MAX_TRANSIENT_RETRY_HORIZON_MS,
  MEDIAN_HEARTBEAT_RUN_DURATION_MS,
  MIN_USEFUL_RETRY_MARGIN_MS,
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

/**
 * The derived margin at the 2026-08-19 measurement: 71m dispatch-lateness p95
 * plus one 7m41s median run. Spelled out here so a re-tune of either input
 * shows up as a failing expectation rather than as silently shifted boundaries.
 */
const MARGIN_MS = 78 * 60 * 1000 + 41 * 1000;

describe("routine-period awareness of the transient horizon (BLO-28863)", () => {
  it("derives the minimum useful margin from the measurement rather than picking it", () => {
    // Mirrors the TRANSIENT_HORIZON_CLAMP_MIN_ATTEMPTS precedent in this module:
    // the constant must stay a function of its inputs so a future reader cannot
    // widen the total without re-deriving what it was sized against.
    expect(MIN_USEFUL_RETRY_MARGIN_MS).toBe(
      DISPATCH_LATENESS_P95_MS + MEDIAN_HEARTBEAT_RUN_DURATION_MS,
    );
    expect(MIN_USEFUL_RETRY_MARGIN_MS).toBe(MARGIN_MS);
  });

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
    // Period deadline 10:24:00Z, less the 78m41s lead.
    expect(result.dueAt?.toISOString()).toBe("2026-08-19T09:05:19.000Z");
    expect(result.decision === "clamp" && result.clampedFromIso).toBe(dueAt.toISOString());
    // The invariant the acceptance criteria names: never later than one period.
    expect(result.dueAt!.getTime() - failedAt.getTime()).toBeLessThanOrEqual(SIX_HOURS_MS);
    // And now strictly *inside* it, by the margin, rather than flush against it.
    expect(result.dueAt!.getTime() - failedAt.getTime()).toBe(SIX_HOURS_MS - MARGIN_MS);
  });

  it("honours a backoff that already lands inside the period", () => {
    const failedAt = new Date("2026-08-19T00:00:00.000Z");
    const dueAt = new Date("2026-08-19T00:16:00.000Z");

    const result = resolveRoutineScopedRetry({ dueAt, failedAt, routinePeriodMs: SIX_HOURS_MS });

    expect(result.decision).toBe("honour");
    expect(result.dueAt?.getTime()).toBe(dueAt.getTime());
    expect(result.decision === "honour" && result.clampedFromIso).toBeNull();
  });

  it("pulls the BLO-28785 schedule forward instead of honouring the loss", () => {
    // The real BLO-28785 loss: failure 19 minutes into a 00:00Z-06:00Z window,
    // provider advertising 04:50Z. The first cut of this suite asserted that
    // 04:50Z should be *honoured* because it was "genuinely inside the window" —
    // but that is precisely the schedule that lost the window: the retry
    // dispatched at 06:00:39.677Z, 39.7s after the close, because 70 minutes of
    // margin does not survive this fleet's 71-minute dispatch-lateness p95.
    // Honouring it is the honour-path twin of clamping to the close.
    const failedAt = new Date("2026-08-19T00:19:17.166Z");
    const windowClosesAt = new Date("2026-08-19T06:00:00.000Z");
    const advertised = new Date("2026-08-19T04:50:00.028Z");

    const result = resolveRoutineScopedRetry({
      dueAt: advertised,
      failedAt,
      routinePeriodMs: SIX_HOURS_MS,
      windowClosesAt,
    });

    expect(result.decision).toBe("clamp");
    // 06:00:00Z close, less the 78m41s lead.
    expect(result.dueAt?.toISOString()).toBe("2026-08-19T04:41:19.000Z");
    expect(result.decision === "clamp" && result.clampedFromIso).toBe(advertised.toISOString());
    // The window deadline binds, not the period: the period alone would have
    // allowed 06:19:17Z, past the close.
    expect(result.dueAt!.getTime()).toBeLessThan(windowClosesAt.getTime());
    expect(windowClosesAt.getTime() - result.dueAt!.getTime()).toBe(MARGIN_MS);
  });

  it("leaves a trace when the requested due time is exactly the window close", () => {
    // Previously this slipped through `honour` with `clampedFromIso: null` — the
    // same 0ms-of-window strand, but invisible in the run row. With a lead
    // applied the boundary case is a clamp, so it is legible from `resultJson`
    // the way every other clamped park in this module is.
    const failedAt = new Date("2026-08-19T00:00:00.000Z");
    const windowClosesAt = new Date("2026-08-19T06:00:00.000Z");

    const result = resolveRoutineScopedRetry({
      dueAt: windowClosesAt,
      failedAt,
      routinePeriodMs: SIX_HOURS_MS,
      windowClosesAt,
    });

    expect(result.decision).toBe("clamp");
    expect(result.decision === "clamp" && result.clampedFromIso).toBe(windowClosesAt.toISOString());
    expect(result.dueAt?.toISOString()).toBe("2026-08-19T04:41:19.000Z");
  });

  it("abandons a failure late inside a still-open window", () => {
    // The shape that actually loses windows, and the one the first cut of this
    // function could never reach: the window is *open* at the failure instant,
    // but too little of it remains for a retry to start and finish. Under the
    // pre-ruling code `marginMs = deadline - failedAt` was 60 minutes here, so
    // this clamped to the 06:00Z close and burned a slot and an attempt on a
    // wake with 0ms of usable window.
    const failedAt = new Date("2026-08-19T05:00:00.000Z");
    const windowClosesAt = new Date("2026-08-19T06:00:00.000Z");

    const result = resolveRoutineScopedRetry({
      dueAt: new Date("2026-08-19T06:01:00.000Z"),
      failedAt,
      routinePeriodMs: SIX_HOURS_MS,
      windowClosesAt,
    });

    expect(result.decision).toBe("abandon");
    expect(result.dueAt).toBeNull();
    expect(result.decision === "abandon" && result.reason).toMatch(
      /too little of the owning window/,
    );
    // Reported as a rejection, not a clamp, so a uniform logger cannot record a
    // clamp that never happened.
    expect(result.decision === "abandon" && result.rejectedDueAtIso).toBe(
      "2026-08-19T06:01:00.000Z",
    );
    expect("clampedFromIso" in result).toBe(false);
  });

  it("abandons every failure inside the final margin of a window", () => {
    // Ally's 360-case reproduction, inverted. Sweeping the last hour of an open
    // 6h window minute by minute, the pre-ruling function clamped 60/60 to the
    // close and abandoned none. The contract is now the stated one.
    const windowClosesAt = new Date("2026-08-19T06:00:00.000Z");
    const decisions = new Set<string>();
    for (let minutesBeforeClose = 0; minutesBeforeClose < 60; minutesBeforeClose += 1) {
      const failedAt = new Date(windowClosesAt.getTime() - minutesBeforeClose * 60 * 1000);
      decisions.add(
        resolveRoutineScopedRetry({
          dueAt: new Date(windowClosesAt.getTime() + 60 * 1000),
          failedAt,
          routinePeriodMs: SIX_HOURS_MS,
          windowClosesAt,
        }).decision,
      );
    }
    expect([...decisions]).toEqual(["abandon"]);
  });

  it("abandons when the window had already closed at the failure instant", () => {
    const failedAt = new Date("2026-08-19T06:00:05.000Z");
    const result = resolveRoutineScopedRetry({
      dueAt: new Date("2026-08-19T10:00:00.000Z"),
      failedAt,
      routinePeriodMs: SIX_HOURS_MS,
      windowClosesAt: new Date("2026-08-19T06:00:00.000Z"),
    });

    expect(result.decision).toBe("abandon");
    expect(result.dueAt).toBeNull();
    expect(result.decision === "abandon" && result.reason).toMatch(/already closed/);
  });

  it("fails closed to abandon on non-finite input", () => {
    const failedAt = new Date("2026-08-19T00:00:00.000Z");
    const dueAt = new Date("2026-08-20T00:00:00.000Z");

    // `Math.max(1, NaN)` is `NaN`, so the pre-ruling guard read like a floor
    // while covering only the non-positive case: every comparison against `NaN`
    // is false, so this returned `decision: "clamp"` with an `Invalid Date`.
    const nanPeriod = resolveRoutineScopedRetry({ dueAt, failedAt, routinePeriodMs: Number.NaN });
    expect(nanPeriod.decision).toBe("abandon");
    expect(nanPeriod.decision === "abandon" && nanPeriod.reason).toMatch(/not finite/);
    expect(nanPeriod.decision === "abandon" && nanPeriod.rejectedDueAtIso).toBe(dueAt.toISOString());

    for (const routinePeriodMs of [Number.POSITIVE_INFINITY, 0, -1]) {
      expect(resolveRoutineScopedRetry({ dueAt, failedAt, routinePeriodMs }).decision).toBe(
        "abandon",
      );
    }

    // An invalid instant must not throw on the way out either: `toISOString()`
    // on an `Invalid Date` raises RangeError, so the rejected value is reported
    // as null rather than crashing the dispatch path.
    const badDueAt = resolveRoutineScopedRetry({
      dueAt: new Date(Number.NaN),
      failedAt,
      routinePeriodMs: SIX_HOURS_MS,
    });
    expect(badDueAt.decision).toBe("abandon");
    expect(badDueAt.decision === "abandon" && badDueAt.rejectedDueAtIso).toBeNull();

    expect(
      resolveRoutineScopedRetry({
        dueAt,
        failedAt: new Date(Number.NaN),
        routinePeriodMs: SIX_HOURS_MS,
      }).decision,
    ).toBe("abandon");

    expect(
      resolveRoutineScopedRetry({
        dueAt,
        failedAt,
        routinePeriodMs: SIX_HOURS_MS,
        windowClosesAt: new Date(Number.NaN),
      }).decision,
    ).toBe("abandon");
  });

  it("never moves a due time later than what was asked for", () => {
    const failedAt = new Date("2026-08-19T00:00:00.000Z");
    const targetMs = failedAt.getTime() + SIX_HOURS_MS - MARGIN_MS;

    // Each case names its expected decision. The previous form guarded the
    // comparison with `if (result.dueAt)`, so a regression that turned every
    // input into `abandon` left the assertion green while covering nothing.
    const cases: Array<{ delayMs: number; decision: string }> = [
      { delayMs: 1_000, decision: "honour" },
      { delayMs: 60_000, decision: "honour" },
      { delayMs: SIX_HOURS_MS - MARGIN_MS, decision: "honour" },
      { delayMs: SIX_HOURS_MS - MARGIN_MS + 1, decision: "clamp" },
      { delayMs: SIX_HOURS_MS - 1, decision: "clamp" },
      { delayMs: SIX_HOURS_MS, decision: "clamp" },
      { delayMs: 24 * 60 * 60 * 1000, decision: "clamp" },
    ];

    for (const { delayMs, decision } of cases) {
      const dueAt = new Date(failedAt.getTime() + delayMs);
      const result = resolveRoutineScopedRetry({ dueAt, failedAt, routinePeriodMs: SIX_HOURS_MS });
      expect(result.decision, `delay ${delayMs}ms`).toBe(decision);
      expect(result.dueAt).not.toBeNull();
      expect(result.dueAt!.getTime()).toBeLessThanOrEqual(dueAt.getTime());
      // Pin the clamp target itself, so moving it (say to `deadline + slack`)
      // fails here rather than passing on the weaker `<= dueAt` property.
      if (decision === "clamp") expect(result.dueAt!.getTime()).toBe(targetMs);
    }
  });

  it("lets the caller pin the margin independently of the measured constant", () => {
    // The constant is expected to shrink to ~12m40s once BLO-28863 defect 1
    // meets its p95 <= 5m criterion. Callers and tests that care about a
    // boundary should not have to be rewritten when it does.
    const failedAt = new Date("2026-08-19T00:00:00.000Z");
    const result = resolveRoutineScopedRetry({
      dueAt: new Date("2026-08-19T05:59:00.000Z"),
      failedAt,
      routinePeriodMs: SIX_HOURS_MS,
      minUsefulMarginMs: 15 * 60 * 1000,
    });

    expect(result.decision).toBe("clamp");
    expect(result.dueAt?.toISOString()).toBe("2026-08-19T05:45:00.000Z");
  });
});
