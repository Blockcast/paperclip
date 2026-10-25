/**
 * @fileoverview Decompose the worker's OWN cgroup memory charge, so the class of
 * a container-level excursion can be named without host access (PEN-3692).
 *
 * PEN-3692 is the second of two memory rows split off PEN-3314, and it is a
 * different layer from its sibling. PEN-3314 owns the JS heap (~1.1 GiB, `old` +
 * `large_object`). This one owns an excursion one layer out, in the *cgroup*,
 * whose JS-heap component is 0.6% — so every heap instrument this process
 * already carries is structurally blind to it.
 *
 * ## What was measured, and why it needs a reading from inside
 *
 * Between 2026-09-25 and 09-28 the worker cgroup sat against its 10 GiB
 * `memory.max` on four consecutive days. Byte-exact against
 * `container_spec_memory_limit_bytes` = 10,737,418,240:
 *
 *   | day   | peak bytes     | gap to memory.max |
 *   |-------|----------------|-------------------|
 *   | 09-25 | 10,737,401,856 | **16,384 B** — four pages |
 *   | 09-26 | 10,736,377,856 | 0.99 MiB |
 *   | 09-27 | 10,736,906,240 | 0.49 MiB |
 *   | 09-28 | 10,737,299,456 | 0.11 MiB |
 *
 * The cgroup did not "live near" its ceiling; it was held one allocation short
 * of it, which is continuous synchronous direct reclaim. Node-level correlation
 * attributed the charge to **reclaimable kernel slab** (Pearson r = 0.9802 over
 * n = 672 against `node_memory_SReclaimable_bytes`), with page cache excluded by
 * SIGN (node `Cached` FELL 28.4 -> 19.2 GiB while the residual climbed +5.0) and
 * unreclaimable slab excluded by MAGNITUDE (+0.6 vs +6.67 GiB).
 *
 * ⚠ That attribution is an inference from a *node-level* gauge plus a
 * correlation. Nothing has ever read this cgroup's own `memory.stat`. This
 * module is what makes the claim checkable rather than argued: `slab_reclaimable`
 * here is the same quantity, charged to the one cgroup in question.
 *
 * ## Why this is the only place the read can happen
 *
 * A process can only read cgroup accounting for its own cgroup: an agent seat
 * reading it learns about the agent pod and nothing about the worker, and no
 * agent seat reaches another pod's cgroup at all. A collector inside the worker
 * process is therefore the one place the worker's cgroup is addressable — the
 * limitation was always scope, never permission.
 *
 * ⚠ **`/sys/fs/cgroup` is NOT unconditionally this process's own cgroup**, and
 * getting that wrong is the one way this module could produce the confident
 * wrong answer it exists to prevent. The mount shows our own cgroup as the root
 * only under a *private cgroup namespace* (the Kubernetes default since 1.25,
 * and what this cluster uses — `/proc/self/cgroup` reads `0::/`). Under
 * `cgroupns=host` the same path is the **host root cgroup**, whose `memory.stat`
 * is v2-shaped and would sail through {@link V2_REQUIRED_KEYS} — publishing
 * **node-wide slab as this cgroup's charge**. Two guards, both load-bearing:
 *
 *   1. The cgroup path is resolved from `/proc/self/cgroup` rather than assumed,
 *      so a host-namespace deployment reads the right subdirectory instead of
 *      the root.
 *   2. `memory.current` is **required**. The v2 root cgroup does not have it (the
 *      memory controller creates no interface files there), so requiring it
 *      refuses a root read outright — a backstop that holds even if the path
 *      resolution above is defeated some other way.
 *
 * The teardown path this row suspects runs in exactly this cgroup, which is what
 * makes the read attributable: `execFile` children share the parent's cgroup, and
 * workspace provisioning is NOT dispatched to agent pods. So the `git worktree
 * remove --force` / recursive-delete work, and the 30 s collector's `git status`
 * safety walks, charge their dentry and inode cache *here*.
 *
 * ## `memory.peak` is the field that carries the most, and nothing else has it
 *
 * `memory.peak` is a kernel-maintained high-water mark. It therefore survives an
 * excursion that every scrape missed, which is precisely the 09-28 failure mode:
 * cAdvisor scrapes at 30 s and a 15-min evaluation step sees 1 sample in 30. The
 * authoring pod demonstrated the gap incidentally — `memory.current` 2.60 GB
 * against a `memory.peak` of 3.88 GB, a **1.28 GB excursion no sampled series on
 * that pod recorded**.
 *
 * ## What this is NOT
 *
 * ⛔ **It does not name the slab cache.** cgroup v2 reports `slab_reclaimable` as
 * a single scalar with no per-cache breakdown. Separating dentry from inode from
 * buffer_head needs host `/proc/slabinfo`, which is `Permission denied` from
 * every seat here. This confirms the CLASS; it does not close the question. The
 * help string repeats this so the exposition cannot be over-read either.
 *
 * ⛔ **Not a fix and not an alert source.** Detection already shipped as the
 * `PaperclipWorkerCgroupNearMemoryMax` rule. PEN-3692 does not close on this
 * module landing — the touching code path is still unidentified.
 *
 * ⛔ **Not a partition.** `slab` is the kernel's own total of `slab_reclaimable +
 * slab_unreclaimable`, published beside its parts rather than derived, so a
 * kernel that disagrees with the addition is visible instead of silently
 * reconciled. Do not sum the components and expect `memory.current`.
 *
 * ## Unmeasurable is never published as zero
 *
 * This is the single most load-bearing property in the module, and it is not
 * generic hygiene — it is specific to what a wrong answer here would cause. A
 * flat `slab_reclaimable 0` is exactly the reading someone would cite as
 * REFUTING this row's hypothesis. So an unreadable `memory.stat` publishes
 * nothing at all, and a cgroup **v1** `memory.stat` is refused rather than parsed
 * as an empty v2 one (v1 names the same quantities differently: `rss`, `cache`,
 * `total_rss` — a v2 parser over a v1 file finds none of its keys and would
 * otherwise emit a complete set of confident zeroes).
 *
 * An unlimited `memory.max` — the literal string `max` — publishes ABSENT for the
 * same reason in the other direction: 0 reads as a zero-byte limit, and `+Inf`
 * silently poisons any `current / max` ratio an operator writes.
 *
 * ## Cost
 *
 * ~43.6 µs per read, measured over 1000 reads, and O(1) in the leak — these are
 * small synthetic files whose size does not grow with the charge. That is what
 * makes it safe on the scrape path, where the sibling `/proc/self/smaps` walk is
 * not: that one is O(resident pages) and reaches 108 ms at 3 GB, so it samples on
 * a 300 s floor to avoid injecting a weaker copy of the stall it measures. At
 * 43.6 µs this one cannot. Reading all four files in one pass also keeps
 * `current - anon - file` self-consistent against a PromQL recomputation.
 *
 * @module server/services/cgroup-memory-metrics
 */

