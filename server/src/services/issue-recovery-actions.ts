import { and, asc, desc, eq, inArray, isNotNull, lte, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueRecoveryActions } from "@paperclipai/db";
import type {
  IssueRecoveryAction,
  IssueRecoveryActionKind,
  IssueRecoveryActionOwnerType,
  IssueRecoveryActionOutcome,
  IssueRecoveryActionStatus,
} from "@paperclipai/shared";

export const ACTIVE_RECOVERY_ACTION_STATUSES = ["active", "escalated"] as const satisfies readonly IssueRecoveryActionStatus[];

/**
 * Recovery-action statuses that still hold a live repair path, for the purpose of
 * suppressing blocked-issue auto-resume.
 *
 * Deliberately NARROWER than `ACTIVE_RECOVERY_ACTION_STATUSES`, and the asymmetry is
 * load-bearing (BLO-21523). `escalated` belongs in the wider set — it holds
 * `issue_recovery_actions_active_source_uq` so a fresh action cannot be minted with a
 * new budget (BLO-18996), it keeps the handoff comment grant open, and it keeps the
 * owner able to check the issue out. What it does NOT do is wake anyone:
 *
 *   - `escalateExpiredWakeHorizons` is the ONLY writer of `escalated`, and it sets it
 *     exactly when `maxAttempts !== null && timeoutAt !== null && timeoutAt <= now`.
 *     `strandedRecoveryWakeAttemptsExhausted` returns true for precisely that condition.
 *     (`upsertSourceScoped` only ever *preserves* an existing `escalated` — it never
 *     creates one — so there is no second way in.)
 *   - So every `escalated` action is already wake-exhausted.
 *     `reconcileStrandedRecoveryWakeBackstop` selects it and then always drops it at
 *     `exhaustedSkipped`. Should a later re-upsert ever null out `maxAttempts`, the
 *     conclusion is unchanged: a null budget is reserved for the causes that never wake
 *     an owner at all.
 *
 * The platform says as much verbatim when it escalates: "Paperclip has stopped waking
 * anyone for it". Suppressing auto-resume on an `escalated` action therefore preserves
 * no repair path — it only pins the issue `blocked` with zero unresolved blockers, which
 * is the exact stranded state the reconciler exists to drain, and which no wake, retry or
 * monitor will ever re-enter. Measured 2026-08-24: 88 of 106 stranded rows were held this
 * way, 87 of them with no run, no monitor and no scheduled retry, the oldest 6 weeks old.
 *
 * Resolving or cancelling the action remains the way to clear the wider set; this constant
 * only decides whether the row may return to `todo`.
 */
export const BLOCKED_AUTO_RESUME_SUPPRESSING_RECOVERY_ACTION_STATUSES = ["active"] as const satisfies readonly IssueRecoveryActionStatus[];

const MAX_UPSERT_RETRIES = 3;
const SOURCE_SCOPED_WAKE_HORIZON_EVIDENCE_KEY = "sourceScopedWakeHorizonAt";
const RECOVERY_HANDOFF_GRANT_ANCHOR_EVIDENCE_KEY = "recoveryHandoffGrantAnchorAt";
// Written by `buildStrandedRecoveryActionEvidence` in recovery/service.ts.
const LATEST_RUN_AGENT_ID_EVIDENCE_KEY = "latestRunAgentId";
const LATEST_RUN_ID_EVIDENCE_KEY = "latestRunId";

// How long after a recovery transfer the previous owner keeps the comment-only
// handoff channel opened by BLO-18906 / #827.
//
// #827 justified that widening as "state-bounded": active/escalated only, so
// resolving or cancelling the action lapses it. Measured on 2026-07-31 that bound
// is nearly inert — 0 of 119 active recovery actions had ever been resolved, and
// the resulting grants ran to a median age of 9 days (p90 12d, max 51d) across 117
// issues the grantee did not own. Nothing drains the queue (BLO-19124), so in
// practice the grant never lapsed at all.
//
// 24h is chosen to cover the actual use case and little else: the channel exists so
// the agent that was just taken off the issue can write down the diagnosis it is
// still holding. That is a single wake's work, and an agent that has not posted its
// handoff within a day no longer has a fresh diagnosis worth the standing access.
// The value is intentionally here rather than inline at the authorization call site
// so the grant's lifetime is tunable in one place (BLO-20263).
export const RECOVERY_HANDOFF_COMMENT_GRANT_TTL_MS = 24 * 60 * 60 * 1000;

type IssueRecoveryActionRow = typeof issueRecoveryActions.$inferSelect;
type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type DbOrTransaction = Db | DbTransaction;

