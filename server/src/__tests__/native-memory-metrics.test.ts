/**
 * PEN-3314 — native-memory instrument.
 *
 * This module exists because the previous instrument went blind, so its own
 * failure modes are the thing worth testing. Three properties carry the value
 * and each fails silently:
 *
 * 1. **"Unmeasurable" is distinct from "zero".** A field this runtime does not
 *    report must be ABSENT, not published at 0. A flat zero line reads as
 *    "measured, not growing" — which is precisely the wrong conclusion that
 *    `nodejs_heap_size_used_bytes` led this investigation into for two months.
 *
 * 2. **`native_unaccounted` is not clamped.** `rss - heapTotal - external` can
 *    legitimately go negative while V8's committed heap holds untouched pages.
 *    A `Math.max(0, …)` tidy-up would make that case render identically to a
 *    process holding no native memory, and would pass every test that only ever
 *    feeds it plausible numbers.
 *
 * 3. **Reset-then-set.** A component that stops being reported must stop being
 *    published, or a stale value freezes in place and reads as live.
 */

import { describe, expect, it, afterEach } from "vitest";

import {
  ARRAY_BUFFERS_COMPONENT,
  DETACHED_CONTEXT_KIND,
  EXTERNAL_OTHER_COMPONENT,
  NATIVE_CONTEXT_KIND,
  NATIVE_UNACCOUNTED_COMPONENT,
  V8_GLOBAL_HANDLES_TOTAL_COMPONENT,
  V8_GLOBAL_HANDLES_USED_COMPONENT,
  V8_MALLOCED_COMPONENT,
  V8_PEAK_MALLOCED_COMPONENT,
  collectNativeMemorySnapshot,
} from "../services/native-memory-metrics.js";
import {
  PROCESS_MEMORY_COMPONENT_BYTES_METRIC,
  PROCESS_V8_CONTEXT_COUNT_METRIC,
  __resetMetricsForTest,
  renderMetrics,
  setNativeMemoryMetrics,
} from "../services/metrics.js";

/** A complete, plausible pair of readings. Individual tests remove one field at a time. */
const USAGE = { rss: 2_981_000_000, heapTotal: 1_062_000_000, external: 102_000_000, arrayBuffers: 40_000_000 };
const HEAP = {
  malloced_memory: 1_024,
  peak_malloced_memory: 8_192,
  total_global_handles_size: 65_536,
  used_global_handles_size: 32_768,
  number_of_native_contexts: 3,
  number_of_detached_contexts: 0,
};

function collect(usage: Record<string, number> = USAGE, heap: Record<string, number> = HEAP) {
  return collectNativeMemorySnapshot({ memoryUsage: () => usage, heapStatistics: () => heap });
}

describe("collectNativeMemorySnapshot", () => {
  it("computes the headline residual from rss - heapTotal - external", () => {
    // The numbers are gen F's measured breakdown at age 19h; the expected value
    // is the 1817 MB of unaccounted native memory that opened this line of work.
    expect(collect()!.components.get(NATIVE_UNACCOUNTED_COMPONENT)).toBe(1_817_000_000);
  });

  it("splits external into its ArrayBuffer and non-ArrayBuffer halves", () => {
    const components = collect()!.components;
    expect(components.get(ARRAY_BUFFERS_COMPONENT)).toBe(40_000_000);
    expect(components.get(EXTERNAL_OTHER_COMPONENT)).toBe(62_000_000);
  });

  it("does NOT clamp a negative residual", () => {
    // Property #2. A freshly started process whose committed heap exceeds its
    // resident set produces this, and it is information rather than an error:
    // it says heapTotal is over-reporting residency. Clamping would render it
    // as "no native memory", which is a different and false claim.
    const components = collect({ rss: 100, heapTotal: 400, external: 50 })!.components;
    expect(components.get(NATIVE_UNACCOUNTED_COMPONENT)).toBe(-350);
  });

  it("publishes V8's own native pools", () => {
    const components = collect()!.components;
    expect(components.get(V8_MALLOCED_COMPONENT)).toBe(1_024);
    expect(components.get(V8_PEAK_MALLOCED_COMPONENT)).toBe(8_192);
    expect(components.get(V8_GLOBAL_HANDLES_TOTAL_COMPONENT)).toBe(65_536);
    expect(components.get(V8_GLOBAL_HANDLES_USED_COMPONENT)).toBe(32_768);
  });

  it("reports a zero detached-context count rather than omitting it", () => {
    // 0 is the healthy steady state and must be measurable as such: absent means
    // "this runtime does not report it", which is a different statement.
    const contexts = collect()!.contexts;
    expect(contexts.get(DETACHED_CONTEXT_KIND)).toBe(0);
    expect(contexts.get(NATIVE_CONTEXT_KIND)).toBe(3);
  });

  it("omits a component whose field this runtime does not report", () => {
    // Property #1, at the collector. `arrayBuffers` absent must remove BOTH the
    // array_buffers series and the external_other series derived from it —
    // publishing `external - undefined` as NaN, or as `external`, would both be
    // wrong in a way no plausible-input test would catch.
    const { external: _external, arrayBuffers: _arrayBuffers, ...rest } = USAGE;
    const components = collect({ ...rest })!.components;
    expect(components.has(ARRAY_BUFFERS_COMPONENT)).toBe(false);
    expect(components.has(EXTERNAL_OTHER_COMPONENT)).toBe(false);
    // The residual needs all three terms, so it drops too rather than becoming
    // a partial subtraction wearing the same name.
    expect(components.has(NATIVE_UNACCOUNTED_COMPONENT)).toBe(false);
  });

  it("rejects a non-finite reading rather than publishing it", () => {
    const components = collect({ ...USAGE, rss: Number.NaN })!.components;
    expect(components.has(NATIVE_UNACCOUNTED_COMPONENT)).toBe(false);
  });

  it("returns null when either underlying call throws", () => {
    expect(collectNativeMemorySnapshot({
      memoryUsage: () => { throw new Error("nope"); },
      heapStatistics: () => HEAP,
    })).toBeNull();
    expect(collectNativeMemorySnapshot({
      memoryUsage: () => USAGE,
      heapStatistics: () => { throw new Error("nope"); },
    })).toBeNull();
  });

  it("returns null when the calls succeed but report nothing this module reads", () => {
    // Not an empty snapshot: an empty one publishes no series, which is also
    // what a healthy-but-unreadable runtime would produce, and the two must not
    // be reachable by different paths that render identically for different
    // reasons.
    expect(collect({}, {})).toBeNull();
  });

  it("reads this process's real memory accounting", () => {
    // Positive control. Every assertion above drives injected fakes, so without
    // this the suite would pass against field names Node does not actually emit
    // — the failure mode where the instrument ships and publishes nothing.
    const snapshot = collectNativeMemorySnapshot();
    expect(snapshot).not.toBeNull();
    expect(snapshot!.components.has(NATIVE_UNACCOUNTED_COMPONENT)).toBe(true);
    expect(snapshot!.components.get(ARRAY_BUFFERS_COMPONENT)).toBeGreaterThanOrEqual(0);
    expect(snapshot!.contexts.get(NATIVE_CONTEXT_KIND)).toBeGreaterThan(0);
  });
});

