import path from "node:path";
import { and, eq, ne } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns } from "@paperclipai/db";
import type { AdapterRunIsolationDescriptor } from "../adapters/index.js";
import { resolveAgentEmptyWorkspaceSourceDir } from "../home-paths.js";
import { logger } from "../middleware/logger.js";

/** The one descriptor field the exemption reads. */
type IsolationWorkspaceStorage = {
  storage: Pick<AdapterRunIsolationDescriptor["storage"], "workspace">;
};

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
//
// The probe is invoked from heartbeat.ts against the FINAL resolved
// executionWorkspace, not from inside realizeExecutionWorkspace. That is
// load-bearing: provisionExecutionWorkspaceWithReuse only calls
// realizeWorkspace() when !policy.shouldRestoreExistingWorkspace, so probing
// inside realization would skip `reuse_existing` -- the mode that exists
// precisely to hand run 2+ the tree run 1 is using.

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
 *
 * "Live" here means `status = 'running'` only, deliberately narrower than
 * MAX_TURN_CONTINUATION_LIVE_RUN_STATUSES (which also counts `queued` and
 * `scheduled_retry`). A queued run holds no working tree yet, and the
 * under-report is self-correcting: when it does start, its own realization
 * runs this probe and sees us. Widening it here would warn about runs that
 * cannot yet touch the disk.
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
 * BLO-42212: does this run actually land in `executionWorkspace.cwd`?
 *
 * The probe used to exempt `git_worktree` and nothing else, and that missed the
 * commonest case on this fleet. `buildK8sRunIsolationDescriptor` relocates the
 * workspace to a per-run ephemeral root whenever `isolationMode === "run"` and
 * the run has no provisioned worktree -- which is every K8s run of a
 * concurrency-enabled agent on `project_primary`, including the repo-less
 * `empty-workspaces/<agentId>` fallback. Such a run never opens `cwd`, so
 * warning it about a sibling in that directory is false, and because the sibling
 * count is agent-scoped it fired on EVERY run of such an agent at once.
 * Measured 2026-10-11 on two live runs (Ally `23434662`, Staff `e502006e`): both
 * carried the warning naming `empty-workspaces/...` while their own
 * `paperclipK8sIsolation` read `isolationMode: "run"`, `storage.workspace:
 * "ephemeral"`, `workspaceRoot: /runtime-cache/paperclip-runs/<runId>/workspace`.
 *
 * That is the universality this module's own `listSiblingRunningRunIds` docs
 * argue against ("a universal warning is noise") -- the self-exclusion guard
 * closed one source of it and this was the other, larger one.
 *
 * Keyed on `storage.workspace`, not on `isolationMode`: the descriptor sets that
 * field from the same `usesEphemeralWorkspace` that picks `workspaceRoot`, and
 * its own comment requires the two to track exactly. `isolationMode === "run"`
 * alone is wrong -- a run pinned to a provisioned worktree is also mode `run`
 * yet keeps a persistent workspace.
 *
 * An ephemeral workspace is NECESSARY, not sufficient. A relocated run is still
 * told `executionWorkspace.cwd` is its workspace (`buildPaperclipWorkspaceContext`
 * publishes it), the pod mounts `/paperclip`, and BLO-31282 records exactly such
 * a `run:<runId>` run reaching for the project BASE checkout from its empty
 * scratch dir. So a repo-backed `project_primary` run keeps the warning: that is
 * the one case where the shared tree is real. The exemption also requires `cwd`
 * to be the agent's repo-less fallback, `empty-workspaces/<agentId>`
 * (BLO-18760), the only cwd with nothing in it to reach for -- and the cwd both
 * measured runs above named. Matched by exact path, not by
 * `repoUrl`/`projectId`: a managed project checkout can carry `repoUrl: null`,
 * and the agent-home fallback keeps the issue's `projectId`, so neither field
 * separates a real checkout from an empty one. The persistent agent home
 * (`workspaces/<agentId>`) is not exempt either; it accumulates a `.git`.
 *
 * Absent isolation (non-K8s adapters) means no relocation, so we still warn:
 * forgetting to pass it costs noise, never a missed real collision. The same
 * holds for a missing or malformed `agentId`: unprovable means warn.
 */
export function runLandsInSharedCheckout(input: {
  strategyType: string;
  cwd: string;
  agentId: string | null;
  isolation?: IsolationWorkspaceStorage | null;
}): boolean {
  // git_worktree gives every run its own path and stamps ownership, so there is
  // no shared tree to warn about.
  if (input.strategyType === "git_worktree") return false;
  if (input.isolation?.storage.workspace !== "ephemeral") return true;
  return !isRepoLessFallbackCwd(input.cwd, input.agentId);
}

function isRepoLessFallbackCwd(cwd: string, agentId: string | null): boolean {
  if (!agentId) return false;
  try {
    return path.resolve(cwd) === path.resolve(resolveAgentEmptyWorkspaceSourceDir(agentId));
  } catch {
    // Invalid agent id: the resolver refuses to build a path from it.
    return false;
  }
}

/**
 * The warning text. Its caller (heartbeat.ts) pushes it onto
 * `runtimeWorkspaceWarnings`, which is bound BY REFERENCE into
 * `context.paperclipWorkspace.warnings` and spread into the adapter context --
 * so it reaches the agent before the agent process starts, and therefore
 * before any filesystem write. The same array is also drained to the run log,
 * so a human triaging a mystery diff after the fact sees it too.
 *
 * Both audiences matter and the text is written for the agent, which is the
 * one that can still act on it. Returns null when there is no contention.
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
  /**
   * The run's resolved K8s isolation descriptor, when it has one. Omit for a
   * non-K8s run: that is the warn-anyway default (see
   * `runLandsInSharedCheckout`).
   */
  isolation?: IsolationWorkspaceStorage | null;
}): Promise<string | null> {
  const { db, companyId, agentId, heartbeatRunId, cwd, strategyType, isolation } = input;
  // Before the query, not after: a run that does not land in this tree should
  // cost nothing to clear.
  if (!runLandsInSharedCheckout({ strategyType, cwd, agentId, isolation })) return null;
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
