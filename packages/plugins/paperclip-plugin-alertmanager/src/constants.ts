import type {
  AlertmanagerPluginConfig,
  IssueRouteMap,
  OwnerMap,
  PaperclipPriority,
} from "./types.js";

export const PLUGIN_ID = "paperclip-plugin-alertmanager";
export const PLUGIN_VERSION = "0.2.0";

export const WEBHOOK_KEYS = {
  alertmanager: "alertmanager",
} as const;

export const STATE_KEYS = {
  /** Per-fingerprint dedup row. See spec §6. */
  alert: (fingerprint: string) => `alert:${fingerprint}`,
  /** Per-email cached Paperclip user id (positive cache). Empty string = negative cache. */
  ownerByEmail: (email: string) => `owner-by-email:${email}`,
  /** Mirror of config.ownerMap — editable from UI without re-deploying. */
  ownerMap: "owner-map",
} as const;

/**
 * Scope key for a fingerprint's dedup row (BLO-20467).
 *
 * Scoped to the company the tracked issue lives in, NOT `instance`. Alertmanager
 * fingerprints are derived from alert labels, so two independent tenants running
 * the same alert rules routinely produce the *same* fingerprint. Under the old
 * instance scope those collided in one namespace: a firing delivery for company
 * B would find company A's record and update/re-open A's issue instead of
 * creating B's, and a B resolution would close A's issue.
 *
 * `companyId` here is the company the issue is filed into — the same
 * `config.defaultCompanyId` that `recoverStateFromIssue` and the escalation
 * sweep already use as their tenant boundary. Keying on it keeps the module
 * internally consistent: everything that can reach a record can also construct
 * its scope. Each tenant resolves it from its own config row, so one tenant
 * cannot address another's namespace.
 */
export function alertStateRef(companyId: string, fingerprint: string) {
  return {
    scopeKind: "company" as const,
    scopeId: companyId,
    stateKey: STATE_KEYS.alert(fingerprint),
  };
}

/**
 * Pre-BLO-20467 location of the same row: instance scope, shared by every
 * tenant. Read only to migrate a record into its owning company's scope, and
 * only when the record itself says it belongs to that company.
 */
export function legacyInstanceAlertStateRef(fingerprint: string) {
  return {
    scopeKind: "instance" as const,
    stateKey: STATE_KEYS.alert(fingerprint),
  };
}

/**
 * Default severity → priority map. Operators can override via
 * `config.severityToPriority`.
 */
export const DEFAULT_SEVERITY_TO_PRIORITY: Record<string, PaperclipPriority> = {
  critical: "critical",
  warning: "high",
  info: "medium",
  // BLO-27018: `page` and `ticket` are the severity vocabulary the Blockcast
  // Prometheus rule groups actually emit (`llm-proxy.alerts` and friends), and
  // neither was mapped here. An unmapped severity silently falls back to
  // FALLBACK_PRIORITY, so every `severity=page` alert — the highest urgency
  // this fleet has — was being filed as `medium`.
  page: "critical",
  ticket: "low",
};

export const DEFAULT_ESCALATION_DEADLINE_MINUTES: Record<string, number> = {
  critical: 30,
  warning: 240,
  // BLO-27018: this omission disabled the escalation ladder outright for the
  // fleet's highest severity. `escalationDeadlineMs` returns null for an
  // unmapped severity, the webhook handler then stores `nextEscalationAt:
  // null`, and the per-minute sweep early-returns on that field forever. The
  // net effect: the "no agent owner at all → board cover" safety net in
  // escalation.ts could never fire for a `page` alert. Measured on BLO-25023 —
  // unassigned and comment-free for 4 days while firing.
  page: 30,
  // `ticket` is deliberately absent: it is the low-urgency severity, so it
  // keeps the null deadline (no ladder) rather than paging a chain.
};

/**
 * Default width of the board-cover dedup window (BLO-15982). Concurrent or
 * near-simultaneous escalation ladders for the same alertname that reach the
 * cover rung within the same window bucket land on one retained cover
 * instead of one each. Operators can override via
 * `config.coverDedupWindowMinutes`.
 */
export const DEFAULT_COVER_DEDUP_WINDOW_MINUTES = 120;

/**
 * Platform / SRE lane owner for Blockcast observability alerts. Its charter is
 * "triages and closes every alertmanager-origin alert", which is precisely the
 * `team: devops` rule groups below.
 */
