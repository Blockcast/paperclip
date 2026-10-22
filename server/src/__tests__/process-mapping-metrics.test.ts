/**
 * PEN-3314 — mapping-class attribution.
 *
 * The arena detector is the part worth testing, and its dangerous failure is
 * over-acceptance rather than under: a loose version reported **38 "arenas" in a
 * 48 MB process** where the strict one reports 5, and an inflated count reads as
 * confirmation of the very hypothesis this module exists to test. A live process
 * cannot be made to exhibit a near-miss on demand, so the rejections are driven
 * from synthetic smaps and the acceptance is cross-checked against this
 * process's real one.
 *
 * Three further properties each fail silently:
 *
 * 1. **The classes are a partition.** Unlike `native-memory-metrics`, whose
 *    components deliberately overlap, every mapping here lands in exactly one
 *    class and the classes must sum to the kernel's own total. A classifier that
 *    drops a mapping would otherwise just look like slightly less memory.
 *
 * 2. **"Unmeasurable" is distinct from "zero"** — and for the three label-less
 *    gauges `reset()` is not enough, because prom-client renders a label-less
 *    gauge as `name 0`. A zero scan timestamp dates the last scan to 1970.
 *
 * 3. **The cadence cache must not freeze a failure.** A scan that fails has to
 *    drop the cached values, or a stale reading keeps publishing as if live.
 */

import { describe, expect, it, afterEach } from "vitest";

import {
  ANON_ALIGNED_64M_FULL_CLASS,
  ANON_OTHER_CLASS,
  FILE_BACKED_CLASS,
  GLIBC_HEAP_MAX_SIZE,
  MAIN_ARENA_CLASS,
  MAPPING_RSS_TOTAL_CLASS,
  SECONDARY_ARENA_CLASS,
  SPECIAL_CLASS,
  STACK_CLASS,
  MAPPING_SIZE_BUCKETS,
  SIZE_BUCKET_MAX_BYTES,
  SIZE_BUCKET_MIN_BYTES,
  TRUNCATED_CLASS,
  collectProcessMappingSnapshot,
  sizeBucketFor,
} from "../services/process-mapping-metrics.js";
import {
  PROCESS_GLIBC_SECONDARY_ARENA_HEAP_COUNT_METRIC,
  PROCESS_MAPPING_COUNT_METRIC,
  PROCESS_MAPPING_RSS_BYTES_METRIC,
  PROCESS_MAPPING_SCAN_SECONDS_METRIC,
  PROCESS_MAPPING_SIZE_BUCKET_BYTES_METRIC,
  PROCESS_MAPPING_SIZE_BUCKET_COUNT_METRIC,
  PROCESS_MAPPING_SCAN_TIMESTAMP_METRIC,
  __resetMetricsForTest,
  renderMetrics,
  setProcessMappingMetrics,
} from "../services/metrics.js";
import {
  __resetProcessMappingCacheForTest,
  refreshProcessMappingMetrics,
} from "../services/scrape-metrics-collector.js";

/** One smaps stanza. Only the header and `Rss:` are read; the rest is realistic filler. */
function vma(start: bigint, end: bigint, perms: string, rssKb: number, path = ""): string {
  const hex = (n: bigint) => n.toString(16);
  return [
    `${hex(start)}-${hex(end)} ${perms} 00000000 00:00 0 ${path ? `                  ${path}` : ""}`,
    `Size:           ${Number(end - start) / 1024} kB`,
    `Rss:            ${rssKb} kB`,
    `Pss:            ${rssKb} kB`,
    "VmFlags: rd wr mr mw me ac",
  ].join("\n");
}

const HEAP_MAX = BigInt(GLIBC_HEAP_MAX_SIZE);
/** A 64 MiB-aligned base, well away from anything else the fixtures use. */
const ARENA_BASE = 0x7f0040000000n;

