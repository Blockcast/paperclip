/**
 * Pure functions that turn an Alertmanager v2 alert into the title,
 * description, priority, and drill-in link block we hand to
 * `ctx.issues.create`.
 *
 * These functions are intentionally side-effect-free so they can be unit
 * tested without spinning up a plugin context or mocking the host RPC.
 */

import { ISSUE_PRIORITIES } from "@paperclipai/shared";
import {
  DEFAULT_SEVERITY_TO_PRIORITY,
  TERMINAL_SEVERITIES,
  FALLBACK_PRIORITY,
  OBSERVABILITY_URL_KEYS,
  OBSERVABILITY_URL_LABELS,
} from "./constants.js";
import type {
  AlertmanagerAlert,
  AlertmanagerWebhookPayload,
  ObservabilityUrls,
  PaperclipPriority,
} from "./types.js";

/**
 * Map an alert's severity label to a Paperclip priority value.
 *
 * Resolution order:
 *   1. operator override map (`severityToPriority`)
 *   2. built-in default map (`DEFAULT_SEVERITY_TO_PRIORITY`)
 *   3. `FALLBACK_PRIORITY` ("medium")
 *
 * Severities are matched case-insensitively against the keys of both maps.
 */
export function severityToPriority(
  severity: string | undefined,
  override?: Record<string, PaperclipPriority>,
): PaperclipPriority {
  if (!severity) return FALLBACK_PRIORITY;
  const key = severity.trim().toLowerCase();
  if (!key) return FALLBACK_PRIORITY;
  if (override && key in override) {
    const value = override[key];
    if (value !== undefined) return value;
  }
  if (key in DEFAULT_SEVERITY_TO_PRIORITY) {
    const value = DEFAULT_SEVERITY_TO_PRIORITY[key];
    if (value !== undefined) return value;
  }
  return FALLBACK_PRIORITY;
}

/**
 * Outcome of resolving one alert's issue priority.
 *
 * `ignoredLabel` is set when a `paperclip_priority` label was present but
 * unusable, so the caller — which holds `ctx`, unlike this module — can warn
 * and emit a metric. Without it a typo (`hgih`) is indistinguishable from an
 * absent label: the rule author believes they opted back up and nothing
 * anywhere records that they did not.
 */
export interface ResolvedAlertPriority {
  priority: PaperclipPriority;
  /** Raw label value when present but unusable; `undefined` when honoured or absent. */
  ignoredLabel?: string;
}

/**
 * Resolve the issue priority for one alert.
 *
 * Resolution order:
 *   1. the `paperclip_priority` alert label (per-rule escape hatch, BLO-20576)
 *   2. `severityToPriority` above (operator override map, then the default map)
 *
 * The label is the escape hatch for the `warning → medium` default: a rule
 * whose warnings genuinely are not self-resolving declares that on itself,
 * next to its own `severity`, rather than dragging the whole severity band up
 * with it. It is validated against `ISSUE_PRIORITIES` and ignored when it is
 * anything else — an unrecognised value must not reach `ctx.issues.create`
 * and fail the whole delivery, and a `PrometheusRule` is not a trusted enough
 * surface to pass straight through to the API.
 *
 * The label is read as `unknown`: `isAlertmanagerPayload` deliberately does
 * not validate label entries (see its docstring), so a YAML `paperclip_priority: 5`
 * arrives as a number at runtime despite the declared `Record<string, string>`.
 * Calling a string method on it would throw a `TypeError` — not a
 * `PermanentAlertError` — which fails the whole batch and makes Alertmanager
 * redeliver into the same deterministic crash until the alert is lost. Mirrors
 * the `paperclip_issue` guard in `webhook-handler.ts`.
 *
 * A whitespace-only label is treated as absent, not as a typo: Prometheus drops
 * empty labels, so warning on one would be noise about a value nobody set.
 */
export function resolveAlertPriority(
  alert: AlertmanagerAlert,
  override?: Record<string, PaperclipPriority>,
): ResolvedAlertPriority {
  // `?? "unknown"` is load-bearing: it is the key `severityToPriority` matches
  // an operator's `severityToPriority: { unknown: … }` entry against. Passing
  // the raw label would short-circuit on `!severity` and never consult it.
  const priority = severityToPriority(
    alert.labels.severity ?? "unknown",
    override,
  );
  const raw: unknown = alert.labels.paperclip_priority;
  if (raw === undefined) return { priority };
  if (typeof raw !== "string") {
    return { priority, ignoredLabel: `<non-string ${typeof raw}>` };
  }
  const key = raw.trim().toLowerCase();
  if (!key) return { priority };
  if ((ISSUE_PRIORITIES as readonly string[]).includes(key)) {
    return { priority: key as PaperclipPriority };
  }
  return { priority, ignoredLabel: raw };
}

/**
 * Whether an alert's severity (BLO-24177) is one that must never become
 * agent-actionable work — e.g. `none`, the convention for Prometheus's
 * always-firing `Watchdog` dead-man's-switch heartbeat. Case-insensitive,
 * matched against `TERMINAL_SEVERITIES`, which is deliberately a constant
 * rather than a config key (see its docstring).
 *
 * Pure and side-effect-free like `severityToPriority` above, so the webhook
 * handler can decide — before doing any owner/route resolution or issue
 * creation — whether this alert should land in a terminal status instead of
 * the normal `todo` + assignee flow.
 */
