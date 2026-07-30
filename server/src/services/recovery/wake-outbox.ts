import { and, asc, eq, inArray, lte, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { recoveryWakeOutbox } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";

type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type DbOrTransaction = Db | DbTransaction;

/**
 * How many dispatch attempts a wake gets before it is parked as `failed`.
 *
 * Deliberately higher than the plugin outbox's 5: under-waking is the dangerous
 * direction here (a `blocked` issue with no wake is a permanent strand, because
 * `reconcileStrandedAssignedIssues` does not select `blocked` issues), whereas an
 * extra dispatch attempt only costs one suppressed/coalesced `enqueueWakeup` call.
 */
export const RECOVERY_WAKE_OUTBOX_MAX_ATTEMPTS = 10;
const BACKOFF_BASE_MS = 15_000;
const BACKOFF_MAX_MS = 10 * 60 * 1_000;
const CLAIM_BATCH = 25;

function backoffMs(attempts: number) {
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1), BACKOFF_MAX_MS);
}

export type RecoveryWakeOutboxRow = typeof recoveryWakeOutbox.$inferSelect;

export type StagedRecoveryWake = {
  companyId: string;
  sourceIssueId: string;
  recoveryActionId?: string | null;
  agentId: string;
  recoveryCause?: string | null;
  idempotencyKey: string;
  wakeOptions: Record<string, unknown>;
};

/**
 * The `enqueueWakeup` shape this dispatcher replays into.
 *
 * `opts` is intentionally loose: the stored `wakeOptions` come back from jsonb as a plain
 * record, and a narrower parameter type here would make the real `enqueueWakeup` (whose
 * options are a specific union-typed object) fail to satisfy this signature under
 * parameter contravariance.
 */
type WakeDispatcher = (
  agentId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  opts?: any,
) => Promise<unknown>;

/**
 * Stage a recovery-owner wake on the caller's transaction (BLO-18829).
 *
 * MUST be handed the same transaction as the escalation's expected-status write, so
 * that a lost CAS rolls the wake back along with the recovery action and monitor. The
 * unique index on `idempotency_key` makes a repeat escalation at the same attempt count
 * collapse onto the existing row rather than double-waking.
 */
export async function stageRecoveryWake(
  tx: DbOrTransaction,
  input: StagedRecoveryWake,
): Promise<void> {
  await tx
    .insert(recoveryWakeOutbox)
    .values({
      companyId: input.companyId,
      sourceIssueId: input.sourceIssueId,
      recoveryActionId: input.recoveryActionId ?? null,
      agentId: input.agentId,
      recoveryCause: input.recoveryCause ?? null,
      idempotencyKey: input.idempotencyKey,
      wakeOptions: input.wakeOptions,
    })
    .onConflictDoNothing({ target: recoveryWakeOutbox.idempotencyKey });
}

/**
 * Atomically claim one queued row. The `status = 'queued'` predicate inside the UPDATE
 * is the claim: whoever flips the row to `processing` wins and every other caller gets
 * zero rows back, so this is safe for the post-commit inline drain and the periodic
 * sweeper racing on the same row (and for >1 worker replica).
 */
async function claimNext(db: Db, sourceIssueId?: string): Promise<RecoveryWakeOutboxRow | null> {
  const now = new Date();
  const scope = [
    eq(recoveryWakeOutbox.status, "queued"),
    lte(recoveryWakeOutbox.nextAttemptAt, now),
    ...(sourceIssueId ? [eq(recoveryWakeOutbox.sourceIssueId, sourceIssueId)] : []),
  ];
  const [claimed] = await db
    .update(recoveryWakeOutbox)
    .set({ status: "processing", updatedAt: now })
    .where(
      and(
        eq(recoveryWakeOutbox.status, "queued"),
        inArray(
          recoveryWakeOutbox.id,
          db
            .select({ id: recoveryWakeOutbox.id })
            .from(recoveryWakeOutbox)
            .where(and(...scope))
            .orderBy(asc(recoveryWakeOutbox.seq))
            .limit(1),
        ),
      ),
    )
    .returning();
  return claimed ?? null;
}

async function markSent(db: Db, row: RecoveryWakeOutboxRow) {
  const now = new Date();
  await db
    .update(recoveryWakeOutbox)
    .set({ status: "sent", attempts: row.attempts + 1, dispatchedAt: now, updatedAt: now, lastError: null })
    .where(eq(recoveryWakeOutbox.id, row.id));
}

