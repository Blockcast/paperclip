/**
 * Next-tick search for a cron expression read on the wall clock of an IANA
 * time zone (BLO-32638).
 *
 * The search this replaces stepped one UTC minute at a time and asked `Intl`
 * for the zone's wall clock on every step. A yearly cron needed ~527,000 steps
 * per call, and `deriveRoutineFireGapsMs` makes seven calls per trigger. Once
 * the routine fire-gap gauge put that derivation on the 15 s scrape-metrics
 * tick, one tick cost 95-135 s of synchronous CPU, `/healthz` starved, and the
 * liveness probe restarted every pod of helm revision 798 (2026-10-11).
 *
 * This search returns the same tick, or the same `null`, but jumps between
 * candidates instead of walking minutes:
 *
 * 1. Look up the zone's wall clock at the cursor (one `Intl` call). If it
 *    matches, the cursor is the answer.
 * 2. Otherwise compute the next matching wall-clock time with plain calendar
 *    arithmetic: skip to the next allowed month, day, hour and minute. That
 *    costs no `Intl` calls.
 * 3. Map that wall time back to UTC with the cursor's own offset, and jump
 *    there. If the zone's offset changes before the jump lands (a DST
 *    transition), land on the transition instead and go back to step 1, so a
 *    repeated fall-back hour or a skipped spring-forward hour is handled the
 *    same way the minute stepper handled it.
 *
 * Each pass costs O(1) `Intl` calls, plus a binary search of at most ~22 calls
 * when a jump crosses a transition, and only a transition can force another
 * pass. A next-tick search that crosses no transition costs about four lookups,
 * whatever the cron's period.
 *
 * Transitions are found by probing the offset, and that relies on two
 * properties of every IANA zone (see `TRANSITION_WINDOW_MS`). The equivalence
 * tests check the result against the old minute stepper.
 */
import type { ParsedCron } from "./cron.js";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * The minute stepper's search window, kept so "no tick within the horizon"
 * means exactly what it meant before: a candidate is a UTC minute in
 * `[floor(after) + 1 min, floor(after) + 1 min + this many minutes)`.
 */
export const ZONED_CRON_SEARCH_HORIZON_MINUTES = 366 * 24 * 60 * 5;

/**
 * Window for offset-transition detection. The search is exact for any zone
 * where both of these hold:
 *
 * - (A1) the UTC offset changes at most once in any window this long;
 * - (A2) no two instants have offsets more than this far apart.
 *
 * Every IANA zone meets both by a wide margin. Offsets span -12:00 to +14:00
 * (26 h). In current tzdata the closest pair of transitions in any zone is
 * weeks apart (Ramadan suspensions in Africa/Casablanca and Asia/Gaza, about
 * a month).
 *
 * Under those two, a jump whose first and last 30 h keep the cursor's offset
 * cannot pass a matching minute. In that stretch every minute's wall time lies
 * strictly between the cursor's wall time and the target's, and
 * `nextWallMatch` has already shown nothing in that range matches.
 */
const TRANSITION_WINDOW_MS = 30 * HOUR_MS;

/**
 * Hard cap on search passes. Only an offset transition can force a second
 * pass (at most two per transition), and a five-year horizon holds about ten
 * transitions in a DST zone, or about twenty in the busiest zones. 512 is
 * far above that, and it bounds the worst case at roughly
 * 512 * (4 + 22) zone lookups even if a zone broke both assumptions above.
 */
export const ZONED_CRON_SEARCH_MAX_STEPS = 512;

/** The zone's wall clock at one instant, in the shape the cron fields are matched against. */
export interface ZonedMinuteParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

export interface ZonedCronSearchResult {
  /** The first matching UTC minute strictly after `after`, or null when none falls within the horizon. */
  tick: Date | null;
  /** Search passes used. */
  steps: number;
  /** Wall-clock lookups (`partsAt` calls). With the `Intl` lookup, these are `formatToParts` calls. */
  lookups: number;
  /** True only when the step budget ran out first. `tick` is then null. */
  exhausted: boolean;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

// Constructing an Intl.DateTimeFormat costs ~1ms of ICU work, so cache one
// per timezone; instances are immutable. See #8033. (The minute stepper made
// this critical, calling it once per minute-step; the bounded search below
// calls it a handful of times per next-tick search.)
const zonedMinuteFormatterCache = new Map<string, Intl.DateTimeFormat>();

export function getZonedMinuteFormatter(timeZone: string) {
  let formatter = zonedMinuteFormatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      weekday: "short",
    });
    zonedMinuteFormatterCache.set(timeZone, formatter);
  }
  return formatter;
}

