import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { executionWorkspaces } from "./execution_workspaces.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issues } from "./issues.js";

// BLO-21602: the issue-scoped run-ownership guard (issues.checkoutRunId /
// executionRunId) cannot see contention between two *different* issues that
// resolve to the same git branch/PR (parent + child issue sharing one
// execution workspace, or any operator_branch / reuse_existing pairing).
// This table is the branch-scoped equivalent: one active claim per
// (companyId, branchKey), enforced by a partial unique index rather than
// application-level compare-and-swap alone, mirroring
// external_runtime_reservations' active-slot/active-isolation-writer indexes.
export const branchRunClaims = pgTable(
  "branch_run_claims",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    branchKey: text("branch_key").notNull(),
    executionWorkspaceId: uuid("execution_workspace_id").references(() => executionWorkspaces.id, {
      onDelete: "set null",
    }),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    heartbeatRunId: uuid("heartbeat_run_id").notNull().references(() => heartbeatRuns.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    acquiredAt: timestamp("acquired_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastRenewedAt: timestamp("last_renewed_at", { withTimezone: true }).notNull().defaultNow(),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    releaseReason: text("release_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    activeBranchIdx: uniqueIndex("branch_run_claims_active_branch_idx")
      .on(table.companyId, table.branchKey)
      .where(sql`${table.releasedAt} is null`),
    activeRunIdx: index("branch_run_claims_active_run_idx")
      .on(table.heartbeatRunId)
      .where(sql`${table.releasedAt} is null`),
    activeExpiryIdx: index("branch_run_claims_active_expiry_idx")
      .on(table.expiresAt)
      .where(sql`${table.releasedAt} is null`),
  }),
);
