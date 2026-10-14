/**
 * PEN-3314 — lifetime heap-peak sampler.
 *
 * This instrument exists because the previous read of the same process was a
 * floor statistic, and a floor is guaranteed to miss the excursion that does the
 * damage. So the failure modes worth testing are the ones that would make it
 * report a reassuring number while the excursion happens anyway:
 *
 * 1. **A peak must survive the fall.** The measured event (api `r4xbn`,
 *    2026-10-14T19:15Z) went 3.01 GB -> 0.56 GB in one minute. An
 *    implementation that reported the latest sample, or that let a later lower
 *    sample overwrite the maximum, would publish 0.56 GB and read as healthy.
 * 2. **"Never sampled" must not render as "peaked at zero".** Those are the
 *    same gauge value and opposite conclusions, and this row has already paid
 *    two months for exactly that conflation on `nodejs_heap_size_used_bytes`.
 * 3. **The sampler must not keep the process alive.** `unref()` on the timer.
 * 4. **One throwing read must not blind the sampler for the process lifetime.**
 */

import { describe, expect, it, beforeEach } from "vitest";

import {
  DEFAULT_SAMPLE_INTERVAL_MS,
  HEAP_TOTAL_PEAK_COMPONENT,
  HEAP_USED_PEAK_COMPONENT,
  __resetHeapPeakTrackerForTest,
  readHeapPeaks,
  recordHeapPeakSample,
  startHeapPeakTracking,
} from "../services/heap-peak-tracker.js";
import { collectNativeMemorySnapshot } from "../services/native-memory-metrics.js";

/** The measured excursion on api `r4xbn`, 2026-10-14T19:12 -> 19:16Z. */
const EXCURSION = [
  { used_heap_size: 2_872_000_000, total_heap_size: 3_001_000_000 },
  { used_heap_size: 3_010_000_000, total_heap_size: 3_134_000_000 },
  { used_heap_size: 558_000_000, total_heap_size: 661_000_000 },
  { used_heap_size: 394_000_000, total_heap_size: 548_000_000 },
];

beforeEach(() => {
  __resetHeapPeakTrackerForTest();
});

describe("recordHeapPeakSample", () => {
  it("holds the peak after the heap collapses back", () => {
    for (const sample of EXCURSION) recordHeapPeakSample(sample);
    const peaks = readHeapPeaks()!;
    // The point of the instrument: the last reading is 394 MB and the answer is 3.01 GB.
    expect(peaks.usedPeakBytes).toBe(3_010_000_000);
    expect(peaks.totalPeakBytes).toBe(3_134_000_000);
    expect(peaks.sampleCount).toBe(4);
  });

  it("tracks the two sizes independently", () => {
    recordHeapPeakSample({ used_heap_size: 900, total_heap_size: 100 });
    recordHeapPeakSample({ used_heap_size: 100, total_heap_size: 900 });
    const peaks = readHeapPeaks()!;
    expect(peaks.usedPeakBytes).toBe(900);
    expect(peaks.totalPeakBytes).toBe(900);
  });

  it("ignores absent and non-finite fields without losing an established peak", () => {
    recordHeapPeakSample({ used_heap_size: 5_000, total_heap_size: 6_000 });
    recordHeapPeakSample({});
    recordHeapPeakSample({ used_heap_size: Number.NaN, total_heap_size: Number.POSITIVE_INFINITY });
    const peaks = readHeapPeaks()!;
    expect(peaks.usedPeakBytes).toBe(5_000);
    expect(peaks.totalPeakBytes).toBe(6_000);
    // Still counted: the sampler IS alive, it just read nothing usable. Conflating
    // that with "never started" is the ambiguity this field exists to remove.
    expect(peaks.sampleCount).toBe(3);
  });
});

describe("readHeapPeaks", () => {
  it("returns null before any sample rather than a pair of zeroes", () => {
    expect(readHeapPeaks()).toBeNull();
  });

  it("reports the interval, so a low peak can be read as a bound", () => {
    recordHeapPeakSample({ used_heap_size: 1, total_heap_size: 1 });
    expect(readHeapPeaks()!.sampleIntervalMs).toBe(DEFAULT_SAMPLE_INTERVAL_MS);
  });
});