import { readFileSync } from "node:fs";

/** Anonymous memory charged to the cgroup. The sibling row (PEN-3314) owns this one. */
export const CGROUP_ANON_COMPONENT = "anon";
/**
 * Page cache charged to the cgroup.
 *
 * ⚠ **The node-level SIGN exclusion does not survive contact with this
 * instrument, and that is why the breakdown below exists.** (B) excluded page
 * cache as its driver because node `Cached` FELL 28.4 -> 19.2 GiB while the pod
 * residual climbed +5.0. That argument is about the NODE; this gauge is about
 * the one cgroup, and the two came apart the first time anyone could compare
 * them. In the first within-life climb measured here -- `paperclip-1`,
 * 2026-10-24T08:00Z -> 10-25T06:00Z, one pod life, +2.158 GiB of
 * `memory.current` -- `file` contributed **+1175.6 MiB (53.2%)**, the single
 * largest term, against `slab_reclaimable`'s +15.9 MiB (0.72%).
 *
 * ⛔ That is NOT a refutation of the 09-25..09-28 slab attribution and must not
 * be cited as one: this was a 3.78 GiB level, roughly a third of the 10.74 GiB
 * excursion, on a different pod. It is the reason the question is now worth
 * decomposing rather than assuming.
 */
export const CGROUP_FILE_COMPONENT = "file";
/**
 * Page cache on the inactive list -- the half that is CHEAP to reclaim.
 *
 * `file` alone cannot answer the question its own size now raises: a cgroup
 * sitting on gigabytes of cold, clean page cache is the kernel working as
 * designed and gives the memory back under pressure, while the same number in
 * dirty or mapped pages is headroom that is NOT available and is a different
 * defect. Splitting the dominant growth term is what tells those apart.
 */
