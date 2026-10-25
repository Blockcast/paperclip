/**
 * @fileoverview Publish the GC dimension prom-client throws away — V8's
 * per-cycle `flags` bitfield — so a page-pool release can be attributed to a
 * *class* of GC cycle rather than to "a major GC happened" (PEN-3314).
 *
 * ## Why a new series, when `nodejs_gc_duration_seconds` already exists
 *
 * prom-client's default GC collector observes `perf_hooks` `gc` entries and
 * labels them by `entry.detail.kind` only. The sibling field `entry.detail.flags`
 * — V8's `GCCallbackFlags` — is read by nobody and never leaves the process.
 * That discarded field is the one PEN-3314 needs, and the measurement below is
 * what establishes it rather than taste.
 *
 * On 2026-10-25 the four known page-pool release events (RSS drops of 619–789 MB
 * on `10.244.3.43` and `10.244.3.83`) were cross-tabulated at 30 s resolution
 * against every series this process already exports. The result:
 *
 *   - **A V8 heap-used ceiling (>=1048 MB) is NECESSARY.** All four releases are
 *     preceded by a ceiling sample at *exactly* the prior 30 s scrape, 4/4, and
 *     no instance that never reached the ceiling ever released.
 *   - **It is NOT SUFFICIENT.** 11 ceiling samples produced 4 releases (36%).
 *   - **Nothing exported discriminates the other 64%.** Across the 7 ceiling
 *     samples that did *not* release:
 *       * major-GC count in the following sample was `2,4,2,4,4,2,2` against
 *         `4,4,4,2` for the four that did — the same support;
 *       * heap magnitude overlaps (the single highest ceiling sample of all,
 *         1175.9 MB, did not release, while 1048.0 MB did);
 *       * RSS level overlaps (1558–1692 MB non-releasing vs 1563–1730 MB
 *         releasing — 1692 did not release, 1563 did).
 *
 * So the missing variable is not *timing* and not *magnitude*. Major GC at event
 * magnitude is simply the ambient state of this process — it holds in 93.4% of
 * all 30 s samples on the two instances that released (3347/3582), giving a
 * 0.12% precision for "release", and it fires 2148 times on a worker that
 * released zero times. A signal that is true almost always cannot be the thing
 * that distinguishes the rare event.
 *
 * What remains unmeasured is *which kind of major cycle ran*, and that is
 * exactly what `kind` collapses: a memory-reducing full GC and an ordinary
 * incremental-marking major are both `kind: "major"`. Publishing `flags`
 * alongside `kind` splits majors by flag class, and this module is the only
 * place that split becomes visible. Whether that split *is* the
 * memory-reducing/ordinary distinction is the question this series exists to
 * decide — it is not assumed here.
 *
 * ⛔ It deliberately does **not** name which flag value marks the unmapper's
 * page-release path, and no query against this series should filter on a
 * predicted one. An earlier revision of this docblock asserted
 * `NODE_PERFORMANCE_GC_FLAGS_ALL_AVAILABLE_GARBAGE` was that marker. That bit
 * was never observed: over 13 natural major cycles (Node v24, synthetic
 * allocation workload) `all_available_garbage` fired **0 times**, while
 * `kind: "major"` split **11:2** between `schedule_idle` and `none`.
 *
 * ⚠️ Read that result at its real strength, which is narrower than it looks.
 * It rules the bit out as the thing that splits `kind: "major"` *here*. It does
 * not rule it out as a marker of the unmapper path in general: V8 sets
 * `all_available_garbage` on `CollectAllAvailableGarbage` / low-memory paths,
 * and a synthetic allocation workload would not be expected to reach those. So
 * the split this module exposes is real, and the guess about which bit carries
 * it is unsupported — not disproved. Read the distribution:
 *
 *     sum by (kind, flags) (increase(paperclip_gc_cycles_total[1m]))
 *
 * A filter on a value V8 never emits returns empty for a reason that has
 * nothing to do with its hypothesis, and an empty result is then read as
 * "the cycle class was excluded" when it means "the label never existed".
 * That is the same trap PEN-3314 already records for `v8_heap_physical`,
 * where a name grep read EMPTY as never-shipped.
 *
 * ## Cost
 *
 * One additional `PerformanceObserver` on an event stream Node already emits and
 * prom-client already observes. No syscall, no `smaps` walk, no scrape-cadence
 * change, no timer. This deliberately supersedes the earlier PEN-3314 proposal
 * to resample RSS at 5 s, which was both more expensive and — per the ordering
 * result above, which is already clean at 30 s — aimed at the wrong axis.
 *
 * ## What it is not
 *
 * ⛔ Not an alert source, not a fix, and not a claim that the memory-reducing
 * cycle *is* the discriminator. It is the instrument that can decide it. If the
 * same `{kind, flags}` combinations turn out to fire on the non-releasing
 * ceiling samples too, that is a real answer and this series is how it gets read.
 *
 * ⛔ Does not replace `nodejs_gc_duration_seconds`. That histogram keeps its
 * duration distribution; this counts cycles by class.
 *
 * @module server/services/gc-flags-metrics
 */

