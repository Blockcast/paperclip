const TERMINAL_STATUSES = new Set(["done", "cancelled"]);

const PRODUCTIVITY_REVIEW_ORIGIN_KINDS = new Set([
  "issue_productivity_review",
  "productivity_review_escalation",
]);

export type AcPolicyIssueRef = {
  id: string;
  identifier?: string | null;
  status?: string | null;
};

export type AcPolicyCancelCandidate = {
  id: string;
  identifier?: string | null;
  title: string;
  status: string;
  assigneeAgentId?: string | null;
  assigneeUserId?: string | null;
  createdByUserId?: string | null;
  originKind?: string | null;
  blocks?: AcPolicyIssueRef[] | null;
};

export type AcPolicyCandidateClassification =
  | { bucket: "auto-cancel-safe" }
  | { bucket: "needs-human-triage"; reasons: string[] };

export function classifyAcPolicyCancelCandidate(
  candidate: AcPolicyCancelCandidate,
): AcPolicyCandidateClassification {
  const reasons: string[] = [];

  if (candidate.assigneeUserId) {
    reasons.push("user_assigned");
  }

  if (!candidate.assigneeAgentId && candidate.createdByUserId) {
    reasons.push("user_owned_protected");
  }

  if (candidate.originKind && PRODUCTIVITY_REVIEW_ORIGIN_KINDS.has(candidate.originKind)) {
    reasons.push("productivity_review_escalation");
  } else if (candidate.title.toLowerCase().includes("productivity-review escalation")) {
    reasons.push("productivity_review_escalation");
  }

  const activeBlockedParents = (candidate.blocks ?? []).filter((parent) => {
    const status = parent.status ?? null;
    return status !== null && !TERMINAL_STATUSES.has(status);
  });
  if (activeBlockedParents.length > 0) {
    reasons.push("active_blocker_for_non_terminal_parent");
  }

  if (reasons.length > 0) return { bucket: "needs-human-triage", reasons };
  return { bucket: "auto-cancel-safe" };
}

export function partitionAcPolicyCancelCandidates(candidates: AcPolicyCancelCandidate[]) {
  const autoCancelSafe: AcPolicyCancelCandidate[] = [];
  const needsHumanTriage: Array<AcPolicyCancelCandidate & { triageReasons: string[] }> = [];

  for (const candidate of candidates) {
    const classification = classifyAcPolicyCancelCandidate(candidate);
    if (classification.bucket === "auto-cancel-safe") {
      autoCancelSafe.push(candidate);
    } else {
      needsHumanTriage.push({ ...candidate, triageReasons: classification.reasons });
    }
  }

  return { autoCancelSafe, needsHumanTriage };
}
