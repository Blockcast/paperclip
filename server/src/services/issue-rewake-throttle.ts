/**
 * PAP-13775: throttle no-information issue re-wakes.
 *
 * After a process death (or any stall), external drivers — assignment pollers,
 * stranded-issue reconcilers, on-demand invokes — can re-wake the same agent
 * for the same issue every few seconds for as long as the issue stays
 * `in_progress`. When each of those runs ends without changing any
 * issue-visible state, every wake pays a full adapter session for zero new
 * information (the Phase 4 interruption-recovery smoke paid 25 sessions and
 * 2.4x cost for one recovery this way).
 *
 * This module decides when such a wake should be skipped: once an issue has
 * accumulated a streak of consecutive succeeded-but-no-issue-progress runs by
 * the same agent, further event-free wakes are held back for an escalating
 * cooldown anchored to the last run's finish time. Any genuinely new input —
 * a comment wake, fresh issue activity, an explicit resume, forceFreshSession,
 * or an event-carrying wake reason — bypasses the throttle entirely.
 *
 * Server-side recovery retries (process-loss retries, missing-comment
 * follow-ups) insert their runs directly and never pass through this gate, so
 * crash recovery stays immediate; only repeated no-op re-invocations slow
 * down.
 */

/** Consecutive no-progress runs required before the cooldown engages. */
export const ISSUE_REWAKE_NO_PROGRESS_THRESHOLD = 2;

/** Cooldown after the threshold streak; doubles per additional no-progress run. */
export const ISSUE_REWAKE_BASE_COOLDOWN_MS = 120_000;

/** Upper bound for the escalating cooldown. */
export const ISSUE_REWAKE_MAX_COOLDOWN_MS = 30 * 60_000;

/** Only runs newer than this feed the streak; older history is ignored. */
export const ISSUE_REWAKE_LOOKBACK_MS = 6 * 60 * 60_000;

/** How many recent terminal runs to sample when computing the streak. */
export const ISSUE_REWAKE_RUN_SAMPLE_LIMIT = 8;

/**
 * Wake reasons that assert issue state rather than deliver a new event.
 * These (plus reason-less on-demand invokes) are the only wakes the throttle
 * applies to; every event-shaped reason (comments, mentions, blockers
 * resolved, interactions, approvals, monitors, reviews, …) passes through.
 */
export const THROTTLED_ISSUE_REWAKE_REASONS: ReadonlySet<string> = new Set([
  "issue_assigned",
  "issue_continuation_needed",
  "issue_assignment_recovery",
  "issue_graph_liveness_backstop",
]);

/**
 * Activity actions that count as issue-visible progress when attributed to a
 * run. Deliberately narrower than run-liveness "concrete action evidence":
 * tool calls inside the workspace do not move the issue, so they do not reset
 * the streak — a run must leave a mutation, document, work product,
 * interaction, or scheduled continuation behind.
 *
 * `issue.comment_added` is deliberately excluded: a bare comment carries no
 * state change, so on its own it must not count as progress (BLO-23081) — see
 * `isIssueRewakeProgressActivity` / `isIssueRewakeNewInputActivity` below for
 * how comments are handled instead.
 */
export const ISSUE_PROGRESS_ACTIVITY_ACTIONS: string[] = [
  "issue.updated",
  "issue.created",
  "issue.child_created",
  "issue.assigned",
  "issue.released",
  "issue.blockers_updated",
  "issue.document_upserted",
  "issue.document_updated",
  "issue.document_deleted",
  "issue.document_restored",
  "issue.document_annotation_comment_added",
  "issue.document_annotation_thread_created",
  "issue.document_annotation_thread_resolved",
  "issue.work_product_created",
  "issue.work_product_updated",
  "issue.work_product_deleted",
  "issue.attachment_added",
  "issue.attachment_removed",
  "issue.thread_interaction_created",
  "issue.monitor_scheduled",
  "issue.approval_linked",
];

/** Comment activity is handled separately — see the actor-aware helpers below. */
export const ISSUE_COMMENT_ADDED_ACTION = "issue.comment_added";

/**
 * Activity on the issue that counts as new external input since the last run
 * finished — anything a waiting agent should be woken for, including board
 * responses to interactions and comments from anyone other than the
 * evaluating agent itself.
 */
export const ISSUE_NEW_INPUT_ACTIVITY_ACTIONS: string[] = [
  ...ISSUE_PROGRESS_ACTIVITY_ACTIONS,
  ISSUE_COMMENT_ADDED_ACTION,
  "issue.thread_interaction_accepted",
  "issue.thread_interaction_answered",
  "issue.thread_interaction_item_verdicts_submitted",
  "issue.blockers_resolved_wake_emitted",
];

const ISSUE_PROGRESS_ACTIVITY_ACTION_SET: ReadonlySet<string> = new Set(ISSUE_PROGRESS_ACTIVITY_ACTIONS);
const ISSUE_NEW_INPUT_ACTIVITY_ACTION_SET: ReadonlySet<string> = new Set(ISSUE_NEW_INPUT_ACTIVITY_ACTIONS);

/**
 * A single issue-activity row as needed by the throttle: which run (if any)
 * produced it, who performed it, and when.
 */
