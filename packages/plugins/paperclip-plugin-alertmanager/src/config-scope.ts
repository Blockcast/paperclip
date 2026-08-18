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

import type { PluginContext, PluginWebhookInput } from "@paperclipai/plugin-sdk";
import { DEFAULT_ISSUE_ROUTE_MAP, DEFAULT_OWNER_MAP } from "./constants.js";
import { readBearerCredential, verifyBearerToken } from "./webhook-handler.js";
import { recordCredentialResolution } from "./credential-health.js";
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
 * Returns the inline token when configured. A `null` result either means there
 * is no credential or that a secret ref must be verified separately.
 *
 * `webhookTokenRef` is intentionally not resolved in the worker. The webhook
 * path verifies it through `ctx.secrets.verify`, which returns only a boolean
 * and does not consume the secret value-resolution budget.
 */
export async function resolveWebhookToken(
  ctx: PluginContext,
  config: AlertmanagerPluginConfig,
  companyId?: string,
): Promise<string | null> {
  const forCompany = companyId ? ` for company ${companyId}` : "";
  // A configured `webhookTokenRef` resolves to no inline value ON PURPOSE: the
  // secret never enters this worker. Until BLO-20738 this branch threw, because
  // the only way to check a ref was to resolve it. `authenticateWebhook` now
  // checks the presented bearer through `ctx.secrets.verify`, so a ref is a
  // usable credential and `null` here means "verified elsewhere", not "absent".
  // Callers must therefore treat a ref as configured — see `resolveCompanyScope`.
  if (config.webhookTokenRef) return null;
  if (config.webhookToken) return config.webhookToken;
  ctx.logger.warn(
    `paperclip-plugin-alertmanager: no webhookToken or webhookTokenRef configured${forCompany} — webhook endpoint will reject every request`,
  );
  return null;
}

export async function authenticateWebhook(
  ctx: PluginContext,
  config: AlertmanagerPluginConfig,
  input: PluginWebhookInput,
): Promise<boolean> {
  if (config.webhookTokenRef) {
    const presented = readBearerCredential(input.headers);
    // Reject a credential-less request before spending a host round trip:
    // that is what keeps an anonymous flood free (BLO-20706 / PR #924).
    if (presented === null) return false;
    try {
      return await ctx.secrets.verify(config.webhookTokenRef, presented, {
        companyId: input.companyId,
        configPath: "webhookTokenRef",
      });
    } catch (err) {
      // The host refuses to verify some secret versions (BLO-20738). Either way
      // that is a permanent configuration or data fault for this company, NOT a
      // wrong bearer, so it must not be reported as `unauthorized` — that would
      // read as an Alertmanager misconfiguration and hide the real cause.
      const unverifiable = verifierRefusalCode(err);
      if (unverifiable) {
        // Both codes fail closed identically, but they send an operator to two
        // different places, so they must not share a message. `unsupported` is
        // a legitimate configuration choice the host cannot serve; `unavailable`
        // means the version row is missing or its digest is malformed, which is
        // a data-integrity fault — telling that operator to "use an inline
        // token" would point them at the wrong problem entirely.
        ctx.logger.error(
          unverifiable === "secret_verifier_unsupported"
            ? `paperclip-plugin-alertmanager: webhookTokenRef for company ${input.companyId} points at an external provider reference, which cannot be verified host-side — use an inline webhookToken or a Paperclip-managed secret version`
            : `paperclip-plugin-alertmanager: webhookTokenRef for company ${input.companyId} resolved to a secret version the host cannot verify — its version row is missing or its stored digest is malformed. This is a vault data fault, not a configuration choice: check the secret's versions rather than switching credential shape.`,
        );
        // `resolveCompanyScope` already recorded this company as credentialed
        // on the strength of the ref being set; correct that, or `onHealth()`
        // reports `ok` for a tenant rejecting 100% of deliveries (BLO-20572).
        recordCredentialResolution(input.companyId, null);
        throw new CompanyScopeUnavailableError(
          `webhookTokenRef for company ${input.companyId} cannot be verified host-side (${unverifiable})`,
        );
      }
      throw err;
    }
  }
  return verifyBearerToken(input.headers, config.webhookToken ?? null);
}

/**
 * Which "the host cannot verify this secret" refusal is this, if any?
 *
 * Returns the discriminating code so the caller can explain the right fault,
 * or `null` for anything else. Both codes fail closed the same way, but they
 * are different problems: `secret_verifier_unsupported` is an external
 * provider reference (a configuration choice the host cannot serve), while
 * `secret_verifier_unavailable` is a missing version row or malformed digest
 * (a data-integrity fault). A single boolean forced one message onto both.
 *
 * Matched on `err.data.code`, which is where a host error's machine-readable
 * discriminator lands: the host projects `HttpError.details.code` into the
 * JSON-RPC error's `data` (`plugin-worker-manager.ts` → `workerHostErrorData`),
 * and the worker transport surfaces that as `JsonRpcCallError.data`
 * (`packages/plugins/sdk/src/protocol.ts`).
 *
 * NOT matched on `err.code`: that is the numeric JSON-RPC code, and an
 * `unprocessable()` from a host service always arrives as `INTERNAL_ERROR`
 * (-32603) because `HttpError` carries `status`, not a numeric `code`. NOT
 * matched on the message either — prose is not a contract, and string-matching
 * it is how this check silently rots.
 */
