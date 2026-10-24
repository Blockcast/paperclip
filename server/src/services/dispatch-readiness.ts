import { ISSUE_TREE_CONTROL_INTERACTION_WAKE_REASONS } from "./issue-tree-control.js";
import { extractWakeCommentIds } from "./deferred-wake-reopen.js";

/**
 * The dependency-readiness half of "can dispatch actually claim this row",
 * and nothing else.
 *
 * This module is a leaf on purpose, for the same reason
 * `deferred-wake-reopen.ts` is: the verdict has to be readable from
 * `heartbeat.ts` (the dispatcher and claim path), from
 * `queued-run-age-metrics.ts` (the measurand), and from anything that comes
 * later, and a predicate living in `heartbeat.ts` can only be reached by
 * importing a ~40k-line module that pulls in the whole run lifecycle.
 *
 * It holds BOTH halves of the dispatcher's readiness screen -- the dependency
 * half and the admission-backoff half -- because a reader that takes only one
 * of them has re-derived the verdict, which is the thing this module exists to
 * prevent. That is not hypothetical: the first cut of the claimable gauge read
 * `isEffectivelyDependencyReadyForDispatch` alone and therefore counted an
 * admission-deferred retry as claimable, reproducing the very false-positive
 * shape PEN-4280 reported, for a smaller population (caught in review on
 * PR #2814).
 *
 * Re-derivation is the bug class here, not an inconvenience.
 * `isEffectivelyDependencyReadyForDispatch` exists *because* BLO-21792 leaks
 * 2-5 and BLO-22091 were each a site re-deriving this verdict slightly
 * differently from the others. PEN-4280 found the fourth: the queued-age
 * measurand counts a dependency-blocked queued run as dispatch wait, in two
 * independent implementations (this repo's `paperclip_queued_run_oldest_age_seconds`
 * and onprem-k8s' exporter). Only one of those can read a TypeScript
 * predicate; that is exactly why the exclusion lands here and not in
 * exporter SQL, where it would have become the fifth copy across a repo
 * boundary.
 */

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/**
 * The single reader of "which comment id, if any, woke this run".
 *
 * Batched wake ids win over the scalar fields: `extractWakeCommentIds`
 * returns the coalesced list in arrival order, and the LAST entry is the one
 * the prompt renders, so that is the one a wake is identified by.
 */
export function deriveCommentId(
  contextSnapshot: Record<string, unknown> | null | undefined,
  payload: Record<string, unknown> | null | undefined,
) {
  const batchedCommentId = extractWakeCommentIds(contextSnapshot).at(-1);
  return (
    batchedCommentId ??
    readNonEmptyString(contextSnapshot?.wakeCommentId) ??
    readNonEmptyString(contextSnapshot?.commentId) ??
    readNonEmptyString(payload?.commentId) ??
    null
  );
}

export function allowsIssueInteractionWake(
  contextSnapshot: Record<string, unknown> | null | undefined,
) {
  const wakeReason = readNonEmptyString(contextSnapshot?.wakeReason);
  if (!wakeReason || !ISSUE_TREE_CONTROL_INTERACTION_WAKE_REASONS.has(wakeReason)) return false;
  return Boolean(deriveCommentId(contextSnapshot, null));
}

/**
 * The single definition of "can dispatch actually claim this row", as far as
 * dependency blockers are concerned.
 *
 * `claimQueuedRun` cancels a queued run whose issue has unresolved blockers
 * *unless* the run is an issue-interaction wake carrying a comment id -- those
 * are deliberately allowed to run on a blocked issue so a human can still talk
 * to the assignee while it waits. Every dispatch-side readiness screen has to
 * agree with that, or the two disagree in a way that is invisible and
 * unbounded (BLO-21792 third review follow-up):
 *
 *   - the emergency/starvation lanes treat the row as unclaimable, so they
 *     page PAST it looking for "real" work and it is never offered; and
 *   - `dispatchRank` files it under the dependency-blocked rank (12+), below
 *     every routine row, so on the pass that does collect it, it loses to
 *     anything else in the window.
 *
 * Under sustained critical arrivals that combination has no upper bound -- the
 * exact starvation shape BLO-22091 exists to cap -- while the claim path would
 * have run the row immediately. Both sides read this predicate, so a future
 * change to the claim-time exemption cannot silently desynchronize them.
 *
 * PEN-4280/PEN-4293 added a third reader, and it reads the verdict for the
 * opposite purpose: `refreshClaimableQueuedRunAgeMetrics` EXCLUDES a run this
 * returns false for, because such a run is structurally unclaimable by design
 * -- `dispatchRank` deliberately refuses to let it age forward ("a row that
 * cannot be claimed must not escalate to the front, however long it has
 * waited") and `claimQueuedRun`'s cancel-on-blocked screen only fires on a
 * claim that therefore never arrives. Counting its wait as dispatch latency
 * reads a healthy dispatcher as starvation.
 */
