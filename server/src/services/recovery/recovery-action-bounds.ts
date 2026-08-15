import type { IssueRecoveryAction } from "@paperclipai/shared";

/**
 * Default attempt/wall-clock bounds for a `wake_owner` recovery action.
 *
 * These live here, in a module with no runtime imports, so `config.ts` and
 * `recovery/service.ts` can both read them without an import cycle.
 *
 * The values are deliberately the ones BLO-18995/18996 chose for the escalation
 * wake budget, and that is load-bearing rather than incidental: escalation's own
 * runaway backstop, `strandedRecoveryWakeAttemptsExhausted`, reads the bounds
 * *stamped on the row* — the same fields this reaper reads. So the number here is
 * simultaneously "when does the reaper expire this action" and "when does
 * escalation stop waking the owner about it". Raising the timeout does not just
 * slow the drain; it lengthens the owner-churn ping-pong loop BLO-18996 measured
 * at 30 wakes over 30 sweeps. Change these two only with that loop in mind.
 */
export const DEFAULT_RECOVERY_ACTION_MAX_ATTEMPTS = 5;
export const DEFAULT_RECOVERY_ACTION_TIMEOUT_MS = 6 * 60 * 60 * 1000;

/**
 * Bounding + re-arm policy for source-scoped recovery actions (BLO-19124).
 *
 * Background: escalation creates a recovery action, fires exactly one
 * `wake_owner`, and parks the source issue in `blocked`. The only sweep that
 * could re-attempt it (`reconcileStrandedAssignedIssues`) selects
 * todo/in_progress/in_review, so escalation evicts its own issue from the one
 * retry path it has. If that single wake is not absorbed — and a burst of 59
 * one-shot wakes at an owner running maxConcurrentRuns: 3 guarantees most are
 * not — the action stays `active` forever.
 *
 * This module holds the decision logic only, with no I/O and no clock of its
 * own, so the policy can be tested directly.
 */

export type RecoveryActionBoundsConfig = {
  /** First re-arm waits this long after the last attempt. */
  retryBaseMs: number;
  /** Ceiling for the exponential backoff between re-arms. */
  retryMaxMs: number;
  /** Attempts allowed before the action expires. */
  maxAttempts: number;
  /** Wall-clock bound measured from creation. */
  timeoutMs: number;
  /** Max issues restored per owner per tick (burst safety). */
  perOwnerPerTick: number;
  /** Max issues restored across all owners per tick. */
  perTick: number;
};

export type RecoveryActionDecision =
  /** Bound reached — terminate into outcome `expired`. */
  | { type: "expire"; reason: "max_attempts" | "timeout" }
  /** Still within bounds and the backoff has elapsed — re-arm. */
  | { type: "rearm"; attempt: number }
  /** Backoff has not elapsed yet. */
  | { type: "wait" };

/**
 * Exponential backoff on attempt number, clamped to `retryMaxMs`.
 * attempt 1 -> base, attempt 2 -> 2x base, attempt 3 -> 4x base, ...
 */
export function retryBackoffMs(attemptCount: number, config: RecoveryActionBoundsConfig): number {
  const exponent = Math.max(0, attemptCount - 1);
  // Cap the exponent before shifting so a large attemptCount cannot overflow
  // into Infinity/NaN before the Math.min clamp runs.
  const safeExponent = Math.min(exponent, 32);
  const scaled = config.retryBaseMs * 2 ** safeExponent;
  return Math.min(config.retryMaxMs, scaled);
}

/**
 * Effective wall-clock deadline for an action.
 *
 * `timeoutAt` is NULL on every row created before this change shipped, so the
 * deadline falls back to createdAt + timeoutMs. That deliberately avoids a
 * backfill migration: the ~300 legacy rows become bounded the moment the
 * reaper first sees them, and are drained by the same per-owner cap as new
 * ones rather than all expiring in one bang.
 */
export function effectiveTimeoutAt(
  action: Pick<IssueRecoveryAction, "timeoutAt" | "createdAt">,
  config: RecoveryActionBoundsConfig,
): Date {
  if (action.timeoutAt) return new Date(action.timeoutAt as Date | string);
  return new Date(new Date(action.createdAt as Date | string).getTime() + config.timeoutMs);
}

/** Effective attempt bound, falling back to config for legacy NULL rows. */
export function effectiveMaxAttempts(
  action: Pick<IssueRecoveryAction, "maxAttempts">,
  config: RecoveryActionBoundsConfig,
): number {
  return action.maxAttempts ?? config.maxAttempts;
}

export function decideRecoveryAction(
  action: Pick<
    IssueRecoveryAction,
    "attemptCount" | "maxAttempts" | "timeoutAt" | "createdAt" | "lastAttemptAt"
  >,
  now: Date,
  config: RecoveryActionBoundsConfig,
): RecoveryActionDecision {
  // Timeout is checked before attempts so a long-silent action expires on the
  // wall clock even if it never accumulated attempts.
  if (now.getTime() >= effectiveTimeoutAt(action, config).getTime()) {
    return { type: "expire", reason: "timeout" };
  }
  if (action.attemptCount >= effectiveMaxAttempts(action, config)) {
    return { type: "expire", reason: "max_attempts" };
  }
  const lastAttemptAt = action.lastAttemptAt
    ? new Date(action.lastAttemptAt as Date | string)
    : null;
  if (!lastAttemptAt) return { type: "rearm", attempt: action.attemptCount + 1 };
  const dueAt = lastAttemptAt.getTime() + retryBackoffMs(action.attemptCount, config);
  if (now.getTime() < dueAt) return { type: "wait" };
  return { type: "rearm", attempt: action.attemptCount + 1 };
}

export type PlannedRecoveryAction<T> = {
  action: T;
  decision: Exclude<RecoveryActionDecision, { type: "wait" }>;
};

/**
 * Applies the burst-safety caps.
 *
 * The whole point of BLO-19124's burst case is that N recoveries for one owner
 * must not depend on that owner absorbing N wakes. Expirations are NOT capped
 * per owner: they terminate an action and hand the issue back to a live status
 * without waking anyone, so they cost the owner nothing and letting them drain
 * freely is what stops a seven-week backlog from taking weeks more to clear.
 * Re-arms are what actually cost an owner a run, so only those are throttled.
 */
export function planRecoverySweep<T extends { ownerAgentId: string | null }>(
  candidates: PlannedRecoveryAction<T>[],
  config: RecoveryActionBoundsConfig,
): PlannedRecoveryAction<T>[] {
  const planned: PlannedRecoveryAction<T>[] = [];
  const rearmsByOwner = new Map<string, number>();
  for (const candidate of candidates) {
    if (planned.length >= config.perTick) break;
    if (candidate.decision.type === "expire") {
      planned.push(candidate);
      continue;
    }
    const ownerKey = candidate.action.ownerAgentId ?? "__unowned__";
    const used = rearmsByOwner.get(ownerKey) ?? 0;
    if (used >= config.perOwnerPerTick) continue;
    rearmsByOwner.set(ownerKey, used + 1);
    planned.push(candidate);
  }
  return planned;
}
