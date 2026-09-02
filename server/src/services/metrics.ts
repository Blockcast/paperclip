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

import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";
import { logger } from "../middleware/logger.js";
import { resetDepBlockedMetrics, snapshotDepBlockedMetrics } from "./dep-blocked-metrics.js";
import {
  resetBlockerResolvedWakeMetrics,
  snapshotBlockerResolvedWakeMetrics,
} from "./blocker-resolved-wake-metrics.js";
import {
  resetRoutineDispatchMetrics,
  snapshotRoutineDispatchMetrics,
} from "./routine-dispatch-metrics.js";

export const CONCURRENT_RUN_BLOCKED_METRIC = "claude_k8s_concurrent_run_blocked_total";
// BLO-23379: routine dispatch bypassed a long-parked execution issue instead of
// letting it gate the fire. Non-zero means a quota/capacity park was overridden;
// zero while a routine is quiet means it is genuinely gated on in-flight work.
export const ROUTINE_DISPATCH_METRIC = "paperclip_routine_dispatch_total";
export const AUTH_REQUEST_METRIC = "paperclip_auth_request_total";
/**
 * Project primary-workspace fallback counter (BLO-26184). Incremented once
 * per resolution of a project that has >=1 workspace but no row flagged
 * `isPrimary` — i.e. `pickPrimaryWorkspace` fell through to the
 * earliest-created row instead of an explicit choice. Measured fleet exposure
 * is 0/80 non-archived projects (see BLO-23599); this counter is the
 * alertable signal that would have caught that drift on day one. No labels —
 * cardinality is bounded by call volume, not by project identity (the
 * offending `project_id` goes on the paired structured log line instead, to
 * keep this series a plain fleet-wide total). A sustained non-zero rate means
 * a project has drifted into the ambiguous state and should be re-flagged.
 */
export const PROJECT_PRIMARY_WORKSPACE_FALLBACK_METRIC = "paperclip_project_primary_workspace_fallback_total";
export const BACKSTOP_DEFERRED_CANDIDATES_METRIC = "paperclip_backstop_deferred_candidates";
export const BACKSTOP_SWEEP_COMPLETED_METRIC = "paperclip_backstop_sweep_completed_total";
export const BACKSTOP_CANDIDATES_SKIPPED_METRIC = "paperclip_backstop_candidates_skipped_total";
export const BACKSTOP_SOURCES = [
  "issue_graph_liveness.backstop",
  "stranded_recovery_wake_backstop",
] as const;
export type BackstopSource = (typeof BACKSTOP_SOURCES)[number];
export const BACKSTOP_SKIP_REASONS = [
  "not_ready", "existing_wake", "live_path", "pause_hold", "interaction",
  "no_owner", "cause", "exhausted", "cooldown", "claim_lost",
  "deferred_or_failed", "enqueue_failed",
] as const;
export type BackstopSkipReason = (typeof BACKSTOP_SKIP_REASONS)[number];
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
export const HEARTBEAT_TIMER_SCHEDULER_EXCLUSION_METRIC =
  "paperclip_heartbeat_timer_scheduler_exclusion_total";

export const KNOWN_HEARTBEAT_TIMER_SCHEDULER_EXCLUSIONS = [
  "idle_circuit_breaker",
  "adapter_failed_circuit_breaker",
  "no_in_flight_work",
  "provider_capacity_deferred",
  "heartbeat.scheduling_suppressed",
  "company.inactive",
  "heartbeat.worktree_execution_cutoff",
  "budget.blocked",
  "agent.not_invokable",
  "heartbeat.disabled",
  "heartbeat.cooldown.active",
  "heartbeat.timer.no_actionable_work",
  "issue_tree_hold_active",
] as const;
export const UNKNOWN_HEARTBEAT_TIMER_SCHEDULER_EXCLUSION = "other";
const knownHeartbeatTimerSchedulerExclusionSet: ReadonlySet<string> = new Set(
  KNOWN_HEARTBEAT_TIMER_SCHEDULER_EXCLUSIONS,
);

export function normalizeHeartbeatTimerSchedulerExclusion(reason: string | null | undefined): string {
  return typeof reason === "string" && knownHeartbeatTimerSchedulerExclusionSet.has(reason)
    ? reason
    : UNKNOWN_HEARTBEAT_TIMER_SCHEDULER_EXCLUSION;
}
export const AGENT_NO_USAGE_STREAK_METRIC = "paperclip_agent_zero_token_completed_run_streak";
export const EXTERNAL_RUNTIME_RESERVATION_EVENTS_METRIC = "paperclip_external_runtime_reservation_events_total";
export const EXTERNAL_RUNTIME_RESERVATIONS_ACTIVE_METRIC = "paperclip_external_runtime_reservations_active";
export const EXTERNAL_RUNTIME_RESERVATION_OLDEST_AGE_METRIC = "paperclip_external_runtime_reservation_oldest_age_seconds";
// BLO-21116: age of the oldest `queued` heartbeatRuns row per agent. A
// dispatchable run sitting in `queued` for a long time is exactly the
// "invisible strand" this issue reports -- it looks like an active issue with
// an assignee and a run, but nothing is executing, and nothing else pages on
// it. Labeled by bounded agent_id (same allow-list guardrail as
// CONCURRENT_RUN_BLOCKED_METRIC) so `max(...) by (agent_id) > threshold`
// identifies which agent is starved.
export const QUEUED_RUN_OLDEST_AGE_METRIC = "paperclip_queued_run_oldest_age_seconds";
export const QUEUED_RUN_AGE_METRICS_REFRESH_SUCCESS_METRIC = "paperclip_queued_run_age_metrics_refresh_success";
// BLO-28865. Deliberately NOT a threshold over the pre-existing
// EXTERNAL_RUNTIME_RESERVATION_OLDEST_AGE_METRIC: that gauge is unlabelled and
// measures reservation age only, so it cannot separate a stranded row from a
// legitimately long run (measured 7d spread: ~93 min to ~9.0h, all healthy)
// and cannot name the wedged agent. This gauge encodes the correlation in SQL
// instead -- it only counts a reservation whose run is terminal or silent --
// so the alert is a plain threshold over a series that is already 0 for a
// healthy long run.
export const EXTERNAL_RUNTIME_RESERVATION_STRANDED_OLDEST_AGE_METRIC =
  "paperclip_external_runtime_reservation_stranded_oldest_age_seconds";
export const EXTERNAL_RUNTIME_RESERVATION_STRAND_METRICS_REFRESH_SUCCESS_METRIC =
  "paperclip_external_runtime_reservation_strand_metrics_refresh_success";
/**
 * Overdue-parked-retry age gauge (BLO-22094). {@link QUEUED_RUN_OLDEST_AGE_METRIC}
 * deliberately excludes `status='scheduled_retry'` rows -- that exclusion is
 * correct and stays (Ally review, onprem-k8s#2013: without it, a retry
 * promoted after hours of backoff would instantly report that whole backoff
 * as queued-dispatch wait). But the consequence is that a retry which is
 * parked and never promoted is invisible to any gauge, forever. This metric
 * covers exactly that gap: for `status='scheduled_retry'` rows whose
 * `scheduled_retry_at` is already in the past (i.e. due and not yet
 * promoted), the age of the oldest such row past its due time, per agent. A
 * row that is merely backing off (`scheduled_retry_at` still in the future)
 * contributes nothing -- this is an overdue-since-due-time clock, not a
 * parked-since-creation one. Labeled by bounded agent_id, same allow-list
 * guardrail as {@link QUEUED_RUN_OLDEST_AGE_METRIC}.
 */
export const OVERDUE_SCHEDULED_RETRY_OLDEST_AGE_METRIC = "paperclip_overdue_scheduled_retry_oldest_age_seconds";
/**
 * Freshness companion for {@link OVERDUE_SCHEDULED_RETRY_OLDEST_AGE_METRIC}
 * (BLO-22094, Ally review on #1184). Exactly the role
 * {@link QUEUED_RUN_AGE_METRICS_REFRESH_SUCCESS_METRIC} plays for the sibling
 * gauge, and it is load-bearing for the same reason -- more so here, in fact.
 *
 * The age gauge is reset-then-set only on the refresh success path, so a
 * throw leaves the previous per-agent values frozen in the registry while
 * `/metrics` keeps returning 200. The frozen value is almost always `0`, the
 * *healthy* reading, which means a dead refresh is indistinguishable from a
 * healthy fleet on both the dashboard and the alert. That is precisely the
 * invisible-failure class this whole metric exists to eliminate, so shipping
 * the detector without its own freshness gate would make the fix for an
 * unobservable failure itself unobservable.
 *
 * A separate gauge from the sibling's rather than a shared one: the two
 * refreshes run different aggregates against different indexes (0217 for
 * `status='queued'`, 0224 for the overdue-parked predicate), so a statement
 * timeout or plan regression can hit one and not the other. Sharing a
 * freshness signal would let a healthy sibling refresh vouch for a dead one.
 */
export const OVERDUE_SCHEDULED_RETRY_AGE_METRICS_REFRESH_SUCCESS_METRIC =
  "paperclip_overdue_scheduled_retry_age_metrics_refresh_success";
export const SCHEDULED_RETRY_PARK_HORIZON_METRIC =
  "paperclip_scheduled_retry_park_horizon_seconds";
export const SCHEDULED_RETRY_PARK_HORIZON_REFRESH_SUCCESS_METRIC =
  "paperclip_scheduled_retry_park_horizon_refresh_success";
/** Queue wait observed when a sanctioned GitHub PR-review run starts. */
export const PR_REVIEW_QUEUE_WAIT_METRIC = "paperclip_pr_review_queue_wait_seconds";
export const PR_REVIEW_QUEUE_WAIT_BUCKETS_SECONDS = [60, 300, 600, 900, 1800, 3600, 7200, 14400, 28800];
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
/**
 * gbrain-context recall-prefetch outcome counter (BLO-25892).
 *
 * Incremented once per `agent.run.started` prefetch, at the single server-side
 * write path (`pluginStateStore.set`, `stateKey="gbrain-context"`,
 * `scopeKind="run"`) rather than inside the gbrain plugin worker — the worker
 * runs out-of-process with no access to this registry, whereas every prefetch
 * result already round-trips through `ctx.state.set` to persist to
 * `plugin_state`, so hooking the existing write is free of a second RPC.
 *
 * This exists because container-restart-count monitoring is structurally
 * blind to a recall outage: the 2026-08-08T11:00–22:00Z incident (1,629
 * failed `traverse_graph` calls, 0 successes for 11h) left `gbrain-mcp`'s
 * restart count untouched, because the fetch failed at the transport layer
 * while the pod's own liveness probe (not routed through the same Service
 * path) kept passing. `rate(...{status="error"}[15m])` crossing a threshold
 * catches that class of failure regardless of whether the backing pod ever
 * restarts.
 *
 * Scope limit — this counter detects a FAILING recall, not an ABSENT one. When
 * the plugin worker stops writing altogether (BLO-30067 measured 76 such hours
 * across 2026-08-18..08-23) every series here stays flat and the error ratio is
 * 0/0, i.e. green. The complementary detector for that mode is activity-side
 * coverage (`plugin_state` rows per hour over `heartbeat_runs` per hour), which
 * is owned by BLO-30067. Neither signal subsumes the other; both are required.
 *
 * Labels: `status`, bounded to {@link KNOWN_GBRAIN_RECALL_STATUSES} (else
 * "other" — see {@link normalizeGbrainRecallStatus}). Cardinality is fixed at
 * 7 series, independent of agent/company/issue.
 */
export const GBRAIN_RECALL_METRIC = "paperclip_gbrain_recall_total";

/**
 * Closed set of `CachedRecallStatus` values from
 * `packages/plugins/paperclip-plugin-gbrain/src/recall.ts`. Duplicated here
 * (rather than imported) to keep this module's cardinality guardrail
 * self-contained and independent of the plugin package's exports drifting.
 */
export const KNOWN_GBRAIN_RECALL_STATUSES = [
  "ok",
  "no-issue-page",
  "empty",
  "island",
  "skipped",
  "error",
] as const;

export const UNKNOWN_GBRAIN_RECALL_STATUS = "other";

const knownGbrainRecallStatusSet: ReadonlySet<string> = new Set(KNOWN_GBRAIN_RECALL_STATUSES);

export function normalizeGbrainRecallStatus(status: string | null | undefined): string {
  return typeof status === "string" && knownGbrainRecallStatusSet.has(status)
    ? status
    : UNKNOWN_GBRAIN_RECALL_STATUS;
}

/**
 * GitHub review-request delivery-state counter (BLO-18859, parent BLO-18848).
 * One series per (`state`, `reason`) so an operator can read the full delivery
 * funnel for reviewer wakes driven by the in-tree GitHub receiver
 * (`routes/github-webhook.ts`) rather than inferring it from logs.
 *
 * The four states are deliberately a funnel, not a partition of arrivals:
 * - `received`: the delivery cleared every suppression gate (signature,
 *   self-echo, idempotency dedup, reviewer selection) and we are about to
 *   dispatch a wake. Skipped/deduped deliveries are correct no-ops and are
 *   NOT counted, so `received` measures intent-to-wake, not raw arrivals.
 * - `queued`: `heartbeat.wakeup` resolved with an actual run, i.e. a durable
 *   `agent_wakeup_requests` row is committed and the wake can no longer be
 *   lost by this process dying. Also emitted when
 *   `reconcileFailedWakeDispatches` recovers a `dispatch_failed` row, since
 *   that delivery did reach the queued state — just later than the inline
 *   path. Never both for one delivery: if the inline dispatch throws, the
 *   receiver's `queued` line is skipped and only the reconciler can emit it.
 *   Crucially this is gated on a truthy `enqueueWakeup` result: that function
 *   resolves `null` (not an error) when a scheduling gate declines the wake,
 *   and counting those as `queued` reported a healthy funnel for a review that
 *   never ran.
 * - `suppressed`: the wake was declined rather than dispatched, and no run will
 *   ever come of it. Two shapes reach it, both terminal because no reconciler
 *   pass re-arms them: `enqueueWakeup` resolving `null` after writing a
 *   `status = "skipped"` row (scheduling suppression, an inactive company, a
 *   cooldown, and the other `return null` gates), and `enqueueWakeup` throwing
 *   an `HttpError` business rule — which for `budget.blocked` and
 *   `agent.not_invokable` also leaves a durable `skipped` row, and for an
 *   unresolvable agent/responsible-user leaves none. The `HttpError` shape is
 *   counted at both dispatch sites (inline and reconciler; the reconciler marks
 *   the row `dispatch_superseded`) — missing it left a delivery with
 *   `received = 1` and no terminal state forever, breaking the funnel
 *   invariant below. Distinct from `dead_lettered`, which is a *dispatch*
 *   failure the retry chain could not absorb; `suppressed` is the fleet
 *   deliberately declining, which is sometimes correct (a paused company) and
 *   sometimes an outage (`heartbeat.scheduling_suppressed` left on). Break down
 *   by {@link GITHUB_REVIEW_REQUEST_SUPPRESSION_METRIC}'s `cause` label to tell
 *   those apart — that is the counter to alert on, not this state as a whole.
 * - `deferred`: the provider-capacity (penstock/ccrotate) gate declined to
 *   dispatch *now* and `persistProviderCapacityRetry` committed a
 *   `heartbeat_runs` row with `status = "scheduled_retry"`, which the scheduler
 *   re-drives once capacity returns. This is the ONE `return null` out of
 *   `enqueueWakeup` that is not a durable skip, so it must not be folded into
 *   `suppressed`: it is late, not lost. Folding it in was doubly wrong — it
 *   claimed a review had been terminally declined, and because the gate writes
 *   no `skipped` row the cause fell through to
 *   {@link UNKNOWN_GITHUB_SUPPRESSION_CAUSE}, which the outage alert pages on.
 *   A provider rate-limit would have paged as "reviews are being dropped".
 *   Not terminal, so it is excluded from the funnel invariant below; a
 *   sustained rate means reviews are arriving slowly, which is a capacity
 *   signal (see `paperclip_ccrotate_capacity_deferred_total`), not a loss one.
 * - `retried`: one re-dispatch attempt after a transient (non-HttpError)
 *   dispatch failure — both the in-process attempts in
 *   `wakeupWithDispatchRetry` and each later `reconcileFailedWakeDispatches`
 *   pass. Counted per attempt, so it is a rate of dispatch flakiness.
 * - `dead_lettered`: the delivery is terminally lost without operator action.
 *   Two paths reach it: the reconciler marking a row
 *   `dispatch_failed_exhausted` after `DISPATCH_RETRY_MAX_ATTEMPTS`, and
 *   `wakeupWithDispatchRetry` failing to persist its durable safety-net row at
 *   all (agent unresolvable, or the insert itself threw) — the latter is the
 *   original "lost forever, no record" mode and is the more urgent of the two.
 *
 * The invariant an operator reads: every `received` delivery reaches exactly one
 * terminal state, so `received == queued + suppressed + dead_lettered` once the
 * retry chains and `deferred` re-drives in flight have settled. In steady state
 * `received` ≈ `queued`
 * and both `suppressed` and `dead_lettered` are flat at zero. A non-zero
 * `dead_lettered` rate means an
 * `@ally` review request will never produce a run, which is the BLO-18847
 * symptom this counter exists to make visible.
 *
 * Cardinality: `state` is closed at 6 and `reason` is coerced to
 * {@link KNOWN_GITHUB_WAKE_REASONS} (else "other"), so the series count is
 * bounded at `6 * (KNOWN_GITHUB_WAKE_REASONS.length + 1)` — independent of
 * repo, PR number, delivery id, and agent roster. Those high-cardinality
 * identifiers stay on the structured log lines, matching the guardrail
 * {@link CONCURRENT_RUN_BLOCKED_METRIC} documents above.
 */
export const GITHUB_REVIEW_REQUEST_DELIVERY_METRIC = "paperclip_github_review_request_delivery_total";

/**
 * The delivery states. Closed set — see
 * {@link GITHUB_REVIEW_REQUEST_DELIVERY_METRIC} for what each one means and
 * why `received` counts intent-to-wake rather than raw arrivals.
 */
