/**
 * @fileoverview Control-plane Prometheus exposition (BLO-8328).
 *
 * Owns the process-local prom-client registry and the
 * `claude_k8s_concurrent_run_blocked_total{agent_id,reason,isolation_mode}`
 * counter. The source event (a `claude_k8s` dispatch refusal) lives in the
 * adapter lane; this module is the D2 platform substrate that ingests those
 * increments and exposes them on `/metrics` so Prometheus can scrape them
 * centrally (see BLO-4296 for the lane split).
 *
 * Cardinality guardrail: all three labels are bounded before they ever reach
 * the registry. `reason` is coerced to a fixed allow-list, `isolation_mode` to
 * the {@link KNOWN_ISOLATION_MODES} allow-list (else "unknown"), and `agent_id`
 * to "unknown" unless it is a member of the caller-supplied active agent
 * roster. Worst-case series count is therefore
 * `(roster_size + 1) * (KNOWN_BLOCKED_REASONS.length + 1) * (KNOWN_ISOLATION_MODES.length + 1)`
 * — bounded by the company's agent count, never by attacker- or typo-supplied
 * ids.
 *
 * @module server/services/metrics
 */

import { Counter, Gauge, Registry, collectDefaultMetrics } from "prom-client";
import { resetDepBlockedMetrics, snapshotDepBlockedMetrics } from "./dep-blocked-metrics.js";
import {
  resetBlockerResolvedWakeMetrics,
  snapshotBlockerResolvedWakeMetrics,
} from "./blocker-resolved-wake-metrics.js";

export const CONCURRENT_RUN_BLOCKED_METRIC = "claude_k8s_concurrent_run_blocked_total";
export const AUTH_REQUEST_METRIC = "paperclip_auth_request_total";
export const HEARTBEAT_RUN_FAILED_METRIC = "paperclip_heartbeat_run_failed_total";
export const DEP_BLOCKED_WAKEUP_METRIC = "paperclip_dependency_blocked_wakeup_total";
/**
 * Outcome counter for blocker-resolved dependent wakes (BLO-13250). Labeled
 * only by `outcome` (mirrors {@link DEP_BLOCKED_WAKEUP_METRIC}'s snapshot
 * style — see blocker-resolved-wake-metrics.ts for the full outcome list).
 * A sustained non-zero `*_skipped`/`*_failed` rate means dependents whose
 * blockers just resolved are not being woken, i.e. they will sit `blocked`
 * with a fully-resolved `blockedBy` set until the periodic sweep or an
 * operator intervenes.
 */
export const BLOCKER_RESOLVED_WAKEUP_METRIC = "paperclip_blocker_resolved_wakeup_total";
/**
 * Isolated concurrent starts counter (BLO-12212/BLO-12505). Incremented when a
 * K8s adapter run is dispatched under an isolated workspace/session descriptor
 * (i.e. NOT blocked). Paired with {@link CONCURRENT_RUN_BLOCKED_METRIC} so an
 * operator can read the isolated-start vs shared-mode-block ratio directly.
 */
export const ISOLATED_RUN_STARTED_METRIC = "paperclip_k8s_isolated_run_started_total";
/**
 * ccrotate-capacity dispatch deferral counter (BLO-12953). Incremented once per
 * heartbeat tick denied by the penstock availability gate (i.e. the gate returns
 * `allow: false` because all model capacity is unavailable). The run outcome
 * after the counter fires varies by call site: fresh-wakeup path persists a
 * `scheduled_retry`; re-deferral-at-promotion path may cancel the run if the
 * retry budget is exhausted.
 *
 * A sustained rate on this counter means the fleet is stalled behind quota
 * exhaustion and no work is progressing. Alert threshold: any non-zero rate
 * sustained over >5 min warrants operator attention.
 *
 * Labels: `adapter` (agent adapter type, e.g. "claude_k8s"), `provider`
 * (penstock provider, e.g. "anthropic"). In practice only `claude_k8s` agents
 * reach the penstock gate, so cardinality on `adapter` is effectively 1.
 * Unknown/empty values collapse to "unknown" to guard against future changes.
 */
export const CCROTATE_CAPACITY_DEFERRED_METRIC = "paperclip_ccrotate_capacity_deferred_total";
export const AGENT_NO_USAGE_STREAK_METRIC = "paperclip_agent_zero_token_completed_run_streak";
export const EXTERNAL_RUNTIME_RESERVATION_EVENTS_METRIC = "paperclip_external_runtime_reservation_events_total";
export const EXTERNAL_RUNTIME_RESERVATIONS_ACTIVE_METRIC = "paperclip_external_runtime_reservations_active";
export const EXTERNAL_RUNTIME_RESERVATION_OLDEST_AGE_METRIC = "paperclip_external_runtime_reservation_oldest_age_seconds";
/**
 * process_lost reap counter (BLO-16184, parent BLO-12292). Incremented once at
 * the reaper's `process_lost` mint, labeled by bounded `adapter`
 * (claude_k8s/opencode_k8s/other), `error_bucket` (the fixed reaper failure
 * string collapsed to a category), and `classification` (the durable
 * resultJson.processLoss bucket added in BLO-16181). This is the NUMERATOR of
 * the trigger monitor: warn >20/day, page >40/day sustained 2h. Worst-case
 * series = 3 adapters x 5 buckets x 6 classifications = 90, roster-independent.
 */
