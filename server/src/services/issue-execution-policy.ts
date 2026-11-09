import { createHash, randomUUID } from "node:crypto";
import type {
  IssueExecutionDecision,
  IssueExecutionMonitorClearReason,
  IssueExecutionMonitorPolicy,
  IssueExecutionMonitorState,
  IssueExecutionPolicy,
  IssueExecutionStage,
  IssueExecutionStagePrincipal,
  IssueExecutionState,
  IssueMonitorGateSource,
  IssueMonitorScheduledBy,
} from "@paperclipai/shared";
import {
  DEFAULT_ISSUE_MONITOR_CONVERGENCE_THRESHOLD,
  DEFAULT_ISSUE_MONITOR_MAX_ATTEMPTS,
  MAX_ISSUE_MONITOR_CONVERGENCE_THRESHOLD,
  MAX_ISSUE_MONITOR_GATE_SIGNALS,
  issueExecutionPolicySchema,
  issueExecutionStateSchema,
  renewedIssueMonitorMaxAttempts,
} from "@paperclipai/shared";
import { unprocessable } from "../errors.js";

type AssigneeLike = {
  assigneeAgentId?: string | null;
  assigneeUserId?: string | null;
};

type IssueLike = AssigneeLike & {
  status: string;
  executionPolicy?: IssueExecutionPolicy | Record<string, unknown> | null;
  executionState?: IssueExecutionState | Record<string, unknown> | null;
  monitorNextCheckAt?: Date | null;
  monitorWakeRequestedAt?: Date | null;
  monitorLastTriggeredAt?: Date | null;
  monitorAttemptCount?: number | null;
  monitorNotes?: string | null;
  monitorScheduledBy?: string | null;
};

type ActorLike = {
  agentId?: string | null;
  userId?: string | null;
};

type RequestedAssigneePatch = {
  assigneeAgentId?: string | null;
  assigneeUserId?: string | null;
};

type TransitionInput = {
  issue: IssueLike;
  policy: IssueExecutionPolicy | null;
  previousPolicy?: IssueExecutionPolicy | null;
  requestedStatus?: string;
  requestedAssigneePatch: RequestedAssigneePatch;
  effectiveMonitorAssigneeAgentId?: string | null;
  actor: ActorLike;
  commentBody?: string | null;
  reviewRequest?: IssueExecutionState["reviewRequest"] | null;
  monitorExplicitlyUpdated?: boolean;
  /**
   * BLO-18294: the issue's currently-unresolved blocker issue ids, supplied by
   * the caller (the transition layer has no DB access). These are folded into
   * the monitor's gate fingerprint alongside any declared `gateSignals`.
   */
  unresolvedBlockerIssueIds?: readonly string[] | null;
  /** BLO-18294: override for the consecutive-identical-recheck ceiling. */
  monitorConvergenceThreshold?: number | null;
  /**
   * BLO-15942: an operator/adjudicator override (`tasks:override_execution_stage`,
   * checked by the caller before this is set — never derived here) that lets an
   * actor above the stage's mandate-bound participant force-complete or
   * request-changes on a review/approval stage the participant cannot or will
   * not act on. Without this, a stage pinned to a participant whose mandate
   * excludes stage decisions (e.g. a PR-webhook-only reviewer bot) deadlocks:
   * only the participant can advance, and no role-based actor can unstick it.
   */
  overrideAuthorized?: boolean;
};

type TransitionResult = {
  patch: Record<string, unknown>;
  decision?: Pick<IssueExecutionDecision, "stageId" | "stageType" | "outcome" | "body">;
  workflowControlledAssignment?: boolean;
  /**
   * BLO-18294: set whenever an arm was evaluated by the convergence guard.
   * `converged: true` means the arm was refused and the patch escalates the
   * issue to `blocked`; callers surface the blocker set as unblock owners.
   */
  monitorConvergence?: IssueMonitorConvergence | null;
};

const COMPLETED_STATUS: IssueExecutionState["status"] = "completed";
const PENDING_STATUS: IssueExecutionState["status"] = "pending";
const CHANGES_REQUESTED_STATUS: IssueExecutionState["status"] = "changes_requested";
const MONITOR_INVALID_MESSAGE = "Monitor can only be scheduled on issues assigned to an agent in in_progress or in_review";
/**
 * PEN-3803: the remedy is part of the message because this 422 now fires on a
 * population it previously waved through — a monitor at or past the default
 * ceiling with `maxAttempts: null` — and the advice in circulation for that
 * case was exactly backwards ("omit `maxAttempts`", which is what produced the
 * silent 200). Clearing does not reset `monitorAttemptCount` either, so a
 * reader who is told only "exhausted" has no way to infer the one move that
 * works.
 */
const MONITOR_BOUNDS_EXHAUSTED_MESSAGE =
  "Monitor bounds are already exhausted — this arm would be cleared at dispatch without firing. " +
  "Either set an explicit `maxAttempts` greater than the issue's `monitorAttemptCount` " +
  "(a recorded, bounded budget extension), or clear the monitor and stop polling. " +
  "Omitting `maxAttempts` does NOT grant more attempts: the scheduler applies its own ceiling " +
  "to every monitor at dispatch.";

/**
 * PEN-3803: the numbers behind the refusal, so a caller can compute the remedy
 * the message names without a second read. `maxAttemptsSource` distinguishes a
 * bound the issue declared from the fleet-wide ceiling, which is the difference
 * between "you set this" and "you never saw this".
 */
function monitorBoundsExhaustedDetails(input: {
  clearReason: IssueExecutionMonitorClearReason;
  monitor: Pick<IssueExecutionMonitorPolicy, "timeoutAt" | "maxAttempts"> | null;
  attemptCount: number;
}) {
  const declared = input.monitor?.maxAttempts ?? null;
  const effective = declared ?? DEFAULT_ISSUE_MONITOR_MAX_ATTEMPTS;
  return {
    clearReason: input.clearReason,
    attemptCount: input.attemptCount,
    maxAttempts: effective,
    maxAttemptsSource: declared === null ? ("default" as const) : ("policy" as const),
    timeoutAt: input.monitor?.timeoutAt ?? null,
    suggestedMaxAttempts: renewedIssueMonitorMaxAttempts(input.attemptCount),
  };
}
const MONITOR_CONVERGENCE_RESET_REQUIRES_NON_ASSIGNEE_MESSAGE =
  "A monitor cleared for convergence_stalled must be re-armed by a non-assignee actor";
export const REDACTED_ISSUE_MONITOR_EXTERNAL_REF = "[redacted]";

