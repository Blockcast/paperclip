/**
 * Type definitions for paperclip-plugin-alertmanager.
 *
 * Mirrors the structure of `paperclip-plugin-slack/src/types.ts`: a config
 * interface, plus payload types for the foreign system the plugin integrates
 * with (here, the Alertmanager v2 webhook envelope).
 */

import type { PluginIssueOriginKind } from "@paperclipai/shared";

/**
 * Severity levels mapped from `alert.labels.severity` to a Paperclip issue
 * priority. Anything outside this enum falls back to the default priority.
 */
export type AlertSeverity = "critical" | "warning" | "info" | string;

/**
 * Paperclip issue priority values accepted by `ctx.issues.create`. Mirrors
 * the runtime enum on the server. Kept narrow so the severity-to-priority map
 * cannot produce an unsupported value.
 */
export type PaperclipPriority = "critical" | "high" | "medium" | "low";

/**
 * Owner-map config: per-instance mapping from a label-key (e.g. `team`) to a
 * value→email map (e.g. `{ platform: "alice@blockcast.net" }`). Resolution
 * order is defined in §7.7 of the spec.
 */
export type OwnerMap = Record<string, Record<string, string>>;

export type IssueRouteStatus =
  | "backlog"
  | "todo"
  | "in_progress"
  | "in_review"
  | "done"
  | "blocked"
  | "cancelled";

/**
 * Optional Paperclip issue routing fields applied when an alert's labels match
 * a configured label-key/value route.
 */
export interface IssueRoute {
  projectId?: string;
  goalId?: string;
  status?: IssueRouteStatus;
  assigneeAgentId?: string;
  assigneeUserId?: string | null;
  escalationDeadlineMinutes?: number;
}

/**
 * Per-label issue routing map. Shape mirrors ownerMap:
 * `{ class: { physical_infra_bmc: { projectId, goalId, assigneeAgentId }}}`.
 */
export type IssueRouteMap = Record<string, Record<string, IssueRoute>>;

/**
 * Plugin instance config. Validated by the host against the manifest's
 * `instanceConfigSchema` before being passed to the worker.
 */
export interface AlertmanagerPluginConfig {
  /** Company that receives alerts when no company-routing label is present. */
  defaultCompanyId: string;
  /**
    * Secret reference to the static bearer token Alertmanager uses when posting
    * webhooks. The host compares credentials without returning the secret value
    * to the worker.
   */
  webhookTokenRef?: string;
  /**
   * Inline bearer token accepted by the worker-side webhook path. Prefer
   * `webhookTokenRef` for production deployments.
   */
  webhookToken?: string;
  /**
   * If set, only alerts whose labels match all of these key=value pairs are
   * accepted. Use to scope a shared-tenancy AM cluster.
   */
  acceptOnlyLabels?: Record<string, string>;
  /**
   * Map from Alertmanager severity label (e.g. `critical`, `warning`, `info`)
   * to a Paperclip issue priority. Defaults are merged with this map.
   */
  severityToPriority?: Record<string, PaperclipPriority>;
  /**
   * If true or omitted, transitions the issue to status=cancelled when AM sends
   * status=resolved. If false, posts a "resolved at <ts>" comment and leaves
   * status alone.
   */
  autoCloseOnResolve?: boolean;
  /**
   * Per-instance owner map. e.g. `{ team: { platform: "alice@blockcast.net" }}`.
   */
  ownerMap?: OwnerMap;
  /** Exact named agent used when owner and issue-route resolution produce no assignee. */
  fallbackAgentName?: string;
  /**
   * Per-instance issue route map. Matches alert labels and applies project,
   * goal, status, and queue defaults to created issues.
   */
  issueRouteMap?: IssueRouteMap;
  /**
   * How long (hours) an operator-closed issue suppresses re-fires of its
   * fingerprint before the plugin re-opens it anyway (BLO-24234).
   *
   * Closing an alert issue by hand means "stop nagging me about this", so the
   * plugin honours it — but only for a bounded window. Without an expiry the
   * suppression is permanent and silent: the fingerprint is muted forever, and
   * because Alertmanager fingerprints are `hash(sorted(labels))`, a
   * provider-agnostic alert re-uses one fingerprint across every future root
   * cause. One operator closing a noisy issue would mute an unrelated outage
   * months later.
   *
   * Defaults to `DEFAULT_OPERATOR_SUPPRESSION_HOURS`. Set to `0` to suppress
   * indefinitely (the pre-BLO-24234 behaviour) — only safe for alerts you are
   * willing to never hear from again.
   */
  operatorSuppressionHours?: number;
  escalationDeadlineMinutes?: Record<string, number>;
  /**
   * Width (minutes) of the board-cover dedup window (BLO-15982). Concurrent
   * same-alertname escalation ladders that reach the cover rung within the
   * same window bucket share one retained cover instead of each opening
   * their own. Defaults to `DEFAULT_COVER_DEDUP_WINDOW_MINUTES`.
   */
  coverDedupWindowMinutes?: number;
  /**
   * Severities (case-insensitive) that never produce agent-actionable work
   * (BLO-24177). A matching alert's issue is created/kept in a terminal
   * status with no assignee — owner and issue-route resolution are skipped
   * entirely — instead of the normal `todo` + owner-map flow. The row is
   * still created and refreshed on every re-fire, so it stays available as a
   * liveness signal for the delivery path; it just never becomes work an
   * agent or a stranded-issue sweep can pick up. Defaults to
   * `DEFAULT_TERMINAL_SEVERITIES` (`["none"]`, e.g. Prometheus's always-firing
   * `Watchdog` alert).
   */
  terminalSeverities?: string[];
}

