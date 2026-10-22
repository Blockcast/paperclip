import type { BillingType } from "@paperclipai/shared";

/**
 * Ledger `billing_type` classification for a completed run.
 *
 * ⚠️ READ THIS WITH `services/consumption-metric.ts`. That file holds the ORDERING
 * CONSTRAINT: a classification change must not reach `normalizeBilledCostCents` until every
 * spend gate reads CONSUMPTION. PEN-4466 discharged that precondition (deployed
 * 2026-10-22T10:15:03Z); this file is the classification change it was gating.
 *
 * ## The defect this fixes
 *
 * Every Penstock-brokered lane booked as `metered_api` — i.e. "Anthropic bills us per
 * token for this run". That is false, and it was false by two independent routes:
 *
 *   * `claude_k8s` (9 of the 11 live lanes) carries ONE unconditional
 *     `billingType: "api"` literal and does not classify at all. It cannot: the
 *     `ANTHROPIC_BASE_URL` that determines the lane is supplied by the Job pod's image
 *     (`$HOME/.bashrc`, see `job-manifest.ts`), not by anything the adapter holds.
 *   * `claude_local` (the other 2) asks `resolveClaudeBillingType` whether
 *     `ANTHROPIC_API_KEY` is set, and answers "api" when it is. But the platform ITSELF
 *     writes that variable on exactly the proxied lane — from the
 *     `paperclip-penstock-org-key` secret in the deployment, and via
 *     `applyPaperclipRunAuthAnthropicEnv` in the adapter. So the signal it reads is one
 *     the caller manufactured, and it carries no information about upstream billing.
 *
 * Measured 2026-10-22 against running artifacts, not traced: a live agent Job pod reports
 * `ANTHROPIC_BASE_URL=https://api.penstock.run/anthropic` with `ANTHROPIC_API_KEY` a
 * 47-char `psk_…` Penstock key (an Anthropic key is `sk-ant-…`); both `Deployment/paperclip-api`
 * and `StatefulSet/paperclip` source that variable from `secretKeyRef: paperclip-penstock-org-key`.
 *
 * ## Why classification lives HERE and not in the adapters
 *
 * The row that commissioned this asked for an adapter fix. It cannot be one for 9 of 11
 * lanes — see `claude_k8s` above. The server, by contrast, holds the lane in its own
 * resolved env, which is where `penstock-availability-gate.ts` already reads it before
 * every run. Confirmed live on the ledger-writing tier: `paperclip-0` reports 52
 * `penstock_availability_gate_probe_total{outcome="ok",provider="anthropic"}` samples, and
 * that counter is unreachable unless `isPenstockBaseUrl()` returned true there.
 *
 * ## Why `unknown` and NOT `subscription_included`
 *
 * `unknown` is the honest answer, and the only one supported by evidence:
 *
 *   * What IS verifiable is that the lane is BROKERED — the run authenticates to
 *     `*.penstock.run` with a Penstock key, so it has no direct metered relationship with
 *     the upstream provider. `metered_api` is therefore affirmatively false.
 *   * What is NOT verifiable from this process is what Penstock did upstream. It brokers
 *     onto a pool that holds both subscription seats AND raw API keys, and no response
 *     header distinguishes them (the CLI would not surface one anyway). Asserting
 *     `subscription_included` would invent the answer — the exact failure that made
 *     migration `0263` crashloop production for 31 minutes on 2026-10-22.
 *   * It is also the only safe direction. `subscription_included` is the ONE value
 *     `normalizeBilledCostCents` zeroes; emitting it would take `cost_cents` to 0 for
 *     100% of fleet spend. `unknown` is not zeroed, so no cap can move. That invariant is
 *     asserted, not merely intended — see `billing-classification.test.ts`.
 *
 * The cash question stays open and now reads as open instead of answered wrongly. It is
 * owned by the cash ledger (`finance_events`, PEN-4463 step 1), which is where a figure
 * backed by real invoices can come from.
 *
 * Ruling: Penstock PEN-4463 (@Ceo, 2026-10-21), step 3 = PEN-4515.
 */

/** Values that assert a DIRECT metered relationship with the upstream provider. */
const DIRECT_METERED_BILLING_TYPES: ReadonlySet<string> = new Set(["api", "metered_api"]);

