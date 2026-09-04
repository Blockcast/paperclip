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
 *    unidentified). Every signal the delete decision rests on — existence,
 *    layout, and `lastUsedAt` — is re-checked immediately before removal, and a
 *    vanished entry is counted, not an error.
 *
 * 4. **Bounded per tick.** `maxDeletesPerTick` caps the unlink volume. Deletion
 *    here is MDS-metadata-bound, not data-bound — measured 145 files/s serial
 *    against a saturated MDS — so an unbounded sweep is a latency event for
 *    every other CephFS consumer on the cluster.
 *
 * **Idleness comes from the database, not from the filesystem.** These
 * directories are keyed by **execution-workspace id, not run id**, so they are
 * reusable and legitimately outlive any single run — which makes "how long since
 * this was last used" the only safe question to ask before deleting one.
 *
 * An earlier revision of this module asked it of the directory's own `mtime`.
 * That was wrong, and wrong in the dangerous direction. A directory's `mtime`
 * advances only when a **direct child entry** is added, removed, or renamed —
 * never when nested content is written. For `isolationMode === "workspace"` the
 * only top-level children are `home` and `session`
 * (`heartbeat.ts:6429,6434`); `cacheRoot` and `tmpRoot` are deliberately routed
 * elsewhere (`heartbeat.ts:6437,6441`). Both are created once at materialization
 * and never again, so the root's `mtime` **is its creation time and never
 * advances with use**. `maxAgeDays` therefore meant "materialized more than N
 * days ago", not "idle for N days" — and since the directory name is
 * `execution_workspaces.id` (`heartbeat.ts:6340-6344`), a workspace in active
 * daily use that happened to be materialized 31 days ago was eligible for
 * irreversible deletion on the reaper's first pass. `storage.home` and
 * `storage.session` are both `"persistent"` (`heartbeat.ts:6458-6459`), so what
 * that would destroy is durable per-workspace state.
 *
 * So the age test resolves each directory name against `execution_workspaces`,
 * and deletes only when **every available signal says idle**:
 *
 * - **Row found** -> gate on `lastUsedAt`, which *is* maintained on use: the
 *   workspace-restore path refreshes it on every reuse
 *   (`heartbeat.ts:27159`), as does creation (`heartbeat.ts:27186`). The column
 *   is `notNull` (`execution_workspaces.ts:35`).
 * - **No row** -> the true orphan cohort this reaper is aimed at, and the only
 *   population with no database truth to consult. Here filesystem age carries
 *   the decision, where "materialized more than N days ago with no owning row"
 *   is exactly the intended meaning. Taking `max(mtime)` of `home`/`session`
 *   instead would not help: the same rule applies one level down.
 *
 * `mtime` is still consulted for every directory, because being a useless
 * *deletion* signal does not make it a useless *retention* one: a workspace
 * materialized yesterday cannot have been idle for a month, whatever a stale
 * row says. Requiring both can only ever retain more.
 *
 * Because `lastUsedAt` is the only signal that can protect a live workspace, it
 * is also the only one whose staleness is dangerous, and the sweep's opening
 * snapshot is exactly that: a read taken potentially minutes before the unlink
 * it authorizes. So it is re-read per directory immediately before `fs.rm`.
 * Neither of the other two re-checks can substitute — a run resuming a
 * long-idle workspace refreshes the row and writes under `home`/`session`,
 * which changes the root's existence not at all, its top-level layout not at
 * all, and (per the paragraph above) its `mtime` not at all.
 *
 * Deleting a genuinely idle workspace costs a cold start, not source: durable
 * transcripts live separately under `data/run-logs/`.
 */
import { inArray } from "drizzle-orm";
import fs from "node:fs/promises";
import path from "node:path";
import type { Db } from "@paperclipai/db";
import { executionWorkspaces } from "@paperclipai/db";
import { logger as defaultLogger } from "../middleware/logger.js";

/** Top-level entries a reapable isolation workspace may contain, sorted. */
export const REAPABLE_LAYOUT = ["home", "session"] as const;

export const DEFAULT_ISOLATION_WORKSPACE_ROOT =
  "/paperclip/instances/default/data/k8s-isolation/workspaces";

/** Per-tick unlink ceiling. Keeps MDS pressure bounded on a shared filesystem. */
export const DEFAULT_MAX_DELETES_PER_TICK = 200;

