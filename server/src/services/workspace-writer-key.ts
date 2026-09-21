/**
 * BLO-31443 / BLO-19422: the equivalence class of the working tree a run will
 * write, used as the single-writer reservation key
 * (`external_runtime_reservations_active_isolation_writer_idx`).
 *
 * Deliberately dependency-free and in its own module: it is pure policy, it is
 * the half of the shared-checkout guarantee that has been wrong twice, and
 * keeping it importable without the heartbeat dependency graph is what lets it
 * be tested directly.
 *
 * The contract is one line: two runs that would share a directory must produce
 * the SAME string; two runs that would not must produce different ones. `null`
 * means "nothing shared to exclude on" and leaves the run's own run-unique key
 * in place.
 *
 * The class depends on which shape the run resolves to, and the two shapes key
 * on different things:
 *
 * - `runResolvesToOwnTree` (git worktree / isolated / explicitly reused
 *   workspace) -> key on the ISSUE. Under `per_issue` runScope the path is a
 *   pure function of the issue (identifier + title -> branch name -> directory,
 *   no run input), so the issue is exactly that class. Scoped by
 *   `projectWorkspaceId` because one issue can hold trees in several repos of a
 *   multi-repo project and those are genuinely independent.
 *
 * - otherwise (`project_primary`, the SHARED project checkout) -> key on the
 *   PROJECT WORKSPACE. `realizeExecutionWorkspace` returns `input.base.baseCwd`
 *   for every non-`git_worktree` strategy, so every issue of that project
 *   workspace lands in ONE directory. Keying on the issue here would reproduce
 *   the defect: two issues, two keys, one tree.
 *
 *   One caveat on that "returns baseCwd" claim, because it is load-bearing for
 *   anyone deciding what this key means: `rebindProjectPrimaryToManagedCheckout`
 *   can substitute a managed checkout resolved from `(companyId, projectId,
 *   repoName)` -- keyed by PROJECT + REPO, not by project workspace. Two project
 *   workspaces of one project pointing at one repo URL would therefore rebind to
 *   a single directory while holding two distinct keys here. Not reachable in
 *   any config today, and deliberately not defended against: keying on the
 *   project instead would over-serialize unrelated workspaces in every config
 *   that IS reachable. If that config ever becomes reachable, this key is the
 *   thing that has to change.
 *
 * BLO-19422 is that second branch. Every arm of the original predicate required
 * isolation or a worktree, so a shared-checkout run produced a null key and fell
 * through to `run:<runId>` in the resolver -- unique per run. Two such runs held
 * distinct writer keys and both wrote the same tree, which is the measured
 * defect (a torn read of an in-flight external edit failing a `go build`).
 *
 * Colliding DEFERS the second run -- `deferRunForK8sIsolationConflict` re-queues
 * it with backoff carrying `conflictingRunId` -- it does not fail it. That is
 * the deliberately cheap arm of the fix. Handing each run its own tree instead
 * costs a worktree plus a full dependency install per concurrent run (measured
 * on this repo: ~105 MB of tree and ~2.2 GB of node_modules), which is not
 * affordable on a volume already at 88%. Serializing runs that genuinely share
 * one mutable directory is the correct outcome, not a degradation.
 *
 * Two exclusions, and note the asymmetry between them:
 * - a stateless PR review is run-unique by construction (and is filtered in
 *   `resolveK8sRunIsolationIdentity` ahead of every other branch), so it never
 *   keys.
 * - `per_run` runScope excludes ONLY on the own-tree branch, where it appends a
 *   run token to the branch and hence to the directory. Under `project_primary`
 *   no branch or directory is derived at all, so `runScope: "per_run"` sitting
 *   on a non-worktree strategy does NOT make the run tree-unique -- those runs
 *   still share the base checkout and must still collide.
 *
 * Conservative where issue and path disagree: an issue retitled between runs
 * resolves to a NEW directory while keeping its id, so this over-serializes
 * rather than under-serializes. Serializing two runs that could have been
 * parallel costs latency; letting two runs share one tree corrupts a checkout.
 *
 * KNOWN GAP -- the first run of an un-backfilled issue is UNPROTECTED, and this
 * is accepted rather than fixed. The only source for `projectWorkspaceId` at
 * reservation-bind time is `issueRef`, but the run's actual workspace is not
 * resolved until ~600 lines later (`issueRef?.projectWorkspaceId ??
 * resolvedWorkspace.workspaceId`) and is written back onto the issue after
 * that. The id is a RESULT of the first run, not a precondition of it, so run 1
 * of a fresh issue keys null and only run 2 onward is excluded.
 *
 * Two consequences worth stating, because the second is a real (narrow) loss:
 *
 * - There is no sound fix available at bind time. Every candidate is a proxy
 *   with its own gap, and the reservation MUST bind before the workspace is
 *   realized -- binding after it would mean the loser has already mutated the
 *   tree it was supposed to be excluded from. Closing this properly means
 *   hoisting the workspace-base resolution above the bind, which is a dispatch-
 *   path change and not this row's scope.
 * - Now that the `agent-shared` exit is tree-scoped too (BLO-19422), a null key
 *   falls back to `agent-shared:<agentId>` and therefore no longer collides
 *   with the SAME agent's tree-keyed runs on that tree. Pre-BLO-19422 it did.
 *   That window needs two concurrent runs of one agent at effective
 *   concurrency 1, which requires the BLO-12990 silent-run exclusion from
 *   `countRunsOccupyingSlots`, and one of the two to be an un-backfilled first
 *   run. It is strictly narrower than the cross-agent case it buys: that one
 *   needs no loophole at all and is the measured defect.
 */
export function resolveWorkspaceWriterTreeKey(input: {
  statelessPrReview: boolean;
  runResolvesToOwnTree: boolean;
  usesPerRunScope: boolean;
  issue: { id: string | null; projectWorkspaceId: string | null } | null;
}): string | null {
  if (input.statelessPrReview) return null;
  if (input.runResolvesToOwnTree) {
    if (input.usesPerRunScope) return null;
    if (!input.issue?.id) return null;
    return `${input.issue.projectWorkspaceId ?? "no-project-workspace"}:${input.issue.id}`;
  }
  if (!input.issue?.projectWorkspaceId) return null;
  return `project-primary:${input.issue.projectWorkspaceId}`;
}
