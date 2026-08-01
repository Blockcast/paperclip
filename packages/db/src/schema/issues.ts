import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  pgTable,
  uuid,
  text,
  timestamp,
  date,
  integer,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { projects } from "./projects.js";
import { goals } from "./goals.js";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { projectWorkspaces } from "./project_workspaces.js";
import { executionWorkspaces } from "./execution_workspaces.js";
import { milestones } from "./milestones.js";
import type { SourceTrustMetadata } from "@paperclipai/shared";

export const issues = pgTable(
  "issues",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    projectId: uuid("project_id").references(() => projects.id),
    projectWorkspaceId: uuid("project_workspace_id").references(() => projectWorkspaces.id, { onDelete: "set null" }),
    goalId: uuid("goal_id").references(() => goals.id),
    parentId: uuid("parent_id").references((): AnyPgColumn => issues.id),
    milestoneId: uuid("milestone_id").references(() => milestones.id, { onDelete: "set null" }),
    targetDate: date("target_date"),
    title: text("title").notNull(),
    description: text("description"),
    status: text("status").notNull().default("backlog"),
    workMode: text("work_mode").notNull().default("standard"),
    harnessKind: text("harness_kind"),
    priority: text("priority").notNull().default("medium"),
    estimate: integer("estimate"),
    assigneeAgentId: uuid("assignee_agent_id").references(() => agents.id),
    assigneeUserId: text("assignee_user_id"),
    checkoutRunId: uuid("checkout_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    executionRunId: uuid("execution_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    executionAgentNameKey: text("execution_agent_name_key"),
    executionLockedAt: timestamp("execution_locked_at", { withTimezone: true }),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id),
    createdByUserId: text("created_by_user_id"),
    responsibleUserId: text("responsible_user_id"),
    issueNumber: integer("issue_number"),
    identifier: text("identifier"),
    // Stash of the identifier as it existed before a Phase-3 BLO→PCL
    // re-prefix. Null on greenfield rows. Provides a one-line UPDATE to
    // roll the rename back without re-deriving from row order if Phase 3
    // misfires. See plan: linear-id-unification.md.
    legacyIdentifier: text("legacy_identifier"),
    originKind: text("origin_kind").notNull().default("manual"),
    originId: text("origin_id"),
    originRunId: text("origin_run_id"),
    originFingerprint: text("origin_fingerprint").notNull().default("default"),
    requestDepth: integer("request_depth").notNull().default(0),
    billingCode: text("billing_code"),
    assigneeAdapterOverrides: jsonb("assignee_adapter_overrides").$type<Record<string, unknown>>(),
    executionPolicy: jsonb("execution_policy").$type<Record<string, unknown>>(),
    executionState: jsonb("execution_state").$type<Record<string, unknown>>(),
    monitorNextCheckAt: timestamp("monitor_next_check_at", { withTimezone: true }),
    monitorWakeRequestedAt: timestamp("monitor_wake_requested_at", { withTimezone: true }),
    monitorLastTriggeredAt: timestamp("monitor_last_triggered_at", { withTimezone: true }),
    monitorAttemptCount: integer("monitor_attempt_count").notNull().default(0),
    monitorNotes: text("monitor_notes"),
    monitorScheduledBy: text("monitor_scheduled_by"),
    executionWorkspaceId: uuid("execution_workspace_id")
      .references((): AnyPgColumn => executionWorkspaces.id, { onDelete: "set null" }),
    executionWorkspacePreference: text("execution_workspace_preference"),
    executionWorkspaceSettings: jsonb("execution_workspace_settings").$type<Record<string, unknown>>(),
    sourceTrust: jsonb("source_trust").$type<SourceTrustMetadata | null>(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    hiddenAt: timestamp("hidden_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    // Materialized "last activity on this issue" timestamp. Maintained by DB
    // triggers (see migration 0072_issues_last_activity_at.sql): mirrors
    // updated_at on UPDATE, and bumps to comment.created_at on
    // issue_comments insert. Used by inboxVisibleForUserCondition to make the
    // archive predicate sargable.
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).notNull().defaultNow(),
    // Last verdict from the artifact-evidence gate (BLO-4461). Written by
    // services/issues.ts on transitions to in_review. Phase 1 is warn-only:
    // verdict is recorded but never blocks the PATCH. Phase 2 (BLO-4828)
    // flips block verdicts to 422 unprocessable. Null until the issue
    // transitions to in_review under the gate.
    lastEvidenceVerdict: jsonb("last_evidence_verdict").$type<{
      verdict: "pass" | "warn" | "block";
      missing: string[];
      evidenceFound: string[];
      unlabeledFallback: boolean;
      overridden?: boolean;
      overrideReason?: string;
      evaluatedAt: string;
    }>(),
    // Materialized from lastEvidenceVerdict.evaluatedAt when the evidence gate
    // writes a verdict. Keeps dashboard scorecard review-window queries on a
    // normal timestamp column instead of scanning JSONB across the company.
    lastEvidenceVerdictEvaluatedAt: timestamp("last_evidence_verdict_evaluated_at", { withTimezone: true }),
  },
  (table) => ({
    companyStatusIdx: index("issues_company_status_idx").on(table.companyId, table.status),
    companyLastActivityIdx: index("issues_company_last_activity_idx").on(
      table.companyId,
      table.lastActivityAt,
    ),
    companyHarnessKindIdx: index("issues_company_harness_kind_idx").on(table.companyId, table.harnessKind),
    assigneeStatusIdx: index("issues_company_assignee_status_idx").on(
      table.companyId,
      table.assigneeAgentId,
      table.status,
    ),
    assigneeUserStatusIdx: index("issues_company_assignee_user_status_idx").on(
      table.companyId,
      table.assigneeUserId,
      table.status,
    ),
    responsibleUserIdx: index("issues_company_responsible_user_idx").on(table.companyId, table.responsibleUserId),
    parentIdx: index("issues_company_parent_idx").on(table.companyId, table.parentId),
    projectIdx: index("issues_company_project_idx").on(table.companyId, table.projectId),
    milestoneIdx: index("issues_company_milestone_idx").on(table.companyId, table.milestoneId).where(sql`milestone_id IS NOT NULL`),
    originIdx: index("issues_company_origin_idx").on(table.companyId, table.originKind, table.originId),
    projectWorkspaceIdx: index("issues_company_project_workspace_idx").on(table.companyId, table.projectWorkspaceId),
    executionWorkspaceIdx: index("issues_company_execution_workspace_idx").on(table.companyId, table.executionWorkspaceId),
    dueMonitorIdx: index("issues_company_monitor_due_idx").on(table.companyId, table.monitorNextCheckAt),
    // Partial on `last_evidence_verdict IS NOT NULL` (BLO-10777 follow-up): the
    // only consumer (dashboard scorecard query) always carries that filter, so a
    // partial index is an exact predicate match — smaller, and unambiguously the
    // planner's choice over any other `(company_id, …)` index. Hardens
    // dashboard-service.test.ts's EXPLAIN guard against future sibling indexes.
    evidenceVerdictEvaluatedIdx: index("issues_company_evidence_verdict_evaluated_idx")
      .on(table.companyId, table.lastEvidenceVerdictEvaluatedAt)
      .where(sql`${table.lastEvidenceVerdict} is not null`),
    companyUpdatedIdx: index("issues_company_updated_idx").on(table.companyId, table.updatedAt),
    companyCreatedIdx: index("issues_company_created_idx").on(table.companyId, table.createdAt),
    openNormalizedTitleCreatedIdx: index("issues_open_normalized_title_created_idx")
      .on(
        table.companyId,
        table.parentId,
        sql`lower(regexp_replace(btrim(${table.title}), '\\s+', ' ', 'g'))`,
        table.createdAt,
      )
      .where(sql`${table.hiddenAt} is null and ${table.status} not in ('done', 'cancelled')`),
    companyPriorityIdx: index("issues_company_priority_idx").on(table.companyId, table.priority),
    identifierIdx: uniqueIndex("issues_identifier_idx").on(table.identifier),
    titleSearchIdx: index("issues_title_search_idx").using("gin", table.title.op("gin_trgm_ops")),
    identifierSearchIdx: index("issues_identifier_search_idx").using("gin", table.identifier.op("gin_trgm_ops")),
    descriptionSearchIdx: index("issues_description_search_idx").using("gin", table.description.op("gin_trgm_ops")),
    openRoutineExecutionIdx: uniqueIndex("issues_open_routine_execution_uq")
      .on(table.companyId, table.originKind, table.originId, table.originFingerprint)
      .where(
        sql`${table.originKind} = 'routine_execution'
          and ${table.originId} is not null
          and ${table.hiddenAt} is null
          and ${table.executionRunId} is not null
          and ${table.status} in ('backlog', 'todo', 'in_progress', 'in_review', 'blocked')`,
      ),
    activeLivenessRecoveryIncidentIdx: uniqueIndex("issues_active_liveness_recovery_incident_uq")
      .on(table.companyId, table.originKind, table.originId)
      .where(
        sql`${table.originKind} = 'harness_liveness_escalation'
          and ${table.originId} is not null
          and ${table.hiddenAt} is null
          and ${table.status} not in ('done', 'cancelled')`,
      ),
    activeLivenessRecoveryLeafIdx: uniqueIndex("issues_active_liveness_recovery_leaf_uq")
      .on(table.companyId, table.originKind, table.originFingerprint)
      .where(
        sql`${table.originKind} = 'harness_liveness_escalation'
          and ${table.originFingerprint} <> 'default'
          and ${table.hiddenAt} is null
          and ${table.status} not in ('done', 'cancelled')`,
      ),
    activeStaleRunEvaluationIdx: uniqueIndex("issues_active_stale_run_evaluation_uq")
      .on(table.companyId, table.originKind, table.originId)
      .where(
        sql`${table.originKind} = 'stale_active_run_evaluation'
          and ${table.originId} is not null
          and ${table.hiddenAt} is null
          and ${table.status} not in ('done', 'cancelled')`,
      ),
    activeCcrotateCapacityExhaustionIdx: uniqueIndex("issues_active_ccrotate_capacity_exhaustion_uq")
      .on(table.companyId, table.originKind, table.originId)
      .where(
        sql`${table.originKind} = 'ccrotate_capacity_exhausted'
          and ${table.originId} is not null
          and ${table.hiddenAt} is null
          and ${table.status} not in ('done', 'cancelled')`,
      ),
    activeTaskWatchdogIdx: uniqueIndex("issues_active_task_watchdog_uq")
      .on(table.companyId, table.originKind, table.originId)
      .where(
        sql`${table.originKind} = 'task_watchdog'
          and ${table.originId} is not null
          and ${table.hiddenAt} is null
          and ${table.status} not in ('done', 'cancelled')`,
      ),
    activeProductivityReviewIdx: uniqueIndex("issues_active_productivity_review_uq")
      .on(table.companyId, table.originKind, table.originId)
      .where(
        sql`${table.originKind} = 'issue_productivity_review'
          and ${table.originId} is not null
          and ${table.hiddenAt} is null
          and ${table.status} not in ('done', 'cancelled')`,
      ),
    activeStrandedIssueRecoveryIdx: uniqueIndex("issues_active_stranded_issue_recovery_uq")
      .on(table.companyId, table.originKind, table.originId)
      .where(
        sql`${table.originKind} = 'stranded_issue_recovery'
          and ${table.originId} is not null
          and ${table.hiddenAt} is null
          and ${table.status} not in ('done', 'cancelled')`,
       ),
    alertmanagerAggregateIdx: uniqueIndex("issues_alertmanager_aggregate_uq")
      .on(table.companyId, table.originKind, table.originId)
      .where(
        sql`${table.originKind} = 'plugin:paperclip-plugin-alertmanager'
          and ${table.originId} is not null
          and ${table.hiddenAt} is null`,
      ),
    // BLO-15982: cross-issue dedup for alertmanager board covers. originId
    // stays the specific triggering alert issue's id (so resolve-time cover
    // cleanup can look covers up by originId=<source alert issue id>);
    // originFingerprint carries the alertname+dedup-window key so concurrent
    // same-alertname ladders racing to the cover rung hit this constraint
    // instead of a read-then-create gap — the loser catches 23505 and
    // attaches itself to the winner's cover instead of duplicating it.
    activeAlertEscalationCoverIdx: uniqueIndex("issues_active_alert_escalation_cover_uq")
      .on(table.companyId, table.originKind, table.originFingerprint)
      .where(
        sql`${table.originKind} = 'plugin:paperclip-plugin-alertmanager:escalation'
          and ${table.originFingerprint} <> 'default'
          and ${table.hiddenAt} is null
          and ${table.status} not in ('done', 'cancelled')`,
      ),
    // BLO-16319: one open issue per Dependabot alert. originId is the stable
    // `github-dependabot:<repoFullName>#<alertNumber>` key (the same key the
    // webhook route already uses for the wake idempotency key), so a
    // `reintroduced`/`reopened` redelivery for an alert with an already-open
    // issue reuses it instead of spawning a duplicate remediation run.
    activeDependabotAlertIdx: uniqueIndex("issues_active_dependabot_alert_uq")
      .on(table.companyId, table.originKind, table.originId)
      .where(
        sql`${table.originKind} = 'github_dependabot_alert'
          and ${table.originId} is not null
          and ${table.hiddenAt} is null
          and ${table.status} not in ('done', 'cancelled')`,
      ),
  }),
);
