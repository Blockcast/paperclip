// Event-loop stall logging (BLO-32668).
//
// `nodejs_eventloop_lag_max_seconds` is a scraped gauge, and on this deployment
// roughly half the scrapes are lost (BLO-33243), so a multi-second stall is
// routinely invisible: the founding 9.72s worker stall was noticed only because
// it also flapped the readiness probe, and a 2.98s stall on 2026-09-12 does not
// appear at all on a 5m grid. This samples the loop in-process once a second and
// emits one warn line per stalled window, independent of the scrape path.
//
// Attribution is by timestamp: the sweeps already log continuously, so a stall
// line lands next to whatever was running. See the ponytail note below.

import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { logger } from "./middleware/logger.js";

const DEFAULT_THRESHOLD_MS = 1_000;
const DEFAULT_SAMPLE_MS = 1_000;
/** Coarser than the stalls we care about, fine enough not to miss a 1s block. */
const HISTOGRAM_RESOLUTION_MS = 20;

/**
 * `PAPERCLIP_EVENT_LOOP_STALL_LOG_MS` in ms. `0` disables logging entirely;
 * unset/blank/invalid falls back to 1000. Tunable because a production deploy
 * here can take over a day, so the threshold must be changeable without one.
 */
export function resolveStallThresholdMs(
  raw: string | undefined = process.env.PAPERCLIP_EVENT_LOOP_STALL_LOG_MS,
): number {
  const trimmed = raw?.trim();
  if (!trimmed) return DEFAULT_THRESHOLD_MS;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_THRESHOLD_MS;
  return parsed;
}

export interface EventLoopStallLogOptions {
  thresholdMs?: number;
  /**
   * Keep this an order of magnitude above `HISTOGRAM_RESOLUTION_MS`. After a
   * stall both this timer and the histogram's own are overdue, and if libuv
   * runs ours first the histogram is re-armed before it can record — `max`
   * reads 0 and that stall is lost from the histogram, unrecoverably. It is
   * NOT deferred to the next window: `reset()` clears the histogram's own
   * previous-tick timestamp, so the overdue tick records nothing when it
   * finally runs (40 of 40 misses lost, never recovered — PEN-3381). The
   * default 1000ms leaves the histogram overdue by nearly a second more, so it
   * normally wins (0 misses in 26 blocks). At 50ms the two are within the
   * resolution and ours wins ~27% of the time on an idle host and ~78% on a
   * 4-core cgroup at load ~12 (BLO-22985, re-measured PEN-3381).
   *
   * That race no longer decides whether a stall is reported: `lagMs` below is
   * a second detector the race cannot reach. Lowering this is still not free —
   * `lagMs` under-reports by up to one sample interval, so a smaller value
   * makes the floor tighter, not looser.
   */
  sampleMs?: number;
  log?: (fields: Record<string, number>, message: string) => void;
  /**
   * The delay histogram, for tests. Defaults to a real `monitorEventLoopDelay`
   * and production never passes it. It exists because the histogram's reading
   * is decided by the libuv race above, so a test that drives a REAL stall
   * cannot deterministically exercise the histogram arm of `stallMs` — pinning
   * `max` is the only way to cover that path without a coin flip.
   */
  histogram?: EventLoopDelayHistogram;
}

/**
 * The slice of node's `IntervalHistogram` this sampler touches. Narrow on
 * purpose: a stub needs four members, not the whole interface.
 */
export interface EventLoopDelayHistogram {
  enable(): unknown;
  disable(): unknown;
  reset(): void;
  /** Largest delay observed in the current window, in NANOseconds. */
  readonly max: number;
}

/**
 * One listener, called after each logged stall. A setter rather than a start
 * option because the sampler starts before config loads and later starts are
 * no-ops (see below). Used by the worker's stall-triggered profile (BLO-45336).
 */
let stallListener: ((stallMs: number) => void) | null = null;
export function setEventLoopStallListener(fn: ((stallMs: number) => void) | null): void {
  stallListener = fn;
}

/** Non-null while a sampler is running. See the idempotency note below. */
let activeStop: (() => void) | null = null;

