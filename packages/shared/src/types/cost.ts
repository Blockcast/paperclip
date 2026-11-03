import type { BillingType, CostStatus } from "../constants.js";

/**
 * BLO-29842: the four billed token classes carried by every cost row.
 *
 * Fields are REQUIRED on purpose. Cache writes used to be folded into
 * `inputTokens`, so every volume total in the app silently shrinks if a row is
 * summed without them. Requiring the field makes that a compile error at the
 * next call site instead of a quiet under-report.
 */
export interface BilledTokenCounts {
  inputTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  outputTokens: number;
}

/**
 * Prompt tokens billed at or above the fresh-input rate: fresh input + cache
 * writes. This is what `inputTokens` alone meant before BLO-29842 split cache
 * writes into their own column, so any total that used to read `inputTokens`
 * must read this to keep measuring the same thing.
 *
 * Excludes cache READS, which bill at ~0.1x and stay separate — callers that
 * want every prompt class add `cachedInputTokens` themselves, or use
 * `totalTokens`.
 *
 * The `?? 0` legs are NOT redundant despite the required types. Both helpers
 * are called straight onto API-deserialized rows in the UI, and during the
 * rolling deploy that ships this change a new bundle can reach an old pod whose
 * response predates `cacheCreationInputTokens`. Bare `+` would turn the WHOLE
 * total into `NaN` rather than dropping just the absent leg — a visible wrong
 * number on every tile, where the honest degradation is the old total.
 */
export function promptTokens(
  row: Pick<BilledTokenCounts, "inputTokens" | "cacheCreationInputTokens">,
): number {
  return (row.inputTokens ?? 0) + (row.cacheCreationInputTokens ?? 0);
}

/** Every billed token class for a row: fresh input + cache write + cache read + output. */
export function totalTokens(row: BilledTokenCounts): number {
  return promptTokens(row) + (row.cachedInputTokens ?? 0) + (row.outputTokens ?? 0);
}

export interface CostEvent {
  id: string;
  companyId: string;
  agentId: string;
  issueId: string | null;
  projectId: string | null;
  goalId: string | null;
  heartbeatRunId: string | null;
  billingCode: string | null;
  provider: string;
  biller: string;
  billingType: BillingType;
  costStatus: CostStatus;
  model: string;
  inputTokens: number;
  cachedInputTokens: number;
  /** BLO-29842: cache WRITE (Anthropic `cache_creation_input_tokens`), billed 1.25x-2x input. Not part of `inputTokens`. */
  cacheCreationInputTokens: number;
  outputTokens: number;
  costCents: number;
  occurredAt: Date;
  createdAt: Date;
}

export interface CostSummary {
  companyId: string;
  spendCents: number;
  /**
   * PEN-4902: list-price CONSUMPTION for the same rows. Served by every `/costs/*`
   * aggregate since PEN-4466, but undeclared here until now — so a typed client was
   * offered only the cash column and could not see the two diverge, which is the very
   * thing `services/consumption-metric.ts` says reporting both exists to prevent.
   *
   * THIS, not `costCents`, is what enforcement reads: `getMonthlySpendTotal`
   * (`services/costs.ts`) and `computeObservedAmount` (`services/budgets.ts`) both sum
   * `consumptionCentsExpr`, so it is the number behind `spentMonthlyCents`, the 75% warn
   * card, and any `hardStopEnabled` policy. `costCents` is CASH, and is zeroed for
   * `subscription_included` by `normalizeBilledCostCents`. The two are equal for every
   * row written to date only because no lane is classified as a subscription; they
   * diverge — cash reading LOW — the first time any adapter reports one.
   */
  consumptionCents: number;
  budgetCents: number;
  utilizationPercent: number;
  /** PEN-4902: `consumptionCents` against the same budget. Served since PEN-4466, undeclared until now. */
  consumptionUtilizationPercent: number;
}

export interface IssueCostSummary {
  issueId: string;
  issueCount: number;
  includeDescendants: boolean;
  costCents: number;
  /**
   * PEN-4902: list-price CONSUMPTION for the same rows — served since PEN-4466, declared
   * here from now on. This is the quantity every spend gate reads; `costCents` is CASH and
   * is zeroed for `subscription_included`. See `services/consumption-metric.ts`.
   */
  consumptionCents: number;
  inputTokens: number;
  cachedInputTokens: number;
  /** BLO-29842: cache WRITE (Anthropic `cache_creation_input_tokens`), billed 1.25x-2x input. Not part of `inputTokens`. */
  cacheCreationInputTokens: number;
  outputTokens: number;
  /** number of distinct heartbeat runs aggregated across the issue tree */
  runCount: number;
  /** sum of wall-clock duration of each run in the tree (ms);
   * still-running runs contribute (now - startedAt) so this ticks up live */
  runtimeMs: number;
}

