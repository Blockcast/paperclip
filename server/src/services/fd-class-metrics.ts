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
 * Cardinality is bounded on three independent axes, because the hypothesis
 * this instrument tests is "something accumulates per poll pass" and the
 * obvious naive implementation — label by full dirname — would itself
 * accumulate one series per run directory. Path *depth*
 * ({@link FD_CLASS_PATH_SEGMENTS}), each segment's *alphabet*
 * ({@link FD_CLASS_VOLATILE_SEGMENT}), and the published *series count*
 * ({@link FD_CLASS_MAX_SERIES}). Depth and alphabet are not redundant: depth
 * stops an identifier only when enough stable segments precede it, and this
 * repo creates two per-run trees where it does not.
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
 * state; beyond it the remainder is reported as a single
 * `unclassified-truncated` series rather than silently dropped, so the class
 * counts always sum to the true total.
 *
 * What the cap costs at full engagement, measured on a Linux container rather
 * than estimated: 33 fds → 0.33 ms, 4033 fds → 43.7 ms (median of 7), i.e.
 * ~10.8 µs per descriptor. These are synchronous syscalls on the event loop, so
 * that 43 ms blocks every other request for its duration — "no I/O wait" is not
 * the same as "does not block", and an earlier version of this comment claimed
 * a sub-millisecond walk, which was wrong by ~40x. It is admissible anyway
 * because the cost is a bounded constant amortised over the scrape interval:
 * once per 15 s is a ~0.3% duty cycle, far inside BLO-33243's 10 s budget. The
 * bound is what makes that true, which is why it is a constant and not a
 * fraction of the table.
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
 *
 * ⚠ Depth alone does NOT bound the label alphabet, and that gap was real: the
 * identifier's *position* varies per tree, so a tree with fewer than 4 stable
 * leading segments carries its identifier inside the depth bound. Two paths
 * this repo creates per-run do exactly that —
 * `fs.mkdtemp(/tmp/paperclip-run-<issue>-<run>-)` (`run-scratch.ts`, once per
 * heartbeat run on the worker tier) sits at depth 2, and
 * `/runtime-cache/paperclip-runs/<runId>/workspace` puts the run id at depth 3.
 * {@link FD_CLASS_MAX_SERIES} does not save this: it bounds series *per
 * scrape*, not distinct label values *over time*, which is what mints
 * Prometheus series — and the leaking class is by construction the top class,
 * so it is guaranteed past the cap and guaranteed to mint one series per run.
 * {@link boundedSegment} closes it by bounding the alphabet as well.
 */
export const FD_CLASS_PATH_SEGMENTS = 4;

/**
 * Stand-in for a path segment that failed {@link boundedSegment}'s stability
 * test. Retained in place rather than truncated away so the label still names
 * the *shape* of the tree — `/runtime-cache/paperclip-runs/*​/workspace` names
 * a code site, where truncating at the identifier would collapse every
 * per-run tree into the same two segments.
 */
export const FD_CLASS_VOLATILE_SEGMENT = "*";

/**
 * Hard ceiling on the verbatim prefix {@link boundedSegment} will rebuild.
 *
 * Shape-rejection alone leaves one residual: a name whose every token is
 * individually stable rebuilds at whatever length it happens to be. 32 is
 * comfortably above every real directory name in this repo's trees
 * (`x86_64-linux-gnu` is 16, `instances` 9) while keeping each published label
 * segment bounded by a constant.
 */
export const FD_CLASS_MAX_SEGMENT_CHARS = 32;

/** Class assigned when `readlink` races the descriptor being closed (`ENOENT`). */
export const FD_CLASS_VANISHED = "vanished";
/** Class carrying the count of descriptors skipped by {@link FD_CLASS_MAX_ENTRIES}. */
export const FD_CLASS_TRUNCATED = "unclassified-truncated";
/**
 * Class assigned to a descriptor that could not be classified. Three distinct
 * causes land here, and the label names none of them, so a non-zero count is a
 * prompt to look rather than a diagnosis:
 *   - `readlink` failed for any reason other than `ENOENT` (the race, which is
 *     {@link FD_CLASS_VANISHED});
 *   - the target read back empty;
 *   - the target is a non-path form whose prefix fails the subtype alphabet,
 *     i.e. a kernel prefix this code does not recognise.
 * Widened from naming only the first: an investigator told to look for a
 * failing `readlink` will not find one when the cause was an unrecognised
 * prefix.
 */
