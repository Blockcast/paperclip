import type {
  AgentRole,
  AgentStatus,
  HeartbeatInvocationSource,
  HeartbeatRunStatus,
  RunLivenessState,
  WakeupTriggerDetail,
  WakeupRequestStatus,
} from "../constants.js";

export type GitWorktreeBranchAncestryVerdict = "ancestor" | "diverged" | "unknown";

export type GitWorktreeInProgressOperation = "rebase" | "merge" | "cherry_pick" | "revert" | "bisect";

export interface GitWorktreeBranchIncoherenceEvidence {
  reason: "git_worktree_branch_incoherence";
  fingerprint: string;
  sourceIssueId: string | null;
  sourceIdentifier: string | null;
  executionWorkspaceId: string | null;
  worktreePath: string;
  repoRoot: string;
  expectedBranch: string;
  actualBranch: string | null;
  cleanliness: "clean" | "dirty" | "unknown";
  /**
   * Interrupted git operation (rebase/merge/cherry-pick/revert/bisect) whose
   * state directory is still present in the worktree. Optional so previously
   * persisted evidence payloads stay valid.
   */
  inProgressOperation?: GitWorktreeInProgressOperation | null;
  statusEntryCount: number | null;
  dirtyPathSample: string[];
  contention: {
    claimedByWorkspaceId: string;
    claimedByIssueId: string | null;
    claimedByIssueIdentifier: string | null;
    activeRun: {
      id: string;
      status: "queued" | "running";
      issueId: string | null;
      issueIdentifier: string | null;
    } | null;
  } | null;
  provenance: {
    expectedBranchRef: string;
    actualBranchRef: string | null;
    registeredBranchRef: string | null;
    registeredPathFound: boolean;
    registeredBranchMatchesHead: boolean;
    expectedBranchExists: boolean;
    actualBranchExists: boolean | null;
    expectedHeadSha: string | null;
    actualHeadSha: string | null;
    sameHead: boolean;
    ancestryVerdict: GitWorktreeBranchAncestryVerdict;
    plainLanguageReason: string;
  };
  safeRepair: {
    eligible: boolean;
    attempted: boolean;
    succeeded: boolean;
    reason: string;
  };
}

export interface HeartbeatRun {
  id: string;
  companyId: string;
  agentId: string;
  invocationSource: HeartbeatInvocationSource;
  triggerDetail: WakeupTriggerDetail | null;
  status: HeartbeatRunStatus;
  responsibleUserId: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  error: string | null;
  wakeupRequestId: string | null;
  exitCode: number | null;
  signal: string | null;
  usageJson: Record<string, unknown> | null;
  resultJson: Record<string, unknown> | null;
  sessionIdBefore: string | null;
  sessionIdAfter: string | null;
  logStore: string | null;
  logRef: string | null;
  logBytes: number | null;
  logSha256: string | null;
  logCompressed: boolean;
  stdoutExcerpt: string | null;
  stderrExcerpt: string | null;
  errorCode: string | null;
  externalRunId: string | null;
  processPid: number | null;
  processGroupId?: number | null;
  processStartedAt: Date | null;
  lastOutputAt: Date | null;
  lastOutputSeq: number;
  lastOutputStream: "stdout" | "stderr" | null;
  lastOutputBytes: number | null;
  retryOfRunId: string | null;
  processLossRetryCount: number;
  /**
   * INBOUND, not outbound. `scheduledRetryAt` / `scheduledRetryAttempt` /
   * `scheduledRetryReason` describe the park that *produced* this run: when the
   * hold this run was released from was due, which attempt of that chain this
   * run is, and why the chain started. They do **not** record a park created
   * because *this* run failed — a park is a separate row carrying
   * `retryOfRunId`, so nothing about it is written back here.
   *
   * Consequently, on a run whose `status` is `failed`:
   *   - `scheduledRetryAt: null` means "this run was not itself born of a
   *     park", NOT "the system declined to retry it";
   *   - a `scheduledRetryAt` in the past is when *this* attempt was released,
   *     NOT a retry that was promised and never fired.
   *
   * Both readings have been made, in production, on this exact field (BLO-28734
   * and its re-verification). Read `retrySuccessor` for the outbound direction —
   * that is the field that answers "was this failed run retried?". BLO-29312.
   */
  scheduledRetryAt?: Date | null;
  /** Inbound — see the note on {@link HeartbeatRun.scheduledRetryAt}. */
  scheduledRetryAttempt?: number;
  /** Inbound — see the note on {@link HeartbeatRun.scheduledRetryAt}. */
  scheduledRetryReason?: string | null;
  retryExhaustedReason?: string | null;
  /**
   * Outbound retry edge — the park created because this run ended. Decorated
   * onto the single-run read (`GET /api/heartbeat-runs/:runId`) only; absent on
   * list endpoints, which do not resolve it. BLO-29312.
   */
  retrySuccessor?: HeartbeatRunRetrySuccessor;
  livenessState: RunLivenessState | null;
  livenessReason: string | null;
  continuationAttempt: number;
  lastUsefulActionAt: Date | null;
  nextAction: string | null;
  contextSnapshot: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
  outputSilence?: HeartbeatRunOutputSilence;
  /**
   * Ephemeral, process-local current status message for an active run. Resolved
   * from the in-memory runtime status store (never persisted to the database)
   * and only populated for active/live run reads. Disappears on TTL expiry,
   * terminal run status, or server restart.
   */
  currentStatusMessage?: string | null;
  currentStatusUpdatedAt?: Date | string | null;
  currentToolName?: string | null;
  lastAssistantSnippet?: string | null;
  lastEventAt?: Date | string | null;
}