/** Directory names are `execution_workspaces.id`; anything else cannot resolve. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What the control plane knows about a workspace the filesystem cannot tell us. */
export interface WorkspaceUsageRow {
  lastUsedAt: Date;
  status: string;
  closedAt: Date | null;
}

/**
 * Resolves directory names to owning `execution_workspaces` rows. Injected so
 * the age predicate — the part of this module that decides what gets deleted —
 * is testable without an embedded Postgres, and therefore runs on every host
 * rather than being skipped on some.
 *
 * Called twice per sweep in the live path: once batched over every directory,
 * then once per prospective unlink to re-check the one row that matters.
 */
export type WorkspaceUsageLookup = (ids: string[]) => Promise<Map<string, WorkspaceUsageRow>>;

/**
 * The production lookup. Served by the primary key — the predicate is
 * `id IN (...)`, and the only index touching `lastUsedAt` is
 * `execution_workspaces_company_last_used_idx` on `(companyId, lastUsedAt)`
 * (`execution_workspaces.ts:59-62`), whose leading column this query does not
 * constrain. The PK is the better path anyway; the note is here so nobody
 * "optimizes" toward an index that was never in play.
 */
export function createDbWorkspaceUsageLookup(db: Db): WorkspaceUsageLookup {
  return async (ids) => {
    const resolvable = ids.filter((id) => UUID_PATTERN.test(id));
    const found = new Map<string, WorkspaceUsageRow>();
    if (resolvable.length === 0) return found;

    const rows = await db
      .select({
        id: executionWorkspaces.id,
        lastUsedAt: executionWorkspaces.lastUsedAt,
        status: executionWorkspaces.status,
        closedAt: executionWorkspaces.closedAt,
      })
      .from(executionWorkspaces)
      .where(inArray(executionWorkspaces.id, resolvable));

    for (const row of rows) {
      found.set(row.id, {
        lastUsedAt: row.lastUsedAt,
        status: row.status,
        closedAt: row.closedAt,
      });
    }
    return found;
  };
}

export interface IsolationWorkspaceReapOptions {
  root?: string;
  maxAgeDays: number;
  maxDeletesPerTick?: number;
  /** Classify and log, delete nothing. */
  dryRun?: boolean;
  now?: () => number;
  logger?: typeof defaultLogger;
  /**
   * Required, and deliberately not defaulted. Any default here is fail-open:
   * "no rows" routes every directory to the filesystem fallback, which is the
   * predicate this module exists to stop using. Callers must state where
   * idleness comes from.
   */
  lookupWorkspaceUsage: WorkspaceUsageLookup;
}

export interface IsolationWorkspaceReapResult {
  scanned: number;
  eligible: number;
  deleted: number;
  /** Present but not matching the layout allowlist — deliberately untouched. */
  skippedLayout: number;
  /** Resolved to a workspace row used inside the window — the live cohort. */
  retainedInUse: number;
  /**
   * Materialized inside the window, so it cannot have been idle longer than it
   * has existed. Counted rather than left as the arithmetic remainder, so an
   * operator reading a sweep log can name every outcome: with no concurrent
   * removals, `scanned` is exactly
   * `retainedFresh + retainedInUse + skippedLayout + eligible`.
   */
  retainedFresh: number;
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
  const lookupWorkspaceUsage = options.lookupWorkspaceUsage;
  const cutoff = now() - options.maxAgeDays * 86_400_000;

  const result: IsolationWorkspaceReapResult = {
    scanned: 0,
    eligible: 0,
    deleted: 0,
    skippedLayout: 0,
    retainedInUse: 0,
    retainedFresh: 0,
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

  const directories = entries.filter((entry) => entry.isDirectory());
  // One batched query for the whole sweep, rather than a round trip per directory.
  const usage = await lookupWorkspaceUsage(directories.map((entry) => entry.name));

  for (const entry of directories) {
    result.scanned += 1;
    const dir = path.join(root, entry.name);
    const owner = usage.get(entry.name);

    // The age test: delete only when EVERY available signal says idle.
    //
    // `lastUsedAt` is the authoritative one and the only one that can keep a
    // live workspace alive — see the module doc comment. Filesystem `mtime` is
    // materialization time, so it is a valid *retention* signal even though it
    // is a useless deletion signal: a directory materialized yesterday cannot
    // have been idle for a month, whatever a stale row claims. Requiring both
    // can only ever retain more, which is the correct bias for an irreversible
    // operation, and it costs one `stat`.
    let idleSinceMs: number;
    try {
      idleSinceMs = (await fs.stat(dir)).mtimeMs;
    } catch {
      result.vanished += 1;
      continue;
    }
    if (idleSinceMs >= cutoff) {
      result.retainedFresh += 1;
      continue;
    }

    if (owner) {
      // A row exists, so the filesystem no longer gets a vote on deletion.
      idleSinceMs = owner.lastUsedAt.getTime();
      if (idleSinceMs >= cutoff) {
        result.retainedInUse += 1;
        continue;
      }
    }

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
        {
          dir,
          layout: [...children].sort(),
          ageDays: (now() - idleSinceMs) / 86_400_000,
          ageSource: owner ? "lastUsedAt" : "mtime",
        },
        "isolation-workspace reaper skipped a directory outside the layout allowlist",
      );
      continue;
    }

