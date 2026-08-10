import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import { issueComments, issueCommentEffects, type Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

/**
 * Durable effect ledger for the post-insert pipeline of an idempotent issue
 * comment. See `packages/db/src/schema/issue_comment_effects.ts` for why this
 * exists; in short, an accepted keyed comment must always leave behind
 * retryable work rather than a silently-incomplete side-effect pipeline, and
 * concurrent same-key requests must not both run that pipeline.
 *
 * Ownership model: every effect row is claimed by CAS with a lease. Exactly one
 * caller — a request handler or the reconciler — wins a given claim, so an
 * effect executes once even when two same-key requests overlap. A claim whose
 * lease expires (process died mid-effect) is reclaimable, which is what makes
 * crash recovery eventual rather than manual.
 */

export const COMMENT_EFFECT_KINDS = [
  "references_sync",
  "comment_activity",
  "interaction_expiry",
  "recovery_revalidation",
  "wake",
  "watchdog_evaluation",
  "run_activity",
] as const;

export type CommentEffectKind = (typeof COMMENT_EFFECT_KINDS)[number];

export type CommentEffectRow = typeof issueCommentEffects.$inferSelect;

export interface CommentEffectIntent {
  readonly effectKind: CommentEffectKind;
  /** Deterministic identity within the comment. Re-enqueueing is a no-op. */
  readonly effectKey: string;
  readonly payload: Record<string, unknown>;
}

/** How long a claim is held before another worker may reclaim it. */
export const DEFAULT_CLAIM_LEASE_MS = 60_000;
/** Attempts after which an effect uses the slower exhausted-retry backoff. */
export const MAX_EFFECT_ATTEMPTS = 10;
/** First retry delay for a failed effect. Later normal failures back off exponentially. */
export const EFFECT_RETRY_BASE_DELAY_MS = 1_000;
/** Cap for normal exponential retries before the exhausted backoff applies. */
export const EFFECT_RETRY_MAX_DELAY_MS = 60_000;
/**
 * Durable cooling-off period after repeated failures. `failed` remains
 * reclaimable after this delay; it is deliberately not a terminal state.
 */
export const EFFECT_EXHAUSTED_RETRY_DELAY_MS = 5 * 60_000;

export function getEffectRetryDelayMs(attempts: number): number {
  if (attempts >= MAX_EFFECT_ATTEMPTS) return EFFECT_EXHAUSTED_RETRY_DELAY_MS;
  return Math.min(
    EFFECT_RETRY_MAX_DELAY_MS,
    EFFECT_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attempts - 1),
  );
}

/**
 * Persist the deterministic effect intents for a comment.
 *
 * MUST be called inside the same transaction that inserts the comment: that
 * atomicity is the whole point, so there is no window where an accepted comment
 * has no durable record of the work it still owes.
 *
 * Conflicts on `(comment_id, effect_key)` are ignored so a replay that
 * re-derives the same intent set does not duplicate rows.
 */
export async function enqueueCommentEffects(
  tx: Db,
  input: {
    companyId: string;
    issueId: string;
    commentId: string;
    effects: readonly CommentEffectIntent[];
  },
): Promise<void> {
  if (input.effects.length === 0) return;
  await tx
    .insert(issueCommentEffects)
    .values(
      input.effects.map((effect) => ({
        companyId: input.companyId,
        issueId: input.issueId,
        commentId: input.commentId,
        effectKind: effect.effectKind,
        effectKey: effect.effectKey,
        payload: effect.payload,
      })),
    )
    .onConflictDoNothing({
      target: [issueCommentEffects.commentId, issueCommentEffects.effectKey],
    });
}

/** Effects still owed by a comment, in deterministic execution order. */
export async function listUnfinishedEffects(db: Db, commentId: string): Promise<CommentEffectRow[]> {
  return db
    .select()
    .from(issueCommentEffects)
    .where(
      and(
        eq(issueCommentEffects.commentId, commentId),
        ne(issueCommentEffects.status, "processed"),
      ),
    )
    .orderBy(asc(issueCommentEffects.seq));
}

export async function hasCommentEffects(db: Db, commentId: string): Promise<boolean> {
  const rows = await db
    .select({ id: issueCommentEffects.id })
    .from(issueCommentEffects)
    .where(eq(issueCommentEffects.commentId, commentId))
    .limit(1);
  return rows.length > 0;
}