export const CGROUP_INACTIVE_FILE_COMPONENT = "inactive_file";
/** Page cache on the active list. Reclaimed only after the inactive list is exhausted. */
export const CGROUP_ACTIVE_FILE_COMPONENT = "active_file";
/**
 * File pages mapped into page tables.
 *
 * These cannot simply be dropped while a process maps them, so this is the part
 * of `file` that behaves like a floor rather than like cache.
 */
export const CGROUP_FILE_MAPPED_COMPONENT = "file_mapped";
/** Dirty page cache. Must be written back before it can be reclaimed. */
export const CGROUP_FILE_DIRTY_COMPONENT = "file_dirty";
/**
 * Page cache under writeback right now.
 *
 * Named so that reclaim stalling on writeback is distinguishable from reclaim
 * having nothing to reclaim -- the two produce the same `memory.current` and
 * very different remedies.
 */
export const CGROUP_FILE_WRITEBACK_COMPONENT = "file_writeback";
/** Kernel memory total, inclusive of slab. */
export const CGROUP_KERNEL_COMPONENT = "kernel";
/** Kernel stacks. Scales with thread count, not with cache. */
export const CGROUP_KERNEL_STACK_COMPONENT = "kernel_stack";
/** Page tables. Scales with mapped address space. */
export const CGROUP_PAGETABLES_COMPONENT = "pagetables";
/** Socket buffers. Named so a network-buffer excursion is not misread as slab. */
export const CGROUP_SOCK_COMPONENT = "sock";
/**
 * Shared memory / tmpfs.
 *
 * Carried specifically to keep an exclusion checkable rather than remembered:
 * the pod's two emptyDirs (`runtime-cache` 20Gi, `runtime-config` 10Gi) set no
 * `medium: Memory`, so both are disk-backed and must NOT be charged here. A
 * non-zero reading refutes that and is a finding in its own right.
 */
export const CGROUP_SHMEM_COMPONENT = "shmem";
/**
 * ⭐ Reclaimable slab — dentry and inode cache. **This row's headline.**
 *
 * The quantity node-level correlation attributed the 09-25..09-28 excursion to,
 * now read against the one cgroup that matters. Growing until a cgroup limit
 * forces reclaim is the kernel working as designed; the defect is that this
 * cgroup's working set leaves it PINNED at its hard limit for days.
 */
export const CGROUP_SLAB_RECLAIMABLE_COMPONENT = "slab_reclaimable";
/** Unreclaimable slab. Excluded as the driver by MAGNITUDE (+0.6 vs +6.67 GiB). */
export const CGROUP_SLAB_UNRECLAIMABLE_COMPONENT = "slab_unreclaimable";
/** The kernel's own slab total. Published beside its parts, never derived from them. */
export const CGROUP_SLAB_COMPONENT = "slab";

/**
 * Keys read out of `memory.stat`, in published order.
 *
 * A key absent from this runtime's `memory.stat` is OMITTED from the snapshot
 * rather than zeroed, so the published series set names exactly what this kernel
 * could actually report.
 */
const STAT_COMPONENTS: readonly string[] = [
  CGROUP_ANON_COMPONENT,
  CGROUP_FILE_COMPONENT,
  CGROUP_INACTIVE_FILE_COMPONENT,
  CGROUP_ACTIVE_FILE_COMPONENT,
  CGROUP_FILE_MAPPED_COMPONENT,
  CGROUP_FILE_DIRTY_COMPONENT,
  CGROUP_FILE_WRITEBACK_COMPONENT,
  CGROUP_KERNEL_COMPONENT,
  CGROUP_KERNEL_STACK_COMPONENT,
  CGROUP_PAGETABLES_COMPONENT,
  CGROUP_SOCK_COMPONENT,
  CGROUP_SHMEM_COMPONENT,
  CGROUP_SLAB_RECLAIMABLE_COMPONENT,
  CGROUP_SLAB_UNRECLAIMABLE_COMPONENT,
  CGROUP_SLAB_COMPONENT,
];

/**
 * Keys that identify the file as cgroup **v2**.
 *
 * Positive identification, not a v1 blocklist: a file that does not carry these
 * is refused whatever it is. `anon` and `file` are v2 spellings — cgroup v1 calls
 * the same quantities `rss` and `cache` — and `slab_reclaimable` is the field
 * this row exists to read, so a "v2" file without it has nothing to offer here
 * anyway.
 */
const V2_REQUIRED_KEYS: readonly string[] = [
  CGROUP_ANON_COMPONENT,
  CGROUP_FILE_COMPONENT,
  CGROUP_SLAB_RECLAIMABLE_COMPONENT,
];

