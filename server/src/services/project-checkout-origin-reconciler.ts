/**
 * @fileoverview PEN-4188 (PEN-3633 item 5). Periodic origin <-> `repo_url`
 * reconciler for project checkouts.
 *
 * ## What it is for
 *
 * PEN-3628: one `url` line in one `.git/config` repointed the shared
 * `penstock-llm-proxy-core` checkout at `Blockcast/paperclip`. Every run
 * dispatched into that project was refused, 33 of them across 8.6 h, and the
 * fault was found ~3 h in by a manual board sweep. The two items ranked above
 * this one (PEN-3633 items 1 and 3) made that fault legible ONCE A RUN HAD
 * ALREADY BEEN SPENT: git's stderr stopped being swallowed, and the refusals
 * were aggregated into one project-scoped alert bucketed on the error body.
 *
 * This moves detection earlier than the first refusal. It asks the same
 * question the dispatch gate asks, on a timer, against every project checkout
 * -- so a repointed checkout is a page before a run is dispatched into it, not
 * after.
 *
 * ## What it does NOT cover, and must not be widened to cover
 *
 * PEN-3633 measured two episodes of the same `setup_failed` message class,
 * emitted by different branches of the same function:
 *
 * | | episode 1 (2026-09-29) | episode 2 (2026-10-05) |
 * |---|---|---|
 * | condition | origin identity != expected | `isGitCheckout(cwd)` false |
 * | origin URL at the time | wrong | CORRECT |
 * | does this reconciler fire? | yes | NO |
 *
 * This is 1 of 2 measured episodes by construction. Episode 2's checkout had
 * the right origin, so no origin comparison can see it; it is covered from the
 * run side by the `not_a_checkout` / `probe_indeterminate` buckets of
 * `workspace-reuse-refusal-metrics.ts`. Resist turning this into a general
 * checkout-health prober: a second probe of the same directory would publish a
 * second, differently-timed opinion of a condition that already has an owner,
 * and the two would disagree during every provisioning window.
 *
 * ## Why the unit of reporting is the project workspace
 *
 * Measured on PEN-3628: 565 of 570 issues in the affected project carried one
 * `projectWorkspaceId`, fanning out across ~86 `executionWorkspaceId` values
 * that all resolved to ONE `cwd`. Worktrees do not escape it either -- a
 * worktree's `.git` is a file pointing into the parent clone, so `git config`
 * reads the parent's config and one bad `url` line reaches all of them. This
 * sweep therefore iterates `project_workspaces` rows, so one broken checkout is
 * one series no matter how many issues, runs or worktrees hang off it.
 *
 * ## The `insteadOf` trap
 *
 * See the header of `project-checkout-origin.ts`. The short version: this
 * reconciler reads `git config --get remote.origin.url` (via the gate's own
 * `readGitOriginUrl`) and compares through `normalizeRepoIdentity`, because
 * `git remote -v` prints the SSH form on every healthy Blockcast checkout in
 * this estate and a verbatim comparison would page on all of them.
 */

import { and, isNotNull, ne, sql } from "drizzle-orm";
import path from "node:path";
import fs from "node:fs/promises";
import type { Db } from "@paperclipai/db";
import { projectWorkspaces } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { resolveManagedProjectWorkspaceDir } from "../home-paths.js";
import { compareProjectCheckoutOrigin } from "./project-checkout-origin.js";
import { deriveRepoNameFromRepoUrlForRuntime, readGitOriginUrl } from "./workspace-runtime.js";
import {
  setProjectCheckoutOriginMismatchMetrics,
  setProjectCheckoutOriginReconcileMetricsRefreshSuccess,
  type ProjectCheckoutOriginMismatchEntry,
} from "./metrics.js";

/**
 * Sweep cadence.
 *
 * Five minutes, not fifteen seconds. This is deliberately NOT in
 * `scrape-metrics-collector.ts`'s `REFRESHES`, and the reason is measured:
 * `/paperclip/instances/default/projects` holds 2,515 managed directories on
 * the production PVC, 665 of which contain a `.git` (measured 2026-10-16).
 * Those are process spawns
 * against a shared ceph filesystem, not a database query, and the collector
 * runs its refreshes in SERIES inside one tick -- so putting this there would
 * put a filesystem walk in front of every DB-backed gauge, which is the exact
 * coupling BLO-33243 moved off the scrape handler in the first place.
 *
 * Five minutes is also right on its own terms. The condition is a config edit
 * at operator timescale, and the thing it replaces is a manual board sweep that
 * took ~3 h on PEN-3628. Detection inside one interval is more than two orders
 * of magnitude earlier; polling faster buys nothing and costs spawns.
 */
