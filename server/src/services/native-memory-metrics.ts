/**
 * @fileoverview Measure the part of this process's footprint that V8 cannot
 * see, so an off-heap leak can be attributed without a heap snapshot (PEN-3314).
 *
 * This is the replacement instrument for the one that stopped working. PEN-3314
 * spent two months bisecting `nodejs_heap_size_used_bytes`, and on 2026-10-12
 * that gauge was shown to have stopped tracking this process: container
 * generation `10.244.3.143` (born 2026-10-11T13:09:19Z) ran a byte-identical
 * image to its predecessor at load matched to 0.05 concurrent runs, and
 *
 *   - `nodejs_heap_size_used_bytes` 12h floor slope: **-3.5 MB/h** (negative),
 *   - `process_resident_memory_bytes`: 1188 -> 2981 MB over 18h, monotonic,
 *   - `rss - heapTotal - external`: **281 -> 2098 MB over 21h (+87 MB/h)**.
 *
 * At age 19h the split was RSS 2981 MB, heapTotal 1062, heapUsed 738,
 * external 102 — i.e. **1817 MB resident that V8 does not account for**. Heap
 * was ~80% of the footprint when this row opened and ~15% by then. So a
 * `v8.writeHeapSnapshot()` would have shown a healthy ~740 MB heap and answered
 * nothing, which is why that route is retired on technical grounds and not only
 * on the credential-custody grounds recorded earlier.
 *
 * Every JS-visible accounting was flat across the same window, which is what
 * makes "native" the residual rather than a guess: `nodejs_active_handles` by
 * type, `nodejs_active_resources` by type, and `paperclip_process_open_fds_by_class`
 * all flat, with no `Worker` resource present at all (so it is not worker-thread
 * heaps, which the main isolate's `heapTotal` would not count).
 *
 * ## What this adds that PromQL could not already compute
 *
 * `rss - heapTotal - external` is derivable today from three default gauges, and
 * that subtraction is how the numbers above were measured. Three things it cannot
 * give, and this module does:
 *
 *   1. **`external` split into its two halves.** `process.memoryUsage().external`
 *      lumps ArrayBuffer-backed memory together with every other C++ object bound
 *      to a JS object. `arrayBuffers` is reported separately by Node and is simply
 *      not published by prom-client's default set. Buffers being flat while the
 *      remainder climbs, or the reverse, splits "Buffer churn" from "native
 *      binding" without a single line of guesswork.
 *   2. **V8's own native allocation.** `malloced_memory` / `peak_malloced_memory`
 *      and the global-handle sizes are V8 memory that lives *outside* the heap it
 *      reports as `heapTotal`. A native addon leaking persistent handles shows up
 *      in `total_global_handles_size` and in no other signal this process emits.
 *   3. **Detached contexts.** `number_of_detached_contexts` is non-zero only when
 *      a context has been detached but not yet collected — a leak signature with
 *      no false-positive steady state.
 *
 * Between them these partition the plausible causes of the residual into
 * V8-internal (malloced / global handles), ArrayBuffer-backed (array_buffers),
 * and *none of the above* — where "none of the above" is itself the finding,
 * because it leaves allocator retention and native addons, and the container
 * runs with a 4-CPU limit on a 64-CPU node, which lets glibc open up to
 * `8 * 64 = 512` malloc arenas that are never trimmed back to the OS.
 *
 * ## What it is not
 *
 * ⛔ Not an alert source, and not a fix. It names which pool is growing; it does
 * not stop the growth. PEN-3314 stays open on the strength of this module
 * landing, not closed by it.
 *
 * ⛔ The components are **not a partition of RSS** and do not sum to it. Three of
 * them (`array_buffers`, `external_other`) are already inside the `external`
 * that `native_unaccounted` subtracts, and `v8_malloced` overlaps the native
 * remainder rather than sitting beside it. Summing these is meaningless; each is
 * read on its own trend line.
 *
 * @module server/services/native-memory-metrics
 */

import { getHeapStatistics } from "node:v8";

import {
  EXTERNAL_PEAK_COMPONENT,
  HEAP_TOTAL_PEAK_COMPONENT,
  HEAP_USED_PEAK_COMPONENT,
  type HeapPeakReading,
  readHeapPeaks,
} from "./heap-peak-tracker.js";

