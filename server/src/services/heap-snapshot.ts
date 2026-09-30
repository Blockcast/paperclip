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
}

function isCompletedSnapshot(name: string): boolean {
  return name.endsWith(HEAP_SNAPSHOT_EXTENSION);
}

function isPartialSnapshot(name: string): boolean {
  return name.endsWith(`${HEAP_SNAPSHOT_EXTENSION}${PARTIAL_SUFFIX}`);
}

/**
 * Retain the `keep` newest completed snapshots and delete every older one.
 *
 * Also deletes *every* `.partial` file unconditionally. A partial only exists
 * because a previous snapshot did not return — and this worker's failure mode is
 * an abrupt SIGABRT on heap exhaustion, so an abandoned multi-gigabyte partial is
 * the expected leftover rather than a hypothetical one. They are never renamed in
 * after the fact, so there is nothing to preserve.
 *
 * Returns the basenames removed.
 */
export function pruneHeapSnapshots(dir: string, keep: number): string[] {
  if (!existsSync(dir)) return [];
  const retain = Math.max(0, keep);
  const entries = readdirSync(dir);
  const removed: string[] = [];

  for (const name of entries) {
    if (!isPartialSnapshot(name)) continue;
    try {
      unlinkSync(path.join(dir, name));
      removed.push(name);
    } catch {
      // A concurrent prune or an in-flight write owns it; leave it.
    }
  }

  const completed = entries
    .filter(isCompletedSnapshot)
    .map((name) => {
      const filePath = path.join(dir, name);
      try {
        return { name, mtimeMs: statSync(filePath).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((entry): entry is { name: string; mtimeMs: number } => entry !== null)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const entry of completed.slice(retain)) {
    try {
      unlinkSync(path.join(dir, entry.name));
      removed.push(entry.name);
    } catch {
      // Best effort: a failed prune must never block the snapshot itself.
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
 * space the previous snapshot occupies is exactly the space this one needs.
 */
export function takeHeapSnapshot(
  config: HeapSnapshotConfig,
  trigger: HeapSnapshotTrigger,
  runtime: HeapSnapshotRuntime = defaultHeapSnapshotRuntime,
): HeapSnapshotResult | HeapSnapshotSkipped {
  mkdirSync(config.dir, { recursive: true });

  // Prune first so the outgoing generation's bytes count as available headroom.
  const prunedBefore = pruneHeapSnapshots(config.dir, Math.max(0, config.keep - 1));

  const heapUsedBytes = runtime.heapUsedBytes();
  const requiredBytes = config.minFreeBytes + heapUsedBytes * SIZE_ESTIMATE_MULTIPLIER;
  const freeBytes = runtime.freeBytes(config.dir);
  if (freeBytes < requiredBytes) {
    return { skipped: "insufficient-free-space", freeBytes, requiredBytes };
  }

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
 * the ones that persist.
 */
export function decideHeapSnapshot(
  config: HeapSnapshotConfig,
  state: { lastAutoSnapshotAtMs: number | null },
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