export const KNOWN_GITHUB_DELIVERY_STATES = [
  "received",
  "queued",
  "suppressed",
  "deferred",
  "retried",
  "dead_lettered",
] as const;

export type GithubReviewRequestDeliveryState = (typeof KNOWN_GITHUB_DELIVERY_STATES)[number];

/**
 * Bounded `reason` allow-list for {@link GITHUB_REVIEW_REQUEST_DELIVERY_METRIC},
 * mirroring the `context.wakeReason` values the GitHub receiver mints for
 * reviewer wakes. Anything outside this set (including a missing reason)
 * collapses to {@link UNKNOWN_GITHUB_WAKE_REASON} so a future event type cannot
 * silently inflate cardinality before the allow-list is updated.
 */
export const KNOWN_GITHUB_WAKE_REASONS = [
  "github_pr_opened",
  "github_pr_ready_for_review",
  "github_pr_reopened",
  "github_pr_review_requested",
  "github_pr_review_submitted",
  "github_pr_review_feedback",
  "github_pr_synchronized",
] as const;

export const UNKNOWN_GITHUB_WAKE_REASON = "other";

const knownGithubWakeReasonSet: ReadonlySet<string> = new Set(KNOWN_GITHUB_WAKE_REASONS);

export function normalizeGithubWakeReason(reason: string | null | undefined): string {
  return typeof reason === "string" && knownGithubWakeReasonSet.has(reason)
    ? reason
    : UNKNOWN_GITHUB_WAKE_REASON;
}

/**
 * Why a GitHub review-request delivery ended in the terminal `suppressed`
 * state (BLO-18859 review follow-up). Split into its own counter rather than a
 * third label on {@link GITHUB_REVIEW_REQUEST_DELIVERY_METRIC} because a
 * suppression cause is meaningless for the other four states — carrying it
 * there would mean a `cause="none"` filler on every `received`/`queued` series
 * and a labels-only-valid-for-one-value contract that PromQL cannot express.
 *
 * The two counters are incremented from a single call site
 * ({@link recordGithubReviewRequestSuppressed}), so
 * `sum(paperclip_github_review_request_suppression_total)` and
 * `sum(paperclip_github_review_request_delivery_total{state="suppressed"})`
 * are equal by construction and cannot drift.
 *
 * This exists because `suppressed` is NOT uniformly a problem: an inactive
 * company, a wake-on-demand policy that is off, and a cooldown are the fleet
 * correctly declining, while global scheduling suppression left on strands
 * every review request in the fleet. Without a cause breakdown an operator can
 * only alert on all-or-nothing, so the outage case has to stay unalerted to
 * keep the expected cases from paging — which is how a stuck
 * `heartbeat.scheduling_suppressed` flag can silently eat every `@ally`
 * review while the dead-letter alert stays green.
 *
 * Cardinality: bounded at `(causes + 1) * (reasons + 1)`, independent of repo,
 * PR, agent, and delivery id.
 */
export const GITHUB_REVIEW_REQUEST_SUPPRESSION_METRIC =
  "paperclip_github_review_request_suppression_total";

/**
 * Restart-safe gauge of unresolved GitHub review-request dead letters
 * (BLO-18859 review follow-up). See the gauge's `help` text for why the
 * `dead_lettered` counter alone leaves two holes — a dead letter recorded
 * before the first scrape has no baseline for `increase()`, and a pod
 * replacement retires the series before a pending `for` can elapse.
 */
export const GITHUB_REVIEW_REQUEST_DEAD_LETTER_UNRESOLVED_METRIC =
  "paperclip_github_review_request_dead_letter_unresolved";

/**
 * Reviews the reviewer identity actually PUBLISHED to GitHub (BLO-27608).
 *
 * Every other GitHub review metric in this file is REQUEST-side: they count
 * deliveries arriving, being queued, suppressed, deferred or dead-lettered.
 * None of them can answer "did a review come out the other end". That gap is
 * not theoretical — Ally was silently down fleet-wide for ~8.6h on 2026-08-12
 * (codex provider unavailability, BLO-27123) and the request funnel read
 * perfectly healthy throughout: `received 131 / queued 131 / suppressed 0 /
 * deferred 0 / dead_lettered 0`. The runs were enqueued and dispatched; they
 * died at the model call and produced no artifact. Nothing paged, because
 * "enqueued" is exactly what a healthy fleet also looks like.
 *
 * WHERE THIS IS INCREMENTED, AND WHY IT IS NOT AT THE POST CALL. The control
 * plane never posts a review: there is no `POST /pulls/{n}/reviews` anywhere in
 * this server, and the only two GitHub writes it makes are a commit status and
 * an issue back-link comment. Ally composes and posts its own review by running
 * `gh pr review` inside its pod, so there is no in-process "the post succeeded"
 * moment to hook. What the server does have is GitHub telling it the artifact
 * exists, over the signed webhook — which is strictly stronger than
 * instrumenting the caller would be: it is a first-party observation of the
 * published review rather than the poster's own report that it published one.
 * It is therefore incremented from the webhook receiver, once per delivery that
 * carries a review authored by the configured reviewer identity.
 *
 * SCOPE IS DELIBERATELY THE REVIEWER IDENTITY ONLY — a human's review on one of
 * our repos does NOT count here. The drought alert this feeds
 * (`PaperclipGithubReviewOutputDrought`) is a bare
 * `sum(increase(paperclip_github_review_posted_total[2h])) == 0`, with no label
 * selector, so any series that can be fed by a non-Ally reviewer would let one
 * human review during an Ally blackout hold the alert down. Keep this counter
 * meaning "Ally published a review" and nothing else; if per-author breakdown is
 * ever wanted, add a SEPARATE metric rather than a label here.
 *
 * BOTH SURFACES ARE COUNTED because Ally uses both and either one alone
 * under-reports: measured, `Blockcast/paperclip#952` carries 4 comment-shaped
 * reviews and 0 formal, while `#937` carries 4 formal and 0 comment-shaped.
 * `surface="formal"` is a `pull_request_review.submitted` event;
 * `surface="comment"` is an `issue_comment` whose body carries Ally's
 * consolidated-review heading. The comment surface is the one that most needs a
 * dedicated observation point: a CLEAN comment-shaped review resolves to no
 * event context at all (`isActionablePrReviewComment` requires actionable
 * findings), so it is invisible to every existing counter in this file.
 *
 * Cardinality: `surface` is closed at 2 and `repo` is bounded by the GitHub App
 * installation's repository selection — signature verification means only our
 * own installation can produce these deliveries, so `repo` is not
 * caller-controlled free text. Measured 2026-08-16 the installation carries 98
 * repositories, giving a worst case of 196 series if Ally ever reviewed in all
 * of them; the live set is a single-digit subset. That is small enough to be
 * worth the label, which is the one dimension an operator needs to answer "is
 * the drought fleet-wide or one repo". PR number, review id and author stay on
 * the structured log line, per the guardrail
 * {@link GITHUB_REVIEW_REQUEST_DELIVERY_METRIC} documents.
 *
 * Redelivery: GitHub can redeliver a webhook, which would double-count here.
 * That is accepted rather than deduped — this counter exists to distinguish
 * "zero" from "non-zero" for a drought alert, where an over-count is harmless
 * and the dedup state would have to be durable to help.
 */
export const GITHUB_REVIEW_POSTED_METRIC = "paperclip_github_review_posted_total";

/**
 * Which GitHub surface a published review was written to. Closed set — see
 * {@link GITHUB_REVIEW_POSTED_METRIC} for why both are counted.
 */
export const KNOWN_GITHUB_REVIEW_SURFACES = ["formal", "comment"] as const;

export type GithubReviewSurface = (typeof KNOWN_GITHUB_REVIEW_SURFACES)[number];

export const UNKNOWN_GITHUB_REVIEW_REPO = "unknown";

/**
 * Coerce a webhook-supplied repository full name to a metric label. Only guards
 * the missing/blank case: the value is already bounded by the installation (see
 * the cardinality note on {@link GITHUB_REVIEW_POSTED_METRIC}), and an
 * allow-list here would silently drop a newly-onboarded repo from the drought
 * alert — failing open on coverage is worse than the bounded label growth.
 */
export function normalizeGithubReviewRepo(repo: string | null | undefined): string {
  const trimmed = typeof repo === "string" ? repo.trim() : "";
  return trimmed.length > 0 ? trimmed : UNKNOWN_GITHUB_REVIEW_REPO;
}

/**
 * Terminal verdict of a reviewer run's completion evidence (BLO-27608), the
 * companion to {@link GITHUB_REVIEW_POSTED_METRIC}.
 *
 * The drought alert asks "did any review get published". On its own that
 * over-fires, because there are outcomes where publishing nothing is CORRECT:
 * Ally declining to self-review a PR it authored (BLO-9293), a repo that has
 * been archived, or a head that was already reviewed. A quiet period made
 * entirely of those is healthy; a quiet period made of `missing` is an outage.
 * Without this breakdown the two are indistinguishable, and intentional-skip
 * volume masks a genuine drought.
 *
 * `status` mirrors `evaluatePrReviewCompletionEvidence`'s verdict exactly, and
 * is recorded AFTER the authoritative GitHub re-verification that call sites
 * apply — so a locally-`missing` run that GitHub then proves did post lands here
 * as `posted_review`, matching what the run was actually credited with. The
 * deliberate-skip outcomes are `self_review_skipped`, `already_reviewed` and
 * `archived_repo_skipped`; the failure outcome is `missing`; `auth_expired` is a
 * recoverable fault that is retried rather than either.
 *
 * Note this is RUN-side and therefore complementary to, not a substitute for,
 * the webhook-observed counter: a run that dies at the model call never reaches
 * a verdict at all, so it is silence here and silence there — which is exactly
 * what the drought alert keys on.
 *
 * Cardinality: `status` is closed at the 6 verdicts below.
 */
export const GITHUB_REVIEW_COMPLETION_METRIC = "paperclip_github_review_completion_total";

/**
 * The reviewer-run completion verdicts. Closed set, mirroring
 * `evaluatePrReviewCompletionEvidence`. `not_applicable` is deliberately absent:
 * it means the run was not a reviewer run, which is not a review outcome.
 */
export const KNOWN_GITHUB_REVIEW_COMPLETION_STATUSES = [
  "posted_review",
  "already_reviewed",
  "self_review_skipped",
  "archived_repo_skipped",
  "auth_expired",
  "missing",
] as const;

export type GithubReviewCompletionStatus =
  (typeof KNOWN_GITHUB_REVIEW_COMPLETION_STATUSES)[number];

export const UNKNOWN_GITHUB_REVIEW_COMPLETION_STATUS = "other";

const knownGithubReviewCompletionStatusSet: ReadonlySet<string> = new Set(
  KNOWN_GITHUB_REVIEW_COMPLETION_STATUSES,
);

/**
 * Coerce a completion verdict to the bounded label set. A future verdict added
 * to `evaluatePrReviewCompletionEvidence` collapses to
 * {@link UNKNOWN_GITHUB_REVIEW_COMPLETION_STATUS} rather than inflating
 * cardinality before this allow-list is updated.
 */
export function normalizeGithubReviewCompletionStatus(status: string | null | undefined): string {
  return typeof status === "string" && knownGithubReviewCompletionStatusSet.has(status)
    ? status
    : UNKNOWN_GITHUB_REVIEW_COMPLETION_STATUS;
}

/**
 * Restart-safe gauge of `agent_wakeup_requests` rows sitting in the terminal
 * `status = 'failed'` state (BLO-20255).
 *
 * This is a DIFFERENT terminal state from the one
 * {@link GITHUB_REVIEW_REQUEST_DEAD_LETTER_UNRESOLVED_METRIC} covers, and the
 * gap between them is exactly why this metric exists. `dispatch_failed_exhausted`
 * means the *dispatch* chain burned its retry budget; `failed` means the wake
 * dispatched fine and the **run** died (the Job was force-terminated, the Job
 * failed, the adapter blew up). `reconcileFailedWakeDispatches` only ever
 * selects `dispatch_failed`, so a `failed` row is never re-driven and never
 * counted — it is terminal *and* invisible.
 *
 * BLO-18030 / PR #900 closed the retry half for one slice of this (a
 * stale-killed `pr_review` run is now bounded-retried when a GitHub probe
 * proves no review landed). Three cases deliberately stay terminal there so we
 * never double-post a review: the probe found an existing review, the probe
 * threw / there was no PR context, or the run was not `pr_review` at all. Those
 * rows are correct to leave alone and wrong to leave unmonitored.
 */
export const AGENT_WAKEUP_TERMINAL_FAILED_UNRESOLVED_METRIC =
  "paperclip_agent_wakeup_terminal_failed_unresolved";

/**
 * Age, in seconds, of the OLDEST unresolved terminal-`failed` wake in each
 * scope — 0 when the scope has none (BLO-20255).
 *
 * This exists because a Prometheus `for:` clause cannot express the condition
 * the alert actually needs. `for:` measures how long the *expression* has been
 * continuously true, not how long any individual row has been failed, and the
 * alert expression sums rows together. So with
 * `sum(..._unresolved{scope="pr_review"}) > 0` and `for: 30m`, two different
 * short-lived failures overlapping by a single scrape keep the sum non-zero
 * across the whole window: failure A holds it up for 29 minutes, B appears as A
 * is resolved, the expression never goes false, and B pages after roughly one
 * minute while the annotation claims a row has sat failed for thirty. Rotating
 * `error_code` values do not save it either, since the expression sums that
 * label away.
 *
 * Publishing the age as its own gauge moves the ageing into data the server
 * already knows exactly (`now - finishedAt` of a row that survived the
 * successor exclusion), so the rule can threshold on a real per-row age and use
 * `for:` only for the thing it is good at — tolerating a scrape or two of
 * flapping.
 *
 * `scope`-only labels, deliberately: `error_code` is a triage breakdown for the
 * count, and adding it here would let a scope's oldest row hide behind a
 * younger row of a different code.
 */
export const AGENT_WAKEUP_TERMINAL_FAILED_OLDEST_AGE_METRIC =
  "paperclip_agent_wakeup_terminal_failed_oldest_age_seconds";

/**
 * Restart-safe gauge: 1 while an installed plugin sits in `status = 'error'`,
 * 0 otherwise (BLO-21092/BLO-20410). One sample per installed plugin, not per
 * status — the label set is only the plugin's stable identity (`plugin_id`,
 * `plugin_key`); the error/not-error distinction lives in the gauge value.
 * Using `status` itself as a label would leave a stale `status="ready"`
 * series behind the instant a plugin flips to `error` (prom-client never
 * retires an old label combination on its own), so a query like
 * `count(paperclip_plugin_status)` would grow every time a plugin's status
 * ever changed instead of staying pinned at the installed-plugin count.
 *
 * Deliberately narrower than the full `PLUGIN_STATUSES` enum: a plugin the
 * operator disabled is a different signal from one that crashed, and
 * collapsing them would page on `disabled` maintenance. Re-derived on every
 * collector tick from the `plugins` table (the worker tier only —
 * `app.ts` gates plugin lifecycle to `paperclipNodeRole !== "api"`), so a
 * pod restart republishes the current state instead of starting from a
 * stale 0. This is the exact gap BLO-20410 exposed: `lucitra.plugin-secrets`
 * sat in `status='error'` for 9+ hours with the pod `1/1 Running` and
 * nothing watching the DB row.
 */
export const PLUGIN_ERROR_METRIC = "paperclip_plugin_error";

/**
 * Prometheus exposition for plugin-contributed metrics (PEN-2799).
 *
 * `ctx.metrics.write` used to write a `plugin_logs` row and nothing else, so
 * no alert rule could fire on any plugin metric — ever. That is not
 * theoretical: `paperclip-plugin-alertmanager` emitted
 * `alertmanager.owner.fallback_failed` on every single failed delivery for 89
 * hours while ~93% of fleet alert delivery was lost (PEN-2581), and the series
 * did not exist. The metric that *named the root cause* was being published
 * into a channel nothing can observe.
 *
 * The plugin's metric name is a **label, never part of the series name**. Two
 * reasons, and the second is the load-bearing one:
 *   1. Rule authors cannot enumerate plugin metric names ahead of time, so a
 *      name-per-series family is unwritable against.
 *   2. It is already attacker-shaped. Two bundled call sites build the name by
 *      interpolation (`demo.${name}` in kitchen-sink, `slack.tool.${name}.error`
 *      in the Slack plugin), so mapping it into the series name would let any
 *      installed plugin mint arbitrary `paperclip_*` series in the platform's
 *      own namespace.
 *
 * `company_id` is deliberately NOT a label — it is unbounded per tenant. It
 * stays on the `plugin_logs` row, which is where per-tenant detail belongs.
 */
export const PLUGIN_METRIC_TOTAL_METRIC = "paperclip_plugin_metric_total";

/**
 * Companion to {@link PLUGIN_METRIC_TOTAL_METRIC}: what we refused to publish
 * and why. A drop is never silent — every rejected or collapsed write lands
 * here under a `reason`, so "my plugin metric is missing" is answerable from
 * Prometheus instead of by reading host source.
 */
export const PLUGIN_METRIC_DROPPED_METRIC = "paperclip_plugin_metric_dropped_total";

/**
 * Tag keys any plugin may ever promote to a Prometheus label.
 *
 * This is the platform half of a two-sided gate: a tag key becomes a label
 * only if it is in **both** this list and the emitting plugin's manifest
 * `metricLabels`. The manifest chooses which keys *that* plugin promotes; this
 * list bounds what *any* plugin may promote, so installing a third-party
 * plugin cannot introduce an unbounded label.
 *
 * Two sides are required rather than one because prom-client fixes a counter's
 * `labelNames` at construction and throws on any label it was not built with,
 * while a manifest is read per-write — long after the counter exists. So the
 * label *set* must be known statically here; the manifest can only narrow it.
 *
 * Seeded from every tag key actually in use across the bundled plugins
 * (measured, not guessed: `source` ×7, `event_type` ×5, `decision` ×5,
 * `severity` ×4, `error_code` ×4, `action` ×3, `alertname` ×2, then
 * `version` / `scope` / `trigger` / `exit_code` as singletons). Each is a
 * closed vocabulary.
 *
 * Deliberately EXCLUDED, because each is unbounded in principle and would
 * blow up cardinality on a plugin that never intended it:
 *   - `command` / `command_name` — operator-defined custom command names;
 *   - `turns` / `threshold` — numeric measurements, not categories;
 *   - `by` — an actor identity;
 *   - `mimetype` — plugin-supplied and effectively open.
 * Their metrics still publish; they just publish without those labels. Adding
 * a key here is an explicit cardinality decision, not a convenience.
 */