function normalizeMonitorNotes(notes: string | null | undefined) {
  if (typeof notes !== "string") return null;
  const trimmed = notes.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeMonitorText(value: string | null | undefined) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function redactIssueMonitorExternalRef(value: string | null | undefined) {
  return normalizeMonitorText(value) ? REDACTED_ISSUE_MONITOR_EXTERNAL_REF : null;
}

function monitorMetadataFromPolicy(monitor: IssueExecutionMonitorPolicy) {
  return {
    kind: monitor.kind ?? null,
    serviceName: normalizeMonitorText(monitor.serviceName),
    externalRef: redactIssueMonitorExternalRef(monitor.externalRef),
    timeoutAt: monitor.timeoutAt ?? null,
    maxAttempts: monitor.maxAttempts ?? null,
    recoveryPolicy: monitor.recoveryPolicy ?? null,
  };
}

function monitorMetadataFromState(state: IssueExecutionMonitorState | null | undefined) {
  return {
    kind: state?.kind ?? null,
    serviceName: normalizeMonitorText(state?.serviceName),
    externalRef: redactIssueMonitorExternalRef(state?.externalRef),
    timeoutAt: state?.timeoutAt ?? null,
    maxAttempts: state?.maxAttempts ?? null,
    recoveryPolicy: state?.recoveryPolicy ?? null,
  };
}

/**
 * BLO-18294: the convergence bookkeeping a monitor state carries forward.
 * `previous` is the state we are superseding; `monitor`/`convergence` are only
 * present on an arm, where a freshly computed fingerprint replaces the old one.
 *
 * PEN-6228: `convergence` is null for a monitor the guard declines to score —
 * `external_service`, or board/manager-scheduled. That exemption governs
 * COUNTING, not STORAGE. Without `gateIdentity` such an arm refreshed
 * `gateSignals` from the incoming policy while carrying the previous
 * `gateFingerprint` forward, so the row stored a digest that was never computed
 * from the signals sitting beside it, and nothing marked it stale. Callers that
 * know the gate set pass `gateIdentity` so the stored pair always corresponds.
 */
function monitorConvergenceFields(
  previous: IssueExecutionMonitorState | null | undefined,
  monitor?: IssueExecutionMonitorPolicy | null,
  convergence?: IssueMonitorConvergence | null,
  options: { preservePrevious?: boolean; gateIdentity?: IssueMonitorGateIdentity | null } = {},
) {
  if (options.preservePrevious) {
    return {
      gateSignals: previous?.gateSignals ?? null,
      gateFingerprint: previous?.gateFingerprint ?? null,
      gateSource: previous?.gateSource ?? null,
      convergenceCount: previous?.convergenceCount ?? 0,
      convergenceStallCount: previous?.convergenceStallCount ?? 0,
      convergenceStalledAssigneeAgentId: previous?.convergenceStalledAssigneeAgentId ?? null,
    };
  }
  const previousFingerprint = previous?.gateFingerprint ?? null;
  // At most one of these is set: `convergence` when the guard scored this arm,
  // `gateIdentity` when it declined to score but the caller knew the gate set.
  const gateIdentity = convergence ?? options.gateIdentity ?? null;
  return {
    gateSignals: monitor
      ? normalizeIssueMonitorGateSignals(monitor.gateSignals)
      : previous?.gateSignals ?? null,
    gateFingerprint: gateIdentity?.fingerprint ?? previousFingerprint,
    gateSource: gateIdentity?.source ?? previous?.gateSource ?? null,
    // An unscored arm records no count of its own. Carrying the stored one
    // across a gate set that MOVED would credit the new gates with re-checks
    // the old ones earned, so reset it; an unchanged gate set keeps whatever
    // evidence it had already accumulated.
    convergenceCount:
      convergence?.count
      ?? (options.gateIdentity && options.gateIdentity.fingerprint !== previousFingerprint
        ? 0
        : previous?.convergenceCount ?? 0),
    convergenceStallCount: previous?.convergenceStallCount ?? 0,
    convergenceStalledAssigneeAgentId: previous?.convergenceStalledAssigneeAgentId ?? null,
  };
}

function resetMonitorConvergenceFields(
  state: IssueExecutionMonitorState | null,
): IssueExecutionMonitorState | null {
  if (!state) return null;
  return {
    ...state,
    gateSignals: null,
    gateFingerprint: null,
    gateSource: null,
    convergenceCount: 0,
  };
}

function blankExecutionState(): IssueExecutionState {
  return {
    status: "idle",
    currentStageId: null,
    currentStageIndex: null,
    currentStageType: null,
    currentParticipant: null,
    returnAssignee: null,
    reviewRequest: null,
    completedStageIds: [],
    lastDecisionId: null,
    lastDecisionOutcome: null,
    monitor: null,
  };
}

function isoString(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return value;
}

function monitorStatesEqual(left: IssueExecutionMonitorState | null, right: IssueExecutionMonitorState | null): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function executionStateWithMonitor(
  stageState: IssueExecutionState | null,
  monitorState: IssueExecutionMonitorState | null,
): IssueExecutionState | null {
  if (!stageState && !monitorState) return null;
  const base = stageState ? { ...stageState } : blankExecutionState();
  return {
    ...base,
    monitor: monitorState,
  };
}

export function derivePersistedMonitorState(input: {
  issue: IssueLike;
  state: IssueExecutionState | null;
  policy: IssueExecutionPolicy | null;
}): IssueExecutionMonitorState | null {
  const fromState = input.state?.monitor ?? null;
  const scheduledMonitor = input.policy?.monitor ?? null;
  const nextCheckAt = isoString(input.issue.monitorNextCheckAt) ?? scheduledMonitor?.nextCheckAt ?? fromState?.nextCheckAt ?? null;
  const lastTriggeredAt = isoString(input.issue.monitorLastTriggeredAt) ?? fromState?.lastTriggeredAt ?? null;
  const attemptCount = input.issue.monitorAttemptCount ?? fromState?.attemptCount ?? 0;
  const notes = scheduledMonitor?.notes ?? normalizeMonitorNotes(input.issue.monitorNotes) ?? fromState?.notes ?? null;
  const scheduledByRaw = input.issue.monitorScheduledBy ?? scheduledMonitor?.scheduledBy ?? fromState?.scheduledBy ?? null;
  const scheduledBy =
    scheduledByRaw === "assignee" || scheduledByRaw === "board" || scheduledByRaw === "manager" ? scheduledByRaw : null;
  const metadata = scheduledMonitor ? monitorMetadataFromPolicy(scheduledMonitor) : monitorMetadataFromState(fromState);
  // BLO-18294: convergence bookkeeping has no dedicated columns, so it only
  // survives via executionState. Carry it across every derived shape.
  const convergence = monitorConvergenceFields(fromState, scheduledMonitor);

  if (nextCheckAt) {
    return {
      status: "scheduled",
      nextCheckAt,
      lastTriggeredAt,
      attemptCount,
      notes,
      scheduledBy,
      ...metadata,
      ...convergence,
      clearedAt: null,
      clearReason: null,
      clearedNextCheckAt: null,
      recoveryEmittedAt: null,
    };
  }

  if (fromState?.status === "cleared") {
    return {
      ...fromState,
      notes,
      scheduledBy,
      attemptCount,
      lastTriggeredAt,
      ...metadata,
      ...convergence,
      // PEN-5346: normalize absent to null so a state persisted before the
      // field existed derives to the same shape as one written after it.
      // `monitorStatesEqual` compares by JSON.stringify, where an absent key
      // and a null one are different strings; without this every such row
      // would compare unequal to itself and take a spurious executionState
      // write on the next transition. The spread keeps the key in its
      // persisted position when it is already there.
      recoveryEmittedAt: fromState.recoveryEmittedAt ?? null,
    };
  }

  if (fromState?.status === "triggered" || lastTriggeredAt || attemptCount > 0) {
    return {
      status: "triggered",
      nextCheckAt: null,
      lastTriggeredAt,
      attemptCount,
      notes,
      scheduledBy,
      ...metadata,
      ...convergence,
      clearedAt: null,
      clearReason: null,
      clearedNextCheckAt: null,
      recoveryEmittedAt: null,
    };
  }

  return null;
}

function buildScheduledMonitorState(
  previous: IssueExecutionMonitorState | null,
  monitor: IssueExecutionMonitorPolicy,
  convergence?: IssueMonitorConvergence | null,
  options: { preserveConvergence?: boolean; gateIdentity?: IssueMonitorGateIdentity | null } = {},
): IssueExecutionMonitorState {
  return {
    status: "scheduled",
    nextCheckAt: monitor.nextCheckAt,
    lastTriggeredAt: previous?.lastTriggeredAt ?? null,
    attemptCount: previous?.attemptCount ?? 0,
    notes: monitor.notes ?? null,
    scheduledBy: monitor.scheduledBy,
    ...monitorMetadataFromPolicy(monitor),
    ...monitorConvergenceFields(previous, monitor, convergence, {
      preservePrevious: options.preserveConvergence === true,
      gateIdentity: options.gateIdentity ?? null,
    }),
    clearedAt: null,
    clearReason: null,
    // PEN-5343: an arm and a fire both leave nothing owed, so neither carries
    // a lost due time forward. Only a clear sets this.
    clearedNextCheckAt: null,
    recoveryEmittedAt: null,
  };
}

function buildTriggeredMonitorState(input: {
  previous: IssueExecutionMonitorState | null;
  triggeredAt: Date;
}): IssueExecutionMonitorState {
  return {
    status: "triggered",
    nextCheckAt: null,
    lastTriggeredAt: input.triggeredAt.toISOString(),
    attemptCount: (input.previous?.attemptCount ?? 0) + 1,
    notes: input.previous?.notes ?? null,
    scheduledBy: input.previous?.scheduledBy ?? null,
    ...monitorMetadataFromState(input.previous),
    ...monitorConvergenceFields(input.previous),
    clearedAt: null,
    clearReason: null,
    // PEN-5343: an arm and a fire both leave nothing owed, so neither carries
    // a lost due time forward. Only a clear sets this.
    clearedNextCheckAt: null,
    recoveryEmittedAt: null,
  };
}

/**
 * PEN-5902: whether a clear with this reason still owes a reader the monitor's
 * `notes`, and so must keep the audit copy on `executionState.monitor.notes`.
 *
 * Exactly one consumer re-hydrates from that copy, and it is deferred:
 * `reconcileCancelledIssueMonitorRecoveries` runs on a later tick, after the clear has
 * committed and `issues.monitorNotes` is already null, and CASes on
 * `clearReason = 'cancelled' AND recoveryEmittedAt IS NULL`. For a cancelled
 * row the recovery issue it mints may be the only surviving carrier of the
 * obligation, so the notes have to travel with it.
 *
 * Every other clear reason either runs its recovery inline — the scheduler
 * still holds the pre-clear row, so it reads the live column, not the archive —
 * or has no recovery at all. For those the archived copy has no reader, and
 * `monitorRecoveryComment` only reaches `clearedMonitor` in its `cancelled`
 * branch.
 */
function clearedMonitorKeepsNotes(clearReason: IssueExecutionMonitorClearReason): boolean {
  return clearReason === "cancelled";
}

function buildClearedMonitorState(input: {
  previous: IssueExecutionMonitorState | null;
  clearReason: IssueExecutionMonitorClearReason;
  clearedAt: Date;
  convergence?: IssueMonitorConvergence | null;
  assigneeAgentId?: string | null;
}): IssueExecutionMonitorState {
  return {
    status: "cleared",
    nextCheckAt: null,
    lastTriggeredAt: input.previous?.lastTriggeredAt ?? null,
    attemptCount: input.previous?.attemptCount ?? 0,
    // PEN-5902: the notes are operating instructions addressed to the next
    // waking run. A retired monitor's copy of them has no reader except a
    // human or agent inspecting the row, to whom they read as live work —
    // and until now nothing could write to this field, so the mistake was
    // permanent. Keep them only where a deferred consumer needs them; the
    // durable audit record is the `issue.monitor_cleared` activity entry,
    // which carries `notes` on every clear path.
    notes: clearedMonitorKeepsNotes(input.clearReason) ? input.previous?.notes ?? null : null,
    scheduledBy: input.previous?.scheduledBy ?? null,
    ...monitorMetadataFromState(input.previous),
    ...monitorConvergenceFields(input.previous, null, input.convergence),
    convergenceStallCount:
      input.clearReason === "convergence_stalled"
        ? (input.previous?.convergenceStallCount ?? 0) + 1
        : input.previous?.convergenceStallCount ?? 0,
    convergenceStalledAssigneeAgentId:
      input.clearReason === "convergence_stalled"
        ? input.assigneeAgentId ?? input.previous?.convergenceStalledAssigneeAgentId ?? null
        : input.previous?.convergenceStalledAssigneeAgentId ?? null,
    clearedAt: input.clearedAt.toISOString(),
    clearReason: input.clearReason,
    ...clearedNextCheckAtField(input.previous),
    // PEN-5346: a clear owes a handoff; this clear has not made one yet.
    // Deliberately NOT carried forward from `previous` — the audit copy is of
    // the monitor being destroyed now, so inheriting an earlier clear's stamp
    // would mark this obligation discharged by a recovery that was emitted for
    // a different one. A re-clear can only reach here with a monitor armed in
    // between, and an arm resets the stamp anyway.
    recoveryEmittedAt: null,
  };
}

/**
 * PEN-5343: the due time a clear is destroying, as a spreadable fragment so the
 * three cases stay distinguishable at rest.
 *
 * - An armed monitor is being destroyed -> record what it was holding.
 * - A re-clear of an already-cleared monitor -> carry the *first* clear's
 *   record forward verbatim, **including its absence**. The plugin flaps (64
 *   plugin-authored status transitions on PEN-4365 in 14 days), so a second
 *   clear arrives with `previous.nextCheckAt` already null; assigning there
 *   would erase the original due time, and collapsing an absent value to `null`
 *   would assert "no wake was owed" about a row cleared before this field
 *   existed. Both are the false-negative direction.
 * - Any other clear -> `null`: a clear ran and genuinely found nothing owed.
 *
 * Returning a fragment rather than a value is what lets the second case emit no
 * key at all; `monitorStatesEqual` compares via `JSON.stringify`, which drops
 * absent keys, so an untouched old row still compares equal and writes nothing.
 */
function clearedNextCheckAtField(
  previous: IssueExecutionMonitorState | null,
): { clearedNextCheckAt?: string | null } {
  if (previous?.nextCheckAt) return { clearedNextCheckAt: previous.nextCheckAt };
  if (previous?.status === "cleared") {
    return previous.clearedNextCheckAt === undefined
      ? {}
      : { clearedNextCheckAt: previous.clearedNextCheckAt };
  }
  return { clearedNextCheckAt: null };
}

export function issueAllowsMonitor(status: string, assigneeAgentId: string | null, assigneeUserId: string | null) {
  return Boolean(assigneeAgentId) && !assigneeUserId && (status === "in_progress" || status === "in_review");
}

function monitorClearReasonForIssue(
  status: string,
  assigneeAgentId: string | null,
  assigneeUserId: string | null,
): IssueExecutionMonitorClearReason | null {
  if (status === "done") return "done";
  if (status === "cancelled") return "cancelled";
  if (!issueAllowsMonitor(status, assigneeAgentId, assigneeUserId)) {
    if (assigneeUserId || !assigneeAgentId) return "invalid_assignee";
    return "invalid_status";
  }
  return null;
}

/**
 * BLO-18294 — monitor convergence guard.
 *
 * A timer-based monitor only earns its cost if each re-check narrows what the
 * issue is waiting on. BLO-13266 re-armed a 30-minute monitor ~52 times over
 * ~30h (~$197) without the blocker set ever moving, because nothing compared
 * one re-check to the last: the recorded signature mixed in an unrelated
 * staging CrashLoopBackOff, so incidental churn read as "state changed".
 *
 * The fix is to fingerprint the *declared gates* — the issue's unresolved
 * blocker edges plus the monitor's own `gateSignals` — and count how many
 * consecutive re-check cycles produce the same fingerprint. Free-form `notes`
 * is deliberately excluded whenever anything structured exists, which is what
 * makes unrelated churn stop resetting the counter.
 */
function normalizeGateToken(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/\s+/gu, " ").toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

export function normalizeIssueMonitorGateSignals(signals: readonly unknown[] | null | undefined): string[] {
  if (!Array.isArray(signals)) return [];
  const unique = new Set<string>();
  for (const raw of signals) {
    const token = normalizeGateToken(raw);
    if (token) unique.add(token);
  }
  return [...unique].sort();
}

/**
 * Gate token the dispatch watchdog writes to name the queued run it is watching.
 *
 * Lives here, beside the rest of the gate-token vocabulary, rather than in
 * `heartbeat.ts` where it was first written: two modules now read it and they
 * must not drift. The watchdog reads the run id back out of the gate set in
 * order to poll it, and `terminal-gate-reconciler` has to recognise the token
 * in order to *ignore* it — a prefix known to one of those and not the other
 * fails silently in opposite directions.
 */
export const ISSUE_MONITOR_DISPATCH_WATCHDOG_GATE_PREFIX = "heartbeat_run:";

/**
 * The gate set a dispatch-watchdog re-arm carries (PEN-6346).
 *
 * The watchdog used to write `[heartbeat_run:<id>]` — *replacing* whatever the
 * assignee had declared. That discarded the only machine-readable statement of
 * what the issue was actually waiting on, and since the re-arm's own monitor is
 * cleared a few minutes later, the row was left with no record of its gates at
 * all. `terminal-gate-reconciler` is the designed safety net for exactly that
 * row and reads precisely that field, so the substitution removed the net on
 * the one path where it was needed. Appending keeps both: the declared gates
 * survive into the archived monitor state, and the watchdog still finds its own
 * token by prefix.
 *
 * `dropped` is returned rather than swallowed because the overflow case has to
 * pick a loser. The schema admits `MAX_ISSUE_MONITOR_GATE_SIGNALS` tokens and
 * overflow is not a clamped write — the policy fails to parse and the re-arm is
 * skipped entirely — so one slot is reserved for the watchdog token and the
 * declared tail is trimmed to fit. That trim is itself a silent drop of the
 * kind this function exists to fix, so the caller logs the count: losing the
 * watchdog token instead would strand the run it was watching, which is worse
 * and also unobservable. A monitor declaring 20 gates is well outside the
 * measured population (1-3), so the trim is a guard, not a routine path.
 */
export function dispatchWatchdogGateSignals(input: {
  declared: readonly unknown[] | null | undefined;
  watchedRunId: string;
}): { gateSignals: string[]; dropped: number } {
  const watchdogToken = `${ISSUE_MONITOR_DISPATCH_WATCHDOG_GATE_PREFIX}${input.watchedRunId}`;
  const declared = normalizeIssueMonitorGateSignals(input.declared)
    .filter((token) => !token.startsWith(ISSUE_MONITOR_DISPATCH_WATCHDOG_GATE_PREFIX));
  const budget = Math.max(0, MAX_ISSUE_MONITOR_GATE_SIGNALS - 1);
  const carried = declared.slice(0, budget);
  return {
    gateSignals: normalizeIssueMonitorGateSignals([...carried, watchdogToken]),
    dropped: declared.length - carried.length,
  };
}

export function computeIssueMonitorGateFingerprint(input: {
  gateSignals?: readonly unknown[] | null;
  unresolvedBlockerIssueIds?: readonly unknown[] | null;
  notes?: string | null;
}): { fingerprint: string; source: IssueMonitorGateSource } {
  const declared = normalizeIssueMonitorGateSignals(input.gateSignals);
  const blockers = normalizeIssueMonitorGateSignals(input.unresolvedBlockerIssueIds);
  const structured = declared.length > 0 || blockers.length > 0;
  // When gates are declared (or the issue graph models them), the fingerprint is
  // built from those alone — this is the AC2 property: churn in a signal that is
  // not a declared gate cannot reset the convergence counter.
  const material = structured
    ? `b:${blockers.join(",")}|g:${declared.join(",")}`
    : `n:${normalizeGateToken(input.notes ?? null) ?? ""}`;
  return {
    source: structured ? "gates" : "notes",
    fingerprint: createHash("sha256").update(material).digest("hex").slice(0, 32),
  };
}

export function normalizeIssueMonitorConvergenceThreshold(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_ISSUE_MONITOR_CONVERGENCE_THRESHOLD;
  }
  const rounded = Math.floor(value);
  if (rounded < 1) return 1;
  return Math.min(rounded, MAX_ISSUE_MONITOR_CONVERGENCE_THRESHOLD);
}

