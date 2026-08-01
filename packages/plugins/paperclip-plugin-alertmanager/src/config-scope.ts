/**
 * Per-company config and bearer-token resolution.
 *
 * Split out of worker.ts so it is unit-testable: worker.ts calls
 * `startWorkerRpcHost()` at import time, so a test cannot import it directly.
 *
 * Why per-company at all: the host hands a plugin worker an EMPTY bootstrap
 * config whenever more than one company has configured the plugin — see
 * `server/src/services/plugin-loader.ts` ("multiple company configs; legacy
 * bootstrap scope disabled"). A worker that snapshots its token during
 * `setup()` therefore has no token at all on a multi-company instance, and
 * rejects every delivery with `unauthorized`. Webhook deliveries carry their
 * own `companyId`, so the token is resolved from that instead.
 */

import type { PluginContext } from "@paperclipai/plugin-sdk";
import { DEFAULT_ISSUE_ROUTE_MAP, DEFAULT_OWNER_MAP } from "./constants.js";
import type {
  AlertmanagerPluginConfig,
  IssueRouteMap,
  OwnerMap,
} from "./types.js";

export function mergeOwnerMap(ownerMap: OwnerMap | undefined): OwnerMap {
  const merged: OwnerMap = {};
  for (const [labelKey, valueMap] of Object.entries(DEFAULT_OWNER_MAP)) {
    merged[labelKey] = { ...valueMap };
  }
  for (const [labelKey, valueMap] of Object.entries(ownerMap ?? {})) {
    merged[labelKey] = { ...(merged[labelKey] ?? {}), ...valueMap };
  }
  return merged;
}

export function mergeIssueRouteMap(
  issueRouteMap: IssueRouteMap | undefined,
): IssueRouteMap {
  const merged: IssueRouteMap = {};
  for (const [labelKey, valueMap] of Object.entries(DEFAULT_ISSUE_ROUTE_MAP)) {
    merged[labelKey] = {};
    for (const [labelValue, route] of Object.entries(valueMap)) {
      merged[labelKey][labelValue] = { ...route };
    }
  }
  for (const [labelKey, valueMap] of Object.entries(issueRouteMap ?? {})) {
    merged[labelKey] = { ...(merged[labelKey] ?? {}) };
    for (const [labelValue, route] of Object.entries(valueMap)) {
      merged[labelKey][labelValue] = {
        ...(merged[labelKey][labelValue] ?? {}),
        ...route,
      };
    }
  }
  return merged;
}

/**
 * Normalise a raw config snapshot into the shape the handlers expect
 * (defaults merged in). Pure — safe to call per request.
 */
export function buildConfig(
  config: AlertmanagerPluginConfig,
): AlertmanagerPluginConfig {
  return {
    ...config,
    ownerMap: mergeOwnerMap(config.ownerMap),
    issueRouteMap: mergeIssueRouteMap(config.issueRouteMap),
  };
}

/** True when the host gave us no usable config snapshot. */
export function isEmptyConfig(
  raw: Record<string, unknown> | null | undefined,
): boolean {
  return !raw || Object.keys(raw).length === 0;
}

/**
 * Resolve the bearer token this company's webhook endpoint should accept.
 *
 * Resolved per delivery rather than cached: the SDK contract for
 * `ctx.secrets.resolve` is that secret values "must never be cached or written
 * to logs, config, or other persistent storage" — and a cached token is
 * exactly what let a worker restart silently disable auth for every company.
 *
 * `webhookTokenRef` is the production posture; `webhookToken` is the
 * documented dev-mode inline fallback.
 *
 * Returns `null` ONLY when this company has configured no credential at all.
 * That is a determinate answer — nothing can authenticate against an endpoint
 * with no token — so the caller is right to reject the delivery.
 *
 * A *failure to resolve* a configured ref is a different thing entirely, and is
 * raised rather than returned. `ctx.secrets.resolve` is typed `Promise<string>`
 * and signals every failure by throwing, so a caught error means we do not know
 * what the expected token is. Not knowing the expected credential is not
 * evidence that the presented one is wrong: reporting it as `unauthorized`
 * writes a false `alertmanager.webhook.unauthorized` metric — the exact signal
 * an operator reads as "someone is sending bad credentials" — and records
 * "unauthorized" on the delivery row instead of the real secrets error, sending
 * an incident investigation in the wrong direction.
 *
 * Transient (provider outage) and permanent (malformed ref) failures are
 * deliberately treated alike, because they are not distinguishable here: the
 * host collapses every worker→host handler error to a JSON-RPC
 * `INTERNAL_ERROR` with only a message string (`plugin-worker-manager.ts`
 * `errorCodeForWorkerHostError`), discarding the originating HTTP status. Given
 * that, failing retryably is the safe default in both directions — a permanent
 * misconfiguration surfaces as repeated `failed` deliveries carrying the real
 * error text, which is louder and more diagnostic than a silent 401, while a
 * transient outage keeps the alert alive.
 */