export const PROJECT_CHECKOUT_ORIGIN_RECONCILE_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Per-probe `git config` timeout.
 *
 * The directories live on a shared network filesystem, so a wedged mount is a
 * real failure mode and an unbounded `git` would hold the whole pass behind it.
 * A timeout resolves to `null`, which this sweep counts as unreadable rather
 * than as health -- see {@link ProjectCheckoutOriginReconcileOutcome}.
 */
export const PROJECT_CHECKOUT_ORIGIN_PROBE_TIMEOUT_MS = 5_000;

/**
 * Hard wall-clock budget for one pass's probe phase.
 *
 * The non-overlap guard in {@link startProjectCheckoutOriginReconciler} is what
 * makes this necessary rather than merely tidy: a pass that never settles would
 * hold `ticking` forever, so the reconciler would stop sweeping while every
 * gauge kept its last value and the freshness gauge kept reading 1 -- a
 * detector that is dead and indistinguishable from a healthy one. That is the
 * precise failure `expireStaleRefreshFreshness` exists to catch for the scrape
 * collector, and this reconciler does not run under it.
 *
 * Each individual probe is already bounded ({@link PROJECT_CHECKOUT_ORIGIN_PROBE_TIMEOUT_MS}),
 * so the remaining exposure is the `fs.stat` on a wedged network mount, which
 * has no timeout of its own. Exceeding the budget is reported as a FAILED pass
 * -- freshness goes to 0, the mismatch snapshot is deliberately left standing
 * rather than zeroed, and the next tick starts clean.
 *
 * 120 s is ~26x the measured full-estate pass (2,515 managed directories, 665
 * with a `.git`, ~6.8 ms per probe => ~4.5 s strictly serial), and well inside
 * the 5-minute interval so a timed-out pass cannot collide with its successor.
 */
export const PROJECT_CHECKOUT_ORIGIN_PASS_BUDGET_MS = 120_000;

/** Thrown when a pass exceeds {@link PROJECT_CHECKOUT_ORIGIN_PASS_BUDGET_MS}. */
export class ProjectCheckoutOriginPassTimeoutError extends Error {
  constructor(budgetMs: number) {
    super(`project-checkout origin reconcile pass exceeded ${budgetMs}ms`);
    this.name = "ProjectCheckoutOriginPassTimeoutError";
  }
}

/**
 * Probes in flight at once.
 *
 * Measured cost of one probe on the production PVC: 20 spawns in 0.136 s,
 * ~6.8 ms each, so the full 665-checkout population is ~4.5 s even strictly
 * serial. The bound is therefore not about throughput -- it is a ceiling on how
 * many `git` processes this can have outstanding against a shared filesystem at
 * any instant, so a pathological estate cannot fork-bomb the pod.
 */
const PROBE_CONCURRENCY = 8;

/**
 * Workspace rows this sweep will read.
 *
 * Reaching it means the estate has grown an order of magnitude past the
 * measured 2,515 managed directories, at which point the counts become a lower
 * bound and the sweep says so rather than truncating quietly. Same contract as
 * `WORKSPACE_REUSE_REFUSAL_SCAN_LIMIT`.
 */
const WORKSPACE_SCAN_LIMIT = 20_000;

export type ProjectCheckoutOriginReconcileOutcome = {
  /**
   * Checkouts whose origin was actually read and compared. THE POSITIVE
   * CONTROL, and the reason it is published as a gauge rather than only logged:
   * `mismatches.length === 0` is worth nothing on its own, because a sweep that
   * probed nothing produces exactly the same number as a healthy estate. The
   * alert requires this to be non-zero.
   */
  compared: number;
  /** Rows whose checkout directory does not exist. Not a fault: an unprovisioned project looks exactly like this. */
  absent: number;
  /** Rows whose directory exists but whose origin could not be read (not a checkout, no origin, timeout). */
  unreadable: number;
  /** One entry per project workspace whose origin disagrees with its `repo_url`. */
  mismatches: ProjectCheckoutOriginMismatchEntry[];
  /** True when {@link WORKSPACE_SCAN_LIMIT} bit, so the caller knows the counts are a lower bound. */
  truncated: boolean;
};

type ProjectWorkspaceCheckoutRow = {
  id: string;
  companyId: string;
  projectId: string;
  cwd: string | null;
  repoUrl: string | null;
};

