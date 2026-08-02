/**
 * Per-company webhook-credential health, derived from observed delivery
 * outcomes rather than a config probe.
 *
 * `onHealth()` has no company scope: `resolveRequiredCompanyId`
 * (`packages/plugins/sdk/src/host-client-factory.ts`) throws
 * `InvocationScopeDeniedError` for an unscoped `config.get`, so health cannot
 * enumerate configured companies and pre-check their tokens (BLO-20572).
 * Every webhook delivery already resolves a per-company token
 * (`resolveCompanyScope` in `config-scope.ts`), so recording that outcome
 * here gives `onHealth()` something real to report without ever touching
 * config itself.
 *
 * The signal is about CONFIGURATION, not authentication: it fires when the
 * company's config resolved no usable credential at all, never when a
 * request merely presented the wrong one. Recording on presented-token
 * failures would let anyone flip a tenant's reported health by sending bad
 * bearer tokens, and would conflate "misconfigured" with "under attack".
 */

import type { PluginHealthDiagnostics } from "@paperclipai/plugin-sdk";

const NO_CREDENTIAL_REASON =
  "no webhookToken or webhookTokenRef configured";

const companiesMissingCredential = new Map<string, string>();

/**
 * Record whether the delivering company's config resolved a usable bearer
 * token for this delivery. Call once per delivery, keyed by the company that
 * owns it — not by whether the request's presented `Authorization` header
 * happened to match.
 */
export function recordCredentialResolution(
  companyId: string,
  resolvedToken: string | null,
): void {
  if (resolvedToken) {
    companiesMissingCredential.delete(companyId);
  } else {
    companiesMissingCredential.set(companyId, NO_CREDENTIAL_REASON);
  }
}

/** Current health, derived purely from recorded delivery outcomes. */
export function getCredentialHealth(): PluginHealthDiagnostics {
  if (companiesMissingCredential.size === 0) {
    return { status: "ok" };
  }
  const companyIds = [...companiesMissingCredential.keys()].sort();
  const plural = companyIds.length === 1 ? "company" : "companies";
  return {
    status: "degraded",
    message: `no webhook credential resolved for ${companyIds.length} ${plural}: ${companyIds.join(", ")}`,
    details: { companyIds },
  };
}

/** Test-only: clear recorded state between cases. */
export function resetCredentialHealth(): void {
  companiesMissingCredential.clear();
}