/**
 * PEN-6228: the identity of the gate set an arm is waiting on — what
 * `computeIssueMonitorGateFingerprint` returns, without the counting the
 * convergence guard layers on top. Every arm that knows its gate set records
 * this, including the arms the guard itself declines to score.
 */
export type IssueMonitorGateIdentity = {
  fingerprint: string;
  source: IssueMonitorGateSource;
};

export type IssueMonitorConvergence = IssueMonitorGateIdentity & {
  count: number;
  threshold: number;
  converged: boolean;
};

/**
 * Returns null when the guard does not apply to this monitor — the caller then
 * records no convergence bookkeeping at all, so an unrelated PATCH that merely
 * carries an existing monitor forward does not rewrite `executionState`.
 */
export function evaluateIssueMonitorConvergence(input: {
  monitor: IssueExecutionMonitorPolicy;
  previous: IssueExecutionMonitorState | null;
  unresolvedBlockerIssueIds?: readonly string[] | null;
  threshold?: number | null;
}): IssueMonitorConvergence | null {
  // Only assignee-scheduled monitors are guarded. A board user arming a monitor
  // has made a deliberate human decision to keep polling; that is not the
  // guaranteed-waste shape this guard exists to stop.
  if (input.monitor.scheduledBy !== "assignee") return null;
  // Recovery-owned external checks (provider quota, CI, and similar services)
  // can legitimately re-arm against the same external condition until the
  // provider window moves. They are bounded by their own recovery policy.
  if (input.monitor.kind === "external_service") return null;

  const threshold = normalizeIssueMonitorConvergenceThreshold(input.threshold);
  const { fingerprint, source } = computeIssueMonitorGateFingerprint({
    gateSignals: input.monitor.gateSignals,
    unresolvedBlockerIssueIds: input.unresolvedBlockerIssueIds,
    notes: input.monitor.notes,
  });

  const previousFingerprint = input.previous?.gateFingerprint ?? null;
  const previousCount = input.previous?.convergenceCount ?? 0;

  let count: number;
  if (!previousFingerprint || previousFingerprint !== fingerprint) {
    // Something the monitor is actually waiting on moved: this is the first
    // observation of the new gate set.
    count = 1;
  } else if (input.previous?.status === "triggered") {
    // A full re-check cycle elapsed (the monitor fired, the assignee looked)
    // and nothing narrowed.
    count = previousCount + 1;
  } else {
    // Re-arm without an intervening fire — the assignee is adjusting the
    // schedule, not completing another re-check. Do not advance the counter.
    count = Math.max(previousCount, 1);
  }

  return { fingerprint, source, count, threshold, converged: count > threshold };
}

function parseMonitorDate(value: string | null | undefined) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * PEN-3803: the ceiling now lives in `@paperclipai/shared` and is re-exported
 * here so existing server importers keep their import path.
 *
 * It moved because the sentence that used to sit on this declaration — "this is
 * intentionally a scheduler default, not an API re-arm default: an explicit
 * re-arm without `maxAttempts` remains unbounded" — was not true of the system,
 * and believing it was what produced the defect. The scheduler applies this
 * ceiling to EVERY monitor at dispatch, whether or not the arm declared a
 * `maxAttempts`. "Unbounded at the API" therefore only ever meant "the arm is
 * not refused"; it never meant the monitor got more than 24 attempts. See the
 * declaration in `shared/constants.ts` for the full reasoning.
 */
export { DEFAULT_ISSUE_MONITOR_MAX_ATTEMPTS };

/**
 * Single source of truth for "has this monitor run out of road?" — shared by the
 * policy transition path and the heartbeat scheduler (BLO-23061).
 *
 * `attemptCount` is the number of attempts ALREADY made, not the one about to be
 * consumed. The scheduler previously kept a private copy of this rule phrased as
 * `nextAttemptCount > maxAttempts`, where `nextAttemptCount = attemptCount + 1`;
 * that is algebraically identical to `attemptCount >= maxAttempts`, so collapsing
 * the two is behaviour-preserving. Keep this parameterization — passing the
 * post-increment count here would move the ceiling by one.
 *
 * PEN-3803: `defaultMaxAttempts` used to be supplied by the scheduler alone, on
 * the theory that an explicit policy transition should leave a monitor with no
 * configured limit unbounded. The effect was not an unbounded monitor but an
 * undetectable one — the arm returned 200 and the scheduler cleared the row as
 * `max_attempts_exhausted` at the due instant without ever firing, after the
 * row had advertised a live `monitorNextCheckAt` for the whole interval. Every
 * caller that decides whether a monitor CAN BE DELIVERED now supplies the
 * ceiling, so the arm-time verdict and the dispatch verdict are the same
 * verdict. A caller asking a different question may still omit it; the one
 * in-tree example is `armedMonitorNextCheckAt` in terminal-gate-reconciler.ts,
 * which deliberately honours only an issue-declared bound and documents why.
 */
