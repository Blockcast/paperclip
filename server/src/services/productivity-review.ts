import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, notInArray, or, sql } from "drizzle-orm";
import type { Db, DbTransaction } from "@paperclipai/db";
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
import { countRunsOccupyingSlots, resolveEffectiveMaxConcurrentRuns } from "./agent-concurrency.js";
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
  listResolvedTerminalGates,
  readIssueMonitorGateSignals,
} from "./terminal-gate-reconciler.js";
import {
  recoveryAssigneeAdapterOverrides,
  withRecoveryModelProfileHint,
} from "./recovery/model-profile-hint.js";
import { RECOVERY_ORIGIN_KINDS } from "./recovery/origins.js";
import {
  PULL_REQUEST_WORK_PRODUCT_METADATA_SOURCE,
  PULL_REQUEST_WORK_PRODUCT_SOURCE_TRUST_ACTOR_ID,
} from "./pull-request-work-products.js";
import { resolveOwningPaperclipIdentifiers } from "./paperclip-identifiers.js";
import {
  isDependencyBlockedRun,
  isInfraFailureRun,
  runUsageTokenCounts,
} from "./recovery/zero-token-startup-failure.js";
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
/**
 * BLO-27698 A3: window in which an assignee `Next action:` comment counts as a
 * live progress signal, matching the "in the last 6h" wording in the Manager
 * Decision block below.
 *
 * Deliberately its own constant rather than `thresholds.longActiveMs`. Those two
 * numbers happen to share the 6h default, but they answer different questions —
 * one is the bar an episode must cross to be *reviewed*, the other is how far
 * back evidence stays *relevant*. Keying the evidence lookback off the trigger
 * bar meant raising the bar silently widened the search, so an operator tuning
 * `longActiveMs` up to 12h would also, invisibly, have started accepting 12h-old
 * comments as current. Not overridable: it tracks the rubric text a human
 * reviewer is asked to apply, so drifting it out of step with that wording would
 * make the printed criterion and the evaluated one disagree.
 */
export const PRODUCTIVITY_REVIEW_NEXT_ACTION_COMMENT_FRESH_MS = 6 * 60 * 60 * 1000;
/**
 * BLO-27698 A2: window in which an issue the assignee filed against this one
 * counts as a progress signal. Shared with `PRODUCTIVITY_REVIEW_PR_FRESH_MS` by
 * intent, not coincidence — A2 suppresses "on the same terms as A1", so the two
 * deliverable-shaped progress signals must age out together. A reader comparing
 * the two gates should not have to check whether 24h means the same 24h.
 */
const PRODUCTIVITY_REVIEW_LINKED_ISSUE_FRESH_MS = PRODUCTIVITY_REVIEW_PR_FRESH_MS;
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
// service's module graph. BLO-30087 exports it so a drift guard can pin it
// against the sweeper's own bound — the three consumers of this heuristic have
// already drifted apart once.
export const NON_LIVE_EXECUTION_SILENCE_MS = 2 * 60 * 60 * 1000;
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

/**
 * BLO-27698 B2: the one dominance shape, shared by both mechanisms that can
 * account for an episode instead of assignee inactivity — no-executable-turn
 * time (BLO-23248/BLO-23624) and executing time (B1). Extracted rather than
 * re-written so a change to what "dominant" means cannot apply to one and not
 * the other, which would leave the two gates disagreeing about the same
 * episode.
 */
function isDominantEpisodeShare(partMs: number, elapsedMs: number | null) {
  return elapsedMs !== null && elapsedMs > 0 && partMs / elapsedMs > NO_EXECUTABLE_TURN_DOMINANT_SHARE;
}
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
const PRODUCTIVITY_REVIEW_SUPPRESSED_ACTION = "issue.productivity_review_suppressed";
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
  | "runtime_failure_streak"
  // BLO-27698 B3b: one run that has been executing, uninterrupted and still
  // live, for at least `longActiveMs`. Distinct from `long_active_duration`,
  // which after B3 measures only time nobody was accounting for — a runaway run
  // is the opposite shape (the turn was taken and never given back).
  | "runaway_execution";

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

// BLO-22887 AC2. Deliberately a STATE record, not a duration: the readiness
// map carries blocker ids and counts, never the edge's own age, so there is no
// honest "blocked for N hours" figure to compute from it — and inventing one
// by scanning `issueRelations` or `latestRuns` was the defect that sank the
// first attempt at this (PR #1361: an unbounded `latestRuns.find` against a
// 100-run cap, so an older park silently read as absent). The line's job is to
// tell a reviewer that the control plane independently classified this issue
// as dependency-blocked while the elapsed split was calling the same wall-clock
// "unattended". That disagreement is the whole finding; the arithmetic is not.
type DependencyGating = {
  unresolvedBlockerCount: number;
  /** Subset that are `done` but whose execution workspace has not finalized. */
  pendingFinalizeBlockerCount: number;
  // The fired triggers an unresolved blocker does NOT excuse — i.e. the reason
  // this review survived the suppression gate. Never empty on a rendered line:
  // an all-closable set is suppressed before the body is built.
  nonClosableTriggers: ProductivityReviewTrigger[];
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
  /**
   * Whether this PR names the source issue as an OWNER, rather than merely
   * mentioning it (PEN-3219).
   *
   * A `pull_request` work product is written for every issue a PR references
   * anywhere, so holding one is not evidence that the PR is work on the issue
   * holding it. A long-lived registry/invariant row accumulates every PR that
   * name-drops it: PEN-2370 carried 44 such rows, none of them its own work.
   * Without this flag the most recently *touched* member of that pile became
   * the row's progress signal, and the review then told its reviewer that
   * "the second signal is already present" — licensing a "close as productive"
   * verdict on a `critical` row that had been dark for seven days.
   */
  ownsSourceIssue: boolean;
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
  /** PR head branch, from metadata — an ownership tier for legacy rows. */
  branch: string | null;
  /**
   * Owning identifiers recorded by the webhook at write time, or null on rows
   * written before that field existed. Null means "not recorded", NOT "owns
   * nothing" — see `pullRequestOwnsIssue`.
   */
  owningIdentifiers: unknown;
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
  // These runs had nothing capable of writing a comment. Reported separately
  // from `runtimeFailureStreak` so the evidence block can tell a reviewer "this
  // many runs never had a chance to comment" apart from "this many runs
  // executed and stayed silent." The two populations overlap in production —
  // a pre-adapter setup failure IS classified (`livenessState: "failed"`) and
  // so is usually caught by the runtime-failure heuristic too — which is why
  // `nonExecutingAlsoNeverInvokedCount` measures the intersection rather than
  // assuming disjointness.
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
    // BLO-27698 B1: episode time a run was demonstrably executing, taken out of
    // `unattendedMs` (never out of `gatedMs`). The three buckets partition the
    // episode: `gatedMs + executingMs + unattendedMs === elapsedMs`.
    executingMs: number;
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
    // BLO-27698 A4: set (to the same instant as `lapsedAt`) when the monitor's
    // scheduled check has passed but is still inside `monitorLapseServiceGraceMs`
    // — the same window `deliberatePendingMonitor` treats as pending. Reporting
    // only; see `monitorGatingBreakdown` for why it is deliberately not folded
    // into `gatedIsUpperBound`.
    awaitingServiceSince: Date | null;
  } | null;
  // BLO-23248/BLO-23624: elapsed time attributable to a no-executable-turn
  // run — the union of capacity park, dispatch backlog, and zero-token
  // throttle (see the constants above) — a third bucket distinct from
  // monitor-gated and unattended time. null when no run in the episode
  // classifies as one of those three mechanisms.
  noExecutableTurnGating: NoExecutableTurnGating | null;
  // BLO-22887 AC2: the dependency-blocked bucket, reported alongside — never
  // folded into — the monitor-gated/unattended split. Populated only on the
  // generation path (`reconcileProductivityReviews`), from the readiness map
  // that path already computes for BLO-22436's suppression gate;
  // `collectEvidence` deliberately does not fetch it (see the note at the top
  // of that function — its other caller must not see dependency state at all,
  // and re-querying would put a second readiness round-trip on the
  // continuation-hold path for a field that path never renders).
  //
  // Null whenever the source has no unresolved blocker, so the line's presence
  // is itself a signal. Every blocked source that reaches the body builder is
  // by construction one whose fired-trigger set is NOT dependency-closable —
  // the closable case is suppressed outright at generation — i.e. exactly
  // AC2's "still warranted on other grounds".
  dependencyGating: DependencyGating | null;
  // BLO-27698 C1: the assignee's live slot occupancy at evidence time —
  // `running` runs against the ceiling the dispatcher actually enforces. The
  // four fallback verdicts on a `long_active_duration` review all presuppose an
  // agent that had a turn and used it poorly; a saturated agent had no turn to
  // use, and until now a reviewer had to reconstruct that from Kubernetes. Null
  // only when the effective ceiling cannot be resolved from the agent row.
  //
  // `runningRunCount` counts the agent's `running` rows that still occupy a
  // slot, company-wide and NOT just this issue — saturation is an agent-level
  // property and the whole point is that the other slots are held by *other*
  // issues. Stale/silent rows are excluded by the same predicate the
  // dispatcher's slot gate applies (`isRunOccupyingSlot`), so this cannot
  // report saturation while dispatch would still admit a turn. It is the DB's
  // view of live runs, deliberately not a Kubernetes read, and the rendered
  // line says so rather than implying a cluster probe.
  assigneeConcurrency: {
    runningRunCount: number;
    maxConcurrentRuns: number;
    effectiveMaxConcurrentRuns: number;
    concurrencyEnabled: boolean;
    externalLifecycle: boolean;
  } | null;
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

const MONITOR_SCHEDULED_SUPPRESSION_ACTORS = new Set(["assignee", "board", "manager"]);

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

/**
 * Batched `issueRunScopeSql` — same three columns, one query for many issues.
 * Used by the retirement sweep, which resolves run liveness for every open
 * `runaway_execution` review at once rather than per review.
 */
function issueRunScopeInSql(issueIds: string[]) {
  return or(
    inArray(heartbeatRuns.contextIssueId, issueIds),
    inArray(heartbeatRuns.contextTaskId, issueIds),
    inArray(heartbeatRuns.contextTaskKey, issueIds),
  );
}

