/**
 * BLO-32638: the bounded next-tick search must return exactly what the minute
 * stepper it replaced returned. The oracle is that stepper, copied verbatim
 * into helpers/legacy-next-cron-tick-in-time-zone.ts.
 *
 * The oracle walks one UTC minute at a time (~3 us per minute on a laptop, ten
 * times that on a loaded CI runner), so this always-on matrix keeps every walk
 * short: start instants sit a few hours before each zone's DST transitions and
 * just before month and year ends, and ticks are chained a few times so daily
 * crons cross the transition. The yearly and monthly production crons get
 * hand-computed expected values here instead of a full oracle walk.
 *
 * PAPERCLIP_CRON_EQUIVALENCE_EXHAUSTIVE=1 adds a long run: every supported
 * time zone around its own 2026-2027 transitions, the multi-year walks
 * (yearly, Feb 29, Feb 31), every production trigger's fire-gap derivation,
 * and a seeded random sweep.
 */
import { describe, expect, it } from "vitest";
import {
  deriveRoutineFireGapsMs,
  nextCronTickInTimeZone,
  resetRoutineFireGapsMemoForTests,
} from "../services/routines.js";
import { nextCronTickInTimeZone as legacyNextCronTickInTimeZone } from "./helpers/legacy-next-cron-tick-in-time-zone.js";

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

function iso(date: Date | null) {
  return date === null ? null : date.toISOString();
}

/** Follow `chain` consecutive ticks from `start` with both implementations; return every disagreement. */
function compareChain(expression: string, timeZone: string, start: string, chain: number) {
  const mismatches: string[] = [];
  let after = new Date(start);
  for (let i = 0; i < chain; i += 1) {
    const expected = legacyNextCronTickInTimeZone(expression, timeZone, after);
    const actual = nextCronTickInTimeZone(expression, timeZone, after);
    if (iso(actual) !== iso(expected)) {
      mismatches.push(`${expression} @ ${timeZone} after ${after.toISOString()}: legacy=${iso(expected)} new=${iso(actual)}`);
    }
    if (expected === null) break;
    after = expected;
  }
  return mismatches;
}

// Wall times inside, at the edge of, and either side of the repeated and the
// skipped hour, plus sub-hourly and multi-hour cadences.
const SUB_DAILY = ["*/7 * * * *", "15,45 * * * *", "0 * * * *", "45 */6 * * *", "37 */4 * * *"];
const DAILY = ["30 2 * * *", "30 1 * * *", "0 3 * * *", "0 0 * * *"];
// DST changes land on Sundays in all of these zones, and each start below is
// within a day of one.
const SUNDAY_EARLY = "0,30 1-3 * * 0";

const DST_WINDOWS: Array<{ label: string; starts: string[]; zones: string[] }> = [
  {
    label: "North America (2026-03-08 and 2026-11-01)",
    starts: ["2026-03-08T04:00:00Z", "2026-11-01T03:30:00Z", "2026-11-01T07:30:00Z"],
    zones: ["America/New_York", "America/Los_Angeles", "America/St_Johns"],
  },
  {
    label: "Europe, and Troll's two-hour shift (2026-03-29 and 2026-10-25)",
    starts: ["2026-03-28T23:00:00Z", "2026-10-24T23:30:00Z"],
    zones: ["Europe/London", "Europe/Berlin", "Antarctica/Troll"],
  },
  {
    label: "southern hemisphere, incl. Lord Howe's 30-minute shift (2026-04-05, 2026-09-27, 2026-10-04)",
    starts: ["2026-04-04T12:30:00Z", "2026-09-26T12:00:00Z", "2026-10-03T13:30:00Z"],
    zones: ["Australia/Sydney", "Australia/Lord_Howe", "Pacific/Auckland", "Pacific/Chatham"],
  },
  {
    label: "Santiago (2026-04-05 and 2026-09-06)",
    starts: ["2026-04-05T01:00:00Z", "2026-09-06T02:00:00Z"],
    zones: ["America/Santiago"],
  },
  {
    label: "Casablanca's Ramadan shift (2026-02-15 and 2026-03-22)",
    starts: ["2026-02-15T00:00:00Z", "2026-03-22T00:00:00Z"],
    zones: ["Africa/Casablanca"],
  },
];