export const PLUGIN_METRIC_PROMOTABLE_TAG_KEYS = [
  "action",
  "alertname",
  "decision",
  "error_code",
  "event_type",
  "exit_code",
  "scope",
  "severity",
  "source",
  "trigger",
  "version",
] as const;

export type PluginMetricPromotableTagKey =
  (typeof PLUGIN_METRIC_PROMOTABLE_TAG_KEYS)[number];

/**
 * A plugin metric name must look like a metric name. Rejecting a mis-shaped
 * name is cheaper than carrying it as a label value forever, because
 * prom-client never retires a label combination.
 */
export const PLUGIN_METRIC_NAME_REGEX = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/;
export const PLUGIN_METRIC_NAME_MAX_LENGTH = 64;

/**
 * Ceiling on the length of a *promoted tag value*, applying the same reasoning
 * as {@link PLUGIN_METRIC_NAME_MAX_LENGTH} to the other axis — and the one that
 * actually crosses a trust boundary. The metric name is plugin source; a
 * promoted value is not. `alertname` is `alert.labels.alertname` taken verbatim
 * from the inbound Alertmanager webhook, so its length is chosen by whoever
 * authored the firing rule, not by us.
 *
 * The *count* of retained values is already bounded by
 * {@link PLUGIN_METRIC_CARDINALITY_BUDGET}, so an unbounded length is bloat
 * rather than a breach: prom-client never retires a label combination, so each
 * one is re-serialised on every scrape for the process lifetime. Truncating is
 * strictly better than dropping — a truncated `alertname` still identifies the
 * alert to a human reading the series, where a dropped label loses the
 * breakdown entirely.
 *
 * 128 is comfortably above the longest alertname firing fleet-wide when this
 * was written (59 chars, `PhysicalInfra...NearConfiguredMax`) while keeping the
 * worst case bounded at roughly
 * `CARDINALITY_BUDGET x promotable-keys x 128` bytes per plugin.
 */
export const PLUGIN_METRIC_LABEL_VALUE_MAX_LENGTH = 128;

/**
 * Ceiling on distinct metric *names* a single plugin may occupy, per process
 * lifetime. Past it, further new names collapse into one `metric="_overflow"`
 * series.
 *
 * This tier exists because a metric name can be built by interpolation
 * (`demo.${name}` in kitchen-sink, `slack.tool.${name}.error` in the Slack
 * plugin), so the name axis is not inherently bounded by plugin source. It is
 * nonetheless *enumerable* and small in practice — the alertmanager plugin
 * uses 19 — which is why it gets a tight budget of its own rather than sharing
 * one with the tag-value axis.
 */
export const PLUGIN_METRIC_NAME_BUDGET = 50;

/**
 * Ceiling on distinct `(metric, promoted-label-values)` combinations a single
 * plugin may occupy, per process lifetime. Past it, a write **keeps its
 * `metric` label and drops its promoted labels**, so it still lands on the
 * plugin's real per-name series.
 *
 * The two tiers degrade on different axes, and that asymmetry is the whole
 * point (PEN-2799 review of its own first cut):
 *
 * - The `metric` label is what an alert rule filters on. A rule reads
 *   `paperclip_plugin_metric_total{metric="alertmanager.alert.error"}`, so
 *   collapsing `metric` on overflow silently makes that rule stop matching —
 *   a narrower re-run of the PEN-2579 failure mode (a rule watching a series
 *   that is not reliably there), reintroduced by the bound meant to prevent
 *   it.
 * - Promoted tag values are the genuinely unbounded axis: `alertname` is
 *   derived from alert labels, and 155 distinct alertnames fired fleet-wide in
 *   the seven days before this was written, against 16 alertmanager metric
 *   names that carry it. Exhaustion is the expected steady state within days
 *   of a worker start, not a tail case.
 *
 * So the unbounded axis is the one that degrades, and the bounded, alertable
 * one survives. Because a label-dropped write lands on the same series as a
 * no-tag write of that metric, `sum by (metric)` stays **exactly** correct
 * across overflow — only the per-tag breakdown is lost, and
 * `paperclip_plugin_metric_dropped_total{reason="label_budget"}` says so.
 *
 * Both tiers are bounded over values *ever observed*, not currently active,
 * because prom-client never retires a label combination — bounding "active"
 * would bound nothing. They reset on a worker restart, which is correct for a
 * counter and does mean a plugin churning names gets a fresh allowance each
 * restart; the alternative is persisting the ledger, which is not worth a DB
 * write per metric.
 *
 * Worst case per plugin is {@link PLUGIN_METRIC_NAME_BUDGET} name-level series
 * + this many full combinations + one `_overflow`, i.e. 151.
 */
export const PLUGIN_METRIC_CARDINALITY_BUDGET = 100;

/** Label value that over-name-budget writes collapse into. */
export const PLUGIN_METRIC_OVERFLOW_NAME = "_overflow";

/**
 * Unix timestamp (seconds) of the plugin-status collector's last successful
 * tick (BLO-21092 review follow-up). Set ONLY on success, never on failure —
 * a `listInstalled()` rejection (first tick or any later one) leaves this
 * value where it was, so `time() - this` grows monotonically while the
 * collector is stuck and {@link PLUGIN_ERROR_METRIC} silently keeps serving
 * a stale (or, on a first-tick failure, entirely absent) snapshot. Alerting
 * on staleness here catches exactly the case a plain `paperclip_plugin_error
 * == 1` rule cannot: the collector itself is dead, so no plugin is reporting
 * anything, healthy or not.
 *
 * Labeled by a constant `role="worker"` even though the value never varies —
 * NOT for cardinality, but because prom-client auto-publishes a bare
 * (zero-label) Gauge at value 0 the moment it is constructed, with no `.set()`
 * call required (confirmed against prom-client 15.1.3). `ensureRegistry` runs
 * on every tier, including the API tier, which never starts the collector
 * (`app.ts` gates it to `paperclipNodeRole !== "api"`), so a bare Gauge here
 * would auto-publish frozen at 0 on every API pod forever -- and since
 * production scrapes both the `paperclip` and `paperclip-workers` Services,
 * `time() - 0 > threshold` would be permanently true on the API target
 * regardless of worker health. A *labeled* Gauge with no `.set()` call
 * renders no series at all (also confirmed against prom-client 15.1.3), so
 * this only ever appears once {@link startPluginStatusCollector} sets it --
 * which happens only on the tier that can ever make it fresh again. An
 * API-tier scrape of this series is simply absent, and `time() - <absent>`
 * correctly never evaluates.
 */
export const PLUGIN_STATUS_COLLECTOR_LAST_SUCCESS_METRIC =
  "paperclip_plugin_status_collector_last_success_timestamp_seconds";

/**
 * Bounded `error_code` allow-list for
 * {@link AGENT_WAKEUP_TERMINAL_FAILED_UNRESOLVED_METRIC}.
 *
 * IMPORTANT: `agent_wakeup_requests` has **no** `error_code` column — only a
 * free-text `error`. These codes live on `heartbeat_runs.error_code`, written
 * by the same terminal-outcome path that sets the wake row to `failed`
 * (`services/heartbeat.ts` `finalizeExternalLifecycleTerminalRun` sets the run
 * errorCode and the wake `status`/`error` together). The gauge therefore joins
 * the wake row to its run via `agent_wakeup_requests.run_id` to recover the
 * label. Do not "simplify" this into a text match on the `error` prose: that
 * string is human-facing and unversioned, and matching it would silently
 * rebucket every row the first time someone rewords a message.
 *
 * An unlisted code collapses to {@link UNKNOWN_TERMINAL_FAILED_WAKE_ERROR_CODE}
 * rather than growing the series set, so a new terminal code cannot blow up
 * cardinality — it shows up as `other` and gets triaged into this list.
 */
export const KNOWN_TERMINAL_FAILED_WAKE_ERROR_CODES = [
  "external_lifecycle_stale_killed",
  "job_failed",
  "job_missing",
  "adapter_failed",
  "process_lost",
  "agent_not_found",
] as const;

export const UNKNOWN_TERMINAL_FAILED_WAKE_ERROR_CODE = "other";

/**
 * A wake row whose run never got far enough to record an errorCode at all —
 * including the direct `.update()` sites that set `status='failed'` with no
 * companion run (the "deferred wake could not be promoted" path). Kept
 * distinct from `other`: `other` means "a code we have not triaged yet",
 * `none` means "there was no code to read", and conflating them would hide
 * which of the two is growing.
 */
export const TERMINAL_FAILED_WAKE_ERROR_CODE_NONE = "none";

/**
 * Whether the terminal wake was a PR review. Only `pr_review` is alerted on:
 * a lost review is user-visible (the PR sits with a posted trigger and no
 * review), whereas an ordinary issue wake that failed is usually re-driven by
 * the issue's own lifecycle. Both are published so the gauge answers "how much
 * terminal-failed wake is there in total", which is the question the alert's
 * denominator needs.
 *
 * Derived from the wake row's own `payload->>'taskKey'`, which the GitHub
 * webhook writes as `pr_review:<repo>:<prNumber>`
 * (`routes/github-webhook.ts` `buildPrReviewerTaskKey`).
 */
export const TERMINAL_FAILED_WAKE_SCOPES = ["pr_review", "other"] as const;

const knownTerminalFailedWakeErrorCodeSet: ReadonlySet<string> = new Set(
  KNOWN_TERMINAL_FAILED_WAKE_ERROR_CODES,
);

/**
 * `null`/absent maps to {@link TERMINAL_FAILED_WAKE_ERROR_CODE_NONE} (no run
 * row, or a run that recorded no code); an unrecognized string maps to
 * {@link UNKNOWN_TERMINAL_FAILED_WAKE_ERROR_CODE}.
 */
export function normalizeTerminalFailedWakeErrorCode(code: string | null | undefined): string {
  if (typeof code !== "string" || code.length === 0) return TERMINAL_FAILED_WAKE_ERROR_CODE_NONE;
  return knownTerminalFailedWakeErrorCodeSet.has(code)
    ? code
    : UNKNOWN_TERMINAL_FAILED_WAKE_ERROR_CODE;
}

/**
 * A `pr_review:`-prefixed taskKey is the PR-review scope marker. Anything else
 * — including a missing taskKey — is `other`.
 */
export function terminalFailedWakeScopeForTaskKey(taskKey: string | null | undefined): string {
  return typeof taskKey === "string" && taskKey.startsWith("pr_review:") ? "pr_review" : "other";
}

/**
 * Bounded `cause` allow-list. Every entry except
 * {@link GITHUB_SUPPRESSION_CAUSE_DISPATCH_REJECTED} is a literal skip reason
 * `enqueueWakeup` writes to `agent_wakeup_requests.reason` on the durable
 * `status = "skipped"` row, so a cause here can always be joined back to rows
 * with `select * from agent_wakeup_requests where status = 'skipped' and reason = '<cause>'`.
 *
 * Keep in sync with the `writeSkippedRequest` / `writeSkippedHeartbeatRequest`
 * call sites in `services/heartbeat.ts`. Drift is not silent-but-unbounded: an
 * unlisted reason collapses to {@link UNKNOWN_GITHUB_SUPPRESSION_CAUSE}, which
 * the outage alert treats as pageable precisely because an untriaged cause has
 * not been shown to be expected.
 */
export const KNOWN_GITHUB_SUPPRESSION_CAUSES = [
  "heartbeat.scheduling_suppressed",
  "company.inactive",
  "heartbeat.worktree_execution_cutoff",
  "budget.blocked",
  "agent.not_invokable",
  "heartbeat.disabled",
  "heartbeat.wakeOnDemand.disabled",
  "heartbeat.cooldown.active",
  "heartbeat.timer.no_actionable_work",
  "issue_tree_hold_active",
  "dispatch_rejected",
  "scheduled_retry_gate_declined",
  "reviewer_lock_contended",
] as const;

/**
 * The wake was rejected by an `HttpError` business rule that wrote no durable
 * `skipped` row — an unresolvable agent, an unresolvable responsible user, or
 * any other 4xx from the dispatch path. Terminal like the rest (nothing
 * re-arms it) but distinct from a policy decline, and pageable: for a reviewer
 * wake it means the receiver resolved a reviewer the dispatch path then
 * refused, which no amount of waiting fixes.
 */
export const GITHUB_SUPPRESSION_CAUSE_DISPATCH_REJECTED = "dispatch_rejected";

/**
 * A delivery that was parked on a `scheduled_retry` run (counted `deferred`)
 * was cancelled at promotion time by a scheduled-retry gate rather than being
 * promoted to `queued` (BLO-18859 review follow-up). Terminal: the run is
 * `cancelled`, so nothing re-drives it.
 *
 * Deliberately ONE cause for the whole gate family rather than one per
 * `errorCode`. Every gate in that family is a policy decline — the issue was
 * reassigned, cancelled, paused, moved to a terminal status, or its execution
 * lock changed under the retry; the agent went non-invokable or over budget —
 * so none of them belong in the outage selector, and collapsing them keeps
 * this counter's cardinality flat. The specific `errorCode` is not lost: it is
 * on the run's `error`/`errorCode` columns and on the lifecycle event the same
 * promotion pass appends.
 *
 * Note this is NOT the "pool never recovered" ending. That one exhausts the
 * capacity retry budget and loses the review for real, so it is counted
 * `dead_lettered` on the delivery counter and pages via the dead-letter alert.
 */
export const GITHUB_SUPPRESSION_CAUSE_SCHEDULED_RETRY_GATE = "scheduled_retry_gate_declined";

/**
 * A reviewer wake lost the PR-scope dispatch lock AND no durable contended-wake
 * row was recorded, so nothing will ever retry it (BLO-31075 review follow-up).
 * Like {@link GITHUB_SUPPRESSION_CAUSE_DISPATCH_REJECTED} this writes no
 * `skipped` row, so it cannot be joined back to `agent_wakeup_requests` — this
 * counter is the only record it happened.
 *
 * Pageable, and in {@link ALERTING_GITHUB_SUPPRESSION_CAUSES}, because it is
 * genuinely terminal: the delivery is failed for manual redelivery, which
 * nobody may ever perform. It was previously invisible to the funnel entirely —
 * `recordGithubReviewRequestDelivery({state:"received"})` runs INSIDE the lock,
 * so a lock-ACQUISITION timeout incremented neither `received` nor `queued` and
 * showed up only as a dip indistinguishable from a quiet hour.
 */
export const GITHUB_SUPPRESSION_CAUSE_REVIEWER_LOCK_CONTENDED = "reviewer_lock_contended";

export const UNKNOWN_GITHUB_SUPPRESSION_CAUSE = "other";

/**
 * Causes zero-initialized at process start. Deliberately only the ones the
 * outage alert selects: for those, absent-vs-zero is the difference between
 * "nothing suppressed" and "the scrape is broken", so the series must exist
 * before the first event. The expected policy declines are left to appear
 * lazily — they are read as a breakdown when something already fired, never
 * alerted on, so a missing series costs nothing and this keeps the constant
 * series count at `4 * 8` instead of `13 * 8`.
 */
export const ALERTING_GITHUB_SUPPRESSION_CAUSES = [
  "heartbeat.scheduling_suppressed",
  GITHUB_SUPPRESSION_CAUSE_DISPATCH_REJECTED,
  GITHUB_SUPPRESSION_CAUSE_REVIEWER_LOCK_CONTENDED,
  UNKNOWN_GITHUB_SUPPRESSION_CAUSE,
] as const;

const knownGithubSuppressionCauseSet: ReadonlySet<string> = new Set(KNOWN_GITHUB_SUPPRESSION_CAUSES);

export function normalizeGithubSuppressionCause(cause: string | null | undefined): string {
  return typeof cause === "string" && knownGithubSuppressionCauseSet.has(cause)
    ? cause
    : UNKNOWN_GITHUB_SUPPRESSION_CAUSE;
}

/**
 * Terminal-conclusion counter for GitHub Actions `workflow_run` completions
 * received over the webhook (BLO-21078). Exists to make a fleet-wide mass
 * runner-kill visible as a metric instead of only as a wave of misattributed
 * red checks: on 2026-08-02 19:34–19:57Z, GitHub gracefully cancelled
 * multiple in-flight `PR` workflow runs across unrelated PRs/branches (post
 * steps still ran, ruling out an ARC/k8s runner death) with no ARC event
 * spike and no repo-side cancel automation to explain it — the incident had
 * no metric surface at all, so the only way to notice it was an author
 * manually reading job conclusions.
 *
 * One increment per completed `workflow_run` webhook delivery, labeled by
 * the bounded `conclusion` (see {@link KNOWN_WORKFLOW_RUN_CONCLUSIONS}) and,
 * for `cancelled` only, `supersession`. Deliberately excludes repo/workflow
 * name to keep cardinality fixed regardless of fleet growth — this counter's
 * whole job is "how many terminal runs of each kind arrived recently".
 *
 * `supersession` exists because `cancelled` alone is not incident signal:
 * this repo's `pr.yml` sets `concurrency.cancel-in-progress: true`, so an
 * ordinary force-push produces the identical conclusion (BLO-21078's own
 * investigation clocked 101 of 196 cancellations in a 2026-08-01/08-02
 * sample as exactly this, and confirmed the "every lane dies at once, red
 * `verify`, unexpanded matrix names" shape it produces is indistinguishable
 * from a genuine infra kill by shape alone). `supersession="superseded"`
 * means a newer run on the same branch already existed when this run ended
 * — see `recordGithubWorkflowRunConclusion`'s caller in github-webhook.ts
 * for how that is determined. The mass-cancellation alert must key on
 * `conclusion="cancelled",supersession="none"`, not `conclusion="cancelled"`
 * alone — see the `PaperclipGithubWorkflowRunMassCancellation` rule.
 */
