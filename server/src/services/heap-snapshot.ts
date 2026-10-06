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
 * exposure indefinitely extensible by a reader. (Ally review Suggestion 1,
 * promoted to a condition of acceptance by the CEO on PEN-3631.)
 *
 * "Not mutable that way" is as far as the stamp's immutability goes, and an
 * earlier version of this comment overstated it. The stamp resists `touch`; it
 * does not resist `mv`, and it does not resist a forward-skewed writer clock.
 * Because this window is the ONLY retirement mechanism a partial has, a stamp
 * ahead of the sweeper's `nowMs` would make it immortal rather than merely
 * mis-ordered — so `collectPrunable` falls back to mtime for a future stamp
 * exactly as it does for an unparseable name. The reasoning is at that call
 * site; it is the reason this constant is still a sound bound.
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
  /**
   * Number of completed snapshots to retain. Older ones are pruned newest-first.
   *
   * A cap over the whole **directory**, not per writing process — and `dir` is on
   * a volume every pod mounts. That is sound today only because the tier that
   * runs this is a singleton: the worker StatefulSet is `replicas: 1` and the API
   * Deployment sets `PAPERCLIP_NODE_ROLE=api`, which excludes it from the feature
   * entirely. Raising the worker replica count without raising `keep` with it
   * breaks the PEN-3314 deliverable rather than merely crowding the disk: each
   * round of snapshots fills every slot and the post-write prune takes the
   * previous round out, so the pair stops spanning hours and becomes one
   * instant across processes. Budget `keep >= replicas × pairs`.
   * `findConcurrentSnapshotWriters` detects *that* condition — and only that
   * one. It filters on `entry.pid !== self.pid`, so it is blind to the two
   * single-process routes to the same collapsed pair: a sentinel capture
   * followed by a threshold capture one poll later, and a restart that re-grows
   * past the threshold inside `autoMinIntervalMs`. Both are bounded in
   * `decideHeapSnapshot` and at startup instead, because neither has a foreign
   * pid for the detector to see.
   */
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
   * touching the file. The embedded stamp is not mutable by `touch`. It *is*
   * mutable by `mv`, from any pod on the claim, so the key clamps a future stamp
   * to `0` rather than trusting it — see `retentionKeyMs`, which carries why an
   * unclamped future stamp defeats this bound and `keep` simultaneously. A file
   * whose name this module did not write has no stamp to read and is treated as
   * already expired rather than falling back to mtime, which would reopen
   * exactly that hole for any name that did not parse.
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
const SNAPSHOT_NAME_PATTERN =
  /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-pid(\d+)/;

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

/**
 * The one retention key for a snapshot file: its embedded capture stamp, or `0`
 * for any name this module did not write.
 *
 * Zero is load-bearing in both directions at once. A file keyed `0` sorts
 * *oldest* under every ordering here, so it can never hold a `keep` slot ahead
 * of a real snapshot; and `nowMs - 0` exceeds every finite `maxAgeMs`, so it is
 * expirable on the first sweep that sees it. Maximally old and maximally
 * expirable is the correct posture for a secret-bearing file on this volume
 * that this process cannot date.
 *
 * The fallback this replaces was `?? stats.mtimeMs`, and it broke both halves.
 * `maxAgeMs` is documented as stamp-based precisely so a reader cannot extend
 * the exposure window by touching the file — and mtime handed that mutability
 * straight back for any name that happened not to parse, so a file with a
 * refreshed mtime never expired at all. It also broke *inconsistently*:
 * `listHeapSnapshots` already keyed the same file at `0`, so the two functions
 * disagreed about which end of the ordering it sat on, and an unstamped file
 * could take a keep slot and evict the older half of a diff pair — the one
 * artifact PEN-3314 needs and the one that cannot be retaken.
 *
 * A stamp *ahead* of `nowMs` is keyed `0` for the same reason, and that case is
 * not hypothetical padding. Left unclamped it defeats both retention bounds at
 * once on the same entry: `nowMs - stamp` is negative, so no finite `maxAgeMs`
 * ever expires it, and the descending sort pins it at index 0, so it never falls
 * outside `keep` either. The file becomes immortal *and* permanently holds a
 * keep slot, evicting the real snapshots underneath it.
 *
 * That contradicts the immutability the `maxAgeMs` docblock claims for this key.
 * The stamp is not mutable by `touch`, which is the hole the mtime fallback had
 * — but it is mutable by `mv`, from any pod on the shared claim, which no file
 * mode separates. Renaming is not an escalation of confidentiality (an actor who
 * can rename already reads the file); the durable harm is the false invariant and
 * the pinned keep slot. The no-adversary route is forward clock skew between
 * pods, which this module already concedes is live — small skew only perturbs
 * the ordering, but a materially future stamp buys immortality.
 *
 * Sole source of this key: every ordering and every age test routes through it,
 * so the two cannot drift apart again. (Ally review, PEN-3631.)
 */
