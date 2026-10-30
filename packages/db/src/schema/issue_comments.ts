import type {
  IssueCommentAuthorType,
  IssueCommentDerivedAuthorSource,
  IssueCommentMetadata,
  IssueCommentPresentation,
  SourceTrustMetadata,
} from "@paperclipai/shared";
import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, index, jsonb, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { agents } from "./agents.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

export const issueComments = pgTable(
  "issue_comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    issueId: uuid("issue_id").notNull().references(() => issues.id),
    authorAgentId: uuid("author_agent_id").references(() => agents.id),
    authorUserId: text("author_user_id"),
    authorType: text("author_type").$type<IssueCommentAuthorType>(),
    createdByRunId: uuid("created_by_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    // Persisted result of best-effort agent-attribution derivation for comments
    // authored by a non-human sentinel (e.g. `local-board`). Populated once by a
    // backfill migration and lazily on read so the load path stops re-scanning
    // run logs.
    derivedAuthorAgentId: uuid("derived_author_agent_id").references(() => agents.id, { onDelete: "set null" }),
    derivedCreatedByRunId: uuid("derived_created_by_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    derivedAuthorSource: text("derived_author_source").$type<IssueCommentDerivedAuthorSource>(),
    idempotencyKey: text("idempotency_key"),
    // Primarily the comment-effects settlement marker: set once when a
    // comment's side effects have been processed, and read everywhere else
    // only as `IS NULL` / truthy (issue-comment-effects.ts, issues.ts,
    // routes/issues.ts).
    //
    // It carries a SECOND meaning for the terminal-gate reconciler's
    // held-open announcements (`terminal-gate-human-only-held:`): a still-held
    // re-check REWRITES this column to `now` without posting a comment, so the
    // 6h re-check window measures time since the last look rather than since
    // the first announcement. See `HELD_GATE_RECHECK_INTERVAL_MS` in
    // server/src/services/terminal-gate-reconciler.ts.
    //
    // Safe for the null-testing readers, since it never goes from set back to
    // null. But a sweep that ORDERS or AGES comments by this column would
    // silently pick up those re-stamps and read a stale held row as recent —
    // use `created_at` for "when was this posted".
    idempotencyProcessedAt: timestamp("idempotency_processed_at", { withTimezone: true }),
    body: text("body").notNull(),
    presentation: jsonb("presentation").$type<IssueCommentPresentation | null>(),
    metadata: jsonb("metadata").$type<IssueCommentMetadata | null>(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletedByType: text("deleted_by_type").$type<"agent" | "user">(),
    deletedByAgentId: uuid("deleted_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    deletedByUserId: text("deleted_by_user_id"),
    deletedByRunId: uuid("deleted_by_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    sourceTrust: jsonb("source_trust").$type<SourceTrustMetadata | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    issueIdx: index("issue_comments_issue_idx").on(table.issueId),
    companyIdx: index("issue_comments_company_idx").on(table.companyId),
    issueAgentIdempotencyIdx: uniqueIndex("issue_comments_issue_agent_idempotency_idx")
      .on(table.issueId, table.authorAgentId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} IS NOT NULL AND ${table.authorAgentId} IS NOT NULL AND ${table.deletedAt} IS NULL`),
    issueUserIdempotencyIdx: uniqueIndex("issue_comments_issue_user_idempotency_idx")
      .on(table.issueId, table.authorUserId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} IS NOT NULL AND ${table.authorUserId} IS NOT NULL AND ${table.deletedAt} IS NULL`),
    issueSystemIdempotencyIdx: uniqueIndex("issue_comments_issue_system_idempotency_idx")
      .on(table.issueId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} IS NOT NULL AND ${table.authorAgentId} IS NULL AND ${table.authorUserId} IS NULL AND ${table.deletedAt} IS NULL`),
    companyIssueCreatedAtIdx: index("issue_comments_company_issue_created_at_idx").on(
      table.companyId,
      table.issueId,
      table.createdAt,
    ),
    companyAuthorIssueCreatedAtIdx: index("issue_comments_company_author_issue_created_at_idx").on(
      table.companyId,
      table.authorUserId,
      table.issueId,
      table.createdAt,
    ),
    // PEN-3596: company-scoped, and it REPLACES the single-column
    // `issue_comments_body_search_idx` rather than joining it (migration
    // 0269). btree_gin lets company_id lead the GIN index, so the index cond
    // answers the company filter and the trigram match together instead of
    // BitmapAnd-ing a trigram bitmap built across every company. All five
    // body ILIKE/regex queries in the repo are company-scoped, so nothing is
    // left that wants the un-scoped form -- which is why the GIN-index count
    // on `body` stays at one and 0268's write-amplification objection to a
    // *second* one does not apply. Measured ~6x on the comment arm; see the
    // migration header for the full table.
    companyBodySearchIdx: index("issue_comments_company_body_search_idx")
      .using("gin", table.companyId, table.body.op("gin_trgm_ops")),
  }),
);
