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
 */
export const KNOWN_BLOCKED_REASONS = [
  "live_job_for_active_run",
  "live_job_for_unknown_run",
  "live_job_for_terminated_run",
  "shared_mode_serialized",
  "unknown_isolation_blocked",
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
export const KNOWN_ISOLATION_MODES = ["shared", "workspace"] as const;

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

let registry: Registry | null = null;
let concurrentRunBlocked: Counter<"agent_id" | "reason" | "isolation_mode"> | null = null;
let isolatedRunStarted: Counter<"agent_id" | "isolation_mode"> | null = null;
let heartbeatRunFailed: Counter<"adapter" | "error_code" | "invocation_source"> | null = null;
let ccrotateCapacityDeferred: Counter<"adapter" | "provider"> | null = null;
let agentZeroTokenCompletedRunStreak: Gauge<"agent_id" | "adapter"> | null = null;
let externalRuntimeReservationEvents: Counter<"event"> | null = null;
let externalRuntimeReservationsActive: Gauge | null = null;
let externalRuntimeReservationOldestAge: Gauge | null = null;

function ensureRegistry(): {
  registry: Registry;
  counter: Counter<"agent_id" | "reason" | "isolation_mode">;
  isolatedStartedCounter: Counter<"agent_id" | "isolation_mode">;
  failedCounter: Counter<"adapter" | "error_code" | "invocation_source">;
  capacityDeferredCounter: Counter<"adapter" | "provider">;
  zeroTokenCompletedRunStreakGauge: Gauge<"agent_id" | "adapter">;
  externalRuntimeReservationEventsCounter: Counter<"event">;
  externalRuntimeReservationsActiveGauge: Gauge;
  externalRuntimeReservationOldestAgeGauge: Gauge;
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
        "Count of heartbeat runs that reached terminal status 'failed', labeled by adapter type, "
        + "error_code, and invocation_source (wake reason). Used to compute webhook-driven "
        + "PR-review failure rate (BLO-7457 / BLO-9147). Cardinality bounded by allow-lists.",
      labelNames: ["adapter", "error_code", "invocation_source"],
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
  /** Agent adapter type (e.g. "claude_k8s", "claude_local"). */
  adapter: string | null | undefined;
  /** Finalized error code on the heartbeat_runs row. */
  errorCode: string | null | undefined;
  /**
   * Wake reason from the run's contextSnapshot (normalized to the allow-list).
   * Maps to `invocation_source` label.
   */
  invocationSource: string | null | undefined;
}

/**
 * Increment `paperclip_heartbeat_run_failed_total`. Call once per run that
 * reaches terminal status "failed" in the liveness loop. Returns the
 * normalized labels emitted (useful for logging/tests).
 */
export function recordHeartbeatRunFailed(
  input: RecordHeartbeatRunFailedInput,
): { adapter: string; error_code: string; invocation_source: string } {
  const labels = {
    adapter: typeof input.adapter === "string" && input.adapter.length > 0 ? input.adapter : "unknown",
    error_code: typeof input.errorCode === "string" && input.errorCode.length > 0 ? input.errorCode : "unknown",
    invocation_source: normalizeInvocationSource(input.invocationSource),
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
  resetDepBlockedMetrics();
  resetBlockerResolvedWakeMetrics();
}
