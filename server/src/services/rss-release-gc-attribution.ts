/**
 * @fileoverview Count the GC cycles that fired AROUND a release onset, in a
 * window narrow enough to mean something, against an ambient baseline measured
 * the same way (PEN-3314).
 *
 * ## The gap this closes, stated exactly
 *
 * PEN-3314 has two instruments that cannot be read against each other:
 *
 *   - {@link module:server/services/rss-release-tracker} dates a release ONSET
 *     to +/-1 s, in-process.
 *   - {@link module:server/services/gc-flags-metrics} counts GC cycles by
 *     `{kind, flags}` into a prom-client COUNTER, readable only at the scrape.
 *
 * The scrape is 30 s on this fleet, and its buckets are aligned to scrape
 * boundaries rather than to anything that happened. So joining them in PromQL
 * takes a +/-1 s instant and asks a 30 s average about it: that selects WHICH
 * bucket to look in — the +/-300 s stamp this row had before spanned ten of
 * them — but every correlate inside it is still a 30 s mean. That is the whole
 * content of the row's standing "Prometheus is exhausted on the trigger"
 * finding, and it is a limit of the READOUT, not of the evidence.
 *
 * This module does the join in-process, where the entries still carry their own
 * instants, and publishes the result. The window is the caller's, centred on the
 * onset rather than on a scrape boundary.
 *
 * ## ⚠ Why a baseline window ships beside it, and why it is not optional
 *
 * PEN-3314's single most expensive repeated error is reading an ambient signal
 * as a marker. Major GC at event magnitude holds in **93.4%** of all 30 s
 * samples on the instances that released (3347/3582) — a 0.12% precision for
 * "release" — and fired 2148 times on a worker that released zero times. So
 * "4 major cycles fired within 5 s of the onset" is, on its own, worth nothing:
 * it is the expected number.
 *
 * A reader given only the onset window will nonetheless read it as a finding.
 * That is not a hypothetical; it is this row's history. So the baseline window
 * is published from the same ring, at the SAME width, over a stretch of the same
 * generation that contains no onset — making the only defensible comparison the
 * cheap one. ⛔ Do not quote the onset counts without the baseline counts. A
 * ratio near 1 is the standing refutation holding at a resolution that can
 * finally test it; a ratio far from 1 is the first positive result this row has
 * had on the trigger.
 *
 * ## Memoised per onset, deliberately
 *
 * The ring ages. Re-counting the same episode on every scrape would make the
 * published counts decay toward zero as entries evicted — a series that silently
 * rewrites a past measurement into a smaller one, which is worse than not
 * publishing it. The counts are computed once per distinct onset instant and
 * held, so they describe the episode rather than the ring's current contents.
 *
 * ⚠ But only once the window has CLOSED. Detection can land ~1 s after the
 * onset — a single sample can clear the whole threshold — so a scrape
 * arriving inside `[onset, onset + 5 s]` would count a window whose tail is
 * still in the future, and freezing THAT would publish a truncated count as
 * the episode's exact one: the same error shape the ring's eviction test
 * exists to prevent. Until the window closes (plus
 * {@link GC_ENTRY_DELIVERY_SLACK_MS} for the observer's asynchronous entry
 * delivery) the onset counts are published as a LOWER BOUND, `covered: false`,
 * and recounted on the next scrape.
 *
 * ## What it is not
 *
 * ⛔ Not a fix, not an alert source, and PEN-3314 does not close on it.
 *
 * ⛔ Not an attribution in the causal sense, despite the name: it reports
 * coincidence in time, at a resolution where coincidence is finally
 * informative. GC is the candidate this row has refuted twice at 30 s and once
 * at +/-1 s against 30 s correlates; this is the measurement that can refute it
 * at matched resolution, or stop refuting it.
 *
 * ⛔ Takes no view on which `{kind, flags}` classes matter, and publishes every
 * class that fired. Filtering to a predicted one is the trap `gc-flags-metrics`
 * already records.
 *
 * @module server/services/rss-release-gc-attribution
 */

import { readGcCyclesInWindow, type GcCycleWindow } from "./gc-flags-metrics.js";
import type { RssReleaseReading } from "./rss-release-tracker.js";

