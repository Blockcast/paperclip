import { and, eq, ne } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

// BLO-27858: under a non-`git_worktree` strategy, realizeExecutionWorkspace
// returns `input.base.baseCwd` verbatim -- no per-run path, no ownership stamp,
// no advisory lock. Two concurrent runs of one agent therefore edit ONE working
// tree, and nothing in the execution plane notices.
//
// Why the existing guards do not cover this:
//
//   * issues.checkoutRunId / executionRunId (issue-run-holding.ts, BLO-19001)
//     is issue-scoped. Two runs legitimately checked out on two DIFFERENT
//     issues each hold their own lock and never collide -- yet they share the
//     directory. And for an UNSCOPED wake (no contextSnapshot.issueId) the
//     column is not written at dispatch at all (heartbeat.ts, "Fix A (lazy
//     locking)"), so the issue reads as unowned until the run itself calls
//     checkout -- 17 minutes into the measured incident.
//   * branch-run-claims.ts claims a git BRANCH. It catches only the subset of
//     shared-tree runs that converge on the same branch key.
//   * git-worktree-ownership.ts stamps only the `git_worktree` branch.
//
// The remedy here is deliberately a WARNING, not a refusal. `shared_workspace`
// is the fallback mode (execution-workspace-policy.ts) and the default
// maxConcurrentRuns is AGENT_DEFAULT_MAX_CONCURRENT_RUNS (20), so refusing the
// combination would stop essentially every agent in the fleet. Most runs never
// write, so the exposure is real but latent; the proportionate fix is to tell
// the run it is sharing a tree before it touches disk.

/**
 * Deliberately conservative: agent-scoped, not path-proven.
 *
 * We cannot prove two live runs resolved to the same directory, because no
 * per-run cwd is recorded anywhere (execution_workspaces.cwd is per
 * project/issue, not per run). The precise join -- sibling run -> its issue ->
 * its project -- would have to go through `issues.executionRunId`, which is
 * exactly the column that is null for the unscoped self-selecting runs this
 * hazard is about. Filtering on it would drop the dangerous case and keep the
 * safe one.
 *
 * So we count every live sibling run of the agent and say plainly in the
 * warning that the signal is agent-scoped. Same conservatism as
 * isRunHoldingIssue: over-report contention rather than miss it.
 */
export async function listSiblingRunningRunIds(
  db: Pick<Db, "select">,
  input: { companyId: string; agentId: string; selfRunId: string },
): Promise<string[]> {
  const rows = await db
    .select({ id: heartbeatRuns.id })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, input.companyId),
        eq(heartbeatRuns.agentId, input.agentId),
        eq(heartbeatRuns.status, "running"),
        ne(heartbeatRuns.id, input.selfRunId),
      ),
    );
  // Re-filter in JS rather than trusting the SQL `ne` alone. Self-exclusion is
  // the load-bearing property: without it every run reports itself as
  // contention, the warning fires universally, and a universal warning is
  // noise. Keeping it here also makes the guarantee directly testable instead
  // of true only by construction.
  return rows
    .map((row) => row.id)
    .filter((id) => id !== input.selfRunId)
    .sort();
}

/** How many sibling run ids to name before truncating. */
export const SHARED_CHECKOUT_WARNING_RUN_SAMPLE = 4;

/**
 * The warning text pushed onto RealizedExecutionWorkspace.warnings, which
 * heartbeat.ts folds into `context.paperclipWorkspace` -- i.e. it reaches the
 * run's own context before the agent process starts, and therefore before any
 * filesystem write. Returns null when there is no contention to report.
 */
export function formatSharedCheckoutOccupancyWarning(input: {
  cwd: string;
  strategyType: string;
  siblingRunIds: string[];
}): string | null {
  const { cwd, strategyType, siblingRunIds } = input;
  if (siblingRunIds.length === 0) return null;

  const sample = siblingRunIds.slice(0, SHARED_CHECKOUT_WARNING_RUN_SAMPLE);
  const remaining = siblingRunIds.length - sample.length;
  const named = sample.join(", ") + (remaining > 0 ? `, +${remaining} more` : "");
  const plural = siblingRunIds.length === 1 ? "run" : "runs";

  return [
    `SHARED CHECKOUT CONTENTION: ${siblingRunIds.length} other live ${plural} of this agent`,
    ` (${named}) while this workspace has no per-run isolation`,
    ` (strategy=${strategyType}, cwd=${cwd}).`,
    " This signal is agent-scoped, not path-proven: a sibling working a different project may not",
    " actually share this directory. Treat the tree as shared anyway.",
    " HEAD can move under you, so re-read 'git rev-parse HEAD' rather than caching it, and never",
    " leave a scratch or deliberately-failing mutation edit on disk -- another run can commit and",
    " push it. Confirm ownership (paperclipGetIssue -> activeRun) before editing, and prefer an",
    " isolated worktree for write-heavy work.",
  ].join("");
}

/**
 * Safe wrapper for the realization hot path: resolves the warning, or null when
 * there is nothing to report or not enough context to ask.
 *
 * Never throws. This is advisory telemetry on the path that provisions every
 * run's workspace; a failed count must not fail the run that was about to work.
 */
export async function describeSharedCheckoutOccupancy(input: {
  db: Pick<Db, "select"> | null;
  companyId: string;
  agentId: string | null;
  heartbeatRunId: string | null;
  cwd: string;
  strategyType: string;
}): Promise<string | null> {
  const { db, companyId, agentId, heartbeatRunId, cwd, strategyType } = input;
  // Without a db, an agent identity, and our own run id we cannot tell a
  // sibling from ourselves -- and counting ourselves as contention would warn
  // on every single-run agent. Stay silent rather than cry wolf.
  if (!db || !agentId || !heartbeatRunId) return null;
  try {
    const siblingRunIds = await listSiblingRunningRunIds(db, {
      companyId,
      agentId,
      selfRunId: heartbeatRunId,
    });
    return formatSharedCheckoutOccupancyWarning({ cwd, strategyType, siblingRunIds });
  } catch (error) {
    logger.warn(
      { err: error, companyId, agentId, heartbeatRunId },
      "shared-checkout occupancy probe failed; continuing without the warning",
    );
    return null;
  }
}
