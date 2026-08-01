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
import { PLUGIN_RPC_ERROR_CODES } from "@paperclipai/plugin-sdk";
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
 * Resolve the inline bearer token this company's webhook endpoint should accept.
 *
 * Returns `null` ONLY when this company has configured no credential at all.
 * That is a determinate answer — nothing can authenticate against an endpoint
 * with no token — so the caller is right to reject the delivery.
 *
 * `webhookTokenRef` is intentionally not resolved in the worker's public
 * webhook path. Invalid public deliveries would otherwise force one
 * `ctx.secrets.resolve` operation before authentication, letting unauthenticated
 * traffic spend the shared secret-resolution budget. A secret-ref production
 * posture needs a host-side verifier that can authenticate before invoking the
 * worker. Until that exists, secret refs fail closed and inline tokens remain
 * the only enabled worker-side authentication mechanism.
 */
export async function resolveWebhookToken(
  ctx: PluginContext,
  config: AlertmanagerPluginConfig,
  companyId?: string,
): Promise<string | null> {
  const forCompany = companyId ? ` for company ${companyId}` : "";
  if (config.webhookToken) return config.webhookToken;
  if (config.webhookTokenRef) {
    ctx.logger.error(
      `paperclip-plugin-alertmanager: webhookTokenRef is configured${forCompany}, but secret-ref webhook auth requires host-side verification before the worker is invoked`,
    );
    throw new CompanyScopeUnavailableError(
      `webhookTokenRef${forCompany} requires host-side webhook verification`,
    );
  }
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
 * with no stored config yet, or a configured `webhookTokenRef` on a build that
 * requires host-side verification before secret refs can be used safely.
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

/**
 * True when a host call failed because this invocation carries no company
 * scope (or the wrong one).
 *
 * Matched on the JSON-RPC code rather than the message so it survives wording
 * changes; the `name` check covers a direct (non-RPC) handler call in tests.
 */
function isInvocationScopeDenied(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED) return true;
  return (err as { name?: unknown } | null)?.name === "InvocationScopeDeniedError";
}

/**
 * Resolve the company scope for one escalation-sweep tick.
 *
 * The scope comes from the HOST's invocation scope, not from a module global
 * populated by `onConfigChanged`. That distinction is the whole point:
 *
 *  - `onConfigChanged` does not say which company saved, so a global populated
 *    from it holds "whichever company saved last" — and is empty until the
 *    first save after every restart. That is last-writer-wins plus a silent
 *    post-restart hole.
 *  - An unscoped `ctx.config.get()` *after* initialization is an RPC the host
 *    answers from the current invocation's scope
 *    (`worker-rpc-host.ts` → `config.get`). For a job tick the host derives
 *    that scope in `deriveCallInvocationScope`
 *    (`server/src/services/plugin-worker-manager.ts`), which returns
 *    `bootstrapCompanyId` — set by `plugin-loader.ts` only when EXACTLY ONE
 *    company has configured the plugin.
 *
 * So the behaviour is decided by the host, deterministically:
 *
 *  - One configured company → the tick is scoped to it, and we read that
 *    company's live config straight from the host. No dependence on
 *    `onConfigChanged`, so the sweep is correct immediately after a restart.
 *  - Two or more → the tick has no scope and the host denies every
 *    company-scoped call. This is not a limitation we can code around: the
 *    sweep's own `ctx.issues.list({ companyId })` would be denied too, whatever
 *    company id we passed it. We stop here deliberately and say so, rather than
 *    proceeding into a guaranteed `InvocationScopeDeniedError` per tick.
 *
 * Enumerating a plugin's configured companies needs a host API that the worker
 * protocol does not expose (the host has `registry.listConfigCompanyIds`, but
 * there is no worker-facing method for it) — tracked in BLO-20595. Until that
 * lands, multi-company escalation cannot work, and this returns `null`.
 */
export async function resolveSweepScope(
  ctx: PluginContext,
): Promise<AlertmanagerPluginConfig | null> {
  let raw: Record<string, unknown> | null | undefined;
  try {
    raw = (await ctx.config.get()) as
      | Record<string, unknown>
      | null
      | undefined;
  } catch (err) {
    if (isInvocationScopeDenied(err)) {
      ctx.logger.warn(
        "paperclip-plugin-alertmanager: escalation sweep skipped — this instance has more than one company configured, so the host gives scheduled jobs no company scope and denies every company-scoped call. Alert escalation ladders are NOT advancing for any tenant. Needs host enumeration of configured companies (BLO-20595). Webhook deliveries are unaffected: they carry their own company scope.",
      );
      return null;
    }
    ctx.logger.error(
      `paperclip-plugin-alertmanager: escalation sweep skipped — could not load config for this tick: ${String(err)}`,
    );
    return null;
  }
  if (isEmptyConfig(raw)) {
    ctx.logger.warn(
      "paperclip-plugin-alertmanager: escalation sweep skipped — the scoped company has no stored plugin config yet",
    );
    return null;
  }
  const config = buildConfig(raw as unknown as AlertmanagerPluginConfig);
  if (!config.defaultCompanyId) {
    ctx.logger.warn(
      "paperclip-plugin-alertmanager: escalation sweep skipped — defaultCompanyId is not set in the scoped company's config",
    );
    return null;
  }
  return config;
}