/**
 * Half-width of the window centred on the onset, in ms.
 *
 * 5 s, giving a 10 s window. Chosen to be strictly finer than the 30 s scrape
 * this module exists to beat while still spanning several cycles at the ambient
 * 0.55/s — a window so narrow it usually contains nothing would publish noise
 * rather than a rate.
 *
 * It is also wider than the onset stamp's own error. That stamp lands up to one
 * plateau band into the fall (~4 s at the measured 3.6 MB/s drain), so a
 * half-width below that could place the true onset OUTSIDE the window it is
 * meant to centre.
 */
export const DEFAULT_ONSET_WINDOW_HALF_MS = 5_000;

/**
 * How far before the onset the baseline window is centred, in ms.
 *
 * 300 s back: far enough that the baseline cannot overlap the onset window or
 * the descent leading into it, and recent enough to be the same process, the
 * same generation and broadly the same load — which is what makes it a baseline
 * rather than a different measurement.
 *
 * ⚠ It is ONE window, not a long-run average, so it carries the sampling noise
 * of ~5 cycles. Read it as an order-of-magnitude control, and read
 * {@link RssReleaseGcAttribution.baseline}'s `covered` before reading it at all.
 *
 * ⚠ "Contains no onset" is enforced rather than assumed: the baseline is
 * `null`, and nothing is published for it, when ANY earlier episode's onset
 * falls inside it — not merely the immediately-prior one. See
 * {@link RssReleaseGcAttribution.baseline}.
 */
export const DEFAULT_BASELINE_OFFSET_MS = 300_000;

/**
 * How long after a window's end it is treated as CLOSED, in ms.
 *
 * `PerformanceObserver` delivers `gc` entries asynchronously — the callback
 * runs after the cycle it describes, not during it — so a window counted at
 * exactly `toMs` can still be short by the delivery lag. One second sits far
 * above that lag (entries are queued and drained on the next turn) and far
 * below the 30 s scrape that governs when the recount actually happens, so it
 * costs nothing and removes the race.
 */
export const GC_ENTRY_DELIVERY_SLACK_MS = 1_000;

export interface RssReleaseGcAttribution {
  /** The onset this describes. Identifies the episode; the counts never move once set. */
  readonly onsetAtMs: number;
  /** Window centred on {@link onsetAtMs}. */
  readonly onset: GcCycleWindow;
  /**
   * Same-width window {@link DEFAULT_BASELINE_OFFSET_MS} earlier, containing no onset.
   *
   * `null` when ANY earlier episode's onset falls inside that window, which
   * would make it a second event rather than the ambient control it is read as.
   * ⛔ A `null` baseline is not a baseline of zero: with no control the
   * onset count is uninterpretable, so nothing is published for either window's
   * comparison and the reader is left with the absence rather than with a ratio
   * computed against a contaminated denominator.
   *
   * ⚠ Checked against EVERY onset still within reach of a control window,
   * not just the newest. Several onsets can fall inside one baseline offset —
   * this fleet produced three in ~10 min — and a check holding only the
   * immediately-prior one would let the newest overwrite the record of an older
   * onset that is itself sitting in this window, publishing a contaminated
   * denominator as clean.
   *
   * Best-effort within one process, in two ways: an onset is known only from an
   * episode this module has already attributed, so the first episode after a
   * restart cannot be checked against one that predates it — and the tracker
   * publishes one onset at a time, so two onsets falling between consecutive
   * scrapes leave the module never having seen the earlier one. ⛔ Neither gap
   * is closable from here, so a non-null baseline means no OBSERVED onset
   * contaminates it.
   */
  readonly baseline: GcCycleWindow | null;
  /** Full width of both windows, in ms. Published so a count is readable as a rate. */
  readonly windowMs: number;
}

export interface AttributeRssReleaseGcOptions {
  readonly onsetWindowHalfMs?: number;
  readonly baselineOffsetMs?: number;
  /** Injected by the test so windows can be counted without a real GC stream. */
  readonly readWindow?: (fromMs: number, toMs: number) => GcCycleWindow;
  /** Injected by the test so a scrape can be placed inside an open window. */
  readonly now?: () => number;
}

