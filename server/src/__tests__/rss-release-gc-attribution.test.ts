/**
 * PEN-3314 — joining a +/-1 s release onset to GC at matched resolution.
 *
 * The value of this join is entirely in its *narrowness*: `paperclip_gc_cycles_total`
 * already answers "how much GC per 30 s", and that answer is useless here
 * because major GC at event magnitude is the ambient state of these processes.
 * So the properties worth testing are the ones whose failure would produce a
 * confident wrong answer rather than a visible crash:
 *
 * 1. **The window is actually narrow and actually centred on the onset.** A
 *    window that silently widened, or that drifted onto a scrape boundary,
 *    would reproduce the 30 s measurement this module exists to beat while
 *    looking like a 10 s one.
 *
 * 2. **An unobserved window is reported, not absorbed.** A window the ring can
 *    no longer cover — evicted, or reaching back before the ring was watching
 *    at all — must read `covered: false`. If it read as a smaller count
 *    instead, ring pressure (or a release early in a generation) would render
 *    as "GC did not fire near the onset" — the first positive-looking trigger
 *    result this row has ever had, and a false one. This is the single most
 *    dangerous failure mode in the module, and it has two halves: the ring's
 *    oldest end and its START.
 *
 * 3. **Counts are frozen per episode — but only once the episode's window has
 *    finished happening.** Recomputing on every scrape would make a published
 *    measurement shrink over the following minutes as entries evicted, silently
 *    rewriting the past; freezing a window whose tail is still in the future
 *    would publish a truncated count as the exact one, which is the same error
 *    pointing the other way.
 *
 * 4. **No episode publishes nothing, and neither does a contaminated control.**
 *    "No release observed" and "a release was observed with no GC near it" are
 *    opposite findings, and the second is the result this row is waiting for. A
 *    baseline window holding ANY earlier episode's onset is a second event
 *    rather than an ambient stretch, so it is withheld rather than published as
 *    a denominator. ⚠ "Any", not "the previous one": several onsets fit inside
 *    one baseline offset — this fleet produced three in ~10 min — so a check
 *    that remembers only the newest can have the contaminating onset erased out
 *    from under it and publish the window as clean.
 */

import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { constants } from "node:perf_hooks";

import {
  __resetGcCycleRingForTest,
  readGcCyclesInWindow,
  recordGcCycle,
} from "../services/gc-flags-metrics.js";
import {
  __resetRssReleaseGcAttributionForTest,
  attributeRssReleaseGc,
  DEFAULT_BASELINE_OFFSET_MS,
  GC_ENTRY_DELIVERY_SLACK_MS,
} from "../services/rss-release-gc-attribution.js";
import type { GcCycleWindow } from "../services/gc-flags-metrics.js";
import type { RssReleaseGcAttribution } from "../services/rss-release-gc-attribution.js";
import {
  PROCESS_RSS_RELEASE_ONSET_GC_CYCLES_METRIC,
  PROCESS_RSS_RELEASE_ONSET_GC_PAUSE_SECONDS_METRIC,
  PROCESS_RSS_RELEASE_ONSET_GC_PAUSE_UNKNOWN_CYCLES_METRIC,
  PROCESS_RSS_RELEASE_ONSET_GC_WINDOW_COVERED_METRIC,
  PROCESS_RSS_RELEASE_ONSET_GC_WINDOW_SECONDS_METRIC,
  __resetMetricsForTest,
  renderMetrics,
  setRssReleaseGcAttributionMetrics,
} from "../services/metrics.js";
import type { RssReleaseReading } from "../services/rss-release-tracker.js";

const MAJOR = constants.NODE_PERFORMANCE_GC_MAJOR;
const MINOR = constants.NODE_PERFORMANCE_GC_MINOR;
const IDLE = constants.NODE_PERFORMANCE_GC_FLAGS_SCHEDULE_IDLE;

