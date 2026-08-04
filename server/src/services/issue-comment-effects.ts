import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
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
/** Attempts after which an effect stops being retried and is parked `failed`. */
export const MAX_EFFECT_ATTEMPTS = 10;

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
        inArray(issueCommentEffects.status, ["queued", "processing"]),
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
 * The CAS predicate accepts a row that is `queued`, or `processing` with an
 * expired lease (its previous owner died). Returns null when another live
 * claim holds the row — the caller must then skip it rather than run it, which
 * is what stops two concurrent same-key requests from double-executing.
 */
export async function claimEffect(
  db: Db,
  effectId: string,
  leaseMs: number = DEFAULT_CLAIM_LEASE_MS,
): Promise<CommentEffectRow | null> {
  const now = new Date();
  const claimToken = randomUUID();
  const rows = await db
    .update(issueCommentEffects)
    .set({
      status: "processing",
      claimToken,
      claimedAt: now,
      claimExpiresAt: new Date(now.getTime() + leaseMs),
      attempts: sql`${issueCommentEffects.attempts} + 1`,
      updatedAt: now,
    })
    .where(
      and(
        eq(issueCommentEffects.id, effectId),
        or(
          eq(issueCommentEffects.status, "queued"),
          and(
            eq(issueCommentEffects.status, "processing"),
            lt(issueCommentEffects.claimExpiresAt, now),
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
 * Release a failed claim back to `queued` so it is retried, or park it `failed`
 * once it has burned through MAX_EFFECT_ATTEMPTS. Parking is what stops a
 * genuinely poisonous effect from pinning a comment permanently unprocessed.
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
  const now = new Date();
  const giveUp = effect.attempts >= MAX_EFFECT_ATTEMPTS;
  const rows = await db
    .update(issueCommentEffects)
    .set({
      status: giveUp ? "failed" : "queued",
      lastError: String(err),
      claimExpiresAt: null,
      claimToken: null,
      updatedAt: now,
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
 * Mark the comment processed iff every one of its effects has settled.
 *
 * `failed` counts as settled. It is terminal — the row is only parked there after
 * MAX_EFFECT_ATTEMPTS, and no query will hand it out again — so treating it as
 * outstanding would pin the comment unprocessed forever while `idempotency`
 * replays redid the entire pipeline on every retry, chasing an effect that can
 * never succeed. That is strictly worse than the pre-ledger behaviour. A parked
 * effect is visible via its `failed` status and `last_error`; settlement is about
 * "is any work still owed", and the answer for a parked effect is no.
 *
 * Returns true when the comment is (now or already) processed.
 */
export async function markCommentProcessedIfSettled(db: Db, commentId: string): Promise<boolean> {
  const outstanding = await db
    .select({ id: issueCommentEffects.id })
    .from(issueCommentEffects)
    .where(
      and(
        eq(issueCommentEffects.commentId, commentId),
        inArray(issueCommentEffects.status, ["queued", "processing"]),
      ),
    )
    .limit(1);
  if (outstanding.length > 0) return false;

  await db
    .update(issueComments)
    .set({ idempotencyProcessedAt: new Date() })
    .where(
      and(
        eq(issueComments.id, commentId),
        isNull(issueComments.idempotencyProcessedAt),
        isNull(issueComments.deletedAt),
      ),
    );
  return true;
}

/**
 * Comments whose effects are still outstanding and are due for another attempt
 * — i.e. `queued`, or `processing` past its lease. This is the reconciler's
 * work list; it is what turns a crashed request into eventual completion.
 */
export async function listCommentsWithResumableEffects(
  db: Db,
  limit: number,
): Promise<string[]> {
  const now = new Date();
  const rows = await db
    .selectDistinct({ commentId: issueCommentEffects.commentId })
    .from(issueCommentEffects)
    .where(
      or(
        eq(issueCommentEffects.status, "queued"),
        and(
          eq(issueCommentEffects.status, "processing"),
          lt(issueCommentEffects.claimExpiresAt, now),
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
    .set({ status: "queued", claimToken: null, updatedAt: new Date() })
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
 * Comments whose effects have all settled but whose `idempotency_processed_at`
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
            and inner_effects.status in ('queued', 'processing')
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
