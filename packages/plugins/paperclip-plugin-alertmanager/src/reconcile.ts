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
import { handleWebhook, parseMemberSnapshot, readAlertState } from "./webhook-handler.js";
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
  status?: { state?: unknown };
}

export interface ReconcileResult {
  /** Why the pass did nothing, when it did nothing by design. */
  skipped?: string;
  /** Active alerts routed to this company's receivers. */
  routed: number;
  /** Alerts handed to the push path this pass. */
  backfilled: string[];
  /** BLO-51097: tracked fingerprints Alertmanager no longer holds, resolved this pass. */
  resolved?: string[];
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

  // Read EVERYTHING Alertmanager holds, silenced and inhibited included: the
  // resolve pass below must treat a suppressed alert as still held, since it is
  // still firing. The backfill skips suppressed alerts itself, because
  // Alertmanager never notifies them and the push path would not have filed them.
  const res = await fetch(`${base}/api/v2/alerts?active=true&silenced=true&inhibited=true`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(ALERTMANAGER_READ_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Alertmanager returned HTTP ${res.status}`);
  const body: unknown = await res.json();
  if (!Array.isArray(body)) throw new Error("Alertmanager returned a non-array body");

  const cutoff = now.getTime() - RECONCILE_GRACE_MS;
  let routed = 0;
  const missing: AlertmanagerAlert[] = [];
  const held = new Set<string>();
  for (const entry of body as ActiveApiAlert[]) {
    if (typeof entry.fingerprint === "string") held.add(entry.fingerprint);
  }
  for (const entry of body as ActiveApiAlert[]) {
    if (entry.status?.state === "suppressed") continue;
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
  const resolved = await reconcileLostResolves(ctx, config, companyId, held, now);
  return { routed, backfilled: missing.map((a) => a.fingerprint), resolved };
}

/**
 * fingerprint -> first pass (ms) that found it tracked-unresolved but not held
 * by Alertmanager. In-memory on purpose: a worker restart only delays a resolve
 * by one grace window, never causes a wrong one.
 */
const absentSince = new Map<string, number>();

/** Test hook: forget absence observations between cases. */
export function __resetLostResolveObservationsForTests(): void {
  absentSince.clear();
}

/**
 * BLO-51097 — the reverse of the backfill: an alert that RESOLVED while its
 * resolve delivery was lost (control-plane restart, Alertmanager gave up
 * retrying). Its member row still reads unresolved, its issue stays open, and
 * no later delivery will ever arrive. On 2026-10-31 that stranded ~220 rows.
 *
 * Candidates are the aggregate member rows still marked unresolved; one is
 * resolved only when Alertmanager holds no alert with its fingerprint on two
 * passes at least RECONCILE_GRACE_MS apart. A single empty read is not enough:
 * an Alertmanager restart briefly holds nothing, and acting on that would
 * cancel every open alert row at once. Prometheus re-sends live alerts within
 * a minute or two, far inside the grace window.
 *
 * The resolve goes through `handleWebhook` exactly as a delivery would, so
 * aggregate fences, sibling deferral, the execution-lock guard and the
 * `pluginClosedAt` stamp all apply unchanged.
 *
 * ponytail: assumes the queried Alertmanager is the only one delivering to this
 * plugin (true today: the tools-cluster Alertmanager routes to null receivers).
 * A second delivering Alertmanager would need its own read here first, or its
 * alerts would be resolved as "not held". Legacy state rows with no member row
 * are not enumerated; they still resolve on a real delivery.
 */
async function reconcileLostResolves(
  ctx: PluginContext,
  config: AlertmanagerPluginConfig,
  companyId: string,
  held: Set<string>,
  now: Date,
): Promise<string[]> {
  const rows = await ctx.db.query<{ fingerprint: string; alert_snapshot: Record<string, unknown> | string | null }>(
    `SELECT fingerprint, alert_snapshot
       FROM ${ctx.db.namespace}.alertmanager_aggregate_members
      WHERE company_id = $1 AND resolved_at IS NULL AND NOT (fingerprint = ANY($2::text[]))
      ORDER BY updated_at ASC, fingerprint ASC`,
    [companyId, [...held]],
  );
  const nowMs = now.getTime();
  const candidates = new Set(rows.map((r) => r.fingerprint));
  for (const fp of absentSince.keys()) if (!candidates.has(fp)) absentSince.delete(fp);

  const lost: AlertmanagerAlert[] = [];
  const endsAt = now.toISOString();
  for (const row of rows) {
    const firstAbsent = absentSince.get(row.fingerprint);
    if (firstAbsent === undefined) {
      absentSince.set(row.fingerprint, nowMs);
      continue;
    }
    if (nowMs - firstAbsent < RECONCILE_GRACE_MS) continue;
    const snap = parseMemberSnapshot(row.fingerprint, row.alert_snapshot);
    lost.push({
      status: "resolved",
      fingerprint: row.fingerprint,
      labels: snap?.labels ?? { alertname: "UnnamedAlert" },
      annotations: snap?.annotations ?? {},
      startsAt: snap?.startsAt || endsAt,
      endsAt,
    });
    if (lost.length >= RECONCILE_MAX_PER_PASS) break;
  }
  if (lost.length === 0) return [];

  ctx.logger.warn(
    `paperclip-plugin-alertmanager: reconciler resolving ${lost.length} tracked alert(s) Alertmanager no longer holds (resolve delivery lost): ${lost
      .map((a) => `${a.labels.alertname ?? "unknown"} (${a.fingerprint})`)
      .join(", ")}`,
  );
  // Throws AlertDeliveryIncompleteError if any resolve failed (e.g. a held
  // aggregate fence); those keep their absence mark and retry next pass.
  await handleWebhook(ctx, config, true, {
    endpointKey: WEBHOOK_KEYS.alertmanager,
    companyId,
    parsedBody: {
      version: "4",
      status: "resolved",
      receiver: "paperclip-plugin-alertmanager/reconcile",
      alerts: lost,
    } satisfies AlertmanagerWebhookPayload,
  } as unknown as PluginWebhookInput);
  for (const a of lost) absentSince.delete(a.fingerprint);
  try {
    await ctx.metrics.write("alertmanager.reconcile.resolved", lost.length);
  } catch (err) {
    ctx.logger.error(`paperclip-plugin-alertmanager: failed to record reconcile metric: ${String(err)}`);
  }
  return lost.map((a) => a.fingerprint);
}
