/**
 * @fileoverview Attribute this process's resident memory to the *allocator
 * regions* it actually lives in, so the PEN-3314 residual can be assigned to a
 * mechanism rather than to a subtraction (PEN-3314).
 *
 * ## Why a third memory instrument
 *
 * {@link module:server/services/native-memory-metrics} answered "which pool
 * grows" and its answer was a residual: `native_unaccounted = rss - heapTotal -
 * external`, measured at **88% of a 942 MB generation-scale rise** on worker
 * generation `10.244.3.199` (born 2026-10-19T08:23:13Z, 17.45 h, endpoints
 * 850.3 -> 1792.5 MiB). Over that generation `v8_malloced` peaked at 4.0 MiB and
 * the global-handle table at 245,792 / 331,848 entries — three orders of
 * magnitude short of the ~1 GB. So V8's own native pools are excluded, and the
 * residual is *named* but not *located*: it says only "outside the heap and
 * outside external", which is a definition, not a mechanism.
 *
 * This module reads the one authority that already knows where those bytes are —
 * the kernel's per-mapping accounting in `/proc/self/smaps` — and partitions
 * resident memory by mapping class. Unlike the residual, this IS a partition:
 * every VMA lands in exactly one class and the classes sum to the kernel's own
 * total (see {@link MAPPING_RSS_TOTAL_CLASS}).
 *
 * ## The hypothesis it is built to discriminate
 *
 * One mechanism survived the 2026-10-13 eliminations: **glibc secondary-arena
 * retention**. The worker runs with a 4-CPU limit on a 64-CPU node, and glibc
 * sizes its arena cap from `sysconf(_SC_NPROCESSORS_ONLN)` — which sees the
 * *node*, not the cgroup — permitting `8 * 64 = 512` arenas that `malloc_trim`
 * never returns to the OS. {@link SECONDARY_ARENA_CLASS} measures exactly that
 * population, so the hypothesis becomes a readable series instead of an
 * argument.
 *
 * ⚠ The *blanket* arena lead was demoted on 2026-10-13 and this module does not
 * revive it: the same-image `paperclip-api` sibling on the same node released
 * 1177 then 865 MB in ten minutes each, so a 512-arena cap that applies equally
 * to both cannot by itself explain the difference. What survived is the
 * narrower secondary-versus-main question, which is the one measured here. A
 * high arena count is therefore **not** a finding on its own — the finding is
 * arena RSS *tracking* the residual across a generation while the sibling's
 * does not.
 *
 * ## Cost — measured, and the reason this is NOT on the scrape path
 *
 * Reading `/proc/self/smaps` costs O(resident pages), not O(mappings): the
 * kernel walks page tables to produce each `Rss:` line. Measured on a Linux
 * container at a fixed ~121-129 mappings, median of 7:
 *
 * | RSS | `/proc/self/smaps` | `/proc/self/smaps_rollup` |
 * |---|---|---|
 * | 47 MB | 1.91 ms | 1.36 ms |
 * | 552 MB | 18.63 ms | 18.52 ms |
 * | 1047 MB | 35.96 ms | 39.50 ms |
 * | 2039 MB | 83.83 ms | 84.28 ms |
 * | 3037 MB | **108.42 ms** | **108.53 ms** |
 *
 * ~36 us/MB resident. Two consequences drive the design:
 *
 *   1. **`smaps_rollup` is not a cheap fallback.** It walks the same page tables
 *      and is the same price while discarding the per-mapping detail that is the
 *      entire point. There is no cheaper aggregate to degrade to.
 *   2. **The cost grows with the thing being measured.** At the 1.8-3.0 GB this
 *      worker reaches, a scan is a **70-110 ms synchronous event-loop block** —
 *      and the signature this row is chasing is *itself* an event-loop stall
 *      (the +672 MB single-scrape step coincides with the heartbeat-timer
 *      counter failing to advance). An instrument that stalls the loop for
 *      ~110 ms every 15 s would inject its own copy of the phenomenon into the
 *      measurement. {@link refreshProcessMappingMetrics} therefore samples on a
 *      bounded cadence ({@link DEFAULT_MIN_SCAN_INTERVAL_MS}) and republishes a
 *      cached snapshot in between, and {@link MAPPING_SCAN_SECONDS_METRIC}
 *      publishes the scan's own duration so that stall is attributable rather
 *      than anonymous.
 *
 * At the default 300 s cadence a 110 ms scan is a 0.037% duty cycle, against
 * the 0.3% that {@link module:server/services/fd-class-metrics} already accepts
 * at 15 s. The long cadence is what buys that, which is why it is a floor and
 * not a suggestion.
 *
 * ## What it is not
 *
 * ⛔ Not an alert source and not a fix. It localises the residual to a region
 * class; it does not stop the growth, and PEN-3314 does not close on it landing.
 *
 * ⛔ Linux-only by construction. On a kernel without `/proc/self/smaps` the
 * collector returns `null` and *nothing* is published — never zeroes. The
 * distinction is the same one the two sibling modules are built around, and it
 * is the distinction this investigation lost two months to.
 *
 * @module server/services/process-mapping-metrics
 */

