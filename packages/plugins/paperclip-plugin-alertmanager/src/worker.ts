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
import { handleWebhook, reconcileAbandonedAggregateFences } from "./webhook-handler.js";
import { runAlertEscalationSweep } from "./escalation.js";
import {
  authenticateWebhook,
  CompanyScopeUnavailableError,
  resolveCompanyScope,
  resolveEscalationSweepConfig,
} from "./config-scope.js";
import { getCredentialHealth } from "./credential-health.js";
import {
  handleRecoveryApiRequest,
  registerRecoveryAction,
} from "./recovery-action.js";

let pluginCtx: PluginContext | null = null;

export const plugin = definePlugin({
  async setup(ctx) {
    pluginCtx = ctx;
    registerRecoveryAction(ctx);
    // Release aggregate lifecycle fences abandoned by a previous occupant of
    // this slot (BLO-31036). A firing delivery claims the fence and releases it
    // in a `finally`, so only death of the owning process between the two can
    // leave it held — which is what every rollout does. Those fences then
    // refuse each subsequent firing delivery for their aggregate indefinitely,
    // and before this sweep the only drain was an operator-only recovery route
    // that needs the dead process's token.
    //
    // Awaited before the escalation job registers so the sweep cannot interleave
    // with a resolve that claims finalization. It cannot disturb a live delivery
    // regardless: it only releases fences whose owner is not this process.
    await reconcileAbandonedAggregateFences(ctx);
    ctx.jobs.register("check-alert-escalations", async (job: PluginJobContext) => {
      const companyId = job.companyId;
      if (!companyId) {
        // The scheduler dispatches once per configured company. An
        // instance-scoped dispatch therefore means the registry returned an
        // empty set, which cannot run this company-scoped sweep safely.
        throw new CompanyScopeUnavailableError(
          "paperclip-plugin-alertmanager: escalation sweep cannot run without a company scope",
        );
      }
      const config = await resolveEscalationSweepConfig(ctx, companyId);
      if (!config) {
        throw new CompanyScopeUnavailableError(
          `paperclip-plugin-alertmanager: escalation sweep cannot run for company ${companyId} — no matching stored config`,
        );
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
    const authenticated = await authenticateWebhook(ctx, scope.config, input);
    await handleWebhook(ctx, scope.config, authenticated, input);
  },

  async onApiRequest(input) {
    const ctx = pluginCtx;
    if (!ctx) {
      return {
        status: 503,
        body: { error: "Alertmanager recovery API is not ready" },
      };
    }
    return handleRecoveryApiRequest(ctx, input);
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