export const GITHUB_WORKFLOW_RUN_CONCLUSION_METRIC = "paperclip_github_workflow_run_conclusion_total";

export const KNOWN_WORKFLOW_RUN_CONCLUSIONS = [
  "success",
  "failure",
  "cancelled",
  "skipped",
  "timed_out",
  "action_required",
  "neutral",
  "stale",
  "startup_failure",
] as const;

export const UNKNOWN_WORKFLOW_RUN_CONCLUSION = "other";

const knownWorkflowRunConclusionSet: ReadonlySet<string> = new Set(KNOWN_WORKFLOW_RUN_CONCLUSIONS);

export function normalizeWorkflowRunConclusion(conclusion: string | null | undefined): string {
  return typeof conclusion === "string" && knownWorkflowRunConclusionSet.has(conclusion)
    ? conclusion
    : UNKNOWN_WORKFLOW_RUN_CONCLUSION;
}

// Only meaningful for conclusion="cancelled" — every other conclusion always
// records "none" (there is no supersession question to ask of a run that
// wasn't cancelled). Two values keeps this a flat cardinality multiplier of
// 2 rather than an open-ended label.
export const KNOWN_WORKFLOW_RUN_SUPERSESSIONS = ["none", "superseded"] as const;

const knownWorkflowRunSupersessionSet: ReadonlySet<string> = new Set(KNOWN_WORKFLOW_RUN_SUPERSESSIONS);

export function normalizeWorkflowRunSupersession(supersession: string | null | undefined): string {
  return typeof supersession === "string" && knownWorkflowRunSupersessionSet.has(supersession)
    ? supersession
    : "none";
}

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
  location?: string | number | string[] | undefined;
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
    if (typeof location !== "string" || !location) continue;
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
 * BLO-20815: terminal silence-gap histogram for external-lifecycle runs.
 * Observes `finalizedAt - COALESCE(lastUsefulActionAt, lastOutputAt, startedAt)`
 * at run finalization — the exact same precedence the dispatcher's staleness
 * filter uses in startNextQueuedRunForAgent (heartbeat.ts) to decide whether a
 * running run is stale. Labeled by adapter and terminal status so the
 * `status="succeeded"` population (healthy quiet gaps) can be read separately
 * from the failed/cancelled population (zombie/stuck candidates). This metric
 * is additive-only: it does not gate dispatch, slot accounting, or kill
 * decisions.
 *
 * Buckets deliberately span the EXTERNAL_LIFECYCLE_STALE_MS (15m) /
 * EXTERNAL_LIFECYCLE_HARD_STALE_MS (45m) decision range with resolution where
 * it matters, so a `histogram_quantile` against the `succeeded` population can
 * be compared directly against the 45m destructive-kill floor.
 */
export const EXTERNAL_LIFECYCLE_RUN_SILENCE_GAP_METRIC = "paperclip_external_lifecycle_run_silence_gap_seconds";

export const EXTERNAL_LIFECYCLE_RUN_SILENCE_GAP_BUCKETS_SECONDS = [
  60, 300, 600, 900, 1200, 1800, 2700, 3600, 5400, 7200,
];

/**
 * Companion last-value gauge to {@link EXTERNAL_LIFECYCLE_RUN_SILENCE_GAP_METRIC}
 * (BLO-20815 review follow-up, Ally/gstack-review on PR #947): a classic
 * Prometheus Histogram cannot expose an exact max — values above the last
 * finite bucket collapse into `+Inf`, and the exported bucket/count/sum series
 * retain no per-observation maximum. This gauge is set to the *last observed*
 * silence-gap value per adapter/status on every {@link recordExternalLifecycleRunSilenceGap}
 * call. Reset/window semantics: it is a plain last-write gauge with no reset
 * or decay — the true rolling max is recovered at query time via
 * `max_over_time(...[7d])`, which reads every scraped sample in the window
 * (a process restart only affects samples *after* the restart; earlier peak
 * samples already persisted in Prometheus TSDB are unaffected). The one
 * accepted gap: two observations for the same adapter/status landing within a
 * single scrape interval can have the smaller one overwritten before it is
 * ever scraped — acceptable given external-lifecycle run finalizations are
 * infrequent relative to the scrape interval.
 */
export const EXTERNAL_LIFECYCLE_RUN_SILENCE_GAP_LAST_METRIC =
  "paperclip_external_lifecycle_run_silence_gap_seconds_last";

/**
 * Bounded terminal-status allow-list for {@link EXTERNAL_LIFECYCLE_RUN_SILENCE_GAP_METRIC}.
 * Mirrors HEARTBEAT_RUN_TERMINAL_STATUSES (heartbeat.ts) minus "interrupted",
 * which external-lifecycle runs do not reach. Anything else (including a
 * future new terminal status) collapses to "other" so the label cannot be
 * inflated by an unbounded/typo'd status string.
 */
export const KNOWN_EXTERNAL_LIFECYCLE_TERMINAL_STATUSES = [
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
] as const;
export const UNKNOWN_EXTERNAL_LIFECYCLE_TERMINAL_STATUS = "other";
const knownExternalLifecycleTerminalStatusSet: ReadonlySet<string> = new Set(
  KNOWN_EXTERNAL_LIFECYCLE_TERMINAL_STATUSES,
);

export function normalizeExternalLifecycleTerminalStatus(status: string | null | undefined): string {
  return typeof status === "string" && knownExternalLifecycleTerminalStatusSet.has(status)
    ? status
    : UNKNOWN_EXTERNAL_LIFECYCLE_TERMINAL_STATUS;
}

export interface ExternalLifecycleSilenceGapRunSignals {
  lastUsefulActionAt: Date | string | null | undefined;
  lastOutputAt: Date | string | null | undefined;
  startedAt: Date | string | null | undefined;
}

/**
 * Compute the terminal silence gap in seconds for an external-lifecycle run,
 * using the exact `lastUsefulActionAt > lastOutputAt > startedAt` precedence
 * the dispatcher's staleness filter uses (heartbeat.ts:
 * startNextQueuedRunForAgent). Returns null when no signal timestamp is
 * available at all (e.g. a queued/scheduled_retry run cancelled before it
 * ever started) — callers must skip observing in that case rather than
 * recording a meaningless gap against `finalizedAt`.
 */
