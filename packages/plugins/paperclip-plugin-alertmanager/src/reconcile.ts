/**
 * BLO-44820 — backfill alerts whose webhook delivery was lost.
 *
 * Alertmanager webhooks become issues only through this plugin, which runs
 * inside the control plane it reports on. While that control plane is down,
 * Alertmanager retries a delivery and then drops it, and nothing re-sends it
 * unless the alert group changes. An alert that fires during the outage and
 * stays active therefore never becomes an issue.
 *
 * This pass PULLS the alerts Alertmanager still holds active and feeds any that
 * have no state row through `handleWebhook` exactly as a delivery would. That
 * keeps every rule of the push path — label filter, `paperclip_issue` opt-out,
 * severity floor, aggregate fence, per-fingerprint (`originId`) dedupe — in one
 * place instead of a second copy that drifts.
 */

import type { PluginContext, PluginWebhookInput } from "@paperclipai/plugin-sdk";
import { WEBHOOK_KEYS } from "./constants.js";
import { ALERTMANAGER_READ_TIMEOUT_MS, resolveAlertmanagerApiUrl } from "./escalation.js";
import { alertMatchesLabelFilter } from "./issue-mapping.js";
import { handleWebhook, readAlertState } from "./webhook-handler.js";
import type {
  AlertmanagerAlert,
  AlertmanagerPluginConfig,
  AlertmanagerWebhookPayload,
} from "./types.js";

/**
 * An alert younger than this is left to the push path. Alertmanager's own
 * first delivery (group_wait + retries) lands well inside it, so a healthy
 * pipeline never sees the reconciler file anything — and the pass cannot race
 * a delivery that is merely in flight.
 */
export const RECONCILE_GRACE_MS = 10 * 60_000;

/**
 * Upper bound on alerts backfilled per pass. Recovery from an outage is
 * exactly when the API is least able to absorb a burst (BLO-43851 was a crash
 * loop driven by webhook retry load), so a large backlog drains over several
 * passes instead of in one.
 */
export const RECONCILE_MAX_PER_PASS = 25;

interface ActiveApiAlert {
  fingerprint?: unknown;
  labels?: unknown;
  annotations?: unknown;
  startsAt?: unknown;
  endsAt?: unknown;
  generatorURL?: unknown;
  receivers?: unknown;
}

export interface ReconcileResult {
  /** Why the pass did nothing, when it did nothing by design. */
  skipped?: string;
  /** Active alerts routed to this company's receivers. */
  routed: number;
  /** Alerts handed to the push path this pass. */
  backfilled: string[];
}

export function toWebhookAlert(entry: ActiveApiAlert): AlertmanagerAlert | null {
  if (typeof entry.fingerprint !== "string" || typeof entry.startsAt !== "string") return null;
  if (!entry.labels || typeof entry.labels !== "object") return null;
  return {
    status: "firing",
    fingerprint: entry.fingerprint,
    labels: entry.labels as Record<string, string>,
    annotations:
      entry.annotations && typeof entry.annotations === "object"
        ? (entry.annotations as Record<string, string>)
        : {},
    startsAt: entry.startsAt,
    endsAt: typeof entry.endsAt === "string" ? entry.endsAt : "0001-01-01T00:00:00Z",
    ...(typeof entry.generatorURL === "string" ? { generatorURL: entry.generatorURL } : {}),
  };
}

export function routedTo(entry: { receivers?: unknown }, receivers: Set<string>): boolean {
  if (!Array.isArray(entry.receivers)) return false;
  return entry.receivers.some(
    (r) => typeof (r as { name?: unknown })?.name === "string" && receivers.has((r as { name: string }).name),
  );
}

/**
 * Creation-only policy the push path applies before filing. Checked here too so
 * an alert that will never get a state row (opted out, filtered, below the
 * floor) is not re-submitted — and re-counted in the delivery metrics — on
 * every pass.
 */
