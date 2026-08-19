import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, notInArray, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { clampIssueRequestDepth } from "@paperclipai/shared";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  approvals,
  companies,
  companyMemberships,
  costEvents,
  heartbeatRuns,
  issueApprovals,
  issueComments,
  issueRelations,
  issueWorkProducts,
  issues,
  linearIssueLinks,
  projects,
} from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import { assertAssignableAgent } from "./agent-assignability.js";
import { budgetService } from "./budgets.js";
import {
  allocateIdentifier,
  deleteLinearIssueForCompany,
  LinearIssueCreateUnconfirmedError,
} from "./identifier-allocator.js";
import { withIssueMonitorQueueLock } from "./issue-monitor-queue-lock.js";
import { issueService } from "./issues.js";
import { visibleIssueCondition } from "./issue-visibility.js";
import {
  recoveryAssigneeAdapterOverrides,
  withRecoveryModelProfileHint,
} from "./recovery/model-profile-hint.js";
import { RECOVERY_ORIGIN_KINDS } from "./recovery/origins.js";
import {
  PULL_REQUEST_WORK_PRODUCT_METADATA_SOURCE,
  PULL_REQUEST_WORK_PRODUCT_SOURCE_TRUST_ACTOR_ID,
} from "./pull-request-work-products.js";
import { runUsageTokenCounts } from "./recovery/zero-token-startup-failure.js";
import { extractNextActionFromText } from "./run-liveness.js";

export const PRODUCTIVITY_REVIEW_ORIGIN_KIND = RECOVERY_ORIGIN_KINDS.issueProductivityReview;
export const DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS = 10;
export const DEFAULT_PRODUCTIVITY_REVIEW_LONG_ACTIVE_HOURS = 6;
// How long a linked `pending` approval may suppress the `long_active_duration` trigger.
// Must stay comfortably above the long-active threshold or the gate would expire before it
// ever engages — `buildThresholds` clamps overrides up to `longActiveMs` to enforce that.
// Past this age the gate has itself become the stuck thing: an approval nobody
// has decided in a day is exactly the condition the detector exists to surface, so the
// suppression lapses and reviews resume.
export const DEFAULT_PRODUCTIVITY_REVIEW_APPROVAL_GATE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_PRODUCTIVITY_REVIEW_HIGH_CHURN_HOURLY = 10;
export const DEFAULT_PRODUCTIVITY_REVIEW_HIGH_CHURN_SIX_HOURS = 30;
export const DEFAULT_PRODUCTIVITY_REVIEW_RESOLVED_SNOOZE_MS = 6 * 60 * 60 * 1000;
export const PRODUCTIVITY_REVIEW_REPEAT_BACKOFF_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_PRODUCTIVITY_REVIEW_ESCALATION_THRESHOLD = 3;
export const DEFAULT_PRODUCTIVITY_REVIEW_ESCALATION_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;
export const DEFAULT_PRODUCTIVITY_REVIEW_REFRESH_INTERVAL_MS = 60 * 60 * 1000;
export const DEFAULT_PRODUCTIVITY_REVIEW_MAX_REFRESH_COMMENTS = 3;
export const DEFAULT_PRODUCTIVITY_REVIEW_CREATION_WINDOW_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_PRODUCTIVITY_REVIEW_MAX_CREATIONS_PER_WINDOW = 1;
export const DEFAULT_PRODUCTIVITY_REVIEW_MAX_CONSECUTIVE_NO_ACTION_REVIEWS = 3;
export const ISSUE_MONITOR_WAKE_CLAIM_TTL_MS = 5 * 60 * 1000;
export const ISSUE_MONITOR_DISPATCH_BATCH_SIZE = 50;
export const DEFAULT_HEARTBEAT_SCHEDULER_INTERVAL_MS = 30_000;
export const DEFAULT_PRODUCTIVITY_REVIEW_MONITOR_LAPSE_SERVICE_GRACE_MS =
  DEFAULT_HEARTBEAT_SCHEDULER_INTERVAL_MS + ISSUE_MONITOR_WAKE_CLAIM_TTL_MS;

const PRODUCTIVITY_REVIEW_RESERVATION_STALE_MS = 5 * 60 * 1000;
/**
 * Window in which a linked PR counts as a non-stale progress signal, matching
 * the "created or updated in the last 24h" wording in the Manager Decision
 * block below (BLO-19566 AC4).
 */
export const PRODUCTIVITY_REVIEW_PR_FRESH_MS = 24 * 60 * 60 * 1000;
const TERMINAL_RUN_STATUSES = ["succeeded", "interrupted", "failed", "cancelled", "timed_out"] as const;
// BLO-25410: NOT a lock predicate — this only counts recent runs for the review
// narrative (`activeRunCount`), and never decides whether an issue is
// checkoutable. Enumeration is fine here because an unknown status simply goes
// uncounted in a report. Checkoutability and `activeRun` hydration use the
// terminal complement instead — see `issue-execution-lock.ts`.
const ACTIVE_RUN_STATUSES = ["queued", "running", "scheduled_retry"] as const;
const MAX_CANDIDATE_ISSUES = 250;
const MAX_RUNS_FOR_STREAK = 100;
const MAX_NEXT_ACTION_COMMENT_CANDIDATES = 20;
const NEXT_ACTION_COMMENT_CANDIDATE_PATTERN = [
  "(^|[[:space:]])([-*]|[0-9]+[.])?[[:space:]]*next( steps?| action)?[[:space:]]*:",
  [
    "(^|[[:space:]])",
    "(i'll|i will|i am going to|i'm going to|let me|i need to|next(,| i will| i'll)?|my next step is|the next step is)",
    "[[:space:]]+(first[[:space:]]+)?",
    "(inspect|check|review|look|investigate|analy[sz]e|open|read|start|begin|work on|implement|fix|test|update|create|add)",
    "([^[:alpha:]]|$)",
  ].join(""),
].join("|");
const MAX_PARENT_WALK_DEPTH = 25;
// BLO-19848: how long a `running` execution holder may go without a genuine
// activity signal before its elapsed time stops being attributed to live work.
// Matches STALE_RUNNING_ISSUE_LOCK_MS in recovery/service.ts, which is the point
// the stale-lock sweeper itself stops believing the holder — kept as a local
// constant rather than an import to avoid coupling the detector to the recovery
// service's module graph.
const NON_LIVE_EXECUTION_SILENCE_MS = 2 * 60 * 60 * 1000;
// BLO-23248/BLO-22331/BLO-19604/BLO-23624: three distinct mechanisms all
// produce the same null hypothesis — "the assignee was never given an
// executable turn" — which BLO-23248 originally tracked under a single
// capacity-only bucket. Widened here (BLO-23624) into one `noExecutableTurn`
// classification so the dominance test below sees the union, not just
// whichever mechanism happened to be active when it was first diagnosed:
//   - capacity park: a capacity-class `scheduled_retry` — the fleet's
//     ccrotate/penstock model-provider pool is exhausted, not a per-run
//     hiccup. Mirrors CCROTATE_CAPACITY_RETRY_REASON in heartbeat.ts,
//     duplicated locally (not imported) because heartbeat.ts imports
//     productivityReviewService from this module; importing back would be
//     circular. scheduledRetryReason is the primary signal; errorCode is a
//     fallback for rows written before the reason was recorded on this path.
//   - dispatch backlog (BLO-19604): a run that never reached `startedAt`,
//     whether it is still sitting `queued` or was already `cancelled` out
//     from under it (e.g. the BLO-21621 sweep's
//     `queued_run_detached_from_issue`) — the assignee never got a turn on
//     it either way.
//   - zero-token adapter throttle: a terminal run whose liveness came back
//     `failed` after burning zero input/output tokens — reuses
//     `isNeverExecutedRun`, the same signature `runtime_failure_streak` keys
//     on for the identical reason (BLO-21769).
const CAPACITY_RETRY_REASON = "ccrotate_capacity";
const CAPACITY_RETRY_ERROR_CODE = "rate_limit_exhausted";
// Share of the active episode that must be no-executable-turn time before
// `long_active_duration` treats the episode as a fleet/dispatch artifact
// rather than assignee inactivity (BLO-23248 AC2, widened by BLO-23624).
// Chosen so a brand-new park/backlog/throttle streak (which is nearly all of
// a fresh episode) always suppresses, while an episode that was already long
// *before* it started still fires on its own unattended time.
const NO_EXECUTABLE_TURN_DOMINANT_SHARE = 0.5;
// BLO-26165: `heartbeatRuns.issueCommentStatus` defaults to (and is explicitly
// re-stamped) `not_applicable` by `finalizeIssueCommentPolicy` (heartbeat.ts).
// It is NOT an invocation signal and must never be used as one — see
// `isNeverInvokedRun` for the predicate that is, and the narrowing note there
// for why keying the streak on this column produced a fleet-wide false
// negative. Retained only to report the comment-policy-exempt population as
// its own accurately-named bucket, which stays IN the streak numerator.
const COMMENT_POLICY_EXEMPT_ISSUE_COMMENT_STATUS = "not_applicable";
export const PRODUCTIVITY_REVIEW_REFRESH_COMMENT_PREFIX = "Productivity review evidence refreshed.";
const PRODUCTIVITY_REVIEW_CREATED_ACTION = "issue.productivity_review_created";
const PRODUCTIVITY_REVIEW_ASSIGNMENT_WAKE_STARTED_ACTION =
  "issue.productivity_review_assignment_wake_started";
const PRODUCTIVITY_REVIEW_ASSIGNMENT_WAKE_FAILED_ACTION =
  "issue.productivity_review_assignment_wake_failed";
const PRODUCTIVITY_REVIEW_ASSIGNMENT_WAKE_ENQUEUED_ACTION =
  "issue.productivity_review_assignment_wake_enqueued";
const PRODUCTIVITY_REVIEW_ASSIGNMENT_WAKE_CLAIM_LEASE_MS = 5 * 60 * 1000;
const PRODUCTIVITY_REVIEW_DURABLE_WAKE_REQUEST_STATUSES = [
  "queued",
  "claimed",
  "coalesced",
  "deferred_issue_execution",
  "completed",
] as const;
// BLO-3281 AC2 hard floor: even if the detector scan cadence is faster
// than this, the refresh-evidence-comment path stays throttled at 5 min.
// Defends against the 2026-05-05 incident on BLO-3277 (14 refreshes in
// 6 minutes, ~30s apart) regardless of scheduler config.
export const PRODUCTIVITY_REVIEW_MIN_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
// Marker set on heartbeat-run contextSnapshot.source by routine dispatches; see
// queueIssueAssignmentWakeup callers in routines.ts (`contextSource: "routine.dispatch"`).
const ROUTINE_DISPATCH_CONTEXT_SOURCE = "routine.dispatch";
// Back-compat export for existing tests/imports. New logic reads the threshold
// value so the worker can derive it from scheduler cadence and dispatch TTL.
export const MONITOR_LAPSE_SERVICE_GRACE_MS = DEFAULT_PRODUCTIVITY_REVIEW_MONITOR_LAPSE_SERVICE_GRACE_MS;

type IssueRow = typeof issues.$inferSelect;
type AgentRow = typeof agents.$inferSelect;
type HeartbeatRunRow = typeof heartbeatRuns.$inferSelect;
type ProductivityReviewTrigger =
  | "no_comment_streak"
  | "long_active_duration"
  | "high_churn"
  | "runtime_failure_streak";

type ProductivityReviewThresholds = {
  noCommentStreakRuns: number;
  longActiveMs: number;
  approvalGateMaxAgeMs: number;
  highChurnHourly: number;
  highChurnSixHours: number;
  resolvedSnoozeMs: number;
  escalationThreshold: number;
  escalationLookbackMs: number;
  refreshIntervalMs: number;
  maxRefreshComments: number;
  creationWindowMs: number;
  maxCreationsPerWindow: number;
  maxConsecutiveNoActionReviews: number;
  monitorLapseServiceGraceMs: number;
  monitorSchedulerIntervalMs: number;
  monitorDispatchBatchSize: number;
};

// BLO-23624: the three run-level mechanisms that all mean "the assignee was
// never given an executable turn" — see the constants block above for the
// per-mechanism detail.
type NoExecutableTurnMechanism = "capacity_park" | "dispatch_backlog" | "zero_token_throttle";

type NoExecutableTurnGating = {
  noExecutableTurnMs: number;
  mechanismMs: Record<NoExecutableTurnMechanism, number>;
  // The run heading the episode as of `now` (chronologically last in
  // `latestRuns`), and its classification — null when that run does not
  // itself classify as no-executable-turn, even if earlier runs in the
  // episode did.
  currentRunId: string | null;
  currentMechanism: NoExecutableTurnMechanism | null;
  scheduledRetryAt: Date | null;
  retryReason: string | null;
  errorCode: string | null;
  // Only meaningful when currentMechanism is "capacity_park": whether that
  // retry's own due time has already passed.
  overdue: boolean;
  // Whether the current run's block is still open — i.e. still actually
  // blocking the assignee right now, not just a historical contributor to
  // the dominance share. See `noExecutableTurnBreakdown` for the per-
  // mechanism definition of "open".
  currentBlockOpen: boolean;
};

type PullRequestEvidence = {
  title: string;
  url: string | null;
  status: string;
  externalId: string | null;
  /** GitHub event time of the newest PR event (not DB receipt time). */
  updatedAt: Date;
  /** Age of the newest PR event at evidence-collection time. */
  ageMs: number;
};

const PRODUCTIVITY_REVIEW_PROGRESS_PR_STATUS_VALUES = ["ready_for_review", "draft", "merged"] as const;
const PRODUCTIVITY_REVIEW_PROGRESS_PR_STATUSES = new Set<string>(PRODUCTIVITY_REVIEW_PROGRESS_PR_STATUS_VALUES);
const PRODUCTIVITY_REVIEW_WEBHOOK_PR_METADATA_SOURCE = PULL_REQUEST_WORK_PRODUCT_METADATA_SOURCE;

/**
 * Effective chronology for a PR work product: the GitHub event time the row was
 * built from, falling back to DB receipt time only when the row predates that
 * field. Used for both "which PR is newest" and "how old is it" so a delayed
 * delivery cannot present a stale PR as fresh (BLO-19566).
 */
const pullRequestEffectiveEventAtSql = sql`coalesce(
  case
    when ${issueWorkProducts.metadata}->>'sourceEventTimestampMs' ~ '^[0-9]+$'
      then to_timestamp((${issueWorkProducts.metadata}->>'sourceEventTimestampMs')::bigint / 1000.0)
    else null
  end,
  ${issueWorkProducts.updatedAt}
)`;

type PullRequestEvidenceRow = {
  title: string;
  url: string | null;
  status: string;
  externalId: string | null;
  updatedAt: Date;
  sourceEventTimestampMs: string | number | null;
};

type ProductivityReviewEvidence = {
  trigger: ProductivityReviewTrigger;
  // BLO-22436 (Ally follow-up on 37c1bd65): every trigger whose predicate fired
  // this pass, in `choosePrimaryTrigger`'s ladder order — `trigger` is only the
  // head of this list. Any gate that decides whether an *external* condition
  // excuses the review must consult the whole set: `choosePrimaryTrigger` is a
  // priority ladder, not a classification, so a single dispositive-looking
  // primary can be hiding a co-fired trigger the same condition does not excuse
  // at all. The concrete case is a blocked source that is both silent and
  // churning: `no_comment_streak` wins the ladder and is dependency-closable,
  // but the `high_churn` evidence underneath it records runs that did execute
  // and did burn cost, which no blocker retroactively excuses.
  firedTriggers: ProductivityReviewTrigger[];
  triggerReasons: string[];
  sourceIssue: IssueRow;
  sourceAgent: AgentRow;
  noCommentStreak: number;
  runtimeFailureStreak: number;
  // BLO-22097: whether the runtime-failure streak's "no model turn" evidence
  // is a *measured* zero-token usage blob, an *inferred* call (null usage,
  // corroborated only by low/missing log volume), or a mix — see
  // `isInfraFailureRun`. Evidence text must not claim "0 input/output
  // tokens" for a run where usage was never recorded at all.
  runtimeFailureUsageBasis: "measured" | "inferred" | "mixed" | null;
  // BLO-26165: count of terminal runs excluded from the `noCommentStreak` walk
  // because no adapter container was ever created for them (`isNeverInvokedRun`
  // — `usageJson`, `logStore`, `logRef` all null and `logBytes` null-or-zero).
  // These runs had nothing capable of writing a comment. Distinct from
  // `runtimeFailureStreak`, whose `livenessState`/usage heuristic cannot see a
  // pre-adapter setup failure because classification never ran, so the evidence
  // block can tell a reviewer "this many runs never had a chance to comment"
  // apart from "this many runs executed and stayed silent."
  neverInvokedRunCount: number;
  // BLO-26165 (narrowing): of the runs eligible for the `noCommentStreak` walk,
  // how many carry `issueCommentStatus: "not_applicable"` —
  // `finalizeIssueCommentPolicy` exempted them from the comment requirement
  // (wake reason outside the four-reason whitelist, or a deferred comment wake
  // was already pending). Reported, NOT excluded: a run that executed and
  // stayed silent is assignee silence whether or not policy demanded a comment.
  // Named separately so the evidence block never labels an invoked run "never
  // invoked".
  commentExemptExecutedRunCount: number;
  // BLO-22436: runs in the sample window that could not possibly have
  // produced a comment (infra failure or dependency-gate cancellation),
  // reported separately from the streaks so a review body never has to be
  // re-derived from raw run telemetry.
  nonExecutingRunCount: number;
  // Null when no single `errorCode` holds a strict majority of the
  // non-executing runs — the window has no one explanation, and naming a
  // plurality winner would read as a diagnosis.
  nonExecutingDominantErrorCode: { code: string | null; count: number } | null;
  // BLO-22436 (Ally follow-up): how many of `nonExecutingRunCount` are ALSO
  // in `neverInvokedRunCount`. The two counts are computed from independent
  // predicates (errorCode/liveness vs. run telemetry) and are not defined to be
  // disjoint, so the overlap is measured rather than assumed. Without this,
  // rendering both counts side by side double-counts every run that satisfies
  // both for a reader summing the evidence block.
  nonExecutingAlsoNeverInvokedCount: number;
  totalRunCount: number;
  terminalRunCount: number;
  activeRunCount: number;
  runCountLastHour: number;
  runCountLastSixHours: number;
  commentCount: number;
  commentCountLastHour: number;
  commentCountLastSixHours: number;
  elapsedMs: number | null;
  // BLO-19848: wall-clock excluded from elapsedMs because the issue's
  // executionRunId was pinned by a run that was not live. 0 when the holder is
  // live or absent.
  nonLiveHoldMs: number;
  monitorGating: {
    gatedMs: number;
    unattendedMs: number;
    lapsedAt: Date | null;
    priorLapseAt: Date | null;
    armedUntil: Date | null;
    gatedIsUpperBound: boolean;
    // BLO-25877: set (to the same instant as `lapsedAt`) only when the row's
    // *current* `monitorNextCheckAt` is null at `lapsedAt` — i.e. the monitor's
    // last transition was a fire, not an abandoned schedule. Distinguishes
    // "did its job, nothing has re-armed it since" from a genuinely stuck
    // monitor so `formatMonitorGating` doesn't blame the wrong thing.
    firedAt: Date | null;
    successorRunId: string | null;
  } | null;
  // BLO-23248/BLO-23624: elapsed time attributable to a no-executable-turn
  // run — the union of capacity park, dispatch backlog, and zero-token
  // throttle (see the constants above) — a third bucket distinct from
  // monitor-gated and unattended time. null when no run in the episode
  // classifies as one of those three mechanisms.
  noExecutableTurnGating: NoExecutableTurnGating | null;
  latestRuns: HeartbeatRunRow[];
  latestComments: Array<typeof issueComments.$inferSelect>;
  costCents: number;
  usageSamples: Array<{ runId: string; usageJson: Record<string, unknown> | null }>;
  nextAction: string | null;
  /**
   * Newest `pull_request` work product on the source issue, or null when the
   * issue carries none (BLO-19566 AC4). The reviewer's verdict criteria ask for
   * "a non-stale PR/MR link in the source issue's evidence"; before this the
   * evidence pack had no PR field at all, so an assignee pushing commits to an
   * open PR was indistinguishable from one doing nothing.
   */
  latestPullRequest: PullRequestEvidence | null;
  queuedUndispatchedRunCount: number;
  oldestQueuedUndispatchedRunAgeMs: number | null;
  thresholds: ProductivityReviewThresholds;
  generatedAt: Date;
  routineOnlySamplingWindow: boolean;
};

type ProductivityReviewFinishEvidence = Pick<
  ProductivityReviewEvidence,
  | "sourceIssue"
  | "generatedAt"
  | "trigger"
  | "firedTriggers"
  | "noCommentStreak"
  | "runCountLastHour"
  | "commentCountLastHour"
>;

type MonitorScheduledSuppression = {
  trigger: "long_active_duration";
  firedTriggers: ProductivityReviewTrigger[];
  triggerReasons: string[];
  sourceIssue: IssueRow;
  sourceAgent: AgentRow;
  elapsedMs: number | null;
  // BLO-25877: null in the just-fired branch — firing clears `monitorNextCheckAt`
  // atomically with `monitorLastTriggeredAt` (buildIssueMonitorTriggeredPatch), so a
  // suppression raised on that branch has no future check to report. See
  // `monitorLastTriggeredAt` below for the timestamp that branch does carry.
  monitorNextCheckAt: Date | null;
  monitorScheduledBy: string;
  monitorWakeRequestedAt: Date | null;
  monitorLastTriggeredAt: Date | null;
  thresholds: ProductivityReviewThresholds;
  generatedAt: Date;
};

type PendingMonitorForReviewSuppression = {
  monitorNextCheckAt: Date | null;
  monitorScheduledBy: string;
  monitorWakeRequestedAt: Date | null;
  monitorLastTriggeredAt: Date | null;
};

type ApprovalGatedSuppression = {
  trigger: "long_active_duration";
  firedTriggers: ProductivityReviewTrigger[];
  triggerReasons: string[];
  sourceIssue: IssueRow;
  sourceAgent: AgentRow;
  elapsedMs: number | null;
  approvalGate: { approvalId: string; approvalStatus: string; approvalType: string };
  thresholds: ProductivityReviewThresholds;
  generatedAt: Date;
};

type EnqueueWakeup = (
  agentId: string,
  opts?: {
    source?: "timer" | "assignment" | "on_demand" | "automation";
    triggerDetail?: "manual" | "ping" | "callback" | "system";
    reason?: string | null;
    payload?: Record<string, unknown> | null;
    idempotencyKey?: string | null;
    requestedByActorType?: "user" | "agent" | "system";
    requestedByActorId?: string | null;
    contextSnapshot?: Record<string, unknown>;
  },
) => Promise<unknown | null>;

const MONITOR_SCHEDULED_SUPPRESSION_ACTORS = new Set(["assignee", "board"]);

// A linked approval in one of these statuses means the issue's next move belongs to a human.
// Deliberately `pending` only: `revision_requested` hands the ball back to the *agent*, so a
// long-active review there is legitimate and should still fire.
const APPROVAL_GATE_SUPPRESSION_STATUSES = ["pending"] as const;

type ProductivityReviewServiceDeps = {
  beforeCollectEvidence?: (sourceIssue: IssueRow) => Promise<void> | void;
  beforeMonitorBacklogGrace?: (sourceIssue: IssueRow) => Promise<void> | void;
  enqueueWakeup?: EnqueueWakeup;
  beforeCreateOrUpdateReview?: (evidence: ProductivityReviewEvidence) => Promise<void> | void;
  beforeCreateReviewIssueInsert?: (evidence: ProductivityReviewEvidence) => Promise<void> | void;
  beforeFinalMonitorSuppressionRevalidation?: (evidence: ProductivityReviewEvidence) => Promise<void> | void;
  afterFinalMonitorReviewReservation?: (evidence: ProductivityReviewEvidence, review: IssueRow) => Promise<void> | void;
  beforeStaleReservationRecoveryFinalize?: (review: IssueRow, sourceIssue: IssueRow) => Promise<void> | void;
  afterStaleReservationRecoveryFinalize?: (
    review: IssueRow,
    sourceIssue: IssueRow,
    finalized: boolean,
  ) => Promise<void> | void;
};

class MonitorSuppressedBeforeCreateError extends Error {
  constructor(readonly monitor: PendingMonitorForReviewSuppression) {
    super("productivity review source monitor became pending before issue insert");
  }
}

function productivityReviewFingerprint(sourceIssueId: string) {
  return `productivity-review:${sourceIssueId}`;
}

function productivityReviewAssignmentWakeIdempotencyKey(reviewIssueId: string) {
  return `productivity-review-created:${reviewIssueId}`;
}

function productivityReviewEscalationFingerprint(sourceIssueId: string) {
  return `productivity-review-escalation:${sourceIssueId}`;
}

function issueRunScopeSql(issueId: string) {
  return or(
    eq(heartbeatRuns.contextIssueId, issueId),
    eq(heartbeatRuns.contextTaskId, issueId),
    eq(heartbeatRuns.contextTaskKey, issueId),
  );
}

