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
import { refreshWorkspaceReuseRefusalMetrics } from "./workspace-reuse-refusal-metrics.js";
import { refreshApprovalQueueMetrics } from "./approval-queue-metrics.js";
import { refreshAcceptedInteractionOutcomeMetrics } from "./accepted-interaction-outcome-sweep.js";
import {
  refreshDeferredIssueExecutionWakeAgeMetrics,
  refreshOverdueScheduledRetryAgeMetrics,
  refreshQueuedRunAgeMetrics,
  refreshScheduledRetryParkHorizonMetrics,
} from "./queued-run-age-metrics.js";
import { refreshRoutineFireGapMetrics } from "./routine-fire-gap-metrics.js";
import { attributeRssReleaseGc } from "./rss-release-gc-attribution.js";
import { readRssReleases } from "./rss-release-tracker.js";
import {
  setAgentStartLockHeldMetrics,
  setAcceptedInteractionOutcomeMetricsRefreshSuccess,
  setApprovalQueueMetricsRefreshSuccess,
  setDbPoolStats,
  setDeferredIssueExecutionWakeAgeMetricsRefreshSuccess,
  setExternalRuntimeReservationStrandMetricsRefreshSuccess,
  setFdClassMetrics,
  setCgroupMemoryMetrics,
  setNativeMemoryMetrics,
  setProcessMappingMetrics,
  setRssReleaseMetrics,
  setRssReleaseGcAttributionMetrics,
  setOverdueScheduledRetryAgeMetricsRefreshSuccess,
  setQueuedRunAgeMetricsRefreshSuccess,
  setRoutineFireGapMetricsRefreshSuccess,
  setScheduledRetryParkHorizonRefreshSuccess,
  setWorkspaceReuseRefusalMetricsRefreshSuccess,
  type DbPoolStats,
} from "./metrics.js";
import { collectFdClassSnapshot } from "./fd-class-metrics.js";
import { collectCgroupMemorySnapshot } from "./cgroup-memory-metrics.js";
import { collectNativeMemorySnapshot } from "./native-memory-metrics.js";
import {
  DEFAULT_MIN_SCAN_INTERVAL_MS,
  collectProcessMappingSnapshot,
  type ProcessMappingSnapshot,
} from "./process-mapping-metrics.js";

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
  /**
   * Run this refresh at most once per this many ms, instead of every tick.
   *
   * Default (undefined) is every tick, which is right for anything derived from
   * run/queue/lease tables: those change on machine timescales and the gauge is
   * read against a 15 s scrape. Set it only where the underlying data changes on
   * HUMAN timescales and the query is not cheap, so that re-asking four times a
   * minute buys nothing and costs a full scan.
   *
   * {@link expireStaleRefreshFreshness} derives this refresh's stale window from
   * the value, so a slowed refresh is not mistaken for a stopped one.
   */
  minIntervalMs?: number;
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
  {
    // PEN-3633. Every refresh above is scoped to an agent or a run. This one is
    // scoped to the project CHECKOUT, which is the actual unit of failure here:
    // one broken checkout produced 33 run failures across 8.6 h, each reported
    // separately and none naming the checkout they shared.
    name: "workspace-reuse-refusal",
    run: (db) => refreshWorkspaceReuseRefusalMetrics(db),
    setFresh: setWorkspaceReuseRefusalMetricsRefreshSuccess,
  },
  {
    // BLO-29850. Not a run-table refresh and not a queue the platform serves at
    // all: the board approval queue is served by humans, so every refresh above
    // is blind to it. It stopped for 3.2 days with 39 cards filed into it and
    // nothing could tell that apart from an empty queue.
    name: "approval-queue",
    run: (db) => refreshApprovalQueueMetrics(db),
    setFresh: setApprovalQueueMetricsRefreshSuccess,
  },
  {
    // PEN-4409. Every refresh above measures whether the platform is serving
    // work. This one measures whether a DECISION the platform recorded was ever
    // acted on -- a question no run, queue or lease gauge can reach, because the
    // acceptance is already terminal and the action belongs to someone else.
    // Report-only by construction: `refreshAcceptedInteractionOutcomeMetrics`
    // issues no writes and must never gain the ability to resolve a card.
    name: "accepted-interaction-outcome",
    run: (db) => refreshAcceptedInteractionOutcomeMetrics(db),
    setFresh: setAcceptedInteractionOutcomeMetricsRefreshSuccess,
    // The only refresh in this list on a cadence of its own. Its CTE scans every
    // accepted confirmation ever filed with two correlated EXISTS per row, and
    // that cost grows with history and never shrinks -- while what it measures
    // (has a person acted on a decision?) moves on a scale of hours against a
    // 24 h alerting threshold. Asking four times a minute bought nothing and
    // scanned the whole table 5.7k times a day to re-derive the same answer.
    minIntervalMs: 5 * 60_000,
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
    if (now - last > staleWindowFor(refresh, staleAfterMs)) refresh.setFresh?.(false);
  }
}