export const FD_CLASS_UNREADABLE = "unreadable";
/**
 * Sentinel published when the descriptor *table itself* could not be
 * enumerated on a host that has procfs — `EACCES` under a restricted `/proc`,
 * `ENOMEM`, or anything else the kernel raises that is not "no such directory".
 *
 * Deliberately not {@link FD_CLASS_UNREADABLE}: that one counts descriptors
 * this code looked at and could not classify, and folding a whole-table failure
 * into it would conflate "240 descriptors, 3 unclassifiable" with "no idea, the
 * walk never ran". The value is always 0 — nothing was inspected, so the
 * partition still sums to a total of 0 — and it is the series' *presence* that
 * carries the signal: the instrument is deployed and failing. Absence of the
 * whole metric then keeps meaning exactly one thing, that this host has no
 * procfs to read.
 */
export const FD_CLASS_TABLE_UNREADABLE = "table-unreadable";
/** Fold bucket for classes past {@link FD_CLASS_MAX_SERIES}. */
export const FD_CLASS_OTHER = "other";

/**
 * Kernel anonymous-inode subtypes are a small fixed set (`[eventpoll]`,
 * `[eventfd]`, `[timerfd]`, `[inotify]`, `[signalfd]`, `bpf-map`, ...), but they
 * arrive as text read out of procfs, so they are constrained rather than
 * trusted: the subtype is kept only if it is short and drawn from a closed
 * alphabet. Anything else collapses to the bare `anon_inode` class. This keeps
 * the label alphabet closed without having to enumerate kernel versions.
 *
 * `-` is admitted because real kernel subtypes use it (`bpf-map`, `bpf-prog`,
 * `bpf-link`); excluding it collapsed those to bare `anon_inode` and also made
 * the `bpf-map:` example in {@link classifyFdTarget} describe behaviour the
 * code did not have.
 */
const ANON_INODE_SUBTYPE = /^[a-z_-]{1,24}$/;

/** Suffix procfs appends when the target has been unlinked. */
const DELETED_SUFFIX = " (deleted)";

/** Separators that compound directory names use (`runtime-cache`, `node_modules`, `kubernetes.io`). */
const SEGMENT_TOKEN_SEPARATORS = /([-_.])/;

/**
 * Decide whether one `-`/`_`/`.`-delimited token of a path segment is stable
 * enough to publish verbatim.
 *
 * Inverted deliberately: this rejects *identifier shapes* rather than
 * allowlisting known-good directory names. An allowlist fails silently in the
 * expensive direction — a new stable path appears, matches nothing, and the
 * whole class folds to `other`, which is precisely the naming power this
 * instrument exists for. Rejecting shapes degrades the other way: an
 * unrecognised-but-stable name keeps working, and only identifier-looking
 * tokens are redacted.
 *
 * A token is volatile when it:
 *   - contains an uppercase letter — mkdtemp's random suffix (`XyZ9aB`) and
 *     issue keys (`BLO-38624`) both carry one, and no directory this repo
 *     creates deliberately does;
 *   - contains a digit *and* is ≥4 characters — hex chunks (`b1d3f3d3`,
 *     `013a18368d84`, `adc9`) and numeric ids (`38624`). The length floor is
 *     what keeps genuinely stable short names like `v1`, `s3`, `d0` and the
 *     `x86`/`64` of `x86_64` intact;
 *   - is ≥4 characters drawn entirely from `[0-9a-f]` — the digit rule alone
 *     lets an all-letter hex chunk through, and about 1 `randomUUID()` in 2,600
 *     opens with eight hex letters (`abcdefab-…`). Costs only all-hex-letter
 *     names (`cafe`, `facade`); this repo creates none;
 *   - exceeds 24 characters, as a backstop for an encoding this does not
 *     anticipate.
 */
