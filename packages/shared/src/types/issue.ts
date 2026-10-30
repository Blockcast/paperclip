import type {
  IssueCommentAuthorType,
  IssueCommentMetadataRowType,
  IssueCommentPresentationKind,
  IssueCommentPresentationTone,
  IssueExecutionMonitorClearReason,
  IssueExecutionMonitorKind,
  IssueExecutionMonitorRecoveryPolicy,
  IssueExecutionMonitorStateStatus,
  IssueExecutionDecisionOutcome,
  IssueMonitorScheduledBy,
  IssueMonitorGateSource,
  IssueExecutionPolicyMode,
  IssueReferenceSourceKind,
  IssueExecutionStageType,
  IssueExecutionStateStatus,
  IssueHarnessKind,
  IssueOriginKind,
  IssuePriority,
  IssueRecoveryActionKind,
  IssueRecoveryActionOutcome,
  IssueRecoveryActionOwnerType,
  IssueRecoveryActionStatus,
  IssueRecoveryActionRetiringBound,
  IssueWorkMode,
  ModelProfileKey,
  IssueThreadInteractionContinuationPolicy,
  IssueThreadInteractionKind,
  IssueThreadInteractionStatus,
  IssueStatus,
} from "../constants.js";
import type { Goal } from "./goal.js";
import type { Project, ProjectWorkspace } from "./project.js";
import type { ExecutionWorkspace, IssueExecutionWorkspaceSettings } from "./workspace-runtime.js";
import type { IssueWorkProduct } from "./work-product.js";
import type {
  LowTrustReviewPresetPolicy,
  SourceTrustMetadata,
  TrustAuthorizationPolicy,
} from "../trust-policy.js";

export type { IssueWorkMode };

export interface IssueAncestorProject {
  id: string;
  name: string;
  description: string | null;
  status: string;
  goalId: string | null;
  workspaces: ProjectWorkspace[];
  primaryWorkspace: ProjectWorkspace | null;
}

export interface IssueAncestorGoal {
  id: string;
  title: string;
  description: string | null;
  level: string;
  status: string;
}

export interface IssueAncestor {
  id: string;
  identifier: string | null;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  projectId: string | null;
  goalId: string | null;
  project: IssueAncestorProject | null;
  goal: IssueAncestorGoal | null;
}

