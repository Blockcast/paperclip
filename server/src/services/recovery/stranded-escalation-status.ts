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
 * This module isolates the one decision that fixes the *producer*: do not write
 * `blocked` when there is provably nothing to be blocked ON and nobody who will ever
 * be woken. It deliberately does NOT attach the recovery issue as a blocker edge —
 * `c9741f57a` (BLO-28618) removed exactly that behaviour from the liveness path after
 * measuring 240 of 500 sampled rows re-filed across 92 sources, and re-introducing it
 * here would reproduce that defect in the stranded path.
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
   * True when the escalation found no owner, no quota-monitor park, and no blocker
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
 * no recovery owner, not a provider-quota monitor park, and no unresolved blocker
 * edge. In that case the strand is a CAPACITY condition (paused agent, exhausted
 * budget, dead provider pool) rather than a dependency, so the row is left
 * dispatchable and resumes on its own once an invokable owner exists.
 *
 * `in_review` is preserved rather than downgraded to `todo`: those rows are parked on
 * a review participant, and clobbering that park is the BLO-18643 regression.
 */
export function resolveStrandedEscalationStatus(
  input: StrandedEscalationStatusInput,
): StrandedEscalationStatusDecision {
  const isManualRepairCause = input.recoveryCause === "workspace_validation_failed" ||
    input.recoveryCause === "configuration_incomplete";
  const hasNoRecoveryPath = !isManualRepairCause &&
    !input.recoveryOwnerAgentId &&
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