/** A reading carrying one onset; every other field is irrelevant to this join. */
function readingWithOnset(onsetAtMs: number | null): RssReleaseReading {
  return {
    releaseCount: onsetAtMs === null ? 0 : 1,
    releasedBytesTotal: 0,
    lastOnsetAtMs: onsetAtMs,
    lastDetectedAtMs: onsetAtMs === null ? null : onsetAtMs + 1_000,
    lastReleaseBytes: onsetAtMs === null ? null : 64 * 1024 * 1024,
    episodeOpen: false,
    sampleCount: 10,
    sampleIntervalMs: 1_000,
    thresholdBytes: 64 * 1024 * 1024,
    plateauBandBytes: 16 * 1024 * 1024,
  };
}

beforeEach(() => {
  __resetGcCycleRingForTest(0);
  __resetRssReleaseGcAttributionForTest();
});

describe("GC cycle ring", () => {
  it("counts only the cycles inside the window, by class", () => {
    recordGcCycle(1_000, MAJOR, IDLE);
    recordGcCycle(5_000, MAJOR, IDLE);
    recordGcCycle(5_100, MAJOR, 0);
    recordGcCycle(5_200, MINOR, 0);
    recordGcCycle(9_000, MAJOR, IDLE); // outside

    const window = readGcCyclesInWindow(4_000, 6_000);

    expect(window.observedCycles).toBe(3);
    expect(window.covered).toBe(true);
    expect(window.classes).toEqual([
      { kind: "major", flags: "schedule_idle", cycles: 1, pauseMs: 0 },
      { kind: "major", flags: "none", cycles: 1, pauseMs: 0 },
      { kind: "minor", flags: "none", cycles: 1, pauseMs: 0 },
    ]);
    // These cycles were recorded without a duration, so the pause total is a
    // lower bound and says so rather than reading as a measured zero.
    expect(window.pauseUnknownCycles).toBe(3);
    expect(window.observedPauseMs).toBe(0);
  });

  it("sums pause time per class, and reports it as exact when every cycle carried one", () => {
    recordGcCycle(5_000, MAJOR, IDLE, 12.5);
    recordGcCycle(5_100, MAJOR, IDLE, 7.5);
    recordGcCycle(5_200, MINOR, 0, 1.25);
    recordGcCycle(9_000, MAJOR, IDLE, 999); // outside

    const window = readGcCyclesInWindow(4_000, 6_000);

    expect(window.observedCycles).toBe(3);
    expect(window.observedPauseMs).toBe(21.25);
    expect(window.pauseUnknownCycles).toBe(0);
    expect(window.classes).toEqual([
      { kind: "major", flags: "schedule_idle", cycles: 2, pauseMs: 20 },
      { kind: "minor", flags: "none", cycles: 1, pauseMs: 1.25 },
    ]);
  });

  it("counts a missing duration apart instead of adding it as zero", () => {
    // The distinction the pause series turns on: a cycle that took no
    // measurable time and a cycle whose time never arrived are different
    // readings, and summing both as 0 makes them the same one.
    recordGcCycle(5_000, MAJOR, 0, 10);
    recordGcCycle(5_100, MAJOR, 0); // no duration at all
    recordGcCycle(5_200, MAJOR, 0, Number.NaN);
    recordGcCycle(5_300, MAJOR, 0, -1); // not a real pause
    recordGcCycle(5_400, MAJOR, 0, 0); // genuinely zero, and KNOWN

    const window = readGcCyclesInWindow(4_000, 6_000);

    expect(window.observedCycles).toBe(5);
    expect(window.observedPauseMs).toBe(10);
    // Three unusable, and the measured 0 is NOT among them.
    expect(window.pauseUnknownCycles).toBe(3);
  });

  it("boundaries are inclusive, so a cycle exactly at the onset is counted", () => {
    recordGcCycle(5_000, MAJOR, 0);
    expect(readGcCyclesInWindow(5_000, 5_000).observedCycles).toBe(1);
  });

  it("reports an empty window as covered when nothing was evicted", () => {
    recordGcCycle(1_000, MAJOR, 0);
    const window = readGcCyclesInWindow(50_000, 60_000);
    // The distinction the whole row turns on: nothing fired, and we KNOW it.
    expect(window.observedCycles).toBe(0);
    expect(window.covered).toBe(true);
    expect(window.classes).toEqual([]);
  });

  it("marks a window UNCOVERED when it reaches back before the ring was watching", () => {
    // The ring begins observing at t=10_000; nothing before that was ever seen.
    __resetGcCycleRingForTest(0, 10_000);
    recordGcCycle(11_000, MAJOR, 0);

    // Nothing was evicted, so the eviction test alone would call this exact --
    // and publish an unobserved stretch as a measured zero, which on the
    // baseline window reads as a large positive trigger result.
    const beforeStart = readGcCyclesInWindow(5_000, 9_000);
    expect(beforeStart.observedCycles).toBe(0);
    expect(beforeStart.covered).toBe(false);

    // Straddling the start is still only partly observed.
    expect(readGcCyclesInWindow(9_999, 12_000).covered).toBe(false);
    // From the start instant onward it is a real measurement.
    expect(readGcCyclesInWindow(10_000, 12_000).covered).toBe(true);
  });

  it("marks a window UNCOVERED once entries inside it have been evicted", () => {
    // Overflow the ring so the early entries are overwritten. Capacity is
    // 8192; writing 8193 evicts exactly the entry at t=1.
    for (let index = 1; index <= 8_193; index += 1) recordGcCycle(index, MAJOR, 0);

    const evicted = readGcCyclesInWindow(0, 10);
    expect(evicted.covered).toBe(false);

    // A window entirely NEWER than the newest eviction is still exact — the
    // ring losing ancient history must not poison every later reading.
    const intact = readGcCyclesInWindow(8_000, 8_100);
    expect(intact.covered).toBe(true);
    expect(intact.observedCycles).toBe(101);
  });
});

