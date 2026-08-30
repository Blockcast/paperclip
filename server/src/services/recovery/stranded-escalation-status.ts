/**
 * BLO-27635: which status a stranded-issue escalation should leave behind.
 *
 * `escalateStrandedAssignedIssue` used to write `status: "blocked"` unconditionally,
 * with `blockedByIssueIds` set to whatever unresolved `blocks` edges existed — which,
 * for a stale-killed or stranded run, is the empty array. That produced the
 * `blocked`-with-no-blocker signature: 206 rows measured estate-wide on 2026-08-15.
 *
 * The park is unrecoverable by construction, because two independent drains both
 * decline the row:
 *   - `reconcileStrandedAssignedIssues` only scans `STRANDED_ASSIGNED_ISSUE_STATUSES`
 *     (`todo` / `in_progress` / `in_review`), so a row it just moved to `blocked` can
 *     never be re-picked by the same sweep;
 *   - the BLO-21523 `stranded-blocked-issue-reconciler` skips it because
 *     `listBlockedIssueAutoResumeSuppressions` reports the still-open recovery action
 *     as `active_recovery_action`.
 *
 * BLO-30743: that second bullet holds only while the action is `active`. See the
 * correction below.
 *
 * This module isolates the one decision that fixes the *producer*: do not write
 * `blocked` when there is provably nothing to be blocked ON and nobody who will ever
 * be woken. It deliberately does NOT attach the recovery issue as a blocker edge —
 * `c9741f57a` (BLO-28618) removed exactly that behaviour from the liveness path after
 * measuring 240 of 500 sampled rows re-filed across 92 sources, and re-introducing it
 * here would reproduce that defect in the stranded path.
 *
 * BLO-30743: the second bullet above does not hold once the action's wake horizon expires,
 * and the two drains fought over the difference. The suppression set that makes the
 * reconciler skip these rows is `BLOCKED_AUTO_RESUME_SUPPRESSING_RECOVERY_ACTION_STATUSES = ["active"]`, which
 * deliberately EXCLUDES `escalated` (BLO-21523): an escalated action is wake-exhausted by
 * construction, so suppressing on it would preserve no repair path and only pin the row
 * `blocked` forever. So once `escalateExpiredWakeHorizons` retires an action's horizon,
 * the reconciler stops skipping the row — while this module, testing only whether an
 * owner is NAMED, kept writing `blocked` with an empty blocker set. Measured on BLO-27999:
 * 458 writes in 10.3h, 208 of them `issue.escalation.needs_human_decision` (each one a
 * Slack forward), across 14 rows estate-wide.
 *
 * The fix is to make both halves test the SAME property. The reconciler's question is not
 * "is an owner named" but "will anyone actually be woken", and a named owner on an
 * `escalated` action answers no — the platform says as much verbatim when it escalates:
 * "Paperclip has stopped waking anyone for it". Folding wake-exhaustion into
 * `hasNoRecoveryPath` makes this module write the very status the reconciler would flip
 * the row to, so the two drains reach a fixed point on the first tick instead of trading
 * the row back and forth every 15 minutes.
 *
 * Note what this deliberately does NOT do, because both alternatives were considered and
 * rejected against existing constraints: it does not synthesise a blocker edge (BLO-28618),
 * and it does not widen the suppression set to include `escalated` (BLO-21523's asymmetry
 * is load-bearing — widening it would re-strand the 88-of-106 rows that constant was
 * written to free). The producer yields; the reconciler is untouched.
 */

/** Statuses a stranded escalation may leave on the source issue. */
export type StrandedEscalationStatus = "blocked" | "todo" | "in_review";