function wouldFile(alert: AlertmanagerAlert, config: AlertmanagerPluginConfig): boolean {
  if (!alertMatchesLabelFilter(alert, config.acceptOnlyLabels)) return false;
  const optedOut = [alert.labels.paperclip_issue, alert.annotations.paperclip_issue].some(
    (v) => typeof v === "string" && v.trim().toLowerCase() === "false",
  );
  if (optedOut) return false;
  return (alert.labels.severity ?? "").trim().toLowerCase() !== "info";
}

export async function reconcileActiveAlerts(
  ctx: PluginContext,
  config: AlertmanagerPluginConfig,
  now: Date = new Date(),
): Promise<ReconcileResult> {
  const receivers = new Set((config.reconcileReceivers ?? []).filter((r) => typeof r === "string" && r));
  const base = resolveAlertmanagerApiUrl(config);
  const companyId = config.defaultCompanyId;
  if (receivers.size === 0) return { skipped: "no reconcileReceivers configured", routed: 0, backfilled: [] };
  if (!base || !["http:", "https:"].includes(URL.parse(base)?.protocol ?? "")) {
    return { skipped: "alertmanagerApiUrl is not an http(s) URL", routed: 0, backfilled: [] };
  }
  if (!companyId) return { skipped: "no defaultCompanyId", routed: 0, backfilled: [] };

  // Silenced and inhibited alerts are excluded: Alertmanager never notifies
  // them, so the push path would not have filed them either.
  const res = await fetch(`${base}/api/v2/alerts?active=true&silenced=false&inhibited=false`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(ALERTMANAGER_READ_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Alertmanager returned HTTP ${res.status}`);
  const body: unknown = await res.json();
  if (!Array.isArray(body)) throw new Error("Alertmanager returned a non-array body");

  const cutoff = now.getTime() - RECONCILE_GRACE_MS;
  let routed = 0;
  const missing: AlertmanagerAlert[] = [];
  for (const entry of body as ActiveApiAlert[]) {
    if (!routedTo(entry, receivers)) continue;
    routed += 1;
    const alert = toWebhookAlert(entry);
    if (!alert || !(Date.parse(alert.startsAt) <= cutoff) || !wouldFile(alert, config)) continue;
    const { record } = await readAlertState(ctx, companyId, alert.fingerprint);
    // Tracked and not resolved: nothing was lost. A record resolved BEFORE this
    // occurrence started is a re-fire whose delivery was lost; one resolved
    // after it is the push path being ahead of this read, so leave it.
    if (record && !(record.resolvedAt && Date.parse(record.resolvedAt) < Date.parse(alert.startsAt))) continue;
    missing.push(alert);
    if (missing.length >= RECONCILE_MAX_PER_PASS) break;
  }

  if (missing.length > 0) {
    const payload: AlertmanagerWebhookPayload = {
      version: "4",
      status: "firing",
      receiver: "paperclip-plugin-alertmanager/reconcile",
      alerts: missing,
    };
    ctx.logger.warn(
      `paperclip-plugin-alertmanager: reconciler backfilling ${missing.length} active alert(s) with no delivered webhook: ${missing
        .map((a) => `${a.labels.alertname ?? "unknown"} (${a.fingerprint})`)
        .join(", ")}`,
    );
    // Throws AlertDeliveryIncompleteError on a transient failure, which fails
    // the job run; the next pass retries whatever is still missing.
    await handleWebhook(ctx, config, true, {
      endpointKey: WEBHOOK_KEYS.alertmanager,
      companyId,
      parsedBody: payload,
    } as unknown as PluginWebhookInput);
    try {
      await ctx.metrics.write("alertmanager.reconcile.backfilled", missing.length);
    } catch (err) {
      ctx.logger.error(`paperclip-plugin-alertmanager: failed to record reconcile metric: ${String(err)}`);
    }
  }
  return { routed, backfilled: missing.map((a) => a.fingerprint) };
}