/**
 * Take exclusive ownership of one effect.
 *
 * The CAS predicate accepts a due `queued` or `failed` row, or `processing`
 * with an expired lease (its previous owner died). Returns null when another
 * live claim holds the row — or when a failure is still in durable backoff —
 * so the caller must then skip it rather than run it. That is what stops two
 * concurrent same-key requests from double-executing.
 *
 * Both the stamped lease and the expiry predicate come from database `now()`,
 * never from this process's clock. Mixing the two is not cosmetic: with the
 * local clock running ahead, a replica evaluates `claimExpiresAt < now` against
 * a *future* instant and reclaims a lease another replica is still holding,
 * running the same non-idempotent sink concurrently; running behind, it defers
 * recovery of a genuinely dead owner. Because every lease is written and read
 * in database time, the comparison is skew-free no matter how many replicas
 * race here.
 */
export async function claimEffect(
  db: Db,
  effectId: string,
  leaseMs: number = DEFAULT_CLAIM_LEASE_MS,
): Promise<CommentEffectRow | null> {
  const claimToken = randomUUID();
  const rows = await db
    .update(issueCommentEffects)
    .set({
      status: "processing",
      claimToken,
      claimedAt: sql`now()`,
      claimExpiresAt: sql`now() + make_interval(secs => ${leaseMs / 1000})`,
      attempts: sql`${issueCommentEffects.attempts} + 1`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(issueCommentEffects.id, effectId),
        or(
          and(
            inArray(issueCommentEffects.status, ["queued", "failed"]),
            lte(issueCommentEffects.nextAttemptAt, sql`now()`),
          ),
          and(
            eq(issueCommentEffects.status, "processing"),
            lt(issueCommentEffects.claimExpiresAt, sql`now()`),
          ),
        ),
      ),
    )
    .returning();
  return rows[0] ?? null;
}

/**
 * Extend our lease on an in-flight effect.
 *
 * A sink that legitimately runs longer than one lease would otherwise be
 * reclaimed and executed a second time concurrently. Renewal keeps a *healthy*
 * slow worker's claim alive; a dead worker stops renewing and is still reclaimed
 * on schedule, so crash recovery is unaffected.
 *
 * The new expiry is computed from `now()` on the database rather than from this
 * process's clock: the lease is compared against database time by every other
 * reader, so deriving it from a skewed local clock is what would make a renewal
 * silently short (or never-expiring).
 *
 * Returns false when the claim token no longer matches — we have already lost
 * ownership and must stop touching the row.
 */
export async function renewEffectLease(
  db: Db,
  effectId: string,
  claimToken: string,
  leaseMs: number = DEFAULT_CLAIM_LEASE_MS,
): Promise<boolean> {
  const rows = await db
    .update(issueCommentEffects)
    .set({
      claimExpiresAt: sql`now() + make_interval(secs => ${leaseMs / 1000})`,
      updatedAt: sql`now()`,
    })
    .where(and(
      eq(issueCommentEffects.id, effectId),
      eq(issueCommentEffects.status, "processing"),
      eq(issueCommentEffects.claimToken, claimToken),
    ))
    .returning({ id: issueCommentEffects.id });
  return rows.length > 0;
}

/**
 * Record an effect as done, optionally publishing a result for later effects.
 *
 * Returns false when the CAS matched nothing, i.e. our lease expired and another
 * worker reclaimed the row. The caller MUST treat that as lost ownership and
 * stop: continuing to later effects would run them alongside the new owner.
 */
export async function completeEffect(
  db: Db,
  effect: Pick<CommentEffectRow, "id" | "claimToken">,
  result?: Record<string, unknown> | null,
): Promise<boolean> {
  const claimToken = effect.claimToken;
  if (!claimToken) throw new Error("Cannot complete an unclaimed comment effect");
  const now = new Date();
  const rows = await db
    .update(issueCommentEffects)
    .set({
      status: "processed",
      processedAt: now,
      updatedAt: now,
      claimExpiresAt: null,
      claimToken: null,
      lastError: null,
      ...(result === undefined ? {} : { result }),
    })
    .where(and(
      eq(issueCommentEffects.id, effect.id),
      eq(issueCommentEffects.status, "processing"),
      eq(issueCommentEffects.claimToken, claimToken),
    ))
    .returning({ id: issueCommentEffects.id });
  return rows.length > 0;
}

/**
 * Release a failed claim into durable retry backoff. Repeated failures use the
 * `failed` state and a longer delay, but every failure remains reclaimable:
 * treating an unexecuted effect as settled would lose the side effect forever.
 *
 * Returns false when we had already lost ownership, so the caller does not
 * report a retry it did not actually schedule.
 */