/**
 * Resolve the directory a project workspace's checkout lives in.
 *
 * Mirrors `deriveProjectCodebase`'s `effectiveLocalFolder`: an explicit `cwd`
 * wins, otherwise the managed path the runtime itself would bind, derived with
 * the runtime's own repo-name deriver. Exported for the tests, which assert
 * this against the managed layout rather than re-deriving it.
 */
export function resolveProjectCheckoutDir(row: ProjectWorkspaceCheckoutRow): string | null {
  const explicit = row.cwd?.trim();
  if (explicit) return path.resolve(explicit);
  const repoName = deriveRepoNameFromRepoUrlForRuntime(row.repoUrl);
  // No derivable repo name means the managed path would be the shared
  // `_default` directory, which is not this workspace's checkout and may well
  // be another one's. Refusing to guess keeps the sweep from comparing a
  // repo_url against a directory that was never cloned for it.
  if (!repoName) return null;
  try {
    return resolveManagedProjectWorkspaceDir({
      companyId: row.companyId,
      projectId: row.projectId,
      repoName,
    });
  } catch {
    // `resolveManagedProjectWorkspaceDir` throws on a blank company/project id.
    // A malformed row is not a reconciliation verdict; drop it rather than
    // aborting the pass and reporting a refresh failure for the whole estate.
    return null;
  }
}

async function directoryExists(value: string): Promise<boolean> {
  return fs.stat(value).then((stats) => stats.isDirectory()).catch(() => false);
}

export interface ReconcileProjectCheckoutOriginsOptions {
  /** Test seam. Default: `fs.stat`. */
  directoryExists?: (cwd: string) => Promise<boolean>;
  /** Test seam. Default: the dispatch gate's own `readGitOriginUrl`. */
  readOriginUrl?: (cwd: string) => Promise<string | null>;
  probeConcurrency?: number;
  passBudgetMs?: number;
}

/** Run the probes with a bounded number in flight, preserving input order in the result. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Settle `work` or reject with {@link ProjectCheckoutOriginPassTimeoutError}.
 *
 * The orphaned work is deliberately NOT cancelled -- there is nothing to cancel
 * it with, every probe it holds is independently timed out, and its result is
 * discarded. What matters is that THIS pass settles, so the caller's
 * non-overlap guard is released and the next tick can run.
 */
async function withPassBudget<T>(budgetMs: number, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ProjectCheckoutOriginPassTimeoutError(budgetMs)), budgetMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Compare every project checkout's actual git origin against the `repo_url` its
 * project workspace expects, and publish the disagreements.
 *
 * Does NOT wait on a dispatch. That is the whole point of the row: a project
 * whose checkout is repointed stops dispatching successfully, so any detector
 * that needed a new successful run to report would go quiet exactly when the
 * fault got worse.
 */
