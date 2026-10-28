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
 * ⛔ Does not replace `nodejs_gc_duration_seconds`, even though the ring now
 * retains each cycle's pause as well as its class. That histogram keeps the
 * duration DISTRIBUTION, observed at the scrape and labelled by `kind` alone.
 * The ring's copy exists for one thing the histogram cannot do at any query:
 * be summed over a ±5 s window a caller centres on a release onset. See
 * {@link GcCycleWindow.observedPauseMs}.
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
      // Same entry, second consumer: the counter answers "how many, by class,
      // over a scrape interval"; the ring answers "which classes fired in THIS
      // 10 s window", which is the question a +/-1 s release onset asks and a
      // counter cannot be queried for. See `readGcCyclesInWindow`.
      // `entry.duration` rides along because it is the cycle's own pause length
      // and the ring is the only place it can be joined to an onset -- see
      // GcCycleWindow.observedPauseMs for why that join is the open question.
      recordGcCycle(gcEntryInstantMs(entry), kind, flags, entry.duration);
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

  // Observation begins HERE, not at module load: anchor the ring's coverage
  // floor to it so a window reaching back before this instant reads as
  // unobserved rather than as an exact zero. See `ringStartMs`.
  ringStartMs = Date.now();
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

/**
 * Capacity of {@link recentCycles}, in GC entries.
 *
 * Sized against what the join in
 * {@link module:server/services/rss-release-gc-attribution} needs to retain: a
 * release onset must still be inside the ring when the next `/metrics` scrape
 * reads it. Worst case measured on this row is a 207 s drain (so the onset is
 * already that old at detection) plus a 30 s scrape interval plus the window's
 * own half-width — call it 5 minutes of GC history as the floor.
 *
 * 8192 entries covers ~4 h at the ambient 0.55 cycles/s this fleet runs at, and
 * still covers the 5 minute floor at a sustained 27 cycles/s — ~50x the ambient
 * rate. Beyond that the ring evicts, which is NOT silent: see
 * {@link GcCycleWindow.covered}.
 *
 * ⚠ Fixed cost, paid once: four typed arrays, 192 KiB total, allocated at
 * module load and never grown. That matters twice over on PEN-3314. The row is
 * a memory investigation, so an instrument whose own footprint scales with
 * anything would be self-defeating; and the writer runs INSIDE a
 * `PerformanceObserver` GC callback, where allocating per entry would make the
 * instrument a participant in the phenomenon it measures rather than an
 * observer of it. Hence typed arrays and raw numbers rather than an array of
 * `{ atMs, kind, flags, durationMs }` objects, which would allocate on every cycle.
 */
const GC_RING_CAPACITY = 8192;

const ringAtMs = new Float64Array(GC_RING_CAPACITY);
const ringKind = new Int32Array(GC_RING_CAPACITY);
const ringFlags = new Int32Array(GC_RING_CAPACITY);
/**
 * Pause duration of each cycle, in ms, or `NaN` where the entry did not carry one.
 *
 * `NaN` rather than `0` because this ring's consumers sum it: a zero would be
 * indistinguishable from a cycle that really did take no measurable time, and
 * would silently shrink a total that is read as a measurement. Unknown entries
 * are counted separately — see {@link GcCycleWindow.pauseUnknownCycles} — so a
 * sum is always qualifiable as exact or as a lower bound.
 */
const ringDurationMs = new Float64Array(GC_RING_CAPACITY);
/** Total entries ever recorded; the ring holds the last {@link GC_RING_CAPACITY} of them. */
let ringWritten = 0;
/**
 * Instant of the NEWEST entry evicted by wraparound, or `null` if none has been.
 *
 * This is the whole basis of {@link GcCycleWindow.covered}: a window whose start
 * is at or before this instant has lost entries it should have counted, so its
 * counts are a LOWER BOUND. Tracking the newest rather than the oldest eviction
 * is what makes that test sound — an older eviction says nothing about a
 * recent window.
 */
let newestEvictedAtMs: number | null = null;

/**
 * Epoch instant from which this ring could have observed ANYTHING.
 *
 * Eviction is only half of coverage. A window that reaches back past the
 * instant observation began was never observed either, and the ring cannot
 * tell the two apart from its contents: both look like "no entry in range".
 * Before the first eviction {@link newestEvictedAtMs} is `null`, so without
 * this instant every such window read {@link GcCycleWindow.covered} as `true`
 * — publishing an unobserved stretch as an exact zero.
 *
 * ⚠ That failure has a specific, likely shape on PEN-3314. A release in the
 * first ~305 s of a generation (warm-up, then a drop) puts the BASELINE window
 * of {@link module:server/services/rss-release-gc-attribution} — onset − 300 s
 * — before this process was watching. An exact-looking baseline of 0 against a
 * nonzero onset count is a large positive ratio, i.e. the first positive
 * trigger result this row has ever had, manufactured out of a measurement that
 * was never taken.
 *
 * Re-anchored when {@link registerGcFlagsCollector} installs the observer,
 * because that — not module load — is when entries begin arriving.
 */
let ringStartMs = Date.now();

