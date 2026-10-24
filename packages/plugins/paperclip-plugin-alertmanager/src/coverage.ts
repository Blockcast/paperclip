import type { PluginContext } from "@paperclipai/plugin-sdk";
import { aggregateKeyForAlert } from "./aggregate-key.js";
import { alertStateRef } from "./constants.js";
import { resolveAlertmanagerApiUrl } from "./escalation.js";
import { isTerminalSeverity } from "./issue-mapping.js";
import { routedTo } from "./reconcile.js";
import type { AlertmanagerAlert, AlertmanagerPluginConfig, AlertStateRecord } from "./types.js";
import { DEFAULT_RECONCILE_RECEIVERS } from "./types.js";
import { decideRefire, findActiveAggregateIssue } from "./webhook-handler.js";

/**
 * BLO-40673 AC4 — "an Alertmanager alert is active and nothing open tracks it"
 * is itself alertable.
 *
 * The failure this exists for is silent by construction: a cancelled row reads
 * exactly like a resolved alert on every triage surface, so 20 live alerts (two
 * critical) sat untracked for up to 33 days with nothing anywhere saying so.
 *
 * Keyed on the plugin's OWN past decision to file, not on a re-implementation
 * of the exemption rules (info floor, `paperclip_issue=false`, label filters,
 * routing). Those live in separate branches of `webhook-handler.ts`, and a copy
 * would drift the next time any of them changes. A fingerprint with no state
 * record is one the plugin never decided to file — exempt here, and a delivery
 * that never arrived is `AlertmanagerWebhookNotificationsFailing`'s job.
 *
 * The verdict for a terminal row is `decideRefire` itself, the function the
 * webhook uses, so this check and the re-fire path cannot disagree about
 * whether a closed row ought to be open: an operator close inside its
 * suppression window is exempt; `reopen` / `issue_missing` is the gap.
 *
 * Known limit: an operator-closed row whose state record carries no
 * suppression anchor stays exempt, because `decideRefire` says so. That is the
 * webhook's own verdict, so this check reports it the same way.
 */

/** Once per this many minutes — well inside one Alertmanager `repeat_interval` (1h). */
export const COVERAGE_CHECK_EVERY_MINUTES = 15;
const READ_TIMEOUT_MS = 10_000;

/**
 * BLO-48332 — a firing episode younger than one Alertmanager notification
 * cycle (group_wait 30s + group_interval 5m, plus webhook handling) may simply
 * not have been delivered yet, so its closed row is in flight to reopen, not
 * stranded. Measured 2026-10-22: re-fires reopened at the next 5m group flush
 * (06:06:25 -> 06:10:27), and the 06:00:16 pass flagged one 51s after its
 * startsAt. With many flapping fingerprints under one alertname, two such
 * races on consecutive passes paged the per-alertname rule. A young alert is
 * judged on the next pass instead; one whose reopen genuinely failed keeps its
 * startsAt and is flagged then.
 */
export const IN_FLIGHT_GRACE_MS = 6 * 60_000; // ponytail: hard-coded to the AM route timings; read them if they change

/** `/api/v2/alerts` shape: `status` is an object there, not the webhook's string. */
type AmAlert = Omit<AlertmanagerAlert, "status"> & { status?: { state?: string }; receivers?: unknown };

export type CoverageVerdict = "covered" | "exempt" | "uncovered";

export async function classifyAlertCoverage(
  ctx: PluginContext,
  companyId: string,
  alert: AmAlert,
  config: AlertmanagerPluginConfig,
  now: Date,
): Promise<CoverageVerdict> {
  // Terminal severities are routed straight to `done` by design (BLO-24177).
  if (isTerminalSeverity(alert.labels.severity)) return "exempt";
  // BLO-48499 — an alert re-routed away from this company's receivers (e.g. to
  // `blackhole`) is never delivered, so its last row is closed by design. Same
  // receiver set the reconcile backfill uses (default ["paperclip"], BLO-48574).
  const receivers = new Set(config.reconcileReceivers ?? DEFAULT_RECONCILE_RECEIVERS);
  // Unknown routing (no `receivers` on the read) never exempts: fail loud.
  if (receivers.size > 0 && Array.isArray(alert.receivers) && !routedTo(alert, receivers)) return "exempt";
  if (now.getTime() - Date.parse(alert.startsAt ?? "") < IN_FLIGHT_GRACE_MS) return "exempt";
  const record = (await ctx.state.get(alertStateRef(companyId, alert.fingerprint))) as AlertStateRecord | null;
  if (!record?.paperclipIssueId) return "exempt";
  const issue = await ctx.issues.get(record.paperclipIssueId, companyId);
  if (issue && issue.status !== "done" && issue.status !== "cancelled") return "covered";
  // Aggregate-aware: one open row covers every member fingerprint, and only
  // one of them is its `originId` — keying on that gave false positives.
  const aggregateKey = record.aggregateKey ?? aggregateKeyForAlert({ ...alert, annotations: alert.annotations ?? {}, status: "firing" });
  if (await findActiveAggregateIssue(ctx, companyId, aggregateKey)) return "covered";
  const decision = decideRefire(issue, record, config, now.getTime());
  return decision.kind === "suppressed" ? "exempt" : "uncovered";
}

