import { pgTable, uuid, text, integer, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { issues } from "./issues.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

/**
 * PEN-5876: revision history for the scalar text fields of an issue.
 *
 * The issue `description` had neither a compare-and-set nor an audit trail,
 * while `paperclipUpsertIssueDocument` had both. Two runs of one seat editing
 * the same `Done when` checklist therefore overwrote each other silently, and
 * — the sharper half — a lost update was *unobservable after the fact*: with
 * no history there was nothing to adjudicate whether a run's claimed edit had
 * been clobbered or had never been written at all.
 *
 * Deliberately a snapshot of the whole field SET rather than of `description`
 * alone. The gap sits in `updateIssueSchema`, one level above any individual
 * field, so `title` races identically; a description-only history would force
 * a second shape the moment anyone noticed.
 *
 * `createdByRunId` is the column the second measured instance turned on — a
 * write that landed and announced itself on no row at all. Attribution
 * survived only because the author happened to self-attribute in prose and
 * `executionRunId` happened not to have been released yet. Both were luck;
 * this column is the record. Mirrors `document_revisions`, which already
 * carries exactly this triple.
 */
export const issueFieldRevisions = pgTable(
  "issue_field_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    revisionNumber: integer("revision_number").notNull(),
    // Snapshot of the field set AFTER the write this revision records. The
    // baseline revision (number 1, written lazily on a row's first guarded
    // field write) snapshots the state BEFORE it, so the pre-existing text is
    // not lost the first time anyone edits an old row.
    title: text("title"),
    description: text("description"),
    changeSummary: text("change_summary"),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    createdByRunId: uuid("created_by_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    issueRevisionUq: uniqueIndex("issue_field_revisions_issue_revision_uq").on(
      table.issueId,
      table.revisionNumber,
    ),
    companyIssueCreatedIdx: index("issue_field_revisions_company_issue_created_idx").on(
      table.companyId,
      table.issueId,
      table.createdAt,
    ),
  }),
);
