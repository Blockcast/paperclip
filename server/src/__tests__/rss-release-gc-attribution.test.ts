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
 * 2. **Eviction is reported, not absorbed.** A window the ring can no longer
 *    cover must read `covered: false`. If it read as a smaller count instead,
 *    ring pressure would render as "GC did not fire near the onset" — the
 *    first positive-looking trigger result this row has ever had, and a false
 *    one. This is the single most dangerous failure mode in the module.
 *
 * 3. **Counts are frozen per episode.** Recomputing on every scrape would make
 *    a published measurement shrink over the following minutes as entries
 *    evicted, silently rewriting the past.
 *
 * 4. **No episode publishes nothing.** "No release observed" and "a release was
 *    observed with no GC near it" are opposite findings, and the second is the
 *    result this row is waiting for.
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
      attribution!.baseline.toMs - attribution!.baseline.fromMs,
    );
    expect(attribution?.baseline.toMs).toBe(onset - DEFAULT_BASELINE_OFFSET_MS + 5_000);
    // And they must not overlap, or the baseline would include the event.
    expect(attribution!.baseline.toMs).toBeLessThan(attribution!.onset.fromMs);
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

    expect(attribution?.baseline.observedCycles).toBe(11);
    expect(attribution?.onset.observedCycles).toBe(13);
    // The ambient class is flat across both windows; only the extra class
    // separates them. That contrast is the finding this series can carry, and
    // it is invisible to a 30 s counter, where both windows are one bucket.
    expect(attribution?.baseline.classes).toEqual([
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
});