/**
 * How long this refresh may go without a success before its freshness gauge is
 * forced to 0.
 *
 * Scaled off `minIntervalMs` where one is set. The default window is six TICKS,
 * which silently assumes every refresh runs every tick — so a refresh
 * deliberately slowed below that window would be marked stale between every
 * pair of its own runs, firing its strand alert permanently and reporting a
 * working sweep as a broken one. Six of its OWN intervals keeps the original
 * "several consecutive misses, not one slow run" semantics at any cadence.
 */
function staleWindowFor(refresh: ScrapeRefresh, defaultStaleAfterMs: number): number {
  if (refresh.minIntervalMs === undefined) return defaultStaleAfterMs;
  return Math.max(defaultStaleAfterMs, 6 * refresh.minIntervalMs);
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
export function refreshDbPoolMetrics(db: Db, pool: "main" | "webhook" = "main"): void {
  const client = (db as { $client?: PoolStatsClient }).$client;
  const stats = client?.poolStats?.();
  if (stats) setDbPoolStats(stats, pool);
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

/**
 * PEN-3314: publish the native-memory accounting on the scrape path.
 *
 * On the scrape path rather than in {@link REFRESHES} for the third reason given
 * for {@link refreshFdClassMetrics}, which applies here with more force: this
 * gauge exists to be correlated against `process_resident_memory_bytes`,
 * `nodejs_heap_size_total_bytes` and `nodejs_external_memory_bytes`, all of which
 * prom-client renders at scrape time. `native_unaccounted` is a *subtraction* of
 * two of them, so a one-tick offset would not merely add noise — it would make
 * the published residual disagree with the same residual computed in PromQL from
 * the three default gauges, and the disagreement would be invisible.
 *
 * Unlike the descriptor walk this costs no syscall worth measuring:
 * `process.memoryUsage()` reads this process's own counters and
 * `v8.getHeapStatistics()` is an in-process struct copy.
 */
export function refreshNativeMemoryMetrics(): void {
  setNativeMemoryMetrics(collectNativeMemorySnapshot());
}

/**
 * PEN-3314: publish the RSS release record on the scrape path.
 *
 * The cheapest refresher in this file by a wide margin, and deliberately so: it
 * takes no reading of its own. The 1 s sampler has already folded every sample
 * into a handful of scalars, so this republishes in-process state and performs
 * no syscall at all.
 *
 * That asymmetry is the design. The measurement has to happen at 1 Hz to date a
 * release to the second, and it cannot happen on the scrape path, which runs at
 * 60 s — so the sampler owns the reading and the scrape owns only the publish.
 * Contrast {@link refreshProcessMappingMetrics}, whose reading is floored at a
 * 300 s cadence by its own O(resident pages) cost; that floor is precisely the
 * resolution limit this instrument exists to get under.
 */
export function refreshRssReleaseMetrics(): void {
  const reading = readRssReleases();
  setRssReleaseMetrics(reading);
  // Same reading, joined against the in-process GC ring. Done here rather than
  // inside the tracker because `rss-release-tracker` deliberately records no
  // candidate cause of its own -- it says WHEN, and folding a hypothesis into
  // it would make the instrument agree with whichever one it was built around.
  // The join belongs where both readings already meet, which is this collector.
  setRssReleaseGcAttributionMetrics(attributeRssReleaseGc(reading));
}

/**
 * PEN-3692: publish the worker cgroup's memory decomposition on the scrape path.
 *
 * On the scrape path for the same reason as {@link refreshNativeMemoryMetrics},
 * and it costs less: four small synthetic files, ~43.6 µs per read measured over
 * 1000 reads, and **O(1) in the leak** — these files do not grow with the charge
 * they report, unlike the `/proc/self/smaps` walk that forces
 * {@link refreshProcessMappingMetrics} onto a cadence floor.
 *
 * Reading all four in one pass is what keeps `current - anon - file` consistent
 * with the same subtraction recomputed in PromQL; sampling them a tick apart
 * would let the published residual disagree with the derived one invisibly.
 */
export function refreshCgroupMemoryMetrics(): void {
  setCgroupMemoryMetrics(collectCgroupMemorySnapshot());
}

/**
 * Last completed mapping scan, republished on every scrape in between.
 *
 * Module-level rather than passed in because the cadence is a property of the
 * *process*, not of any caller: `/metrics` can be scraped by more than one
 * client, and a per-caller cache would multiply the scan rate by the number of
 * scrapers — reintroducing exactly the event-loop cost the cadence exists to
 * bound.
 */
let lastMappingSnapshot: ProcessMappingSnapshot | null = null;
let lastMappingScanAtMs: number | null = null;

/** Test seam: forget the cached scan so the next refresh performs a real one. */
export function __resetProcessMappingCacheForTest(): void {
  lastMappingSnapshot = null;
  lastMappingScanAtMs = null;
}

/**
 * PEN-3314: publish the mapping-class attribution, scanning at most once per
 * {@link DEFAULT_MIN_SCAN_INTERVAL_MS}.
 *
 * ⚠ This is the one memory refresher that is NOT simply "do the work on the
 * scrape path", and the departure is deliberate. Its two neighbours justify
 * running per scrape on cost: `process.memoryUsage()` is a counter read, and
 * the descriptor walk is a bounded 43.7 ms at its cap. Neither holds here. The
 * `/proc/self/smaps` read costs O(resident pages) — measured 1.91 ms at 47 MB,
 * 35.96 ms at 1047 MB, **108.42 ms at 3037 MB** — so on this worker it is a
 * ~110 ms synchronous event-loop block whose cost *grows with the leak it
 * measures*, and `smaps_rollup` is not a cheaper fallback (108.53 ms at the
 * same RSS; it walks the same page tables).
 *
 * That matters beyond throughput. The step this row is chasing is a +672 MB
 * rise in one 60 s scrape during which the heartbeat-timer counter does not
 * advance — an event-loop stall. An instrument stalling the loop for ~110 ms
 * every 15 s would be injecting a weaker copy of the signature into the
 * evidence. At the 300 s floor the same scan is a 0.037% duty cycle, against
 * the ~0.3% {@link refreshFdClassMetrics} already accepts.
 *
 * Between scans the cached snapshot is republished verbatim, so the series stay
 * continuous and `paperclip_process_mapping_scan_timestamp_seconds` carries how
 * stale they are. A failed scan drops the cache rather than preserving it: a
 * frozen value that reads as live is the failure mode these three modules are
 * collectively built against.
 */
export function refreshProcessMappingMetrics(
  nowMs: number = Number(process.hrtime.bigint() / 1_000_000n),
): void {
  // MONOTONIC, not `Date.now()`. A backwards wall-clock step (NTP correction,
  // VM migration) would make this difference negative and suppress every scan
  // until the clock caught up, while the republished snapshot kept the series
  // looking live -- a stall that is invisible precisely because the cache is
  // working. The staleness timestamp on the snapshot stays wall-clock, because
  // its only consumer is `time() - timestamp` in PromQL.
  const due =
    lastMappingScanAtMs === null || nowMs - lastMappingScanAtMs >= DEFAULT_MIN_SCAN_INTERVAL_MS;
  if (due) {
    lastMappingScanAtMs = nowMs;
    lastMappingSnapshot = collectProcessMappingSnapshot();
  }
  setProcessMappingMetrics(lastMappingSnapshot);
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
        // Cadence is checked against the last SUCCESS, not the last attempt, so
        // a failing slow refresh keeps retrying on every tick rather than
        // holding its own failure for another full interval.
        if (refresh.minIntervalMs !== undefined) {
          const last = lastSuccessMs.get(refresh.name);
          if (last !== undefined && now() - last < refresh.minIntervalMs) continue;
        }
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
