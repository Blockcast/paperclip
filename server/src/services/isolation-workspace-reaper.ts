/**
 * Isolation-workspace reaper (BLO-31222).
 *
 * `buildK8sRunIsolationDescriptor` mounts every `isolationMode === "workspace"`
 * run under
 * `/paperclip/instances/default/data/k8s-isolation/workspaces/<executionWorkspaceId>`,
 * and **nothing has ever removed one**. That is not a leak in the usual sense —
 * there is no code path that tries and fails, there is simply no reaper. The
 * tree grew 0 -> 406.7 GiB between July and 2026-09-02 with no owner.
 *
 * It is billed to CephFS (`paperclip-data`, a 2 TiB quota on the `ssd-fast`
 * tier), so the growth lands directly on the pool that produced BLO-31222's
 * ~19-hours-to-write-block incident. Deleting the >30d cohort by hand during
 * that incident reclaimed real space, but a manual pass re-derives the whole
 * incident in roughly five weeks. This is the scheduled version of that pass.
 *
 * Four properties, each of which is load-bearing:
 *
 * 1. **Positive layout allowlist, not an age-only predicate.** A directory is
 *    removed only when its top level is exactly `{home, session}` — Claude
 *    scratch (`HOME`) and session state (`CLAUDE_CONFIG_DIR`). Anything else is
 *    skipped *unexamined*. When this cohort was audited by hand over 448 real
 *    directories, 447 matched and **one did not**: it carried `wt-blo-19094`, a
 *    real git worktree. An age-only `rm -rf` would have destroyed it. The
 *    allowlist costs ~0.2% of the reclaim and removes the entire class,
 *    including on future passes whose composition nobody has looked at.
 *
 * 2. **Opt-in, following `strandedRecoveryHandBack`.** This deletes files
 *    irreversibly. Defaulting it on would make "deploy the code" and "perform
 *    the deletion" the same act, with no run in between to inspect what the
 *    predicate actually matched. `dryRun` exists so the first enablement can be
 *    an observation.
 *
 * 3. **Idempotent and concurrency-tolerant.** Something else was observed
 *    reclaiming this same tree mid-incident (1,235 -> 1,065 dirs in ~5h, cause
 *    unidentified). Every directory is re-checked immediately before removal and
 *    a vanished entry is counted, not an error.
 *
 * 4. **Bounded per tick.** `maxDeletesPerTick` caps the unlink volume. Deletion
 *    here is MDS-metadata-bound, not data-bound — measured 145 files/s serial
 *    against a saturated MDS — so an unbounded sweep is a latency event for
 *    every other CephFS consumer on the cluster.
 *
 * Age is judged by `mtime` on the workspace directory. These directories are
 * keyed by **execution-workspace id, not run id**, so they are reusable and can
 * legitimately outlive any single run; `mtime` is what distinguishes "idle for a
 * month" from "between runs". Deleting a stale one costs a cold start, not
 * source: durable transcripts live separately under `data/run-logs/`.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { logger as defaultLogger } from "../middleware/logger.js";

/** Top-level entries a reapable isolation workspace may contain, sorted. */
export const REAPABLE_LAYOUT = ["home", "session"] as const;

export const DEFAULT_ISOLATION_WORKSPACE_ROOT =
  "/paperclip/instances/default/data/k8s-isolation/workspaces";

/** Per-tick unlink ceiling. Keeps MDS pressure bounded on a shared filesystem. */
export const DEFAULT_MAX_DELETES_PER_TICK = 200;

export interface IsolationWorkspaceReapOptions {
  root?: string;
  maxAgeDays: number;
  maxDeletesPerTick?: number;
  /** Classify and log, delete nothing. */
  dryRun?: boolean;
  now?: () => number;
  logger?: typeof defaultLogger;
}

export interface IsolationWorkspaceReapResult {
  scanned: number;
  eligible: number;
  deleted: number;
  /** Present but not matching the layout allowlist — deliberately untouched. */
  skippedLayout: number;
  /** Disappeared between scan and delete (concurrent reaper, or a live run). */
  vanished: number;
  failed: number;
  /** True when `maxDeletesPerTick` stopped the pass with work remaining. */
  capped: boolean;
}