/** The exact `new_heap()` footprint: committed prefix + PROT_NONE tail, gapless, 64 MiB total. */
function arena(base: bigint, committedKb: number, rssKb: number): string[] {
  const committed = base + BigInt(committedKb * 1024);
  return [
    vma(base, committed, "rw-p", rssKb),
    vma(committed, base + HEAP_MAX, "---p", 0),
  ];
}

function snapshotOf(stanzas: string[], maxEntries?: number) {
  return collectProcessMappingSnapshot({
    readSmaps: () => `${stanzas.join("\n")}\n`,
    maxEntries,
    monotonicSeconds: (() => {
      let t = 100;
      return () => (t += 0.25);
    })(),
    wallClockSeconds: () => 1_700_000_000,
  });
}

describe("collectProcessMappingSnapshot — arena detection", () => {
  it("accepts the glibc new_heap() footprint", () => {
    const snapshot = snapshotOf(arena(ARENA_BASE, 2048, 1024))!;
    expect(snapshot.secondaryArenaHeapCount).toBe(1);
    expect(snapshot.rssByClass.get(SECONDARY_ARENA_CLASS)).toBe(1024 * 1024);
  });

  it("counts each 64 MiB heap once however many mappings it is split into", () => {
    // Two arenas, the second fragmented into three mappings by an mprotect of an
    // interior range. Still one heap each.
    const second = ARENA_BASE + HEAP_MAX;
    const snapshot = snapshotOf([
      ...arena(ARENA_BASE, 2048, 1024),
      vma(second, second + 0x100000n, "rw-p", 512),
      vma(second + 0x100000n, second + 0x200000n, "rw-p", 256),
      vma(second + 0x200000n, second + HEAP_MAX, "---p", 0),
    ])!;
    expect(snapshot.secondaryArenaHeapCount).toBe(2);
    expect(snapshot.countByClass.get(SECONDARY_ARENA_CLASS)).toBe(5);
  });

  it("rejects a run that does not start on a 64 MiB boundary", () => {
    const off = ARENA_BASE + 0x1000n;
    const snapshot = snapshotOf([
      vma(off, off + 0x200000n, "rw-p", 1024),
      vma(off + 0x200000n, ARENA_BASE + HEAP_MAX, "---p", 0),
    ])!;
    expect(snapshot.secondaryArenaHeapCount).toBe(0);
    expect(snapshot.rssByClass.get(ANON_OTHER_CLASS)).toBe(1024 * 1024);
  });

  it("rejects a run shorter than 64 MiB", () => {
    const snapshot = snapshotOf([
      vma(ARENA_BASE, ARENA_BASE + 0x200000n, "rw-p", 1024),
      vma(ARENA_BASE + 0x200000n, ARENA_BASE + 0x400000n, "---p", 0),
    ])!;
    expect(snapshot.secondaryArenaHeapCount).toBe(0);
  });

  it("rejects a run with an interior gap", () => {
    // Covers the full 64 MiB at both ends but is not one contiguous reservation,
    // so it is two unrelated mappings that happen to share a block.
    const snapshot = snapshotOf([
      vma(ARENA_BASE, ARENA_BASE + 0x100000n, "rw-p", 1024),
      vma(ARENA_BASE + 0x200000n, ARENA_BASE + HEAP_MAX, "---p", 0),
    ])!;
    expect(snapshot.secondaryArenaHeapCount).toBe(0);
  });

  it("files a fully committed 64 MiB run as a CANDIDATE, not as a confirmed heap", () => {
    // Found in review of PR #2856, and it is the case that matters most:
    // grow_heap() mprotects the reserved tail read/write as the heap grows, so a
    // heap at HEAP_MAX_SIZE has NO `---p` left. An earlier revision rejected this
    // outright and swept it into anon_other, which is documented as pointing away
    // from arenas -- i.e. it would have rendered the large-retention case this
    // row is chasing as evidence against the hypothesis.
    const snapshot = snapshotOf([vma(ARENA_BASE, ARENA_BASE + HEAP_MAX, "rw-p", 65536)])!;
    expect(snapshot.secondaryArenaHeapCount).toBe(0);
    expect(snapshot.fullAlignedBlockCount).toBe(1);
    expect(snapshot.rssByClass.get(ANON_ALIGNED_64M_FULL_CLASS)).toBe(65536 * 1024);
    expect(snapshot.rssByClass.get(ANON_OTHER_CLASS)).toBe(0);
  });

  it("counts two kernel-merged mature heaps as two candidate blocks", () => {
    // The kernel merges adjacent anonymous VMAs with identical flags, so two
    // fully grown neighbours arrive as ONE 128 MiB rw-p mapping. Per-block
    // classification inside the aligned run is what recovers both.
    const snapshot = snapshotOf([vma(ARENA_BASE, ARENA_BASE + 2n * HEAP_MAX, "rw-p", 131072)])!;
    expect(snapshot.fullAlignedBlockCount).toBe(2);
    expect(snapshot.rssByClass.get(ANON_ALIGNED_64M_FULL_CLASS)).toBe(131072 * 1024);
  });

  it("UNDER-COUNTS a mature heap merged against a young one, by design", () => {
    // Documented limitation, asserted so it stays deliberate. A full rw-p heap
    // abutting the next heap's rw-p prefix merges into one 128 MiB run that
    // carries the young heap's tail -- so it is neither a clean single block nor
    // an unguarded run, and both halves fall to anon_other.
    //
    // The alternative was classifying per block inside any aligned run, which
    // sliced V8's 8.25 GiB reservation into 132 "arenas" on an idle 70 MB
    // process. Under-counting a narrow adjacency beats over-counting by two
    // orders of magnitude on the series whose whole purpose is to be believed.
    const snapshot = snapshotOf([
      vma(ARENA_BASE, ARENA_BASE + HEAP_MAX + 0x200000n, "rw-p", 66560),
      vma(ARENA_BASE + HEAP_MAX + 0x200000n, ARENA_BASE + 2n * HEAP_MAX, "---p", 0),
    ])!;
    expect(snapshot.fullAlignedBlockCount).toBe(0);
    expect(snapshot.secondaryArenaHeapCount).toBe(0);
    expect(snapshot.rssByClass.get(ANON_OTHER_CLASS)).toBe(66560 * 1024);
  });

  it("does not slice a large guarded reservation into candidate blocks", () => {
    // The regression this guard exists for. A 192 MiB aligned anonymous run with
    // interior PROT_NONE guard pages is a V8-style reservation, not three heaps;
    // an earlier revision reported 132 "arenas" from exactly this shape.
    const snapshot = snapshotOf([
      vma(ARENA_BASE, ARENA_BASE + 0x4000000n, "rw-p", 4096),
      vma(ARENA_BASE + 0x4000000n, ARENA_BASE + 0x4001000n, "---p", 0),
      vma(ARENA_BASE + 0x4001000n, ARENA_BASE + 3n * HEAP_MAX, "rw-p", 2048),
    ])!;
    expect(snapshot.secondaryArenaHeapCount).toBe(0);
    expect(snapshot.fullAlignedBlockCount).toBe(0);
    expect(snapshot.rssByClass.get(ANON_OTHER_CLASS)).toBe((4096 + 2048) * 1024);
  });

  it("still finds a young heap when an unrelated mapping abuts it", () => {
    // Why `confirmed` groups by block rather than by contiguous run: the run
    // would extend through the neighbour, fail the exact-64 MiB test, and drop a
    // real heap. Measured at 0-1 heaps under run-grouping against the validated
    // 5 under block-grouping.
    const snapshot = snapshotOf([
      ...arena(ARENA_BASE, 2048, 1024),
      vma(ARENA_BASE + HEAP_MAX, ARENA_BASE + HEAP_MAX + 0x10000n, "rw-p", 64),
    ])!;
    expect(snapshot.secondaryArenaHeapCount).toBe(1);
  });

  it("does not slice candidate blocks out of an unaligned or odd-sized anon run", () => {
    // The outer guard. Without it, any large V8 reservation would donate interior
    // 64 MiB slices to the candidate class and make it meaningless.
    const odd = snapshotOf([vma(ARENA_BASE, ARENA_BASE + HEAP_MAX + 0x100000n, "rw-p", 1024)])!;
    expect(odd.fullAlignedBlockCount).toBe(0);
    const unaligned = snapshotOf([
      vma(ARENA_BASE + 0x100000n, ARENA_BASE + 0x100000n + 2n * HEAP_MAX, "rw-p", 1024),
    ])!;
    expect(unaligned.fullAlignedBlockCount).toBe(0);
  });

  it("never treats a file-backed run as an arena", () => {
    const snapshot = snapshotOf([
      vma(ARENA_BASE, ARENA_BASE + 0x200000n, "r-xp", 1024, "/usr/lib/libc.so.6"),
      vma(ARENA_BASE + 0x200000n, ARENA_BASE + HEAP_MAX, "---p", 0, "/usr/lib/libc.so.6"),
    ])!;
    expect(snapshot.secondaryArenaHeapCount).toBe(0);
    expect(snapshot.rssByClass.get(FILE_BACKED_CLASS)).toBe(1024 * 1024);
  });
});