export async function resolveWebhookToken(
  ctx: PluginContext,
  config: AlertmanagerPluginConfig,
  companyId?: string,
): Promise<string | null> {
  const forCompany = companyId ? ` for company ${companyId}` : "";
  if (config.webhookTokenRef) {
    try {
      return await ctx.secrets.resolve(config.webhookTokenRef, { companyId });
    } catch (err) {
      ctx.logger.error(
        `paperclip-plugin-alertmanager: failed to resolve webhookTokenRef${forCompany}: ${String(err)}`,
      );
      throw new CompanyScopeUnavailableError(
        `could not resolve webhookTokenRef${forCompany}: ${String(err)}`,
      );
    }
  }
  if (config.webhookToken) return config.webhookToken;
  ctx.logger.warn(
    `paperclip-plugin-alertmanager: no webhookToken or webhookTokenRef configured${forCompany} — webhook endpoint will reject every request`,
  );
  return null;
}

export interface CompanyScope {
  config: AlertmanagerPluginConfig;
  token: string | null;
}

/**
 * Raised when this delivery's company scope could not be established for a
 * reason that may not still hold on a retry — a failed config RPC, a company
 * with no stored config yet, or a configured `webhookTokenRef` that could not
 * be resolved.
 *
 * It must propagate out of `onWebhook`. Returning normally makes the host record
 * the delivery `success` and answer HTTP 200 (`server/src/routes/plugins.ts`
 * "Step 8: Update delivery record to success"), which tells Alertmanager the
 * alert was accepted and suppresses its retry — so a transient config-RPC blip
 * would silently destroy the alert instead of delaying it. Throwing lands in the
 * host's catch, records `failed`, and returns 502, which Alertmanager retries.
 */
export class CompanyScopeUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompanyScopeUnavailableError";
  }
}

/**
 * Load the config + bearer token for the company that owns this delivery.
 *
 * The delivering company's own config row is the ONLY acceptable source, and
 * there is deliberately no fallback to the `setup()` snapshot. Two reasons:
 *
 *  1. The snapshot is worthless. `plugin-loader.ts` builds the bootstrap config
 *     as a literal `{}` for every install — single- and multi-company alike —
 *     so it never carries a token to fall back to.
 *  2. The snapshot is dangerous. The only thing that ever populates those
 *     module globals is `onConfigChanged`, which the host fires per company
 *     without telling the worker which one it was. The globals therefore hold
 *     "whichever company saved config last". Serving that to a different
 *     company's delivery would authenticate it against the wrong tenant's
 *     bearer token and then file the resulting issues under the wrong tenant's
 *     `defaultCompanyId`.
 *
 * Failure modes are split by whether a retry could succeed. A read error, an
 * empty config, or a `defaultCompanyId` naming a different tenant throws
 * `CompanyScopeUnavailableError` so Alertmanager retries and the alert survives
 * an operator fixing the config. A delivery with no `companyId` at all returns
 * `null`: no retry can add one, so it is dropped. Neither ever falls open onto
 * another tenant's credentials.
 */
export async function resolveCompanyScope(
  ctx: PluginContext,
  // `PluginWebhookInput.companyId` is a required `string`, so this keeps the SDK
  // guarantee intact. The falsy check below is ingress defense against a host
  // that violates it, not an admission that `undefined` is expected.
  companyId: string,
): Promise<CompanyScope | null> {
  if (!companyId) {
    ctx.logger.error(
      "paperclip-plugin-alertmanager: webhook delivery carried no companyId — dropping rather than guessing a tenant",
    );
    return null;
  }
  let raw: Record<string, unknown> | null | undefined;
  try {
    raw = (await ctx.config.get(companyId)) as
      | Record<string, unknown>
      | null
      | undefined;
  } catch (err) {
    ctx.logger.error(
      `paperclip-plugin-alertmanager: failed to load config for company ${companyId}: ${String(err)}`,
    );
    throw new CompanyScopeUnavailableError(
      `could not load config for company ${companyId}: ${String(err)}`,
    );
  }
  if (isEmptyConfig(raw)) {
    ctx.logger.error(
      `paperclip-plugin-alertmanager: no stored config for company ${companyId} — failing delivery so Alertmanager retries`,
    );
    throw new CompanyScopeUnavailableError(
      `no stored config for company ${companyId}`,
    );
  }
  const config = buildConfig(raw as unknown as AlertmanagerPluginConfig);

  // The host picked this delivery's tenant when it matched the endpoint key;
  // `defaultCompanyId` is just an operator-typed field inside that tenant's own
  // config row. Where they disagree, the host wins — it is the authenticated
  // fact, and the stored string is the guess.
  //
  // Leaving them unreconciled loses alerts two different silent ways, both of
  // which still answer HTTP 200 and so stop Alertmanager retrying:
  //   - unset: every firing alert hits the `defaultCompanyId not configured`
  //     guard in webhook-handler.ts and no-ops.
  //   - pointing at another company: issue calls target a tenant outside this
  //     invocation's scope, the host denies them, and `handleWebhook`'s
  //     per-alert catch swallows the denial.
  if (!config.defaultCompanyId) {
    config.defaultCompanyId = companyId;
  } else if (config.defaultCompanyId !== companyId) {
    ctx.logger.error(
      `paperclip-plugin-alertmanager: company ${companyId} has defaultCompanyId=${config.defaultCompanyId} — refusing to file its alerts under another tenant`,
    );
    throw new CompanyScopeUnavailableError(
      `defaultCompanyId ${config.defaultCompanyId} does not match delivering company ${companyId}`,
    );
  }

  return {
    config,
    token: await resolveWebhookToken(ctx, config, companyId),
  };
}
