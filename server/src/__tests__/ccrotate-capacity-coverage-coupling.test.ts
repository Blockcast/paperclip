import { describe, expect, it } from "vitest";

import {
  CCROTATE_CAPACITY_INTENDED_COVERAGE_MS,
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
 * distinction is easy to lose: the coverage invariant is the only test here
 * that fails on a fresh drift. The derivation test cannot distinguish a derived
 * 48 from a hard-coded 48 — they are the same value today, by construction —
 * so it documents intent rather than catching a regression.
 */
describe("ccrotate capacity coverage coupling (PEN-2407)", () => {
  it("is behaviour-neutral: the shipped attempt count is unchanged at 48", () => {
    // The load-bearing assertion for this change. Coupling the constants must
    // not move any timing; if this fails, the refactor altered live behaviour.
    expect(CCROTATE_CAPACITY_MAX_RETRY_ATTEMPTS).toBe(48);
    expect(CCROTATE_CAPACITY_MAX_PARK_MS).toBe(15 * 60 * 1000);
  });

  it("GUARD: attempts x cap still buys the coverage it claims to buy", () => {
    // This is the test that fails on drift. Tighten the cap and hard-code the
    // count back to 48 — as happened before this change — and the product
    // falls under the declared coverage and this goes red.
    const coveredMs = CCROTATE_CAPACITY_MAX_RETRY_ATTEMPTS * CCROTATE_CAPACITY_MAX_PARK_MS;
    expect(
      coveredMs,
      `${CCROTATE_CAPACITY_MAX_RETRY_ATTEMPTS} attempts x ` +
        `${CCROTATE_CAPACITY_MAX_PARK_MS / 60_000}m cap covers ` +
        `${(coveredMs / HOUR_MS).toFixed(1)}h, short of the declared ` +
        `${CCROTATE_CAPACITY_INTENDED_COVERAGE_MS / HOUR_MS}h`,
    ).toBeGreaterThanOrEqual(CCROTATE_CAPACITY_INTENDED_COVERAGE_MS);
  });

  it("documents the derivation: ceil(intended coverage / park cap)", () => {
    // Intent, not a guard — see the file docblock.
    expect(CCROTATE_CAPACITY_MAX_RETRY_ATTEMPTS).toBe(
      Math.ceil(CCROTATE_CAPACITY_INTENDED_COVERAGE_MS / CCROTATE_CAPACITY_MAX_PARK_MS),
    );
  });

  it("records the open shortfall against the longest recorded outage", () => {
    // Asserts the gap EXISTS and is the size we think it is. It is deliberately
    // not closed here: choosing between buying ~500 attempts of coverage and
    // accepting exhaustion is the unresolved policy question this change
    // surfaces rather than settles.
    const shortfallMs = ccrotateCapacityCoverageShortfallMs();
    expect(shortfallMs).toBeGreaterThan(0);
    expect(shortfallMs / HOUR_MS).toBeCloseTo(112.8, 1);

    const attemptsToCoverRecordedWindow = Math.ceil(
      LONGEST_RECORDED_PROVIDER_CAPACITY_WINDOW_MS / CCROTATE_CAPACITY_MAX_PARK_MS,
    );
    expect(attemptsToCoverRecordedWindow).toBe(500);
    expect(attemptsToCoverRecordedWindow).toBeGreaterThan(CCROTATE_CAPACITY_MAX_RETRY_ATTEMPTS);
  });

  it("keeps the two stale published derivations falsified", () => {
    // heartbeat.ts claimed "48 attempts cover ~7.5 days" off a "4h maximum
    // hop"; ccrotate-capacity-retry.ts claimed "(24) ... roughly six hours".
    // Neither matches the shipped pair. Pinned so removing the reconciliation
    // comment without re-checking the numbers is visible.
    const coveredHours = (CCROTATE_CAPACITY_MAX_RETRY_ATTEMPTS * CCROTATE_CAPACITY_MAX_PARK_MS) / HOUR_MS;
    expect(coveredHours).toBe(12);
    expect(coveredHours).not.toBe(7.5 * 24);
    expect(coveredHours).not.toBe(6);
  });
});