export const PROCESS_LOST_TOTAL_METRIC = "paperclip_process_lost_total";
/**
 * External-lifecycle running-run volume gauge (BLO-16184 DENOMINATOR #1). Set
 * every reap cycle from the live `activeRuns` snapshot, reset-then-set so a
 * genuine drop to 0 is written explicitly rather than going stale. A
 * `process_lost`-count of 0 is only trustworthy as "healthy" when this gauge is
 * above a floor — otherwise the 0 just means there were no external runs to lose.
 */
export const EXTERNAL_LIFECYCLE_RUNNING_RUNS_METRIC = "paperclip_external_lifecycle_running_runs";
/**
 * Kube-liveness-null counter (BLO-16184 DENOMINATOR #2). Incremented once per
 * reap cycle when the reaper had external-lifecycle candidates but
 * `listAgentJobRunStatuses()` returned null (kube API unavailable) — the exact
 * degradation the data-plane review flagged as previously unobservable (only a
 * `logger.warn` existed). A rising rate means the reaper is flying blind, so any
 * concurrent low `process_lost` count is UNRELIABLE, not healthy.
 */
export const PROCESS_LOST_LIVENESS_NULL_METRIC = "paperclip_process_lost_liveness_null_total";
/**
 * Orphaned-managed-pod reap counter (BLO-16850). Incremented once per pod
 * force-deleted by the orphaned-managed-pod sweep in reapOrphanedRuns — a
 * still-Running external-lifecycle agent pod whose heartbeat run has finalized
 * (terminal/absent) with no live Job. Labeled by bounded `adapter`
 * (claude_k8s/opencode_k8s/other). A sustained rate means runs are finalizing
 * while their pods keep running (the wedged-container leak this reaper closes).
 */
export const ORPHANED_MANAGED_POD_REAPED_METRIC = "paperclip_orphaned_managed_pod_reaped_total";

export const KNOWN_AUTH_OPERATIONS = [
  "oidc_start",
  "oidc_callback",
  "password_sign_in",
  "password_sign_up",
  "other",
] as const;
export const KNOWN_AUTH_OUTCOMES = [
  "success",
  "rate_limited",
  "client_error",
  "server_error",
] as const;
export type AuthOperation = (typeof KNOWN_AUTH_OPERATIONS)[number];
export type AuthOutcome = (typeof KNOWN_AUTH_OUTCOMES)[number];

const knownAuthOperationSet: ReadonlySet<string> = new Set(KNOWN_AUTH_OPERATIONS);
const knownAuthOutcomeSet: ReadonlySet<string> = new Set(KNOWN_AUTH_OUTCOMES);
const oidcServerErrorRedirectCodes: ReadonlySet<string> = new Set([
  "internal_server_error",
  "oauth_code_verification_failed",
  "user_info_is_missing",
]);

export function normalizeAuthOperation(operation: string | null | undefined): AuthOperation {
  return typeof operation === "string" && knownAuthOperationSet.has(operation)
    ? operation as AuthOperation
    : "other";
}

export function normalizeAuthOutcome(outcome: string | null | undefined): AuthOutcome {
  return typeof outcome === "string" && knownAuthOutcomeSet.has(outcome)
    ? outcome as AuthOutcome
    : "server_error";
}

export function classifyAuthOperation(requestUrl: string): AuthOperation {
  const pathname = requestUrl.split("?", 1)[0]?.replace(/\/+$/, "") ?? "";
  if (pathname.endsWith("/sign-in/oauth2")) return "oidc_start";
  if (/\/(?:oauth2\/callback|callback)\/[^/]+$/.test(pathname)) return "oidc_callback";
  if (pathname.endsWith("/sign-in/email")) return "password_sign_in";
  if (pathname.endsWith("/sign-up/email")) return "password_sign_up";
  return "other";
}

export function classifyAuthOutcome(statusCode: number): AuthOutcome {
  if (statusCode === 429) return "rate_limited";
  if (statusCode >= 500) return "server_error";
  if (statusCode >= 400) return "client_error";
  return "success";
}

export function classifyAuthResponse(input: {
  operation: AuthOperation;
  statusCode: number;
  location?: string | string[] | undefined;
}): AuthOutcome {
  const statusOutcome = classifyAuthOutcome(input.statusCode);
  if (
    statusOutcome !== "success" ||
    input.operation !== "oidc_callback" ||
    input.statusCode < 300 ||
    input.statusCode >= 400
  ) {
    return statusOutcome;
  }

  const locations = Array.isArray(input.location) ? input.location : [input.location];
  for (const location of locations) {
    if (!location) continue;
    try {
      const error = new URL(location, "http://paperclip.invalid").searchParams.get("error");
      if (error !== null) {
        return oidcServerErrorRedirectCodes.has(error) ? "server_error" : "client_error";
      }
    } catch {
      // A malformed Location header is not an OAuth error redirect signal.
    }
  }

  return "success";
}

