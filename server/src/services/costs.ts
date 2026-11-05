import { and, desc, eq, gte, inArray, isNotNull, isNull, lt, lte, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "@paperclipai/db";
import { activityLog, agents, companies, costEvents, heartbeatRuns, issues, projects } from "@paperclipai/db";
import { notFound, unprocessable } from "../errors.js";
import { budgetService, type BudgetServiceHooks } from "./budgets.js";
import { visibleIssueCondition } from "./issue-visibility.js";
import { consumptionCentsExpr, consumptionCentsSum } from "./consumption-metric.js";

export interface CostDateRange {
  from?: Date;
  to?: Date;
}

/**
 * PEN-4902: narrow an agent-keyed cost aggregate to one seat.
 *
 * `GET /costs/by-agent?agentId=…` used to accept the parameter and ignore it,
 * answering 200 with every seat in the company. The failure is not that the
 * caller gets too much — it is that the natural read of a one-seat request,
 * `rows[0]`, silently returns whichever seat sorts first by spend. A wrong
 * seat's number is indistinguishable from the right one at the call site.
 */
export interface CostAgentFilter {
  agentId?: string;
}

const METERED_BILLING_TYPE = "metered_api";
const SUBSCRIPTION_BILLING_TYPES = ["subscription_included", "subscription_overage"] as const;

/**
 * PEN-4902: the UNBRANCHED run count, and the gap it leaves visible.
 *
 * `apiRunCount` and `subscriptionRunCount` partition only the CLASSIFIED rows. `unknown`
 * is in neither set, and `unknown` is the normal value, not an edge case: it is the
 * default in `createEvent` and in `createCostEventSchema`, and it is what
 * `resolveLedgerBillingType` deliberately resolves every Penstock-brokered lane to
 * (`services/billing-classification.ts`). So on a fleet whose lanes are all brokered,
 * BOTH counters read 0 for every row while runs are happening.
 *
 * Zero there means "nothing is classified", never "no runs" — it fails in the direction
 * of ABSENCE, which is the reading a caller is least likely to question. A per-run
 * quantity built on `apiRunCount` divides by zero, and the result looks like an answer.
 * Nor can the true count be recovered from what used to be served: there was no total,
 * so `apiRunCount + subscriptionRunCount` is a lower bound and nothing published said so.
 *
 * ⇒ Use `costEventRunCount` where you would have reached for the classified pair, and the
 * classified pair only to ask what fraction of a window is classified.
 *
 * ⚠️ `costEventRunCount` is NOT the run count and is deliberately not named `runCount`:
 * `IssueCostSummary.runCount` already carries that name for runs counted `FROM
 * heartbeat_runs` with no `cost_events` join, and this one is a strict SUBSET of those —
 * `heartbeat.ts` writes a cost event only `if (additionalCostCents > 0 ||
 * consumptionCents > 0 || hasTokenUsage)`, so a run that reported neither spend nor token
 * usage is absent here and present there. Raised by @Ceo on #3341: a remedy that moves an
 * error from ABSENT to quietly WRONG, under the name the correct answer would carry, is
 * worse than the absence. There is no served window-scoped run count to get the true
 * denominator from: `GET /companies/:id/heartbeat-runs` reads only `agentId`, `limit` and
 * `summary` (`routes/agents.ts`), and `heartbeat.list` takes no time bounds, so a
 * `from`/`to` passed there is dropped in silence and the response is the company's whole
 * run list capped at `limit`. Until such a route exists the count has to come from the
 * table: `count(*) from heartbeat_runs where company_id = … and created_at` in the
 * window — noting that clock is the run's queue-entry time, while these aggregates
 * window on `cost_events.occurred_at`.
 *
 * `runlessEventCount` is served beside it because `costEventRunCount` fails the OTHER way:
 * `cost_events.heartbeat_run_id` is nullable (`packages/db/src/schema/cost_events.ts`)
 * and `count(distinct …)` skips NULL, so a row reported through `POST /cost-events`
 * with no run id lands in the numerator of cost-per-run and not in its denominator. A
 * non-zero `runlessEventCount` means cost-per-run reads HIGH by whatever those rows
 * carry; it is served rather than inferred so the bias is visible without a second query.
 */
const costEventRunCountExpr = sql<number>`count(distinct ${costEvents.heartbeatRunId})::int`;
const runlessEventCountExpr = sql<number>`count(*) filter (where ${costEvents.heartbeatRunId} is null)::int`;

function sumAsNumber(
  column:
    | typeof costEvents.costCents
    | typeof costEvents.inputTokens
    | typeof costEvents.cachedInputTokens
    | typeof costEvents.cacheCreationInputTokens
    | typeof costEvents.outputTokens,
) {
  return sql<number>`coalesce(sum(${column}), 0)::double precision`;
}

function currentUtcMonthWindow(now = new Date()) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  return {
    start: new Date(Date.UTC(year, month, 1, 0, 0, 0, 0)),
    end: new Date(Date.UTC(year, month + 1, 1, 0, 0, 0, 0)),
  };
}