/**
 * Resident memory not attributable to the V8 heap or to `external`.
 *
 * `rss - heapTotal - external`. This is the headline number for PEN-3314 and the
 * one an investigator should trend first.
 *
 * ⚠ It is **deliberately not clamped at zero**, and a negative reading is
 * meaningful rather than a bug. `heapTotal` is V8's *committed* heap, which can
 * include pages V8 has mapped but never touched; those count in `heapTotal` and
 * not in RSS, so the subtraction can legitimately underflow — most often shortly
 * after start, before the heap is dirtied. Clamping would render that case
 * identically to "this process holds no native memory", which is the same
 * unmeasurable-versus-zero conflation `fd-class-metrics.ts` exists to avoid one
 * level down. A persistently negative value says `heapTotal` is over-reporting
 * residency, which is information; a *rising* value is the leak.
 */
export const NATIVE_UNACCOUNTED_COMPONENT = "native_unaccounted";

/** `process.memoryUsage().arrayBuffers` — the ArrayBuffer-backed half of `external`. */
export const ARRAY_BUFFERS_COMPONENT = "array_buffers";

/**
 * `external - arrayBuffers` — the half of `external` that is *not* ArrayBuffer
 * memory, i.e. C++ objects bound to JS objects.
 *
 * Published as the remainder rather than as raw `external` because `external` is
 * already published by prom-client as `nodejs_external_memory_bytes`; emitting it
 * again would duplicate a series while answering nothing. The remainder is the
 * part no existing series carries.
 *
 * Can be slightly negative in principle for the same reason any difference of two
 * independently-sampled counters can be; both come from one `memoryUsage()` call
 * here, so in practice it does not. Left unclamped for consistency with
 * {@link NATIVE_UNACCOUNTED_COMPONENT}.
 */
export const EXTERNAL_OTHER_COMPONENT = "external_other";

/** `v8.getHeapStatistics().malloced_memory` — V8's native allocation outside its heap. */
export const V8_MALLOCED_COMPONENT = "v8_malloced";
/** `v8.getHeapStatistics().peak_malloced_memory` — high-water mark of the above. */
export const V8_PEAK_MALLOCED_COMPONENT = "v8_peak_malloced";
/** `v8.getHeapStatistics().total_global_handles_size` — persistent-handle arena size. */
export const V8_GLOBAL_HANDLES_TOTAL_COMPONENT = "v8_global_handles_total";
/** `v8.getHeapStatistics().used_global_handles_size` — persistent handles actually in use. */
export const V8_GLOBAL_HANDLES_USED_COMPONENT = "v8_global_handles_used";

/**
 * `v8.getHeapStatistics().total_physical_size` — the heap V8 has actually
 * committed physical pages for, as against `heapTotal`'s *reserved* size.
 *
 * ## Why this component and not another subtraction
 *
 * The 2026-10-21 generation of `paperclip-0` (born 08:03:09Z, 0 restarts) grew
 * `mapping_class=anon_other` by **+460 MB over 15.4 h while `heapTotal` moved
 * +21 MB**, and RSS rose +555 MB. The two same-image `paperclip-api` siblings
 * over the identical window moved `anon_other` by **−450 and −375 MB**. So the
 * worker accrues anonymous mappings that V8's *reserved* heap does not account
 * for and the siblings do not — but `heapTotal` alone cannot say whether those
 * pages are still physically committed inside V8, or were handed back by V8 and
 * retained below it.
 *
 * That is the whole remaining question, and it has exactly two answers:
 *
 *   - `total_physical_size` **stays high while `heapTotal` falls** ⇒ the pages
 *     are committed inside V8 and the retention is V8's own (its page pool, or
 *     a heap it declines to shrink). The fix is a V8 flag or an explicit
 *     release.
 *   - `total_physical_size` **tracks `heapTotal` down while RSS stays up** ⇒ V8
 *     released them and something *below* V8 — the page allocator, glibc, the
 *     kernel — kept them resident. The fix is at that layer instead.
 *
 * Those point at different subsystems, and nothing already published separates
 * them: `heapTotal` is reserved rather than committed, and
 * {@link NATIVE_UNACCOUNTED_COMPONENT} subtracts that reserved figure, so it
 * charges V8-committed-but-unreserved bytes to "native" where they are not
 * native at all.
 *
 * ⛔ Not a fix and not an alert source. It is the discriminator that tells the
 * next change which layer to go to.
 */