export async function reconcileProjectCheckoutOrigins(
  db: Db,
  options: ReconcileProjectCheckoutOriginsOptions = {},
): Promise<ProjectCheckoutOriginReconcileOutcome> {
  const statDir = options.directoryExists ?? directoryExists;
  const readOrigin =
    options.readOriginUrl
    ?? ((cwd: string) => readGitOriginUrl(cwd, { timeoutMs: PROJECT_CHECKOUT_ORIGIN_PROBE_TIMEOUT_MS }));

  try {
    const rows: ProjectWorkspaceCheckoutRow[] = await db
      .select({
        id: projectWorkspaces.id,
        companyId: projectWorkspaces.companyId,
        projectId: projectWorkspaces.projectId,
        cwd: projectWorkspaces.cwd,
        repoUrl: projectWorkspaces.repoUrl,
      })
      .from(projectWorkspaces)
      .where(
        and(
          // A workspace with no expected repository has nothing to disagree
          // with; `compareProjectCheckoutOrigin` would return
          // `no_expected_repo_url` for every one of them.
          isNotNull(projectWorkspaces.repoUrl),
          ne(projectWorkspaces.repoUrl, ""),
        ),
      )
      // Deterministic cut if the scan limit ever bites.
      .orderBy(sql`${projectWorkspaces.id} asc`)
      .limit(WORKSPACE_SCAN_LIMIT);

    const truncated = rows.length >= WORKSPACE_SCAN_LIMIT;
    if (truncated) {
      logger.warn(
        { scanLimit: WORKSPACE_SCAN_LIMIT },
        "project-checkout origin reconciler hit its workspace scan limit; results are a lower bound",
      );
    }

    const probeAll = mapWithConcurrency(
      rows,
      options.probeConcurrency ?? PROBE_CONCURRENCY,
      async (row) => {
        const cwd = resolveProjectCheckoutDir(row);
        if (!cwd) return { row, outcome: "absent" as const };
        // One `stat` before one spawn. On the measured estate ~1,850 of 2,515
        // managed directories hold no checkout, so this is the difference
        // between ~665 spawns a pass and ~2,515 doomed ones.
        if (!await statDir(cwd)) return { row, outcome: "absent" as const };

        const verdict = compareProjectCheckoutOrigin({
          cwd,
          expectedRepoUrl: row.repoUrl,
          actualUrl: await readOrigin(cwd),
        });
        return { row, cwd, verdict, outcome: "probed" as const };
      },
    );
    const probes = await withPassBudget(
      options.passBudgetMs ?? PROJECT_CHECKOUT_ORIGIN_PASS_BUDGET_MS,
      probeAll,
    );

    const outcome: ProjectCheckoutOriginReconcileOutcome = {
      compared: 0,
      absent: 0,
      unreadable: 0,
      mismatches: [],
      truncated,
    };

    for (const probe of probes) {
      if (probe.outcome === "absent") {
        outcome.absent += 1;
        continue;
      }
      const { verdict } = probe;
      if (verdict.state === "unknown") {
        outcome.unreadable += 1;
        continue;
      }
      outcome.compared += 1;
      if (verdict.state !== "mismatch") continue;
      outcome.mismatches.push({
        projectWorkspaceId: probe.row.id,
        companyId: probe.row.companyId,
        projectId: probe.row.projectId,
        cwd: probe.cwd,
        actualUrl: verdict.actualUrl,
        expectedRepoUrl: verdict.expectedRepoUrl,
      });
    }

    setProjectCheckoutOriginMismatchMetrics(outcome.mismatches, outcome.compared);
    setProjectCheckoutOriginReconcileMetricsRefreshSuccess(true);

    for (const mismatch of outcome.mismatches) {
      // Logged as well as gauged. The gauge is what pages; this is what the
      // responder reads, because PEN-3628's own `failureSummary` truncated
      // mid-causal-clause and sent the first responder after a workspace that
      // was healthy the whole time. Both URLs, in full, in one line.
      logger.error(
        {
          projectWorkspaceId: mismatch.projectWorkspaceId,
          companyId: mismatch.companyId,
          projectId: mismatch.projectId,
          cwd: mismatch.cwd,
          actualOriginUrl: mismatch.actualUrl,
          expectedRepoUrl: mismatch.expectedRepoUrl,
        },
        "project checkout origin does not match the project workspace repo_url",
      );
    }

    logger.debug(
      {
        compared: outcome.compared,
        absent: outcome.absent,
        unreadable: outcome.unreadable,
        mismatches: outcome.mismatches.length,
      },
      "project-checkout origin reconcile pass complete",
    );

    return outcome;
  } catch (error) {
    // Same contract as `refreshWorkspaceReuseRefusalMetrics`: do NOT publish
    // synthetic zeros. Zeroing the mismatch gauge would read as "every checkout
    // is correct", which is the one conclusion a failed sweep cannot support.
    // The freshness gauge makes the stale snapshot ineligible for the alert and
    // pages its own failure instead.
    setProjectCheckoutOriginReconcileMetricsRefreshSuccess(false);
    throw error;
  }
}

export interface ProjectCheckoutOriginReconcilerOptions
  extends ReconcileProjectCheckoutOriginsOptions {
  intervalMs?: number;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
}

/**
 * Start the periodic reconciler. Returns a stop function, matching the shape of
 * the other pollers wired in `app.ts`.
 */
export function startProjectCheckoutOriginReconciler(
  db: Db,
  options: ProjectCheckoutOriginReconcilerOptions = {},
): () => void {
  const intervalMs = options.intervalMs ?? PROJECT_CHECKOUT_ORIGIN_RECONCILE_INTERVAL_MS;
  const scheduleInterval = options.setInterval ?? setInterval;
  const clearIntervalFn = options.clearInterval ?? clearInterval;

  let ticking = false;
  let stopped = false;

  async function tick(): Promise<void> {
    // A pass can outlive its interval on a slow filesystem; overlapping passes
    // would double the spawn pressure that slowness is already evidence of.
    if (ticking || stopped) return;
    ticking = true;
    try {
      await reconcileProjectCheckoutOrigins(db, options);
    } catch (err) {
      logger.warn({ err }, "project-checkout origin reconcile pass failed");
    } finally {
      ticking = false;
    }
  }

  void tick();
  const timer = scheduleInterval(() => {
    void tick();
  }, intervalMs);
  timer.unref?.();

  return () => {
    stopped = true;
    clearIntervalFn(timer);
  };
}
