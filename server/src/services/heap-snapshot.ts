import { existsSync, mkdirSync, readdirSync, renameSync, statSync, statfsSync, unlinkSync } from "node:fs";
import path from "node:path";
import { writeHeapSnapshot } from "node:v8";

/**
 * On-demand V8 heap snapshots for the worker tier (PEN-3631).
 *
 * PEN-3314 tracks a live heap leak on `paperclip-0` whose cause is unattributed:
 * the *floor* of `nodejs_heap_size_used_bytes` climbs while load is flat, so the
 * retained objects are genuinely reachable and no metric we emit today names the
 * allocation. A snapshot *diff* does name it, and nothing in this repo could take
 * one — there is no `writeHeapSnapshot`, no `--heapsnapshot-signal`, no inspector.
 *
 * The blocker was believed to be retrieval (`pods/exec`, which no seat holds). It
 * is not: the worker and every agent pod mount the same ReadWriteMany CephFS claim
 * (`paperclip-data`) read-write, so a file written under the Paperclip instance
 * root is readable from an ordinary agent seat with no privilege change at all.
 * That makes the shared volume both the retrieval channel and — via a sentinel
 * file — the *trigger* channel, which is why this is a filesystem poll and not a
 * new authenticated admin route on the worker.
 *
 * Capture is inert unless `PAPERCLIP_HEAP_SNAPSHOT_ENABLED=true`. *Retention is
 * not* — see below.
 *
 * Snapshots are large (roughly 1.5-2x the used heap) and the shared volume is
 * also every agent's home directory, so both a retention cap and a free-space
 * precondition are load-bearing rather than tidiness.
 *
 * ## A snapshot is a secret, and its lifetime is the only control we have
 *
 * `writeHeapSnapshot` serialises every reachable string, and `loadConfig()`
 * reads this process's secrets out of the environment into exactly such strings
 * (`githubAppPrivateKey` is a required field). Measured, not assumed: a value
 * read from the environment onto a live object is present verbatim in the
 * resulting file, while one left undereferenced is not.
 *
 * The obvious mitigation does not exist here. On the deployed cluster the
 * worker and every agent pod run as the *same uid* against the same RWX claim,
 * so no file mode separates them — 0600 owned by 1000 is readable by uid 1000
 * in another pod. The retrieval property this feature is built on ("readable
 * from any agent seat with no privilege change") is the identical mechanism.
 *
 * What is left is *how long* the file exists, which is why `maxAgeMs` is a
 * security bound rather than a disk-tidiness setting, and why the caller must
 * keep pruning even when capture is disabled. Gating the prune on the feature
 * flag — as this first shipped — meant switching capture off stopped the sweep
 * too, so the moment an operator believes the exposure ended is the moment it
 * becomes permanent. (CTO review, PEN-3631.)
 */

export const HEAP_SNAPSHOT_EXTENSION = ".heapsnapshot";

/**
 * Drop a file at this name inside the snapshot directory to request a snapshot
 * from any pod that mounts the volume. Contents are ignored; only existence is
 * read, so `touch` is the whole interface.
 */
export const HEAP_SNAPSHOT_SENTINEL_BASENAME = "snapshot.request";

/**
 * Snapshots are written under this suffix and renamed into place only once V8
 * has returned. A reader on another pod polling the directory would otherwise
 * see a partial file as a finished one — the rename is atomic within a
 * directory, the multi-second write is not.
 */
const PARTIAL_SUFFIX = ".partial";

/**
 * A heapsnapshot is JSON and reliably larger than the heap it describes. Require
 * headroom for twice the live heap on top of the configured floor, so a snapshot
 * cannot be the thing that fills a volume shared with every agent's home.
 */
const SIZE_ESTIMATE_MULTIPLIER = 2;

