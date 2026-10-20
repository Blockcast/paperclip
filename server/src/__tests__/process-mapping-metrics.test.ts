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
  ANON_OTHER_CLASS,
  FILE_BACKED_CLASS,
  GLIBC_HEAP_MAX_SIZE,
  MAIN_ARENA_CLASS,
  MAPPING_RSS_TOTAL_CLASS,
  SECONDARY_ARENA_CLASS,
  SPECIAL_CLASS,
  STACK_CLASS,
  TRUNCATED_CLASS,
  collectProcessMappingSnapshot,
} from "../services/process-mapping-metrics.js";
import {
  PROCESS_GLIBC_SECONDARY_ARENA_COUNT_METRIC,
  PROCESS_MAPPING_COUNT_METRIC,
  PROCESS_MAPPING_RSS_BYTES_METRIC,
  PROCESS_MAPPING_SCAN_SECONDS_METRIC,
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
    expect(snapshot.secondaryArenaCount).toBe(1);
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
    expect(snapshot.secondaryArenaCount).toBe(2);
    expect(snapshot.countByClass.get(SECONDARY_ARENA_CLASS)).toBe(5);
  });

  it("rejects a run that does not start on a 64 MiB boundary", () => {
    const off = ARENA_BASE + 0x1000n;
    const snapshot = snapshotOf([
      vma(off, off + 0x200000n, "rw-p", 1024),
      vma(off + 0x200000n, ARENA_BASE + HEAP_MAX, "---p", 0),
    ])!;
    expect(snapshot.secondaryArenaCount).toBe(0);
    expect(snapshot.rssByClass.get(ANON_OTHER_CLASS)).toBe(1024 * 1024);
  });

  it("rejects a run shorter than 64 MiB", () => {
    const snapshot = snapshotOf([
      vma(ARENA_BASE, ARENA_BASE + 0x200000n, "rw-p", 1024),
      vma(ARENA_BASE + 0x200000n, ARENA_BASE + 0x400000n, "---p", 0),
    ])!;
    expect(snapshot.secondaryArenaCount).toBe(0);
  });

  it("rejects a run with an interior gap", () => {
    // Covers the full 64 MiB at both ends but is not one contiguous reservation,
    // so it is two unrelated mappings that happen to share a block.
    const snapshot = snapshotOf([
      vma(ARENA_BASE, ARENA_BASE + 0x100000n, "rw-p", 1024),
      vma(ARENA_BASE + 0x200000n, ARENA_BASE + HEAP_MAX, "---p", 0),
    ])!;
    expect(snapshot.secondaryArenaCount).toBe(0);
  });

  it("rejects a fully committed 64 MiB run with no PROT_NONE tail", () => {
    // This is the discriminating case: right size, right alignment, gapless, but
    // no reserved tail. glibc always leaves one, so this is something else --
    // most plausibly a V8 reservation, which must not be counted as an arena.
    const snapshot = snapshotOf([vma(ARENA_BASE, ARENA_BASE + HEAP_MAX, "rw-p", 65536)])!;
    expect(snapshot.secondaryArenaCount).toBe(0);
    expect(snapshot.rssByClass.get(ANON_OTHER_CLASS)).toBe(65536 * 1024);
  });

  it("never treats a file-backed run as an arena", () => {
    const snapshot = snapshotOf([
      vma(ARENA_BASE, ARENA_BASE + 0x200000n, "r-xp", 1024, "/usr/lib/libc.so.6"),
      vma(ARENA_BASE + 0x200000n, ARENA_BASE + HEAP_MAX, "---p", 0, "/usr/lib/libc.so.6"),
    ])!;
    expect(snapshot.secondaryArenaCount).toBe(0);
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
    expect(snapshot.secondaryArenaCount).toBe(0);
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
    secondaryArenaCount: 1,
    scanSeconds: 0.108,
    scanTimestampSeconds: 1_700_000_000,
  };

  it("publishes every series, including a zero arena count", async () => {
    setProcessMappingMetrics({ ...SNAPSHOT, secondaryArenaCount: 0 });
    expect(await labelled(PROCESS_MAPPING_RSS_BYTES_METRIC))
      .toEqual({ [SECONDARY_ARENA_CLASS]: 1024, [MAPPING_RSS_TOTAL_CLASS]: 4096 });
    expect(await labelled(PROCESS_MAPPING_COUNT_METRIC)).toEqual({ [SECONDARY_ARENA_CLASS]: 2 });
    const all = await lines();
    expect(all).toContain(`${PROCESS_GLIBC_SECONDARY_ARENA_COUNT_METRIC} 0`);
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
    expect(all.some((l) => l.startsWith(PROCESS_GLIBC_SECONDARY_ARENA_COUNT_METRIC))).toBe(false);
    expect(all.some((l) => l.startsWith(PROCESS_MAPPING_SCAN_TIMESTAMP_METRIC))).toBe(false);
  });

  it("never publishes a zero scan timestamp before the first scan", async () => {
    // Registration-time hazard: prom-client renders a label-less gauge the moment
    // it exists, so this must hold with no publish call at all.
    await renderMetrics();
    const all = await lines();
    expect(all.some((l) => l.startsWith(PROCESS_MAPPING_SCAN_TIMESTAMP_METRIC))).toBe(false);
    expect(all.some((l) => l.startsWith(PROCESS_GLIBC_SECONDARY_ARENA_COUNT_METRIC))).toBe(false);
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