export async function releaseEffect(
  db: Db,
  effect: CommentEffectRow,
  err: unknown,
): Promise<boolean> {
  const claimToken = effect.claimToken;
  if (!claimToken) throw new Error("Cannot release an unclaimed comment effect");
  const exhausted = effect.attempts >= MAX_EFFECT_ATTEMPTS;
  const retryDelayMs = getEffectRetryDelayMs(effect.attempts);
  const rows = await db
    .update(issueCommentEffects)
    .set({
      status: exhausted ? "failed" : "queued",
      lastError: String(err),
      nextAttemptAt: sql`now() + make_interval(secs => ${retryDelayMs / 1000})`,
      claimExpiresAt: null,
      claimToken: null,
      updatedAt: sql`now()`,
    })
    .where(and(
      eq(issueCommentEffects.id, effect.id),
      eq(issueCommentEffects.status, "processing"),
      eq(issueCommentEffects.claimToken, claimToken),
    ))
    .returning({ id: issueCommentEffects.id });
  return rows.length > 0;
}

/** Read a sibling effect's published result (e.g. the reference diff). */
export async function getEffectResult(
  db: Db,
  commentId: string,
  effectKey: string,
): Promise<{ status: string; result: Record<string, unknown> | null } | null> {
  const rows = await db
    .select({ status: issueCommentEffects.status, result: issueCommentEffects.result })
    .from(issueCommentEffects)
    .where(
      and(
        eq(issueCommentEffects.commentId, commentId),
        eq(issueCommentEffects.effectKey, effectKey),
      ),
    );
  return rows[0] ?? null;
}

/**
 * Mark the comment processed iff every one of its effects is `processed`.
 * `failed` is a retry backoff state, not settlement: it represents a side effect
 * that still has not happened and must keep the idempotent comment visibly
 * unfinished until a later reclaim completes it.
 */
export async function markCommentProcessedIfSettled(db: Db, commentId: string): Promise<boolean> {
  const outstanding = await db
    .select({ id: issueCommentEffects.id })
    .from(issueCommentEffects)
    .where(
      and(
        eq(issueCommentEffects.commentId, commentId),
        ne(issueCommentEffects.status, "processed"),
      ),
    )
    .limit(1);
  if (outstanding.length > 0) return false;

  const stamped = await db
    .update(issueComments)
    .set({ idempotencyProcessedAt: new Date() })
    .where(
      and(
        eq(issueComments.id, commentId),
        isNull(issueComments.idempotencyProcessedAt),
        isNull(issueComments.deletedAt),
      ),
    )
    .returning({ id: issueComments.id });

  return stamped.length > 0 || outstanding.length === 0;
}

/**
 * Comments whose effects are still outstanding and are due for another attempt
 * — i.e. a due `queued` or `failed` row, or `processing` past its lease. This
 * is the reconciler's work list; it is what turns a crashed request and a
 * repeated dispatch failure into eventual completion.
 *
 * The lease predicate uses database `now()`, matching `claimEffect`: a
 * reconciler on a fast-running clock would otherwise hand itself work whose
 * lease is still live, then lose the claim CAS and burn the attempt.
 */
export async function listCommentsWithResumableEffects(
  db: Db,
  limit: number,
): Promise<string[]> {
  const rows = await db
    .selectDistinct({ commentId: issueCommentEffects.commentId })
    .from(issueCommentEffects)
    .where(
      or(
        and(
          inArray(issueCommentEffects.status, ["queued", "failed"]),
          lte(issueCommentEffects.nextAttemptAt, sql`now()`),
        ),
        and(
          eq(issueCommentEffects.status, "processing"),
          lt(issueCommentEffects.claimExpiresAt, sql`now()`),
        ),
      ),
    )
    .limit(limit);
  return rows.map((row: { commentId: string }) => row.commentId);
}

/**
 * Startup reclaim for rows stranded `processing` with no lease recorded at all.
 * A NULL `claim_expires_at` cannot be compared against `now()`, so such a row
 * would never be picked up by the expiry predicate above.
 */
export async function resetLeaselessProcessing(db: Db): Promise<number> {
  const rows = await db
    .update(issueCommentEffects)
    .set({
      status: "queued",
      claimToken: null,
      claimExpiresAt: null,
      nextAttemptAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(issueCommentEffects.status, "processing"),
        isNull(issueCommentEffects.claimExpiresAt),
      ),
    )
    .returning({ id: issueCommentEffects.id });
  return rows.length;
}