/** The source issue a run row is scoped to, for grouping a batched scope read. */
function runScopeIssueIds(run: HeartbeatRunRow) {
  return [run.contextIssueId, run.contextTaskId, run.contextTaskKey].filter(
    (id): id is string => Boolean(id),
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
 * BLO-22436: the span a run was demonstrably executing.
 *
 * Used only to protect the no-executable-turn buckets from over-exclusion. A
 * run sitting `queued` while a *different* run works the same issue is not a
 * missing turn — the assignee had one, on the sibling row — so that overlap has
 * to come back out of `noExecutableTurnMs` before it suppresses the trigger.
 *
 * Liveness matches `nonLiveExecutionHoldSince`: a `running` row counts until it
 * goes silent past NON_LIVE_EXECUTION_SILENCE_MS, and one carrying a past
 * `scheduledRetryAt` starts at that park boundary rather than at its preserved
 * pre-park `startedAt`, for the reason `liveSegmentStartedAt` documents —
 * otherwise a promoted row's live span would swallow its own park.
 */
function runLiveInterval(run: HeartbeatRunRow, now: Date): { start: number; end: number } | null {
  const startedAt = coerceDate(run.startedAt);
  if (!startedAt || Number.isNaN(startedAt.getTime())) return null;
  const parkEndedAt = liveSegmentStartedAt(run, now);
  const start = parkEndedAt && parkEndedAt.getTime() > startedAt.getTime() ? parkEndedAt : startedAt;

  const lastSignal = latestDate(run.lastUsefulActionAt, run.lastOutputAt, startedAt);
  let end: Date | null;
  if (TERMINAL_RUN_STATUSES.includes(run.status as (typeof TERMINAL_RUN_STATUSES)[number])) {
    end = coerceDate(run.finishedAt) ?? lastSignal;
  } else if (run.status === "running") {
    const silentFrom = lastSignal ? lastSignal.getTime() + NON_LIVE_EXECUTION_SILENCE_MS : now.getTime();
    end = new Date(Math.min(now.getTime(), silentFrom));
  } else {
    // queued / scheduled_retry carrying a startedAt: a row that executed and has
    // since re-parked. Its live span ended at its last signal.
    end = lastSignal;
  }
  if (!end) return null;
  return end.getTime() > start.getTime() ? { start: start.getTime(), end: end.getTime() } : null;
}

/**
 * The shared "still signalling" test: a live span that still reaches `now`.
 *
 * Written against the span rather than the run so its two consumers cannot
 * drift — `siblingStillExecuting` (episode attribution) and `liveExecutingMs`
 * (B3b). The tail clamp in `liveExecutingMs` is provably a no-op only while
 * those two tests are identical; a comment was carrying that coupling (Ally
 * review on 06b87852), so it is structural here instead.
 */
function stillSignalling(
  span: { start: number; end: number } | null,
  now: Date,
): span is { start: number; end: number } {
  return span !== null && span.end >= now.getTime();
}

/** Milliseconds of `[start, end)` not covered by any span in `liveSpans`. */
function msOutsideLiveSpans(start: number, end: number, liveSpans: { start: number; end: number }[]) {
  if (end <= start) return 0;
  const overlapping = liveSpans
    .map((span) => ({ start: Math.max(span.start, start), end: Math.min(span.end, end) }))
    .filter((span) => span.end > span.start)
    .sort((a, b) => a.start - b.start);

  let covered = 0;
  let cursor = start;
  for (const span of overlapping) {
    if (span.start > cursor) cursor = span.start;
    if (span.end > cursor) {
      covered += span.end - cursor;
      cursor = span.end;
    }
  }
  return end - start - covered;
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

  // BLO-22436: subtract any span a *different* run was demonstrably executing.
  // Without this, one stray `queued` sibling of a live run covers almost the
  // whole episode — the segment below runs from that row's `createdAt` to
  // `attributableEndAt` regardless of what else was happening — and the
  // dominant-share test then suppresses `long_active_duration` outright. A
  // freshly-enqueued run is the normal state of an actively-woken issue, so
  // unguarded this desensitizes the trigger on exactly the issues that *are*
  // running. Measured on the BLO-25722 overlap case: 6h 50m of a 7h episode
  // excluded while a run was live throughout, `created` 1 → 0.
  const liveSpans = chronological
    .map((run) => runLiveInterval(run, now))
    .filter((span): span is { start: number; end: number } => span !== null);

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
    const segmentMs = msOutsideLiveSpans(segmentStart.getTime(), segmentEnd.getTime(), liveSpans);
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
  attributableStartAt: Date | null,
  elapsedMs: number | null,
  now: Date,
  latestRuns: HeartbeatRunRow[],
  thresholds: ProductivityReviewThresholds,
) {
  if (elapsedMs === null || !attributableStartAt) return null;
  const armedUntil = coerceDate(issue.monitorNextCheckAt);
  const lastTriggeredAt = coerceDate(issue.monitorLastTriggeredAt);

  // BLO-27698 B1: time a run was demonstrably executing is neither a deliberate
  // monitor-gated wait nor an unattended stall — the assignee had its turn and
  // was taking it. Reported as a third bucket so a manager reading the split
  // does not have to reconstruct it from run rows.
  //
  // Scoped to the *unwatched* window: the monitor-gated prefix keeps its overlap,
  // and only the suffix nobody was accounting for is split into executing vs
  // unattended. That is the question the split exists to answer — "nobody was
  // watching; was anything still happening?" — and executing time inside the
  // gated prefix is unremarkable, because the monitor was accounting for it.
  //
  // Leaving the gated prefix whole also keeps `unattendedMs + executingMs`
  // exactly equal to the pre-B1 `unattendedMs`, which is what lets the BLO-22331
  // AC2 suppression gate below stay bit-identical while this lands. Reporting
  // only: B3 is the separate change that makes the trigger fire on the narrowed
  // bucket, and folding it in here is the compute-without-consult failure
  // BLO-27225 documents.
  const episodeStartMs = attributableStartAt.getTime();
  const episodeEndMs = episodeStartMs + elapsedMs;
  const liveSpans = latestRuns
    .map((run) => runLiveInterval(run, now))
    .filter((span): span is { start: number; end: number } => span !== null);
  /** Splits an episode whose monitor-gated prefix is `gatedMs` into the three buckets. */
  const splitExecuting = (gatedMs: number) => {
    const boundaryMs = Math.min(episodeEndMs, episodeStartMs + gatedMs);
    const executingMs =
      episodeEndMs > boundaryMs
        ? episodeEndMs - boundaryMs - msOutsideLiveSpans(boundaryMs, episodeEndMs, liveSpans)
        : 0;
    return { gatedMs, executingMs, unattendedMs: Math.max(0, elapsedMs - gatedMs) - executingMs };
  };

  // Still armed for a future check. There is no arm-time column, so a monitor
  // armed seconds ago is indistinguishable from one armed at `attributableStartAt`
  // and the whole episode is attributed to gating — flagged as an upper bound,
  // because reporting it flat would tell a manager that a 15h stall was fully
  // accounted for when only the last 90s provably was.
  if (armedUntil && armedUntil.getTime() > now.getTime()) {
    return {
      ...splitExecuting(elapsedMs),
      lapsedAt: null,
      priorLapseAt: null,
      armedUntil,
      gatedIsUpperBound: true,
      firedAt: null,
      successorRunId: null,
      awaitingServiceSince: null,
    };
  }

  // A monitor ran at some point and has since lapsed. Coverage ended at the
  // later of its last trigger and its last scheduled check.
  const lapseCandidates = [lastTriggeredAt, armedUntil].filter((d): d is Date => Boolean(d));
  if (lapseCandidates.length === 0) {
    return {
      ...splitExecuting(0),
      lapsedAt: null,
      priorLapseAt: null,
      armedUntil: null,
      gatedIsUpperBound: false,
      firedAt: null,
      successorRunId: null,
      awaitingServiceSince: null,
    };
  }
  const lapsedAt = new Date(Math.max(...lapseCandidates.map((d) => d.getTime())));

  // Coverage that ended before this episode began belongs to a prior episode:
  // none of this episode was gated, and calling it an in-episode lapse would
  // print a timestamp from before `attributableStartAt`.
  if (lapsedAt.getTime() <= attributableStartAt.getTime()) {
    return {
      ...splitExecuting(0),
      lapsedAt: null,
      priorLapseAt: lapsedAt,
      armedUntil: null,
      gatedIsUpperBound: false,
      firedAt: null,
      successorRunId: null,
      awaitingServiceSince: null,
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

  const gatedMs = Math.min(elapsedMs, lapsedAt.getTime() - attributableStartAt.getTime());
  // BLO-27698 A4: a monitor whose scheduled check has only just passed has not
  // "lapsed" — it is waiting on the dispatcher, inside the same
  // `monitorLapseServiceGraceMs` window `deliberatePendingMonitor` already
  // honours for suppression. Reporting that as "never re-armed" tells a manager
  // nobody is watching when dispatch is merely still due, so suppression and
  // reporting disagree about what lapsed means.
  //
  // Deliberately a separate display-only field rather than routing this case
  // into the still-armed branch above, which is what a literal reading of the AC
  // would do: that branch reports `gatedIsUpperBound: true`, and the BLO-22331
  // AC2 guard below only subtracts the *measured* unattended component
  // (`!gatedIsUpperBound`). Flipping this case into it would skip that guard
  // entirely and fire the very `long_active_duration` review the current code
  // correctly suppresses. Bucket math and `gatedIsUpperBound` are untouched here
  // on purpose.
  const awaitingServiceSince =
    armedUntil !== null && now.getTime() - lapsedAt.getTime() <= thresholds.monitorLapseServiceGraceMs
      ? lapsedAt
      : null;
  return {
    ...splitExecuting(gatedMs),
    lapsedAt,
    priorLapseAt: null,
    armedUntil: null,
    gatedIsUpperBound: false,
    firedAt: armedUntil === null ? lapsedAt : null,
    successorRunId,
    awaitingServiceSince,
  };
}

function formatMonitorGating(gating: NonNullable<ProductivityReviewEvidence["monitorGating"]>) {
  // An upper-bound gated figure implies a lower-bound unattended figure; both
  // carry a qualifier so neither half of the split reads as measured.
  const gated = `${gating.gatedIsUpperBound ? "≤" : ""}${msToHumanFine(gating.gatedMs)} monitor-gated`;
  const unattended = `${gating.gatedIsUpperBound ? "≥" : ""}${msToHumanFine(gating.unattendedMs)} unattended`;
  // BLO-27698 B1: executing time is measured from run spans, so it carries no
  // qualifier even when the gated half is an upper bound. Omitted entirely at
  // zero so the common no-overlap case reads exactly as it did before.
  const executing = gating.executingMs > 0 ? `${msToHumanFine(gating.executingMs)} executing, ` : "";
  const split = `${gated}, ${executing}${unattended}`;
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
  if (gating.awaitingServiceSince) {
    return `${split} (monitor came due at ${gating.awaitingServiceSince.toISOString()} and is still inside the dispatch service grace, so its wake has not been missed yet)`;
  }
  if (gating.lapsedAt) return `${split} (monitor lapsed at ${gating.lapsedAt.toISOString()}, never re-armed)`;
  if (gating.priorLapseAt) {
    return `${split} (no monitor armed during this episode; previous monitor lapsed at ${gating.priorLapseAt.toISOString()}, before it began)`;
  }
  return `${split} (no monitor armed during this episode)`;
}

// BLO-22887 AC2: the dependency-blocked bucket, rendered next to the elapsed
// split rather than subtracted from it. Reports blocker state and says so —
// see `DependencyGating` for why there is no honest span to report here, and
// why claiming one would be worse than the bug this replaces.
function formatDependencyGating(
  gating: NonNullable<ProductivityReviewEvidence["dependencyGating"]>,
  // Whether the `Elapsed accounting` split is rendered above this line. It is
  // conditional on `monitorGating`, which is null whenever `elapsedMs` is —
  // i.e. for every `todo` candidate, the most ordinary dependency-blocked
  // shape there is — so the caveat below must not point at a figure that is
  // not on the page (Ally review, PR #1722).
  elapsedSplitRendered: boolean,
) {
  const blockers = `${gating.unresolvedBlockerCount} unresolved \`blockedBy\` ${
    gating.unresolvedBlockerCount === 1 ? "blocker" : "blockers"
  } at this evidence pass`;
  const finalize = gating.pendingFinalizeBlockerCount > 0
    ? ` (${gating.pendingFinalizeBlockerCount} \`done\` but awaiting workspace finalize)`
    : "";
  // Explains the line's own presence. Without it the line reads as a
  // contradiction of BLO-22436's suppression — "blocked, so why am I looking
  // at this?" — which is the question that makes a reviewer close a real
  // high-churn or runtime-failure review as a false positive.
  const survived = gating.nonClosableTriggers.length > 0
    ? `; reviewed anyway because ${gating.nonClosableTriggers.map((trigger) => `\`${trigger}\``).join(", ")} fired, which an unresolved blocker does not excuse`
    : "";
  // Names NO individual bucket of the elapsed split, deliberately. This read
  // "read their unattended portion as covering dependency-blocked time", which
  // was written when the split had exactly two buckets and dependency-blocked
  // time could only land in `unattended`. B1 (BLO-27698) adds an `executing`
  // bucket that absorbs some of it, so on a 30m episode with a blocker
  // unresolved throughout, the split can render `0m unattended` and a manager
  // applying the old wording literally concludes there was no
  // dependency-blocked time — the opposite of the truth, reached by following
  // the caveat correctly. Point at the figures collectively so a bucket added
  // later cannot empty the one this names. Do not re-add a bucket name.
  const caveat = elapsedSplitRendered
    ? "the elapsed figures above are wall-clock and are NOT reduced by this, so dependency-blocked time of unrecorded length is already inside them"
    : "no elapsed split was computed for this episode, so there is no wall-clock figure this reduces";
  return `${blockers}${finalize}${survived} — blocker state at this pass, not a measured span: ${caveat}`;
}

function isFreshPullRequest(pr: PullRequestEvidence | null): pr is PullRequestEvidence {
  return pr !== null && pr.ageMs <= PRODUCTIVITY_REVIEW_PR_FRESH_MS;
}

// Deliberately NOT a type predicate: a false result means "not progress", not
// "null", so narrowing `pr` to null on the false branch (as `pr is
// PullRequestEvidence` would) makes the unattributed fall-through in
// `pullRequestProgressNote` read as `never` and fails the build.
function isProgressPullRequest(pr: PullRequestEvidence | null): boolean {
  return (
    isFreshPullRequest(pr) &&
    PRODUCTIVITY_REVIEW_PROGRESS_PR_STATUSES.has(pr.status) &&
    // PEN-3219: attribution, not just movement. The webhook proves the PR
    // moved; it says nothing about whether THIS row moved. Every consumer of
    // this predicate treats a true result as concrete progress on the source
    // issue — the "second signal is already present" note in the Manager
    // Decision block, and any suppression gate that declines to file a review
    // at all — so an unattributed PR here is a counterfeit progress signal
    // that defeats the exact failure mode a productivity review exists to
    // catch. Checked in the predicate rather than at each call site so a
    // consumer added later inherits it.
    pr.ownsSourceIssue
  );
}

/**
 * Does this PR work product belong to the issue holding it?
 *
 * Prefers the owning set the webhook recorded at write time. Rows written
 * before that field existed fall back to re-deriving ownership from the two
 * tiers the row still carries — the PR title and its head branch. The PR body
 * is never persisted on the row, so a legacy PR that claims its issue ONLY in
 * a labeled body line (`Fixes: PEN-1234`) cannot be recognised here and loses
 * the progress signal until its next `pull_request` event rewrites the row.
 * That direction is the safe one: it withholds a progress signal rather than
 * manufacturing one.
 */
function pullRequestOwnsIssue(row: PullRequestEvidenceRow, sourceIdentifier: string | null): boolean {
  if (!sourceIdentifier) return false;
  const recorded = row.owningIdentifiers;
  // An empty recorded array IS authoritative — the PR named no owner anywhere,
  // so it is attributable to nothing. Only null/absent means "not recorded".
  if (Array.isArray(recorded)) {
    return recorded.some((value) => typeof value === "string" && value === sourceIdentifier);
  }
  return resolveOwningPaperclipIdentifiers({
    title: row.title,
    branch: row.branch,
  }).owning.includes(sourceIdentifier);
}

function toPullRequestEvidence(
  row: PullRequestEvidenceRow | null,
  now: Date,
  sourceIdentifier: string | null,
): PullRequestEvidence | null {
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
    ownsSourceIssue: pullRequestOwnsIssue(row, sourceIdentifier),
  };
}

/**
 * Render the linked PR for the evidence pack (BLO-19566 AC4). Reads "none
 * recorded" only when the issue genuinely has no PR work product -- which is
 * now a real signal rather than, as before, the only possible output.
 *
 * PEN-3219: reports attribution alongside freshness and status. The PR is
 * still shown when it belongs to another issue — suppressing it would hide
 * real information from the reviewer — but it is labelled, so the line cannot
 * be read as progress on this row.
 */
function formatPullRequestEvidence(pr: PullRequestEvidence | null) {
  if (!pr) return "none recorded";
  const ref = pr.url ?? pr.externalId ?? pr.title;
  const freshness = isFreshPullRequest(pr) ? "non-stale" : "stale";
  const progress = PRODUCTIVITY_REVIEW_PROGRESS_PR_STATUSES.has(pr.status)
    ? "progress-eligible"
    : "not progress-eligible";
  const attribution = pr.ownsSourceIssue
    ? "attributed to this issue"
    : "NOT attributed to this issue";
  return `${ref} \`${pr.status}\`, last activity ${pr.updatedAt.toISOString()} (${msToHuman(pr.ageMs)} ago, ${freshness}, ${progress}, ${attribution})`;
}

/**
 * The Manager Decision note about the linked PR.
 *
 * Three outcomes, not two (PEN-3219). The affirmation is unchanged for a PR
 * that owns this row. A PR that moved recently but belongs to another issue
 * now gets an explicit warning rather than silence: staying quiet would leave
 * the reviewer reading a `Linked pull request:` line that looks like progress
 * with nothing telling them it is not theirs, which is how PEN-3216 reached a
 * reviewer recommending "close as productive" on a `critical` row that had
 * been dark for seven days.
 */
function pullRequestProgressNote(pr: PullRequestEvidence | null): string[] {
  if (isProgressPullRequest(pr)) {
    return [
      "",
      `> The second signal is already present: ${formatPullRequestEvidence(pr)}.`,
      "> PR activity is recorded from the GitHub webhook, so this is deliverable progress even",
      "> when the run/comment counters above read zero.",
    ];
  }
  const movedButUnattributed =
    pr !== null &&
    isFreshPullRequest(pr) &&
    PRODUCTIVITY_REVIEW_PROGRESS_PR_STATUSES.has(pr.status) &&
    !pr.ownsSourceIssue;
  if (!movedButUnattributed) return [];
  return [
    "",
    `> A linked PR moved recently, but it is NOT attributed to this issue: ${formatPullRequestEvidence(pr)}.`,
    "> A PR work product is recorded against every issue the PR mentions anywhere, so this row",
    "> holding it is not evidence that anyone worked on THIS issue. The webhook proves the PR",
    "> moved; it says nothing about whether this row moved.",
    "> This does NOT satisfy the second signal. Do not treat it as grounds for \"Close as productive\".",
  ];
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

// BLO-27698 C2: whether the evidence pack itself shows the assignee was denied
// an executable turn, from the two signals this service already measures — live
// slot saturation (C1) and no-executable-turn time (BLO-23624). Deliberately
// NOT a new measurement and NOT a heuristic: the capacity verdict is offered
// only when one of those two already-computed facts is present, so it cannot
// become a blanket excuse for every slow episode.
//
// The `noExecutableTurn` arm does not require dominance. The dominance test
// gates *suppression* — withholding the review entirely — and must stay strict.
// This gates whether a human reviewer is *shown the option*, where a
// non-dominant but real capacity block is still the thing they need to know.
// What the cell then SAYS is graded by `hasEpisodeScopedCapacityBlock` — being
// shown the option and being told not to record under-performance are two
// different claims, and only the second needs episode-scoped evidence.
function isCapacityConstrainedEvidence(evidence: ProductivityReviewEvidence) {
  return (
    (evidence.assigneeConcurrency !== null
      && evidence.assigneeConcurrency.runningRunCount
        >= evidence.assigneeConcurrency.effectiveMaxConcurrentRuns)
    || (evidence.noExecutableTurnGating !== null
      && evidence.noExecutableTurnGating.noExecutableTurnMs > 0)
  );
}

// BLO-27698 C2 (Ally review on #1856): whether the evidence can carry the
// CATEGORICAL claim — "had no turn, none of the four verdicts applies" — across
// the whole episode. Only one of the two signals can:
//
//   - `noExecutableTurnGating` is episode-scoped by construction (clamped to
//     `[attributableStartAt, attributableEndAt)`), so a DOMINANT share of it
//     does describe the episode. Same predicate and same constant the
//     suppression gate uses, deliberately — one bar, two consumers.
//   - `assigneeConcurrency` is a single sample at `now` (see its field note).
//     Saturation at evidence time says nothing about the preceding hours.
//   - a NON-dominant no-executable-turn share is real but does not exonerate
//     the episode: ~30s of queue inside a 7h stall would otherwise emit a
//     blanket "do not record this as assignee under-performance".
//
// Neither weak case is dropped — `isCapacityConstrainedEvidence` still offers
// the cell — but they render as an unconfirmed partial block the reviewer must
// check, not as an exoneration.
function hasEpisodeScopedCapacityBlock(evidence: ProductivityReviewEvidence) {
  const { noExecutableTurnGating: gating, elapsedMs } = evidence;
  return Boolean(
    gating
      && elapsedMs !== null
      && elapsedMs > 0
      && gating.noExecutableTurnMs / elapsedMs > NO_EXECUTABLE_TURN_DOMINANT_SHARE,
  );
}

function describeCapacityConstraint(evidence: ProductivityReviewEvidence) {
  const parts: string[] = [];
  if (
    evidence.assigneeConcurrency
    && evidence.assigneeConcurrency.runningRunCount
      >= evidence.assigneeConcurrency.effectiveMaxConcurrentRuns
  ) {
    // "as of this evidence snapshot" is load-bearing, not hedging: this count
    // is read once at `now`, so stating it unqualified inside an episode-wide
    // verdict is an instant-to-episode leap. The C1 line scopes itself the
    // same way ("live", "while this held").
    parts.push(
      `all ${evidence.assigneeConcurrency.effectiveMaxConcurrentRuns} of the assignee's run slots occupied as of this evidence snapshot`,
    );
  }
  if (evidence.noExecutableTurnGating && evidence.noExecutableTurnGating.noExecutableTurnMs > 0) {
    parts.push(
      `${msToHuman(evidence.noExecutableTurnGating.noExecutableTurnMs)} of no-executable-turn time`,
    );
  }
  return parts.join("; ");
}

// BLO-27698 C1: the assignee's live slot occupancy, stated so a reviewer does
// not have to reconstruct it from Kubernetes. Says "running runs" rather than
// "pods" because it is a DB count, not a cluster probe — naming it "pods"
// would claim a measurement this service never takes. The count excludes
// stale/silent rows on the dispatcher's own predicate, so "saturated" here
// means dispatch would genuinely have refused a turn.
function formatAssigneeConcurrency(
  concurrency: NonNullable<ProductivityReviewEvidence["assigneeConcurrency"]>,
) {
  const { runningRunCount, effectiveMaxConcurrentRuns, maxConcurrentRuns } = concurrency;
  const saturated = runningRunCount >= effectiveMaxConcurrentRuns;
  // Only worth explaining the ceiling when the enforced value differs from the
  // configured one — otherwise the parenthetical is noise on every review.
  const ceilingClause =
    effectiveMaxConcurrentRuns === maxConcurrentRuns
      ? ""
      : concurrency.externalLifecycle && !concurrency.concurrencyEnabled
        ? ` (configured \`maxConcurrentRuns\` ${maxConcurrentRuns}, held to 1 because external-lifecycle \`concurrencyEnabled\` is off — BLO-15959)`
        : ` (configured \`maxConcurrentRuns\` ${maxConcurrentRuns}, bounded by the external-lifecycle slot ceiling)`;
  return `${runningRunCount}/${effectiveMaxConcurrentRuns} running runs against the dispatcher's enforced ceiling${ceilingClause}${
    saturated
      ? " — **saturated**: the assignee could not have been dispatched a turn on this issue while this held"
      : ""
  }`;
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
  runawayExecution: boolean;
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
  // BLO-27698 B3b: directly above `long_active_duration`, and that position is
  // the whole point. B3 narrows `long_active_duration` to the *unattended*
  // bucket, which by construction stops it firing on an episode a run spent
  // executing — so without a trigger that outranks it, a genuinely runaway run
  // would become undetectable instead of merely reclassified. Below the two
  // streak triggers and `high_churn` because those describe the whole sampled
  // window; this one describes a single run inside it.
  //
  // ⚠ Outranking `long_active_duration` also opts this trigger OUT of every
  // suppression gate keyed on `trigger === "long_active_duration"` — the
  // approval gate, `currentPendingMonitorForReviewSuppression`, the A1
  // progress-PR gate, and the final TOCTOU revalidation. That is deliberate,
  // not an oversight: those gates all answer "is this elapsed time explained by
  // something other than assignee inactivity?", and a run that has been
  // *live-executing* past the bar is burning real compute regardless of the
  // answer. It is the same argument this file already makes one line above for
  // `high_churn` — a human gate does not excuse cost being burned against it.
  // An armed monitor means "wake me later", not "this run may execute
  // indefinitely". Pinned by the monitor-armed + live-runaway test; if you ever
  // want a monitor to suppress this, change the test first — a silent flip here
  // would re-open exactly the indefinite-suppression hazard BLO-22331 AC2
  // forbids, from the other direction.
  if (input.runawayExecution) return "runaway_execution";
  if (input.longActive) return "long_active_duration";
  return null;
}

// Which open reviews hold an agent back from *continuing* onto more work.
// Scoped to the accumulation triggers — `no_comment_streak` and `high_churn`
// both say "you have already spent turns badly, stop taking more".
// Deliberately excluded:
//   - `long_active_duration` / `runaway_execution` — both describe a single
//     episode that is still in flight, not a pattern across turns. A
//     continuation hold cannot act on either: the hold is evaluated between
//     turns, while the run these describe is executing right now, so holding
//     would neither stop that run nor answer the review. `runaway_execution`
//     (BLO-27698 B3b) is excluded for exactly the reason it bypasses the
//     monitor gate — it is a runtime/cost alarm for a human to adjudicate, not
//     an automatic brake.
//   - `runtime_failure_streak` — infra faults; withholding the agent's next
//     turn punishes it for the platform's failure.
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
//   - `runaway_execution` (BLO-27698 B3b) — an unresolved blocker cannot explain
//     a run that is executing *right now*. The dependency gate cancels queued
//     runs before dispatch, so it produces absence of execution, never an
//     excess of it; a blocker added mid-run leaves the burn real and the alarm
//     valid. Fail-closed here is the deliberate answer, not an oversight.
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

// BLO-27515: which triggers a *resolved* terminal gate excuses. Only
// `long_active_duration`, and the scoping matters more here than it looks.
//
// A satisfied gate explains exactly one thing: the elapsed wall-clock was spent
// waiting on something that has since happened, and no assignee run was
// dispatched to notice. It explains nothing about conduct. `high_churn` and
// `runtime_failure_streak` are records of runs that did execute and did burn
// cost or fail; a pull request merging does not make either untrue.
// `no_comment_streak` is excluded too, unlike the dependency-blocked set above:
// a dependency gate *causes* silence by cancelling queued runs before dispatch,
// whereas a monitor gate does not stop the assignee from commenting — so
// silence under a resolved gate is still worth a manager's attention.
//
// Set form, and every trigger must be closable: a review that also fired a
// non-closable trigger still files.
//
// State the limit honestly rather than claiming more than the code does. This
// bounds an evasion; it does not close it. Three things stand between a
// declared gate and a silenced review: the set must be purely
// `long_active_duration` (any conduct trigger alongside it still files); the
// cited PR must be a webhook-promoted GitHub work product *of this issue*
// (`listResolvedTerminalGates`); and the suppression is bounded by
// `longActiveMs`. What remains open is that *any* such work product qualifies —
// an assignee whose issue legitimately owns a merged PR can arm a monitor on it
// after the fact and buy a bounded `long_active_duration` suppression it did
// not spend the time on. "Tied to the issue's intended work" is not mechanically
// expressible here, so the binding is webhook provenance, and that is weaker.
function isTerminalGateClosableTriggerSet(triggers: unknown) {
  return Array.isArray(triggers) && triggers.length > 0
    && triggers.every((trigger) => trigger === "long_active_duration");
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

// Exhaustive by type, not by if-ladder (Ally review on BLO-27698 2e95b50b): the
// previous form fell through to "Long active duration" as its default, so a new
// trigger would render under an existing trigger's name — a silently wrong
// evidence pack rather than a compile error. `runaway_execution` in particular
// would have been labelled as the very trigger it was split out from.
const TRIGGER_LABELS: Record<ProductivityReviewTrigger, string> = {
  no_comment_streak: "No-comment streak",
  long_active_duration: "Long active duration",
  high_churn: "High churn",
  runtime_failure_streak: "Runtime failure streak",
  runaway_execution: "Runaway execution",
};

function formatTrigger(trigger: ProductivityReviewTrigger) {
  return TRIGGER_LABELS[trigger];
}

const PRODUCTIVITY_REVIEW_TRIGGERS: readonly ProductivityReviewTrigger[] = [
  "no_comment_streak",
  "long_active_duration",
  "high_churn",
  "runtime_failure_streak",
  "runaway_execution",
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
// comment wake already exists. That helper is a four-item wake-reason
// whitelist (`issue_assigned`, `execution_review_requested`,
// `execution_approval_requested`, `execution_changes_requested`) sitting
// behind a fifth early exit for `contextSnapshot.skipIssueComment === true`,
// so it is narrower still than the wake list alone suggests. Keying the streak
// on the column made every `heartbeat_timer`, `issue_monitor_due`,
// `issue_comment_mentioned`, `issue_continuation_needed`, `process_lost_retry`
// and recovery-lane run structurally invisible to the silent-agent detector,
// whether or not it ran a full model turn. An agent could go silent across
// dozens of wakes and the streak would read zero. Comment *policy* and
// *invocation* are two different facts sharing one column; only this predicate
// tests the second one.
//
// Keyed on total absence of run telemetry rather than the `logBytes` ceiling
// heuristic `isInfraFailureRun` uses. `logStore`/`logRef` carry most of the
// weight: they are written immediately after `runLogStore.begin`, which is one
// of the first things the inner execution `try` does, so a setup failure that
// throws before that block opens leaves both null. An explicit zero-token
// `usageJson` means a session was created and measured (the BLO-21769 shape) —
// that run was invoked and belongs to `runtimeFailureStreak`, not here.
//
// This is a deliberately *conservative* proxy, not proof a container existed.
// The log store is opened before adapter resolution and well before
// `adapter.execute`, so an `adapter_failed` run that never resolved a container
// can still carry a non-null `logStore` and will be counted rather than
// excluded. That bias is the one we want: wrongly excluding a run recreates the
// false negative above (a silent agent reads as clean), while wrongly counting
// one produces a review a manager can read the evidence block and dismiss.
// Prefer counting.
//
// NOT keyed on `livenessState`, despite an earlier revision of this predicate
// opening with `if (run.livenessState != null) return false;` on the theory
// that the column is only ever written after the adapter completes. It is not:
// the setup-failure branch of the outer catch in `executeRun` calls
// `classifyAndPersistRunLiveness` for exactly these pre-adapter throws, and
// `classifyRunLiveness` (run-liveness.ts) returns `"failed"` for any
// non-`succeeded` run — it never returns null. `backfillMissingRunLivenessForIssue`
// (activity.ts) is a second writer that fills any remaining null on an ordinary
// issue-read path. The BLO-23096 rows therefore carry `livenessState: "failed"`,
// and that guard disqualified the exact population this predicate was written
// to catch, leaving it inert in production.
//
// Because those rows also satisfy `isInfraFailureRun` (failed liveness, null
// usage, log bytes under the boilerplate ceiling), this predicate is mostly a
// *subset* of `isNeverExecutedRun` rather than a widening of it. It still earns
// its keep twice: it separates "no adapter was ever created" from "the runtime
// failed after starting" in the manager-facing evidence block, and it catches
// the rows where liveness classification never landed at all — the setup-failure
// write is gated on the run still being `running`, and the backfill is
// scheduled asynchronously, so `livenessState: null` is reachable and
// `isInfraFailureRun` returns false for it.
function isNeverInvokedRun(
  run: Pick<HeartbeatRunRow, "usageJson" | "logBytes" | "logStore" | "logRef">,
): boolean {
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
type DbOrTx = Db | DbTransaction;

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
      action: PRODUCTIVITY_REVIEW_SUPPRESSED_ACTION,
      entityType: "issue",
      entityId: suppression.sourceIssue.id,
      details,
    });
    logger.info(details, "productivity review long_active_duration suppressed by pending approval gate");
  }

  /**
   * BLO-24022: identity of the monitor wait a suppression is reporting.
   *
   * The reconcile re-evaluates every ~30s (`heartbeatSchedulerIntervalMs`) and re-reaches the same
   * suppression decision each time, because nothing about the wait has changed — the monitor is
   * still armed for the same future check. Keying on that wait lets us write one audit row per
   * wait instead of one per tick.
   *
   * Deliberately excluded from the key:
   * - `elapsedMs` — grows monotonically every tick. Including it would make every key unique and
   *   defeat the dedupe entirely; it is the field that made these rows look like state changes.
   * - `monitorWakeRequestedAt` — a wake claim expires after
   *   `ISSUE_MONITOR_WAKE_CLAIM_TTL_MS` (5m) and is re-taken, which would re-open the same churn
   *   at 12 rows/hour per issue. The claim does not change *which* wait we are suppressing for.
   *
   * `monitorLastTriggeredAt` IS in the key: on the just-fired branch `monitorNextCheckAt` is null
   * (see `MonitorScheduledSuppression`), so it is the only field that distinguishes one fired
   * window from the next.
   */
  function monitorSuppressionWindowKey(details: {
    monitorNextCheckAt: string | null;
    monitorScheduledBy: string | null;
    monitorLastTriggeredAt: string | null;
  }) {
    return [
      details.monitorNextCheckAt ?? "none",
      details.monitorScheduledBy ?? "none",
      details.monitorLastTriggeredAt ?? "none",
    ].join("|");
  }

  async function latestMonitorScheduledSuppressionKey(
    executor: DbOrTx,
    input: { companyId: string; issueId: string },
  ) {
    const row = await executor
      .select({ details: activityLog.details })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.companyId, input.companyId),
          eq(activityLog.entityType, "issue"),
          eq(activityLog.entityId, input.issueId),
          eq(activityLog.action, PRODUCTIVITY_REVIEW_SUPPRESSED_ACTION),
        ),
      )
      .orderBy(desc(activityLog.createdAt), desc(activityLog.id))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!row) return null;
    const details = activityDetails(row.details);
    // A different suppression reason (approval_pending, terminal source) is a real state change,
    // so it must not be mistaken for an already-reported monitor wait.
    if (details.suppressedBy !== "monitor_scheduled") return null;
    const str = (value: unknown) => (typeof value === "string" ? value : null);
    return monitorSuppressionWindowKey({
      monitorNextCheckAt: str(details.monitorNextCheckAt),
      monitorScheduledBy: str(details.monitorScheduledBy),
      monitorLastTriggeredAt: str(details.monitorLastTriggeredAt),
    });
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
    // BLO-24022: only the first tick of a given monitor wait writes an audit row. Re-suppressing a
    // wait already on record is not a state change, and emitting it every ~30s drowned the
    // activity feed (46% of all company activity), which broke agent-health triage.
    //
    // Best-effort by design: this is a read-then-write without a lock, so two overlapping
    // reconciles (see the note on the 30s scheduler overlapping itself) can both miss the existing
    // row and write. That degrades to a small number of rows per wait rather than ~120/hour, which
    // is the whole point; an advisory lock is not worth taking for an audit row.
    const previousKey = await latestMonitorScheduledSuppressionKey(db, {
      companyId: suppression.sourceIssue.companyId,
      issueId: suppression.sourceIssue.id,
    });
    if (previousKey !== null && previousKey === monitorSuppressionWindowKey(details)) {
      logger.debug(
        details,
        "productivity review long_active_duration suppression already recorded for this monitor wait",
      );
      return false;
    }
    await logActivity(db, {
      companyId: suppression.sourceIssue.companyId,
      actorType: "system",
      actorId: "system",
      agentId: suppression.sourceIssue.assigneeAgentId,
      action: PRODUCTIVITY_REVIEW_SUPPRESSED_ACTION,
      entityType: "issue",
      entityId: suppression.sourceIssue.id,
      details,
    });
    logger.info(details, "productivity review long_active_duration suppressed by scheduled monitor");
    return true;
  }

  /**
   * BLO-27515: audit the suppression so a silenced review is still legible. The
   * detector reads only the recorded resolution — the gate itself was re-read
   * board-side by the terminal-gate reconciler, which also left a comment on
   * the source issue naming the resolved gate.
   */
  async function recordTerminalGateResolvedSuppression(
    sourceIssue: IssueRow,
    evidence: ProductivityReviewEvidence,
  ) {
    const details = {
      source: "productivity_review.reconcile",
      sourceIssueId: sourceIssue.id,
      trigger: evidence.trigger,
      firedTriggers: evidence.firedTriggers,
      suppressedBy: "terminal_gate_resolved",
      gateSignals: readIssueMonitorGateSignals(sourceIssue.executionState),
      elapsedMs: evidence.elapsedMs,
    };
    await logActivity(db, {
      companyId: sourceIssue.companyId,
      actorType: "system",
      actorId: "system",
      agentId: sourceIssue.assigneeAgentId,
      action: "issue.productivity_review_suppressed",
      entityType: "issue",
      entityId: sourceIssue.id,
      details,
    });
    logger.info(
      details,
      "productivity review long_active_duration suppressed by an already-resolved terminal gate (BLO-27515)",
    );
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
      // BLO-33477: rotate on the same least-recently-scanned watermark the
      // source candidate scan uses (BLO-30303), for the same reason. This loop
      // writes only to a review it *retires*; a review that is scanned and
      // correctly declined — its alarm still stands — has nothing written back,
      // so its `updatedAt` never advances. Under `asc(updatedAt)` the same
      // oldest-MAX_CANDIDATE_ISSUES declined rows therefore re-occupied the
      // window on every pass forever, and once the open-review population
      // passed the cap no review sorting behind them could ever be evaluated
      // for retirement. Those are exactly the reviews whose sources have since
      // gone `done` — dead alarms, each costing a manager run to triage by hand.
      //
      // Sharing `productivityScannedAt` with the source scan is safe: that scan
      // filters `originKind <> PRODUCTIVITY_REVIEW_ORIGIN_KIND` and this one
      // requires equality, so the two stamp strictly disjoint row sets and
      // neither can perturb the other's ordering.
      // `recoverStaleReservedProductivityReviews` reads a subset of these rows
      // but orders on `updatedAt` and never reads this column, so it is
      // unaffected either way (see the note on its own query).
      //
      // Coalesce to `createdAt` rather than sorting NULLS FIRST, for the reason
      // given at the source scan: NULLS FIRST is an absolute priority class, so
      // a sustained influx of new reviews would permanently preempt an
      // already-scanned one — the same starvation with a different victim.
      // Treating "created" as the implicit first touch makes the key a strict
      // FIFO, so every open review is reached within
      // ceil(N / MAX_CANDIDATE_ISSUES) passes at any population and arrival
      // rate. `updatedAt`/`id` only break ties within one watermark value; a
      // whole batch shares one `now`, so ties are common and must be stable.
      .orderBy(
        sql`coalesce(${issues.productivityScannedAt}, ${issues.createdAt}) asc`,
        asc(issues.updatedAt),
        asc(issues.id),
      )
      .limit(MAX_CANDIDATE_ISSUES);

    // Stamp before evaluating, not after: a review that throws mid-loop has
    // already rotated out, so one poison row cannot wedge the window forever.
    // A bare column write — it leaves `updatedAt` alone, so the
    // `issues_sync_last_activity_at` BEFORE UPDATE trigger (which fires only
    // when `updated_at` is distinct from OLD) stays quiet and the watermark
    // cannot masquerade as activity on the review.
    if (reviewRows.length > 0) {
      await db
        .update(issues)
        .set({ productivityScannedAt: now })
        .where(
          inArray(
            issues.id,
            reviewRows.map((review) => review.id),
          ),
        );
    }

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
    let closedExecutionEnded = 0;

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

    // BLO-27698 B3b (Ally review on 7f4fbc43b): resolve, for every open
    // `runaway_execution` review, whether the run it describes is still running.
    //
    // That trigger is the only one in the set whose subject is a single
    // in-flight run, and its rubric is entirely forward-looking — "let it
    // finish", "bound it", "route to platform/SRE" are all actions on a live
    // process. Its retirement predicate is therefore *the run ended*, and
    // source-`done` (the arm below) is a strictly narrower proxy for it: a run
    // that exits while its issue stays `in_progress`/`todo`/`blocked` would
    // strand an unanswerable review open indefinitely, because generation
    // cannot retire it either (`createOrUpdateReview` returns null the moment
    // no trigger fires, so an open review whose trigger stopped firing is never
    // revisited). Close on the predicate itself.
    //
    // Liveness is `runLiveInterval` + `stillSignalling`, the identical pair
    // `liveExecutingMs` applies in the generation path, so suppression and
    // retirement cannot drift on what "still executing" means — the same
    // discipline A4 applies to the monitor grace. When no run is still
    // signalling, `liveExecutingMs` is 0 by construction and so cannot clear
    // any positive bar; that is why this needs no threshold of its own.
    const runawayExecutionEndedSourceIds = new Set<string>();
    const runawaySourceIdsByCompany = new Map<string, Set<string>>();
    for (const review of reviewRows) {
      if (!review.originId) continue;
      if (reviewTriggerById.get(review.id) !== "runaway_execution") continue;
      const sourceIssue = sourceIssueById.get(review.originId);
      if (!sourceIssue || sourceIssue.companyId !== review.companyId) continue;
      const forCompany = runawaySourceIdsByCompany.get(review.companyId) ?? new Set<string>();
      forCompany.add(sourceIssue.id);
      runawaySourceIdsByCompany.set(review.companyId, forCompany);
    }
    for (const [runawayCompanyId, sourceIds] of runawaySourceIdsByCompany) {
      const scopedIds = [...sourceIds];
      // Only `running` rows can be live: `runLiveInterval` ends a terminal row
      // at `finishedAt` and a re-parked one at its last signal, so neither can
      // satisfy `stillSignalling`. Filtering in SQL keeps this read bounded by
      // the number of *live* runs rather than by run history.
      const liveRuns = await db
        .select()
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.companyId, runawayCompanyId),
            eq(heartbeatRuns.status, "running"),
            issueRunScopeInSql(scopedIds),
          ),
        );
      const stillExecutingSourceIds = new Set<string>();
      // Issue-scoped, not run-scoped, and chosen that way: the review does not
      // persist the run id it fired on, so keying per-run would mean adding that
      // to `details` first. The cost is a residue — a review that fired on run A
      // stays open while an unrelated later run B is live on the same source.
      // That is the fail-closed direction and it is self-clearing (the first
      // sweep with nothing live retires it), so it is bounded by an unrelated
      // run's lifetime rather than by the issue's, which is the bound the
      // predicate was tightened to buy.
      for (const run of liveRuns) {
        if (!stillSignalling(runLiveInterval(run, now), now)) continue;
        for (const scopeId of runScopeIssueIds(run)) {
          if (sourceIds.has(scopeId)) stillExecutingSourceIds.add(scopeId);
        }
      }
      for (const sourceId of sourceIds) {
        if (!stillExecutingSourceIds.has(sourceId)) runawayExecutionEndedSourceIds.add(sourceId);
      }
    }

    for (const review of reviewRows) {
      if (!review.originId) continue;
      const sourceIssue = sourceIssueById.get(review.originId) ?? null;
      if (!sourceIssue) continue;
      if (sourceIssue.companyId !== review.companyId) continue;
      const trigger = reviewTriggerById.get(review.id);

      let suppressedBy:
        | "terminal_source"
        | "monitor_scheduled"
        | "dependency_blocked"
        | "execution_ended"
        | null = null;
      let suppressionDetails: Record<string, unknown> = {};
      // A `done` source can retire an already-open long-active review: the work
      // episode finished under the terminal-status evidence gate, so the
      // elapsed-time alarm no longer needs manager adjudication. `runaway_execution`
      // rides the same arm for the same reason (BLO-27698 B3b, Ally review on
      // 2e95b50b): it is a runtime/cost alarm on a run that is executing *right
      // now*, so once the source reaches `done` that run has finished and every
      // option in its rubric — "let it finish", "bound it", "route to platform"
      // — is a question about a run that no longer exists. Leaving it open would
      // park an unanswerable review in a reviewer's queue.
      // For `runaway_execution` this arm is a *convenience*, not its predicate:
      // source-`done` implies the run ended, but the run can also end with the
      // source still open, and that case is retired by the `execution_ended`
      // arm below on the real predicate (Ally review on 7f4fbc43b). The two
      // overlap deliberately — this one costs no extra read when it applies.
      // This does not extend to `cancelled`; an assignee can abandon and later
      // restore their own source issue, so cancellation must not retire its
      // oversight artifact. It also does not extend to historical/accountability
      // triggers (`no_comment_streak`, `high_churn`) or missing provenance:
      // completion does not invalidate those signals, and unknown trigger
      // semantics fail closed.
      if (
        (trigger === "long_active_duration" || trigger === "runaway_execution")
        && sourceIssue.status === "done"
      ) {
        suppressedBy = "terminal_source";
        suppressionDetails = { sourceStatus: sourceIssue.status };
      } else if (
        trigger === "runaway_execution"
        && runawayExecutionEndedSourceIds.has(sourceIssue.id)
      ) {
        // The run this alarm describes has stopped executing. Unlike
        // `long_active_duration` — whose rubric ("what progress did the
        // assignee show") stays answerable after the episode ends, and which
        // keeps the `monitor_scheduled` arm — every option offered for a
        // runaway run is an instruction to a live process. Retire it rather
        // than asking a manager to bound a run that already exited.
        //
        // Deliberately NOT gated on `isTerminalIssueStatus`: the whole point is
        // that the source is usually still open here. A run that restarts and
        // clears the bar again simply re-fires a fresh review through
        // generation, so this cannot suppress a genuinely runaway run — it can
        // only retire the record of one that ended.
        suppressedBy = "execution_ended";
        suppressionDetails = { sourceStatus: sourceIssue.status };
      } else if (trigger === "long_active_duration" && !isTerminalIssueStatus(sourceIssue.status)) {
        // Deliberately monitor-only, and deliberately `long_active_duration`-only:
        // `runaway_execution` is excluded here because `choosePrimaryTrigger`
        // opts it out of the monitor gate by design (an armed monitor means
        // "wake me later", not "this run may execute indefinitely"). Honouring a
        // monitor here would re-suppress through the close path what the
        // generation path deliberately let fire.
        // An approval gate suppresses *new* reviews but never closes one
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
      // Explicit on every arm rather than falling through to
      // `closedMonitorScheduled`: that default silently mis-attributed any new
      // suppression reason to the monitor counter, which is the funnel
      // BLO-33477 AC4 added these counters to make legible.
      if (suppressedBy === "terminal_source") closedTerminalSource += 1;
      else if (suppressedBy === "dependency_blocked") closedDependencyBlocked += 1;
      else if (suppressedBy === "execution_ended") closedExecutionEnded += 1;
      else closedMonitorScheduled += 1;
    }
    const retiredCount =
      closedMonitorScheduled + closedTerminalSource + closedDependencyBlocked + closedExecutionEnded;
    return {
      monitorScheduled: closedMonitorScheduled,
      terminalSource: closedTerminalSource,
      dependencyBlocked: closedDependencyBlocked,
      executionEnded: closedExecutionEnded,
      // BLO-33477 AC4: funnel counters for the retirement pass. A sweep that
      // scans a full window and retires nothing is exactly what starvation
      // looks like, and without `scanned` it is indistinguishable from a
      // healthy sweep with nothing to do — the same blind spot that let
      // BLO-30303 read as normal for 23 days. `declined` is "scanned but not
      // retired", which folds in the early `continue`s (no origin, missing or
      // cross-company source, lost close race) as well as a standing alarm.
      scanned: reviewRows.length,
      retired: retiredCount,
      declined: reviewRows.length - retiredCount,
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

  /**
   * Newest assignee comment carrying a `Next action:` line, within
   * `PRODUCTIVITY_REVIEW_NEXT_ACTION_COMMENT_FRESH_MS`.
   *
   * Returns the row rather than a bare string because BLO-27698 A3 gives this
   * signal a caller in the generation path, and that caller needs one fact the
   * string cannot carry: whether the comment is **run-linked**. The Manager
   * Decision rubric asks for "an assignee run-linked comment in the last 6h",
   * and suppression must apply the criterion as written — see the gate in
   * `collectEvidence` for why the unlinked case is reported but not acted on.
   *
   * `runLinked` is a property of the **window**, not of the newest comment:
   * the rubric asks whether *a* run-linked comment exists in the last 6h. Read
   * off the newest row alone, any later unlinked comment carrying a next-action
   * line — an out-of-band note, a human-triggered edit — would mask a run-linked
   * one behind it and flip the gate off. The reported `line` stays the newest,
   * since that is the one a reviewer wants to read; the two facts are decoupled.
   *
   * They are decoupled in their *window* too, and the asymmetry is deliberate:
   * `line` is drawn from the full freshness window, while `runLinked` is
   * additionally intersected with the episode. Reporting a next action is useful
   * to a reviewer at a lower bar than suppressing the review outright — see the
   * two cutoffs below.
   */
  async function findCommentNextAction(
    sourceIssue: IssueRow,
    sourceAgent: AgentRow,
    episodeStartAt: Date | null,
    now: Date,
  ): Promise<{ line: string; runLinked: boolean } | null> {
    // The QUERY keeps the full freshness window, because the reporting fallback
    // (BLO-19604) is a deliberately lower bar than suppression: recovering a
    // `Next action:` line for a reviewer to read is useful even when the comment
    // predates the current episode. Narrowing the query instead would regress it
    // to "none recorded" — which reads as "the assignee left no next step" and is
    // exactly what that fallback exists to prevent.
    const freshCutoff = new Date(now.getTime() - PRODUCTIVITY_REVIEW_NEXT_ACTION_COMMENT_FRESH_MS);
    // SUPPRESSION, by contrast, is intersected with the episode, exactly as A2's
    // `findFreshLinkedProgressIssue` is. The freshness bar alone is NOT a subset
    // of the episode: `longActiveMs` is freely overridable with no lower clamp
    // (`buildThresholds`), so a lowered bar makes this fixed 6h window wider than
    // the episode itself, and a `Next action:` from a *previous* episode on the
    // same issue would suppress indefinitely many reviews of the current one.
    // Before the lookback was decoupled from `longActiveMs` the subset property
    // held by construction (`longActive` requires `elapsedMs >= longActiveMs`);
    // decoupling it is right, but only its upper bound was argued — this restores
    // the lower one. The failure direction is the unsafe one (review silently
    // withheld), which is the indefinite-suppression hazard BLO-22331 AC2 forbids.
    const suppressionStart = episodeStartAt && episodeStartAt.getTime() > freshCutoff.getTime()
      ? episodeStartAt
      : freshCutoff;
    const rows = await db
      .select({
        body: issueComments.body,
        createdByRunId: issueComments.createdByRunId,
        createdAt: issueComments.createdAt,
      })
      .from(issueComments)
      .where(
        and(
          eq(issueComments.companyId, sourceIssue.companyId),
          eq(issueComments.issueId, sourceIssue.id),
          eq(issueComments.authorAgentId, sourceAgent.id),
          sql`${issueComments.createdAt} >= ${freshCutoff.toISOString()}::timestamptz`,
          sql`${issueComments.body} ~* ${NEXT_ACTION_COMMENT_CANDIDATE_PATTERN}`,
        ),
      )
      .orderBy(desc(issueComments.createdAt), desc(issueComments.id))
      .limit(MAX_NEXT_ACTION_COMMENT_CANDIDATES);

    let newestLine: string | null = null;
    let runLinked = false;
    for (const comment of rows) {
      const line = extractNextActionFromText(comment.body);
      // The regex above is a cheap *candidate* filter; `extractNextActionFromText`
      // is what actually decides a comment states a next action. Only the latter
      // may be treated as the signal — otherwise a comment merely containing the
      // words would suppress a review.
      if (!line) continue;
      // Rows are newest-first, so the first line seen is the one to report.
      newestLine ??= line;
      if (comment.createdByRunId !== null && comment.createdAt.getTime() >= suppressionStart.getTime()) {
        runLinked = true;
        break;
      }
    }
    return newestLine === null ? null : { line: newestLine, runLinked };
  }

  /**
   * BLO-27698 A2: an issue the assignee filed against this one during the
   * episode, as a progress signal.
   *
   * Decomposing a too-large issue, or filing the human row that a blocker needs,
   * is deliverable work — but it leaves no trace in any signal this detector
   * reads. The work-product query is hard-scoped `type = "pull_request"`, so an
   * assignee who decomposes on contact with a blocker scored exactly zero and
   * looked identical to one doing nothing.
   *
   * "References the source issue" is read **structurally** — a parent link or an
   * `issue_relations` edge in either direction — never by matching the source
   * identifier in free text. An identifier is quoted in ordinary prose all the
   * time (this very comment does it), so a text match would let an assignee
   * suppress its own review by mentioning the issue it is already working on.
   * Both structural forms are load-bearing and neither subsumes the other:
   * decomposition writes `parentId`, while follow-up work the source blocks
   * writes a relation edge and no parent.
   *
   * The relation arm deliberately matches an edge of **any** `type`, in either
   * direction, whoever created it. `blocks` is the only type the codebase writes
   * today, so constraining to it would be a no-op that silently excludes any type
   * added later — and it would not close the residual anyway: a third party can
   * write a `blocks` edge as easily as any other, so the edge's *creator*, not its
   * type, is what a tightening would have to key on, and `issue_relations` records
   * no creator. The residual is therefore accepted and bounded rather than
   * half-closed: a third party linking an unrelated assignee-filed issue to the
   * source can manufacture one suppression, but the freshness bar below ages it
   * out, so it cannot suppress indefinitely.
   *
   * Restricted to `originKind = 'manual'`, which is the single most important
   * line in this function. The productivity review row is ITSELF written as a
   * child of the source issue with `createdByAgentId` set to the assignee, so
   * without this filter a generated review would satisfy A2 and suppress the
   * next one — the detector would switch itself off 24h after firing once, which
   * is precisely the indefinite-suppression hazard BLO-22331 AC2 forbids. Three
   * existing `assignment wake` replay tests caught exactly this.
   *
   * An allowlist rather than a denylist of known platform origins, so that a
   * recovery/routine/plugin origin kind added later is excluded by default: the
   * failure direction is then "a review still generates", not "the detector went
   * quiet for a reason nobody can see".
   */
  async function findFreshLinkedProgressIssue(
    sourceIssue: IssueRow,
    sourceAgent: AgentRow,
    episodeStartAt: Date | null,
    now: Date,
  ) {
    // Bounded by construction, per BLO-22331 AC2. The episode bound alone would
    // NOT be bounded: an episode grows without limit, so one sub-issue filed in
    // its first hour would suppress every review for the rest of the episode,
    // however long. Intersecting it with the same 24h freshness bar A1 uses is
    // what makes the signal age out.
    const freshCutoff = new Date(now.getTime() - PRODUCTIVITY_REVIEW_LINKED_ISSUE_FRESH_MS);
    const createdSince = episodeStartAt && episodeStartAt.getTime() > freshCutoff.getTime()
      ? episodeStartAt
      : freshCutoff;
    const rows = await db
      .select({ id: issues.id })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, sourceIssue.companyId),
          eq(issues.createdByAgentId, sourceAgent.id),
          eq(issues.originKind, "manual"),
          // A soft-deleted row is not a deliverable, and a `harnessKind` row is
          // test scaffolding. Reuses the shared predicate rather than restating
          // `hidden_at is null`, so this ages with the visibility rule.
          visibleIssueCondition(),
          // Progress-*eligibility*, mirroring `isProgressPullRequest`: A1 keys on
          // status rather than mere freshness, so that a PR the assignee closed
          // without merging is not progress however recently it moved. A sub-issue
          // filed and then cancelled is the same shape. `done` is deliberately
          // still eligible — completed work is the strongest progress there is.
          sql`${issues.status} <> 'cancelled'`,
          sql`${issues.id} <> ${sourceIssue.id}`,
          sql`${issues.createdAt} >= ${createdSince.toISOString()}::timestamptz`,
          or(
            eq(issues.parentId, sourceIssue.id),
            sql`exists (
              select 1 from ${issueRelations} r
              where r.company_id = ${sourceIssue.companyId}
                and (
                  (r.issue_id = ${issues.id} and r.related_issue_id = ${sourceIssue.id})
                  or (r.issue_id = ${sourceIssue.id} and r.related_issue_id = ${issues.id})
                )
            )`,
          ),
        ),
      )
      .orderBy(desc(issues.createdAt), desc(issues.id))
      .limit(1);
    return rows[0] ?? null;
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
    // infrastructure fact to the assignee. Kept as its own predicate rather
    // than folded into `isNeverExecutedRun` because it answers a different
    // question — "was an adapter ever created" versus "did the runtime fail" —
    // and the evidence block reports the two separately. In production the
    // BLO-23096 rows satisfy both (the setup-failure path does stamp
    // `livenessState: "failed"`, so `isInfraFailureRun` already excludes them);
    // this filter is what still catches them when liveness classification never
    // landed, and what keeps the count honest for the evidence line.
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
      branch: sql<string | null>`${issueWorkProducts.metadata}->>'branch'`,
      owningIdentifiers: sql<unknown>`${issueWorkProducts.metadata}->'owningIdentifiers'`,
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
      assigneeRunningRunRows,
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
      //
      // PEN-3219: and it must be a PR that OWNS this row. Attribution cannot be
      // decided in SQL — `resolveOwningPaperclipIdentifiers` is a ranked
      // tier-walk over title/body/branch, and legacy rows carry no recorded
      // owning set — so every candidate is read newest-first and the first
      // attributed one is picked in TS below. There is deliberately NO row cap:
      // a cap applied before the ownership filter would let N newer
      // unattributed PRs (a registry issue name-dropped by many PRs at once)
      // push this row's own PR off the page and withhold a real progress
      // signal. The WHERE already bounds the read to this issue's trusted PR
      // rows that moved inside the 24h freshness window AND sit in a
      // progress-eligible state, which is small in practice (PEN-2370 held 44
      // rows in TOTAL, not 44 moving inside one day).
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
        .then((rows) => rows.find((row) => pullRequestOwnsIssue(row, sourceIssue.identifier)) ?? null),
      // BLO-27698 C1: the assignee's live slot occupancy. Company-wide for the
      // agent, NOT scoped to this issue — the slots that starve this issue are
      // held by other issues, so an issue-scoped count would always read 1 and
      // say nothing. `running` only: a `queued` or `scheduled_retry` run holds
      // no pod and no slot.
      //
      // Selects the liveness stamps rather than `count(*)` because the
      // dispatcher's slot gate counts only NON-STALE running rows
      // (`isRunOccupyingSlot`). Counting every `running` row here would let a
      // stale/silent row report `N/N … saturated` — and offer the C2 capacity
      // verdict — while dispatch would still admit a turn. That is a false
      // capacity explanation, which is worse than none: it reads as
      // measurement. The row set is bounded by the agent's live runs, so
      // filtering in JS against the shared predicate is cheaper than keeping a
      // second copy of the staleness rule in SQL.
      db
        .select({
          startedAt: heartbeatRuns.startedAt,
          lastOutputAt: heartbeatRuns.lastOutputAt,
          lastUsefulActionAt: heartbeatRuns.lastUsefulActionAt,
        })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.companyId, sourceIssue.companyId),
            eq(heartbeatRuns.agentId, sourceAgent.id),
            eq(heartbeatRuns.status, "running"),
          ),
        ),
    ]);

    const activeRunCount = latestRuns.filter((run) =>
      ACTIVE_RUN_STATUSES.includes(run.status as (typeof ACTIVE_RUN_STATUSES)[number]),
    ).length;
    // BLO-27698 C1: both halves resolved through the same leaf module the
    // dispatcher's slot gate uses — the ceiling via
    // `resolveEffectiveMaxConcurrentRuns`, the occupancy via
    // `countRunsOccupyingSlots` — so neither a reported ceiling nor a reported
    // occupancy can disagree with the enforced one.
    const assigneeConcurrency = {
      runningRunCount: countRunsOccupyingSlots(assigneeRunningRunRows, now.getTime()),
      ...resolveEffectiveMaxConcurrentRuns(sourceAgent),
    };
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
    // BLO-27698 (Ally review on 160720b4): `nonLiveExecutionHoldSince` keys only
    // on `issue.executionRunId`, so it answers "is the *holder* live", not "is
    // anything live on this issue". Those diverge whenever the holder pointer is
    // parked while another run keeps executing, and the holder-only reading is
    // then applied on a false premise: the episode has not ended, work is
    // happening on the sibling row. `runLiveInterval`'s docblock already states
    // that principle for its own consumer — "a run sitting `queued` while a
    // *different* run works the same issue is not a missing turn" — so reading
    // liveness holder-only here contradicted it, and did so invisibly: because
    // `elapsedMs` and `liveExecutingMs` are both cut at this boundary, a sibling
    // burning 13h continuously was truncated to the holder's 2h for *every*
    // B-group gate at once, leaving B2, B3 and B3b unable to see it between them.
    //
    // `latestRuns` is scoped to this issue and this assignee, so a live sibling
    // here is that assignee demonstrably working this issue right now — not
    // unrelated traffic.
    //
    // BLO-18307 is not weakened, and the precise statement matters: the tail
    // extension never resurrects a gap, because `attributableStartAt` moves to
    // the sibling's own span start whenever the sibling began after the hold
    // (see `siblingSegmentStart`). So the wedged-holder wall-clock this exists
    // to exclude stays excluded either way — as a trailing hold when nothing is
    // live anywhere, or as a leading park when a sibling picked the issue up
    // later. An earlier draft of this comment claimed only the first half; that
    // understated the change, because a *binary* extension removed the
    // truncation entirely and retroactively the moment anything went live.
    // The earliest point from which a still-signalling sibling has been live —
    // i.e. when the sibling-carried live segment began, or null when no sibling
    // is executing.
    const siblingLiveFrom = latestRuns.reduce<number | null>((earliest, run) => {
      if (run.id === sourceIssue.executionRunId || run.status !== "running") return earliest;
      const span = runLiveInterval(run, now);
      // `runLiveInterval` caps a `running` row at `min(now, silentFrom)`, so
      // `end >= now` is exactly "still signalling" — the same liveness test
      // `liveExecutingMs` applies below, shared via `stillSignalling`.
      if (!stillSignalling(span, now)) return earliest;
      return earliest === null || span.start < earliest ? span.start : earliest;
    }, null);
    const siblingStillExecuting = siblingLiveFrom !== null;
    // Clamping below activeStartedAt collapses to 0 via Math.max — i.e. a holder
    // that went non-live before the episode began contributes no active time.
    const attributableEndAt = siblingStillExecuting ? now : (nonLiveHoldSince ?? now);
    // BLO-19848 (review follow-up): the tail clamp above is not enough on its
    // own, because it only truncates a hold that is *still* open. A holder that
    // parked and then resumed is live again, so nonLiveExecutionHoldSince
    // correctly returns null — and the whole parked interval silently reverts to
    // being counted, since elapsed is measured from activeStartedAt. A 6h50m
    // park followed by a 10m run still reported 7h and still fired the trigger.
    // Exclude the park from the front of the episode too. See
    // liveSegmentStartedAt.
    const liveSegmentStart = liveSegmentStartedAt(executionRun, now);
    // BLO-27698 (Ally review on 06b87852): extending the tail on a *duration-
    // blind boolean* re-attributes the whole holder park whenever anything is
    // live — a sibling up for one second resurrects an 11h gap retroactively and
    // entirely, not proportionally, handing B2 an episode rendered as 13h of
    // "active elapsed time" that was 11h of park. Worse, the disclosure vanishes
    // with it: `trailingHoldMs` goes to 0, so the excluded-hold line is not
    // rendered either, and the gap is neither counted out nor visible as in.
    //
    // Bound the extension to the sibling's own span. When the holder is non-live
    // and the segment is carried by a sibling that started *after* the hold
    // began, the current live segment starts there — so the sibling contributes
    // its own burn without resurrecting the gap before it. A sibling live since
    // before the hold leaves the start untouched, which is the 13h
    // continuous-burn case the tail extension exists for.
    //
    // This is `liveSegmentStartedAt`'s own BLO-19848 discipline — a park breaks
    // the segment, measure the current one — applied issue-wide rather than
    // holder-only, so the excluded interval keeps surfacing through the existing
    // `leadingParkMs` disclosure instead of disappearing from both sides of the
    // ledger. It also keeps `elapsedMs` exactly `attributableEndAt -
    // attributableStartAt`, which `monitorGatingBreakdown` relies on to place
    // the episode window (`episodeEndMs = start + elapsedMs`); subtracting an
    // interior hole from the duration instead would have shifted that window off
    // the spans it measures and broken B1's bucket identity.
    const siblingSegmentStart =
      siblingLiveFrom !== null && nonLiveHoldSince && siblingLiveFrom > nonLiveHoldSince.getTime()
        ? new Date(siblingLiveFrom)
        : null;
    const segmentStart = latestDate(liveSegmentStart, siblingSegmentStart);
    const attributableStartAt = activeStartedAt
      && segmentStart
      && segmentStart.getTime() > activeStartedAt.getTime()
      ? segmentStart
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

    const latestPullRequest = toPullRequestEvidence(
      progressPullRequestRow ?? latestPullRequestRow,
      now,
      sourceIssue.identifier,
    );
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
        && isDominantEpisodeShare(noExecutableTurnGating.noExecutableTurnMs, elapsedMs),
    );
    // BLO-27698 B3b: the longest execution span in this episode that is
    // *still live as of `now`*. `runLiveInterval` caps a `running` row at its
    // last signal + NON_LIVE_EXECUTION_SILENCE_MS, so a row that went silent
    // stops counting here — "still executing" means signalling, not merely
    // still holding the `running` status.
    //
    // Read by `runawayExecution` only. Scoped deliberately: B2's dominance gate
    // reads `monitorGating.executingMs`, which carries no liveness requirement
    // at all, and locates its bound in the share test instead — see the comment
    // on that clause. An earlier version of this docblock claimed to be "the
    // liveness half of both B-group gates" and credited BLO-22331 AC2
    // boundedness to it; that was wrong for B2 and is corrected here, because a
    // reader trusting it could remove B2's share-test bound believing liveness
    // still covered it.
    //
    // For B3b the liveness requirement is what keeps `runaway_execution`
    // bounded: a run that executed hard and then went quiet stops counting, so
    // the trigger cannot latch on a dead span. Clamped to the episode at *both*
    // ends so a span that predates it cannot inflate the gate and a span that
    // outruns it cannot exceed the elapsed figure rendered beside it.
    //
    // The tail clamp is not symmetry for its own sake (Ally review on
    // 2e95b50b). It originally existed because `nonLiveExecutionHoldSince` keys
    // only on the run pointed at by `issue.executionRunId`, so a parked holder
    // truncated `attributableEndAt` into the past while this reducer walked
    // *all* of `latestRuns` and counted a live sibling right up to `now` —
    // making `liveExecutingMs > elapsedMs` representable, and the evidence pack
    // self-contradictory: the trigger reason prints this figure and the report
    // prints `elapsedMs`, so one review could claim 13h of continuous execution
    // above "Current active elapsed time: 2h".
    //
    // That divergence is now fixed at its source — `attributableEndAt` extends
    // to `now` while a sibling is still executing (see `siblingLiveFrom`), with
    // `attributableStartAt` moved to the sibling's own span start so the
    // extension covers the sibling's burn and not the holder's park before it.
    // Both figures move together and the contradiction is unrepresentable
    // rather than clamped away. Clamping the tail was the wrong half of that
    // trade: it bought consistency by discarding the sibling's burn from
    // `liveExecutingMs` too, which hid a genuinely runaway run from the one
    // trigger B3b added to catch it.
    //
    // The clamp is therefore retained as a belt-and-braces invariant guard, not
    // as a suppressor: with `attributableEndAt` sibling-aware it is provably a
    // no-op, because every span this reducer counts is `running` and live, and
    // any such run drives `attributableEndAt` to `now` (as the holder, via a
    // null hold; or as a sibling, via `siblingStillExecuting`). Keeping it means
    // `liveExecutingMs <= elapsedMs` stays true by construction if a future edit
    // narrows either of those paths, instead of by the argument above. The head
    // clamp is no longer a no-op in the sibling case and is doing real work: it
    // is what stops a sibling's pre-episode span leaking back in once
    // `attributableStartAt` has been moved forward to exclude the park.
    //
    // Order matters: the clamp is applied to the measured duration *after* the
    // `stillSignalling` liveness test, never before. Testing a clamped end
    // against `now` would read a truncated `attributableEndAt` as "went silent"
    // and zero out genuinely live runs — liveness asks about `now`, the counted
    // duration stays inside the episode.
    const liveExecutingMs = Math.max(
      0,
      ...latestRuns.map((run) => {
        if (run.status !== "running") return 0;
        const span = runLiveInterval(run, now);
        if (!stillSignalling(span, now)) return 0;
        const start = attributableStartAt ? Math.max(span.start, attributableStartAt.getTime()) : span.start;
        const end = Math.min(span.end, attributableEndAt.getTime());
        return Math.max(0, end - start);
      }),
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
    // BLO-27698 B3b: the escape hatch B3 owes. Keyed on a single run's own
    // still-live execution span, not on the episode, so it survives B3's
    // narrowing of `long_active_duration` to the unattended bucket — an episode
    // spent executing has almost no unattended time by construction, which is
    // exactly the case that would otherwise vanish.
    //
    // Reuses `longActiveMs` rather than adding a knob: both are "this has gone
    // on too long" bars over the same episode, and two independently-tunable
    // constants for one question is how a raised bar silently stops covering a
    // case (the A3 defect on this same issue). Split them if a fleet ever needs
    // a runaway bar below the long-active one.
    //
    // Guarded on `elapsedMs !== null && attributableStartAt !== null`, matching
    // `longActive` above. Both are required and neither is redundant:
    //   - `elapsedMs` is null for any issue not `in_progress` (see the episode
    //     attribution above), yet `reconcileProductivityReviews` selects over
    //     `["todo", "in_progress"]`. Without this, a `todo` issue still carrying
    //     a signalling `running` row — released back to `todo` mid-run, or a
    //     checkout that never landed — would produce a review that
    //     `long_active_duration` is structurally incapable of producing.
    //   - `attributableStartAt` null is the BLO-22016 `currentHolderNeverDispatched`
    //     shape. The clamp in `liveExecutingMs` degrades to the raw `span.start`
    //     there, so the run's entire lifetime counts rather than its episode
    //     share — the opposite of what that docblock promises. Guarding here
    //     makes the clamp unconditional in every case that can reach this bar.
    // Such reports also render "Current active elapsed time: unknown" with no
    // `Elapsed accounting` line (`monitorGatingBreakdown` returns null on a null
    // `elapsedMs`), so firing on them would be evidence-free as well as wrong.
    const runawayExecution =
      elapsedMs !== null && attributableStartAt !== null && liveExecutingMs >= thresholds.longActiveMs;
    const trigger = choosePrimaryTrigger({ runtimeFailure, noComment, longActive, highChurn, runawayExecution });
    if (!trigger) return null;

    // BLO-22436 (Ally follow-up): recorded in `choosePrimaryTrigger`'s ladder
    // order so `firedTriggers[0] === trigger` always holds. Built from the same
    // four booleans the ladder reads, rather than re-deriving the predicates,
    // so the set cannot drift from the primary it is supposed to contain.
    const firedTriggers: ProductivityReviewTrigger[] = [];
    if (runtimeFailure) firedTriggers.push("runtime_failure_streak");
    if (noComment) firedTriggers.push("no_comment_streak");
    if (highChurn) firedTriggers.push("high_churn");
    if (runawayExecution) firedTriggers.push("runaway_execution");
    if (longActive) firedTriggers.push("long_active_duration");

    const triggerReasons: string[] = [];
    if (runtimeFailure) {
      triggerReasons.push(formatRuntimeFailureTriggerClaim(runtimeFailureStreak, runtimeFailureUsageBasis));
    }
    if (noComment) {
      // BLO-29535 (Ally suggestion on a38c12fe2): NOT "additional". Per
      // `isNeverInvokedRun`'s own note, this population is mostly a *subset* of
      // `isNeverExecutedRun`, so these runs are usually already inside the
      // non-executing count the evidence block reports. The evidence block
      // disambiguates via `nonExecutingAlsoNeverInvokedCount`; this prose reason
      // carries no such field, so it has to say the overlap out loud or a reader
      // summing the two counts double-counts every run that satisfies both.
      const neverInvokedNote = neverInvokedRunCount > 0
        ? ` (${neverInvokedRunCount} run(s) in the sampled window never had an adapter created and are excluded, not counted toward this streak; these mostly overlap the non-executing runs reported separately, so the two counts do not sum)`
        : "";
      triggerReasons.push(`${noCommentStreak} consecutive terminal, turn-executing issue-linked runs had no run-created issue comment${neverInvokedNote}`);
    }
    if (runawayExecution) {
      triggerReasons.push(
        `a single run has been executing continuously for ${msToHuman(liveExecutingMs)} and is still signalling; the assignee has had its turn and has not given it back`,
      );
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

    // Only `long_active_duration` is suppressible by a human gate. `no_comment_streak`,
    // `high_churn` and `runaway_execution` stay live: an agent burning runs against a gate
    // it cannot clear is exactly the waste worth reviewing, and a gate does not excuse
    // silent runs — nor a single run executing past the long-active bar (BLO-27698 B3b;
    // see the opt-out note in `choosePrimaryTrigger`).
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

    // BLO-27698 A1: a fresh, progress-eligible linked PR is a concrete progress
    // signal, so `long_active_duration` must not fire over it. A GitHub-side push
    // is invisible to every Paperclip-side recency measure this detector reads
    // (issue comments, run cadence), so an assignee actively pushing commits
    // produced an evidence pack indistinguishable from an idle issue — BLO-27207
    // fired with the PR 6h13m old and the last comment only 7m outside the
    // window. `isProgressPullRequest` already gated the render-side "second
    // signal is already present" line; this is the caller it never had in the
    // generation path, so the suppression and the report now agree on what
    // counts as progress.
    //
    // Bounded by construction, per BLO-22331 AC2: progress-eligibility requires
    // `ageMs <= PRODUCTIVITY_REVIEW_PR_FRESH_MS` (24h), so a PR that stops moving
    // ages out and the trigger fires again — this cannot suppress indefinitely.
    // Returns null rather than a recorded suppression for the same reason the
    // gated-elapsed check below does: `long_active_duration` is last in
    // `choosePrimaryTrigger`'s ladder, so no other fired trigger is discarded.
    if (trigger === "long_active_duration" && isProgressPullRequest(latestPullRequest)) {
      return null;
    }

    // BLO-19604: `run.nextAction` is only populated when that specific run's own
    // liveness classification saw the text. Computed here — above the two gates
    // below rather than at its point of use further down — because it is a pure
    // scan of already-loaded rows, and hoisting it lets the comment query below
    // stay lazy for the callers that never needed it.
    const structuredNextAction = latestRuns.find((run) => run.nextAction)?.nextAction ?? null;

    // BLO-27698 A3: the comment progress signal, evaluated rather than only
    // printed. The Manager Decision rubric has told reviewers for three releases
    // that a run-linked `Next action:` comment in the last 6h means "close as
    // productive", while no code read it — so an assignee that posted exactly the
    // artifact the rubric asks for still had the review generated against it.
    //
    // Queried here (not at the `nextAction` fallback below) because the gate needs
    // it whether or not the structured field is populated: `run.nextAction` has no
    // freshness bound of its own, so a stale structured value must not stand in
    // for a fresh comment. Kept lazy for every other trigger, which is the access
    // pattern the fallback below was written for.
    const nextActionComment = trigger === "long_active_duration" || !structuredNextAction
      ? await findCommentNextAction(sourceIssue, sourceAgent, attributableStartAt, now)
      : null;
    // Run-linked only, exactly as the rubric words it. An assignee comment with no
    // `createdByRunId` is still *reported* (the fallback below prints it), but it
    // is not evidence that a turn happened — and this gate's whole claim is that
    // the assignee attended the issue. Bounded per BLO-22331 AC2 by the 6h window:
    // stop commenting and the trigger fires, so this cannot suppress indefinitely.
    if (trigger === "long_active_duration" && nextActionComment?.runLinked) {
      return null;
    }

    // BLO-27698 A2: an issue filed against this one during the episode is
    // deliverable progress on the same terms as a fresh PR. Structural edges only
    // — see `findFreshLinkedProgressIssue`.
    const linkedProgressIssue = trigger === "long_active_duration"
      ? await findFreshLinkedProgressIssue(sourceIssue, sourceAgent, attributableStartAt, now)
      : null;
    if (linkedProgressIssue) {
      return null;
    }

    // BLO-25877: computed once here — after both suppression gates above have had
    // their chance to hold this review back — and reused as-is for the report-text
    // field further down, rather than recomputed there.
    const monitorGating = monitorGatingBreakdown(sourceIssue, attributableStartAt, elapsedMs, now, latestRuns, thresholds);
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
      // BLO-27698 B3/B3a: fires on the *unattended* bucket. B1's addend is gone,
      // so executing time no longer counts toward the trigger it was never
      // evidence for. Still guarded by `!gatedIsUpperBound` above — the
      // still-armed branch reports `unattendedMs: 0` as a deliberate upper
      // bound, and treating that as measured would exempt any issue with a
      // monitor armed however briefly (BLO-22331 AC2). B3b's
      // `runaway_execution` recovers the case this narrowing drops for ONE
      // shape only — a single continuous run, still live, past the bar — and it
      // outranks this trigger, so an episode of that shape never reaches this
      // gate at all. It is deliberately NOT the general inverse of B3: an
      // episode whose executing time is split across several finished runs,
      // none individually past the bar, stays suppressed here and is not
      // recovered. That is intended, on the same ground the B2 clause below
      // takes — an executing-dominant episode is explained — but do not read
      // B3b as full coverage and widen this narrowing on that basis.
      (monitorGating.unattendedMs < thresholds.longActiveMs ||
        // BLO-27698 B2: the episode is more than half executing time. Same
        // dominance shape as `noExecutableTurnDominant`, through the shared
        // `isDominantEpisodeShare`, because both answer one question: is this
        // episode better explained by something other than assignee inactivity?
        //
        // Deliberately NOT gated on a *run* being live right now, which is where
        // `noExecutableTurnDominantAndOpen` gets its bound. That guard would make
        // this clause unreachable rather than conservative: a run that is live now
        // started at or before the episode anchor (`mostRecentDispatchAt`), so its
        // span covers the whole episode, `unattendedMs` is then ~0, and the first
        // arm above has already suppressed. Both fixtures below prove the point
        // from the other side — their executing span is a *terminal* run, so no
        // run is live and the clause still has to work.
        //
        // It IS gated on the *episode clock* being live, which is a different
        // thing and the actual bound (Ally review on fe4e9dcb). The share test
        // alone is not self-clearing: it only falls as `elapsedMs` grows, and
        // `elapsedMs` stops growing whenever `attributableEndAt` stops tracking
        // `now` — i.e. exactly when `trailingHoldMs > 0`. For a silent `running`
        // holder, `nonLiveExecutionHoldSince` (:698) pins the episode end at the
        // fixed `lastSignal + NON_LIVE_EXECUTION_SILENCE_MS`, so `elapsedMs`,
        // `executingMs` and `unattendedMs` all freeze and the ratio can never
        // cross back under the bar. Reachable shape: anchor 15h ago, holder live
        // for 8h, then silent — executing 8h / unattended 7h / elapsed 15h, the
        // unattended residue is above the bar so the first arm does not apply,
        // and `runaway_execution` declines because the span no longer reaches
        // `now`. B2 alone would then suppress permanently, which is the BLO-22331
        // AC2 hazard this clause claimed to avoid.
        //
        // `trailingHoldMs === 0` is the whole guard: while the clock runs, the
        // ratio genuinely falls and suppression lapses once the episode reaches
        // twice the executing time (the paired boundedness test pins that); once
        // it freezes, the episode falls through to the trigger rather than being
        // suppressed on a number that can no longer move.
        (trailingHoldMs === 0 && isDominantEpisodeShare(monitorGating.executingMs, elapsedMs)))
    ) {
      return null;
    }

    // BLO-19604: before reporting "none recorded" — which reads as "the assignee
    // left no next step" — fall back to the assignee's own recent comments, the
    // same way run-liveness classification would have. This is a genuine fallback,
    // not a relabelled null: it recovers a `Next action:`/`Next:` line the
    // structured field missed. Sourced from `findCommentNextAction` (queried
    // directly against `issueComments`, no join on `heartbeatRuns`) rather than
    // `latestComments`, since a plain assignee comment with no `createdByRunId` is
    // exactly the kind this fallback exists to recover, and `latestComments`'s
    // inner join excludes it. That unlinked case is why the A3 gate above checks
    // `runLinked` while this line does not: reporting a next action is useful to a
    // reviewer at a lower bar than suppressing the review outright.
    const nextAction = structuredNextAction ?? nextActionComment?.line ?? null;

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
      // BLO-22887 AC2: always null here. Dependency readiness is not fetched on
      // this path (see the header note); `reconcileProductivityReviews` fills
      // this in from the map it already holds, and the continuation-hold
      // caller leaves it null because it renders no body.
      dependencyGating: null,
      assigneeConcurrency,
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
      ...(evidence.assigneeConcurrency
        ? [`- Assignee live concurrency: ${formatAssigneeConcurrency(evidence.assigneeConcurrency)}`]
        : []),
      `- No-comment streak (terminal, turn-executing runs): ${evidence.noCommentStreak}`,
      `- Runtime-failure streak (terminal, never-executed runs): ${evidence.runtimeFailureStreak}`,
      `- Never-invoked runs excluded (terminal, no adapter ever created — \`usageJson\`/\`logStore\`/\`logRef\` null, \`logBytes\` null or 0, BLO-26165): ${evidence.neverInvokedRunCount}`,
      // BLO-29535 (Ally suggestion on a38c12fe2): "not excluded from the streak
      // walk", NOT "counted toward the streak". This count is taken over every
      // run in `noCommentEligibleRuns`, while `noCommentStreak` is only the
      // prefix of that list before the first commented run — so the two numbers
      // legitimately differ, and the old label invited a manager to read the
      // larger one as the streak length.
      `- Comment-policy-exempt runs that DID execute (terminal, \`issueCommentStatus: not_applicable\`, not excluded from the streak walk — BLO-26165): ${evidence.commentExemptExecutedRunCount}`,
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
            `- Excluded as non-live execution hold: ${msToHuman(evidence.nonLiveHoldMs)} (issue's executionRunId parked, pinned by a run that was not live, or outside the current live segment; not counted toward the trigger — BLO-19848)`,
          ]
        : []),
      ...(evidence.monitorGating
        ? [`- Elapsed accounting: ${formatMonitorGating(evidence.monitorGating)}`]
        : []),
      ...(evidence.noExecutableTurnGating
        ? [`- No-executable-turn accounting: ${formatNoExecutableTurnGating(evidence.noExecutableTurnGating)}`]
        : []),
      ...(evidence.dependencyGating
        ? [`- Dependency accounting: ${formatDependencyGating(evidence.dependencyGating, evidence.monitorGating !== null)}`]
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
        : evidence.trigger === "runaway_execution"
        // BLO-27698 B3b: the four verdicts below all ask whether the assignee
        // showed progress signals during time it was *not* working. That
        // question is wrong here by construction — this trigger fires because a
        // run is still executing right now — so asking it would invite a
        // "close as productive" on a run nobody has bounded.
        ? [
          "A single run has held its turn longer than the whole-episode bar and is still signalling, so this is a runtime/cost question, not an assignee-inactivity one.",
          "",
          "Decide one of:",
          "- Let it finish (the work genuinely needs a long turn; say so and snooze, naming the expected finish)",
          "- Bound it (the run has no stopping condition — interrupt it and require the assignee to decompose the work before re-dispatching)",
          "- Route to platform/SRE (the run is wedged rather than working: a live signal stream with no run comments and no cost growth is the shape to look for)",
        ]
        : [
          "A \"Close as productive\" verdict requires at least ONE of the following concrete progress signals:",
          "- An assignee run-linked comment in the last 6h that contains a `Next action:` line",
          "- A non-stale PR/MR link in the source issue's evidence, attributed to THIS issue (created or updated in the last 24h)",
          "- A recent test result, artifact commit, or workspace deliverable in the last 6h",
          ...pullRequestProgressNote(evidence.latestPullRequest),
          "",
          "If none of these signals is present, the correct verdict is one of:",
          // BLO-27698 C2: the four verdicts below all presuppose an agent that
          // was given a turn and used it poorly — decompose, block, stop,
          // snooze are all instructions to the *assignee*. An assignee that was
          // saturated or fleet-starved had no turn to use, and with no cell for
          // that case a reviewer had to force one of the four, which is how a
          // platform-capacity episode gets recorded as assignee
          // under-performance. Mirrors the "Route to platform/SRE" block the
          // `runtime_failure_streak` branch already carries.
          //
          // Listed FIRST, and gated on measured evidence rather than always
          // offered: an always-present capacity excuse would become the default
          // verdict for every slow episode, which is the opposite failure.
          ...(isCapacityConstrainedEvidence(evidence)
            ? [
              hasEpisodeScopedCapacityBlock(evidence)
                ? `- Route to platform/SRE as a capacity/dispatch constraint — the evidence above shows the assignee was not given an executable turn (${describeCapacityConstraint(evidence)}). None of the four verdicts below applies to an agent that had no turn; do not record this as assignee under-performance.`
                : `- Route to platform/SRE as a capacity/dispatch constraint — the evidence above shows a PARTIAL capacity block (${describeCapacityConstraint(evidence)}), not established across the whole episode. Confirm it held for the period in question before routing; if it did not, one of the four verdicts below still applies.`,
            ]
            : []),
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
      // BLO-29535: same wording fix as the description's evidence block — this
      // count is every streak-eligible exempt run, not the streak prefix, and
      // a bare "(counted)" sitting under "No-comment streak" read as "counted
      // into that streak". The comment must tell the same story as the
      // description it summarises.
      `- Comment-policy-exempt runs that DID execute (not excluded from the streak walk): ${evidence.commentExemptExecutedRunCount}`,
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
      ...(evidence.dependencyGating
        ? [`- Dependency accounting: ${formatDependencyGating(evidence.dependencyGating, evidence.monitorGating !== null)}`]
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
    // BLO-33477 AC3: this scan orders by `asc(updatedAt)` rather than the
    // `productivityScannedAt` watermark the source scan (BLO-30303) and the
    // retirement scan above use — it cannot share that column, because
    // `closeOpenSuppressedReviews` stamps a superset of these rows and would
    // drive the ordering. It is starvation-free anyway: every path out of the
    // loop below takes the row *out* of this window, including the failure
    // path, which backs the row off for a full stale interval (see the catch).
    //
    //   - retired        -> status `done`, drops out of `notInArray(status, ...)`
    //   - finalized      -> gains identifier/issueNumber, drops out of `isNull(...)`
    //   - retire raced   -> `existing`; transient, the row changed under us
    //   - finalize threw -> `failed`, and the catch sets `updatedAt = now`, so
    //                       the row fails `updatedAt < staleCutoff` on the next
    //                       pass and cannot hold a slot at all
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
        // BLO-33477 AC3: back the row off for a full stale interval so a
        // deterministically-failing finalize cannot re-select on the next pass
        // and starve the reservations behind it. `input.now`, not `staleCutoff`
        // — clamping to the cutoff also bounds starvation (the cohort's key
        // tracks the eligibility frontier, so any fixed-key row overtakes it
        // within two eligible passes) but keeps 250 poison rows re-filling the
        // window forever; `now` drops them out of `updatedAt < staleCutoff`
        // entirely until stale again, which is the property worth asserting.
        // Costs a failed finalize one stale interval before retry, which this
        // janitor path (rows are already >= 5min stale) can afford.
        //
        // Guarded to rows still reserved: if finalize threw *after* assigning
        // identifier/issueNumber the row has already left this window. This
        // advances `lastActivityAt` too, via the migration-0076 BEFORE UPDATE
        // trigger — intended, the row was genuinely touched.
        await db
          .update(issues)
          .set({ updatedAt: input.now })
          .where(
            and(
              eq(issues.companyId, review.companyId),
              eq(issues.id, review.id),
              eq(issues.originKind, PRODUCTIVITY_REVIEW_ORIGIN_KIND),
              isNull(issues.issueNumber),
              isNull(issues.identifier),
              notInArray(issues.status, ["done", "cancelled"]),
            ),
          );
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
      action: PRODUCTIVITY_REVIEW_SUPPRESSED_ACTION,
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
      terminalGateResolvedSuppressed: 0,
      closedSuppressedMonitorReviews: 0,
      closedTerminalSourceReviews: 0,
      closedDependencyBlockedReviews: 0,
      closedExecutionEndedReviews: 0,
      // BLO-33477 AC4: the retirement pass's own funnel. Kept separate from the
      // `closed*` counters above because those are outcome tallies and one of
      // them (`closedTerminalSourceReviews`) is also credited by the stale
      // reservation recovery below — so neither it nor their sum isolates what
      // this sweep actually did.
      retirementScanned: 0,
      retirementRetired: 0,
      retirementDeclined: 0,
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
    result.closedExecutionEndedReviews = closedSuppressed.executionEnded;
    result.retirementScanned = closedSuppressed.scanned;
    result.retirementRetired = closedSuppressed.retired;
    result.retirementDeclined = closedSuppressed.declined;

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
      // BLO-30303: rotate on a least-recently-*scanned* watermark, not on
      // `updatedAt`. Nothing in this file writes back to a scanned *source*
      // row, so under the old `asc(updatedAt)` ordering the same oldest-250
      // rows were re-selected on every pass forever and `created` was
      // permanently 0 once the eligible population passed the cap. `desc` is
      // not the fix either — a stalled issue's `updatedAt` stops advancing by
      // definition, so it would sink out of the window exactly as it became
      // interesting. Any static ordering on a field uncorrelated with
      // eligibility starves at some cap; rotation makes that impossible by
      // construction.
      //
      // Coalesce to `createdAt` rather than sorting NULLS FIRST (Ally review).
      // NULLS FIRST is an *absolute* priority class: never-scanned rows always
      // outrank every scanned row, so a sustained influx of >= MAX_CANDIDATE_ISSUES
      // new eligible rows per pass would consume the whole window forever and
      // an already-scanned row could never be revisited. That is the same
      // starvation this fix exists to remove, just with a different victim —
      // and the victim is the one that matters, since a row is scanned while it
      // is still healthy and only becomes interesting once it later goes quiet.
      // Treating "created" as the implicit first touch makes the key a strict
      // FIFO: it advances only when a row is scanned, so the scan always takes
      // the globally longest-waiting rows and new arrivals cannot jump the
      // queue. Every eligible row is then evaluated within ceil(N/250) passes
      // at any population and any arrival rate.
      // `updatedAt`/`id` only break ties within one watermark value — a whole
      // scan batch shares one `now`, so ties are common and must be stable.
      .orderBy(
        sql`coalesce(${issues.productivityScannedAt}, ${issues.createdAt}) asc`,
        asc(issues.updatedAt),
        asc(issues.id),
      )
      .limit(MAX_CANDIDATE_ISSUES);
    result.scanned = candidates.length;

    // Stamp before evaluating, not after: a candidate that throws mid-loop has
    // already rotated out, so one poison row cannot wedge the window forever
    // (the failure shape of BLO-30320). A bare column write — it does not
    // touch `updatedAt`, so the `issues_sync_last_activity_at` trigger stays
    // quiet and the watermark is invisible to the evidence signals this
    // detector reads.
    if (candidates.length > 0) {
      await db
        .update(issues)
        .set({ productivityScannedAt: now })
        .where(
          inArray(
            issues.id,
            candidates.map((candidate) => candidate.id),
          ),
        );
    }

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
    const dependencyBlockedSourceIssueIds = new Map<
      string,
      { unresolvedBlockerCount: number; pendingFinalizeBlockerCount: number }
    >();
    const candidateIdsByCompany = new Map<string, string[]>();
    for (const candidate of candidates) {
      const forCompany = candidateIdsByCompany.get(candidate.companyId) ?? [];
      forCompany.push(candidate.id);
      candidateIdsByCompany.set(candidate.companyId, forCompany);
    }
    for (const [candidateCompanyId, candidateIds] of candidateIdsByCompany) {
      const readiness = await issuesSvc.listDependencyReadiness(candidateCompanyId, candidateIds, db);
      for (const candidateId of candidateIds) {
        const candidateReadiness = readiness.get(candidateId);
        const unresolvedBlockerCount = candidateReadiness?.unresolvedBlockerCount ?? 0;
        if (unresolvedBlockerCount > 0) {
          // BLO-22887 AC2: the membership test below is unchanged (`.has`), but
          // the counts ride along so the reported bucket costs no second
          // readiness round-trip. Deliberately NOT the blocker ids: rendering
          // raw uuids in a review body is noise, and the source issue's own
          // `blockedBy` is one click away for a reviewer who needs them.
          dependencyBlockedSourceIssueIds.set(candidateId, {
            unresolvedBlockerCount,
            pendingFinalizeBlockerCount: candidateReadiness?.pendingFinalizeBlockerIssueIds.length ?? 0,
          });
        }
      }
    }

    const prefixCache = new Map<string, string>();

    // BLO-27515: sources whose terminated monitor declared pull-request gates
    // that a board-side re-read has since found satisfied. This is a plain
    // lookup of an already-recorded result — the detector never reads GitHub
    // itself. Re-evaluation lives in the terminal-gate reconciler precisely so
    // that the gate is observed on its own cadence rather than only once an
    // issue has already crossed the 6h threshold this detector measures.
    const terminalGateResolutions = await listResolvedTerminalGates(
      db,
      candidates.map((candidate) => ({ id: candidate.id, executionState: candidate.executionState })),
    );

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
      // Checked after the approval and monitor gates on purpose. Both of those
      // describe a gate that is still *live* — a pending approval, a monitor
      // with a future check — and are the more accurate explanation whenever
      // they apply. A recorded resolution outlives the monitor that produced
      // it, so a same-signal re-arm would otherwise be reported here under a
      // gate that has since been re-opened.
      if (
        terminalGateResolutions.has(candidate.id) &&
        now.getTime() - terminalGateResolutions.get(candidate.id)!.createdAt.getTime() < thresholds.longActiveMs &&
        isTerminalGateClosableTriggerSet(evidence.firedTriggers)
      ) {
        await recordTerminalGateResolvedSuppression(candidate, evidence);
        result.terminalGateResolvedSuppressed += 1;
        continue;
      }
      // BLO-22887 AC2: attach the dependency bucket for the survivors of the
      // gate above. Placed here rather than beside that gate only because this
      // is where the union has narrowed to `ProductivityReviewEvidence` — the
      // two suppression branches carry no body to render. Reaching this line
      // while blocked means the fired set was NOT all-closable, so
      // `nonClosableTriggers` is non-empty by construction.
      const dependencyBlockers = dependencyBlockedSourceIssueIds.get(candidate.id);
      if (dependencyBlockers) {
        evidence.dependencyGating = {
          ...dependencyBlockers,
          nonClosableTriggers: evidence.firedTriggers.filter(
            (trigger) => !isDependencyBlockedClosableTrigger(trigger),
          ),
        };
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