export type UpsertIssueRecoveryActionInput = {
  companyId: string;
  sourceIssueId: string;
  recoveryIssueId?: string | null;
  kind: IssueRecoveryActionKind;
  ownerType?: IssueRecoveryActionOwnerType;
  ownerAgentId?: string | null;
  ownerUserId?: string | null;
  previousOwnerAgentId?: string | null;
  returnOwnerAgentId?: string | null;
  cause: string;
  fingerprint: string;
  evidence?: Record<string, unknown>;
  nextAction: string;
  wakePolicy?: Record<string, unknown> | null;
  monitorPolicy?: Record<string, unknown> | null;
  maxAttempts?: number | null;
  timeoutAt?: Date | null;
  lastAttemptAt?: Date | null;
};

export type ResolveIssueRecoveryActionInput = {
  companyId: string;
  sourceIssueId: string;
  actionId?: string | null;
  kind?: IssueRecoveryActionKind | null;
  cause?: string | null;
  fingerprint?: string | null;
  status: Extract<IssueRecoveryActionStatus, "resolved" | "cancelled">;
  outcome: IssueRecoveryActionOutcome;
  resolutionNote?: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toValidDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function readSourceScopedWakeHorizonAt(evidence: unknown): Date | null {
  if (!isRecord(evidence)) return null;
  return toValidDate(evidence[SOURCE_SCOPED_WAKE_HORIZON_EVIDENCE_KEY]);
}

function withSourceScopedWakeHorizonEvidence(
  evidence: unknown,
  wakeHorizonAt: Date | null,
): Record<string, unknown> {
  const next = isRecord(evidence) ? { ...evidence } : {};
  if (wakeHorizonAt) {
    next[SOURCE_SCOPED_WAKE_HORIZON_EVIDENCE_KEY] = wakeHorizonAt.toISOString();
  }
  return next;
}

// The instant the handoff TTL runs from: the most recent transfer that took the
// issue away from `previousOwnerAgentId`.
//
// This deliberately does NOT anchor on `lastAttemptAt`, which the AC for BLO-20263
// offered as a candidate. `upsertSourceScopedUnlocked` rewrites `lastAttemptAt` on
// EVERY sweep of an unresolved action (`lastAttemptAt: input.lastAttemptAt ?? now`),
// so a TTL measured from it would be pushed forward for as long as the action stays
// open — which is forever, per the same measurement that motivated the bound. That
// would ship a TTL that never expires: strictly worse than no TTL, because it reads
// as bounded.
//
// It is also not plain `createdAt`. The active row is REUSED across reassignments
// (one active row per (company, issue) via `issue_recovery_actions_active_source_uq`),
// and the sweep rewrites `previousOwnerAgentId` from the issue's current assignee.
// So a row created 9 days ago can name a previous owner transferred away 10 minutes
// ago; anchoring on `createdAt` would deny that agent the channel BLO-18906 exists
// to give it, silently regressing #827 for exactly the case it was built for.
//
// Hence a dedicated anchor, refreshed only when `previousOwnerAgentId` actually
// changes — i.e. on a real transfer, never on ordinary sweep churn. At most one
// agent holds this grant on an issue at a time, for at most the TTL after the
// transfer that named them. `createdAt` remains the read-side fallback for rows
// written before this key existed.
//
// BLO-22127: the read is deliberately TRI-state rather than `Date | null`. "The key is
// absent" and "the key is present but unparseable" are different claims and must have
// different outcomes: the first is a legacy row that predates the key and legitimately
// falls back to `createdAt`; the second is a row whose evidence asserts an anchor we
// cannot read, where falling back to `createdAt` would silently substitute a DIFFERENT
// and potentially fresher anchor than the one the row claims. Collapsing them to `null`
// is fail-open in an authorization path.
type RecoveryHandoffGrantAnchor =
  | { kind: "valid"; at: Date }
  | { kind: "absent" }
  | { kind: "invalid"; raw: unknown };

function readRecoveryHandoffGrantAnchor(evidence: unknown): RecoveryHandoffGrantAnchor {
  if (!isRecord(evidence)) return { kind: "absent" };
  if (!(RECOVERY_HANDOFF_GRANT_ANCHOR_EVIDENCE_KEY in evidence)) return { kind: "absent" };
  const raw = evidence[RECOVERY_HANDOFF_GRANT_ANCHOR_EVIDENCE_KEY];
  const at = toValidDate(raw);
  return at ? { kind: "valid", at } : { kind: "invalid", raw };
}

/**
 * The agent whose run actually failed, per the sweep's own evidence.
 *
 * This is the only field that separates the two shapes which both satisfy
 * `input.previousOwnerAgentId === existing.ownerAgentId` — see the churn predicate
 * in `upsertSourceScopedUnlocked`. Absent or malformed (legacy rows, and callers
 * like `pr_review_non_convergence` that carry no run) reads as `null`, which the
 * predicate treats as churn: that preserves the existing anchor rather than
 * refreshing it, so an unidentifiable sweep can never extend a grant.
 */
function readLatestRunAgentId(evidence: unknown): string | null {
  if (!isRecord(evidence)) return null;
  const value = evidence[LATEST_RUN_AGENT_ID_EVIDENCE_KEY];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * The id of the run that failed, per the sweep's own evidence.
 *
 * BLO-22127: `readLatestRunAgentId` answers "whose run failed"; this answers "which
 * run". Both are needed, and neither substitutes for the other. Agent identity
 * separates replay churn from a newly failed recovery owner; run identity separates a
 * replay of the SAME failure from a genuinely distinct later failure by the same agent.
 * Absent or malformed reads as `null`, which suppresses re-anchoring — an
 * unidentifiable sweep can never extend a grant.
 */
function readLatestRunId(evidence: unknown): string | null {
  if (!isRecord(evidence)) return null;
  const value = evidence[LATEST_RUN_ID_EVIDENCE_KEY];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function withRecoveryHandoffGrantAnchorEvidence(
  evidence: unknown,
  anchor: RecoveryHandoffGrantAnchor,
): Record<string, unknown> {
  const next = isRecord(evidence) ? { ...evidence } : {};
  if (anchor.kind === "valid") {
    next[RECOVERY_HANDOFF_GRANT_ANCHOR_EVIDENCE_KEY] = anchor.at.toISOString();
  } else if (anchor.kind === "invalid") {
    // BLO-22127: carry an unreadable anchor through VERBATIM rather than dropping it.
    // Dropping it would rewrite "present but unparseable" (which the read side denies)
    // into "absent" (which falls back to `createdAt`), so an ordinary sweep would
    // launder a fail-closed row back into a fail-open one. The row stays denied until a
    // genuine transfer writes a fresh anchor over it.
    next[RECOVERY_HANDOFF_GRANT_ANCHOR_EVIDENCE_KEY] = anchor.raw;
  }
  return next;
}

/**
 * Whether a recovery action's handoff comment grant is still inside its TTL.
 *
 * `createdAt` is the fallback anchor for rows written before the evidence key
 * existed. Those are the 117 rows this ticket was filed about: all far older than
 * the TTL, so they lapse on the first request after deploy, which is the point.
 *
 * BLO-22127 hardens two fail-open holes in the original bound:
 *
 *   - A future-dated anchor produced a NEGATIVE age, and negative trivially satisfies
 *     `<= TTL`, so such a grant held until wall-clock caught up — unbounded in the only
 *     direction that matters. The age is now range-checked at both ends.
 *   - A present-but-unparseable anchor fell through `??` to `createdAt`, quietly
 *     honouring an anchor the row never claimed. Only an ABSENT key falls back now.
 *
 * The lower bound is strict rather than skew-tolerant. The anchor is written by this
 * same service on transfer and read on a strictly later request, so a legitimate age is
 * never negative; allowing a tolerance would reintroduce a fail-open window to buy
 * nothing, and its failure mode (a brief deny that self-heals on the next request) is
 * the safe direction for an authorization check.
 */
export function recoveryHandoffGrantIsWithinTtl(input: {
  evidence: unknown;
  createdAt: Date | string | null;
  now?: Date;
}): boolean {
  const anchor = readRecoveryHandoffGrantAnchor(input.evidence);
  // Evidence claims an anchor we cannot parse: we cannot show the grant is fresh, and
  // we must not substitute a different one. Fail closed.
  if (anchor.kind === "invalid") return false;
  const anchorAt = anchor.kind === "valid" ? anchor.at : toValidDate(input.createdAt);
  // No usable anchor at all (unparseable `createdAt` on a row with no evidence key)
  // means we cannot show the grant is fresh, so it does not hold. Fail closed.
  if (!anchorAt) return false;
  const now = input.now ?? new Date();
  const ageMs = now.getTime() - anchorAt.getTime();
  return ageMs >= 0 && ageMs <= RECOVERY_HANDOFF_COMMENT_GRANT_TTL_MS;
}

function toReadModel(row: IssueRecoveryActionRow): IssueRecoveryAction {
  return {
    id: row.id,
    companyId: row.companyId,
    sourceIssueId: row.sourceIssueId,
    recoveryIssueId: row.recoveryIssueId,
    kind: row.kind as IssueRecoveryAction["kind"],
    status: row.status as IssueRecoveryAction["status"],
    ownerType: row.ownerType as IssueRecoveryAction["ownerType"],
    ownerAgentId: row.ownerAgentId,
    ownerUserId: row.ownerUserId,
    previousOwnerAgentId: row.previousOwnerAgentId,
    returnOwnerAgentId: row.returnOwnerAgentId,
    cause: row.cause,
    fingerprint: row.fingerprint,
    evidence: row.evidence,
    nextAction: row.nextAction,
    wakePolicy: row.wakePolicy,
    monitorPolicy: row.monitorPolicy,
    attemptCount: row.attemptCount,
    maxAttempts: row.maxAttempts,
    timeoutAt: row.timeoutAt,
    lastAttemptAt: row.lastAttemptAt,
    outcome: row.outcome as IssueRecoveryAction["outcome"],
    resolutionNote: row.resolutionNote,
    resolvedAt: row.resolvedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function isUniqueRecoveryActionConflict(error: unknown) {
  const maybe = error as { code?: string; constraint?: string; message?: string } | null;
  return Boolean(
    maybe &&
      maybe.code === "23505" &&
      (
        maybe.constraint === "issue_recovery_actions_active_source_uq" ||
        maybe.constraint === "issue_recovery_actions_active_fingerprint_uq" ||
        typeof maybe.message === "string" && (
          maybe.message.includes("issue_recovery_actions_active_source_uq") ||
          maybe.message.includes("issue_recovery_actions_active_fingerprint_uq")
        )
      ),
  );
}

export function issueRecoveryActionService(db: DbOrTransaction) {
  const upsertQueues = new Map<string, Promise<void>>();

  async function runExclusiveUpsert<T>(
    input: UpsertIssueRecoveryActionInput,
    task: () => Promise<T>,
  ): Promise<T> {
    const key = `${input.companyId}:${input.sourceIssueId}`;
    const previous = upsertQueues.get(key) ?? Promise.resolve();
    let release: () => void = () => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const next = previous.catch(() => undefined).then(() => current);
    upsertQueues.set(key, next);

    await previous.catch(() => undefined);
    try {
      return await task();
    } finally {
      release();
      if (upsertQueues.get(key) === next) {
        upsertQueues.delete(key);
      }
    }
  }

  async function getActiveForIssue(companyId: string, sourceIssueId: string): Promise<IssueRecoveryAction | null> {
    const row = await db
      .select()
      .from(issueRecoveryActions)
      .where(
        and(
          eq(issueRecoveryActions.companyId, companyId),
          eq(issueRecoveryActions.sourceIssueId, sourceIssueId),
          inArray(issueRecoveryActions.status, [...ACTIVE_RECOVERY_ACTION_STATUSES]),
        ),
      )
      .orderBy(desc(issueRecoveryActions.updatedAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    return row ? toReadModel(row) : null;
  }

  async function listActiveForIssues(companyId: string, sourceIssueIds: string[]) {
    if (sourceIssueIds.length === 0) return new Map<string, IssueRecoveryAction>();
    const rows = await db
      .select()
      .from(issueRecoveryActions)
      .where(
        and(
          eq(issueRecoveryActions.companyId, companyId),
          inArray(issueRecoveryActions.sourceIssueId, [...new Set(sourceIssueIds)]),
          inArray(issueRecoveryActions.status, [...ACTIVE_RECOVERY_ACTION_STATUSES]),
        ),
      )
      .orderBy(desc(issueRecoveryActions.updatedAt));
    const result = new Map<string, IssueRecoveryAction>();
    for (const row of rows) {
      if (!result.has(row.sourceIssueId)) result.set(row.sourceIssueId, toReadModel(row));
    }
    return result;
  }

  async function retryUpsertSourceScoped(
    input: UpsertIssueRecoveryActionInput,
    retryCount: number,
    error?: unknown,
  ): Promise<IssueRecoveryAction> {
    if (retryCount >= MAX_UPSERT_RETRIES) {
      if (error) throw error;
      throw new Error(
        `Failed to upsert active recovery action for issue ${input.sourceIssueId} after ${MAX_UPSERT_RETRIES} retries`,
      );
    }
    return upsertSourceScopedUnlocked(input, retryCount + 1);
  }

  async function upsertSourceScopedUnlocked(
    input: UpsertIssueRecoveryActionInput,
    retryCount = 0,
  ): Promise<IssueRecoveryAction> {
    const existing = await getActiveForIssue(input.companyId, input.sourceIssueId);
    const now = new Date();
    const ownerType = input.ownerType ?? (input.ownerAgentId ? "agent" : "board");
    if (existing) {
      // BLO-18996: this UPDATE overwrites `ownerAgentId` in place while carrying
      // `attemptCount` forward, so a reassigned owner inherited the previous owner's spent
      // budget and — once it was over `maxAttempts` — was never woken at all. The action
      // then sat open and undischargeable, which is the exact deadlock this issue is about.
      //
      // Reset on a change of OWNER, not of fingerprint. The wake budget counts "times we
      // woke this agent about this action", so the agent is the thing the count belongs to,
      // and replacing the agent is what has to start a fresh sequence. The fingerprint is
      // the wrong key even though it reads like the natural one: the stranded fingerprint
      // ends in `issue.assigneeAgentId`, and escalation itself reassigns the issue to the
      // recovery owner, so the fingerprint changes on EVERY sweep of an unresolved failure.
      // Keying on it would reset the counter every sweep and the budget would never
      // exhaust — silently reinstating the unbounded re-fire loop the budget exists to stop.
      // (Verified: across two consecutive escalations of one unresolved issue the
      // fingerprint's assignee segment changes while `ownerAgentId` holds steady.)
      //
      // Computed in the same UPDATE as the owner write, so no sweep can observe a new owner
      // carrying an old counter.
      const isNewOwnerSequence = (input.ownerAgentId ?? null) !== existing.ownerAgentId;
      const existingTimeoutAt = toValidDate(existing.timeoutAt);
      const inputMaxAttempts = input.maxAttempts ?? null;
      const existingWakeHorizonAt = readSourceScopedWakeHorizonAt(existing.evidence);
      // ROLLOUT NOTE: the `existing.maxAttempts !== null ? existingTimeoutAt : null` arm is the
      // backfill for rows written before the evidence key existed. A row that is already
      // mid-ownerless-phase at deploy time has `maxAttempts: null` AND no evidence key, so it
      // reads as never-bounded and re-arms its horizon once on the first owned sweep after
      // rollout. That is self-healing and bounded to a single extra horizon window; it is
      // expected at deploy and is NOT a recurrence of the flap this code fixes. Distinguish
      // them by count: the bug re-armed on EVERY ownerless flap, the backfill re-arms once.
      const carriedWakeHorizonAt = existingWakeHorizonAt ?? (existing.maxAttempts !== null ? existingTimeoutAt : null);
      // BLO-18996 (review follow-up): the row is long-lived and can gain a budget it did not
      // have when its `timeoutAt` was written, so "preserve the horizon" has to start
      // counting from the sweep that STARTS the bound, not from whatever wrote the column
      // first. An unbounded row (`maxAttempts === null`) has no wake horizon — any value in
      // `timeoutAt` there belongs to a different mechanism (the provider-quota scheduler's
      // `retryAt`) and is typically already in the past by the time ownership arrives.
      // Inheriting it would make `strandedRecoveryWakeAttemptsExhausted` true on the new
      // owner's FIRST wake and reinstate the exact deadlock this ticket fixes.
      //
      // A later review found the inverse edge: after a bounded row temporarily loses every
      // invokable owner, a sweep writes `maxAttempts: null` onto the same active row. That must
      // not make the next owned sweep look newly bounded again. Persist the first wake horizon
      // in evidence so "has ever been bounded" survives bounded -> ownerless -> bounded flaps.
      const isNewlyBoundedSequence = carriedWakeHorizonAt === null && inputMaxAttempts !== null;
      const wakeHorizonAt = isNewlyBoundedSequence
        ? (input.timeoutAt ?? null)
        : carriedWakeHorizonAt;
      // BLO-20263: refresh the handoff-grant anchor only when the transfer actually
      // moves the issue away from a different source agent. Every sweep passes
      // `previousOwnerAgentId: issue.assigneeAgentId`, and the prior recovery sweep
      // reassigns that source issue to `existing.ownerAgentId`. When the input names
      // that owner, this is recovery seeing its own reassignment, not a fresh handoff
      // subject. Keep the original previous owner and anchor so recovery-driven
      // CTO/CEO/manager churn cannot turn the TTL into a sliding window.
      //
      // BLO-20263 (review follow-up): owner equality ALONE cannot decide that, because
      // two different situations produce it and they want opposite outcomes:
      //
      //   1. Replay churn. A's run failed, recovery handed the issue to B and reassigned
      //      it to B. The next sweep re-observes A's SAME failed run and passes the
      //      current assignee B back as `previousOwnerAgentId`. B never ran, so B is not
      //      a handoff subject — preserve A and A's anchor.
      //   2. B genuinely failed after taking over. B ran, B's own run failed, and this
      //      sweep routes ownership onward to C. Here B is exactly the agent losing
      //      `allow_self` while holding the freshest diagnosis, so B must become the
      //      grant subject with a fresh anchor — that is the whole point of #827.
      //
      // Both satisfy `input.previousOwnerAgentId === existing.ownerAgentId`. What
      // separates them is WHOSE run failed: in (1) the failed run belongs to A, in (2)
      // it belongs to B. So consult the run identity the sweep already records in its
      // own evidence rather than inferring from owner identity, which cannot tell them
      // apart. Unknown run agent reads as churn (fail closed: preserve, never refresh).
      const inputPreviousOwnerAgentId = input.previousOwnerAgentId ?? existing.previousOwnerAgentId;
      const failedRunAgentId = readLatestRunAgentId(input.evidence);
      const latestRunId = readLatestRunId(input.evidence);
      const existingLatestRunId = readLatestRunId(existing.evidence);
      const isFailedRunByCurrentOwner = failedRunAgentId !== null &&
        failedRunAgentId === input.previousOwnerAgentId;
      const isRecoveryDrivenOwnerChurn = input.previousOwnerAgentId !== null &&
        input.previousOwnerAgentId !== undefined &&
        input.previousOwnerAgentId === existing.ownerAgentId &&
        !isFailedRunByCurrentOwner;
      const nextPreviousOwnerAgentId = isRecoveryDrivenOwnerChurn
        ? existing.previousOwnerAgentId
        : inputPreviousOwnerAgentId;
      const isNewHandoffSubject = nextPreviousOwnerAgentId !== existing.previousOwnerAgentId;
      // BLO-22127: a change of SUBJECT is sufficient for a fresh anchor but not
      // necessary. Ownership can return to A out-of-band — a human reassignment, a
      // manual takeback, anything that is not a recovery sweep — so nothing ever
      // records an intervening `previousOwnerAgentId = B`. When a distinct A-owned run
      // then fails and transfers A away AGAIN, the subject is unchanged and the
      // transfer reads as churn, so A keeps the stale anchor and immediately loses the
      // handoff channel #827 exists to provide. That is a genuine second transfer and
      // must re-anchor.
      //
      // The discriminator is the failed RUN's id: a re-transfer is a distinct failure,
      // a replay is the same failure observed twice. Run identity alone would be wrong
      // as the only test — `reuses the same source-scoped action when latest run IDs
      // change while the cause stays the same` presents two different run ids for the
      // same failed agent and must still suppress — which is why this is gated behind
      // the churn predicate and `isFailedRunByCurrentOwner`: it only speaks for the
      // case where the agent being transferred away is the one whose run just failed.
      // Either id unknown reads as a replay, so an unidentifiable sweep still cannot
      // extend a grant.
      const isDistinctFailedRunByHandoffSubject =
        !isRecoveryDrivenOwnerChurn &&
        isFailedRunByCurrentOwner &&
        latestRunId !== null &&
        existingLatestRunId !== null &&
        latestRunId !== existingLatestRunId;
      const isNewHandoffTransfer = isNewHandoffSubject || isDistinctFailedRunByHandoffSubject;
      const handoffGrantAnchor: RecoveryHandoffGrantAnchor = isNewHandoffTransfer
        ? { kind: "valid", at: now }
        : readRecoveryHandoffGrantAnchor(existing.evidence);
      const [updated] = await db
        .update(issueRecoveryActions)
        .set({
          recoveryIssueId: input.recoveryIssueId ?? null,
          kind: input.kind,
          // BLO-24662: `escalated` is sticky. A row reaches it only by burning the
          // creation-anchored `timeoutAt`, and that horizon is fixed for the life of the
          // action — no owner change restores it (see the `timeoutAt` preservation note
          // below). Re-setting `active` here would silently un-retire an action on the very
          // next sweep and put it straight back into the invisible state the transition
          // exists to end.
          status: existing.status === "escalated" ? "escalated" : "active",
          ownerType,
          ownerAgentId: input.ownerAgentId ?? null,
          ownerUserId: input.ownerUserId ?? null,
          previousOwnerAgentId: nextPreviousOwnerAgentId,
          returnOwnerAgentId: input.returnOwnerAgentId ?? existing.returnOwnerAgentId,
          cause: input.cause,
          fingerprint: input.fingerprint,
          evidence: withRecoveryHandoffGrantAnchorEvidence(
            withSourceScopedWakeHorizonEvidence(input.evidence ?? existing.evidence, wakeHorizonAt),
            handoffGrantAnchor,
          ),
          nextAction: input.nextAction,
          wakePolicy: input.wakePolicy ?? null,
          monitorPolicy: input.monitorPolicy ?? null,
          attemptCount: isNewOwnerSequence ? 1 : existing.attemptCount + 1,
          maxAttempts: inputMaxAttempts,
          // BLO-18996: PRESERVE the existing horizon, once the row is actually bounded.
          // `timeoutAt` is the one bound on this row that owner churn cannot reset, and it
          // only has that property because the sweep does not rewrite it — every sweep
          // re-derives `input.timeoutAt` from "now", so taking the input here on every pass
          // would push the horizon forward and make it as useless as the attempt counter it
          // exists to backstop. The read model widens `timeoutAt` to `Date | string`, so
          // normalize before handing it back to drizzle.
          //
          // The exception is the transition INTO a bounded shape, and it is load-bearing.
          // `timeoutAt` is shared with the provider-quota scheduler, which writes
          // `timeoutAt = retryAt` on this row through a direct UPDATE while the row is still
          // OWNERLESS and unbounded (`maxAttempts: null`). That is inert while it stays that
          // way, because `strandedRecoveryWakeAttemptsExhausted` returns false for a null
          // budget before it ever looks at the horizon. But the SAME active row later gains a
          // manager-ladder owner and a budget when the quota-hit agent stops being invokable,
          // and a quota `retryAt` is minutes out, so by then it is in the past. Blindly
          // preserving it would exhaust the new owner on its first wake — the deadlock this
          // ticket exists to fix, reintroduced through the back door. So on
          // unbounded -> bounded, adopt the fresh wake horizon; thereafter never rewrite it.
          // Staying unbounded still preserves, which keeps the quota `retryAt` intact.
          //
          // PEN-2756: this used to also name `pr_review_non_convergence` as an unbounded
          // caller. It is bounded at creation now (it wakes an owner, so the same rule that
          // bounds every other waking shape applies), which means it reaches the
          // unbounded -> bounded arm above on its first sweep after rollout, exactly like the
          // ROLLOUT NOTE describes. Only the ownerless board-escalation variant of that kind
          // stays unbounded, and that one wakes nobody.
          timeoutAt: inputMaxAttempts !== null
            ? (wakeHorizonAt ?? input.timeoutAt ?? null)
            : (existingTimeoutAt ?? input.timeoutAt ?? null),
          lastAttemptAt: input.lastAttemptAt ?? now,
          outcome: null,
          resolutionNote: null,
          resolvedAt: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(issueRecoveryActions.id, existing.id),
            inArray(issueRecoveryActions.status, [...ACTIVE_RECOVERY_ACTION_STATUSES]),
          ),
        )
        .returning();
      if (!updated) {
        return retryUpsertSourceScoped(input, retryCount);
      }
      return toReadModel(updated!);
    }

    try {
      const [created] = await db
        .insert(issueRecoveryActions)
        .values({
          companyId: input.companyId,
          sourceIssueId: input.sourceIssueId,
          recoveryIssueId: input.recoveryIssueId ?? null,
          kind: input.kind,
          status: "active",
          ownerType,
          ownerAgentId: input.ownerAgentId ?? null,
          ownerUserId: input.ownerUserId ?? null,
          previousOwnerAgentId: input.previousOwnerAgentId ?? null,
          returnOwnerAgentId: input.returnOwnerAgentId ?? null,
          cause: input.cause,
          fingerprint: input.fingerprint,
          evidence: withRecoveryHandoffGrantAnchorEvidence(
            withSourceScopedWakeHorizonEvidence(
              input.evidence ?? {},
              (input.maxAttempts ?? null) !== null ? (input.timeoutAt ?? null) : null,
            ),
            // Creating the row IS the transfer, so it anchors the TTL.
            { kind: "valid", at: now },
          ),
          nextAction: input.nextAction,
          wakePolicy: input.wakePolicy ?? null,
          monitorPolicy: input.monitorPolicy ?? null,
          attemptCount: 1,
          maxAttempts: input.maxAttempts ?? null,
          timeoutAt: input.timeoutAt ?? null,
          lastAttemptAt: input.lastAttemptAt ?? now,
        })
        .returning();
      return toReadModel(created!);
    } catch (error) {
      if (!isUniqueRecoveryActionConflict(error)) throw error;
      return retryUpsertSourceScoped(input, retryCount, error);
    }
  }

  async function upsertSourceScoped(
    input: UpsertIssueRecoveryActionInput,
  ): Promise<IssueRecoveryAction> {
    return runExclusiveUpsert(input, () => upsertSourceScopedUnlocked(input));
  }

  // BLO-18996 (review follow-up): give back an attempt that was reserved but never spent.
  //
  // `upsertSourceScoped` increments `attemptCount` as part of the escalation UPDATE, which
  // commits on this service's own connection — NOT inside the caller's escalation
  // transaction. So by the time the caller tries to wake the owner, the attempt is already
  // durably spent, and a wake enqueue that reaches nobody leaves the budget consumed anyway.
  // Five such sweeps would retire the action's whole budget without a single wake, and the
  // exhaustion notice would then claim the owner had been woken five times.
  //
  // This is the compensating half of that reservation: the caller refunds whenever the
  // enqueue woke nobody — both a throw and a null return, null being how `enqueueWakeup`
  // reports its non-delivery paths (capacity deferral, tree hold, cooldown, disabled wake).
  // So only wakes that actually reached the queue count against the budget. Floors at 0 so a
  // refunded first attempt makes the next sweep's `existing.attemptCount + 1` land back on 1.
  // The owner and attempt count are the reservation token captured by the caller. Keep both
  // in the UPDATE predicate so a refund from an older wake is an atomic no-op after ownership
  // changes or a newer reservation. Scoped to active statuses and matched on company so it
  // cannot touch a resolved row.
  async function releaseWakeAttempt(input: {
    companyId: string;
    actionId: string;
    expectedOwnerAgentId: string;
    expectedAttemptCount: number;
  }): Promise<void> {
    await db
      .update(issueRecoveryActions)
      .set({
        attemptCount: sql`greatest(${issueRecoveryActions.attemptCount} - 1, 0)`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(issueRecoveryActions.id, input.actionId),
          eq(issueRecoveryActions.companyId, input.companyId),
          eq(issueRecoveryActions.ownerAgentId, input.expectedOwnerAgentId),
          eq(issueRecoveryActions.attemptCount, input.expectedAttemptCount),
          inArray(issueRecoveryActions.status, [...ACTIVE_RECOVERY_ACTION_STATUSES]),
        ),
      );
  }

  /**
   * BLO-24662: retire recovery actions that have burned their creation-anchored horizon.
   *
   * `strandedRecoveryWakeAttemptsExhausted` already stops every sweep from waking anyone
   * for these, but nothing ever wrote that fact to the row, so a spent action kept
   * reporting `status: "active"` indefinitely. On BLO-20995 that was a
   * `stranded_assigned_issue` action sitting at `attemptCount: 0 / 5` more than 13h past
   * its `timeoutAt` and still reading as active — the mechanism that exists to catch
   * strandings, itself stranded, and invisible precisely because `active` is the healthy
   * value.
   *
   * `escalated` rather than a terminal status, deliberately. It is the status the schema
   * already reserves for "past automatic recovery, needs a human", the attention feed
   * already renders it at `severity: high`, and — critically — it stays inside
   * `ACTIVE_RECOVERY_ACTION_STATUSES`, so the row keeps holding
   * `issue_recovery_actions_active_source_uq`. A terminal status would free that slot and
   * let the next sweep open a brand-new action with a fresh budget and a fresh horizon,
   * reinstating the unbounded re-fire loop BLO-18996 closed.
   *
   * Only rows that carry a budget are eligible (`maxAttempts is not null`), matching the
   * gate in `strandedRecoveryWakeAttemptsExhausted`: the monitor-only and manual-repair
   * shapes are expected to sit open across many sweeps and a `timeoutAt` on those belongs
   * to the provider-quota scheduler's `retryAt`, not to a wake horizon.
   *
   * The `status` re-check inside the UPDATE is what makes concurrent sweeps safe: only
   * rows this call actually transitioned come back, so the caller announces once.
   */
  async function escalateExpiredWakeHorizons(input: {
    now?: Date;
    companyId?: string | null;
    limit?: number;
  } = {}): Promise<IssueRecoveryAction[]> {
    const now = input.now ?? new Date();
    const limit = Math.max(1, Math.floor(input.limit ?? 200));
    const candidatePredicates = [
      eq(issueRecoveryActions.status, "active"),
      isNotNull(issueRecoveryActions.maxAttempts),
      isNotNull(issueRecoveryActions.timeoutAt),
      lte(issueRecoveryActions.timeoutAt, now),
    ];
    if (input.companyId) {
      candidatePredicates.push(eq(issueRecoveryActions.companyId, input.companyId));
    }

    const candidateIds = await db
      .select({ id: issueRecoveryActions.id })
      .from(issueRecoveryActions)
      .where(and(...candidatePredicates))
      .orderBy(asc(issueRecoveryActions.timeoutAt))
      .limit(limit)
      .then((rows) => rows.map((row) => row.id));
    if (candidateIds.length === 0) return [];

    const updated = await db
      .update(issueRecoveryActions)
      .set({ status: "escalated", updatedAt: now })
      .where(and(
        inArray(issueRecoveryActions.id, candidateIds),
        eq(issueRecoveryActions.status, "active"),
      ))
      .returning();

    return updated.map(toReadModel);
  }

  async function resolveActiveForIssue(
    input: ResolveIssueRecoveryActionInput,
    dbOrTx: DbOrTransaction = db,
  ): Promise<IssueRecoveryAction | null> {
    const now = new Date();
    const predicates = [
      eq(issueRecoveryActions.companyId, input.companyId),
      eq(issueRecoveryActions.sourceIssueId, input.sourceIssueId),
      inArray(issueRecoveryActions.status, [...ACTIVE_RECOVERY_ACTION_STATUSES]),
    ];
    if (input.actionId) {
      predicates.push(eq(issueRecoveryActions.id, input.actionId));
    }
    if (input.kind) {
      predicates.push(eq(issueRecoveryActions.kind, input.kind));
    }
    if (input.cause) {
      predicates.push(eq(issueRecoveryActions.cause, input.cause));
    }
    if (input.fingerprint) {
      predicates.push(eq(issueRecoveryActions.fingerprint, input.fingerprint));
    }

    const [updated] = await dbOrTx
      .update(issueRecoveryActions)
      .set({
        status: input.status,
        outcome: input.outcome,
        resolutionNote: input.resolutionNote ?? null,
        resolvedAt: now,
        updatedAt: now,
      })
      .where(and(...predicates))
      .returning();

    return updated ? toReadModel(updated) : null;
  }

  return {
    getActiveForIssue,
    listActiveForIssues,
    resolveActiveForIssue,
    escalateExpiredWakeHorizons,
    upsertSourceScoped,
    releaseWakeAttempt,
  };
}