export const BLOCKCAST_PLATFORM_SRE_AGENT_ID =
  "d6f327a4-f2f2-4a83-bc5a-173d993cf9b6";

/** Default owner routes shipped with the bundled Blockcast Alertmanager plugin. */
export const DEFAULT_OWNER_MAP: OwnerMap = {
  class: {
    paperclip_claude_k8s: "support@blockcast.net",
    // BLO-10699: byte-usage watermark alert on the shared `paperclip-data`
    // CephFS PVC (PaperclipDataVolumeNearlyFull/Critical). Routes to support
    // so a filling shared HOME is owned, not unassigned.
    paperclip_data_volume: "support@blockcast.net",
    // BLO-12202: physical infrastructure alert classes. Keep the shipped
    // default broad so fresh installs route to the operational support queue;
    // instance ownerMap config can override any class to a narrower queue.
    physical_infra_proxmox: "support@blockcast.net",
    physical_infra_ceph: "support@blockcast.net",
    physical_infra_bmc: "support@blockcast.net",
    physical_infra_disk: "support@blockcast.net",
  },
  // BLO-27018: every route above keys on `class`, a label the observability
  // rule groups do not emit at all — so `resolveOwnerEmail` iterated one key,
  // found no `class` label, and returned `no-match` for every alert those
  // groups produce. They were filed unassigned, which is why a ~24h penstock
  // outage (BLO-27008) generated alerts nobody was ever woken for.
  //
  // Scoped deliberately to `team: devops` (4 alerts firing at time of writing)
  // and NOT `team: platform` (53 firing — 44 of them warnings). Routing that
  // second group by default would bury the lane's attended-WIP budget in one
  // sweep; it needs its own sizing decision, not a default.
  team: {
    devops: `agent:${BLOCKCAST_PLATFORM_SRE_AGENT_ID}`,
  },
};

export const BLOCKCAST_PHYSICAL_INFRA_PROJECT_ID =
  "9a6f627e-0f16-4b46-acc1-811acd1f548e";
export const BLOCKCAST_PHYSICAL_INFRA_GOAL_ID =
  "94c9f942-7067-4fde-a313-b3ee30d72f70";
export const BLOCKCAST_PHYSICAL_INFRA_AGENT_ID =
  "d2ade02d-112c-4da2-b61f-2301254a154c";

/** Default project/agent routes for Blockcast physical infrastructure alerts. */
export const DEFAULT_ISSUE_ROUTE_MAP: IssueRouteMap = {
  class: {
    physical_infra_proxmox: {
      projectId: BLOCKCAST_PHYSICAL_INFRA_PROJECT_ID,
      goalId: BLOCKCAST_PHYSICAL_INFRA_GOAL_ID,
      assigneeAgentId: BLOCKCAST_PHYSICAL_INFRA_AGENT_ID,
      status: "todo",
    },
    physical_infra_ceph: {
      projectId: BLOCKCAST_PHYSICAL_INFRA_PROJECT_ID,
      goalId: BLOCKCAST_PHYSICAL_INFRA_GOAL_ID,
      assigneeAgentId: BLOCKCAST_PHYSICAL_INFRA_AGENT_ID,
      status: "todo",
    },
    physical_infra_bmc: {
      projectId: BLOCKCAST_PHYSICAL_INFRA_PROJECT_ID,
      goalId: BLOCKCAST_PHYSICAL_INFRA_GOAL_ID,
      assigneeAgentId: BLOCKCAST_PHYSICAL_INFRA_AGENT_ID,
      status: "todo",
    },
    physical_infra_disk: {
      projectId: BLOCKCAST_PHYSICAL_INFRA_PROJECT_ID,
      goalId: BLOCKCAST_PHYSICAL_INFRA_GOAL_ID,
      assigneeAgentId: BLOCKCAST_PHYSICAL_INFRA_AGENT_ID,
      status: "todo",
    },
    // BLO-15219: 2026-07-11 prod incident — daemonset pods joining a node
    // produced 7 simultaneous PodPendingCritical alerts that self-healed by
    // ~15:35Z, but the critical default (30m/rung) walked the ladder to the
    // CEO in 90 minutes. pod_pending's noise profile is churn-then-self-heal,
    // not a real outage signal, so it gets a slower rung than the critical
    // default.
    pod_pending: {
      projectId: BLOCKCAST_PHYSICAL_INFRA_PROJECT_ID,
      goalId: BLOCKCAST_PHYSICAL_INFRA_GOAL_ID,
      assigneeAgentId: BLOCKCAST_PHYSICAL_INFRA_AGENT_ID,
      status: "todo",
      escalationDeadlineMinutes: 240,
    },
    pod_init_stuck: {
      projectId: BLOCKCAST_PHYSICAL_INFRA_PROJECT_ID,
      goalId: BLOCKCAST_PHYSICAL_INFRA_GOAL_ID,
      assigneeAgentId: BLOCKCAST_PHYSICAL_INFRA_AGENT_ID,
      status: "todo",
    },
    pod_crashloop: {
      projectId: BLOCKCAST_PHYSICAL_INFRA_PROJECT_ID,
      goalId: BLOCKCAST_PHYSICAL_INFRA_GOAL_ID,
      assigneeAgentId: BLOCKCAST_PHYSICAL_INFRA_AGENT_ID,
      status: "todo",
    },
    pod_create_error: {
      projectId: BLOCKCAST_PHYSICAL_INFRA_PROJECT_ID,
      goalId: BLOCKCAST_PHYSICAL_INFRA_GOAL_ID,
      assigneeAgentId: BLOCKCAST_PHYSICAL_INFRA_AGENT_ID,
      status: "todo",
    },
    pod_config_error: {
      projectId: BLOCKCAST_PHYSICAL_INFRA_PROJECT_ID,
      goalId: BLOCKCAST_PHYSICAL_INFRA_GOAL_ID,
      assigneeAgentId: BLOCKCAST_PHYSICAL_INFRA_AGENT_ID,
      status: "todo",
    },
    pod_image_pull: {
      projectId: BLOCKCAST_PHYSICAL_INFRA_PROJECT_ID,
      goalId: BLOCKCAST_PHYSICAL_INFRA_GOAL_ID,
      assigneeAgentId: BLOCKCAST_PHYSICAL_INFRA_AGENT_ID,
      status: "todo",
    },
  },
};