/**
 * Leave a `.partial` alone until this long after the capture that created it
 * started.
 *
 * Within one process a partial is unambiguously garbage, but the tier gate
 * (`paperclipNodeRole !== "api"`) admits both `worker` and the default `all`, so
 * a second replica against the shared directory would otherwise delete a peer's
 * in-flight write and break that peer's `renameSync`.
 *
 * Measured from the filename stamp, not mtime, for the same reason `maxAgeMs`
 * is (see `snapshotStampMs`) — and here the consequence is worse. A partial
 * holds the same plaintext secrets as a completed snapshot, because
 * `writeHeapSnapshot` serialises incrementally; mtime is rewritten by ordinary
 * retrieval tooling; and unlike a completed snapshot a partial has no `keep`
 * bound behind it, so mtime was the *only* thing retiring it. That made the
 * exposure indefinitely extensible by a reader. The stamp is not mutable that
 * way. (Ally review Suggestion 1, promoted to a condition of acceptance by the
 * CEO on PEN-3631.)
 *
 * The liveness this gives up is a write that runs longer than this window being
 * swept mid-flight. That is bounded by a wide margin: the pause is single-digit
 * seconds on a ~1 GB heap, against a window of ten minutes.
 */
const PARTIAL_ABANDONED_AFTER_MS = 10 * 60 * 1000;

export interface HeapSnapshotRuntime {
  now: () => Date;
  heapUsedBytes: () => number;
  /** `v8.writeHeapSnapshot`. Injected so tests never take a real multi-second snapshot. */
  writeSnapshot: (filePath: string) => string;
  /** Bytes available to an unprivileged writer at `dir`. */
  freeBytes: (dir: string) => number;
}

export const defaultHeapSnapshotRuntime: HeapSnapshotRuntime = {
  now: () => new Date(),
  heapUsedBytes: () => process.memoryUsage().heapUsed,
  writeSnapshot: (filePath: string) => writeHeapSnapshot(filePath),
  freeBytes: (dir: string) => {
    const stats = statfsSync(dir);
    return Number(stats.bavail) * Number(stats.bsize);
  },
};

export interface HeapSnapshotConfig {
  dir: string;
  /** Number of completed snapshots to retain. Older ones are pruned newest-first. */
  keep: number;
  /** Refuse to snapshot unless this many bytes remain free after the estimated write. */
  minFreeBytes: number;
  /** Take an unprompted snapshot at or above this live-heap size. 0 disables the automatic trigger. */
  autoThresholdBytes: number;
  /**
   * Minimum gap between *automatic* snapshots. The deliverable on PEN-3314 is two
   * snapshots hours apart (one names what is on the heap, the diff names what is
   * accumulating), and this is also what stops a worker parked above the threshold
   * from snapshotting on every poll.
   */
  autoMinIntervalMs: number;
  /**
   * Minimum gap between *sentinel* snapshots.
   *
   * Deliberately much shorter than `autoMinIntervalMs` — a sentinel is a human
   * asking, and the automatic gap exists to space a *pair* of snapshots for a
   * diff, which is not what a request means. But it cannot be absent: the
   * sentinel is writable from every pod mounting the shared claim, so an
   * unthrottled path lets a loop touching the file force a stop-the-world pause
   * plus a multi-gigabyte write on the singleton worker once per poll,
   * indefinitely. Retention caps the disk cost; only this caps the pause rate.
   */
  sentinelMinIntervalMs: number;
  /**
   * Hard ceiling on how long a completed snapshot may remain on the volume,
   * measured from the capture stamp embedded in its own filename.
   *
   * This is the exposure window (see the file header): the file contains this
   * process's secrets in plaintext and no file mode separates the readers, so
   * age is the only bound left. It applies *in addition to* `keep` and
   * overrides it — a snapshot past `maxAgeMs` is pruned even when it is one of
   * the `keep` newest, because "there are only two of them" is not a security
   * property.
   *
   * Measured from the filename stamp rather than mtime on purpose. Retrieval is
   * documented as copying these off the shared volume, and copy tooling rewrites
   * mtimes — so an mtime-based bound would let a reader *extend* the window by
   * touching the file. The embedded stamp is not mutable that way.
   *
   * Must exceed `autoMinIntervalMs`, or the older half of a diff pair can expire
   * before the newer half is taken; the caller warns when it does not.
   */
  maxAgeMs: number;
}

export type HeapSnapshotTrigger = "sentinel" | "threshold";

export interface HeapSnapshotResult {
  filePath: string;
  sizeBytes: number;
  heapUsedBytes: number;
  durationMs: number;
  trigger: HeapSnapshotTrigger;
  prunedCount: number;
}

export type HeapSnapshotSkipReason = "insufficient-free-space";