/**
 * PEN-4466: writes the STORED `agents`/`companies.spent_monthly_cents`.
 *
 * The stored value is not what the API serves: `hydrateAgentSpend` (`services/agents.ts`)
 * and `hydrateCompanySpend` (`services/companies.ts`) overwrite it with a live re-sum on
 * every read. All three must stay on `consumptionCentsExpr` together, or
 * `spentMonthlyCents` FLATLINES FORWARD on the day classification lands -- which reads as
 * "the fleet stopped" rather than "the meter broke", and is the harder of the two to
 * notice. See `services/consumption-metric.ts`.
 */
async function getMonthlySpendTotal(
  db: Db,
  scope: { companyId: string; agentId?: string | null },
) {
  const { start, end } = currentUtcMonthWindow();
  const conditions = [
    eq(costEvents.companyId, scope.companyId),
    gte(costEvents.occurredAt, start),
    lt(costEvents.occurredAt, end),
  ];
  if (scope.agentId) {
    conditions.push(eq(costEvents.agentId, scope.agentId));
  }
  const [row] = await db
    .select({
      total: sql<number>`coalesce(sum(${consumptionCentsExpr}), 0)::double precision`,
    })
    .from(costEvents)
    .where(and(...conditions));
  return Number(row?.total ?? 0);
}