/**
 * Bounded `reason` allow-list (mirrors the adapter-lane reasons defined in
 * BLO-4296). Anything outside this set collapses to {@link UNKNOWN_REASON} so a
 * misbehaving or compromised reporter cannot inflate cardinality via `reason`.
 *
 * BLO-12212/BLO-12505 add two isolation-audit reasons:
 * - `shared_mode_serialized`: a run was blocked because the agent runs in
 *   shared (non-isolated) workspace/session mode and a live Job already holds
 *   the shared mutable-state boundary. Keeps the pre-isolation block signal
 *   visible after isolated concurrency lands.
 * - `unknown_isolation_blocked`: a live Job carried missing or malformed
 *   isolation metadata, so the guard fail-closed and refused an isolated start.
 *
 * BLO-15959 adds three bounded-external-lifecycle-concurrency admission
 * reasons, emitted from the server-side dispatch gate in heartbeat.ts (as
 * opposed to the adapter-lane reasons above):
 * - `concurrency_disabled`: the agent is at its (fallback) one-run cap
 *   because `heartbeat.concurrencyEnabled` is false/absent.
 * - `max_concurrent_runs`: concurrency is enabled but the agent is at its
 *   configured `maxConcurrentRuns` ceiling.
 * - `external_slot_capacity`: concurrency is enabled but the agent is at the
 *   operational `EXTERNAL_LIFECYCLE_SLOT_CAPACITY` ceiling (independent of,
 *   and possibly lower than, its configured `maxConcurrentRuns`).
 */
export const KNOWN_BLOCKED_REASONS = [
  "live_job_for_active_run",
  "live_job_for_unknown_run",
  "live_job_for_terminated_run",
  "shared_mode_serialized",
  "unknown_isolation_blocked",
  "concurrency_disabled",
  "max_concurrent_runs",
  "external_slot_capacity",
] as const;

/**
 * Bounded `isolation_mode` allow-list (BLO-12212/BLO-12505). The isolation
 * descriptor's mode is one of these two values; anything else collapses to
 * {@link UNKNOWN_ISOLATION_MODE}. This is the ONLY isolation dimension exposed
 * as a Prometheus label — the high-cardinality identifiers
 * (`isolation_key`, `task_key`, `session_id`) are deliberately kept OUT of the
 * label set and emitted on the structured guard-decision log line instead, so a
 * misbehaving or compromised reporter cannot inflate series cardinality via an
 * unbounded session/task id. The onprem-k8s alerts (PR Blockcast/onprem-k8s#936)
 * group by those identifiers but degrade gracefully to an empty label when the
 * control plane omits them.
 */
export const KNOWN_ISOLATION_MODES = ["shared", "run", "workspace"] as const;

export const UNKNOWN_ISOLATION_MODE = "unknown";

const knownIsolationModeSet: ReadonlySet<string> = new Set(KNOWN_ISOLATION_MODES);

export const UNKNOWN_REASON = "other";
export const UNKNOWN_AGENT_ID = "unknown";

const knownReasonSet: ReadonlySet<string> = new Set(KNOWN_BLOCKED_REASONS);

/**
 * Bounded `invocation_source` allow-list for `paperclip_heartbeat_run_failed_total`.
 * Anything outside this set collapses to "other".
 */
export const KNOWN_INVOCATION_SOURCES = [
  "github_pr_opened",
  "github_pr_synchronize",
  "github_pr_review_submitted",
  "transient_failure_retry",
  "capacity_blocked_retry",
  "issue_assigned",
  "issue_commented",
] as const;

export const UNKNOWN_INVOCATION_SOURCE = "other";

const knownInvocationSourceSet: ReadonlySet<string> = new Set(KNOWN_INVOCATION_SOURCES);

export function normalizeInvocationSource(source: string | null | undefined): string {
  return typeof source === "string" && knownInvocationSourceSet.has(source)
    ? source
    : UNKNOWN_INVOCATION_SOURCE;
}

export function normalizeReason(reason: string | null | undefined): string {
  return typeof reason === "string" && knownReasonSet.has(reason) ? reason : UNKNOWN_REASON;
}

export function normalizeIsolationMode(mode: string | null | undefined): string {
  return typeof mode === "string" && knownIsolationModeSet.has(mode) ? mode : UNKNOWN_ISOLATION_MODE;
}

export function normalizeAgentId(
  agentId: string | null | undefined,
  knownAgentIds: ReadonlySet<string>,
): string {
  if (typeof agentId === "string" && agentId.length > 0 && knownAgentIds.has(agentId)) {
    return agentId;
  }
  return UNKNOWN_AGENT_ID;
}

/**
 * External-lifecycle adapter allow-list for the process_lost monitor (BLO-16184).
 * Anything else (local adapters, future types) collapses to "other" so the
 * `adapter` label can never be inflated by an unexpected value.
 */
export const KNOWN_EXTERNAL_LIFECYCLE_ADAPTERS = ["claude_k8s", "opencode_k8s"] as const;
export const UNKNOWN_EXTERNAL_ADAPTER = "other";
const knownExternalLifecycleAdapterSet: ReadonlySet<string> = new Set(KNOWN_EXTERNAL_LIFECYCLE_ADAPTERS);

