import { pgTable, uuid, text, timestamp, integer, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

/**
 * Durable outbox for GitHub commit-status writes that must be ordered and
 * retried outside the heartbeat run lifecycle.
 */
export const githubCommitStatusDeliveries = pgTable(
  "github_commit_status_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    sourceRunId: uuid("source_run_id")
      .notNull()
      .references(() => heartbeatRuns.id, { onDelete: "cascade" }),
    repoFullName: text("repo_full_name").notNull(),
    sha: text("sha").notNull(),
    context: text("context").notNull(),
    state: text("state").notNull().default("failure"),
    description: text("description").notNull(),
    targetUrl: text("target_url"),
    prNumber: integer("pr_number").notNull(),
    prUrl: text("pr_url"),
    /** queued -> processing -> delivered | skipped | failed | failed_permanent */
    status: text("status").notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    lastError: text("last_error"),
    lastErrorKind: text("last_error_kind"),
    lastResult: jsonb("last_result").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  },
  (table) => ({
    repoShaContextUq: uniqueIndex("github_commit_status_deliveries_repo_sha_context_uq").on(
      table.repoFullName,
      table.sha,
      table.context,
    ),
    statusDueIdx: index("github_commit_status_deliveries_status_due_idx").on(
      table.status,
      table.nextAttemptAt,
      table.createdAt,
    ),
    sourceRunIdx: index("github_commit_status_deliveries_source_run_idx").on(table.sourceRunId),
  }),
);