import { readFileSync } from "node:fs";

/** procfs per-mapping accounting. Linux-only by construction. */
export const PROC_SELF_SMAPS = "/proc/self/smaps";

/**
 * glibc's `HEAP_MAX_SIZE` on 64-bit: the size *and* the alignment of a
 * secondary-arena heap.
 *
 * This constant is what makes {@link SECONDARY_ARENA_CLASS} a measurement
 * rather than a guess. `new_heap()` reserves exactly this much address space
 * with `PROT_NONE` at this alignment and then `mprotect`s the used prefix
 * read/write, which leaves an unmistakable footprint in `/proc/self/smaps`: a
 * 64 MiB-aligned, exactly-64 MiB, gapless run of anonymous mappings containing
 * at least one `---p` tail. Nothing else in a Node process produces that shape
 * by accident — V8's own reservations are differently sized and are not
 * PROT_NONE-tailed.
 */
export const GLIBC_HEAP_MAX_SIZE = 64 * 1024 * 1024;

/**
 * Minimum gap between two real scans.
 *
 * A floor, not a schedule: {@link refreshProcessMappingMetrics} is called from
 * the scrape path and performs a scan only when this much time has elapsed,
 * republishing the cached snapshot otherwise. 300 s holds a 110 ms scan to a
 * 0.037% duty cycle at the RSS where it costs that much — see the cost table in
 * the module docblock for why a 15 s cadence is not admissible here even though
 * it is for the descriptor walk.
 */
export const DEFAULT_MIN_SCAN_INTERVAL_MS = 300_000;

/**
 * Hard cap on mappings parsed per scan.
 *
 * Bounds the *parse*, which is O(mappings), where the read is O(resident pages)
 * and cannot be bounded from here at all. 8192 is ~63x the ~130 mappings this
 * process holds today and comfortably above the 512-arena ceiling glibc could
 * reach (~1100 mappings); past it the remainder is reported under
 * {@link TRUNCATED_CLASS} rather than dropped, so the partition still sums.
 */
export const MAPPING_SCAN_MAX_ENTRIES = 8192;

/** `[heap]` — the brk-based main arena. */
export const MAIN_ARENA_CLASS = "glibc_main_arena";
/** A 64 MiB-aligned, gapless, PROT_NONE-tailed anonymous run: a glibc secondary arena heap. */
export const SECONDARY_ARENA_CLASS = "glibc_secondary_arena";
/** `[stack]` and `[stack:*]`. Thread stacks are anonymous and land in {@link ANON_OTHER_CLASS}. */
export const STACK_CLASS = "stack";
/** Any mapping backed by a path: executable text, shared objects, mapped files. */
export const FILE_BACKED_CLASS = "file_backed";
/** Kernel pseudo-mappings (`[vdso]`, `[vvar]`, `[vsyscall]`, ...). */
export const SPECIAL_CLASS = "special";
/**
 * Anonymous memory that is not an identified arena.
 *
 * ⚠ This is the class that carries V8's own heap reservations, so it is
 * expected to be large and is NOT itself the leak signal. It is the complement
 * that makes the partition exact, and its value is differential: arena RSS
 * rising while this stays flat is the arena hypothesis; the reverse points back
 * at V8's reservations or at direct `mmap` by native code.
 */
export const ANON_OTHER_CLASS = "anon_other";
/** Mappings past {@link MAPPING_SCAN_MAX_ENTRIES}, folded so the partition still sums. */
export const TRUNCATED_CLASS = "unclassified_truncated";

/**
 * Label carrying the kernel's own total, published beside the classes as a
 * cross-check.
 *
 * The classes are built to sum to this exactly. Publishing the total as well
 * costs one series and turns "did the classifier drop a mapping" from an
 * untestable worry into a subtraction anyone can do in PromQL.
 */
export const MAPPING_RSS_TOTAL_CLASS = "total";