describe("collectProcessMappingSnapshot — the partition", () => {
  const MIXED = [
    ...arena(ARENA_BASE, 2048, 1024),
    vma(0x55aa00000000n, 0x55aa00100000n, "rw-p", 2048, "[heap]"),
    vma(0x7ffd00000000n, 0x7ffd00100000n, "rw-p", 128, "[stack]"),
    vma(0x7fff00000000n, 0x7fff00001000n, "r-xp", 4, "[vdso]"),
    vma(0x400000n, 0x500000n, "r-xp", 512, "/usr/bin/node"),
    vma(0x1234000000n, 0x1234100000n, "rw-p", 777, ""),
  ];

  it("assigns each mapping to exactly one class and sums to the kernel total", () => {
    const snapshot = snapshotOf(MIXED)!;
    const classes = [...snapshot.rssByClass]
      .filter(([name]) => name !== MAPPING_RSS_TOTAL_CLASS)
      .reduce((sum, [, bytes]) => sum + bytes, 0);
    expect(classes).toBe(snapshot.rssByClass.get(MAPPING_RSS_TOTAL_CLASS));
    expect(classes).toBe((1024 + 2048 + 128 + 4 + 512 + 777) * 1024);
  });

  it("files a named anonymous mapping as anonymous, not as a kernel pseudo-mapping", () => {
    // PR_SET_VMA_ANON_NAME (Linux >= 5.17) renders as [anon:name]. It starts with
    // '[' but is ordinary anonymous memory, so routing it to `special` would
    // quietly move native-addon allocations out of the class that tracks them.
    const snapshot = snapshotOf([
      vma(0x1234000000n, 0x1234100000n, "rw-p", 64, "[anon:v8-zone]"),
      vma(0x1235000000n, 0x1235100000n, "rw-p", 32, "[anon_shmem:thing]"),
      vma(0x7fff00000000n, 0x7fff00001000n, "r-xp", 4, "[vdso]"),
    ])!;
    expect(snapshot.rssByClass.get(ANON_OTHER_CLASS)).toBe((64 + 32) * 1024);
    expect(snapshot.rssByClass.get(SPECIAL_CLASS)).toBe(4 * 1024);
  });

  it("classifies each pseudo-path to its own class", () => {
    const snapshot = snapshotOf(MIXED)!;
    expect(snapshot.rssByClass.get(MAIN_ARENA_CLASS)).toBe(2048 * 1024);
    expect(snapshot.rssByClass.get(STACK_CLASS)).toBe(128 * 1024);
    expect(snapshot.rssByClass.get(SPECIAL_CLASS)).toBe(4 * 1024);
    expect(snapshot.rssByClass.get(FILE_BACKED_CLASS)).toBe(512 * 1024);
    expect(snapshot.rssByClass.get(ANON_OTHER_CLASS)).toBe(777 * 1024);
  });

  it("publishes a measured zero for a class this process has none of", () => {
    // Distinct from absence. "No secondary arenas" is the control reading the
    // arena hypothesis is tested against, so it has to be expressible.
    const snapshot = snapshotOf([vma(0x400000n, 0x500000n, "r-xp", 512, "/usr/bin/node")])!;
    expect(snapshot.rssByClass.get(SECONDARY_ARENA_CLASS)).toBe(0);
    expect(snapshot.secondaryArenaHeapCount).toBe(0);
  });

  it("folds mappings past the cap instead of dropping them, so the sum still holds", () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      vma(0x10000000n + BigInt(i) * 0x10000n, 0x10000000n + BigInt(i) * 0x10000n + 0x1000n, "rw-p", 16));
    const snapshot = snapshotOf(many, 4)!;
    expect(snapshot.countByClass.get(TRUNCATED_CLASS)).toBe(6);
    expect(snapshot.rssByClass.get(TRUNCATED_CLASS)).toBe(6 * 16 * 1024);
    expect(snapshot.rssByClass.get(MAPPING_RSS_TOTAL_CLASS)).toBe(10 * 16 * 1024);
  });
});

