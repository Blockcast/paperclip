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
  resolveWebhookToken,
} from "./config-scope.js";
import type { AlertmanagerPluginConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Module-level worker state
//
// `setup()` populates these once at startup; the escalation job reads them.
//
// These are a SINGLE-COMPANY snapshot and the webhook path must not rely on
// them. The host hands the worker an empty bootstrap config whenever more than
// one company has configured this plugin (see plugin-loader.ts — "multiple
// company configs; legacy bootstrap scope disabled"), so on a multi-company
// instance `setup()` resolves nothing and these stay null. Webhook deliveries
// carry their own `companyId` and re-resolve per request instead.
// ---------------------------------------------------------------------------

let pluginCtx: PluginContext | null = null;
let pluginConfig: AlertmanagerPluginConfig | null = null;
/** Resolved bearer token, kept in memory only — never written to state. */
let resolvedWebhookToken: string | null = null;

// ---------------------------------------------------------------------------
// Internal: apply a freshly-resolved config snapshot to the worker's in-memory
// state. Used by both setup() (first start) and onConfigChanged() (operator
// edits the instance config at runtime, no restart required).
// ---------------------------------------------------------------------------

async function applyConfig(
  ctx: PluginContext,
  config: AlertmanagerPluginConfig,
): Promise<void> {
  pluginConfig = buildConfig(config);

  if (!pluginConfig.defaultCompanyId) {
    ctx.logger.warn(
      "paperclip-plugin-alertmanager: defaultCompanyId is not configured — incoming alerts will be dropped until it is set",
    );
  }

  resolvedWebhookToken = await resolveWebhookToken(ctx, pluginConfig);
}

export const plugin = definePlugin({
  async setup(ctx) {
    pluginCtx = ctx;
    const rawConfig = (await ctx.config.get()) as
      | Record<string, unknown>
      | null
      | undefined;
    if (isEmptyConfig(rawConfig)) {
      // Expected on multi-company instances: the host withholds the legacy
      // bootstrap scope, so there is no single config to snapshot. Webhook
      // deliveries resolve per-company; only the escalation sweep is affected.
      ctx.logger.info(
        "paperclip-plugin-alertmanager: no bootstrap-scoped config (multi-company instance) — webhooks resolve config per delivery; the escalation sweep stays idle until a single-company scope exists",
      );
    } else {
      await applyConfig(ctx, rawConfig as unknown as AlertmanagerPluginConfig);
    }
    ctx.jobs.register("check-alert-escalations", async () => {
      if (pluginConfig) await runAlertEscalationSweep(ctx, pluginConfig);
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
      // Setup hasn't completed — bail safely instead of throwing so AM
      // doesn't see a 500 and retry storm us.
      return;
    }
    // Resolve against the company that owns THIS delivery. The setup()
    // snapshot is empty on multi-company instances, so trusting it here
    // rejects every request with "unauthorized" until someone re-saves
    // config — and again after the next restart.
    const scope = await resolveCompanyScope(
      ctx,
      input.companyId,
      pluginConfig,
      resolvedWebhookToken,
    );
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
