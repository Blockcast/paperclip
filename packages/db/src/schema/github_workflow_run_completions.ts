import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

/**
 * Durable first-seen ledger for completed GitHub Actions workflow_run events.
 *
 * The corresponding Prometheus signal is derived from this table at scrape
 * time. GitHub webhook deliveries are at-least-once and can land on different
 * API replicas, so this table provides both the shared unique key and the
 * restart-safe metric source.
 */
export const githubWorkflowRunCompletions = pgTable(
  "github_workflow_run_completions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workflowRunId: text("workflow_run_id").notNull(),
    runAttempt: integer("run_attempt").notNull().default(1),
    repoFullName: text("repo_full_name"),
    conclusion: text("conclusion").notNull(),
    firstDeliveryId: text("first_delivery_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    runAttemptUq: uniqueIndex("github_workflow_run_completions_run_attempt_uq").on(
      table.workflowRunId,
      table.runAttempt,
    ),
    repoCreatedAtIdx: index("github_workflow_run_completions_repo_created_at_idx").on(
      table.repoFullName,
      table.createdAt,
    ),
    createdAtIdx: index("github_workflow_run_completions_created_at_idx").on(table.createdAt),
  }),
);