describe("setNativeMemoryMetrics (the publish path)", () => {
  afterEach(() => {
    __resetMetricsForTest();
  });

  async function published(metric: string, label: string): Promise<Record<string, number>> {
    const { body } = await renderMetrics();
    const out: Record<string, number> = {};
    for (const line of body.split("\n")) {
      if (line.startsWith("#") || !line.startsWith(metric)) continue;
      const matched = new RegExp(`\\{${label}="([^"]*)"\\}\\s+(\\S+)$`).exec(line);
      if (matched) out[matched[1]!] = Number(matched[2]);
    }
    return out;
  }

  const components = () => published(PROCESS_MEMORY_COMPONENT_BYTES_METRIC, "component");
  const contexts = () => published(PROCESS_V8_CONTEXT_COUNT_METRIC, "kind");

  it("publishes one series per component and per context kind", async () => {
    setNativeMemoryMetrics({
      components: new Map([[NATIVE_UNACCOUNTED_COMPONENT, 1_817_000_000]]),
      contexts: new Map([[DETACHED_CONTEXT_KIND, 0]]),
    });
    expect(await components()).toEqual({ [NATIVE_UNACCOUNTED_COMPONENT]: 1_817_000_000 });
    // Published AT ZERO: a "skip falsy values" tidy-up in the publish loop would
    // silently delete the detached-context leak signature, whose whole healthy
    // state is 0, and every other assertion here uses non-zero values.
    expect(await contexts()).toEqual({ [DETACHED_CONTEXT_KIND]: 0 });
  });

  it("publishes a negative component verbatim", async () => {
    setNativeMemoryMetrics({
      components: new Map([[NATIVE_UNACCOUNTED_COMPONENT, -350]]),
      contexts: new Map(),
    });
    expect(await components()).toEqual({ [NATIVE_UNACCOUNTED_COMPONENT]: -350 });
  });

  it("stops publishing a component that is no longer reported", async () => {
    // Property #3. Without `reset()` the dropped component keeps reporting its
    // last value forever and reads as a pool that stopped growing.
    setNativeMemoryMetrics({
      components: new Map([[NATIVE_UNACCOUNTED_COMPONENT, 10], [V8_MALLOCED_COMPONENT, 20]]),
      contexts: new Map(),
    });
    setNativeMemoryMetrics({
      components: new Map([[NATIVE_UNACCOUNTED_COMPONENT, 11]]),
      contexts: new Map(),
    });
    expect(await components()).toEqual({ [NATIVE_UNACCOUNTED_COMPONENT]: 11 });
  });

  it("publishes NO series for a null snapshot, and clears a previous one", async () => {
    setNativeMemoryMetrics({
      components: new Map([[NATIVE_UNACCOUNTED_COMPONENT, 10]]),
      contexts: new Map([[NATIVE_CONTEXT_KIND, 3]]),
    });
    setNativeMemoryMetrics(null);
    expect(await components()).toEqual({});
    expect(await contexts()).toEqual({});
  });
});
