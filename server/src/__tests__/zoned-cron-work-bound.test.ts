/**
 * BLO-32638: deterministic work bounds for the next-tick search and the
 * routine fire-gap derivation. They count wall-clock lookups and `Intl`
 * `formatToParts` calls, never wall time, so they cannot flake on a loaded
 * runner.
 *
 * The minute stepper these replace made one `formatToParts` call per UTC
 * minute: ~527,000 for one next tick of a yearly cron, and ~2.6 million to
 * conclude that `0 0 31 2 *` never fires. The routine fire-gap gauge made
 * seven such searches per trigger on every 15 s scrape tick, which is what
 * took helm revision 798 down on 2026-10-11.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { parseCron } from "../services/cron.js";
import {
  deriveRoutineFireGapsMs,
  nextCronTickInTimeZone,
  resetRoutineFireGapsMemoForTests,
} from "../services/routines.js";
import {
  getZonedMinuteParts,
  searchNextZonedCronTick,
  ZONED_CRON_SEARCH_MAX_STEPS,
  type ZonedMinuteParts,
} from "../services/zoned-cron.js";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

// One search pass costs at most 1 + 3 probes + a ~22-step binary search, and
// only a DST transition costs a second pass. 64 allows two transitions. A
// search that steps by day instead of by field would need ~365 for a yearly
// cron, and the minute stepper ~527,000.
const MAX_LOOKUPS_PER_SEARCH = 64;
const MAX_STEPS_PER_SEARCH = 6;

// The 18 active production schedule triggers on 2026-10-11 (helm rev 798).
const PRODUCTION_TRIGGERS: Array<[cron: string, timeZone: string]> = [
  ["45 */6 * * *", "America/Los_Angeles"],
  ["30 */6 * * *", "America/Los_Angeles"],
  ["0 10 * * *", "America/Los_Angeles"],
  ["23 */6 * * *", "UTC"],
  ["7 */6 * * *", "UTC"],
  ["37 */4 * * *", "UTC"],
  ["17 1 * * *", "UTC"],
  ["0 15 * * 1-5", "UTC"],
  ["37 16 * * 1", "UTC"],
  ["0 16 * * 1", "UTC"],
  ["0 15 * * 1", "UTC"],
  ["0 14 * * 1,4", "UTC"],
  ["3 9 * * 1", "UTC"],
  ["0 9 * * 1", "UTC"],
  ["37 6 * * 1", "UTC"],
  ["0 17 1 * *", "UTC"],
  ["7 0 28 * *", "UTC"],
  ["0 9 15 5 *", "UTC"],
];
const INCIDENT_BOOT = new Date("2026-10-11T08:21:24Z");

function search(expression: string, timeZone: string, after: Date) {
  return searchNextZonedCronTick(parseCron(expression), after, (ms) => getZonedMinuteParts(ms, timeZone));
}

let formatToParts: MockInstance<Intl.DateTimeFormat["formatToParts"]>;

