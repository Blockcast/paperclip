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
  issueGraphLivenessBoardEscalation: "harness_liveness_board",
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

/**
 * BLO-24744: coalescing key for the ONE board card a liveness incident is allowed to raise.
 *
 * A liveness escalation is minted per *repair target* — `blocked_by_uninvokable_assignee` keys its
 * incident on the blocker issue, so one paused agent holding N blocker issues mints N escalations,
 * each legitimately distinct (each blocker needs its own re-home). Since BLO-25878 each of those
 * status-only runs may file a `request_board_approval`, so without a shared key one pause raises N
 * cards asking a human the same single question. Measured 2026-08-10: one manual pause of Release
 * Engineer `c0bccc75` produced 3 escalations in ~53s.
 *
 * `rootCauseId` is therefore the thing a human actually decides about, not the leaf the detector
 * happened to walk: the uninvokable agent when the state names one, else the repair-target issue.
 * Callers that cannot identify an agent pass the issue and still coalesce repeat filings for that
 * one incident across runs, which is strictly better than no key at all.
 */
export function buildIssueGraphLivenessBoardEscalationKey(input: {
  companyId: string;
  state: string;
  rootCauseId: string;
}) {
  return [
    RECOVERY_KEY_PREFIXES.issueGraphLivenessBoardEscalation,
    input.companyId,
    input.state,
    input.rootCauseId,
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

// BLO-24543: SQL LIKE pattern for "the alert surface carries a normal
// emission." Reading these keys is the receipt-absence predicate itself -- it
// replaces the old `lastUsefulActionAt IS NOT NULL` proxy, which was too
// permissive: a run can set that column off a single early activity event
// (e.g. checkout) and then still strand before ever reaching the runbook's own
// emission step.
//
// BLO-28871: this deliberately does NOT interpolate a window key. The previous
// `agent-health:<windowKey>:%` form pinned the match to one exact timestamp
// string, and the platform's window identity is not the runbook's: the
// scheduler knows the raw `triggeredAt` (`:07:xx` under the live `7 */6 * * *`
// cron) while every receipt on the live alert surface is keyed to the floored
// UTC slot (`:00:00`). Those two strings can never be equal, so the guard
// matched nothing in production. Match the whole namespace here and decide
// window membership from the parsed key -- see
// `parseAgentHealthReceiptWindowKey`.
export const AGENT_HEALTH_RECEIPT_KEY_LIKE_PATTERN = `${AGENT_HEALTH_RECEIPT_KEY_PREFIX}:%`;

// The window instant inside `agent-health:<windowKey>:<fingerprint>`. Not a
// `split(":")`: `<windowKey>` is an ISO-8601 instant that contains its own
// colons, and `<fingerprint>` is runbook-owned free text. Both formats observed
// on the live alert surface are accepted -- `2026-08-03T18:00:00Z` (seconds)
// and `2026-08-19T00:00:00.000Z` (milliseconds) -- plus an explicit numeric
// offset, since this convention belongs to the runbook and may drift again.
const AGENT_HEALTH_RECEIPT_WINDOW_KEY_PATTERN = new RegExp(
  `^${AGENT_HEALTH_RECEIPT_KEY_PREFIX}:`
    + "(\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(?::\\d{2}(?:\\.\\d{1,9})?)?)"
    + "(Z|[+-]\\d{2}:?\\d{2})?"
    + "(?::|$)",
);

/**
 * BLO-28871: parse the window instant a runbook stamped into its own receipt
 * key. Returns `null` for anything that is not an `agent-health:` key with a
 * readable ISO-8601 window -- including a null key, which is the shape every
 * pre-`2026-07-31` emission on the live alert surface has. An unparseable or
 * absent window cannot be attributed to a window, so it must never suppress a
 * scheduler receipt; that is what keeps the July-shaped true positives true.
 *
 * A form with no explicit offset is read as UTC. Every observed convention
 * stamps the UTC slot, and the JS default of local time would make this parse
 * depend on the server's timezone.
 */
export function parseAgentHealthReceiptWindowKey(idempotencyKey: string | null | undefined) {
  if (!idempotencyKey) return null;
  const match = AGENT_HEALTH_RECEIPT_WINDOW_KEY_PATTERN.exec(idempotencyKey);
  if (!match) return null;
  const datePart = match[1].slice(0, 10);
  const parsed = new Date(`${match[1]}${match[2] ?? "Z"}`);
  if (Number.isNaN(parsed.getTime())) return null;
  // Date normalizes shape-valid values such as 2026-02-30 into a different
  // calendar day. Round-trip the captured date before accepting the instant.
  return parsed.toISOString().startsWith(datePart) ? parsed : null;
}
