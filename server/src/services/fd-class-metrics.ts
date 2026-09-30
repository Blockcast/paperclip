/**
 * @fileoverview Classify the process's open file descriptors by what they point
 * at, so a descriptor leak can be attributed without a heap snapshot (PEN-3314).
 *
 * Why this exists rather than "take a heap snapshot and read it": on the
 * leaking worker (`paperclip-0`), measured 2026-09-30 over the pre/post windows
 * of the 09-27T19Z→09-28T07Z step,
 *
 *   - `process_open_fds` climbs at +0.323/h then +1.254/h (R² 0.822 / 0.933),
 *   - `nodejs_heap_size_used_bytes` floor climbs at +1.845 then +5.769 MB/h,
 *   - `nodejs_active_handles_total` is FLAT in both regimes (R² 0.000, mean ~89).
 *
 * Handles being flat while descriptors climb is the useful part.
 * `nodejs_active_handles_total` is `process._getActiveHandles()`, which counts
 * sockets, timers and streams — so the accumulating descriptors are *not*
 * registered libuv handles. That excludes leaked sockets/timers/streams and
 * points at raw descriptors: an `fs.open` never closed, or one held by native
 * code. This module names which, by reading the one authority that already
 * knows — procfs.
 *
 * ⛔ This is an INSTRUMENT, not an alert. `process_max_fds` is 524288 against a
 * current `process_open_fds` of ~240; at +1.25/h the descriptor count is not a
 * failure mode and will not become one before the heap SIGABRTs. Do not page on
 * it. Its value is that it is a *cheap, in-process, already-scraped* signal that
 * co-moves with the heap (detrended r = +0.682, first-difference r = +0.445,
 * n=229) while concurrent run count does not (first-difference r = +0.014).
 *
 * Cardinality is bounded three ways, because the hypothesis this instrument
 * tests is "something accumulates per poll pass" and the obvious naive
 * implementation — label by full dirname — would itself accumulate one series
 * per run directory. See {@link FD_CLASS_PATH_SEGMENTS} and
 * {@link FD_CLASS_MAX_SERIES}.
 *
 * @module server/services/fd-class-metrics
 */

import { readdirSync, readlinkSync } from "node:fs";

/** procfs view of this process's descriptor table. Linux-only by construction. */
export const PROC_SELF_FD = "/proc/self/fd";

/**
 * Hard cap on descriptors inspected per refresh.
 *
 * This runs synchronously on the `/metrics` request path, so the cost must be
 * bounded by a constant rather than by however many descriptors the process has
 * managed to leak — the one scenario in which this code runs is the one in
 * which that number is growing without limit. 4096 is ~17x the observed steady
 * state and still a sub-millisecond procfs walk; beyond it the remainder is
 * reported as a single `unclassified-truncated` series rather than silently
 * dropped, so the class counts always sum to the true total.
 */
export const FD_CLASS_MAX_ENTRIES = 4096;

/**
 * Maximum distinct `fd_class` label values published per scrape. Everything
 * past the top N-1 by count folds into `other`.
 *
 * A fold rather than a drop: the sum across classes stays equal to the number
 * of descriptors inspected, so `other` climbing is itself readable as "the leak
 * is in the long tail" instead of looking like descriptors vanishing.
 */
export const FD_CLASS_MAX_SERIES = 24;

/**
 * Path segments retained from a file descriptor's target directory.
 *
 * 4 is chosen against this repo's actual layout, not arbitrarily:
 * `/paperclip/instances/default/projects/<company>/<project>/<repo>/...`
 * truncates to `/paperclip/instances/default/projects`, which names the code
 * site class (project workspaces) while stopping one segment short of the
 * company UUID. Going deeper would label by identifiers that churn per run —
 * re-creating, in the leak detector, the unbounded-cardinality failure this
 * row already falsified once as a *cause* of the leak.
 */
export const FD_CLASS_PATH_SEGMENTS = 4;

/** Class assigned when `readlink` races the descriptor being closed (`ENOENT`). */
export const FD_CLASS_VANISHED = "vanished";
/** Class carrying the count of descriptors skipped by {@link FD_CLASS_MAX_ENTRIES}. */
export const FD_CLASS_TRUNCATED = "unclassified-truncated";
/** Class assigned when `readlink` fails for any reason other than `ENOENT`. */
export const FD_CLASS_UNREADABLE = "unreadable";
/** Fold bucket for classes past {@link FD_CLASS_MAX_SERIES}. */
export const FD_CLASS_OTHER = "other";

/**
 * Kernel anonymous-inode subtypes are a small fixed set (`[eventpoll]`,
 * `[eventfd]`, `[timerfd]`, `[inotify]`, `[signalfd]`, ...), but they arrive as
 * text read out of procfs, so they are constrained rather than trusted: the
 * subtype is kept only if it is short and lowercase-alphabetic. Anything else
 * collapses to the bare `anon_inode` class. This keeps the label alphabet
 * closed without having to enumerate kernel versions.
 */
const ANON_INODE_SUBTYPE = /^[a-z_]{1,24}$/;

/** Suffix procfs appends when the target has been unlinked. */
const DELETED_SUFFIX = " (deleted)";

/**
 * Reduce an absolute path to a bounded directory label.
 *
 * Operates on the *directory*, not the file: one leaked descriptor per log file
 * would otherwise produce one label per file, and the question this answers is
 * "which code site", not "which inode".
 *
 * Dropping the basename is also what keeps this safe to publish. Paths reach
 * Prometheus, and a filename can carry a token, a run id or a customer name
 * where a depth-bounded directory cannot — `/var/run/secrets/…/token` becomes
 * `/var/run/secrets/kubernetes.io`, which names a mount, not a credential. The
 * basename is discarded unconditionally, before any depth logic, so no path
 * shape can route one into a label.
 */
