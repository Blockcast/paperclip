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
  type PluginJobContext,
  type PluginWebhookInput,
} from "@paperclipai/plugin-sdk";
import { handleWebhook } from "./webhook-handler.js";
import { runAlertEscalationSweep } from "./escalation.js";
import {
  resolveCompanyScope,
  resolveEscalationSweepConfig,
} from "./config-scope.js";
import { getCredentialHealth } from "./credential-health.js";

let pluginCtx: PluginContext | null = null;

export const plugin = definePlugin({
  async setup(ctx) {
    pluginCtx = ctx;
    ctx.jobs.register("check-alert-escalations", async (job: PluginJobContext) => {
      const companyId = job.companyId;
      if (!companyId) {
        // The host dispatches once per company configured for this plugin
        // (BLO-20957) — on the scheduled path *and* on manual/retry "run
        // now" triggers, both of which fan out per company and stamp
        // `job.companyId`. So this branch no longer fires for a normal
        // trigger; it means the plugin has zero configured companies (a
        // successful empty enumeration), which for an escalation sweep is
        // genuinely nothing to do. Warn rather than no-op silently so the
        // "configured nowhere" case is still visible.
        ctx.logger.warn(
          "paperclip-plugin-alertmanager: escalation sweep skipped — dispatch carried no company scope (plugin has no configured companies)",
        );
        return;
      }
      const config = await resolveEscalationSweepConfig(ctx, companyId);
      if (!config) {
        ctx.logger.warn(
          `paperclip-plugin-alertmanager: escalation sweep skipped for company ${companyId} — no stored config`,
        );
        return;
      }
      await runAlertEscalationSweep(ctx, config);
    });
    ctx.logger.info("paperclip-plugin-alertmanager started");
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
    // Resolve against the company that owns THIS delivery — never a cached
    // snapshot. `setup()` always receives an empty bootstrap config (config
    // is company-scoped), so there is nothing safe to cache here anyway.
    //
    // A retryable failure (config RPC error, no stored config) throws
    // CompanyScopeUnavailableError and propagates. `null` means the delivery
    // carried no companyId, which no retry can fix, so it is dropped.
    const scope = await resolveCompanyScope(ctx, input.companyId);
    if (!scope) return;
    await handleWebhook(ctx, scope.config, scope.token, input);
  },

  async onHealth() {
    // Derived from observed delivery outcomes, not a config probe: this
    // method has no company scope (BLO-20572), so it cannot enumerate
    // configured companies and pre-check their tokens.
    return getCredentialHealth();
  },
});

export default plugin;

// Start the RPC host unconditionally — same rationale as Slack plugin
// (worker.ts:1786–1791): runWorker's argv match is fragile through symlinks.
startWorkerRpcHost({ plugin });
