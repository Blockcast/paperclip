import { describe, expect, it } from "vitest";

import {
  CCROTATE_CAPACITY_MAX_PARK_MS,
  CCROTATE_CAPACITY_PARK_JITTER_RATIO,
  LONGEST_RECORDED_PROVIDER_CAPACITY_WINDOW_MS,
  MAX_TRANSIENT_RETRY_HORIZON_MS,
  TRANSIENT_HORIZON_CLAMP_MIN_ATTEMPTS,
  clampTransientRetryHorizon,
  resolveCcrotateCapacityRetry,
} from "../services/ccrotate-capacity-retry.js";

/**
 * BLO-23438. On 2026-08-08 penstock answered a `claude-sonnet-5[1m]` capacity
 * denial with `retry_after_seconds: 449933` (~5.2 days). The scheduler stored
 * that verbatim, so ~76 runs parked to 2026-08-14T02:59:59Z within a 3.4h
 * window. By 2026-08-09T00:54Z the same endpoint reported `state: "available"`
 * (4/6 healthy routes) — nothing re-probed, because the promotion-time capacity
 * check only runs once `scheduledRetryAt <= now` and can therefore only extend
 * a park.
 *
 * Note the filed hypothesis (ccrotate's `reset7d` used where `reset5h` was
 * meant) was refuted: neither identifier appears in server source, and the
 * horizon comes from penstock's own `resume_at`/`retry_after_seconds`.
 */

const NOW = new Date("2026-08-09T00:00:00.000Z");
const DEFAULT_RETRY_DELAY_MS = 5 * 60 * 1000;

// Deterministic stand-in for Math.random so jitter assertions are exact.
function fixedRandom(value: number) {
  return () => value;
}

describe("resolveCcrotateCapacityRetry", () => {
  it("clamps an advertised reset beyond the ceiling to the ceiling, and records what it declined", () => {
    // The exact production value: 449933s past the denial.
    const advertised = new Date(NOW.getTime() + 449_933 * 1000);

    const plan = resolveCcrotateCapacityRetry({
      resumeAt: advertised,
      now: NOW,
      defaultRetryDelayMs: DEFAULT_RETRY_DELAY_MS,
      random: fixedRandom(0),
    });

    expect(plan.retryAt.getTime()).toBe(NOW.getTime() + CCROTATE_CAPACITY_MAX_PARK_MS);
    // Legible without reading code: the horizon we refused is on the row.
    expect(plan.clampedFromIso).toBe(advertised.toISOString());
    expect(plan.advertisedDelaySeconds).toBe(449_933);
    // The AC's headline: never park a rate-limit deferral more than 24h out.
    expect(plan.retryAt.getTime() - NOW.getTime()).toBeLessThan(24 * 60 * 60 * 1000);
  });

  it("honours an advertised reset that falls inside the ceiling, rather than always polling", () => {
    // A genuine short window: 90s out. Retrying earlier would just hammer.
    const advertised = new Date(NOW.getTime() + 90_000);

    const plan = resolveCcrotateCapacityRetry({
      resumeAt: advertised,
      now: NOW,
      defaultRetryDelayMs: DEFAULT_RETRY_DELAY_MS,
      random: fixedRandom(0),
    });

    expect(plan.retryAt.getTime()).toBe(advertised.getTime());
    expect(plan.clampedFromIso).toBeNull();
  });

  it("never schedules earlier than an advertised reset it chose to honour", () => {
    const advertised = new Date(NOW.getTime() + 90_000);

    for (const roll of [0, 0.25, 0.5, 0.99]) {
      const plan = resolveCcrotateCapacityRetry({
        resumeAt: advertised,
        now: NOW,
        defaultRetryDelayMs: DEFAULT_RETRY_DELAY_MS,
        random: fixedRandom(roll),
      });
      expect(plan.retryAt.getTime()).toBeGreaterThanOrEqual(advertised.getTime());
    }
  });

  it("falls back to the default poll delay when no usable reset was advertised", () => {
    for (const resumeAt of [null, new Date(NOW.getTime() - 60_000)]) {
      const plan = resolveCcrotateCapacityRetry({
        resumeAt,
        now: NOW,
        defaultRetryDelayMs: DEFAULT_RETRY_DELAY_MS,
        random: fixedRandom(0),
      });
      // A reset already in the past says nothing about the future.
      expect(plan.retryAt.getTime()).toBe(NOW.getTime() + DEFAULT_RETRY_DELAY_MS);
      expect(plan.advertisedDelaySeconds).toBeNull();
    }
  });

  it("spreads a cohort denied against one reset instead of releasing it in lockstep", () => {
    // Reproduces the shape of the incident: N runs, one advertised horizon.
    const advertised = new Date(NOW.getTime() + 449_933 * 1000);
    const cohortSize = 76;

    const timestamps = Array.from({ length: cohortSize }, (_, i) =>
      resolveCcrotateCapacityRetry({
        resumeAt: advertised,
        now: NOW,
        defaultRetryDelayMs: DEFAULT_RETRY_DELAY_MS,
        // Distinct rolls stand in for independent Math.random draws.
        random: fixedRandom(i / cohortSize),
      }).retryAt.getTime(),
    );

    // The defect was 76 identical timestamps, to the millisecond.
    expect(new Set(timestamps).size).toBe(cohortSize);

    const ceiling = NOW.getTime() + CCROTATE_CAPACITY_MAX_PARK_MS;
    const maxJitterMs = CCROTATE_CAPACITY_MAX_PARK_MS * CCROTATE_CAPACITY_PARK_JITTER_RATIO;
    for (const ts of timestamps) {
      expect(ts).toBeGreaterThanOrEqual(ceiling);
      expect(ts).toBeLessThanOrEqual(ceiling + maxJitterMs);
    }
  });

  it("keeps real Math.random inside the jitter window", () => {
    // Guards the default path the production call sites actually take.
    const advertised = new Date(NOW.getTime() + 449_933 * 1000);
    const ceiling = NOW.getTime() + CCROTATE_CAPACITY_MAX_PARK_MS;
    const maxJitterMs = CCROTATE_CAPACITY_MAX_PARK_MS * CCROTATE_CAPACITY_PARK_JITTER_RATIO;

    for (let i = 0; i < 200; i++) {
      const plan = resolveCcrotateCapacityRetry({
        resumeAt: advertised,
        now: NOW,
        defaultRetryDelayMs: DEFAULT_RETRY_DELAY_MS,
      });
      expect(plan.retryAt.getTime()).toBeGreaterThanOrEqual(ceiling);
      expect(plan.retryAt.getTime()).toBeLessThanOrEqual(ceiling + maxJitterMs);
    }
  });
});