describe("release onset GC attribution", () => {
  it("publishes nothing until an episode has been observed", () => {
    expect(attributeRssReleaseGc(null)).toBeNull();
    expect(attributeRssReleaseGc(readingWithOnset(null))).toBeNull();
  });

  it("centres a 10 s window on the onset and a same-width baseline 300 s earlier", () => {
    const onset = 1_000_000;
    const attribution = attributeRssReleaseGc(readingWithOnset(onset));

    expect(attribution).not.toBeNull();
    expect(attribution?.windowMs).toBe(10_000);
    expect(attribution?.onset.fromMs).toBe(onset - 5_000);
    expect(attribution?.onset.toMs).toBe(onset + 5_000);
    // Same width, so the two counts are directly comparable — which is the
    // only way the onset count means anything at all.
    expect(attribution!.onset.toMs - attribution!.onset.fromMs).toBe(
      attribution!.baseline!.toMs - attribution!.baseline!.fromMs,
    );
    expect(attribution?.baseline?.toMs).toBe(onset - DEFAULT_BASELINE_OFFSET_MS + 5_000);
    // And they must not overlap, or the baseline would include the event.
    expect(attribution!.baseline!.toMs).toBeLessThan(attribution!.onset.fromMs);
  });

  it("separates an onset-clustered burst from the ambient baseline", () => {
    const onset = 1_000_000;
    // Ambient: one major every second across the baseline window.
    for (let offset = -5_000; offset <= 5_000; offset += 1_000) {
      recordGcCycle(onset - DEFAULT_BASELINE_OFFSET_MS + offset, MAJOR, 0);
    }
    // At the onset: the same ambient rate PLUS a distinct class.
    for (let offset = -5_000; offset <= 5_000; offset += 1_000) {
      recordGcCycle(onset + offset, MAJOR, 0);
    }
    recordGcCycle(onset + 10, MAJOR, IDLE);
    recordGcCycle(onset + 20, MAJOR, IDLE);

    const attribution = attributeRssReleaseGc(readingWithOnset(onset));

    expect(attribution?.baseline?.observedCycles).toBe(11);
    expect(attribution?.onset.observedCycles).toBe(13);
    // The ambient class is flat across both windows; only the extra class
    // separates them. That contrast is the finding this series can carry, and
    // it is invisible to a 30 s counter, where both windows are one bucket.
    expect(attribution?.baseline?.classes).toEqual([
      { kind: "major", flags: "none", cycles: 11, pauseMs: 0 },
    ]);
    expect(attribution?.onset.classes).toEqual([
      { kind: "major", flags: "none", cycles: 11, pauseMs: 0 },
      { kind: "major", flags: "schedule_idle", cycles: 2, pauseMs: 0 },
    ]);
  });

  it("separates a LONGER cycle from a more frequent one across the two windows", () => {
    // The case the cycle counts cannot express, and the reason the pause series
    // exists: both windows run the same class at the same rate, so counting is
    // blind here -- 23/23 onsets carried a major cycle against a 65.2% ambient
    // rate, so occurrence cannot be the discriminator. Only the magnitude moves.
    const onset = 1_000_000;
    for (let offset = -5_000; offset <= 5_000; offset += 1_000) {
      recordGcCycle(onset - DEFAULT_BASELINE_OFFSET_MS + offset, MAJOR, 0, 2);
      recordGcCycle(onset + offset, MAJOR, 0, 10);
    }

    const attribution = attributeRssReleaseGc(readingWithOnset(onset));

    // Identical counts: a reader with only the cycle series sees nothing.
    expect(attribution?.baseline?.observedCycles).toBe(11);
    expect(attribution?.onset.observedCycles).toBe(11);
    // The pause series separates them 5:1.
    expect(attribution?.baseline?.observedPauseMs).toBe(22);
    expect(attribution?.onset.observedPauseMs).toBe(110);
    // Both exact, so the ratio is a measurement rather than a lower bound.
    expect(attribution?.baseline?.pauseUnknownCycles).toBe(0);
    expect(attribution?.onset.pauseUnknownCycles).toBe(0);
  });

  it("freezes the counts for an episode instead of re-reading an ageing ring", () => {
    const onset = 1_000_000;
    recordGcCycle(onset, MAJOR, 0);

    const first = attributeRssReleaseGc(readingWithOnset(onset));
    expect(first?.onset.observedCycles).toBe(1);

    // The ring moves on; the episode's measurement must not.
    __resetGcCycleRingForTest(0);
    const second = attributeRssReleaseGc(readingWithOnset(onset));
    expect(second).toBe(first);
    expect(second?.onset.observedCycles).toBe(1);

    // A genuinely new onset is measured afresh against the ring as it now is.
    const third = attributeRssReleaseGc(readingWithOnset(onset + 60_000));
    expect(third).not.toBe(first);
    expect(third?.onset.observedCycles).toBe(0);
  });

  it("does NOT freeze an onset window that has not finished happening yet", () => {
    const onset = 1_000_000;
    recordGcCycle(onset - 1_000, MAJOR, 0);

    // Detection can land ~1s after the onset, so a scrape can arrive while the
    // window's tail is still in the future. Those cycles have not happened.
    const open = attributeRssReleaseGc(readingWithOnset(onset), {
      now: () => onset + 2_000,
    });
    expect(open?.onset.observedCycles).toBe(1);
    // A count missing entries it should contain is a LOWER BOUND, not a result.
    expect(open?.onset.covered).toBe(false);

    // The rest of the window then happens.
    recordGcCycle(onset + 3_000, MAJOR, 0);
    recordGcCycle(onset + 4_500, MAJOR, IDLE);

    const closed = attributeRssReleaseGc(readingWithOnset(onset), {
      now: () => onset + 5_000 + GC_ENTRY_DELIVERY_SLACK_MS,
    });
    expect(closed).not.toBe(open);
    expect(closed?.onset.observedCycles).toBe(3);
    expect(closed?.onset.covered).toBe(true);

    // And THAT is the reading that gets frozen for the episode.
    __resetGcCycleRingForTest(0);
    expect(attributeRssReleaseGc(readingWithOnset(onset), { now: () => onset + 600_000 }))
      .toBe(closed);
  });

  it("withholds the baseline when the previous episode's onset falls inside it", () => {
    const first = 1_000_000;
    // The next episode lands exactly one baseline offset later, which puts the
    // first onset in the centre of the second's control window.
    const second = first + DEFAULT_BASELINE_OFFSET_MS;
    const closed = (onsetAtMs: number) => ({ now: () => onsetAtMs + 600_000 });

    expect(attributeRssReleaseGc(readingWithOnset(first), closed(first))?.baseline)
      .not.toBeNull();

    const contaminated = attributeRssReleaseGc(readingWithOnset(second), closed(second));
    // Not a baseline of zero: a control containing the event is no control, and
    // publishing it as a denominator is how an ambient signal becomes a finding.
    expect(contaminated?.baseline).toBeNull();
    expect(contaminated?.onset).not.toBeNull();

    // A third episode, far enough out that the second's onset is clear of its
    // control window, is measured normally again.
    const third = second + DEFAULT_BASELINE_OFFSET_MS * 2;
    expect(attributeRssReleaseGc(readingWithOnset(third), closed(third))?.baseline)
      .not.toBeNull();
  });

  it("withholds the baseline when an onset older than the PREVIOUS one falls inside it", () => {
    // Three onsets inside one baseline offset -- the shape measured on
    // `paperclip-1` at 09:39 / 09:44 / 09:49. The newest's control window is
    // centred on the FIRST, while the second sits well clear of it. So a check
    // keeping only the immediately-prior onset is asking about the one episode
    // that is NOT in the window, reads it as clean, and publishes a denominator
    // with a release inside it -- an ambient control that contains the event.
    const first = 1_000_000;
    const second = first + 150_000;
    const third = first + DEFAULT_BASELINE_OFFSET_MS;
    const closed = (onsetAtMs: number) => ({ now: () => onsetAtMs + 600_000 });

    expect(attributeRssReleaseGc(readingWithOnset(first), closed(first))?.baseline)
      .not.toBeNull();
    // The middle episode's own control window is genuinely clean and must stay
    // published: widening the check must not withhold every baseline once more
    // than one onset is on record.
    expect(attributeRssReleaseGc(readingWithOnset(second), closed(second))?.baseline)
      .not.toBeNull();

    const contaminated = attributeRssReleaseGc(readingWithOnset(third), closed(third));
    // `second` is 150 s clear of this window; `first` is dead centre in it.
    expect(contaminated?.baseline).toBeNull();
    expect(contaminated?.onset).not.toBeNull();
  });

  it("reads the baseline as UNCOVERED when it predates the ring", () => {
    // Ring starts watching at t=900_000; an onset 100s later puts the baseline
    // window (onset - 300s) 200s before anything was observed.
    __resetGcCycleRingForTest(0, 900_000);
    const onset = 1_000_000;

    const attribution = attributeRssReleaseGc(readingWithOnset(onset), {
      now: () => onset + 600_000,
    });

    expect(attribution?.baseline?.observedCycles).toBe(0);
    // Without this the ratio onset/baseline is a division by an unmeasured 0 --
    // a positive trigger result manufactured from a window nobody watched.
    expect(attribution?.baseline?.covered).toBe(false);
    expect(attribution?.onset.covered).toBe(true);
  });
});