function msToHuman(ms: number | null) {
  if (ms === null) return "unknown";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ${hours % 24}h`;
  return `${hours}h ${minutes % 60}m`;
}

// BLO-21003 AC3: `msToHuman` floors anything under 60s to `0m`, which reads as
// "measured and zero" rather than "sub-minute and unmeasured at this
// resolution". A caller reporting a genuinely nonzero sub-minute duration (e.g.
// `monitorGatingBreakdown`'s `unattendedMs`) should say so with a real unit
// instead. Zero itself is left as `0m` — that value is accurate, not floored.
function msToHumanFine(ms: number | null) {
  if (ms === null) return "unknown";
  if (ms > 0 && ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  return msToHuman(ms);
}

function issueUiLink(issue: { identifier: string | null; id: string }, prefix: string) {
  const label = issue.identifier ?? issue.id;
  return `[${label}](/${prefix}/issues/${label})`;
}

function runUiLink(run: { id: string; agentId: string }, prefix: string) {
  return `[${run.id}](/${prefix}/agents/${run.agentId}/runs/${run.id})`;
}

function truncateInline(value: string | null | undefined, max = 260) {
  if (!value) return "";
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= max ? compact : `${compact.slice(0, max - 3)}...`;
}

function readPositiveInteger(value: number, fallback: number) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function isActiveProductivityReviewUniqueConflict(error: unknown) {
  let current: unknown = error;
  while (current && typeof current === "object") {
    const maybe = current as { code?: string; constraint?: string; message?: string; cause?: unknown };
    if (
      maybe.code === "23505" &&
      (maybe.constraint === "issues_active_productivity_review_uq" ||
        typeof maybe.message === "string" && maybe.message.includes("issues_active_productivity_review_uq"))
    ) {
      return true;
    }
    if (!maybe.cause || maybe.cause === current) return false;
    current = maybe.cause;
  }
  return false;
}

function coerceDate(value: Date | string | null | undefined) {
  if (!value) return null;
  return value instanceof Date ? value : new Date(value);
}

function latestDate(...values: Array<Date | string | null | undefined>) {
  const dates = values
    .map(coerceDate)
    .filter((value): value is Date => !!value && !Number.isNaN(value.getTime()));
  if (dates.length === 0) return null;
  return new Date(Math.max(...dates.map((date) => date.getTime())));
}

/**
 * BLO-19848: the moment an issue's execution stopped being attributable to a
 * live run, or null while the current holder is genuinely live.
 *
 * `long_active_duration` measures wall-clock from `issues.started_at` to `now`
 * with no reference to whether anything is actually executing. That is correct
 * while a run is working and wrong the instant the holding run stops: an issue
 * whose `executionRunId` is pinned by a non-live run keeps accruing "active"
 * time indefinitely, so the detector reports an episode that ended days ago and
 * files a review against an assignee who cannot even transition the issue (the
 * same wedge produces `409 Issue run ownership conflict`). BLO-18307 accrued a
 * reported "1d 7h active episode" behind a `scheduled_retry` holder whose fix
 * had already merged; BLO-12565 and BLO-12696 are the same shape.
 *
 * Liveness here is deliberately stricter than `ACTIVE_RUN_STATUSES`. `queued`
 * and `scheduled_retry` are non-terminal but are, by definition, not executing —
 * counting their elapsed time is exactly the bug. A `running` holder counts as
 * live until it goes silent past NON_LIVE_EXECUTION_SILENCE_MS, measured on the
 * run's own activity columns (the same basis the stale-lock sweeper and the
 * dispatcher's slot gate use) rather than on `updatedAt`, which review and
 * recovery churn would otherwise keep fresh forever (BLO-8827).
 *
 * Returns the clamp point — the last moment still attributable to the run — so
 * the episode is truncated when live work stopped rather than dropped to zero.
 * An issue with no execution holder at all returns null and keeps full
 * wall-clock accounting: that is an unowned `in_progress` issue, which is
 * genuine stalling and exactly what the trigger should still catch.
 */
function nonLiveExecutionHoldSince(
  issue: IssueRow,
  executionRun: HeartbeatRunRow | null,
  now: Date,
): Date | null {
  if (!issue.executionRunId) return null;
  // Pointer to a run row we cannot see: treat the lock timestamp as the last
  // attributable moment rather than trusting an unverifiable holder.
  if (!executionRun) return coerceDate(issue.executionLockedAt);

  const lastSignal = latestDate(
    executionRun.lastUsefulActionAt,
    executionRun.lastOutputAt,
    executionRun.startedAt,
    issue.executionLockedAt,
  );

  if (executionRun.status === "running") {
    if (!lastSignal) return null; // mid-claim; do not truncate on a bare row
    return now.getTime() - lastSignal.getTime() >= NON_LIVE_EXECUTION_SILENCE_MS
      ? new Date(lastSignal.getTime() + NON_LIVE_EXECUTION_SILENCE_MS)
      : null;
  }

  if (TERMINAL_RUN_STATUSES.includes(executionRun.status as (typeof TERMINAL_RUN_STATUSES)[number])) {
    return coerceDate(executionRun.finishedAt) ?? lastSignal;
  }

  // queued / scheduled_retry: parked, not executing.
  return lastSignal;
}

/**
 * BLO-19848 (review follow-up): the moment the current live execution segment
 * began, when the holding run reached `running` by way of a park — or null when
 * there is no park to exclude.
 *
 * `nonLiveExecutionHoldSince` only truncates the *tail* of an episode, so it
 * stops helping the instant a parked holder resumes: the run is genuinely live
 * again, the clamp goes away, and the entire parked interval is re-attributed to
 * active work because elapsed is still measured from `issues.started_at`. That
 * is the reported failure — a 6h50m park plus a 10m run still totals 7h and
 * still trips `long_active_duration`, which is the same false positive this
 * issue exists to remove, just reached by a different path.
 *
 * A promoted retry keeps its park on the row: promoteDueScheduledRetry flips
 * `scheduled_retry` to `queued` writing only status/error/updatedAt
 * (heartbeat.ts), and the subsequent claim preserves `startedAt`
 * (`run.startedAt ?? claimedAt`). So `scheduledRetryAt` survives promotion as a
 * durable record of when the park ended, and `startedAt` still points at the
 * original, pre-park start. A `running` row carrying a past `scheduledRetryAt`
 * therefore could not have been executing before that timestamp.
 *
 * Only consulted for `running` holders. While a run is still parked its
 * `scheduledRetryAt` is the *future* due time, which says nothing about a live
 * segment — that case is already handled by the tail clamp.
 *
 * This deliberately measures the current segment rather than summing every live
 * segment across a multi-park episode: the row keeps only the most recent park
 * boundary, so earlier live attempts are dropped. That under-counts, which is
 * the safe direction for a trigger whose failure mode is firing on work that is
 * not actually running; a genuinely long-running segment still fires, and the
 * evidence block reports the excluded total alongside it.
 */
function liveSegmentStartedAt(executionRun: HeartbeatRunRow | null, now: Date): Date | null {
  if (!executionRun || executionRun.status !== "running") return null;
  const parkEndedAt = coerceDate(executionRun.scheduledRetryAt);
  if (!parkEndedAt || Number.isNaN(parkEndedAt.getTime())) return null;
  // A future deadline on a `running` row is contradictory; ignore rather than
  // clamping the episode start into the future.
  if (parkEndedAt.getTime() > now.getTime()) return null;
  return parkEndedAt;
}

/**
 * BLO-23624: classifies a single run against the union null hypothesis "the
 * assignee was never given an executable turn on this run" — the broader
 * condition BLO-23248/BLO-22331's capacity-only bucket was defending without
 * naming (see the constants block above for the three mechanisms). Returns
 * null for a run that represents genuine, assignee-attributable turn time.
 */
function classifyNoExecutableTurnRun(
  run: HeartbeatRunRow,
): { mechanism: NoExecutableTurnMechanism; scheduledRetryAt: Date | null; retryReason: string | null; errorCode: string | null } | null {
  if (run.status === "scheduled_retry") {
    const isCapacityClass =
      run.scheduledRetryReason === CAPACITY_RETRY_REASON || run.errorCode === CAPACITY_RETRY_ERROR_CODE;
    if (!isCapacityClass) return null;
    const scheduledRetryAt = coerceDate(run.scheduledRetryAt);
    if (!scheduledRetryAt) return null;
    return {
      mechanism: "capacity_park",
      scheduledRetryAt,
      retryReason: run.scheduledRetryReason,
      errorCode: run.errorCode,
    };
  }
  // BLO-19604/BLO-22016: a run that never reached `startedAt` never gave the
  // assignee a turn, whatever became of it afterward — still parked in the
  // dispatch queue, or already cancelled out from under it (e.g. the
  // BLO-21621 sweep's `queued_run_detached_from_issue`).
  if (!run.startedAt && (run.status === "queued" || run.status === "cancelled")) {
    return { mechanism: "dispatch_backlog", scheduledRetryAt: null, retryReason: null, errorCode: run.errorCode };
  }
  if (isNeverExecutedRun(run)) {
    return { mechanism: "zero_token_throttle", scheduledRetryAt: null, retryReason: null, errorCode: run.errorCode };
  }
  return null;
}

/**
 * BLO-23248/BLO-22331/BLO-23624: sums the portion of
 * `[attributableStartAt, attributableEndAt)` attributable to a
 * no-executable-turn run, walking `latestRuns` in chronological order and
 * attributing each inter-run interval to whichever run was "current" (most
 * recently created) during that interval — the same run that would have been
 * `latestRuns[0]` had the evaluation happened at that moment. This is
 * independent of `issue.executionRunId`, which reads null for the entire
 * time a run sits parked in `scheduled_retry`
 * (`scheduleBoundedRetryForRun` clears it the moment it inserts the retry
 * row — heartbeat.ts) or never-dispatched-queued — root cause of BLO-22331.
 * `latestRuns` arrives ordered `desc(createdAt), desc(id)` (see the query in
 * `collectEvidence`), so it is reversed here.
 *
 * `overdue`/`currentBlockOpen` preserve BLO-22331's non-indefinite-
 * suppression guard: a capacity `scheduled_retry` past its own
 * `scheduledRetryAt` is a broken promise the system made and failed to keep,
 * so suppression lifts and the stall becomes visible again. The other two
 * mechanisms have no comparable due time — a `queued` dispatch-backlog run is
 * "open" only while it is genuinely still `queued` (the BLO-21621 sweep is
 * what bounds that, not this detector), and a terminal dispatch-backlog or
 * zero-token run occupies a fixed, already-closed window that cannot itself
 * justify suppressing a *later*, otherwise-uncovered stall.
 */
function noExecutableTurnBreakdown(
  latestRuns: HeartbeatRunRow[],
  attributableStartAt: Date,
  attributableEndAt: Date,
  now: Date,
): NoExecutableTurnGating | null {
  if (attributableEndAt.getTime() <= attributableStartAt.getTime()) return null;
  // `latestRuns` arrives ordered `desc(createdAt), desc(id)`; reversing that
  // ordering requires the same two-key sort, ascending. `createdAt` alone
  // ties on a same-millisecond insert (the exact flake #1188 hit — see
  // `c4aa1d1`), and a JS stable sort on a tied key preserves descending-id
  // input order, which is the *opposite* of what `.at(-1)` needs to recover
  // `latestRuns[0]`. Without the `id` tie-break, a tie silently picks the
  // wrong run as "current" and can flip `currentBlockOpen`.
  const chronological = [...latestRuns].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );

  const mechanismMs: Record<NoExecutableTurnMechanism, number> = {
    capacity_park: 0,
    dispatch_backlog: 0,
    zero_token_throttle: 0,
  };
  let noExecutableTurnMs = 0;

  for (let i = 0; i < chronological.length; i += 1) {
    const run = chronological[i]!;
    const classification = classifyNoExecutableTurnRun(run);
    if (!classification) continue;
    const segmentStart = latestDate(run.createdAt, attributableStartAt) ?? attributableStartAt;
    const next = chronological[i + 1];
    const segmentEndCandidate = next ? next.createdAt : attributableEndAt;
    let segmentEnd = segmentEndCandidate.getTime() < attributableEndAt.getTime()
      ? segmentEndCandidate
      : attributableEndAt;
    // A terminal no-executable-turn run (a `cancelled` dispatch-backlog run,
    // or a zero-token `failed` run) stopped mattering the moment it
    // finished — attributing the gap up to whenever the *next* run happened
    // to be created would let a run that died in 60s swallow a 10h gap
    // before its retry. Open states (`scheduled_retry` still pending its own
    // due time, or a dispatch-backlog run still genuinely `queued`) have no
    // `finishedAt` yet and legitimately park through to the next run.
    const isTerminalNoTurnRun =
      classification.mechanism === "zero_token_throttle" ||
      (classification.mechanism === "dispatch_backlog" && run.status === "cancelled");
    if (isTerminalNoTurnRun) {
      const finishedAt = coerceDate(run.finishedAt);
      if (finishedAt && finishedAt.getTime() < segmentEnd.getTime()) {
        segmentEnd = finishedAt.getTime() > segmentStart.getTime() ? finishedAt : segmentStart;
      }
    }
    const segmentMs = segmentEnd.getTime() - segmentStart.getTime();
    if (segmentMs <= 0) continue;
    mechanismMs[classification.mechanism] += segmentMs;
    noExecutableTurnMs += segmentMs;
  }

  if (noExecutableTurnMs === 0) return null;

  const currentRun = chronological.at(-1) ?? null;
  const currentClassification = currentRun ? classifyNoExecutableTurnRun(currentRun) : null;
  const currentIsActiveStatus = Boolean(
    currentRun && ACTIVE_RUN_STATUSES.includes(currentRun.status as (typeof ACTIVE_RUN_STATUSES)[number]),
  );
  const overdue = Boolean(
    currentClassification?.mechanism === "capacity_park"
      && currentClassification.scheduledRetryAt
      && currentClassification.scheduledRetryAt.getTime() <= now.getTime(),
  );
  const currentBlockOpen = Boolean(currentClassification) && currentIsActiveStatus && !overdue;

  return {
    noExecutableTurnMs,
    mechanismMs,
    currentRunId: currentClassification ? currentRun!.id : null,
    currentMechanism: currentClassification?.mechanism ?? null,
    scheduledRetryAt: currentClassification?.scheduledRetryAt ?? null,
    retryReason: currentClassification?.retryReason ?? null,
    errorCode: currentClassification?.errorCode ?? null,
    overdue,
    currentBlockOpen,
  };
}

function isTerminalIssueStatus(status: string | null | undefined) {
  return status === "done" || status === "cancelled";
}

function isMonitorSuppressionActor(value: string | null | undefined): value is string {
  return Boolean(value && MONITOR_SCHEDULED_SUPPRESSION_ACTORS.has(value));
}

function strictFutureMonitor(issue: IssueRow, now: Date) {
  const monitorNextCheckAt = coerceDate(issue.monitorNextCheckAt);
  const monitorScheduledBy = issue.monitorScheduledBy;
  if (!monitorNextCheckAt || monitorNextCheckAt.getTime() <= now.getTime()) return null;
  if (!isMonitorSuppressionActor(monitorScheduledBy)) return null;
  return { monitorNextCheckAt, monitorScheduledBy };
}

function monitorHasFreshWakeClaim(issue: IssueRow, now: Date) {
  const monitorWakeRequestedAt = coerceDate(issue.monitorWakeRequestedAt);
  if (!monitorWakeRequestedAt) return null;
  return monitorWakeRequestedAt.getTime() >= now.getTime() - ISSUE_MONITOR_WAKE_CLAIM_TTL_MS
    ? monitorWakeRequestedAt
    : null;
}

function issueCanReceiveMonitorDispatch(issue: IssueRow) {
  return Boolean(
    !issue.assigneeUserId &&
      issue.assigneeAgentId &&
      ["in_progress", "in_review"].includes(issue.status),
  );
}

function deliberatePendingMonitor(
  issue: IssueRow,
  now: Date,
  thresholds: ProductivityReviewThresholds,
  backlogGraceMs = 0,
): PendingMonitorForReviewSuppression | null {
  const future = strictFutureMonitor(issue, now);
  if (future) return { ...future, monitorWakeRequestedAt: null, monitorLastTriggeredAt: null };

  const monitorScheduledBy = issue.monitorScheduledBy;
  const effectiveGraceMs = Math.max(thresholds.monitorLapseServiceGraceMs, backlogGraceMs);
  const monitorNextCheckAt = coerceDate(issue.monitorNextCheckAt);

  if (!monitorNextCheckAt) {
    // BLO-25877: firing clears `monitorNextCheckAt` atomically with
    // `monitorLastTriggeredAt` (buildIssueMonitorTriggeredPatch). A caller here
    // reads its own fresh copy of the issue (`getCurrentIssue`), taken *after*
    // this evidence pass's issue snapshot — a monitor that fires in that gap
    // reads as "nothing pending" on the first guard below even though the fire
    // itself, by construction, enqueued a successor run: the strongest
    // available evidence the issue is attended. Cover that just-fired window on
    // the same grace footing as a lapsed-but-unserviced monitor below, and
    // symmetric with `monitorHasFreshWakeClaim`'s claimed-but-not-yet-dispatched
    // window. This is a tolerate-the-transition fix, not a snapshot-consistent
    // read: it does not make the evidence read and this read atomic, it makes
    // "fired since the evidence read" its own recognized state instead of an
    // absence.
    const monitorLastTriggeredAt = coerceDate(issue.monitorLastTriggeredAt);
    if (
      monitorLastTriggeredAt &&
      isMonitorSuppressionActor(monitorScheduledBy) &&
      now.getTime() - monitorLastTriggeredAt.getTime() <= effectiveGraceMs
    ) {
      return {
        monitorNextCheckAt: null,
        monitorScheduledBy,
        monitorWakeRequestedAt: null,
        monitorLastTriggeredAt,
      };
    }
    return null;
  }
  if (!isMonitorSuppressionActor(monitorScheduledBy)) return null;

  // BLO-21003: `monitorNextCheckAt` lapsing is not proof its wake has been
  // serviced. For new-review suppression, keep treating it as pending while
  // either (a) the scheduler-derived grace has not elapsed, or (b) the monitor
  // dispatcher has a fresh durable claim (`monitorWakeRequestedAt`). The close
  // path intentionally does not use this helper because resolving an already
  // open review would start the resolved-review snooze before dispatch succeeds.
  const dueAgeMs = now.getTime() - monitorNextCheckAt.getTime();
  const monitorWakeRequestedAt = monitorHasFreshWakeClaim(issue, now);
  if (dueAgeMs > effectiveGraceMs && !monitorWakeRequestedAt) return null;
  return { monitorNextCheckAt, monitorScheduledBy, monitorWakeRequestedAt, monitorLastTriggeredAt: null };
}

/**
 * Splits an active episode into the portion an armed monitor was accounting for
 * and the portion nobody was watching, so a manager adjudicating a
 * `long_active_duration` review can tell a deliberate monitor-gated wait from an
 * unattended stall without cross-checking the source issue.
 *
 * Derived from the server-owned monitor columns rather than a full monitor
 * history, so `gatedMs` is an upper bound: re-arm gaps inside the covered span
 * are counted as gated. Where that bound is the whole episode — a monitor still
 * armed, whose arm time no column records — the result sets
 * `gatedIsUpperBound` so the manager-facing line carries the qualifier too.
 * This is reporting only — it does not gate whether the review fires.
 */
function monitorGatingBreakdown(
  issue: IssueRow,
  activeStartedAt: Date | null,
  elapsedMs: number | null,
  now: Date,
  latestRuns: HeartbeatRunRow[],
) {
  if (elapsedMs === null || !activeStartedAt) return null;
  const armedUntil = coerceDate(issue.monitorNextCheckAt);
  const lastTriggeredAt = coerceDate(issue.monitorLastTriggeredAt);

  // Still armed for a future check. There is no arm-time column, so a monitor
  // armed seconds ago is indistinguishable from one armed at `activeStartedAt`
  // and the whole episode is attributed to gating — flagged as an upper bound,
  // because reporting it flat would tell a manager that a 15h stall was fully
  // accounted for when only the last 90s provably was.
  if (armedUntil && armedUntil.getTime() > now.getTime()) {
    return {
      gatedMs: elapsedMs,
      unattendedMs: 0,
      lapsedAt: null,
      priorLapseAt: null,
      armedUntil,
      gatedIsUpperBound: true,
      firedAt: null,
      successorRunId: null,
    };
  }

  // A monitor ran at some point and has since lapsed. Coverage ended at the
  // later of its last trigger and its last scheduled check.
  const lapseCandidates = [lastTriggeredAt, armedUntil].filter((d): d is Date => Boolean(d));
  if (lapseCandidates.length === 0) {
    return {
      gatedMs: 0,
      unattendedMs: elapsedMs,
      lapsedAt: null,
      priorLapseAt: null,
      armedUntil: null,
      gatedIsUpperBound: false,
      firedAt: null,
      successorRunId: null,
    };
  }
  const lapsedAt = new Date(Math.max(...lapseCandidates.map((d) => d.getTime())));

  // Coverage that ended before this episode began belongs to a prior episode:
  // none of this episode was gated, and calling it an in-episode lapse would
  // print a timestamp from before `activeStartedAt`.
  if (lapsedAt.getTime() <= activeStartedAt.getTime()) {
    return {
      gatedMs: 0,
      unattendedMs: elapsedMs,
      lapsedAt: null,
      priorLapseAt: lapsedAt,
      armedUntil: null,
      gatedIsUpperBound: false,
      firedAt: null,
      successorRunId: null,
    };
  }

  // BLO-25877: a null `armedUntil` at this point means the row's *current*
  // `monitorNextCheckAt` is null — the monitor's last transition was a fire
  // (which clears it atomically with `monitorLastTriggeredAt`,
  // `buildIssueMonitorTriggeredPatch`), not an abandoned schedule that a
  // non-null, past `armedUntil` would represent. Firing enqueues a successor
  // run by construction, so name it when it's still within the runs sampled
  // for this evidence pass; a null `successorRunId` here just means the run
  // fell outside that sample, not that one doesn't exist.
  const successorRunId = armedUntil === null
    ? (latestRuns
        .filter((run) => run.createdAt.getTime() >= lapsedAt.getTime())
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0]?.id ?? null)
    : null;

  const gatedMs = Math.min(elapsedMs, lapsedAt.getTime() - activeStartedAt.getTime());
  return {
    gatedMs,
    unattendedMs: Math.max(0, elapsedMs - gatedMs),
    lapsedAt,
    priorLapseAt: null,
    armedUntil: null,
    gatedIsUpperBound: false,
    firedAt: armedUntil === null ? lapsedAt : null,
    successorRunId,
  };
}

function formatMonitorGating(gating: NonNullable<ProductivityReviewEvidence["monitorGating"]>) {
  // An upper-bound gated figure implies a lower-bound unattended figure; both
  // carry a qualifier so neither half of the split reads as measured.
  const gated = `${gating.gatedIsUpperBound ? "≤" : ""}${msToHumanFine(gating.gatedMs)} monitor-gated`;
  const unattended = `${gating.gatedIsUpperBound ? "≥" : ""}${msToHumanFine(gating.unattendedMs)} unattended`;
  const split = `${gated}, ${unattended}`;
  if (gating.armedUntil) {
    return `${split} (monitor armed until ${gating.armedUntil.toISOString()}; arm time is not recorded, so monitor-gated time is an upper bound)`;
  }
  // BLO-25877: a monitor that fired at its scheduled check and enqueued a
  // successor demands the opposite reader action from one that silently
  // stopped — do not collapse the two into "never re-armed".
  if (gating.firedAt) {
    const successor = gating.successorRunId ? ` (run \`${gating.successorRunId}\`)` : "";
    return `${split} (monitor fired on schedule at ${gating.firedAt.toISOString()} and enqueued a successor run${successor}; nothing has re-armed it since)`;
  }
  if (gating.lapsedAt) return `${split} (monitor lapsed at ${gating.lapsedAt.toISOString()}, never re-armed)`;
  if (gating.priorLapseAt) {
    return `${split} (no monitor armed during this episode; previous monitor lapsed at ${gating.priorLapseAt.toISOString()}, before it began)`;
  }
  return `${split} (no monitor armed during this episode)`;
}

function isFreshPullRequest(pr: PullRequestEvidence | null): pr is PullRequestEvidence {
  return pr !== null && pr.ageMs <= PRODUCTIVITY_REVIEW_PR_FRESH_MS;
}

function isProgressPullRequest(pr: PullRequestEvidence | null): pr is PullRequestEvidence {
  return isFreshPullRequest(pr) && PRODUCTIVITY_REVIEW_PROGRESS_PR_STATUSES.has(pr.status);
}

function toPullRequestEvidence(row: PullRequestEvidenceRow | null, now: Date): PullRequestEvidence | null {
  if (!row) return null;
  // Prefer the GitHub event time; `updatedAt` is only a fallback for rows
  // written before the source timestamp was recorded.
  const sourceMs = Number(row.sourceEventTimestampMs);
  const eventAt = Number.isFinite(sourceMs) && row.sourceEventTimestampMs !== null
    ? new Date(sourceMs)
    : row.updatedAt;
  return {
    title: row.title,
    url: row.url ?? null,
    status: row.status,
    externalId: row.externalId ?? null,
    updatedAt: eventAt,
    ageMs: Math.max(0, now.getTime() - eventAt.getTime()),
  };
}

/**
 * Render the linked PR for the evidence pack (BLO-19566 AC4). Reads "none
 * recorded" only when the issue genuinely has no PR work product -- which is
 * now a real signal rather than, as before, the only possible output.
 */
function formatPullRequestEvidence(pr: PullRequestEvidence | null) {
  if (!pr) return "none recorded";
  const ref = pr.url ?? pr.externalId ?? pr.title;
  const freshness = isFreshPullRequest(pr) ? "non-stale" : "stale";
  const progress = PRODUCTIVITY_REVIEW_PROGRESS_PR_STATUSES.has(pr.status)
    ? "progress-eligible"
    : "not progress-eligible";
  return `${ref} \`${pr.status}\`, last activity ${pr.updatedAt.toISOString()} (${msToHuman(pr.ageMs)} ago, ${freshness}, ${progress})`;
}

const NO_EXECUTABLE_TURN_MECHANISM_LABELS: Record<NoExecutableTurnMechanism, string> = {
  capacity_park: "capacity park",
  dispatch_backlog: "dispatch backlog",
  zero_token_throttle: "zero-token throttle",
};

// BLO-23624 AC: names the mechanism mix rather than reporting a single
// undifferentiated figure, so a mixed-mechanism episode (e.g. BLO-23427: a
// dispatch-backlog cancellation, a zero-token throttle failure, and a
// capacity park) reads as three named contributors, not one.
function describeNoExecutableTurnMechanismMix(mechanismMs: Record<NoExecutableTurnMechanism, number>) {
  return (Object.keys(mechanismMs) as NoExecutableTurnMechanism[])
    .filter((mechanism) => mechanismMs[mechanism] > 0)
    .map((mechanism) => `${msToHumanFine(mechanismMs[mechanism])} ${NO_EXECUTABLE_TURN_MECHANISM_LABELS[mechanism]}`)
    .join(", ");
}