export function getZonedMinuteParts(date: Date | number, timeZone: string): ZonedMinuteParts {
  const formatter = getZonedMinuteFormatter(timeZone);
  const parts = formatter.formatToParts(date);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const weekday = WEEKDAY_INDEX[map.weekday ?? ""];
  if (weekday == null) {
    throw new Error(`Unable to resolve weekday for timezone ${timeZone}`);
  }
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    weekday,
  };
}

/**
 * A parsed cron as membership tables, plus "next allowed value at or after i"
 * tables for the two fields that are scanned within a day.
 */
interface CronMask {
  minute: boolean[];
  hour: boolean[];
  dayOfMonth: boolean[];
  month: boolean[];
  dayOfWeek: boolean[];
  nextMinute: number[];
  nextHour: number[];
}

function membership(values: readonly number[], size: number): boolean[] {
  const table = new Array<boolean>(size).fill(false);
  for (const value of values) table[value] = true;
  return table;
}

function nextAllowed(table: readonly boolean[]): number[] {
  const next = new Array<number>(table.length).fill(-1);
  let upcoming = -1;
  for (let i = table.length - 1; i >= 0; i -= 1) {
    if (table[i]) upcoming = i;
    next[i] = upcoming;
  }
  return next;
}

function buildCronMask(cron: ParsedCron): CronMask {
  const minute = membership(cron.minutes, 60);
  const hour = membership(cron.hours, 24);
  return {
    minute,
    hour,
    dayOfMonth: membership(cron.daysOfMonth, 32),
    month: membership(cron.months, 13),
    dayOfWeek: membership(cron.daysOfWeek, 7),
    nextMinute: nextAllowed(minute),
    nextHour: nextAllowed(hour),
  };
}

/**
 * The minute stepper's match test: every field must match, day-of-month AND
 * day-of-week (this codebase never used cron's OR rule for those two). A part
 * outside the field's range (an `hour` of 24, say) is just not a member, as it
 * was under `Array.prototype.includes`.
 */
function partsMatch(mask: CronMask, parts: ZonedMinuteParts): boolean {
  return (
    mask.minute[parts.minute] === true &&
    mask.hour[parts.hour] === true &&
    mask.dayOfMonth[parts.day] === true &&
    mask.month[parts.month] === true &&
    mask.dayOfWeek[parts.weekday] === true
  );
}

/** Wall-clock fields as UTC-encoded milliseconds. `setUTCFullYear` keeps years 0-99 literal, unlike `Date.UTC`. */
function wallMs(year: number, month: number, day: number, hour: number, minute: number): number {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, 0, 0);
  return date.getTime();
}

function daysInMonth(year: number, month: number): number {
  const date = new Date(0);
  date.setUTCFullYear(year, month, 0);
  return date.getUTCDate();
}

/**
 * The first wall-clock minute at or after `fromWallMs` whose calendar fields
 * match, or null when there is none up to `maxWallMs`. Pure arithmetic, no
 * `Intl`. The loop always moves forward by at least a month and stops once it
 * passes `maxWallMs`, so even a cron that can never match (`0 0 31 2 *`) costs
 * one cheap pass per month of the horizon.
 */
function nextWallMatch(mask: CronMask, fromWallMs: number, maxWallMs: number): number | null {
  const from = new Date(fromWallMs);
  let year = from.getUTCFullYear();
  let month = from.getUTCMonth() + 1;
  let day = from.getUTCDate();
  let hour = from.getUTCHours();
  let minute = from.getUTCMinutes();
  for (;;) {
    const monthStart = wallMs(year, month, 1, 0, 0);
    if (monthStart > maxWallMs) return null;
    if (mask.month[month]) {
      const lastDay = daysInMonth(year, month);
      const firstWeekday = new Date(monthStart).getUTCDay();
      for (; day <= lastDay; day += 1, hour = 0, minute = 0) {
        if (!mask.dayOfMonth[day] || !mask.dayOfWeek[(firstWeekday + day - 1) % 7]) continue;
        for (let h = mask.nextHour[hour]!; h !== -1; h = h < 23 ? mask.nextHour[h + 1]! : -1) {
          const m = mask.nextMinute[h === hour ? minute : 0]!;
          if (m !== -1) {
            const match = wallMs(year, month, day, h, m);
            return match <= maxWallMs ? match : null;
          }
        }
      }
    }
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
    day = 1;
    hour = 0;
    minute = 0;
  }
}

