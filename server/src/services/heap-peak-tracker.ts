/**
 * @fileoverview Track this process's lifetime PEAK V8 heap size, because the
 * 60-second scrape cannot see the excursion that does the damage (PEN-3314).
 *
 * ## Why a sampler, when `nodejs_heap_size_used_bytes` already exists
 *
 * PEN-3314 spent weeks concluding that the heap gauges had "stopped tracking"
 * the process, because every per-generation comparison it ran was a FLOOR
 * statistic — `min_over_time`, `deriv` over a floor, a slope across a
 * generation. On 2026-10-14 the retention event was finally caught in the act on
 * `paperclip-api-9bc98b85b-r4xbn`, at 1-minute resolution, within one process:
 *
 * | time  | heapUsed | heapTotal | rss  |
 * |-------|----------|-----------|------|
 * | 19:12 | 2872 MB  | 3001 MB   | 3368 |
 * | 19:15 | **3010** | 3134      | —    |
 * | 19:16 | **558**  | **661**   | 3474 |
 * | 19:24 | 394      | 548       | 3502 |
 *
 * V8's live heap reached 3.01 GB and a GC returned it to 0.56 GB inside one
 * minute. RSS did not follow it down — it rose, and held ~3.5 GB for hours
 * afterwards. So the heap gauge was never blind; the *statistic* was. The
 * excursion is the cause and the resident floor is only its receipt, which is
 * why a heap snapshot taken between excursions answers nothing and why a floor
 * slope is guaranteed to miss it.
 *
 * ## What this module adds
 *
 * A monotonic high-water mark, sampled on a short internal timer and published
 * at scrape time. That converts a transient into a durable number. The same
 * pattern already exists one module over as V8's own `peak_malloced_memory`
 * (`native-memory-metrics.ts`); this is that idea applied to the heap, where the
 * measured 3 GB excursion actually lives.
 *
 * ## ⛔ It is still a LOWER BOUND, and that matters more here than anywhere
 *
 * An excursion shorter than {@link DEFAULT_SAMPLE_INTERVAL_MS} is still invisible.
 * Sampling at 1 s tightens the bound against the 60 s scrape by ~60x; it does not
 * remove it. **A flat peak is therefore not evidence that no excursion occurred**
 * — it is evidence that none lasting at least one sample interval occurred.
 *
 * That distinction is not pedantry on this row. Reading "the number is low" as
 * "the problem is absent" is the exact error that cost PEN-3314 two months on
 * `nodejs_heap_size_used_bytes`, and it is the reason {@link readHeapPeaks}
 * reports {@link HeapPeakReading.sampleCount} and
 * {@link HeapPeakReading.sampleIntervalMs}: a reader who sees a low peak can
 * tell "sampled 18 000 times, nothing above 1.1 GB" apart from "the sampler
 * never started", which are the same gauge value and opposite conclusions.
 *
 * ## What it is not
 *
 * ⛔ Not a fix, and not an alert source on its own. It answers one question —
 * does the worker have heap excursions the scrape cannot see? — and that answer
 * decides whether the worker and the api are the same bug.
 *
 * @module server/services/heap-peak-tracker
 */

import { getHeapStatistics } from "node:v8";

/**
 * Sampling period.
 *
 * 1 s is chosen against the measured event, not for roundness: the api
 * excursion above held above 2.8 GB for ~4 minutes, and the worker's own steps
 * complete inside a single 60 s scrape. 1 s resolves both with margin while
 * costing one in-process struct copy per second.
 *
 * Deliberately NOT faster. The cost here is not the read — it is that a
 * sub-second timer is a real wakeup on a container that is already event-loop
 * stalled at exactly the moments this instrument cares about, and stalling the
 * loop harder during the event under study would corrupt the measurement it
 * exists to take.
 */
export const DEFAULT_SAMPLE_INTERVAL_MS = 1_000;

/** Lifetime peak of `v8.getHeapStatistics().used_heap_size`. */
export const HEAP_USED_PEAK_COMPONENT = "heap_used_peak";
/** Lifetime peak of `v8.getHeapStatistics().total_heap_size` (V8's COMMITTED heap). */
export const HEAP_TOTAL_PEAK_COMPONENT = "heap_total_peak";

export interface HeapPeakReading {
  /** Highest `used_heap_size` seen since process start, in bytes. */
  usedPeakBytes: number;
  /** Highest `total_heap_size` seen since process start, in bytes. */
  totalPeakBytes: number;
  /** How many samples contributed. 0 means the sampler never ran — see the module docblock. */
  sampleCount: number;
  /** The interval those samples were taken at, which bounds what could have been missed. */
  sampleIntervalMs: number;
}

