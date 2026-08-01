/**
 * paperclip-plugin-alertmanager — worker entrypoint.
 *
 * Receives Alertmanager v2 webhook deliveries, dedups per-alert by
 * fingerprint, and produces Paperclip issues with the right assignee,
 * priority, and observability drill-in links. Resolution status updates the
 * tracked issue per the configured autoCloseOnResolve policy.
 *
 * The plugin emits two domain events that sibling plugins (e.g. Slack) can
 * subscribe to without coupling to AM directly:
 *   - plugin.alertmanager.alert.firing
 *   - plugin.alertmanager.alert.resolved
 *
 * See `docs/specs/2026-04-29-alertmanager-plugin-spec.md` for the full design.
 */

import {
  definePlugin,
  startWorkerRpcHost,
  type PluginContext,
  type PluginWebhookInput,
} from "@paperclipai/plugin-sdk";
import { handleWebhook } from "./webhook-handler.js";
import { runAlertEscalationSweep } from "./escalation.js";
import {
  buildConfig,
  isEmptyConfig,
  resolveCompanyScope,
} from "./config-scope.js";
import type { AlertmanagerPluginConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Module-level worker state
//
// Read ONLY by the escalation job. The webhook path must never consult these.
//
// `setup()` cannot populate them: plugin-loader.ts builds the bootstrap config
// as a literal `{}` for every install, so the snapshot is always empty. The
// only thing that ever sets them is `onConfigChanged`, which the host fires
// per company without saying which one — so they hold "whichever company saved
// config last". That is fine for a single-company install's escalation sweep
// and actively wrong for authenticating a webhook, which is why deliveries
// re-resolve from their own `companyId` instead.
//
// Deliberately no cached bearer token here: the SDK contract for
// `ctx.secrets.resolve` is that secret values must never be cached, and a
// cached token is exactly what let a worker restart silently disable auth.
// ---------------------------------------------------------------------------

let pluginCtx: PluginContext | null = null;
let pluginConfig: AlertmanagerPluginConfig | null = null;

// ---------------------------------------------------------------------------
// Internal: apply a freshly-resolved config snapshot to the worker's in-memory
// state for the escalation job. Used by onConfigChanged() (operator edits the
// instance config at runtime, no restart required).
// ---------------------------------------------------------------------------

async function applyConfig(
  ctx: PluginContext,
  config: AlertmanagerPluginConfig,
): Promise<void> {
  const previousScope = pluginConfig?.defaultCompanyId ?? null;
  pluginConfig = buildConfig(config);

  if (!pluginConfig.defaultCompanyId) {
    ctx.logger.warn(
      "paperclip-plugin-alertmanager: defaultCompanyId is not configured — incoming alerts will be dropped until it is set",
    );
    return;
  }
  // The escalation sweep runs for exactly one company: whichever one this
  // config names. `onConfigChanged` does not say which company saved, so on a
  // multi-company install a save by tenant B silently moves the sweep off
  // tenant A. Log the transition so that reassignment is observable rather than
  // invisible; the sweep itself stays self-consistent either way, because it
  // reads `defaultCompanyId` out of the very config row it is holding.
  if (previousScope && previousScope !== pluginConfig.defaultCompanyId) {
    ctx.logger.warn(
      `paperclip-plugin-alertmanager: escalation sweep scope moved from company ${previousScope} to ${pluginConfig.defaultCompanyId} — only one company is swept at a time (BLO-20595)`,
    );
  }
}

export const plugin = definePlugin({
  async setup(ctx) {
    pluginCtx = ctx;
    const rawConfig = (await ctx.config.get()) as
      | Record<string, unknown>
      | null
      | undefined;
    if (isEmptyConfig(rawConfig)) {
      // The normal path, on every install: plugin-loader.ts hands the worker a
      // literal `{}`, because plugin config is company-scoped and setup() has
      // no company context. Not a misconfiguration — webhook deliveries resolve
      // their own company's config per request. Only the escalation sweep is
      // affected, and it stays idle until an onConfigChanged supplies a scope.
      ctx.logger.info(
        "paperclip-plugin-alertmanager: bootstrap config is empty (expected — config is company-scoped); webhooks resolve config per delivery",
      );
    } else {
      await applyConfig(ctx, rawConfig as unknown as AlertmanagerPluginConfig);
    }
    ctx.jobs.register("check-alert-escalations", async () => {
      if (!pluginConfig) {
        // Idle until the first onConfigChanged. Deliveries are unaffected —
        // they resolve per request — but escalation ladders do not advance, so
        // say so on every tick instead of no-op'ing silently. Fixing this needs
        // a host API to enumerate a plugin's configured companies, which
        // PluginConfigClient does not expose today (BLO-20595).
        ctx.logger.warn(
          "paperclip-plugin-alertmanager: escalation sweep skipped — no company scope yet (config is company-scoped and setup() receives none); alert escalation ladders are not advancing until an operator saves config (BLO-20595)",
        );
        return;
      }
      await runAlertEscalationSweep(ctx, pluginConfig);
    });
    ctx.logger.info("paperclip-plugin-alertmanager started");
  },

  async onConfigChanged(newConfig) {
    const ctx = pluginCtx;
    if (!ctx) return;
    await applyConfig(ctx, newConfig as unknown as AlertmanagerPluginConfig);
    ctx.logger.info(
      "paperclip-plugin-alertmanager: config reloaded without restart",
    );
  },

  async onWebhook(input: PluginWebhookInput) {
    const ctx = pluginCtx;
    if (!ctx) {
      // Setup has not completed. Transient and self-healing, so surface it as a
      // failed delivery: the host answers 502 and Alertmanager retries once the
      // worker is up. Returning normally would record `success` + HTTP 200 and
      // destroy the alert — the silent-loss failure mode this plugin already
      // suffered a 67-minute outage from (BLO-20467).
      throw new Error(
        "paperclip-plugin-alertmanager: worker setup has not completed; rejecting delivery so Alertmanager retries",
      );
    }
    // Resolve against the company that owns THIS delivery. The setup()
    // snapshot is empty on every instance, and the module globals only ever
    // hold whichever company saved config last — so they are never a safe
    // stand-in for the delivering tenant's credentials.
    //
    // A retryable failure (config RPC error, no stored config) throws
    // CompanyScopeUnavailableError and propagates. `null` means the delivery
    // carried no companyId, which no retry can fix, so it is dropped.
    const scope = await resolveCompanyScope(ctx, input.companyId);
    if (!scope) return;
    await handleWebhook(ctx, scope.config, scope.token, input);
  },

  async onHealth() {
    return { status: "ok" };
  },
});

export default plugin;

// Start the RPC host unconditionally — same rationale as Slack plugin
// (worker.ts:1786–1791): runWorker's argv match is fragile through symlinks.
startWorkerRpcHost({ plugin });