/** Default cgroup v2 mount point. */
const CGROUP_ROOT = "/sys/fs/cgroup";

/** Where the kernel reports this process's cgroup membership. */
const PROC_SELF_CGROUP = "/proc/self/cgroup";

export interface CgroupMemorySnapshot {
  /** `memory.stat` components, keyed by the label value published for each. */
  readonly components: ReadonlyMap<string, number>;
  /**
   * `memory.current`. Never `null`: it is REQUIRED, and an unreadable one makes
   * the whole snapshot `null` (see {@link collectCgroupMemorySnapshot}), because
   * its absence is what tells our own cgroup apart from the v2 root.
   */
  readonly currentBytes: number;
  /** `memory.max`, or `null` when unreadable OR unlimited (literal `max`). */
  readonly maxBytes: number | null;
  /** `memory.peak` high-water mark, or `null` when unreadable. */
  readonly peakBytes: number | null;
}

export interface CollectCgroupMemoryOptions {
  /** Injected for tests. Must throw on an unreadable path, as `readFileSync` does. */
  readonly readFile?: (path: string) => string;
  /** Override the cgroup mount root. */
  readonly cgroupRoot?: string;
  /** Override the `/proc/self/cgroup` path. Injected for tests. */
  readonly procSelfCgroup?: string;
}

/**
 * Accept a reading only if it is a finite, non-negative number.
 *
 * Byte counts cannot be negative, so a negative parse is a malformed file rather
 * than a small value, and publishing it would put a nonsense point on a trend
 * line that an operator reads as real.
 */
function parseBytes(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  // `Number("")` is 0 and `Number("12 34")` is NaN; the explicit empty check
  // above handles the first, and NaN fails `isFinite` below.
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0) return null;
  return value;
}

/**
 * Read one cgroup file, returning `null` rather than throwing.
 *
 * Every caller treats `null` as "not measurable here", which is the behaviour
 * this module is built around: absence must never be renderable as zero.
 */
function readOptional(read: (path: string) => string, path: string): string | null {
  try {
    return read(path);
  } catch {
    return null;
  }
}

/** Parse `key value` lines into a map. Malformed lines are skipped, not fatal. */
function parseStatFile(contents: string): Map<string, number> {
  const parsed = new Map<string, number>();
  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const separator = trimmed.indexOf(" ");
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator);
    const value = parseBytes(trimmed.slice(separator + 1));
    if (value === null) continue;
    parsed.set(key, value);
  }
  return parsed;
}

/**
 * Resolve the directory holding *this process's* cgroup interface files.
 *
 * `/proc/self/cgroup` on a v2 host is a single line `0::<path>`, where `<path>`
 * is relative to the cgroup root **as this process's namespace sees it**. Under
 * the private namespace Kubernetes gives a pod by default that is `/`, so the
 * mount root is already ours. Under `cgroupns=host` it is the full path
 * (`/kubepods/burstable/pod…/…`), and the mount root is the HOST root — reading
 * it would report the whole node.
 *
 * Returns the mount root unchanged when the file is unreadable or not v2-shaped.
 * That is deliberately permissive rather than fatal: it is the status quo for
 * every runtime where this already worked, and the required `memory.current`
 * check in {@link collectCgroupMemorySnapshot} is the backstop that refuses a
 * root read. Keeping the refusal there stops a parsing quirk here from silently
 * disabling the whole instrument.
 *
 * Returns `null` — "unresolvable, publish nothing" — for exactly one input: a
 * path containing a `..` segment. The discriminator is **positive evidence that
 * the mount root is not ours**, not mere malformedness. The kernel emits `../`
 * when a process sits OUTSIDE its own cgroup namespace root (migrated after an
 * `unshare`), and in that case the mount root is a *non-root* cgroup belonging
 * to someone else: it has a `memory.current`, so the backstop does NOT fire, and
 * falling back to it would publish another cgroup's charge as ours. That is the
 * same confident-wrong-answer class this module exists to prevent, so it is the
 * one case worth failing closed for, and it is tested before the absolute-path
 * check so that a malformed path carrying `..` is still refused. (The `""` and
 * `"/"` early returns precede it, which is harmless: neither can contain a `..`
 * segment.) Every other odd reading — unreadable file, v1-only lines, a
 * non-absolute path with no `..` — is merely unverified rather than known
 * wrong, and stays fail-open.
 */