function retentionKeyMs(name: string, nowMs: number): number {
  const stamped = snapshotStampMs(name);
  return stamped === null || stamped > nowMs ? 0 : stamped;
}

/** The pid segment `snapshotBasename` embedded, or null for a foreign name. */
function snapshotPid(name: string): number | null {
  const match = SNAPSHOT_NAME_PATTERN.exec(name);
  return match === null ? null : Number(match[6]);
}

/** This process's identity, as the detector below reasons about it. */
export interface SnapshotWriterSelf {
  /** `process.pid`. Snapshots carrying it are ours and are never foreign. */
  pid: number;
  /**
   * Epoch ms at which this process started — `performance.timeOrigin`.
   *
   * Must be wall-clock epoch ms, comparable against a snapshot's filename
   * stamp. A monotonic reading (`performance.now()`, `process.uptime()`) is
   * near-zero at boot, which would place every snapshot on disk at or after it
   * and make the detector warn on every predecessor instead of none.
   */
  startedAtMs: number;
}

export interface ConcurrentSnapshotWriters {
  /** The foreign pids that wrote during our lifetime, ascending. */
  pids: number[];
  /** Epoch ms of the newest such write — how live the competition is. */
  newestStampMs: number;
}

/**
 * Detect *another live process* writing snapshots into this directory, or null
 * if every snapshot here is explainable as ours or as a dead predecessor's.
 *
 * `keep` is a global cap over this directory, and the directory is shared by
 * every process that mounts the volume. With more than one writer, each round
 * of snapshots fills all `keep` slots and the post-write prune removes the
 * previous round wholesale — leaving two snapshots of *different processes at
 * one instant* rather than one process hours apart. The diff PEN-3314 needs
 * becomes unobtainable, and it fails silently, with only `prunedCount` moving.
 *
 * The discriminator is "a pid that is not ours, stamped at or after we
 * started". It rests on one fact that nothing in this system can bend: a
 * predecessor is dead before its successor boots, so it cannot write a snapshot
 * after our start. Everything older than our start is a predecessor's and is
 * left alone; anything newer is a process running alongside us, which is the
 * failure mode, at any spacing.
 *
 * It deliberately does NOT key off a time window, and that is a correction
 * (Ally review, PEN-3631). The previous shape warned on "different pids closer
 * together than `autoMinIntervalMs`", justified by the claim that a
 * restart-spanning pair is guaranteed hours apart. There is no such guarantee:
 * the limiter is `heapSnapshotState`, held in process memory and never seeded
 * from disk, and `decideHeapSnapshot` applies an interval only when the field is
 * non-null — so the first trigger after *any* restart fires unconditionally.
 * An operator who touches the sentinel, suffers the OOM-restart this feature
 * exists to diagnose, and touches it again ten minutes later produced two pids
 * ten minutes apart: the documented deliverable, warned about as concurrency,
 * with `keep`-raising advice that is wrong on a `replicas: 1` worker. That is
 * the cry-wolf outcome the window was chosen to avoid, reached by the path it
 * named as safe. Anchoring on our own start time removes the timing assumption
 * instead of re-tuning it.
 *
 * Two alternatives were considered and are worse here. Requiring the pids to
 * *interleave* needs three retained snapshots to see anything, and `keep`
 * defaults to 2 — it would be structurally unable to fire on the shipped
 * configuration. Narrowing the window to `heapSnapshotPollIntervalMs` keeps the
 * timing assumption (a crash-restart can be quick) and silently drops genuine
 * concurrency spaced wider than one poll, which this shape catches.
 *
 * Two exposures, both pre-existing and both narrowed rather than widened by the
 * change. Clock skew: a peer whose clock lags ours can stamp a live write
 * before our start and be missed. Pid collision: pods have separate pid
 * namespaces, so a peer that happens to share our pid is invisible. Neither is
 * newly introduced — the filename is the only evidence available here — and the
 * detector is advisory, so a miss costs a warning, not a capture.
 *
 * Detection rather than partitioning, and that is a choice. Partitioning the
 * keep window by pid was the other option and is worse here: pid changes on
 * every restart, not every replica, so partitions would accumulate per-restart
 * and turn a global disk cap into one unbounded in the number of partitions —
 * on a shared volume that PEN-3631 requires snapshots not be allowed to fill.
 * (Ally review, PEN-3631.)
 */