import { PerformanceObserver, constants } from "node:perf_hooks";
import type { PerformanceEntry } from "node:perf_hooks";

import { Counter, type Registry } from "prom-client";

export const GC_CYCLES_METRIC = "paperclip_gc_cycles_total";

/** `entry.detail.kind` values, per `perf_hooks` constants. */
const GC_KINDS: ReadonlyArray<readonly [number, string]> = [
  [constants.NODE_PERFORMANCE_GC_MAJOR, "major"],
  [constants.NODE_PERFORMANCE_GC_MINOR, "minor"],
  [constants.NODE_PERFORMANCE_GC_INCREMENTAL, "incremental"],
  [constants.NODE_PERFORMANCE_GC_WEAKCB, "weakcb"],
];

/**
 * `entry.detail.flags` bits. This is a bitfield, not an enum — a single cycle
 * can carry several — so the label is the set, joined in this fixed order so
 * that one combination always renders as one series rather than as a permutation
 * family.
 */
const GC_FLAG_BITS: ReadonlyArray<readonly [number, string]> = [
  [constants.NODE_PERFORMANCE_GC_FLAGS_CONSTRUCT_RETAINED, "construct_retained"],
  [constants.NODE_PERFORMANCE_GC_FLAGS_FORCED, "forced"],
  [
    constants.NODE_PERFORMANCE_GC_FLAGS_SYNCHRONOUS_PHANTOM_PROCESSING,
    "synchronous_phantom_processing",
  ],
  [constants.NODE_PERFORMANCE_GC_FLAGS_ALL_AVAILABLE_GARBAGE, "all_available_garbage"],
  [constants.NODE_PERFORMANCE_GC_FLAGS_ALL_EXTERNAL_MEMORY, "all_external_memory"],
  [constants.NODE_PERFORMANCE_GC_FLAGS_SCHEDULE_IDLE, "schedule_idle"],
];

export const GC_KIND_UNKNOWN = "unknown";
export const GC_FLAGS_NONE = "none";

/** Every bit this module knows how to name, as a mask. */
const KNOWN_FLAG_MASK = GC_FLAG_BITS.reduce((mask, [bit]) => mask | bit, 0);

