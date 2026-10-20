/**
 * BLO-33243 — background scrape-metrics collector.
 *
 * Two properties matter here and neither is visible from the route test.
 *
 * 1. A failing refresh must not stop its four siblings. Inline they were five
 *    independent `.catch()`-ed awaits; a single try/catch around the loop would
 *    silently convert one bad query into a total blackout of the other gauges.
 *
 * 2. The BLO-28865 freshness contract must survive the move off the request
 *    path. Inline, "a scrape happened" implied "the refreshes just ran", so a
 *    rejection was the ONLY way to serve stale data and each refresh's own
 *    catch block covered it. On a timer there is a second way — the collector
 *    stops ticking — and then the freshness gauge reads last-good forever while
 *    the age gauge it vouches for freezes at whatever it last saw. That value
 *    is usually 0, the healthy reading, so a dead collector would look exactly
 *    like a quiet fleet: the precise invisible-failure mode these gauges exist
 *    to eliminate.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const refreshExternalRuntimeReservationMetrics = vi.fn(async () => {});
const refreshQueuedRunAgeMetrics = vi.fn(async () => {});
const refreshOverdueScheduledRetryAgeMetrics = vi.fn(async () => {});
const refreshScheduledRetryParkHorizonMetrics = vi.fn(async () => {});
const refreshDeferredIssueExecutionWakeAgeMetrics = vi.fn(async () => {});
const refreshExternalRuntimeReservationStrandMetrics = vi.fn(async () => {});
const refreshAcceptedInteractionOutcomeMetrics = vi.fn(async () => {});

vi.mock("../services/external-runtime-reservations.js", () => ({
  refreshExternalRuntimeReservationMetrics: (db: unknown) =>
    refreshExternalRuntimeReservationMetrics(db as never),
}));
vi.mock("../services/accepted-interaction-outcome-sweep.js", () => ({
  refreshAcceptedInteractionOutcomeMetrics: (db: unknown) =>
    refreshAcceptedInteractionOutcomeMetrics(db as never),
}));
vi.mock("../services/external-runtime-reservation-strand-metrics.js", () => ({
  refreshExternalRuntimeReservationStrandMetrics: (db: unknown) =>
    refreshExternalRuntimeReservationStrandMetrics(db as never),
}));
vi.mock("../services/queued-run-age-metrics.js", () => ({
  refreshQueuedRunAgeMetrics: (db: unknown) => refreshQueuedRunAgeMetrics(db as never),
  refreshOverdueScheduledRetryAgeMetrics: (db: unknown) =>
    refreshOverdueScheduledRetryAgeMetrics(db as never),
  refreshScheduledRetryParkHorizonMetrics: (db: unknown) =>
    refreshScheduledRetryParkHorizonMetrics(db as never),
  refreshDeferredIssueExecutionWakeAgeMetrics: (db: unknown) =>
    refreshDeferredIssueExecutionWakeAgeMetrics(db as never),
}));

const {
  ACCEPTED_INTERACTION_OUTCOME_METRICS_REFRESH_SUCCESS_METRIC,
  QUEUED_RUN_AGE_METRICS_REFRESH_SUCCESS_METRIC,
  __resetMetricsForTest,
  renderMetrics,
  setAcceptedInteractionOutcomeMetricsRefreshSuccess,
  setQueuedRunAgeMetricsRefreshSuccess,
} = await import("../services/metrics.js");
const { expireStaleRefreshFreshness, resetScrapeMetricsCollectorState, startScrapeMetricsCollector } =
  await import("../services/scrape-metrics-collector.js");

const DB = {} as never;
const INTERVAL_MS = 15_000;

async function gaugeValue(metric: string): Promise<string | undefined> {
  const { body } = await renderMetrics();
  return body.split("\n").find((line) => line.startsWith(`${metric} `))?.split(" ")[1];
}

/** Flush the microtask queue so an already-started tick can finish. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

let stop: (() => void) | null = null;

beforeEach(() => {
  for (const fn of [
    refreshExternalRuntimeReservationMetrics,
    refreshQueuedRunAgeMetrics,
    refreshOverdueScheduledRetryAgeMetrics,
    refreshScheduledRetryParkHorizonMetrics,
    refreshDeferredIssueExecutionWakeAgeMetrics,
    refreshExternalRuntimeReservationStrandMetrics,
    refreshAcceptedInteractionOutcomeMetrics,
  ]) {
    fn.mockReset();
    fn.mockResolvedValue(undefined);
  }
  resetScrapeMetricsCollectorState();
  __resetMetricsForTest();
});

afterEach(() => {
  stop?.();
  stop = null;
});

describe("startScrapeMetricsCollector", () => {
  it("runs every refresh on the first tick, without waiting for the interval", async () => {
    stop = startScrapeMetricsCollector(DB, { setInterval: vi.fn(() => 0) as never });
    await settle();

    expect(refreshExternalRuntimeReservationMetrics).toHaveBeenCalledTimes(1);
    expect(refreshQueuedRunAgeMetrics).toHaveBeenCalledTimes(1);
    expect(refreshOverdueScheduledRetryAgeMetrics).toHaveBeenCalledTimes(1);
    expect(refreshScheduledRetryParkHorizonMetrics).toHaveBeenCalledTimes(1);
    expect(refreshDeferredIssueExecutionWakeAgeMetrics).toHaveBeenCalledTimes(1);
    expect(refreshExternalRuntimeReservationStrandMetrics).toHaveBeenCalledTimes(1);
  });

  it("keeps refreshing the other gauges when one refresh rejects", async () => {
    refreshQueuedRunAgeMetrics.mockRejectedValue(new Error("statement timeout"));

    stop = startScrapeMetricsCollector(DB, { setInterval: vi.fn(() => 0) as never });
    await settle();

    expect(refreshOverdueScheduledRetryAgeMetrics).toHaveBeenCalledTimes(1);
    expect(refreshScheduledRetryParkHorizonMetrics).toHaveBeenCalledTimes(1);
    expect(refreshDeferredIssueExecutionWakeAgeMetrics).toHaveBeenCalledTimes(1);
    expect(refreshExternalRuntimeReservationStrandMetrics).toHaveBeenCalledTimes(1);
  });

  it("does not overlap ticks", async () => {
    let release: (() => void) | undefined;
    refreshExternalRuntimeReservationMetrics.mockImplementation(
      () => new Promise<void>((resolve) => { release = resolve; }),
    );
    let fire: (() => void) | undefined;
    stop = startScrapeMetricsCollector(DB, {
      setInterval: ((cb: () => void) => { fire = cb; return 0; }) as never,
    });
    await settle();

    fire?.();
    fire?.();
    await settle();
    expect(refreshExternalRuntimeReservationMetrics).toHaveBeenCalledTimes(1);

    release?.();
    await settle();
  });
});

describe("expireStaleRefreshFreshness (BLO-28865 contract)", () => {
  it("leaves a fresh refresh alone", async () => {
    let now = 1_000_000;
    refreshQueuedRunAgeMetrics.mockImplementation(async () => {
      setQueuedRunAgeMetricsRefreshSuccess(true);
    });

    stop = startScrapeMetricsCollector(DB, {
      setInterval: vi.fn(() => 0) as never,
      now: () => now,
    });
    await settle();
    expect(await gaugeValue(QUEUED_RUN_AGE_METRICS_REFRESH_SUCCESS_METRIC)).toBe("1");

    now += INTERVAL_MS;
    expireStaleRefreshFreshness(now);
    expect(await gaugeValue(QUEUED_RUN_AGE_METRICS_REFRESH_SUCCESS_METRIC)).toBe("1");
  });

  it("marks a refresh that stopped running as stale, not last-good", async () => {
    let now = 1_000_000;
    refreshQueuedRunAgeMetrics.mockImplementation(async () => {
      setQueuedRunAgeMetricsRefreshSuccess(true);
    });

    stop = startScrapeMetricsCollector(DB, {
      setInterval: vi.fn(() => 0) as never,
      now: () => now,
    });
    await settle();
    expect(await gaugeValue(QUEUED_RUN_AGE_METRICS_REFRESH_SUCCESS_METRIC)).toBe("1");

    // Collector wedged: no further ticks, so nothing sets the gauge either way.
    now += 7 * INTERVAL_MS;
    expireStaleRefreshFreshness(now);

    expect(await gaugeValue(QUEUED_RUN_AGE_METRICS_REFRESH_SUCCESS_METRIC)).toBe("0");
  });

  it("is a no-op for a refresh that has never succeeded", async () => {
    // Registry zero-init already reads ineligible; forcing 0 again here would
    // stomp the many suites that drive a refresh directly with no collector.
    setQueuedRunAgeMetricsRefreshSuccess(true);
    expireStaleRefreshFreshness(Date.now() + 86_400_000);
    expect(await gaugeValue(QUEUED_RUN_AGE_METRICS_REFRESH_SUCCESS_METRIC)).toBe("1");
  });
});

/**
 * PEN-4409. The accepted-interaction sweep is the only refresh in the list on a
 * cadence of its own: its CTE scans every accepted confirmation ever filed with
 * two correlated EXISTS per row, a cost that grows with history and never
 * shrinks, while what it measures (has a person acted on a decision?) moves on
 * human timescales against a 24 h alerting threshold. Four scans a minute to
 * re-derive the same answer is pure waste.
 */
