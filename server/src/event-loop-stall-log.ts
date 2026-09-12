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

import { monitorEventLoopDelay } from "node:perf_hooks";
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
  sampleMs?: number;
  log?: (fields: Record<string, number>, message: string) => void;
}

/** Starts sampling. Returns a stop function; the timer is unref'd either way. */
export function startEventLoopStallLogging(
  options: EventLoopStallLogOptions = {},
): () => void {
  const thresholdMs = options.thresholdMs ?? resolveStallThresholdMs();
  if (thresholdMs <= 0) return () => {};

  const sampleMs = options.sampleMs ?? DEFAULT_SAMPLE_MS;
  const log = options.log ?? ((fields, message) => logger.warn(fields, message));

  const delay = monitorEventLoopDelay({ resolution: HISTOGRAM_RESOLUTION_MS });
  delay.enable();
  // Measured quirks, both harmless here but non-obvious if you read the output:
  // the histogram records nothing until the loop has iterated once after
  // enable(), and its `max` carries the resolution interval as a ~20ms floor.
  // At a 1s threshold that is 2% of noise on a signal we only read in seconds.
  let windowStart = Date.now();

  const timer = setInterval(() => {
    const stallMs = delay.max / 1e6;
    const now = Date.now();
    // The stall delays this timer too, so the window is >= sampleMs; report the
    // measured one rather than the nominal.
    const windowMs = now - windowStart;
    windowStart = now;
    delay.reset();
    if (stallMs >= thresholdMs) {
      log(
        { stallMs: Math.round(stallMs), windowMs, thresholdMs },
        "event loop stalled",
      );
    }
  }, sampleMs);
  timer.unref();

  return () => {
    clearInterval(timer);
    delay.disable();
  };
}

// ponytail: no phase attribution — the issue asked for "the current dispatcher
// phase", but there is no dispatcher: ~15 independent setInterval reconcilers
// tick on their own timers with no shared tick wrapper to hang a phase label
// off. Adding one means touching every reconciler. The timestamp joins against
// their existing per-tick logs. If log adjacency turns out to be ambiguous in a
// real incident, add a withPhase() wrapper at each scheduler.setInterval site.