function isStableSegmentToken(token: string): boolean {
  if (token.length === 0 || token.length > 24) return false;
  if (/[A-Z]/.test(token)) return false;
  if (token.length >= 4 && /[0-9]/.test(token)) return false;
  if (token.length >= 4 && /^[0-9a-f]+$/.test(token)) return false;
  return true;
}

/**
 * Reduce one path segment to its stable prefix, replacing the first
 * identifier-shaped token and everything after it with
 * {@link FD_CLASS_VOLATILE_SEGMENT}.
 *
 * `paperclip-run-BLO-38624-abc123def456-XyZ9aB` → `paperclip-run-*`, which is
 * one label for every run rather than one per run, while still naming the
 * scratch-directory code site. A segment that is wholly identifier-shaped
 * (a bare UUID) reduces to `*` on its own, and a segment with no volatile
 * token at all is returned untouched.
 *
 * {@link FD_CLASS_MAX_SEGMENT_CHARS} bounds label *length*, not label
 * *cardinality*, and the gap between those is the residual. A segment whose
 * tokens are each individually stable still rebuilds verbatim, so a churning
 * directory named from lowercase non-hex tokens mints one series per run while
 * sitting well inside the cap: measured, 60,000 `/srv/sess-<12 lowercase
 * non-hex>/f` paths give 60,000 distinct labels, every segment 17 characters.
 * Nothing this repo generates has that shape (run ids are hex, issue keys are
 * uppercase, mkdtemp suffixes are mixed alnum), and each of those collapses to
 * exactly 1 label over 60,000 samples. So the alphabet is bounded for every
 * shape this repo generates, not unconditionally — the cap is a backstop that
 * keeps an unanticipated shape's label *short*, not a guarantee it stays
 * single.
 */
function boundedSegment(segment: string): string {
  // A leading dot is part of the name (`.pnpm`, `.cache`, `.git`), not a
  // separator introducing an empty first token.
  const dotted = segment.startsWith(".");
  const body = dotted ? segment.slice(1) : segment;
  if (isStableSegmentToken(body)) return segment;

  const parts = body.split(SEGMENT_TOKEN_SEPARATORS);
  let prefix = "";
  let redacted = false;
  // Budget every character that can reach the emitted label, not just the
  // tokens: the leading dot, the separator appended alongside each token, and
  // the redaction marker. Charging only `prefix + token` let the result settle
  // two over — measured, `wwwww-xxxxx-yyyyy-zzzzz-ssssssss-ZZ` reduced to a
  // 34-character segment against a stated ceiling of 32, so the constant did
  // not mean its name and a future reader sizing anything against it would be
  // wrong. Reserving the marker up front can redact an all-stable compound of
  // 31-32 characters that previously survived verbatim; that is the cost of
  // making the bound true by construction, and it is paid in label precision
  // for a shape this repo does not generate.
  const prefixBudget =
    FD_CLASS_MAX_SEGMENT_CHARS - (dotted ? 1 : 0) - FD_CLASS_VOLATILE_SEGMENT.length;
  // Even indices are tokens, odd indices the separator that followed them; the
  // separator is kept so the stable prefix rebuilds verbatim.
  for (let i = 0; i < parts.length; i += 2) {
    const token = parts[i] ?? "";
    const separator = parts[i + 1] ?? "";
    if (!isStableSegmentToken(token) || prefix.length + token.length + separator.length > prefixBudget) {
      redacted = true;
      break;
    }
    prefix += token + separator;
  }
  // Every token stable — a compound name like `x86_64-linux-gnu` that only
  // failed the whole-segment test because of its separators. Keep it verbatim
  // rather than appending a marker for a redaction that did not happen.
  if (!redacted) return segment;
  return `${dotted ? "." : ""}${prefix}${FD_CLASS_VOLATILE_SEGMENT}`;
}

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
 *
 * Depth is bounded first, then each surviving segment's *alphabet* — see
 * {@link boundedSegment}. Both are required: depth alone leaves an identifier
 * in the label whenever it sits shallower than {@link FD_CLASS_PATH_SEGMENTS},
 * and alphabet alone would let an arbitrarily deep tree mint a long label.
 */