// 08:30Z on a month's last day is still that day on every wall clock from
// UTC-8 to UTC+14, so each "once" tick below is at most a couple of days out.
const CALENDAR_EDGES: Array<{ start: string; daily: string[]; once: string[] }> = [
  { start: "2026-01-31T08:30:00Z", daily: ["0 0 * * *", "59 23 * * *"], once: ["0 0 1 * *", "0 0 1 2 *"] },
  { start: "2026-02-28T08:30:00Z", daily: ["0 0 * * *"], once: ["0 0 1 * *", "0 0 1 3 *"] },
  { start: "2028-02-28T08:30:00Z", daily: ["0 0 * * *"], once: ["0 12 29 2 *", "0 0 29 * *", "0 0 1 3 *"] },
  { start: "2026-04-30T08:30:00Z", daily: ["0 0 * * *"], once: ["0 0 1 * *", "59 23 30 4 *"] },
  { start: "2026-12-31T08:30:00Z", daily: ["0 0 * * *"], once: ["59 23 31 12 *", "0 0 1 1 *"] },
];
const CALENDAR_EDGE_ZONES = ["UTC", "Asia/Kolkata", "Asia/Kathmandu", "Pacific/Kiritimati", "America/New_York", "Pacific/Apia"];

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
const INCIDENT_BOOT = "2026-10-11T08:21:24Z";
const SPARSE_PRODUCTION = new Set(["0 17 1 * *", "7 0 28 * *", "0 9 15 5 *"]);

