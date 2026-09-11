/**
 * @fileoverview Background collector for the DB-backed gauges that the
 * `/metrics` handler used to refresh inline (BLO-33243).
 *
 * `/metrics` awaited five DB-querying refreshes in strict series before
 * rendering, so scrape latency was the sum of five pool acquisitions plus six
 * query round-trips against a 10 s scrape timeout. Every pool stall therefore
 * became a *failed scrape*, and a failed scrape ingests no sample at all --
 * destroying the entire in-process metric set for that interval, including the
 * event-loop-lag gauge an investigator reaches for first. Measured over 9 h to
 * 2026-09-10T23:20Z: two of three control-plane pods lost 82 and 72 samples,
 * every one of them a 10 s timeout, while p50 stayed at 0.18-0.26 s. The
 * monitoring blinded itself precisely when something was wrong.
 *
 * Same shape as {@link startPluginStatusCollector}: boot-started interval,
 * non-overlapping ticks, unref'd timer, returns a stop function. Started on
 * every tier, unlike the plugin collector -- all three control-plane pods are
 * scrape targets and all three need these gauges.
 *
 * The refreshes stay in series inside the tick rather than becoming a
 * `Promise.all`. Off the request path there is no latency budget to defend,
 * and the two-query refreshes would otherwise put eight concurrent queries
 * into a ten-connection pool -- re-creating on a timer the contention this
 * change exists to take off the scrape path.
 */

