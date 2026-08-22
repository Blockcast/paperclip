import { describe, expect, it } from "vitest";

import {
  CCROTATE_CAPACITY_ATTEMPT_HARD_CEILING,
  CCROTATE_CAPACITY_MAX_COVERAGE_MS,
  CCROTATE_CAPACITY_MAX_PARK_MS,
  LONGEST_RECORDED_PROVIDER_CAPACITY_WINDOW_MS,
  ccrotateCapacityCoverageShortfallMs,
} from "../services/ccrotate-capacity-retry.js";
import { CCROTATE_CAPACITY_MAX_RETRY_ATTEMPTS } from "../services/heartbeat.js";

const HOUR_MS = 60 * 60 * 1000;

/**
 * PEN-2407. `CCROTATE_CAPACITY_MAX_RETRY_ATTEMPTS` and
 * `CCROTATE_CAPACITY_MAX_PARK_MS` live in different files and multiply into
 * outage coverage. The cap was tightened without re-deriving the count, and the
 * comment predicting exactly that ("Shorten the cap or the max hop and this
 * must grow") was enforced by nobody.
 *
 * Which of these is a guard and which is a pin, stated plainly because the
 * distinction is easy to lose: the coverage GUARD is the only test here that
 * fails on a fresh drift, and it now catches drift in *both* directions —
 * shorten the cap without re-deriving and it goes red, shorten it far enough
 * that the load clamp binds and it goes red too. The derivation test cannot
 * distinguish a derived 48 from a hard-coded 48 — they are the same value
 * today, by construction — so it documents intent rather than catching a
 * regression, and the load-ceiling test is a pin for the same reason.
 *
 * What "coverage" means here, precisely, because the suite would otherwise
 * overclaim: `attempts x cap` is the coverage **ceiling**, not the coverage.
 * Hops resolve to `min(advertised, default, cap)`, so real coverage is
 * `Σ(actual hops)` and is lower — ~4h on the no-advisory path, where the 5m
 * default delay binds instead of the 15m cap. These tests guard the ceiling and
 * the load, which are the two things these constants actually determine.
 */
