/**
 * @fileoverview Timestamp the instant this process RELEASES resident memory
 * wholesale, at 1 s resolution, from inside the process (PEN-3314).
 *
 * ## Why a fourth memory instrument, and what is structurally missing
 *
 * PEN-3314 has converged on a negative result about *where* the next evidence
 * can come from. The retention is V8's own page-pool/unmapper recycling —
 * ~800 MB of mappings of exactly one V8 page (262,144 B), owned by no V8 space
 * and absent from `total_physical_size` — and it is **not monotonic**: RSS ran
 * 1800.8 -> 1073.6 MB and back to 1929.6 on one generation, returning 100% of
 * `anon_other` and 100% of the 262144 size bucket (-2234 mappings x 262,144 B =
 * 585.6 MB against 588.3 MB observed). The mapping COUNT fell, so V8 called
 * `munmap`; this is a release, not kernel reclaim.
 *
 * The open question is what triggers it, and the answer on 2026-10-26 was that
 * **nothing in Prometheus marks the instant**: not GC, not in-flight runs, not
 * dispatch, not container stall, not node PSI. Deeper load lulls in the same
 * generation produce no release, and the generation's load minimum lands on the
 * REFILL rather than the release. The trigger is in-process, and Prometheus is
 * exhausted on it.
 *
 * It is exhausted for a reason this module can actually fix. Every existing
 * instrument on this row is blind to a release *by construction*:
 *
 *   - {@link module:server/services/heap-peak-tracker} samples at 1 s but keeps
 *     a monotonic HIGH-WATER mark. A maximum cannot go down, so a release is
 *     exactly the event it is built not to record.
 *   - {@link module:server/services/process-mapping-metrics} is the instrument
 *     that *can* see the 262144 bucket drain, but its scan costs O(resident
 *     pages) (~110 ms at 3 GB) and is therefore floored at a 300 s cadence.
 *   - Everything else is scrape-resolution, i.e. 60 s at best.
 *
 * So the finest timestamp this row can currently put on a release is +/-300 s,
 * against a candidate trigger set whose members move on sub-second timescales.
 * That is the gap. This module closes it to +/-1 s for the price of one
 * `process.memoryUsage.rss()` call per second.
 *
 * ## What it publishes that a timestamp alone would not
 *
 * A release is not always a step. The two shapes this row has measured are a
 * ~15 minute drain of 3.3 GB and a drop that completed inside one scrape, and
 * they are different phenomena wearing one word. {@link RssReleaseReading}
 * therefore carries BOTH ends of the episode:
 *
 *   - {@link RssReleaseReading.lastOnsetAtMs} — the last sample at which RSS was
 *     at its pre-release high. This is the *start* of the drawdown, and it is
 *     the number to align other evidence against.
 *   - {@link RssReleaseReading.lastDetectedAtMs} — the sample at which the
 *     drawdown first crossed {@link DEFAULT_RELEASE_THRESHOLD_BYTES}.
 *
 * Their difference is the time taken to shed a FIXED number of bytes, so it is
 * comparable across episodes: ~1 s apart is a step, minutes apart is a drain.
 * A reader who has only the detection instant cannot tell those apart, and
 * would align a trigger search against the wrong end of a 15 minute window.
 *
 * ## Episodes, not edges — and why a consecutive-sample delta is wrong here
 *
 * The obvious detector compares each sample with the one before it and fires on
 * a large negative step. It would have MISSED the 3.3 GB release outright: over
 * 15 minutes that is ~3.6 MB/s, far below any threshold that is also above
 * ordinary churn. There is no threshold that catches both shapes edgewise.
 *
 * {@link recordRssSample} is a drawdown detector instead. It tracks a running
 * high-water mark and opens an EPISODE when RSS falls a threshold below it,
 * which fires once for a step and once for a drain, deepening the recorded
 * magnitude as a drain continues rather than minting an event per sample.
 *
 * The episode closes when RSS recovers a threshold above its trough — the
 * refill — and the high-water mark re-anchors there. Closing on recovery past
 * the ORIGINAL peak would be wrong: a release followed by a partial refill that
 * plateaus below the old high would leave the episode open forever, and the
 * next release would then go unreported. That is the staircase this row has
 * measured, so it is the case the detector has to survive, not an edge case.
 *
 * ## Cost — and the one "optimisation" that must never be made here
 *
 * `process.memoryUsage.rss()` is the documented narrow path that reads ONLY
 * resident set size; on Linux it is `uv_resident_set_memory`, a read of the
 * fixed-size `/proc/self/stat`. It is O(1) in the footprint, which is the
 * property that makes 1 Hz admissible.
 *
 * ⛔ Do NOT "improve" this by sourcing RSS from `/proc/self/smaps`, or by
 * folding this sampler into the mapping scan to get the per-bucket detail.
 * `smaps` and `smaps_rollup` both walk page tables and cost ~36 us/MB resident —
 * 110 ms at 3 GB, measured, and that is a synchronous event-loop block. The
 * signature this row is chasing IS an event-loop stall, and a 110 ms block every
 * second is a 11% duty cycle that would inject a copy of the phenomenon into the
 * measurement. The cheapness of the reading is not incidental to this module; it
 * is the reason it is allowed to run at the only frequency that answers the
 * question. The per-bucket detail stays at its 300 s cadence where it belongs.
 *
 * ## What it is not
 *
 * ⛔ Not a fix, and not an alert source. It dates the release; it does not stop
 * it, and PEN-3314 does not close on this landing.
 *
 * ⛔ Not an attribution. It says WHEN, not WHY. Naming the trigger needs this
 * timestamp joined against something else, and this module deliberately records
 * no candidate cause of its own — folding a guess in here would make the
 * instrument agree with whichever hypothesis it was built around.
 *
 * ⛔ A LOWER BOUND, like every sampler on this row. A release that completes and
 * fully refills inside one interval is invisible, and a drawdown shallower than
 * {@link DEFAULT_RELEASE_THRESHOLD_BYTES} is not an episode. **A zero event
 * count is therefore not evidence that no release occurred** — read it against
 * {@link RssReleaseReading.sampleCount}, which is published for exactly this
 * reason: "sampled 40 000 times, saw no drawdown past 64 MiB" and "the sampler
 * never ran" are the same zero and opposite conclusions, and this row has
 * already paid two months for that conflation once.
 *
 * @module server/services/rss-release-tracker
 */