export function findConcurrentSnapshotWriters(
  names: string[],
  self: SnapshotWriterSelf,
): ConcurrentSnapshotWriters | null {
  const foreign = names
    .filter(isCompletedSnapshot)
    .map((name) => {
      const stampMs = snapshotStampMs(name);
      const pid = snapshotPid(name);
      return stampMs === null || pid === null ? null : { stampMs, pid };
    })
    .filter((entry): entry is { stampMs: number; pid: number } => entry !== null)
    // Ours is not competition, and a stamp older than our start belongs to a
    // process that was already gone when we booted.
    .filter((entry) => entry.pid !== self.pid && entry.stampMs >= self.startedAtMs);

  if (foreign.length === 0) return null;
  return {
    pids: [...new Set(foreign.map((entry) => entry.pid))].sort((a, b) => a - b),
    // Folded rather than spread into `Math.max`: this list is whatever the
    // directory holds, and a retention failure is exactly when the detector
    // should still work. A spread over ~100k entries is a RangeError, which the
    // caller would swallow as a debug line.
    newestStampMs: foreign.reduce((newest, entry) => (entry.stampMs > newest ? entry.stampMs : newest), -Infinity),
  };
}

interface PrunableEntry {
  name: string;
  sizeBytes: number;
}

/**
 * The entries `pruneHeapSnapshots(dir, keep, maxAgeMs, nowMs)` would delete.
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
      // Filename stamp first; mtime when the stamp is absent OR ahead of now.
      // See PARTIAL_ABANDONED_AFTER_MS.
      //
      // Deliberately NOT routed through `retentionKeyMs`. The completed path
      // keys an unparsed name at 0 because its only bound is `maxAgeMs`, which
      // mtime made evadable without limit. Keying at 0 here would delete every
      // stampless partial on sight, including a peer's genuinely in-flight
      // write. The two paths differ because what they are protecting against
      // differs. (Ally review noted the shared shape; PEN-3631.)
      //
      // But the FUTURE-stamp clamp `retentionKeyMs` applies is needed here too,
      // and the earlier version of this comment was wrong to say the fixed
      // 10-minute window "caps the exposure either way". That holds for a name
      // this module did not parse; it does not hold for one stamped ahead of
      // `nowMs`, which makes `nowMs - startedAtMs` NEGATIVE, so the comparison
      // below is true on every sweep forever. `collectPrunable` is the only
      // partial deleter besides `takeHeapSnapshot`'s own failure `catch`, and a
      // partial has no `keep` bound behind it (see the header at the top of
      // this file), so this window is the ONLY retirement mechanism a partial
      // has. A negative elapsed value disables it permanently — and the file
      // stays visible via `listResidualHeapSnapshots`, under a startup warning
      // promising the poll will collect it once it ages out, which it never
      // will. Disabling capture does not remove it either.
      //
      // The no-adversary route is the one that matters: the name comes from the
      // WRITING pod's clock (`takeHeapSnapshot` builds it from `runtime.now()`),
      // so a forward-skewed pod that OOMs mid-write leaves a future-stamped
      // partial relative to a correctly-clocked sweeper. OOM mid-write is this
      // feature's own documented failure mode on the worker it diagnoses.
      //
      // Clamp forward to MTIME, not to `nowMs`. `Math.min(stamped, nowMs)` reads
      // as the obvious fix and silently does not work: it re-pins `startedAtMs`
      // to `nowMs` on every sweep, so elapsed is 0 each time and the file is
      // permanently "just started" until the wall clock overtakes the stamp.
      // Falling back to mtime instead puts a future-stamped partial in exactly
      // the posture this path already accepts for an unparseable name — a
      // genuinely in-flight peer write is still spared by its fresh mtime,
      // while a stranded one ages out in ten minutes.
      // (Ally review of 320def5, Important 1; PEN-3631.)
      const stamped = snapshotStampMs(name);
      const startedAtMs = stamped === null || stamped > nowMs ? stats.mtimeMs : stamped;
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
        return { name, sizeBytes: stats.size, sortKey: retentionKeyMs(name, nowMs) };
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
 * Bytes a `pruneHeapSnapshots(dir, keep, maxAgeMs, nowMs)` would release right now.
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
export function listHeapSnapshots(dir: string, nowMs: number = Date.now()): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(isCompletedSnapshot)
    .sort((a, b) => retentionKeyMs(b, nowMs) - retentionKeyMs(a, nowMs));
}

/**
 * The newest capture stamp already on the volume, or `null` if there is none.
 *
 * Exported so startup can seed `lastAutoSnapshotAtMs` from disk. The in-memory
 * limiter is initialised to null on every boot, so without this seed
 * `autoMinIntervalMs` provides no spacing across a restart at all: a worker that
 * OOM-restarts and re-grows past the threshold inside the interval retains a
 * pair spaced by the crash cycle rather than by the interval, and at `keep: 2`
 * the prune takes the hours-older half with it. The deliverable is a pair hours
 * apart; a pair minutes apart is not a diff.
 *
 * Returns `null` rather than `0` for an unstamped or future-stamped newest file:
 * `retentionKeyMs` keys both at `0`, which carries no information about when the
 * last capture happened, and seeding the limiter with it would read as "captured
 * at the epoch" and bound nothing. Null leaves the first capture unthrottled,
 * which is the same posture as an empty directory.
 *
 * Deliberately not used to seed `lastSentinelSnapshotAtMs`: a human request
 * after a restart should fire promptly, and the sentinel's own rationing exists
 * to bound an operator loop, not to space a diff pair. (Ally review, PEN-3631.)
 */