function isReapableLayout(entries: string[]): boolean {
  if (entries.length !== REAPABLE_LAYOUT.length) return false;
  const sorted = [...entries].sort();
  return REAPABLE_LAYOUT.every((name, i) => sorted[i] === name);
}

/**
 * One sweep. Never throws for a per-directory fault: a single unreadable or
 * concurrently-removed workspace must not abort the pass.
 */
export async function reapIsolationWorkspaces(
  options: IsolationWorkspaceReapOptions,
): Promise<IsolationWorkspaceReapResult> {
  const root = options.root ?? DEFAULT_ISOLATION_WORKSPACE_ROOT;
  const maxDeletes = options.maxDeletesPerTick ?? DEFAULT_MAX_DELETES_PER_TICK;
  const now = options.now ?? Date.now;
  const log = options.logger ?? defaultLogger;
  const cutoff = now() - options.maxAgeDays * 86_400_000;

  const result: IsolationWorkspaceReapResult = {
    scanned: 0,
    eligible: 0,
    deleted: 0,
    skippedLayout: 0,
    vanished: 0,
    failed: 0,
    capped: false,
  };

  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (err) {
    // An absent root is the normal case on a non-k8s-isolation deployment.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return result;
    throw err;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    result.scanned += 1;

    if (result.deleted >= maxDeletes) {
      result.capped = true;
      break;
    }

    const dir = path.join(root, entry.name);

    let mtimeMs: number;
    try {
      mtimeMs = (await fs.stat(dir)).mtimeMs;
    } catch {
      result.vanished += 1;
      continue;
    }
    if (mtimeMs >= cutoff) continue;

    let children: string[];
    try {
      children = await fs.readdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") result.vanished += 1;
      else result.failed += 1;
      continue;
    }

    if (!isReapableLayout(children)) {
      result.skippedLayout += 1;
      // Logged individually and on purpose: a skip count above the historical
      // baseline of 1 means the tree is more heterogeneous than the allowlist
      // was validated against, and that is worth a human look before the next
      // pass widens.
      log.warn(
        { dir, layout: [...children].sort(), ageDays: (now() - mtimeMs) / 86_400_000 },
        "isolation-workspace reaper skipped a directory outside the layout allowlist",
      );
      continue;
    }

    result.eligible += 1;
    if (options.dryRun) continue;

    try {
      await fs.rm(dir, { recursive: true, force: true });
      result.deleted += 1;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") result.vanished += 1;
      else {
        result.failed += 1;
        log.error({ err, dir }, "isolation-workspace reaper failed to remove a workspace");
      }
    }
  }

  log.info(
    { root, maxAgeDays: options.maxAgeDays, dryRun: options.dryRun === true, ...result },
    "isolation-workspace reaper sweep complete",
  );
  return result;
}

export type IsolationWorkspaceReaperScheduler = {
  setInterval: (callback: () => void, intervalMs: number) => ReturnType<typeof setInterval>;
  clearInterval: (timer: ReturnType<typeof setInterval>) => void;
};

const defaultScheduler: IsolationWorkspaceReaperScheduler = { setInterval, clearInterval };

export function startIsolationWorkspaceReaper(
  intervalMs: number,
  options: IsolationWorkspaceReapOptions,
  scheduler: IsolationWorkspaceReaperScheduler = defaultScheduler,
): () => void {
  let inFlight: Promise<void> | null = null;
  const runTick = () => {
    // Ticks are serialized: a sweep that outruns its interval against a slow
    // MDS must not stack concurrent passes over the same tree.
    if (inFlight) return;
    inFlight = reapIsolationWorkspaces(options)
      .catch((err) => {
        defaultLogger.error({ err }, "isolation-workspace reaper sweep failed");
      })
      .then(() => undefined)
      .finally(() => {
        inFlight = null;
      });
  };

  runTick();
  const timer = scheduler.setInterval(runTick, intervalMs);
  return () => scheduler.clearInterval(timer);
}
