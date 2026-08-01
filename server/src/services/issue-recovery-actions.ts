import { and, desc, eq, exists, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentWakeupRequests, issueRecoveryActions, issues } from "@paperclipai/db";
import type {
  IssueRecoveryAction,
  IssueRecoveryActionKind,
  IssueRecoveryActionOwnerType,
  IssueRecoveryActionOutcome,
  IssueRecoveryActionStatus,
} from "@paperclipai/shared";

export const ACTIVE_RECOVERY_ACTION_STATUSES = ["active", "escalated"] as const satisfies readonly IssueRecoveryActionStatus[];
const MAX_UPSERT_RETRIES = 3;
const SOURCE_SCOPED_WAKE_HORIZON_EVIDENCE_KEY = "sourceScopedWakeHorizonAt";

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

export function issueRecoveryActionService(db: Db) {
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

  async function getActiveForIssue(
    companyId: string,
    sourceIssueId: string,
    dbOrTx: DbOrTransaction = db,
  ): Promise<IssueRecoveryAction | null> {
    const row = await dbOrTx
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
    dbOrTx: DbOrTransaction,
    error?: unknown,
  ): Promise<IssueRecoveryAction> {
    if (retryCount >= MAX_UPSERT_RETRIES) {
      if (error) throw error;
      throw new Error(
        `Failed to upsert active recovery action for issue ${input.sourceIssueId} after ${MAX_UPSERT_RETRIES} retries`,
      );
    }
    return upsertSourceScopedUnlocked(input, retryCount + 1, dbOrTx);
  }

  async function upsertSourceScopedUnlocked(
    input: UpsertIssueRecoveryActionInput,
    retryCount = 0,
    dbOrTx: DbOrTransaction = db,
  ): Promise<IssueRecoveryAction> {
    const existing = await getActiveForIssue(input.companyId, input.sourceIssueId, dbOrTx);
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
      const [updated] = await dbOrTx
        .update(issueRecoveryActions)
        .set({
          recoveryIssueId: input.recoveryIssueId ?? null,
          kind: input.kind,
          status: "active",
          ownerType,
          ownerAgentId: input.ownerAgentId ?? null,
          ownerUserId: input.ownerUserId ?? null,
          previousOwnerAgentId: input.previousOwnerAgentId ?? existing.previousOwnerAgentId,
          returnOwnerAgentId: input.returnOwnerAgentId ?? existing.returnOwnerAgentId,
          cause: input.cause,
          fingerprint: input.fingerprint,
          evidence: withSourceScopedWakeHorizonEvidence(input.evidence ?? existing.evidence, wakeHorizonAt),
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
          // Staying unbounded still preserves, which keeps the quota `retryAt` intact and the
          // `pr_review_non_convergence` caller (also `maxAttempts: null`) unaffected.
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
        return retryUpsertSourceScoped(input, retryCount, dbOrTx);
      }
      return toReadModel(updated!);
    }

    try {
      const [created] = await dbOrTx
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
          evidence: withSourceScopedWakeHorizonEvidence(
            input.evidence ?? {},
            (input.maxAttempts ?? null) !== null ? (input.timeoutAt ?? null) : null,
          ),
          nextAction: input.nextAction,
          wakePolicy: input.wakePolicy ?? null,
          monitorPolicy: input.monitorPolicy ?? null,
          attemptCount: 1,
          maxAttempts: input.maxAttempts ?? null,
          timeoutAt: input.timeoutAt ?? null,
          lastAttemptAt: input.lastAttemptAt ?? now,
        })
        .onConflictDoNothing()
        .returning();
      if (!created) {
        return retryUpsertSourceScoped(input, retryCount, dbOrTx);
      }
      return toReadModel(created!);
    } catch (error) {
      if (!isUniqueRecoveryActionConflict(error)) throw error;
      return retryUpsertSourceScoped(input, retryCount, dbOrTx, error);
    }
  }

  async function upsertSourceScoped(
    input: UpsertIssueRecoveryActionInput,
    dbOrTx: DbOrTransaction = db,
  ): Promise<IssueRecoveryAction> {
    return runExclusiveUpsert(input, () => upsertSourceScopedUnlocked(input, 0, dbOrTx));
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
  // Scoped to active statuses and matched on company so it cannot touch a resolved row.
  async function releaseWakeAttempt(input: { companyId: string; actionId: string }): Promise<void> {
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
          inArray(issueRecoveryActions.status, [...ACTIVE_RECOVERY_ACTION_STATUSES]),
        ),
      );
  }

  async function reserveWakeAttempt(input: {
    companyId: string;
    actionId: string;
    sourceIssueId?: string;
    ownerAgentId?: string;
    wakePolicyType?: string;
    requireBlockedSourceIssue?: boolean;
    requireNoOutstandingIssueWake?: boolean;
  }): Promise<IssueRecoveryAction | null> {
    const now = new Date();
    const [updated] = await db
      .update(issueRecoveryActions)
      .set({
        attemptCount: sql`${issueRecoveryActions.attemptCount} + 1`,
        lastAttemptAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(issueRecoveryActions.id, input.actionId),
          eq(issueRecoveryActions.companyId, input.companyId),
          input.sourceIssueId ? eq(issueRecoveryActions.sourceIssueId, input.sourceIssueId) : undefined,
          input.ownerAgentId ? eq(issueRecoveryActions.ownerAgentId, input.ownerAgentId) : undefined,
          input.wakePolicyType
            ? sql`${issueRecoveryActions.wakePolicy} ->> 'type' = ${input.wakePolicyType}`
            : undefined,
          inArray(issueRecoveryActions.status, [...ACTIVE_RECOVERY_ACTION_STATUSES]),
          sql`(${issueRecoveryActions.maxAttempts} is null or ${issueRecoveryActions.attemptCount} < ${issueRecoveryActions.maxAttempts})`,
          sql`(${issueRecoveryActions.timeoutAt} is null or ${issueRecoveryActions.timeoutAt} > ${now})`,
          input.requireBlockedSourceIssue && input.sourceIssueId
            ? exists(
              db
                .select({ id: issues.id })
                .from(issues)
                .where(and(
                  eq(issues.companyId, input.companyId),
                  eq(issues.id, input.sourceIssueId),
                  eq(issues.status, "blocked"),
                  isNull(issues.assigneeUserId),
                  isNull(issues.hiddenAt),
                )),
            )
            : undefined,
          input.requireNoOutstandingIssueWake && input.sourceIssueId && input.ownerAgentId
            ? sql`not exists (
                select 1
                from ${agentWakeupRequests}
                where ${agentWakeupRequests.companyId} = ${input.companyId}
                  and ${agentWakeupRequests.agentId} = ${input.ownerAgentId}
                  and ${agentWakeupRequests.status} in ('queued', 'deferred_issue_execution', 'claimed', 'running')
                  and ${agentWakeupRequests.payload} ->> 'issueId' = ${input.sourceIssueId}
              )`
            : undefined,
        ),
      )
      .returning();
    return updated ? toReadModel(updated) : null;
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
    upsertSourceScoped,
    releaseWakeAttempt,
    reserveWakeAttempt,
  };
}