function boundedDirLabel(absolutePath: string): string {
  const segments = absolutePath.split("/").filter((segment) => segment.length > 0);
  // Drop the basename to get the directory, then bound the depth.
  const dirSegments = segments.slice(0, Math.max(0, segments.length - 1));
  const kept = dirSegments.slice(0, FD_CLASS_PATH_SEGMENTS);
  return `/${kept.join("/")}`;
}

/**
 * Map one `readlink("/proc/self/fd/N")` result to a bounded class label.
 *
 * Exported for direct testing: the classification, not the directory walk, is
 * where this can silently go wrong.
 */
export function classifyFdTarget(target: string): string {
  const raw = target.trim();
  if (raw.length === 0) return FD_CLASS_UNREADABLE;

  // An fd still held on an unlinked file is the classic leak signature, so it
  // gets its own prefix rather than being folded in with live files — a leak
  // that only shows up here is a much narrower search than one that does not.
  const deleted = raw.endsWith(DELETED_SUFFIX);
  const path = deleted ? raw.slice(0, -DELETED_SUFFIX.length) : raw;

  if (path.startsWith("socket:")) return "socket";
  if (path.startsWith("pipe:")) return "pipe";
  if (path.startsWith("memfd:")) return "memfd";
  if (path.startsWith("anon_inode:")) {
    const subtype = path.slice("anon_inode:".length).replace(/^\[|\]$/g, "");
    return ANON_INODE_SUBTYPE.test(subtype) ? `anon_inode:${subtype}` : "anon_inode";
  }
  if (!path.startsWith("/")) {
    // Anything else procfs can report (`bpf-map:`, future kernel prefixes) is
    // bucketed by its prefix rather than dropped, so an unrecognized class is
    // visible as itself instead of hiding inside `other`.
    const prefix = path.split(":", 1)[0] ?? "";
    return ANON_INODE_SUBTYPE.test(prefix) ? prefix : FD_CLASS_UNREADABLE;
  }

  const dir = boundedDirLabel(path);
  return deleted ? `deleted:${dir}` : `file:${dir}`;
}

export interface FdClassSnapshot {
  /** Class label -> descriptor count. Already folded to {@link FD_CLASS_MAX_SERIES}. */
  classes: ReadonlyMap<string, number>;
  /** Descriptors present in the table, including any beyond {@link FD_CLASS_MAX_ENTRIES}. */
  total: number;
}

export interface CollectFdClassOptions {
  dir?: string;
  readdir?: (dir: string) => string[];
  readlink?: (path: string) => string;
  maxEntries?: number;
  maxSeries?: number;
}

/**
 * Fold a raw class histogram down to at most `maxSeries` entries.
 *
 * Ties break on the class name so the published set is stable across scrapes
 * with equal counts — otherwise two classes at the same value would trade
 * places between scrapes and each would look like it was appearing and
 * disappearing.
 */
function foldToSeriesCap(raw: Map<string, number>, maxSeries: number): Map<string, number> {
  if (raw.size <= maxSeries) return raw;
  const ranked = [...raw.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const kept = new Map(ranked.slice(0, Math.max(0, maxSeries - 1)));
  let folded = 0;
  for (const [, count] of ranked.slice(Math.max(0, maxSeries - 1))) folded += count;
  kept.set(FD_CLASS_OTHER, (kept.get(FD_CLASS_OTHER) ?? 0) + folded);
  return kept;
}

/**
 * Read and classify the descriptor table.
 *
 * Returns `null` where procfs is unavailable — macOS dev machines and any
 * non-Linux CI runner. A null return means "not measurable here", which is why
 * the caller publishes nothing rather than zeroes: a zeroed gauge on a platform
 * that cannot see descriptors would read identically to a process that has none.
 */
export function collectFdClassSnapshot(options: CollectFdClassOptions = {}): FdClassSnapshot | null {
  const dir = options.dir ?? PROC_SELF_FD;
  const readdir = options.readdir ?? ((target: string) => readdirSync(target));
  const readlink = options.readlink ?? ((target: string) => readlinkSync(target));
  const maxEntries = options.maxEntries ?? FD_CLASS_MAX_ENTRIES;
  const maxSeries = options.maxSeries ?? FD_CLASS_MAX_SERIES;

  let entries: string[];
  try {
    entries = readdir(dir);
  } catch {
    return null;
  }

  const raw = new Map<string, number>();
  const bump = (fdClass: string): void => {
    raw.set(fdClass, (raw.get(fdClass) ?? 0) + 1);
  };

  const inspected = entries.length > maxEntries ? entries.slice(0, maxEntries) : entries;
  for (const entry of inspected) {
    let target: string;
    try {
      target = readlink(`${dir}/${entry}`);
    } catch (err) {
      // Expected at a rate of roughly one per call: `readdir` opens a
      // descriptor to enumerate the table and closes it before these
      // `readlink`s run, so its own number is listed and then gone. Measured
      // on a live node process, exactly one ENOENT per call. Counting it as a
      // class keeps the sum honest and makes a *rising* `vanished` count —
      // which would mean genuine churn, not this artifact — visible.
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      bump(code === "ENOENT" ? FD_CLASS_VANISHED : FD_CLASS_UNREADABLE);
      continue;
    }
    bump(classifyFdTarget(target));
  }

  if (entries.length > inspected.length) {
    raw.set(FD_CLASS_TRUNCATED, entries.length - inspected.length);
  }

  return { classes: foldToSeriesCap(raw, maxSeries), total: entries.length };
}
