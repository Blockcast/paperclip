import { pgTable, uuid, text, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
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
    decidedByUserId: text("decided_by_user_id"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
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
