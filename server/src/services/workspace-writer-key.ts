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
 * That contract depends on the index being keyed on `isolation_key` ALONE
 * (migration 0130: `ON (isolation_key) WHERE released_at IS NULL AND
 * isolation_key IS NOT NULL`). Adding `isolation_mode` to it would silently
 * un-exclude every mixed-mode pair this relies on -- agent A at concurrency 1
 * (mode `shared`) and agent B at concurrency 3 (mode `run`) on one project
 * workspace produce the same key and MUST collide. Every test here would still
 * pass while that case stayed broken.
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
 *   keys. BLO-42212: `statelessPrReview` is now TWO populations, not one -- a
 *   webhook-born review and a hand-filed review row carrying
 *   `STATELESS_REVIEW_WORKSPACE_LABEL`. Both are run-unique for the same
 *   reason (neither lands in the shared checkout at all); see
 *   `runUsesStatelessReviewWorkspace` for why the label does not instead feed
 *   `derivePaperclipPrReview`.
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
 * FIRST RUN OF AN UN-BACKFILLED ISSUE (BLO-37188). `issue.projectWorkspaceId`
 * is a RESULT of an issue's first run, not a precondition of it: it is written
 * back as `issueRef?.projectWorkspaceId ?? resolvedWorkspace.workspaceId` only
 * after the workspace is realized, ~600 lines below the bind. So on run 1 the
 * issue carries null, and keying on it alone returned null -- no exclusion at
 * all, on either branch. `projectWorkspaceFallbackId` closes that: the caller
 * reproduces, at bind time, the same selection the late path will make when the
 * issue names no workspace, and this coalesces onto it.
 *
 * That selection is FIRST ROW IN CREATION ORDER, not the `isPrimary` row. The
 * two differ whenever a project flags a primary that is not its earliest row,
 * and the late path does not consult the flag on this route:
 * `prioritizeProjectWorkspaceCandidatesForRun(rows, null)` returns `rows`
 * untouched, `isNonPrimaryWorkspaceTarget` is false with no preferred id so
 * every row stays a candidate, and the realization loop takes the first one
 * whose cwd resolves. `resolveProjectPrimaryWorkspaceId` is the wrong helper
 * here and would key a different workspace than the run lands in.
 *
 * It is still a proxy, because which row realizes is not knowable at bind time,
 * and it has two residuals:
 *
 * - SOME rows fail and a later one wins: the run lands in that later tree while
 *   holding row 0's key. It over-serializes against other runs on row 0 (costs
 *   latency) and under-serializes against runs on the row that won -- exactly
 *   the pre-BLO-37188 state, so no regression.
 * - NO row realizes: `resolveWorkspaceForRun` does not fail, it falls back to
 *   `resolveDefaultAgentWorkspaceDir(agent.id)`, the agent home. Pre-BLO-37188
 *   that run keyed null and fell to `agent-shared:<agentId>`, the class that
 *   names the agent home exactly. Now it keys `project-primary:<row0>`: it is
 *   serialized against a project tree it never touches, and is NO LONGER
 *   excluded against the same agent's null-keyed runs in that same agent home.
 *   That mis-keys OFF `agent-shared`, in the UNSAFE direction (under-
 *   serialization on a shared directory). It needs every candidate cwd to be
 *   absent (the `missingProjectCwds` path), and is accepted because what it
 *   trades against -- run 1 of every fresh issue going unexcluded -- is the
 *   common case.
 *
 * Fully closing both needs the realized path itself, i.e. hoisting
 * workspace-base resolution above the bind; the reservation MUST bind first,
 * because binding after realization means the loser has already mutated the
 * tree it was supposed to be excluded from.
 *
 * The caller must NOT pass a fallback for a run that resolves to the agent home
 * rather than a project checkout (`agent_default` mode, where
 * `resolveWorkspaceForRun` is called with `useProjectWorkspace: false` and
 * considers no project workspace rows at all). Such a run shares no project
 * tree, and keying it on one would serialize unrelated agents against each
 * other for nothing. `resolveProjectIdNeedingWorkspaceFallback` is that gate.
 */
