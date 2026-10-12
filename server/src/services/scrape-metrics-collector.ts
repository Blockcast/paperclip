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
import { describeHeldAgentStartLocks } from "./agent-start-lock.js";
import { refreshExternalRuntimeReservationMetrics } from "./external-runtime-reservations.js";
import { refreshExternalRuntimeReservationStrandMetrics } from "./external-runtime-reservation-strand-metrics.js";
import {
  refreshDeferredIssueExecutionWakeAgeMetrics,
  refreshOverdueScheduledRetryAgeMetrics,
  refreshQueuedRunAgeMetrics,
  refreshScheduledRetryParkHorizonMetrics,
} from "./queued-run-age-metrics.js";
import { refreshRoutineFireGapMetrics } from "./routine-fire-gap-metrics.js";
import {
  setAgentStartLockHeldMetrics,
  setDbPoolStats,
  setDeferredIssueExecutionWakeAgeMetricsRefreshSuccess,
  setExternalRuntimeReservationStrandMetricsRefreshSuccess,
  setFdClassMetrics,
  setOverdueScheduledRetryAgeMetricsRefreshSuccess,
  setQueuedRunAgeMetricsRefreshSuccess,
  setRoutineFireGapMetricsRefreshSuccess,
  setScheduledRetryParkHorizonRefreshSuccess,
  type DbPoolStats,
} from "./metrics.js";
import { collectFdClassSnapshot } from "./fd-class-metrics.js";

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
    // PEN-3734. Sits with the queued-run family because it answers the same
    // question — "is something waiting and nothing reporting it?" — one table
    // over. A deferred wake writes no `heartbeat_runs` row at all, so the
    // three run-table refreshes around it are structurally blind to it.
    name: "deferred-issue-execution-wake-age",
    run: (db) => refreshDeferredIssueExecutionWakeAgeMetrics(db),
    setFresh: setDeferredIssueExecutionWakeAgeMetricsRefreshSuccess,
  },
  {
    name: "scheduled-retry-park-horizon",
    run: (db) => refreshScheduledRetryParkHorizonMetrics(db),
    setFresh: setScheduledRetryParkHorizonRefreshSuccess,
  },
  {
    // BLO-32638. Not a run-table refresh: the receipt it ages is a `done`
    // issue row recorded on `routine_runs`, which every refresh above is
    // structurally blind to. A routine silently disabled for intervals reads
    // identically to a healthy quiet one without it.
    name: "routine-fire-gap",
    run: (db) => refreshRoutineFireGapMetrics(db),
    setFresh: setRoutineFireGapMetricsRefreshSuccess,
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

/**
 * Publish the held agent start locks (PEN-3305). Synchronous and DB-free for
 * the same reason as {@link refreshDbPoolMetrics}, and the reason is sharper
 * here: the condition this exists to expose is a dispatch section wedged on a
 * database await, so a DB-backed collector tick would be stuck behind the very
 * thing it is meant to report. Reading it on the scrape path means the gauge
 * is published *because* the process can still serve HTTP, independently of
 * whether it can reach Postgres.
 */
export function refreshAgentStartLockMetrics(): void {
  setAgentStartLockHeldMetrics(describeHeldAgentStartLocks());
}

/**
 * Publish the descriptor-class histogram (PEN-3314). Synchronous and DB-free
 * like its two neighbours. Its cost is a bounded constant rather than a cheap
 * one, and the distinction matters: `/proc` is kernel memory, so the walk is
 * `readdir`/`readlink` syscalls with no I/O wait — but they are synchronous
 * syscalls on the event loop, and no I/O wait is not the same as not blocking.
 * Measured on a Linux container, 33 fds → 0.33 ms and 4033 fds → 43.7 ms, so at
 * the inspection cap it holds the loop for ~43 ms. What makes it admissible on
 * a request path whose whole design constraint (BLO-33243) is that nothing on
 * it may block is the amortisation, not the speed: once per 15 s scrape is a
 * ~0.3% duty cycle against a 10 s timeout, and the cap keeps that figure from
 * growing with the leak.
 *
 * On the scrape path rather than in {@link REFRESHES} for the same reason as
 * {@link refreshAgentStartLockMetrics}, and it is the load-bearing one: the
 * collector's tick awaits five database refreshes in series, so a process
 * wedged on Postgres publishes nothing from it. That is a state in which a
 * descriptor histogram is *more* wanted, not less — a pool wedge and a
 * descriptor leak are two of the shapes this worker actually fails in, and an
 * instrument that goes dark during one of them cannot distinguish them.
 *
 * The second reason is sampling skew: this gauge exists to be correlated
 * against `process_open_fds` and the heap gauges, all of which are rendered at
 * scrape time. A one-tick offset between them would be invisible and would show
 * up as noise in exactly the correlation it is meant to sharpen.
 */
export function refreshFdClassMetrics(): void {
  setFdClassMetrics(collectFdClassSnapshot());
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