/** True when the comment has at least one effect that never settled. */
export async function hasUnsettledEffects(db: Db, commentId: string): Promise<boolean> {
  const rows = await db
    .select({ id: issueCommentEffects.id })
    .from(issueCommentEffects)
    .where(
      and(
        eq(issueCommentEffects.commentId, commentId),
        ne(issueCommentEffects.status, "processed"),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * Comments whose effects all completed but whose `idempotency_processed_at`
 * was never stamped.
 *
 * This is a real reachable state, not defensive padding: whenever a worker loses
 * its lease mid-pipeline, the worker that finishes the last effect may not be the
 * one that runs settlement, and the resumable-work query above cannot see the
 * comment any more because no row is left `queued` or lease-expired. Without this
 * sweep such a comment stays unprocessed forever and every later replay redoes
 * the whole pipeline.
 */
export async function listSettledUnprocessedComments(
  db: Db,
  limit: number,
): Promise<string[]> {
  const rows = await db
    .selectDistinct({ commentId: issueCommentEffects.commentId })
    .from(issueCommentEffects)
    .innerJoin(issueComments, eq(issueComments.id, issueCommentEffects.commentId))
    .where(
      and(
        isNull(issueComments.idempotencyProcessedAt),
        isNull(issueComments.deletedAt),
        sql`not exists (
          select 1 from ${issueCommentEffects} inner_effects
          where inner_effects.comment_id = ${issueCommentEffects.commentId}
            and inner_effects.status <> 'processed'
        )`,
      ),
    )
    .limit(limit);
  return rows.map((row: { commentId: string }) => row.commentId);
}

/**
 * Run every effect a comment still owes, in order, under a renewed lease.
 *
 * Returns false when the pipeline was not carried to settlement by *this* call —
 * either another worker holds a claim, or ours expired mid-flight. That is not an
 * error: the winning worker (or the reconciler) finishes the chain.
 */
export async function processCommentEffects(
  db: Db,
  commentId: string,
  execute: (effect: CommentEffectRow) => Promise<Record<string, unknown> | null | void>,
  leaseMs: number = DEFAULT_CLAIM_LEASE_MS,
): Promise<boolean> {
  const effects = await listUnfinishedEffects(db, commentId);
  for (const effect of effects) {
    const claimed = await claimEffect(db, effect.id, leaseMs);
    // Someone else owns this effect. Stopping here (rather than skipping ahead)
    // is what preserves execution order: later effects may read this one's result.
    if (!claimed) return false;
    const claimToken = claimed.claimToken;
    if (!claimToken) return false;

    // Renew well inside the lease so one slow renewal round-trip cannot let it
    // lapse. `lostOwnership` latches: once reclaimed we must not complete.
    let lostOwnership = false;
    const renewalTimer = setInterval(() => {
      void renewEffectLease(db, claimed.id, claimToken, leaseMs)
        .then((stillOwned) => {
          if (!stillOwned) lostOwnership = true;
        })
        .catch((err) =>
          logger.warn({ err, effectId: claimed.id }, "issue-comment-effects: lease renewal failed"));
    }, Math.max(1_000, Math.floor(leaseMs / 3)));
    renewalTimer.unref?.();

    try {
      const result = await execute(claimed);
      if (lostOwnership) return false;
      // The CAS is the authority, not `lostOwnership`: a reclaim can land between
      // the last renewal and here, and only the write can tell us.
      if (!await completeEffect(db, claimed, result ?? null)) return false;
    } catch (err) {
      await releaseEffect(db, claimed, err);
      throw err;
    } finally {
      clearInterval(renewalTimer);
    }
  }
  return markCommentProcessedIfSettled(db, commentId);
}

export function startIssueCommentEffectReconciler(
  db: Db,
  process: (commentId: string) => Promise<unknown>,
  intervalMs: number = 1_000,
): () => Promise<void> {
  let pass: Promise<void> = Promise.resolve();
  let polling = false;
  let stopped = false;
  void resetLeaselessProcessing(db).catch((err) =>
    logger.warn({ err }, "issue-comment-effects: stale-processing reset failed"));
  const timer = setInterval(() => {
    if (polling || stopped) return;
    polling = true;
    pass = (async () => {
      const resumable = await listCommentsWithResumableEffects(db, 50);
      for (const commentId of resumable) {
        if (stopped) break;
        await process(commentId).catch((err) =>
          logger.warn({ err, commentId }, "issue-comment-effects: reconciliation failed"));
      }
      // Comments whose effects all settled but that nobody stamped processed.
      // Settlement only, no sink re-execution.
      const stranded = await listSettledUnprocessedComments(db, 50);
      for (const commentId of stranded) {
        if (stopped) break;
        await markCommentProcessedIfSettled(db, commentId).catch((err) =>
          logger.warn({ err, commentId }, "issue-comment-effects: settlement sweep failed"));
      }
    })()
      .catch((err) => logger.warn({ err }, "issue-comment-effects: reconciliation pass failed"))
      .finally(() => {
        polling = false;
      });
  }, intervalMs);
  timer.unref?.();
  // Awaitable so shutdown drains an in-flight pass instead of abandoning claims
  // to lease expiry, which would replay work the pass had already done.
  return async () => {
    stopped = true;
    clearInterval(timer);
    await pass.catch(() => {});
  };
}