export function computeExternalLifecycleSilenceGapSeconds(
  run: ExternalLifecycleSilenceGapRunSignals,
  finalizedAt: Date,
): number | null {
  const signalAt = run.lastUsefulActionAt ?? run.lastOutputAt ?? run.startedAt;
  if (!signalAt) return null;
  const signalMs = new Date(signalAt).getTime();
  if (!Number.isFinite(signalMs)) return null;
  return Math.max(0, (finalizedAt.getTime() - signalMs) / 1000);
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

/**
 * Outcome-side per-agent liveness gauges (BLO-23413).
 *
 * Every alert on this fleet prior to these watched a CAUSE (a K8s Job or pod
 * failing). None watched the OUTCOME: an agent that has simply stopped
 * executing. A cause-side alert clears the moment the Job is reaped, so an
 * agent that dies after its Job/pod signal disappears stays dark with
 * nothing firing (see the BLO-23413 incident: 12.5h undetected). These three
 * gauges make that outcome directly observable and alertable without reading
 * the agent's DB record.
 *
 * `agent_id` cardinality here is bounded by the real `agents` table roster
 * (the publisher iterates committed rows itself), not by caller-supplied
 * input, so it does not need the normalize-to-"unknown" guard the
 * request-driven counters above use.
 */
export const AGENT_HEARTBEAT_AGE_SECONDS_METRIC = "paperclip_agent_heartbeat_age_seconds";
/**
 * The agent's own configured `heartbeat.intervalSec`, republished as a gauge
 * so an alert can threshold the age metric as a MULTIPLE of each agent's own
 * interval (`age > N * interval`) with a single PromQL `on(agent_id)` join,
 * rather than hard-coding one fleet-wide threshold that is wrong for every
 * agent not running the modal interval.
 */
export const AGENT_HEARTBEAT_INTERVAL_SECONDS_METRIC = "paperclip_agent_heartbeat_interval_seconds";
/**
 * Seconds the agent has continuously held `status = 'error'`, 0 otherwise.
 * `error` is not a scheduling gate (it is assignable/invokable, see
 * agent-eligibility.ts) so this is diagnostic time-in-state, not an outage
 * signal by itself -- it exists to answer "how long has this been true"
 * fleet-wide from Prometheus rather than by reading each agent record.
 * `agents` has no dedicated `status`-transition timestamp, so this uses
 * `updatedAt` as the best-available proxy for when `error` was entered; any
 * other write to the row while still in `error` would reset the apparent
 * start, making this a slight underestimate, never an overestimate.
 */
export const AGENT_ERROR_DURATION_SECONDS_METRIC = "paperclip_agent_status_error_duration_seconds";

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
let heartbeatTimerSchedulerExclusion: Counter<"reason"> | null = null;
let agentZeroTokenCompletedRunStreak: Gauge<"agent_id" | "adapter"> | null = null;
let externalRuntimeReservationEvents: Counter<"event"> | null = null;
let externalRuntimeReservationsActive: Gauge | null = null;
let externalRuntimeReservationOldestAge: Gauge | null = null;
let queuedRunAgeMetricsRefreshSuccess: Gauge | null = null;
let externalRuntimeReservationStrandedOldestAge: Gauge<"agent_id"> | null = null;
let externalRuntimeReservationStrandMetricsRefreshSuccess: Gauge | null = null;
let processLostTotal: Counter<"adapter" | "error_bucket" | "classification"> | null = null;
let externalLifecycleRunningRuns: Gauge<"adapter"> | null = null;
let externalLifecycleRunSilenceGap: Histogram<"adapter" | "status"> | null = null;
let externalLifecycleRunSilenceGapLast: Gauge<"adapter" | "status"> | null = null;
let processLostLivenessNull: Counter | null = null;
let orphanedManagedPodReaped: Counter<"adapter"> | null = null;
let githubReviewRequestDelivery: Counter<"state" | "reason"> | null = null;
let githubReviewRequestSuppression: Counter<"cause" | "reason"> | null = null;
let githubReviewRequestDeadLetterUnresolved: Gauge<"reason"> | null = null;
let githubReviewPosted: Counter<"repo" | "surface"> | null = null;
let githubReviewCompletion: Counter<"status"> | null = null;
let agentWakeupTerminalFailedUnresolved: Gauge<"error_code" | "scope"> | null = null;
let agentWakeupTerminalFailedOldestAge: Gauge<"scope"> | null = null;
let githubWorkflowRunConclusion: Counter<"conclusion" | "supersession"> | null = null;
let queuedRunOldestAge: Gauge<"agent_id"> | null = null;
let overdueScheduledRetryOldestAge: Gauge<"agent_id"> | null = null;
let overdueScheduledRetryAgeMetricsRefreshSuccess: Gauge | null = null;
let scheduledRetryParkHorizon: Gauge<"agent_id"> | null = null;
let scheduledRetryParkHorizonRefreshSuccess: Gauge | null = null;
let pluginError: Gauge<"plugin_id" | "plugin_key"> | null = null;
let pluginMetric: Counter<
  "plugin_id" | "plugin_key" | "metric" | PluginMetricPromotableTagKey
> | null = null;
let pluginMetricDropped: Counter<"plugin_id" | "plugin_key" | "reason" | "metric"> | null = null;

/**
 * Per-plugin ledger of `(metric, promoted-label-values)` combinations already
 * published, enforcing {@link PLUGIN_METRIC_CARDINALITY_BUDGET}.
 *
 * Keys are joined with a NUL, matching this file's existing composite-key
 * idiom. That is not cosmetic: with a printable separator two different
 * combinations can render to the same ledger key, and the second write then
 * reads as already-seen — so it consumes no budget slot and still publishes.
 * Every such collision buys a free series and the bound leaks. NUL cannot
 * appear in a Prometheus label value, so the key is injective.
 */
const pluginMetricCombinations = new Map<string, Set<string>>();

/**
 * Per-plugin ledger of metric *names* already published, enforcing
 * {@link PLUGIN_METRIC_NAME_BUDGET}. Kept separate from
 * {@link pluginMetricCombinations} because the two tiers bound different axes
 * and collapse to different targets — see PLUGIN_METRIC_CARDINALITY_BUDGET.
 */
const pluginMetricNames = new Map<string, Set<string>>();
let pluginStatusCollectorLastSuccess: Gauge<"role"> | null = null;
let prReviewQueueWait: Histogram | null = null;
let authRequest: Counter<"operation" | "outcome"> | null = null;
let gbrainRecallTotal: Counter<"status"> | null = null;
let agentHeartbeatAge: Gauge<"agent_id"> | null = null;
let agentHeartbeatInterval: Gauge<"agent_id"> | null = null;
let agentErrorDuration: Gauge<"agent_id"> | null = null;
let projectPrimaryWorkspaceFallback: Counter | null = null;
let backstopDeferredCandidates: Gauge<"source"> | null = null;
let backstopSweepCompleted: Counter<"source"> | null = null;
let backstopCandidatesSkipped: Counter<"source" | "reason"> | null = null;

function ensureRegistry(): {
  registry: Registry;
  counter: Counter<"agent_id" | "reason" | "isolation_mode">;
  isolatedStartedCounter: Counter<"agent_id" | "isolation_mode">;
  failedCounter: Counter<HeartbeatRunFailedLabel>;
  capacityDeferredCounter: Counter<"adapter" | "provider">;
  heartbeatTimerSchedulerExclusionCounter: Counter<"reason">;
  zeroTokenCompletedRunStreakGauge: Gauge<"agent_id" | "adapter">;
  externalRuntimeReservationEventsCounter: Counter<"event">;
  externalRuntimeReservationsActiveGauge: Gauge;
  externalRuntimeReservationOldestAgeGauge: Gauge;
  processLostTotalCounter: Counter<"adapter" | "error_bucket" | "classification">;
  externalLifecycleRunningRunsGauge: Gauge<"adapter">;
  externalLifecycleRunSilenceGapHistogram: Histogram<"adapter" | "status">;
  externalLifecycleRunSilenceGapLastGauge: Gauge<"adapter" | "status">;
  processLostLivenessNullCounter: Counter;
  orphanedManagedPodReapedCounter: Counter<"adapter">;
  githubReviewRequestDeliveryCounter: Counter<"state" | "reason">;
  githubReviewRequestSuppressionCounter: Counter<"cause" | "reason">;
  githubReviewRequestDeadLetterUnresolvedGauge: Gauge<"reason">;
  githubReviewPostedCounter: Counter<"repo" | "surface">;
  githubReviewCompletionCounter: Counter<"status">;
  agentWakeupTerminalFailedUnresolvedGauge: Gauge<"error_code" | "scope">;
  agentWakeupTerminalFailedOldestAgeGauge: Gauge<"scope">;
  githubWorkflowRunConclusionCounter: Counter<"conclusion" | "supersession">;
  queuedRunOldestAgeGauge: Gauge<"agent_id">;
  queuedRunAgeMetricsRefreshSuccessGauge: Gauge;
  overdueScheduledRetryOldestAgeGauge: Gauge<"agent_id">;
  overdueScheduledRetryAgeMetricsRefreshSuccessGauge: Gauge;
  scheduledRetryParkHorizonGauge: Gauge<"agent_id">;
  scheduledRetryParkHorizonRefreshSuccessGauge: Gauge;
  pluginErrorGauge: Gauge<"plugin_id" | "plugin_key">;
  pluginMetricCounter: Counter<
    "plugin_id" | "plugin_key" | "metric" | PluginMetricPromotableTagKey
  >;
  pluginMetricDroppedCounter: Counter<"plugin_id" | "plugin_key" | "reason" | "metric">;
  pluginStatusCollectorLastSuccessGauge: Gauge<"role">;
  externalRuntimeReservationStrandedOldestAgeGauge: Gauge<"agent_id">;
  externalRuntimeReservationStrandMetricsRefreshSuccessGauge: Gauge;
  prReviewQueueWaitHistogram: Histogram;
  authRequestCounter: Counter<"operation" | "outcome">;
  gbrainRecallCounter: Counter<"status">;
  agentHeartbeatAgeGauge: Gauge<"agent_id">;
  agentHeartbeatIntervalGauge: Gauge<"agent_id">;
  agentErrorDurationGauge: Gauge<"agent_id">;
  projectPrimaryWorkspaceFallbackCounter: Counter;
  backstopDeferredCandidatesGauge: Gauge<"source">;
  backstopSweepCompletedCounter: Counter<"source">;
  backstopCandidatesSkippedCounter: Counter<"source" | "reason">;
} {
  if (
    !registry
    || !concurrentRunBlocked
    || !isolatedRunStarted
    || !heartbeatRunFailed
    || !ccrotateCapacityDeferred
    || !heartbeatTimerSchedulerExclusion
    || !agentZeroTokenCompletedRunStreak
    || !externalRuntimeReservationEvents
    || !externalRuntimeReservationsActive
    || !externalRuntimeReservationOldestAge
    || !queuedRunAgeMetricsRefreshSuccess
    || !externalRuntimeReservationStrandedOldestAge
    || !externalRuntimeReservationStrandMetricsRefreshSuccess
    || !processLostTotal
    || !externalLifecycleRunningRuns
    || !externalLifecycleRunSilenceGap
    || !externalLifecycleRunSilenceGapLast
    || !processLostLivenessNull
    || !orphanedManagedPodReaped
    || !githubReviewRequestDelivery
    || !githubReviewRequestSuppression
    || !githubReviewRequestDeadLetterUnresolved
    || !githubReviewPosted
    || !githubReviewCompletion
    || !agentWakeupTerminalFailedUnresolved
    || !agentWakeupTerminalFailedOldestAge
    || !githubWorkflowRunConclusion
    || !queuedRunOldestAge
    || !overdueScheduledRetryOldestAge
    || !overdueScheduledRetryAgeMetricsRefreshSuccess
    || !scheduledRetryParkHorizon
    || !scheduledRetryParkHorizonRefreshSuccess
    || !pluginError
    || !pluginMetric
    || !pluginMetricDropped
    || !pluginStatusCollectorLastSuccess
    || !prReviewQueueWait
    || !authRequest
    || !gbrainRecallTotal
    || !agentHeartbeatAge
    || !agentHeartbeatInterval
    || !agentErrorDuration
    || !projectPrimaryWorkspaceFallback
    || !backstopDeferredCandidates
    || !backstopSweepCompleted
    || !backstopCandidatesSkipped
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
    heartbeatTimerSchedulerExclusion = new Counter({
      name: HEARTBEAT_TIMER_SCHEDULER_EXCLUSION_METRIC,
      help:
        "Count of due heartbeat timer ticks excluded before dispatch, labeled by a bounded "
        + "operational reason. Each increment has durable evidence in agent_wakeup_requests "
        + "or a scheduled_retry heartbeat run.",
      labelNames: ["reason"],
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
    queuedRunAgeMetricsRefreshSuccess = new Gauge({
      name: QUEUED_RUN_AGE_METRICS_REFRESH_SUCCESS_METRIC,
      help:
        "1 when the most recent queued-run-age database refresh completed before metrics exposition; "
        + "0 when it failed, so stale queued-run ages cannot be read as fresh.",
      registers: [registry],
    });
    queuedRunAgeMetricsRefreshSuccess.set(0);
    scheduledRetryParkHorizon = new Gauge({
      name: SCHEDULED_RETRY_PARK_HORIZON_METRIC,
      help: "Booked scheduled_retry park horizon in seconds, by agent.",
      labelNames: ["agent_id"],
      registers: [registry],
    });
    scheduledRetryParkHorizonRefreshSuccess = new Gauge({
      name: SCHEDULED_RETRY_PARK_HORIZON_REFRESH_SUCCESS_METRIC,
      help: "1 when the scheduled_retry park horizon database refresh succeeded, otherwise 0.",
      registers: [registry],
    });
    scheduledRetryParkHorizonRefreshSuccess.set(0);
    externalRuntimeReservationStrandedOldestAge = new Gauge({
      name: EXTERNAL_RUNTIME_RESERVATION_STRANDED_OLDEST_AGE_METRIC,
      help:
        "Age in seconds of the oldest STRANDED unreleased external-runtime reservation for an agent "
        + "(BLO-28865). Stranded means the reservation's heartbeat run is already terminal, or the run "
        + "is non-terminal but has emitted nothing past the hard-stale floor. A legitimately "
        + "long-running run is neither, so it contributes 0 -- that is the whole point, and the reason "
        + "this exists alongside " + EXTERNAL_RUNTIME_RESERVATION_OLDEST_AGE_METRIC + " rather than "
        + "being a threshold over it: that gauge is unlabelled and measures age alone, which cannot "
        + "distinguish a wedge from a long run. Reset-then-set every refresh so an agent whose "
        + "reservation is released reads back an explicit 0 rather than a frozen stale value or an "
        + "absent series (an absent series and 'nothing stuck' render identically). Labeled by bounded "
        + "agent_id so the alert names who is wedged.",
      labelNames: ["agent_id"],
      registers: [registry],
    });
    externalRuntimeReservationStrandMetricsRefreshSuccess = new Gauge({
      name: EXTERNAL_RUNTIME_RESERVATION_STRAND_METRICS_REFRESH_SUCCESS_METRIC,
      help:
        "1 when the most recent stranded-reservation database refresh completed before metrics "
        + "exposition; 0 when it failed, so stale strand ages cannot be read as fresh.",
      registers: [registry],
    });
    externalRuntimeReservationStrandMetricsRefreshSuccess.set(0);
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
    externalLifecycleRunSilenceGap = new Histogram({
      name: EXTERNAL_LIFECYCLE_RUN_SILENCE_GAP_METRIC,
      help:
        "Terminal silence gap in seconds for external-lifecycle runs (BLO-20815): "
        + "finalizedAt minus the same lastUsefulActionAt > lastOutputAt > startedAt "
        + "signal the dispatcher's staleness filter uses. Labeled by bounded adapter "
        + "and terminal status; read the status=\"succeeded\" population's p99 against "
        + "EXTERNAL_LIFECYCLE_HARD_STALE_MS (45m) to judge whether a shorter destructive-"
        + "kill floor leaves a safe margin.",
      labelNames: ["adapter", "status"],
      buckets: EXTERNAL_LIFECYCLE_RUN_SILENCE_GAP_BUCKETS_SECONDS,
      registers: [registry],
    });
    externalLifecycleRunSilenceGapLast = new Gauge({
      name: EXTERNAL_LIFECYCLE_RUN_SILENCE_GAP_LAST_METRIC,
      help:
        "Last-observed silence-gap seconds per adapter/status, companion to "
        + EXTERNAL_LIFECYCLE_RUN_SILENCE_GAP_METRIC + " (BLO-20815): a classic "
        + "Histogram cannot expose an exact max (values above the last finite "
        + "bucket collapse into +Inf). Read the true rolling max via "
        + "max_over_time(...[7d]) against this gauge instead.",
      labelNames: ["adapter", "status"],
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
    githubReviewRequestDelivery = new Counter({
      name: GITHUB_REVIEW_REQUEST_DELIVERY_METRIC,
      help:
        "Count of GitHub review-request reviewer-wake deliveries by funnel state "
        + "(received/queued/suppressed/deferred/retried/dead_lettered) and bounded wake reason "
        + "(BLO-18859). 'received' counts deliveries that cleared every suppression gate "
        + "and are about to dispatch (NOT raw arrivals); 'queued' means a durable "
        + "agent_wakeup_requests row committed AND a run was actually enqueued; "
        + "'suppressed' means a scheduling gate declined the wake (skipped row, no run, "
        + "terminal) — see "
        + GITHUB_REVIEW_REQUEST_SUPPRESSION_METRIC
        + " for which gate; 'deferred' means the provider-capacity gate parked it as a "
        + "scheduled_retry run (late, NOT lost, and NOT terminal); 'retried' counts each "
        + "re-dispatch attempt after a transient "
        + "failure; 'dead_lettered' means terminally lost without operator action "
        + "(dispatch_failed_exhausted, or the durable safety-net write itself failing). "
        + "In steady state received ~= queued and suppressed/deferred/dead_lettered are flat at zero.",
      labelNames: ["state", "reason"],
      registers: [registry],
    });
    // Zero-initialize the full bounded grid so every series is present from
    // process start. Without this, prom-client omits a never-incremented series
    // entirely and a healthy fleet renders as "No data" on the funnel panel —
    // indistinguishable from a broken scrape. It matters most for
    // `dead_lettered`, where absent-vs-zero is exactly the difference between
    // "nothing was lost" and "we cannot tell". 6 states x 8 reasons = 48
    // constant-zero series, which is negligible next to the roster-scaled
    // counters above.
    for (const state of KNOWN_GITHUB_DELIVERY_STATES) {
      for (const reason of [...KNOWN_GITHUB_WAKE_REASONS, UNKNOWN_GITHUB_WAKE_REASON]) {
        githubReviewRequestDelivery.inc({ state, reason }, 0);
      }
    }
    githubReviewRequestSuppression = new Counter({
      name: GITHUB_REVIEW_REQUEST_SUPPRESSION_METRIC,
      help:
        "Cause breakdown of GitHub review-request reviewer wakes that ended in the terminal "
        + "'suppressed' state (BLO-18859). Equals "
        + "paperclip_github_review_request_delivery_total{state=\"suppressed\"} by construction. "
        + "Every cause but 'dispatch_rejected'/'reviewer_lock_contended'/'other' is a literal "
        + "agent_wakeup_requests.reason on the durable skipped row, so a firing series joins "
        + "straight back to rows; those three wrote no row, which is precisely why they are "
        + "counted here. Alert on outage-like causes only (heartbeat.scheduling_suppressed, "
        + "dispatch_rejected, reviewer_lock_contended, other); the rest — an inactive "
        + "company, a cooldown, wake-on-demand off, a blocked budget, a non-invokable agent — "
        + "are the fleet correctly declining and must not page.",
      labelNames: ["cause", "reason"],
      registers: [registry],
    });
    // Only the pageable causes are zero-initialized -- see
    // ALERTING_GITHUB_SUPPRESSION_CAUSES for why the expected declines are not.
    for (const cause of ALERTING_GITHUB_SUPPRESSION_CAUSES) {
      for (const reason of [...KNOWN_GITHUB_WAKE_REASONS, UNKNOWN_GITHUB_WAKE_REASON]) {
        githubReviewRequestSuppression.inc({ cause, reason }, 0);
      }
    }
    githubReviewRequestDeadLetterUnresolved = new Gauge({
      name: GITHUB_REVIEW_REQUEST_DEAD_LETTER_UNRESOLVED_METRIC,
      help:
        "Current count of GitHub review-request wakes sitting in the durable terminal "
        + "dispatch_failed_exhausted state within the recency window, re-derived from "
        + "agent_wakeup_requests on every heartbeat scheduler tick (BLO-18859 review "
        + "follow-up; moved off the wake-dispatch reconcile pass in BLO-31335). Published "
        + "by EVERY replica and identical on each, because it is a full rewrite of global "
        + "DB-derived state -- aggregate across pods with max by (reason), never a bare "
        + "sum, which multiplies by the replica count. This is the restart-safe companion to "
        + "paperclip_github_review_request_delivery_total{state=\"dead_lettered\"}: that "
        + "counter is process-local, so a dead letter recorded before the first scrape has "
        + "no baseline to increase() against, and a pod replacement retires the series "
        + "before a pending `for` can elapse. This gauge is recomputed from committed rows, "
        + "so it survives both. It does NOT cover the no-row failure path (the safety-net "
        + "insert itself failing) -- that leaves nothing durable to count and is visible "
        + "only on the counter, which is why the alert keys on both.",
      labelNames: ["reason"],
      registers: [registry],
    });
    // Zero-initialize the bounded reason set for the same absent-vs-zero reason
    // as the funnel counter: on a healthy fleet this gauge is flat zero, and a
    // missing series would render identically to a stalled reconciler.
    for (const reason of [...KNOWN_GITHUB_WAKE_REASONS, UNKNOWN_GITHUB_WAKE_REASON]) {
      githubReviewRequestDeadLetterUnresolved.set({ reason }, 0);
    }
    githubReviewPosted = new Counter({
      name: GITHUB_REVIEW_POSTED_METRIC,
      help:
        "Count of PR reviews the configured reviewer identity actually PUBLISHED to GitHub, "
        + "observed from the signed webhook once per delivery (BLO-27608). This is the "
        + "OUTPUT-side companion to "
        + GITHUB_REVIEW_REQUEST_DELIVERY_METRIC
        + ", which is entirely request-side and reads healthy through a total review blackout "
        + "(the runs enqueue and dispatch, then die at the model call producing no artifact). "
        + "surface='formal' is a pull_request_review.submitted event; surface='comment' is an "
        + "issue_comment carrying Ally's consolidated-review heading — both are counted because "
        + "Ally uses both and either alone under-reports. Scoped to the reviewer identity only: "
        + "a human review must not hold the drought alert down. Redeliveries may double-count; "
        + "this counter is built to separate zero from non-zero, not to be an exact tally.",
      labelNames: ["repo", "surface"],
      registers: [registry],
    });
    // Zero-initialize both surfaces under the placeholder repo. This is not
    // cosmetic here, it is what makes the drought alert able to fire at all:
    // `PaperclipGithubReviewOutputDrought` keys on
    // `sum(increase(paperclip_github_review_posted_total[2h])) == 0`, and an
    // ABSENT series makes that inner expression an empty vector, so the `and`
    // yields nothing and the alert stays silent. Absent and zero are the same
    // rendering and opposite meanings, and the case where they diverge — no
    // review has been posted since this pod started — is exactly the outage.
    // 2 constant-zero series.
    for (const surface of KNOWN_GITHUB_REVIEW_SURFACES) {
      githubReviewPosted.inc({ repo: UNKNOWN_GITHUB_REVIEW_REPO, surface }, 0);
    }
    githubReviewCompletion = new Counter({
      name: GITHUB_REVIEW_COMPLETION_METRIC,
      help:
        "Terminal verdict of each reviewer run's completion evidence (BLO-27608), recorded "
        + "after the authoritative GitHub re-verification the call sites apply. Distinguishes a "
        + "DELIBERATE non-post — self_review_skipped (Ally declining to review its own PR, "
        + "BLO-9293), already_reviewed, archived_repo_skipped — from a FAILURE to produce output "
        + "(missing). Without that split, intentional-skip volume is indistinguishable from a "
        + "genuine drought on "
        + GITHUB_REVIEW_POSTED_METRIC
        + ". auth_expired is a recoverable fault that is retried rather than either. A run that "
        + "dies before completing never reaches a verdict, so an outage is silence here too.",
      labelNames: ["status"],
      registers: [registry],
    });
    // Same absent-vs-zero reasoning as above, over the closed verdict set: a
    // healthy fleet must render 0 on the skip/failure panels rather than "No
    // data". 7 constant-zero series.
    for (const status of [
      ...KNOWN_GITHUB_REVIEW_COMPLETION_STATUSES,
      UNKNOWN_GITHUB_REVIEW_COMPLETION_STATUS,
    ]) {
      githubReviewCompletion.inc({ status }, 0);
    }
    agentWakeupTerminalFailedUnresolved = new Gauge({
      name: AGENT_WAKEUP_TERMINAL_FAILED_UNRESOLVED_METRIC,
      help:
        "Current count of agent_wakeup_requests rows sitting in the terminal "
        + "status='failed' state within the recency window, with no successor wake for "
        + "the same taskKey, re-derived from committed rows on every heartbeat scheduler "
        + "tick (BLO-20255; moved off the wake-dispatch reconcile pass in BLO-31335). "
        + "Published by EVERY replica and identical on each, because it is a full rewrite "
        + "of global DB-derived state -- aggregate across pods with "
        + "max by (error_code, scope), never a bare sum. Distinct from the dispatch "
        + "dead-letter gauge "
        + GITHUB_REVIEW_REQUEST_DEAD_LETTER_UNRESOLVED_METRIC
        + ": 'failed' means the wake dispatched and the RUN died "
        + "(Job force-terminated, Job failed, adapter threw), whereas "
        + "dispatch_failed_exhausted means the dispatch chain itself burned its retry "
        + "budget. reconcileFailedWakeDispatches only selects dispatch_failed, so a "
        + "'failed' row is never re-driven -- it is terminal AND, before this gauge, "
        + "invisible. `error_code` is joined from heartbeat_runs.error_code via "
        + "agent_wakeup_requests.run_id (the wake table has no error_code column of its "
        + "own); 'none' means no run row or no code recorded, 'other' means a code not "
        + "yet in KNOWN_TERMINAL_FAILED_WAKE_ERROR_CODES. `scope` is 'pr_review' when the "
        + "row's payload taskKey is pr_review:<repo>:<pr>. Rows the BLO-18030 bounded "
        + "retry re-queued drop out via the successor-wake exclusion, so a retried row "
        + "never shows here. In steady state this is flat at zero.",
      labelNames: ["error_code", "scope"],
      registers: [registry],
    });
    // Zero-initialize the full bounded grid, same absent-vs-zero reasoning as
    // the dead-letter gauge above: a healthy fleet must render 0, not "No
    // data", or a stalled reconciler is indistinguishable from a clean one.
    // 8 codes x 2 scopes = 16 constant-zero series.
    for (
      const errorCode of [
        ...KNOWN_TERMINAL_FAILED_WAKE_ERROR_CODES,
        UNKNOWN_TERMINAL_FAILED_WAKE_ERROR_CODE,
        TERMINAL_FAILED_WAKE_ERROR_CODE_NONE,
      ]
    ) {
      for (const scope of TERMINAL_FAILED_WAKE_SCOPES) {
        agentWakeupTerminalFailedUnresolved.set({ error_code: errorCode, scope }, 0);
      }
    }
    agentWakeupTerminalFailedOldestAge = new Gauge({
      name: AGENT_WAKEUP_TERMINAL_FAILED_OLDEST_AGE_METRIC,
      help:
        "Age in seconds of the OLDEST agent_wakeup_requests row still sitting in the "
        + "terminal status='failed' state for this scope, with no successor wake for the "
        + "same taskKey, re-derived on every heartbeat scheduler tick (BLO-20255; moved "
        + "off the wake-dispatch reconcile pass in BLO-31335). Published by EVERY replica "
        + "and identical on each; aggregate across pods with max by (scope). 0 "
        + "means the scope has no unresolved terminal-failed wake. Alert on THIS rather "
        + "than on a `for:` clause over "
        + AGENT_WAKEUP_TERMINAL_FAILED_UNRESOLVED_METRIC
        + ": `for:` measures continuity of the expression, not the age of any one row, so "
        + "two short failures overlapping by a single scrape keep a summed expression "
        + "true and page for a row that is only seconds old. This gauge carries the real "
        + "per-row age, so the rule can threshold it directly and use `for:` only to ride "
        + "out scrape flapping. Labeled by scope only -- adding error_code would let a "
        + "scope's oldest row hide behind a younger row of another code.",
      labelNames: ["scope"],
      registers: [registry],
    });
    // Zero-initialize both scopes for the same absent-vs-zero reason as above.
    for (const scope of TERMINAL_FAILED_WAKE_SCOPES) {
      agentWakeupTerminalFailedOldestAge.set({ scope }, 0);
    }
    githubWorkflowRunConclusion = new Counter({
      name: GITHUB_WORKFLOW_RUN_CONCLUSION_METRIC,
      help:
        "Count of completed GitHub Actions workflow_run webhook deliveries, labeled by "
        + "bounded conclusion and, for cancelled, whether a newer run on the same branch "
        + "already superseded it (BLO-21078). One increment per completed run regardless "
        + "of whether it matched a paperclip identifier. "
        + "`increase(...{conclusion=\"cancelled\",supersession=\"none\"}[window])` catches a "
        + "fleet-wide mass-cancellation wave without also tripping on ordinary "
        + "cancel-in-progress force-push churn, which carries supersession=\"superseded\".",
      labelNames: ["conclusion", "supersession"],
      registers: [registry],
    });
    for (const conclusion of [...KNOWN_WORKFLOW_RUN_CONCLUSIONS, UNKNOWN_WORKFLOW_RUN_CONCLUSION]) {
      for (const supersession of KNOWN_WORKFLOW_RUN_SUPERSESSIONS) {
        githubWorkflowRunConclusion.inc({ conclusion, supersession }, 0);
      }
    }
    queuedRunOldestAge = new Gauge({
      name: QUEUED_RUN_OLDEST_AGE_METRIC,
      help:
        "Age in seconds of the oldest `queued` heartbeat run for an agent (BLO-21116). "
        + "Refreshed on scrape from a live MIN(coalesce(queued_at, created_at)) aggregate, not a Prometheus "
        + "`for:` clause -- same reasoning as " + AGENT_WAKEUP_TERMINAL_FAILED_OLDEST_AGE_METRIC
        + ": `for:` measures how long the alert expression has been true, not the age of "
        + "any one row. Reset-then-set every refresh (see setQueuedRunOldestAgeMetrics) so an "
        + "agent whose queue drains to empty reads back an explicit 0 rather than a frozen "
        + "stale value or an absent series. Labeled by bounded agent_id.",
      labelNames: ["agent_id"],
      registers: [registry],
    });
    overdueScheduledRetryOldestAge = new Gauge({
      name: OVERDUE_SCHEDULED_RETRY_OLDEST_AGE_METRIC,
      help:
        "Age in seconds past due time of the oldest overdue `scheduled_retry` heartbeat "
        + "run for an agent (BLO-22094). `status='queued'` age is covered by "
        + QUEUED_RUN_OLDEST_AGE_METRIC + "; that gauge deliberately excludes "
        + "`scheduled_retry` rows (Ally review, onprem-k8s#2013), so a retry that is "
        + "parked and never promoted was invisible to any gauge. This one closes that "
        + "gap: refreshed on scrape from a live MIN(scheduled_retry_at) aggregate over "
        + "rows where status='scheduled_retry' AND scheduled_retry_at < now(), so a run "
        + "still backing off (due time in the future) contributes nothing. Reset-then-set "
        + "every refresh (see setOverdueScheduledRetryAgeMetrics) so an agent with no "
        + "overdue parked run reads back an explicit 0. Labeled by bounded agent_id.",
      labelNames: ["agent_id"],
      registers: [registry],
    });
    overdueScheduledRetryAgeMetricsRefreshSuccess = new Gauge({
      name: OVERDUE_SCHEDULED_RETRY_AGE_METRICS_REFRESH_SUCCESS_METRIC,
      help:
        "1 when the most recent overdue-scheduled_retry-age database refresh completed "
        + "before metrics exposition; 0 when it failed, so stale overdue-parked ages "
        + "cannot be read as fresh. Separate from "
        + QUEUED_RUN_AGE_METRICS_REFRESH_SUCCESS_METRIC
        + " because the two refreshes run different aggregates against different indexes "
        + "and can fail independently.",
      registers: [registry],
    });
    overdueScheduledRetryAgeMetricsRefreshSuccess.set(0);
    pluginError = new Gauge({
      name: PLUGIN_ERROR_METRIC,
      help:
        "1 while an installed plugin sits in status='error', 0 otherwise "
        + "(BLO-21092). Labeled by plugin_id and plugin_key only -- status is "
        + "deliberately NOT a label, so a plugin flipping status rewrites this "
        + "series' value instead of orphaning an old status=X series that "
        + "prom-client would never retire on its own. Re-derived from the "
        + "plugins table on every worker-tier collector tick; 'disabled' is "
        + "distinct from 'error' and never sets this to 1, so an operator-"
        + "disabled plugin does not page.",
      labelNames: ["plugin_id", "plugin_key"],
      registers: [registry],
    });
    pluginMetric = new Counter({
      name: PLUGIN_METRIC_TOTAL_METRIC,
      help:
        "Plugin-contributed metric increments from ctx.metrics.write (PEN-2799). "
        + "The plugin's own metric name is the 'metric' LABEL, not part of this "
        + "series name -- plugins build metric names by interpolation, so "
        + "name-mapping would let any installed plugin mint arbitrary "
        + "paperclip_* series. Tag keys become labels only when present in BOTH "
        + "the plugin manifest's metricLabels and "
        + "PLUGIN_METRIC_PROMOTABLE_TAG_KEYS; unpromoted tags stay on the "
        + "plugin_logs row. company_id is deliberately not a label (unbounded "
        + "per tenant). Two cardinality tiers degrade on DIFFERENT axes: past "
        + "the per-plugin tag-value budget a write keeps its 'metric' label and "
        + "drops its promoted labels, so a rule matching metric=\"<name>\" keeps "
        + "working and sum by (metric) stays exact; only a plugin exceeding the "
        + "much tighter metric-NAME budget collapses to metric=\""
        + PLUGIN_METRIC_OVERFLOW_NAME + "\". Nothing is ever discarded.",
      labelNames: [
        "plugin_id",
        "plugin_key",
        "metric",
        ...PLUGIN_METRIC_PROMOTABLE_TAG_KEYS,
      ],
      registers: [registry],
    });
    pluginMetricDropped = new Counter({
      name: PLUGIN_METRIC_DROPPED_METRIC,
      help:
        "Plugin metric writes not published as-submitted, by reason "
        + "(PEN-2799): 'bad_name' (name failed shape/length validation), "
        + "'bad_value' (non-finite or negative -- ctx.metrics.write is a "
        + "counter increment), 'label_budget' (per-plugin tag-value budget "
        + "exhausted, so the promoted labels were dropped but the increment "
        + "still landed on the metric's own series -- totals stay correct, only "
        + "the per-tag breakdown is lost), 'name_budget' (the plugin exceeded "
        + "its metric-NAME budget, so this write folded into the overflow "
        + "series). A drop is never silent: this is the series that answers "
        + "'why is my plugin metric missing', which otherwise required reading "
        + "host source. The 'metric' label is populated ONLY for the two budget "
        + "reasons, where its cardinality is already bounded: 'label_budget' "
        + "carries the real name (it cleared the name budget, so it is one of "
        + "at most " + String(PLUGIN_METRIC_NAME_BUDGET) + "), and 'name_budget' "
        + "carries \"" + PLUGIN_METRIC_OVERFLOW_NAME + "\" -- NOT the rejected "
        + "name, which is by definition the unbounded thing that tier is "
        + "refusing. 'bad_name' and 'bad_value' leave it empty for the same "
        + "reason: a rejected name must never become a label value.",
      labelNames: ["plugin_id", "plugin_key", "reason", "metric"],
      registers: [registry],
    });
    pluginStatusCollectorLastSuccess = new Gauge({
      name: PLUGIN_STATUS_COLLECTOR_LAST_SUCCESS_METRIC,
      help:
        "Unix timestamp (seconds) of the plugin-status collector's last "
        + "successful tick (BLO-21092). Set ONLY on success; a listInstalled() "
        + "rejection -- first tick or any later one -- leaves this unchanged, so "
        + PLUGIN_ERROR_METRIC + " can keep serving a stale or (on a first-tick "
        + "failure) entirely absent snapshot while looking otherwise healthy. "
        + "Labeled by a constant role=\"worker\" -- not for cardinality, but "
        + "because a bare (zero-label) Gauge auto-publishes at value 0 the "
        + "moment ensureRegistry constructs it, with no .set() call required, "
        + "which would freeze this series at 0 forever on the API tier (which "
        + "never starts the collector) and permanently false-fire a "
        + "(time() - this) alert there. A labeled Gauge renders no series "
        + "until first .set(), which startPluginStatusCollector does once, "
        + "itself, immediately before its first tick -- so the series exists "
        + "(and reads maximally stale) only on the tier that can refresh it.",
      labelNames: ["role"],
      registers: [registry],
    });
    prReviewQueueWait = new Histogram({
      name: PR_REVIEW_QUEUE_WAIT_METRIC,
      help:
        "Seconds from creation until start for heartbeat runs with a pr_review: task key. "
        + "Observed once at the guarded queued-to-running transition; no repo, PR, agent, or other unbounded labels.",
      buckets: PR_REVIEW_QUEUE_WAIT_BUCKETS_SECONDS,
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
    gbrainRecallTotal = new Counter({
      name: GBRAIN_RECALL_METRIC,
      help:
        "Count of gbrain-context recall-prefetch outcomes (BLO-25892), labeled by bounded "
        + "status (ok/no-issue-page/empty/island/skipped/error/other). Incremented at the "
        + "pluginStateStore.set write path, once per agent.run.started prefetch. Detects a "
        + "recall outage independent of gbrain-mcp container restart count -- see "
        + GBRAIN_RECALL_METRIC + "'s doc comment for the 2026-08-08 incident this closes.",
      labelNames: ["status"],
      registers: [registry],
    });
    for (const status of [...KNOWN_GBRAIN_RECALL_STATUSES, UNKNOWN_GBRAIN_RECALL_STATUS]) {
      gbrainRecallTotal.inc({ status }, 0);
    }
    agentHeartbeatAge = new Gauge({
      name: AGENT_HEARTBEAT_AGE_SECONDS_METRIC,
      help:
        "Seconds since the agent's lastHeartbeatAt, labeled by agent_id, published only for "
        + "agents with heartbeat.enabled=true (BLO-23413). Outcome-side: unlike every prior "
        + "agent alert, this does not depend on any K8s Job/pod signal surviving, so it stays "
        + "correct even after the Job that last ran the agent has been reaped. Read alongside "
        + AGENT_HEARTBEAT_INTERVAL_SECONDS_METRIC
        + " to threshold as a multiple of the agent's OWN configured interval rather than one "
        + "fleet-wide constant.",
      labelNames: ["agent_id"],
      registers: [registry],
    });
    agentHeartbeatInterval = new Gauge({
      name: AGENT_HEARTBEAT_INTERVAL_SECONDS_METRIC,
      help:
        "The agent's own configured heartbeat.intervalSec, republished as a gauge so "
        + AGENT_HEARTBEAT_AGE_SECONDS_METRIC
        + " can be thresholded per-agent via `on(agent_id)` join instead of one fleet-wide "
        + "constant that is wrong for every agent not on the modal interval (BLO-23413).",
      labelNames: ["agent_id"],
      registers: [registry],
    });
    agentErrorDuration = new Gauge({
      name: AGENT_ERROR_DURATION_SECONDS_METRIC,
      help:
        "Seconds the agent has continuously held status='error', 0 otherwise, labeled by "
        + "agent_id, for every agent in the fleet (BLO-23413). 'error' is not a scheduling "
        + "gate -- it is assignable and invokable -- so this is diagnostic time-in-state, not "
        + "an outage signal on its own. Uses updatedAt as the best-available proxy for when "
        + "error was entered (agents has no dedicated status-transition timestamp), so a "
        + "concurrent unrelated write to the row understates rather than overstates the age.",
      labelNames: ["agent_id"],
      registers: [registry],
    });
    projectPrimaryWorkspaceFallback = new Counter({
      name: PROJECT_PRIMARY_WORKSPACE_FALLBACK_METRIC,
      help:
        "Count of project primary-workspace resolutions that fell through to the "
        + "earliest-created workspace because no row was flagged isPrimary (BLO-26184). "
        + "Measured fleet exposure is 0/80 non-archived projects; a sustained non-zero "
        + "rate means a project has drifted into the ambiguous state. The offending "
        + "project_id is on the paired structured log line, not this series' labels.",
      registers: [registry],
    });
    projectPrimaryWorkspaceFallback.inc(0);
    backstopDeferredCandidates = new Gauge({
      name: BACKSTOP_DEFERRED_CANDIDATES_METRIC,
      help: "Current number of backstop candidates deferred beyond the page limit.",
      labelNames: ["source"],
      registers: [registry],
    });
    backstopSweepCompleted = new Counter({
      name: BACKSTOP_SWEEP_COMPLETED_METRIC,
      help: "Completed backstop sweeps, labeled by stream.",
      labelNames: ["source"],
      registers: [registry],
    });
    backstopCandidatesSkipped = new Counter({
      name: BACKSTOP_CANDIDATES_SKIPPED_METRIC,
      help: "Backstop candidates skipped by a bounded decision reason.",
      labelNames: ["source", "reason"],
      registers: [registry],
    });
    for (const source of BACKSTOP_SOURCES) {
      backstopDeferredCandidates.set({ source }, 0);
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
    heartbeatTimerSchedulerExclusionCounter: heartbeatTimerSchedulerExclusion,
    zeroTokenCompletedRunStreakGauge: agentZeroTokenCompletedRunStreak,
    externalRuntimeReservationEventsCounter: externalRuntimeReservationEvents,
    externalRuntimeReservationsActiveGauge: externalRuntimeReservationsActive,
    externalRuntimeReservationOldestAgeGauge: externalRuntimeReservationOldestAge,
    queuedRunAgeMetricsRefreshSuccessGauge: queuedRunAgeMetricsRefreshSuccess,
    externalRuntimeReservationStrandedOldestAgeGauge: externalRuntimeReservationStrandedOldestAge,
    externalRuntimeReservationStrandMetricsRefreshSuccessGauge:
      externalRuntimeReservationStrandMetricsRefreshSuccess,
    processLostTotalCounter: processLostTotal,
    externalLifecycleRunningRunsGauge: externalLifecycleRunningRuns,
    externalLifecycleRunSilenceGapHistogram: externalLifecycleRunSilenceGap,
    externalLifecycleRunSilenceGapLastGauge: externalLifecycleRunSilenceGapLast,
    processLostLivenessNullCounter: processLostLivenessNull,
    orphanedManagedPodReapedCounter: orphanedManagedPodReaped,
    githubReviewRequestDeliveryCounter: githubReviewRequestDelivery,
    githubReviewRequestSuppressionCounter: githubReviewRequestSuppression,
    githubReviewRequestDeadLetterUnresolvedGauge: githubReviewRequestDeadLetterUnresolved,
    githubReviewPostedCounter: githubReviewPosted,
    githubReviewCompletionCounter: githubReviewCompletion,
    agentWakeupTerminalFailedUnresolvedGauge: agentWakeupTerminalFailedUnresolved,
    agentWakeupTerminalFailedOldestAgeGauge: agentWakeupTerminalFailedOldestAge,
    githubWorkflowRunConclusionCounter: githubWorkflowRunConclusion,
    queuedRunOldestAgeGauge: queuedRunOldestAge,
    overdueScheduledRetryOldestAgeGauge: overdueScheduledRetryOldestAge,
    overdueScheduledRetryAgeMetricsRefreshSuccessGauge: overdueScheduledRetryAgeMetricsRefreshSuccess,
    scheduledRetryParkHorizonGauge: scheduledRetryParkHorizon,
    scheduledRetryParkHorizonRefreshSuccessGauge: scheduledRetryParkHorizonRefreshSuccess,
    pluginErrorGauge: pluginError,
    pluginMetricCounter: pluginMetric,
    pluginMetricDroppedCounter: pluginMetricDropped,
    pluginStatusCollectorLastSuccessGauge: pluginStatusCollectorLastSuccess,
    prReviewQueueWaitHistogram: prReviewQueueWait,
    authRequestCounter: authRequest,
    gbrainRecallCounter: gbrainRecallTotal,
    agentHeartbeatAgeGauge: agentHeartbeatAge,
    agentHeartbeatIntervalGauge: agentHeartbeatInterval,
    agentErrorDurationGauge: agentErrorDuration,
    projectPrimaryWorkspaceFallbackCounter: projectPrimaryWorkspaceFallback,
    backstopDeferredCandidatesGauge: backstopDeferredCandidates,
    backstopSweepCompletedCounter: backstopSweepCompleted,
    backstopCandidatesSkippedCounter: backstopCandidatesSkipped,
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

export function recordHeartbeatTimerSchedulerExclusion(reason: string | null | undefined): string {
  const normalized = normalizeHeartbeatTimerSchedulerExclusion(reason);
  ensureRegistry().heartbeatTimerSchedulerExclusionCounter.inc({ reason: normalized });
  return normalized;
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

/**
 * Last `adapter` label written per `agent_id` for
 * {@link AGENT_NO_USAGE_STREAK_METRIC} (BLO-21415).
 *
 * This gauge is written per-agent from that agent's own heartbeat finalization,
 * so there is no fleet-wide snapshot pass that could reset-then-set it the way
 * {@link setQueuedRunOldestAgeMetrics} does. That makes `adapter` a latching
 * label: `Gauge.set()` mints one child per (agent_id, adapter) pair and never
 * retires one, so an agent moved between adapters keeps exporting its OLD
 * adapter's child frozen at whatever value it last held. Frozen at or above the
 * alert threshold, that orphan fires `PaperclipAgentZeroTokenRunStreak` forever
 * while the agent's live series reads healthy -- and because the streak
 * saturates at the `listRecentTerminalRunsForZeroTokenStreak` LIMIT, the orphan
 * is pinned at exactly the value a maximally-wedged agent reports, so the alert
 * cannot be told apart from a real incident by its value either.
 *
 * Bounded by the same roster that bounds the label itself: at most one entry per
 * active agent id plus {@link UNKNOWN_AGENT_ID}.
 */
const zeroTokenStreakAdapterByAgentId = new Map<string, string>();

export function recordAgentZeroTokenCompletedRunStreak(
  input: RecordAgentZeroTokenCompletedRunStreakInput,
): { agent_id: string; adapter: string; streak: number } {
  const labels = {
    agent_id: normalizeAgentId(input.agentId, input.knownAgentIds),
    adapter: typeof input.adapter === "string" && input.adapter.length > 0 ? input.adapter : "unknown",
  };
  const streak = Number.isFinite(input.streak) ? Math.max(0, Math.floor(input.streak)) : 0;
  const gauge = ensureRegistry().zeroTokenCompletedRunStreakGauge;
  // Retire the previous adapter's child before minting the new one, so an agent
  // that changed adapterType stops exporting a frozen series under the old label.
  const previousAdapter = zeroTokenStreakAdapterByAgentId.get(labels.agent_id);
  if (previousAdapter !== undefined && previousAdapter !== labels.adapter) {
    gauge.remove({ agent_id: labels.agent_id, adapter: previousAdapter });
  }
  zeroTokenStreakAdapterByAgentId.set(labels.agent_id, labels.adapter);
  gauge.set(labels, streak);
  return { ...labels, streak };
}

const EXTERNAL_RUNTIME_RESERVATION_EVENTS = new Set([
  "reserved",
  "contended",
  "launching",
  "launched",
  "released",
  // BLO-28865. Distinct from every other label here: the rest are lifecycle
  // transitions, this one is a fault -- a launch arriving under a Job name the
  // reservation was not launched with (the adapter-type strand). It is
  // enumerated rather than left to fall through to "other" precisely so it can
  // be alerted and graphed on its own.
  "name_mismatch",
]);

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
 * Publish the oldest queued-run age per known agent. Reset-then-set is
 * deliberate: an agent whose queue drains must read 0 rather than retaining a
 * stale age that would keep the stranded-run alert open forever.
 */
export function setQueuedRunOldestAgeMetrics(
  entries: ReadonlyArray<{ agentId: string | null | undefined; ageSeconds: number }>,
  knownAgentIds: ReadonlySet<string>,
): void {
  const gauge = ensureRegistry().queuedRunOldestAgeGauge;
  gauge.reset();
  const oldestByAgentId = new Map<string, number>();
  for (const entry of entries) {
    const agentId = normalizeAgentId(entry.agentId, knownAgentIds);
    const ageSeconds = Number.isFinite(entry.ageSeconds) ? Math.max(0, entry.ageSeconds) : 0;
    const current = oldestByAgentId.get(agentId);
    if (current === undefined || ageSeconds > current) oldestByAgentId.set(agentId, ageSeconds);
  }
  for (const agentId of knownAgentIds) {
    gauge.set({ agent_id: agentId }, oldestByAgentId.get(agentId) ?? 0);
  }
  const unknownAge = oldestByAgentId.get(UNKNOWN_AGENT_ID);
  if (unknownAge !== undefined) gauge.set({ agent_id: UNKNOWN_AGENT_ID }, unknownAge);
}

/** Mark whether the queued-run age gauge was refreshed from the database. */
export function setQueuedRunAgeMetricsRefreshSuccess(success: boolean): void {
  ensureRegistry().queuedRunAgeMetricsRefreshSuccessGauge.set(success ? 1 : 0);
}

/** Publish the maximum booked park horizon for each live scheduled retry. */
export function setScheduledRetryParkHorizonMetrics(
  entries: ReadonlyArray<{ agentId: string | null | undefined; horizonSeconds: number }>,
  knownAgentIds: ReadonlySet<string>,
): void {
  const gauge = ensureRegistry().scheduledRetryParkHorizonGauge;
  gauge.reset();
  const maxByAgentId = new Map<string, number>();
  for (const entry of entries) {
    const agentId = normalizeAgentId(entry.agentId, knownAgentIds);
    const horizonSeconds = Number.isFinite(entry.horizonSeconds) ? Math.max(0, entry.horizonSeconds) : 0;
    const current = maxByAgentId.get(agentId);
    if (current === undefined || horizonSeconds > current) maxByAgentId.set(agentId, horizonSeconds);
  }
  for (const agentId of knownAgentIds) gauge.set({ agent_id: agentId }, maxByAgentId.get(agentId) ?? 0);
  const unknownHorizon = maxByAgentId.get(UNKNOWN_AGENT_ID);
  if (unknownHorizon !== undefined) gauge.set({ agent_id: UNKNOWN_AGENT_ID }, unknownHorizon);
}

export function setScheduledRetryParkHorizonRefreshSuccess(success: boolean): void {
  ensureRegistry().scheduledRetryParkHorizonRefreshSuccessGauge.set(success ? 1 : 0);
}

/**
 * Publish the oldest STRANDED external-runtime reservation age per known agent
 * (BLO-28865). Same reset-then-set contract as
 * {@link setQueuedRunOldestAgeMetrics}, and for the same reason: an agent whose
 * reservation is released must read 0 rather than retaining an age that would
 * hold the strand alert open forever.
 */
export function setExternalRuntimeReservationStrandedOldestAgeMetrics(
  entries: ReadonlyArray<{ agentId: string | null | undefined; ageSeconds: number }>,
  knownAgentIds: ReadonlySet<string>,
): void {
  const gauge = ensureRegistry().externalRuntimeReservationStrandedOldestAgeGauge;
  gauge.reset();
  const oldestByAgentId = new Map<string, number>();
  for (const entry of entries) {
    const agentId = normalizeAgentId(entry.agentId, knownAgentIds);
    const ageSeconds = Number.isFinite(entry.ageSeconds) ? Math.max(0, entry.ageSeconds) : 0;
    const current = oldestByAgentId.get(agentId);
    if (current === undefined || ageSeconds > current) oldestByAgentId.set(agentId, ageSeconds);
  }
  for (const agentId of knownAgentIds) {
    gauge.set({ agent_id: agentId }, oldestByAgentId.get(agentId) ?? 0);
  }
  const unknownAge = oldestByAgentId.get(UNKNOWN_AGENT_ID);
  if (unknownAge !== undefined) gauge.set({ agent_id: UNKNOWN_AGENT_ID }, unknownAge);
}

/** Mark whether the stranded-reservation gauge was refreshed from the database. */
export function setExternalRuntimeReservationStrandMetricsRefreshSuccess(success: boolean): void {
  ensureRegistry().externalRuntimeReservationStrandMetricsRefreshSuccessGauge.set(success ? 1 : 0);
}

export function computePrReviewQueueWaitSeconds(
  taskKey: string | null | undefined,
  createdAt: Date | string | null | undefined,
  startedAt: Date | string | null | undefined,
): number | null {
  if (typeof taskKey !== "string" || !taskKey.startsWith("pr_review:") || !createdAt || !startedAt) return null;
  const createdMs = new Date(createdAt).getTime();
  const startedMs = new Date(startedAt).getTime();
  if (!Number.isFinite(createdMs) || !Number.isFinite(startedMs)) return null;
  return Math.max(0, (startedMs - createdMs) / 1000);
}

export function recordPrReviewQueueWait(input: {
  taskKey: string | null | undefined;
  createdAt: Date | string | null | undefined;
  startedAt: Date | string | null | undefined;
}): number | null {
  const waitSeconds = computePrReviewQueueWaitSeconds(input.taskKey, input.createdAt, input.startedAt);
  if (waitSeconds === null) return null;
  ensureRegistry().prReviewQueueWaitHistogram.observe(waitSeconds);
  return waitSeconds;
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

/**
 * Observe one external-lifecycle run's terminal silence gap (BLO-20815). Call
 * once per run at finalization (reap-driven completion/force-kill, or manual
 * cancel), passing the run's raw signal timestamps and the exact instant it
 * was finalized. Returns null (and records nothing) when the run has no
 * signal timestamp at all — a queued/scheduled_retry run cancelled before it
 * ever started has no meaningful silence gap to report. Otherwise returns the
 * normalized labels and the observed value (useful for logging/tests).
 *
 * Also updates {@link EXTERNAL_LIFECYCLE_RUN_SILENCE_GAP_LAST_METRIC}, the
 * last-value companion gauge that makes the population max queryable via
 * `max_over_time(...[7d])` (the histogram alone cannot answer that — see the
 * gauge's own doc comment).
 */
export function recordExternalLifecycleRunSilenceGap(input: {
  adapter: string | null | undefined;
  status: string | null | undefined;
  run: ExternalLifecycleSilenceGapRunSignals;
  finalizedAt: Date;
}): { adapter: string; status: string; silenceGapSeconds: number } | null {
  const silenceGapSeconds = computeExternalLifecycleSilenceGapSeconds(input.run, input.finalizedAt);
  if (silenceGapSeconds === null) return null;
  const labels = {
    adapter: normalizeExternalAdapter(input.adapter),
    status: normalizeExternalLifecycleTerminalStatus(input.status),
  };
  const registered = ensureRegistry();
  registered.externalLifecycleRunSilenceGapHistogram.observe(labels, silenceGapSeconds);
  registered.externalLifecycleRunSilenceGapLastGauge.set(labels, silenceGapSeconds);
  return { ...labels, silenceGapSeconds };
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

/**
 * Record one GitHub review-request delivery funnel transition (BLO-18859).
 * `state` is a compile-time-closed union; `reason` is coerced to the bounded
 * {@link KNOWN_GITHUB_WAKE_REASONS} allow-list so an unrecognized or absent
 * wake reason lands on "other" instead of minting a new series. Returns the
 * emitted labels so call sites can echo them on their structured log line.
 *
 * `"suppressed"` is excluded from the accepted states on purpose: it must go
 * through {@link recordGithubReviewRequestSuppressed} so the cause breakdown is
 * incremented in the same statement and cannot drift from the funnel.
 */
export function recordGithubReviewRequestDelivery(input: {
  state: Exclude<GithubReviewRequestDeliveryState, "suppressed">;
  reason: string | null | undefined;
}): { state: string; reason: string } {
  const labels = {
    state: input.state,
    reason: normalizeGithubWakeReason(input.reason),
  };
  ensureRegistry().githubReviewRequestDeliveryCounter.inc(labels);
  return labels;
}

/**
 * Record one terminally-suppressed GitHub review-request delivery
 * (BLO-18859 review follow-up). Increments the funnel counter's `suppressed`
 * state AND the cause breakdown together — this is the only sanctioned way to
 * reach `state="suppressed"`, which is what makes
 * `sum(suppression_total) == sum(delivery_total{state="suppressed"})` hold
 * without a lockstep test.
 *
 * `cause` is normally the `agent_wakeup_requests.reason` written on the durable
 * `skipped` row; pass {@link GITHUB_SUPPRESSION_CAUSE_DISPATCH_REJECTED} when
 * an `HttpError` refused the wake without leaving one. Anything unrecognized
 * collapses to {@link UNKNOWN_GITHUB_SUPPRESSION_CAUSE}, which the outage alert
 * does page on: an untriaged cause is not a known-expected decline.
 */
export function recordGithubReviewRequestSuppressed(input: {
  reason: string | null | undefined;
  cause: string | null | undefined;
}): { state: string; reason: string; cause: string } {
  const reason = normalizeGithubWakeReason(input.reason);
  const cause = normalizeGithubSuppressionCause(input.cause);
  const registry = ensureRegistry();
  registry.githubReviewRequestDeliveryCounter.inc({ state: "suppressed", reason });
  registry.githubReviewRequestSuppressionCounter.inc({ cause, reason });
  return { state: "suppressed", reason, cause };
}

/**
 * Record one PR review the reviewer identity published to GitHub (BLO-27608).
 *
 * Called from the webhook receiver on a signed delivery that carries a review
 * authored by the configured reviewer identity — see
 * {@link GITHUB_REVIEW_POSTED_METRIC} for why the observation point is the
 * webhook rather than a post call (the control plane never posts a review), and
 * why a human reviewer must never reach this counter.
 */
export function recordGithubReviewPosted(input: {
  repo: string | null | undefined;
  surface: GithubReviewSurface;
}): { repo: string; surface: string } {
  const labels = {
    repo: normalizeGithubReviewRepo(input.repo),
    surface: input.surface,
  };
  ensureRegistry().githubReviewPostedCounter.inc(labels);
  return labels;
}

/**
 * Record the terminal verdict of one reviewer run (BLO-27608).
 *
 * Call this with the FINAL verdict, after any authoritative GitHub
 * re-verification the call site performs — recording the pre-verification value
 * would count a `missing` that GitHub then proved was a real posted review, and
 * the run is credited the other way. `not_applicable` (the run was not a
 * reviewer run) is dropped rather than counted, since it is not a review
 * outcome.
 */
export function recordGithubReviewCompletion(status: string | null | undefined): string | null {
  if (status === "not_applicable") return null;
  const label = normalizeGithubReviewCompletionStatus(status);
  ensureRegistry().githubReviewCompletionCounter.inc({ status: label });
  return label;
}

/**
 * Publish the current unresolved GitHub review-request dead-letter counts
 * (BLO-18859 review follow-up). Called once per heartbeat scheduler tick
 * (BLO-31335) with the full bounded map, so the gauge is a rewrite of durable
 * state rather than a delta — a restarted process republishes the same value on
 * its first tick instead of starting from a zero it can never climb back from.
 *
 * Every known reason absent from `byReason` is explicitly reset to 0, so a
 * dead letter that ages out of the recency window drops the gauge instead of
 * leaving a stale non-zero series alerting forever.
 */
export function setGithubReviewRequestDeadLetterUnresolved(byReason: Record<string, number>): void {
  const gauge = ensureRegistry().githubReviewRequestDeadLetterUnresolvedGauge;
  const normalized: Record<string, number> = {};
  for (const [reason, count] of Object.entries(byReason)) {
    const label = normalizeGithubWakeReason(reason);
    normalized[label] = (normalized[label] ?? 0) + Math.max(0, count);
  }
  for (const reason of [...KNOWN_GITHUB_WAKE_REASONS, UNKNOWN_GITHUB_WAKE_REASON]) {
    gauge.set({ reason }, normalized[reason] ?? 0);
  }
}

/**
 * Publish the current unresolved terminal-`failed` wake counts (BLO-20255).
 * Called once per heartbeat scheduler tick (BLO-31335) with the full bounded
 * set, so the gauge is a rewrite of durable state rather than a delta — a
 * restarted process republishes the same value on its first tick instead of
 * starting from a zero it can never climb back from.
 *
 * Every `(error_code, scope)` pair absent from `entries` is explicitly reset to
 * 0, so a row that ages out of the recency window — or that a successor wake
 * has since covered — drops the gauge instead of leaving a stale non-zero
 * series alerting forever.
 */
export function setAgentWakeupTerminalFailedUnresolved(
  entries: ReadonlyArray<{
    errorCode: string | null | undefined;
    scope: string | null | undefined;
    count: number;
  }>,
): void {
  const gauge = ensureRegistry().agentWakeupTerminalFailedUnresolvedGauge;
  const normalized = new Map<string, number>();
  for (const entry of entries) {
    const errorCode = normalizeTerminalFailedWakeErrorCode(entry.errorCode);
    // Anything not in the bounded scope set collapses to `other` rather than
    // minting a new series.
    const scope = entry.scope === "pr_review" ? "pr_review" : "other";
    const key = `${errorCode} ${scope}`;
    normalized.set(key, (normalized.get(key) ?? 0) + Math.max(0, entry.count));
  }
  for (
    const errorCode of [
      ...KNOWN_TERMINAL_FAILED_WAKE_ERROR_CODES,
      UNKNOWN_TERMINAL_FAILED_WAKE_ERROR_CODE,
      TERMINAL_FAILED_WAKE_ERROR_CODE_NONE,
    ]
  ) {
    for (const scope of TERMINAL_FAILED_WAKE_SCOPES) {
      gauge.set(
        { error_code: errorCode, scope },
        normalized.get(`${errorCode} ${scope}`) ?? 0,
      );
    }
  }
}

/**
 * Publish the oldest unresolved terminal-`failed` wake age per scope
 * (BLO-20255). Same rewrite-of-durable-state contract as
 * {@link setAgentWakeupTerminalFailedUnresolved}: called once per heartbeat
 * scheduler tick (BLO-31335) with the full set, and every scope absent from
 * `entries` is explicitly reset to 0.
 *
 * That reset is the part with teeth. If a scope's series were merely left
 * alone once its last failure cleared, the age would freeze at whatever it
 * last was — permanently above any threshold the alert uses, so the page would
 * never resolve. Writing 0 is what lets the alert clear.
 */
export function setAgentWakeupTerminalFailedOldestAgeSeconds(
  entries: ReadonlyArray<{ scope: string | null | undefined; ageSeconds: number }>,
): void {
  const gauge = ensureRegistry().agentWakeupTerminalFailedOldestAgeGauge;
  const oldestByScope = new Map<string, number>();
  for (const entry of entries) {
    // Same collapse as the count gauge: an unrecognized scope becomes `other`
    // rather than minting a new series.
    const scope = entry.scope === "pr_review" ? "pr_review" : "other";
    const ageSeconds = Number.isFinite(entry.ageSeconds) ? Math.max(0, entry.ageSeconds) : 0;
    const current = oldestByScope.get(scope);
    if (current === undefined || ageSeconds > current) oldestByScope.set(scope, ageSeconds);
  }
  for (const scope of TERMINAL_FAILED_WAKE_SCOPES) {
    gauge.set({ scope }, oldestByScope.get(scope) ?? 0);
  }
}

/**
 * Record one completed GitHub Actions `workflow_run` webhook delivery
 * (BLO-21078). Call exactly once per completed run, regardless of whether it
 * matched a paperclip identifier — the counter's job is fleet-wide visibility
 * into conclusion mix, not per-issue attribution. `supersession` is only
 * meaningful when `conclusion` is `"cancelled"`; pass `"none"` (or omit) for
 * every other conclusion.
 */
export function recordGithubWorkflowRunConclusion(
  conclusion: string | null | undefined,
  supersession?: string | null,
): string {
  const conclusionLabel = normalizeWorkflowRunConclusion(conclusion);
  const supersessionLabel = normalizeWorkflowRunSupersession(supersession);
  ensureRegistry().githubWorkflowRunConclusionCounter.inc({
    conclusion: conclusionLabel,
    supersession: supersessionLabel,
  });
  return conclusionLabel;
}

/**
 * Snapshot the oldest-overdue-`scheduled_retry`-row age per agent (BLO-22094).
 * Same reset-then-set contract as {@link setQueuedRunOldestAgeMetrics}: an
 * agent absent from `entries` must read back an explicit 0, not a frozen
 * stale value or an absent series -- that explicit 0 is what lets an alert on
 * this series resolve once the last overdue parked row is promoted or the
 * agent has none. `knownAgentIds` bounds the label the same way.
 */
export function setOverdueScheduledRetryAgeMetrics(
  entries: ReadonlyArray<{ agentId: string | null | undefined; ageSeconds: number }>,
  knownAgentIds: ReadonlySet<string>,
): void {
  const gauge = ensureRegistry().overdueScheduledRetryOldestAgeGauge;
  gauge.reset();
  const oldestByAgentId = new Map<string, number>();
  for (const entry of entries) {
    const agentId = normalizeAgentId(entry.agentId, knownAgentIds);
    const ageSeconds = Number.isFinite(entry.ageSeconds) ? Math.max(0, entry.ageSeconds) : 0;
    const current = oldestByAgentId.get(agentId);
    if (current === undefined || ageSeconds > current) oldestByAgentId.set(agentId, ageSeconds);
  }
  for (const agentId of knownAgentIds) {
    gauge.set({ agent_id: agentId }, oldestByAgentId.get(agentId) ?? 0);
  }
  const unknownAge = oldestByAgentId.get(UNKNOWN_AGENT_ID);
  if (unknownAge !== undefined) gauge.set({ agent_id: UNKNOWN_AGENT_ID }, unknownAge);
}

/**
 * Mark whether the overdue-scheduled_retry age gauge was refreshed from the
 * database (BLO-22094). Deliberately separate from
 * {@link setQueuedRunAgeMetricsRefreshSuccess}: the two refreshes hit
 * different aggregates behind different indexes, so a healthy sibling refresh
 * must never vouch for a dead one.
 */
export function setOverdueScheduledRetryAgeMetricsRefreshSuccess(success: boolean): void {
  ensureRegistry().overdueScheduledRetryAgeMetricsRefreshSuccessGauge.set(success ? 1 : 0);
}

export interface PluginErrorStatusEntry {
  /** `plugins.id` (uuid) — the stable DB identity. */
  id: string;
  /** `plugins.plugin_key` (e.g. `lucitra.plugin-secrets`) — the alert-routing label. */
  pluginKey: string;
  /** True when this row's `status` is `error`. */
  isError: boolean;
}

/**
 * Publish the current plugin error/ready split (BLO-21092). Reset-then-set
 * with the full currently-installed roster on every collector tick: a
 * plugin that gets uninstalled drops out of the series entirely instead of
 * alerting forever on a row that no longer exists, and a plugin that
 * recovers from `error` writes an explicit 0 -- the value the alert rule
 * needs to see in order to resolve.
 */
export function setPluginErrorStatus(entries: ReadonlyArray<PluginErrorStatusEntry>): void {
  const gauge = ensureRegistry().pluginErrorGauge;
  gauge.reset();
  for (const entry of entries) {
    gauge.set({ plugin_id: entry.id, plugin_key: entry.pluginKey }, entry.isError ? 1 : 0);
  }
}

export interface RecordPluginMetricInput {
  /** `plugins.id` (uuid). */
  pluginId: string;
  /** `plugins.plugin_key` — the routable identity an alert rule selects on. */
  pluginKey: string;
  /** The plugin-supplied metric name. Becomes the `metric` label. */
  name: string;
  /** Counter increment. Must be finite and `>= 0`. */
  value: number;
  /** Plugin-supplied tags. Untrusted input. */
  tags?: Readonly<Record<string, unknown>> | null;
  /**
   * Tag keys this plugin's manifest declares as promotable (`metricLabels`).
   * A key is promoted only if it appears here AND in
   * {@link PLUGIN_METRIC_PROMOTABLE_TAG_KEYS}. Omitted/empty means promote
   * nothing, so a plugin that has not opted in gets aggregate-only series.
   */
  declaredLabels?: readonly string[] | null;
}

/**
 * Publish one plugin-contributed metric increment to Prometheus (PEN-2799).
 *
 * **Never throws.** This runs inside the plugin host's `ctx.metrics.write`,
 * which plugins call from inside alert/webhook processing. prom-client's
 * `inc()` *does* throw on a negative value, and an exception escaping here
 * would escalate "a plugin submitted a mis-shaped metric" into "the delivery
 * that carried it failed" — turning an instrumentation defect into the exact
 * dropped-alert class this function exists to make visible. Every rejection is
 * therefore a counted drop, not a raised error.
 *
 * The `plugin_logs` write in the caller is independent and unchanged; this is
 * additive exposition, so no plugin needs recompiling for its existing
 * counters to become alertable.
 */
export function recordPluginMetric(input: RecordPluginMetricInput): void {
  try {
    const metrics = ensureRegistry();
    const pluginId = String(input.pluginId ?? "");
    const pluginKey = String(input.pluginKey ?? "");
    const identity = { plugin_id: pluginId, plugin_key: pluginKey };

    const name = String(input.name ?? "").trim();
    if (
      name.length === 0
      || name.length > PLUGIN_METRIC_NAME_MAX_LENGTH
      || !PLUGIN_METRIC_NAME_REGEX.test(name)
    ) {
      metrics.pluginMetricDroppedCounter.inc({ ...identity, reason: "bad_name" });
      return;
    }

    // A counter increment, so a negative or non-finite value has no meaning.
    // Rejected rather than clamped: clamping would publish a number the plugin
    // did not submit, and a silently-altered counter is worse than a counted
    // drop.
    const value = typeof input.value === "number" ? input.value : Number(input.value);
    if (!Number.isFinite(value) || value < 0) {
      metrics.pluginMetricDroppedCounter.inc({ ...identity, reason: "bad_value" });
      return;
    }

    // Tier 1 — the name axis. Bounded on its own so that exhausting the
    // (much larger) tag-value axis below can never cost a plugin its
    // per-name series, which is what alert rules match on.
    let seenNames = pluginMetricNames.get(pluginId);
    if (!seenNames) {
      seenNames = new Set<string>();
      pluginMetricNames.set(pluginId, seenNames);
    }
    if (!seenNames.has(name)) {
      if (seenNames.size >= PLUGIN_METRIC_NAME_BUDGET) {
        // Only here does `metric` collapse: the plugin is minting names
        // faster than any rule author could enumerate them, so there is no
        // per-name series worth preserving.
        //
        // The drop is labelled `_overflow`, matching the series the increment
        // lands on -- deliberately NOT the rejected name. That name is the
        // 51st-or-later distinct one, i.e. exactly the unbounded input this
        // tier exists to refuse; carrying it here would leak the bound onto
        // the drop series instead.
        metrics.pluginMetricDroppedCounter.inc({
          ...identity,
          reason: "name_budget",
          metric: PLUGIN_METRIC_OVERFLOW_NAME,
        });
        metrics.pluginMetricCounter.inc(
          { ...identity, metric: PLUGIN_METRIC_OVERFLOW_NAME },
          value,
        );
        return;
      }
      seenNames.add(name);
    }

    // Two-sided gate: manifest-declared AND platform-promotable.
    const declared = new Set(
      (input.declaredLabels ?? []).map((key) => String(key)),
    );
    const labels: Record<string, string> = { ...identity, metric: name };
    const comboParts: string[] = [name];
    for (const key of PLUGIN_METRIC_PROMOTABLE_TAG_KEYS) {
      const raw = declared.has(key) ? input.tags?.[key] : undefined;
      // Only primitives promote. `String(raw)` on an object yields the constant
      // "[object Object]", which is not a breach (it is low-cardinality) but is
      // a label value that identifies nothing -- worse than an absent label,
      // because a rule author reading the series cannot tell it from a real
      // value. An array would flatten to a comma-joined string of unbounded
      // arity. Both are treated as "not supplied".
      const promoted =
        typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean"
          ? String(raw).slice(0, PLUGIN_METRIC_LABEL_VALUE_MAX_LENGTH)
          : "";
      if (promoted.length > 0) labels[key] = promoted;
      comboParts.push(promoted);
    }

    // Tier 2 — the tag-value axis, over combinations ever observed. `combo` is
    // NUL-joined so two distinct combinations cannot render to one ledger key
    // (see pluginMetricCombinations) — a collision there would hand out a free
    // series and leak the bound.
    const combo = comboParts.join("\0");
    let seen = pluginMetricCombinations.get(pluginId);
    if (!seen) {
      seen = new Set<string>();
      pluginMetricCombinations.set(pluginId, seen);
    }
    if (!seen.has(combo)) {
      if (seen.size >= PLUGIN_METRIC_CARDINALITY_BUDGET) {
        // Drop the LABELS, keep the `metric`. The name already cleared tier 1,
        // so its series is bounded and an alert rule matching on
        // `metric="<name>"` keeps working — which is the entire reason this
        // tier collapses on a different axis than the one above. The increment
        // lands on the plugin's real per-name series, so `sum by (metric)`
        // stays exactly correct across overflow; only the per-tag breakdown is
        // lost, and the drop counter says so rather than leaving it to be
        // inferred from a flat graph. Safe to label with the real name: it
        // already cleared tier 1, so it is one of at most
        // PLUGIN_METRIC_NAME_BUDGET values.
        metrics.pluginMetricDroppedCounter.inc({
          ...identity,
          reason: "label_budget",
          metric: name,
        });
        metrics.pluginMetricCounter.inc({ ...identity, metric: name }, value);
        return;
      }
      seen.add(combo);
    }

    metrics.pluginMetricCounter.inc(labels, value);
  } catch (err) {
    // Deliberately swallowed — see the "never throws" contract above. Logged at
    // debug because a metrics defect must not become a log flood on the same
    // hot path it already failed on.
    console.debug("[metrics] recordPluginMetric failed:", err);
  }
}

/**
 * Record a successful plugin-status collector tick (BLO-21092 review
 * follow-up). Callers pass unix seconds, not milliseconds -- the collector
 * owns the clock so this stays a pure setter and unit-tests deterministically.
 * The `role="worker"` label is constant (see {@link PLUGIN_STATUS_COLLECTOR_LAST_SUCCESS_METRIC})
 * -- this is the only caller, and it only ever runs on the worker tier.
 */
export function setPluginStatusCollectorLastSuccessSeconds(unixSeconds: number): void {
  ensureRegistry().pluginStatusCollectorLastSuccessGauge.set({ role: "worker" }, unixSeconds);
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

/**
 * Record one gbrain-context recall-prefetch outcome (BLO-25892). `status` is
 * normalized into the bounded label set, so an unrecognized value from a newer
 * plugin build lands on "other" rather than minting an unbounded series.
 */
export function recordGbrainRecallOutcome(status: string | null | undefined): { status: string } {
  const labels = { status: normalizeGbrainRecallStatus(status) };
  ensureRegistry().gbrainRecallCounter.inc(labels);
  return labels;
}

/**
 * Publish the fleet-wide agent-liveness gauges (BLO-23413). Called once per
 * heartbeat-scheduler tick with a full snapshot of the current agent roster,
 * so this is a rewrite of durable state rather than a delta -- same
 * reset-then-set contract as {@link setExternalLifecycleRunningRuns} and the
 * wake-terminal-failed gauges: an agent that is deleted, or whose heartbeat
 * gets disabled, or that leaves `error`, drops (or zeros) out of the gauge on
 * the very next publish rather than freezing at its last-known value forever.
 *
 * `heartbeatAgeSeconds`/`heartbeatIntervalSeconds` are only set for entries
 * with `heartbeatEnabled: true` AND `heartbeatExpected: true` -- an agent that
 * is expected to be dark must not publish an ever-growing age, because that
 * age never comes back down and so the consuming alert never clears.
 *
 * The two flags are deliberately separate facts, not one:
 *  - `heartbeatEnabled` is the agent's own `heartbeat.enabled` CONFIG.
 *  - `heartbeatExpected` is whether the scheduler would ever actually wake it
 *    (BLO-28861). `heartbeat.enabled` is NOT cleared on termination, so config
 *    alone says nothing about liveness: a terminated agent keeps
 *    `enabled: true` forever and its age grows without bound.
 *
 * `errorDurationSeconds` is published for EVERY entry regardless of either
 * flag -- it is a status observation, not a liveness claim, and BLO-28861
 * explicitly preserves its existing series set.
 */
export function setAgentLivenessMetrics(
  entries: ReadonlyArray<{
    agentId: string;
    heartbeatEnabled: boolean;
    /**
     * Whether this agent is one the heartbeat scheduler would actually wake.
     * Required rather than optional-defaulting-true so a future caller cannot
     * silently reintroduce BLO-28861 by forgetting to pass it.
     */
    heartbeatExpected: boolean;
    heartbeatAgeSeconds: number | null;
    heartbeatIntervalSeconds: number | null;
    errorDurationSeconds: number;
  }>,
): void {
  const metrics = ensureRegistry();
  metrics.agentHeartbeatAgeGauge.reset();
  metrics.agentHeartbeatIntervalGauge.reset();
  metrics.agentErrorDurationGauge.reset();
  for (const entry of entries) {
    if (typeof entry.agentId !== "string" || entry.agentId.length === 0) continue;
    if (entry.heartbeatEnabled && entry.heartbeatExpected) {
      if (Number.isFinite(entry.heartbeatAgeSeconds)) {
        metrics.agentHeartbeatAgeGauge.set({ agent_id: entry.agentId }, Math.max(0, entry.heartbeatAgeSeconds as number));
      }
      if (Number.isFinite(entry.heartbeatIntervalSeconds)) {
        metrics.agentHeartbeatIntervalGauge.set(
          { agent_id: entry.agentId },
          Math.max(0, entry.heartbeatIntervalSeconds as number),
        );
      }
    }
    metrics.agentErrorDurationGauge.set(
      { agent_id: entry.agentId },
      Number.isFinite(entry.errorDurationSeconds) ? Math.max(0, entry.errorDurationSeconds) : 0,
    );
  }
}

/**
 * Record a project primary-workspace resolution that fell through to the
 * earliest-created row (BLO-26184). Callers should invoke this only when the
 * project has >=1 workspace and none is flagged `isPrimary` — never for a
 * 0-workspace project (that resolves `null`, not a fallback guess) or a
 * project with an explicit primary.
 */
export function recordProjectPrimaryWorkspaceFallback(projectId: string): void {
  ensureRegistry().projectPrimaryWorkspaceFallbackCounter.inc();
  logger.warn(
    { projectId },
    "project primary-workspace resolved via earliest-created fallback (no row flagged isPrimary)",
  );
}

export function setBackstopDeferredCandidates(source: BackstopSource, value: number): void {
  ensureRegistry().backstopDeferredCandidatesGauge.set({ source }, Math.max(0, value));
}

export function recordBackstopSweepCompleted(source: BackstopSource): void {
  ensureRegistry().backstopSweepCompletedCounter.inc({ source });
}

export function recordBackstopCandidateSkipped(source: BackstopSource, reason: BackstopSkipReason): void {
  ensureRegistry().backstopCandidatesSkippedCounter.inc({ source, reason });
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
  const routineDispatchSnapshot = snapshotRoutineDispatchMetrics();
  const routineDispatchBody = [
    `# HELP ${ROUTINE_DISPATCH_METRIC} Count of routine dispatch gating outcomes, labeled by outcome. routine_dispatch_bypassed_parked_execution_issue = a fire proceeded past an execution issue parked on a long-horizon scheduled_retry rather than being silently skipped for the whole park. routine_dispatch_bypassed_stale_execution_issue = a fire proceeded past an execution issue whose run was left queued or running past the run-age horizon.`,
    `# TYPE ${ROUTINE_DISPATCH_METRIC} counter`,
    ...Object.entries(routineDispatchSnapshot).map(
      ([outcome, value]) => `${ROUTINE_DISPATCH_METRIC}{outcome="${outcome}"} ${value}`,
    ),
  ].join("\n");
  return {
    contentType: reg.contentType,
    body: `${await reg.metrics()}\n${depBlockedBody}\n${blockerResolvedBody}\n${routineDispatchBody}\n`,
  };
}

/** Test-only: drop the registry so each test starts from a clean counter. */
export function __resetMetricsForTest(): void {
  registry = null;
  concurrentRunBlocked = null;
  isolatedRunStarted = null;
  heartbeatRunFailed = null;
  ccrotateCapacityDeferred = null;
  heartbeatTimerSchedulerExclusion = null;
  agentZeroTokenCompletedRunStreak = null;
  zeroTokenStreakAdapterByAgentId.clear();
  externalRuntimeReservationEvents = null;
  externalRuntimeReservationsActive = null;
  externalRuntimeReservationOldestAge = null;
  queuedRunAgeMetricsRefreshSuccess = null;
  externalRuntimeReservationStrandedOldestAge = null;
  externalRuntimeReservationStrandMetricsRefreshSuccess = null;
  processLostTotal = null;
  externalLifecycleRunningRuns = null;
  externalLifecycleRunSilenceGap = null;
  externalLifecycleRunSilenceGapLast = null;
  processLostLivenessNull = null;
  orphanedManagedPodReaped = null;
  githubReviewRequestDelivery = null;
  githubReviewRequestSuppression = null;
  githubReviewRequestDeadLetterUnresolved = null;
  agentWakeupTerminalFailedUnresolved = null;
  agentWakeupTerminalFailedOldestAge = null;
  githubWorkflowRunConclusion = null;
  queuedRunOldestAge = null;
  overdueScheduledRetryOldestAge = null;
  overdueScheduledRetryAgeMetricsRefreshSuccess = null;
  scheduledRetryParkHorizon = null;
  scheduledRetryParkHorizonRefreshSuccess = null;
  pluginError = null;
  pluginMetric = null;
  pluginMetricDropped = null;
  pluginMetricCombinations.clear();
  pluginMetricNames.clear();
  pluginStatusCollectorLastSuccess = null;
  prReviewQueueWait = null;
  authRequest = null;
  agentHeartbeatAge = null;
  agentHeartbeatInterval = null;
  agentErrorDuration = null;
  projectPrimaryWorkspaceFallback = null;
  backstopDeferredCandidates = null;
  backstopSweepCompleted = null;
  backstopCandidatesSkipped = null;
  gbrainRecallTotal = null;
  resetDepBlockedMetrics();
  resetBlockerResolvedWakeMetrics();
  resetRoutineDispatchMetrics();
}
