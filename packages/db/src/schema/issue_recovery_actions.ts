import { sql } from "drizzle-orm";
import {
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

export const issueRecoveryActions = pgTable(
  "issue_recovery_actions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    sourceIssueId: uuid("source_issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    recoveryIssueId: uuid("recovery_issue_id").references(() => issues.id, { onDelete: "set null" }),
    kind: text("kind").notNull(),
    status: text("status").notNull().default("active"),
    ownerType: text("owner_type").notNull().default("agent"),
    ownerAgentId: uuid("owner_agent_id").references(() => agents.id, { onDelete: "set null" }),
    ownerUserId: text("owner_user_id"),
    previousOwnerAgentId: uuid("previous_owner_agent_id").references(() => agents.id, { onDelete: "set null" }),
    returnOwnerAgentId: uuid("return_owner_agent_id").references(() => agents.id, { onDelete: "set null" }),
    cause: text("cause").notNull(),
    fingerprint: text("fingerprint").notNull(),
    evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull().default({}),
    nextAction: text("next_action").notNull(),
    wakePolicy: jsonb("wake_policy").$type<Record<string, unknown>>(),
    monitorPolicy: jsonb("monitor_policy").$type<Record<string, unknown>>(),
    attemptCount: integer("attempt_count").notNull().default(0),
    maxAttempts: integer("max_attempts"),
    timeoutAt: timestamp("timeout_at", { withTimezone: true }),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    outcome: text("outcome"),
    resolutionNote: text("resolution_note"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    /**
     * Why the stranded-recovery hand-back drain last declined to return this row to its
     * `returnOwnerAgentId` (BLO-19123). Null means the drain has not judged the row — either it
     * was never a candidate, or it was handed back and the marker cleared.
     *
     * This is the durable form of the pass's per-row residual. The pass computes the same
     * inventory in memory and logs a bounded sample of it, but the scheduler discards the rest
     * when the promise resolves, so the log could only ever answer "why" for the first N rows.
     * Persisting it here makes the repair list queryable and JOINable against the issue instead
     * of grep-able for a retention window:
     *
     *   select i.identifier, a.hand_back_residual_reason, a.hand_back_residual_detail
     *     from issue_recovery_actions a join issues i on i.id = a.source_issue_id
     *    where a.status in ('active','escalated') and a.hand_back_residual_reason is not null;
     */
    handBackResidualReason: text("hand_back_residual_reason"),
    handBackResidualDetail: text("hand_back_residual_detail"),
    /**
     * When the row first presented its CURRENT residual reason, not when it was last seen. The
     * drain rewrites these columns only when the reason or detail actually changes, so a stable
     * population costs no writes on a 30s scheduler tick — and the age of this timestamp reads
     * as "how long has it been stuck like this", which is the question an operator triaging the
     * inventory is actually asking.
     */
    handBackResidualAt: timestamp("hand_back_residual_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companySourceStatusIdx: index("issue_recovery_actions_company_source_status_idx").on(
      table.companyId,
      table.sourceIssueId,
      table.status,
    ),
    companyOwnerStatusIdx: index("issue_recovery_actions_company_owner_status_idx").on(
      table.companyId,
      table.ownerAgentId,
      table.status,
    ),
    companyRecoveryIssueIdx: index("issue_recovery_actions_company_recovery_issue_idx").on(
      table.companyId,
      table.recoveryIssueId,
    ),
    activeSourceIdx: uniqueIndex("issue_recovery_actions_active_source_uq")
      .on(table.companyId, table.sourceIssueId)
      .where(sql`${table.status} in ('active', 'escalated')`),
    activeFingerprintIdx: uniqueIndex("issue_recovery_actions_active_fingerprint_uq")
      .on(table.companyId, table.sourceIssueId, table.cause, table.fingerprint)
      .where(sql`${table.status} in ('active', 'escalated')`),
    // Partial: the residual inventory is a small minority of the table, and the operator query
    // above always filters on the reason being present.
    handBackResidualIdx: index("issue_recovery_actions_hand_back_residual_idx")
      .on(table.companyId, table.handBackResidualReason)
      .where(sql`${table.handBackResidualReason} is not null`),
  }),
);
