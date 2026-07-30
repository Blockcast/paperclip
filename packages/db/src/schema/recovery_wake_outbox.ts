import {
  bigserial,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

/**
 * Transactional outbox for recovery-owner wakes (BLO-18829).
 *
 * Stranded-issue escalation used to call `enqueueWakeup` inline, BEFORE the
 * expected-status CAS that guards the `blocked` transition. When a concurrent
 * writer (e.g. a reviewer PATCHing to `in_review`) landed between the status
 * re-check and the CAS, the CAS correctly no-op'd but the wake had already
 * escaped -- waking a recovery owner for an issue that was no longer stranded.
 *
 * The wake cannot simply move after the CAS either: `reconcileStrandedAssignedIssues`
 * does not select `blocked` issues, so a wake lost after commit has no retry path
 * and the issue strands permanently. And `enqueueWakeup` itself cannot be pulled
 * into the escalation transaction -- it opens its own `db.transaction(...)` blocks,
 * which run on a different pooled connection and would block on the escalation's
 * own advisory lock.
 *
 * So: escalation inserts a row here on the SAME transaction as the status write,
 * and a post-commit dispatcher drains it with backoff. A CAS miss rolls the row
 * back with the rest of the side effects; a committed escalation always leaves a
 * durable wake behind, even if the dispatching process dies.
 */
export const recoveryWakeOutbox = pgTable(
  "recovery_wake_outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Monotonic insertion order — drives deterministic FIFO dispatch. */
    seq: bigserial("seq", { mode: "number" }).notNull(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    sourceIssueId: uuid("source_issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    recoveryActionId: uuid("recovery_action_id"),
    /** Agent to wake. Cascades to null so a deleted agent can't wedge the queue. */
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    /** Denormalized for observability / the field-signal query; not read by the dispatcher. */
    recoveryCause: text("recovery_cause"),
    /**
     * The full `enqueueWakeup` options bag, replayed verbatim on dispatch. Kept
     * opaque so adding a wake option never needs a migration here.
     */
    wakeOptions: jsonb("wake_options").$type<Record<string, unknown>>().notNull(),
    /**
     * Mirrors `wakeOptions.idempotencyKey`. UNIQUE, so a re-escalation at the same
     * attempt count collapses onto the existing row instead of double-waking.
     */
    idempotencyKey: text("idempotency_key").notNull(),
    /** queued → processing → sent | failed */
    status: text("status").notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    /** Backoff gate. The plugin outbox lacks this and hot-loops failures at 1s. */
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
  },
  (table) => ({
    idempotencyKeyUq: uniqueIndex("recovery_wake_outbox_idempotency_key_uq").on(table.idempotencyKey),
    claimIdx: index("recovery_wake_outbox_claim_idx").on(table.status, table.nextAttemptAt, table.seq),
    sourceIssueIdx: index("recovery_wake_outbox_source_issue_idx").on(table.sourceIssueId),
  }),
);
