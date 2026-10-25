/**
 * PEN-4711: `paperclip_routine_fire_interval_seconds` is the denominator of
 * `PaperclipRoutineFireGap` (`age > 2 * interval`), and it must be the LONGEST
 * gap the cron legitimately schedules or the alert pages on healthy behaviour.
 *
 * The sampling walk is bounded in ticks, not time, so a cron firing more than
 * ~6 times a week never reached its own day-skip gap. Measured in production:
 * `0 9,14 * * 1-5` published 19h (the overnight gap) against a legitimate 67h
 * Fri -> Mon idle, so the alert fired for ~28h every weekend on a routine that
 * was working perfectly.
 *
 * The regression these lock down is directional and time-dependent: the old
 * code was CORRECT when sampled mid-week and wrong only once the first tick
 * after `now` had moved past the weekend. A weekday-sampled test passes against
 * the bug, so every case here samples from the failing instants too.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  deriveRoutineFireAgeHorizonMs,
  deriveRoutineFireGapsMs,
  resetRoutineFireGapsMemoForTests,
} from "./routines.js";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const JITTER_MS = MINUTE_MS;

// 2026-10-19 is a Monday, so these span one whole week of sampling instants.
const SAMPLED_AT = {
  monday: new Date("2026-10-19T00:00:00.000Z"),
  wednesday: new Date("2026-10-21T12:00:00.000Z"),
  // The old sampler flipped to the correct answer here and back again on
  // Friday evening, so these two bracket the defect.
  thursday: new Date("2026-10-22T18:00:00.000Z"),
  friday: new Date("2026-10-23T18:00:00.000Z"),
  saturday: new Date("2026-10-24T12:00:00.000Z"),
  // The instant PEN-4347 was triaged, mid-false-page.
  sunday: new Date("2026-10-25T05:13:00.000Z"),
} as const;
const EVERY_DAY = Object.values(SAMPLED_AT);

function gapsFor(cronExpression: string, now: Date, timezone = "UTC") {
  resetRoutineFireGapsMemoForTests();
  return deriveRoutineFireGapsMs({ kind: "schedule", cronExpression, timezone }, now);
}

describe("routine fire-gap interval (PEN-4711)", () => {
  beforeEach(() => {
    resetRoutineFireGapsMemoForTests();
  });

  describe("day-skip gaps a tick-bounded walk cannot reach", () => {
    // The two production routines that false-paged. Both fire 10x a week, so
    // six gaps span only three days and never reach Fri -> Mon.
    it.each([
      // cron, longest legitimate gap, shortest gap
      ["0 9,14 * * 1-5", 67 * HOUR_MS, 5 * HOUR_MS],
      ["0 9,13 * * 1-5", 68 * HOUR_MS, 4 * HOUR_MS],
    ])("reports the weekend gap for %s from every day of the week", (cron, maxMs, minMs) => {
      for (const now of EVERY_DAY) {
        expect(gapsFor(cron, now), `${cron} sampled ${now.toISOString()}`)
          .toEqual({ minMs, maxMs });
      }
    });

    // The invariant the defect broke: the cadence of a cron is a property of
    // the cron, not of the instant it happens to be sampled at.
    it("is independent of the sampling instant", () => {
      const sampled = EVERY_DAY.map((now) => gapsFor("0 9,14 * * 1-5", now));
      expect(new Set(sampled.map((g) => JSON.stringify(g))).size).toBe(1);
    });

    // Three fires a day: six gaps span barely two days.
    it("reaches the weekend gap on a thrice-daily weekday cron", () => {
      expect(gapsFor("0 9,13,17 * * 1-5", SAMPLED_AT.sunday))
        .toEqual({ minMs: 4 * HOUR_MS, maxMs: 64 * HOUR_MS });
    });

    // An hourly weekday cron needs 169 ticks to span a week -- far past the
    // search budget BLO-32638 imposes, and the case that makes walking further
    // the wrong fix rather than merely an expensive one.
    it("reaches the weekend gap on an hourly weekday cron", () => {
      expect(gapsFor("0 * * * 1-5", SAMPLED_AT.sunday))
        .toEqual({ minMs: HOUR_MS, maxMs: 49 * HOUR_MS });
    });

    // A mid-week skip, to show the stride is the largest run of skipped days
    // and not "the weekend" specially.
    it("uses the largest stride on a cron that skips days mid-week", () => {
      expect(gapsFor("0 10 * * 1,3,5", SAMPLED_AT.sunday))
        .toEqual({ minMs: 48 * HOUR_MS, maxMs: 72 * HOUR_MS });
    });

    // A within-day gap longer than the overnight one, to show the two sources
    // compose rather than one masking the other: Fri 23:00 -> Mon 01:00 = 50h.
    it("composes a long within-day gap with the day skip", () => {
      expect(gapsFor("0 1,23 * * 1-5", SAMPLED_AT.sunday))
        .toEqual({ minMs: 2 * HOUR_MS, maxMs: 50 * HOUR_MS });
    });
  });

  describe("unchanged behaviour", () => {
    // These already sampled correctly: at <=6 fires a week the walk does span
    // the week. They are here so the arithmetic path cannot drift away from the
    // measured one where both apply.
    it.each([
      ["0 9 * * 1-5", 72 * HOUR_MS, 24 * HOUR_MS],
      ["0 15 * * 1-5", 72 * HOUR_MS, 24 * HOUR_MS],
    ])("agrees with the walk on %s, which was already correct", (cron, maxMs, minMs) => {
      for (const now of EVERY_DAY) {
        expect(gapsFor(cron, now), `${cron} sampled ${now.toISOString()}`)
          .toEqual({ minMs, maxMs });
      }
    });

    it.each([
      ["0 6 * * *", 24 * HOUR_MS],
      ["23 */6 * * *", 6 * HOUR_MS],
      ["*/15 * * * *", 15 * MINUTE_MS],
    ])("leaves a cron that skips no day alone: %s", (cron, gap) => {
      expect(gapsFor(cron, SAMPLED_AT.sunday)).toEqual({ minMs: gap, maxMs: gap });
    });

    // A restricted day-of-month or month field means the pattern is not weekly,
    // so the arithmetic path declines it and the walk still answers.
    it("leaves a yearly cron to the walk", () => {
      expect(gapsFor("0 9 15 5 *", SAMPLED_AT.sunday))
        .toEqual({ minMs: 365 * DAY_MS, maxMs: 366 * DAY_MS });
    });

    // Sampled from 2026-10-25 the first tick is 2026-11-01, so the six gaps
    // run Nov -> May and include February 2027 (28 days, not a leap year).
    it("leaves a monthly cron to the walk", () => {
      expect(gapsFor("0 17 1 * *", SAMPLED_AT.sunday))
        .toEqual({ minMs: 28 * DAY_MS, maxMs: 31 * DAY_MS });
    });
  });

  // BLO-31996: `minMs` bounds how long one fire may hold the dispatch lock. A
  // day-skip gap is by construction never the SHORTEST gap, so widening
  // `maxMs` must not move it -- otherwise a Thursday wedge would hold the lock
  // until the following Tuesday, which is the bug that sizing read as `minMs`
  // in the first place.
  describe("dispatch-lock horizon is untouched", () => {
    it.each([
      ["0 9,14 * * 1-5", 5 * HOUR_MS],
      ["0 9,13 * * 1-5", 4 * HOUR_MS],
      ["0 9 * * 1-5", 24 * HOUR_MS],
      ["0 1,23 * * 1-5", 2 * HOUR_MS],
    ])("keeps the %s horizon at its shortest gap", (cron, shortest) => {
      for (const now of EVERY_DAY) {
        resetRoutineFireGapsMemoForTests();
        expect(
          deriveRoutineFireAgeHorizonMs({ kind: "schedule", cronExpression: cron, timezone: "UTC" }, now),
          `${cron} sampled ${now.toISOString()}`,
        ).toBe(shortest - JITTER_MS);
      }
    });
  });

  // The arithmetic path counts a stride in calendar days at 24h each, so a gap
  // spanning a DST transition is an hour out either way. That is deliberate and
  // immaterial against the alert's 2x multiplier, but it must stay bounded to
  // an hour rather than collapsing or inverting.
  it("stays within an hour of the true gap across a DST transition", () => {
    // 2026-03-29 is the European spring-forward Sunday.
    const gaps = gapsFor("0 9,14 * * 1-5", new Date("2026-03-29T03:00:00.000Z"), "Europe/London")!;
    expect(gaps.maxMs).toBeGreaterThanOrEqual(66 * HOUR_MS);
    expect(gaps.maxMs).toBeLessThanOrEqual(68 * HOUR_MS);
    expect(gaps.minMs).toBe(5 * HOUR_MS);
  });

  it("returns null for a trigger with no cadence to derive", () => {
    expect(deriveRoutineFireGapsMs({ kind: "webhook", cronExpression: null, timezone: null }, SAMPLED_AT.sunday))
      .toBeNull();
    expect(gapsFor("not a cron", SAMPLED_AT.sunday)).toBeNull();
  });
});