/**
 * process_lost error-string buckets. Derived from the FIXED failure strings the
 * reaper stamps (heartbeat.ts buildProcessLossMessage + the pre-adapter mint) so
 * the raw (pid-bearing, unbounded) message never becomes a label. Unmatched
 * strings collapse to "other".
 */
export const KNOWN_PROCESS_LOST_BUCKETS = [
  "pre_adapter",
  "child_pid",
  "process_group",
  "server_restart",
] as const;
export const UNKNOWN_PROCESS_LOST_BUCKET = "other";

/**
 * The 5 durable ProcessLossClassification values (process-loss-classification.ts,
 * BLO-16181). Anything else collapses to "unknown" — notably historical rows
 * minted before BLO-16181 have no classification and land here.
 */
export const KNOWN_PROCESS_LOSS_CLASSIFICATIONS = [
  "pre_adapter_job_unstamped",
  "pre_adapter_job_stamped",
  "pre_adapter_kube_unknown",
  "started_job_absent",
  "local",
] as const;
export const UNKNOWN_PROCESS_LOSS_CLASSIFICATION = "unknown";
const knownProcessLossClassificationSet: ReadonlySet<string> = new Set(KNOWN_PROCESS_LOSS_CLASSIFICATIONS);

export function normalizeExternalAdapter(adapter: string | null | undefined): string {
  return typeof adapter === "string" && knownExternalLifecycleAdapterSet.has(adapter)
    ? adapter
    : UNKNOWN_EXTERNAL_ADAPTER;
}

/**
 * Map a raw process_lost failure message to a bounded bucket by matching the
 * fixed substrings the reaper stamps. Order matters only in that each substring
 * is unique to one bucket. Never returns the raw string (unbounded cardinality).
 */
export function normalizeProcessLostBucket(errorString: string | null | undefined): string {
  const s = typeof errorString === "string" ? errorString : "";
  if (s.includes("before external adapter invocation")) return "pre_adapter";
  if (s.includes("child pid")) return "child_pid";
  if (s.includes("process group")) return "process_group";
  if (s.includes("server may have restarted")) return "server_restart";
  return UNKNOWN_PROCESS_LOST_BUCKET;
}

export function normalizeProcessLossClassification(classification: string | null | undefined): string {
  return typeof classification === "string" && knownProcessLossClassificationSet.has(classification)
    ? classification
    : UNKNOWN_PROCESS_LOSS_CLASSIFICATION;
}

let registry: Registry | null = null;
let concurrentRunBlocked: Counter<"agent_id" | "reason" | "isolation_mode"> | null = null;
let isolatedRunStarted: Counter<"agent_id" | "isolation_mode"> | null = null;
type HeartbeatRunFailedLabel =
  | "agent_id"
  | "issue_id"
  | "adapter"
  | "error_code"
  | "invocation_source"
  | "isolation_mode";

let heartbeatRunFailed: Counter<HeartbeatRunFailedLabel> | null = null;
let ccrotateCapacityDeferred: Counter<"adapter" | "provider"> | null = null;
let agentZeroTokenCompletedRunStreak: Gauge<"agent_id" | "adapter"> | null = null;
let externalRuntimeReservationEvents: Counter<"event"> | null = null;
let externalRuntimeReservationsActive: Gauge | null = null;
let externalRuntimeReservationOldestAge: Gauge | null = null;
let processLostTotal: Counter<"adapter" | "error_bucket" | "classification"> | null = null;
let externalLifecycleRunningRuns: Gauge<"adapter"> | null = null;
let processLostLivenessNull: Counter | null = null;
let orphanedManagedPodReaped: Counter<"adapter"> | null = null;
let authRequest: Counter<"operation" | "outcome"> | null = null;