export function exhaustedMonitorClearReason(input: {
  monitor: Pick<IssueExecutionMonitorPolicy, "timeoutAt" | "maxAttempts"> | null;
  attemptCount: number;
  now: Date;
  defaultMaxAttempts?: number | null;
}): IssueExecutionMonitorClearReason | null {
  const timeoutAt = parseMonitorDate(input.monitor?.timeoutAt ?? null);
  if (timeoutAt && input.now.getTime() >= timeoutAt.getTime()) {
    return "timeout_exceeded";
  }
  const maxAttempts = input.monitor?.maxAttempts ?? input.defaultMaxAttempts ?? null;
  if (maxAttempts !== null && input.attemptCount >= maxAttempts) {
    return "max_attempts_exhausted";
  }
  return null;
}

/**
 * Single source of truth for "is this monitor's next check still a live wake path?"
 * — shared by the stranded-assigned sweep and the `in_review` disposition validator
 * (PEN-2853).
 *
 * The two were written independently and disagreed about the same column. The sweep
 * (`hasActiveMonitorPath`, recovery/service.ts) required a genuinely future instant;
 * the validator (`hasScheduledMonitor`, routes/issues.ts) accepted any non-null one.
 * So an issue could pass the write-side gate on a monitor the read-side had already
 * stopped counting — admitted to `in_review` and seizable as stranded at the same
 * moment, off the same `monitorNextCheckAt`. A week-old lapsed monitor, or a patch
 * arming one in the past, cleared the 422 (`nextCheckAt` has no future constraint in
 * the validator, unlike `timeoutAt`, which `exhaustedMonitorClearReason` rejects).
 *
 * That compounded badly. Of the five review paths the validator accepts, the monitor
 * is the only one an agent can satisfy unilaterally — the other four need a human, a
 * board decision, a counterparty to ask, or a configured execution policy. So the one
 * remedy always in reach was also the one verified least.
 *
 * This is the BLO-24782 divergence again, one predicate over, and it takes that
 * remedy: delegate rather than restate. A restated rule is only ever as good as the
 * test that notices it drifting; delegation makes the drift unrepresentable. Hence
 * `>` at millisecond resolution, no grace, in one place.
 *
 * Two asymmetries are deliberate, not oversights:
 *
 * - The sweep ORs a bounded lapsed-trigger window on top of this (BLO-18643 /
 *   BLO-24782) and the validator does not, so the validator is strictly the tighter
 *   reading. That is safe in exactly one direction and this is it: everything the
 *   validator accepts, the sweep counts. The leniency exists to avoid *seizing* a row
 *   whose owner has not had a chance to re-arm; it is not a licence to *assert* a
 *   review path. On a write the agent supplies the instant, so it can always name a
 *   real one.
 * - `hasScheduledMonitor` in recovery/issue-graph-liveness.ts is a third copy of this
 *   rule and is deliberately left alone. It is already future-bounded — on the safe
 *   side of the invariant, no defect — and that module is pure by construction
 *   (`@paperclipai/shared` and one sibling only, its own structural row type and date
 *   readers), so importing this file into it would cost more than the duplication.
 */
export function isMonitorNextCheckAtLive(
  nextCheckAt: Date | string | null | undefined,
  nowMs: number,
): boolean {
  const parsed = nextCheckAt instanceof Date
    ? (Number.isNaN(nextCheckAt.getTime()) ? null : nextCheckAt)
    : parseMonitorDate(nextCheckAt ?? null);
  return parsed !== null && parsed.getTime() > nowMs;
}

function nextAssigneeIds(input: {
  issue: IssueLike;
  requestedAssigneePatch: RequestedAssigneePatch;
  stagePatch: Record<string, unknown>;
}) {
  const assigneeAgentId =
    input.stagePatch.assigneeAgentId !== undefined
      ? (input.stagePatch.assigneeAgentId as string | null)
      : input.requestedAssigneePatch.assigneeAgentId !== undefined
        ? input.requestedAssigneePatch.assigneeAgentId ?? null
        : input.issue.assigneeAgentId ?? null;
  const assigneeUserId =
    input.stagePatch.assigneeUserId !== undefined
      ? (input.stagePatch.assigneeUserId as string | null)
      : input.requestedAssigneePatch.assigneeUserId !== undefined
        ? input.requestedAssigneePatch.assigneeUserId ?? null
        : input.issue.assigneeUserId ?? null;
  return { assigneeAgentId, assigneeUserId };
}

export function stripMonitorFromExecutionPolicy(policy: IssueExecutionPolicy | null): IssueExecutionPolicy | null {
  if (!policy) return null;
  if (!policy.monitor) return policy;
  const { monitor: _monitor, ...rest } = policy;
  // BLO-18816: mirror `normalizeIssueExecutionPolicy`'s emptiness rule exactly.
  // This used to rebuild `{mode, commentRequired, stages}` and so silently
  // dropped `reviewPreset`/`authorizationPolicy` from every clear path — the
  // same class of loss the monitor write path exists to prevent, arriving via
  // the clear instead of the arm. The rest-spread is what keeps BLO-39945's
  // `productivityReviewDisabled` too, without this function having to name it
  // — an allowlist is how that field came to be dropped in the first place.
  // Only the emptiness guard still enumerates, because it has to.
  if (
    rest.stages.length === 0 &&
    !rest.reviewPreset &&
    !rest.authorizationPolicy &&
    !rest.productivityReviewDisabled
  ) {
    return null;
  }
  return rest;
}

export function setIssueExecutionPolicyMonitorScheduledBy(
  policy: IssueExecutionPolicy | null,
  scheduledBy: IssueMonitorScheduledBy,
): IssueExecutionPolicy | null {
  if (!policy?.monitor) return policy;
  return {
    ...policy,
    monitor: {
      ...policy.monitor,
      scheduledBy,
    },
  };
}

/**
 * Merge a requested monitor into an existing policy rather than replacing the
 * policy outright.
 *
 * `PATCH /issues/:id` writes `executionPolicy` wholesale, which is correct for
 * an actor who already holds general mutation authority over the issue. It is
 * wrong for the narrow manager-chain monitor re-arm (BLO-22860): that actor is
 * *not* the assignee and holds no general mutation grant, so restoring a lapsed
 * timer must not also drop the report's `stages`, `reviewPreset`,
 * `authorizationPolicy` or `mode` as a side effect.
 */
export function mergeIssueExecutionPolicyMonitor(
  previous: IssueExecutionPolicy | null,
  monitor: IssueExecutionMonitorPolicy | null,
): IssueExecutionPolicy | null {
  if (!monitor) return previous;
  if (!previous) {
    return { mode: "normal", commentRequired: true, stages: [], monitor };
  }
  return { ...previous, monitor };
}