describe("per-refresh cadence", () => {
  function startWithClock(nowMs: { value: number }) {
    let tick: (() => void) | null = null;
    const stopFn = startScrapeMetricsCollector(DB, {
      setInterval: vi.fn((fn: () => void) => {
        tick = fn;
        return 0;
      }) as never,
      now: () => nowMs.value,
    });
    return { stopFn, runTick: () => tick?.() };
  }

  it("skips a slowed refresh before its own interval has elapsed, while siblings keep ticking", async () => {
    const nowMs = { value: 1_000_000 };
    const { stopFn, runTick } = startWithClock(nowMs);
    stop = stopFn;
    await settle();

    expect(refreshAcceptedInteractionOutcomeMetrics).toHaveBeenCalledTimes(1);

    nowMs.value += INTERVAL_MS;
    runTick();
    await settle();
    nowMs.value += INTERVAL_MS;
    runTick();
    await settle();

    expect(refreshAcceptedInteractionOutcomeMetrics).toHaveBeenCalledTimes(1);
    // The siblings are unaffected: three ticks, three runs.
    expect(refreshQueuedRunAgeMetrics).toHaveBeenCalledTimes(3);
  });

  it("runs the slowed refresh again once its own interval has elapsed", async () => {
    const nowMs = { value: 1_000_000 };
    const { stopFn, runTick } = startWithClock(nowMs);
    stop = stopFn;
    await settle();

    nowMs.value += 5 * 60_000;
    runTick();
    await settle();

    expect(refreshAcceptedInteractionOutcomeMetrics).toHaveBeenCalledTimes(2);
  });

  /**
   * The trap this guards. The default stale window is six TICKS (90 s), which
   * silently assumes every refresh runs every tick. A refresh deliberately
   * slowed to 5 min would be marked stale between every pair of its OWN runs,
   * firing its strand alert permanently and reporting a working sweep as broken.
   */
  it("does not mark a slowed refresh stale merely for running on its own cadence", async () => {
    const nowMs = { value: 1_000_000 };
    refreshAcceptedInteractionOutcomeMetrics.mockImplementation(async () => {
      setAcceptedInteractionOutcomeMetricsRefreshSuccess(true);
    });
    const { stopFn } = startWithClock(nowMs);
    stop = stopFn;
    await settle();
    expect(await gaugeValue(ACCEPTED_INTERACTION_OUTCOME_METRICS_REFRESH_SUCCESS_METRIC)).toBe("1");

    // Well past the 90 s default window, well inside six of its own intervals.
    expireStaleRefreshFreshness(nowMs.value + 4 * 60_000);

    expect(await gaugeValue(ACCEPTED_INTERACTION_OUTCOME_METRICS_REFRESH_SUCCESS_METRIC)).toBe("1");
  });

  it("still marks a slowed refresh stale once it has missed several of its own intervals", async () => {
    const nowMs = { value: 1_000_000 };
    refreshAcceptedInteractionOutcomeMetrics.mockImplementation(async () => {
      setAcceptedInteractionOutcomeMetricsRefreshSuccess(true);
    });
    const { stopFn } = startWithClock(nowMs);
    stop = stopFn;
    await settle();
    expect(await gaugeValue(ACCEPTED_INTERACTION_OUTCOME_METRICS_REFRESH_SUCCESS_METRIC)).toBe("1");

    expireStaleRefreshFreshness(nowMs.value + 7 * 5 * 60_000);

    expect(await gaugeValue(ACCEPTED_INTERACTION_OUTCOME_METRICS_REFRESH_SUCCESS_METRIC)).toBe("0");
  });
});