function ensureRegistry(): {
  registry: Registry;
  counter: Counter<"agent_id" | "reason" | "isolation_mode">;
  isolatedStartedCounter: Counter<"agent_id" | "isolation_mode">;
  failedCounter: Counter<HeartbeatRunFailedLabel>;
  capacityDeferredCounter: Counter<"adapter" | "provider">;
  zeroTokenCompletedRunStreakGauge: Gauge<"agent_id" | "adapter">;
  externalRuntimeReservationEventsCounter: Counter<"event">;
  externalRuntimeReservationsActiveGauge: Gauge;
  externalRuntimeReservationOldestAgeGauge: Gauge;
  processLostTotalCounter: Counter<"adapter" | "error_bucket" | "classification">;
  externalLifecycleRunningRunsGauge: Gauge<"adapter">;
  processLostLivenessNullCounter: Counter;
  orphanedManagedPodReapedCounter: Counter<"adapter">;
  authRequestCounter: Counter<"operation" | "outcome">;
} {
  if (
    !registry
    || !concurrentRunBlocked
    || !isolatedRunStarted
    || !heartbeatRunFailed
    || !ccrotateCapacityDeferred
    || !agentZeroTokenCompletedRunStreak
    || !externalRuntimeReservationEvents
    || !externalRuntimeReservationsActive
    || !externalRuntimeReservationOldestAge
    || !processLostTotal
    || !externalLifecycleRunningRuns
    || !processLostLivenessNull
    || !orphanedManagedPodReaped
    || !authRequest
  ) {
    registry = new Registry();
    concurrentRunBlocked = new Counter({
      name: CONCURRENT_RUN_BLOCKED_METRIC,
      help:
        "Count of claude_k8s adapter dispatch refusals (concurrent run blocked), "
        + "labeled by bounded agent_id, reason, and isolation_mode. The conflicting "
        + "isolation_key/task_key/session_id are emitted on the structured guard-decision "
        + "log line (not as labels) to keep series cardinality bounded (BLO-12212).",
      labelNames: ["agent_id", "reason", "isolation_mode"],
      registers: [registry],
    });
    isolatedRunStarted = new Counter({
      name: ISOLATED_RUN_STARTED_METRIC,
      help:
        "Count of K8s adapter runs dispatched under an isolated workspace/session "
        + "descriptor (not blocked), labeled by bounded agent_id and isolation_mode. "
        + "Paired with " + CONCURRENT_RUN_BLOCKED_METRIC + " to read the isolated-start "
        + "vs shared-mode-block ratio (BLO-12212).",
      labelNames: ["agent_id", "isolation_mode"],
      registers: [registry],
    });
    heartbeatRunFailed = new Counter({
      name: HEARTBEAT_RUN_FAILED_METRIC,
      help:
        "Count of heartbeat runs that reached terminal status 'failed', labeled by agent, source issue, "
        + "adapter, error_code, invocation_source (wake reason), and bounded isolation_mode. Used to "
        + "compute webhook-driven PR-review failure rate and detect repeated run-isolated execution-pod "
        + "failures for one issue (BLO-7457 / BLO-9147 / BLO-17953). Agent and issue identifiers are "
        + "retained only for run-isolated k8s_pod_schedule_failed; other failures collapse them to "
        + "bounded fallbacks.",
      labelNames: ["agent_id", "issue_id", "adapter", "error_code", "invocation_source", "isolation_mode"],
      registers: [registry],
    });
    ccrotateCapacityDeferred = new Counter({
      name: CCROTATE_CAPACITY_DEFERRED_METRIC,
      help:
        "Count of heartbeat dispatches deferred because the penstock availability gate "
        + "returned no available capacity (BLO-12953). Incremented once per heartbeat tick "
        + "that returned scheduled_retry with scheduledRetryReason='ccrotate_capacity'. "
        + "A sustained non-zero rate means the fleet is quota-stalled.",
      labelNames: ["adapter", "provider"],
      registers: [registry],
    });
    agentZeroTokenCompletedRunStreak = new Gauge({
      name: AGENT_NO_USAGE_STREAK_METRIC,
      help:
        "Current count of consecutive terminal heartbeat runs for an agent that completed with zero token usage. "
        + "Alerts at >=3 catch poisoned-session or pre-model throttle loops within minutes (BLO-10891).",
      labelNames: ["agent_id", "adapter"],
      registers: [registry],
    });
    externalRuntimeReservationEvents = new Counter({
      name: EXTERNAL_RUNTIME_RESERVATION_EVENTS_METRIC,
      help: "Count of durable external-runtime reservation lifecycle transitions.",
      labelNames: ["event"],
      registers: [registry],
    });
    externalRuntimeReservationsActive = new Gauge({
      name: EXTERNAL_RUNTIME_RESERVATIONS_ACTIVE_METRIC,
      help: "Current count of unreleased durable external-runtime slot reservations.",
      registers: [registry],
    });
    externalRuntimeReservationOldestAge = new Gauge({
      name: EXTERNAL_RUNTIME_RESERVATION_OLDEST_AGE_METRIC,
      help: "Age in seconds of the oldest unreleased external-runtime slot reservation.",
      registers: [registry],
    });
    processLostTotal = new Counter({
      name: PROCESS_LOST_TOTAL_METRIC,
      help:
        "Count of heartbeat runs reaped as process_lost (BLO-16184/BLO-12292), labeled by "
        + "bounded adapter (claude_k8s/opencode_k8s/other), error_bucket (fixed reaper failure "
        + "string collapsed to a category), and classification (the durable resultJson.processLoss "
        + "bucket from BLO-16181). NUMERATOR of the trigger monitor; read against "
        + EXTERNAL_LIFECYCLE_RUNNING_RUNS_METRIC + " and " + PROCESS_LOST_LIVENESS_NULL_METRIC
        + " so a 0 count is only trusted at real volume with kube liveness intact.",
      labelNames: ["adapter", "error_bucket", "classification"],
      registers: [registry],
    });
    externalLifecycleRunningRuns = new Gauge({
      name: EXTERNAL_LIFECYCLE_RUNNING_RUNS_METRIC,
      help:
        "Current count of running external-lifecycle heartbeat runs by adapter, snapshotted "
        + "each reap cycle (reset-then-set so a true drop to 0 is written explicitly, not stale). "
        + "DENOMINATOR for " + PROCESS_LOST_TOTAL_METRIC + ": a 0 process_lost count is only "
        + "'healthy' when this is above a floor — otherwise there were simply no runs to lose.",
      labelNames: ["adapter"],
      registers: [registry],
    });
    processLostLivenessNull = new Counter({
      name: PROCESS_LOST_LIVENESS_NULL_METRIC,
      help:
        "Count of reap cycles that had external-lifecycle candidates but got a null kube "
        + "Job-status list (kube API unavailable), i.e. the reaper fell back to the staleness "
        + "heuristic while blind. DENOMINATOR guard: a rising rate makes any concurrent low "
        + PROCESS_LOST_TOTAL_METRIC + " reading unreliable rather than healthy (BLO-16184).",
      registers: [registry],
    });
    orphanedManagedPodReaped = new Counter({
      name: ORPHANED_MANAGED_POD_REAPED_METRIC,
      help:
        "Count of orphaned external-lifecycle agent pods force-deleted by the "
        + "reapOrphanedRuns managed-pod sweep (BLO-16850): a still-Running pod whose "
        + "heartbeat run finalized (terminal/absent) with no live Job. Labeled by bounded "
        + "adapter (claude_k8s/opencode_k8s/other). A sustained rate means runs are "
        + "finalizing while their pods keep running.",
      labelNames: ["adapter"],
      registers: [registry],
    });
    authRequest = new Counter({
      name: AUTH_REQUEST_METRIC,
      help:
        "Count of Better Auth requests labeled by bounded operation and outcome. "
        + "No user, provider, IP address, callback state, or token is exposed.",
      labelNames: ["operation", "outcome"],
      registers: [registry],
    });
    for (const operation of KNOWN_AUTH_OPERATIONS) {
      for (const outcome of KNOWN_AUTH_OUTCOMES) {
        authRequest.inc({ operation, outcome }, 0);
      }
    }
    // Process/runtime metrics make the scrape target carry meaningful data even
    // before any refusal is reported (manual-verification check #3 on BLO-8328).
    collectDefaultMetrics({ register: registry });
  }
  return {
    registry,
    counter: concurrentRunBlocked,
    isolatedStartedCounter: isolatedRunStarted,
    failedCounter: heartbeatRunFailed,
    capacityDeferredCounter: ccrotateCapacityDeferred,
    zeroTokenCompletedRunStreakGauge: agentZeroTokenCompletedRunStreak,
    externalRuntimeReservationEventsCounter: externalRuntimeReservationEvents,
    externalRuntimeReservationsActiveGauge: externalRuntimeReservationsActive,
    externalRuntimeReservationOldestAgeGauge: externalRuntimeReservationOldestAge,
    processLostTotalCounter: processLostTotal,
    externalLifecycleRunningRunsGauge: externalLifecycleRunningRuns,
    processLostLivenessNullCounter: processLostLivenessNull,
    orphanedManagedPodReapedCounter: orphanedManagedPodReaped,
    authRequestCounter: authRequest,
  };
}

