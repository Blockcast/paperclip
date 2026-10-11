/**
 * Pure functions that turn an Alertmanager v2 alert into the title,
 * description, priority, and drill-in link block we hand to
 * `ctx.issues.create`.
 *
 * These functions are intentionally side-effect-free so they can be unit
 * tested without spinning up a plugin context or mocking the host RPC.
 */

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
 *
 * `startedAtAnchor` (BLO-42850) overrides the rendered **Started** with the
 * aggregate row's own start instead of this alert's. Pass it for anything
 * rendered onto an aggregate row; omit it and the alert's own `startsAt` is
 * used, which is the pre-BLO-42850 behaviour and the right answer for a
 * single-subject preview. When the two differ, the alert's own `startsAt` is
 * still rendered, as **Latest firing**.
 */
export function buildIssueDescription(
  alert: AlertmanagerAlert,
  startedAtAnchor?: string | null,
): string {
  const summary =
    alert.annotations.summary ??
    alert.labels.alertname ??
    "Alert firing";
  const description = alert.annotations.description ?? "";
  const severity = alert.labels.severity ?? "unknown";
  const source = alert.generatorURL ?? "—";
  const runbook = alert.annotations.runbook_url ?? "—";
  const startedAt = startedAtAnchor || alert.startsAt;

  const sections: string[] = [];
  sections.push(`**Summary**: ${summary}`);
  if (description) sections.push(description);
  sections.push(
    [
      `**Started**: ${startedAt}`,
      // Only when the anchor has diverged from this firing — i.e. the row has
      // been tracking its aggregate since before the episode now in the body.
      // Deliberately a separate field from **Started**: this one is allowed to
      // move backwards (a later-joining member can carry an earlier
      // `startsAt`), which is exactly why it must not be the anchor.
      ...(startedAt === alert.startsAt ? [] : [`**Latest firing**: ${alert.startsAt}`]),
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
 * One active member of an aggregate row, as stored by `upsertAggregateMember`.
 *
 * `alert` is null for a member written before migration 006 added the snapshot
 * column. Such a member is still listed — it is a real firing alert and hiding
 * it would reintroduce the invisibility this exists to fix — just with nothing
 * but its fingerprint to show. It re-acquires a snapshot on its next firing
 * delivery.
 */
export interface AggregateMemberSubject {
  fingerprint: string;
  alert: AlertmanagerAlert | null;
}

/**
 * Label keys whose value is not the same across every snapshotted member.
 *
 * These are what actually tell two members of one aggregate apart. The shared
 * ones (`alertname`, usually `severity`) are already in the representative's
 * labels table above, and repeating them per row would bury the one column that
 * carries information.
 */
function varyingLabelKeys(members: AggregateMemberSubject[]): string[] {
  const seen = new Map<string, Set<string>>();
  for (const member of members) {
    if (!member.alert) continue;
    for (const [key, value] of Object.entries(member.alert.labels)) {
      const values = seen.get(key) ?? new Set<string>();
      values.add(value);
      seen.set(key, values);
    }
  }
  return [...seen.entries()]
    .filter(([, values]) => values.size > 1)
    .map(([key]) => key)
    .sort();
}

/** One member's distinguishing text for the active-members table. */
function memberSubject(
  member: AggregateMemberSubject,
  varyingKeys: string[],
): string {
  const alert = member.alert;
  if (!alert) return "_(no snapshot yet — will appear on its next firing)_";
  const varying = varyingKeys
    .map((key) => (alert.labels[key] ? `${key}=${alert.labels[key]}` : null))
    .filter((pair): pair is string => pair !== null);
  if (varying.length > 0) return varying.join(", ");
  return (
    alert.annotations.summary ??
    alert.labels.alertname ??
    "_(no distinguishing labels)_"
  );
}

/**
 * BLO-42850 — render an aggregate row's body from its *active* members.
 *
 * The row is an aggregate of N Alertmanager fingerprints and is cancelled only
 * when its last member resolves. Before this, the body was whatever single
 * alert wrote last, which made three things false at once: the body named a
 * different alert than `originId`, **Started** moved in whichever direction the
 * last writer pointed, and the other members were invisible. The resolve path
 * did not refresh the body at all, so a row could keep naming a *cleared* alert
 * while its siblings fired — and the documented triage protocol, falsifying the
 * named alert against Alertmanager, then produced a wrong close
 * ([BLO-41538](https://paperclip.blockcast.net/BLO/issues/BLO-41538)).
 *
 * Route taken is (a) from the ticket — render the members — not (b), refusing
 * foreign body writes. (b) is ~3 lines and no migration, but it cannot satisfy
 * AC3: once the creating member resolves, the body is pinned to a cleared alert
 * forever, which is the wrong-close failure made permanent rather than removed.
 *
 * Contract, in the order the acceptance criteria state it:
 *
 *   1. Every active member is named. `members` must be the active set only, so
 *      a resolved member cannot be the representative.
 *   2. **Started** comes from `startedAtAnchor`, which the caller reads from the
 *      oldest-joined member's immutable `first_seen_starts_at`. Immutable means
 *      non-decreasing by construction, not by comparison.
 *   3. Callers refresh on resolve as well as on fire, so a surviving sibling
 *      becomes the representative the moment the named one clears.
 *
 * Returns `null` when no member carries a snapshot — pre-migration rows, before
 * their first re-fire. The caller keeps the existing body rather than replacing
 * it with a fingerprint list that is strictly less useful than what is there.
 */
export function buildAggregateIssueDescription(
  members: AggregateMemberSubject[],
  startedAtAnchor?: string | null,
): string | null {
  // First *snapshotted* member in join order. Join order is stable (nothing
  // deletes member rows, and a re-fire preserves `created_at`), so the
  // representative only ever changes when it resolves or a snapshot lands.
  const representative = members.find((member) => member.alert)?.alert;
  if (!representative) return null;
  const body = buildIssueDescription(representative, startedAtAnchor);
  if (members.length < 2) return body;

  const varyingKeys = varyingLabelKeys(members);
  const rows = members.map((member) => {
    const startsAt = member.alert?.startsAt ?? "—";
    const severity = member.alert?.labels.severity ?? "—";
    return `| \`${member.fingerprint}\` | ${startsAt} | ${severity} | ${memberSubject(member, varyingKeys)} |`;
  });
  return [
    body,
    [
      `### Active members (${members.length})`,
      "",
      "This issue is an aggregate: it tracks **every** currently-firing alert" +
        " listed below, and is closed only when the last of them resolves. The" +
        " block above describes the first of them — it is a representative, not" +
        " the whole subject of this row. Falsify every fingerprint here before" +
        " closing, not just the one named above.",
      "",
      "| fingerprint | started | severity | subject |",
      "|-------------|---------|----------|---------|",
      ...rows,
    ].join("\n"),
  ].join("\n\n");
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
