import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { SourceTrustMetadata } from "@paperclipai/shared";
import { companies } from "./companies.js";
import { executionWorkspaces } from "./execution_workspaces.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issues } from "./issues.js";
import { projects } from "./projects.js";
import { workspaceRuntimeServices } from "./workspace_runtime_services.js";

export const issueWorkProducts = pgTable(
  "issue_work_products",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    executionWorkspaceId: uuid("execution_workspace_id")
      .references(() => executionWorkspaces.id, { onDelete: "set null" }),
    runtimeServiceId: uuid("runtime_service_id")
      .references(() => workspaceRuntimeServices.id, { onDelete: "set null" }),
    type: text("type").notNull(),
    provider: text("provider").notNull(),
    externalId: text("external_id"),
    title: text("title").notNull(),
    url: text("url"),
    status: text("status").notNull(),
    reviewState: text("review_state").notNull().default("none"),
    isPrimary: boolean("is_primary").notNull().default(false),
    healthStatus: text("health_status").notNull().default("unknown"),
    summary: text("summary"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    sourceTrust: jsonb("source_trust").$type<SourceTrustMetadata | null>(),
    createdByRunId: uuid("created_by_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIssueTypeIdx: index("issue_work_products_company_issue_type_idx").on(
      table.companyId,
      table.issueId,
      table.type,
    ),
    companyExecutionWorkspaceTypeIdx: index("issue_work_products_company_execution_workspace_type_idx").on(
      table.companyId,
      table.executionWorkspaceId,
      table.type,
    ),
    companyProviderExternalIdIdx: index("issue_work_products_company_provider_external_id_idx").on(
      table.companyId,
      table.provider,
      table.externalId,
    ),
    // PEN-6056 (migration 0279). Backs the case-insensitive arm of
    // `listOwnersByExternalId`: GitHub treats both segments of `owner/repo`
    // case-insensitively, so the reverse lookup folds the key, and the index above
    // cannot serve a folded comparison -- `lower(external_id)` is not the indexed
    // value. Without this the lookup degrades to an (company_id, provider) range
    // scan plus a heap filter over every artifact the company has ever recorded.
    //
    // NOT partial on `provider = 'github' and type = 'pull_request'`, even though
    // that is exactly when the folded arm runs. The query binds provider and type
    // as PARAMETERS, and Postgres can only prove a partial index applicable against
    // constants -- a partial index here would be built, look correct, and never be
    // chosen. Both columns are therefore ordinary leading keys instead.
    companyProviderTypeFoldedExternalIdIdx: index(
      "issue_work_products_company_folded_external_id_idx",
    ).on(
      table.companyId,
      table.provider,
      table.type,
      sql`lower(${table.externalId})`,
    ),
    companyUpdatedIdx: index("issue_work_products_company_updated_idx").on(
      table.companyId,
      table.updatedAt,
    ),
    // Conflict target for the webhook upsert (BLO-19566). Partial on
    // external_id so hand-created rows, which leave it null, stay unconstrained.
    issueProviderTypeExternalIdUniq: uniqueIndex(
      "issue_work_products_issue_provider_type_external_id_uniq",
    )
      .on(table.companyId, table.issueId, table.provider, table.type, table.externalId)
      .where(sql`${table.externalId} IS NOT NULL`),
  }),
);
