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
const refreshExternalRuntimeReservationStrandMetrics = vi.fn(async () => {});

vi.mock("../services/external-runtime-reservations.js", () => ({
  refreshExternalRuntimeReservationMetrics: (db: unknown) =>
    refreshExternalRuntimeReservationMetrics(db as never),
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
}));

const {
  QUEUED_RUN_AGE_METRICS_REFRESH_SUCCESS_METRIC,
  __resetMetricsForTest,
  renderMetrics,
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
    refreshExternalRuntimeReservationStrandMetrics,
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
    expect(refreshExternalRuntimeReservationStrandMetrics).toHaveBeenCalledTimes(1);
  });

  it("keeps refreshing the other gauges when one refresh rejects", async () => {
    refreshQueuedRunAgeMetrics.mockRejectedValue(new Error("statement timeout"));

    stop = startScrapeMetricsCollector(DB, { setInterval: vi.fn(() => 0) as never });
    await settle();

    expect(refreshOverdueScheduledRetryAgeMetrics).toHaveBeenCalledTimes(1);
    expect(refreshScheduledRetryParkHorizonMetrics).toHaveBeenCalledTimes(1);
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
