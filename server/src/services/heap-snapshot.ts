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
 * Everything here is inert unless `PAPERCLIP_HEAP_SNAPSHOT_ENABLED=true`.
 *
 * Snapshots are large (roughly 1.5-2x the used heap) and the shared volume is
 * also every agent's home directory, so both a retention cap and a free-space
 * precondition are load-bearing rather than tidiness.
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
 * Leave a `.partial` alone until it has been untouched for this long.
 *
 * Within one process a partial is unambiguously garbage, but the tier gate
 * (`paperclipNodeRole !== "api"`) admits both `worker` and the default `all`, so
 * a second replica against the shared directory would otherwise delete a peer's
 * in-flight write and break that peer's `renameSync`. V8 extends the file
 * continuously while writing, so an in-flight partial's mtime is always recent
 * and an abandoned one's is frozen at the abort.
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
 * The entries `pruneHeapSnapshots(dir, keep)` would delete, newest retained.
 *
 * Split out from the deletion so the free-space precondition can price a prune
 * without committing to it.
 */
function collectPrunable(dir: string, keep: number): PrunableEntry[] {
  if (!existsSync(dir)) return [];
  const retain = Math.max(0, keep);
  const entries = readdirSync(dir);
  const prunable: PrunableEntry[] = [];
  const nowMs = Date.now();

  for (const name of entries) {
    if (!isPartialSnapshot(name)) continue;
    try {
      const stats = statSync(path.join(dir, name));
      if (nowMs - stats.mtimeMs < PARTIAL_ABANDONED_AFTER_MS) continue;
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

  for (const entry of completed.slice(retain)) {
    prunable.push({ name: entry.name, sizeBytes: entry.sizeBytes });
  }

  return prunable;
}

/**
 * Bytes a `pruneHeapSnapshots(dir, keep)` would release right now.
 *
 * Exported for the free-space precondition in `takeHeapSnapshot`, which must do
 * this arithmetic *before* deleting anything.
 */
export function reclaimableHeapSnapshotBytes(dir: string, keep: number): number {
  return collectPrunable(dir, keep).reduce((sum, entry) => sum + entry.sizeBytes, 0);
}

/**
 * Retain the `keep` newest completed snapshots and delete every older one.
 *
 * Also deletes abandoned `.partial` files regardless of the cap. A partial only
 * exists because a previous snapshot did not return — and this worker's failure
 * mode is an abrupt SIGABRT on heap exhaustion, so an abandoned multi-gigabyte
 * partial is the expected leftover rather than a hypothetical one. They are
 * never renamed in after the fact, so there is nothing to preserve. See
 * `PARTIAL_ABANDONED_AFTER_MS` for why "abandoned" is timed rather than assumed.
 *
 * Returns the basenames removed.
 */
export function pruneHeapSnapshots(dir: string, keep: number): string[] {
  const removed: string[] = [];

  for (const entry of collectPrunable(dir, keep)) {
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
 */
export function takeHeapSnapshot(
  config: HeapSnapshotConfig,
  trigger: HeapSnapshotTrigger,
  runtime: HeapSnapshotRuntime = defaultHeapSnapshotRuntime,
): HeapSnapshotResult | HeapSnapshotSkipped {
  mkdirSync(config.dir, { recursive: true });

  const pruneToBeforeWrite = Math.max(0, config.keep - 1);
  const heapUsedBytes = runtime.heapUsedBytes();
  const requiredBytes = config.minFreeBytes + heapUsedBytes * SIZE_ESTIMATE_MULTIPLIER;
  const freeBytes = runtime.freeBytes(config.dir);
  const reclaimableBytes = reclaimableHeapSnapshotBytes(config.dir, pruneToBeforeWrite);
  if (freeBytes + reclaimableBytes < requiredBytes) {
    return { skipped: "insufficient-free-space", freeBytes, requiredBytes, reclaimableBytes };
  }

  const prunedBefore = pruneHeapSnapshots(config.dir, pruneToBeforeWrite);

  const now = runtime.now();
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

  const prunedAfter = pruneHeapSnapshots(config.dir, config.keep);
  return {
    filePath: finalPath,
    sizeBytes,
    heapUsedBytes,
    durationMs,
    trigger,
    prunedCount: prunedBefore.length + prunedAfter.length,
  };
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
