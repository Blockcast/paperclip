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