/**
 * The one value `normalizeBilledCostCents` zeroes. Named so the invariant "classification
 * never synthesises a zeroing type" is checkable rather than a comment.
 */
export const CASH_ZEROING_BILLING_TYPE: BillingType = "subscription_included";

/**
 * Hosts Penstock serves on. Hostname-exact rather than a substring match: a substring test
 * for "penstock" would also match an attacker-chosen `penstock.evil.test`, and the point of
 * this predicate is to decide what we assert about money.
 *
 * `penstock-availability-gate.ts` imports this rather than keeping its own copy, so the
 * "is this lane brokered?" question has exactly one answer in the codebase.
 */
export function isPenstockBaseUrl(baseUrl: string | null | undefined): boolean {
  if (!baseUrl?.trim()) return false;
  try {
    const url = new URL(baseUrl);
    return url.hostname === "api.penstock.run" || url.hostname.endsWith(".penstock.run");
  } catch {
    return false;
  }
}

/**
 * Base-URL env var per adapter-reported provider. Mirrors `PROVIDER_ENV` in
 * `penstock-availability-gate.ts`. A provider absent from this map is never treated as
 * brokered — `openrouter` bills its own key directly and must keep reporting `metered_api`.
 */
const PROVIDER_BASE_URL_ENV: Readonly<Record<string, string>> = {
  anthropic: "ANTHROPIC_BASE_URL",
  claude: "ANTHROPIC_BASE_URL",
  openai: "OPENAI_BASE_URL",
  codex: "OPENAI_BASE_URL",
};

function readEnvString(source: Record<string, unknown> | null | undefined, key: string): string | null {
  const raw = source?.[key];
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
}

export interface LaneBillingInput {
  /** `AdapterExecutionResult.billingType`, as the adapter reported it. */
  reported: unknown;
  /** `AdapterExecutionResult.provider`. */
  provider: unknown;
  /** The agent's `adapterConfig`; its `env` wins over `process.env`, as the gate resolves it. */
  adapterConfig?: unknown;
  /** Defaults to `process.env`. Injectable so the behaviour is testable without mutating it. */
  env?: Record<string, string | undefined>;
}

/**
 * Normalise an adapter-reported billing type onto the ledger's closed union.
 *
 * Moved here from `services/heartbeat.ts` so normalisation and the brokered-lane correction
 * live together: they are two halves of one decision, and a caller that reaches only the
 * first silently re-books brokered spend as metered.
 */
export function normalizeLedgerBillingType(value: unknown): BillingType {
  const raw = typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
  switch (raw) {
    case "api":
    case "metered_api":
      return "metered_api";
    case "subscription":
    case "subscription_included":
      return "subscription_included";
    case "subscription_overage":
      return "subscription_overage";
    case "credits":
      return "credits";
    case "fixed":
      return "fixed";
    default:
      return "unknown";
  }
}

/** True when this run's provider lane is served through Penstock rather than direct. */
export function isBrokeredLane(input: Pick<LaneBillingInput, "provider" | "adapterConfig" | "env">): boolean {
  const provider = typeof input.provider === "string" ? input.provider.trim().toLowerCase() : "";
  const envKey = PROVIDER_BASE_URL_ENV[provider];
  if (!envKey) return false;

  const adapterConfig = (input.adapterConfig ?? null) as Record<string, unknown> | null;
  const configEnv = (adapterConfig?.env ?? null) as Record<string, unknown> | null;
  const baseUrl = readEnvString(configEnv, envKey) ?? readEnvString(input.env ?? process.env, envKey);
  return isPenstockBaseUrl(baseUrl);
}

/**
 * The ledger `billing_type` for a completed run.
 *
 * Only ever WEAKENS a claim: a brokered lane reporting a direct-metered type is corrected to
 * `unknown`. Nothing here can produce {@link CASH_ZEROING_BILLING_TYPE} that was not already
 * reported by the adapter, which is what makes landing this incapable of zeroing a cap.
 */
export function resolveLedgerBillingType(input: LaneBillingInput): BillingType {
  const normalized = normalizeLedgerBillingType(input.reported);
  if (!DIRECT_METERED_BILLING_TYPES.has(normalized)) return normalized;
  return isBrokeredLane(input) ? "unknown" : normalized;
}