/**
 * Reads EVERY active alert, unfiltered. Unlike the liveness read this cannot
 * fail open to "nothing firing": a failed read returns `null` and the caller
 * skips the pass, so `uncovered` is never emitted off a read that did not land.
 */
async function readActiveAlerts(config: AlertmanagerPluginConfig, logger: PluginContext["logger"]): Promise<AmAlert[] | null> {
  // Same resolver as the escalation ladder: config first, then the host's
  // PAPERCLIP_ALERTMANAGER_API_URL default. Reading config alone left this
  // detector inert in production, where only the env default is set.
  const base = resolveAlertmanagerApiUrl(config);
  if (!base || !["http:", "https:"].includes(URL.parse(base)?.protocol ?? "")) {
    logger.warn("alert-coverage: no usable alertmanagerApiUrl, skipping this pass");
    return null;
  }
  try {
    // Global fetch, not ctx.http: the host's SSRF guard refuses the
    // cluster-internal ClusterIP (see readAlertLiveness in escalation.ts).
    // Suppressed (inhibited/silenced) alerts are never delivered, so they are
    // exempt by construction — read `active` only.
    const res = await fetch(`${base}/api/v2/alerts?active=true&silenced=false&inhibited=false`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body: unknown = await res.json();
    if (!Array.isArray(body)) throw new Error("non-array body");
    return body.filter((a: AmAlert) => typeof a?.fingerprint === "string" && a.labels
      && a.status?.state === "active");
  } catch (err) {
    logger.warn(`alert-coverage: Alertmanager read failed, skipping this pass: ${String(err)}`);
    return null;
  }
}

export async function runCoverageCheck(
  ctx: PluginContext,
  config: AlertmanagerPluginConfig,
  now = new Date(),
  readAlerts: typeof readActiveAlerts = readActiveAlerts,
): Promise<void> {
  const companyId = config.defaultCompanyId;
  if (!companyId || now.getUTCMinutes() % COVERAGE_CHECK_EVERY_MINUTES !== 0) return;
  const alerts = await readAlerts(config, ctx.logger);
  if (!alerts) return;
  // Keyed on alertname AND severity: one rule with severity tiers must not
  // file its critical count under whichever tier was seen first.
  const uncovered = new Map<string, { alertname: string; severity: string; count: number }>();
  for (const alert of alerts) {
    let verdict: CoverageVerdict;
    try {
      verdict = await classifyAlertCoverage(ctx, companyId, alert, config, now);
    } catch (err) {
      // Unknown is not "covered": abandon the pass rather than under-report.
      ctx.logger.warn(`alert-coverage: could not classify ${alert.fingerprint}, skipping this pass: ${String(err)}`);
      return;
    }
    if (verdict !== "uncovered") continue;
    const alertname = alert.labels.alertname ?? "UnnamedAlert";
    const severity = alert.labels.severity ?? "";
    const key = JSON.stringify([alertname, severity]);
    const entry = uncovered.get(key) ?? { alertname, severity, count: 0 };
    entry.count += 1;
    uncovered.set(key, entry);
    ctx.logger.warn(`alert-coverage: ${alertname} (${alert.fingerprint}) is active with no open tracking row`);
  }
  for (const { alertname, severity, count } of uncovered.values()) {
    await ctx.metrics.write("alertmanager.coverage.uncovered", count, { alertname, severity });
  }
  // Heartbeat: written only after a completed pass, so a dead or failing
  // detector reads as missing data, never as health.
  await ctx.metrics.write("alertmanager.coverage.checked", 1);
}