function formatNoExecutableTurnGating(gating: NonNullable<ProductivityReviewEvidence["noExecutableTurnGating"]>) {
  const mix = describeNoExecutableTurnMechanismMix(gating.mechanismMs);
  let currentClause = "";
  if (gating.currentMechanism === "capacity_park" && gating.scheduledRetryAt) {
    const dueClause = gating.overdue
      ? `due ${gating.scheduledRetryAt.toISOString()}, overdue and not yet promoted`
      : `due ${gating.scheduledRetryAt.toISOString()}`;
    currentClause = `; current run \`${gating.currentRunId}\` parked \`scheduled_retry\` on \`${gating.retryReason ?? gating.errorCode ?? "unknown"}\`, ${dueClause}`;
  } else if (gating.currentMechanism === "dispatch_backlog") {
    currentClause = `; current run \`${gating.currentRunId}\` never reached \`startedAt\``;
  } else if (gating.currentMechanism === "zero_token_throttle") {
    currentClause = `; current run \`${gating.currentRunId}\` failed with zero tokens executed`;
  }
  return `${msToHumanFine(gating.noExecutableTurnMs)} no-executable-turn time (${mix})${currentClause}`;
}

// BLO-23624: the `longActive` trigger-reason qualifier — only rendered when
// the episode is no-executable-turn-dominant. Mirrors the capacity-only
// version this replaces: when the current block is still open the trigger
// itself is suppressed (this note is unreachable), so the only path that
// reaches here is a dominant-but-no-longer-open block, most commonly an
// overdue, unpromoted capacity retry (BLO-22331's guard).
function formatNoExecutableTurnTriggerNote(gating: NonNullable<ProductivityReviewEvidence["noExecutableTurnGating"]>) {
  const mix = describeNoExecutableTurnMechanismMix(gating.mechanismMs);
  if (gating.currentMechanism === "capacity_park" && gating.overdue && gating.scheduledRetryAt) {
    return ` — ${msToHuman(gating.noExecutableTurnMs)} of that is no-executable-turn time (${mix}), currently behind an overdue \`scheduled_retry\` (run \`${gating.currentRunId}\`, due ${gating.scheduledRetryAt.toISOString()}, not yet promoted); this is a fleet-capacity signal, not assignee inactivity`;
  }
  return ` — ${msToHuman(gating.noExecutableTurnMs)} of that is no-executable-turn time (${mix}), but the current run is no longer blocked, so this is not being suppressed`;
}

function isMonitorScheduledSuppression(
  value: ProductivityReviewEvidence | MonitorScheduledSuppression | ApprovalGatedSuppression,
): value is MonitorScheduledSuppression {
  return "monitorNextCheckAt" in value;
}

function isApprovalGatedSuppression(
  value: ProductivityReviewEvidence | MonitorScheduledSuppression | ApprovalGatedSuppression,
): value is ApprovalGatedSuppression {
  return "approvalGate" in value;
}

function isRoutineOriginRun(run: HeartbeatRunRow): boolean {
  const ctx = run.contextSnapshot;
  if (!ctx || typeof ctx !== "object") return false;
  return (ctx as Record<string, unknown>).source === ROUTINE_DISPATCH_CONTEXT_SOURCE;
}

function buildThresholds(overrides?: Partial<ProductivityReviewThresholds>): ProductivityReviewThresholds {
  const monitorSchedulerIntervalMs = readPositiveInteger(
    overrides?.monitorSchedulerIntervalMs ?? DEFAULT_HEARTBEAT_SCHEDULER_INTERVAL_MS,
    DEFAULT_HEARTBEAT_SCHEDULER_INTERVAL_MS,
  );
  const monitorDispatchBatchSize = readPositiveInteger(
    overrides?.monitorDispatchBatchSize ?? ISSUE_MONITOR_DISPATCH_BATCH_SIZE,
    ISSUE_MONITOR_DISPATCH_BATCH_SIZE,
  );
  const longActiveMs = readPositiveInteger(
    overrides?.longActiveMs ?? DEFAULT_PRODUCTIVITY_REVIEW_LONG_ACTIVE_HOURS * 60 * 60 * 1000,
    DEFAULT_PRODUCTIVITY_REVIEW_LONG_ACTIVE_HOURS * 60 * 60 * 1000,
  );
  const requestedApprovalGateMaxAgeMs = readPositiveInteger(
    overrides?.approvalGateMaxAgeMs ?? DEFAULT_PRODUCTIVITY_REVIEW_APPROVAL_GATE_MAX_AGE_MS,
    DEFAULT_PRODUCTIVITY_REVIEW_APPROVAL_GATE_MAX_AGE_MS,
  );
  // The gate is only reachable while it outlives the trigger it suppresses: a gate that expires
  // at or before `longActiveMs` is already stale by the time the first long-active review would
  // fire, silently disabling the feature. The two are read independently above, so an override
  // pair can violate the invariant the constant's comment states — clamp instead of trusting it.
  const approvalGateMaxAgeMs = Math.max(requestedApprovalGateMaxAgeMs, longActiveMs);
  if (approvalGateMaxAgeMs !== requestedApprovalGateMaxAgeMs) {
    logger.warn(
      { requestedApprovalGateMaxAgeMs, longActiveMs, approvalGateMaxAgeMs },
      "productivity review approvalGateMaxAgeMs was at or below longActiveMs; clamped so the approval gate can engage",
    );
  }
  return {
    noCommentStreakRuns: readPositiveInteger(
      overrides?.noCommentStreakRuns ?? DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
      DEFAULT_PRODUCTIVITY_REVIEW_NO_COMMENT_STREAK_RUNS,
    ),
    longActiveMs,
    approvalGateMaxAgeMs,
    highChurnHourly: readPositiveInteger(
      overrides?.highChurnHourly ?? DEFAULT_PRODUCTIVITY_REVIEW_HIGH_CHURN_HOURLY,
      DEFAULT_PRODUCTIVITY_REVIEW_HIGH_CHURN_HOURLY,
    ),
    highChurnSixHours: readPositiveInteger(
      overrides?.highChurnSixHours ?? DEFAULT_PRODUCTIVITY_REVIEW_HIGH_CHURN_SIX_HOURS,
      DEFAULT_PRODUCTIVITY_REVIEW_HIGH_CHURN_SIX_HOURS,
    ),
    resolvedSnoozeMs: readPositiveInteger(
      overrides?.resolvedSnoozeMs ?? DEFAULT_PRODUCTIVITY_REVIEW_RESOLVED_SNOOZE_MS,
      DEFAULT_PRODUCTIVITY_REVIEW_RESOLVED_SNOOZE_MS,
    ),
    escalationThreshold: readPositiveInteger(
      overrides?.escalationThreshold ?? DEFAULT_PRODUCTIVITY_REVIEW_ESCALATION_THRESHOLD,
      DEFAULT_PRODUCTIVITY_REVIEW_ESCALATION_THRESHOLD,
    ),
    escalationLookbackMs: readPositiveInteger(
      overrides?.escalationLookbackMs ?? DEFAULT_PRODUCTIVITY_REVIEW_ESCALATION_LOOKBACK_MS,
      DEFAULT_PRODUCTIVITY_REVIEW_ESCALATION_LOOKBACK_MS,
    ),
    refreshIntervalMs: readPositiveInteger(
      overrides?.refreshIntervalMs ?? DEFAULT_PRODUCTIVITY_REVIEW_REFRESH_INTERVAL_MS,
      DEFAULT_PRODUCTIVITY_REVIEW_REFRESH_INTERVAL_MS,
    ),
    maxRefreshComments: readPositiveInteger(
      overrides?.maxRefreshComments ?? DEFAULT_PRODUCTIVITY_REVIEW_MAX_REFRESH_COMMENTS,
      DEFAULT_PRODUCTIVITY_REVIEW_MAX_REFRESH_COMMENTS,
    ),
    creationWindowMs: readPositiveInteger(
      overrides?.creationWindowMs ?? DEFAULT_PRODUCTIVITY_REVIEW_CREATION_WINDOW_MS,
      DEFAULT_PRODUCTIVITY_REVIEW_CREATION_WINDOW_MS,
    ),
    maxCreationsPerWindow: readPositiveInteger(
      overrides?.maxCreationsPerWindow ?? DEFAULT_PRODUCTIVITY_REVIEW_MAX_CREATIONS_PER_WINDOW,
      DEFAULT_PRODUCTIVITY_REVIEW_MAX_CREATIONS_PER_WINDOW,
    ),
    maxConsecutiveNoActionReviews: readPositiveInteger(
      overrides?.maxConsecutiveNoActionReviews ?? DEFAULT_PRODUCTIVITY_REVIEW_MAX_CONSECUTIVE_NO_ACTION_REVIEWS,
      DEFAULT_PRODUCTIVITY_REVIEW_MAX_CONSECUTIVE_NO_ACTION_REVIEWS,
    ),
    monitorLapseServiceGraceMs: readPositiveInteger(
      overrides?.monitorLapseServiceGraceMs ?? monitorSchedulerIntervalMs + ISSUE_MONITOR_WAKE_CLAIM_TTL_MS,
      monitorSchedulerIntervalMs + ISSUE_MONITOR_WAKE_CLAIM_TTL_MS,
    ),
    monitorSchedulerIntervalMs,
    monitorDispatchBatchSize,
  };
}

function choosePrimaryTrigger(input: {
  runtimeFailure: boolean;
  noComment: boolean;
  longActive: boolean;
  highChurn: boolean;
}): ProductivityReviewTrigger | null {
  // Runtime failure takes priority: if the sampled window is dominated by
  // runs that never got a model turn, that is the root cause worth surfacing
  // first — an agent that never executed cannot also be judged unproductive
  // (BLO-21769). `no_comment_streak` only ever counts runs that got an adapter
  // and a model turn (see `isNeverExecutedRun` and the `isNeverInvokedRun`
  // filtering in `collectEvidence`, BLO-26165), so the two streaks are drawn
  // from disjoint run sets and can coexist without this ordering being
  // arbitrary. Note it does NOT additionally require that a comment was
  // *policy-required* — that narrowing was the false negative BLO-26165's
  // follow-up removed.
  if (input.runtimeFailure) return "runtime_failure_streak";
  if (input.noComment) return "no_comment_streak";
  if (input.highChurn) return "high_churn";
  if (input.longActive) return "long_active_duration";
  return null;
}

function isSoftStopTrigger(trigger: ProductivityReviewTrigger) {
  return trigger === "no_comment_streak" || trigger === "high_churn";
}

// BLO-22436: which already-open reviews an unresolved blocker may retire. Scoped
// to the triggers the dependency gate itself *causes*, because the gate cancels
// queued runs before dispatch: `no_comment_streak` counts the silence the gate
// produces, and `long_active_duration` counts elapsed time the assignee cannot
// spend. Deliberately excluded:
//   - `high_churn` — a record of runs that did execute and did burn cost. A
//     blocker added afterwards does not make that untrue, and honouring it here
//     would let a flagged agent retire its own cost-accountability artifact by
//     adding a `blockedBy` edge.
//   - `runtime_failure_streak` — genuine infra faults, disjoint from the gate by
//     construction (`isInfraFailureRun` short-circuits on
//     `isDependencyBlockedRun`), so a blocker does not explain it.
//   - missing/unknown provenance — fails closed.
function isDependencyBlockedClosableTrigger(trigger: unknown) {
  return trigger === "no_comment_streak" || trigger === "long_active_duration";
}

// BLO-22436 (Ally follow-up on 37c1bd65): the set form of the predicate above,
// and the one every dependency gate must use. Keying on the *primary* trigger
// alone reopens the evasion `isDependencyBlockedClosableTrigger` exists to
// refuse, because `choosePrimaryTrigger` is a priority ladder: `no_comment_streak`
// outranks `high_churn`, so an agent burning runs *and* staying silent — the
// exact shape worth reviewing — presents a closable primary while carrying
// non-closable evidence underneath. The defaults make that overlap the norm
// rather than a corner (`noCommentStreakRuns` and `highChurnHourly` are both 10),
// so ten silent runs inside an hour trip both predicates at once.
//
// Requires a non-empty set: an empty/absent list is unknown provenance and fails
// closed, matching the single-trigger predicate's treatment of a missing trigger.
function isDependencyBlockedClosableTriggerSet(triggers: unknown) {
  return Array.isArray(triggers) && triggers.length > 0 && triggers.every(isDependencyBlockedClosableTrigger);
}

// Close-path form: the persisted `details.firedTriggers` when the review was
// minted with one, else the single `details.trigger` for rows written before
// BLO-22436's follow-up. The fallback is deliberately the *old* behaviour and
// not fail-closed: an already-open legacy review on a source that is now
// blocked has no other path back — `createOrUpdateReview` is the only thing
// that refreshes an open review and generation now skips blocked sources — so
// refusing to close it would strand it open forever, which is the very defect
// the close path was added to fix.
function isDependencyBlockedClosableRecord(trigger: unknown, firedTriggers: unknown) {
  if (firedTriggers === undefined || firedTriggers === null) {
    return isDependencyBlockedClosableTrigger(trigger);
  }
  return isDependencyBlockedClosableTriggerSet(firedTriggers);
}

function formatTrigger(trigger: ProductivityReviewTrigger) {
  if (trigger === "no_comment_streak") return "No-comment streak";
  if (trigger === "high_churn") return "High churn";
  if (trigger === "runtime_failure_streak") return "Runtime failure streak";
  return "Long active duration";
}

// BLO-22097: `usageJson: null` means usage was never *recorded*, not that
// zero tokens were consumed — a post-model failure whose result event never
// arrives leaves usage null even though the model produced output. Treating
// null the same as an explicit `{inputTokens: 0, outputTokens: 0}` (which
// `runUsageTokenCounts` does, since it exists to parse the blob once it
// exists) misclassifies that run as never-executed. `logBytes` corroborates
// the unknown case: every run log opens with ~15-20KB of session boilerplate
// before any model turn, and explicit-zero-usage runs sampled across
// BLO-19924/BLO-21091/BLO-21025 topped out at 111,337 bytes (still no model
// turn — likely a slow upstream timeout inflating the pre-failure log). A
// run that genuinely executed but lost its usage accounting (BLO-19924's
// `claude_truncated` case) logged 844,801 bytes, two orders of magnitude
// above that ceiling. The floor below is set with wide margin above the
// observed boilerplate ceiling and well below the observed executed-run
// floor — see BLO-22097 for the full sample tables.
const NEVER_EXECUTED_UNKNOWN_USAGE_LOG_BYTES_CEILING = 200_000;

const PRODUCTIVITY_REVIEW_TRIGGERS: readonly ProductivityReviewTrigger[] = [
  "no_comment_streak",
  "long_active_duration",
  "high_churn",
  "runtime_failure_streak",
];

// BLO-22105: `buildReviewMarkdown` bakes the trigger that produced it into the
// `- Primary trigger:` line. Reading it back out of the persisted description
// (rather than, say, the last activity-log entry) means the comparison is
// against exactly what a reader currently sees, so a refresh regenerates
// precisely when the visible Manager Decision guidance is actually stale.
function extractReviewTriggerFromDescription(description: string | null): ProductivityReviewTrigger | null {
  if (!description) return null;
  const match = description.match(/^- Primary trigger: `([a-z_]+)`/m);
  const candidate = match?.[1];
  return PRODUCTIVITY_REVIEW_TRIGGERS.find((trigger) => trigger === candidate) ?? null;
}

// True when the dependency gate cancelled a queued run before dispatch (see
// `cancelQueuedRunForBlockedDependencies` in heartbeat.ts). The run never
// reached the adapter, so it is disjoint from `isInfraFailureRun` below even
// though both are zero-token: this one is a graph-state fact about the issue
// (an unresolved `blockedBy` edge), not an infrastructure fault, and it must
// not be reported as one (BLO-22436).
function isDependencyBlockedRun(run: Pick<HeartbeatRunRow, "errorCode">): boolean {
  return run.errorCode === "issue_dependencies_blocked";
}

// True when a run's most recent classification is `failed` liveness AND it
// burned zero input+output tokens. That combination means the agent never
// got a model turn — the runtime crashed, the process was killed, or every
// model call errored before producing output. Observed causes include a K8s
// crashloop (`BackoffLimitExceeded`), an inference-gateway 503 storm, a
// provider capacity 429 kill, and retry-budget exhaustion with no error code
// at all (`error: "unknown"`, `error_status: null`). Keying on token usage
// rather than error code/status/dispatch-state is deliberate: it is the one
// signature all four causes share (BLO-21769). Excludes dependency-gate
// cancellations (BLO-22436) — those never reached the adapter at all, so they
// are a graph-state fact rather than an infrastructure fault, and are counted
// separately.
//
// `usageJson: null` is unknown, not a measured zero (BLO-22097): it is only
// read as never-executed when `logBytes` also stays at or under the
// boilerplate-only ceiling. An *explicit* zero-usage blob is never
// second-guessed by `logBytes` — a large log with confirmed zero tokens
// (observed up to 111,337 bytes) is still never-executed, since the
// corroboration only fills in for missing telemetry, not disputed telemetry.
//
// The two narrowings compose without collapsing: BLO-22097 narrows *within*
// this predicate (which failed runs count as infra), while BLO-22436 widens
// the *union* below (which populations count as never-executed). Keep them
// disjoint — folding the dependency gate into the usage test would let a
// blocker edge masquerade as an infrastructure fault.
function isInfraFailureRun(
  run: Pick<HeartbeatRunRow, "livenessState" | "usageJson" | "logBytes" | "errorCode">,
): boolean {
  if (isDependencyBlockedRun(run)) return false;
  if (run.livenessState !== "failed") return false;
  if (run.usageJson == null) {
    return (run.logBytes ?? 0) <= NEVER_EXECUTED_UNKNOWN_USAGE_LOG_BYTES_CEILING;
  }
  const { inputTokens, outputTokens } = runUsageTokenCounts(run.usageJson);
  return inputTokens === 0 && outputTokens === 0;
}

// BLO-22097: manager-facing evidence text must not claim a measured "0
// input/output tokens" for a run whose usage was never recorded — that
// overstates an inferred infrastructure classification as a fact. Only
// runs with a present zero-token usage blob get the explicit-zero wording;
// null-usage runs get "unavailable" wording naming the corroborator instead.
function formatRuntimeFailureUsageEvidence(
  basis: "measured" | "inferred" | "mixed" | null,
): string {
  if (basis === "measured") return "0 input/output tokens";
  if (basis === "inferred") {
    return "usage telemetry unavailable — low/missing log volume consistent with no model turn";
  }
  if (basis === "mixed") {
    return "usage telemetry unavailable for some runs (low/missing log volume consistent with no model turn), explicit 0 input/output tokens for the rest";
  }
  return "usage telemetry unavailable";
}

// BLO-22097 (Ally follow-up): "produced zero model turns" is a fact only when
// `basis === "measured"`. For `inferred`/`mixed` the underlying signal is
// missing usage telemetry corroborated by low/absent log volume — consistent
// with no model turn, not proof of it. Asserting the unqualified claim for
// those bases overstates a heuristic as a measured outcome, so they get
// hedged wording instead.
function formatRuntimeFailureTriggerClaim(
  streak: number,
  basis: "measured" | "inferred" | "mixed" | null,
): string {
  const evidence = formatRuntimeFailureUsageEvidence(basis);
  if (basis === "measured") {
    return `${streak} consecutive terminal runs produced zero model turns (failed liveness, ${evidence}) — infrastructure failure, not agent silence`;
  }
  return `${streak} consecutive terminal runs show no evidence of a model turn (failed liveness, ${evidence}) — consistent with an infrastructure failure, not confirmed agent silence`;
}

// Same qualification as `formatRuntimeFailureTriggerClaim`, applied to the
// manager-facing decision text: "the assignee was never given a chance to
// act" is only provable when usage is measured. Missing telemetry cannot
// confirm that claim, only be consistent with it.
function formatRuntimeFailureManagerClaim(
  basis: "measured" | "inferred" | "mixed" | null,
): string {
  const evidence = formatRuntimeFailureUsageEvidence(basis);
  if (basis === "measured") {
    return `This trigger fired because the sampled runs never executed a model turn (failed liveness, ${evidence}) — the assignee was never given a chance to act. This is an infrastructure signal, not an agent-performance verdict; do not decompose, block, or cancel the underlying work on the strength of this alone.`;
  }
  return `This trigger fired because the sampled runs show no evidence of executing a model turn (failed liveness, ${evidence}) — consistent with the assignee never being given a chance to act, though missing usage telemetry means this cannot be confirmed. This is an infrastructure signal, not an agent-performance verdict; do not decompose, block, or cancel the underlying work on the strength of this alone.`;
}

// Union of every population that could not possibly have produced a run
// comment: the agent was never given a model turn to comment with, whether
// because the runtime failed (`isInfraFailureRun`) or because the dependency
// gate cancelled the run before dispatch (`isDependencyBlockedRun`,
// BLO-22436). Both populations are excluded from the no-comment-streak walk
// on the same basis — neither is evidence of assignee silence.
function isNeverExecutedRun(
  run: Pick<HeartbeatRunRow, "livenessState" | "usageJson" | "logBytes" | "errorCode">,
): boolean {
  return isInfraFailureRun(run) || isDependencyBlockedRun(run);
}

// True when no adapter container was ever created for this run, so nothing
// capable of writing a comment ever existed (BLO-23096: `preferred_workspace_
// unrealizable` / `adapter_failed` pre-adapter setup failures, observed at
// 584ms and 1,097ms lifetimes).
//
// This is the *invocation* predicate. It exists because BLO-26165 originally
// excluded these runs by reading `issueCommentStatus === "not_applicable"`,
// which was a false-negative regression of considerable scope:
// `finalizeIssueCommentPolicy` (heartbeat.ts) stamps that same status on runs
// that provably executed — once when
// `shouldRequireIssueCommentForWake` returns false, and once when a deferred
// comment wake already exists. That helper is a four-item whitelist
// (`issue_assigned`, `execution_review_requested`,
// `execution_approval_requested`, `execution_changes_requested`), so keying
// the streak on the column made every `heartbeat_timer`, `issue_monitor_due`,
// `issue_comment_mentioned`, `issue_continuation_needed`, `process_lost_retry`
// and recovery-lane run structurally invisible to the silent-agent detector,
// whether or not it ran a full model turn. An agent could go silent across
// dozens of wakes and the streak would read zero. Comment *policy* and
// *invocation* are two different facts sharing one column; only this predicate
// tests the second one.
//
// Deliberately keyed on total absence of run telemetry rather than the
// `logBytes` ceiling heuristic `isInfraFailureRun` uses. A container that
// started writes its session boilerplate, so a non-null `logStore`/`logRef`
// or any non-zero `logBytes` is positive evidence the adapter existed. An
// explicit zero-token `usageJson` likewise means a session was created and
// measured (the BLO-21769 shape) — that run was invoked and belongs to
// `runtimeFailureStreak`, not here. Keeping the two disjoint is what lets the
// evidence block name which one it is.
//
// Independent of `livenessState` being *`failed`*, which is the gap that made
// the original fix necessary: `classifyAndPersistRunLiveness` never runs for a
// pre-adapter failure, so `isInfraFailureRun`'s `livenessState !== "failed"`
// check cannot catch these rows. A *non-null* `livenessState` is still read as
// positive proof of invocation, though — that column is only ever written by
// `classifyAndPersistRunLiveness`, which runs after the adapter completes and
// has adapter output to classify. This direction of the bias is deliberate:
// wrongly excluding a run recreates the false negative above (a silent agent
// reads as clean), while wrongly counting one produces a review a manager can
// read the evidence block and dismiss. Prefer counting.
function isNeverInvokedRun(
  run: Pick<HeartbeatRunRow, "usageJson" | "logBytes" | "logStore" | "logRef" | "livenessState">,
): boolean {
  if (run.livenessState != null) return false;
  if (run.usageJson != null) return false;
  if (run.logStore != null || run.logRef != null) return false;
  return (run.logBytes ?? 0) === 0;
}

