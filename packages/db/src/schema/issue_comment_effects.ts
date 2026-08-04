import { pgTable, uuid, text, timestamp, jsonb, integer, bigserial, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { issueComments } from "./issue_comments.js";

/**
 * Durable effect ledger for the post-insert pipeline of an idempotent issue
 * comment.
 *
 * Accepting a keyed comment used to be a single row insert followed by a
 * best-effort in-request pipeline (reference sync, activity + plugin event,
 * interaction expiry, recovery revalidation, agent wakes, watchdog). Two
 * failure modes fell out of that:
 *
 *  - A crash or a swallowed dispatch rejection between the insert and the
 *    `idempotency_processed_at` update left an *accepted* comment whose
 *    side effects never ran. Retries short-circuit on the existing row, so the
 *    missing wake was permanent rather than retryable.
 *  - Two concurrent same-key requests both observed `idempotency_processed_at`
 *    null and both ran the whole pipeline, with no exclusive owner.
 *
 * This table is the fix, and mirrors `plugin_event_outbox`: the comment row and
 * one row per deterministic effect commit in the same transaction, so an
 * accepted comment always carries durable, retryable work. Each effect is then
 * claimed individually (CAS on `status` + lease expiry) so exactly one worker —
 * request handler or reconciler — executes it. The comment is only marked
 * processed once every one of its effect rows is `processed`.
 *
 * Unlike `plugin_event_outbox`, claims here carry an explicit lease: the API
 * tier is multi-replica and same-key requests race, so "single replica ⇒
 * nothing is mid-flight" does not hold and a crashed claim must be reclaimable
 * by expiry rather than only at worker startup.
 */
export const issueCommentEffects = pgTable(
  "issue_comment_effects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Monotonic insertion order — drives deterministic execution order. */
    seq: bigserial("seq", { mode: "number" }).notNull(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    issueId: uuid("issue_id")
      .notNull()
      .references(() => issues.id),
    commentId: uuid("comment_id")
      .notNull()
      .references(() => issueComments.id, { onDelete: "cascade" }),
    /**
     * Effect family: `references_sync`, `comment_activity`,
     * `interaction_expiry`, `recovery_revalidation`, `wake`,
     * `watchdog_evaluation`.
     */
    effectKind: text("effect_kind").notNull(),
    /**
     * Deterministic identity of this effect within the comment (e.g.
     * `wake:<agentId>:<issueId>`). Unique per comment so re-enqueueing the same
     * intent is a no-op instead of a duplicate.
     */
    effectKey: text("effect_key").notNull(),
    /** queued → processing → processed | failed */
    status: text("status").notNull().default("queued"),
    /** Everything the executor needs to run without the originating request. */
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    /**
     * Output an effect must hand to a later effect — currently the reference
     * diff produced by `references_sync`, which `comment_activity` embeds in its
     * activity details and cannot recompute once the sync has already run.
     */
    result: jsonb("result").$type<Record<string, unknown> | null>(),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    /** Ownership token; prevents a stale lease holder completing a reclaimed row. */
    claimToken: uuid("claim_token"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    claimExpiresAt: timestamp("claim_expires_at", { withTimezone: true }),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    commentEffectKeyIdx: uniqueIndex("issue_comment_effects_comment_effect_key_idx").on(
      table.commentId,
      table.effectKey,
    ),
    statusSeqIdx: index("issue_comment_effects_status_seq_idx").on(table.status, table.seq),
    commentSeqIdx: index("issue_comment_effects_comment_seq_idx").on(table.commentId, table.seq),
  }),
);