/**
 * Find the first UTC minute strictly after `after` whose wall clock in the
 * zone matches `cron`, looking the wall clock up through `partsAt`. Same
 * contract as the minute stepper it replaces: the same tick, or null when the
 * first match lies beyond {@link ZONED_CRON_SEARCH_HORIZON_MINUTES}.
 *
 * `partsAt` is a parameter, not a hard-wired `Intl` call, so tests can count
 * lookups and feed adversarial clocks. Production passes
 * {@link getZonedMinuteParts}.
 */
export function searchNextZonedCronTick(
  cron: ParsedCron,
  after: Date,
  partsAt: (ms: number) => ZonedMinuteParts,
): ZonedCronSearchResult {
  const mask = buildCronMask(cron);
  const looked = new Map<number, ZonedMinuteParts>();
  const lookup = (ms: number): ZonedMinuteParts => {
    let parts = looked.get(ms);
    if (!parts) {
      parts = partsAt(ms);
      looked.set(ms, parts);
    }
    return parts;
  };
  // `% 24`: an ICU that renders midnight as hour 24 (an h24 cycle) still
  // dates it to the day that is starting, so treat it as hour 0 when deriving
  // the offset. Matching keeps the raw value, as the minute stepper did.
  const wallOf = (parts: ZonedMinuteParts) =>
    wallMs(parts.year, parts.month, parts.day, parts.hour % 24, parts.minute);
  const offsetAt = (ms: number) => wallOf(lookup(ms)) - ms;

  // First instant at which `offsetAt` differs from `offset`, given that it
  // equals `offset` at `lo` and differs at `hi`.
  const firstMinuteOffBy = (lo: number, hi: number, offset: number): number => {
    while (hi - lo > MINUTE_MS) {
      const mid = lo + Math.floor((hi - lo) / (2 * MINUTE_MS)) * MINUTE_MS;
      if (offsetAt(mid) === offset) lo = mid;
      else hi = mid;
    }
    return hi;
  };

  // Advance from `from` (whose offset is `offset`) towards `target`, given that
  // no wall time in [wall(from), target + offset) matches. Returns `target` when
  // the offset holds at both ends of the jump, else the instant the offset
  // changes. Either way, no minute in between can match (see
  // TRANSITION_WINDOW_MS for why the two ends are enough).
  const advance = (from: number, offset: number, target: number): number => {
    const probes = target - from <= TRANSITION_WINDOW_MS
      ? [target]
      : [from + TRANSITION_WINDOW_MS, target - TRANSITION_WINDOW_MS, target].sort((a, b) => a - b);
    let known = from;
    for (const probe of probes) {
      if (offsetAt(probe) !== offset) return firstMinuteOffBy(known, probe, offset);
      known = probe;
    }
    return target;
  };

  const afterMs = after.getTime();
  const startMs = afterMs - (((afterMs % MINUTE_MS) + MINUTE_MS) % MINUTE_MS) + MINUTE_MS;
  if (Number.isNaN(startMs)) {
    // An invalid `after`: the minute stepper threw from formatToParts on its
    // first step, so let the lookup throw the same RangeError here.
    lookup(startMs);
    return { tick: null, steps: 0, lookups: looked.size, exhausted: false };
  }
  const endMs = startMs + ZONED_CRON_SEARCH_HORIZON_MINUTES * MINUTE_MS;
  // Any minute before endMs has a wall time below endMs + its offset, and real
  // offsets are under a day, so this bound covers every wall time that matters.
  const maxWallMs = endMs + 2 * DAY_MS;

  let cursor = startMs;
  for (let step = 1; step <= ZONED_CRON_SEARCH_MAX_STEPS; step += 1) {
    if (cursor >= endMs) return { tick: null, steps: step, lookups: looked.size, exhausted: false };
    const parts = lookup(cursor);
    if (partsMatch(mask, parts)) {
      return { tick: new Date(cursor), steps: step, lookups: looked.size, exhausted: false };
    }
    const offset = wallOf(parts) - cursor;
    const nextWall = nextWallMatch(mask, cursor + offset + MINUTE_MS, maxWallMs);
    const target = nextWall === null ? endMs : Math.min(nextWall - offset, endMs);
    cursor = advance(cursor, offset, target);
  }
  return { tick: null, steps: ZONED_CRON_SEARCH_MAX_STEPS, lookups: looked.size, exhausted: true };
}
