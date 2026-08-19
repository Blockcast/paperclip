export const RECOVERY_ORIGIN_KINDS = {
  issueGraphLivenessEscalation: "harness_liveness_escalation",
  issueProductivityReview: "issue_productivity_review",
  productivityReviewEscalation: "productivity_review_escalation",
  strandedIssueRecovery: "stranded_issue_recovery",
  staleActiveRunEvaluation: "stale_active_run_evaluation",
  ccrotateCapacityExhausted: "ccrotate_capacity_exhausted",
} as const;

export const RECOVERY_REASON_KINDS = {
  runLivenessContinuation: "run_liveness_continuation",
} as const;

export const RECOVERY_KEY_PREFIXES = {
  issueGraphLivenessIncident: "harness_liveness",
  issueGraphLivenessLeaf: "harness_liveness_leaf",
  schedulerFailureHeartbeat: "scheduler-heartbeat",
} as const;

// BLO-24543: the routine runbook's own free-text idempotency-key convention
// for a normal emission on its alert surface (`agent-health:<windowKey>:<fingerprint>`).
// This is a per-runbook convention this service does not own -- see the
// namespace ruling below -- so it is kept separate from RECOVERY_KEY_PREFIXES,
// which are keys this service is allowed to WRITE. This one is READ-only.
export const AGENT_HEALTH_RECEIPT_KEY_PREFIX = "agent-health";

export type RecoveryOriginKind = typeof RECOVERY_ORIGIN_KINDS[keyof typeof RECOVERY_ORIGIN_KINDS];
export type RecoveryReasonKind = typeof RECOVERY_REASON_KINDS[keyof typeof RECOVERY_REASON_KINDS];
export type RecoveryKeyPrefix = typeof RECOVERY_KEY_PREFIXES[keyof typeof RECOVERY_KEY_PREFIXES];

export function isStrandedIssueRecoveryOriginKind(originKind: string | null | undefined) {
  return originKind === RECOVERY_ORIGIN_KINDS.strandedIssueRecovery;
}

export function buildIssueGraphLivenessIncidentKey(input: {
  companyId: string;
  issueId: string;
  state: string;
  blockerIssueId?: string | null;
  participantAgentId?: string | null;
}) {
  return [
    RECOVERY_KEY_PREFIXES.issueGraphLivenessIncident,
    input.companyId,
    input.issueId,
    input.state,
    input.blockerIssueId ?? input.participantAgentId ?? "none",
  ].join(":");
}

export function parseIssueGraphLivenessIncidentKey(incidentKey: string | null | undefined) {
  if (!incidentKey) return null;
  const parts = incidentKey.split(":");
  if (parts.length !== 5 || parts[0] !== RECOVERY_KEY_PREFIXES.issueGraphLivenessIncident) return null;
  const [, companyId, issueId, state, leafIssueId] = parts;
  if (!companyId || !issueId || !state || !leafIssueId) return null;
  return { companyId, issueId, state, leafIssueId };
}

export function buildIssueGraphLivenessLeafKey(input: {
  companyId: string;
  state: string;
  leafIssueId: string;
}) {
  return [
    RECOVERY_KEY_PREFIXES.issueGraphLivenessLeaf,
    input.companyId,
    input.state,
    input.leafIssueId,
  ].join(":");
}

// BLO-21395: dedup key for the scheduler-side failure heartbeat, kept in its
// own namespace rather than a suffix inside a routine's own free-text
// `agent-health:<window>`-style convention (which is per-runbook, not a
// platform contract this service owns). One key per (routine, window) --
// stable across repeated escalation sweeps for the same stranded window, and
// distinct across windows because each routine run gets its own `windowKey`.
export function buildSchedulerFailureHeartbeatKey(input: {
  routineId: string;
  windowKey: string;
}) {
  return [
    RECOVERY_KEY_PREFIXES.schedulerFailureHeartbeat,
    input.routineId,
    input.windowKey,
  ].join(":");
}

// BLO-24543: SQL LIKE pattern for "this window already has a normal
// emission." `windowKey` is an ISO-8601 timestamp (no `%`/`_` wildcard
// characters), so this is a literal prefix match, not a real glob. Reading
// this prefix is the receipt-absence predicate itself -- it replaces the old
// `lastUsefulActionAt IS NOT NULL` proxy, which was too permissive: a run can
// set that column off a single early activity event (e.g. checkout) and then
// still strand before ever reaching the runbook's own emission step.
export function buildAgentHealthReceiptKeyLikePattern(windowKey: string) {
  return `${AGENT_HEALTH_RECEIPT_KEY_PREFIX}:${windowKey}:%`;
}