export interface IssueLabel {
  id: string;
  companyId: string;
  name: string;
  color: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface IssueAssigneeAdapterOverrides {
  modelProfile?: ModelProfileKey;
  adapterConfig?: Record<string, unknown>;
  useProjectWorkspace?: boolean;
}

export type DocumentFormat = "markdown";

export interface IssueDocumentSummary {
  id: string;
  companyId: string;
  issueId: string;
  key: string;
  title: string | null;
  format: DocumentFormat;
  latestRevisionId: string | null;
  latestRevisionNumber: number;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  updatedByAgentId: string | null;
  updatedByUserId: string | null;
  lockedAt: Date | null;
  lockedByAgentId: string | null;
  lockedByUserId: string | null;
  sourceTrust?: SourceTrustMetadata | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface IssueDocument extends IssueDocumentSummary {
  body: string;
}

export interface DocumentRevision {
  id: string;
  companyId: string;
  documentId: string;
  issueId: string;
  key: string;
  revisionNumber: number;
  title: string | null;
  format: DocumentFormat;
  body: string;
  changeSummary: string | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  createdAt: Date;
}

export interface LegacyPlanDocument {
  key: "plan";
  body: string;
  source: "issue_description";
}

export type AcceptedPlanDecompositionStatus = "in_flight" | "completed";

export interface AcceptedPlanDecompositionChild {
  projectId?: string | null;
  projectWorkspaceId?: string | null;
  goalId?: string | null;
  blockedByIssueIds?: string[];
  title: string;
  description?: string | null;
  status: IssueStatus;
  workMode: IssueWorkMode;
  harnessKind?: IssueHarnessKind | null;
  priority: IssuePriority;
  assigneeAgentId?: string | null;
  assigneeUserId?: string | null;
  requestDepth?: number;
  billingCode?: string | null;
  assigneeAdapterOverrides?: IssueAssigneeAdapterOverrides | null;
  executionPolicy?: IssueExecutionPolicy | null;
  executionWorkspaceId?: string | null;
  executionWorkspacePreference?: string | null;
  executionWorkspaceSettings?: IssueExecutionWorkspaceSettings | null;
  labelIds?: string[];
  acceptanceCriteria?: string[];
  blockParentUntilDone?: boolean;
}

export interface AcceptedPlanDecomposition {
  id: string;
  companyId: string;
  sourceIssueId: string;
  acceptedPlanRevisionId: string;
  acceptedInteractionId: string | null;
  status: AcceptedPlanDecompositionStatus;
  requestFingerprint: string;
  requestedChildCount: number;
  childIssueIds: string[];
  ownerAgentId: string | null;
  ownerUserId: string | null;
  ownerRunId: string | null;
  completedAt: Date | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export interface AcceptedPlanDecompositionResult {
  decomposition: AcceptedPlanDecomposition;
  childIssueIds: string[];
  newlyCreatedChildIssueIds: string[];
}

export interface AcceptedPlanDecompositionChildIssue {
  id: string;
  identifier: string | null;
  title: string;
  status: IssueStatus;
  priority: IssuePriority;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
}

export interface AcceptedPlanDecompositionSummary extends AcceptedPlanDecomposition {
  acceptedPlanRevisionNumber: number | null;
  childIssues: AcceptedPlanDecompositionChildIssue[];
}

export interface IssueRelationIssueSummary {
  id: string;
  identifier: string | null;
  title: string;
  status: IssueStatus;
  priority: IssuePriority;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  terminalBlockers?: IssueRelationIssueSummary[];
  activeRecoveryAction?: IssueRecoveryAction | null;
}

export type IssueBlockerDiagnosticFlag =
  | "done_but_blocking"
  | "cancelled_blocker_in_set"
  | "workspace_finalize_pending";

export interface IssueBlockerDiagnosticIssueSummary {
  id: string;
  identifier: string | null;
  title: string;
  status: IssueStatus;
  priority: IssuePriority;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
}

export interface IssueBlockerDiagnosticNode extends IssueBlockerDiagnosticIssueSummary {
  isUnresolved: boolean;
  isDependencyReady: boolean;
  isPendingFinalize: boolean;
  flags: IssueBlockerDiagnosticFlag[];
}

export interface IssueBlockerDiagnosticsReadiness {
  allBlockersDone: boolean;
  isDependencyReady: boolean;
  unresolvedBlockerCount: number;
  pendingFinalizeBlockerCount: number;
}

export interface IssueBlockerDiagnosticsResponse {
  issue: IssueBlockerDiagnosticIssueSummary;
  diagnosis: string | null;
  readiness: IssueBlockerDiagnosticsReadiness | null;
  blockers: IssueBlockerDiagnosticNode[];
  omittedUnauthorizedBlockerCount: number | null;
  truncated: boolean;
  caps: {
    maxBlockers: number;
  };
}

export type IssueWakeDiagnosticWakeFailureClass = "failed" | "cancelled" | "skipped";

/**
 * PEN-3877: which component acted on this wake row, where that is attributable
 * from a server-authored marker rather than inferred.
 *
 * Today the only attributable actor is the lockless deferred-wake drain, whose
 * three acting verbs each stamp a distinct literal into
 * `agent_wakeup_requests.error`. `null` means "no attributable marker" — which
 * includes an ordinary finalizer promotion, because that path promotes the row
 * in place with `error: null` and so is distinguished by the absence.
 *
 * The raw `error` column is deliberately NOT exposed: it is not uniformly
 * server-authored (see `locklessDeferredWakeDisposition`).
 */
export type IssueWakeDiagnosticWakeDisposition =
  | "lockless_drain_promoted"
  | "lockless_drain_cancelled_dependency_blocked"
  | "lockless_drain_cancelled_terminal";

export interface IssueWakeDiagnosticWakeRequest {
  kind: "wake_request";
  agentId: string | null;
  source: string;
  reason: string | null;
  status: string;
  coalescedCount: number;
  runId: string | null;
  requestedAt: string;
  claimedAt: string | null;
  finishedAt: string | null;
  failureClass: IssueWakeDiagnosticWakeFailureClass | null;
  disposition: IssueWakeDiagnosticWakeDisposition | null;
}

export interface IssueWakeDiagnosticActivityRecord {
  kind: "activity";
  action: string;
  entityType: string;
  agentId: string | null;
  runId: string | null;
  createdAt: string;
  source: string | null;
  requestedReason: string | null;
  previousReason: string | null;
  rootIssueId: string | null;
  holdId: string | null;
  summary: string;
}

export type IssueWakeDiagnosticEvent =
  | IssueWakeDiagnosticWakeRequest
  | IssueWakeDiagnosticActivityRecord;

export interface IssueWakeDiagnosticsResponse {
  issue: IssueBlockerDiagnosticIssueSummary;
  diagnosis: string | null;
  likelyReason: string | null;
  events: IssueWakeDiagnosticEvent[];
  wakeRequestCount: number;
  activityRecordCount: number;
  truncated: boolean;
  truncatedSections: {
    wakeRequests: boolean;
    activityRecords: boolean;
  };
  caps: {
    maxWakeRequests: number;
    maxActivityRecords: number;
    lookbackDays: number;
  };
}

export interface IssueSubtreeDiagnosticNode {
  issue: IssueBlockerDiagnosticIssueSummary;
  parentId: string | null;
  depth: number;
  diagnosis: string | null;
  likelyReason: string | null;
  blockers: IssueBlockerDiagnosticNode[];
  blockerReadiness: IssueBlockerDiagnosticsReadiness | null;
  omittedUnauthorizedBlockerCount: number | null;
  wakeEvents: IssueWakeDiagnosticEvent[];
  wakeRequestCount: number;
  activityRecordCount: number;
  truncated: boolean;
  truncatedSections: {
    blockers: boolean;
    wakeRequests: boolean;
    activityRecords: boolean;
  };
}

export type IssueSubtreeDiagnosticEdge =
  | {
    kind: "parent";
    fromIssueId: string;
    toIssueId: string;
    timestamp: string | null;
  }
  | {
    kind: "blocks";
    fromIssueId: string;
    toIssueId: string;
    timestamp: string | null;
  }
  | {
    kind: "wake_request";
    issueId: string;
    agentId: string | null;
    reason: string | null;
    status: string;
    timestamp: string;
  }
  | {
    kind: "activity";
    issueId: string;
    action: string;
    timestamp: string;
  };

export interface IssueSubtreeDiagnosticsResponse {
  issue: IssueBlockerDiagnosticIssueSummary;
  diagnosis: string | null;
  likelyReason: string | null;
  nodes: IssueSubtreeDiagnosticNode[];
  edges: IssueSubtreeDiagnosticEdge[];
  nodeCount: number;
  omittedUnauthorizedNodeCount: number | null;
  truncated: boolean;
  truncatedSections: {
    nodes: boolean;
    depth: boolean;
    blockers: boolean;
    wakeRequests: boolean;
    activityRecords: boolean;
  };
  caps: {
    maxDepth: number;
    maxNodes: number;
    maxBlockersPerNode: number;
    maxWakeRequestsPerNode: number;
    maxActivityRecordsPerNode: number;
    lookbackDays: number;
  };
}

export type IssueBlockerAttentionState = "none" | "covered" | "stalled" | "needs_attention";

export type IssueBlockerAttentionReason =
  | "active_child"
  | "active_dependency"
  | "stalled_review"
  | "attention_required"
  | null;

export interface IssueBlockerAttention {
  state: IssueBlockerAttentionState;
  reason: IssueBlockerAttentionReason;
  unresolvedBlockerCount: number;
  coveredBlockerCount: number;
  stalledBlockerCount: number;
  attentionBlockerCount: number;
  sampleBlockerIdentifier: string | null;
  sampleStalledBlockerIdentifier: string | null;
  /**
   * PEN-5105, OBSERVATION ONLY. How many of this row's top-level blockers reached
   * `covered` through the human-assigned arm specifically -- `assigneeUserId` set and
   * status not `cancelled`, which covers unconditionally with no staleness term.
   *
   * This is NOT a subset you can derive from `coveredBlockerCount`: a blocker also
   * reaches `covered` by being `done`, by carrying a pending interaction, by holding a
   * live run/monitor/park, or by the downstream recursion. Only this arm is unbounded in
   * time, so only this count sizes the population a staleness conjunct would touch.
   *
   * **It is an UPPER BOUND on what a staleness conjunct would un-cover, not an exact
   * count.** This arm returns BEFORE the `in_review` arm, the downstream recursion and the
   * leaf monitor/run/park checks. A blocker that failed a new staleness conjunct here would
   * fall through to those arms, and any of them may still cover it. So the true delta is
   * `<=` this number. That is the safe direction for sizing a blast radius -- it can only
   * overstate the flood -- but read it as "depends on this arm", never as "would be
   * un-covered". The exact figure needs a second classification pass with the arm disabled,
   * which the PR that takes the conjunct has to compute anyway.
   *
   * It changes no `state`, no `reason` and no other count. It exists so the threshold in
   * PEN-5105 can be chosen against a measured blast radius instead of a guess, and so the
   * flood is measurable BEFORE it is taken.
   */
  humanAssignedCoveredBlockerCount: number;
  /**
   * PEN-5105, OBSERVATION ONLY. Idle hours of the stalest blocker counted in
   * {@link humanAssignedCoveredBlockerCount}, or `null` when that count is 0.
   *
   * **The clock is `issues.last_activity_at`, and its error direction is the whole reason
   * it is the right one.** Migration 0076 maintains that column as a UNION: a BEFORE
   * UPDATE trigger mirrors every `updated_at` bump into it, and an AFTER INSERT trigger on
   * `issue_comments` bumps it to each new comment. So it advances on any write by anyone --
   * human, agent or system.
   *
   * That makes it useless for asserting attendance (`heartbeat.ts` rejects it for exactly
   * this reason: the run-finalization write would make every summary look fresh) but
   * correct for asserting its ABSENCE. Fresh does not prove a human attended; stale proves
   * nothing touched the row at all, which is strictly stronger. A staleness conjunct only
   * ever acts on the stale side, so this clock can only UNDER-report staleness -- and
   * under-reporting leaves a blocker `covered`, preserving today's behaviour. The error
   * direction is toward the status quo, never toward the flood.
   *
   * Consequence when reading the measurement: these spans are a LOWER BOUND on human
   * idleness. A threshold chosen from them is conservative by construction.
   */
  oldestHumanAssignedCoveredIdleHours: number | null;
}

export type IssueInboxAttentionKind = "blocked";

export type IssueBlockedInboxState =
  | "needs_attention"
  | "awaiting_decision"
  | "external_wait"
  | "recovery_open"
  | "missing_disposition";

export type IssueBlockedInboxSeverity = "critical" | "high" | "medium" | "low";

export type IssueBlockedInboxReason =
  | "blocked_by_unassigned_issue"
  | "blocked_by_assigned_backlog_issue"
  | "blocked_by_uninvokable_assignee"
  | "blocked_by_cancelled_issue"
  | "blocked_without_blockers"
  | "blocked_chain_stalled"
  | "invalid_review_participant"
  | "in_review_without_action_path"
  | "missing_successful_run_disposition"
  | "pending_board_decision"
  | "pending_approval_revision"
  | "pending_user_decision"
  | "external_owner_action"
  | "open_recovery_issue";

export type IssueBlockedInboxOwnerType = "agent" | "user" | "board" | "external" | "unknown";

export interface IssueBlockedInboxIssueRef {
  id: string;
  identifier: string | null;
  title: string;
  status: IssueStatus;
  priority: IssuePriority;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
}

export interface IssueBlockedInboxOwner {
  type: IssueBlockedInboxOwnerType;
  agentId: string | null;
  userId: string | null;
  label: string | null;
}

export interface IssueBlockedInboxAction {
  label: string;
  detail: string | null;
}

export interface IssueBlockedInboxAttention {
  kind: IssueInboxAttentionKind;
  state: IssueBlockedInboxState;
  reason: IssueBlockedInboxReason;
  severity: IssueBlockedInboxSeverity;
  stoppedSinceAt: string | null;
  owner: IssueBlockedInboxOwner;
  action: IssueBlockedInboxAction;
  sourceIssue: IssueBlockedInboxIssueRef | null;
  leafIssue: IssueBlockedInboxIssueRef | null;
  recoveryIssue: IssueBlockedInboxIssueRef | null;
  approvalId: string | null;
  interactionId: string | null;
  // PEN-4193: the pending interaction on THIS row that is older than
  // `PENDING_INTERACTION_MAX_AGE_MS`, or null. Always populated when such a card
  // exists, on every branch of the reason ladder, independently of which branch
  // claimed the row. `interactionId` cannot carry it: on the interaction branch
  // that field means "the live card to answer", and the ladder reaches that
  // branch only for cards *inside* the window, so an overdue card reported there
  // would contradict the action label. Keeping it in its own field is what makes
  // "is anything overdue on this row?" answerable without re-deriving the cutoff.
  overdueInteractionId: string | null;
  sampleIssueIdentifier: string | null;
  redaction: {
    externalDetailsRedacted: boolean;
    secretFieldsOmitted: true;
  };
}

// BLO-34216: the single source of truth for the productivity-review trigger
// set. The union type below, both runtime parse-side allowlists (issues.ts,
// productivity-review.ts) and both label maps derive from this tuple, so adding
// a trigger is one line here plus a label in each map — the maps are
// `Record<Trigger, string>`, so a missing label is a red build, not a silent
// fallback — plus a predicate in `choosePrimaryTrigger` and a push in
// `firedTriggers`, neither of which the compiler can enforce: both read a
// hand-written set of booleans, so a tuple member with no predicate compiles
// clean and can never fire. The trigger round-trips through markdown via
// `extractReviewTriggerFromDescription` rather than a DB enum, so a
// hand-maintained allowlist that drifted failed quietly — it silently stopped
// parsing an already-written review rather than failing a typecheck.
export const ISSUE_PRODUCTIVITY_REVIEW_TRIGGERS = [
  "no_comment_streak",
  "long_active_duration",
  "high_churn",
  "runtime_failure_streak",
  // BLO-27698 B3b: one still-live run has held its turn longer than the
  // long-active bar. Kept distinct from `long_active_duration`, which measures
  // time nobody was accounting for.
  "runaway_execution",
] as const;

export type IssueProductivityReviewTrigger = (typeof ISSUE_PRODUCTIVITY_REVIEW_TRIGGERS)[number];

export interface IssueProductivityReview {
  reviewIssueId: string;
  reviewIdentifier: string | null;
  status: IssueStatus;
  priority: IssuePriority;
  trigger: IssueProductivityReviewTrigger | null;
  noCommentStreak: number | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface IssueRecoveryAction {
  id: string;
  companyId: string;
  sourceIssueId: string;
  recoveryIssueId: string | null;
  kind: IssueRecoveryActionKind;
  status: IssueRecoveryActionStatus;
  ownerType: IssueRecoveryActionOwnerType;
  ownerAgentId: string | null;
  ownerUserId: string | null;
  previousOwnerAgentId: string | null;
  returnOwnerAgentId: string | null;
  cause: string;
  fingerprint: string;
  evidence: Record<string, unknown>;
  nextAction: string;
  wakePolicy: Record<string, unknown> | null;
  monitorPolicy: Record<string, unknown> | null;
  attemptCount: number;
  nonDeliverySweepCount: number;
  maxAttempts: number | null;
  timeoutAt: Date | string | null;
  retiringBound: IssueRecoveryActionRetiringBound | null;
  lastAttemptAt: Date | string | null;
  outcome: IssueRecoveryActionOutcome | null;
  resolutionNote: string | null;
  resolvedAt: Date | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export type SuccessfulRunHandoffStateKind = "required" | "resolved" | "escalated";

export interface SuccessfulRunHandoffState {
  state: SuccessfulRunHandoffStateKind;
  required: boolean;
  hasLiveContinuation: boolean;
  liveRunId?: string | null;
  sourceRunId: string | null;
  correctiveRunId: string | null;
  assigneeAgentId: string | null;
  detectedProgressSummary: string | null;
  createdAt: Date | string | null;
  // Set when the handoff reads `resolved` because its source issue reached a
  // terminal status rather than because a corrective run discharged it. Absent
  // on every handoff resolved the ordinary way, so a reader can tell the two
  // apart instead of inferring a continuation that never ran (BLO-16074).
  resolvedBySourceIssueStatus?: "done" | "cancelled" | null;
  // Set when the handoff reads `resolved` because something continued the issue
  // after the requirement was recorded, without a run writing the resolution
  // row (BLO-47584): the issue now has a live review path.
  resolvedByContinuation?: "pending_interaction" | "pending_approval" | "monitor" | "human_assignee" | null;
}

export type IssueScheduledRetryStatus = "scheduled_retry" | "queued" | "running" | "cancelled";

export interface IssueScheduledRetry {
  runId: string;
  status: IssueScheduledRetryStatus;
  agentId: string;
  agentName: string | null;
  retryOfRunId: string | null;
  scheduledRetryAt: Date | string | null;
  scheduledRetryAttempt: number;
  scheduledRetryReason: string | null;
  retryExhaustedReason?: string | null;
  error?: string | null;
  errorCode?: string | null;
}

export type IssueRetryNowOutcome =
  | "promoted"
  | "already_promoted"
  | "no_scheduled_retry"
  | "gate_suppressed"
  | "re_deferred";

export interface IssueRetryNowResponse {
  outcome: IssueRetryNowOutcome;
  message: string;
  scheduledRetry: IssueScheduledRetry | null;
}

export interface IssueRelation {
  id: string;
  companyId: string;
  issueId: string;
  relatedIssueId: string;
  type: "blocks";
  relatedIssue: IssueRelationIssueSummary;
}

export interface IssueReferenceSource {
  kind: IssueReferenceSourceKind;
  sourceRecordId: string | null;
  label: string;
  matchedText: string | null;
  href?: string | null;
  sourceIssueId?: string | null;
  sourceIssueIdentifier?: string | null;
}

export interface IssueRelatedWorkItem {
  issue: IssueRelationIssueSummary;
  mentionCount: number;
  sources: IssueReferenceSource[];
}

export interface IssueRelatedWorkSummary {
  outbound: IssueRelatedWorkItem[];
  inbound: IssueRelatedWorkItem[];
}

export interface IssueExecutionStagePrincipal {
  type: "agent" | "user";
  agentId?: string | null;
  userId?: string | null;
}

export interface IssueExecutionStageParticipant extends IssueExecutionStagePrincipal {
  id: string;
}

export interface IssueExecutionStage {
  id: string;
  type: IssueExecutionStageType;
  approvalsNeeded: 1;
  participants: IssueExecutionStageParticipant[];
}

export interface IssueExecutionMonitorPolicy {
  nextCheckAt: string;
  notes: string | null;
  scheduledBy: IssueMonitorScheduledBy;
  kind?: IssueExecutionMonitorKind | null;
  serviceName?: string | null;
  externalRef?: string | null;
  timeoutAt?: string | null;
  maxAttempts?: number | null;
  recoveryPolicy?: IssueExecutionMonitorRecoveryPolicy | null;
  productivityReviewDisabled?: boolean;
  /**
   * BLO-18294: the gates this monitor is waiting on. When present (or when the
   * issue has unresolved blocker edges), the convergence guard fingerprints
   * these instead of free-form `notes`, so unrelated churn cannot read as
   * progress and keep a no-op poll loop alive.
   */
  gateSignals?: string[] | null;
}

export interface IssueExecutionPolicy {
  mode: IssueExecutionPolicyMode;
  commentRequired: boolean;
  stages: IssueExecutionStage[];
  monitor?: IssueExecutionMonitorPolicy | null;
  reviewPreset?: LowTrustReviewPresetPolicy;
  authorizationPolicy?: TrustAuthorizationPolicy;
  /**
   * BLO-39945: opt a deliberately-permanent row out of productivity review
   * without arming a monitor it does not need.
   *
   * `isProductivityReviewOptedOut` honours this OR the older
   * `IssueExecutionMonitorPolicy.productivityReviewDisabled` — but the two are
   * not equivalent in lifetime, and only this one is durable. The nested form
   * is a property of the monitor: clearing that monitor runs the policy through
   * `stripMonitorFromExecutionPolicy`, which drops `monitor` wholesale (and
   * collapses a monitor-only policy to null), so the nested opt-out dies with
   * the monitor it was attached to. Set it here for anything meant to last.
   */
  productivityReviewDisabled?: boolean;
}

export interface IssueExecutionMonitorState {
  status: IssueExecutionMonitorStateStatus;
  nextCheckAt: string | null;
  lastTriggeredAt: string | null;
  attemptCount: number;
  notes: string | null;
  scheduledBy: IssueMonitorScheduledBy | null;
  kind?: IssueExecutionMonitorKind | null;
  serviceName?: string | null;
  externalRef?: string | null;
  timeoutAt?: string | null;
  maxAttempts?: number | null;
  recoveryPolicy?: IssueExecutionMonitorRecoveryPolicy | null;
  /** BLO-18294: convergence bookkeeping — see IssueExecutionMonitorPolicy.gateSignals. */
  gateSignals?: string[] | null;
  gateFingerprint?: string | null;
  gateSource?: IssueMonitorGateSource | null;
  convergenceCount?: number;
  convergenceStallCount?: number;
  convergenceStalledAssigneeAgentId?: string | null;
  clearedAt: string | null;
  clearReason: IssueExecutionMonitorClearReason | null;
}

export interface IssueReviewRequest {
  instructions: string;
}

export interface IssueExecutionState {
  status: IssueExecutionStateStatus;
  currentStageId: string | null;
  currentStageIndex: number | null;
  currentStageType: IssueExecutionStageType | null;
  currentParticipant: IssueExecutionStagePrincipal | null;
  returnAssignee: IssueExecutionStagePrincipal | null;
  reviewRequest: IssueReviewRequest | null;
  completedStageIds: string[];
  lastDecisionId: string | null;
  lastDecisionOutcome: IssueExecutionDecisionOutcome | null;
  monitor?: IssueExecutionMonitorState | null;
}

export interface IssueExecutionDecision {
  id: string;
  companyId: string;
  issueId: string;
  stageId: string;
  stageType: IssueExecutionStageType;
  actorAgentId: string | null;
  actorUserId: string | null;
  outcome: IssueExecutionDecisionOutcome;
  body: string;
  createdByRunId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type IssueWatchdogStatus = "active" | "disabled";

export interface IssueWatchdogSummary {
  id: string;
  companyId: string;
  issueId: string;
  watchdogAgentId: string;
  instructions: string | null;
  status: IssueWatchdogStatus;
  watchdogIssueId: string | null;
  lastObservedFingerprint: string | null;
  lastReviewedFingerprint: string | null;
  lastTriggeredAt: Date | null;
  lastCompletedAt: Date | null;
  triggerCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface IssueWatchdog extends IssueWatchdogSummary {
  createdByAgentId: string | null;
  createdByUserId: string | null;
  createdByRunId: string | null;
  updatedByAgentId: string | null;
  updatedByUserId: string | null;
  updatedByRunId: string | null;
}

export interface Issue {
  id: string;
  companyId: string;
  projectId: string | null;
  projectWorkspaceId: string | null;
  goalId: string | null;
  parentId: string | null;
  milestoneId: string | null;
  targetDate: string | null;
  ancestors?: IssueAncestor[];
  title: string;
  description: string | null;
  status: IssueStatus;
  workMode: IssueWorkMode;
  priority: IssuePriority;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  checkoutRunId: string | null;
  executionRunId: string | null;
  executionAgentNameKey: string | null;
  executionLockedAt: Date | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  responsibleUserId: string | null;
  issueNumber: number | null;
  identifier: string | null;
  originKind?: IssueOriginKind;
  originId?: string | null;
  originRunId?: string | null;
  originFingerprint?: string | null;
  requestDepth: number;
  billingCode: string | null;
  assigneeAdapterOverrides: IssueAssigneeAdapterOverrides | null;
  executionPolicy?: IssueExecutionPolicy | null;
  executionState?: IssueExecutionState | null;
  monitorNextCheckAt?: Date | null;
  monitorLastTriggeredAt?: Date | null;
  monitorAttemptCount?: number;
  monitorNotes?: string | null;
  monitorScheduledBy?: IssueMonitorScheduledBy | null;
  // BLO-27912: the deliberate-park disposition. Server-owned (hence optional/read-only
  // here) and written only via the nested `parkedDisposition` PATCH input. `parkedUntil`
  // in the future is the seventh explicit waiting path the liveness sweep accepts; once it
  // lapses the row is detectable again without anyone having to un-park it.
  parkedUntil?: Date | null;
  parkedReason?: string | null;
  parkedByAgentId?: string | null;
  parkedAt?: Date | null;
  /**
   * PEN-4420: when THIS park's one-shot expiry wake fired, or `null` while it has not.
   *
   * ⚠️ PEN-4894: NOT DURABLE, and NOT an audit record of park wakes. This is the sweep's
   * fire-once CLAIM marker, scoped to the park currently on the row. The park writer
   * resets it to `null` on every `parkedDisposition` write (`services/issues.ts`), so the
   * next re-park erases it — and a park wake that WORKS dispatches a run which routinely
   * re-parks. The field therefore deletes its own positive cases, and deletes more of them
   * the better the release edge works.
   *
   * Measured 2026-10-28 on a 7-row cohort parked to one shared instant: 7 of 7 fired and
   * 7 of 7 read `null` here 45 minutes later, every one re-parked in between.
   *
   * ⇒ `null` means "no release wake is owed for the park on this row right now". It does
   * NOT mean "this row's park never woke", and reading it that way is wrong in the
   * reassuring direction. To ask whether park wakes FIRED, use
   * `GET /api/issues/:id/diagnostics/wakes` — but note it is a BOUNDED view of
   * `agent_wakeup_requests` (last 50 requests, 14-day lookback, no pagination), so check
   * `caps` and `truncatedSections.wakeRequests` before reading an absence as a negative.
   * Full account, and the two other ways this field reaches `null`:
   * `runbooks/deliberate-park-release-edge.md`.
   *
   * Projected read-only alongside the four park columns for the same reason they are: the
   * audit that found PEN-4420 (PEN-4419) is a client-side query over list rows, and "is
   * this park's release edge still pending?" — the question this field answers correctly —
   * is the one it has to ask.
   */
  parkedWakeFiredAt?: Date | null;
  /**
   * Flat scheduled-retry projection carried by every issue **list** row
   * (BLO-28843). Present-and-null when the issue has no run parked in
   * `scheduled_retry`; never absent on a list row.
   *
   * These mirror the `scheduledRetry` object returned by the single-issue read
   * for the same issue — an issue is attended by exactly one of three paths (a
   * live `activeRun`, an armed `monitor*`, or a scheduled retry), and a list
   * consumer that reads only the first two systematically over-reports
   * "unattended".
   */
  scheduledRetryAt?: Date | null;
  scheduledRetryReason?: string | null;
  scheduledRetryAttempt?: number | null;
  executionWorkspaceId: string | null;
  executionWorkspacePreference: string | null;
  executionWorkspaceSettings: IssueExecutionWorkspaceSettings | null;
  startedAt: Date | null;
  completedAt: Date | null;
  cancelledAt: Date | null;
  hiddenAt: Date | null;
  sourceTrust?: SourceTrustMetadata | null;
  labelIds?: string[];
  labels?: IssueLabel[];
  blockedBy?: IssueRelationIssueSummary[];
  blocks?: IssueRelationIssueSummary[];
  blockerAttention?: IssueBlockerAttention;
  blockedInboxAttention?: IssueBlockedInboxAttention | null;
  productivityReview?: IssueProductivityReview | null;
  /**
   * Last verdict from the artifact-evidence gate (BLO-4461). Written by the
   * server on PATCH transitions to `in_review`. Null when the issue has
   * never transitioned to `in_review` under the gate. Phase 1 is warn-only
   * (verdict recorded but never blocks PATCH); Phase 2 (BLO-4828) flips
   * block verdicts to 422.
   */
  lastEvidenceVerdict?: {
    verdict: "pass" | "warn" | "block";
    missing: string[];
    evidenceFound: string[];
    unlabeledFallback: boolean;
    overridden?: boolean;
    overrideReason?: string;
    evaluatedAt: string;
  } | null;
  activeRecoveryAction?: IssueRecoveryAction | null;
  successfulRunHandoff?: SuccessfulRunHandoffState | null;
  watchdog?: IssueWatchdogSummary | null;
  scheduledRetry?: IssueScheduledRetry | null;
  liveDescendantCount?: number;
  relatedWork?: IssueRelatedWorkSummary;
  referencedIssueIdentifiers?: string[];
  planDocument?: IssueDocument | null;
  documentSummaries?: IssueDocumentSummary[];
  legacyPlanDocument?: LegacyPlanDocument | null;
  project?: Project | null;
  goal?: Goal | null;
  currentExecutionWorkspace?: ExecutionWorkspace | null;
  workProducts?: IssueWorkProduct[];
  mentionedProjects?: Project[];
  myLastTouchAt?: Date | null;
  lastExternalCommentAt?: Date | null;
  lastActivityAt?: Date | null;
  isUnreadForMe?: boolean;
  archivedAt?: Date | null;
  archivedByActorType?: "user" | "agent" | null;
  archivedByAgentId?: string | null;
  archivedByRunId?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type CompactIssue = Pick<
  Issue,
  | "id"
  | "companyId"
  | "projectId"
  | "projectWorkspaceId"
  | "goalId"
  | "parentId"
  | "title"
  | "description"
  | "status"
  | "workMode"
  | "priority"
  | "assigneeAgentId"
  | "assigneeUserId"
  | "checkoutRunId"
  | "executionRunId"
  | "executionAgentNameKey"
  | "executionLockedAt"
  | "createdByAgentId"
  | "createdByUserId"
  | "issueNumber"
  | "identifier"
  | "originKind"
  | "originId"
  | "originRunId"
  | "requestDepth"
  | "billingCode"
  | "executionWorkspaceId"
  | "startedAt"
  | "completedAt"
  | "cancelledAt"
  | "createdAt"
  | "updatedAt"
> & {
  /**
   * PEN-4450: `true` when the stored description is longer than the list projection's
   * character cap, so `description` here is a prefix. Always present on a list row — an
   * ABSENT key means the server predates this field and the question is unanswerable
   * from this response, which is not the same as `false`. Read the row with
   * `GET /api/issues/:id` to get the whole description.
   *
   * It describes the STORED column. On a blocked-inbox row whose description was also
   * redacted, both claims hold independently: text was removed from within the prefix
   * AND there is more text past it.
   */
  descriptionTruncated?: boolean;
  labelIds?: string[];
  labels?: IssueLabel[];
  blockedBy?: IssueRelationIssueSummary[];
  blockerAttention?: IssueBlockerAttention;
  blockedInboxAttention?: IssueBlockedInboxAttention | null;
  productivityReview?: IssueProductivityReview | null;
  scheduledRetry?: IssueScheduledRetry | null;
  liveDescendantCount?: number;
  myLastTouchAt?: Date | null;
  lastExternalCommentAt?: Date | null;
  lastActivityAt?: Date | null;
  isUnreadForMe?: boolean;
  archivedAt?: Date | null;
  archivedByActorType?: "user" | "agent" | null;
  archivedByAgentId?: string | null;
  archivedByRunId?: string | null;
  activeRecoveryAction: IssueRecoveryAction | null;
  successfulRunHandoff: SuccessfulRunHandoffState | null;
};

/**
 * Where a comment's derived (non-stored-author) agent attribution came from,
 * in descending confidence:
 * - `run_id`: comment carries a `createdByRunId`/`derivedCreatedByRunId` whose
 *   run resolves directly to an agent (lossless).
 * - `run_log_comment_post`: a run log within the comment window contains the
 *   `comment id: {id}` post marker (lossless: the run recorded posting it).
 *
 * Only lossless signals are used. Pure run-window timing overlap is NOT a
 * source — it cannot distinguish an agent comment from a human board comment
 * that coincided with a run (Option A).
 */
export type IssueCommentDerivedAuthorSource =
  | "run_id"
  | "run_log_comment_post";

export interface IssueComment {
  id: string;
  companyId: string;
  issueId: string;
  authorType: IssueCommentAuthorType;
  authorAgentId: string | null;
  authorUserId: string | null;
  createdByRunId?: string | null;
  derivedAuthorAgentId?: string | null;
  derivedCreatedByRunId?: string | null;
  derivedAuthorSource?: IssueCommentDerivedAuthorSource | null;
  idempotencyKey?: string | null;
  idempotencyProcessedAt?: Date | null;
  body: string;
  presentation: IssueCommentPresentation | null;
  metadata: IssueCommentMetadata | null;
  deletedAt?: Date | null;
  deletedByType?: "agent" | "user" | null;
  deletedByAgentId?: string | null;
  deletedByUserId?: string | null;
  deletedByRunId?: string | null;
  sourceTrust?: SourceTrustMetadata | null;
  followUpRequested?: boolean;
  createdAt: Date;
  updatedAt: Date;
}

interface IssueCommentMetadataRowBase {
  type: IssueCommentMetadataRowType;
  label?: string | null;
}

export interface IssueCommentMetadataTextRow extends IssueCommentMetadataRowBase {
  type: "text";
  text: string;
}

export interface IssueCommentMetadataCodeRow extends IssueCommentMetadataRowBase {
  type: "code";
  code: string;
  language?: string | null;
}

export interface IssueCommentMetadataKeyValueRow extends IssueCommentMetadataRowBase {
  type: "key_value";
  label: string;
  value: string;
}

export interface IssueCommentMetadataIssueLinkRow extends IssueCommentMetadataRowBase {
  type: "issue_link";
  issueId?: string | null;
  identifier?: string | null;
  title?: string | null;
}

export interface IssueCommentMetadataAgentLinkRow extends IssueCommentMetadataRowBase {
  type: "agent_link";
  agentId: string;
  name?: string | null;
}

export interface IssueCommentMetadataRunLinkRow extends IssueCommentMetadataRowBase {
  type: "run_link";
  runId: string;
  title?: string | null;
}

export type IssueCommentMetadataRow =
  | IssueCommentMetadataTextRow
  | IssueCommentMetadataCodeRow
  | IssueCommentMetadataKeyValueRow
  | IssueCommentMetadataIssueLinkRow
  | IssueCommentMetadataAgentLinkRow
  | IssueCommentMetadataRunLinkRow;

export interface IssueCommentMetadataSection {
  title?: string | null;
  rows: IssueCommentMetadataRow[];
}

export interface IssueCommentMetadata {
  version: 1;
  sourceRunId?: string | null;
  sections: IssueCommentMetadataSection[];
}

export interface IssueCommentPresentation {
  kind: IssueCommentPresentationKind;
  tone: IssueCommentPresentationTone;
  title?: string | null;
  detailsDefaultOpen: boolean;
}

export interface IssueThreadInteractionActorFields {
  createdByAgentId?: string | null;
  createdByUserId?: string | null;
  resolvedByAgentId?: string | null;
  resolvedByUserId?: string | null;
}

export interface SuggestedTaskDraft {
  clientKey: string;
  parentClientKey?: string | null;
  parentId?: string | null;
  title: string;
  description?: string | null;
  priority?: IssuePriority | null;
  workMode?: IssueWorkMode | null;
  assigneeAgentId?: string | null;
  assigneeUserId?: string | null;
  projectId?: string | null;
  goalId?: string | null;
  billingCode?: string | null;
  labels?: string[];
  hiddenInPreview?: boolean;
}

export interface SuggestTasksPayload {
  version: 1;
  defaultParentId?: string | null;
  tasks: SuggestedTaskDraft[];
}

export interface SuggestTasksResultCreatedTask {
  clientKey: string;
  issueId: string;
  identifier?: string | null;
  title?: string | null;
  parentIssueId?: string | null;
  parentIdentifier?: string | null;
}

export interface SuggestTasksResult {
  version: 1;
  createdTasks?: SuggestTasksResultCreatedTask[];
  skippedClientKeys?: string[];
  rejectionReason?: string | null;
  cancelled?: true;
  cancellationReason?: string | null;
}

export interface AskUserQuestionsQuestionOption {
  id: string;
  label: string;
  description?: string | null;
}

export interface AskUserQuestionsQuestion {
  id: string;
  prompt: string;
  helpText?: string | null;
  selectionMode: "single" | "multi";
  required?: boolean;
  options: AskUserQuestionsQuestionOption[];
}

export interface AskUserQuestionsPayload {
  version: 1;
  title?: string | null;
  submitLabel?: string | null;
  supersedeOnUserComment?: boolean;
  questions: AskUserQuestionsQuestion[];
}

export interface AskUserQuestionsAnswer {
  questionId: string;
  optionIds: string[];
  otherText?: string | null;
}

export interface AskUserQuestionsResult {
  version: 1;
  answers: AskUserQuestionsAnswer[];
  cancelled?: true;
  cancellationReason?: string | null;
  expirationReason?: "superseded_by_comment";
  commentId?: string | null;
  summaryMarkdown?: string | null;
}

/**
 * What an acceptance AUTHORISES, declared by the agent that files the ask
 * (PEN-4409).
 *
 * ## The gap this closes
 *
 * An accepted interaction records that a decision was *made* and nothing
 * anywhere records whether the action it authorised actually *happened*. The
 * measured instance is interaction `f2a8595c`: `status: accepted`, resolved
 * 2026-10-19T07:01:42Z, authorising the merge of `Blockcast/paperclip#2584`.
 * 26h45m and 28 unrelated merges later the PR was still open, the card still
 * read `accepted`, and the card had emitted nothing. Its whole payload was
 * `{version, prompt, acceptLabel, …}` — not one field naming the PR. So an
 * accepted decision whose action never happened is byte-identical to one whose
 * action did, and nothing can query the difference.
 *
 * ## Why this is DECLARED and never extracted from prose
 *
 * The obvious cheaper design — scan `prompt` / `detailsMarkdown` for a PR
 * number, a SHA, an issue key — is a decoy, and shipping it would be worse than
 * shipping nothing. `f2a8595c`'s prose names `#2584`, `#2569`, `3ecdf1dd`,
 * `8b14f0e6`, `PEN-4318`, `PEN-4284`, `ci.yml:578`, `:1380`, `27.7%` and
 * `02:30–03:30Z`. An extractor picks one. The correct answer (`#2584`) is not
 * the first, not the most frequent, and not distinguishable by shape from
 * `#2569` — the PR the DECLINE path would have acted on. When the extractor
 * picks wrong the sweep reports a *tracked* card observing the wrong object and
 * calls it green while the authorised action never happened. A false clear is
 * strictly worse than today's honest silence: silence does not claim to have
 * checked.
 *
 * The agent that writes the ask is the only party that knows what it is asking
 * for. Nobody downstream can recover that from prose.
 *
 * ## Why the `kind` set is small, and why it stays small
 *
 * Every admitted `kind` MUST have a durable in-process observer, or the field
 * manufactures the opposite failure: a card declaring an outcome nothing can
 * ever observe sits in `unobserved` forever and trains readers to ignore the
 * bucket. Both kinds below resolve against a table this process already holds,
 * needing no new credential and no new workload — the same argument that keeps
 * the approval-queue gauges in the app rather than in a sidecar exporter.
 *
 * `github_pr_approved` is DELIBERATELY ABSENT. The only approval state the
 * installation persists is `pull_request_review_state`, which covers **open**
 * PRs and is pruned once a PR leaves the open set. An approval observed before
 * the merge would become unobservable after it, so the card would flip back
 * from `observed` to `unobserved` permanently — a false alarm that never
 * clears. Add it when an approval record outlives the PR's open state, not
 * before.
 *
 * Adding a kind is therefore a two-part change: the variant here AND its
 * observer in `accepted-interaction-outcome-sweep.ts`. A kind with no observer
 * is classified `unobserved` (never `observed`), so forgetting the second half
 * fails toward the alarm, not toward the clear.
 */
export interface InteractionExpectedOutcomeGithubPrMerged {
  kind: "github_pr_merged";
  /**
   * Observed against `issue_pull_requests`, which is webhook-fed on merge and
   * backfilled by the merged-PR reconciler.
   *
   * ABSENCE OF A ROW IS NOT EVIDENCE OF NON-MERGE — it is absence of a record,
   * and the reconciler only discovers a repo once it has at least one
   * forward-captured PR. That ambiguity is resolved toward `unobserved`, never
   * toward `observed`, so an unrecorded merge costs a spurious flag rather than
   * a false clear. This is the inverse of the `requestsReadable` trap in
   * `pull_request_review_state`, where an unreadable probe rendered as an empty
   * section and read to a human as "nothing is waiting".
   */
  ref: {
    /** `owner/repo`, exactly as GitHub spells it. */
    repoFullName: string;
    prNumber: number;
  };
  /** Free-text for a human reading the sweep output. Never parsed. */
  note?: string | null;
}

export interface InteractionExpectedOutcomeIssueStatus {
  kind: "issue_status";
  /**
   * Observed against `issues.status` in the interaction's own company.
   *
   * `issueId` is validated to resolve at creation time, so a typo is refused at
   * the ask rather than sitting in `unobserved` forever pretending to be a
   * finding.
   */
  ref: {
    /** Issue UUID. */
    issueId: string;
    /** The status that means the authorised action happened. */
    status: IssueStatus;
  };
  /** Free-text for a human reading the sweep output. Never parsed. */
  note?: string | null;
}

export type InteractionExpectedOutcome =
  | InteractionExpectedOutcomeGithubPrMerged
  | InteractionExpectedOutcomeIssueStatus;

export type InteractionExpectedOutcomeKind = InteractionExpectedOutcome["kind"];

/**
 * A person's record that an accepted card's authorised action will NOT be
 * observed, and that this is fine (PEN-4409).
 *
 * ## Why this exists at all
 *
 * `unobserved` had no exit. An acceptance is terminal — `withdrawInteraction`
 * refuses any interaction that is not `pending` — so the runbook's original
 * remedy, "withdraw the interaction if it has gone moot", named an operation
 * the API refuses. And because the alert thresholds the OLDEST age in the
 * bucket, a single card whose action legitimately never happens (its PR closed
 * unmerged, or superseded by a different PR) pinned the warning on forever and
 * masked every newer unobserved card behind it. An alert with no clearing path
 * is not a strict alert, it is an alert that gets ignored.
 *
 * ## Why it is a separate record and not a status change
 *
 * The acceptance itself stays `accepted` with its original `resolvedAt`,
 * `resolvedByUserId` and reason untouched. The decision genuinely was made and
 * rewriting that row to `cancelled` would falsify the audit trail this whole
 * feature exists to create. This is an annotation recording that nobody is
 * waiting any more — not a retraction of the decision.
 *
 * ## Why `reason` is required
 *
 * An acknowledgement with no reason is indistinguishable from a silenced alarm,
 * and the failure this feature was built against is precisely a decision that
 * went unrecorded. The reason is never parsed; it is there so the next reader
 * can tell "the PR was closed in favour of #2601" from "someone wanted the
 * alert to stop".
 */
export interface InteractionOutcomeAcknowledgement {
  /** ISO-8601. When the acknowledgement was recorded, not when the card was accepted. */
  acknowledgedAt: string;
  acknowledgedByUserId?: string | null;
  acknowledgedByAgentId?: string | null;
  /** Free text. Required, never parsed — see the note above on why. */
  reason: string;
}

export interface RequestConfirmationIssueDocumentTarget {
  type: "issue_document";
  issueId?: string | null;
  documentId?: string | null;
  key: string;
  revisionId: string;
  revisionNumber?: number | null;
  label?: string | null;
  href?: string | null;
}

export interface RequestConfirmationCustomTarget {
  type: "custom";
  key: string;
  revisionId?: string | null;
  revisionNumber?: number | null;
  label?: string | null;
  href?: string | null;
}

export type RequestConfirmationTarget =
  | RequestConfirmationIssueDocumentTarget
  | RequestConfirmationCustomTarget;

/**
 * Enrichment block carried on a `request_confirmation` interaction when it gates
 * a write/destructive MCP tool call (PAP-13726 §D1). Its presence flips the feed
 * card into the dedicated tool-approval rendering (PAP-13745). Arguments are
 * redacted server-side before this reaches the client.
 */
export interface RequestConfirmationToolActionPayload {
  version: 1;
  actionRequestId: string;
  invocationId: string;
  toolName: string;
  toolDisplayName: string;
  connectionId: string | null;
  applicationId: string | null;
  appDisplayName: string | null;
  risk: "write" | "destructive";
  previewMarkdown: string;
  argumentsSummaryJson: string;
  argumentsHash: string;
  expiresAt: string;
}

/**
 * Lifecycle status written back onto the resolved interaction once the operator
 * approves. `approve = run`, so the terminal states are executed/failed/expired —
 * never a bare "accepted".
 */
export interface RequestConfirmationToolActionResult {
  version: 1;
  status: "approved" | "executing" | "executed" | "failed" | "expired";
  errorCode?: string | null;
  errorMessage?: string | null;
  resultSummary?: string | null;
  resultHref?: string | null;
  updatedAt: string;
}

export interface RequestConfirmationPayload {
  version: 1;
  prompt: string;
  acceptLabel?: string | null;
  rejectLabel?: string | null;
  rejectRequiresReason?: boolean;
  rejectReasonLabel?: string | null;
  allowDeclineReason?: boolean;
  declineReasonPlaceholder?: string | null;
  detailsMarkdown?: string | null;
  supersedeOnUserComment?: boolean;
  target?: RequestConfirmationTarget | null;
  toolAction?: RequestConfirmationToolActionPayload;
  /**
   * What accepting this ask AUTHORISES, so a sweep can tell an acceptance whose
   * action happened from one whose action never did (PEN-4409). Optional, and
   * NEVER inferred from `prompt` / `detailsMarkdown` — see
   * {@link InteractionExpectedOutcome}.
   */
  expectedOutcome?: InteractionExpectedOutcome | null;
}

export interface RequestCheckboxConfirmationOption {
  id: string;
  label: string;
  description?: string | null;
}

export interface RequestCheckboxConfirmationPayload {
  version: 1;
  prompt: string;
  detailsMarkdown?: string | null;
  options: RequestCheckboxConfirmationOption[];
  defaultSelectedOptionIds?: string[];
  minSelected?: number;
  maxSelected?: number | null;
  acceptLabel?: string | null;
  rejectLabel?: string | null;
  rejectRequiresReason?: boolean;
  rejectReasonLabel?: string | null;
  allowDeclineReason?: boolean;
  declineReasonPlaceholder?: string | null;
  supersedeOnUserComment?: boolean;
  target?: RequestConfirmationTarget | null;
  /**
   * What accepting this ask AUTHORISES, so a sweep can tell an acceptance whose
   * action happened from one whose action never did (PEN-4409). Optional, and
   * NEVER inferred from `prompt` / `detailsMarkdown` — see
   * {@link InteractionExpectedOutcome}.
   */
  expectedOutcome?: InteractionExpectedOutcome | null;
}

export type RequestItemVerdictValue = "approve" | "reject" | "defer";

export interface RequestItemVerdictsItem {
  id: string;
  label: string;
  description?: string | null;
  previewMarkdown?: string | null;
  href?: string | null;
  attachmentId?: string | null;
}

export interface RequestItemVerdictsPayload {
  version: 1;
  prompt: string;
  detailsMarkdown?: string | null;
  items: RequestItemVerdictsItem[];
  verdicts?: RequestItemVerdictValue[];
  requireReasonOn?: RequestItemVerdictValue[];
  reasonLabel?: string | null;
  allowBulkApprove?: boolean;
  supersedeOnUserComment?: boolean;
  target?: RequestConfirmationTarget | null;
}

export interface RequestConfirmationResult {
  version: 1;
  outcome: "accepted" | "rejected" | "superseded_by_comment" | "stale_target" | "cancelled";
  reason?: string | null;
  commentId?: string | null;
  staleTarget?: RequestConfirmationTarget | null;
  resumeFailure?: {
    status: "retrying" | "needs_attention";
    errorCode: string | null;
    attempt: number;
    maxAttempts: number;
    runId?: string | null;
    retryRunId?: string | null;
    recoveryActionId?: string | null;
    updatedAt?: string | null;
  } | null;
  toolAction?: RequestConfirmationToolActionResult;
  /**
   * Set only by `acknowledgeInteractionOutcome` (PEN-4409), long after the card
   * resolved. Records that a person has accepted that the authorised action
   * will not be observed, which is the ONLY way a card leaves the `unobserved`
   * bucket without the action actually happening. Never written by the sweep.
   */
  outcomeAcknowledgement?: InteractionOutcomeAcknowledgement | null;
}

export interface RequestCheckboxConfirmationResult extends RequestConfirmationResult {
  selectedOptionIds?: string[];
}

export interface RequestItemVerdictsResultItem {
  id: string;
  verdict: RequestItemVerdictValue;
  reason?: string | null;
  resolvedByUserId: string;
  resolvedAt: Date | string;
  commentId?: string | null;
}

export interface RequestItemVerdictsResult {
  version: 1;
  outcome: "resolved" | "superseded_by_comment" | "stale_target" | "cancelled";
  complete: boolean;
  items: RequestItemVerdictsResultItem[];
  commentId?: string | null;
  staleTarget?: RequestConfirmationTarget | null;
}

export interface IssueThreadInteractionBase extends IssueThreadInteractionActorFields {
  id: string;
  companyId: string;
  issueId: string;
  kind: IssueThreadInteractionKind;
  idempotencyKey?: string | null;
  sourceCommentId?: string | null;
  sourceRunId?: string | null;
  title?: string | null;
  summary?: string | null;
  status: IssueThreadInteractionStatus;
  continuationPolicy: IssueThreadInteractionContinuationPolicy;
  createdAt: Date | string;
  updatedAt: Date | string;
  resolvedAt?: Date | string | null;
}

export interface SuggestTasksInteraction extends IssueThreadInteractionBase {
  kind: "suggest_tasks";
  payload: SuggestTasksPayload;
  result?: SuggestTasksResult | null;
}

export interface AskUserQuestionsInteraction extends IssueThreadInteractionBase {
  kind: "ask_user_questions";
  payload: AskUserQuestionsPayload;
  result?: AskUserQuestionsResult | null;
}

export interface RequestConfirmationInteraction extends IssueThreadInteractionBase {
  kind: "request_confirmation";
  payload: RequestConfirmationPayload;
  result?: RequestConfirmationResult | null;
}

export interface RequestCheckboxConfirmationInteraction extends IssueThreadInteractionBase {
  kind: "request_checkbox_confirmation";
  payload: RequestCheckboxConfirmationPayload;
  result?: RequestCheckboxConfirmationResult | null;
}

export interface RequestItemVerdictsInteraction extends IssueThreadInteractionBase {
  kind: "request_item_verdicts";
  payload: RequestItemVerdictsPayload;
  result?: RequestItemVerdictsResult | null;
}

export type IssueThreadInteraction =
  | SuggestTasksInteraction
  | AskUserQuestionsInteraction
  | RequestConfirmationInteraction
  | RequestCheckboxConfirmationInteraction
  | RequestItemVerdictsInteraction;

export type IssueThreadInteractionPayload =
  | SuggestTasksPayload
  | AskUserQuestionsPayload
  | RequestConfirmationPayload
  | RequestCheckboxConfirmationPayload
  | RequestItemVerdictsPayload;

export type IssueThreadInteractionResult =
  | SuggestTasksResult
  | AskUserQuestionsResult
  | RequestConfirmationResult
  | RequestCheckboxConfirmationResult
  | RequestItemVerdictsResult;

export interface IssueAttachment {
  id: string;
  companyId: string;
  issueId: string;
  issueCommentId: string | null;
  assetId: string;
  provider: string;
  objectKey: string;
  contentType: string;
  byteSize: number;
  sha256: string;
  originalFilename: string | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
  contentPath: string;
  openPath?: string;
  downloadPath?: string;
}