export const V8_HEAP_PHYSICAL_COMPONENT = "v8_heap_physical";

/** `number_of_native_contexts` — a steady-state value; growth means contexts are retained. */
export const NATIVE_CONTEXT_KIND = "native";
/** `number_of_detached_contexts` — non-zero is a leak signature with no healthy steady state. */
export const DETACHED_CONTEXT_KIND = "detached";

export interface NativeMemorySnapshot {
  /** Component label -> bytes. Not a partition of RSS; see the module docblock. */
  components: ReadonlyMap<string, number>;
  /** Context kind -> count. */
  contexts: ReadonlyMap<string, number>;
  /**
   * Samples the 1 s heap-peak sampler has folded in over this process's life,
   * or `null` when it has never run.
   *
   * Deliberately NOT a {@link components} entry: that map is published on a
   * `..._bytes` gauge and this is a count, so putting it there would make the
   * metric's unit a lie for one label value. It gets its own series instead.
   *
   * ## Why it is published at all
   *
   * The three peak components are the only series on this row whose *low*
   * reading is load-bearing: `external_peak` flat near its scrape value is what
   * sends the next instrument to malloc level instead of into server code. But
   * the peaks are sampled by an `unref()`d 1 s timer on the event loop, and the
   * event loop is exactly what the measured step stalls -- `up{pod="paperclip-0"}`
   * was **0** at 09:31Z on 2026-10-15 while RSS gained 1096 MiB. A sampler that
   * did not run during the burst reports a flat peak for the same reason a
   * sampler that ran 18 000 times and found nothing does, and the two carry
   * opposite conclusions.
   *
   * `rate()` over this series answers that in one query: a healthy 1 s sampler
   * rates at ~1.0/s, and a dip is the stall, measured rather than inferred from
   * a scrape that happened not to land.
   *
   * ⚠ Absence of the series means the sampler never started -- distinct from a
   * published 0, which this never is (the tracker returns `null` until the first
   * sample, so there is no count to publish before then).
   */
  heapPeakSampleCount: number | null;
}

/** Subset of `v8.getHeapStatistics()` this module reads. Every field is optional by Node version. */
export interface HeapStatisticsReading {
  malloced_memory?: number;
  peak_malloced_memory?: number;
  total_global_handles_size?: number;
  used_global_handles_size?: number;
  total_physical_size?: number;
  number_of_native_contexts?: number;
  number_of_detached_contexts?: number;
}

/** Subset of `process.memoryUsage()` this module reads. */
export interface MemoryUsageReading {
  rss?: number;
  heapTotal?: number;
  external?: number;
  arrayBuffers?: number;
}

export interface CollectNativeMemoryOptions {
  memoryUsage?: () => MemoryUsageReading;
  heapStatistics?: () => HeapStatisticsReading;
  heapPeaks?: () => HeapPeakReading | null;
}

/**
 * Accept a reading only if it is a finite number.
 *
 * The guard is against *absence*, not against implausibility: these fields are
 * documented per Node version and a runtime that does not report one omits it
 * rather than zeroing it. Treating a missing field as 0 would publish a flat zero
 * line that reads as "measured, and it is not growing" — the single most
 * expensive wrong answer this instrument could give, since that is exactly the
 * conclusion it exists to let someone draw about the V8 heap.
 */