/** Subset of `v8.getHeapStatistics()` this module reads. Optional by Node version. */
export interface HeapSizeReading {
  used_heap_size?: number;
  total_heap_size?: number;
}

interface TrackerState {
  usedPeakBytes: number;
  totalPeakBytes: number;
  sampleCount: number;
  sampleIntervalMs: number;
}

const state: TrackerState = {
  usedPeakBytes: 0,
  totalPeakBytes: 0,
  sampleCount: 0,
  sampleIntervalMs: DEFAULT_SAMPLE_INTERVAL_MS,
};

function finite(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Fold one reading into the running maxima.
 *
 * Exported so the peak logic is testable without a timer: a test that has to
 * wait for real wall-clock ticks to assert a maximum tests the scheduler, not
 * the measurement.
 *
 * A reading whose fields are both absent still increments
 * {@link HeapPeakReading.sampleCount}, because the count's job is to say whether
 * the sampler is alive — conflating "running but this runtime reports no heap
 * sizes" with "never started" would reintroduce the unmeasurable-versus-zero
 * ambiguity this row keeps paying for.
 */
export function recordHeapPeakSample(reading: HeapSizeReading): void {
  state.sampleCount += 1;
  if (finite(reading.used_heap_size) && reading.used_heap_size > state.usedPeakBytes) {
    state.usedPeakBytes = reading.used_heap_size;
  }
  if (finite(reading.total_heap_size) && reading.total_heap_size > state.totalPeakBytes) {
    state.totalPeakBytes = reading.total_heap_size;
  }
}

/**
 * Read the peaks.
 *
 * Returns `null` when no sample has ever been folded in, so "the sampler is not
 * running" publishes nothing rather than a pair of zeroes. Zero is a legitimate
 * peak only for a process that has never allocated, which no process reaching a
 * `/metrics` scrape ever is — so a published 0 would be read as a measurement
 * and it would be wrong.
 */
export function readHeapPeaks(): HeapPeakReading | null {
  if (state.sampleCount === 0) return null;
  return {
    usedPeakBytes: state.usedPeakBytes,
    totalPeakBytes: state.totalPeakBytes,
    sampleCount: state.sampleCount,
    sampleIntervalMs: state.sampleIntervalMs,
  };
}

export interface StartHeapPeakTrackingOptions {
  intervalMs?: number;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
  heapStatistics?: () => HeapSizeReading;
}

/**
 * Start sampling. Returns a stop function, matching the other pollers wired in
 * `app.ts`.
 *
 * The timer is `unref()`d so this instrument can never be the reason the process
 * stays alive. A diagnostic that keeps a worker from exiting would turn a clean
 * shutdown into the hung-pod failure that PEN-3294 already owns.
 *
 * A throwing `getHeapStatistics` is swallowed per-tick rather than tearing down
 * the sampler: the read is on a timer with no caller to surface the error to, and
 * one bad tick is not a reason to go blind for the life of the process. The
 * sample is not counted in that case, because a tick that read nothing is not
 * evidence that the sampler is observing anything.
 */
export function startHeapPeakTracking(options: StartHeapPeakTrackingOptions = {}): () => void {
  const intervalMs = options.intervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS;
  const schedule = options.setInterval ?? setInterval;
  const cancel = options.clearInterval ?? clearInterval;
  const readHeapStatistics = options.heapStatistics ?? (() => getHeapStatistics() as HeapSizeReading);

  state.sampleIntervalMs = intervalMs;

  const timer = schedule(() => {
    let reading: HeapSizeReading;
    try {
      reading = readHeapStatistics();
    } catch {
      return;
    }
    recordHeapPeakSample(reading);
  }, intervalMs);
  if (typeof (timer as { unref?: () => void }).unref === "function") {
    (timer as { unref: () => void }).unref();
  }

  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    cancel(timer as Parameters<typeof clearInterval>[0]);
  };
}

/** Test-only. Mirrors `__resetMetricsForTest`; the peaks are process-lifetime otherwise. */
export function __resetHeapPeakTrackerForTest(): void {
  state.usedPeakBytes = 0;
  state.totalPeakBytes = 0;
  state.sampleCount = 0;
  state.sampleIntervalMs = DEFAULT_SAMPLE_INTERVAL_MS;
}