describe("collectProcessMappingSnapshot — unmeasurable is not zero", () => {
  it("returns null when smaps cannot be read", () => {
    expect(collectProcessMappingSnapshot({
      readSmaps: () => { throw new Error("ENOENT"); },
    })).toBeNull();
  });

  it("returns null for a readable but unparseable smaps", () => {
    // Not an empty snapshot: an empty one publishes a zero partition, which is
    // what a process mapping nothing would look like, and no such process exists.
    expect(collectProcessMappingSnapshot({ readSmaps: () => "" })).toBeNull();
    expect(collectProcessMappingSnapshot({ readSmaps: () => "not smaps\n" })).toBeNull();
  });

  it("times the scan on the monotonic clock and stamps it on the wall clock", () => {
    // Separate sources on purpose: an NTP step during a 110 ms scan would make a
    // wall-clock duration negative, and a monotonic timestamp is meaningless to
    // the `time() - timestamp` expression this field exists for.
    let mono = 10;
    const snapshot = collectProcessMappingSnapshot({
      readSmaps: () => `${arena(ARENA_BASE, 2048, 1024).join("\n")}\n`,
      monotonicSeconds: () => (mono += 0.5),
      wallClockSeconds: () => 1_700_000_000,
    })!;
    expect(snapshot.scanSeconds).toBeCloseTo(0.5, 6);
    expect(snapshot.scanTimestampSeconds).toBe(1_700_000_000);
  });

  it.skipIf(process.platform !== "linux")("reads this process's real mappings", () => {
    // Positive control. Every assertion above drives synthetic text, so without
    // this the suite would pass against an smaps format the kernel does not emit
    // — the failure mode where the instrument ships and publishes nothing.
    const snapshot = collectProcessMappingSnapshot();
    expect(snapshot).not.toBeNull();
    expect(snapshot!.rssByClass.get(MAPPING_RSS_TOTAL_CLASS)).toBeGreaterThan(0);
    // A real Node process always maps its own executable and some anonymous
    // memory; asserting these are non-zero is what catches a header regex that
    // silently matches nothing.
    expect(snapshot!.rssByClass.get(FILE_BACKED_CLASS)).toBeGreaterThan(0);
    expect(snapshot!.rssByClass.get(ANON_OTHER_CLASS)).toBeGreaterThan(0);
    const classes = [...snapshot!.rssByClass]
      .filter(([name]) => name !== MAPPING_RSS_TOTAL_CLASS)
      .reduce((sum, [, bytes]) => sum + bytes, 0);
    expect(classes).toBe(snapshot!.rssByClass.get(MAPPING_RSS_TOTAL_CLASS));
  });
});