    // Cap on the work a real pass would perform, not on unlinks already done, so
    // that a dry run stops at the same directory a live run would and a tick
    // whose remaining entries were all retained does not report itself capped.
    if (result.eligible >= maxDeletes) {
      result.capped = true;
      result.scanned -= 1;
      break;
    }

    // Property 3, for the one signal that can protect a live workspace.
    //
    // Existence and layout were both re-checked just above, and neither can see
    // a resurrection: restoring a workspace refreshes `lastUsedAt` and writes
    // *under* `home`/`session`, leaving the root present, its top level
    // unchanged, and its `mtime` unchanged. So the sweep's opening snapshot is
    // the only stale input here — and it is not stale by a hair. `maxDeletes`
    // unlinks against an MDS measured at 145 files/s serial can hold that
    // window open for minutes, which is long enough for a run to restore this
    // workspace and start writing to it. Deleting underneath such a run is
    // strictly worse than the cold start this module budgets for.
    //
    // One primary-key lookup per prospective unlink, at most `maxDeletes` per
    // tick on a pass that runs daily — negligible against the unlink it guards.
    // `dryRun` skips it, so a preview still costs exactly one query; the
    // consequence is that a dry run may report as eligible a workspace the live
    // pass would then retain, which is the harmless direction.
    //
    // A lookup fault propagates and ends the tick rather than being swallowed
    // per directory: unlike an unreadable directory it is not local to one
    // entry, and the fail-closed reading of "cannot confirm idle" is "do not
    // delete". The next tick retries from a fresh snapshot.
    if (!options.dryRun) {
      const current = (await lookupWorkspaceUsage([entry.name])).get(entry.name);
      if (current && current.lastUsedAt.getTime() >= cutoff) {
        result.retainedInUse += 1;
        continue;
      }
    }

    result.eligible += 1;

    if (options.dryRun) {
      // The operator inspecting a dry run has to be able to tell a true orphan
      // from a workspace the database still owns; printing the age source is
      // what makes that distinction visible before the first live pass.
      log.info(
        {
          dir,
          idleSince: new Date(idleSinceMs).toISOString(),
          ageDays: (now() - idleSinceMs) / 86_400_000,
          ageSource: owner ? "lastUsedAt" : "mtime",
          status: owner?.status ?? null,
          closedAt: owner?.closedAt?.toISOString() ?? null,
        },
        "isolation-workspace reaper would remove a workspace (dry run)",
      );
      continue;
    }

    try {
      // No `force`: a directory that vanishes mid-sweep must raise ENOENT so it
      // is counted as `vanished` rather than silently reported as a deletion.
      await fs.rm(dir, { recursive: true });
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
  db: Db,
  intervalMs: number,
  options: Omit<IsolationWorkspaceReapOptions, "lookupWorkspaceUsage"> &
    Partial<Pick<IsolationWorkspaceReapOptions, "lookupWorkspaceUsage">>,
  scheduler: IsolationWorkspaceReaperScheduler = defaultScheduler,
): () => void {
  const log = options.logger ?? defaultLogger;
  // Built once: the lookup holds no per-sweep state, and building it per tick
  // would only re-close over the same handle.
  const sweepOptions: IsolationWorkspaceReapOptions = {
    ...options,
    lookupWorkspaceUsage: options.lookupWorkspaceUsage ?? createDbWorkspaceUsageLookup(db),
  };
  let inFlight: Promise<void> | null = null;
  const runTick = () => {
    // Ticks are serialized: a sweep that outruns its interval against a slow
    // MDS must not stack concurrent passes over the same tree.
    if (inFlight) return;
    inFlight = reapIsolationWorkspaces(sweepOptions)
      .catch((err) => {
        log.error({ err }, "isolation-workspace reaper sweep failed");
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