/**
 * Sampling period.
 *
 * 1 s, matching {@link module:server/services/heap-peak-tracker} deliberately:
 * the two samplers are read together, and a release timestamped on a different
 * grid from the heap peaks would have to be reconciled before it could be
 * compared with them.
 *
 * Deliberately NOT faster, for that module's reason and one of its own. A
 * sub-second timer is a real wakeup on a container that is event-loop stalled at
 * precisely the moments this instrument cares about; and the release this exists
 * to date took minutes at its slowest and a single scrape interval at its
 * fastest, so 1 s already resolves both with three orders of margin against the
 * 300 s floor it replaces.
 */
export const DEFAULT_SAMPLE_INTERVAL_MS = 1_000;

/**
 * How far RSS must fall below its running high-water mark to open an episode.
 *
 * 64 MiB is chosen against both tails of the measured distribution. The
 * smallest release this row has recorded is 585.6 MB, so the threshold sits ~9x
 * below the signal; ordinary per-second RSS variation on this worker is single-
 * digit MB, so it sits well above the noise. Nothing in between has been
 * observed, which is what makes a single threshold viable at all.
 *
 * ⚠ It bounds what is detectable in BOTH directions, and the quiet direction is
 * the dangerous one: a drawdown of 63 MiB is not an episode and is not reported.
 * Lowering it would admit GC churn as false episodes and destroy the series'
 * meaning; raising it would silently discard the smaller releases. Change it
 * only against a measured distribution, never to make a number look better.
 */
export const DEFAULT_RELEASE_THRESHOLD_BYTES = 64 * 1024 * 1024;