export function getMetricsRegistry(): Registry {
  return ensureRegistry().registry;
}

export interface RecordConcurrentRunBlockedInput {
  agentId: string | null | undefined;
  reason: string | null | undefined;
  /**
   * Isolation mode of the descriptor at the time of the block. Bounded to the
   * {@link KNOWN_ISOLATION_MODES} allow-list; anything else collapses to
   * {@link UNKNOWN_ISOLATION_MODE}. Optional for backward compatibility with
   * older adapters that do not yet report it.
   */
  isolationMode?: string | null | undefined;
  /** Active company agent roster used to bound the `agent_id` label. */
  knownAgentIds: ReadonlySet<string>;
}

/**
 * Apply the cardinality guardrail and increment the counter. Returns the
 * normalized labels that were actually emitted (useful for logging/tests).
 */
export function recordConcurrentRunBlocked(
  input: RecordConcurrentRunBlockedInput,
): { agent_id: string; reason: string; isolation_mode: string } {
  const labels = {
    agent_id: normalizeAgentId(input.agentId, input.knownAgentIds),
    reason: normalizeReason(input.reason),
    isolation_mode: normalizeIsolationMode(input.isolationMode),
  };
  ensureRegistry().counter.inc(labels);
  return labels;
}

export interface RecordIsolatedRunStartedInput {
  agentId: string | null | undefined;
  isolationMode?: string | null | undefined;
  /** Active company agent roster used to bound the `agent_id` label. */
  knownAgentIds: ReadonlySet<string>;
}

/**
 * Increment {@link ISOLATED_RUN_STARTED_METRIC} for a run dispatched under an
 * isolated descriptor. Same cardinality guardrail as the blocked counter.
 * Returns the normalized labels emitted (useful for logging/tests).
 */
export function recordIsolatedRunStarted(
  input: RecordIsolatedRunStartedInput,
): { agent_id: string; isolation_mode: string } {
  const labels = {
    agent_id: normalizeAgentId(input.agentId, input.knownAgentIds),
    isolation_mode: normalizeIsolationMode(input.isolationMode),
  };
  ensureRegistry().isolatedStartedCounter.inc(labels);
  return labels;
}

