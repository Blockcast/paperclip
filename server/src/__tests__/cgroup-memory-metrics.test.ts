/**
 * PEN-3692 — worker cgroup memory decomposition.
 *
 * The properties worth testing here are the ones that fail SILENTLY and in the
 * reassuring direction, because this instrument exists to settle a disputed
 * attribution and a confident wrong answer closes the question:
 *
 * 1. **A cgroup v1 `memory.stat` must be REFUSED, not parsed as an empty v2
 *    one.** v1 names the same quantities `rss` / `cache` / `total_rss`, so a v2
 *    parser over a v1 file finds none of its keys — and without the guard would
 *    publish a complete set of confident zeroes, `slab_reclaimable 0` among
 *    them. That is exactly the reading someone would cite as REFUTING this row's
 *    hypothesis, which makes it the most expensive bug available here.
 *
 * 2. **An unlimited `memory.max` must be ABSENT, never 0 and never `+Inf`.**
 *    Both render as usable numbers in a `current / max` headroom expression and
 *    silently produce a wrong one; an absent series makes it return no data.
 *
 * 3. **Unreadable is not zero, per file.** One unreadable scalar must not
 *    suppress the components, and must not publish itself as 0.
 *
 * 4. **Reset-then-set.** A component the kernel stops reporting must stop being
 *    published rather than freezing its last value.
 */

import { describe, expect, it, afterEach } from "vitest";

import {
  CGROUP_ANON_COMPONENT,
  CGROUP_FILE_COMPONENT,
  CGROUP_KERNEL_COMPONENT,
  CGROUP_SHMEM_COMPONENT,
  CGROUP_SLAB_COMPONENT,
  CGROUP_SLAB_RECLAIMABLE_COMPONENT,
  CGROUP_SLAB_UNRECLAIMABLE_COMPONENT,
  collectCgroupMemorySnapshot,
} from "../services/cgroup-memory-metrics.js";
import {
  CGROUP_MEMORY_COMPONENT_BYTES_METRIC,
  CGROUP_MEMORY_CURRENT_BYTES_METRIC,
  CGROUP_MEMORY_MAX_BYTES_METRIC,
  CGROUP_MEMORY_PEAK_BYTES_METRIC,
  __resetMetricsForTest,
  renderMetrics,
  setCgroupMemoryMetrics,
} from "../services/metrics.js";

/**
 * A real cgroup v2 `memory.stat`, trimmed to the keys this module reads plus
 * several it must ignore. Transcribed from a live pod rather than invented, so
 * the key spellings and ordering are the kernel's.
 */
const V2_STAT = [
  "anon 317882368",
  "file 217456640",
  "kernel 26689536",
  "kernel_stack 851968",
  "pagetables 5107712",
  "sec_pagetables 0",
  "percpu 18368",
  "sock 0",
  "vmalloc 0",
  "shmem 0",
  "file_mapped 258048",
  "slab_reclaimable 16910600",
  "slab_unreclaimable 2945192",
  "slab 19855792",
  "",
].join("\n");

/**
 * A cgroup **v1** `memory.stat`. The point of this fixture is that it is
 * perfectly well-formed — it parses cleanly into key/value pairs and yields none
 * of the v2 keys. Nothing but an explicit shape check distinguishes it.
 */
const V1_STAT = [
  "cache 217456640",
  "rss 317882368",
  "rss_huge 0",
  "mapped_file 258048",
  "total_cache 217456640",
  "total_rss 317882368",
  "",
].join("\n");

const FILES: Record<string, string> = {
  // `0::/` is the private cgroup namespace Kubernetes gives a pod by default:
  // the mount root IS our own cgroup. See HOST_NS_FILES for the other case.
  "/proc/self/cgroup": "0::/\n",
  "/cg/memory.stat": V2_STAT,
  "/cg/memory.current": "563560448\n",
  "/cg/memory.max": "8589934592\n",
  "/cg/memory.peak": "595288064\n",
};