import type { Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { refreshExternalRuntimeReservationMetrics } from "./external-runtime-reservations.js";
import { refreshExternalRuntimeReservationStrandMetrics } from "./external-runtime-reservation-strand-metrics.js";
import {
  refreshOverdueScheduledRetryAgeMetrics,
  refreshQueuedRunAgeMetrics,
  refreshScheduledRetryParkHorizonMetrics,
} from "./queued-run-age-metrics.js";
import {
  setDbPoolStats,
  setExternalRuntimeReservationStrandMetricsRefreshSuccess,
  setOverdueScheduledRetryAgeMetricsRefreshSuccess,
  setQueuedRunAgeMetricsRefreshSuccess,
  setScheduledRetryParkHorizonRefreshSuccess,
  type DbPoolStats,
} from "./metrics.js";

/** Scrape interval is 15 s; refreshing on the same cadence keeps every scrape at most one tick behind. */
const DEFAULT_INTERVAL_MS = 15_000;

/**
 * How stale a last-successful refresh may get before its freshness gauge is
 * forced back to 0 (BLO-28865 contract, see {@link expireStaleRefreshFreshness}).
 * Six intervals: long enough that a single slow tick cannot flap the gauge,
 * short enough to be well inside the 10 m `for:` window on the alerts that
 * read it.
 */
const DEFAULT_STALE_AFTER_MS = 6 * DEFAULT_INTERVAL_MS;

interface ScrapeRefresh {
  name: string;
  run: (db: Db) => Promise<void>;
  /**
   * Companion freshness gauge, where one exists. Each refresh already sets its
   * own on success and failure; this collector only needs the setter to force
   * the gauge back to 0 when the refresh stops running altogether.
   * `refreshExternalRuntimeReservationMetrics` has no freshness gauge (it
   * overwrites both of its values unconditionally, so a stale read is not
   * mistakable for a healthy one) and is therefore listed with `null`.
   */
  setFresh: ((success: boolean) => void) | null;
}

const REFRESHES: readonly ScrapeRefresh[] = [
  {
    name: "external-runtime-reservation",
    run: (db) => refreshExternalRuntimeReservationMetrics(db),
    setFresh: null,
  },
  {
    name: "queued-run-age",
    run: (db) => refreshQueuedRunAgeMetrics(db),
    setFresh: setQueuedRunAgeMetricsRefreshSuccess,
  },
  {
    name: "overdue-scheduled-retry-age",
    run: (db) => refreshOverdueScheduledRetryAgeMetrics(db),
    setFresh: setOverdueScheduledRetryAgeMetricsRefreshSuccess,
  },
  {
    name: "scheduled-retry-park-horizon",
    run: (db) => refreshScheduledRetryParkHorizonMetrics(db),
    setFresh: setScheduledRetryParkHorizonRefreshSuccess,
  },
  {
    name: "external-runtime-reservation-strand",
    run: (db) => refreshExternalRuntimeReservationStrandMetrics(db),
    setFresh: setExternalRuntimeReservationStrandMetricsRefreshSuccess,
  },
];

/** Unix ms of the last successful run, per refresh. Only populated once a refresh has actually succeeded. */
const lastSuccessMs = new Map<string, number>();

/**
 * Force the freshness gauge of any refresh that has STOPPED RUNNING back to 0.
 *
 * This is the half of the BLO-28865 freshness contract that moving off the
 * request path would otherwise break. While the refreshes ran inline, "a
 * scrape happened" implied "the refreshes just ran", so a rejection was the
 * only way to get stale data and each refresh's own catch block covered it. On
 * a timer, a collector that silently stops ticking leaves the gauge reading
 * last-good forever -- stale data that is fully eligible for the strand alert,
 * which is the exact invisible-failure mode those gauges exist to prevent.
 *
 * Called synchronously from the `/metrics` handler: it reads only in-memory
 * state, so it costs nothing and keeps the request path DB-free.
 *
 * A refresh that has never succeeded is skipped deliberately -- its gauge is
 * already 0 from `ensureRegistry`'s zero-init, and skipping keeps this a no-op
 * in the many tests that drive the refreshes directly without a collector.
 */
export function expireStaleRefreshFreshness(
  now = Date.now(),
  staleAfterMs = DEFAULT_STALE_AFTER_MS,
): void {
  for (const refresh of REFRESHES) {
    const last = lastSuccessMs.get(refresh.name);
    if (last === undefined) continue;
    if (now - last > staleAfterMs) refresh.setFresh?.(false);
  }
}

/** Test seam: forget recorded successes so `expireStaleRefreshFreshness` starts from a clean slate. */
export function resetScrapeMetricsCollectorState(): void {
  lastSuccessMs.clear();
}

/**
 * postgres.js exposes no pool statistics of its own; `poolStats` comes from
 * `patches/postgres@3.4.9.patch` (BLO-33243), which returns the driver's own
 * queue lengths. Typed structurally and read optionally so that if a future
 * upgrade drops the patch this degrades to "the gauges stop moving" instead of
 * a TypeError on every scrape. `db-pool-stats.test.ts` fails if the patch goes
 * missing, so the degradation cannot pass CI unnoticed.
 */
type PoolStatsClient = { poolStats?: () => DbPoolStats };

/**
 * Publish the connection-pool snapshot (BLO-33243). Synchronous and DB-free:
 * `poolStats()` reads four in-memory queue lengths, so this is safe to call on
 * the `/metrics` request path -- which is the point, since a saturated pool is
 * only observable while it is saturated.
 */
export function refreshDbPoolMetrics(db: Db): void {
  const client = (db as { $client?: PoolStatsClient }).$client;
  const stats = client?.poolStats?.();
  if (stats) setDbPoolStats(stats);
}

export interface ScrapeMetricsCollectorOptions {
  intervalMs?: number;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
  now?: () => number;
}

/**
 * Start the scrape-metrics collector. Returns a stop function, matching
 * `startPluginStatusCollector` and the other pollers wired in `app.ts`.
 */
export function startScrapeMetricsCollector(
  db: Db,
  options: ScrapeMetricsCollectorOptions = {},
): () => void {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const scheduleInterval = options.setInterval ?? setInterval;
  const clearIntervalFn = options.clearInterval ?? clearInterval;
  const now = options.now ?? Date.now;

  let ticking = false;
  let stopped = false;

  async function tick(): Promise<void> {
    if (ticking || stopped) return;
    ticking = true;
    try {
      for (const refresh of REFRESHES) {
        try {
          await refresh.run(db);
          lastSuccessMs.set(refresh.name, now());
        } catch (err) {
          // Per-refresh catch, not per-tick: one failing query must not stop
          // the other four from refreshing. The refresh has already set its
          // own freshness gauge to 0 on the way out, which is what makes its
          // stale age ineligible for the strand alert and pages the failure
          // on its own -- the BLO-28865 contract, unchanged by this move.
          logger.warn({ err, refresh: refresh.name }, "scrape-metrics collector refresh failed");
        }
      }
    } finally {
      ticking = false;
    }
  }

  void tick();
  const timer = scheduleInterval(() => {
    void tick();
  }, intervalMs);
  timer.unref?.();

  logger.info({ intervalMs }, "scrape-metrics collector started");

  return () => {
    stopped = true;
    clearIntervalFn(timer);
  };
}
