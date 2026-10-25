import { sql } from "drizzle-orm";
import { index, integer, pgTable, text, timestamp, uuid, uniqueIndex } from "drizzle-orm/pg-core";
import { approvals } from "./approvals.js";
import { budgetPolicies } from "./budget_policies.js";
import { companies } from "./companies.js";

export const budgetIncidents = pgTable(
  "budget_incidents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    policyId: uuid("policy_id").notNull().references(() => budgetPolicies.id),
    scopeType: text("scope_type").notNull(),
    scopeId: uuid("scope_id").notNull(),
    metric: text("metric").notNull(),
    windowKind: text("window_kind").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    windowEnd: timestamp("window_end", { withTimezone: true }).notNull(),
    thresholdType: text("threshold_type").notNull(),
    amountLimit: integer("amount_limit").notNull(),
    amountObserved: integer("amount_observed").notNull(),
    status: text("status").notNull().default("open"),
    /**
     * Which board action closed this incident, or null (PEN-4742).
     *
     * `status` cannot answer this: `raise_budget_and_resume`,
     * `resume_without_raise` and every *system* closure all land as `resolved`.
     * `resume_without_raise` grants a window-scoped rebaseline of the hard stop,
     * so the decision has to be readable from the row afterwards --
     * `hardStopForgivenSince` reads exactly this column.
     *
     * Null means "not closed by a board decision": every row predating the
     * column, plus system closures (`upsertPolicy` clearing a policy's
     * incidents, `clearExpiredBudgetPause` at the window roll). Null never
     * confers a grant, so both directions fail closed.
     *
     * Values come from `BUDGET_INCIDENT_RESOLUTION_ACTIONS`.
     */
    resolutionAction: text("resolution_action"),
    approvalId: uuid("approval_id").references(() => approvals.id),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusIdx: index("budget_incidents_company_status_idx").on(table.companyId, table.status),
    companyScopeIdx: index("budget_incidents_company_scope_idx").on(
      table.companyId,
      table.scopeType,
      table.scopeId,
      table.status,
    ),
    // At most one *open* incident per (policy, window, threshold). This mirrors
    // the suppression check in `createIncidentIfNeeded` exactly, and the two must
    // move together: the code's SELECT decides whether to insert, and this index
    // is what rejects the insert if the code got it wrong.
    //
    // The predicate was `status <> 'dismissed'` until BLO-28908. That let a
    // `resolved` row hold the slot for the rest of the window, so once the board
    // raised a cap -- which resolves every open incident for the policy -- no
    // further card could be filed until the window rolled over. On the hard path
    // the pause is not similarly gated, so the next wall in the same window paused
    // the scope with no card at all. Closed incidents now free the slot; the
    // resolved/dismissed rows stay as the per-crossing audit trail.
    policyWindowIdx: uniqueIndex("budget_incidents_policy_window_threshold_idx").on(
      table.policyId,
      table.windowStart,
      table.thresholdType,
    ).where(sql`${table.status} = 'open'`),
  }),
);