/**
 * Typed phase labels emitted by the sandbox-managed runtime as it progresses
 * through workspace preparation, adapter startup, restore/export, and
 * finalization. Used by the ephemeral runtime status plumbing; not persisted.
 */
export type HeartbeatRunStatusPhase =
  | "git_sync"
  | "config_sync"
  | "adapter_startup"
  | "restore"
  | "export"
  | "finalize"
  | "run_activity";

export type HeartbeatRunOutputSilenceLevel =
  | "not_applicable"
  | "ok"
  | "suspicious"
  | "critical"
  | "snoozed";

export interface HeartbeatRunOutputSilence {
  lastOutputAt: Date | string | null;
  lastOutputSeq: number;
  lastOutputStream: "stdout" | "stderr" | null;
  silenceStartedAt: Date | string | null;
  silenceAgeMs: number | null;
  level: HeartbeatRunOutputSilenceLevel;
  suspicionThresholdMs: number;
  criticalThresholdMs: number;
  snoozedUntil: Date | string | null;
  evaluationIssueId: string | null;
  evaluationIssueIdentifier: string | null;
  evaluationIssueAssigneeAgentId: string | null;
}

export type HeartbeatRunRetrySuccessorState = "retried" | "not_retried" | "not_applicable";

/**
 * The OUTBOUND retry edge of a run: the park that was created *because this run
 * ended*, resolved by looking up the row whose `retryOfRunId` is this run's id.
 *
 * Every persisted `scheduledRetry*` column on `heartbeat_runs` points the other
 * way — see the note on {@link HeartbeatRun.scheduledRetryAt}. Before this
 * existed, "was this failed run retried?" could only be answered by scanning
 * the whole run table for a matching `retryOfRunId`, so readers instead guessed
 * from `scheduledRetryAt` and guessed wrong. `state` is therefore deliberately
 * an assertion rather than a nullable object: "not retried" is a fact this
 * endpoint states, not an absence a caller has to interpret. BLO-29312.
 */
export interface HeartbeatRunRetrySuccessor {
  /**
   * - `retried` — a successor exists; the fields below describe it.
   * - `not_retried` — this run reached a terminal status and no successor was
   *   ever created for it.
   * - `not_applicable` — this run has not reached a terminal status, so there
   *   is nothing yet for it to have been retried from.
   */
  state: HeartbeatRunRetrySuccessorState;
  runId: string | null;
  status: HeartbeatRunStatus | null;
  /**
   * The successor's own due time — i.e. when this run's retry is scheduled to
   * fire, or fired. Null once the successor has been promoted out of the park
   * without one, which is normal for immediate re-queues (`process_lost`).
   */
  scheduledRetryAt: Date | string | null;
  scheduledRetryAttempt: number | null;
  scheduledRetryReason: string | null;
  createdAt: Date | string | null;
}

export interface AgentWakeupSkipped {
  status: "skipped";
  reason: string;
  message: string | null;
  issueId: string | null;
  executionRunId: string | null;
  executionAgentId: string | null;
  executionAgentName: string | null;
}

export type AgentWakeupResponse = HeartbeatRun | AgentWakeupSkipped;

export interface HeartbeatRunEvent {
  id: number;
  companyId: string;
  runId: string;
  agentId: string;
  seq: number;
  eventType: string;
  stream: "system" | "stdout" | "stderr" | null;
  level: "info" | "warn" | "error" | null;
  color: string | null;
  message: string | null;
  payload: Record<string, unknown> | null;
  createdAt: Date;
}

export interface AgentRuntimeState {
  agentId: string;
  companyId: string;
  adapterType: string;
  sessionId: string | null;
  sessionDisplayId?: string | null;
  sessionParamsJson?: Record<string, unknown> | null;
  stateJson: Record<string, unknown>;
  lastRunId: string | null;
  lastRunStatus: string | null;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCachedInputTokens: number;
  totalCostCents: number;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AgentTaskSession {
  id: string;
  companyId: string;
  agentId: string;
  adapterType: string;
  taskKey: string;
  sessionParamsJson: Record<string, unknown> | null;
  sessionDisplayId: string | null;
  lastRunId: string | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AgentWakeupRequest {
  id: string;
  companyId: string;
  agentId: string;
  source: HeartbeatInvocationSource;
  triggerDetail: WakeupTriggerDetail | null;
  reason: string | null;
  payload: Record<string, unknown> | null;
  status: WakeupRequestStatus;
  coalescedCount: number;
  requestedByActorType: "user" | "agent" | "system" | null;
  requestedByActorId: string | null;
  idempotencyKey: string | null;
  runId: string | null;
  requestedAt: Date;
  claimedAt: Date | null;
  finishedAt: Date | null;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface InstanceSchedulerHeartbeatAgent {
  id: string;
  companyId: string;
  companyName: string;
  companyIssuePrefix: string;
  agentName: string;
  agentUrlKey: string;
  role: AgentRole;
  title: string | null;
  status: AgentStatus;
  adapterType: string;
  intervalSec: number;
  heartbeatEnabled: boolean;
  schedulerActive: boolean;
  lastHeartbeatAt: Date | null;
}