/** Every class this module can publish, so the publish path can emit measured zeroes. */
export const MAPPING_CLASSES: readonly string[] = [
  MAIN_ARENA_CLASS,
  SECONDARY_ARENA_CLASS,
  STACK_CLASS,
  FILE_BACKED_CLASS,
  SPECIAL_CLASS,
  ANON_OTHER_CLASS,
  TRUNCATED_CLASS,
];

export interface ProcessMappingSnapshot {
  /** Mapping class -> resident bytes. A true partition; includes {@link MAPPING_RSS_TOTAL_CLASS}. */
  rssByClass: ReadonlyMap<string, number>;
  /** Mapping class -> number of VMAs. Excludes {@link MAPPING_RSS_TOTAL_CLASS}. */
  countByClass: ReadonlyMap<string, number>;
  /** Distinct glibc secondary-arena heaps, each 64 MiB of reserved address space. */
  secondaryArenaCount: number;
  /** Wall-clock seconds the scan took, published so its event-loop cost is attributable. */
  scanSeconds: number;
  /**
   * Unix seconds at which this scan completed.
   *
   * Carried on the snapshot rather than stamped at publish time because the
   * snapshot is republished unchanged between scans: stamping at publish would
   * date every scrape to "now" and report a stale reading as fresh, which is
   * the one thing this field exists to prevent.
   */
  scanTimestampSeconds: number;
}

interface Vma {
  start: bigint;
  end: bigint;
  perms: string;
  path: string;
  rss: number;
}

const HEADER = /^([0-9a-f]+)-([0-9a-f]+)\s+(\S{4})\s+\S+\s+\S+\s+\S+\s*(.*)$/;
const RSS_LINE = /^Rss:\s+(\d+) kB$/;

/**
 * Parse `/proc/self/smaps` text into mappings.
 *
 * Exported for the tests, which drive it with synthetic smaps rather than with
 * this process's real one: the arena detector's *rejections* are the part worth
 * testing, and a live process cannot be made to exhibit a near-miss on demand.
 */
export function parseSmaps(text: string, maxEntries = MAPPING_SCAN_MAX_ENTRIES): {
  vmas: Vma[];
  truncatedRss: number;
  truncatedCount: number;
} {
  const vmas: Vma[] = [];
  let truncatedRss = 0;
  let truncatedCount = 0;
  let current: Vma | null = null;
  let overflow = false;

  for (const line of text.split("\n")) {
    const header = HEADER.exec(line);
    if (header) {
      overflow = vmas.length >= maxEntries;
      current = {
        start: BigInt(`0x${header[1]}`),
        end: BigInt(`0x${header[2]}`),
        perms: header[3]!,
        path: (header[4] ?? "").trim(),
        rss: 0,
      };
      if (overflow) truncatedCount += 1;
      else vmas.push(current);
      continue;
    }
    if (!current) continue;
    const rss = RSS_LINE.exec(line);
    if (!rss) continue;
    const bytes = Number(rss[1]) * 1024;
    if (overflow) truncatedRss += bytes;
    else current.rss = bytes;
  }

  return { vmas, truncatedRss, truncatedCount };
}

/**
 * Identify glibc secondary-arena heaps among the anonymous mappings.
 *
 * Returns the set of 64 MiB-aligned base addresses that carry the full
 * `new_heap()` signature. The test is deliberately strict on all four counts —
 * aligned base, exact 64 MiB extent, no interior gap, at least one PROT_NONE
 * mapping — because a loose version is worse than none: grouping anonymous
 * mappings by 64 MiB block alone reported **38 "arenas" in a 48 MB process**
 * where the strict test reports 5, and an inflated count would have read as
 * confirmation of the very hypothesis this is built to test.
 *
 * Validated against a forced positive: driving 256 concurrent `zlib.gzip` calls
 * with `UV_THREADPOOL_SIZE=64` moved this from **5 arenas / 0.29 MB to 69 arenas
 * / 10.29 MB** — i.e. it tracks arena creation one-for-one with threadpool
 * threads, and it does so without the loose detector's background noise.
 */
function findSecondaryArenaBases(vmas: readonly Vma[]): Set<bigint> {
  const heapMax = BigInt(GLIBC_HEAP_MAX_SIZE);
  const blocks = new Map<bigint, Vma[]>();

  for (const vma of vmas) {
    if (vma.path) continue;
    // A mapping straddling a 64 MiB boundary cannot be part of a heap that is
    // both 64 MiB long and 64 MiB aligned.
    if ((vma.end - 1n) / heapMax !== vma.start / heapMax) continue;
    const base = (vma.start / heapMax) * heapMax;
    const group = blocks.get(base);
    if (group) group.push(vma);
    else blocks.set(base, [vma]);
  }

  const bases = new Set<bigint>();
  for (const [base, group] of blocks) {
    group.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
    if (group[0]!.start !== base) continue;
    if (group[group.length - 1]!.end !== base + heapMax) continue;
    let gapless = true;
    for (let i = 1; i < group.length; i += 1) {
      if (group[i]!.start !== group[i - 1]!.end) {
        gapless = false;
        break;
      }
    }
    if (!gapless) continue;
    // The reserved, never-committed tail. Its absence means the region is fully
    // committed and is something other than a fresh glibc heap.
    if (!group.some((vma) => vma.perms.startsWith("---"))) continue;
    bases.add(base);
  }

  return bases;
}