export function newestHeapSnapshotStampMs(dir: string, nowMs: number = Date.now()): number | null {
  const newest = listHeapSnapshots(dir, nowMs)[0];
  if (newest === undefined) return null;
  const stamp = retentionKeyMs(newest, nowMs);
  return stamp === 0 ? null : stamp;
}

/**
 * The `lastAutoSnapshotAtMs` seed, resolved against a volume that may not be
 * readable. Never throws.
 *
 * `newestHeapSnapshotStampMs` reads the filesystem, so it throws like every
 * other read here — and startup is the one caller that cannot afford it.
 * `startServer()` is invoked as `void startServer().catch(() => process.exit(1))`,
 * so an EACCES/EIO/ESTALE out of this seed is not a failed diagnostic, it is
 * `process.exit(1)` on every boot until the volume recovers. `existsSync` does
 * not screen that: a directory that exists but cannot be *read* passes it and
 * throws from `readdirSync` — and the snapshot directory is a shared CephFS
 * claim every agent pod also mounts rw, which makes a transient one ordinary.
 *
 * Totality lives here rather than at the call site because this seed is the
 * third read on that path to need the same guard, and the first to be reached
 * **before** the feature flag is consulted — so it alone crash-loops the whole
 * worker tier on a deployment that never enabled the feature. A `try` around
 * the call site would have closed this instance; returning a verdict closes the
 * class, and makes the posture testable rather than inline. (Ally review,
 * PEN-3631; the same defect as `prior:9243c0f important 3`.)
 *
 * Fails **open**, to `stampMs: null` — the posture an empty directory gets, and
 * exactly the behaviour that preceded this seed. The alternative, seeding `nowMs`
 * so an unreadable volume throttles, would silently withhold the first capture
 * of a diagnostic on evidence that says nothing about when the last one ran; and
 * a volume this process cannot read is one it is about to fail to write anyway,
 * audibly. `readError` is returned rather than swallowed so the caller can say
 * so: a seed that quietly degrades to null would re-open the cross-restart gap
 * this function exists to close, with nothing in the log to attribute it to.
 */