function finite(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Read the native-memory accounting.
 *
 * Returns `null` when the readings cannot be taken at all — a runtime without
 * `v8.getHeapStatistics`, or either call throwing. The caller publishes nothing
 * in that case rather than zeroes, so "not measurable on this host" never renders
 * as "measured zero".
 *
 * Components whose underlying field is individually absent are *omitted* from the
 * map for the same reason, so the published series set names exactly what this
 * runtime could actually report.
 */
export function collectNativeMemorySnapshot(
  options: CollectNativeMemoryOptions = {},
): NativeMemorySnapshot | null {
  const readMemoryUsage = options.memoryUsage ?? (() => process.memoryUsage());
  const readPeaks = options.heapPeaks ?? readHeapPeaks;
  // `node:v8` is a core module, so the import never fails; the field this reads
  // is what varies by runtime. The `typeof` check throws into the `null` branch
  // below rather than letting a missing function surface as a crash on the
  // `/metrics` request path.
  const readHeapStatistics =
    options.heapStatistics
    ?? (() => {
      if (typeof getHeapStatistics !== "function") throw new Error("v8.getHeapStatistics unavailable");
      return getHeapStatistics() as HeapStatisticsReading;
    });

  let usage: MemoryUsageReading;
  let heap: HeapStatisticsReading;
  try {
    usage = readMemoryUsage();
    heap = readHeapStatistics();
  } catch {
    return null;
  }

  const components = new Map<string, number>();
  const contexts = new Map<string, number>();

  // The headline residual. Requires all three terms: a partial subtraction would
  // be a different quantity wearing this one's name.
  if (finite(usage.rss) && finite(usage.heapTotal) && finite(usage.external)) {
    components.set(NATIVE_UNACCOUNTED_COMPONENT, usage.rss - usage.heapTotal - usage.external);
  }
  if (finite(usage.arrayBuffers)) {
    components.set(ARRAY_BUFFERS_COMPONENT, usage.arrayBuffers);
    if (finite(usage.external)) {
      components.set(EXTERNAL_OTHER_COMPONENT, usage.external - usage.arrayBuffers);
    }
  }

  if (finite(heap.malloced_memory)) components.set(V8_MALLOCED_COMPONENT, heap.malloced_memory);
  if (finite(heap.peak_malloced_memory)) {
    components.set(V8_PEAK_MALLOCED_COMPONENT, heap.peak_malloced_memory);
  }
  if (finite(heap.total_global_handles_size)) {
    components.set(V8_GLOBAL_HANDLES_TOTAL_COMPONENT, heap.total_global_handles_size);
  }
  if (finite(heap.used_global_handles_size)) {
    components.set(V8_GLOBAL_HANDLES_USED_COMPONENT, heap.used_global_handles_size);
  }
  // PEN-3314: committed-vs-reserved. Guarded by `finite` like every other field
  // here because a Node version that does not report it must leave the series
  // ABSENT -- a published 0 would read as "V8 has committed nothing", which is
  // precisely the wrong half of the discrimination this component exists to make.
  if (finite(heap.total_physical_size)) {
    components.set(V8_HEAP_PHYSICAL_COMPONENT, heap.total_physical_size);
  }

  // PEN-3314: the lifetime heap peaks, which are the whole reason this row's
  // floor-based statistics kept reading "flat". Sourced from the 1 s sampler
  // rather than from `heap` above, because the excursion that costs permanent
  // RSS completes between two scrapes and so is never present in a scrape-time
  // reading. A `null` here means the sampler is not running: publish nothing,
  // never a zero, for the reason given on `readHeapPeaks`.
  const peaks = readPeaks();
  // Null until the sampler's first tick; see `heapPeakSampleCount`. Read out of
  // the same reading as the peaks so the count can never describe a different
  // sampler state than the values it qualifies.
  const heapPeakSampleCount = peaks && finite(peaks.sampleCount) ? peaks.sampleCount : null;
  if (peaks) {
    components.set(HEAP_USED_PEAK_COMPONENT, peaks.usedPeakBytes);
    components.set(HEAP_TOTAL_PEAK_COMPONENT, peaks.totalPeakBytes);
    // The worker's measured step moved RSS +1096 MiB while `heapUsed` FELL, so
    // the heap peaks above cannot account for it. This is the axis it could have
    // landed on that V8 still accounts for; a flat reading here is what sends the
    // next instrument to malloc level instead. See the tracker's docblock.
    components.set(EXTERNAL_PEAK_COMPONENT, peaks.externalPeakBytes);
  }

  if (finite(heap.number_of_native_contexts)) {
    contexts.set(NATIVE_CONTEXT_KIND, heap.number_of_native_contexts);
  }
  if (finite(heap.number_of_detached_contexts)) {
    contexts.set(DETACHED_CONTEXT_KIND, heap.number_of_detached_contexts);
  }

  // Both calls succeeded but this runtime reported nothing we read. Publishing an
  // empty snapshot would be indistinguishable from a healthy process with no
  // native memory, so report it as unmeasurable instead.
  if (components.size === 0 && contexts.size === 0) return null;

  return { components, contexts, heapPeakSampleCount };
}