beforeEach(() => {
  resetRoutineFireGapsMemoForTests();
  formatToParts = vi.spyOn(Intl.DateTimeFormat.prototype, "formatToParts");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("next-tick search work bound (BLO-32638)", () => {
  it.each([
    // The outage trigger: one yearly tick, from the instant rev 798 booted.
    ["0 9 15 5 *", "UTC", INCIDENT_BOOT, "2027-05-15T09:00:00.000Z"],
    // The same, across two DST transitions on the way.
    ["0 9 15 5 *", "America/New_York", INCIDENT_BOOT, "2027-05-15T13:00:00.000Z"],
    ["0 9 15 5 *", "Australia/Sydney", INCIDENT_BOOT, "2027-05-14T23:00:00.000Z"],
    // Two years to the next leap day.
    ["0 0 29 2 *", "UTC", new Date("2026-03-01T00:00:00Z"), "2028-02-29T00:00:00.000Z"],
    ["0 0 29 2 *", "Europe/Berlin", new Date("2026-03-01T00:00:00Z"), "2028-02-28T23:00:00.000Z"],
    // Never fires: the whole five-year horizon must be ruled out cheaply.
    ["0 0 31 2 *", "UTC", INCIDENT_BOOT, null],
    ["0 0 31 2 *", "America/New_York", INCIDENT_BOOT, null],
    // Fires, but not within the horizon (the next Monday Feb 29 is in 2044).
    ["0 0 29 2 1", "UTC", INCIDENT_BOOT, null],
  ] as const)("bounds %s in %s", (expression, timeZone, after, expected) => {
    const result = search(expression, timeZone, after);
    expect(result.tick?.toISOString() ?? null).toBe(expected);
    expect(result.exhausted).toBe(false);
    expect(result.steps).toBeLessThanOrEqual(MAX_STEPS_PER_SEARCH);
    expect(result.lookups).toBeLessThanOrEqual(MAX_LOOKUPS_PER_SEARCH);

    // The production entry point does the same bounded work through Intl.
    formatToParts.mockClear();
    expect(nextCronTickInTimeZone(expression, timeZone, after)?.toISOString() ?? null).toBe(expected);
    expect(formatToParts.mock.calls.length).toBeGreaterThan(0);
    expect(formatToParts.mock.calls.length).toBeLessThanOrEqual(MAX_LOOKUPS_PER_SEARCH);
  });

  it("bounds every production trigger, chained through its next seven ticks", () => {
    for (const [cron, timeZone] of PRODUCTION_TRIGGERS) {
      let after: Date = INCIDENT_BOOT;
      for (let i = 0; i < 7; i += 1) {
        const result = search(cron, timeZone, after);
        expect(result.tick, `${cron} @ ${timeZone}`).not.toBeNull();
        expect(result.lookups, `${cron} @ ${timeZone} after ${after.toISOString()}`).toBeLessThanOrEqual(MAX_LOOKUPS_PER_SEARCH);
        expect(result.steps).toBeLessThanOrEqual(MAX_STEPS_PER_SEARCH);
        after = result.tick!;
      }
    }
  });

  it("gives up after the step budget even when the clock defeats every assumption", () => {
    // An adversarial "zone" whose offset grows by a minute every minute (its
    // wall clock runs at double speed), so every probe sees a transition and
    // each pass advances one minute. That breaks both properties the search
    // relies on. It must still stop after ZONED_CRON_SEARCH_MAX_STEPS passes
    // and report "no tick" rather than spin.
    const origin = INCIDENT_BOOT.getTime();
    let lookups = 0;
    const result = searchNextZonedCronTick(parseCron("0 0 31 2 *"), INCIDENT_BOOT, (ms): ZonedMinuteParts => {
      lookups += 1;
      const wall = new Date(ms + Math.floor((ms - origin) / MINUTE_MS) * MINUTE_MS);
      return {
        year: wall.getUTCFullYear(),
        month: wall.getUTCMonth() + 1,
        day: wall.getUTCDate(),
        hour: wall.getUTCHours(),
        minute: wall.getUTCMinutes(),
        weekday: wall.getUTCDay(),
      };
    });
    expect(result.exhausted).toBe(true);
    expect(result.tick).toBeNull();
    expect(result.steps).toBe(ZONED_CRON_SEARCH_MAX_STEPS);
    expect(result.lookups).toBe(lookups);
    // 1 lookup at the cursor, 3 probes and a <=22-step binary search per pass.
    expect(lookups).toBeGreaterThan(ZONED_CRON_SEARCH_MAX_STEPS);
    expect(lookups).toBeLessThanOrEqual(ZONED_CRON_SEARCH_MAX_STEPS * 26);
  });
});

describe("deriveRoutineFireGapsMs work bound and memo (BLO-32638)", () => {
  it("derives each production trigger with bounded Intl work, then serves it from the memo", () => {
    const derived = new Map<string, { minMs: number; maxMs: number } | null>();
    for (const [cron, timeZone] of PRODUCTION_TRIGGERS) {
      formatToParts.mockClear();
      const gaps = deriveRoutineFireGapsMs({ kind: "schedule", cronExpression: cron, timezone: timeZone }, INCIDENT_BOOT);
      expect(gaps, `${cron} @ ${timeZone}`).not.toBeNull();
      // Seven next-tick searches per derivation.
      expect(formatToParts.mock.calls.length, `${cron} @ ${timeZone}`).toBeLessThanOrEqual(7 * MAX_LOOKUPS_PER_SEARCH);
      derived.set(`${cron}|${timeZone}`, gaps);
    }

    // One scrape tick later nothing has fired, so nothing is re-derived.
    const nextScrape = new Date(INCIDENT_BOOT.getTime() + 15_000);
    formatToParts.mockClear();
    for (const [cron, timeZone] of PRODUCTION_TRIGGERS) {
      expect(deriveRoutineFireGapsMs({ kind: "schedule", cronExpression: cron, timezone: timeZone }, nextScrape))
        .toEqual(derived.get(`${cron}|${timeZone}`));
    }
    expect(formatToParts.mock.calls.length).toBe(0);
  });

  it("derives the yearly trigger's real gaps, leap years included", () => {
    // Ticks from 2027-05-15: the 2028 and 2032 gaps span a Feb 29.
    expect(
      deriveRoutineFireGapsMs({ kind: "schedule", cronExpression: "0 9 15 5 *", timezone: "UTC" }, INCIDENT_BOOT),
    ).toEqual({ minMs: 365 * DAY_MS, maxMs: 366 * DAY_MS });
  });

  it("re-derives once the first sampled tick has passed, and only then", () => {
    const trigger = { kind: "schedule", cronExpression: "37 */4 * * *", timezone: "UTC" } as const;
    expect(deriveRoutineFireGapsMs(trigger, INCIDENT_BOOT)).toEqual({ minMs: 4 * HOUR_MS, maxMs: 4 * HOUR_MS });

    // 08:36:59 is still before the 08:37 tick: memo hit.
    formatToParts.mockClear();
    deriveRoutineFireGapsMs(trigger, new Date("2026-10-11T08:36:59Z"));
    expect(formatToParts.mock.calls.length).toBe(0);

    // 08:37:00 is the tick itself, so the sample now starts at 12:37: re-derived.
    formatToParts.mockClear();
    expect(deriveRoutineFireGapsMs(trigger, new Date("2026-10-11T08:37:00Z"))).toEqual({ minMs: 4 * HOUR_MS, maxMs: 4 * HOUR_MS });
    expect(formatToParts.mock.calls.length).toBeGreaterThan(0);
    expect(formatToParts.mock.calls.length).toBeLessThanOrEqual(7 * MAX_LOOKUPS_PER_SEARCH);
  });

  it("returns a copy, so a caller cannot corrupt the memo", () => {
    const trigger = { kind: "schedule", cronExpression: "0 15 * * 1-5", timezone: "UTC" } as const;
    const first = deriveRoutineFireGapsMs(trigger, INCIDENT_BOOT)!;
    expect(first).toEqual({ minMs: 24 * HOUR_MS, maxMs: 72 * HOUR_MS });
    first.minMs = 1;
    expect(deriveRoutineFireGapsMs(trigger, INCIDENT_BOOT)).toEqual({ minMs: 24 * HOUR_MS, maxMs: 72 * HOUR_MS });
  });
});