export function seedLastAutoSnapshotAtMs(
  dir: string,
  nowMs: number = Date.now(),
): { stampMs: number | null; readError: unknown } {
  try {
    return { stampMs: newestHeapSnapshotStampMs(dir, nowMs), readError: null };
  } catch (err) {
    return { stampMs: null, readError: err };
  }
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
export function listResidualHeapSnapshots(
  dir: string,
  nowMs: number = Date.now(),
): {
  completed: string[];
  partial: string[];
} {
  if (!existsSync(dir)) return { completed: [], partial: [] };
  const byNewest = (a: string, b: string): number => retentionKeyMs(b, nowMs) - retentionKeyMs(a, nowMs);
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

/**
 * What this poll did about the sentinel.
 *
 * `trigger === null` is three situations wearing one face, and the caller cannot
 * tell them apart from the trigger alone — so this says which. Two of them are
 * operator-facing and want *different* responses:
 *
 * - `"rate-limited"` — the file is **gone** and no snapshot will appear. The
 *   sentinel's disappearance is the only feedback this interface has, so
 *   without a distinct verdict here a declined request is indistinguishable
 *   from an honoured one. Response: wait out the interval and touch it again.
 * - `"claim-failed"` — the file is **still there** and was not honoured.
 *   Response: find out who else is consuming it, or why it cannot be deleted.
 *
 * A boolean cannot carry this: `"claim-failed"` and `"absent"` both mean "not
 * consumed" while meaning opposite things to an operator.
 */
export type HeapSnapshotSentinelOutcome =
  /** No sentinel file was present. */
  | "absent"
  /** Observed, deleted, and honoured — this poll snapshots. */
  | "claimed"
  /** Observed and deleted, but declined by `sentinelMinIntervalMs`. */
  | "rate-limited"
  /** Observed, but the delete failed, so it was not claimed and not honoured. */
  | "claim-failed";

export interface HeapSnapshotDecision {
  trigger: HeapSnapshotTrigger | null;
  /**
   * What happened to the sentinel, whether or not it produced a snapshot.
   * `"claimed"` and `"rate-limited"` both mean the file was deleted —
   * honoured-exactly-once holds either way.
   *
   * Independent of `trigger`, and deliberately so: `"claim-failed"` pairs with
   * a `"threshold"` trigger whenever the heap floor is over the line, because
   * an unclaimable request file is not a reason to stop watching the heap.
   */
  sentinel: HeapSnapshotSentinelOutcome;
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
 *
 * Neither a *declined* nor an *unclaimable* sentinel returns early: both fall
 * through to the threshold arm. The two triggers are independent — separate
 * config, separate interval, separate state field — and neither a request file
 * the worker cannot delete nor one the rate limit turned away says anything
 * about the heap.
 *
 * The suppression this prevents is real, but ONLY the claim-failed half of it
 * is load-bearing at the shipped configuration, and an earlier version of this
 * comment claimed both. Claim-failed never stamps `lastSentinelSnapshotAtMs`,
 * so it genuinely leaves the threshold arm's spacing untouched; the file is
 * still there by definition, so every later poll takes the same branch, and
 * returning early would suppress automatic capture for the whole life of the
 * process.
 *
 * The rate-limited half cannot reach a capture on the shipped relationship.
 * Getting there needs `now - lastSentinel < sentinelMinIntervalMs`, while the
 * threshold arm needs `now - max(lastAuto, lastSentinel) >= autoMinIntervalMs`;
 * since that max is `>= lastSentinel`, the conjunction is satisfiable only when
 * `autoMinIntervalMs < sentinelMinIntervalMs`. The fallbacks are the inverse
 * (120 min vs 5 min, and the sentinel's is called "deliberately much shorter"),
 * so in production this path throttles — which is the correct outcome either
 * way. The window the fall-through was originally justified by is in fact
 * closed by the threshold arm's own `Math.max` spacing, a change made after
 * that justification was written.
 *
 * The branch stays, because `autoMinIntervalMs < sentinelMinIntervalMs` is a
 * legal configuration (both bound at `min: 1` minute) under which it is the
 * difference between watching the heap and not. It is simply not the shipped
 * one, and the tests say so rather than certifying it at an out-of-bounds
 * interval. Note the separate decision above — a declined sentinel is still
 * *consumed* — is about honoured-exactly-once and is not a reason to skip the
 * threshold arm. (Ally review of 9b2fc5f and 320def5; PEN-3631.)
 */
export function decideHeapSnapshot(
  config: HeapSnapshotConfig,
  state: { lastAutoSnapshotAtMs: number | null; lastSentinelSnapshotAtMs: number | null },
  runtime: HeapSnapshotRuntime = defaultHeapSnapshotRuntime,
): HeapSnapshotDecision {
  const sentinelPath = path.join(config.dir, HEAP_SNAPSHOT_SENTINEL_BASENAME);
  let sentinel: HeapSnapshotSentinelOutcome = "absent";
  if (existsSync(sentinelPath)) {
    let claimed = false;
    try {
      unlinkSync(sentinelPath);
      claimed = true;
    } catch {
      // Another replica consumed it, or it is unwritable. Either way, do not
      // snapshot on a sentinel we could not claim — but do keep watching the
      // heap, which is a trigger this file has no bearing on.
      sentinel = "claim-failed";
    }
    if (claimed) {
      const lastSentinelAt = state.lastSentinelSnapshotAtMs;
      if (
        lastSentinelAt !== null &&
        runtime.now().getTime() - lastSentinelAt < config.sentinelMinIntervalMs
      ) {
        // Claimed but declined: the pause this would cost is the thing being
        // rationed, and the sentinel is writable from every pod on the claim.
        // Fall through rather than return — see the docblock: a declined
        // request says nothing about the heap, and something re-creating the
        // file each poll would otherwise suppress the threshold arm outright.
        sentinel = "rate-limited";
      } else {
        return { trigger: "sentinel", sentinel: "claimed" };
      }
    }
  }

  if (config.autoThresholdBytes <= 0) return { trigger: null, sentinel };
  if (runtime.heapUsedBytes() < config.autoThresholdBytes) {
    return { trigger: null, sentinel };
  }
  // Spaced against the newest capture by *either* trigger, not just this one.
  // `autoMinIntervalMs` exists to keep the retained pair hours apart, and the
  // caller stamps one field or the other per capture — so reading only
  // `lastAutoSnapshotAtMs` means a sentinel capture leaves it null and the very
  // next poll fires the threshold arm unconditionally (with a threshold set the
  // heap sits above it by definition — that is the PEN-3314 posture). That is a
  // second unrequested stop-the-world pause on an already-pressured worker, and
  // at `keep: 2` the post-write prune then evicts the hours-older half the
  // operator was accumulating. The sentinel arm deliberately keeps its own
  // field, so a human request still fires promptly after an automatic capture.
  // (Ally review, PEN-3631.)
  const lastAt = Math.max(
    state.lastAutoSnapshotAtMs ?? Number.NEGATIVE_INFINITY,
    state.lastSentinelSnapshotAtMs ?? Number.NEGATIVE_INFINITY,
  );
  if (Number.isFinite(lastAt) && runtime.now().getTime() - lastAt < config.autoMinIntervalMs) {
    return { trigger: null, sentinel };
  }
  return { trigger: "threshold", sentinel };
}

/**
 * The operator-facing log a decision owes, or `null` when it owes none.
 *
 * Split out as a pure function rather than inlined at the call site because the
 * defect it exists to prevent is *silence* — a declined request deleting the
 * only file the operator can see and logging nothing. Silence is not observable
 * from the decision alone, so it has to be assertable here.
 */
export interface HeapSnapshotSentinelLog {
  level: "info" | "warn";
  data: Record<string, unknown>;
  message: string;
}

export function describeSentinelOutcome(
  decision: HeapSnapshotDecision,
  config: HeapSnapshotConfig,
  state: { lastSentinelSnapshotAtMs: number | null },
): HeapSnapshotSentinelLog | null {
  const sentinelPath = path.join(config.dir, HEAP_SNAPSHOT_SENTINEL_BASENAME);
  switch (decision.sentinel) {
    case "rate-limited":
      return {
        // info, not warn: this is the rate limit working as designed, on a
        // request any pod on the shared claim can make. It is not a fault.
        level: "info",
        data: {
          sentinelPath,
          sentinelMinIntervalMs: config.sentinelMinIntervalMs,
          lastSentinelSnapshotAtMs: state.lastSentinelSnapshotAtMs,
        },
        message:
          "Heap snapshot request declined — too soon after the last sentinel snapshot. The request file was " +
          "deleted anyway (a request is honoured exactly once, declined or not), so its disappearance does NOT " +
          "mean a snapshot was taken and none will appear. Touch it again once sentinelMinIntervalMs has elapsed " +
          "since lastSentinelSnapshotAtMs.",
      };
    case "claim-failed":
      return {
        // warn, not info: unlike the rate limit this is nobody's design. The
        // worker creates snapshots in this same directory, so a delete it
        // cannot make is either a race with another replica (clears itself on
        // the next poll) or a permission fault (does not).
        level: "warn",
        data: { sentinelPath },
        message:
          "Heap snapshot request seen but not claimed — deleting the request file failed, so it was not honoured. " +
          "The file is still present. If this clears on the next poll another replica claimed it; if it repeats, " +
          "the worker cannot delete the file and the request path is wedged until it is removed by hand. " +
          "Threshold-triggered capture is unaffected and continues on its own interval.",
      };
    case "claimed":
    case "absent":
      // "claimed" needs nothing here: it snapshots, and the snapshot itself is
      // logged with its own credential-exposure warning.
      return null;
  }
}
