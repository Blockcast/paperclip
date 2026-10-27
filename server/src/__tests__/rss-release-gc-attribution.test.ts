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
 *    baseline window holding the previous episode's onset is a second event
 *    rather than an ambient stretch, so it is withheld rather than published as
 *    a denominator.
 */

import { describe, expect, it, beforeEach } from "vitest";
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
      { kind: "major", flags: "schedule_idle", cycles: 1 },
      { kind: "major", flags: "none", cycles: 1 },
      { kind: "minor", flags: "none", cycles: 1 },
    ]);
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
      { kind: "major", flags: "none", cycles: 11 },
    ]);
    expect(attribution?.onset.classes).toEqual([
      { kind: "major", flags: "none", cycles: 11 },
      { kind: "major", flags: "schedule_idle", cycles: 2 },
    ]);
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