describe("ccrotate capacity coverage coupling (PEN-2407)", () => {
  it("is behaviour-neutral: the shipped attempt count is unchanged at 48", () => {
    // The load-bearing assertion for this change. Coupling the constants must
    // not move any timing; if this fails, the refactor altered live behaviour.
    expect(CCROTATE_CAPACITY_MAX_RETRY_ATTEMPTS).toBe(48);
    expect(CCROTATE_CAPACITY_MAX_PARK_MS).toBe(15 * 60 * 1000);
    expect(CCROTATE_CAPACITY_ATTEMPT_HARD_CEILING).toBe(96);
  });

  it("GUARD: attempts x cap still buys the coverage ceiling it claims to buy", () => {
    // This is the test that fails on drift. Tighten the cap and hard-code the
    // count back to 48 — as happened before this change — and the product
    // falls under the declared ceiling and this goes red. It also goes red when
    // the cap is shortened far enough that the load clamp binds, which is the
    // intended way "cap and coverage are jointly infeasible" surfaces.
    const coveredMs = CCROTATE_CAPACITY_MAX_RETRY_ATTEMPTS * CCROTATE_CAPACITY_MAX_PARK_MS;
    expect(
      coveredMs,
      `${CCROTATE_CAPACITY_MAX_RETRY_ATTEMPTS} attempts x ` +
        `${CCROTATE_CAPACITY_MAX_PARK_MS / 60_000}m cap covers at most ` +
        `${(coveredMs / HOUR_MS).toFixed(1)}h, short of the declared ceiling of ` +
        `${CCROTATE_CAPACITY_MAX_COVERAGE_MS / HOUR_MS}h`,
    ).toBeGreaterThanOrEqual(CCROTATE_CAPACITY_MAX_COVERAGE_MS);
  });

  it("pins the load ceiling the derivation is clamped against", () => {
    // NOT a guard, and labelled that way on purpose: because the derivation is
    // clamped at this value, `attempts <= ceiling` holds by construction and
    // cannot fail. It pins the budget so removing or widening the clamp is
    // visible in a diff.
    //
    // The test that actually goes red when the load side is violated is the
    // coverage GUARD above: shorten the cap far enough that the clamp binds and
    // the product falls under the declared ceiling. Verified — at a 5m cap the
    // derivation wants 144, the clamp holds it to 96, and 96 x 5m = 8h trips
    // that guard.
    expect(CCROTATE_CAPACITY_MAX_RETRY_ATTEMPTS).toBeLessThanOrEqual(CCROTATE_CAPACITY_ATTEMPT_HARD_CEILING);
  });

  it("documents the derivation: min(ceil(coverage ceiling / park cap), load ceiling)", () => {
    // Intent, not a guard — see the file docblock.
    expect(CCROTATE_CAPACITY_MAX_RETRY_ATTEMPTS).toBe(
      Math.min(
        Math.ceil(CCROTATE_CAPACITY_MAX_COVERAGE_MS / CCROTATE_CAPACITY_MAX_PARK_MS),
        CCROTATE_CAPACITY_ATTEMPT_HARD_CEILING,
      ),
    );
  });

  it("shows the load clamp is not binding at the shipped pair", () => {
    // So 48 is provably the coverage derivation rather than the clamp. Without
    // this, a reader cannot tell which of the two produced the shipped value,
    // and the clamp could silently become the thing setting live behaviour.
    expect(Math.ceil(CCROTATE_CAPACITY_MAX_COVERAGE_MS / CCROTATE_CAPACITY_MAX_PARK_MS)).toBeLessThanOrEqual(
      CCROTATE_CAPACITY_ATTEMPT_HARD_CEILING,
    );
  });

  it("records the open shortfall against the longest recorded outage", () => {
    // Asserts the gap EXISTS and that it is the full subtraction, without
    // hard-coding either side: LONGEST_RECORDED_PROVIDER_CAPACITY_WINDOW_MS is
    // an observational record that gets revised when a worse outage lands, and
    // pinning 112.8h/500 here would redden this suite for a reason unrelated to
    // the coupling invariant. The relationships are what carry meaning.
    //
    // Deliberately not closed: choosing between buying that much coverage and
    // accepting exhaustion is the unresolved policy question this change
    // surfaces rather than settles.
    const shortfallMs = ccrotateCapacityCoverageShortfallMs();
    expect(shortfallMs).toBeGreaterThan(0);
    expect(shortfallMs).toBe(LONGEST_RECORDED_PROVIDER_CAPACITY_WINDOW_MS - CCROTATE_CAPACITY_MAX_COVERAGE_MS);

    const attemptsToCoverRecordedWindow = Math.ceil(
      LONGEST_RECORDED_PROVIDER_CAPACITY_WINDOW_MS / CCROTATE_CAPACITY_MAX_PARK_MS,
    );
    expect(attemptsToCoverRecordedWindow).toBeGreaterThan(CCROTATE_CAPACITY_MAX_RETRY_ATTEMPTS);
    // Covering the recorded window is also out of reach of the load budget, not
    // merely of the current count — which is the real shape of the open
    // decision: it cannot be settled by raising coverage alone.
    expect(attemptsToCoverRecordedWindow).toBeGreaterThan(CCROTATE_CAPACITY_ATTEMPT_HARD_CEILING);
  });

  it("keeps the two stale published derivations falsified", () => {
    // Pinning the ceiling to 12h is what falsifies both stale figures: the
    // "~7.5 days" heartbeat.ts derived off a nonexistent "4h maximum hop", and
    // the "roughly six hours" this file derived when the count was 24. Asserting
    // `not.toBe(180)` / `not.toBe(6)` alongside would add nothing — both are
    // entailed by the equality below and cannot fail independently of it.
    const coveredHours = (CCROTATE_CAPACITY_MAX_RETRY_ATTEMPTS * CCROTATE_CAPACITY_MAX_PARK_MS) / HOUR_MS;
    expect(coveredHours).toBe(12);
  });
});
