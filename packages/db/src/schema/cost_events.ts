import { sql } from "drizzle-orm";
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
    // PEN-5937: DERIVED run-level project attribution. Deliberately a SECOND column
    // rather than a backfill of `project_id`, and the two must not be merged.
    //
    // `project_id` is the run's WRITE-TIME scope, and `services/budgets.ts` enforces
    // every `scopeType: "project"` budget policy on it (`:198`, `:275`). Widening it to
    // "a project this run touched" would silently enlarge what counts against a project's
    // cap -- a financial gate moving because a reporting query wanted a cheaper join.
    // This column carries the attribution `costs.byProject` used to reconstruct at read
    // time from `activity_log`, and NOTHING reads it but that aggregate.
    //
    // Readers use `coalesce(project_id, attributed_project_id)`: write-time scope wins,
    // and the derived value only ever fills a gap. A row whose `project_id` is set is
    // never re-attributed.
    attributedProjectId: uuid("attributed_project_id"),
    // Resolution WATERMARK, and the reason `attributed_project_id` alone is not enough:
    // NULL there means both "never resolved" and "resolved, this run touched no project",
    // so the backfill could not tell what it had already visited and would re-derive every
    // unattributable row on every pass, forever. NULL here means "never resolved"; a
    // timestamp means "resolved", whatever the answer was.
    //
    // No DB-level FK on `attributed_project_id` on purpose: adding one to a populated
    // table takes a lock and a validation scan to protect a DERIVED, advisory value. A
    // deleted project leaves a dangling id, which `byProject`'s `innerJoin(projects)`
    // drops exactly as it drops a NULL -- the same outcome a FK's ON DELETE would give.
    attributedProjectAt: timestamp("attributed_project_at", { withTimezone: true }),
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
    // PEN-5937 (migration 0277): the keyset driver for
    // `repairCostEventProjectAttribution`, which runs on an interval rather than once per
    // lease acquisition and would otherwise walk the whole primary key heap-fetching a
    // column no index carries. PARTIAL on the repair's own predicate, so it holds only
    // rows still awaiting a watermark -- largest during the initial backfill, then
    // collapsing to the few rows deferred because their run is still in flight.
    //
    // Deliberately NOT company-scoped: the repair is a fleet-wide drain with no company
    // in its predicate, and adding one would make the index unusable for the only query
    // that reads it.
    unattributedIdx: index("cost_events_unattributed_idx")
      .on(table.id)
      .where(sql`${table.attributedProjectAt} is null`),
  }),
);