export function isEffectivelyDependencyReadyForDispatch(
  contextSnapshot: Record<string, unknown> | null | undefined,
  readiness: { isDependencyReady: boolean } | null | undefined,
) {
  if (readiness?.isDependencyReady ?? true) return true;
  return allowsIssueInteractionWake(contextSnapshot);
}

/**
 * Context-snapshot keys that carry a queued run's "not admissible yet" backoff
 * stamp. They live here rather than in `heartbeat.ts` so the writers (which
 * stamp them) and the readers (which gate on them) cannot drift apart across a
 * module boundary.
 */
export const K8S_ISOLATION_RETRY_AT_CONTEXT_KEY = "paperclipK8sIsolationRetryAt";
export const BRANCH_CLAIM_RETRY_AT_CONTEXT_KEY = "paperclipBranchClaimRetryAt";
// BLO-48769: the non-run isolation key a K8s-deferred run is waiting on. Unlike
// `paperclipK8sIsolation` (dropped on deferral), this survives in `queued`, so
// the writer lock can admit waiters on one key oldest-first.
export const K8S_ISOLATION_WAIT_KEY_CONTEXT_KEY = "paperclipK8sIsolationWaitKey";

function isRetryStampDeferred(
  context: Record<string, unknown> | null | undefined,
  key: string,
  now: Date,
): boolean {
  const retryAtValue = readNonEmptyString(context?.[key]);
  if (!retryAtValue) return false;
  const retryAt = new Date(retryAtValue);
  return !Number.isNaN(retryAt.getTime()) && retryAt.getTime() > now.getTime();
}

export function isK8sIsolationRetryDeferred(
  context: Record<string, unknown> | null | undefined,
  now = new Date(),
): boolean {
  return isRetryStampDeferred(context, K8S_ISOLATION_RETRY_AT_CONTEXT_KEY, now);
}

// BLO-21602: deferRunForBranchClaimConflict (like deferRunForK8sIsolationConflict)
// sends a run back to `queued` with a computed backoff rather than failing it,
// stamping paperclipBranchClaimRetryAt on the run's contextSnapshot. Queued-run
// admission must honor that backoff the same way it already honors the K8s
// isolation retry stamp -- otherwise the run is immediately eligible again and
// repeatedly performs setup, conflict, and requeue instead of waiting.
export function isBranchClaimRetryDeferred(
  context: Record<string, unknown> | null | undefined,
  now = new Date(),
): boolean {
  return isRetryStampDeferred(context, BRANCH_CLAIM_RETRY_AT_CONTEXT_KEY, now);
}

// Combines every "queued run is not actually admissible yet" backoff stamp a
// run's contextSnapshot may carry. Use this everywhere queued runs are
// scanned for admission instead of checking isK8sIsolationRetryDeferred alone.
export function isQueuedRunAdmissionDeferred(
  context: Record<string, unknown> | null | undefined,
  now = new Date(),
): boolean {
  return isK8sIsolationRetryDeferred(context, now) || isBranchClaimRetryDeferred(context, now);
}

