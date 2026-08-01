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
      return null;
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
 * Load the config + bearer token for the company that owns this delivery.
 *
 * Falls back to the `setup()` snapshot only when the per-company read yields
 * nothing, so single-company installs behave exactly as before.
 */
export async function resolveCompanyScope(
  ctx: PluginContext,
  companyId: string | undefined,
  fallbackConfig: AlertmanagerPluginConfig | null,
  fallbackToken: string | null,
): Promise<CompanyScope | null> {
  if (companyId) {
    try {
      const raw = (await ctx.config.get(companyId)) as
        | Record<string, unknown>
        | null
        | undefined;
      if (!isEmptyConfig(raw)) {
        const config = buildConfig(raw as unknown as AlertmanagerPluginConfig);
        return {
          config,
          token: await resolveWebhookToken(ctx, config, companyId),
        };
      }
    } catch (err) {
      ctx.logger.error(
        `paperclip-plugin-alertmanager: failed to load config for company ${companyId}: ${String(err)}`,
      );
    }
  }
  if (!fallbackConfig) return null;
  return { config: fallbackConfig, token: fallbackToken };
}