/**
 * BLO-42212: the issue label that marks a HAND-FILED PR-review row as one that
 * needs no durable checkout, so it is isolated exactly like a webhook-born
 * review -- `run:<runId>`, ephemeral workspace, null writer key.
 *
 * THE MEASURED DEFECT. A review row filed by hand (not by the GitHub webhook)
 * wakes as `issue_assigned`, so `derivePaperclipPrReview` returns null for it:
 * that function keys on `wakeReason` starting `github_pr_` or `reviewKind:
 * "pr_review"`, both of which only the signed-webhook path writes. The row then
 * falls through to the `project_primary` branch below. Onprem review rows are
 * bound to one project workspace (a workaround for BLO-40317, which otherwise
 * refuses them dispatch), so EVERY such review collides on
 * `project-primary:b194eb56...` and the lane runs one review at a time behind a
 * single isolation writer -- measured 2026-10-09 at ~3-4 reviews/hour against
 * ~40 waiting heads, with deferral retries reaching attempt 25 (~2h).
 *
 * WHY THIS WIDENS THE ISOLATION PREDICATE AND NOT `derivePaperclipPrReview`.
 * The obvious fix -- make a hand-filed row look like a webhook review by
 * injecting `reviewKind`/`githubPrNumber` into its context -- is NOT available.
 * `derivePaperclipPrReview` also projects `prAuthorLogin`, which the
 * reviewer-output gate trusts as signed-webhook data to anchor a self-review
 * skip (BLO-9293). Forging the wake context to buy isolation would hand that
 * gate unsigned input. So the two facts are separated here: `statelessPrReview`
 * answers "does this run write a shared tree", and it is isolation-only -- grep
 * it, every consumer is a key/root derivation, none grants trust.
 *
 * WHY A LABEL IS SAFE TO LET AGENTS SET. Marking a row does not un-exclude a
 * run from a tree it still touches; it moves the run OFF that tree.
 * `buildK8sRunIsolationDescriptor` forces `hasProvisionedWorktree` false for a
 * stateless review, so `workspaceRoot` becomes
 * `/runtime-cache/paperclip-runs/<runId>/workspace` on EPHEMERAL storage. The
 * run cannot reach the shared checkout, which is why dropping its writer key is
 * correct rather than merely cheap -- it satisfies this module's contract
 * literally: null means "nothing shared to exclude on". A self-applied label
 * therefore costs the applier a warm checkout and can corrupt nothing.
 *
 * THE ONE HAZARD, and it is the loud kind: label a row that genuinely needs the
 * project checkout and its run starts in an empty directory. That fails
 * immediately and visibly on the first path that is not there. It does not
 * silently tear a shared tree, which is the failure this module exists to
 * prevent.
 *
 * WHY NOT A PER-RUN WORKTREE instead (the other option on BLO-42212): a
 * worktree per concurrent run costs persistent volume on a filesystem measured
 * at 88% with BLO-41473 (Thanos compactor sharing the control-plane Ceph quota)
 * still open. Ephemeral run storage costs none of it, and is the profile
 * webhook reviews have run on all along -- so this is the already-proven path,
 * not a new one.
 */
export const STATELESS_REVIEW_WORKSPACE_LABEL = "stateless-review";

/**
 * Does this run get a run-unique ephemeral workspace instead of a shared tree?
 *
 * Two populations, and they are deliberately derived from different sources: a
 * webhook-born PR review (trusted signed context) and a hand-filed review row
 * carrying `STATELESS_REVIEW_WORKSPACE_LABEL` (operator-applied issue label).
 * See that constant for why the label may not simply feed
 * `derivePaperclipPrReview` instead.
 */
export function runUsesStatelessReviewWorkspace(input: {
  webhookPrReview: boolean;
  issueLabelNames?: readonly string[] | null;
}): boolean {
  return input.webhookPrReview
    || (input.issueLabelNames ?? []).includes(STATELESS_REVIEW_WORKSPACE_LABEL);
}

export function resolveWorkspaceWriterTreeKey(input: {
  statelessPrReview: boolean;
  runResolvesToOwnTree: boolean;
  usesPerRunScope: boolean;
  issue: { id: string | null; projectWorkspaceId: string | null } | null;
  /**
   * Bind-time stand-in for `issue.projectWorkspaceId` while it is still null.
   * Omit (or pass null) when the run resolves to no project checkout.
   */
  projectWorkspaceFallbackId?: string | null;
}): string | null {
  if (input.statelessPrReview) return null;
  const projectWorkspaceId = input.issue?.projectWorkspaceId ?? input.projectWorkspaceFallbackId ?? null;
  if (input.runResolvesToOwnTree) {
    if (input.usesPerRunScope) return null;
    if (!input.issue?.id) return null;
    return `${projectWorkspaceId ?? "no-project-workspace"}:${input.issue.id}`;
  }
  if (!projectWorkspaceId) return null;
  return `project-primary:${projectWorkspaceId}`;
}

/**
 * Which project, if any, the caller must resolve a `projectWorkspaceFallbackId`
 * for (BLO-37188). Null means "pass no fallback, and do not query for one":
 *
 * - a stateless PR review keys null on both branches regardless;
 * - an issue that already names a workspace is authoritative;
 * - `useProjectWorkspace` false (`agent_default`) means `resolveWorkspaceForRun`
 *   considers no project workspace rows and lands in the agent home, so a
 *   fallback would key the run on a project tree it never touches.
 *
 * `useProjectWorkspace` must be the SAME value the caller passes to
 * `resolveWorkspaceForRun`, or the two can disagree about whether the run
 * consults project workspaces at all.
 */
export function resolveProjectIdNeedingWorkspaceFallback(input: {
  statelessPrReview: boolean;
  issueProjectWorkspaceId: string | null;
  useProjectWorkspace: boolean;
  executionProjectId: string | null;
}): string | null {
  if (input.statelessPrReview || input.issueProjectWorkspaceId || !input.useProjectWorkspace) return null;
  return input.executionProjectId;
}
