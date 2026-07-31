import { and, asc, eq, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import { issueComments, issueCommentEffects, type Db } from "@paperclipai/db";

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
  const rows = await db
    .update(issueCommentEffects)
    .set({
      status: "processing",
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

/** Record an effect as done, optionally publishing a result for later effects. */
export async function completeEffect(
  db: Db,
  effectId: string,
  result?: Record<string, unknown> | null,
): Promise<void> {
  const now = new Date();
  await db
    .update(issueCommentEffects)
    .set({
      status: "processed",
      processedAt: now,
      updatedAt: now,
      claimExpiresAt: null,
      lastError: null,
      ...(result === undefined ? {} : { result }),
    })
    .where(eq(issueCommentEffects.id, effectId));
}

/**
 * Release a failed claim back to `queued` so it is retried, or park it `failed`
 * once it has burned through MAX_EFFECT_ATTEMPTS. Parking is what stops a
 * genuinely poisonous effect from pinning a comment permanently unprocessed.
 */
export async function releaseEffect(
  db: Db,
  effect: CommentEffectRow,
  err: unknown,
): Promise<void> {
  const now = new Date();
  const giveUp = effect.attempts >= MAX_EFFECT_ATTEMPTS;
  await db
    .update(issueCommentEffects)
    .set({
      status: giveUp ? "failed" : "queued",
      lastError: String(err),
      claimExpiresAt: null,
      updatedAt: now,
    })
    .where(eq(issueCommentEffects.id, effect.id));
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
 * `failed` counts as settled: it is terminal after MAX_EFFECT_ATTEMPTS, and
 * leaving the comment unprocessed forever would make every later replay redo
 * the whole pipeline chasing an effect that will never succeed.
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
    .set({ status: "queued", updatedAt: new Date() })
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
