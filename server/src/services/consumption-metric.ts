import { sql } from "drizzle-orm";
import { costEvents } from "@paperclipai/db";

/**
 * ⚠️ ORDERING CONSTRAINT — read this before "fixing" adapter billingType classification.
 *
 * `cost_events` carries two quantities in two columns and they are not interchangeable:
 *
 *   * `cost_cents` is CASH. It is written through `normalizeBilledCostCents()`
 *     (`services/heartbeat.ts`), which returns 0 whenever `billingType` is
 *     "subscription_included" — correctly, because the marginal cash cost of a run on an
 *     already-purchased seat is $0.
 *   * `consumption_cents` is list-price CONSUMPTION, computed from the same `costUsd` with
 *     NO `billingType` branch. It is the quantity a THROTTLE wants: list price is monotone
 *     in work and model-weighted.
 *
 * Every spend gate and every burn series must read CONSUMPTION. Before PEN-4466 they all
 * summed `cost_cents`, so on the day an adapter started classifying subscription lanes
 * correctly, every such lane would book $0, every cap would read 0 forever, and every
 * hard stop would become silently unreachable while all dashboards read healthy.
 *
 * ⇒ A `billingType` classification change must not reach `normalizeBilledCostCents` until
 * every reader below is on this expression. Classification goes LAST.
 *
 * This constant exists so there is exactly ONE place to audit, and so a new reader cannot
 * quietly reintroduce the defect by hand-rolling `sum(cost_cents)`. Its consumers:
 *
 *   | reader                        | file                    | what it drives                      |
 *   |-------------------------------|-------------------------|-------------------------------------|
 *   | `computeObservedAmount`       | `services/budgets.ts`   | every `hardStopEnabled` policy      |
 *   | `heartbeat.daily_cost_limit`  | `services/heartbeat.ts` | per-agent daily cost cap            |
 *   | `getMonthlySpendTotal`        | `services/costs.ts`     | the STORED `spent_monthly_cents`    |
 *   | `getMonthlySpendByAgentIds`   | `services/agents.ts`    | the SERVED `agents.spentMonthly…`   |
 *   | `getMonthlySpendByCompanyIds` | `services/companies.ts` | the SERVED `companies.spentMonthly…`|
 *
 * The last two matter more than they look: they OVERWRITE the stored column with a live
 * re-sum on every read, so repointing `getMonthlySpendTotal` alone would fix what is
 * written and not what is served, and `spentMonthlyCents` would still flatline forward on
 * the day classification lands. Flatlining is worse than collapsing — the fleet reads as
 * *stopped* rather than *mis-metered*.
 *
 * Still NOT on this expression, deliberately: the reporting surfaces (`/costs/*`,
 * `dashboard.ts`, `issue-efficiency.ts`). They answer the cash question too, carry no gate,
 * and so fail visibly rather than silently — but whoever lands classification owes them
 * both quantities, labelled.
 *
 * `coalesce` and NOT `coalesce(nullif(consumption_cents, 0), …)`: the column is nullable
 * precisely so NULL ("row predates migration 0263") stays distinguishable from 0 ("this
 * run genuinely cost nothing"). `nullif` collapses those and re-reads `cost_cents` for
 * every free row, forever. The fallback also covers rows written between 0263 and the
 * deploy that starts populating the column.
 *
 * Ruling: Penstock PEN-4463 (@Ceo, 2026-10-21). Trace: PEN-4397 doc
 * billing-classification-trace. Invariants held by
 * `server/src/__tests__/budget-consumption-metric.test.ts`.
 */
export const consumptionCentsExpr = sql<number>`coalesce(${costEvents.consumptionCents}, ${costEvents.costCents})`;

/** `sum()` of the consumption metric as a double, 0 when the window is empty. */
export const consumptionCentsSum = sql<number>`coalesce(sum(coalesce(${costEvents.consumptionCents}, ${costEvents.costCents})), 0)::double precision`;
