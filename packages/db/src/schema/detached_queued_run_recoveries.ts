import { sql } from "drizzle-orm";
import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issues } from "./issues.js";

/**
 * Durable lineage and recovery outbox for queued runs whose stale issue lock
 * was released. A row starts as `detached`, becomes `pending` atomically with
 * run cancellation, and is completed only after a replacement execution path
 * exists. The partial unique index serializes recovery per source issue.
 */
export const detachedQueuedRunRecoveries = pgTable(
  "detached_queued_run_recoveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    sourceRunId: uuid("source_run_id").notNull().references(() => heartbeatRuns.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("detached"),
    recoveryRunId: uuid("recovery_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    detachedAt: timestamp("detached_at", { withTimezone: true }).notNull().defaultNow(),
    pendingAt: timestamp("pending_at", { withTimezone: true }),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastError: text("last_error"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    sourceRunUq: uniqueIndex("detached_queued_run_recoveries_source_run_uq").on(table.sourceRunId),
    pendingIssueUq: uniqueIndex("detached_queued_run_recoveries_pending_issue_uq")
      .on(table.companyId, table.issueId)
      .where(sql`${table.status} = 'pending'`),
    statusDetachedAtIdx: index("detached_queued_run_recoveries_status_detached_at_idx").on(
      table.status,
      table.detachedAt,
      table.id,
    ),
    statusPendingAtIdx: index("detached_queued_run_recoveries_status_pending_at_idx").on(
      table.status,
      table.lastAttemptAt,
      table.pendingAt,
      table.id,
    ),
  }),
);