/**
 * The second, independent route to the same multi-day park: a finalized run's
 * `retryNotBefore` is treated by scheduleBoundedRetryForRun as an *uncapped*
 * floor. The in-run k8s ccrotate loop (BLO-18278) breaks out deliberately to
 * hand this scheduler the advertised reset, so clamping only the capacity gate
 * would leave this path freezing runs exactly as before.
 */
describe("clampTransientRetryHorizon", () => {
  it("clamps a floor beyond the horizon ceiling and records what it declined", () => {
    const advertised = new Date(NOW.getTime() + 449_933 * 1000);

    const result = clampTransientRetryHorizon({ retryNotBefore: advertised, now: NOW });

    expect(result.dueAt.getTime()).toBe(NOW.getTime() + MAX_TRANSIENT_RETRY_HORIZON_MS);
    expect(result.clampedFromIso).toBe(advertised.toISOString());
  });

  it("leaves ordinary provider backoff untouched", () => {
    // These are no-ops for the clamp, which is all this case asserts. It used to
    // also claim "every horizon the fleet schedules today is shorter than the
    // ceiling" — BLO-28919 measured that and it was false: p90 == max == exactly
    // 24h on 484 parks, i.e. the ceiling was binding, not idle. The blast-radius
    // claim is gone; the no-op behaviour it was attached to still holds.
    for (const delayMs of [0, 1_000, 60_000, 5 * 60_000, 60 * 60_000, 23 * 60 * 60_000]) {
      const floor = new Date(NOW.getTime() + delayMs);
      const result = clampTransientRetryHorizon({ retryNotBefore: floor, now: NOW });
      expect(result.dueAt.getTime()).toBe(floor.getTime());
      expect(result.clampedFromIso).toBeNull();
    }
  });

  it("treats the ceiling itself as in-bounds rather than clamping it", () => {
    const exactly = new Date(NOW.getTime() + MAX_TRANSIENT_RETRY_HORIZON_MS);
    const result = clampTransientRetryHorizon({ retryNotBefore: exactly, now: NOW });
    expect(result.dueAt.getTime()).toBe(exactly.getTime());
    expect(result.clampedFromIso).toBeNull();
  });

  it("only ever shortens a wait", () => {
    for (const delayMs of [1_000, 60_000, 449_933_000, 30 * 24 * 60 * 60_000]) {
      const floor = new Date(NOW.getTime() + delayMs);
      const result = clampTransientRetryHorizon({ retryNotBefore: floor, now: NOW });
      expect(result.dueAt.getTime()).toBeLessThanOrEqual(floor.getTime());
    }
  });
});

