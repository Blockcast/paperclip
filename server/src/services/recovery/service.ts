import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, notInArray, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  DEFAULT_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS,
  MAX_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS,
  MIN_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS,
  PROVIDER_QUOTA_MONITOR_SERVICE_NAME,
  getAgentWorkEligibility,
  type IssueGraphLivenessAutoRecoveryPreview,
  type IssueGraphLivenessAutoRecoveryPreviewItem,
  type IssueStatus,
} from "@paperclipai/shared";
import {
  agents,
  agentTaskSessions,
  agentWakeupRequests,
  approvals,
  activityLog,
  companies,
  detachedQueuedRunRecoveries,
  heartbeatRunEvents,
  heartbeatRunWatchdogDecisions,
  heartbeatRuns,
  issueAttachments,
  issueComments,
  issueApprovals,
  issueRecoveryActions,
  issueRelations,
  issueThreadInteractions,
  issues,
  routineRuns,
  routines,
  workspaceOperations,
} from "@paperclipai/db";
import { EXTERNAL_LIFECYCLE_ADAPTER_TYPES } from "@paperclipai/shared/validators/agent";
import { loadConfig } from "../../config.js";
import { parseObject, asBoolean, asNumber } from "../../adapters/utils.js";
import { runningProcesses } from "../../adapters/index.js";
import { visibleIssueCondition } from "../issue-visibility.js";
import { HttpError, forbidden, notFound } from "../../errors.js";
import { logger } from "../../middleware/logger.js";
import { isPidAlive, isProcessGroupAlive, terminateLocalService } from "../local-service-supervisor.js";
import { redactCurrentUserText } from "../../log-redaction.js";
import { redactSensitiveText } from "../../redaction.js";
import { PROVIDER_CAPACITY_MAX_HORIZON_MS } from "../provider-capacity-horizon-bound.js";
// BLO-30087: the stale-lock sweeper below is the second consumer of the
// "output silence means the holder is dead" heuristic. k8s-job-liveness is a
// leaf module (k8s client + logger + redactor only), so importing it here adds
// no cycle — heartbeat.ts imports THIS module, so the dependency cannot run the
// other way.
import {
  AGENT_POD_BUSY_MAX_STALE_MS,
  probeAgentPodActivity,
} from "../k8s-job-liveness.js";
import { logActivity } from "../activity-log.js";
import { budgetService } from "../budgets.js";
import { instanceSettingsService } from "../instance-settings.js";
import { issueRecoveryActionService } from "../issue-recovery-actions.js";
import {
  isVerifiedIssueTreeControlInteractionWake,
  issueTreeControlService,
} from "../issue-tree-control.js";
import {
  TERMINAL_HEARTBEAT_RUN_STATUSES,
  externalWaitFromDescription,
  issueService,
  lockIssueParentMutationCompany,
  type IssueDependencyReadiness,
} from "../issues.js";
import {
  issueLockOwnerStateMatches,
  lockIssueOwnership,
  releaseIssueRunOwnership,
  restoreCheckoutPromotedStatus,
  type IssueLockOwnerState,
} from "../issue-checkout-status.js";
import {
  applyIssueMonitorPolicyTransition,
  buildIssueMonitorClearedPatch,
  derivePersistedMonitorState,
  normalizeIssueExecutionPolicy,
  parseIssueExecutionState,
} from "../issue-execution-policy.js";
import {
  ISSUE_BLOCKERS_RESOLVED_WAKE_REASON,
  buildIssueBlockersResolvedWakeIdempotencyKey,
  findExistingIssueBlockersResolvedWakeForAnyKey,
} from "../issue-dependency-wakeups.js";
import {
  evaluateAgentInvokability,
  evaluateAgentInvokabilityFromDb,
} from "../agent-invokability.js";
import { getRunLogStore } from "../run-log-store.js";
import {
  DEFAULT_MAX_SUCCESSFUL_RUN_HANDOFF_ATTEMPTS,
  FINISH_SUCCESSFUL_RUN_HANDOFF_REASON,
  SUCCESSFUL_RUN_MISSING_STATE_REASON,
  buildSuccessfulRunHandoffExhaustedNotice,
  noticeMetadataReferencesRecoveryAction,
  type SuccessfulRunHandoffNotice,
} from "./successful-run-handoff.js";
import {
  RECOVERY_ORIGIN_KINDS,
  buildIssueGraphLivenessLeafKey,
  isStrandedIssueRecoveryOriginKind,
  parseIssueGraphLivenessIncidentKey,
} from "./origins.js";
import { postRoutineSchedulerFailureHeartbeat } from "./routine-scheduler-heartbeat.js";
import {
  classifyIssueGraphLiveness,
  type IssueLivenessFinding,
} from "./issue-graph-liveness.js";
import {
  recoveryAssigneeAdapterOverrides,
  withRecoveryModelProfileHint,
} from "./model-profile-hint.js";
import { isAutomaticRecoverySuppressedByPauseHold } from "./pause-hold-guard.js";
import { resolveStrandedEscalationStatus } from "./stranded-escalation-status.js";
import {
  recordBackstopCandidateSkipped,
  recordBackstopSweepCompleted,
  setBackstopDeferredCandidates,
} from "../metrics.js";
import {
  isLegacySessionUnavailableAdapterMismatch,
  isZeroTokenStartupFailureRun,
  isZeroTokenSessionResetRetryRun,
  SESSION_UNAVAILABLE_RECOVERY_MAX_ATTEMPTS,
  ZERO_TOKEN_SESSION_RESET_RETRY_REASON,
} from "./zero-token-startup-failure.js";

type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * The recovery transaction has already upserted its source-scoped action when
 * the issue UPDATE reports no match. That result is a lost write precondition,
 * not a successful no-op: returning from the transaction callback would commit
 * the action/comment/activity rows without the matching issue mutation. Throw a
 * private sentinel so Drizzle rolls the transaction back, then translate it
 * back to the normal "another writer won" null result at the boundary.
 */
class RecoveryEscalationRollback extends Error {
  constructor() {
    super("Recovery escalation rolled back because the issue update matched no row");
    this.name = "RecoveryEscalationRollback";
  }
}

/**
 * The provider-quota monitor is created after the escalation transaction commits,
 * so a failed action CAS must abort the monitor transaction as well. Returning
 * from the transaction callback would commit an orphaned wake/run pair.
 */
class ProviderQuotaMonitorRollback extends Error {
  constructor() {
    super("Provider-quota recovery monitor action changed before it could be updated");
    this.name = "ProviderQuotaMonitorRollback";
  }
}

const EXECUTION_PATH_HEARTBEAT_RUN_STATUSES = ["queued", "running", "scheduled_retry"] as const;
const UNSUCCESSFUL_HEARTBEAT_RUN_TERMINAL_STATUSES = ["interrupted", "failed", "cancelled", "timed_out"] as const;
export const ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS = 60 * 60 * 1000;
export const ACTIVE_RUN_OUTPUT_CRITICAL_THRESHOLD_MS = 4 * 60 * 60 * 1000;
export const ACTIVE_RUN_OUTPUT_CONTINUE_REARM_MS = 30 * 60 * 1000;
export const DEFAULT_LIVENESS_REESCALATION_COOLDOWN_MS = 60 * 60 * 1000;
/**
 * Ceiling on the `unchanged_target` re-escalation suppressor (BLO-27676).
 *
 * The target-state gate is what lets this class terminate, but on its own it is
 * permanent: the leaf is quiet by construction -- that is the precondition of
 * the finding -- so an escalation closed `done` WITHOUT giving the leaf an
 * action path would never be re-reported. That is a silent hole in a liveness
 * detector, and closing a report without acting on the leaf is a routine path,
 * not an edge case. This bounds it: worst case the class re-reports weekly
 * instead of every ~75 min (a ~130x reduction) while still eventually speaking
 * about a genuinely abandoned row.
 *
 * Set to 0 to disable the target-state suppressor entirely and fall back to the
 * pre-BLO-27676 time-only behaviour.
 */
export const DEFAULT_LIVENESS_UNCHANGED_TARGET_SUPPRESSION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Skew allowance on the suppressor's sargable `updated_at` scan bound
 * (BLO-27676 review).
 *
 * `findSuppressingResolvedLivenessRecoveryIssue` orders and compares on
 * `coalesce(completed_at, updated_at)` but must FILTER on bare `updated_at`,
 * because only the bare column is servable by `issues_company_updated_idx` and
 * the alternative is an unbounded scan of the company's whole escalation
 * history. Those two are not the same instant: `services/issues.ts` stamps
 * `updatedAt` when it builds the patch and `completedAt` from a second clock
 * read later in the same request, so `completed_at` can lead `updated_at` by
 * however long the intervening work takes.
 *
 * Without slack, a row resolved within that gap of the horizon boundary is
 * filtered out, the suppressor returns null, and the escalation re-raises --
 * the exact loop this issue exists to close, just through a much narrower door.
 * One minute is several orders of magnitude above the observed intra-request
 * gap and several orders below the 60m floor of the horizon it widens, so it
 * closes the hole without meaningfully enlarging the scan.
 */
export const LIVENESS_SUPPRESSION_SCAN_SKEW_MS = 60 * 1000;

/**
 * Why a liveness finding produced no escalation row, as recorded in
 * `issue.harness_liveness_escalation_suppressed` (BLO-29761).
 *
 * `existing_open` is the open-row branch and the other two are the
 * resolved-history branch; keeping all three under one action means counting
 * suppressions for a period is a single filter, while telling "an open row owns
 * this" from "a closed row suppressed this" is a single GROUP BY.
 */
export type LivenessSuppressionReason = "existing_open" | "cooldown" | "unchanged_target";

/**
 * How long an open liveness recovery row may sit untouched before the sweep
 * treats it as abandoned and retires it (BLO-28957).
 *
 * This is the exit for the `sourceStillOpenSkipped` arm in
 * `retireObsoleteLivenessRecoveryIssues`. An open row suppresses liveness
 * findings for its source *and* its leaf (`openRecoveryIssues` ->
 * `hasExplicitWaitingPath`, which reads no blocker edges), and BLO-28618 made
 * the retire loop skip any row whose source is still open. Held
 * unconditionally that skip never ends: a row that is filed and never worked
 * hides its source forever, and hides it *silently*, because BLO-28618 also
 * (correctly) stopped forcing the source to `blocked` -- which is what used to
 * make the wedge visible in a blocked inbox.
 *
 * Deliberately much longer than the escalation staleness lookback (24h
 * default). The bound exists to catch rows nobody is going to work, not rows an
 * owner is merely slow to pick up, and it matches the ">7 days with no
 * activity" cohort the BLO-28618 census measured.
 *
 * Set to 0 to disable the bound and restore the pre-BLO-28957 unbounded skip.
 */
export const DEFAULT_LIVENESS_ABANDONED_RECOVERY_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Stable token on the comment left when a row is retired for abandonment
 * (BLO-28957). Grep/query on this rather than on the prose around it.
 */
export const ABANDONED_LIVENESS_RECOVERY_MARKER = "paperclip:liveness-recovery-abandoned";

type RecoveryActionBoundsConfig = {
  maxAttempts: number;
  timeoutMs: number;
};

/**
 * Read bounds when creating an action so deployments can tune newly-created
 * recovery work without changing actions that are already in flight.
 */
function recoveryActionBoundsConfig(): RecoveryActionBoundsConfig {
  const config = loadConfig();
  return {
    maxAttempts: config.recoveryActionMaxAttempts,
    timeoutMs: config.recoveryActionTimeoutMs,
  };
}

/** Bounds persisted on the first wake_owner escalation for an action. */
function recoveryActionBoundsAtCreation(now: Date): { maxAttempts: number; timeoutAt: Date } {
  const bounds = recoveryActionBoundsConfig();
  return {
    maxAttempts: bounds.maxAttempts,
    timeoutAt: new Date(now.getTime() + bounds.timeoutMs),
  };
}

// BLO-18995: how long an issue execution lock may be held by a run that has
// not yet been claimed (status still `queued`/`scheduled_retry`, startedAt
// null) before sweepStaleIssueLocks treats it as stale and clears it.
//
// Chosen well above any legitimate queue wait so this never races the
// dispatcher: a queued run is forced to the front of its agent's queue once it
// passes the 2h STARVATION_FULL_ESCALATION_MS floor in heartbeat.ts, so 6h
// leaves several hours of drain headroom past that escalation even for a
// heavily backlogged agent. Clearing the lock does not cancel or deprioritize
// the run — it only stops subsequent wakes for the issue from being parked
// behind a holder that may never start.
//
// BLO-21309: this is a bound on how long the *lock* is held, deliberately
// independent of how far out a `scheduled_retry` holder's `scheduledRetryAt` is.
// A `ccrotate_capacity` park takes its horizon from the provider's capacity
// reset and is routinely days away; letting that horizon set the lock lifetime
// took the issue out of service for the whole park, for its own assignee.
export const STALE_PRE_CLAIM_ISSUE_LOCK_MS = 6 * 60 * 60 * 1000;
// BLO-22060: sentinel return from the sweep transaction meaning "the lock moved
// between the pre-transaction scan and the FOR UPDATE revalidation, so this pass
// declined to clear it". Distinct from `null`, which means "revalidated and the
// lock is legitimately not stale". Only the former can starve the clear when a
// renewal keeps landing on the sweep's cadence, so only the former is counted
// and logged.
const LOCK_CHANGED_UNDER_SWEEP: unique symbol = Symbol("staleIssueLockSweep.lockChangedUnderSweep");
export const ISSUE_ASSIGNMENT_RECOVERY_PER_AGENT_SWEEP_LIMIT = 5;
const ASSIGNMENT_RECOVERY_CAPACITY_RESERVATION_STATUS = "assignment_recovery_capacity_reserved";
// Enqueue normally finishes in seconds; an hour-old reservation has lost its owning process.
const ASSIGNMENT_RECOVERY_CAPACITY_RESERVATION_TTL_MS = 60 * 60 * 1000;
// Keep in sync with heartbeat.ts requiresIssueExecutionRetryLock(). These
// retry kinds must retain issue.executionRunId through promotion: the promotion
// path gates on the lock under FOR UPDATE, and the pre-start staleness check
// cancels the run outright (`issue_execution_lock_changed`) if it changed. For
// these reasons alone, clearing the lock destroys the continuation instead of
// merely delaying it, so the sweeper leaves them held.
const SCHEDULED_RETRY_REASONS_REQUIRING_CONTINUOUS_ISSUE_LOCK = new Set([
  "max_turns_continuation",
  "capacity_blocked",
  "job_failed",
]);
// BLO-19941: the same backstop, for a holder wedged at `running`.
//
// `running` is neither missing nor terminal, so isCleanable() is false forever
// and — unlike the pre-claim case — executionLockedAt cannot be the basis: a
// healthy 4h run legitimately holds a 4h-old lock. Age must therefore be
// measured against the run's own most-recent *genuine* activity — the newest of
// lastUsefulActionAt / lastOutputAt / startedAt, NOT the first non-null of them
// (see latestRunActivityAt below). That is the same metric the dispatcher's slot
// gate uses (`nonStaleRunningRuns` in heartbeat.ts) and the reaper's own silence
// test (`externalLifecycleRecentRefTime` in heartbeat.ts); both of those took the
// first non-null rather than the max until BLO-20775 fixed them to match this.
// Deliberately NOT updatedAt:
// review/recovery churn bumps it every ~minute and would shield a dead run
// forever (BLO-8827, and the reaper's own note at heartbeat.ts:16444-16448).
//
// reapOrphanedRuns is the primary path and normally flips such a run terminal
// within minutes, but it is not a guarantee: several of its skips are
// clock-unbounded (a persistent duplicate-Job/identity mismatch recomputes
// identically every pass; the in-memory runningProcesses/activeRunExecutions
// skips last as long as the pod does; the hot-restart-adoption and detached-pid
// holds have no ceiling). This is the backstop for when it does not fire.
//
// 2h sits well clear of the reaper's own floors — 15m EXTERNAL_LIFECYCLE_STALE_MS
// and the 45m EXTERNAL_LIFECYCLE_HARD_STALE_MS that gates destructive kills — so
// the reaper always gets its full chance first and this only fires once it has
// demonstrably failed. Shorter than the 6h pre-claim bound on purpose: a
// `queued` holder may legitimately be waiting on capacity, whereas a `running`
// holder has already had its liveness independently evaluated every ~30s.
export const STALE_RUNNING_ISSUE_LOCK_MS = 2 * 60 * 60 * 1000;
// The activity columns are independent stamps, not a priority chain: a run can
// emit output without recording a useful action, so lastUsefulActionAt may be
// hours older than lastOutputAt on a perfectly live run. Selecting the *newest*
// valid timestamp is therefore the only safe reading — a `??` chain returns the
// first non-null, which lets a stale lastUsefulActionAt mask recent output and
// classify a live run as silent. Mirrors silenceStartedAtForRun() below, and
// matches nonLiveExecutionHoldSince()'s latestDate() in productivity-review.ts.
// NaN dates are dropped rather than propagated, so one bad row cannot poison
// the comparison into never tripping.
function latestRunActivityAt(...values: Array<Date | string | null | undefined>) {
  const times = values
    .map((value) => (value == null ? null : value instanceof Date ? value : new Date(value)))
    .filter((value): value is Date => value !== null && !Number.isNaN(value.getTime()))
    .map((value) => value.getTime());
  return times.length > 0 ? new Date(Math.max(...times)) : null;
}
const ACTIVE_RUN_OUTPUT_EVIDENCE_TAIL_BYTES = 8 * 1024;
// PEN-2106: `run.logBytes` is only written back when the log is FINALIZED, so it
// is null/0 for the entire population this detector fires on (a still-`running`
// row). It therefore cannot be a precondition for reading — only a seek hint.
// When the hint is absent or stale-low we walk forward from it in chunks and
// keep the trailing window, bounded so a pathologically large log cannot turn a
// detector sweep into a multi-MB read.
const ACTIVE_RUN_OUTPUT_EVIDENCE_SCAN_CHUNK_BYTES = 256 * 1024;
const ACTIVE_RUN_OUTPUT_EVIDENCE_MAX_SCAN_BYTES = 4 * 1024 * 1024;
// PEN-2106: only these adapters have a pod/Job behind a run row. On a
// sessioned-local adapter (claude_local, codex_local, …) there is no external
// lifecycle, so BLO-4467's "the pod is gone, reap it to free the concurrency
// lock" story is false in every clause — see staleRunOrphanedRowRemedy.
const RECOVERY_EXTERNAL_LIFECYCLE_ADAPTER_TYPES = new Set<string>(EXTERNAL_LIFECYCLE_ADAPTER_TYPES);
// BLO-7113: re-fire suppression for `stale_active_run_evaluation` wrappers.
// When the underlying `runs.status='running'` row is the canonical
// BLO-4467-family wedge (pod already reaped), the detector keeps re-firing
// every ~10-15 min on the SAME run. Each wrapper costs a CTO heartbeat slot
// to triage and close as a false-positive — three closures inside 23 min for
// one wedge was the trigger. If the most recent wrapper for the same run was
// closed (done/cancelled) within this window, suppress a fresh wrapper and
// instead record a running tally on the closed one. 1h: long enough to absorb
// the re-fire burst that follows a manual close, short enough that a run still
// stuck after an hour earns a genuinely fresh surface.
export const STALE_ACTIVE_RUN_EVALUATION_REFIRE_COOLDOWN_MS = 60 * 60 * 1000;
// After this many suppressed re-fires inside the escalation window, stop
// suppressing silently and reopen the latest wrapper to `in_progress` (pinging
// its owner / CTO) rather than opening wrapper #N+1.
export const STALE_ACTIVE_RUN_EVALUATION_ESCALATION_WINDOW_MS = 6 * 60 * 60 * 1000;
export const STALE_ACTIVE_RUN_EVALUATION_ESCALATION_THRESHOLD = 3;
// Stable body prefix on the suppression tally comment. Used both as the
// human-facing marker and as the counting key for the escalation threshold
// (issue_comments.metadata is a strict schema with no room for a custom tag,
// so we count by this prefix on system-authored comments within the window).
export const STALE_ACTIVE_RUN_EVALUATION_REFIRE_COMMENT_MARKER = "[detector] +1 fire";
// BLO-29601: prefix on the comment left when a liveness escalation is closed because its
// originating invariant stopped holding. Exported so tests and any future
// "why did this close?" audit can select these without parsing prose.
export const STALE_LIVENESS_ESCALATION_AUTO_RESOLVE_MARKER = "[liveness] auto-resolved:";
const STRANDED_ISSUE_RECOVERY_ORIGIN_KIND = RECOVERY_ORIGIN_KINDS.strandedIssueRecovery;
const STALE_ACTIVE_RUN_EVALUATION_ORIGIN_KIND = RECOVERY_ORIGIN_KINDS.staleActiveRunEvaluation;
const DEFERRED_WAKE_CONTEXT_KEY = "_paperclipWakeContext";
const EXECUTION_REVIEW_PARTICIPANT_RECOVERY_REASON = "execution_review_participant_recovery";
const RESOLVED_DEPENDENCY_WAKE_BACKSTOP_CANDIDATE_LIMIT = 500;
const STRANDED_RECOVERY_WAKE_BACKSTOP_CANDIDATE_LIMIT = 500;
// A persisted claim gives a process that dies after the review-stage transaction commits a
// bounded retry lease. It deliberately does not spend another recovery-action attempt: that
// attempt was already reserved by the escalation which failed to dispatch its wake.
const STRANDED_RECOVERY_WAKE_BACKSTOP_COOLDOWN_MS = 30 * 60 * 1000;

/**
 * Bounds for the ownership-only hand-back drain (BLO-19123).
 *
 * The budget is the load-bearing one: a source issue may be auto-returned at most twice
 * across all time. A dependency-blocked row that keeps re-stranding is not a routing problem
 * the drain can fix by handing it back a third time — it is a signal that something about
 * that issue needs a human, so the drain reports it as residual instead of oscillating.
 */
const STRANDED_RECOVERY_MAX_HAND_BACKS_PER_ISSUE = 2;
const STRANDED_RECOVERY_HAND_BACK_COOLDOWN_MS = 6 * 60 * 60 * 1000;
/**
 * How recently the return owner must have completed real work. Wider than the cooldown on
 * purpose: an IC parked behind a provider-capacity wait can be legitimately quiet for hours
 * and is still the right owner.
 */
const STRANDED_RECOVERY_HAND_BACK_RUN_EVIDENCE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const STRANDED_RECOVERY_HAND_BACK_CANDIDATE_LIMIT = 500;

/**
 * Batch size for the deferred-candidate enumeration (BLO-19123, #1549 review).
 *
 * This is a page size, NOT an inventory bound: the enumeration loops until the deferred set
 * is exhausted, so every deferred row is named regardless of how many there are. An earlier
 * revision capped the enumeration instead, which just moved the unnamed-rows problem to a
 * higher threshold — an inventory that is complete "up to N" is not the individually
 * actionable repair list the acceptance criterion asks for.
 *
 * Exhaustive enumeration is affordable because the population is bounded by construction and
 * measured: the filter is `blocked` + active `stranded_assigned_issue` action + non-null
 * `returnOwnerAgentId` differing from the assignee, so its ceiling is the company's blocked
 * issue count — 811 across every agent on 2026-08-30, against ~360 rows actually mis-owned.
 * Each row costs three columns. Bounding the *processing* loop at
 * `STRANDED_RECOVERY_HAND_BACK_CANDIDATE_LIMIT` still matters, because working a candidate
 * costs several queries and a transaction; naming one does not.
 */
const STRANDED_RECOVERY_HAND_BACK_RESIDUAL_PAGE_SIZE = 1000;

/**
 * How many residual rows a single log line carries. The residual is now bounded only by the
 * candidate population, so a whole-set log line could bury everything around it. The sample
 * plus `residualByReason` (which is always complete, being a count over every residual row)
 * answers "what was skipped and why" without that; `residualTruncated` keeps the line from
 * implying it is the full set. The full set is in `result.residual`, which is what the
 * scheduler's caller receives.
 */
const STRANDED_RECOVERY_HAND_BACK_RESIDUAL_LOG_SAMPLE = 50;

export type StrandedRecoveryHandBackResidualRow = {
  issueId: string;
  identifier: string | null;
  returnOwnerAgentId: string | null;
  reason: string;
  detail?: string;
};

/**
 * Decides what a hand-back pass should report, and is exported so the decision is testable
 * without standing up the scheduler (nothing imports `src/index.ts` under test).
 *
 * A pass that skips every candidate is the case this exists for. It is not a quiet pass — it
 * is the pass whose residual an operator most needs, because every row it examined stayed
 * mis-owned and the reasons are the repair list. Reporting only when `handedBack > 0` left
 * that inventory unrecoverable, which is the defect this closes.
 *
 * Returns `null` only when the pass had nothing to say at all (no candidates, no residual),
 * so an idle fleet does not log on every scheduler tick.
 */
export function summarizeStrandedRecoveryHandBackPass(
  result: {
    handedBack: number;
    failed: number;
    residual: readonly StrandedRecoveryHandBackResidualRow[];
  } & Record<string, unknown>,
  opts?: { residualSampleLimit?: number },
): { level: "info" | "warn"; message: string; payload: Record<string, unknown> } | null {
  const { residual, ...counters } = result;
  const residualCount = residual.length;
  if (result.handedBack === 0 && result.failed === 0 && residualCount === 0) return null;

  const sampleLimit = Math.max(0, Math.floor(opts?.residualSampleLimit ?? STRANDED_RECOVERY_HAND_BACK_RESIDUAL_LOG_SAMPLE));
  const residualByReason: Record<string, number> = {};
  for (const row of residual) {
    residualByReason[row.reason] = (residualByReason[row.reason] ?? 0) + 1;
  }

  return {
    // A pass that returned nothing while holding residual is not an error — a fleet whose
    // candidates are all legitimately on the live path skips all of them — but it is the
    // line an operator goes looking for, so it must not be buried at info alongside the
    // successful passes.
    level: result.failed > 0 || (result.handedBack === 0 && residualCount > 0) ? "warn" : "info",
    message:
      result.handedBack > 0
        ? "stranded-recovery hand-back pass returned ownership to original owners"
        // True unconditionally: candidates the pass deferred past its processing limit are
        // enumerated exhaustively, so `residual` names every candidate it did not hand back.
        : "stranded-recovery hand-back pass returned nothing; every candidate is enumerated in residual",
    payload: {
      ...counters,
      residualCount,
      residualByReason,
      residual: sampleLimit > 0 ? residual.slice(0, sampleLimit) : [],
      // Bounds the LOG LINE only. `residualCount`, `residualByReason` and the caller's
      // `result.residual` all remain complete.
      residualTruncated: residualCount > sampleLimit,
    },
  };
}

/**
 * Signals that the issue-side ownership write lost a race after the action was already
 * resolved in the same transaction, so the whole hand-back must roll back together.
 */
class HandBackOwnershipRaceLost extends Error {
  constructor() {
    super("hand-back ownership race lost");
    this.name = "HandBackOwnershipRaceLost";
  }
}

/**
 * `targetDate` is a calendar date, not an instant, so a deadline of "today" is still live.
 * Only a strictly earlier day counts as expired.
 */
function isValidityWindowExpired(targetDate: string | Date, now: Date): boolean {
  const raw = targetDate instanceof Date ? targetDate.toISOString().slice(0, 10) : String(targetDate).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return false;
  return raw < now.toISOString().slice(0, 10);
}

/**
 * Issue statuses whose active recovery actions `reconcileStrandedAssignedIssues` can select.
 * These are the dispatchable ones: the repair is to re-drive the owner.
 */
export const STRANDED_ASSIGNED_ISSUE_STATUSES = [
  "todo",
  "in_progress",
  "in_review",
] as const satisfies readonly IssueStatus[];

/**
 * Issue statuses whose active recovery actions `reconcileStrandedRecoveryWakeBackstop` can
 * select. `blocked` is woken; `backlog` is folded (see the sweep's doc comment, BLO-25907).
 */
export const STRANDED_RECOVERY_WAKE_BACKSTOP_ISSUE_STATUSES = [
  "blocked",
  "backlog",
] as const satisfies readonly IssueStatus[];

/**
 * Statuses the backstop resolves rather than wakes. Kept separate from the candidate list so
 * the coverage-union invariant can distinguish "selected and woken" from "selected and folded"
 * — both count as covered, but only the former may enqueue a wake.
 */
export const STRANDED_RECOVERY_WAKE_BACKSTOP_FOLD_ONLY_STATUSES = [
  "backlog",
] as const satisfies readonly IssueStatus[];

/**
 * Every non-terminal issue status must be selectable by at least one recovery sweep, or an
 * active recovery action on it is a zombie no reconciler can service (BLO-25907, BLO-16074
 * gap 3). `issue-recovery-actions.test.ts` asserts this union covers
 * `ISSUE_STATUSES` minus the terminal ones, so adding a status without routing it to a sweep
 * fails the suite instead of silently reopening the hole.
 */
export const RECOVERY_SWEEP_COVERED_ISSUE_STATUSES = [
  ...STRANDED_ASSIGNED_ISSUE_STATUSES,
  ...STRANDED_RECOVERY_WAKE_BACKSTOP_ISSUE_STATUSES,
] as const satisfies readonly IssueStatus[];
const SESSIONED_LOCAL_ADAPTERS = new Set([
  "claude_local",
  "codex_local",
  "cursor",
  "gemini_local",
  "hermes_local",
  "opencode_local",
  "pi_local",
]);

// GGU-809: when a stranded `in_progress` issue would otherwise hit the
// `isRepeatedProductiveContinuationRecovery` escalation path, exempt the
// escalation if the assignee posted a comment or attachment within this window.
// Batch workflows (e.g. Image Spec multi-frame generation) make real progress
// every heartbeat and would otherwise trigger a recovery issue after just two
// productive heartbeats. Floor the override at 60s to keep the exemption from
// being effectively disabled by misconfiguration.
export const STRANDED_RECENT_PROGRESS_EXEMPTION_MS = Math.max(
  60_000,
  Number(process.env.STRANDED_RECENT_PROGRESS_EXEMPTION_MS) || 30 * 60 * 1000,
);

/**
 * BLO-18996: hard ceiling on how many times one source-scoped recovery action may wake
 * an owner before the sweep stops re-firing it.
 *
 * Retained as a compatibility export for callers that still inspect the legacy
 * environment setting. Newly-created actions use `recoveryActionBoundsConfig`
 * and `RECOVERY_ACTION_MAX_ATTEMPTS` instead.
 *
 * Every wake this action mints is discretionary — nothing downstream verifies that the
 * owner it names can actually discharge it. When the owner cannot (the reported case: a
 * `stranded_assigned_issue` action named an owner who was then 403'd by `issue:comment`
 * on the very issue it woke them about), the action never resolves, `attemptCount` grows
 * without bound, and each sweep pays for another wake that cannot possibly make
 * progress. Bounding the wakes converts a silent infinite loop into a visible terminal
 * state: the action stays open with `attemptCount > maxAttempts`, which is directly
 * queryable, and the source issue carries a one-time system comment saying so.
 *
 * Deliberately generous — this is a runaway backstop, not a retry policy. Legitimate
 * recovery converges in one or two attempts, and a discharge resolves the action so the
 * next escalation starts a fresh one at attempt 1.
 */
export const STRANDED_RECOVERY_MAX_OWNER_WAKE_ATTEMPTS = Math.max(
  2,
  Number(process.env.STRANDED_RECOVERY_MAX_OWNER_WAKE_ATTEMPTS) || 5,
);

/**
 * BLO-18996: outer horizon on the same loop, in wall-clock time rather than attempts.
 * Newly-created actions use `recoveryActionBoundsConfig` and
 * `RECOVERY_ACTION_TIMEOUT_MS`; this static value remains for compatibility.
 *
 * `attemptCount` is a per-OWNER budget — it restarts when the action changes hands, which is
 * what makes a genuinely reassigned owner reachable again. But owner identity is not stable
 * across sweeps: escalation reassigns the source issue to the recovery owner, and
 * `resolveStrandedIssueRecoveryOwnerAgentId` then routes from the new assignee's `reportsTo`.
 * In an org deeper than two levels that ping-pongs (CTO -> CEO -> CTO -> ...), because the
 * CEO has no `reportsTo` and the role fallback orders `cto` first. Every sweep is then an
 * owner change, the per-owner counter never leaves 1, and the attempt budget alone bounds
 * nothing — measured at 30 wakes over 30 sweeps against a budget of 5.
 *
 * So the attempt budget cannot be the only bound. This horizon is anchored to the action's
 * own creation instant, which no sweep rewrites, and therefore holds no matter how ownership
 * churns. Past it the sweep stops waking anyone for the action and says so once on the
 * source issue, exactly as attempt exhaustion does.
 */
export const STRANDED_RECOVERY_OWNER_WAKE_HORIZON_MS = Math.max(
  60_000,
  Number(process.env.STRANDED_RECOVERY_OWNER_WAKE_HORIZON_MS) || 6 * 60 * 60 * 1000,
);

/**
 * Escape a literal for use inside a `LIKE` pattern. Mirrors the helper in
 * `services/issues.ts` (module-private there); the call sites below pair it with an
 * explicit `ESCAPE '\'` clause, which is the same idiom that file uses.
 */
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

/**
 * True once this action has spent its wake budget. Only actions that actually carry a
 * budget are bounded: `maxAttempts` is left null for the causes that never wake an owner
 * (OWNERLESS provider-quota monitor waits, manual-repair holds), so neither their
 * long-lived `attemptCount` nor their age trips this. Provider-quota WITH a manager-ladder
 * owner is not in that set — it wakes that owner, so it is bounded like any other
 * escalation.
 *
 * Two independent bounds, either of which is terminal:
 *   - the per-owner attempt budget, which restarts on reassignment; and
 *   - `timeoutAt`, the creation-anchored horizon that owner churn cannot reset.
 * `maxAttempts !== null` gates both, so "does this action wake anyone at all" stays a single
 * decision made once at escalation time.
 */
export function strandedRecoveryWakeAttemptsExhausted(
  action: { attemptCount: number; maxAttempts: number | null; timeoutAt?: Date | string | null },
  now: Date = new Date(),
  attemptAlreadyReserved = true,
) {
  if (action.maxAttempts === null) return false;
  // Most callers check after reserving the next attempt. The backstop reads a
  // persisted row without reserving, so an exact budget is exhausted there.
  if (attemptAlreadyReserved ? action.attemptCount > action.maxAttempts : action.attemptCount >= action.maxAttempts) {
    return true;
  }
  if (!action.timeoutAt) return false;
  const horizon = action.timeoutAt instanceof Date ? action.timeoutAt : new Date(action.timeoutAt);
  return Number.isFinite(horizon.getTime()) && horizon.getTime() <= now.getTime();
}

type RecoveryWakeupOptions = {
  source?: "timer" | "assignment" | "on_demand" | "automation";
  triggerDetail?: "manual" | "ping" | "callback" | "system";
  reason?: string | null;
  payload?: Record<string, unknown> | null;
  idempotencyKey?: string | null;
  requestedByActorType?: "user" | "agent" | "system";
  requestedByActorId?: string | null;
  contextSnapshot?: Record<string, unknown>;
  retryOfRunId?: string | null;
  scheduledRetryAttempt?: number;
  expectedLockOwnerState?: IssueLockOwnerState | null;
};

type RecoveryWakeup = (
  agentId: string,
  opts?: RecoveryWakeupOptions,
) => Promise<typeof heartbeatRuns.$inferSelect | null>;

type ResolvedDependencyWakeBackstopSource =
  | "issue_graph_liveness.backstop"
  | "workspace.finalize";

type ResolvedDependencyWakeBackstopOptions = {
  runId?: string | null;
  companyId?: string | null;
  blockerIssueId?: string | null;
  source?: ResolvedDependencyWakeBackstopSource;
};

type LatestIssueRun = Pick<
  typeof heartbeatRuns.$inferSelect,
  | "id"
  | "agentId"
  | "status"
  | "error"
  | "errorCode"
  | "contextSnapshot"
  | "livenessState"
  | "resultJson"
  | "usageJson"
  | "sessionIdBefore"
  | "scheduledRetryAttempt"
  | "createdAt"
  | "finishedAt"
> | null;
type SuccessfulLatestIssueRun = NonNullable<LatestIssueRun> & { status: "succeeded" };

type StrandedRecoveryCause =
  | "stranded_assigned_issue"
  | "process_lost"
  | "provider_quota"
  | "codex_output_inactivity_monitor"
  | "workspace_validation_failed"
  | "configuration_incomplete"
  | "execution_review_participant_recovery"
  | typeof SUCCESSFUL_RUN_MISSING_STATE_REASON;

type StrandedPreviousStatus = "todo" | "in_progress" | "in_review";

const ROUTE_TO_ORIGINAL_INFRA_ERROR_CODES = new Set([
  "job_failed",
  "k8s_pod_schedule_failed",
  "adapter_failed",
  "external_lifecycle_stale_killed",
  "k8s_concurrency_guard_unreachable",
]);

type SuccessfulRunHandoffRecoveryEvidence = {
  sourceRunId: string | null;
  correctiveRunId: string;
  missingDisposition: string;
  handoffAttempt: number;
  maxHandoffAttempts: number;
};

function readRecoveryRunErrorFamily(latestRun: LatestIssueRun) {
  const result = parseObject(latestRun?.resultJson);
  return readNonEmptyString(result.errorFamily);
}

function isProviderQuotaRecovery(latestRun: LatestIssueRun) {
  if (latestRun?.errorCode === "provider_quota" || latestRun?.errorCode === "provider_quota_exhausted") return true;
  if (readRecoveryRunErrorFamily(latestRun) === "provider_quota") return true;
  if (latestRun?.errorCode !== "adapter_failed") return false;
  return /(?:usage|rate|quota) limit|quota (?:exceeded|reset)|try again after/i.test(latestRun.error ?? "");
}

// BLO-20933: a run that dies because its POD vanished (eviction, preemption, node
// drain, or the Job being deleted out from under it) is an infrastructure event, not
// an agent/adapter failure — the run never got a chance to succeed or fail on its own
// merits. `paperclip-adapter-claude-k8s` cannot always tell a vanished pod apart from a
// genuine crash at exit time, so a truncated stream surfaces as the same `claude_truncated`
// code either way; the distinguishing signal is the pod-removal wording
// `describeTruncationCause` attaches to the error text when the pod is confirmed missing.
// `k8s_job_deleted_externally` is unambiguous by code alone. Exported so the routing
// decision this feeds is auditable/testable independent of the cause plumbing below.
//
// `paperclip-adapter-claude-k8s`'s `execute.ts` emits exactly one fixed string for a
// confirmed-missing pod: "pod is gone — Job pod was removed (eviction, preemption, or
// external delete) before exit could be read". The eviction/preemption/external-delete
// wording only ever appears inside that same sentence, so matching on it independently
// added no true-positive coverage — it only widened the surface for an unrelated
// `claude_truncated` message that happens to mention "eviction" to false-collide. The
// two adapter markers below are the actual signal.
export function isInfraClassStrandedFailure(latestRun: LatestIssueRun): boolean {
  if (!latestRun) return false;
  if (latestRun.errorCode === "k8s_job_deleted_externally") return true;
  if (latestRun.errorCode !== "claude_truncated") return false;
  return /pod is gone|pod was removed/i.test(latestRun.error ?? "");
}

function resolveStrandedRecoveryCause(
  latestRun: LatestIssueRun,
  explicitCause?: StrandedRecoveryCause,
): StrandedRecoveryCause {
  if (explicitCause) return explicitCause;
  if (isProviderQuotaRecovery(latestRun)) return "provider_quota";
  if (latestRun?.errorCode === "process_lost") return "process_lost";
  if (latestRun?.errorCode === "codex_output_inactivity_monitor") {
    return "codex_output_inactivity_monitor";
  }
  return "stranded_assigned_issue";
}

function readWorkspaceValidationPayload(latestRun: LatestIssueRun): Record<string, unknown> | null {
  const payload = parseObject(parseObject(latestRun?.resultJson).workspaceValidation);
  return Object.keys(payload).length > 0 ? payload : null;
}

function readWorkspaceValidationFingerprint(latestRun: LatestIssueRun): string | null {
  const payload = readWorkspaceValidationPayload(latestRun);
  return readNonEmptyString(payload?.fingerprint);
}

type WatchdogDecisionActor =
  | { type: "board"; userId?: string | null; runId?: string | null }
  | { type: "agent"; agentId?: string | null; runId?: string | null }
  | { type: "none" };

export type RunOutputSilenceSummary = {
  lastOutputAt: Date | null;
  lastOutputSeq: number;
  lastOutputStream: "stdout" | "stderr" | null;
  silenceStartedAt: Date | null;
  silenceAgeMs: number | null;
  level: "not_applicable" | "ok" | "suspicious" | "critical" | "snoozed";
  suspicionThresholdMs: number;
  criticalThresholdMs: number;
  snoozedUntil: Date | null;
  evaluationIssueId: string | null;
  evaluationIssueIdentifier: string | null;
  evaluationIssueAssigneeAgentId: string | null;
};

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function normalizeAgentNameKey(value: string | null | undefined) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

// `extractAgentMcpKeys` reads the adapter_config.mcpServers map (set by
// adapter-specific configs like claude_k8s) and returns the sorted list of
// MCP names. Used in the recovery prompt so the recovery agent can see at
// a glance what tools the original assignee had vs candidate replacements
// (e.g. UXDesigner → [figma, webflow], CTO → []). The schema doesn't
// enforce the shape, so this is best-effort: missing or malformed
// `mcpServers` returns []. Skill names (paperclipSkillSync.desiredSkills)
// are intentionally NOT surfaced here — they're long lists with a lot of
// shared baseline that would obscure the meaningful MCP-coverage signal.
function extractAgentMcpKeys(agent: typeof agents.$inferSelect | null | undefined): string[] {
  if (!agent) return [];
  const adapterConfig = parseObject(agent.adapterConfig);
  const mcpServers = adapterConfig.mcpServers;
  if (!mcpServers || typeof mcpServers !== "object" || Array.isArray(mcpServers)) return [];
  return Object.keys(mcpServers).sort();
}

function summarizeAgentCapabilities(agent: typeof agents.$inferSelect | null | undefined): string {
  if (!agent) return "";
  const cap = readNonEmptyString(agent.capabilities);
  if (!cap) return "";
  // Single-line summary; long capability blurbs would dominate the prompt.
  const trimmed = cap.replace(/\s+/g, " ").trim();
  return trimmed.length > 200 ? `${trimmed.slice(0, 197)}...` : trimmed;
}

// PR #4600 redacted this to a "details withheld from the issue thread"
// sentinel because raw adapter error blobs can carry secrets (API keys,
// JWTs, internal hostnames). That left the recovery agent flying blind:
// with no visible signal of WHY the original assignee failed, the only
// reasonable action was to grab ownership of the parent issue and try
// itself. Observed BLO-3182 (2026-05-04 → 2026-05-06): UXDesigner failed
// once, recovery escalated to CTO with no diagnostic, CTO reassigned the
// parent to itself, then looped for 4 days posting empty "No response
// requested." runs because CTO doesn't have the Webflow MCP the issue
// actually needs.
//
// Restore a structured summary (errorCode + first line of the error
// message, capped) but pass it through `redactSensitiveText` first so any
// secrets in the raw error blob get scrubbed. errorCode is a stable
// classifier (e.g. `rate_limit_exhausted`, `silent_failure`) and is never
// itself sensitive — surface it always.
// BLO-18278: the capacity-reset instant heartbeat finalization recovered from
// the throttle fault (see parseProviderCapacityResetHorizon). Read from the
// run's own resultJson so the strand comment can attribute the stall to the
// provider window rather than to whatever terminal symptom got recorded last.
//
// `run.resultJson` starts as adapter-owned data, and summarizeRunFailureForIssueComment
// interpolates selected fields into an issue comment other agents read. The
// `providerCapacityResetAt` path is therefore trusted only when heartbeat
// finalization also wrote the paired server provenance key after stripping any
// adapter-supplied copy. Without that discriminator, a spoofed adapter result
// could relabel an ordinary failure as a self-healing capacity window.
const PROVIDER_CAPACITY_THROTTLE_FAMILIES = new Set(["rate_limit_exhausted", "provider_quota"]);
const PROVIDER_CAPACITY_RESET_PROVENANCE_SOURCE = "server_parse_provider_capacity_horizon";

// Full-string match — no surrounding prose, markdown, or newlines survive it.
// Mirrors the shape parseProviderCapacityResetHorizon captures on the write side.
const PROVIDER_CAPACITY_RESET_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

// The horizon was advertised during the run that recorded it, and the write side
// caps an accepted horizon at PROVIDER_CAPACITY_MAX_HORIZON_MS past
// finalization. Bound the read lower side by run creation and the upper side by
// run finish (falling back to creation) so long-running jobs can still report a
// horizon parsed near the end.
//
// This is the SAME constant the writer caps with, deliberately — an over-cap
// park lands exactly on the upper bound below, so the two diverging would
// silently refuse every such horizon on read.
const PROVIDER_CAPACITY_RESET_MAX_SKEW_MS = PROVIDER_CAPACITY_MAX_HORIZON_MS;

type ProviderCapacityResetBounds = {
  lowerBoundAt: Date | null;
  upperBoundAt: Date | null;
};

function readCapacityResetBounds(run: NonNullable<LatestIssueRun>): ProviderCapacityResetBounds {
  const createdAt = run.createdAt instanceof Date ? run.createdAt : null;
  const finishedAt = run.finishedAt instanceof Date ? run.finishedAt : null;
  return { lowerBoundAt: createdAt, upperBoundAt: finishedAt ?? createdAt };
}

function canonicalizeCapacityResetInstant(value: unknown, bounds: ProviderCapacityResetBounds): string | null {
  const raw = readNonEmptyString(value)?.trim();
  if (!raw) return null;
  if (!PROVIDER_CAPACITY_RESET_INSTANT_PATTERN.test(raw)) return null;
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) return null;

  const lowerAnchor = bounds.lowerBoundAt?.getTime();
  if (lowerAnchor !== undefined && Number.isFinite(lowerAnchor)) {
    if (parsed < lowerAnchor - PROVIDER_CAPACITY_RESET_MAX_SKEW_MS) return null;
  }
  const upperAnchor = bounds.upperBoundAt?.getTime();
  if (upperAnchor !== undefined && Number.isFinite(upperAnchor)) {
    if (parsed > upperAnchor + PROVIDER_CAPACITY_RESET_MAX_SKEW_MS) return null;
  }
  return new Date(parsed).toISOString();
}

function normalizeHttpStatusCode(value: unknown): number | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim().length > 0
        ? Number(value.trim())
        : NaN;
  if (!Number.isInteger(parsed) || parsed < 100 || parsed > 599) return null;
  return parsed;
}

function readProviderCapacityResetProvenance(resultJson: Record<string, unknown>) {
  const provenance = parseObject(resultJson.providerCapacityResetProvenance);
  if (readNonEmptyString(provenance.source) !== PROVIDER_CAPACITY_RESET_PROVENANCE_SOURCE) {
    return null;
  }
  const family = readNonEmptyString(provenance.errorFamily);
  if (!family || !PROVIDER_CAPACITY_THROTTLE_FAMILIES.has(family)) return null;
  return {
    errorFamily: family,
    observedStatusCode: normalizeHttpStatusCode(provenance.observedStatusCode),
    // BLO-18285: present only when the run parked at the horizon cap rather
    // than on the instant the provider named. `providerCapacityResetAt` is then
    // OUR checkpoint, not the provider's claim — so any sentence attributing it
    // to the provider has to use this field instead, or it states something the
    // provider never said.
    advertisedResetAt: readNonEmptyString(provenance.advertisedResetAt) ?? null,
  };
}

type ProviderCapacityResetRead = {
  resetAt: string;
  // True only when the instant carries real 429-capacity provenance, i.e. the
  // server's own `providerCapacityResetAt`, which finalization writes solely
  // from parseProviderCapacityResetHorizon under a throttle override. A bare
  // `retryNotBefore` does NOT qualify: `rate_limit_exhausted` is set by
  // isRateLimitExhausted() for "429, 401-cap, or 'you've hit your limit' cap
  // text" (heartbeat.ts), and `provider_quota` is a legacy adapter quota
  // signal — neither implies a 429 capacity event, so neither may be reported
  // as one.
  is429Capacity: boolean;
  // BLO-18285: set when `resetAt` is our capped checkpoint rather than the
  // provider's own instant. Distinguishing them keeps the strand comment
  // honest: at the checkpoint the ADVERTISED window has not elapsed, so the
  // "that horizon has since elapsed" wording below would be simply untrue.
  advertisedResetAt: string | null;
};

function readProviderCapacityResetAt(
  run: NonNullable<LatestIssueRun>,
): ProviderCapacityResetRead | null {
  const resultJson = parseObject(run.resultJson);

  const family = readNonEmptyString(resultJson.errorFamily);
  if (!family || !PROVIDER_CAPACITY_THROTTLE_FAMILIES.has(family)) return null;

  const bounds = readCapacityResetBounds(run);

  const provenance = readProviderCapacityResetProvenance(resultJson);
  const explicit = provenance
    ? canonicalizeCapacityResetInstant(resultJson.providerCapacityResetAt, bounds)
    : null;
  if (explicit) {
    return {
      resetAt: explicit,
      is429Capacity: provenance?.observedStatusCode === 429,
      advertisedResetAt: provenance?.advertisedResetAt ?? null,
    };
  }

  const advertised =
    canonicalizeCapacityResetInstant(resultJson.retryNotBefore, bounds) ??
    canonicalizeCapacityResetInstant(resultJson.transientRetryNotBefore, bounds);
  return advertised ? { resetAt: advertised, is429Capacity: false, advertisedResetAt: null } : null;
}

export function summarizeRunFailureForIssueComment(run: LatestIssueRun, now = Date.now()) {
  if (!run) return null;

  const errorCode = readNonEmptyString(run.errorCode)?.trim() ?? null;
  const rawError = readNonEmptyString(run.error)?.trim() ?? null;

  // BLO-18278: when the run was actually killed by a provider capacity
  // throttle that advertised a reset, say so. The generic text this would
  // otherwise emit — `job_failed` — External lifecycle Job failed:
  // BackoffLimitExceeded — describes the symptom (the Job gave up) and reads
  // as an infrastructure fault, which repeatedly sent readers looking at the
  // cluster instead of at a provider window that had already reopened on its
  // own. Naming the window and the instant is the difference between "our Job
  // broke" and "the provider was closed until 21:29:59Z".
  //
  // Only the explicit server-parsed horizon may be called a 429: the throttle
  // families also cover 401 cap-windows and legacy quota signals, so a bare
  // advertised `retryNotBefore` gets the honest "rate-limit/quota window"
  // phrasing instead of a status code we cannot substantiate.
  //
  // The horizon is also only load-bearing while it is still in the future.
  // Recovery sweeps run on their own cadence and routinely read a run that
  // failed hours earlier, so an unconditional present-tense "waiting on that
  // reset … self-healing" tells agents to sit out a window that already
  // reopened — the exact misdiagnosis this summary exists to prevent, pointed
  // the other way.
  //
  // But an elapsed horizon is not proof the window reopened either. The instant
  // is the provider's own estimate, and the write-side parser deliberately
  // accepts tentative wording ("capacity may reset at …", "retry in …"); a
  // throttle can be extended past the instant it advertised. So past the
  // horizon we claim only that the horizon elapsed and that current capacity
  // must be rechecked. Asserting "the cause is something after it" would trade
  // one confident misdiagnosis for another — sending the reader hunting a new
  // blocker while the original throttle is still the live one.
  const capacityReset = readProviderCapacityResetAt(run);
  if (capacityReset) {
    const suffix = errorCode ? ` (surfaced as \`${errorCode}\`)` : "";

    // BLO-18285: an over-cap park. `resetAt` here is OUR checkpoint, not the
    // provider's instant, so it must not be attributed to the provider — and
    // the elapsed-horizon branch below must not fire on it, because reaching
    // the checkpoint says nothing about the advertised window, which is still
    // open by construction. Report both numbers and what each one means.
    if (capacityReset.advertisedResetAt) {
      const cause =
        `provider capacity throttle (429) — the provider advertised a capacity reset at ` +
        `${capacityReset.advertisedResetAt}, further out than we are willing to park on a single ` +
        `unverified estimate`;
      // Same cadence problem as the advertised-horizon branch below: a sweep
      // routinely reads this run long after it failed. Past our own checkpoint
      // the present tense is simply false — there is no live park left to
      // describe — and "it parks again" would promise a retry path that only
      // exists if something actually re-ran. Both readings sent operators
      // waiting on a park that had already lapsed.
      //
      // What stays unclaimed past the checkpoint is whether the *advertised*
      // window reopened: the checkpoint is our bound, not the provider's, so
      // reaching it is no evidence either way. Hence "recheck", not "expired".
      const checkpointAtMs = Date.parse(capacityReset.resetAt);
      const checkpointStillAhead = Number.isFinite(checkpointAtMs) && checkpointAtMs > now;
      return checkpointStillAhead
        ? ` Latest retry failure: ${cause}${suffix}. The run is parked until ${capacityReset.resetAt} ` +
            `to recheck capacity rather than waiting out the full advertised window; if the throttle is ` +
            `still in force then, it parks again. This is transient and self-healing — the issue is ` +
            `waiting on provider capacity, not on a broken runtime.`
        : ` Latest retry failure: ${cause}${suffix}. Paperclip capped the park at ` +
            `${capacityReset.resetAt}, and that checkpoint has since passed, so this is no longer a ` +
            `live park. Reaching our own checkpoint says nothing about whether the advertised window ` +
            `reopened — recheck current provider capacity and whether a further retry was actually ` +
            `scheduled before either waiting on this window or diagnosing a different blocker.`;
    }

    const cause = capacityReset.is429Capacity
      ? `provider capacity throttle (429) — the provider advertised a capacity reset at ${capacityReset.resetAt}`
      : `provider rate-limit/quota window — the provider advertised availability no earlier than ${capacityReset.resetAt}`;
    const resetAtMs = Date.parse(capacityReset.resetAt);
    const windowStillOpen = Number.isFinite(resetAtMs) && resetAtMs > now;
    return windowStillOpen
      ? ` Latest retry failure: ${cause}${suffix}. This is transient and self-healing; ` +
          `the issue is waiting on that reset, not on a broken runtime.`
      : ` Latest retry failure: ${cause}${suffix}. That advertised horizon has since elapsed, ` +
          `but the provider only ever advertised it as an estimate and a throttle can be ` +
          `extended past it — recheck current provider capacity before either waiting on this ` +
          `window or diagnosing a different blocker.`;
  }

  // Prefer the JSON `"message": "..."` field if the error body is a JSON
  // blob (matches the heartbeat-side summarizer); otherwise take the first
  // non-empty line. Cap to 240 chars before redaction.
  const apiMessageMatch = rawError?.match(/"message"\s*:\s*"([^"]+)"/);
  const firstLine = rawError
    ?.split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) ?? null;
  const summarySource = apiMessageMatch?.[1] ?? firstLine;
  const truncated =
    summarySource && summarySource.length > 240
      ? `${summarySource.slice(0, 237)}...`
      : summarySource;
  const summary = truncated ? redactSensitiveText(truncated) : null;

  if (errorCode && summary) return ` Latest retry failure: \`${errorCode}\` — ${summary}.`;
  if (errorCode) return ` Latest retry failure: \`${errorCode}\`.`;
  if (summary) return ` Latest retry failure: ${summary}.`;
  return null;
}

// Run failures that the recovery sweep must NOT retry. These are environment
// preconditions that no amount of re-dispatch will resolve — the next run will
// fail in the same way until a human (or the workspace owner) intervenes. We
// escalate to `blocked` on the first occurrence rather than burning a recovery
// cycle and producing another `Latest retry failure withheld` comment. See
// BLO-1498 (recovery loop spun 5+ cycles on a single tar conflict).
const NON_RETRYABLE_RUN_ERROR_CODES = new Set<string>([
  "workspace_import_conflict",
  "workspace_repo_mismatch",
]);

function isNonRetryableTerminalRun(latestRun: LatestIssueRun) {
  if (!latestRun) return false;
  if (
    !UNSUCCESSFUL_HEARTBEAT_RUN_TERMINAL_STATUSES.includes(
      latestRun.status as (typeof UNSUCCESSFUL_HEARTBEAT_RUN_TERMINAL_STATUSES)[number],
    )
  ) {
    return false;
  }
  const errorCode = readNonEmptyString(latestRun.errorCode);
  return Boolean(errorCode && NON_RETRYABLE_RUN_ERROR_CODES.has(errorCode));
}

// BLO-18860: `issue_checkout_adopted` is a HANDOVER marker, not a failure.
// `adoptStaleCheckoutRun`/`adoptUnownedCheckoutRun` (services/issues.ts) cancel
// an issue's older context runs when a *live* run of the same assignee writes to
// that issue, and deliberately keep the adopting run alive (`keepRunId`). The
// cancellation is bookkeeping about the run that lost the checkout; it says
// nothing about the issue's health, so it must never be the evidence that
// escalates the issue away from the agent whose write produced it. Observed live
// on BLO-18237 (2026-07-30): CTO — the assignee — PATCHed a stale issue at
// 02:40:42Z (200 OK, adoption), and 25s later the resulting cancellation was
// classified as a stranded-work failure and the issue was reassigned CTO → CEO
// and flipped to `blocked`, taking CTO's write access with it.
const CHECKOUT_ADOPTED_RUN_ERROR_CODE = "issue_checkout_adopted";

function isCheckoutAdoptionCancelledRun(
  latestRun: LatestIssueRun,
): latestRun is NonNullable<LatestIssueRun> {
  return (
    latestRun?.status === "cancelled" &&
    readNonEmptyString(latestRun.errorCode) === CHECKOUT_ADOPTED_RUN_ERROR_CODE
  );
}

// BLO-19954: `routine_execution_duplicate_suppressed` is the dispatch layer's
// own single-owner lock refusing a non-owner run of a routine configured
// `concurrencyPolicy=always_enqueue` — the run's cancellation message says so
// verbatim ("the owner run will continue the work"). It is benign, intentional
// control flow, not a stranded assignment: nothing failed, there is no
// runtime/adapter defect to repair, and no owner action can make this run
// succeed (the lock is held by another issue's run by design). Escalating it
// created a wake amplifier — one recovery action and one `wake_owner` per
// routine fire, forever, on a routine that was never broken. See
// `cancelClaimedRunForRoutineExecutionDuplicate` (heartbeat.ts) for where the
// run itself is cancelled with this code.
const ROUTINE_EXECUTION_DUPLICATE_SUPPRESSED_ERROR_CODE = "routine_execution_duplicate_suppressed";
const ISSUE_TERMINAL_STATUS_ERROR_CODE = "issue_terminal_status";

function isRoutineExecutionDuplicateSuppressedRun(
  latestRun: LatestIssueRun,
): latestRun is NonNullable<LatestIssueRun> {
  return (
    latestRun?.status === "cancelled" &&
    readNonEmptyString(latestRun.errorCode) === ROUTINE_EXECUTION_DUPLICATE_SUPPRESSED_ERROR_CODE
  );
}

function isTerminalDispatchRaceRun(
  latestRun: LatestIssueRun,
): latestRun is NonNullable<LatestIssueRun> {
  return (
    latestRun?.status === "cancelled" &&
    readNonEmptyString(latestRun.errorCode) === ISSUE_TERMINAL_STATUS_ERROR_CODE
  );
}

// BLO-19160: the outcome of observing a checkout-handover marker when the
// adopter can no longer prove continuity. `markerRunId` is the handover run —
// the newest run genuinely scoped to this issue, so the honest retry parent.
// `lockOwnerState` is the CAS precondition for every mutation the observation
// leads to.
type AdoptionHandoverNeutralRecovery = {
  markerRunId: string;
  lockOwnerState: IssueLockOwnerState;
};

function buildNonRetryableEscalationComment(input: {
  status: "todo" | "in_progress";
  latestRun: LatestIssueRun;
}) {
  const errorCode = readNonEmptyString(input.latestRun?.errorCode) ?? "non_retryable_failure";
  const verb = input.status === "todo" ? "dispatch" : "continuation";
  return (
    `Paperclip skipped automatic ${verb} recovery for this assigned \`${input.status}\` issue because the last run ` +
    `failed with a non-retryable code \`${errorCode}\`. ` +
    "Retrying would re-hit the same environment precondition. " +
    "Moving it to `blocked` so the recovery owner can clear the precondition before resuming."
  );
}

function buildExecutionReviewParticipantRecoveryComment(latestRun: LatestIssueRun) {
  const failureSummary = summarizeRunFailureForIssueComment(latestRun);
  return (
    "Paperclip retried the pending execution-review participant once, but the review stage still has no completed decision " +
    `or live reviewer run.${failureSummary ?? ""} ` +
    "Moving it to `blocked` with a source-scoped recovery action so the recovery owner can repair the reviewer runtime, " +
    "restore the review stage, or record an intentional manual resolution."
  );
}

function buildExecutionReviewParticipantUnavailableComment(latestRun: LatestIssueRun) {
  const failureSummary = summarizeRunFailureForIssueComment(latestRun);
  return (
    "Paperclip cannot continue the pending execution-review participant because the participant is not invokable " +
    `and the review stage has no completed decision or live reviewer run.${failureSummary ?? ""} ` +
    "Moving it to `blocked` with a source-scoped recovery action so the recovery owner can repair the reviewer runtime, " +
    "restore the review stage, or record an intentional manual resolution."
  );
}

function didAutomaticRecoveryFail(
  latestRun: LatestIssueRun,
  expectedRetryReason: "assignment_recovery" | "issue_continuation_needed" | typeof EXECUTION_REVIEW_PARTICIPANT_RECOVERY_REASON,
) {
  if (!latestRun) return false;

  const latestContext = parseObject(latestRun.contextSnapshot);
  const latestRetryReason = readNonEmptyString(latestContext.retryReason);
  return latestRetryReason === expectedRetryReason &&
    UNSUCCESSFUL_HEARTBEAT_RUN_TERMINAL_STATUSES.includes(
      latestRun.status as (typeof UNSUCCESSFUL_HEARTBEAT_RUN_TERMINAL_STATUSES)[number],
    );
}

const QUOTA_EXHAUSTED_RUN_ERROR_CODES = new Set<string>([
  "provider_quota_exhausted",
]);

function isQuotaExhaustedTerminalRun(latestRun: LatestIssueRun) {
  if (!latestRun) return false;
  if (
    !UNSUCCESSFUL_HEARTBEAT_RUN_TERMINAL_STATUSES.includes(
      latestRun.status as (typeof UNSUCCESSFUL_HEARTBEAT_RUN_TERMINAL_STATUSES)[number],
    )
  ) {
    return false;
  }
  const errorCode = readNonEmptyString(latestRun.errorCode);
  return Boolean(errorCode && QUOTA_EXHAUSTED_RUN_ERROR_CODES.has(errorCode));
}

function isTerminalIssueRun(latestRun: LatestIssueRun) {
  if (!latestRun) return false;
  return TERMINAL_HEARTBEAT_RUN_STATUSES.has(latestRun.status);
}

const TRANSIENT_INFRA_CONTINUATION_ERROR_CODES = new Set<string>([
  "adapter_failed",
  "codex_transient_upstream",
  "claude_transient_upstream",
  // BLO-18285: the server-side classification of a hint-less provider 503/529
  // on the k8s adapters. The bounded retry in heartbeat should normally park
  // such a run in `scheduled_retry` before this sweep ever sees it; listing the
  // code here keeps the continuation path consistent if it does.
  "provider_transient_upstream",
  "provider_quota",
  "timeout",
  // BLO-16182: `process_lost` means the run died before ANY adapter/model call
  // (server/pod restart in the setup window) — no work product, idempotent to
  // re-dispatch. Treat it as transient infra (3 bounded attempts + backoff)
  // instead of the `default` single-attempt/instant-escalate path, so a lone
  // control-plane blip no longer strands the issue as `blocked`.
  "process_lost",
]);

// BLO-19124: emitted by the dispatcher's dependency gate (see heartbeat.ts
// `cancelQueuedRunForBlockedDependencies`) when `listDependencyReadiness` reports
// the issue is not dependency-ready. A member of NON_RETRYABLE_CONTINUATION_ERROR_CODES
// so it does not burn retry attempts — but unlike the other members it is not an
// error condition at all, so it must not escalate as a stranded issue.
const DEPENDENCY_BLOCKED_ERROR_CODE = "issue_dependencies_blocked";
// Longer than heartbeat.ts reconcileResolvedBlockerDependents()'s default
// minBlockerResolvedAgeMs. A blocker that just became dependency-ready may still
// be waiting for the normal edge-triggered or first sweep dependency-resolved
// wake to land.
const DEPENDENCY_RESOLVED_WAKE_GRACE_MS = 6 * 60 * 1000;
// A dependency-resolved wake only proves an observable execution path while it
// is still being delivered. A completed row is historical idempotency evidence,
// not evidence that its dependent made progress.
const LIVE_ISSUE_BLOCKERS_RESOLVED_WAKE_STATUSES = new Set([
  "queued",
  "deferred_issue_execution",
  "claimed",
]);

const NON_RETRYABLE_CONTINUATION_ERROR_CODES = new Set<string>([
  "agent_not_invokable",
  "agent_not_found",
  "budget_blocked",
  "budget_exhausted",
  "issue_paused",
  DEPENDENCY_BLOCKED_ERROR_CODE,
  // Production emits job_missing only after adapter.invoke, so continuation
  // replay could duplicate a durable external side effect.
  "job_missing",
  // Adapters also use this after main-container startup failures, so scheduling
  // failure alone does not prove that external work never began.
  "k8s_pod_schedule_failed",
]);

// A continuation cancelled with this code is a *deliberate wait* (the latest run
// reported it was parked for review/approval), not a lost execution path. When the
// issue has a real waiting target we convert it into a normal dependency wait rather
// than escalating it as stranded.
const CONTINUATION_WAITING_ON_REVIEW_ERROR_CODE = "issue_continuation_waiting_on_review";
const INTERACTION_CONTINUATION_REQUEUE_MAX_ATTEMPTS = 3;

// BLO-16182: `process_lost` has two automatic retry engines — the continuation
// sweep (which dispatches runs with retryReason `issue_continuation_needed`) and
// the in-reaper `enqueueProcessLossRetry` (retryReason `process_lost`). To keep a
// single bounded attempt budget once `process_lost` is a retryable transient code,
// the sweep's consecutive-attempt counter must count BOTH reasons for a
// `process_lost` budget — otherwise the sweep would grant a fresh 3 attempts on top
// of the reaper's retry. Scoped to the `process_lost` budget so an in-reaper retry
// run that later fails with a *different* code cannot shorten that other code's
// separate budget.
const CONTINUATION_ATTEMPT_RETRY_REASON = "issue_continuation_needed";
const IN_REAPER_PROCESS_LOSS_RETRY_REASON = "process_lost";
const PROCESS_LOST_ERROR_CODE = "process_lost";

export function isContinuationAttemptRetryReason(
  retryReason: string | null,
  errorCodeToMatch: string | null,
): boolean {
  if (retryReason === CONTINUATION_ATTEMPT_RETRY_REASON) return true;
  if (
    retryReason === IN_REAPER_PROCESS_LOSS_RETRY_REASON &&
    errorCodeToMatch === PROCESS_LOST_ERROR_CODE
  ) {
    return true;
  }
  return false;
}

// BLO-16182: the continuation cap+backoff block must ENTER whenever the latest
// terminal run is an automatic retry attempt for this budget — symmetric with the
// broadened streak counter above. For non-`process_lost` codes this is identical to
// the old `didAutomaticRecoveryFail(latestRun, "issue_continuation_needed")` gate;
// for `process_lost` it ALSO admits an in-reaper (engine B) retry whose retryReason
// is `process_lost` and which is the most recent run — otherwise that interleaving
// skips the cap and re-dispatches uncapped + backoff-free (the exact window this
// change bounds).
function isAutomaticContinuationRecoveryRun(
  latestRun: LatestIssueRun,
  errorCodeToMatch: string | null,
): boolean {
  if (!latestRun) return false;
  const latestRetryReason = readNonEmptyString(parseObject(latestRun.contextSnapshot).retryReason);
  return (
    isContinuationAttemptRetryReason(latestRetryReason, errorCodeToMatch) &&
    UNSUCCESSFUL_HEARTBEAT_RUN_TERMINAL_STATUSES.includes(
      latestRun.status as (typeof UNSUCCESSFUL_HEARTBEAT_RUN_TERMINAL_STATUSES)[number],
    )
  );
}

// Recovery handoffs for workspace-preflight failures used to route the operator to
// a generic "restore a live execution path" instruction, which names neither the
// failing check nor a first probe. Give the actual cause instead. (BLO-18784)
const WORKSPACE_PREFLIGHT_RECOVERY_GUIDANCE: Record<string, string> = {
  workspace_git_submodule_unavailable:
    "the git submodule preflight (`git submodule status --recursive`) could not leave the execution " +
    "workspace's submodules in a usable state. A merely slow inspection no longer strands an issue, " +
    "so this handoff means one of three things: a submodule fault was actually detected (conflicted " +
    "gitlinks, or still uninitialized after the automatic repair); the repair commands themselves " +
    "failed -- which can be transient, e.g. a network/auth failure fetching a submodule; or the " +
    "inspection itself failed deterministically (malformed `.gitmodules`, corrupt checkout, " +
    "permission error, missing git binary). Check the run's failure output to tell them apart: if the " +
    "repair failed transiently, re-running may be sufficient; if a gitlink is genuinely conflicted or " +
    "`.gitmodules` will not parse, fix the shared checkout first.",
  workspace_repo_mismatch:
    "the execution workspace is checked out from a different repository than the issue expects. " +
    "Repoint or re-provision the workspace, then re-run.",
};

function describeWorkspacePreflightRecoveryCause(latestRun: LatestIssueRun): string | null {
  const errorCode = readNonEmptyString(latestRun?.errorCode);
  if (!errorCode) return null;
  return WORKSPACE_PREFLIGHT_RECOVERY_GUIDANCE[errorCode] ?? null;
}

const CONTINUATION_RECOVERY_TRANSIENT_MAX_ATTEMPTS = 3;
const CONTINUATION_RECOVERY_DEFAULT_MAX_ATTEMPTS = 1;
const CONTINUATION_RECOVERY_TRANSIENT_BASE_BACKOFF_MS = 60_000;
export const PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS = 60 * 60 * 1000;

const PROVIDER_QUOTA_ERROR_RE =
  /(?:you(?:'|’)ve hit your usage limit|usage limit(?: reached| exceeded)?|provider quota|quota (?:limit )?exceeded|model (?:is )?at capacity)/i;
const CONFIGURATION_INCOMPLETE_ERROR_RE =
  /(?:model_not_found|model [^\n]{0,120} not found|missing (?:api )?(?:key|credentials?)|credentials? (?:are |is )?missing|no (?:api )?(?:key|credentials?) (?:was |were )?(?:found|configured|provided)|api key (?:is )?(?:not set|unavailable))/i;
// BLO-21116: a truncated/malformed adapter response is a transport-level parse
// fault, not evidence about credentials. Before this guard, the config-incomplete
// regex ran against `errorCode + error + JSON.stringify(resultJson)` — the FULL
// raw (possibly truncated) response payload — so an unparseable blob could
// false-positive match one of the config phrases via unrelated substring content
// (e.g. a partial JSON fragment that happens to contain "model ... not found").
// A match here permanently latches the issue into `manual_repair_required`
// (service.ts enqueueSourceScopedStrandedRecoveryWake) telling the owner to bind
// a secret that was never actually missing — an unperformable repair with no
// automatic retry path. Observed live on BLO-18991: `adapter_failed` — "JSON
// parsing failed: Text: {"type":"response.completed","response":{..." (truncated).
const ADAPTER_RESPONSE_PARSE_FAILURE_RE = /json parsing failed/i;

export type AdapterFailureRecoveryClassification =
  | { kind: "provider_quota"; retryAt: Date; parsedResetTime: boolean }
  | { kind: "configuration_incomplete" }
  | null;

function parseProviderQuotaClockReset(error: string, now: Date) {
  const match = error.match(
    /try again at\s+(\d{1,2})(?::(\d{2}))?\s*(?:([ap])\.?\s*m\.?)?(?:\s*\(([^)]+)\)|\s+([A-Z]{2,5}))?/i,
  );
  if (!match) return null;

  const hourValue = Number.parseInt(match[1] ?? "", 10);
  const minute = Number.parseInt(match[2] ?? "0", 10);
  const meridiem = (match[3] ?? "").toLowerCase();
  if (!Number.isInteger(hourValue)) return null;
  if (meridiem ? hourValue < 1 || hourValue > 12 : hourValue < 0 || hourValue > 23) return null;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;

  let hour = meridiem ? hourValue % 12 : hourValue;
  if (meridiem === "p") hour += 12;
  const timeZone = (match[4] ?? match[5])?.trim();
  if (!timeZone) {
    const retryAt = new Date(now);
    retryAt.setUTCHours(hour, minute, 0, 0);
    if (retryAt.getTime() <= now.getTime()) retryAt.setUTCDate(retryAt.getUTCDate() + 1);
    return retryAt;
  }

  try {
    const wallClock = (date: Date) => Object.fromEntries(
      new Intl.DateTimeFormat("en-US", {
        timeZone,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      }).formatToParts(date).map((part) => [part.type, part.value]),
    );
    const nowParts = wallClock(now);
    const buildRetryAt = (dayOffset: number) => {
      const targetDay = new Date(Date.UTC(
        Number(nowParts.year),
        Number(nowParts.month) - 1,
        Number(nowParts.day) + dayOffset,
        hour,
        minute,
      ));
      let candidate = targetDay;
      const targetMs = targetDay.getTime();
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const actual = wallClock(candidate);
        const actualMs = Date.UTC(
          Number(actual.year),
          Number(actual.month) - 1,
          Number(actual.day),
          Number(actual.hour),
          Number(actual.minute),
        );
        const adjustment = targetMs - actualMs;
        if (adjustment === 0) break;
        candidate = new Date(candidate.getTime() + adjustment);
      }
      return candidate;
    };
    const sameDay = buildRetryAt(0);
    return sameDay.getTime() > now.getTime() ? sameDay : buildRetryAt(1);
  } catch {
    return null;
  }
}

export function classifyAdapterFailureForRecovery(
  latestRun: Pick<NonNullable<LatestIssueRun>, "error" | "errorCode" | "resultJson">,
  now = new Date(),
): AdapterFailureRecoveryClassification {
  if (
    latestRun.errorCode !== "adapter_failed" &&
    latestRun.errorCode !== "provider_quota" &&
    latestRun.errorCode !== "configuration_incomplete"
  ) {
    return null;
  }
  const resultJson = parseObject(latestRun.resultJson);
  const rawError = latestRun.error ?? "";
  // An `adapter_failed` whose own message names a response-parse failure means
  // resultJson is an untrusted/truncated payload, not classification evidence.
  // Keep the guard scoped to that durable error code: provider_quota and
  // configuration_incomplete are authoritative classifications and must not be
  // discarded merely because their human-readable message contains the same
  // phrase.
  const isResponseParseFailure =
    latestRun.errorCode === "adapter_failed" && ADAPTER_RESPONSE_PARSE_FAILURE_RE.test(rawError);
  const error = [latestRun.errorCode ?? "", rawError, isResponseParseFailure ? "" : JSON.stringify(resultJson)]
    .join("\n");
  if (
    !isResponseParseFailure &&
    (latestRun.errorCode === "configuration_incomplete" || CONFIGURATION_INCOMPLETE_ERROR_RE.test(error))
  ) {
    return { kind: "configuration_incomplete" };
  }
  // The raw parse-failure text can itself contain quota-like words, so do not
  // let an adapter_failed transport fault enter the provider-quota path.
  if (isResponseParseFailure) return null;
  if (latestRun.errorCode !== "provider_quota" && !PROVIDER_QUOTA_ERROR_RE.test(error)) return null;

  const persistedRetryAt = readNonEmptyString(resultJson.retryNotBefore) ??
    readNonEmptyString(resultJson.transientRetryNotBefore) ??
    readNonEmptyString(resultJson.providerQuotaRetryNotBefore);
  const parsedPersistedRetryAt = persistedRetryAt ? new Date(persistedRetryAt) : null;
  if (parsedPersistedRetryAt && !Number.isNaN(parsedPersistedRetryAt.getTime()) && parsedPersistedRetryAt > now) {
    return { kind: "provider_quota", retryAt: parsedPersistedRetryAt, parsedResetTime: true };
  }

  const parsedClockReset = parseProviderQuotaClockReset(error, now);
  if (parsedClockReset) {
    return { kind: "provider_quota", retryAt: parsedClockReset, parsedResetTime: true };
  }
  return {
    kind: "provider_quota",
    retryAt: new Date(now.getTime() + PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS),
    parsedResetTime: false,
  };
}

export function isBlockingRelationCycleError(error: unknown) {
  return error instanceof Error && error.message.includes("Blocking relations cannot contain cycles");
}

type ContinuationRetryClassification = {
  kind: "transient_infra" | "non_retryable" | "default";
  maxAttempts: number;
  baseBackoffMs: number;
  errorCode: string | null;
};

export function classifyContinuationFailure(latestRun: LatestIssueRun): ContinuationRetryClassification {
  const errorCode = readNonEmptyString(latestRun?.errorCode);
  if (errorCode && NON_RETRYABLE_CONTINUATION_ERROR_CODES.has(errorCode)) {
    return { kind: "non_retryable", maxAttempts: 0, baseBackoffMs: 0, errorCode };
  }
  if (errorCode && TRANSIENT_INFRA_CONTINUATION_ERROR_CODES.has(errorCode)) {
    return {
      kind: "transient_infra",
      maxAttempts: CONTINUATION_RECOVERY_TRANSIENT_MAX_ATTEMPTS,
      baseBackoffMs: CONTINUATION_RECOVERY_TRANSIENT_BASE_BACKOFF_MS,
      errorCode,
    };
  }
  return {
    kind: "default",
    maxAttempts: CONTINUATION_RECOVERY_DEFAULT_MAX_ATTEMPTS,
    baseBackoffMs: 0,
    errorCode,
  };
}

function successfulRunHandoffRecoveryEvidence(latestRun: LatestIssueRun): SuccessfulRunHandoffRecoveryEvidence | null {
  if (!latestRun) return null;

  const context = parseObject(latestRun.contextSnapshot);
  const wakeReason = readNonEmptyString(context.wakeReason);
  const handoffReason = readNonEmptyString(context.handoffReason);
  const isSuccessfulRunHandoff =
    wakeReason === FINISH_SUCCESSFUL_RUN_HANDOFF_REASON ||
    handoffReason === SUCCESSFUL_RUN_MISSING_STATE_REASON ||
    asBoolean(context.handoffRequired, false) === true;
  if (!isSuccessfulRunHandoff) return null;

  const handoffAttempt = asNumber(context.handoffAttempt, 1);
  const maxHandoffAttempts = asNumber(
    context.maxHandoffAttempts,
    DEFAULT_MAX_SUCCESSFUL_RUN_HANDOFF_ATTEMPTS,
  );
  return {
    sourceRunId: readNonEmptyString(context.sourceRunId) ?? readNonEmptyString(context.resumeFromRunId),
    correctiveRunId: latestRun.id,
    missingDisposition: readNonEmptyString(context.missingDisposition) ?? "clear_next_step",
    handoffAttempt,
    maxHandoffAttempts,
  };
}

function isExhaustedSuccessfulRunHandoff(latestRun: LatestIssueRun) {
  const evidence = successfulRunHandoffRecoveryEvidence(latestRun);
  if (!evidence) return null;
  if (evidence.handoffAttempt < evidence.maxHandoffAttempts) return { ...evidence, exhausted: false };
  return { ...evidence, exhausted: true };
}

function issueIdFromRunContext(contextSnapshot: unknown) {
  const context = parseObject(contextSnapshot);
  return readNonEmptyString(context.issueId) ?? readNonEmptyString(context.taskId);
}

function issueIdFromWakePayload(payload: unknown) {
  const parsed = parseObject(payload);
  const nestedContext = parseObject(parsed[DEFERRED_WAKE_CONTEXT_KEY]);
  return readNonEmptyString(parsed.issueId) ??
    readNonEmptyString(nestedContext.issueId) ??
    readNonEmptyString(nestedContext.taskId);
}

function issueUiLink(issue: { identifier: string | null; id: string }, prefix: string) {
  const label = issue.identifier ?? issue.id;
  return `[${label}](/${prefix}/issues/${label})`;
}

function runUiLink(run: { id: string; agentId: string }, prefix: string) {
  return `[${run.id}](/${prefix}/agents/${run.agentId}/runs/${run.id})`;
}

function agentUiLink(agent: { id: string; name: string | null } | null, prefix: string) {
  if (!agent) return "unknown";
  return `[${agent.name ?? agent.id}](/${prefix}/agents/${agent.id})`;
}

function formatDuration(ms: number | null) {
  if (ms === null) return "unknown";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

function formatIssueLinksForComment(relations: Array<{ identifier?: string | null }>) {
  const identifiers = [
    ...new Set(
      relations
        .map((relation) => relation.identifier)
        .filter((identifier): identifier is string => Boolean(identifier)),
    ),
  ];
  if (identifiers.length === 0) return "another open issue";
  return identifiers
    .slice(0, 5)
    .map((identifier) => {
      const prefix = identifier.split("-")[0] || "PAP";
      return `[${identifier}](/${prefix}/issues/${identifier})`;
    })
    .join(", ");
}

function unwrapDatabaseConflictError(error: unknown) {
  if (!error || typeof error !== "object") return null;

  const candidate = error as {
    code?: string;
    constraint?: string;
    constraint_name?: string;
    message?: string;
    cause?: unknown;
  };

  if (
    typeof candidate.code === "string" ||
    typeof candidate.constraint === "string" ||
    typeof candidate.constraint_name === "string"
  ) {
    return candidate;
  }

  const cause = candidate.cause;
  if (!cause || typeof cause !== "object") return candidate;

  return cause as {
    code?: string;
    constraint?: string;
    constraint_name?: string;
    message?: string;
  };
}

function isStrandedIssueRecoveryIssue(issue: Pick<typeof issues.$inferSelect, "originKind">) {
  return isStrandedIssueRecoveryOriginKind(issue.originKind);
}

function isUnsuccessfulTerminalIssueRun(latestRun: LatestIssueRun) {
  return Boolean(
    latestRun &&
      UNSUCCESSFUL_HEARTBEAT_RUN_TERMINAL_STATUSES.includes(
        latestRun.status as (typeof UNSUCCESSFUL_HEARTBEAT_RUN_TERMINAL_STATUSES)[number],
      ),
  );
}

function isSuccessfulInProgressContinuationRun(latestRun: LatestIssueRun): latestRun is SuccessfulLatestIssueRun {
  return latestRun?.status === "succeeded";
}

function isProductiveContinuationRun(latestRun: LatestIssueRun) {
  if (latestRun?.status !== "succeeded") return false;
  const livenessLooksProductive =
    latestRun.livenessState === "advanced" ||
    latestRun.livenessState === "completed" ||
    latestRun.livenessState === "blocked" ||
    latestRun.livenessState === "needs_followup";
  if (!livenessLooksProductive) return false;
  // 2026-05-06 BLO-3182 RCA: liveness can be fooled by trivial activity
  // (one inbox-fetch tool call gets classified as "advanced") even when
  // the agent's own result summary admits no work was done. Treat
  // explicit no-op summaries as non-productive regardless of liveness.
  return !runResultLooksLikeNoChangeExit(latestRun.resultJson);
}

const NO_CHANGE_EXIT_SUMMARY_PATTERNS = [
  /^\s*no\s+change\b/i,
  /^\s*same\s+sweep\s+wake\b/i,
  /^\s*exiting\.?\s*$/i,
  /^\s*nothing\s+to\s+do\b/i,
  /^\s*no\s+new\s+context\b/i,
  /^\s*no\s+actionable\b/i,
  /\bno\s+response\s+requested\b/i,
];

function runResultLooksLikeNoChangeExit(resultJson: unknown) {
  if (!resultJson || typeof resultJson !== "object") return false;
  const raw = resultJson as Record<string, unknown>;
  const summaryFields = [raw.summary, raw.result, raw.message];
  for (const value of summaryFields) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed.length === 0) continue;
    if (NO_CHANGE_EXIT_SUMMARY_PATTERNS.some((pattern) => pattern.test(trimmed))) return true;
  }
  return false;
}

// After this many consecutive succeeded-but-non-productive runs on the same
// in_progress issue, escalate to `blocked` instead of waking the agent
// again. The pattern looks like the BLO-3182 cycle: agent runs, exits
// succeeded with livenessState ∈ {plan_only, empty_response, null}, the
// harness posts "No response requested.", the issue stays in_progress,
// next sweep wakes the same agent, repeat. Each iteration burns provider
// quota for zero forward progress. UXDesigner explicitly called out this
// pattern in BLO-3182's 05:10Z comment.
//
// 5 chosen so:
//   - genuine multi-step continuations (an agent that needs 2-3 wakeups to
//     finish a plan-then-execute cycle) aren't escalated prematurely; their
//     intermediate runs typically interleave with at least one productive
//     liveness transition (advanced/needs_followup)
//   - a clear no-op loop is caught well within an hour at the typical
//     5-min heartbeat cadence (~25 min wall clock)
const NON_PRODUCTIVE_RUN_NOOP_THRESHOLD = 5;

function isRepeatedProductiveContinuationRecovery(latestRun: SuccessfulLatestIssueRun) {
  const latestContext = parseObject(latestRun.contextSnapshot);
  return readNonEmptyString(latestContext.retryReason) === "issue_continuation_needed" &&
    readNonEmptyString(latestContext.source) === "issue.productive_terminal_continuation_recovery" &&
    isProductiveContinuationRun(latestRun);
}

function isAutomaticContinuationRun(latestRun: SuccessfulLatestIssueRun) {
  const latestContext = parseObject(latestRun.contextSnapshot);
  return readNonEmptyString(latestContext.retryReason) === "issue_continuation_needed";
}

function parseLivenessIncidentKey(incidentKey: string | null | undefined) {
  if (!incidentKey) return null;
  return parseIssueGraphLivenessIncidentKey(incidentKey);
}

function livenessRecoveryLeafIssueId(finding: IssueLivenessFinding) {
  return finding.recoveryIssueId;
}

function livenessRecoveryLeafFingerprint(finding: IssueLivenessFinding) {
  return buildIssueGraphLivenessLeafKey({
    companyId: finding.companyId,
    state: finding.state,
    leafIssueId: livenessRecoveryLeafIssueId(finding),
  });
}

function livenessRecoveryLeafKey(companyId: string, state: string, leafIssueId: string) {
  return buildIssueGraphLivenessLeafKey({ companyId, state, leafIssueId });
}

function isUniqueLivenessRecoveryConflict(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const maybe = error as { code?: string; constraint?: string; message?: string };
  return maybe.code === "23505" &&
    (
      maybe.constraint === "issues_active_liveness_recovery_incident_uq" ||
      maybe.constraint === "issues_active_liveness_recovery_leaf_uq" ||
      typeof maybe.message === "string" &&
        (
          maybe.message.includes("issues_active_liveness_recovery_incident_uq") ||
          maybe.message.includes("issues_active_liveness_recovery_leaf_uq")
        )
    );
}

function formatDependencyPath(finding: IssueLivenessFinding) {
  return finding.dependencyPath
    .map((entry) => entry.identifier ?? entry.issueId)
    .join(" -> ");
}

function buildLivenessEscalationDescription(finding: IssueLivenessFinding) {
  const source = finding.dependencyPath[0];
  const recovery = finding.dependencyPath.find((entry) => entry.issueId === finding.recoveryIssueId);
  const selectedOwner = finding.recommendedOwnerAgentId ?? "none";

  return [
    "Paperclip detected a harness-level issue graph liveness incident.",
    "",
    "## Source",
    "",
    `- Source issue: ${source?.identifier ?? source?.issueId ?? finding.issueId}`,
    `- Recovery target issue: ${recovery?.identifier ?? recovery?.issueId ?? finding.recoveryIssueId}`,
    `- Incident key: \`${finding.incidentKey}\``,
    `- Detected invariant: \`${finding.state}\``,
    `- Dependency path: ${formatDependencyPath(finding)}`,
    `- Reason: ${finding.reason}`,
    "",
    "## Ownership",
    "",
    `- Selected owner agent: \`${selectedOwner}\``,
    `- Candidate owner agents: ${finding.recommendedOwnerCandidateAgentIds.length > 0 ? finding.recommendedOwnerCandidateAgentIds.map((id) => `\`${id}\``).join(", ") : "none"}`,
    "",
    "## Next Action",
    "",
    finding.recommendedAction,
    "",
    "Resolve the blocked chain, then mark this escalation issue done so the original issue can resume when all blockers are cleared.",
    "",
    // BLO-24744: this issue is worked by a cheap status-only run, and the repair it asks for is
    // sometimes not one an agent can perform (a `pauseReason: manual` pause is a human's decision).
    // Without naming the one channel that class of run may use, the honest options left were all
    // bad: file nothing, poll a human decision, or close unresolved. Name it here — the reader is
    // the run, and this text is the only instruction it gets.
    "## If only a human can resolve this",
    "",
    "Do not poll it, and do not close this unresolved. File a board escalation from this run: " +
    "`POST /api/companies/:companyId/approvals` with `type: \"request_board_approval\"` and " +
    "`issueIds: [\"<this escalation issue id>\"]` — that is the one approval a status-only recovery " +
    "run may create, and linking it to this issue is required. Paperclip supplies the idempotency " +
    "key, so every escalation raised for this same root cause replays the one existing card " +
    "(response `deduplicated: true`) instead of adding another. Record the approval id here, then " +
    "leave this issue blocked on that decision.",
  ].join("\n");
}

function buildLivenessOriginalIssueComment(finding: IssueLivenessFinding, escalation: typeof issues.$inferSelect) {
  return [
    "Paperclip detected a harness-level liveness incident in this issue's dependency graph.",
    "",
    `- Escalation issue: ${escalation.identifier ?? escalation.id}`,
    `- Incident key: \`${finding.incidentKey}\``,
    `- Finding: \`${finding.state}\``,
    `- Dependency path: ${formatDependencyPath(finding)}`,
    `- Reason: ${finding.reason}`,
    `- Manager action requested: ${finding.recommendedAction}`,
    "",
    "This issue's own blockers and status are left untouched: the escalation is tracked separately rather than added as a blocker here, so a fabricated dependency cannot wedge this issue once its real gate clears (BLO-28618).",
  ].join("\n");
}

export function recoveryService(
  db: Db,
  deps: {
    enqueueWakeup: RecoveryWakeup;
    beforeStaleIssueLockSweepClearForTest?: (
      issue: {
        id: string;
        checkoutRunId: string | null;
        executionRunId: string | null;
        executionLockedAt: Date | null;
      },
    ) => Promise<void> | void;
    /**
     * Test-only seam for the review-wait blocker relation write. Production
     * leaves this unset; tests use it to inject the same cycle error that the
     * issue service can raise after a concurrent relation update, without
     * intercepting the recovery transaction itself.
     */
    beforeContinuationReviewBlockerUpdateForTest?: (input: {
      issueId: string;
      blockedByIssueIds: string[];
    }) => Promise<void> | void;
  },
) {
  const issuesSvc = issueService(db);
  const recoveryActionsSvc = issueRecoveryActionService(db);
  const treeControlSvc = issueTreeControlService(db);
  const budgets = budgetService(db);
  const instanceSettings = instanceSettingsService(db);
  const runLogStore = getRunLogStore();
  let resolvedDependencyWakeBackstopCandidateCursor: string | null = null;
  let strandedRecoveryWakeBackstopCandidateCursor: string | null = null;
  let resolvedDependencyWakeBackstopTail = Promise.resolve();
  let strandedRecoveryWakeBackstopTail = Promise.resolve();
  let strandedRecoveryHandBackTail = Promise.resolve();

  const getCurrentUserRedactionOptions = async () => ({
    enabled: (await instanceSettings.getGeneral()).censorUsernameInLogs,
  });

  async function getAgent(agentId: string) {
    return db.select().from(agents).where(eq(agents.id, agentId)).then((rows) => rows[0] ?? null);
  }

  async function isAgentInvokable(agent: typeof agents.$inferSelect | null | undefined) {
    return (await evaluateAgentInvokabilityFromDb(db, agent)).invokable;
  }

  // Column set behind `LatestIssueRun`. Shared by every helper that produces
  // run evidence for the recovery classifiers so the shapes cannot drift apart.
  const LATEST_ISSUE_RUN_COLUMNS = {
    id: heartbeatRuns.id,
    agentId: heartbeatRuns.agentId,
    status: heartbeatRuns.status,
    error: heartbeatRuns.error,
    errorCode: heartbeatRuns.errorCode,
    contextSnapshot: heartbeatRuns.contextSnapshot,
    livenessState: heartbeatRuns.livenessState,
    resultJson: heartbeatRuns.resultJson,
    usageJson: heartbeatRuns.usageJson,
    sessionIdBefore: heartbeatRuns.sessionIdBefore,
    scheduledRetryAttempt: heartbeatRuns.scheduledRetryAttempt,
    createdAt: heartbeatRuns.createdAt,
    finishedAt: heartbeatRuns.finishedAt,
  } as const;

  async function getLatestIssueRun(companyId: string, issueId: string): Promise<LatestIssueRun> {
    return db
      .select(LATEST_ISSUE_RUN_COLUMNS)
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`,
        ),
      )
      .orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  // BLO-18860: the run that took over `adoptedRun`'s checkout — i.e. the run the
  // issue's execution lock now points at. `getLatestIssueRun` cannot find it:
  // that query matches on `contextSnapshot ->> 'issueId'`, and the hazardous
  // adoption is precisely an agent touching a *stale other* issue from a run
  // scoped to a different issue, so the adopting run carries someone else's
  // issueId (or none). Returns null when the lock no longer names a different
  // run, in which case there is no successor evidence to judge the issue on.
  async function getCheckoutAdoptingRun(
    issue: Pick<typeof issues.$inferSelect, "companyId" | "executionRunId" | "checkoutRunId">,
    adoptedRun: NonNullable<LatestIssueRun>,
  ): Promise<LatestIssueRun> {
    const adoptingRunId = issue.executionRunId ?? issue.checkoutRunId;
    if (!adoptingRunId || adoptingRunId === adoptedRun.id) return null;
    return db
      .select(LATEST_ISSUE_RUN_COLUMNS)
      .from(heartbeatRuns)
      .where(
        and(eq(heartbeatRuns.companyId, issue.companyId), eq(heartbeatRuns.id, adoptingRunId)),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  // BLO-19160: the execution lock + owner as of a specific instant. The
  // stranded-assigned sweep reads its candidates as one bulk snapshot and then
  // performs many awaits per candidate, so by the time a per-candidate branch
  // runs the snapshot's lock columns may be several seconds stale. Adoption
  // rewrites exactly these three fields, so a handover observed against a stale
  // snapshot resolves the *previous* terminal owner while a live adopter holds
  // the current lock — and recovery then escalates or reassigns the issue out
  // from under that live run. Re-read them at observation time, and CAS on them
  // before any mutation the observation led to.
  async function readIssueLockOwnerState(
    companyId: string,
    issueId: string,
  ): Promise<IssueLockOwnerState | null> {
    const [row] = await db
      .select({
        executionRunId: issues.executionRunId,
        checkoutRunId: issues.checkoutRunId,
        assigneeAgentId: issues.assigneeAgentId,
      })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.id, issueId)))
      .limit(1);
    return row ?? null;
  }

  // True when `expected` no longer describes the issue's committed lock/owner —
  // i.e. this sweep lost the race and must take no side effect. A vanished issue
  // counts as changed. `null`/`undefined` expectation means "no handover was
  // observed on this candidate", so nothing extra is enforced.
  async function issueLockOwnerStateChanged(
    issueId: string,
    expected: IssueLockOwnerState | null | undefined,
  ): Promise<boolean> {
    if (!expected) return false;
    const [fresh] = await db
      .select({
        executionRunId: issues.executionRunId,
        checkoutRunId: issues.checkoutRunId,
        assigneeAgentId: issues.assigneeAgentId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .limit(1);
    if (!fresh) return true;
    return !issueLockOwnerStateMatches(expected, fresh);
  }

  // Decide what a checkout-handover marker means for the issue it is scoped to.
  // Returns null when there is nothing to recover — either a live same-assignee
  // adopter holds the lock (continuity) or the issue vanished mid-sweep.
  // Otherwise returns the neutral-recovery descriptor: the marker run for
  // provenance, plus the lock/owner values to CAS every later mutation against.
  async function resolveCheckoutAdoptionHandover(
    issue: Pick<typeof issues.$inferSelect, "companyId" | "id">,
    handoverMarkerRun: NonNullable<LatestIssueRun>,
  ): Promise<AdoptionHandoverNeutralRecovery | null> {
    // BLO-19160 finding 2: resolve the adopter from the lock as it is NOW, not
    // as the candidate snapshot saw it before this loop began. Following stale
    // lock ids resolves the *previous* terminal owner while a live adopter holds
    // the current lock — a narrow-window re-entry into the exact BLO-18860
    // failure mode this whole path exists to prevent.
    const lockOwnerState = await readIssueLockOwnerState(issue.companyId, issue.id);
    if (!lockOwnerState) return null;

    const adoptingRun = await getCheckoutAdoptingRun(
      { companyId: issue.companyId, ...lockOwnerState },
      handoverMarkerRun,
    );
    // Compare against the assignee, not the sweep's `agentId`: adoption is only
    // ever performed by the assignee's own run (`adoptStaleCheckoutRun` requires
    // `assigneeAgentId = actor`), and on an `in_review` issue `agentId` is the
    // review participant instead.
    //
    // The adopter proves continuity only while it is LIVE. A terminal adopter
    // tells us nothing about this issue (see the caller), and so does the
    // successor-less case: `clearCheckoutRunIfTerminal` (services/issues.ts)
    // nulls BOTH lock columns once the adopter goes terminal, leaving no id to
    // resolve here — the ordinary cleanup sequence, not an anomaly.
    if (
      adoptingRun &&
      adoptingRun.agentId === lockOwnerState.assigneeAgentId &&
      !isTerminalIssueRun(adoptingRun)
    ) {
      return null;
    }
    return { markerRunId: handoverMarkerRun.id, lockOwnerState };
  }

  // Count the number of consecutive (most-recent-first) succeeded runs for
  // this issue whose livenessState is non-productive (plan_only,
  // empty_response, failed, or null). Stops counting at the first
  // productive run, the first non-succeeded run, or when the limit is hit.
  // Used by the no-op-loop detector to decide whether to escalate to
  // blocked instead of waking the agent again.
  //
  // 2026-05-25 BLO-7521: scope the lookback to runs created AFTER the
  // most recent `previousStatus=blocked` transition on this issue. A manual
  // operator unblock should give the agent a fresh window to make progress
  // before the no-op-loop detector re-blocks based on pre-unblock history.
  // Without the scope, the streak survives across reopens and re-blocks
  // within seconds of the operator flip — defeating the manual recovery
  // path entirely.
  async function getLatestUnblockedAt(
    companyId: string,
    issueId: string,
  ): Promise<Date | null> {
    const [row] = await db
      .select({ createdAt: activityLog.createdAt })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.companyId, companyId),
          eq(activityLog.entityType, "issue"),
          eq(activityLog.entityId, issueId),
          eq(activityLog.action, "issue.updated"),
          sql`${activityLog.details} ->> 'previousStatus' = 'blocked'`,
        ),
      )
      .orderBy(desc(activityLog.createdAt))
      .limit(1);
    return row?.createdAt ?? null;
  }

  // BLO-8050: shared gate for "operator just unblocked this issue, give the
  // agent a fresh sweep window before re-escalating based on pre-unblock
  // history." Returns true when the latest run predates (or coincides with)
  // the most recent operator unblock — meaning the failure evidence the
  // escalation branches would key off was already known when the operator
  // chose to unblock. Without this gate, `reconcileStrandedAssignedIssues`
  // re-flips the issue back to `blocked` on the next sweep using stale
  // latestRun state, defeating the manual recovery path. BLO-7521 added the
  // first instance of this gate for stranded-recovery-origin issues; BLO-8050
  // generalizes it to all six escalation callsites (todo and in_progress
  // arms × non-retryable / zero-token / recovery-failed predicates).
  async function latestRunPredatesLatestUnblock(
    companyId: string,
    issueId: string,
    latestRun: LatestIssueRun,
  ): Promise<boolean> {
    const unblockedAt = await getLatestUnblockedAt(companyId, issueId);
    const latestRunCreatedAt = latestRun?.createdAt ?? null;
    return Boolean(unblockedAt && latestRunCreatedAt && latestRunCreatedAt <= unblockedAt);
  }

  async function countConsecutiveNonProductiveSuccessfulRuns(
    companyId: string,
    issueId: string,
    limit: number,
  ): Promise<number> {
    const unblockedAt = await getLatestUnblockedAt(companyId, issueId);
    const recent = await db
      .select({
        status: heartbeatRuns.status,
        livenessState: heartbeatRuns.livenessState,
        resultJson: heartbeatRuns.resultJson,
      })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`,
          unblockedAt ? gt(heartbeatRuns.createdAt, unblockedAt) : undefined,
        ),
      )
      .orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id))
      .limit(Math.max(limit, 1));

    let count = 0;
    for (const run of recent) {
      if (run.status !== "succeeded") break;
      const livenessLooksProductive =
        run.livenessState === "advanced" ||
        run.livenessState === "completed" ||
        run.livenessState === "blocked" ||
        run.livenessState === "needs_followup";
      // 2026-05-06 BLO-3182 RCA: liveness was being marked `advanced` on
      // wake-and-exit runs because the agent fetched the inbox or read
      // a comment ("Run produced concrete action evidence: 1 activity
      // event(s)"). The actual result body said "No change. Exiting."
      // Override liveness as non-productive when the summary itself is
      // explicit about it -- a trivial API call ≠ progress.
      if (livenessLooksProductive && !runResultLooksLikeNoChangeExit(run.resultJson)) break;
      count += 1;
    }
    return count;
  }

  async function getLatestIssueRunForAgentStage(
    companyId: string,
    issueId: string,
    agentId: string,
    stageId: string,
  ): Promise<LatestIssueRun> {
    return db
      .select({
        id: heartbeatRuns.id,
        agentId: heartbeatRuns.agentId,
        status: heartbeatRuns.status,
        error: heartbeatRuns.error,
        errorCode: heartbeatRuns.errorCode,
        contextSnapshot: heartbeatRuns.contextSnapshot,
        livenessState: heartbeatRuns.livenessState,
        resultJson: heartbeatRuns.resultJson,
        usageJson: heartbeatRuns.usageJson,
        sessionIdBefore: heartbeatRuns.sessionIdBefore,
        scheduledRetryAttempt: heartbeatRuns.scheduledRetryAttempt,
        createdAt: heartbeatRuns.createdAt,
        finishedAt: heartbeatRuns.finishedAt,
      })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          eq(heartbeatRuns.agentId, agentId),
          sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`,
          sql`coalesce(
            ${heartbeatRuns.contextSnapshot} -> 'executionStage' ->> 'stageId',
            ${heartbeatRuns.contextSnapshot} ->> 'currentStageId'
          ) = ${stageId}`,
        ),
      )
      .orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function summarizeRecentContinuationRetries(
    companyId: string,
    issueId: string,
    agentId: string,
    errorCodeToMatch: string | null,
    since: Date | null = null,
  ) {
    const rows = await db
      .select({
        id: heartbeatRuns.id,
        status: heartbeatRuns.status,
        errorCode: heartbeatRuns.errorCode,
        contextSnapshot: heartbeatRuns.contextSnapshot,
        finishedAt: heartbeatRuns.finishedAt,
      })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          eq(heartbeatRuns.agentId, agentId),
          sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`,
          ...(since ? [or(gte(heartbeatRuns.createdAt, since), gte(heartbeatRuns.finishedAt, since))] : []),
        ),
      )
      .orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id))
      .limit(10);

    let consecutive = 0;
    let latestFinishedAt: Date | null = null;
    for (const row of rows) {
      const ctx = parseObject(row.contextSnapshot);
      const retryReason = readNonEmptyString(ctx.retryReason);
      // BLO-16182: count continuation-sweep AND in-reaper process_lost retries
      // toward one bounded budget (see isContinuationAttemptRetryReason). This
      // check runs BEFORE the errorCode-equality check below on purpose: a
      // `process_lost`-reason run returns false here for any non-`process_lost`
      // budget, fencing it out of another code's streak (cross-error leakage).
      if (!isContinuationAttemptRetryReason(retryReason, errorCodeToMatch)) break;
      if (
        !UNSUCCESSFUL_HEARTBEAT_RUN_TERMINAL_STATUSES.includes(
          row.status as (typeof UNSUCCESSFUL_HEARTBEAT_RUN_TERMINAL_STATUSES)[number],
        )
      ) {
        break;
      }

      const rowErrorCode = readNonEmptyString(row.errorCode);
      if (errorCodeToMatch !== rowErrorCode) {
        break;
      }

      consecutive += 1;
      if (latestFinishedAt === null) latestFinishedAt = row.finishedAt ?? null;
    }
    return { consecutive, latestFinishedAt };
  }

  async function hasActiveExecutionPath(companyId: string, issueId: string, agentId?: string | null) {
    const [run, deferredWake] = await Promise.all([
      db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.companyId, companyId),
            inArray(heartbeatRuns.status, [...EXECUTION_PATH_HEARTBEAT_RUN_STATUSES]),
            sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`,
            agentId ? eq(heartbeatRuns.agentId, agentId) : sql`true`,
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null),
      db
        .select({ id: agentWakeupRequests.id })
        .from(agentWakeupRequests)
        .where(
          and(
            eq(agentWakeupRequests.companyId, companyId),
            eq(agentWakeupRequests.status, "deferred_issue_execution"),
            sql`${agentWakeupRequests.payload} ->> 'issueId' = ${issueId}`,
            agentId ? eq(agentWakeupRequests.agentId, agentId) : sql`true`,
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null),
    ]);

    return Boolean(run || deferredWake);
  }

  /**
   * Whether the recorded return owner can actually be assigned work, and if not, why.
   *
   * Mirrors the route-layer `normalizeIssueAssigneeAgentReference` gate, but as a value
   * rather than a thrown HTTP error, so the drain can report a per-row reason instead of
   * aborting the batch. Handing work to a terminated or unapproved agent is how a hand-back
   * "succeeds" and still never converges.
   */
  async function resolveReturnOwnerEligibility(
    companyId: string,
    returnOwnerAgentId: string,
  ): Promise<{ assignable: boolean; reason: string }> {
    const companyAgents = await db
      .select({
        id: agents.id,
        companyId: agents.companyId,
        name: agents.name,
        status: agents.status,
        reportsTo: agents.reportsTo,
      })
      .from(agents)
      .where(eq(agents.companyId, companyId));
    const agent = companyAgents.find((row) => row.id === returnOwnerAgentId);
    if (!agent) return { assignable: false, reason: "not_found" };
    const eligibility = getAgentWorkEligibility({ agent, agents: companyAgents });
    return { assignable: eligibility.assignable, reason: eligibility.assignabilityReason };
  }

  /**
   * Positive evidence that an agent recently did real work — not merely that it is alive.
   *
   * `agents.lastHeartbeatAt` only proves the process ticked, and a no-op run still reports
   * `status: "succeeded"`, so both are satisfied by an agent that is accomplishing nothing.
   * `livenessState` is the classifier's verdict on whether the run advanced anything, which
   * is the signal the plan required in place of the dry run's liveness proxy.
   *
   * `lastUsefulActionAt` is coalesced with `lastOutputAt` because some adapters
   * (`opencode_k8s`) never write the former, and a bare `is not null` on it would silently
   * exclude every agent on those adapters.
   */
  async function hasPositiveRunEvidence(agentId: string, cutoff: Date): Promise<boolean> {
    // Bind the cutoff as an ISO string with an explicit cast: postgres.js cannot serialize a
    // Date passed into a raw `sql` template (it only accepts string/Buffer there), so a bare
    // `${cutoff}` throws ERR_INVALID_ARG_TYPE at bind time rather than returning a wrong row.
    const cutoffIso = cutoff.toISOString();
    const rows = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.agentId, agentId),
        eq(heartbeatRuns.status, "succeeded"),
        inArray(heartbeatRuns.livenessState, ["completed", "advanced"]),
        sql`coalesce(${heartbeatRuns.lastUsefulActionAt}, ${heartbeatRuns.lastOutputAt}, ${heartbeatRuns.finishedAt}) > ${cutoffIso}::timestamptz`,
      ))
      .limit(1);
    return rows.length > 0;
  }

  /**
   * Whether a first-class `blocks` relation still holds this issue back. This is the
   * truthfulness precondition the resolve endpoint enforces for a `blocked` outcome
   * (`routes/issues.ts:8710`), duplicated here so the sweep path inherits it too.
   */
  async function hasUnresolvedFirstClassBlocker(issueId: string): Promise<boolean> {
    const rows = await db
      .select({ id: issueRelations.id })
      .from(issueRelations)
      .innerJoin(issues, eq(issues.id, issueRelations.issueId))
      .where(and(
        eq(issueRelations.type, "blocks"),
        eq(issueRelations.relatedIssueId, issueId),
        notInArray(issues.status, ["done", "cancelled"]),
      ))
      .limit(1);
    return rows.length > 0;
  }

  async function hasPendingWakeInteraction(companyId: string, issueId: string) {
    return db
      .select({ id: issueThreadInteractions.id })
      .from(issueThreadInteractions)
      .where(
        and(
          eq(issueThreadInteractions.companyId, companyId),
          eq(issueThreadInteractions.issueId, issueId),
          eq(issueThreadInteractions.status, "pending"),
          inArray(issueThreadInteractions.continuationPolicy, ["wake_assignee", "wake_assignee_on_accept"]),
        ),
      )
      .limit(1)
      .then((rows) => Boolean(rows[0]));
  }

  async function hasPersistedDurableWaitPath(issue: typeof issues.$inferSelect) {
    if (issue.monitorNextCheckAt) return true;

    return db
      .select({ id: issueRelations.issueId })
      .from(issueRelations)
      .innerJoin(issues, eq(issueRelations.issueId, issues.id))
      .where(
        and(
          eq(issueRelations.companyId, issue.companyId),
          eq(issueRelations.relatedIssueId, issue.id),
          eq(issueRelations.type, "blocks"),
          eq(issues.companyId, issue.companyId),
          notInArray(issues.status, ["done", "cancelled"]),
          isNull(issues.hiddenAt),
        ),
      )
      .limit(1)
      .then((rows) => Boolean(rows[0]));
  }

  async function hasQueuedIssueWake(companyId: string, issueId: string, agentId?: string | null) {
    return db
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, companyId),
          eq(agentWakeupRequests.status, "queued"),
          sql`${agentWakeupRequests.payload} ->> 'issueId' = ${issueId}`,
          agentId ? eq(agentWakeupRequests.agentId, agentId) : sql`true`,
        ),
      )
      .limit(1)
      .then((rows) => Boolean(rows[0]));
  }

  async function hasQueuedExecutionReviewParticipantRecoveryWake(
    companyId: string,
    issueId: string,
    participantAgentId: string,
    stageId: string,
  ) {
    return db
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, companyId),
          eq(agentWakeupRequests.agentId, participantAgentId),
          eq(agentWakeupRequests.status, "queued"),
          eq(agentWakeupRequests.reason, EXECUTION_REVIEW_PARTICIPANT_RECOVERY_REASON),
          sql`${agentWakeupRequests.payload} ->> 'issueId' = ${issueId}`,
          sql`coalesce(
            ${agentWakeupRequests.payload} ->> 'currentStageId',
            ${agentWakeupRequests.payload} -> 'executionStage' ->> 'stageId'
          ) = ${stageId}`,
        ),
      )
      .limit(1)
      .then((rows) => Boolean(rows[0]));
  }

  async function latestDependencyReadinessTransitionAt(companyId: string, blockerIssueIds: string[]) {
    const uniqueBlockerIssueIds = [...new Set(blockerIssueIds.filter(Boolean))];
    if (uniqueBlockerIssueIds.length === 0) return null;
    const blockerRows = await db
      .select({
        id: issues.id,
        completedAt: issues.completedAt,
        executionWorkspaceId: issues.executionWorkspaceId,
      })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          inArray(issues.id, uniqueBlockerIssueIds),
          eq(issues.status, "done"),
        ),
      )
      .then((rows) => rows);

    const readyAtByBlocker = new Map<string, Date | null>(
      blockerRows.map((row) => [row.id, row.completedAt ?? null]),
    );
    const blockerWorkspacePairs = blockerRows.flatMap((row) =>
      row.executionWorkspaceId
        ? [{ blockerIssueId: row.id, executionWorkspaceId: row.executionWorkspaceId }]
        : []
    );

    if (blockerWorkspacePairs.length > 0) {
      const blockerWorkspaceKeys = new Set(
        blockerWorkspacePairs.map((pair) => `${pair.blockerIssueId}:${pair.executionWorkspaceId}`),
      );
      const executionWorkspaceIds = [
        ...new Set(blockerWorkspacePairs.map((pair) => pair.executionWorkspaceId)),
      ];
      const finalizeRows = await db
        .select({
          issueId: workspaceOperations.issueId,
          executionWorkspaceId: workspaceOperations.executionWorkspaceId,
          finishedAt: workspaceOperations.finishedAt,
          startedAt: workspaceOperations.startedAt,
        })
        .from(workspaceOperations)
        .where(
          and(
            eq(workspaceOperations.companyId, companyId),
            inArray(workspaceOperations.executionWorkspaceId, executionWorkspaceIds),
            eq(workspaceOperations.phase, "workspace_finalize"),
            eq(workspaceOperations.status, "succeeded"),
            or(inArray(workspaceOperations.issueId, uniqueBlockerIssueIds), isNull(workspaceOperations.issueId)),
          ),
        );

      const latestAttributedByBlockerWorkspace = new Map<string, Date>();
      const latestUnattributedByWorkspace = new Map<string, Date>();
      for (const row of finalizeRows) {
        if (!row.executionWorkspaceId) continue;
        // A successful finalization restores readiness when it completes, not
        // when it begins. Keep `startedAt` only as a compatibility fallback for
        // legacy succeeded rows that predate (or failed to persist) `finishedAt`.
        const finalizedAt = row.finishedAt ?? row.startedAt;
        if (row.issueId) {
          const key = `${row.issueId}:${row.executionWorkspaceId}`;
          if (!blockerWorkspaceKeys.has(key)) continue;
          const current = latestAttributedByBlockerWorkspace.get(key);
          if (!current || finalizedAt > current) latestAttributedByBlockerWorkspace.set(key, finalizedAt);
          continue;
        }
        const current = latestUnattributedByWorkspace.get(row.executionWorkspaceId);
        if (!current || finalizedAt > current) latestUnattributedByWorkspace.set(row.executionWorkspaceId, finalizedAt);
      }

      for (const pair of blockerWorkspacePairs) {
        const finalizedAt = latestAttributedByBlockerWorkspace.get(`${pair.blockerIssueId}:${pair.executionWorkspaceId}`)
          ?? latestUnattributedByWorkspace.get(pair.executionWorkspaceId)
          ?? null;
        if (!finalizedAt) continue;
        const current = readyAtByBlocker.get(pair.blockerIssueId) ?? null;
        if (!current || finalizedAt > current) readyAtByBlocker.set(pair.blockerIssueId, finalizedAt);
      }
    }

    let latestReadyAt: Date | null = null;
    for (const readyAt of readyAtByBlocker.values()) {
      if (readyAt && (!latestReadyAt || readyAt > latestReadyAt)) latestReadyAt = readyAt;
    }
    return latestReadyAt;
  }

  function isWithinDependencyResolvedWakeGrace(completedAt: Date | null, now = new Date()) {
    return completedAt !== null && now.getTime() - completedAt.getTime() < DEPENDENCY_RESOLVED_WAKE_GRACE_MS;
  }

  async function hasObservableDependencyResolvedWakePath(input: {
    issue: typeof issues.$inferSelect;
    blockerIssueIds: string[];
  }) {
    const blockerIssueIds = [...new Set(input.blockerIssueIds.filter(Boolean))];
    const assigneeAgentId = input.issue.assigneeAgentId;
    if (!assigneeAgentId || blockerIssueIds.length === 0) return false;
    const idempotencyKeys = blockerIssueIds.map((blockerIssueId) =>
      buildIssueBlockersResolvedWakeIdempotencyKey({
        dependentIssueId: input.issue.id,
        resolvedBlockerIssueId: blockerIssueId,
      })
    );
    const existingWake = await findExistingIssueBlockersResolvedWakeForAnyKey(db, {
      companyId: input.issue.companyId,
      idempotencyKeys,
    });
    if (existingWake && LIVE_ISSUE_BLOCKERS_RESOLVED_WAKE_STATUSES.has(existingWake.status)) return true;

    const [activeExecutionPath, queuedIssueWake, pendingWakeInteraction] = await Promise.all([
      hasActiveExecutionPath(input.issue.companyId, input.issue.id, assigneeAgentId),
      hasQueuedIssueWake(input.issue.companyId, input.issue.id, assigneeAgentId),
      hasPendingWakeInteraction(input.issue.companyId, input.issue.id),
    ]);
    return activeExecutionPath || queuedIssueWake || pendingWakeInteraction;
  }

  async function getLatestAcceptedContinuationInteraction(companyId: string, issueId: string) {
    return db
      .select({
        id: issueThreadInteractions.id,
        kind: issueThreadInteractions.kind,
        status: issueThreadInteractions.status,
        continuationPolicy: issueThreadInteractions.continuationPolicy,
        sourceRunId: issueThreadInteractions.sourceRunId,
        resolvedAt: issueThreadInteractions.resolvedAt,
        updatedAt: issueThreadInteractions.updatedAt,
      })
      .from(issueThreadInteractions)
      .where(
        and(
          eq(issueThreadInteractions.companyId, companyId),
          eq(issueThreadInteractions.issueId, issueId),
          eq(issueThreadInteractions.status, "accepted"),
          inArray(issueThreadInteractions.continuationPolicy, ["wake_assignee", "wake_assignee_on_accept"]),
        ),
      )
      .orderBy(desc(sql`coalesce(${issueThreadInteractions.resolvedAt}, ${issueThreadInteractions.updatedAt})`), desc(issueThreadInteractions.id))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function hasSuccessfulIssueRunSince(
    companyId: string,
    issueId: string,
    since: Date,
    interactionId?: string | null,
  ) {
    return db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          eq(heartbeatRuns.status, "succeeded"),
          sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`,
          interactionId
            ? sql`${heartbeatRuns.contextSnapshot} ->> 'interactionId' = ${interactionId}`
            : sql`true`,
          or(gte(heartbeatRuns.createdAt, since), gte(heartbeatRuns.finishedAt, since)),
        ),
      )
      .limit(1)
      .then((rows) => Boolean(rows[0]));
  }

  async function getLatestIssueRunSince(
    companyId: string,
    issueId: string,
    since: Date,
    interactionId: string,
  ): Promise<LatestIssueRun> {
    return db
      .select({
        id: heartbeatRuns.id,
        agentId: heartbeatRuns.agentId,
        status: heartbeatRuns.status,
        error: heartbeatRuns.error,
        errorCode: heartbeatRuns.errorCode,
        contextSnapshot: heartbeatRuns.contextSnapshot,
        livenessState: heartbeatRuns.livenessState,
        resultJson: heartbeatRuns.resultJson,
        usageJson: heartbeatRuns.usageJson,
        sessionIdBefore: heartbeatRuns.sessionIdBefore,
        scheduledRetryAttempt: heartbeatRuns.scheduledRetryAttempt,
        createdAt: heartbeatRuns.createdAt,
        finishedAt: heartbeatRuns.finishedAt,
      })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`,
          sql`${heartbeatRuns.contextSnapshot} ->> 'interactionId' = ${interactionId}`,
          or(gte(heartbeatRuns.createdAt, since), gte(heartbeatRuns.finishedAt, since)),
        ),
      )
      .orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  // GGU-809: visible-progress signal for stranded-recovery escalation guard.
  // Returns true if the assignee posted a comment, OR any attachment was added
  // to the issue, within `windowMs`. Used to suppress false-positive recovery
  // issues for batch workflows that genuinely advance every heartbeat.
  async function hasRecentVisibleProgress(
    companyId: string,
    issueId: string,
    assigneeAgentId: string,
    windowMs: number,
  ) {
    const since = new Date(Date.now() - windowMs);
    const [comment, attachment] = await Promise.all([
      db
        .select({ id: issueComments.id })
        .from(issueComments)
        .where(
          and(
            eq(issueComments.companyId, companyId),
            eq(issueComments.issueId, issueId),
            eq(issueComments.authorAgentId, assigneeAgentId),
            gt(issueComments.createdAt, since),
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null),
      db
        .select({ id: issueAttachments.id })
        .from(issueAttachments)
        .where(
          and(
            eq(issueAttachments.companyId, companyId),
            eq(issueAttachments.issueId, issueId),
            gt(issueAttachments.createdAt, since),
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null),
    ]);
    return Boolean(comment || attachment);
  }

  async function enqueueStrandedIssueRecovery(input: {
    issueId: string;
    agentId: string;
    reason: "issue_assignment_recovery" | "issue_continuation_needed" | "issue_zero_token_session_reset" | typeof EXECUTION_REVIEW_PARTICIPANT_RECOVERY_REASON;
    retryReason: "assignment_recovery" | "issue_continuation_needed" | "zero_token_session_reset" | typeof EXECUTION_REVIEW_PARTICIPANT_RECOVERY_REASON;
    source: string;
    retryOfRunId?: string | null;
    extraContext?: Record<string, unknown>;
    // BLO-19160: when this recovery follows a checkout-handover observation,
    // the lock/owner values it was decided on. If an adoption committed in the
    // meantime a live run owns this issue now, and queuing a wake would put
    // competing work against it.
    expectedLockOwnerState?: IssueLockOwnerState | null;
  }) {
    if (await issueLockOwnerStateChanged(input.issueId, input.expectedLockOwnerState)) return null;

    const queued = await deps.enqueueWakeup(input.agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: input.reason,
      payload: withRecoveryModelProfileHint({
        issueId: input.issueId,
        ...(input.retryOfRunId ? { retryOfRunId: input.retryOfRunId } : {}),
        ...(input.extraContext ?? {}),
      }, "normal_model"),
      requestedByActorType: "system",
      requestedByActorId: null,
      contextSnapshot: withRecoveryModelProfileHint({
        issueId: input.issueId,
        taskId: input.issueId,
        wakeReason: input.reason,
        retryReason: input.retryReason,
        source: input.source,
        ...(input.retryOfRunId ? { retryOfRunId: input.retryOfRunId } : {}),
        ...(input.extraContext ?? {}),
      }, "normal_model"),
      retryOfRunId: input.retryOfRunId,
      expectedLockOwnerState: input.expectedLockOwnerState,
      scheduledRetryAttempt:
        typeof input.extraContext?.scheduledRetryAttempt === "number"
          ? input.extraContext.scheduledRetryAttempt
          : undefined,
    });
    return queued;
  }

  async function enqueueInitialAssignedTodoDispatch(
    issue: typeof issues.$inferSelect,
    agentId: string,
    expectedLockOwnerState?: IssueLockOwnerState | null,
  ) {
    // BLO-19160: see `enqueueStrandedIssueRecovery` — on the handover path this
    // dispatch must not race a freshly committed adoption.
    if (await issueLockOwnerStateChanged(issue.id, expectedLockOwnerState)) return null;
    return deps.enqueueWakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: withRecoveryModelProfileHint({
        issueId: issue.id,
        mutation: "assigned_todo_liveness_dispatch",
      }, "normal_model"),
      requestedByActorType: "system",
      requestedByActorId: null,
      contextSnapshot: withRecoveryModelProfileHint({
        issueId: issue.id,
        taskId: issue.id,
        wakeReason: "issue_assigned",
        source: "issue.assigned_todo_liveness_dispatch",
      }, "normal_model"),
      expectedLockOwnerState,
    });
  }

  async function enqueueWithAssignmentRecoveryCapacity<T>(
    issue: Pick<typeof issues.$inferSelect, "companyId">,
    agentId: string,
    enqueue: () => Promise<T | null | undefined>,
  ): Promise<T | null> {
    // Reserve under the cross-replica lock, then release the transaction's
    // connection before enqueueWakeup acquires its own connection.
    const reservationId = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${issue.companyId} || ':assignment_recovery:' || ${agentId}, 0))`,
      );

      await tx.delete(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.companyId, issue.companyId),
        eq(agentWakeupRequests.agentId, agentId),
        eq(agentWakeupRequests.status, ASSIGNMENT_RECOVERY_CAPACITY_RESERVATION_STATUS),
        lt(agentWakeupRequests.updatedAt, new Date(Date.now() - ASSIGNMENT_RECOVERY_CAPACITY_RESERVATION_TTL_MS)),
      ));

      const liveAssignmentRecoveryRuns = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(heartbeatRuns)
        .where(and(
          eq(heartbeatRuns.companyId, issue.companyId),
          eq(heartbeatRuns.agentId, agentId),
          inArray(heartbeatRuns.status, ["queued", "scheduled_retry", "running"]),
          or(
            sql`${heartbeatRuns.contextSnapshot} ->> 'retryReason' = 'assignment_recovery'`,
            sql`${heartbeatRuns.contextSnapshot} ->> 'source' = 'issue.assigned_todo_liveness_dispatch'`,
          ),
        ))
        .then((rows) => Number(rows[0]?.count ?? 0));

      const activeReservations = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(agentWakeupRequests)
        .where(and(
          eq(agentWakeupRequests.companyId, issue.companyId),
          eq(agentWakeupRequests.agentId, agentId),
          eq(agentWakeupRequests.status, ASSIGNMENT_RECOVERY_CAPACITY_RESERVATION_STATUS),
        ))
        .then((rows) => Number(rows[0]?.count ?? 0));

      if (
        liveAssignmentRecoveryRuns + activeReservations >=
        ISSUE_ASSIGNMENT_RECOVERY_PER_AGENT_SWEEP_LIMIT
      ) {
        return null;
      }

      return tx
        .insert(agentWakeupRequests)
        .values({
          companyId: issue.companyId,
          agentId,
          source: "automation",
          triggerDetail: "system",
          reason: "issue_assignment_recovery_capacity_reservation",
          status: ASSIGNMENT_RECOVERY_CAPACITY_RESERVATION_STATUS,
        })
        .returning({ id: agentWakeupRequests.id })
        .then((rows) => rows[0]?.id ?? null);
    });

    if (!reservationId) return null;

    try {
      return await enqueue() ?? null;
    } finally {
      await db.delete(agentWakeupRequests).where(eq(agentWakeupRequests.id, reservationId));
    }
  }

  async function isInvocationBudgetBlocked(issue: typeof issues.$inferSelect, agentId: string) {
    const budgetBlock = await budgets.getInvocationBlock(issue.companyId, agentId, {
      issueId: issue.id,
      projectId: issue.projectId,
    });
    return Boolean(budgetBlock);
  }

  async function reconcileUnassignedBlockingIssues() {
    const candidates = await db
      .select({
        id: issues.id,
        companyId: issues.companyId,
        identifier: issues.identifier,
        status: issues.status,
        createdByAgentId: issues.createdByAgentId,
      })
      .from(issueRelations)
      .innerJoin(issues, eq(issueRelations.issueId, issues.id))
      .where(
        and(
          eq(issueRelations.type, "blocks"),
          inArray(issues.status, ["todo", "blocked"]),
          isNull(issues.assigneeAgentId),
          isNull(issues.assigneeUserId),
          sql`${issues.createdByAgentId} is not null`,
          sql`exists (
            select 1
            from issues blocked_issue
            where blocked_issue.id = ${issueRelations.relatedIssueId}
              and blocked_issue.company_id = ${issues.companyId}
              and blocked_issue.status not in ('done', 'cancelled')
          )`,
        ),
      );

    let assigned = 0;
    let skipped = 0;
    const issueIds: string[] = [];
    const seen = new Set<string>();

    for (const candidate of candidates) {
      if (seen.has(candidate.id)) continue;
      seen.add(candidate.id);

      const creatorAgentId = candidate.createdByAgentId;
      if (!creatorAgentId) {
        skipped += 1;
        continue;
      }
      const creatorAgent = await getAgent(creatorAgentId);
      if (!creatorAgent || creatorAgent.companyId !== candidate.companyId || !(await isAgentInvokable(creatorAgent))) {
        skipped += 1;
        continue;
      }

      const relations = await issuesSvc.getRelationSummaries(candidate.id);
      const blockingLinks = formatIssueLinksForComment(relations.blocks);
      const updated = await issuesSvc.update(candidate.id, {
        assigneeAgentId: creatorAgent.id,
        assigneeUserId: null,
      });
      if (!updated) {
        skipped += 1;
        continue;
      }

      await issuesSvc.addComment(
        candidate.id,
        [
          "## Assigned Orphan Blocker",
          "",
          `Paperclip found this issue is blocking ${blockingLinks} but had no assignee, so no heartbeat could pick it up.`,
          "",
          "- Assigned it back to the agent that created the blocker.",
          "- Next action: resolve this blocker or reassign it to the right owner.",
        ].join("\n"),
        {},
      );

      await logActivity(db, {
        companyId: candidate.companyId,
        actorType: "system",
        actorId: "system",
        agentId: null,
        runId: null,
        action: "issue.updated",
        entityType: "issue",
        entityId: candidate.id,
        details: {
          identifier: candidate.identifier,
          assigneeAgentId: creatorAgent.id,
          source: "recovery.reconcile_unassigned_blocking_issue",
        },
      });

      const queued = await deps.enqueueWakeup(creatorAgent.id, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: withRecoveryModelProfileHint({
          issueId: candidate.id,
          mutation: "unassigned_blocker_recovery",
        }, "normal_model"),
        requestedByActorType: "system",
        requestedByActorId: null,
        contextSnapshot: withRecoveryModelProfileHint({
          issueId: candidate.id,
          taskId: candidate.id,
          wakeReason: "issue_assigned",
          source: "issue.unassigned_blocker_recovery",
        }, "normal_model"),
      });

      if (queued) {
        assigned += 1;
        issueIds.push(candidate.id);
      } else {
        skipped += 1;
      }
    }

    return { assigned, skipped, issueIds };
  }

  async function getCompanyIssuePrefix(companyId: string) {
    return db
      .select({ issuePrefix: companies.issuePrefix })
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0]?.issuePrefix ?? "PAP");
  }

  function staleActiveRunOriginFingerprint(companyId: string, runId: string) {
    return `stale_active_run:${companyId}:${runId}`;
  }

  function isTerminalIssueStatus(status: string | null | undefined) {
    return status === "done" || status === "cancelled";
  }

  function isRecoveryOriginIssue(issue: typeof issues.$inferSelect) {
    return Object.values(RECOVERY_ORIGIN_KINDS).includes(
      issue.originKind as typeof RECOVERY_ORIGIN_KINDS[keyof typeof RECOVERY_ORIGIN_KINDS],
    );
  }

  function silenceStartedAtForRun(run: Pick<typeof heartbeatRuns.$inferSelect, "lastOutputAt" | "lastUsefulActionAt" | "processStartedAt" | "startedAt" | "createdAt">) {
    const progressTimes = [run.lastOutputAt, run.lastUsefulActionAt]
      .filter((value): value is Date => value instanceof Date)
      .map((value) => value.getTime());
    const progressAt = progressTimes.length > 0 ? new Date(Math.max(...progressTimes)) : null;
    return progressAt ?? run.processStartedAt ?? run.startedAt ?? run.createdAt ?? null;
  }

  function silenceAgeMsForRun(run: Pick<typeof heartbeatRuns.$inferSelect, "lastOutputAt" | "lastUsefulActionAt" | "processStartedAt" | "startedAt" | "createdAt">, now = new Date()) {
    const startedAt = silenceStartedAtForRun(run);
    return startedAt ? Math.max(0, now.getTime() - startedAt.getTime()) : null;
  }

  async function latestActiveOutputQuietUntilDecision(companyId: string, runId: string, now = new Date()) {
    const [row] = await db
      .select()
      .from(heartbeatRunWatchdogDecisions)
      .where(
        and(
          eq(heartbeatRunWatchdogDecisions.companyId, companyId),
          eq(heartbeatRunWatchdogDecisions.runId, runId),
          inArray(heartbeatRunWatchdogDecisions.decision, ["snooze", "continue"]),
          gt(heartbeatRunWatchdogDecisions.snoozedUntil, now),
        ),
      )
      .orderBy(desc(heartbeatRunWatchdogDecisions.createdAt))
      .limit(1);
    return row ?? null;
  }

  async function findOpenStaleRunEvaluation(companyId: string, runId: string) {
    const [row] = await db
      .select({
        id: issues.id,
        identifier: issues.identifier,
        status: issues.status,
        priority: issues.priority,
        assigneeAgentId: issues.assigneeAgentId,
        updatedAt: issues.updatedAt,
      })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, STALE_ACTIVE_RUN_EVALUATION_ORIGIN_KIND),
          eq(issues.originId, runId),
          visibleIssueCondition(),
          notInArray(issues.status, ["done", "cancelled"]),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  // BLO-7113: the most-recent wrapper for this run that was closed
  // (done/cancelled) within the re-fire cooldown. Window is measured from the
  // STABLE close timestamp (completed_at/cancelled_at), NOT updated_at — posting
  // the suppression tally comment bumps updated_at, so keying off it would let
  // the window slide indefinitely and never re-surface a genuinely-stuck run.
  async function findRecentClosedStaleRunEvaluation(companyId: string, runId: string, now: Date) {
    const cutoff = new Date(now.getTime() - STALE_ACTIVE_RUN_EVALUATION_REFIRE_COOLDOWN_MS);
    const [row] = await db
      .select({
        id: issues.id,
        identifier: issues.identifier,
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        completedAt: issues.completedAt,
        cancelledAt: issues.cancelledAt,
        updatedAt: issues.updatedAt,
      })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, STALE_ACTIVE_RUN_EVALUATION_ORIGIN_KIND),
          eq(issues.originId, runId),
          isNull(issues.hiddenAt),
          inArray(issues.status, ["done", "cancelled"]),
          sql`coalesce(${issues.completedAt}, ${issues.cancelledAt}, ${issues.updatedAt}) > ${cutoff.toISOString()}::timestamptz`,
          visibleIssueCondition(),
        ),
      )
      .orderBy(
        sql`coalesce(${issues.completedAt}, ${issues.cancelledAt}, ${issues.updatedAt}) desc`,
      )
      .limit(1);
    return row ?? null;
  }

  // BLO-7113: has the agent engaged this run's wrapper via a `continue`/`snooze`
  // watchdog decision within the cooldown? If so, the re-arm mechanism (which
  // deliberately re-surfaces a fresh wrapper after its quiet window) owns
  // re-creation — the re-fire cooldown must NOT suppress that. This scopes
  // suppression to the pure close-as-false-positive-then-auto-refire noise mode
  // (BLO-7090/7099/7109), where no such decision exists.
  async function hasRecentStaleRunWatchdogDecision(companyId: string, runId: string, since: Date) {
    const [row] = await db
      .select({ id: heartbeatRunWatchdogDecisions.id })
      .from(heartbeatRunWatchdogDecisions)
      .where(
        and(
          eq(heartbeatRunWatchdogDecisions.companyId, companyId),
          eq(heartbeatRunWatchdogDecisions.runId, runId),
          inArray(heartbeatRunWatchdogDecisions.decision, ["snooze", "continue"]),
          gt(heartbeatRunWatchdogDecisions.createdAt, since),
        ),
      )
      .limit(1);
    return Boolean(row);
  }

  // BLO-7113: count the suppression tally comments already recorded on a closed
  // wrapper within the escalation window. These are system-authored comments
  // whose body starts with the stable re-fire marker; once we have recorded
  // STALE_ACTIVE_RUN_EVALUATION_ESCALATION_THRESHOLD of them the detector
  // escalates by reopening instead of suppressing again.
  async function countRecentStaleRunRefireComments(issueId: string, since: Date) {
    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(issueComments)
      .where(
        and(
          eq(issueComments.issueId, issueId),
          eq(issueComments.authorType, "system"),
          gt(issueComments.createdAt, since),
          sql`${issueComments.body} like ${`${STALE_ACTIVE_RUN_EVALUATION_REFIRE_COMMENT_MARKER}%`}`,
        ),
      );
    return row?.count ?? 0;
  }

  // PCL-2571 (2026-05-25 RCA): when an active run is silent past the
  // suspicion threshold and the detector files a `stale_active_run_evaluation`
  // review, but moments later the heartbeat reaper finalizes the run to
  // `failed`/`cancelled` (process_lost is the dominant case), the silence
  // is fully explained by the termination and no operator review is needed.
  // Without this cleanup hook the review stayed `todo` on the CTO inbox
  // indefinitely — 11 stuck reviews accumulated in 5 days at the time of
  // this writing. Callers in the heartbeat reaper / cancellation paths
  // invoke this AFTER setRunStatus has flipped the run to its terminal
  // state, so a fresh detector sweep on the same run would no longer
  // create a new review either.
  async function dismissStaleEvaluationOnRunTerminated(input: {
    companyId: string;
    runId: string;
    agentId: string | null;
    terminalStatus: "failed" | "cancelled" | "timed_out";
    errorCode: string | null;
    errorMessage: string | null;
  }) {
    const evaluation = await findOpenStaleRunEvaluation(input.companyId, input.runId);
    if (!evaluation) return { kind: "none" as const };
    if (isTerminalIssueStatus(evaluation.status)) return { kind: "none" as const };
    const now = new Date();
    const [cancelledEvaluation] = await db
      .update(issues)
      .set({
        status: "cancelled",
        cancelledAt: now,
        checkoutRunId: null,
        executionRunId: null,
        executionAgentNameKey: null,
        executionLockedAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(issues.id, evaluation.id),
          eq(issues.companyId, input.companyId),
          eq(issues.originKind, STALE_ACTIVE_RUN_EVALUATION_ORIGIN_KIND),
          eq(issues.originId, input.runId),
          isNull(issues.hiddenAt),
          notInArray(issues.status, ["done", "cancelled"]),
        ),
      )
      .returning({
        id: issues.id,
        identifier: issues.identifier,
      });
    if (!cancelledEvaluation) return { kind: "none" as const };

    const blockedSources = await db
      .select({
        id: issues.id,
        companyId: issues.companyId,
        identifier: issues.identifier,
        status: issues.status,
      })
      .from(issueRelations)
      .innerJoin(issues, eq(issueRelations.relatedIssueId, issues.id))
      .where(
        and(
          eq(issueRelations.companyId, input.companyId),
          eq(issueRelations.issueId, cancelledEvaluation.id),
          eq(issueRelations.type, "blocks"),
          isNull(issues.hiddenAt),
          notInArray(issues.status, ["done", "cancelled"]),
        ),
      );

    let detachedBlockedSources = 0;
    for (const source of blockedSources) {
      const nextBlockerIds = (await existingBlockerIssueIds(source.companyId, source.id))
        .filter((blockerId) => blockerId !== cancelledEvaluation.id);
      await db
        .delete(issueRelations)
        .where(
          and(
            eq(issueRelations.companyId, source.companyId),
            eq(issueRelations.issueId, cancelledEvaluation.id),
            eq(issueRelations.relatedIssueId, source.id),
            eq(issueRelations.type, "blocks"),
          ),
        );
      const { blockerIssueIds: unresolvedAfterDetach } = await unresolvedBlockerHumanDecisionEscalationState(source.companyId, source.id);
      let restoredSourceStatus = false;
      let restoreSkippedReason: string | null = null;
      if (source.status === "blocked" && unresolvedAfterDetach.length === 0) {
        try {
          const restored = await issuesSvc.update(source.id, { status: "todo" });
          restoredSourceStatus = restored?.status === "todo";
        } catch (err) {
          restoreSkippedReason = err instanceof Error ? err.message : String(err);
          logger.warn(
            { err, issueId: source.id, companyId: source.companyId, evaluationIssueId: cancelledEvaluation.id },
            "detached stale active run evaluation blocker but could not restore source issue status",
          );
        }
      }
      detachedBlockedSources += 1;
      await logActivity(db, {
        companyId: source.companyId,
        actorType: "system",
        actorId: "system",
        agentId: input.agentId,
        runId: input.runId,
        action: "heartbeat.output_stale_blocker_detached_on_termination",
        entityType: "issue",
        entityId: source.id,
        details: {
          source: "recovery.dismiss_on_run_terminated",
          evaluationIssueId: cancelledEvaluation.id,
          evaluationIssueIdentifier: cancelledEvaluation.identifier,
          remainingBlockerCount: nextBlockerIds.length,
          remainingUnresolvedBlockerCount: unresolvedAfterDetach.length,
          restoredSourceStatus,
          restoreSkippedReason,
        },
      });
    }

    const bodyLines = [
      `Auto-cancelled: source run finalized to \`${input.terminalStatus}\`${
        input.errorCode ? ` (errorCode: \`${input.errorCode}\`)` : ""
      }.`,
      "",
      "The output silence that prompted this review was explained by the heartbeat reaper rather than requiring operator intervention.",
    ];
    if (input.errorMessage) {
      bodyLines.push("", `> ${input.errorMessage}`);
    }
    await issuesSvc.addComment(evaluation.id, bodyLines.join("\n"), { runId: input.runId });
    await logActivity(db, {
      companyId: input.companyId,
      actorType: "system",
      actorId: "system",
      agentId: input.agentId,
      runId: input.runId,
      action: "heartbeat.output_stale_auto_dismissed_on_termination",
      entityType: "issue",
      entityId: evaluation.id,
      details: {
        source: "recovery.dismiss_on_run_terminated",
        terminalStatus: input.terminalStatus,
        errorCode: input.errorCode,
        evaluationIssueIdentifier: cancelledEvaluation.identifier,
        detachedBlockedSources,
      },
    });
    return { kind: "dismissed" as const, evaluationIssueId: cancelledEvaluation.id };
  }

  // Returns true when a reviewer has already dismissed this run's silence as a false positive.
  // Used to prevent re-filing after a deliberate close — while still allowing legitimate
  // re-arm after a "continue" decision's snooze window expires.
  async function hasDismissedFalsePositiveDecision(companyId: string, runId: string) {
    const [row] = await db
      .select({ id: heartbeatRunWatchdogDecisions.id })
      .from(heartbeatRunWatchdogDecisions)
      .where(
        and(
          eq(heartbeatRunWatchdogDecisions.companyId, companyId),
          eq(heartbeatRunWatchdogDecisions.runId, runId),
          eq(heartbeatRunWatchdogDecisions.decision, "dismissed_false_positive"),
        ),
      )
      .limit(1);
    return row != null;
  }

  async function buildRunOutputSilence(
    run: Pick<
      typeof heartbeatRuns.$inferSelect,
      "id" | "companyId" | "status" | "lastOutputAt" | "lastOutputSeq" | "lastOutputStream" | "lastUsefulActionAt" | "processStartedAt" | "startedAt" | "createdAt"
    >,
    now = new Date(),
  ): Promise<RunOutputSilenceSummary> {
    const [quietUntilDecision, evaluation] = await Promise.all([
      latestActiveOutputQuietUntilDecision(run.companyId, run.id, now),
      findOpenStaleRunEvaluation(run.companyId, run.id),
    ]);
    const silenceStartedAt = silenceStartedAtForRun(run);
    const silenceAgeMs = run.status === "running" ? silenceAgeMsForRun(run, now) : null;
    const level = run.status !== "running"
      ? "not_applicable"
      : quietUntilDecision
        ? "snoozed"
        : (silenceAgeMs ?? 0) >= ACTIVE_RUN_OUTPUT_CRITICAL_THRESHOLD_MS
          ? "critical"
          : (silenceAgeMs ?? 0) >= ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS
            ? "suspicious"
            : "ok";
    return {
      lastOutputAt: run.lastOutputAt ?? null,
      lastOutputSeq: run.lastOutputSeq ?? 0,
      lastOutputStream: (run.lastOutputStream === "stdout" || run.lastOutputStream === "stderr")
        ? run.lastOutputStream
        : null,
      silenceStartedAt,
      silenceAgeMs,
      level,
      suspicionThresholdMs: ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS,
      criticalThresholdMs: ACTIVE_RUN_OUTPUT_CRITICAL_THRESHOLD_MS,
      snoozedUntil: quietUntilDecision?.snoozedUntil ?? null,
      evaluationIssueId: evaluation?.id ?? null,
      evaluationIssueIdentifier: evaluation?.identifier ?? null,
      evaluationIssueAssigneeAgentId: evaluation?.assigneeAgentId ?? null,
    };
  }

  function redactWatchdogEvidenceText(value: string, currentUserRedactionOptions: Awaited<ReturnType<typeof getCurrentUserRedactionOptions>>) {
    return redactSensitiveText(redactCurrentUserText(value, currentUserRedactionOptions));
  }

  function truncateEvidenceText(value: string, maxChars = 4000) {
    if (value.length <= maxChars) return value;
    return `${value.slice(value.length - maxChars)}\n[truncated earlier evidence]`;
  }

  async function readRunLogTailForEvidence(run: typeof heartbeatRuns.$inferSelect) {
    // PEN-2106: do NOT gate on `run.logBytes`. `logStore`/`logRef` are written
    // immediately after runLogStore.begin(), but `logBytes` is only written back
    // on finalize — so it is null/0 for exactly the runs this detector fires on,
    // and requiring it made the card's evidence block unconditionally empty for
    // every stale-run wrapper ever minted. The store already stat()s and clamps
    // the range to the real file, so the hint is advisory in both directions.
    if (!run.logStore || !run.logRef) return "";
    const sizeHint = Number(run.logBytes ?? 0);
    let offset = Number.isFinite(sizeHint) && sizeHint > ACTIVE_RUN_OUTPUT_EVIDENCE_TAIL_BYTES
      ? sizeHint - ACTIVE_RUN_OUTPUT_EVIDENCE_TAIL_BYTES
      : 0;
    let tail = "";
    let scanned = 0;
    try {
      while (scanned < ACTIVE_RUN_OUTPUT_EVIDENCE_MAX_SCAN_BYTES) {
        const limitBytes = Math.min(
          ACTIVE_RUN_OUTPUT_EVIDENCE_SCAN_CHUNK_BYTES,
          ACTIVE_RUN_OUTPUT_EVIDENCE_MAX_SCAN_BYTES - scanned,
        );
        const result = await runLogStore.read(
          { store: run.logStore as "local_file", logRef: run.logRef },
          { offset, limitBytes },
        );
        scanned += Buffer.byteLength(result.content, "utf8");
        // Keep only the trailing window: the last lines are the diagnostic ones
        // (an adapter timeout on stderr is typically the final entry).
        tail = (tail + result.content).slice(-ACTIVE_RUN_OUTPUT_EVIDENCE_TAIL_BYTES);
        // `nextOffset` is undefined once the store has served the final byte.
        // The `<= offset` guard keeps a misbehaving store from looping forever.
        if (result.nextOffset == null || result.nextOffset <= offset) break;
        offset = result.nextOffset;
      }
      return tail;
    } catch (err) {
      logger.warn({ err, runId: run.id }, "failed to read stale-run watchdog evidence tail");
      // A partial tail is strictly better evidence than none.
      return tail;
    }
  }

  async function resolveStaleRunSourceIssue(run: typeof heartbeatRuns.$inferSelect) {
    const issueId = issueIdFromRunContext(run.contextSnapshot);
    if (!issueId) return null;
    const [issue] = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, run.companyId), eq(issues.id, issueId), visibleIssueCondition()))
      .limit(1);
    return issue ?? null;
  }

  async function latestSameRunSourceTerminalEvidence(input: {
    run: typeof heartbeatRuns.$inferSelect;
    sourceIssue: typeof issues.$inferSelect;
    evidenceAfter: Date | null;
  }) {
    if (!isTerminalIssueStatus(input.sourceIssue.status)) return null;
    const after = input.evidenceAfter ?? input.run.startedAt ?? input.run.createdAt ?? null;
    const activityPredicates = [
      eq(activityLog.companyId, input.run.companyId),
      eq(activityLog.runId, input.run.id),
      eq(activityLog.action, "issue.updated"),
      eq(activityLog.entityType, "issue"),
      eq(activityLog.entityId, input.sourceIssue.id),
      sql`${activityLog.details} ->> 'status' = ${input.sourceIssue.status}`,
    ];
    if (after) {
      activityPredicates.push(gte(activityLog.createdAt, after));
    }

    const activity = await db
      .select({
        id: activityLog.id,
        createdAt: activityLog.createdAt,
        action: activityLog.action,
      })
      .from(activityLog)
      .where(and(...activityPredicates))
      .orderBy(desc(activityLog.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);

    if (activity) {
      return {
        kind: "activity" as const,
        id: activity.id,
        createdAt: activity.createdAt,
        action: activity.action,
      };
    }
    return null;
  }

  async function nextRunEventSeq(runId: string) {
    const [row] = await db
      .select({ maxSeq: sql<number | null>`max(${heartbeatRunEvents.seq})` })
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, runId));
    return Number(row?.maxSeq ?? 0) + 1;
  }

  async function appendRecoveryRunEvent(
    run: typeof heartbeatRuns.$inferSelect,
    event: {
      level: "info" | "warn" | "error";
      message: string;
      payload?: Record<string, unknown>;
    },
  ) {
    await db.insert(heartbeatRunEvents).values({
      companyId: run.companyId,
      runId: run.id,
      agentId: run.agentId,
      seq: await nextRunEventSeq(run.id),
      eventType: "lifecycle",
      stream: "system",
      level: event.level,
      message: event.message,
      payload: event.payload ?? null,
    });
  }

  async function cleanupSourceResolvedRunProcess(input: {
    run: typeof heartbeatRuns.$inferSelect;
    runningAgent: typeof agents.$inferSelect;
  }) {
    if (!SESSIONED_LOCAL_ADAPTERS.has(input.runningAgent.adapterType)) {
      return {
        attempted: false,
        outcome: "skipped_non_local_adapter",
        adapterType: input.runningAgent.adapterType,
      };
    }

    const running = runningProcesses.get(input.run.id);
    const pid = running?.child.pid ?? input.run.processPid ?? null;
    const processGroupId = running?.processGroupId ?? input.run.processGroupId ?? null;
    if (typeof pid !== "number" && typeof processGroupId !== "number") {
      return {
        attempted: false,
        outcome: "no_process_metadata",
        adapterType: input.runningAgent.adapterType,
      };
    }

    const wasAlive =
      (typeof pid === "number" && isPidAlive(pid)) ||
      (typeof processGroupId === "number" && isProcessGroupAlive(processGroupId));
    if (!wasAlive) {
      runningProcesses.delete(input.run.id);
      return {
        attempted: false,
        outcome: "not_running",
        adapterType: input.runningAgent.adapterType,
        pid,
        processGroupId,
      };
    }

    try {
      await terminateLocalService(
        {
          pid: typeof pid === "number" && Number.isInteger(pid) && pid > 0
            ? pid
            : (processGroupId ?? 0),
          processGroupId: typeof processGroupId === "number" && Number.isInteger(processGroupId) && processGroupId > 0
            ? processGroupId
            : null,
        },
        running ? { forceAfterMs: Math.max(1, running.graceSec) * 1000 } : undefined,
      );
      runningProcesses.delete(input.run.id);
      const stillAlive =
        (typeof pid === "number" && isPidAlive(pid)) ||
        (typeof processGroupId === "number" && isProcessGroupAlive(processGroupId));
      return {
        attempted: true,
        outcome: stillAlive ? "termination_sent_still_running" : "terminated",
        adapterType: input.runningAgent.adapterType,
        pid,
        processGroupId,
      };
    } catch (error) {
      return {
        attempted: true,
        outcome: "failed",
        adapterType: input.runningAgent.adapterType,
        pid,
        processGroupId,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async function finalizeAgentAfterSourceResolvedRun(run: typeof heartbeatRuns.$inferSelect, status: "succeeded" | "cancelled") {
    const [runningCountRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.agentId, run.agentId), eq(heartbeatRuns.status, "running")));
    const runningCount = Number(runningCountRow?.count ?? 0);
    const nextStatus = runningCount > 0 ? "running" : status === "succeeded" || status === "cancelled" ? "idle" : "error";
    await db
      .update(agents)
      .set({
        status: nextStatus,
        lastHeartbeatAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(agents.id, run.agentId), notInArray(agents.status, ["paused", "terminated"])));
  }

  async function foldSourceResolvedStaleRun(input: {
    run: typeof heartbeatRuns.$inferSelect;
    runningAgent: typeof agents.$inferSelect;
    sourceIssue: typeof issues.$inferSelect;
    evidence: Awaited<ReturnType<typeof latestSameRunSourceTerminalEvidence>>;
    existingEvaluation: Awaited<ReturnType<typeof findOpenStaleRunEvaluation>>;
    silenceStartedAt: Date | null;
    silenceAgeMs: number | null;
    now: Date;
  }) {
    if (!input.evidence) return { kind: "skipped" as const };
    const cleanup = await cleanupSourceResolvedRunProcess({ run: input.run, runningAgent: input.runningAgent });
    const finalRunStatus = input.sourceIssue.status === "cancelled" ? "cancelled" : "succeeded";
    const resultJson = {
      ...parseObject(input.run.resultJson),
      sourceResolvedWatchdogFold: {
        sourceIssueId: input.sourceIssue.id,
        sourceIssueIdentifier: input.sourceIssue.identifier,
        sourceIssueStatus: input.sourceIssue.status,
        sameRunEvidenceKind: input.evidence.kind,
        sameRunEvidenceId: input.evidence.id,
        sameRunEvidenceAt: input.evidence.createdAt.toISOString(),
        silenceStartedAt: input.silenceStartedAt?.toISOString() ?? null,
        silenceAgeMs: input.silenceAgeMs,
        evaluationIssueId: input.existingEvaluation?.id ?? null,
        evaluationIssueIdentifier: input.existingEvaluation?.identifier ?? null,
        cleanup,
      },
    };
    const finalizedRun = await db.transaction(async (tx) => {
      // Lock order: issues before heartbeat_runs.
      //
      // sweepStaleIssueLocks takes `issues` FOR UPDATE and then `heartbeat_runs`
      // FOR UPDATE; releaseIssueExecutionAndPromote likewise locks issues first
      // and documents the ordering explicitly. This transaction used to update
      // the run row first and the issue row last, so the two paths acquired the
      // same two rows in opposite orders — and they contend on precisely the
      // pair the sweep exists to reconcile: an execution lock whose holder is
      // finalizing. Under that race Postgres aborts one side with
      // deadlock_detected (40P01) instead of either completing, which is the
      // failure the sweep is supposed to prevent.
      //
      // Taking the issue row up front removes the inversion without changing
      // semantics: the conditional UPDATE below still no-ops when the lock has
      // already moved to another run, and a missing issue row simply locks
      // nothing, exactly as before.
      await tx
        .select({ id: issues.id })
        .from(issues)
        .where(and(eq(issues.id, input.sourceIssue.id), eq(issues.companyId, input.run.companyId)))
        .for("update");

      const [updatedRun] = await tx
        .update(heartbeatRuns)
        .set({
          status: finalRunStatus,
          finishedAt: input.now,
          error: null,
          errorCode: null,
          resultJson,
          updatedAt: input.now,
        })
        .where(and(eq(heartbeatRuns.id, input.run.id), eq(heartbeatRuns.companyId, input.run.companyId), eq(heartbeatRuns.status, "running")))
        .returning();
      if (!updatedRun) return null;

      if (input.run.wakeupRequestId) {
        await tx
          .update(agentWakeupRequests)
          .set({
            status: finalRunStatus === "succeeded" ? "completed" : "cancelled",
            finishedAt: input.now,
            error: null,
            updatedAt: input.now,
          })
          .where(and(eq(agentWakeupRequests.id, input.run.wakeupRequestId), eq(agentWakeupRequests.companyId, input.run.companyId)));
      }

      await releaseIssueRunOwnership(tx, {
        issueId: input.sourceIssue.id,
        companyId: input.run.companyId,
        runId: input.run.id,
        updatedAt: input.now,
      });

      // The run is finalized; if it never wrote a status of its own, undo the
      // `in_progress` its checkout wrote (BLO-20649).
      await restoreCheckoutPromotedStatus(tx, {
        issueId: input.sourceIssue.id,
        companyId: input.run.companyId,
      });

      return updatedRun;
    });
    if (!finalizedRun) return { kind: "skipped" as const };

    if (input.existingEvaluation && !isTerminalIssueStatus(input.existingEvaluation.status)) {
      await issuesSvc.update(input.existingEvaluation.id, { status: "done" });
      await issuesSvc.addComment(input.existingEvaluation.id, [
        "Source-resolved watchdog fold.",
        "",
        `- Source issue: ${input.sourceIssue.identifier ?? input.sourceIssue.id}`,
        `- Run: \`${input.run.id}\``,
        `- Same-run evidence: \`${input.evidence.kind}:${input.evidence.id}\` at ${input.evidence.createdAt.toISOString()}`,
        "- Outcome: false positive; the source issue already reached a terminal disposition from this run.",
      ].join("\n"), { runId: input.run.id });
    }

    // Only resolve the active recovery action if process cleanup is
    // confirmed terminal. Outcomes `termination_sent_still_running` and
    // `failed` mean we may have a zombie local process: marking the
    // recovery as resolved would hide that from operators. The source
    // issue did reach a terminal disposition, so the run/watchdog
    // finalization above is still correct — but the OS-level cleanup
    // concern must remain operator-visible.
    const cleanupConfirmed =
      !cleanup.attempted ||
      cleanup.outcome === "terminated" ||
      cleanup.outcome === "not_running" ||
      cleanup.outcome === "no_process_metadata" ||
      cleanup.outcome === "skipped_non_local_adapter";
    const activeRecoveryAction = await recoveryActionsSvc.getActiveForIssue(input.run.companyId, input.sourceIssue.id);
    if (activeRecoveryAction?.kind === "active_run_watchdog" && cleanupConfirmed) {
      await recoveryActionsSvc.resolveActiveForIssue({
        companyId: input.run.companyId,
        sourceIssueId: input.sourceIssue.id,
        actionId: activeRecoveryAction.id,
        status: "resolved",
        outcome: "false_positive",
        resolutionNote: "Source issue reached a terminal disposition through durable same-run activity; watchdog folded as source-resolved.",
      });
    }

    const [decision] = await db
      .insert(heartbeatRunWatchdogDecisions)
      .values({
        companyId: input.run.companyId,
        runId: input.run.id,
        evaluationIssueId: input.existingEvaluation?.id ?? null,
        decision: "dismissed_false_positive",
        reason: "Source issue already reached a terminal disposition through durable same-run activity.",
        createdByRunId: input.run.id,
      })
      .returning();

    await appendRecoveryRunEvent(finalizedRun, {
      // Promote to warn whenever process cleanup is unconfirmed (not just on
      // hard `failed`): `termination_sent_still_running` is equally operator-
      // visible because a local process may still be alive.
      level: cleanupConfirmed ? "info" : "warn",
      message: cleanupConfirmed
        ? "Source-resolved watchdog fold finalized stale active run"
        : "Source-resolved watchdog fold finalized stale active run; recovery action kept open due to unconfirmed process cleanup",
      payload: resultJson.sourceResolvedWatchdogFold,
    });
    await logActivity(db, {
      companyId: input.run.companyId,
      actorType: "system",
      actorId: "system",
      agentId: input.run.agentId,
      runId: input.run.id,
      action: "heartbeat.output_stale_source_resolved",
      entityType: "heartbeat_run",
      entityId: input.run.id,
      details: {
        source: "recovery.scan_silent_active_runs",
        sourceIssueId: input.sourceIssue.id,
        sourceIssueIdentifier: input.sourceIssue.identifier,
        sourceIssueStatus: input.sourceIssue.status,
        evaluationIssueId: input.existingEvaluation?.id ?? null,
        watchdogDecisionId: decision.id,
        sameRunEvidenceKind: input.evidence.kind,
        sameRunEvidenceId: input.evidence.id,
        sameRunEvidenceAt: input.evidence.createdAt.toISOString(),
        cleanup,
      },
    });
    await finalizeAgentAfterSourceResolvedRun(finalizedRun, finalRunStatus);
    return { kind: "folded" as const, evaluationIssueId: input.existingEvaluation?.id ?? null };
  }

  async function resolveStaleRunOwnerAgentId(input: {
    run: typeof heartbeatRuns.$inferSelect;
    runningAgent: typeof agents.$inferSelect;
    sourceIssue: typeof issues.$inferSelect | null;
  }) {
    const candidateIds: string[] = [];
    if (input.sourceIssue?.assigneeAgentId) {
      const sourceAssignee = await getAgent(input.sourceIssue.assigneeAgentId);
      if (sourceAssignee?.reportsTo) candidateIds.push(sourceAssignee.reportsTo);
    }
    if (input.runningAgent.reportsTo) candidateIds.push(input.runningAgent.reportsTo);
    const roleCandidates = await db
      .select()
      .from(agents)
      .where(and(eq(agents.companyId, input.run.companyId), inArray(agents.role, ["cto", "ceo"])))
      .orderBy(sql`case when ${agents.role} = 'cto' then 0 else 1 end`, asc(agents.createdAt));
    candidateIds.push(...roleCandidates.map((agent) => agent.id));

    const seen = new Set<string>();
    for (const agentId of candidateIds) {
      if (seen.has(agentId)) continue;
      seen.add(agentId);
      const candidate = await getAgent(agentId);
      if (!candidate || candidate.companyId !== input.run.companyId) continue;
      const budgetBlock = await budgets.getInvocationBlock(input.run.companyId, candidate.id, {
        issueId: input.sourceIssue?.id ?? null,
        projectId: input.sourceIssue?.projectId ?? null,
      });
      if ((await isAgentInvokable(candidate)) && !budgetBlock) return candidate.id;
    }

    return null;
  }

  async function collectStaleRunEvidence(input: {
    run: typeof heartbeatRuns.$inferSelect;
    runningAgent: typeof agents.$inferSelect;
    sourceIssue: typeof issues.$inferSelect | null;
    prefix: string;
    now: Date;
  }) {
    const [tail, recentEvents, childIssues, blockers] = await Promise.all([
      readRunLogTailForEvidence(input.run),
      db
        .select({
          eventType: heartbeatRunEvents.eventType,
          level: heartbeatRunEvents.level,
          message: heartbeatRunEvents.message,
          createdAt: heartbeatRunEvents.createdAt,
        })
        .from(heartbeatRunEvents)
        .where(and(eq(heartbeatRunEvents.companyId, input.run.companyId), eq(heartbeatRunEvents.runId, input.run.id)))
        .orderBy(desc(heartbeatRunEvents.id))
        .limit(8),
      input.sourceIssue
        ? db
          .select({ id: issues.id, identifier: issues.identifier, title: issues.title, status: issues.status })
          .from(issues)
          .where(and(eq(issues.companyId, input.run.companyId), eq(issues.parentId, input.sourceIssue.id), visibleIssueCondition()))
          .orderBy(desc(issues.updatedAt))
          .limit(8)
        : Promise.resolve([]),
      input.sourceIssue
        ? db
          .select({ id: issues.id, identifier: issues.identifier, title: issues.title, status: issues.status })
          .from(issueRelations)
          .innerJoin(issues, eq(issueRelations.issueId, issues.id))
          .where(
            and(
              eq(issueRelations.companyId, input.run.companyId),
              eq(issueRelations.relatedIssueId, input.sourceIssue.id),
              eq(issueRelations.type, "blocks"),
            ),
          )
          .limit(8)
        : Promise.resolve([]),
    ]);
    const currentUserRedactionOptions = await getCurrentUserRedactionOptions();
    const safeTail = truncateEvidenceText(redactWatchdogEvidenceText(tail, currentUserRedactionOptions));
    const silenceAgeMs = silenceAgeMsForRun(input.run, input.now);
    return {
      safeTail,
      silenceAgeMs,
      recentEvents: recentEvents.reverse().map((event) => ({
        eventType: event.eventType,
        level: event.level,
        createdAt: event.createdAt.toISOString(),
        message: event.message ? truncateEvidenceText(redactWatchdogEvidenceText(event.message, currentUserRedactionOptions), 300) : null,
      })),
      childIssues,
      blockers,
    };
  }

  function buildStaleRunEvaluationDescription(input: {
    run: typeof heartbeatRuns.$inferSelect;
    runningAgent: typeof agents.$inferSelect;
    sourceIssue: typeof issues.$inferSelect | null;
    prefix: string;
    evidence: Awaited<ReturnType<typeof collectStaleRunEvidence>>;
    level: "suspicious" | "critical";
    now: Date;
  }) {
    const sourceIssue = input.sourceIssue
      ? issueUiLink({ identifier: input.sourceIssue.identifier, id: input.sourceIssue.id }, input.prefix)
      : "none";
    const recentEvents = input.evidence.recentEvents.length > 0
      ? input.evidence.recentEvents.map((event) =>
        `- ${event.createdAt} \`${event.eventType}\`${event.level ? ` ${event.level}` : ""}: ${event.message ?? "(no message)"}`,
      ).join("\n")
      : "- none";
    const childIssues = input.evidence.childIssues.length > 0
      ? input.evidence.childIssues.map((issue) =>
        `- ${issueUiLink({ identifier: issue.identifier, id: issue.id }, input.prefix)} \`${issue.status}\`: ${issue.title}`,
      ).join("\n")
      : "- none detected";
    const blockers = input.evidence.blockers.length > 0
      ? input.evidence.blockers.map((issue) =>
        `- ${issueUiLink({ identifier: issue.identifier, id: issue.id }, input.prefix)} \`${issue.status}\`: ${issue.title}`,
      ).join("\n")
      : "- none detected";
    return [
      `Paperclip detected ${input.level} output silence on an active heartbeat run.`,
      "",
      "## Run",
      "",
      `- Run: ${runUiLink(input.run, input.prefix)}`,
      `- Agent: ${input.runningAgent.name} (${input.runningAgent.adapterType})`,
      `- Invocation: ${input.run.invocationSource}${input.run.triggerDetail ? ` / ${input.run.triggerDetail}` : ""}`,
      `- Source issue: ${sourceIssue}`,
      `- Started at: ${input.run.startedAt?.toISOString() ?? "unknown"}`,
      `- Process started at: ${input.run.processStartedAt?.toISOString() ?? "unknown"}`,
      `- Last output at: ${input.run.lastOutputAt?.toISOString() ?? "none recorded"}`,
      `- Last output sequence: ${input.run.lastOutputSeq ?? 0}`,
      `- Silent for: ${formatDuration(input.evidence.silenceAgeMs)}`,
      `- Thresholds: suspicious after ${formatDuration(ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS)}, critical after ${formatDuration(ACTIVE_RUN_OUTPUT_CRITICAL_THRESHOLD_MS)}`,
      `- Process metadata: pid \`${input.run.processPid ?? "unknown"}\`, process group \`${input.run.processGroupId ?? "unknown"}\`, in-memory handle \`${runningProcesses.has(input.run.id) ? "yes" : "no"}\``,
      "",
      "## Last Output Excerpt",
      "",
      input.evidence.safeTail ? `\`\`\`text\n${input.evidence.safeTail}\n\`\`\`` : "_No run-log tail was available._",
      "",
      "## Recent Run Events",
      "",
      recentEvents,
      "",
      "## Related Work",
      "",
      "Active child issues:",
      childIssues,
      "",
      "Current source blockers:",
      blockers,
      "",
      "## Decision Checklist",
      "",
      "- Continue or snooze if the run is intentionally quiet.",
      "- Ask the run owner for context if work may be delegated outside the transcript.",
      "- Preserve artifacts, branch state, and useful output before cancellation.",
      "- Cancel or recover through the explicit run recovery controls when authorized.",
      "- Close this issue as a false positive only after recording the reason.",
    ].join("\n");
  }

  function isUniqueStaleRunEvaluationConflict(error: unknown) {
    const maybe = unwrapDatabaseConflictError(error);
    if (!maybe) return false;
    return maybe.code === "23505" &&
      (
        maybe.constraint === "issues_active_stale_run_evaluation_uq" ||
        maybe.constraint_name === "issues_active_stale_run_evaluation_uq" ||
        typeof maybe.message === "string" && maybe.message.includes("issues_active_stale_run_evaluation_uq")
      );
  }

  function isUniqueStrandedIssueRecoveryConflict(error: unknown) {
    const maybe = unwrapDatabaseConflictError(error);
    if (!maybe) return false;
    return maybe.code === "23505" &&
      (
        maybe.constraint === "issues_active_stranded_issue_recovery_uq" ||
        maybe.constraint_name === "issues_active_stranded_issue_recovery_uq" ||
        typeof maybe.message === "string" && maybe.message.includes("issues_active_stranded_issue_recovery_uq")
      );
  }

  async function ensureSourceIssueCommentedForStaleEvaluation(input: {
    sourceIssue: typeof issues.$inferSelect | null;
    evaluationIssue: { id: string; identifier: string | null };
    run: typeof heartbeatRuns.$inferSelect;
  }) {
    if (!input.sourceIssue || ["done", "cancelled"].includes(input.sourceIssue.status)) return false;
    // Idempotency guard: if we've already emitted the escalation comment for this
    // (sourceIssue, evaluationIssue) pair, skip. Without this, every subsequent scan
    // cycle while the evaluation issue is still open re-fires the comment and spams
    // the source-issue thread. The activity log row written below is the persistence
    // record we check against — a single row per pair is enough to suppress repeats
    // even after process restarts.
    const [priorEscalation] = await db
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.companyId, input.sourceIssue.companyId),
          eq(activityLog.action, "heartbeat.output_stale_escalated"),
          eq(activityLog.entityType, "issue"),
          eq(activityLog.entityId, input.sourceIssue.id),
          sql`${activityLog.details} ->> 'evaluationIssueId' = ${input.evaluationIssue.id}`,
        ),
      )
      .limit(1);
    if (priorEscalation) return false;
    // Evaluation issues are observability-only — do NOT add them to blockedByIssueIds.
    // They are already parented under the source issue. Adding them as hard blockers
    // creates a self-amplifying loop: block → silence → new alert → block again.
    await issuesSvc.addComment(input.sourceIssue.id, [
      "Paperclip detected critical output silence on this issue's active run.",
      "",
      `- Evaluation issue: ${input.evaluationIssue.identifier ?? input.evaluationIssue.id}`,
      `- Run: \`${input.run.id}\``,
      "",
      "Review the evaluation issue above. The active run has not been cancelled.",
    ].join("\n"), { runId: input.run.id });
    await logActivity(db, {
      companyId: input.sourceIssue.companyId,
      actorType: "system",
      actorId: "system",
      agentId: null,
      runId: input.run.id,
      action: "heartbeat.output_stale_escalated",
      entityType: "issue",
      entityId: input.sourceIssue.id,
      details: {
        source: "recovery.scan_silent_active_runs",
        evaluationIssueId: input.evaluationIssue.id,
      },
    });
    return true;
  }

  // PEN-2106: the BLO-4467 wedge is an EXTERNAL-LIFECYCLE story — a pod/Job died
  // while its run row stayed `running`, and because external-lifecycle agents are
  // clamped to one concurrent run, that row holds the agent's only slot until it
  // is reaped. None of that holds on a sessioned-local adapter: there is no pod
  // and no Job, and `runningCount` already excludes rows silent past
  // RUN_STALE_SILENCE_MS, so a multi-hour-silent row contributes 0 to
  // concurrency and holds no lock. Asserting the k8s mechanism there sends the
  // reader after a pod that does not exist and invites a cancel to "free" a lock
  // nothing is holding. Both the reopen remedy and the suppression note render
  // through here so the two can't drift apart.
  function staleRunOrphanedRowRemedy(adapterType: string) {
    if (RECOVERY_EXTERNAL_LIFECYCLE_ADAPTER_TYPES.has(adapterType)) {
      return {
        mechanism: "the canonical BLO-4467-family wedge (pod already reaped)",
        remedy:
          "Likely the canonical BLO-4467-family wedge: the run row is `running` but the pod/Job is gone. Force-finish the run (reaper) so the agent's concurrency lock releases — do not just re-close this wrapper.",
      };
    }
    return {
      mechanism: `an orphaned \`running\` row on \`${adapterType}\`, which has no external runtime lifecycle`,
      remedy:
        `\`${adapterType}\` has no external runtime lifecycle, so the BLO-4467 wedge does not apply: there is no external workload to force-finish, and a run silent this long is already excluded from the agent's concurrency accounting, so terminating it frees no capacity. The row is simply orphaned \`running\`. The only route to terminal is \`POST /heartbeat-runs/:runId/cancel\`, which is board-gated — an agent assignee cannot perform it, so escalate to the board rather than re-closing this wrapper.`,
    };
  }

  // BLO-7113: reopen the most-recent closed wrapper to `in_progress` and ping
  // its owner (the resolved manager/CTO) instead of opening wrapper #N+1.
  // Once reopened, subsequent detector sweeps find an OPEN wrapper via
  // findOpenStaleRunEvaluation and return `existing`, so this is self-limiting:
  // exactly one wrapper carries the wedge forward for an operator to action.
  async function escalateStaleRunRefire(input: {
    run: typeof heartbeatRuns.$inferSelect;
    runningAgent: typeof agents.$inferSelect;
    sourceIssue: typeof issues.$inferSelect | null;
    closedEvaluation: NonNullable<Awaited<ReturnType<typeof findRecentClosedStaleRunEvaluation>>>;
    priorRefires: number;
    now: Date;
  }) {
    const ownerAgentId =
      input.closedEvaluation.assigneeAgentId ??
      (await resolveStaleRunOwnerAgentId({
        run: input.run,
        runningAgent: input.runningAgent,
        sourceIssue: input.sourceIssue,
      }));
    const [reopened] = await db
      .update(issues)
      .set({
        status: "in_progress",
        startedAt: input.now,
        completedAt: null,
        cancelledAt: null,
        assigneeAgentId: ownerAgentId ?? input.closedEvaluation.assigneeAgentId ?? null,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(issues.id, input.closedEvaluation.id),
          eq(issues.companyId, input.run.companyId),
          eq(issues.originKind, STALE_ACTIVE_RUN_EVALUATION_ORIGIN_KIND),
          isNull(issues.hiddenAt),
          inArray(issues.status, ["done", "cancelled"]),
        ),
      )
      .returning({ id: issues.id, identifier: issues.identifier });
    // Lost the race (a concurrent sweep already reopened, or an operator
    // touched it). Treat the now-open wrapper as the canonical artifact.
    if (!reopened) return { kind: "existing" as const, evaluationIssueId: input.closedEvaluation.id };

    await issuesSvc.addComment(
      reopened.id,
      [
        "## Re-fire escalation — reopening instead of opening a new wrapper",
        "",
        `The \`stale_active_run_evaluation\` detector has now fired ${input.priorRefires + 1} times for run \`${input.run.id}\` (${input.runningAgent.name}) since this wrapper was closed, all inside a ${formatDuration(STALE_ACTIVE_RUN_EVALUATION_ESCALATION_WINDOW_MS)} window.`,
        `That is past the ${STALE_ACTIVE_RUN_EVALUATION_ESCALATION_THRESHOLD}-suppressed-fire threshold, so the underlying \`running\` run row is NOT draining on its own — closing this wrapper as a false-positive is no longer the right disposition.`,
        "",
        "- This wrapper has been reopened to `in_progress` rather than spawning yet another duplicate review.",
        `- ${staleRunOrphanedRowRemedy(input.runningAgent.adapterType).remedy}`,
        "- Refs: BLO-4467 (completed-run-not-reaped), BLO-7113 (this dedupe).",
      ].join("\n"),
      { runId: input.run.id },
    );
    await logActivity(db, {
      companyId: input.run.companyId,
      actorType: "system",
      actorId: "system",
      agentId: ownerAgentId,
      runId: input.run.id,
      action: "heartbeat.output_stale_refire_escalated",
      entityType: "issue",
      entityId: reopened.id,
      details: {
        source: "recovery.scan_silent_active_runs",
        evaluationIssueId: reopened.id,
        priorRefires: input.priorRefires,
        escalationThreshold: STALE_ACTIVE_RUN_EVALUATION_ESCALATION_THRESHOLD,
        escalationWindowMs: STALE_ACTIVE_RUN_EVALUATION_ESCALATION_WINDOW_MS,
      },
    });
    if (ownerAgentId) {
      await deps.enqueueWakeup(ownerAgentId, {
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: withRecoveryModelProfileHint(
          { issueId: reopened.id, staleRunId: input.run.id, sourceIssueId: input.sourceIssue?.id ?? null },
          "status_only",
        ),
        requestedByActorType: "system",
        requestedByActorId: null,
        contextSnapshot: withRecoveryModelProfileHint(
          {
            issueId: reopened.id,
            taskId: reopened.id,
            wakeReason: "issue_assigned",
            source: STALE_ACTIVE_RUN_EVALUATION_ORIGIN_KIND,
            staleRunId: input.run.id,
            sourceIssueId: input.sourceIssue?.id ?? null,
          },
          "status_only",
        ),
      });
    }
    return { kind: "reopened" as const, evaluationIssueId: reopened.id };
  }

  // BLO-7113: the run is silent and there's no OPEN wrapper, but a wrapper for
  // the SAME run was just closed within the cooldown. Don't open a fresh
  // wrapper — record a running tally on the closed one, and once the tally
  // crosses the threshold, escalate by reopening (see escalateStaleRunRefire).
  async function suppressOrEscalateStaleRunRefire(input: {
    run: typeof heartbeatRuns.$inferSelect;
    runningAgent: typeof agents.$inferSelect;
    sourceIssue: typeof issues.$inferSelect | null;
    closedEvaluation: NonNullable<Awaited<ReturnType<typeof findRecentClosedStaleRunEvaluation>>>;
    now: Date;
  }) {
    const windowStart = new Date(input.now.getTime() - STALE_ACTIVE_RUN_EVALUATION_ESCALATION_WINDOW_MS);
    const priorRefires = await countRecentStaleRunRefireComments(input.closedEvaluation.id, windowStart);

    if (priorRefires >= STALE_ACTIVE_RUN_EVALUATION_ESCALATION_THRESHOLD) {
      return escalateStaleRunRefire({
        run: input.run,
        runningAgent: input.runningAgent,
        sourceIssue: input.sourceIssue,
        closedEvaluation: input.closedEvaluation,
        priorRefires,
        now: input.now,
      });
    }

    const fireOrdinal = priorRefires + 1;
    await issuesSvc.addComment(
      input.closedEvaluation.id,
      [
        `${STALE_ACTIVE_RUN_EVALUATION_REFIRE_COMMENT_MARKER} (${fireOrdinal} suppressed re-fire${fireOrdinal === 1 ? "" : "s"} in the last ${formatDuration(STALE_ACTIVE_RUN_EVALUATION_ESCALATION_WINDOW_MS)})`,
        "",
        `The \`stale_active_run_evaluation\` detector fired again for run \`${input.run.id}\` (${input.runningAgent.name}), but ${input.closedEvaluation.identifier} was already closed \`${input.closedEvaluation.status}\` within the last ${formatDuration(STALE_ACTIVE_RUN_EVALUATION_REFIRE_COOLDOWN_MS)}.`,
        `Suppressing a fresh wrapper: the orphaned \`running\` row is ${staleRunOrphanedRowRemedy(input.runningAgent.adapterType).mechanism}, so re-opening a new review every ~10-15 min would only burn a triage slot.`,
        `- After ${STALE_ACTIVE_RUN_EVALUATION_ESCALATION_THRESHOLD} suppressed re-fires in ${formatDuration(STALE_ACTIVE_RUN_EVALUATION_ESCALATION_WINDOW_MS)} this wrapper is reopened to \`in_progress\` instead of opening wrapper #${fireOrdinal + 1}.`,
      ].join("\n"),
      { runId: input.run.id },
    );
    await logActivity(db, {
      companyId: input.run.companyId,
      actorType: "system",
      actorId: "system",
      agentId: input.run.agentId,
      runId: input.run.id,
      action: "heartbeat.output_stale_refire_suppressed",
      entityType: "issue",
      entityId: input.closedEvaluation.id,
      details: {
        source: "recovery.scan_silent_active_runs",
        evaluationIssueId: input.closedEvaluation.id,
        closedStatus: input.closedEvaluation.status,
        suppressedRefireCount: fireOrdinal,
        cooldownMs: STALE_ACTIVE_RUN_EVALUATION_REFIRE_COOLDOWN_MS,
      },
    });
    return { kind: "suppressed" as const, evaluationIssueId: input.closedEvaluation.id };
  }

  async function createOrUpdateStaleRunEvaluation(input: {
    run: typeof heartbeatRuns.$inferSelect;
    now: Date;
  }) {
    const runningAgent = await getAgent(input.run.agentId);
    if (!runningAgent || runningAgent.companyId !== input.run.companyId) return { kind: "skipped" as const };
    const sourceIssue = await resolveStaleRunSourceIssue(input.run);
    if (sourceIssue && sourceIssue.status === "blocked") {
      return { kind: "skipped" as const };
    }
    const existing = await findOpenStaleRunEvaluation(input.run.companyId, input.run.id);
    if (sourceIssue && isRecoveryOriginIssue(sourceIssue)) {
      await logActivity(db, {
        companyId: input.run.companyId,
        actorType: "system",
        actorId: "system",
        agentId: input.run.agentId,
        runId: input.run.id,
        action: "heartbeat.output_stale_recovery_recursion_refused",
        entityType: "heartbeat_run",
        entityId: input.run.id,
        details: {
          source: "recovery.scan_silent_active_runs",
          sourceIssueId: sourceIssue.id,
          sourceIssueIdentifier: sourceIssue.identifier,
          sourceIssueOriginKind: sourceIssue.originKind,
          existingEvaluationIssueId: existing?.id ?? null,
        },
      });
      return { kind: "skipped" as const };
    }
    const silenceStartedAt = silenceStartedAtForRun(input.run);
    if (sourceIssue && isTerminalIssueStatus(sourceIssue.status)) {
      const terminalEvidence = await latestSameRunSourceTerminalEvidence({
        run: input.run,
        sourceIssue,
        evidenceAfter: silenceStartedAt,
      });
      if (terminalEvidence) {
        return foldSourceResolvedStaleRun({
          run: input.run,
          runningAgent,
          sourceIssue,
          evidence: terminalEvidence,
          existingEvaluation: existing,
          silenceStartedAt,
          silenceAgeMs: silenceAgeMsForRun(input.run, input.now),
          now: input.now,
        });
      }
    }

    // Idle output is expected when the source issue is blocked — skip ticket creation entirely.
    if (sourceIssue?.status === "blocked") return { kind: "skipped" as const };

    // Dedup: if a reviewer has dismissed this run's silence as a false positive, don't re-file.
    // A "continue" decision with a snooze window is allowed to re-arm normally — only an
    // explicit dismissed_false_positive blocks all further alerts for this run.
    if (await hasDismissedFalsePositiveDecision(input.run.companyId, input.run.id)) {
      return { kind: "skipped" as const };
    }

    const prefix = await getCompanyIssuePrefix(input.run.companyId);
    const evidence = await collectStaleRunEvidence({
      run: input.run,
      runningAgent,
      sourceIssue,
      prefix,
      now: input.now,
    });
    const level = (evidence.silenceAgeMs ?? 0) >= ACTIVE_RUN_OUTPUT_CRITICAL_THRESHOLD_MS ? "critical" : "suspicious";
    if (existing) {
      if (level === "critical" && existing.priority !== "high") {
        await issuesSvc.update(existing.id, {
          priority: "high",
        });
        await issuesSvc.addComment(existing.id, [
          "Critical output silence threshold crossed.",
          "",
          `- Run: \`${input.run.id}\``,
          `- Silent for: ${formatDuration(evidence.silenceAgeMs)}`,
          `- Last output at: ${input.run.lastOutputAt?.toISOString() ?? "none recorded"}`,
        ].join("\n"), { runId: input.run.id });
        await ensureSourceIssueCommentedForStaleEvaluation({
          sourceIssue,
          evaluationIssue: existing,
          run: input.run,
        });
        return { kind: "escalated" as const, evaluationIssueId: existing.id };
      }
      if (level === "critical") {
        await ensureSourceIssueCommentedForStaleEvaluation({
          sourceIssue,
          evaluationIssue: existing,
          run: input.run,
        });
      }
      return { kind: "existing" as const, evaluationIssueId: existing.id };
    }

    // BLO-7113: no OPEN wrapper, but if one for this same run was closed within
    // the cooldown, suppress a fresh wrapper (the re-fire-on-reaped-row noise
    // mode) and tally it instead — escalating by reopen after the threshold.
    const recentlyClosed = await findRecentClosedStaleRunEvaluation(input.run.companyId, input.run.id, input.now);
    if (recentlyClosed) {
      // Defer to the continue/re-arm mechanism when the agent explicitly chose
      // to keep watching — that path is meant to re-create after its window.
      const cooldownSince = new Date(input.now.getTime() - STALE_ACTIVE_RUN_EVALUATION_REFIRE_COOLDOWN_MS);
      const rearmed = await hasRecentStaleRunWatchdogDecision(input.run.companyId, input.run.id, cooldownSince);
      if (!rearmed) {
        return suppressOrEscalateStaleRunRefire({
          run: input.run,
          runningAgent,
          sourceIssue,
          closedEvaluation: recentlyClosed,
          now: input.now,
        });
      }
    }

    const ownerAgentId = await resolveStaleRunOwnerAgentId({ run: input.run, runningAgent, sourceIssue });
    const description = buildStaleRunEvaluationDescription({
      run: input.run,
      runningAgent,
      sourceIssue,
      prefix,
      evidence,
      level,
      now: input.now,
    });
    let evaluation: Awaited<ReturnType<typeof issuesSvc.create>>;
    try {
      evaluation = await issuesSvc.create(input.run.companyId, {
        title: `Review silent active run for ${runningAgent.name}`,
        description,
        status: "todo",
        priority: level === "critical" ? "high" : "medium",
        parentId: sourceIssue && !["done", "cancelled"].includes(sourceIssue.status) ? sourceIssue.id : null,
        projectId: sourceIssue?.projectId ?? null,
        goalId: sourceIssue?.goalId ?? null,
        billingCode: sourceIssue?.billingCode ?? null,
        assigneeAgentId: ownerAgentId,
        assigneeAdapterOverrides: recoveryAssigneeAdapterOverrides("status_only"),
        originKind: STALE_ACTIVE_RUN_EVALUATION_ORIGIN_KIND,
        originId: input.run.id,
        originRunId: input.run.id,
        originFingerprint: staleActiveRunOriginFingerprint(input.run.companyId, input.run.id),
      });
    } catch (error) {
      if (!isUniqueStaleRunEvaluationConflict(error)) throw error;
      const raced = await findOpenStaleRunEvaluation(input.run.companyId, input.run.id);
      if (!raced) throw error;
      return { kind: "existing" as const, evaluationIssueId: raced.id };
    }

    await logActivity(db, {
      companyId: input.run.companyId,
      actorType: "system",
      actorId: "system",
      agentId: ownerAgentId,
      runId: input.run.id,
      action: "heartbeat.output_stale_detected",
      entityType: "issue",
      entityId: evaluation.id,
      details: {
        source: "recovery.scan_silent_active_runs",
        level,
        sourceIssueId: sourceIssue?.id ?? null,
        silenceAgeMs: evidence.silenceAgeMs,
        lastOutputAt: input.run.lastOutputAt?.toISOString() ?? null,
      },
    });
    if (level === "critical") {
      await ensureSourceIssueCommentedForStaleEvaluation({
        sourceIssue,
        evaluationIssue: evaluation,
        run: input.run,
      });
    }
    if (ownerAgentId) {
      await deps.enqueueWakeup(ownerAgentId, {
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: withRecoveryModelProfileHint({
          issueId: evaluation.id,
          staleRunId: input.run.id,
          sourceIssueId: sourceIssue?.id ?? null,
        }, "status_only"),
        requestedByActorType: "system",
        requestedByActorId: null,
        contextSnapshot: withRecoveryModelProfileHint({
          issueId: evaluation.id,
          taskId: evaluation.id,
          wakeReason: "issue_assigned",
          source: STALE_ACTIVE_RUN_EVALUATION_ORIGIN_KIND,
          staleRunId: input.run.id,
          sourceIssueId: sourceIssue?.id ?? null,
        }, "status_only"),
      });
    }
    return { kind: "created" as const, evaluationIssueId: evaluation.id };
  }

  async function scanSilentActiveRuns(opts?: { now?: Date; companyId?: string; issueCreatedAtGte?: Date | null }) {
    const now = opts?.now ?? new Date();
    const suspicionBefore = new Date(now.getTime() - ACTIVE_RUN_OUTPUT_SUSPICION_THRESHOLD_MS);
    let candidates = await db
      .select()
      .from(heartbeatRuns)
      .where(
        and(
          opts?.companyId ? eq(heartbeatRuns.companyId, opts.companyId) : undefined,
          eq(heartbeatRuns.status, "running"),
          sql`coalesce(
            case when ${heartbeatRuns.lastOutputAt} is not null or ${heartbeatRuns.lastUsefulActionAt} is not null then
              greatest(
                coalesce(${heartbeatRuns.lastOutputAt}, 'epoch'::timestamptz),
                coalesce(${heartbeatRuns.lastUsefulActionAt}, 'epoch'::timestamptz)
              )
            end,
            ${heartbeatRuns.processStartedAt},
            ${heartbeatRuns.startedAt},
            ${heartbeatRuns.createdAt}
          ) <= ${suspicionBefore.toISOString()}::timestamptz`,
          // Exclude lifecycle markers and adapter invocations; only flag on meaningful tool/log output.
          sql`not exists (
            select 1
            from ${heartbeatRunEvents}
            where ${heartbeatRunEvents.companyId} = ${heartbeatRuns.companyId}
              and ${heartbeatRunEvents.runId} = ${heartbeatRuns.id}
              and ${heartbeatRunEvents.eventType} not in ('lifecycle', 'adapter.invoke', 'error')
              and ${heartbeatRunEvents.createdAt} > ${suspicionBefore.toISOString()}::timestamptz
          )`,
        ),
      )
      .orderBy(asc(heartbeatRuns.createdAt))
      .limit(100);

    if (opts?.issueCreatedAtGte) {
      const issueIds = [...new Set(candidates.flatMap((run) => {
        const context = parseObject(run.contextSnapshot);
        const issueId = context.issueId ?? context.taskId;
        return typeof issueId === "string" && issueId.length > 0 ? [issueId] : [];
      }))];
      const eligibleIssueIds = new Set(
        issueIds.length > 0
          ? (await db.select({ id: issues.id }).from(issues).where(and(
              inArray(issues.id, issueIds),
              gte(issues.createdAt, opts.issueCreatedAtGte),
            ))).map((issue) => issue.id)
          : [],
      );
      candidates = candidates.filter((run) => {
        const context = parseObject(run.contextSnapshot);
        const issueId = context.issueId ?? context.taskId;
        return typeof issueId === "string" && eligibleIssueIds.has(issueId);
      });
    }

    const result = {
      scanned: candidates.length,
      created: 0,
      existing: 0,
      escalated: 0,
      folded: 0,
      snoozed: 0,
      suppressed: 0,
      reopened: 0,
      skipped: 0,
      evaluationIssueIds: [] as string[],
    };

    for (const run of candidates) {
      if (await latestActiveOutputQuietUntilDecision(run.companyId, run.id, now)) {
        result.snoozed += 1;
        continue;
      }
      const outcome = await createOrUpdateStaleRunEvaluation({ run, now });
      if (outcome.kind === "created") result.created += 1;
      else if (outcome.kind === "existing") result.existing += 1;
      else if (outcome.kind === "escalated") result.escalated += 1;
      else if (outcome.kind === "folded") result.folded += 1;
      else if (outcome.kind === "suppressed") result.suppressed += 1;
      else if (outcome.kind === "reopened") result.reopened += 1;
      else result.skipped += 1;
      if ("evaluationIssueId" in outcome && outcome.evaluationIssueId) {
        result.evaluationIssueIds.push(outcome.evaluationIssueId);
      }
    }

    return result;
  }

  async function recordWatchdogDecision(input: {
    runId: string;
    actor: WatchdogDecisionActor;
    decision: "snooze" | "continue" | "dismissed_false_positive";
    evaluationIssueId?: string | null;
    reason?: string | null;
    snoozedUntil?: Date | null;
    createdByRunId?: string | null;
    now?: Date;
  }) {
    const [run] = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, input.runId))
      .limit(1);
    if (!run) throw notFound("Heartbeat run not found");

    let evaluationIssue: {
      id: string;
      assigneeAgentId: string | null;
      companyId: string;
      originKind: string;
      originId: string | null;
      hiddenAt: Date | null;
      status: string;
    } | null = null;
    if (input.evaluationIssueId) {
      evaluationIssue = await db
        .select({
          id: issues.id,
          assigneeAgentId: issues.assigneeAgentId,
          companyId: issues.companyId,
          originKind: issues.originKind,
          originId: issues.originId,
          hiddenAt: issues.hiddenAt,
          status: issues.status,
        })
        .from(issues)
        .where(and(eq(issues.id, input.evaluationIssueId), eq(issues.companyId, run.companyId)))
        .then((rows) => rows[0] ?? null);
      if (!evaluationIssue) throw notFound("Evaluation issue not found");
    }

    const boardActor = input.actor.type === "board";
    const assignedRecoveryOwner =
      input.actor.type === "agent" &&
      Boolean(input.actor.agentId) &&
      evaluationIssue !== null &&
      evaluationIssue.originKind === STALE_ACTIVE_RUN_EVALUATION_ORIGIN_KIND &&
      evaluationIssue.originId === run.id &&
      evaluationIssue.hiddenAt === null &&
      !["done", "cancelled"].includes(evaluationIssue.status) &&
      evaluationIssue?.assigneeAgentId === input.actor.agentId;
    if (!boardActor && !assignedRecoveryOwner) {
      throw forbidden("Only the board or the assigned recovery owner can record watchdog decisions");
    }

    if (evaluationIssue && (
      evaluationIssue.originKind !== STALE_ACTIVE_RUN_EVALUATION_ORIGIN_KIND ||
      evaluationIssue.originId !== run.id
    )) {
      throw forbidden("Watchdog decision evaluation issue is not bound to the target run");
    }

    if (input.actor.type === "agent" && !evaluationIssue) {
      throw forbidden("Agent watchdog decisions require the target evaluation issue");
    }

    const createdByRunId = input.actor.type === "agent"
      ? input.actor.runId ?? input.createdByRunId ?? null
      : input.actor.type === "board"
        ? input.actor.runId ?? input.createdByRunId ?? null
        : null;
    if (createdByRunId) {
      const [creatorRun] = await db
        .select({ id: heartbeatRuns.id, companyId: heartbeatRuns.companyId, agentId: heartbeatRuns.agentId })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, createdByRunId))
        .limit(1);
      const sameCompany = creatorRun?.companyId === run.companyId;
      const sameAgent = input.actor.type !== "agent" || creatorRun?.agentId === input.actor.agentId;
      if (!creatorRun || !sameCompany || !sameAgent) {
        throw forbidden("createdByRunId is not valid for this watchdog decision actor");
      }
    }

    const decisionNow = input.now ?? new Date();
    const effectiveSnoozedUntil = input.decision === "snooze"
      ? input.snoozedUntil ?? null
      : input.decision === "continue"
        ? input.snoozedUntil && input.snoozedUntil > decisionNow
          ? input.snoozedUntil
          : new Date(decisionNow.getTime() + ACTIVE_RUN_OUTPUT_CONTINUE_REARM_MS)
        : null;

    const [row] = await db
      .insert(heartbeatRunWatchdogDecisions)
      .values({
        companyId: run.companyId,
        runId: run.id,
        evaluationIssueId: input.evaluationIssueId ?? null,
        decision: input.decision,
        snoozedUntil: effectiveSnoozedUntil,
        reason: input.reason ?? null,
        createdByAgentId: input.actor.type === "agent" ? input.actor.agentId ?? null : null,
        createdByUserId: input.actor.type === "board" ? input.actor.userId ?? null : null,
        createdByRunId,
      })
      .returning();

    await logActivity(db, {
      companyId: run.companyId,
      actorType: input.actor.type === "agent" ? "agent" : "user",
      actorId: input.actor.type === "agent"
        ? input.actor.agentId ?? "agent"
        : input.actor.type === "board"
          ? input.actor.userId ?? "board"
          : "unknown",
      agentId: input.actor.type === "agent" ? input.actor.agentId ?? null : null,
      runId: run.id,
      action: input.decision === "snooze" ? "heartbeat.watchdog_snoozed" : "heartbeat.watchdog_decision_recorded",
      entityType: "heartbeat_run",
      entityId: run.id,
      details: {
        source: "recovery.record_watchdog_decision",
        decision: input.decision,
        evaluationIssueId: input.evaluationIssueId ?? null,
        snoozedUntil: effectiveSnoozedUntil?.toISOString() ?? null,
        reason: input.reason ?? null,
      },
    });

    return row;
  }

  async function findOpenStrandedIssueRecoveryIssue(companyId: string, sourceIssueId: string) {
    return db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, STRANDED_ISSUE_RECOVERY_ORIGIN_KIND),
          eq(issues.originId, sourceIssueId),
          visibleIssueCondition(),
          notInArray(issues.status, ["done", "cancelled"]),
        ),
      )
      .orderBy(desc(issues.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  // Cooldown after a stranded-recovery issue closes before another can fire
  // for the same source. The active-recovery uniqueness index prevents
  // *concurrent* duplicates but doesn't prevent *sequential* re-firing —
  // BLO-3182 spawned 9 separate recoveries over 4 days, each marked done
  // without changing assignment/status, then re-detected as stranded on the
  // next sweep. The recovery agent's "no-op succeeded" runs aren't enough
  // signal on their own to break the loop. Cooldown gives the operator (or
  // the recovery agent on its next chance) breathing room to take a non-
  // automatic action — a manual reassignment, a hold, or marking blocked —
  // before the sweep papers over the underlying problem with another
  // identical recovery.
  //
  // 6 hours: short enough that genuinely transient stranding (e.g. agent
  // pod crash that the harness recovers from) gets a follow-up recovery
  // within one shift; long enough that a CEO/manual hold has time to
  // propagate before the sweep re-fires.
  const STRANDED_ISSUE_RECOVERY_COOLDOWN_MS = 6 * 60 * 60 * 1000;

  async function findRecentClosedStrandedIssueRecoveryIssue(
    companyId: string,
    sourceIssueId: string,
    now: Date,
  ) {
    const cutoff = new Date(now.getTime() - STRANDED_ISSUE_RECOVERY_COOLDOWN_MS);
    return db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, STRANDED_ISSUE_RECOVERY_ORIGIN_KIND),
          eq(issues.originId, sourceIssueId),
          isNull(issues.hiddenAt),
          inArray(issues.status, ["done", "cancelled"]),
          gt(issues.updatedAt, cutoff),
        ),
      )
      .orderBy(desc(issues.updatedAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  function isStrandedIssueRecoveryIssue(issue: typeof issues.$inferSelect) {
    return issue.originKind === STRANDED_ISSUE_RECOVERY_ORIGIN_KIND;
  }

  async function buildNestedStrandedRecoveryLine(issue: typeof issues.$inferSelect, prefix: string) {
    const sourceIssueId = readNonEmptyString(issue.originId);
    const sourceIssue = sourceIssueId
      ? await db
        .select({ id: issues.id, identifier: issues.identifier })
        .from(issues)
        .where(and(eq(issues.companyId, issue.companyId), eq(issues.id, sourceIssueId)))
        .then((rows) => rows[0] ?? null)
      : null;
    const sourceLine = sourceIssue
      ? `- Original source issue: ${issueUiLink(sourceIssue, prefix)}`
      : sourceIssueId
        ? `- Original source issue: \`${sourceIssueId}\``
        : "- Original source issue: unknown";

    return [
      "",
      "- Nested recovery: suppressed because this issue is already a `stranded_issue_recovery` issue.",
      sourceLine,
      "- Next action: the assigned recovery owner or board operator should fix the runtime/adapter problem, resolve or reassign the original source issue, then mark this recovery issue done or cancelled.",
    ].join("\n");
  }

  async function resolveStrandedIssueRecoveryOwnerAgentId(
    issue: typeof issues.$inferSelect,
    preferredOwnerAgentId?: string | null,
  ) {
    const candidateIds: string[] = [];
    if (preferredOwnerAgentId) candidateIds.push(preferredOwnerAgentId);
    if (issue.assigneeAgentId) {
      const assignee = await getAgent(issue.assigneeAgentId);
      if (assignee?.reportsTo) candidateIds.push(assignee.reportsTo);
    }
    if (issue.createdByAgentId) {
      const creator = await getAgent(issue.createdByAgentId);
      if (creator?.reportsTo) candidateIds.push(creator.reportsTo);
      candidateIds.push(issue.createdByAgentId);
    }

    const roleCandidates = await db
      .select()
      .from(agents)
      .where(and(eq(agents.companyId, issue.companyId), inArray(agents.role, ["cto", "ceo"])))
      .orderBy(sql`case when ${agents.role} = 'cto' then 0 else 1 end`, asc(agents.createdAt));
    candidateIds.push(...roleCandidates.map((agent) => agent.id));
    if (issue.assigneeAgentId) candidateIds.push(issue.assigneeAgentId);

    const seen = new Set<string>();
    for (const agentId of candidateIds) {
      if (seen.has(agentId)) continue;
      seen.add(agentId);
      const candidate = await getAgent(agentId);
      if (!candidate || candidate.companyId !== issue.companyId) continue;
      const budgetBlock = await budgets.getInvocationBlock(issue.companyId, candidate.id, {
        issueId: issue.id,
        projectId: issue.projectId,
      });
      if ((await isAgentInvokable(candidate)) && !budgetBlock) return candidate.id;
    }

    return null;
  }

  async function resolveInvokableRecoveryAgentId(
    issue: typeof issues.$inferSelect,
    agentId: string | null | undefined,
  ) {
    if (!agentId) return null;
    const candidate = await getAgent(agentId);
    if (!candidate || candidate.companyId !== issue.companyId) return null;
    const budgetBlock = await budgets.getInvocationBlock(issue.companyId, candidate.id, {
      issueId: issue.id,
      projectId: issue.projectId,
    });
    return (await isAgentInvokable(candidate)) && !budgetBlock ? candidate.id : null;
  }

  async function resolveStrandedRecoveryRouting(input: {
    issue: typeof issues.$inferSelect;
    latestRun: LatestIssueRun;
    recoveryCause: StrandedRecoveryCause;
    preferredOwnerAgentId?: string | null;
    existingReturnOwnerAgentId?: string | null;
    existingOwnerAgentId?: string | null;
  }) {
    // `originalAgentId` intentionally keeps `latestRun.agentId` as the first candidate:
    // `provider_quota` retries need the agent who actually hit the quota, which can
    // diverge from `issue.assigneeAgentId` once THIS function has already escalated
    // ownership to the manager on an earlier sweep — conflating "current assignee" with
    // "the quota-hit run's agent" would retry the manager against a quota that was never
    // theirs. `returnOwnerAgentId` below (used by the `routeToOriginal` re-dispatch causes)
    // wants the opposite priority.
    const originalAgentId = input.latestRun?.agentId ?? input.issue.assigneeAgentId;
    // BLO-20933: prefer the issue's lock-fresh current assignee over the failed run's
    // `agentId`. The two diverge whenever the issue was reassigned after that run started
    // (or the run predates the current assignment) — routing back to a stale run-agent
    // would hand the re-dispatch to someone who is no longer the owner.
    //
    // The recorded return owner is pinned ONLY when the current assignee is this
    // subsystem's own escalation artifact. Once a prior sweep transferred ownership, it
    // also wrote that owner onto the issue (`assigneeAgentId: action.ownerAgentId` below),
    // so `assignee === existingOwnerAgentId` identifies an assignment WE manufactured —
    // there the recorded return owner is the durable truth and reusing the assignee would
    // make the manager the return owner and lose the original assignee permanently.
    //
    // When the assignee is anyone else, a third party genuinely reassigned the issue after
    // the escalation, and that decision outranks our record. Pinning unconditionally here
    // silently reverted such a reassignment from the second sweep onward — a laundering bug
    // inside the laundering fix, re-introducing exactly the misrouting this issue exists to
    // kill. `existingOwnerAgentId ?? existingReturnOwnerAgentId` is the comparison basis so
    // that owner-less actions (a `provider_quota` wait records only a return owner) are
    // still measured against the owner they effectively named.
    const priorRecoveryOwnerAgentId = input.existingOwnerAgentId ??
      input.existingReturnOwnerAgentId ??
      null;
    const assigneeSupersedesRecoveryOwner = input.issue.assigneeAgentId != null &&
      priorRecoveryOwnerAgentId != null &&
      input.issue.assigneeAgentId !== priorRecoveryOwnerAgentId;
    const returnOwnerAgentId =
      (assigneeSupersedesRecoveryOwner ? null : input.existingReturnOwnerAgentId) ??
      input.issue.assigneeAgentId ??
      originalAgentId;
    const routeToOriginal = input.recoveryCause === "process_lost" ||
      input.recoveryCause === SUCCESSFUL_RUN_MISSING_STATE_REASON ||
      input.recoveryCause === "codex_output_inactivity_monitor" ||
      // BLO-20933: an infra-class `stranded_assigned_issue` (pod eviction/preemption/
      // external delete) is nobody's fault — transferring ownerAgentId up the manager
      // ladder for it concentrates load on the manager for an event the current
      // assignee had no part in. Re-dispatch to the existing assignee instead, same as
      // the other transient causes above.
      //
      // Two tests, deliberately kept separate because they answer the question with
      // different evidence:
      //   * ROUTE_TO_ORIGINAL_INFRA_ERROR_CODES — codes that are infra-class by code
      //     ALONE (`job_failed`, `k8s_pod_schedule_failed`, …). No message needed.
      //   * isInfraClassStrandedFailure — the codes that are ambiguous by code alone.
      //     `claude_truncated` is emitted both for a genuine mid-stream crash and for a
      //     pod that vanished before exit could be read, so only the adapter's
      //     pod-removal wording separates them; `k8s_job_deleted_externally` is
      //     unambiguous but is absent from the set above.
      // Neither subsumes the other, so the union is the correct predicate. BLO-20321 —
      // this ticket's live proof instance — is `claude_truncated` + pod-removal text and
      // is matched ONLY by the second test.
      (input.recoveryCause === "stranded_assigned_issue" &&
        (ROUTE_TO_ORIGINAL_INFRA_ERROR_CODES.has(input.latestRun?.errorCode ?? "") ||
          isInfraClassStrandedFailure(input.latestRun)));
    if (input.recoveryCause === "provider_quota") {
      const retryAgentId = await resolveInvokableRecoveryAgentId(input.issue, originalAgentId);
      if (!retryAgentId) {
        return {
          ownerAgentId: await resolveStrandedIssueRecoveryOwnerAgentId(input.issue),
          returnOwnerAgentId: originalAgentId,
          routingFallbackReason: "The original assignee is not invokable; quota recovery fell through to the manager ladder.",
        };
      }
      return {
        ownerAgentId: null,
        returnOwnerAgentId: retryAgentId,
        routingFallbackReason: null,
      };
    }
    if (routeToOriginal) {
      const ownerAgentId = await resolveInvokableRecoveryAgentId(input.issue, returnOwnerAgentId);
      if (ownerAgentId) {
        return { ownerAgentId, returnOwnerAgentId, routingFallbackReason: null };
      }
      return {
        ownerAgentId: await resolveStrandedIssueRecoveryOwnerAgentId(input.issue),
        returnOwnerAgentId,
        routingFallbackReason: "The original assignee is not invokable; recovery fell through to the manager ladder.",
      };
    }
    return {
      ownerAgentId: await resolveStrandedIssueRecoveryOwnerAgentId(
        input.issue,
        input.preferredOwnerAgentId,
      ),
      returnOwnerAgentId,
      routingFallbackReason: null,
    };
  }

  function buildStrandedIssueRecoveryDescription(input: {
    issue: typeof issues.$inferSelect;
    latestRun: LatestIssueRun;
    previousStatus: StrandedPreviousStatus;
    prefix: string;
    originalAssignee: typeof agents.$inferSelect | null;
    recoveryCause?: StrandedRecoveryCause;
    successfulRunHandoffEvidence?: SuccessfulRunHandoffRecoveryEvidence | null;
    sourceAssignee?: Pick<typeof agents.$inferSelect, "id" | "name"> | null;
  }) {
    const sourceIssue = issueUiLink({ identifier: input.issue.identifier, id: input.issue.id }, input.prefix);
    const runLink = input.latestRun
      ? `[\`${input.latestRun.id}\`](/${input.prefix}/agents/${input.latestRun.agentId}/runs/${input.latestRun.id})`
      : "none";
    if (input.recoveryCause === SUCCESSFUL_RUN_MISSING_STATE_REASON) {
      const sourceRunId = input.successfulRunHandoffEvidence?.sourceRunId;
      const sourceRunLink = sourceRunId && input.latestRun
        ? `[\`${sourceRunId}\`](/${input.prefix}/agents/${input.latestRun.agentId}/runs/${sourceRunId})`
        : "unknown";
      const missingDisposition = input.successfulRunHandoffEvidence?.missingDisposition ?? "clear_next_step";
      return [
        "Paperclip exhausted the bounded corrective handoff for a successful run that still has no valid issue disposition.",
        "",
        "This is not a runtime/adapter crash report. The source run succeeded; the remaining problem is the missing `done`, `in_review`, `blocked`, delegated follow-up, or explicit continuation path.",
        "",
        "## Safe Evidence",
        "",
        `- Source issue: ${sourceIssue}`,
        `- Source run: ${sourceRunLink}`,
        `- Corrective handoff run: ${runLink}`,
        `- Source assignee: ${agentUiLink(input.sourceAssignee ?? null, input.prefix)}`,
        `- Latest issue status: \`${input.issue.status}\``,
        `- Latest handoff run status: \`${input.latestRun?.status ?? "unknown"}\``,
        `- Normalized cause: \`${SUCCESSFUL_RUN_MISSING_STATE_REASON}\``,
        `- Missing disposition: \`${missingDisposition}\``,
        "- Suggested manager action: choose and record a valid issue disposition without copying transcript content.",
        "",
        "## Required Action",
        "",
        "- Inspect the source issue and run metadata, not raw transcript excerpts.",
        "- Choose a valid issue disposition: `done`/`cancelled`, `in_review` with an owner, `blocked` with first-class blockers, delegated follow-up work, or an explicit continuation path.",
        "- When the source issue has a clear owner and disposition, mark this recovery issue done.",
      ].join("\n");
    }

    const retryReason = readNonEmptyString(parseObject(input.latestRun?.contextSnapshot)?.retryReason) ?? "unknown";
    const failureSummary = summarizeRunFailureForIssueComment(input.latestRun);
    const isReviewParticipantRecovery = input.recoveryCause === "execution_review_participant_recovery";
    const detectedInvariant = isReviewParticipantRecovery
      ? "execution_review_participant_recovery"
      : "stranded_assigned_issue";
    const requiredAction = isReviewParticipantRecovery
      ? [
        "- Inspect the latest reviewer run and the pending execution-review stage.",
        "- Fix the reviewer runtime, restore the source issue to `in_review` with a live participant, or record an intentional manual resolution.",
        "- When the source issue has a live review path or has been intentionally resolved, mark this recovery issue done.",
      ]
      : [
        "1. **Inspect first**: read the latest run linked above and identify whether the failure is transient or environmental.",
        "2. **Default action — re-wake the original assignee.** Leave the source issue's existing assignee unchanged unless they provably lack a required capability.",
        "3. **Reassign only when the original assignee cannot do the work.** Name the missing tool, MCP, or skill in the source-issue comment.",
        "4. **Mark blocked for environmental failures** that require a human to repair a workspace, runtime, or credential.",
        "5. **When the source issue has a live execution path or has been intentionally resolved, mark this recovery issue done.**",
      ];

    // Surface the original assignee's name + role + MCP keys + capability
    // blurb so the recovery agent can compare to its own (and any candidate
    // replacement's) capabilities BEFORE reassigning. Closes the BLO-3182
    // gap where CTO reassigned UXDesigner → CTO without realizing UXDesigner
    // had webflow + figma MCPs that CTO doesn't.
    const originalMcpKeys = extractAgentMcpKeys(input.originalAssignee);
    const originalCapabilities = summarizeAgentCapabilities(input.originalAssignee);
    const originalAssigneeName = input.originalAssignee?.name ?? "unknown";
    const originalAssigneeRole = input.originalAssignee?.role ?? "unknown";
    const mcpsLine = originalMcpKeys.length > 0
      ? `- Original assignee MCPs: ${originalMcpKeys.map((k) => `\`${k}\``).join(", ")}`
      : "- Original assignee MCPs: none configured";

    return [
      isReviewParticipantRecovery
        ? "Paperclip exhausted automatic recovery for a pending execution-review participant and created this explicit recovery task."
        : "Paperclip exhausted automatic recovery for an assigned issue and created this explicit recovery task.",
      "",
      "## Source",
      "",
      `- Source issue: ${sourceIssue}`,
      `- Previous source status: \`${input.previousStatus}\``,
      `- Latest retry run: ${runLink}`,
      `- Latest retry status: \`${input.latestRun?.status ?? "unknown"}\``,
      `- Detected invariant: \`${detectedInvariant}\``,
      `- Retry reason: \`${retryReason}\``,
      failureSummary ? `- Failure: ${failureSummary.trim()}` : "- Failure: none recorded",
      "",
      "## Original Assignee Capabilities",
      "",
      `- Original assignee: ${originalAssigneeName} (role: \`${originalAssigneeRole}\`)`,
      mcpsLine,
      originalCapabilities ? `- Capability blurb: ${originalCapabilities}` : "- Capability blurb: none recorded",
      "- Compare against your own capabilities before considering reassignment. If the original assignee has MCPs you don't, they probably need re-waking, not replacing.",
      "",
      "## Ownership",
      "",
      "- Selected owner: the first invokable manager/creator/executive candidate with budget available.",
      "- The original assignee is still the right owner for the *source* issue unless they provably can't do the work; this recovery task exists to diagnose, not to take over.",
      "",
      "## Required Action",
      "",
      ...requiredAction,
    ].join("\n");
  }

  async function ensureStrandedIssueRecoveryIssue(input: {
    issue: typeof issues.$inferSelect;
    latestRun: LatestIssueRun;
    previousStatus: StrandedPreviousStatus;
    recoveryCause?: StrandedRecoveryCause;
    successfulRunHandoffEvidence?: SuccessfulRunHandoffRecoveryEvidence | null;
  }) {
    if (isStrandedIssueRecoveryIssue(input.issue)) return null;

    // Retry loop tolerates two concurrency outcomes when many reconcile
    // sweeps race for the same source issue: (a) the partial unique index
    // catches the duplicate INSERT (23505), and (b) PostgreSQL kills one
    // of the racing transactions with a deadlock (40P01) when
    // index/parent/heap locks acquire in different orders. Either way the
    // caller treats the winner's issue as the canonical recovery.
    const MAX_ATTEMPTS = 5;
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const existing = await findOpenStrandedIssueRecoveryIssue(input.issue.companyId, input.issue.id);
      if (existing) return existing;

      // Cooldown: if a recovery for this source recently closed (done or
      // cancelled), don't fire another one. Returns the closed recovery so
      // the caller treats it as the current artifact and skips work; logs
      // surface that we suppressed instead of creating fresh.
      const now = new Date();
      const recentlyClosed = await findRecentClosedStrandedIssueRecoveryIssue(
        input.issue.companyId,
        input.issue.id,
        now,
      );
      if (recentlyClosed) {
        logger.info(
          {
            companyId: input.issue.companyId,
            sourceIssueId: input.issue.id,
            recentRecoveryId: recentlyClosed.id,
            recentRecoveryClosedAt: recentlyClosed.updatedAt,
            cooldownMs: STRANDED_ISSUE_RECOVERY_COOLDOWN_MS,
          },
          "stranded-recovery suppressed by cooldown after recent close",
        );
        return recentlyClosed;
      }

      const ownerAgentId = await resolveStrandedIssueRecoveryOwnerAgentId(input.issue);
      if (!ownerAgentId) return null;

      const prefix = await getCompanyIssuePrefix(input.issue.companyId);
      const sourceAssignee = input.issue.assigneeAgentId
        ? await getAgent(input.issue.assigneeAgentId)
        : null;
      const recoveryCause = input.recoveryCause ?? "stranded_assigned_issue";
      let recovery: Awaited<ReturnType<typeof issuesSvc.create>>;
      try {
        recovery = await issuesSvc.create(input.issue.companyId, {
          title: recoveryCause === SUCCESSFUL_RUN_MISSING_STATE_REASON
            ? `Recover missing next step ${input.issue.identifier ?? input.issue.title}`
            : `Recover stalled issue ${input.issue.identifier ?? input.issue.title}`,
          description: buildStrandedIssueRecoveryDescription({
            issue: input.issue,
            latestRun: input.latestRun,
            previousStatus: input.previousStatus,
            prefix,
            originalAssignee: sourceAssignee,
            recoveryCause,
            successfulRunHandoffEvidence: input.successfulRunHandoffEvidence,
            sourceAssignee,
          }),
          status: "todo",
          priority: input.issue.priority,
          parentId: input.issue.id,
          projectId: input.issue.projectId,
          goalId: input.issue.goalId,
          assigneeAgentId: ownerAgentId,
          assigneeAdapterOverrides: recoveryAssigneeAdapterOverrides("status_only"),
          originKind: STRANDED_ISSUE_RECOVERY_ORIGIN_KIND,
          originId: input.issue.id,
          originRunId: input.latestRun?.id ?? null,
          originFingerprint: [
            STRANDED_ISSUE_RECOVERY_ORIGIN_KIND,
            input.issue.companyId,
            input.issue.id,
            recoveryCause,
            input.latestRun?.id ?? "no-run",
          ].join(":"),
          billingCode: input.issue.billingCode,
          inheritExecutionWorkspaceFromIssueId: input.issue.id,
        });
      } catch (error) {
        lastError = error;
        const code = (error as { code?: string })?.code;
        const isRetryable = isUniqueStrandedIssueRecoveryConflict(error) || code === "40P01";
        if (!isRetryable) throw error;
        const raced = await findOpenStrandedIssueRecoveryIssue(input.issue.companyId, input.issue.id);
        if (raced) return raced;
        if (attempt === MAX_ATTEMPTS - 1) break;
        // Jittered backoff so concurrent retriers don't deadlock again on
        // the same lock-acquisition order.
        await new Promise((resolve) => setTimeout(resolve, 10 + Math.random() * 40));
        continue;
      }

      await deps.enqueueWakeup(ownerAgentId, {
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: withRecoveryModelProfileHint({
          issueId: recovery.id,
          sourceIssueId: input.issue.id,
          strandedRunId: input.latestRun?.id ?? null,
          recoveryCause,
        }, "status_only"),
        requestedByActorType: "system",
        requestedByActorId: null,
        contextSnapshot: withRecoveryModelProfileHint({
          issueId: recovery.id,
          taskId: recovery.id,
          wakeReason: "issue_assigned",
          source: STRANDED_ISSUE_RECOVERY_ORIGIN_KIND,
          sourceIssueId: input.issue.id,
          strandedRunId: input.latestRun?.id ?? null,
          recoveryCause,
        }, "status_only"),
      });

      return recovery;
    }

    throw lastError ?? new Error("ensureStrandedIssueRecoveryIssue: exhausted retries with no winner");
  }

  function strandedRecoveryActionKind(cause: StrandedRecoveryCause) {
    return cause === SUCCESSFUL_RUN_MISSING_STATE_REASON
      ? "missing_disposition" as const
      : cause === "workspace_validation_failed"
        ? "workspace_validation" as const
      : cause === "configuration_incomplete"
        ? "configuration_validation" as const
      : "stranded_assigned_issue" as const;
  }

  function strandedRecoveryActionFingerprint(input: {
    issue: typeof issues.$inferSelect;
    recoveryCause: StrandedRecoveryCause;
    latestRun: LatestIssueRun;
    blockerIssueIds?: string[];
  }) {
    const blockerIssueIds = [...new Set(input.blockerIssueIds ?? [])].sort();
    const blockerSignature = blockerIssueIds.length > 0
      ? `:blockers=${blockerIssueIds.join(",")}`
      : "";
    if (input.recoveryCause === "workspace_validation_failed") {
      const workspaceFingerprint = readWorkspaceValidationFingerprint(input.latestRun);
      if (workspaceFingerprint) {
        return [
          "source_scoped_recovery",
          input.issue.companyId,
          input.issue.id,
          input.recoveryCause,
          workspaceFingerprint,
        ].join(":") + blockerSignature;
      }
    }
    return [
      "source_scoped_recovery",
      input.issue.companyId,
      input.issue.id,
      input.recoveryCause,
      // Include assignee so a reassignment is a distinct failure signature. NOTE: this does
      // NOT drive the wake-budget reset, despite what this comment claimed before BLO-18996
      // — escalation reassigns the issue to the recovery owner, so this segment changes on
      // every sweep of an unresolved failure. The budget resets on a change of
      // `ownerAgentId` instead; see `upsertSourceScopedUnlocked`.
      input.issue.assigneeAgentId ?? "unassigned",
    ].join(":") + blockerSignature;
  }

  function buildStrandedRecoveryActionEvidence(input: {
    issue: typeof issues.$inferSelect;
    latestRun: LatestIssueRun;
    previousStatus: StrandedPreviousStatus;
    recoveryCause: StrandedRecoveryCause;
    sourceAssignee?: typeof agents.$inferSelect | null;
    successfulRunHandoffEvidence?: SuccessfulRunHandoffRecoveryEvidence | null;
  }) {
    const context = parseObject(input.latestRun?.contextSnapshot);
    const workspaceValidation = input.recoveryCause === "workspace_validation_failed"
      ? readWorkspaceValidationPayload(input.latestRun)
      : null;
    return {
      sourceIssueId: input.issue.id,
      sourceIdentifier: input.issue.identifier,
      previousStatus: input.previousStatus,
      latestIssueStatus: input.issue.status,
      latestRunId: input.latestRun?.id ?? null,
      // BLO-20263: whose run failed. `upsertSourceScoped` needs this to tell replay of an
      // earlier agent's failure apart from a recovery owner that has since failed on its
      // own run — owner identity alone reads identically in both, and the handoff grant
      // must refresh for the second and not the first.
      latestRunAgentId: input.latestRun?.agentId ?? null,
      latestRunStatus: input.latestRun?.status ?? null,
      latestRunErrorCode: input.latestRun?.errorCode ?? null,
      latestRunFailureSummary: summarizeRunFailureForIssueComment(input.latestRun),
      retryReason: readNonEmptyString(context.retryReason) ?? null,
      recoveryCause: input.recoveryCause,
      // BLO-20933: audit trail for the routing decision above — records whether the
      // terminal cause was classified infrastructure-class (pod eviction/preemption/
      // external delete) independent of which `recoveryCause` bucket it landed in.
      infraClassCause: isInfraClassStrandedFailure(input.latestRun),
      originalAssigneeMcpKeys: extractAgentMcpKeys(input.sourceAssignee),
      originalAssigneeCapabilities: summarizeAgentCapabilities(input.sourceAssignee),
      sourceRunId: input.successfulRunHandoffEvidence?.sourceRunId ?? null,
      correctiveRunId: input.successfulRunHandoffEvidence?.correctiveRunId ?? null,
      missingDisposition: input.successfulRunHandoffEvidence?.missingDisposition ?? null,
      handoffAttempt: input.successfulRunHandoffEvidence?.handoffAttempt ?? null,
      maxHandoffAttempts: input.successfulRunHandoffEvidence?.maxHandoffAttempts ?? null,
      ...(workspaceValidation ? { workspaceValidation } : {}),
    };
  }

  async function ensureSourceScopedStrandedRecoveryAction(input: {
    issue: typeof issues.$inferSelect;
    latestRun: LatestIssueRun;
    previousStatus: StrandedPreviousStatus;
    recoveryCause?: StrandedRecoveryCause;
    recoveryOwnerAgentId?: string | null;
    successfulRunHandoffEvidence?: SuccessfulRunHandoffRecoveryEvidence | null;
    blockerIssueIds?: string[];
  }, dbOrTx: Db | DbTransaction = db) {
    const actionSvc = dbOrTx === db ? recoveryActionsSvc : issueRecoveryActionService(dbOrTx);
    const recoveryCause = resolveStrandedRecoveryCause(input.latestRun, input.recoveryCause);
    // Read the existing action before the upsert. Two consumers depend on it:
    //   - `existingReturnOwnerAgentId` below, so a repeat takeover cannot overwrite the
    //     originally-recorded return owner with the current (manager) one;
    //   - `previousAttemptAt` further down, to compare against issue.lastActivityAt and
    //     suppress duplicate non-assignee wakes when nothing changed.
    const existingAction = await actionSvc.getActiveForIssue(input.issue.companyId, input.issue.id);
    const routing = await resolveStrandedRecoveryRouting({
      issue: input.issue,
      latestRun: input.latestRun,
      recoveryCause,
      preferredOwnerAgentId: input.recoveryOwnerAgentId,
      existingReturnOwnerAgentId: existingAction?.returnOwnerAgentId,
      existingOwnerAgentId: existingAction?.ownerAgentId,
    });
    const ownerAgentId = routing.ownerAgentId;
    // BLO-18996: the single predicate for "will any sweep wake an owner for this action".
    // The wake budget and the wake path have to agree, and previously they were written as
    // two separate expressions that disagreed on exactly one shape: `provider_quota` is
    // monitor-only ONLY when it has no owner, but the budget condition excluded the cause
    // outright. `resolveStrandedRecoveryRouting` gives provider-quota a manager-ladder owner
    // whenever the quota-hit agent is not invokable, and that shape takes the `wake_owner`
    // branch below and clears every early return in
    // `enqueueSourceScopedStrandedRecoveryWake` — so it woke an owner forever on a null
    // budget. Deriving all of it from one boolean is what stops that drift recurring.
    const wakesOwner = Boolean(ownerAgentId) &&
      recoveryCause !== "workspace_validation_failed" &&
      recoveryCause !== "configuration_incomplete";
    const sourceAssignee = input.issue.assigneeAgentId
      ? await getAgent(input.issue.assigneeAgentId)
      : null;
    const now = new Date();
    const boundsAtCreation = wakesOwner ? recoveryActionBoundsAtCreation(now) : null;

    const previousAttemptAt = existingAction?.lastAttemptAt
      ? new Date(existingAction.lastAttemptAt as Date | string)
      : null;
    const hasNewActivitySinceLastAttempt = !previousAttemptAt
      || input.issue.lastActivityAt > previousAttemptAt;

    // An ownerless action has no wake budget to spend. Reuse the unchanged action so a
    // sweepable no-owner issue cannot increment attemptCount on every sweep. A changed cause
    // or newly resolved owner still uses the normal upsert path below.
    if (existingAction && !ownerAgentId && !existingAction.ownerAgentId &&
      existingAction.cause === recoveryCause &&
      existingAction.fingerprint === strandedRecoveryActionFingerprint({
        issue: input.issue,
        recoveryCause,
        latestRun: input.latestRun,
        blockerIssueIds: input.blockerIssueIds,
      })) {
      return { action: existingAction, hasNewActivitySinceLastAttempt, unchangedOwnerless: true };
    }

    const action = await actionSvc.upsertSourceScoped({
      companyId: input.issue.companyId,
      sourceIssueId: input.issue.id,
      kind: strandedRecoveryActionKind(recoveryCause),
      ownerType: recoveryCause === "provider_quota" && !ownerAgentId ? "system" : ownerAgentId ? "agent" : "board",
      ownerAgentId,
      previousOwnerAgentId: input.issue.assigneeAgentId,
      returnOwnerAgentId: routing.returnOwnerAgentId,
      cause: recoveryCause,
      fingerprint: strandedRecoveryActionFingerprint({
        issue: input.issue,
        recoveryCause,
        latestRun: input.latestRun,
        blockerIssueIds: input.blockerIssueIds,
      }),
      evidence: {
        ...buildStrandedRecoveryActionEvidence({
          issue: input.issue,
          latestRun: input.latestRun,
          previousStatus: input.previousStatus,
          recoveryCause,
          sourceAssignee,
          successfulRunHandoffEvidence: input.successfulRunHandoffEvidence,
        }),
        failureSummary: summarizeRunFailureForIssueComment(input.latestRun)?.trim() ?? null,
        routingFallbackReason: routing.routingFallbackReason,
      },
      nextAction: recoveryCause === SUCCESSFUL_RUN_MISSING_STATE_REASON
        ? "Choose and record a valid issue disposition without copying transcript content."
        : recoveryCause === "process_lost"
          ? "Retry the original assignee from durable progress without redoing completed steps."
        : recoveryCause === "provider_quota"
          ? "Wait for provider quota recovery, then retry the original assignee; do not wake a takeover owner."
        : recoveryCause === "codex_output_inactivity_monitor"
          ? "Retry the same agent from durable progress after the output-inactivity termination."
        : recoveryCause === "workspace_validation_failed"
          ? readWorkspaceValidationPayload(input.latestRun)?.reason === "git_worktree_branch_incoherence"
            ? "Repair the source issue git worktree branch incoherence, or choose a new execution workspace, before resuming adapter execution."
            : "Repair the source issue workspace link, project workspace cwd, or git checkout before resuming adapter execution."
        : recoveryCause === "configuration_incomplete"
          ? "Bind the missing secret(s) named in the run failure to the agent/project/routine env before resuming adapter execution."
        : recoveryCause === "execution_review_participant_recovery"
          ? "Repair the failed review participant path, restore the source issue to in_review with a live reviewer, or record an intentional manual resolution."
        : "Restore a live execution path, fix the runtime/adapter failure, or record an intentional manual resolution.",
      wakePolicy: recoveryCause === "provider_quota" && !ownerAgentId
        ? {
          type: "monitor_only",
          reason: recoveryCause,
        }
        : recoveryCause === "workspace_validation_failed" || recoveryCause === "configuration_incomplete"
        ? {
          type: "manual_repair_required",
          reason: recoveryCause,
          ownerAgentId,
        }
        : ownerAgentId
        ? {
          type: "wake_owner",
          reason: "source_scoped_recovery_action",
          ownerAgentId,
        }
        : {
          type: "board_escalation",
          reason: "no_invokable_recovery_owner",
        },
      monitorPolicy: recoveryCause === "provider_quota" && !ownerAgentId
        ? { type: "wait_recovery", retryAgentId: routing.returnOwnerAgentId }
        : null,
      // Only the wake-owner shape gets creation-time bounds. The monitor-only and
      // manual-repair shapes deliberately remain unbounded because neither path
      // performs an owner wake. `upsertSourceScoped` preserves these fields after
      // insertion, so owner churn cannot turn this into a sliding horizon.
      maxAttempts: boundsAtCreation?.maxAttempts ?? null,
      timeoutAt: boundsAtCreation?.timeoutAt ?? null,
      lastAttemptAt: now,
    });

    return { action, hasNewActivitySinceLastAttempt, unchangedOwnerless: false };
  }

  async function enqueueSourceScopedStrandedRecoveryWake(input: {
    action: Awaited<ReturnType<typeof recoveryActionsSvc.upsertSourceScoped>>;
    issue: typeof issues.$inferSelect;
    latestRun: LatestIssueRun;
    recoveryCause: StrandedRecoveryCause;
    hasNewActivitySinceLastAttempt: boolean;
    expectedLockOwnerState?: IssueLockOwnerState | null;
  }) {
    if (input.recoveryCause === "provider_quota" && !input.action.ownerAgentId) return;
    if (input.recoveryCause === "workspace_validation_failed" || input.recoveryCause === "configuration_incomplete") return;
    if (!input.action.ownerAgentId) return;
    // BLO-18996 (review follow-up): the attempt this wake spends was already committed.
    // `recoveryActionsSvc` runs on the outer `db`, not on `escalateStrandedAssignedIssue`'s
    // transaction, so `upsertSourceScoped`'s `attemptCount` increment is durable before we
    // get here and the surrounding rollback cannot take it back. Without a refund an enqueue
    // that woke nobody burns budget anyway — five such sweeps retire the action having woken
    // nobody, while the exhaustion notice reports five wakes.
    //
    // "Woke nobody" is NOT just a throw. `enqueueWakeup` returns null on nine separate
    // non-delivery paths — provider-capacity deferral (`checkPenstockAvailabilityForAgent`),
    // an active tree pause hold, heartbeat/wake-on-demand disabled, cooldown, the
    // no-actionable-timer-work skip — and every one of those either writes a *skipped*
    // request row or nothing at all. None of them queues a run. So the budget must be spent
    // on a non-null return only, which is the sole outcome that means a wake reached the
    // queue. (See the same null-is-not-an-error reading at the blockers-resolved backstop
    // below, `result.deferredOrFailed`.)
    //
    // Refunding every null cannot reopen the unbounded loop this PR exists to close: a
    // permanently-deferred owner is still retired by `timeoutAt`, the creation-anchored
    // horizon in `strandedRecoveryWakeAttemptsExhausted`, which no sweep rewrites and which
    // does not depend on `attemptCount` moving at all. Attempts bound delivered-but-
    // unproductive wakes; the horizon bounds wall-clock regardless of delivery.
    const reservedOwnerAgentId = input.action.ownerAgentId;
    const reservedAttemptCount = input.action.attemptCount;
    const refundUnspentWakeAttempt = async (
      cause: "enqueue_threw" | "enqueue_not_delivered" | "attempts_exhausted",
      error?: unknown,
    ) => {
      const release = () =>
        recoveryActionsSvc.releaseWakeAttempt({
          companyId: input.issue.companyId,
          actionId: input.action.id,
          expectedOwnerAgentId: reservedOwnerAgentId,
          expectedAttemptCount: reservedAttemptCount,
        });
      try {
        await release();
      } catch (firstError) {
        // One retry, because the failure mode this compensates for is a transient database
        // blip and a second attempt is nearly free. If it still fails we must not rethrow —
        // on the `enqueue_threw` path that would mask the enqueue's own error, which is the
        // more diagnostic one. But it must not vanish either: a swallowed refund leaves the
        // attempt spent for a wake nobody received, so record it under a stable message that
        // can be counted. Bounded damage by construction — over-counting is at most one
        // attempt per failed refund against a 5-attempt budget that `timeoutAt` also bounds,
        // so the degradation is a slightly early retirement with a comment on the issue, not
        // a silent loop.
        try {
          await release();
        } catch (secondError) {
          logger.warn(
            {
              err: secondError,
              firstErr: firstError,
              enqueueErr: error,
              cause,
              companyId: input.issue.companyId,
              issueId: input.issue.id,
              recoveryActionId: input.action.id,
              attemptCount: input.action.attemptCount,
              maxAttempts: input.action.maxAttempts,
            },
            "recovery wake attempt refund failed after retry; budget over-counted by one attempt",
          );
        }
      }
    };
    // BLO-19124: the exhaustion gate must refund too, and it has to sit BELOW the closure
    // above so it can reach it. The reserve at `issue-recovery-actions.ts:508` is
    // unconditional — every sweep of an already-exhausted row commits `attemptCount + 1` —
    // while this gate returns without spending a wake. Before this refund the two were
    // asymmetric, so an exhausted row gained +1 per sweep forever: monotonic, unbounded, and
    // the reason a live row read `attemptCount: 30` against `maxAttempts: 5` (~30 sweeps, of
    // which only 5 ever woke anyone). Refunding makes reserve-then-return net zero, so the
    // counter FREEZES at the number of wakes actually delivered instead of counting sweeps.
    //
    // This cannot un-exhaust the row or leak an extra wake. The refund lands on
    // `maxAttempts` and the next sweep's reserve puts it back at `maxAttempts + 1`, which
    // re-trips this same gate before any enqueue — so the delivered-wake ceiling is unchanged
    // at exactly `maxAttempts`, and `timeoutAt` still bounds wall-clock independently.
    if (strandedRecoveryWakeAttemptsExhausted(input.action)) {
      await refundUnspentWakeAttempt("attempts_exhausted");
      return;
    }
    const enqueueOrRefundAttempt: typeof deps.enqueueWakeup = async (agentId, opts) => {
      let queued: Awaited<ReturnType<typeof deps.enqueueWakeup>>;
      try {
        queued = await deps.enqueueWakeup(agentId, opts);
      } catch (error) {
        // Refund, then rethrow so the escalation still fails loudly.
        await refundUnspentWakeAttempt("enqueue_threw", error);
        throw error;
      }
      if (!queued) await refundUnspentWakeAttempt("enqueue_not_delivered");
      return queued;
    };
    const ownerIsNonAssignee = input.action.ownerAgentId !== input.issue.assigneeAgentId;
    if (!input.hasNewActivitySinceLastAttempt && ownerIsNonAssignee && input.action.attemptCount > 1) {
      const assigneeAgentId = input.issue.assigneeAgentId;
      if (!assigneeAgentId) {
        await refundUnspentWakeAttempt("enqueue_not_delivered");
        return;
      }
      await enqueueOrRefundAttempt(assigneeAgentId, {
        source: "assignment",
        triggerDetail: "system",
        reason: "source_scoped_recovery_action",
        idempotencyKey: `source_scoped_recovery_action:${input.action.id}:${input.action.attemptCount}:assignee_fallback`,
        payload: withRecoveryModelProfileHint({
          issueId: input.issue.id,
          sourceIssueId: input.issue.id,
          recoveryActionId: input.action.id,
          strandedRunId: input.latestRun?.id ?? null,
          recoveryCause: input.recoveryCause,
          suppressedNonAssigneeWake: true,
        }, "status_only"),
        requestedByActorType: "system",
        requestedByActorId: null,
        contextSnapshot: withRecoveryModelProfileHint({
          issueId: input.issue.id,
          taskId: input.issue.id,
          wakeReason: "source_scoped_recovery_action",
          skipIssueComment: true,
          source: "issue_recovery_action",
          recoveryActionId: input.action.id,
          sourceIssueId: input.issue.id,
          strandedRunId: input.latestRun?.id ?? null,
          recoveryCause: input.recoveryCause,
          suppressedNonAssigneeWake: true,
        }, "status_only"),
        expectedLockOwnerState: input.expectedLockOwnerState,
      });
      return;
    }
    // NOTE (BLO-18996): `attemptCount` restarts at 1 whenever the action's owner changes,
    // and refunds decrement it when no wake was delivered. This key can therefore repeat
    // within one owner sequence after refunded attempts, and across owner sequences after
    // reassignment. That is safe today because nothing dedupes this path on `idempotencyKey`:
    // `enqueueWakeup` coalesces on (companyId, agentId, taskKey). If you ever add
    // idempotency-key dedup here, include the owner and a non-refunded delivery sequence first.
    await enqueueOrRefundAttempt(input.action.ownerAgentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "source_scoped_recovery_action",
      idempotencyKey: `source_scoped_recovery_action:${input.action.id}:${input.action.attemptCount}`,
      payload: withRecoveryModelProfileHint({
        issueId: input.issue.id,
        sourceIssueId: input.issue.id,
        recoveryActionId: input.action.id,
        strandedRunId: input.latestRun?.id ?? null,
        recoveryCause: input.recoveryCause,
      }, "status_only"),
      requestedByActorType: "system",
      requestedByActorId: null,
      contextSnapshot: withRecoveryModelProfileHint({
        issueId: input.issue.id,
        taskId: input.issue.id,
        wakeReason: "source_scoped_recovery_action",
        skipIssueComment: true,
        source: "issue_recovery_action",
        recoveryActionId: input.action.id,
        sourceIssueId: input.issue.id,
        strandedRunId: input.latestRun?.id ?? null,
        recoveryCause: input.recoveryCause,
      }, "status_only"),
      expectedLockOwnerState: input.expectedLockOwnerState,
    });
  }

  function readProviderQuotaRetryAt(latestRun: LatestIssueRun, now: Date) {
    const result = parseObject(latestRun?.resultJson);
    const context = parseObject(latestRun?.contextSnapshot);
    const raw = result.providerQuotaRetryNotBefore ??
      result.retryNotBefore ??
      result.transientRetryNotBefore ??
      context.providerQuotaRetryNotBefore ??
      context.transientRetryNotBefore;
    if (typeof raw === "string" || typeof raw === "number" || raw instanceof Date) {
      const parsed = new Date(raw);
      if (!Number.isNaN(parsed.getTime()) && parsed.getTime() > now.getTime()) return parsed;
    }
    return new Date(now.getTime() + PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS);
  }

  async function ensureProviderQuotaWaitRecoveryMonitor(input: {
    issue: typeof issues.$inferSelect;
    latestRun: LatestIssueRun;
    actionId: string;
    agentId: string;
  }) {
    const now = new Date();
    const retryAt = readProviderQuotaRetryAt(input.latestRun, now);
    try {
      return await db.transaction(async (tx) => {
        // The escalation has committed, so this second transaction must prove that
        // the issue is still the exact post-escalation state that authorized the
        // monitor. Adoption, reassignment, resolution, or another recovery writer
        // can otherwise leave a retry attached to stale recovery state.
        await lockIssueOwnership(tx, input.issue.companyId, input.issue.id);
        const [freshIssue] = await tx
          .select()
          .from(issues)
          .where(and(
            eq(issues.companyId, input.issue.companyId),
            eq(issues.id, input.issue.id),
          ))
          .limit(1)
          .for("update");
        if (!freshIssue || freshIssue.status !== input.issue.status || !issueLockOwnerStateMatches(
          {
            executionRunId: input.issue.executionRunId,
            checkoutRunId: input.issue.checkoutRunId,
            assigneeAgentId: input.issue.assigneeAgentId,
          },
          {
            executionRunId: freshIssue.executionRunId,
            checkoutRunId: freshIssue.checkoutRunId,
            assigneeAgentId: freshIssue.assigneeAgentId,
          },
        )) {
          return null;
        }

        // Lock the action before checking its routing/evidence. The action is
        // deliberately narrower than ACTIVE_RECOVERY_ACTION_STATUSES here:
        // `escalated` is a terminal human-attention state and must not receive a
        // scheduler monitor as a side effect of an old post-commit callback.
        const [action] = await tx
          .select()
          .from(issueRecoveryActions)
          .where(and(
            eq(issueRecoveryActions.id, input.actionId),
            eq(issueRecoveryActions.companyId, freshIssue.companyId),
            eq(issueRecoveryActions.sourceIssueId, freshIssue.id),
          ))
          .limit(1)
          .for("update");
        if (!action || action.status !== "active" || action.cause !== "provider_quota" ||
          action.ownerAgentId !== null || action.returnOwnerAgentId !== input.agentId) {
          return null;
        }

        // A recovery action records the run that supplied its evidence. If that
        // evidence is present, the post-commit monitor callback must still be for
        // the same run; an older callback must not arm a retry for a newer action
        // generation. Older rows may lack either field, so absent evidence remains
        // compatible with the pre-evidence schema.
        const actionEvidence = parseObject(action.evidence);
        const actionLatestRunId = readNonEmptyString(actionEvidence.latestRunId);
        const actionLatestRunAgentId = readNonEmptyString(actionEvidence.latestRunAgentId);
        if (
          (actionLatestRunId !== null && actionLatestRunId !== input.latestRun?.id) ||
          (actionLatestRunAgentId !== null && actionLatestRunAgentId !== input.latestRun?.agentId)
        ) {
          return null;
        }

        const existing = await tx
          .select()
          .from(heartbeatRuns)
          .where(and(
            eq(heartbeatRuns.companyId, freshIssue.companyId),
            eq(heartbeatRuns.agentId, input.agentId),
            eq(heartbeatRuns.status, "scheduled_retry"),
            eq(heartbeatRuns.scheduledRetryReason, "provider_quota_recovery"),
            or(
              sql`${heartbeatRuns.contextSnapshot} ->> 'recoveryActionId' = ${action.id}`,
              // Compatibility for monitors created before the stable action key
              // was introduced. The reason and issue scope keep this fallback
              // from matching unrelated scheduled retries for the same issue.
              and(
                sql`${heartbeatRuns.contextSnapshot} ->> 'recoveryActionId' is null`,
                sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${freshIssue.id}`,
              ),
            ),
          ))
          .orderBy(desc(heartbeatRuns.scheduledRetryAt))
          .limit(1)
          .then((rows) => rows[0] ?? null);
        if (existing) return existing;

        const recoveryActionId = action.id;
        const stableIdempotencyKey = `provider_quota_recovery:${recoveryActionId}`;
        const wakeup = await tx
          .insert(agentWakeupRequests)
          .values({
            companyId: freshIssue.companyId,
            agentId: input.agentId,
            source: "automation",
            triggerDetail: "system",
            reason: "provider_quota_recovery",
            payload: withRecoveryModelProfileHint({
              issueId: freshIssue.id,
              recoveryActionId,
              retryOfRunId: input.latestRun?.id ?? null,
              retryReason: "provider_quota_recovery",
              providerQuotaRetryNotBefore: retryAt.toISOString(),
            }, "normal_model"),
            status: "queued",
            requestedByActorType: "system",
            requestedByActorId: null,
            idempotencyKey: stableIdempotencyKey,
            updatedAt: now,
          })
          .returning()
          .then((rows) => rows[0]!);
        const scheduledRun = await tx
          .insert(heartbeatRuns)
          .values({
            companyId: freshIssue.companyId,
            agentId: input.agentId,
            invocationSource: "automation",
            triggerDetail: "system",
            status: "scheduled_retry",
            wakeupRequestId: wakeup.id,
            retryOfRunId: input.latestRun?.id ?? null,
            scheduledRetryAt: retryAt,
            scheduledRetryAttempt: 1,
            scheduledRetryReason: "provider_quota_recovery",
            contextSnapshot: withRecoveryModelProfileHint({
              issueId: freshIssue.id,
              taskId: freshIssue.id,
              recoveryActionId,
              wakeReason: "provider_quota_recovery",
              retryReason: "provider_quota_recovery",
              providerQuotaRetryNotBefore: retryAt.toISOString(),
            }, "normal_model"),
            updatedAt: now,
          })
          .returning()
          .then((rows) => rows[0]!);
        await tx
          .update(agentWakeupRequests)
          .set({ runId: scheduledRun.id, updatedAt: now })
          .where(eq(agentWakeupRequests.id, wakeup.id));
        const [updatedAction] = await tx
          .update(issueRecoveryActions)
          .set({
            monitorPolicy: {
              type: "wait_recovery",
              retryAgentId: input.agentId,
              recoveryActionId,
              scheduledRunId: scheduledRun.id,
              retryAt: retryAt.toISOString(),
            },
            timeoutAt: retryAt,
            updatedAt: now,
          })
          .where(and(
            eq(issueRecoveryActions.id, action.id),
            eq(issueRecoveryActions.companyId, freshIssue.companyId),
            eq(issueRecoveryActions.sourceIssueId, freshIssue.id),
            eq(issueRecoveryActions.status, "active"),
            eq(issueRecoveryActions.cause, "provider_quota"),
            isNull(issueRecoveryActions.ownerAgentId),
            eq(issueRecoveryActions.returnOwnerAgentId, input.agentId),
            ...(actionLatestRunId === null
              ? []
              : [sql`${issueRecoveryActions.evidence} ->> 'latestRunId' = ${actionLatestRunId}`]),
            ...(actionLatestRunAgentId === null
              ? []
              : [sql`${issueRecoveryActions.evidence} ->> 'latestRunAgentId' = ${actionLatestRunAgentId}`]),
          ))
          .returning();
        if (!updatedAction) throw new ProviderQuotaMonitorRollback();
        return scheduledRun;
      });
    } catch (error) {
      if (error instanceof ProviderQuotaMonitorRollback) return null;
      throw error;
    }
  }

  function buildRecoveryIssueInPlaceEscalationComment(input: {
    issue: typeof issues.$inferSelect;
    previousStatus: StrandedPreviousStatus;
    latestRun: LatestIssueRun;
    prefix: string;
  }) {
    const runLink = input.latestRun
      ? runUiLink({ id: input.latestRun.id, agentId: input.latestRun.agentId }, input.prefix)
      : "none";
    const retryReason = readNonEmptyString(parseObject(input.latestRun?.contextSnapshot)?.retryReason) ?? "none";
    const failureSummary = summarizeRunFailureForIssueComment(input.latestRun);
    const workspacePreflightCause = describeWorkspacePreflightRecoveryCause(input.latestRun);

    return [
      "Paperclip stopped automatic stranded-work recovery for this recovery issue.",
      "",
      `- Recovery issue: ${issueUiLink({ identifier: input.issue.identifier, id: input.issue.id }, input.prefix)}`,
      `- Previous status: \`${input.previousStatus}\``,
      `- Latest run: ${runLink}`,
      `- Latest run status: \`${input.latestRun?.status ?? "unknown"}\``,
      `- Retry reason: \`${retryReason}\``,
      failureSummary ? `- Failure: ${failureSummary.trim()}` : "- Failure: none recorded",
      "- Guard: recovery issues do not create nested `stranded_issue_recovery` issues.",
      "",
      workspacePreflightCause
        ? `Next action: ${workspacePreflightCause} Then move this recovery issue out of \`blocked\`.`
        : "Next action: the current recovery owner should inspect the failed run evidence, restore a live execution path or record the manual resolution, then move this recovery issue out of `blocked`.",
    ].join("\n");
  }

  async function escalateStrandedRecoveryIssueInPlace(input: {
    issue: typeof issues.$inferSelect;
    previousStatus: StrandedPreviousStatus;
    latestRun: LatestIssueRun;
    expectedLockOwnerState?: IssueLockOwnerState | null;
  }) {
    const result = await db.transaction(async (tx) => {
      await lockIssueOwnership(tx, input.issue.companyId, input.issue.id);

      // Acquire the graph lock before the issue row. `issuesSvc.update` takes
      // this order for status mutations that touch the issue graph; retaining
      // the same order here avoids an inversion with a concurrent blocker
      // update while still keeping the handover decision and its side effects
      // in one transaction.
      await lockIssueParentMutationCompany(input.issue.companyId, tx);
      const [fresh] = await tx
        .select()
        .from(issues)
        .where(eq(issues.id, input.issue.id))
        .limit(1)
        .for("update");
      if (!fresh || fresh.status !== input.previousStatus && fresh.status !== "blocked") return null;
      if (
        input.expectedLockOwnerState &&
        !issueLockOwnerStateMatches(input.expectedLockOwnerState, {
          executionRunId: fresh.executionRunId,
          checkoutRunId: fresh.checkoutRunId,
          assigneeAgentId: fresh.assigneeAgentId,
        })
      ) return null;

      const updated = await issuesSvc.update(
        fresh.id,
        {
          status: "blocked",
          ...buildIssueMonitorClearedPatch({
            issue: fresh,
            policy: normalizeIssueExecutionPolicy(fresh.executionPolicy ?? null),
            clearReason: "suppressed_by_status",
          }),
          expectedCurrentStatus: fresh.status,
          expectedCurrentAssigneeAgentId: fresh.assigneeAgentId,
          expectedCurrentCheckoutRunId: fresh.checkoutRunId,
          expectedCurrentExecutionRunId: fresh.executionRunId,
        },
        tx,
      );
      if (!updated) return null;

      const prefix = await getCompanyIssuePrefix(fresh.companyId);
      await issuesSvc.addComment(
        fresh.id,
        buildRecoveryIssueInPlaceEscalationComment({
          issue: fresh,
          previousStatus: input.previousStatus,
          latestRun: input.latestRun,
          prefix,
        }),
        {},
        { authorType: "system" },
        tx,
      );

      const publish = await logActivity(tx as unknown as Db, {
        companyId: fresh.companyId,
        actorType: "system",
        actorId: "system",
        agentId: null,
        runId: null,
        action: "issue.updated",
        entityType: "issue",
        entityId: fresh.id,
        details: {
          identifier: fresh.identifier,
          status: "blocked",
          previousStatus: input.previousStatus,
          source: "recovery.reconcile_stranded_recovery_issue",
          latestRunId: input.latestRun?.id ?? null,
          latestRunStatus: input.latestRun?.status ?? null,
          latestRunErrorCode: input.latestRun?.errorCode ?? null,
          originKind: fresh.originKind,
          originId: fresh.originId,
        },
      }, { deferPublish: true });

      return { updated, publish };
    });
    if (!result) return null;
    result.publish();
    return result.updated;
  }

  function isWaitingOnReviewContinuationRun(latestRun: LatestIssueRun) {
    const context = parseObject(latestRun?.contextSnapshot);
    return latestRun?.status === "cancelled" &&
      readNonEmptyString(context.retryReason) === "issue_continuation_needed" &&
      latestRun.errorCode === "issue_continuation_waiting_on_review";
  }

  function hasActiveMonitorPath(issue: typeof issues.$inferSelect) {
    if (issue.status === "blocked") return false;
    if (issue.monitorNextCheckAt && issue.monitorNextCheckAt.getTime() > Date.now()) return true;

    // BLO-18643: a monitor that has already fired (`status: "triggered"`) but has not
    // yet been rescheduled or cleared is still an active watch, not an absent one --
    // the assignee's next continuation run (or the monitor's own scheduler) owns
    // re-arming `monitorNextCheckAt`. Reading "fired, not yet rescheduled" as "no
    // monitor" let the stranded-assigned sweep race the park gate and re-escalate a
    // deliberate review wait to `blocked` (BLO-16146 recurrence).
    const monitor = derivePersistedMonitorState({
      issue,
      state: parseIssueExecutionState(issue.executionState),
      policy: null,
    });
    return monitor?.status === "triggered";
  }

  type ReviewWaitingParkOutcome = "parked" | "already_parked" | "lost_race" | "failed";

  async function parkReviewWaitingContinuationIssue(input: {
    issue: typeof issues.$inferSelect;
    previousStatus: "in_progress";
    latestRun: LatestIssueRun;
    expectedLockOwnerState?: IssueLockOwnerState | null;
  }): Promise<ReviewWaitingParkOutcome> {
    const result = await db.transaction(async (tx) => {
      await lockIssueOwnership(tx, input.issue.companyId, input.issue.id);

      const [fresh] = await tx
        .select()
        .from(issues)
        .where(eq(issues.id, input.issue.id))
        .limit(1)
        .for("update");
      if (!fresh) return { outcome: "lost_race" as const };
      if (fresh.status === "in_review") return { outcome: "already_parked" as const };
      if (fresh.status !== input.previousStatus || !hasActiveMonitorPath(fresh)) {
        return { outcome: "lost_race" as const };
      }

      // BLO-19160: parking to `in_review` is a status mutation on the handover
      // path just as much as an escalation is, so it takes the same CAS.
      if (
        input.expectedLockOwnerState &&
        !issueLockOwnerStateMatches(input.expectedLockOwnerState, {
          executionRunId: fresh.executionRunId,
          checkoutRunId: fresh.checkoutRunId,
          assigneeAgentId: fresh.assigneeAgentId,
        })
      ) {
        return { outcome: "lost_race" as const };
      }

      let updated: Awaited<ReturnType<typeof issuesSvc.update>>;
      try {
        updated = await issuesSvc.update(
          fresh.id,
          {
            status: "in_review",
            expectedCurrentStatus: input.previousStatus,
            expectedCurrentAssigneeAgentId: fresh.assigneeAgentId,
            expectedCurrentCheckoutRunId: fresh.checkoutRunId,
            expectedCurrentExecutionRunId: fresh.executionRunId,
          },
          tx,
        );
      } catch (error) {
        if (error instanceof HttpError && error.status === 409) {
          return { outcome: "lost_race" as const };
        }
        throw error;
      }
      if (!updated) return { outcome: "lost_race" as const };

      const activeRecoveryAction = await recoveryActionsSvc.resolveActiveForIssue({
        companyId: fresh.companyId,
        sourceIssueId: fresh.id,
        status: "resolved",
        outcome: "restored",
        resolutionNote:
          "Continuation retry was intentionally cancelled because the issue is waiting on review/CI, and the source issue has an active monitor path.",
      }, tx);

      const publish = await logActivity(tx as unknown as Db, {
        companyId: fresh.companyId,
        actorType: "system",
        actorId: "system",
        agentId: null,
        runId: null,
        action: "issue.updated",
        entityType: "issue",
        entityId: fresh.id,
        details: {
          identifier: fresh.identifier,
          status: "in_review",
          previousStatus: input.previousStatus,
          source: "recovery.reconcile_review_waiting_continuation",
          latestRunId: input.latestRun?.id ?? null,
          latestRunStatus: input.latestRun?.status ?? null,
          latestRunErrorCode: input.latestRun?.errorCode ?? null,
          recoveryActionId: activeRecoveryAction?.id ?? null,
        },
      }, { deferPublish: true });

      return { outcome: "parked" as const, publish };
    });
    if (result.outcome === "parked") {
      result.publish();
      return "parked";
    }
    return result.outcome;
  }

  async function parkNoDependencyReviewWaitingIssue(input: {
    issue: typeof issues.$inferSelect;
    previousStatus: "in_progress";
    latestRun: LatestIssueRun;
    expectedLockOwnerState?: IssueLockOwnerState | null;
  }): Promise<ReviewWaitingParkOutcome> {
    // BLO-16146: a continuation that deliberately parked for review/approval, with no
    // dependency to convert into a `blocked` wait (resolveContinuationWaitingOnReview
    // returned null) and no active monitor path (the monitor-path park earlier in the
    // reconcile arm did not fire). Park it `in_review` — the designated "waiting on a
    // reviewer/approver" status — instead of escalating it to `blocked` as if its live
    // execution were lost. It resumes on the next reviewer/approver response (or linked
    // PR update); there is nothing to retry in the meantime. Mirrors
    // parkReviewWaitingContinuationIssue minus the monitor-path requirement, plus a
    // plain-language comment (no monitor path guarantees a re-poke, so the wait must be
    // visible in the thread).
    const result = await db.transaction(async (tx) => {
      await lockIssueOwnership(tx, input.issue.companyId, input.issue.id);

      const [fresh] = await tx
        .select()
        .from(issues)
        .where(eq(issues.id, input.issue.id))
        .limit(1)
        .for("update");
      if (!fresh) return "lost_race";
      if (fresh.status === "in_review") return "already_parked";
      if (fresh.status !== input.previousStatus) return "lost_race";

      if (input.expectedLockOwnerState && !issueLockOwnerStateMatches(input.expectedLockOwnerState, {
        executionRunId: fresh.executionRunId,
        checkoutRunId: fresh.checkoutRunId,
        assigneeAgentId: fresh.assigneeAgentId,
      })) {
        return "lost_race";
      }

      // The in_review transition runs an evidence gate (issues.ts) that throws
      // `unprocessable` when the issue has no reviewable evidence yet (analysis-only
      // work: no PR, branch, or commits). Catch it so a single un-reviewable issue
      // cannot abort the whole recovery sweep — bail and let the caller fall through to
      // `blocked` escalation, the correct disposition when there is nothing to review.
      // Any other transient failure degrades the same safe way.
      let updated: Awaited<ReturnType<typeof issuesSvc.update>>;
      try {
        updated = await issuesSvc.update(
          fresh.id,
          {
            status: "in_review",
            expectedCurrentStatus: input.previousStatus,
            expectedCurrentAssigneeAgentId: fresh.assigneeAgentId,
            expectedCurrentCheckoutRunId: fresh.checkoutRunId,
            expectedCurrentExecutionRunId: fresh.executionRunId,
          },
          tx,
        );
      } catch (err) {
        if (err instanceof HttpError && err.status === 409) return "lost_race";
        logger.warn(
          { err, issueId: fresh.id, identifier: fresh.identifier },
          "parkNoDependencyReviewWaitingIssue: in_review park rejected; escalating instead",
        );
        return "failed";
      }
      if (!updated) return "lost_race";

      const activeRecoveryAction = await recoveryActionsSvc.resolveActiveForIssue({
        companyId: fresh.companyId,
        sourceIssueId: fresh.id,
        status: "resolved",
        outcome: "restored",
        resolutionNote:
          "Continuation retry was intentionally cancelled because the issue is waiting on review/approval " +
          "with no dependency to wait on; parked in_review to await a reviewer/approver response.",
      }, tx);

      await issuesSvc.addComment(
        fresh.id,
        "Paused for review/approval. The latest run reported it was waiting on a reviewer or approver, and there " +
          "is no dependency to wait on — so it is now `in_review` rather than flagged as stuck. It will resume " +
          "automatically when a reviewer or approver responds (or the linked pull request updates); there's nothing " +
          "to retry in the meantime.",
        {},
        { authorType: "system" },
        tx,
      );

      const publish = await logActivity(tx as unknown as Db, {
        companyId: fresh.companyId,
        actorType: "system",
        actorId: "system",
        agentId: null,
        runId: null,
        action: "issue.updated",
        entityType: "issue",
        entityId: fresh.id,
        details: {
          identifier: fresh.identifier,
          status: "in_review",
          previousStatus: input.previousStatus,
          source: "recovery.reconcile_review_waiting_no_dependency_park",
          latestRunId: input.latestRun?.id ?? null,
          latestRunStatus: input.latestRun?.status ?? null,
          latestRunErrorCode: input.latestRun?.errorCode ?? null,
          recoveryActionId: activeRecoveryAction?.id ?? null,
        },
      }, { deferPublish: true });

      return { outcome: "parked" as const, publish };
    });
    if (typeof result === "object" && result.outcome === "parked") result.publish();
    return typeof result === "string" ? result : result.outcome;
  }

  async function existingBlockerIssueIds(companyId: string, issueId: string) {
    return db
      .select({ blockerIssueId: issueRelations.issueId })
      .from(issueRelations)
      .where(
        and(
          eq(issueRelations.companyId, companyId),
          eq(issueRelations.relatedIssueId, issueId),
          eq(issueRelations.type, "blocks"),
        ),
      )
      .then((rows) => rows.map((row) => row.blockerIssueId));
  }

  async function findCycleFormingBlockerIssueIds(
    companyId: string,
    issueId: string,
    blockerIssueIds: string[],
    dbOrTx: Db | DbTransaction = db,
  ) {
    const candidates = new Set(blockerIssueIds);
    const cycleForming = new Set<string>();
    if (candidates.size === 0) return cycleForming;

    const rows = await dbOrTx
      .select({
        blockerIssueId: issueRelations.issueId,
        blockedIssueId: issueRelations.relatedIssueId,
      })
      .from(issueRelations)
      .where(and(eq(issueRelations.companyId, companyId), eq(issueRelations.type, "blocks")));

    const adjacency = new Map<string, string[]>();
    for (const row of rows) {
      const blocked = adjacency.get(row.blockerIssueId) ?? [];
      blocked.push(row.blockedIssueId);
      adjacency.set(row.blockerIssueId, blocked);
    }

    const queue = [...(adjacency.get(issueId) ?? [])];
    const visited = new Set<string>([issueId]);
    while (queue.length > 0 && cycleForming.size < candidates.size) {
      const current = queue.shift()!;
      if (candidates.has(current)) {
        cycleForming.add(current);
      }
      if (visited.has(current)) continue;
      visited.add(current);
      queue.push(...(adjacency.get(current) ?? []));
    }

    return cycleForming;
  }

  async function unresolvedBlockerHumanDecisionEscalationState(
    companyId: string,
    issueId: string,
    dbOrTx: Db | DbTransaction = db,
  ) {
    const blockerRows = await dbOrTx
      .select({
        blockerIssueId: issueRelations.issueId,
        assigneeAgentId: issues.assigneeAgentId,
        assigneeUserId: issues.assigneeUserId,
      })
      .from(issueRelations)
      .innerJoin(
        issues,
        and(
          eq(issues.companyId, issueRelations.companyId),
          eq(issues.id, issueRelations.issueId),
        ),
      )
      .where(
        and(
          eq(issueRelations.companyId, companyId),
          eq(issueRelations.relatedIssueId, issueId),
          eq(issueRelations.type, "blocks"),
          notInArray(issues.status, ["done", "cancelled"]),
        ),
      );

    const blockerIssueIds = blockerRows.map((row) => row.blockerIssueId);
    const needsHumanDecision = blockerRows.length === 0 || blockerRows.every(
      (row) => row.assigneeAgentId && !row.assigneeUserId,
    );
    return { blockerIssueIds, needsHumanDecision };
  }

  async function emitNeedsHumanDecisionEscalationEvent(input: {
    issue: typeof issues.$inferSelect;
    assigneeAgentName: string | null;
    blockedByIssueIds: string[];
  }) {
    const transitionedAt = new Date().toISOString();
    await logActivity(db, {
      companyId: input.issue.companyId,
      actorType: "system",
      actorId: "system",
      agentId: null,
      runId: null,
      action: "issue.escalation.needs_human_decision",
      entityType: "issue",
      entityId: input.issue.id,
      details: {
        issueId: input.issue.id,
        identifier: input.issue.identifier,
        title: input.issue.title,
        assigneeAgentId: input.issue.assigneeAgentId,
        assigneeAgentName: input.assigneeAgentName,
        blockedByIssueIds: input.blockedByIssueIds,
        originSweep: "recovery.reconcile_stranded_assigned_issue",
        transitionedAt,
      },
    });
  }

  async function existingUnresolvedBlockerIssues(
    companyId: string,
    issueId: string,
    dbOrTx: Db | DbTransaction = db,
  ) {
    return dbOrTx
      .select({ id: issues.id, identifier: issues.identifier })
      .from(issueRelations)
      .innerJoin(
        issues,
        and(
          eq(issues.companyId, issueRelations.companyId),
          eq(issues.id, issueRelations.issueId),
        ),
      )
      .where(
        and(
          eq(issueRelations.companyId, companyId),
          eq(issueRelations.relatedIssueId, issueId),
          eq(issueRelations.type, "blocks"),
          notInArray(issues.status, ["done", "cancelled"]),
        ),
      );
  }

  // BLO-19160: `expectedLockOwnerState` is the handover-observation CAS. This
  // helper mutates the issue to `blocked` and writes blocker relations, so it
  // is an escalation side effect exactly like `escalateStrandedAssignedIssue`
  // even though it is not one of the four enqueue/escalate helpers — which is
  // precisely how the original "all N call sites guarded" audit missed it. Any
  // audit of this path has to enumerate *mutations*, not helper names.
  async function resolveContinuationWaitingOnReview(
    issue: typeof issues.$inferSelect,
    expectedLockOwnerState?: IssueLockOwnerState | null,
  ) {
    const result = await db.transaction(async (tx) => {
      await lockIssueOwnership(tx, issue.companyId, issue.id);
      // All issue-graph writers take this company lock before issue row locks.
      // Holding it across blocker discovery, cycle filtering, and the update
      // makes the dependency decision atomic with the relation mutation.
      await lockIssueParentMutationCompany(issue.companyId, tx);
      const [fresh] = await tx
        .select()
        .from(issues)
        .where(and(eq(issues.companyId, issue.companyId), eq(issues.id, issue.id)))
        .limit(1)
        .for("update");
      if (!fresh || fresh.status !== issue.status) return null;
      if (
        expectedLockOwnerState &&
        !issueLockOwnerStateMatches(expectedLockOwnerState, {
          executionRunId: fresh.executionRunId,
          checkoutRunId: fresh.checkoutRunId,
          assigneeAgentId: fresh.assigneeAgentId,
        })
      ) return null;

      const existingBlockers = await existingUnresolvedBlockerIssues(fresh.companyId, fresh.id, tx);
      const openChildren = await tx
        .select({ id: issues.id, identifier: issues.identifier })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, fresh.companyId),
            eq(issues.parentId, fresh.id),
            visibleIssueCondition(),
            notInArray(issues.status, ["done", "cancelled"]),
          ),
        );
      const blockerRowsById = new Map<string, { id: string; identifier: string | null; source: string }>();
      for (const row of existingBlockers) {
        blockerRowsById.set(row.id, { ...row, source: "existing_unresolved_blocker" });
      }
      for (const row of openChildren) {
        if (!blockerRowsById.has(row.id)) {
          blockerRowsById.set(row.id, { ...row, source: "open_child" });
        }
      }

      let blockedByIssueIds = [...blockerRowsById.keys()];
      if (blockedByIssueIds.length === 0) return null;
      const cycleFormingBlockerIds = await findCycleFormingBlockerIssueIds(
        fresh.companyId,
        fresh.id,
        blockedByIssueIds,
        tx,
      );
      if (cycleFormingBlockerIds.size > 0) {
        const skippedBlockers = [...cycleFormingBlockerIds]
          .map((id) => blockerRowsById.get(id))
          .filter((row): row is { id: string; identifier: string | null; source: string } => Boolean(row));
        logger.warn(
          {
            companyId: fresh.companyId,
            issueId: fresh.id,
            identifier: fresh.identifier,
            skippedBlockerIssueIds: skippedBlockers.map((row) => row.id),
            skippedBlockerIdentifiers: skippedBlockers.map((row) => row.identifier).filter(Boolean),
            skippedBlockerSources: skippedBlockers.map((row) => ({ id: row.id, source: row.source })),
          },
          "skipping cycle-forming review-wait blocker relations",
        );
        blockedByIssueIds = blockedByIssueIds.filter((id) => !cycleFormingBlockerIds.has(id));
        if (blockedByIssueIds.length === 0) return null;
      }

      let updated: Awaited<ReturnType<typeof issuesSvc.update>>;
      try {
        await deps.beforeContinuationReviewBlockerUpdateForTest?.({
          issueId: fresh.id,
          blockedByIssueIds,
        });
        updated = await issuesSvc.update(
          fresh.id,
          {
            status: "blocked",
            blockedByIssueIds,
            expectedCurrentStatus: fresh.status,
            expectedCurrentAssigneeAgentId: fresh.assigneeAgentId,
            expectedCurrentCheckoutRunId: fresh.checkoutRunId,
            expectedCurrentExecutionRunId: fresh.executionRunId,
          },
          tx,
        );
      } catch (error) {
        if (!isBlockingRelationCycleError(error)) throw error;
        logger.warn(
          {
            companyId: fresh.companyId,
            issueId: fresh.id,
            identifier: fresh.identifier,
            blockedByIssueIds,
          },
          "review-wait blocker write raced a concurrent relation update and formed a cycle; parking without dependency",
        );
        return null;
      }
      if (!updated) return null;

      const waitingOn = formatIssueLinksForComment(
        blockedByIssueIds
          .map((id) => blockerRowsById.get(id))
          .filter((row): row is { id: string; identifier: string | null; source: string } => Boolean(row)),
      );
      await issuesSvc.addComment(
        fresh.id,
        `This task is waiting on ${waitingOn} to finish. ` +
          "It will continue automatically when that work is done - there's nothing you need to do. " +
          "(It was paused because the latest run reported it was waiting for review/approval; " +
          "Paperclip turned that into a normal dependency wait instead of flagging it as stuck.)",
        {},
        { authorType: "system" },
        tx,
      );
      const publish = await logActivity(tx as unknown as Db, {
        companyId: fresh.companyId,
        actorType: "system",
        actorId: "system",
        agentId: null,
        runId: null,
        action: "issue.updated",
        entityType: "issue",
        entityId: fresh.id,
        details: {
          identifier: fresh.identifier,
          status: "blocked",
          previousStatus: issue.status,
          source: "recovery.reconcile_continuation_waiting_on_review",
          blockedByIssueIds,
        },
      }, { deferPublish: true });
      return { updated, publish };
    });
    if (!result) return null;
    result.publish();
    return result.updated;
  }

  // BLO-19954: cancel a routine-execution issue whose only run was suppressed
  // as a dispatch-lock duplicate, instead of escalating it. `cancelled` is the
  // correct terminal status — the issue performed no scan and never will, the
  // lock owner is already continuing the work — so there is nothing for a
  // recovery owner to repair and no wake to raise.
  async function cancelDuplicateSuppressedRoutineExecutionIssue(
    issue: typeof issues.$inferSelect,
    latestRun: LatestIssueRun,
  ) {
    const result = await db.transaction(async (tx) => {
      await lockIssueOwnership(tx, issue.companyId, issue.id);

      const [fresh] = await tx
        .select()
        .from(issues)
        .where(and(eq(issues.companyId, issue.companyId), eq(issues.id, issue.id)))
        .limit(1)
        .for("update");
      if (!fresh || isTerminalIssueStatus(fresh.status)) return null;

      // BLO-27572: explicitly suppress the scheduler-side failure heartbeat that
      // the ordinary cancellation transition now posts. This is the one
      // cancellation that must stay silent: the window is NOT dark, because
      // another open execution issue already owns the dispatch lock and is doing
      // the work. A receipt here would manufacture a false dark-window alarm.
      let updated: Awaited<ReturnType<typeof issuesSvc.update>>;
      try {
        updated = await issuesSvc.update(
          fresh.id,
          {
            status: "cancelled",
            suppressRoutineSchedulerFailureHeartbeat: true,
            expectedCurrentStatus: fresh.status,
            expectedCurrentAssigneeAgentId: fresh.assigneeAgentId,
            expectedCurrentCheckoutRunId: fresh.checkoutRunId,
            expectedCurrentExecutionRunId: fresh.executionRunId,
          },
          tx,
        );
      } catch (error) {
        // A concurrent owner/status writer won after the recovery snapshot. This
        // duplicate is no longer ours to cancel; importantly, do not append the
        // cancellation activity or comment for a mutation that did not happen.
        if (error instanceof HttpError && error.status === 409) return null;
        throw error;
      }
      if (!updated) return null;

      const publish = await logActivity(tx as unknown as Db, {
        companyId: fresh.companyId,
        actorType: "system",
        actorId: "system",
        agentId: null,
        runId: null,
        action: "issue.updated",
        entityType: "issue",
        entityId: fresh.id,
        details: {
          identifier: fresh.identifier,
          status: "cancelled",
          previousStatus: fresh.status,
          source: "recovery.routine_execution_duplicate_suppressed",
          latestRunId: latestRun?.id ?? null,
          latestRunErrorCode: latestRun?.errorCode ?? null,
        },
      }, { deferPublish: true });

      await issuesSvc.addComment(
        fresh.id,
        "Paperclip cancelled this routine-execution issue instead of escalating it to `blocked`. Its run was " +
          `cancelled with \`${ROUTINE_EXECUTION_DUPLICATE_SUPPRESSED_ERROR_CODE}\` because another open ` +
          "routine-execution issue already owns this dispatch lock. Under `always_enqueue` with a single-owner " +
          "dispatcher, that is expected, intentional control flow — the lock owner continues the work. This issue " +
          "performed no scan and never will, so no recovery action or owner wake was raised.",
        {},
        { authorType: "system" },
        tx,
      );

      return { updated, publish };
    });
    if (!result) return null;
    result.publish();
    return result.updated;
  }

  // BLO-27463: incremented by the dependency-wait gate inside
  // `escalateStrandedAssignedIssue`, which has 20 call sites and no `result` in scope.
  // `reconcileStrandedAssignedIssues` snapshots and diffs it rather than threading an
  // out-param through every caller. Diagnostic only: two overlapping sweeps would split
  // the delta between them, which does not affect any control-flow decision.
  //
  // Invariant the snapshot/diff accounting depends on: every
  // `escalateStrandedAssignedIssue` call site is lexically inside
  // `reconcileStrandedAssignedIssues`. If a caller is ever added outside that sweep, its
  // increments land in whichever sweep happens to be open and the delta silently
  // misattributes — thread an explicit counter at that point instead of widening this one.
  let dependencyWaitEscalationSuppressedTotal = 0;

  async function escalateStrandedAssignedIssue(input: {
    issue: typeof issues.$inferSelect;
    previousStatus: StrandedPreviousStatus;
    latestRun: LatestIssueRun;
    comment?: string;
    recoveryCause?: StrandedRecoveryCause;
    recoveryOwnerAgentId?: string | null;
    expectedReviewStage?: {
      stageId: string;
      participantAgentId: string;
      executionRunId: string | null;
    };
    successfulRunHandoffEvidence?: SuccessfulRunHandoffRecoveryEvidence | null;
    // BLO-19160: when this escalation follows a checkout-handover observation,
    // the lock/owner values it was decided on. Re-checked below against the
    // in-transaction re-read, before any side effect — so a *detected* race
    // takes no escalation or reassignment side effect. It is NOT a
    // mutation-time CAS; see the limitation note at that check.
    expectedLockOwnerState?: IssueLockOwnerState | null;
  }) {
    // `isRoutineExecutionDuplicateSuppressedRun` is a type predicate, so the
    // negative branch below narrows `input.latestRun` all the way to `null`.
    // Capture the unnarrowed value first — the scheduler receipt still needs its
    // error code further down.
    const latestRunForReceipt: LatestIssueRun = input.latestRun;

    if (isRoutineExecutionDuplicateSuppressedRun(input.latestRun)) {
      return cancelDuplicateSuppressedRoutineExecutionIssue(input.issue, input.latestRun);
    }

    if (isStrandedIssueRecoveryIssue(input.issue)) {
      return escalateStrandedRecoveryIssueInPlace({
        issue: input.issue,
        previousStatus: input.previousStatus,
        latestRun: input.latestRun,
        expectedLockOwnerState: input.expectedLockOwnerState,
      });
    }

    // Serialize escalation per (company, source-issue) so concurrent
    // reconcile sweeps don't fight over the same recovery-action upsert,
    // wakeup, and source-issue UPDATE.
    // The advisory lock is xact-scoped on this tx's connection; once we
    // commit/return, waiting peers wake up and record their next attempt
    // against the same active source-scoped action.
    const escalation = await db.transaction(async (tx) => {
      await lockIssueOwnership(tx, input.issue.companyId, input.issue.id);

      // Re-read source issue under the lock so the recovery action records
      // the latest owner/status evidence and repeated sweeps reuse the same
      // source-scoped action instead of creating issue-backed fallbacks.
      // BLO-19160: the handover decision and every durable mutation that depends on it
      // must share this transaction. The checkout/adoption paths take the same advisory
      // lock, so an adoption either commits before this read (and is observed here) or
      // waits until this transaction commits. The row lock then keeps non-advisory issue
      // writers from changing the ownership snapshot while the recovery mutation runs.
      // Keep all issue/action/comment/activity writes on `tx`; using the pooled `db` here
      // would self-block on the row lock while this callback is awaiting that other query.
      // Match `issuesSvc.update`'s graph-lock order: ownership arbitration,
      // company graph lock, then the issue row. Taking the row first here and
      // the graph lock inside `update` would invert against a concurrent
      // blocker/parent mutation (which takes the graph lock before its row).
      await lockIssueParentMutationCompany(input.issue.companyId, tx);
      const freshQuery = tx
        .select()
        .from(issues)
        .where(eq(issues.id, input.issue.id))
        .limit(1);
      const [fresh] = await freshQuery.for("update");
      if (!fresh) return null;
      // BLO-18643: mirror the park paths' own re-check (parkReviewWaitingContinuationIssue /
      // parkNoDependencyReviewWaitingIssue both bail if `fresh.status` has moved past the
      // status the candidate was read at). Without this, a park that committed first --
      // under the same per-issue advisory lock, whether from a concurrent transaction or an
      // earlier sweep pass -- gets silently clobbered back to `blocked` here. Whichever side
      // reaches its expected-status re-check second is now a no-op.
      //
      // `blocked` is explicitly allowed through in addition to `previousStatus`: it's this
      // function's own steady-state output, and repeated/concurrent escalation attempts on an
      // already-`blocked` issue are expected to keep updating the same active recovery action
      // (attempt-count bookkeeping, wake suppression) rather than no-op. Only a status this
      // function did NOT produce -- e.g. `in_review` from a park that raced it -- is a signal
      // that some other terminal action already claimed this issue for this cause.
      if (input.expectedReviewStage) {
        const executionState = parseIssueExecutionState(fresh.executionState);
        const participant = executionState?.status === "pending"
          ? executionState.currentParticipant
          : null;
        if (
          fresh.status !== "in_review" ||
          executionState?.currentStageId !== input.expectedReviewStage.stageId ||
          participant?.type !== "agent" ||
          participant.agentId !== input.expectedReviewStage.participantAgentId ||
          fresh.executionRunId !== input.expectedReviewStage.executionRunId
        ) {
          logger.info(
            {
              issueId: fresh.id,
              expectedReviewStage: input.expectedReviewStage,
              actualStatus: fresh.status,
              actualStageId: executionState?.currentStageId ?? null,
              actualParticipantAgentId: participant?.type === "agent" ? participant.agentId : null,
              actualExecutionRunId: fresh.executionRunId,
            },
            "skipping stale review-stage recovery escalation",
          );
          return null;
        }
      } else if (fresh.status !== input.previousStatus && fresh.status !== "blocked") return null;

      // BLO-27463: a terminal `issue_dependencies_blocked` run on the *assignee's own
      // execution* is a wait state, never a stranded execution path (see
      // DEPENDENCY_BLOCKED_ERROR_CODE), so it must not open a stranded_assigned_issue
      // action or move ownership up the org chain — regardless of whether the blockers
      // have since cleared.
      //
      // This previously only refused escalation while the issue was *still* not
      // dependency-ready. That predicate cannot fire on the population that actually
      // escalates: heartbeat.ts restores the issue to its pre-checkout status when the
      // dep-blocked retry budget exhausts, so by the time the sweep sees it the
      // blockers have resolved or never existed, and the readiness re-check passes.
      // Measured against the CEO inbox 2026-08-18, of the 24 escalations opened since
      // the readiness guards landed on 2026-08-09: 24/24 had zero unresolved blockers,
      // 23/24 were reassigned up the org chain, and 24/24 came to rest in `blocked`
      // with an empty blocker set — permanently undispatchable per BLO-21523.
      //
      // 14 of those 24 were provider rate-limit/quota parks carrying this error code
      // ("surfaced as `issue_dependencies_blocked`"), which BLO-19889 AC#2 classes as
      // infra-class and equally non-escalating. Refusing on the error code covers both
      // populations at the single gate every escalation caller passes through.
      //
      // Skipping is safe for that population two ways: a dependency-ready issue is left
      // in a dispatchable status for the normal scheduler, and a still-blocked one
      // retains its edge-triggered dependency-resolved wake.
      //
      // Review-participant strands are deliberately excluded, because neither of
      // those safety arguments holds for them. Four of the five review-participant
      // call sites below reach here with a *terminal participant run*, and because
      // DEPENDENCY_BLOCKED_ERROR_CODE is a member of
      // NON_RETRYABLE_CONTINUATION_ERROR_CODES the non-retryable branch catches it
      // first. An `in_review` issue with a pending stage is not re-dispatched by the
      // normal scheduler; and when its blockers have already cleared there is no
      // dependency wake left to retain, because the wait is on the *participant*, not
      // on a dependency. On the `!agentInvokable` branch the participant provably
      // cannot be invoked, so suppressing here would leave the stage with no recovery
      // path at all, silently re-skipped every sweep — strictly worse than the
      // escalation this gate removes, and reachable in production because
      // `claimQueuedRun`'s dependency gate cancels *any* queued run for the issue,
      // participant wakes included. The measurement above covers the
      // assignee-execution population only; whether an `in_review` dependency wait
      // should also stop escalating is a separate question that needs its own evidence.
      //
      // `recoveryOwnerAgentId == null` is that exclusion stated exactly, rather than
      // proxied through `previousStatus !== "in_review"`. All five review-participant sites
      // pass `recoveryOwnerAgentId: participantAgentId`, which the guard at the top of the
      // `issue.status === "in_review"` block has already narrowed to a non-null string; no
      // assignee-lane site passes the field at all. The status proxy was broader than its
      // own justification: three assignee-lane sites forward `previousStatus: issue.status`
      // and `in_review` is a member of STRANDED_ASSIGNED_ISSUE_STATUSES, so it exempted
      // them too.
      //
      // The two predicates are not currently distinguishable in practice. BLO-19123's F2
      // (`3830d7bc`) added an earlier arm keyed on `errorCode === DEPENDENCY_BLOCKED &&
      // (status === "in_review" || !agentInvokable)` that `continue`s before this gate is
      // reached, so no `in_review` strand of either lane arrives here. This gate therefore
      // covers the remaining and much larger population: `todo`/`in_progress` issues with
      // an invokable assignee, which that arm does not match. The exact form is kept
      // regardless — it states the intent instead of encoding an assumption about an
      // upstream arm that may later narrow.
      if (input.recoveryOwnerAgentId == null && input.latestRun?.errorCode === DEPENDENCY_BLOCKED_ERROR_CODE) {
        // Diagnostic only, but worth the lock-held round-trip: `isDependencyReady`
        // is what separates a still-blocked wait from the defect-shaped
        // "dependency-blocked with nothing blocking it" arm, and that distinction is
        // the visibility this gate trades the escalation for.
        const readiness = await issuesSvc
          .listDependencyReadiness(fresh.companyId, [fresh.id], tx)
          .then((rows) => rows.get(fresh.id));
        dependencyWaitEscalationSuppressedTotal += 1;
        logger.info(
          {
            issueId: fresh.id,
            issueStatus: fresh.status,
            latestRunId: input.latestRun?.id ?? null,
            isDependencyReady: readiness?.isDependencyReady ?? null,
            unresolvedBlockerCount: readiness?.unresolvedBlockerCount ?? null,
          },
          "skipping stranded escalation for dependency-wait terminal run",
        );
        return null;
      }

      // BLO-19160: re-check the handover evidence under the same lock before
      // creating recovery state. This remains useful for callers whose candidate
      // snapshot is already stale; the advisory/row lock closes the mutation-time
      // race with checkout adoption.
      if (
        input.expectedLockOwnerState &&
        !issueLockOwnerStateMatches(input.expectedLockOwnerState, {
          executionRunId: fresh.executionRunId,
          checkoutRunId: fresh.checkoutRunId,
          assigneeAgentId: fresh.assigneeAgentId,
        })
      ) {
        return null;
      }

      const recoveryCause = resolveStrandedRecoveryCause(input.latestRun, input.recoveryCause);
      const {
        blockerIssueIds: blockerIds,
        needsHumanDecision,
      } = await unresolvedBlockerHumanDecisionEscalationState(fresh.companyId, fresh.id, tx);
      const { action, hasNewActivitySinceLastAttempt, unchangedOwnerless } = await ensureSourceScopedStrandedRecoveryAction({
        issue: fresh,
        previousStatus: input.previousStatus,
        latestRun: input.latestRun,
        recoveryCause,
        recoveryOwnerAgentId: input.recoveryOwnerAgentId,
        successfulRunHandoffEvidence: input.successfulRunHandoffEvidence,
        blockerIssueIds: blockerIds,
      }, tx);
      if (unchangedOwnerless) return null;
      const isProviderQuotaWait = recoveryCause === "provider_quota" &&
        !action.ownerAgentId && Boolean(action.returnOwnerAgentId);

      // Wakes and quota monitors are intentionally deferred until after commit.
      // Both can write issue/run state through another pooled connection and must
      // never publish work for a transaction that later rolls back.

      // BLO-27635: the `blocked`-with-no-blocker signature. See
      // `resolveStrandedEscalationStatus` for the full rationale; in short, a strand
      // with no recovery owner, no quota-monitor park, and no blocker edge is a
      // CAPACITY condition rather than a dependency, and writing `blocked` for it
      // froze a transient state into a permanent park that neither
      // `reconcileStrandedAssignedIssues` (status filter) nor the BLO-21523
      // reconciler (active-recovery-action suppression) will ever drain. Leave such a
      // row dispatchable so it self-heals when capacity returns, and keep every other
      // escalation side effect (recovery action, board-escalation comment, activity
      // record) so the strand stays visible.
      const { status: escalatedStatus, hasNoRecoveryPath } = resolveStrandedEscalationStatus({
        currentStatus: fresh.status,
        recoveryOwnerAgentId: action.ownerAgentId ?? null,
        isProviderQuotaWait,
        blockerIssueIds: blockerIds,
        recoveryCause,
      });

      const issueUpdate = {
        status: escalatedStatus,
        blockedByIssueIds: blockerIds,
        assigneeAgentId: action.ownerAgentId ?? fresh.assigneeAgentId,
        expectedCurrentStatus: fresh.status,
        // Keep the assignee snapshot as a belt-and-braces write precondition.
        expectedCurrentAssigneeAgentId: fresh.assigneeAgentId,
      };
      // Any failed precondition rolls back the action and comments together with
      // this issue update, so no partial recovery state escapes the transaction.
      const updated = await issuesSvc.update(input.issue.id, issueUpdate, tx);
      if (!updated) throw new RecoveryEscalationRollback();
      if (isProviderQuotaWait) {
        return {
          updated,
          action,
          fresh,
          recoveryCause,
          hasNewActivitySinceLastAttempt,
          needsHumanDecision,
          blockerIds,
          // BLO-21395: `null` suppresses the scheduler-side failure heartbeat. A provider
          // capacity park is not a strand the system has committed to — it may still
          // self-heal on retry — so emitting here would post a dark-window receipt about a
          // window that is very likely still live. Non-null on the stranding path below.
          schedulerFailureHeartbeat: null,
        };
      }

      const prefix = await getCompanyIssuePrefix(fresh.companyId);
      const workspacePreflightHandoffCause = describeWorkspacePreflightRecoveryCause(input.latestRun);
      const recoveryOwner = action.ownerAgentId ? await getAgent(action.ownerAgentId) : null;
      const sourceAssignee = fresh.assigneeAgentId ? await getAgent(fresh.assigneeAgentId) : null;
      let notice: SuccessfulRunHandoffNotice | null = null;
      if (recoveryCause === SUCCESSFUL_RUN_MISSING_STATE_REASON && input.successfulRunHandoffEvidence) {
        notice = buildSuccessfulRunHandoffExhaustedNotice({
          issue: fresh,
          sourceRun: input.successfulRunHandoffEvidence.sourceRunId
            ? { id: input.successfulRunHandoffEvidence.sourceRunId, status: "succeeded" }
            : null,
          correctiveRun: input.latestRun ? { id: input.latestRun.id, status: input.latestRun.status } : null,
          sourceAssignee,
          recoveryIssue: null,
          recoveryActionId: action.id,
          recoveryOwner,
          latestIssueStatus: fresh.status,
          latestHandoffRunStatus: input.latestRun?.status ?? "unknown",
          missingDisposition: input.successfulRunHandoffEvidence.missingDisposition,
        });
      }
      // BLO-18860: a recovery escalation that moves the issue to a NEW owner is
      // a transfer of write access away from the previous assignee — after it,
      // that agent's `allow_self` grant is gone and its next PATCH/comment on
      // the issue 403s. Make the transfer legible in the issue history (naming
      // the recovery action AND the cause) instead of only in
      // `activeRecoveryAction`, so the previous owner and any reader can see
      // who owns it now and why. `fresh` was read before the status/assignee
      // update below, so its `assigneeAgentId` is the pre-transfer owner.
      const reassignsAssignee = Boolean(
        action.ownerAgentId && action.ownerAgentId !== fresh.assigneeAgentId,
      );
      // Stable dedup key for the transfer announcement: one comment per
      // (recovery action, new owner), so a repeated escalation to the SAME
      // owner stays silent while a transfer to a new owner is always announced.
      const reassignmentMarker = `Reassigned by recovery action \`${action.id}\` to owner \`${action.ownerAgentId}\``;
      const recoveryLine = action.ownerAgentId
        ? [
          "",
          `- Recovery action: \`${action.id}\` (cause \`${recoveryCause}\`, attempt ${action.attemptCount})`,
          `- Recovery owner: ${agentUiLink(recoveryOwner, prefix)}`,
          ...(reassignsAssignee
            ? [
              `- ${reassignmentMarker}: taken over from ${agentUiLink(sourceAssignee, prefix)}, which can no longer PATCH or comment on this issue as its assignee.`,
            ]
            : []),
          workspacePreflightHandoffCause
            ? `- Next action: ${workspacePreflightHandoffCause}`
            : "- Next action: the recovery owner should restore a live execution path, fix the runtime/adapter failure, or record an intentional manual resolution.",
        ].join("\n")
        : [
          "",
          `- Recovery action: \`${action.id}\` (cause \`${recoveryCause}\`, attempt ${action.attemptCount})`,
          "- Recovery owner: board escalation, because Paperclip could not find an invokable manager, creator, or executive owner with budget available.",
          // BLO-27635: say which status this left behind. When there is no owner AND no
          // blocker edge the row is deliberately NOT parked in `blocked` — it stays
          // dispatchable so it resumes on its own once an owner becomes invokable.
          ...(hasNoRecoveryPath
            ? [
              `- Issue status: left \`${escalatedStatus}\` rather than \`blocked\`, because no owner and no blocker edge means a \`blocked\` park here would never be re-swept or drained. It will dispatch again on its own once an invokable owner with budget exists.`,
            ]
            : []),
          "- Next action: a board operator should assign an invokable recovery owner, fix the agent/runtime state, or record an intentional manual resolution.",
        ].join("\n");

      // A later attempt normally stays silent (one comment per action), but a
      // reassignment on that attempt must still be announced. The notice path
      // keeps its own metadata-based dedup, so leave it on the original gate.
      const announcesReassignment = reassignsAssignee && !notice;
      const shouldPostEscalationComment =
        action.attemptCount === 1 ||
        recoveryCause === "workspace_validation_failed" ||
        recoveryCause === "configuration_incomplete" ||
        announcesReassignment;
      if (shouldPostEscalationComment) {
        const escalationCommentMarker = announcesReassignment
          ? reassignmentMarker
          : `Recovery action: \`${action.id}\``;
        const hasEscalationComment = await tx
          .select({ id: issueComments.id, body: issueComments.body, metadata: issueComments.metadata })
          .from(issueComments)
          .where(and(eq(issueComments.issueId, fresh.id), eq(issueComments.authorType, "system")))
          .orderBy(desc(issueComments.createdAt))
          .limit(50)
          .then((rows) =>
            rows.some((row) =>
              (row.body ?? "").includes(escalationCommentMarker) ||
              noticeMetadataReferencesRecoveryAction(row.metadata, action.id),
            ),
          );

        if (!hasEscalationComment) {
          if (notice) {
            await issuesSvc.addComment(fresh.id, notice.body, {}, {
              authorType: "system",
              presentation: notice.presentation,
              metadata: notice.metadata,
            }, tx);
          } else {
            await issuesSvc.addComment(
              fresh.id,
              `${input.comment ?? "Automatic stranded-work recovery needs manual attention."}${recoveryLine}`,
              {},
              { authorType: "system" },
              tx,
            );
          }
        }
      }

      // BLO-18996: the wake budget is spent, so no further sweep will wake anyone for
      // this action. Say so once, on the source issue, rather than letting the loop go
      // quiet with no explanation — a silent stop reads exactly like a silent re-fire to
      // whoever is looking at the issue. Keyed on the action id so it lands once per
      // action, not once per subsequent sweep.
      if (strandedRecoveryWakeAttemptsExhausted(action)) {
        // Which bound stopped it, because the operator's next move differs: a spent
        // per-owner budget can be restored by handing the action to a different owner, but
        // the horizon cannot be restored at all — that action is done being auto-worked.
        const attemptBudgetSpent = action.attemptCount > (action.maxAttempts ?? Infinity);
        // Key the dedup marker on whatever starts a new sequence for the bound that fired.
        // The row is reused across reassignments (`upsertSourceScoped` updates the active row
        // in place), so an id-only marker would suppress this notice forever after the first
        // exhaustion — including for a later owner whose budget legitimately reset and was
        // then spent again, hence the owner in the attempt-budget key. The horizon is the
        // opposite case: it fires once and stays fired while ownership churns underneath, so
        // keying it on the owner would re-announce on every ping-pong sweep. Key it on the
        // horizon instant, which is fixed for the life of the action.
        const exhaustionMarker = attemptBudgetSpent
          ? `Recovery wake budget exhausted for action \`${action.id}\` (owner \`${action.ownerAgentId ?? "unassigned"}\`)`
          : `Recovery wake horizon reached for action \`${action.id}\` (horizon \`${
            action.timeoutAt instanceof Date ? action.timeoutAt.toISOString() : String(action.timeoutAt)
          }\`)`;
        // Exact, unbounded marker lookup — deliberately NOT a "scan the latest N comments"
        // window. This notice fires at the END of an action's life, which is precisely when
        // the source issue has accumulated the most automation chatter, so a bounded window
        // is guaranteed to age the marker out and let a later sweep re-announce the same
        // exhaustion. Filtered by issue + author in SQL and capped at one row, so it costs
        // an index seek rather than the 50-row fetch it replaces.
        const alreadyAnnounced = await tx
          .select({ id: issueComments.id })
          .from(issueComments)
          .where(and(
            eq(issueComments.issueId, fresh.id),
            eq(issueComments.authorType, "system"),
            sql`${issueComments.body} LIKE ${`%${escapeLikePattern(exhaustionMarker)}%`} ESCAPE '\\'`,
          ))
          .limit(1)
          .then((rows) => rows.length > 0);
        if (!alreadyAnnounced) {
          await issuesSvc.addComment(
            fresh.id,
            [
              `${exhaustionMarker}.`,
              "",
              attemptBudgetSpent
                ? `Paperclip woke the recovery owner ${action.maxAttempts} times without this action being ` +
                  "discharged, so it has stopped waking anyone for it. The action stays open and needs a human " +
                  "or a board operator to resolve it."
                : "This recovery action passed its auto-recovery horizon without being discharged, so Paperclip " +
                  "has stopped waking anyone for it. Recovery ownership was being reassigned faster than any one " +
                  "owner could spend its attempt budget, which is why the attempt count below is low. The action " +
                  "stays open and needs a human or a board operator to resolve it.",
              "",
              `- Recovery owner: ${agentUiLink(recoveryOwner, prefix)}`,
              `- Attempts: ${action.attemptCount} (budget ${action.maxAttempts})`,
              `- Auto-recovery horizon: ${
                action.timeoutAt instanceof Date ? action.timeoutAt.toISOString() : String(action.timeoutAt ?? "none")
              }`,
              `- Cause: \`${recoveryCause}\``,
              attemptBudgetSpent
                ? "- Next action: discharge or cancel this recovery action, reassign the source issue, or record an " +
                  "intentional manual resolution. Handing the action to a different recovery owner starts a fresh " +
                  "attempt sequence and restores the wake budget; re-running it against the same owner does not."
                : "- Next action: discharge or cancel this recovery action, or record an intentional manual " +
                  "resolution. Reassigning will NOT restore the wake budget — the horizon above is fixed for the " +
                  "life of the action, so a new owner does not get fresh attempts.",
            ].join("\n"),
            {},
            { authorType: "system" },
            tx,
          );
        }
      }

      const publishEscalationActivity = await logActivity(tx as unknown as Db, {
        companyId: fresh.companyId,
        actorType: "system",
        actorId: "system",
        agentId: null,
        runId: null,
        action: recoveryCause === SUCCESSFUL_RUN_MISSING_STATE_REASON
          ? "issue.successful_run_handoff_escalated"
          : "issue.updated",
        entityType: "issue",
        entityId: fresh.id,
        details: {
          identifier: fresh.identifier,
          status: escalatedStatus,
          previousStatus: input.previousStatus,
          // BLO-27635: the before/after pair for THIS write. `previousStatus` above is
          // the caller's classification of how the row was categorised on entry, not the
          // row's own prior status, so it cannot answer "what did this escalation
          // change". `recoveryPathAbsent` makes the rows diverted away from `blocked`
          // queryable without re-deriving the three-way predicate from owner/blocker
          // fields.
          statusBefore: fresh.status,
          statusAfter: escalatedStatus,
          recoveryPathAbsent: hasNoRecoveryPath,
          source: recoveryCause === SUCCESSFUL_RUN_MISSING_STATE_REASON
            ? "recovery.reconcile_successful_run_handoff_missing_state"
            : recoveryCause === "workspace_validation_failed"
              ? "recovery.reconcile_workspace_validation_failed"
              : recoveryCause === "configuration_incomplete"
                ? "recovery.reconcile_configuration_incomplete"
                : recoveryCause === "execution_review_participant_recovery"
                  ? "recovery.reconcile_execution_review_participant"
              : "recovery.reconcile_stranded_assigned_issue",
          recoveryCause,
          latestRunId: input.latestRun?.id ?? null,
          latestRunStatus: input.latestRun?.status ?? null,
          latestRunErrorCode: input.latestRun?.errorCode ?? null,
          recoveryActionId: action.id,
          recoveryActionAttemptCount: action.attemptCount,
          // BLO-18996: the fields a "which recovery actions have stopped making progress"
          // query needs, without having to join the actions table. `attemptCount` alone is
          // not enough to spot a stalled action, because owner churn keeps it near 1 — the
          // horizon is what identifies that class.
          recoveryActionMaxAttempts: action.maxAttempts,
          recoveryWakeBudgetExhausted: strandedRecoveryWakeAttemptsExhausted(action),
          recoveryWakeHorizonAt: action.timeoutAt instanceof Date
            ? action.timeoutAt.toISOString()
            : action.timeoutAt ?? null,
          recoveryOwnerAgentId: action.ownerAgentId,
          previousOwnerAgentId: action.previousOwnerAgentId,
          returnOwnerAgentId: action.returnOwnerAgentId,
          blockerIssueIds: blockerIds,
        },
      }, {
        // The activity row is transactional; publish only after its commit.
        deferPublish: true,
      });

      return {
        updated,
        action,
        fresh,
        recoveryCause,
        hasNewActivitySinceLastAttempt,
        needsHumanDecision,
        blockerIds,
        publishEscalationActivity,
        // BLO-21395: the scheduler-side failure heartbeat is cross-posted after this
        // transaction commits, and `prefix` is only derived in here — threading it out
        // beats a second `getCompanyIssuePrefix` round trip on the same company. Non-null
        // marks this as a real strand, distinguishing it from the provider-quota park above.
        schedulerFailureHeartbeat: { prefix },
      };
    }).catch((error) => {
      if (error instanceof RecoveryEscalationRollback) return null;
      throw error;
    });
    if (!escalation) return null;

    // All durable state is committed now. Publish the activity before independent
    // wake dispatch; a dispatch failure leaves the recovery action for the next sweep.
    escalation.publishEscalationActivity?.();

    // The active recovery action committed above is the durable wake intent.
    // Dispatch after releasing the stage row lock: enqueueWakeup may claim the
    // issue synchronously, and running it inside this transaction would either
    // self-block or publish work that an eventual rollback made inapplicable.
    // A failed dispatch leaves the action active for the next recovery sweep.
    if (escalation.recoveryCause === "provider_quota" && !escalation.action.ownerAgentId && escalation.action.returnOwnerAgentId) {
      await ensureProviderQuotaWaitRecoveryMonitor({
        issue: escalation.updated,
        latestRun: input.latestRun,
        actionId: escalation.action.id,
        agentId: escalation.action.returnOwnerAgentId,
      });
    }
    await enqueueSourceScopedStrandedRecoveryWake({
      action: escalation.action,
      issue: escalation.fresh,
      latestRun: input.latestRun,
      recoveryCause: escalation.recoveryCause,
      hasNewActivitySinceLastAttempt: escalation.hasNewActivitySinceLastAttempt,
      expectedLockOwnerState: {
        executionRunId: escalation.updated.executionRunId,
        checkoutRunId: escalation.updated.checkoutRunId,
        assigneeAgentId: escalation.updated.assigneeAgentId,
      },
    });
    if (escalation.needsHumanDecision) {
      const assigneeAgent = escalation.fresh.assigneeAgentId
        ? await db
          .select({ name: agents.name })
          .from(agents)
          .where(and(eq(agents.companyId, escalation.fresh.companyId), eq(agents.id, escalation.fresh.assigneeAgentId)))
          .limit(1)
          .then((rows) => rows[0] ?? null)
        : null;
      await emitNeedsHumanDecisionEscalationEvent({
        issue: escalation.fresh,
        assigneeAgentName: assigneeAgent?.name ?? null,
        blockedByIssueIds: escalation.blockerIds,
      });
    }

    // BLO-21395: cross-post the scheduler-side failure heartbeat to the routine's alert
    // surface, so a window that stranded before its runbook could emit is never silent.
    // Deliberately after commit, next to the other deferred side-effects: this writes a
    // comment to a *different* issue, and inside the transaction a failure to post would
    // roll back an escalation that is otherwise correct and already decided. `null` means
    // the provider-quota park path, which must not emit — see the early return above.
    if (escalation.schedulerFailureHeartbeat) {
      await postRoutineSchedulerFailureHeartbeat(
        { db, addComment: issuesSvc.addComment, logger },
        {
          issue: escalation.fresh,
          disposition: {
            kind: "stranded",
            failureClass: latestRunForReceipt?.errorCode ?? escalation.recoveryCause,
          },
          prefix: escalation.schedulerFailureHeartbeat.prefix,
        },
      );
    }

    return escalation.updated;
  }

  function buildZeroTokenStartupFailureComment(input: {
    previousStatus: "todo" | "in_progress";
    latestRun: LatestIssueRun;
  }) {
    const errorCode = readNonEmptyString(input.latestRun?.errorCode) ?? "context_overflow";
    const verb = input.previousStatus === "todo" ? "dispatch" : "continuation";
    return (
      `Paperclip skipped automatic ${verb} recovery for this assigned \`${input.previousStatus}\` issue ` +
      `because the last run failed with \`${errorCode}\` and burned zero tokens — a structural, pre-model ` +
      "startup wedge (a poisoned/oversized session, or a model-config mismatch), not a transient failure. " +
      "A `stranded_issue_recovery` wrapper would just re-invoke the same wedged session and loop, so none " +
      "was created (see BLO-5681). Moving it to `blocked` so the chain-of-command owner can clear the wedge " +
      "(reset the session, fix the adapter config, or reassign) before work resumes. The invariant will not " +
      "re-fire until the issue leaves `blocked` and a non-zero-token run completes."
    );
  }

  // BLO-5681: when a stranded issue's latest terminal failure is a structural,
  // zero-token pre-model startup wedge (context_overflow / context_length_exceeded
  // / startup_error_pre_model), escalate the source straight to `blocked` WITHOUT
  // a `stranded_issue_recovery` wrapper. A wrapper re-runs the same wedged session
  // and produces another zero-token failed run — the BLO-5378 → BLO-5676 loop
  // (9 zero-token runs in ~1h). Because `reconcileStrandedAssignedIssues` only
  // scans `todo`/`in_progress`, a `blocked` issue is never re-swept, so this
  // escalation fires exactly once until a human moves the issue back; owner
  // attention is then routed through the standard blocked-issue liveness path.
  async function escalateZeroTokenStartupFailureIssue(input: {
    issue: typeof issues.$inferSelect;
    previousStatus: "todo" | "in_progress";
    latestRun: LatestIssueRun;
    expectedLockOwnerState?: IssueLockOwnerState | null;
  }) {
    const result = await db.transaction(async (tx) => {
      // Serialize per (company, source-issue) so racing reconcile sweeps don't
      // double-escalate. Xact-scoped advisory lock, same key shape as
      // escalateStrandedAssignedIssue.
      await lockIssueOwnership(tx, input.issue.companyId, input.issue.id);

      const [fresh] = await tx
        .select()
        .from(issues)
        .where(eq(issues.id, input.issue.id))
        .limit(1)
        .for("update");
      if (!fresh) return null;
      // Peer sweep already escalated this source under the lock.
      if (fresh.status === "blocked") return fresh;
      if (fresh.status !== input.previousStatus) return null;
      if (
        input.expectedLockOwnerState &&
        !issueLockOwnerStateMatches(input.expectedLockOwnerState, {
          executionRunId: fresh.executionRunId,
          checkoutRunId: fresh.checkoutRunId,
          assigneeAgentId: fresh.assigneeAgentId,
        })
      ) return null;

      let updated: Awaited<ReturnType<typeof issuesSvc.update>>;
      try {
        updated = await issuesSvc.update(
          fresh.id,
          {
            status: "blocked",
            ...buildIssueMonitorClearedPatch({
              issue: fresh,
              policy: normalizeIssueExecutionPolicy(fresh.executionPolicy ?? null),
              clearReason: "suppressed_by_status",
            }),
            expectedCurrentStatus: fresh.status,
            expectedCurrentAssigneeAgentId: fresh.assigneeAgentId,
            expectedCurrentCheckoutRunId: fresh.checkoutRunId,
            expectedCurrentExecutionRunId: fresh.executionRunId,
          },
          tx,
        );
      } catch (error) {
        if (error instanceof HttpError && error.status === 409) return null;
        throw error;
      }
      if (!updated) return null;

      await issuesSvc.addComment(
        fresh.id,
        buildZeroTokenStartupFailureComment({
          previousStatus: input.previousStatus,
          latestRun: input.latestRun,
        }),
        {},
        { authorType: "system" },
        tx,
      );

      const publish = await logActivity(tx as unknown as Db, {
        companyId: fresh.companyId,
        actorType: "system",
        actorId: "system",
        agentId: null,
        runId: null,
        action: "issue.updated",
        entityType: "issue",
        entityId: fresh.id,
        details: {
          identifier: fresh.identifier,
          status: "blocked",
          previousStatus: input.previousStatus,
          source: "recovery.reconcile_stranded_assigned_issue.zero_token_startup_failure",
          latestRunId: input.latestRun?.id ?? null,
          latestRunStatus: input.latestRun?.status ?? null,
          latestRunErrorCode: input.latestRun?.errorCode ?? null,
          recoveryWrapperSuppressed: true,
        },
      }, { deferPublish: true });

      return { updated, publish };
    });
    if (!result) return null;
    if ("publish" in result) result.publish();
    return "updated" in result ? result.updated : result;
  }

  // BLO-10889 (BLO-10866 WS2): defense-in-depth for the zero-token
  // startup-failure wedge. Escalating straight to `blocked` (BLO-5681) is
  // safe but leaves a poisoned session stuck until a human manually resets
  // it or reassigns to a different agent (the only known escape, per
  // BLO-10866/BLO-10777). Now that a persisted task session can be cleared
  // in place, try ONE bounded reset-and-retry first: clear the agent's task
  // session for this issue, then re-dispatch. `escalateZeroTokenStartupFailureIssue`
  // remains the fallback if that retry also fails (see
  // isZeroTokenSessionResetRetryRun above) — so this never loops past one
  // extra attempt. Returns the queued run row, or null if the retry could
  // not be dispatched (caller falls back to `skipped`).
  async function resetSessionAndRetryZeroTokenFailure(input: {
    issue: typeof issues.$inferSelect;
    agent: typeof agents.$inferSelect;
    latestRun: NonNullable<LatestIssueRun>;
  }) {
    const taskKey =
      readNonEmptyString(parseObject(input.latestRun.contextSnapshot).taskKey) ?? input.issue.id;
    const scheduledRetryAttempt = Math.min(
      (input.latestRun.scheduledRetryAttempt ?? 0) + 1,
      SESSION_UNAVAILABLE_RECOVERY_MAX_ATTEMPTS,
    );
    const queued = await enqueueStrandedIssueRecovery({
      issueId: input.issue.id,
      agentId: input.agent.id,
      reason: "issue_zero_token_session_reset",
      retryReason: ZERO_TOKEN_SESSION_RESET_RETRY_REASON,
      source: "issue.zero_token_session_reset_recovery",
      retryOfRunId: input.latestRun?.id ?? null,
      extraContext: { scheduledRetryAttempt, taskKey },
    });
    if (!queued) return null;

    await issuesSvc.addComment(
      input.issue.id,
      "Paperclip detected a zero-token startup wedge on this assigned issue's last run " +
        "(the BLO-10866 poisoned-session signature). Instead of re-invoking the same possibly-poisoned " +
        "session, the agent's persisted task session was reset and a fresh retry was queued. If this " +
        "retry also fails with zero tokens, the issue will move to `blocked` for manual attention.",
      {},
      { authorType: "system" },
    );

    return queued;
  }

  function sessionUnavailableAdapterMismatch(input: {
    latestRun: LatestIssueRun;
    agent: typeof agents.$inferSelect | null;
    historicalAdapterType?: string | null;
  }): { historicalAdapterType: string; currentAdapterType: string } | null {
    if (!input.latestRun || !input.agent || input.latestRun.agentId !== input.agent.id) return null;
    const historicalAdapterType =
      readNonEmptyString(input.historicalAdapterType) ??
      readNonEmptyString(parseObject(input.latestRun.contextSnapshot).adapterType);
    const currentAdapterType = readNonEmptyString(input.agent.adapterType);
    if (
      !historicalAdapterType ||
      !currentAdapterType ||
      historicalAdapterType === currentAdapterType ||
      (input.latestRun.errorCode?.trim() !== "session_unavailable" &&
        !isLegacySessionUnavailableAdapterMismatch({
          run: { ...input.latestRun, adapterType: historicalAdapterType },
          currentAdapterType,
        }))
    ) {
      return null;
    }
    return { historicalAdapterType, currentAdapterType };
  }

  async function resolveSessionUnavailableRunAdapterType(input: {
    issue: typeof issues.$inferSelect;
    latestRun: NonNullable<LatestIssueRun>;
  }) {
    const snapshottedAdapterType = readNonEmptyString(
      parseObject(input.latestRun.contextSnapshot).adapterType,
    );
    if (snapshottedAdapterType || !input.latestRun.sessionIdBefore) {
      return snapshottedAdapterType;
    }
    const taskKey =
      readNonEmptyString(parseObject(input.latestRun.contextSnapshot).taskKey) ?? input.issue.id;

    return db
      .select({ adapterType: agentTaskSessions.adapterType })
      .from(agentTaskSessions)
      .where(
        and(
          eq(agentTaskSessions.companyId, input.issue.companyId),
          eq(agentTaskSessions.agentId, input.latestRun.agentId),
          eq(agentTaskSessions.taskKey, taskKey),
          eq(agentTaskSessions.sessionDisplayId, input.latestRun.sessionIdBefore),
        ),
      )
      .limit(1)
      .then((rows) => readNonEmptyString(rows[0]?.adapterType));
  }

  function buildSessionUnavailableAdapterMismatchComment(input: {
    previousStatus: "todo" | "in_progress";
    historicalAdapterType: string;
    currentAdapterType: string;
  }) {
    const verb = input.previousStatus === "todo" ? "dispatch" : "continuation";
    return (
      `Paperclip detected a \`Session unavailable\` ${verb} failure from ` +
      `\`${input.historicalAdapterType}\`, but the assigned agent now uses ` +
      `\`${input.currentAdapterType}\`. This run is not eligible for the OpenCode ` +
      "session-reset path, and retrying it under the new adapter would reclassify stale " +
      "runtime evidence. Moving it to `blocked` so an operator can restart the work " +
      "intentionally under the current adapter or clear the stale failure."
    );
  }

  async function persistAdapterFailureRecoveryClassification(
    latestRun: NonNullable<LatestIssueRun>,
    classification: NonNullable<AdapterFailureRecoveryClassification>,
  ): Promise<NonNullable<LatestIssueRun>> {
    const classifiedRun = withAdapterFailureRecoveryClassification(latestRun, classification);

    await db
      .update(heartbeatRuns)
      .set({
        errorCode: classifiedRun.errorCode,
        resultJson: parseObject(classifiedRun.resultJson),
        updatedAt: new Date(),
      })
      .where(eq(heartbeatRuns.id, latestRun.id));

    return classifiedRun;
  }

  function withAdapterFailureRecoveryClassification(
    latestRun: NonNullable<LatestIssueRun>,
    classification: NonNullable<AdapterFailureRecoveryClassification>,
  ): NonNullable<LatestIssueRun> {
    const resultJson = parseObject(latestRun.resultJson);
    const providerQuotaMetadata = classification.kind === "provider_quota"
      ? {
          errorFamily: "provider_quota",
          retryNotBefore: classification.retryAt.toISOString(),
          transientRetryNotBefore: classification.retryAt.toISOString(),
          providerQuotaRetryNotBefore: classification.retryAt.toISOString(),
        }
      : { errorFamily: "configuration_incomplete" };
    const errorCode = classification.kind;

    return {
      ...latestRun,
      errorCode,
      resultJson: {
        ...resultJson,
        ...providerQuotaMetadata,
        recoveryClassification: errorCode,
      },
    };
  }

  async function scheduleProviderQuotaRecoveryMonitor(input: {
    issue: typeof issues.$inferSelect;
    latestRun: NonNullable<LatestIssueRun>;
    classification: Extract<NonNullable<AdapterFailureRecoveryClassification>, { kind: "provider_quota" }>;
  }) {
    if (input.issue.status !== "in_progress" && input.issue.status !== "in_review") return null;

    const targetAgentId = getAdapterFailureRecoveryTargetAgentId(input.issue);
    if (!targetAgentId || input.latestRun.agentId !== targetAgentId) return null;

    const previousPolicy = normalizeIssueExecutionPolicy(input.issue.executionPolicy ?? null);
    const retryTargetDescription = input.issue.status === "in_review"
      ? "the active review participant"
      : "the original assignee";
    const policy = {
      ...(previousPolicy ?? { mode: "normal" as const, commentRequired: true, stages: [] }),
      monitor: {
        nextCheckAt: input.classification.retryAt.toISOString(),
        notes: input.classification.parsedResetTime
          ? `Provider usage quota reached; retry ${retryTargetDescription} at the provider reset time.`
          : `Provider usage quota reached; retry ${retryTargetDescription} after the default recovery backoff.`,
        scheduledBy: "assignee" as const,
        kind: "external_service" as const,
        serviceName: PROVIDER_QUOTA_MONITOR_SERVICE_NAME,
        externalRef: input.latestRun.id,
        timeoutAt: null,
        maxAttempts: null,
        recoveryPolicy: "wake_owner" as const,
      },
    };
    const transition = applyIssueMonitorPolicyTransition({
      issue: input.issue,
      policy,
      previousPolicy,
      requestedStatus: input.issue.status,
      requestedAssigneePatch: {},
      actor: { agentId: null, userId: null },
      monitorExplicitlyUpdated: true,
    });
    const updated = await issuesSvc.update(input.issue.id, {
      ...transition.patch,
      executionPolicy: policy,
    });
    if (!updated) return null;

    await logActivity(db, {
      companyId: input.issue.companyId,
      actorType: "system",
      actorId: "recovery",
      agentId: null,
      runId: input.latestRun.id,
      action: "issue.monitor_scheduled",
      entityType: "issue",
      entityId: input.issue.id,
      details: {
        identifier: input.issue.identifier,
        source: "recovery.provider_quota",
        latestRunId: input.latestRun.id,
        errorCode: "provider_quota",
        nextCheckAt: input.classification.retryAt.toISOString(),
        parsedResetTime: input.classification.parsedResetTime,
        targetAgentId,
      },
    });

    return updated;
  }

  function getAdapterFailureRecoveryTargetAgentId(issue: typeof issues.$inferSelect) {
    if (issue.status !== "in_review") return issue.assigneeAgentId;

    const pendingExecutionState = parseIssueExecutionState(issue.executionState);
    const participant = pendingExecutionState?.status === "pending"
      ? pendingExecutionState.currentParticipant
      : null;
    return participant?.type === "agent" ? participant.agentId : null;
  }

  function hasPendingProviderQuotaRecoveryMonitor(
    issue: typeof issues.$inferSelect,
    latestRun: LatestIssueRun,
    now: Date,
  ) {
    if (!latestRun || !issue.monitorNextCheckAt || issue.monitorNextCheckAt.getTime() <= now.getTime()) return false;
    const monitor = parseObject(parseObject(issue.executionPolicy).monitor);
    return readNonEmptyString(monitor.serviceName) === PROVIDER_QUOTA_MONITOR_SERVICE_NAME &&
      readNonEmptyString(monitor.externalRef) === latestRun.id;
  }

  async function reconcileStrandedAssignedIssues(opts?: { issueCreatedAtGte?: Date | null }) {
    const dependencyWaitEscalationSuppressedAtSweepStart = dependencyWaitEscalationSuppressedTotal;
    const candidates = await db
      .select()
      .from(issues)
      .where(
        and(
          isNull(issues.assigneeUserId),
          inArray(issues.status, STRANDED_ASSIGNED_ISSUE_STATUSES),
          or(
            sql`${issues.assigneeAgentId} is not null`,
            eq(issues.status, "in_review"),
          ),
          sql`not exists (
            select 1
            from ${heartbeatRuns} live_execution_run
            where live_execution_run.id = ${issues.executionRunId}
              and live_execution_run.status in ('queued', 'running', 'scheduled_retry')
          )`,
          opts?.issueCreatedAtGte ? gte(issues.createdAt, opts.issueCreatedAtGte) : undefined,
        ),
      )
      .orderBy(asc(issues.companyId), asc(issues.assigneeAgentId), asc(issues.createdAt), asc(issues.id));

    const result = {
      assignmentDispatched: 0,
      dispatchRequeued: 0,
      continuationRequeued: 0,
      productiveContinuationObserved: 0,
      successfulContinuationObserved: 0,
      orphanBlockersAssigned: 0,
      successfulRunHandoffEscalated: 0,
      reviewWaitingParked: 0,
      reviewParticipantRequeued: 0,
      escalated: 0,
      zeroTokenStartupFailureBlocked: 0,
      zeroTokenSessionResetRetried: 0,
      waitingOnReviewResolved: 0,
      dependencyWaitSkipped: 0,
      // BLO-27463: dependency-wait terminal runs whose escalation was refused at the
      // transactional gate. Counted separately from `dependencyWaitSkipped` (the sweep
      // preflight) because a non-zero value here means the issue reported
      // `issue_dependencies_blocked` with its blockers already resolved — a real defect
      // that must stay observable without being escalated up the org chain.
      dependencyWaitEscalationSuppressed: 0,
      providerQuotaMonitored: 0,
      recentProgressExempted: 0,
      skipped: 0,
      issueIds: [] as string[],
    };
    for (const issue of candidates) {
      const executionState = issue.status === "in_review"
        ? parseIssueExecutionState(issue.executionState)
        : null;
      const pendingExecutionState = executionState?.status === "pending" ? executionState : null;
      const currentParticipant = pendingExecutionState
        ? pendingExecutionState.currentParticipant
        : null;
      const participantAgentId = currentParticipant?.type === "agent" ? currentParticipant.agentId : null;
      const agentId = issue.status === "in_review" && participantAgentId
        ? participantAgentId
        : issue.assigneeAgentId;
      if (!agentId) {
        result.skipped += 1;
        continue;
      }

      if (await hasActiveExecutionPath(
        issue.companyId,
        issue.id,
        issue.status === "in_review" ? agentId : null,
      )) {
        result.skipped += 1;
        continue;
      }

      if (await hasPendingWakeInteraction(issue.companyId, issue.id)) {
        result.skipped += 1;
        continue;
      }

      if (await isAutomaticRecoverySuppressedByPauseHold(db, issue.companyId, issue.id, treeControlSvc)) {
        result.skipped += 1;
        continue;
      }

      const newestIssueRun = await getLatestIssueRun(issue.companyId, issue.id);
      // Memoised per candidate: the dependency-blocked arm below and the
      // review-participant block can both need readiness for the same issue on
      // the fall-through path this sweep now has (BLO-29604).
      let dependencyReadiness: IssueDependencyReadiness | null = null;
      // `issue_terminal_status` means this queued dispatch was correctly
      // cancelled while the issue was terminal. The candidate query above has
      // already established that the issue is non-terminal now, so this is
      // stale lifecycle evidence rather than a failure to escalate or a reason
      // to keep skipping the issue forever. Clear it before classification,
      // but retain the flag so an `in_progress` issue reaches the normal
      // continuation re-dispatch below instead of the generic no-run skip.
      let latestRun: LatestIssueRun = newestIssueRun;
      const reopenedAfterTerminalDispatchRace = isTerminalDispatchRaceRun(latestRun);
      if (reopenedAfterTerminalDispatchRace) latestRun = null;
      // BLO-18860: never judge an issue on a checkout-adoption cancellation.
      // The adopting run is by construction the assignee's own run, so this
      // issue has continuity, not a lost execution path — but the
      // `hasActiveExecutionPath` check above cannot see that run (it matches on
      // `contextSnapshot ->> 'issueId'`, and the adopting run is scoped to
      // whichever issue its own dispatch was for). Left unhandled, the handover
      // marker is the newest run row for this issue, reads as
      // terminal-unsuccessful, and escalates the issue away from the agent that
      // had just written to it.
      let adoptionHandover: AdoptionHandoverNeutralRecovery | null = null;
      if (isCheckoutAdoptionCancelledRun(newestIssueRun)) {
        adoptionHandover = await resolveCheckoutAdoptionHandover(issue, newestIssueRun);
        // Continuity (a live same-assignee adopter holds the lock) or the issue
        // vanished mid-sweep. Either way there is nothing to recover.
        if (!adoptionHandover) {
          result.skipped += 1;
          continue;
        }
      }
      // BLO-19160 finding 1: on the handover path this issue is judged with NO
      // run evidence. The handover marker itself is bookkeeping about the run
      // that lost the checkout, and the adopter — once terminal — is by
      // construction scoped to a *different* issue, so its error code,
      // workspace result, quota state, liveness and retry budget all describe
      // that other issue's work. Substituting the adopter as `latestRun` (as
      // this branch used to) let a foreign nonretryable outcome block,
      // reassign, or suppress recovery on an issue for which the condition was
      // never true. Carrying no evidence instead lands the issue on the neutral
      // continuation recovery at the end of the loop: it is known to need a
      // live execution path, and nothing more than that is known.
      //
      // Annotated (rather than inferred) because `isCheckoutAdoptionCancelledRun`
      // is a type predicate: without the annotation TS narrows its *negative*
      // branch to `null` too, and reads every run check below as unreachable.
      if (adoptionHandover) latestRun = null;
      // The marker stays the newest run scoped to this issue forever, so the
      // no-run/no-lock guard below must not read the resulting absence of
      // evidence as "nothing to recover from" and skip the issue on this sweep
      // and every sweep after it.
      const adoptionHandoverNeedsNeutralRecovery = Boolean(adoptionHandover);
      // Provenance for that neutral recovery. The handover marker is the newest
      // run genuinely scoped to THIS issue, which makes it the honest retry
      // parent — unlike the lock columns, which on this path may name a run
      // dispatched for someone else's issue.
      const adoptionHandoverMarkerRunId = adoptionHandover?.markerRunId ?? null;
      // Lock/owner values re-read at the instant the handover was observed.
      // Non-null only on the handover path; every recovery mutation below CASes
      // against it so a lost race takes no side effect.
      const adoptionHandoverLockGuard = adoptionHandover?.lockOwnerState ?? null;
      const agent = await getAgent(agentId);
      const agentInvokable = agent && agent.companyId === issue.companyId
        ? await isAgentInvokable(agent)
        : false;
      const dependencyBlockedStrand = latestRun?.errorCode === DEPENDENCY_BLOCKED_ERROR_CODE &&
        (issue.status === "in_review" || !agentInvokable);
      if (dependencyBlockedStrand) {
        dependencyReadiness ??= await issuesSvc.getDependencyReadiness(issue.id);
      }
      // BLO-29604: this arm's contract is "keep the owner and let the dependency
      // machinery do the routing", and BOTH of its outputs need a blocker row to
      // exist — `blocked` is only honest while one is unresolved, and the wake
      // below is keyed on `resolvedBlockerIssueId`. With no blocker rows at all
      // it is provably a no-op that still `continue`s, which is how a
      // review-stage strand ended up with no recovery action, no
      // blockers-resolved wake, and no scheduler dispatch (an `in_review` issue
      // with a pending stage is never re-dispatched). That zero-blocker shape is
      // the common one, not the edge case: `issue_dependencies_blocked` is also
      // the code provider rate-limit/quota parks are finalized under, so it
      // arrives on runs that never had a dependency at all.
      //
      // Consume the issue here only when there is something to consume it for;
      // otherwise fall through and let the review-participant block below own
      // it. For the `!agentInvokable` assignee lane that fall-through is
      // behaviour-preserving by construction — the very next guard skips a
      // non-`in_review` issue whose agent is not invokable — minus the phantom
      // `issueIds` push a no-op used to record.
      if (
        dependencyBlockedStrand && dependencyReadiness &&
        (dependencyReadiness.unresolvedBlockerCount > 0 ||
          (dependencyReadiness.blockerIssueIds.length > 0 && issue.assigneeAgentId !== null))
      ) {
        const readiness = dependencyReadiness;
        const resolvedBlockerIssueId = readiness.blockerIssueIds[0] ?? null;
        // A dependency-ready issue has no blocker wake backstop unless this
        // reconciliation persists one. Do not manufacture a blocked state for
        // that case: the blocked-only reconciler would immediately flip it to
        // todo and this sweep could put it back into blocked on every pass.
        let nextStatus: "blocked" | "todo" | null = readiness.unresolvedBlockerCount > 0
          ? "blocked"
          : null;
        if (readiness.unresolvedBlockerCount === 0 && resolvedBlockerIssueId && issue.assigneeAgentId) {
          // `enqueueWakeup` signals "woke nobody" two different ways, and only one of
          // them is a null return. The benign deferrals (wake-on-demand disabled,
          // cooldown, concurrency gating) return null, but a wholly non-invokable
          // assignee — paused, terminated, invalid org chain — or an exhausted budget
          // THROWS a 409 instead (`heartbeat.ts` invokability and budget guards).
          //
          // That throw is the *expected* shape here, not an anomaly: one of the two
          // ways to reach this branch at all is `!agentInvokable`. Letting it escape
          // would abort the entire sweep mid-loop, so a single paused assignee would
          // strand every issue queued behind it. Treat it exactly like a declined wake:
          // leave `nextStatus` null so the issue keeps the status it already has, and
          // let the blockers-resolved sweep pick it up once the assignee is invokable.
          try {
            const wake = await deps.enqueueWakeup(issue.assigneeAgentId, {
              source: "automation",
              triggerDetail: "system",
              reason: ISSUE_BLOCKERS_RESOLVED_WAKE_REASON,
              payload: {
                issueId: issue.id,
                resolvedBlockerIssueId,
                blockerIssueIds: readiness.blockerIssueIds,
                backstop: "stranded_recovery_reconciliation",
              },
              idempotencyKey: buildIssueBlockersResolvedWakeIdempotencyKey({
                dependentIssueId: issue.id,
                resolvedBlockerIssueId,
              }),
              requestedByActorType: "system",
              requestedByActorId: "stranded_recovery_reconciliation",
              contextSnapshot: {
                issueId: issue.id,
                taskId: issue.id,
                wakeReason: ISSUE_BLOCKERS_RESOLVED_WAKE_REASON,
                source: "recovery.reconcile_stranded_assigned_issue",
                resolvedBlockerIssueId,
                blockerIssueIds: readiness.blockerIssueIds,
              },
            });
            if (wake) nextStatus = "todo";
          } catch (err) {
            logger.warn(
              { err, issueId: issue.id, agentId: issue.assigneeAgentId, resolvedBlockerIssueId },
              "failed to enqueue dependency wake during stranded recovery reconciliation; leaving issue status unchanged",
            );
          }
        }
        const updated = nextStatus === null || issue.status === nextStatus
          ? issue
          : await issuesSvc.update(issue.id, { status: nextStatus });
        if (updated) result.issueIds.push(issue.id);
        result.skipped += 1;
        continue;
      }
      if (issue.status !== "in_review" && !agentInvokable) {
        result.skipped += 1;
        continue;
      }
      if (latestRun?.status === "succeeded" && await hasPersistedDurableWaitPath(issue)) {
        result.skipped += 1;
        continue;
      }
      if (isQuotaExhaustedTerminalRun(latestRun)) {
        result.skipped += 1;
        continue;
      }
      const recoveryNow = new Date();
      const participantLatestRunForRecovery = issue.status === "in_review" && participantAgentId &&
          pendingExecutionState?.currentStageId
        ? await getLatestIssueRunForAgentStage(
            issue.companyId,
            issue.id,
            participantAgentId,
            pendingExecutionState.currentStageId,
          )
        : null;
      const providerQuotaMonitorRun = issue.status === "in_review"
        ? participantLatestRunForRecovery
        : latestRun;
      if (hasPendingProviderQuotaRecoveryMonitor(issue, providerQuotaMonitorRun, recoveryNow)) {
        result.skipped += 1;
        continue;
      }
      if (isStrandedIssueRecoveryIssue(issue) && isUnsuccessfulTerminalIssueRun(latestRun)) {
        // BLO-7521 (2026-05-25) / BLO-8050 (2026-05-28): if the operator just
        // manually unblocked this recovery-origin issue, give the agent a
        // fresh run window before re-escalating. See
        // `latestRunPredatesLatestUnblock` for the full rationale.
        if (await latestRunPredatesLatestUnblock(issue.companyId, issue.id, latestRun)) {
          result.skipped += 1;
          continue;
        }
        const updated = await escalateStrandedRecoveryIssueInPlace({
          expectedLockOwnerState: adoptionHandoverLockGuard,
          issue,
          previousStatus: issue.status as StrandedPreviousStatus,
          latestRun,
        });
        if (updated) {
          result.escalated += 1;
          result.issueIds.push(issue.id);
        } else {
          result.skipped += 1;
        }
        continue;
      }

      const adapterFailureClassification = issue.status !== "in_review" && latestRun && isUnsuccessfulTerminalIssueRun(latestRun)
        ? classifyAdapterFailureForRecovery(latestRun, recoveryNow)
        : null;
      if (latestRun && adapterFailureClassification) {
        const targetAgentId = getAdapterFailureRecoveryTargetAgentId(issue);
        if (!targetAgentId || latestRun.agentId !== targetAgentId) {
          result.skipped += 1;
          continue;
        }

        if (adapterFailureClassification.kind === "provider_quota") {
          const monitored = await scheduleProviderQuotaRecoveryMonitor({
            issue,
            latestRun,
            classification: adapterFailureClassification,
          });
          if (monitored) {
            latestRun = await persistAdapterFailureRecoveryClassification(latestRun, adapterFailureClassification);
            result.providerQuotaMonitored += 1;
            result.issueIds.push(issue.id);
            continue;
          }
          result.skipped += 1;
          continue;
        } else {
          const updated = await escalateStrandedAssignedIssue({
            expectedLockOwnerState: adoptionHandoverLockGuard,
            issue,
            previousStatus: issue.status as StrandedPreviousStatus,
            latestRun,
            recoveryCause: "configuration_incomplete",
            comment:
              "Paperclip classified the latest adapter failure as `configuration_incomplete`. " +
              "Moving the issue to `blocked` with the configuration fix recorded instead of creating a recovery takeover.",
          });
          if (updated) {
            latestRun = await persistAdapterFailureRecoveryClassification(latestRun, adapterFailureClassification);
            result.escalated += 1;
            result.issueIds.push(issue.id);
          } else {
            result.skipped += 1;
          }
          continue;
        }
      }

      const acceptedContinuationInteraction = await getLatestAcceptedContinuationInteraction(issue.companyId, issue.id);
      const acceptedInteractionResolvedAt = acceptedContinuationInteraction
        ? acceptedContinuationInteraction.resolvedAt ?? acceptedContinuationInteraction.updatedAt
        : null;
      if (acceptedContinuationInteraction && acceptedInteractionResolvedAt && !pendingExecutionState) {
        const successfulRunSinceResolution = await hasSuccessfulIssueRunSince(
          issue.companyId,
          issue.id,
          acceptedInteractionResolvedAt,
          acceptedContinuationInteraction.id,
        );

        if (!successfulRunSinceResolution) {
          const latestPostResolutionRun = await getLatestIssueRunSince(
            issue.companyId,
            issue.id,
            acceptedInteractionResolvedAt,
            acceptedContinuationInteraction.id,
          );
          const postResolutionClassification = latestPostResolutionRun &&
              isUnsuccessfulTerminalIssueRun(latestPostResolutionRun)
            ? classifyContinuationFailure(latestPostResolutionRun)
            : null;
          if (postResolutionClassification?.kind === "non_retryable") {
            if (await latestRunPredatesLatestUnblock(issue.companyId, issue.id, latestPostResolutionRun)) {
              result.skipped += 1;
              continue;
            }
            const failureSummary = summarizeRunFailureForIssueComment(latestPostResolutionRun);
            const updated = await escalateStrandedAssignedIssue({
              issue,
              previousStatus: issue.status as StrandedPreviousStatus,
              latestRun: latestPostResolutionRun,
              comment:
                "Paperclip detected a non-retryable failure after an accepted interaction " +
                `(\`${postResolutionClassification.errorCode}\`). Skipping continuation replay and moving it to ` +
                `\`blocked\` so it is visible for intervention.${failureSummary ?? ""}`,
            });
            if (updated) {
              result.escalated += 1;
              result.issueIds.push(issue.id);
            } else {
              result.skipped += 1;
            }
            continue;
          }

          if (!agentInvokable) {
            result.skipped += 1;
            continue;
          }

          if (await hasQueuedIssueWake(issue.companyId, issue.id, agentId)) {
            result.skipped += 1;
            continue;
          }

          if (await isInvocationBudgetBlocked(issue, agentId)) {
            result.skipped += 1;
            continue;
          }

          const { consecutive } = await summarizeRecentContinuationRetries(
            issue.companyId,
            issue.id,
            agentId,
            CONTINUATION_WAITING_ON_REVIEW_ERROR_CODE,
            acceptedInteractionResolvedAt,
          );
          if (consecutive >= INTERACTION_CONTINUATION_REQUEUE_MAX_ATTEMPTS && latestPostResolutionRun) {
            const resolved = await resolveContinuationWaitingOnReview(issue, adoptionHandoverLockGuard);
            if (resolved) {
              result.waitingOnReviewResolved += 1;
              result.issueIds.push(issue.id);
              continue;
            }

            const updated = await escalateStrandedAssignedIssue({
              expectedLockOwnerState: adoptionHandoverLockGuard,
              issue,
              previousStatus: issue.status as StrandedPreviousStatus,
              latestRun: latestPostResolutionRun,
              comment:
                `Paperclip stopped requeueing accepted interaction \`${acceptedContinuationInteraction.id}\` after ` +
                `${consecutive} consecutive continuation wakes were cancelled while waiting on review. ` +
                "Moving the issue to `blocked` so the missing execution path is visible for intervention.",
            });
            if (updated) {
              result.escalated += 1;
              result.issueIds.push(issue.id);
            } else {
              result.skipped += 1;
            }
            continue;
          }

          const queued = await enqueueStrandedIssueRecovery({
            expectedLockOwnerState: adoptionHandoverLockGuard,
            issueId: issue.id,
            agentId,
            reason: "issue_continuation_needed",
            retryReason: "issue_continuation_needed",
            source: "issue.interaction_continuation_recovery",
            retryOfRunId: latestPostResolutionRun?.id ?? acceptedContinuationInteraction.sourceRunId ?? latestRun?.id ?? null,
            extraContext: {
              mutation: "interaction",
              interactionId: acceptedContinuationInteraction.id,
              interactionKind: acceptedContinuationInteraction.kind,
              interactionStatus: acceptedContinuationInteraction.status,
              interactionContinuationPolicy: acceptedContinuationInteraction.continuationPolicy,
              interactionResolvedAt: acceptedInteractionResolvedAt.toISOString(),
            },
          });
          if (queued) {
            result.continuationRequeued += 1;
            result.issueIds.push(issue.id);
          } else {
            result.skipped += 1;
          }
          continue;
        }
      }

      if (issue.status === "in_review") {
        if (!participantAgentId || !pendingExecutionState?.currentStageId) {
          result.skipped += 1;
          continue;
        }
        const participantLatestRun = participantLatestRunForRecovery;

        if (!participantLatestRun || !isTerminalIssueRun(participantLatestRun)) {
          if (!agentInvokable) {
            const updated = await escalateStrandedAssignedIssue({
              expectedLockOwnerState: adoptionHandoverLockGuard,
              issue,
              previousStatus: "in_review",
              latestRun: participantLatestRun,
              comment: buildExecutionReviewParticipantUnavailableComment(participantLatestRun),
              recoveryCause: EXECUTION_REVIEW_PARTICIPANT_RECOVERY_REASON,
              recoveryOwnerAgentId: participantAgentId,
              expectedReviewStage: {
                stageId: pendingExecutionState.currentStageId,
                participantAgentId,
                executionRunId: issue.executionRunId,
              },
            });
            if (updated) {
              result.escalated += 1;
              result.issueIds.push(issue.id);
            } else {
              result.skipped += 1;
            }
          } else {
            result.skipped += 1;
          }
          continue;
        }

        const participantContinuationClassification = classifyContinuationFailure(participantLatestRun);
        // BLO-29604: `issue_dependencies_blocked` on a participant run is the
        // dispatcher declining to *start* the reviewer, not the reviewer
        // failing — `claimQueuedRun`'s dependency gate cancels any queued run
        // for the issue, participant wakes included. It sits in
        // NON_RETRYABLE_CONTINUATION_ERROR_CODES so a retry can never burn
        // attempts against a genuinely open blocker, and while one is open that
        // is right. Once readiness is satisfied the refusal has expired and the
        // reviewer is precisely who should run, so treat it as requeueable
        // instead: escalating parks a pending review stage `blocked` under a
        // manager who cannot submit the decision, which is the ownership
        // ratchet BLO-19123 exists to stop. Mirrors the assignee lane's own
        // readiness re-check (BLO-19124) further down this function.
        //
        // Bounded, not a loop: the requeue below stamps retryReason
        // `execution_review_participant_recovery`, so if that run also ends
        // terminal the `didAutomaticRecoveryFail` arm escalates on the next
        // sweep whatever error code it carries.
        const participantDependencyRefusalExpired =
          participantContinuationClassification.errorCode === DEPENDENCY_BLOCKED_ERROR_CODE &&
          (dependencyReadiness ??= await issuesSvc.getDependencyReadiness(issue.id)).isDependencyReady;
        const queuedParticipantRecovery = agentInvokable
          ? await hasQueuedExecutionReviewParticipantRecoveryWake(
              issue.companyId,
              issue.id,
              participantAgentId,
              pendingExecutionState.currentStageId,
            )
          : false;
        if (
          isUnsuccessfulTerminalIssueRun(participantLatestRun) &&
          participantContinuationClassification.kind === "non_retryable" &&
          !participantDependencyRefusalExpired
        ) {
          if (queuedParticipantRecovery) {
            result.skipped += 1;
            continue;
          }
          if (await latestRunPredatesLatestUnblock(issue.companyId, issue.id, participantLatestRun)) {
            result.skipped += 1;
            continue;
          }
          const failureSummary = summarizeRunFailureForIssueComment(participantLatestRun);
          const updated = await escalateStrandedAssignedIssue({
            issue,
            previousStatus: "in_review",
            latestRun: participantLatestRun,
            recoveryCause: EXECUTION_REVIEW_PARTICIPANT_RECOVERY_REASON,
            recoveryOwnerAgentId: participantAgentId,
            expectedReviewStage: {
              stageId: pendingExecutionState.currentStageId,
              participantAgentId,
              executionRunId: issue.executionRunId,
            },
            comment:
              "Paperclip detected a non-retryable failure on the active review participant's run " +
              `(\`${participantContinuationClassification.errorCode}\`). Skipping automatic retries and moving it to ` +
              `\`blocked\` so it is visible for intervention.${failureSummary ?? ""}`,
          });
          if (updated) {
            result.escalated += 1;
            result.issueIds.push(issue.id);
          } else {
            result.skipped += 1;
          }
          continue;
        }

        const participantAdapterFailureClassification = isUnsuccessfulTerminalIssueRun(participantLatestRun)
          ? classifyAdapterFailureForRecovery(participantLatestRun, recoveryNow)
          : null;
        if (participantAdapterFailureClassification?.kind === "provider_quota") {
          const monitored = await scheduleProviderQuotaRecoveryMonitor({
            issue,
            latestRun: participantLatestRun,
            classification: participantAdapterFailureClassification,
          });
          if (monitored) {
            latestRun = await persistAdapterFailureRecoveryClassification(
              participantLatestRun,
              participantAdapterFailureClassification,
            );
            result.providerQuotaMonitored += 1;
            result.issueIds.push(issue.id);
          } else {
            result.skipped += 1;
          }
          continue;
        }
        if (participantAdapterFailureClassification?.kind === "configuration_incomplete") {
          const updated = await escalateStrandedAssignedIssue({
            expectedLockOwnerState: adoptionHandoverLockGuard,
            issue,
            previousStatus: "in_review",
            latestRun: participantLatestRun,
            recoveryCause: "configuration_incomplete",
            recoveryOwnerAgentId: participantAgentId,
            comment:
              "Paperclip classified the active review participant's latest adapter failure as " +
              "`configuration_incomplete`. Moving the issue to `blocked` with the configuration fix " +
              "recorded instead of repeatedly requeueing the reviewer.",
          });
          if (updated) {
            latestRun = await persistAdapterFailureRecoveryClassification(
              participantLatestRun,
              participantAdapterFailureClassification,
            );
            result.escalated += 1;
            result.issueIds.push(issue.id);
          } else {
            result.skipped += 1;
          }
          continue;
        }

        if (!agentInvokable) {
          const updated = await escalateStrandedAssignedIssue({
            expectedLockOwnerState: adoptionHandoverLockGuard,
            issue,
            previousStatus: "in_review",
            latestRun: participantLatestRun,
            comment: buildExecutionReviewParticipantUnavailableComment(participantLatestRun),
            recoveryCause: EXECUTION_REVIEW_PARTICIPANT_RECOVERY_REASON,
            recoveryOwnerAgentId: participantAgentId,
            expectedReviewStage: {
              stageId: pendingExecutionState.currentStageId,
              participantAgentId,
              executionRunId: issue.executionRunId,
            },
          });
          if (updated) {
            result.escalated += 1;
            result.issueIds.push(issue.id);
          } else {
            result.skipped += 1;
          }
          continue;
        }

        if (queuedParticipantRecovery) {
          result.skipped += 1;
          continue;
        }

        if (didAutomaticRecoveryFail(participantLatestRun, EXECUTION_REVIEW_PARTICIPANT_RECOVERY_REASON)) {
          const updated = await escalateStrandedAssignedIssue({
            expectedLockOwnerState: adoptionHandoverLockGuard,
            issue,
            previousStatus: "in_review",
            latestRun: participantLatestRun,
            comment: buildExecutionReviewParticipantRecoveryComment(participantLatestRun),
            recoveryCause: EXECUTION_REVIEW_PARTICIPANT_RECOVERY_REASON,
            recoveryOwnerAgentId: participantAgentId,
            expectedReviewStage: {
              stageId: pendingExecutionState.currentStageId,
              participantAgentId,
              executionRunId: issue.executionRunId,
            },
          });
          if (updated) {
            result.escalated += 1;
            result.issueIds.push(issue.id);
          } else {
            result.skipped += 1;
          }
          continue;
        }

        if (await hasQueuedIssueWake(issue.companyId, issue.id, participantAgentId)) {
          result.skipped += 1;
          continue;
        }

        if (await isInvocationBudgetBlocked(issue, participantAgentId)) {
          result.skipped += 1;
          continue;
        }

        const queued = await enqueueStrandedIssueRecovery({
          expectedLockOwnerState: adoptionHandoverLockGuard,
          issueId: issue.id,
          agentId: participantAgentId,
          reason: EXECUTION_REVIEW_PARTICIPANT_RECOVERY_REASON,
          retryReason: EXECUTION_REVIEW_PARTICIPANT_RECOVERY_REASON,
          source: "issue.execution_review_recovery",
          retryOfRunId: participantLatestRun.id,
          extraContext: {
            currentStageId: pendingExecutionState.currentStageId ?? null,
            currentStageType: pendingExecutionState.currentStageType ?? null,
            reviewRecoveryInstruction:
              "The previous reviewer run ended while this execution-review stage was still pending. Submit the review decision now, or mark the issue blocked with the exact unblock action.",
          },
        });
        if (queued) {
          result.reviewParticipantRequeued += 1;
          result.issueIds.push(issue.id);
        } else {
          result.skipped += 1;
        }
        continue;
      }

      if (issue.status === "todo") {
        if (!latestRun) {
          if (await hasQueuedIssueWake(issue.companyId, issue.id)) {
            result.skipped += 1;
            continue;
          }

          if (await isInvocationBudgetBlocked(issue, agentId)) {
            result.skipped += 1;
            continue;
          }

          const queued = await enqueueWithAssignmentRecoveryCapacity(issue, agentId, () =>
            enqueueInitialAssignedTodoDispatch(issue, agentId, adoptionHandoverLockGuard)
          );
          if (queued) {
            result.assignmentDispatched += 1;
            result.issueIds.push(issue.id);
          } else {
            result.skipped += 1;
          }
          continue;
        }

        if (latestRun.status === "succeeded") {
          result.skipped += 1;
          continue;
        }

        const assignmentContinuationClassification = classifyContinuationFailure(latestRun);
        if (assignmentContinuationClassification.kind === "non_retryable") {
          if (await latestRunPredatesLatestUnblock(issue.companyId, issue.id, latestRun)) {
            result.skipped += 1;
            continue;
          }
          const failureSummary = summarizeRunFailureForIssueComment(latestRun);
          const updated = await escalateStrandedAssignedIssue({
            issue,
            previousStatus: "todo",
            latestRun,
            comment:
              "Paperclip detected a non-retryable failure on this assigned issue's latest run " +
              `(\`${assignmentContinuationClassification.errorCode}\`). Skipping automatic retries and moving it to ` +
              `\`blocked\` so it is visible for intervention.${failureSummary ?? ""}`,
          });
          if (updated) {
            result.escalated += 1;
            result.issueIds.push(issue.id);
          } else {
            result.skipped += 1;
          }
          continue;
        }

        if (isNonRetryableTerminalRun(latestRun)) {
          if (await latestRunPredatesLatestUnblock(issue.companyId, issue.id, latestRun)) {
            // BLO-8050: operator just unblocked; skip re-escalation on stale evidence.
            result.skipped += 1;
            continue;
          }
          const updated = await escalateStrandedAssignedIssue({
            expectedLockOwnerState: adoptionHandoverLockGuard,
            issue,
            previousStatus: "todo",
            latestRun,
            comment: buildNonRetryableEscalationComment({ status: "todo", latestRun }),
          });
          if (updated) {
            result.escalated += 1;
            result.issueIds.push(issue.id);
          } else {
            result.skipped += 1;
          }
          continue;
        }

        const todoHistoricalAdapterType = await resolveSessionUnavailableRunAdapterType({ issue, latestRun });
        const todoSessionUnavailableAdapterMismatch =
          sessionUnavailableAdapterMismatch({
            latestRun,
            agent,
            historicalAdapterType: todoHistoricalAdapterType,
          });
        if (todoSessionUnavailableAdapterMismatch) {
          if (await latestRunPredatesLatestUnblock(issue.companyId, issue.id, latestRun)) {
            // BLO-8050: operator just unblocked; skip re-escalation on stale evidence.
            result.skipped += 1;
            continue;
          }
          const updated = await escalateStrandedAssignedIssue({
            issue,
            previousStatus: "todo",
            latestRun,
            comment: buildSessionUnavailableAdapterMismatchComment({
              previousStatus: "todo",
              ...todoSessionUnavailableAdapterMismatch,
            }),
          });
          if (updated) {
            result.escalated += 1;
            result.issueIds.push(issue.id);
          } else {
            result.skipped += 1;
          }
          continue;
        }

        if (
          latestRun.agentId === agentId &&
          isZeroTokenStartupFailureRun({
            ...latestRun,
            adapterType: todoHistoricalAdapterType,
          })
        ) {
          if (await latestRunPredatesLatestUnblock(issue.companyId, issue.id, latestRun)) {
            // BLO-8050: operator just unblocked; skip re-escalation on stale evidence.
            result.skipped += 1;
            continue;
          }
          if (isZeroTokenSessionResetRetryRun(latestRun)) {
            const updated = await escalateZeroTokenStartupFailureIssue({
              issue,
              previousStatus: "todo",
              latestRun,
              expectedLockOwnerState: adoptionHandoverLockGuard,
            });
            if (updated) {
              result.escalated += 1;
              result.zeroTokenStartupFailureBlocked += 1;
              result.issueIds.push(issue.id);
            } else {
              result.skipped += 1;
            }
            continue;
          }
          if (await isInvocationBudgetBlocked(issue, agentId)) {
            result.skipped += 1;
            continue;
          }
          const retried = await resetSessionAndRetryZeroTokenFailure({ issue, agent, latestRun });
          if (retried) {
            result.zeroTokenSessionResetRetried += 1;
            result.issueIds.push(issue.id);
          } else {
            result.skipped += 1;
          }
          continue;
        }

        if (didAutomaticRecoveryFail(latestRun, "assignment_recovery")) {
          if (await latestRunPredatesLatestUnblock(issue.companyId, issue.id, latestRun)) {
            // BLO-8050: operator just unblocked; skip re-escalation on stale evidence.
            result.skipped += 1;
            continue;
          }
          const failureSummary = summarizeRunFailureForIssueComment(latestRun);
          const updated = await escalateStrandedAssignedIssue({
            expectedLockOwnerState: adoptionHandoverLockGuard,
            issue,
            previousStatus: "todo",
            latestRun,
            comment:
              "Paperclip automatically retried dispatch for this assigned `todo` issue after a lost wake/run, " +
              `but it still has no live execution path.${failureSummary ?? ""} ` +
              "Moving it to `blocked` so it is visible for intervention.",
          });
          if (updated) {
            result.escalated += 1;
            result.issueIds.push(issue.id);
          } else {
            result.skipped += 1;
          }
          continue;
        }

        if (await isInvocationBudgetBlocked(issue, agentId)) {
          result.skipped += 1;
          continue;
        }

        const queued = await enqueueWithAssignmentRecoveryCapacity(issue, agentId, () =>
          enqueueStrandedIssueRecovery({
            expectedLockOwnerState: adoptionHandoverLockGuard,
            issueId: issue.id,
            agentId,
            reason: "issue_assignment_recovery",
            retryReason: "assignment_recovery",
            source: "issue.assignment_recovery",
            retryOfRunId: latestRun.id,
          })
        );
        if (queued) {
          result.dispatchRequeued += 1;
          result.issueIds.push(issue.id);
        } else {
          result.skipped += 1;
        }
        continue;
      }

      // No run evidence and no lock: nothing to recover from. A handover marker
      // is the exception — there the absence of usable evidence is deliberate
      // (BLO-19160) or the result of normal adoption cleanup, and the issue
      // still needs a live path, so let it fall through to the continuation
      // re-dispatch at the end.
      if (
        !latestRun &&
        !issue.checkoutRunId &&
        !issue.executionRunId &&
        !adoptionHandoverNeedsNeutralRecovery &&
        !reopenedAfterTerminalDispatchRace
      ) {
        result.skipped += 1;
        continue;
      }
      const handoffEvidence = isExhaustedSuccessfulRunHandoff(latestRun);
      if (handoffEvidence) {
        if (!handoffEvidence.exhausted) {
          result.skipped += 1;
          continue;
        }

        const updated = await escalateStrandedAssignedIssue({
          expectedLockOwnerState: adoptionHandoverLockGuard,
          issue,
          previousStatus: "in_progress",
          latestRun,
          recoveryCause: SUCCESSFUL_RUN_MISSING_STATE_REASON,
          successfulRunHandoffEvidence: handoffEvidence,
        });
        if (updated) {
          result.successfulRunHandoffEscalated += 1;
          result.issueIds.push(issue.id);
        } else {
          result.skipped += 1;
        }
        continue;
      }
      if (isWaitingOnReviewContinuationRun(latestRun) && hasActiveMonitorPath(issue)) {
        const parkOutcome = await parkReviewWaitingContinuationIssue({
          issue,
          previousStatus: "in_progress",
          latestRun,
          expectedLockOwnerState: adoptionHandoverLockGuard,
        });
        if (parkOutcome === "parked") {
          result.reviewWaitingParked += 1;
          result.issueIds.push(issue.id);
        } else {
          result.skipped += 1;
        }
        continue;
      }
      if (isSuccessfulInProgressContinuationRun(latestRun)) {
        const successfulRun = latestRun;
        if (isProductiveContinuationRun(successfulRun)) {
          const repeatedProductiveContinuation = isRepeatedProductiveContinuationRecovery(successfulRun);
          if (repeatedProductiveContinuation) {
            // GGU-809: visible assignee progress means a batch-style workflow
            // is still advancing; skip escalation and enqueue the next
            // continuation wake below.
            const exempted = await hasRecentVisibleProgress(
              issue.companyId,
              issue.id,
              agentId,
              STRANDED_RECENT_PROGRESS_EXEMPTION_MS,
            );
            if (!exempted) {
              const updated = await escalateStrandedAssignedIssue({
                expectedLockOwnerState: adoptionHandoverLockGuard,
                issue,
                previousStatus: "in_progress",
                latestRun: successfulRun,
                comment:
                  "Paperclip automatically retried continuation for this assigned `in_progress` issue and the retry " +
                  "made progress, but it still has no live execution path. Moving it to `blocked` so it is visible for intervention.",
              });
              if (updated) {
                result.escalated += 1;
                result.issueIds.push(issue.id);
              } else {
                result.skipped += 1;
              }
              continue;
            }
            result.recentProgressExempted += 1;
          }
          if (await isInvocationBudgetBlocked(issue, agentId)) {
            result.skipped += 1;
            continue;
          }
          const queued = await enqueueStrandedIssueRecovery({
            expectedLockOwnerState: adoptionHandoverLockGuard,
            issueId: issue.id,
            agentId,
            reason: "issue_continuation_needed",
            retryReason: "issue_continuation_needed",
            source: "issue.productive_terminal_continuation_recovery",
            retryOfRunId: successfulRun.id,
          });
          if (queued) {
            if (isAutomaticContinuationRun(successfulRun) && !repeatedProductiveContinuation) {
              result.productiveContinuationObserved += 1;
            } else {
              result.continuationRequeued += 1;
              result.issueIds.push(issue.id);
            }
          } else {
            result.skipped += 1;
          }
          continue;
        }
        // Non-productive succeeded run: most stranding pattern is the agent
        // exiting cleanly with no actionable output (plan_only / empty
        // response / null liveness), the harness posting "No response
        // requested." and the next sweep waking the agent again. Each
        // iteration burns provider quota for zero forward progress.
        // Look back across recent runs; if the consecutive non-productive
        // streak has hit the threshold, escalate to blocked instead of
        // waking the agent yet another time.
        result.successfulContinuationObserved += 1;
        const nonProductiveStreak = await countConsecutiveNonProductiveSuccessfulRuns(
          issue.companyId,
          issue.id,
          NON_PRODUCTIVE_RUN_NOOP_THRESHOLD,
        );
        if (nonProductiveStreak >= NON_PRODUCTIVE_RUN_NOOP_THRESHOLD) {
          const updated = await escalateStrandedAssignedIssue({
            expectedLockOwnerState: adoptionHandoverLockGuard,
            issue,
            previousStatus: "in_progress",
            latestRun,
            comment:
              `Paperclip detected ${nonProductiveStreak} consecutive succeeded heartbeat runs producing no actionable output ` +
              "(livenessState ∈ plan_only / empty_response / failed / null) — the \"No response requested.\" no-op loop. " +
              "Moving to `blocked` so an operator can investigate (assignee may be missing a tool/MCP, or the issue " +
              "needs a clearer next step) instead of burning more provider quota waking the same agent.",
          });
          if (updated) {
            logger.info(
              {
                companyId: issue.companyId,
                issueId: issue.id,
                identifier: issue.identifier,
                streak: nonProductiveStreak,
                threshold: NON_PRODUCTIVE_RUN_NOOP_THRESHOLD,
              },
              "stranded-assigned issue escalated to blocked: non-productive run streak exceeded threshold",
            );
            result.escalated += 1;
            result.issueIds.push(issue.id);
          } else {
            result.skipped += 1;
          }
        }
        continue;
      }
      if (isNonRetryableTerminalRun(latestRun)) {
        if (await latestRunPredatesLatestUnblock(issue.companyId, issue.id, latestRun)) {
          // BLO-8050: operator just unblocked; skip re-escalation on stale evidence.
          result.skipped += 1;
          continue;
        }
        const updated = await escalateStrandedAssignedIssue({
          expectedLockOwnerState: adoptionHandoverLockGuard,
          issue,
          previousStatus: "in_progress",
          latestRun,
          comment: buildNonRetryableEscalationComment({ status: "in_progress", latestRun }),
        });
        if (updated) {
          result.escalated += 1;
          result.issueIds.push(issue.id);
        } else {
          result.skipped += 1;
        }
        continue;
      }
      const continuationHistoricalAdapterType = latestRun
        ? await resolveSessionUnavailableRunAdapterType({ issue, latestRun })
        : null;
      const continuationSessionUnavailableAdapterMismatch =
        sessionUnavailableAdapterMismatch({
          latestRun,
          agent,
          historicalAdapterType: continuationHistoricalAdapterType,
        });
      if (continuationSessionUnavailableAdapterMismatch) {
        if (await latestRunPredatesLatestUnblock(issue.companyId, issue.id, latestRun)) {
          // BLO-8050: operator just unblocked; skip re-escalation on stale evidence.
          result.skipped += 1;
          continue;
        }
        const updated = await escalateStrandedAssignedIssue({
          issue,
          previousStatus: "in_progress",
          latestRun,
          comment: buildSessionUnavailableAdapterMismatchComment({
            previousStatus: "in_progress",
            ...continuationSessionUnavailableAdapterMismatch,
          }),
        });
        if (updated) {
          result.escalated += 1;
          result.issueIds.push(issue.id);
        } else {
          result.skipped += 1;
        }
        continue;
      }
      if (
        latestRun?.agentId === agentId &&
        isZeroTokenStartupFailureRun({
          ...latestRun,
          adapterType: continuationHistoricalAdapterType,
        })
      ) {
        if (await latestRunPredatesLatestUnblock(issue.companyId, issue.id, latestRun)) {
          // BLO-8050: operator just unblocked; skip re-escalation on stale evidence.
          result.skipped += 1;
          continue;
        }
        if (isZeroTokenSessionResetRetryRun(latestRun)) {
          const updated = await escalateZeroTokenStartupFailureIssue({
            issue,
            previousStatus: "in_progress",
            latestRun,
            expectedLockOwnerState: adoptionHandoverLockGuard,
          });
          if (updated) {
            result.escalated += 1;
            result.zeroTokenStartupFailureBlocked += 1;
            result.issueIds.push(issue.id);
          } else {
            result.skipped += 1;
          }
          continue;
        }
        if (await isInvocationBudgetBlocked(issue, agentId)) {
          result.skipped += 1;
          continue;
        }
        const retried = await resetSessionAndRetryZeroTokenFailure({ issue, agent, latestRun });
        if (retried) {
          result.zeroTokenSessionResetRetried += 1;
          result.issueIds.push(issue.id);
        } else {
          result.skipped += 1;
        }
        continue;
      }
      if (isUnsuccessfulTerminalIssueRun(latestRun)) {
        if (await latestRunPredatesLatestUnblock(issue.companyId, issue.id, latestRun)) {
          // BLO-8050: operator just unblocked; skip re-escalation on stale evidence.
          result.skipped += 1;
          continue;
        }
        const classification = classifyContinuationFailure(latestRun);

        if (classification.errorCode === CONTINUATION_WAITING_ON_REVIEW_ERROR_CODE) {
          const resolved = await resolveContinuationWaitingOnReview(issue, adoptionHandoverLockGuard);
          if (resolved) {
            result.waitingOnReviewResolved += 1;
            result.issueIds.push(issue.id);
            continue;
          }
          // BLO-16146: a genuine continuation cancellation that deliberately parked for
          // review/approval, with no dependency to wait on and no active monitor path.
          // Park it `in_review` rather than escalating to `blocked` as if its execution
          // were lost. Gated on isWaitingOnReviewContinuationRun (cancelled +
          // issue_continuation_needed) so a `failed`/`timed_out` run that merely carries
          // this error code is NOT treated as a deliberate wait.
          if (isWaitingOnReviewContinuationRun(latestRun)) {
            const parkOutcome = await parkNoDependencyReviewWaitingIssue({
              issue,
              previousStatus: "in_progress",
              latestRun,
              expectedLockOwnerState: adoptionHandoverLockGuard,
            });
            if (parkOutcome === "parked") {
              result.reviewWaitingParked += 1;
              result.issueIds.push(issue.id);
              continue;
            }
            if (parkOutcome === "already_parked") {
              // BLO-18643: the common case on a re-run -- the issue was already parked
              // `in_review` by an earlier pass (parkNoDependencyReviewWaitingIssue's own
              // guard requires `status === "in_progress"`). Never a stranded escalation:
              // falling through here previously let the second sweep pass clobber a
              // just-parked issue back to `blocked` 21s later.
              result.skipped += 1;
              continue;
            }
            if (parkOutcome === "lost_race") {
              result.skipped += 1;
              continue;
            }
            // `failed` is a genuine park failure (evidence-gate rejection
            // because there's nothing reviewable yet, or a transient update
            // failure). Fall through to the normal blocked recovery path.
          }
        }

        // BLO-19124: `issue_dependencies_blocked` is a *wait*, not a failure. The
        // dispatcher emits it when `listDependencyReadiness` says the issue is not
        // dependency-ready, and its own cancellation reason promises "Paperclip will
        // wake the assignee when blockers resolve" — that wake comes from
        // `listWakeableBlockedDependents` when the blocker closes. It shares the
        // non-retryable Set with genuine failures (`agent_not_invokable`,
        // `budget_exhausted`) only because neither should burn retry attempts, and
        // that co-tenancy made every correctly-sequenced DAG node escalate as a
        // strand: 158 of 161 active recovery actions on one inbox, all 158 with a
        // genuinely unresolved blocker. Escalating them is worse than a no-op —
        // `escalateStrandedAssignedIssue` reassigns the issue to a recovery owner, so
        // the dependency wake then fires at an agent that is no longer the assignee.
        // Re-evaluate readiness *now* (not from the run's stale evidence): if the
        // dispatcher's own gate would still refuse, there is nothing an owner can do,
        // so skip.
        //
        // BLO-27463 removed the other half of this rationale. It used to read: "Keep
        // escalating when the issue is dependency-ready, because 'dependency-blocked
        // with nothing blocking it' is a real defect and is exactly the
        // `blocked`-with-zero-blockers state this ticket forbids." The defect is real,
        // but escalation was measured to *produce* that state rather than prevent it —
        // all 24 escalations opened this way between 2026-08-09 and 2026-08-18 came to
        // rest `blocked` with an empty blocker set, undispatchable per BLO-21523. The
        // dependency-ready arm is therefore refused outright at the transactional gate
        // in `escalateStrandedAssignedIssue`, which every caller passes through, and
        // the defect stays visible via its `dependencyWaitEscalationSuppressed` counter.
        // The early `continue`s below remain worth keeping: they skip before the
        // transaction and account the row as `dependencyWaitSkipped` (still blocked)
        // rather than as a suppressed defect.
        if (classification.errorCode === DEPENDENCY_BLOCKED_ERROR_CODE) {
          const readinessMap = await issuesSvc.listDependencyReadiness(issue.companyId, [issue.id]);
          const readiness = readinessMap.get(issue.id);
          if (readiness && !readiness.isDependencyReady) {
            result.dependencyWaitSkipped += 1;
            result.skipped += 1;
            continue;
          }
          if (readiness?.isDependencyReady && readiness.blockerIssueIds.length > 0) {
            const latestDependencyReadyAt = await latestDependencyReadinessTransitionAt(issue.companyId, readiness.blockerIssueIds);
            if (
              isWithinDependencyResolvedWakeGrace(latestDependencyReadyAt) ||
              await hasObservableDependencyResolvedWakePath({ issue, blockerIssueIds: readiness.blockerIssueIds })
            ) {
              result.dependencyWaitSkipped += 1;
              result.skipped += 1;
              continue;
            }
          }
        }

        if (classification.kind === "non_retryable") {
          const failureSummary = summarizeRunFailureForIssueComment(latestRun);
          const updated = await escalateStrandedAssignedIssue({
            expectedLockOwnerState: adoptionHandoverLockGuard,
            issue,
            previousStatus: "in_progress",
            latestRun,
            comment:
              "Paperclip detected a non-retryable failure on this issue's continuation run " +
              `(\`${classification.errorCode}\`). Skipping automatic retries and moving it to \`blocked\` ` +
              `so it is visible for intervention.${failureSummary ?? ""}`,
          });
          if (updated) {
            result.escalated += 1;
            result.issueIds.push(issue.id);
          } else {
            result.skipped += 1;
          }
          continue;
        }

        // BLO-16182: enter the cap+backoff block for any latest terminal run that
        // is an automatic retry attempt for this budget (continuation sweep OR, for
        // process_lost, the in-reaper engine-B retry) — symmetric with the streak
        // counter so an engine-B-latest interleaving can't skip the cap.
        if (isAutomaticContinuationRecoveryRun(latestRun, classification.errorCode)) {
          const { consecutive, latestFinishedAt } = await summarizeRecentContinuationRetries(
            issue.companyId,
            issue.id,
            agentId,
            classification.errorCode,
          );
          if (consecutive >= classification.maxAttempts) {
            const failureSummary = summarizeRunFailureForIssueComment(latestRun);
            const attemptCopy = consecutive <= 1 ? "" : ` (${consecutive}× attempts)`;
            const causeCopy = classification.errorCode
              ? ` Latest cause: \`${classification.errorCode}\`.`
              : "";
            const updated = await escalateStrandedAssignedIssue({
              expectedLockOwnerState: adoptionHandoverLockGuard,
              issue,
              previousStatus: "in_progress",
              latestRun,
              comment:
                "Paperclip automatically retried continuation for this assigned `in_progress` issue after its live " +
                `execution disappeared, but it still has no live execution path${attemptCopy}.${causeCopy}${failureSummary ?? ""} ` +
                "Moving it to `blocked` so it is visible for intervention.",
            });
            if (updated) {
              result.escalated += 1;
              result.issueIds.push(issue.id);
            } else {
              result.skipped += 1;
            }
            continue;
          }

          if (classification.baseBackoffMs > 0 && latestFinishedAt) {
            const elapsed = Date.now() - latestFinishedAt.getTime();
            const requiredDelay = classification.baseBackoffMs *
              Math.pow(2, Math.max(0, consecutive - 1));
            if (elapsed < requiredDelay) {
              result.skipped += 1;
              continue;
            }
          }
        }
      }

      if (await isInvocationBudgetBlocked(issue, agentId)) {
        result.skipped += 1;
        continue;
      }

      const queued = await enqueueStrandedIssueRecovery({
        issueId: issue.id,
        agentId,
        reason: "issue_continuation_needed",
        retryReason: "issue_continuation_needed",
        source: "issue.continuation_recovery",
        // BLO-19160: prefer the handover marker over the lock columns for
        // provenance — on the handover path the lock may name a run dispatched
        // for a different issue, while the marker is scoped to this one.
        retryOfRunId: latestRun?.id ?? adoptionHandoverMarkerRunId ?? issue.checkoutRunId ?? null,
        expectedLockOwnerState: adoptionHandoverLockGuard,
      });
      if (queued) {
        result.continuationRequeued += 1;
        result.issueIds.push(issue.id);
      } else {
        result.skipped += 1;
      }
    }

    const orphanBlockerRecovery = await reconcileUnassignedBlockingIssues();
    result.orphanBlockersAssigned = orphanBlockerRecovery.assigned;
    result.skipped += orphanBlockerRecovery.skipped;
    result.issueIds.push(...orphanBlockerRecovery.issueIds);

    result.dependencyWaitEscalationSuppressed =
      dependencyWaitEscalationSuppressedTotal - dependencyWaitEscalationSuppressedAtSweepStart;

    return result;
  }

  async function collectIssueGraphLiveness() {
    const issueRowsPromise = Promise.resolve(db
      .select({
        id: issues.id,
        companyId: issues.companyId,
        identifier: issues.identifier,
        title: issues.title,
        status: issues.status,
        projectId: issues.projectId,
        goalId: issues.goalId,
        parentId: issues.parentId,
        assigneeAgentId: issues.assigneeAgentId,
        assigneeUserId: issues.assigneeUserId,
        createdByAgentId: issues.createdByAgentId,
        createdByUserId: issues.createdByUserId,
        executionPolicy: issues.executionPolicy,
        executionState: issues.executionState,
        monitorNextCheckAt: issues.monitorNextCheckAt,
        monitorAttemptCount: issues.monitorAttemptCount,
      })
      .from(issues)
      .where(
        and(
          visibleIssueCondition(),
          notInArray(issues.originKind, [RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation]),
        ),
      ));

    const [
      issueRows,
      relationRows,
      agentRows,
      activeRunRows,
      activeIssueRunRows,
      wakeRows,
      interactionRows,
      approvalRows,
      recoveryIssueRows,
      recoveryActionRows,
    ] = await Promise.all([
      db
        .select({
          id: issues.id,
          companyId: issues.companyId,
          identifier: issues.identifier,
          title: issues.title,
          status: issues.status,
          projectId: issues.projectId,
          goalId: issues.goalId,
          parentId: issues.parentId,
          assigneeAgentId: issues.assigneeAgentId,
          assigneeUserId: issues.assigneeUserId,
          createdByAgentId: issues.createdByAgentId,
          createdByUserId: issues.createdByUserId,
          executionPolicy: issues.executionPolicy,
          executionState: issues.executionState,
          lastActivityAt: issues.lastActivityAt,
          monitorNextCheckAt: issues.monitorNextCheckAt,
          monitorAttemptCount: issues.monitorAttemptCount,
          // BLO-27912: the deliberate-park deadline. The classifier compares it against
          // `now` itself, so an elapsed park is carried in and correctly stops suppressing.
          parkedUntil: issues.parkedUntil,
          // BLO-24662: only used to derive the `hasExternalWaitOwner` boolean below. The
          // prose itself never reaches the classifier — a description can carry
          // external-wait details that are redacted on read.
          description: issues.description,
        })
        .from(issues)
        .where(
          and(
            isNull(issues.hiddenAt),
            notInArray(issues.originKind, [RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation]),
          ),
        ),
      db
        .select({
          companyId: issueRelations.companyId,
          blockerIssueId: issueRelations.issueId,
          blockedIssueId: issueRelations.relatedIssueId,
        })
        .from(issueRelations)
        .where(eq(issueRelations.type, "blocks")),
      db
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
        .from(agents),
      db
        .select({
          companyId: heartbeatRuns.companyId,
          agentId: heartbeatRuns.agentId,
          status: heartbeatRuns.status,
          contextSnapshot: heartbeatRuns.contextSnapshot,
        })
        .from(heartbeatRuns)
        .where(inArray(heartbeatRuns.status, [...EXECUTION_PATH_HEARTBEAT_RUN_STATUSES])),
      db
        .select({
          companyId: issues.companyId,
          agentId: heartbeatRuns.agentId,
          status: heartbeatRuns.status,
          issueId: issues.id,
        })
        .from(issues)
        .innerJoin(heartbeatRuns, eq(issues.executionRunId, heartbeatRuns.id))
        .where(
          and(
            visibleIssueCondition(),
            notInArray(issues.originKind, [RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation]),
            inArray(heartbeatRuns.status, [...EXECUTION_PATH_HEARTBEAT_RUN_STATUSES]),
          ),
        ),
      db
        .select({
          companyId: agentWakeupRequests.companyId,
          agentId: agentWakeupRequests.agentId,
          status: agentWakeupRequests.status,
          payload: agentWakeupRequests.payload,
        })
        .from(agentWakeupRequests)
        .where(inArray(agentWakeupRequests.status, ["queued", "deferred_issue_execution"])),
      db
        .select({
          companyId: issueThreadInteractions.companyId,
          issueId: issueThreadInteractions.issueId,
          status: issueThreadInteractions.status,
        })
        .from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.status, "pending")),
      db
        .select({
          companyId: issueApprovals.companyId,
          issueId: issueApprovals.issueId,
          status: approvals.status,
        })
        .from(issueApprovals)
        .innerJoin(approvals, eq(issueApprovals.approvalId, approvals.id))
        .where(inArray(approvals.status, ["pending", "revision_requested"])),
      db
        .select({
          companyId: issues.companyId,
          id: issues.id,
          status: issues.status,
          originKind: issues.originKind,
          originId: issues.originId,
        })
        .from(issues)
        .where(
          and(
            visibleIssueCondition(),
            inArray(issues.originKind, [
              STRANDED_ISSUE_RECOVERY_ORIGIN_KIND,
              RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation,
            ]),
            notInArray(issues.status, ["done", "cancelled"]),
          ),
        ),
      issueRowsPromise.then((rows) => {
        const issueIdsUnderAnalysis = rows.map((row) => row.id);
        return issueIdsUnderAnalysis.length === 0
          ? []
          : db
            .select({
              companyId: issueRecoveryActions.companyId,
              issueId: issueRecoveryActions.sourceIssueId,
              status: issueRecoveryActions.status,
            })
            .from(issueRecoveryActions)
            .where(
              and(
                inArray(issueRecoveryActions.status, ["active", "escalated"]),
                inArray(issueRecoveryActions.sourceIssueId, issueIdsUnderAnalysis),
              ),
            );
      }),
    ]);

    // Waiting paths contributed by OPEN liveness escalations, kept separate from every
    // other recovery-shaped waiting path (stranded-issue recoveries, open recovery
    // actions) so the premise re-check below can drop exactly these and nothing else.
    const escalationRecoveryIssues = recoveryIssueRows.flatMap((row) => {
      if (row.originKind !== RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation) return [];
      const parsed = parseIssueGraphLivenessIncidentKey(row.originId);
      if (!parsed || parsed.companyId !== row.companyId) return [];
      return [
        {
          companyId: row.companyId,
          issueId: parsed.issueId,
          status: row.status,
        },
        {
          companyId: row.companyId,
          issueId: parsed.leafIssueId,
          status: row.status,
        },
      ];
    });

    const nonEscalationRecoveryIssues = recoveryIssueRows.flatMap((row) => {
      if (row.originKind === RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation) return [];
      const issueId = readNonEmptyString(row.originId);
      if (!issueId) return [];
      return [{
        companyId: row.companyId,
        issueId,
        status: row.status,
      }];
    });

    const sharedInput = {
      issues: issueRows.map(({ description, ...issue }) => ({
        ...issue,
        hasExternalWaitOwner: externalWaitFromDescription(description ?? null) !== null,
      })),
      relations: relationRows,
      agents: agentRows,
      activeRuns: activeRunRows.map((row) => ({
        companyId: row.companyId,
        agentId: row.agentId,
        status: row.status,
        issueId: issueIdFromRunContext(row.contextSnapshot),
      })).concat(activeIssueRunRows.map((row) => ({
        companyId: row.companyId,
        agentId: row.agentId,
        status: row.status,
        issueId: row.issueId,
      }))),
      queuedWakeRequests: wakeRows.map((row) => ({
        companyId: row.companyId,
        agentId: row.agentId,
        status: row.status,
        issueId: issueIdFromWakePayload(row.payload),
      })),
      pendingInteractions: interactionRows,
      pendingApprovals: approvalRows,
      now: new Date(),
    };

    const baselineRecoveryIssues = escalationRecoveryIssues
      .concat(nonEscalationRecoveryIssues)
      .concat(recoveryActionRows);

    return {
      // The MINTING view. An open escalation contributes a waiting path for its own
      // subject and leaf, which is what stops the detector re-firing the same incident
      // every 30s tick while somebody is already on it (BLO-15200). Everything that
      // creates escalations must keep reading this one.
      findings: classifyIssueGraphLiveness({
        ...sharedInput,
        openRecoveryIssues: baselineRecoveryIssues,
      }),
      // BLO-29601: the PREMISE RE-CHECK view, and the reason this function classifies
      // twice. `hasExplicitWaitingPath` treats an open recovery issue as a satisfier, so
      // an escalation supplies the action path for the very issue it was minted about.
      // That is self-sealing: the invariant stops firing the moment the escalation
      // exists, so "does this still fire?" answers no for every escalation — the live
      // ones included — and a re-check built on the minting view would auto-close the
      // entire backlog rather than only the dead half.
      //
      // Dropping ALL escalation-contributed waiting paths rather than only the one under
      // evaluation is deliberate: two escalations covering each other's subject would
      // otherwise each read as satisfied by the other, which is the same self-sealing
      // defect one hop out. Non-escalation recovery paths stay in — those are real,
      // independently-owned action paths.
      //
      // Strictly a read: this set is never used to create anything.
      escalationBlindFindings: classifyIssueGraphLiveness({
        ...sharedInput,
        openRecoveryIssues: nonEscalationRecoveryIssues.concat(recoveryActionRows),
      }),
    };
  }

  async function collectIssueGraphLivenessFindings() {
    return (await collectIssueGraphLiveness()).findings;
  }

  async function findOpenLivenessEscalation(companyId: string, incidentKey: string) {
    return db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation),
          eq(issues.originId, incidentKey),
          visibleIssueCondition(),
          notInArray(issues.status, ["done", "cancelled"]),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function findOpenLivenessRecoveryIssueForLeaf(finding: IssueLivenessFinding) {
    const byFingerprint = await db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, finding.companyId),
          eq(issues.originKind, RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation),
          eq(issues.originFingerprint, livenessRecoveryLeafFingerprint(finding)),
          visibleIssueCondition(),
          notInArray(issues.status, ["done", "cancelled"]),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (byFingerprint) return byFingerprint;

    const leafIssueId = livenessRecoveryLeafIssueId(finding);
    const openRecoveries = await db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, finding.companyId),
          eq(issues.originKind, RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation),
          visibleIssueCondition(),
          notInArray(issues.status, ["done", "cancelled"]),
        ),
      );
    return openRecoveries.find((row) => {
      const parsed = parseLivenessIncidentKey(row.originId);
      return parsed?.state === finding.state && parsed.leafIssueId === leafIssueId;
    }) ?? null;
  }

  /**
   * Should we suppress re-raising an escalation we have already delivered once?
   *
   * Two suppressors (BLO-27676):
   *
   *   1. `cooldown` -- a `done` escalation for this incident inside `cooldownMs`.
   *      Debounces the detector against its own sweep cadence. Unchanged.
   *
   *   2. `unchanged_target` -- a `done` escalation for this incident whose leaf
   *      target has had no activity since it resolved. This is the termination
   *      path the class lacked. The old rule was purely time-based: it consulted
   *      only elapsed time, never the target, so it always expired and an
   *      unchanged leaf re-escalated forever. Measured on one leaf: four
   *      byte-identical `originFingerprint` rows over five days at ~75 min
   *      inter-arrival, which is exactly this 60 min cooldown plus the next
   *      sweep. We have already reported this leaf in this state to an owner who
   *      resolved the report; re-delivering an unchanged fact on a timer is
   *      noise, not liveness.
   *
   *      Bounded by `DEFAULT_LIVENESS_UNCHANGED_TARGET_SUPPRESSION_MS` (7d).
   *      Without a ceiling this suppressor is permanent, because the leaf is
   *      quiet by construction: an escalation closed `done` without giving the
   *      leaf an action path would never be re-reported, which is a silent hole
   *      in a liveness detector and the exact defect this class started as, with
   *      the sign flipped. The ceiling keeps the worst case at weekly rather
   *      than never.
   *
   * `cooldownMs` (the public `reescalationCooldownMs` option) governs suppressor
   * 1 only; passing 0 no longer disables re-escalation suppression outright, it
   * disables the weaker of the two. Pass `unchangedTargetSuppressionMs: 0` for
   * the pre-BLO-27676 time-only behaviour.
   *
   * Note this is a suppressor on RE-escalation only. Suppression while an
   * escalation is still open is a separate, deliberate mechanism -- the open row
   * contributes a waiting path for its leaf, so the finding does not re-fire.
   * That behaviour is intentional and is pinned by "treats open recovery issues
   * as active waiting paths for non-assigned-backlog states" and by "creates one
   * bounded escalation for an assigned backlog blocker leaf"; do not remove it in
   * an attempt to fix the loop. The loop lives here, in the re-arm.
   *
   * What still re-arms, so this cannot degrade into "stop escalating":
   *   - any activity on the leaf after the resolution
   *   - the suppression ceiling elapsing (see 2 above)
   *   - a different invariant state (the fingerprint carries `state`)
   *   - a `cancelled` rather than `done` prior escalation
   *   - a leaf we cannot read (fails open)
   *
   * Trade-off, now bounded rather than open-ended: an escalation resolved `done`
   * WITHOUT actually giving the leaf an action path will not re-raise under the
   * same fingerprint until the leaf is touched or the ceiling elapses. That is
   * the intended reading of "closing a row must not, by itself, regenerate it";
   * the alternative is the unbounded loop this replaces, and cancelling rather
   * than closing re-arms immediately. Resolving an escalation does not itself
   * write to the leaf (`removeRecoveryBlockerFromSource` touches the SOURCE), so
   * the comparison is stable rather than self-clearing.
   */
  async function findSuppressingResolvedLivenessRecoveryIssue(
    finding: IssueLivenessFinding,
    now: Date,
    cooldownMs: number,
    unchangedTargetSuppressionMs: number,
  ) {
    // With both suppressors off the function can only return null (the cooldown
    // branch needs `cooldownMs > 0`, the target-state branch needs
    // `unchangedTargetSuppressionMs > 0`), so skip the query rather than issuing
    // it once per finding per sweep to discard the row. Keeps "suppression fully
    // disabled" genuinely free instead of merely inert.
    if (cooldownMs <= 0 && unchangedTargetSuppressionMs <= 0) return null;

    // Retired-row cooldown (BLO-28957). Checked before the `done` lookup below
    // because it is the cheaper query -- bounded by the cooldown (60m default)
    // rather than by `max(cooldown, unchangedTarget)` (7d) -- so a hit here
    // saves the wide scan entirely.
    //
    // This exists because retiring a row IS the re-file trigger: the retire
    // cancels the row, `openRecoveryIssues` then sees nothing open, and the very
    // next sweep re-files. On a `done`-only cooldown the abandonment bound above
    // would therefore have converted an unbounded wedge into an unbounded
    // re-file loop -- the 48% re-file rate (240 of 500 rows, 2026-08-18) that
    // BLO-28618 exists to kill, just on a timer. The bound and this hold are one
    // change; neither is safe alone.
    //
    // Scoped to the COOLDOWN branch only, and that scoping is load-bearing. The
    // `unchanged_target` branch below suppresses for up to 7 days on the reading
    // that a report closed `done` without the leaf being touched should not
    // re-raise every 75 minutes. A cancellation is not that: it is not a
    // resolution, and the leaf of an abandoned row is quiet *by construction*
    // (that is the finding's precondition), so letting `cancelled` reach that
    // branch would suppress the re-escalation for a week and trade this issue's
    // unbounded wedge for a 7-day recurring one. Feeding it through the 60m
    // cooldown instead holds exactly one sweep-cycle's worth of churn and then
    // lets the finding speak again.
    //
    // Kept as a SEPARATE query rather than widening the status filter below, so
    // BLO-27676 is provably unperturbed. Widening that filter would let a
    // recently-cancelled row out-sort an older `done` row under the shared
    // `limit(1)`, which would silently *weaken* the target-state suppressor for
    // reasons unrelated to this fix.
    //
    // Accepted cost, stated so a reviewer can weigh it: when a human cancels a
    // row they consider bogus, re-escalation is delayed by one cooldown rather
    // than firing on the next sweep. The end state is identical -- the finding
    // re-files if it still reproduces -- so this trades ~1h of latency in that
    // case for closing the loop. First-time detection on an incident sharing
    // neither key nor leaf fingerprint is unaffected.
    if (cooldownMs > 0) {
      const cooldownCutoff = new Date(
        now.getTime() - cooldownMs - LIVENESS_SUPPRESSION_SCAN_SKEW_MS,
      );
      const recentlyCancelled = await db
        .select({
          id: issues.id,
          identifier: issues.identifier,
          status: issues.status,
          completedAt: issues.completedAt,
          updatedAt: issues.updatedAt,
        })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, finding.companyId),
            eq(issues.originKind, RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation),
            or(
              eq(issues.originId, finding.incidentKey),
              eq(issues.originFingerprint, livenessRecoveryLeafFingerprint(finding)),
            ),
            visibleIssueCondition(),
            eq(issues.status, "cancelled"),
            // Same sargability and skew reasoning as the `done` query below:
            // filter on bare `updated_at` (servable by
            // `issues_company_updated_idx`) while comparing on
            // `coalesce(completed_at, updated_at)`, with slack so a row whose
            // `completed_at` leads `updated_at` is not dropped at the boundary.
            gte(issues.updatedAt, cooldownCutoff),
          ),
        )
        .orderBy(desc(sql`coalesce(${issues.completedAt}, ${issues.updatedAt})`), desc(issues.id))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      const cancelledAtMs = (recentlyCancelled?.completedAt ?? recentlyCancelled?.updatedAt)
        ?.getTime();
      if (
        recentlyCancelled &&
        cancelledAtMs !== undefined &&
        Number.isFinite(cancelledAtMs) &&
        cancelledAtMs >= now.getTime() - cooldownMs
      ) {
        return {
          id: recentlyCancelled.id,
          identifier: recentlyCancelled.identifier,
          status: recentlyCancelled.status,
          resolvedAtMs: cancelledAtMs,
          reason: "cooldown" as const,
        };
      }
    }

    // The ORDER BY must be the same expression that `resolvedAtMs` reads below,
    // or the row selected is not the row whose timestamp is compared. Ordering
    // by `updatedAt` alone was wrong in both directions: any post-close edit to
    // an older escalation (reopen/re-close, assignee change, retitle, label)
    // bumps its `updatedAt` above a newer resolution, so it wins the sort while
    // contributing an older `completedAt` -- which reinstates the very loop this
    // suppressor removes -- and on rows where `completedAt` is null the drifting
    // `updatedAt` silently swallows a genuine leaf touch. Pinned by "picks the
    // most recently resolved escalation even when an older row was edited after
    // it closed".
    const resolvedAtExpr = sql`coalesce(${issues.completedAt}, ${issues.updatedAt})`;
    // Keep the scan bounded. Neither OR arm is servable for these rows: the
    // fingerprint arm's only indexes (`issues_active_liveness_recovery_leaf_uq`,
    // `issues_active_alert_escalation_cover_uq` -- schema/issues.ts) are partial
    // on `status not in ('done','cancelled')`, mutually exclusive with the
    // `status = 'done'` filter below, so the planner falls back to the
    // `(company_id, origin_kind)` prefix of `issues_company_origin_idx` and reads
    // the company's ENTIRE escalation history -- which only ever grows, since
    // resolved rows are never pruned. The version this replaced was bounded to
    // the 60m cooldown by a `gte(updatedAt, cutoff)` servable by
    // `issues_company_updated_idx`; dropping it was required for the 7d
    // target-state window, but nothing replaced it, and this runs once per stale
    // finding per sweep AND synchronously inside the operator preview endpoint.
    //
    // Bounding by `max(cooldownMs, unchangedTargetSuppressionMs)` cannot change a
    // result: every branch below already returns null for rows resolved before
    // that horizon (the cooldown branch needs `resolvedAtMs >= now - cooldownMs`;
    // the target branch returns null at `resolvedAtMs <= now -
    // unchangedTargetSuppressionMs`).
    //
    // That the `desc` ORDER BY still picks the same row is NOT a separate
    // argument that stands on its own -- it rests entirely on the skew allowance
    // introduced below, so do not read it as surviving a smaller (or absent)
    // `LIVENESS_SUPPRESSION_SCAN_SKEW_MS`. The guarantee is the superset
    // property: GIVEN `completed_at <= updated_at + skew` on every row, any row
    // with `resolvedAt >= now - horizon` also has `updated_at >= now - horizon -
    // skew`, and so survives the filter. Every row capable of a non-null result
    // therefore survives; if the global max `resolvedAt` survives it is still the
    // max among survivors, and if it does not, no row clears the horizon and the
    // answer is null either way.
    //
    // It is specifically NOT true that only excluding *every* candidate can move
    // the pick -- excluding a strict subset can. Two `done` rows for one leaf
    // under a 7d horizon: X at `completed_at = now-1h` / `updated_at = now-8d`,
    // Y at both `now-3d`. X is dropped and Y is not, the winner flips from X to
    // Y, and the outcome moves off the cooldown branch onto the leaf-read path,
    // which can return null where the unfiltered query suppressed. X clears the
    // invariant above by ~7d, which is exactly the point: it is the invariant,
    // not the number of rows excluded, that the argument needs.
    //
    // The bound is on `updatedAt` rather than on `resolvedAtExpr` because only
    // the former is sargable. That makes it a superset ONLY up to skew between
    // the two columns, and the skew does not run in the convenient direction: on
    // the primary write path `completed_at` is the LATER of the two.
    // `services/issues.ts` builds its patch with `updatedAt: new Date()` and only
    // then calls `applyStatusSideEffects`, which sets `completedAt` from a second
    // clock read one request-body later -- so `completed_at >= updated_at` there,
    // by however long the intervening validation and blocker reads take. Every
    // other path that writes `completed_at` runs in the SAFE direction: the
    // `update(issues)` sites that touch it set `completedAt` and `updatedAt`
    // from one clock read (the escalation-close path below and the reopen path,
    // both `input.now`; `productivity-review.ts` stale-close and retire, `now` /
    // `input.now`; `issue-tree-control.ts` cancel writes it null) -- those are
    // examples, NOT an inventory -- and the create path (`services/issues.ts`,
    // `values.completedAt = new Date()`) is an INSERT
    // where `updated_at` takes `defaultNow()` at DB-write time, so
    // `completed_at <= updated_at` there. Nothing bumps `updated_at` implicitly:
    // there is no `$onUpdate` on the column, and migration 0076 mirrors
    // `updated_at` INTO `last_activity_at`, not back. Deliberately not stated as
    // a count of call sites -- an earlier revision of this comment said "the
    // other four", which was already wrong when written and would rot on the
    // next refactor. The skew allowance below is what makes the exact inventory
    // non-load-bearing: it holds for ANY path whose gap stays under it,
    // including ones added later.
    //
    // Unskewed, that leaves a real hole: a row with
    // `updated_at < cutoff <= completed_at` is dropped by the filter, the
    // suppressor returns null, and the escalation re-raises -- this issue's loop
    // again, through a much narrower door. It only bites within one
    // request-duration of the horizon boundary, where the row was about to expire
    // anyway, but "narrow" is not "closed", and a seconds-wide window on a 7d
    // horizon is exactly the shape that shows up once in production and never in
    // a test. `LIVENESS_SUPPRESSION_SCAN_SKEW_MS` restores the superset property
    // for any gap below it, at the cost of scanning a bounded sliver more. Pinned
    // by "holds a leaf whose escalation closed with completed_at ahead of
    // updated_at at the horizon edge". No migration needed.
    const suppressionHorizonMs = Math.max(cooldownMs, unchangedTargetSuppressionMs);
    const horizonCutoff = new Date(
      now.getTime() - suppressionHorizonMs - LIVENESS_SUPPRESSION_SCAN_SKEW_MS,
    );
    const mostRecentDone = await db
      .select({
        id: issues.id,
        identifier: issues.identifier,
        // Read the status back rather than hardcoding "done" at the return
        // sites, even though the filter below currently admits only `done`.
        // BLO-29764 ruled (2026-08-23) that `cancelled` rows will suppress on
        // these same two gates; BLO-29838 implements that by widening the
        // filter. Sourcing the logged status from the row means that change
        // flows into the audit log for free -- and a hardcoded "done" would
        // instead go quietly, permanently wrong the day it lands.
        status: issues.status,
        completedAt: issues.completedAt,
        updatedAt: issues.updatedAt,
      })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, finding.companyId),
          eq(issues.originKind, RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation),
          or(
            eq(issues.originId, finding.incidentKey),
            eq(issues.originFingerprint, livenessRecoveryLeafFingerprint(finding)),
          ),
          visibleIssueCondition(),
          // `done` only, deliberately -- this is the branch that can suppress
          // for 7 days, and only a genuine resolution earns that. `cancelled`
          // is handled by the narrow cooldown-only lookup above (BLO-28957);
          // routing it here instead would hold an abandoned row's source silent
          // for a week, because such a leaf is quiet by construction. Pinned by
          // "holds re-escalation for one cooldown after a matching escalation is
          // cancelled", which asserts the 1h hold AND the release after it.
          eq(issues.status, "done"),
          // Sargable superset of the suppression horizon -- see the note above
          // the query. Restores the bound the 60m cooldown used to provide, and
          // carries a skew allowance because `completed_at` can lead
          // `updated_at` on the primary close path.
          gte(issues.updatedAt, horizonCutoff),
        ),
      )
      .orderBy(desc(resolvedAtExpr), desc(issues.id))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!mostRecentDone) return null;

    const resolvedAtMs = (mostRecentDone.completedAt ?? mostRecentDone.updatedAt)?.getTime();
    if (resolvedAtMs === undefined || !Number.isFinite(resolvedAtMs)) return null;

    if (cooldownMs > 0 && resolvedAtMs >= now.getTime() - cooldownMs) {
      return {
        id: mostRecentDone.id,
        identifier: mostRecentDone.identifier,
        status: mostRecentDone.status,
        resolvedAtMs,
        reason: "cooldown" as const,
      };
    }

    // Bound the target-state suppressor before paying for the leaf read. 0
    // disables it outright; past the ceiling we re-raise even on an untouched
    // leaf, so a report closed without acting on the target cannot go silent
    // forever. Pinned by "re-escalates an untouched leaf once the suppression
    // ceiling has elapsed".
    if (unchangedTargetSuppressionMs <= 0) return null;
    if (resolvedAtMs <= now.getTime() - unchangedTargetSuppressionMs) return null;

    const leaf = await db
      .select({ lastActivityAt: issues.lastActivityAt })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, finding.companyId),
          eq(issues.id, livenessRecoveryLeafIssueId(finding)),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
    // Leaf unreadable -> fall through and let the escalation be raised. Failing
    // open keeps a genuinely abandoned row escalating, which this must not regress.
    const leafActivityMs = leaf?.lastActivityAt?.getTime();
    if (leafActivityMs === undefined || !Number.isFinite(leafActivityMs)) return null;
    if (leafActivityMs > resolvedAtMs) return null;

    return {
      id: mostRecentDone.id,
      identifier: mostRecentDone.identifier,
      status: mostRecentDone.status,
      resolvedAtMs,
      reason: "unchanged_target" as const,
    };
  }

  /**
   * A 409 raised by `issuesSvc.update` because an `expectedCurrent*RunId` write
   * precondition failed — i.e. the row was checked out between the caller reading its lock
   * state and the update landing. Matched on the precondition keys `update` puts in the
   * error details rather than on the status alone, so unrelated 409s from the same call
   * still propagate instead of being silently read as "someone else took the row".
   */
  function isExecutionLockPreconditionConflict(error: unknown) {
    if (!(error instanceof HttpError) || error.status !== 409) return false;
    const details = error.details;
    if (!details || typeof details !== "object") return false;
    return "expectedCheckoutRunId" in details || "expectedExecutionRunId" in details;
  }

  type LivenessBlockerPruneOutcome = {
    /** The fabricated edge was found and cleared. */
    pruned: boolean;
    /**
     * The edge was cleared but the status restore did not land, so the source
     * is left at `blocked` with nothing unresolved -- the very
     * `blocked_without_blockers` state this prune exists to avoid producing.
     */
    restoreDegraded: boolean;
  };

  const PRUNE_NOT_APPLICABLE: LivenessBlockerPruneOutcome = { pruned: false, restoreDegraded: false };

  /**
   * Prunes a legacy fabricated blocker edge (recovery issue -> its own source)
   * left behind by escalations filed before BLO-28618 stopped writing them.
   *
   * Clearing the edge alone is not enough, and getting this wrong is how the
   * re-file loop sustained itself: a source left at `blocked` with an empty
   * blocker set is *exactly* the `blocked_without_blockers` trigger, so pruning
   * the edge re-arms the detector against the same source on the next sweep.
   * Measured on 2026-08-18: closing the recovery row as `done` -- the
   * disposition its own body prescribes -- left 11 of 11 sources in that state.
   * So restore the status in the same pass whenever nothing unresolved remains.
   */
  async function removeRecoveryBlockerFromSource(
    recovery: typeof issues.$inferSelect,
  ): Promise<LivenessBlockerPruneOutcome> {
    const parsed = parseLivenessIncidentKey(recovery.originId);
    if (!parsed) return PRUNE_NOT_APPLICABLE;
    const sourceIssue = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, recovery.companyId), eq(issues.id, parsed.issueId)))
      .then((rows) => rows[0] ?? null);
    if (!sourceIssue) return PRUNE_NOT_APPLICABLE;

    const blockerIds = await existingBlockerIssueIds(sourceIssue.companyId, sourceIssue.id);
    if (!blockerIds.includes(recovery.id)) return PRUNE_NOT_APPLICABLE;
    const nextBlockerIds = blockerIds.filter((blockerId) => blockerId !== recovery.id);

    // Compute what survives the prune BEFORE writing, so the edge clear and the
    // status restore go out as one update. Split across two writes, a crash
    // between them leaves the source at `blocked` with an empty blocker set --
    // the trigger state -- and nothing retries, because the second pass sees the
    // edge already gone and bails at the guard above.
    const { blockerIssueIds: unresolvedBlockerIds } =
      await unresolvedBlockerHumanDecisionEscalationState(sourceIssue.companyId, sourceIssue.id);
    const unresolvedAfterPrune = unresolvedBlockerIds.filter((blockerId) => blockerId !== recovery.id);
    const shouldRestoreStatus = sourceIssue.status === "blocked" && unresolvedAfterPrune.length === 0;

    let restoredSourceStatus = false;
    let restoreSkippedReason: string | null = null;
    let restoreDegraded = false;
    try {
      const updated = await issuesSvc.update(sourceIssue.id, {
        blockedByIssueIds: nextBlockerIds,
        ...(shouldRestoreStatus ? { status: "todo" as const } : {}),
      });
      // `update` resolves to null when no row matched (issues.ts:9716) -- the
      // source was deleted mid-sweep. Nothing was written: the blocker sync at
      // issues.ts:9727 sits *after* that early return, so the edge is still
      // there. Report no prune rather than counting a write that never landed.
      if (!updated) return PRUNE_NOT_APPLICABLE;
      restoredSourceStatus = shouldRestoreStatus && updated.status === "todo";
    } catch (err) {
      if (!shouldRestoreStatus) throw err;
      // NOT a blocker-validation refusal. `issuesSvc.update` only validates
      // blockers when the patch sets `in_progress` (issues.ts:9670), so a
      // `todo` patch is never rejected for unresolved blockers -- a concurrent
      // write re-adding a blocker cannot land us here. What reaches this arm is
      // infrastructure failure: lock timeout, transient DB fault, serialization
      // error. Retry the edge clear alone, because leaving the fabricated edge
      // in place is the wedge BLO-28618 exists to remove.
      //
      // That retry is a DEGRADED outcome, not a success: it clears the edge and
      // leaves the source at `blocked` with nothing unresolved, which is the
      // `blocked_without_blockers` state that re-arms the detector against this
      // same source. Log at `error` and count it, so a silent re-arm cannot
      // hide behind an incremented `blockerRelationsRemoved`.
      restoreSkippedReason = err instanceof Error ? err.message : String(err);
      logger.error(
        { err, issueId: sourceIssue.id, companyId: sourceIssue.companyId, recoveryIssueId: recovery.id },
        "pruned liveness recovery blocker but could not restore source issue status; source left in the blocked_without_blockers trigger state",
      );
      const retried = await issuesSvc.update(sourceIssue.id, { blockedByIssueIds: nextBlockerIds });
      if (!retried) return PRUNE_NOT_APPLICABLE;
      restoreDegraded = true;
    }

    await logActivity(db, {
      companyId: sourceIssue.companyId,
      actorType: "system",
      actorId: "system",
      agentId: null,
      runId: null,
      action: "issue.liveness_recovery_blocker_pruned",
      entityType: "issue",
      entityId: sourceIssue.id,
      details: {
        source: "recovery.reconcile_issue_graph_liveness",
        recoveryIssueId: recovery.id,
        recoveryIdentifier: recovery.identifier,
        incidentKey: recovery.originId,
        previousStatus: sourceIssue.status,
        remainingUnresolvedBlockerCount: unresolvedAfterPrune.length,
        restoredSourceStatus,
        restoreSkippedReason,
      },
    });

    return { pruned: true, restoreDegraded };
  }

  async function hasActiveRunForIssueId(companyId: string, issueId: string) {
    const [contextRun, issueRun] = await Promise.all([
      db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.companyId, companyId),
            inArray(heartbeatRuns.status, [...EXECUTION_PATH_HEARTBEAT_RUN_STATUSES]),
            sql`(${heartbeatRuns.contextSnapshot}->>'issueId' = ${issueId}
              OR ${heartbeatRuns.contextSnapshot}->>'taskId' = ${issueId})`,
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null),
      db
        .select({ id: heartbeatRuns.id })
        .from(issues)
        .innerJoin(heartbeatRuns, eq(issues.executionRunId, heartbeatRuns.id))
        .where(
          and(
            eq(issues.companyId, companyId),
            eq(issues.id, issueId),
            inArray(heartbeatRuns.status, [...EXECUTION_PATH_HEARTBEAT_RUN_STATUSES]),
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null),
    ]);
    return Boolean(contextRun || issueRun);
  }

  /**
   * BLO-29601: close open liveness escalations whose originating invariant has stopped
   * holding, before anything spends an agent run adjudicating them.
   *
   * An escalation is minted from a premise ("BLO-x is in review with no action path")
   * and then never re-checked. When the premise clears — the blocker resolves, the
   * assignee wakes, a monitor re-arms — the row stays open and keeps demanding a run to
   * rediscover that there is nothing to do. `retireObsoleteLivenessRecoveryIssues`
   * cannot do this job: it reads the minting view, in which an open escalation
   * suppresses its own subject's finding, so every escalation looks obsolete there and
   * the only thing standing between the backlog and a mass close is its
   * still-wired-as-a-blocker guard.
   *
   * The re-check therefore runs against `escalationBlindFindings`, where escalation
   * -contributed waiting paths are removed and the invariant is evaluated against the
   * graph on its own terms. Premise still present in that set → leave the row alone.
   *
   * Two properties this must preserve, both load-bearing:
   *
   *  - Equality is on the full incident key (company, subject, invariant, leaf), not on
   *    the subject alone. A subject that has moved to a DIFFERENT invariant retires the
   *    old escalation; the mint path then raises the new one through its own suppressors
   *    rather than this pass silently re-scoping a live row.
   *  - The blocker edge comes off the source BEFORE the row is cancelled. Cancelling
   *    first would leave the source blocked behind a cancelled issue, which is itself a
   *    liveness violation (`blocked_by_cancelled_issue`) — trading one dead escalation
   *    for another.
   */
  async function autoResolveStaleLivenessEscalations(
    escalationBlindFindings: IssueLivenessFinding[],
    opts?: { runId?: string | null },
  ) {
    const livePremiseKeys = new Set(
      escalationBlindFindings.map((finding) => finding.incidentKey),
    );
    const openEscalations = await db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.originKind, RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation),
          visibleIssueCondition(),
          notInArray(issues.status, ["done", "cancelled"]),
        ),
      );

    const result = {
      checked: 0,
      autoResolved: 0,
      premiseStillTrueSkipped: 0,
      unparsableSkipped: 0,
      liveRunSkipped: 0,
      runsReleased: 0,
      blockerRelationsRemoved: 0,
      autoResolvedIssueIds: [] as string[],
    };

    // The set of escalations that survive the premise check, resolved in one pass so the
    // subject lookup below is a single query rather than one per row. Bounded by the
    // backlog size, but this sweep runs on every 30s tick and the backlog it exists to
    // drain is exactly when the row count is highest.
    const staleEscalations = openEscalations.flatMap((escalation) => {
      result.checked += 1;
      const parsed = parseLivenessIncidentKey(escalation.originId);
      // No parsable premise means nothing to re-check. Left for
      // `retireObsoleteLivenessRecoveryIssues`, which has its own disposal path.
      if (!parsed || !escalation.originId) {
        result.unparsableSkipped += 1;
        return [];
      }
      // AC3. The one branch that must not regress: a live incident stays open.
      if (livePremiseKeys.has(escalation.originId)) {
        result.premiseStillTrueSkipped += 1;
        return [];
      }
      return [{ escalation, parsed }];
    });

    const subjectIssueIds = [
      ...new Set(staleEscalations.map(({ parsed }) => parsed.issueId)),
    ];
    const subjectById = new Map(
      subjectIssueIds.length === 0
        ? []
        : (
            await db
              .select({
                id: issues.id,
                companyId: issues.companyId,
                identifier: issues.identifier,
                status: issues.status,
              })
              .from(issues)
              .where(inArray(issues.id, subjectIssueIds))
          ).map((row) => [row.id, row] as const),
    );

    // The cancel below takes the escalation's `blocks` edge off with it, inside the same
    // transaction (`issuesSvc.update` deletes it for this origin kind), so by the time the
    // residual `removeRecoveryBlockerFromSource` runs there is normally nothing left for it
    // to report. Read the wired edges NOW, batched alongside the subject rows above, so
    // `blockerRelationsRemoved` keeps counting what the sweep actually unwired instead of
    // silently reporting zero once the cancel moved ahead of it.
    const wiredBlockerEdgeKey = (escalationId: string, subjectId: string) =>
      `${escalationId}:${subjectId}`;
    const staleEscalationIds = staleEscalations.map(({ escalation }) => escalation.id);
    const wiredBlockerEdges = new Set(
      staleEscalationIds.length === 0
        ? []
        : (
            await db
              .select({
                issueId: issueRelations.issueId,
                relatedIssueId: issueRelations.relatedIssueId,
              })
              .from(issueRelations)
              .where(
                and(
                  inArray(issueRelations.issueId, staleEscalationIds),
                  eq(issueRelations.type, "blocks"),
                ),
              )
          ).map((row) => wiredBlockerEdgeKey(row.issueId, row.relatedIssueId)),
    );

    for (const { escalation, parsed } of staleEscalations) {
      // AC2, and the ordering matters. A dead escalation holding an execution lock
      // strands that run: the issue keeps pointing at it, and
      // `retireObsoleteLivenessRecoveryIssues` refuses to touch a row with an active run,
      // so the lock outlives the premise. Terminal status alone does NOT clear these
      // columns (`issuesSvc.update` leaves executionRunId untouched on done/cancelled),
      // so it has to be released explicitly.
      //
      // But release ONLY when every owner run is reapable, and do it BEFORE the comment
      // and the cancel. A run that is genuinely executing still owns this row: detaching
      // its lock and then cancelling the issue underneath it leaves a live worker writing
      // to a row it no longer holds. Such an escalation is left entirely alone — no
      // comment, no blocker edge removal, no cancel — and the next tick picks it up once
      // the run reaches a terminal status. Skipping is safe because the premise is
      // already false: nothing is lost by resolving it one tick later.
      //
      // Called unconditionally, deliberately NOT gated on the loaded row's lock columns.
      // Those come from `openEscalations`, an unlocked snapshot taken before this loop,
      // and every row processed here costs a comment insert plus two updates — so by the
      // time a late row is reached that snapshot can be well out of date. An agent that
      // checks the escalation out inside that window still reads as unlocked, would skip
      // this guard entirely, and get cancelled underneath its live run: the same defect
      // as releasing a live lock, reached through the snapshot instead of through the
      // predicate. This call re-reads both lock columns and their owner runs FOR UPDATE,
      // so the decision is made on current state. `no_lock` is the cheap answer when
      // there is genuinely no owner.
      //
      // This guard is necessary but NOT sufficient: it commits, so it cannot speak for the
      // window after it returns. The cancel below re-pins the same lock state as a write
      // precondition, which is what actually makes the decision safe.
      {
        const release = await issuesSvc.releaseExecutionLockIfOwnerReapable(escalation.id);
        if (release.outcome === "live_owner_run") {
          result.liveRunSkipped += 1;
          continue;
        }
        if (release.outcome === "released") result.runsReleased += 1;
      }

      // Company-scoped, matching the per-row query this replaced: an incident key names a
      // company, and a subject row from a different one is not this escalation's subject.
      const subject = subjectById.get(parsed.issueId) ?? null;
      const sourceIssue = subject && subject.companyId === parsed.companyId ? subject : null;

      // The cancel goes FIRST, and it is the atomic decision point for the whole row.
      //
      // The guard above closes over its own transaction and commits. That leaves a window
      // between it and this write in which an agent can legitimately check the escalation
      // out: the guard saw no owner, so it did not skip, and the row is now live. Doing the
      // comment and the blocker-edge removal before the cancel meant that window ended with
      // a live worker attached to an issue the sweep had already unwired from its subject
      // and cancelled underneath it — the same defect as force-releasing a live lock, just
      // reached one step later.
      //
      // `expectedCurrent{Checkout,Execution}RunId: null` pins the exact state the guard
      // left behind. Drizzle renders a null expectation as `IS NULL`, and `update` re-emits
      // both into the UPDATE's own WHERE, so under READ COMMITTED a checkout that lands in
      // the window is serialized against this statement and the predicate is re-evaluated
      // against its committed row: zero rows matched, `update` raises 409, and the row is
      // skipped whole — no comment, no edge removal, no cancel. The checkout's own UPDATE is
      // symmetrically a CAS on `status`, so the reverse interleaving fails on its side
      // instead. Either way exactly one of the two wins, and the loser touches nothing.
      //
      // Ordering the cancel ahead of the edge removal reverses the previous
      // edge-before-cancel decision, which existed to avoid leaving the subject blocked
      // behind a cancelled issue. That window is already self-healing: reconciliation drops
      // closed liveness escalations from blocker relations (covered by "removes closed
      // liveness escalations from blocker relations during reconciliation"). The reverse
      // order has no such repair path — an edge removed before a cancel that then loses the
      // CAS leaves a live escalation silently unwired from its subject, with nothing to put
      // it back. And for this origin kind the cancel deletes that edge in its own
      // transaction anyway, so the subject is never observably blocked behind a cancelled
      // row to begin with.
      try {
        await issuesSvc.update(escalation.id, {
          status: "cancelled",
          expectedCurrentCheckoutRunId: null,
          expectedCurrentExecutionRunId: null,
        });
      } catch (error) {
        if (!isExecutionLockPreconditionConflict(error)) throw error;
        // Checked out inside the window. Same disposition as the guard's `live_owner_run`:
        // the premise is already false, so nothing is lost by resolving it a tick later,
        // once that run reaches a terminal status.
        result.liveRunSkipped += 1;
        continue;
      }

      await issuesSvc.addComment(
        escalation.id,
        [
          `${STALE_LIVENESS_ESCALATION_AUTO_RESOLVE_MARKER} premise no longer holds — closing without an agent run.`,
          "",
          `- Invariant: \`${parsed.state}\``,
          `- Subject issue: ${sourceIssue?.identifier ?? parsed.issueId}${
            sourceIssue ? ` (now \`${sourceIssue.status}\`)` : " (no longer visible)"
          }`,
          `- Incident key: \`${escalation.originId}\``,
          "",
          sourceIssue
            ? `Re-evaluated against current state with open liveness escalations excluded as action paths, so this row could not vouch for itself: \`${parsed.state}\` no longer fires for ${sourceIssue.identifier ?? parsed.issueId}. Nothing here needs adjudicating.`
            : "The subject issue is no longer visible, so the invariant has nothing left to hold against.",
        ].join("\n"),
        { runId: opts?.runId ?? null },
      );

      // Residual path: covers the rows the cancel's own edge delete cannot reach — an
      // origin id the escalation-side parser rejects, or a subject in another company.
      // Counted exactly once per escalation: the cancel took the edge, or this did.
      const edgeRemovedByCancel =
        sourceIssue !== null && wiredBlockerEdges.has(wiredBlockerEdgeKey(escalation.id, sourceIssue.id));
      const edgeRemovedByResidual = await removeRecoveryBlockerFromSource(escalation);
      if (edgeRemovedByCancel || edgeRemovedByResidual) {
        result.blockerRelationsRemoved += 1;
      }

      result.autoResolved += 1;
      result.autoResolvedIssueIds.push(escalation.id);
    }

    return result;
  }

  async function retireObsoleteLivenessRecoveryIssues(
    findings: IssueLivenessFinding[],
    opts?: { now?: Date; abandonedAfterMs?: number },
  ) {
    const now = opts?.now ?? new Date();
    const abandonedAfterMs = Math.max(
      0,
      Math.floor(asNumber(opts?.abandonedAfterMs, DEFAULT_LIVENESS_ABANDONED_RECOVERY_MS)),
    );
    // 0 disables the bound rather than retiring everything: the
    // `abandonedAfterMs > 0` guard at the comparison site means a zero restores
    // the pre-BLO-28957 unbounded skip, which is the conservative reading of
    // "turned off".
    const abandonedCutoff = new Date(now.getTime() - abandonedAfterMs);
    const currentIncidentKeys = new Set(findings.map((finding) => finding.incidentKey));
    const currentLeafKeys = new Set(
      findings.map((finding) =>
        livenessRecoveryLeafKey(
          finding.companyId,
          finding.state,
          livenessRecoveryLeafIssueId(finding),
        ),
      ),
    );
    const openRecoveries = await db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.originKind, RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation),
          visibleIssueCondition(),
          notInArray(issues.status, ["done", "cancelled"]),
        ),
      );
    const result = {
      retired: 0,
      activeSkipped: 0,
      sourceStillOpenSkipped: 0,
      abandonedRetired: 0,
      blockerRelationsRemoved: 0,
      blockerPruneRestoreDegraded: 0,
      retiredIssueIds: [] as string[],
      abandonedRetiredIssueIds: [] as string[],
    };

    for (const recovery of openRecoveries) {
      if (recovery.originId && currentIncidentKeys.has(recovery.originId)) continue;
      const parsed = parseLivenessIncidentKey(recovery.originId);
      if (!parsed) continue;
      if (
        currentLeafKeys.has(
          livenessRecoveryLeafKey(parsed.companyId, parsed.state, parsed.leafIssueId),
        )
      ) {
        continue;
      }
      const sourceIssue = await db
        .select({
          id: issues.id,
          status: issues.status,
        })
        .from(issues)
        .where(and(eq(issues.companyId, parsed.companyId), eq(issues.id, parsed.issueId)))
        .then((rows) => rows[0] ?? null);
      // "Obsolete" here means "no finding in this sweep names this incident" --
      // but an OPEN recovery row suppresses its own finding via
      // `openRecoveryIssues`/`hasExplicitWaitingPath`, so every live row looks
      // obsolete on the very next sweep. What kept them alive was the guard
      // below reading "the source still carries our blocker edge", which was
      // true for essentially every row this loop reaches -- so the guard
      // reduced to "a live row whose source is still open is not retired".
      // BLO-28618 stopped writing that edge, so the intent is now tested
      // directly against the source's status. Without this the detector files a
      // row and cancels it one sweep later, which is worse than the wedge it
      // replaced.
      //
      // BLO-28957 closes that gap, and closes it HERE rather than by loosening
      // suppression, because the retire is the narrower lever: it needs no
      // change to `openRecoveryIssues`, so it cannot under-report a first-time
      // dead end. The skip is now bounded by the ROW's own activity -- a row
      // nobody has touched in `abandonedAfterMs` is abandoned and falls through
      // to the retire below.
      //
      // `lastActivityAt` is the clock, and it is the right one: migration 0076
      // mirrors every `updated_at` bump into it (BEFORE UPDATE trigger) and
      // bumps it on comment insert (AFTER INSERT on `issue_comments`), so any
      // real work on the row -- a status flip, an assignment change, or a human
      // merely commenting -- resets the bound. Nothing in this sweep writes to
      // the recovery row on a non-retiring pass, so the clock is not
      // self-resetting.
      //
      // Safe only because the cooldown now also holds recently-`cancelled`
      // rows. Retiring a row IS the re-file trigger, so on a `done`-only
      // cooldown this bound would have converted an unbounded wedge into an
      // unbounded re-file loop. The two halves are one change.
      const recoveryLastActivityAt = recovery.lastActivityAt ?? recovery.updatedAt;
      const abandoned = abandonedAfterMs > 0 && recoveryLastActivityAt <= abandonedCutoff;
      const sourceStillOpen = Boolean(
        sourceIssue && !["done", "cancelled"].includes(sourceIssue.status),
      );
      if (sourceStillOpen && !abandoned) {
        result.activeSkipped += 1;
        result.sourceStillOpenSkipped += 1;
        continue;
      }
      const prune = await removeRecoveryBlockerFromSource(recovery);
      if (prune.pruned) {
        result.blockerRelationsRemoved += 1;
      }
      if (prune.restoreDegraded) {
        result.blockerPruneRestoreDegraded += 1;
      }
      if (await hasActiveRunForIssueId(recovery.companyId, recovery.id)) {
        result.activeSkipped += 1;
        continue;
      }
      await issuesSvc.update(recovery.id, { status: "cancelled" });
      result.retired += 1;
      result.retiredIssueIds.push(recovery.id);
      if (abandoned && sourceStillOpen) {
        result.abandonedRetired += 1;
        result.abandonedRetiredIssueIds.push(recovery.id);
        await annotateAbandonedLivenessRecovery(recovery, parsed, recoveryLastActivityAt, now);
      }
    }

    return result;
  }

  /**
   * Record WHY a row was retired, on two surfaces that outlive the sweep.
   *
   * This is the answer to "which sources had a recovery row that suppressed them
   * and was never worked", without reading sweep logs:
   *
   *  - an activity row with action `issue.liveness_recovery_abandoned`, keyed to
   *    the SOURCE issue, carrying the incident key and the idle interval. This
   *    is the queryable surface -- issue search covers title and description
   *    only, so a comment alone would not be findable.
   *  - a comment on the retired row carrying
   *    `ABANDONED_LIVENESS_RECOVERY_MARKER`, so anyone who opens the row sees
   *    why it closed rather than an unexplained cancellation.
   *
   * Two ordering constraints, both load-bearing:
   *
   * 1. This runs strictly AFTER the cancel. Commenting bumps the row's
   *    `last_activity_at` (AFTER INSERT trigger on `issue_comments`, migration
   *    0076), so annotate-then-crash would reset the abandonment clock and buy
   *    the row another full bound of silent suppression -- reintroducing the
   *    exact defect this fixes. Cancel-then-crash loses only the annotation.
   * 2. The comment goes on the RECOVERY ROW, never on the source. The
   *    escalation staleness gate reads `lastActivityAt` on the finding's
   *    `recoveryIssue`, which is the leaf -- and the leaf IS the source in the
   *    self-referential dead-end shape. For those findings a "helpful" note on
   *    the source would push it back inside the staleness lookback and delay the
   *    very re-escalation this retire exists to unblock.
   *
   * Neither surface may fail the retirement: the cancel is the part that
   * restores the wake path, so annotation failures are logged and swallowed.
   */
  async function annotateAbandonedLivenessRecovery(
    recovery: typeof issues.$inferSelect,
    parsed: { companyId: string; issueId: string; leafIssueId: string; state: string },
    lastActivityAt: Date,
    now: Date,
  ) {
    const idleMs = Math.max(0, now.getTime() - lastActivityAt.getTime());
    const idleDays = Math.floor(idleMs / (24 * 60 * 60 * 1000));
    logger.warn(
      {
        recoveryIssueId: recovery.id,
        recoveryIdentifier: recovery.identifier,
        sourceIssueId: parsed.issueId,
        leafIssueId: parsed.leafIssueId,
        incidentKey: recovery.originId,
        lastActivityAt: lastActivityAt.toISOString(),
        idleMs,
      },
      "retired abandoned liveness recovery issue so its source can be re-escalated",
    );
    try {
      await logActivity(db, {
        companyId: recovery.companyId,
        actorType: "system",
        actorId: "system",
        agentId: null,
        runId: null,
        action: "issue.liveness_recovery_abandoned",
        entityType: "issue",
        entityId: parsed.issueId,
        details: {
          source: "recovery.reconcile_issue_graph_liveness",
          recoveryIssueId: recovery.id,
          recoveryIdentifier: recovery.identifier,
          incidentKey: recovery.originId,
          leafIssueId: parsed.leafIssueId,
          state: parsed.state,
          lastActivityAt: lastActivityAt.toISOString(),
          idleMs,
        },
      });
    } catch (error) {
      logger.warn(
        { err: error, recoveryIssueId: recovery.id },
        "failed to record abandoned liveness recovery activity; retirement itself still applied",
      );
    }
    try {
      await issuesSvc.addComment(
        recovery.id,
        [
          `<!-- ${ABANDONED_LIVENESS_RECOVERY_MARKER} -->`,
          `Retired automatically: this liveness recovery row saw no activity for ${idleDays}d ` +
            `(last activity ${lastActivityAt.toISOString()}).`,
          "",
          `- Source issue: \`${parsed.issueId}\``,
          `- Leaf issue: \`${parsed.leafIssueId}\``,
          `- Finding: \`${parsed.state}\``,
          `- Incident key: \`${recovery.originId ?? "unknown"}\``,
          "",
          "While open, this row suppressed liveness findings for both the source and the leaf, so " +
            "leaving it open indefinitely would have kept the source silently unreportable " +
            "(BLO-28957). Retiring it restores the source's wake path: the finding re-surfaces on " +
            "the next sweep and re-escalates to a fresh owner once the re-escalation cooldown " +
            "expires. Nothing is lost by this cancellation -- if the incident is still live, a " +
            "fresh row is filed.",
        ].join("\n"),
        { runId: null },
        { authorType: "system" },
      );
    } catch (error) {
      logger.warn(
        { err: error, recoveryIssueId: recovery.id },
        "failed to annotate abandoned liveness recovery issue; retirement itself still applied",
      );
    }
  }

  async function retireDoneLivenessRecoveryBlockers() {
    const closedRecoveries = await db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.originKind, RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation),
          visibleIssueCondition(),
          inArray(issues.status, ["done", "cancelled"]),
        ),
      );

    let blockerRelationsRemoved = 0;
    let blockerPruneRestoreDegraded = 0;
    for (const recovery of closedRecoveries) {
      const prune = await removeRecoveryBlockerFromSource(recovery);
      if (prune.pruned) {
        blockerRelationsRemoved += 1;
      }
      if (prune.restoreDegraded) {
        blockerPruneRestoreDegraded += 1;
      }
    }

    return { blockerRelationsRemoved, blockerPruneRestoreDegraded };
  }

  function normalizeIssueGraphLivenessAutoRecoveryLookbackHours(raw: unknown) {
    const numeric = Math.floor(asNumber(raw, DEFAULT_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS));
    return Math.min(
      MAX_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS,
      Math.max(MIN_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS, numeric),
    );
  }

  function livenessDependencyIssueKey(companyId: string, issueId: string) {
    return `${companyId}:${issueId}`;
  }

  /**
   * Load `lastActivityAt` for every recoveryIssue referenced by the
   * findings (and, defensively, every dependency hop). Used by the
   * staleness gate to decide which findings have been silently stuck
   * long enough to escalate.
   *
   * Pre-2026-05-06 RCA this loaded `updatedAt` for dependencyPath entries
   * only and the gate REQUIRED activity within the lookback window --
   * which silently quarantined any finding whose recoveryIssue wasn't
   * also a dependency, and any finding whose entire chain went quiet for
   * longer than 24h. We now key off the recoveryIssue itself, with
   * `lastActivityAt` (status flips, comments, assignment changes) as the
   * primary clock so that pure-metadata writes don't reset staleness.
   */
  async function loadLivenessRecoveryIssueLastActivityByKey(findings: IssueLivenessFinding[]) {
    const issueIds = [
      ...new Set(
        findings.flatMap((finding) => [
          finding.recoveryIssueId,
          ...finding.dependencyPath.map((entry) => entry.issueId),
        ]),
      ),
    ];
    if (issueIds.length === 0) return new Map<string, Date>();
    const rows = await db
      .select({
        id: issues.id,
        companyId: issues.companyId,
        lastActivityAt: issues.lastActivityAt,
        updatedAt: issues.updatedAt,
      })
      .from(issues)
      .where(inArray(issues.id, issueIds));
    return new Map(rows.map((row) => [
      livenessDependencyIssueKey(row.companyId, row.id),
      row.lastActivityAt ?? row.updatedAt,
    ]));
  }

  function recoveryIssueLastActivityForFinding(
    finding: IssueLivenessFinding,
    activityByIssueKey: Map<string, Date>,
  ) {
    const directKey = livenessDependencyIssueKey(finding.companyId, finding.recoveryIssueId);
    const directHit = activityByIssueKey.get(directKey);
    if (directHit) return directHit;
    // Fallback: walk dependency hops and take the OLDEST observed
    // activity. The gate logic below escalates when this is older than
    // the staleness threshold; using the oldest dep ensures we don't
    // refuse to escalate just because some dep upstream got touched
    // recently.
    const dependencyIssueIds = [...new Set(finding.dependencyPath.map((entry) => entry.issueId))];
    if (dependencyIssueIds.length === 0) return null;
    const timestamps = dependencyIssueIds
      .map((issueId) => activityByIssueKey.get(livenessDependencyIssueKey(finding.companyId, issueId)))
      .filter((timestamp): timestamp is Date => Boolean(timestamp));
    if (timestamps.length === 0) return null;
    return timestamps.reduce((oldest, current) => (current < oldest ? current : oldest), timestamps[0]!);
  }

  /**
   * Inverted from the original "is the finding's dependency activity
   * within the lookback window?" gate. The recoveryIssue must be STALE
   * for at least `staleThresholdMs` to qualify for auto-recovery --
   * recently-touched issues aren't yet stuck (operator may still be
   * acting on them), and the longer-since-touched the finding is, the
   * more it deserves escalation.
   */
  function isLivenessFindingStaleEnoughForEscalation(
    finding: IssueLivenessFinding,
    staleAt: Date,
    activityByIssueKey: Map<string, Date>,
  ) {
    const lastActivityAt = recoveryIssueLastActivityForFinding(finding, activityByIssueKey);
    // No activity record at all -> definitely stale (defensive: an issue
    // missing from the activity map is either deleted or pre-dates the
    // lastActivityAt column backfill; either way escalation is safe and
    // the finding-suppression elsewhere will dedupe duplicates).
    if (!lastActivityAt) return true;
    return lastActivityAt <= staleAt;
  }

  /**
   * The two re-escalation suppression windows, normalized once (BLO-27676
   * review). Read by BOTH the preview and the run: they are paired operator
   * endpoints, so a default that drifts between them makes the preview describe
   * a run nobody can trigger. Sharing the normalization is what keeps
   * `recoverableFindings` and `escalationsCreated` answerable from one rule.
   */
  function normalizeLivenessSuppressionWindows(opts?: {
    reescalationCooldownMs?: number;
    unchangedTargetSuppressionMs?: number;
  }) {
    return {
      reescalationCooldownMs: Math.max(
        0,
        Math.floor(
          asNumber(opts?.reescalationCooldownMs, DEFAULT_LIVENESS_REESCALATION_COOLDOWN_MS),
        ),
      ),
      unchangedTargetSuppressionMs: Math.max(
        0,
        Math.floor(
          asNumber(
            opts?.unchangedTargetSuppressionMs,
            DEFAULT_LIVENESS_UNCHANGED_TARGET_SUPPRESSION_MS,
          ),
        ),
      ),
    };
  }

  async function buildIssueGraphLivenessAutoRecoveryPreview(
    opts?: {
      lookbackHours?: number;
      now?: Date;
      // Same knobs the run takes, for the same reason: an operator who previews
      // with the documented rollback lever must see the run that lever produces.
      reescalationCooldownMs?: number;
      unchangedTargetSuppressionMs?: number;
    },
  ): Promise<IssueGraphLivenessAutoRecoveryPreview> {
    const now = opts?.now ?? new Date();
    const lookbackHours = normalizeIssueGraphLivenessAutoRecoveryLookbackHours(opts?.lookbackHours);
    const { reescalationCooldownMs, unchangedTargetSuppressionMs } =
      normalizeLivenessSuppressionWindows(opts);
    // `lookbackHours` is now a min-staleness threshold (post-2026-05-06
    // RCA gate inversion). A finding is escalation-eligible when its
    // recoveryIssue hasn't seen meaningful activity since this cutoff.
    const staleAt = new Date(now.getTime() - lookbackHours * 60 * 60 * 1000);
    const findings = await collectIssueGraphLivenessFindings();
    const activityByIssueKey = await loadLivenessRecoveryIssueLastActivityByKey(findings);
    const issueIds = [...new Set(findings.map((finding) => finding.recoveryIssueId))];
    const recoveryRows = issueIds.length > 0
      ? await db
        .select({ id: issues.id, identifier: issues.identifier, title: issues.title })
        .from(issues)
        .where(inArray(issues.id, issueIds))
      : [];
    const recoveryById = new Map(recoveryRows.map((row) => [row.id, row]));
    const items: IssueGraphLivenessAutoRecoveryPreviewItem[] = [];
    let skippedNotYetStale = 0;
    let skippedReescalationCooldown = 0;
    let skippedUnchangedTarget = 0;

    for (const finding of findings) {
      const lastActivityAt = recoveryIssueLastActivityForFinding(finding, activityByIssueKey);
      if (!isLivenessFindingStaleEnoughForEscalation(finding, staleAt, activityByIssueKey)) {
        skippedNotYetStale += 1;
        continue;
      }
      // Apply the same re-escalation suppressors the run applies (BLO-27676
      // review). Without this the preview counts every stale finding while the
      // run creates only the unsuppressed ones, and the operator surface states
      // the difference as a promise -- the confirm dialog's button is literally
      // labelled "Enable and create {recoverableFindings}"
      // (`ui/src/pages/InstanceExperimentalSettings.tsx`). The divergence
      // pre-dates BLO-27676 but its magnitude did not: the cooldown alone could
      // only over-report on findings resolved within the last hour, whereas the
      // target-state gate spans 7d and selects exactly the population an
      // operator previews -- leaves already reported once and since quiet. The
      // steady state was a preview listing n and a run creating zero.
      //
      // Cost is one indexed `select` per stale finding, plus a leaf read only
      // for findings that reach the target-state branch -- the same per-finding
      // cost the run already pays, on a read-only operator-triggered endpoint.
      // Note this calls the suppressor DIRECTLY rather than going through
      // `createIssueGraphLivenessEscalation`, which is also what keeps the
      // preview out of the audit log (BLO-29761 AC5): the
      // `issue.harness_liveness_escalation_suppressed` write lives in that
      // function, not in the suppressor, so a preview reproduces the run's
      // decisions without writing a row that would make a read-only operator
      // preview indistinguishable from an actual run. Pinned by "does not write
      // suppression activity rows from the operator preview". Keep the write on
      // the creation path if these two are ever unified.
      const suppressed = await findSuppressingResolvedLivenessRecoveryIssue(
        finding,
        now,
        reescalationCooldownMs,
        unchangedTargetSuppressionMs,
      );
      if (suppressed) {
        skippedReescalationCooldown += 1;
        if (suppressed.reason === "unchanged_target") skippedUnchangedTarget += 1;
        continue;
      }
      const recoveryIssue = recoveryById.get(finding.recoveryIssueId);
      items.push({
        issueId: finding.issueId,
        identifier: finding.identifier,
        title: finding.dependencyPath[0]?.title ?? finding.identifier ?? finding.issueId,
        state: finding.state,
        severity: finding.severity,
        reason: finding.reason,
        recoveryIssueId: finding.recoveryIssueId,
        recoveryIdentifier: recoveryIssue?.identifier ?? null,
        recoveryTitle: recoveryIssue?.title ?? null,
        recommendedOwnerAgentId: finding.recommendedOwnerAgentId,
        incidentKey: finding.incidentKey,
        latestDependencyUpdatedAt: lastActivityAt?.toISOString() ?? null,
        dependencyPath: finding.dependencyPath,
      });
    }

    return {
      lookbackHours,
      cutoff: staleAt.toISOString(),
      generatedAt: now.toISOString(),
      findings: findings.length,
      recoverableFindings: items.length,
      skippedOutsideLookback: skippedNotYetStale,
      // Named to match the run's counters so the two responses compare
      // field-for-field.
      //
      // Residual divergence, deliberately not modelled here. This list is
      // complete as of this head rather than illustrative -- it is what a reader
      // deciding "is this preview/run gap known or new?" will trust, so it
      // enumerates every exit in `createIssueGraphLivenessEscalation` that
      // CREATES NO ROW and that the preview does not reproduce. Selected by
      // outcome rather than by position, because a reader checking that question
      // cares whether a row appeared, not whether the exit happened before or
      // after the INSERT was attempted:
      //
      //   1. source issue vanished, or crossed companies since collection
      //   2. automatic recovery suppressed by a pause hold
      //   3. recovery issue vanished since collection
      //   4. an OPEN escalation already exists (returns `existing`)
      //   5. no resolvable owner agent
      //   6. a concurrent run won the unique-violation race: the INSERT throws,
      //      the conflict resolves to the racing row, and it returns `existing`
      //      (the `catch` on `isUniqueLivenessRecoveryConflict` below). This is
      //      (4) reached one step later, and is the reason the list is scoped by
      //      outcome -- under a "pre-creation exits" scope it would be excluded
      //      on a technicality while still producing the divergence the note
      //      exists to account for.
      //
      // All six are pre-existing and unchanged in magnitude by BLO-27676,
      // unlike the two suppressors above -- which is why they are recorded here
      // rather than replicated. (4) and (6) are additionally rare by
      // construction: an open escalation contributes a waiting path for its own
      // leaf, so the finding is usually not collected at all.
      //
      // One attribution nuance, not a count difference: when a finding has BOTH
      // an open escalation and a resolved `done` one, the run books it to
      // `existingEscalations` (its `existing` check at the `findOpenLiveness*`
      // call above precedes its suppressor call) while the preview books it to
      // `skippedReescalationCooldown`. Neither creates a row, so
      // `recoverableFindings == escalationsCreated` still holds.
      skippedReescalationCooldown,
      skippedUnchangedTarget,
      // Echo the resolved windows so the operator surface can state the bounds
      // rather than hardcoding them. Both suppressors expire, and a dialog that
      // says "will not be re-raised" unqualified asserts the unbounded
      // behaviour the ceiling was added to remove -- the same
      // surface-promises-what-the-run-won't-do defect this PR round exists to
      // close (BLO-27676 review). These are the values this preview used, so
      // the string stays true under a tuned constant or an overridden knob.
      reescalationCooldownMs,
      unchangedTargetSuppressionMs,
      items,
    };
  }

  async function resolveEscalationOwnerAgentId(
    finding: IssueLivenessFinding,
    issue: typeof issues.$inferSelect,
  ) {
    const detailedCandidates = finding.recommendedOwnerCandidates.length > 0
      ? finding.recommendedOwnerCandidates
      : finding.recommendedOwnerCandidateAgentIds.map((agentId) => ({
        agentId,
        reason: "ordered_invokable_fallback" as const,
        sourceIssueId: finding.recoveryIssueId,
      }));
    const seenCandidates = new Set<string>();
    const candidates = detailedCandidates.filter((candidate) => {
      if (seenCandidates.has(candidate.agentId)) return false;
      seenCandidates.add(candidate.agentId);
      return true;
    });
    const budgetBlockedCandidateAgentIds: string[] = [];

    for (const candidate of candidates) {
      const budgetBlock = await budgets.getInvocationBlock(issue.companyId, candidate.agentId, {
        issueId: issue.id,
        projectId: issue.projectId,
      });
      if (!budgetBlock) {
        return {
          agentId: candidate.agentId,
          reason: candidate.reason,
          sourceIssueId: candidate.sourceIssueId,
          candidateAgentIds: candidates.map((entry) => entry.agentId),
          candidateReasons: candidates.map((entry) => ({
            agentId: entry.agentId,
            reason: entry.reason,
            sourceIssueId: entry.sourceIssueId,
          })),
          budgetBlockedCandidateAgentIds,
        };
      }
      budgetBlockedCandidateAgentIds.push(candidate.agentId);
    }

    return null;
  }

  function shouldReuseRecoveryExecutionWorkspace(input: {
    finding: IssueLivenessFinding;
    recoveryIssue: typeof issues.$inferSelect;
    ownerAgentId: string;
  }) {
    if (input.finding.recoveryIssueId === input.finding.issueId) return false;
    return input.recoveryIssue.assigneeAgentId === input.ownerAgentId;
  }

  /**
   * Persists the decision NOT to file a liveness escalation (BLO-29761).
   *
   * The filing path writes `issue.harness_liveness_escalation_created`; the
   * suppression path used to write nothing at all, so an operator could not
   * tell "suppressed by history" from "never detected", and suppression
   * effectiveness could only be inferred by parsing row titles -- the exact
   * method that produced this issue's own false 470/496 census.
   *
   * ## Why this is deduped rather than written per evaluation
   *
   * A suppressed finding is not evaluated once. Nothing about it changes, so
   * the detector re-collects it and the suppressor re-suppresses it on EVERY
   * sweep, and the sweep is the heartbeat scheduler tick --
   * `config.heartbeatSchedulerIntervalMs`, default 30s (`server/src/config.ts`).
   * That is 2,880 evaluations per incident per day, held for up to the 7d
   * `unchanged_target` ceiling: ~20k rows for ONE incident, times the ~400
   * resolved escalations currently inside that window, on both `paperclip-api`
   * replicas. Logging per evaluation would add ~1M activity rows/day and make
   * the log it exists to clarify unreadable.
   *
   * So the unit of record is the DECISION, not the evaluation:
   * `(incidentKey, reason, suppressedByIssueId)`. That triple is
   * once-per-lifetime by construction rather than merely coarse --
   * `resolvedAtMs` only recedes and leaf activity only advances, so once a
   * given prior row stops suppressing under a given reason it cannot resume
   * under that same pair. A `cooldown` -> `unchanged_target` handover, a
   * different prior row, or a re-file after the ceiling each produce a new
   * triple and so a new row. Nothing countable is lost; the per-sweep
   * evaluation count remains available as the run's `skippedReescalationCooldown`
   * / `skippedUnchangedTarget` counters.
   *
   * Dedupe reads `activity_log` rather than an in-process cache deliberately:
   * an in-memory Set would double-write on every sweep from the second API
   * replica and re-write the whole working set after each deploy, neither of
   * which a shared table does. The lookup is served by
   * `activity_log_entity_type_id_idx` on `(entity_type, entity_id)` and scans
   * only one issue's activity, which is a rounding error next to the two issue
   * reads the suppressor itself already pays per finding.
   *
   * This is check-then-insert, not an upsert, so two replicas that evaluate the
   * same finding inside the same instant can both miss and both write. That is
   * a bounded, one-off duplicate on a first-observation edge rather than the
   * per-sweep duplication an in-memory cache would produce, and the row carries
   * `suppressionKey` so a counting query can `count(distinct ...)` past it. A
   * unique index would close it outright, but not for free: `activity_log` is
   * an append-only audit table with no unique constraint anywhere in its
   * schema, and adding a partial one for a best-effort observability row would
   * let a duplicate key abort a write path that must never affect the sweep.
   *
   * This is best-effort observability. It must never be able to change a
   * suppression decision or fail a sweep, so the caller ignores its result and
   * it swallows its own errors.
   */
  async function logLivenessSuppressionDecision(input: {
    finding: IssueLivenessFinding;
    sourceIssue: typeof issues.$inferSelect;
    runId?: string | null;
    reason: LivenessSuppressionReason;
    suppressedBy: { id: string; identifier: string | null; status: string };
    resolvedAtMs?: number | null;
  }) {
    try {
      const suppressionKey = [input.finding.incidentKey, input.reason, input.suppressedBy.id].join("|");
      const already = await db
        .select({ id: activityLog.id })
        .from(activityLog)
        .where(
          and(
            eq(activityLog.companyId, input.sourceIssue.companyId),
            eq(activityLog.entityType, "issue"),
            eq(activityLog.entityId, input.sourceIssue.id),
            eq(activityLog.action, "issue.harness_liveness_escalation_suppressed"),
            sql`${activityLog.details}->>'suppressionKey' = ${suppressionKey}`,
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (already) return;

      await logActivity(db, {
        companyId: input.sourceIssue.companyId,
        actorType: "system",
        actorId: "system",
        agentId: null,
        runId: input.runId ?? null,
        action: "issue.harness_liveness_escalation_suppressed",
        entityType: "issue",
        entityId: input.sourceIssue.id,
        details: {
          source: "recovery.reconcile_issue_graph_liveness",
          // Stable dedupe identity for the read above. Also the natural GROUP BY
          // for "count suppressions in a period" without touching row titles.
          suppressionKey,
          incidentKey: input.finding.incidentKey,
          // `existing_open` = an OPEN row already owns this incident.
          // `cooldown` / `unchanged_target` = a RESOLVED row suppressed it.
          // One action with a reason discriminator, rather than two actions, so
          // a period count is one filter and the split is one GROUP BY.
          reason: input.reason,
          suppressedByIssueId: input.suppressedBy.id,
          suppressedByIdentifier: input.suppressedBy.identifier,
          // Required by BLO-29761's amended AC: once BLO-29838 lets `cancelled`
          // rows suppress, this is the only field that distinguishes a
          // suppression sourced from a cancel from one sourced from a close.
          suppressedByStatus: input.suppressedBy.status,
          suppressedByResolvedAt:
            input.resolvedAtMs != null ? new Date(input.resolvedAtMs).toISOString() : null,
          findingState: input.finding.state,
          leafIssueId: livenessRecoveryLeafIssueId(input.finding),
          sourceIssueId: input.sourceIssue.id,
          sourceIdentifier: input.sourceIssue.identifier,
          recoveryIssueId: input.finding.recoveryIssueId,
        },
      });
    } catch (err) {
      // Observability must not be able to break the sweep it observes.
      logger.warn(
        { err, incidentKey: input.finding.incidentKey, reason: input.reason },
        "failed to log liveness escalation suppression decision",
      );
    }
  }

  /**
   * Files the "Unblock liveness incident for X" row for a finding.
   *
   * Deliberately does NOT add the escalation to the source's blocker set, and
   * does NOT flip the source to `blocked` (BLO-28618). Doing either wedged the
   * very issue the escalation was meant to rescue: the source acquired a
   * fabricated dependency nobody would ever work, so it could not resolve even
   * once its real gate cleared -- and when the escalation was later closed or
   * cancelled the source dropped back into a detector-triggering state, which
   * made the sweep self-sustaining (240 of 500 sampled rows were re-files).
   *
   * Suppression does not need the edge. `openRecoveryIssues` is derived from
   * `originKind` + the parsed incident key, so an open escalation already
   * satisfies `hasExplicitWaitingPath` for both the source and the leaf. The
   * source learns about the escalation through the comment below instead.
   */
  async function createIssueGraphLivenessEscalation(input: {
    finding: IssueLivenessFinding;
    runId?: string | null;
    now: Date;
    reescalationCooldownMs: number;
    unchangedTargetSuppressionMs: number;
  }) {
    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, input.finding.issueId))
      .then((rows) => rows[0] ?? null);
    if (!issue || issue.companyId !== input.finding.companyId) return { kind: "skipped" as const };
    if (await isAutomaticRecoverySuppressedByPauseHold(db, issue.companyId, issue.id, treeControlSvc)) {
      return { kind: "skipped" as const };
    }

    const recoveryIssue = await db
      .select()
      .from(issues)
      .where(and(eq(issues.id, input.finding.recoveryIssueId), eq(issues.companyId, issue.companyId)))
      .then((rows) => rows[0] ?? null);
    if (!recoveryIssue) return { kind: "skipped" as const };

    const existing =
      await findOpenLivenessEscalation(issue.companyId, input.finding.incidentKey) ??
      await findOpenLivenessRecoveryIssueForLeaf(input.finding);
    if (existing) {
      await logLivenessSuppressionDecision({
        finding: input.finding,
        sourceIssue: issue,
        runId: input.runId,
        reason: "existing_open",
        suppressedBy: { id: existing.id, identifier: existing.identifier, status: existing.status },
      });
      return { kind: "existing" as const, escalationIssueId: existing.id };
    }
    const suppressed = await findSuppressingResolvedLivenessRecoveryIssue(
      input.finding,
      input.now,
      input.reescalationCooldownMs,
      input.unchangedTargetSuppressionMs,
    );
    if (suppressed) {
      await logLivenessSuppressionDecision({
        finding: input.finding,
        sourceIssue: issue,
        runId: input.runId,
        reason: suppressed.reason,
        suppressedBy: {
          id: suppressed.id,
          identifier: suppressed.identifier,
          status: suppressed.status,
        },
        resolvedAtMs: suppressed.resolvedAtMs,
      });
      return { kind: "suppressed" as const, reason: suppressed.reason };
    }

    const ownerSelection = await resolveEscalationOwnerAgentId(input.finding, recoveryIssue);
    if (!ownerSelection) return { kind: "skipped" as const };
    const reuseRecoveryExecutionWorkspace = shouldReuseRecoveryExecutionWorkspace({
      finding: input.finding,
      recoveryIssue,
      ownerAgentId: ownerSelection.agentId,
    });

    let escalation: Awaited<ReturnType<typeof issuesSvc.create>>;
    try {
      escalation = await issuesSvc.create(issue.companyId, {
        title: `Unblock liveness incident for ${issue.identifier ?? issue.id}`,
        description: buildLivenessEscalationDescription(input.finding),
        status: "todo",
        priority: "high",
        parentId: recoveryIssue.id,
        projectId: recoveryIssue.projectId,
        goalId: recoveryIssue.goalId,
        assigneeAgentId: ownerSelection.agentId,
        assigneeAdapterOverrides: recoveryAssigneeAdapterOverrides("status_only"),
        originKind: RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation,
        originId: input.finding.incidentKey,
        originFingerprint: livenessRecoveryLeafFingerprint(input.finding),
        billingCode: recoveryIssue.billingCode,
        ...(reuseRecoveryExecutionWorkspace
          ? { inheritExecutionWorkspaceFromIssueId: recoveryIssue.id }
          : {
            executionWorkspaceId: null,
            executionWorkspacePreference: null,
            executionWorkspaceSettings: null,
          }),
      });
    } catch (error) {
      if (!isUniqueLivenessRecoveryConflict(error)) throw error;
      const raced =
        await findOpenLivenessEscalation(issue.companyId, input.finding.incidentKey) ??
        await findOpenLivenessRecoveryIssueForLeaf(input.finding);
      if (!raced) throw error;
      // Same suppression shape as the pre-insert `existing` branch above: a
      // concurrent sweep won the unique index, so this finding produced no row.
      // The winner logs `created`; this side logs why it stood down.
      await logLivenessSuppressionDecision({
        finding: input.finding,
        sourceIssue: issue,
        runId: input.runId,
        reason: "existing_open",
        suppressedBy: { id: raced.id, identifier: raced.identifier, status: raced.status },
      });
      return { kind: "existing" as const, escalationIssueId: raced.id };
    }

    await issuesSvc.addComment(
      issue.id,
      buildLivenessOriginalIssueComment(input.finding, escalation),
      { runId: input.runId ?? null },
    );

    await logActivity(db, {
      companyId: issue.companyId,
      actorType: "system",
      actorId: "system",
      agentId: ownerSelection.agentId,
      runId: input.runId ?? null,
      action: "issue.harness_liveness_escalation_created",
      entityType: "issue",
      entityId: escalation.id,
      details: {
        source: "recovery.reconcile_issue_graph_liveness",
        incidentKey: input.finding.incidentKey,
        findingState: input.finding.state,
        sourceIssueId: issue.id,
        sourceIdentifier: issue.identifier,
        recoveryIssueId: recoveryIssue.id,
        recoveryIdentifier: recoveryIssue.identifier,
        escalationIssueId: escalation.id,
        escalationIdentifier: escalation.identifier,
        dependencyPath: input.finding.dependencyPath,
        ownerSelection: {
          selectedAgentId: ownerSelection.agentId,
          selectedReason: ownerSelection.reason,
          selectedSourceIssueId: ownerSelection.sourceIssueId,
          candidateAgentIds: ownerSelection.candidateAgentIds,
          candidateReasons: ownerSelection.candidateReasons,
          budgetBlockedCandidateAgentIds: ownerSelection.budgetBlockedCandidateAgentIds,
        },
        workspaceSelection: {
          reuseRecoveryExecutionWorkspace,
          inheritedExecutionWorkspaceFromIssueId: reuseRecoveryExecutionWorkspace ? recoveryIssue.id : null,
          projectWorkspaceSourceIssueId: recoveryIssue.id,
        },
      },
    });

    const wake = await deps.enqueueWakeup(ownerSelection.agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: withRecoveryModelProfileHint({
        issueId: escalation.id,
        sourceIssueId: issue.id,
        recoveryIssueId: recoveryIssue.id,
        incidentKey: input.finding.incidentKey,
      }, "status_only"),
      requestedByActorType: "system",
      requestedByActorId: null,
      contextSnapshot: withRecoveryModelProfileHint({
        issueId: escalation.id,
        taskId: escalation.id,
        wakeReason: "issue_assigned",
        source: RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation,
        sourceIssueId: issue.id,
        recoveryIssueId: recoveryIssue.id,
        incidentKey: input.finding.incidentKey,
      }, "status_only"),
    });

    logger.warn({
      incidentKey: input.finding.incidentKey,
      findingState: input.finding.state,
      sourceIssueId: issue.id,
      recoveryIssueId: recoveryIssue.id,
      escalationIssueId: escalation.id,
      ownerAgentId: ownerSelection.agentId,
      ownerSelectionReason: ownerSelection.reason,
      wakeupRunId: wake?.id ?? null,
    }, "created issue graph liveness escalation");

    return { kind: "created" as const, escalationIssueId: escalation.id };
  }

  async function reconcileResolvedDependencyWakeBackstopImpl(opts?: ResolvedDependencyWakeBackstopOptions) {
    const result = {
      checked: 0,
      healed: 0,
      existingWakeSkipped: 0,
      livePathSkipped: 0,
      interactionSkipped: 0,
      pauseHoldSkipped: 0,
      notReadySkipped: 0,
      candidateLimitSkipped: 0,
      deferredOrFailed: 0,
      enqueueFailed: 0,
      issueIds: [] as string[],
    };

    const source = opts?.source ?? "issue_graph_liveness.backstop";
    const requestedByActorId = source === "workspace.finalize"
      ? "heartbeat_finalize"
      : "issue_graph_liveness_backstop";
    const payloadBackstop = source === "workspace.finalize"
      ? "workspace_finalize_reconciliation"
      : "issue_graph_liveness_reconciliation";
    const useCursor = !opts?.blockerIssueId;

    const queryCandidates = (afterIssueId: string | null) => {
      const filters = [
        eq(issues.status, "blocked"),
        visibleIssueCondition(),
        sql`${issues.assigneeAgentId} is not null`,
      ];
      if (opts?.companyId) filters.push(eq(issues.companyId, opts.companyId));
      if (afterIssueId) filters.push(gt(issues.id, afterIssueId));

      if (opts?.blockerIssueId) {
        filters.push(
          eq(issueRelations.companyId, issues.companyId),
          eq(issueRelations.type, "blocks"),
          eq(issueRelations.issueId, opts.blockerIssueId),
          eq(issueRelations.relatedIssueId, issues.id),
        );
        return db
          .select({
            id: issues.id,
            companyId: issues.companyId,
            identifier: issues.identifier,
            assigneeAgentId: issues.assigneeAgentId,
            totalCount: sql<number>`count(*) over()::int`,
          })
          .from(issueRelations)
          .innerJoin(issues, eq(issueRelations.relatedIssueId, issues.id))
          .where(and(...filters))
          .orderBy(asc(issues.id))
          .limit(RESOLVED_DEPENDENCY_WAKE_BACKSTOP_CANDIDATE_LIMIT);
      }

      return db
        .select({
          id: issues.id,
          companyId: issues.companyId,
          identifier: issues.identifier,
          assigneeAgentId: issues.assigneeAgentId,
          totalCount: sql<number>`count(*) over()::int`,
        })
        .from(issues)
        .where(and(...filters))
        .orderBy(asc(issues.id))
        .limit(RESOLVED_DEPENDENCY_WAKE_BACKSTOP_CANDIDATE_LIMIT);
    };

    let candidateRows = await queryCandidates(useCursor ? resolvedDependencyWakeBackstopCandidateCursor : null);
    if (useCursor && candidateRows.length === 0 && resolvedDependencyWakeBackstopCandidateCursor) {
      resolvedDependencyWakeBackstopCandidateCursor = null;
      candidateRows = await queryCandidates(null);
    }
    const totalCandidateCount = candidateRows[0]?.totalCount ?? 0;
    const candidates = candidateRows.map(({ totalCount: _totalCount, ...candidate }) => candidate);
    result.checked = candidates.length;
    result.candidateLimitSkipped = Math.max(0, totalCandidateCount - candidates.length);
    if (source !== "workspace.finalize") {
      setBackstopDeferredCandidates("issue_graph_liveness.backstop", result.candidateLimitSkipped);
    }
    const lastCandidate = candidates[candidates.length - 1] ?? null;
    if (useCursor) {
      resolvedDependencyWakeBackstopCandidateCursor =
        result.candidateLimitSkipped > 0 && lastCandidate ? lastCandidate.id : null;
    }
    if (result.candidateLimitSkipped > 0) {
      logger.warn(
        {
          processed: candidates.length,
          skipped: result.candidateLimitSkipped,
          limit: RESOLVED_DEPENDENCY_WAKE_BACKSTOP_CANDIDATE_LIMIT,
          nextCursor: useCursor ? resolvedDependencyWakeBackstopCandidateCursor : null,
          source,
          blockerIssueId: opts?.blockerIssueId ?? null,
        },
        "issue graph liveness backstop deferred resolved dependency wake candidates past page limit",
      );
    }

    const candidatesByCompany = new Map<string, typeof candidates>();
    for (const candidate of candidates) {
      const companyCandidates = candidatesByCompany.get(candidate.companyId) ?? [];
      companyCandidates.push(candidate);
      candidatesByCompany.set(candidate.companyId, companyCandidates);
    }

    for (const [companyId, companyCandidates] of candidatesByCompany.entries()) {
      const readinessMap = await issuesSvc.listDependencyReadiness(
        companyId,
        companyCandidates.map((candidate) => candidate.id),
      );

      for (const candidate of companyCandidates) {
        const agentId = candidate.assigneeAgentId;
        if (!agentId) continue;

        const readiness = readinessMap.get(candidate.id);
        const resolvedBlockerIssueId = readiness?.blockerIssueIds[0] ?? null;
        if (
          !readiness ||
          !readiness.isDependencyReady ||
          readiness.blockerIssueIds.length === 0 ||
          !resolvedBlockerIssueId
        ) {
          result.notReadySkipped += 1;
          continue;
        }

        const idempotencyKeys = readiness.blockerIssueIds.map((blockerIssueId) =>
          buildIssueBlockersResolvedWakeIdempotencyKey({
            dependentIssueId: candidate.id,
            resolvedBlockerIssueId: blockerIssueId,
          })
        );
        const idempotencyKey = buildIssueBlockersResolvedWakeIdempotencyKey({
          dependentIssueId: candidate.id,
          resolvedBlockerIssueId,
        });
        const existingWake = await findExistingIssueBlockersResolvedWakeForAnyKey(db, {
          companyId,
          idempotencyKeys,
        });
        if (existingWake) {
          result.existingWakeSkipped += 1;
          continue;
        }

        if (
          await hasActiveExecutionPath(companyId, candidate.id, agentId) ||
          await hasQueuedIssueWake(companyId, candidate.id, agentId)
        ) {
          result.livePathSkipped += 1;
          continue;
        }

        if (await hasPendingWakeInteraction(companyId, candidate.id)) {
          result.interactionSkipped += 1;
          continue;
        }

        if (await isAutomaticRecoverySuppressedByPauseHold(db, companyId, candidate.id, treeControlSvc)) {
          result.pauseHoldSkipped += 1;
          continue;
        }

        try {
          const wake = await deps.enqueueWakeup(agentId, {
            source: "automation",
            triggerDetail: "system",
            reason: ISSUE_BLOCKERS_RESOLVED_WAKE_REASON,
            payload: {
              issueId: candidate.id,
              resolvedBlockerIssueId,
              blockerIssueIds: readiness.blockerIssueIds,
              backstop: payloadBackstop,
            },
            idempotencyKey,
            requestedByActorType: "system",
            requestedByActorId,
            contextSnapshot: {
              issueId: candidate.id,
              taskId: candidate.id,
              wakeReason: ISSUE_BLOCKERS_RESOLVED_WAKE_REASON,
              source,
              resolvedBlockerIssueId,
              blockerIssueIds: readiness.blockerIssueIds,
            },
          });
          if (!wake) {
            // enqueueWakeup returns null for normal deferred/skipped paths
            // such as disabled wake-on-demand or concurrency gating. That is
            // not an enqueue error, but the backstop still did not heal now.
            result.deferredOrFailed += 1;
            continue;
          }

          result.healed += 1;
          result.issueIds.push(candidate.id);

          await logActivity(db, {
            companyId,
            actorType: "system",
            actorId: "issue_graph_liveness_backstop",
            agentId,
            runId: opts?.runId ?? null,
            action: "issue.blockers_resolved_wake_emitted",
            entityType: "issue",
            entityId: candidate.id,
            details: {
              source,
              wakeupRunId: wake.id,
              idempotencyKey,
              resolvedBlockerIssueId,
              blockerIssueIds: readiness.blockerIssueIds,
            },
          });
        } catch (err) {
          result.deferredOrFailed += 1;
          result.enqueueFailed += 1;
          logger.warn(
            { err, issueId: candidate.id, agentId, idempotencyKey, source },
            "failed to enqueue dependency wake from issue graph liveness backstop",
          );
        }
      }
    }

    if (source !== "workspace.finalize") {
      for (const [reason, count] of [
        ["not_ready", result.notReadySkipped], ["existing_wake", result.existingWakeSkipped],
        ["live_path", result.livePathSkipped], ["pause_hold", result.pauseHoldSkipped],
        ["interaction", result.interactionSkipped],
        // These reasons are mutually exclusive: enqueue errors also increment
        // deferredOrFailed for the aggregate result returned to existing callers.
        ["deferred_or_failed", result.deferredOrFailed - result.enqueueFailed],
        ["enqueue_failed", result.enqueueFailed],
      ] as const) {
        for (let i = 0; i < count; i++) recordBackstopCandidateSkipped("issue_graph_liveness.backstop", reason);
      }
      if (result.candidateLimitSkipped === 0) recordBackstopSweepCompleted("issue_graph_liveness.backstop");
    }

    if (result.healed > 0) {
      logger.warn(
        { healed: result.healed, issueIds: result.issueIds, source, blockerIssueId: opts?.blockerIssueId ?? null },
        "issue graph liveness backstop healed resolved blocked dependency wakes",
      );
    }

    return result;
  }

  /**
   * BLO-24662: move recovery actions that have burned their wake horizon out of `active`.
   *
   * `strandedRecoveryWakeAttemptsExhausted` already makes every sweep skip these, and
   * `escalateStrandedAssignedIssue` posts a one-time "horizon reached" notice — but only
   * on a pass that re-escalates the same issue. Once an issue stops being a candidate for
   * that sweep, nothing runs again and the row keeps reporting `status: "active"` forever:
   * a recovery that spent its entire window without a single attempt, indistinguishable
   * from one that is working. BLO-20995 sat that way at `attemptCount: 0 / 5` for 13h.
   *
   * This is the missing unconditional pass. It is independent of liveness findings and of
   * the source issue's status, and — like the wake backstop beside it — stays enabled when
   * automatic liveness escalation is off, because it re-routes an already-committed action
   * rather than creating recovery work.
   */
  async function reconcileExpiredRecoveryWakeHorizons(opts?: {
    runId?: string | null;
    companyId?: string | null;
    now?: Date;
    limit?: number;
  }) {
    const result = { checked: 0, escalated: 0, announced: 0, actionIds: [] as string[], issueIds: [] as string[] };
    const now = opts?.now ?? new Date();

    const expired = await recoveryActionsSvc.escalateExpiredWakeHorizons({
      now,
      companyId: opts?.companyId ?? null,
      limit: opts?.limit,
    });
    result.checked = expired.length;
    if (expired.length === 0) return result;

    for (const action of expired) {
      result.escalated += 1;
      result.actionIds.push(action.id);
      result.issueIds.push(action.sourceIssueId);

      logger.warn(
        {
          actionId: action.id,
          companyId: action.companyId,
          sourceIssueId: action.sourceIssueId,
          cause: action.cause,
          ownerAgentId: action.ownerAgentId,
          attemptCount: action.attemptCount,
          maxAttempts: action.maxAttempts,
          timeoutAt: action.timeoutAt,
          runId: opts?.runId ?? null,
        },
        "recovery action passed its wake horizon and was escalated out of active",
      );

      // Same marker text and the same exact-match dedup as the notice in
      // `escalateStrandedAssignedIssue`, so whichever path gets there first wins and the
      // other stays quiet — the operator sees one horizon notice per action, not two.
      const horizonAt = action.timeoutAt instanceof Date
        ? action.timeoutAt.toISOString()
        : String(action.timeoutAt);
      const marker = `Recovery wake horizon reached for action \`${action.id}\` (horizon \`${horizonAt}\`)`;
      const alreadyAnnounced = await db
        .select({ id: issueComments.id })
        .from(issueComments)
        .where(and(
          eq(issueComments.issueId, action.sourceIssueId),
          eq(issueComments.authorType, "system"),
          sql`${issueComments.body} LIKE ${`%${escapeLikePattern(marker)}%`} ESCAPE '\\'`,
        ))
        .limit(1)
        .then((rows) => rows.length > 0);
      if (alreadyAnnounced) continue;

      try {
        await issuesSvc.addComment(
          action.sourceIssueId,
          [
            `${marker}.`,
            "",
            "This recovery action passed its auto-recovery horizon without being discharged, so Paperclip has " +
              "stopped waking anyone for it and has moved it out of `active` to `escalated`. It now needs a human " +
              "or a board operator to resolve it.",
            "",
            `- Attempts: ${action.attemptCount} (budget ${action.maxAttempts})`,
            `- Auto-recovery horizon: ${horizonAt}`,
            `- Cause: \`${action.cause}\``,
            action.attemptCount === 0
              ? "- Note: this action never made a single wake attempt before its window closed, so the stranding it " +
                "was opened to repair was never actually worked."
              : "- Note: reassigning will NOT restore the wake budget — the horizon above is fixed for the life of " +
                "the action, so a new owner does not get fresh attempts.",
            "- Next action: discharge or cancel this recovery action, or record an intentional manual resolution.",
          ].join("\n"),
          {},
          { authorType: "system" },
        );
        result.announced += 1;
      } catch (error) {
        // The status transition is the load-bearing half and is already committed; a failed
        // comment must not roll it back or abort the rest of the batch.
        logger.warn(
          { err: error, actionId: action.id, sourceIssueId: action.sourceIssueId },
          "failed to announce recovery wake horizon expiry on source issue",
        );
      }
    }

    return result;
  }

  /**
   * Returns ownership of correctly-blocked-but-mis-owned recovery rows to the IC who was
   * doing the work, without touching the issue's status (BLO-19123).
   *
   * The stranded-recovery ladder re-homes a strand onto the owner's manager. For a
   * dependency-blocked issue that transfer is an artifact: the issue is not stranded, it is
   * waiting for its blocker, and when the blocker resolves
   * `reconcileResolvedBlockerDependents` wakes the *current* assignee — the manager — so the
   * agent that was actually doing the work is never woken. 290 rows accrued on two agents
   * that way before anything looked.
   *
   * This is the automated drain for that stock. It is deliberately ownership-only: the row
   * stays `blocked`, because 217 of 218 such rows have genuinely unresolved blockers and
   * moving them to `todo` would falsify state. That is the same `blocked`+`blocked` contract
   * the resolve endpoint sanctions (`routes/issues.ts:8676`), reached from a sweep instead of
   * an HTTP call — including its precondition that an unresolved first-class `blocks`
   * relation actually backs the status, so the drain can never launder a false `blocked`.
   *
   * No wake is enqueued. The blockers-resolved sweep wakes the now-correct assignee when the
   * blocker clears, which is the whole point of putting ownership back.
   *
   * Guard rationale — each of these exists because a naive drain re-triggers the ratchet:
   * - **Hand-back budget.** Two auto-returns per source issue, ever, counted over resolved
   *   history (rows are never deleted, so the count is durable). Without it a row can
   *   oscillate blocked -> handed back -> stranded -> blocked indefinitely.
   * - **Positive run evidence.** `agents.lastHeartbeatAt` proves the process is alive, not
   *   that it accomplished anything — a no-op run also succeeds. Requiring a recent run with
   *   `livenessState in (completed, advanced)` is the "real run signal" the plan asked for.
   * - **Return-owner eligibility.** A hand-back only converges if the return owner can
   *   actually run it, so terminated / `pending_approval` / invalid-org-chain owners are
   *   skipped and reported with their reason rather than silently handed work they cannot do.
   * - **Cooldown.** Source-scoped, so a row cannot be re-driven every tick.
   * - **Validity window.** An issue whose `targetDate` has already passed is reported as lost
   *   rather than silently returned late, since handing back expired work manufactures a
   *   second false signal on top of the first.
   */
  async function reconcileStrandedRecoveryHandBacksImpl(opts?: {
    runId?: string | null;
    companyId?: string | null;
    now?: Date;
    cooldownMs?: number;
    limit?: number;
    maxHandBacksPerIssue?: number;
    runEvidenceWindowMs?: number;
    residualPageSize?: number;
  }) {
    const result = {
      checked: 0,
      handedBack: 0,
      userAssignedSkipped: 0,
      budgetExhaustedSkipped: 0,
      windowExpiredSkipped: 0,
      cooldownSkipped: 0,
      returnOwnerIneligibleSkipped: 0,
      noRunEvidenceSkipped: 0,
      blockerMissingSkipped: 0,
      livePathSkipped: 0,
      pauseHoldSkipped: 0,
      claimLost: 0,
      candidateLimitSkipped: 0,
      failed: 0,
      issueIds: [] as string[],
      /**
       * Per-row residual, so the acceptance criterion "rows not handed back are enumerated
       * individually with the failing reason" is served by the sweep itself rather than by a
       * separate reconstruction pass that could disagree with it. This names every candidate
       * the pass did not hand back, with no cap: rows it *worked* carry the gate that
       * rejected them, and rows past the processing limit carry `candidate_limit_deferred`,
       * which is a scheduling reason rather than a diagnosis — those rows were never
       * evaluated, so no gate has judged them yet.
       */
      residual: [] as Array<{
        issueId: string;
        identifier: string | null;
        returnOwnerAgentId: string | null;
        reason: string;
        detail?: string;
      }>,
    };
    const now = opts?.now ?? new Date();
    const cooldownMs = Math.max(
      0,
      Math.floor(asNumber(opts?.cooldownMs, STRANDED_RECOVERY_HAND_BACK_COOLDOWN_MS)),
    );
    const maxHandBacksPerIssue = Math.max(
      0,
      Math.floor(asNumber(opts?.maxHandBacksPerIssue, STRANDED_RECOVERY_MAX_HAND_BACKS_PER_ISSUE)),
    );
    const runEvidenceWindowMs = Math.max(
      0,
      Math.floor(asNumber(opts?.runEvidenceWindowMs, STRANDED_RECOVERY_HAND_BACK_RUN_EVIDENCE_WINDOW_MS)),
    );
    const candidateLimit = Math.max(
      1,
      Math.floor(asNumber(opts?.limit, STRANDED_RECOVERY_HAND_BACK_CANDIDATE_LIMIT)),
    );
    const residualPageSize = Math.max(
      1,
      Math.floor(asNumber(opts?.residualPageSize, STRANDED_RECOVERY_HAND_BACK_RESIDUAL_PAGE_SIZE)),
    );
    const runEvidenceCutoff = new Date(now.getTime() - runEvidenceWindowMs);

    const noteResidual = (
      candidate: { issueId: string; identifier: string | null; returnOwnerAgentId: string | null },
      reason: string,
      detail?: string,
    ) => {
      result.residual.push({
        issueId: candidate.issueId,
        identifier: candidate.identifier,
        returnOwnerAgentId: candidate.returnOwnerAgentId,
        reason,
        ...(detail ? { detail } : {}),
      });
    };

    const filters = [
      inArray(issueRecoveryActions.status, ["active", "escalated"]),
      eq(issues.status, "blocked"),
      visibleIssueCondition(),
      // The drain is scoped to ONE action shape: the stranded-assigned re-home. Without
      // both predicates the query is "any active action carrying a return owner whose
      // issue is blocked and mis-owned", which is a much larger population than this
      // drain was designed and guarded for. `returnOwnerAgentId` has three writers —
      // the source-scoped stranded path (any `StrandedRecoveryCause`, so including
      // `provider_quota`), and the `pr_review_non_convergence` path at :13062 — and the
      // other two produce actions whose issues can equally be blocked and mis-owned.
      // Draining those would resolve them `handed_back` and move ownership on rows whose
      // recovery semantics this sweep's guards say nothing about.
      //
      // `kind` alone is not sufficient: `strandedRecoveryActionKind` maps several causes
      // (notably `provider_quota` and `process_lost`) onto `stranded_assigned_issue`, so
      // the cause predicate is what actually excludes the quota-wait shape.
      eq(issueRecoveryActions.kind, "stranded_assigned_issue"),
      eq(issueRecoveryActions.cause, "stranded_assigned_issue"),
      sql`${issueRecoveryActions.returnOwnerAgentId} is not null`,
      sql`${issues.assigneeAgentId} is not null`,
      // Mis-owned is the whole population: the row already sits on someone other than the
      // agent it should go back to. A row already on its return owner needs no repair.
      sql`${issues.assigneeAgentId} <> ${issueRecoveryActions.returnOwnerAgentId}`,
    ];
    if (opts?.companyId) filters.push(eq(issueRecoveryActions.companyId, opts.companyId));

    const candidateRows = await db
      .select({
        actionId: issueRecoveryActions.id,
        companyId: issueRecoveryActions.companyId,
        actionOwnerAgentId: issueRecoveryActions.ownerAgentId,
        actionCause: issueRecoveryActions.cause,
        actionCreatedAt: issueRecoveryActions.createdAt,
        actionLastAttemptAt: issueRecoveryActions.lastAttemptAt,
        returnOwnerAgentId: issueRecoveryActions.returnOwnerAgentId,
        issueId: issues.id,
        identifier: issues.identifier,
        assigneeAgentId: issues.assigneeAgentId,
        assigneeUserId: issues.assigneeUserId,
        targetDate: issues.targetDate,
        totalCount: sql<number>`count(*) over()::int`,
      })
      .from(issueRecoveryActions)
      .innerJoin(issues, eq(issues.id, issueRecoveryActions.sourceIssueId))
      .where(and(...filters))
      .orderBy(asc(issueRecoveryActions.id))
      .limit(candidateLimit);

    const totalCandidateCount = candidateRows[0]?.totalCount ?? 0;
    const candidates = candidateRows.map(({ totalCount: _totalCount, ...candidate }) => candidate);
    result.checked = candidates.length;
    result.candidateLimitSkipped = Math.max(0, totalCandidateCount - candidates.length);

    for (const candidate of candidates) {
      const returnOwnerAgentId = candidate.returnOwnerAgentId;
      if (!returnOwnerAgentId) continue;

      // The whole per-candidate body, gates included, is contained: every gate issues its own
      // queries, so an error in one of them would otherwise abort the entire batch and leave
      // the remaining rows unexamined with no record of why.
      try {
        // A human owner outranks the recorded return owner. The underlying write sets
        // `assigneeAgentId` without clearing `assigneeUserId`, so handing back here would
        // leave the row owned by both.
        if (candidate.assigneeUserId) {
          result.userAssignedSkipped += 1;
          noteResidual(candidate, "user_assigned", candidate.assigneeUserId);
          continue;
        }

        const priorHandBacks = await db
          .select({
            count: sql<number>`count(*)::int`,
            latestResolvedAt: sql<Date | null>`max(${issueRecoveryActions.resolvedAt})`,
          })
          .from(issueRecoveryActions)
          .where(and(
            eq(issueRecoveryActions.companyId, candidate.companyId),
            eq(issueRecoveryActions.sourceIssueId, candidate.issueId),
            eq(issueRecoveryActions.outcome, "handed_back"),
          ));
        const priorHandBackCount = priorHandBacks[0]?.count ?? 0;
        if (priorHandBackCount >= maxHandBacksPerIssue) {
          result.budgetExhaustedSkipped += 1;
          noteResidual(candidate, "hand_back_budget_exhausted", `${priorHandBackCount}/${maxHandBacksPerIssue}`);
          continue;
        }

        // Source-scoped, not action-scoped. A successful hand-back resolves its action, so
        // the next strand arrives as a brand-new row with `lastAttemptAt: null` — keying the
        // cooldown on the action would let a row bounce straight back on the following tick,
        // bounded only by the budget. Keying it on the last hand-back for this *issue* is
        // what actually paces the oscillation.
        const latestHandBackAt = priorHandBacks[0]?.latestResolvedAt
          ? new Date(priorHandBacks[0].latestResolvedAt as Date | string)
          : null;
        if (latestHandBackAt && now.getTime() - latestHandBackAt.getTime() < cooldownMs) {
          result.cooldownSkipped += 1;
          noteResidual(candidate, "cooldown", latestHandBackAt.toISOString());
          continue;
        }

        // `targetDate` is a date column: compare on the calendar day so a deadline of "today"
        // is still inside its window.
        if (candidate.targetDate && isValidityWindowExpired(candidate.targetDate, now)) {
          result.windowExpiredSkipped += 1;
          noteResidual(candidate, "validity_window_expired", String(candidate.targetDate));
          continue;
        }

        const eligibility = await resolveReturnOwnerEligibility(candidate.companyId, returnOwnerAgentId);
        if (!eligibility.assignable) {
          result.returnOwnerIneligibleSkipped += 1;
          noteResidual(candidate, "return_owner_ineligible", eligibility.reason);
          continue;
        }

        // Anchored to THIS action, not just to a flat 7-day window: the floor is the later
        // of the window and the moment this strand was recorded, so the evidence has to
        // postdate the failure being repaired. An owner that stranded a row and has not
        // completed anything since is not demonstrably able to take it back yet.
        //
        // Deliberately still agent-scoped rather than source-issue-scoped. Every candidate
        // here is `blocked` behind a *verified* unresolved blocker (asserted below), and a
        // blocked issue cannot be worked — its runs terminate `issue_dependencies_blocked`
        // rather than succeeding. So a `status: succeeded` + `completed|advanced` run
        // against the source issue cannot exist for any row in this population, and
        // requiring one would skip 100% of candidates and drain nothing. Oscillation is
        // bounded instead by the two guards that ARE source-scoped and do hold here: the
        // permanent per-issue hand-back budget and the per-issue cooldown above.
        const evidenceFloor = candidate.actionCreatedAt && candidate.actionCreatedAt > runEvidenceCutoff
          ? candidate.actionCreatedAt
          : runEvidenceCutoff;
        if (!(await hasPositiveRunEvidence(returnOwnerAgentId, evidenceFloor))) {
          result.noRunEvidenceSkipped += 1;
          noteResidual(candidate, "no_positive_run_evidence", evidenceFloor.toISOString());
          continue;
        }

        // Same precondition the resolve endpoint enforces for a `blocked` outcome: the status
        // must be backed by a real unresolved blocker. Without this the drain would quietly
        // hand back rows whose `blocked` is itself the lie.
        if (!(await hasUnresolvedFirstClassBlocker(candidate.issueId))) {
          result.blockerMissingSkipped += 1;
          noteResidual(candidate, "no_unresolved_blocker");
          continue;
        }

        if (await hasActiveExecutionPath(candidate.companyId, candidate.issueId, candidate.assigneeAgentId)) {
          result.livePathSkipped += 1;
          noteResidual(candidate, "live_execution_path");
          continue;
        }

        if (await isAutomaticRecoverySuppressedByPauseHold(db, candidate.companyId, candidate.issueId, treeControlSvc)) {
          result.pauseHoldSkipped += 1;
          noteResidual(candidate, "pause_hold");
          continue;
        }

        const resolutionNote =
          "Recovery ownership returned to the original assignee without changing the source issue "
          + "status: the issue is waiting on its blocker, not stranded, so the blockers-resolved "
          + "sweep must wake the agent that was doing the work.";
        const handedBack = await db.transaction(async (tx) => {
          const resolved = await recoveryActionsSvc.resolveActiveForIssue({
            companyId: candidate.companyId,
            sourceIssueId: candidate.issueId,
            actionId: candidate.actionId,
            status: "resolved",
            outcome: "handed_back",
            resolutionNote,
          }, tx);
          if (!resolved) return null;
          // Re-assert the observed ownership tuple in the WHERE clause so a concurrent
          // checkout or adoption between candidate selection and this write loses the race
          // rather than being silently overwritten.
          const updated = await tx
            .update(issues)
            .set({ assigneeAgentId: returnOwnerAgentId, updatedAt: now })
            .where(and(
              eq(issues.id, candidate.issueId),
              eq(issues.companyId, candidate.companyId),
              eq(issues.status, "blocked"),
              eq(issues.assigneeAgentId, candidate.assigneeAgentId as string),
              isNull(issues.assigneeUserId),
            ))
            .returning({ id: issues.id });
          if (updated.length === 0) {
            // Roll the action resolution back with it: a resolved action whose issue never
            // moved would drop the row out of the active set while leaving it mis-owned,
            // which is strictly worse than not draining it.
            throw new HandBackOwnershipRaceLost();
          }
          return resolved;
        });

        if (!handedBack) {
          result.claimLost += 1;
          noteResidual(candidate, "claim_lost");
          continue;
        }

        result.handedBack += 1;
        result.issueIds.push(candidate.issueId);
        await logActivity(db, {
          companyId: candidate.companyId,
          actorType: "system",
          actorId: "stranded_recovery_hand_back",
          agentId: candidate.actionOwnerAgentId,
          runId: opts?.runId ?? null,
          action: "issue.recovery_action_resolved",
          entityType: "issue",
          entityId: candidate.issueId,
          details: {
            source: "recovery.stranded_recovery_hand_back",
            identifier: candidate.identifier,
            status: "blocked",
            recoveryActionId: handedBack.id,
            recoveryActionStatus: handedBack.status,
            outcome: handedBack.outcome,
            resolutionNote: handedBack.resolutionNote,
            recoveryCause: candidate.actionCause,
            recoveryOwnerAgentId: candidate.actionOwnerAgentId,
            previousAssigneeAgentId: candidate.assigneeAgentId,
            returnOwnerAgentId,
            priorHandBackCount,
          },
        });
      } catch (error) {
        if (error instanceof HandBackOwnershipRaceLost) {
          result.claimLost += 1;
          noteResidual(candidate, "ownership_race_lost");
          continue;
        }
        result.failed += 1;
        noteResidual(candidate, "error", error instanceof Error ? error.message : String(error));
        logger.warn(
          { err: error, actionId: candidate.actionId, sourceIssueId: candidate.issueId },
          "stranded-recovery hand-back failed for candidate",
        );
      }
    }

    // Name every row the processing limit deferred. `candidateLimitSkipped` alone made an
    // over-limit pass report an inventory it did not have: the rows past the page stayed
    // mis-owned, were not handed back, and carried no identifier or reason — so the residual
    // silently stopped being the operator repair list at exactly the backlog size that needs
    // one.
    //
    // Exhaustive, not capped. Capping the enumeration instead would only move the unnamed-rows
    // problem to a higher threshold, and an inventory that is complete "up to N" is not the
    // individually actionable list the acceptance criterion asks for. It stays a separate pass
    // from the processing loop because the two costs differ by orders of magnitude: naming a
    // row is three columns over the same index range, working one is several queries and a
    // transaction. That split is what lets the inventory be complete while a single scheduler
    // tick's write volume stays bounded.
    //
    // Cursored off the last processed action id, so the worked and deferred sets cannot
    // overlap. The read is not in the processing loop's transaction, so a row concurrently
    // handed back by another path can appear here as deferred; that is the ordinary staleness
    // of a point-in-time report, and it errs toward naming a row that needs no repair rather
    // than omitting one that does.
    let deferredCursor = candidates.length > 0 ? candidates[candidates.length - 1].actionId : null;
    if (result.candidateLimitSkipped > 0 && deferredCursor) {
      let enumerated = 0;
      for (;;) {
        const deferredRows = await db
          .select({
            actionId: issueRecoveryActions.id,
            issueId: issues.id,
            identifier: issues.identifier,
            returnOwnerAgentId: issueRecoveryActions.returnOwnerAgentId,
          })
          .from(issueRecoveryActions)
          .innerJoin(issues, eq(issues.id, issueRecoveryActions.sourceIssueId))
          .where(and(...filters, gt(issueRecoveryActions.id, deferredCursor as string)))
          .orderBy(asc(issueRecoveryActions.id))
          .limit(residualPageSize);

        if (deferredRows.length === 0) break;
        for (const row of deferredRows) {
          noteResidual(row, "candidate_limit_deferred", `processing limit ${candidateLimit}`);
          enumerated += 1;
        }
        deferredCursor = deferredRows[deferredRows.length - 1].actionId;
        // A short page is the last page, so this terminates without a second round trip.
        if (deferredRows.length < residualPageSize) break;
      }

      logger.warn(
        {
          processed: candidates.length,
          skipped: result.candidateLimitSkipped,
          limit: candidateLimit,
          enumerated,
        },
        "stranded-recovery hand-back deferred candidates past processing limit",
      );
    }

    return result;
  }

  /**
   * Retries delivery for a blocked issue whose active recovery action committed but whose
   * owner wake did not. Review-stage escalation intentionally dispatches after committing
   * its stage-row transaction; a process exit or enqueue failure in that gap must therefore
   * leave a durable state that a later liveness pass can repair.
   *
   * This is intentionally action-driven rather than an expansion of
   * `reconcileStrandedAssignedIssues`'s status filter. Some blocked issues are deliberately
   * terminal from the ordinary stranded-work sweep; only an active recovery action proves
   * that an owner wake is still the intended next step.
   *
   * `backlog` is also selected here, but is *folded* rather than woken (BLO-25907). It used
   * to be selected by nothing: `reconcileStrandedAssignedIssues` covers
   * todo/in_progress/in_review and this sweep covered only blocked, so an assigned backlog
   * issue carrying an active action was invisible to both and nothing ever re-drove it —
   * BLO-16074 sat that way for 27 days with `updatedAt == createdAt`. Waking is the wrong
   * repair because backlog deliberately means "not dispatchable", so re-delivering an owner
   * wake would contradict the status. Resolving the action is the honest repair: it keeps
   * the active set truthful without claiming a backlog issue is schedulable. Selecting it
   * here rather than relying only on the write-time fold in
   * `classifySourceRecoveryRevalidation` is what heals rows that are *already* parked, since
   * that classifier only runs when something writes to the issue and the failure mode is
   * that nothing does.
   */
  async function reconcileStrandedRecoveryWakeBackstopImpl(opts?: {
    runId?: string | null;
    companyId?: string | null;
    now?: Date;
    cooldownMs?: number;
  }) {
    const result = {
      checked: 0,
      healed: 0,
      backlogParkedResolved: 0,
      noOwnerSkipped: 0,
      causeSkipped: 0,
      exhaustedSkipped: 0,
      cooldownSkipped: 0,
      livePathSkipped: 0,
      interactionSkipped: 0,
      pauseHoldSkipped: 0,
      claimLost: 0,
      candidateLimitSkipped: 0,
      deferredOrFailed: 0,
      enqueueFailed: 0,
      issueIds: [] as string[],
    };
    const now = opts?.now ?? new Date();
    const cooldownMs = Math.max(
      0,
      Math.floor(asNumber(opts?.cooldownMs, STRANDED_RECOVERY_WAKE_BACKSTOP_COOLDOWN_MS)),
    );
    const cooldownBefore = new Date(now.getTime() - cooldownMs);

    const queryCandidates = (afterActionId: string | null) => {
      const filters = [
        inArray(issueRecoveryActions.status, ["active", "escalated"]),
        inArray(issues.status, STRANDED_RECOVERY_WAKE_BACKSTOP_ISSUE_STATUSES),
        visibleIssueCondition(),
        sql`${issues.assigneeAgentId} is not null`,
      ];
      if (opts?.companyId) filters.push(eq(issueRecoveryActions.companyId, opts.companyId));
      if (afterActionId) filters.push(gt(issueRecoveryActions.id, afterActionId));
      return db
        .select({
          actionId: issueRecoveryActions.id,
          companyId: issueRecoveryActions.companyId,
          actionOwnerAgentId: issueRecoveryActions.ownerAgentId,
          actionCause: issueRecoveryActions.cause,
          actionAttemptCount: issueRecoveryActions.attemptCount,
          actionMaxAttempts: issueRecoveryActions.maxAttempts,
          actionTimeoutAt: issueRecoveryActions.timeoutAt,
          actionLastAttemptAt: issueRecoveryActions.lastAttemptAt,
          issueId: issues.id,
          issueStatus: issues.status,
          // Preserve the ownership tuple observed with the candidate. The backstop
          // claims the recovery action before enqueueing, so adoption can commit in
          // the gap between those operations; enqueueWakeup performs the final
          // ownership CAS under the issue lock.
          executionRunId: issues.executionRunId,
          checkoutRunId: issues.checkoutRunId,
          assigneeAgentId: issues.assigneeAgentId,
          identifier: issues.identifier,
          totalCount: sql<number>`count(*) over()::int`,
        })
        .from(issueRecoveryActions)
        .innerJoin(issues, eq(issues.id, issueRecoveryActions.sourceIssueId))
        .where(and(...filters))
        .orderBy(asc(issueRecoveryActions.id))
        .limit(STRANDED_RECOVERY_WAKE_BACKSTOP_CANDIDATE_LIMIT);
    };

    let candidateRows = await queryCandidates(strandedRecoveryWakeBackstopCandidateCursor);
    if (candidateRows.length === 0 && strandedRecoveryWakeBackstopCandidateCursor) {
      strandedRecoveryWakeBackstopCandidateCursor = null;
      candidateRows = await queryCandidates(null);
    }
    const totalCandidateCount = candidateRows[0]?.totalCount ?? 0;
    const candidates = candidateRows.map(({ totalCount: _totalCount, ...candidate }) => candidate);
    result.checked = candidates.length;
    result.candidateLimitSkipped = Math.max(0, totalCandidateCount - candidates.length);
    setBackstopDeferredCandidates("stranded_recovery_wake_backstop", result.candidateLimitSkipped);
    const lastCandidate = candidates[candidates.length - 1] ?? null;
    strandedRecoveryWakeBackstopCandidateCursor =
      result.candidateLimitSkipped > 0 && lastCandidate ? lastCandidate.actionId : null;

    if (result.candidateLimitSkipped > 0) {
      logger.warn(
        {
          processed: candidates.length,
          skipped: result.candidateLimitSkipped,
          limit: STRANDED_RECOVERY_WAKE_BACKSTOP_CANDIDATE_LIMIT,
          nextCursor: strandedRecoveryWakeBackstopCandidateCursor,
        },
        "stranded recovery wake backstop deferred candidates past page limit",
      );
    }

    for (const candidate of candidates) {
      // `backlog` is selected so the action cannot become a zombie, but it is folded rather
      // than woken: the status means "deliberately not dispatchable", so re-delivering an
      // owner wake would contradict the park. Resolving keeps the active set honest. This
      // runs ahead of the owner/cause/cooldown gates on purpose — those gates decide whether
      // a *wake* is worth attempting, and none of them apply to an action that is never
      // going to be serviced at all.
      if ((STRANDED_RECOVERY_WAKE_BACKSTOP_FOLD_ONLY_STATUSES as readonly string[])
        .includes(candidate.issueStatus)) {
        const resolutionNote =
          `Recovery action became stale because the source issue is parked in ${candidate.issueStatus}, `
          + "which is not dispatchable, so no sweep will re-drive its owner.";
        const resolved = await recoveryActionsSvc.resolveActiveForIssue({
          companyId: candidate.companyId,
          sourceIssueId: candidate.issueId,
          actionId: candidate.actionId,
          status: "cancelled",
          outcome: "cancelled",
          resolutionNote,
        });
        if (!resolved) {
          result.claimLost += 1;
          continue;
        }
        result.backlogParkedResolved += 1;
        result.issueIds.push(candidate.issueId);
        await logActivity(db, {
          companyId: candidate.companyId,
          actorType: "system",
          actorId: "stranded_recovery_wake_backstop",
          agentId: candidate.actionOwnerAgentId,
          runId: opts?.runId ?? null,
          action: "issue.recovery_action_resolved",
          entityType: "issue",
          entityId: candidate.issueId,
          details: {
            source: "recovery.stranded_recovery_wake_backstop",
            identifier: candidate.identifier,
            status: candidate.issueStatus,
            recoveryActionId: resolved.id,
            recoveryActionStatus: resolved.status,
            outcome: resolved.outcome,
            resolutionNote: resolved.resolutionNote,
            recoveryCause: candidate.actionCause,
            recoveryOwnerAgentId: candidate.actionOwnerAgentId,
          },
        });
        continue;
      }

      const ownerAgentId = candidate.actionOwnerAgentId;
      if (!ownerAgentId) {
        result.noOwnerSkipped += 1;
        continue;
      }
      if (
        candidate.actionCause === "workspace_validation_failed" ||
        candidate.actionCause === "configuration_incomplete"
      ) {
        result.causeSkipped += 1;
        continue;
      }
      if (strandedRecoveryWakeAttemptsExhausted({
        attemptCount: candidate.actionAttemptCount,
        maxAttempts: candidate.actionMaxAttempts,
        timeoutAt: candidate.actionTimeoutAt,
      }, now, false)) {
        result.exhaustedSkipped += 1;
        continue;
      }
      const lastAttemptAt = candidate.actionLastAttemptAt
        ? new Date(candidate.actionLastAttemptAt as Date | string)
        : null;
      if (lastAttemptAt && now.getTime() - lastAttemptAt.getTime() < cooldownMs) {
        result.cooldownSkipped += 1;
        continue;
      }
      if (
        await hasActiveExecutionPath(candidate.companyId, candidate.issueId, ownerAgentId) ||
        await hasQueuedIssueWake(candidate.companyId, candidate.issueId, ownerAgentId)
      ) {
        result.livePathSkipped += 1;
        continue;
      }
      if (await hasPendingWakeInteraction(candidate.companyId, candidate.issueId)) {
        result.interactionSkipped += 1;
        continue;
      }
      if (await isAutomaticRecoverySuppressedByPauseHold(db, candidate.companyId, candidate.issueId, treeControlSvc)) {
        result.pauseHoldSkipped += 1;
        continue;
      }

      // Claim the retry before enqueueing. The persisted timestamp is both a cross-process
      // lease and a unique delivery token, so another sweep cannot reuse a completed wake if
      // this owner later becomes stranded again. If this process dies after the claim, the
      // cooldown expires and the same durable action is eligible on the next pass.
      const claimed = await db
        .update(issueRecoveryActions)
        .set({ lastAttemptAt: now, updatedAt: now })
        .where(and(
          eq(issueRecoveryActions.id, candidate.actionId),
          eq(issueRecoveryActions.companyId, candidate.companyId),
          eq(issueRecoveryActions.ownerAgentId, ownerAgentId),
          inArray(issueRecoveryActions.status, ["active", "escalated"]),
          or(isNull(issueRecoveryActions.lastAttemptAt), lt(issueRecoveryActions.lastAttemptAt, cooldownBefore)),
        ))
        .returning({ lastAttemptAt: issueRecoveryActions.lastAttemptAt })
        .then((rows) => rows[0] ?? null);
      if (!claimed) {
        result.claimLost += 1;
        continue;
      }
      const deliveryAttemptAt = claimed.lastAttemptAt ?? now;
      const idempotencyKey =
        `source_scoped_recovery_action:${candidate.actionId}:wake_backstop:${deliveryAttemptAt.getTime()}`;

      try {
        const wake = await deps.enqueueWakeup(ownerAgentId, {
          source: "assignment",
          triggerDetail: "system",
          reason: "source_scoped_recovery_action",
          idempotencyKey,
          payload: withRecoveryModelProfileHint({
            issueId: candidate.issueId,
            sourceIssueId: candidate.issueId,
            recoveryActionId: candidate.actionId,
            recoveryCause: candidate.actionCause,
            backstop: "stranded_recovery_wake_backstop",
          }, "status_only"),
          requestedByActorType: "system",
          requestedByActorId: null,
          contextSnapshot: withRecoveryModelProfileHint({
            issueId: candidate.issueId,
            taskId: candidate.issueId,
            wakeReason: "source_scoped_recovery_action",
            skipIssueComment: true,
            source: "issue_recovery_action",
            recoveryActionId: candidate.actionId,
            sourceIssueId: candidate.issueId,
            recoveryCause: candidate.actionCause,
            backstop: "stranded_recovery_wake_backstop",
          }, "status_only"),
          expectedLockOwnerState: {
            executionRunId: candidate.executionRunId,
            checkoutRunId: candidate.checkoutRunId,
            assigneeAgentId: candidate.assigneeAgentId,
          },
        });
        if (!wake) {
          result.deferredOrFailed += 1;
          continue;
        }

        result.healed += 1;
        result.issueIds.push(candidate.issueId);
        await logActivity(db, {
          companyId: candidate.companyId,
          actorType: "system",
          actorId: "stranded_recovery_wake_backstop",
          agentId: ownerAgentId,
          runId: opts?.runId ?? null,
          action: "issue.updated",
          entityType: "issue",
          entityId: candidate.issueId,
          details: {
            source: "recovery.stranded_recovery_wake_backstop",
            identifier: candidate.identifier,
            status: candidate.issueStatus,
            wakeupRunId: wake.id,
            recoveryActionId: candidate.actionId,
            recoveryCause: candidate.actionCause,
            recoveryOwnerAgentId: ownerAgentId,
            idempotencyKey,
          },
        });
      } catch (err) {
        result.deferredOrFailed += 1;
        result.enqueueFailed += 1;
        logger.warn(
          { err, issueId: candidate.issueId, agentId: ownerAgentId, recoveryActionId: candidate.actionId },
          "failed to redeliver stranded recovery wake from backstop",
        );
      }
    }

    if (result.healed > 0) {
      logger.warn(
        { healed: result.healed, issueIds: result.issueIds },
        "stranded recovery wake backstop redelivered undelivered recovery-action wakes",
      );
    } else if (result.checked > 0) {
      // The all-skipped sweep is the one that matters and it used to be the one that said
      // nothing: the healed>0 branch above was the only log here, and both callers in
      // index.ts log `reconcileIssueGraphLiveness` only when `escalationsCreated` or
      // `dependencyWakesHealed` moved. So a sweep that examined a full page of candidates
      // and redelivered none emitted no record at all, and the per-gate counters below were
      // computed and dropped on the floor. That is why BLO-19124 could measure the symptom
      // (actions reaching their 6h horizon at attemptCount 0-1 of a 5-attempt budget) but
      // not the cause: nothing said which gate consumed the ~11 unused redelivery slots.
      // `info` rather than `warn` because this fires on the 30s scheduler tick and an
      // idle-but-healthy fleet legitimately skips every candidate (live path, cooldown).
      // The value is the time series, not any single line.
      logger.info(
        {
          checked: result.checked,
          noOwnerSkipped: result.noOwnerSkipped,
          causeSkipped: result.causeSkipped,
          exhaustedSkipped: result.exhaustedSkipped,
          cooldownSkipped: result.cooldownSkipped,
          livePathSkipped: result.livePathSkipped,
          interactionSkipped: result.interactionSkipped,
          pauseHoldSkipped: result.pauseHoldSkipped,
          claimLost: result.claimLost,
          candidateLimitSkipped: result.candidateLimitSkipped,
          deferredOrFailed: result.deferredOrFailed,
          enqueueFailed: result.enqueueFailed,
          backlogParkedResolved: result.backlogParkedResolved,
        },
        "stranded recovery wake backstop redelivered nothing this sweep",
      );
    }

    for (const [reason, count] of [
      ["no_owner", result.noOwnerSkipped], ["cause", result.causeSkipped],
      ["exhausted", result.exhaustedSkipped], ["cooldown", result.cooldownSkipped],
      ["live_path", result.livePathSkipped], ["interaction", result.interactionSkipped],
      ["pause_hold", result.pauseHoldSkipped], ["claim_lost", result.claimLost],
      ["deferred_or_failed", result.deferredOrFailed], ["enqueue_failed", result.enqueueFailed],
    ] as const) {
      for (let i = 0; i < count; i++) recordBackstopCandidateSkipped("stranded_recovery_wake_backstop", reason);
    }
    if (result.candidateLimitSkipped === 0) recordBackstopSweepCompleted("stranded_recovery_wake_backstop");

    return result;
  }

  function reconcileResolvedDependencyWakeBackstop(opts?: ResolvedDependencyWakeBackstopOptions) {
    const run = resolvedDependencyWakeBackstopTail.then(() => reconcileResolvedDependencyWakeBackstopImpl(opts));
    resolvedDependencyWakeBackstopTail = run.then(() => undefined, () => undefined);
    return run;
  }

  function reconcileStrandedRecoveryWakeBackstop(opts?: Parameters<typeof reconcileStrandedRecoveryWakeBackstopImpl>[0]) {
    const run = strandedRecoveryWakeBackstopTail.then(() => reconcileStrandedRecoveryWakeBackstopImpl(opts));
    strandedRecoveryWakeBackstopTail = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * Serialized like its sibling backstops: two overlapping passes would both read the same
   * pre-hand-back budget count and could spend the per-issue budget twice on one row.
   */
  function reconcileStrandedRecoveryHandBacks(opts?: Parameters<typeof reconcileStrandedRecoveryHandBacksImpl>[0]) {
    const run = strandedRecoveryHandBackTail.then(() => reconcileStrandedRecoveryHandBacksImpl(opts));
    strandedRecoveryHandBackTail = run.then(() => undefined, () => undefined);
    return run;
  }

  async function reconcileIssueGraphLiveness(opts?: {
    runId?: string | null;
    force?: boolean;
    lookbackHours?: number;
    issueCreatedAtGte?: Date | null;
    now?: Date;
    reescalationCooldownMs?: number;
    unchangedTargetSuppressionMs?: number;
    /** Idle bound after which an untouched recovery row is retired (BLO-28957). 0 disables. */
    abandonedRecoveryMs?: number;
  }) {
    const collected = await collectIssueGraphLiveness();
    let findings = collected.findings;
    // BLO-29601: run the premise re-check FIRST, so a sweep that closes a dead
    // escalation does it before anything downstream reads the escalation as an owned
    // action path. Unfiltered by `issueCreatedAtGte` on purpose: that knob narrows which
    // findings may CREATE escalations, and applying it here would leave the pre-cutoff
    // backlog — the population this exists to drain — permanently unreachable.
    const staleEscalationCleanup = await autoResolveStaleLivenessEscalations(
      collected.escalationBlindFindings,
      { runId: opts?.runId ?? null },
    );
    if (opts?.issueCreatedAtGte) {
      const findingIssueIds = [...new Set(findings.map((finding) => finding.recoveryIssueId))];
      const eligibleIssueIds = new Set(
        findingIssueIds.length === 0
          ? []
          : (await db
              .select({ id: issues.id })
              .from(issues)
              .where(and(
                inArray(issues.id, findingIssueIds),
                gte(issues.createdAt, opts.issueCreatedAtGte),
              )))
              .map((issue) => issue.id),
      );
      findings = findings.filter((finding) => eligibleIssueIds.has(finding.recoveryIssueId));
    }
    const experimentalSettings = await instanceSettings.getExperimental();
    const autoRecoveryEnabled = asBoolean(
      experimentalSettings.enableIssueGraphLivenessAutoRecovery,
      true,
    ) || opts?.force === true;
    const lookbackHours = normalizeIssueGraphLivenessAutoRecoveryLookbackHours(
      opts?.lookbackHours ?? experimentalSettings.issueGraphLivenessAutoRecoveryLookbackHours,
    );
    const now = opts?.now ?? new Date();
    // `lookbackHours` is now a min-staleness threshold (post-2026-05-06
    // RCA gate inversion). Escalate when an issue has been silently quiet
    // for at least this long.
    const staleAt = new Date(now.getTime() - lookbackHours * 60 * 60 * 1000);
    // Shared with the preview so the paired operator endpoints cannot disagree
    // about the default windows (BLO-27676 review).
    const { reescalationCooldownMs, unchangedTargetSuppressionMs } =
      normalizeLivenessSuppressionWindows(opts);
    const obsoleteRecoveryCleanup = await retireObsoleteLivenessRecoveryIssues(findings, {
      now,
      abandonedAfterMs: Math.max(
        0,
        Math.floor(asNumber(opts?.abandonedRecoveryMs, DEFAULT_LIVENESS_ABANDONED_RECOVERY_MS)),
      ),
    });
    const activityByIssueKey = await loadLivenessRecoveryIssueLastActivityByKey(findings);
    const doneRecoveryBlockerCleanup = await retireDoneLivenessRecoveryBlockers();
    const result = {
      findings: findings.length,
      autoRecoveryEnabled,
      lookbackHours,
      cutoff: staleAt.toISOString(),
      escalationsCreated: 0,
      existingEscalations: 0,
      skipped: 0,
      skippedAutoRecoveryDisabled: 0,
      skippedOutsideLookback: 0,
      skippedReescalationCooldown: 0,
      skippedUnchangedTarget: 0,
      obsoleteRecoveriesRetired: obsoleteRecoveryCleanup.retired,
      // BLO-29601. `findings` above was collected BEFORE these closures landed, so the
      // subjects freed by this pass still carry their (now-cancelled) escalation as a
      // waiting path in the minting view and cannot be re-escalated on this same tick.
      // That is the wanted shape: closing a dead escalation should not immediately mint
      // a replacement. A subject that is genuinely still stuck re-fires next sweep,
      // through the normal staleness and cooldown gates.
      staleEscalationsChecked: staleEscalationCleanup.checked,
      staleEscalationsAutoResolved: staleEscalationCleanup.autoResolved,
      staleEscalationsPremiseStillTrueSkipped: staleEscalationCleanup.premiseStillTrueSkipped,
      staleEscalationsUnparsableSkipped: staleEscalationCleanup.unparsableSkipped,
      staleEscalationsLiveRunSkipped: staleEscalationCleanup.liveRunSkipped,
      staleEscalationRunsReleased: staleEscalationCleanup.runsReleased,
      staleEscalationBlockerRelationsRemoved: staleEscalationCleanup.blockerRelationsRemoved,
      staleEscalationAutoResolvedIssueIds: staleEscalationCleanup.autoResolvedIssueIds,
      obsoleteRecoveriesActiveSkipped: obsoleteRecoveryCleanup.activeSkipped,
      // Breakout of the dominant `activeSkipped` arm. `activeSkipped` stays the
      // total so existing consumers keep working; this names the "source is
      // still open" rows specifically -- rows still being held. Rows deferred by
      // an in-flight run are `activeSkipped - sourceStillOpenSkipped`.
      obsoleteRecoveriesSourceStillOpenSkipped: obsoleteRecoveryCleanup.sourceStillOpenSkipped,
      // Rows that fell THROUGH that skip because the row itself went untouched
      // past `abandonedRecoveryMs` (BLO-28957). These are the retirements that
      // hand a source its wake path back, so this is the counter to watch when
      // asking whether the bound is firing -- and, if it climbs while
      // `escalationsCreated` climbs with it one cooldown later, whether it is
      // firing on rows that should have been left alone.
      obsoleteRecoveriesAbandonedRetired: obsoleteRecoveryCleanup.abandonedRetired,
      obsoleteRecoveryBlockerRelationsRemoved: obsoleteRecoveryCleanup.blockerRelationsRemoved,
      // Edge cleared but the status restore did not land -- the source is left
      // in the `blocked_without_blockers` trigger state. Non-zero means the
      // detector has been silently re-armed against those sources.
      obsoleteRecoveryBlockerPruneRestoreDegraded: obsoleteRecoveryCleanup.blockerPruneRestoreDegraded,
      doneRecoveryBlockerRelationsRemoved: doneRecoveryBlockerCleanup.blockerRelationsRemoved,
      doneRecoveryBlockerPruneRestoreDegraded: doneRecoveryBlockerCleanup.blockerPruneRestoreDegraded,
      dependencyWakeBackstopChecked: 0,
      dependencyWakesHealed: 0,
      dependencyWakeExistingSkipped: 0,
      dependencyWakeLivePathSkipped: 0,
      dependencyWakeInteractionSkipped: 0,
      dependencyWakePauseHoldSkipped: 0,
      dependencyWakeNotReadySkipped: 0,
      dependencyWakeCandidateLimitSkipped: 0,
      dependencyWakeDeferredOrFailed: 0,
      dependencyWakeEnqueueFailed: 0,
      dependencyWakeIssueIds: [] as string[],
      strandedRecoveryWakeBackstopChecked: 0,
      strandedRecoveryWakesHealed: 0,
      strandedRecoveryWakeExhaustedSkipped: 0,
      strandedRecoveryWakeCooldownSkipped: 0,
      strandedRecoveryWakeLivePathSkipped: 0,
      strandedRecoveryWakeDeferredOrFailed: 0,
      strandedRecoveryWakeEnqueueFailed: 0,
      strandedRecoveryWakeIssueIds: [] as string[],
      expiredRecoveryHorizonsEscalated: 0,
      expiredRecoveryHorizonsAnnounced: 0,
      expiredRecoveryHorizonIssueIds: [] as string[],
      issueIds: [] as string[],
      escalationIssueIds: [] as string[],
      retiredRecoveryIssueIds: obsoleteRecoveryCleanup.retiredIssueIds,
    };

    const dependencyWakeBackstop = await reconcileResolvedDependencyWakeBackstop({
      runId: opts?.runId ?? null,
    });
    result.dependencyWakeBackstopChecked = dependencyWakeBackstop.checked;
    result.dependencyWakesHealed = dependencyWakeBackstop.healed;
    result.dependencyWakeExistingSkipped = dependencyWakeBackstop.existingWakeSkipped;
    result.dependencyWakeLivePathSkipped = dependencyWakeBackstop.livePathSkipped;
    result.dependencyWakeInteractionSkipped = dependencyWakeBackstop.interactionSkipped;
    result.dependencyWakePauseHoldSkipped = dependencyWakeBackstop.pauseHoldSkipped;
    result.dependencyWakeNotReadySkipped = dependencyWakeBackstop.notReadySkipped;
    result.dependencyWakeCandidateLimitSkipped = dependencyWakeBackstop.candidateLimitSkipped;
    result.dependencyWakeDeferredOrFailed = dependencyWakeBackstop.deferredOrFailed;
    result.dependencyWakeEnqueueFailed = dependencyWakeBackstop.enqueueFailed;
    result.dependencyWakeIssueIds = dependencyWakeBackstop.issueIds;

    // This sibling backstop is independent of liveness findings and remains enabled even
    // when automatic liveness escalation is disabled: it only redelivers an already-committed
    // recovery action rather than creating or re-routing recovery work.
    const strandedRecoveryWakeBackstop = await reconcileStrandedRecoveryWakeBackstop({
      runId: opts?.runId ?? null,
      now,
    });
    result.strandedRecoveryWakeBackstopChecked = strandedRecoveryWakeBackstop.checked;
    result.strandedRecoveryWakesHealed = strandedRecoveryWakeBackstop.healed;
    result.strandedRecoveryWakeExhaustedSkipped = strandedRecoveryWakeBackstop.exhaustedSkipped;
    result.strandedRecoveryWakeCooldownSkipped = strandedRecoveryWakeBackstop.cooldownSkipped;
    result.strandedRecoveryWakeLivePathSkipped = strandedRecoveryWakeBackstop.livePathSkipped;
    result.strandedRecoveryWakeDeferredOrFailed = strandedRecoveryWakeBackstop.deferredOrFailed;
    result.strandedRecoveryWakeEnqueueFailed = strandedRecoveryWakeBackstop.enqueueFailed;
    result.strandedRecoveryWakeIssueIds = strandedRecoveryWakeBackstop.issueIds;

    // Also independent of liveness findings, and for the same reason: this only retires an
    // already-committed action that has stopped waking anyone, so it must keep running when
    // automatic liveness escalation is disabled. It is the pass that stops a spent recovery
    // from reading as healthy (BLO-24662).
    const expiredHorizons = await reconcileExpiredRecoveryWakeHorizons({
      runId: opts?.runId ?? null,
      now,
    });
    result.expiredRecoveryHorizonsEscalated = expiredHorizons.escalated;
    result.expiredRecoveryHorizonsAnnounced = expiredHorizons.announced;
    result.expiredRecoveryHorizonIssueIds = expiredHorizons.issueIds;

    if (!autoRecoveryEnabled) {
      result.skippedAutoRecoveryDisabled = findings.length;
      return result;
    }

    for (const finding of findings) {
      if (!isLivenessFindingStaleEnoughForEscalation(finding, staleAt, activityByIssueKey)) {
        // Field name preserved for back-compat with existing telemetry/dashboards.
        result.skippedOutsideLookback += 1;
        result.skipped += 1;
        continue;
      }
      const escalation = await createIssueGraphLivenessEscalation({
        finding,
        runId: opts?.runId ?? null,
        now,
        reescalationCooldownMs,
        unchangedTargetSuppressionMs,
      });
      if (escalation.kind === "created") {
        result.escalationsCreated += 1;
        result.issueIds.push(finding.issueId);
        result.escalationIssueIds.push(escalation.escalationIssueId);
      } else if (escalation.kind === "existing") {
        result.existingEscalations += 1;
        result.issueIds.push(finding.issueId);
        result.escalationIssueIds.push(escalation.escalationIssueId);
      } else if (escalation.kind === "suppressed") {
        // `skippedReescalationCooldown` is the aggregate across BOTH suppressors
        // and is kept stable for existing dashboards; `skippedUnchangedTarget` is
        // the subset attributable to the target-state gate, so the true
        // cooldown-only count is the difference.
        result.skippedReescalationCooldown += 1;
        if (escalation.reason === "unchanged_target") result.skippedUnchangedTarget += 1;
        result.skipped += 1;
      } else {
        result.skipped += 1;
      }
    }

    return result;
  }

  function readRecoveryTimerIntervalMs(raw: unknown, fallback: number) {
    return Math.max(1, Math.floor(asNumber(raw, fallback)));
  }

  // Surface a pool that never recovered within the ccrotate auto-retry budget
  // (PEN-382). Coalesced per (company, ccrotate target): a pool outage exhausts
  // many agents' retries at once, so the escalation is keyed on the target —
  // one open issue per pool, not one per cancelled run.
  async function escalateCcrotateCapacityExhausted(input: {
    companyId: string;
    ccrotateTarget: string;
    agentId: string;
    agentName: string | null;
    runId: string;
    attempts: number;
  }): Promise<{ kind: "created" | "coalesced"; issueId: string }> {
    const originId = input.ccrotateTarget;
    const findOpen = () =>
      db
        .select({ id: issues.id })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, input.companyId),
            eq(issues.originKind, RECOVERY_ORIGIN_KINDS.ccrotateCapacityExhausted),
            eq(issues.originId, originId),
            isNull(issues.hiddenAt),
            notInArray(issues.status, ["done", "cancelled"]),
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null);

    const existing = await findOpen();
    if (existing) return { kind: "coalesced", issueId: existing.id };

    const agentLabel = input.agentName
      ? `${input.agentName} (${input.agentId})`
      : input.agentId;
    try {
      const created = await issuesSvc.create(input.companyId, {
        title: `ccrotate pool exhausted — ${input.ccrotateTarget}`,
        description: [
          `The ccrotate capacity pool **${input.ccrotateTarget}** did not recover within the auto-retry budget.`,
          "",
          `- Agent: ${agentLabel}`,
          `- Cancelled run: ${input.runId}`,
          `- Retry attempts before giving up: ${input.attempts}`,
          "",
          "Agent runs are deferring and then cancelling because no account in this pool has usable capacity and none reported a future reset within the retry window. This usually needs a ccrotate token refresh / capacity top-up rather than agent action. This issue is coalesced per pool, so it represents the whole outage rather than a single run — mark it done once the pool recovers.",
        ].join("\n"),
        status: "todo",
        priority: "high",
        originKind: RECOVERY_ORIGIN_KINDS.ccrotateCapacityExhausted,
        originId,
      });
      return { kind: "created", issueId: created.id };
    } catch (error) {
      // Lost the check-then-create race to a concurrent exhaustion of the same
      // pool. The partial unique index issues_active_ccrotate_capacity_exhaustion_uq
      // guarantees only one open escalation per (company, target), so coalesce
      // onto whoever won the insert rather than surfacing the conflict. PEN-382.
      const conflict = unwrapDatabaseConflictError(error);
      const isDedupeConflict =
        conflict?.code === "23505" &&
        (conflict.constraint === "issues_active_ccrotate_capacity_exhaustion_uq" ||
          (typeof conflict.message === "string" &&
            conflict.message.includes("issues_active_ccrotate_capacity_exhaustion_uq")));
      if (!isDedupeConflict) throw error;
      const winner = await findOpen();
      if (winner) return { kind: "coalesced", issueId: winner.id };
      throw error;
    }
  }

  async function closeRecoveredCcrotateCapacityEscalations(input: {
    companyId: string;
    ccrotateTarget: string;
    runId: string;
    now: Date;
  }): Promise<{ closed: number; issueIds: string[] }> {
    const openEscalations = await db
      .select({ id: issues.id })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, input.companyId),
          eq(issues.originKind, RECOVERY_ORIGIN_KINDS.ccrotateCapacityExhausted),
          eq(issues.originId, input.ccrotateTarget),
          isNull(issues.hiddenAt),
          notInArray(issues.status, ["done", "cancelled"]),
        ),
      );

    const issueIds = openEscalations.map((issue) => issue.id);
    if (issueIds.length === 0) return { closed: 0, issueIds: [] };

    const closedIssueIds: string[] = [];
    for (const issueId of issueIds) {
      const updated = await db
        .update(issues)
        .set({
          status: "done",
          completedAt: input.now,
          cancelledAt: null,
          checkoutRunId: null,
          executionRunId: null,
          executionAgentNameKey: null,
          executionLockedAt: null,
          updatedAt: input.now,
        })
        .where(
          and(
            eq(issues.id, issueId),
            eq(issues.companyId, input.companyId),
            eq(issues.originKind, RECOVERY_ORIGIN_KINDS.ccrotateCapacityExhausted),
            eq(issues.originId, input.ccrotateTarget),
            isNull(issues.hiddenAt),
            notInArray(issues.status, ["done", "cancelled"]),
          ),
        )
        .returning({ id: issues.id })
        .then((rows) => rows[0] ?? null);
      if (!updated) continue;
      closedIssueIds.push(issueId);

      await issuesSvc.addComment(
        issueId,
        [
          "ccrotate pool recovered; closing stale capacity escalation.",
          "",
          `- Target: ${input.ccrotateTarget}`,
          `- Recovery run: \`${input.runId}\``,
          `- Recovered at: ${input.now.toISOString()}`,
        ].join("\n"),
        { runId: input.runId },
      );

      await logActivity(db, {
        companyId: input.companyId,
        actorType: "system",
        actorId: "system",
        agentId: null,
        runId: input.runId,
        action: "issue.ccrotate_capacity_recovered",
        entityType: "issue",
        entityId: issueId,
        details: {
          source: "recovery.close_recovered_ccrotate_capacity_escalations",
          ccrotateTarget: input.ccrotateTarget,
        },
      });
    }

    return { closed: closedIssueIds.length, issueIds: closedIssueIds };
  }

  // Backstop sweeper: clears stale lock columns on issues whose checkoutRunId
  // or executionRunId points at a heartbeat_runs row that is either missing or
  // in a terminal status. Provides self-heal for stale locks that fell outside
  // releaseIssueExecutionAndPromote / clearCheckoutRunIfTerminal / adoption.
  // Idempotent and safe: clears at most one row's worth of lock columns per
  // candidate, and only when the referenced run row is unambiguously terminal.
  async function sweepStaleIssueLocks() {
    const result = {
      cleared: 0,
      issueIds: [] as string[],
      // BLO-22060: the sweep revalidates every candidate under FOR UPDATE and
      // bails out silently when the lock moved between the scan and the
      // transaction. That is correct — but it was also invisible, so a renewal
      // landing repeatedly on the sweep's own cadence (30s) could starve the
      // clear indefinitely and look identical to "nothing was stale". Count the
      // bailouts so the starvation is observable in the sweep result and in the
      // log line below.
      skippedByConcurrentLockChange: 0,
      skippedByConcurrentLockChangeIssueIds: [] as string[],
    };

    const candidates = await db
      .select({
        id: issues.id,
        companyId: issues.companyId,
        assigneeAgentId: issues.assigneeAgentId,
        responsibleUserId: issues.responsibleUserId,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
        executionLockedAt: issues.executionLockedAt,
      })
      .from(issues)
      .where(
        sql`(${issues.checkoutRunId} is not null or ${issues.executionRunId} is not null)`,
      );

    const referencedRunIds = [
      ...new Set(
        candidates
          .flatMap((issue) => [issue.checkoutRunId, issue.executionRunId])
          .filter((id): id is string => !!id),
      ),
    ];
    const runRows =
      referencedRunIds.length > 0
        ? await db
            .select({
              id: heartbeatRuns.id,
              status: heartbeatRuns.status,
              scheduledRetryAt: heartbeatRuns.scheduledRetryAt,
              scheduledRetryReason: heartbeatRuns.scheduledRetryReason,
              startedAt: heartbeatRuns.startedAt,
              lastOutputAt: heartbeatRuns.lastOutputAt,
              lastUsefulActionAt: heartbeatRuns.lastUsefulActionAt,
            })
            .from(heartbeatRuns)
            .where(inArray(heartbeatRuns.id, referencedRunIds))
        : [];
    const runById = new Map<string, {
      status: string;
      scheduledRetryAt: Date | null;
      scheduledRetryReason: string | null;
      startedAt: Date | null;
      lastOutputAt: Date | null;
      lastUsefulActionAt: Date | null;
    }>();
    for (const row of runRows) runById.set(row.id, row);

    const isCleanable = (runId: string | null) => {
      if (!runId) return true;
      const run = runById.get(runId);
      if (!run) return true; // missing run row → no real claim
      return TERMINAL_HEARTBEAT_RUN_STATUSES.has(run.status);
    };

    // BLO-18995: older deployments stamped executionRunId/executionLockedAt at
    // enqueue time. Keep cleaning those persisted pre-claim locks after the
    // writer paths move to claim-time locking; otherwise an upgraded instance
    // can retain a queued lock indefinitely.
    //
    // Bound it: once a pre-claim lock has been held longer than
    // STALE_PRE_CLAIM_ISSUE_LOCK_MS, treat it as cleanable. Clearing is safe
    // and does not cancel the run — claimQueuedRun's lock update is guarded by
    // `or(isNull(executionRunId), eq(executionRunId, claimed.id))`, so the run
    // simply re-acquires the lock if and when it is finally claimed, and the
    // per-issue dedupe in startNextQueuedRunForAgent still prevents two runs
    // for one issue from executing concurrently.
    const isPreClaimLockExpired = (runId: string | null, lockedAt: Date | null) => {
      if (!runId || !lockedAt) return false;
      const run = runById.get(runId);
      if (run?.status === "queued") {
        return Date.now() - lockedAt.getTime() >= STALE_PRE_CLAIM_ISSUE_LOCK_MS;
      }
      if (run?.status === "scheduled_retry") {
        // BLO-19848: these retry kinds must retain issue.executionRunId through
        // promotion, so for them clearing is NOT a safe reacquire. heartbeat.ts
        // gates them on the lock at promotion (requiresIssueExecutionRetryLock,
        // ~13281) and again in the pre-start staleness check (~15124), where a
        // changed executionRunId cancels the run outright with
        // `issue_execution_lock_changed`. Clearing here would therefore destroy
        // a max-turns continuation rather than delay it. Keep the lock and let
        // the promotion path own the lifecycle.
        //
        // This guard is why the "clearing early is always safe" reasoning below
        // is scoped to the reasons that survive losing the lock.
        if (
          SCHEDULED_RETRY_REASONS_REQUIRING_CONTINUOUS_ISSUE_LOCK.has(
            run.scheduledRetryReason ?? "",
          )
        ) {
          return false;
        }
        // BLO-21309: measured from `lockedAt`, exactly like the `queued` branch
        // above — NOT from `scheduledRetryAt`.
        //
        // This used to key off `run.scheduledRetryAt ?? lockedAt`, on the theory
        // that a parked retry holds a legitimate future claim and should keep its
        // lock until that deadline goes stale. But `scheduledRetryAt` is set from
        // the *provider's* capacity-reset horizon, so a `ccrotate_capacity` retry
        // is routinely parked days out — and since the basis was in the future,
        // `now - basis` was negative and this returned false for the entire park.
        // Effective lock lifetime became `scheduledRetryAt + 6h` rather than 6h.
        //
        // Nothing else could release it either: `scheduled_retry` is not in
        // TERMINAL_HEARTBEAT_RUN_STATUSES, so isCleanable(), clearStaleExecutionLock()
        // and clearCheckoutRunIfTerminal() all decline, and every route that can
        // force a release is board-only. Net effect on BLO-20983: the *assignee*
        // could not set status or re-arm its own monitor for ~4 days, from a live
        // run, while `executionState` reported `idle` and `activeRun` was null.
        //
        // Clearing early is safe for the remaining reasons, and for the same
        // reason the `queued` case is: promoteDueScheduledRetry's UPDATE is
        // conditioned only on the run row (`status='scheduled_retry' and
        // scheduledRetryAt <= now`) and never reads the issue lock, and
        // claimQueuedRun re-stamps under
        // `or(isNull(executionRunId), eq(executionRunId, claimed.id))` — so the
        // retry still fires and simply re-acquires. If a fresh run has taken the
        // issue in the meantime, the retry declines to claim and is cancelled,
        // which is the correct outcome: live work outranks a days-old continuation.
        return Date.now() - lockedAt.getTime() >= STALE_PRE_CLAIM_ISSUE_LOCK_MS;
      }
      return false;
    };

    // BLO-19941: the `running` counterpart. Keyed on the run's own most-recent
    // genuine activity, never on executionLockedAt (a healthy long run holds an
    // old lock) and never on updatedAt (churn-renewable, BLO-8827). Clearing is
    // non-destructive in exactly the same way as the pre-claim case: the run row
    // is left alone, releaseIssueExecutionAndPromote's write is guarded by
    // `eq(executionRunId, run.id)` so a late finish cannot stomp a new holder,
    // and a fresh claim re-stamps under `or(isNull, eq(self))`.
    // Returns the timestamp the `running` bound is measured from, or null when
    // the holder is not a `running` run at all.
    const runningLockStaleBasis = (runId: string | null, lockedAt: Date | null) => {
      if (!runId) return null;
      const run = runById.get(runId);
      if (run?.status !== "running") return null;
      // A `running` row that has not stamped any signal yet is anomalous, but it
      // is also the shape of a run mid-claim, so fall back to the lock timestamp
      // rather than clearing a lock that was taken seconds ago.
      return latestRunActivityAt(
        run.lastUsefulActionAt,
        run.lastOutputAt,
        run.startedAt,
      ) ?? lockedAt;
    };
    const isRunningLockSilent = (runId: string | null, lockedAt: Date | null) => {
      const basis = runningLockStaleBasis(runId, lockedAt);
      if (!basis) return false;
      return Date.now() - basis.getTime() >= STALE_RUNNING_ISSUE_LOCK_MS;
    };

    // BLO-30087: silence alone is no longer sufficient evidence that a `running`
    // holder is dead. PR #1465 taught the hard-stale reaper to SPARE a run whose
    // pod is demonstrably burning CPU, up to AGENT_POD_BUSY_MAX_STALE_MS (3h) —
    // but that probe is a read at decision time and writes no activity column,
    // so lastOutputAt / lastUsefulActionAt stay frozen at the original silence
    // timestamp. This sweeper reads exactly those frozen columns.
    //
    // Net effect before this guard: between STALE_RUNNING_ISSUE_LOCK_MS (2h) and
    // AGENT_POD_BUSY_MAX_STALE_MS (3h) the reaper kept the run alive while the
    // sweeper freed its issue lock. A sibling then took a legitimate clean
    // acquire on an issue whose holder was still writing, and in
    // `shared_workspace` mode both runs held the same cwd — two live writers
    // interleaving into one file. Before #1465 the 45min reaper always killed
    // first, so the state was unreachable and the reaper was an accidental
    // mutual-exclusion backstop. Extending the liveness signal to this consumer
    // is what replaces it.
    //
    // Fails CLOSED, matching #1465's own posture: only positive "busy" evidence
    // spares a lock. With no metrics-server every probe returns "unknown" and
    // behaviour is byte-for-byte pre-change.
    //
    // The probe is memoized per run and performed HERE, in the pre-transaction
    // candidate scan. The in-transaction revalidation below reads the memo
    // synchronously — issuing a k8s metrics call inside `db.transaction` would
    // hold a Postgres transaction open across a network round-trip.
    const busySparedByRunId = new Map<string, boolean>();
    const isBusySparedRunningHolder = async (runId: string | null, lockedAt: Date | null) => {
      if (!runId) return false;
      const basis = runningLockStaleBasis(runId, lockedAt);
      if (!basis) return false;
      const silentMs = Date.now() - basis.getTime();
      // Only holders that have actually crossed the sweeper's bound matter here;
      // anything younger is kept by the bound itself and must not cost a probe.
      if (silentMs < STALE_RUNNING_ISSUE_LOCK_MS) return false;
      const memoized = busySparedByRunId.get(runId);
      if (memoized !== undefined) return memoized;
      // Past the shared ceiling a busy pod is a CPU-burning zombie and loses its
      // lock regardless, exactly as the reaper kills it regardless — so the
      // BLO-19941 reclamation guarantee still has a bound.
      const spared = silentMs < AGENT_POD_BUSY_MAX_STALE_MS
        && (await probeAgentPodActivity(runId)) === "busy";
      busySparedByRunId.set(runId, spared);
      if (spared) {
        logger.info(
          { runId, silentMs, staleBoundMs: STALE_RUNNING_ISSUE_LOCK_MS, ceilingMs: AGENT_POD_BUSY_MAX_STALE_MS },
          "sweepStaleIssueLocks: keeping issue lock — holder pod is executing a live subprocess (BLO-30087)",
        );
      }
      return spared;
    };

    for (const issue of candidates) {
      const runningLockSilent = isRunningLockSilent(
        issue.executionRunId,
        issue.executionLockedAt,
      ) && !(await isBusySparedRunningHolder(
        issue.executionRunId,
        issue.executionLockedAt,
      ));
      // BLO-21309: distinguishes a parked-retry release from an unclaimed-`queued`
      // release in the audit trail below. Both go through the same 6h bound, but
      // only this one implies a provider-capacity park whose `scheduledRetryAt`
      // may still be days out, so an operator reading `issue.stale_lock_cleared`
      // can tell that the retry is expected to re-acquire later.
      const parkedRetryLockExpired = issue.executionRunId != null
        && runById.get(issue.executionRunId)?.status === "scheduled_retry"
        && isPreClaimLockExpired(issue.executionRunId, issue.executionLockedAt);
      const executionLockExpired = isPreClaimLockExpired(
        issue.executionRunId,
        issue.executionLockedAt,
      ) || runningLockSilent;
      // sweep a no-op for exactly the case it needs to cover.
      //
      // BLO-19566 extends that allowance from `running`-silent to the pre-claim
      // (`queued`) case, which BLO-19941 deliberately left out. The exclusion
      // made the BLO-18995 pre-claim path dead code for every issue checked out
      // the normal way, because checkout stamps both columns at once.
      //
      // BLO-19848 applies the same reasoning to `scheduled_retry`: a retry
      // deadline can be parked far into the future, and if checkoutRunId and
      // executionRunId both point at that same expired holder, the checkout guard
      // would otherwise keep the issue wedged forever.
      //
      // The same-run-id restriction is what keeps this narrow. A different live
      // checkout holder still keeps its lock no matter how stale the execution
      // lock is, while a late claim by the expired run can re-acquire through the
      // usual `or(isNull(executionRunId), eq(executionRunId, self))` guard.
      const checkoutHeldBySameExpiredRun = executionLockExpired
        && issue.checkoutRunId != null
        && issue.checkoutRunId === issue.executionRunId;
      // Guards are kept separate on purpose. The update below nulls the
      // checkout *and* execution columns together, so the expiry allowance must
      // not become a blanket bypass of the checkout check.
      if (!isCleanable(issue.checkoutRunId) && !checkoutHeldBySameExpiredRun) continue;
      if (!isCleanable(issue.executionRunId) && !executionLockExpired) continue;

      const sweepOutcome = await db.transaction(async (tx) => {
        await deps.beforeStaleIssueLockSweepClearForTest?.(issue);

        const currentIssue = await tx
          .select({
            id: issues.id,
            companyId: issues.companyId,
            assigneeAgentId: issues.assigneeAgentId,
            responsibleUserId: issues.responsibleUserId,
            checkoutRunId: issues.checkoutRunId,
            executionRunId: issues.executionRunId,
            executionLockedAt: issues.executionLockedAt,
          })
          .from(issues)
          .where(eq(issues.id, issue.id))
          .for("update")
          .then((rows) => rows[0] ?? null);

        if (!currentIssue) return null;
        // BLO-22060: concurrent-bump bailouts — the lock moved between the
        // pre-transaction scan and this revalidation. Report them distinctly
        // from "revalidated and found not stale" (plain null below) so a lock
        // that keeps being renewed under the sweep is visible rather than
        // indistinguishable from a quiet pass.
        if (currentIssue.checkoutRunId !== issue.checkoutRunId) return LOCK_CHANGED_UNDER_SWEEP;
        if (currentIssue.executionRunId !== issue.executionRunId) return LOCK_CHANGED_UNDER_SWEEP;
        if ((currentIssue.executionLockedAt?.getTime() ?? null) !== (issue.executionLockedAt?.getTime() ?? null)) {
          return LOCK_CHANGED_UNDER_SWEEP;
        }

        const currentReferencedRunIds = [
          ...new Set(
            [currentIssue.checkoutRunId, currentIssue.executionRunId]
              .filter((id): id is string => !!id),
          ),
        ];
        const currentRunRows =
          currentReferencedRunIds.length > 0
            ? await tx
                .select({
                  id: heartbeatRuns.id,
                  status: heartbeatRuns.status,
                  scheduledRetryAt: heartbeatRuns.scheduledRetryAt,
                  scheduledRetryReason: heartbeatRuns.scheduledRetryReason,
                  startedAt: heartbeatRuns.startedAt,
                  lastOutputAt: heartbeatRuns.lastOutputAt,
                  lastUsefulActionAt: heartbeatRuns.lastUsefulActionAt,
                })
                .from(heartbeatRuns)
                .where(inArray(heartbeatRuns.id, currentReferencedRunIds))
                .for("update")
            : [];
        const currentRunById = new Map<string, {
          status: string;
          scheduledRetryAt: Date | null;
          scheduledRetryReason: string | null;
          startedAt: Date | null;
          lastOutputAt: Date | null;
          lastUsefulActionAt: Date | null;
        }>();
        for (const row of currentRunRows) currentRunById.set(row.id, row);

        const currentIsCleanable = (runId: string | null) => {
          if (!runId) return true;
          const run = currentRunById.get(runId);
          if (!run) return true;
          return TERMINAL_HEARTBEAT_RUN_STATUSES.has(run.status);
        };
        const currentPreClaimLockExpired = (runId: string | null, lockedAt: Date | null) => {
          if (!runId || !lockedAt) return false;
          const run = currentRunById.get(runId);
          if (run?.status === "queued") {
            return Date.now() - lockedAt.getTime() >= STALE_PRE_CLAIM_ISSUE_LOCK_MS;
          }
          if (run?.status === "scheduled_retry") {
            // Mirror of isPreClaimLockExpired — keep both in sync. See the full
            // rationale there (BLO-19848 lock-required guard, BLO-21309 basis).
            if (
              SCHEDULED_RETRY_REASONS_REQUIRING_CONTINUOUS_ISSUE_LOCK.has(
                run.scheduledRetryReason ?? "",
              )
            ) {
              return false;
            }
            return Date.now() - lockedAt.getTime() >= STALE_PRE_CLAIM_ISSUE_LOCK_MS;
          }
          return false;
        };
        const currentRunningLockStaleBasis = (runId: string | null, lockedAt: Date | null) => {
          if (!runId) return null;
          const run = currentRunById.get(runId);
          if (run?.status !== "running") return null;
          // Newest signal, not first non-null — see latestRunActivityAt.
          return latestRunActivityAt(
            run.lastUsefulActionAt,
            run.lastOutputAt,
            run.startedAt,
          ) ?? lockedAt;
        };
        const currentRunningLockSilent = (runId: string | null, lockedAt: Date | null) => {
          const basis = currentRunningLockStaleBasis(runId, lockedAt);
          if (!basis) return false;
          if (Date.now() - basis.getTime() < STALE_RUNNING_ISSUE_LOCK_MS) return false;
          // BLO-30087: mirror of the busy-pod spare in the pre-transaction scan.
          // Reads the memo rather than probing, so this stays synchronous and no
          // k8s round-trip happens while this transaction holds `issues` and
          // `heartbeat_runs` FOR UPDATE. Safe to key by runId alone: the
          // concurrent-bump bailouts above already guarantee
          // currentIssue.executionRunId === issue.executionRunId here.
          if (runId && busySparedByRunId.get(runId) === true) return false;
          return true;
        };
        const currentExecutionLockExpired = currentPreClaimLockExpired(
          currentIssue.executionRunId,
          currentIssue.executionLockedAt,
        ) || currentRunningLockSilent(
          currentIssue.executionRunId,
          currentIssue.executionLockedAt,
        );
        const currentCheckoutHeldBySameExpiredRun = currentExecutionLockExpired
          && currentIssue.checkoutRunId != null
          && currentIssue.checkoutRunId === currentIssue.executionRunId;
        if (!currentIsCleanable(currentIssue.checkoutRunId) && !currentCheckoutHeldBySameExpiredRun) {
          return null;
        }
        if (!currentIsCleanable(currentIssue.executionRunId) && !currentExecutionLockExpired) {
          return null;
        }

        const clearedAt = new Date();
        const detachedQueuedRunId = currentIssue.executionRunId
          && currentRunById.get(currentIssue.executionRunId)?.status === "queued"
          && currentPreClaimLockExpired(currentIssue.executionRunId, currentIssue.executionLockedAt)
          ? currentIssue.executionRunId
          : null;
        const updated = await tx
          .update(issues)
          .set({
            checkoutRunId: null,
            executionRunId: null,
            executionAgentNameKey: null,
            executionLockedAt: null,
            updatedAt: clearedAt,
          })
          .where(
            and(
              eq(issues.id, currentIssue.id),
              currentIssue.checkoutRunId
                ? eq(issues.checkoutRunId, currentIssue.checkoutRunId)
                : isNull(issues.checkoutRunId),
              currentIssue.executionRunId
                ? eq(issues.executionRunId, currentIssue.executionRunId)
                : isNull(issues.executionRunId),
              currentIssue.executionLockedAt
                ? eq(issues.executionLockedAt, currentIssue.executionLockedAt)
                : isNull(issues.executionLockedAt),
            ),
          )
          .returning({
            id: issues.id,
            companyId: issues.companyId,
            assigneeAgentId: issues.assigneeAgentId,
            responsibleUserId: issues.responsibleUserId,
          })
          .then((rows) => rows[0] ?? null);

        if (!updated) return LOCK_CHANGED_UNDER_SWEEP;

        // BLO-22060: the release must outlive the issue row we just nulled.
        // The run itself is deliberately left alive (a `scheduled_retry` park
        // still has to fire at its deadline, and a `queued` run must stay
        // claimable), and enqueueWakeup's legacy-run fallback would otherwise
        // re-adopt that same run and re-stamp executionLockedAt, restarting the
        // 6h clock on every wake. Recording the release on the run is what lets
        // adoption decline. Counted for whatever status held the lock — the
        // fallback can select `queued`, `running` and `scheduled_retry` alike,
        // and a released park that is later promoted reaches it as `queued`.
        if (currentIssue.executionRunId) {
          await tx
            .update(heartbeatRuns)
            .set({
              issueLockReleaseCount: sql`${heartbeatRuns.issueLockReleaseCount} + 1`,
              updatedAt: clearedAt,
            })
            .where(eq(heartbeatRuns.id, currentIssue.executionRunId));
        }

        // BLO-21621: clearing a stale pre-claim lock is the only positive
        // evidence that a queued row previously owned, and then lost, this
        // issue lock. Persist that lineage in the same transaction as the
        // release. The detached-run reconciler must never infer this state from
        // old age plus NULL issue pointers because that is also the normal
        // lazy-lock backlog shape.
        if (detachedQueuedRunId) {
          await tx
            .insert(detachedQueuedRunRecoveries)
            .values({
              companyId: updated.companyId,
              issueId: updated.id,
              sourceRunId: detachedQueuedRunId,
              status: "detached",
              detachedAt: clearedAt,
              updatedAt: clearedAt,
            })
            .onConflictDoNothing({ target: detachedQueuedRunRecoveries.sourceRunId });
        }

        const skippedDeferredWakeIds: string[] = [];

        while (true) {
          const deferred = await tx
            .select()
            .from(agentWakeupRequests)
            .where(
              and(
                eq(agentWakeupRequests.companyId, updated.companyId),
                eq(agentWakeupRequests.status, "deferred_issue_execution"),
                sql`(
                  ${agentWakeupRequests.payload} ->> 'issueId' = ${updated.id}
                  or ${agentWakeupRequests.payload} ->> 'taskId' = ${updated.id}
                  or ${agentWakeupRequests.payload} -> '_paperclipWakeContext' ->> 'issueId' = ${updated.id}
                  or ${agentWakeupRequests.payload} -> '_paperclipWakeContext' ->> 'taskId' = ${updated.id}
                )`,
              ),
            )
            .orderBy(asc(agentWakeupRequests.requestedAt), asc(agentWakeupRequests.id))
            .limit(1)
            .for("update")
            .then((rows) => rows[0] ?? null);

          if (!deferred) {
            return {
              updated,
              promotedRunId: null,
              promotedWakeId: null,
              promotedAgentId: null,
              skippedDeferredWakeIds,
            };
          }

          const deferredAgent = await tx
            .select({
              id: agents.id,
              companyId: agents.companyId,
              name: agents.name,
              reportsTo: agents.reportsTo,
              status: agents.status,
              adapterType: agents.adapterType,
            })
            .from(agents)
            .where(eq(agents.id, deferred.agentId))
            .then((rows) => rows[0] ?? null);
          const companyAgents = deferredAgent
            ? await tx
              .select({
                id: agents.id,
                companyId: agents.companyId,
                name: agents.name,
                reportsTo: agents.reportsTo,
                status: agents.status,
              })
              .from(agents)
              .where(eq(agents.companyId, updated.companyId))
            : [];
          const invokability =
            deferredAgent?.companyId === updated.companyId
              ? evaluateAgentInvokability(deferredAgent, companyAgents)
              : evaluateAgentInvokability(null, companyAgents);

          if (!deferredAgent || deferredAgent.companyId !== updated.companyId || !invokability.invokable) {
            const now = new Date();
            skippedDeferredWakeIds.push(deferred.id);
            await tx
              .update(agentWakeupRequests)
              .set({
                status: "failed",
                finishedAt: now,
                error: "Deferred wake could not be promoted: agent is not invokable",
                updatedAt: now,
              })
              .where(eq(agentWakeupRequests.id, deferred.id));
            continue;
          }

          const deferredPayload = { ...parseObject(deferred.payload) };
          const deferredContextSeed = {
            ...parseObject(deferredPayload[DEFERRED_WAKE_CONTEXT_KEY]),
          };
          delete deferredPayload[DEFERRED_WAKE_CONTEXT_KEY];

          const activePauseHold = await treeControlSvc.getActivePauseHoldGate(
            updated.companyId,
            updated.id,
            tx,
          );
          const treeHoldInteractionWake = activePauseHold && await isVerifiedIssueTreeControlInteractionWake(tx, {
            companyId: updated.companyId,
            issueId: updated.id,
            agentId: deferred.agentId,
            contextSnapshot: deferredContextSeed,
            requestedByActorType: deferred.requestedByActorType,
            requestedByActorId: deferred.requestedByActorId,
            wakeupRequestId: deferred.id,
          });
          if (activePauseHold && !treeHoldInteractionWake) {
            const now = new Date();
            skippedDeferredWakeIds.push(deferred.id);
            await tx
              .update(agentWakeupRequests)
              .set({
                status: "cancelled",
                finishedAt: now,
                error: "Deferred wake suppressed by active subtree pause hold",
                updatedAt: now,
              })
              .where(eq(agentWakeupRequests.id, deferred.id));
            continue;
          }

          const promotedReason = readNonEmptyString(deferred.reason) ?? "issue_execution_promoted";
          const promotedSource = readNonEmptyString(deferred.source) ?? "automation";
          const promotedTriggerDetail = readNonEmptyString(deferred.triggerDetail);
          const promotedContextSnapshot: Record<string, unknown> = { ...deferredContextSeed };
          if (activePauseHold) {
            promotedContextSnapshot.treeHoldInteraction = true;
            promotedContextSnapshot.activeTreeHold = {
              holdId: activePauseHold.holdId,
              rootIssueId: activePauseHold.rootIssueId,
              mode: activePauseHold.mode,
              reason: activePauseHold.reason,
              releasePolicy: activePauseHold.releasePolicy,
              interaction: true,
            };
          }
          if (!readNonEmptyString(promotedContextSnapshot.issueId)) {
            promotedContextSnapshot.issueId = updated.id;
          }
          if (!readNonEmptyString(promotedContextSnapshot.taskId)) {
            promotedContextSnapshot.taskId = updated.id;
          }
          if (!readNonEmptyString(promotedContextSnapshot.wakeReason)) {
            promotedContextSnapshot.wakeReason = promotedReason;
          }
          if (!readNonEmptyString(promotedContextSnapshot.wakeSource)) {
            promotedContextSnapshot.wakeSource = promotedSource;
          }
          if (
            promotedTriggerDetail &&
            !readNonEmptyString(promotedContextSnapshot.wakeTriggerDetail)
          ) {
            promotedContextSnapshot.wakeTriggerDetail = promotedTriggerDetail;
          }
          if (
            readNonEmptyString(deferredPayload.commentId) &&
            !readNonEmptyString(promotedContextSnapshot.commentId)
          ) {
            promotedContextSnapshot.commentId = deferredPayload.commentId;
          }
          if (
            readNonEmptyString(deferredPayload.taskKey) &&
            !readNonEmptyString(promotedContextSnapshot.taskKey)
          ) {
            promotedContextSnapshot.taskKey = deferredPayload.taskKey;
          }

          const now = new Date();
          const promotedRetryOfRunId = readNonEmptyString(promotedContextSnapshot.retryOfRunId);
          const promotedScheduledRetryAttempt = promotedContextSnapshot.scheduledRetryAttempt;
          if (
            readNonEmptyString(promotedContextSnapshot.retryReason) ===
            ZERO_TOKEN_SESSION_RESET_RETRY_REASON
          ) {
            const latestIssueRunId = await tx
              .select({ id: heartbeatRuns.id })
              .from(heartbeatRuns)
              .where(
                and(
                  eq(heartbeatRuns.companyId, updated.companyId),
                  sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${updated.id}`,
                ),
              )
              .orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id))
              .limit(1)
              .then((rows) => rows[0]?.id ?? null);
            if (!promotedRetryOfRunId || latestIssueRunId !== promotedRetryOfRunId) {
              skippedDeferredWakeIds.push(deferred.id);
              await tx
                .update(agentWakeupRequests)
                .set({
                  status: "cancelled",
                  finishedAt: now,
                  error: "Deferred session reset was superseded by newer issue execution",
                  updatedAt: now,
                })
                .where(eq(agentWakeupRequests.id, deferred.id));
              continue;
            }
            await tx
              .delete(agentTaskSessions)
              .where(
                and(
                  eq(agentTaskSessions.companyId, updated.companyId),
                  eq(agentTaskSessions.agentId, deferredAgent.id),
                  eq(
                    agentTaskSessions.taskKey,
                    readNonEmptyString(promotedContextSnapshot.taskKey) ?? updated.id,
                  ),
                  eq(agentTaskSessions.adapterType, deferredAgent.adapterType),
                ),
              );
          }
          const newRun = await tx
            .insert(heartbeatRuns)
            .values({
              companyId: deferredAgent.companyId,
              agentId: deferredAgent.id,
              invocationSource: promotedSource,
              triggerDetail: promotedTriggerDetail,
              status: "queued",
              wakeupRequestId: deferred.id,
              contextSnapshot: promotedContextSnapshot,
              responsibleUserId: updated.responsibleUserId,
              retryOfRunId: promotedRetryOfRunId,
              scheduledRetryAttempt:
                typeof promotedScheduledRetryAttempt === "number" &&
                Number.isInteger(promotedScheduledRetryAttempt) &&
                promotedScheduledRetryAttempt >= 0
                  ? promotedScheduledRetryAttempt
                  : undefined,
              updatedAt: now,
            })
            .returning({ id: heartbeatRuns.id })
            .then((rows) => rows[0]);

          const promotedWake = await tx
            .update(agentWakeupRequests)
            .set({
              status: "queued",
              reason: "issue_execution_promoted",
              runId: newRun.id,
              claimedAt: null,
              finishedAt: null,
              error: null,
              updatedAt: now,
            })
            .where(
              and(
                eq(agentWakeupRequests.id, deferred.id),
                eq(agentWakeupRequests.status, "deferred_issue_execution"),
              ),
            )
            .returning({ id: agentWakeupRequests.id })
            .then((rows) => rows[0] ?? null);

          if (!promotedWake) {
            await tx.delete(heartbeatRuns).where(eq(heartbeatRuns.id, newRun.id));
            skippedDeferredWakeIds.push(deferred.id);
            continue;
          }

          return {
            updated,
            promotedRunId: newRun.id,
            promotedWakeId: deferred.id,
            promotedAgentId: deferredAgent.id,
            skippedDeferredWakeIds,
          };
        }
      });

      if (sweepOutcome === LOCK_CHANGED_UNDER_SWEEP) {
        result.skippedByConcurrentLockChange += 1;
        result.skippedByConcurrentLockChangeIssueIds.push(issue.id);
        logger.warn(
          {
            issueId: issue.id,
            companyId: issue.companyId,
            executionRunId: issue.executionRunId,
            checkoutRunId: issue.checkoutRunId,
            scannedExecutionLockedAt: issue.executionLockedAt?.toISOString() ?? null,
          },
          "stale issue lock sweep skipped: lock changed between scan and clear",
        );
        continue;
      }
      if (!sweepOutcome) continue;
      const { updated } = sweepOutcome;

      result.cleared += 1;
      result.issueIds.push(updated.id);

      await logActivity(db, {
        companyId: issue.companyId,
        actorType: "system",
        actorId: "system",
        agentId: null,
        runId: null,
        action: "issue.stale_lock_cleared",
        entityType: "issue",
        entityId: updated.id,
        details: {
          source: "recovery.sweep_stale_issue_locks",
          clearedCheckoutRunId: issue.checkoutRunId,
          clearedExecutionRunId: issue.executionRunId,
          referencedRunStatuses: Object.fromEntries(
            [...runById.entries()].map(([id, run]) => [id, run.status]),
          ),
          promotedDeferredWakeId: sweepOutcome.promotedWakeId,
          promotedRunId: sweepOutcome.promotedRunId,
          promotedAgentId: sweepOutcome.promotedAgentId,
          skippedDeferredWakeIds: sweepOutcome.skippedDeferredWakeIds,
          // BLO-18995: distinguishes the original terminal/missing-run path from
          // the pre-claim lock timeout, so an operator reading the audit trail
          // can tell whether a lock was released because its run finished or
          // because it was never claimed within STALE_PRE_CLAIM_ISSUE_LOCK_MS.
          // BLO-19941 adds the third case: a holder wedged at `running`.
          reason: runningLockSilent
            ? "running_lock_silent"
            : parkedRetryLockExpired
            ? "parked_retry_lock_expired"
            : executionLockExpired
            ? "pre_claim_lock_expired"
            : "run_terminal_or_missing",
          ...(runningLockSilent
            ? {
              runningLockSilentMs: (() => {
                const basis = runningLockStaleBasis(
                  issue.executionRunId,
                  issue.executionLockedAt,
                );
                return basis ? Date.now() - basis.getTime() : null;
              })(),
              runningLockTimeoutMs: STALE_RUNNING_ISSUE_LOCK_MS,
            }
            : parkedRetryLockExpired
            ? {
              // The park is not cancelled by this release — surfacing the
              // horizon it will re-acquire at is the point (BLO-21309).
              parkedRetryLockHeldMs: issue.executionLockedAt
                ? Date.now() - issue.executionLockedAt.getTime()
                : null,
              parkedRetryLockTimeoutMs: STALE_PRE_CLAIM_ISSUE_LOCK_MS,
              parkedRetryScheduledRetryAt: issue.executionRunId
                ? runById.get(issue.executionRunId)?.scheduledRetryAt?.toISOString() ?? null
                : null,
            }
            : executionLockExpired
            ? {
              preClaimLockHeldMs: issue.executionLockedAt
                ? Date.now() - issue.executionLockedAt.getTime()
                : null,
              preClaimLockTimeoutMs: STALE_PRE_CLAIM_ISSUE_LOCK_MS,
            }
            : {}),
        },
      });
    }

    if (result.cleared > 0) {
      logger.warn(
        { cleared: result.cleared, issueIds: result.issueIds },
        "swept stale issue lock columns",
      );
    }

    return result;
  }

  // Self-review non-convergence escalation (BLO-13353 (b)). When a PR authored
  // by the reviewer bot keeps getting actionable self-review feedback without
  // converging, the author↔self-review loop can spin forever — a same-identity
  // self-review can't formally block, so nothing forces a resolution. Once the
  // caller (github-webhook) detects the Nth actionable reopen cycle, hand the
  // issue up the chain of command — manager agent first (reportsTo → creator →
  // CTO/CEO), board only when no agent is invokable (SKILL.md rule #1) — via a
  // recovery action + owner wake. Mirrors the stranded-recovery upsert+wake
  // flow; re-fetches the full issue row so the caller can pass just an id.
  async function escalateStalledSelfReviewPr(input: {
    issueId: string;
    prNumber: number;
    repoFullName: string | null;
    cycleCount: number;
  }): Promise<{ escalated: boolean; ownerAgentId: string | null; ownerType: "agent" | "board" }> {
    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, input.issueId))
      .then((rows) => rows[0] ?? null);
    if (!issue) return { escalated: false, ownerAgentId: null, ownerType: "board" };

    const resolvedOwnerAgentId = await resolveStrandedIssueRecoveryOwnerAgentId(issue);
    // resolveStrandedIssueRecoveryOwnerAgentId falls back to the current
    // assignee as its last candidate — correct for stranded-run recovery, but
    // here the assignee IS the looping author we're escalating away from.
    // Escalating back to them would just re-arm the loop, so if the only
    // invokable candidate is the assignee, go to the board instead.
    const ownerAgentId =
      resolvedOwnerAgentId && resolvedOwnerAgentId === issue.assigneeAgentId
        ? null
        : resolvedOwnerAgentId;
    const action = await recoveryActionsSvc.upsertSourceScoped({
      companyId: issue.companyId,
      sourceIssueId: issue.id,
      kind: "pr_review_non_convergence",
      ownerType: ownerAgentId ? "agent" : "board",
      ownerAgentId,
      previousOwnerAgentId: issue.assigneeAgentId,
      returnOwnerAgentId: issue.assigneeAgentId,
      cause: "self_review_pr_non_convergence",
      fingerprint: `pr_review_non_convergence:${issue.id}:${input.repoFullName ?? "unknown"}:${input.prNumber}`,
      evidence: {
        repoFullName: input.repoFullName,
        prNumber: input.prNumber,
        cycleCount: input.cycleCount,
        priorAssigneeAgentId: issue.assigneeAgentId,
      },
      nextAction: ownerAgentId
        ? `Self-reviewed PR #${input.prNumber} has cycled through review feedback ${input.cycleCount} times without converging. Take over the PR, unblock or reassign the author, or record a disposition — do not leave the author looping on its own self-review.`
        : `Self-reviewed PR #${input.prNumber} is not converging after ${input.cycleCount} review cycles and no invokable agent can own it. Board intervention needed.`,
      wakePolicy: ownerAgentId
        ? { type: "wake_owner", reason: "self_review_pr_non_convergence", ownerAgentId }
        : { type: "board_escalation", reason: "no_invokable_recovery_owner" },
      monitorPolicy: null,
      maxAttempts: null,
      lastAttemptAt: new Date(),
    });

    if (ownerAgentId) {
      await deps.enqueueWakeup(ownerAgentId, {
        source: "assignment",
        triggerDetail: "system",
        reason: "self_review_pr_non_convergence",
        idempotencyKey: `self_review_pr_non_convergence:${action.id}:${action.attemptCount}`,
        payload: {
          issueId: issue.id,
          sourceIssueId: issue.id,
          recoveryActionId: action.id,
          prNumber: input.prNumber,
          repoFullName: input.repoFullName,
          cycleCount: input.cycleCount,
        },
        requestedByActorType: "system",
        requestedByActorId: null,
        contextSnapshot: {
          issueId: issue.id,
          taskId: issue.id,
          wakeReason: "self_review_pr_non_convergence",
          source: "issue_recovery_action",
          recoveryActionId: action.id,
          sourceIssueId: issue.id,
          prNumber: input.prNumber,
        },
      });
    }

    return { escalated: true, ownerAgentId, ownerType: ownerAgentId ? "agent" : "board" };
  }

  return {
    escalateStalledSelfReviewPr,
    buildRunOutputSilence,
    closeRecoveredCcrotateCapacityEscalations,
    escalateCcrotateCapacityExhausted,
    escalateStrandedRecoveryIssueInPlace,
    escalateStrandedAssignedIssue,
    recordWatchdogDecision,
    scanSilentActiveRuns,
    dismissStaleEvaluationOnRunTerminated,
    reconcileStrandedAssignedIssues,
    sweepStaleIssueLocks,
    buildIssueGraphLivenessAutoRecoveryPreview,
    reconcileResolvedDependencyWakeBackstop,
    reconcileStrandedRecoveryWakeBackstop,
    reconcileStrandedRecoveryHandBacks,
    reconcileExpiredRecoveryWakeHorizons,
    reconcileIssueGraphLiveness,
    readRecoveryTimerIntervalMs,
  };
}