function collect(overrides: Record<string, string | undefined> = {}) {
  const files = { ...FILES, ...overrides };
  return collectCgroupMemorySnapshot({
    cgroupRoot: "/cg",
    procSelfCgroup: "/proc/self/cgroup",
    readFile: (path) => {
      const value = files[path];
      // Mirror `readFileSync`, which throws rather than returning undefined.
      if (value === undefined) throw new Error(`ENOENT: ${path}`);
      return value;
    },
  });
}

describe("collectCgroupMemorySnapshot", () => {
  it("decomposes a cgroup v2 memory.stat into the published components", () => {
    const components = collect()!.components;
    expect(components.get(CGROUP_SLAB_RECLAIMABLE_COMPONENT)).toBe(16_910_600);
    expect(components.get(CGROUP_SLAB_UNRECLAIMABLE_COMPONENT)).toBe(2_945_192);
    expect(components.get(CGROUP_SLAB_COMPONENT)).toBe(19_855_792);
    expect(components.get(CGROUP_ANON_COMPONENT)).toBe(317_882_368);
    expect(components.get(CGROUP_FILE_COMPONENT)).toBe(217_456_640);
    expect(components.get(CGROUP_KERNEL_COMPONENT)).toBe(26_689_536);
  });

  it("publishes shmem at a measured 0, because 0 is the reading that confirms the emptyDir exclusion", () => {
    // The pod's two emptyDirs set no `medium: Memory`, so they must not be
    // charged here. That exclusion is only checkable if a real 0 is published
    // rather than omitted -- this is the one component whose zero is a finding.
    expect(collect()!.components.has(CGROUP_SHMEM_COMPONENT)).toBe(true);
    expect(collect()!.components.get(CGROUP_SHMEM_COMPONENT)).toBe(0);
  });

  it("ignores memory.stat keys it does not publish", () => {
    expect(collect()!.components.has("file_mapped")).toBe(false);
    expect(collect()!.components.has("percpu")).toBe(false);
  });

  it("REFUSES a cgroup v1 memory.stat rather than parsing it as an empty v2 one", () => {
    // The defect this guards: v1 parses cleanly and yields no v2 keys, so
    // without the shape check the snapshot would publish slab_reclaimable 0 --
    // the precise reading that would be cited as refuting PEN-3692.
    expect(collect({ "/cg/memory.stat": V1_STAT })).toBeNull();
  });

  it("returns null when memory.stat cannot be read at all", () => {
    expect(collect({ "/cg/memory.stat": undefined })).toBeNull();
  });

  it("returns null when memory.stat is v2-shaped but missing slab_reclaimable", () => {
    // A kernel that reports anon/file but not the field this row exists to read
    // has nothing to offer here, and a partial set would read as a measurement.
    const partial = ["anon 1", "file 2", "kernel 3", ""].join("\n");
    expect(collect({ "/cg/memory.stat": partial })).toBeNull();
  });

  it("reads memory.current and memory.peak", () => {
    const snapshot = collect()!;
    expect(snapshot.currentBytes).toBe(563_560_448);
    expect(snapshot.peakBytes).toBe(595_288_064);
  });

  it("reports an unlimited memory.max as null, not 0 and not Infinity", () => {
    const snapshot = collect({ "/cg/memory.max": "max\n" })!;
    expect(snapshot.maxBytes).toBeNull();
    // Guard the two wrong answers explicitly: both are finite-looking in a
    // current/max ratio, where null makes the expression return no data.
    expect(snapshot.maxBytes).not.toBe(0);
    expect(snapshot.maxBytes).not.toBe(Number.POSITIVE_INFINITY);
  });

  it("keeps the components when a scalar file is unreadable", () => {
    const snapshot = collect({ "/cg/memory.peak": undefined })!;
    expect(snapshot.peakBytes).toBeNull();
    expect(snapshot.currentBytes).toBe(563_560_448);
    expect(snapshot.components.get(CGROUP_SLAB_RECLAIMABLE_COMPONENT)).toBe(16_910_600);
  });

  it("rejects malformed and negative scalar readings rather than publishing them", () => {
    // memory.max is optional, so a malformed one leaves the rest measurable.
    expect(collect({ "/cg/memory.max": "not-a-number\n" })!.maxBytes).toBeNull();
    expect(collect({ "/cg/memory.max": "-1\n" })!.maxBytes).toBeNull();
    expect(collect({ "/cg/memory.peak": "\n" })!.peakBytes).toBeNull();
  });

  it("refuses the whole snapshot when memory.current is malformed or unreadable", () => {
    // memory.current is REQUIRED: it is the backstop that tells our own cgroup
    // apart from the v2 root, which has a v2-shaped memory.stat and no
    // memory.current. An unparseable one is as uninformative as a missing one.
    expect(collect({ "/cg/memory.current": undefined })).toBeNull();
    expect(collect({ "/cg/memory.current": "not-a-number\n" })).toBeNull();
    expect(collect({ "/cg/memory.current": "-1\n" })).toBeNull();
  });

  it("⛔ REFUSES a root-cgroup read — v2-shaped memory.stat but no memory.current", () => {
    // The cgroupns=host failure mode, and the most expensive one available:
    // the host root cgroup passes every memory.stat check and would publish
    // NODE-WIDE slab as this cgroup's charge.
    const root = collect({ "/cg/memory.current": undefined, "/cg/memory.max": undefined });
    expect(root).toBeNull();
  });

  it("resolves our own cgroup under a host cgroup namespace instead of reading the root", () => {
    // /proc/self/cgroup names a real path ⇒ the mount root is the HOST root and
    // our files live underneath it. Root-level values are deliberately given
    // DIFFERENT numbers, so reading the wrong directory cannot pass.
    const sub = "/cg/kubepods/burstable/podabc/container1";
    const snapshot = collectCgroupMemorySnapshot({
      cgroupRoot: "/cg",
      procSelfCgroup: "/proc/self/cgroup",
      readFile: (path) => {
        const files: Record<string, string> = {
          "/proc/self/cgroup": "0::/kubepods/burstable/podabc/container1\n",
          // host root: v2-shaped stat, no memory.current (as the kernel has it)
          "/cg/memory.stat": V2_STAT.replace("slab_reclaimable 16910600", "slab_reclaimable 99999999999"),
          [`${sub}/memory.stat`]: V2_STAT,
          [`${sub}/memory.current`]: "563560448\n",
          [`${sub}/memory.max`]: "8589934592\n",
          [`${sub}/memory.peak`]: "595288064\n",
        };
        const value = files[path];
        if (value === undefined) throw new Error(`ENOENT: ${path}`);
        return value;
      },
    })!;
    expect(snapshot.components.get(CGROUP_SLAB_RECLAIMABLE_COMPONENT)).toBe(16_910_600);
    expect(snapshot.currentBytes).toBe(563_560_448);
  });

  it("ignores a cgroup v1 /proc/self/cgroup line and does not walk out of the mount", () => {
    // A v1 line has the shape `N:controllers:/path` and must not be parsed as a
    // v2 path; a `..` segment must never escape the cgroup mount.
    expect(collect({ "/proc/self/cgroup": "3:memory:/kubepods/podabc\n" })!.currentBytes).toBe(563_560_448);
    expect(collect({ "/proc/self/cgroup": "0::/../../etc\n" })!.currentBytes).toBe(563_560_448);
    expect(collect({ "/proc/self/cgroup": undefined })!.currentBytes).toBe(563_560_448);
  });

  it("skips malformed memory.stat lines without failing the whole read", () => {
    const noisy = [V2_STAT.trimEnd(), "garbage-without-a-value", "another bad-value", ""].join("\n");
    const snapshot = collect({ "/cg/memory.stat": noisy })!;
    expect(snapshot.components.get(CGROUP_SLAB_RECLAIMABLE_COMPONENT)).toBe(16_910_600);
  });
});