/**
 * The PUBLISH path, which the compute tests above never reach.
 *
 * `attributeRssReleaseGc` is tested hard because its failures are subtle;
 * `setRssReleaseGcAttributionMetrics` is tested here because its failures are
 * SILENT AND UNIT-SHAPED, which on this row is worse. The series are read by
 * hand against a Prometheus console by someone comparing an onset window to its
 * control, so:
 *
 * 1. **ms -> s happens exactly once.** `pauseMs` is milliseconds and the metric
 *    name ends `_seconds`. A dropped or doubled `/ 1000` still renders a
 *    plausible small number next to a cycle count, and the reader has nothing
 *    in the exposition to check it against -- they would simply take a 1000x
 *    error as the measurement. This is the one assertion that cannot be made
 *    from the compute layer, where everything is ms.
 *
 * 2. **`pause_unknown_cycles` is published AT ZERO, for BOTH windows.** Zero is
 *    the expected reading and therefore the one a `set`-only-when-non-zero
 *    publish would omit. An absent qualifier is not a qualifier: the pause sums
 *    are only readable as totals rather than lower bounds when this is known to
 *    be 0, so omitting it at 0 silently converts "exact" into "unknown".
 *
 * 3. **A `null` attribution clears the previous episode.** These gauges are
 *    frozen per onset, so a stale set left standing after the tracker loses the
 *    release does not look stale -- it looks like the current episode.
 */