/**
 * `performance.timeOrigin`, read once.
 *
 * `PerformanceEntry.startTime` is milliseconds since the time origin, not an
 * epoch instant, and every consumer of this ring compares it against
 * `Date.now()`-derived timestamps from the RSS sampler. Converting at write
 * time keeps the two instruments on one clock, which is the entire point of
 * dating anything at 1 s.
 *
 * ⚠ Not the SAME clock, strictly: `timeOrigin + startTime` rides the monotonic
 * clock while the sampler's stamps ride the wall clock, so NTP slew separates
 * them by however much the wall clock was corrected since process start. That
 * is a drift of well under a second at this fleet's uptimes — immaterial
 * against a 10 s window and the onset stamp's own ~4 s lateness — but it is a
 * drift, not a fixed offset, and it would matter to anyone narrowing the window
 * toward the ±1 s the onset is dated at. Re-anchoring per entry would cost a
 * `Date.now()` inside the GC callback and buy nothing at the current width.
 */
let timeOriginMs = performance.timeOrigin;

/** One GC class and how many of its cycles fell inside a window. */
export interface GcCycleClassCount {
  readonly kind: string;
  readonly flags: string;
  readonly cycles: number;
  /**
   * Total pause time of this class's cycles inside the window, in ms.
   *
   * Sums only the cycles that carried a duration; see
   * {@link GcCycleWindow.pauseUnknownCycles} before reading it as exact.
   */
  readonly pauseMs: number;
}

/** The result of counting GC cycles over a closed time window. */
export interface GcCycleWindow {
  readonly fromMs: number;
  readonly toMs: number;
  /** Per-class counts, descending by `cycles`. Empty when no cycle fell inside. */
  readonly classes: readonly GcCycleClassCount[];
  /** Total cycles inside the window, i.e. the sum over {@link classes}. */
  readonly observedCycles: number;
  /**
   * Total GC pause time inside the window, in ms, i.e. the sum over {@link classes}.
   *
   * ⭐ The reason this exists. {@link observedCycles} answers "did GC fire?",
   * which PEN-3314 has now measured as NECESSARY-LOOKING but plainly NOT
   * SUFFICIENT: a major marking cycle was in flight at 23/23 release onsets
   * against a 65.2% ambient rate, so occurrence cannot be the discriminator and
   * the thing that separates a releasing cycle from an ordinary one must be a
   * PROPERTY of the cycle. Pause time is the one property V8 already hands over
   * on the same entry.
   *
   * ⚠ It is a CANDIDATE property, not a predicted one, and the direction is
   * deliberately not asserted. V8's unmapper can free chunks on a background
   * task rather than inside the collection, so a releasing cycle need not cost
   * more pause time at all. That makes a null result here INFORMATIVE rather
   * than a failure: pause moving implicates work done inside the cycle, pause
   * flat while the release still lands implicates the background unmapper, and
   * both readings narrow the mechanism. ⛔ Do not read this field as an
   * assertion that the releasing cycle is the longer one.
   *
   * ⭐ It is also CONTINUOUS, which is why it is worth a series rather than
   * another label. The row's binary candidates need ~628 paired onsets for 80%
   * power at the effect sizes measured so far; a per-onset magnitude carries far
   * more information per episode, and episodes accrue at ~6/hour.
   *
   * ⛔ Not the same measurement as `nodejs_gc_duration_seconds`. That histogram
   * is observed at the scrape, aligned to scrape boundaries and labelled by
   * `kind` alone — the exact 30 s readout limit this module exists to beat. This
   * is pause time inside a window the CALLER centres on a ±1 s onset.
   *
   * ⛔ Read against the baseline window, never alone, for the same reason the
   * counts are: GC pause is ambient too.
   */
  readonly observedPauseMs: number;
  /**
   * Cycles inside the window that carried NO usable duration.
   *
   * `0` is the expected reading — Node's `gc` entries always carry one — so a
   * non-zero value means {@link observedPauseMs} and every {@link classes}
   * `pauseMs` beside it are a LOWER BOUND rather than a total. ⛔ Published
   * rather than folded into `covered`: that flag answers a different question
   * (did the ring still hold the window), and overloading it would make two
   * distinct failures indistinguishable — the error shape this row has already
   * paid for repeatedly.
   */
  readonly pauseUnknownCycles: number;
  /**
   * Whether the ring still held everything this window covers.
   *
   * `false` means entries inside the window were evicted and every count here
   * is a LOWER BOUND. ⛔ A reader that ignores this field converts ring
   * pressure into "GC did not fire", which is the exact shape of error PEN-3314
   * has already paid for twice — an empty read taken as a measurement rather
   * than as an absence of measurement.
   */
  readonly covered: boolean;
}

/**
 * Record one GC cycle in the ring.
 *
 * `durationMs` is the entry's own pause length. It is optional so that the
 * ring's existing callers and tests, which predate it, keep compiling; anything
 * absent or non-finite is stored as UNKNOWN rather than as a zero, and surfaces
 * in {@link GcCycleWindow.pauseUnknownCycles}.
 *
 * Exported for the test, which must be able to place cycles at chosen instants:
 * real GC is not schedulable, so driving this through actual collections would
 * test the allocator rather than the ring.
 */