describe("nextCronTickInTimeZone matches the minute stepper it replaced (BLO-32638)", () => {
  for (const window of DST_WINDOWS) {
    it(`across DST transitions: ${window.label}`, () => {
      const mismatches: string[] = [];
      let compared = 0;
      for (const timeZone of window.zones) {
        for (const start of window.starts) {
          for (const expression of SUB_DAILY) mismatches.push(...compareChain(expression, timeZone, start, 4));
          for (const expression of DAILY) mismatches.push(...compareChain(expression, timeZone, start, 2));
          mismatches.push(...compareChain(SUNDAY_EARLY, timeZone, start, 3));
          compared += SUB_DAILY.length + DAILY.length + 1;
        }
      }
      expect(compared).toBeGreaterThan(0);
      expect(mismatches).toEqual([]);
    });
  }

  it("at month ends, year ends and the leap day", () => {
    const mismatches: string[] = [];
    for (const timeZone of CALENDAR_EDGE_ZONES) {
      for (const { start, daily, once } of CALENDAR_EDGES) {
        for (const expression of daily) mismatches.push(...compareChain(expression, timeZone, start, 2));
        for (const expression of once) mismatches.push(...compareChain(expression, timeZone, start, 1));
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("for the production triggers whose next tick is near", () => {
    const mismatches: string[] = [];
    for (const [cron, timeZone] of PRODUCTION_TRIGGERS) {
      if (SPARSE_PRODUCTION.has(cron)) continue;
      mismatches.push(...compareChain(cron, timeZone, INCIDENT_BOOT, 2));
    }
    expect(mismatches).toEqual([]);
  });

  // A full oracle walk for these is 30k-2.6M minutes each; the exhaustive run
  // below does it. Here the expected ticks are worked out by hand.
  it.each([
    ["0 9 15 5 *", "UTC", INCIDENT_BOOT, "2027-05-15T09:00:00.000Z"],
    ["0 9 15 5 *", "America/New_York", INCIDENT_BOOT, "2027-05-15T13:00:00.000Z"],
    ["0 9 15 5 *", "Australia/Sydney", INCIDENT_BOOT, "2027-05-14T23:00:00.000Z"],
    ["0 17 1 * *", "UTC", INCIDENT_BOOT, "2026-11-01T17:00:00.000Z"],
    ["7 0 28 * *", "UTC", INCIDENT_BOOT, "2026-10-28T00:07:00.000Z"],
    ["0 0 29 2 *", "UTC", "2026-03-01T00:00:00Z", "2028-02-29T00:00:00.000Z"],
    ["0 0 29 2 *", "America/New_York", "2026-03-01T00:00:00Z", "2028-02-29T05:00:00.000Z"],
    // Feb 31 never exists; Feb 29 next falls on a Monday in 2044, past the horizon.
    ["0 0 31 2 *", "UTC", INCIDENT_BOOT, null],
    ["0 0 31 2 *", "Pacific/Chatham", INCIDENT_BOOT, null],
    ["0 0 29 2 1", "UTC", INCIDENT_BOOT, null],
  ] as const)("finds %s in %s after %s at %s", (cron, timeZone, start, expected) => {
    expect(iso(nextCronTickInTimeZone(cron, timeZone, new Date(start)))).toBe(expected);
  });

  it("rejects what the stepper rejected, with the same message", () => {
    const cases: Array<[string, string, Date]> = [
      ["0 9 * * *", "Not/AZone", new Date(INCIDENT_BOOT)],
      ["61 * * * *", "UTC", new Date(INCIDENT_BOOT)],
      ["0 9 * *", "UTC", new Date(INCIDENT_BOOT)],
      ["0 9 * * *", "UTC", new Date(Number.NaN)],
    ];
    for (const [cron, timeZone, after] of cases) {
      const thrown = (fn: () => unknown) => {
        try {
          fn();
        } catch (err) {
          return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        }
        return "no error";
      };
      const legacy = thrown(() => legacyNextCronTickInTimeZone(cron, timeZone, after));
      expect(legacy).not.toBe("no error");
      expect(thrown(() => nextCronTickInTimeZone(cron, timeZone, after))).toBe(legacy);
    }
  });
});

const EXHAUSTIVE = process.env.PAPERCLIP_CRON_EQUIVALENCE_EXHAUSTIVE === "1";

/** Offset of `timeZone` at `ms`, in minutes, from a formatter of its own (independent of the code under test). */
function offsetMinutes(formatter: Intl.DateTimeFormat, ms: number) {
  const map = Object.fromEntries(formatter.formatToParts(ms).map((part) => [part.type, part.value]));
  const wall = Date.UTC(Number(map.year), Number(map.month) - 1, Number(map.day), Number(map.hour) % 24, Number(map.minute));
  return Math.round((wall - Math.floor(ms / MINUTE_MS) * MINUTE_MS) / MINUTE_MS);
}

/** The zone's offset transitions in [fromMs, toMs), to the minute, found from 6-hourly samples. */
function transitions(timeZone: string, fromMs: number, toMs: number) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone, hour12: false, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric",
  });
  const found: number[] = [];
  const stride = 6 * 60 * MINUTE_MS;
  for (let lo = fromMs; lo < toMs; lo += stride) {
    let hi = lo + stride;
    const base = offsetMinutes(formatter, lo);
    if (offsetMinutes(formatter, hi) === base) continue;
    let low = lo;
    while (hi - low > MINUTE_MS) {
      const mid = low + Math.floor((hi - low) / (2 * MINUTE_MS)) * MINUTE_MS;
      if (offsetMinutes(formatter, mid) === base) low = mid;
      else hi = mid;
    }
    found.push(hi);
  }
  return found;
}

/** Verbatim sampling loop of deriveRoutineFireGapsMs, run on the legacy stepper. */
function legacyFireGaps(cron: string, timeZone: string, now: Date) {
  let cursor = legacyNextCronTickInTimeZone(cron, timeZone, now);
  if (!cursor) return null;
  let gaps: { minMs: number; maxMs: number } | null = null;
  for (let i = 0; i < 6; i += 1) {
    const next = legacyNextCronTickInTimeZone(cron, timeZone, cursor);
    if (!next) break;
    const gapMs = next.getTime() - cursor.getTime();
    cursor = next;
    if (!Number.isFinite(gapMs) || gapMs <= 0) continue;
    if (gaps === null) gaps = { minMs: gapMs, maxMs: gapMs };
    else {
      if (gapMs < gaps.minMs) gaps.minMs = gapMs;
      if (gapMs > gaps.maxMs) gaps.maxMs = gapMs;
    }
  }
  return gaps;
}

/** Deterministic PRNG (mulberry32) so a failing random case can be replayed. */
function mulberry32(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe.runIf(EXHAUSTIVE)("exhaustive equivalence with the minute stepper (PAPERCLIP_CRON_EQUIVALENCE_EXHAUSTIVE=1)", () => {
  const LONG = 4 * 60 * 60 * 1000;

  it("in every supported time zone, around each of its 2026-2027 transitions", () => {
    const zones = Intl.supportedValuesOf("timeZone");
    const expressions = ["0 * * * *", "30 2 * * *", "30 1 * * *", "0 0 * * *", "45 */6 * * *", "*/20 0-4 * * *"];
    const mismatches: string[] = [];
    let compared = 0;
    for (const timeZone of zones) {
      const found = transitions(timeZone, Date.UTC(2026, 0, 1), Date.UTC(2028, 0, 1));
      const starts = found.length > 0
        ? found.flatMap((t) => [t - 3 * 60 * MINUTE_MS, t - 26 * 60 * MINUTE_MS])
        : [Date.UTC(2026, 9, 11, 8, 21)];
      for (const start of starts) {
        for (const expression of expressions) {
          mismatches.push(...compareChain(expression, timeZone, new Date(start).toISOString(), 3));
          compared += 1;
        }
      }
    }
    console.info(`exhaustive: ${zones.length} zones, ${compared} chains compared`);
    expect(mismatches).toEqual([]);
  }, 6 * LONG);

  it("on multi-year walks: yearly, Feb 29, Feb 31, Friday the 13th, quarterly", () => {
    const zones = ["UTC", "America/New_York", "America/Los_Angeles", "Europe/London", "Australia/Sydney",
      "Australia/Lord_Howe", "Pacific/Chatham", "Africa/Casablanca", "Asia/Kathmandu", "America/Santiago"];
    const expressions = ["0 9 15 5 *", "0 0 29 2 *", "30 2 29 2 *", "0 0 31 2 *", "0 0 29 2 1", "0 12 13 * 5",
      "0 0 1 1,4,7,10 *", "30 2 * 3 0", "30 1 1-7 11 0"];
    const starts = ["2026-03-01T00:00:00Z", INCIDENT_BOOT, "2027-03-14T12:00:00Z"];
    const mismatches: string[] = [];
    for (const timeZone of zones) {
      for (const expression of expressions) {
        for (const start of starts) mismatches.push(...compareChain(expression, timeZone, start, 1));
      }
    }
    expect(mismatches).toEqual([]);
  }, LONG);

  it("derives the same fire gaps as the stepper for every production trigger", () => {
    resetRoutineFireGapsMemoForTests();
    const now = new Date(INCIDENT_BOOT);
    for (const [cron, timeZone] of PRODUCTION_TRIGGERS) {
      expect(deriveRoutineFireGapsMs({ kind: "schedule", cronExpression: cron, timezone: timeZone }, now), `${cron} @ ${timeZone}`)
        .toEqual(legacyFireGaps(cron, timeZone, now));
    }
  }, LONG);

  it("on a seeded random sweep of expressions, zones and instants", () => {
    const random = mulberry32(0x32638);
    const pick = <T>(values: readonly T[]) => values[Math.floor(random() * values.length)]!;
    const zones = Intl.supportedValuesOf("timeZone");
    const minuteFields = ["*", "0", "30", "*/15", "5,35", "0-10/5", "59"];
    const hourFields = ["*", "0", "1", "2", "3", "*/6", "1-3", "23", "9-17"];
    const domFields = ["*", "*", "*", "1", "15", "28", "29", "30", "31", "1-7"];
    const monthFields = ["*", "*", "*", "2", "3", "10", "11", "3,10", "*/3"];
    const dowFields = ["*", "*", "*", "0", "1-5", "6", "0,6", "5"];
    const startFrom = Date.UTC(2025, 0, 1);
    const startSpan = Date.UTC(2029, 0, 1) - startFrom;
    const mismatches: string[] = [];
    for (let i = 0; i < 400; i += 1) {
      const expression = [pick(minuteFields), pick(hourFields), pick(domFields), pick(monthFields), pick(dowFields)].join(" ");
      const timeZone = pick(zones);
      const start = new Date(startFrom + Math.floor(random() * (startSpan / MINUTE_MS)) * MINUTE_MS + 17_000);
      mismatches.push(...compareChain(expression, timeZone, start.toISOString(), 2));
    }
    expect(mismatches).toEqual([]);
  }, 6 * LONG);

  it("never sees two offset transitions within 30 h in any zone, 2000-2040 (the search's window assumption)", () => {
    const closest: Array<{ timeZone: string; gapHours: number; at: string }> = [];
    for (const timeZone of Intl.supportedValuesOf("timeZone")) {
      const found = transitions(timeZone, Date.UTC(2000, 0, 1), Date.UTC(2040, 0, 1));
      for (let i = 1; i < found.length; i += 1) {
        const gapHours = (found[i]! - found[i - 1]!) / (60 * MINUTE_MS);
        if (gapHours < 30 * 24) closest.push({ timeZone, gapHours, at: new Date(found[i]!).toISOString() });
      }
    }
    closest.sort((a, b) => a.gapHours - b.gapHours);
    console.info(`closest transition pairs: ${JSON.stringify(closest.slice(0, 5))}`);
    expect(closest.filter((pair) => pair.gapHours <= 30)).toEqual([]);
  }, 6 * LONG);

  it("keeps every zone's offsets within 30 h of each other, 2000-2040", () => {
    for (const timeZone of Intl.supportedValuesOf("timeZone")) {
      const formatter = new Intl.DateTimeFormat("en-US", {
        timeZone, hour12: false, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric",
      });
      let min = Infinity;
      let max = -Infinity;
      for (let ms = Date.UTC(2000, 0, 1); ms < Date.UTC(2040, 0, 1); ms += 7 * DAY_MS) {
        const offset = offsetMinutes(formatter, ms);
        min = Math.min(min, offset);
        max = Math.max(max, offset);
      }
      expect(max - min, timeZone).toBeLessThanOrEqual(30 * 60);
    }
  }, LONG);
});
