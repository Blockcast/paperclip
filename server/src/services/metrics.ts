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
export const QUEUED_RUN_OLDEST_AGE_METRIC = "paperclip_queued_run_oldest_age_seconds";
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

export const UNKNOWN_GITHUB_SUPPRESSION_CAUSE = "other";

/**
 * Causes zero-initialized at process start. Deliberately only the ones the
 * outage alert selects: for those, absent-vs-zero is the difference between
 * "nothing suppressed" and "the scrape is broken", so the series must exist
 * before the first event. The expected policy declines are left to appear
 * lazily — they are read as a breakdown when something already fired, never
 * alerted on, so a missing series costs nothing and this keeps the constant
 * series count at `3 * 8` instead of `12 * 8`.
 */
export const ALERTING_GITHUB_SUPPRESSION_CAUSES = [
  "heartbeat.scheduling_suppressed",
  GITHUB_SUPPRESSION_CAUSE_DISPATCH_REJECTED,
  UNKNOWN_GITHUB_SUPPRESSION_CAUSE,
] as const;

const knownGithubSuppressionCauseSet: ReadonlySet<string> = new Set(KNOWN_GITHUB_SUPPRESSION_CAUSES);

export function normalizeGithubSuppressionCause(cause: string | null | undefined): string {
  return typeof cause === "string" && knownGithubSuppressionCauseSet.has(cause)
    ? cause
    : UNKNOWN_GITHUB_SUPPRESSION_CAUSE;
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
let githubReviewRequestDelivery: Counter<"state" | "reason"> | null = null;
let githubReviewRequestSuppression: Counter<"cause" | "reason"> | null = null;
let githubReviewRequestDeadLetterUnresolved: Gauge<"reason"> | null = null;
let agentWakeupTerminalFailedUnresolved: Gauge<"error_code" | "scope"> | null = null;
let agentWakeupTerminalFailedOldestAge: Gauge<"scope"> | null = null;
let queuedRunOldestAge: Gauge<"agent_id"> | null = null;
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
  githubReviewRequestDeliveryCounter: Counter<"state" | "reason">;
  githubReviewRequestSuppressionCounter: Counter<"cause" | "reason">;
  githubReviewRequestDeadLetterUnresolvedGauge: Gauge<"reason">;
  agentWakeupTerminalFailedUnresolvedGauge: Gauge<"error_code" | "scope">;
  agentWakeupTerminalFailedOldestAgeGauge: Gauge<"scope">;
  queuedRunOldestAgeGauge: Gauge<"agent_id">;
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
    || !githubReviewRequestDelivery
    || !githubReviewRequestSuppression
    || !githubReviewRequestDeadLetterUnresolved
    || !agentWakeupTerminalFailedUnresolved
    || !agentWakeupTerminalFailedOldestAge
    || !queuedRunOldestAge
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
        + "Every cause but 'dispatch_rejected'/'other' is a literal "
        + "agent_wakeup_requests.reason on the durable skipped row, so a firing series joins "
        + "straight back to rows. Alert on outage-like causes only "
        + "(heartbeat.scheduling_suppressed, dispatch_rejected, other); the rest — an inactive "
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
        + "agent_wakeup_requests on every wake-dispatch reconcile pass (BLO-18859 review "
        + "follow-up). This is the restart-safe companion to "
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
    agentWakeupTerminalFailedUnresolved = new Gauge({
      name: AGENT_WAKEUP_TERMINAL_FAILED_UNRESOLVED_METRIC,
      help:
        "Current count of agent_wakeup_requests rows sitting in the terminal "
        + "status='failed' state within the recency window, with no successor wake for "
        + "the same taskKey, re-derived from committed rows on every wake-dispatch "
        + "reconcile pass (BLO-20255). Distinct from the dispatch dead-letter gauge "
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
        + "same taskKey, re-derived on every wake-dispatch reconcile pass (BLO-20255). 0 "
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
    queuedRunOldestAge = new Gauge({
      name: QUEUED_RUN_OLDEST_AGE_METRIC,
      help:
        "Age in seconds of the oldest queued heartbeat run for each agent. "
        + "Refreshed from durable queue-entry timestamps on every metrics scrape; "
        + "a failed refresh clears samples rather than exporting stale values.",
      labelNames: ["agent_id"],
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
    githubReviewRequestDeliveryCounter: githubReviewRequestDelivery,
    githubReviewRequestSuppressionCounter: githubReviewRequestSuppression,
    githubReviewRequestDeadLetterUnresolvedGauge: githubReviewRequestDeadLetterUnresolved,
    agentWakeupTerminalFailedUnresolvedGauge: agentWakeupTerminalFailedUnresolved,
    agentWakeupTerminalFailedOldestAgeGauge: agentWakeupTerminalFailedOldestAge,
    queuedRunOldestAgeGauge: queuedRunOldestAge,
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
 * Publish the current unresolved GitHub review-request dead-letter counts
 * (BLO-18859 review follow-up). Called once per wake-dispatch reconcile pass
 * with the full bounded map, so the gauge is a rewrite of durable state rather
 * than a delta — a restarted process republishes the same value on its first
 * pass instead of starting from a zero it can never climb back from.
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
 * Called once per wake-dispatch reconcile pass with the full bounded set, so
 * the gauge is a rewrite of durable state rather than a delta — a restarted
 * process republishes the same value on its first pass instead of starting
 * from a zero it can never climb back from.
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
 * {@link setAgentWakeupTerminalFailedUnresolved}: called once per reconcile
 * pass with the full set, and every scope absent from `entries` is explicitly
 * reset to 0.
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
 * Publish the oldest queued-run age per agent from a complete database
 * snapshot. Known agents without queued work explicitly receive zero so a
 * successful refresh resolves a previous alert instead of leaving it stale.
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
    const previous = oldestByAgentId.get(agentId);
    if (previous === undefined || ageSeconds > previous) oldestByAgentId.set(agentId, ageSeconds);
  }
  for (const agentId of knownAgentIds) {
    gauge.set({ agent_id: agentId }, oldestByAgentId.get(agentId) ?? 0);
  }
  const unknownAge = oldestByAgentId.get(UNKNOWN_AGENT_ID);
  if (unknownAge !== undefined) gauge.set({ agent_id: UNKNOWN_AGENT_ID }, unknownAge);
}

/** Remove queued-run samples after a failed refresh so Prometheus never sees stale state as live data. */
export function invalidateQueuedRunOldestAgeMetrics(): void {
  ensureRegistry().queuedRunOldestAgeGauge.reset();
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
  githubReviewRequestDelivery = null;
  githubReviewRequestSuppression = null;
  githubReviewRequestDeadLetterUnresolved = null;
  agentWakeupTerminalFailedUnresolved = null;
  agentWakeupTerminalFailedOldestAge = null;
  queuedRunOldestAge = null;
  authRequest = null;
  resetDepBlockedMetrics();
  resetBlockerResolvedWakeMetrics();
}