/**
 * Series created at zero when the collector starts, as `(kind, flags)` pairs.
 *
 * A prom-client counter emits nothing until its first `inc()`, so a GC class
 * that never runs is *absent* from the scrape rather than zero — and absent is
 * exactly the reading this module cannot afford. PEN-3314 has already lost
 * time to two traps of that shape (`v8_heap_physical` read as a metric name
 * when it is a label value; the mapping bucket label being `size_bucket`, not
 * `bucket_bytes`), where an empty read was mistaken for "never shipped".
 *
 * Confirmed live on 2026-10-25: `paperclip_gc_cycles_total` read empty while
 * the sibling `paperclip_process_mapping_*` series — same registry, same
 * `/metrics` endpoint, same process — were populated. Distinguishing "not
 * deployed" from "never fired" took a source grep, a `merge-base` and a pod
 * inspection. It resolved to deploy lag, but nothing in the scrape could say
 * so. With these series pre-created it is one query: absent means the build
 * predates this module, `0` means the class genuinely never ran.
 *
 * ⛔ These are the combinations V8 was **measured** to emit — `major` split
 * 11:2 between `schedule_idle` and `none` over 13 natural major cycles — plus
 * the ambient scavenge that shows the observer is receiving entries at all.
 * They are deliberately **not** a prediction about which flag marks the
 * unmapper's page-release path, which this module does not assert and a query
 * must not guess (see the ⛔ note in the module docblock, and #3010). Pinning
 * the measured support is what makes the *distribution* readable from the
 * first scrape; any other combination V8 emits still appears on its first
 * occurrence, and once these read non-zero the collector is provably live, so
 * a combination still absent at that point is genuinely one that never fired.
 *
 * Deliberately only three. The `flags` label is a bitfield set, so the full
 * cross-product is 4 kinds x 64 combinations; pre-creating it would trade a
 * readability problem for a cardinality one.
 *
 * ⚠️ These are exact label combinations, not flag predicates, and the
 * difference decides how a `0` here may be read. Because `flags` renders the
 * whole set, a major carrying `schedule_idle|forced` is a *different* series
 * from the pre-created `major|schedule_idle`. So a pre-created series still
 * reading `0` means **that exact combination** never fired — not that the bit
 * never appeared, which it may well have done alongside another one. A query
 * asking whether a bit was ever set at all must match the set rather than
 * equal it (`flags=~".*schedule_idle.*"`), or read the whole distribution with
 * `sum by (kind, flags)`, which is what PEN-3314 should do in any case.
 */
const PRE_INITIALISED_SERIES: ReadonlyArray<readonly [number, number]> = [
  [constants.NODE_PERFORMANCE_GC_MAJOR, 0],
  [constants.NODE_PERFORMANCE_GC_MAJOR, constants.NODE_PERFORMANCE_GC_FLAGS_SCHEDULE_IDLE],
  [constants.NODE_PERFORMANCE_GC_MINOR, 0],
];

/**
 * Map `entry.detail.kind` to a stable label.
 *
 * Unrecognised kinds collapse to {@link GC_KIND_UNKNOWN} rather than leaking the
 * raw integer: a future Node could add one, and an unbounded label value is how
 * a metric becomes a cardinality incident.
 */
export function gcKindLabel(kind: number | undefined): string {
  for (const [value, label] of GC_KINDS) {
    if (kind === value) return label;
  }
  return GC_KIND_UNKNOWN;
}

/**
 * Render `entry.detail.flags` as a canonical, bounded label.
 *
 * Returns {@link GC_FLAGS_NONE} for the no-flags cycle (the common case —
 * every scavenge observed in practice carries 0), otherwise the set bits joined
 * by `|` in {@link GC_FLAG_BITS} order. Bits outside {@link KNOWN_FLAG_MASK} are
 * folded into a single `other` term instead of being rendered numerically, which
 * keeps the label set finite no matter what a future V8 sets.
 */
export function gcFlagsLabel(flags: number | undefined): string {
  if (flags === undefined || !Number.isFinite(flags) || flags <= 0) return GC_FLAGS_NONE;
  const parts: string[] = [];
  for (const [bit, label] of GC_FLAG_BITS) {
    if ((flags & bit) !== 0) parts.push(label);
  }
  if ((flags & ~KNOWN_FLAG_MASK) !== 0) parts.push("other");
  return parts.length > 0 ? parts.join("|") : GC_FLAGS_NONE;
}

interface GcEntryDetail {
  readonly kind?: number;
  readonly flags?: number;
}

/**
 * Read the `gc` entry's detail without trusting its shape.
 *
 * `PerformanceEntry.detail` is typed `unknown` and is `null` for non-GC entry
 * types, so this narrows rather than casts. A malformed entry must not throw
 * inside an observer callback — that would surface as an unhandled rejection in
 * the metrics path and take down the scrape it was added to serve.
 */