export interface RssReleaseReading {
  /** Episodes opened since process start. Monotonic within a process. */
  releaseCount: number;
  /** Sum of every episode's peak-to-trough drop, in bytes. Monotonic within a process. */
  releasedBytesTotal: number;
  /**
   * Epoch ms of the LAST sample at which RSS stood at its pre-release high —
   * the START of the most recent drawdown. `null` until one is observed.
   *
   * Last, not first: a plateau at the high can run for hours, and dating the
   * onset from when the climb stopped would point a trigger search at an
   * arbitrary quiet instant. See {@link recordRssSample}.
   */
  lastOnsetAtMs: number | null;
  /**
   * Epoch ms at which that drawdown first crossed the threshold. `null` until
   * one is observed. Read WITH {@link lastOnsetAtMs}: the gap is the time taken
   * to shed a fixed number of bytes, which is what separates a step from a drain.
   */
  lastDetectedAtMs: number | null;
  /**
   * Peak-to-trough size of the most recent episode, in bytes. `null` until one
   * is observed. Grows while a drain is still deepening, so it is the episode's
   * running total rather than its value at detection.
   */
  lastReleaseBytes: number | null;
  /** Whether a drawdown is open right now, i.e. RSS has not yet refilled. */
  episodeOpen: boolean;
  /** How many samples contributed. 0 means the sampler never ran — see the module docblock. */
  sampleCount: number;
  /** The interval those samples were taken at, which bounds what could have been missed. */
  sampleIntervalMs: number;
  /** The drawdown depth required to open an episode, which bounds what is detectable at all. */
  thresholdBytes: number;
}

interface TrackerState {
  peakBytes: number | null;
  peakAtMs: number;
  episodeOpen: boolean;
  episodeTroughBytes: number;
  releaseCount: number;
  releasedBytesTotal: number;
  lastOnsetAtMs: number | null;
  lastDetectedAtMs: number | null;
  lastReleaseBytes: number | null;
  sampleCount: number;
  sampleIntervalMs: number;
  thresholdBytes: number;
}

function initialState(): TrackerState {
  return {
    peakBytes: null,
    peakAtMs: 0,
    episodeOpen: false,
    episodeTroughBytes: 0,
    releaseCount: 0,
    releasedBytesTotal: 0,
    lastOnsetAtMs: null,
    lastDetectedAtMs: null,
    lastReleaseBytes: null,
    sampleCount: 0,
    sampleIntervalMs: DEFAULT_SAMPLE_INTERVAL_MS,
    thresholdBytes: DEFAULT_RELEASE_THRESHOLD_BYTES,
  };
}

const state: TrackerState = initialState();