export interface HeapSnapshotSkipped {
  skipped: HeapSnapshotSkipReason;
  freeBytes: number;
  requiredBytes: number;
  /**
   * Bytes the retention prune would have released had it run. Reported because
   * the refusal *declines* to spend it: a reader seeing `freeBytes` alone below
   * `requiredBytes` would reasonably assume pruning was simply not tried.
   */
  reclaimableBytes: number;
}

function isCompletedSnapshot(name: string): boolean {
  return name.endsWith(HEAP_SNAPSHOT_EXTENSION);
}

function isPartialSnapshot(name: string): boolean {
  return name.endsWith(`${HEAP_SNAPSHOT_EXTENSION}${PARTIAL_SUFFIX}`);
}

/** Matches `snapshotBasename`: an ISO stamp with `:` and `.` flattened to `-`. */
const SNAPSHOT_NAME_PATTERN = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-pid\d+/;

/**
 * Recover the capture time from the filename, or null if it was not written by
 * `snapshotBasename`.
 *
 * Preferred over `mtime` for retention ordering because retrieval is documented
 * as copying these off the shared volume, and copy tooling rewrites mtimes —
 * which would make the ordering input mutable by the consumer, and could retire
 * the *newer* snapshot of a pair. The embedded stamp is not mutable that way.
 */
function snapshotStampMs(name: string): number | null {
  const match = SNAPSHOT_NAME_PATTERN.exec(name);
  if (match === null) return null;
  const [, date, hh, mm, ss, ms] = match;
  const parsed = Date.parse(`${date}T${hh}:${mm}:${ss}.${ms}Z`);
  return Number.isNaN(parsed) ? null : parsed;
}

interface PrunableEntry {
  name: string;
  sizeBytes: number;
}

/**
 * The entries `pruneHeapSnapshots(dir, keep, maxAgeMs)` would delete.
 *
 * Split out from the deletion so the free-space precondition can price a prune
 * without committing to it.
 *
 * Two independent reasons an entry is prunable: it falls outside the `keep`
 * newest, or it is older than `maxAgeMs`. The second overrides the first — the
 * age bound is an exposure window, not a disk cap (see the file header).
 */