function boundedDirLabel(absolutePath: string): string {
  const segments = absolutePath.split("/").filter((segment) => segment.length > 0);
  // Drop the basename to get the directory, then bound the depth.
  const dirSegments = segments.slice(0, Math.max(0, segments.length - 1));
  const kept = dirSegments.slice(0, FD_CLASS_PATH_SEGMENTS).map(boundedSegment);
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
  //
  // ⚠ Not authenticated, and this class is the one an investigator leans on
  // hardest. procfs appends " (deleted)" to an unlinked target, but a LIVE file
  // whose name simply ends in that text readlinks identically — verified: a
  // real, non-deleted `/tmp/s2/evil (deleted)` is indistinguishable here from a
  // deleted `/tmp/s2/evil`. Agents write arbitrary filenames into workspaces,
  // so `deleted:<dir>` can be inflated by a filename alone. Inherent to procfs
  // rather than fixable here; it is called out in the gauge `help` too.
  const deleted = raw.endsWith(DELETED_SUFFIX);
  const path = deleted ? raw.slice(0, -DELETED_SUFFIX.length) : raw;

  if (path.startsWith("socket:")) return "socket";
  if (path.startsWith("pipe:")) return "pipe";
  // Both spellings, and before the `/`-prefixed path branch below, because the
  // kernel emits the *slashed* one: verified on a live Linux kernel,
  // `memfd_create("paperclip-heap")` readlinks to `/memfd:paperclip-heap
  // (deleted)`. Matching only the bare form let every memfd fall through to the
  // path branch, lose its basename and land in `deleted:/` — contaminating the
  // one class documented as the classic leak signature, which is the sharpest
  // discriminator this instrument has. The bare form is kept because procfs
  // has emitted it and it costs nothing to accept.
  if (path.startsWith("memfd:") || path.startsWith("/memfd:")) return "memfd";
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
 * Returns `null` only where there is no procfs to read — macOS dev machines and
 * any non-Linux CI runner, which surface as `ENOENT`/`ENOTDIR` on the directory
 * itself. A null return means "not measurable here", which is why the caller
 * publishes nothing rather than zeroes: a zeroed gauge on a platform that
 * cannot see descriptors would read identically to a process that has none.
 *
 * Every *other* errno is a Linux host whose table we failed to enumerate, and
 * that is reported as {@link FD_CLASS_TABLE_UNREADABLE} rather than folded into
 * the same `null`. Collapsing the two would tell an investigator on a Linux pod
 * that the instrument is not deployed at the moment it is deployed and broken —
 * the same "unmeasurable is distinct from zero" conflation this module exists
 * to avoid, one level up. This mirrors the `ENOENT`-vs-everything-else branch
 * the per-descriptor `readlink` path below already makes.
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
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    return { classes: new Map([[FD_CLASS_TABLE_UNREADABLE, 0]]), total: 0 };
  }

  const raw = new Map<string, number>();
  const bump = (fdClass: string): void => {
    raw.set(fdClass, (raw.get(fdClass) ?? 0) + 1);
  };

  const inspected = entries.length > maxEntries
    // Numeric sort before slicing, because `readdirSync` on procfs returns
    // LEXICOGRAPHIC order (measured under Node: `0,1,10,11,…,2,20,21,3`) — note
    // the kernel itself iterates numerically, so this is Node's ordering, not
    // procfs's, and sampling it in Python shows numeric order and hides the
    // problem. Without the sort the cap takes a prefix biased toward low
    // leading digits rather than the lowest-numbered descriptors, and it does
    // so exactly when truncation engages — i.e. in the leak scenario this
    // exists to describe, where a biased sample of the table is the one thing
    // it must not report. The partition stays correct either way; what the sort
    // buys is that the truncation boundary means what the comment says.
    ? [...entries].sort((a, b) => Number(a) - Number(b)).slice(0, maxEntries)
    : entries;
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