/**
 * BLO-23525. `clampTransientRetryHorizon` caps a floor-carrying run at
 * MAX_TRANSIENT_RETRY_HORIZON_MS per attempt, but a cap without a matching
 * attempt ceiling just relocates BLO-23438's exhaustion trap: the generic
 * `transient_upstream` family's ordinary ceiling (4 attempts, sized for
 * hintless exponential backoff) covers only 96h once every attempt is capped
 * at 24h — short of the 124.8h outage recorded on BLO-22844.
 * TRANSIENT_HORIZON_CLAMP_MIN_ATTEMPTS is the attempt count
 * scheduleBoundedRetryForRun raises a clamped family's ceiling to, and it
 * must be *derived* from the cap and the recorded worst case, not hand-picked
 * — this suite is what would catch a future edit to either constant that
 * silently reopens the gap.
 */
describe("TRANSIENT_HORIZON_CLAMP_MIN_ATTEMPTS coverage invariant (BLO-23525)", () => {
  it("is derived, not hand-picked: ceil(longest recorded outage / horizon cap)", () => {
    expect(TRANSIENT_HORIZON_CLAMP_MIN_ATTEMPTS).toBe(
      Math.ceil(LONGEST_RECORDED_PROVIDER_CAPACITY_WINDOW_MS / MAX_TRANSIENT_RETRY_HORIZON_MS),
    );
  });

  it("covers the longest recorded provider-capacity outage (BLO-22844, 124.8h)", () => {
    const coveredMs = TRANSIENT_HORIZON_CLAMP_MIN_ATTEMPTS * MAX_TRANSIENT_RETRY_HORIZON_MS;
    const coveredHours = coveredMs / (60 * 60 * 1000);
    const worstCaseHours = LONGEST_RECORDED_PROVIDER_CAPACITY_WINDOW_MS / (60 * 60 * 1000);
    const shortfallHours = worstCaseHours - coveredHours;
    expect(
      coveredMs,
      `${TRANSIENT_HORIZON_CLAMP_MIN_ATTEMPTS} attempts * ${MAX_TRANSIENT_RETRY_HORIZON_MS / (60 * 60 * 1000)}h cap ` +
        `covers ${coveredHours.toFixed(1)}h, ${shortfallHours > 0 ? `short ${shortfallHours.toFixed(1)}h of` : "meeting"} ` +
        `the ${worstCaseHours.toFixed(1)}h window seen on BLO-22844`,
    ).toBeGreaterThanOrEqual(LONGEST_RECORDED_PROVIDER_CAPACITY_WINDOW_MS);
  });

  it("documents the shortfall the old hintless ceiling (4 attempts) would have left", () => {
    // BOUNDED_TRANSIENT_HEARTBEAT_RETRY_MAX_ATTEMPTS pre-BLO-23525 — the
    // ceiling a clamped transient_upstream run was left at before this fix
    // gave clamped families their own, derived ceiling.
    const OLD_HINTLESS_CEILING_ATTEMPTS = 4;
    const coveredMs = OLD_HINTLESS_CEILING_ATTEMPTS * MAX_TRANSIENT_RETRY_HORIZON_MS;
    const coveredHours = coveredMs / (60 * 60 * 1000);
    const worstCaseHours = LONGEST_RECORDED_PROVIDER_CAPACITY_WINDOW_MS / (60 * 60 * 1000);
    const shortfallHours = worstCaseHours - coveredHours;
    expect(
      shortfallHours,
      `${OLD_HINTLESS_CEILING_ATTEMPTS} attempts * ${MAX_TRANSIENT_RETRY_HORIZON_MS / (60 * 60 * 1000)}h cap ` +
        `covers only ${coveredHours.toFixed(1)}h, short ${shortfallHours.toFixed(1)}h of the ${worstCaseHours.toFixed(1)}h window seen on BLO-22844`,
    ).toBeGreaterThan(0);
    // The raised, derived ceiling must actually close that gap.
    expect(TRANSIENT_HORIZON_CLAMP_MIN_ATTEMPTS).toBeGreaterThan(OLD_HINTLESS_CEILING_ATTEMPTS);
  });
});

/**
 * BLO-28919 — the fourth path. `retryNotBefore` has TWO writers and they
 * disagreed about its ceiling:
 *
 *   - `persistProviderCapacityRetry` (wake gate) runs the advertised reset
 *     through `resolveCcrotateCapacityRetry` and persists the CLAMPED instant,
 *     because `scheduleBoundedRetryForRun` treats the field as a retry floor.
 *   - the finalize writer (`effectiveRetryNotBefore` in heartbeat.ts) persisted
 *     the advertised reset verbatim, so the identical capacity denial fell
 *     through to the generic 24h backstop instead of the 15m capacity ceiling.
 *
 * One field, one consumer, two ceilings 96x apart. Measured 2026-08-19 on a full
 * parked census: 484/700 fleet parks under `transient_failure` at p50 4.6h with
 * p90 == max == exactly 1440.0m (the backstop binding), while correctly-gated
 * capacity parks sat at 17.9m. ~99% of that population was floor-driven: 244
 * rows at attempt 1 against a base curve whose first slot is 1.5-2.5m, with only
 * 3 rows landing inside 5m.
 *
 * These assert the invariant that keeps the two writers from drifting again,
 * which is the thing three prior fixes on this class did not have.
 */