function readGcDetail(entry: PerformanceEntry): GcEntryDetail {
  const detail: unknown = (entry as { detail?: unknown }).detail;
  if (typeof detail !== "object" || detail === null) return {};
  const { kind, flags } = detail as { kind?: unknown; flags?: unknown };
  return {
    kind: typeof kind === "number" ? kind : undefined,
    flags: typeof flags === "number" ? flags : undefined,
  };
}

export interface GcFlagsCollectorHandle {
  /** Stop observing. Idempotent. */
  readonly stop: () => void;
}

export interface RegisterGcFlagsCollectorOptions {
  readonly registry: Registry;
  /**
   * Observer factory, injected only so the test can drive entries without
   * provoking real garbage collection — which is not reliably schedulable and
   * would make the test flaky on a loaded CI box.
   */
  readonly createObserver?: (
    onEntries: (entries: readonly PerformanceEntry[]) => void,
  ) => { observe: () => void; disconnect: () => void };
}

/**
 * Register the GC-class counter on `registry` and begin observing.
 *
 * Safe to call once per registry; the caller owns lifetime via the returned
 * handle. The observer is `unref`-free by construction because
 * `PerformanceObserver` does not hold the event loop open.
 */
export function registerGcFlagsCollector(
  options: RegisterGcFlagsCollectorOptions,
): GcFlagsCollectorHandle {
  const { registry, createObserver } = options;

  const cycles = new Counter({
    name: GC_CYCLES_METRIC,
    help:
      "Garbage-collection cycles by kind and by V8's GCCallbackFlags bitfield "
      + "(PEN-3314). prom-client's default collector labels GC by 'kind' only "
      + "and discards 'flags', which collapses a memory-reducing full GC and an "
      + "ordinary incremental-marking major into the same series. That "
      + "distinction is the open question on PEN-3314: a V8 heap-used ceiling is "
      + "NECESSARY for a page-pool release (4/4, one 30s sample ahead) but only "
      + "36% sufficient, and neither major-GC count, heap magnitude nor RSS level "
      + "separates the ceilings that release from the ones that do not. "
      + "Which flag value marks the unmapper's page-release path is NOT "
      + "asserted here and must not be guessed at query time: read the "
      + "distribution with sum by (kind, flags). Filtering on a predicted "
      + "flag value returns empty whenever V8 never emits it, and that empty "
      + "then reads as 'the cycle class was excluded' when it means 'the "
      + "label never existed'. The module docblock carries the measurement "
      + "that retired the earlier 'all_available_garbage' guess; dated counts "
      + "are kept there rather than here, where they would age into a "
      + "standing claim. The 'flags' label is "
      + "a set, joined by '|' in a fixed order, so one bit combination is one "
      + "series; unknown bits fold into 'other' and unknown kinds into "
      + "'unknown' rather than rendering raw integers, which bounds cardinality.",
    labelNames: ["kind", "flags"],
    registers: [registry],
  });

  // Zero-init the measured GC classes, so "this class never fired" reads as a
  // 0 rather than an absence. See PRE_INITIALISED_SERIES for why these three.
  for (const [kind, flags] of PRE_INITIALISED_SERIES) {
    cycles.inc({ kind: gcKindLabel(kind), flags: gcFlagsLabel(flags) }, 0);
  }

  const onEntries = (entries: readonly PerformanceEntry[]): void => {
    for (const entry of entries) {
      const { kind, flags } = readGcDetail(entry);
      cycles.inc({ kind: gcKindLabel(kind), flags: gcFlagsLabel(flags) });
    }
  };

  const observer = createObserver
    ? createObserver(onEntries)
    : (() => {
        const real = new PerformanceObserver(list => {
          onEntries(list.getEntries());
        });
        return {
          observe: () => real.observe({ entryTypes: ["gc"] }),
          disconnect: () => real.disconnect(),
        };
      })();

  observer.observe();

  let stopped = false;
  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      observer.disconnect();
    },
  };
}