export interface CostByAgent {
  agentId: string;
  agentName: string | null;
  agentStatus: string | null;
  costCents: number;
  /** PEN-4902: list-price CONSUMPTION for the same rows — the quantity enforcement reads. See {@link CostSummary.consumptionCents}. */
  consumptionCents: number;
  inputTokens: number;
  cachedInputTokens: number;
  /** BLO-29842: cache WRITE (Anthropic `cache_creation_input_tokens`), billed 1.25x-2x input. Not part of `inputTokens`. */
  cacheCreationInputTokens: number;
  outputTokens: number;
  apiRunCount: number;
  subscriptionRunCount: number;
  /**
   * PEN-4902: distinct heartbeat runs IN THIS WINDOW THAT PRODUCED A COST EVENT, with no
   * `billingType` branch. `apiRunCount` and `subscriptionRunCount` above cover only
   * CLASSIFIED rows, and both read 0 while `unknown` is the fleet's normal value (it is
   * the default in `createEvent` and what brokered lanes deliberately resolve to). A zero
   * there reads as "this scope made no runs" and is not that.
   *
   * ⚠️ This is a LOWER BOUND on runs, not the run count, and it is deliberately NOT named
   * `runCount`: {@link IssueCostSummary.runCount} carries that name for a different
   * population — runs counted `FROM heartbeat_runs`, with no `cost_events` join.
   * `heartbeat.ts` writes a cost event only when a run reports spend or token usage, so a
   * run that produced neither is absent here and present there. For a true per-run
   * denominator over a window, count `heartbeat_runs`
   * (`GET /companies/:id/heartbeat-runs?from=…&to=…&countOnly=true`) rather than this.
   */
  costEventRunCount: number;
  /**
   * PEN-4902: rows in the window carrying no `heartbeatRunId`. The column is nullable and
   * `count(distinct …)` skips NULL, so these are in the numerator of cost-per-run and not
   * in its denominator: a non-zero value means that ratio reads HIGH.
   */
  runlessEventCount: number;
  subscriptionCachedInputTokens: number;
  /** BLO-29842: cache WRITE on subscription-billed runs. Not part of `subscriptionInputTokens`. */
  subscriptionCacheCreationInputTokens: number;
  subscriptionInputTokens: number;
  subscriptionOutputTokens: number;
}

export interface CostByProviderModel {
  provider: string;
  biller: string;
  billingType: BillingType;
  model: string;
  costCents: number;
  /** PEN-4902: list-price CONSUMPTION for the same rows — the quantity enforcement reads. See {@link CostSummary.consumptionCents}. */
  consumptionCents: number;
  inputTokens: number;
  cachedInputTokens: number;
  /** BLO-29842: cache WRITE (Anthropic `cache_creation_input_tokens`), billed 1.25x-2x input. Not part of `inputTokens`. */
  cacheCreationInputTokens: number;
  outputTokens: number;
  apiRunCount: number;
  subscriptionRunCount: number;
  /**
   * PEN-4902: distinct heartbeat runs IN THIS WINDOW THAT PRODUCED A COST EVENT, with no
   * `billingType` branch. `apiRunCount` and `subscriptionRunCount` above cover only
   * CLASSIFIED rows, and both read 0 while `unknown` is the fleet's normal value (it is
   * the default in `createEvent` and what brokered lanes deliberately resolve to). A zero
   * there reads as "this scope made no runs" and is not that.
   *
   * ⚠️ This is a LOWER BOUND on runs, not the run count, and it is deliberately NOT named
   * `runCount`: {@link IssueCostSummary.runCount} carries that name for a different
   * population — runs counted `FROM heartbeat_runs`, with no `cost_events` join.
   * `heartbeat.ts` writes a cost event only when a run reports spend or token usage, so a
   * run that produced neither is absent here and present there. For a true per-run
   * denominator over a window, count `heartbeat_runs`
   * (`GET /companies/:id/heartbeat-runs?from=…&to=…&countOnly=true`) rather than this.
   */
  costEventRunCount: number;
  /**
   * PEN-4902: rows in the window carrying no `heartbeatRunId`. The column is nullable and
   * `count(distinct …)` skips NULL, so these are in the numerator of cost-per-run and not
   * in its denominator: a non-zero value means that ratio reads HIGH.
   */
  runlessEventCount: number;
  subscriptionCachedInputTokens: number;
  /** BLO-29842: cache WRITE on subscription-billed runs. Not part of `subscriptionInputTokens`. */
  subscriptionCacheCreationInputTokens: number;
  subscriptionInputTokens: number;
  subscriptionOutputTokens: number;
}