export interface RecordHeartbeatRunFailedInput {
  /** Agent that owned the finalized run. */
  agentId: string | null | undefined;
  /** Source issue for issue-scoped execution, or null for non-issue work. */
  issueId: string | null | undefined;
  /** Agent adapter type (e.g. "claude_k8s", "claude_local"). */
  adapter: string | null | undefined;
  /** Finalized error code on the heartbeat_runs row. */
  errorCode: string | null | undefined;
  /**
   * Wake reason from the run's contextSnapshot (normalized to the allow-list).
   * Maps to `invocation_source` label.
   */
  invocationSource: string | null | undefined;
  /** K8s workspace isolation mode; non-K8s and malformed values become unknown. */
  isolationMode: string | null | undefined;
}

/**
 * Increment `paperclip_heartbeat_run_failed_total`. Call once per run that
 * reaches terminal status "failed" in the liveness loop. Returns the
 * normalized labels emitted (useful for logging/tests).
 */
export function recordHeartbeatRunFailed(
  input: RecordHeartbeatRunFailedInput,
): Record<HeartbeatRunFailedLabel, string> {
  // Per-issue labels are intentionally limited to the retry-loop failure this
  // monitor needs. Keeping them on every terminal failure would retain one
  // Prometheus counter series per historical issue for the process lifetime.
  const isolationMode = normalizeIsolationMode(input.isolationMode);
  const retainSourceIds = input.errorCode === "k8s_pod_schedule_failed" && isolationMode === "run";
  const labels = {
    agent_id: retainSourceIds && typeof input.agentId === "string" && input.agentId.length > 0
      ? input.agentId
      : UNKNOWN_AGENT_ID,
    issue_id: retainSourceIds && typeof input.issueId === "string" && input.issueId.length > 0
      ? input.issueId
      : "none",
    adapter: typeof input.adapter === "string" && input.adapter.length > 0 ? input.adapter : "unknown",
    error_code: typeof input.errorCode === "string" && input.errorCode.length > 0 ? input.errorCode : "unknown",
    invocation_source: normalizeInvocationSource(input.invocationSource),
    isolation_mode: isolationMode,
  };
  ensureRegistry().failedCounter.inc(labels);
  return labels;
}

export interface RecordCcrotateCapacityDeferredInput {
  /** Agent adapter type (e.g. "claude_k8s"). */
  adapter: string | null | undefined;
  /** Penstock provider that was unavailable (e.g. "anthropic"). */
  provider: string | null | undefined;
}

/**
 * Increment {@link CCROTATE_CAPACITY_DEFERRED_METRIC}. Call once per heartbeat
 * tick where the penstock availability gate returns `allow: false` and a
 * `scheduled_retry` run is persisted. Returns the labels emitted.
 */
export function recordCcrotateCapacityDeferred(
  input: RecordCcrotateCapacityDeferredInput,
): { adapter: string; provider: string } {
  const labels = {
    adapter: typeof input.adapter === "string" && input.adapter.length > 0 ? input.adapter : "unknown",
    provider: typeof input.provider === "string" && input.provider.length > 0
      ? input.provider
      : "unknown",
  };
  ensureRegistry().capacityDeferredCounter.inc(labels);
  return labels;
}

export interface RecordAgentZeroTokenCompletedRunStreakInput {
  /** Agent id is bounded against the active company roster before emission. */
  agentId: string | null | undefined;
  /** Agent adapter type (e.g. "claude_k8s", "opencode_k8s"). */
  adapter: string | null | undefined;
  /** Consecutive terminal zero-token runs, computed from persisted heartbeat_runs. */
  streak: number;
  /** Active company agent roster used to bound the `agent_id` label. */
  knownAgentIds: ReadonlySet<string>;
}

export function recordAgentZeroTokenCompletedRunStreak(
  input: RecordAgentZeroTokenCompletedRunStreakInput,
): { agent_id: string; adapter: string; streak: number } {
  const labels = {
    agent_id: normalizeAgentId(input.agentId, input.knownAgentIds),
    adapter: typeof input.adapter === "string" && input.adapter.length > 0 ? input.adapter : "unknown",
  };
  const streak = Number.isFinite(input.streak) ? Math.max(0, Math.floor(input.streak)) : 0;
  ensureRegistry().zeroTokenCompletedRunStreakGauge.set(labels, streak);
  return { ...labels, streak };
}

const EXTERNAL_RUNTIME_RESERVATION_EVENTS = new Set(["reserved", "contended", "launching", "launched", "released"]);

export function recordExternalRuntimeReservationEvent(event: string): string {
  const normalized = EXTERNAL_RUNTIME_RESERVATION_EVENTS.has(event) ? event : "other";
  ensureRegistry().externalRuntimeReservationEventsCounter.inc({ event: normalized });
  return normalized;
}

export function setExternalRuntimeReservationMetrics(input: {
  active: number;
  oldestAgeSeconds: number;
}): void {
  const metrics = ensureRegistry();
  metrics.externalRuntimeReservationsActiveGauge.set(Math.max(0, input.active));
  metrics.externalRuntimeReservationOldestAgeGauge.set(Math.max(0, input.oldestAgeSeconds));
}

/**
 * Record one process_lost reap (BLO-16184 numerator). All three labels are
 * normalized to bounded allow-lists before touching the registry. Returns the
 * resolved label set (useful for assertions / structured logs).
 */