// The most common `errorCode` among `runs`, but ONLY when it holds a strict
// majority — a plurality decided by run ordering would render as a definite
// diagnosis of the window when none exists (e.g. 2 infra + 2 dependency-gate
// cancellations). Returns null when no code clears half, so the caller can say
// so explicitly. A missing code is counted in its own bucket rather than folded
// into the literal string `"unknown"`, which BLO-21769 documents as a real
// observed `errorCode` value.
function dominantErrorCode(
  runs: Array<Pick<HeartbeatRunRow, "errorCode">>,
): { code: string | null; count: number } | null {
  if (runs.length === 0) return null;
  const counts = new Map<string | null, number>();
  for (const run of runs) {
    const code = run.errorCode ?? null;
    counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  let winner: string | null = null;
  let winnerCount = 0;
  for (const [code, count] of counts) {
    if (count > winnerCount) {
      winner = code;
      winnerCount = count;
    }
  }
  if (winnerCount * 2 <= runs.length) return null;
  return { code: winner, count: winnerCount };
}

/**
 * Either the pooled handle or an open transaction. Helpers that participate in
 * the BLO-3737 refresh-throttle critical section accept this so the read and the
 * write land on the same connection (and therefore inside the same advisory lock).
 */
type DbOrTx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

export function productivityReviewService(db: Db, deps?: ProductivityReviewServiceDeps) {
  const issuesSvc = issueService(db);
  const budgets = budgetService(db);

  async function currentDatabaseTime(executor: DbOrTx) {
    const [row] = Array.from(await executor.execute(sql<{ now: Date | string }>`
      select clock_timestamp() as "now"
    `)) as Array<{ now: Date | string | null }>;
    return coerceDate(row?.now) ?? new Date();
  }

  async function getCompanyIssuePrefix(companyId: string) {
    return db
      .select({ issuePrefix: companies.issuePrefix })
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0]?.issuePrefix ?? "PAP");
  }

  async function getAgent(agentId: string) {
    return db
      .select()
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0] ?? null);
  }

  async function getCurrentIssue(
    sourceIssue: IssueRow,
    dbClient: DbOrTx = db,
    opts?: { forUpdate?: boolean },
  ) {
    if (opts?.forUpdate) {
      await dbClient.execute(sql`
        select ${issues.id}
        from ${issues}
        where ${issues.companyId} = ${sourceIssue.companyId}
          and ${issues.id} = ${sourceIssue.id}
        for update
      `);
    }
    return dbClient
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, sourceIssue.companyId), eq(issues.id, sourceIssue.id)))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function evaluateSourceReviewability(sourceIssue: IssueRow, sourceAgentId: string) {
    const current = await db
      .select({
        status: issues.status,
        hiddenAt: issues.hiddenAt,
        assigneeAgentId: issues.assigneeAgentId,
        assigneeUserId: issues.assigneeUserId,
        originKind: issues.originKind,
      })
      .from(issues)
      .where(and(eq(issues.companyId, sourceIssue.companyId), eq(issues.id, sourceIssue.id)))
      .then((rows) => rows[0] ?? null);
    const status = current?.status ?? null;
    const reviewable = Boolean(
      current &&
        !current.hiddenAt &&
        !current.assigneeUserId &&
        current.assigneeAgentId === sourceAgentId &&
        ["todo", "in_progress"].includes(current.status) &&
        current.originKind !== PRODUCTIVITY_REVIEW_ORIGIN_KIND,
    );
    // BLO-6243: a source that has reached a terminal status (done/cancelled) — including via
    // a race between candidate selection and this recheck — is a post-terminal sweep artifact,
    // not a work-stoppage signal. Surface it distinctly so the caller can suppress + audit it.
    const terminal = isTerminalIssueStatus(status);
    return { reviewable, terminal, status };
  }

  function isAgentInvokable(agent: AgentRow | null | undefined) {
    return Boolean(agent && !["paused", "terminated", "pending_approval"].includes(agent.status));
  }

  async function isProductivityReviewDescendant(issue: Pick<IssueRow, "companyId" | "parentId">) {
    let parentId = issue.parentId;
    let depth = 0;
    while (parentId && depth < MAX_PARENT_WALK_DEPTH) {
      const parent = await db
        .select({ id: issues.id, parentId: issues.parentId, originKind: issues.originKind })
        .from(issues)
        .where(and(eq(issues.companyId, issue.companyId), eq(issues.id, parentId)))
        .then((rows) => rows[0] ?? null);
      if (!parent) return false;
      if (parent.originKind === PRODUCTIVITY_REVIEW_ORIGIN_KIND) return true;
      parentId = parent.parentId;
      depth += 1;
    }
    return false;
  }

  async function findOpenProductivityReview(
    companyId: string,
    sourceIssueId: string,
    executor: DbOrTx = db,
  ) {
    return executor
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, PRODUCTIVITY_REVIEW_ORIGIN_KIND),
          eq(issues.originId, sourceIssueId),
          visibleIssueCondition(),
          notInArray(issues.status, ["done", "cancelled"]),
        ),
      )
      .orderBy(desc(issues.updatedAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function reserveLongActiveProductivityReviewIssue(input: {
    evidence: ProductivityReviewEvidence;
    thresholds: ProductivityReviewThresholds;
    ownerAgentId: string;
    title: string;
    description: string;
  }) {
    return db.transaction((tx) =>
      withIssueMonitorQueueLock(tx, async () => {
        const monitor = await currentPendingMonitorForReviewSuppression(
          input.evidence.sourceIssue,
          input.evidence.generatedAt,
          input.thresholds,
          tx,
          { lockSource: true, runBacklogHook: false },
        );
        if (monitor) throw new MonitorSuppressedBeforeCreateError(monitor);

        const existing = await findOpenProductivityReview(
          input.evidence.sourceIssue.companyId,
          input.evidence.sourceIssue.id,
          tx,
        );
        if (existing) return { kind: "existing" as const, review: existing };

        const [review] = await tx
          .insert(issues)
          .values({
            companyId: input.evidence.sourceIssue.companyId,
            title: input.title,
            description: input.description,
            status: "todo",
            priority: "medium",
            parentId: input.evidence.sourceIssue.id,
            projectId: input.evidence.sourceIssue.projectId,
            projectWorkspaceId: input.evidence.sourceIssue.projectWorkspaceId,
            goalId: input.evidence.sourceIssue.goalId,
            billingCode: input.evidence.sourceIssue.billingCode,
            assigneeAgentId: input.ownerAgentId,
            createdByAgentId: input.evidence.sourceAgent.id,
            assigneeAdapterOverrides: recoveryAssigneeAdapterOverrides("status_only"),
            responsibleUserId:
              input.evidence.sourceIssue.responsibleUserId ??
              input.evidence.sourceIssue.createdByUserId,
            originKind: PRODUCTIVITY_REVIEW_ORIGIN_KIND,
            originId: input.evidence.sourceIssue.id,
            originFingerprint: productivityReviewFingerprint(input.evidence.sourceIssue.id),
            requestDepth: clampIssueRequestDepth(input.evidence.sourceIssue.requestDepth + 1),
            createdAt: input.evidence.generatedAt,
            updatedAt: input.evidence.generatedAt,
            lastActivityAt: input.evidence.generatedAt,
          })
          .returning();

        return { kind: "reserved" as const, review };
      })
    );
  }

  async function finalizeReservedProductivityReviewIssue(input: {
    review: IssueRow;
    title: string;
    description: string;
    generatedAt: Date;
  }): Promise<{ review: IssueRow; finalized: boolean }> {
    let createdLinearIssueId: string | null = null;
    let preserveReservation = false;
    try {
      return await db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`productivity-review-finalize:${input.review.id}`}, 0))`,
        );

        const current = await tx
          .select()
          .from(issues)
          .where(and(eq(issues.companyId, input.review.companyId), eq(issues.id, input.review.id)))
          .limit(1)
          .then((rows) => rows[0] ?? null);
        if (!current) throw new Error(`Reserved productivity review ${input.review.id} disappeared before finalization`);
        if (current.identifier && current.issueNumber != null) {
          return { review: current, finalized: false };
        }
        if (current.identifier || current.issueNumber != null) {
          throw new Error(`Reserved productivity review ${input.review.id} is partially finalized`);
        }

        const allocation = await allocateIdentifier({
          db: tx,
          companyId: input.review.companyId,
          title: input.title,
          description: input.description,
          linearIssueIdempotencyKey: input.review.id,
        });
        if (allocation.createdLinearSideIssue && allocation.externalIssueId) {
          createdLinearIssueId = allocation.externalIssueId;
        }
        if (allocation.source === "linear") {
          preserveReservation = true;
        }

        const [updated] = await tx
          .update(issues)
          .set({
            issueNumber: allocation.issueNumber,
            identifier: allocation.identifier,
            updatedAt: input.generatedAt,
          })
          .where(
            and(
              eq(issues.companyId, input.review.companyId),
              eq(issues.id, input.review.id),
              isNull(issues.issueNumber),
              isNull(issues.identifier),
            ),
          )
          .returning();
        if (!updated) throw new Error(`Reserved productivity review ${input.review.id} was finalized concurrently`);

        if (allocation.source === "linear" && allocation.externalIssueId) {
          await tx.insert(linearIssueLinks).values({
            companyId: input.review.companyId,
            paperclipIssueId: updated.id,
            linearIssueId: allocation.externalIssueId,
            linearIdentifier: allocation.identifier,
          });
        }

        return { review: updated, finalized: true };
      });
    } catch (error) {
      if (error instanceof LinearIssueCreateUnconfirmedError || preserveReservation) {
        throw error;
      }
      if (createdLinearIssueId) {
        await deleteLinearIssueForCompany(db, input.review.companyId, createdLinearIssueId).catch(() => {});
      }
      await db
        .delete(issues)
        .where(and(eq(issues.id, input.review.id), isNull(issues.issueNumber), isNull(issues.identifier)))
        .catch(() => {});
      throw error;
    }
  }

  async function findRecentResolvedProductivityReview(
    companyId: string,
    sourceIssueId: string,
    thresholds: ProductivityReviewThresholds,
    now: Date,
  ) {
    const cutoff = new Date(now.getTime() - thresholds.resolvedSnoozeMs);
    return db
      .select({ id: issues.id, identifier: issues.identifier, status: issues.status, updatedAt: issues.updatedAt })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, PRODUCTIVITY_REVIEW_ORIGIN_KIND),
          eq(issues.originId, sourceIssueId),
          inArray(issues.status, ["done", "cancelled"]),
          gt(issues.updatedAt, cutoff),
        ),
      )
      .orderBy(desc(issues.updatedAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function hasRepeatedTerminalReviewsInBackoff(companyId: string, sourceIssueId: string, now: Date) {
    const cutoff = new Date(now.getTime() - PRODUCTIVITY_REVIEW_REPEAT_BACKOFF_MS);
    const count = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, PRODUCTIVITY_REVIEW_ORIGIN_KIND),
          eq(issues.originId, sourceIssueId),
          eq(issues.status, "done"),
          gt(issues.updatedAt, cutoff),
        ),
      )
      .then((rows) => rows[0]?.count ?? 0);
    return count >= 2;
  }

  async function countResolvedProductivityReviews(
    companyId: string,
    sourceIssueId: string,
    lookbackMs: number,
    now: Date,
  ): Promise<number> {
    const cutoff = new Date(now.getTime() - lookbackMs);
    return db
      .select({ count: sql<number>`count(*)::int` })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, PRODUCTIVITY_REVIEW_ORIGIN_KIND),
          eq(issues.originId, sourceIssueId),
          eq(issues.status, "done"),
          gt(issues.updatedAt, cutoff),
          isNull(issues.hiddenAt),
        ),
      )
      .then((rows) => Number(rows[0]?.count ?? 0));
  }

  async function countRecentProductivityReviews(
    companyId: string,
    sourceIssueId: string,
    thresholds: ProductivityReviewThresholds,
    now: Date,
  ) {
    const cutoff = new Date(now.getTime() - thresholds.creationWindowMs);
    return db
      .select({ count: sql<number>`count(*)::int` })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, PRODUCTIVITY_REVIEW_ORIGIN_KIND),
          eq(issues.originId, sourceIssueId),
          visibleIssueCondition(),
          sql`${issues.status} <> 'cancelled'`,
          sql`${issues.createdAt} >= ${cutoff.toISOString()}::timestamptz`,
        ),
      )
      .then((rows) => Number(rows[0]?.count ?? 0));
  }

  async function countConsecutiveNoActionProductivityReviews(
    companyId: string,
    sourceIssueId: string,
    thresholds: ProductivityReviewThresholds,
  ) {
    const completedReviews = await db
      .select({
        createdAt: issues.createdAt,
      })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, PRODUCTIVITY_REVIEW_ORIGIN_KIND),
          eq(issues.originId, sourceIssueId),
          eq(issues.status, "done"),
          visibleIssueCondition(),
        ),
      )
      .orderBy(desc(issues.createdAt), desc(issues.id))
      .limit(thresholds.maxConsecutiveNoActionReviews);

    const earliestReviewCreatedAt = completedReviews.at(-1)?.createdAt;
    if (!earliestReviewCreatedAt) return 0;
    const sourceActions = await db
      .select({ createdAt: activityLog.createdAt })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.companyId, companyId),
          eq(activityLog.entityType, "issue"),
          eq(activityLog.entityId, sourceIssueId),
          gte(activityLog.createdAt, earliestReviewCreatedAt),
        ),
      );

    let streak = 0;
    for (const [index, review] of completedReviews.entries()) {
      const nextNewerReviewCreatedAt = completedReviews[index - 1]?.createdAt ?? null;
      const sourceAction = sourceActions.some((activity) => {
        if (activity.createdAt < review.createdAt) return false;
        return !nextNewerReviewCreatedAt || activity.createdAt < nextNewerReviewCreatedAt;
      });
      if (sourceAction) break;
      streak += 1;
    }
    return streak;
  }

  async function getRefreshCommentState(companyId: string, reviewIssueId: string, executor: DbOrTx = db) {
    return executor
      .select({
        count: sql<number>`count(*)::int`,
        latestCreatedAt: sql<Date | null>`max(${issueComments.createdAt})`,
      })
      .from(issueComments)
      .where(
        and(
          eq(issueComments.companyId, companyId),
          eq(issueComments.issueId, reviewIssueId),
          sql`${issueComments.body} like ${`${PRODUCTIVITY_REVIEW_REFRESH_COMMENT_PREFIX}%`}`,
        ),
      )
      .then((rows) => {
        const row = rows[0];
        return {
          count: Number(row?.count ?? 0),
          latestCreatedAt: coerceDate(row?.latestCreatedAt),
        };
      });
  }

  async function addRefreshComment(
    reviewIssueId: string,
    body: string,
    generatedAt: Date,
    executor: DbOrTx = db,
  ) {
    const comment = await issuesSvc.addComment(reviewIssueId, body, {}, undefined, executor);
    await executor
      .update(issueComments)
      .set({ createdAt: generatedAt, updatedAt: generatedAt })
      .where(eq(issueComments.id, comment.id));
    await executor
      .update(issues)
      .set({ updatedAt: generatedAt })
      .where(eq(issues.id, reviewIssueId));
    return comment;
  }

  async function hasIssueActivity(
    executor: DbOrTx,
    input: { companyId: string; issueId: string; action: string },
  ) {
    return executor
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.companyId, input.companyId),
          eq(activityLog.entityType, "issue"),
          eq(activityLog.entityId, input.issueId),
          eq(activityLog.action, input.action),
        ),
      )
      .limit(1)
      .then((rows) => Boolean(rows[0]));
  }

  async function insertIssueActivityIfMissing(
    executor: DbOrTx,
    input: {
      companyId: string;
      issueId: string;
      action: string;
      agentId?: string | null;
      details?: Record<string, unknown> | null;
      createdAt: Date;
    },
  ) {
    if (await hasIssueActivity(executor, input)) return false;
    await executor.insert(activityLog).values({
      companyId: input.companyId,
      actorType: "system",
      actorId: "system",
      action: input.action,
      entityType: "issue",
      entityId: input.issueId,
      agentId: input.agentId ?? null,
      details: input.details ?? null,
      createdAt: input.createdAt,
    });
    return true;
  }

  function activityDetails(details: unknown) {
    return typeof details === "object" && details !== null && !Array.isArray(details)
      ? details as Record<string, unknown>
      : {};
  }

  function activityAttemptId(details: unknown) {
    const attemptId = activityDetails(details).attemptId;
    return typeof attemptId === "string" ? attemptId : null;
  }

  function activityAttemptSequence(details: unknown) {
    const attemptSequence = activityDetails(details).attemptSequence;
    return typeof attemptSequence === "number" && Number.isFinite(attemptSequence) ? attemptSequence : 0;
  }

  async function latestAssignmentWakeClaimActivity(
    executor: DbOrTx,
    input: { companyId: string; issueId: string },
  ) {
    return executor
      .select({
        action: activityLog.action,
        createdAt: activityLog.createdAt,
        details: activityLog.details,
      })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.companyId, input.companyId),
          eq(activityLog.entityType, "issue"),
          eq(activityLog.entityId, input.issueId),
          inArray(activityLog.action, [
            PRODUCTIVITY_REVIEW_ASSIGNMENT_WAKE_STARTED_ACTION,
            PRODUCTIVITY_REVIEW_ASSIGNMENT_WAKE_FAILED_ACTION,
          ]),
        ),
      )
      .orderBy(
        desc(activityLog.createdAt),
        desc(sql<number>`coalesce((${activityLog.details}->>'attemptSequence')::int, 0)`),
        desc(sql<number>`case ${activityLog.action}
          when ${PRODUCTIVITY_REVIEW_ASSIGNMENT_WAKE_FAILED_ACTION} then 2
          when ${PRODUCTIVITY_REVIEW_ASSIGNMENT_WAKE_STARTED_ACTION} then 1
          else 0
        end`),
        desc(activityLog.id),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function hasAssignmentWakeRequest(
    executor: DbOrTx,
    input: { companyId: string; agentId: string; idempotencyKey: string },
  ) {
    return executor
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, input.companyId),
          eq(agentWakeupRequests.agentId, input.agentId),
          eq(agentWakeupRequests.idempotencyKey, input.idempotencyKey),
          inArray(agentWakeupRequests.status, [...PRODUCTIVITY_REVIEW_DURABLE_WAKE_REQUEST_STATUSES]),
        ),
      )
      .limit(1)
      .then((rows) => Boolean(rows[0]));
  }

  function assignmentWakeDetails(
    evidence: ProductivityReviewFinishEvidence,
    wakeIdempotencyKey: string,
    attemptId?: string,
    attemptSequence?: number,
  ) {
    return {
      source: "productivity_review.reconcile",
      sourceIssueId: evidence.sourceIssue.id,
      trigger: evidence.trigger,
      idempotencyKey: wakeIdempotencyKey,
      ...(attemptId
        ? {
            attemptId,
            attemptSequence: attemptSequence ?? 0,
            leaseMs: PRODUCTIVITY_REVIEW_ASSIGNMENT_WAKE_CLAIM_LEASE_MS,
          }
        : {}),
    };
  }

  function assignmentWakeOptions(
    review: Pick<IssueRow, "id">,
    evidence: ProductivityReviewFinishEvidence,
    wakeIdempotencyKey: string,
  ): NonNullable<Parameters<EnqueueWakeup>[1]> {
    return {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      idempotencyKey: wakeIdempotencyKey,
      payload: withRecoveryModelProfileHint({
        issueId: review.id,
        sourceIssueId: evidence.sourceIssue.id,
        trigger: evidence.trigger,
      }, "status_only"),
      requestedByActorType: "system",
      requestedByActorId: "productivity_review",
      contextSnapshot: withRecoveryModelProfileHint({
        issueId: review.id,
        taskId: review.id,
        wakeReason: "issue_assigned",
        source: PRODUCTIVITY_REVIEW_ORIGIN_KIND,
        sourceIssueId: evidence.sourceIssue.id,
        productivityReviewTrigger: evidence.trigger,
      }, "status_only"),
    };
  }

  async function failAssignmentWakeClaim(input: {
    review: Pick<IssueRow, "id">;
    evidence: ProductivityReviewFinishEvidence;
    ownerAgentId: string;
    wakeIdempotencyKey: string;
    attemptId: string;
    attemptSequence: number;
  }) {
    await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`productivity-review-finish:${input.review.id}`}, 0))`,
      );
      const claimNow = await currentDatabaseTime(tx);
      const latest = await latestAssignmentWakeClaimActivity(tx, {
        companyId: input.evidence.sourceIssue.companyId,
        issueId: input.review.id,
      });
      if (
        latest?.action !== PRODUCTIVITY_REVIEW_ASSIGNMENT_WAKE_STARTED_ACTION ||
        activityAttemptId(latest.details) !== input.attemptId
      ) {
        return;
      }
      await tx.insert(activityLog).values({
        companyId: input.evidence.sourceIssue.companyId,
        actorType: "system",
        actorId: "system",
        action: PRODUCTIVITY_REVIEW_ASSIGNMENT_WAKE_FAILED_ACTION,
        entityType: "issue",
        entityId: input.review.id,
        agentId: input.ownerAgentId,
        details: assignmentWakeDetails(
          input.evidence,
          input.wakeIdempotencyKey,
          input.attemptId,
          input.attemptSequence,
        ),
        createdAt: claimNow,
      });
    });
  }

  async function completeAssignmentWakeClaim(input: {
    review: Pick<IssueRow, "id">;
    evidence: ProductivityReviewFinishEvidence;
    ownerAgentId: string;
    wakeIdempotencyKey: string;
    attemptId: string;
    attemptSequence: number;
    wake: unknown | null;
  }) {
    return db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`productivity-review-finish:${input.review.id}`}, 0))`,
      );
      const claimNow = await currentDatabaseTime(tx);
      const wakeMarkerExists = await hasIssueActivity(tx, {
        companyId: input.evidence.sourceIssue.companyId,
        issueId: input.review.id,
        action: PRODUCTIVITY_REVIEW_ASSIGNMENT_WAKE_ENQUEUED_ACTION,
      });
      if (wakeMarkerExists) return false;

      const latest = await latestAssignmentWakeClaimActivity(tx, {
        companyId: input.evidence.sourceIssue.companyId,
        issueId: input.review.id,
      });
      if (
        latest?.action !== PRODUCTIVITY_REVIEW_ASSIGNMENT_WAKE_STARTED_ACTION ||
        activityAttemptId(latest.details) !== input.attemptId
      ) {
        return false;
      }

      const wakeProcessed = Boolean(input.wake) || await hasAssignmentWakeRequest(tx, {
        companyId: input.evidence.sourceIssue.companyId,
        agentId: input.ownerAgentId,
        idempotencyKey: input.wakeIdempotencyKey,
      });
      if (!wakeProcessed) {
        await tx.insert(activityLog).values({
          companyId: input.evidence.sourceIssue.companyId,
          actorType: "system",
          actorId: "system",
          action: PRODUCTIVITY_REVIEW_ASSIGNMENT_WAKE_FAILED_ACTION,
          entityType: "issue",
          entityId: input.review.id,
          agentId: input.ownerAgentId,
          details: assignmentWakeDetails(
            input.evidence,
            input.wakeIdempotencyKey,
            input.attemptId,
            input.attemptSequence,
          ),
          createdAt: claimNow,
        });
        return false;
      }

      return insertIssueActivityIfMissing(tx, {
        companyId: input.evidence.sourceIssue.companyId,
        issueId: input.review.id,
        action: PRODUCTIVITY_REVIEW_ASSIGNMENT_WAKE_ENQUEUED_ACTION,
        agentId: input.ownerAgentId,
        createdAt: claimNow,
        details: assignmentWakeDetails(input.evidence, input.wakeIdempotencyKey),
      });
    });
  }

  async function finishCreatedProductivityReview(
    review: Pick<IssueRow, "id">,
    evidence: ProductivityReviewFinishEvidence,
    ownerAgentId: string,
  ): Promise<{ createdActivityInserted: boolean; assignmentWakeProcessed: boolean }> {
    const wakeIdempotencyKey = productivityReviewAssignmentWakeIdempotencyKey(review.id);
    const claim = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`productivity-review-finish:${review.id}`}, 0))`,
      );

      const createdActivityInserted = await insertIssueActivityIfMissing(tx, {
        companyId: evidence.sourceIssue.companyId,
        issueId: review.id,
        action: PRODUCTIVITY_REVIEW_CREATED_ACTION,
        agentId: ownerAgentId,
        createdAt: evidence.generatedAt,
        details: {
          source: "productivity_review.reconcile",
          sourceIssueId: evidence.sourceIssue.id,
          trigger: evidence.trigger,
          // BLO-22436: persisted so the close path can apply the same
          // whole-set test the generation gate does. Rows written before this
          // field existed carry only `trigger`; see the fallback in
          // `closeOpenSuppressedReviews`.
          firedTriggers: evidence.firedTriggers,
          noCommentStreak: evidence.noCommentStreak,
          runCountLastHour: evidence.runCountLastHour,
          commentCountLastHour: evidence.commentCountLastHour,
        },
      });

      if (createdActivityInserted) {
        await tx
          .update(issues)
          .set({ createdAt: evidence.generatedAt, updatedAt: evidence.generatedAt })
          .where(eq(issues.id, review.id));
      }

      if (!deps?.enqueueWakeup) {
        return {
          createdActivityInserted,
          assignmentWakeProcessed: false,
          wakeClaim: null as { attemptId: string; attemptSequence: number } | null,
        };
      }

      const wakeMarkerExists = await hasIssueActivity(tx, {
        companyId: evidence.sourceIssue.companyId,
        issueId: review.id,
        action: PRODUCTIVITY_REVIEW_ASSIGNMENT_WAKE_ENQUEUED_ACTION,
      });
      if (wakeMarkerExists) {
        return {
          createdActivityInserted,
          assignmentWakeProcessed: false,
          wakeClaim: null as { attemptId: string; attemptSequence: number } | null,
        };
      }

      const wakeAlreadyProcessed = await hasAssignmentWakeRequest(tx, {
        companyId: evidence.sourceIssue.companyId,
        agentId: ownerAgentId,
        idempotencyKey: wakeIdempotencyKey,
      });
      if (wakeAlreadyProcessed) {
        const assignmentWakeProcessed = await insertIssueActivityIfMissing(tx, {
          companyId: evidence.sourceIssue.companyId,
          issueId: review.id,
          action: PRODUCTIVITY_REVIEW_ASSIGNMENT_WAKE_ENQUEUED_ACTION,
          agentId: ownerAgentId,
          createdAt: evidence.generatedAt,
          details: assignmentWakeDetails(evidence, wakeIdempotencyKey),
        });
        return {
          createdActivityInserted,
          assignmentWakeProcessed,
          wakeClaim: null as { attemptId: string; attemptSequence: number } | null,
        };
      }

      const claimNow = await currentDatabaseTime(tx);
      const latest = await latestAssignmentWakeClaimActivity(tx, {
        companyId: evidence.sourceIssue.companyId,
        issueId: review.id,
      });
      if (
        latest?.action === PRODUCTIVITY_REVIEW_ASSIGNMENT_WAKE_STARTED_ACTION &&
        latest.createdAt.getTime() > claimNow.getTime() - PRODUCTIVITY_REVIEW_ASSIGNMENT_WAKE_CLAIM_LEASE_MS
      ) {
        return {
          createdActivityInserted,
          assignmentWakeProcessed: false,
          wakeClaim: null as { attemptId: string; attemptSequence: number } | null,
        };
      }

      const attemptId = randomUUID();
      const attemptSequence = activityAttemptSequence(latest?.details) + 1;
      await tx.insert(activityLog).values({
        companyId: evidence.sourceIssue.companyId,
        actorType: "system",
        actorId: "system",
        action: PRODUCTIVITY_REVIEW_ASSIGNMENT_WAKE_STARTED_ACTION,
        entityType: "issue",
        entityId: review.id,
        agentId: ownerAgentId,
        details: assignmentWakeDetails(evidence, wakeIdempotencyKey, attemptId, attemptSequence),
        createdAt: claimNow,
      });
      return { createdActivityInserted, assignmentWakeProcessed: false, wakeClaim: { attemptId, attemptSequence } };
    });

    if (!claim.wakeClaim || !deps?.enqueueWakeup) {
      return {
        createdActivityInserted: claim.createdActivityInserted,
        assignmentWakeProcessed: claim.assignmentWakeProcessed,
      };
    }

    let wake: unknown | null = null;
    try {
      wake = await deps.enqueueWakeup(
        ownerAgentId,
        assignmentWakeOptions(review, evidence, wakeIdempotencyKey),
      );
    } catch (error) {
      await failAssignmentWakeClaim({
        review,
        evidence,
        ownerAgentId,
        wakeIdempotencyKey,
        attemptId: claim.wakeClaim.attemptId,
        attemptSequence: claim.wakeClaim.attemptSequence,
      });
      throw error;
    }

    const assignmentWakeProcessed = await completeAssignmentWakeClaim({
      review,
      evidence,
      ownerAgentId,
      wakeIdempotencyKey,
      attemptId: claim.wakeClaim.attemptId,
      attemptSequence: claim.wakeClaim.attemptSequence,
      wake,
    });

    return {
      createdActivityInserted: claim.createdActivityInserted,
      assignmentWakeProcessed,
    };
  }

  async function findOpenProductivityReviewEscalation(companyId: string, sourceIssueId: string) {
    return db
      .select({ id: issues.id })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, RECOVERY_ORIGIN_KINDS.productivityReviewEscalation),
          eq(issues.originId, sourceIssueId),
          isNull(issues.hiddenAt),
          notInArray(issues.status, ["done", "cancelled"]),
        ),
      )
      .orderBy(desc(issues.updatedAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function latestResolvedProductivityReviews(companyId: string, sourceIssueId: string, lookbackMs: number, now: Date) {
    const cutoff = new Date(now.getTime() - lookbackMs);
    return db
      .select({ id: issues.id, identifier: issues.identifier, status: issues.status, updatedAt: issues.updatedAt })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, PRODUCTIVITY_REVIEW_ORIGIN_KIND),
          eq(issues.originId, sourceIssueId),
          eq(issues.status, "done"),
          gt(issues.updatedAt, cutoff),
          isNull(issues.hiddenAt),
        ),
      )
      .orderBy(desc(issues.updatedAt))
      .limit(5);
  }

  // A gate only suppresses while it is still plausibly live. `deliberateFutureMonitor` gets this
  // for free (a monitor whose `nextCheckAt` has passed stops suppressing); approvals carry no
  // expiry column, so the bound is applied to the oldest pending linked approval. New pending
  // approvals do not reset the source issue's gate window while an older gate is still open.
  async function findOpenApprovalGate(
    companyId: string,
    issueId: string,
    now: Date,
    maxAgeMs: number,
  ) {
    const oldestAllowedCreatedAt = new Date(now.getTime() - maxAgeMs);
    const rows = await db
      .select({
        approvalId: approvals.id,
        approvalStatus: approvals.status,
        approvalType: approvals.type,
        approvalCreatedAt: approvals.createdAt,
      })
      .from(issueApprovals)
      .innerJoin(approvals, eq(issueApprovals.approvalId, approvals.id))
      .where(
        and(
          eq(issueApprovals.companyId, companyId),
          eq(issueApprovals.issueId, issueId),
          inArray(approvals.status, [...APPROVAL_GATE_SUPPRESSION_STATUSES]),
        ),
      )
      .orderBy(asc(approvals.createdAt), asc(approvals.id))
      .limit(1);
    const oldestPending = rows[0] ?? null;
    if (!oldestPending) return null;
    return oldestPending.approvalCreatedAt >= oldestAllowedCreatedAt ? oldestPending : null;
  }

  async function recordApprovalGatedSuppression(suppression: ApprovalGatedSuppression) {
    const details = {
      source: "productivity_review.reconcile",
      sourceIssueId: suppression.sourceIssue.id,
      trigger: suppression.trigger,
      suppressedBy: "approval_pending",
      approvalId: suppression.approvalGate.approvalId,
      approvalStatus: suppression.approvalGate.approvalStatus,
      approvalType: suppression.approvalGate.approvalType,
      elapsedMs: suppression.elapsedMs,
    };
    await logActivity(db, {
      companyId: suppression.sourceIssue.companyId,
      actorType: "system",
      actorId: "system",
      agentId: suppression.sourceIssue.assigneeAgentId,
      action: "issue.productivity_review_suppressed",
      entityType: "issue",
      entityId: suppression.sourceIssue.id,
      details,
    });
    logger.info(details, "productivity review long_active_duration suppressed by pending approval gate");
  }

  async function recordMonitorScheduledSuppression(suppression: MonitorScheduledSuppression) {
    const details = {
      source: "productivity_review.reconcile",
      sourceIssueId: suppression.sourceIssue.id,
      trigger: suppression.trigger,
      suppressedBy: "monitor_scheduled",
      monitorNextCheckAt: suppression.monitorNextCheckAt?.toISOString() ?? null,
      monitorScheduledBy: suppression.monitorScheduledBy,
      monitorWakeRequestedAt: suppression.monitorWakeRequestedAt?.toISOString() ?? null,
      monitorLastTriggeredAt: suppression.monitorLastTriggeredAt?.toISOString() ?? null,
      elapsedMs: suppression.elapsedMs,
    };
    await logActivity(db, {
      companyId: suppression.sourceIssue.companyId,
      actorType: "system",
      actorId: "system",
      agentId: suppression.sourceIssue.assigneeAgentId,
      action: "issue.productivity_review_suppressed",
      entityType: "issue",
      entityId: suppression.sourceIssue.id,
      details,
    });
    logger.info(details, "productivity review long_active_duration suppressed by scheduled monitor");
  }

  /**
   * BLO-20549: sweep already-open productivity reviews and retire the ones whose alarm no longer
   * stands. This is the only place that can retire them — the reconcile candidate query scans
   * `todo`/`in_progress` sources only, so once a source reaches a terminal status it drops out of
   * the loop and `evaluateSourceReviewability` never sees it again. A review created while its
   * source was still active would otherwise stay open forever, costing a manager run to triage.
   */
  async function closeOpenSuppressedReviews(now: Date, companyId?: string) {
    const reviewRows = await db
      .select()
      .from(issues)
      .where(
        and(
          companyId ? eq(issues.companyId, companyId) : undefined,
          eq(issues.originKind, PRODUCTIVITY_REVIEW_ORIGIN_KIND),
          isNull(issues.hiddenAt),
          notInArray(issues.status, ["done", "cancelled"]),
        ),
      )
      .orderBy(asc(issues.updatedAt), asc(issues.id))
      .limit(MAX_CANDIDATE_ISSUES);

    const sourceIssueIds = [
      ...new Set(reviewRows.map((review) => review.originId).filter((id): id is string => Boolean(id))),
    ];
    const sourceIssueById = new Map<string, IssueRow>();
    for (const chunk of sourceIssueIds.length > 0 ? [sourceIssueIds] : []) {
      const sourceRows = await db
        .select()
        .from(issues)
        .where(inArray(issues.id, chunk));
      for (const source of sourceRows) sourceIssueById.set(source.id, source);
    }

    const reviewTriggerById = new Map<string, unknown>();
    const reviewFiredTriggersById = new Map<string, unknown>();
    const reviewIds = reviewRows.map((review) => review.id);
    for (const chunk of reviewIds.length > 0 ? [reviewIds] : []) {
      const triggerRows = await db
        .select({ entityId: activityLog.entityId, details: activityLog.details })
        .from(activityLog)
        .where(
          and(
            companyId ? eq(activityLog.companyId, companyId) : undefined,
            eq(activityLog.entityType, "issue"),
            inArray(activityLog.entityId, chunk),
            inArray(activityLog.action, ["issue.productivity_review_created", "issue.productivity_review_updated"]),
          ),
        )
        .orderBy(desc(activityLog.createdAt), desc(activityLog.id));
      for (const row of triggerRows) {
        if (!reviewTriggerById.has(row.entityId)) {
          reviewTriggerById.set(row.entityId, row.details?.trigger);
          // Read from the same newest-activity row as `trigger`, inside the
          // same first-wins guard, so the primary and the set can never be
          // sourced from different generations of the same review.
          reviewFiredTriggersById.set(row.entityId, row.details?.firedTriggers);
        }
      }
    }

    let closedMonitorScheduled = 0;
    let closedTerminalSource = 0;
    let closedDependencyBlocked = 0;

    // BLO-22436: resolve blocker state for the sources whose open review a
    // blocker could retire, batched per company. Without this, a review minted
    // *before* a blocker was added is stranded open forever: generation now
    // skips blocked sources, and `createOrUpdateReview` is the only path that
    // refreshes an open review, so nothing ever revisits it. That strand lands
    // squarely on the loop this ticket closes — the documented remedy for a
    // flagged platform fault is to model it as a `blockedBy` edge, which would
    // otherwise freeze a review pointing at an assignee who provably cannot act.
    const dependencyBlockedSourceIssueIds = new Map<string, number>();
    const closableSourceIdsByCompany = new Map<string, Set<string>>();
    for (const review of reviewRows) {
      if (!review.originId) continue;
      if (!isDependencyBlockedClosableRecord(reviewTriggerById.get(review.id), reviewFiredTriggersById.get(review.id))) continue;
      const sourceIssue = sourceIssueById.get(review.originId);
      if (!sourceIssue || sourceIssue.companyId !== review.companyId) continue;
      const forCompany = closableSourceIdsByCompany.get(review.companyId) ?? new Set<string>();
      forCompany.add(sourceIssue.id);
      closableSourceIdsByCompany.set(review.companyId, forCompany);
    }
    for (const [closableCompanyId, sourceIds] of closableSourceIdsByCompany) {
      const readiness = await issuesSvc.listDependencyReadiness(closableCompanyId, [...sourceIds], db);
      for (const sourceId of sourceIds) {
        const unresolvedBlockerCount = readiness.get(sourceId)?.unresolvedBlockerCount ?? 0;
        if (unresolvedBlockerCount > 0) {
          dependencyBlockedSourceIssueIds.set(sourceId, unresolvedBlockerCount);
        }
      }
    }

    for (const review of reviewRows) {
      if (!review.originId) continue;
      const sourceIssue = sourceIssueById.get(review.originId) ?? null;
      if (!sourceIssue) continue;
      if (sourceIssue.companyId !== review.companyId) continue;
      const trigger = reviewTriggerById.get(review.id);

      let suppressedBy: "terminal_source" | "monitor_scheduled" | "dependency_blocked" | null = null;
      let suppressionDetails: Record<string, unknown> = {};
      // A `done` source can retire an already-open long-active review: the work
      // episode finished under the terminal-status evidence gate, so the
      // elapsed-time alarm no longer needs manager adjudication. This does not
      // extend to `cancelled`; an assignee can abandon and later restore their
      // own source issue, so cancellation must not retire its oversight
      // artifact. It also does not extend to historical/accountability triggers
      // (`no_comment_streak`, `high_churn`) or missing provenance: completion
      // does not invalidate those signals, and unknown trigger semantics fail
      // closed.
      if (trigger === "long_active_duration" && sourceIssue.status === "done") {
        suppressedBy = "terminal_source";
        suppressionDetails = { sourceStatus: sourceIssue.status };
      } else if (trigger === "long_active_duration" && !isTerminalIssueStatus(sourceIssue.status)) {
        // Deliberately monitor-only. An approval gate suppresses *new* reviews but never closes one
        // that already fired: the approval that would justify the close is creatable by the very
        // agent under review (`POST /companies/:companyId/approvals` resolves `requestedByAgentId`
        // from an agent actor and hard-codes `status: "pending"`), so honouring it here would let a
        // flagged agent retire its own oversight artifact. A monitor is set by the assignee or the
        // board through a server-owned column and self-expires, which is why it keeps this path.
        const monitor = strictFutureMonitor(sourceIssue, now);
        if (monitor) {
          suppressedBy = "monitor_scheduled";
          suppressionDetails = {
            monitorNextCheckAt: monitor.monitorNextCheckAt.toISOString(),
            monitorScheduledBy: monitor.monitorScheduledBy,
          };
        }
      }
      // `dependencyBlockedSourceIssueIds` is keyed by source issue id, not
      // review id, and is only populated from reviews whose trigger record
      // already passed `isDependencyBlockedClosableRecord` (above). Re-checking
      // it here too (Ally review, BLO-22436) makes this arm locally
      // correct on its own terms — today it's redundant only because
      // `issues_active_productivity_review_uq` guarantees at most one active
      // review per source, so a non-closable review can't share this
      // source's key with a closable one. A future widening of that index
      // must not silently start closing `high_churn`/`runtime_failure_streak`
      // reviews through this branch.
      if (
        !suppressedBy &&
        isDependencyBlockedClosableRecord(trigger, reviewFiredTriggersById.get(review.id)) &&
        dependencyBlockedSourceIssueIds.has(sourceIssue.id)
      ) {
        suppressedBy = "dependency_blocked";
        suppressionDetails = {
          sourceStatus: sourceIssue.status,
          unresolvedBlockerCount: dependencyBlockedSourceIssueIds.get(sourceIssue.id) ?? 0,
        };
      }
      if (!suppressedBy) continue;

      const closePredicates = [
        eq(issues.id, review.id),
        notInArray(issues.status, ["done", "cancelled"]),
      ];
      if (suppressedBy === "terminal_source") {
        closePredicates.push(sql`exists (
          select 1
          from issues source_issue
          where source_issue.id = ${sourceIssue.id}
            and source_issue.company_id = ${review.companyId}
            and source_issue.status = 'done'
        )`);
      }
      if (suppressedBy === "dependency_blocked") {
        // Re-check the blocker edge at write time so a blocker that resolved
        // between the batched read above and this UPDATE cannot retire a review
        // that is valid again. This mirrors the primary unresolved clause in
        // `listIssueDependencyReadinessMap` (an explicit `blocks` edge whose
        // blocker is not `done`) and deliberately omits its workspace-finalize
        // subcase, making the predicate strictly narrower than the batched read:
        // a source blocked *only* by a pending finalize simply is not closed
        // here. That fails closed — the review stays open, and once the finalize
        // barrier clears the source leaves the exempt set and
        // `createOrUpdateReview` refreshes or retires it on the normal path.
        closePredicates.push(sql`exists (
          select 1
          from issue_relations blocker_rel
          join issues blocker_issue on blocker_issue.id = blocker_rel.issue_id
          where blocker_rel.related_issue_id = ${sourceIssue.id}
            and blocker_rel.company_id = ${review.companyId}
            and blocker_rel.type = 'blocks'
            and blocker_issue.status <> 'done'
        )`);
      }
      const closed = await db
        .update(issues)
        .set({ status: "done", completedAt: now, updatedAt: now })
        .where(and(...closePredicates))
        .returning({ id: issues.id });
      if (closed.length === 0) continue;

      await logActivity(db, {
        companyId: review.companyId,
        actorType: "system",
        actorId: "system",
        action: "issue.productivity_review_suppressed_open_review_closed",
        entityType: "issue",
        entityId: review.id,
        agentId: review.assigneeAgentId,
        details: {
          source: "productivity_review.reconcile",
          sourceIssueId: sourceIssue.id,
          trigger: trigger ?? null,
          suppressedBy,
          ...suppressionDetails,
        },
      });
      if (suppressedBy === "terminal_source") closedTerminalSource += 1;
      else if (suppressedBy === "dependency_blocked") closedDependencyBlocked += 1;
      else closedMonitorScheduled += 1;
    }
    return {
      monitorScheduled: closedMonitorScheduled,
      terminalSource: closedTerminalSource,
      dependencyBlocked: closedDependencyBlocked,
    };
  }

  async function monitorBacklogGraceMs(
    sourceIssue: IssueRow,
    now: Date,
    thresholds: ProductivityReviewThresholds,
    dbClient: DbOrTx = db,
  ) {
    const monitorNextCheckAt = coerceDate(sourceIssue.monitorNextCheckAt);
    if (!monitorNextCheckAt || monitorNextCheckAt.getTime() > now.getTime()) return 0;
    if (!isMonitorSuppressionActor(sourceIssue.monitorScheduledBy)) return 0;
    if (!issueCanReceiveMonitorDispatch(sourceIssue)) return 0;

    const staleClaimThreshold = new Date(now.getTime() - ISSUE_MONITOR_WAKE_CLAIM_TTL_MS);
    const staleClaimCutoff = staleClaimThreshold.toISOString();
    const precedesSource = or(
      lt(issues.monitorNextCheckAt, monitorNextCheckAt),
      and(
        eq(issues.monitorNextCheckAt, monitorNextCheckAt),
        lt(issues.updatedAt, sourceIssue.updatedAt),
      ),
      and(
        eq(issues.monitorNextCheckAt, monitorNextCheckAt),
        eq(issues.updatedAt, sourceIssue.updatedAt),
        lt(issues.id, sourceIssue.id),
      ),
    );
    const queueFilter = and(
      eq(companies.status, "active"),
      sql`${issues.monitorNextCheckAt} is not null`,
      lte(issues.monitorNextCheckAt, now),
      or(
        precedesSource,
        and(
          sql`${issues.id} <> ${sourceIssue.id}`,
          eq(issues.monitorNextCheckAt, monitorNextCheckAt),
          gte(issues.monitorWakeRequestedAt, staleClaimThreshold),
        ),
        and(
          eq(issues.id, sourceIssue.id),
          or(
            isNull(issues.monitorWakeRequestedAt),
            lt(issues.monitorWakeRequestedAt, staleClaimThreshold),
          ),
        ),
      ),
      isNull(issues.assigneeUserId),
      sql`${issues.assigneeAgentId} is not null`,
      inArray(issues.status, ["in_progress", "in_review"]),
    );
    const queueState = await dbClient
      .select({
        duePosition: sql<number>`count(*)::int`,
        latestFreshPredecessorClaimedAt: sql<Date | null>`
          max(${issues.monitorWakeRequestedAt}) filter (
            where ${issues.id} <> ${sourceIssue.id}
              and ${issues.monitorWakeRequestedAt} >= ${staleClaimCutoff}::timestamptz
          )
        `,
      })
      .from(issues)
      .innerJoin(companies, eq(companies.id, issues.companyId))
      .where(queueFilter)
      .then((rows) => rows[0] ?? null);
    const duePosition = Number(queueState?.duePosition ?? 0);
    if (duePosition <= 0) return 0;
    if (duePosition === 1) return 0;

    const dispatchTicks = Math.max(1, Math.ceil(duePosition / thresholds.monitorDispatchBatchSize));
    const dispatchDeadlineMs =
      dispatchTicks * thresholds.monitorSchedulerIntervalMs + ISSUE_MONITOR_WAKE_CLAIM_TTL_MS;
    const latestFreshPredecessorClaimedAt = coerceDate(queueState?.latestFreshPredecessorClaimedAt);
    // Fresh predecessor claims can prove a real dispatch is still in service, but later reclaims
    // must not keep extending this source's suppression window indefinitely.
    const freshClaimDeadlineCapMs = dispatchDeadlineMs + ISSUE_MONITOR_WAKE_CLAIM_TTL_MS;
    const freshPredecessorDeadlineMs = latestFreshPredecessorClaimedAt
      ? Math.min(
        latestFreshPredecessorClaimedAt.getTime() - monitorNextCheckAt.getTime() + ISSUE_MONITOR_WAKE_CLAIM_TTL_MS,
        freshClaimDeadlineCapMs,
      )
      : 0;
    return Math.max(dispatchDeadlineMs, freshPredecessorDeadlineMs);
  }

  async function currentPendingMonitorForReviewSuppression(
    sourceIssue: IssueRow,
    now: Date,
    thresholds: ProductivityReviewThresholds,
    dbClient: DbOrTx = db,
    opts?: { lockSource?: boolean; runBacklogHook?: boolean },
  ) {
    const currentIssue = await getCurrentIssue(sourceIssue, dbClient, { forUpdate: opts?.lockSource });
    if (!currentIssue || !issueCanReceiveMonitorDispatch(currentIssue)) return null;

    const direct = deliberatePendingMonitor(currentIssue, now, thresholds);
    if (direct) return direct;

    if (opts?.runBacklogHook !== false) {
      await deps?.beforeMonitorBacklogGrace?.(currentIssue);
    }
    const backlogGraceMs = await monitorBacklogGraceMs(currentIssue, now, thresholds, dbClient);
    const latestIssue = await getCurrentIssue(sourceIssue, dbClient);
    if (!latestIssue || !issueCanReceiveMonitorDispatch(latestIssue)) return null;

    const latestDirect = deliberatePendingMonitor(latestIssue, now, thresholds);
    if (latestDirect) return latestDirect;

    return deliberatePendingMonitor(
      latestIssue,
      now,
      thresholds,
      backlogGraceMs,
    );
  }

  async function countIssueRunsSince(companyId: string, agentId: string, issueId: string, since: Date) {
    return db
      .select({ count: sql<number>`count(*)::int` })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          eq(heartbeatRuns.agentId, agentId),
          issueRunScopeSql(issueId),
          sql`coalesce(${heartbeatRuns.startedAt}, ${heartbeatRuns.createdAt}) >= ${since.toISOString()}::timestamptz`,
        ),
      )
      .then((rows) => rows[0]?.count ?? 0);
  }

  async function countIssueCommentsSince(companyId: string, issueId: string, agentId: string, since?: Date) {
    return db
      .select({ count: sql<number>`count(*)::int` })
      .from(issueComments)
      .innerJoin(heartbeatRuns, eq(heartbeatRuns.id, issueComments.createdByRunId))
      .where(
        and(
          eq(issueComments.companyId, companyId),
          eq(issueComments.issueId, issueId),
          eq(issueComments.authorAgentId, agentId),
          eq(heartbeatRuns.companyId, companyId),
          eq(heartbeatRuns.agentId, agentId),
          issueRunScopeSql(issueId),
          since ? sql`${issueComments.createdAt} >= ${since.toISOString()}::timestamptz` : undefined,
        ),
      )
      .then((rows) => rows[0]?.count ?? 0);
  }

  async function findCommentNextAction(
    sourceIssue: IssueRow,
    sourceAgent: AgentRow,
    thresholds: ProductivityReviewThresholds,
    now: Date,
  ) {
    const lookbackStart = new Date(now.getTime() - thresholds.longActiveMs);
    const rows = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(
        and(
          eq(issueComments.companyId, sourceIssue.companyId),
          eq(issueComments.issueId, sourceIssue.id),
          eq(issueComments.authorAgentId, sourceAgent.id),
          sql`${issueComments.createdAt} >= ${lookbackStart.toISOString()}::timestamptz`,
          sql`${issueComments.body} ~* ${NEXT_ACTION_COMMENT_CANDIDATE_PATTERN}`,
        ),
      )
      .orderBy(desc(issueComments.createdAt), desc(issueComments.id))
      .limit(MAX_NEXT_ACTION_COMMENT_CANDIDATES);

    return rows
      .map((comment) => extractNextActionFromText(comment.body))
      .find((line): line is string => Boolean(line)) ?? null;
  }

  async function collectEvidence(
    sourceIssue: IssueRow,
    sourceAgent: AgentRow,
    thresholds: ProductivityReviewThresholds,
    now: Date,
  ): Promise<ProductivityReviewEvidence | MonitorScheduledSuppression | ApprovalGatedSuppression | null> {
    // The dependency-blocked exemption (BLO-22436) deliberately does NOT live
    // here. `collectEvidence` has two callers with opposite needs: review
    // *generation* must exempt blocked issues, while
    // `isProductivityReviewContinuationHoldActive` must not — it maps a `null`
    // return to `held: false`, so gating here would silently release an active
    // soft-stop continuation hold the moment a blocker edge was added. See
    // `dependencyBlockedSourceIssueIds` in `reconcileProductivityReviews`.
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    const sixHoursAgo = new Date(now.getTime() - 6 * 60 * 60 * 1000);

    const latestRuns = await db
      .select()
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, sourceIssue.companyId),
          eq(heartbeatRuns.agentId, sourceAgent.id),
          issueRunScopeSql(sourceIssue.id),
        ),
      )
      .orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id))
      .limit(MAX_RUNS_FOR_STREAK);

    const runIds = latestRuns.map((run) => run.id);
    const commentRunIds = new Set<string>();
    if (runIds.length > 0) {
      const commentRows = await db
        .select({ createdByRunId: issueComments.createdByRunId })
        .from(issueComments)
        .where(
          and(
            eq(issueComments.companyId, sourceIssue.companyId),
            eq(issueComments.issueId, sourceIssue.id),
            inArray(issueComments.createdByRunId, runIds),
          ),
        );
      for (const row of commentRows) {
        if (row.createdByRunId) commentRunIds.add(row.createdByRunId);
      }
    }

    const terminalRuns = latestRuns.filter((run) =>
      TERMINAL_RUN_STATUSES.includes(run.status as (typeof TERMINAL_RUN_STATUSES)[number]),
    );

    // BLO-21769: a run that never executed a model turn (see
    // `isInfraFailureRun`) is infrastructure telemetry, not agent behaviour.
    // It must not extend `noCommentStreak` — the agent was never given a
    // chance to comment — so it is filtered out of the walk entirely rather
    // than counted as silence or treated as a streak-breaker. This streak is
    // deliberately scoped to `isInfraFailureRun` and excludes dependency-gate
    // cancellations (BLO-22436): those are a graph-state fact, not an
    // infrastructure fault, and must not surface as one via
    // `runtime_failure_streak`.
    //
    // Dependency-gate cancellations are *transparent* to this walk rather than
    // streak-breakers, symmetrically with `noCommentStreak` below. Breaking here
    // would assert "the runtime was healthy at this point", which a cancelled-
    // before-dispatch run is no evidence for — nothing was attempted. It also
    // matters concretely: BLO-20815's history is genuine infra failures with
    // newer dependency-gate cancellations layered on top, and breaking the walk
    // would mask the real infra streak behind them exactly when a platform
    // owner needs to see it.
    const infraCandidateRuns = terminalRuns.filter((run) => !isDependencyBlockedRun(run));
    let runtimeFailureStreak = 0;
    let runtimeFailureSawMeasuredZero = false;
    let runtimeFailureSawInferred = false;
    for (const run of infraCandidateRuns) {
      if (!isInfraFailureRun(run)) break;
      runtimeFailureStreak += 1;
      if (run.usageJson == null) {
        runtimeFailureSawInferred = true;
      } else {
        runtimeFailureSawMeasuredZero = true;
      }
    }
    const runtimeFailureUsageBasis: ProductivityReviewEvidence["runtimeFailureUsageBasis"] =
      runtimeFailureStreak === 0
        ? null
        : runtimeFailureSawMeasuredZero && runtimeFailureSawInferred
          ? "mixed"
          : runtimeFailureSawInferred
            ? "inferred"
            : "measured";
    const executedTerminalRuns = terminalRuns.filter((run) => !isNeverExecutedRun(run));
    // BLO-26165: a run whose adapter container was never created had nothing
    // capable of writing a comment, so counting it as silence misattributes an
    // infrastructure fact to the assignee. Excluded here rather than folded
    // into `isNeverExecutedRun` because that predicate needs
    // `livenessState === "failed"`, and a pre-adapter setup failure never gets
    // classified at all.
    //
    // Keyed on `isNeverInvokedRun` (absence of run telemetry), NOT on
    // `issueCommentStatus`. The latter conflates invocation with comment
    // policy: `finalizeIssueCommentPolicy` stamps `not_applicable` on runs that
    // executed fine but whose wake reason was outside the four-reason
    // comment-required whitelist, or that had a deferred comment wake pending.
    // Excluding on the column therefore blinded the detector to silence on
    // almost every wake reason — the exact inverse of the false positive this
    // issue was opened for. See `isNeverInvokedRun`.
    const neverInvokedRunCount = terminalRuns.filter(isNeverInvokedRun).length;
    const noCommentEligibleRuns = executedTerminalRuns.filter((run) => !isNeverInvokedRun(run));
    // Of the runs actually eligible for the streak walk, how many carry the
    // comment-policy-exempt status. Scoped to the eligible population (not all
    // terminal runs) so the "DID execute" claim is literally true of every run
    // counted — an infra-failure run with `livenessState: "failed"` and zero
    // tokens also carries this status, but it did not execute a turn and is
    // already excluded via `isNeverExecutedRun`, so folding it in here would
    // repeat the mislabelling this narrowing exists to fix.
    //
    // Reported, NOT excluded: a run that executed and stayed silent is assignee
    // silence regardless of whether policy demanded a comment. This is also
    // what keeps the `hasDeferredIssueCommentWake` path from masking a streak —
    // a chain of deferred-wake runs that never comments stays visible.
    const commentExemptExecutedRunCount = noCommentEligibleRuns.filter(
      (run) => run.issueCommentStatus === COMMENT_POLICY_EXEMPT_ISSUE_COMMENT_STATUS,
    ).length;
    let noCommentStreak = 0;
    for (const run of noCommentEligibleRuns) {
      if (commentRunIds.has(run.id)) break;
      noCommentStreak += 1;
    }
    // BLO-22436: every run in the sample window that could not possibly have
    // produced a comment (infra failure OR dependency-gate cancellation),
    // reported as a count + dominant errorCode so a reviewing manager doesn't
    // have to re-derive dispatch health from raw run telemetry.
    const nonExecutingRuns = terminalRuns.filter((run) => isNeverExecutedRun(run));
    const nonExecutingRunCount = nonExecutingRuns.length;
    const nonExecutingDominantErrorCode = dominantErrorCode(nonExecutingRuns);
    const nonExecutingAlsoNeverInvokedCount = nonExecutingRuns.filter(isNeverInvokedRun).length;

    const pullRequestFreshCutoff = new Date(now.getTime() - PRODUCTIVITY_REVIEW_PR_FRESH_MS);
    const pullRequestEvidenceSelect = {
      title: issueWorkProducts.title,
      url: issueWorkProducts.url,
      status: issueWorkProducts.status,
      externalId: issueWorkProducts.externalId,
      updatedAt: issueWorkProducts.updatedAt,
      sourceEventTimestampMs: sql<string | number | null>`case
        when ${issueWorkProducts.metadata}->>'sourceEventTimestampMs' ~ '^[0-9]+$'
          then (${issueWorkProducts.metadata}->>'sourceEventTimestampMs')::bigint
        else null
      end`,
    };
    const trustedPullRequestEvidenceWhere = and(
      eq(issueWorkProducts.companyId, sourceIssue.companyId),
      eq(issueWorkProducts.issueId, sourceIssue.id),
      eq(issueWorkProducts.provider, "github"),
      eq(issueWorkProducts.type, "pull_request"),
      isNotNull(issueWorkProducts.externalId),
      isNotNull(issueWorkProducts.url),
      sql`${issueWorkProducts.metadata}->>'source' = ${PRODUCTIVITY_REVIEW_WEBHOOK_PR_METADATA_SOURCE}`,
      sql`${issueWorkProducts.sourceTrust}->>'promotedByActorType' = 'system'`,
      sql`${issueWorkProducts.sourceTrust}->>'promotedByActorId' = ${PULL_REQUEST_WORK_PRODUCT_SOURCE_TRUST_ACTOR_ID}`,
    );

    const [
      runCountLastHour,
      runCountLastSixHours,
      assigneeRunCommentCount,
      assigneeRunCommentCountLastHour,
      assigneeRunCommentCountLastSixHours,
      latestComments,
      mostRecentDispatchAt,
      costRow,
      latestPullRequestRow,
      progressPullRequestRow,
    ] = await Promise.all([
      countIssueRunsSince(sourceIssue.companyId, sourceAgent.id, sourceIssue.id, oneHourAgo),
      countIssueRunsSince(sourceIssue.companyId, sourceAgent.id, sourceIssue.id, sixHoursAgo),
      countIssueCommentsSince(sourceIssue.companyId, sourceIssue.id, sourceAgent.id),
      countIssueCommentsSince(sourceIssue.companyId, sourceIssue.id, sourceAgent.id, oneHourAgo),
      countIssueCommentsSince(sourceIssue.companyId, sourceIssue.id, sourceAgent.id, sixHoursAgo),
      db
        .select({ comment: issueComments })
        .from(issueComments)
        .innerJoin(heartbeatRuns, eq(heartbeatRuns.id, issueComments.createdByRunId))
        .where(
          and(
            eq(issueComments.companyId, sourceIssue.companyId),
            eq(issueComments.issueId, sourceIssue.id),
            eq(issueComments.authorAgentId, sourceAgent.id),
            eq(heartbeatRuns.companyId, sourceIssue.companyId),
            eq(heartbeatRuns.agentId, sourceAgent.id),
            issueRunScopeSql(sourceIssue.id),
          ),
        )
        .orderBy(desc(issueComments.createdAt), desc(issueComments.id))
        .limit(5)
        .then((rows) => rows.map((row) => row.comment)),
      // BLO-19604: `latestRuns` is ordered by `createdAt`, not `startedAt` — a run created
      // earlier can be dispatched later than a run created after it, so scanning that array
      // for the first `startedAt` can pick a stale dispatch timestamp (or, once more than
      // `MAX_RUNS_FOR_STREAK` runs exist, miss the true most-recent dispatch entirely because
      // it fell outside the createdAt-ordered sample). Query `max(startedAt)` directly instead.
      db
        .select({ mostRecentDispatchAt: sql<Date | null>`max(${heartbeatRuns.startedAt})` })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.companyId, sourceIssue.companyId),
            eq(heartbeatRuns.agentId, sourceAgent.id),
            issueRunScopeSql(sourceIssue.id),
          ),
        )
        .then((rows) => coerceDate(rows[0]?.mostRecentDispatchAt)),
      db
        .select({ costCents: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int` })
        .from(costEvents)
        .where(and(eq(costEvents.companyId, sourceIssue.companyId), eq(costEvents.issueId, sourceIssue.id)))
        .then((rows) => rows[0] ?? { costCents: 0 }),
      // BLO-19566 AC4: newest PR linked to this issue. Written by the GitHub
      // webhook on every pull_request event.
      //
      // Ordered and aged by the *GitHub* event time, not `updatedAt`. The row's
      // `updatedAt` is DB receipt time, so a first delivery that arrives late
      // (retry, backfill, outage drain) inserts with `updatedAt = now` and would
      // advertise an already-stale PR as fresh progress for another day. Falls
      // back to `updatedAt` only for rows with no recorded source timestamp.
      db
        .select(pullRequestEvidenceSelect)
        .from(issueWorkProducts)
        .where(trustedPullRequestEvidenceWhere)
        .orderBy(desc(pullRequestEffectiveEventAtSql))
        .limit(1)
        .then((rows) => rows[0] ?? null),
      // The verdict criterion is satisfied by any fresh progress-eligible PR,
      // not necessarily the newest PR overall. A newer closed-unmerged PR must
      // not hide an older open/draft/merged PR that is still fresh.
      db
        .select(pullRequestEvidenceSelect)
        .from(issueWorkProducts)
        .where(
          and(
            trustedPullRequestEvidenceWhere,
            inArray(issueWorkProducts.status, [...PRODUCTIVITY_REVIEW_PROGRESS_PR_STATUS_VALUES]),
            sql`${pullRequestEffectiveEventAtSql} >= ${pullRequestFreshCutoff.toISOString()}::timestamptz`,
          ),
        )
        .orderBy(desc(pullRequestEffectiveEventAtSql))
        .limit(1)
        .then((rows) => rows[0] ?? null),
    ]);

    const activeRunCount = latestRuns.filter((run) =>
      ACTIVE_RUN_STATUSES.includes(run.status as (typeof ACTIVE_RUN_STATUSES)[number]),
    ).length;
    // BLO-19604: a run stuck in `queued` never reaches `startedAt`, so it must not anchor
    // the episode. `mostRecentDispatchAt` is a direct `max(startedAt)` over every run
    // touching this issue (queried above, not derived from the createdAt-ordered
    // `latestRuns` sample) — that is real evidence the agent was working, unlike a
    // queued-but-unclaimed row.
    //
    // BLO-22016 (BLO-18846 / run `9e49405e`, ~17.75h queued with zero tokens executed): a
    // dispatch is only evidence for the *current* episode if it happened at or after the
    // current checkout. But the checkout-time fallback is not simply wrong to keep in all
    // cases — an issue that never even got a run *at all* (no monitor armed, dispatcher
    // never acted) is exactly the "unattended episode" scenario the monitor-gating tests
    // below (BLO-19067/BLO-21003) intentionally still want to catch as wall-clock
    // unattended time, and a live/terminal execution holder pinned via `executionRunId`
    // (BLO-19848) never populates `startedAt` at all — that liveness is tracked instead via
    // `lastOutputAt`/`lastUsefulActionAt`/status and clamped below by
    // `nonLiveExecutionHoldSince`, so it must keep anchoring on `issueEpisodeStartedAt` too.
    // The one case that must return `null` instead of falling back to checkout time is
    // narrower: the issue's *current* execution holder (`sourceIssue.executionRunId`,
    // fetched below as `executionRun`) is itself still `queued` and has never started. That
    // is real, specific evidence the system tried to dispatch and is stuck — a dispatch-lag
    // problem (BLO-21116 et al.), not a long-active-episode problem; the
    // `queuedUndispatchedRunCount` evidence field further down is where that gets surfaced
    // instead of silently inflating this trigger. `elapsedMs` below already treats a null
    // `activeStartedAt` as "no episode to measure," which withholds `long_active_duration`
    // without touching `no_comment_streak`/`high_churn`.
    const issueEpisodeStartedAt = sourceIssue.startedAt ?? sourceIssue.executionLockedAt ?? null;
    // BLO-19848: clamp the episode end to the last moment execution was
    // attributable to a live run, so a wedged holder cannot accrue "active"
    // time on work that already finished. See nonLiveExecutionHoldSince.
    const executionRun = sourceIssue.executionRunId
      ? await db
          .select()
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, sourceIssue.executionRunId))
          .limit(1)
          .then((rows) => rows[0] ?? null)
      : null;
    const currentHolderNeverDispatched = executionRun?.status === "queued" && !executionRun.startedAt;
    const activeStartedAt =
      mostRecentDispatchAt &&
      (!issueEpisodeStartedAt || mostRecentDispatchAt.getTime() >= issueEpisodeStartedAt.getTime())
        ? mostRecentDispatchAt
        : currentHolderNeverDispatched
          ? null
          : issueEpisodeStartedAt;
    const nonLiveHoldSince = nonLiveExecutionHoldSince(sourceIssue, executionRun, now);
    // Clamping below activeStartedAt collapses to 0 via Math.max — i.e. a holder
    // that went non-live before the episode began contributes no active time.
    const attributableEndAt = nonLiveHoldSince ?? now;
    // BLO-19848 (review follow-up): the tail clamp above is not enough on its
    // own, because it only truncates a hold that is *still* open. A holder that
    // parked and then resumed is live again, so nonLiveExecutionHoldSince
    // correctly returns null — and the whole parked interval silently reverts to
    // being counted, since elapsed is measured from activeStartedAt. A 6h50m
    // park followed by a 10m run still reported 7h and still fired the trigger.
    // Exclude the park from the front of the episode too. See
    // liveSegmentStartedAt.
    const liveSegmentStart = liveSegmentStartedAt(executionRun, now);
    const attributableStartAt = activeStartedAt
      && liveSegmentStart
      && liveSegmentStart.getTime() > activeStartedAt.getTime()
      ? liveSegmentStart
      : activeStartedAt;
    const elapsedMs = sourceIssue.status === "in_progress" && attributableStartAt
      ? Math.max(0, attributableEndAt.getTime() - attributableStartAt.getTime())
      : null;
    // Total wall-clock withheld from the trigger: the leading park plus the
    // trailing non-live hold. Bounded by the episode so the two exclusions
    // cannot report more than the episode actually spans.
    const leadingParkMs = activeStartedAt && attributableStartAt
      ? Math.max(0, attributableStartAt.getTime() - activeStartedAt.getTime())
      : 0;
    const trailingHoldMs = Math.max(0, now.getTime() - attributableEndAt.getTime());
    const episodeMs = activeStartedAt
      ? Math.max(0, now.getTime() - activeStartedAt.getTime())
      : null;
    const nonLiveHoldMs = episodeMs === null
      ? trailingHoldMs
      : Math.min(episodeMs, leadingParkMs + trailingHoldMs);

    const latestPullRequest = toPullRequestEvidence(progressPullRequestRow ?? latestPullRequestRow, now);
    // BLO-23248/BLO-23624: the portion of elapsedMs attributable to a
    // no-executable-turn run anywhere in the episode (not just the current
    // one), reported as its own evidence bucket distinct from
    // monitor-gated/unattended (BLO-22331). Segments are clamped inside
    // `noExecutableTurnBreakdown` to [attributableStartAt, attributableEndAt),
    // so a retry/backlog chain that outlives this episode cannot report more
    // no-executable-turn time than the episode actually spans.
    const noExecutableTurnGating = attributableStartAt && elapsedMs !== null
      ? noExecutableTurnBreakdown(latestRuns, attributableStartAt, attributableEndAt, now)
      : null;
    const noExecutableTurnDominant = Boolean(
      noExecutableTurnGating
        && elapsedMs !== null
        && elapsedMs > 0
        && noExecutableTurnGating.noExecutableTurnMs / elapsedMs > NO_EXECUTABLE_TURN_DOMINANT_SHARE,
    );
    // Only suppress while the run currently heading the episode is still
    // actually blocked (`currentBlockOpen`) — e.g. a capacity retry genuinely
    // still backing off, or a dispatch-backlog run still sitting `queued`.
    // Per BLO-22331 AC, this must not become indefinite: once a capacity
    // retry's due time passes and it sits unpromoted, that is itself the
    // wedged-retry-chain signal the detector should surface (see BLO-22094's
    // overdue-scheduled-retry gauge for the fleet-level view) — so
    // `longActive` is allowed to fire again, with the evidence block and
    // trigger-reason qualifier below naming the mechanism mix explicitly
    // rather than leaving the primary-trigger line reading as pure assignee
    // inactivity.
    const noExecutableTurnDominantAndOpen = noExecutableTurnDominant && Boolean(noExecutableTurnGating?.currentBlockOpen);

    const noComment = noCommentStreak >= thresholds.noCommentStreakRuns;
    // Reuses `noCommentStreakRuns` as the sample-size threshold: both streaks
    // ask "how many consecutive terminal runs is suspicious", just over
    // disjoint filters (turn-executing vs never-executed). A separate config
    // knob would be redundant surface for the same question.
    const runtimeFailure = runtimeFailureStreak >= thresholds.noCommentStreakRuns;
    // BLO-23248/BLO-23624: while the dominant share of the episode is
    // no-executable-turn time AND the current block is still open (fleet
    // model-provider exhaustion, dispatch backlog, or a zero-token throttle
    // the assignee cannot act on), long_active_duration does not fire —
    // mirrors how a pending monitor/approval gate suppresses this same
    // trigger below, just folded into the boolean rather than a parallel gate
    // object, since (like those gates) this only ever affects
    // `long_active_duration` specifically and never the other triggers.
    //
    // BLO-25877: deliberately raw `elapsedMs` here, not the monitor-gated split.
    // Trigger selection (and therefore every other trigger's suppression
    // bookkeeping) must stay exactly as it was — the monitor-gated subtraction
    // below is an *additional*, later gate on whether a `long_active_duration`
    // review actually gets created, not a change to what counts as long-active
    // in the first place. Folding the subtraction in here made the predicate
    // itself go false for issues whose monitor is still safely inside
    // `currentPendingMonitorForReviewSuppression`'s grace/backlog window — that
    // bypassed the suppression bookkeeping (and its `monitorScheduledSuppressed`
    // accounting) for dozens of already-covered backlog-grace scenarios instead
    // of just narrowing the small genuinely-new case this issue targets.
    const longActive =
      elapsedMs !== null && elapsedMs >= thresholds.longActiveMs && !noExecutableTurnDominantAndOpen;
    const highChurn =
      runCountLastHour >= thresholds.highChurnHourly ||
      assigneeRunCommentCountLastHour >= thresholds.highChurnHourly ||
      runCountLastSixHours >= thresholds.highChurnSixHours ||
      assigneeRunCommentCountLastSixHours >= thresholds.highChurnSixHours;
    const trigger = choosePrimaryTrigger({ runtimeFailure, noComment, longActive, highChurn });
    if (!trigger) return null;

    // BLO-22436 (Ally follow-up): recorded in `choosePrimaryTrigger`'s ladder
    // order so `firedTriggers[0] === trigger` always holds. Built from the same
    // four booleans the ladder reads, rather than re-deriving the predicates,
    // so the set cannot drift from the primary it is supposed to contain.
    const firedTriggers: ProductivityReviewTrigger[] = [];
    if (runtimeFailure) firedTriggers.push("runtime_failure_streak");
    if (noComment) firedTriggers.push("no_comment_streak");
    if (highChurn) firedTriggers.push("high_churn");
    if (longActive) firedTriggers.push("long_active_duration");

    const triggerReasons: string[] = [];
    if (runtimeFailure) {
      triggerReasons.push(formatRuntimeFailureTriggerClaim(runtimeFailureStreak, runtimeFailureUsageBasis));
    }
    if (noComment) {
      const neverInvokedNote = neverInvokedRunCount > 0
        ? ` (${neverInvokedRunCount} additional run(s) in the sampled window never had an adapter created and are excluded, not counted toward this streak)`
        : "";
      triggerReasons.push(`${noCommentStreak} consecutive terminal, turn-executing issue-linked runs had no run-created issue comment${neverInvokedNote}`);
    }
    if (longActive) {
      // BLO-23624: this only fires while no-executable-turn-dominant when the
      // current block is no longer open (`noExecutableTurnDominantAndOpen`
      // already excluded the still-open case above) — most commonly a stuck,
      // overdue retry chain the assignee still cannot act on — so name the
      // cause explicitly rather than reading as assignee inactivity.
      const noExecutableTurnNote = noExecutableTurnDominant && noExecutableTurnGating
        ? formatNoExecutableTurnTriggerNote(noExecutableTurnGating)
        : "";
      triggerReasons.push(`current active episode has lasted ${msToHuman(elapsedMs)}${noExecutableTurnNote}`);
    }
    if (highChurn) {
      triggerReasons.push(
        `${runCountLastHour} runs/${assigneeRunCommentCountLastHour} assignee-run comments in 1h; ${runCountLastSixHours} runs/${assigneeRunCommentCountLastSixHours} assignee-run comments in 6h`,
      );
    }

    const routineOnlySamplingWindow = latestRuns.length > 0 && latestRuns.every(isRoutineOriginRun);

    // Only `long_active_duration` is suppressible by a human gate. `no_comment_streak` and
    // `high_churn` stay live: an agent burning runs against a gate it cannot clear is exactly
    // the waste worth reviewing, and a gate does not excuse silent runs.
    //
    // The suppression is deliberately bounded and forward-only: it lapses once the approval ages
    // past `approvalGateMaxAgeMs`, and it never closes a review that already fired (see
    // `closeOpenSuppressedReviews`). Both limits exist because the reviewed agent can
    // create the approval itself, so the gate delays oversight at most one window and cannot
    // erase it.
    if (trigger === "long_active_duration") {
      const approvalGate = await findOpenApprovalGate(
        sourceIssue.companyId,
        sourceIssue.id,
        now,
        thresholds.approvalGateMaxAgeMs,
      );
      if (approvalGate) {
        return {
          trigger,
          firedTriggers,
          triggerReasons,
          sourceIssue,
          sourceAgent,
          elapsedMs,
          approvalGate,
          thresholds,
          generatedAt: now,
        };
      }
    }

    const monitor =
      trigger === "long_active_duration"
        ? await currentPendingMonitorForReviewSuppression(sourceIssue, now, thresholds)
        : null;
    if (trigger === "long_active_duration" && monitor) {
      return {
        trigger,
        firedTriggers,
        triggerReasons,
        sourceIssue,
        sourceAgent,
        elapsedMs,
        monitorNextCheckAt: monitor.monitorNextCheckAt,
        monitorScheduledBy: monitor.monitorScheduledBy,
        monitorWakeRequestedAt: monitor.monitorWakeRequestedAt,
        monitorLastTriggeredAt: monitor.monitorLastTriggeredAt,
        thresholds,
        generatedAt: now,
      };
    }

    // BLO-25877: computed once here — after both suppression gates above have had
    // their chance to hold this review back — and reused as-is for the report-text
    // field further down, rather than recomputed there.
    const monitorGating = monitorGatingBreakdown(sourceIssue, attributableStartAt, elapsedMs, now, latestRuns);
    // Neither suppression gate above catches every "monitor accounted for most of
    // this episode" case: `currentPendingMonitorForReviewSuppression` only covers a
    // monitor that is still armed or within its lapse grace, not one that lapsed a
    // long time ago and was never re-armed. For that remaining case, only the
    // *measured* gated component (`gatedIsUpperBound === false`) is safe to subtract
    // from the elapsed time before comparing to the threshold — the still-armed
    // branch reports `gatedMs: elapsedMs` as a deliberate upper bound (no column
    // records monitor arm time), so treating its `unattendedMs: 0` as authoritative
    // would make `long_active_duration` structurally unfireable for any issue with a
    // monitor armed however briefly, which is the indefinite-suppression hazard
    // BLO-22331 AC2 forbids — and that branch is already fully suppressed above
    // anyway, so it never reaches this check with anything but `gatedIsUpperBound:
    // true`. Checked here rather than folded into `longActive` above so trigger
    // selection and the other three triggers' suppression bookkeeping are
    // unaffected — see the comment on `longActive`.
    if (
      trigger === "long_active_duration" &&
      monitorGating &&
      !monitorGating.gatedIsUpperBound &&
      monitorGating.unattendedMs < thresholds.longActiveMs
    ) {
      return null;
    }

    // BLO-19604: `run.nextAction` is only populated when that specific run's own
    // liveness classification saw the text (e.g. a comment posted after that run had
    // already been classified is invisible to it). Before reporting "none recorded" —
    // which reads as "the assignee left no next step" — fall back to scanning the
    // assignee's own recent comments directly, the same way run-liveness classification
    // would have. This is a genuine fallback, not just a relabelled null: it recovers a
    // `Next action:`/`Next:` line the structured field missed. Sourced from
    // `findCommentNextAction` (queried directly against `issueComments`, no join on
    // `heartbeatRuns`) rather than `latestComments`, since a plain assignee comment with no
    // `createdByRunId` is exactly the kind of comment this fallback exists to recover, and
    // `latestComments`'s inner join excludes it. Keep that fallback lazy and projected: the
    // common structured path should not transfer or parse the assignee's full comment window.
    const structuredNextAction = latestRuns.find((run) => run.nextAction)?.nextAction ?? null;
    const commentNextAction = structuredNextAction
      ? null
      : await findCommentNextAction(sourceIssue, sourceAgent, thresholds, now);
    const nextAction = structuredNextAction ?? commentNextAction;

    // Queued-but-never-dispatched runs are excluded from the elapsed-time figure but
    // reported explicitly, so a reviewer has an explanation for why the episode looks
    // shorter than the issue's raw age. Reaping/re-dispatch ceilings are the
    // dispatcher's job (BLO-21116 / BLO-19954), not this evaluator's.
    const queuedUndispatchedRuns = latestRuns.filter((run) => run.status === "queued" && !run.startedAt);
    const oldestQueuedUndispatchedRun = queuedUndispatchedRuns.reduce<HeartbeatRunRow | null>(
      (oldest, run) => (!oldest || run.createdAt.getTime() < oldest.createdAt.getTime() ? run : oldest),
      null,
    );

    return {
      trigger,
      firedTriggers,
      triggerReasons,
      sourceIssue,
      sourceAgent,
      noCommentStreak,
      runtimeFailureStreak,
      runtimeFailureUsageBasis,
      neverInvokedRunCount,
      commentExemptExecutedRunCount,
      nonExecutingRunCount,
      nonExecutingDominantErrorCode,
      nonExecutingAlsoNeverInvokedCount,
      totalRunCount: latestRuns.length,
      terminalRunCount: terminalRuns.length,
      activeRunCount,
      runCountLastHour,
      runCountLastSixHours,
      commentCount: assigneeRunCommentCount,
      commentCountLastHour: assigneeRunCommentCountLastHour,
      commentCountLastSixHours: assigneeRunCommentCountLastSixHours,
      elapsedMs,
      nonLiveHoldMs,
      monitorGating,
      noExecutableTurnGating,
      latestRuns: latestRuns.slice(0, 5),
      latestComments,
      costCents: costRow.costCents,
      usageSamples: latestRuns
        .filter((run) => run.usageJson)
        .slice(0, 3)
        .map((run) => ({ runId: run.id, usageJson: run.usageJson ?? null })),
      nextAction,
      latestPullRequest,
      queuedUndispatchedRunCount: queuedUndispatchedRuns.length,
      oldestQueuedUndispatchedRunAgeMs: oldestQueuedUndispatchedRun
        ? Math.max(0, now.getTime() - oldestQueuedUndispatchedRun.createdAt.getTime())
        : null,
      thresholds,
      generatedAt: now,
      routineOnlySamplingWindow,
    };
  }

  async function resolveReviewOwnerAgentId(sourceIssue: IssueRow, sourceAgent: AgentRow) {
    const candidateIds: string[] = [];
    if (sourceAgent.reportsTo) candidateIds.push(sourceAgent.reportsTo);
    if (sourceIssue.createdByAgentId) candidateIds.push(sourceIssue.createdByAgentId);
    if (sourceIssue.projectId) {
      const project = await db
        .select({ leadAgentId: projects.leadAgentId })
        .from(projects)
        .where(and(eq(projects.companyId, sourceIssue.companyId), eq(projects.id, sourceIssue.projectId)))
        .then((rows) => rows[0] ?? null);
      if (project?.leadAgentId) candidateIds.push(project.leadAgentId);
    }
    const roleCandidates = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.companyId, sourceIssue.companyId), inArray(agents.role, ["cto", "ceo"])))
      .orderBy(sql`case when ${agents.role} = 'cto' then 0 else 1 end`, asc(agents.createdAt), asc(agents.id));
    candidateIds.push(...roleCandidates.map((agent) => agent.id));

    const seen = new Set<string>();
    for (const agentId of candidateIds) {
      if (seen.has(agentId)) continue;
      seen.add(agentId);
      const candidate = await getAgent(agentId);
      if (!candidate || candidate.companyId !== sourceIssue.companyId || !isAgentInvokable(candidate)) continue;
      const budgetBlock = await budgets.getInvocationBlock(sourceIssue.companyId, candidate.id, {
        issueId: sourceIssue.id,
        projectId: sourceIssue.projectId ?? null,
      });
      if (!budgetBlock) return candidate.id;
    }
    return null;
  }

  async function resolveEscalationOwnerUserId(companyId: string) {
    const rows = await db
      .select({ userId: companyMemberships.principalId, membershipRole: companyMemberships.membershipRole })
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.status, "active"),
        ),
      )
      .orderBy(
        sql`case when ${companyMemberships.membershipRole} = 'owner' then 0 when ${companyMemberships.membershipRole} = 'admin' then 1 else 2 end`,
        asc(companyMemberships.createdAt),
        asc(companyMemberships.id),
      )
      .limit(1);
    return rows[0]?.userId ?? null;
  }

  function isProductivityReviewOptedOut(issue: IssueRow) {
    const policy = issue.executionPolicy;
    if (!policy || typeof policy !== "object" || Array.isArray(policy)) return false;
    const monitor = (policy as Record<string, unknown>).monitor;
    if (!monitor || typeof monitor !== "object" || Array.isArray(monitor)) return false;
    return (monitor as Record<string, unknown>).productivityReviewDisabled === true;
  }

  function buildReviewMarkdown(evidence: ProductivityReviewEvidence, prefix: string) {
    const latestRuns = evidence.latestRuns.length > 0
      ? evidence.latestRuns.map((run) =>
        `- ${runUiLink(run, prefix)} \`${run.status}\` liveness \`${run.livenessState ?? "unknown"}\`, created ${run.createdAt.toISOString()}${run.nextAction ? `, next action: ${truncateInline(run.nextAction, 160)}` : ""}`,
      ).join("\n")
      : "- none";
    const latestComments = evidence.latestComments.length > 0
      ? evidence.latestComments.map((comment) =>
        `- ${comment.createdAt.toISOString()}${comment.createdByRunId ? ` run \`${comment.createdByRunId}\`` : ""}: ${truncateInline(comment.body)}`,
      ).join("\n")
      : "- none";
    const usage = evidence.usageSamples.length > 0
      ? evidence.usageSamples.map((sample) => `- \`${sample.runId}\`: \`${JSON.stringify(sample.usageJson).slice(0, 500)}\``).join("\n")
      : "- no usage payloads on sampled runs";
    return [
      "Paperclip detected an unusual productivity/progression pattern on an assigned issue.",
      "",
      "## Source",
      "",
      `- Source issue: ${issueUiLink(evidence.sourceIssue, prefix)}`,
      `- Assigned agent: ${evidence.sourceAgent.name} (${evidence.sourceAgent.role})`,
      `- Primary trigger: \`${evidence.trigger}\` (${formatTrigger(evidence.trigger)})`,
      `- Trigger reasons: ${evidence.triggerReasons.join("; ")}`,
      `- Generated at: ${evidence.generatedAt.toISOString()}`,
      "",
      "## Evidence",
      "",
      `- Total sampled issue-linked runs: ${evidence.totalRunCount}`,
      `- Terminal sampled runs: ${evidence.terminalRunCount}`,
      `- Active queued/running/scheduled runs: ${evidence.activeRunCount}`,
      `- No-comment streak (terminal, turn-executing runs): ${evidence.noCommentStreak}`,
      `- Runtime-failure streak (terminal, never-executed runs): ${evidence.runtimeFailureStreak}`,
      `- Never-invoked runs excluded (terminal, no adapter ever created — \`usageJson\`/\`logStore\`/\`logRef\` null, \`logBytes\` 0, BLO-26165): ${evidence.neverInvokedRunCount}`,
      `- Comment-policy-exempt runs that DID execute (terminal, \`issueCommentStatus: not_applicable\`, counted toward the streak — BLO-26165): ${evidence.commentExemptExecutedRunCount}`,
      ...(evidence.nonExecutingRunCount > 0
        ? [
            // BLO-22436 (Ally suggestion on 37c1bd65): one parenthetical group,
            // not two adjacent ones — the overlap note and the dominant-errorCode
            // note are both qualifications of the same count, and `all N` drops
            // the `N of N` echo the total-overlap case used to render.
            `- Non-executing runs in sample window (excluded from streaks above): ${evidence.nonExecutingRunCount} (${
              [
                ...(evidence.nonExecutingAlsoNeverInvokedCount > 0
                  ? [
                      evidence.nonExecutingAlsoNeverInvokedCount < evidence.nonExecutingRunCount
                        ? `${evidence.nonExecutingAlsoNeverInvokedCount} already counted above as never-invoked, ${evidence.nonExecutingRunCount - evidence.nonExecutingAlsoNeverInvokedCount} additional`
                        : `all ${evidence.nonExecutingAlsoNeverInvokedCount} already counted above as never-invoked`,
                    ]
                  : []),
                evidence.nonExecutingDominantErrorCode
                  ? `dominant errorCode: ${
                      evidence.nonExecutingDominantErrorCode.code
                        ? `\`${evidence.nonExecutingDominantErrorCode.code}\``
                        : "none recorded"
                    }, ${
                      evidence.nonExecutingDominantErrorCode.count === evidence.nonExecutingRunCount
                        ? `all ${evidence.nonExecutingRunCount}`
                        : `${evidence.nonExecutingDominantErrorCode.count} of ${evidence.nonExecutingRunCount}`
                    }`
                  : "no single dominant errorCode",
              ].join("; ")
            })`,
          ]
        : []),
      `- Current active elapsed time: ${msToHuman(evidence.elapsedMs)}`,
      ...(evidence.nonLiveHoldMs > 0
        ? [
            `- Excluded as non-live execution hold: ${msToHuman(evidence.nonLiveHoldMs)} (issue's executionRunId parked or pinned by a run that was not live; not counted toward the trigger — BLO-19848)`,
          ]
        : []),
      ...(evidence.monitorGating
        ? [`- Elapsed accounting: ${formatMonitorGating(evidence.monitorGating)}`]
        : []),
      ...(evidence.noExecutableTurnGating
        ? [`- No-executable-turn accounting: ${formatNoExecutableTurnGating(evidence.noExecutableTurnGating)}`]
        : []),
      `- Runs in rolling windows: ${evidence.runCountLastHour}/1h, ${evidence.runCountLastSixHours}/6h`,
      `- Assignee run-linked comments total/window: ${evidence.commentCount} total, ${evidence.commentCountLastHour}/1h, ${evidence.commentCountLastSixHours}/6h`,
      `- Cost events total: ${evidence.costCents} cents`,
      `- Linked pull request: ${formatPullRequestEvidence(evidence.latestPullRequest)}`,
      ...(evidence.queuedUndispatchedRunCount > 0
        ? [
          `- Queued, never-dispatched runs in sample: ${evidence.queuedUndispatchedRunCount} (oldest ${msToHuman(evidence.oldestQueuedUndispatchedRunAgeMs)} old) — excluded from the elapsed-time figure above; a run stuck in \`queued\` is a dispatch problem, not evidence of a long-running episode`,
        ]
        : []),
      `- Current next action: ${evidence.nextAction ? truncateInline(evidence.nextAction, 500) : "none recorded"}`,
      "",
      "## Thresholds",
      "",
      `- No-comment / runtime-failure streak: ${evidence.thresholds.noCommentStreakRuns} consecutive terminal runs`,
      `- Long active duration: ${msToHuman(evidence.thresholds.longActiveMs)}`,
      `- High churn: ${evidence.thresholds.highChurnHourly}/1h or ${evidence.thresholds.highChurnSixHours}/6h runs/assignee-run comments`,
      `- Resolved-review snooze: ${msToHuman(evidence.thresholds.resolvedSnoozeMs)}`,
      "",
      "## Latest Runs",
      "",
      latestRuns,
      "",
      "## Latest Assignee Run Comments",
      "",
      latestComments,
      "",
      "## Usage Samples",
      "",
      usage,
      "",
      "## Manager Decision",
      "",
      ...(evidence.trigger === "runtime_failure_streak"
        ? [
          formatRuntimeFailureManagerClaim(evidence.runtimeFailureUsageBasis),
          "",
          "Route to platform/SRE for one of:",
          "- Diagnose and fix the underlying dispatch/runtime fault (crashloop, provider outage, retry exhaustion)",
          "- Confirm the fault has cleared and let the issue continue unattended (no assignee action needed)",
          "- If the fault persists, escalate for infrastructure remediation instead of reassigning or cancelling the source work",
        ]
        : [
          "A \"Close as productive\" verdict requires at least ONE of the following concrete progress signals:",
          "- An assignee run-linked comment in the last 6h that contains a `Next action:` line",
          "- A non-stale PR/MR link in the source issue's evidence (created or updated in the last 24h)",
          "- A recent test result, artifact commit, or workspace deliverable in the last 6h",
          ...(isProgressPullRequest(evidence.latestPullRequest)
            ? [
              "",
              `> The second signal is already present: ${formatPullRequestEvidence(evidence.latestPullRequest)}.`,
              "> PR activity is recorded from the GitHub webhook, so this is deliverable progress even",
              "> when the run/comment counters above read zero.",
            ]
            : []),
          "",
          "If none of these signals is present, the correct verdict is one of:",
          "- Request decomposition (the work is too large for a single heartbeat issue and needs to be split)",
          "- Block with an unblock owner (the work needs human direction; name the gate)",
          "- Stop/cancel (the work is not delivering value and should be wound down)",
          "- Continue with a snooze window (only if the assignee has a clear next step but no surface evidence yet)",
          "",
          "If you choose \"Block with an unblock owner\", file the escalation in this same run: create a `request_board_approval` approval with this review's source issue in `issueIds`, naming the gate and the exact human action needed. The source link is required and the source must be authorized before the approval is created — an unlinked card reaches a human with no context, and a review run may not attach arbitrary same-company issues. A stated gate with no approval card reaches nobody, and polling a human-only gate is not a substitute. This review runs on the cheap status-only profile, which is permitted to create that one approval type and no other.",
        ]),
    ].join("\n");
  }

  function buildRefreshComment(evidence: ProductivityReviewEvidence, prefix: string) {
    return [
      "Productivity review evidence refreshed.",
      "",
      `- Source issue: ${issueUiLink(evidence.sourceIssue, prefix)}`,
      `- Trigger: \`${evidence.trigger}\` (${formatTrigger(evidence.trigger)})`,
      `- Reasons: ${evidence.triggerReasons.join("; ")}`,
      `- No-comment streak: ${evidence.noCommentStreak}`,
      `- Runtime-failure streak: ${evidence.runtimeFailureStreak}`,
      `- Never-invoked runs excluded (no adapter created): ${evidence.neverInvokedRunCount}`,
      `- Comment-policy-exempt runs that DID execute (counted): ${evidence.commentExemptExecutedRunCount}`,
      // BLO-22436 (Ally suggestion on 37c1bd65): the never-invoked count is
      // ambiguous on its own — it says nothing about *why* those runs could not
      // comment. Carry the non-executing count and its overlap here too, so the
      // comment that lands in a manager's notifications tells the same story as
      // the description it summarises.
      ...(evidence.nonExecutingRunCount > 0
        ? [
            `- Non-executing runs excluded: ${evidence.nonExecutingRunCount}${
              evidence.nonExecutingAlsoNeverInvokedCount > 0
                ? evidence.nonExecutingAlsoNeverInvokedCount < evidence.nonExecutingRunCount
                  ? ` (${evidence.nonExecutingAlsoNeverInvokedCount} of them already counted as never-invoked)`
                  : " (all of them already counted as never-invoked)"
                : ""
            }`,
          ]
        : []),
      `- Runs/assignee comments: ${evidence.runCountLastHour}/${evidence.commentCountLastHour} in 1h, ${evidence.runCountLastSixHours}/${evidence.commentCountLastSixHours} in 6h`,
      ...(evidence.monitorGating
        ? [`- Elapsed accounting: ${formatMonitorGating(evidence.monitorGating)}`]
        : []),
      ...(evidence.noExecutableTurnGating
        ? [`- No-executable-turn accounting: ${formatNoExecutableTurnGating(evidence.noExecutableTurnGating)}`]
        : []),
      `- Next action: ${evidence.nextAction ? truncateInline(evidence.nextAction, 300) : "none recorded"}`,
      `- Linked pull request: ${formatPullRequestEvidence(evidence.latestPullRequest)}`,
    ].join("\n");
  }

  async function createOrUpdateReview(
    evidence: ProductivityReviewEvidence,
    opts: { prefix: string; thresholds: ProductivityReviewThresholds },
  ) {
    if (evidence.routineOnlySamplingWindow) {
      logger.info(
        {
          sourceIssueId: evidence.sourceIssue.id,
          sourceIssueIdentifier: evidence.sourceIssue.identifier,
          trigger: evidence.trigger,
          sampledRunCount: evidence.totalRunCount,
        },
        "productivity review skipped: source issue's sampling-window runs are 100% routine-origin",
      );
      return { kind: "skipped" as const, reviewIssueId: null };
    }

    const existing = await findOpenProductivityReview(evidence.sourceIssue.companyId, evidence.sourceIssue.id);
    if (existing) {
      if (existing.identifier == null && existing.issueNumber == null) {
        const reservationAgeMs = evidence.generatedAt.getTime() - existing.updatedAt.getTime();
        if (reservationAgeMs < PRODUCTIVITY_REVIEW_RESERVATION_STALE_MS) {
          logger.info(
            {
              reviewIssueId: existing.id,
              sourceIssueId: evidence.sourceIssue.id,
              reservationAgeMs,
            },
            "productivity review create skipped: reservation is still finalizing",
          );
          return { kind: "existing" as const, reviewIssueId: existing.id };
        }
        if (!existing.assigneeAgentId) {
          logger.warn(
            {
              reviewIssueId: existing.id,
              sourceIssueId: evidence.sourceIssue.id,
              reservationAgeMs,
            },
            "productivity review reservation recovery skipped: reservation has no assignee agent",
          );
          return { kind: "existing" as const, reviewIssueId: existing.id };
        }
        const finalized = await finalizeReservedProductivityReviewIssue({
          review: existing,
          title: existing.title,
          description: existing.description ?? buildReviewMarkdown(evidence, opts.prefix),
          generatedAt: evidence.generatedAt,
        });
        const finish = await finishCreatedProductivityReview(
          finalized.review,
          evidence,
          existing.assigneeAgentId,
        );
        logger.info(
          {
            reviewIssueId: finalized.review.id,
            sourceIssueId: evidence.sourceIssue.id,
            reservationAgeMs,
            finalized: finalized.finalized,
            createdActivityInserted: finish.createdActivityInserted,
            assignmentWakeProcessed: finish.assignmentWakeProcessed,
          },
          "productivity review reservation recovered and finalized",
        );
        // Finalization and finish use separate locks, so side-effect ownership
        // identifies the single reconciler that completed creation.
        return finish.createdActivityInserted || finish.assignmentWakeProcessed
          ? { kind: "created" as const, reviewIssueId: finalized.review.id }
          : { kind: "existing" as const, reviewIssueId: finalized.review.id };
      }

      if (existing.identifier == null || existing.issueNumber == null) {
        logger.warn(
          {
            reviewIssueId: existing.id,
            sourceIssueId: evidence.sourceIssue.id,
          },
          "productivity review existing row is partially finalized",
        );
        return { kind: "existing" as const, reviewIssueId: existing.id };
      }

      if (existing.assigneeAgentId) {
        const finish = await finishCreatedProductivityReview(existing, evidence, existing.assigneeAgentId);
        if (finish.createdActivityInserted || finish.assignmentWakeProcessed) {
          logger.info(
            {
              reviewIssueId: existing.id,
              sourceIssueId: evidence.sourceIssue.id,
              createdActivityInserted: finish.createdActivityInserted,
              assignmentWakeProcessed: finish.assignmentWakeProcessed,
            },
            "productivity review finalized side effects replayed",
          );
          return { kind: "created" as const, reviewIssueId: existing.id };
        }
      }

      // BLO-3281 AC2: hard-floor refresh interval. Even when the
      // scheduler triggers a re-scan inside the 5-min window, we
      // skip the addComment so the review thread doesn't accumulate
      // ~identical "evidence refreshed" comments. The previous run
      // is reused as the {kind:"existing"} outcome.
      //
      // BLO-3737: read-then-write across two statements let concurrent
      // reconciles (the 30s scheduler overlapping itself) both observe the
      // pre-write state and both pass the gate — BLO-3277 accumulated 14
      // refreshes in 6 minutes that way. Hold a transaction-scoped advisory
      // lock keyed on the review issue for the whole check-then-append, so
      // the second reconcile blocks until the first commits and then sees
      // its comment. `pg_advisory_xact_lock` waits rather than failing and
      // is released on commit/rollback, so no unlock bookkeeping is needed.
      const effectiveRefreshIntervalMs = Math.max(
        PRODUCTIVITY_REVIEW_MIN_REFRESH_INTERVAL_MS,
        opts.thresholds.refreshIntervalMs,
      );
      const refreshOutcome = await db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${evidence.sourceIssue.companyId} || ':' || ${existing.id}, 0))`,
        );

        const refreshState = await getRefreshCommentState(evidence.sourceIssue.companyId, existing.id, tx);
        const lastRefreshAt = refreshState.latestCreatedAt ?? existing.createdAt;
        // The hard-floor interval gates everything below, including the
        // description rewrite — a trigger flip must not be usable to force
        // more writes than a normal refresh already allows.
        if (evidence.generatedAt.getTime() - lastRefreshAt.getTime() < effectiveRefreshIntervalMs) {
          return { throttled: true as const, lastRefreshAt };
        }

        // BLO-22105: the Manager Decision block is trigger-conditional (see
        // buildReviewMarkdown), so a review whose live trigger has flipped since
        // it was created/last regenerated is showing stale — potentially
        // under-enforcing — remedy guidance. Regenerate only on an actual flip
        // (never on unparseable/legacy descriptions) and only inside this same
        // throttle-gated branch, so a trigger flip cannot be used to force a
        // description write more often than the hard-floor interval allows.
        const previousTrigger = extractReviewTriggerFromDescription(existing.description);
        const descriptionStale = previousTrigger !== null && previousTrigger !== evidence.trigger;
        let descriptionRegenerated = false;
        if (descriptionStale) {
          // `existing.description` was read outside this transaction. The
          // advisory lock only serializes this refresh path against itself —
          // it says nothing about a human editing the review issue's
          // description directly in between. Guard the overwrite with the
          // description we actually read so a concurrent edit loses the race
          // cleanly (0 rows matched, nothing clobbered) instead of being
          // silently discarded.
          const [updatedRow] = await tx
            .update(issues)
            .set({ description: buildReviewMarkdown(evidence, opts.prefix), updatedAt: evidence.generatedAt })
            .where(and(eq(issues.id, existing.id), eq(issues.description, existing.description as string)))
            .returning({ id: issues.id });
          descriptionRegenerated = updatedRow !== undefined;
        }

        // `maxRefreshComments` bounds refresh-comment churn, not the
        // correctness of the durable Manager Decision guidance. Gating the
        // description rewrite on it too would mean a review that outlives the
        // cap could never self-correct after a trigger flip — exactly the
        // staleness this fix exists to close. Only the comment emission is
        // capped; the interval check above still applies to both.
        const commentCapped = refreshState.count >= opts.thresholds.maxRefreshComments;
        if (!commentCapped) {
          await addRefreshComment(
            existing.id,
            buildRefreshComment(evidence, opts.prefix),
            evidence.generatedAt,
            tx,
          );
        }

        if (commentCapped && !descriptionRegenerated) {
          return { throttled: true as const, lastRefreshAt };
        }
        return { throttled: false as const, lastRefreshAt, descriptionRegenerated };
      });

      if (refreshOutcome.throttled) {
        logger.debug(
          {
            reviewIssueId: existing.id,
            sourceIssueId: evidence.sourceIssue.id,
            lastRefreshAt: refreshOutcome.lastRefreshAt.toISOString(),
            minIntervalMs: effectiveRefreshIntervalMs,
          },
          "productivity review refresh throttled: within hard-floor window or comment cap reached with no stale description to fix",
        );
        return { kind: "existing" as const, reviewIssueId: existing.id };
      }
      await logActivity(db, {
        companyId: evidence.sourceIssue.companyId,
        actorType: "system",
        actorId: "system",
        action: "issue.productivity_review_updated",
        entityType: "issue",
        entityId: existing.id,
        agentId: existing.assigneeAgentId,
        details: {
          source: "productivity_review.reconcile",
          sourceIssueId: evidence.sourceIssue.id,
          trigger: evidence.trigger,
          firedTriggers: evidence.firedTriggers,
          noCommentStreak: evidence.noCommentStreak,
          runCountLastHour: evidence.runCountLastHour,
          commentCountLastHour: evidence.commentCountLastHour,
          descriptionRegenerated: refreshOutcome.descriptionRegenerated,
        },
      });
      return { kind: "updated" as const, reviewIssueId: existing.id };
    }

    const recentCreationCount = await countRecentProductivityReviews(
      evidence.sourceIssue.companyId,
      evidence.sourceIssue.id,
      opts.thresholds,
      evidence.generatedAt,
    );
    if (recentCreationCount >= opts.thresholds.maxCreationsPerWindow) {
      return { kind: "creation_capped" as const, reviewIssueId: null };
    }

    const consecutiveNoActionReviews = await countConsecutiveNoActionProductivityReviews(
      evidence.sourceIssue.companyId,
      evidence.sourceIssue.id,
      opts.thresholds,
    );
    if (consecutiveNoActionReviews >= opts.thresholds.maxConsecutiveNoActionReviews) {
      return { kind: "no_action_suppressed" as const, reviewIssueId: null };
    }

    const ownerAgentId = await resolveReviewOwnerAgentId(evidence.sourceIssue, evidence.sourceAgent);
    // Never open an unassigned review. It was already a dead row — the wake
    // below is gated on `ownerAgentId`, so nothing would ever work it — and
    // since BLO-19094 it is also a privilege-escalation hook: an open review
    // grants its assignee issue:comment/issue:mutate on the SOURCE issue, and
    // an issue with no agent assignee is mutable by any company agent
    // (`allow_company_agent`). Together those let any agent self-assign the
    // dangling review and inherit mutation rights on an issue it has no
    // relationship to. Skipping creation keeps the grant reachable only by the
    // reviewer the harness actually chose.
    if (!ownerAgentId) {
      logger.warn({
        companyId: evidence.sourceIssue.companyId,
        issueId: evidence.sourceIssue.id,
        trigger: evidence.trigger,
      }, "productivity review skipped: no invokable, in-budget review owner could be resolved");
      return { kind: "skipped" as const, reviewIssueId: null };
    }

    if (evidence.trigger === "long_active_duration") {
      const monitor = await currentPendingMonitorForReviewSuppression(
        evidence.sourceIssue,
        evidence.generatedAt,
        opts.thresholds,
      );
      if (monitor) {
        await recordMonitorScheduledSuppression({
          trigger: evidence.trigger,
          firedTriggers: evidence.firedTriggers,
          triggerReasons: evidence.triggerReasons,
          sourceIssue: evidence.sourceIssue,
          sourceAgent: evidence.sourceAgent,
          elapsedMs: evidence.elapsedMs,
          monitorNextCheckAt: monitor.monitorNextCheckAt,
          monitorScheduledBy: monitor.monitorScheduledBy,
          monitorWakeRequestedAt: monitor.monitorWakeRequestedAt,
          monitorLastTriggeredAt: monitor.monitorLastTriggeredAt,
          thresholds: evidence.thresholds,
          generatedAt: evidence.generatedAt,
        });
        return { kind: "monitor_suppressed" as const, reviewIssueId: null };
      }
    }

    let review: Awaited<ReturnType<typeof issuesSvc.create>>;
    const reviewTitle = `Review productivity for ${evidence.sourceIssue.identifier ?? evidence.sourceIssue.title}`;
    const reviewDescription = buildReviewMarkdown(evidence, opts.prefix);
    try {
      await deps?.beforeCreateReviewIssueInsert?.(evidence);
      if (evidence.trigger === "long_active_duration") {
        await assertAssignableAgent(db, evidence.sourceIssue.companyId, ownerAgentId, { kind: "work" });
        await deps?.beforeFinalMonitorSuppressionRevalidation?.(evidence);
        const reservation = await reserveLongActiveProductivityReviewIssue({
          evidence,
          thresholds: opts.thresholds,
          ownerAgentId,
          title: reviewTitle,
          description: reviewDescription,
        });
        if (reservation.kind === "existing") {
          return { kind: "existing" as const, reviewIssueId: reservation.review.id };
        }
        await deps?.afterFinalMonitorReviewReservation?.(evidence, reservation.review);
        review = await finalizeReservedProductivityReviewIssue({
          review: reservation.review,
          title: reviewTitle,
          description: reviewDescription,
          generatedAt: evidence.generatedAt,
        }).then((finalized) => finalized.review) as Awaited<ReturnType<typeof issuesSvc.create>>;
      } else {
        review = await issuesSvc.create(evidence.sourceIssue.companyId, {
          title: reviewTitle,
          description: reviewDescription,
          status: "todo",
          priority: "high",
          parentId: evidence.sourceIssue.id,
          projectId: evidence.sourceIssue.projectId,
          goalId: evidence.sourceIssue.goalId,
          billingCode: evidence.sourceIssue.billingCode,
          assigneeAgentId: ownerAgentId,
          assigneeAdapterOverrides: recoveryAssigneeAdapterOverrides("status_only"),
          originKind: PRODUCTIVITY_REVIEW_ORIGIN_KIND,
          originId: evidence.sourceIssue.id,
          originFingerprint: productivityReviewFingerprint(evidence.sourceIssue.id),
          requestDepth: clampIssueRequestDepth(evidence.sourceIssue.requestDepth + 1),
        });
      }
    } catch (error) {
      if (error instanceof MonitorSuppressedBeforeCreateError) {
        const monitor = error.monitor;
        await recordMonitorScheduledSuppression({
          trigger: "long_active_duration",
          firedTriggers: evidence.firedTriggers,
          triggerReasons: evidence.triggerReasons,
          sourceIssue: evidence.sourceIssue,
          sourceAgent: evidence.sourceAgent,
          elapsedMs: evidence.elapsedMs,
          monitorNextCheckAt: monitor.monitorNextCheckAt,
          monitorScheduledBy: monitor.monitorScheduledBy,
          monitorWakeRequestedAt: monitor.monitorWakeRequestedAt,
          monitorLastTriggeredAt: monitor.monitorLastTriggeredAt,
          thresholds: evidence.thresholds,
          generatedAt: evidence.generatedAt,
        });
        return { kind: "monitor_suppressed" as const, reviewIssueId: null };
      }
      if (!isActiveProductivityReviewUniqueConflict(error)) throw error;
      const raced = await findOpenProductivityReview(evidence.sourceIssue.companyId, evidence.sourceIssue.id);
      if (!raced) throw error;
      return { kind: "existing" as const, reviewIssueId: raced.id };
    }
    await finishCreatedProductivityReview(review, evidence, ownerAgentId);

    return { kind: "created" as const, reviewIssueId: review.id };
  }

  function reservationRecoveryFinishEvidence(
    sourceIssue: IssueRow,
    generatedAt: Date,
  ): ProductivityReviewFinishEvidence {
    return {
      sourceIssue,
      generatedAt,
      trigger: "long_active_duration",
      // The reservation is the only surviving record of why this review exists,
      // and it is long-active by construction (`reserveLongActiveProductivityReviewIssue`
      // is the sole writer). Recording exactly that keeps the persisted set
      // consistent with the persisted primary and leaves this path's close
      // behaviour identical to what the single `trigger` gave it before.
      firedTriggers: ["long_active_duration"],
      noCommentStreak: 0,
      runCountLastHour: 0,
      commentCountLastHour: 0,
    };
  }

  async function retireStaleProductivityReviewReservation(input: {
    review: IssueRow;
    sourceIssue: IssueRow | null;
    now: Date;
    reason:
      | "missing_source"
      | "terminal_source"
      | "unreviewable_source"
      | "missing_source_agent"
      | "review_owner_changed";
  }) {
    const [retired] = await db
      .update(issues)
      .set({ status: "done", completedAt: input.now, updatedAt: input.now })
      .where(
        and(
          eq(issues.companyId, input.review.companyId),
          eq(issues.id, input.review.id),
          eq(issues.originKind, PRODUCTIVITY_REVIEW_ORIGIN_KIND),
          isNull(issues.issueNumber),
          isNull(issues.identifier),
          notInArray(issues.status, ["done", "cancelled"]),
        ),
      )
      .returning({ id: issues.id });
    if (!retired) return false;

    await logActivity(db, {
      companyId: input.review.companyId,
      actorType: "system",
      actorId: "system",
      action: "issue.productivity_review_suppressed_open_review_closed",
      entityType: "issue",
      entityId: input.review.id,
      agentId: input.review.assigneeAgentId,
      details: {
        source: "productivity_review.reconcile",
        sourceIssueId: input.sourceIssue?.id ?? input.review.originId,
        trigger: "long_active_duration",
        suppressedBy: input.reason,
        sourceStatus: input.sourceIssue?.status ?? null,
        sourceMissing: !input.sourceIssue,
        reservationRecovered: true,
      },
    });
    return true;
  }

  async function recoverStaleReservedProductivityReviews(input: {
    now: Date;
    companyId?: string;
  }) {
    const staleCutoff = new Date(input.now.getTime() - PRODUCTIVITY_REVIEW_RESERVATION_STALE_MS);
    const reservedReviews = await db
      .select()
      .from(issues)
      .where(
        and(
          input.companyId ? eq(issues.companyId, input.companyId) : undefined,
          eq(issues.originKind, PRODUCTIVITY_REVIEW_ORIGIN_KIND),
          visibleIssueCondition(),
          notInArray(issues.status, ["done", "cancelled"]),
          isNull(issues.identifier),
          isNull(issues.issueNumber),
          lt(issues.updatedAt, staleCutoff),
        ),
      )
      .orderBy(asc(issues.updatedAt), asc(issues.id))
      .limit(MAX_CANDIDATE_ISSUES);

    const result = {
      created: 0,
      existing: 0,
      failed: 0,
      reviewIssueIds: [] as string[],
      failedIssueIds: [] as string[],
      retiredStaleReservation: 0,
      recoveredSourceIssueIds: new Set<string>(),
    };

    for (const review of reservedReviews) {
      if (!review.originId) {
        const retired = await retireStaleProductivityReviewReservation({
          review,
          sourceIssue: null,
          now: input.now,
          reason: "missing_source",
        });
        if (retired) {
          result.retiredStaleReservation += 1;
          result.reviewIssueIds.push(review.id);
        } else {
          result.existing += 1;
        }
        continue;
      }
      result.recoveredSourceIssueIds.add(review.originId);
      if (!review.assigneeAgentId) {
        const retired = await retireStaleProductivityReviewReservation({
          review,
          sourceIssue: null,
          now: input.now,
          reason: "review_owner_changed",
        });
        if (retired) {
          result.retiredStaleReservation += 1;
          result.reviewIssueIds.push(review.id);
        } else {
          result.existing += 1;
        }
        continue;
      }

      const sourceIssue = await db
        .select()
        .from(issues)
        .where(and(eq(issues.companyId, review.companyId), eq(issues.id, review.originId)))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (!sourceIssue) {
        const retired = await retireStaleProductivityReviewReservation({
          review,
          sourceIssue: null,
          now: input.now,
          reason: "missing_source",
        });
        if (retired) {
          result.retiredStaleReservation += 1;
          result.reviewIssueIds.push(review.id);
        } else {
          result.existing += 1;
        }
        continue;
      }
      const reservationSourceAgentId = review.createdByAgentId ??
        (sourceIssue.updatedAt.getTime() <= review.updatedAt.getTime() ? sourceIssue.assigneeAgentId : null);
      const sourceAgent = reservationSourceAgentId ? await getAgent(reservationSourceAgentId) : null;
      const currentSourceAgent = sourceIssue.assigneeAgentId ? await getAgent(sourceIssue.assigneeAgentId) : null;
      const reviewability = reservationSourceAgentId
        ? await evaluateSourceReviewability(sourceIssue, reservationSourceAgentId)
        : { reviewable: false, terminal: isTerminalIssueStatus(sourceIssue.status), status: sourceIssue.status };
      const currentReviewOwnerId = currentSourceAgent
        ? await resolveReviewOwnerAgentId(sourceIssue, currentSourceAgent)
        : null;
      const retiredReason =
        reviewability.terminal ? "terminal_source" :
        !sourceAgent || sourceAgent.companyId !== sourceIssue.companyId ? "missing_source_agent" :
        sourceIssue.assigneeAgentId &&
          (!currentSourceAgent || currentSourceAgent.companyId !== sourceIssue.companyId) ? "missing_source_agent" :
        currentReviewOwnerId && currentReviewOwnerId !== review.assigneeAgentId ? "review_owner_changed" :
        !reviewability.reviewable ||
          await isProductivityReviewDescendant(sourceIssue) ||
          isProductivityReviewOptedOut(sourceIssue) ? "unreviewable_source" :
        null;
      if (retiredReason) {
        const retired = await retireStaleProductivityReviewReservation({
          review,
          sourceIssue,
          now: input.now,
          reason: retiredReason,
        });
        if (retired) {
          result.retiredStaleReservation += 1;
          result.reviewIssueIds.push(review.id);
        } else {
          result.existing += 1;
        }
        continue;
      }

      try {
        await deps?.beforeStaleReservationRecoveryFinalize?.(review, sourceIssue);
        const finalized = await finalizeReservedProductivityReviewIssue({
          review,
          title: review.title,
          description: review.description ?? `Review productivity for ${sourceIssue.identifier ?? sourceIssue.title}`,
          generatedAt: input.now,
        });
        await deps?.afterStaleReservationRecoveryFinalize?.(
          finalized.review,
          sourceIssue,
          finalized.finalized,
        );
        const finish = await finishCreatedProductivityReview(
          finalized.review,
          reservationRecoveryFinishEvidence(sourceIssue, input.now),
          review.assigneeAgentId,
        );
        // Finalization and finish use separate locks, so side-effect ownership
        // identifies the single reconciler that completed creation.
        if (finish.createdActivityInserted || finish.assignmentWakeProcessed) {
          result.created += 1;
          result.reviewIssueIds.push(finalized.review.id);
        } else {
          result.existing += 1;
        }
        logger.info(
          {
            reviewIssueId: finalized.review.id,
            sourceIssueId: sourceIssue.id,
            finalized: finalized.finalized,
            createdActivityInserted: finish.createdActivityInserted,
            assignmentWakeProcessed: finish.assignmentWakeProcessed,
          },
          "productivity review stale reservation recovered before source candidate filtering",
        );
      } catch (err) {
        result.failed += 1;
        result.failedIssueIds.push(sourceIssue.id);
        logger.warn(
          {
            err,
            reviewIssueId: review.id,
            sourceIssueId: sourceIssue.id,
          },
          "productivity review stale reservation recovery failed",
        );
      }
    }

    return result;
  }

  async function createProductivityReviewEscalation(input: {
    sourceIssue: IssueRow;
    priorReviewCount: number;
    thresholds: ProductivityReviewThresholds;
    now: Date;
  }) {
    const existing = await findOpenProductivityReviewEscalation(input.sourceIssue.companyId, input.sourceIssue.id);
    if (existing) return { kind: "existing" as const, escalationIssueId: existing.id };

    const [ownerUserId, priorReviews] = await Promise.all([
      resolveEscalationOwnerUserId(input.sourceIssue.companyId),
      latestResolvedProductivityReviews(
        input.sourceIssue.companyId,
        input.sourceIssue.id,
        input.thresholds.escalationLookbackMs,
        input.now,
      ),
    ]);
    const lookbackDays = Math.round(input.thresholds.escalationLookbackMs / (24 * 60 * 60 * 1000));
    const priorReviewLines = priorReviews.length > 0
      ? priorReviews.map((review) => `- ${review.identifier ?? review.id}: ${review.status}, updated ${review.updatedAt.toISOString()}`).join("\n")
      : "- no prior review rows available in the sampled lookback";

    const escalation = await issuesSvc.create(input.sourceIssue.companyId, {
      title: `[user-cover] productivity-review escalation: ${input.sourceIssue.identifier ?? input.sourceIssue.title} — ${input.priorReviewCount} prior reviews in ${lookbackDays}d`,
      description: [
        `Productivity review hit the repeat-review cap for ${input.sourceIssue.identifier ?? input.sourceIssue.id}.`,
        "",
        `- Source status: ${input.sourceIssue.status}`,
        `- Source assignee agent: ${input.sourceIssue.assigneeAgentId ?? "none"}`,
        `- Prior review count: ${input.priorReviewCount} prior resolved productivity reviews in ${lookbackDays}d`,
        `- Latest source activity: ${input.sourceIssue.lastActivityAt?.toISOString?.() ?? input.sourceIssue.updatedAt.toISOString()}`,
        `- Source started at: ${input.sourceIssue.startedAt?.toISOString?.() ?? "unknown"}`,
        `- Source monitor next check: ${input.sourceIssue.monitorNextCheckAt?.toISOString?.() ?? "none"}`,
        "",
        "## Recent wrapper verdicts",
        "",
        priorReviewLines,
        "",
        "## User direction needed",
        "",
        "Please choose one explicit direction: cancel / hand off / decompose / let it run with the opt-out flag.",
      ].join("\n"),
      status: "todo",
      priority: "high",
      parentId: input.sourceIssue.id,
      projectId: input.sourceIssue.projectId,
      goalId: input.sourceIssue.goalId,
      billingCode: input.sourceIssue.billingCode,
      assigneeAgentId: null,
      assigneeUserId: ownerUserId,
      originKind: RECOVERY_ORIGIN_KINDS.productivityReviewEscalation,
      originId: input.sourceIssue.id,
      originFingerprint: productivityReviewEscalationFingerprint(input.sourceIssue.id),
      requestDepth: clampIssueRequestDepth(input.sourceIssue.requestDepth + 1),
    });

    if (["todo", "in_progress", "in_review", "blocked"].includes(input.sourceIssue.status)) {
      const existingBlockers = await db
        .select({ blockerIssueId: issueRelations.issueId })
        .from(issueRelations)
        .where(
          and(
            eq(issueRelations.companyId, input.sourceIssue.companyId),
            eq(issueRelations.relatedIssueId, input.sourceIssue.id),
            eq(issueRelations.type, "blocks"),
          ),
        );
      await issuesSvc.update(input.sourceIssue.id, {
        status: "blocked",
        blockedByIssueIds: [...new Set([...existingBlockers.map((row) => row.blockerIssueId), escalation.id])],
      });
    }

    logger.info(
      {
        companyId: input.sourceIssue.companyId,
        sourceIssueId: input.sourceIssue.id,
        priorReviewCount: input.priorReviewCount,
        escalationIssueId: escalation.id,
      },
      "productivity review escalated chronic source issue",
    );

    return { kind: "created" as const, escalationIssueId: escalation.id };
  }

  // BLO-6243: record a suppressed terminal-source review as an audit-only decision. No review
  // issue is created and no wake comment is enqueued — this is purely an attributable trace so
  // the suppression is observable rather than an indistinguishable generic skip.
  async function recordTerminalSourceSuppression(
    evidence: ProductivityReviewEvidence,
    sourceStatus: string | null,
  ) {
    await logActivity(db, {
      companyId: evidence.sourceIssue.companyId,
      actorType: "system",
      actorId: "system",
      action: "issue.productivity_review_suppressed",
      entityType: "issue",
      entityId: evidence.sourceIssue.id,
      agentId: evidence.sourceAgent.id,
      details: {
        source: "productivity_review.reconcile",
        decision: "suppress_terminal_source",
        sourceIssueId: evidence.sourceIssue.id,
        sourceStatus,
        trigger: evidence.trigger,
        noCommentStreak: evidence.noCommentStreak,
      },
    });
  }

  async function reconcileProductivityReviews(opts?: {
    now?: Date;
    companyId?: string;
    thresholds?: Partial<ProductivityReviewThresholds>;
    issueCreatedAtGte?: Date | null;
  }) {
    const now = opts?.now ?? new Date();
    const thresholds = buildThresholds(opts?.thresholds);
    const result = {
      scanned: 0,
      created: 0,
      updated: 0,
      existing: 0,
      snoozed: 0,
      escalated: 0,
      optedOut: 0,
      monitorScheduledSuppressed: 0,
      approvalGatedSuppressed: 0,
      dependencyBlockedSuppressed: 0,
      closedSuppressedMonitorReviews: 0,
      closedTerminalSourceReviews: 0,
      closedDependencyBlockedReviews: 0,
      creationCapped: 0,
      noActionSuppressed: 0,
      skipped: 0,
      suppressedTerminalSource: 0,
      failed: 0,
      reviewIssueIds: [] as string[],
      failedIssueIds: [] as string[],
    };

    const closedSuppressed = await closeOpenSuppressedReviews(now, opts?.companyId);
    result.closedSuppressedMonitorReviews = closedSuppressed.monitorScheduled;
    result.closedTerminalSourceReviews = closedSuppressed.terminalSource;
    result.closedDependencyBlockedReviews = closedSuppressed.dependencyBlocked;

    const recoveredReservations = await recoverStaleReservedProductivityReviews({
      now,
      companyId: opts?.companyId,
    });
    result.created += recoveredReservations.created;
    result.existing += recoveredReservations.existing;
    result.failed += recoveredReservations.failed;
    result.closedTerminalSourceReviews += recoveredReservations.retiredStaleReservation;
    result.reviewIssueIds.push(...recoveredReservations.reviewIssueIds);
    result.failedIssueIds.push(...recoveredReservations.failedIssueIds);

    const candidates = await db
      .select()
      .from(issues)
      .where(
        and(
          opts?.companyId ? eq(issues.companyId, opts.companyId) : undefined,
          visibleIssueCondition(),
          isNull(issues.assigneeUserId),
          inArray(issues.status, ["todo", "in_progress"]),
          sql`${issues.assigneeAgentId} is not null`,
          sql`${issues.originKind} <> ${PRODUCTIVITY_REVIEW_ORIGIN_KIND}`,
          opts?.issueCreatedAtGte ? gte(issues.createdAt, opts.issueCreatedAtGte) : undefined,
        ),
      )
      .orderBy(asc(issues.updatedAt), asc(issues.id))
      .limit(MAX_CANDIDATE_ISSUES);
    result.scanned = candidates.length;

    // BLO-22436: an issue with an unresolved blocker has its queued *routine*
    // runs cancelled by the dependency gate before dispatch (see
    // `cancelQueuedRunForBlockedDependencies` in heartbeat.ts) and therefore
    // cannot produce a run comment from a routine wake no matter how long it
    // waits — an issue-interaction wake carrying a comment id is a deliberate
    // carve-out (see below) and can still comment. The standard remediation
    // for a flagged productivity review is to model the platform fault as a
    // `blockedBy` edge, which makes this a self-reinforcing loop for the
    // triggers a blocker actually explains (`no_comment_streak`,
    // `long_active_duration`) unless blocked issues are exempt from those:
    // fixing the previous review's cause becomes the cause of the next one.
    //
    // Scoped to `isDependencyBlockedClosableTriggerSet` over *every* trigger
    // that fired — not the primary one (Ally review, BLO-22436, twice).
    // `high_churn` and
    // `runtime_failure_streak` must still be able to fire while blocked: a
    // `blockedBy` edge is agent-writable (`paperclipUpdateIssue`) and
    // interaction wakes are deliberately allowed to dispatch on a blocked
    // issue (`isEffectivelyDependencyReadyForDispatch` in heartbeat.ts), so an
    // unconditional skip here would let a flagged agent retire its own
    // cost-accountability artifact one cycle early by adding the edge before
    // generation runs — exactly the evasion `isDependencyBlockedClosableTrigger`
    // was written to refuse at close time. Keying on `evidence.trigger` alone
    // left that evasion intact for the overlapping case, which the thresholds
    // make the *common* one: `choosePrimaryTrigger` ranks `no_comment_streak`
    // above `high_churn`, so an agent burning runs and staying silent presents a
    // closable primary and took the churn evidence down with it. Checked after
    // `collectEvidence`
    // (below) rather than filtering the candidate up front, since the trigger
    // is what determines whether the blocker is dispositive and evidence is
    // already collected for every other candidate that reaches this point.
    const dependencyBlockedSourceIssueIds = new Set<string>();
    const candidateIdsByCompany = new Map<string, string[]>();
    for (const candidate of candidates) {
      const forCompany = candidateIdsByCompany.get(candidate.companyId) ?? [];
      forCompany.push(candidate.id);
      candidateIdsByCompany.set(candidate.companyId, forCompany);
    }
    for (const [candidateCompanyId, candidateIds] of candidateIdsByCompany) {
      const readiness = await issuesSvc.listDependencyReadiness(candidateCompanyId, candidateIds, db);
      for (const candidateId of candidateIds) {
        if ((readiness.get(candidateId)?.unresolvedBlockerCount ?? 0) > 0) {
          dependencyBlockedSourceIssueIds.add(candidateId);
        }
      }
    }

    const prefixCache = new Map<string, string>();
    for (const candidate of candidates) {
      if (recoveredReservations.recoveredSourceIssueIds.has(candidate.id)) {
        continue;
      }
      if (!candidate.assigneeAgentId) {
        result.skipped += 1;
        continue;
      }
      if (await isProductivityReviewDescendant(candidate)) {
        result.skipped += 1;
        continue;
      }
      if (isProductivityReviewOptedOut(candidate)) {
        result.optedOut += 1;
        continue;
      }
      const sourceAgent = await getAgent(candidate.assigneeAgentId);
      if (!sourceAgent || sourceAgent.companyId !== candidate.companyId) {
        result.skipped += 1;
        continue;
      }
      await deps?.beforeCollectEvidence?.(candidate);
      const evidence = await collectEvidence(candidate, sourceAgent, thresholds, now);
      if (!evidence) {
        result.skipped += 1;
        continue;
      }
      if (
        dependencyBlockedSourceIssueIds.has(candidate.id) &&
        isDependencyBlockedClosableTriggerSet(evidence.firedTriggers)
      ) {
        result.dependencyBlockedSuppressed += 1;
        continue;
      }
      if (isApprovalGatedSuppression(evidence)) {
        await recordApprovalGatedSuppression(evidence);
        result.approvalGatedSuppressed += 1;
        continue;
      }
      if (isMonitorScheduledSuppression(evidence)) {
        await recordMonitorScheduledSuppression(evidence);
        result.monitorScheduledSuppressed += 1;
        continue;
      }
      if (await findRecentResolvedProductivityReview(candidate.companyId, candidate.id, thresholds, now)) {
        result.snoozed += 1;
        continue;
      }
      if (await hasRepeatedTerminalReviewsInBackoff(candidate.companyId, candidate.id, now)) {
        result.snoozed += 1;
        continue;
      }
      let prefix = prefixCache.get(candidate.companyId);
      if (!prefix) {
        prefix = await getCompanyIssuePrefix(candidate.companyId);
        prefixCache.set(candidate.companyId, prefix);
      }
      try {
        await deps?.beforeCreateOrUpdateReview?.(evidence);
        const reviewability = await evaluateSourceReviewability(candidate, sourceAgent.id);
        if (!reviewability.reviewable) {
          if (reviewability.terminal) {
            await recordTerminalSourceSuppression(evidence, reviewability.status);
            result.suppressedTerminalSource += 1;
          } else {
            result.skipped += 1;
          }
          continue;
        }
        const outcome = await createOrUpdateReview(evidence, { prefix, thresholds });
        if (outcome.kind === "created") result.created += 1;
        else if (outcome.kind === "updated") result.updated += 1;
        else if (outcome.kind === "skipped") result.skipped += 1;
        else if (outcome.kind === "monitor_suppressed") result.monitorScheduledSuppressed += 1;
        else if (outcome.kind === "creation_capped") result.creationCapped += 1;
        else if (outcome.kind === "no_action_suppressed") result.noActionSuppressed += 1;
        else result.existing += 1;
        if (outcome.reviewIssueId) result.reviewIssueIds.push(outcome.reviewIssueId);
      } catch (err) {
        result.failed += 1;
        result.failedIssueIds.push(candidate.id);
        logger.warn(
          {
            err,
            companyId: candidate.companyId,
            issueId: candidate.id,
            requestDepth: candidate.requestDepth,
          },
          "productivity review reconciliation skipped malformed candidate",
        );
      }
    }

    return result;
  }

  async function isProductivityReviewContinuationHoldActive(input: {
    companyId: string;
    issueId: string;
    agentId: string;
    now?: Date;
    thresholds?: Partial<ProductivityReviewThresholds>;
  }) {
    const now = input.now ?? new Date();
    const thresholds = buildThresholds(input.thresholds);
    const [sourceIssue, sourceAgent, openReview] = await Promise.all([
      db
        .select()
        .from(issues)
        .where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.issueId)))
        .then((rows) => rows[0] ?? null),
      getAgent(input.agentId),
      findOpenProductivityReview(input.companyId, input.issueId),
    ]);
    if (!sourceIssue || !sourceAgent || !openReview) return { held: false as const };
    if (sourceAgent.companyId !== input.companyId) return { held: false as const };
    const evidence = await collectEvidence(sourceIssue, sourceAgent, thresholds, now);
    if (!evidence || isMonitorScheduledSuppression(evidence) || isApprovalGatedSuppression(evidence)) {
      return { held: false as const };
    }
    if (!isSoftStopTrigger(evidence.trigger) || evidence.routineOnlySamplingWindow) {
      return { held: false as const };
    }
    return {
      held: true as const,
      reviewIssueId: openReview.id,
      reviewIdentifier: openReview.identifier,
      trigger: evidence.trigger,
      reason: evidence.triggerReasons.join("; "),
    };
  }

  async function recordContinuationHold(input: {
    companyId: string;
    issueId: string;
    runId: string;
    agentId: string;
    reviewIssueId: string;
    trigger: ProductivityReviewTrigger;
    reason: string;
  }) {
    await logActivity(db, {
      companyId: input.companyId,
      actorType: "system",
      actorId: "system",
      agentId: input.agentId,
      runId: input.runId,
      action: "issue.productivity_review_continuation_held",
      entityType: "issue",
      entityId: input.issueId,
      details: {
        source: "productivity_review.continuation_hold",
        reviewIssueId: input.reviewIssueId,
        trigger: input.trigger,
        reason: input.reason,
      },
    });
  }

  return {
    reconcileProductivityReviews,
    countResolvedProductivityReviews,
    isProductivityReviewContinuationHoldActive,
    recordContinuationHold,
  };
}
