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
 */
export function promptTokens(
  row: Pick<BilledTokenCounts, "inputTokens" | "cacheCreationInputTokens">,
): number {
  return row.inputTokens + row.cacheCreationInputTokens;
}

/** Every billed token class for a row: fresh input + cache write + cache read + output. */
export function totalTokens(row: BilledTokenCounts): number {
  return promptTokens(row) + row.cachedInputTokens + row.outputTokens;
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
  budgetCents: number;
  utilizationPercent: number;
}

export interface IssueCostSummary {
  issueId: string;
  issueCount: number;
  includeDescendants: boolean;
  costCents: number;
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
  inputTokens: number;
  cachedInputTokens: number;
  /** BLO-29842: cache WRITE (Anthropic `cache_creation_input_tokens`), billed 1.25x-2x input. Not part of `inputTokens`. */
  cacheCreationInputTokens: number;
  outputTokens: number;
  apiRunCount: number;
  subscriptionRunCount: number;
  subscriptionCachedInputTokens: number;
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
  inputTokens: number;
  cachedInputTokens: number;
  /** BLO-29842: cache WRITE (Anthropic `cache_creation_input_tokens`), billed 1.25x-2x input. Not part of `inputTokens`. */
  cacheCreationInputTokens: number;
  outputTokens: number;
  apiRunCount: number;
  subscriptionRunCount: number;
  subscriptionCachedInputTokens: number;
  subscriptionCacheCreationInputTokens: number;
  subscriptionInputTokens: number;
  subscriptionOutputTokens: number;
}

export interface CostByBiller {
  biller: string;
  costCents: number;
  inputTokens: number;
  cachedInputTokens: number;
  /** BLO-29842: cache WRITE (Anthropic `cache_creation_input_tokens`), billed 1.25x-2x input. Not part of `inputTokens`. */
  cacheCreationInputTokens: number;
  outputTokens: number;
  apiRunCount: number;
  subscriptionRunCount: number;
  subscriptionCachedInputTokens: number;
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
  inputTokens: number;
  cachedInputTokens: number;
  /** BLO-29842: cache WRITE (Anthropic `cache_creation_input_tokens`), billed 1.25x-2x input. Not part of `inputTokens`. */
  cacheCreationInputTokens: number;
  outputTokens: number;
}