export function normalizeIssueExecutionPolicy(input: unknown): IssueExecutionPolicy | null {
  if (input == null) return null;
  const parsed = issueExecutionPolicySchema.safeParse(input);
  if (!parsed.success) {
    throw unprocessable("Invalid execution policy", parsed.error.flatten());
  }

  const stages = parsed.data.stages
    .map((stage) => {
      const participants: IssueExecutionStage["participants"] = stage.participants
        .map((participant) => ({
          id: participant.id ?? randomUUID(),
          type: participant.type,
          agentId: participant.type === "agent" ? participant.agentId ?? null : null,
          userId: participant.type === "user" ? participant.userId ?? null : null,
        }))
        .filter((participant) => (participant.type === "agent" ? Boolean(participant.agentId) : Boolean(participant.userId)));

      const dedupedParticipants: IssueExecutionStage["participants"] = [];
      const seen = new Set<string>();
      for (const participant of participants) {
        const key = participant.type === "agent" ? `agent:${participant.agentId}` : `user:${participant.userId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        dedupedParticipants.push(participant);
      }

      if (dedupedParticipants.length === 0) return null;
      return {
        id: stage.id ?? randomUUID(),
        type: stage.type,
        approvalsNeeded: 1 as const,
        participants: dedupedParticipants,
      };
    })
    .filter((stage): stage is NonNullable<typeof stage> => stage !== null);

  const monitor = parsed.data.monitor
    ? {
      nextCheckAt: parsed.data.monitor.nextCheckAt,
      notes: normalizeMonitorNotes(parsed.data.monitor.notes),
      scheduledBy: parsed.data.monitor.scheduledBy,
      kind: parsed.data.monitor.kind ?? null,
      serviceName: normalizeMonitorText(parsed.data.monitor.serviceName),
      externalRef: redactIssueMonitorExternalRef(parsed.data.monitor.externalRef),
      timeoutAt: parsed.data.monitor.timeoutAt ?? null,
      maxAttempts: parsed.data.monitor.maxAttempts ?? null,
      recoveryPolicy: parsed.data.monitor.recoveryPolicy ?? null,
      productivityReviewDisabled: parsed.data.monitor.productivityReviewDisabled ?? false,
      // BLO-18294: normalized here so two arms that declare the same gates in a
      // different order or casing produce the same convergence fingerprint.
      gateSignals: normalizeIssueMonitorGateSignals(parsed.data.monitor.gateSignals),
    }
    : null;

  const reviewPreset = parsed.data.reviewPreset;
  const authorizationPolicy = parsed.data.authorizationPolicy;
  // BLO-39945: part of the collapse guard below, not an afterthought. A policy
  // carrying ONLY this flag must survive normalization — otherwise the write
  // returns 200, normalizes to null, and the opt-out silently never happened.
  const productivityReviewDisabled = parsed.data.productivityReviewDisabled === true;

  if (stages.length === 0 && !monitor && !reviewPreset && !authorizationPolicy && !productivityReviewDisabled) return null;

  return {
    mode: parsed.data.mode ?? "normal",
    commentRequired: true,
    stages,
    ...(monitor ? { monitor } : {}),
    ...(reviewPreset ? { reviewPreset } : {}),
    ...(authorizationPolicy ? { authorizationPolicy } : {}),
    // Emitted only when true, so every existing policy normalizes byte-identically.
    ...(productivityReviewDisabled ? { productivityReviewDisabled: true } : {}),
  };
}

export function parseIssueExecutionState(input: unknown): IssueExecutionState | null {
  if (input == null) return null;
  const parsed = issueExecutionStateSchema.safeParse(input);
  if (!parsed.success) return null;
  return parsed.data;
}

export function assigneePrincipal(input: AssigneeLike): IssueExecutionStagePrincipal | null {
  if (input.assigneeAgentId) {
    return { type: "agent", agentId: input.assigneeAgentId, userId: null };
  }
  if (input.assigneeUserId) {
    return { type: "user", userId: input.assigneeUserId, agentId: null };
  }
  return null;
}

function actorPrincipal(actor: ActorLike): IssueExecutionStagePrincipal | null {
  if (actor.agentId) return { type: "agent", agentId: actor.agentId, userId: null };
  if (actor.userId) return { type: "user", userId: actor.userId, agentId: null };
  return null;
}

function principalsEqual(a: IssueExecutionStagePrincipal | null, b: IssueExecutionStagePrincipal | null): boolean {
  if (!a || !b) return false;
  if (a.type !== b.type) return false;
  return a.type === "agent" ? a.agentId === b.agentId : a.userId === b.userId;
}

function findStageById(policy: IssueExecutionPolicy, stageId: string | null | undefined) {
  if (!stageId) return null;
  return policy.stages.find((stage) => stage.id === stageId) ?? null;
}

function nextPendingStage(policy: IssueExecutionPolicy, state: IssueExecutionState | null) {
  const completed = new Set(state?.completedStageIds ?? []);
  return policy.stages.find((stage) => !completed.has(stage.id)) ?? null;
}

function selectStageParticipant(
  stage: IssueExecutionStage,
  opts?: {
    preferred?: IssueExecutionStagePrincipal | null;
    exclude?: IssueExecutionStagePrincipal | null;
  },
): IssueExecutionStagePrincipal | null {
  const participants = stage.participants.filter((participant) => !principalsEqual(participant, opts?.exclude ?? null));
  if (participants.length === 0) return null;
  if (opts?.preferred) {
    const preferred = participants.find((participant) => principalsEqual(participant, opts.preferred ?? null));
    if (preferred) return preferred;
  }
  const first = participants[0];
  return first ? { type: first.type, agentId: first.agentId ?? null, userId: first.userId ?? null } : null;
}

function stageHasParticipant(stage: IssueExecutionStage, participant: IssueExecutionStagePrincipal | null): boolean {
  if (!participant) return false;
  return stage.participants.some((candidate) => principalsEqual(candidate, participant));
}

function patchForPrincipal(principal: IssueExecutionStagePrincipal | null) {
  if (!principal) {
    return { assigneeAgentId: null, assigneeUserId: null };
  }
  return principal.type === "agent"
    ? { assigneeAgentId: principal.agentId ?? null, assigneeUserId: null }
    : { assigneeAgentId: null, assigneeUserId: principal.userId ?? null };
}

function buildCompletedState(previous: IssueExecutionState | null, currentStage: IssueExecutionStage): IssueExecutionState {
  const completedStageIds = Array.from(new Set([...(previous?.completedStageIds ?? []), currentStage.id]));
  return {
    status: COMPLETED_STATUS,
    currentStageId: null,
    currentStageIndex: null,
    currentStageType: null,
    currentParticipant: null,
    returnAssignee: previous?.returnAssignee ?? null,
    reviewRequest: null,
    completedStageIds,
    lastDecisionId: previous?.lastDecisionId ?? null,
    lastDecisionOutcome: "approved",
    monitor: previous?.monitor ?? null,
  };
}

function buildStateWithCompletedStages(input: {
  previous: IssueExecutionState | null;
  completedStageIds: string[];
  returnAssignee: IssueExecutionStagePrincipal | null;
}): IssueExecutionState {
  return {
    status: input.previous?.status ?? PENDING_STATUS,
    currentStageId: input.previous?.currentStageId ?? null,
    currentStageIndex: input.previous?.currentStageIndex ?? null,
    currentStageType: input.previous?.currentStageType ?? null,
    currentParticipant: input.previous?.currentParticipant ?? null,
    returnAssignee: input.previous?.returnAssignee ?? input.returnAssignee,
    reviewRequest: input.previous?.reviewRequest ?? null,
    completedStageIds: input.completedStageIds,
    lastDecisionId: input.previous?.lastDecisionId ?? null,
    lastDecisionOutcome: input.previous?.lastDecisionOutcome ?? null,
    monitor: input.previous?.monitor ?? null,
  };
}

function buildSkippedStageCompletedState(input: {
  previous: IssueExecutionState | null;
  completedStageIds: string[];
  returnAssignee: IssueExecutionStagePrincipal | null;
}): IssueExecutionState {
  return {
    status: COMPLETED_STATUS,
    currentStageId: null,
    currentStageIndex: null,
    currentStageType: null,
    currentParticipant: null,
    returnAssignee: input.previous?.returnAssignee ?? input.returnAssignee,
    reviewRequest: null,
    completedStageIds: input.completedStageIds,
    lastDecisionId: input.previous?.lastDecisionId ?? null,
    lastDecisionOutcome: input.previous?.lastDecisionOutcome ?? null,
    monitor: input.previous?.monitor ?? null,
  };
}

function buildPendingState(input: {
  previous: IssueExecutionState | null;
  stage: IssueExecutionStage;
  stageIndex: number;
  participant: IssueExecutionStagePrincipal;
  returnAssignee: IssueExecutionStagePrincipal | null;
  reviewRequest?: IssueExecutionState["reviewRequest"] | null;
}): IssueExecutionState {
  return {
    status: PENDING_STATUS,
    currentStageId: input.stage.id,
    currentStageIndex: input.stageIndex,
    currentStageType: input.stage.type,
    currentParticipant: input.participant,
    returnAssignee: input.returnAssignee,
    reviewRequest: input.reviewRequest ?? null,
    completedStageIds: input.previous?.completedStageIds ?? [],
    lastDecisionId: input.previous?.lastDecisionId ?? null,
    lastDecisionOutcome: input.previous?.lastDecisionOutcome ?? null,
    monitor: input.previous?.monitor ?? null,
  };
}

function buildChangesRequestedState(previous: IssueExecutionState, currentStage: IssueExecutionStage): IssueExecutionState {
  return {
    ...previous,
    status: CHANGES_REQUESTED_STATUS,
    currentStageId: currentStage.id,
    currentStageType: currentStage.type,
    reviewRequest: null,
    lastDecisionOutcome: "changes_requested",
  };
}

function buildPendingStagePatch(input: {
  patch: Record<string, unknown>;
  previous: IssueExecutionState | null;
  policy: IssueExecutionPolicy;
  stage: IssueExecutionStage;
  participant: IssueExecutionStagePrincipal;
  returnAssignee: IssueExecutionStagePrincipal | null;
  reviewRequest?: IssueExecutionState["reviewRequest"] | null;
}) {
  input.patch.status = "in_review";
  Object.assign(input.patch, patchForPrincipal(input.participant));
  input.patch.executionState = buildPendingState({
    previous: input.previous,
    stage: input.stage,
    stageIndex: input.policy.stages.findIndex((candidate) => candidate.id === input.stage.id),
    participant: input.participant,
    returnAssignee: input.returnAssignee,
    reviewRequest: input.reviewRequest,
  });
}

function clearExecutionStatePatch(input: {
  patch: Record<string, unknown>;
  issueStatus: string;
  requestedStatus?: string;
  returnAssignee: IssueExecutionStagePrincipal | null;
}) {
  input.patch.executionState = null;
  if (input.requestedStatus === undefined && input.issueStatus === "in_review" && input.returnAssignee) {
    input.patch.status = "in_progress";
    Object.assign(input.patch, patchForPrincipal(input.returnAssignee));
  }
}

function canAutoSkipPendingStage(input: {
  stage: IssueExecutionStage;
  returnAssignee: IssueExecutionStagePrincipal | null;
  requestedStatus?: string;
}) {
  if (input.requestedStatus !== "done" || input.stage.type !== "review" || !input.returnAssignee) {
    return false;
  }
  return input.stage.participants.length > 0 &&
    input.stage.participants.every((participant) => principalsEqual(participant, input.returnAssignee));
}

function applyIssueExecutionStageTransition(input: TransitionInput): TransitionResult {
  const patch: Record<string, unknown> = {};
  const existingState = parseIssueExecutionState(input.issue.executionState);
  const currentAssignee = assigneePrincipal(input.issue);
  const actor = actorPrincipal(input.actor);
  const requestedAssigneePatchProvided =
    input.requestedAssigneePatch.assigneeAgentId !== undefined || input.requestedAssigneePatch.assigneeUserId !== undefined;
  const explicitAssignee = assigneePrincipal(input.requestedAssigneePatch);
  const currentStage = input.policy ? findStageById(input.policy, existingState?.currentStageId) : null;
  const requestedStatus = input.requestedStatus;
  const activeStage = currentStage && existingState?.status === PENDING_STATUS ? currentStage : null;
  const effectiveReviewRequest = input.reviewRequest === undefined
    ? existingState?.reviewRequest ?? null
    : input.reviewRequest;

  if (!input.policy) {
    if (existingState) {
      patch.executionState = null;
      if (input.issue.status === "in_review" && existingState.returnAssignee) {
        patch.status = "in_progress";
        Object.assign(patch, patchForPrincipal(existingState.returnAssignee));
      }
    }
    return { patch };
  }

  if (
    (input.issue.status === "done" || input.issue.status === "cancelled") &&
    requestedStatus &&
    requestedStatus !== "done" &&
    requestedStatus !== "cancelled"
  ) {
    patch.executionState = null;
    return { patch };
  }

  // BLO-33728: cancelling while the stage sits in `changes_requested` (the work
  // is back with the return assignee, so there is no active stage) reaches none
  // of the branches below — `shouldStartWorkflow` covers only done/in_review —
  // and so used to return an empty patch, leaving a live `currentStageId` on a
  // terminal issue. Drop only the live pointers: `lastDecisionOutcome` and
  // `completedStageIds` are real history, and a genuine `changes_requested`
  // must still read back as `changes_requested`. Reopening still nulls the
  // whole state via the terminal -> active branch above, so the review path is
  // rebuilt from scratch rather than resumed against a discharged stage.
  if (
    requestedStatus === "cancelled" &&
    existingState?.status === CHANGES_REQUESTED_STATUS &&
    existingState.currentStageId
  ) {
    patch.executionState = {
      ...existingState,
      currentStageId: null,
      currentStageIndex: null,
      currentStageType: null,
      currentParticipant: null,
      reviewRequest: null,
    };
    return { patch };
  }

  if (existingState?.currentStageId && !currentStage) {
    clearExecutionStatePatch({
      patch,
      issueStatus: input.issue.status,
      requestedStatus,
      returnAssignee: existingState.returnAssignee,
    });
    return { patch };
  }

  if (activeStage) {
    const currentParticipant =
      existingState?.currentParticipant ??
      selectStageParticipant(activeStage, {
        exclude: existingState?.returnAssignee ?? null,
      });
    if (!currentParticipant) {
      throw unprocessable(`No eligible ${activeStage.type} participant is configured for this issue`);
    }

    // A blocked transition is a status correction, not a stage advance or
    // "requesting changes" action. Clear the pending execution state so a
    // future PATCH on the blocked issue does not drift back to in_review.
    if (requestedStatus === "blocked") {
      patch.executionState = null;
      return { patch };
    }

    if (!stageHasParticipant(activeStage, currentParticipant)) {
      const participant = selectStageParticipant(activeStage, {
        preferred: explicitAssignee ?? existingState?.currentParticipant ?? null,
        exclude: existingState?.returnAssignee ?? null,
      });
      if (!participant) {
        clearExecutionStatePatch({
          patch,
          issueStatus: input.issue.status,
          requestedStatus,
          returnAssignee: existingState?.returnAssignee ?? null,
        });
        return { patch };
      }

      buildPendingStagePatch({
        patch,
        previous: existingState,
        policy: input.policy,
        stage: activeStage,
        participant,
        returnAssignee: existingState?.returnAssignee ?? currentAssignee ?? actor,
        reviewRequest: effectiveReviewRequest,
      });
      return {
        patch,
        workflowControlledAssignment: true,
      };
    }

    // BLO-15942: an authorized override acts with the same stage authority as
    // the pinned participant (the route only sets this after an explicit
    // tasks:override_execution_stage authorization check), so a stage cannot
    // permanently deadlock on a participant whose mandate excludes stage
    // decisions.
    if (principalsEqual(currentParticipant, actor) || input.overrideAuthorized) {
      if (requestedStatus === "done") {
        if (!input.commentBody?.trim()) {
          throw unprocessable("Approving a review or approval stage requires a comment");
        }
        const approvedState = buildCompletedState(existingState, activeStage);
        const nextStage = nextPendingStage(
          input.policy,
          { ...approvedState, completedStageIds: approvedState.completedStageIds },
        );

        if (!nextStage) {
          patch.executionState = approvedState;
          return {
            patch,
            decision: {
              stageId: activeStage.id,
              stageType: activeStage.type,
              outcome: "approved",
              body: input.commentBody.trim(),
            },
          };
        }

        const participant = selectStageParticipant(nextStage, {
          preferred: explicitAssignee,
          exclude: existingState?.returnAssignee ?? null,
        });
        if (!participant) {
          throw unprocessable(`No eligible ${nextStage.type} participant is configured for this issue`);
        }

        buildPendingStagePatch({
          patch,
          previous: approvedState,
          policy: input.policy,
          stage: nextStage,
          participant,
          returnAssignee: existingState?.returnAssignee ?? currentAssignee ?? actor,
          reviewRequest: input.reviewRequest ?? null,
        });
        return {
          patch,
          decision: {
            stageId: activeStage.id,
            stageType: activeStage.type,
            outcome: "approved",
            body: input.commentBody.trim(),
          },
          workflowControlledAssignment: true,
        };
      }

      if (requestedStatus && requestedStatus !== "in_review") {
        if (!input.commentBody?.trim()) {
          throw unprocessable("Requesting changes requires a comment");
        }
        if (!existingState?.returnAssignee) {
          throw unprocessable("This execution stage has no return assignee");
        }
        patch.status = "in_progress";
        Object.assign(patch, patchForPrincipal(existingState.returnAssignee));
        patch.executionState = buildChangesRequestedState(existingState, activeStage);
        return {
          patch,
          decision: {
            stageId: activeStage.id,
            stageType: activeStage.type,
            outcome: "changes_requested",
            body: input.commentBody.trim(),
          },
          workflowControlledAssignment: true,
        };
      }
    }

    const attemptedStageAdvance =
      (requestedStatus !== undefined && requestedStatus !== "in_review") ||
      (requestedAssigneePatchProvided && !principalsEqual(explicitAssignee, currentParticipant));
    const stageStateDrifted =
      input.issue.status !== "in_review" ||
      !principalsEqual(currentAssignee, currentParticipant) ||
      !principalsEqual(existingState?.currentParticipant ?? null, currentParticipant);

    if (attemptedStageAdvance && !stageStateDrifted) {
      throw unprocessable("Only the active reviewer or approver can advance the current execution stage");
    }

    // BLO-36237: drift repair rewrites the issue back to `in_review`, which
    // silently discards a requested terminal status and still returns 200 —
    // a split-comment approve (or an approve from the wrong seat) then reads
    // as success while the stage re-pends and the recovery sweep loops.
    // Fail loudly with the shape that would actually record the decision.
    if (stageStateDrifted && (requestedStatus === "done" || requestedStatus === "cancelled")) {
      throw unprocessable(
        `Cannot move to ${requestedStatus}: the ${activeStage.type} stage is pending on its participant. ` +
          'Only that participant (or an authorized override) can decide it, with {"status":"done","comment":"..."} ' +
          "in ONE PATCH; a comment posted separately is not a stage decision",
        { currentParticipant, stageType: activeStage.type },
      );
    }

    if (stageStateDrifted) {
      buildPendingStagePatch({
        patch,
        previous: existingState,
        policy: input.policy,
        stage: activeStage,
        participant: currentParticipant,
        returnAssignee: existingState?.returnAssignee ?? currentAssignee ?? actor,
        reviewRequest: effectiveReviewRequest,
      });
      return {
        patch,
        workflowControlledAssignment: true,
      };
    }

    return { patch };
  }

  const shouldStartWorkflow =
    requestedStatus === "done" ||
    requestedStatus === "in_review";

  if (!shouldStartWorkflow) {
    return { patch };
  }

  let pendingStage =
    existingState?.status === CHANGES_REQUESTED_STATUS && currentStage
      ? currentStage
      : nextPendingStage(input.policy, existingState);
  if (!pendingStage) return { patch };

  const returnAssignee = existingState?.returnAssignee ?? currentAssignee;
  const skippedStageIds = [...(existingState?.completedStageIds ?? [])];
  let participant = selectStageParticipant(pendingStage, {
    preferred:
      existingState?.status === CHANGES_REQUESTED_STATUS
        ? explicitAssignee ?? existingState.currentParticipant ?? null
        : explicitAssignee,
    exclude: returnAssignee,
  });
  while (!participant && canAutoSkipPendingStage({ stage: pendingStage, returnAssignee, requestedStatus })) {
    skippedStageIds.push(pendingStage.id);
    pendingStage = nextPendingStage(
      input.policy,
      buildStateWithCompletedStages({
        previous: existingState,
        completedStageIds: skippedStageIds,
        returnAssignee,
      }),
    );
    if (!pendingStage) {
      patch.executionState = buildSkippedStageCompletedState({
        previous: existingState,
        completedStageIds: skippedStageIds,
        returnAssignee,
      });
      return { patch };
    }
    participant = selectStageParticipant(pendingStage, {
      preferred:
        existingState?.status === CHANGES_REQUESTED_STATUS
          ? explicitAssignee ?? existingState.currentParticipant ?? null
          : explicitAssignee,
      exclude: returnAssignee,
    });
  }
  if (!participant) {
    throw unprocessable(`No eligible ${pendingStage.type} participant is configured for this issue`);
  }

  buildPendingStagePatch({
    patch,
    previous:
      skippedStageIds.length === (existingState?.completedStageIds ?? []).length
        ? existingState
        : buildStateWithCompletedStages({
            previous: existingState,
            completedStageIds: skippedStageIds,
            returnAssignee,
          }),
    policy: input.policy,
    stage: pendingStage,
    participant,
    returnAssignee,
    reviewRequest: input.reviewRequest ?? null,
  });
  return {
    patch,
    workflowControlledAssignment: true,
  };
}

/**
 * PEN-1995: `issues.monitorNotes` describes the monitor that is currently armed.
 * Every clear path already nulls `monitorNextCheckAt`/`monitorWakeRequestedAt`
 * but used to leave the notes column populated, so a retired monitor's notes
 * survived as a live-looking instruction. Observed cost: notes registering a
 * discriminator to read at a trigger time outlived their monitor by four days,
 * and the next reader treated them as an active gate.
 *
 * PEN-5902: this used to say the audit copy on `executionState.monitor.notes`
 * made nulling the column lossless. That copy is where the same defect went to
 * hide — it is reachable by every reader of the row, named identically to the
 * live field, and no verb could write to it. `buildClearedMonitorState` now
 * keeps it only for the one clear reason with a deferred consumer
 * (`clearedMonitorKeepsNotes`). What makes nulling the column lossless is the
 * `issue.monitor_cleared` activity entry, which records `notes` read from the
 * pre-clear row on every clear path.
 *
 * Applied by every clear site so a future branch cannot forget one.
 */
function clearArmedMonitorColumns(patch: Record<string, unknown>) {
  patch.monitorNextCheckAt = null;
  patch.monitorWakeRequestedAt = null;
  patch.monitorNotes = null;
}

function applyMonitorTransition(
  input: TransitionInput,
  stagePatch: Record<string, unknown>,
): { patch: Record<string, unknown>; convergence: IssueMonitorConvergence | null } {
  const patch: Record<string, unknown> = {};
  let convergence: IssueMonitorConvergence | null = null;
  const previousPolicy = input.previousPolicy ?? normalizeIssueExecutionPolicy(input.issue.executionPolicy ?? null);
  const existingState = parseIssueExecutionState(input.issue.executionState);
  const currentMonitorState = derivePersistedMonitorState({
    issue: input.issue,
    state: existingState,
    policy: previousPolicy,
  });
  const nextStatus =
    typeof stagePatch.status === "string"
      ? (stagePatch.status as string)
      : input.requestedStatus ?? input.issue.status;
  let { assigneeAgentId, assigneeUserId } = nextAssigneeIds({
    issue: input.issue,
    requestedAssigneePatch: input.requestedAssigneePatch,
    stagePatch,
  });
  const canRestoreEffectiveMonitorAssignee =
    input.policy?.monitor &&
    input.effectiveMonitorAssigneeAgentId &&
    !assigneeAgentId &&
    !assigneeUserId &&
    input.requestedAssigneePatch.assigneeAgentId === undefined &&
    input.requestedAssigneePatch.assigneeUserId === undefined &&
    (nextStatus === "in_progress" || nextStatus === "in_review");
  if (canRestoreEffectiveMonitorAssignee) {
    assigneeAgentId = input.effectiveMonitorAssigneeAgentId ?? null;
    patch.assigneeAgentId = assigneeAgentId;
    patch.assigneeUserId = null;
  }
  const stageState =
    stagePatch.executionState !== undefined
      ? parseIssueExecutionState(stagePatch.executionState)
      : existingState;
  const invalidReason = input.policy?.monitor
    ? monitorClearReasonForIssue(nextStatus, assigneeAgentId, assigneeUserId)
    : null;

  let targetMonitorState = currentMonitorState;
  const resetConvergenceAfterStalledClear = Boolean(
    input.monitorExplicitlyUpdated &&
    input.policy?.monitor &&
    currentMonitorState?.status === "cleared" &&
    currentMonitorState.clearReason === "convergence_stalled" &&
    !invalidReason,
  );
  const convergenceBaseMonitorState = resetConvergenceAfterStalledClear
    ? resetMonitorConvergenceFields(currentMonitorState)
    : currentMonitorState;
  const sameAssigneeResetAfterPriorStall = Boolean(
    resetConvergenceAfterStalledClear &&
    (currentMonitorState?.convergenceStallCount ?? 0) > 0 &&
    input.actor.agentId &&
    input.actor.agentId === (
      currentMonitorState?.convergenceStalledAssigneeAgentId ?? input.issue.assigneeAgentId ?? null
    ),
  );

  if (input.policy?.monitor) {
    if (invalidReason) {
      if (input.monitorExplicitlyUpdated) {
        throw unprocessable(MONITOR_INVALID_MESSAGE);
      }
      patch.executionPolicy = stripMonitorFromExecutionPolicy(input.policy);
      clearArmedMonitorColumns(patch);
      targetMonitorState = buildClearedMonitorState({
        previous: currentMonitorState,
        clearReason: invalidReason,
        clearedAt: new Date(),
      });
    } else {
      // PEN-3803: supply the scheduler's ceiling so this validator asks the
      // question the scheduler will ask. Omitting it made the two disagree
      // about the same bound: at `attemptCount >= DEFAULT_ISSUE_MONITOR_MAX_ATTEMPTS`
      // with `maxAttempts: null`, the arm resolved the bound to `null`, returned
      // 200, and the row read as a live wake until dispatch cleared it as
      // `max_attempts_exhausted` without firing (measured on PEN-3328: armed
      // 2026-10-03T23:50Z for 2026-10-04T23:30Z, cleared at the due second,
      // `lastTriggeredAt` predating the arm). An explicit `maxAttempts` still
      // wins over the default, which is what keeps a deliberate budget
      // extension possible — see `renewedIssueMonitorMaxAttempts`.
      //
      // ⚠️ ONLY on an explicit arm. This predicate has two consumers just below
      // and they are not symmetric. An explicit arm THROWS 422 — loud, at the
      // caller, before anything is persisted. A non-explicit transition instead
      // STRIPS the monitor and records it cleared: silent, no activity row, no
      // `recoveryPolicy`, because `buildClearedMonitorState` is a pure state
      // builder. That branch runs on every generic `PATCH /api/issues/:id` that
      // leaves `executionPolicy` alone, since `nextExecutionPolicy` falls back
      // to the stored policy and carries its armed monitor in with
      // `monitorExplicitlyUpdated` false (routes/issues.ts).
      //
      // Applying the fleet ceiling there would silently destroy the exact
      // population this fix exists for. A legacy row at `attemptCount >= 24`
      // with `maxAttempts: null` — what the old 200 path created, PEN-3328
      // included — survives any unrelated PATCH today and reaches the
      // scheduler, which retires it LOUDLY through `clearIssueMonitorAndRecover`
      // (`issue.monitor_exhausted` plus the configured `recoveryPolicy`,
      // heartbeat.ts). Stripping it here would trade that escalation for a
      // silent clear triggered by an unrelated edit — a priority change, a
      // comment, a status move.
      //
      // Deliverability is the ARM's question. Carrying an already-armed monitor
      // forward is not an arm, so the scheduler stays the one place that retires
      // a spent monitor, and it does so with the escalation attached.
      const exhaustedReason = exhaustedMonitorClearReason({
        monitor: input.policy.monitor,
        attemptCount: currentMonitorState?.attemptCount ?? 0,
        now: new Date(),
        // Non-explicit transitions keep the pre-PEN-3803 resolution — the
        // issue-declared bound only. An explicit `maxAttempts` the row has
        // already reached still strips exactly as it always did; only the
        // default is withheld, and only here.
        ...(input.monitorExplicitlyUpdated
          ? { defaultMaxAttempts: DEFAULT_ISSUE_MONITOR_MAX_ATTEMPTS }
          : {}),
      });
      if (exhaustedReason) {
        if (input.monitorExplicitlyUpdated) {
          throw unprocessable(
            MONITOR_BOUNDS_EXHAUSTED_MESSAGE,
            monitorBoundsExhaustedDetails({
              clearReason: exhaustedReason,
              monitor: input.policy.monitor,
              attemptCount: currentMonitorState?.attemptCount ?? 0,
            }),
          );
        }
        patch.executionPolicy = stripMonitorFromExecutionPolicy(input.policy);
        clearArmedMonitorColumns(patch);
        targetMonitorState = buildClearedMonitorState({
          previous: currentMonitorState,
          clearReason: exhaustedReason,
          clearedAt: new Date(),
        });
      } else {
        // BLO-18294: refuse to re-arm a monitor that has re-checked the same gate
        // set `threshold` times running. Polling cannot move a gate that polling
        // has already failed to move; escalate to `blocked` so the blocker set
        // becomes visible work for named owners instead of billable silence.
        // Only an explicit arm/re-arm is evaluated. Transitions that merely carry
        // an existing monitor forward (a status-only return, a stage auto-approval)
        // are not re-checks, and those call sites do not supply blocker edges —
        // scoring them would reset the counter against an empty gate set.
        // Provider-quota recovery scheduling passes no actor agent id, so this
        // same-assignee guard cannot block that recovery-owned monitor path.
        const preserveConvergence = input.monitorExplicitlyUpdated && input.unresolvedBlockerIssueIds === null;
        if (sameAssigneeResetAfterPriorStall) {
          throw unprocessable(MONITOR_CONVERGENCE_RESET_REQUIRES_NON_ASSIGNEE_MESSAGE);
        }
        const gateSetKnown = input.monitorExplicitlyUpdated && input.unresolvedBlockerIssueIds !== null;
        convergence = gateSetKnown
          ? evaluateIssueMonitorConvergence({
            monitor: input.policy.monitor,
            previous: convergenceBaseMonitorState,
            unresolvedBlockerIssueIds: input.unresolvedBlockerIssueIds ?? [],
            threshold: input.monitorConvergenceThreshold ?? null,
          })
          : null;
        // PEN-6228: the evaluator returns null for a monitor it does not score
        // (`external_service`, or board/manager-scheduled). Record the gate
        // identity anyway whenever this arm knows the gate set, so the stored
        // `gateFingerprint`/`gateSource` describe the `gateSignals` persisted by
        // this same write rather than a digest from an earlier, unrelated era.
        // Only `convergenceCount` stays exempt — that is what the guard is for.
        const gateIdentity = gateSetKnown && !convergence
          ? computeIssueMonitorGateFingerprint({
            gateSignals: input.policy.monitor.gateSignals,
            unresolvedBlockerIssueIds: input.unresolvedBlockerIssueIds ?? [],
            notes: input.policy.monitor.notes,
          })
          : null;
        if (convergence?.converged) {
          patch.executionPolicy = stripMonitorFromExecutionPolicy(input.policy);
          clearArmedMonitorColumns(patch);
          patch.status = "blocked";
          targetMonitorState = buildClearedMonitorState({
            previous: currentMonitorState,
            clearReason: "convergence_stalled",
            clearedAt: new Date(),
            convergence,
            assigneeAgentId: input.actor.agentId ?? assigneeAgentId,
          });
        } else {
          patch.monitorNextCheckAt = new Date(input.policy.monitor.nextCheckAt);
          patch.monitorWakeRequestedAt = null;
          patch.monitorNotes = input.policy.monitor.notes ?? null;
          patch.monitorScheduledBy = input.policy.monitor.scheduledBy;
          targetMonitorState = buildScheduledMonitorState(
            convergenceBaseMonitorState,
            input.policy.monitor,
            convergence,
            { preserveConvergence, gateIdentity },
          );
        }
      }
    }
  } else if (
    previousPolicy?.monitor ||
    // BLO-18816 / BLO-27586 AC1: once a monitor fires,
    // `buildIssueMonitorTriggeredPatch` strips it out of `executionPolicy`
    // (returning null outright for a monitor-only policy), so a `triggered`
    // monitor lives ONLY in `executionState`. Keying the clear on
    // `previousPolicy.monitor` alone therefore made a clear a silent 200 no-op
    // with the stale notes intact, and re-arm 422s once attempts are exhausted
    // — no exit in either direction.
    //
    // Deliberately gated on `monitorExplicitlyUpdated`. Dropping that gate is
    // the naive fix and it is worse: every incidental carry-forward transition
    // (a status-only return, a stage auto-approval) would then destroy the
    // `triggered` state that `tickExpiredIssueMonitors` needs to run the
    // monitor's `recoveryPolicy`, trading a visible no-op for a silent
    // cancellation. Only a caller who explicitly wrote the monitor clears it.
    (input.monitorExplicitlyUpdated && currentMonitorState && currentMonitorState.status !== "cleared")
  ) {
    clearArmedMonitorColumns(patch);
    targetMonitorState = buildClearedMonitorState({
      previous: currentMonitorState,
      clearReason:
        input.monitorExplicitlyUpdated
          ? "manual"
          : monitorClearReasonForIssue(nextStatus, assigneeAgentId, assigneeUserId) ?? "manual",
      clearedAt: new Date(),
    });
  } else if (
    // PEN-5902: an explicit clear of an ALREADY-cleared monitor, which the
    // branch above deliberately declines. Rows cleared before that change
    // still hold the retired monitor's `notes`, and a re-clear through the
    // branch above would be the wrong repair — it would stamp a fresh
    // `clearedAt`, overwrite `clearReason` with `manual` and reset
    // `recoveryEmittedAt`, falsifying when the monitor actually died and
    // re-arming a recovery handoff that was already discharged.
    //
    // So scrub the one free-prose field and leave the audit record alone.
    // `monitorStatesEqual` makes this a no-op write when the notes are
    // already empty, which is every row cleared after that change.
    input.monitorExplicitlyUpdated &&
    currentMonitorState?.status === "cleared" &&
    currentMonitorState.notes != null &&
    // Never destroy an input the deferred cancelled-recovery pass has not
    // consumed yet — it re-hydrates the notes from here precisely because the
    // column is gone by the time it runs.
    !(clearedMonitorKeepsNotes(currentMonitorState.clearReason ?? "manual") && !currentMonitorState.recoveryEmittedAt)
  ) {
    clearArmedMonitorColumns(patch);
    targetMonitorState = { ...currentMonitorState, notes: null };
  }

  if (stagePatch.executionState !== undefined || !monitorStatesEqual(currentMonitorState, targetMonitorState)) {
    patch.executionState = executionStateWithMonitor(stageState, targetMonitorState);
  }

  return { patch, convergence };
}

export function buildInitialIssueMonitorFields(input: {
  policy: IssueExecutionPolicy | null;
  status: string;
  assigneeAgentId?: string | null;
  assigneeUserId?: string | null;
}) {
  if (!input.policy?.monitor) return {};
  if (!issueAllowsMonitor(input.status, input.assigneeAgentId ?? null, input.assigneeUserId ?? null)) {
    throw unprocessable(MONITOR_INVALID_MESSAGE);
  }
  // PEN-3803: `defaultMaxAttempts` is correctly omitted here, unlike at the
  // re-arm site above. This is the create path, where the row has made no
  // attempts by construction, so the ceiling cannot bite and supplying it would
  // be inert. The literal `0` is the row's real attempt count here, not the
  // hardcoded stand-in the re-arm path used to pass.
  const exhaustedReason = exhaustedMonitorClearReason({
    monitor: input.policy.monitor,
    attemptCount: 0,
    now: new Date(),
  });
  if (exhaustedReason) {
    throw unprocessable(
      MONITOR_BOUNDS_EXHAUSTED_MESSAGE,
      monitorBoundsExhaustedDetails({
        clearReason: exhaustedReason,
        monitor: input.policy.monitor,
        attemptCount: 0,
      }),
    );
  }

  const monitorState = buildScheduledMonitorState(null, input.policy.monitor);
  return {
    monitorNextCheckAt: new Date(input.policy.monitor.nextCheckAt),
    monitorWakeRequestedAt: null,
    monitorNotes: input.policy.monitor.notes ?? null,
    monitorScheduledBy: input.policy.monitor.scheduledBy,
    executionState: executionStateWithMonitor(null, monitorState) as Record<string, unknown> | null,
  };
}

export function buildIssueMonitorTriggeredPatch(input: {
  issue: IssueLike;
  policy: IssueExecutionPolicy | null;
  triggeredAt: Date;
}) {
  const existingState = parseIssueExecutionState(input.issue.executionState);
  const currentMonitorState = derivePersistedMonitorState({
    issue: input.issue,
    state: existingState,
    policy: input.policy,
  });
  const nextMonitorState = buildTriggeredMonitorState({
    previous: currentMonitorState,
    triggeredAt: input.triggeredAt,
  });

  return {
    executionPolicy: stripMonitorFromExecutionPolicy(input.policy) as Record<string, unknown> | null,
    executionState: executionStateWithMonitor(existingState, nextMonitorState) as Record<string, unknown> | null,
    monitorNextCheckAt: null,
    monitorWakeRequestedAt: null,
    monitorLastTriggeredAt: input.triggeredAt,
    monitorAttemptCount: nextMonitorState.attemptCount,
    monitorNotes: nextMonitorState.notes,
    monitorScheduledBy: nextMonitorState.scheduledBy,
  };
}

export function buildIssueMonitorDispatchRearmPatch(input: {
  issue: IssueLike;
  policy: IssueExecutionPolicy;
  /**
   * Attempt count to persist. Defaults to restoring the attempt the undelivered
   * wake consumed — the tick-detected lapse path, where the wake never ran and
   * so must not count against maxAttempts.
   *
   * The watchdog *dispatch* path passes the already-incremented count instead:
   * that fire did real work (it re-dispatched the stuck run), so it consumes an
   * attempt and the retry loop stays bounded by maxAttempts rather than
   * re-arming forever against a run that never moves (BLO-22860).
   */
  attemptCount?: number;
}) {
  const existingState = parseIssueExecutionState(input.issue.executionState);
  const currentMonitorState = derivePersistedMonitorState({
    issue: input.issue,
    state: existingState,
    policy: input.policy,
  });
  const restoredAttemptCount = input.attemptCount ?? Math.max(0, (currentMonitorState?.attemptCount ?? 1) - 1);
  const previousMonitorState = currentMonitorState
    ? { ...currentMonitorState, attemptCount: restoredAttemptCount }
    : null;
  const nextMonitorState = buildScheduledMonitorState(previousMonitorState, input.policy.monitor!);

  return {
    executionPolicy: input.policy as unknown as Record<string, unknown>,
    executionState: executionStateWithMonitor(existingState, nextMonitorState) as Record<string, unknown> | null,
    monitorNextCheckAt: new Date(input.policy.monitor!.nextCheckAt),
    monitorWakeRequestedAt: null,
    monitorAttemptCount: restoredAttemptCount,
    monitorNotes: nextMonitorState.notes,
    monitorScheduledBy: nextMonitorState.scheduledBy,
  };
}

export function buildIssueMonitorClearedPatch(input: {
  issue: IssueLike;
  policy: IssueExecutionPolicy | null;
  clearReason: IssueExecutionMonitorClearReason;
  clearedAt?: Date;
}) {
  const existingState = parseIssueExecutionState(input.issue.executionState);
  const currentMonitorState = derivePersistedMonitorState({
    issue: input.issue,
    state: existingState,
    policy: input.policy,
  });
  const nextMonitorState = buildClearedMonitorState({
    previous: currentMonitorState,
    clearReason: input.clearReason,
    clearedAt: input.clearedAt ?? new Date(),
  });

  return {
    executionPolicy: stripMonitorFromExecutionPolicy(input.policy) as Record<string, unknown> | null,
    executionState: executionStateWithMonitor(existingState, nextMonitorState) as Record<string, unknown> | null,
    monitorNextCheckAt: null,
    monitorWakeRequestedAt: null,
    // PEN-1995: see clearArmedMonitorColumns — the notes describe the armed
    // monitor, and the audit copy is on executionState.monitor.notes.
    monitorNotes: null,
  };
}

/**
 * BLO-28900 — reconcile a monitor that a raw status/assignee write just made
 * undeliverable.
 *
 * `tickDueIssueMonitors` only selects rows that are `in_progress`/`in_review`
 * and agent-assigned. A write that demotes a row out of that set has to clear
 * the monitor too, or it survives reading `scheduled` with a populated
 * `nextCheckAt` while being structurally incapable of firing — indistinguishable
 * from an idle assignee, and silent. A fleet census on 2026-08-19 found 24 such
 * rows, 18 of them already past their check time.
 *
 * `applyMonitorTransition` already does this for writes routed through
 * `issuesSvc.update`. This is the same reconciliation for the set-based raw
 * writes (checkout-restore, release) that bypass the service layer.
 *
 * PEN-6202 — this used to be keyed on `monitorNextCheckAt` alone, deferring a
 * monitor that had already FIRED (`triggered`, null check time) to BLO-25865 as
 * "a different defect". It is a different defect, and BLO-25865's net cannot
 * reach the rows this pass creates: `tickExpiredIssueMonitors` is the only thing
 * that clears a fired monitor, and its outer `where` carries
 * `status in ('in_progress','in_review') and assignee_user_id is null` — exactly
 * the eligibility this pass runs because the row has just LOST. So the two nets
 * handed the case to each other and the demotion fell between them, in the same
 * transaction, two statements apart.
 *
 * Measured 2026-11-08 across all 5615 company rows: 19 non-terminal rows carried
 * a permanently unclearable `triggered` monitor, 3 of them for 91–106 days. All
 * three were watching a pull request, all three of those PRs had merged, and no
 * monitor could ever fire again to say so. The sharpest wrote its final note
 * seven minutes AFTER the merge it was reporting as still open.
 *
 * Both axes of ineligibility reach this, not just status: a monitor that outlives
 * its agent assignee strands identically, which is how the one row outside every
 * agent intake surface (`in_review` + human-held) was stranded.
 *
 * This clears; it does not wake. The recovery wake `tickExpiredIssueMonitors`
 * emits is deliberately not reproduced here — these call sites are raw set-based
 * writes with no wake machinery, a demotion happens at the end of the run that
 * would be woken, and a demoted row keeps an agent assignee and so stays visible
 * through ordinary intake. Clearing removes the false-liveness signal, which is
 * the harm; see PEN-6202 for the part this deliberately leaves open.
 *
 * A monitor still sitting `triggered` on an ELIGIBLE row is untouched, because
 * `monitorClearReasonForIssue` declines there. That is what keeps BLO-35155's
 * live-consumer grace intact: this fires at the instant the row leaves
 * eligibility — the instant the hole opens — and never before.
 *
 * Returns an empty patch when the row holds no monitor or the monitor is still
 * deliverable, so callers can spread it unconditionally.
 */
export function buildIssueMonitorEligibilityPatch(issue: IssueLike): Record<string, unknown> {
  const policy = normalizeIssueExecutionPolicy(issue.executionPolicy ?? null);
  if (!issue.monitorNextCheckAt && !holdsTriggeredMonitor(issue, policy)) return {};
  const clearReason = monitorClearReasonForIssue(
    issue.status,
    issue.assigneeAgentId ?? null,
    issue.assigneeUserId ?? null,
  );
  if (!clearReason) return {};
  return buildIssueMonitorClearedPatch({ issue, policy, clearReason });
}

/**
 * PEN-6202 — does this row hold a monitor that has fired and not yet been
 * cleared?
 *
 * Read through `derivePersistedMonitorState` rather than off
 * `executionState.monitor.status` directly, so this agrees with the two other
 * places that decide the same question (`tickExpiredIssueMonitors`' post-claim
 * re-check, and `buildIssueMonitorClearedPatch` above) — including legacy rows whose
 * trigger survives only in the `monitorLastTriggeredAt` / `monitorAttemptCount`
 * columns with no `executionState` to read.
 *
 * An already-`cleared` monitor derives as `cleared` and is excluded, so this
 * cannot rewrite a `clearReason` that a scheduler or an assignee already set —
 * the clear is idempotent, and the second call through any of these write paths
 * is a no-op.
 */
function holdsTriggeredMonitor(issue: IssueLike, policy: IssueExecutionPolicy | null): boolean {
  // Cheap necessary condition, so the overwhelmingly common "row holds no
  // monitor at all" case costs no `executionState` parse. `derivePersistedMonitorState`
  // can only reach its `triggered` branch via one of these three, and
  // `buildIssueMonitorTriggeredPatch` writes the column atomically with the
  // JSON — the `executionState` arm is kept anyway so a row whose columns were
  // reset without its state is still seen.
  if (!issue.monitorLastTriggeredAt && !(issue.monitorAttemptCount ?? 0) && !issue.executionState) {
    return false;
  }
  const state = derivePersistedMonitorState({
    issue,
    state: parseIssueExecutionState(issue.executionState),
    policy,
  });
  return state?.status === "triggered";
}

export function applyIssueExecutionPolicyTransition(input: TransitionInput): TransitionResult {
  const stageResult = applyIssueExecutionStageTransition(input);
  const monitor = applyMonitorTransition(input, stageResult.patch);
  Object.assign(stageResult.patch, monitor.patch);
  return { ...stageResult, monitorConvergence: monitor.convergence };
}

export function applyIssueMonitorPolicyTransition(input: TransitionInput): TransitionResult {
  const monitor = applyMonitorTransition(input, {});
  return { patch: monitor.patch, monitorConvergence: monitor.convergence };
}