function finite(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Fold one RSS reading into the drawdown detector.
 *
 * Exported so the detector is testable without a timer: a test that waits for
 * real wall-clock ticks to assert an episode boundary tests the scheduler, not
 * the measurement — and the shapes that matter here (a 15 minute drain, a
 * partial refill) are not reproducible in real time at all.
 *
 * A non-finite reading still increments {@link RssReleaseReading.sampleCount}
 * and folds nothing, matching the sibling sampler: the count's job is to say
 * whether the sampler is alive, so conflating "running, but this runtime
 * reported no RSS" with "never started" would reintroduce the unmeasurable-
 * versus-zero ambiguity the module exists to avoid.
 */
export function recordRssSample(rssBytes: number | undefined, nowMs: number): void {
  state.sampleCount += 1;
  if (!finite(rssBytes)) return;

  // First reading establishes the high-water mark. It is not a drawdown of the
  // whole footprint from zero, which is what folding it through the branches
  // below would make it.
  if (state.peakBytes === null) {
    state.peakBytes = rssBytes;
    state.peakAtMs = nowMs;
    return;
  }

  if (state.episodeOpen) {
    // Still draining: deepen the episode rather than opening a second one.
    if (rssBytes < state.episodeTroughBytes) {
      state.releasedBytesTotal += state.episodeTroughBytes - rssBytes;
      state.episodeTroughBytes = rssBytes;
      state.lastReleaseBytes = state.peakBytes - state.episodeTroughBytes;
      return;
    }
    // Refilling. Close on recovery above the TROUGH, not above the old peak —
    // see the module docblock: a partial refill that plateaus below the old
    // high would otherwise hold the episode open forever and swallow the next
    // release. Re-anchor the high-water mark here so the next drawdown is
    // measured from the level RSS actually returned to.
    if (rssBytes - state.episodeTroughBytes >= state.thresholdBytes) {
      state.episodeOpen = false;
      state.peakBytes = rssBytes;
      state.peakAtMs = nowMs;
    }
    return;
  }

  // Climbing, or holding AT the high: ratchet the mark and restamp it, because
  // that timestamp becomes the onset of whatever drawdown follows.
  //
  // `>=`, not `>`, and the difference is the whole value of the onset series. A
  // process that sits at its high for three hours and then releases has an
  // onset at the END of that plateau, not at its start: with `>` the stamp
  // would stay at the FIRST sample to reach the high and date the drawdown
  // hours before anything moved, sending a trigger search to a quiet instant
  // chosen by when the climb happened to stop.
  if (rssBytes >= state.peakBytes) {
    state.peakBytes = rssBytes;
    state.peakAtMs = nowMs;
    return;
  }

  const drawdownBytes = state.peakBytes - rssBytes;
  if (drawdownBytes < state.thresholdBytes) return;

  state.episodeOpen = true;
  state.episodeTroughBytes = rssBytes;
  state.releaseCount += 1;
  state.releasedBytesTotal += drawdownBytes;
  state.lastReleaseBytes = drawdownBytes;
  state.lastOnsetAtMs = state.peakAtMs;
  state.lastDetectedAtMs = nowMs;
}

/**
 * Read the release record.
 *
 * Returns `null` when no sample has ever been folded in, so "the sampler is not
 * running" publishes nothing rather than a set of zeroes. Zero events is a
 * legitimate and interesting reading for a live sampler; it is a lie for one
 * that never started, and those are the same numbers.
 */
export function readRssReleases(): RssReleaseReading | null {
  if (state.sampleCount === 0) return null;
  return {
    releaseCount: state.releaseCount,
    releasedBytesTotal: state.releasedBytesTotal,
    lastOnsetAtMs: state.lastOnsetAtMs,
    lastDetectedAtMs: state.lastDetectedAtMs,
    lastReleaseBytes: state.lastReleaseBytes,
    episodeOpen: state.episodeOpen,
    sampleCount: state.sampleCount,
    sampleIntervalMs: state.sampleIntervalMs,
    thresholdBytes: state.thresholdBytes,
  };
}

export interface StartRssReleaseTrackingOptions {
  intervalMs?: number;
  thresholdBytes?: number;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
  residentSetSize?: () => number;
  now?: () => number;
}

/**
 * Start sampling. Returns a stop function, matching the other pollers wired in
 * `app.ts`.
 *
 * The timer is `unref()`d so this instrument can never be the reason the process
 * stays alive. A diagnostic that keeps a worker from exiting would turn a clean
 * shutdown into the hung-pod failure that PEN-3294 already owns.
 *
 * A throwing read is swallowed per-tick rather than tearing down the sampler, and
 * is NOT counted as a sample: the read is on a timer with no caller to surface
 * the error to, one bad tick is not a reason to go blind for the life of the
 * process, and a tick that read nothing is not evidence the sampler is observing
 * anything.
 */
export function startRssReleaseTracking(options: StartRssReleaseTrackingOptions = {}): () => void {
  const intervalMs = options.intervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS;
  const schedule = options.setInterval ?? setInterval;
  const cancel = options.clearInterval ?? clearInterval;
  const now = options.now ?? Date.now;
  // The narrow path, not `process.memoryUsage()`. See the cost note in the
  // module docblock: reading only RSS is what keeps this O(1) in the footprint.
  const readRss = options.residentSetSize ?? (() => process.memoryUsage.rss());

  state.sampleIntervalMs = intervalMs;
  state.thresholdBytes = options.thresholdBytes ?? DEFAULT_RELEASE_THRESHOLD_BYTES;

  const timer = schedule(() => {
    let rssBytes: number;
    try {
      rssBytes = readRss();
    } catch {
      return;
    }
    recordRssSample(rssBytes, now());
  }, intervalMs);
  if (typeof (timer as { unref?: () => void }).unref === "function") {
    (timer as { unref: () => void }).unref();
  }

  // Idempotent, matching the sibling sampler: a second call must not clear a
  // handle this sampler no longer owns.
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    cancel(timer as Parameters<typeof clearInterval>[0]);
  };
}

/** Reset module state between tests. Not for production use. */
export function __resetRssReleaseTrackerForTest(): void {
  Object.assign(state, initialState());
}