export type StrandedEscalationStatusInput = {
  /** The issue's status as re-read under the escalation's advisory lock. */
  currentStatus: string;
  /**
   * `ownerAgentId` on the upserted recovery action. `null` means
   * `resolveStrandedIssueRecoveryOwnerAgentId` walked the entire ladder — the
   * assignee's manager, the creator's manager, the creator, the CTO, the CEO, and
   * finally the assignee itself — and found nobody both invokable and clear of a
   * budget block. `wakesOwner` is derived from the same value, so a null owner also
   * means the action is created with no horizon and no sweep will wake anyone.
   */
  recoveryOwnerAgentId: string | null;
  /**
   * True when the recovery action backing this escalation is `escalated` — i.e. it has
   * burned its creation-anchored wake horizon and `escalateExpiredWakeHorizons` retired it.
   *
   * This is the BLO-30743 correction. `recoveryOwnerAgentId` answers "is an owner NAMED",
   * which is not the question: an `escalated` action keeps its `ownerAgentId` column
   * populated (the status transition writes only `status`), so the owner reads as resolved
   * long after every wake for it has stopped. `reconcileStrandedRecoveryWakeBackstop`
   * selects such an action and always drops it at `exhaustedSkipped`.
   *
   * Treating that named-but-unwakeable owner as a live path is what minted `blocked` with
   * an empty blocker set on a row the reconciler was simultaneously draining. A wake budget
   * that cannot be spent is not a recovery path.
   */
  isWakeExhaustedEscalation: boolean;
  /**
   * True for the `provider_quota` park that has a `returnOwnerAgentId`. That shape
   * has no owner either, but it DOES have a live wake path: the caller arms a quota
   * monitor for the return owner after commit. It is a real park and must keep
   * writing `blocked`.
   */
  isProviderQuotaWait: boolean;
  /** Unresolved `blocks` edges. Non-empty means `blocked` is honest. */
  blockerIssueIds: readonly string[];
  /** Manual-repair causes have no autonomous path and must remain parked. */
  recoveryCause: string;
};

export type StrandedEscalationStatusDecision = {
  status: StrandedEscalationStatus;
  /**
   * True when the escalation found no live owner, no quota-monitor park, and no blocker
   * edge — i.e. no path by which this row would ever move again. Surfaced on the
   * escalation activity record so the diverted rows stay queryable without
   * re-deriving the predicate from the owner/blocker columns.
   */
  hasNoRecoveryPath: boolean;
};

/**
 * Decide the status a stranded escalation writes.
 *
 * `blocked` stays the default. It is only declined when all three hold:
 * no LIVE recovery owner, not a provider-quota monitor park, and no unresolved blocker
 * edge. In that case the strand is a CAPACITY condition (paused agent, exhausted
 * budget, dead provider pool) rather than a dependency, so the row is left
 * dispatchable and resumes on its own once an invokable owner exists.
 *
 * "Live" is doing real work in that first clause (BLO-30743). An owner whose action has
 * gone `escalated` is wake-exhausted, so it is counted as no owner at all — otherwise
 * this module writes `blocked` on precisely the rows the stranded-blocked reconciler is
 * draining to `todo`, and the two sweeps trade the row back and forth forever.
 *
 * `in_review` is preserved rather than downgraded to `todo`: those rows are parked on
 * a review participant, and clobbering that park is the BLO-18643 regression.
 */
export function resolveStrandedEscalationStatus(
  input: StrandedEscalationStatusInput,
): StrandedEscalationStatusDecision {
  const isManualRepairCause = input.recoveryCause === "workspace_validation_failed" ||
    input.recoveryCause === "configuration_incomplete";
  // A named owner only counts as a path while it can still be woken. The provider-quota
  // park is checked separately below because its wake path is the post-commit monitor
  // armed for `returnOwnerAgentId`, not an owner wake, so exhaustion does not apply to it.
  const hasLiveRecoveryOwner = Boolean(input.recoveryOwnerAgentId) &&
    !input.isWakeExhaustedEscalation;
  const hasNoRecoveryPath = !isManualRepairCause &&
    !hasLiveRecoveryOwner &&
    !input.isProviderQuotaWait &&
    input.blockerIssueIds.length === 0;

  if (!hasNoRecoveryPath) {
    return { status: "blocked", hasNoRecoveryPath: false };
  }

  return {
    status: input.currentStatus === "in_review" ? "in_review" : "todo",
    hasNoRecoveryPath: true,
  };
}