function resolveCgroupDir(
  read: (path: string) => string,
  root: string,
  procSelfCgroup: string,
): string | null {
  const contents = readOptional(read, procSelfCgroup);
  if (contents === null) return root;
  for (const line of contents.split("\n")) {
    // v2 is the unified hierarchy, always controller-list-empty: `0::<path>`.
    // A v1 line (`N:controllers:<path>`) is skipped rather than parsed; this
    // module publishes nothing on v1 anyway.
    if (!line.startsWith("0::")) continue;
    const path = line.slice(3).trim();
    if (path === "" || path === "/") return root;
    // Known wrong, not merely malformed: we are outside our namespace root, so
    // the mount root is someone else's cgroup. Refuse rather than fall back.
    if (path.split("/").includes("..")) return null;
    // Malformed but not evidence of anything. Fall back to the mount root and
    // let the required `memory.current` check decide.
    if (!path.startsWith("/")) return root;
    return `${root}${path}`;
  }
  return root;
}

/**
 * Read the cgroup memory accounting.
 *
 * Returns `null` when the cgroup is not measurable at all — `memory.stat`
 * unreadable (not running under cgroup v2, or the mount is hidden), or readable
 * but not v2-shaped. The caller publishes NOTHING in that case rather than
 * zeroes; see the module docblock for why that distinction is the point of the
 * module rather than a nicety.
 */
export function collectCgroupMemorySnapshot(
  options: CollectCgroupMemoryOptions = {},
): CgroupMemorySnapshot | null {
  const read = options.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  const mountRoot = options.cgroupRoot ?? CGROUP_ROOT;
  const procSelfCgroup = options.procSelfCgroup ?? PROC_SELF_CGROUP;
  // NOT necessarily the mount root -- see the docblock. Under `cgroupns=host`
  // the mount root is the host's root cgroup, and reading it would publish
  // node-wide slab as this cgroup's charge.
  const root = resolveCgroupDir(read, mountRoot, procSelfCgroup);
  // `null` means the resolver has positive evidence the mount root is NOT ours
  // (a `..` segment). Unlike a root read, that cgroup would have a
  // `memory.current`, so the backstop below cannot catch it. Publish nothing.
  if (root === null) return null;

  const statContents = readOptional(read, `${root}/memory.stat`);
  // No `memory.stat` at all: not under cgroup v2, or the mount is not visible.
  // Nothing further is worth reading, and nothing is published.
  if (statContents === null) return null;

  const stat = parseStatFile(statContents);
  // Refuse a file that is not v2-shaped rather than parsing it as an empty v2
  // one. A cgroup v1 `memory.stat` parses cleanly here and yields none of the
  // keys below -- which, without this guard, would publish a complete set of
  // confident zeroes including `slab_reclaimable 0`.
  if (!V2_REQUIRED_KEYS.every((key) => stat.has(key))) return null;

  const components = new Map<string, number>();
  for (const key of STAT_COMPONENTS) {
    const value = stat.get(key);
    // Omit, never zero: the published set names what this kernel reports.
    if (value === undefined) continue;
    components.set(key, value);
  }

  const currentBytes = parseBytes(readOptional(read, `${root}/memory.current`) ?? undefined);
  // REQUIRED, and the backstop against reporting the whole node. The cgroup v2
  // ROOT has a v2-shaped `memory.stat` -- it passes every check above -- but the
  // memory controller creates no `memory.current` there. So an unreadable
  // `memory.current` means either "this is the root" or "the memory controller
  // is not enabled here", and in both cases the components just parsed describe
  // something other than this process's own charge. Publish nothing.
  if (currentBytes === null) return null;

  const peakBytes = parseBytes(readOptional(read, `${root}/memory.peak`) ?? undefined);

  // `memory.max` is the literal string `max` when no limit is set. `parseBytes`
  // returns null for it, which is the behaviour we want and is reached without a
  // special case -- but it is spelled out here because the alternatives are both
  // actively harmful: 0 reads as a zero-byte limit, and `Infinity` renders as
  // `+Inf` and silently poisons any `current / max` ratio.
  const maxBytes = parseBytes(readOptional(read, `${root}/memory.max`) ?? undefined);

  // `memory.stat` was v2-shaped, so the components map is non-empty by
  // construction (the required keys are themselves published components), and
  // `currentBytes` is non-null by the guard above. `maxBytes` and `peakBytes`
  // stay independently optional.
  return { components, currentBytes, maxBytes, peakBytes };
}
