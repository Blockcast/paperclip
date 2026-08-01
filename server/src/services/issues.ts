import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { and, asc, desc, eq, exists, gt, gte, inArray, isNotNull, isNull, like, lt, lte, ne, notInArray, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  authUsers,
  approvals,
  assets,
  companies,
  companyMemberships,
  costEvents,
  documentRevisions,
  documents,
  financeEvents,
  goals,
  heartbeatRuns,
  routineRuns,
  executionWorkspaces,
  issueApprovals,
  issueAttachments,
  issueCreateIdempotencyKeys,
  issueInboxArchives,
  issueLabels,
  issueWatchdogs,
  issuePlanDecompositions,
  issueRecoveryActions,
  issueRelations,
  issueComments,
  issueDocuments,
  issueReadStates,
  issueThreadInteractions,
  issueWorkProducts,
  issues,
  labels,
  linearIssueLinks,
  milestones,
  projectWorkspaces,
  projects,
  workspaceOperations,
} from "@paperclipai/db";
import type {
  AcceptedPlanDecomposition,
  IssueComment,
  IssueCommentAuthorType,
  IssueCommentDerivedAuthorSource,
  IssueCommentMetadata,
  IssueCommentPresentation,
  IssueBlockerAttention,
  IssueBlockedInboxAttention,
  IssueBlockedInboxIssueRef,
  IssueProductivityReview,
  IssueProductivityReviewTrigger,
  IssueRelationIssueSummary,
  IssueWatchdogSummary,
  LowTrustBoundary,
  SuccessfulRunHandoffState,
} from "@paperclipai/shared";
import {
  clampIssueRequestDepth,
  extractAgentMentionIds,
  extractProjectMentionIds,
  issueCommentAuthorTypeSchema,
  issueCommentMetadataSchema,
  issueCommentPresentationSchema,
  isUuidLike,
  normalizeIssueIdentifier as normalizeIssueReferenceIdentifier,
  SYSTEM_ISSUE_DOCUMENT_KEYS,
} from "@paperclipai/shared";
import { conflict, HttpError, notFound, unprocessable } from "../errors.js";
import { incrementBlockerResolvedWakeMetric } from "./blocker-resolved-wake-metrics.js";
import { logger } from "../middleware/logger.js";
import { parseObject } from "../adapters/utils.js";
import {
  hydrateSuccessfulRunHandoffLiveness,
  SUCCESSFUL_RUN_HANDOFF_LIVE_WAKE_STATUSES,
} from "./successful-run-handoff-state.js";
import {
  defaultIssueExecutionWorkspaceSettingsForProject,
  gateProjectExecutionWorkspacePolicy,
  issueExecutionWorkspaceModeForPersistedWorkspace,
  isUnrunnableWorktreeCombo,
  parseIssueExecutionWorkspaceSettings,
  parseProjectExecutionWorkspacePolicy,
  resolvePinnedIssueWorkspaceStrategyType,
  WORKSPACE_WORKTREE_REQUIRES_PROJECT_CODE,
  WORKSPACE_WORKTREE_REQUIRES_PROJECT_MESSAGE,
  WORKSPACE_WORKTREE_REQUIRES_PROJECT_REMEDIATION,
  type ParsedExecutionWorkspaceMode,
} from "./execution-workspace-policy.js";
import { mergeExecutionWorkspaceConfig } from "./execution-workspaces.js";
import { buildInitialIssueMonitorFields, normalizeIssueExecutionPolicy } from "./issue-execution-policy.js";
import { instanceSettingsService } from "./instance-settings.js";
import { redactCurrentUserText } from "../log-redaction.js";
import { redactSensitiveText } from "../redaction.js";
import { resolveIssueGoalId, resolveNextIssueGoalId } from "./issue-goal-fallback.js";
import { getRunLogStore } from "./run-log-store.js";
import { getTelemetryClient } from "../telemetry.js";
import { getDefaultCompanyGoal } from "./goals.js";
import { assertAssignableAgent } from "./agent-assignability.js";
import { allocateIdentifier, deleteLinearIssueForCompany } from "./identifier-allocator.js";
import {
  summarizeIssueWatchdog,
  upsertIssueWatchdogForIssue,
} from "./task-watchdogs.js";
import {
  isVerifiedIssueTreeControlInteractionWake,
  issueTreeControlService,
  type ActiveIssueTreePauseHoldGate,
} from "./issue-tree-control.js";
import { runEvidenceGate, type EvidenceFetchResult } from "./evidence-gate-wiring.js";
import { countDoneWhenBullets } from "./evidence-gate.js";
import { shouldBlockNarratedDone } from "./done-gate.js";
import {
  parseIssueGraphLivenessIncidentKey,
  RECOVERY_ORIGIN_KINDS,
} from "./recovery/origins.js";
import { classifyIssueGraphLiveness, type IssueLivenessFinding } from "./recovery/issue-graph-liveness.js";
import { ACTIVE_RECOVERY_ACTION_STATUSES } from "./issue-recovery-actions.js";
import { visibleIssueCondition } from "./issue-visibility.js";
import { finalizeSummarySlotsForTerminalIssue } from "./summary-slot-finalization.js";

const ALL_ISSUE_STATUSES = ["backlog", "todo", "in_progress", "in_review", "blocked", "done", "cancelled"];
const OPEN_ROUTINE_EXECUTION_ISSUE_STATUSES = ["backlog", "todo", "in_progress", "in_review", "blocked"] as const;
const ISSUE_PARENT_ANCESTRY_VALIDATION_MAX_DEPTH = 256;
const MAX_ISSUE_COMMENT_PAGE_LIMIT = 500;
export const ISSUE_LIST_DEFAULT_LIMIT = 500;
export const ISSUE_LIST_MAX_LIMIT = 1000;
const BLOCKED_PROMOTION_AWAITING_USER_EVENT = "sweep_blocked_promotion_skipped_awaiting_user";
const BLOCKED_PROMOTION_AWAITING_USER_COUNTER = "sweep.blocked_promotion_skipped_awaiting_user";
export const ISSUE_BLOCKER_DIAGNOSTICS_MAX_BLOCKERS = 100;
export const ISSUE_WAKE_DIAGNOSTICS_MAX_WAKE_REQUESTS = 50;
export const ISSUE_WAKE_DIAGNOSTICS_MAX_ACTIVITY_RECORDS = 50;
export const ISSUE_WAKE_DIAGNOSTICS_LOOKBACK_DAYS = 14;
export const ISSUE_SUBTREE_DIAGNOSTICS_MAX_DEPTH = 8;
export const ISSUE_SUBTREE_DIAGNOSTICS_MAX_NODES = 100;
export const ISSUE_SUBTREE_DIAGNOSTICS_MAX_BLOCKERS_PER_NODE = 20;
export const ISSUE_SUBTREE_DIAGNOSTICS_MAX_WAKE_REQUESTS_PER_NODE = 5;
export const ISSUE_SUBTREE_DIAGNOSTICS_MAX_ACTIVITY_RECORDS_PER_NODE = 5;
const ISSUE_LIST_RELATED_QUERY_CHUNK_SIZE = 500;
export const MAX_CHILD_ISSUES_CREATED_BY_HELPER = 25;
const MAX_CHILD_COMPLETION_SUMMARIES = 20;
const CHILD_COMPLETION_SUMMARY_BODY_MAX_CHARS = 500;
// Non-human author sentinels that agents post under. These ARE eligible for
// agent-attribution derivation even though `local-board` is also materialized
// as a row in the `user` table (it is the implicit board admin). Genuine human
// users — real signups with their own ids — are never reattributed.
const NON_HUMAN_SENTINEL_AUTHOR_USER_IDS = new Set<string>(["local-board"]);
const ISSUE_COMMENT_RUN_LOG_DERIVATION_MAX_LOG_BYTES = 2_000_000;
const ISSUE_COMMENT_RUN_LOG_DERIVATION_CHUNK_BYTES = 256_000;
const ISSUE_COMMENT_RUN_LOG_DERIVATION_END_SLACK_MS = 60_000;
const EVIDENCE_DESCRIPTION_HISTORY_LIMIT = 100;
const ISSUE_COMMENT_RUN_LOG_DERIVATION_MAX_PARALLEL_READS = 8;
function awaitingUserInputReason(body: string): string | null {
  const normalized = body.toLowerCase();
  const hasExplicitPhrase = [
    /\bpick (?:a|an)\b/,
    /\bconfirm\b/,
    /\blet me know\b/,
    /\bblocked on clarification\b/,
    /\bblocked awaiting\b/,
    /\bawaiting user\b/,
    /\bawaiting your\b/,
  ].some((phrase) => phrase.test(normalized));
  if (hasExplicitPhrase) return "explicit_phrase";

  const hasQuestion = body.includes("?");
  const hasUserMention = /(^|\s)@[^\s]+|user:\/\//.test(body);
  if (hasQuestion && hasUserMention) return "question_with_user_mention";

  return null;
}

async function findBlockedPromotionsAwaitingUserInput(
  dbOrTx: any,
  companyId: string,
  issueIds: string[],
) {
  if (issueIds.length === 0) return new Map<string, {
    commentId: string;
    commentCreatedAt: Date;
    reason: string;
  }>();

  const latestAgentComments = await dbOrTx
    .selectDistinctOn([issueComments.issueId], {
      id: issueComments.id,
      issueId: issueComments.issueId,
      body: issueComments.body,
      createdAt: issueComments.createdAt,
    })
    .from(issueComments)
    .where(
      and(
        eq(issueComments.companyId, companyId),
        inArray(issueComments.issueId, issueIds),
        or(
          sql<boolean>`${issueComments.authorAgentId} IS NOT NULL`,
          sql<boolean>`${issueComments.createdByRunId} IS NOT NULL`,
          eq(issueComments.authorType, "agent"),
        )!,
      ),
    )
    .orderBy(issueComments.issueId, desc(issueComments.createdAt), desc(issueComments.id)) as Array<{
      id: string;
      issueId: string;
      body: string;
      createdAt: Date;
    }>;

  const awaitingComments = latestAgentComments.flatMap((comment) => {
    const reason = awaitingUserInputReason(comment.body);
    return reason ? [{ ...comment, reason }] : [];
  });
  if (awaitingComments.length === 0) return new Map();

  const latestUserReplies = await dbOrTx
    .selectDistinctOn([issueComments.issueId], {
      issueId: issueComments.issueId,
      createdAt: issueComments.createdAt,
    })
    .from(issueComments)
    .where(
      and(
        eq(issueComments.companyId, companyId),
        inArray(issueComments.issueId, awaitingComments.map((comment) => comment.issueId)),
        sql<boolean>`${issueComments.authorUserId} IS NOT NULL`,
      ),
    )
    .orderBy(issueComments.issueId, desc(issueComments.createdAt), desc(issueComments.id)) as Array<{
      issueId: string;
      createdAt: Date;
    }>;
  const latestUserReplyByIssueId = new Map(
    latestUserReplies.map((comment) => [comment.issueId, comment.createdAt] as const),
  );

  return new Map(awaitingComments.flatMap((comment) => {
    const latestUserReply = latestUserReplyByIssueId.get(comment.issueId);
    if (latestUserReply && latestUserReply > comment.createdAt) return [];
    return [[comment.issueId, {
      commentId: comment.id,
      commentCreatedAt: comment.createdAt,
      reason: comment.reason,
    }] as const];
  }));
}

function recordBlockedPromotionAwaitingUserSkip(input: {
  issueId: string;
  commentId: string;
  commentCreatedAt: Date;
  reason: string;
  triggerPath: "blocker_done" | "resolved_blocker_sweep";
}) {
  const details = {
    event: BLOCKED_PROMOTION_AWAITING_USER_EVENT,
    counter: BLOCKED_PROMOTION_AWAITING_USER_COUNTER,
    ...input,
    commentCreatedAt: input.commentCreatedAt.toISOString(),
  };
  logger.info(details, "automatic blocked issue wake skipped because latest agent comment awaits user input");
  getTelemetryClient()?.track(BLOCKED_PROMOTION_AWAITING_USER_COUNTER, {
    reason: input.reason,
    triggerPath: input.triggerPath,
  });
}

export const ISSUE_CREATE_IDEMPOTENCY_KEY_RETENTION_DAYS = 7;
const ISSUE_CREATE_IDEMPOTENCY_KEY_RETENTION_MS = ISSUE_CREATE_IDEMPOTENCY_KEY_RETENTION_DAYS * 24 * 60 * 60 * 1000;
const ISSUE_CREATE_IDEMPOTENCY_KEY_CLEANUP_BATCH_SIZE = 500;
const DELETED_ISSUE_COMMENT_BODY = "";
const ISSUE_WAKE_DIAGNOSTICS_ACTIVITY_ACTIONS = ["issue.tree_hold_wakeup_deferred"] as const;

function wakeRequestTargetsIssue(issueId: string) {
  return sql`(
    ${agentWakeupRequests.payload} ->> 'issueId' = ${issueId}
    or ${agentWakeupRequests.payload} ->> 'taskId' = ${issueId}
    or ${agentWakeupRequests.payload} -> '_paperclipWakeContext' ->> 'issueId' = ${issueId}
    or ${agentWakeupRequests.payload} -> '_paperclipWakeContext' ->> 'taskId' = ${issueId}
  )`;
}

function wakeDiagnosticActivityTargetsIssue(issueId: string) {
  return sql`(
    (${activityLog.entityType} = 'issue' and ${activityLog.entityId} = ${issueId})
    or ${activityLog.details} ->> 'issueId' = ${issueId}
    or ${activityLog.details} ->> 'rootIssueId' = ${issueId}
  )`;
}

function assertTransition(from: string, to: string) {
  if (from === to) return;
  if (!ALL_ISSUE_STATUSES.includes(to)) {
    throw conflict(`Unknown issue status: ${to}`);
  }
}

function applyStatusSideEffects(
  status: string | undefined,
  patch: Partial<typeof issues.$inferInsert>,
): Partial<typeof issues.$inferInsert> {
  if (!status) return patch;

  if (status === "in_progress" && !patch.startedAt) {
    patch.startedAt = new Date();
  }
  if (status === "done") {
    patch.completedAt = new Date();
  }
  if (status === "cancelled") {
    patch.cancelledAt = new Date();
  }
  return patch;
}

function workspaceWorktreeRequiresProjectDetails() {
  return {
    code: WORKSPACE_WORKTREE_REQUIRES_PROJECT_CODE,
    remediation: WORKSPACE_WORKTREE_REQUIRES_PROJECT_REMEDIATION,
  };
}

function assertExplicitPinnedWorktreeIssueRunnable(input: {
  projectId: string | null | undefined;
  projectWorkspaceId: string | null | undefined;
  executionWorkspaceId: string | null | undefined;
  executionWorkspacePreference: string | null | undefined;
  executionWorkspaceSettings: unknown;
}) {
  const settings = parseIssueExecutionWorkspaceSettings(input.executionWorkspaceSettings);
  const mode = settings?.mode;
  if (mode !== "isolated_workspace" && mode !== "operator_branch") return;

  const resolvedMode = mode as ParsedExecutionWorkspaceMode;
  if (
    isUnrunnableWorktreeCombo({
      issue: {
        projectId: input.projectId ?? null,
        projectWorkspaceId: input.projectWorkspaceId ?? null,
        executionWorkspaceId: input.executionWorkspaceId ?? null,
        executionWorkspacePreference: input.executionWorkspacePreference ?? null,
      },
      resolvedMode,
      resolvedStrategy: resolvePinnedIssueWorkspaceStrategyType({
        mode: resolvedMode,
        issueSettings: settings,
      }),
      hasResolvablePriorSessionWorkspace: false,
    })
  ) {
    throw unprocessable(
      WORKSPACE_WORKTREE_REQUIRES_PROJECT_MESSAGE,
      workspaceWorktreeRequiresProjectDetails(),
    );
  }
}

// Two deliberately different questions about the same three fields. Collapsing
// them into one `!= null` predicate regressed recovery escalation once already
// (PR #811), so they stay separate and each call site picks explicitly.
//
// Did the caller *mention* any workspace field? An explicit `null` counts.
// Passing all three as null is how a caller opts OUT of inheriting a parent's
// execution workspace — recovery/service.ts does exactly that for a liveness
// escalation it parents to the recovery issue, to stop the escalation adopting
// the blocker's checkout. The inheritance-suppression sites must therefore read
// null as a real override, or that opt-out silently stops working.
function hasExplicitExecutionWorkspaceOverride(input: {
  executionWorkspaceId?: string | null;
  executionWorkspacePreference?: string | null;
  executionWorkspaceSettings?: unknown;
}) {
  return (
    input.executionWorkspaceId !== undefined ||
    input.executionWorkspacePreference !== undefined ||
    input.executionWorkspaceSettings !== undefined
  );
}

// Did the caller supply an actual workspace *value*? Explicit nulls do not
// count. Sole-led-project inference keys off this one, because the board/UI
// intake path serializes explicit nulls and must still get inference — that
// intake case is the whole point of BLO-18760.
function hasExecutionWorkspaceIntent(input: {
  executionWorkspaceId?: string | null;
  executionWorkspacePreference?: string | null;
  executionWorkspaceSettings?: unknown;
}) {
  return (
    input.executionWorkspaceId != null ||
    input.executionWorkspacePreference != null ||
    input.executionWorkspaceSettings != null
  );
}

function readStringFromRecord(record: unknown, key: string) {
  if (!record || typeof record !== "object") return null;
  const value = (record as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

async function findOpenRoutineExecutionLockOwnerForIssue(db: Db, companyId: string, issueId: string) {
  const target = await db
    .select({
      id: issues.id,
      originKind: issues.originKind,
      originId: issues.originId,
      originFingerprint: issues.originFingerprint,
    })
    .from(issues)
    .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)))
    .limit(1)
    .then((rows) => rows[0] ?? null);

  if (!target || target.originKind !== "routine_execution" || !target.originId) return null;

  return db
    .select({
      id: issues.id,
      identifier: issues.identifier,
      executionRunId: issues.executionRunId,
    })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, companyId),
        eq(issues.originKind, "routine_execution"),
        eq(issues.originId, target.originId),
        eq(issues.originFingerprint, target.originFingerprint),
        inArray(issues.status, OPEN_ROUTINE_EXECUTION_ISSUE_STATUSES),
        isNull(issues.hiddenAt),
        isNotNull(issues.executionRunId),
        ne(issues.id, issueId),
      ),
    )
    .orderBy(desc(issues.updatedAt), desc(issues.createdAt))
    .limit(1)
    .then((rows) => rows[0] ?? null);
}

async function resolveResponsibleUserIdForIssueCreate(
  reader: DbReader,
  companyId: string,
  input: {
    explicitResponsibleUserId?: string | null;
    createdByUserId?: string | null;
    parentId?: string | null;
    originKind?: string | null;
    originRunId?: string | null;
    actorRunId?: string | null;
    actorResponsibleUserId?: string | null;
    trustExplicitResponsibleUserId?: boolean;
  },
) {
  const explicitResponsibleUserId = readStringFromRecord(input, "explicitResponsibleUserId");
  if (explicitResponsibleUserId && input.trustExplicitResponsibleUserId === true) return explicitResponsibleUserId;

  if (input.originKind === "routine_execution" && input.originRunId) {
    const routineRun = await reader
      .select({ responsibleUserId: routineRuns.responsibleUserId })
      .from(routineRuns)
      .where(and(eq(routineRuns.companyId, companyId), eq(routineRuns.id, input.originRunId)))
      .then((rows) => rows[0] ?? null);
    if (routineRun?.responsibleUserId) return routineRun.responsibleUserId;
  }

  const actorResponsibleUserId = readStringFromRecord(input, "actorResponsibleUserId");
  if (actorResponsibleUserId) return actorResponsibleUserId;

  if (input.actorRunId) {
    const actorRun = await reader
      .select({ responsibleUserId: heartbeatRuns.responsibleUserId })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, input.actorRunId)))
      .then((rows) => rows[0] ?? null);
    if (actorRun?.responsibleUserId) return actorRun.responsibleUserId;
  }

  if (input.parentId) {
    const parent = await reader
      .select({
        responsibleUserId: issues.responsibleUserId,
        createdByUserId: issues.createdByUserId,
      })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.id, input.parentId)))
      .then((rows) => rows[0] ?? null);
    if (parent?.responsibleUserId) return parent.responsibleUserId;
    if (parent?.createdByUserId) return parent.createdByUserId;
  }

  return input.createdByUserId ?? null;
}

function buildReusedExecutionWorkspaceConfigPatchFromIssueSettings(
  settings: ReturnType<typeof parseIssueExecutionWorkspaceSettings>,
) {
  return {
    environmentId: settings?.environmentId ?? null,
    provisionCommand: settings?.workspaceStrategy?.provisionCommand ?? null,
    teardownCommand: settings?.workspaceStrategy?.teardownCommand ?? null,
    workspaceRuntime: settings?.workspaceRuntime ?? null,
  };
}

// Accepted-plan children are not realized yet, so carry only unresolved
// workspace intent and let the first child run render/persist its own branch.
function buildPreRealizationExecutionWorkspaceSettings(raw: unknown): Record<string, unknown> | null {
  const settings = parseIssueExecutionWorkspaceSettings(raw, { includeEnvironmentId: true });
  if (!settings) return null;
  const mode =
    settings.mode && settings.mode !== "inherit" && settings.mode !== "reuse_existing"
      ? settings.mode
      : null;
  const next: Record<string, unknown> = {};
  if (mode) next.mode = mode;
  if (settings.environmentId !== undefined) next.environmentId = settings.environmentId;
  if (settings.workspaceRuntime) next.workspaceRuntime = settings.workspaceRuntime;
  if (settings.workspaceStrategy) {
    next.workspaceStrategy = {
      type: settings.workspaceStrategy.type,
      ...(settings.workspaceStrategy.baseRef ? { baseRef: settings.workspaceStrategy.baseRef } : {}),
      ...(settings.workspaceStrategy.branchTemplate ? { branchTemplate: settings.workspaceStrategy.branchTemplate } : {}),
      ...(settings.workspaceStrategy.worktreeParentDir ? { worktreeParentDir: settings.workspaceStrategy.worktreeParentDir } : {}),
      ...(settings.workspaceStrategy.provisionCommand ? { provisionCommand: settings.workspaceStrategy.provisionCommand } : {}),
      ...(settings.workspaceStrategy.teardownCommand ? { teardownCommand: settings.workspaceStrategy.teardownCommand } : {}),
    };
  }
  return Object.keys(next).length > 0 ? next : null;
}

function toTimestampMs(value: Date | string | null | undefined) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  const timestamp = date.getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

type IssueCommentRunLogAttributionCandidate = {
  id: string;
  createdAt: Date | string;
  authorAgentId?: string | null;
  authorUserId?: string | null;
  createdByRunId?: string | null;
};

type IssueCommentRunLogAttributionRun = {
  runId: string;
  agentId: string;
  createdAt: Date | string;
  startedAt?: Date | string | null;
  finishedAt?: Date | string | null;
  // Best-effort run log text. May be empty when logs were not read for a tier
  // that does not need them (run-id / run-window-unique); only the
  // `run_log_comment_post` tier consults this.
  logContent: string;
};

type DerivedIssueCommentAttribution = {
  derivedAuthorAgentId: string;
  derivedCreatedByRunId: string;
  derivedAuthorSource: IssueCommentDerivedAuthorSource;
};

/**
 * Best-effort agent attribution for comments whose stored author is a non-human
 * sentinel (e.g. `local-board`). Callers MUST pre-filter `comments` to drop any
 * comment whose `authorUserId` maps to a genuine user profile so a real board /
 * user comment is never reattributed.
 *
 * Only LOSSLESS signals are used — a comment is reattributed solely when a run
 * provably authored it. Pure run-window timing overlap is intentionally NOT a
 * signal: because agents post through the `local-board` subprocess, an agent
 * comment and a genuine human board comment are indistinguishable rows, so any
 * timing-based guess mis-attributes human board comments that merely coincided
 * with an agent run (Option A).
 *
 * Tiers, in descending confidence (first match wins per comment):
 *  1. `run_id` — the comment's own `createdByRunId` resolves to an agent run
 *     (lossless: that run authored the comment).
 *  2. `run_log_comment_post` — an overlapping run log contains the explicit
 *     `comment id: {id}` post marker (lossless: the run recorded posting it).
 */
export function deriveIssueCommentRunLogAttribution(
  comments: readonly IssueCommentRunLogAttributionCandidate[],
  runs: readonly IssueCommentRunLogAttributionRun[],
) {
  const derivedByCommentId = new Map<string, DerivedIssueCommentAttribution>();
  const runById = new Map(runs.map((run) => [run.runId, run] as const));

  for (const comment of comments) {
    if (comment.authorAgentId || !comment.authorUserId) continue;

    // Tier 1: the comment carries the run that authored it. Lossless even when
    // the author was recorded as the `local-board` sentinel.
    if (comment.createdByRunId) {
      const ownRun = runById.get(comment.createdByRunId);
      if (ownRun?.agentId) {
        derivedByCommentId.set(comment.id, {
          derivedAuthorAgentId: ownRun.agentId,
          derivedCreatedByRunId: ownRun.runId,
          derivedAuthorSource: "run_id",
        });
        continue;
      }
    }

    const commentCreatedAtMs = toTimestampMs(comment.createdAt);
    if (commentCreatedAtMs === null) continue;

    const overlappingRuns: Array<{ run: IssueCommentRunLogAttributionRun; runEndMs: number }> = [];
    for (const run of runs) {
      const runStartMs = toTimestampMs(run.startedAt ?? run.createdAt);
      const runEndMs = toTimestampMs(run.finishedAt ?? run.createdAt);
      if (runStartMs === null || runEndMs === null) continue;
      if (
        commentCreatedAtMs < runStartMs
        || commentCreatedAtMs > runEndMs + ISSUE_COMMENT_RUN_LOG_DERIVATION_END_SLACK_MS
      ) {
        continue;
      }
      overlappingRuns.push({ run, runEndMs });
    }

    // Tier 2: an overlapping run log explicitly recorded posting this comment.
    let bestLogMatch: { runId: string; agentId: string; distanceMs: number } | null = null;
    for (const { run, runEndMs } of overlappingRuns) {
      if (!run.logContent.includes(`comment id: ${comment.id}`)) continue;
      const distanceMs = Math.abs(runEndMs - commentCreatedAtMs);
      if (!bestLogMatch || distanceMs < bestLogMatch.distanceMs) {
        bestLogMatch = { runId: run.runId, agentId: run.agentId, distanceMs };
      }
    }
    if (bestLogMatch) {
      derivedByCommentId.set(comment.id, {
        derivedAuthorAgentId: bestLogMatch.agentId,
        derivedCreatedByRunId: bestLogMatch.runId,
        derivedAuthorSource: "run_log_comment_post",
      });
      continue;
    }

    // No lossless signal — leave unresolved. A pure run-window timing overlap is
    // deliberately NOT enough to reattribute (it cannot tell an agent comment
    // from a human board comment that happened during the run).
  }

  return derivedByCommentId;
}

// Express's default `qs` parser binds repeated query keys to a `string[]`,
// so a request like `?status=todo&status=in_progress` arrives here as an
// array. Single-key + comma-separated forms remain valid too; normalize the
// supported shapes once so the service contract matches runtime reality.
export function parseStatusFilter(input: string | readonly string[] | undefined): string[] {
  if (input === undefined || input === null) return [];
  const entries = Array.isArray(input) ? input : typeof input === "string" ? [input] : [];
  return entries
    .flatMap((entry) => (typeof entry === "string" ? entry.split(",") : []))
    .map((status) => status.trim())
    .filter(Boolean);
}

export interface IssueFilters {
  attention?: "blocked";
  status?: string | readonly string[];
  /**
   * Filter by assignee agent ID.
   * - `string` (UUID): match issues assigned to that agent.
   * - `null`: match unassigned issues (IS NULL).
   * - The literal string `"null"` is also accepted as a sentinel for `null`
   *   so that query-string callers can pass `?assigneeAgentId=null` directly.
   *   The route layer normalises it before calling the service, but the service
   *   also normalises it for direct callers.
   */
  assigneeAgentId?: string | null;
  participantAgentId?: string;
  assigneeUserId?: string;
  touchedByUserId?: string;
  inboxArchivedByUserId?: string;
  unreadForUserId?: string;
  projectId?: string;
  workspaceId?: string;
  executionWorkspaceId?: string;
  parentId?: string;
  descendantOf?: string;
  labelId?: string;
  originKind?: string;
  originKindPrefix?: string;
  originId?: string;
  originFingerprint?: string;
  includeRoutineExecutions?: boolean;
  excludeRoutineExecutions?: boolean;
  includePluginOperations?: boolean;
  includeBlockedBy?: boolean;
  includeBlockedInboxAttention?: boolean;
  includeLiveDescendantSummary?: boolean;
  hasPlanDocument?: boolean;
  lowTrustBoundary?: LowTrustBoundary & { companyId: string };
  q?: string;
  limit?: number;
  offset?: number;
  sortField?: "updated";
  sortDir?: "asc" | "desc";
}

type IssueRow = typeof issues.$inferSelect;
type IssueLabelRow = typeof labels.$inferSelect;
type IssuePlanDecompositionRow = typeof issuePlanDecompositions.$inferSelect;
type IssueActiveRunRow = {
  id: string;
  status: string;
  agentId: string;
  invocationSource: string;
  triggerDetail: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
  // BLO-19001: liveness signals, so a consumer can tell a run that is actually
  // holding this issue from one that has been silent long enough to be stale.
  lastOutputAt: Date | null;
  lastUsefulActionAt: Date | null;
};
type IssueScheduledRetryRow = {
  runId: string;
  status: "scheduled_retry" | "queued" | "running" | "cancelled";
  agentId: string;
  agentName: string | null;
  retryOfRunId: string | null;
  scheduledRetryAt: Date | null;
  scheduledRetryAttempt: number;
  scheduledRetryReason: string | null;
  retryExhaustedReason?: string | null;
  error?: string | null;
  errorCode?: string | null;
};
type IssueWithLabels = IssueRow & {
  labels: IssueLabelRow[];
  labelIds: string[];
  watchdog?: IssueWatchdogSummary | null;
};
type IssueWithLabelsAndRun = IssueWithLabels & { activeRun: IssueActiveRunRow | null };
type IssueUserCommentStats = {
  issueId: string;
  myLastCommentAt: Date | null;
  lastExternalCommentAt: Date | null;
};
type IssueReadStat = {
  issueId: string;
  myLastReadAt: Date | null;
};
type IssueLastActivityStat = {
  issueId: string;
  latestCommentAt: Date | null;
  latestLogAt: Date | null;
};

function serializeAcceptedPlanDecomposition(
  decomposition: IssuePlanDecompositionRow,
): AcceptedPlanDecomposition {
  return {
    id: decomposition.id,
    companyId: decomposition.companyId,
    sourceIssueId: decomposition.sourceIssueId,
    acceptedPlanRevisionId: decomposition.acceptedPlanRevisionId,
    acceptedInteractionId: decomposition.acceptedInteractionId,
    status: decomposition.status as AcceptedPlanDecomposition["status"],
    requestFingerprint: decomposition.requestFingerprint,
    // Intentionally omit requestedChildren here; the API only needs stable counts
    // and child ids, while the durable table keeps the full child draft payload.
    requestedChildCount: decomposition.requestedChildCount,
    childIssueIds: normalizeIssuePlanDecompositionChildIds(decomposition.childIssueIds),
    ownerAgentId: decomposition.ownerAgentId,
    ownerUserId: decomposition.ownerUserId,
    ownerRunId: decomposition.ownerRunId,
    completedAt: decomposition.completedAt,
    createdAt: decomposition.createdAt,
    updatedAt: decomposition.updatedAt,
  };
}
type IssueUserContextInput = {
  createdByUserId: string | null;
  assigneeUserId: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
};
type ProjectGoalReader = Pick<Db, "select">;
type DbReader = Pick<Db, "select">;
type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type IssueCreateInput = Omit<typeof issues.$inferInsert, "companyId"> & {
  labelIds?: string[];
  blockedByIssueIds?: string[];
  inheritExecutionWorkspaceFromIssueId?: string | null;
  /**
   * Mirror-create signal from Linear-side imports (webhook, manual import,
   * bulk-import). Plumbs to allocateIdentifier so the linear-provider path
   * skips IssueCreate and uses this identifier verbatim, and ensures a
   * linear_issue_links row is written for paperclip-provider companies
   * too. Suppresses the compensating Linear-delete on tx rollback — the
   * Linear issue pre-existed.
   */
  linkedLinearIssue?: { id: string; identifier: string };
  skipExecutionWorkspaceInheritance?: boolean;
  watchdog?: { agentId: string; instructions?: string | null } | null;
  watchdogActorRunId?: string | null;
  actorRunId?: string | null;
  actorResponsibleUserId?: string | null;
  trustExplicitResponsibleUserId?: boolean;
  idempotencyKey?: string | null;
  allowDuplicate?: boolean;
  onDeduplicated?: (reason: "idempotency_key" | "recent_open_title") => void;
  beforeSideEffects?: (tx: DbTransaction) => Promise<void> | void;
};
type IssueChildCreateInput = IssueCreateInput & {
  acceptanceCriteria?: string[];
  blockParentUntilDone?: boolean;
  executionWorkspaceInheritanceMode?: "linkage" | "strategy_only";
  actorAgentId?: string | null;
  actorUserId?: string | null;
};
type AcceptedPlanDecompositionInput = {
  acceptedPlanRevisionId: string;
  children: IssueChildCreateInput[];
  actorAgentId?: string | null;
  actorUserId?: string | null;
  actorRunId?: string | null;
};
type AcceptedPlanDocumentInteraction = {
  id: string;
};
type IssueRelationSummaryMap = {
  blockedBy: IssueRelationIssueSummary[];
  blocks: IssueRelationIssueSummary[];
};
type IssueBlockerDiagnosticsIssueRow = {
  id: string;
  companyId: string;
  projectId: string | null;
  parentId: string | null;
  identifier: string | null;
  title: string;
  status: typeof ALL_ISSUE_STATUSES[number];
  priority: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
};
type IssueWakeDiagnosticsWakeRequestRow = {
  agentId: string;
  source: string;
  reason: string | null;
  status: string;
  coalescedCount: number;
  runId: string | null;
  requestedAt: Date;
  claimedAt: Date | null;
  finishedAt: Date | null;
  error: string | null;
};
type IssueWakeDiagnosticsActivityRow = {
  action: string;
  entityType: string;
  entityId: string;
  agentId: string | null;
  runId: string | null;
  details: Record<string, unknown> | null;
  createdAt: Date;
};
type IssueSubtreeDiagnosticsIssueRow = IssueBlockerDiagnosticsIssueRow & {
  depth: number;
  createdAt: Date;
  updatedAt: Date;
};
type IssueSubtreeDiagnosticsBlockerRow = IssueBlockerDiagnosticsIssueRow & {
  blockedIssueId: string;
  relationCreatedAt: Date;
};
type IssueSubtreeDiagnosticsWakeRequestRow = IssueWakeDiagnosticsWakeRequestRow & {
  issueId: string;
};
type IssueSubtreeDiagnosticsActivityRow = IssueWakeDiagnosticsActivityRow & {
  issueId: string;
};
type IssueSubtreeDiagnosticsBlockerResultRow = IssueSubtreeDiagnosticsBlockerRow & {
  rowNumber: number | string;
};
type IssueSubtreeDiagnosticsWakeRequestResultRow = IssueSubtreeDiagnosticsWakeRequestRow & {
  rowNumber: number | string;
};
type IssueSubtreeDiagnosticsActivityResultRow = IssueSubtreeDiagnosticsActivityRow & {
  rowNumber: number | string;
};
export type IssueDependencyReadiness = {
  issueId: string;
  blockerIssueIds: string[];
  unresolvedBlockerIssueIds: string[];
  unresolvedBlockerCount: number;
  /** Blockers whose status is `done` but whose execution workspace has not yet finalized. */
  pendingFinalizeBlockerIssueIds: string[];
  allBlockersDone: boolean;
  isDependencyReady: boolean;
};
export type ChildIssueCompletionSummary = {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  priority: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  updatedAt: Date;
  summary: string | null;
};

function sameRunLock(checkoutRunId: string | null, actorRunId: string | null) {
  if (actorRunId) return checkoutRunId === actorRunId;
  return checkoutRunId == null;
}

export const TERMINAL_HEARTBEAT_RUN_STATUSES = new Set([
  "succeeded",
  "interrupted",
  "failed",
  "error",
  "adapter_failed",
  "cancelled",
  "timed_out",
]);
const STALE_ISSUE_CONTEXT_RUN_STATUSES = ["queued", "scheduled_retry"] as const;
// Same statuses, as a lookup set: these are the non-terminal statuses a run can
// hold before it has ever executed.
const NEVER_STARTED_HEARTBEAT_RUN_STATUSES = new Set<string>(STALE_ISSUE_CONTEXT_RUN_STATUSES);

// BLO-20321: a run that exists but has never executed holds no real claim on an
// issue. `queued` and `scheduled_retry` are non-terminal, so a terminal-only
// staleness test read them as a live owner and answered the assignee's own write
// with 409 "Issue run ownership conflict". That made WIP monotonic: checkout adds
// WIP without a lock, while parking or closing needs the lock — and the lock was
// held by the very queue backlog being drained.
//
// Reaping is gated on `startedAt == null` as well as status, so a run that has
// actually begun is never reaped here even if its status column is momentarily
// out of step. The race protection the guard exists for is preserved: a genuinely
// `running` owner still conflicts.
//
// This is the single source of truth for "is this lock owner reapable". There are
// Transactional ownership paths read the run rows themselves and defer to this
// predicate; they must not drift, because adoptStaleCheckoutRun runs FIRST and a
// non-stale verdict there throws the 409 before another recovery path is reached.
function isReapableHeartbeatRunRow(
  run: { status: string; startedAt: Date | null } | null | undefined,
): boolean {
  if (!run) return true;
  if (TERMINAL_HEARTBEAT_RUN_STATUSES.has(run.status)) return true;
  return NEVER_STARTED_HEARTBEAT_RUN_STATUSES.has(run.status) && run.startedAt == null;
}
const ISSUE_LIST_DESCRIPTION_MAX_CHARS = 1200;

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

export function clampIssueListLimit(limit: number): number {
  return Math.min(ISSUE_LIST_MAX_LIMIT, Math.max(1, Math.floor(limit)));
}

function truncateByCodePoint(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return Array.from(value).slice(0, maxChars).join("");
}

function decodeDatabaseTextPreview(value: string | null | undefined, maxChars: number): string | null {
  if (value == null) return null;
  return truncateByCodePoint(value, maxChars);
}

function chunkList<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function truncateInlineSummary(value: string | null | undefined, maxChars = CHILD_COMPLETION_SUMMARY_BODY_MAX_CHARS) {
  const normalized = value?.trim();
  if (!normalized) return null;
  return normalized.length > maxChars ? `${normalized.slice(0, Math.max(0, maxChars - 15)).trimEnd()} [truncated]` : normalized;
}

function appendAcceptanceCriteriaToDescription(description: string | null | undefined, acceptanceCriteria: string[] | undefined) {
  const criteria = (acceptanceCriteria ?? []).map((item) => item.trim()).filter(Boolean);
  if (criteria.length === 0) return description ?? null;
  const base = description?.trim() ?? "";
  const criteriaMarkdown = ["## Acceptance Criteria", "", ...criteria.map((item) => `- ${item}`)].join("\n");
  return base ? `${base}\n\n${criteriaMarkdown}` : criteriaMarkdown;
}

function normalizeAcceptedPlanDecompositionFingerprintValue(value: unknown): unknown {
  if (value === undefined) return null;
  if (
    value == null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    return value.map((item) => normalizeAcceptedPlanDecompositionFingerprintValue(item));
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, normalizeAcceptedPlanDecompositionFingerprintValue(record[key])]),
    );
  }
  return String(value);
}

const ACCEPTED_PLAN_DECOMPOSITION_FINGERPRINT_CHILD_METADATA_KEYS = new Set([
  "id",
  "companyId",
  "parentId",
  "identifier",
  "checkoutRunId",
  "executionRunId",
  "executionLockedAt",
  "startedAt",
  "completedAt",
  "cancelledAt",
  "hiddenAt",
  "createdAt",
  "updatedAt",
  "createdByAgentId",
  "createdByUserId",
  "updatedByAgentId",
  "updatedByUserId",
  "actorAgentId",
  "actorUserId",
  "executionWorkspaceInheritanceMode",
  "skipExecutionWorkspaceInheritance",
]);

function normalizeAcceptedPlanDecompositionFingerprintChild(child: IssueChildCreateInput) {
  return Object.fromEntries(
    Object.entries(child).filter(([key]) => !ACCEPTED_PLAN_DECOMPOSITION_FINGERPRINT_CHILD_METADATA_KEYS.has(key)),
  );
}

function createAcceptedPlanDecompositionRequestFingerprint(input: {
  acceptedPlanRevisionId: string;
  children: IssueChildCreateInput[];
}) {
  const canonical = JSON.stringify(normalizeAcceptedPlanDecompositionFingerprintValue({
    acceptedPlanRevisionId: input.acceptedPlanRevisionId,
    children: input.children.map(normalizeAcceptedPlanDecompositionFingerprintChild),
  }));
  return createHash("sha256").update(canonical).digest("hex");
}

function normalizeIssuePlanDecompositionChildIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

export function readAcceptedPlanConfirmationTarget(payload: unknown): {
  revisionId: string;
  key: string;
  issueId: string;
} | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const target = (payload as Record<string, unknown>).target;
  if (!target || typeof target !== "object" || Array.isArray(target)) return null;
  const record = target as Record<string, unknown>;
  if (record.type !== "issue_document") return null;
  const revisionId = readStringFromRecord(record, "revisionId");
  const key = readStringFromRecord(record, "key");
  const issueId = readStringFromRecord(record, "issueId");
  if (!revisionId || !key || !issueId) return null;
  return { revisionId, key, issueId };
}

async function resolveAcceptedPlanClaimOwner(input: {
  dbOrTx: Pick<Db, "select">;
  claim: Pick<typeof issuePlanDecompositions.$inferSelect, "ownerAgentId" | "ownerUserId" | "ownerRunId">;
  actorAgentId?: string | null;
  actorUserId?: string | null;
  actorRunId?: string | null;
}) {
  const nextOwner = {
    ownerAgentId: input.actorAgentId ?? null,
    ownerUserId: input.actorUserId ?? null,
    ownerRunId: input.actorRunId ?? null,
  };
  if (
    input.claim.ownerAgentId === nextOwner.ownerAgentId
    && input.claim.ownerUserId === nextOwner.ownerUserId
    && input.claim.ownerRunId === nextOwner.ownerRunId
  ) {
    return nextOwner;
  }

  if (!input.claim.ownerRunId) {
    return nextOwner;
  }

  const existingOwnerRun = await input.dbOrTx
    .select({ status: heartbeatRuns.status })
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.id, input.claim.ownerRunId))
    .then((rows) => rows[0] ?? null);
  if (existingOwnerRun && !TERMINAL_HEARTBEAT_RUN_STATUSES.has(existingOwnerRun.status)) {
    return {
      ownerAgentId: input.claim.ownerAgentId,
      ownerUserId: input.claim.ownerUserId,
      ownerRunId: input.claim.ownerRunId,
    };
  }

  return nextOwner;
}

async function findAcceptedPlanDocumentInteraction(
  dbOrTx: Pick<Db, "select">,
  input: {
    companyId: string;
    sourceIssueId: string;
    acceptedPlanRevisionId: string;
  },
): Promise<AcceptedPlanDocumentInteraction | null> {
  const rows = await dbOrTx
    .select({
      id: issueThreadInteractions.id,
      payload: issueThreadInteractions.payload,
    })
    .from(issueThreadInteractions)
    .where(and(
      eq(issueThreadInteractions.companyId, input.companyId),
      eq(issueThreadInteractions.issueId, input.sourceIssueId),
      eq(issueThreadInteractions.kind, "request_confirmation"),
      eq(issueThreadInteractions.status, "accepted"),
    ))
    .orderBy(desc(issueThreadInteractions.resolvedAt), desc(issueThreadInteractions.createdAt));

  for (const row of rows) {
    const target = readAcceptedPlanConfirmationTarget(row.payload);
    if (
      target?.issueId === input.sourceIssueId &&
      target.key === "plan" &&
      target.revisionId === input.acceptedPlanRevisionId
    ) {
      return { id: row.id };
    }
  }
  return null;
}

function createIssueDependencyReadiness(issueId: string): IssueDependencyReadiness {
  return {
    issueId,
    blockerIssueIds: [],
    unresolvedBlockerIssueIds: [],
    unresolvedBlockerCount: 0,
    pendingFinalizeBlockerIssueIds: [],
    allBlockersDone: true,
    isDependencyReady: true,
  };
}

/**
 * Returns the set of execution-workspace ids whose most recent workspace operation
 * is NOT a successful `workspace_finalize`. These workspaces have either an in-flight
 * run, a failed finalize, or never reached the finalize barrier — dependents that
 * read this workspace must wait until finalize succeeds.
 *
 * Workspaces with no recorded operations are considered finalized (nothing has
 * touched them since they were realized).
 */
export async function listUnfinalizedExecutionWorkspaceIds(
  dbOrTx: Pick<Db, "select">,
  companyId: string,
  executionWorkspaceIds: string[],
): Promise<Set<string>> {
  const unfinalized = new Set<string>();
  if (executionWorkspaceIds.length === 0) return unfinalized;

  // Pull every workspace op for the candidate workspaces and pick the latest per
  // workspace in memory. Per-workspace LATERAL queries would be tighter, but the
  // candidate set is tiny in practice (one workspace per blocker per readiness call).
  const rows = await dbOrTx
    .select({
      executionWorkspaceId: workspaceOperations.executionWorkspaceId,
      phase: workspaceOperations.phase,
      status: workspaceOperations.status,
      startedAt: workspaceOperations.startedAt,
    })
    .from(workspaceOperations)
    .where(
      and(
        eq(workspaceOperations.companyId, companyId),
        inArray(workspaceOperations.executionWorkspaceId, executionWorkspaceIds),
      ),
    );

  const latestByWorkspace = new Map<string, { phase: string; status: string; startedAt: Date }>();
  for (const row of rows) {
    if (!row.executionWorkspaceId) continue;
    const current = latestByWorkspace.get(row.executionWorkspaceId);
    if (!current || row.startedAt > current.startedAt) {
      latestByWorkspace.set(row.executionWorkspaceId, {
        phase: row.phase,
        status: row.status,
        startedAt: row.startedAt,
      });
    }
  }

  for (const workspaceId of executionWorkspaceIds) {
    const latest = latestByWorkspace.get(workspaceId);
    if (!latest) continue; // no ops recorded → treat as finalized
    if (latest.phase === "workspace_finalize" && latest.status === "succeeded") continue;
    unfinalized.add(workspaceId);
  }

  return unfinalized;
}

async function listPendingFinalizeBlockerIssueIds(
  dbOrTx: Pick<Db, "select">,
  companyId: string,
  blockerWorkspacePairs: Array<{ blockerIssueId: string; executionWorkspaceId: string }>,
): Promise<Set<string>> {
  const pending = new Set<string>();
  const blockerIssueIds = [...new Set(blockerWorkspacePairs.map((pair) => pair.blockerIssueId))];
  const executionWorkspaceIds = [...new Set(blockerWorkspacePairs.map((pair) => pair.executionWorkspaceId))];
  if (blockerIssueIds.length === 0 || executionWorkspaceIds.length === 0) return pending;
  const blockerWorkspaceKeys = new Set(
    blockerWorkspacePairs.map((pair) => `${pair.blockerIssueId}:${pair.executionWorkspaceId}`),
  );

  const rows = await dbOrTx
    .select({
      issueId: workspaceOperations.issueId,
      executionWorkspaceId: workspaceOperations.executionWorkspaceId,
      phase: workspaceOperations.phase,
      status: workspaceOperations.status,
      startedAt: workspaceOperations.startedAt,
    })
    .from(workspaceOperations)
    .where(
      and(
        eq(workspaceOperations.companyId, companyId),
        inArray(workspaceOperations.executionWorkspaceId, executionWorkspaceIds),
        or(inArray(workspaceOperations.issueId, blockerIssueIds), isNull(workspaceOperations.issueId)),
      ),
    );

  const latestAttributedByBlockerWorkspace = new Map<string, { phase: string; status: string; startedAt: Date }>();
  const latestUnattributedByWorkspace = new Map<string, { phase: string; status: string; startedAt: Date }>();
  for (const row of rows) {
    if (!row.executionWorkspaceId) continue;
    if (row.issueId) {
      const key = `${row.issueId}:${row.executionWorkspaceId}`;
      if (!blockerWorkspaceKeys.has(key)) continue;
      const current = latestAttributedByBlockerWorkspace.get(key);
      if (!current || row.startedAt > current.startedAt) {
        latestAttributedByBlockerWorkspace.set(key, {
          phase: row.phase,
          status: row.status,
          startedAt: row.startedAt,
        });
      }
      continue;
    }

    const current = latestUnattributedByWorkspace.get(row.executionWorkspaceId);
    if (!current || row.startedAt > current.startedAt) {
      latestUnattributedByWorkspace.set(row.executionWorkspaceId, {
        phase: row.phase,
        status: row.status,
        startedAt: row.startedAt,
      });
    }
  }

  for (const pair of blockerWorkspacePairs) {
    const latest = latestAttributedByBlockerWorkspace.get(`${pair.blockerIssueId}:${pair.executionWorkspaceId}`)
      ?? latestUnattributedByWorkspace.get(pair.executionWorkspaceId);
    if (!latest) continue; // no ops recorded -> nothing to finalize for this blocker
    if (latest.phase === "workspace_finalize" && latest.status === "succeeded") continue;
    pending.add(pair.blockerIssueId);
  }

  return pending;
}

/**
 * Returns whether a specific run's operations on a specific execution workspace
 * reached the workspace_finalize barrier.
 *
 * Runs with no operations on the workspace are considered finalized because
 * they never touched the workspace state that accept/review gates protect.
 */
export async function runWorkspaceIsFinalized(
  dbOrTx: Pick<Db, "select">,
  companyId: string,
  executionWorkspaceId: string,
  runId: string,
): Promise<boolean> {
  const rows = await dbOrTx
    .select({
      phase: workspaceOperations.phase,
      status: workspaceOperations.status,
      startedAt: workspaceOperations.startedAt,
    })
    .from(workspaceOperations)
    .where(
      and(
        eq(workspaceOperations.companyId, companyId),
        eq(workspaceOperations.executionWorkspaceId, executionWorkspaceId),
        eq(workspaceOperations.heartbeatRunId, runId),
      ),
    );

  let latest: { phase: string; status: string; startedAt: Date } | null = null;
  for (const row of rows) {
    if (!latest || row.startedAt > latest.startedAt) latest = row;
  }

  if (!latest) return true;
  return latest.phase === "workspace_finalize" && latest.status === "succeeded";
}

async function listIssueDependencyReadinessMap(
  dbOrTx: Pick<Db, "select">,
  companyId: string,
  issueIds: string[],
) {
  const uniqueIssueIds = [...new Set(issueIds.filter(Boolean))];
  const readinessMap = new Map<string, IssueDependencyReadiness>();
  for (const issueId of uniqueIssueIds) {
    readinessMap.set(issueId, createIssueDependencyReadiness(issueId));
  }
  if (uniqueIssueIds.length === 0) return readinessMap;

  const blockerRows = await dbOrTx
    .select({
      issueId: issueRelations.relatedIssueId,
      blockerIssueId: issueRelations.issueId,
      blockerStatus: issues.status,
      blockerExecutionWorkspaceId: issues.executionWorkspaceId,
    })
    .from(issueRelations)
    .innerJoin(issues, eq(issueRelations.issueId, issues.id))
    .where(
      and(
        eq(issueRelations.companyId, companyId),
        eq(issueRelations.type, "blocks"),
        inArray(issueRelations.relatedIssueId, uniqueIssueIds),
      ),
    );

  // Collect issue/workspace pairs of "done" blockers — these are the only ones
  // subject to the workspace-finalize barrier. Blockers that aren't done already
  // mark the dependent as not-ready and don't need a finalize check.
  const doneBlockerWorkspacePairs: Array<{ blockerIssueId: string; executionWorkspaceId: string }> = [];
  for (const row of blockerRows) {
    if (row.blockerStatus === "done" && row.blockerExecutionWorkspaceId) {
      doneBlockerWorkspacePairs.push({
        blockerIssueId: row.blockerIssueId,
        executionWorkspaceId: row.blockerExecutionWorkspaceId,
      });
    }
  }
  const pendingFinalizeBlockerIssueIds = await listPendingFinalizeBlockerIssueIds(
    dbOrTx,
    companyId,
    doneBlockerWorkspacePairs,
  );

  for (const row of blockerRows) {
    const current = readinessMap.get(row.issueId) ?? createIssueDependencyReadiness(row.issueId);
    current.blockerIssueIds.push(row.blockerIssueId);
    // Only done blockers resolve dependents; cancelled blockers stay unresolved
    // until an operator removes or replaces the blocker relationship explicitly.
    if (row.blockerStatus !== "done") {
      current.unresolvedBlockerIssueIds.push(row.blockerIssueId);
      current.unresolvedBlockerCount += 1;
      current.allBlockersDone = false;
      current.isDependencyReady = false;
    } else if (
      row.blockerExecutionWorkspaceId &&
      pendingFinalizeBlockerIssueIds.has(row.blockerIssueId)
    ) {
      // Workspace-finalize barrier: the blocker's most recent run on its
      // execution workspace hasn't recorded a successful workspace_finalize.
      // Treat the dependent as not-ready until sync-back lands (or the run
      // finalizes); a subsequent finalize wake will re-evaluate readiness.
      // `allBlockersDone` is cleared too so that callers using it as a
      // proxy for "this dependent can proceed" still see the gate.
      current.unresolvedBlockerIssueIds.push(row.blockerIssueId);
      current.unresolvedBlockerCount += 1;
      current.pendingFinalizeBlockerIssueIds.push(row.blockerIssueId);
      current.allBlockersDone = false;
      current.isDependencyReady = false;
    }
    readinessMap.set(row.issueId, current);
  }

  return readinessMap;
}

async function listUnresolvedBlockerIssueIds(
  dbOrTx: Pick<Db, "select">,
  companyId: string,
  blockerIssueIds: string[],
) {
  const uniqueBlockerIssueIds = [...new Set(blockerIssueIds.filter(Boolean))];
  if (uniqueBlockerIssueIds.length === 0) return [];
  return dbOrTx
    .select({ id: issues.id })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, companyId),
        inArray(issues.id, uniqueBlockerIssueIds),
        // Cancelled blockers intentionally remain unresolved until the relation changes.
        ne(issues.status, "done"),
      ),
    )
    .then((rows) => rows.map((row) => row.id));
}
async function getProjectDefaultGoalId(
  db: ProjectGoalReader,
  companyId: string,
  projectId: string | null | undefined,
) {
  if (!projectId) return null;
  const row = await db
    .select({ goalId: projects.goalId })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.companyId, companyId)))
    .then((rows) => rows[0] ?? null);
  return row?.goalId ?? null;
}

async function getWorkspaceInheritanceIssue(
  db: DbReader,
  companyId: string,
  issueId: string,
) {
  const issue = await db
    .select({
      id: issues.id,
      projectId: issues.projectId,
      projectWorkspaceId: issues.projectWorkspaceId,
      executionWorkspaceId: issues.executionWorkspaceId,
      executionWorkspaceSettings: issues.executionWorkspaceSettings,
    })
    .from(issues)
    .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)))
    .then((rows) => rows[0] ?? null);
  if (!issue) {
    throw notFound("Workspace inheritance issue not found");
  }
  return issue;
}

function touchedByUserCondition(companyId: string, userId: string) {
  return sql<boolean>`
    (
      ${issues.createdByUserId} = ${userId}
      OR ${issues.assigneeUserId} = ${userId}
      OR EXISTS (
        SELECT 1
        FROM ${issueReadStates}
        WHERE ${issueReadStates.issueId} = ${issues.id}
          AND ${issueReadStates.companyId} = ${companyId}
          AND ${issueReadStates.userId} = ${userId}
      )
      OR EXISTS (
        SELECT 1
        FROM ${issueComments}
        WHERE ${issueComments.issueId} = ${issues.id}
          AND ${issueComments.companyId} = ${companyId}
          AND ${issueComments.authorUserId} = ${userId}
      )
    )
  `;
}

function participatedByAgentCondition(companyId: string, agentId: string) {
  return sql<boolean>`
    (
      ${issues.createdByAgentId} = ${agentId}
      OR ${issues.assigneeAgentId} = ${agentId}
      OR EXISTS (
        SELECT 1
        FROM ${issueComments}
        WHERE ${issueComments.issueId} = ${issues.id}
          AND ${issueComments.companyId} = ${companyId}
          AND ${issueComments.authorAgentId} = ${agentId}
      )
      OR EXISTS (
        SELECT 1
        FROM ${activityLog}
        WHERE ${activityLog.companyId} = ${companyId}
          AND ${activityLog.entityType} = 'issue'
          AND ${activityLog.entityId} = ${issues.id}::text
          AND ${activityLog.agentId} = ${agentId}
      )
    )
  `;
}

function myLastCommentAtExpr(companyId: string, userId: string) {
  return sql<Date | null>`
    (
      SELECT MAX(${issueComments.createdAt})
      FROM ${issueComments}
      WHERE ${issueComments.issueId} = ${issues.id}
        AND ${issueComments.companyId} = ${companyId}
        AND ${issueComments.authorUserId} = ${userId}
    )
  `;
}

function myLastReadAtExpr(companyId: string, userId: string) {
  return sql<Date | null>`
    (
      SELECT MAX(${issueReadStates.lastReadAt})
      FROM ${issueReadStates}
      WHERE ${issueReadStates.issueId} = ${issues.id}
        AND ${issueReadStates.companyId} = ${companyId}
        AND ${issueReadStates.userId} = ${userId}
    )
  `;
}

function myLastTouchAtExpr(companyId: string, userId: string) {
  const myLastCommentAt = myLastCommentAtExpr(companyId, userId);
  const myLastReadAt = myLastReadAtExpr(companyId, userId);
  return sql<Date | null>`
    GREATEST(
      COALESCE(${myLastCommentAt}, to_timestamp(0)),
      COALESCE(${myLastReadAt}, to_timestamp(0)),
      COALESCE(CASE WHEN ${issues.createdByUserId} = ${userId} THEN ${issues.createdAt} ELSE NULL END, to_timestamp(0)),
      COALESCE(CASE WHEN ${issues.assigneeUserId} = ${userId} THEN ${issues.updatedAt} ELSE NULL END, to_timestamp(0))
    )
  `;
}

// NOTE: A previous helper `issueLastActivityAtExpr(companyId, userId)` lived
// here that computed a per-user, per-row "last activity" expression via
// correlated subqueries on issue_comments / issue_read_states. It was the
// right-hand side of `inboxVisibleForUserCondition`, which made that predicate
// non-sargable and caused the inbox query to take 1-2 minutes for accounts
// with a few thousand issues. It has been replaced by the materialized
// `issues.last_activity_at` column maintained by DB triggers (see migration
// 0072_issues_last_activity_at.sql).

const ISSUE_LOCAL_INBOX_ACTIVITY_ACTIONS = [
  "issue.read_marked",
  "issue.read_unmarked",
  "issue.inbox_archived",
  "issue.inbox_unarchived",
] as const;

function issueLatestCommentAtExpr(companyId: string) {
  return sql<Date | null>`
    (
      SELECT MAX(${issueComments.createdAt})
      FROM ${issueComments}
      WHERE ${issueComments.issueId} = ${issues.id}
        AND ${issueComments.companyId} = ${companyId}
    )
  `;
}

function issueLatestLogAtExpr(companyId: string) {
  return sql<Date | null>`
    (
      SELECT MAX(${activityLog.createdAt})
      FROM ${activityLog}
      WHERE ${activityLog.companyId} = ${companyId}
        AND ${activityLog.entityType} = 'issue'
        AND ${activityLog.entityId} = ${issues.id}::text
        AND ${activityLog.action} NOT IN (${sql.join(
          ISSUE_LOCAL_INBOX_ACTIVITY_ACTIONS.map((action) => sql`${action}`),
          sql`, `,
        )})
    )
  `;
}

function issueCanonicalLastActivityAtExpr(companyId: string) {
  const latestCommentAt = issueLatestCommentAtExpr(companyId);
  const latestLogAt = issueLatestLogAtExpr(companyId);
  return sql<Date>`
    GREATEST(
      ${issues.updatedAt},
      COALESCE(${latestCommentAt}, to_timestamp(0)),
      COALESCE(${latestLogAt}, to_timestamp(0))
    )
  `;
}

function unreadForUserCondition(companyId: string, userId: string) {
  const touchedCondition = touchedByUserCondition(companyId, userId);
  const myLastTouchAt = myLastTouchAtExpr(companyId, userId);
  return sql<boolean>`
    (
      ${touchedCondition}
      AND EXISTS (
        SELECT 1
        FROM ${issueComments}
        WHERE ${issueComments.issueId} = ${issues.id}
          AND ${issueComments.companyId} = ${companyId}
          AND (
            ${issueComments.authorUserId} IS NULL
            OR ${issueComments.authorUserId} <> ${userId}
          )
          AND ${issueComments.createdAt} > ${myLastTouchAt}
      )
    )
  `;
}

/**
 * Hide issues that the given user has archived from their inbox, unless new
 * activity has occurred on the issue since the archive timestamp.
 *
 * The right-hand side compares against the materialized
 * {@link issues.lastActivityAt} column rather than a per-row dynamic
 * expression involving correlated subqueries over `issue_comments`,
 * `issue_read_states`, and `activity_log`. That makes the predicate sargable
 * and lets Postgres perform a single hash semi-join against
 * `issue_inbox_archives` instead of replaying multiple correlated subqueries
 * per scanned issue.
 *
 * Semantic note: this uses a global "last activity on the issue" timestamp,
 * not a per-user "subjective" activity timestamp (which is what the previous
 * implementation computed). Concretely: if user U archives issue X at T1 and
 * then *user U themselves* posts a comment at T2 > T1, the issue will resurface
 * (under the old implementation it would not, because U's own comment was
 * counted as "their own touch" and excluded). This matches Slack/Linear inbox
 * semantics and is the desired behavior.
 */
function inboxVisibleForUserCondition(companyId: string, userId: string) {
  return sql<boolean>`
    NOT EXISTS (
      SELECT 1
      FROM ${issueInboxArchives}
      WHERE ${issueInboxArchives.issueId} = ${issues.id}
        AND ${issueInboxArchives.companyId} = ${companyId}
        AND ${issueInboxArchives.userId} = ${userId}
        AND ${issueInboxArchives.archivedAt} >= ${issues.lastActivityAt}
    )
  `;
}

const LEGACY_PLUGIN_OPERATION_ORIGIN_KINDS = [
  "plugin:paperclipai.content-machine:case",
  "plugin:paperclipai.content-machine:evaluation",
  "plugin:paperclipai.content-machine:source-sync",
] as const;

function nonPluginOperationIssueCondition() {
  return sql<boolean>`NOT (
    ${issues.originKind} LIKE 'plugin:%:operation'
    OR ${issues.originKind} LIKE 'plugin:%:operation:%'
    OR ${inArray(issues.originKind, LEGACY_PLUGIN_OPERATION_ORIGIN_KINDS)}
  )`;
}

function shouldIncludePluginOperationIssues(filters: IssueFilters | undefined) {
  return Boolean(
    filters?.includePluginOperations ||
    filters?.originKind ||
    filters?.originKindPrefix ||
    filters?.originId ||
    filters?.projectId,
  );
}

function shouldExcludeRoutineExecutionIssues(filters: IssueFilters | undefined) {
  return Boolean(
    !filters?.includeRoutineExecutions &&
    !filters?.originKind &&
    !filters?.originKindPrefix &&
    !filters?.originId,
  );
}

function nonRoutineExecutionIssueCondition() {
  return or(isNull(issues.originKind), ne(issues.originKind, "routine_execution"))!;
}

/** Named entities commonly emitted in saved issue bodies; unknown `&name;` sequences are left unchanged. */
const WELL_KNOWN_NAMED_HTML_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  apos: "'",
  copy: "\u00A9",
  gt: ">",
  lt: "<",
  nbsp: "\u00A0",
  quot: '"',
  ensp: "\u2002",
  emsp: "\u2003",
  thinsp: "\u2009",
};

function decodeNumericHtmlEntity(digits: string, radix: 16 | 10): string | null {
  const n = Number.parseInt(digits, radix);
  if (Number.isNaN(n) || n < 0 || n > 0x10ffff) return null;
  try {
    return String.fromCodePoint(n);
  } catch {
    return null;
  }
}

/** Decodes HTML character references in a raw @mention capture so UI-encoded bodies match agent names. */
export function normalizeAgentMentionToken(raw: string): string {
  let s = raw.replace(/&#x([0-9a-fA-F]+);/gi, (full, hex: string) => decodeNumericHtmlEntity(hex, 16) ?? full);
  s = s.replace(/&#([0-9]+);/g, (full, dec: string) => decodeNumericHtmlEntity(dec, 10) ?? full);
  s = s.replace(/&([a-z][a-z0-9]*);/gi, (full, name: string) => {
    const decoded = WELL_KNOWN_NAMED_HTML_ENTITIES[name.toLowerCase()];
    return decoded !== undefined ? decoded : full;
  });
  return s.trim();
}

export function deriveIssueUserContext(
  issue: IssueUserContextInput,
  userId: string,
  stats:
    | {
      myLastCommentAt: Date | string | null;
      myLastReadAt: Date | string | null;
      lastExternalCommentAt: Date | string | null;
    }
    | null
    | undefined,
) {
  const normalizeDate = (value: Date | string | null | undefined) => {
    if (!value) return null;
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  };

  const myLastCommentAt = normalizeDate(stats?.myLastCommentAt);
  const myLastReadAt = normalizeDate(stats?.myLastReadAt);
  const createdTouchAt = issue.createdByUserId === userId ? normalizeDate(issue.createdAt) : null;
  const assignedTouchAt = issue.assigneeUserId === userId ? normalizeDate(issue.updatedAt) : null;
  const myLastTouchAt = [myLastCommentAt, myLastReadAt, createdTouchAt, assignedTouchAt]
    .filter((value): value is Date => value instanceof Date)
    .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
  const lastExternalCommentAt = normalizeDate(stats?.lastExternalCommentAt);
  const isUnreadForMe = Boolean(
    myLastTouchAt &&
    lastExternalCommentAt &&
    lastExternalCommentAt.getTime() > myLastTouchAt.getTime(),
  );

  return {
    myLastTouchAt,
    lastExternalCommentAt,
    isUnreadForMe,
  };
}

function latestIssueActivityAt(...values: Array<Date | string | null | undefined>): Date | null {
  const normalized = values
    .map((value) => {
      if (!value) return null;
      if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
      const parsed = new Date(value);
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    })
    .filter((value): value is Date => value instanceof Date)
    .sort((a, b) => b.getTime() - a.getTime());
  return normalized[0] ?? null;
}

type InboxArchiveAttributionRow = {
  issueId: string;
  archivedAt: Date;
  archivedByActorType: "user" | "agent";
  archivedByAgentId: string | null;
  archivedByRunId: string | null;
};

async function inboxArchiveRowsForIssues(
  dbOrTx: Db,
  companyId: string,
  userId: string,
  issueIds: string[],
): Promise<InboxArchiveAttributionRow[]> {
  if (issueIds.length === 0) return [];
  return dbOrTx
    .select({
      issueId: issueInboxArchives.issueId,
      archivedAt: issueInboxArchives.archivedAt,
      archivedByActorType: issueInboxArchives.archivedByActorType,
      archivedByAgentId: issueInboxArchives.archivedByAgentId,
      archivedByRunId: issueInboxArchives.archivedByRunId,
    })
    .from(issueInboxArchives)
    .where(and(
      eq(issueInboxArchives.companyId, companyId),
      eq(issueInboxArchives.userId, userId),
      inArray(issueInboxArchives.issueId, issueIds),
    ));
}

function activeInboxArchiveFields(
  archive: InboxArchiveAttributionRow | undefined,
  lastActivityAt: Date,
) {
  if (!archive || archive.archivedAt.getTime() < lastActivityAt.getTime()) return {};
  return {
    archivedAt: archive.archivedAt,
    archivedByActorType: archive.archivedByActorType,
    archivedByAgentId: archive.archivedByAgentId,
    archivedByRunId: archive.archivedByRunId,
  };
}

function issueListOrderBy(
  companyId: string,
  {
    hasSearch,
    priorityOrder,
    searchOrder,
    sortField,
    sortDir,
  }: {
    hasSearch: boolean;
    priorityOrder: SQL;
    searchOrder: SQL;
    sortField?: IssueFilters["sortField"];
    sortDir?: IssueFilters["sortDir"];
  },
) {
  const canonicalLastActivityAt = issueCanonicalLastActivityAtExpr(companyId);
  if (sortField === "updated") {
    const activityOrder = sortDir === "asc"
      ? asc(canonicalLastActivityAt)
      : desc(canonicalLastActivityAt);
    const updatedOrder = sortDir === "asc" ? asc(issues.updatedAt) : desc(issues.updatedAt);
    const idOrder = sortDir === "asc" ? asc(issues.id) : desc(issues.id);
    return hasSearch
      ? [asc(searchOrder), activityOrder, updatedOrder, idOrder]
      : [activityOrder, updatedOrder, idOrder];
  }

  return [
    hasSearch ? asc(searchOrder) : asc(priorityOrder),
    asc(priorityOrder),
    desc(canonicalLastActivityAt),
    desc(issues.updatedAt),
    desc(issues.id),
  ];
}

async function labelMapForIssues(dbOrTx: any, issueIds: string[]): Promise<Map<string, IssueLabelRow[]>> {
  const map = new Map<string, IssueLabelRow[]>();
  if (issueIds.length === 0) return map;
  for (const issueIdChunk of chunkList(issueIds, ISSUE_LIST_RELATED_QUERY_CHUNK_SIZE)) {
    const rows = await dbOrTx
      .select({
        issueId: issueLabels.issueId,
        label: labels,
      })
      .from(issueLabels)
      .innerJoin(labels, eq(issueLabels.labelId, labels.id))
      .where(inArray(issueLabels.issueId, issueIdChunk))
      .orderBy(asc(labels.name), asc(labels.id));

    for (const row of rows) {
      const existing = map.get(row.issueId);
      if (existing) existing.push(row.label);
      else map.set(row.issueId, [row.label]);
    }
  }
  return map;
}

async function withIssueLabels(dbOrTx: any, rows: IssueRow[]): Promise<IssueWithLabels[]> {
  if (rows.length === 0) return [];
  const issueIds = rows.map((row) => row.id);
  const [labelsByIssueId, watchdogByIssueId] = await Promise.all([
    labelMapForIssues(dbOrTx, issueIds),
    watchdogMapForIssues(dbOrTx, rows),
  ]);
  return rows.map((row) => {
    const issueLabels = labelsByIssueId.get(row.id) ?? [];
    return {
      ...row,
      labels: issueLabels,
      labelIds: issueLabels.map((label) => label.id),
      watchdog: watchdogByIssueId.get(row.id) ?? null,
    };
  });
}

/**
 * Shapes that record a DURABLE fact ("a PR/commit was attached to this issue"),
 * as opposed to a fact about the current comment window.
 */
const DURABLE_LANDING_SHAPES = ["pr-link", "landing-artifact"] as const;

/**
 * Carry forward durable landing evidence when re-evaluating an already-in_review
 * issue.
 *
 * The evaluator only scans the 10 most recent agent comments, so once ten
 * comments accumulate after the one bearing the PR link, a fresh evaluation
 * reports `allDetected: []`. On the in_review TRANSITION that is the honest
 * answer and it is what gets stored. But `done-gate.ts` reads the STORED
 * verdict's `allDetected` as the standing record that a PR was ever attached
 * (`hasPrLinkEvidence`), so letting a re-evaluation overwrite it would make an
 * issue that legitimately shipped a PR fail its later `done` transition with
 * `no_execution_run_and_no_pr_evidence` purely because the comment thread grew.
 * Before BLO-19047 the re-evaluation was a no-op, so the transition-time verdict
 * was durable by accident; this keeps it durable on purpose.
 *
 * Only `allDetected` is merged — `verdict`, `missing` and `requiredFound` stay
 * exactly as freshly computed, which is the whole point of re-evaluating.
 *
 * Note (BLO-19081): the done gate's third evidence path — a run-attributed
 * durable artifact, see `fetchDurableArtifactEvidence` below — deliberately does
 * NOT rely on this carry-forward. It queries the artifact rows live at close
 * time, so it has no comment-window to age out of and nothing to preserve. If
 * you add a fourth shape, prefer that pattern over widening
 * `DURABLE_LANDING_SHAPES`: a live row is a stronger record than a cached
 * verdict field, which is only needed for shapes scraped from comment text.
 */
function preserveDurableLandingEvidence<T extends { allDetected?: unknown }>(
  fresh: T,
  stored: unknown,
): T {
  const storedDetected = (stored as { allDetected?: unknown } | null)?.allDetected;
  if (!Array.isArray(storedDetected)) return fresh;
  const freshDetected = Array.isArray(fresh.allDetected) ? fresh.allDetected : [];
  const carried = DURABLE_LANDING_SHAPES.filter(
    (shape) => storedDetected.includes(shape) && !freshDetected.includes(shape),
  );
  if (carried.length === 0) return fresh;
  return { ...fresh, allDetected: [...freshDetected, ...carried] };
}

/**
 * Work-product types that count as a durable, inspectable deliverable for the
 * done gate. Deliberately narrow: `pull_request` / `branch` / `commit` are
 * already covered by the pr-link path, and `preview_url` / `runtime_service`
 * describe ephemeral infrastructure rather than a reviewable artifact.
 */
const DURABLE_ARTIFACT_WORK_PRODUCT_TYPES = ["artifact", "document"] as const;
const UUID_SQL_SOURCE =
  "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}";
const UUID_SQL_PATTERN = `^${UUID_SQL_SOURCE}$`;
const ATTACHMENT_CONTENT_URL_SQL_PATTERN = `^/api/attachments/${UUID_SQL_SOURCE}/content(\\?download=1)?$`;

function hasTrustedOrPromotedSourceTrust(sourceTrustColumn: any): SQL {
  return or(
    isNull(sourceTrustColumn as any),
    sql`${sourceTrustColumn}->>'disposition' = 'promoted'`,
  )!;
}

function hasInspectableWorkProductUrlLocator(): SQL {
  return or(
    // External artifact URLs are accepted as reviewer-openable locators. The
    // server deliberately does not resolve them here because that would create
    // SSRF surface; internal attachment URLs resolve against same-issue rows.
    sql`${issueWorkProducts.url} ~* '^https?://[^[:space:]]+$'`,
    sql`case
      when ${issueWorkProducts.url} ~* ${ATTACHMENT_CONTENT_URL_SQL_PATTERN}
      then exists (
        select 1
        from issue_attachments durable_url_attachment
        where durable_url_attachment.company_id = ${issueWorkProducts.companyId}
          and durable_url_attachment.issue_id = ${issueWorkProducts.issueId}
          and (
            ${issueWorkProducts.url} = '/api/attachments/' || durable_url_attachment.id::text || '/content'
            or ${issueWorkProducts.url} = '/api/attachments/' || durable_url_attachment.id::text || '/content?download=1'
          )
      )
      else false
    end`,
  )!;
}

function hasInspectableWorkProductLocator(issueId: string): SQL {
  return or(
    hasInspectableWorkProductUrlLocator(),
    and(
      sql`jsonb_typeof(${issueWorkProducts.metadata}->'resourceRef') = 'object'`,
      sql`${issueWorkProducts.metadata}->'resourceRef'->>'kind' = 'workspace_file'`,
      sql`${issueWorkProducts.metadata}->'resourceRef'->>'issueId' = ${issueId}`,
      sql`${issueWorkProducts.metadata}->'resourceRef'->>'workspaceKind' in ('execution_workspace', 'project_workspace')`,
      sql`${issueWorkProducts.metadata}->'resourceRef'->>'relativePath' ~ '[^[:space:]]'`,
      sql`${issueWorkProducts.metadata}->'resourceRef'->>'displayPath' ~ '[^[:space:]]'`,
      sql`case
        when ${issueWorkProducts.metadata}->'resourceRef'->>'workspaceId' ~* ${UUID_SQL_PATTERN}
        then (
          (
            ${issueWorkProducts.metadata}->'resourceRef'->>'workspaceKind' = 'execution_workspace'
            and exists (
              select 1
              from execution_workspaces durable_execution_workspace
              where durable_execution_workspace.id = (${issueWorkProducts.metadata}->'resourceRef'->>'workspaceId')::uuid
                and durable_execution_workspace.company_id = ${issueWorkProducts.companyId}
                and durable_execution_workspace.source_issue_id = ${issueWorkProducts.issueId}
            )
          )
          or (
            ${issueWorkProducts.metadata}->'resourceRef'->>'workspaceKind' = 'project_workspace'
            and exists (
              select 1
              from project_workspaces durable_project_workspace
              where durable_project_workspace.id = (${issueWorkProducts.metadata}->'resourceRef'->>'workspaceId')::uuid
                and durable_project_workspace.company_id = ${issueWorkProducts.companyId}
            )
          )
        )
        else false
      end`,
    )!,
    sql`case
      when ${issueWorkProducts.metadata}->>'attachmentId' ~* ${UUID_SQL_PATTERN}
      then exists (
        select 1
        from issue_attachments durable_attachment
        where durable_attachment.id = (${issueWorkProducts.metadata}->>'attachmentId')::uuid
          and durable_attachment.company_id = ${issueWorkProducts.companyId}
          and durable_attachment.issue_id = ${issueWorkProducts.issueId}
          and ${issueWorkProducts.metadata}->>'contentPath' = '/api/attachments/' || durable_attachment.id::text || '/content'
          and ${issueWorkProducts.metadata}->>'openPath' = '/api/attachments/' || durable_attachment.id::text || '/content'
          and ${issueWorkProducts.metadata}->>'downloadPath' = '/api/attachments/' || durable_attachment.id::text || '/content?download=1'
      )
      else false
    end`,
    sql`case
      when ${issueWorkProducts.metadata}->>'documentId' ~* ${UUID_SQL_PATTERN}
      then exists (
        select 1
        from issue_documents durable_issue_document
        inner join documents durable_document
          on durable_document.id = durable_issue_document.document_id
        inner join document_revisions durable_revision
          on durable_revision.id = durable_document.latest_revision_id
        where durable_document.id = (${issueWorkProducts.metadata}->>'documentId')::uuid
          and durable_issue_document.company_id = ${issueWorkProducts.companyId}
          and durable_issue_document.issue_id = ${issueWorkProducts.issueId}
          and durable_issue_document.key not in (${DONE_GATE_NON_QUALIFYING_DOCUMENT_KEY_SQL_LIST})
          and (durable_document.source_trust is null or durable_document.source_trust->>'disposition' = 'promoted')
          and durable_revision.created_by_run_id is not null
          and durable_revision.body ~ '[^[:space:]]'
      )
      else false
    end`,
    sql`exists (
      select 1
      from issue_documents durable_issue_document
      inner join documents durable_document
        on durable_document.id = durable_issue_document.document_id
      inner join document_revisions durable_revision
        on durable_revision.id = durable_document.latest_revision_id
      where durable_issue_document.company_id = ${issueWorkProducts.companyId}
        and durable_issue_document.issue_id = ${issueWorkProducts.issueId}
        and durable_issue_document.key = ${issueWorkProducts.metadata}->>'documentKey'
        and durable_issue_document.key not in (${DONE_GATE_NON_QUALIFYING_DOCUMENT_KEY_SQL_LIST})
        and (durable_document.source_trust is null or durable_document.source_trust->>'disposition' = 'promoted')
        and durable_revision.created_by_run_id is not null
        and durable_revision.body ~ '[^[:space:]]'
    )`,
  )!;
}

/**
 * Document keys that must NOT satisfy the done gate.
 *
 * `plan` is authored at the START of the work, so accepting it would let every
 * issue that was ever planned self-certify completion — the plan is a statement
 * of intent, not a deliverable. The system keys are scaffolding the platform
 * writes on the agent's behalf (`continuation-summary` is emitted automatically
 * when a run hands off), so neither is evidence the agent produced anything.
 */
const DONE_GATE_NON_QUALIFYING_DOCUMENT_KEYS: readonly string[] = [
  ...SYSTEM_ISSUE_DOCUMENT_KEYS,
  "plan",
];
const DONE_GATE_NON_QUALIFYING_DOCUMENT_KEY_SQL_LIST = sql.join(
  DONE_GATE_NON_QUALIFYING_DOCUMENT_KEYS.map((key) => sql`${key}`),
  sql`, `,
);

/**
 * Does this issue carry a durable artifact that a real run produced? (BLO-19081)
 *
 * See the docblock in `done-gate.ts` for why this exists and why it is not a
 * hole in the gate. Two qualifying shapes, both requiring run attribution:
 *
 *  - an issue document (excluding plan/system keys) whose latest revision has a
 *    non-empty body, is stamped `createdByRunId`, and is trusted or promoted;
 *  - an active, trusted-or-promoted, inspectable `artifact`/`document` work
 *    product stamped `createdByRunId`.
 *
 * `createdByRunId` is validated against the authenticated actor's run context in
 * the route layer, so an agent cannot attribute evidence to another run.
 *
 * Call this LAZILY — only when the cheaper gate checks have already decided to
 * block — so the common update path pays no extra query.
 */
async function fetchDurableArtifactEvidence(dbOrTx: any, issueId: string, companyId: string): Promise<boolean> {
  const [documentRows, workProductRows] = await Promise.all([
    dbOrTx
      .select({ key: issueDocuments.key })
      .from(issueDocuments)
      .innerJoin(documents, eq(issueDocuments.documentId, documents.id))
      .innerJoin(documentRevisions, eq(documentRevisions.id, documents.latestRevisionId))
      .where(
        and(
          eq(issueDocuments.companyId, companyId),
          eq(issueDocuments.issueId, issueId),
          notInArray(issueDocuments.key, [...DONE_GATE_NON_QUALIFYING_DOCUMENT_KEYS]),
          hasTrustedOrPromotedSourceTrust(documents.sourceTrust),
          isNotNull(documentRevisions.createdByRunId),
          // Must contain at least one non-whitespace character. A body of
          // spaces, tabs or newlines is as empty as `''` and would otherwise
          // be the cheapest way to satisfy the gate with no deliverable.
          // NOT `length(trim(...)) > 0` — Postgres `trim`/`btrim` strips only
          // SPACES by default, so "\n\t" survives it and passes. Deliberately
          // not a minimum length beyond blank either: an arbitrary threshold
          // invites padding, and the substantive check is a reviewer opening
          // the artifact.
          sql`${documentRevisions.body} ~ '[^[:space:]]'`,
        ),
      )
      .limit(1)
      .for("update", { of: [issueDocuments, documents] }),
    dbOrTx
      .select({ id: issueWorkProducts.id })
      .from(issueWorkProducts)
      .where(
        and(
          eq(issueWorkProducts.companyId, companyId),
          eq(issueWorkProducts.issueId, issueId),
          inArray(issueWorkProducts.type, [...DURABLE_ARTIFACT_WORK_PRODUCT_TYPES]),
          eq(issueWorkProducts.status, "active"),
          hasTrustedOrPromotedSourceTrust(issueWorkProducts.sourceTrust),
          isNotNull(issueWorkProducts.createdByRunId),
          hasInspectableWorkProductLocator(issueId),
        ),
      )
      .limit(1)
      .for("update"),
  ]);
  return documentRows.length > 0 || workProductRows.length > 0;
}

/**
 * Evidence-gate fetcher (BLO-4824 / BLO-4461). Loads the data the pure
 * evaluator needs: issue labels, the 10 most-recent comments, any recent
 * operator overrides, and any work_products. Caller supplies the description
 * (already on the existing row in the PATCH handler, no need to re-select).
 *
 * `effectiveLabelNames` overrides the labels read from the DB. A PATCH may
 * carry `labelIds` alongside the status change, and `syncIssueLabels` only runs
 * later inside the update transaction — so the stored rows are the PRE-patch
 * labels and evaluating against them applies the wrong policy. (BLO-19047)
 */
async function fetchEvidenceForIssue(
  dbOrTx: any,
  issueId: string,
  description: string | null,
  previousDescription: string | null = description,
  now: Date = new Date(),
  effectiveLabelNames: Array<{ name: string }> | null = null,
): Promise<EvidenceFetchResult> {
  const [recentComments, operatorOverrideComments, workProductRows, labelsByIssueId, descriptionHistory] = await Promise.all([
    dbOrTx
      .select({
        body: issueComments.body,
        authorAgentId: issueComments.authorAgentId,
        authorUserId: issueComments.authorUserId,
        createdAt: issueComments.createdAt,
      })
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId))
      .orderBy(desc(issueComments.createdAt))
      .limit(10),
    dbOrTx
      .select({
        body: issueComments.body,
        authorAgentId: issueComments.authorAgentId,
        authorUserId: issueComments.authorUserId,
        createdAt: issueComments.createdAt,
      })
      .from(issueComments)
      .where(and(
        eq(issueComments.issueId, issueId),
        isNotNull(issueComments.authorUserId),
        isNull(issueComments.authorAgentId),
        like(issueComments.body, "evidence-gate: override %"),
        gte(issueComments.createdAt, new Date(now.getTime() - 60 * 60 * 1000)),
        lte(issueComments.createdAt, now),
      ))
      .orderBy(desc(issueComments.createdAt)),
    dbOrTx
      .select({
        type: issueWorkProducts.type,
        metadata: issueWorkProducts.metadata,
        status: issueWorkProducts.status,
      })
      .from(issueWorkProducts)
      .where(eq(issueWorkProducts.issueId, issueId)),
    labelMapForIssues(dbOrTx, [issueId]),
    dbOrTx
      .select({ description: sql<string | null>`${activityLog.details}->'_previous'->>'description'` })
      .from(activityLog)
      .where(and(
        eq(activityLog.entityType, "issue"),
        eq(activityLog.entityId, issueId),
        eq(activityLog.action, "issue.updated"),
        sql`${activityLog.details}->'_previous' ? 'description'`,
      ))
      .orderBy(desc(activityLog.createdAt), desc(activityLog.id))
      .limit(EVIDENCE_DESCRIPTION_HISTORY_LIMIT),
  ]);

  const issueLabels = labelsByIssueId.get(issueId) ?? [];
  const hadPriorDoneWhenBullets = [
    previousDescription,
    ...descriptionHistory.map((row: { description: string | null }) => row.description),
  ].some((priorDescription) => countDoneWhenBullets(priorDescription ?? "") > 0);
  return {
    description,
    doneWhenBulletsRemoved:
      countDoneWhenBullets(description ?? "") === 0 && hadPriorDoneWhenBullets,
    labels: effectiveLabelNames ?? issueLabels.map((l: { name: string }) => ({ name: l.name })),
    comments: recentComments as EvidenceFetchResult["comments"],
    operatorOverrideComments: operatorOverrideComments as EvidenceFetchResult["operatorOverrideComments"],
    workProducts: workProductRows as EvidenceFetchResult["workProducts"],
  };
}

async function watchdogMapForIssues(dbOrTx: any, rows: IssueRow[]): Promise<Map<string, IssueWatchdogSummary>> {
  const map = new Map<string, IssueWatchdogSummary>();
  if (rows.length === 0) return map;
  const byCompany = new Map<string, string[]>();
  for (const row of rows) {
    const ids = byCompany.get(row.companyId) ?? [];
    ids.push(row.id);
    byCompany.set(row.companyId, ids);
  }
  for (const [companyId, issueIds] of byCompany.entries()) {
    for (const issueIdChunk of chunkList([...new Set(issueIds)], ISSUE_LIST_RELATED_QUERY_CHUNK_SIZE)) {
      const watchdogRows = await dbOrTx
        .select()
        .from(issueWatchdogs)
        .where(and(
          eq(issueWatchdogs.companyId, companyId),
          inArray(issueWatchdogs.issueId, issueIdChunk),
          eq(issueWatchdogs.status, "active"),
        ));
      for (const row of watchdogRows) {
        map.set(row.issueId, summarizeIssueWatchdog(row));
      }
    }
  }
  return map;
}

const ACTIVE_RUN_STATUSES = ["queued", "running"];
const BLOCKER_ATTENTION_ACTIVE_RUN_STATUSES = ["queued", "running"];
const BLOCKER_ATTENTION_ACTIVE_WAKE_STATUSES = ["queued", "deferred_issue_execution"];
const BLOCKER_ATTENTION_PENDING_INTERACTION_STATUSES = ["pending"];
const BLOCKER_ATTENTION_PENDING_APPROVAL_STATUSES = ["pending", "revision_requested"];
const BLOCKER_ATTENTION_OPEN_RECOVERY_ORIGIN_KIND = "harness_liveness_escalation";
const BLOCKER_ATTENTION_CHILD_TERMINAL_STATUSES = ["done", "cancelled"];
const PRODUCTIVITY_REVIEW_ORIGIN_KIND = "issue_productivity_review";
// Excluded from the "all children terminal?" check that gates parent wakes:
// these originKinds are system-generated by the harness itself (productivity
// reviews, liveness escalations, stranded-issue recoveries, stale active-run
// evaluations). Counting them as work-children causes false-positive parent
// wakes — see PCL-2418.
const SYSTEM_HARNESS_CHILD_ORIGIN_KINDS: string[] = [
  PRODUCTIVITY_REVIEW_ORIGIN_KIND,
  BLOCKER_ATTENTION_OPEN_RECOVERY_ORIGIN_KIND,
  "stranded_issue_recovery",
  "stale_active_run_evaluation",
];
const PRODUCTIVITY_REVIEW_TERMINAL_STATUSES = ["done", "cancelled"];
const PRODUCTIVITY_REVIEW_ACTIVITY_ACTIONS = [
  "issue.productivity_review_created",
  "issue.productivity_review_source_mutation",
  "issue.productivity_review_updated",
];
const PRODUCTIVITY_REVIEW_TRIGGERS: readonly IssueProductivityReviewTrigger[] = [
  "no_comment_streak",
  "long_active_duration",
  "high_churn",
];

function lowTrustBoundaryIssueCondition(
  companyId: string,
  boundary: (LowTrustBoundary & { companyId: string }) | null | undefined,
) {
  if (!boundary || boundary.companyId !== companyId) return null;
  const clauses: SQL[] = [];
  const issueIds = [...new Set(boundary.issueIds ?? [])];
  const projectIds = [...new Set(boundary.projectIds ?? [])];
  if (issueIds.length > 0) clauses.push(inArray(issues.id, issueIds));
  if (projectIds.length > 0) clauses.push(inArray(issues.projectId, projectIds));
  if (boundary.rootIssueId) {
    clauses.push(sql<boolean>`
      ${issues.id} IN (
        WITH RECURSIVE descendants(id) AS (
          SELECT ${issues.id}
          FROM ${issues}
          WHERE ${issues.companyId} = ${companyId}
            AND ${issues.id} = ${boundary.rootIssueId}
          UNION
          SELECT ${issues.id}
          FROM ${issues}
          JOIN descendants ON ${issues.parentId} = descendants.id
          WHERE ${issues.companyId} = ${companyId}
        )
        SELECT id FROM descendants
      )
    `);
  }
  if (clauses.length === 0) return sql<boolean>`false`;
  return or(...clauses);
}

const BLOCKER_ATTENTION_OPEN_RECOVERY_TERMINAL_STATUSES = ["done", "cancelled"];
const BLOCKER_ATTENTION_MAX_DEPTH = 8;
const BLOCKER_ATTENTION_MAX_NODES = 2000;
const BLOCKER_ATTENTION_INVOKABLE_AGENT_STATUSES = new Set(["active", "idle", "running", "error"]);

type IssueBlockerAttentionNode = {
  id: string;
  companyId: string;
  parentId: string | null;
  identifier: string | null;
  title: string;
  status: string;
  executionRunId?: string | null;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  monitorNextCheckAt?: Date | null;
  monitorAttemptCount?: number | null;
  executionPolicy?: unknown;
};
type IssueBlockerAttentionInputNode =
  Pick<
    IssueBlockerAttentionNode,
    "id" | "companyId" | "parentId" | "identifier" | "title" | "status" | "assigneeAgentId" | "assigneeUserId"
  >
  & { executionRunId?: string | null };

type IssueBlockerAttentionEdge = {
  issueId: string;
  blockerIssueId: string;
};
type IssueBlockerAttentionQueryRow = IssueBlockerAttentionNode & {
  issueId: string | null;
  blockerIssueId: string;
};
type IssueBlockerAttentionActivePathRow = {
  issueId: string | null;
};
type IssueBlockerAttentionAgentRow = {
  id: string;
  companyId: string;
  status: string;
};

function activeRunMapKey(companyId: string, runId: string) {
  return `${companyId}:${runId}`;
}

async function activeRunMapForIssues(
  dbOrTx: any,
  issueRows: Array<Pick<IssueRow, "companyId" | "executionRunId">>,
): Promise<Map<string, IssueActiveRunRow>> {
  const map = new Map<string, IssueActiveRunRow>();
  const runIds = issueRows
    .map((row) => row.executionRunId)
    .filter((id): id is string => id != null);
  if (runIds.length === 0) return map;
  const companyIds = [...new Set(issueRows.map((row) => row.companyId))];

  for (const runIdChunk of chunkList([...new Set(runIds)], ISSUE_LIST_RELATED_QUERY_CHUNK_SIZE)) {
    const rows = await dbOrTx
      .select({
        id: heartbeatRuns.id,
        companyId: heartbeatRuns.companyId,
        status: heartbeatRuns.status,
        agentId: heartbeatRuns.agentId,
        invocationSource: heartbeatRuns.invocationSource,
        triggerDetail: heartbeatRuns.triggerDetail,
        startedAt: heartbeatRuns.startedAt,
        finishedAt: heartbeatRuns.finishedAt,
        createdAt: heartbeatRuns.createdAt,
        lastOutputAt: heartbeatRuns.lastOutputAt,
        lastUsefulActionAt: heartbeatRuns.lastUsefulActionAt,
      })
      .from(heartbeatRuns)
      .where(
        and(
          inArray(heartbeatRuns.id, runIdChunk),
          inArray(heartbeatRuns.companyId, companyIds),
          inArray(heartbeatRuns.status, ACTIVE_RUN_STATUSES),
        ),
      );

    for (const row of rows) {
      const { companyId, ...activeRun } = row;
      map.set(activeRunMapKey(companyId, row.id), activeRun);
    }
  }
  return map;
}

async function liveDescendantCountMapForIssues(
  dbOrTx: any,
  companyId: string,
  issueIds: string[],
): Promise<Map<string, number>> {
  const uniqueIssueIds = [...new Set(issueIds)];
  const map = new Map<string, number>();
  if (uniqueIssueIds.length === 0) return map;

  for (const issueIdChunk of chunkList(uniqueIssueIds, ISSUE_LIST_RELATED_QUERY_CHUNK_SIZE)) {
    const targetRows = issueIdChunk.map((issueId) => sql`(${issueId}::uuid)`);
    const rows = await dbOrTx.execute(sql<{
      issueId: string;
      liveDescendantCount: number;
    }>`
      WITH RECURSIVE
        target_issues(issue_id) AS (
          VALUES ${sql.join(targetRows, sql`, `)}
        ),
        live_issues(live_issue_id, parent_id) AS (
          SELECT DISTINCT live_issue.id, live_issue.parent_id
          FROM issues live_issue
          JOIN heartbeat_runs live_run ON live_run.id = live_issue.execution_run_id
          WHERE live_issue.company_id = ${companyId}
            AND live_issue.hidden_at IS NULL
            AND live_issue.harness_kind IS NULL
            AND live_run.company_id = ${companyId}
            AND live_run.status IN ('queued', 'running')
          UNION
          SELECT DISTINCT live_issue.id, live_issue.parent_id
          FROM heartbeat_runs live_run
          JOIN issues live_issue ON live_issue.id::text = (live_run.context_snapshot ->> 'issueId')
          WHERE live_issue.company_id = ${companyId}
            AND live_issue.hidden_at IS NULL
            AND live_issue.harness_kind IS NULL
            AND live_run.company_id = ${companyId}
            AND live_run.status IN ('queued', 'running')
        ),
        live_ancestors(live_issue_id, ancestor_id, next_parent_id, visited_issue_ids) AS (
          SELECT live_issues.live_issue_id, parent.id, parent.parent_id, ARRAY[live_issues.live_issue_id, parent.id]
          FROM live_issues
          JOIN issues parent ON parent.id = live_issues.parent_id
          WHERE parent.company_id = ${companyId}
            AND parent.hidden_at IS NULL
            AND parent.harness_kind IS NULL
          UNION ALL
          SELECT
            live_ancestors.live_issue_id,
            parent.id,
            parent.parent_id,
            live_ancestors.visited_issue_ids || parent.id
          FROM live_ancestors
          JOIN issues parent ON parent.id = live_ancestors.next_parent_id
          WHERE parent.company_id = ${companyId}
            AND parent.hidden_at IS NULL
            AND parent.harness_kind IS NULL
            AND NOT parent.id = ANY(live_ancestors.visited_issue_ids)
        )
      SELECT
        live_ancestors.ancestor_id::text AS "issueId",
        count(DISTINCT live_ancestors.live_issue_id)::int AS "liveDescendantCount"
      FROM live_ancestors
      JOIN target_issues ON target_issues.issue_id = live_ancestors.ancestor_id
      WHERE live_ancestors.ancestor_id <> live_ancestors.live_issue_id
      GROUP BY live_ancestors.ancestor_id
    `);

    const resultRows = Array.isArray(rows) ? rows : Array.from(rows as Iterable<unknown>);
    for (const row of resultRows) {
      if (typeof row !== "object" || row === null) continue;
      const issueId = (row as { issueId?: unknown }).issueId;
      const liveDescendantCount = (row as { liveDescendantCount?: unknown }).liveDescendantCount;
      if (typeof issueId !== "string") continue;
      const count = typeof liveDescendantCount === "number"
        ? liveDescendantCount
        : Number(liveDescendantCount);
      if (Number.isFinite(count)) map.set(issueId, count);
    }
  }

  return map;
}

function createIssueBlockerAttention(input: Partial<IssueBlockerAttention> = {}): IssueBlockerAttention {
  return {
    state: input.state ?? "none",
    reason: input.reason ?? null,
    unresolvedBlockerCount: input.unresolvedBlockerCount ?? 0,
    coveredBlockerCount: input.coveredBlockerCount ?? 0,
    stalledBlockerCount: input.stalledBlockerCount ?? 0,
    attentionBlockerCount: input.attentionBlockerCount ?? 0,
    sampleBlockerIdentifier: input.sampleBlockerIdentifier ?? null,
    sampleStalledBlockerIdentifier: input.sampleStalledBlockerIdentifier ?? null,
  };
}

function blockerSampleIdentifier(node: IssueBlockerAttentionNode | null | undefined) {
  return node?.identifier ?? node?.id ?? null;
}

function appendBlockerAttentionEdges(
  edgesByIssueId: Map<string, IssueBlockerAttentionEdge[]>,
  rows: IssueBlockerAttentionEdge[],
) {
  for (const row of rows) {
    const existing = edgesByIssueId.get(row.issueId) ?? [];
    if (!existing.some((edge) => edge.blockerIssueId === row.blockerIssueId)) {
      existing.push(row);
      edgesByIssueId.set(row.issueId, existing);
    }
  }
}

type IssueRelationSummaryRow = {
  relatedId: string;
  identifier: string | null;
  title: string;
  status: string;
  priority: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
};

function summarizeIssueRelationRow(row: IssueRelationSummaryRow): IssueRelationIssueSummary {
  return {
    id: row.relatedId,
    identifier: row.identifier,
    title: row.title,
    status: row.status as IssueRelationIssueSummary["status"],
    priority: row.priority as IssueRelationIssueSummary["priority"],
    assigneeAgentId: row.assigneeAgentId,
    assigneeUserId: row.assigneeUserId,
  };
}

async function terminalExplicitBlockersByRoot(
  companyId: string,
  roots: IssueRelationIssueSummary[],
  dbOrTx: DbReader,
): Promise<Map<string, IssueRelationIssueSummary[]>> {
  const rootIds = [...new Set(roots.map((root) => root.id))];
  const terminalByRoot = new Map<string, IssueRelationIssueSummary[]>();
  if (rootIds.length === 0) return terminalByRoot;

  const nodesById = new Map<string, IssueRelationIssueSummary>();
  const edgesByIssueId = new Map<string, string[]>();
  for (const root of roots) nodesById.set(root.id, root);

  let frontier = rootIds;
  for (let depth = 0; frontier.length > 0 && depth < BLOCKER_ATTENTION_MAX_DEPTH; depth += 1) {
    const nextFrontier = new Set<string>();
    for (const chunk of chunkList([...new Set(frontier)], ISSUE_LIST_RELATED_QUERY_CHUNK_SIZE)) {
      const rows = await dbOrTx
        .select({
          currentIssueId: issueRelations.relatedIssueId,
          relatedId: issues.id,
          identifier: issues.identifier,
          title: issues.title,
          status: issues.status,
          priority: issues.priority,
          assigneeAgentId: issues.assigneeAgentId,
          assigneeUserId: issues.assigneeUserId,
        })
        .from(issueRelations)
        .innerJoin(issues, eq(issueRelations.issueId, issues.id))
        .where(
          and(
            eq(issueRelations.companyId, companyId),
            eq(issueRelations.type, "blocks"),
            inArray(issueRelations.relatedIssueId, chunk),
            eq(issues.companyId, companyId),
            ne(issues.status, "done"),
          ),
        );

      for (const row of rows) {
        const existingEdges = edgesByIssueId.get(row.currentIssueId) ?? [];
        if (!existingEdges.includes(row.relatedId)) {
          existingEdges.push(row.relatedId);
          edgesByIssueId.set(row.currentIssueId, existingEdges);
        }
        if (!nodesById.has(row.relatedId)) {
          nodesById.set(row.relatedId, summarizeIssueRelationRow(row));
          nextFrontier.add(row.relatedId);
        }
      }
    }

    if (nodesById.size > BLOCKER_ATTENTION_MAX_NODES) break;
    frontier = [...nextFrontier];
  }

  const collectTerminal = (issueId: string, seen: Set<string>): IssueRelationIssueSummary[] => {
    if (seen.has(issueId)) return [];
    const node = nodesById.get(issueId);
    if (!node || node.status === "done") return [];
    const nextSeen = new Set(seen);
    nextSeen.add(issueId);
    const downstreamIds = edgesByIssueId.get(issueId) ?? [];
    if (downstreamIds.length === 0) return [node];
    return downstreamIds.flatMap((downstreamId) => collectTerminal(downstreamId, nextSeen));
  };

  for (const rootId of rootIds) {
    const deduped = new Map<string, IssueRelationIssueSummary>();
    for (const blocker of collectTerminal(rootId, new Set())) {
      if (blocker.id !== rootId) deduped.set(blocker.id, blocker);
    }
    if (deduped.size > 0) {
      terminalByRoot.set(rootId, [...deduped.values()].sort((a, b) => a.title.localeCompare(b.title)));
    }
  }

  return terminalByRoot;
}

function readProductivityReviewTrigger(value: unknown): IssueProductivityReviewTrigger | null {
  if (typeof value !== "string") return null;
  return PRODUCTIVITY_REVIEW_TRIGGERS.includes(value as IssueProductivityReviewTrigger)
    ? (value as IssueProductivityReviewTrigger)
    : null;
}

function readProductivityReviewStreak(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.floor(value);
}

async function listIssueProductivityReviewMap(
  dbOrTx: any,
  companyId: string,
  sourceIssueIds: string[],
): Promise<Map<string, IssueProductivityReview>> {
  const map = new Map<string, IssueProductivityReview>();
  if (sourceIssueIds.length === 0) return map;

  const reviewRows: Array<{
    sourceIssueId: string | null;
    reviewIssueId: string;
    reviewIdentifier: string | null;
    status: string;
    priority: string;
    createdAt: Date;
    updatedAt: Date;
  }> = [];
  for (const chunk of chunkList([...new Set(sourceIssueIds)], ISSUE_LIST_RELATED_QUERY_CHUNK_SIZE)) {
    const rows = await dbOrTx
      .select({
        sourceIssueId: issues.originId,
        reviewIssueId: issues.id,
        reviewIdentifier: issues.identifier,
        status: issues.status,
        priority: issues.priority,
        createdAt: issues.createdAt,
        updatedAt: issues.updatedAt,
      })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, PRODUCTIVITY_REVIEW_ORIGIN_KIND),
          inArray(issues.originId, chunk),
          visibleIssueCondition(),
          notInArray(issues.status, PRODUCTIVITY_REVIEW_TERMINAL_STATUSES),
        ),
      )
      .orderBy(desc(issues.createdAt), desc(issues.id));
    reviewRows.push(...rows);
  }

  if (reviewRows.length === 0) return map;

  const reviewIssueIds = reviewRows.map((row) => row.reviewIssueId);
  const triggerByReviewIssueId = new Map<
    string,
    { trigger: IssueProductivityReviewTrigger | null; noCommentStreak: number | null }
  >();
  for (const chunk of chunkList(reviewIssueIds, ISSUE_LIST_RELATED_QUERY_CHUNK_SIZE)) {
    const detailRows = await dbOrTx
      .select({
        entityId: activityLog.entityId,
        details: activityLog.details,
        createdAt: activityLog.createdAt,
      })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.companyId, companyId),
          eq(activityLog.entityType, "issue"),
          inArray(activityLog.entityId, chunk),
          inArray(activityLog.action, PRODUCTIVITY_REVIEW_ACTIVITY_ACTIONS),
        ),
      )
      .orderBy(desc(activityLog.createdAt));
    for (const row of detailRows as Array<{
      entityId: string;
      details: Record<string, unknown> | null;
      createdAt: Date;
    }>) {
      if (triggerByReviewIssueId.has(row.entityId)) continue;
      triggerByReviewIssueId.set(row.entityId, {
        trigger: readProductivityReviewTrigger(row.details?.trigger),
        noCommentStreak: readProductivityReviewStreak(row.details?.noCommentStreak),
      });
    }
  }

  for (const row of reviewRows) {
    if (!row.sourceIssueId) continue;
    if (map.has(row.sourceIssueId)) continue;
    const detail = triggerByReviewIssueId.get(row.reviewIssueId);
    map.set(row.sourceIssueId, {
      reviewIssueId: row.reviewIssueId,
      reviewIdentifier: row.reviewIdentifier,
      status: row.status as IssueProductivityReview["status"],
      priority: row.priority as IssueProductivityReview["priority"],
      trigger: detail?.trigger ?? null,
      noCommentStreak: detail?.noCommentStreak ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  }

  return map;
}

function hasValidBlockerMonitor(node: Pick<IssueBlockerAttentionNode, "monitorNextCheckAt" | "monitorAttemptCount" | "executionPolicy">): boolean {
  const nextCheckAt = node.monitorNextCheckAt;
  if (!nextCheckAt) return false;
  const nextCheckAtMs = nextCheckAt instanceof Date ? nextCheckAt.getTime() : new Date(nextCheckAt).getTime();
  if (Number.isNaN(nextCheckAtMs) || nextCheckAtMs <= Date.now()) return false;

  const policy = node.executionPolicy as Record<string, unknown> | null | undefined;
  const policyMonitor = policy?.monitor as Record<string, unknown> | null | undefined;

  const timeoutAtRaw = policyMonitor?.timeoutAt;
  if (timeoutAtRaw != null) {
    const timeoutAtMs = new Date(timeoutAtRaw as string | Date).getTime();
    if (!Number.isNaN(timeoutAtMs) && timeoutAtMs <= Date.now()) return false;
  }

  const maxAttempts = typeof policyMonitor?.maxAttempts === "number" && policyMonitor.maxAttempts > 0
    ? policyMonitor.maxAttempts
    : null;
  if (maxAttempts !== null) {
    const attemptCount = node.monitorAttemptCount ?? 0;
    if (attemptCount >= maxAttempts) return false;
  }

  return true;
}

async function listIssueBlockerAttentionMap(
  dbOrTx: any,
  companyId: string,
  issueRows: IssueBlockerAttentionInputNode[],
): Promise<Map<string, IssueBlockerAttention>> {
  const companyIssueRows = issueRows.filter((row) => row.companyId === companyId);
  const dependencyReadinessMap = await listIssueDependencyReadinessMap(
    dbOrTx,
    companyId,
    companyIssueRows.map((row) => row.id),
  );
  const roots = companyIssueRows.filter((row) =>
    !BLOCKER_ATTENTION_CHILD_TERMINAL_STATUSES.includes(row.status) &&
    (row.status === "blocked" || (dependencyReadinessMap.get(row.id)?.unresolvedBlockerCount ?? 0) > 0),
  );
  const rootIds = new Set(roots.map((root) => root.id));
  const attentionMap = new Map<string, IssueBlockerAttention>();
  for (const row of issueRows) {
    if (!rootIds.has(row.id)) {
      attentionMap.set(row.id, createIssueBlockerAttention());
    }
  }
  if (roots.length === 0) return attentionMap;

  const nodesById = new Map<string, IssueBlockerAttentionNode>();
  const edgesByIssueId = new Map<string, IssueBlockerAttentionEdge[]>();
  for (const root of roots) nodesById.set(root.id, { ...root });

  // Query the union of each breadth-first layer once, but retain independent
  // visited sets and truncation state for every root. This keeps the batched
  // query shape without letting one oversized graph invalidate unrelated
  // roots in the same list page.
  const nodeIdsByRoot = new Map(roots.map((root) => [root.id, new Set([root.id])]));
  const queriedNodeIds = new Set<string>();
  const truncatedRootIds = new Set<string>();
  let frontierByRoot = new Map(roots.map((root) => [root.id, new Set([root.id])]));
  for (let depth = 0; frontierByRoot.size > 0 && depth < BLOCKER_ATTENTION_MAX_DEPTH; depth += 1) {
    const frontier = [...new Set([...frontierByRoot.values()].flatMap((nodeIds) => [...nodeIds]))].filter(
      (nodeId) => !queriedNodeIds.has(nodeId),
    );

    for (const chunk of chunkList(frontier, ISSUE_LIST_RELATED_QUERY_CHUNK_SIZE)) {
      const explicitBlockerRowsPromise: Promise<IssueBlockerAttentionQueryRow[]> = dbOrTx
        .select({
          issueId: issueRelations.relatedIssueId,
          blockerIssueId: issues.id,
          id: issues.id,
          companyId: issues.companyId,
          parentId: issues.parentId,
          identifier: issues.identifier,
          title: issues.title,
          status: issues.status,
          executionRunId: issues.executionRunId,
          assigneeAgentId: issues.assigneeAgentId,
          assigneeUserId: issues.assigneeUserId,
          monitorNextCheckAt: issues.monitorNextCheckAt,
          monitorAttemptCount: issues.monitorAttemptCount,
          executionPolicy: issues.executionPolicy,
        })
        .from(issueRelations)
        .innerJoin(issues, eq(issueRelations.issueId, issues.id))
        .where(
          and(
            eq(issueRelations.companyId, companyId),
            eq(issueRelations.type, "blocks"),
            inArray(issueRelations.relatedIssueId, chunk),
            eq(issues.companyId, companyId),
            ne(issues.status, "done"),
          ),
        );
      const childRowsPromise: Promise<IssueBlockerAttentionQueryRow[]> = dbOrTx
        .select({
          issueId: issues.parentId,
          blockerIssueId: issues.id,
          id: issues.id,
          companyId: issues.companyId,
          parentId: issues.parentId,
          identifier: issues.identifier,
          title: issues.title,
          status: issues.status,
          executionRunId: issues.executionRunId,
          assigneeAgentId: issues.assigneeAgentId,
          assigneeUserId: issues.assigneeUserId,
          monitorNextCheckAt: issues.monitorNextCheckAt,
          monitorAttemptCount: issues.monitorAttemptCount,
          executionPolicy: issues.executionPolicy,
        })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, companyId),
            inArray(issues.parentId, chunk),
            notInArray(issues.status, BLOCKER_ATTENTION_CHILD_TERMINAL_STATUSES),
          ),
        );
      const [explicitBlockerRows, childRows] = await Promise.all([
        explicitBlockerRowsPromise,
        childRowsPromise,
      ]);
      for (const nodeId of chunk) queriedNodeIds.add(nodeId);

      appendBlockerAttentionEdges(edgesByIssueId, [
        ...explicitBlockerRows
          .filter((row): row is IssueBlockerAttentionQueryRow & { issueId: string } => row.issueId !== null)
          .map((row) => ({ issueId: row.issueId, blockerIssueId: row.blockerIssueId })),
        ...childRows
          .filter((row): row is IssueBlockerAttentionQueryRow & { issueId: string } => row.issueId !== null)
          .map((row) => ({ issueId: row.issueId, blockerIssueId: row.blockerIssueId })),
      ]);

      for (const row of [...explicitBlockerRows, ...childRows]) {
        if (!row.issueId || nodesById.has(row.blockerIssueId)) continue;
        nodesById.set(row.blockerIssueId, {
          id: row.blockerIssueId,
          companyId: row.companyId,
          parentId: row.parentId,
          identifier: row.identifier,
          title: row.title,
          status: row.status,
          executionRunId: row.executionRunId,
          assigneeAgentId: row.assigneeAgentId,
          assigneeUserId: row.assigneeUserId,
          monitorNextCheckAt: row.monitorNextCheckAt,
          monitorAttemptCount: row.monitorAttemptCount,
          executionPolicy: row.executionPolicy,
        });
      }
    }

    const nextFrontierByRoot = new Map<string, Set<string>>();
    for (const [rootId, rootFrontier] of frontierByRoot) {
      const rootNodeIds = nodeIdsByRoot.get(rootId)!;
      const nextRootFrontier = new Set<string>();
      let rootTruncated = false;
      for (const nodeId of rootFrontier) {
        for (const edge of edgesByIssueId.get(nodeId) ?? []) {
          if (rootNodeIds.has(edge.blockerIssueId)) continue;
          rootNodeIds.add(edge.blockerIssueId);
          if (rootNodeIds.size > BLOCKER_ATTENTION_MAX_NODES) {
            truncatedRootIds.add(rootId);
            rootTruncated = true;
            break;
          }
          nextRootFrontier.add(edge.blockerIssueId);
        }
        if (rootTruncated) break;
      }
      if (!rootTruncated && nextRootFrontier.size > 0) {
        nextFrontierByRoot.set(rootId, nextRootFrontier);
      }
    }
    frontierByRoot = nextFrontierByRoot;
  }
  // Depth-limit boundary (documented design tradeoff, not a classification bug).
  // The loop above queries hop-distances 0..MAX_DEPTH-1 fully but only *discovers*
  // the MAX_DEPTH layer — it never loads those nodes' edges. Any root still
  // holding distance-MAX_DEPTH nodes in its frontier is conservatively marked
  // truncated -> needs_attention, even when such a node is a terminating leaf
  // that would otherwise classify as covered. This is safe-direction (surfaces to
  // a human rather than hiding) and deterministic; it cannot cause the batched
  // whole-page false-positive the per-root tracking fixed. If MAX_DEPTH is meant
  // to be an inclusive hop bound (chains exactly MAX_DEPTH deep must classify
  // fully), query the discovered final layer instead — and apply the same change
  // to the single-root twin `terminalExplicitBlockersByRoot`, which shares this
  // discover-but-don't-query last layer.
  for (const rootId of frontierByRoot.keys()) truncatedRootIds.add(rootId);

  const nodeIds = [...nodesById.keys()];
  const activeIssueIds = new Set<string>();
  const agentIds = new Set<string>();
  const issueIdByExecutionRunId = new Map<string, string>();
  for (const node of nodesById.values()) {
    if (node.assigneeAgentId) agentIds.add(node.assigneeAgentId);
    if (node.executionRunId) issueIdByExecutionRunId.set(node.executionRunId, node.id);
  }

  for (const chunk of chunkList([...issueIdByExecutionRunId.keys()], ISSUE_LIST_RELATED_QUERY_CHUNK_SIZE)) {
    const runRows: Array<{ id: string }> = await dbOrTx
      .select({
        id: heartbeatRuns.id,
      })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          inArray(heartbeatRuns.status, BLOCKER_ATTENTION_ACTIVE_RUN_STATUSES),
          inArray(heartbeatRuns.id, chunk),
        ),
      );

    for (const row of runRows) {
      const issueId = issueIdByExecutionRunId.get(row.id);
      if (issueId) activeIssueIds.add(issueId);
    }
  }

  for (const chunk of chunkList(nodeIds, ISSUE_LIST_RELATED_QUERY_CHUNK_SIZE)) {
    const wakeRowsPromise: Promise<IssueBlockerAttentionActivePathRow[]> = dbOrTx
      .select({
        issueId: sql<string | null>`${agentWakeupRequests.payload} ->> 'issueId'`,
      })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, companyId),
          inArray(agentWakeupRequests.status, BLOCKER_ATTENTION_ACTIVE_WAKE_STATUSES),
          sql`${agentWakeupRequests.runId} is null`,
          inArray(sql<string>`${agentWakeupRequests.payload} ->> 'issueId'`, chunk),
        ),
      );
    const wakeRows = await wakeRowsPromise;
    for (const row of wakeRows) {
      if (row.issueId) activeIssueIds.add(row.issueId);
    }
  }

  const explicitWaitCandidateIds = [...nodesById.values()]
    .filter((node) => node.status !== "done")
    .map((node) => node.id);
  const explicitWaitingIssueIds = new Set<string>();
  if (explicitWaitCandidateIds.length > 0) {
    for (const chunk of chunkList(explicitWaitCandidateIds, ISSUE_LIST_RELATED_QUERY_CHUNK_SIZE)) {
      const interactionRows: Array<{ issueId: string }> = await dbOrTx
        .select({ issueId: issueThreadInteractions.issueId })
        .from(issueThreadInteractions)
        .where(
          and(
            eq(issueThreadInteractions.companyId, companyId),
            inArray(issueThreadInteractions.status, BLOCKER_ATTENTION_PENDING_INTERACTION_STATUSES),
            inArray(issueThreadInteractions.issueId, chunk),
          ),
        );
      for (const row of interactionRows) explicitWaitingIssueIds.add(row.issueId);

      const approvalRows: Array<{ issueId: string }> = await dbOrTx
        .select({ issueId: issueApprovals.issueId })
        .from(issueApprovals)
        .innerJoin(approvals, eq(issueApprovals.approvalId, approvals.id))
        .where(
          and(
            eq(issueApprovals.companyId, companyId),
            inArray(approvals.status, BLOCKER_ATTENTION_PENDING_APPROVAL_STATUSES),
            inArray(issueApprovals.issueId, chunk),
          ),
        );
      for (const row of approvalRows) explicitWaitingIssueIds.add(row.issueId);
    }

    // Recovery rows are intentionally company-wide: a liveness escalation for
    // the same leaf blocker represents an active waiting path even when that
    // blocker is reached through another blocked graph.
    const recoveryRows: Array<{ id: string; originId: string | null }> = await dbOrTx
      .select({ id: issues.id, originId: issues.originId })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, BLOCKER_ATTENTION_OPEN_RECOVERY_ORIGIN_KIND),
          visibleIssueCondition(),
          notInArray(issues.status, BLOCKER_ATTENTION_OPEN_RECOVERY_TERMINAL_STATUSES),
        ),
      );
    for (const row of recoveryRows) {
      const parsed = parseIssueGraphLivenessIncidentKey(row.originId);
      if (!parsed || parsed.companyId !== companyId) continue;
      explicitWaitingIssueIds.add(row.id);
      explicitWaitingIssueIds.add(parsed.issueId);
      explicitWaitingIssueIds.add(parsed.leafIssueId);
    }

    const recoveryActionRows: Array<{ sourceIssueId: string }> = await dbOrTx
      .select({ sourceIssueId: issueRecoveryActions.sourceIssueId })
      .from(issueRecoveryActions)
      .where(
        and(
          eq(issueRecoveryActions.companyId, companyId),
          inArray(issueRecoveryActions.status, ["active", "escalated"]),
          inArray(issueRecoveryActions.sourceIssueId, explicitWaitCandidateIds),
        ),
      );
    for (const row of recoveryActionRows) explicitWaitingIssueIds.add(row.sourceIssueId);
  }

  const agentRows: IssueBlockerAttentionAgentRow[] = agentIds.size > 0
    ? await dbOrTx
        .select({
          id: agents.id,
          companyId: agents.companyId,
          status: agents.status,
        })
        .from(agents)
        .where(and(eq(agents.companyId, companyId), inArray(agents.id, [...agentIds])))
    : [];
  const agentsById = new Map(agentRows.map((agent) => [agent.id, agent]));

  type PathClassification = {
    covered: boolean;
    stalled: boolean;
    sampleBlockerIdentifier: string | null;
    sampleStalledBlockerIdentifier: string | null;
  };
  const classifyPath = (
    nodeId: string,
    seen: Set<string>,
    rootNodeIds: Set<string>,
    rootTraversalTruncated: boolean,
  ): PathClassification => {
    const sample = blockerSampleIdentifier(nodesById.get(nodeId));
    if (rootTraversalTruncated || !rootNodeIds.has(nodeId) || seen.has(nodeId)) {
      return { covered: false, stalled: false, sampleBlockerIdentifier: sample, sampleStalledBlockerIdentifier: null };
    }
    const node = nodesById.get(nodeId);
    if (!node || node.companyId !== companyId) {
      return { covered: false, stalled: false, sampleBlockerIdentifier: nodeId, sampleStalledBlockerIdentifier: null };
    }
    const nodeSample = blockerSampleIdentifier(node);
    if (node.status === "done") {
      return { covered: true, stalled: false, sampleBlockerIdentifier: nodeSample, sampleStalledBlockerIdentifier: null };
    }
    if (explicitWaitingIssueIds.has(node.id)) {
      return { covered: true, stalled: false, sampleBlockerIdentifier: nodeSample, sampleStalledBlockerIdentifier: null };
    }
    if (node.assigneeUserId && node.status !== "cancelled") {
      return { covered: true, stalled: false, sampleBlockerIdentifier: nodeSample, sampleStalledBlockerIdentifier: null };
    }
    if (node.status === "in_review") {
      const hasWaitingPath = activeIssueIds.has(node.id) || Boolean(node.assigneeUserId) || hasValidBlockerMonitor(node);
      if (hasWaitingPath) {
        return { covered: true, stalled: false, sampleBlockerIdentifier: nodeSample, sampleStalledBlockerIdentifier: null };
      }
      return { covered: false, stalled: true, sampleBlockerIdentifier: nodeSample, sampleStalledBlockerIdentifier: nodeSample };
    }
    if (activeIssueIds.has(node.id)) {
      return { covered: true, stalled: false, sampleBlockerIdentifier: nodeSample, sampleStalledBlockerIdentifier: null };
    }
    if (node.status === "cancelled") {
      return { covered: false, stalled: false, sampleBlockerIdentifier: nodeSample, sampleStalledBlockerIdentifier: null };
    }
    if (node.status === "backlog" && node.assigneeAgentId) {
      return { covered: false, stalled: false, sampleBlockerIdentifier: nodeSample, sampleStalledBlockerIdentifier: null };
    }

    const downstream = (edgesByIssueId.get(node.id) ?? []).filter((edge) => nodesById.get(edge.blockerIssueId)?.status !== "done");
    if (downstream.length > 0) {
      const nextSeen = new Set(seen);
      nextSeen.add(nodeId);
      const classified = downstream.map((edge) =>
        classifyPath(edge.blockerIssueId, nextSeen, rootNodeIds, rootTraversalTruncated),
      );
      const stalledChild = classified.find((result) => result.stalled || result.sampleStalledBlockerIdentifier);
      const sampleStalled = stalledChild?.sampleStalledBlockerIdentifier ?? null;
      const hardAttention = classified.find((result) => !result.covered && !result.stalled);
      if (hardAttention) {
        return {
          covered: false,
          stalled: false,
          sampleBlockerIdentifier: hardAttention.sampleBlockerIdentifier,
          sampleStalledBlockerIdentifier: sampleStalled,
        };
      }
      const stalledEntry = classified.find((result) => result.stalled);
      if (stalledEntry) {
        return {
          covered: false,
          stalled: true,
          sampleBlockerIdentifier: stalledEntry.sampleBlockerIdentifier,
          sampleStalledBlockerIdentifier: sampleStalled,
        };
      }
      return {
        covered: true,
        stalled: false,
        sampleBlockerIdentifier: classified[0]?.sampleBlockerIdentifier ?? nodeSample,
        sampleStalledBlockerIdentifier: null,
      };
    }

    if (node.assigneeAgentId) {
      const assignee = agentsById.get(node.assigneeAgentId);
      if (!assignee || assignee.companyId !== companyId || !BLOCKER_ATTENTION_INVOKABLE_AGENT_STATUSES.has(assignee.status)) {
        return { covered: false, stalled: false, sampleBlockerIdentifier: nodeSample, sampleStalledBlockerIdentifier: null };
      }
    }

    return { covered: false, stalled: false, sampleBlockerIdentifier: nodeSample, sampleStalledBlockerIdentifier: null };
  };

  for (const root of roots) {
    const rootNodeIds = nodeIdsByRoot.get(root.id) ?? new Set([root.id]);
    const rootTraversalTruncated = truncatedRootIds.has(root.id);
    const dependencyReadiness = dependencyReadinessMap.get(root.id);
    const unresolvedBlockerIssueIds = new Set(
      dependencyReadiness?.unresolvedBlockerIssueIds ?? [],
    );
    const pendingFinalizeBlockerCount = new Set(
      dependencyReadiness?.pendingFinalizeBlockerIssueIds ?? [],
    ).size;
    const topLevelEdges = (edgesByIssueId.get(root.id) ?? []).filter((edge) => {
      if (unresolvedBlockerIssueIds.has(edge.blockerIssueId)) return true;
      const blockerNode = nodesById.get(edge.blockerIssueId);
      return (
        blockerNode?.parentId === root.id &&
        !BLOCKER_ATTENTION_CHILD_TERMINAL_STATUSES.includes(blockerNode.status)
      );
    });
    if (topLevelEdges.length === 0) {
      if (pendingFinalizeBlockerCount > 0) {
        attentionMap.set(root.id, createIssueBlockerAttention({
          state: "covered",
          reason: "active_dependency",
          unresolvedBlockerCount: pendingFinalizeBlockerCount,
          coveredBlockerCount: pendingFinalizeBlockerCount,
        }));
        continue;
      }
      attentionMap.set(root.id, createIssueBlockerAttention({
        state: "needs_attention",
        reason: "attention_required",
      }));
      continue;
    }

    const classified = topLevelEdges.map((edge) => ({
      edge,
      result: classifyPath(edge.blockerIssueId, new Set([root.id]), rootNodeIds, rootTraversalTruncated),
    }));
    const classifiedCoveredBlockerCount = classified.filter((entry) => entry.result.covered).length;
    const coveredBlockerCount = classifiedCoveredBlockerCount + pendingFinalizeBlockerCount;
    const stalledBlockerCount = classified.filter((entry) => entry.result.stalled).length;
    const attentionBlockerCount = classified.length - classifiedCoveredBlockerCount - stalledBlockerCount;
    const hardAttentionEntry = classified.find((entry) => !entry.result.covered && !entry.result.stalled);
    const stalledEntry = classified.find((entry) => entry.result.stalled);
    const sampleEntry = hardAttentionEntry ?? stalledEntry ?? classified[0] ?? null;
    const sampleNode = sampleEntry ? nodesById.get(sampleEntry.edge.blockerIssueId) : null;
    const sampleStalledFromChain = classified
      .map((entry) => entry.result.sampleStalledBlockerIdentifier)
      .find((value) => value);

    let state: IssueBlockerAttention["state"];
    let reason: IssueBlockerAttention["reason"];
    if (attentionBlockerCount > 0) {
      state = "needs_attention";
      reason = "attention_required";
    } else if (stalledBlockerCount > 0) {
      state = "stalled";
      reason = "stalled_review";
    } else {
      state = "covered";
      reason = pendingFinalizeBlockerCount === 0 &&
        topLevelEdges.every((edge) => nodesById.get(edge.blockerIssueId)?.parentId === root.id)
        ? "active_child"
        : "active_dependency";
    }

    attentionMap.set(root.id, createIssueBlockerAttention({
      state,
      reason,
      unresolvedBlockerCount: topLevelEdges.length + pendingFinalizeBlockerCount,
      coveredBlockerCount,
      stalledBlockerCount,
      attentionBlockerCount,
      sampleBlockerIdentifier: sampleEntry?.result.sampleBlockerIdentifier ?? blockerSampleIdentifier(sampleNode),
      sampleStalledBlockerIdentifier:
        stalledEntry?.result.sampleStalledBlockerIdentifier ?? sampleStalledFromChain ?? null,
    }));
  }

  return attentionMap;
}

const issueListSelect = {
  id: issues.id,
  companyId: issues.companyId,
  projectId: issues.projectId,
  projectWorkspaceId: issues.projectWorkspaceId,
  goalId: issues.goalId,
  milestoneId: issues.milestoneId,
  targetDate: issues.targetDate,
  parentId: issues.parentId,
  title: issues.title,
  // Slice the description prefix server-side to bound payload size. Using
  // `substring(text, 1, n)` (not `convert_to(...)+substring`) is what makes
  // this fast on TOAST'd rows: PG can fetch only the first ~n*encoding-max
  // bytes via heap_tuple_untoast_attr_slice and decompress just enough pglz
  // chunks to satisfy them. The earlier convert_to-based approach forced a
  // full detoast on every list row (eBPF profile showed pglz_decompress at
  // ~14% of pg CPU under list load with 66% of issues > 2KB description).
  description: sql<string | null>`substring(${issues.description}, 1, ${ISSUE_LIST_DESCRIPTION_MAX_CHARS})`,
  status: issues.status,
  workMode: issues.workMode,
  harnessKind: issues.harnessKind,
  priority: issues.priority,
  estimate: issues.estimate,
  assigneeAgentId: issues.assigneeAgentId,
  assigneeUserId: issues.assigneeUserId,
  checkoutRunId: issues.checkoutRunId,
  executionRunId: issues.executionRunId,
  executionAgentNameKey: issues.executionAgentNameKey,
  executionLockedAt: issues.executionLockedAt,
  createdByAgentId: issues.createdByAgentId,
  createdByUserId: issues.createdByUserId,
  responsibleUserId: issues.responsibleUserId,
  issueNumber: issues.issueNumber,
  identifier: issues.identifier,
  legacyIdentifier: issues.legacyIdentifier,
  originKind: issues.originKind,
  originId: issues.originId,
  originRunId: issues.originRunId,
  originFingerprint: issues.originFingerprint,
  requestDepth: issues.requestDepth,
  billingCode: issues.billingCode,
  assigneeAdapterOverrides: issues.assigneeAdapterOverrides,
  executionPolicy: sql<null>`null`,
  executionState: sql<null>`null`,
  monitorNextCheckAt: issues.monitorNextCheckAt,
  monitorWakeRequestedAt: issues.monitorWakeRequestedAt,
  monitorLastTriggeredAt: issues.monitorLastTriggeredAt,
  monitorAttemptCount: issues.monitorAttemptCount,
  monitorNotes: issues.monitorNotes,
  monitorScheduledBy: issues.monitorScheduledBy,
  executionWorkspaceId: issues.executionWorkspaceId,
  executionWorkspacePreference: issues.executionWorkspacePreference,
  executionWorkspaceSettings: sql<null>`null`,
  sourceTrust: issues.sourceTrust,
  startedAt: issues.startedAt,
  completedAt: issues.completedAt,
  cancelledAt: issues.cancelledAt,
  hiddenAt: issues.hiddenAt,
  createdAt: issues.createdAt,
  updatedAt: issues.updatedAt,
  lastActivityAt: issues.lastActivityAt,
  // Evidence-gate verdict (BLO-4824). Returned but typically not rendered
  // in the list view — useful for sorting/filtering issues that have a
  // recorded verdict.
  lastEvidenceVerdict: issues.lastEvidenceVerdict,
  lastEvidenceVerdictEvaluatedAt: issues.lastEvidenceVerdictEvaluatedAt,
};

function withActiveRuns(
  issueRows: IssueWithLabels[],
  runMap: Map<string, IssueActiveRunRow>,
): IssueWithLabelsAndRun[] {
  return issueRows.map((row) => ({
    ...row,
    activeRun: row.executionRunId ? (runMap.get(activeRunMapKey(row.companyId, row.executionRunId)) ?? null) : null,
  }));
}

async function userCommentStatsForIssues(
  dbOrTx: any,
  companyId: string,
  userId: string,
  issueIds: string[],
): Promise<IssueUserCommentStats[]> {
  const stats: IssueUserCommentStats[] = [];
  for (const issueIdChunk of chunkList(issueIds, ISSUE_LIST_RELATED_QUERY_CHUNK_SIZE)) {
    const rows = await dbOrTx
      .select({
        issueId: issueComments.issueId,
        myLastCommentAt: sql<Date | null>`
          MAX(CASE WHEN ${issueComments.authorUserId} = ${userId} THEN ${issueComments.createdAt} END)
        `,
        lastExternalCommentAt: sql<Date | null>`
          MAX(
            CASE
              WHEN ${issueComments.authorUserId} IS NULL OR ${issueComments.authorUserId} <> ${userId}
              THEN ${issueComments.createdAt}
            END
          )
        `,
      })
      .from(issueComments)
      .where(
        and(
          eq(issueComments.companyId, companyId),
          inArray(issueComments.issueId, issueIdChunk),
        ),
      )
      .groupBy(issueComments.issueId);
    stats.push(...rows);
  }
  return stats;
}

async function userReadStatsForIssues(
  dbOrTx: any,
  companyId: string,
  userId: string,
  issueIds: string[],
): Promise<IssueReadStat[]> {
  const stats: IssueReadStat[] = [];
  for (const issueIdChunk of chunkList(issueIds, ISSUE_LIST_RELATED_QUERY_CHUNK_SIZE)) {
    const rows = await dbOrTx
      .select({
        issueId: issueReadStates.issueId,
        myLastReadAt: issueReadStates.lastReadAt,
      })
      .from(issueReadStates)
      .where(
        and(
          eq(issueReadStates.companyId, companyId),
          eq(issueReadStates.userId, userId),
          inArray(issueReadStates.issueId, issueIdChunk),
        ),
      );
    stats.push(...rows);
  }
  return stats;
}

async function lastActivityStatsForIssues(
  dbOrTx: any,
  companyId: string,
  issueIds: string[],
): Promise<IssueLastActivityStat[]> {
  const byIssueId = new Map<string, IssueLastActivityStat>();
  for (const issueIdChunk of chunkList(issueIds, ISSUE_LIST_RELATED_QUERY_CHUNK_SIZE)) {
    const [commentRows, logRows] = await Promise.all([
      dbOrTx
        .select({
          issueId: issueComments.issueId,
          latestCommentAt: sql<Date | null>`MAX(${issueComments.createdAt})`,
        })
        .from(issueComments)
        .where(
          and(
            eq(issueComments.companyId, companyId),
            inArray(issueComments.issueId, issueIdChunk),
          ),
        )
        .groupBy(issueComments.issueId),
      dbOrTx
        .select({
          issueId: activityLog.entityId,
          latestLogAt: sql<Date | null>`MAX(${activityLog.createdAt})`,
        })
        .from(activityLog)
        .where(
          and(
            eq(activityLog.companyId, companyId),
            eq(activityLog.entityType, "issue"),
            inArray(activityLog.entityId, issueIdChunk),
            sql`${activityLog.action} NOT IN (${sql.join(
              ISSUE_LOCAL_INBOX_ACTIVITY_ACTIONS.map((action) => sql`${action}`),
              sql`, `,
            )})`,
          ),
        )
        .groupBy(activityLog.entityId),
    ]);

    for (const row of commentRows) {
      byIssueId.set(row.issueId, {
        issueId: row.issueId,
        latestCommentAt: row.latestCommentAt,
        latestLogAt: null,
      });
    }
    for (const row of logRows) {
      const existing = byIssueId.get(row.issueId);
      if (existing) existing.latestLogAt = row.latestLogAt;
      else {
        byIssueId.set(row.issueId, {
          issueId: row.issueId,
          latestCommentAt: null,
          latestLogAt: row.latestLogAt,
        });
      }
    }
  }
  return [...byIssueId.values()];
}

async function blockedByMapForIssues(
  dbOrTx: any,
  companyId: string,
  issueIds: string[],
): Promise<Map<string, IssueRelationIssueSummary[]>> {
  const map = new Map<string, IssueRelationIssueSummary[]>();
  const uniqueIssueIds = [...new Set(issueIds)];
  if (uniqueIssueIds.length === 0) return map;

  for (const issueId of uniqueIssueIds) {
    map.set(issueId, []);
  }

  for (const issueIdChunk of chunkList(uniqueIssueIds, ISSUE_LIST_RELATED_QUERY_CHUNK_SIZE)) {
    const rows = await dbOrTx
      .select({
        currentIssueId: issueRelations.relatedIssueId,
        relatedId: issues.id,
        identifier: issues.identifier,
        title: issues.title,
        status: issues.status,
        priority: issues.priority,
        assigneeAgentId: issues.assigneeAgentId,
        assigneeUserId: issues.assigneeUserId,
      })
      .from(issueRelations)
      .innerJoin(issues, eq(issueRelations.issueId, issues.id))
      .where(
        and(
          eq(issueRelations.companyId, companyId),
          eq(issueRelations.type, "blocks"),
          inArray(issueRelations.relatedIssueId, issueIdChunk),
        ),
      );

    for (const row of rows) {
      const blockedBy = map.get(row.currentIssueId);
      if (!blockedBy) continue;
      blockedBy.push({
        id: row.relatedId,
        identifier: row.identifier,
        title: row.title,
        status: row.status as IssueRelationIssueSummary["status"],
        priority: row.priority as IssueRelationIssueSummary["priority"],
        assigneeAgentId: row.assigneeAgentId,
        assigneeUserId: row.assigneeUserId,
      });
    }
  }

  for (const blockedBy of map.values()) {
    blockedBy.sort((a, b) => a.title.localeCompare(b.title));
  }

  return map;
}

export const EXECUTIVE_AGENT_ROLES_FOR_HOLDS = new Set(["ceo", "cto"]);

const EXECUTIVE_HOLD_MARKER_REGEX =
  /do\s+not\s+retry\s+before\s+(\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?(?:\s+(?:UTC|GMT))?)/i;

export function parseExecutiveHoldMarkerTimestamp(raw: string): Date | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const direct = /Z$|[+-]\d{2}:?\d{2}$/.test(trimmed) ? new Date(trimmed) : null;
  if (direct && !Number.isNaN(direct.getTime())) return direct;
  const looseMatch = trimmed.match(
    /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)\s*(?:UTC|GMT)?$/i,
  );
  if (looseMatch) {
    const time = looseMatch[2].length === 5 ? `${looseMatch[2]}:00` : looseMatch[2];
    const date = new Date(`${looseMatch[1]}T${time}Z`);
    if (!Number.isNaN(date.getTime())) return date;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const date = new Date(`${trimmed}T00:00:00Z`);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return null;
}

export function extractExecutiveHoldMarker(body: string | null | undefined): Date | null {
  if (!body) return null;
  const match = body.match(EXECUTIVE_HOLD_MARKER_REGEX);
  if (!match) return null;
  return parseExecutiveHoldMarkerTimestamp(match[1]);
}

export function findActiveExecutiveHold(
  comments: Array<{
    id: string;
    body: string | null;
    createdAt: Date;
    authorRole: string | null;
  }>,
  now: Date = new Date(),
): { until: Date; commentId: string } | null {
  const sorted = [...comments].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  for (const comment of sorted) {
    if (!comment.authorRole || !EXECUTIVE_AGENT_ROLES_FOR_HOLDS.has(comment.authorRole)) continue;
    const until = extractExecutiveHoldMarker(comment.body);
    if (!until) continue;
    return until.getTime() > now.getTime()
      ? { until, commentId: comment.id }
      : null;
  }
  return null;
}

const BLOCKED_INBOX_TERMINAL_STATUSES = ["done", "cancelled"] as const;
const BLOCKED_INBOX_ACTIVE_RUN_STATUSES = ["queued", "running"] as const;
const BLOCKED_INBOX_ACTIVE_WAKE_STATUSES = SUCCESSFUL_RUN_HANDOFF_LIVE_WAKE_STATUSES;
const BLOCKED_INBOX_PENDING_INTERACTION_STATUSES = ["pending"] as const;
const BLOCKED_INBOX_PENDING_APPROVAL_STATUSES = ["pending", "revision_requested"] as const;
const BLOCKED_INBOX_RECOVERY_ORIGIN_KINDS = [
  RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation,
  RECOVERY_ORIGIN_KINDS.issueProductivityReview,
  RECOVERY_ORIGIN_KINDS.strandedIssueRecovery,
] as const;
const BLOCKED_INBOX_SUCCESSFUL_RUN_HANDOFF_ACTIONS = [
  "issue.successful_run_handoff_required",
  "issue.successful_run_handoff_resolved",
  "issue.successful_run_handoff_escalated",
] as const;

type BlockedInboxIssueRow = IssueRow & { labels?: IssueLabelRow[]; labelIds?: string[] };
type BlockedInboxInteractionRow = {
  id: string;
  issueId: string;
  kind: string;
  createdAt: Date;
};
type BlockedInboxApprovalRow = {
  approvalId: string;
  issueId: string;
  createdAt: Date;
};

function issueRef(row: Pick<IssueRow, "id" | "identifier" | "title" | "status" | "priority" | "assigneeAgentId" | "assigneeUserId"> | null | undefined): IssueBlockedInboxIssueRef | null {
  if (!row) return null;
  return {
    id: row.id,
    identifier: row.identifier,
    title: row.title,
    status: row.status as IssueBlockedInboxIssueRef["status"],
    priority: row.priority as IssueBlockedInboxIssueRef["priority"],
    assigneeAgentId: row.assigneeAgentId,
    assigneeUserId: row.assigneeUserId,
  };
}

function hasPlanDocumentCondition(companyId: string, hasPlanDocument: boolean): SQL {
  const existsPlanDocument = sql<boolean>`
    EXISTS (
      SELECT 1
      FROM ${issueDocuments}
      WHERE ${issueDocuments.companyId} = ${companyId}
        AND ${issueDocuments.issueId} = ${issues.id}
        AND ${issueDocuments.key} = 'plan'
    )
  `;
  return hasPlanDocument ? existsPlanDocument : sql<boolean>`NOT ${existsPlanDocument}`;
}

function isoDate(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function attentionBase(input: {
  state: IssueBlockedInboxAttention["state"];
  reason: IssueBlockedInboxAttention["reason"];
  severity: IssueBlockedInboxAttention["severity"];
  stoppedSinceAt: Date | string | null | undefined;
  owner: IssueBlockedInboxAttention["owner"];
  action: IssueBlockedInboxAttention["action"];
  sourceIssue: IssueBlockedInboxIssueRef | null;
  leafIssue?: IssueBlockedInboxIssueRef | null;
  recoveryIssue?: IssueBlockedInboxIssueRef | null;
  approvalId?: string | null;
  interactionId?: string | null;
  sampleIssueIdentifier?: string | null;
  externalDetailsRedacted?: boolean;
}): IssueBlockedInboxAttention {
  return {
    kind: "blocked",
    state: input.state,
    reason: input.reason,
    severity: input.severity,
    stoppedSinceAt: isoDate(input.stoppedSinceAt),
    owner: input.owner,
    action: input.action,
    sourceIssue: input.sourceIssue,
    leafIssue: input.leafIssue ?? null,
    recoveryIssue: input.recoveryIssue ?? null,
    approvalId: input.approvalId ?? null,
    interactionId: input.interactionId ?? null,
    sampleIssueIdentifier:
      input.sampleIssueIdentifier
      ?? input.leafIssue?.identifier
      ?? input.recoveryIssue?.identifier
      ?? input.sourceIssue?.identifier
      ?? null,
    redaction: {
      externalDetailsRedacted: input.externalDetailsRedacted ?? false,
      secretFieldsOmitted: true,
    },
  };
}

function readSuccessfulRunHandoffFromActivity(row: {
  action: string;
  agentId: string | null;
  runId: string | null;
  details: Record<string, unknown> | null;
  createdAt: Date;
}): SuccessfulRunHandoffState | null {
  const details = row.details ?? {};
  const state =
    row.action === "issue.successful_run_handoff_required"
      ? "required"
      : row.action === "issue.successful_run_handoff_resolved"
        ? "resolved"
        : row.action === "issue.successful_run_handoff_escalated"
          ? "escalated"
          : null;
  if (!state) return null;

  const detectedProgressSummary =
    readStringFromRecord(details, "detectedProgressSummary")
    ?? readStringFromRecord(details, "detected_progress_summary")
    ?? null;

  return {
    state,
    required: state === "required",
    hasLiveContinuation: false,
    sourceRunId:
      readStringFromRecord(details, "sourceRunId")
      ?? readStringFromRecord(details, "source_run_id")
      ?? readStringFromRecord(details, "resumeFromRunId")
      ?? row.runId
      ?? null,
    correctiveRunId:
      readStringFromRecord(details, "correctiveRunId")
      ?? readStringFromRecord(details, "corrective_run_id")
      ?? (state !== "required" ? row.runId : null),
    assigneeAgentId:
      readStringFromRecord(details, "assigneeAgentId")
      ?? readStringFromRecord(details, "agentId")
      ?? row.agentId
      ?? null,
    detectedProgressSummary: detectedProgressSummary ? redactSensitiveText(detectedProgressSummary) : null,
    createdAt: row.createdAt,
  };
}

async function listSuccessfulRunHandoffMapForIssues(
  dbOrTx: any,
  companyId: string,
  issueIds: string[],
  options?: { hydrateLiveness?: boolean },
): Promise<Map<string, SuccessfulRunHandoffState>> {
  const uniqueIssueIds = [...new Set(issueIds)];
  const states = new Map<string, SuccessfulRunHandoffState>();
  if (uniqueIssueIds.length === 0) return states;

  for (const issueIdChunk of chunkList(uniqueIssueIds, ISSUE_LIST_RELATED_QUERY_CHUNK_SIZE)) {
    const rows = await dbOrTx
      .select({
        entityId: activityLog.entityId,
        action: activityLog.action,
        agentId: activityLog.agentId,
        runId: activityLog.runId,
        details: activityLog.details,
        createdAt: activityLog.createdAt,
      })
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.entityType, "issue"),
        inArray(activityLog.entityId, issueIdChunk),
        inArray(activityLog.action, [...BLOCKED_INBOX_SUCCESSFUL_RUN_HANDOFF_ACTIONS]),
      ))
      .orderBy(activityLog.entityId, desc(activityLog.createdAt), desc(activityLog.id));

    for (const row of rows as Array<{
      entityId: string;
      action: string;
      agentId: string | null;
      runId: string | null;
      details: Record<string, unknown> | null;
      createdAt: Date;
    }>) {
      if (states.has(row.entityId)) continue;
      const state = readSuccessfulRunHandoffFromActivity(row);
      if (state) states.set(row.entityId, state);
    }
  }

  return options?.hydrateLiveness === false
    ? states
    : hydrateSuccessfulRunHandoffLiveness(dbOrTx, companyId, states);
}

function externalWaitFromDescription(description: string | null): { owner: string; action: string } | null {
  if (!description) return null;
  const owner = description.match(/^\s*external owner\s*:\s*(.+)$/im)?.[1]?.trim();
  const action = description.match(/^\s*external action\s*:\s*(.+)$/im)?.[1]?.trim();
  if (!owner || !action) return null;
  return {
    owner: owner.slice(0, 120),
    action: action.slice(0, 240),
  };
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function redactExternalWaitDescription(
  description: string | null | undefined,
  external: { owner: string; action: string } | null,
) {
  if (!description) return null;
  let redacted = description
    .split(/\r?\n/)
    .filter((line) => !/^\s*external\s+(?:owner|action)\s*:/i.test(line))
    .join("\n");

  for (const value of [external?.owner, external?.action]) {
    if (!value) continue;
    redacted = redacted.replace(new RegExp(escapeRegExp(value), "gi"), "[redacted external wait detail]");
  }

  redacted = redacted.replace(/\n{3,}/g, "\n\n").trim();
  return redacted.length > 0 ? redacted : null;
}

function blockedInboxResponseDescription(attention: IssueBlockedInboxAttention, row: BlockedInboxIssueRow) {
  if (!attention.redaction.externalDetailsRedacted) return row.description;
  return redactExternalWaitDescription(row.description, externalWaitFromDescription(row.description));
}

function blockedInboxSearchText(attention: IssueBlockedInboxAttention, row: BlockedInboxIssueRow) {
  return [
    row.identifier,
    row.title,
    blockedInboxResponseDescription(attention, row),
    attention.sourceIssue?.identifier,
    attention.sourceIssue?.title,
    attention.leafIssue?.identifier,
    attention.leafIssue?.title,
    attention.recoveryIssue?.identifier,
    attention.recoveryIssue?.title,
    attention.action.label,
    attention.action.detail,
  ]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" ")
    .toLowerCase();
}

function blockedInboxSeverityRank(severity: IssueBlockedInboxAttention["severity"]) {
  switch (severity) {
    case "critical":
      return 0;
    case "high":
      return 1;
    case "medium":
      return 2;
    case "low":
      return 3;
  }
}

function issuePriorityRank(priority: string) {
  switch (priority) {
    case "critical":
      return 0;
    case "high":
      return 1;
    case "medium":
      return 2;
    case "low":
      return 3;
    default:
      return 4;
  }
}

function compareBlockedInboxRows(
  left: BlockedInboxIssueRow & { blockedInboxAttention: IssueBlockedInboxAttention; lastActivityAt?: Date | null },
  right: BlockedInboxIssueRow & { blockedInboxAttention: IssueBlockedInboxAttention; lastActivityAt?: Date | null },
) {
  const leftAttention = left.blockedInboxAttention;
  const rightAttention = right.blockedInboxAttention;
  const severity = blockedInboxSeverityRank(leftAttention.severity)
    - blockedInboxSeverityRank(rightAttention.severity);
  if (severity !== 0) return severity;

  const leftStopped = leftAttention.stoppedSinceAt
    ? new Date(leftAttention.stoppedSinceAt).getTime()
    : Number.POSITIVE_INFINITY;
  const rightStopped = rightAttention.stoppedSinceAt
    ? new Date(rightAttention.stoppedSinceAt).getTime()
    : Number.POSITIVE_INFINITY;
  if (leftStopped !== rightStopped) return leftStopped - rightStopped;

  const priority = issuePriorityRank(left.priority) - issuePriorityRank(right.priority);
  if (priority !== 0) return priority;

  const leftActivity = left.lastActivityAt ? new Date(left.lastActivityAt).getTime() : new Date(left.updatedAt).getTime();
  const rightActivity = right.lastActivityAt ? new Date(right.lastActivityAt).getTime() : new Date(right.updatedAt).getTime();
  if (leftActivity !== rightActivity) return rightActivity - leftActivity;

  return right.id.localeCompare(left.id);
}

async function listIssueBlockedInboxAttentionMap(
  dbOrTx: any,
  companyId: string,
  issueRows: BlockedInboxIssueRow[],
): Promise<Map<string, IssueBlockedInboxAttention>> {
  const rowIssueIds = [...new Set(issueRows.map((row) => row.id))];
  const result = new Map<string, IssueBlockedInboxAttention>();
  if (rowIssueIds.length === 0) return result;

  const [graphIssueRows, graphRelationRows, companyAgentRows] = await Promise.all([
    dbOrTx
      .select()
      .from(issues)
      .where(and(
        eq(issues.companyId, companyId),
        visibleIssueCondition(),
        ne(issues.status, "done"),
      )),
    dbOrTx
      .select({
        companyId: issueRelations.companyId,
        blockerIssueId: issueRelations.issueId,
        blockedIssueId: issueRelations.relatedIssueId,
      })
      .from(issueRelations)
      .where(and(eq(issueRelations.companyId, companyId), eq(issueRelations.type, "blocks"))),
    dbOrTx
      .select({
        id: agents.id,
        companyId: agents.companyId,
        name: agents.name,
        role: agents.role,
        title: agents.title,
        status: agents.status,
        pauseReason: agents.pauseReason,
        runtimeConfig: agents.runtimeConfig,
        reportsTo: agents.reportsTo,
      })
      .from(agents)
      .where(eq(agents.companyId, companyId)),
  ]);

  const graphIssues = graphIssueRows as IssueRow[];
  const graphRelations = graphRelationRows as Array<{ companyId: string; blockerIssueId: string; blockedIssueId: string }>;
  const companyAgents = companyAgentRows as Array<{
    id: string;
    companyId: string;
    name: string;
    role: string;
    title: string | null;
    status: string;
    pauseReason: string | null;
    runtimeConfig: Record<string, unknown> | null;
    reportsTo: string | null;
  }>;
  const graphIssueIds = graphIssues.map((issue) => issue.id);
  const issuesById = new Map<string, IssueRow>(graphIssues.map((issue) => [issue.id, issue]));

  const [
    activeRunRows,
    wakeRows,
    scheduledRetryRows,
    interactionRows,
    approvalRows,
    handoffMap,
    blockerAttentionByIssueId,
  ] = await Promise.all([
    graphIssueIds.length === 0
      ? Promise.resolve([])
      : dbOrTx
          .select({
            companyId: heartbeatRuns.companyId,
            issueId: sql<string | null>`coalesce(
              ${heartbeatRuns.contextSnapshot} ->> 'issueId',
              ${heartbeatRuns.contextSnapshot} ->> 'taskId'
            )`,
            agentId: heartbeatRuns.agentId,
            status: heartbeatRuns.status,
          })
          .from(heartbeatRuns)
          .where(and(
            eq(heartbeatRuns.companyId, companyId),
            inArray(heartbeatRuns.status, [...BLOCKED_INBOX_ACTIVE_RUN_STATUSES]),
            inArray(sql<string>`coalesce(
              ${heartbeatRuns.contextSnapshot} ->> 'issueId',
              ${heartbeatRuns.contextSnapshot} ->> 'taskId'
            )`, graphIssueIds),
          )),
    graphIssueIds.length === 0
      ? Promise.resolve([])
      : dbOrTx
          .select({
            companyId: agentWakeupRequests.companyId,
            issueId: sql<string | null>`coalesce(
              ${agentWakeupRequests.payload} ->> 'issueId',
              ${agentWakeupRequests.payload} ->> 'taskId',
              ${agentWakeupRequests.payload} -> '_paperclipWakeContext' ->> 'issueId',
              ${agentWakeupRequests.payload} -> '_paperclipWakeContext' ->> 'taskId'
            )`,
            agentId: agentWakeupRequests.agentId,
            status: agentWakeupRequests.status,
          })
          .from(agentWakeupRequests)
          .where(and(
            eq(agentWakeupRequests.companyId, companyId),
            inArray(agentWakeupRequests.status, [...BLOCKED_INBOX_ACTIVE_WAKE_STATUSES]),
            inArray(sql<string>`coalesce(
              ${agentWakeupRequests.payload} ->> 'issueId',
              ${agentWakeupRequests.payload} ->> 'taskId',
              ${agentWakeupRequests.payload} -> '_paperclipWakeContext' ->> 'issueId',
              ${agentWakeupRequests.payload} -> '_paperclipWakeContext' ->> 'taskId'
            )`, graphIssueIds),
          )),
    graphIssueIds.length === 0
      ? Promise.resolve([])
      : dbOrTx
          .select({
            companyId: heartbeatRuns.companyId,
            issueId: sql<string | null>`coalesce(
              ${heartbeatRuns.contextSnapshot} ->> 'issueId',
              ${heartbeatRuns.contextSnapshot} ->> 'taskId'
            )`,
            agentId: heartbeatRuns.agentId,
            status: heartbeatRuns.status,
          })
          .from(heartbeatRuns)
          .where(and(
            eq(heartbeatRuns.companyId, companyId),
            eq(heartbeatRuns.status, "scheduled_retry"),
            inArray(sql<string>`coalesce(
              ${heartbeatRuns.contextSnapshot} ->> 'issueId',
              ${heartbeatRuns.contextSnapshot} ->> 'taskId'
            )`, graphIssueIds),
          )),
    graphIssueIds.length === 0
      ? Promise.resolve([])
      : dbOrTx
          .select({
            id: issueThreadInteractions.id,
            issueId: issueThreadInteractions.issueId,
            kind: issueThreadInteractions.kind,
            createdAt: issueThreadInteractions.createdAt,
          })
          .from(issueThreadInteractions)
          .where(and(
            eq(issueThreadInteractions.companyId, companyId),
            inArray(issueThreadInteractions.status, [...BLOCKED_INBOX_PENDING_INTERACTION_STATUSES]),
            inArray(issueThreadInteractions.issueId, graphIssueIds),
          )),
    graphIssueIds.length === 0
      ? Promise.resolve([])
      : dbOrTx
          .select({
            approvalId: approvals.id,
            issueId: issueApprovals.issueId,
            createdAt: approvals.createdAt,
          })
          .from(issueApprovals)
          .innerJoin(approvals, eq(issueApprovals.approvalId, approvals.id))
          .where(and(
            eq(issueApprovals.companyId, companyId),
            eq(approvals.companyId, companyId),
            inArray(approvals.status, [...BLOCKED_INBOX_PENDING_APPROVAL_STATUSES]),
            inArray(issueApprovals.issueId, graphIssueIds),
          )),
    listSuccessfulRunHandoffMapForIssues(dbOrTx, companyId, rowIssueIds, { hydrateLiveness: false }),
    // Resolve the union of blocked roots once. Calling this from the row loop
    // turns every blocked-inbox read into an N+1 graph traversal on companies
    // with a large stopped-work backlog.
    listIssueBlockerAttentionMap(dbOrTx, companyId, issueRows),
  ]);

  const pendingInteractions = (interactionRows as BlockedInboxInteractionRow[]).map((row) => ({
    companyId,
    issueId: row.issueId,
    status: "pending",
  }));
  const pendingApprovals = (approvalRows as BlockedInboxApprovalRow[]).map((row) => ({
    companyId,
    issueId: row.issueId,
    status: "pending",
  }));

  const openRecoveryIssues = graphIssues
    .filter((issue) => BLOCKED_INBOX_RECOVERY_ORIGIN_KINDS.includes(issue.originKind as typeof BLOCKED_INBOX_RECOVERY_ORIGIN_KINDS[number]))
    .filter((issue) => !BLOCKED_INBOX_TERMINAL_STATUSES.includes(issue.status as typeof BLOCKED_INBOX_TERMINAL_STATUSES[number]))
    .flatMap((issue) => {
      const entries = [{ companyId, issueId: issue.id, status: issue.status }];
      if (issue.originKind === RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation) {
        const parsed = parseIssueGraphLivenessIncidentKey(issue.originId);
        if (parsed?.companyId === companyId) {
          entries.push({ companyId, issueId: parsed.issueId, status: issue.status });
          entries.push({ companyId, issueId: parsed.leafIssueId, status: issue.status });
        }
      } else if (
        (issue.originKind === RECOVERY_ORIGIN_KINDS.issueProductivityReview ||
          issue.originKind === RECOVERY_ORIGIN_KINDS.strandedIssueRecovery) && issue.originId
      ) {
        entries.push({ companyId, issueId: issue.originId, status: issue.status });
      }
      return entries;
    });

  const findings = classifyIssueGraphLiveness({
    issues: graphIssues.map((issue) => ({
      id: issue.id,
      companyId: issue.companyId,
      identifier: issue.identifier,
      title: issue.title,
      status: issue.status,
      projectId: issue.projectId,
      goalId: issue.goalId,
      parentId: issue.parentId,
      assigneeAgentId: issue.assigneeAgentId,
      assigneeUserId: issue.assigneeUserId,
      createdByAgentId: issue.createdByAgentId,
      createdByUserId: issue.createdByUserId,
      executionPolicy: issue.executionPolicy,
      executionState: issue.executionState,
      monitorNextCheckAt: issue.monitorNextCheckAt,
      monitorAttemptCount: issue.monitorAttemptCount,
    })),
    relations: graphRelations,
    agents: companyAgents,
    activeRuns: (activeRunRows as Array<{ companyId: string; issueId: string | null; agentId: string | null; status: string }>)
      .flatMap((row) => row.issueId
        ? [{ companyId: row.companyId, issueId: row.issueId, agentId: row.agentId, status: row.status }]
        : []),
    queuedWakeRequests: [
      ...(wakeRows as Array<{ companyId: string; issueId: string | null; agentId: string | null; status: string }>),
      ...(scheduledRetryRows as Array<{ companyId: string; issueId: string | null; agentId: string | null; status: string }>),
    ]
      .flatMap((row) => row.issueId
        ? [{ companyId: row.companyId, issueId: row.issueId, agentId: row.agentId, status: row.status }]
        : []),
    pendingInteractions,
    pendingApprovals,
    openRecoveryIssues,
    now: new Date(),
  });
  const findingByIssueId = new Map<string, IssueLivenessFinding>();
  for (const finding of findings) {
    if (!findingByIssueId.has(finding.issueId)) findingByIssueId.set(finding.issueId, finding);
  }

  const interactionByIssueId = new Map<string, BlockedInboxInteractionRow>();
  for (const row of interactionRows as BlockedInboxInteractionRow[]) {
    if (!interactionByIssueId.has(row.issueId)) interactionByIssueId.set(row.issueId, row);
  }
  const approvalByIssueId = new Map<string, BlockedInboxApprovalRow>();
  for (const row of approvalRows as BlockedInboxApprovalRow[]) {
    if (!approvalByIssueId.has(row.issueId)) approvalByIssueId.set(row.issueId, row);
  }
  const liveHandoffRunIssueIds = new Set([
    ...(activeRunRows as Array<{ issueId: string | null }>),
    ...(scheduledRetryRows as Array<{ issueId: string | null }>),
  ].flatMap((row) => row.issueId ? [row.issueId] : []));
  const liveHandoffWakeIssueIds = new Set(
    (wakeRows as Array<{ issueId: string | null }>).flatMap((row) => row.issueId ? [row.issueId] : []),
  );

  for (const row of issueRows) {
    if (row.companyId !== companyId || BLOCKED_INBOX_TERMINAL_STATUSES.includes(row.status as typeof BLOCKED_INBOX_TERMINAL_STATUSES[number]) || row.hiddenAt) {
      continue;
    }
    const source = issueRef(row);
    const handoff = handoffMap.get(row.id);
    const hasLiveHandoffContinuation = Boolean(
      handoff?.state === "required"
      && (liveHandoffRunIssueIds.has(row.id) || liveHandoffWakeIssueIds.has(row.id))
    );
    if (handoff && !hasLiveHandoffContinuation && (handoff.required || handoff.state === "escalated")) {
      result.set(row.id, attentionBase({
        state: "missing_disposition",
        reason: "missing_successful_run_disposition",
        severity: "high",
        stoppedSinceAt: handoff.createdAt ?? row.updatedAt,
        owner: {
          type: row.assigneeAgentId ? "agent" : row.assigneeUserId ? "user" : "unknown",
          agentId: row.assigneeAgentId,
          userId: row.assigneeUserId,
          label: null,
        },
        action: {
          label: "Choose disposition",
          detail: "Choose exactly one final disposition: done, cancelled, review/input, blocked with owner, delegated follow-up, or queued continuation.",
        },
        sourceIssue: source,
      }));
      continue;
    }

    if (BLOCKED_INBOX_RECOVERY_ORIGIN_KINDS.includes(row.originKind as typeof BLOCKED_INBOX_RECOVERY_ORIGIN_KINDS[number])) {
      let sourceIssue: IssueBlockedInboxIssueRef | null = null;
      let leafIssue: IssueBlockedInboxIssueRef | null = null;
      if (row.originKind === RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation) {
        const parsed = parseIssueGraphLivenessIncidentKey(row.originId);
        if (parsed?.companyId === companyId) {
          sourceIssue = issueRef(issuesById.get(parsed.issueId));
          leafIssue = issueRef(issuesById.get(parsed.leafIssueId));
        }
      } else if (
        (row.originKind === RECOVERY_ORIGIN_KINDS.issueProductivityReview ||
          row.originKind === RECOVERY_ORIGIN_KINDS.strandedIssueRecovery) && row.originId
      ) {
        sourceIssue = issueRef(issuesById.get(row.originId));
      }
      result.set(row.id, attentionBase({
        state: "recovery_open",
        reason: "open_recovery_issue",
        severity: "high",
        stoppedSinceAt: row.createdAt,
        owner: {
          type: row.assigneeAgentId ? "agent" : row.assigneeUserId ? "user" : "unknown",
          agentId: row.assigneeAgentId,
          userId: row.assigneeUserId,
          label: null,
        },
        action: {
          label: "Resolve recovery",
          detail: "Restore a live path for the source work or record why this recovery issue is a false positive.",
        },
        sourceIssue: sourceIssue ?? source,
        leafIssue,
        recoveryIssue: source,
      }));
      continue;
    }

    const interaction = interactionByIssueId.get(row.id);
    if (interaction) {
      const isUserQuestion = interaction.kind === "ask_user_questions" && Boolean(row.assigneeUserId);
      result.set(row.id, attentionBase({
        state: "awaiting_decision",
        reason: isUserQuestion ? "pending_user_decision" : "pending_board_decision",
        severity: "medium",
        stoppedSinceAt: interaction.createdAt,
        owner: isUserQuestion
          ? { type: "user", agentId: null, userId: row.assigneeUserId, label: null }
          : { type: "board", agentId: null, userId: null, label: "Board" },
        action: {
          label: isUserQuestion ? "Answer question" : "Answer confirmation",
          detail: "Respond to the pending issue-thread interaction so the assignee has a live next action.",
        },
        sourceIssue: source,
        interactionId: interaction.id,
      }));
      continue;
    }

    const approval = approvalByIssueId.get(row.id);
    if (approval) {
      result.set(row.id, attentionBase({
        state: "awaiting_decision",
        reason: "pending_board_decision",
        severity: "medium",
        stoppedSinceAt: approval.createdAt,
        owner: { type: "board", agentId: null, userId: null, label: "Board" },
        action: {
          label: "Decide approval",
          detail: "Approve, reject, or request revision on the linked approval.",
        },
        sourceIssue: source,
        approvalId: approval.approvalId,
      }));
      continue;
    }

    const finding = findingByIssueId.get(row.id);
    if (finding) {
      const leaf = finding.dependencyPath.length > 1
        ? issuesById.get(finding.dependencyPath[finding.dependencyPath.length - 1]!.issueId)
        : issuesById.get(finding.recoveryIssueId);
      const ownerAgentId = finding.state === "blocked_by_unassigned_issue"
        ? null
        : finding.recommendedOwnerAgentId ?? row.assigneeAgentId ?? leaf?.assigneeAgentId ?? null;
      result.set(row.id, attentionBase({
        state: "needs_attention",
        reason: finding.state as IssueBlockedInboxAttention["reason"],
        severity: finding.state === "blocked_by_assigned_backlog_issue"
          || finding.state === "in_review_without_action_path"
          ? "high"
          : finding.severity === "critical" ? "critical" : "high",
        stoppedSinceAt: leaf?.updatedAt ?? row.updatedAt,
        owner: {
          type: ownerAgentId ? "agent" : leaf?.assigneeUserId ? "user" : "unknown",
          agentId: ownerAgentId,
          userId: leaf?.assigneeUserId ?? null,
          label: null,
        },
        action: {
          label: (() => {
            switch (finding.state) {
              case "blocked_by_unassigned_issue":
                return "Assign blocker";
              case "blocked_by_assigned_backlog_issue":
                return "Resume parked blocker";
              case "blocked_by_uninvokable_assignee":
                return "Assign active owner";
              case "blocked_by_cancelled_issue":
                return "Replace blocker";
              case "invalid_review_participant":
                return "Repair review participant";
              case "in_review_without_action_path":
                return "Choose review path";
            }
          })(),
          detail: finding.recommendedAction,
        },
        sourceIssue: source,
        leafIssue: issueRef(leaf),
        recoveryIssue: issueRef(issuesById.get(finding.recoveryIssueId)),
        sampleIssueIdentifier: leaf?.identifier ?? finding.identifier,
      }));
      continue;
    }

    const hasMonitor = Boolean(row.monitorNextCheckAt && row.monitorNextCheckAt.getTime() > Date.now());
    const external = row.status === "blocked" && !hasMonitor ? externalWaitFromDescription(row.description) : null;
    if (external) {
      result.set(row.id, attentionBase({
        state: "external_wait",
        reason: "external_owner_action",
        severity: "medium",
        stoppedSinceAt: row.updatedAt,
        owner: { type: "external", agentId: null, userId: null, label: null },
        action: {
          label: "External owner action",
          detail: null,
        },
        sourceIssue: source,
        externalDetailsRedacted: true,
      }));
      continue;
    }

    const blockerState = blockerAttentionByIssueId.get(row.id);
    if (row.status === "blocked" && (blockerState?.state === "needs_attention" || blockerState?.state === "stalled")) {
      result.set(row.id, attentionBase({
        state: "needs_attention",
        reason: "blocked_chain_stalled",
        severity: "high",
        stoppedSinceAt: row.updatedAt,
        owner: { type: "unknown", agentId: null, userId: null, label: null },
        action: {
          label: "Inspect blocker chain",
          detail: "Inspect the stalled blocker or review leaf and make the next owner/action explicit.",
        },
        sourceIssue: source,
        sampleIssueIdentifier: blockerState.sampleStalledBlockerIdentifier ?? blockerState.sampleBlockerIdentifier,
      }));
    }
  }

  return result;
}

function parseIssueAssigneeAgentFilter(
  assigneeAgentId: IssueFilters["assigneeAgentId"],
): string | null | undefined {
  const normalizedRaw = typeof assigneeAgentId === "string" ? assigneeAgentId.trim() : assigneeAgentId;
  const normalized = normalizedRaw === "" ? undefined : normalizedRaw;
  if (typeof normalized !== "string") return normalized;
  return normalized.toLowerCase() === "null" ? null : normalized;
}

function assertValidAssigneeAgentFilter(assigneeAgentFilter: string | null | undefined) {
  if (typeof assigneeAgentFilter === "string" && !isUuidLike(assigneeAgentFilter)) {
    throw unprocessable("assigneeAgentId must be a UUID or 'null'");
  }
}

async function blockedInboxIssueConditions(
  dbOrTx: any,
  companyId: string,
  filters?: IssueFilters,
) {
  const conditions = [
    eq(issues.companyId, companyId),
    visibleIssueCondition(),
    notInArray(issues.status, [...BLOCKED_INBOX_TERMINAL_STATUSES]),
  ];
  const touchedByUserId = filters?.touchedByUserId?.trim() || undefined;
  const inboxArchivedByUserId = filters?.inboxArchivedByUserId?.trim() || undefined;
  const unreadForUserId = filters?.unreadForUserId?.trim() || undefined;
  const contextUserId = unreadForUserId ?? touchedByUserId ?? inboxArchivedByUserId;
  const assigneeAgentFilter = parseIssueAssigneeAgentFilter(filters?.assigneeAgentId);
  assertValidAssigneeAgentFilter(assigneeAgentFilter);

  if (filters?.descendantOf) {
    conditions.push(sql<boolean>`
      ${issues.id} IN (
        WITH RECURSIVE descendants(id) AS (
          SELECT ${issues.id}
          FROM ${issues}
          WHERE ${issues.companyId} = ${companyId}
            AND ${issues.parentId} = ${filters.descendantOf}
          UNION
          SELECT ${issues.id}
          FROM ${issues}
          JOIN descendants ON ${issues.parentId} = descendants.id
          WHERE ${issues.companyId} = ${companyId}
        )
        SELECT id FROM descendants
      )
    `);
  }
  const lowTrustCondition = lowTrustBoundaryIssueCondition(companyId, filters?.lowTrustBoundary);
  if (lowTrustCondition) conditions.push(lowTrustCondition);
  if (filters?.status) {
    const statuses = parseStatusFilter(filters.status);
    if (statuses.length > 0) {
      conditions.push(statuses.length === 1 ? eq(issues.status, statuses[0]!) : inArray(issues.status, statuses));
    }
  }
  if (assigneeAgentFilter === null) {
    conditions.push(isNull(issues.assigneeAgentId));
  } else if (assigneeAgentFilter) {
    conditions.push(eq(issues.assigneeAgentId, assigneeAgentFilter));
  }
  if (filters?.participantAgentId) conditions.push(participatedByAgentCondition(companyId, filters.participantAgentId));
  if (filters?.assigneeUserId) conditions.push(eq(issues.assigneeUserId, filters.assigneeUserId));
  if (touchedByUserId) conditions.push(touchedByUserCondition(companyId, touchedByUserId));
  if (inboxArchivedByUserId) conditions.push(inboxVisibleForUserCondition(companyId, inboxArchivedByUserId));
  if (unreadForUserId) conditions.push(unreadForUserCondition(companyId, unreadForUserId));
  if (filters?.projectId) conditions.push(eq(issues.projectId, filters.projectId));
  if (filters?.workspaceId) {
    conditions.push(or(
      eq(issues.executionWorkspaceId, filters.workspaceId),
      eq(issues.projectWorkspaceId, filters.workspaceId),
    )!);
  }
  if (filters?.executionWorkspaceId) conditions.push(eq(issues.executionWorkspaceId, filters.executionWorkspaceId));
  if (filters?.parentId) conditions.push(eq(issues.parentId, filters.parentId));
  if (filters?.originKind) conditions.push(eq(issues.originKind, filters.originKind));
  if (filters?.originKindPrefix) conditions.push(like(issues.originKind, `${filters.originKindPrefix}%`));
  if (filters?.originId) conditions.push(eq(issues.originId, filters.originId));
  if (filters?.originFingerprint) conditions.push(eq(issues.originFingerprint, filters.originFingerprint));
  if (filters?.hasPlanDocument !== undefined) {
    conditions.push(hasPlanDocumentCondition(companyId, filters.hasPlanDocument));
  }
  if (!shouldIncludePluginOperationIssues(filters)) conditions.push(nonPluginOperationIssueCondition());
  if (filters?.labelId) {
    const labeledIssueIds = await dbOrTx
      .select({ issueId: issueLabels.issueId })
      .from(issueLabels)
      .where(and(eq(issueLabels.companyId, companyId), eq(issueLabels.labelId, filters.labelId)));
    if (labeledIssueIds.length === 0) return { conditions: [sql<boolean>`false`], contextUserId };
    conditions.push(inArray(issues.id, labeledIssueIds.map((row: { issueId: string }) => row.issueId)));
  }
  if (
    (filters?.excludeRoutineExecutions && !filters?.originKind && !filters?.originKindPrefix && !filters?.originId) ||
    shouldExcludeRoutineExecutionIssues(filters)
  ) {
    conditions.push(nonRoutineExecutionIssueCondition());
  }

  return { conditions, contextUserId };
}

async function listBlockedInboxIssues(
  dbOrTx: any,
  companyId: string,
  filters?: IssueFilters,
): Promise<Array<IssueWithLabelsAndRun & {
  blockedBy?: IssueRelationIssueSummary[];
  blockerAttention?: IssueBlockerAttention;
  blockedInboxAttention: IssueBlockedInboxAttention;
  productivityReview?: IssueProductivityReview | null;
  liveDescendantCount?: number;
  lastActivityAt: Date;
  myLastTouchAt?: Date | null;
  lastExternalCommentAt?: Date | null;
  isUnreadForMe?: boolean;
}>> {
  const { conditions, contextUserId } = await blockedInboxIssueConditions(dbOrTx, companyId, filters);

  const rows = (await dbOrTx
    .select(issueListSelect)
    .from(issues)
    .where(and(...conditions))
    .orderBy(desc(issueCanonicalLastActivityAtExpr(companyId)), desc(issues.updatedAt), desc(issues.id)))
    .map((row: any) => ({
      ...row,
      description: decodeDatabaseTextPreview(row.description, ISSUE_LIST_DESCRIPTION_MAX_CHARS),
    }));
  const withLabels = await withIssueLabels(dbOrTx, rows);
  const withRuns = withActiveRuns(withLabels, await activeRunMapForIssues(dbOrTx, withLabels));
  if (withRuns.length === 0) return [];

  const issueIds = withRuns.map((row) => row.id);
  const includeLiveDescendantSummary = filters?.includeLiveDescendantSummary === true;
  const [
    statsRows,
    readRows,
    lastActivityRows,
    blockedByMap,
    blockerAttentionByIssueId,
    productivityReviewByIssueId,
    blockedInboxAttentionByIssueId,
    liveDescendantCountByIssueId,
  ] = await Promise.all([
    contextUserId ? userCommentStatsForIssues(dbOrTx, companyId, contextUserId, issueIds) : Promise.resolve([]),
    contextUserId ? userReadStatsForIssues(dbOrTx, companyId, contextUserId, issueIds) : Promise.resolve([]),
    lastActivityStatsForIssues(dbOrTx, companyId, issueIds),
    blockedByMapForIssues(dbOrTx, companyId, issueIds),
    listIssueBlockerAttentionMap(dbOrTx, companyId, withRuns),
    listIssueProductivityReviewMap(dbOrTx, companyId, issueIds),
    listIssueBlockedInboxAttentionMap(dbOrTx, companyId, withRuns),
    includeLiveDescendantSummary
      ? liveDescendantCountMapForIssues(dbOrTx, companyId, issueIds)
      : Promise.resolve(new Map<string, number>()),
  ]);

  const rawSearchInput = filters?.q?.trim() ?? "";
  const rawSearch = rawSearchInput.toLowerCase();
  const commentSearchMatchIssueIds = new Set<string>();
  if (rawSearchInput) {
    const containsPattern = `%${escapeLikePattern(rawSearchInput)}%`;
    for (const issueIdChunk of chunkList(issueIds, ISSUE_LIST_RELATED_QUERY_CHUNK_SIZE)) {
      const rows = await dbOrTx
        .select({ issueId: issueComments.issueId })
        .from(issueComments)
        .where(and(
          eq(issueComments.companyId, companyId),
          inArray(issueComments.issueId, issueIdChunk),
          isNull(issueComments.deletedAt),
          sql<boolean>`${issueComments.body} ILIKE ${containsPattern} ESCAPE '\\'`,
        ));
      for (const row of rows as Array<{ issueId: string }>) commentSearchMatchIssueIds.add(row.issueId);
    }
  }
  const statsByIssueId = new Map(statsRows.map((row) => [row.issueId, row]));
  const readByIssueId = new Map(readRows.map((row) => [row.issueId, row.myLastReadAt]));
  const lastActivityByIssueId = new Map(lastActivityRows.map((row) => [row.issueId, row]));

  const enriched = withRuns.flatMap((row) => {
    const blockedInboxAttention = blockedInboxAttentionByIssueId.get(row.id);
    if (!blockedInboxAttention) return [];
    if (
      rawSearch
      && !blockedInboxSearchText(blockedInboxAttention, row).includes(rawSearch)
      && !commentSearchMatchIssueIds.has(row.id)
    ) return [];

    const activity = lastActivityByIssueId.get(row.id);
    const lastActivityAt = latestIssueActivityAt(
      row.updatedAt,
      activity?.latestCommentAt ?? null,
      activity?.latestLogAt ?? null,
    ) ?? row.updatedAt;
    return [{
      ...row,
      description: blockedInboxResponseDescription(blockedInboxAttention, row),
      blockedBy: blockedByMap.get(row.id) ?? [],
      lastActivityAt,
      ...(blockerAttentionByIssueId.has(row.id) ? { blockerAttention: blockerAttentionByIssueId.get(row.id) } : {}),
      blockedInboxAttention,
      ...(productivityReviewByIssueId.has(row.id)
        ? { productivityReview: productivityReviewByIssueId.get(row.id) }
        : {}),
      ...(includeLiveDescendantSummary ? { liveDescendantCount: liveDescendantCountByIssueId.get(row.id) ?? 0 } : {}),
      ...(contextUserId
        ? deriveIssueUserContext(row, contextUserId, {
            myLastCommentAt: statsByIssueId.get(row.id)?.myLastCommentAt ?? null,
            myLastReadAt: readByIssueId.get(row.id) ?? null,
            lastExternalCommentAt: statsByIssueId.get(row.id)?.lastExternalCommentAt ?? null,
          })
        : {}),
    }];
  }).sort(compareBlockedInboxRows);

  const offset = typeof filters?.offset === "number" && Number.isFinite(filters.offset)
    ? Math.max(0, Math.floor(filters.offset))
    : 0;
  const limit = typeof filters?.limit === "number" && Number.isFinite(filters.limit)
    ? Math.max(1, Math.floor(filters.limit))
    : undefined;
  return limit === undefined ? enriched.slice(offset) : enriched.slice(offset, offset + limit);
}

async function countBlockedInboxIssues(dbOrTx: any, companyId: string, filters?: IssueFilters): Promise<number> {
  const { conditions } = await blockedInboxIssueConditions(dbOrTx, companyId, filters);
  const rows = (await dbOrTx
    .select()
    .from(issues)
    .where(and(...conditions))) as IssueRow[];
  if (rows.length === 0) return 0;

  const blockedInboxAttentionByIssueId = await listIssueBlockedInboxAttentionMap(dbOrTx, companyId, rows);
  const rawSearchInput = filters?.q?.trim() ?? "";
  const rawSearch = rawSearchInput.toLowerCase();
  const commentSearchMatchIssueIds = new Set<string>();
  if (rawSearchInput) {
    const issueIds = rows.map((row) => row.id);
    const containsPattern = `%${escapeLikePattern(rawSearchInput)}%`;
    for (const issueIdChunk of chunkList(issueIds, ISSUE_LIST_RELATED_QUERY_CHUNK_SIZE)) {
      const commentRows = await dbOrTx
        .select({ issueId: issueComments.issueId })
        .from(issueComments)
        .where(and(
          eq(issueComments.companyId, companyId),
          inArray(issueComments.issueId, issueIdChunk),
          isNull(issueComments.deletedAt),
          sql<boolean>`${issueComments.body} ILIKE ${containsPattern} ESCAPE '\\'`,
        ));
      for (const row of commentRows as Array<{ issueId: string }>) commentSearchMatchIssueIds.add(row.issueId);
    }
  }

  return rows.reduce((count: number, row: IssueRow) => {
    const attention = blockedInboxAttentionByIssueId.get(row.id);
    if (!attention) return count;
    if (
      rawSearch
      && !blockedInboxSearchText(attention, row).includes(rawSearch)
      && !commentSearchMatchIssueIds.has(row.id)
    ) return count;
    return count + 1;
  }, 0);
}

// BLO-15982: matches a 23505 violation of `issues_active_alert_escalation_cover_uq`
// (partial unique index on companyId+originKind+originFingerprint, scoped to
// the alertmanager plugin's escalation-cover origin kind). Mirrors the
// constraint-name matching convention used by task-watchdogs.ts's
// `isUniqueConstraintConflict` and companies.ts's inline check.
function isAlertEscalationCoverDedupConflict(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const maybe = current as {
      code?: string;
      constraint?: string;
      constraint_name?: string;
      cause?: unknown;
    };
    const constraint = maybe.constraint ?? maybe.constraint_name;
    if (maybe.code === "23505" && constraint === "issues_active_alert_escalation_cover_uq") {
      return true;
    }
    current = maybe.cause;
  }
  return false;
}

export function issueService(db: Db) {
  const instanceSettings = instanceSettingsService(db);
  const treeControlSvc = issueTreeControlService(db);

  function normalizeCreateIssueTitle(title: string) {
    return title.trim().replace(/\s+/g, " ").toLowerCase();
  }

  async function getIssueByUuid(id: string) {
    const row = await db
      .select()
      .from(issues)
      .where(eq(issues.id, id))
      .then((rows) => rows[0] ?? null);
    if (!row) return null;
    const [enriched] = await withIssueLabels(db, [row]);
    return enriched;
  }

  async function getIssueByIdentifier(identifier: string) {
    const upper = identifier.toUpperCase();
    // Primary lookup against the current `identifier`. This is the hot path —
    // every URL with an identifier in it lands here on every request.
    const row = await db
      .select()
      .from(issues)
      .where(eq(issues.identifier, upper))
      .then((rows) => rows[0] ?? null);
    if (row) {
      const [enriched] = await withIssueLabels(db, [row]);
      return enriched;
    }
    // Legacy fallback: 0084's BLO→PCL backfill stashed the pre-rename
    // identifier in `legacy_identifier` so old URLs (bookmarks, agent
    // memory, copy-pasted refs in chat) still resolve to the correct
    // row. Returning the row here means the caller transparently lands
    // on the renamed issue. URL-bar upgrade is handled UI-side: when
    // the API returns `identifier='PCL-N'` for a request that used the
    // legacy form, `IssueDetail.tsx`'s identifier-mismatch effect fires
    // a `navigate(replace: true)` that swaps the address bar to the
    // current identifier (same effect that handles UUID-via-URL).
    const legacyRow = await db
      .select()
      .from(issues)
      .where(eq(issues.legacyIdentifier, upper))
      .then((rows) => rows[0] ?? null);
    if (!legacyRow) return null;
    const [enriched] = await withIssueLabels(db, [legacyRow]);
    return enriched;
  }

  async function getCurrentScheduledRetryForIssue(issueId: string, companyId: string): Promise<IssueScheduledRetryRow | null> {
    const row = await db
      .select({
        runId: heartbeatRuns.id,
        status: heartbeatRuns.status,
        agentId: heartbeatRuns.agentId,
        agentName: agents.name,
        retryOfRunId: heartbeatRuns.retryOfRunId,
        scheduledRetryAt: heartbeatRuns.scheduledRetryAt,
        scheduledRetryAttempt: heartbeatRuns.scheduledRetryAttempt,
        scheduledRetryReason: heartbeatRuns.scheduledRetryReason,
        error: heartbeatRuns.error,
        errorCode: heartbeatRuns.errorCode,
      })
      .from(heartbeatRuns)
      .innerJoin(agents, eq(heartbeatRuns.agentId, agents.id))
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          eq(heartbeatRuns.status, "scheduled_retry"),
          sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`,
        ),
      )
      .orderBy(asc(heartbeatRuns.scheduledRetryAt), asc(heartbeatRuns.createdAt), asc(heartbeatRuns.id))
      .limit(1)
      .then((rows) => rows[0] ?? null);

    return row ? { ...row, status: "scheduled_retry" } : null;
  }

  function deriveIssueCommentAuthorType(comment: {
    authorType?: string | null;
    authorAgentId?: string | null;
    authorUserId?: string | null;
  }): IssueCommentAuthorType {
    const explicit = issueCommentAuthorTypeSchema.safeParse(comment.authorType);
    if (explicit.success) return explicit.data;
    if (comment.authorAgentId) return "agent";
    if (comment.authorUserId) return "user";
    return "system";
  }

  function assertIssueCommentAuthorTypeAllowed(
    actor: { agentId?: string | null; userId?: string | null },
    authorType: IssueCommentAuthorType,
  ) {
    if (actor.agentId && authorType !== "agent") {
      throw unprocessable("Comment authorType must match authenticated actor");
    }
    if (actor.userId && authorType !== "user") {
      throw unprocessable("Comment authorType must match authenticated actor");
    }
    if (!actor.agentId && !actor.userId && authorType !== "system") {
      throw unprocessable("System comments cannot use user or agent authorType without an author id");
    }
  }

  function issueCommentIdempotencyAuthorScope(actor: { agentId?: string | null; userId?: string | null }) {
    if (actor.agentId) {
      return and(eq(issueComments.authorAgentId, actor.agentId), isNull(issueComments.authorUserId));
    }
    if (actor.userId) {
      return and(eq(issueComments.authorUserId, actor.userId), isNull(issueComments.authorAgentId));
    }
    return and(isNull(issueComments.authorAgentId), isNull(issueComments.authorUserId));
  }

  function redactIssueComment<T extends {
    body: string;
    authorType?: string | null;
    authorAgentId?: string | null;
    authorUserId?: string | null;
    presentation?: unknown;
    metadata?: unknown;
    deletedAt?: Date | string | null;
    deletedByType?: "agent" | "user" | null;
    deletedByAgentId?: string | null;
    deletedByUserId?: string | null;
    deletedByRunId?: string | null;
  }>(
    comment: T,
    censorUsernameInLogs: boolean,
  ): T & {
    authorType: IssueCommentAuthorType;
    presentation: IssueCommentPresentation | null;
    metadata: IssueCommentMetadata | null;
  } {
    const deletedAt = comment.deletedAt ?? null;
    if (deletedAt) {
      return {
        ...comment,
        authorType: deriveIssueCommentAuthorType(comment),
        body: "",
        presentation: null,
        metadata: null,
        deletedAt,
        deletedByType: comment.deletedByType ?? null,
        deletedByAgentId: comment.deletedByAgentId ?? null,
        deletedByUserId: comment.deletedByUserId ?? null,
        deletedByRunId: comment.deletedByRunId ?? null,
      };
    }

    return {
      ...comment,
      authorType: deriveIssueCommentAuthorType(comment),
      body: redactCurrentUserText(comment.body, { enabled: censorUsernameInLogs }),
      presentation: issueCommentPresentationSchema.nullable().catch(null).parse(comment.presentation ?? null),
      metadata: issueCommentMetadataSchema.nullable().catch(null).parse(comment.metadata ?? null),
    };
  }

  async function readRunLogText(run: {
    runId?: string | null;
    logStore: string | null;
    logRef: string | null;
    logBytes: number | null;
  }) {
    if (run.logStore !== "local_file" || !run.logRef) return "";
    const logBytes = Number(run.logBytes ?? 0);
    if (!Number.isFinite(logBytes) || logBytes <= 0) return "";

    const store = getRunLogStore();
    let offset = 0;
    let content = "";
    let nextOffset: number | undefined = 0;

    try {
      while (nextOffset !== undefined) {
        const remainingBytes = ISSUE_COMMENT_RUN_LOG_DERIVATION_MAX_LOG_BYTES - Buffer.byteLength(content, "utf8");
        if (remainingBytes <= 0) break;
        const chunk = await store.read(
          { store: "local_file", logRef: run.logRef },
          {
            offset,
            limitBytes: Math.min(ISSUE_COMMENT_RUN_LOG_DERIVATION_CHUNK_BYTES, remainingBytes),
          },
        );
        content += chunk.content;
        nextOffset = chunk.nextOffset;
        offset = chunk.nextOffset ?? 0;
      }
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) {
        logger.warn(
          { err, runId: run.runId ?? undefined, logRef: run.logRef },
          "missing heartbeat run log while deriving issue comment metadata",
        );
        return content;
      }
      throw err;
    }

    return content;
  }

  // Persist a resolved attribution so subsequent reads stop re-scanning run
  // logs (and old "Board" threads stay fixed durably). Best-effort: a write
  // failure must never break the read path. The `IS NULL` guard keeps this
  // idempotent and avoids clobbering a value another reader just stored.
  async function persistDerivedIssueCommentAttribution(
    derivedByCommentId: ReadonlyMap<string, DerivedIssueCommentAttribution>,
  ) {
    if (derivedByCommentId.size === 0) return;
    // One bulk `UPDATE ... FROM (VALUES ...)` so the read path is never blocked
    // on N sequential round-trips for a large legacy thread. The `IS NULL` guard
    // keeps this idempotent and avoids clobbering a value another reader just
    // stored. Best-effort: a write failure must never break the read path.
    const rows = [...derivedByCommentId].map(
      ([commentId, derived]) =>
        sql`(${commentId}::uuid, ${derived.derivedAuthorAgentId}::uuid, ${derived.derivedCreatedByRunId}::uuid, ${derived.derivedAuthorSource}::text)`,
    );
    try {
      await db.execute(sql`
        UPDATE ${issueComments} AS c
        SET derived_author_agent_id = v.agent_id,
            derived_created_by_run_id = v.run_id,
            derived_author_source = v.source
        FROM (VALUES ${sql.join(rows, sql`, `)}) AS v(comment_id, agent_id, run_id, source)
        WHERE c.id = v.comment_id AND c.derived_author_agent_id IS NULL
      `);
    } catch (err) {
      logger.warn(
        { err, commentIds: [...derivedByCommentId.keys()] },
        "failed to persist derived issue-comment attribution",
      );
    }
  }

  async function enrichCommentsWithDerivedAgentAttribution<
    T extends {
      id: string;
      companyId: string;
      issueId: string;
      authorAgentId?: string | null;
      authorUserId?: string | null;
      createdByRunId?: string | null;
      derivedAuthorAgentId?: string | null;
      createdAt: Date | string;
    },
  >(comments: readonly T[]) {
    // Candidates: a non-human author, no stored agent, and not already resolved
    // by a previous read / the backfill migration.
    const preliminary = comments.filter((comment) =>
      !comment.authorAgentId
      && !!comment.authorUserId
      && !comment.derivedAuthorAgentId,
    );
    if (preliminary.length === 0) return comments;

    const companyId = comments[0]?.companyId ?? null;
    const issueId = comments[0]?.issueId ?? null;
    if (!companyId || !issueId) return comments;

    // Guard: never reattribute a comment whose author maps to a genuine user
    // profile. Only the non-human sentinels agents post under (e.g.
    // `local-board`) are eligible — even though `local-board` is itself a row in
    // the `user` table, so a plain "exists in user table" check would wrongly
    // exclude every mis-attributed agent comment.
    const nonSentinelAuthorUserIds = [
      ...new Set(
        preliminary
          .map((comment) => comment.authorUserId)
          .filter((id): id is string => !!id && !NON_HUMAN_SENTINEL_AUTHOR_USER_IDS.has(id)),
      ),
    ];
    const genuineUserIds = nonSentinelAuthorUserIds.length
      ? new Set(
          (
            await db
              .select({ id: authUsers.id })
              .from(authUsers)
              .where(inArray(authUsers.id, nonSentinelAuthorUserIds))
          ).map((row) => row.id),
        )
      : new Set<string>();
    // `preliminary` already guarantees a truthy `authorUserId`, so only the two
    // "not a genuine user" arms are live: the explicit non-human sentinel, or an
    // author id absent from the `user` table.
    const candidates = preliminary.filter(
      (comment) =>
        NON_HUMAN_SENTINEL_AUTHOR_USER_IDS.has(comment.authorUserId!)
        || !genuineUserIds.has(comment.authorUserId!),
    );
    if (candidates.length === 0) return comments;

    const minCommentCreatedAtMs = candidates.reduce<number | null>((min, comment) => {
      const timestamp = toTimestampMs(comment.createdAt);
      if (timestamp === null) return min;
      return min === null ? timestamp : Math.min(min, timestamp);
    }, null);
    const maxCommentCreatedAtMs = candidates.reduce<number | null>((max, comment) => {
      const timestamp = toTimestampMs(comment.createdAt);
      if (timestamp === null) return max;
      return max === null ? timestamp : Math.max(max, timestamp);
    }, null);
    if (minCommentCreatedAtMs === null || maxCommentCreatedAtMs === null) return comments;

    const minCommentCreatedAt = new Date(minCommentCreatedAtMs).toISOString();
    const maxCommentCreatedAt = new Date(
      maxCommentCreatedAtMs + ISSUE_COMMENT_RUN_LOG_DERIVATION_END_SLACK_MS,
    ).toISOString();

    // The runs the comments' own `createdByRunId` point at — fetched
    // unconditionally so the lossless run-id tier resolves even when a run is
    // not otherwise associated with the issue.
    const ownRunIds = [
      ...new Set(candidates.map((comment) => comment.createdByRunId).filter((id): id is string => !!id)),
    ];

    const runs = await db
      .select({
        runId: heartbeatRuns.id,
        agentId: heartbeatRuns.agentId,
        createdAt: heartbeatRuns.createdAt,
        startedAt: heartbeatRuns.startedAt,
        finishedAt: heartbeatRuns.finishedAt,
        logStore: heartbeatRuns.logStore,
        logRef: heartbeatRuns.logRef,
        logBytes: heartbeatRuns.logBytes,
      })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          or(
            and(
              or(
                sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`,
                sql`exists (
                  select 1
                  from ${activityLog}
                  where ${activityLog.companyId} = ${companyId}
                    and ${activityLog.entityType} = 'issue'
                    and ${activityLog.entityId} = ${issueId}
                    and ${activityLog.runId} = ${heartbeatRuns.id}
                )`,
              ),
              sql`coalesce(${heartbeatRuns.finishedAt}, ${heartbeatRuns.createdAt}) >= ${minCommentCreatedAt}::timestamptz`,
              sql`coalesce(${heartbeatRuns.startedAt}, ${heartbeatRuns.createdAt}) <= ${maxCommentCreatedAt}::timestamptz`,
            ),
            ownRunIds.length > 0 ? inArray(heartbeatRuns.id, ownRunIds) : sql`false`,
          ),
        ),
      )
      .orderBy(desc(heartbeatRuns.createdAt));

    if (runs.length === 0) return comments;

    // Pass 1: resolve the run-id tier, which never reads log bodies. Most
    // comments resolve here, so we avoid object-storage reads entirely.
    const runsWithoutLogs = runs.map((run) => ({ ...run, logContent: "" }));
    const derivedByCommentId = new Map<string, DerivedIssueCommentAttribution>(
      deriveIssueCommentRunLogAttribution(candidates, runsWithoutLogs),
    );

    // Pass 2: for comments still unresolved after the run-id tier, read the logs
    // of any run whose window overlaps such a comment, to look for the explicit
    // `comment id:` post marker. The marker is a lossless signal regardless of
    // how many runs overlap, so we do not short-circuit on the single-run case.
    const unresolved = candidates.filter((comment) => !derivedByCommentId.has(comment.id));
    if (unresolved.length > 0) {
      const runIdsToRead = new Set<string>();
      for (const run of runs) {
        const runStartMs = toTimestampMs(run.startedAt ?? run.createdAt);
        const runEndMs = toTimestampMs(run.finishedAt ?? run.createdAt);
        if (runStartMs === null || runEndMs === null) continue;
        for (const comment of unresolved) {
          const commentCreatedAtMs = toTimestampMs(comment.createdAt);
          if (commentCreatedAtMs === null) continue;
          if (
            commentCreatedAtMs >= runStartMs
            && commentCreatedAtMs <= runEndMs + ISSUE_COMMENT_RUN_LOG_DERIVATION_END_SLACK_MS
          ) {
            runIdsToRead.add(run.runId);
            break;
          }
        }
      }

      if (runIdsToRead.size > 0) {
        const runsToRead = runs.filter((run) => runIdsToRead.has(run.runId));
        const logByRunId = new Map<string, string>();
        for (let index = 0; index < runsToRead.length; index += ISSUE_COMMENT_RUN_LOG_DERIVATION_MAX_PARALLEL_READS) {
          const batch = runsToRead.slice(index, index + ISSUE_COMMENT_RUN_LOG_DERIVATION_MAX_PARALLEL_READS);
          await Promise.all(
            batch.map(async (run) => {
              logByRunId.set(run.runId, await readRunLogText(run));
            }),
          );
        }
        const runsWithLogs = runs.map((run) => ({ ...run, logContent: logByRunId.get(run.runId) ?? "" }));
        for (const [commentId, derived] of deriveIssueCommentRunLogAttribution(unresolved, runsWithLogs)) {
          derivedByCommentId.set(commentId, derived);
        }
      }
    }

    if (derivedByCommentId.size === 0) return comments;

    await persistDerivedIssueCommentAttribution(derivedByCommentId);

    return comments.map((comment) => {
      const derived = derivedByCommentId.get(comment.id);
      return derived ? { ...comment, ...derived } : comment;
    });
  }

  async function isTreeHoldInteractionCheckoutAllowed(
    companyId: string,
    checkoutRunId: string | null,
    _gate: ActiveIssueTreePauseHoldGate,
  ) {
    if (!checkoutRunId) return false;
    const run = await db
      .select({
        id: heartbeatRuns.id,
        agentId: heartbeatRuns.agentId,
        wakeupRequestId: heartbeatRuns.wakeupRequestId,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.id, checkoutRunId), eq(heartbeatRuns.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    const issueId = readStringFromRecord(run?.contextSnapshot, "issueId");
    if (!run || !issueId) return false;
    return isVerifiedIssueTreeControlInteractionWake(db, {
      companyId,
      issueId,
      agentId: run.agentId,
      runId: run.id,
      wakeupRequestId: run.wakeupRequestId,
      contextSnapshot: run.contextSnapshot as Record<string, unknown> | null | undefined,
    });
  }

  async function assertAssignableUser(companyId: string, userId: string) {
    const membership = await db
      .select({ id: companyMemberships.id })
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalId, userId),
          eq(companyMemberships.status, "active"),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!membership) {
      throw notFound("Assignee user not found");
    }
  }

  async function assertValidProjectWorkspace(
    companyId: string,
    projectId: string | null | undefined,
    projectWorkspaceId: string,
    dbOrTx: DbReader = db,
  ) {
    const workspace = await dbOrTx
      .select({
        id: projectWorkspaces.id,
        companyId: projectWorkspaces.companyId,
        projectId: projectWorkspaces.projectId,
      })
      .from(projectWorkspaces)
      .where(eq(projectWorkspaces.id, projectWorkspaceId))
      .then((rows) => rows[0] ?? null);
    if (!workspace) throw notFound("Project workspace not found");
    if (workspace.companyId !== companyId) throw unprocessable("Project workspace must belong to same company");
    if (projectId && workspace.projectId !== projectId) {
      throw unprocessable("Project workspace must belong to the selected project");
    }
    return workspace;
  }

  async function assertValidExecutionWorkspace(
    companyId: string,
    projectId: string | null | undefined,
    executionWorkspaceId: string,
    dbOrTx: DbReader = db,
  ) {
    const workspace = await dbOrTx
      .select({
        id: executionWorkspaces.id,
        companyId: executionWorkspaces.companyId,
        projectId: executionWorkspaces.projectId,
      })
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, executionWorkspaceId))
      .then((rows) => rows[0] ?? null);
    if (!workspace) throw notFound("Execution workspace not found");
    if (workspace.companyId !== companyId) throw unprocessable("Execution workspace must belong to same company");
    if (projectId && workspace.projectId !== projectId) {
      throw unprocessable("Execution workspace must belong to the selected project");
    }
    return workspace;
  }

  async function assertValidIssueProject(
    companyId: string,
    projectId: string | null | undefined,
    dbOrTx: any = db,
  ) {
    if (!projectId) return;
    const project = await dbOrTx
      .select({ id: projects.id, companyId: projects.companyId })
      .from(projects)
      .where(eq(projects.id, projectId))
      .then((rows: Array<{ id: string; companyId: string }>) => rows[0] ?? null);
    if (!project) throw notFound("Project not found");
    if (project.companyId !== companyId) throw unprocessable("Project must belong to the issue's company");
  }

  async function assertValidIssueMilestone(
    companyId: string,
    projectId: string | null | undefined,
    milestoneId: string | null | undefined,
    dbOrTx: any = db,
  ) {
    if (!milestoneId) return;
    const milestone = await dbOrTx
      .select({ id: milestones.id, companyId: milestones.companyId, projectId: milestones.projectId })
      .from(milestones)
      .where(eq(milestones.id, milestoneId))
      .then((rows: Array<{ id: string; companyId: string; projectId: string | null }>) => rows[0] ?? null);
    if (!milestone) throw notFound("Milestone not found");
    if (milestone.companyId !== companyId) throw unprocessable("Milestone must belong to the issue's company");
    if (milestone.projectId && milestone.projectId !== projectId) {
      throw unprocessable("Milestone must belong to the selected project");
    }
  }

  async function lockIssueParentMutationCompany(companyId: string, dbOrTx: any = db) {
    await dbOrTx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`paperclip:issue-parent:${companyId}`}, 0))`,
    );
  }

  async function assertValidIssueParent(
    companyId: string,
    issueId: string,
    parentId: string | null | undefined,
    dbOrTx: any = db,
  ) {
    if (!parentId) return;
    if (parentId === issueId) throw unprocessable("Parent issue would create a cycle");
    await dbOrTx.execute(
      sql`SELECT ${issues.id} FROM ${issues}
          WHERE ${and(eq(issues.companyId, companyId), inArray(issues.id, [issueId, parentId]))}
          ORDER BY ${issues.id}
          FOR UPDATE`,
    );

    let cursorId: string | null = parentId;
    for (let depth = 0; cursorId; depth += 1) {
      if (depth >= ISSUE_PARENT_ANCESTRY_VALIDATION_MAX_DEPTH) {
        throw unprocessable("Parent issue ancestry is too deep");
      }
      await dbOrTx.execute(
        sql`SELECT ${issues.id} FROM ${issues}
            WHERE ${and(eq(issues.companyId, companyId), eq(issues.id, cursorId))}
            FOR UPDATE`,
      );
      const cursor: { id: string; companyId: string; parentId: string | null } | null = await dbOrTx
        .select({ id: issues.id, companyId: issues.companyId, parentId: issues.parentId })
        .from(issues)
        .where(eq(issues.id, cursorId))
        .then((rows: Array<{ id: string; companyId: string; parentId: string | null }>) => rows[0] ?? null);
      if (!cursor) throw notFound("Parent issue not found");
      if (cursor.companyId !== companyId) throw unprocessable("Parent issue must belong to the issue's company");
      if (cursor.id === issueId) throw unprocessable("Parent issue would create a cycle");
      cursorId = cursor.parentId;
    }
  }

  async function assertValidLabelIds(companyId: string, labelIds: string[], dbOrTx: any = db) {
    if (labelIds.length === 0) return;
    const existing = await dbOrTx
      .select({ id: labels.id })
      .from(labels)
      .where(and(eq(labels.companyId, companyId), inArray(labels.id, labelIds)));
    if (existing.length !== new Set(labelIds).size) {
      throw unprocessable("One or more labels are invalid for this company");
    }
  }

  async function syncIssueLabels(
    issueId: string,
    companyId: string,
    labelIds: string[],
    dbOrTx: any = db,
  ) {
    const deduped = [...new Set(labelIds)];
    await assertValidLabelIds(companyId, deduped, dbOrTx);
    await dbOrTx.delete(issueLabels).where(eq(issueLabels.issueId, issueId));
    if (deduped.length === 0) return;
    await dbOrTx.insert(issueLabels).values(
      deduped.map((labelId) => ({
        issueId,
        labelId,
        companyId,
      })),
    );
  }

  /**
   * Label NAMES for an explicit `labelIds` patch, validated against the company.
   *
   * The evidence gate keys its policy off label names, and it runs before the
   * update transaction that calls `syncIssueLabels`. Reading names from the DB
   * at gate time therefore yields the labels the issue is moving AWAY from.
   * Validation is duplicated from `assertValidLabelIds` deliberately: it has to
   * happen before the gate so an invalid-label patch reports the label error
   * rather than a misleading `missing-evidence`. (BLO-19047)
   */
  async function resolveLabelNames(
    dbOrTx: any,
    companyId: string,
    labelIds: string[],
  ): Promise<Array<{ name: string }>> {
    const deduped = [...new Set(labelIds)];
    if (deduped.length === 0) return [];
    const rows = await dbOrTx
      .select({ name: labels.name })
      .from(labels)
      .where(and(eq(labels.companyId, companyId), inArray(labels.id, deduped)));
    if (rows.length !== deduped.length) {
      throw unprocessable("One or more labels are invalid for this company");
    }
    return rows.map((row: { name: string }) => ({ name: row.name }));
  }

  async function getIssueRelationSummaryMap(
    companyId: string,
    issueIds: string[],
    dbOrTx: DbReader = db,
  ): Promise<Map<string, IssueRelationSummaryMap>> {
    const uniqueIssueIds = [...new Set(issueIds)];
    const empty = new Map<string, IssueRelationSummaryMap>();
    for (const issueId of uniqueIssueIds) {
      empty.set(issueId, { blockedBy: [], blocks: [] });
    }
    if (uniqueIssueIds.length === 0) return empty;

    const [blockedByRows, blockingRows] = await Promise.all([
      dbOrTx
        .select({
          currentIssueId: issueRelations.relatedIssueId,
          relatedId: issues.id,
          identifier: issues.identifier,
          title: issues.title,
          status: issues.status,
          priority: issues.priority,
          assigneeAgentId: issues.assigneeAgentId,
          assigneeUserId: issues.assigneeUserId,
        })
        .from(issueRelations)
        .innerJoin(issues, eq(issueRelations.issueId, issues.id))
        .where(
          and(
            eq(issueRelations.companyId, companyId),
            eq(issueRelations.type, "blocks"),
            inArray(issueRelations.relatedIssueId, uniqueIssueIds),
          ),
        ),
      dbOrTx
        .select({
          currentIssueId: issueRelations.issueId,
          relatedId: issues.id,
          identifier: issues.identifier,
          title: issues.title,
          status: issues.status,
          priority: issues.priority,
          assigneeAgentId: issues.assigneeAgentId,
          assigneeUserId: issues.assigneeUserId,
        })
        .from(issueRelations)
        .innerJoin(issues, eq(issueRelations.relatedIssueId, issues.id))
        .where(
          and(
            eq(issueRelations.companyId, companyId),
            eq(issueRelations.type, "blocks"),
            inArray(issueRelations.issueId, uniqueIssueIds),
          ),
        ),
    ]);

    for (const row of blockedByRows) {
      empty.get(row.currentIssueId)?.blockedBy.push(summarizeIssueRelationRow(row));
    }
    for (const row of blockingRows) {
      empty.get(row.currentIssueId)?.blocks.push(summarizeIssueRelationRow(row));
    }

    const terminalByRoot = await terminalExplicitBlockersByRoot(
      companyId,
      [...empty.values()].flatMap((relations) => relations.blockedBy),
      dbOrTx,
    );

    for (const relations of empty.values()) {
      relations.blockedBy.sort((a, b) => a.title.localeCompare(b.title));
      for (const blocker of relations.blockedBy) {
        const terminalBlockers = terminalByRoot.get(blocker.id);
        if (terminalBlockers && terminalBlockers.length > 0) {
          blocker.terminalBlockers = terminalBlockers;
        }
      }
      relations.blocks.sort((a, b) => a.title.localeCompare(b.title));
    }

    return empty;
  }

  async function withIssueRelationSummaries<T extends { id: string }>(
    companyId: string,
    rows: T[],
    dbOrTx: DbReader = db,
  ): Promise<Array<T & IssueRelationSummaryMap>> {
    if (rows.length === 0) return [];
    const relationMap = await getIssueRelationSummaryMap(
      companyId,
      rows.map((row) => row.id),
      dbOrTx,
    );
    return rows.map((row) => ({
      ...row,
      ...(relationMap.get(row.id) ?? { blockedBy: [], blocks: [] }),
    }));
  }

  async function assertNoBlockingCycles(
    companyId: string,
    issueId: string,
    blockerIssueIds: string[],
    dbOrTx: DbReader = db,
  ) {
    if (blockerIssueIds.length === 0) return;

    const rows = await dbOrTx
      .select({
        blockerIssueId: issueRelations.issueId,
        blockedIssueId: issueRelations.relatedIssueId,
      })
      .from(issueRelations)
      .where(and(eq(issueRelations.companyId, companyId), eq(issueRelations.type, "blocks")));

    const adjacency = new Map<string, string[]>();
    for (const row of rows) {
      const list = adjacency.get(row.blockerIssueId) ?? [];
      list.push(row.blockedIssueId);
      adjacency.set(row.blockerIssueId, list);
    }

    for (const blockerIssueId of blockerIssueIds) {
      const queue = [...(adjacency.get(issueId) ?? [])];
      const visited = new Set<string>([issueId]);
      while (queue.length > 0) {
        const current = queue.shift()!;
        if (current === blockerIssueId) {
          throw unprocessable("Blocking relations cannot contain cycles");
        }
        if (visited.has(current)) continue;
        visited.add(current);
        queue.push(...(adjacency.get(current) ?? []));
      }
    }
  }

  async function lockBlockedByIssueRowsForUpdate(
    issueId: string,
    companyId: string,
    blockedByIssueIds: string[],
    dbOrTx: any = db,
  ) {
    const lockedIssueIds = [issueId, ...new Set(blockedByIssueIds)].sort();
    await dbOrTx.execute(
      sql`SELECT ${issues.id} FROM ${issues}
          WHERE ${and(eq(issues.companyId, companyId), inArray(issues.id, lockedIssueIds))}
          ORDER BY ${issues.id}
          FOR UPDATE`,
    );
  }

  async function syncBlockedByIssueIds(
    issueId: string,
    companyId: string,
    blockedByIssueIds: string[],
    actor: { agentId?: string | null; userId?: string | null } = {},
    dbOrTx: any = db,
  ) {
    const deduped = [...new Set(blockedByIssueIds)];
    if (deduped.some((candidate) => candidate === issueId)) {
      throw unprocessable("Issue cannot be blocked by itself");
    }

    if (deduped.length > 0) {
      await lockBlockedByIssueRowsForUpdate(issueId, companyId, deduped, dbOrTx);
      const relatedIssues = await dbOrTx
        .select({ id: issues.id })
        .from(issues)
        .where(and(eq(issues.companyId, companyId), inArray(issues.id, deduped)));
      if (relatedIssues.length !== deduped.length) {
        throw unprocessable("Blocked-by issues must belong to the same company");
      }
      await assertNoBlockingCycles(companyId, issueId, deduped, dbOrTx);
    }

    await dbOrTx
      .delete(issueRelations)
      .where(
        and(
          eq(issueRelations.companyId, companyId),
          eq(issueRelations.relatedIssueId, issueId),
          eq(issueRelations.type, "blocks"),
        ),
      );

    if (deduped.length === 0) return;

    await dbOrTx.insert(issueRelations).values(
      deduped.map((blockerIssueId) => ({
        companyId,
        issueId: blockerIssueId,
        relatedIssueId: issueId,
        type: "blocks",
        createdByAgentId: actor.agentId ?? null,
        createdByUserId: actor.userId ?? null,
      })),
    );
  }

  async function isTerminalOrMissingHeartbeatRun(runId: string, dbOrTx: DbReader = db) {
    const run = await dbOrTx
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    if (!run) return true;
    return TERMINAL_HEARTBEAT_RUN_STATUSES.has(run.status);
  }

  async function cancelNeverStartedOwnerRun(
    dbOrTx: any,
    run: {
      id: string;
      status: string;
      startedAt: Date | null;
      wakeupRequestId: string | null;
    } | null | undefined,
    input: { reason: string; errorCode: string },
  ) {
    if (!run || TERMINAL_HEARTBEAT_RUN_STATUSES.has(run.status)) return true;
    if (!isReapableHeartbeatRunRow(run)) return false;

    const now = new Date();
    const cancelled: { wakeupRequestId: string | null } | null = await dbOrTx
      .update(heartbeatRuns)
      .set({
        status: "cancelled",
        finishedAt: now,
        error: input.reason,
        errorCode: input.errorCode,
        updatedAt: now,
      })
      .where(
        and(
          eq(heartbeatRuns.id, run.id),
          inArray(heartbeatRuns.status, STALE_ISSUE_CONTEXT_RUN_STATUSES),
          isNull(heartbeatRuns.startedAt),
        ),
      )
      .returning({ wakeupRequestId: heartbeatRuns.wakeupRequestId })
      .then((rows: Array<{ wakeupRequestId: string | null }>) => rows[0] ?? null);
    if (!cancelled) return false;

    const wakeupRequestId = cancelled.wakeupRequestId ?? run.wakeupRequestId;
    if (wakeupRequestId) {
      await dbOrTx
        .update(agentWakeupRequests)
        .set({
          status: "skipped",
          finishedAt: now,
          error: input.reason,
          updatedAt: now,
        })
        .where(eq(agentWakeupRequests.id, wakeupRequestId));
    }
    return true;
  }

  async function isSameAgentRetryOfRun(input: {
    actorRunId: string;
    expectedCheckoutRunId: string;
    actorAgentId: string;
  }) {
    const run = await db
      .select({ agentId: heartbeatRuns.agentId, retryOfRunId: heartbeatRuns.retryOfRunId })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, input.actorRunId))
      .then((rows) => rows[0] ?? null);

    return run?.agentId === input.actorAgentId && run.retryOfRunId === input.expectedCheckoutRunId;
  }

  async function isActiveActorRunForIssue(input: {
    issueId: string;
    companyId: string;
    actorAgentId: string;
    actorRunId: string;
  }) {
    const run = await db
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.id, input.actorRunId),
          eq(heartbeatRuns.companyId, input.companyId),
          eq(heartbeatRuns.agentId, input.actorAgentId),
          eq(heartbeatRuns.status, "running"),
        ),
      )
      .then((rows) => rows[0] ?? null);

    if (!run || !run.contextSnapshot || typeof run.contextSnapshot !== "object" || Array.isArray(run.contextSnapshot)) {
      return false;
    }
    const context = run.contextSnapshot as Record<string, unknown>;
    return context.issueId === input.issueId || context.taskId === input.issueId;
  }

  async function isActorRunNewerThanIssueOwners(input: {
    companyId: string;
    actorRunId: string;
    ownerRunIds: string[];
  }) {
    const ownerRunIds = [...new Set(input.ownerRunIds.filter((id) => id && id !== input.actorRunId))];
    if (ownerRunIds.length === 0) return true;

    const rows = await db
      .select({ id: heartbeatRuns.id, createdAt: heartbeatRuns.createdAt })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, input.companyId),
          inArray(heartbeatRuns.id, [input.actorRunId, ...ownerRunIds]),
        ),
      );
    const createdAtByRunId = new Map(rows.map((row) => [row.id, row.createdAt.getTime()]));
    const actorCreatedAt = createdAtByRunId.get(input.actorRunId);
    if (actorCreatedAt == null) return false;

    return ownerRunIds.every((ownerRunId) => {
      const ownerCreatedAt = createdAtByRunId.get(ownerRunId);
      return ownerCreatedAt == null || actorCreatedAt > ownerCreatedAt;
    });
  }

  async function adoptActiveActorIssueRun(input: {
    issueId: string;
    companyId: string;
    actorAgentId: string;
    actorRunId: string;
    expectedCheckoutRunId: string | null;
    expectedExecutionRunId: string | null;
  }) {
    if (!(await isActiveActorRunForIssue(input))) return null;
    if (!(await isActorRunNewerThanIssueOwners({
      companyId: input.companyId,
      actorRunId: input.actorRunId,
      ownerRunIds: [input.expectedCheckoutRunId, input.expectedExecutionRunId].filter((id): id is string => Boolean(id)),
    }))) return null;

    const now = new Date();
    return db
      .update(issues)
      .set({
        checkoutRunId: input.actorRunId,
        executionRunId: input.actorRunId,
        executionLockedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(issues.id, input.issueId),
          eq(issues.companyId, input.companyId),
          eq(issues.status, "in_progress"),
          eq(issues.assigneeAgentId, input.actorAgentId),
          input.expectedCheckoutRunId
            ? eq(issues.checkoutRunId, input.expectedCheckoutRunId)
            : isNull(issues.checkoutRunId),
          input.expectedExecutionRunId
            ? eq(issues.executionRunId, input.expectedExecutionRunId)
            : undefined,
        ),
      )
      .returning({
        id: issues.id,
        companyId: issues.companyId,
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .then((rows) => rows[0] ?? null);
  }

  async function adoptStaleCheckoutRun(input: {
    issueId: string;
    actorAgentId: string;
    actorRunId: string;
    expectedCheckoutRunId: string;
  }) {
    const result = await db.transaction(async (tx) => {
      const lockedIssue = await tx
        .select({
          id: issues.id,
          companyId: issues.companyId,
          status: issues.status,
          assigneeAgentId: issues.assigneeAgentId,
          checkoutRunId: issues.checkoutRunId,
          executionRunId: issues.executionRunId,
        })
        .from(issues)
        .where(eq(issues.id, input.issueId))
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (!lockedIssue) {
        return { adopted: null, latest: null };
      }

      if (
        lockedIssue.status !== "in_progress" ||
        lockedIssue.assigneeAgentId !== input.actorAgentId ||
        lockedIssue.checkoutRunId !== input.expectedCheckoutRunId
      ) {
        return { adopted: null, latest: lockedIssue };
      }

      const ownerRunIds = [...new Set([
        input.expectedCheckoutRunId,
        lockedIssue.executionRunId,
        input.actorRunId,
      ].filter((runId): runId is string => Boolean(runId)))].sort();
      const lockedRuns = await tx
        .select({
          id: heartbeatRuns.id,
          status: heartbeatRuns.status,
          startedAt: heartbeatRuns.startedAt,
          agentId: heartbeatRuns.agentId,
          retryOfRunId: heartbeatRuns.retryOfRunId,
          wakeupRequestId: heartbeatRuns.wakeupRequestId,
        })
        .from(heartbeatRuns)
        .where(inArray(heartbeatRuns.id, ownerRunIds))
        .orderBy(asc(heartbeatRuns.id))
        .for("update");
      const runById = new Map(lockedRuns.map((run) => [run.id, run]));
      const existingRun = runById.get(input.expectedCheckoutRunId) ?? null;
      const actorRun = runById.get(input.actorRunId) ?? null;
      const executionOwnerRun = lockedIssue.executionRunId
        ? runById.get(lockedIssue.executionRunId) ?? null
        : null;
      // BLO-20321: same reapability rule as clearStaleExecutionLock. This test
      // runs FIRST when checkoutRunId is set, so a divergence here would make the
      // fix unreachable for the common shape (checkout and execution locks both
      // pointing at one never-started run).
      const stale = isReapableHeartbeatRunRow(existingRun);
      const actorLive = actorRun && !TERMINAL_HEARTBEAT_RUN_STATUSES.has(actorRun.status);
      const sameAgentRetry =
        actorRun?.agentId === input.actorAgentId &&
        actorRun.retryOfRunId === input.expectedCheckoutRunId;
      if ((!stale && !sameAgentRetry) || !actorLive) {
        return { adopted: null, latest: lockedIssue };
      }

      const executionOwnerIsAllowed =
        !lockedIssue.executionRunId ||
        lockedIssue.executionRunId === input.actorRunId ||
        lockedIssue.executionRunId === input.expectedCheckoutRunId ||
        isReapableHeartbeatRunRow(executionOwnerRun);
      if (!executionOwnerIsAllowed) {
        return { adopted: null, latest: lockedIssue };
      }

      const cancellation = {
        reason: "Cancelled because the issue checkout was adopted by the current execution run",
        errorCode: "issue_checkout_adopted",
      };
      if (
        !(await cancelNeverStartedOwnerRun(tx, existingRun, cancellation)) ||
        (lockedIssue.executionRunId !== input.expectedCheckoutRunId &&
          lockedIssue.executionRunId !== input.actorRunId &&
          !(await cancelNeverStartedOwnerRun(tx, executionOwnerRun, cancellation)))
      ) {
        return { adopted: null, latest: lockedIssue };
      }

      const now = new Date();
      const adopted = await tx
        .update(issues)
        .set({
          checkoutRunId: input.actorRunId,
          executionRunId: input.actorRunId,
          executionLockedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(issues.id, input.issueId),
            eq(issues.status, "in_progress"),
            eq(issues.assigneeAgentId, input.actorAgentId),
            eq(issues.checkoutRunId, input.expectedCheckoutRunId),
            lockedIssue.executionRunId
              ? eq(issues.executionRunId, lockedIssue.executionRunId)
              : isNull(issues.executionRunId),
          ),
        )
        .returning({
          id: issues.id,
          companyId: issues.companyId,
          status: issues.status,
          assigneeAgentId: issues.assigneeAgentId,
          checkoutRunId: issues.checkoutRunId,
          executionRunId: issues.executionRunId,
        })
        .then((rows) => rows[0] ?? null);
      if (adopted) {
        return { adopted, latest: adopted };
      }

      const latest = await tx
        .select({
          id: issues.id,
          companyId: issues.companyId,
          status: issues.status,
          assigneeAgentId: issues.assigneeAgentId,
          checkoutRunId: issues.checkoutRunId,
          executionRunId: issues.executionRunId,
        })
        .from(issues)
        .where(eq(issues.id, input.issueId))
        .then((rows) => rows[0] ?? null);
      return { adopted: null, latest };
    });

    if (result.adopted) {
      await cancelStaleIssueContextRuns({
        companyId: result.adopted.companyId,
        issueId: result.adopted.id,
        keepRunId: input.actorRunId,
        reason: "Cancelled because the issue checkout was adopted by the current execution run",
        errorCode: "issue_checkout_adopted",
      });
    }

    return result;
  }

  async function adoptUnownedCheckoutRun(input: {
    issueId: string;
    actorAgentId: string;
    actorRunId: string;
  }) {
    const actorRun = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, input.actorRunId))
      .then((rows) => rows[0] ?? null);
    if (!actorRun || TERMINAL_HEARTBEAT_RUN_STATUSES.has(actorRun.status)) return null;

    const now = new Date();
    const adopted = await db
      .update(issues)
      .set({
        checkoutRunId: input.actorRunId,
        executionRunId: input.actorRunId,
        executionLockedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(issues.id, input.issueId),
          eq(issues.status, "in_progress"),
          eq(issues.assigneeAgentId, input.actorAgentId),
          isNull(issues.checkoutRunId),
          or(isNull(issues.executionRunId), eq(issues.executionRunId, input.actorRunId)),
        ),
      )
      .returning({
        id: issues.id,
        companyId: issues.companyId,
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .then((rows) => rows[0] ?? null);

    if (adopted) {
      await cancelStaleIssueContextRuns({
        companyId: adopted.companyId,
        issueId: adopted.id,
        keepRunId: input.actorRunId,
        reason: "Cancelled because the issue checkout was adopted by the current execution run",
        errorCode: "issue_checkout_adopted",
      });
    }

    return adopted;
  }

  async function clearExecutionRunIfTerminal(issueId: string): Promise<boolean> {
    return db.transaction(async (tx) => {
      await tx.execute(
        sql`select ${issues.id} from ${issues} where ${issues.id} = ${issueId} for update`,
      );
      const issue = await tx
        .select({ executionRunId: issues.executionRunId })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null);
      if (!issue?.executionRunId) return false;

      await tx.execute(
        sql`select ${heartbeatRuns.id} from ${heartbeatRuns} where ${heartbeatRuns.id} = ${issue.executionRunId} for update`,
      );
      const run = await tx
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, issue.executionRunId))
        .then((rows) => rows[0] ?? null);
      if (run && !TERMINAL_HEARTBEAT_RUN_STATUSES.has(run.status)) return false;

      const updated = await tx
        .update(issues)
        .set({
          executionRunId: null,
          executionAgentNameKey: null,
          executionLockedAt: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(issues.id, issueId),
            eq(issues.executionRunId, issue.executionRunId),
          ),
        )
        .returning({ id: issues.id })
        .then((rows) => rows[0] ?? null);

      return Boolean(updated);
    });
  }

  async function clearStaleExecutionLock(input: {
    issueId: string;
    expectedCheckoutRunId: string | null;
    expectedExecutionRunId: string;
    actorRunId: string | null;
  }) {
    // BLO-20321: reap never-started (`queued` / `scheduled_retry`) owners as well
    // as terminal ones. Callers re-acquire the lock and then run
    // cancelStaleIssueContextRuns(keepRunId: <actor run>), which cancels the
    // superseded run — so it cannot start later against a status the assignee has
    // since changed.
    return db.transaction(async (tx) => {
      const issue = await tx
        .select({
          checkoutRunId: issues.checkoutRunId,
          executionRunId: issues.executionRunId,
        })
        .from(issues)
        .where(eq(issues.id, input.issueId))
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (
        issue?.executionRunId !== input.expectedExecutionRunId ||
        issue.checkoutRunId !== input.expectedCheckoutRunId
      ) return false;

      const ownerRunIds = [...new Set([
        input.expectedExecutionRunId,
        input.expectedCheckoutRunId,
      ].filter((runId): runId is string => Boolean(runId)))].sort();
      const ownerRuns = await tx
        .select({
          id: heartbeatRuns.id,
          status: heartbeatRuns.status,
          startedAt: heartbeatRuns.startedAt,
          wakeupRequestId: heartbeatRuns.wakeupRequestId,
        })
        .from(heartbeatRuns)
        .where(inArray(heartbeatRuns.id, ownerRunIds))
        .orderBy(asc(heartbeatRuns.id))
        .for("update")
      const ownerRunById = new Map(ownerRuns.map((run) => [run.id, run]));
      const executionOwnerRun = ownerRunById.get(input.expectedExecutionRunId) ?? null;
      const distinctCheckoutOwnerId = input.expectedCheckoutRunId !== null &&
        input.expectedCheckoutRunId !== input.actorRunId &&
        input.expectedCheckoutRunId !== input.expectedExecutionRunId
          ? input.expectedCheckoutRunId
          : null;
      const distinctCheckoutOwnerRun = distinctCheckoutOwnerId
        ? ownerRunById.get(distinctCheckoutOwnerId) ?? null
        : null;
      if (distinctCheckoutOwnerId && !isReapableHeartbeatRunRow(distinctCheckoutOwnerRun)) {
        return false;
      }

      const cancellation = {
        reason: "Cancelled because the stale issue execution lock was released",
        errorCode: "issue_execution_lock_reaped",
      };
      if (
        !(await cancelNeverStartedOwnerRun(tx, executionOwnerRun, cancellation)) ||
        (distinctCheckoutOwnerId &&
          !(await cancelNeverStartedOwnerRun(tx, distinctCheckoutOwnerRun, cancellation)))
      ) return false;

      const cleared = await tx
        .update(issues)
        .set({
          executionRunId: null,
          executionAgentNameKey: null,
          executionLockedAt: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(issues.id, input.issueId),
            eq(issues.executionRunId, input.expectedExecutionRunId),
            input.expectedCheckoutRunId
              ? eq(issues.checkoutRunId, input.expectedCheckoutRunId)
              : isNull(issues.checkoutRunId),
          ),
        )
        .returning({ id: issues.id })
        .then((rows) => rows[0] ?? null);

      return cleared != null;
    });
  }

  async function cancelStaleIssueContextRuns(input: {
    companyId: string;
    issueId: string;
    keepRunId?: string | null;
    reason: string;
    errorCode: string;
  }, dbOrTx: any = db) {
    const now = new Date();
    const conditions: SQL[] = [
      eq(heartbeatRuns.companyId, input.companyId),
      inArray(heartbeatRuns.status, STALE_ISSUE_CONTEXT_RUN_STATUSES),
      sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${input.issueId}`,
    ];
    if (input.keepRunId) {
      conditions.push(ne(heartbeatRuns.id, input.keepRunId));
    }

    const cancelled: Array<{ id: string; wakeupRequestId: string | null }> = await dbOrTx
      .update(heartbeatRuns)
      .set({
        status: "cancelled",
        finishedAt: now,
        error: input.reason,
        errorCode: input.errorCode,
        updatedAt: now,
      })
      .where(and(...conditions))
      .returning({
        id: heartbeatRuns.id,
        wakeupRequestId: heartbeatRuns.wakeupRequestId,
      });

    const wakeupRequestIds = cancelled
      .map((run: { wakeupRequestId: string | null }) => run.wakeupRequestId)
      .filter((id: string | null): id is string => Boolean(id));
    if (wakeupRequestIds.length > 0) {
      await dbOrTx
        .update(agentWakeupRequests)
        .set({
          status: "skipped",
          finishedAt: now,
          error: input.reason,
          updatedAt: now,
        })
        .where(inArray(agentWakeupRequests.id, wakeupRequestIds));
    }

    return cancelled.length;
  }

  // Symmetric to clearExecutionRunIfTerminal. Clears checkoutRunId (and the
  // bundled execution lock cols) when the row's checkoutRunId points at a
  // heartbeat run that is terminal or no longer exists. No assignee/status
  // precondition: a terminal run holds no real claim regardless of who is
  // assigned or what status the issue is currently in.
  async function clearCheckoutRunIfTerminal(issueId: string): Promise<boolean> {
    return db.transaction(async (tx) => {
      await tx.execute(
        sql`select ${issues.id} from ${issues} where ${issues.id} = ${issueId} for update`,
      );
      const issue = await tx
        .select({ checkoutRunId: issues.checkoutRunId, executionRunId: issues.executionRunId })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null);
      if (!issue?.checkoutRunId) return false;

      await tx.execute(
        sql`select ${heartbeatRuns.id} from ${heartbeatRuns} where ${heartbeatRuns.id} = ${issue.checkoutRunId} for update`,
      );
      const run = await tx
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, issue.checkoutRunId))
        .then((rows) => rows[0] ?? null);
      if (run && !TERMINAL_HEARTBEAT_RUN_STATUSES.has(run.status)) return false;

      if (issue.executionRunId && issue.executionRunId !== issue.checkoutRunId) {
        await tx.execute(
          sql`select ${heartbeatRuns.id} from ${heartbeatRuns} where ${heartbeatRuns.id} = ${issue.executionRunId} for update`,
        );
        const executionRun = await tx
          .select({ status: heartbeatRuns.status })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, issue.executionRunId))
          .then((rows) => rows[0] ?? null);
        if (executionRun && !TERMINAL_HEARTBEAT_RUN_STATUSES.has(executionRun.status)) return false;
      }

      const updated = await tx
        .update(issues)
        .set({
          checkoutRunId: null,
          executionRunId: null,
          executionAgentNameKey: null,
          executionLockedAt: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(issues.id, issueId),
            eq(issues.checkoutRunId, issue.checkoutRunId),
            issue.executionRunId
              ? eq(issues.executionRunId, issue.executionRunId)
              : isNull(issues.executionRunId),
          ),
        )
        .returning({ id: issues.id })
        .then((rows) => rows[0] ?? null);

      return Boolean(updated);
    });
  }

  return {
    clearExecutionRunIfTerminal,
    clearCheckoutRunIfTerminal,

    list: async (companyId: string, filters?: IssueFilters) => {
      if (filters?.attention === "blocked") {
        return listBlockedInboxIssues(db, companyId, {
          ...filters,
          includeBlockedBy: true,
          includeBlockedInboxAttention: true,
        });
      }

      const conditions = [eq(issues.companyId, companyId), visibleIssueCondition()];
      const assigneeAgentFilter = parseIssueAssigneeAgentFilter(filters?.assigneeAgentId);
      assertValidAssigneeAgentFilter(assigneeAgentFilter);
      const limit = typeof filters?.limit === "number" && Number.isFinite(filters.limit)
        ? Math.max(1, Math.floor(filters.limit))
        : undefined;
      const offset = typeof filters?.offset === "number" && Number.isFinite(filters.offset)
        ? Math.max(0, Math.floor(filters.offset))
        : 0;
      const touchedByUserId = filters?.touchedByUserId?.trim() || undefined;
      const inboxArchivedByUserId = filters?.inboxArchivedByUserId?.trim() || undefined;
      const unreadForUserId = filters?.unreadForUserId?.trim() || undefined;
      const contextUserId = unreadForUserId ?? touchedByUserId ?? inboxArchivedByUserId;
      const includeBlockedBy = filters?.includeBlockedBy === true;
      const includeBlockedInboxAttention = filters?.includeBlockedInboxAttention === true;
      const includeLiveDescendantSummary = filters?.includeLiveDescendantSummary === true;
      const rawSearch = filters?.q?.trim() ?? "";
      const hasSearch = rawSearch.length > 0;
      const escapedSearch = hasSearch ? escapeLikePattern(rawSearch) : "";
      const startsWithPattern = `${escapedSearch}%`;
      const containsPattern = `%${escapedSearch}%`;
      const titleStartsWithMatch = sql<boolean>`${issues.title} ILIKE ${startsWithPattern} ESCAPE '\\'`;
      const titleContainsMatch = sql<boolean>`${issues.title} ILIKE ${containsPattern} ESCAPE '\\'`;
      const identifierStartsWithMatch = sql<boolean>`${issues.identifier} ILIKE ${startsWithPattern} ESCAPE '\\'`;
      const identifierContainsMatch = sql<boolean>`${issues.identifier} ILIKE ${containsPattern} ESCAPE '\\'`;
      const descriptionContainsMatch = sql<boolean>`${issues.description} ILIKE ${containsPattern} ESCAPE '\\'`;
      const commentContainsMatch = sql<boolean>`
        EXISTS (
          SELECT 1
          FROM ${issueComments}
          WHERE ${issueComments.issueId} = ${issues.id}
            AND ${issueComments.companyId} = ${companyId}
            AND ${issueComments.deletedAt} IS NULL
            AND ${issueComments.body} ILIKE ${containsPattern} ESCAPE '\\'
        )
      `;
      if (filters?.descendantOf) {
        conditions.push(sql<boolean>`
          ${issues.id} IN (
            WITH RECURSIVE descendants(id) AS (
              SELECT ${issues.id}
              FROM ${issues}
              WHERE ${issues.companyId} = ${companyId}
                AND ${issues.parentId} = ${filters.descendantOf}
              UNION
              SELECT ${issues.id}
              FROM ${issues}
              JOIN descendants ON ${issues.parentId} = descendants.id
              WHERE ${issues.companyId} = ${companyId}
            )
            SELECT id FROM descendants
          )
        `);
      }
      const lowTrustCondition = lowTrustBoundaryIssueCondition(companyId, filters?.lowTrustBoundary);
      if (lowTrustCondition) conditions.push(lowTrustCondition);
      if (filters?.status) {
        const statuses = parseStatusFilter(filters.status);
        conditions.push(statuses.length === 1 ? eq(issues.status, statuses[0]) : inArray(issues.status, statuses));
      }
      if (assigneeAgentFilter === null) {
        conditions.push(isNull(issues.assigneeAgentId));
      } else if (assigneeAgentFilter) {
        conditions.push(eq(issues.assigneeAgentId, assigneeAgentFilter));
      }
      if (filters?.participantAgentId) {
        conditions.push(participatedByAgentCondition(companyId, filters.participantAgentId));
      }
      if (filters?.assigneeUserId) {
        conditions.push(eq(issues.assigneeUserId, filters.assigneeUserId));
      }
      if (touchedByUserId) {
        conditions.push(touchedByUserCondition(companyId, touchedByUserId));
      }
      if (inboxArchivedByUserId) {
        conditions.push(inboxVisibleForUserCondition(companyId, inboxArchivedByUserId));
      }
      if (unreadForUserId) {
        conditions.push(unreadForUserCondition(companyId, unreadForUserId));
      }
      if (filters?.projectId) conditions.push(eq(issues.projectId, filters.projectId));
      if (filters?.workspaceId) {
        conditions.push(or(
          eq(issues.executionWorkspaceId, filters.workspaceId),
          eq(issues.projectWorkspaceId, filters.workspaceId),
        )!);
      }
      if (filters?.executionWorkspaceId) {
        conditions.push(eq(issues.executionWorkspaceId, filters.executionWorkspaceId));
      }
      if (filters?.parentId) conditions.push(eq(issues.parentId, filters.parentId));
      if (filters?.originKind) conditions.push(eq(issues.originKind, filters.originKind));
      if (filters?.originKindPrefix) conditions.push(like(issues.originKind, `${filters.originKindPrefix}%`));
      if (filters?.originId) conditions.push(eq(issues.originId, filters.originId));
      if (filters?.originFingerprint) conditions.push(eq(issues.originFingerprint, filters.originFingerprint));
      if (filters?.hasPlanDocument !== undefined) {
        conditions.push(hasPlanDocumentCondition(companyId, filters.hasPlanDocument));
      }
      if (!shouldIncludePluginOperationIssues(filters)) {
        conditions.push(nonPluginOperationIssueCondition());
      }
      if (filters?.labelId) {
        const labeledIssueIds = await db
          .select({ issueId: issueLabels.issueId })
          .from(issueLabels)
          .where(and(eq(issueLabels.companyId, companyId), eq(issueLabels.labelId, filters.labelId)));
        if (labeledIssueIds.length === 0) return [];
        conditions.push(inArray(issues.id, labeledIssueIds.map((row) => row.issueId)));
      }
      if (hasSearch) {
        conditions.push(
          or(
            titleContainsMatch,
            identifierContainsMatch,
            descriptionContainsMatch,
            commentContainsMatch,
          )!,
        );
      }
      if (
        (filters?.excludeRoutineExecutions && !filters?.originKind && !filters?.originKindPrefix && !filters?.originId) ||
        shouldExcludeRoutineExecutionIssues(filters)
      ) {
        conditions.push(nonRoutineExecutionIssueCondition());
      }
      const priorityOrder = sql`CASE ${issues.priority} WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END`;
      const searchOrder = sql<number>`
        CASE
          WHEN ${titleStartsWithMatch} THEN 0
          WHEN ${titleContainsMatch} THEN 1
          WHEN ${identifierStartsWithMatch} THEN 2
          WHEN ${identifierContainsMatch} THEN 3
          WHEN ${commentContainsMatch} THEN 4
          WHEN ${descriptionContainsMatch} THEN 5
          ELSE 6
        END
      `;
      const baseQuery = db
        .select(issueListSelect)
        .from(issues)
        .where(and(...conditions))
        .orderBy(...issueListOrderBy(companyId, {
          hasSearch,
          priorityOrder,
          searchOrder,
          sortField: filters?.sortField,
          sortDir: filters?.sortDir,
        }));
      const pageQuery = offset > 0
        ? (limit === undefined ? baseQuery.offset(offset) : baseQuery.limit(limit).offset(offset))
        : (limit === undefined ? baseQuery : baseQuery.limit(limit));
      const rows = await pageQuery;
      const withLabels = await withIssueLabels(db, rows);
      const runMap = await activeRunMapForIssues(db, withLabels);
      const withRuns = withActiveRuns(withLabels, runMap);
      if (withRuns.length === 0) {
        return withRuns;
      }

      const issueIds = withRuns.map((row) => row.id);
      const [statsRows, readRows, lastActivityRows, archiveRows, blockedByMap, liveDescendantCountByIssueId] = await Promise.all([
        contextUserId
          ? userCommentStatsForIssues(db, companyId, contextUserId, issueIds)
          : Promise.resolve([]),
        contextUserId
          ? userReadStatsForIssues(db, companyId, contextUserId, issueIds)
          : Promise.resolve([]),
        lastActivityStatsForIssues(db, companyId, issueIds),
        contextUserId
          ? inboxArchiveRowsForIssues(db, companyId, contextUserId, issueIds)
          : Promise.resolve([]),
        includeBlockedBy
          ? blockedByMapForIssues(db, companyId, issueIds)
          : Promise.resolve(new Map<string, IssueRelationIssueSummary[]>()),
        includeLiveDescendantSummary
          ? liveDescendantCountMapForIssues(db, companyId, issueIds)
          : Promise.resolve(new Map<string, number>()),
      ]);
      const statsByIssueId = new Map(statsRows.map((row) => [row.issueId, row]));
      const lastActivityByIssueId = new Map(lastActivityRows.map((row) => [row.issueId, row]));
      const archiveByIssueId = new Map(archiveRows.map((row) => [row.issueId, row]));
      const [
        blockerAttentionByIssueId,
        productivityReviewByIssueId,
        blockedInboxAttentionByIssueId,
      ] = await Promise.all([
        listIssueBlockerAttentionMap(db, companyId, withRuns),
        listIssueProductivityReviewMap(db, companyId, issueIds),
        includeBlockedInboxAttention
          ? listIssueBlockedInboxAttentionMap(db, companyId, withRuns)
          : Promise.resolve(new Map<string, IssueBlockedInboxAttention>()),
      ]);

      if (!contextUserId) {
        return withRuns.map((row) => {
          const activity = lastActivityByIssueId.get(row.id);
          const lastActivityAt = latestIssueActivityAt(
            row.updatedAt,
            activity?.latestCommentAt ?? null,
            activity?.latestLogAt ?? null,
          ) ?? row.updatedAt;
          return {
            ...row,
            ...(includeBlockedBy ? { blockedBy: blockedByMap.get(row.id) ?? [] } : {}),
            lastActivityAt,
            ...(blockerAttentionByIssueId.has(row.id) ? { blockerAttention: blockerAttentionByIssueId.get(row.id) } : {}),
            ...(includeBlockedInboxAttention ? { blockedInboxAttention: blockedInboxAttentionByIssueId.get(row.id) ?? null } : {}),
            ...(includeLiveDescendantSummary ? { liveDescendantCount: liveDescendantCountByIssueId.get(row.id) ?? 0 } : {}),
            ...(productivityReviewByIssueId.has(row.id)
              ? { productivityReview: productivityReviewByIssueId.get(row.id) }
              : {}),
          };
        });
      }

      const readByIssueId = new Map(readRows.map((row) => [row.issueId, row.myLastReadAt]));

      return withRuns.map((row) => {
        const activity = lastActivityByIssueId.get(row.id);
        const lastActivityAt = latestIssueActivityAt(
          row.updatedAt,
          activity?.latestCommentAt ?? null,
          activity?.latestLogAt ?? null,
        ) ?? row.updatedAt;
        return {
          ...row,
          ...activeInboxArchiveFields(archiveByIssueId.get(row.id), lastActivityAt),
          ...(includeBlockedBy ? { blockedBy: blockedByMap.get(row.id) ?? [] } : {}),
          lastActivityAt,
          ...(blockerAttentionByIssueId.has(row.id) ? { blockerAttention: blockerAttentionByIssueId.get(row.id) } : {}),
          ...(includeBlockedInboxAttention ? { blockedInboxAttention: blockedInboxAttentionByIssueId.get(row.id) ?? null } : {}),
          ...(includeLiveDescendantSummary ? { liveDescendantCount: liveDescendantCountByIssueId.get(row.id) ?? 0 } : {}),
          ...(productivityReviewByIssueId.has(row.id)
            ? { productivityReview: productivityReviewByIssueId.get(row.id) }
            : {}),
          ...deriveIssueUserContext(row, contextUserId, {
            myLastCommentAt: statsByIssueId.get(row.id)?.myLastCommentAt ?? null,
            myLastReadAt: readByIssueId.get(row.id) ?? null,
            lastExternalCommentAt: statsByIssueId.get(row.id)?.lastExternalCommentAt ?? null,
          }),
        };
      });
    },

    count: async (companyId: string, filters?: IssueFilters) => {
      if (filters?.attention === "blocked") {
        return countBlockedInboxIssues(db, companyId, filters);
      }

      const conditions = [eq(issues.companyId, companyId), visibleIssueCondition()];
      const statuses = parseStatusFilter(filters?.status);
      if (statuses.length === 1) conditions.push(eq(issues.status, statuses[0]!));
      else if (statuses.length > 1) conditions.push(inArray(issues.status, statuses));
      const assigneeAgentFilter = parseIssueAssigneeAgentFilter(filters?.assigneeAgentId);
      assertValidAssigneeAgentFilter(assigneeAgentFilter);
      if (assigneeAgentFilter === null) {
        conditions.push(isNull(issues.assigneeAgentId));
      } else if (assigneeAgentFilter) {
        conditions.push(eq(issues.assigneeAgentId, assigneeAgentFilter));
      }
      if (filters?.assigneeUserId) conditions.push(eq(issues.assigneeUserId, filters.assigneeUserId));
      if (filters?.projectId) conditions.push(eq(issues.projectId, filters.projectId));
      if (filters?.workspaceId) {
        conditions.push(or(
          eq(issues.executionWorkspaceId, filters.workspaceId),
          eq(issues.projectWorkspaceId, filters.workspaceId),
        )!);
      }
      if (filters?.executionWorkspaceId) conditions.push(eq(issues.executionWorkspaceId, filters.executionWorkspaceId));
      if (filters?.parentId) conditions.push(eq(issues.parentId, filters.parentId));
      if (filters?.originKind) conditions.push(eq(issues.originKind, filters.originKind));
      if (filters?.originKindPrefix) conditions.push(like(issues.originKind, `${filters.originKindPrefix}%`));
      if (filters?.originId) conditions.push(eq(issues.originId, filters.originId));
      if (filters?.originFingerprint) conditions.push(eq(issues.originFingerprint, filters.originFingerprint));
      if (filters?.hasPlanDocument !== undefined) {
        conditions.push(hasPlanDocumentCondition(companyId, filters.hasPlanDocument));
      }
      if (!shouldIncludePluginOperationIssues(filters)) conditions.push(nonPluginOperationIssueCondition());
      if (
        (filters?.excludeRoutineExecutions && !filters?.originKind && !filters?.originKindPrefix && !filters?.originId) ||
        shouldExcludeRoutineExecutionIssues(filters)
      ) {
        conditions.push(nonRoutineExecutionIssueCondition());
      }
      const [row] = await db
        .select({ count: sql<number>`count(*)` })
        .from(issues)
        .where(and(...conditions));
      return Number(row?.count ?? 0);
    },

    countUnreadTouchedByUser: async (
      companyId: string,
      userId: string,
      status?: string | readonly string[],
    ) => {
      const conditions = [
        eq(issues.companyId, companyId),
        visibleIssueCondition(),
        nonPluginOperationIssueCondition(),
        unreadForUserCondition(companyId, userId),
      ];
      const statuses = parseStatusFilter(status);
      if (statuses.length === 1) {
        conditions.push(eq(issues.status, statuses[0]));
      } else if (statuses.length > 1) {
        conditions.push(inArray(issues.status, statuses));
      }
      const [row] = await db
        .select({ count: sql<number>`count(*)` })
        .from(issues)
        .where(and(...conditions));
      return Number(row?.count ?? 0);
    },

    markRead: async (companyId: string, issueId: string, userId: string, readAt: Date = new Date()) => {
      const now = new Date();
      const [row] = await db
        .insert(issueReadStates)
        .values({
          companyId,
          issueId,
          userId,
          lastReadAt: readAt,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [issueReadStates.companyId, issueReadStates.issueId, issueReadStates.userId],
          set: {
            lastReadAt: readAt,
            updatedAt: now,
          },
        })
        .returning();
      return row;
    },

    markUnread: async (companyId: string, issueId: string, userId: string) => {
      const deleted = await db
        .delete(issueReadStates)
        .where(
          and(
            eq(issueReadStates.companyId, companyId),
            eq(issueReadStates.issueId, issueId),
            eq(issueReadStates.userId, userId),
          ),
        )
        .returning();
      return deleted.length > 0;
    },

    archiveInbox: async (
      companyId: string,
      issueId: string,
      userId: string,
      archivedAt: Date = new Date(),
      attribution?: {
        archivedByActorType: "user" | "agent";
        archivedByAgentId?: string | null;
        archivedByRunId?: string | null;
      },
    ) => {
      const now = new Date();
      const [row] = await db
        .insert(issueInboxArchives)
        .values({
          companyId,
          issueId,
          userId,
          archivedByActorType: attribution?.archivedByActorType ?? "user",
          archivedByAgentId: attribution?.archivedByAgentId ?? null,
          archivedByRunId: attribution?.archivedByRunId ?? null,
          archivedAt,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [issueInboxArchives.companyId, issueInboxArchives.issueId, issueInboxArchives.userId],
          set: {
            archivedAt,
            archivedByActorType: attribution?.archivedByActorType ?? "user",
            archivedByAgentId: attribution?.archivedByAgentId ?? null,
            archivedByRunId: attribution?.archivedByRunId ?? null,
            updatedAt: now,
          },
        })
        .returning();
      return row;
    },

    unarchiveInbox: async (companyId: string, issueId: string, userId: string) => {
      const [row] = await db
        .delete(issueInboxArchives)
        .where(
          and(
            eq(issueInboxArchives.companyId, companyId),
            eq(issueInboxArchives.issueId, issueId),
            eq(issueInboxArchives.userId, userId),
          ),
        )
        .returning();
      return row ?? null;
    },

    getActiveInboxArchiveFields: async (
      issue: Pick<IssueRow, "id" | "companyId" | "updatedAt">,
      userId: string,
    ) => {
      const [[activity], [archive]] = await Promise.all([
        lastActivityStatsForIssues(db, issue.companyId, [issue.id]),
        inboxArchiveRowsForIssues(db, issue.companyId, userId, [issue.id]),
      ]);
      const lastActivityAt = latestIssueActivityAt(
        issue.updatedAt,
        activity?.latestCommentAt ?? null,
        activity?.latestLogAt ?? null,
      ) ?? issue.updatedAt;
      return activeInboxArchiveFields(archive, lastActivityAt);
    },

    getById: async (raw: string) => {
      const id = raw.trim();
      const identifier = normalizeIssueReferenceIdentifier(id);
      if (identifier) {
        return getIssueByIdentifier(identifier);
      }
      if (!isUuidLike(id)) {
        return null;
      }
      return getIssueByUuid(id);
    },

    getByIdentifier: async (identifier: string) => {
      return getIssueByIdentifier(identifier);
    },

    /**
     * The queued-or-running run recorded for this issue, or null.
     *
     * BLO-19001: single-issue counterpart to the `activeRun` the list paths
     * attach via `withActiveRuns`. `getById` deliberately stays lean, so the
     * issue-detail route composes this in alongside its other enrichments.
     *
     * Null covers "no run recorded", "the recorded run belongs to another
     * company", and "the recorded run has already
     * terminalized" — `activeRunMapForIssues` only returns rows whose status is
     * in ACTIVE_RUN_STATUSES. That is the distinction a caller needs: a stale
     * `executionRunId` left behind by a finished run reads as not-held, while a
     * live sibling run reads as present. A queued run is present but does not
     * yet hold a worktree; callers should use `isRunHoldingIssue` for that
     * stricter cede decision.
     */
    getActiveRun: async (
      issue: Pick<IssueRow, "companyId" | "executionRunId">,
    ): Promise<IssueActiveRunRow | null> => {
      if (!issue.executionRunId) return null;
      const map = await activeRunMapForIssues(db, [issue]);
      return map.get(activeRunMapKey(issue.companyId, issue.executionRunId)) ?? null;
    },

    /**
     * Find a paperclip issue by its Linear-side issue id via the
     * `linear_issue_links` table. Used by the Linear plugin's webhook
     * create handler to detect mirrors written by the host's allocator
     * path (`originKind != 'plugin:paperclip-plugin-linear'` parents
     * with linker rows). Without this lookup, the plugin's own dedup
     * (originKind+originId, plugin_state IssueLink) misses host-allocator
     * mirrors and creates duplicates — closing the post-cutover loop.
     *
     * Scoped to (companyId, linearIssueId) — matches the allocator-write
     * path's row shape. Returns null when no link exists.
     */
    getByLinearIssueId: async (companyId: string, linearIssueId: string) => {
      const link = await db
        .select({ paperclipIssueId: linearIssueLinks.paperclipIssueId })
        .from(linearIssueLinks)
        .where(
          and(
            eq(linearIssueLinks.companyId, companyId),
            eq(linearIssueLinks.linearIssueId, linearIssueId),
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (!link) return null;
      const issue = await getIssueByUuid(link.paperclipIssueId);
      if (!issue) {
        // Skew: link row points to a paperclip_issue_id that no longer
        // resolves. The FK is ON DELETE CASCADE so this should be
        // unreachable under normal operation; surface as console.error
        // so a pg_dump-restore mishap or out-of-band hard-delete is
        // caught instead of silently masquerading as "no link" — which
        // would make the caller (Linear plugin webhook handler) fall
        // through to mint path and re-open the loop.
        console.error(
          `[issues.getByLinearIssueId] linear_issue_links row for ` +
            `companyId=${companyId} linearIssueId=${linearIssueId} ` +
            `points to missing issues.id=${link.paperclipIssueId}; ` +
            `returning null but this is a data-integrity skew that ` +
            `should not be reachable through normal operations.`,
        );
      }
      return issue;
    },

    linkLinearIssue: async (
      companyId: string,
      input: {
        issueId: string;
        linearIssueId: string;
        linearIdentifier: string;
        replaceExisting?: boolean;
      },
    ) => {
      const issue = await getIssueByUuid(input.issueId);
      if (!issue || issue.companyId !== companyId) {
        throw notFound("Issue not found");
      }

      const matchingRows = await db
        .select({
          id: linearIssueLinks.id,
          companyId: linearIssueLinks.companyId,
          paperclipIssueId: linearIssueLinks.paperclipIssueId,
          linearIssueId: linearIssueLinks.linearIssueId,
          linearIdentifier: linearIssueLinks.linearIdentifier,
        })
        .from(linearIssueLinks)
        .where(
          or(
            eq(linearIssueLinks.paperclipIssueId, input.issueId),
            and(
              eq(linearIssueLinks.companyId, companyId),
              eq(linearIssueLinks.linearIssueId, input.linearIssueId),
            ),
            and(
              eq(linearIssueLinks.companyId, companyId),
              eq(linearIssueLinks.linearIdentifier, input.linearIdentifier),
            ),
          ),
        );

      const sameBinding = matchingRows.find((row) =>
        row.companyId === companyId
        && row.paperclipIssueId === input.issueId
        && row.linearIssueId === input.linearIssueId
      );
      const conflicts = matchingRows.filter((row) =>
        row.id !== sameBinding?.id
        && (
          row.companyId !== companyId
          || row.paperclipIssueId !== input.issueId
          || row.linearIssueId !== input.linearIssueId
          || row.linearIdentifier !== input.linearIdentifier
        )
      );
      if (conflicts.length > 0) {
        const replaceablePaperclipRow = input.replaceExisting
          ? matchingRows.find((row) =>
            row.companyId === companyId
            && row.paperclipIssueId === input.issueId
          )
          : null;
        const hasOnlySamePaperclipConflicts = conflicts.every((row) =>
          row.companyId === companyId
          && row.paperclipIssueId === input.issueId
        );
        if (replaceablePaperclipRow && hasOnlySamePaperclipConflicts) {
          await db
            .update(linearIssueLinks)
            .set({
              linearIssueId: input.linearIssueId,
              linearIdentifier: input.linearIdentifier,
              updatedAt: new Date(),
            })
            .where(eq(linearIssueLinks.id, replaceablePaperclipRow.id));
          return;
        }

        throw conflict("Linear issue link conflict", {
          issueId: input.issueId,
          linearIssueId: input.linearIssueId,
          linearIdentifier: input.linearIdentifier,
          conflicts,
        });
      }

      const existing = sameBinding ?? matchingRows[0];
      if (existing) {
        await db
          .update(linearIssueLinks)
          .set({
            linearIdentifier: input.linearIdentifier,
            updatedAt: new Date(),
          })
          .where(eq(linearIssueLinks.id, existing.id));
        return;
      }

      try {
        await db.insert(linearIssueLinks).values({
          companyId,
          paperclipIssueId: input.issueId,
          linearIssueId: input.linearIssueId,
          linearIdentifier: input.linearIdentifier,
        });
      } catch (err) {
        const maybe = err as { code?: string; constraint?: string; constraint_name?: string };
        if (maybe.code === "23505") {
          throw conflict("Linear issue link conflict", {
            issueId: input.issueId,
            linearIssueId: input.linearIssueId,
            linearIdentifier: input.linearIdentifier,
            constraint: maybe.constraint ?? maybe.constraint_name,
          });
        }
        throw err;
      }
    },

    getCurrentScheduledRetry: async (issueId: string) => {
      const issue = await db
        .select({ id: issues.id, companyId: issues.companyId })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null);
      if (!issue) throw notFound("Issue not found");
      return getCurrentScheduledRetryForIssue(issue.id, issue.companyId);
    },

    getRelationSummaries: async (issueId: string) => {
      const issue = await db
        .select({ id: issues.id, companyId: issues.companyId })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null);
      if (!issue) throw notFound("Issue not found");
      const relations = await getIssueRelationSummaryMap(issue.companyId, [issueId], db);
      return relations.get(issueId) ?? { blockedBy: [], blocks: [] };
    },

    getBlockerDiagnostics: async (
      issueId: string,
      maxBlockers = ISSUE_BLOCKER_DIAGNOSTICS_MAX_BLOCKERS,
    ) => {
      const issue = await db
        .select({ id: issues.id, companyId: issues.companyId })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null);
      if (!issue) throw notFound("Issue not found");

      const cappedMax = Math.max(0, Math.min(maxBlockers, ISSUE_BLOCKER_DIAGNOSTICS_MAX_BLOCKERS));
      const blockerRows = await db
        .select({
          id: issues.id,
          companyId: issues.companyId,
          projectId: issues.projectId,
          parentId: issues.parentId,
          identifier: issues.identifier,
          title: issues.title,
          status: issues.status,
          priority: issues.priority,
          assigneeAgentId: issues.assigneeAgentId,
          assigneeUserId: issues.assigneeUserId,
        })
        .from(issueRelations)
        .innerJoin(issues, eq(issueRelations.issueId, issues.id))
        .where(
          and(
            eq(issueRelations.companyId, issue.companyId),
            eq(issueRelations.type, "blocks"),
            eq(issueRelations.relatedIssueId, issue.id),
            eq(issues.companyId, issue.companyId),
          ),
        )
        .orderBy(asc(issues.title), asc(issues.id))
        .limit(cappedMax + 1);

      const readiness = await listIssueDependencyReadinessMap(db, issue.companyId, [issue.id]);

      return {
        blockers: blockerRows.slice(0, cappedMax) as IssueBlockerDiagnosticsIssueRow[],
        readiness: readiness.get(issue.id) ?? createIssueDependencyReadiness(issue.id),
        truncated: blockerRows.length > cappedMax,
      };
    },

    getWakeDiagnostics: async (
      issueId: string,
      opts?: {
        maxWakeRequests?: number;
        maxActivityRecords?: number;
        lookbackDays?: number;
      },
    ) => {
      const issue = await db
        .select({ id: issues.id, companyId: issues.companyId })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null);
      if (!issue) throw notFound("Issue not found");

      const maxWakeRequests = Math.max(
        0,
        Math.min(
          opts?.maxWakeRequests ?? ISSUE_WAKE_DIAGNOSTICS_MAX_WAKE_REQUESTS,
          ISSUE_WAKE_DIAGNOSTICS_MAX_WAKE_REQUESTS,
        ),
      );
      const maxActivityRecords = Math.max(
        0,
        Math.min(
          opts?.maxActivityRecords ?? ISSUE_WAKE_DIAGNOSTICS_MAX_ACTIVITY_RECORDS,
          ISSUE_WAKE_DIAGNOSTICS_MAX_ACTIVITY_RECORDS,
        ),
      );
      const lookbackDays = Math.max(
        1,
        Math.min(
          opts?.lookbackDays ?? ISSUE_WAKE_DIAGNOSTICS_LOOKBACK_DAYS,
          ISSUE_WAKE_DIAGNOSTICS_LOOKBACK_DAYS,
        ),
      );
      const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);

      const wakeRows = await db
        .select({
          agentId: agentWakeupRequests.agentId,
          source: agentWakeupRequests.source,
          reason: agentWakeupRequests.reason,
          status: agentWakeupRequests.status,
          coalescedCount: agentWakeupRequests.coalescedCount,
          runId: agentWakeupRequests.runId,
          requestedAt: agentWakeupRequests.requestedAt,
          claimedAt: agentWakeupRequests.claimedAt,
          finishedAt: agentWakeupRequests.finishedAt,
          error: agentWakeupRequests.error,
        })
        .from(agentWakeupRequests)
        .where(
          and(
            eq(agentWakeupRequests.companyId, issue.companyId),
            gte(agentWakeupRequests.requestedAt, since),
            wakeRequestTargetsIssue(issue.id),
          ),
        )
        .orderBy(desc(agentWakeupRequests.requestedAt), desc(agentWakeupRequests.createdAt))
        .limit(maxWakeRequests + 1);

      const activityRows = await db
        .select({
          action: activityLog.action,
          entityType: activityLog.entityType,
          entityId: activityLog.entityId,
          agentId: activityLog.agentId,
          runId: activityLog.runId,
          details: activityLog.details,
          createdAt: activityLog.createdAt,
        })
        .from(activityLog)
        .where(
          and(
            eq(activityLog.companyId, issue.companyId),
            gte(activityLog.createdAt, since),
            inArray(activityLog.action, [...ISSUE_WAKE_DIAGNOSTICS_ACTIVITY_ACTIONS]),
            wakeDiagnosticActivityTargetsIssue(issue.id),
          ),
        )
        .orderBy(desc(activityLog.createdAt))
        .limit(maxActivityRecords + 1);

      return {
        wakeRequests: wakeRows.slice(0, maxWakeRequests) as IssueWakeDiagnosticsWakeRequestRow[],
        activityRecords: activityRows.slice(0, maxActivityRecords) as IssueWakeDiagnosticsActivityRow[],
        truncatedWakeRequests: wakeRows.length > maxWakeRequests,
        truncatedActivityRecords: activityRows.length > maxActivityRecords,
        caps: {
          maxWakeRequests: ISSUE_WAKE_DIAGNOSTICS_MAX_WAKE_REQUESTS,
          maxActivityRecords: ISSUE_WAKE_DIAGNOSTICS_MAX_ACTIVITY_RECORDS,
          lookbackDays: ISSUE_WAKE_DIAGNOSTICS_LOOKBACK_DAYS,
        },
      };
    },

    getSubtreeDiagnostics: async (
      issueId: string,
      opts?: {
        maxDepth?: number;
        maxNodes?: number;
        maxBlockersPerNode?: number;
        maxWakeRequestsPerNode?: number;
        maxActivityRecordsPerNode?: number;
        lookbackDays?: number;
      },
    ) => {
      const issue = await db
        .select({ id: issues.id, companyId: issues.companyId })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null);
      if (!issue) throw notFound("Issue not found");

      const maxDepth = Math.max(
        0,
        Math.min(opts?.maxDepth ?? ISSUE_SUBTREE_DIAGNOSTICS_MAX_DEPTH, ISSUE_SUBTREE_DIAGNOSTICS_MAX_DEPTH),
      );
      const maxNodes = Math.max(
        1,
        Math.min(opts?.maxNodes ?? ISSUE_SUBTREE_DIAGNOSTICS_MAX_NODES, ISSUE_SUBTREE_DIAGNOSTICS_MAX_NODES),
      );
      const maxBlockersPerNode = Math.max(
        0,
        Math.min(
          opts?.maxBlockersPerNode ?? ISSUE_SUBTREE_DIAGNOSTICS_MAX_BLOCKERS_PER_NODE,
          ISSUE_SUBTREE_DIAGNOSTICS_MAX_BLOCKERS_PER_NODE,
        ),
      );
      const maxWakeRequestsPerNode = Math.max(
        0,
        Math.min(
          opts?.maxWakeRequestsPerNode ?? ISSUE_SUBTREE_DIAGNOSTICS_MAX_WAKE_REQUESTS_PER_NODE,
          ISSUE_SUBTREE_DIAGNOSTICS_MAX_WAKE_REQUESTS_PER_NODE,
        ),
      );
      const maxActivityRecordsPerNode = Math.max(
        0,
        Math.min(
          opts?.maxActivityRecordsPerNode ?? ISSUE_SUBTREE_DIAGNOSTICS_MAX_ACTIVITY_RECORDS_PER_NODE,
          ISSUE_SUBTREE_DIAGNOSTICS_MAX_ACTIVITY_RECORDS_PER_NODE,
        ),
      );
      const lookbackDays = Math.max(
        1,
        Math.min(opts?.lookbackDays ?? ISSUE_WAKE_DIAGNOSTICS_LOOKBACK_DAYS, ISSUE_WAKE_DIAGNOSTICS_LOOKBACK_DAYS),
      );
      const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);
      const sinceIso = since.toISOString();

      const rawSubtreeRows = await db.execute(sql<IssueSubtreeDiagnosticsIssueRow>`
        WITH RECURSIVE issue_tree AS (
          SELECT
            id,
            company_id,
            project_id,
            parent_id,
            identifier,
            title,
            status,
            priority,
            assignee_agent_id,
            assignee_user_id,
            created_at,
            updated_at,
            0 AS depth,
            ARRAY[id] AS path
          FROM issues
          WHERE company_id = ${issue.companyId}
            AND id = ${issue.id}
            AND hidden_at IS NULL
            AND harness_kind IS NULL
          UNION ALL
          SELECT
            child.id,
            child.company_id,
            child.project_id,
            child.parent_id,
            child.identifier,
            child.title,
            child.status,
            child.priority,
            child.assignee_agent_id,
            child.assignee_user_id,
            child.created_at,
            child.updated_at,
            issue_tree.depth + 1,
            issue_tree.path || child.id
          FROM issues child
          JOIN issue_tree ON child.parent_id = issue_tree.id
          WHERE child.company_id = ${issue.companyId}
            AND child.hidden_at IS NULL
            AND child.harness_kind IS NULL
            AND issue_tree.depth < ${maxDepth + 1}
            AND NOT child.id = ANY(issue_tree.path)
        )
        SELECT
          id,
          company_id AS "companyId",
          project_id AS "projectId",
          parent_id AS "parentId",
          identifier,
          title,
          status,
          priority,
          assignee_agent_id AS "assigneeAgentId",
          assignee_user_id AS "assigneeUserId",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          depth::int AS depth
        FROM issue_tree
        ORDER BY depth ASC, created_at ASC, id ASC
        LIMIT ${maxNodes + 1}
      `);
      const subtreeRows = Array.from(rawSubtreeRows)
        .map((row) => ({ ...row, depth: Number(row.depth) }));
      const rowsWithinDepth = subtreeRows.filter((row) => row.depth <= maxDepth);
      const nodes = rowsWithinDepth.slice(0, maxNodes) as IssueSubtreeDiagnosticsIssueRow[];
      const truncatedNodes = rowsWithinDepth.length > maxNodes;
      const truncatedDepth = truncatedNodes || subtreeRows.some((row) => row.depth > maxDepth);
      const nodeIds = nodes.map((node) => node.id);

      const readiness = nodeIds.length > 0
        ? await listIssueDependencyReadinessMap(db, issue.companyId, nodeIds)
        : new Map<string, IssueDependencyReadiness>();
      const blockersByIssueId = new Map<string, IssueSubtreeDiagnosticsBlockerRow[]>();
      const wakeRequestsByIssueId = new Map<string, IssueSubtreeDiagnosticsWakeRequestRow[]>();
      const activityRecordsByIssueId = new Map<string, IssueSubtreeDiagnosticsActivityRow[]>();
      const truncatedBlockerIssueIds = new Set<string>();
      const truncatedWakeIssueIds = new Set<string>();
      const truncatedActivityIssueIds = new Set<string>();

      if (nodeIds.length > 0) {
        const nodeIdValues = sql.join(nodeIds.map((id) => sql`${id}`), sql`, `);
        const rawBlockerRows = Array.from(await db.execute(sql`
          WITH blocker_rows AS (
            SELECT
              blocker.id,
              blocker.company_id AS "companyId",
              blocker.project_id AS "projectId",
              blocker.parent_id AS "parentId",
              blocker.identifier,
              blocker.title,
              blocker.status,
              blocker.priority,
              blocker.assignee_agent_id AS "assigneeAgentId",
              blocker.assignee_user_id AS "assigneeUserId",
              relation.related_issue_id AS "blockedIssueId",
              relation.created_at AS "relationCreatedAt",
              row_number() OVER (
                PARTITION BY relation.related_issue_id
                ORDER BY blocker.title ASC, blocker.id ASC
              )::int AS "rowNumber"
            FROM issue_relations relation
            INNER JOIN issues blocker ON blocker.id = relation.issue_id
            WHERE relation.company_id = ${issue.companyId}
              AND relation.type = 'blocks'
              AND blocker.company_id = ${issue.companyId}
              AND blocker.hidden_at IS NULL
              AND blocker.harness_kind IS NULL
              AND relation.related_issue_id::text IN (${nodeIdValues})
          )
          SELECT *
          FROM blocker_rows
          WHERE "rowNumber" <= ${maxBlockersPerNode + 1}
          ORDER BY "blockedIssueId" ASC, "rowNumber" ASC
        `)) as IssueSubtreeDiagnosticsBlockerResultRow[];
        for (const row of rawBlockerRows) {
          const normalized = { ...row, rowNumber: Number(row.rowNumber) };
          if (normalized.rowNumber > maxBlockersPerNode) {
            truncatedBlockerIssueIds.add(normalized.blockedIssueId);
            continue;
          }
          const rows = blockersByIssueId.get(normalized.blockedIssueId) ?? [];
          rows.push(normalized);
          blockersByIssueId.set(normalized.blockedIssueId, rows);
        }

        const wakeTargetIssueIdSql = sql<string>`
          coalesce(
            wake.payload ->> 'issueId',
            wake.payload ->> 'taskId',
            wake.payload -> '_paperclipWakeContext' ->> 'issueId',
            wake.payload -> '_paperclipWakeContext' ->> 'taskId'
          )
        `;
        const rawWakeRows = Array.from(await db.execute(sql`
          WITH wake_rows AS (
            SELECT
              ${wakeTargetIssueIdSql} AS "issueId",
              wake.agent_id AS "agentId",
              wake.source,
              wake.reason,
              wake.status,
              wake.coalesced_count AS "coalescedCount",
              wake.run_id AS "runId",
              wake.requested_at AS "requestedAt",
              wake.claimed_at AS "claimedAt",
              wake.finished_at AS "finishedAt",
              wake.error,
              row_number() OVER (
                PARTITION BY ${wakeTargetIssueIdSql}
                ORDER BY wake.requested_at DESC, wake.created_at DESC
              )::int AS "rowNumber"
            FROM agent_wakeup_requests wake
            WHERE wake.company_id = ${issue.companyId}
              AND wake.requested_at >= ${sinceIso}::timestamptz
              AND ${wakeTargetIssueIdSql} IN (${nodeIdValues})
          )
          SELECT *
          FROM wake_rows
          WHERE "rowNumber" <= ${maxWakeRequestsPerNode + 1}
          ORDER BY "issueId" ASC, "requestedAt" DESC
        `)) as IssueSubtreeDiagnosticsWakeRequestResultRow[];
        for (const row of rawWakeRows) {
          const normalized = { ...row, rowNumber: Number(row.rowNumber) };
          if (normalized.rowNumber > maxWakeRequestsPerNode) {
            truncatedWakeIssueIds.add(normalized.issueId);
            continue;
          }
          const rows = wakeRequestsByIssueId.get(normalized.issueId) ?? [];
          rows.push(normalized);
          wakeRequestsByIssueId.set(normalized.issueId, rows);
        }

        const activityTargetIssueIdSql = sql<string>`
          coalesce(
            CASE WHEN activity.entity_type = 'issue' THEN activity.entity_id ELSE NULL END,
            activity.details ->> 'issueId',
            activity.details ->> 'rootIssueId'
          )
        `;
        const activityActionValues = sql.join(
          ISSUE_WAKE_DIAGNOSTICS_ACTIVITY_ACTIONS.map((action) => sql`${action}`),
          sql`, `,
        );
        const rawActivityRows = Array.from(await db.execute(sql`
          WITH activity_rows AS (
            SELECT
              ${activityTargetIssueIdSql} AS "issueId",
              activity.action,
              activity.entity_type AS "entityType",
              activity.entity_id AS "entityId",
              activity.agent_id AS "agentId",
              activity.run_id AS "runId",
              activity.details,
              activity.created_at AS "createdAt",
              row_number() OVER (
                PARTITION BY ${activityTargetIssueIdSql}
                ORDER BY activity.created_at DESC, activity.id DESC
              )::int AS "rowNumber"
            FROM activity_log activity
            WHERE activity.company_id = ${issue.companyId}
              AND activity.created_at >= ${sinceIso}::timestamptz
              AND activity.action IN (${activityActionValues})
              AND ${activityTargetIssueIdSql} IN (${nodeIdValues})
          )
          SELECT *
          FROM activity_rows
          WHERE "rowNumber" <= ${maxActivityRecordsPerNode + 1}
          ORDER BY "issueId" ASC, "createdAt" DESC
        `)) as IssueSubtreeDiagnosticsActivityResultRow[];
        for (const row of rawActivityRows) {
          const normalized = { ...row, rowNumber: Number(row.rowNumber) };
          if (normalized.rowNumber > maxActivityRecordsPerNode) {
            truncatedActivityIssueIds.add(normalized.issueId);
            continue;
          }
          const rows = activityRecordsByIssueId.get(normalized.issueId) ?? [];
          rows.push(normalized);
          activityRecordsByIssueId.set(normalized.issueId, rows);
        }
      }

      return {
        nodes,
        blockersByIssueId,
        readinessByIssueId: readiness,
        wakeRequestsByIssueId,
        activityRecordsByIssueId,
        truncatedNodes,
        truncatedDepth,
        truncatedBlockerIssueIds,
        truncatedWakeIssueIds,
        truncatedActivityIssueIds,
        caps: {
          maxDepth,
          maxNodes,
          maxBlockersPerNode,
          maxWakeRequestsPerNode,
          maxActivityRecordsPerNode,
          lookbackDays,
        },
      };
    },

    getDependencyReadiness: async (issueId: string, dbOrTx: any = db) => {
      const issue = await dbOrTx
        .select({ id: issues.id, companyId: issues.companyId })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows: Array<{ id: string; companyId: string }>) => rows[0] ?? null);
      if (!issue) throw notFound("Issue not found");
      const readiness = await listIssueDependencyReadinessMap(dbOrTx, issue.companyId, [issueId]);
      return readiness.get(issueId) ?? createIssueDependencyReadiness(issueId);
    },

    listDependencyReadiness: async (companyId: string, issueIds: string[], dbOrTx: any = db) => {
      return listIssueDependencyReadinessMap(dbOrTx, companyId, issueIds);
    },

    listBlockerAttention: async (
      companyId: string,
      issueRows: IssueBlockerAttentionInputNode[],
      dbOrTx: any = db,
    ) => {
      return listIssueBlockerAttentionMap(dbOrTx, companyId, issueRows);
    },

    listProductivityReviews: async (
      companyId: string,
      sourceIssueIds: string[],
      dbOrTx: any = db,
    ) => {
      return listIssueProductivityReviewMap(dbOrTx, companyId, sourceIssueIds);
    },

    listWakeableBlockedDependents: async (blockerIssueId: string) => {
      const blockerIssue = await db
        .select({ id: issues.id, companyId: issues.companyId })
        .from(issues)
        .where(eq(issues.id, blockerIssueId))
        .then((rows) => rows[0] ?? null);
      if (!blockerIssue) return [];

      const candidates = await db
        .select({
          id: issues.id,
          assigneeAgentId: issues.assigneeAgentId,
          status: issues.status,
        })
        .from(issueRelations)
        .innerJoin(issues, eq(issueRelations.relatedIssueId, issues.id))
        .where(
          and(
            eq(issueRelations.companyId, blockerIssue.companyId),
            eq(issueRelations.type, "blocks"),
            eq(issueRelations.issueId, blockerIssueId),
          ),
        );
      if (candidates.length === 0) return [];

      const wakeableCandidates = candidates.filter(
        (candidate) =>
          candidate.assigneeAgentId && !["backlog", "done", "cancelled"].includes(candidate.status),
      );
      if (wakeableCandidates.length === 0) return [];

      // Defer to the unified readiness check so that a dependent only fires when
      // (a) every blocker is done AND (b) every done blocker's workspace has
      // recorded a successful workspace_finalize. The finalize hook also calls
      // this function on completion, so a wake initially gated by an in-flight
      // sync-back will re-fire once the restore lands locally.
      const readinessMap = await listIssueDependencyReadinessMap(
        db,
        blockerIssue.companyId,
        wakeableCandidates.map((candidate) => candidate.id),
      );

      const withReadiness = wakeableCandidates
        .map((candidate) => {
          const readiness = readinessMap.get(candidate.id) ?? createIssueDependencyReadiness(candidate.id);
          return { candidate, readiness };
        })
        .filter(({ candidate, readiness }) => {
          if (readiness.isDependencyReady && readiness.blockerIssueIds.length > 0) return true;
          // BLO-13250: a dependent excluded here because a blocker is done but
          // its execution workspace hasn't recorded workspace_finalize yet
          // used to vanish from the candidate set with zero audit trail — the
          // fast-path sent/skipped/failed counters never saw it, so a stuck
          // dependent was indistinguishable from "nothing happened yet".
          // Log + count it explicitly; the finalize hook re-runs this same
          // query on completion, so this fires again (as ready, or gated on a
          // different blocker) rather than being a one-shot drop.
          //
          // Only fire when the finalize barrier is the *sole* reason the
          // dependent isn't ready — `unresolvedBlockerIssueIds` also contains
          // blockers that aren't `done` at all (see
          // `listIssueDependencyReadinessMap`), so a mismatched length means
          // some other, wholly-unresolved blocker is the real reason this
          // dependent is stuck. Attributing that case to the finalize gate
          // would mislead an operator chasing the wrong barrier.
          if (
            readiness.pendingFinalizeBlockerIssueIds.length > 0 &&
            readiness.pendingFinalizeBlockerIssueIds.length === readiness.unresolvedBlockerIssueIds.length
          ) {
            incrementBlockerResolvedWakeMetric("fast_path_finalize_gated");
            logger.info(
              {
                issueId: blockerIssueId,
                dependentIssueId: candidate.id,
                agentId: candidate.assigneeAgentId,
                pendingFinalizeBlockerIssueIds: readiness.pendingFinalizeBlockerIssueIds,
                outcome: "gated",
                skipReason: "workspace_finalize_pending",
              },
              "blocker-resolved dependent wake outcome",
            );
          }
          return false;
        });

      const blockedCandidateIds = withReadiness
        .filter(({ candidate }) => candidate.status === "blocked")
        .map(({ candidate }) => candidate.id);

      const suppressedIssueIds = new Set<string>();
      if (blockedCandidateIds.length > 0) {
        const awaitingUserInputByIssueId = await findBlockedPromotionsAwaitingUserInput(
          db,
          blockerIssue.companyId,
          blockedCandidateIds,
        );
        for (const [issueId, awaitingUserInput] of awaitingUserInputByIssueId) {
          suppressedIssueIds.add(issueId);
          recordBlockedPromotionAwaitingUserSkip({
            issueId,
            ...awaitingUserInput,
            triggerPath: "blocker_done",
          });
        }

        const commentRows = await db
          .select({
            id: issueComments.id,
            issueId: issueComments.issueId,
            body: issueComments.body,
            createdAt: issueComments.createdAt,
            authorRole: agents.role,
          })
          .from(issueComments)
          .leftJoin(agents, eq(agents.id, issueComments.authorAgentId))
          .where(
            and(
              eq(issueComments.companyId, blockerIssue.companyId),
              inArray(issueComments.issueId, blockedCandidateIds),
            ),
          )
          .orderBy(desc(issueComments.createdAt));

        const commentsByIssueId = new Map<string, typeof commentRows>();
        for (const row of commentRows) {
          const list = commentsByIssueId.get(row.issueId) ?? [];
          list.push(row);
          commentsByIssueId.set(row.issueId, list);
        }

        const now = new Date();
        for (const issueId of blockedCandidateIds) {
          const candidateComments = commentsByIssueId.get(issueId) ?? [];
          const hold = findActiveExecutiveHold(candidateComments, now);
          if (hold) {
            suppressedIssueIds.add(issueId);
            logger.debug(
              { issueId, until: hold.until.toISOString(), holdCommentId: hold.commentId },
              `blockers_resolved_sweep: suppressed for issue=${issueId} until=${hold.until.toISOString()} hold_comment=${hold.commentId}`,
            );
          }
        }
      }

      return withReadiness
        .filter(({ candidate }) => !suppressedIssueIds.has(candidate.id))
        .map(({ candidate, readiness }) => ({
          id: candidate.id,
          assigneeAgentId: candidate.assigneeAgentId!,
          blockerIssueIds: readiness.blockerIssueIds,
        }));
    },

    // Sweep companion to listWakeableBlockedDependents. The latter only fires
    // at the moment a blocker transitions to `done` (`routes/issues.ts` becameDone
    // edge); if that wake is lost (process restart, blocker completed before the
    // dependent existed, etc.) the dependent stays silently stuck with zero wakes
    // targeting it. This sweep finds all eligible dependents whose every blocker
    // is already `done`, so a periodic reconciler can re-fire wakes for them.
    // "Done by status" alone isn't ready, though: after the cheap status-only
    // prefilter below, candidates are re-checked against
    // `listIssueDependencyReadinessMap` so the workspace_finalize barrier gates
    // the sweep the same way it gates the fast path (BLO-13577, sibling fix to
    // BLO-13250's fast-path `fast_path_finalize_gated` instrumentation).
    //
    // Cancelled blockers intentionally remain unresolved (see `listIssueDependencyReadinessMap`).
    listResolvedBlockerDependentsToSweep: async (
      companyId: string | undefined,
      opts: { limit?: number; minBlockerResolvedAge?: { milliseconds: number } } = {},
    ) => {
      const limit = Math.max(1, Math.min(opts.limit ?? 100, 500));
      const minAgeMs = Math.max(0, opts.minBlockerResolvedAge?.milliseconds ?? 0);

      const candidateConditions = [
        isNotNull(issues.assigneeAgentId),
        isNull(issues.completedAt),
        isNull(issues.cancelledAt),
        // This is lost-wake recovery for executable work. `in_review` issues
        // already have a reviewer/CI path and should not be polled by agents.
        inArray(issues.status, ["todo", "in_progress", "blocked"]),
      ];
      if (companyId) candidateConditions.push(eq(issues.companyId, companyId));

      const candidates = await db
        .select({
          id: issues.id,
          companyId: issues.companyId,
          assigneeAgentId: issues.assigneeAgentId,
          status: issues.status,
        })
        .from(issues)
        .where(and(...candidateConditions))
        .limit(limit * 4); // overfetch; many will fail the all-blockers-done predicate

      if (candidates.length === 0) return [];

      const candidateIds = candidates.map((c) => c.id);
      const blockerRows = await db
        .select({
          dependentId: issueRelations.relatedIssueId,
          blockerIssueId: issueRelations.issueId,
          blockerStatus: issues.status,
          blockerCompletedAt: issues.completedAt,
        })
        .from(issueRelations)
        .innerJoin(issues, eq(issueRelations.issueId, issues.id))
        .where(
          and(
            eq(issueRelations.type, "blocks"),
            inArray(issueRelations.relatedIssueId, candidateIds),
          ),
        );

      const byDependent = new Map<
        string,
        { ids: string[]; allDone: boolean; latestResolvedAt: Date | null }
      >();
      for (const row of blockerRows) {
        const entry = byDependent.get(row.dependentId) ?? { ids: [], allDone: true, latestResolvedAt: null };
        entry.ids.push(row.blockerIssueId);
        if (row.blockerStatus !== "done") entry.allDone = false;
        if (row.blockerCompletedAt && (!entry.latestResolvedAt || row.blockerCompletedAt > entry.latestResolvedAt)) {
          entry.latestResolvedAt = row.blockerCompletedAt;
        }
        byDependent.set(row.dependentId, entry);
      }

      const ageCutoff = minAgeMs > 0 ? new Date(Date.now() - minAgeMs) : null;
      const naiveReady: Array<{
        id: string;
        companyId: string;
        assigneeAgentId: string;
        blockerIssueIds: string[];
        latestBlockerResolvedAt: Date | null;
      }> = [];
      const candidateStatusById = new Map(candidates.map((c) => [c.id, c.status]));
      const candidateCompanyIdById = new Map(candidates.map((c) => [c.id, c.companyId]));
      for (const candidate of candidates) {
        const blockers = byDependent.get(candidate.id);
        if (!blockers || blockers.ids.length === 0 || !blockers.allDone) continue;
        if (ageCutoff && (!blockers.latestResolvedAt || blockers.latestResolvedAt > ageCutoff)) continue;
        naiveReady.push({
          id: candidate.id,
          companyId: candidate.companyId,
          assigneeAgentId: candidate.assigneeAgentId!,
          blockerIssueIds: blockers.ids,
          latestBlockerResolvedAt: blockers.latestResolvedAt,
        });
      }

      // BLO-13577: "all blockers done by status" is not sufficient — mirror
      // listWakeableBlockedDependents' workspace_finalize readiness check here
      // too, or this sweep re-introduces BLO-13250's silent-drop bug one hop
      // later (on reconciliation instead of the becameDone edge). Group by
      // company since this sweep can span every company in one pass while
      // listIssueDependencyReadinessMap is scoped to a single companyId.
      const naiveReadyByCompany = new Map<string, typeof naiveReady>();
      for (const candidate of naiveReady) {
        const list = naiveReadyByCompany.get(candidate.companyId) ?? [];
        list.push(candidate);
        naiveReadyByCompany.set(candidate.companyId, list);
      }
      const results: typeof naiveReady = [];
      companyLoop: for (const [candidateCompanyId, candidatesForCompany] of naiveReadyByCompany) {
        const readinessMap = await listIssueDependencyReadinessMap(
          db,
          candidateCompanyId,
          candidatesForCompany.map((c) => c.id),
        );
        for (const candidate of candidatesForCompany) {
          const readiness = readinessMap.get(candidate.id) ?? createIssueDependencyReadiness(candidate.id);
          if (readiness.isDependencyReady) {
            results.push(candidate);
            // Stop scanning as soon as `limit` is reached, same as the
            // pre-#601 single-loop behavior — checking only between companies
            // let one over-full company push every naively-ready candidate
            // through the readiness DB call (and through sweep_finalize_gated
            // accounting) even past `limit`, and, when companyId is undefined,
            // starved every company after the one that first filled `results`
            // (Ally review on #602).
            if (results.length >= limit) break companyLoop;
            continue;
          }
          // Only attribute the gate to workspace_finalize when it's the sole
          // reason the dependent isn't ready yet (see the matching comment in
          // listWakeableBlockedDependents) — otherwise a wholly-unresolved
          // blocker would be mislabeled as a finalize wait.
          if (
            readiness.pendingFinalizeBlockerIssueIds.length > 0 &&
            readiness.pendingFinalizeBlockerIssueIds.length === readiness.unresolvedBlockerIssueIds.length
          ) {
            incrementBlockerResolvedWakeMetric("sweep_finalize_gated");
            logger.info(
              {
                dependentIssueId: candidate.id,
                agentId: candidate.assigneeAgentId,
                pendingFinalizeBlockerIssueIds: readiness.pendingFinalizeBlockerIssueIds,
                outcome: "gated",
                skipReason: "workspace_finalize_pending",
              },
              "reconcileResolvedBlockerDependents dependent outcome",
            );
          } else {
            // Mixed or wholly-unresolved-blocker case: not attributable to
            // workspace_finalize. Without this branch the candidate left the
            // loop with zero counter increment and zero log line — the exact
            // "operator sees all-zero counters for a stuck dependent" failure
            // mode BLO-13250/BLO-13577 exist to eliminate (Ally review on #602).
            incrementBlockerResolvedWakeMetric("sweep_unresolved_gated");
            logger.info(
              {
                dependentIssueId: candidate.id,
                agentId: candidate.assigneeAgentId,
                unresolvedBlockerIssueIds: readiness.unresolvedBlockerIssueIds,
                outcome: "gated",
                skipReason: "blocker_unresolved",
              },
              "reconcileResolvedBlockerDependents dependent outcome",
            );
          }
        }
      }

      const resultIds = results.map((r) => r.id);
      if (resultIds.length === 0) return results;

      // Explicit waiting paths (request_confirmation/chooser interactions and
      // linked approvals) are already a live action path. The blocker-resolved
      // sweep is a lost-wake recovery path; it must not re-wake executor agents
      // that are parked waiting for a human or reviewer decision.
      const explicitlyWaitingIssueIds = new Set<string>();
      const pendingInteractionRows = await db
        .select({ issueId: issueThreadInteractions.issueId })
        .from(issueThreadInteractions)
        .where(
          and(
            inArray(issueThreadInteractions.issueId, resultIds),
            inArray(issueThreadInteractions.status, BLOCKER_ATTENTION_PENDING_INTERACTION_STATUSES),
          ),
        );
      for (const row of pendingInteractionRows) explicitlyWaitingIssueIds.add(row.issueId);

      const pendingApprovalRows = await db
        .select({ issueId: issueApprovals.issueId })
        .from(issueApprovals)
        .innerJoin(approvals, eq(issueApprovals.approvalId, approvals.id))
        .where(
          and(
            inArray(issueApprovals.issueId, resultIds),
            inArray(approvals.status, BLOCKER_ATTENTION_PENDING_APPROVAL_STATUSES),
          ),
        );
      for (const row of pendingApprovalRows) explicitlyWaitingIssueIds.add(row.issueId);

      const resultsAfterExplicitWaitingSuppression = explicitlyWaitingIssueIds.size === 0
        ? results
        : results.filter((r) => {
            const suppress = explicitlyWaitingIssueIds.has(r.id);
            if (suppress) {
              logger.debug(
                { issueId: r.id },
                "blockers_resolved_sweep: suppressed because issue has an explicit pending interaction or approval",
              );
            }
            return !suppress;
          });

      // BLO-3496: companion suppression to listWakeableBlockedDependents. The
      // edge-triggered path checks executive `do not retry before <ts>` markers
      // before waking; the sweep must too, otherwise a CTO hold gets bypassed
      // every time the periodic reconciler runs and fires the wake again.
      const blockedResultIds = resultsAfterExplicitWaitingSuppression
        .filter((r) => candidateStatusById.get(r.id) === "blocked")
        .map((r) => r.id);
      if (blockedResultIds.length === 0) return resultsAfterExplicitWaitingSuppression;

      const blockedResultIdsByCompanyId = new Map<string, string[]>();
      for (const issueId of blockedResultIds) {
        const candidateCompanyId = candidateCompanyIdById.get(issueId);
        if (!candidateCompanyId) continue;
        const ids = blockedResultIdsByCompanyId.get(candidateCompanyId) ?? [];
        ids.push(issueId);
        blockedResultIdsByCompanyId.set(candidateCompanyId, ids);
      }
      const awaitingUserInputByIssueId = new Map<string, {
        commentId: string;
        commentCreatedAt: Date;
        reason: string;
      }>();
      for (const [candidateCompanyId, issueIds] of blockedResultIdsByCompanyId) {
        const companyResults = await findBlockedPromotionsAwaitingUserInput(db, candidateCompanyId, issueIds);
        for (const [issueId, awaitingUserInput] of companyResults) {
          awaitingUserInputByIssueId.set(issueId, awaitingUserInput);
        }
      }
      for (const [issueId, awaitingUserInput] of awaitingUserInputByIssueId) {
        recordBlockedPromotionAwaitingUserSkip({
          issueId,
          ...awaitingUserInput,
          triggerPath: "resolved_blocker_sweep",
        });
      }

      const pendingConfirmationRows = await db
        .select({ issueId: issueThreadInteractions.issueId })
        .from(issueThreadInteractions)
        .where(and(
          inArray(issueThreadInteractions.issueId, blockedResultIds),
          eq(issueThreadInteractions.kind, "request_confirmation"),
          eq(issueThreadInteractions.status, "pending"),
        ));
      const suppressedIssueIds = new Set<string>([
        ...pendingConfirmationRows.map((row) => row.issueId),
        ...awaitingUserInputByIssueId.keys(),
      ]);

      const commentRows = await db
        .select({
          id: issueComments.id,
          issueId: issueComments.issueId,
          body: issueComments.body,
          createdAt: issueComments.createdAt,
          authorRole: agents.role,
        })
        .from(issueComments)
        .leftJoin(agents, eq(agents.id, issueComments.authorAgentId))
        .where(inArray(issueComments.issueId, blockedResultIds))
        .orderBy(desc(issueComments.createdAt));

      const commentsByIssueId = new Map<string, typeof commentRows>();
      for (const row of commentRows) {
        const list = commentsByIssueId.get(row.issueId) ?? [];
        list.push(row);
        commentsByIssueId.set(row.issueId, list);
      }

      const now = new Date();
      for (const issueId of blockedResultIds) {
        const candidateComments = commentsByIssueId.get(issueId) ?? [];
        const hold = findActiveExecutiveHold(candidateComments, now);
        if (hold) {
          suppressedIssueIds.add(issueId);
          logger.debug(
            { issueId, until: hold.until.toISOString(), holdCommentId: hold.commentId },
            `blockers_resolved_sweep: suppressed for issue=${issueId} until=${hold.until.toISOString()} hold_comment=${hold.commentId}`,
          );
        }
      }
      return suppressedIssueIds.size === 0
        ? resultsAfterExplicitWaitingSuppression
        : resultsAfterExplicitWaitingSuppression.filter((r) => !suppressedIssueIds.has(r.id));
    },

    getWakeableParentAfterChildCompletion: async (parentIssueId: string) => {
      const parent = await db
        .select({
          id: issues.id,
          assigneeAgentId: issues.assigneeAgentId,
          status: issues.status,
          companyId: issues.companyId,
        })
        .from(issues)
        .where(eq(issues.id, parentIssueId))
        .then((rows) => rows[0] ?? null);
      if (!parent || !parent.assigneeAgentId || ["backlog", "done", "cancelled"].includes(parent.status)) {
        return null;
      }

      const children = await db
        .select({
          id: issues.id,
          identifier: issues.identifier,
          title: issues.title,
          status: issues.status,
          priority: issues.priority,
          assigneeAgentId: issues.assigneeAgentId,
          assigneeUserId: issues.assigneeUserId,
          updatedAt: issues.updatedAt,
        })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, parent.companyId),
            eq(issues.parentId, parentIssueId),
            notInArray(issues.originKind, SYSTEM_HARNESS_CHILD_ORIGIN_KINDS),
          ),
        )
        .orderBy(asc(issues.issueNumber), asc(issues.createdAt));
      if (children.length === 0) return null;
      if (!children.every((child) => child.status === "done" || child.status === "cancelled")) {
        return null;
      }

      const childIdsForSummaries = children.slice(0, MAX_CHILD_COMPLETION_SUMMARIES).map((child) => child.id);
      const commentRows = childIdsForSummaries.length > 0
        ? await db
            .select({
              issueId: issueComments.issueId,
              body: issueComments.body,
              createdAt: issueComments.createdAt,
            })
            .from(issueComments)
            .where(and(
              eq(issueComments.companyId, parent.companyId),
              inArray(issueComments.issueId, childIdsForSummaries),
              isNull(issueComments.deletedAt),
            ))
            .orderBy(desc(issueComments.createdAt), desc(issueComments.id))
        : [];
      const latestCommentByIssueId = new Map<string, string>();
      for (const comment of commentRows) {
        if (!latestCommentByIssueId.has(comment.issueId)) {
          latestCommentByIssueId.set(comment.issueId, comment.body);
        }
      }
      const childIssueSummaries: ChildIssueCompletionSummary[] = children
        .slice(0, MAX_CHILD_COMPLETION_SUMMARIES)
        .map((child) => ({
          ...child,
          summary: truncateInlineSummary(latestCommentByIssueId.get(child.id)),
        }));

      return {
        id: parent.id,
        assigneeAgentId: parent.assigneeAgentId,
        childIssueIds: children.map((child) => child.id),
        childIssueSummaries,
        childIssueSummaryTruncated: children.length > childIssueSummaries.length,
      };
    },

    createChild: async (
      parentIssueId: string,
      data: IssueChildCreateInput,
    ) => {
      const parent = await db
        .select()
        .from(issues)
        .where(eq(issues.id, parentIssueId))
        .then((rows) => rows[0] ?? null);
      if (!parent) throw notFound("Parent issue not found");

      const [{ childCount }] = await db
        .select({ childCount: sql<number>`count(*)::int` })
        .from(issues)
        .where(and(eq(issues.companyId, parent.companyId), eq(issues.parentId, parent.id)));
      if (childCount >= MAX_CHILD_ISSUES_CREATED_BY_HELPER) {
        throw unprocessable(`Parent issue already has the maximum ${MAX_CHILD_ISSUES_CREATED_BY_HELPER} child issues for this helper`);
      }

      const {
        acceptanceCriteria,
        blockParentUntilDone,
        executionWorkspaceInheritanceMode = "linkage",
        actorAgentId,
        actorUserId,
        ...issueData
      } = data;
      const inheritStrategyOnly = executionWorkspaceInheritanceMode === "strategy_only";
      const hasExplicitWorkspaceOverride = hasExplicitExecutionWorkspaceOverride(issueData);
      const inheritedPreRealizationWorkspaceSettings =
        inheritStrategyOnly && !hasExplicitWorkspaceOverride
          ? buildPreRealizationExecutionWorkspaceSettings(parent.executionWorkspaceSettings)
          : null;
      let child = await issueService(db).create(parent.companyId, {
        ...issueData,
        parentId: parent.id,
        projectId: issueData.projectId ?? parent.projectId,
        projectWorkspaceId: issueData.projectWorkspaceId ?? (inheritStrategyOnly ? parent.projectWorkspaceId : undefined),
        goalId: issueData.goalId ?? parent.goalId,
        actorResponsibleUserId: issueData.actorResponsibleUserId ?? null,
        trustExplicitResponsibleUserId: issueData.trustExplicitResponsibleUserId === true,
        requestDepth: clampIssueRequestDepth(
          Math.max(clampIssueRequestDepth(parent.requestDepth) + 1, issueData.requestDepth ?? 0),
        ),
        description: appendAcceptanceCriteriaToDescription(issueData.description, acceptanceCriteria),
        ...(inheritedPreRealizationWorkspaceSettings
          ? { executionWorkspaceSettings: inheritedPreRealizationWorkspaceSettings }
          : {}),
        ...(inheritStrategyOnly
          ? { skipExecutionWorkspaceInheritance: true }
          : { inheritExecutionWorkspaceFromIssueId: parent.id }),
      });

      if (blockParentUntilDone) {
        await db.transaction(async (tx) => {
          await lockIssueParentMutationCompany(parent.companyId, tx);
          const existingBlockers = await tx
            .select({ blockerIssueId: issueRelations.issueId })
            .from(issueRelations)
            .where(and(eq(issueRelations.companyId, parent.companyId), eq(issueRelations.relatedIssueId, parent.id), eq(issueRelations.type, "blocks")));
          await syncBlockedByIssueIds(
            parent.id,
            parent.companyId,
            [...new Set([...existingBlockers.map((row) => row.blockerIssueId), child.id])],
            { agentId: actorAgentId ?? null, userId: actorUserId ?? null },
            tx,
          );
        });
        [child] = await withIssueRelationSummaries(parent.companyId, [child], db);
      }

      return {
        issue: child,
        parentBlockerAdded: Boolean(blockParentUntilDone),
      };
    },

    decomposeAcceptedPlan: async (
      sourceIssueId: string,
      data: AcceptedPlanDecompositionInput,
    ) => {
      const sourceIssue = await db
        .select({
          id: issues.id,
          companyId: issues.companyId,
          projectId: issues.projectId,
          goalId: issues.goalId,
        })
        .from(issues)
        .where(eq(issues.id, sourceIssueId))
        .then((rows) => rows[0] ?? null);
      if (!sourceIssue) throw notFound("Source issue not found");

      const requestFingerprint = createAcceptedPlanDecompositionRequestFingerprint({
        acceptedPlanRevisionId: data.acceptedPlanRevisionId,
        children: data.children,
      });

      const initialClaim = await db.transaction(async (tx) => {
        await tx.execute(sql`select ${issues.id} from ${issues} where ${issues.id} = ${sourceIssue.id} for update`);

        const belongsToPlanDocument = await tx
          .select({ revisionId: documentRevisions.id })
          .from(issueDocuments)
          .innerJoin(documentRevisions, eq(issueDocuments.documentId, documentRevisions.documentId))
          .where(and(
            eq(issueDocuments.companyId, sourceIssue.companyId),
            eq(issueDocuments.issueId, sourceIssue.id),
            eq(issueDocuments.key, "plan"),
            eq(documentRevisions.id, data.acceptedPlanRevisionId),
          ))
          .then((rows) => rows[0] ?? null);
        if (!belongsToPlanDocument) {
          throw unprocessable("acceptedPlanRevisionId must belong to the source issue's plan document");
        }

        const acceptedInteraction = await findAcceptedPlanDocumentInteraction(tx, {
          companyId: sourceIssue.companyId,
          sourceIssueId: sourceIssue.id,
          acceptedPlanRevisionId: data.acceptedPlanRevisionId,
        });
        if (!acceptedInteraction) {
          throw unprocessable("acceptedPlanRevisionId must have an accepted plan confirmation");
        }

        const existing = await tx
          .select()
          .from(issuePlanDecompositions)
          .where(and(
            eq(issuePlanDecompositions.companyId, sourceIssue.companyId),
            eq(issuePlanDecompositions.sourceIssueId, sourceIssue.id),
            eq(issuePlanDecompositions.acceptedPlanRevisionId, data.acceptedPlanRevisionId),
          ))
          .then((rows) => rows[0] ?? null);

        const now = new Date();
        if (!existing) {
          const [created] = await tx
            .insert(issuePlanDecompositions)
            .values({
              companyId: sourceIssue.companyId,
              sourceIssueId: sourceIssue.id,
              acceptedPlanRevisionId: data.acceptedPlanRevisionId,
              acceptedInteractionId: acceptedInteraction.id,
              status: "in_flight",
              requestFingerprint,
              requestedChildCount: data.children.length,
              requestedChildren: data.children as unknown as Record<string, unknown>[],
              childIssueIds: [],
              ownerAgentId: data.actorAgentId ?? null,
              ownerUserId: data.actorUserId ?? null,
              ownerRunId: data.actorRunId ?? null,
              updatedAt: now,
            })
            .returning();
          if (!created) throw new Error("Failed to create accepted-plan decomposition claim");
          return created;
        }

        if (existing.requestFingerprint !== requestFingerprint) {
          throw conflict("Accepted-plan decomposition already exists for this revision with a different child set");
        }

        return existing;
      });

      let currentClaim = initialClaim;
      const newlyCreatedIssues: Array<typeof issues.$inferSelect> = [];

      while (true) {
        const step = await db.transaction(async (tx) => {
          await tx.execute(
            sql`select ${issuePlanDecompositions.id}
                from ${issuePlanDecompositions}
                where ${issuePlanDecompositions.id} = ${currentClaim.id}
                for update`,
          );

          const claim = await tx
            .select()
            .from(issuePlanDecompositions)
            .where(eq(issuePlanDecompositions.id, currentClaim.id))
            .then((rows) => rows[0] ?? null);
          if (!claim) throw notFound("Accepted-plan decomposition claim not found");
          if (claim.requestFingerprint !== requestFingerprint) {
            throw conflict("Accepted-plan decomposition already exists for this revision with a different child set");
          }

          const existingChildIssueIds = normalizeIssuePlanDecompositionChildIds(claim.childIssueIds);
          if (claim.status === "completed" || existingChildIssueIds.length >= data.children.length) {
            const nextIds = existingChildIssueIds.slice(0, data.children.length);
            if (claim.status === "completed" && nextIds.length === data.children.length) {
              return {
                claim,
                createdIssue: null,
              };
            }

            const completedAt = claim.completedAt ?? new Date();
            const ownerPatch = await resolveAcceptedPlanClaimOwner({
              dbOrTx: tx,
              claim,
              actorAgentId: data.actorAgentId,
              actorUserId: data.actorUserId,
              actorRunId: data.actorRunId,
            });
            const [completed] = await tx
              .update(issuePlanDecompositions)
              .set({
                status: "completed",
                childIssueIds: nextIds,
                completedAt,
                ...ownerPatch,
                updatedAt: completedAt,
              })
              .where(eq(issuePlanDecompositions.id, claim.id))
              .returning();
            if (!completed) throw new Error("Failed to complete accepted-plan decomposition claim");
            return {
              claim: completed,
              createdIssue: null,
            };
          }

          const nextChildInput = data.children[existingChildIssueIds.length];
          if (!nextChildInput) {
            throw new Error("Accepted-plan decomposition child cursor moved past the requested children");
          }

          const createdChild = await issueService(tx as unknown as Db).createChild(sourceIssue.id, {
            ...nextChildInput,
            executionWorkspaceInheritanceMode: "strategy_only",
          });
          const nextIds = [...existingChildIssueIds, createdChild.issue.id];
          const now = new Date();
          const nextStatus = nextIds.length === data.children.length ? "completed" : "in_flight";
          const ownerPatch = await resolveAcceptedPlanClaimOwner({
            dbOrTx: tx,
            claim,
            actorAgentId: data.actorAgentId,
            actorUserId: data.actorUserId,
            actorRunId: data.actorRunId,
          });
          const [updatedClaim] = await tx
            .update(issuePlanDecompositions)
            .set({
              status: nextStatus,
              childIssueIds: nextIds,
              completedAt: nextStatus === "completed" ? now : null,
              ...ownerPatch,
              updatedAt: now,
            })
            .where(eq(issuePlanDecompositions.id, claim.id))
            .returning();
          if (!updatedClaim) throw new Error("Failed to persist accepted-plan decomposition progress");
          return {
            claim: updatedClaim,
            createdIssue: createdChild.issue,
          };
        });

        currentClaim = step.claim;
        if (step.createdIssue) {
          newlyCreatedIssues.push(step.createdIssue);
        }
        if (step.claim.status === "completed") break;
      }

      const childIssueIds = normalizeIssuePlanDecompositionChildIds(currentClaim.childIssueIds);
      const childIssueRows = childIssueIds.length > 0
        ? await db
            .select()
            .from(issues)
            .where(and(eq(issues.companyId, sourceIssue.companyId), inArray(issues.id, childIssueIds)))
        : [];
      const childIssueMap = new Map(childIssueRows.map((row) => [row.id, row]));
      const orderedChildIssues = childIssueIds
        .map((childIssueId) => childIssueMap.get(childIssueId))
        .filter((row): row is typeof issues.$inferSelect => Boolean(row));

      const decomposition = serializeAcceptedPlanDecomposition(currentClaim);

      return {
        decomposition,
        childIssueIds: decomposition.childIssueIds,
        childIssues: orderedChildIssues,
        newlyCreatedIssues,
      };
    },

    listAcceptedPlanDecompositions: async (sourceIssueId: string) => {
      const sourceIssue = await db
        .select({ id: issues.id, companyId: issues.companyId })
        .from(issues)
        .where(eq(issues.id, sourceIssueId))
        .then((rows) => rows[0] ?? null);
      if (!sourceIssue) return [];

      const rows = await db
        .select({
          decomposition: issuePlanDecompositions,
          revisionNumber: documentRevisions.revisionNumber,
        })
        .from(issuePlanDecompositions)
        .leftJoin(
          documentRevisions,
          eq(documentRevisions.id, issuePlanDecompositions.acceptedPlanRevisionId),
        )
        .where(and(
          eq(issuePlanDecompositions.companyId, sourceIssue.companyId),
          eq(issuePlanDecompositions.sourceIssueId, sourceIssue.id),
        ))
        .orderBy(desc(issuePlanDecompositions.createdAt));

      if (rows.length === 0) return [];

      const allChildIds = new Set<string>();
      for (const row of rows) {
        for (const childId of normalizeIssuePlanDecompositionChildIds(row.decomposition.childIssueIds)) {
          allChildIds.add(childId);
        }
      }

      const childIssueRows = allChildIds.size > 0
        ? await db
            .select({
              id: issues.id,
              identifier: issues.identifier,
              title: issues.title,
              status: issues.status,
              priority: issues.priority,
              assigneeAgentId: issues.assigneeAgentId,
              assigneeUserId: issues.assigneeUserId,
            })
            .from(issues)
            .where(and(eq(issues.companyId, sourceIssue.companyId), inArray(issues.id, Array.from(allChildIds))))
        : [];
      const childIssueMap = new Map(childIssueRows.map((row) => [row.id, row]));

      return rows.map((row) => {
        const decomposition = serializeAcceptedPlanDecomposition(row.decomposition);
        const childIds = decomposition.childIssueIds;
        return {
          ...decomposition,
          acceptedPlanRevisionNumber: row.revisionNumber ?? null,
          childIssues: childIds
            .map((childId) => childIssueMap.get(childId) ?? null)
            .filter((entry): entry is NonNullable<typeof entry> => entry !== null),
        };
      });
    },

    create: async (companyId: string, data: IssueCreateInput) => {
      const {
        labelIds: inputLabelIds,
        blockedByIssueIds,
        inheritExecutionWorkspaceFromIssueId,
        linkedLinearIssue,
        skipExecutionWorkspaceInheritance,
        watchdog,
        watchdogActorRunId,
        actorRunId,
        actorResponsibleUserId,
        trustExplicitResponsibleUserId,
        idempotencyKey: rawIdempotencyKey,
        allowDuplicate,
        onDeduplicated,
        beforeSideEffects,
        ...issueData
      } = data;
      const isolatedWorkspacesEnabled = (await instanceSettings.getExperimental()).enableIsolatedWorkspaces;
      if (!isolatedWorkspacesEnabled) {
        delete issueData.executionWorkspaceId;
        delete issueData.executionWorkspacePreference;
        delete issueData.executionWorkspaceSettings;
      }
      if (data.assigneeAgentId && data.assigneeUserId) {
        throw unprocessable("Issue can only have one assignee");
      }
      if (data.assigneeAgentId) {
        await assertAssignableAgent(db, companyId, data.assigneeAgentId, { kind: "work" });
      }
      if (data.assigneeUserId) {
        await assertAssignableUser(companyId, data.assigneeUserId);
      }
      if (data.status === "in_progress" && !data.assigneeAgentId && !data.assigneeUserId) {
        throw unprocessable("in_progress issues require an assignee");
      }

      // If the allocator hits Linear during the tx and the tx subsequently
      // fails, the Linear-side issue would otherwise dangle without a
      // paperclip mirror. We capture its id from inside the tx and, on tx
      // rollback, fire a best-effort IssueDelete so the namespaces stay in
      // sync. Cleanup errors are logged-and-swallowed to avoid masking the
      // original failure that triggered the rollback.
      let createdLinearIssueId: string | null = null;
      try {
        return await db.transaction(async (tx) => {
        const idempotencyKey = rawIdempotencyKey?.trim() || null;
        const normalizedTitle = normalizeCreateIssueTitle(issueData.title);
        if (allowDuplicate === false) {
          const titleGuardKey =
            `issue-create:title:${companyId}:${issueData.parentId ?? "root"}:${normalizedTitle}`;
          await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${titleGuardKey}, 0))`);
        }
        if (idempotencyKey) {
          const idempotencyGuardKey = `issue-create:idempotency:${companyId}:${idempotencyKey}`;
          await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${idempotencyGuardKey}, 0))`);
        }

        let existingIssue: typeof issues.$inferSelect | undefined;
        let deduplicationReason: "idempotency_key" | "recent_open_title" | null = null;
        if (idempotencyKey) {
          const idempotencyKeyRetentionCutoff = new Date(Date.now() - ISSUE_CREATE_IDEMPOTENCY_KEY_RETENTION_MS);
          await tx.execute(sql`
            delete from ${issueCreateIdempotencyKeys}
            where ${issueCreateIdempotencyKeys.id} in (
              select ${issueCreateIdempotencyKeys.id}
              from ${issueCreateIdempotencyKeys}
              where ${issueCreateIdempotencyKeys.companyId} = ${companyId}
                and ${issueCreateIdempotencyKeys.createdAt} < ${idempotencyKeyRetentionCutoff.toISOString()}::timestamptz
              order by ${issueCreateIdempotencyKeys.createdAt} asc, ${issueCreateIdempotencyKeys.id} asc
              limit ${ISSUE_CREATE_IDEMPOTENCY_KEY_CLEANUP_BATCH_SIZE}
            )
          `);

          [existingIssue] = await tx
            .select()
            .from(issueCreateIdempotencyKeys)
            .innerJoin(issues, eq(issueCreateIdempotencyKeys.issueId, issues.id))
            .where(and(
              eq(issueCreateIdempotencyKeys.companyId, companyId),
              eq(issueCreateIdempotencyKeys.idempotencyKey, idempotencyKey),
            ))
            .limit(1)
            .then((rows) => rows.map((row) => row.issues));
          if (existingIssue) deduplicationReason = "idempotency_key";
        }
        if (!existingIssue && allowDuplicate === false) {
          [existingIssue] = await tx
            .select()
            .from(issues)
            .where(and(
              eq(issues.companyId, companyId),
              issueData.parentId ? eq(issues.parentId, issueData.parentId) : isNull(issues.parentId),
              isNull(issues.hiddenAt),
              notInArray(issues.status, ["done", "cancelled"]),
              gte(issues.createdAt, new Date(Date.now() - 48 * 60 * 60 * 1000)),
              sql`lower(regexp_replace(btrim(${issues.title}), '\\s+', ' ', 'g')) = ${normalizedTitle}`,
            ))
            .orderBy(asc(issues.createdAt), asc(issues.id))
            .limit(1);
          if (existingIssue) deduplicationReason = "recent_open_title";
        }
        if (existingIssue) {
          if (idempotencyKey) {
            await tx
              .insert(issueCreateIdempotencyKeys)
              .values({ companyId, idempotencyKey, issueId: existingIssue.id })
              .onConflictDoNothing();
          }
          if (deduplicationReason) onDeduplicated?.(deduplicationReason);
          const [enriched] = await withIssueLabels(tx, [existingIssue]);
          const [withRelations] = await withIssueRelationSummaries(companyId, [enriched], tx);
          return withRelations;
        }

        // Create can mutate the same issue graph as update via parentId and
        // blockedByIssueIds. Keep the company-scoped graph lock outermost
        // before create-time blocker sync starts taking row locks.
        if (issueData.parentId !== undefined || blockedByIssueIds !== undefined) {
          await lockIssueParentMutationCompany(companyId, tx);
        }

        const defaultCompanyGoal = await getDefaultCompanyGoal(tx, companyId);
        let projectWorkspaceId = issueData.projectWorkspaceId ?? null;
        let executionWorkspaceId = issueData.executionWorkspaceId ?? null;
        let executionWorkspacePreference = issueData.executionWorkspacePreference ?? null;
        let executionWorkspaceSettings =
          (issueData.executionWorkspaceSettings as Record<string, unknown> | null | undefined) ?? null;
        const workspaceInheritanceIssueId = skipExecutionWorkspaceInheritance
          ? null
          : inheritExecutionWorkspaceFromIssueId ?? issueData.parentId ?? null;
        const hasExplicitWorkspaceOverride = hasExplicitExecutionWorkspaceOverride(issueData);
        const hasWorkspaceIntent = hasExecutionWorkspaceIntent(issueData);
        if (workspaceInheritanceIssueId) {
          const workspaceSource = await getWorkspaceInheritanceIssue(tx, companyId, workspaceInheritanceIssueId);
          if (issueData.projectId == null && workspaceSource.projectId) {
            issueData.projectId = workspaceSource.projectId;
          }
          if (projectWorkspaceId == null && workspaceSource.projectWorkspaceId) {
            projectWorkspaceId = workspaceSource.projectWorkspaceId;
          }
          if (
            isolatedWorkspacesEnabled &&
            !hasExplicitWorkspaceOverride &&
            workspaceSource.executionWorkspaceId
          ) {
            const sourceWorkspace = await tx
              .select({
                id: executionWorkspaces.id,
                mode: executionWorkspaces.mode,
              })
              .from(executionWorkspaces)
              .where(eq(executionWorkspaces.id, workspaceSource.executionWorkspaceId))
              .then((rows) => rows[0] ?? null);
            if (sourceWorkspace) {
              executionWorkspaceId = sourceWorkspace.id;
              executionWorkspacePreference = "reuse_existing";
              executionWorkspaceSettings = {
                ...((workspaceSource.executionWorkspaceSettings as Record<string, unknown> | null | undefined) ?? {}),
                mode: issueExecutionWorkspaceModeForPersistedWorkspace(sourceWorkspace.mode),
              };
            }
          }
        }
        if (issueData.projectId == null && projectWorkspaceId) {
          const workspace = await assertValidProjectWorkspace(companyId, null, projectWorkspaceId, tx);
          issueData.projectId = workspace.projectId;
        }
        if (issueData.projectId == null && executionWorkspaceId) {
          const workspace = await assertValidExecutionWorkspace(companyId, null, executionWorkspaceId, tx);
          issueData.projectId = workspace.projectId;
        }
        // Note for the inference below: reaching it with `projectId == null` PROVES both
        // workspace *ids* are also null, so it needs no separate guard against those two.
        // `execution_workspaces.project_id` and `project_workspaces.project_id` are both
        // `NOT NULL` (packages/db/src/schema/execution_workspaces.ts:20,
        // project_workspaces.ts:19; DDL in migrations/0035_marvelous_satana.sql, never
        // relaxed since). So each block above either assigns a non-null projectId or
        // throws — a *projectless* explicit/inherited workspace is not a representable
        // state. Raised twice in review (PR #811) as a case where inference would fight
        // the re-validation at ~7729 and fail the create; recorded here because the
        // reasoning is non-local and the counterexample is unwritable as a test.
        //
        // This argument is about the two workspace *ids* ONLY, and does not extend to
        // `executionWorkspacePreference` / `executionWorkspaceSettings`: those carry
        // workspace intent with no project attached, nothing above resolves a project
        // from them, and they DO reach the inference with `projectId` null. They get a
        // real guard — see policy note 4 below. Don't read this paragraph as "no
        // workspace guard is ever needed here."
        // BLO-18760: an issue created with none of the inheritance signals
        // above (no parent, no explicit workspace) is *born* with
        // projectId: null and, on its first run, falls back onto the
        // per-agent fallback workspace — a long-lived, shared directory that
        // can accumulate a real (but unrelated, concurrently-touched) git
        // checkout from past work, making a local `git clone --shared` from
        // it a coin-flip to fail with a fatal git error before the agent
        // ever starts. Give the issue a real managed checkout instead of
        // leaving it workspace-less, but only when the signal is
        // unambiguous: exactly one non-archived project the assignee leads.
        // Anything murkier (no assignee, no lead project, or more than one
        // candidate) is left alone rather than guessing at which repo the
        // agent meant.
        //
        // Two policy decisions encoded here, both deliberate (Ally review, PR #811):
        //
        // 1. `== null` treats an *explicit* `projectId: null` the same as omitting the
        //    field. This is required, not incidental: the board/UI create path posts an
        //    explicit null, which is precisely the intake case BLO-18760 exists to fix.
        //    Honoring explicit null as "definitely no project" would make this a no-op
        //    for the only caller that matters. A caller that genuinely wants a
        //    workspace-less issue can still get one by leaving the issue unassigned, or
        //    by assigning an agent with no (or an ambiguous) lead project.
        //
        // 2. `archivedAt` is the ONLY exclusion. A `completed` or `paused` project stays
        //    a candidate on purpose — what the issue inherits is the project's git
        //    checkout, and that checkout is just as valid on a finished project as an
        //    active one. Project status describes the *work*, not the repo. Archived is
        //    excluded because archival is the one signal that the checkout itself is no
        //    longer maintained.
        //
        // 3. Root creates ONLY. A child whose parent is *intentionally* projectless must
        //    stay projectless rather than be inferred onto its assignee's led project:
        //    projectId carries the default goal, the execution-workspace policy, and the
        //    repository, so inferring here would silently split parent and child across
        //    all three — a child quietly doing work against a different repo than the
        //    parent it reports into. Both guards are load-bearing and neither implies the
        //    other: `workspaceInheritanceIssueId` is null when a caller passes
        //    `skipExecutionWorkspaceInheritance` even though a parent exists (the
        //    `inheritStrategyOnly` sub-issue path does exactly this), and it is non-null
        //    for an explicit `inheritExecutionWorkspaceFromIssueId` with no parent at all.
        //    Intake — the case BLO-18760 exists to fix — has neither.
        //
        // 4. No explicit workspace intent. `executionWorkspacePreference` /
        //    `executionWorkspaceSettings` carry workspace intent without carrying a
        //    project, so unlike a workspace *id* (whose `project_id` is NOT NULL, and
        //    which the two blocks above already resolve a project from) they can reach
        //    here with `projectId` still null. Inferring under them would not just add a
        //    project — it would silently pull in that project's default goal, project
        //    workspace, and repository, and would convert a deliberate error into a
        //    success: a projectless `isolated_workspace` request is meant to fail
        //    `assertExplicitPinnedWorktreeIssueRunnable` (WORKSPACE_WORKTREE_REQUIRES_PROJECT),
        //    and inference would instead quietly bind it to whichever project the
        //    assignee happens to lead. A caller who names a workspace mode has said
        //    something about where this runs; honour it and let the validation speak.
        //    Nullable API payloads are not workspace intent: explicit null workspace
        //    fields mean "no workspace override" and follow the same inference path as
        //    omitted fields, matching `projectId: null` above. That null-tolerance is
        //    scoped to THIS guard — hence `hasExecutionWorkspaceIntent` here versus
        //    `hasExplicitExecutionWorkspaceOverride` at the two inheritance sites above.
        //    Do not re-merge them: for inheritance, explicit nulls are a deliberate
        //    opt-out ("do not adopt the parent's workspace") and must keep suppressing
        //    it. Collapsing both onto `!= null` regressed exactly that and let a
        //    liveness escalation adopt its blocker's checkout.
        //    Intake sends none of these fields, so the fix still fires where it matters.
        //    Inert when `enableIsolatedWorkspaces` is off, and correctly so: create()
        //    deletes all three fields in that mode, so the flag is already false — and
        //    the same setting gates assertExplicitPinnedWorktreeIssueRunnable, so there
        //    is no rejection left to preserve.
        if (
          issueData.projectId == null &&
          issueData.assigneeAgentId &&
          issueData.parentId == null &&
          workspaceInheritanceIssueId == null &&
          !hasWorkspaceIntent
        ) {
          const ledProjects = await tx
            .select({ id: projects.id })
            .from(projects)
            .where(
              and(
                eq(projects.companyId, companyId),
                eq(projects.leadAgentId, issueData.assigneeAgentId),
                isNull(projects.archivedAt),
              ),
            )
            .limit(2);
          if (ledProjects.length === 1) {
            issueData.projectId = ledProjects[0].id;
          }
        }
        const projectGoalId = await getProjectDefaultGoalId(tx, companyId, issueData.projectId);
        // Cache the project policy lookup for this insert. Both the
        // default-settings block and the assignee-environment-promotion block
        // need the same row; without caching they'd issue two round-trips.
        let projectPolicyCached: ReturnType<typeof parseProjectExecutionWorkspacePolicy> | null = null;
        let projectPolicyLoaded = false;
        const loadProjectPolicyOnce = async () => {
          if (projectPolicyLoaded) return projectPolicyCached;
          projectPolicyLoaded = true;
          if (!issueData.projectId) return null;
          const projectRow = await tx
            .select({ executionWorkspacePolicy: projects.executionWorkspacePolicy })
            .from(projects)
            .where(and(eq(projects.id, issueData.projectId), eq(projects.companyId, companyId)))
            .then((rows) => rows[0] ?? null);
          projectPolicyCached = parseProjectExecutionWorkspacePolicy(projectRow?.executionWorkspacePolicy);
          return projectPolicyCached;
        };

        if (
          executionWorkspaceSettings == null &&
          executionWorkspaceId == null &&
          issueData.projectId
        ) {
          executionWorkspaceSettings =
            defaultIssueExecutionWorkspaceSettingsForProject(
              gateProjectExecutionWorkspacePolicy(
                await loadProjectPolicyOnce(),
                isolatedWorkspacesEnabled,
              ),
            ) as Record<string, unknown> | null;
        }
        if (!projectWorkspaceId && issueData.projectId) {
          const project = await tx
            .select({
              executionWorkspacePolicy: projects.executionWorkspacePolicy,
            })
            .from(projects)
            .where(and(eq(projects.id, issueData.projectId), eq(projects.companyId, companyId)))
            .then((rows) => rows[0] ?? null);
          const projectPolicy = parseProjectExecutionWorkspacePolicy(project?.executionWorkspacePolicy);
          projectWorkspaceId = projectPolicy?.defaultProjectWorkspaceId ?? null;
          if (!projectWorkspaceId) {
            projectWorkspaceId = await tx
              .select({ id: projectWorkspaces.id })
              .from(projectWorkspaces)
              .where(and(eq(projectWorkspaces.projectId, issueData.projectId), eq(projectWorkspaces.companyId, companyId)))
              .orderBy(desc(projectWorkspaces.isPrimary), asc(projectWorkspaces.createdAt), asc(projectWorkspaces.id))
              .then((rows) => rows[0]?.id ?? null);
          }
        }
        if (projectWorkspaceId) {
          await assertValidProjectWorkspace(companyId, issueData.projectId, projectWorkspaceId, tx);
        }
        if (executionWorkspaceId) {
          await assertValidExecutionWorkspace(companyId, issueData.projectId, executionWorkspaceId, tx);
        }
        if (isolatedWorkspacesEnabled && issueData.executionWorkspaceSettings !== undefined) {
          assertExplicitPinnedWorktreeIssueRunnable({
            projectId: issueData.projectId ?? null,
            projectWorkspaceId,
            executionWorkspaceId,
            executionWorkspacePreference,
            executionWorkspaceSettings: issueData.executionWorkspaceSettings,
          });
        }
        await beforeSideEffects?.(tx);
        // Identifier minting is delegated to allocateIdentifier(), which
        // dispatches on companies.identifier_provider. The paperclip-internal
        // path runs inside this same tx (atomic counter + insert); the
        // Linear path (Task 2.2 of the linear-id-unification plan) will hit
        // Linear's GraphQL before the issues insert, taking the identifier
        // back out-of-tx. For now every company stays on paperclip-source,
        // so behaviour is unchanged from before this refactor.
        const allocation = await allocateIdentifier({
          db: tx,
          companyId,
          title: issueData.title,
          description: issueData.description,
          linkedLinearIssue,
        });
        // Capture the Linear-side issue id as soon as allocation returns so
        // the outer compensating-delete handler can fire even if the issues
        // insert below throws (FK violation, status invariant, etc.).
        // Gated on createdLinearSideIssue: if the caller passed
        // linkedLinearIssue, the Linear issue pre-existed and a tx
        // rollback must NOT delete it. Paperclip-source allocations leave
        // externalIssueId undefined and are skipped here too.
        if (allocation.createdLinearSideIssue && allocation.externalIssueId) {
          createdLinearIssueId = allocation.externalIssueId;
        }
        const issueNumber = allocation.issueNumber;
        const identifier = allocation.identifier;
        const responsibleUserId = await resolveResponsibleUserIdForIssueCreate(tx, companyId, {
          explicitResponsibleUserId: issueData.responsibleUserId ?? null,
          createdByUserId: issueData.createdByUserId ?? null,
          parentId: issueData.parentId ?? null,
          originKind: issueData.originKind ?? "manual",
          originRunId: issueData.originRunId ?? null,
          actorRunId: actorRunId ?? null,
          actorResponsibleUserId: actorResponsibleUserId ?? null,
          trustExplicitResponsibleUserId: trustExplicitResponsibleUserId === true,
        });

        const values = {
          ...issueData,
          responsibleUserId,
          requestDepth: clampIssueRequestDepth(issueData.requestDepth),
          originKind: issueData.originKind ?? "manual",
          goalId: resolveIssueGoalId({
            projectId: issueData.projectId,
            goalId: issueData.goalId,
            projectGoalId,
            defaultGoalId: defaultCompanyGoal?.id ?? null,
          }),
          ...(projectWorkspaceId ? { projectWorkspaceId } : {}),
          ...(executionWorkspaceId ? { executionWorkspaceId } : {}),
          ...(executionWorkspacePreference ? { executionWorkspacePreference } : {}),
          ...(executionWorkspaceSettings ? { executionWorkspaceSettings } : {}),
          companyId,
          issueNumber,
          identifier,
        } as typeof issues.$inferInsert;
        if (values.status === "in_progress" && !values.startedAt) {
          values.startedAt = new Date();
        }
        if (values.status === "done") {
          values.completedAt = new Date();
        }
        if (values.status === "cancelled") {
          values.cancelledAt = new Date();
        }
        Object.assign(
          values,
          buildInitialIssueMonitorFields({
            policy: normalizeIssueExecutionPolicy(issueData.executionPolicy ?? null),
            status: values.status ?? "backlog",
            assigneeAgentId: values.assigneeAgentId ?? null,
            assigneeUserId: values.assigneeUserId ?? null,
          }),
        );

        const [issue] = await tx.insert(issues).values(values).returning();

        // When the identifier was minted by Linear (companies.identifier_provider
        // = 'linear'), persist the link row in the same tx so the paperclip↔Linear
        // mapping is durably committed alongside the issue itself. If the issue
        // insert fails, the linear_issue_links row never appears and the Linear
        // counterpart created via createLinearIssue() becomes a dangling Linear
        // issue (no paperclip mirror). That's an accepted trade-off: at the
        // current write rates the rare error path is preferable to a more
        // complex compensating Linear-delete flow.
        if (allocation.source === "linear" && allocation.externalIssueId) {
          await tx.insert(linearIssueLinks).values({
            companyId,
            paperclipIssueId: issue.id,
            linearIssueId: allocation.externalIssueId,
            linearIdentifier: allocation.identifier,
          });
        } else if (linkedLinearIssue) {
          // Mirror-import into a paperclip-provider company: identifier
          // stays paperclip-internal but we still bind the cross-tracker
          // mapping so Linear-keyed lookups (`WHERE linear_identifier =
          // 'BLO-N'`) find the mirror. Without this branch, plugin sync
          // state would diverge from the host link table.
          await tx.insert(linearIssueLinks).values({
            companyId,
            paperclipIssueId: issue.id,
            linearIssueId: linkedLinearIssue.id,
            linearIdentifier: linkedLinearIssue.identifier,
          });
        }

        if (idempotencyKey) {
          await tx.insert(issueCreateIdempotencyKeys).values({
            companyId,
            idempotencyKey,
            issueId: issue.id,
          });
        }
        if (watchdog) {
          await upsertIssueWatchdogForIssue(tx, companyId, issue.id, {
            agentId: watchdog.agentId,
            instructions: watchdog.instructions,
            actor: {
              agentId: issueData.createdByAgentId ?? null,
              userId: issueData.createdByUserId ?? null,
              runId: watchdogActorRunId ?? null,
            },
          });
        }
        if (inputLabelIds) {
          await syncIssueLabels(issue.id, companyId, inputLabelIds, tx);
        }
        if (blockedByIssueIds !== undefined) {
          await syncBlockedByIssueIds(
            issue.id,
            companyId,
            blockedByIssueIds,
            {
              agentId: issueData.createdByAgentId ?? null,
              userId: issueData.createdByUserId ?? null,
            },
            tx,
          );
        }
        const [enriched] = await withIssueLabels(tx, [issue]);
        const [withRelations] = await withIssueRelationSummaries(companyId, [enriched], tx);
        return withRelations;
        });
      } catch (err) {
        // tx rolled back. If the allocator already created a Linear issue
        // (linear path), best-effort IssueDelete it so we don't leave a
        // dangling Linear issue with no paperclip counterpart. Swallow
        // cleanup errors — surfacing them would mask the real failure.
        if (createdLinearIssueId) {
          await deleteLinearIssueForCompany(db, companyId, createdLinearIssueId).catch(
            () => {
              // No logger handle here; the call site logs the original err
              // via the route layer. Cleanup failure is a known soft drop.
            },
          );
        }
        if (isAlertEscalationCoverDedupConflict(err)) {
          // BLO-15982: the partial unique index on (companyId, originKind,
          // originFingerprint) rejects a concurrent create for a dedup slot
          // another caller already claimed. Surface as a typed 409 so the
          // alertmanager plugin can distinguish "I lost the race" from a
          // real failure and attach itself to the winning cover instead.
          throw conflict("Alert escalation cover conflict", {
            companyId,
            originFingerprint: issueData.originFingerprint,
          });
        }
        throw err;
      }
    },

    update: async (
      id: string,
      data: Partial<typeof issues.$inferInsert> & {
        labelIds?: string[];
        blockedByIssueIds?: string[];
        actorAgentId?: string | null;
        actorUserId?: string | null;
        /**
         * BLO-18797: optimistic-concurrency guard. When set, the row must still
         * carry this status at write time or the update is rejected with 409.
         * Callers that authorized a mutation *because of* the row's current
         * status must pass it — the authorization check reads a snapshot loaded
         * by the route, and READ COMMITTED lets a concurrent writer (an
         * assignee checkout, say) land between that read and this write. The
         * status equality is repeated in the UPDATE's WHERE clause, not just
         * asserted against `existing`, because only the WHERE is re-evaluated
         * against the latest row version when the statement blocks on a
         * concurrent transaction.
         */
        expectedCurrentStatus?: string;
        /**
         * BLO-18797: the same optimistic-concurrency guard for the assignee.
         * `allow_manager_chain` is granted *because* the row's assignee is a
         * report of the actor, so the assignee is an authorization-relevant
         * snapshot field exactly like the status: a reassignment that lands
         * between the route's read and this write would leave the actor
         * clearing an unrelated agent's blockers under a grant that no longer
         * holds. Pinned in the UPDATE's WHERE clause for the same reason as
         * the status — only the WHERE is re-evaluated against the latest row
         * version when the statement blocks on a concurrent transaction.
         */
        expectedCurrentAssigneeAgentId?: string | null;
        /**
         * Pins the execution-stage snapshot that authorized a decision. A
         * concurrent decision or stage advance must not be overwritten by a
         * former participant acting on stale route state.
         */
        expectedCurrentExecutionState?: Record<string, unknown> | null;
        /** Pins the policy from which an execution-stage transition was derived. */
        expectedCurrentExecutionPolicy?: Record<string, unknown> | null;
      },
      dbOrTx: any = db,
    ) => {
      const existing = await dbOrTx
        .select()
        .from(issues)
        .where(eq(issues.id, id))
        .then((rows: Array<typeof issues.$inferSelect>) => rows[0] ?? null);
      if (!existing) return null;

      const {
        labelIds: nextLabelIds,
        blockedByIssueIds,
        actorAgentId,
        actorUserId,
        expectedCurrentStatus,
        expectedCurrentAssigneeAgentId,
        expectedCurrentExecutionState,
        expectedCurrentExecutionPolicy,
        ...issueData
      } = data;

      if (expectedCurrentStatus !== undefined && existing.status !== expectedCurrentStatus) {
        throw conflict("Issue status changed before the update could be applied", {
          issueId: id,
          expectedStatus: expectedCurrentStatus,
          currentStatus: existing.status,
        });
      }
      if (
        expectedCurrentAssigneeAgentId !== undefined &&
        existing.assigneeAgentId !== expectedCurrentAssigneeAgentId
      ) {
        throw conflict("Issue assignee changed before the update could be applied", {
          issueId: id,
          expectedAssigneeAgentId: expectedCurrentAssigneeAgentId,
          currentAssigneeAgentId: existing.assigneeAgentId,
        });
      }
      if (
        expectedCurrentExecutionState !== undefined &&
        JSON.stringify(existing.executionState ?? null) !== JSON.stringify(expectedCurrentExecutionState)
      ) {
        throw conflict("Issue execution stage changed before the decision could be applied", {
          issueId: id,
        });
      }
      if (
        expectedCurrentExecutionPolicy !== undefined &&
        JSON.stringify(existing.executionPolicy ?? null) !== JSON.stringify(expectedCurrentExecutionPolicy)
      ) {
        throw conflict("Issue execution policy changed before the decision could be applied", {
          issueId: id,
        });
      }
      const experimental = await instanceSettings.getExperimental();
      const isolatedWorkspacesEnabled = experimental.enableIsolatedWorkspaces;
      if (!isolatedWorkspacesEnabled) {
        delete issueData.executionWorkspaceId;
        delete issueData.executionWorkspacePreference;
        delete issueData.executionWorkspaceSettings;
      }

      if (issueData.status) {
        assertTransition(existing.status, issueData.status);
      }

      // Labels the issue will HAVE once this patch lands. Both gates below run
      // before `runUpdate`'s transaction, and `syncIssueLabels` runs inside it,
      // so a combined `{ status: "in_review", labelIds: [frontend] }` on an
      // unlabeled issue would otherwise be judged under the unlabeled fallback
      // and only then acquire the stricter frontend policy — recording a
      // pass/warn against a policy the issue no longer has, and letting a
      // single call sidestep the requirements its new labels demand.
      // (BLO-19047 review)
      const effectiveLabelNames =
        nextLabelIds === undefined
          ? null
          : await resolveLabelNames(dbOrTx, existing.companyId, nextLabelIds);

      // Done-execution gate (narrated-completion hardening, instance flag
      // `enableDoneExecutionGate`, default off). Blocks an agent self-marking
      // an issue `done` when no real execution run ever occurred, no pr-link
      // evidence was recorded, and no run-attributed durable artifact exists —
      // the failure mode where agents post "## Done" via the board API without
      // shipping code. Never gates human actors. See done-gate.ts.
      //
      // Both expensive lookups (the evidence refresh and the durable-artifact
      // query) run ONLY once the cheap checks have already decided to block, so
      // the ordinary update path is unaffected. `hasDurableArtifactEvidence:
      // false` in the pre-check is what makes that laziness correct: it can
      // only cause us to look harder, never to skip a block.
      let doneTransitionEvidenceVerdict: Awaited<ReturnType<typeof runEvidenceGate>> | null = null;
      let doneGateEvidenceVerdict = existing.lastEvidenceVerdict;
      let doneGateNeedsDurableArtifactCheck = false;
      const doneGateInput = {
        fromStatus: existing.status,
        toStatus: issueData.status,
        existingCheckoutRunId: existing.checkoutRunId,
        lastEvidenceVerdict: doneGateEvidenceVerdict,
        isAgentActor: actorAgentId != null,
        hasDurableArtifactEvidence: false,
      };
      if (experimental.enableDoneExecutionGate && shouldBlockNarratedDone(doneGateInput)) {
        try {
          doneTransitionEvidenceVerdict = await runEvidenceGate(
            (issueId, now) => fetchEvidenceForIssue(
              dbOrTx,
              issueId,
              issueData.description !== undefined ? issueData.description : existing.description,
              existing.description,
              now,
              effectiveLabelNames,
            ),
            id,
          );
          doneGateEvidenceVerdict = doneTransitionEvidenceVerdict;
        } catch (err) {
          logger.warn(
            {
              issueId: id,
              err: err instanceof Error ? err.message : String(err),
            },
            "done-execution gate: evidence refresh failed; preserving block posture",
          );
        }
        doneGateNeedsDurableArtifactCheck = shouldBlockNarratedDone({
          fromStatus: existing.status,
          toStatus: issueData.status,
          existingCheckoutRunId: existing.checkoutRunId,
          lastEvidenceVerdict: doneGateEvidenceVerdict,
          isAgentActor: actorAgentId != null,
          hasDurableArtifactEvidence: false,
        });
      }

      const patch: Partial<typeof issues.$inferInsert> = {
        ...issueData,
        updatedAt: new Date(),
      };
      if (doneTransitionEvidenceVerdict) {
        patch.lastEvidenceVerdict = doneTransitionEvidenceVerdict;
        patch.lastEvidenceVerdictEvaluatedAt = new Date(doneTransitionEvidenceVerdict.evaluatedAt);
      }
      if (issueData.requestDepth !== undefined) {
        patch.requestDepth = clampIssueRequestDepth(issueData.requestDepth);
      }

      const nextAssigneeAgentId =
        issueData.assigneeAgentId !== undefined ? issueData.assigneeAgentId : existing.assigneeAgentId;
      const nextAssigneeUserId =
        issueData.assigneeUserId !== undefined ? issueData.assigneeUserId : existing.assigneeUserId;

      if (nextAssigneeAgentId && nextAssigneeUserId) {
        throw unprocessable("Issue can only have one assignee");
      }
      if (patch.status === "in_progress" && !nextAssigneeAgentId && !nextAssigneeUserId) {
        throw unprocessable("in_progress issues require an assignee");
      }
      if (patch.status === "in_progress") {
        const unresolvedBlockerIssueIds = blockedByIssueIds !== undefined
          ? await listUnresolvedBlockerIssueIds(dbOrTx, existing.companyId, blockedByIssueIds)
          : (
              await listIssueDependencyReadinessMap(dbOrTx, existing.companyId, [id])
            ).get(id)?.unresolvedBlockerIssueIds ?? [];
        if (unresolvedBlockerIssueIds.length > 0) {
          throw unprocessable("Issue is blocked by unresolved blockers", { unresolvedBlockerIssueIds });
        }
      }
      const shouldValidateNextAssignee =
        Boolean(nextAssigneeAgentId) &&
        (issueData.assigneeAgentId !== undefined || patch.status === "in_progress");
      if (shouldValidateNextAssignee) {
        await assertAssignableAgent(dbOrTx as Db, existing.companyId, nextAssigneeAgentId, { kind: "work" });
      }
      if (issueData.assigneeUserId) {
        await assertAssignableUser(existing.companyId, issueData.assigneeUserId);
      }
      if (issueData.executionWorkspaceSettings !== undefined) {
        const nextExecutionWorkspaceSettings = parseIssueExecutionWorkspaceSettings(
          issueData.executionWorkspaceSettings,
        );
        patch.executionWorkspaceSettings = nextExecutionWorkspaceSettings
          ? { ...nextExecutionWorkspaceSettings }
          : null;
      }

      applyStatusSideEffects(issueData.status, patch);

      // Evaluation failures remain fail-open, but a computed block verdict
      // rejects every new transition to in_review.
      //
      // The gate re-evaluates on EVERY patch that carries `status: "in_review"`,
      // including in_review → in_review. It used to be transition-only, which
      // silently froze `lastEvidenceVerdict` at its first evaluation: an agent
      // following the documented remediation loop ("add the missing evidence,
      // comment again, re-send in_review") got a 200 with an unchanged stale
      // verdict and no way to tell "gate ran and still fails" from "gate never
      // ran" — the same silent-no-op class as BLO-18790. (BLO-19047)
      //
      // Only a real transition INTO in_review can throw. A re-evaluation on an
      // already-in_review issue refreshes the recorded verdict but never
      // rejects the patch, so unrelated edits (labels, description, assignee)
      // to an in_review issue cannot start failing with a 422.
      const shouldRunInReviewEvidenceGate =
        issueData.status === "in_review" ||
        (nextLabelIds !== undefined && existing.status === "in_review");
      if (shouldRunInReviewEvidenceGate) {
        const isInReviewTransition = issueData.status === "in_review" && existing.status !== "in_review";
        let inReviewVerdict: Awaited<ReturnType<typeof runEvidenceGate>> | null = null;
        try {
          const verdict = await runEvidenceGate(
            (issueId, now) => fetchEvidenceForIssue(
              dbOrTx,
              issueId,
              issueData.description !== undefined ? issueData.description : existing.description,
              existing.description,
              now,
              effectiveLabelNames,
            ),
            id,
          );
          inReviewVerdict = verdict;
          patch.lastEvidenceVerdict = isInReviewTransition
            ? verdict
            : preserveDurableLandingEvidence(verdict, existing.lastEvidenceVerdict);
          patch.lastEvidenceVerdictEvaluatedAt = new Date(verdict.evaluatedAt);
          logger.info(
            {
              issueId: id,
              companyId: existing.companyId,
              verdict: verdict.verdict,
              missing: verdict.missing,
              evidenceFound: verdict.evidenceFound,
              unlabeledFallback: verdict.unlabeledFallback,
              diagnostics: verdict.diagnostics,
              overridden: verdict.overridden,
              overrideReason: verdict.overrideReason,
              inReviewTransition: isInReviewTransition,
            },
            `evidence-gate: ${verdict.verdict} on ${
              isInReviewTransition ? "in_review transition" : "in_review re-evaluation"
            }`,
          );
        } catch (err) {
          logger.warn(
            {
              issueId: id,
              err,
            },
            "evidence-gate: evaluation failed; proceeding without verdict",
          );
        }

        if (isInReviewTransition && inReviewVerdict?.verdict === "block") {
          throw unprocessable("missing-evidence", {
            code: "missing-evidence",
            missing: inReviewVerdict.missing,
          });
        }

      }

      if (issueData.status && issueData.status !== "done") {
        patch.completedAt = null;
      }
      if (issueData.status && issueData.status !== "cancelled") {
        patch.cancelledAt = null;
      }
      if (issueData.status && issueData.status !== "in_progress") {
        patch.checkoutRunId = null;
        patch.executionRunId = null;
        patch.executionAgentNameKey = null;
        patch.executionLockedAt = null;
      }
      if (
        (issueData.assigneeAgentId !== undefined && issueData.assigneeAgentId !== existing.assigneeAgentId) ||
        (issueData.assigneeUserId !== undefined && issueData.assigneeUserId !== existing.assigneeUserId)
      ) {
        patch.checkoutRunId = null;
        patch.executionRunId = null;
        patch.executionAgentNameKey = null;
        patch.executionLockedAt = null;
      }

      const runUpdate = async (tx: any) => {
        // Parent and blocker edges share issue rows. Take one company-scoped graph
        // lock before either path starts row-level locks, so combined parent/blocker
        // patches cannot invert against blocker-only patches.
        if (issueData.parentId !== undefined || blockedByIssueIds !== undefined) {
          await lockIssueParentMutationCompany(existing.companyId, tx);
        }
        if (blockedByIssueIds !== undefined) {
          await lockBlockedByIssueRowsForUpdate(id, existing.companyId, blockedByIssueIds, tx);
        }
        if (issueData.parentId !== undefined) {
          await assertValidIssueParent(existing.companyId, id, issueData.parentId, tx);
        }
        await tx.execute(
          sql`SELECT ${issues.id} FROM ${issues}
              WHERE ${eq(issues.id, id)}
              FOR UPDATE`,
        );
        const lockedExisting = await tx
          .select()
          .from(issues)
          .where(eq(issues.id, id))
          .then((rows: Array<typeof issues.$inferSelect>) => rows[0] ?? null);
        if (!lockedExisting) return null;

        let nextProjectId = issueData.projectId !== undefined
          ? issueData.projectId
          : lockedExisting.projectId;
        const nextProjectWorkspaceId =
          issueData.projectWorkspaceId !== undefined
            ? issueData.projectWorkspaceId
            : lockedExisting.projectWorkspaceId;
        const nextExecutionWorkspaceId =
          issueData.executionWorkspaceId !== undefined
            ? issueData.executionWorkspaceId
            : lockedExisting.executionWorkspaceId;
        const nextExecutionWorkspacePreference =
          issueData.executionWorkspacePreference !== undefined
            ? issueData.executionWorkspacePreference
            : lockedExisting.executionWorkspacePreference;
        const nextExecutionWorkspaceSettings =
          issueData.executionWorkspaceSettings !== undefined
            ? parseIssueExecutionWorkspaceSettings(issueData.executionWorkspaceSettings)
            : parseIssueExecutionWorkspaceSettings(lockedExisting.executionWorkspaceSettings);
        let validatedProjectWorkspace: { projectId: string } | null = null;
        let validatedExecutionWorkspace: { projectId: string } | null = null;
        if (!nextProjectId && nextProjectWorkspaceId) {
          const workspace = await assertValidProjectWorkspace(
            lockedExisting.companyId,
            null,
            nextProjectWorkspaceId,
            tx,
          );
          validatedProjectWorkspace = workspace;
          nextProjectId = workspace.projectId;
          patch.projectId = workspace.projectId;
        }
        if (!nextProjectId && nextExecutionWorkspaceId) {
          const workspace = await assertValidExecutionWorkspace(
            lockedExisting.companyId,
            null,
            nextExecutionWorkspaceId,
            tx,
          );
          validatedExecutionWorkspace = workspace;
          nextProjectId = workspace.projectId;
          patch.projectId = workspace.projectId;
        }
        if (nextProjectWorkspaceId) {
          if (!validatedProjectWorkspace) {
            await assertValidProjectWorkspace(lockedExisting.companyId, nextProjectId, nextProjectWorkspaceId, tx);
          }
        }
        if (nextExecutionWorkspaceId) {
          if (!validatedExecutionWorkspace) {
            await assertValidExecutionWorkspace(lockedExisting.companyId, nextProjectId, nextExecutionWorkspaceId, tx);
          }
        }
        if (isolatedWorkspacesEnabled && issueData.executionWorkspaceSettings !== undefined) {
          assertExplicitPinnedWorktreeIssueRunnable({
            projectId: nextProjectId ?? null,
            projectWorkspaceId: nextProjectWorkspaceId ?? null,
            executionWorkspaceId: nextExecutionWorkspaceId ?? null,
            executionWorkspacePreference: nextExecutionWorkspacePreference ?? null,
            executionWorkspaceSettings: issueData.executionWorkspaceSettings,
          });
        }
        if (issueData.projectId !== undefined || patch.projectId !== undefined) {
          await assertValidIssueProject(lockedExisting.companyId, nextProjectId, tx);
        }
        if (
          issueData.milestoneId !== undefined ||
          issueData.projectId !== undefined ||
          patch.projectId !== undefined
        ) {
          await assertValidIssueMilestone(
            lockedExisting.companyId,
            nextProjectId,
            issueData.milestoneId !== undefined ? issueData.milestoneId : lockedExisting.milestoneId,
            tx,
          );
        }

        const defaultCompanyGoal = await getDefaultCompanyGoal(tx, lockedExisting.companyId);
        const projectIdForGoalFallback =
          issueData.projectId !== undefined || patch.projectId !== undefined ? nextProjectId : undefined;
        const [currentProjectGoalId, nextProjectGoalId] = await Promise.all([
          getProjectDefaultGoalId(tx, lockedExisting.companyId, lockedExisting.projectId),
          getProjectDefaultGoalId(
            tx,
            lockedExisting.companyId,
            projectIdForGoalFallback !== undefined ? projectIdForGoalFallback : lockedExisting.projectId,
          ),
        ]);

        patch.goalId = resolveNextIssueGoalId({
          currentProjectId: lockedExisting.projectId,
          currentGoalId: lockedExisting.goalId,
          currentProjectGoalId,
          projectId: projectIdForGoalFallback,
          goalId: issueData.goalId,
          projectGoalId: nextProjectGoalId,
          defaultGoalId: defaultCompanyGoal?.id ?? null,
        });
        if (doneGateNeedsDurableArtifactCheck) {
          let doneGateHasDurableArtifact = false;
          try {
            doneGateHasDurableArtifact = await fetchDurableArtifactEvidence(tx, id, existing.companyId);
          } catch (err) {
            logger.warn(
              {
                issueId: id,
                err: err instanceof Error ? err.message : String(err),
              },
              "done-execution gate: durable-artifact lookup failed; returning retryable error",
            );
            throw new HttpError(503, "Done-gate durable artifact evidence lookup failed", {
              reason: "done_gate_evidence_lookup_failed",
              issueId: id,
              retryable: true,
            });
          }
          if (
            shouldBlockNarratedDone({
              fromStatus: existing.status,
              toStatus: issueData.status,
              existingCheckoutRunId: existing.checkoutRunId,
              lastEvidenceVerdict: doneGateEvidenceVerdict,
              isAgentActor: actorAgentId != null,
              hasDurableArtifactEvidence: doneGateHasDurableArtifact,
            })
          ) {
            throw unprocessable(
              "Issue cannot be marked done without execution evidence (no execution run, no pr-link evidence, and no run-attributed durable artifact). Attach a PR link, or write the deliverable to an issue document (PUT /api/issues/:id/documents/:key) before closing — a comment body is not sufficient.",
              { reason: "no_execution_run_and_no_pr_evidence", issueId: id },
            );
          }
        }
        const writePreconditions = [
          ...(expectedCurrentStatus === undefined ? [] : [eq(issues.status, expectedCurrentStatus)]),
          ...(expectedCurrentAssigneeAgentId === undefined
            ? []
            : [
                expectedCurrentAssigneeAgentId === null
                  ? isNull(issues.assigneeAgentId)
                  : eq(issues.assigneeAgentId, expectedCurrentAssigneeAgentId),
              ]),
          ...(expectedCurrentExecutionState === undefined
            ? []
            : [
                expectedCurrentExecutionState === null
                  ? isNull(issues.executionState)
                  : sql`${issues.executionState} = ${JSON.stringify(expectedCurrentExecutionState)}::jsonb`,
              ]),
          ...(expectedCurrentExecutionPolicy === undefined
            ? []
            : [
                expectedCurrentExecutionPolicy === null
                  ? isNull(issues.executionPolicy)
                  : sql`${issues.executionPolicy} = ${JSON.stringify(expectedCurrentExecutionPolicy)}::jsonb`,
              ]),
        ];
        const updated = await tx
          .update(issues)
          .set(patch)
          .where(
            writePreconditions.length === 0
              ? eq(issues.id, id)
              : and(eq(issues.id, id), ...writePreconditions),
          )
          .returning()
          .then((rows: Array<typeof issues.$inferSelect>) => rows[0] ?? null);
        if (!updated) {
          // With a precondition set, zero matched rows means a concurrent writer
          // changed an authorization-relevant field after the snapshot check
          // above — the precondition genuinely failed, so surface 409 rather
          // than the 404 that a bare `return null` would produce.
          if (writePreconditions.length > 0) {
            throw conflict("Issue changed before the update could be applied", {
              issueId: id,
              ...(expectedCurrentStatus === undefined ? {} : { expectedStatus: expectedCurrentStatus }),
              ...(expectedCurrentAssigneeAgentId === undefined
                ? {}
                : { expectedAssigneeAgentId: expectedCurrentAssigneeAgentId }),
              ...(expectedCurrentExecutionState === undefined
                ? {}
                : { expectedExecutionState: true }),
              ...(expectedCurrentExecutionPolicy === undefined
                ? {}
                : { expectedExecutionPolicy: true }),
            });
          }
          return null;
        }
        if (
          (updated.status === "done" || updated.status === "cancelled") &&
          lockedExisting.status !== updated.status
        ) {
          await finalizeSummarySlotsForTerminalIssue(tx, updated);
        }
        if (nextLabelIds !== undefined) {
          await syncIssueLabels(updated.id, lockedExisting.companyId, nextLabelIds, tx);
        }
        if (blockedByIssueIds !== undefined) {
          await syncBlockedByIssueIds(
            updated.id,
            lockedExisting.companyId,
            blockedByIssueIds,
            {
              agentId: actorAgentId ?? null,
              userId: actorUserId ?? null,
            },
            tx,
          );
        }
        if (
          issueData.executionWorkspaceSettings !== undefined &&
          nextExecutionWorkspaceId &&
          nextExecutionWorkspacePreference === "reuse_existing"
        ) {
          const workspace = await tx
            .select({
              id: executionWorkspaces.id,
              metadata: executionWorkspaces.metadata,
            })
            .from(executionWorkspaces)
            .where(
              and(
                eq(executionWorkspaces.id, nextExecutionWorkspaceId),
                eq(executionWorkspaces.companyId, lockedExisting.companyId),
              ),
            )
            .then((rows: Array<{ id: string; metadata: unknown }>) => rows[0] ?? null);
          if (workspace) {
            await tx
              .update(executionWorkspaces)
              .set({
                metadata: mergeExecutionWorkspaceConfig(
                  (workspace.metadata as Record<string, unknown> | null) ?? null,
                  buildReusedExecutionWorkspaceConfigPatchFromIssueSettings(nextExecutionWorkspaceSettings),
                ),
                updatedAt: new Date(),
              })
              .where(eq(executionWorkspaces.id, workspace.id));
          }
        }
        const [enriched] = await withIssueLabels(tx, [updated]);
        if (
          (issueData.status === "done" || issueData.status === "cancelled") &&
          lockedExisting.status !== issueData.status &&
          lockedExisting.originKind === RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation
        ) {
          const parsedIncident = parseIssueGraphLivenessIncidentKey(lockedExisting.originId);
          if (parsedIncident?.issueId && parsedIncident.companyId === lockedExisting.companyId) {
            await tx
              .delete(issueRelations)
              .where(
                and(
                  eq(issueRelations.companyId, lockedExisting.companyId),
                  eq(issueRelations.issueId, lockedExisting.id),
                  eq(issueRelations.relatedIssueId, parsedIncident.issueId),
                  eq(issueRelations.type, "blocks"),
                ),
              );
          }
        }
        return enriched;
      };

      return dbOrTx === db ? db.transaction(runUpdate) : runUpdate(dbOrTx);
    },

    clearExecutionWorkspaceEnvironmentSelection: async (companyId: string, environmentId: string) => {
      const rows = await db
        .select({
          id: issues.id,
          executionWorkspaceSettings: issues.executionWorkspaceSettings,
        })
        .from(issues)
        .where(eq(issues.companyId, companyId));

      let cleared = 0;
      for (const row of rows) {
        const settings = parseIssueExecutionWorkspaceSettings(
          row.executionWorkspaceSettings,
          { includeEnvironmentId: true },
        );
        if (settings?.environmentId !== environmentId) continue;

        await db
          .update(issues)
          .set({
            executionWorkspaceSettings: {
              ...settings,
              environmentId: null,
            },
            updatedAt: new Date(),
          })
          .where(eq(issues.id, row.id));
        cleared += 1;
      }

      return cleared;
    },

    remove: (id: string) =>
      db.transaction(async (tx) => {
        const attachmentAssetIds = await tx
          .select({ assetId: issueAttachments.assetId })
          .from(issueAttachments)
          .where(eq(issueAttachments.issueId, id));
        const issueDocumentIds = await tx
          .select({ documentId: issueDocuments.documentId })
          .from(issueDocuments)
          .where(eq(issueDocuments.issueId, id));

        // Clean up FK references that don't use CASCADE or SET NULL
        await tx.delete(issueComments).where(eq(issueComments.issueId, id));
        await tx.delete(issueReadStates).where(eq(issueReadStates.issueId, id));
        await tx.delete(issueInboxArchives).where(eq(issueInboxArchives.issueId, id));
        await tx.update(financeEvents).set({ issueId: null }).where(eq(financeEvents.issueId, id));
        await tx.update(costEvents).set({ issueId: null }).where(eq(costEvents.issueId, id));
        await tx.update(issues).set({ parentId: null }).where(eq(issues.parentId, id));

        const removedIssue = await tx
          .delete(issues)
          .where(eq(issues.id, id))
          .returning()
          .then((rows) => rows[0] ?? null);

        if (removedIssue && attachmentAssetIds.length > 0) {
          await tx
            .delete(assets)
            .where(inArray(assets.id, attachmentAssetIds.map((row) => row.assetId)));
        }

        if (removedIssue && issueDocumentIds.length > 0) {
          await tx
            .delete(documents)
            .where(inArray(documents.id, issueDocumentIds.map((row) => row.documentId)));
        }

        if (!removedIssue) return null;
        const [enriched] = await withIssueLabels(tx, [removedIssue]);
        return enriched;
      }),

    checkout: async (
      id: string,
      agentId: string,
      expectedStatuses: string[],
      checkoutRunId: string | null,
      options: {
        allowSourceScopedRecoveryOwner?: boolean;
        recoveryActionId?: string | null;
        recoveryActionStatus?: string | null;
      } = {},
    ) => {
      const issueCompany = await db
        .select({ companyId: issues.companyId })
        .from(issues)
        .where(eq(issues.id, id))
        .then((rows) => rows[0] ?? null);
      if (!issueCompany) throw notFound("Issue not found");
      await assertAssignableAgent(db, issueCompany.companyId, agentId, { kind: "work" });

      const now = new Date();
      const activePauseHold = await treeControlSvc.getActivePauseHoldGate(issueCompany.companyId, id);
      if (
        activePauseHold &&
        !(await isTreeHoldInteractionCheckoutAllowed(issueCompany.companyId, checkoutRunId, activePauseHold))
      ) {
        throw conflict("Issue checkout blocked by active subtree pause hold", {
          issueId: id,
          holdId: activePauseHold.holdId,
          rootIssueId: activePauseHold.rootIssueId,
          mode: activePauseHold.mode,
          securityPrinciples: ["Complete Mediation", "Fail Securely", "Secure Defaults"],
        });
      }

      await clearExecutionRunIfTerminal(id);
      await clearCheckoutRunIfTerminal(id);

      if (checkoutRunId) {
        const routineLockOwner = await findOpenRoutineExecutionLockOwnerForIssue(db, issueCompany.companyId, id);
        if (routineLockOwner) {
          throw conflict("Routine execution already locked by another open issue", {
            issueId: id,
            ownerIssueId: routineLockOwner.id,
            ownerIdentifier: routineLockOwner.identifier,
            ownerExecutionRunId: routineLockOwner.executionRunId,
          });
        }
      }

      const dependencyReadiness = await listIssueDependencyReadinessMap(db, issueCompany.companyId, [id]);
      const unresolvedBlockerIssueIds = dependencyReadiness.get(id)?.unresolvedBlockerIssueIds ?? [];
      if (unresolvedBlockerIssueIds.length > 0) {
        throw unprocessable("Issue is blocked by unresolved blockers", { unresolvedBlockerIssueIds });
      }

      const sameRunAssigneeCondition = checkoutRunId
        ? and(
          eq(issues.assigneeAgentId, agentId),
          or(isNull(issues.checkoutRunId), eq(issues.checkoutRunId, checkoutRunId)),
        )
        : and(eq(issues.assigneeAgentId, agentId), isNull(issues.checkoutRunId));
      const executionLockCondition = checkoutRunId
        ? or(isNull(issues.executionRunId), eq(issues.executionRunId, checkoutRunId))
        : isNull(issues.executionRunId);
      const activeRecoveryOwnerCondition = options.allowSourceScopedRecoveryOwner
        ? exists(
          db
            .select({ id: issueRecoveryActions.id })
            .from(issueRecoveryActions)
            .where(
              and(
                eq(issueRecoveryActions.companyId, issues.companyId),
                eq(issueRecoveryActions.sourceIssueId, issues.id),
                eq(issueRecoveryActions.ownerAgentId, agentId),
                inArray(issueRecoveryActions.status, [...ACTIVE_RECOVERY_ACTION_STATUSES]),
              ),
            ),
        )
        : undefined;
      const updated = await db
        .update(issues)
        .set({
          assigneeAgentId: agentId,
          assigneeUserId: null,
          checkoutRunId,
          executionRunId: checkoutRunId,
          // BLO-19848: stamp the lock timestamp alongside the pointer. Without
          // it sweepStaleIssueLocks' isPreClaimLockExpired bails on
          // `if (!runId || !lockedAt) return false`, so a checkout-acquired lock
          // whose run later parks at queued/scheduled_retry is never reclaimable.
          executionLockedAt: now,
          status: "in_progress",
          startedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(issues.id, id),
            inArray(issues.status, expectedStatuses),
            activeRecoveryOwnerCondition
              ? or(isNull(issues.assigneeAgentId), sameRunAssigneeCondition, activeRecoveryOwnerCondition)
              : or(isNull(issues.assigneeAgentId), sameRunAssigneeCondition),
            executionLockCondition,
          ),
        )
        .returning()
        .then((rows) => rows[0] ?? null);

      if (updated) {
        const [enriched] = await withIssueLabels(db, [updated]);
        return enriched;
      }

      if (options.allowSourceScopedRecoveryOwner) {
        logger.warn(
          {
            issueId: id,
            agentId,
            expectedStatuses,
            recoveryActionId: options.recoveryActionId ?? null,
            recoveryActionStatus: options.recoveryActionStatus ?? null,
          },
          "source-scoped recovery owner checkout update matched no rows",
        );
      }

      const current = await db
        .select({
          id: issues.id,
          status: issues.status,
          assigneeAgentId: issues.assigneeAgentId,
          checkoutRunId: issues.checkoutRunId,
          executionRunId: issues.executionRunId,
        })
        .from(issues)
        .where(eq(issues.id, id))
        .then((rows) => rows[0] ?? null);

      if (!current) throw notFound("Issue not found");

      if (options.allowSourceScopedRecoveryOwner && current.assigneeAgentId !== agentId) {
        throw conflict("Issue checkout failed — authorization or status mismatch", {
          issueId: current.id,
          status: current.status,
          assigneeAgentId: current.assigneeAgentId,
          checkoutRunId: current.checkoutRunId,
          executionRunId: current.executionRunId,
        });
      }

      if (
        current.assigneeAgentId === agentId &&
        current.status === "in_progress" &&
        current.checkoutRunId == null &&
        (current.executionRunId == null || current.executionRunId === checkoutRunId) &&
        checkoutRunId
      ) {
        const adoptedAt = new Date();
        const adopted = await db
          .update(issues)
          .set({
            checkoutRunId,
            executionRunId: checkoutRunId,
            // BLO-19848: see the checkout site above — a lock pointer without a
            // lock timestamp is unreclaimable by the stale-lock sweeper.
            executionLockedAt: adoptedAt,
            updatedAt: adoptedAt,
          })
          .where(
            and(
              eq(issues.id, id),
              eq(issues.status, "in_progress"),
              eq(issues.assigneeAgentId, agentId),
              isNull(issues.checkoutRunId),
              or(isNull(issues.executionRunId), eq(issues.executionRunId, checkoutRunId)),
            ),
          )
          .returning()
          .then((rows) => rows[0] ?? null);
        if (adopted) return adopted;
      }

      if (
        checkoutRunId &&
        current.assigneeAgentId === agentId &&
        current.status === "in_progress" &&
        current.checkoutRunId &&
        current.checkoutRunId !== checkoutRunId
      ) {
        const staleAdoption = await adoptStaleCheckoutRun({
          issueId: id,
          actorAgentId: agentId,
          actorRunId: checkoutRunId,
          expectedCheckoutRunId: current.checkoutRunId,
        });
        if (staleAdoption.adopted) {
          const row = await db.select().from(issues).where(eq(issues.id, id)).then((rows) => rows[0] ?? null);
          if (!row) throw notFound("Issue not found");
          const [enriched] = await withIssueLabels(db, [row]);
          return enriched;
        }
      }

      // Adopt stale executionRunId — if the execution lock points to a terminal/missing run, clear it and proceed.
      // Only adopts when the caller's expectedStatuses guard still holds; preserves any existing assigneeUserId
      // and preserves the original startedAt when the issue is already in_progress.
      //
      // BLO-20321 deliberately left this branch terminal-only. Checkout is not
      // where the WIP defect bites (checkout adds WIP; it is parking/closing that
      // was blocked), and widening here would change which branch handles a
      // never-started owner — this one preserves startedAt, the
      // clearStaleExecutionLock fallback below resets it. A never-started owner
      // now falls through to that fallback and is adopted there.
      if (
        checkoutRunId &&
        current.executionRunId &&
        current.executionRunId !== checkoutRunId &&
        (current.assigneeAgentId === agentId || current.assigneeAgentId == null)
      ) {
        const stale = await isTerminalOrMissingHeartbeatRun(current.executionRunId);
        if (stale) {
          const now = new Date();
          const adoptionSet: Record<string, unknown> = {
            assigneeAgentId: agentId,
            checkoutRunId,
            executionRunId: checkoutRunId,
            executionAgentNameKey: null,
            executionLockedAt: now,
            status: "in_progress",
            updatedAt: now,
          };
          if (current.status !== "in_progress") {
            adoptionSet.startedAt = now;
          }
          const adopted = await db
            .update(issues)
            .set(adoptionSet)
            .where(
              and(
                eq(issues.id, id),
                inArray(issues.status, expectedStatuses),
                eq(issues.executionRunId, current.executionRunId),
                or(isNull(issues.assigneeAgentId), eq(issues.assigneeAgentId, agentId)),
              ),
            )
            .returning()
            .then((rows) => rows[0] ?? null);
          if (adopted) {
            const [enriched] = await withIssueLabels(db, [adopted]);
            return enriched;
          }
        }
      }

      // If this run already owns it and it's in_progress, return it (no self-409)
      if (
        current.assigneeAgentId === agentId &&
        current.status === "in_progress" &&
        sameRunLock(current.checkoutRunId, checkoutRunId)
      ) {
        const row = await db.select().from(issues).where(eq(issues.id, id)).then((rows) => rows[0] ?? null);
        if (!row) throw notFound("Issue not found");
        const [enriched] = await withIssueLabels(db, [row]);
        return enriched;
      }

      // If an executionRunId is blocking checkout but its run is dead, clear it and retry
      if (
        current.executionRunId &&
        current.executionRunId !== checkoutRunId &&
        (current.assigneeAgentId === agentId || current.assigneeAgentId == null)
      ) {
        const cleared = await clearStaleExecutionLock({
          issueId: id,
          expectedCheckoutRunId: current.checkoutRunId,
          expectedExecutionRunId: current.executionRunId,
          actorRunId: checkoutRunId,
        });
        if (cleared) {
          const now = new Date();
          const retried = await db
            .update(issues)
            .set({
              assigneeAgentId: agentId,
              assigneeUserId: null,
              checkoutRunId,
              executionRunId: checkoutRunId,
              // BLO-19848: see the checkout site above.
              executionLockedAt: now,
              status: "in_progress",
              startedAt: now,
              updatedAt: now,
            })
            .where(
              and(
                eq(issues.id, id),
                inArray(issues.status, expectedStatuses),
                isNull(issues.executionRunId),
                current.checkoutRunId
                  ? eq(issues.checkoutRunId, current.checkoutRunId)
                  : isNull(issues.checkoutRunId),
              ),
            )
            .returning()
            .then((rows) => rows[0] ?? null);
          if (retried) {
            await cancelStaleIssueContextRuns({
              companyId: retried.companyId,
              issueId: retried.id,
              keepRunId: checkoutRunId,
              reason: "Cancelled because the stale issue execution lock was adopted by the current run",
              errorCode: "issue_execution_lock_adopted",
            });
            const [enriched] = await withIssueLabels(db, [retried]);
            return enriched;
          }
        }
      }

      // in_review is intentionally not claimable via checkout (it is excluded from every
      // caller's expectedStatuses, matching shouldAutoCheckoutIssueForWake). When the caller
      // already owns the issue and there is no active checkout/execution owner, the generic
      // "Issue checkout conflict" 409 is misleading: there is no owner to conflict with. Surface
      // a typed 422 pointing at the review-mutation path instead — the assignee can already
      // PATCH/comment/close their own in_review issue without checkout (BLO-8454).
      if (
        current.status === "in_review" &&
        current.assigneeAgentId === agentId &&
        current.checkoutRunId == null &&
        current.executionRunId == null
      ) {
        throw unprocessable("Issue in review is not checked out", {
          code: "issue_in_review_not_checkoutable",
          issueId: current.id,
          status: current.status,
          assigneeAgentId: current.assigneeAgentId,
          checkoutRunId: current.checkoutRunId,
          executionRunId: current.executionRunId,
          supportedMutationPath:
            "Assignees may update, comment on, or close their own in_review issue directly via " +
            "PATCH /issues/{id} without checkout. To resume active work, PATCH status to in_progress first.",
        });
      }

      throw conflict("Issue checkout conflict", {
        issueId: current.id,
        status: current.status,
        assigneeAgentId: current.assigneeAgentId,
        checkoutRunId: current.checkoutRunId,
        executionRunId: current.executionRunId,
      });
    },

    assertCheckoutOwner: async (id: string, actorAgentId: string, actorRunId: string | null) => {
      await clearExecutionRunIfTerminal(id);
      await clearCheckoutRunIfTerminal(id);
      const loadCurrent = () =>
        db
          .select({
            id: issues.id,
            companyId: issues.companyId,
            status: issues.status,
            assigneeAgentId: issues.assigneeAgentId,
            checkoutRunId: issues.checkoutRunId,
            executionRunId: issues.executionRunId,
          })
          .from(issues)
          .where(eq(issues.id, id))
          .then((rows) => rows[0] ?? null);
      const current = await loadCurrent();

      if (!current) throw notFound("Issue not found");

      const resolveSameRunOwnership = (candidate: {
        id: string;
        companyId: string;
        status: string;
        assigneeAgentId: string | null;
        checkoutRunId: string | null;
        executionRunId: string | null;
      }) => {
        if (
          candidate.status === "in_progress" &&
          candidate.assigneeAgentId === actorAgentId &&
          sameRunLock(candidate.checkoutRunId, actorRunId)
        ) {
          return { ...candidate, adoptedFromRunId: null as string | null };
        }
        return null;
      };

      const canAdoptUnownedCheckout = (candidate: {
        status: string;
        assigneeAgentId: string | null;
        checkoutRunId: string | null;
        executionRunId: string | null;
      }) => (
        actorRunId
        && candidate.status === "in_progress"
        && candidate.assigneeAgentId === actorAgentId
        && candidate.checkoutRunId == null
        && (candidate.executionRunId == null || candidate.executionRunId === actorRunId)
      );

      const resolveOwnership = async (
        candidate: {
          id: string;
          companyId: string;
          status: string;
          assigneeAgentId: string | null;
          checkoutRunId: string | null;
          executionRunId: string | null;
        },
      ) => {
        const sameRunOwnership = resolveSameRunOwnership(candidate);
        if (sameRunOwnership) return { ownership: sameRunOwnership, latest: null };

        if (canAdoptUnownedCheckout(candidate)) {
          const adopted = await adoptUnownedCheckoutRun({
            issueId: id,
            actorAgentId,
            actorRunId: actorRunId!,
          });

          if (adopted) {
            return {
              ownership: {
                ...adopted,
                adoptedFromRunId: null as string | null,
              },
              latest: null,
            };
          }
        }

        if (
          actorRunId &&
          candidate.status === "in_progress" &&
          candidate.assigneeAgentId === actorAgentId &&
          candidate.checkoutRunId &&
          candidate.checkoutRunId !== actorRunId
        ) {
          const previousCheckoutRunId = candidate.checkoutRunId;
          const staleAdoption = await adoptStaleCheckoutRun({
            issueId: id,
            actorAgentId,
            actorRunId,
            expectedCheckoutRunId: previousCheckoutRunId,
          });

          if (staleAdoption.adopted) {
            return {
              ownership: {
                ...staleAdoption.adopted,
                adoptedFromRunId: previousCheckoutRunId,
              },
              latest: null,
            };
          }

          const latestCandidate = staleAdoption.latest ?? candidate;
          // Active issue-scoped runs may supersede one older owner, but must not
          // collapse divergent ownership after stale adoption rejected either
          // side. In particular, a reapable execution owner cannot make a
          // distinct live checkout owner replaceable.
          if (latestCandidate.checkoutRunId === latestCandidate.executionRunId) {
            const activeActorRun = await adoptActiveActorIssueRun({
              issueId: id,
              companyId: latestCandidate.companyId,
              actorAgentId,
              actorRunId,
              expectedCheckoutRunId: latestCandidate.checkoutRunId,
              expectedExecutionRunId: latestCandidate.executionRunId,
            });

            if (activeActorRun) {
              return {
                ownership: {
                  ...activeActorRun,
                  adoptedFromRunId: latestCandidate.checkoutRunId,
                },
                latest: null,
              };
            }
          }

          if (staleAdoption.latest) {
            const latestOwnership = resolveSameRunOwnership(staleAdoption.latest);
            if (latestOwnership) return { ownership: latestOwnership, latest: staleAdoption.latest };
            return { ownership: null, latest: staleAdoption.latest };
          }
        }

        return { ownership: null, latest: null };
      };

      const resolved = await resolveOwnership(current);
      if (resolved.ownership) return resolved.ownership;

      const latest = resolved.latest ?? await loadCurrent();
      if (!latest) throw notFound("Issue not found");
      const resolvedLatest = await resolveOwnership(latest);
      if (resolvedLatest.ownership) return resolvedLatest.ownership;
      if (resolvedLatest.latest) {
        throw conflict("Issue run ownership conflict", {
          issueId: resolvedLatest.latest.id,
          status: resolvedLatest.latest.status,
          assigneeAgentId: resolvedLatest.latest.assigneeAgentId,
          checkoutRunId: resolvedLatest.latest.checkoutRunId,
          executionRunId: resolvedLatest.latest.executionRunId,
          actorAgentId,
          actorRunId,
        });
      }

      if (
        actorRunId &&
        current.status === "in_progress" &&
        current.assigneeAgentId === actorAgentId &&
        current.checkoutRunId == null &&
        current.executionRunId &&
        current.executionRunId !== actorRunId
      ) {
        const activeActorRun = await adoptActiveActorIssueRun({
          issueId: id,
          companyId: current.companyId,
          actorAgentId,
          actorRunId,
          expectedCheckoutRunId: null,
          expectedExecutionRunId: current.executionRunId,
        });

        if (activeActorRun) {
          return {
            ...activeActorRun,
            adoptedFromRunId: current.executionRunId,
          };
        }
      }

      if (
        actorRunId &&
        current.status === "in_progress" &&
        current.assigneeAgentId === actorAgentId &&
        current.checkoutRunId &&
        current.checkoutRunId !== actorRunId
      ) {
        const staleAdoption = await adoptStaleCheckoutRun({
          issueId: id,
          actorAgentId,
          actorRunId,
          expectedCheckoutRunId: current.checkoutRunId,
        });

        if (staleAdoption.adopted) {
          return {
            ...staleAdoption.adopted,
            adoptedFromRunId: current.checkoutRunId,
          };
        }

        const activeActorRun = await adoptActiveActorIssueRun({
          issueId: id,
          companyId: current.companyId,
          actorAgentId,
          actorRunId,
          expectedCheckoutRunId: current.checkoutRunId,
          expectedExecutionRunId: current.executionRunId,
        });

        if (activeActorRun) {
          return {
            ...activeActorRun,
            adoptedFromRunId: current.checkoutRunId,
          };
        }
      }

      // Clear stale execution lock from a dead run before giving up
      if (
        actorRunId &&
        current.status === "in_progress" &&
        current.assigneeAgentId === actorAgentId &&
        current.executionRunId &&
        current.executionRunId !== actorRunId
      ) {
        const cleared = await clearStaleExecutionLock({
          issueId: id,
          expectedCheckoutRunId: current.checkoutRunId,
          expectedExecutionRunId: current.executionRunId,
          actorRunId,
        });
        if (cleared) {
          const refreshed = await db
            .update(issues)
            .set({
              checkoutRunId: actorRunId,
              executionRunId: actorRunId,
              executionLockedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(issues.id, id),
                eq(issues.status, "in_progress"),
                eq(issues.assigneeAgentId, actorAgentId),
                isNull(issues.executionRunId),
                current.checkoutRunId
                  ? eq(issues.checkoutRunId, current.checkoutRunId)
                  : isNull(issues.checkoutRunId),
              ),
            )
            .returning({
              id: issues.id,
              companyId: issues.companyId,
              status: issues.status,
              assigneeAgentId: issues.assigneeAgentId,
              checkoutRunId: issues.checkoutRunId,
            })
            .then((rows) => rows[0] ?? null);
          if (refreshed) {
            await cancelStaleIssueContextRuns({
              companyId: refreshed.companyId,
              issueId: refreshed.id,
              keepRunId: actorRunId,
              reason: "Cancelled because the stale issue execution lock was adopted by the current run",
              errorCode: "issue_execution_lock_adopted",
            });
            return { ...refreshed, adoptedFromRunId: current.executionRunId };
          }
        }
      }

      throw conflict("Issue run ownership conflict", {
        issueId: latest.id,
        status: latest.status,
        assigneeAgentId: latest.assigneeAgentId,
        checkoutRunId: latest.checkoutRunId,
        executionRunId: latest.executionRunId,
        actorAgentId,
        actorRunId,
      });
    },

    release: async (id: string, actorAgentId?: string, actorRunId?: string | null) =>
      db.transaction(async (tx) => {
        await tx.execute(
          sql`select ${issues.id} from ${issues} where ${issues.id} = ${id} for update`,
        );
        const existing = await tx
          .select()
          .from(issues)
          .where(eq(issues.id, id))
          .then((rows) => rows[0] ?? null);

        if (!existing) return null;
        if (actorAgentId && existing.assigneeAgentId && existing.assigneeAgentId !== actorAgentId) {
          throw conflict("Only assignee can release issue");
        }
        if (actorAgentId && existing.status === "in_progress" && existing.assigneeAgentId === actorAgentId) {
          const ownerRunIds = [...new Set([
            existing.checkoutRunId,
            existing.executionRunId,
          ].filter((runId): runId is string => Boolean(runId)))].sort();
          const ownerRuns = ownerRunIds.length > 0
            ? await tx
                .select({
                  id: heartbeatRuns.id,
                  status: heartbeatRuns.status,
                  startedAt: heartbeatRuns.startedAt,
                  wakeupRequestId: heartbeatRuns.wakeupRequestId,
                })
                .from(heartbeatRuns)
                .where(inArray(heartbeatRuns.id, ownerRunIds))
                .orderBy(asc(heartbeatRuns.id))
                .for("update")
            : [];
          const ownerRunById = new Map(ownerRuns.map((run) => [run.id, run]));
          const actorOwnsRun = (runId: string | null) => Boolean(runId && actorRunId && runId === actorRunId);
          const ownerIsReleasable = (runId: string | null) =>
            !runId || actorOwnsRun(runId) || isReapableHeartbeatRunRow(ownerRunById.get(runId));

          if (!ownerIsReleasable(existing.checkoutRunId) || !ownerIsReleasable(existing.executionRunId)) {
            throw conflict("Only checkout run can release issue", {
              issueId: existing.id,
              assigneeAgentId: existing.assigneeAgentId,
              checkoutRunId: existing.checkoutRunId,
              executionRunId: existing.executionRunId,
              actorRunId: actorRunId ?? null,
            });
          }

          const cancellation = {
            reason: "Cancelled because the issue was released",
            errorCode: "issue_released",
          };
          for (const runId of ownerRunIds) {
            if (!actorOwnsRun(runId) && !(await cancelNeverStartedOwnerRun(tx, ownerRunById.get(runId), cancellation))) {
              throw conflict("Issue run ownership changed before release", {
                issueId: existing.id,
                ownerRunId: runId,
              });
            }
          }
        }

        const updated = await tx
          .update(issues)
          .set({
            status: "todo",
            assigneeAgentId: null,
            checkoutRunId: null,
            executionRunId: null,
            executionAgentNameKey: null,
            executionLockedAt: null,
            updatedAt: new Date(),
          })
          .where(eq(issues.id, id))
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!updated) return null;
        await cancelStaleIssueContextRuns({
          companyId: updated.companyId,
          issueId: updated.id,
          reason: "Cancelled because the issue was released",
          errorCode: "issue_released",
        }, tx);
        const [enriched] = await withIssueLabels(tx, [updated]);
        return enriched;
      }),

    adminForceRelease: async (id: string, options: { clearAssignee?: boolean } = {}) => {
      const result = await db.transaction(async (tx) => {
        await tx.execute(
          sql`select ${issues.id} from ${issues} where ${issues.id} = ${id} for update`,
        );
        const existing = await tx
          .select({
            id: issues.id,
            checkoutRunId: issues.checkoutRunId,
            executionRunId: issues.executionRunId,
          })
          .from(issues)
          .where(eq(issues.id, id))
          .then((rows) => rows[0] ?? null);
        if (!existing) return null;

        const patch: Partial<typeof issues.$inferInsert> = {
          checkoutRunId: null,
          executionRunId: null,
          executionAgentNameKey: null,
          executionLockedAt: null,
          updatedAt: new Date(),
        };
        if (options.clearAssignee) {
          patch.assigneeAgentId = null;
        }

        const updated = await tx
          .update(issues)
          .set(patch)
          .where(eq(issues.id, id))
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!updated) return null;

        const [enriched] = await withIssueLabels(tx, [updated]);
        return {
          issue: enriched,
          previous: {
            checkoutRunId: existing.checkoutRunId,
            executionRunId: existing.executionRunId,
          },
        };
      });
      if (result) {
        await cancelStaleIssueContextRuns({
          companyId: result.issue.companyId,
          issueId: result.issue.id,
          reason: "Cancelled because the issue was force-released",
          errorCode: "issue_force_released",
        });
      }
      return result;
    },
    forceRelease: async (id: string) => {
      const existing = await db
        .select()
        .from(issues)
        .where(eq(issues.id, id))
        .then((rows) => rows[0] ?? null);

      if (!existing) return null;

      const patch: Partial<typeof issues.$inferInsert> = {
        checkoutRunId: null,
        executionRunId: null,
        executionLockedAt: null,
        executionAgentNameKey: null,
        updatedAt: new Date(),
      };
      if (existing.status === "in_progress") {
        patch.status = "todo";
      }

      const updated = await db
        .update(issues)
        .set(patch)
        .where(eq(issues.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
      if (!updated) return null;
      await cancelStaleIssueContextRuns({
        companyId: updated.companyId,
        issueId: updated.id,
        reason: "Cancelled because the issue was force-released",
        errorCode: "issue_force_released",
      });
      const [enriched] = await withIssueLabels(db, [updated]);
      return enriched;
    },

    listLabels: (companyId: string) =>
      db.select().from(labels).where(eq(labels.companyId, companyId)).orderBy(asc(labels.name), asc(labels.id)),

    getLabelById: (id: string) =>
      db
        .select()
        .from(labels)
        .where(eq(labels.id, id))
        .then((rows) => rows[0] ?? null),

    createLabel: async (companyId: string, data: Pick<typeof labels.$inferInsert, "name" | "color">) => {
      const [created] = await db
        .insert(labels)
        .values({
          companyId,
          name: data.name.trim(),
          color: data.color,
        })
        .returning();
      return created;
    },

    deleteLabel: async (id: string) =>
      db
        .delete(labels)
        .where(eq(labels.id, id))
        .returning()
        .then((rows) => rows[0] ?? null),

    listComments: async (
      issueId: string,
      opts?: {
        afterCommentId?: string | null;
        order?: "asc" | "desc";
        limit?: number | null;
      },
    ) => {
      const order = opts?.order === "asc" ? "asc" : "desc";
      const afterCommentId = opts?.afterCommentId?.trim() || null;
      const limit =
        opts?.limit && opts.limit > 0
          ? Math.min(Math.floor(opts.limit), MAX_ISSUE_COMMENT_PAGE_LIMIT)
          : null;

      const conditions = [eq(issueComments.issueId, issueId)];
      if (afterCommentId) {
        const anchor = await db
          .select({
            id: issueComments.id,
            createdAt: issueComments.createdAt,
          })
          .from(issueComments)
          .where(and(eq(issueComments.issueId, issueId), eq(issueComments.id, afterCommentId)))
          .then((rows) => rows[0] ?? null);

        if (!anchor) return [];
        const anchorCreatedAt =
          anchor.createdAt instanceof Date
            ? anchor.createdAt
            : new Date(String(anchor.createdAt));
        conditions.push(
          order === "asc"
            ? or(
                gt(issueComments.createdAt, anchorCreatedAt),
                and(
                  eq(issueComments.createdAt, anchorCreatedAt),
                  gt(issueComments.id, anchor.id),
                ),
              )!
            : or(
                lt(issueComments.createdAt, anchorCreatedAt),
                and(
                  eq(issueComments.createdAt, anchorCreatedAt),
                  lt(issueComments.id, anchor.id),
                ),
              )!,
        );
      }

      const query = db
        .select()
        .from(issueComments)
        .where(and(...conditions))
        .orderBy(
          order === "asc" ? asc(issueComments.createdAt) : desc(issueComments.createdAt),
          order === "asc" ? asc(issueComments.id) : desc(issueComments.id),
        );

      const comments = limit ? await query.limit(limit) : await query;
      const { censorUsernameInLogs } = await instanceSettings.getGeneral();
      const enrichedComments = await enrichCommentsWithDerivedAgentAttribution(comments);
      return enrichedComments.map((comment) => redactIssueComment(comment, censorUsernameInLogs));
    },

    getCommentCursor: async (issueId: string) => {
      const [latest, countRow] = await Promise.all([
        db
          .select({
            latestCommentId: issueComments.id,
            latestCommentAt: issueComments.createdAt,
          })
          .from(issueComments)
          .where(eq(issueComments.issueId, issueId))
          .orderBy(desc(issueComments.createdAt), desc(issueComments.id))
          .limit(1)
          .then((rows) => rows[0] ?? null),
        db
          .select({
            totalComments: sql<number>`count(*)::int`,
          })
          .from(issueComments)
          .where(eq(issueComments.issueId, issueId))
          .then((rows) => rows[0] ?? null),
      ]);

      return {
        totalComments: Number(countRow?.totalComments ?? 0),
        latestCommentId: latest?.latestCommentId ?? null,
        latestCommentAt: latest?.latestCommentAt ?? null,
      };
    },

    getComment: async (commentId: string) => {
      const { censorUsernameInLogs } = await instanceSettings.getGeneral();
      const comment = await db
        .select()
        .from(issueComments)
        .where(eq(issueComments.id, commentId))
        .then((rows) => rows[0] ?? null);
      if (!comment) return null;
      const [enrichedComment] = await enrichCommentsWithDerivedAgentAttribution([comment]);
      return redactIssueComment(enrichedComment ?? comment, censorUsernameInLogs);
    },

    removeComment: async (commentId: string) => {
      const currentUserRedactionOptions = {
        enabled: (await instanceSettings.getGeneral()).censorUsernameInLogs,
      };

      return db.transaction(async (tx) => {
        const [comment] = await tx
          .delete(issueComments)
          .where(eq(issueComments.id, commentId))
          .returning();

        if (!comment) return null;

        await tx
          .update(issues)
          .set({ updatedAt: new Date() })
          .where(eq(issues.id, comment.issueId));

        return redactIssueComment(comment, currentUserRedactionOptions.enabled);
      });
    },

    tombstoneComment: async (
      commentId: string,
      actor: {
        actorType: "agent" | "user";
        agentId?: string | null;
        userId?: string | null;
        runId?: string | null;
      },
      options?: {
        afterTombstone?: (comment: IssueComment, tx: any) => Promise<void>;
      },
    ) => {
      const currentUserRedactionOptions = {
        enabled: (await instanceSettings.getGeneral()).censorUsernameInLogs,
      };

      return db.transaction(async (tx) => {
        const now = new Date();
        const [comment] = await tx
          .update(issueComments)
          .set({
            body: DELETED_ISSUE_COMMENT_BODY,
            presentation: null,
            metadata: null,
            deletedAt: now,
            deletedByType: actor.actorType,
            deletedByAgentId: actor.actorType === "agent" ? actor.agentId ?? null : null,
            deletedByUserId: actor.actorType === "user" ? actor.userId ?? null : null,
            deletedByRunId: actor.runId ?? null,
            updatedAt: now,
          })
          .where(and(eq(issueComments.id, commentId), isNull(issueComments.deletedAt)))
          .returning();

        if (!comment) return null;

        await tx
          .update(issues)
          .set({ updatedAt: now })
          .where(eq(issues.id, comment.issueId));

        const redacted = redactIssueComment(comment, currentUserRedactionOptions.enabled);
        await options?.afterTombstone?.(redacted, tx);

        return redacted;
      });
    },

    getCommentByIdempotencyKey: async (
      issueId: string,
      idempotencyKey: string,
      actor: { agentId?: string | null; userId?: string | null },
      dbOrTx: any = db,
    ) => {
      const comment = await dbOrTx
        .select()
        .from(issueComments)
        .where(and(
          eq(issueComments.issueId, issueId),
          eq(issueComments.idempotencyKey, idempotencyKey),
          issueCommentIdempotencyAuthorScope(actor),
          isNull(issueComments.deletedAt),
        ))
        .then((rows: Array<typeof issueComments.$inferSelect>) => rows[0] ?? null);
      if (!comment) return null;

      const currentUserRedactionOptions = {
        enabled: (await instanceSettings.getGeneral()).censorUsernameInLogs,
      };
      return redactIssueComment(comment, currentUserRedactionOptions.enabled);
    },

    markCommentIdempotencyProcessed: async (commentId: string, dbOrTx: any = db) => {
      await dbOrTx
        .update(issueComments)
        .set({ idempotencyProcessedAt: new Date() })
        .where(and(
          eq(issueComments.id, commentId),
          isNotNull(issueComments.idempotencyKey),
          isNull(issueComments.idempotencyProcessedAt),
          isNull(issueComments.deletedAt),
        ));
    },

    addComment: async (
      issueId: string,
      body: string,
      actor: { agentId?: string; userId?: string; runId?: string | null },
      options?: {
        authorType?: IssueCommentAuthorType | null;
        presentation?: IssueCommentPresentation | null;
        metadata?: IssueCommentMetadata | null;
        idempotencyKey?: string | null;
        sourceTrust?: typeof issueComments.$inferInsert.sourceTrust;
        createdAt?: Date | string | null;
      },
      dbOrTx: any = db,
    ) => {
      const issue = await dbOrTx
        .select({ companyId: issues.companyId })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows: Array<{ companyId: string }>) => rows[0] ?? null);

      if (!issue) throw notFound("Issue not found");

      const currentUserRedactionOptions = {
        enabled: (await instanceSettings.getGeneral()).censorUsernameInLogs,
      };
      const redactedBody = redactCurrentUserText(body, currentUserRedactionOptions);
      const authorType = issueCommentAuthorTypeSchema.parse(
        options?.authorType ?? (actor.agentId ? "agent" : actor.userId ? "user" : "system"),
      );
      assertIssueCommentAuthorTypeAllowed(actor, authorType);
      const presentation = issueCommentPresentationSchema.nullable().parse(options?.presentation ?? null);
      const metadata = issueCommentMetadataSchema.nullable().parse(options?.metadata ?? null);
      const createdAt = options?.createdAt ? new Date(options.createdAt) : null;
      const [insertedComment] = await dbOrTx
        .insert(issueComments)
        .values({
          companyId: issue.companyId,
          issueId,
          authorAgentId: actor.agentId ?? null,
          authorUserId: actor.userId ?? null,
          authorType,
          createdByRunId: actor.runId ?? null,
          idempotencyKey: options?.idempotencyKey ?? null,
          body: redactedBody,
          presentation,
          metadata,
          sourceTrust: options?.sourceTrust ?? null,
          ...(createdAt && !Number.isNaN(createdAt.getTime()) ? { createdAt } : {}),
        })
        .onConflictDoNothing()
        .returning();

      const comment = insertedComment ?? (options?.idempotencyKey
        ? await dbOrTx
            .select()
            .from(issueComments)
            .where(and(
              eq(issueComments.issueId, issueId),
              eq(issueComments.idempotencyKey, options.idempotencyKey),
              issueCommentIdempotencyAuthorScope(actor),
              isNull(issueComments.deletedAt),
            ))
            .then((rows: Array<typeof issueComments.$inferSelect>) => rows[0] ?? null)
        : null);

      if (!comment) throw conflict("Issue comment idempotency conflict");

      if (!insertedComment) {
        return {
          ...redactIssueComment(comment, currentUserRedactionOptions.enabled),
          deduplicated: true as const,
        };
      }

      // Update issue's updatedAt so comment activity is reflected in recency sorting
      await dbOrTx
        .update(issues)
        .set({ updatedAt: new Date() })
        .where(eq(issues.id, issueId));

      return redactIssueComment(comment, currentUserRedactionOptions.enabled);
    },

    createAttachment: async (input: {
      issueId: string;
      issueCommentId?: string | null;
      provider: string;
      objectKey: string;
      contentType: string;
      byteSize: number;
      sha256: string;
      originalFilename?: string | null;
      createdByAgentId?: string | null;
      createdByUserId?: string | null;
    }) => {
      const issue = await db
        .select({ id: issues.id, companyId: issues.companyId })
        .from(issues)
        .where(eq(issues.id, input.issueId))
        .then((rows) => rows[0] ?? null);
      if (!issue) throw notFound("Issue not found");

      if (input.issueCommentId) {
        const comment = await db
          .select({ id: issueComments.id, companyId: issueComments.companyId, issueId: issueComments.issueId })
          .from(issueComments)
          .where(eq(issueComments.id, input.issueCommentId))
          .then((rows) => rows[0] ?? null);
        if (!comment) throw notFound("Issue comment not found");
        if (comment.companyId !== issue.companyId || comment.issueId !== issue.id) {
          throw unprocessable("Attachment comment must belong to same issue and company");
        }
      }

      return db.transaction(async (tx) => {
        const [asset] = await tx
          .insert(assets)
          .values({
            companyId: issue.companyId,
            provider: input.provider,
            objectKey: input.objectKey,
            contentType: input.contentType,
            byteSize: input.byteSize,
            sha256: input.sha256,
            originalFilename: input.originalFilename ?? null,
            createdByAgentId: input.createdByAgentId ?? null,
            createdByUserId: input.createdByUserId ?? null,
          })
          .returning();

        const [attachment] = await tx
          .insert(issueAttachments)
          .values({
            companyId: issue.companyId,
            issueId: issue.id,
            assetId: asset.id,
            issueCommentId: input.issueCommentId ?? null,
          })
          .returning();

        return {
          id: attachment.id,
          companyId: attachment.companyId,
          issueId: attachment.issueId,
          issueCommentId: attachment.issueCommentId,
          assetId: attachment.assetId,
          provider: asset.provider,
          objectKey: asset.objectKey,
          contentType: asset.contentType,
          byteSize: asset.byteSize,
          sha256: asset.sha256,
          originalFilename: asset.originalFilename,
          createdByAgentId: asset.createdByAgentId,
          createdByUserId: asset.createdByUserId,
          createdAt: attachment.createdAt,
          updatedAt: attachment.updatedAt,
        };
      });
    },

    listAttachments: async (issueId: string) =>
      db
        .select({
          id: issueAttachments.id,
          companyId: issueAttachments.companyId,
          issueId: issueAttachments.issueId,
          issueCommentId: issueAttachments.issueCommentId,
          assetId: issueAttachments.assetId,
          provider: assets.provider,
          objectKey: assets.objectKey,
          contentType: assets.contentType,
          byteSize: assets.byteSize,
          sha256: assets.sha256,
          originalFilename: assets.originalFilename,
          createdByAgentId: assets.createdByAgentId,
          createdByUserId: assets.createdByUserId,
          createdAt: issueAttachments.createdAt,
          updatedAt: issueAttachments.updatedAt,
        })
        .from(issueAttachments)
        .innerJoin(assets, eq(issueAttachments.assetId, assets.id))
        .where(eq(issueAttachments.issueId, issueId))
        .orderBy(desc(issueAttachments.createdAt)),

    getAttachmentById: async (id: string) =>
      db
        .select({
          id: issueAttachments.id,
          companyId: issueAttachments.companyId,
          issueId: issueAttachments.issueId,
          issueCommentId: issueAttachments.issueCommentId,
          assetId: issueAttachments.assetId,
          provider: assets.provider,
          objectKey: assets.objectKey,
          contentType: assets.contentType,
          byteSize: assets.byteSize,
          sha256: assets.sha256,
          originalFilename: assets.originalFilename,
          createdByAgentId: assets.createdByAgentId,
          createdByUserId: assets.createdByUserId,
          createdAt: issueAttachments.createdAt,
          updatedAt: issueAttachments.updatedAt,
        })
        .from(issueAttachments)
        .innerJoin(assets, eq(issueAttachments.assetId, assets.id))
        .where(eq(issueAttachments.id, id))
        .then((rows) => rows[0] ?? null),

    removeAttachment: async (id: string) =>
      db.transaction(async (tx) => {
        const existing = await tx
          .select({
            id: issueAttachments.id,
            companyId: issueAttachments.companyId,
            issueId: issueAttachments.issueId,
            issueCommentId: issueAttachments.issueCommentId,
            assetId: issueAttachments.assetId,
            provider: assets.provider,
            objectKey: assets.objectKey,
            contentType: assets.contentType,
            byteSize: assets.byteSize,
            sha256: assets.sha256,
            originalFilename: assets.originalFilename,
            createdByAgentId: assets.createdByAgentId,
            createdByUserId: assets.createdByUserId,
            createdAt: issueAttachments.createdAt,
            updatedAt: issueAttachments.updatedAt,
          })
          .from(issueAttachments)
          .innerJoin(assets, eq(issueAttachments.assetId, assets.id))
          .where(eq(issueAttachments.id, id))
          .then((rows) => rows[0] ?? null);
        if (!existing) return null;

        await tx.delete(issueAttachments).where(eq(issueAttachments.id, id));
        await tx.delete(assets).where(eq(assets.id, existing.assetId));
        return existing;
      }),

    findMentionedAgents: async (companyId: string, body: string) => {
      const explicitAgentMentionIds = extractAgentMentionIds(body);
      if (explicitAgentMentionIds.length === 0) return [];

      const rows = await db.select({ id: agents.id })
        .from(agents).where(eq(agents.companyId, companyId));
      const companyAgentIds = new Set(rows.map((agent) => agent.id));
      return explicitAgentMentionIds.filter((agentId) => companyAgentIds.has(agentId));
    },

    findMentionedProjectIds: async (
      issueId: string,
      opts?: { includeCommentBodies?: boolean },
    ) => {
      const issue = await db
        .select({
          companyId: issues.companyId,
          title: issues.title,
          description: issues.description,
        })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null);
      if (!issue) return [];

      const mentionedIds = new Set<string>();
      for (const source of [issue.title, issue.description ?? ""]) {
        for (const projectId of extractProjectMentionIds(source)) {
          mentionedIds.add(projectId);
        }
      }

      if (opts?.includeCommentBodies !== false) {
        const comments = await db
          .select({ body: issueComments.body })
          .from(issueComments)
          .where(and(eq(issueComments.issueId, issueId), isNull(issueComments.deletedAt)));

        for (const comment of comments) {
          for (const projectId of extractProjectMentionIds(comment.body)) {
            mentionedIds.add(projectId);
          }
        }
      }

      if (mentionedIds.size === 0) return [];

      const rows = await db
        .select({ id: projects.id })
        .from(projects)
        .where(
          and(
            eq(projects.companyId, issue.companyId),
            inArray(projects.id, [...mentionedIds]),
          ),
        );
      const valid = new Set(rows.map((row) => row.id));
      return [...mentionedIds].filter((projectId) => valid.has(projectId));
    },

    getAncestors: async (issueId: string) => {
      const raw: Array<{
        id: string; identifier: string | null; title: string; description: string | null;
        status: string; priority: string;
        assigneeAgentId: string | null; projectId: string | null; goalId: string | null;
      }> = [];
      const visited = new Set<string>([issueId]);
      const start = await db.select().from(issues).where(eq(issues.id, issueId)).then(r => r[0] ?? null);
      let currentId = start?.parentId ?? null;
      while (currentId && !visited.has(currentId) && raw.length < 50) {
        visited.add(currentId);
        const parent = await db.select({
          id: issues.id, identifier: issues.identifier, title: issues.title, description: issues.description,
          status: issues.status, priority: issues.priority,
          assigneeAgentId: issues.assigneeAgentId, projectId: issues.projectId,
          goalId: issues.goalId, parentId: issues.parentId,
        }).from(issues).where(eq(issues.id, currentId)).then(r => r[0] ?? null);
        if (!parent) break;
        raw.push({
          id: parent.id, identifier: parent.identifier ?? null, title: parent.title, description: parent.description ?? null,
          status: parent.status, priority: parent.priority,
          assigneeAgentId: parent.assigneeAgentId ?? null,
          projectId: parent.projectId ?? null, goalId: parent.goalId ?? null,
        });
        currentId = parent.parentId ?? null;
      }

      // Batch-fetch referenced projects and goals
      const projectIds = [...new Set(raw.map(a => a.projectId).filter((id): id is string => id != null))];
      const goalIds = [...new Set(raw.map(a => a.goalId).filter((id): id is string => id != null))];

      const projectMap = new Map<string, {
        id: string;
        name: string;
        description: string | null;
        status: string;
        goalId: string | null;
        workspaces: Array<{
          id: string;
          companyId: string;
          projectId: string;
          name: string;
          cwd: string | null;
          repoUrl: string | null;
          repoRef: string | null;
          metadata: Record<string, unknown> | null;
          isPrimary: boolean;
          createdAt: Date;
          updatedAt: Date;
        }>;
        primaryWorkspace: {
          id: string;
          companyId: string;
          projectId: string;
          name: string;
          cwd: string | null;
          repoUrl: string | null;
          repoRef: string | null;
          metadata: Record<string, unknown> | null;
          isPrimary: boolean;
          createdAt: Date;
          updatedAt: Date;
        } | null;
      }>();
      const goalMap = new Map<string, { id: string; title: string; description: string | null; level: string; status: string }>();

      if (projectIds.length > 0) {
        const workspaceRows = await db
          .select()
          .from(projectWorkspaces)
          .where(inArray(projectWorkspaces.projectId, projectIds))
          .orderBy(desc(projectWorkspaces.isPrimary), asc(projectWorkspaces.createdAt), asc(projectWorkspaces.id));
        const workspaceMap = new Map<string, Array<(typeof workspaceRows)[number]>>();
        for (const workspace of workspaceRows) {
          const existing = workspaceMap.get(workspace.projectId);
          if (existing) existing.push(workspace);
          else workspaceMap.set(workspace.projectId, [workspace]);
        }

        const rows = await db.select({
          id: projects.id, name: projects.name, description: projects.description,
          status: projects.status, goalId: projects.goalId,
        }).from(projects).where(inArray(projects.id, projectIds));
        for (const r of rows) {
          const projectWorkspaceRows = workspaceMap.get(r.id) ?? [];
          const workspaces = projectWorkspaceRows.map((workspace) => ({
            id: workspace.id,
            companyId: workspace.companyId,
            projectId: workspace.projectId,
            name: workspace.name,
            cwd: workspace.cwd,
            repoUrl: workspace.repoUrl ?? null,
            repoRef: workspace.repoRef ?? null,
            metadata: (workspace.metadata as Record<string, unknown> | null) ?? null,
            isPrimary: workspace.isPrimary,
            createdAt: workspace.createdAt,
            updatedAt: workspace.updatedAt,
          }));
          const primaryWorkspace = workspaces.find((workspace) => workspace.isPrimary) ?? workspaces[0] ?? null;
          projectMap.set(r.id, {
            ...r,
            workspaces,
            primaryWorkspace,
          });
          // Also collect goalIds from projects
          if (r.goalId && !goalIds.includes(r.goalId)) goalIds.push(r.goalId);
        }
      }

      if (goalIds.length > 0) {
        const rows = await db.select({
          id: goals.id, title: goals.title, description: goals.description,
          level: goals.level, status: goals.status,
        }).from(goals).where(inArray(goals.id, goalIds));
        for (const r of rows) goalMap.set(r.id, r);
      }

      return raw.map(a => ({
        ...a,
        project: a.projectId ? projectMap.get(a.projectId) ?? null : null,
        goal: a.goalId ? goalMap.get(a.goalId) ?? null : null,
      }));
    },
  };
}