export interface IssueRewakeActivityRow {
  runId: string | null;
  action: string;
  /** Acting agent id, or null for a user/system actor. */
  agentId: string | null;
  createdAt: Date;
}

/**
 * Whether an activity row counts as issue-visible progress for streak
 * purposes. A bare comment never does — a run must also leave a real
 * mutation behind (BLO-23081); commenting alongside a real mutation still
 * counts via the mutation's own action.
 */
export function isIssueRewakeProgressActivity(row: Pick<IssueRewakeActivityRow, "action">): boolean {
  return ISSUE_PROGRESS_ACTIVITY_ACTION_SET.has(row.action);
}

/**
 * Whether an activity row counts as new external input the throttled agent
 * should be woken for. A comment authored by the evaluating agent itself is
 * a status ping, not new input; the identical comment from anyone else
 * (another agent, a board user) still bypasses the throttle immediately.
 */
export function isIssueRewakeNewInputActivity(
  row: IssueRewakeActivityRow,
  evaluatingAgentId: string,
): boolean {
  if (row.action === ISSUE_COMMENT_ADDED_ACTION) {
    return row.agentId !== evaluatingAgentId;
  }
  return ISSUE_NEW_INPUT_ACTIVITY_ACTION_SET.has(row.action);
}

export interface IssueRewakeCandidateInput {
  reason: string | null;
  wakeCommentId: string | null;
  forceFreshSession: boolean;
  hasExplicitResume: boolean;
}

/**
 * Whether a wake is even a candidate for throttling. Wakes that carry new
 * information or an explicit operator escalation always pass.
 */
export function isThrottleCandidateIssueRewake(input: IssueRewakeCandidateInput): boolean {
  if (input.forceFreshSession) return false;
  if (input.wakeCommentId) return false;
  if (input.hasExplicitResume) return false;
  if (input.reason === null) return true;
  return THROTTLED_ISSUE_REWAKE_REASONS.has(input.reason);
}

export interface RecentIssueRunSample {
  id: string;
  status: string;
  finishedAt: Date | null;
}

export interface IssueRewakeThrottleInput {
  now: Date;
  /** The agent whose wake is being evaluated. */
  agentId: string;
  /** Terminal runs for the same (agent, issue), newest finish first. */
  recentTerminalRuns: RecentIssueRunSample[];
  /**
   * Issue activity rows relevant to this decision: anything attributed to a
   * sampled run (for progress) and anything created after the newest run's
   * finish time (for new input). Order does not matter.
   */
  activityRows: IssueRewakeActivityRow[];
}

export type IssueRewakeThrottleDecision =
  | { blocked: false; noProgressStreak: number }
  | {
      blocked: true;
      noProgressStreak: number;
      cooldownMs: number;
      lastRunFinishedAt: Date;
      nextAllowedAt: Date;
    };

export function computeIssueRewakeCooldownMs(noProgressStreak: number): number {
  const doublings = Math.max(0, noProgressStreak - ISSUE_REWAKE_NO_PROGRESS_THRESHOLD);
  // Guard the exponent so an absurd streak can't overflow into Infinity.
  const factor = 2 ** Math.min(doublings, 16);
  return Math.min(ISSUE_REWAKE_BASE_COOLDOWN_MS * factor, ISSUE_REWAKE_MAX_COOLDOWN_MS);
}

export function evaluateIssueRewakeThrottle(input: IssueRewakeThrottleInput): IssueRewakeThrottleDecision {
  const runs = input.recentTerminalRuns;
  if (runs.length === 0) return { blocked: false, noProgressStreak: 0 };

  const lastRunFinishedAt = runs[0]?.finishedAt ?? null;
  const hasNewIssueInputSinceLastRun =
    lastRunFinishedAt !== null &&
    input.activityRows.some(
      (row) =>
        row.createdAt.getTime() > lastRunFinishedAt.getTime() &&
        isIssueRewakeNewInputActivity(row, input.agentId),
    );
  if (hasNewIssueInputSinceLastRun) return { blocked: false, noProgressStreak: 0 };

  const runIdsWithIssueProgress = new Set(
    input.activityRows
      .filter(isIssueRewakeProgressActivity)
      .map((row) => row.runId)
      .filter((runId): runId is string => Boolean(runId)),
  );

  let noProgressStreak = 0;
  for (const run of runs) {
    // A failed/cancelled/interrupted run breaks the streak: its follow-up is
    // recovery, not a redundant re-poll, and must not be delayed.
    if (run.status !== "succeeded" || !run.finishedAt) break;
    if (runIdsWithIssueProgress.has(run.id)) break;
    noProgressStreak += 1;
  }

  if (noProgressStreak < ISSUE_REWAKE_NO_PROGRESS_THRESHOLD) {
    return { blocked: false, noProgressStreak };
  }

  if (!lastRunFinishedAt) return { blocked: false, noProgressStreak };

  const cooldownMs = computeIssueRewakeCooldownMs(noProgressStreak);
  const nextAllowedAt = new Date(lastRunFinishedAt.getTime() + cooldownMs);
  if (input.now.getTime() < nextAllowedAt.getTime()) {
    return { blocked: true, noProgressStreak, cooldownMs, lastRunFinishedAt, nextAllowedAt };
  }
  return { blocked: false, noProgressStreak };
}