/**
 * `dispatchRank`'s `ready` screen (BLO-22091), and the full definition of
 * "could dispatch advance this row right now".
 *
 * Deliberately narrower than `heartbeat.ts`'s `isRunClaimable`: it omits the
 * terminal-issue check on purpose. By the time a row reaches the ranking step,
 * `queuedRuns` has already been pruned for terminal issues by the main scan via
 * `evaluateQueuedRunStaleness` -- the same function `claimQueuedRun` itself
 * uses -- which lets a `resumeIntent`/wake-comment-carrying row survive against
 * a done/cancelled issue so a comment can reopen it. That pruning is
 * authoritative and resume-intent-aware; this function must not re-exclude what
 * it already decided to keep. If it did, `dispatchRank`'s `!ready` branch never
 * ages (a row that "cannot be claimed" must not escalate to the front, however
 * long it has waited) so a legitimately-claimable reopened row would rank `12+`
 * forever and starve exactly the way BLO-22091 exists to prevent, just via a
 * different exemption than leak 5's.
 *
 * The lanes don't have this problem: they already excluded terminal issues from
 * their own candidate batches unconditionally before that fix (via
 * `criticalIssueById`'s filter, lane B's `candidates` filter, and lane C's
 * inline check), so a resume-intent-exempted terminal row was already never
 * surfaced as "found ready" by any lane -- `isRunClaimable` preserves that
 * pre-existing behavior rather than changing it. Only `dispatchRank`'s `ready`
 * previously had *no* terminal screen at all (trusting the upstream prune), so
 * adding the full `isRunClaimable` there -- rather than this narrower sibling
 * -- would have been a net new regression, not a fix.
 *
 * PEN-4293 made this the measurand's predicate too. That is the right one: it
 * is precisely the screen that decides whether a row is allowed to age toward
 * the front, so "a run this returns false for is waiting, but not on dispatch"
 * is exactly what the claimable gauge needs to exclude. Reading only its
 * dependency conjunct counts an admission-deferred retry's backoff as dispatch
 * latency.
 */
export function isDispatchRankReady(
  contextSnapshot: Record<string, unknown> | null | undefined,
  readiness: { isDependencyReady: boolean } | null | undefined,
  now: Date,
): boolean {
  if (isQueuedRunAdmissionDeferred(contextSnapshot, now)) return false;
  return isEffectivelyDependencyReadyForDispatch(contextSnapshot, readiness);
}

/**
 * Issue statuses that end a run's reason to exist.
 *
 * Lives here rather than in `heartbeat.ts` so {@link isRunClaimable} can live
 * here too. `heartbeat.ts` imports it; there is deliberately only one copy, for
 * the reason stated at the top of this file.
 */
export const TERMINAL_ISSUE_STATUSES: ReadonlySet<string> = new Set(["done", "cancelled"]);

/**
 * The single definition of "is this queued run's issue actually claimable right
 * now" (BLO-22091). Every dispatch lane's eligibility test
 * (`foundReadyCritical`, `foundReadyRecovery`, `foundReadyAbsolute`) calls this
 * and nothing else, so a future change to any one screen cannot silently
 * desynchronize the lanes from what the claim path actually accepts -- the exact
 * shape of leaks 2-5 (BLO-21792), which were each one site re-deriving this
 * verdict slightly differently from the others.
 *
 * Three screens, matching what `claimQueuedRun` applies to a routine
 * (non-reopen) queued run:
 *   1. The issue must exist and be non-terminal ({@link TERMINAL_ISSUE_STATUSES}).
 *   2. It must not be a queued-admission retry still waiting on its timestamp.
 *   3. It must be dependency-ready, or exempted via a verified issue-interaction
 *      wake ({@link isEffectivelyDependencyReadyForDispatch}).
 *
 * `claimQueuedRun`'s own dependency-blocker gate calls
 * {@link isEffectivelyDependencyReadyForDispatch} directly rather than this
 * whole predicate, and `dispatchRank` calls the narrower sibling
 * {@link isDispatchRankReady} instead of this -- see that function's comment for
 * why terminal-status can't be folded in there without reintroducing an
 * unbounded wait for a different exemption.
 *
 * PEN-4385 moved this out of `heartbeat.ts` so the out-of-band reaper can hold
 * it as a safety interlock without importing the ~40k-line run lifecycle. The
 * body is unchanged by that move.
 */
export function isRunClaimable(
  contextSnapshot: Record<string, unknown> | null | undefined,
  issue: { status: string } | null | undefined,
  readiness: { isDependencyReady: boolean } | null | undefined,
  now: Date,
): boolean {
  if (!issue || TERMINAL_ISSUE_STATUSES.has(issue.status)) return false;
  if (isQueuedRunAdmissionDeferred(contextSnapshot, now)) return false;
  return isEffectivelyDependencyReadyForDispatch(contextSnapshot, readiness);
}