function collectPrunable(
  dir: string,
  keep: number,
  maxAgeMs: number,
  nowMs: number,
): PrunableEntry[] {
  if (!existsSync(dir)) return [];
  const retain = Math.max(0, keep);
  const entries = readdirSync(dir);
  const prunable: PrunableEntry[] = [];

  for (const name of entries) {
    if (!isPartialSnapshot(name)) continue;
    try {
      const stats = statSync(path.join(dir, name));
      // Filename stamp first; mtime only for a file this module did not name,
      // where there is nothing else to go on. See PARTIAL_ABANDONED_AFTER_MS.
      const startedAtMs = snapshotStampMs(name) ?? stats.mtimeMs;
      if (nowMs - startedAtMs < PARTIAL_ABANDONED_AFTER_MS) continue;
      prunable.push({ name, sizeBytes: stats.size });
    } catch {
      // Vanished under us, or unreadable; nothing to reclaim either way.
    }
  }

  const completed = entries
    .filter(isCompletedSnapshot)
    .map((name) => {
      try {
        const stats = statSync(path.join(dir, name));
        return { name, sizeBytes: stats.size, sortKey: snapshotStampMs(name) ?? stats.mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((entry): entry is { name: string; sizeBytes: number; sortKey: number } => entry !== null)
    .sort((a, b) => b.sortKey - a.sortKey);

  completed.forEach((entry, index) => {
    const beyondKeep = index >= retain;
    const expired = maxAgeMs > 0 && nowMs - entry.sortKey >= maxAgeMs;
    if (beyondKeep || expired) prunable.push({ name: entry.name, sizeBytes: entry.sizeBytes });
  });

  return prunable;
}

/**
 * Bytes a `pruneHeapSnapshots(dir, keep, maxAgeMs)` would release right now.
 *
 * Exported for the free-space precondition in `takeHeapSnapshot`, which must do
 * this arithmetic *before* deleting anything.
 */
export function reclaimableHeapSnapshotBytes(
  dir: string,
  keep: number,
  maxAgeMs: number,
  nowMs: number = Date.now(),
): number {
  return collectPrunable(dir, keep, maxAgeMs, nowMs).reduce((sum, entry) => sum + entry.sizeBytes, 0);
}

/**
 * Retain the `keep` newest completed snapshots, and delete every older one plus
 * every one past `maxAgeMs` regardless of the cap.
 *
 * Also deletes abandoned `.partial` files regardless of the cap. A partial only
 * exists because a previous snapshot did not return — and this worker's failure
 * mode is an abrupt SIGABRT on heap exhaustion, so an abandoned multi-gigabyte
 * partial is the expected leftover rather than a hypothetical one. They are
 * never renamed in after the fact, so there is nothing to preserve. See
 * `PARTIAL_ABANDONED_AFTER_MS` for why "abandoned" is timed rather than assumed.
 *
 * Callers must keep invoking this when capture is disabled; see the file header.
 *
 * Returns the basenames removed.
 */
export function pruneHeapSnapshots(
  dir: string,
  keep: number,
  maxAgeMs: number,
  nowMs: number = Date.now(),
): string[] {
  const removed: string[] = [];

  for (const entry of collectPrunable(dir, keep, maxAgeMs, nowMs)) {
    try {
      unlinkSync(path.join(dir, entry.name));
      removed.push(entry.name);
    } catch {
      // Best effort: a concurrent prune owns it, or a failed unlink must never
      // block the snapshot itself.
    }
  }

  return removed;
}

/**
 * Completed snapshots currently on the volume, newest first.
 *
 * Counts only finished files. For the startup residual check use
 * `listResidualHeapSnapshots`, which also sees `.partial` leftovers — they carry
 * the same secrets and this function is blind to them by construction.
 */
export function listHeapSnapshots(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(isCompletedSnapshot)
    .sort((a, b) => (snapshotStampMs(b) ?? 0) - (snapshotStampMs(a) ?? 0));
}

/**
 * Every secret-bearing snapshot file on the volume, finished or not, newest first.
 *
 * Exported so startup can report leftovers while capture is *disabled* — that
 * is precisely the state in which an operator believes the exposure is over.
 *
 * Partials are included, and that inclusion is the whole point. `writeHeapSnapshot`
 * serialises incrementally, so a `<stamp>.heapsnapshot.partial` holds the same
 * plaintext heap strings as a completed one — and this feature's own documented
 * failure mode, an OOM *during* the write, is exactly what leaves one behind. The
 * natural operator response to that is to disable the flag and restart, so sizing
 * the residual check off completed files alone meant the one case most likely to
 * produce an orphaned partial was the one case that reported nothing: `poll` and
 * `warnResidualSnapshots` both came back false, nothing swept it again for the
 * life of the process, and the operator was told nothing. (Ally review Important
 * 1; upheld as a condition of acceptance by the CEO on PEN-3631.)
 */
export function listResidualHeapSnapshots(dir: string): {
  completed: string[];
  partial: string[];
} {
  if (!existsSync(dir)) return { completed: [], partial: [] };
  const byNewest = (a: string, b: string): number =>
    (snapshotStampMs(b) ?? 0) - (snapshotStampMs(a) ?? 0);
  const entries = readdirSync(dir);
  return {
    completed: entries.filter(isCompletedSnapshot).sort(byNewest),
    partial: entries.filter(isPartialSnapshot).sort(byNewest),
  };
}

/**
 * Create the snapshot directory.
 *
 * Called at startup rather than lazily on first snapshot: the sentinel file is
 * dropped *into* this directory, so if it only appeared after the first snapshot
 * there would be nowhere to place the request that triggers one.
 */
export function ensureHeapSnapshotDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

function snapshotBasename(now: Date): string {
  // Colons are legal on the volume but hostile to shell globbing on retrieval,
  // and retrieval is a human on another pod running `ls`.
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  return `${stamp}-pid${process.pid}${HEAP_SNAPSHOT_EXTENSION}`;
}

/**
 * Write one heap snapshot, pruning before and after.
 *
 * Pruning *before* is what makes the retention cap useful under pressure: the
 * space the previous snapshot occupies is exactly the space this one needs. But
 * the prune is priced before it is spent, because the free-space refusal below
 * is unrecoverable in a way an ordinary failure is not — a snapshot names a
 * *past* heap state, so a deleted one cannot be retaken, and the deliverable on
 * PEN-3314 is a pair hours apart that a single refusal would reduce to one with
 * no diff. Refusing without pruning costs nothing: the test already credits the
 * prune's bytes, so if it refuses, deleting them would not have been enough.
 *
 * For the same reason the pre-prune is *skipped entirely* when there is already
 * room. On the ample-space path it buys nothing and still destroys the older
 * half of the pair before a write that may not return — and the write not
 * returning is not hypothetical here. This runs on a worker whose failure mode
 * is heap exhaustion, `writeHeapSnapshot` on a bloated heap is itself a
 * plausible OOM trigger, and an OOMKill is SIGKILL: the `catch` below cannot
 * run, so nothing restores what the prune deleted. That put maximum kill risk
 * exactly where the baseline had just been removed. Deferring to the post-write
 * prune costs only the seconds of the write, and the age bound is unaffected —
 * an expired snapshot is still swept by the pass below, and by the caller's
 * periodic sweep. (Ally review, Important 1; upheld on PEN-3631.)
 */
export function takeHeapSnapshot(
  config: HeapSnapshotConfig,
  trigger: HeapSnapshotTrigger,
  runtime: HeapSnapshotRuntime = defaultHeapSnapshotRuntime,
): HeapSnapshotResult | HeapSnapshotSkipped {
  mkdirSync(config.dir, { recursive: true });

  const now = runtime.now();
  const nowMs = now.getTime();
  const pruneToBeforeWrite = Math.max(0, config.keep - 1);
  const heapUsedBytes = runtime.heapUsedBytes();
  const requiredBytes = config.minFreeBytes + heapUsedBytes * SIZE_ESTIMATE_MULTIPLIER;
  const freeBytes = runtime.freeBytes(config.dir);
  const reclaimableBytes = reclaimableHeapSnapshotBytes(
    config.dir,
    pruneToBeforeWrite,
    config.maxAgeMs,
    nowMs,
  );
  if (freeBytes + reclaimableBytes < requiredBytes) {
    return { skipped: "insufficient-free-space", freeBytes, requiredBytes, reclaimableBytes };
  }

  // Only spend the prune when the write actually needs the room. See the doc
  // comment: on the ample-space path this would delete the older half of the
  // diff pair to no purpose, immediately before the operation most likely to
  // take the process down with it.
  const prunedBefore =
    freeBytes < requiredBytes
      ? pruneHeapSnapshots(config.dir, pruneToBeforeWrite, config.maxAgeMs, nowMs)
      : [];

  const finalPath = path.join(config.dir, snapshotBasename(now));
  const partialPath = `${finalPath}${PARTIAL_SUFFIX}`;

  const startedAtMs = Date.now();
  try {
    runtime.writeSnapshot(partialPath);
    renameSync(partialPath, finalPath);
  } catch (err) {
    try {
      unlinkSync(partialPath);
    } catch {
      // Nothing to clean up, or the volume is unhappy; the throw below is the signal.
    }
    throw err;
  }
  const durationMs = Date.now() - startedAtMs;

  let sizeBytes = 0;
  try {
    sizeBytes = statSync(finalPath).size;
  } catch {
    // The snapshot is written; not being able to size it is not a failure.
  }

  const prunedAfter = pruneHeapSnapshots(config.dir, config.keep, config.maxAgeMs, nowMs);
  return {
    filePath: finalPath,
    sizeBytes,
    heapUsedBytes,
    durationMs,
    trigger,
    prunedCount: prunedBefore.length + prunedAfter.length,
  };
}

/**
 * How many completed snapshots the periodic sweep may retain.
 *
 * `keep` while capture is on; **zero** once it is off. Disabling the flag is an
 * operator declaring the capture window closed, and a snapshot's lifetime is the
 * only control there is over what it discloses (see the file header) — so the
 * files go at that point rather than lingering until `maxAgeMs` retires them.
 * The two bounds cover different halves of the window: `maxAgeMs` while it is
 * open, this once it shuts.
 *
 * The cost is real and is documented rather than mitigated: flipping the flag
 * off deletes the pair, including one that has not been retrieved yet. That is
 * why `doc/DEVELOPING.md` states the ordering — copy the snapshots off the
 * volume *before* disabling capture — and why that line is load-bearing rather
 * than documentation polish. (CTO review, PEN-3631.)
 */
export function heapSnapshotSweepKeep(captureEnabled: boolean, keep: number): number {
  return captureEnabled ? Math.max(0, keep) : 0;
}

export interface HeapSnapshotStartupPlan {
  /** Create the snapshot directory and honour triggers. */
  capture: boolean;
  /** Run the periodic retention sweep. */
  poll: boolean;
  /** Warn that secret-bearing files are on disk while capture is off. */
  warnResidualSnapshots: boolean;
}

/**
 * Decide what the worker tier should arm at startup.
 *
 * Extracted from `index.ts` so the one property that matters here is a tested
 * unit rather than inline gating: **`poll` is not implied by `capture`.** Every
 * prune once lived inside the capture flag, so setting it to `false` stopped the
 * sweep along with the capture and whatever was already on the shared volume
 * stayed there forever — the moment an operator believes the exposure ended was
 * the moment it became permanent. That was an untested inline condition, which
 * is exactly why this one is not. (CTO review, PEN-3631.)
 *
 * Capture off with nothing on disk arms nothing at all: there is no exposure to
 * sweep, so a deployment that never enabled this keeps precisely the footprint
 * it had. Capture off *with* something on disk keeps polling, for either of two
 * reasons: a completed snapshot that survived the startup sweep survived an
 * unlink, and the retry is the only thing that will clear it; or a `.partial`
 * was spared deliberately because it is still inside its abandonment window, and
 * the poll is what collects it once it ages out. Both are residual exposure, so
 * `residualSnapshotCount` must count both — see `listResidualHeapSnapshots`.
 */
export function planHeapSnapshotStartup(input: {
  captureEnabled: boolean;
  residualSnapshotCount: number;
}): HeapSnapshotStartupPlan {
  if (input.captureEnabled) {
    return { capture: true, poll: true, warnResidualSnapshots: false };
  }
  const hasResidual = input.residualSnapshotCount > 0;
  return { capture: false, poll: hasResidual, warnResidualSnapshots: hasResidual };
}

export interface HeapSnapshotDecision {
  trigger: HeapSnapshotTrigger | null;
  /** True when a sentinel was observed, whether or not it produced a snapshot. */
  sentinelConsumed: boolean;
}

/**
 * Decide whether this poll should snapshot, consuming the sentinel if present.
 *
 * The sentinel is deleted *before* the snapshot is attempted, not after, so a
 * request is honoured exactly once. Deleting afterwards would retry a failing
 * snapshot on every poll for as long as the condition persisted — and the
 * conditions that make a snapshot fail (a full volume, a dying heap) are exactly
 * the ones that persist. A sentinel declined by the rate limit is consumed for
 * the same reason: honoured-exactly-once has to hold whether or not the request
 * produced a snapshot, or a backlog of touches would drain one per poll.
 */
export function decideHeapSnapshot(
  config: HeapSnapshotConfig,
  state: { lastAutoSnapshotAtMs: number | null; lastSentinelSnapshotAtMs: number | null },
  runtime: HeapSnapshotRuntime = defaultHeapSnapshotRuntime,
): HeapSnapshotDecision {
  const sentinelPath = path.join(config.dir, HEAP_SNAPSHOT_SENTINEL_BASENAME);
  if (existsSync(sentinelPath)) {
    try {
      unlinkSync(sentinelPath);
    } catch {
      // Another replica consumed it, or it is unwritable. Either way, do not
      // snapshot on a sentinel we could not claim.
      return { trigger: null, sentinelConsumed: false };
    }
    const lastSentinelAt = state.lastSentinelSnapshotAtMs;
    if (
      lastSentinelAt !== null &&
      runtime.now().getTime() - lastSentinelAt < config.sentinelMinIntervalMs
    ) {
      // Claimed but declined: the pause this would cost is the thing being
      // rationed, and the sentinel is writable from every pod on the claim.
      return { trigger: null, sentinelConsumed: true };
    }
    return { trigger: "sentinel", sentinelConsumed: true };
  }

  if (config.autoThresholdBytes <= 0) return { trigger: null, sentinelConsumed: false };
  if (runtime.heapUsedBytes() < config.autoThresholdBytes) {
    return { trigger: null, sentinelConsumed: false };
  }
  const lastAt = state.lastAutoSnapshotAtMs;
  if (lastAt !== null && runtime.now().getTime() - lastAt < config.autoMinIntervalMs) {
    return { trigger: null, sentinelConsumed: false };
  }
  return { trigger: "threshold", sentinelConsumed: false };
}