describe("setProcessMappingMetrics (the publish path)", () => {
  afterEach(() => {
    __resetMetricsForTest();
    __resetProcessMappingCacheForTest();
  });

  async function lines(): Promise<string[]> {
    const { body } = await renderMetrics();
    return body.split("\n").filter((line) => line && !line.startsWith("#"));
  }

  async function labelled(metric: string): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const line of await lines()) {
      if (!line.startsWith(`${metric}{`)) continue;
      const matched = /\{mapping_class="([^"]*)"\}\s+(\S+)$/.exec(line);
      if (matched) out[matched[1]!] = Number(matched[2]);
    }
    return out;
  }

  const SNAPSHOT = {
    rssByClass: new Map([[SECONDARY_ARENA_CLASS, 1024], [MAPPING_RSS_TOTAL_CLASS, 4096]]),
    countByClass: new Map([[SECONDARY_ARENA_CLASS, 2]]),
    secondaryArenaHeapCount: 1,
    fullAlignedBlockCount: 0,
    scanSeconds: 0.108,
    scanTimestampSeconds: 1_700_000_000,
    sizeBucketCount: new Map([["262144", 2]]),
    sizeBucketBytes: new Map([["262144", 524_288]]),
  };

  it("publishes every series, including a zero arena count", async () => {
    setProcessMappingMetrics({ ...SNAPSHOT, secondaryArenaHeapCount: 0 });
    expect(await labelled(PROCESS_MAPPING_RSS_BYTES_METRIC))
      .toEqual({ [SECONDARY_ARENA_CLASS]: 1024, [MAPPING_RSS_TOTAL_CLASS]: 4096 });
    expect(await labelled(PROCESS_MAPPING_COUNT_METRIC)).toEqual({ [SECONDARY_ARENA_CLASS]: 2 });
    const all = await lines();
    expect(all).toContain(`${PROCESS_GLIBC_SECONDARY_ARENA_HEAP_COUNT_METRIC} 0`);
    expect(all).toContain(`${PROCESS_MAPPING_SCAN_SECONDS_METRIC} 0.108`);
    expect(all).toContain(`${PROCESS_MAPPING_SCAN_TIMESTAMP_METRIC} 1700000000`);
  });

  it("stops publishing a class that is no longer reported", async () => {
    setProcessMappingMetrics({
      ...SNAPSHOT,
      rssByClass: new Map([[SECONDARY_ARENA_CLASS, 1024], [ANON_OTHER_CLASS, 99]]),
    });
    setProcessMappingMetrics({ ...SNAPSHOT, rssByClass: new Map([[SECONDARY_ARENA_CLASS, 2048]]) });
    expect(await labelled(PROCESS_MAPPING_RSS_BYTES_METRIC))
      .toEqual({ [SECONDARY_ARENA_CLASS]: 2048 });
  });

  it("removes the label-less gauges on a null snapshot rather than zeroing them", async () => {
    // The sharp one. `reset()` on a label-less gauge republishes it at 0, and a
    // zero scan timestamp dates the last scan to 1970 — so `time() - timestamp`
    // would read ~56 years of staleness instead of the series going absent.
    setProcessMappingMetrics(SNAPSHOT);
    setProcessMappingMetrics(null);
    const all = await lines();
    expect(all.some((l) => l.startsWith(PROCESS_MAPPING_RSS_BYTES_METRIC))).toBe(false);
    expect(all.some((l) => l.startsWith(PROCESS_MAPPING_SIZE_BUCKET_COUNT_METRIC))).toBe(false);
    expect(all.some((l) => l.startsWith(PROCESS_MAPPING_SIZE_BUCKET_BYTES_METRIC))).toBe(false);
    expect(all.some((l) => l.startsWith(PROCESS_GLIBC_SECONDARY_ARENA_HEAP_COUNT_METRIC))).toBe(false);
    expect(all.some((l) => l.startsWith(PROCESS_MAPPING_SCAN_TIMESTAMP_METRIC))).toBe(false);
  });

  it("never publishes a zero scan timestamp before the first scan", async () => {
    // Registration-time hazard: prom-client renders a label-less gauge the moment
    // it exists, so this must hold with no publish call at all.
    await renderMetrics();
    const all = await lines();
    expect(all.some((l) => l.startsWith(PROCESS_MAPPING_SCAN_TIMESTAMP_METRIC))).toBe(false);
    expect(all.some((l) => l.startsWith(PROCESS_GLIBC_SECONDARY_ARENA_HEAP_COUNT_METRIC))).toBe(false);
  });
});

