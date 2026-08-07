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
  configChangedRequiresRestart,
  resolveCompanyScope,
  resolveSweepScope,
} from "./config-scope.js";

// ---------------------------------------------------------------------------
// Module-level worker state
//
// Deliberately just the context. There is NO cached config and NO cached
// bearer token, and both omissions are load-bearing:
//
//  - A config snapshot here could only ever come from `onConfigChanged`, which
//    the host fires per company without saying which one — so it would hold
//    "whichever company saved config last" and be empty until the first save
//    after every restart. Both readers now derive their own scope instead: a
//    webhook from its delivery's `companyId`, the escalation sweep from the
//    host's invocation scope. Keeping no global is what makes that structural
//    rather than a convention someone can quietly read around.
//  - The SDK contract for `ctx.secrets.resolve` is that secret values must
//    never be cached, and a cached token is exactly what let a worker restart
//    silently disable auth for every company (BLO-20467).
// ---------------------------------------------------------------------------

let pluginCtx: PluginContext | null = null;

export const plugin = definePlugin({
  async setup(ctx) {
    pluginCtx = ctx;
    // Deliberately no config read here. Before `initialize` completes, an
    // unscoped `ctx.config.get()` returns the bootstrap snapshot, which
    // `plugin-loader.ts` builds as a literal `{}` on every install because
    // plugin config is company-scoped and `setup()` has no company context.
    // Reading it produced only misleading "not configured" warnings while the
    // stored config was perfectly fine (BLO-20467). Both real readers resolve
    // their own scope at call time instead.
    ctx.jobs.register("check-alert-escalations", async () => {
      // Scope comes from the host's invocation scope, resolved per tick — not
      // from a config snapshot captured at setup or at the last save. See
      // `resolveSweepScope` for why that is the only correct source, and for
      // the multi-company limitation it surfaces (BLO-20595).
      const config = await resolveSweepScope(ctx);
      if (!config) return; // resolveSweepScope logged the reason
      await runAlertEscalationSweep(ctx, config);
    });
    ctx.logger.info("paperclip-plugin-alertmanager started");
  },

  async onConfigChanged() {
    // Deliberately fails with METHOD_NOT_IMPLEMENTED so the host restarts this
    // worker (`server/src/routes/plugins.ts` → `lifecycle.restartWorker`).
    //
    // Nothing here needs a live update — no config is cached in this worker, so
    // the delivery path already sees this edit. The restart is for the one
    // thing this worker CANNOT refresh in place: the escalation sweep's company
    // scope, frozen into `bootstrapCompanyId` when the worker spawned. Only a
    // restart recomputes it, so a `0 -> 1`, `1 -> 2`, or `2 -> 1` change in
    // configured companies would otherwise leave the sweep running against a
    // scope that no longer matches the config.
    //
    // Returning normally — as this hook used to — is what suppresses that
    // restart, and so is not the harmless no-op it reads as. See
    // `configChangedRequiresRestart` for the full mechanism.
    pluginCtx?.logger.info(
      "paperclip-plugin-alertmanager: config changed; requesting a worker restart so the escalation sweep's company scope is recomputed",
    );
    throw configChangedRequiresRestart();
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