export function isTerminalSeverity(severity: string | undefined): boolean {
  if (!severity) return false;
  const key = severity.trim().toLowerCase();
  if (!key) return false;
  return TERMINAL_SEVERITIES.some((entry) => entry.trim().toLowerCase() === key);
}

/**
 * Build the issue title per spec §7.1:
 *   `[<severity>] <alertname>  ·  <commonLabels.team or node or "">`
 *
 * Trailing-context segment is omitted (with the separator) when neither
 * team nor node is present, so we don't end up with a stray `·`.
 */
export function buildIssueTitle(
  alert: AlertmanagerAlert,
  envelope?: Pick<AlertmanagerWebhookPayload, "commonLabels">,
): string {
  const severity = alert.labels.severity ?? "unknown";
  const alertname = alert.labels.alertname ?? "UnnamedAlert";
  const commonLabels = envelope?.commonLabels ?? {};
  const context =
    alert.labels.team ??
    alert.labels.node ??
    commonLabels.team ??
    commonLabels.node ??
    "";
  const head = `[${severity}] ${alertname}`;
  return context ? `${head} · ${context}` : head;
}

/**
 * Pull observability URLs (the reserved annotation keys from §7.6) off an
 * alert. Unknown `*_url` annotation keys are NOT included — surface them by
 * logging if you want to spot gaps.
 */
export function extractObservabilityUrls(
  alert: AlertmanagerAlert,
): ObservabilityUrls {
  const out: ObservabilityUrls = {};
  for (const key of OBSERVABILITY_URL_KEYS) {
    if (key === "generator_url") {
      // generator_url is sourced from `alert.generatorURL`, not an annotation.
      if (alert.generatorURL) out[key] = alert.generatorURL;
      continue;
    }
    const value = alert.annotations[key];
    if (typeof value === "string" && value.length > 0) {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Render the drill-in section of the issue body.
 *
 * Empty input → returns `""` (caller is expected to skip rendering the
 * section header in that case).
 */
export function renderDrillInLinks(urls: ObservabilityUrls): string {
  const lines: string[] = [];
  for (const key of OBSERVABILITY_URL_KEYS) {
    const url = urls[key];
    if (!url) continue;
    lines.push(`- [${OBSERVABILITY_URL_LABELS[key]}](${url})`);
  }
  if (lines.length === 0) return "";
  return ["### Drill in", ...lines].join("\n");
}

/**
 * Render the labels table per spec §7.2. Sorted by key for stable output.
 */
function renderLabelsTable(labels: Record<string, string>): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return "_(no labels)_";
  const rows = keys.map((k) => `| ${k} | ${labels[k]} |`);
  return ["| key | value |", "|-----|-------|", ...rows].join("\n");
}

/**
 * Build the full issue description (markdown body) per spec §7.2 + §7.6.
 *
 * Layout:
 *
 *   **Summary**: <annotations.summary or alertname>
 *
 *   <annotations.description>
 *
 *   **Started**: <startsAt>
 *   **Severity**: <severity>
 *   **Source**: <generatorURL>
 *   **Runbook**: <annotations.runbook_url or "—">
 *
 *   ### Labels
 *   | key | value |
 *   ...
 *
 *   ### Drill in
 *   - [Dashboard](...)
 *   ...
 */
export function buildIssueDescription(alert: AlertmanagerAlert): string {
  const summary =
    alert.annotations.summary ??
    alert.labels.alertname ??
    "Alert firing";
  const description = alert.annotations.description ?? "";
  const severity = alert.labels.severity ?? "unknown";
  const source = alert.generatorURL ?? "—";
  const runbook = alert.annotations.runbook_url ?? "—";

  const sections: string[] = [];
  sections.push(`**Summary**: ${summary}`);
  if (description) sections.push(description);
  sections.push(
    [
      `**Started**: ${alert.startsAt}`,
      `**Severity**: ${severity}`,
      `**Source**: ${source}`,
      `**Runbook**: ${runbook}`,
    ].join("\n"),
  );
  sections.push(`### Labels\n${renderLabelsTable(alert.labels)}`);

  const drillIn = renderDrillInLinks(extractObservabilityUrls(alert));
  if (drillIn) sections.push(drillIn);

  return sections.join("\n\n");
}

/**
 * `acceptOnlyLabels` filter (§5.2 step 4). All key=value pairs in `filter`
 * must be present and equal on `alert.labels` for the alert to be accepted.
 * Empty/unset `filter` means accept-all.
 */
export function alertMatchesLabelFilter(
  alert: AlertmanagerAlert,
  filter: Record<string, string> | undefined,
): boolean {
  if (!filter) return true;
  const keys = Object.keys(filter);
  if (keys.length === 0) return true;
  for (const key of keys) {
    if (alert.labels[key] !== filter[key]) return false;
  }
  return true;
}

/**
 * Effective alert status per §5.2 step 4: prefer the per-alert status, fall
 * back to the envelope status if missing.
 */
export function effectiveAlertStatus(
  alert: AlertmanagerAlert,
  envelope: Pick<AlertmanagerWebhookPayload, "status">,
): "firing" | "resolved" {
  return alert.status ?? envelope.status;
}