let memo: RssReleaseGcAttribution | null = null;
/**
 * Onsets this module has attributed, oldest first, frozen or not.
 *
 * Kept only to answer "is the baseline window clean?" — see
 * {@link RssReleaseGcAttribution.baseline}. The tracker publishes one onset at
 * a time, so once an onset is superseded this array is the only record of it,
 * and a single "previous" slot would lose every onset but the newest.
 *
 * Bounded by elapsed time rather than by episode count: onsets only move
 * forward, so each call drops those already past the reach of any future
 * control window, leaving one baseline offset of history — a handful of
 * entries at this fleet's ~1 release per process-hour, and still bounded
 * through a burst.
 */
let recentOnsetsAtMs: number[] = [];

/**
 * Compute (or recall) the GC windows around the reading's most recent onset.
 *
 * Returns `null` while no episode has been observed — the same discipline the
 * sibling series follow, where ABSENT and "measured zero" must not be the same
 * reading. A reading with no onset is not an episode with no GC; it is no
 * episode.
 */
export function attributeRssReleaseGc(
  reading: RssReleaseReading | null,
  options: AttributeRssReleaseGcOptions = {},
): RssReleaseGcAttribution | null {
  const onsetAtMs = reading?.lastOnsetAtMs ?? null;
  if (onsetAtMs === null) return null;
  // Same episode: hand back the counts taken when it was fresh. Re-counting
  // would shrink them as the ring evicts. See the module docblock.
  if (memo && memo.onsetAtMs === onsetAtMs) return memo;

  const halfMs = options.onsetWindowHalfMs ?? DEFAULT_ONSET_WINDOW_HALF_MS;
  const baselineOffsetMs = options.baselineOffsetMs ?? DEFAULT_BASELINE_OFFSET_MS;
  const readWindow = options.readWindow ?? readGcCyclesInWindow;

  const nowMs = (options.now ?? Date.now)();
  // EVERY onset seen so far is a candidate contaminant of this episode's
  // control window, so they are kept as a set rather than in a single
  // "previous" slot. Tracked here rather than off `memo`, which holds only
  // FROZEN episodes and so would skip one whose window was still open when the
  // next arrived.
  if (recentOnsetsAtMs[recentOnsetsAtMs.length - 1] !== onsetAtMs) {
    recentOnsetsAtMs.push(onsetAtMs);
  }
  // Onsets only move forward, so every later control window starts no earlier
  // than this one's: an onset before this window's far edge can never fall
  // inside this or any future one, and dropping it bounds the record.
  const oldestReachableMs = onsetAtMs - baselineOffsetMs - halfMs;
  recentOnsetsAtMs = recentOnsetsAtMs.filter((at) => at >= oldestReachableMs);

  const baselineCentreMs = onsetAtMs - baselineOffsetMs;
  const baselineFromMs = baselineCentreMs - halfMs;
  const baselineToMs = baselineCentreMs + halfMs;
  // Any OTHER episode's onset inside the control window makes it a second
  // event, not an ambient stretch. Refuse the comparison rather than publish a
  // denominator that quietly contains the thing being measured.
  const baselineContainsOnset = recentOnsetsAtMs.some(
    (at) => at !== onsetAtMs && at >= baselineFromMs && at <= baselineToMs,
  );

  const onset = readWindow(onsetAtMs - halfMs, onsetAtMs + halfMs);
  // Has the onset window finished happening? If not, every entry still to come
  // in it is missing from this count, which is exactly what `covered: false`
  // means — a LOWER BOUND, not a measurement.
  const windowClosed = nowMs >= onset.toMs + GC_ENTRY_DELIVERY_SLACK_MS;
  const attribution: RssReleaseGcAttribution = {
    onsetAtMs,
    onset: windowClosed ? onset : { ...onset, covered: false },
    baseline: baselineContainsOnset ? null : readWindow(baselineFromMs, baselineToMs),
    windowMs: halfMs * 2,
  };

  // Freeze only a closed window. An open one is republished — and recounted --
  // on the next scrape, by which time the ring has the whole window in it.
  if (windowClosed) memo = attribution;
  return attribution;
}

/** Reset module state between tests. Not for production use. */
export function __resetRssReleaseGcAttributionForTest(): void {
  memo = null;
  recentOnsetsAtMs = [];
}