export interface CostByBiller {
  biller: string;
  costCents: number;
  /** PEN-4902: list-price CONSUMPTION for the same rows — the quantity enforcement reads. See {@link CostSummary.consumptionCents}. */
  consumptionCents: number;
  inputTokens: number;
  cachedInputTokens: number;
  /** BLO-29842: cache WRITE (Anthropic `cache_creation_input_tokens`), billed 1.25x-2x input. Not part of `inputTokens`. */
  cacheCreationInputTokens: number;
  outputTokens: number;
  apiRunCount: number;
  subscriptionRunCount: number;
  /**
   * PEN-4902: distinct heartbeat runs IN THIS WINDOW THAT PRODUCED A COST EVENT, with no
   * `billingType` branch. `apiRunCount` and `subscriptionRunCount` above cover only
   * CLASSIFIED rows, and both read 0 while `unknown` is the fleet's normal value (it is
   * the default in `createEvent` and what brokered lanes deliberately resolve to). A zero
   * there reads as "this scope made no runs" and is not that.
   *
   * ⚠️ This is a LOWER BOUND on runs, not the run count, and it is deliberately NOT named
   * `runCount`: {@link IssueCostSummary.runCount} carries that name for a different
   * population — runs counted `FROM heartbeat_runs`, with no `cost_events` join.
   * `heartbeat.ts` writes a cost event only when a run reports spend or token usage, so a
   * run that produced neither is absent here and present there. For a true per-run
   * denominator over a window, count `heartbeat_runs`
   * (`GET /companies/:id/heartbeat-runs?from=…&to=…&countOnly=true`) rather than this.
   */
  costEventRunCount: number;
  /**
   * PEN-4902: rows in the window carrying no `heartbeatRunId`. The column is nullable and
   * `count(distinct …)` skips NULL, so these are in the numerator of cost-per-run and not
   * in its denominator: a non-zero value means that ratio reads HIGH.
   */
  runlessEventCount: number;
  subscriptionCachedInputTokens: number;
  /** BLO-29842: cache WRITE on subscription-billed runs. Not part of `subscriptionInputTokens`. */
  subscriptionCacheCreationInputTokens: number;
  subscriptionInputTokens: number;
  subscriptionOutputTokens: number;
  providerCount: number;
  modelCount: number;
}

/** per-agent breakdown by provider + model, for identifying token-hungry agents */
export interface CostByAgentModel {
  agentId: string;
  agentName: string | null;
  provider: string;
  biller: string;
  billingType: BillingType;
  model: string;
  costCents: number;
  /** PEN-4902: list-price CONSUMPTION for the same rows — the quantity enforcement reads. See {@link CostSummary.consumptionCents}. */
  consumptionCents: number;
  inputTokens: number;
  cachedInputTokens: number;
  /** BLO-29842: cache WRITE (Anthropic `cache_creation_input_tokens`), billed 1.25x-2x input. Not part of `inputTokens`. */
  cacheCreationInputTokens: number;
  outputTokens: number;
}

/** spend per provider for a fixed rolling time window */
export interface CostWindowSpendRow {
  provider: string;
  biller: string;
  /** duration label, e.g. "5h", "24h", "7d" */
  window: string;
  /** rolling window duration in hours */
  windowHours: number;
  costCents: number;
  /**
   * PEN-4902: list-price CONSUMPTION for the same rows — served since PEN-4466, declared
   * here from now on. This is the quantity every spend gate reads; `costCents` is CASH and
   * is zeroed for `subscription_included`. See `services/consumption-metric.ts`.
   */
  consumptionCents: number;
  inputTokens: number;
  cachedInputTokens: number;
  /** BLO-29842: cache WRITE (Anthropic `cache_creation_input_tokens`), billed 1.25x-2x input. Not part of `inputTokens`. */
  cacheCreationInputTokens: number;
  outputTokens: number;
}

/** cost attributed to a project via heartbeat run → activity log → issue → project chain */
export interface CostByProject {
  projectId: string | null;
  projectName: string | null;
  costCents: number;
  /** PEN-4902: list-price CONSUMPTION for the same rows — the quantity enforcement reads. See {@link CostSummary.consumptionCents}. */
  consumptionCents: number;
  inputTokens: number;
  cachedInputTokens: number;
  /** BLO-29842: cache WRITE (Anthropic `cache_creation_input_tokens`), billed 1.25x-2x input. Not part of `inputTokens`. */
  cacheCreationInputTokens: number;
  outputTokens: number;
}