function verifierRefusalCode(
  err: unknown,
): "secret_verifier_unsupported" | "secret_verifier_unavailable" | null {
  if (!err || typeof err !== "object") return null;
  const data = (err as { data?: unknown }).data;
  if (!data || typeof data !== "object") return null;
  const code = (data as { code?: unknown }).code;
  if (code === "secret_verifier_unsupported") return code;
  if (code === "secret_verifier_unavailable") return code;
  return null;
}

export interface CompanyScope {
  config: AlertmanagerPluginConfig;
  token: string | null;
}

/**
 * Raised when this delivery's company scope could not be established for a
 * reason that may not still hold on a retry — a failed config RPC or a company
 * with no stored config yet.
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
    // Deliberately NOT recorded as a credential fault: a config-RPC blip is
    // transient and may not hold on retry, so recording it would flap the
    // health surface on infrastructure noise rather than on misconfiguration.
    throw new CompanyScopeUnavailableError(
      `could not load config for company ${companyId}: ${String(err)}`,
    );
  }
  if (isEmptyConfig(raw)) {
    ctx.logger.error(
      `paperclip-plugin-alertmanager: no stored config for company ${companyId} — failing delivery so Alertmanager retries`,
    );
    // No stored config means neither `webhookToken` nor `webhookTokenRef` is
    // set, which is precisely the "no credential resolvable" condition — and it
    // throws before `handleWebhook`, so record it here (BLO-20572).
    recordCredentialResolution(companyId, null);
    throw new CompanyScopeUnavailableError(
      `no stored config for company ${companyId}`,
    );
  }
  const config = buildConfig(raw as unknown as AlertmanagerPluginConfig);

  // Resolve (and record) the credential BEFORE the routing check below.
  // Credential validity and routing validity are independent faults, but the
  // routing check used to run first and throw, so a company with a routing
  // mismatch never reached this line at all: a company with no credential
  // *and* a mismatch was invisible to health, and a company that fixed its
  // credential but still had a stale mismatch could never clear a prior
  // degraded entry, because the mismatch always threw before recording ran
  // again (BLO-20572 review feedback on PR #948).
  const token = await resolveWebhookToken(ctx, config, companyId);
  // `webhookTokenRef ?? token`, not `token`: a ref-configured company resolves
  // no inline token by design (BLO-20738), and recording that `null` would
  // report every ref-configured tenant as credential-less while its deliveries
  // authenticate perfectly. The ref is an opaque identifier, never a secret
  // value, and this recorder only reads truthiness — it never stores or logs
  // what it is handed.
  //
  // This is now the ONLY success-path recorder. `handleWebhook` used to record
  // too, but it is handed an authentication *verdict* rather than a credential
  // once a ref is in play, so it can no longer distinguish "no credential
  // configured" from "wrong bearer presented" — exactly the conflation
  // credential-health.ts exists to avoid.
  recordCredentialResolution(companyId, config.webhookTokenRef ?? token);

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
    // A permanent misconfiguration, but a routing one, not (necessarily) a
    // credential one — the credential state above already recorded the truth
    // for this company independent of this throw, so a good token isn't
    // misreported as missing just because routing also failed.
    throw new CompanyScopeUnavailableError(
      `defaultCompanyId ${config.defaultCompanyId} does not match delivering company ${companyId}`,
    );
  }

  return { config, token };
}

/**
 * Resolve one company's config for a single `check-alert-escalations`
 * dispatch (BLO-20957: the host now dispatches the sweep once per company
 * configured for this plugin, each with its own invocation scope, rather
 * than a process-wide dispatch that only ever worked for one company).
 *
 * Unlike `resolveCompanyScope`, a missing or misrouted config for this
 * dispatch resolves to `null` instead of throwing — the escalation sweep is
 * a scheduled job with no inbound delivery to retry against, so those cases
 * are a "skip and log" condition, not a retryable failure. A `ctx.config.get`
 * RPC failure still propagates (the caller lets it fail the job run so it
 * shows up in `plugin_job_runs`, rather than silently skipping a company on
 * a transient blip). This also never resolves a bearer token — the sweep
 * only reads and updates issues, it does not authenticate inbound webhook
 * traffic.
 *
 * Returns `null` when there is no stored config for `companyId`, or when the
 * stored config's `defaultCompanyId` names a *different* tenant (a
 * misconfigured row — refuse rather than sweep under the wrong tenant).
 */
export async function resolveEscalationSweepConfig(
  ctx: PluginContext,
  companyId: string,
): Promise<AlertmanagerPluginConfig | null> {
  const raw = (await ctx.config.get(companyId)) as
    | Record<string, unknown>
    | null
    | undefined;
  if (isEmptyConfig(raw)) return null;
  const config = buildConfig(raw as unknown as AlertmanagerPluginConfig);
  if (!config.defaultCompanyId) {
    config.defaultCompanyId = companyId;
  } else if (config.defaultCompanyId !== companyId) {
    ctx.logger.error(
      `paperclip-plugin-alertmanager: company ${companyId} has defaultCompanyId=${config.defaultCompanyId} — refusing to sweep its alerts under another tenant`,
    );
    return null;
  }
  return config;
}