describe("capacity floor ceiling is writer-independent (BLO-28919)", () => {
  // Every advertised horizon observed in the incident record for this class,
  // plus the census percentiles that showed the 24h backstop binding.
  const ADVERTISED_HORIZONS_MS = [
    16_763 * 1000, // CEO's run 0b6f4d4f, prose-parsed "capacity may reset at"
    13_974 * 1000, // hit live while fixing this, 2026-08-20
    4.6 * 60 * 60 * 1000, // census p50
    24 * 60 * 60 * 1000, // census p90 == max: the backstop itself
    449_933 * 1000, // BLO-23438, ~5.2 days
    124.8 * 60 * 60 * 1000, // BLO-22844, longest recorded outage
  ];

  it("bounds every recorded capacity horizon by the capacity ceiling, not the 24h backstop", () => {
    for (const advertisedMs of ADVERTISED_HORIZONS_MS) {
      const plan = resolveCcrotateCapacityRetry({
        resumeAt: new Date(NOW.getTime() + advertisedMs),
        now: NOW,
        defaultRetryDelayMs: DEFAULT_RETRY_DELAY_MS,
        random: fixedRandom(0.999),
      });

      const parkMs = plan.retryAt.getTime() - NOW.getTime();
      const ceilingWithJitter =
        CCROTATE_CAPACITY_MAX_PARK_MS * (1 + CCROTATE_CAPACITY_PARK_JITTER_RATIO);

      expect(
        parkMs,
        `an advertised ${(advertisedMs / (60 * 60 * 1000)).toFixed(2)}h capacity horizon must park ` +
          `within the ${CCROTATE_CAPACITY_MAX_PARK_MS / 60_000}m capacity ceiling (+jitter), not the ` +
          `${MAX_TRANSIENT_RETRY_HORIZON_MS / (60 * 60 * 1000)}h generic backstop`,
      ).toBeLessThanOrEqual(ceilingWithJitter);
    }
  });

  it("is strictly tighter than the generic backstop for the measured population", () => {
    // The severity inversion, stated as an invariant: the same error must never
    // be cheaper to recover from merely because it was labelled capacity.
    expect(CCROTATE_CAPACITY_MAX_PARK_MS).toBeLessThan(MAX_TRANSIENT_RETRY_HORIZON_MS);
    // The 96x gap the census measured. If someone retunes either constant, this
    // is the line that makes them look at the other one.
    expect(MAX_TRANSIENT_RETRY_HORIZON_MS / CCROTATE_CAPACITY_MAX_PARK_MS).toBe(96);
  });

  it("only ever shortens a park, so a stale or near floor is never pushed out", () => {
    // The finalize writer adopts the clamp only when it lands EARLIER than what
    // was advertised. `resolveCcrotateCapacityRetry` falls back to its default
    // poll delay for an absent/stale/unparseable instant, which would otherwise
    // delay a run whose floor already passed — the one way this fix could have
    // made a park worse rather than better.
    for (const advertisedMs of [1_000, 30_000, 60_000, 5 * 60_000]) {
      const advertised = new Date(NOW.getTime() + advertisedMs);
      const plan = resolveCcrotateCapacityRetry({
        resumeAt: advertised,
        now: NOW,
        defaultRetryDelayMs: DEFAULT_RETRY_DELAY_MS,
        random: fixedRandom(0),
      });
      // Inside the ceiling the advertised instant is honoured as-is, so the
      // clamp does not apply and the writer keeps the provider's value.
      expect(plan.retryAt.getTime()).toBe(advertised.getTime());
      expect(plan.clampedFromIso).toBeNull();
    }
  });

  it("keeps a hintless transient failure on the base curve (no floor to clamp)", () => {
    // The other half of the split-check. A `transient_failure` with no advertised
    // floor must be untouched by any of this: it has no capacity horizon, so the
    // exponential base curve (2m/10m/30m/2h) remains its only schedule. Asserted
    // here as the contract the finalize writer relies on — it gates the clamp on
    // a throttle family AND a present floor, so a hintless run cannot reach it.
    const plan = resolveCcrotateCapacityRetry({
      resumeAt: null,
      now: NOW,
      defaultRetryDelayMs: DEFAULT_RETRY_DELAY_MS,
      random: fixedRandom(0),
    });
    // With no advertisement there is nothing to clamp *from*, so the resolver
    // reports no declined horizon — which is what makes the finalize writer's
    // "adopt only if earlier" test fail closed and leave the run on its curve.
    expect(plan.clampedFromIso).toBeNull();
    expect(plan.advertisedDelaySeconds).toBeNull();
  });
});