/** Fallback priority when severity is unknown / unmapped. */
export const FALLBACK_PRIORITY: PaperclipPriority = "medium";

/**
 * Reserved annotation keys treated as drill-in URLs. See spec §7.6 — order
 * here is the rendered order in the issue body.
 */
export const OBSERVABILITY_URL_KEYS = [
  "dashboard_url",
  "trace_url",
  "profile_url",
  "logs_url",
  "flow_query_url",
  "runbook_url",
  "generator_url",
] as const;

/**
 * Human-readable labels for each drill-in URL key.
 */
export const OBSERVABILITY_URL_LABELS: Record<
  (typeof OBSERVABILITY_URL_KEYS)[number],
  string
> = {
  dashboard_url: "Dashboard",
  trace_url: "Tempo trace",
  profile_url: "Pyroscope flamegraph",
  logs_url: "Loki / journal logs",
  flow_query_url: "Hubble flow query",
  runbook_url: "Runbook",
  generator_url: "Source query in Prometheus",
};

/**
 * Label key on an alert that overrides owner resolution. See §7.7 step 1.
 */
export const ASSIGNEE_OVERRIDE_LABEL = "paperclip_assignee_email";
/** Annotation equivalent of the override label. §7.7 step 3. */
export const ASSIGNEE_OVERRIDE_ANNOTATION = "paperclip_assignee_email";

/**
 * Default plugin config. Used as the schema default in the manifest and as a
 * test-harness baseline.
 */
export const DEFAULT_CONFIG: AlertmanagerPluginConfig = {
  defaultCompanyId: "",
  webhookTokenRef: "",
  webhookToken: "",
  acceptOnlyLabels: {},
  severityToPriority: DEFAULT_SEVERITY_TO_PRIORITY,
  autoCloseOnResolve: true,
  ownerMap: DEFAULT_OWNER_MAP,
  issueRouteMap: DEFAULT_ISSUE_ROUTE_MAP,
  escalationDeadlineMinutes: DEFAULT_ESCALATION_DEADLINE_MINUTES,
  coverDedupWindowMinutes: DEFAULT_COVER_DEDUP_WINDOW_MINUTES,
};

/**
 * Schema versions of the AM v2 envelope this plugin accepts. Anything else is
 * logged + dropped so a poison payload doesn't back up Alertmanager's queue.
 */
export const ACCEPTED_SCHEMA_VERSIONS = new Set(["4"]);
