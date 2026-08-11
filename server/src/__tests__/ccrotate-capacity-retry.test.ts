import { describe, expect, it } from "vitest";

import {
  CCROTATE_CAPACITY_MAX_PARK_MS,
  CCROTATE_CAPACITY_PARK_JITTER_RATIO,
  MAX_TRANSIENT_RETRY_HORIZON_MS,
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
    // The blast-radius claim: every horizon the fleet schedules today is
    // shorter than the ceiling, so this clamp must be a no-op for all of them.
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
