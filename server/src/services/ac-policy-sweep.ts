const TERMINAL_STATUSES = new Set(["done", "cancelled"]);

const PRODUCTIVITY_REVIEW_ORIGIN_KINDS = new Set([
  "issue_productivity_review",
  "productivity_review_escalation",
]);

/**
 * The AC-policy sweep (routine 8b764d66) is REPORT-ONLY as of revision 7.
 *
 * Ratified by the CEO on BLO-19484 (option 1), implemented via BLO-19487. The
 * destructive cancellation step this module used to plan is retired: there is no
 * batch planner, no safety cap, and no destruction-eligible bucket, because
 * nothing is destroyed. Both buckets below are reporting outputs.
 *
 * Why (do not relitigate without new evidence): the step formed a candidate batch
 * in four consecutive runs and was correctly refused every time, because
 * spot-checks kept finding live work inside a batch the filter called safe. The
 * single run that did execute (2026-06-08) destroyed PCL-354, a user-assigned
 * strategic issue. Root cause is not a threshold — grace-flag age measures issue
 * *format* ("nobody added a markdown heading"), not issue *liveness*. Genuine
 * abandonment is owned by stranded-issue recovery and productivity review.
 *
 * If a future change proposes reintroducing a destructive path, that needs a fresh
 * ruling on BLO-19484, not a new default here.
 */

export type AcPolicyIssueRef = {
  id: string;
  identifier?: string | null;
  status?: string | null;
};

export type AcPolicyStaleCandidate = {
  id: string;
  identifier?: string | null;
  title: string;
  status: string;
  assigneeAgentId?: string | null;
  assigneeUserId?: string | null;
  createdByUserId?: string | null;
  originKind?: string | null;
  blocks?: AcPolicyIssueRef[] | null;
  /**
   * Newest human-attributable touch, from the `humanClockAt` computation in
   * `human-gated-ageing.ts`. NEVER derive this from `updatedAt` / `lastActivityAt`:
   * migration 0076 bumps those on *any* comment insert with no author_type filter,
   * and this routine's own grace-flag comments are the main thing bumping them — it
   * would be reading back its own writes. `null` means no human has ever touched the
   * issue, which is reported as its own condition rather than as a large age.
   */
  humanClockAt?: Date | string | null;
};

export type AcPolicyCandidateClassification =
  | { bucket: "stale-non-compliant" }
  | { bucket: "needs-human-triage"; reasons: string[] };

export function classifyAcPolicyStaleCandidate(
  candidate: AcPolicyStaleCandidate,
): AcPolicyCandidateClassification {
  const reasons: string[] = [];

  if (candidate.assigneeUserId) {
    reasons.push("user_assigned");
  }

  if (candidate.createdByUserId) {
    reasons.push("user_owned_protected");
  }

  if (candidate.originKind && PRODUCTIVITY_REVIEW_ORIGIN_KINDS.has(candidate.originKind)) {
    reasons.push("productivity_review_escalation");
  } else if (candidate.title.toLowerCase().includes("productivity-review escalation")) {
    reasons.push("productivity_review_escalation");
  }

  const activeBlockedParents = (candidate.blocks ?? []).filter((parent) => {
    const status = parent.status ?? null;
    return status === null || !TERMINAL_STATUSES.has(status);
  });
  if (activeBlockedParents.length > 0) {
    reasons.push("active_blocker_for_non_terminal_parent");
  }

  if (reasons.length > 0) return { bucket: "needs-human-triage", reasons };
  return { bucket: "stale-non-compliant" };
}

/**
 * Splits stale candidates into two report-only buckets. Neither is actionable;
 * the split exists because the two need different follow-up.
 */
export function partitionAcPolicyStaleCandidates(candidates: AcPolicyStaleCandidate[]) {
  const staleNonCompliant: AcPolicyStaleCandidate[] = [];
  const needsHumanTriage: Array<AcPolicyStaleCandidate & { triageReasons: string[] }> = [];

  for (const candidate of candidates) {
    const classification = classifyAcPolicyStaleCandidate(candidate);
    if (classification.bucket === "stale-non-compliant") {
      staleNonCompliant.push(candidate);
    } else {
      needsHumanTriage.push({ ...candidate, triageReasons: classification.reasons });
    }
  }

  return { staleNonCompliant, needsHumanTriage };
}

function formatIssueRef(issue: AcPolicyStaleCandidate) {
  return issue.identifier ? `${issue.identifier} (${issue.id})` : issue.id;
}

/**
 * `null` humanClockAt is rendered as its own condition rather than folded into an
 * age, per the BLO-19484 amendment: never touched by a human is worse than merely
 * stale, and must stay visibly distinct in the table.
 */
function formatHumanClock(issue: AcPolicyStaleCandidate) {
  if (!("humanClockAt" in issue)) return "";
  if (issue.humanClockAt == null) return " [never touched by a human]";
  const at = issue.humanClockAt instanceof Date ? issue.humanClockAt : new Date(issue.humanClockAt);
  if (Number.isNaN(at.getTime())) return " [never touched by a human]";
  return ` [last human touch ${at.toISOString().slice(0, 10)}]`;
}

export function formatAcPolicyStaleDashboardSections(candidates: AcPolicyStaleCandidate[]) {
  const partitioned = partitionAcPolicyStaleCandidates(candidates);
  const lines: string[] = [
    `### Stale non-compliant candidates — report only (${partitioned.staleNonCompliant.length})`,
  ];

  if (partitioned.staleNonCompliant.length === 0) {
    lines.push("- None");
  } else {
    for (const candidate of partitioned.staleNonCompliant) {
      lines.push(`- ${formatIssueRef(candidate)} - ${candidate.title}${formatHumanClock(candidate)}`);
    }
  }

  lines.push(
    "",
    `### Needs-human-triage candidates — report only (${partitioned.needsHumanTriage.length})`,
  );
  if (partitioned.needsHumanTriage.length === 0) {
    lines.push("- None");
  } else {
    for (const candidate of partitioned.needsHumanTriage) {
      lines.push(
        `- ${formatIssueRef(candidate)} - ${candidate.title} (${candidate.triageReasons.join(", ")})${formatHumanClock(candidate)}`,
      );
    }
  }

  lines.push("", "Issues cancelled by this sweep: 0 (this routine is report-only — see BLO-19484).");

  return lines.join("\n");
}