function classify(vma: Vma, arenaBases: ReadonlySet<bigint>): string {
  if (vma.path === "[heap]") return MAIN_ARENA_CLASS;
  if (vma.path === "[stack]" || vma.path.startsWith("[stack")) return STACK_CLASS;
  if (vma.path.startsWith("[")) return SPECIAL_CLASS;
  if (vma.path) return FILE_BACKED_CLASS;
  const base = (vma.start / BigInt(GLIBC_HEAP_MAX_SIZE)) * BigInt(GLIBC_HEAP_MAX_SIZE);
  if (arenaBases.has(base)) return SECONDARY_ARENA_CLASS;
  return ANON_OTHER_CLASS;
}

export interface CollectProcessMappingOptions {
  /** Injection point for the tests; defaults to reading {@link PROC_SELF_SMAPS}. */
  readSmaps?: () => string;
  maxEntries?: number;
  /** Monotonic clock, seconds, for the duration only. Injected by the tests. */
  monotonicSeconds?: () => number;
  /** Wall clock, unix seconds. Separate from {@link monotonicSeconds} on purpose. */
  wallClockSeconds?: () => number;
}

/**
 * Read and classify this process's mappings.
 *
 * Returns `null` when `/proc/self/smaps` cannot be read at all — a non-Linux
 * host, or a kernel built without it. The caller publishes nothing in that case,
 * so "not measurable here" never renders as "measured zero". A readable smaps
 * that happens to contain no mappings of some class is a different thing, and
 * that class is published at its measured 0.
 */
export function collectProcessMappingSnapshot(
  options: CollectProcessMappingOptions = {},
): ProcessMappingSnapshot | null {
  const read = options.readSmaps ?? (() => readFileSync(PROC_SELF_SMAPS, "utf8"));
  // Two clocks, deliberately. The duration must come from a monotonic source --
  // an NTP step during a 110ms scan would otherwise publish a negative or wild
  // duration -- while the timestamp must come from the wall clock, because its
  // only consumer is `time() - timestamp` in PromQL and `time()` is wall clock.
  // Measuring both from one source would make one of the two wrong.
  const monotonic = options.monotonicSeconds ?? (() => Number(process.hrtime.bigint()) / 1e9);
  const wallClock = options.wallClockSeconds ?? (() => Date.now() / 1000);

  const started = monotonic();
  let text: string;
  try {
    text = read();
  } catch {
    return null;
  }

  const { vmas, truncatedRss, truncatedCount } = parseSmaps(
    text,
    options.maxEntries ?? MAPPING_SCAN_MAX_ENTRIES,
  );
  // A readable-but-empty smaps is not a measurement of an empty address space;
  // it means the read did not give us what we parse. Report it unmeasurable.
  if (vmas.length === 0 && truncatedCount === 0) return null;

  const arenaBases = findSecondaryArenaBases(vmas);

  const rssByClass = new Map<string, number>();
  const countByClass = new Map<string, number>();
  for (const mappingClass of MAPPING_CLASSES) {
    rssByClass.set(mappingClass, 0);
    countByClass.set(mappingClass, 0);
  }

  let total = 0;
  for (const vma of vmas) {
    const mappingClass = classify(vma, arenaBases);
    rssByClass.set(mappingClass, rssByClass.get(mappingClass)! + vma.rss);
    countByClass.set(mappingClass, countByClass.get(mappingClass)! + 1);
    total += vma.rss;
  }
  if (truncatedCount > 0) {
    rssByClass.set(TRUNCATED_CLASS, truncatedRss);
    countByClass.set(TRUNCATED_CLASS, truncatedCount);
    total += truncatedRss;
  }
  rssByClass.set(MAPPING_RSS_TOTAL_CLASS, total);

  return {
    rssByClass,
    countByClass,
    secondaryArenaCount: arenaBases.size,
    scanSeconds: Math.max(0, monotonic() - started),
    scanTimestampSeconds: wallClock(),
  };
}