export function recordGcCycle(
  atMs: number,
  kind: number | undefined,
  flags: number | undefined,
  durationMs?: number,
): void {
  const slot = ringWritten % GC_RING_CAPACITY;
  if (ringWritten >= GC_RING_CAPACITY) {
    // About to overwrite a live entry. Remember it, because a window reaching
    // back past it can no longer be counted exactly.
    const evictedAtMs = ringAtMs[slot];
    if (newestEvictedAtMs === null || evictedAtMs > newestEvictedAtMs) {
      newestEvictedAtMs = evictedAtMs;
    }
  }
  ringAtMs[slot] = atMs;
  ringKind[slot] = typeof kind === "number" && Number.isFinite(kind) ? kind : -1;
  ringFlags[slot] = typeof flags === "number" && Number.isFinite(flags) ? flags : 0;
  ringDurationMs[slot] =
    typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs >= 0
      ? durationMs
      : Number.NaN;
  ringWritten += 1;
}

/**
 * Count the GC cycles whose start instant falls in `[fromMs, toMs]`, by class.
 *
 * ## Why this exists rather than a PromQL range over `paperclip_gc_cycles_total`
 *
 * `paperclip_gc_cycles_total` is a counter, so the finest window a reader can
 * put on it is one scrape interval — 30 s on this fleet — and that window is
 * aligned to scrape boundaries rather than to anything that happened. PEN-3314
 * now dates a release ONSET to +/-1 s, and its standing conclusion is that
 * "Prometheus is exhausted on the trigger" precisely because a +/-1 s instant
 * read against 30 s averages buys bucket SELECTION, not bucket RESOLUTION.
 *
 * This function is the other half: it counts cycles in a narrow window centred
 * on an instant of the caller's choosing, in-process, at the resolution the
 * entries themselves carry. That is a measurement the scrape cannot express at
 * any query, and it is what makes the standing "GC does not mark the instant"
 * result testable rather than merely re-assertable.
 *
 * ⛔ It takes no view on which classes matter. The caller names a window; this
 * returns every class that fired in it. Filtering to a predicted `{kind, flags}`
 * is the trap the module docblock already records — an empty result then reads
 * as "that class was excluded" when it means "that label never existed".
 */
export function readGcCyclesInWindow(fromMs: number, toMs: number): GcCycleWindow {
  const counts = new Map<string, { kind: string; flags: string; cycles: number; pauseMs: number }>();
  const held = Math.min(ringWritten, GC_RING_CAPACITY);
  let observedCycles = 0;
  let observedPauseMs = 0;
  let pauseUnknownCycles = 0;
  for (let index = 0; index < held; index += 1) {
    const atMs = ringAtMs[index];
    if (atMs < fromMs || atMs > toMs) continue;
    const kind = gcKindLabel(ringKind[index] < 0 ? undefined : ringKind[index]);
    const flags = gcFlagsLabel(ringFlags[index]);
    // NaN marks a cycle whose duration never arrived. It is counted apart
    // rather than added as 0, so the sum stays a sum and the shortfall stays
    // visible. See GcCycleWindow.pauseUnknownCycles.
    const durationMs = ringDurationMs[index];
    const knownPauseMs = Number.isNaN(durationMs) ? 0 : durationMs;
    if (Number.isNaN(durationMs)) pauseUnknownCycles += 1;
    const key = `${kind}\u0000${flags}`;
    const existing = counts.get(key);
    if (existing) {
      existing.cycles += 1;
      existing.pauseMs += knownPauseMs;
    } else {
      counts.set(key, { kind, flags, cycles: 1, pauseMs: knownPauseMs });
    }
    observedCycles += 1;
    observedPauseMs += knownPauseMs;
  }
  const classes = [...counts.values()].sort(
    (left, right) => right.cycles - left.cycles || left.kind.localeCompare(right.kind),
  );
  return {
    fromMs,
    toMs,
    classes,
    observedCycles,
    observedPauseMs,
    pauseUnknownCycles,
    covered:
      fromMs >= ringStartMs && (newestEvictedAtMs === null || newestEvictedAtMs < fromMs),
  };
}

/** Reset ring state between tests. Not for production use. */
export function __resetGcCycleRingForTest(originMs?: number, startMs?: number): void {
  ringAtMs.fill(0);
  ringKind.fill(0);
  ringFlags.fill(0);
  ringDurationMs.fill(Number.NaN);
  ringWritten = 0;
  newestEvictedAtMs = null;
  timeOriginMs = originMs ?? performance.timeOrigin;
  // Defaults to the injected origin, so a test that places synthetic entries on
  // an origin-relative axis gets a ring that was "watching" from its own zero.
  // Pass `startMs` explicitly to test the window-precedes-the-ring case.
  ringStartMs = startMs ?? originMs ?? Date.now();
}

/** Epoch instant of a `gc` entry, which carries time-origin-relative `startTime`. */
export function gcEntryInstantMs(entry: PerformanceEntry): number {
  return timeOriginMs + entry.startTime;
}
