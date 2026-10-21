import { pgTable, uuid, text, timestamp, integer, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { issues } from "./issues.js";
import { projects } from "./projects.js";
import { goals } from "./goals.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

export const costEvents = pgTable(
  "cost_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    issueId: uuid("issue_id").references(() => issues.id),
    projectId: uuid("project_id").references(() => projects.id),
    goalId: uuid("goal_id").references(() => goals.id),
    heartbeatRunId: uuid("heartbeat_run_id").references(() => heartbeatRuns.id),
    billingCode: text("billing_code"),
    provider: text("provider").notNull(),
    biller: text("biller").notNull().default("unknown"),
    billingType: text("billing_type").notNull().default("unknown"),
    costStatus: text("cost_status").notNull().default("reported"),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    cachedInputTokens: integer("cached_input_tokens").notNull().default(0),
    // BLO-29842: cache WRITE (Anthropic `cache_creation_input_tokens`), billed at
    // 1.25x/2x input vs 0.1x for cachedInputTokens (cache read). Previously folded
    // into inputTokens, which made the 3-price rate card unidentifiable from 2
    // columns. Rows written before this column shipped carry 0 and cannot be
    // backfilled — the information was never captured. Any rate-card fit must start
    // AFTER its migration deployed, or it reads the zero-default as real cache-write
    // volume. (Deliberately no migration number here: a rebase renumbers it and the
    // stale number then names a real but unrelated migration.)
    // ponytail: one column, not one per TTL. Claude's `modelUsage` ledger reports
    // cacheCreationInputTokens as a single aggregate and does not split
    // ephemeral_5m/_1h, so a second column would have nothing to read. Cost of the
    // choice: the fit recovers a blended write price over the fleet's TTL mix, not
    // the 1.25x and 2x legs separately. Split when an adapter reports the breakdown.
    cacheCreationInputTokens: integer("cache_creation_input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    costCents: integer("cost_cents").notNull(),
    // PEN-4466: list-price CONSUMPTION, the quantity every hard gate enforces on.
    // `cost_cents` is written through normalizeBilledCostCents() (services/heartbeat.ts),
    // which returns 0 for billingType "subscription_included" -- so the day an adapter
    // classifies subscription lanes correctly, every cap that sums cost_cents reads 0
    // forever. This column is computed from the same costUsd with NO billingType branch,
    // which is what makes correcting classification safe.
    //
    // NULLABLE on purpose: NULL means "this row predates the column", 0 means "this run
    // genuinely cost nothing". A NOT NULL DEFAULT 0 cannot tell those apart, which would
    // force readers into nullif(consumption_cents, 0) and silently re-read cost_cents for
    // every free row forever. Readers use coalesce(consumption_cents, cost_cents) --
    // see computeObservedAmount (services/budgets.ts) for the ordering constraint.
    consumptionCents: integer("consumption_cents"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyOccurredIdx: index("cost_events_company_occurred_idx").on(table.companyId, table.occurredAt),
    companyAgentOccurredIdx: index("cost_events_company_agent_occurred_idx").on(
      table.companyId,
      table.agentId,
      table.occurredAt,
    ),
    companyProviderOccurredIdx: index("cost_events_company_provider_occurred_idx").on(
      table.companyId,
      table.provider,
      table.occurredAt,
    ),
    companyBillerOccurredIdx: index("cost_events_company_biller_occurred_idx").on(
      table.companyId,
      table.biller,
      table.occurredAt,
    ),
    companyHeartbeatRunIdx: index("cost_events_company_heartbeat_run_idx").on(
      table.companyId,
      table.heartbeatRunId,
    ),
    // BLO-47753: per-issue cost rollups. Without it the generic plan filters
    // issue_id through the heartbeat-run index (~2 s/call at 431k rows).
    companyIssueIdx: index("cost_events_company_issue_idx").on(table.companyId, table.issueId),
  }),
);
