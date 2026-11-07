import { pgTable, uuid, text, timestamp, jsonb, integer, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { approvals } from "./approvals.js";
import { agents } from "./agents.js";

/**
 * One row per superseded `approvals.payload`, written by `PATCH /approvals/:id`.
 *
 * A pending card's payload used to be immutable to the agent that filed it, so a
 * filer whose stated evidence had gone stale had exactly two moves: leave false
 * evidence in front of a human decider, or `withdraw` and re-file. Re-filing mints
 * a new row with a new `created_at`, and service is measurably recency-skewed
 * (PEN-3918 cmt `d00b4081` §4: the 11-03 burst decided 17 cards, 16 of them newer
 * than the oldest card it left pending), so correcting your own evidence and
 * jumping ahead of cards that had waited longer were the same keystroke (PEN-5766).
 *
 * `payload` here is the payload AS IT WAS BEFORE the edit that created this row —
 * the prior value, not the new one. `revision` is the number that payload held, so
 * the first edit of a never-edited card writes `revision = 0` and leaves
 * `approvals.payload_revision = 1`. The live payload is always on `approvals`, and
 * is deliberately NOT duplicated here: two copies of the current value is how they
 * come to disagree.
 *
 * ⚠️ This table is the disclosure half of a trade made with eyes open. An editable
 * payload means a decider can approve a card whose text changed after they read it
 * — a real regression against the immutability it replaces, which was doing that
 * safety work for free. The mitigation is that the change is VISIBLE (the edit
 * marker on the card, and this history behind it) where the failure it replaces was
 * SILENT. It is not prevention: nothing here stops the race, it only makes it
 * readable afterwards.
 */
export const approvalPayloadRevisions = pgTable(
  "approval_payload_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    approvalId: uuid("approval_id").notNull().references(() => approvals.id, { onDelete: "cascade" }),
    /** The revision number the archived payload held, counting from 0. */
    revision: integer("revision").notNull(),
    /** The payload as it stood BEFORE the edit that superseded it. */
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    editedByAgentId: uuid("edited_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    editedByUserId: text("edited_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    approvalRevisionIdx: index("approval_payload_revisions_approval_revision_idx").on(
      table.approvalId,
      table.revision,
    ),
    companyIdx: index("approval_payload_revisions_company_idx").on(table.companyId),
    // One archived copy per (card, revision). The edit is applied with a
    // `payload_revision` guard in the same transaction, so two concurrent edits
    // cannot both believe they superseded revision N — this index is the backstop
    // that turns a lost race into a refusal rather than a forked history.
    approvalRevisionUniqueIdx: uniqueIndex("approval_payload_revisions_approval_revision_unique_idx").on(
      table.approvalId,
      table.revision,
    ),
  }),
);