export function costService(db: Db, budgetHooks: BudgetServiceHooks = {}) {
  const budgets = budgetService(db, budgetHooks);
  return {
    createEvent: async (companyId: string, data: Omit<typeof costEvents.$inferInsert, "companyId">) => {
      const agent = await db
        .select()
        .from(agents)
        .where(eq(agents.id, data.agentId))
        .then((rows) => rows[0] ?? null);

      if (!agent) throw notFound("Agent not found");
      if (agent.companyId !== companyId) {
        throw unprocessable("Agent does not belong to company");
      }

      const event = await db
        .insert(costEvents)
        .values({
          ...data,
          companyId,
          biller: data.biller ?? data.provider,
          billingType: data.billingType ?? "unknown",
          cachedInputTokens: data.cachedInputTokens ?? 0,
          // BLO-29842: cache WRITE. Adapters that report no cache-creation field
          // omit it and land on 0, which is the same value pre-migration rows carry.
          cacheCreationInputTokens: data.cacheCreationInputTokens ?? 0,
          // PEN-4466: callers that do not report consumption separately fall back to
          // costCents, which is the right value for every metered_api lane. The heartbeat
          // ledger writer passes this explicitly, computed with no billingType branch, so
          // subscription lanes do NOT inherit the zero that normalizeBilledCostCents
          // returns. Deliberately `??` and not `|| `: a genuinely-zero consumption must
          // stay 0 rather than silently re-deriving from costCents.
          consumptionCents: data.consumptionCents ?? data.costCents,
        })
        .returning()
        .then((rows) => rows[0]);

      const [agentMonthSpend, companyMonthSpend] = await Promise.all([
        getMonthlySpendTotal(db, { companyId, agentId: event.agentId }),
        getMonthlySpendTotal(db, { companyId }),
      ]);

      await db
        .update(agents)
        .set({
          spentMonthlyCents: agentMonthSpend,
          updatedAt: new Date(),
        })
        .where(eq(agents.id, event.agentId));

      await db
        .update(companies)
        .set({
          spentMonthlyCents: companyMonthSpend,
          updatedAt: new Date(),
        })
        .where(eq(companies.id, companyId));

      await budgets.evaluateCostEvent(event);

      return event;
    },

    summary: async (companyId: string, range?: CostDateRange) => {
      const company = await db
        .select()
        .from(companies)
        .where(eq(companies.id, companyId))
        .then((rows) => rows[0] ?? null);

      if (!company) throw notFound("Company not found");

      const conditions: ReturnType<typeof eq>[] = [eq(costEvents.companyId, companyId)];
      if (range?.from) conditions.push(gte(costEvents.occurredAt, range.from));
      if (range?.to) conditions.push(lte(costEvents.occurredAt, range.to));

      const [{ total, consumptionTotal }] = await db
        .select({
          total: sumAsNumber(costEvents.costCents),
          consumptionTotal: consumptionCentsSum,
        })
        .from(costEvents)
        .where(and(...conditions));

      const spendCents = Number(total);
      // PEN-4515: CASH and CONSUMPTION side by side, each named for what it is.
      // `spendCents` keeps summing `cost_cents` -- the cash column, which
      // normalizeBilledCostCents zeroes for subscription_included. `consumptionCents` is
      // list price with no billingType branch, and is what every hard gate enforces on
      // (services/consumption-metric.ts). They are equal for every row written to date;
      // they diverge the moment any lane is classified as a subscription, and this is what
      // stops that divergence from being silent.
      const consumptionCents = Number(consumptionTotal);
      const utilization =
        company.budgetMonthlyCents > 0
          ? (spendCents / company.budgetMonthlyCents) * 100
          : 0;
      const consumptionUtilization =
        company.budgetMonthlyCents > 0
          ? (consumptionCents / company.budgetMonthlyCents) * 100
          : 0;

      return {
        companyId,
        spendCents,
        consumptionCents,
        budgetCents: company.budgetMonthlyCents,
        utilizationPercent: Number(utilization.toFixed(2)),
        consumptionUtilizationPercent: Number(consumptionUtilization.toFixed(2)),
      };
    },

    issueTreeSummary: async (
      companyId: string,
      issueId: string,
      options: { excludeRoot?: boolean } = {},
    ) => {
      // Callers must resolve and authorize a visible root issue before invoking this.
      // The route does that so zero counts are not mistaken for a missing root.
      const childIssues = alias(issues, "child");

      // The seed of the recursive CTE: when excludeRoot is true, start from
      // the direct children so the root issue itself is not counted.
      const cteSeed = options.excludeRoot
        ? sql`
            SELECT ${issues.id}
            FROM ${issues}
            WHERE ${issues.companyId} = ${companyId}
              AND ${issues.parentId} = ${issueId}
              AND ${issues.hiddenAt} IS NULL
              AND ${issues.harnessKind} IS NULL
          `
        : sql`
            SELECT ${issues.id}
            FROM ${issues}
            WHERE ${issues.companyId} = ${companyId}
              AND ${issues.id} = ${issueId}
              AND ${issues.hiddenAt} IS NULL
              AND ${issues.harnessKind} IS NULL
          `;

      const cteSeedText = options.excludeRoot
        ? sql`
            SELECT (${issues.id})::text AS id
            FROM ${issues}
            WHERE ${issues.companyId} = ${companyId}
              AND ${issues.parentId} = ${issueId}
              AND ${issues.hiddenAt} IS NULL
              AND ${issues.harnessKind} IS NULL
          `
        : sql`
            SELECT (${issues.id})::text AS id
            FROM ${issues}
            WHERE ${issues.companyId} = ${companyId}
              AND ${issues.id} = ${issueId}
              AND ${issues.hiddenAt} IS NULL
              AND ${issues.harnessKind} IS NULL
          `;

      const issueTreeCondition = sql<boolean>`
        ${issues.id} IN (
          WITH RECURSIVE issue_tree(id) AS (
            ${cteSeed}
            UNION ALL
            SELECT ${childIssues.id}
            FROM ${issues} ${childIssues}
            JOIN issue_tree ON ${childIssues.parentId} = issue_tree.id
            WHERE ${childIssues.companyId} = ${companyId}
              AND ${childIssues.hiddenAt} IS NULL
              AND ${childIssues.harnessKind} IS NULL
          )
          SELECT id FROM issue_tree
        )
      `;

      const runSummarySql = sql`
        WITH RECURSIVE issue_tree(id) AS (
          ${cteSeedText}
          UNION ALL
          SELECT (${childIssues.id})::text
          FROM ${issues} ${childIssues}
          JOIN issue_tree ON (${childIssues.parentId})::text = issue_tree.id
          WHERE ${childIssues.companyId} = ${companyId}
            AND ${childIssues.hiddenAt} IS NULL
            AND ${childIssues.harnessKind} IS NULL
        )
        SELECT
          count(distinct ${heartbeatRuns.id})::int AS "runCount",
          coalesce(sum(extract(epoch from (coalesce(${heartbeatRuns.finishedAt}, now()) - ${heartbeatRuns.startedAt})) * 1000), 0)::double precision AS "runtimeMs"
        FROM ${heartbeatRuns}
        WHERE ${heartbeatRuns.companyId} = ${companyId}
          AND ${heartbeatRuns.startedAt} IS NOT NULL
          AND (
            ${heartbeatRuns.contextSnapshot} ->> 'issueId' IN (SELECT id FROM issue_tree)
            OR EXISTS (
              SELECT 1
              FROM ${activityLog}
              JOIN issue_tree ON ${activityLog.entityId} = issue_tree.id
              WHERE ${activityLog.companyId} = ${companyId}
                AND ${activityLog.entityType} = 'issue'
                AND ${activityLog.runId} = ${heartbeatRuns.id}
            )
          )
      `;

      // Run cost-event aggregation and run-duration aggregation in parallel.
      // They're separate queries because cost_events fan out per-event and
      // joining heartbeat_runs through them would double-count run durations.
      const [costRowResult, runRowResult] = await Promise.all([
        db
          .select({
            issueCount: sql<number>`count(distinct ${issues.id})::int`,
            costCents: sumAsNumber(costEvents.costCents),
            consumptionCents: consumptionCentsSum,
            inputTokens: sumAsNumber(costEvents.inputTokens),
            cachedInputTokens: sumAsNumber(costEvents.cachedInputTokens),
            cacheCreationInputTokens: sumAsNumber(costEvents.cacheCreationInputTokens),
            outputTokens: sumAsNumber(costEvents.outputTokens),
          })
          .from(issues)
          .leftJoin(
            costEvents,
            and(
              eq(costEvents.companyId, companyId),
              eq(costEvents.issueId, issues.id),
            ),
          )
          .where(
            and(
              eq(issues.companyId, companyId),
              visibleIssueCondition(),
              issueTreeCondition,
            ),
          ),
        db.execute(runSummarySql),
      ]);

      const costRow = costRowResult[0];
      const runRow = Array.isArray(runRowResult)
        ? (runRowResult[0] as { runCount?: number | string | null; runtimeMs?: number | string | null } | undefined)
        : undefined;

      return {
        issueId,
        issueCount: Number(costRow?.issueCount ?? 0),
        includeDescendants: true,
        costCents: Number(costRow?.costCents ?? 0),
        consumptionCents: Number(costRow?.consumptionCents ?? 0),
        inputTokens: Number(costRow?.inputTokens ?? 0),
        cachedInputTokens: Number(costRow?.cachedInputTokens ?? 0),
        cacheCreationInputTokens: Number(costRow?.cacheCreationInputTokens ?? 0),
        outputTokens: Number(costRow?.outputTokens ?? 0),
        runCount: Number(runRow?.runCount ?? 0),
        runtimeMs: Number(runRow?.runtimeMs ?? 0),
      };
    },

    byAgent: async (companyId: string, range?: CostDateRange, options: CostAgentFilter = {}) => {
      const conditions: ReturnType<typeof eq>[] = [eq(costEvents.companyId, companyId)];
      if (options.agentId) conditions.push(eq(costEvents.agentId, options.agentId));
      if (range?.from) conditions.push(gte(costEvents.occurredAt, range.from));
      if (range?.to) conditions.push(lte(costEvents.occurredAt, range.to));

      return db
        .select({
          agentId: costEvents.agentId,
          agentName: agents.name,
          agentStatus: agents.status,
          costCents: sumAsNumber(costEvents.costCents),
          consumptionCents: consumptionCentsSum,
          inputTokens: sumAsNumber(costEvents.inputTokens),
          cachedInputTokens: sumAsNumber(costEvents.cachedInputTokens),
          cacheCreationInputTokens: sumAsNumber(costEvents.cacheCreationInputTokens),
          outputTokens: sumAsNumber(costEvents.outputTokens),
          apiRunCount:
            sql<number>`count(distinct case when ${costEvents.billingType} = ${METERED_BILLING_TYPE} then ${costEvents.heartbeatRunId} end)::int`,
          subscriptionRunCount:
            sql<number>`count(distinct case when ${costEvents.billingType} in (${sql.join(SUBSCRIPTION_BILLING_TYPES.map((value) => sql`${value}`), sql`, `)}) then ${costEvents.heartbeatRunId} end)::int`,
          // PEN-4902: the unbranched denominator. The two counters above cover only
          // classified rows and both read 0 while `unknown` is the fleet's normal value.
          costEventRunCount: costEventRunCountExpr,
          runlessEventCount: runlessEventCountExpr,
          subscriptionCachedInputTokens:
            sql<number>`coalesce(sum(case when ${costEvents.billingType} in (${sql.join(SUBSCRIPTION_BILLING_TYPES.map((value) => sql`${value}`), sql`, `)}) then ${costEvents.cachedInputTokens} else 0 end), 0)::double precision`,
          // BLO-29842: cache writes used to be folded into inputTokens, so without this
          // twin `subscriptionInputTokens` silently shrinks by the whole cache-write volume.
          subscriptionCacheCreationInputTokens:
            sql<number>`coalesce(sum(case when ${costEvents.billingType} in (${sql.join(SUBSCRIPTION_BILLING_TYPES.map((value) => sql`${value}`), sql`, `)}) then ${costEvents.cacheCreationInputTokens} else 0 end), 0)::double precision`,
          subscriptionInputTokens:
            sql<number>`coalesce(sum(case when ${costEvents.billingType} in (${sql.join(SUBSCRIPTION_BILLING_TYPES.map((value) => sql`${value}`), sql`, `)}) then ${costEvents.inputTokens} else 0 end), 0)::double precision`,
          subscriptionOutputTokens:
            sql<number>`coalesce(sum(case when ${costEvents.billingType} in (${sql.join(SUBSCRIPTION_BILLING_TYPES.map((value) => sql`${value}`), sql`, `)}) then ${costEvents.outputTokens} else 0 end), 0)::double precision`,
        })
        .from(costEvents)
        .leftJoin(agents, eq(costEvents.agentId, agents.id))
        .where(and(...conditions))
        .groupBy(costEvents.agentId, agents.name, agents.status)
        .orderBy(desc(sumAsNumber(costEvents.costCents)));
    },

    byProvider: async (companyId: string, range?: CostDateRange) => {
      const conditions: ReturnType<typeof eq>[] = [eq(costEvents.companyId, companyId)];
      if (range?.from) conditions.push(gte(costEvents.occurredAt, range.from));
      if (range?.to) conditions.push(lte(costEvents.occurredAt, range.to));

      return db
        .select({
          provider: costEvents.provider,
          biller: costEvents.biller,
          billingType: costEvents.billingType,
          model: costEvents.model,
          costCents: sumAsNumber(costEvents.costCents),
          consumptionCents: consumptionCentsSum,
          inputTokens: sumAsNumber(costEvents.inputTokens),
          cachedInputTokens: sumAsNumber(costEvents.cachedInputTokens),
          cacheCreationInputTokens: sumAsNumber(costEvents.cacheCreationInputTokens),
          outputTokens: sumAsNumber(costEvents.outputTokens),
          apiRunCount:
            sql<number>`count(distinct case when ${costEvents.billingType} = ${METERED_BILLING_TYPE} then ${costEvents.heartbeatRunId} end)::int`,
          subscriptionRunCount:
            sql<number>`count(distinct case when ${costEvents.billingType} in (${sql.join(SUBSCRIPTION_BILLING_TYPES.map((value) => sql`${value}`), sql`, `)}) then ${costEvents.heartbeatRunId} end)::int`,
          // PEN-4902: the unbranched denominator. The two counters above cover only
          // classified rows and both read 0 while `unknown` is the fleet's normal value.
          costEventRunCount: costEventRunCountExpr,
          runlessEventCount: runlessEventCountExpr,
          subscriptionCachedInputTokens:
            sql<number>`coalesce(sum(case when ${costEvents.billingType} in (${sql.join(SUBSCRIPTION_BILLING_TYPES.map((value) => sql`${value}`), sql`, `)}) then ${costEvents.cachedInputTokens} else 0 end), 0)::double precision`,
          // BLO-29842: cache writes used to be folded into inputTokens, so without this
          // twin `subscriptionInputTokens` silently shrinks by the whole cache-write volume.
          subscriptionCacheCreationInputTokens:
            sql<number>`coalesce(sum(case when ${costEvents.billingType} in (${sql.join(SUBSCRIPTION_BILLING_TYPES.map((value) => sql`${value}`), sql`, `)}) then ${costEvents.cacheCreationInputTokens} else 0 end), 0)::double precision`,
          subscriptionInputTokens:
            sql<number>`coalesce(sum(case when ${costEvents.billingType} in (${sql.join(SUBSCRIPTION_BILLING_TYPES.map((value) => sql`${value}`), sql`, `)}) then ${costEvents.inputTokens} else 0 end), 0)::double precision`,
          subscriptionOutputTokens:
            sql<number>`coalesce(sum(case when ${costEvents.billingType} in (${sql.join(SUBSCRIPTION_BILLING_TYPES.map((value) => sql`${value}`), sql`, `)}) then ${costEvents.outputTokens} else 0 end), 0)::double precision`,
        })
        .from(costEvents)
        .where(and(...conditions))
        .groupBy(costEvents.provider, costEvents.biller, costEvents.billingType, costEvents.model)
        .orderBy(desc(sumAsNumber(costEvents.costCents)));
    },

    byBiller: async (companyId: string, range?: CostDateRange) => {
      const conditions: ReturnType<typeof eq>[] = [eq(costEvents.companyId, companyId)];
      if (range?.from) conditions.push(gte(costEvents.occurredAt, range.from));
      if (range?.to) conditions.push(lte(costEvents.occurredAt, range.to));

      return db
        .select({
          biller: costEvents.biller,
          costCents: sumAsNumber(costEvents.costCents),
          consumptionCents: consumptionCentsSum,
          inputTokens: sumAsNumber(costEvents.inputTokens),
          cachedInputTokens: sumAsNumber(costEvents.cachedInputTokens),
          cacheCreationInputTokens: sumAsNumber(costEvents.cacheCreationInputTokens),
          outputTokens: sumAsNumber(costEvents.outputTokens),
          apiRunCount:
            sql<number>`count(distinct case when ${costEvents.billingType} = ${METERED_BILLING_TYPE} then ${costEvents.heartbeatRunId} end)::int`,
          subscriptionRunCount:
            sql<number>`count(distinct case when ${costEvents.billingType} in (${sql.join(SUBSCRIPTION_BILLING_TYPES.map((value) => sql`${value}`), sql`, `)}) then ${costEvents.heartbeatRunId} end)::int`,
          // PEN-4902: the unbranched denominator. The two counters above cover only
          // classified rows and both read 0 while `unknown` is the fleet's normal value.
          costEventRunCount: costEventRunCountExpr,
          runlessEventCount: runlessEventCountExpr,
          subscriptionCachedInputTokens:
            sql<number>`coalesce(sum(case when ${costEvents.billingType} in (${sql.join(SUBSCRIPTION_BILLING_TYPES.map((value) => sql`${value}`), sql`, `)}) then ${costEvents.cachedInputTokens} else 0 end), 0)::double precision`,
          // BLO-29842: cache writes used to be folded into inputTokens, so without this
          // twin `subscriptionInputTokens` silently shrinks by the whole cache-write volume.
          subscriptionCacheCreationInputTokens:
            sql<number>`coalesce(sum(case when ${costEvents.billingType} in (${sql.join(SUBSCRIPTION_BILLING_TYPES.map((value) => sql`${value}`), sql`, `)}) then ${costEvents.cacheCreationInputTokens} else 0 end), 0)::double precision`,
          subscriptionInputTokens:
            sql<number>`coalesce(sum(case when ${costEvents.billingType} in (${sql.join(SUBSCRIPTION_BILLING_TYPES.map((value) => sql`${value}`), sql`, `)}) then ${costEvents.inputTokens} else 0 end), 0)::double precision`,
          subscriptionOutputTokens:
            sql<number>`coalesce(sum(case when ${costEvents.billingType} in (${sql.join(SUBSCRIPTION_BILLING_TYPES.map((value) => sql`${value}`), sql`, `)}) then ${costEvents.outputTokens} else 0 end), 0)::double precision`,
          providerCount: sql<number>`count(distinct ${costEvents.provider})::int`,
          modelCount: sql<number>`count(distinct ${costEvents.model})::int`,
        })
        .from(costEvents)
        .where(and(...conditions))
        .groupBy(costEvents.biller)
        .orderBy(desc(sumAsNumber(costEvents.costCents)));
    },

    /**
     * aggregates cost_events by provider for each of three rolling windows:
     * last 5 hours, last 24 hours, last 7 days.
     * purely internal consumption data, no external rate-limit sources.
     */
    windowSpend: async (companyId: string) => {
      const windows = [
        { label: "5h", hours: 5 },
        { label: "24h", hours: 24 },
        { label: "7d", hours: 168 },
      ] as const;

      const results = await Promise.all(
        windows.map(async ({ label, hours }) => {
          const since = new Date(Date.now() - hours * 60 * 60 * 1000);
          const rows = await db
            .select({
              provider: costEvents.provider,
              biller: sql<string>`case when count(distinct ${costEvents.biller}) = 1 then min(${costEvents.biller}) else 'mixed' end`,
              costCents: sumAsNumber(costEvents.costCents),
              consumptionCents: consumptionCentsSum,
              inputTokens: sumAsNumber(costEvents.inputTokens),
              cachedInputTokens: sumAsNumber(costEvents.cachedInputTokens),
              cacheCreationInputTokens: sumAsNumber(costEvents.cacheCreationInputTokens),
              outputTokens: sumAsNumber(costEvents.outputTokens),
            })
            .from(costEvents)
            .where(
              and(
                eq(costEvents.companyId, companyId),
                gte(costEvents.occurredAt, since),
              ),
            )
            .groupBy(costEvents.provider)
            .orderBy(desc(sumAsNumber(costEvents.costCents)));

          return rows.map((row) => ({
            provider: row.provider,
            biller: row.biller,
            window: label as string,
            windowHours: hours,
            costCents: row.costCents,
            consumptionCents: row.consumptionCents,
            inputTokens: row.inputTokens,
            cachedInputTokens: row.cachedInputTokens,
            cacheCreationInputTokens: row.cacheCreationInputTokens,
            outputTokens: row.outputTokens,
          }));
        }),
      );

      return results.flat();
    },

    byAgentModel: async (companyId: string, range?: CostDateRange, options: CostAgentFilter = {}) => {
      const conditions: ReturnType<typeof eq>[] = [eq(costEvents.companyId, companyId)];
      if (options.agentId) conditions.push(eq(costEvents.agentId, options.agentId));
      if (range?.from) conditions.push(gte(costEvents.occurredAt, range.from));
      if (range?.to) conditions.push(lte(costEvents.occurredAt, range.to));

      // single query: group by agent + provider + model.
      // the (companyId, agentId, occurredAt) composite index covers this well.
      // order by provider + model for stable db-level ordering; cost-desc sort
      // within each agent's sub-rows is done client-side in the ui memo.
      return db
        .select({
          agentId: costEvents.agentId,
          agentName: agents.name,
          provider: costEvents.provider,
          biller: costEvents.biller,
          billingType: costEvents.billingType,
          model: costEvents.model,
          costCents: sumAsNumber(costEvents.costCents),
          consumptionCents: consumptionCentsSum,
          inputTokens: sumAsNumber(costEvents.inputTokens),
          cachedInputTokens: sumAsNumber(costEvents.cachedInputTokens),
          cacheCreationInputTokens: sumAsNumber(costEvents.cacheCreationInputTokens),
          outputTokens: sumAsNumber(costEvents.outputTokens),
        })
        .from(costEvents)
        .leftJoin(agents, eq(costEvents.agentId, agents.id))
        .where(and(...conditions))
        .groupBy(
          costEvents.agentId,
          agents.name,
          costEvents.provider,
          costEvents.biller,
          costEvents.billingType,
          costEvents.model,
        )
        .orderBy(costEvents.provider, costEvents.biller, costEvents.billingType, costEvents.model);
    },

    byProject: async (companyId: string, range?: CostDateRange) => {
      const conditions: ReturnType<typeof eq>[] = [eq(costEvents.companyId, companyId)];
      if (range?.from) conditions.push(gte(costEvents.occurredAt, range.from));
      if (range?.to) conditions.push(lte(costEvents.occurredAt, range.to));

      /**
       * PEN-5585: the window has to reach `run_project_links`, not just `cost_events`.
       *
       * `run_project_links` exists only to supply a project for cost events that carry a
       * `heartbeat_run_id` but no `project_id`. It used to be built from the company's
       * ENTIRE `activity_log` history whatever window the caller asked for, so its cost
       * grew monotonically with fleet activity and never came back down — and the join it
       * feeds is `activity_log.entity_id = issues.id::text`, where the cast defeats any
       * ordinary index on `issues.id`, so that full join fed a `DISTINCT ON` sort.
       *
       * On 2026-11-04 that stopped fitting inside the 30s `statement_timeout`: a client
       * polling a pinned 30-day window every 60s got 503 on 191/191 attempts, and the
       * always-in-flight 30s query pushed ten other routes over their own timeouts
       * (peak 103 `57014`/hour against a 0-1/hour baseline).
       *
       * Restricting to the runs that actually appear in the windowed `cost_events` is
       * EXACTLY result-preserving, not an approximation: the outer `leftJoin` is on
       * `cost_events.heartbeat_run_id = run_project_links.run_id`, so a link row whose
       * `run_id` is absent from that set can never match and contributes nothing. It is
       * deliberately not a `created_at` bound — a run may log activity long before or
       * after the cost event it bills, and no run-duration slack is provably safe.
       *
       * The inner select is served by `cost_events_company_occurred_idx`, and the
       * resulting `run_id` restriction by `activity_log_run_id_idx`.
       */
      const windowedRunIds = db
        .selectDistinct({ runId: costEvents.heartbeatRunId })
        .from(costEvents)
        .where(and(...conditions, isNotNull(costEvents.heartbeatRunId)));

      const issueIdAsText = sql<string>`${issues.id}::text`;
      // PEN-5604: dedup by RUN, not by (run, project) pair. Pair-dedup emitted one link
      // row per project a run touched, and since the join below matches on `run_id`
      // alone, every cost event of a multi-project run was counted once per project --
      // so `sum(byProject[].costCents)` exceeded actual spend. Run-dedup also makes the
      // `ORDER BY ... created_at DESC` below mean what it was written to mean: of the
      // projects this run touched, attribute its run-level cost to the most recent one.
      const runProjectLinks = db
        .selectDistinctOn([activityLog.runId], {
          runId: activityLog.runId,
          projectId: issues.projectId,
        })
        .from(activityLog)
        .innerJoin(
          issues,
          and(
            eq(activityLog.entityType, "issue"),
            eq(activityLog.entityId, issueIdAsText),
          ),
        )
        .where(
          and(
            eq(activityLog.companyId, companyId),
            eq(issues.companyId, companyId),
            isNotNull(activityLog.runId),
            isNotNull(issues.projectId),
            inArray(activityLog.runId, windowedRunIds),
          ),
        )
        .orderBy(activityLog.runId, desc(activityLog.createdAt))
        .as("run_project_links");

      const effectiveProjectId = sql<string | null>`coalesce(${costEvents.projectId}, ${runProjectLinks.projectId})`;

      const costCentsExpr = sumAsNumber(costEvents.costCents);

      return db
        .select({
          projectId: effectiveProjectId,
          projectName: projects.name,
          costCents: costCentsExpr,
          consumptionCents: consumptionCentsSum,
          inputTokens: sumAsNumber(costEvents.inputTokens),
          cachedInputTokens: sumAsNumber(costEvents.cachedInputTokens),
          cacheCreationInputTokens: sumAsNumber(costEvents.cacheCreationInputTokens),
          outputTokens: sumAsNumber(costEvents.outputTokens),
        })
        .from(costEvents)
        // Only rows WITHOUT a direct project need run attribution. Narrowing the join
        // here is safe under LEFT JOIN -- a row that already carries a project simply
        // does not match, and `coalesce(direct, null)` returns that project unchanged.
        .leftJoin(
          runProjectLinks,
          and(
            eq(costEvents.heartbeatRunId, runProjectLinks.runId),
            isNull(costEvents.projectId),
          ),
        )
        .innerJoin(projects, sql`${projects.id} = ${effectiveProjectId}`)
        .where(and(...conditions, sql`${effectiveProjectId} is not null`))
        .groupBy(effectiveProjectId, projects.name)
        .orderBy(desc(costCentsExpr));
    },
  };
}