describe("startHeapPeakTracking", () => {
  function fakeTimers() {
    const ticks: Array<() => void> = [];
    let cleared = 0;
    let unreffed = 0;
    const handle = {
      unref() {
        unreffed += 1;
      },
    };
    return {
      ticks,
      get cleared() {
        return cleared;
      },
      get unreffed() {
        return unreffed;
      },
      setInterval: ((fn: () => void) => {
        ticks.push(fn);
        return handle;
      }) as unknown as typeof setInterval,
      clearInterval: (() => {
        cleared += 1;
      }) as unknown as typeof clearInterval,
    };
  }

  it("unrefs its timer so it cannot hold the process open", () => {
    const timers = fakeTimers();
    startHeapPeakTracking({ setInterval: timers.setInterval, clearInterval: timers.clearInterval });
    expect(timers.unreffed).toBe(1);
  });

  it("samples on each tick and records the peak", () => {
    const timers = fakeTimers();
    let index = 0;
    startHeapPeakTracking({
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
      heapStatistics: () => EXCURSION[index++]!,
    });
    for (let i = 0; i < EXCURSION.length; i += 1) timers.ticks[0]!();
    expect(readHeapPeaks()!.usedPeakBytes).toBe(3_010_000_000);
  });

  it("survives a throwing read and keeps sampling afterwards", () => {
    const timers = fakeTimers();
    let call = 0;
    startHeapPeakTracking({
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
      heapStatistics: () => {
        call += 1;
        if (call === 1) throw new Error("v8 unavailable");
        return { used_heap_size: 777, total_heap_size: 888 };
      },
    });
    timers.ticks[0]!();
    // A tick that read nothing is not evidence the sampler is observing anything.
    expect(readHeapPeaks()).toBeNull();
    timers.ticks[0]!();
    expect(readHeapPeaks()!.usedPeakBytes).toBe(777);
    expect(readHeapPeaks()!.sampleCount).toBe(1);
  });

  it("records the configured interval so the bound is published, not assumed", () => {
    const timers = fakeTimers();
    startHeapPeakTracking({
      intervalMs: 250,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
      heapStatistics: () => ({ used_heap_size: 1, total_heap_size: 1 }),
    });
    timers.ticks[0]!();
    expect(readHeapPeaks()!.sampleIntervalMs).toBe(250);
  });

  it("stops once and is idempotent", () => {
    const timers = fakeTimers();
    const stop = startHeapPeakTracking({
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
    });
    stop();
    stop();
    expect(timers.cleared).toBe(1);
  });
});

describe("native-memory snapshot integration", () => {
  const USAGE = { rss: 2_981_000_000, heapTotal: 1_062_000_000, external: 102_000_000, arrayBuffers: 40_000_000 };
  const HEAP = { malloced_memory: 1_024 };

  it("publishes both peak components once the sampler has run", () => {
    for (const sample of EXCURSION) recordHeapPeakSample(sample);
    const components = collectNativeMemorySnapshot({
      memoryUsage: () => USAGE,
      heapStatistics: () => HEAP,
    })!.components;
    expect(components.get(HEAP_USED_PEAK_COMPONENT)).toBe(3_010_000_000);
    expect(components.get(HEAP_TOTAL_PEAK_COMPONENT)).toBe(3_134_000_000);
  });

  it("omits both components entirely when the sampler never ran", () => {
    const components = collectNativeMemorySnapshot({
      memoryUsage: () => USAGE,
      heapStatistics: () => HEAP,
    })!.components;
    expect(components.has(HEAP_USED_PEAK_COMPONENT)).toBe(false);
    expect(components.has(HEAP_TOTAL_PEAK_COMPONENT)).toBe(false);
  });

  it("leaves the pre-existing components untouched", () => {
    recordHeapPeakSample({ used_heap_size: 1, total_heap_size: 2 });
    const components = collectNativeMemorySnapshot({
      memoryUsage: () => USAGE,
      heapStatistics: () => HEAP,
    })!.components;
    // gen F's measured residual, unchanged by this PR.
    expect(components.get("native_unaccounted")).toBe(1_817_000_000);
    expect(components.get("array_buffers")).toBe(40_000_000);
  });
});
