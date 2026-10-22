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
 * Reporting surfaces, updated by PEN-4515 (the classification change this block was
 * gating). The debt this paragraph used to record is now partly paid and the rest is a
 * recorded decision rather than silence:
 *
 *   * `/costs/*` and `dashboard.ts` now report BOTH quantities, named. `costCents` /
 *     `spendCents` / `monthSpendCents` keep meaning CASH; `consumptionCents` /
 *     `monthConsumptionCents` are this expression. Every aggregate carries the pair, so a
 *     reader can see cash and consumption diverge instead of being handed one and told it
 *     is the other.
 *   * `issue-efficiency.ts` and `dashboard.ts`'s agent scorecard are deliberately NOT
 *     twinned. Both build DERIVED RATIOS on cash (`costCentsPerAuthoredLoc`,
 *     `costCentsPerMergedPr`, scorecard weighting), so twinning them doubles a public API
 *     shape and forces a second, unasked question — which denominator an efficiency ratio
 *     should use. Their question ("what did this cost us") is a cash question and cash is
 *     the right column for it today. Revisit when a lane is genuinely classified
 *     `subscription_included`; until then the two columns are equal for every row ever
 *     written, so the omission cannot mislead anyone yet.
 *
 * Note what makes that last sentence true rather than hopeful: PEN-4515 resolves brokered
 * lanes to `unknown`, never to `subscription_included`, and
 * `services/billing-classification.test.ts` asserts it cannot synthesise that value. So
 * `cost_cents` and `consumption_cents` still agree on every row, and no cap moved.
 *
 * `coalesce` and NOT `coalesce(nullif(consumption_cents, 0), …)`: the column is nullable
 * precisely so NULL ("row predates migration 0263") stays distinguishable from 0 ("this
 * run genuinely cost nothing"). `nullif` collapses those and re-reads `cost_cents` for
 * every free row, forever. The fallback also covers rows written between 0263 and the
 * deploy that starts populating the column.
 *
 * Upstream of every reader above sits ONE classifier:
 * `services/billing-classification.ts` decides the `billing_type` each row is written with,
 * for every adapter, from the lane rather than from the adapter's self-report. Audit it
 * together with this file — a reader on the right column still reports the wrong thing if
 * rows are classified wrongly, which is what PEN-4515 fixed.
 *
 * Ruling: Penstock PEN-4463 (@Ceo, 2026-10-21). Trace: PEN-4397 doc
 * billing-classification-trace. Invariants held by
 * `server/src/__tests__/budget-consumption-metric.test.ts`.
 */
export const consumptionCentsExpr = sql<number>`coalesce(${costEvents.consumptionCents}, ${costEvents.costCents})`;

/** `sum()` of the consumption metric as a double, 0 when the window is empty. */
export const consumptionCentsSum = sql<number>`coalesce(sum(coalesce(${costEvents.consumptionCents}, ${costEvents.costCents})), 0)::double precision`;
