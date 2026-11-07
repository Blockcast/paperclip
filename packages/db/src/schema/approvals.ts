import { pgTable, uuid, text, timestamp, jsonb, integer, boolean, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

export const approvals = pgTable(
  "approvals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    type: text("type").notNull(),
    linkedAgentId: uuid("linked_agent_id").references(() => agents.id, { onDelete: "set null" }),
    requestedByAgentId: uuid("requested_by_agent_id").references(() => agents.id),
    requestedByUserId: text("requested_by_user_id"),
    status: text("status").notNull().default("pending"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    // Requester-supplied dedupe token. Scoped to (company, requester, key) and only
    // enforced while the approval is still undecided — see the partial indexes below.
    idempotencyKey: text("idempotency_key"),
    decisionNote: text("decision_note"),
    // Whether the `payload.gate` this card advertised was SATISFIED when the
    // reconciler closed it, as structured data (PEN-5885).
    //
    // `cancelled` is written on both branches of the gate close -- "the gated PR
    // merged" and "the gated PR was closed unmerged" land in the same column with
    // the same value -- so the one fact that separates a served ask from a dead
    // one survived only inside `decision_note` prose. Anything downstream that
    // needed it had to match an English sentence; the decision gauge did not try,
    // and so read twenty served asks as a dead channel.
    //
    // Three-valued on purpose, and the null is the common case: null means "no
    // gate adjudicated this card", which is true of every decided, withdrawn and
    // human-cancelled row and of every row that predates this column. Only the
    // reconciler writes it. See `approval-gate-reconciler.ts`.
    gateSatisfied: boolean("gate_satisfied"),
    decidedByUserId: text("decided_by_user_id"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    // How many times the payload has been edited in place by its requester, and
    // when it last was. Both are the EDIT MARKER a decider reads: `payloadRevision
    // > 0` means the text now on the card is not the text it was filed with, and
    // the superseded versions are in `approval_payload_revisions` (PEN-5766).
    //
    // `createdAt` is deliberately untouched by an edit. That is the entire point of
    // having an edit route at all: the alternative a filer had — withdraw and
    // re-file — mints a fresh `created_at`, and service is measurably recency-
    // skewed, so correcting stale evidence promoted the card over cards that had
    // waited longer (PEN-3918 cmt `d00b4081` §4). Preserving it is a correctness
    // requirement, not ergonomics.
    payloadRevision: integer("payload_revision").notNull().default(0),
    payloadEditedAt: timestamp("payload_edited_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusTypeIdx: index("approvals_company_status_type_idx").on(
      table.companyId,
      table.status,
      table.type,
    ),
    linkedAgentIdx: index("approvals_linked_agent_idx").on(table.linkedAgentId),
    // Two indexes rather than one because the requester is stored in one of two
    // mutually exclusive columns. Both are scoped to the undecided statuses: once the
    // board has answered an ask, re-filing the same key is a legitimately new request
    // (the answer may have changed the situation), so the key is released on decision.
    companyAgentIdempotencyIdx: uniqueIndex("approvals_company_agent_idempotency_idx")
      .on(table.companyId, table.requestedByAgentId, table.idempotencyKey)
      .where(
        sql`${table.idempotencyKey} IS NOT NULL AND ${table.requestedByAgentId} IS NOT NULL AND ${table.status} IN ('pending', 'revision_requested')`,
      ),
    companyUserIdempotencyIdx: uniqueIndex("approvals_company_user_idempotency_idx")
      .on(table.companyId, table.requestedByUserId, table.idempotencyKey)
      .where(
        sql`${table.idempotencyKey} IS NOT NULL AND ${table.requestedByUserId} IS NOT NULL AND ${table.status} IN ('pending', 'revision_requested')`,
      ),
  }),
);