describe("setCgroupMemoryMetrics", () => {
  afterEach(() => {
    __resetMetricsForTest();
  });

  async function render(): Promise<string> {
    return (await renderMetrics()).body;
  }

  it("publishes nothing at all for a null snapshot", async () => {
    setCgroupMemoryMetrics(null);
    const body = await render();
    // Not "publishes zeroes" -- the series must be ABSENT. A `# HELP`/`# TYPE`
    // header with no sample is what an unmeasurable cgroup looks like.
    expect(body).not.toMatch(new RegExp(`^${CGROUP_MEMORY_COMPONENT_BYTES_METRIC}\\{`, "m"));
    expect(body).not.toMatch(new RegExp(`^${CGROUP_MEMORY_CURRENT_BYTES_METRIC} `, "m"));
    expect(body).not.toMatch(new RegExp(`^${CGROUP_MEMORY_MAX_BYTES_METRIC} `, "m"));
    expect(body).not.toMatch(new RegExp(`^${CGROUP_MEMORY_PEAK_BYTES_METRIC} `, "m"));
  });

  it("publishes the components and scalars from a snapshot", async () => {
    setCgroupMemoryMetrics(collect());
    const body = await render();
    expect(body).toContain(
      `${CGROUP_MEMORY_COMPONENT_BYTES_METRIC}{component="${CGROUP_SLAB_RECLAIMABLE_COMPONENT}"} 16910600`,
    );
    expect(body).toMatch(new RegExp(`^${CGROUP_MEMORY_CURRENT_BYTES_METRIC} 563560448$`, "m"));
    expect(body).toMatch(new RegExp(`^${CGROUP_MEMORY_MAX_BYTES_METRIC} 8589934592$`, "m"));
    expect(body).toMatch(new RegExp(`^${CGROUP_MEMORY_PEAK_BYTES_METRIC} 595288064$`, "m"));
  });

  it("leaves the limit series absent when the cgroup is unlimited", async () => {
    setCgroupMemoryMetrics(collect({ "/cg/memory.max": "max\n" }));
    const body = await render();
    // The current series proves the publish happened at all, so the absent
    // limit is a real absence rather than a no-op test.
    expect(body).toMatch(new RegExp(`^${CGROUP_MEMORY_CURRENT_BYTES_METRIC} 563560448$`, "m"));
    expect(body).not.toMatch(new RegExp(`^${CGROUP_MEMORY_MAX_BYTES_METRIC} `, "m"));
  });

  it("stops publishing a component the kernel no longer reports", async () => {
    setCgroupMemoryMetrics(collect());
    expect(await render()).toContain(`${CGROUP_MEMORY_COMPONENT_BYTES_METRIC}{component="${CGROUP_KERNEL_COMPONENT}"}`);
    const withoutKernel = V2_STAT.split("\n").filter((line) => !line.startsWith("kernel ")).join("\n");
    setCgroupMemoryMetrics(collect({ "/cg/memory.stat": withoutKernel }));
    const body = await render();
    // Reset-then-set: a stale value freezing in place would read as live.
    expect(body).not.toContain(`${CGROUP_MEMORY_COMPONENT_BYTES_METRIC}{component="${CGROUP_KERNEL_COMPONENT}"}`);
    expect(body).toContain(`${CGROUP_MEMORY_COMPONENT_BYTES_METRIC}{component="${CGROUP_ANON_COMPONENT}"}`);
  });

  it("returns the scalars to absent, not to 0, when the cgroup becomes unmeasurable", async () => {
    setCgroupMemoryMetrics(collect());
    expect(await render()).toMatch(new RegExp(`^${CGROUP_MEMORY_MAX_BYTES_METRIC} 8589934592$`, "m"));
    setCgroupMemoryMetrics(null);
    const body = await render();
    // `reset()` on a label-less gauge republishes 0; `remove()` deletes it. A 0
    // limit turns every headroom expression into a division by zero.
    expect(body).not.toMatch(new RegExp(`^${CGROUP_MEMORY_MAX_BYTES_METRIC} `, "m"));
    expect(body).not.toMatch(new RegExp(`^${CGROUP_MEMORY_CURRENT_BYTES_METRIC} `, "m"));
  });
});