// ---------------------------------------------------------------------------
// Alertmanager v2 webhook payload — see spec §5 and Prometheus docs:
// https://prometheus.io/docs/alerting/latest/configuration/#webhook_config
// https://prometheus.io/docs/alerting/latest/notifications/
// ---------------------------------------------------------------------------

/** Alert status as reported by Alertmanager. */
export type AlertmanagerAlertStatus = "firing" | "resolved";

/**
 * One element of the `alerts[]` array in an AM v2 webhook payload.
 *
 * Notes:
 * - `endsAt` is set to `0001-01-01T00:00:00Z` (Go zero time) for firing alerts.
 * - `fingerprint` is `hash(sorted(labels))`; stable across firings of the
 *   same labels, different across pods/nodes.
 */
export interface AlertmanagerAlert {
  status: AlertmanagerAlertStatus;
  labels: Record<string, string>;
  annotations: Record<string, string>;
  startsAt: string;
  endsAt: string;
  generatorURL?: string;
  fingerprint: string;
}

/** Top-level AM v2 webhook envelope. */
export interface AlertmanagerWebhookPayload {
  /** Schema version. Currently always `"4"`. */
  version: string;
  groupKey?: string;
  truncatedAlerts?: number;
  status: AlertmanagerAlertStatus;
  receiver?: string;
  groupLabels?: Record<string, string>;
  commonLabels?: Record<string, string>;
  commonAnnotations?: Record<string, string>;
  externalURL?: string;
  alerts: AlertmanagerAlert[];
}

// ---------------------------------------------------------------------------
// State shapes
// ---------------------------------------------------------------------------

/**
 * Per-fingerprint state row. Lives at `alert:<fingerprint>` in the instance
 * scope. See spec §6.
 */
export interface AlertStateRecord {
  paperclipIssueId: string;
  paperclipCompanyId: string;
  /**
   * Aggregate identity captured when this fingerprint first fired. Routing
   * annotations are mutable, so resolution must not recompute this from a
   * later payload and accidentally act on a different aggregate.
   */
  aggregateKey?: string;
  assigneeUserId: string | null;
  /**
   * Set when ownerMap routes to an agent via the `agent:<id>` value syntax.
   * Mutually exclusive with `assigneeUserId` — at most one is non-null.
   */
  assigneeAgentId: string | null;
  alertname: string;
  severity: string;
  firstSeenAt: string;
  lastFiredAt: string;
  resolvedAt: string | null;
  /**
   * When the plugin FIRST saw this fingerprint re-fire against an issue that
   * an operator (not the plugin) had closed — i.e. terminal status with no
   * `resolvedAt` (BLO-24234). Anchors the `operatorSuppressionHours` window.
   *
   * Cleared whenever the issue is observed open again, so a close/re-open
   * cycle restarts the window rather than carrying a stale anchor forward.
   * Optional: rows written before BLO-24234 do not have it, and `undefined`
   * is treated as "suppression starts now".
   */
  operatorSuppressedAt?: string | null;
  nextEscalationAt?: string | null;
  escalationAttempt?: number;
  escalationComplete?: boolean;
  /**
   * Deadline interval captured at firing time (route/severity-resolved).
   * Each ladder rung re-arms by this much — the route override is not
   * recomputable in the sweep because alert labels are not persisted.
   */
  escalationIntervalMs?: number | null;
  /**
   * BLO-29908: set when a resolve arrived while a run held the issue's
   * execution lock, so the auto-cancel was withheld rather than evicting that
   * run. Names the holding run; null once a resolve cancels cleanly.
   *
   * Diagnostic, not control state — nothing reconciles off it. It exists so
   * that "this row is open even though its alert cleared" is answerable from
   * the state row instead of only from the issue thread.
   */
  cancelWithheldForRunId?: string | null;
  cancelWithheldAt?: string | null;
}

/**
 * Origin kind tag we stamp onto created issues. Plugin-namespaced so that
 * future Paperclip features (e.g. inbox grouping) can recognize alerts.
 */
export const ORIGIN_KIND: PluginIssueOriginKind =
  "plugin:paperclip-plugin-alertmanager";

/**
 * Reserved annotation keys rendered as drill-in links. Keys not in this list
 * are NOT rendered as links — see spec §7.6 "Why a fixed key allowlist".
 */
export interface ObservabilityUrls {
  dashboard_url?: string;
  trace_url?: string;
  profile_url?: string;
  logs_url?: string;
  flow_query_url?: string;
  runbook_url?: string;
  generator_url?: string;
}

/**
 * Result of the owner-resolution pipeline (§7.7). Carries the email OR
 * the agentId that matched (so the caller can log it) plus which step
 * produced it. `email` and `agentId` are mutually exclusive — at most one
 * is set on any non-`no-match` resolution.
 *
 * ownerMap values prefixed with `agent:<uuid>` (case-insensitive prefix)
 * resolve to `agentId` and bypass the `users.findByEmail` cache lookup.
 * Plain email values resolve to `email` and follow the original §7.7
 * email → user-id flow.
 */
export interface OwnerResolution {
  email: string | null;
  agentId: string | null;
  source:
    | "label-override"
    | "owner-map"
    | "annotation-override"
    | "no-match";
}