export function recordProcessLost(input: {
  adapter: string | null | undefined;
  errorString: string | null | undefined;
  classification: string | null | undefined;
}): { adapter: string; error_bucket: string; classification: string } {
  const labels = {
    adapter: normalizeExternalAdapter(input.adapter),
    error_bucket: normalizeProcessLostBucket(input.errorString),
    classification: normalizeProcessLossClassification(input.classification),
  };
  ensureRegistry().processLostTotalCounter.inc(labels);
  return labels;
}

/**
 * Snapshot the external-lifecycle running-run volume (BLO-16184 denominator #1).
 * Reset-then-set so a true drop to 0 for an adapter is written explicitly rather
 * than leaving a stale non-zero series (the classic stale-gauge masking trap).
 * Unknown/future external adapters collapse into the "other" series.
 */
export function setExternalLifecycleRunningRuns(byAdapter: Record<string, number>): void {
  const gauge = ensureRegistry().externalLifecycleRunningRunsGauge;
  gauge.reset();
  let other = 0;
  for (const [adapter, count] of Object.entries(byAdapter)) {
    const value = Math.max(0, count);
    if (knownExternalLifecycleAdapterSet.has(adapter)) {
      gauge.set({ adapter }, value);
    } else {
      other += value;
    }
  }
  // Always write an explicit 0 for each known adapter that had no running runs,
  // so a drop to 0 is observable rather than an absent series.
  for (const adapter of KNOWN_EXTERNAL_LIFECYCLE_ADAPTERS) {
    if (!(adapter in byAdapter)) gauge.set({ adapter }, 0);
  }
  if (other > 0) gauge.set({ adapter: UNKNOWN_EXTERNAL_ADAPTER }, other);
}

/** Record one reap cycle that was blind to kube (BLO-16184 denominator #2). */
export function recordProcessLostLivenessNull(): void {
  ensureRegistry().processLostLivenessNullCounter.inc();
}

/**
 * Record one orphaned external-lifecycle managed-pod reap (BLO-16850). The
 * adapter label is normalized to the bounded external-adapter allow-list before
 * touching the registry (claude_k8s/opencode_k8s/other), mirroring
 * {@link recordProcessLost}'s cardinality guard.
 */
export function recordOrphanedManagedPodReaped(labels?: { adapterType?: string }): void {
  ensureRegistry().orphanedManagedPodReapedCounter.inc({
    adapter: normalizeExternalAdapter(labels?.adapterType),
  });
}

export function recordAuthRequest(input: {
  operation: string | null | undefined;
  outcome: string | null | undefined;
}): { operation: AuthOperation; outcome: AuthOutcome } {
  const labels = {
    operation: normalizeAuthOperation(input.operation),
    outcome: normalizeAuthOutcome(input.outcome),
  };
  ensureRegistry().authRequestCounter.inc(labels);
  return labels;
}

export async function renderMetrics(): Promise<{ contentType: string; body: string }> {
  const reg = getMetricsRegistry();
  const depBlockedSnapshot = snapshotDepBlockedMetrics();
  const depBlockedBody = [
    `# HELP ${DEP_BLOCKED_WAKEUP_METRIC} Count of dependency-blocked wakeup coalescer outcomes, labeled by outcome.`,
    `# TYPE ${DEP_BLOCKED_WAKEUP_METRIC} counter`,
    ...Object.entries(depBlockedSnapshot).map(
      ([outcome, value]) => `${DEP_BLOCKED_WAKEUP_METRIC}{outcome="${outcome}"} ${value}`,
    ),
  ].join("\n");
  const blockerResolvedSnapshot = snapshotBlockerResolvedWakeMetrics();
  const blockerResolvedBody = [
    `# HELP ${BLOCKER_RESOLVED_WAKEUP_METRIC} Count of blocker-resolved dependent wake outcomes, labeled by outcome (fast_path_* = immediate becameDone wake, sweep_* = periodic reconcileResolvedBlockerDependents sweep).`,
    `# TYPE ${BLOCKER_RESOLVED_WAKEUP_METRIC} counter`,
    ...Object.entries(blockerResolvedSnapshot).map(
      ([outcome, value]) => `${BLOCKER_RESOLVED_WAKEUP_METRIC}{outcome="${outcome}"} ${value}`,
    ),
  ].join("\n");
  return {
    contentType: reg.contentType,
    body: `${await reg.metrics()}\n${depBlockedBody}\n${blockerResolvedBody}\n`,
  };
}

/** Test-only: drop the registry so each test starts from a clean counter. */
export function __resetMetricsForTest(): void {
  registry = null;
  concurrentRunBlocked = null;
  isolatedRunStarted = null;
  heartbeatRunFailed = null;
  ccrotateCapacityDeferred = null;
  agentZeroTokenCompletedRunStreak = null;
  externalRuntimeReservationEvents = null;
  externalRuntimeReservationsActive = null;
  externalRuntimeReservationOldestAge = null;
  processLostTotal = null;
  externalLifecycleRunningRuns = null;
  processLostLivenessNull = null;
  orphanedManagedPodReaped = null;
  authRequest = null;
  resetDepBlockedMetrics();
  resetBlockerResolvedWakeMetrics();
}