async function markRetry(db: Db, row: RecoveryWakeOutboxRow, error: unknown) {
  const attempts = row.attempts + 1;
  const exhausted = attempts >= RECOVERY_WAKE_OUTBOX_MAX_ATTEMPTS;
  const now = new Date();
  await db
    .update(recoveryWakeOutbox)
    .set({
      status: exhausted ? "failed" : "queued",
      attempts,
      lastError: String(error).slice(0, 2000),
      nextAttemptAt: new Date(now.getTime() + backoffMs(attempts)),
      updatedAt: now,
    })
    .where(eq(recoveryWakeOutbox.id, row.id));
  logger.warn(
    {
      outboxId: row.id,
      sourceIssueId: row.sourceIssueId,
      agentId: row.agentId,
      attempts,
      exhausted,
      err: error,
    },
    exhausted
      ? "recovery-wake-outbox: dispatch exhausted; issue may be blocked with no live wake"
      : "recovery-wake-outbox: dispatch failed; requeued with backoff",
  );
}

/**
 * Drain queued recovery wakes, calling `enqueueWakeup` outside any transaction.
 *
 * Called twice: inline right after the escalation transaction commits (so the wake is
 * prompt in the happy path), and from the periodic recovery sweep (so a wake survives
 * the dispatching process dying between commit and dispatch). Never throws -- a failed
 * dispatch is recorded on the row and retried.
 *
 * @param sourceIssueId scope to one issue (the post-commit drain); omit to sweep all.
 */
export async function dispatchRecoveryWakes(
  db: Db,
  enqueueWakeup: WakeDispatcher,
  opts: { sourceIssueId?: string; limit?: number } = {},
): Promise<{ dispatched: number; failed: number }> {
  const limit = opts.limit ?? CLAIM_BATCH;
  let dispatched = 0;
  let failed = 0;
  for (let i = 0; i < limit; i += 1) {
    let row: RecoveryWakeOutboxRow | null = null;
    try {
      row = await claimNext(db, opts.sourceIssueId);
    } catch (err) {
      logger.warn({ err }, "recovery-wake-outbox: claim failed");
      break;
    }
    if (!row) break;
    if (!row.agentId) {
      // Agent was deleted (FK is ON DELETE SET NULL). Nothing to wake; don't retry.
      await db
        .update(recoveryWakeOutbox)
        .set({ status: "failed", lastError: "agent deleted before dispatch", updatedAt: new Date() })
        .where(eq(recoveryWakeOutbox.id, row.id));
      failed += 1;
      continue;
    }
    try {
      await enqueueWakeup(row.agentId, row.wakeOptions);
      await markSent(db, row);
      dispatched += 1;
    } catch (err) {
      await markRetry(db, row, err).catch((markErr) => {
        logger.warn({ err: markErr, outboxId: row!.id }, "recovery-wake-outbox: failed to record retry");
      });
      failed += 1;
    }
  }
  return { dispatched, failed };
}

/**
 * Requeue rows stuck in `processing` because the dispatching process died mid-flight.
 *
 * `enqueueWakeup` is idempotent on `idempotencyKey`, so re-dispatching a wake that had
 * actually landed coalesces rather than double-waking -- which is why requeueing an
 * ambiguous `processing` row is the safe direction.
 */
export async function requeueStaleRecoveryWakes(
  db: Db,
  staleAfterMs = 5 * 60 * 1_000,
): Promise<number> {
  const cutoff = new Date(Date.now() - staleAfterMs);
  const rows = await db
    .update(recoveryWakeOutbox)
    .set({ status: "queued", updatedAt: new Date() })
    .where(
      and(
        eq(recoveryWakeOutbox.status, "processing"),
        lte(recoveryWakeOutbox.updatedAt, cutoff),
        sql`${recoveryWakeOutbox.attempts} < ${RECOVERY_WAKE_OUTBOX_MAX_ATTEMPTS}`,
      ),
    )
    .returning({ id: recoveryWakeOutbox.id });
  if (rows.length > 0) {
    logger.warn({ count: rows.length }, "recovery-wake-outbox: requeued stale processing rows");
  }
  return rows.length;
}

/** Test/ops helper: are there wakes still owed for this issue? */
export async function pendingRecoveryWakeCount(db: Db, sourceIssueId: string): Promise<number> {
  const rows = await db
    .select({ id: recoveryWakeOutbox.id })
    .from(recoveryWakeOutbox)
    .where(
      and(
        eq(recoveryWakeOutbox.sourceIssueId, sourceIssueId),
        or(eq(recoveryWakeOutbox.status, "queued"), eq(recoveryWakeOutbox.status, "processing")),
      ),
    );
  return rows.length;
}