/**
 * Starts sampling. Returns a stop function; the timer is unref'd either way.
 *
 * Idempotent: a second start while one is running is a no-op that hands back
 * the running sampler's disposer, so the caller's options are ignored. The
 * alternative — wiring the disposer through shutdown — does not fix the case
 * that actually occurs: `startServer()` is exported and called repeatedly
 * in-process by the test suite (25 times in one file), which sends no
 * `SIGINT`/`SIGTERM`, so every prior histogram and interval would stay live
 * and degrade the very loop they measure. Same reasoning, and the same remedy,
 * as the crash guard installing under `isMainModule` rather than in
 * `startServer()`.
 */
export function startEventLoopStallLogging(
  options: EventLoopStallLogOptions = {},
): () => void {
  if (activeStop) return activeStop;

  const thresholdMs = options.thresholdMs ?? resolveStallThresholdMs();
  if (thresholdMs <= 0) return () => {};

  const sampleMs = options.sampleMs ?? DEFAULT_SAMPLE_MS;
  const log = options.log ?? ((fields, message) => logger.warn(fields, message));

  const delay: EventLoopDelayHistogram =
    options.histogram ?? monitorEventLoopDelay({ resolution: HISTOGRAM_RESOLUTION_MS });
  delay.enable();
  // Measured quirks, both harmless here but non-obvious if you read the output:
  // the histogram records nothing until the loop has iterated once after
  // enable(), and its `max` carries the resolution interval as a ~20ms floor.
  // At a 1s threshold that is 2% of noise on a signal we only read in seconds.
  // Monotonic: `lagMs` below is derived from this, and a wall-clock step would
  // manufacture or erase a stall that never happened.
  let windowStart = performance.now();

  const timer = setInterval(() => {
    const histogramMs = delay.max / 1e6;
    const now = performance.now();
    // The stall delays this timer too, so the window is >= sampleMs; report the
    // measured one rather than the nominal.
    const windowMs = now - windowStart;
    windowStart = now;
    delay.reset();
    // Second detector, and the only one the re-arm race cannot take away: this
    // interval cannot run while the loop is blocked, so the interval's own
    // lateness is a FLOOR on how long the loop was unresponsive. A block of D
    // ms sits entirely inside one window, so windowMs >= D and lagMs >= D -
    // sampleMs, whatever libuv does — and contention can only make the tick
    // later, i.e. it moves this quantity AWAY from a missed detection.
    //
    // A floor, not a replacement. A stall shorter than one sample interval can
    // miss its deadline by anything down to zero, so `lagMs` under-reports by
    // up to `sampleMs`: at the production 1000ms sampling a 1.2s stall shows
    // lagMs 200 and is caught by the histogram, not by this. The histogram
    // stays the sensitive detector; this is the robust one. Report both so an
    // operator can see which fired.
    const lagMs = Math.max(0, windowMs - sampleMs);
    const stallMs = Math.max(histogramMs, lagMs);
    if (stallMs >= thresholdMs) {
      log(
        {
          stallMs: Math.round(stallMs),
          histogramMs: Math.round(histogramMs),
          lagMs: Math.round(lagMs),
          windowMs: Math.round(windowMs),
          thresholdMs,
        },
        "event loop stalled",
      );
      stallListener?.(stallMs);
    }
  }, sampleMs);
  timer.unref();

  const stop = () => {
    clearInterval(timer);
    delay.disable();
    // Only deregister if we are still the live sampler: a disposer called
    // twice, after a later start, must not unregister that later sampler.
    if (activeStop === stop) activeStop = null;
  };
  activeStop = stop;
  return stop;
}

// ponytail: no phase attribution — the issue asked for "the current dispatcher
// phase", but there is no dispatcher: ~15 independent setInterval reconcilers
// tick on their own timers with no shared tick wrapper to hang a phase label
// off. Adding one means touching every reconciler. The timestamp joins against
// their existing per-tick logs. If log adjacency turns out to be ambiguous in a
// real incident, add a withPhase() wrapper at each scheduler.setInterval site.