/**
 * Why a queued run is or is not eligible for the out-of-band dependency reap
 * (PEN-4385). Every arm is named so the sweep's log says which population a row
 * fell into rather than just that it was skipped.
 */
export type QueuedRunDependencyReapVerdict =
  | { reap: false; reason: "claimable" | "issue_missing" | "terminal_issue" | "admission_deferred" }
  | { reap: true; reason: "dependency_blocked" };

/**
 * Decide whether an already-`queued` run should be reaped because its issue is
 * dependency-blocked (PEN-4385).
 *
 * ## The gap this closes
 *
 * A dependency-blocked *wake* is handled correctly: it parks into
 * `scheduled_retry` under `DEP_BLOCKED_RETRY_REASON`, with a retry budget and a
 * wall-clock ceiling. The gap is a run that is ALREADY `queued` when its issue
 * becomes un-ready -- the common shape being a run enqueued against a ready
 * issue that is blocked afterwards, which no enqueue-time screen can catch.
 * Such a row is unclaimable, so every dispatch lane pages past it and
 * `dispatchRank` files it at rank 12+ where it "must not escalate to the front,
 * however long it has waited". The only thing that cancels it,
 * `cancelQueuedRunForBlockedDependencies`, had exactly one call site -- inside
 * `claimQueuedRun` -- so it fired only on a claim that never came. The row then
 * aged in `queued` without bound, occupying per-agent queue depth and the
 * dispatch scan's bounded window, and inflating
 * `pg_heartbeat_run_queue_backlog_by_agent_oldest_unparked_queued_seconds`
 * (PEN-4280 §1: three days of triage on a healthy dispatcher).
 *
 * ## Why the arms are in this order
 *
 * {@link isRunClaimable} comes FIRST and is the hard safety interlock: a row the
 * dispatcher could claim right now is never reaped, whatever the arms below
 * would say. It is the dispatcher's own predicate, called whole -- not a
 * dependency conjunct, not a restatement. That matters more here than anywhere
 * else in this file, because this is the one reader whose verdict DESTROYS a
 * run rather than ranking or counting it: a re-derivation that drifted
 * permissive would cancel dispatchable work.
 *
 * The remaining arms then split "unclaimable" by cause, because only one cause
 * is unbounded:
 *
 *   - `terminal_issue` / `issue_missing` are NOT this sweep's population.
 *     `evaluateQueuedRunStaleness` owns them and is resume-intent-aware: it
 *     deliberately keeps a `resumeIntent`/wake-comment-carrying row alive
 *     against a done or cancelled issue so a comment can reopen it. This
 *     function has no way to see that intent, so reaping here would kill rows
 *     that are legitimately waiting to be reopened.
 *   - `admission_deferred` is already bounded by construction. A k8s-isolation
 *     or branch-claim backoff carries its own future timestamp and clears
 *     itself; the row is unclaimable on purpose and only for as long as the
 *     stamp says. Reaping it would cancel a run that is behaving exactly as
 *     designed.
 *   - `dependency_blocked` is the one with no other bound, and the one the
 *     claim path already knows how to dispose of.
 *
 * The issue-interaction-wake exemption is preserved for free, because it lives
 * inside {@link isEffectivelyDependencyReadyForDispatch}: a wake carrying a
 * comment id is deliberately allowed to run on a blocked issue so a human can
 * still talk to the assignee, and it is reported `claimable` by the first arm.
 * That is the one case in this whole population with a person waiting on it.
 */
export function classifyQueuedRunForDependencyReap(
  contextSnapshot: Record<string, unknown> | null | undefined,
  issue: { status: string } | null | undefined,
  readiness: { isDependencyReady: boolean } | null | undefined,
  now: Date,
): QueuedRunDependencyReapVerdict {
  if (isRunClaimable(contextSnapshot, issue, readiness, now)) {
    return { reap: false, reason: "claimable" };
  }
  if (!issue) return { reap: false, reason: "issue_missing" };
  if (TERMINAL_ISSUE_STATUSES.has(issue.status)) return { reap: false, reason: "terminal_issue" };
  if (isEffectivelyDependencyReadyForDispatch(contextSnapshot, readiness)) {
    return { reap: false, reason: "admission_deferred" };
  }
  return { reap: true, reason: "dependency_blocked" };
}