describe("setRssReleaseGcAttributionMetrics", () => {
  afterEach(() => {
    __resetMetricsForTest();
  });

  async function render(): Promise<string> {
    return (await renderMetrics()).body;
  }

  /**
   * Value of one sample, found by metric name + labels rather than by matching a
   * rendered line, so the assertions do not depend on prom-client's label order.
   * `null` when the series is absent, which several tests below assert directly.
   */
  function sample(body: string, metric: string, labels: Record<string, string>): number | null {
    for (const line of body.split("\n")) {
      if (!line.startsWith(`${metric}{`) && !line.startsWith(`${metric} `)) continue;
      if (!Object.entries(labels).every(([k, v]) => line.includes(`${k}="${v}"`))) continue;
      const value = line.slice(line.lastIndexOf(" ") + 1);
      return Number(value);
    }
    return null;
  }

  const window = (over: Partial<GcCycleWindow> = {}): GcCycleWindow => ({
    fromMs: 1_000_000,
    toMs: 1_010_000,
    classes: [{ kind: "major", flags: "schedule_idle", cycles: 3, pauseMs: 1_234.5 }],
    observedCycles: 3,
    observedPauseMs: 1_234.5,
    pauseUnknownCycles: 0,
    covered: true,
    ...over,
  });

  const attribution = (over: Partial<RssReleaseGcAttribution> = {}): RssReleaseGcAttribution => ({
    onsetAtMs: 1_005_000,
    onset: window(),
    baseline: window({ classes: [{ kind: "major", flags: "schedule_idle", cycles: 1, pauseMs: 400 }] }),
    windowMs: 10_000,
    ...over,
  });

  it("publishes pause in SECONDS, converting from the ms the window carries", async () => {
    setRssReleaseGcAttributionMetrics(attribution());
    const body = await render();
    const labels = { window: "onset", kind: "major", flags: "schedule_idle" };
    // 1234.5 ms. Chosen so a missing `/ 1000` (1234.5), a doubled one
    // (0.0012345) and the correct value are three visibly different numbers --
    // a round input would let a wrong scale still look like a pause time.
    expect(sample(body, PROCESS_RSS_RELEASE_ONSET_GC_PAUSE_SECONDS_METRIC, labels)).toBe(1.2345);
    // The cycle count beside it is NOT scaled -- same loop, different unit.
    expect(sample(body, PROCESS_RSS_RELEASE_ONSET_GC_CYCLES_METRIC, labels)).toBe(3);
    // The window width is the module's other ms -> s conversion.
    expect(sample(body, PROCESS_RSS_RELEASE_ONSET_GC_WINDOW_SECONDS_METRIC, {})).toBe(10);
  });

  it("publishes pause_unknown_cycles at a measured 0 for BOTH windows", async () => {
    setRssReleaseGcAttributionMetrics(attribution());
    const body = await render();
    // `toBe(0)`, not `toBeFalsy()`: `null` here is the bug being excluded.
    expect(sample(body, PROCESS_RSS_RELEASE_ONSET_GC_PAUSE_UNKNOWN_CYCLES_METRIC, { window: "onset" })).toBe(0);
    expect(sample(body, PROCESS_RSS_RELEASE_ONSET_GC_PAUSE_UNKNOWN_CYCLES_METRIC, { window: "baseline" })).toBe(0);
    expect(sample(body, PROCESS_RSS_RELEASE_ONSET_GC_WINDOW_COVERED_METRIC, { window: "onset" })).toBe(1);
    expect(sample(body, PROCESS_RSS_RELEASE_ONSET_GC_WINDOW_COVERED_METRIC, { window: "baseline" })).toBe(1);
  });

  it("publishes a non-zero pause_unknown_cycles, which marks its window's pause a LOWER BOUND", async () => {
    setRssReleaseGcAttributionMetrics(
      attribution({ onset: window({ pauseUnknownCycles: 2, observedCycles: 5 }) }),
    );
    const body = await render();
    expect(sample(body, PROCESS_RSS_RELEASE_ONSET_GC_PAUSE_UNKNOWN_CYCLES_METRIC, { window: "onset" })).toBe(2);
    // Independent of coverage, which is a different failure: the ring held this
    // window, and two of the entries in it carried no duration.
    expect(sample(body, PROCESS_RSS_RELEASE_ONSET_GC_WINDOW_COVERED_METRIC, { window: "onset" })).toBe(1);
  });

  it("withholds a contaminated control ENTIRELY, including its qualifiers", async () => {
    setRssReleaseGcAttributionMetrics(attribution({ baseline: null }));
    const body = await render();
    // The onset side proves the publish happened, so the absences below are
    // real absences rather than a no-op test.
    expect(sample(body, PROCESS_RSS_RELEASE_ONSET_GC_PAUSE_SECONDS_METRIC, { window: "onset" })).toBe(1.2345);
    expect(sample(body, PROCESS_RSS_RELEASE_ONSET_GC_PAUSE_SECONDS_METRIC, { window: "baseline" })).toBeNull();
    // Not even covered=0: there is no window to qualify, and a published 0
    // would read as "the ring missed it" rather than "no control exists".
    expect(sample(body, PROCESS_RSS_RELEASE_ONSET_GC_WINDOW_COVERED_METRIC, { window: "baseline" })).toBeNull();
    expect(sample(body, PROCESS_RSS_RELEASE_ONSET_GC_PAUSE_UNKNOWN_CYCLES_METRIC, { window: "baseline" })).toBeNull();
  });

  it("clears every series on a null attribution rather than freezing the last episode", async () => {
    setRssReleaseGcAttributionMetrics(attribution());
    expect(sample(await render(), PROCESS_RSS_RELEASE_ONSET_GC_PAUSE_SECONDS_METRIC, { window: "onset" })).toBe(1.2345);

    setRssReleaseGcAttributionMetrics(null);
    const body = await render();
    // Frozen-per-onset is the contract, so a stale set surviving here does not
    // look stale -- it reads as the current episode's measurement.
    expect(sample(body, PROCESS_RSS_RELEASE_ONSET_GC_PAUSE_SECONDS_METRIC, { window: "onset" })).toBeNull();
    expect(sample(body, PROCESS_RSS_RELEASE_ONSET_GC_CYCLES_METRIC, { window: "onset" })).toBeNull();
    expect(sample(body, PROCESS_RSS_RELEASE_ONSET_GC_PAUSE_UNKNOWN_CYCLES_METRIC, { window: "onset" })).toBeNull();
    expect(sample(body, PROCESS_RSS_RELEASE_ONSET_GC_WINDOW_COVERED_METRIC, { window: "onset" })).toBeNull();
    // `remove()` rather than `reset()` on the label-less width: a published 0
    // would turn a per-second rate over this window into a division by zero.
    expect(sample(body, PROCESS_RSS_RELEASE_ONSET_GC_WINDOW_SECONDS_METRIC, {})).toBeNull();
  });
});
