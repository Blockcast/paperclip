/**
 * BLO-32638: the scrape-metrics collector's routine-fire-gap refresh must do
 * bounded work per tick, and almost none in steady state.
 *
 * Helm revision 798 put that refresh on the collector's 15 s tick with a
 * minute-stepping next-tick search behind it. Against the 18 production
 * triggers (one yearly, two monthly), one tick took 95-135 s of synchronous
 * CPU, `/healthz` timed out, and the liveness probe restarted every pod for
 * 4.5 h. This drives the real collector against a stub database that returns
 * those triggers, and counts `Intl` `formatToParts` calls per tick. That is the
 * cost that used to scale with the number of minutes searched.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Every other refresh on the tick is a no-op here, so the count is the fire-gap
// refresh's alone.
vi.mock("../services/external-runtime-reservations.js", () => ({
  refreshExternalRuntimeReservationMetrics: async () => {},
}));
vi.mock("../services/external-runtime-reservation-strand-metrics.js", () => ({
  refreshExternalRuntimeReservationStrandMetrics: async () => {},
}));
vi.mock("../services/queued-run-age-metrics.js", () => ({
  refreshQueuedRunAgeMetrics: async () => {},
  refreshOverdueScheduledRetryAgeMetrics: async () => {},
  refreshScheduledRetryParkHorizonMetrics: async () => {},
  refreshDeferredIssueExecutionWakeAgeMetrics: async () => {},
}));

const {
  ROUTINE_FIRE_GAP_METRICS_REFRESH_SUCCESS_METRIC,
  ROUTINE_FIRE_INTERVAL_METRIC,
  __resetMetricsForTest,
  renderMetrics,
} = await import("../services/metrics.js");
const { resetScrapeMetricsCollectorState, startScrapeMetricsCollector } = await import(
  "../services/scrape-metrics-collector.js"
);
const { deriveRoutineFireGapsMs, resetRoutineFireGapsMemoForTests } = await import("../services/routines.js");

const DAY_SECONDS = 24 * 60 * 60;

// The 18 active production schedule triggers on 2026-10-11, plus the sparse
// shapes the bound must also cover: a leap-day cron, a cron that never fires,
// and the yearly cron in a DST zone.
const TRIGGERS: Array<[cron: string, timeZone: string]> = [
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
  ["0 0 29 2 *", "UTC"],
  ["0 0 31 2 *", "UTC"],
  ["0 9 15 5 *", "America/New_York"],
];

const rows = TRIGGERS.map(([cronExpression, timezone], index) => ({
  routineId: `routine-${index}`,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  triggerKind: "schedule",
  cronExpression,
  timezone,
  lastCompletedAt: new Date("2026-10-11T00:00:00Z"),
}));

// The refresh's one query is select().from().innerJoin().where(); answer it
// with the rows above.
const db = {
  select: () => db,
  from: () => db,
  innerJoin: () => db,
  where: () => Promise.resolve(rows),
} as never;

// Seven next-tick searches per trigger, each at most 64 lookups (see
// zoned-cron-work-bound.test.ts). The minute stepper needed ~3.7 million for
// the production set.
const MAX_FORMAT_TO_PARTS_PER_TRIGGER = 7 * 64;

// Count with a plain counter, not vi.spyOn. A spy keeps every call's
// arguments, and a regressed search makes millions of calls: a minute-stepper
// mutant pushed the test worker past 23 GB. Past this cap the counter throws,
// so a regression fails in seconds instead of running for minutes.
const FORMAT_TO_PARTS_CALL_CAP = 4 * TRIGGERS.length * MAX_FORMAT_TO_PARTS_PER_TRIGGER;
const realFormatToParts = Intl.DateTimeFormat.prototype.formatToParts;
let formatToPartsCalls = 0;

function countedFormatToParts(this: Intl.DateTimeFormat, date?: Date | number) {
  formatToPartsCalls += 1;
  if (formatToPartsCalls > FORMAT_TO_PARTS_CALL_CAP) {
    throw new Error(`formatToParts was called more than ${FORMAT_TO_PARTS_CALL_CAP} times`);
  }
  return realFormatToParts.call(this, date);
}

// What deriving one trigger costs with nothing memoized, at the current time.
// Clears the memo, so call it after the collector checks.
function freshDerivationCost(cronExpression: string, timezone: string) {
  resetRoutineFireGapsMemoForTests();
  formatToPartsCalls = 0;
  deriveRoutineFireGapsMs({ kind: "schedule", cronExpression, timezone }, new Date());
  return formatToPartsCalls;
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

async function scrape(metric: string) {
  const { body } = await renderMetrics();
  return body.split("\n").filter((line) => line.startsWith(metric));
}

let stop: (() => void) | null = null;
let fireTick: (() => void) | null = null;

async function tickAt(iso: string) {
  vi.setSystemTime(new Date(iso));
  formatToPartsCalls = 0;
  fireTick!();
  await settle();
  return formatToPartsCalls;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-11T08:21:24Z")); // rev 798's first boot
  resetScrapeMetricsCollectorState();
  resetRoutineFireGapsMemoForTests();
  __resetMetricsForTest();
  formatToPartsCalls = 0;
  Intl.DateTimeFormat.prototype.formatToParts = countedFormatToParts;
  stop = startScrapeMetricsCollector(db, {
    setInterval: ((callback: () => void) => {
      fireTick = callback;
      return { unref() {} };
    }) as never,
    clearInterval: (() => {}) as never,
  });
});

afterEach(() => {
  stop?.();
  stop = null;
  fireTick = null;
  Intl.DateTimeFormat.prototype.formatToParts = realFormatToParts;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("scrape-metrics collector: routine-fire-gap refresh work per tick (BLO-32638)", () => {
  it("publishes every trigger's gauge on the boot tick with bounded Intl work", async () => {
    await settle();
    const bootTick = formatToPartsCalls;

    // The refresh really ran and published; a refresh that threw would also
    // make zero Intl calls.
    expect(await scrape(`${ROUTINE_FIRE_GAP_METRICS_REFRESH_SUCCESS_METRIC} `)).toEqual([
      `${ROUTINE_FIRE_GAP_METRICS_REFRESH_SUCCESS_METRIC} 1`,
    ]);
    const intervals = await scrape(`${ROUTINE_FIRE_INTERVAL_METRIC}{`);
    // Every trigger but `0 0 31 2 *` (it never fires, so it has no cadence).
    expect(intervals).toHaveLength(TRIGGERS.length - 1);
    expect(intervals).toContain(`${ROUTINE_FIRE_INTERVAL_METRIC}{routine_id="routine-17"} ${366 * DAY_SECONDS}`);
    expect(intervals).toContain(`${ROUTINE_FIRE_INTERVAL_METRIC}{routine_id="routine-5"} ${4 * 60 * 60}`);
    expect(intervals).toContain(`${ROUTINE_FIRE_INTERVAL_METRIC}{routine_id="routine-7"} ${3 * DAY_SECONDS}`);

    // The boot tick derived each trigger once, and no single derivation is
    // over the per-trigger bound.
    const costs = TRIGGERS.map(([cron, timeZone]) => freshDerivationCost(cron, timeZone));
    for (const [index, cost] of costs.entries()) {
      expect(cost, TRIGGERS[index]!.join(" @ ")).toBeGreaterThan(0);
      expect(cost, TRIGGERS[index]!.join(" @ ")).toBeLessThanOrEqual(MAX_FORMAT_TO_PARTS_PER_TRIGGER);
    }
    expect(bootTick).toBe(costs.reduce((sum, cost) => sum + cost, 0));
  });

  it("makes no Intl calls on a steady-state tick, and re-derives only the trigger whose tick passed", async () => {
    await settle();
    expect(formatToPartsCalls).toBeGreaterThan(0);

    // 15 s later no trigger has fired, so every derivation comes from the memo.
    expect(await tickAt("2026-10-11T08:21:39Z")).toBe(0);
    expect(await tickAt("2026-10-11T08:21:54Z")).toBe(0);

    // `37 */4 * * *` fired at 08:37. The tick costs exactly what deriving that
    // trigger alone costs, so no other trigger was re-derived with it.
    const afterTick = await tickAt("2026-10-11T08:37:09Z");
    expect(await scrape(`${ROUTINE_FIRE_GAP_METRICS_REFRESH_SUCCESS_METRIC} `)).toEqual([
      `${ROUTINE_FIRE_GAP_METRICS_REFRESH_SUCCESS_METRIC} 1`,
    ]);
    const alone = freshDerivationCost("37 */4 * * *", "UTC");
    expect(alone).toBeGreaterThan(0);
    expect(alone).toBeLessThanOrEqual(MAX_FORMAT_TO_PARTS_PER_TRIGGER);
    expect(afterTick).toBe(alone);
  });
});