describe("refreshProcessMappingMetrics (the cadence)", () => {
  afterEach(() => {
    __resetMetricsForTest();
    __resetProcessMappingCacheForTest();
  });

  it.skipIf(process.platform !== "linux")(
    "scans once and republishes the same timestamp until the interval elapses",
    async () => {
      const read = async () => {
        const { body } = await renderMetrics();
        const line = body.split("\n")
          .find((l) => l.startsWith(`${PROCESS_MAPPING_SCAN_TIMESTAMP_METRIC} `));
        return line ? Number(line.split(" ")[1]) : null;
      };

      refreshProcessMappingMetrics(1_000_000);
      const first = await read();
      expect(first).not.toBeNull();

      // Well inside the 300 s floor: must republish, not rescan.
      refreshProcessMappingMetrics(1_000_000 + 60_000);
      expect(await read()).toBe(first);

      // Past it: a real scan, so a strictly later timestamp.
      refreshProcessMappingMetrics(1_000_000 + 400_000);
      expect(await read()).toBeGreaterThanOrEqual(first!);
    },
  );
});

describe("anon_other size buckets — PEN-3314", () => {
  const V8_PAGE = 262144;

  it("floors to a power of two, with the exact boundary landing in its own bucket", () => {
    // Computed by doubling rather than Math.log2 precisely so this holds: a V8
    // regular page is exactly 262144 bytes, and rounding it down one bucket
    // would hide the fixed-size signature this instrument exists to find.
    expect(sizeBucketFor(V8_PAGE)).toBe("262144");
    expect(sizeBucketFor(V8_PAGE - 1)).toBe("131072");
    expect(sizeBucketFor(V8_PAGE + 1)).toBe("262144");
    expect(sizeBucketFor(2 * V8_PAGE)).toBe("524288");
  });

  it("folds the tails in rather than dropping them", () => {
    expect(sizeBucketFor(0)).toBe(String(SIZE_BUCKET_MIN_BYTES));
    expect(sizeBucketFor(1)).toBe(String(SIZE_BUCKET_MIN_BYTES));
    expect(sizeBucketFor(SIZE_BUCKET_MAX_BYTES * 4)).toBe(String(SIZE_BUCKET_MAX_BYTES));
    expect(sizeBucketFor(Number.NaN)).toBe(String(SIZE_BUCKET_MIN_BYTES));
    expect(sizeBucketFor(Number.POSITIVE_INFINITY)).toBe(String(SIZE_BUCKET_MIN_BYTES));
  });

  it("separates a fixed-size population from a payload-sized one in the SAME bucket", () => {
    // The discrimination the pair exists for. Both fixtures put four mappings in
    // the 262144 bucket, so the COUNT alone cannot tell them apart; only
    // bytes/count can, and that is why neither series is published alone.
    const fixed = snapshotOf([
      vma(0x1000000000n, 0x1000000000n + BigInt(V8_PAGE), "rw-p", 256),
      vma(0x1100000000n, 0x1100000000n + BigInt(V8_PAGE), "rw-p", 256),
      vma(0x1200000000n, 0x1200000000n + BigInt(V8_PAGE), "rw-p", 256),
      vma(0x1300000000n, 0x1300000000n + BigInt(V8_PAGE), "rw-p", 256),
    ])!;
    const payload = snapshotOf([
      vma(0x1000000000n, 0x1000000000n + BigInt(V8_PAGE + 4096), "rw-p", 256),
      vma(0x1100000000n, 0x1100000000n + BigInt(V8_PAGE + 40960), "rw-p", 256),
      vma(0x1200000000n, 0x1200000000n + BigInt(V8_PAGE + 81920), "rw-p", 256),
      vma(0x1300000000n, 0x1300000000n + BigInt(V8_PAGE + 122880), "rw-p", 256),
    ])!;

    expect(fixed.sizeBucketCount.get("262144")).toBe(4);
    expect(payload.sizeBucketCount.get("262144")).toBe(4);

    const meanOf = (s: typeof fixed) =>
      s.sizeBucketBytes.get("262144")! / s.sizeBucketCount.get("262144")!;
    expect(meanOf(fixed)).toBe(V8_PAGE);
    expect(meanOf(payload)).toBeGreaterThan(V8_PAGE);
  });

  it("buckets VIRTUAL size, not resident size", () => {
    // A 256 KiB mapping with one resident page is still a 256 KiB allocation.
    // Bucketing by RSS would file it under 4096 and misreport the allocator.
    const snapshot = snapshotOf([
      vma(0x1000000000n, 0x1000000000n + BigInt(V8_PAGE), "rw-p", 4),
    ])!;
    expect(snapshot.sizeBucketCount.get("262144")).toBe(1);
    expect(snapshot.sizeBucketBytes.get("262144")).toBe(V8_PAGE);
    expect(snapshot.rssByClass.get(ANON_OTHER_CLASS)).toBe(4 * 1024);
  });

  it("counts only anon_other, so a same-sized mapping in another class is excluded", () => {
    const snapshot = snapshotOf([
      vma(0x1000000000n, 0x1000000000n + BigInt(V8_PAGE), "rw-p", 64, "[heap]"),
      vma(0x1100000000n, 0x1100000000n + BigInt(V8_PAGE), "r-xp", 64, "/usr/bin/node"),
      vma(0x1200000000n, 0x1200000000n + BigInt(V8_PAGE), "rw-p", 64),
    ])!;
    expect(snapshot.sizeBucketCount.get("262144")).toBe(1);
  });

  it("publishes a measured zero for every bucket this process has none of", () => {
    const snapshot = snapshotOf([vma(0x1200000000n, 0x1200000000n + BigInt(V8_PAGE), "rw-p", 64)])!;
    for (const bucket of MAPPING_SIZE_BUCKETS) {
      expect(snapshot.sizeBucketCount.get(bucket)).toBe(bucket === "262144" ? 1 : 0);
      expect(snapshot.sizeBucketBytes.get(bucket)).toBe(bucket === "262144" ? V8_PAGE : 0);
    }
  });

  it("renders both series, and renders neither when the scan is unmeasurable", async () => {
    __resetMetricsForTest();
    __resetProcessMappingCacheForTest();
    setProcessMappingMetrics(snapshotOf([
      vma(0x1200000000n, 0x1200000000n + BigInt(V8_PAGE), "rw-p", 64),
    ]));
    const { body } = await renderMetrics();
    expect(body).toContain(
      `${PROCESS_MAPPING_SIZE_BUCKET_COUNT_METRIC}{size_bucket="262144"} 1`,
    );
    expect(body).toContain(
      `${PROCESS_MAPPING_SIZE_BUCKET_BYTES_METRIC}{size_bucket="262144"} ${V8_PAGE}`,
    );

    // Unmeasurable publishes NOTHING -- never a zeroed bucket set, which would
    // read as "scanned, and the population is empty".
    __resetMetricsForTest();
    __resetProcessMappingCacheForTest();
    setProcessMappingMetrics(null);
    const empty = await renderMetrics();
    // SAMPLE lines only: a registered-but-empty gauge still renders its # HELP
    // and # TYPE, so asserting on the raw body would pass on the help text and
    // never test the thing this case is about.
    const samples = empty.body.split("\n").filter((line) => line && !line.startsWith("#"));
    expect(samples.some((l) => l.startsWith(PROCESS_MAPPING_SIZE_BUCKET_COUNT_METRIC))).toBe(false);
    expect(samples.some((l) => l.startsWith(PROCESS_MAPPING_SIZE_BUCKET_BYTES_METRIC))).toBe(false);
  });
});
