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
