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
// Value imports, deliberately: the zero-inits below need the actual member lists, and a
// second copy of either here would be free to drift from the map that decides which kinds the
// sweep discharges. `@paperclipai/shared` is a leaf package with no edge back here, so
// unlike the service imports below this one cannot form a cycle.
import {
  ACCEPTED_INTERACTION_OUTCOME_BUCKETS,
  APPROVAL_TYPES,
  RESTORED_EXECUTION_DISCHARGE_KINDS,
} from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
// Type-only, so it is erased at runtime and creates no import cycle with the
// reaper (which imports the recorder below). Structurally restating the result
// shape here would let a NEW result field be added and silently go unrecorded.
import type { IsolationWorkspaceReapResult } from "./isolation-workspace-reaper.js";
// Type-only for the same reason as the reaper result above: erased at runtime,
// so it creates no import cycle with the collector (which imports the recorder
// below), while still making a NEW result field a compile error here rather
// than a silently unrecorded one.
import type { ExecutionWorkspaceCleanupResult } from "./execution-workspace-cleanup.js";
import { resetDepBlockedMetrics, snapshotDepBlockedMetrics } from "./dep-blocked-metrics.js";
import {
  resetBlockerResolvedWakeMetrics,
  snapshotBlockerResolvedWakeMetrics,
} from "./blocker-resolved-wake-metrics.js";
import {
  resetRoutineDispatchMetrics,
  snapshotRoutineDispatchMetrics,
} from "./routine-dispatch-metrics.js";
import type { FdClassSnapshot } from "./fd-class-metrics.js";
import type { CgroupMemorySnapshot } from "./cgroup-memory-metrics.js";
import type { NativeMemorySnapshot } from "./native-memory-metrics.js";
import type { ProcessMappingSnapshot } from "./process-mapping-metrics.js";
import type { RssReleaseReading } from "./rss-release-tracker.js";
import { registerGcFlagsCollector } from "./gc-flags-metrics.js";

export const CONCURRENT_RUN_BLOCKED_METRIC = "claude_k8s_concurrent_run_blocked_total";
/**
 * PEN-3607: every reason `startNextQueuedRunForAgent` can decline to start a
 * queued run, counted per agent.
 *
 * This exists because a dark seat was previously unexplainable from outside the
 * process. Before this metric, exactly one of that dispatch pass's `return []`
 * sites recorded anything ({@link CONCURRENT_RUN_BLOCKED_METRIC},
 * which covers only the slot-ceiling refusal), and the rest were silent — no
 * metric, no log above `debug`, no write to the run row. Measured consequence:
 * agent `bcba1cc7` sat 73.6 h with four `queued` runs and no `startedAt`, and
 * two successive code-trace localizations of the bail were both wrong because
 * the only available signal was another counter that had *stopped*.
 *
 * A stopped counter is the trap this one is shaped to avoid. Dispatch is
 * re-attempted every scheduler tick, so a genuinely wedged seat increments this
 * counter continuously with the reason that is wedging it. Read it as a rate, and
 * prefer a present-and-rising series over inferring anything from an absence:
 *
 *     sum by (agent_id, reason) (rate(paperclip_agent_dispatch_declined_total[15m]))
 *
 * `agent_id` is bounded by the active company roster exactly as
 * {@link CONCURRENT_RUN_BLOCKED_METRIC} bounds it, and collapses to
 * {@link UNKNOWN_AGENT_ID} for the process-wide guards that fire before the
 * agent row is loaded (those are not per-agent facts and must not look like it).
 */
export const AGENT_DISPATCH_DECLINED_METRIC = "paperclip_agent_dispatch_declined_total";
// BLO-23379: routine dispatch bypassed a long-parked execution issue instead of
// letting it gate the fire. Non-zero means a quota/capacity park was overridden;
// zero while a routine is quiet means it is genuinely gated on in-flight work.
export const ROUTINE_DISPATCH_METRIC = "paperclip_routine_dispatch_total";
export const AUTH_REQUEST_METRIC = "paperclip_auth_request_total";
/**
 * Per-route, per-status request counter (PEN-3702).
 *
 * Before this existed, `paperclip_auth_request_total` was the *only* request
 * counter in the process, and it is scoped to Better Auth operations — so no
 * query could characterise an episodic fault on an ordinary API route. The
 * concrete failure that motivated this: four list-route calls returned zero
 * rows during a database-pool excursion on 2026-09-24T04:05-04:11Z, and
 * because nothing retained per-request status it was never provable whether
 * those were empty `200`s or `5xx`s that the caller's row-counting script
 * rendered as `0`. A strong correlation that can never be promoted to a
 * measurement is the defect this closes.
 *
 * The access log cannot substitute. It carries the *raw URL*
 * (`GET /heartbeat-runs/<uuid> 200`), not the route template, and
 * `shouldSilenceHttpSuccessLog` drops successful requests on the hottest API
 * paths outright — so it is both unaggregatable and sampled by policy.
 */
export const HTTP_REQUESTS_METRIC = "paperclip_http_requests_total";
/**
 * Zero-row responses, as a strict subset of {@link HTTP_REQUESTS_METRIC}
 * (PEN-3702). Incremented only when a handler serialized a **bare empty
 * array**, so `empty / requests` is the empty-response rate for a route and
 * the `status` label says what an empty body was served *with*.
 *
 * This is what makes "I am broken" distinguishable from "you have nothing" at
 * the moment it is served: an empty `200` increments both families, while a
 * `503` increments only the request counter (its body is an error envelope,
 * not an array). Retrospectively the two are indistinguishable, which is why
 * the distinction has to be recorded live.
 */
export const HTTP_EMPTY_LIST_RESPONSES_METRIC = "paperclip_http_empty_list_responses_total";
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
/**
 * Ticks on which the worker's periodic recovery chain was skipped because the
 * previous pass was still running (PEN-3314).
 *
 * The chain is launched fire-and-forget from a fixed 30 s `setInterval`, so
 * before the latch existed a pass that ran long simply overlapped its
 * predecessor — invisibly. That invisibility is the reason this cost a
 * multi-day fleet outage: each overlapping pass pins its own copy of the whole
 * visible issue graph, so the only externally observable symptom was the worker
 * heap climbing to the 6.2 GB V8 ceiling and aborting every few hours, with
 * nothing anywhere naming overlap as the cause.
 *
 * Read it with {@link HEARTBEAT_RECOVERY_CHAIN_INFLIGHT_METRIC}: a non-zero
 * rate here means the chain is exceeding the scheduler interval, and the
 * in-flight gauge says by how much. (Not the *duration* gauge, which describes
 * the last pass to finish and so cannot see the one that is overrunning now.)
 * Sustained skipping is not itself data loss — these passes are reconcilers, so
 * a skipped tick is later work, not lost work — but it does mean recovery
 * latency now tracks chain duration rather than the interval, which is worth an
 * operator's attention well before the heap is.
 *
 * ⚠ This counter alone cannot tell "healthy" from "wedged", because it is the
 * one series here that the heartbeat tick still writes: it counts ticks that
 * reached the latch, so it goes FLAT both when the chain is comfortably keeping
 * up and when no tick is arriving at all. Disambiguate against the in-flight
 * gauge, which is refreshed independently of the tick — flat skips with a
 * climbing in-flight gauge is the second case, and it is the more urgent one.
 */
export const HEARTBEAT_RECOVERY_CHAIN_SKIPPED_METRIC = "paperclip_heartbeat_recovery_chain_skipped_total";
/**
 * Duplicate wake deliveries that the BLO-25726 idempotency machinery SUPPRESSED.
 *
 * This counts the race firing and being caught, not an absence. That direction
 * is deliberate: the obvious field signal for BLO-25726 ("no two runs share a
 * wake idempotency key") is unmeasurable from any read surface -- `heartbeat_runs`
 * carries no idempotency key, and its `wakeupRequestId` is 1:1 with runs by
 * construction, so a second dispatch minting a fresh wake row is invisible to
 * it. A zero there is vacuous. A non-zero here is positive proof the guard ran.
 *
 * Every cause is zero-initialized so the series exists before the first
 * suppression; an absent series and a quiet one must not look alike.
 *
 * Non-zero is EXPECTED and must not page -- it means a crash or a concurrent
 * reconciler pass hit the delivery window and the duplicate was declined. The
 * alertable inversion is this staying at zero while duplicate runs appear.
 */
export const WAKE_REDELIVERY_SUPPRESSED_METRIC = "paperclip_agent_wake_redelivery_suppressed_total";

const WAKE_REDELIVERY_SUPPRESSED_CAUSES = [
  "claim_contended",
  "claim_lost",
  "already_delivered",
  "fence_lost",
] as const;

/**
 * Which of the four BLO-25726 guards declined this redelivery.
 *
 * They are four, not one, because they fire at four different points in the
 * dispatch and are not interchangeable — collapsing them would make AC3
 * (concurrent reconcilers) indistinguishable from AC1 (enqueue-time key).
 *
 * - `claim_contended`: the compare-and-set claim on the `dispatch_failed` /
 *   expired-lease row lost to a concurrent pass, so this pass skipped BEFORE
 *   dispatching. The scheduler is not leader-elected, so this is the shape two
 *   replicas actually run (AC3).
 * - `claim_lost`: this pass held the claim, but the lease was reclaimed before
 *   its enqueue could commit, so the stale redelivery was dropped mid-flight.
 * - `already_delivered`: `enqueueWakeup`'s enqueue-time claim found a live wake
 *   row under the same idempotency key and delivery token and handed back that
 *   run rather than committing a second one (AC1/AC2).
 * - `fence_lost`: this pass did NOT deliver (its re-dispatch failed, or a gate
 *   declined or deferred it), ran past its lease, another pass reclaimed the
 *   row, and this pass's re-arm or terminal write was discarded rather than
 *   stamped over the new owner's live state -- a stale re-arm would hand the row
 *   back to the due-rows query while the new owner is still dispatching it. A
 *   fence lost AFTER this pass delivered is not counted: that wake reached a
 *   run, nothing was declined, and the new owner's redelivery of it is counted
 *   once, as `already_delivered`.
 */
export type WakeRedeliverySuppressedCause = (typeof WAKE_REDELIVERY_SUPPRESSED_CAUSES)[number];
/**
 * Wall-clock duration of the last COMPLETED periodic recovery chain, in seconds
 * (PEN-3314).
 *
 * Read this for how long the chain takes when it works. Do NOT build the overlap
 * alert on it: it is written only when a pass settles, so while a pass is
 * overrunning it holds the previous pass's value — which is by construction a
 * value *below* the interval, since that pass finished in time. A chain that is
 * currently running long, or wedged outright, reports a healthy-looking number
 * here. {@link HEARTBEAT_RECOVERY_CHAIN_INFLIGHT_METRIC} is the one that sees
 * the pass you actually care about.
 *
 * A gauge rather than a histogram because the question is "is the chain
 * outrunning the interval", not "what is the distribution of chain durations".
 */
export const HEARTBEAT_RECOVERY_CHAIN_DURATION_METRIC = "paperclip_heartbeat_recovery_chain_duration_seconds";
/**
 * How long the currently outstanding periodic recovery chain has been running,
 * in seconds; `0` when no pass is outstanding (PEN-3314).
 *
 * This is the leading indicator the incident lacked, and the one to alert on:
 * overlap begins precisely when this crosses `heartbeatSchedulerIntervalMs`
 * (default 30 s), which is observable hours before the heap ceiling is reached.
 * Unlike the duration gauge it describes the *live* pass, so it is also the only
 * signal that distinguishes a chain taking 35 s from a chain that has been
 * wedged for six hours — see {@link HEARTBEAT_RECOVERY_CHAIN_STALLED_METRIC}.
 *
 * It is refreshed by a dedicated timer of its own, NOT by the heartbeat tick, and
 * that distinction is the whole reason the series can be trusted. The tick only
 * reaches the recovery-chain latch after two `resolveSchedulingSuppression()`
 * round-trips; under the pool saturation this metric exists to catch, every tick
 * parks on those awaits, so a tick-driven refresh would freeze at whatever the
 * last settle wrote — `0` — and the worker would read idle and healthy for the
 * duration of the incident. The refreshing timer awaits nothing and queries
 * nothing, so `0` here means "no pass outstanding" independently of whether any
 * tick got far enough to say so, rather than "no pass outstanding as of the last
 * tick that got far enough to say".
 *
 * That timer samples at a FRACTION of `heartbeatSchedulerIntervalMs`
 * (`max(1s, interval / 3)`), deliberately finer than the threshold above:
 * sampling at the same period as the quantity being thresholded would let this
 * gauge lag the actual overlap crossing by up to a full interval. Treat that
 * fraction as the resolution of the alert — a crossing is visible within one
 * sample, not within one scheduler tick.
 *
 * Scope, so that `0` is not read more broadly than it holds: this covers the
 * *periodic* chain only, which is what the metric name says. The startup
 * recovery sequence runs several of the same reconcilers outside the latch, and
 * this timer is armed while that pass may still be running, so during the
 * startup window the gauge reports `0` with a recovery pass genuinely
 * outstanding. That window is uncovered rather than misreported.
 */
export const HEARTBEAT_RECOVERY_CHAIN_INFLIGHT_METRIC = "paperclip_heartbeat_recovery_chain_inflight_seconds";
/**
 * Recovery-chain passes that were still outstanding past the stall threshold
 * (PEN-3314 / PEN-3365). Counted once per stalled pass, not once per tick.
 *
 * Non-zero means a pass stopped settling entirely — not merely ran slow, which
 * shows up as skips instead — and therefore that **every recovery pass on this
 * worker is halted**: orphan reaping, retry promotion, stranded-issue
 * reconciliation, watchdogs, the lot. The latch deliberately does not self-clear
 * (force-clearing would re-admit the overlapping passes that cause the heap
 * leak, under exactly the saturated-pool conditions that raised the alarm), so
 * this state persists until the chain returns or the process restarts.
 *
 * **Page on this.** It is rare by design and it does not resolve itself.
 *
 * The companion `error` log ("periodic heartbeat recovery chain still in flight
 * across many ticks") reports the first crossing immediately and then re-reports
 * at most once per stall threshold while the halt lasts. So log-line count is a
 * measure of DURATION, not of severity or of how many passes stalled — read the
 * count off this counter, and read "how long" off `inFlightMs` on the newest
 * line.
 */
export const HEARTBEAT_RECOVERY_CHAIN_STALLED_METRIC = "paperclip_heartbeat_recovery_chain_stalled_total";

/**
 * Whether THIS process currently holds a named scheduler lease (BLO-43292).
 * `1` while it runs the loop, `0` while it does not.
 *
 * Labelled by pod, not by holder id: the holder id carries a per-process nonce
 * so a restarted pod cannot renew its predecessor's lease, and using it here
 * would mint a fresh series on every restart. The nonce is in the DB row and
 * in the acquire/lose log lines, which is where you want it when reconstructing
 * a handover.
 *
 * The alert is `sum by (lease) (...) != 1` — zero means nothing is running the
 * loop (fleet dispatch is dark, the 2026-10-05 failure), and more than one
 * means two processes believe they are the leader, which should be impossible
 * and is worth knowing immediately if it is not. Evaluate it with a `for:`
 * longer than {@link SCHEDULER_LEASE_RENEWED_METRIC}'s renew interval, since a
 * handover legitimately passes through zero.
 */
export const SCHEDULER_LEASE_HELD_METRIC = "paperclip_scheduler_lease_held";
/**
 * Unix time of this process's last SUCCESSFUL lease renewal, in seconds;
 * `0` if it has never held the lease (BLO-43292).
 *
 * `time() - ` this is renewal age. It is the one signal that separates "the
 * leader is renewing and the loop is simply quiet" from "the leader stopped
 * renewing and nobody has taken over yet" — the two look identical on
 * {@link SCHEDULER_LEASE_HELD_METRIC} alone for the length of the TTL.
 *
 * Written on every renew attempt including failed ones (the value then stays
 * where it was, so the age climbs), which is what makes a wedged renewer
 * visible rather than merely absent.
 */
export const SCHEDULER_LEASE_RENEWED_METRIC = "paperclip_scheduler_lease_last_renewal_timestamp_seconds";

/**
 * Isolation-workspace reaper sweep metrics (BLO-36814).
 *
 * The reaper (BLO-31222) performs a daily **irreversible** delete pass over
 * `data/k8s-isolation/workspaces/` and until now emitted a pino log line and
 * nothing else. A reaper that stopped ticking looked identical on every
 * dashboard to one that ticks and finds nothing — which is literally half of
 * how BLO-36735 found that it had never been switched on at all.
 *
 * **Series presence is itself the liveness signal, so nothing here is
 * pre-seeded at zero in `ensureRegistry()`.** Seeding would make "deployed but
 * never ran" indistinguishable from "ran and found nothing" on every counter —
 * reintroducing the exact blind spot this exists to remove. Instead
 * `recordIsolationWorkspaceReapSweep` materializes every child, including the
 * zero-valued ones, at the end of each sweep: after one tick the series exist
 * with honest values, and before the first tick they do not exist at all.
 *
 * `scanned` and `deleted` are first-class names rather than `outcome` labels
 * because they are the denominator and the headline of a destructive pass.
 * `skipped_layout` and `retained_resurrected` are first-class for a different
 * reason: non-zero on either is a *finding*, not routine, and folding them
 * into a generic outcome label makes them vanish under any `sum by ()` an
 * operator writes without thinking about it.
 */
export const ISOLATION_WORKSPACE_REAPER_SCANNED_METRIC = "paperclip_isolation_workspace_reaper_scanned_total";
export const ISOLATION_WORKSPACE_REAPER_DELETED_METRIC = "paperclip_isolation_workspace_reaper_deleted_total";
export const ISOLATION_WORKSPACE_REAPER_SKIPPED_LAYOUT_METRIC =
  "paperclip_isolation_workspace_reaper_skipped_layout_total";
export const ISOLATION_WORKSPACE_REAPER_RETAINED_RESURRECTED_METRIC =
  "paperclip_isolation_workspace_reaper_retained_resurrected_total";
export const ISOLATION_WORKSPACE_REAPER_ENTRIES_METRIC =
  "paperclip_isolation_workspace_reaper_entries_total";
export const ISOLATION_WORKSPACE_REAPER_SWEEPS_METRIC = "paperclip_isolation_workspace_reaper_sweeps_total";
export const ISOLATION_WORKSPACE_REAPER_LAST_SWEEP_METRIC =
  "paperclip_isolation_workspace_reaper_last_sweep_timestamp_seconds";
/** Routine per-entry outcomes. The two *findings* fields are NOT in here. */
export const ISOLATION_WORKSPACE_REAPER_ENTRY_OUTCOMES = [
  "eligible",
  "retained_in_use",
  "retained_fresh",
  "retained_nested_checkout",
  "vanished",
  "failed",
] as const;
/**
 * How the pass ended. `capped` and `lookup_faulted` both stop with work
 * remaining, but only the second means the remaining directories were never
 * assessed at all — see `IsolationWorkspaceReapResult.lookupFaulted`.
 *
 * `root_absent` is deliberately NOT folded into `complete`, even though both
 * scan zero directories. An absent root is the ordinary state on a
 * non-k8s-isolation deployment, but it is ALSO what an enabled reaper pointed
 * at the wrong path looks like — the BLO-31222 shape, where a real tree grows
 * unreclaimed while the sweep reports success over an empty one. Collapsing
 * the two would leave that case reading as a healthy `complete` sweep with
 * `scanned=0`, which is the same blind spot BLO-36814 exists to remove, one
 * layer in.
 */
export const ISOLATION_WORKSPACE_REAPER_STOP_REASONS = [
  "complete",
  "capped",
  "lookup_faulted",
  "root_absent",
] as const;
/**
 * Execution-workspace teardown work (PEN-3692).
 *
 * PEN-3692 measured the paperclip worker's cgroup sitting pinned at its 10 GiB
 * `memory.max` on reclaimable kernel slab, and attributed the fill to FAILED
 * runs by magnitude: across two regimes the slab fill ratio was 0.058
 * (CI 0.043–0.074) and of seven candidate drivers only `heartbeat_run_failed`
 * (x0.045) was consistent — all starts (x0.286), successful starts (x0.584)
 * and capacity-deferrals (x0.228) were excluded by magnitude, concurrency
 * (x1.055) and enqueued (x3.129) by sign, with `heartbeat_timer_checked`
 * (x1.005) as the flat positive control.
 *
 * That attribution rests on **two episodes either side of one regime
 * boundary**, so every signal stepped at the same time and the discrimination
 * is by magnitude alone — an unmeasured driver that also fell ~20x would fit
 * equally well. It is a natural experiment nobody controlled. These series
 * exist to replace it with a continuous one: they count the teardown work
 * itself rather than a proxy for it, so the slab residual can be regressed
 * against measured recursive-delete seconds instead of against a run-failure
 * counter that merely correlates.
 *
 * `trigger` is the label that earns its place. PEN-3692 could NOT say whether
 * the periodic collector or the per-failure run teardown is the dominant term
 * — both are live, both call the same function, and the row recorded that as
 * an open question. Splitting on trigger answers it directly.
 */
export const EXECUTION_WORKSPACE_TEARDOWN_METRIC = "paperclip_execution_workspace_teardown_total";
export const EXECUTION_WORKSPACE_TEARDOWN_DURATION_METRIC =
  "paperclip_execution_workspace_teardown_duration_seconds";
/**
 * Which caller asked for the removal. `unknown` is not padding: it is how an
 * unlabelled future call site shows up, and a rising `unknown` share means
 * this split has quietly stopped partitioning the work.
 *
 * ⛔ `persist_rollback` was called `run_teardown` until 2026-10-02, and that
 * name was a lie worth understanding before trusting this split. Its one call
 * site (`heartbeat.ts`) sits inside the `catch` wrapping the execution-workspace
 * persist step and fires only `if (executionWorkspace.created)` — i.e. the tree
 * reached disk but its ROW could not be written. It counts DB-write failures, a
 * rare population that sits near zero.
 *
 * **Run end performs no inline teardown at all.** It stamps
 * `cleanupEligibleAt = now + grace` with `cleanupReason: "run_ended"` and hands
 * the work to the collector — so per-failure run teardown is already INSIDE
 * `trigger="collector"`, and is separated from idle reclamation by
 * `cleanup_reason`, not by this label. Reading a flat `run_teardown` against a
 * large `collector` as "per-failure teardown is negligible" was therefore
 * attribution by magnitude against an uninstrumented alternative — the PEN-3692
 * error in a new costume. Found by Ally on this PR.
 */
export const EXECUTION_WORKSPACE_TEARDOWN_TRIGGERS = [
  "persist_rollback",
  "collector",
  "operator",
  "unknown",
] as const;
export type ExecutionWorkspaceTeardownTrigger =
  (typeof EXECUTION_WORKSPACE_TEARDOWN_TRIGGERS)[number];
/**
 * Why the workspace was eligible for collection — the split that actually
 * answers PEN-3692's question, since run-end teardown is deferred into
 * `trigger="collector"` (see above).
 *
 * `run_ended` is failed-and-succeeded-run-attributable work; `idle_backfill` is
 * reclamation of the pre-existing population. `not_applicable` is every
 * non-collector caller, which has no eligibility reason at all.
 *
 * `unknown` is a THIRD state and not a synonym for either: the row was made
 * eligible by a writer that recorded no reason (`cleanup_reason is null` with a
 * stamp set — today only the operator PATCH, plus rows a pre-PEN-3692 writer
 * stripped). That is a different silence from `not_applicable`, which says "this
 * caller has no eligibility reason by construction", and folding it into
 * `idle_backfill` would assert idle reclamation about work whose origin nobody
 * recorded. It carries the same meaning the trigger enum's `unknown` does — a
 * writer did not classify itself — which is why it reuses the name.
 *
 * It is a POPULATION, not a defect signal (Ally, review of 68b9cad). An earlier
 * draft of this block said the opposite — "after the heartbeat fix no production
 * writer should produce one" — which contradicted the two producers named three
 * lines above it, and in the direction a reader acts on: someone watching
 * `unknown` climb would go hunting a regression that does not exist. Both
 * producers are real and both are by design:
 *
 *   - The operator PATCH spreads `cleanupReason` and `cleanupEligibleAt` as
 *     INDEPENDENT optional fields (`routes/execution-workspaces.ts`), so
 *     `PATCH {cleanupEligibleAt: <past>}` stamps a row collectable while leaving
 *     the reason untouched, and `selectEligible` does not filter on the reason.
 *   - Rows the pre-PEN-3692 heartbeat writer already stripped are sitting in the
 *     table now with a stamp and no reason. They do not heal —
 *     `stampIdleLegacyWorkspaces` only rewrites rows whose `cleanupEligibleAt`
 *     is null — so they drain through `unknown` after deploy. Non-zero on the
 *     first pass that touches one, regardless of operator behaviour.
 *
 * What WOULD be a defect is a *NEW* code writer producing one, which is the
 * narrower thing `execution-workspace-cleanup-reason-writers.test.ts` guards.
 */
export const EXECUTION_WORKSPACE_CLEANUP_REASONS = [
  "run_ended",
  "idle_backfill",
  "unknown",
  "not_applicable",
] as const;
export type ExecutionWorkspaceCleanupReason =
  (typeof EXECUTION_WORKSPACE_CLEANUP_REASONS)[number];
/**
 * Which piece of tree-walking work was done. The first two are removals and are
 * not interchangeable work: a `git worktree remove` shells out and lets git walk
 * the tree, `remove_local_fs` is an in-process `fs.rm(recursive)`. Both end in
 * per-entry `unlink`, which is the dentry/inode pressure this row is chasing,
 * but only the second holds a libuv threadpool thread while doing it.
 *
 * `inspect_safety` is NOT a removal — it is `inspectWorktreeReclaimSafety`'s
 * `git status --porcelain`, a full tree walk the collector performs up to twice
 * per candidate (once to prove the tree safe to remove, once to prove it gone).
 * It is in this enum because it charges the same readdir/lstat pressure to the
 * same cgroup, so an integral that omits it omits what may be its largest term
 * — PEN-3692 §3(b) regresses slab residual against that integral, and a missing
 * dominant term would reproduce the mis-attribution the row exists to replace.
 *
 * ⚠️ Consequence, deliberate: summing the duration histogram over ALL methods is
 * the work integral, but `..._duration_seconds_count` therefore EXCEEDS
 * `..._teardown_total`, which counts removals only. Filter to the two removal
 * methods to compare the two metrics.
 */
export const EXECUTION_WORKSPACE_TEARDOWN_METHODS = [
  "worktree_remove",
  "remove_local_fs",
  "inspect_safety",
] as const;
export type ExecutionWorkspaceTeardownMethod =
  (typeof EXECUTION_WORKSPACE_TEARDOWN_METHODS)[number];
export const EXECUTION_WORKSPACE_TEARDOWN_OUTCOMES = ["succeeded", "failed"] as const;

/**
 * Periodic execution-workspace collector pass census (PEN-3692).
 *
 * `reconcileExecutionWorkspaceCleanup` already returns this shape and
 * `index.ts` already logs it unconditionally. Logs answer "what happened in
 * this pass"; these answer "at what rate, over a week, against the slab
 * residual" — which is the question PEN-3692 needs and the one a log with
 * normal retention cannot be regressed against.
 */
export const EXECUTION_WORKSPACE_COLLECTOR_SCANNED_METRIC =
  "paperclip_execution_workspace_collector_scanned_total";
export const EXECUTION_WORKSPACE_COLLECTOR_CANDIDATES_METRIC =
  "paperclip_execution_workspace_collector_candidates_total";
export const EXECUTION_WORKSPACE_COLLECTOR_STAMPED_METRIC =
  "paperclip_execution_workspace_collector_stamped_total";
export const EXECUTION_WORKSPACE_COLLECTOR_PASSES_METRIC =
  "paperclip_execution_workspace_collector_passes_total";
export const EXECUTION_WORKSPACE_COLLECTOR_LAST_PASS_METRIC =
  "paperclip_execution_workspace_collector_last_pass_timestamp_seconds";
/**
 * Per-candidate dispositions. These partition `scanned`; `stamped` does NOT
 * belong here because it counts rows the *backfill* made eligible, a different
 * population that this pass did not examine.
 */
export const EXECUTION_WORKSPACE_COLLECTOR_OUTCOMES = [
  "collected",
  "skipped",
  "failed",
] as const;
/**
 * How a collector pass ended. `skipped_saturated` is the entry gate: abandoned
 * fs calls already hold the threadpool, so the pass examined nothing. That is
 * the wedged-mount regime in which teardown stops and trees accumulate — the
 * condition PEN-3692 exists to explain — so it must be a counted reason, not a
 * missing record that reads like a dead worker. `ended_saturated` and
 * `ended_wedged` stopped part-way with candidates left unexamined.
 */
export const EXECUTION_WORKSPACE_COLLECTOR_STOP_REASONS = [
  "complete",
  "skipped_saturated",
  "ended_saturated",
  "ended_wedged",
] as const;
export type ExecutionWorkspaceCollectorStopReason =
  (typeof EXECUTION_WORKSPACE_COLLECTOR_STOP_REASONS)[number];

export type BackstopSource = (typeof BACKSTOP_SOURCES)[number];
export const BACKSTOP_SKIP_REASONS = [
  // `live_path` is NOT comparable across sources, so do not `sum by (reason)` over both.
  // For `stranded_recovery_wake_backstop` it is the active-run arm ALONE, with the
  // queued-owner-wake arm split out as `live_path_queued_wake` (BLO-19124). For
  // `issue_graph_liveness.backstop` it is still the union of both probes behind one `||`.
  // Scope every query by `source`.
  "not_ready", "existing_wake", "live_path", "live_path_queued_wake", "pause_hold", "interaction",
  "no_owner", "cause", "exhausted", "cooldown", "claim_lost",
  "pending_wake", "deferred_or_failed", "enqueue_failed",
] as const;
export type BackstopSkipReason = (typeof BACKSTOP_SKIP_REASONS)[number];
/**
 * Webhook deliveries turned away at the ingestion readiness guard (BLO-28803).
 *
 * `POST /api/plugins/:pluginId/webhooks/:endpointKey` returns from that guard
 * long before the `plugin_webhook_deliveries` insert, so a rejected delivery
 * used to leave no row, no counter and no log. During the 2026-08-18 alert
 * blackout ([BLO-20813]) the only surviving evidence that ~15h of alert
 * batches had been turned away lived in *Alertmanager's* logs — Paperclip, the
 * system of record for alerting, could not answer "how many did we bounce, and
 * for which plugins?".
 *
 * This is the counter that answers it. It matters more since [BLO-28659]
 * converted rejection from destruction into deferral: deliveries now pile up
 * at the sender instead of failing loudly, so a plugin quietly bouncing every
 * delivery for hours is otherwise indistinguishable from one receiving none.
 * Silence is not health.
 *
 * `response_class` separates the two outcomes that must never aggregate:
 * `retryable` (503 — the sender will come back, payloads are merely delayed)
 * from `terminal` (410 — the plugin is gone and the payloads are being
 * dropped on purpose). `plugin_status` carries the underlying cause.
 *
 * Cardinality guardrail — this route is public and unauthenticated, so the
 * bound is load-bearing rather than decorative. Labels are read from the
 * *resolved database row*, never from the caller-supplied `:pluginId` path
 * parameter: a POST naming a plugin that does not exist is rejected 404 one
 * step earlier and mints no series at all. On top of that,
 * {@link boundWebhookRejectionPluginKey} admits at most
 * {@link MAX_TRACKED_WEBHOOK_REJECTION_PLUGIN_KEYS} distinct keys per process
 * and collapses the rest to {@link OVERFLOW_WEBHOOK_REJECTION_PLUGIN_KEY}, so
 * the hard ceiling is `(64 + 1) * 5` series — five because `ready` never
 * reaches the guard — independent of the plugins table and of request volume.
 * Abuse costs a counter increment on an existing series, never storage.
 */
export const PLUGIN_WEBHOOK_DELIVERY_REJECTED_METRIC = "paperclip_plugin_webhook_delivery_rejected_total";
/**
 * PEN-3000: recovery actions retired by `escalateExpiredWakeHorizons`, split by whether a wake
 * was delivered to the action's CURRENT owner.
 *
 * These are two different events that render identically today. `attemptCount` is the count
 * of wakes that actually REACHED THE QUEUE, not the count of sweeps: `upsertSourceScoped`
 * reserves `+1` per sweep and `releaseWakeAttempt` refunds it whenever `enqueueWakeup`
 * returned null (BLO-18996 review follow-up), so reserve-then-refund nets to zero and the
 * counter freezes at the number of delivered wakes.
 *
 * The claim is scoped to the CURRENT OWNER SEQUENCE, not the row's whole life: owner churn
 * restarts the counter (`attemptCount: isNewOwnerSequence ? 1 : existing.attemptCount + 1`
 * in `upsertSourceScopedUnlocked`), so a row that woke owner A three times, was handed to
 * owner B, and then had B's only reservation refunded reads `attemptCount: 0` too. A row
 * therefore reaches its horizon at 0 only after EVERY sweep since the current owner took
 * over failed to deliver — a wake-channel failure (provider-capacity deferral, tree pause
 * hold, wake disabled, cooldown) for that owner, not an owner who was woken and failed to
 * converge. Nothing on the row records the lifetime delivered count, and
 * `previousOwnerAgentId` cannot stand in for "never churned": the stranded sweep writes it
 * from the issue's current assignee on the very first insert (`recovery/service.ts`,
 * `previousOwnerAgentId: input.issue.assigneeAgentId`), so it is non-null on exactly the
 * population PEN-3000 measured and gating on it would silence the series.
 *
 * Splitting them is what makes the first alertable. `never_delivered` is a scheduler-side
 * fault and should page (`PaperclipRecoveryHorizonNoWakeToCurrentOwner{Elevated,Sustained}` in
 * `deploy/helm/paperclip/templates/prometheusrule.yaml`); `delivered` is a genuine
 * unresolvable stranding and is expected to occur at a low background rate. Measured
 * motivation (PEN-3000, fleet sweep of 2026-09-07): 19 of 25 live expired actions were at
 * `attemptCount: 0`, and BLO-19124 could see the symptom but not separate the populations.
 * The action id, cause and owner stay on the paired structured log line rather than becoming
 * labels, matching the cardinality rule used above.
 */
export const RECOVERY_HORIZON_EXPIRED_METRIC = "paperclip_recovery_horizon_expired_total";
export const RECOVERY_HORIZON_DELIVERY_STATES = ["never_delivered", "delivered"] as const;
export type RecoveryHorizonDeliveryState = (typeof RECOVERY_HORIZON_DELIVERY_STATES)[number];
/**
 * PEN-3976: recovery actions discharged by a sweep rather than by a human-equivalent call,
 * because a run on the source issue reached `succeeded` after the action was created.
 *
 * Worth its own series because the thing it measures is the SIZE OF A BACKLOG THAT USED TO
 * BE UNBOUNDED, and the two directions mean opposite things. In steady state this should sit
 * near zero: an action is minted, the row is repaired, the owner discharges it, and the sweep
 * finds nothing. A sustained non-zero rate means owners are routinely not discharging actions
 * whose remedy landed — the PEN-3631 / PEN-3102 shape, where an action sat `escalated` for 5
 * and 20 days respectively while its own row executed successfully. A one-off spike at
 * rollout is the accumulated population draining and is expected exactly once.
 *
 * Labeled by `kind` only. It is a bounded enum (`ISSUE_RECOVERY_ACTION_KINDS`, and narrower
 * still here — `RESTORED_EXECUTION_DISCHARGE_KINDS` is a 3-member subset), which matters
 * because `kind` is the axis that separates "a stranded row started running again" from "a
 * workspace repair landed and nothing noticed". The action id, issue and evidencing run id
 * stay on the paired structured log line rather than becoming labels, matching the
 * cardinality rule used by the sibling recovery metrics above.
 */
export const RECOVERY_ACTION_AUTO_DISCHARGED_METRIC = "paperclip_recovery_action_auto_discharged_total";
/**
 * Relay failures in the worker-tier proxy, labeled by the reason the request
 * never produced a worker response (BLO-31945).
 *
 * Exists because the only record of this failure was a log line, and the api
 * pod's log is not an instrument: `paperclip-0` is recreated often enough that
 * `--since=24h` silently resolves to whatever survived the last recreation
 * (measured 2026-09-16: ~36 minutes, and `--previous` returns nothing at all).
 * An acceptance criterion asserting "zero relay failures over a rolling 24h"
 * was therefore unevaluable in either direction against that surface. The
 * counter has normal retention, so the same question is a range query.
 *
 * Cardinality is three series by construction —
 * {@link KNOWN_WORKER_TIER_PROXY_FAILURE_REASONS} is a closed set, not caller
 * input. `timeout` means the connection succeeded and the worker was still
 * silent when the proxy's own deadline fired; `mid_stream` means the worker
 * answered and the response then broke after headers were already flushed;
 * `unreachable` means the request never got that far. They are separated
 * because they route differently: `timeout` is worker latency, `mid_stream` is
 * a worker that died or was restarted mid-response, and only `unreachable`
 * points at a missing Service endpoint.
 */
export const WORKER_TIER_PROXY_FAILURES_METRIC = "paperclip_worker_tier_proxy_failures_total";
export const KNOWN_WORKER_TIER_PROXY_FAILURE_REASONS = [
  "timeout",
  "mid_stream",
  "unreachable",
] as const;
export type WorkerTierProxyFailureReason =
  (typeof KNOWN_WORKER_TIER_PROXY_FAILURE_REASONS)[number];
export const HEARTBEAT_RUN_FAILED_METRIC = "paperclip_heartbeat_run_failed_total";
/**
 * `error_code` booked when a `job_failed` run is proven to be the Caveman-proxy
 * readiness timeout (BLO-33441). Classified in `k8s-job-liveness.ts`; declared
 * here so the metric layer can key on it without importing
 * `@kubernetes/client-node`.
 *
 * `error_code` on this counter is free-form (it is `heartbeat_runs.error_code`
 * passed through), so this is a shared constant rather than an allow-list entry
 * — there is no list to add it to.
 *
 * Exists because BLO-33279's AC5 ("zero occurrences for 7 days") was
 * unverifiable: the failure fell into `job_failed`, a catch-all running ~8000
 * per 7d against a defect firing ~10/day, so the query returned "clean" whether
 * or not the defect recurred. With its own code the check is
 * `increase(paperclip_heartbeat_run_failed_total{error_code="caveman_proxy_not_ready"}[7d]) == 0`
 * and stays honest.
 */
export const CAVEMAN_PROXY_NOT_READY_ERROR_CODE = "caveman_proxy_not_ready";
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

/**
 * Penstock availability-gate probe counter (BLO-29900).
 *
 * ## Why this counter has to exist before anything else gets "fixed"
 *
 * `CCROTATE_CAPACITY_MAX_PARK_MS` (15m) is a deliberate trade: re-probe often
 * rather than honour a provider horizon measured going stale within hours
 * (BLO-23438 — ~76 runs frozen 5.2 days). That trade is sound *only if
 * re-probing is cheap*, and the clamp's own docblock asserts exactly that —
 * "Re-probing is a single cached GET".
 *
 * The assertion is **conditional, and the condition was unstated**. When
 * `readPenstockCapacity` yields no verdict (404, non-ok status, unparseable
 * body, or `state: "unknown"` without an authoritative reason) the gate falls
 * through to `probePenstockAnthropicModel` — a real `POST /v1/messages`
 * against the provider that is currently exhausted. The 30s verdict cache
 * cannot absorb it at a ~15m cadence, and the fallback is anthropic-only,
 * which matches the firing alert set (`LLMProxyProviderCapacityRetryStorm
 * {provider="anthropic"}`, no codex equivalent).
 *
 * Before this counter, that path was **unobservable**: `penstock_proxy_requests_total`
 * carries no `route` label, so probe traffic could not be separated from real
 * dispatch, and both probe paths persisted the same `reason` on a 429. The
 * fallback's existence is provable from the code; its *rate* is not provable
 * from anything that existed. This series is what turns that into a
 * measurement — deliberately shipped on its own, ahead of any suppression, so
 * the decision to suppress rests on a number rather than on arithmetic over an
 * unlabelled series (the BLO-29779 error).
 *
 * ## Reading it
 *
 * - `path="capacity"` counts every capacity **attempt**, whatever it returned.
 *   It is the denominator: fallback share is
 *   `{path="messages_fallback"} / {path="capacity"}`.
 * - `path="messages_fallback"` counts the provider-inference probes actually
 *   paid for. **An absent series means the fallback has not been taken since
 *   process start.** Seeding (next bullet) is per `(path, provider, model)`
 *   tuple, so it does not mint a fallback tuple that has never been taken.
 *   Confirm the gate is probing at all by checking the `path="capacity"`
 *   series is advancing; do not read fallback silence alone as health.
 * - **Outcomes are seeded at zero per tuple (PEN-4675).** The first probe
 *   recorded for a `(path, provider, model)` materialises all six
 *   {@link KNOWN_PENSTOCK_PROBE_OUTCOMES} children for that tuple at `0`, so
 *   *within a tuple that has probed at least once* an outcome that never fired
 *   reads `0` instead of having no series. Without it `absent(...)` and `== 0`
 *   were indistinguishable and the ambiguity failed in the reassuring
 *   direction — on PEN-2514/PEN-4462 `outcome="deny_capacity"` was absent for
 *   80 consecutive hours while the gate was demonstrably probing, and a
 *   `deny_temporary` child was observed alive at a flat `0` for 16 h and then
 *   gone with its pod, i.e. child presence was tracking pod lifetime rather
 *   than denial activity. **Seeding does not survive a restart**: series are
 *   per process, so absence across a pod boundary is still uninformative and a
 *   verdict over a window spanning one must say so.
 * - Cache hits do **not** increment. Only real network probes are counted, so
 *   the ratio above is over re-probes rather than over gate calls.
 * - **The fail-open set is path-qualified:** `path="messages_fallback"` with
 *   `outcome=~"error|auth_fault"`, **plus `path="capacity"` with
 *   `outcome="error"`** since BLO-29900 item 3 stopped that branch falling
 *   through (a transport failure says nothing about the model, and the
 *   fallback would reuse the transport that just failed). Those return
 *   `allow: true` with no verdict — `penstock-availability-gate.ts:762` for the
 *   auth fault, `:804`/`:813` for fallback transport errors, and
 *   `capacityOutcomeJustifiesFallback` for the capacity one — so a *broken*
 *   probe is indistinguishable from a healthy one on every other signal, and
 *   that set is what an alert wants. `path="capacity"` with
 *   `outcome="auth_fault"` (or `"inconclusive"`) is fail-open **only on a
 *   provider with no fallback**: on `anthropic` it falls through and the
 *   fallback decides, but `resolvePenstockCheck` sets `messagesUrl` for
 *   anthropic alone, so on `codex` there is nothing to fall through *to* and
 *   every verdict-less capacity outcome returns `allow: true` terminally.
 *   Alerting on `outcome="error"` alone misses every entitlement fail-open;
 *   alerting on the fallback path alone now misses the capacity-transport one,
 *   and misses **all** of codex, which has no fallback series at all.
 *
 * Cardinality: `path` and `outcome` are fixed allow-lists (2 x 6), coerced
 * here. Per-tuple seeding realises all 6 outcomes for every observed
 * `(path, provider, model)` rather than only the ones that fired, so the live
 * series count is the tuple count x 6 — bounded by the same tuple space the
 * counter already pays for, and tens of series at current fleet shape.
 * `provider` is deliberately **not** coerced: it is bounded by its
 * caller's own `PenstockProvider` union instead, because collapsing a
 * genuinely new third provider to "unknown" would hide exactly the per-provider
 * probe cost this series exists to attribute. `model` comes from
 * operator-managed `adapterConfig.model`, so it is bounded by the models
 * configured across the fleet — small, and never attacker- or request-supplied.
 */
export const PENSTOCK_AVAILABILITY_GATE_PROBE_METRIC = "penstock_availability_gate_probe_total";
/**
 * Latency of one availability-gate probe, in seconds
 * ({@link PENSTOCK_AVAILABILITY_GATE_PROBE_METRIC} is the count).
 *
 * Labeled `path` and `provider` only: `model` and `outcome` are omitted on
 * purpose because a histogram multiplies every label combination by the bucket
 * count, and the question this series answers — "is the fallback probe
 * materially more expensive than the capacity GET?" — does not need them. The
 * counter keeps the finer breakdown.
 */
export const PENSTOCK_AVAILABILITY_GATE_PROBE_DURATION_METRIC =
  "penstock_availability_gate_probe_duration_seconds";

/** Which probe produced a verdict. Mirrors `PenstockProbePath` in the gate. */
export const KNOWN_PENSTOCK_PROBE_PATHS = ["capacity", "messages_fallback"] as const;
export type PenstockProbePathLabel = (typeof KNOWN_PENSTOCK_PROBE_PATHS)[number];

/**
 * Probe outcomes, as an allow-list so a future branch cannot mint a series.
 *
 * - `ok` — probe answered and capacity is available (the gate allows).
 * - `deny_capacity` — answered `penstock.model_capacity_unavailable`.
 * - `deny_temporary` — answered `penstock.model_temporarily_unavailable`.
 * - `inconclusive` — the capacity probe returned no verdict. On a provider with
 *   a fallback (`anthropic`) this is the branch that triggers it, so its rate
 *   is the fallback's cause; on `codex` there is nothing to trigger and it is a
 *   terminal fail-open — see "Reading it" above for why.
 *   Minted on `path="capacity"` only; the messages probe never returns it.
 * - `auth_fault` — 401/403. Kept separate from `error` because PEN-2513's whole
 *   finding is that an entitlement fault read as a capacity signal parks
 *   forever on a horizon that cannot expire it. Fails **open** on
 *   `path="messages_fallback"`; on `path="capacity"` it yields no verdict and
 *   falls through to the fallback **where one exists (`anthropic`); on `codex`
 *   there is none, so it too is a terminal fail-open**.
 * - `error` — transport failure or timeout. Fails **open** on **both** paths.
 *   On `path="capacity"` it used to fall through to the fallback; BLO-29900
 *   item 3 stopped that, because a transport failure says nothing about the
 *   model and the fallback would reuse the transport that just failed. So
 *   `path="capacity", outcome="error"` is now a terminal fail-open, and it is
 *   the series to watch: it is the gate going blind, not the gate deciding.
 */
export const KNOWN_PENSTOCK_PROBE_OUTCOMES = [
  "ok",
  "deny_capacity",
  "deny_temporary",
  "inconclusive",
  "auth_fault",
  "error",
] as const;
export type PenstockProbeOutcomeLabel = (typeof KNOWN_PENSTOCK_PROBE_OUTCOMES)[number];

/**
 * Buckets sized to the gate's own 3s `timeoutMs`: sub-100ms is a healthy
 * same-region hop, and the 3s/5s tail exists so an aborted probe is visible
 * rather than collapsed into `+Inf`.
 */
const PENSTOCK_PROBE_DURATION_BUCKETS_SECONDS = [
  0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 3, 5,
] as const;

// BLO-32843: a run requested a model profile (e.g. `cheap`) that did not apply,
// so it ran on the agent's primary model. Labels are all bounded.
export const MODEL_PROFILE_UNAPPLIED_METRIC = "paperclip_model_profile_unapplied_total";

export const HEARTBEAT_TIMER_SCHEDULER_EXCLUSION_METRIC =
  "paperclip_heartbeat_timer_scheduler_exclusion_total";
/**
 * Heartbeat timer-loop liveness pair (BLO-32269). Incremented once per
 * `tickTimers` pass with that pass's own `checked`/`enqueued` totals — the same
 * two integers the worker already logs as
 * `heartbeat timer tick enqueued runs {"checked":N,"enqueued":M}`.
 *
 * These exist so "the fleet has stopped dispatching" can be alerted on the
 * dispatcher itself rather than on a downstream proxy. `PaperclipFleetDispatchDark`
 * previously keyed on `absent(paperclip_agent_heartbeat_age_seconds)` (1-for-3:
 * that gauge is conditionally emitted and blinks ~3x/day) and then on
 * {@link ISOLATED_RUN_STARTED_METRIC}, which counts only *isolated* per-run k8s
 * Job starts and would therefore read zero for a fleet running exclusively
 * shared-isolation work. See BLO-32063.
 *
 * Read them as a pair — that is the whole point of exporting both:
 *   - `checked > 0, enqueued = 0` — candidates were examined and the loop
 *     deliberately enqueued nothing (none due, or every one gated). Healthy.
 *   - `checked = 0` — *no candidate was examined*. See below; this is NOT by
 *     itself evidence that the loop is dead.
 * Those two states have different remediations and are indistinguishable from
 * outside the process today.
 *
 * `checked = 0` is deliberately worded as "no candidate examined" rather than
 * "no tick completed", because a tick can complete normally and still record
 * zero. `checked` is only incremented after three `continue` filters in
 * `tickTimers` (agent not invokable; heartbeat policy disabled or
 * `intervalSec <= 0`; a `getWorktreeExecutionCutoff()` cutoff with no eligible
 * issue behind it), so a fleet where every agent trips one of those yields a
 * completed pass with `checked = 0`. Those three filters are unchanged, and so
 * is what this counter counts — but since PEN-4737 they are no longer silent:
 * each one now increments
 * {@link HEARTBEAT_TIMER_SCHEDULER_EXCLUSION_METRIC} under `agent.not_invokable`
 * / `heartbeat.disabled` / `heartbeat.worktree_execution_cutoff` and writes a
 * durable `agent_wakeup_requests` row, rate-limited to one per agent per reason
 * per hour. The full cause list is therefore:
 *   1. the loop is wedged or the process is dead — the case worth paging on;
 *   2. every candidate was filtered out before the counter (above);
 *   3. global scheduling suppression — the caller does not enter `tickTimers`
 *      at all (`server/src/index.ts`), so nothing is recorded;
 *   4. this process is not the `heartbeat-timer` lease holder (a follower
 *      returns before `tickTimers`, BLO-43292). Startup/takeover recovery
 *      (`heartbeatStartupRecoveryPending`) is no longer a cause: since
 *      BLO-49303 the timer enqueue runs ahead of that gate;
 *   5. the shutdown drain has begun (`heartbeatSchedulerStopped`);
 *   6. the pass completed but {@link recordHeartbeatTimerTick} rejected it as
 *      malformed and dropped **both** halves — see its own doc comment. This
 *      should never happen (both inputs are integer accumulators) and is the
 *      only cause of the six that emits a `logger.warn` naming the bad field,
 *      so the worker log settles it outright.
 * Only (1) warrants a restart. Rule out 2–6 first.
 *
 * {@link HEARTBEAT_TIMER_SCHEDULER_EXCLUSION_METRIC} narrows a zero `checked`
 * for the first time since PEN-4737, but does not resolve it alone. A zero
 * `checked` carrying a non-zero `agent.not_invokable` / `heartbeat.disabled` /
 * `heartbeat.worktree_execution_cutoff` increase over the same window says the
 * per-agent loop RAN and excluded agents ahead of the counter, with a durable
 * `agent_wakeup_requests` row per excluded agent naming which filter caught it.
 * That is cause (2) — or cause (6), which lets those same increments through
 * (they are recorded in the loop, not in the rejected tick) and then drops both
 * halves of the pass. The `logger.warn` (6) emits is what separates the two.
 *
 * Read the absence carefully in the other direction: the ledger behind those
 * three labels is rate-limited to one increment per agent per reason per hour,
 * so a window shorter than an hour can legitimately show a zero increase while
 * cause (2) is still in force. Widen the window before concluding it is not (2).
 *
 * It attributes none of 1, 3, 4 or 5, and must not be read as doing so: every
 * one of its call sites is inside the per-agent loop, which (3)/(4)/(5) never
 * enter and (1) never reaches. Distinguish those from process state instead —
 * worker uptime and the scheduling-suppression record for (1)/(3), and the
 * worker log for (4)/(5)/(6).
 *
 * `checked` is also a composite: agents examined, plus `issueMonitors.checked`,
 * plus `expiredIssueMonitors.checked`. A consumer cannot decompose it, so
 * `checked > 0` can be carried entirely by due issue monitors with zero agents
 * examined. That is fine for a liveness rule — the loop demonstrably ran — but
 * do not read it as "agents were considered".
 *
 * Deliberately unlabeled: the consumer is `sum(increase(...[15m])) == 0`, so
 * per-agent breakdown would add cardinality without adding signal. Reason-level
 * detail for timer-loop exclusions lives in
 * {@link HEARTBEAT_TIMER_SCHEDULER_EXCLUSION_METRIC}, which since PEN-4737
 * spans both sides of this counter: four reasons for candidates excluded after
 * `checked += 1`, and three for agents filtered before it. It is still not
 * per-agent — that detail is in `agent_wakeup_requests`, not in a label.
 *
 * Both counters are emitted by the *worker* (`StatefulSet/paperclip`), which is
 * where the timer loop runs and which deploys independently of
 * `Deployment/paperclip-api` (BLO-29004).
 */
export const HEARTBEAT_TIMER_CHECKED_METRIC = "paperclip_heartbeat_timer_checked_total";
export const HEARTBEAT_TIMER_ENQUEUED_METRIC = "paperclip_heartbeat_timer_enqueued_total";

/**
 * BLO-32553: count of adapter run events dropped because they arrived after the
 * run had already reached a terminal status.
 *
 * Labeled by the run's terminal status only. The event type is deliberately NOT
 * a label: it is adapter-supplied and unbounded, so labeling on it would let any
 * adapter mint arbitrary time series. The dropped event's type, message and
 * payload are carried on the accompanying `logger.warn` instead, which is where
 * the per-drop evidence lives.
 */
export const HEARTBEAT_POST_TERMINAL_RUN_EVENT_DROPPED_METRIC =
  "paperclip_heartbeat_post_terminal_run_event_dropped_total";

/**
 * Bounded label domain for {@link HEARTBEAT_POST_TERMINAL_RUN_EVENT_DROPPED_METRIC}.
 * Mirrors `HEARTBEAT_RUN_TERMINAL_STATUSES` in `heartbeat.ts` (including
 * `interrupted`, which is what `isHeartbeatRunTerminalStatus` treats as terminal).
 * Duplicated rather than imported to keep metrics.ts free of a heartbeat.ts import.
 */
export const KNOWN_HEARTBEAT_POST_TERMINAL_RUN_STATUSES = [
  "succeeded",
  "interrupted",
  "failed",
  "cancelled",
  "timed_out",
] as const;

export type KnownHeartbeatPostTerminalRunStatus =
  (typeof KNOWN_HEARTBEAT_POST_TERMINAL_RUN_STATUSES)[number];

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
// PEN-4280/PEN-4293: the same measurand as QUEUED_RUN_OLDEST_AGE_METRIC with the
// structurally-unclaimable population removed. A queued run whose issue is not
// dependency-ready (and which is not an exempted issue-interaction wake) is
// deliberately refused the front of the dispatch queue -- `dispatchRank` files
// it below every routine row and will not let it age forward, and
// `claimQueuedRun`'s cancel-on-blocked screen only fires on a claim that
// therefore never arrives. Its wait is NOT dispatch latency, and counting it as
// such reads a healthy dispatcher as starvation (measured 2026-10-18: 21.8x
// threshold on one seat, four queued runs stacked on one `blocked` issue in
// 17 minutes).
//
// Published ALONGSIDE the original rather than replacing it: a consumer reads
// the original, and the two differing is itself the signal that undispatchable
// work is piling up.
export const QUEUED_RUN_OLDEST_CLAIMABLE_AGE_METRIC =
  "paperclip_queued_run_oldest_claimable_age_seconds";
export const QUEUED_RUN_AGE_METRICS_REFRESH_SUCCESS_METRIC = "paperclip_queued_run_age_metrics_refresh_success";
// BLO-32638: a routine's receipt that it took a measurement is a `done` issue
// row, which Prometheus cannot see. So a routine silently disabled for
// intervals is indistinguishable, on every existing metrics surface, from one
// that is healthy and quiet -- 11 blind windows (largest 47.5h) accumulated on
// the alert-delivery bridge watchdog that way, one of them hiding a real
// outage that destroyed 22 of 42 alerts.
//
// Deliberately NOT covered by ROUTINE_DISPATCH_METRIC, and the gap is the
// point: every label on that counter requires a fire to have ATTEMPTED
// dispatch. None of them move when a routine stops producing completed fires,
// and none are emitted at all when a fire dispatches fine and its run then
// dies quietly. Through the measured window cadence was correct, run-status
// tallies read healthy, and no dispatch counter moved abnormally.
//
// The pair is a gauge and its own denominator so ONE alert rule covers every
// routine: `age > 2 * interval`. A hand-maintained per-routine threshold is
// the thing that rots silently when a cron is edited.
export const ROUTINE_LAST_DONE_FIRE_AGE_METRIC = "paperclip_routine_last_done_fire_age_seconds";
export const ROUTINE_LAST_FIRE_START_AGE_METRIC = "paperclip_routine_last_fire_start_age_seconds";
export const ROUTINE_FIRE_INTERVAL_METRIC = "paperclip_routine_fire_interval_seconds";
export const ROUTINE_FIRE_GAP_METRICS_REFRESH_SUCCESS_METRIC = "paperclip_routine_fire_gap_metrics_refresh_success";
// PEN-3734: age of the oldest *pending* `deferred_issue_execution` wake per
// agent. A wake deferred behind an issue's execution lock is promoted only
// when a run on that issue finalizes, one per finalization, and the lock is
// held globally across agents -- so an agent's comment-delivery latency on a
// row is bounded below by the queue wait of every other agent's run ahead of
// it there, a quantity none of them can see or influence. Measured at 10h53m
// on PEN-3164.
//
// Deliberately NOT covered by QUEUED_RUN_OLDEST_AGE_METRIC, and the gap is the
// whole point: a deferred wake creates NO `heartbeat_runs` row at all (that is
// the documented contract of the deferral, not an omission), so there is
// nothing for a run-table gauge to age. Every other surface is blind too --
// the recipient's seat has no row to find, and the issue's `lastActivityAt` is
// ADVANCED by each undelivered comment, so staleness sweeps read a starving
// row as freshly healthy. Only `agent_wakeup_requests` knows, and until this
// gauge nothing read it.
//
// Labeled by bounded agent_id (same allow-list guardrail as
// QUEUED_RUN_OLDEST_AGE_METRIC) so `max by (agent_id) (...) > threshold` names
// whose wake is starving. The issue id is NOT a label -- it is unbounded
// cardinality -- so the refresh logs it instead; see
// refreshDeferredIssueExecutionWakeAgeMetrics.
export const DEFERRED_ISSUE_EXECUTION_WAKE_OLDEST_AGE_METRIC =
  "paperclip_deferred_issue_execution_wake_oldest_age_seconds";
export const DEFERRED_ISSUE_EXECUTION_WAKE_AGE_METRICS_REFRESH_SUCCESS_METRIC =
  "paperclip_deferred_issue_execution_wake_age_metrics_refresh_success";
// PEN-4652. An `in_review` issue with NO waiting path at all. The classifier
// for this already exists and is correct -- `in_review_without_action_path` in
// recovery/issue-graph-liveness.ts -- but its only consumer is the
// blocked-inbox attention projection, which is reached solely by an explicit
// `attention=blocked` list filter. That is a PULL surface, so it renders the
// state only when some OTHER blocked row happens to depend on the cold one. The
// agent-facing push surface cannot cover the gap either: `inboxLite` excludes
// `in_review` BY DESIGN, because review waits are meant to resume on a comment,
// interaction or monitor wake -- which is exactly what a row in this state no
// longer has. So the state was computable and unobservable at the same time,
// and nothing escalated it.
//
// THE GAUGE IS A PROJECTION OF THE CLASSIFIER, not a second opinion about what
// "cold" means, and that is load-bearing rather than tidy. The first revision
// re-derived the predicate in SQL from four signals (live run, future monitor
// check, unexpired park, active recovery action). `hasExplicitWaitingPath`
// honours eight satisfiers, and that approximation could see none of these: a
// queued wake request, a live pending interaction, a pending approval, an open
// recovery issue, a recent open pull request, a user assignee. (It is not a
// clean 4-of-8 subset -- the SQL's `issue_recovery_actions` probe is a
// different table from the classifier's open-recovery-ISSUE arm, and its run
// probe covers only part of one arm -- which is itself the reason a
// hand-rolled restatement of this predicate is a bad idea.) Those missing
// satisfiers are the COMMONEST legitimate `in_review` waits, so the SQL
// published every one of them as cold -- an upper
// bound wearing the name of a strand rate, on the one instrument built to
// inform escalation policy. `recovery/service.ts` warns (PEN-3198) that two
// copies of this predicate drift silently; there is now one.
//
// Measured 2026-10-24T08:5xZ, company b1d3f3d3, complete 63-row `in_review`
// population: 25 (40%) matched that four-signal approximation -- 14 lapsed
// (monitor fired, never re-armed) and 11 never armed (both monitor timestamps
// null), oldest 1,366 h. READ THAT AS AN UPPER BOUND on the strand rate, not as
// the rate: it predates this gauge and was taken with the wider predicate. Over
// the same window exactly ONE `harness_liveness_escalation` was open across 187
// ever minted, and it named none of the 25, with the most recent mint 39 h
// earlier against a 1-5/day baseline -- which is the part that stands
// regardless of predicate, and the reason for a carrier.
//
// Ages off `last_activity_at` -- the last MEANINGFUL change, which is the clock
// the escalation staleness gate already reads, rather than `updated_at`, which
// metadata-only writes reset. Labeled by bounded agent_id; an unassigned cold
// row folds into the UNKNOWN_AGENT_ID bucket, and the issue id is unbounded
// cardinality so it never becomes a label.
//
// TIER AND CADENCE, because they are not the usual ones for a gauge in this
// file: it is published from `reconcileIssueGraphLiveness` where the classifier
// verdicts already exist, so it lives on the WORKERS tier only, and refreshes
// once per recovery CHAIN rather than once per 30s tick -- a chain routinely
// outlives one interval. Scope any query to `service="paperclip-workers"` -- but
// that selector is necessary, not sufficient: the chain is single-leader WITHIN
// that tier, so every non-leader worker replica also sits at a permanent 0.
// Aggregate across replicas (`max by (service) (...)`) rather than alerting
// per-replica, and do not size a `for:` off the tick interval.
export const COLD_IN_REVIEW_ISSUE_OLDEST_AGE_METRIC =
  "paperclip_cold_in_review_issue_oldest_age_seconds";
export const COLD_IN_REVIEW_ISSUE_METRICS_REFRESH_SUCCESS_METRIC =
  "paperclip_cold_in_review_issue_metrics_refresh_success";
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
 * PEN-3633 item 3. Managed-checkout refusals in the recent window, per
 * project workspace and per body-derived failure class. The unit of failure is
 * the project checkout and the unit of reporting is the run, so a single broken
 * checkout produced 33 separate run failures and no signal that named the
 * checkout; this collapses that fan-out into one series per project workspace.
 */
export const WORKSPACE_REUSE_REFUSAL_WINDOW_METRIC =
  "paperclip_workspace_reuse_refusal_window_count";
export const WORKSPACE_REUSE_REFUSAL_METRICS_REFRESH_SUCCESS_METRIC =
  "paperclip_workspace_reuse_refusal_metrics_refresh_success";
/**
 * PEN-4188 (PEN-3633 item 5). A project checkout whose actual git origin
 * disagrees with its project workspace's `repo_url`, observed on a timer rather
 * than discovered per-run as a dispatch refusal.
 *
 * Strictly EARLIER than, and strictly narrower than,
 * {@link WORKSPACE_REUSE_REFUSAL_WINDOW_METRIC}. Earlier because it does not
 * wait for a run to be spent: PEN-3628 burned 33 runs over 8.6 h before a
 * manual board sweep found it. Narrower because it can only ever see episode 1
 * of the two measured episodes -- episode 2's checkout had the CORRECT origin
 * and is visible only from the run side. The two are complements, not
 * substitutes; do not retire either for the other.
 */
export const PROJECT_CHECKOUT_ORIGIN_MISMATCH_METRIC =
  "paperclip_project_checkout_origin_mismatch";
/**
 * Checkouts the reconciler actually read an origin from on its last pass.
 *
 * The POSITIVE CONTROL for the gauge above, and not optional: an absent
 * mismatch series means "no checkout disagrees" only if something was
 * compared. A pass that probed nothing -- PVC unmounted, every directory
 * unprovisioned, `git` missing from the image -- produces the identical empty
 * mismatch set, so the alert gates on this being non-zero and a separate alert
 * fires when it reaches zero.
 */
export const PROJECT_CHECKOUT_ORIGIN_RECONCILE_COMPARED_METRIC =
  "paperclip_project_checkout_origin_reconcile_compared";
export const PROJECT_CHECKOUT_ORIGIN_RECONCILE_METRICS_REFRESH_SUCCESS_METRIC =
  "paperclip_project_checkout_origin_reconcile_metrics_refresh_success";
/**
 * Board-approval-queue depth and staleness (BLO-29850). The approval queue is
 * the mandated escalation path for shared-infra changes and had no telemetry at
 * all: it stopped serving for 3.2 days while 39 new cards were filed into it,
 * and the only observable difference between "the board decided everything" and
 * "the board decided nothing" was an API call nobody made.
 *
 * The LAST-DECISION timestamp is the load-bearing one. Depth alone is a staffing
 * opinion -- 88 pending against a healthy service rate is a backlog, 3 pending
 * against a dead one is an outage -- so the alert is a staleness threshold on
 * this series gated on pending > 0, never a threshold on depth.
 */
export const APPROVALS_PENDING_METRIC = "paperclip_approvals_pending";
export const APPROVAL_OLDEST_PENDING_AGE_METRIC = "paperclip_approval_oldest_pending_age_seconds";
export const APPROVAL_LAST_DECISION_TIMESTAMP_METRIC =
  "paperclip_approval_last_decision_timestamp_seconds";
export const APPROVAL_QUEUE_METRICS_REFRESH_SUCCESS_METRIC =
  "paperclip_approval_queue_metrics_refresh_success";
/**
 * Accepted-interaction outcome tracking (PEN-4409).
 *
 * An accepted interaction records that a decision was MADE; nothing recorded
 * whether the action it AUTHORISED happened, so an acceptance that was never
 * acted on was byte-identical to one that was. The measured instance sat
 * `accepted` and silent for 26h45m across 28 unrelated merges while the PR it
 * authorised stayed open with no gate blocking it.
 *
 * The `untracked` series is the one that must never be dropped for being
 * uninteresting: it counts acceptances that declared no outcome at all, and a
 * dashboard which showed only the cards that volunteered a reference would read
 * clean precisely because it excluded the failures it exists to catch.
 */
export const ACCEPTED_INTERACTION_OUTCOME_METRIC = "paperclip_accepted_interaction_outcome_total";
export const ACCEPTED_INTERACTION_OUTCOME_OLDEST_AGE_METRIC =
  "paperclip_accepted_interaction_outcome_oldest_age_seconds";
export const ACCEPTED_INTERACTION_OUTCOME_RECENT_METRIC =
  "paperclip_accepted_interaction_outcome_recent_count";
export const ACCEPTED_INTERACTION_OUTCOME_METRICS_REFRESH_SUCCESS_METRIC =
  "paperclip_accepted_interaction_outcome_metrics_refresh_success";

/**
 * Interaction payload keys this server did not recognise and therefore dropped
 * (PEN-4445).
 *
 * Interaction payload schemas parse leniently — zod strips an unknown key and
 * returns `200` — and that is deliberate: "tool schema ahead of server" is the
 * default state after any interaction schema change, and refusing the create
 * during that window would mean the human-decision card is never filed at all.
 * The create response names the dropped keys back to the caller, but that half
 * only helps a caller that reads the field. This counter is the half that does
 * not depend on anyone's diligence: it makes fleet-wide skew visible here
 * instead of waiting for someone to compare two payloads by hand, which is how
 * the original instance was actually found.
 *
 * Read a non-zero value as EITHER a deploy skew (agents carrying a newer tool
 * schema than this server) OR a misspelled key — the two are indistinguishable
 * from here, and both are worth the same look. `payload_key` is the field name
 * that evaporated, which is what makes the distinction cheap for a human.
 */
export const INTERACTION_PAYLOAD_UNRECOGNIZED_KEY_METRIC =
  "paperclip_interaction_payload_unrecognized_key_total";

/**
 * Shape a dropped key must have to be published as a `payload_key` label
 * value.
 *
 * The label value is chosen by the caller — that is the entire point of the
 * metric — so it crosses a trust boundary, and prom-client never retires a
 * label combination. Anything that is not identifier-shaped is published as
 * {@link UNRECOGNIZED_PAYLOAD_KEY_MALFORMED} rather than verbatim: a real
 * dropped field name is always identifier-shaped (it came from someone's
 * schema), so this costs the signal nothing while keeping control characters,
 * newlines and JSON injected through a key name out of the exposition.
 */
const UNRECOGNIZED_PAYLOAD_KEY_REGEX = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** Published for a dropped key whose name is not identifier-shaped. */
export const UNRECOGNIZED_PAYLOAD_KEY_MALFORMED = "_malformed";

/**
 * Published once the distinct-key budget is spent, so the counter keeps
 * counting while its series count stops growing.
 */
export const UNRECOGNIZED_PAYLOAD_KEY_OVERFLOW = "_overflow";

/**
 * Ceiling on distinct `payload_key` values this process will ever publish.
 *
 * The honest expected cardinality is tiny — a skew window drops the one or two
 * fields a schema change added — so a budget of 50 is far above any legitimate
 * steady state, and reaching it is itself a signal that something is
 * generating key names rather than carrying a newer schema. Degrading to
 * {@link UNRECOGNIZED_PAYLOAD_KEY_OVERFLOW} keeps the `interaction_kind`
 * breakdown and the total intact; only the per-key split is lost, which is the
 * right thing to give up because the total is what an alert thresholds.
 */
const UNRECOGNIZED_PAYLOAD_KEY_BUDGET = 50;
/**
 * How long each currently-held per-agent start lock has been held (PEN-3305).
 *
 * `withAgentStartLock` serializes queued-run dispatch per agent and has no
 * timeout, no TTL and no owner-liveness check — deliberately, because the
 * defect it replaced was a timeout that let a waiter run *alongside* the
 * holder. The cost of that choice is that a section which never settles holds
 * its agent's lock forever, and the agent then stops dispatching while
 * presenting as `status: idle` / `errorReason: null` / `orgChainHealth:
 * healthy`. Nothing exported that condition, so it was unobservable by
 * construction — the same gap, and the same argument, as
 * {@link DB_POOL_CONNECTIONS_METRIC}.
 *
 * Emitted only for agents whose lock is held right now, matching the
 * convention of the per-agent backlog gauges: an absent series means no lock
 * is held, not a zero-length hold. Holds of minutes to a couple of hours are
 * routine and release on their own, so this is NOT near-empty in normal
 * operation and "anything above a few seconds" is not the detector — the
 * detector is `max by (agent_id) (...)` past the 4h abort boundary, which is
 * where `PaperclipAgentStartLockWedged` sits.
 */
export const AGENT_START_LOCK_HELD_SECONDS_METRIC = "paperclip_agent_start_lock_held_seconds";
/**
 * Which await a held start lock is sitting in, and for how long (BLO-36922).
 *
 * Companion to {@link AGENT_START_LOCK_HELD_SECONDS_METRIC}, which says an
 * agent's dispatch has stopped but never which phase stopped it. Four measured
 * fleet stalls (2026-09-21/22/26, 8-14 agents each, peak hold 2293s) were
 * unnameable after the fact precisely because of that gap: container logs
 * rotate in ~1h, paperclip emits no traces, and every downstream instrument
 * went QUIETER during the stalls. A phase label retained at Prometheus
 * resolution is the one surface that survives the window.
 *
 * Deliberately a SEPARATE series, not a `phase` label on the held gauge: a
 * label that changes mid-hold starts a new series, which would destroy the
 * "+scrape_interval per scrape on one continuous series" reading that is the
 * held gauge's whole diagnostic value. Same no-zero-fill semantics as its
 * companion -- series exist only while a lock is held, so absence is health.
 * `phase` is a small closed set of static strings supplied by
 * `markAgentStartLockPhase`; never let an id reach it.
 */
export const AGENT_START_LOCK_PHASE_SECONDS_METRIC = "paperclip_agent_start_lock_phase_seconds";

/**
 * Dispatch sections cancelled for overrunning the start-lock budget (PEN-3328).
 *
 * The companion to {@link AGENT_START_LOCK_HELD_SECONDS_METRIC}, and it exists
 * because that gauge cannot answer this question. A cancelled section releases
 * its lock, so its series *disappears* — the gauge is how you see a wedge while
 * it is happening, and this is how you see that it happened at all. Without it
 * an abort at 03:00 leaves no durable trace anywhere Prometheus can reach.
 *
 * Deliberately unlabelled beyond the agent, and in particular it does NOT carry
 * a "did the cancellation land" label. The two are different shapes: an abort
 * is an event and belongs on a counter, while "still wedged afterwards" is a
 * *condition* and is already exactly what the gauge reports — a series that
 * stays high past the budget instead of vanishing. Splitting the counter would
 * make every recovered abort also increment the alerting series.
 *
 * Any non-zero rate is a defect worth chasing. Not because a healthy section is
 * fast — holds of minutes to a couple of hours are routine and settle on their
 * own (worst measured: 8073s) — but because the abort budget is four hours,
 * set deliberately to clear that settling tail. Reaching it means something
 * inside dispatch stopped responding rather than merely ran slow.
 */
export const AGENT_START_LOCK_ABORTED_METRIC = "paperclip_agent_start_lock_aborted_total";
/**
 * Queued runs cancelled as `duplicate_dispatch_suppressed` (BLO-46812).
 *
 * A start-lock reap that bails, or stale orphan state, leaves a dead run
 * reading `running`, and dispatch then cancels queued same-issue work here.
 * That cancel was invisible: the run ends `cancelled`, not `failed`, so
 * {@link HEARTBEAT_RUN_FAILED_METRIC} can never carry it, and its log line
 * carried no errorCode. Incremented only when the status CAS lands, so it
 * counts DB rows, not dispatch passes.
 *
 * Unlabelled on purpose: prom-client exports an unlabelled counter at 0 from
 * registration, so the first cancel on a pod is a 0->1 transition that
 * `increase()` sees (see seedAgentStartLockAbortedSeries for the trap a
 * labelled counter falls into).
 */
export const HEARTBEAT_DUPLICATE_DISPATCH_SUPPRESSED_METRIC =
  "paperclip_heartbeat_duplicate_dispatch_suppressed_total";
/**
 * How each dispatch pass resolved its start-lock orphan reap (BLO-42010).
 *
 * The bound shipped in BLO-41036 stops the outage by letting a waiter give up
 * at 120 s (`START_LOCK_REAP_WAIT_BOUND_DEFAULT_MS` in heartbeat.ts, overridable
 * via `AGENT_START_LOCK_REAP_WAIT_BOUND_MS`) and dispatch on stale orphan
 * state. That bail is instrumented log-only, which makes the post-fix bail rate
 * uncomputable rather than merely inconvenient to read:
 *
 * - The per-disposition `logger.debug` line is below the deployed log level, so
 *   it emits nothing. Measured 2026-10-10, 6h of production: 0 lines.
 * - The surviving warn/info line is gated on `reapMs >= LOCK_HELD_WARN_MS`, so
 *   it logs only the slow tail. `timed_out` always clears that gate (it waits
 *   the full bound by construction) while `ran`/`joined` clear it only when
 *   slow, so the logged mix is biased toward `timed_out` by the gate itself.
 *
 * So logs carry a complete NUMERATOR for `timed_out` and no DENOMINATOR at all,
 * and the ratio between them -- the thing the bound's health is judged on -- is
 * not recoverable from Loki at any log level currently deployed. Measured over
 * the same 6h, the logged mix reads 1499 `timed_out` / 247 `joined` / 74 `ran`,
 * which is 81% only among slow passes and says nothing about the rate per pass.
 * This counter increments once per pass on every path, which is the whole point:
 * it supplies the denominator the logs structurally cannot.
 *
 * Not pre-seeded, so an absent series means never incremented. Pair any zero
 * reading with a populated sibling disposition before concluding no bails
 * occurred rather than no scrape.
 *
 * Deliberately carries no `agent_id`: this is a fleet-level rate, and the
 * per-agent axis already exists on
 * {@link AGENT_START_LOCK_PHASE_SECONDS_METRIC} under `phase="reap"`.
 */
export const AGENT_START_LOCK_REAP_DISPOSITION_METRIC =
  "paperclip_agent_start_lock_reap_disposition_total";
/**
 * Reap dispositions, as an allow-list so a future branch cannot mint a series.
 *
 * The first five are the literal return union of
 * `reapOrphanedRunsForStartLock`. `error` is not one of its returns: it is the
 * throw path, where the caller's `finally` has a duration but no disposition.
 * Without a label that branch is the one failure mode the counter cannot see,
 * which is the same invisible-failure shape the counter exists to remove.
 *
 * `nested` is worth reading separately rather than folding into `ran`: it is
 * the only disposition that WAITS on a sweep without
 * `awaitStartLockSweepBounded`, so while the bound is enabled it is the only
 * one whose `phase="reap"` hold can exceed it. (`skipped_fresh` also skips the
 * bound, but returns synchronously, so its hold cannot be long.) Disabling the
 * bound (`AGENT_START_LOCK_REAP_WAIT_BOUND_MS=0`) removes that guarantee for
 * every disposition: `ran` and `joined` then wait unbounded too, and
 * `timed_out` is never emitted.
 */
export const KNOWN_START_LOCK_REAP_DISPOSITIONS = [
  "ran",
  "joined",
  "skipped_fresh",
  "nested",
  "timed_out",
  "error",
] as const;
export type StartLockReapDispositionLabel = (typeof KNOWN_START_LOCK_REAP_DISPOSITIONS)[number];

/**
 * Seconds spent in each stage of one fleet-wide `reapOrphanedRuns` sweep
 * (BLO-42010 AC3).
 *
 * A start-lock caller that arrives while a sweep is already reading waits out
 * the rest of it AND the chained sweep after it, so its wait is up to ~2x the
 * sweep. Measured 2026-10-13 06:xxZ: logged `ran` sweeps p50 55.8 s, max
 * 115.4 s, over ~53 running runs. Any sweep past ~60 s therefore pushes chained
 * waiters over the 120 s bound, and that is the `timed_out` rate. The lever is
 * sweep duration, and the sweep had no internal timing. This splits it.
 *
 * No `agent_id`: the sweep is fleet-wide. `stage` is an allow-list.
 */
export const ORPHAN_REAP_STAGE_SECONDS_METRIC = "paperclip_orphan_reap_stage_seconds";
export const KNOWN_ORPHAN_REAP_STAGES = [
  "load_runs",
  "list_jobs",
  "identity_stamp",
  "terminal_job_cleanup",
  "reconcile_reservations",
  // PEN-4380: the three calls `reconcile_reservations` spans, reported
  // separately. They are ADDITIVE, not a replacement -- `reconcile_reservations`
  // still measures the identical span it always did, so series recorded before
  // this split stay comparable and nothing that reads it has to change.
  //
  // The split exists because the aggregate could not answer the question it was
  // reached for. On 2026-10-19 `reconcile_reservations` went from a 0.15s mean
  // to 33s (~221x) in the 16:30-17:00Z bucket, which alone took the fleet sweep
  // past ~60s and so pushed every chained start-lock waiter over the 120s
  // `START_LOCK_REAP_WAIT_BOUND_DEFAULT_MS` -- `ran` 443-679/30m to ~0 and
  // `timed_out` to 155-272/30m. But the stage name points at only the FIRST of
  // the three calls under it, and that call's population
  // (`paperclip_external_runtime_reservations_release_pending`) was 0-2
  // throughout, before AND after. So the label implicated a loop that had
  // nothing to iterate, and the real spender -- one of these three -- was not
  // separable from the metric. Do not re-merge these.
  "reconcile_release_pending",
  // PEN-4380 pass 2: `reconcile_release_pending` is where the split bottomed
  // out, and it was not enough -- it names a function, not a wait. Measured
  // 2026-10-21 on two excursions (211.209 s completing 07:31:58 on
  // `10.244.3.92`; 132.107 s completing 08:06:28 on `10.244.17.123`), FIVE
  // candidate homes for that time were refuted, each against a positive
  // control:
  //
  //   - Slow SQL / a plan cliff. `pg_stat_statements` (unblinded 2026-10-20) is
  //     readable per `queryid`. Across a 12-minute bracket around each
  //     excursion the LARGEST per-call exec time of ANY of the 200 tracked
  //     statements was 13.19 s and 10.94 s. No statement in the database ran
  //     for 211 s, so the stage is not waiting on one. This is also why there
  //     is no index change here: the earlier `environment_leases (status)`
  //     proposal rested on this hypothesis.
  //   - Connection-pool starvation. `paperclip_db_pool_waiting_queries` was 0
  //     at every sample through both excursions, with `active` 0-5 of max 18 --
  //     two consecutive samples read `active=0` WHILE a 132 s stage was open.
  //   - Event-loop blocking / CPU starvation. `nodejs_eventloop_lag_max_seconds`
  //     peaked at 1.223 s and p99 at 0.155 s. The process was scheduling fine.
  //   - A nested re-entrant sweep (reap -> promote -> dispatch -> reap). The
  //     `nested` disposition is EXACTLY 0 for the ten consecutive cliff hours
  //     of 2026-10-19 16:00-10-20 01:00Z, against 6-41/h immediately before.
  //     That path was never taken.
  //   - In-pod kube client saturation (the BLO-36922 signature). Zero
  //     `k8s_concurrency_guard_unreachable` lines in the cliff window, against
  //     a 3,474-line positive control from the same window and stream.
  //
  // What is left is inside the per-row loop, at ~4.5 s/row over a driving set
  // (`paperclip_external_runtime_reservations_active`) of only 5-40 rows. These
  // three separate the loop's two awaits from the query that feeds it, which is
  // the one distinction the refutations above cannot make from outside:
  // `release_pending_select` is the driving SELECT, `release_pending_job_reads`
  // is the per-row `readAgentJobRunStatusByName` kube lookup summed over the
  // pass, and `release_pending_act` is the release/promote/finalize work summed
  // over the rows that were actually acted on.
  //
  // Additive, like the pass-1 split above: the three are recorded only for the
  // sweep's own call, so `reconcile_release_pending` still measures the
  // identical span and its history stays comparable.
  "release_pending_select",
  "release_pending_job_reads",
  "release_pending_act",
  "reconcile_env_leases",
  "refresh_resource_metrics",
  "pod_cleanup",
  "per_run",
  // PEN-4781: the `per_run` lap decomposed into an EXHAUSTIVE partition. Like
  // the two splits above these are ADDITIVE -- `per_run` still measures the
  // identical span, so its history stays comparable -- but unlike them this set
  // is a partition rather than a selection, and that is the point.
  //
  // `per_run` is one lap over ~28 awaits in nested branches across ~700 lines,
  // so every sweep-slow episode resolved to `per_run` and stopped there. It has
  // carried the top stage in episodes of MORE THAN ONE cause: on 2026-10-19
  // phase A, `list_jobs` was flat at x1.04 while `per_run` went x1088 (kube
  // ruled out); on 2026-10-25 `list_jobs` moved x96.6 in lockstep with `per_run`
  // x90.8 while Postgres moved only x5.6 (a kube signature). Same label, two
  // different faults, and no way to tell them apart from the metric.
  //
  // WHY EXHAUSTIVE, AND WHY THE RESIDUAL IS LOAD-BEARING. A 1-of-N split yields
  // a boolean, not a localization: if the instrumented bucket reads flat and the
  // time sits in an un-named remainder, the responder has learned only "not
  // that" and is back to reading source. Worse, a NON-exhaustive partition makes
  // the glue between the buckets invisible, so a responder reads four small
  // numbers and concludes nothing is slow -- a false negative, strictly worse
  // than the honest dead end it replaces. `per_run_other` is therefore not an
  // afterthought bucket: it is what makes
  //   sum(per_run_liveness + _finalize + _dispatch + _cleanup + _other) == per_run
  // true by construction, and it is the bucket to read FIRST when the four named
  // ones are all small.
  //
  // Compare these to `per_run` on the `_sum`, which is exact. The `_count`s also
  // match, because the four are accumulated across the whole pass and emitted
  // once per sweep (as `release_pending_job_reads` already is) rather than once
  // per run -- that is what keeps a p99 comparison between a sub-stage and
  // `per_run` an apples-to-apples one.
  "per_run_liveness",
  "per_run_finalize",
  "per_run_dispatch",
  "per_run_cleanup",
  "per_run_other",
  "total",
] as const;
export type OrphanReapStageLabel = (typeof KNOWN_ORPHAN_REAP_STAGES)[number];
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
/**
 * Retry-scheduling decisions, by outcome and retry reason (BLO-35472).
 *
 * The sibling {@link SCHEDULED_RETRY_PARK_HORIZON_METRIC} is a *max over live
 * retries*, so it cannot see this: mass abandonment removes the long-horizon
 * rows and the gauge goes **down**, which reads identically to the backoff
 * clamp working. `routine_retry_abandoned` in particular creates no retry row
 * at all -- by design, the owning routine's next scheduled fire takes the work
 * -- so there is nothing in `heartbeat_runs` for any row-counting query to
 * find. This counter is the only instrument that sees the decision itself.
 *
 * `outcome` is the return outcome, except that `not_scheduled` is reported as
 * its `errorCode` -- the coarse `not_scheduled` label would collapse "the
 * routine window cannot accept a useful retry" into the same series as "the
 * issue was reassigned", which is the distinction this metric exists to make.
 */
export const RETRY_SCHEDULE_OUTCOME_METRIC = "paperclip_retry_schedule_outcome_total";
/**
 * Retry-scheduling outcomes, as an allow-list so a future branch cannot mint a
 * series. `scheduled` and `retry_exhausted` are returned outcomes; the rest are
 * `not_scheduled` error codes, from `scheduleBoundedRetryForRun`'s own returns
 * and from `evaluateScheduledRetryGate`.
 *
 * `scheduled` is the retry-row creation rate, `routine_retry_abandoned` is the
 * abandon count, and their ratio is the abandon share -- all three of
 * BLO-29052 verifying signal #3 off one counter.
 */
export const KNOWN_RETRY_SCHEDULE_OUTCOMES = [
  "scheduled",
  "retry_exhausted",
  "routine_retry_abandoned",
  "agent_not_invokable",
  "budget_blocked",
  "issue_dependencies_blocked",
  "issue_execution_lock_changed",
  "issue_not_found",
  "issue_not_in_progress",
  "issue_paused",
  "issue_reassigned",
  // BLO-38064: split out of `issue_reassigned`. The agent is not the assignee
  // AND its wake never conferred ownership, so nothing was reassigned — keeping
  // the two under one label is what sent operators looking for a reassignment
  // that had not happened, and is exactly the distinction this metric exists to
  // make.
  "issue_not_assigned_to_agent",
  "issue_review_participant_changed",
  "issue_cancelled",
  "issue_terminal_status",
  "other",
] as const;
export type RetryScheduleOutcomeLabel = (typeof KNOWN_RETRY_SCHEDULE_OUTCOMES)[number];
/**
 * Retry reasons reaching `scheduleBoundedRetryForRun`. Every in-tree caller
 * passes one of these constants, but the service exposes the call publicly
 * (`scheduleBoundedRetry` on the heartbeat service, used by recovery,
 * productivity-review and task-watchdogs), so the reason is coerced here rather
 * than trusted -- an unbounded `retryReason` on a path that runs for every
 * retry of every agent is exactly the cardinality blow-up this metric must not
 * cause. Anything unrecognised lands in `other`, which keeps the counter
 * correct (just less granular) instead of minting a series per typo.
 */
export const KNOWN_RETRY_SCHEDULE_REASONS = [
  "transient_failure",
  "ccrotate_capacity",
  "capacity_blocked",
  "job_failed",
  "dependency_blocked",
  "interaction_continuation_infra_retry",
  "execution_review_participant_recovery",
  "max_turns_continuation",
  "session_unavailable",
  "zero_token_session_reset",
  "issue_continuation_needed",
  "missing_issue_comment",
  "queued_run_detachment_recovery",
  "other",
] as const;
export type RetryScheduleReasonLabel = (typeof KNOWN_RETRY_SCHEDULE_REASONS)[number];
/**
 * Coerce a raw `scheduled_retry_reason` to the allow-list above. Shared by the
 * outcome counter and the park-horizon gauge so the two cannot drift apart:
 * a reason present on one and folded to `other` on the next would make a
 * per-reason alert bound and its rate series disagree about the same park.
 */
export function coerceRetryScheduleReason(reason: string | null | undefined): RetryScheduleReasonLabel {
  return (KNOWN_RETRY_SCHEDULE_REASONS as readonly string[]).includes(reason ?? "")
    ? (reason as RetryScheduleReasonLabel)
    : "other";
}
/**
 * Per-agent zero-floor `reason`, emitted for EVERY known agent, including an
 * agent that also carries live park series. It does not mean "no live park":
 * `{reason="none"}` selects the whole fleet, so counting it yields fleet size,
 * not drained agents. Keeps the BLO-25036 invariant that every known agent
 * always carries a series, without zero-filling the agent x reason cross
 * product. Deliberately outside {@link KNOWN_RETRY_SCHEDULE_REASONS}: it is not
 * a park class, it is always 0, and an alert rule that bounded it would be
 * bounding nothing.
 */
export const NO_SCHEDULED_RETRY_PARK_REASON = "none";
/**
 * Park-horizon-only refinements of `transient_failure` (BLO-31174, Ally C1 on
 * onprem-k8s#4145). The raw column says `transient_failure` for THREE writer
 * paths whose ceilings differ by more than 9x and one of which has no ceiling
 * at all, so a single bound on that label is wrong by construction -- which is
 * the exact defect the per-class bounds were built to remove:
 *
 *  - ladder (neither constant below): `BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS`
 *    final 2h hop plus 25% jitter = **9,000s**. Keeps the bare
 *    `transient_failure` label.
 *  - {@link TRANSIENT_FLOOR_PARK_REASON}: an upstream `retryNotBefore` floor
 *    won. An unclamped floor at or just under the horizon can add up to
 *    `TRANSIENT_RETRY_FLOOR_JITTER_MAX_MS` (300s), while a floor that
 *    `clampTransientRetryHorizon` actually clamps carries no forward jitter;
 *    the maximum is therefore `MAX_TRANSIENT_RETRY_HORIZON_MS` (86,400s) plus
 *    300s = **86,700s**.
 *  - {@link TRANSIENT_QUOTA_FLOOR_PARK_REASON}: a `provider_quota` floor.
 *    `clampTransientHorizon` deliberately excludes this family -- it is a
 *    contractual session/billing boundary carrying an authoritative reset
 *    instant, not a capacity estimate -- so the floor is honoured verbatim and
 *    has **no upper bound**. A multi-day park here is correct behaviour. An
 *    alert rule must EXCLUDE this label rather than invent a bound for it;
 *    bounding it would page on the designed path, which is the defect, not the
 *    fix.
 *
 * Deliberately outside {@link KNOWN_RETRY_SCHEDULE_REASONS}: that list is the
 * vocabulary of the raw column, which never holds either of these, and it is
 * shared with the outcome counter. Refining it there would mint two counter
 * series that can never be written.
 */
export const TRANSIENT_FLOOR_PARK_REASON = "transient_failure_floor";
/** See {@link TRANSIENT_FLOOR_PARK_REASON}. Unbounded by design. */
export const TRANSIENT_QUOTA_FLOOR_PARK_REASON = "transient_failure_quota_floor";
/**
 * Refine a coerced park reason using facts already on the parked row. Only
 * `transient_failure` refines; every other reason passes through untouched, so
 * this is a no-op for 13 of the 14 known reasons.
 *
 * `hasRetryFloor` is floor PRESENCE, not "the floor won" -- recovering the
 * latter would mean recomputing the ladder value the park did not keep. When a
 * present floor loses to the ladder the row is labelled floor anyway and is
 * judged against 86,700s instead of 9,000s. That is a LOOSER bound on a park
 * that is already provably under the tighter one, i.e. weaker monitoring of a
 * known-good case, never a false page.
 */
export function refineScheduledRetryParkReason(input: {
  reason: string | null | undefined;
  hasRetryFloor?: boolean | null;
  isProviderQuotaFamily?: boolean | null;
}): string {
  const reason = coerceRetryScheduleReason(input.reason);
  if (reason !== "transient_failure" || !input.hasRetryFloor) return reason;
  return input.isProviderQuotaFamily ? TRANSIENT_QUOTA_FLOOR_PARK_REASON : TRANSIENT_FLOOR_PARK_REASON;
}
/**
 * postgres.js connection-pool occupancy, by `state` (BLO-33243).
 *
 * There was no pool instrumentation anywhere in this fleet, which made pool
 * saturation unobservable by construction: the 9 h measurement that produced
 * BLO-33243 could establish that two control-plane pods were timing out
 * `/metrics` independently of each other and of their nodes -- the signature
 * of a per-process pool -- but could not confirm the pool was the mechanism,
 * because nothing exported it. Saturation reads as `idle == 0` and
 * `active == max` with {@link DB_POOL_WAITING_QUERIES_METRIC} above 0.
 *
 * `max` is carried as a state rather than a separate gauge so headroom is a
 * plain ratio inside one series, without a second metric to join against.
 */
export const DB_POOL_CONNECTIONS_METRIC = "paperclip_db_pool_connections";
/**
 * Statements holding no connection yet (BLO-33243). This is the saturation
 * signal itself: postgres.js only enqueues a query here once every connection
 * in the pool is busy, so a sustained non-zero value IS pool exhaustion, and a
 * zero value rules it out. Separate from {@link DB_POOL_CONNECTIONS_METRIC}
 * because it counts queries, not connections.
 */
export const DB_POOL_WAITING_QUERIES_METRIC = "paperclip_db_pool_waiting_queries";
/**
 * The timeout environment the application pool inherits from the *server*, in
 * seconds, by `setting` and by the `source` Postgres attributes it to
 * (PEN-3365). `0` means the setting is disabled, matching Postgres' own
 * encoding — so `statement_timeout` reading `0` is the unbounded case, not a
 * missing measurement.
 *
 * ⚠️ INHERITED, NOT EFFECTIVE — and for one of the three settings those differ.
 * `createDb` ships `idle_in_transaction_session_timeout` in the pool's startup
 * packet (`POSTGRES_IDLE_IN_TRANSACTION_TIMEOUT_MS`, #1921), and the
 * probe behind this gauge deliberately reads on a `createUtilitySql`
 * connection that carries none of those overrides — otherwise it would report
 * our own value back to us and destroy the evidence it exists to collect. So
 * `{setting="idle_in_transaction_session_timeout"}` reports what the server
 * imposes (`0` `source="default"` if nothing does), never the pool's own
 * bound. Do NOT read a `0` there as "idle-in-transaction is unbounded". The
 * pool's value is published beside it as
 * `{setting="idle_in_transaction_session_timeout_pool", source="startup_packet"}`,
 * and because the startup packet overrides the server value rather than
 * stacking with it, a pool series above a non-zero inherited one is the
 * PEN-3365 loosening — answerable by query, not only by the startup log
 * line's `LOOSENED:` marker. No number is restated here, so this comment
 * cannot drift from the constant again. `statement_timeout` and
 * `lock_timeout` are not set pool-side, so for those two inherited *is*
 * effective — which is what makes `statement_timeout` here the reading that
 * gates PEN-3365 step 3. The metric is named `_inherited_` rather than
 * `_effective_` precisely because the name is what lands in PromQL, dashboards
 * and alert rules, where this doc comment is not read.
 *
 * This exists because the same reading already shipped as a one-shot startup
 * log line (`Database timeout environment: …`) and that made it *write-only in
 * practice*. Measured 2026-09-26: no `paperclip-api` or worker pod had
 * restarted in over 2 days, the API log runs ~2.2 lines/sec (so the line sits
 * ~390k lines behind the tail), `kubectl logs` is 403 from an agent seat, and
 * the read-only k8s tooling exposes only `tail`. A value nobody can read
 * cannot gate a decision, and PEN-3365 step 3 is explicitly gated on this
 * reading.
 *
 * `source` is a label rather than a second series because it is the half that
 * answers the actual question. The repo asserts a role-level 30 s
 * `statement_timeout` in two places, but no `ALTER ROLE` exists in either
 * `Blockcast/paperclip` or `Blockcast/onprem-k8s`; `source=default` means
 * nothing sets it and the assertion is false, while `database`/`user` means we
 * genuinely inherit a bound. Cardinality is bounded: 3 settings x the small
 * fixed set of `pg_settings.source` values, plus the one pool series.
 *
 * ⚠️ Do NOT substitute `postgres_exporter`'s `pg_settings_statement_timeout_seconds`
 * for this. That series reflects the *exporter's own session* (its labels carry
 * its job name), so it reports whatever short timeout the exporter sets to
 * bound its scrapes — 8 s when this was written — and says nothing about what
 * the application pool inherits.
 *
 * Set once at startup, from the same probe that writes the log line. Absence of
 * the series therefore means the probe did not complete (it is wrapped so it
 * can never block startup), which is distinguishable from any reading.
 */
export const DB_INHERITED_TIMEOUT_METRIC = "paperclip_db_inherited_timeout_seconds";
/**
 * Open file descriptors split by what they point at (PEN-3314). Companion to
 * prom-client's own unlabelled `process_open_fds`, which says the count is
 * rising but not what is rising — see `services/fd-class-metrics.ts` for the
 * measurement that motivated it and for the cardinality bounds.
 */
export const PROCESS_OPEN_FDS_BY_CLASS_METRIC = "paperclip_process_open_fds_by_class";

/**
 * Resident memory broken into the pools V8's own gauges do not report
 * (PEN-3314). Companion to `process_resident_memory_bytes` /
 * `nodejs_heap_size_total_bytes` / `nodejs_external_memory_bytes`, which say the
 * process is growing but not which pool is growing — see
 * `services/native-memory-metrics.ts` for the measurement that motivated it.
 */
export const PROCESS_MEMORY_COMPONENT_BYTES_METRIC = "paperclip_process_memory_component_bytes";

/**
 * V8 context counts (PEN-3314). `detached` is a leak signature whose healthy
 * steady state is 0, which is why it is published at 0 rather than omitted.
 */
export const PROCESS_V8_CONTEXT_COUNT_METRIC = "paperclip_process_v8_context_count";

/**
 * The worker's own cgroup memory charge, decomposed (PEN-3692).
 *
 * A different layer from {@link PROCESS_MEMORY_COMPONENT_BYTES_METRIC}: that one
 * partitions THIS PROCESS's resident footprint, this one reports what the KERNEL
 * charges the whole cgroup — slab, page cache and page tables included, none of
 * which any process-level gauge can see. The 09-25..09-28 excursion this exists
 * for had a JS-heap component of 0.6%. See `services/cgroup-memory-metrics.ts`.
 */
export const CGROUP_MEMORY_COMPONENT_BYTES_METRIC = "paperclip_cgroup_memory_component_bytes";

/** cgroup v2 `memory.current` — the charge the kernel enforces against (PEN-3692). */
export const CGROUP_MEMORY_CURRENT_BYTES_METRIC = "paperclip_cgroup_memory_current_bytes";

/**
 * cgroup v2 `memory.max` — the hard limit (PEN-3692).
 *
 * ABSENT when unlimited, never 0 and never `+Inf`: both render as a usable
 * number in a `current / max` ratio and silently produce a wrong one.
 */
export const CGROUP_MEMORY_MAX_BYTES_METRIC = "paperclip_cgroup_memory_max_bytes";

/**
 * cgroup v2 `memory.peak` — kernel-maintained high-water mark (PEN-3692).
 *
 * The field that survives an excursion every scrape missed, which is the
 * measured 09-28 failure mode: cAdvisor scrapes at 30 s and a 15-min step sees
 * 1 sample in 30. Monotonic within a cgroup's life, so read it as a level, not
 * with rate().
 */
export const CGROUP_MEMORY_PEAK_BYTES_METRIC = "paperclip_cgroup_memory_peak_bytes";

/**
 * Resident memory partitioned by the allocator region it lives in (PEN-3314).
 *
 * Where `PROCESS_MEMORY_COMPONENT_BYTES_METRIC` reports a residual
 * (`rss - heapTotal - external`), this reports an attribution: every mapping
 * lands in exactly one `mapping_class` and the classes sum to the `total`
 * series. See `services/process-mapping-metrics.ts`.
 */
export const PROCESS_MAPPING_RSS_BYTES_METRIC = "paperclip_process_mapping_rss_bytes";

/** VMA counts per `mapping_class` (PEN-3314), beside the bytes. */
export const PROCESS_MAPPING_COUNT_METRIC = "paperclip_process_mapping_count";

/**
 * Size distribution of the `anon_other` mappings (PEN-3314): counts per
 * power-of-two `size_bucket`.
 *
 * Read with {@link PROCESS_MAPPING_SIZE_BUCKET_BYTES_METRIC}; neither is
 * interpretable alone. The help strings carry what the pair discriminates.
 */
export const PROCESS_MAPPING_SIZE_BUCKET_COUNT_METRIC =
  "paperclip_process_mapping_size_bucket_count";

/** Summed VIRTUAL bytes per `size_bucket` (PEN-3314). Virtual, not resident. */
export const PROCESS_MAPPING_SIZE_BUCKET_BYTES_METRIC =
  "paperclip_process_mapping_size_bucket_bytes";

/**
 * Distinct glibc secondary-arena heaps (PEN-3314). The population the
 * 64-CPU/512-arena hypothesis is about, counted rather than argued.
 */
export const PROCESS_GLIBC_SECONDARY_ARENA_HEAP_COUNT_METRIC =
  "paperclip_process_glibc_secondary_arena_heap_count";

/**
 * Duration of the last `/proc/self/smaps` scan (PEN-3314).
 *
 * Published because the scan is a synchronous event-loop block that costs
 * O(resident pages) — ~110 ms at 3 GB — and this row is chasing an event-loop
 * stall. An instrument that can induce the signature must make its own cost
 * attributable rather than anonymous.
 */
export const PROCESS_MAPPING_SCAN_SECONDS_METRIC = "paperclip_process_mapping_scan_seconds";

/**
 * Unix time of the last completed scan (PEN-3314).
 *
 * The mapping series are sampled on a long cadence and republished in between,
 * so they are deliberately staler than the scrape. This makes that staleness
 * computable (`time() - this`) instead of invisible.
 */
export const PROCESS_MAPPING_SCAN_TIMESTAMP_METRIC =
  "paperclip_process_mapping_scan_timestamp_seconds";

/**
 * Liveness of the 1 s heap-peak sampler (PEN-3314).
 *
 * The qualifier for the three `*_peak` components on
 * {@link PROCESS_MEMORY_COMPONENT_BYTES_METRIC}. Those are the only series on
 * this row whose LOW reading decides anything, and they are sampled on the
 * event loop that the leak's step stalls -- so a flat peak has two readings
 * with opposite conclusions, and this series is what separates them.
 *
 * Its own unit is a count, which is why it is not a label value on the
 * `..._bytes` gauge.
 */
export const PROCESS_HEAP_PEAK_SAMPLES_METRIC = "paperclip_process_heap_peak_samples";

/**
 * Count of RSS RELEASE episodes this process has detected (PEN-3314).
 *
 * The counterpart to {@link PROCESS_HEAP_PEAK_SAMPLES_METRIC}'s maxima, and the
 * series that exists because a maximum cannot go down. PEN-3314's open question
 * is what triggers the wholesale return of ~800 MB of single-V8-page mappings,
 * and as of 2026-10-26 NOTHING in Prometheus marks the instant: not GC, not
 * in-flight runs, not dispatch, not node PSI. The finest timestamp available was
 * +/-300 s, floored by the `/proc/self/smaps` scan's own cost.
 *
 * Monotonic within a process; on restart the series goes ABSENT and reappears
 * from 0 rather than stepping down, so read it with `increase()`, never as a
 * level. NOT an alert source.
 */
export const PROCESS_RSS_RELEASE_EVENTS_METRIC = "paperclip_process_rss_release_events";

/**
 * Cumulative peak-to-trough bytes returned across every episode (PEN-3314).
 *
 * Separates a generation that releases often and shallowly from one that
 * releases once and deeply — two shapes with the same event count. Monotonic
 * within a process; read with `increase()`.
 */
export const PROCESS_RSS_RELEASE_BYTES_METRIC = "paperclip_process_rss_release_bytes";

/**
 * Unix time of the START of the most recent drawdown (PEN-3314).
 *
 * ⭐ The headline series: the instant a trigger search aligns against. It is the
 * LAST 1 s sample at which RSS stood at its pre-release high, not the first
 * sample below it and not the first time that high was reached — a plateau can
 * run for hours, and dating the onset from when the climb stopped would point a
 * search at an arbitrary quiet instant.
 *
 * ABSENT until an episode is observed, deliberately. A 0 here is epoch 1970 and
 * would make `time() - this` read as 56 years of staleness — the same hazard
 * {@link PROCESS_MAPPING_SCAN_TIMESTAMP_METRIC} is dropped at construction for.
 */
export const PROCESS_RSS_RELEASE_LAST_ONSET_TIMESTAMP_METRIC =
  "paperclip_process_rss_release_last_onset_timestamp_seconds";

/**
 * Unix time at which that drawdown first crossed the detection threshold
 * (PEN-3314).
 *
 * Read WITH {@link PROCESS_RSS_RELEASE_LAST_ONSET_TIMESTAMP_METRIC}: the gap
 * between them is the time taken to shed a FIXED number of bytes, so it is
 * comparable across episodes and it is what separates the two shapes this row
 * has measured. ~1 s apart is a step that completed inside one scrape; minutes
 * apart is the ~15 minute, 3.3 GB drain. A reader holding only the detection
 * instant cannot tell them apart and would align against the wrong end of a
 * 15 minute window. ABSENT until an episode is observed.
 */
export const PROCESS_RSS_RELEASE_LAST_DETECTED_TIMESTAMP_METRIC =
  "paperclip_process_rss_release_last_detected_timestamp_seconds";

/**
 * Peak-to-trough size of the most recent episode, in bytes (PEN-3314).
 *
 * Grows while a drain is still deepening, so it is the episode's running total
 * rather than its value at detection. ABSENT until an episode is observed.
 */
export const PROCESS_RSS_RELEASE_LAST_BYTES_METRIC = "paperclip_process_rss_release_last_bytes";

/**
 * Liveness of the 1 s RSS sampler (PEN-3314).
 *
 * The qualifier WITHOUT WHICH the event count cannot be read at all: "sampled
 * 40 000 times and saw no drawdown past 64 MiB" and "the sampler never ran" are
 * both a zero event count and opposite conclusions. Same role, and same
 * `rate()`-reads-the-stall property, as {@link PROCESS_HEAP_PEAK_SAMPLES_METRIC}.
 * Never published at 0; absent means the sampler has not ticked.
 */
export const PROCESS_RSS_RELEASE_SAMPLES_METRIC = "paperclip_process_rss_release_samples";

/**
 * The detector's own bounds, in bytes (PEN-3314).
 *
 * `bound="threshold"` is the drawdown depth that opens an episode — what is
 * detectable at all. `bound="plateau_band"` is how far below the high-water
 * mark still counts as "at the plateau" when stamping the onset — what bounds
 * how LATE that stamp can be.
 *
 * Published rather than left to the help strings, for the reason this module
 * publishes `sampleIntervalMs` beside every sampler: a reader who cannot see
 * the bound cannot tell a real null from an undetectable one. It also keeps
 * the figures quoted in the help text above from drifting away from the values
 * actually in force, since both are injectable.
 */
export const PROCESS_RSS_RELEASE_BOUND_BYTES_METRIC = "paperclip_process_rss_release_bound_bytes";

/**
 * `setting` label of the series carrying the pool's OWN idle-in-transaction
 * bound (PEN-3365), published beside the inherited reading so a loosening is a
 * one-series comparison. Named once here so the help text, the startup wiring
 * ({@link dbInheritedTimeoutSeries} in `db-inherited-timeouts.ts`) and the tests
 * cannot drift apart.
 */
export const POOL_IDLE_IN_TRANSACTION_SERIES = "idle_in_transaction_session_timeout_pool";
/** Queue wait observed when a sanctioned GitHub PR-review run starts. */
export const PR_REVIEW_QUEUE_WAIT_METRIC = "paperclip_pr_review_queue_wait_seconds";
/**
 * BLO-31298. Edges past 28800 for the same reason
 * {@link RUN_DISPATCH_WAIT_BUCKETS_SECONDS} has them, found the hard way on
 * this metric: with 28800 (8h) as the top finite edge, every sample in the
 * saturated regime lands in +Inf and histogram_quantile() returns exactly
 * 28800 — the last finite edge — however bad the wait actually is.
 *
 * Measured 2026-10-10T11:44Z, 61h into a continuously-firing
 * PaperclipPrReviewQueueWaitSaturated: `rate(..._bucket[6h])` was 0 for every
 * finite le and 0.0025 at +Inf (100% of samples past 8h), p95 read a flat
 * 28800 for 14h straight, and the uncensored `_sum/_count` mean was 48941s
 * (13.6h) and rising. The alert still fires correctly — the 3600 threshold is
 * far below the censoring point — but it carries no severity gradient above
 * 8h, and the flat p95 panel reads as "stable" while the wait triples.
 */
export const PR_REVIEW_QUEUE_WAIT_BUCKETS_SECONDS = [
  60,
  300,
  600,
  900,
  1800,
  3600,
  7200,
  14400,
  28800,
  43200,
  86400,
  172800,
  259200,
];
/**
 * BLO-25024. Time-to-dispatch for EVERY heartbeat run, not just PR-review ones.
 *
 * The metric above has the same shape but is gated on a `pr_review:` task key,
 * so fleet-wide dispatch latency was measurable only by hand-reading one
 * issue's run list — which is how multi-hour queue waits went unnoticed from
 * 2026-08-10 to 2026-10-04. Observed at the same guarded queued-to-running
 * transition, so the two cannot disagree about when a run started.
 *
 * Buckets deliberately start at 10s: healthy dispatch on this fleet is
 * sub-minute (the week of 2026-08-24 ran a median of ~36s), so buckets that
 * begin at 60s like the PR-review set above cannot distinguish "healthy" from
 * "a minute late" and would make the recovery target unverifiable.
 *
 * `invocation_source` is the only label. It is bounded by
 * HEARTBEAT_INVOCATION_SOURCES (4 values) and normalized against it, because
 * the remedy differs by source: a slow `timer` run costs cadence, a slow
 * `assignment` run costs a human waiting. No agent_id/company_id label — those
 * grow without bound and this is a histogram.
 */
export const RUN_DISPATCH_WAIT_METRIC = "paperclip_run_dispatch_wait_seconds";
/**
 * Local copy of `HEARTBEAT_INVOCATION_SOURCES` from `@paperclip/shared`.
 *
 * Restated here rather than imported because this module deliberately keeps no
 * runtime dependency outside prom-client and the logger (see the type-only
 * import note at the top), and because every other label allow-list in this
 * file — {@link KNOWN_BLOCKED_REASONS}, KNOWN_ISOLATION_MODES — is local for
 * the same reason. The drift this invites is pinned by a test that asserts
 * this array equals the shared constant, so a new invocation source fails CI
 * here instead of silently collapsing into "other" in production.
 *
 * ⚠ NOT {@link KNOWN_INVOCATION_SOURCES}, despite the near-identical name.
 * That list is the *wake-reason* vocabulary (`issue_assigned`,
 * `github_pr_opened`, …); this one is the `heartbeat_runs.invocation_source`
 * COLUMN vocabulary (`timer`, `assignment`, `on_demand`, `automation`). The
 * two sets are disjoint, so normalizing this column through
 * {@link normalizeInvocationSource} would collapse EVERY sample to "other" —
 * a fully-populated histogram with one meaningless label. Do not merge them.
 */
export const RUN_DISPATCH_WAIT_INVOCATION_SOURCES = [
  "timer",
  "assignment",
  "on_demand",
  "automation",
] as const;
/**
 * Day-granular edges past 86400 because the regime this metric was filed for
 * is multi-day: the worst wait measured on BLO-25024 was 28h 19m. With 86400
 * as the top finite edge that sample lands in +Inf, and histogram_quantile()
 * then returns 86400 — the last finite edge — for the p95 exactly while the
 * incident is happening, however bad the wait actually is.
 */
export const RUN_DISPATCH_WAIT_BUCKETS_SECONDS = [
  10,
  30,
  60,
  120,
  300,
  600,
  900,
  1800,
  3600,
  7200,
  14400,
  28800,
  86400,
  172800,
  259200,
];
/**
 * BLO-21460 (2026-08-03 incident follow-up). Unlike the two metrics above
 * (which count every unreleased reservation, healthy in-flight ones
 * included), these two count only the backlog left AFTER each reconciliation
 * pass — reservations still in `release_pending` (or an orphaned prelaunch
 * state) whose Job was confirmed gone/terminal but the row didn't clear, and
 * the oldest such row's age. In steady state both are 0: the periodic
 * reconciler (`reapOrphanedRuns` -> `reconcileReleasePendingExternalRuntimeReservations`,
 * every `heartbeatSchedulerIntervalMs`) and cancellation's own inline release
 * should always be able to clear a confirmed-terminal reservation. A
 * sustained non-zero count means reconciliation itself is failing (e.g. the
 * scheduler is down, as it was during the incident, or the kube API is
 * unreachable) and slots are leaking toward executor capacity exhaustion.
 * Alert threshold: any non-zero value sustained >10 min warrants operator
 * attention; page if oldest age exceeds a few multiples of the scheduler
 * interval.
 */
export const EXTERNAL_RUNTIME_RESERVATIONS_RELEASE_PENDING_METRIC = "paperclip_external_runtime_reservations_release_pending";
export const EXTERNAL_RUNTIME_RESERVATION_RELEASE_PENDING_OLDEST_AGE_METRIC = "paperclip_external_runtime_reservation_release_pending_oldest_age_seconds";
/**
 * BLO-21460. Ephemeral environment leases (`environment_leases.status =
 * 'active'`) whose heartbeat run has already reached a terminal status —
 * i.e. leases cancellation or normal finalization should have released but
 * didn't. Same alerting posture as the release-pending reservation pair
 * above: 0 in steady state, any sustained non-zero count is a leak heading
 * toward environment/executor capacity exhaustion.
 */
export const ENVIRONMENT_LEASES_ORPHANED_ACTIVE_METRIC = "paperclip_environment_leases_orphaned_active";
export const ENVIRONMENT_LEASES_ORPHANED_OLDEST_AGE_METRIC = "paperclip_environment_leases_orphaned_oldest_age_seconds";
/**
 * Freshness companion for the four BLO-21460 backlog gauges above (Ally
 * review on #1304). Same role the sibling `*_refresh_success` gauges play,
 * and load-bearing for the same reason — but the failure mode it covers is
 * specifically the one the alert was written for.
 *
 * `refreshOrphanedRuntimeResourceMetrics` runs *after*
 * `reconcileOrphanedEnvironmentLeases` in `reapOrphanedRuns`, and that sweep
 * calls `confirmStaleKilledJobQuiesced` unguarded. A kube-API failure
 * therefore throws past the refresh, and because `prom-client` gauges retain
 * their last value, all four series hold their previous reading — normally
 * `0`, the *healthy* value. Meanwhile the process is alive, so `up` stays `1`
 * and the scrape target is present: neither the `max(up{...}) == 0` nor the
 * `absent(up{...})` arm of PaperclipRuntimeResourceReconciliationStuck
 * compensates. The alert would stay silent during exactly the kube-API
 * outage its own description tells the operator to check for.
 *
 * One gauge for all four series rather than one each: unlike the
 * queued-run/overdue-retry pair, these four are refreshed by a single
 * function in one pass, so there is no partial-failure mode for a per-gauge
 * signal to distinguish — either the pass completed or none of them updated.
 */
export const ORPHANED_RUNTIME_RESOURCE_METRICS_REFRESH_SUCCESS_METRIC =
  "paperclip_orphaned_runtime_resource_metrics_refresh_success";
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
 * - `coalesced` (BLO-31961): a `queued` delivery that merged into an existing
 *   pending run for the same PR instead of creating one. A sub-count of
 *   `queued`, outside the invariant below. A PR with repeated coalesces and no
 *   review is the signature of an absorbing run that never dispatches.
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
 * bounded at `7 * (KNOWN_GITHUB_WAKE_REASONS.length + 1)` — independent of
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
  // BLO-31961: a `queued` delivery that merged into an existing pending run
  // instead of creating one. Counted in addition to `queued`, not instead.
  "coalesced",
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
 * Refusals GitHub returned to the control plane's own API calls (PEN-3852),
 * split by WHY it refused.
 *
 * This exists because "the installation ran out of budget" and "this App may
 * not read that" are the same HTTP status, and PEN-3776 measured the first one
 * happening: an ordinary agent seat's `gh` reads came back
 * `403 API rate limit exceeded for installation ID 138085375` while eight
 * monitoring exporters swept the same shared installation. PEN-3852's
 * acceptance test is that the INTERACTIVE installation never reaches that
 * state, and nothing in this process could answer that question — the shared
 * GitHub fetch wrapper in `github-fetch.ts` had no rate-limit awareness of any
 * kind.
 *
 * The identifier itself is deliberately not spelled here. `github-writer-
 * derivation.ts` puts EVERY file naming that symbol into the suspected-writer
 * set, comments included, and then demands the outbound scrub of anything it
 * cannot prove read-only. This module issues no GitHub request at all;
 * naming the function would add a false positive to a fail-closed security
 * guard purely through prose.
 *
 * Why a refusal counter rather than a `remaining` gauge: the budget probe on
 * PEN-3852 measured `/rate_limit` reporting one counter while GitHub enforces
 * several (a `/actions/workflows` call and a `/contents` call draw on different
 * ones, resets 1,905s apart — reproduced twice, 15 days apart, at different
 * ceilings). Tooling was also observed reporting "rate limit exceeded" in the
 * same minute `/rate_limit` read 8,582/9,450 remaining. A remaining gauge can
 * therefore read healthy through a real refusal; a refusal cannot be refused
 * and also not happen. Count the thing the outage IS.
 *
 * `rate_limited` is the one PEN-3852's done-when keys on — primary installation
 * budget exhaustion. `secondary_limit` is a different GitHub mechanism (abuse
 * detection, independent of the hourly budget) and is counted separately rather
 * than folded in, because the remedy differs: the first needs capacity or
 * isolation, the second needs the caller to slow down. `forbidden` is the
 * contrast class and the reason this metric is worth more than a bare 403
 * count — a permission problem must never be read as budget exhaustion, which
 * is exactly the merge `docs/runbooks/github-app-credential-ownership.md`
 * warns against.
 *
 * Cardinality: `reason` is closed at the three members of
 * {@link KNOWN_GITHUB_API_REFUSAL_REASONS}. Nothing caller-supplied reaches the
 * label — the classifier maps every response onto that set or onto no refusal
 * at all. No URL, repo or installation id is labelled here; they stay on the
 * structured log line, per the guardrail
 * {@link GITHUB_REVIEW_REQUEST_DELIVERY_METRIC} documents.
 */
export const GITHUB_API_REFUSALS_METRIC = "paperclip_github_api_refusals_total";

/**
 * Every GitHub API call this process attempted — the denominator for
 * {@link GITHUB_API_REFUSALS_METRIC}, and its liveness signal.
 *
 * NOT optional, and not a nicety. A refusal counter reading zero has two
 * readings that render identically — "GitHub refused nothing" and "this
 * instrument is dead, or this build does not carry it" — and PEN-3852's
 * acceptance test is a claim of the first kind. The denominator is what tells
 * them apart: zero refusals over a window in which the denominator climbed is
 * evidence, zero refusals over a flat denominator is an unproven instrument.
 * This is the same drop-counter/denominator pairing the Alloy log counters in
 * `Blockcast/onprem-k8s` enforce via `scripts/check-alloy-log-counters.py`.
 *
 * Counted per ATTEMPT, immediately before the request leaves — not per
 * response. A call that never resolves is still an attempt: a DNS failure, a
 * refused connection, or the 30s `GITHUB_FETCH_DEADLINE_MS` abort in
 * `github-fetch.ts`. A denominator that only advanced on success would freeze
 * during exactly the network-level outage an operator is trying to read it
 * through.
 *
 * SCOPE, stated so nobody over-reads it: this counts every call through the
 * shared GitHub fetch wrapper, including calls to a GitHub Enterprise host, and
 * it is not labelled by host or installation. It is a liveness and volume signal for THIS process's
 * GitHub egress, not a per-installation budget ledger. The per-installation
 * question is answered by the exporter on the installation itself.
 */
export const GITHUB_API_REQUESTS_METRIC = "paperclip_github_api_requests_total";

/**
 * Why GitHub refused. Closed set — see {@link GITHUB_API_REFUSALS_METRIC}.
 *
 * Deliberately NOT a catch-all `other`: every 403/429 lands on exactly one of
 * these three, because `forbidden` already IS the residual (a refusal that is
 * not either quota mechanism). A fourth `unknown` child would only ever mean
 * "the classifier changed and this list did not", which a test pins instead.
 */
export const KNOWN_GITHUB_API_REFUSAL_REASONS = [
  "rate_limited",
  "secondary_limit",
  "forbidden",
] as const;

export type GithubApiRefusalReason = (typeof KNOWN_GITHUB_API_REFUSAL_REASONS)[number];

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
 * Runtime presence of the worker-crash recovery candidate index (BLO-21526).
 * 1 while `heartbeat_runs_crash_recovery_pending_idx` is present, valid and
 * ready; 0 while it is absent or invalid, which is exactly when the periodic
 * crash reconciliation gates itself off (`skippedReason:
 * "candidate_index_missing"`) and the recovery path stops running.
 *
 * This exists because migration 0226 records complete on a populated database
 * WITHOUT building its deferred `CREATE INDEX CONCURRENTLY`, and the only
 * signal it left behind was a `RAISE NOTICE` the production client swallows
 * (`onnotice: () => {}`). Every other channel that could have surfaced the gap
 * is also silent-on-healthy: the deploy guard logs only when it *changes*
 * something, and the probe's own `logger.warn` is latched to the absent
 * transition. A gauge is the first signal that says "present" out loud, and
 * the only one that survives -- `paperclip-0`'s log buffer retains ~4 minutes
 * on a pod that has been up for hours, so a once-at-startup log line is
 * unreadable by the time anyone asks.
 *
 * Re-derived from `pg_class`/`pg_index` on every periodic scheduler tick, so a
 * pod restart republishes current state and an index dropped underneath a
 * running process is picked up within a tick rather than latching forever.
 *
 * Deliberately CLEARED (series goes absent) rather than set to 0 when the
 * catalog probe itself fails: "we could not tell" is not "the index is gone",
 * and leaving a stale 1 behind would reproduce the exact silent-healthy
 * failure this metric exists to end. Alert on `== 0` for a real absence and
 * `absent()` for an unobservable one.
 *
 * Labeled by the index name even though only one index is ever published, for
 * the same reason {@link PLUGIN_STATUS_COLLECTOR_LAST_SUCCESS_METRIC} carries
 * a constant `role` label: prom-client auto-publishes a bare (zero-label)
 * Gauge at 0 the moment it is constructed, and `ensureRegistry` runs on every
 * tier including the API tier, which never runs this probe. A bare Gauge would
 * therefore publish a frozen `0` -- "the index is missing" -- on every API pod
 * forever, and production scrapes both Services, so an `== 0` rule would page
 * permanently regardless of the truth. A labeled Gauge renders no series until
 * something calls `.set()`, so it appears only on the tier that can actually
 * observe the catalog, and `.reset()` genuinely removes the series instead of
 * zeroing it.
 */
export const CRASH_RECOVERY_CANDIDATE_INDEX_PRESENT_METRIC =
  "paperclip_crash_recovery_candidate_index_present";

/** The single index {@link CRASH_RECOVERY_CANDIDATE_INDEX_PRESENT_METRIC} tracks. */
export const CRASH_RECOVERY_CANDIDATE_INDEX_NAME = "heartbeat_runs_crash_recovery_pending_idx";

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
 *
 * `aggregate_key` was added for BLO-32163, and the bound is argued rather than
 * assumed: it is `alert-aggregate:v1:["<alertname>",<dedupe-domain>]` (see the
 * alertmanager plugin's `aggregateKeyForAlert`), so its cardinality is
 * `alertname × dedupe-domain`. `alertname` is already accepted above as bounded
 * by the alert-rule registry, and `dedupe-domain` is a rule-author opt-in label
 * that is null on every rule that does not set it. So this sits in the same
 * order as a key the list already admits, and is bounded by the rule registry —
 * not by alert *instances*, which is the axis that would actually be unbounded.
 *
 * It is load-bearing that `aggregate_key` be a label and not merely present in
 * the metric name: a wedged-fence page has to name the wedged aggregate to be
 * actionable, and `alertname` alone cannot do it — two aggregates of the same
 * rule differing only by dedupe-domain are distinct fences that wedge
 * independently.
 *
 * `phase` (the fence lifecycle column: `active`/`firing`/`cancelling`/
 * `finalizing`) was in the first cut of this change and is deliberately NOT
 * here. It is trivially bounded on its own, but it multiplies the fence
 * metrics' combination count 4× inside their own
 * {@link PLUGIN_METRIC_CARDINALITY_BUDGET} allowance — ~23 live aggregate keys
 * × 4 phases exceeds the 50-slot per-name budget, so admitting it would
 * reintroduce, within one metric, exactly the starvation the per-name ledger
 * fixes. The responder-facing value it carried is supplied in prose by the
 * alert annotation instead.
 */
export const PLUGIN_METRIC_PROMOTABLE_TAG_KEYS = [
  "action",
  "aggregate_key",
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
 * Namespace every promoted tag lands in, so a plugin-supplied tag key can never
 * collide with a label Prometheus itself assigns.
 *
 * This is not cosmetic. An alerting rule OVERWRITES `alertname` with the rule's
 * own name and then applies its `labels:` block (conventionally including
 * `severity`) before checking for duplicate label sets. Both keys were in the
 * allow-list above, so without this prefix:
 *
 *   - `alertname` HARD-FAILS rule evaluation. Two series differing only in
 *     `alertname` become identical once the rule name overwrites it, and the
 *     rule dies with "vector contains metrics with the same labelset after
 *     applying alert labels". Measured on 2026-09-02 with promtool against
 *     onprem-k8s#3022, by adding `alertname` to that rule's by-clause.
 *   - `severity` collides SILENTLY: the rule's own severity overwrites the
 *     plugin's, so the alert routes on a value neither side chose. No error.
 *
 * The bare form fails on the most obvious rule anyone would write against this
 * metric -- `paperclip_plugin_metric_total{metric="..."} > 0`, unaggregated,
 * which is exactly the shape PEN-2799 exists to make possible. The rule in
 * onprem-k8s#3022 only escapes it by aggregating the labels away.
 *
 * Prefixing closes the whole class rather than these two members: `job` and
 * `instance` are the same hazard from the scrape side (with the default
 * `honor_labels: false` they are silently renamed to `exported_*`), and any key
 * added to the allow-list later inherits the immunity instead of re-opening the
 * hole. Nothing in Prometheus reserves a `tag_` prefix.
 *
 * The PLUGIN-FACING contract is unprefixed: a manifest declares `alertname` and
 * `ctx.metrics.write` is called with `{ alertname }`. Only the published label
 * is namespaced, so this costs plugin authors nothing.
 */
export const PLUGIN_METRIC_TAG_LABEL_PREFIX = "tag_";

/** The published label name for a promotable tag key. */
export const pluginMetricTagLabel = (key: string): string =>
  PLUGIN_METRIC_TAG_LABEL_PREFIX + key;

/**
 * A plugin metric name must look like a metric name. Rejecting a mis-shaped
 * name is cheaper than carrying it as a label value forever, because
 * prom-client never retires a label combination.
 */
export const PLUGIN_METRIC_NAME_REGEX = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/;
export const PLUGIN_METRIC_NAME_MAX_LENGTH = 64;

/**
 * Control characters stripped from a promoted label value before it is either
 * published or keyed.
 *
 * Two distinct reasons, and each alone justifies it:
 *
 *  1. **Exposition.** prom-client escapes only `\`, `\n` and `"`
 *     (`registry.js` `escapeLabelValue`). Every other control character —
 *     NUL, CR, ESC — is written into `/metrics` as a raw byte and becomes the
 *     scraper's problem. Promoted values are plugin-supplied and, for
 *     `alertname`/`severity`, verbatim inbound webhook input, so this is
 *     reachable rather than theoretical.
 *  2. **Ledger identity.** {@link pluginMetricCombinations} keys on these
 *     values. Stripping NUL here is what lets that key be discussed at all
 *     without appealing to a Prometheus rule nothing in this path enforces.
 *
 * The whole C0 range plus DEL goes, `\n` and `\t` included: none of them
 * belong in a label value, and one rule is easier to state than an exception
 * list. Global flag is for `.replace`; do not call `.test()` on it — that is
 * stateful via `lastIndex`.
 */
export const PLUGIN_METRIC_CONTROL_CHAR_REGEX = /[\u0000-\u001F\u007F]/g;

/**
 * Ceiling on the length of a *promoted tag value*, applying the same reasoning
 * as {@link PLUGIN_METRIC_NAME_MAX_LENGTH} to the other axis — and the one that
 * actually crosses a trust boundary. The metric name is plugin source; a
 * promoted value is not. `alertname` is `alert.labels.alertname` taken verbatim
 * from the inbound Alertmanager webhook, so its length is chosen by whoever
 * authored the firing rule, not by us.
 *
 * The *count* of retained values is bounded by
 * {@link PLUGIN_METRIC_NAME_BUDGET} × {@link PLUGIN_METRIC_CARDINALITY_BUDGET}
 * — each name carries its own combination pool (BLO-32163), so the two budgets
 * multiply rather than the second bounding the whole plugin. That product is
 * still finite, so an unbounded length is bloat rather than a breach:
 * prom-client never retires a label combination, so each one is re-serialised
 * on every scrape for the process lifetime. Truncating is strictly better than
 * dropping — a truncated `alertname` still identifies the alert to a human
 * reading the series, where a dropped label loses the breakdown entirely.
 *
 * 128 is comfortably above the longest alertname firing fleet-wide when this
 * was written (59 chars, `PhysicalInfra...NearConfiguredMax`) while keeping the
 * worst case bounded at roughly
 * `NAME_BUDGET x CARDINALITY_BUDGET x promotable-keys x 128` bytes per plugin,
 * i.e. ~3.8 MB at 50 x 50 x 12 x 128. That is 50x the pre-BLO-32163 figure,
 * which assumed one combination pool shared across all of a plugin's names.
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
 * **(plugin, metric name)** pair may occupy, per process lifetime — not a
 * per-plugin pool; see the BLO-32163 paragraph below for why that distinction
 * is load-bearing. Past it, a write **keeps its `metric` label and drops its
 * promoted labels**, so it still lands on the plugin's real per-name series.
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
 * This budget is per **(plugin, metric name)**, not per plugin, and that is
 * load-bearing rather than a refinement (BLO-32163). A single shared pool is
 * first-come-first-served over a *restart* lottery, so a chatty metric
 * permanently starves a rare one — and the rare one is exactly the metric a
 * page depends on. Measured in production 2026-09-17 on
 * `paperclip-plugin-alertmanager`: 110 distinct series against a shared budget
 * of 100, with `alertmanager.aggregate.fence_blocked` — the wedged-fence
 * signal — dropping 91 writes/hr to `label_budget` while
 * `alertmanager.alert.error` (185/hr) and `alertmanager.firing.deduped`
 * (101/hr) held the slots. Adding a key to
 * {@link PLUGIN_METRIC_PROMOTABLE_TAG_KEYS} cannot fix that: a full ledger
 * rejects every new combination regardless of which keys compose it. Giving
 * each name its own allowance is what makes a promotion actually reach the
 * series, so the two changes ship together.
 *
 * Halved from 100 to keep the inflation proportionate: worst case per plugin
 * is {@link PLUGIN_METRIC_NAME_BUDGET} name-level series + that many × this
 * many combinations + one `_overflow`, i.e. 2551 rather than the previous 151.
 * 50 is ~2× the largest per-name combination count any live metric has reached
 * (24, on `alertmanager.alert.error`), and the chatty metrics already lose
 * combinations under the shared pool, so no live breakdown regresses.
 */
export const PLUGIN_METRIC_CARDINALITY_BUDGET = 50;

/**
 * Per-name raises of {@link PLUGIN_METRIC_CARDINALITY_BUDGET}, for metrics a
 * page reads per-tag (BLO-32163 AC2). `PaperclipAlertmanagerAggregateFenceWedged`
 * fires on mean hold age per `aggregate_key`; once the 50-slot ledger fills, a
 * new key's writes land on the label-less series and average into the whole
 * pool, so a real wedge reads as ~660s against an 1800s threshold and never
 * pages. Measured 2026-10-13..14: 303 fence writes shed to `label_budget` in
 * 7d, one worker at exactly 50 combinations. Still bounded: worst case adds
 * 2 x (500 - 50) series per worker lifetime.
 */
export const PLUGIN_METRIC_CARDINALITY_BUDGET_OVERRIDES: ReadonlyMap<string, number> = new Map([
  ["alertmanager.aggregate.fence_blocked", 500],
  ["alertmanager.aggregate.fence_blocked_age_seconds", 500],
]);

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
 *
 * When you add a code here you must also add a row for it to the Step 2
 * action table in `runbooks/agent-wakeup-terminal-failed.md`. Listing a code
 * here removes it from the table's `other` escape hatch, so an operator paged
 * on it would otherwise see a label with no row and no fallback.
 *
 * BLO-35668: that drift used to be silent. It is now asserted set-for-set by
 * `terminal-failed-wake-runbook-parity.test.ts`, so a code added here without a
 * runbook row (or a row with no code) fails CI instead of surfacing as a paged
 * label with no instruction.
 */
export const KNOWN_TERMINAL_FAILED_WAKE_ERROR_CODES = [
  "external_lifecycle_stale_killed",
  "job_failed",
  // BLO-33441: listed for the same reason it is listed in recovery's
  // infra-routing set — these runs WERE `job_failed` (a member) before the
  // relabel, so omitting it would silently move them to `other` and change
  // this gauge's meaning without anything upstream having changed.
  CAVEMAN_PROXY_NOT_READY_ERROR_CODE,
  "job_missing",
  "adapter_failed",
  // BLO-35668: `skill_materialization_pending` (BLO-32055 / #1669) is the
  // RENAME of the `adapter_failed` directly above, at the one claude-k8s emit
  // site that names a skill-source fault — so like `caveman_proxy_not_ready`
  // these runs WERE a member before the relabel, and omitting it moved them to
  // `other` with nothing upstream having changed. That is the gauge's own
  // triage instruction (`other` means "triage it into this list") firing on a
  // code that already had a home; it is a label-set correction only, and
  // nothing was suppressed by its absence because the
  // `PaperclipPrReviewWakeTerminallyFailed` alert keys on
  // `…_oldest_age_seconds`, not on `error_code`.
  "skill_materialization_pending",
  "process_lost",
  "agent_not_found",
  // BLO-49060: the reviewer pod never started (e.g. stuck PodInitializing past
  // its budget on a node whose container runtime stalled). Infra fault below
  // the agent, same disposition as `adapter_failed` / `process_lost`.
  "k8s_pod_schedule_failed",
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

/**
 * Bounded label normalization for {@link HTTP_REQUESTS_METRIC} (PEN-3702).
 *
 * Cardinality is the only real risk an app-wide request counter carries, so
 * every label here is bounded, and the one that could in principle grow is
 * bounded by an enforced cap rather than by an argument that it cannot.
 *
 * Measured baseline before shipping this: a 365-second slice of production
 * `paperclip-api` logs (2026-10-02T08:50:12Z-08:56:17Z, 5000 lines, 4611
 * parsed request lines) carried **35 distinct (method, route) pairs and 36
 * distinct (method, route, status) triples**. That is a lower bound — the
 * access log silences successful requests on the hottest API paths, so those
 * routes are invisible to it — but it sizes the counter at dozens of series,
 * against a fleet baseline of 2416 `paperclip_*` series.
 */
export const KNOWN_HTTP_METHODS = [
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
] as const;
export type KnownHttpMethod = (typeof KNOWN_HTTP_METHODS)[number];

const knownHttpMethodSet: ReadonlySet<string> = new Set(KNOWN_HTTP_METHODS);

/** Label value for a request that matched no route (404s, and anything that
 * unwound before Express bound `req.route`). Collapsing these to one series is
 * what keeps an arbitrary-URL scan from minting unbounded labels. */
export const HTTP_ROUTE_UNMATCHED = "<unmatched>";
/** Label value for a route seen after {@link HTTP_ROUTE_LABEL_CAP} distinct
 * routes have already been recorded. Routes come from a finite set of declared
 * Express templates, so this should never fire; it exists so that a future
 * dynamically-registered route cannot turn this counter into a cardinality
 * incident, and a non-zero value here is the signal that one tried. */
export const HTTP_ROUTE_OVERFLOW = "<overflow>";
/** Hard ceiling on distinct `route` label values. Sized well above the ~300
 * declared GET templates so it is inert in normal operation. */
export const HTTP_ROUTE_LABEL_CAP = 512;
/** Defensive ceiling on a single route label's length. */
const HTTP_ROUTE_MAX_LENGTH = 200;

const seenHttpRouteLabels = new Set<string>();

export function normalizeHttpMethod(method: string | null | undefined): string {
  const upper = typeof method === "string" ? method.toUpperCase() : "";
  return knownHttpMethodSet.has(upper) ? upper : "OTHER";
}

/**
 * Normalize a status code to a 3-digit label. Anything outside the valid HTTP
 * range -- including a response that was destroyed before a status was set --
 * lands on `"0"` rather than minting a series from a bogus value.
 */
export function normalizeHttpStatus(status: number | null | undefined): string {
  return typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599
    ? String(status)
    : "0";
}

/**
 * Normalize a route label, enforcing the cardinality cap.
 *
 * The input is expected to be an Express route *template*
 * (`/api/companies/:companyId/approvals`), never a concrete URL -- templates
 * are what make this bounded, since `/issues/:id` stays one label no matter
 * how many ids are requested.
 */
export function normalizeHttpRoute(route: string | null | undefined): string {
  const trimmed = typeof route === "string" ? route.trim() : "";
  if (!trimmed) return HTTP_ROUTE_UNMATCHED;
  const bounded =
    trimmed.length > HTTP_ROUTE_MAX_LENGTH ? trimmed.slice(0, HTTP_ROUTE_MAX_LENGTH) : trimmed;
  if (seenHttpRouteLabels.has(bounded)) return bounded;
  if (seenHttpRouteLabels.size >= HTTP_ROUTE_LABEL_CAP) return HTTP_ROUTE_OVERFLOW;
  seenHttpRouteLabels.add(bounded);
  return bounded;
}

/**
 * One increment per inbound GitHub webhook delivery, whatever the event and
 * whatever the outcome (BLO-39378). This is the *delivery* counter, not a
 * consumer-side one: it is incremented by the receiver itself, so its
 * flatlining is the fault rather than a symptom of one.
 *
 * It exists because {@link GITHUB_WORKFLOW_RUN_CONCLUSION_METRIC} cannot see
 * the failure shape where the api is healthy but GitHub stops delivering —
 * secret rotated, hook disabled, endpoint 404ing, GitHub-side incident. That
 * counter has no denominator for deliveries that *should* have arrived, so a
 * dead webhook and a genuinely quiet CI window emit a byte-identical flat
 * series and no threshold on it can separate them. `absent()` is the wrong
 * instrument there too: the series is present (zero-initialised on every
 * replica), it just stops moving. Across *all* event types the fleet pushes
 * continuously, so "zero deliveries of any kind in N minutes" is actionable
 * where "zero workflow_run completions" is not.
 *
 * `outcome="rejected_signature"` is deliberately a first-class value rather
 * than folded into `error`: a rotated-or-mismatched secret is one of the
 * named shape-B causes, and it presents as healthy delivery *volume* with
 * nothing accepted — invisible to a count that only measures arrival.
 *
 * Cardinality ceiling: KNOWN_GITHUB_WEBHOOK_EVENTS (8) plus the separate
 * UNKNOWN_GITHUB_WEBHOOK_EVENT `other` bucket = 9 event values, x
 * KNOWN_GITHUB_WEBHOOK_OUTCOMES (3) = 27 series per
 * replica, fixed at compile time. No repo, PR number, sender or SHA label —
 * and `event` is normalized against the allowlist precisely because it
 * originates in the attacker-controlled `x-github-event` header on a request
 * that is counted *before* its signature is verified.
 */
export const GITHUB_WEBHOOK_DELIVERY_METRIC = "paperclip_github_webhook_delivery_total";

// Every event this receiver branches on today, plus `ping` — which GitHub
// sends on hook (re)creation and is the one delivery that is literal proof
// the hook is alive. Unrecognized values collapse into `other`; growing this
// list is a deliberate act, which is the point.
export const KNOWN_GITHUB_WEBHOOK_EVENTS = [
  "check_run",
  "check_suite",
  "dependabot_alert",
  "issue_comment",
  "ping",
  "pull_request",
  "pull_request_review",
  "workflow_run",
] as const;

export const UNKNOWN_GITHUB_WEBHOOK_EVENT = "other";

export const KNOWN_GITHUB_WEBHOOK_OUTCOMES = [
  "accepted",
  "rejected_signature",
  "error",
] as const;

export type GithubWebhookDeliveryOutcome = (typeof KNOWN_GITHUB_WEBHOOK_OUTCOMES)[number];

const knownGithubWebhookEventSet: ReadonlySet<string> = new Set(KNOWN_GITHUB_WEBHOOK_EVENTS);

export function normalizeGithubWebhookEvent(event: string | null | undefined): string {
  return typeof event === "string" && knownGithubWebhookEventSet.has(event)
    ? event
    : UNKNOWN_GITHUB_WEBHOOK_EVENT;
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

/**
 * How a webhook delivery rejected at the readiness guard looked to the sender
 * (BLO-28803). These must stay separate in the exposition: `retryable` means
 * the sender will bring the payload back, `terminal` means it will not and the
 * data is being discarded deliberately. Summing them would hide exactly the
 * distinction an incident reconstruction needs.
 */
export const KNOWN_WEBHOOK_REJECTION_RESPONSE_CLASSES = ["retryable", "terminal"] as const;
export type WebhookRejectionResponseClass =
  (typeof KNOWN_WEBHOOK_REJECTION_RESPONSE_CLASSES)[number];

/**
 * Hard ceiling on distinct `plugin_key` label values admitted by
 * {@link PLUGIN_WEBHOOK_DELIVERY_REJECTED_METRIC}.
 *
 * The resolved-row rule already bounds this by the plugins table, which is
 * operator-controlled — an unknown plugin never reaches the guard. This cap is
 * the second line: it holds the series count flat even if a future change lets
 * an unresolved identifier through, so a public unauthenticated route can
 * never turn into unbounded registry growth. Comfortably above any realistic
 * install count (the fleet runs well under 20).
 */
export const MAX_TRACKED_WEBHOOK_REJECTION_PLUGIN_KEYS = 64;
/** Label value standing in for keys beyond the cap, and for a missing key. */
export const OVERFLOW_WEBHOOK_REJECTION_PLUGIN_KEY = "other";

const trackedWebhookRejectionPluginKeys = new Set<string>();

/** Keep reject-path logs useful without making sender volume a log-volume DoS. */
const WEBHOOK_REJECTION_LOG_INTERVAL_MS = 60_000;
type WebhookRejectionLogState = {
  lastLoggedAt: number;
  suppressed: number;
  latest: {
    pluginId: string;
    endpointKey: string;
    pluginStatus: string;
    httpStatus: number;
  };
};
const webhookRejectionLogState = new Map<string, WebhookRejectionLogState>();

/**
 * Admit `pluginKey` as a label value, or collapse it to
 * {@link OVERFLOW_WEBHOOK_REJECTION_PLUGIN_KEY}. First-come-first-served up to
 * the cap: real installs are few and long-lived, so they claim their slots on
 * first rejection and keep them for the life of the process.
 */
export function boundWebhookRejectionPluginKey(pluginKey: string | null | undefined): string {
  const key = typeof pluginKey === "string" ? pluginKey.trim() : "";
  if (key.length === 0) return OVERFLOW_WEBHOOK_REJECTION_PLUGIN_KEY;
  if (trackedWebhookRejectionPluginKeys.has(key)) return key;
  if (trackedWebhookRejectionPluginKeys.size >= MAX_TRACKED_WEBHOOK_REJECTION_PLUGIN_KEYS) {
    return OVERFLOW_WEBHOOK_REJECTION_PLUGIN_KEY;
  }
  trackedWebhookRejectionPluginKeys.add(key);
  return key;
}

function logPluginWebhookDeliveryRejection(input: {
  pluginKey: string;
  pluginId: string;
  endpointKey: string;
  pluginStatus: string;
  responseClass: WebhookRejectionResponseClass;
  httpStatus: number;
}): void {
  const key = `${input.pluginKey}:${input.responseClass}`;
  const now = Date.now();
  const previous = webhookRejectionLogState.get(key);
  const latest = {
    pluginId: input.pluginId,
    endpointKey: input.endpointKey,
    pluginStatus: input.pluginStatus,
    httpStatus: input.httpStatus,
  };

  if (previous && now - previous.lastLoggedAt < WEBHOOK_REJECTION_LOG_INTERVAL_MS) {
    previous.suppressed += 1;
    previous.latest = latest;
    return;
  }

  if (previous?.suppressed) {
    logger.warn(
      {
        pluginKey: input.pluginKey,
        responseClass: input.responseClass,
        suppressedCount: previous.suppressed,
        ...previous.latest,
      },
      "plugin webhook rejection log summary",
    );
  }

  webhookRejectionLogState.set(key, { lastLoggedAt: now, suppressed: 0, latest });
  logger.warn(
    {
      pluginKey: input.pluginKey,
      pluginId: input.pluginId,
      endpointKey: input.endpointKey,
      pluginStatus: input.pluginStatus,
      responseClass: input.responseClass,
      httpStatus: input.httpStatus,
    },
    input.responseClass === "retryable"
      ? "plugin webhook delivery deferred: plugin is not ready, sender told to retry"
      : "plugin webhook delivery dropped: plugin is gone, sender told not to retry",
  );
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

/**
 * Routing/attribution identity carried beside the bounded `agent_id` on the
 * queued-run age gauges (PEN-4280).
 *
 * Both fields are FUNCTIONALLY DETERMINED by `agent_id` -- an agent has exactly
 * one name and one owning company -- so adding them multiplies the series count
 * by nothing. That is what makes this safe here while `company_id` is
 * deliberately omitted from metrics keyed on something coarser, where it is
 * genuinely unbounded per tenant.
 *
 * They are load-bearing downstream rather than decorative. onprem-k8s'
 * `HeartbeatRunQueueAgentOldestQueuedHigh` is pinned to a per-tenant
 * Alertmanager route on `company_id` (BLO-31172) and renders
 * `{{ $labels.agent_name }}` in its summary; its own design note 4 records that
 * route being absent for 34 days, during which every Penstock page was filed
 * against Blockcast on-call. Any consumer repointed onto these gauges without
 * these labels re-opens exactly that, silently.
 *
 * Sourced from the `agents` row, NOT from `heartbeat_runs.company_id`: the
 * zero-floor series (an agent with nothing queued) has no run to read a company
 * from, and `agents.company_id` is also what the onprem exporter's own
 * `company_id` label resolves to, so the two agree by construction.
 */
export interface QueuedRunAgentIdentity {
  agentName: string;
  companyId: string;
}

/** Shared shape of both queued-run age gauges. */
type QueuedRunAgeGauge = Gauge<"agent_id" | "agent_name" | "company_id">;

/**
 * Label set for an `agent_id` that is not in the bounded roster. Mirrors the
 * onprem exporter's `coalesce(a.name, 'unknown')` / `coalesce(a.company_id,
 * 'unknown')` so the same agent reads identically on both collection paths.
 */
const UNKNOWN_QUEUED_RUN_AGENT_IDENTITY: QueuedRunAgentIdentity = {
  agentName: UNKNOWN_AGENT_ID,
  companyId: UNKNOWN_AGENT_ID,
};

const knownReasonSet: ReadonlySet<string> = new Set(KNOWN_BLOCKED_REASONS);

/**
 * Bounded `reason` allow-list for {@link AGENT_DISPATCH_DECLINED_METRIC}.
 *
 * One entry per decline site in `startNextQueuedRunForAgent`, in the order
 * dispatch reaches them. Keep them in that order and keep the set closed —
 * adding a decline path without adding its reason here silently collapses it to
 * {@link UNKNOWN_DISPATCH_DECLINE_REASON}, which reintroduces exactly the blind
 * spot this metric was added to close.
 *
 * "Decline site" is not quite "`return []` site", in both directions, and the
 * gaps are deliberate:
 *
 *   - `emergency_continuation_scheduled` returns the (empty) `claimedRuns`
 *     accumulator rather than a `[]` literal. That shape is why the source
 *     scanner in `dispatch-decline-instrumentation.test.ts` checks returns of
 *     the accumulator as well as of the literal: keying only on `return [];`
 *     left this exact path dark.
 *   - The `onCoalesced` hook passed to `withAgentStartLock` returns `[]` from
 *     three sites in `agent-start-lock.ts` (re-entrant coalesce, depth guard,
 *     deadlock guard) and is INTENTIONALLY not a decline. A coalesced call runs
 *     no queue-selection pass of its own; the pass it folded into claims the
 *     work, so "no runs claimed by this call" is the honest answer rather than
 *     a refusal. Do not add a reason for it — recording one would double-count
 *     a single pass and label a successful dispatch as declined.
 *
 * The first FOUR collapse to {@link UNKNOWN_AGENT_ID}, not the first three.
 * `dispatch_stopped`, `api_tier_fence` and `scheduling_suppressed` do so
 * because they are process-wide: they fire identically for every agent in the
 * instance, so they pass `companyId: null` and the roster read is skipped.
 *
 * `agent_missing` collapses for a different and more permanent reason, and it
 * is NOT fixable by passing a company id. The bound is membership of the
 * `agents` table: `getActiveAgentIds` selects the ids present for a company,
 * and `agent_missing` is emitted precisely when `SELECT * FROM agents WHERE
 * id = ?` returned no row. A row that does not exist cannot be in any
 * company's set, so {@link normalizeAgentId} would return
 * {@link UNKNOWN_AGENT_ID} for it whatever company were supplied. It is
 * structurally unscopeable; do not "fix" it by threading a company id through.
 *
 * Operator consequence: filtering `agent_id!="unknown"` to get per-agent facts
 * drops `agent_missing` entirely — and that is the one reason where *which*
 * agent vanished is the whole datum. Read that reason from the logs, which
 * carry the id.
 */
export const KNOWN_DISPATCH_DECLINE_REASONS = [
  /** Dispatch disabled for this process (`skipQueuedRunDispatch` / `dispatchStopped`). */
  "dispatch_stopped",
  /** BLO-9089 fence: the api tier never claims runs; the workers tier owns them. */
  "api_tier_fence",
  /** Worktree/db-restore scheduling suppression is active process-wide. */
  "scheduling_suppressed",
  /** The agent row vanished between the queue read and the dispatch pass. */
  "agent_missing",
  /** Paused, terminated, pending approval, or an invalid reporting chain. */
  "agent_not_invokable",
  /** An untracked k8s Job or Pod still holds the agent (BLO-12990 gate). */
  "untracked_external_job",
  /** No free slot. Paired with {@link CONCURRENT_RUN_BLOCKED_METRIC}. */
  "no_available_slots",
  /**
   * Retired by BLO-42411 (the dispatcher now applies the bump instead of
   * draining slots). Kept so historical series still normalize.
   */
  "pending_image_bump",
  /**
   * A bounded critical-lane pass is still walking; lower lanes wait.
   * Split from the recovery lane deliberately: a seat starved by a walking
   * critical pass and one starved by the recovery lane are different faults,
   * and collapsing them would put the "which lane holds this seat" question
   * back behind a log join — the exact cost this metric exists to remove.
   */
  "critical_lane_continuation",
  /** As above, for the recovery-action lane. */
  "recovery_lane_continuation",
  /** The queue was scanned and held no candidate row at all. */
  "no_queued_candidates",
  /**
   * A candidate refused to claim and the pass escalated: it scheduled an
   * emergency continuation for a run that is still `queued`, then broke out of
   * the candidate loop.
   *
   * Split from `no_claimable_run` rather than folded into it because the two
   * are different faults. "Refused, and something is still trying" and
   * "refused, with nothing left to try" want different operator responses, and
   * this one is the stronger distress signal of the pair — it is the case the
   * pass itself judged bad enough to escalate. Collapsing them would hide that
   * behind the louder, more common reason.
   */
  "emergency_continuation_scheduled",
  /** Candidates existed and every one of them refused to claim. */
  "no_claimable_run",
] as const;

export const UNKNOWN_DISPATCH_DECLINE_REASON = "other";

const knownDispatchDeclineReasonSet: ReadonlySet<string> = new Set(
  KNOWN_DISPATCH_DECLINE_REASONS,
);

export type DispatchDeclineReason = (typeof KNOWN_DISPATCH_DECLINE_REASONS)[number];

export function normalizeDispatchDeclineReason(reason: string | null | undefined): string {
  return typeof reason === "string" && knownDispatchDeclineReasonSet.has(reason)
    ? reason
    : UNKNOWN_DISPATCH_DECLINE_REASON;
}

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

/**
 * Bounded bucket set for the free-text `agents.errorReason` (BLO-22498).
 *
 * WHY A BUCKET AND NOT THE RAW STRING
 * -----------------------------------
 * `errorReason` is not a repo-defined enum: for this condition it is verbatim
 * text from the opencode CLI, arriving via the session-recovery path in
 * `packages/adapters/opencode-local/src/server/execute.ts` and landing in the
 * column as `finalizeAgentStatus`'s `failureReason`. Putting that on a label
 * would mint a new series per distinct upstream phrasing — the exact
 * cardinality failure BLO-28616 catalogued (343 alert rows / 334 distinct
 * pods). So it is collapsed to this fixed set, same idiom as
 * {@link KNOWN_TERMINAL_FAILED_WAKE_ERROR_CODES}.
 *
 * `other` vs `none` are kept distinct deliberately: `other` means "in error
 * for a reason we have not triaged into a bucket", `none` means "in error
 * with no reason recorded at all". Conflating them would hide which is
 * growing.
 */
export const AGENT_ERROR_REASON_SESSION_UNAVAILABLE = "session_unavailable";
export const AGENT_ERROR_REASON_OTHER = "other";
export const AGENT_ERROR_REASON_NONE = "none";

export const KNOWN_AGENT_ERROR_REASON_BUCKETS = [
  AGENT_ERROR_REASON_SESSION_UNAVAILABLE,
  AGENT_ERROR_REASON_OTHER,
  AGENT_ERROR_REASON_NONE,
] as const;

export type AgentErrorReasonBucket = (typeof KNOWN_AGENT_ERROR_REASON_BUCKETS)[number];

/**
 * Collapse a raw `agents.errorReason` into a {@link
 * KNOWN_AGENT_ERROR_REASON_BUCKETS} member.
 *
 * The `session_unavailable` match is a case-insensitive SUBSTRING test, not
 * equality. That is deliberate and load-bearing: the upstream text is not
 * ours, and observed forms wrap the phrase in surrounding context rather than
 * being exactly `"Session unavailable"`. An equality check would read as
 * working — the series would exist and sit at a plausible 0 — while silently
 * classifying every real occurrence as `other`. That failure is invisible on
 * a dashboard, which is why the test pins a wrapped form and not just the
 * bare phrase.
 */
export function classifyAgentErrorReason(
  errorReason: string | null | undefined,
): AgentErrorReasonBucket {
  if (typeof errorReason !== "string") return AGENT_ERROR_REASON_NONE;
  const trimmed = errorReason.trim();
  if (trimmed.length === 0) return AGENT_ERROR_REASON_NONE;
  return trimmed.toLowerCase().includes("session unavailable")
    ? AGENT_ERROR_REASON_SESSION_UNAVAILABLE
    : AGENT_ERROR_REASON_OTHER;
}

/**
 * Count of agents currently in `status = 'error'`, bucketed by
 * {@link classifyAgentErrorReason} (BLO-22498).
 *
 * This is the reason-resolved companion to
 * {@link AGENT_ERROR_DURATION_SECONDS_METRIC}, which carries only `agent_id`
 * and therefore cannot answer "are we in the BLO-18012 condition, or is some
 * unrelated agent merely errored". BLO-22498's acceptance criteria require
 * that distinction explicitly, so a generic error count cannot satisfy the
 * panel.
 *
 * Every bucket is published on every pass, including empty ones, so an
 * idle-healthy fleet reads an explicit `0` rather than dropping the series.
 * A missing series and a healthy one look identical on a Grafana panel and on
 * most `absent()`-less alert expressions — the zero-fill is what makes
 * "recovered" distinguishable from "exporter broke".
 */
export const AGENT_ERROR_REASON_AGENTS_METRIC = "paperclip_agent_status_error_agents";

/**
 * Seconds the OLDEST agent in each {@link classifyAgentErrorReason} bucket has
 * continuously held `status = 'error'`, 0 when the bucket is empty
 * (BLO-22498).
 *
 * Max-within-bucket rather than a per-agent series so BLO-18012's bound
 * ("time-to-recovery <= 2 min") is a direct single-series comparison instead
 * of a `max()` the panel has to reconstruct. Inherits the `updatedAt`-as-
 * proxy caveat documented on {@link AGENT_ERROR_DURATION_SECONDS_METRIC}: an
 * unrelated write to a still-errored row understates the age, never
 * overstates it, so this is a lower bound on true time-in-error.
 */
export const AGENT_ERROR_REASON_OLDEST_AGE_METRIC =
  "paperclip_agent_status_error_oldest_age_seconds";

let registry: Registry | null = null;
let concurrentRunBlocked: Counter<"agent_id" | "reason" | "isolation_mode"> | null = null;
let agentDispatchDeclined: Counter<"agent_id" | "reason"> | null = null;
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
let retryScheduleOutcome: Counter<"outcome" | "retry_reason"> | null = null;
let startLockReapDisposition: Counter<"disposition"> | null = null;
let orphanReapStageSeconds: Histogram<"stage"> | null = null;
let penstockGateProbe: Counter<"path" | "outcome" | "provider" | "model"> | null = null;
let penstockGateProbeDuration: Histogram<"path" | "provider"> | null = null;
/**
 * `path|provider|model` tuples whose full outcome allow-list has already been
 * materialised at zero (PEN-4675). Keeps the seeding to one pass per tuple
 * instead of six redundant `inc(..., 0)` calls on every probe.
 */
const penstockGateProbeSeededTuples = new Set<string>();
let heartbeatTimerSchedulerExclusion: Counter<"reason"> | null = null;
let modelProfileUnapplied: Counter<"adapter" | "requested" | "reason"> | null = null;
let heartbeatPostTerminalRunEventDropped: Counter<"status"> | null = null;
let heartbeatTimerChecked: Counter | null = null;
let heartbeatTimerEnqueued: Counter | null = null;
let agentZeroTokenCompletedRunStreak: Gauge<"agent_id" | "adapter"> | null = null;
let externalRuntimeReservationEvents: Counter<"event"> | null = null;
let externalRuntimeReservationsActive: Gauge | null = null;
let externalRuntimeReservationOldestAge: Gauge | null = null;
let queuedRunAgeMetricsRefreshSuccess: Gauge | null = null;
let deferredIssueExecutionWakeOldestAge: Gauge<"agent_id"> | null = null;
let deferredIssueExecutionWakeAgeMetricsRefreshSuccess: Gauge | null = null;
let coldInReviewIssueOldestAge: Gauge<"agent_id"> | null = null;
let coldInReviewIssueMetricsRefreshSuccess: Gauge | null = null;
let externalRuntimeReservationsReleasePending: Gauge | null = null;
let externalRuntimeReservationReleasePendingOldestAge: Gauge | null = null;
let environmentLeasesOrphanedActive: Gauge | null = null;
let environmentLeasesOrphanedOldestAge: Gauge | null = null;
let orphanedRuntimeResourceMetricsRefreshSuccess: Gauge | null = null;
let externalRuntimeReservationStrandedOldestAge: Gauge<"agent_id"> | null = null;
let externalRuntimeReservationStrandMetricsRefreshSuccess: Gauge | null = null;
let workspaceReuseRefusalWindow: Gauge<"project_workspace_id" | "failure_class"> | null = null;
let workspaceReuseRefusalMetricsRefreshSuccess: Gauge | null = null;
let projectCheckoutOriginMismatch:
  | Gauge<"project_workspace_id" | "company_id" | "project_id">
  | null = null;
let projectCheckoutOriginReconcileCompared: Gauge | null = null;
let projectCheckoutOriginReconcileMetricsRefreshSuccess: Gauge | null = null;
let approvalsPending: Gauge<"type" | "company_id" | "requester"> | null = null;
let approvalOldestPendingAge: Gauge<"type" | "company_id" | "requester"> | null = null;
let approvalLastDecisionTimestamp: Gauge<"company_id" | "requester"> | null = null;
let approvalQueueMetricsRefreshSuccess: Gauge | null = null;
let acceptedInteractionOutcome: Gauge<"bucket"> | null = null;
let acceptedInteractionOutcomeOldestAge: Gauge<"bucket" | "company_id"> | null = null;
let acceptedInteractionOutcomeRecent: Gauge<"bucket"> | null = null;
let acceptedInteractionOutcomeMetricsRefreshSuccess: Gauge | null = null;
let interactionPayloadUnrecognizedKey: Counter<"interaction_kind" | "payload_key"> | null = null;
let agentStartLockHeldSeconds: Gauge<"agent_id"> | null = null;
let agentStartLockPhaseSeconds: Gauge<"agent_id" | "phase"> | null = null;
let agentStartLockAbortedTotal: Counter<"agent_id"> | null = null;
let duplicateDispatchSuppressedTotal: Counter | null = null;
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
let githubApiRefusals: Counter<"reason"> | null = null;
let githubApiRequests: Counter | null = null;
let agentWakeupTerminalFailedUnresolved: Gauge<"error_code" | "scope"> | null = null;
let agentWakeupTerminalFailedOldestAge: Gauge<"scope"> | null = null;
let githubWorkflowRunConclusion: Counter<"conclusion" | "supersession"> | null = null;
let githubWebhookDelivery: Counter<"event" | "outcome"> | null = null;
let queuedRunOldestAge: QueuedRunAgeGauge | null = null;
let queuedRunOldestClaimableAge: QueuedRunAgeGauge | null = null;
let routineLastDoneFireAge: Gauge<"routine_id"> | null = null;
let routineLastFireStartAge: Gauge<"routine_id"> | null = null;
let routineFireInterval: Gauge<"routine_id"> | null = null;
let routineFireGapMetricsRefreshSuccess: Gauge | null = null;
let overdueScheduledRetryOldestAge: Gauge<"agent_id"> | null = null;
let overdueScheduledRetryAgeMetricsRefreshSuccess: Gauge | null = null;
let scheduledRetryParkHorizon: Gauge<"agent_id"> | null = null;
let scheduledRetryParkHorizonRefreshSuccess: Gauge | null = null;
let dbPoolConnections: Gauge<"pool" | "state"> | null = null;
let dbPoolWaitingQueries: Gauge<"pool"> | null = null;
let dbInheritedTimeout: Gauge<"setting" | "source"> | null = null;
let processOpenFdsByClass: Gauge<"fd_class"> | null = null;
let processMemoryComponentBytes: Gauge<"component"> | null = null;
let processV8ContextCount: Gauge<"kind"> | null = null;
let processMappingRssBytes: Gauge<"mapping_class"> | null = null;
let processMappingCount: Gauge<"mapping_class"> | null = null;
let processMappingSizeBucketCount: Gauge<"size_bucket"> | null = null;
let processMappingSizeBucketBytes: Gauge<"size_bucket"> | null = null;
let processGlibcSecondaryArenaHeapCount: Gauge | null = null;
let processMappingScanSeconds: Gauge | null = null;
let processMappingScanTimestamp: Gauge | null = null;
let processHeapPeakSamples: Gauge | null = null;
let processRssReleaseEvents: Gauge | null = null;
let processRssReleaseBytes: Gauge | null = null;
let processRssReleaseLastOnsetTimestamp: Gauge | null = null;
let processRssReleaseLastDetectedTimestamp: Gauge | null = null;
let processRssReleaseLastBytes: Gauge | null = null;
let processRssReleaseSamples: Gauge | null = null;
let processRssReleaseBoundBytes: Gauge<"bound"> | null = null;
let cgroupMemoryComponentBytes: Gauge<"component"> | null = null;
let cgroupMemoryCurrentBytes: Gauge | null = null;
let cgroupMemoryMaxBytes: Gauge | null = null;
let cgroupMemoryPeakBytes: Gauge | null = null;
let pluginError: Gauge<"plugin_id" | "plugin_key"> | null = null;
let crashRecoveryCandidateIndexPresent: Gauge<"index"> | null = null;
let pluginMetric: Counter<
  "plugin_id" | "plugin_key" | "metric" | PluginMetricPromotableTagKey
> | null = null;
let pluginMetricDropped: Counter<"plugin_id" | "plugin_key" | "reason" | "metric"> | null = null;

/**
 * Per-plugin ledger of `(metric, promoted-label-values)` combinations already
 * published, enforcing {@link PLUGIN_METRIC_CARDINALITY_BUDGET}.
 *
 * Keys are NUL-joined, matching this file's existing composite-key idiom. That
 * is not cosmetic: if two different combinations can render to the same key,
 * the second write reads as already-seen — so it consumes no budget slot and
 * still publishes. Every such collision buys a free series and the bound
 * leaks.
 *
 * A join is injective only while its separator cannot occur inside a part,
 * and that is NOT a free property of a Prometheus label value: promoted
 * values include `alertname` and `severity`, which are verbatim inbound
 * Alertmanager webhook labels, and a NUL survives `JSON.parse` intact. Six
 * NULs inside `alertname` straddle the run of empty slots between promotable
 * indices 1 and 7 and collide with a NUL inside `severity`.
 *
 * So the premise is enforced rather than assumed: promoted values are
 * stripped of control characters at the promote site
 * (see {@link PLUGIN_METRIC_CONTROL_CHAR_REGEX}), and the metric name cleared
 * {@link PLUGIN_METRIC_NAME_REGEX}. A structurally injective key
 * (`JSON.stringify`, a length-prefixed join) was measured at ~1.8x the cost
 * of the join on this per-write path and, with the strip in place, no test
 * can distinguish it — so the strip is the guard, and
 * `never emits a raw control character into the exposition` is what fails if
 * it is ever removed.
 *
 * Entries are keyed by `pluginId\0name` (BLO-32163 — see
 * {@link PLUGIN_METRIC_CARDINALITY_BUDGET} for why the ledger is per-name
 * rather than per-plugin) and are never pruned in production — only
 * {@link __resetMetricsForTest} clears them — so a plugin uninstalled or
 * disabled mid-process keeps its ledger for the worker's lifetime. That is
 * deliberate, not an oversight. The residue is bounded by the same two budgets
 * this ledger exists to enforce (at most 50 names × 50 combinations per
 * plugin), and on the *default* uninstall path pruning
 * would hand a reinstall a fresh budget — turning install/uninstall into a way
 * to mint unbounded series, which is exactly what the bound refuses.
 *
 * That default is a soft delete: the row survives as `uninstalled` and a
 * reinstall reuses it, so `pluginId` — and with it the ledger key prefix — is
 * stable across the cycle. `uninstall(id, removeData = true)` instead
 * hard-deletes the
 * row, so the reinstall inserts under a fresh `defaultRandom()` id and gets a
 * clean budget whether or not we prune; there the retained entry is an orphan
 * rather than a hole this closes. The rule is kept unconditional because the
 * exploitable path is the default one. A worker restart is the reclaim path.
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
let runDispatchWait: Histogram | null = null;
let authRequest: Counter<"operation" | "outcome"> | null = null;
let httpRequests: Counter<"route" | "method" | "status"> | null = null;
let httpEmptyListResponses: Counter<"route" | "method" | "status"> | null = null;
let gbrainRecallTotal: Counter<"status"> | null = null;
let agentHeartbeatAge: Gauge<"agent_id"> | null = null;
let agentHeartbeatInterval: Gauge<"agent_id"> | null = null;
let agentErrorDuration: Gauge<"agent_id"> | null = null;
let agentErrorReasonAgents: Gauge<"error_reason"> | null = null;
let agentErrorReasonOldestAge: Gauge<"error_reason"> | null = null;
let projectPrimaryWorkspaceFallback: Counter | null = null;
let backstopDeferredCandidates: Gauge<"source"> | null = null;
let backstopSweepCompleted: Counter<"source"> | null = null;
let backstopCandidatesSkipped: Counter<"source" | "reason"> | null = null;
let wakeRedeliverySuppressed: Counter<"cause"> | null = null;
let heartbeatRecoveryChainSkipped: Counter | null = null;
let heartbeatRecoveryChainDuration: Gauge | null = null;
let heartbeatRecoveryChainInflight: Gauge | null = null;
let heartbeatRecoveryChainStalled: Counter | null = null;
let schedulerLeaseHeld: Gauge<"lease" | "holder"> | null = null;
let schedulerLeaseRenewed: Gauge<"lease" | "holder"> | null = null;
let pluginWebhookDeliveryRejected:
  | Counter<"plugin_key" | "response_class" | "plugin_status">
  | null = null;
let recoveryHorizonExpired: Counter<"delivery"> | null = null;
let recoveryActionAutoDischarged: Counter<"kind"> | null = null;
let workerTierProxyFailures: Counter<"reason"> | null = null;
let isolationReaperScanned: Counter<"dry_run"> | null = null;
let isolationReaperDeleted: Counter<"dry_run"> | null = null;
let isolationReaperSkippedLayout: Counter<"dry_run"> | null = null;
let isolationReaperRetainedResurrected: Counter<"dry_run"> | null = null;
let isolationReaperEntries: Counter<"dry_run" | "outcome"> | null = null;
let isolationReaperSweeps: Counter<"dry_run" | "stop_reason"> | null = null;
let isolationReaperLastSweep: Gauge<"dry_run"> | null = null;
let executionWorkspaceTeardown: Counter<"trigger" | "method" | "outcome" | "cleanup_reason"> | null = null;
let executionWorkspaceTeardownDuration: Histogram<"trigger" | "method" | "cleanup_reason"> | null = null;
let executionWorkspaceCollectorScanned: Counter<string> | null = null;
let executionWorkspaceCollectorCandidates: Counter<"outcome"> | null = null;
let executionWorkspaceCollectorStamped: Counter<string> | null = null;
let executionWorkspaceCollectorPasses: Counter<"stop_reason"> | null = null;
let executionWorkspaceCollectorLastPass: Gauge<string> | null = null;

function ensureRegistry(): {
  registry: Registry;
  counter: Counter<"agent_id" | "reason" | "isolation_mode">;
  dispatchDeclinedCounter: Counter<"agent_id" | "reason">;
  isolatedStartedCounter: Counter<"agent_id" | "isolation_mode">;
  failedCounter: Counter<HeartbeatRunFailedLabel>;
  capacityDeferredCounter: Counter<"adapter" | "provider">;
  retryScheduleOutcomeCounter: Counter<"outcome" | "retry_reason">;
  startLockReapDispositionCounter: Counter<"disposition">;
  orphanReapStageSecondsHistogram: Histogram<"stage">;
  penstockGateProbeCounter: Counter<"path" | "outcome" | "provider" | "model">;
  penstockGateProbeDurationHistogram: Histogram<"path" | "provider">;
  heartbeatTimerSchedulerExclusionCounter: Counter<"reason">;
  modelProfileUnappliedCounter: Counter<"adapter" | "requested" | "reason">;
  heartbeatPostTerminalRunEventDroppedCounter: Counter<"status">;
  heartbeatTimerCheckedCounter: Counter;
  heartbeatTimerEnqueuedCounter: Counter;
  zeroTokenCompletedRunStreakGauge: Gauge<"agent_id" | "adapter">;
  externalRuntimeReservationEventsCounter: Counter<"event">;
  externalRuntimeReservationsActiveGauge: Gauge;
  externalRuntimeReservationOldestAgeGauge: Gauge;
  externalRuntimeReservationsReleasePendingGauge: Gauge;
  externalRuntimeReservationReleasePendingOldestAgeGauge: Gauge;
  environmentLeasesOrphanedActiveGauge: Gauge;
  environmentLeasesOrphanedOldestAgeGauge: Gauge;
  orphanedRuntimeResourceMetricsRefreshSuccessGauge: Gauge;
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
  githubApiRefusalsCounter: Counter<"reason">;
  githubApiRequestsCounter: Counter;
  agentWakeupTerminalFailedUnresolvedGauge: Gauge<"error_code" | "scope">;
  agentWakeupTerminalFailedOldestAgeGauge: Gauge<"scope">;
  githubWorkflowRunConclusionCounter: Counter<"conclusion" | "supersession">;
  githubWebhookDeliveryCounter: Counter<"event" | "outcome">;
  queuedRunOldestAgeGauge: QueuedRunAgeGauge;
  queuedRunOldestClaimableAgeGauge: QueuedRunAgeGauge;
  routineLastDoneFireAgeGauge: Gauge<"routine_id">;
  routineLastFireStartAgeGauge: Gauge<"routine_id">;
  routineFireIntervalGauge: Gauge<"routine_id">;
  routineFireGapMetricsRefreshSuccessGauge: Gauge;
  queuedRunAgeMetricsRefreshSuccessGauge: Gauge;
  deferredIssueExecutionWakeOldestAgeGauge: Gauge<"agent_id">;
  deferredIssueExecutionWakeAgeMetricsRefreshSuccessGauge: Gauge;
  coldInReviewIssueOldestAgeGauge: Gauge<"agent_id">;
  coldInReviewIssueMetricsRefreshSuccessGauge: Gauge;
  overdueScheduledRetryOldestAgeGauge: Gauge<"agent_id">;
  overdueScheduledRetryAgeMetricsRefreshSuccessGauge: Gauge;
  scheduledRetryParkHorizonGauge: Gauge<"agent_id" | "reason">;
  scheduledRetryParkHorizonRefreshSuccessGauge: Gauge;
  dbPoolConnectionsGauge: Gauge<"pool" | "state">;
  dbPoolWaitingQueriesGauge: Gauge<"pool">;
  dbInheritedTimeoutGauge: Gauge<"setting" | "source">;
  processOpenFdsByClassGauge: Gauge<"fd_class">;
  processMemoryComponentBytesGauge: Gauge<"component">;
  processV8ContextCountGauge: Gauge<"kind">;
  processMappingRssBytesGauge: Gauge<"mapping_class">;
  processMappingCountGauge: Gauge<"mapping_class">;
  processMappingSizeBucketCountGauge: Gauge<"size_bucket">;
  processMappingSizeBucketBytesGauge: Gauge<"size_bucket">;
  processGlibcSecondaryArenaHeapCountGauge: Gauge;
  processMappingScanSecondsGauge: Gauge;
  processMappingScanTimestampGauge: Gauge;
  processHeapPeakSamplesGauge: Gauge;
  processRssReleaseEventsGauge: Gauge;
  processRssReleaseBytesGauge: Gauge;
  processRssReleaseLastOnsetTimestampGauge: Gauge;
  processRssReleaseLastDetectedTimestampGauge: Gauge;
  processRssReleaseLastBytesGauge: Gauge;
  processRssReleaseSamplesGauge: Gauge;
  processRssReleaseBoundBytesGauge: Gauge<"bound">;
  cgroupMemoryComponentBytesGauge: Gauge<"component">;
  cgroupMemoryCurrentBytesGauge: Gauge;
  cgroupMemoryMaxBytesGauge: Gauge;
  cgroupMemoryPeakBytesGauge: Gauge;
  pluginErrorGauge: Gauge<"plugin_id" | "plugin_key">;
  crashRecoveryCandidateIndexPresentGauge: Gauge<"index">;
  pluginMetricCounter: Counter<
    "plugin_id" | "plugin_key" | "metric" | PluginMetricPromotableTagKey
  >;
  pluginMetricDroppedCounter: Counter<"plugin_id" | "plugin_key" | "reason" | "metric">;
  pluginStatusCollectorLastSuccessGauge: Gauge<"role">;
  externalRuntimeReservationStrandedOldestAgeGauge: Gauge<"agent_id">;
  externalRuntimeReservationStrandMetricsRefreshSuccessGauge: Gauge;
  workspaceReuseRefusalWindowGauge: Gauge<"project_workspace_id" | "failure_class">;
  workspaceReuseRefusalMetricsRefreshSuccessGauge: Gauge;
  projectCheckoutOriginMismatchGauge: Gauge<"project_workspace_id" | "company_id" | "project_id">;
  projectCheckoutOriginReconcileComparedGauge: Gauge;
  projectCheckoutOriginReconcileMetricsRefreshSuccessGauge: Gauge;
  approvalsPendingGauge: Gauge<"type" | "company_id" | "requester">;
  approvalOldestPendingAgeGauge: Gauge<"type" | "company_id" | "requester">;
  approvalLastDecisionTimestampGauge: Gauge<"company_id" | "requester">;
  approvalQueueMetricsRefreshSuccessGauge: Gauge;
  acceptedInteractionOutcomeGauge: Gauge<"bucket">;
  acceptedInteractionOutcomeOldestAgeGauge: Gauge<"bucket" | "company_id">;
  acceptedInteractionOutcomeRecentGauge: Gauge<"bucket">;
  acceptedInteractionOutcomeMetricsRefreshSuccessGauge: Gauge;
  interactionPayloadUnrecognizedKeyCounter: Counter<"interaction_kind" | "payload_key">;
  agentStartLockHeldSecondsGauge: Gauge<"agent_id">;
  agentStartLockPhaseSecondsGauge: Gauge<"agent_id" | "phase">;
  agentStartLockAbortedTotalCounter: Counter<"agent_id">;
  duplicateDispatchSuppressedCounter: Counter;
  prReviewQueueWaitHistogram: Histogram;
  runDispatchWaitHistogram: Histogram;
  authRequestCounter: Counter<"operation" | "outcome">;
  httpRequestsCounter: Counter<"route" | "method" | "status">;
  httpEmptyListResponsesCounter: Counter<"route" | "method" | "status">;
  gbrainRecallCounter: Counter<"status">;
  agentHeartbeatAgeGauge: Gauge<"agent_id">;
  agentHeartbeatIntervalGauge: Gauge<"agent_id">;
  agentErrorDurationGauge: Gauge<"agent_id">;
  agentErrorReasonAgentsGauge: Gauge<"error_reason">;
  agentErrorReasonOldestAgeGauge: Gauge<"error_reason">;
  projectPrimaryWorkspaceFallbackCounter: Counter;
  backstopDeferredCandidatesGauge: Gauge<"source">;
  backstopSweepCompletedCounter: Counter<"source">;
  backstopCandidatesSkippedCounter: Counter<"source" | "reason">;
  wakeRedeliverySuppressedCounter: Counter<"cause">;
  heartbeatRecoveryChainSkippedCounter: Counter;
  heartbeatRecoveryChainDurationGauge: Gauge;
  heartbeatRecoveryChainInflightGauge: Gauge;
  heartbeatRecoveryChainStalledCounter: Counter;
  schedulerLeaseHeldGauge: Gauge<"lease" | "holder">;
  schedulerLeaseRenewedGauge: Gauge<"lease" | "holder">;
  pluginWebhookDeliveryRejectedCounter: Counter<"plugin_key" | "response_class" | "plugin_status">;
  recoveryHorizonExpiredCounter: Counter<"delivery">;
  recoveryActionAutoDischargedCounter: Counter<"kind">;
  workerTierProxyFailuresCounter: Counter<"reason">;
  isolationReaperScannedCounter: Counter<"dry_run">;
  isolationReaperDeletedCounter: Counter<"dry_run">;
  isolationReaperSkippedLayoutCounter: Counter<"dry_run">;
  isolationReaperRetainedResurrectedCounter: Counter<"dry_run">;
  isolationReaperEntriesCounter: Counter<"dry_run" | "outcome">;
  isolationReaperSweepsCounter: Counter<"dry_run" | "stop_reason">;
  isolationReaperLastSweepGauge: Gauge<"dry_run">;
  executionWorkspaceTeardownCounter: Counter<"trigger" | "method" | "outcome" | "cleanup_reason">;
  executionWorkspaceTeardownDurationHistogram: Histogram<"trigger" | "method" | "cleanup_reason">;
  executionWorkspaceCollectorScannedCounter: Counter<string>;
  executionWorkspaceCollectorCandidatesCounter: Counter<"outcome">;
  executionWorkspaceCollectorStampedCounter: Counter<string>;
  executionWorkspaceCollectorPassesCounter: Counter<"stop_reason">;
  executionWorkspaceCollectorLastPassGauge: Gauge<string>;
} {
  if (
    !registry
    || !concurrentRunBlocked
    || !agentDispatchDeclined
    || !isolatedRunStarted
    || !heartbeatRunFailed
    || !ccrotateCapacityDeferred
    || !retryScheduleOutcome
    || !startLockReapDisposition
    || !orphanReapStageSeconds
    || !penstockGateProbe
    || !penstockGateProbeDuration
    || !heartbeatTimerSchedulerExclusion
    || !modelProfileUnapplied
    || !heartbeatPostTerminalRunEventDropped
    || !heartbeatTimerChecked
    || !heartbeatTimerEnqueued
    || !agentZeroTokenCompletedRunStreak
    || !externalRuntimeReservationEvents
    || !externalRuntimeReservationsActive
    || !externalRuntimeReservationOldestAge
    || !queuedRunAgeMetricsRefreshSuccess
    || !externalRuntimeReservationsReleasePending
    || !externalRuntimeReservationReleasePendingOldestAge
    || !environmentLeasesOrphanedActive
    || !environmentLeasesOrphanedOldestAge
    || !orphanedRuntimeResourceMetricsRefreshSuccess
    || !externalRuntimeReservationStrandedOldestAge
    || !externalRuntimeReservationStrandMetricsRefreshSuccess
    || !workspaceReuseRefusalWindow
    || !workspaceReuseRefusalMetricsRefreshSuccess
    || !projectCheckoutOriginMismatch
    || !projectCheckoutOriginReconcileCompared
    || !projectCheckoutOriginReconcileMetricsRefreshSuccess
    || !approvalsPending
    || !acceptedInteractionOutcome
    || !acceptedInteractionOutcomeOldestAge
    || !acceptedInteractionOutcomeRecent
    || !acceptedInteractionOutcomeMetricsRefreshSuccess
    || !interactionPayloadUnrecognizedKey
    || !approvalOldestPendingAge
    || !approvalLastDecisionTimestamp
    || !approvalQueueMetricsRefreshSuccess
    || !agentStartLockHeldSeconds
    || !agentStartLockPhaseSeconds
    || !agentStartLockAbortedTotal
    || !duplicateDispatchSuppressedTotal
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
    || !githubApiRefusals
    || !githubApiRequests
    || !agentWakeupTerminalFailedUnresolved
    || !agentWakeupTerminalFailedOldestAge
    || !githubWorkflowRunConclusion
    || !githubWebhookDelivery
    || !queuedRunOldestAge
    || !queuedRunOldestClaimableAge
    || !routineLastDoneFireAge
    || !routineLastFireStartAge
    || !routineFireInterval
    || !routineFireGapMetricsRefreshSuccess
    || !deferredIssueExecutionWakeOldestAge
    || !deferredIssueExecutionWakeAgeMetricsRefreshSuccess
    || !coldInReviewIssueOldestAge
    || !coldInReviewIssueMetricsRefreshSuccess
    || !overdueScheduledRetryOldestAge
    || !overdueScheduledRetryAgeMetricsRefreshSuccess
    || !scheduledRetryParkHorizon
    || !scheduledRetryParkHorizonRefreshSuccess
    || !dbPoolConnections
    || !dbPoolWaitingQueries
    || !dbInheritedTimeout
    || !processOpenFdsByClass
    || !processMemoryComponentBytes
    || !processV8ContextCount
    || !processMappingRssBytes
    || !processMappingCount
    || !processMappingSizeBucketCount
    || !processMappingSizeBucketBytes
    || !processGlibcSecondaryArenaHeapCount
    || !processMappingScanSeconds
    || !processMappingScanTimestamp
    || !processHeapPeakSamples
    || !processRssReleaseEvents
    || !processRssReleaseBytes
    || !processRssReleaseLastOnsetTimestamp
    || !processRssReleaseLastDetectedTimestamp
    || !processRssReleaseLastBytes
    || !processRssReleaseSamples
    || !processRssReleaseBoundBytes
    || !cgroupMemoryComponentBytes
    || !cgroupMemoryCurrentBytes
    || !cgroupMemoryMaxBytes
    || !cgroupMemoryPeakBytes
    || !pluginError
    || !crashRecoveryCandidateIndexPresent
    || !pluginMetric
    || !pluginMetricDropped
    || !pluginStatusCollectorLastSuccess
    || !prReviewQueueWait
    || !runDispatchWait
    || !authRequest
    || !httpRequests
    || !httpEmptyListResponses
    || !gbrainRecallTotal
    || !agentHeartbeatAge
    || !agentHeartbeatInterval
    || !agentErrorDuration
    || !agentErrorReasonAgents
    || !agentErrorReasonOldestAge
    || !projectPrimaryWorkspaceFallback
    || !backstopDeferredCandidates
    || !backstopSweepCompleted
    || !backstopCandidatesSkipped
    || !wakeRedeliverySuppressed
    || !heartbeatRecoveryChainSkipped
    || !heartbeatRecoveryChainDuration
    || !heartbeatRecoveryChainInflight
    || !heartbeatRecoveryChainStalled
    || !schedulerLeaseHeld
    || !schedulerLeaseRenewed
    || !pluginWebhookDeliveryRejected
    || !recoveryHorizonExpired
    || !recoveryActionAutoDischarged
    || !workerTierProxyFailures
    || !isolationReaperScanned
    || !isolationReaperDeleted
    || !isolationReaperSkippedLayout
    || !isolationReaperRetainedResurrected
    || !isolationReaperEntries
    || !isolationReaperSweeps
    || !isolationReaperLastSweep
    || !executionWorkspaceTeardown
    || !executionWorkspaceTeardownDuration
    || !executionWorkspaceCollectorScanned
    || !executionWorkspaceCollectorCandidates
    || !executionWorkspaceCollectorStamped
    || !executionWorkspaceCollectorPasses
    || !executionWorkspaceCollectorLastPass
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
    agentDispatchDeclined = new Counter({
      name: AGENT_DISPATCH_DECLINED_METRIC,
      help:
        "Count of queued-run dispatch passes that declined to start a run, labeled by "
        + "bounded agent_id and the reason the pass bailed (PEN-3607). Every `return []` "
        + "in startNextQueuedRunForAgent increments this; before it, fourteen of the "
        + "fifteen were silent and a wedged seat was unexplainable from outside the "
        + "process. Dispatch retries every scheduler tick, so a wedged seat shows as a "
        + "SUSTAINED RATE on one reason rather than as an absence — read it with "
        + "rate()/increase(), and never infer a cause from a series that stopped. "
        + "agent_id='unknown' on THIS metric means attribution was collapsed BY DESIGN "
        + "ON THE FOUR REASONS NAMED BELOW, and only on those — the OPPOSITE of what the "
        + "same label value means on "
        + HEARTBEAT_RUN_FAILED_METRIC + ", where it means the id was genuinely missing or "
        + "unrecognized. The contrast is PER-REASON, not per-metric: on this metric's "
        + "OTHER, attributed reasons an 'unknown' carries that second meaning instead — "
        + "the id fell outside the company roster normalizeAgentId matched against, e.g. "
        + "an agent created inside the membership-cache window. So do not read the two "
        + "metrics alike, and do not read a collapsing reason and an attributed one alike "
        + "on THIS metric either (PEN-4532). Four reasons always collapse. "
        + "dispatch_stopped, api_tier_fence and scheduling_suppressed are "
        + "process-wide guards that fire before the agent row is loaded: they pass "
        + "companyId=null, so the roster read is skipped and normalizeAgentId has no set "
        + "to match against. The real agent id IS known at those three call sites and is "
        + "withheld deliberately — the refusal is a fact about the PROCESS, so a "
        + "per-agent series would partition it by which seat's wake happened to land "
        + "there rather than by seat health, and would alert on healthy seats. "
        + "agent_missing collapses permanently and is NOT fixable by threading a company "
        + "id (the agents row does not exist, so no roster can contain it); that is the "
        + "one reason where WHICH agent vanished is the whole datum, and it must be read "
        + "from the logs. Operator consequence: a collapsed reason is a FLEET-WIDE TOTAL "
        + "summed over every agent, so comparing it against one seat's slice of an "
        + "attributed reason overstates it by roughly the seat count — aggregate both "
        + "sides before comparing. On a split api/worker deployment a steady "
        + "api_tier_fence rate is EXPECTED and benign: PAPERCLIP_NODE_ROLE=api disables "
        + "the scheduler, so the api tier never claims runs and every HTTP/webhook-path "
        + "dispatch kick lands here, leaving the run for the worker tick "
        + "(heartbeatSchedulerIntervalMs, default 30s) to claim.",
      labelNames: ["agent_id", "reason"],
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
        + "compute webhook-driven PR-review failure rate and detect repeated execution-pod "
        + "failures (BLO-7457 / BLO-9147 / BLO-17953). agent_id is retained for EVERY error code "
        + "and bounded to the company agent roster by normalizeAgentId, so agent_id='unknown' means "
        + "the run carried no agent id, an id that is not a real agent, or an id the 30s roster "
        + "cache had not yet observed — not that policy collapsed it. That last case is reachable "
        + "only for that agent's failing runs within 30s of its creation, and every one of them "
        + "collapses, not just the first: nothing invalidates the cache on agent creation, and an "
        + "unrecognized id does not trigger a refresh (normalizeAgentId is a pure membership "
        + "test). issue_id is unbounded and is retained only "
        + "for k8s_pod_schedule_failed, in every isolation mode (run, workspace and shared are all "
        + "execution pods); every other error code collapses it to 'none' (BLO-17953 A1f). Note "
        + "issue_id is also legitimately 'none' for stateless PR-review runs, which are issue-less "
        + "by construction — that is not an attribution defect.",
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
    penstockGateProbe = new Counter({
      name: PENSTOCK_AVAILABILITY_GATE_PROBE_METRIC,
      help:
        "Count of penstock availability-gate probes (BLO-29900), labeled by path "
        + "(capacity = the cached GET /v1/pools/default/capacity; messages_fallback = the "
        + "real POST /v1/messages taken when that GET yields no verdict), bounded outcome, "
        + "provider, and model. path=capacity counts every attempt and is the denominator "
        + "for fallback share. Seeded per tuple (PEN-4675): the first probe recorded for a "
        + "(path, provider, model) materialises all six outcomes for that tuple at zero, so "
        + "within that tuple an unfired outcome reads 0 rather than vanishing and a quiet "
        + "hour is distinguishable from a dead exporter. Seeding is still per tuple, not "
        + "global: an absent messages_fallback series means the fallback has not been taken "
        + "since process start, so confirm path=capacity is advancing before reading that "
        + "silence as health. Series are also per process, so a pod restart resets them and "
        + "absence across a restart boundary stays uninformative. Cache hits are not counted, "
        + "so the ratio is over real re-probes. The fail-open set is path-qualified: "
        + "path=messages_fallback with outcome=error|auth_fault allows dispatch with no "
        + "verdict, and so does path=capacity with outcome=error, which no longer falls "
        + "through to the fallback (BLO-29900 item 3) - a transport failure says nothing "
        + "about the model. path=capacity with outcome=auth_fault|inconclusive is fail-open "
        + "only where there is no fallback: on anthropic it falls through and the fallback "
        + "decides, but codex has no messagesUrl, so there every verdict-less capacity "
        + "outcome is terminal fail-open and no messages_fallback series exists to alert on.",
      labelNames: ["path", "outcome", "provider", "model"],
      registers: [registry],
    });
    penstockGateProbeDuration = new Histogram({
      name: PENSTOCK_AVAILABILITY_GATE_PROBE_DURATION_METRIC,
      help:
        "Seconds spent in one penstock availability-gate probe, labeled by path and provider "
        + "(BLO-29900). Answers whether the messages_fallback probe is materially more "
        + "expensive than the capacity GET the clamp's cheapness assumption rests on. "
        + "Buckets run to 5s so a probe aborted at the gate's 3s timeout stays visible.",
      labelNames: ["path", "provider"],
      buckets: [...PENSTOCK_PROBE_DURATION_BUCKETS_SECONDS],
      registers: [registry],
    });
    modelProfileUnapplied = new Counter({
      name: MODEL_PROFILE_UNAPPLIED_METRIC,
      help:
        "Count of heartbeat runs whose requested model profile was not applied (BLO-32843), "
        + "so the run executed on the agent's primary model. reason is the resolver's "
        + "fallbackReason, e.g. adapter_profile_not_supported.",
      labelNames: ["adapter", "requested", "reason"],
      registers: [registry],
    });
    heartbeatTimerSchedulerExclusion = new Counter({
      name: HEARTBEAT_TIMER_SCHEDULER_EXCLUSION_METRIC,
      help:
        "Count of heartbeat timer-loop exclusions, labeled by a bounded operational reason. "
        + "Each increment has durable evidence in agent_wakeup_requests or a scheduled_retry "
        + "heartbeat run. Two populations, both in this counter (PEN-4737): due ticks "
        + "excluded before dispatch, once per due tick; and agents filtered before the loop "
        + "counts them in " + HEARTBEAT_TIMER_CHECKED_METRIC + " "
        + "(agent.not_invokable, heartbeat.disabled, heartbeat.worktree_execution_cutoff), "
        + "rate-limited to one increment per agent per reason per hour because those three "
        + "run above the dueness gate and would otherwise fire on every 30s scheduler pass. "
        + "So a non-zero rate on those three is evidence of exclusion, but a zero rate over "
        + "a window shorter than an hour is not evidence of its absence.",
      labelNames: ["reason"],
      registers: [registry],
    });
    heartbeatPostTerminalRunEventDropped = new Counter({
      name: HEARTBEAT_POST_TERMINAL_RUN_EVENT_DROPPED_METRIC,
      help:
        "Count of adapter run events dropped because they arrived after the run reached a "
        + "terminal status, labeled by that terminal status (BLO-32553). Each increment has a "
        + "matching logger.warn carrying the dropped event's type, message and payload. A "
        + "non-zero rate means an adapter is emitting from a continuation that outlives "
        + "execute() — expected only on the orphan-kill path.",
      labelNames: ["status"],
      registers: [registry],
    });
    // Unlabeled on purpose (BLO-32269): consumed as
    // `sum(increase(...[15m])) == 0`. prom-client zero-initializes an unlabeled
    // counter at construction, so both series are present on the very first
    // scrape after boot — a dispatch-dark rule must be able to tell "0 ticks"
    // from "metric not published yet", and an absent series cannot.
    heartbeatTimerChecked = new Counter({
      name: HEARTBEAT_TIMER_CHECKED_METRIC,
      help:
        "Count of heartbeat timer-loop candidates examined, summed across completed "
        + "tickTimers passes. Composite: agents examined + due issue monitors + expired "
        + "issue monitors. Recorded on every completed pass, not only passes that "
        + "enqueued something. Read with " + HEARTBEAT_TIMER_ENQUEUED_METRIC
        + ": checked>0/enqueued=0 is a healthy idle loop. checked=0 means no candidate "
        + "was examined, which is NOT by itself a dead loop -- a pass can complete with "
        + "zero after every agent is filtered out, and the loop is also not entered "
        + "under global scheduling suppression, during startup recovery, or during the "
        + "shutdown drain. A completed pass is also dropped outright, both halves, if "
        + "either input is not a non-negative finite number -- that is logged with the "
        + "offending field and should never happen. "
        + HEARTBEAT_TIMER_SCHEDULER_EXCLUSION_METRIC + " narrows these since "
        + "PEN-4737: a zero here alongside a non-zero agent.not_invokable, "
        + "heartbeat.disabled or heartbeat.worktree_execution_cutoff increase means the "
        + "per-agent loop ran and filtered every agent ahead of this counter, not that "
        + "the loop is dead. Those three are rate-limited to one per agent per reason "
        + "per hour, so read them over an hour or more, and a zero increase over a "
        + "shorter window is not evidence against that case. It stays silent for "
        + "suppression, startup recovery and the shutdown drain -- rule those out from "
        + "worker uptime and logs before restarting. Emitted by the worker, where the "
        + "timer loop runs (BLO-32269).",
      registers: [registry],
    });
    heartbeatTimerEnqueued = new Counter({
      name: HEARTBEAT_TIMER_ENQUEUED_METRIC,
      help:
        "Count of heartbeat runs enqueued by the timer loop, summed across completed "
        + "tickTimers passes. Mirrors the `enqueued` field of the "
        + "'heartbeat timer tick enqueued runs' log line. Direct dispatcher-side "
        + "replacement for the isolated-run proxy previously used by "
        + "PaperclipFleetDispatchDark, which could not see shared-isolation work "
        + "(BLO-32269 / BLO-32063).",
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
      help:
        "Booked scheduled_retry park horizon in seconds, by agent and park reason (BLO-31174). "
        + "`reason` is load-bearing, not decoration: legitimate ceilings differ by class and span "
        + "at least 289x (max_turns_continuation 300s, ccrotate_capacity 1080s as a 15min clamp plus "
        + "20% forward jitter, dependency_blocked "
        + "3600s, transient_failure 9000s on the backoff ladder but up to 86700s when an unclamped "
        + "upstream retryNotBefore floor is at or just under the 24h horizon and takes up to 5min forward "
        + "jitter; a floor actually clamped to 24h carries no forward jitter, and it is unbounded for a "
        + "provider_quota floor, which is never clamped), so any single threshold across all of "
        + "them fires on designed backoff in one class while missing a 5x clamp breach in another. "
        + "Bound each reason against its own ceiling. reason='none' is a per-agent zero floor emitted for every "
        + "known agent, including agents with live parks, so it selects the whole fleet and does "
        + "not mean the agent is drained; it is not a park class, is always 0, and must never "
        + "carry a bound.",
      labelNames: ["agent_id", "reason"],
      registers: [registry],
    });
    scheduledRetryParkHorizonRefreshSuccess = new Gauge({
      name: SCHEDULED_RETRY_PARK_HORIZON_REFRESH_SUCCESS_METRIC,
      help: "1 when the scheduled_retry park horizon database refresh succeeded, otherwise 0.",
      registers: [registry],
    });
    scheduledRetryParkHorizonRefreshSuccess.set(0);
    retryScheduleOutcome = new Counter({
      name: RETRY_SCHEDULE_OUTCOME_METRIC,
      help:
        "Count of retry-scheduling decisions (BLO-35472), by bounded outcome and retry reason. "
        + "Incremented once per scheduleBoundedRetryForRun return. outcome='scheduled' is the "
        + "retry-row creation rate; outcome='routine_retry_abandoned' is a retry deliberately not "
        + "created because the owning routine's window cannot accept a useful one, so the next "
        + "scheduled fire takes the work. That branch persists no row, so it is invisible to "
        + SCHEDULED_RETRY_PARK_HORIZON_METRIC + ", which is a max over LIVE retries and therefore "
        + "falls when retries are dropped. Every outcome x retry_reason series is zero-seeded at "
        + "start, so increase() counts the first event after each worker restart.",
      labelNames: ["outcome", "retry_reason"],
      registers: [registry],
    });
    // BLO-35472: zero-seed the closed label set. A lazily-created series makes
    // its first sample its first event, which increase()/rate() cannot see --
    // and the worker restarts often, so the rare arms this counter exists for
    // lost one event per restart (measured 7d: 8 abandons reported vs 12 real).
    for (const outcome of KNOWN_RETRY_SCHEDULE_OUTCOMES) {
      for (const retry_reason of KNOWN_RETRY_SCHEDULE_REASONS) {
        retryScheduleOutcome.inc({ outcome, retry_reason }, 0);
      }
    }
    orphanReapStageSeconds = new Histogram({
      name: ORPHAN_REAP_STAGE_SECONDS_METRIC,
      help:
        "Seconds per stage of one fleet-wide orphan-reap sweep (BLO-42010). "
        + "stage='total' is the whole sweep. Start-lock waiters can wait ~2x a sweep, "
        + "so sweeps over ~60 s drive the reap disposition timed_out rate.",
      labelNames: ["stage"],
      buckets: [0.1, 0.5, 1, 2, 5, 10, 20, 30, 45, 60, 90, 120, 180, 300],
      registers: [registry],
    });
    startLockReapDisposition = new Counter({
      name: AGENT_START_LOCK_REAP_DISPOSITION_METRIC,
      help:
        "Count of start-lock orphan-reap dispositions (BLO-42010), once per "
        + "external-lifecycle dispatch pass. "
        + "disposition='timed_out' is a pass that gave up waiting on the fleet sweep and "
        + "dispatched on STALE orphan state; its share of the total is the bail rate, which "
        + "logs cannot supply because the per-disposition debug line is below the deployed "
        + "level and the surviving warn line is gated on the hold budget, so it records a "
        + "complete timed_out numerator against no denominator. disposition='nested' is the "
        + "only one that WAITS on a sweep without the wait bound, so while the bound is "
        + "enabled it is the only one whose "
        // No `{` after the metric name: HELP text must not look like a sample line,
        // or a substring assertion over the exposition (and a human grep) will
        // match it. Guarded by start-lock-reap-disposition-metric.test.ts.
        + AGENT_START_LOCK_PHASE_SECONDS_METRIC + " phase=\"reap\" hold can exceed it "
        + "(skipped_fresh also skips the bound but returns synchronously). "
        + "AGENT_START_LOCK_REAP_WAIT_BOUND_MS=0 disables the bound for every disposition: "
        + "ran and joined then wait unbounded too and timed_out is never emitted. "
        + "Not pre-seeded: an absent series means never incremented, so pair any zero reading "
        + "with a populated sibling disposition before concluding no bails occurred rather "
        + "than no scrape.",
      labelNames: ["disposition"],
      registers: [registry],
    });
    dbPoolConnections = new Gauge({
      name: DB_POOL_CONNECTIONS_METRIC,
      help:
        "postgres.js connection-pool occupancy by state (BLO-33243): max (the configured cap), "
        + "idle (connected, no query), active (serving or reserved), connecting (handshaking). "
        + "Per-pod, because the pool is per-process -- which is what made the /metrics scrape "
        + "timeouts independent across pods and across nodes. Saturation is idle=0 with "
        + "active=max and " + DB_POOL_WAITING_QUERIES_METRIC + " above 0. pool=main is the "
        + "process pool; pool=webhook is the API tier's dedicated GitHub webhook pool (BLO-47034).",
      labelNames: ["pool", "state"],
      registers: [registry],
    });
    dbPoolWaitingQueries = new Gauge({
      name: DB_POOL_WAITING_QUERIES_METRIC,
      help:
        "Statements queued with no pool connection yet (BLO-33243). postgres.js only enqueues "
        + "here once every connection is busy, so a sustained non-zero value IS pool exhaustion "
        + "and a zero value rules it out. Labelled by pool like " + DB_POOL_CONNECTIONS_METRIC + ".",
      labelNames: ["pool"],
      registers: [registry],
    });
    dbInheritedTimeout = new Gauge({
      name: DB_INHERITED_TIMEOUT_METRIC,
      help:
        "Timeout environment the application pool INHERITS from the server, in seconds, by "
        + "setting and by the pg_settings source that set it (PEN-3365). 0 means disabled, as "
        + "Postgres encodes it, so statement_timeout=0 is the unbounded case. source=default "
        + "means nothing sets it; database/user means a real inherited bound. NOT the effective "
        + "value for idle_in_transaction_session_timeout: the pool overrides that in its own "
        + "startup packet, which this probe deliberately does not observe. The pool's own value "
        + `is the setting=${POOL_IDLE_IN_TRANSACTION_SERIES},source=startup_packet series; `
        + "it above a non-zero inherited value means the pool LOOSENS the server's bound "
        + "(PEN-3365). statement_timeout and lock_timeout are not set pool-side, so for "
        + "those inherited is effective. Do not read "
        + "postgres_exporter's pg_settings_* for this -- that reports the exporter's own session.",
      labelNames: ["setting", "source"],
      registers: [registry],
    });
    processOpenFdsByClass = new Gauge({
      name: PROCESS_OPEN_FDS_BY_CLASS_METRIC,
      help:
        "Open file descriptors split by readlink('/proc/self/fd/N') target class (PEN-3314). "
        + "prom-client's process_open_fds says the count is climbing; this says what is climbing. "
        + "Classes: socket, pipe, memfd, anon_inode:<subtype>, file:<bounded dir>, "
        + "deleted:<bounded dir> (fd held on an unlinked file -- the classic leak signature, "
        + "but NOT authenticated: a live file whose name merely ends in ' (deleted)' readlinks "
        + "identically, so this class can be inflated by a filename), "
        + "vanished (readlink lost a race with close; ~1 per scrape is the readdir handle itself), "
        + "unreadable (descriptor seen but not classifiable -- readlink failed for some reason "
        + "other than the race, or the target read back empty, or its kernel prefix is one this "
        + "build does not recognise), "
        + "other (fold of everything past the series cap), unclassified-truncated (descriptors "
        + "beyond the per-scrape inspection cap). Counts sum to the true descriptor total. "
        + "Directory labels are depth-bounded AND per-segment alphabet-bounded (an "
        + "identifier-shaped segment becomes '*', e.g. /tmp/paperclip-run-*), so this names a "
        + "code site class, not a file, and does not mint a series per run. "
        + "NOT an alert source: max_fds is 524288 against ~240 open, and the heap aborts long "
        + "before descriptors matter. Absent series means there is no procfs to read at all "
        + "(non-Linux), which is deliberately distinct from a zero. A LONE table-unreadable "
        + "series means the opposite: procfs exists and enumerating /proc/self/fd failed "
        + "(EACCES under a restricted /proc, ENOMEM, ...), so the instrument is deployed and "
        + "broken rather than absent -- its value is always 0 and carries nothing; its presence "
        + "is the signal.",
      labelNames: ["fd_class"],
      registers: [registry],
    });
    processMemoryComponentBytes = new Gauge({
      name: PROCESS_MEMORY_COMPONENT_BYTES_METRIC,
      help:
        "Resident memory split into the pools V8's own gauges do not report (PEN-3314). "
        + "native_unaccounted = rss - heapTotal - external, the headline residual: measured "
        + "281 -> 2098 MB over 21h on the 2026-10-11 worker generation while "
        + "nodejs_heap_size_used_bytes' floor slope was NEGATIVE (-3.5 MB/h), which is why the "
        + "heap gauges stopped being evidence about this process. It is NOT clamped at zero -- a "
        + "negative value means V8's committed heap holds pages that are not resident (normal "
        + "shortly after start) and is distinct from 'no native memory'. "
        + "array_buffers and external_other split nodejs_external_memory_bytes into its "
        + "ArrayBuffer-backed and C++-bound-object halves; v8_malloced / v8_peak_malloced and "
        + "v8_global_handles_total / v8_global_handles_used are V8 allocations OUTSIDE the heap "
        + "it reports as heapTotal, so a native addon leaking persistent handles appears in "
        + "v8_global_handles_total and in no other series this process emits. "
        + "These components are NOT a partition of RSS and do not sum to it -- array_buffers and "
        + "external_other are inside the external that native_unaccounted subtracts, and "
        + "v8_malloced overlaps the residual. Read each on its own trend. "
        + "NOT an alert source: it names which pool grows, it does not bound it. An absent "
        + "component means this runtime does not report that field, deliberately distinct from a "
        + "zero; absence of the whole metric means neither process.memoryUsage() nor "
        + "v8.getHeapStatistics() could be read at all.",
      labelNames: ["component"],
      registers: [registry],
    });
    processV8ContextCount = new Gauge({
      name: PROCESS_V8_CONTEXT_COUNT_METRIC,
      help:
        "V8 context counts (PEN-3314). kind=native is a steady-state value; growth means "
        + "contexts are being retained. kind=detached counts contexts detached but not yet "
        + "collected -- a leak signature whose healthy steady state is 0, so the series is "
        + "published AT 0 rather than omitted, and an absent series means this runtime does not "
        + "report the field.",
      labelNames: ["kind"],
      registers: [registry],
    });
    processMappingRssBytes = new Gauge({
      name: PROCESS_MAPPING_RSS_BYTES_METRIC,
      help:
        "Resident memory attributed to the allocator region it lives in, from /proc/self/smaps "
        + "(PEN-3314). Unlike paperclip_process_memory_component_bytes -- which is a residual, "
        + "rss - heapTotal - external -- this IS a partition: every mapping lands in exactly one "
        + "mapping_class and the classes sum to mapping_class=total, which carries the kernel's "
        + "own figure so a dropped mapping is a visible subtraction rather than a silent one. "
        + "glibc_secondary_arena and anon_aligned_64m_full are the population the "
        + "64-CPU/512-arena hypothesis is about, SPLIT BY HEAP MATURITY AND MEANT TO BE READ "
        + "TOGETHER: new_heap() reserves 64MiB at 64MiB alignment with a PROT_NONE tail "
        + "(glibc_secondary_arena), but grow_heap() consumes that tail as the heap grows, so a "
        + "heap at HEAP_MAX_SIZE -- and two mature neighbours the kernel has merged -- appear "
        + "fully committed and land in anon_aligned_64m_full instead. That second class is a "
        + "CANDIDATE: an aligned, exactly-N*64MiB V8 reservation is indistinguishable from a "
        + "mature heap, which is why it is published beside the confirmed class rather than "
        + "added to it. Reading glibc_secondary_arena alone would miss precisely the "
        + "large-retention case. glibc_main_arena is [heap] (brk). anon_other carries V8's own "
        + "heap reservations and is EXPECTED to be large -- the complement that makes the "
        + "partition exact, NOT a leak signal, and NOT a negative result about glibc: anonymous "
        + "memory that is unaligned or not an exact multiple of 64MiB lands there whatever "
        + "allocated it, and the arena classes are strict enough to under-claim. file_backed is "
        + "executable text and shared objects, special is kernel pseudo-mappings (named "
        + "anonymous mappings from PR_SET_VMA_ANON_NAME go to anon_other, not here), "
        + "unclassified_truncated is the fold past the per-scan mapping cap. "
        + "SAMPLED ON A LONG CADENCE, NOT PER SCRAPE: the read costs O(resident pages) "
        + "(~36us/MB; 108ms measured at 3037MB) and is a synchronous event-loop block, and the "
        + "signature this row chases is itself an event-loop stall -- see "
        + "paperclip_process_mapping_scan_timestamp_seconds for how stale the values are and "
        + "paperclip_process_mapping_scan_seconds for what the scan cost. "
        + "NOT an alert source: it localises growth to a region class, it does not bound it. "
        + "Absent metric means /proc/self/smaps could not be read at all (non-Linux), "
        + "deliberately distinct from a measured zero.",
      labelNames: ["mapping_class"],
      registers: [registry],
    });
    processMappingCount = new Gauge({
      name: PROCESS_MAPPING_COUNT_METRIC,
      help:
        "Mappings (VMAs) per mapping_class (PEN-3314), beside "
        + "paperclip_process_mapping_rss_bytes. NOT a heap count, and it errs in BOTH "
        + "directions: a YOUNG glibc secondary-arena heap is 2+ VMAs (a committed prefix and a "
        + "PROT_NONE tail), but one grown to HEAP_MAX_SIZE has no tail left and is a single VMA, "
        + "and the kernel merges mature neighbours, so several heaps can be ONE mapping. "
        + "paperclip_process_glibc_secondary_arena_heap_count does NOT close that gap: it counts "
        + "the YOUNG heaps only. Mature ones land in mapping_class=anon_aligned_64m_full, which "
        + "is a candidate class and not a heap count either -- an aligned N x 64MiB V8 "
        + "reservation is indistinguishable. Read those two together; arena retention appears as "
        + "the full class rising while the heap count plateaus, and NO series here is the heap "
        + "count. Published at a measured 0 for classes this process currently has none of.",
      labelNames: ["mapping_class"],
      registers: [registry],
    });
    processMappingSizeBucketCount = new Gauge({
      name: PROCESS_MAPPING_SIZE_BUCKET_COUNT_METRIC,
      help:
        "Size distribution of the mapping_class=anon_other population (PEN-3314), bucketed by "
        + "VIRTUAL size floored to a power of two. size_bucket is the bucket's inclusive lower "
        + "bound in BYTES; the bucket spans [size_bucket, 2*size_bucket). ONLY anon_other is "
        + "bucketed -- the other classes are not published here at all, which is ABSENCE and not "
        + "a measured 0. USELESS ALONE: read it with paperclip_process_mapping_size_bucket_bytes, "
        + "whose quotient is the MEAN SIZE WITHIN a bucket. That quotient is the point -- a mean "
        + "of exactly 262144 in the 262144 bucket is a FIXED-SIZE allocator (a V8 regular page is "
        + "exactly 262144 bytes), while a mean strictly inside the bounds is a PAYLOAD-SIZED one. "
        + "Those two send the fix to different places and occupy the same bucket. Virtual size, "
        + "NOT resident: residency is already published per class by "
        + "paperclip_process_mapping_rss_bytes, and a partially-resident 256KiB mapping is still "
        + "a 256KiB allocation. Published at a measured 0 for buckets this process has none of.",
      labelNames: ["size_bucket"],
      registers: [registry],
    });
    processMappingSizeBucketBytes = new Gauge({
      name: PROCESS_MAPPING_SIZE_BUCKET_BYTES_METRIC,
      help:
        "Summed VIRTUAL bytes of the mapping_class=anon_other mappings in each size_bucket "
        + "(PEN-3314). The denominator's partner: see "
        + "paperclip_process_mapping_size_bucket_count for what the quotient discriminates, and "
        + "for why this is virtual rather than resident size. It does NOT sum to "
        + "paperclip_process_mapping_rss_bytes{mapping_class=\"anon_other\"} and is not meant to "
        + "-- that series is resident bytes and this one is mapped bytes, so the gap between them "
        + "is mapped-but-not-resident address space.",
      labelNames: ["size_bucket"],
      registers: [registry],
    });
    processGlibcSecondaryArenaHeapCount = new Gauge({
      name: PROCESS_GLIBC_SECONDARY_ARENA_HEAP_COUNT_METRIC,
      help:
        "glibc secondary-arena HEAPS that still carry a PROT_NONE reserved tail (PEN-3314). "
        + "HEAPS, NOT ARENAS: an arena that outgrows its first heap allocates another, so one "
        + "arena can contribute several -- do NOT compare this with the 8 * ncpu arena cap "
        + "(512 on this 64-CPU node, which glibc sizes from the NODE and not the 4-CPU cgroup, "
        + "and never trims back to the OS). "
        + "COUNTS YOUNG HEAPS ONLY: grow_heap() mprotects the reserved tail read/write as a "
        + "heap grows, so a heap at HEAP_MAX_SIZE has no tail left and is NOT counted here -- "
        + "it moves to mapping_class=anon_aligned_64m_full, as do two mature neighbours the "
        + "kernel has merged into one mapping. READ THE TWO TOGETHER; arena retention appears "
        + "as the full class rising while this one plateaus, and reading this series alone "
        + "would miss exactly the large-retention case. "
        + "Validated against a forced positive: 256 concurrent zlib.gzip calls at "
        + "UV_THREADPOOL_SIZE=64 moved it 5 -> 69 heaps (0.29 -> 10.29 MB), one per threadpool "
        + "thread -- which exercises this series only, never the mature branch. "
        + "A HIGH COUNT IS NOT BY ITSELF A FINDING: the blanket arena lead was demoted "
        + "2026-10-13 because the same-image paperclip-api sibling on the same node has the "
        + "same cap and releases memory normally. The finding would be arena RSS tracking the "
        + "native residual across a generation while the sibling's does not.",
      registers: [registry],
    });
    processMappingScanSeconds = new Gauge({
      name: PROCESS_MAPPING_SCAN_SECONDS_METRIC,
      help:
        "Duration of the last /proc/self/smaps scan (PEN-3314). The read walks page tables, so "
        + "it costs O(resident pages) and GROWS WITH THE LEAK IT MEASURES: measured 1.91ms at "
        + "47MB RSS, 35.96ms at 1047MB, 108.42ms at 3037MB (~36us/MB, median of 7). That is a "
        + "synchronous event-loop block, which is why the scan runs on a long cadence rather "
        + "than per scrape -- the +672MB step signature co-occurs with the heartbeat timer "
        + "failing to advance, so an instrument that stalls the loop could manufacture its own "
        + "evidence. Watch this series to confirm it does not.",
      registers: [registry],
    });
    processMappingScanTimestamp = new Gauge({
      name: PROCESS_MAPPING_SCAN_TIMESTAMP_METRIC,
      help:
        "Unix time of the last completed /proc/self/smaps scan (PEN-3314). The mapping series "
        + "are republished unchanged between scans, so they are deliberately staler than the "
        + "scrape; time() - this is that staleness. A value that stops advancing while the "
        + "process still serves /metrics means scans are failing, which the mapping series "
        + "alone cannot show because they would simply hold their last value.",
      registers: [registry],
    });
    // Same registration-time hazard as processHeapPeakSamples below: prom-client
    // renders a LABEL-LESS gauge as `name 0` from the moment it is registered.
    // Each of these three would be actively misleading at 0 -- no secondary
    // arenas, a free scan, and a 1970 scan timestamp that makes
    // `time() - timestamp` read as 56 years of staleness. Drop them at
    // construction so "no scan has completed" is ABSENT until one has.
    processGlibcSecondaryArenaHeapCount.remove();
    processMappingScanSeconds.remove();
    processMappingScanTimestamp.remove();
    processHeapPeakSamples = new Gauge({
      name: PROCESS_HEAP_PEAK_SAMPLES_METRIC,
      help:
        "Samples the 1s heap-peak sampler has folded in over this process's life (PEN-3314). "
        + "Qualifies the heap_used_peak / heap_total_peak / external_peak components of "
        + PROCESS_MEMORY_COMPONENT_BYTES_METRIC
        + " -- the only series here whose LOW reading decides anything, since a flat "
        + "external_peak is what sends the next instrument to malloc level instead of into "
        + "server code. The sampler runs on the event loop, and the step it exists to catch "
        + "STALLS the event loop, so a peak that is flat because the sampler never ran "
        + "during the burst is indistinguishable from one that is flat because nothing "
        + "happened -- opposite conclusions. rate() over this "
        + "series separates them: a healthy 1s sampler rates at ~1.0/s and a dip IS the stall, "
        + "measured rather than inferred from a scrape that happened not to land. "
        + "Monotonic within a process; on restart the series goes ABSENT and then reappears "
        + "from a low count rather than stepping down, so read it with rate()/increase() and "
        + "never as a level. An absent series means the sampler has not ticked yet; it is never "
        + "published at 0, because the tracker reports nothing until its first sample. "
        + "NOT an alert source on its own.",
      registers: [registry],
    });
    // prom-client publishes a LABEL-LESS gauge as `name 0` the moment it is
    // registered -- before anything has measured anything. For this series a 0
    // is not a quiet default: rate() reads it as a permanently stalled event
    // loop, which is the exact failure the series exists to detect. Drop it at
    // construction so "the sampler has never run" is ABSENT from the first
    // scrape onward, and so that property belongs to the metric rather than to
    // the order in which `/metrics` happens to call its refreshers.
    processHeapPeakSamples.remove();
    processRssReleaseEvents = new Gauge({
      name: PROCESS_RSS_RELEASE_EVENTS_METRIC,
      help:
        "RSS release episodes detected by the 1s sampler over this process's life (PEN-3314). "
        + "An episode opens when resident memory falls 64 MiB below its running high-water "
        + "mark and closes when it recovers 64 MiB above the trough. This is the counterpart "
        + "to the *_peak components of "
        + PROCESS_MEMORY_COMPONENT_BYTES_METRIC
        + ", which are maxima and so cannot record a release at all. "
        + "It is a DRAWDOWN detector, not a per-sample delta: the measured 3.3 GB release took "
        + "~15 minutes (~3.6 MB/s), which no edgewise threshold above ordinary churn would ever "
        + "catch, so one episode covers a whole drain rather than minting an event per sample. "
        + "Monotonic within a process; on restart the series goes ABSENT and reappears from 0 "
        + "rather than stepping down, so read it with increase() and never as a level. "
        + "A ZERO IS NOT EVIDENCE THAT NO RELEASE OCCURRED -- read it against "
        + PROCESS_RSS_RELEASE_SAMPLES_METRIC
        + ", without which 'sampled 40000 times and saw nothing' and 'the sampler never ran' are "
        + "the same number and opposite conclusions. NOT an alert source.",
      registers: [registry],
    });
    processRssReleaseBytes = new Gauge({
      name: PROCESS_RSS_RELEASE_BYTES_METRIC,
      help:
        "Cumulative peak-to-trough bytes returned across every detected episode (PEN-3314). "
        + "Separates a generation that releases often and shallowly from one that releases once "
        + "and deeply -- two shapes with the same episode count. Monotonic within a process; "
        + "read with increase(), never as a level. NOT an alert source.",
      registers: [registry],
    });
    processRssReleaseLastOnsetTimestamp = new Gauge({
      name: PROCESS_RSS_RELEASE_LAST_ONSET_TIMESTAMP_METRIC,
      help:
        "Unix time of the START of the most recent RSS drawdown (PEN-3314). THE HEADLINE "
        + "SERIES: the instant to align a trigger search against. As of 2026-10-26 nothing in "
        + "Prometheus marked this instant -- not GC, in-flight runs, dispatch, container stall "
        + "or node PSI -- and the finest timestamp available was +/-300 s, floored by the "
        + "/proc/self/smaps scan's own O(resident pages) cost. This is +/-1 s. "
        + "It is the LAST 1s sample at which RSS stood at its pre-release high: not the first "
        + "sample below it, and not the first time that high was reached, because a plateau can "
        + "run for hours and dating the onset from when the CLIMB stopped would point a search "
        + "at an arbitrary quiet instant. "
        + "ABSENT until an episode is observed, deliberately -- a 0 is epoch 1970 and makes "
        + "time() - this read as 56 years of staleness. NOT an alert source.",
      registers: [registry],
    });
    processRssReleaseLastDetectedTimestamp = new Gauge({
      name: PROCESS_RSS_RELEASE_LAST_DETECTED_TIMESTAMP_METRIC,
      help:
        "Unix time at which the most recent drawdown first crossed the 64 MiB detection "
        + "threshold (PEN-3314). READ IT WITH "
        + PROCESS_RSS_RELEASE_LAST_ONSET_TIMESTAMP_METRIC
        + ": the gap between them is the time taken to shed a FIXED number of bytes, so it is "
        + "comparable across episodes, and it is what tells the two measured shapes apart. ~1 s "
        + "apart is a step that completed inside one scrape; minutes apart is the ~15 minute, "
        + "3.3 GB drain. A reader holding only the detection instant cannot distinguish them and "
        + "would align evidence against the wrong end of a 15 minute window. "
        + "ABSENT until an episode is observed. NOT an alert source.",
      registers: [registry],
    });
    processRssReleaseLastBytes = new Gauge({
      name: PROCESS_RSS_RELEASE_LAST_BYTES_METRIC,
      help:
        "Peak-to-trough size of the most recent RSS release episode, in bytes (PEN-3314). "
        + "Grows while a drain is still deepening, so it is the episode's running total rather "
        + "than its value at detection -- max_over_time() gives the largest release a process "
        + "has seen. ABSENT until an episode is observed. NOT an alert source.",
      registers: [registry],
    });
    processRssReleaseSamples = new Gauge({
      name: PROCESS_RSS_RELEASE_SAMPLES_METRIC,
      help:
        "Samples the 1s RSS release sampler has folded in over this process's life (PEN-3314). "
        + "The qualifier WITHOUT WHICH "
        + PROCESS_RSS_RELEASE_EVENTS_METRIC
        + " cannot be read: a zero event count means 'no release past 64 MiB happened' only if "
        + "the sampler was running, and means nothing at all if it was not. "
        + "The sampler runs on the event loop and the step it exists to date STALLS the event "
        + "loop, so rate() over this series separates a quiet process from a stalled one and a "
        + "dip IS the stall, measured rather than inferred. A healthy sampler rates at ~1.0/s. "
        + "Monotonic within a process; read with rate()/increase(), never as a level. Never "
        + "published at 0 -- absent means the sampler has not ticked yet. NOT an alert source.",
      registers: [registry],
    });
    // Every one of these six is LABEL-LESS, and prom-client renders a label-less
    // gauge as `name 0` from the moment it is registered -- before anything has
    // measured anything. Each zero is a specific wrong answer: no releases ever,
    // nothing returned, two epoch-1970 timestamps that read as 56 years of
    // staleness, a zero-byte release, and a sampler that rate() reads as a
    // permanently stalled event loop. Drop them at construction so "nothing has
    // been observed yet" is ABSENT from the first scrape onward, and so that
    // property belongs to the metrics rather than to the order in which
    // `/metrics` happens to call its refreshers.
    processRssReleaseBoundBytes = new Gauge({
      name: PROCESS_RSS_RELEASE_BOUND_BYTES_METRIC,
      help:
        "The RSS release detector's own bounds, in bytes (PEN-3314). bound=threshold is the "
        + "drawdown below the running high-water mark that opens an episode -- it bounds what is "
        + "DETECTABLE: a shallower drawdown is not reported, and a release that completes and "
        + "fully refills inside one 1s sample is invisible. bound=plateau_band is how far below "
        + "the mark still counts as 'at the plateau' when stamping "
        + PROCESS_RSS_RELEASE_LAST_ONSET_TIMESTAMP_METRIC
        + " -- it bounds how LATE that stamp can be, because on a slow drain the onset lands at "
        + "the last sample still inside the band (~4 s at the measured 3.6 MB/s). The band "
        + "exists because the mark is an exact byte maximum and real RSS is noisy around a "
        + "plateau: without it one high spike pins the onset to itself for the rest of the "
        + "plateau, publishing an onset hours early. "
        + "Published rather than left to these help strings because both values are injectable "
        + "and a reader who cannot see the bound in force cannot tell a real null from an "
        + "undetectable one. NOT an alert source.",
      labelNames: ["bound"],
      registers: [registry],
    });
    processRssReleaseEvents.remove();
    processRssReleaseBytes.remove();
    processRssReleaseLastOnsetTimestamp.remove();
    processRssReleaseLastDetectedTimestamp.remove();
    processRssReleaseLastBytes.remove();
    processRssReleaseSamples.remove();
    cgroupMemoryComponentBytes = new Gauge({
      name: CGROUP_MEMORY_COMPONENT_BYTES_METRIC,
      help:
        "The worker's OWN cgroup memory charge, decomposed from cgroup v2 memory.stat "
        + "(PEN-3692). A DIFFERENT LAYER from "
        + PROCESS_MEMORY_COMPONENT_BYTES_METRIC
        + ", which partitions this process's resident footprint: this reports what the kernel "
        + "charges the whole cgroup, including slab and page cache that no process-level gauge "
        + "can see. component=slab_reclaimable is the headline -- dentry and inode cache, the "
        + "quantity node-level correlation (r=0.9802, n=672) attributed the 2026-09-25..09-28 "
        + "excursion to, when this cgroup sat 16384 B below its 10 GiB limit for a day. "
        + "component=shmem keeps an exclusion checkable: the pod's emptyDirs set no "
        + "medium: Memory, so a non-zero reading REFUTES that and is itself a finding. "
        + "NOT A PARTITION -- slab is the kernel's own total of slab_reclaimable + "
        + "slab_unreclaimable, and inactive_file/active_file/file_mapped/file_dirty/"
        + "file_writeback are all subsets of file, every one published beside its parts "
        + "rather than derived, so do not sum these and expect "
        + CGROUP_MEMORY_CURRENT_BYTES_METRIC
        + ". The file breakdown exists because page cache, not slab, led the first climb "
        + "this gauge measured; the figures and their caveats live on PEN-3692 and on "
        + "CGROUP_FILE_COMPONENT in services/cgroup-memory-metrics.ts, not in this help "
        + "string, which would go stale the next time the series is measured. Read "
        + "inactive_file for the cache the kernel gives back FIRST under pressure; "
        + "file_mapped, file_dirty and file_writeback are the part it cannot, and they "
        + "OVERLAP both each other and the active/inactive LRU counters -- a page can be "
        + "mapped AND dirty AND on the inactive list -- so they BOUND that part rather "
        + "than sum to it. THIS GAUGE CONFIRMS THE CLASS ONLY and cannot name the slab cache: cgroup v2 reports "
        + "slab_reclaimable as one scalar with no per-cache breakdown, so dentry vs inode vs "
        + "buffer_head still needs host /proc/slabinfo. An absent component means this kernel "
        + "does not report that field; absence of the whole metric means memory.stat was "
        + "unreadable or not v2-shaped, deliberately distinct from a measured zero -- a flat "
        + "slab_reclaimable 0 is exactly the reading that would be cited as refuting PEN-3692. "
        + "NOT an alert source: detection is the PaperclipWorkerCgroupNearMemoryMax rule.",
      labelNames: ["component"],
      registers: [registry],
    });
    cgroupMemoryCurrentBytes = new Gauge({
      name: CGROUP_MEMORY_CURRENT_BYTES_METRIC,
      help:
        "cgroup v2 memory.current -- the charge the kernel actually enforces against "
        + CGROUP_MEMORY_MAX_BYTES_METRIC
        + " (PEN-3692). Read with "
        + CGROUP_MEMORY_PEAK_BYTES_METRIC
        + ", which catches the excursions between scrapes that this one misses. Absent rather "
        + "than 0 when unreadable.",
      registers: [registry],
    });
    cgroupMemoryMaxBytes = new Gauge({
      name: CGROUP_MEMORY_MAX_BYTES_METRIC,
      help:
        "cgroup v2 memory.max -- the hard limit, for headroom against "
        + CGROUP_MEMORY_CURRENT_BYTES_METRIC
        + " (PEN-3692). ABSENT when the cgroup is unlimited (memory.max is the literal string "
        + "max), never 0 and never +Inf: both of those render as a usable number in a "
        + "current/max ratio and silently produce a wrong one, where an absent series makes the "
        + "expression return no data. Raising this limit is NOT the remedy for PEN-3692 -- "
        + "reclaimable cache grows to fill whatever headroom exists, so a larger limit buys a "
        + "longer climb to the same wedged state.",
      registers: [registry],
    });
    cgroupMemoryPeakBytes = new Gauge({
      name: CGROUP_MEMORY_PEAK_BYTES_METRIC,
      help:
        "cgroup v2 memory.peak -- the kernel-maintained high-water mark of "
        + CGROUP_MEMORY_CURRENT_BYTES_METRIC
        + " (PEN-3692). THE FIELD THAT SURVIVES AN EXCURSION EVERY SCRAPE MISSED, which is the "
        + "measured failure mode here: cAdvisor scrapes at 30s and a 15-min evaluation step "
        + "sees 1 sample in 30. Demonstrated incidentally on the authoring pod -- "
        + "memory.current 2.60 GB against a peak of 3.88 GB, a 1.28 GB excursion no sampled "
        + "series recorded. Monotonic within one cgroup's life, so read it as a LEVEL and never "
        + "with rate(); on pod replacement it goes absent and reappears low rather than "
        + "stepping down. Absent rather than 0 when unreadable.",
      registers: [registry],
    });
    // Same reasoning as processHeapPeakSamples above: prom-client publishes a
    // LABEL-LESS gauge as `name 0` from registration, before anything has been
    // measured. Here that zero is actively misleading in three different ways --
    // a zero-byte limit, a cgroup charging nothing, and a high-water mark of
    // nothing ever -- and the max one additionally poisons any current/max ratio.
    // Drop them at construction so "not measurable" is ABSENT from the first
    // scrape onward, independent of the order `/metrics` calls its refreshers in.
    cgroupMemoryCurrentBytes.remove();
    cgroupMemoryMaxBytes.remove();
    cgroupMemoryPeakBytes.remove();
    agentStartLockHeldSeconds = new Gauge({
      name: AGENT_START_LOCK_HELD_SECONDS_METRIC,
      help:
        "Seconds the per-agent queued-run dispatch start lock has currently been held (PEN-3305). "
        + "A section that never settles holds its agent's lock until the PEN-3328 abort fires at 4h "
        + "and that agent silently stops dispatching in the meantime -- while still reading "
        + "status=idle, errorReason=null, orgChainHealth=healthy. Series exist only while a lock is "
        + "held, so absence means no hold, not a zero-length one. Holds of minutes to a couple of "
        + "hours are routine and settle on their own (worst measured 8073s), so this is NOT "
        + "near-empty in normal operation and tens of seconds is not a wedge; past the 4h abort "
        + "boundary is. Per-pod, because the lock is per-process.",
      labelNames: ["agent_id"],
      registers: [registry],
    });
    agentStartLockAbortedTotal = new Counter({
      name: AGENT_START_LOCK_ABORTED_METRIC,
      help:
        "Queued-run dispatch sections cancelled for holding the per-agent start lock past its 4h "
        + "abort budget (PEN-3328). Counterpart to " + AGENT_START_LOCK_HELD_SECONDS_METRIC + ", which "
        + "cannot answer this: a cancelled section releases its lock, so its gauge series "
        + "disappears and the event leaves no durable trace. The budget clears the observed "
        + "settling tail (worst hold that released on its own: 8073s), so any non-zero rate means "
        + "something inside dispatch stopped responding rather than merely ran slow. This counts the "
        + "abort, not its outcome: if the cancellation did NOT land, the agent is still wedged and "
        + "the gauge above keeps reporting it -- that condition is the gauge's job, not a label "
        + "here. Per-pod, because the lock is per-process. Seeded at 0 by "
        + "seedAgentStartLockAbortedSeries when an agent takes the lock, so a series exists before "
        + "its first event and the first abort reads as a 0->1 transition: `increase()` takes "
        + "last-first, so a series born at 1 would evaluate to 0 forever and the alert would never "
        + "fire. A 0 here therefore means \"this agent dispatched on this pod and was never "
        + "aborted\", which is the healthy reading, NOT a missing metric.",
      labelNames: ["agent_id"],
      registers: [registry],
    });
    duplicateDispatchSuppressedTotal = new Counter({
      name: HEARTBEAT_DUPLICATE_DISPATCH_SUPPRESSED_METRIC,
      help:
        "Queued heartbeat runs cancelled as duplicate_dispatch_suppressed because another run for "
        + "the same issue reads in-flight (BLO-46812). Counts landed cancels only, so it should match "
        + "a DB count of heartbeat_runs with error_code='duplicate_dispatch_suppressed'. Mixes benign "
        + "same-tick wake dedupes with stale-running losses, so do not alert on raw non-zero; a rise "
        + "alongside start-lock reap timed_out may indicate a stale running row cost a dispatch.",
      registers: [registry],
    });
    agentStartLockPhaseSeconds = new Gauge({
      name: AGENT_START_LOCK_PHASE_SECONDS_METRIC,
      help:
        "Seconds the per-agent queued-run dispatch start lock has been in its current phase "
        + "(BLO-36922). Names the await a held section is sitting in; pairs with "
        + AGENT_START_LOCK_HELD_SECONDS_METRIC
        + ". A phase age close to the hold age means the section never left that phase. Series "
        + "exist only while a lock is held, so absence means no hold. Per-pod, like its companion.",
      labelNames: ["agent_id", "phase"],
      registers: [registry],
    });
    externalRuntimeReservationsReleasePending = new Gauge({
      name: EXTERNAL_RUNTIME_RESERVATIONS_RELEASE_PENDING_METRIC,
      help:
        "Reservations confirmed releasable (Job gone/terminal) that reconciliation still had "
        + "not cleared as of the last pass. 0 in steady state; sustained non-zero means "
        + "reconciliation itself is failing (BLO-21460).",
      registers: [registry],
    });
    externalRuntimeReservationReleasePendingOldestAge = new Gauge({
      name: EXTERNAL_RUNTIME_RESERVATION_RELEASE_PENDING_OLDEST_AGE_METRIC,
      help: "Age in seconds of the oldest reservation counted by " + EXTERNAL_RUNTIME_RESERVATIONS_RELEASE_PENDING_METRIC + ".",
      registers: [registry],
    });
    environmentLeasesOrphanedActive = new Gauge({
      name: ENVIRONMENT_LEASES_ORPHANED_ACTIVE_METRIC,
      help:
        "Ephemeral environment leases still 'active' whose heartbeat run is already terminal. "
        + "0 in steady state; sustained non-zero means lease release did not run for that run "
        + "(BLO-21460).",
      registers: [registry],
    });
    environmentLeasesOrphanedOldestAge = new Gauge({
      name: ENVIRONMENT_LEASES_ORPHANED_OLDEST_AGE_METRIC,
      help: "Age in seconds of the oldest lease counted by " + ENVIRONMENT_LEASES_ORPHANED_ACTIVE_METRIC + ".",
      registers: [registry],
    });
    orphanedRuntimeResourceMetricsRefreshSuccess = new Gauge({
      name: ORPHANED_RUNTIME_RESOURCE_METRICS_REFRESH_SUCCESS_METRIC,
      help:
        "1 when the orphaned runtime-resource backlog refresh (release-pending reservations "
        + "and orphaned environment leases) completed, otherwise 0. Guards against the four "
        + "backlog gauges holding a stale healthy 0 when the preceding sweep threw (BLO-21460).",
      registers: [registry],
    });
    orphanedRuntimeResourceMetricsRefreshSuccess.set(0);
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
    workspaceReuseRefusalWindow = new Gauge({
      name: WORKSPACE_REUSE_REFUSAL_WINDOW_METRIC,
      help:
        "Count of managed-checkout refusals in the recent window for a project workspace, bucketed "
        + "by a body-derived failure class (PEN-3633). Bucketed on the error BODY and not on "
        + "error_code because every refusal in this class books as `setup_failed`, which cannot "
        + "separate an origin mismatch from a failed git probe nor either from unrelated setup "
        + "failures. Deliberately a reset-then-set gauge rather than a counter: a labelled counter "
        + "is born at its first increment, so increase() over it is permanently silent for the "
        + "FIRST episode on a given project_workspace_id -- exactly the case this measures. An "
        + "absent series therefore means 'no refusals in the window' unambiguously, and the alert "
        + "is a >= threshold that absence can never satisfy. project_workspace_id is unbounded; "
        + "failure_class is a closed four-value set, so the pair's cardinality is bounded by the "
        + "number of project workspaces actually refusing right now, which is 0 when healthy.",
      labelNames: ["project_workspace_id", "failure_class"],
      registers: [registry],
    });
    workspaceReuseRefusalMetricsRefreshSuccess = new Gauge({
      name: WORKSPACE_REUSE_REFUSAL_METRICS_REFRESH_SUCCESS_METRIC,
      help:
        "1 when the most recent workspace-reuse-refusal database sweep completed before metrics "
        + "exposition; 0 when it failed, so a stale snapshot cannot be read as 'this project "
        + "stopped refusing'.",
      registers: [registry],
    });
    workspaceReuseRefusalMetricsRefreshSuccess.set(0);
    projectCheckoutOriginMismatch = new Gauge({
      name: PROJECT_CHECKOUT_ORIGIN_MISMATCH_METRIC,
      help:
        "1 while a project checkout's actual git origin disagrees with its project workspace's "
        + "repo_url, observed on a timer rather than per-run at dispatch (PEN-4188). Both sides are "
        + "normalised to lowercased owner/repo before comparison, and the origin is read with "
        + "`git config --get remote.origin.url` and never `git remote -v`, because the shared "
        + "/paperclip/.gitconfig carries an `insteadOf` rule that rewrites our org's https GitHub "
        + "prefix to SSH at transport time -- a verbatim comparison would report a mismatch on "
        + "every healthy checkout in the estate. (The org name is spelled out in the runbook, not "
        + "here: metrics help is asserted free of it, as a proxy for unbounded task keys leaking "
        + "into labels -- see the BLO-30623 guard in metrics-service.test.ts.) "
        + "Reset-then-set, so an absent series means 'this checkout agrees' -- but ONLY when "
        + "paperclip_project_checkout_origin_reconcile_compared is non-zero; alert on the pair. The "
        + "three labels are functionally dependent (workspace determines project determines "
        + "company), so cardinality is that of project_workspace_id alone, which is 0 when healthy; "
        + "company_id and project_id are carried so the page routes without a lookup.",
      labelNames: ["project_workspace_id", "company_id", "project_id"],
      registers: [registry],
    });
    projectCheckoutOriginReconcileCompared = new Gauge({
      name: PROJECT_CHECKOUT_ORIGIN_RECONCILE_COMPARED_METRIC,
      help:
        "Project checkouts whose git origin was successfully read and compared on the last "
        + "reconcile pass (PEN-4188). The positive control for the mismatch gauge: zero mismatches "
        + "is only evidence of health when this is non-zero. Excludes workspaces whose checkout "
        + "directory does not exist (an unprovisioned project) and those whose origin could not be "
        + "read at all.",
      registers: [registry],
    });
    projectCheckoutOriginReconcileCompared.set(0);
    projectCheckoutOriginReconcileMetricsRefreshSuccess = new Gauge({
      name: PROJECT_CHECKOUT_ORIGIN_RECONCILE_METRICS_REFRESH_SUCCESS_METRIC,
      help:
        "1 when the most recent project-checkout origin reconcile pass completed; 0 when it "
        + "failed, so a stale snapshot cannot be read as 'every checkout still agrees'.",
      registers: [registry],
    });
    projectCheckoutOriginReconcileMetricsRefreshSuccess.set(0);
    approvalsPending = new Gauge({
      name: APPROVALS_PENDING_METRIC,
      help:
        "Board approvals currently in status 'pending', labeled by bounded approval type "
        + "(BLO-29850). `revision_requested` is excluded deliberately: that card is back in the "
        + "REQUESTER's court to resubmit or withdraw, so counting it would attribute a requester "
        + "backlog to board unresponsiveness. Every known approval type is seeded with 0 on each "
        + "refresh, so a drained type -- and an empty queue -- reads back an explicit 0 rather than "
        + "an absent series or a frozen stale value. This gauge is the "
        + "alert's GATE, never its trigger -- depth alone is a staffing opinion; see "
        + APPROVAL_LAST_DECISION_TIMESTAMP_METRIC + " for the fault signal. Labelled by company_id "
        + "and requester ('agent' when requested_by_agent_id is set, else 'board'); the type seed "
        + "covers every (company_id, requester) pair with any approval history (BLO-48410).",
      labelNames: ["type", "company_id", "requester"],
      registers: [registry],
    });
    approvalOldestPendingAge = new Gauge({
      name: APPROVAL_OLDEST_PENDING_AGE_METRIC,
      help:
        "Age in seconds of the oldest still-'pending' board approval, labeled by bounded approval "
        + "type (BLO-29850). Slow-burn companion to the staleness alert: a queue being served at a "
        + "healthy rate can still strand one card forever, which the last-decision timestamp alone "
        + "cannot see. Reset-then-set every refresh; a type with nothing pending has no series here "
        + "(its " + APPROVALS_PENDING_METRIC + " reads 0), because 0 would read as a card filed this "
        + "instant. Labelled by company_id + requester like " + APPROVALS_PENDING_METRIC + ".",
      labelNames: ["type", "company_id", "requester"],
      registers: [registry],
    });
    approvalLastDecisionTimestamp = new Gauge({
      name: APPROVAL_LAST_DECISION_TIMESTAMP_METRIC,
      help:
        "Unix timestamp (seconds) of the most recent BOARD decision on an approval -- "
        + "approved/rejected/revision_requested only (BLO-29850). `withdrawn` and `cancelled` are "
        + "excluded because they are requester-side cleanup: a burst of agents retiring their own "
        + "moot cards drains the pending count without the board deciding anything, and a "
        + "depth-only metric scores that as progress. Excluding them here is what makes "
        + "`time() - <this>` a true service-liveness signal. A revision request is also read from "
        + "the append-only activity log, because the requester's resubmit/withdraw erases it from "
        + "the approval row. Labelled by company_id + requester (BLO-48410). Every "
        + "(company_id, requester) pair with any approval history is emitted, at 0 when it has never "
        + "been decided, so a never-served channel reads as maximally stale instead of dropping out "
        + "of the vector; alerts gate on " + APPROVAL_QUEUE_METRICS_REFRESH_SUCCESS_METRIC
        + " so a failed refresh is not read as either.",
      labelNames: ["company_id", "requester"],
      registers: [registry],
    });
    approvalQueueMetricsRefreshSuccess = new Gauge({
      name: APPROVAL_QUEUE_METRICS_REFRESH_SUCCESS_METRIC,
      help:
        "1 when the most recent approval-queue database refresh completed before metrics "
        + "exposition; 0 when it failed, so a stale pending count cannot be read as a fresh empty "
        + "queue. Silence is not health: this gauge is what separates 'measured nothing pending' "
        + "from 'failed to measure'.",
      registers: [registry],
    });
    approvalQueueMetricsRefreshSuccess.set(0);
    acceptedInteractionOutcome = new Gauge({
      name: ACCEPTED_INTERACTION_OUTCOME_METRIC,
      help:
        "Accepted issue-thread confirmations by outcome-tracking bucket (PEN-4409): `observed` "
        + "(the agent-declared outcome has been observed to have happened), `unobserved` (declared "
        + "but not observed), `untracked` (the acceptance declared no outcome at all, so nothing "
        + "can ever check it). The three are EXHAUSTIVE over accepted confirmations and all three "
        + "are always emitted, including `untracked` -- filtering it would make this series read "
        + "clean by excluding exactly the population the issue measured. Every ambiguity resolves "
        + "to `unobserved`: an unrecognised outcome kind, an unresolvable reference, or a merge "
        + "this installation holds no record of all count there, because a false alarm costs a "
        + "look while a false clear is worse than silence.",
      labelNames: ["bucket"],
      registers: [registry],
    });
    acceptedInteractionOutcomeOldestAge = new Gauge({
      name: ACCEPTED_INTERACTION_OUTCOME_OLDEST_AGE_METRIC,
      help:
        "Seconds since acceptance of the OLDEST accepted confirmation in each outcome bucket "
        + "(PEN-4409). This is the series an alert thresholds -- 'unobserved after N hours' is "
        + "`" + ACCEPTED_INTERACTION_OUTCOME_OLDEST_AGE_METRIC + "{bucket=\"unobserved\"} > N`, "
        + "which keeps N in the alert where it can be tuned instead of baking it into the "
        + "population. Reset-then-set; an empty bucket has NO series here rather than 0, because 0 "
        + "would read as an acceptance made this instant. Its "
        + ACCEPTED_INTERACTION_OUTCOME_METRIC + " reads an explicit 0 alongside, so the absence is "
        + "unambiguous. One series per (bucket, company_id) (BLO-48606): the card belongs to "
        + "one tenant, so the alert must group by company_id to page the tenant that can act "
        + "on it, and so one company's moot card cannot mask another company's.",
      labelNames: ["bucket", "company_id"],
      registers: [registry],
    });
    acceptedInteractionOutcomeRecent = new Gauge({
      name: ACCEPTED_INTERACTION_OUTCOME_RECENT_METRIC,
      help:
        "Accepted issue-thread confirmations per outcome bucket whose acceptance falls inside "
        + "the sweep's trailing window (PEN-4409, default 7d). This is the ADOPTION series, and "
        + "the reason it exists is that `" + ACCEPTED_INTERACTION_OUTCOME_METRIC + "` and "
        + "`" + ACCEPTED_INTERACTION_OUTCOME_OLDEST_AGE_METRIC + "` are both all-time. Every "
        + "acceptance filed before the feature shipped is permanently `untracked` and cannot "
        + "acquire a declaration retroactively, so the all-time oldest untracked age is already "
        + "past any threshold on the first tick after deploy and stays there no matter how "
        + "completely filing agents adopt `expectedOutcome` -- it measures the deploy date, not "
        + "adoption. The untracked SHARE of this windowed count is the thing adoption actually "
        + "moves, so that is what the untracked alert thresholds.",
      labelNames: ["bucket"],
      registers: [registry],
    });
    acceptedInteractionOutcomeMetricsRefreshSuccess = new Gauge({
      name: ACCEPTED_INTERACTION_OUTCOME_METRICS_REFRESH_SUCCESS_METRIC,
      help:
        "1 when the most recent accepted-interaction outcome sweep completed; 0 when it failed. "
        + "On failure the bucket gauges keep their last values rather than being zeroed, because "
        + "an all-zero report reads as 'every acceptance has been acted on' -- the one wrong "
        + "answer this sweep exists to prevent. Alerts on the bucket series must gate on this.",
      registers: [registry],
    });
    acceptedInteractionOutcomeMetricsRefreshSuccess.set(0);
    interactionPayloadUnrecognizedKey = new Counter({
      name: INTERACTION_PAYLOAD_UNRECOGNIZED_KEY_METRIC,
      help:
        "Count of top-level interaction payload keys this server did not recognise and "
        + "therefore DROPPED while still creating the card (PEN-4445). Lenient parsing is "
        + "deliberate -- rejecting the create during a tool-schema-ahead-of-server window "
        + "would mean the human-decision card is never filed at all -- so this counter, not a "
        + "4xx, is how that skew becomes visible. A non-zero value is EITHER agents carrying a "
        + "newer tool schema than this deployment OR a misspelled field name; the two are "
        + "indistinguishable from here and both deserve the same look. payload_key is the "
        + "field that evaporated. payload_key='" + UNRECOGNIZED_PAYLOAD_KEY_MALFORMED + "' is a "
        + "key name that was not identifier-shaped, and '" + UNRECOGNIZED_PAYLOAD_KEY_OVERFLOW
        + "' is this process past its distinct-key budget -- in both cases the count is still "
        + "real and only the per-key split is lost. Counted once the card is CREATED, so a "
        + "rejected or unauthorized request contributes nothing.",
      labelNames: ["interaction_kind", "payload_key"],
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
    // "nothing was lost" and "we cannot tell". 7 states x 8 reasons = 56
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
    githubApiRefusals = new Counter({
      name: GITHUB_API_REFUSALS_METRIC,
      help:
        "Count of GitHub API responses that REFUSED a control-plane call, by why (PEN-3852). "
        + "reason='rate_limited' is primary installation-budget exhaustion (403/429 with "
        + "x-ratelimit-remaining: 0) — the condition PEN-3776 measured refusing an ordinary "
        + "agent seat's reads while monitoring exporters swept the same shared installation. "
        + "reason='secondary_limit' is GitHub's separate abuse-detection mechanism, which is "
        + "independent of the hourly budget and needs the caller to slow down rather than more "
        + "capacity. reason='forbidden' is a 403 that is a PERMISSION problem and no kind of "
        + "quota — counted so it can never be read as budget exhaustion, which is the merge "
        + "that makes a 403 rate uninterpretable. Read against the denominator "
        + GITHUB_API_REQUESTS_METRIC
        + ": zero refusals is only evidence while that counter is climbing, because an absent "
        + "or dead instrument renders the same zero. All three children are present from "
        + "process start for that reason.",
      labelNames: ["reason"],
      registers: [registry],
    });
    // Zero-initialize all three reasons. Load-bearing, not tidiness: PEN-3852's
    // acceptance test asserts that quota refusals are ZERO over a multi-day
    // window, and prom-client does not create a labelled child until its first
    // `inc()`. A counter touched only on a refusal therefore publishes NO
    // series in the healthy case, `sum(increase(...))` over no series is an
    // empty vector, and the criterion neither passes nor fails — it returns
    // nothing, which is the exact defect that made the row's original
    // done-when #4 unsatisfiable. An instrument built to prove "zero refusals"
    // must render zero when there are zero. Same reasoning as the review-posted
    // counter above. 3 constant-zero series.
    for (const reason of KNOWN_GITHUB_API_REFUSAL_REASONS) {
      githubApiRefusals.inc({ reason }, 0);
    }
    githubApiRequests = new Counter({
      name: GITHUB_API_REQUESTS_METRIC,
      help:
        "Count of GitHub API calls this process ATTEMPTED, incremented before the request "
        + "leaves (PEN-3852). The denominator and liveness signal for "
        + GITHUB_API_REFUSALS_METRIC
        + " — a zero refusal count means 'GitHub refused nothing' only while this is climbing, "
        + "and means 'the instrument is dead or absent' when it is flat. Counted per attempt "
        + "rather than per response so a call that never resolves (DNS, connect refused, the "
        + "30s fetch deadline) still advances it; a denominator that only moved on success "
        + "would freeze during exactly the outage it is being read through. Covers every "
        + "GitHub call this process makes, including GitHub Enterprise hosts, and is NOT "
        + "labelled by host or installation: this is egress liveness for this process, not a "
        + "per-installation budget ledger.",
      registers: [registry],
    });
    // Explicit, though prom-client materializes an unlabelled counter at
    // registration: the zero is what the denominator MEANS here, so it is
    // asserted at the source rather than inherited from library behaviour that
    // a future version is free to change. 1 constant-zero series.
    githubApiRequests.inc(0);
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
    githubWebhookDelivery = new Counter({
      name: GITHUB_WEBHOOK_DELIVERY_METRIC,
      help:
        "Count of inbound GitHub webhook deliveries at the receiver, labeled by bounded "
        + "event and outcome (BLO-39378). One increment per delivery, whatever the event "
        + "and whatever the outcome -- including signature rejections, which are counted "
        + "because a rotated secret presents as healthy delivery volume with nothing "
        + "accepted. Unlike " + GITHUB_WORKFLOW_RUN_CONCLUSION_METRIC + ", which counts "
        + "only what a healthy webhook delivered, the FLATLINING of this counter is "
        + "itself the fault: `sum(increase(...[window])) == 0` says 'we received zero "
        + "deliveries of any kind', which is actionable because the fleet pushes "
        + "continuously. Zero-initialized across the full event x outcome grid on every "
        + "replica so that `== 0` evaluates rather than returning an empty vector -- do "
        + "NOT alert on absent() here, which that zero-init deliberately defeats. "
        + "`event` is normalized against a compile-time allowlist because it originates "
        + "in the x-github-event header of a request counted before its signature is "
        + "verified; cardinality is fixed at 9 x 3 regardless of fleet growth.",
      labelNames: ["event", "outcome"],
      registers: [registry],
    });
    for (const event of [...KNOWN_GITHUB_WEBHOOK_EVENTS, UNKNOWN_GITHUB_WEBHOOK_EVENT]) {
      for (const outcome of KNOWN_GITHUB_WEBHOOK_OUTCOMES) {
        githubWebhookDelivery.inc({ event, outcome }, 0);
      }
    }
    routineLastDoneFireAge = new Gauge({
      name: ROUTINE_LAST_DONE_FIRE_AGE_METRIC,
      help:
        "Seconds since the most recent COMPLETED fire of an active, schedule-triggered routine "
        + "(BLO-32638). A routine's receipt that it took a measurement is a `done` issue row, "
        + "which nothing else on this surface can see -- so a silently-disabled routine and a "
        + "healthy quiet one are identical to Prometheus without this. Distinct from "
        + ROUTINE_DISPATCH_METRIC
        + ", which cannot see this at any age: every label there requires a fire to have "
        + "ATTEMPTED dispatch, so none move when fires stop completing, and none are emitted "
        + "at all when a fire dispatches fine and its run then dies quietly. A routine that has "
        + "NEVER completed a fire ages from routines.created_at rather than going absent -- an "
        + "absent series and `nothing is wrong` render identically on a dashboard, which is the "
        + "exact failure this gauge exists to close. Refreshed on the scrape-metrics collector "
        + "tick from a live MAX(routine_runs.completed_at) WHERE status='completed' aggregate, "
        + "and reset-then-set every refresh (see setRoutineFireGapMetrics). Alert against its "
        + "companion " + ROUTINE_FIRE_INTERVAL_METRIC + " rather than a fixed threshold.",
      labelNames: ["routine_id", "company_id"],
      registers: [registry],
    });
    routineLastFireStartAge = new Gauge({
      name: ROUTINE_LAST_FIRE_START_AGE_METRIC,
      help:
        "Seconds since the most recent fire of an active, schedule-triggered routine that "
        + "DISPATCHED ITS OWN execution issue (PEN-4647). Sibling of "
        + ROUTINE_LAST_DONE_FIRE_AGE_METRIC
        + ", and the two answer different questions: that one ages a COMPLETION, this one ages a "
        + "FIRING. They diverge precisely in the failure mode that matters -- a wedged, "
        + "long-open execution row eats the firings behind it, and when that row finally reaches "
        + "`done` the completion age RESETS TO ~0 while no new fire has occurred, so an alert "
        + "reading completion age alone goes green mid-outage. Measured on routine "
        + "b3ba3b33 (`0 9 * * 1-5`): the completion gauge fell 278.34h -> 0.06h at "
        + "2026-10-19T10:00Z and 23.56h -> 0.44h at 2026-10-20T10:00Z, neither a firing, while "
        + "the next real execution row did not land until 2026-10-21T09:00Z. This gauge does not "
        + "move on either of those. Alert on the MAX of the pair: completion age alone fails open "
        + "on the wedge, and firing age alone is blind to fires that dispatch and then die before "
        + "reaching `done`.\n\n"
        + "A `skipped` or `coalesced` run is NOT a firing for this purpose and does not reset it: "
        + "both mean the fire stood down behind an already-open row, which is the loss itself. "
        + "Both nonetheless carry a linked_issue_id (the row they stood down behind), so the age "
        + "comes off runs that are neither -- see the 0266 partial index. A dispatch that failed "
        + "before creating its issue carries no link and likewise does not count. A routine that "
        + "has NEVER dispatched ages from routines.created_at rather than going absent, for the "
        + "reason on the sibling gauge: absent and `nothing is wrong` render identically.",
      labelNames: ["routine_id", "company_id"],
      registers: [registry],
    });
    routineFireInterval = new Gauge({
      name: ROUTINE_FIRE_INTERVAL_METRIC,
      help:
        "The LONGEST gap in seconds between consecutive scheduled fires of an active, "
        + "schedule-triggered routine (BLO-32638), sampled from the trigger's own cron by "
        + "deriveRoutineFireGapsMs -- the SAME sample routine dispatch bounds its lock with, so "
        + "the alert threshold and the dispatch bound cannot drift apart when a cron is edited. "
        + "Dispatch takes that sample's shortest gap; this takes its longest, because on an "
        + "irregular cron (`0 15 * * 1-5`) the shortest gap would page on every healthy weekend "
        + "gap. The raw gap, not the jitter-shaved dispatch horizon. Exists so one relative rule ("
        + ROUTINE_LAST_DONE_FIRE_AGE_METRIC + " > 2 * this) covers every routine instead of a "
        + "hand-maintained per-routine threshold. A paused routine, and a routine whose only "
        + "triggers are webhook/api, emit NO series here: with no right-hand side the alert's "
        + "vector match drops them, which is the correct behaviour rather than a special case. "
        + "Where several enabled schedule triggers exist the MINIMUM of their longest gaps wins: "
        + "fires arrive from all of them, so that is still an upper bound on any healthy gap.",
      labelNames: ["routine_id", "company_id"],
      registers: [registry],
    });
    routineFireGapMetricsRefreshSuccess = new Gauge({
      name: ROUTINE_FIRE_GAP_METRICS_REFRESH_SUCCESS_METRIC,
      help:
        "1 when the most recent routine-fire-gap database refresh completed before metrics "
        + "exposition; 0 when it failed, so stale fire ages cannot be read as fresh. A failed "
        + "refresh deliberately leaves the previous snapshot in place rather than publishing "
        + "zeros: a synthetic 0 age reads as the healthy state and would hide exactly the "
        + "silently-disabled routine this family exists to catch. Separate from "
        + QUEUED_RUN_AGE_METRICS_REFRESH_SUCCESS_METRIC
        + " because the two refreshes run different aggregates against different tables and "
        + "can fail independently.",
      registers: [registry],
    });
    routineFireGapMetricsRefreshSuccess.set(0);
    queuedRunOldestAge = new Gauge({
      name: QUEUED_RUN_OLDEST_AGE_METRIC,
      help:
        "Age in seconds of the oldest `queued` heartbeat run for an agent (BLO-21116). "
        + "Refreshed on scrape from a live MIN(coalesce(queued_at, created_at)) aggregate, not a Prometheus "
        + "`for:` clause -- same reasoning as " + AGENT_WAKEUP_TERMINAL_FAILED_OLDEST_AGE_METRIC
        + ": `for:` measures how long the alert expression has been true, not the age of "
        + "any one row. Reset-then-set every refresh (see setQueuedRunOldestAgeMetrics) so an "
        + "agent whose queue drains to empty reads back an explicit 0 rather than a frozen "
        + "stale value or an absent series. Labeled by bounded agent_id, plus the "
        + "agent_name and company_id that identity determines (PEN-4280) so a consumer "
        + "can route and attribute without a second lookup.",
      labelNames: ["agent_id", "agent_name", "company_id"],
      registers: [registry],
    });
    queuedRunOldestClaimableAge = new Gauge({
      name: QUEUED_RUN_OLDEST_CLAIMABLE_AGE_METRIC,
      help:
        "Age in seconds of the oldest `queued` heartbeat run for an agent that dispatch "
        + "can actually claim (PEN-4280/PEN-4293). Same population as "
        + QUEUED_RUN_OLDEST_AGE_METRIC
        + " minus runs whose issue is not dependency-ready, which the dispatcher "
        + "deliberately refuses to let age forward (`dispatchRank` ranks them below every "
        + "routine row; `claimQueuedRun`'s cancel-on-blocked screen fires only on a claim "
        + "that therefore never arrives). Their wait is undispatchable work, not dispatch "
        + "latency, so the unfiltered gauge reads a healthy dispatcher as starvation. Both "
        + "gauges are published: the ORIGINAL is the one existing consumers read, and the "
        + "DIFFERENCE between them is how much queued work is structurally unclaimable. "
        + "Same reset-then-set zero-floor convention as "
        + QUEUED_RUN_OLDEST_AGE_METRIC
        + " -- every known agent emits an explicit 0 rather than an absent series. "
        + "Carries agent_name and company_id for the reason given on "
        + QUEUED_RUN_OLDEST_AGE_METRIC
        + ": onprem-k8s' per-agent queue alert routes per tenant on company_id and "
        + "renders agent_name, so a repoint onto an agent_id-only series would "
        + "silently mis-route and lose attribution (PEN-4280).",
      labelNames: ["agent_id", "agent_name", "company_id"],
      registers: [registry],
    });
    deferredIssueExecutionWakeOldestAge = new Gauge({
      name: DEFERRED_ISSUE_EXECUTION_WAKE_OLDEST_AGE_METRIC,
      help:
        "Age in seconds since `requested_at` of the oldest agent_wakeup_requests row still "
        + "sitting in status='deferred_issue_execution' for an agent (PEN-3734). A wake is "
        + "parked in that status while another run holds the issue's execution lock, and it "
        + "is promoted ONLY when a run on that issue finalizes, one per finalization, with "
        + "the lock held globally across agents -- so this age is one agent's wait behind "
        + "every other agent's run ahead of it on the same row. Distinct from "
        + QUEUED_RUN_OLDEST_AGE_METRIC
        + ", which cannot see this at any age: a deferred wake deliberately creates no "
        + "heartbeat_runs row, so there is nothing for a run-table gauge to age. Refreshed "
        + "on the scrape-metrics collector tick from a live MIN(requested_at) aggregate, and "
        + "reset-then-set every refresh (see setDeferredIssueExecutionWakeOldestAgeMetrics) "
        + "so an agent with nothing deferred reads back an explicit 0 rather than a frozen "
        + "stale value or an absent series. Ages off `requested_at`, which a coalescing "
        + "wake does NOT reset, so the value is the full wait of the earliest undelivered "
        + "comment rather than of the most recent one. Labeled by bounded agent_id; the "
        + "issue id is unbounded cardinality and is logged by the refresh instead.",
      labelNames: ["agent_id"],
      registers: [registry],
    });
    deferredIssueExecutionWakeAgeMetricsRefreshSuccess = new Gauge({
      name: DEFERRED_ISSUE_EXECUTION_WAKE_AGE_METRICS_REFRESH_SUCCESS_METRIC,
      help:
        "1 when the most recent deferred-issue-execution-wake-age database refresh completed "
        + "before metrics exposition; 0 when it failed, so stale deferred-wake ages cannot be "
        + "read as fresh. Separate from " + QUEUED_RUN_AGE_METRICS_REFRESH_SUCCESS_METRIC
        + " because the two refreshes run different aggregates against different indexes and "
        + "can fail independently.",
      registers: [registry],
    });
    deferredIssueExecutionWakeAgeMetricsRefreshSuccess.set(0);
    coldInReviewIssueOldestAge = new Gauge({
      name: COLD_IN_REVIEW_ISSUE_OLDEST_AGE_METRIC,
      help:
        "Age in seconds since `last_activity_at` of the oldest `in_review` issue the "
        + "liveness classifier reports as `in_review_without_action_path` (PEN-4652) -- a "
        + "row with no live run, no scheduled monitor, no unexpired park, no queued wake, "
        + "no pending interaction or approval, no open recovery issue and no recent open "
        + "pull request. Such a row is finished work that nothing will ever come back to: "
        + "`inboxLite` excludes `in_review` by design, so no heartbeat re-picks it, and the "
        + "classifier itself renders only through the `attention=blocked` pull filter, i.e. "
        + "only when some OTHER blocked row depends on it. This gauge is a PROJECTION of "
        + "that classifier, never a second predicate -- an earlier SQL re-derivation "
        + "honoured four of its eight waiting paths and so published every approval-, "
        + "interaction- and pull-request-waiting row as cold. Reads 0 for an agent with "
        + "nothing cold rather than going absent, because an absent series and \"nothing "
        + "stuck\" render identically on a dashboard. Published from the heartbeat recovery "
        + "chain, so it exists on the workers tier only and refreshes per chain rather than "
        + "per tick; reset-then-set every refresh, so a repaired row drops the agent back "
        + "to 0 instead of freezing at its last value.",
      labelNames: ["agent_id"],
      registers: [registry],
    });
    coldInReviewIssueMetricsRefreshSuccess = new Gauge({
      name: COLD_IN_REVIEW_ISSUE_METRICS_REFRESH_SUCCESS_METRIC,
      help:
        "1 when the most recent liveness pass published "
        + COLD_IN_REVIEW_ISSUE_OLDEST_AGE_METRIC + "; 0 when the snapshot it is derived from "
        + "could not be read, so a stale cold-row age cannot be read as fresh (PEN-4652). "
        + "Note this tracks the heartbeat recovery chain, NOT the scrape-metrics collector "
        + "that carries the other refresh-success gauges in this file -- it can be 1 while "
        + "every one of those is 0, and the reverse. ⚠ A service=\"paperclip-workers\" "
        + "selector is NECESSARY BUT NOT SUFFICIENT on this series, and an alert that "
        + "stops there still pages forever. Two things make a replica read a permanent "
        + "0. First the tier: the registry is constructed everywhere and seeds this "
        + "gauge to 0, but only the workers tier runs the recovery chain, so every api "
        + "replica exports a 0 it will never refresh. Second, and the one the selector "
        + "does NOT cover: the chain is a SINGLE-LEADER process within the workers tier "
        + "too, so at any instant exactly one worker replica refreshes this gauge and "
        + "every other worker replica is also sitting at a permanent 0 while behaving "
        + "correctly. Measured 2026-10-24 against live Prometheus: "
        + "paperclip_heartbeat_recovery_chain_duration_seconds read 645s on "
        + "`paperclip-1` and 0 on `paperclip-0` -- both workers -- having been the "
        + "other way round before leadership moved at ~07:30Z, while both "
        + "`paperclip-api-*` replicas held 0 throughout. So the predicate must "
        + "AGGREGATE ACROSS REPLICAS and ask whether NO worker refreshed, e.g. `max by "
        + "(service) (<series>{service=\"paperclip-workers\"}) == 0`; any per-replica "
        + "`== 0`, scoped or not, fires on the standby. Same shape as the pre-seeded "
        + "backstop counters documented above, which were likewise measured on one "
        + "worker replica alone.",
      registers: [registry],
    });
    coldInReviewIssueMetricsRefreshSuccess.set(0);
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
    crashRecoveryCandidateIndexPresent = new Gauge({
      name: CRASH_RECOVERY_CANDIDATE_INDEX_PRESENT_METRIC,
      help:
        "1 while heartbeat_runs_crash_recovery_pending_idx is present, valid and "
        + "ready; 0 while it is absent or invalid and the periodic worker-crash "
        + "reconciliation is therefore gating itself off (BLO-21526). Migration "
        + "0226 records complete on a populated database without building this "
        + "deferred CONCURRENTLY index, and its RAISE NOTICE is swallowed by the "
        + "production client, so this gauge is the only channel that states the "
        + "index is present rather than merely staying quiet about it. Re-derived "
        + "from pg_class/pg_index every periodic scheduler tick. The series is "
        + "CLEARED, not zeroed, when the catalog probe itself fails: alert on == 0 "
        + "for a real absence and absent() for an unobservable one.",
      labelNames: ["index"],
      registers: [registry],
    });
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
        + "PLUGIN_METRIC_PROMOTABLE_TAG_KEYS, and publish under a '"
        + PLUGIN_METRIC_TAG_LABEL_PREFIX + "' prefix so a plugin tag can never "
        + "collide with a label the alerting engine assigns ('alertname' would "
        + "hard-fail rule evaluation, 'severity' would corrupt routing "
        + "silently); unpromoted tags stay on the "
        + "plugin_logs row. company_id is deliberately not a label (unbounded "
        + "per tenant). Two cardinality tiers degrade on DIFFERENT axes: past "
        + "the per-(plugin, metric) tag-value budget a write keeps its 'metric' label and "
        + "drops its promoted labels, so a rule matching metric=\"<name>\" keeps "
        + "working and sum by (metric) stays exact; only a plugin exceeding the "
        + "much tighter metric-NAME budget collapses to metric=\""
        + PLUGIN_METRIC_OVERFLOW_NAME + "\". Nothing is ever discarded.",
      labelNames: [
        "plugin_id",
        "plugin_key",
        "metric",
        ...PLUGIN_METRIC_PROMOTABLE_TAG_KEYS.map(pluginMetricTagLabel),
      ],
      registers: [registry],
    });
    pluginMetricDropped = new Counter({
      name: PLUGIN_METRIC_DROPPED_METRIC,
      help:
        "Plugin metric writes not published as-submitted, by reason "
        + "(PEN-2799): 'bad_name' (name failed shape/length validation), "
        + "'bad_value' (non-finite or negative -- ctx.metrics.write is a "
        + "counter increment), 'label_budget' (per-(plugin, metric) tag-value budget "
        + "exhausted, so the promoted labels were dropped but the increment "
        + "still landed on the metric's own series -- totals stay correct, only "
        + "the per-tag breakdown is lost), 'name_budget' (the plugin exceeded "
        + "its metric-NAME budget, so this write folded into the overflow "
        + "series), and 'value_truncated' (a promoted label value exceeded "
        + String(PLUGIN_METRIC_LABEL_VALUE_MAX_LENGTH) + " code points and was "
        + "cut to fit; the increment landed with the shortened value, and "
        + "because the combination ledger keys on what is actually published, "
        + "two values sharing that prefix collapse into one series), and "
        + "'value_sanitized' (a promoted label value carried control "
        + "characters, which were stripped before publishing -- prom-client "
        + "escapes only backslash, newline and quote, so anything else would "
        + "reach this endpoint as a raw byte). A drop is "
        + "never silent: this is the series that answers 'why is my plugin "
        + "metric missing or wrong', which otherwise required reading host "
        + "source. The 'metric' label is populated ONLY where its cardinality "
        + "is already bounded: 'label_budget', 'value_truncated' and "
        + "'value_sanitized' carry the "
        + "real name (it cleared the name budget, so it is one of at most "
        + String(PLUGIN_METRIC_NAME_BUDGET) + "), and 'name_budget' "
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
    runDispatchWait = new Histogram({
      name: RUN_DISPATCH_WAIT_METRIC,
      help:
        "Seconds from queue entry (queued_at, else created_at) until start for every heartbeat run (BLO-25024). "
        + "Observed once at the guarded queued-to-running transition, labeled only by bounded invocation_source.",
      labelNames: ["invocation_source"],
      buckets: RUN_DISPATCH_WAIT_BUCKETS_SECONDS,
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
    httpRequests = new Counter({
      name: HTTP_REQUESTS_METRIC,
      help:
        "Count of HTTP requests served by this process, labeled by matched Express route "
        + "template, method, and status code (PEN-3702). The route label is the declared "
        + "template, never a concrete URL, so path parameters do not mint series; requests "
        + `that matched no route collapse to "${HTTP_ROUTE_UNMATCHED}". A status of "0" means `
        + "the response never completed -- a client abort or an ingress timeout -- rather "
        + "than any code the server chose; it can appear on any route label. No user, "
        + "company, agent, query string, or other unbounded label is exposed.",
      labelNames: ["route", "method", "status"],
      registers: [registry],
    });
    httpEmptyListResponses = new Counter({
      name: HTTP_EMPTY_LIST_RESPONSES_METRIC,
      help:
        "Count of responses whose JSON body was a bare empty array, labeled identically to "
        + `${HTTP_REQUESTS_METRIC} (PEN-3702). A strict subset of that counter, so `
        + "empty/total is a route's empty-response rate. This is what separates "
        + '"I am broken" from "you have nothing": an empty 200 increments both families, '
        + "while a 5xx increments only the request counter, because its body is an error "
        + "envelope rather than an array. Responses that are not bare arrays are not "
        + "counted here at all.",
      labelNames: ["route", "method", "status"],
      registers: [registry],
    });
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
    agentErrorReasonAgents = new Gauge({
      name: AGENT_ERROR_REASON_AGENTS_METRIC,
      help:
        "Count of agents currently in status='error', bucketed by a bounded error_reason "
        + "label (session_unavailable | other | none) collapsed from the free-text "
        + "agents.errorReason (BLO-22498). The reason-resolved companion to "
        + AGENT_ERROR_DURATION_SECONDS_METRIC
        + ", which carries only agent_id and so cannot distinguish the BLO-18012 "
        + "'Session unavailable' condition from any unrelated errored agent. Fleet-wide and "
        + "recomputed from the committed agents table on every heartbeat scheduler tick, so "
        + "it is restart-safe and replica-invariant: aggregate across replicas with "
        + "`max by (error_reason)`, NEVER a bare sum, or a second replica doubles the count. "
        + "Every bucket publishes on every pass including empty ones, so a recovered fleet "
        + "reads an explicit 0 instead of the series vanishing -- absent and healthy are "
        + "indistinguishable on a panel, and that ambiguity is the whole failure this closes.",
      labelNames: ["error_reason"],
      registers: [registry],
    });
    agentErrorReasonOldestAge = new Gauge({
      name: AGENT_ERROR_REASON_OLDEST_AGE_METRIC,
      help:
        "Seconds the OLDEST agent in each error_reason bucket has continuously held "
        + "status='error', 0 when the bucket is empty (BLO-22498). Max-within-bucket so "
        + "BLO-18012's <=120s time-to-recovery bound is a direct single-series comparison "
        + "rather than one the panel reconstructs. Same replica-invariance and zero-fill "
        + "contract as "
        + AGENT_ERROR_REASON_AGENTS_METRIC
        + ". Inherits the updatedAt-as-proxy caveat from "
        + AGENT_ERROR_DURATION_SECONDS_METRIC
        + ": an unrelated write to a still-errored row understates the age, so this is a "
        + "lower bound on true time-in-error and can only under-report a bound breach.",
      labelNames: ["error_reason"],
      registers: [registry],
    });
    for (const bucket of KNOWN_AGENT_ERROR_REASON_BUCKETS) {
      agentErrorReasonAgents.set({ error_reason: bucket }, 0);
      agentErrorReasonOldestAge.set({ error_reason: bucket }, 0);
    }
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
    wakeRedeliverySuppressed = new Counter({
      name: WAKE_REDELIVERY_SUPPRESSED_METRIC,
      help:
        "Duplicate wake redeliveries declined by the BLO-25726 guards, labeled by which guard "
        + "declined it; cause=fence_lost counts only passes that did not deliver, so a delivered "
        + "wake whose bookkeeping write lost its lease is not counted. Non-zero is EXPECTED and "
        + "must not page: it means the crash or "
        + "concurrency window fired and the duplicate was suppressed. This is the observable "
        + "for a defect whose absence-based signal is unmeasurable -- heartbeat_runs carries no "
        + "idempotency key and its wakeupRequestId is 1:1 with runs, so a duplicate dispatch is "
        + "invisible there by construction. The alertable inversion is this staying flat while "
        + "duplicate agent runs appear.",
      labelNames: ["cause"],
      registers: [registry],
    });
    for (const cause of WAKE_REDELIVERY_SUPPRESSED_CAUSES) {
      wakeRedeliverySuppressed.inc({ cause }, 0);
    }
    heartbeatRecoveryChainSkipped = new Counter({
      name: HEARTBEAT_RECOVERY_CHAIN_SKIPPED_METRIC,
      help:
        "Scheduler ticks on which the periodic recovery chain was skipped because the "
        + "previous pass was still running (PEN-3314). Zero in steady state. A sustained "
        + "non-zero rate means the chain is outrunning heartbeatSchedulerIntervalMs; read "
        + HEARTBEAT_RECOVERY_CHAIN_INFLIGHT_METRIC + " to see by how much.",
      registers: [registry],
    });
    // Zero-initialize so a healthy worker exports an explicit 0 rather than an
    // absent series -- "no overlap" and "gate never reached" must not look alike.
    heartbeatRecoveryChainSkipped.inc(0);
    heartbeatRecoveryChainDuration = new Gauge({
      name: HEARTBEAT_RECOVERY_CHAIN_DURATION_METRIC,
      help:
        "Wall-clock duration of the last COMPLETED periodic recovery chain, in seconds "
        + "(PEN-3314). Describes the last pass to finish, so it cannot see a pass that is "
        + "overrunning now; alert on " + HEARTBEAT_RECOVERY_CHAIN_INFLIGHT_METRIC + " instead.",
      registers: [registry],
    });
    // Same reasoning as the skip counter above, and it matters more here: without
    // this, a worker whose very first chain runs long or wedges exports no series
    // at all, so an alert of the form "> heartbeatSchedulerIntervalMs" never
    // evaluates -- silent during precisely the incident it was written for.
    heartbeatRecoveryChainDuration.set(0);
    heartbeatRecoveryChainInflight = new Gauge({
      name: HEARTBEAT_RECOVERY_CHAIN_INFLIGHT_METRIC,
      help:
        "How long the currently outstanding periodic recovery chain has been running, in "
        + "seconds; 0 when none is outstanding (PEN-3314). Refreshed by a dedicated timer that "
        + "touches no database, so it stays live when pool saturation stops the heartbeat tick "
        + "from reporting. "
        + "This is the overlap alert: it crosses heartbeatSchedulerIntervalMs while the "
        + "offending pass is still running, hours before the heap ceiling is reached.",
      registers: [registry],
    });
    heartbeatRecoveryChainInflight.set(0);
    heartbeatRecoveryChainStalled = new Counter({
      name: HEARTBEAT_RECOVERY_CHAIN_STALLED_METRIC,
      help:
        "Recovery-chain passes still outstanding past the stall threshold, counted once per "
        + "stalled pass (PEN-3314/PEN-3365). Non-zero means a pass stopped settling entirely "
        + "rather than merely running slow, so EVERY recovery pass on this worker is halted. "
        + "The gate does not self-clear, so this does not resolve itself. Page on this.",
      registers: [registry],
    });
    heartbeatRecoveryChainStalled.inc(0);
    schedulerLeaseHeld = new Gauge({
      name: SCHEDULER_LEASE_HELD_METRIC,
      help:
        "1 while this process holds the named scheduler lease and runs that loop, 0 while it "
        + "does not (BLO-43292). Alert on sum by (lease) (...) != 1: zero means nobody is "
        + "running the loop, >1 means two processes both believe they lead.",
      labelNames: ["lease", "holder"] as const,
      registers: [registry],
    });
    schedulerLeaseRenewed = new Gauge({
      name: SCHEDULER_LEASE_RENEWED_METRIC,
      help:
        "Unix time of this process's last successful scheduler-lease renewal, in seconds; 0 if "
        + "it has never held the lease (BLO-43292). time() minus this is renewal age, which is "
        + "what separates a quiet leader from one that has stopped renewing.",
      labelNames: ["lease", "holder"] as const,
      registers: [registry],
    });
    // Deliberately NOT pre-seeded. Both series are labelled, so there is no
    // label set to seed without inventing a lease name; and unlike the
    // unlabelled gauges above, an absent series here is the honest reading —
    // a process that holds no lease and has never tried is not "0 held", it
    // has no opinion. The series appears on the first renew attempt, which is
    // within one renew interval of start.
    // Pre-seed every backstop series so "healthy" reads as a literal 0 rather than an
    // absent series. The gauge already did this; the counters did not, which reproduced
    // the exact silence defect BLO-29763 was opened to remove, one metric over: on a
    // freshly-started process `paperclip_backstop_sweep_completed_total` is missing for
    // any stream that has not yet completed a sweep, so AC2 ("did this loop finish a
    // sweep in the last N minutes", answerable from metrics alone) has no series to read.
    //
    // What this buys, precisely: `increase(...[2h]) == 0` now RETURNS A SAMPLE for a
    // stream that has never swept. Absent, it returned nothing and the stall was
    // undetectable. It does NOT change `depth > 0 unless increase(...) > 0` -- `> 0`
    // discards a zero-valued sample exactly as it discards an absent series, so that
    // form returns the LHS and fires either way. An alert consuming this must key on
    // `== 0` / `absent_over_time`, never on `unless ... > 0`.
    //
    // The seed is unconditional here, and the API tier registers these metrics without
    // running either loop -- so after this change every api replica exports a
    // permanently-zero completion counter. Measured 2026-09-21 on live Prometheus: the
    // gauge is present on all 3 replicas, while `paperclip_backstop_sweep_completed_total`
    // and `paperclip_backstop_candidates_skipped_total` exist on `paperclip-0`
    // (`service="paperclip-workers"`) alone -- on both `paperclip-api-*` replicas those
    // two counters are absent pre-change and read a permanent seeded 0 after it. Run
    // dispatch is already fenced on that tier (PAPERCLIP_NODE_ROLE=api, heartbeat.ts).
    //
    // Constraints on a stall alert over these series, given as mechanism rather than a
    // paste-ready predicate: two review rounds have each produced a predicate that then
    // measured wrong against live data, because correctness here turns on topology and
    // process lifetime that a code comment cannot track.
    //   1. Scope to `service="paperclip-workers"`, or it pages against a tier that
    //      legitimately never sweeps.
    //   2. The gauge and the completion counter are ONE variable with opposite sign --
    //      `setBackstopDeferredCandidates(src, result.candidateLimitSkipped)` against
    //      `if (result.candidateLimitSkipped === 0) recordBackstopSweepCompleted(src)`
    //      (recovery/service.ts). So `deferred > 0` and "no completion on that tick" are
    //      the SAME fact, not two independent signals, and ANDing them pages forever on a
    //      saturated-but-healthy stream. Corollary: NO predicate over these two series
    //      detects a stall on a permanently-saturated stream -- that needs the
    //      zero-deferred-tick fix, not an alert change.
    //   3. The seed makes a never-swept process read identical to a drained one: both
    //      counters sit at 0 until that process completes its first sweep. Sizing a
    //      `for:` around that needs the sweep CADENCE -- and the cadence is NOT the 30s
    //      scheduler tick. Neither loop is driven by that tick: both run only inside
    //      `reconcileIssueGraphLiveness`, which sits partway down the heartbeat recovery
    //      chain behind `reconcileStrandedAssignedIssues` and is gated by the
    //      `heartbeatRecoveryChainInFlight` latch (index.ts, BLO-34207/#1897). A tick
    //      that finds the chain in flight skips it silently, and the latch declaration
    //      says outright that a sweep "routinely outlives one interval". So a completion
    //      is one CHAIN COMPLETION, not one tick, and that period is a property of the
    //      chain's slowest pass and of estate size -- not of these metrics, and not of
    //      anything this file can track. Do NOT paste a `for:` constant from here.
    //   4. PRECONDITION, not reassurance: `increase(<counter>[Nh]) == 0` is only
    //      meaningful while process lifetime stays under N. Because a completion is
    //      per-chain rather than per-tick, that expression currently reads as a function
    //      of PROCESS AGE more than of sweep liveness; it is quiet today only because the
    //      pod is replaced on a shorter period than the range window. Anything that
    //      lengthens pod lifetime past N makes it fire permanently on a healthy stream.
    //      Any alert built on it must state that bound, and a `for:` shorter than the
    //      start-to-first-completion window pages on every fresh pod.
    //      Measurements behind 3-4, and the standing caveat that this cadence moves:
    //      BLO-29763. Three review rounds have each produced a predicate that then
    //      measured wrong -- a number recorded here is the thing that keeps decaying.
    //
    // Bounded: 2 sources x (1 gauge + 1 counter + 12 reasons) = 28 series.
    for (const source of BACKSTOP_SOURCES) {
      backstopDeferredCandidates.set({ source }, 0);
      backstopSweepCompleted.inc({ source }, 0);
      for (const reason of BACKSTOP_SKIP_REASONS) {
        backstopCandidatesSkipped.inc({ source, reason }, 0);
      }
    }
    isolationReaperScanned = new Counter({
      name: ISOLATION_WORKSPACE_REAPER_SCANNED_METRIC,
      help:
        "Directories the isolation-workspace reaper examined, summed over sweeps "
        + "(BLO-36814). The denominator for every other reaper series. Absent "
        + "means the reaper has not completed a sweep in this process — NOT that "
        + "it swept and found nothing; these series are deliberately not "
        + "pre-seeded so those two states stay distinguishable.",
      labelNames: ["dry_run"],
      registers: [registry],
    });
    isolationReaperDeleted = new Counter({
      name: ISOLATION_WORKSPACE_REAPER_DELETED_METRIC,
      help:
        "Workspace directories irreversibly removed by the isolation-workspace "
        + "reaper (BLO-36814). Counts real unlinks only, so it is always 0 under "
        + "dry_run=\"true\" and can never overstate reclaimed space. The "
        + "would-have-removed count of a dry run is "
        + ISOLATION_WORKSPACE_REAPER_ENTRIES_METRIC + "{outcome=\"eligible\"} — read "
        + "its dry_run label before treating that as a deletion.",
      labelNames: ["dry_run"],
      registers: [registry],
    });
    isolationReaperSkippedLayout = new Counter({
      name: ISOLATION_WORKSPACE_REAPER_SKIPPED_LAYOUT_METRIC,
      help:
        "Directories skipped UNEXAMINED because their top level did not match the "
        + "{home, session} allowlist (BLO-36814). Its own series, not an outcome "
        + "label. SUMS TWO POPULATIONS WITH OPPOSITE MEANINGS AND CANNOT SPLIT "
        + "THEM: single-sided ({home} or {session} alone -- a half-materialized "
        + "workspace, benign) and genuine supersets (an extra top-level entry -- "
        + "the real heterogeneity signal). BLO-36735 measured the whole live tree "
        + "at maxAgeDays=30 on 2026-10-11: 50 skips = 42 single-sided + 8 "
        + "supersets, that subset unchanged from 2026-10-10. So the total is not "
        + "readable as a rise -- an earlier reading of this help gave the baseline "
        + "as 1 (the superset count before the single-sided population existed at "
        + "scale) and against 50 that fires permanently on a benign cause. Until "
        + "this carries a reason label, split it against the tree; see "
        + "runbooks/isolation-workspace-reaper.md. A directory "
        + "whose top level DID match but which holds a nested git checkout is not "
        + "counted here; it is " + ISOLATION_WORKSPACE_REAPER_ENTRIES_METRIC
        + "{outcome=\"retained_nested_checkout\"}.",
      labelNames: ["dry_run"],
      registers: [registry],
    });
    isolationReaperRetainedResurrected = new Counter({
      name: ISOLATION_WORKSPACE_REAPER_RETAINED_RESURRECTED_METRIC,
      help:
        "Workspaces idle at the sweep's opening snapshot but used again before "
        + "this pass reached its unlink — i.e. that came within one query of "
        + "being deleted underneath a live run (BLO-36814). Its own series, not "
        + "an outcome label: any non-zero value is a finding, and this counter's "
        + "frequency is the only evidence that can confirm or retire the exposure "
        + "window the pre-unlink re-read exists to close.",
      labelNames: ["dry_run"],
      registers: [registry],
    });
    isolationReaperEntries = new Counter({
      name: ISOLATION_WORKSPACE_REAPER_ENTRIES_METRIC,
      help:
        "Routine per-entry isolation-workspace reaper outcomes, labeled by bounded "
        + "outcome (eligible, retained_in_use, retained_fresh, retained_nested_checkout, "
        + "vanished, failed). "
        + "The two findings outcomes — skipped_layout and retained_resurrected — "
        + "are deliberately NOT in this counter; they have their own series so no "
        + "sum-by aggregates them away.",
      labelNames: ["dry_run", "outcome"],
      registers: [registry],
    });
    isolationReaperSweeps = new Counter({
      name: ISOLATION_WORKSPACE_REAPER_SWEEPS_METRIC,
      help:
        "Completed isolation-workspace reaper sweeps, labeled by how the pass "
        + "ended (BLO-36814). capped = maxDeletesPerTick stopped it with work "
        + "remaining; lookup_faulted = the pre-unlink re-read faulted, so the "
        + "remaining directories were never assessed at all.",
      labelNames: ["dry_run", "stop_reason"],
      registers: [registry],
    });
    isolationReaperLastSweep = new Gauge({
      name: ISOLATION_WORKSPACE_REAPER_LAST_SWEEP_METRIC,
      help:
        "Unix timestamp of the last completed isolation-workspace reaper sweep "
        + "(BLO-36814). This is the liveness signal: `time() - max(...)` exceeding "
        + "2x the configured interval means a daily irreversible-delete sweep has "
        + "silently stopped ticking, which no counter can express on its own "
        + "because a healthy idle sweep and a dead one both add zero.",
      labelNames: ["dry_run"],
      registers: [registry],
    });
    executionWorkspaceTeardown = new Counter({
      name: EXECUTION_WORKSPACE_TEARDOWN_METRIC,
      help:
        "Execution-workspace tree removals attempted, labeled by trigger "
        + "(persist_rollback, collector, operator, unknown), method (worktree_remove, "
        + "remove_local_fs), cleanup_reason and outcome (PEN-3692). \u26d4 READ "
        + "cleanup_reason, NOT trigger, to attribute work to runs: run end performs no "
        + "inline teardown, so run-attributable removal is inside trigger=\"collector\" "
        + "with cleanup_reason=\"run_ended\", and trigger=\"persist_rollback\" counts "
        + "only the rare DB-write-failure path. outcome=\"failed\" counts a removal that threw; on "
        + "the worktree path that is caught and demoted to a warning, so the tree is "
        + "still on disk and a sustained non-zero rate means reclamation is silently "
        + "not happening.",
      labelNames: ["trigger", "method", "outcome", "cleanup_reason"],
      registers: [registry],
    });
    executionWorkspaceTeardownDuration = new Histogram({
      name: EXECUTION_WORKSPACE_TEARDOWN_DURATION_METRIC,
      help:
        "Seconds spent walking one execution-workspace tree (PEN-3692), split by "
        + "`method`: the `worktree_remove` / `remove_local_fs` removal calls, and the "
        + "`inspect_safety` git-status walks the collector makes up to twice per "
        + "candidate. Summed over ALL methods the _sum is the quantity this row needs "
        + "— the work integral to regress the cgroup's reclaimable-slab residual "
        + "against, replacing the n=2 natural experiment that attributed fill to run "
        + "failures by magnitude alone. Summed over the two removal methods alone it "
        + "omits the safety walks, which may be the largest term. ⚠️ Because "
        + "`inspect_safety` is not a removal, this _count exceeds the teardown _total; "
        + "filter to the removal methods to compare them. Duration is used as the "
        + "proxy for tree size ON PURPOSE: counting entries unlinked would mean "
        + "walking the tree ourselves, i.e. performing the very readdir/lstat work "
        + "being measured, so the instrument would create the pressure it reports. "
        + "Buckets run to 60s because these trees sit on a network mount where a "
        + "removal can block for a long time.",
      labelNames: ["trigger", "method", "cleanup_reason"],
      buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
      registers: [registry],
    });
    executionWorkspaceCollectorScanned = new Counter({
      name: EXECUTION_WORKSPACE_COLLECTOR_SCANNED_METRIC,
      help:
        "Eligible execution-workspace rows the periodic collector examined, summed over "
        + "passes (PEN-3692). The denominator for the candidates counter. Each scanned "
        + "git_worktree candidate costs two full `git status` tree walks before any "
        + "removal, so this — not the collected count — is the collector's tree-walking "
        + "load.",
      registers: [registry],
    });
    executionWorkspaceCollectorCandidates = new Counter({
      name: EXECUTION_WORKSPACE_COLLECTOR_CANDIDATES_METRIC,
      help:
        "Per-candidate dispositions of the periodic execution-workspace collector, "
        + "labeled by outcome (collected, skipped, failed) (PEN-3692). These partition "
        + "the scanned total. A `skipped` candidate was deliberately retained — dirty, "
        + "unpushed, or unverifiable — and is re-examined next window, so a high "
        + "skipped rate is repeated tree-walk cost that frees nothing.",
      labelNames: ["outcome"],
      registers: [registry],
    });
    executionWorkspaceCollectorStamped = new Counter({
      name: EXECUTION_WORKSPACE_COLLECTOR_STAMPED_METRIC,
      help:
        "Long-idle unstamped execution-workspace rows the backfill newly made eligible "
        + "(PEN-3692). Deliberately its own series rather than a candidates outcome: it "
        + "counts rows this pass did NOT examine, so summing it with the dispositions "
        + "would double-count the population.",
      registers: [registry],
    });
    executionWorkspaceCollectorPasses = new Counter({
      name: EXECUTION_WORKSPACE_COLLECTOR_PASSES_METRIC,
      help:
        "Periodic execution-workspace collector passes, labeled by how the pass ended "
        + "(PEN-3692): complete, skipped_saturated (abandoned fs calls held the threadpool "
        + "at entry, so nothing was examined), ended_saturated or ended_wedged (stopped "
        + "part-way). A pass that threw does not reach this counter, so comparing its rate "
        + "against the ~30s scheduler interval is how a collector that is failing every "
        + "tick is distinguished from one that is running and finding nothing, and the "
        + "skipped_saturated rate is how one deliberately standing down on a wedged mount "
        + "is distinguished from both.",
      labelNames: ["stop_reason"],
      registers: [registry],
    });
    executionWorkspaceCollectorLastPass = new Gauge({
      name: EXECUTION_WORKSPACE_COLLECTOR_LAST_PASS_METRIC,
      help:
        "Unix timestamp of the last periodic execution-workspace collector pass of any "
        + "stop_reason, including a skipped one (PEN-3692). The liveness signal no counter "
        + "can express: a healthy idle pass and a collector that has stopped ticking both "
        + "add zero to every counter above.",
      registers: [registry],
    });
    pluginWebhookDeliveryRejected = new Counter({
      name: PLUGIN_WEBHOOK_DELIVERY_REJECTED_METRIC,
      help:
        "Count of inbound plugin webhook deliveries turned away at the ingestion "
        + "readiness guard (BLO-28803), labeled by bounded plugin_key, response_class "
        + "(retryable = 503, the sender will re-deliver; terminal = 410, the payload is "
        + "dropped on purpose) and plugin_status. Before this counter a rejected delivery "
        + "left no row, no counter and no log, so the 2026-08-18 alert blackout "
        + "(BLO-20813) could only be reconstructed from Alertmanager's own logs. "
        + "A sustained retryable rate means a plugin is bouncing every delivery; any "
        + "terminal rate means payloads are being discarded.",
      labelNames: ["plugin_key", "response_class", "plugin_status"],
      registers: [registry],
    });
    recoveryHorizonExpired = new Counter({
      name: RECOVERY_HORIZON_EXPIRED_METRIC,
      help:
        "Recovery actions retired at their auto-recovery wake horizon, labeled by whether a "
        + "wake was delivered to the action's CURRENT owner. delivery=\"never_delivered\" "
        + "means attemptCount reached the horizon at 0 — every sweep since the current owner "
        + "took over reserved an attempt and refunded it because enqueueWakeup delivered "
        + "nothing, so no wake reached the queue for that owner. Owner churn restarts the "
        + "counter, so an earlier owner may have been woken; the label does not claim the row's "
        + "whole life. That is a wake-channel fault (capacity deferral, tree pause hold, wake "
        + "disabled, cooldown) and is the alertable one. delivery=\"delivered\" means the current "
        + "owner was woken at least once and the recovery still did not converge, which is a "
        + "genuine unresolvable stranding. Action id, cause and owner are on the paired "
        + "structured log line, not these labels.",
      labelNames: ["delivery"],
      registers: [registry],
    });
    // Zero-init both series so a scrape can distinguish "no expiry yet" from "not
    // instrumented" — same reason the backstop gauges and the workspace-fallback counter
    // are seeded above. Without this an alert on never_delivered cannot fire off absent().
    for (const delivery of RECOVERY_HORIZON_DELIVERY_STATES) {
      recoveryHorizonExpired.inc({ delivery }, 0);
    }
    recoveryActionAutoDischarged = new Counter({
      name: RECOVERY_ACTION_AUTO_DISCHARGED_METRIC,
      help:
        "Recovery actions discharged by the restored-execution sweep rather than by a "
        + "human-equivalent resolve call, labeled by action kind. Incremented when a run on "
        + "the action's source issue reached \"succeeded\" after the action was created and "
        + "was not itself raised by a recovery action. Near-zero is healthy: it means owners "
        + "discharge their own actions once the remedy lands. A sustained rate means they do "
        + "not, and every such action was holding its source row in status-only wake mode "
        + "until this sweep found it. Action id, source issue and evidencing run id are on "
        + "the paired structured log line, not these labels.",
      labelNames: ["kind"],
      registers: [registry],
    });
    // Zero-init for the same reason as the horizon series above: an alert on a sustained
    // auto-discharge rate has to be able to tell "nothing to discharge" from "this sweep is
    // not running at all", and absent() cannot.
    for (const kind of RESTORED_EXECUTION_DISCHARGE_KINDS) {
      recoveryActionAutoDischarged.inc({ kind }, 0);
    }
    workerTierProxyFailures = new Counter({
      name: WORKER_TIER_PROXY_FAILURES_METRIC,
      help:
        "Count of worker-tier proxy relay failures, labeled by reason: 'timeout' "
        + "(connection succeeded, the worker was still silent at the proxy deadline), "
        + "'mid_stream' (the worker answered and the response broke after headers "
        + "were flushed) or 'unreachable' (the request never reached a worker). "
        + "Replaces a log grep that could not answer a 24h question, because the api "
        + "pod's log does not survive its own recreation (BLO-31945).",
      labelNames: ["reason"],
      registers: [registry],
    });
    // Zero-init every series. An un-incremented counter is absent from the
    // scrape, and an absent series is indistinguishable from a healthy one on
    // every dashboard — rate() over it returns nothing rather than 0.
    for (const reason of KNOWN_WORKER_TIER_PROXY_FAILURE_REASONS) {
      workerTierProxyFailures.inc({ reason }, 0);
    }
    // Process/runtime metrics make the scrape target carry meaningful data even
    // before any refusal is reported (manual-verification check #3 on BLO-8328).
    collectDefaultMetrics({ register: registry });
    // That default set labels GC by `kind` alone and discards V8's `flags`
    // bitfield, which is the dimension PEN-3314 needs to tell a memory-reducing
    // full GC from an ordinary major. Observes the same event stream; no extra
    // syscall and no cadence change. See `services/gc-flags-metrics.ts`.
    registerGcFlagsCollector({ registry });
  }
  return {
    registry,
    counter: concurrentRunBlocked,
    dispatchDeclinedCounter: agentDispatchDeclined,
    isolatedStartedCounter: isolatedRunStarted,
    failedCounter: heartbeatRunFailed,
    capacityDeferredCounter: ccrotateCapacityDeferred,
    retryScheduleOutcomeCounter: retryScheduleOutcome,
    startLockReapDispositionCounter: startLockReapDisposition,
    orphanReapStageSecondsHistogram: orphanReapStageSeconds,
    penstockGateProbeCounter: penstockGateProbe,
    penstockGateProbeDurationHistogram: penstockGateProbeDuration,
    heartbeatTimerSchedulerExclusionCounter: heartbeatTimerSchedulerExclusion,
    modelProfileUnappliedCounter: modelProfileUnapplied,
    heartbeatPostTerminalRunEventDroppedCounter: heartbeatPostTerminalRunEventDropped,
    heartbeatTimerCheckedCounter: heartbeatTimerChecked,
    heartbeatTimerEnqueuedCounter: heartbeatTimerEnqueued,
    zeroTokenCompletedRunStreakGauge: agentZeroTokenCompletedRunStreak,
    externalRuntimeReservationEventsCounter: externalRuntimeReservationEvents,
    externalRuntimeReservationsActiveGauge: externalRuntimeReservationsActive,
    externalRuntimeReservationOldestAgeGauge: externalRuntimeReservationOldestAge,
    queuedRunAgeMetricsRefreshSuccessGauge: queuedRunAgeMetricsRefreshSuccess,
    externalRuntimeReservationsReleasePendingGauge: externalRuntimeReservationsReleasePending,
    externalRuntimeReservationReleasePendingOldestAgeGauge: externalRuntimeReservationReleasePendingOldestAge,
    environmentLeasesOrphanedActiveGauge: environmentLeasesOrphanedActive,
    environmentLeasesOrphanedOldestAgeGauge: environmentLeasesOrphanedOldestAge,
    orphanedRuntimeResourceMetricsRefreshSuccessGauge: orphanedRuntimeResourceMetricsRefreshSuccess,
    externalRuntimeReservationStrandedOldestAgeGauge: externalRuntimeReservationStrandedOldestAge,
    externalRuntimeReservationStrandMetricsRefreshSuccessGauge:
      externalRuntimeReservationStrandMetricsRefreshSuccess,
    workspaceReuseRefusalWindowGauge: workspaceReuseRefusalWindow,
    workspaceReuseRefusalMetricsRefreshSuccessGauge: workspaceReuseRefusalMetricsRefreshSuccess,
    projectCheckoutOriginMismatchGauge: projectCheckoutOriginMismatch,
    projectCheckoutOriginReconcileComparedGauge: projectCheckoutOriginReconcileCompared,
    projectCheckoutOriginReconcileMetricsRefreshSuccessGauge:
      projectCheckoutOriginReconcileMetricsRefreshSuccess,
    approvalsPendingGauge: approvalsPending,
    approvalOldestPendingAgeGauge: approvalOldestPendingAge,
    approvalLastDecisionTimestampGauge: approvalLastDecisionTimestamp,
    approvalQueueMetricsRefreshSuccessGauge: approvalQueueMetricsRefreshSuccess,
    acceptedInteractionOutcomeGauge: acceptedInteractionOutcome,
    acceptedInteractionOutcomeOldestAgeGauge: acceptedInteractionOutcomeOldestAge,
    acceptedInteractionOutcomeRecentGauge: acceptedInteractionOutcomeRecent,
    acceptedInteractionOutcomeMetricsRefreshSuccessGauge: acceptedInteractionOutcomeMetricsRefreshSuccess,
    interactionPayloadUnrecognizedKeyCounter: interactionPayloadUnrecognizedKey,
    agentStartLockHeldSecondsGauge: agentStartLockHeldSeconds,
    agentStartLockPhaseSecondsGauge: agentStartLockPhaseSeconds,
    agentStartLockAbortedTotalCounter: agentStartLockAbortedTotal,
    duplicateDispatchSuppressedCounter: duplicateDispatchSuppressedTotal,
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
    githubApiRefusalsCounter: githubApiRefusals,
    githubApiRequestsCounter: githubApiRequests,
    agentWakeupTerminalFailedUnresolvedGauge: agentWakeupTerminalFailedUnresolved,
    agentWakeupTerminalFailedOldestAgeGauge: agentWakeupTerminalFailedOldestAge,
    githubWorkflowRunConclusionCounter: githubWorkflowRunConclusion,
    githubWebhookDeliveryCounter: githubWebhookDelivery,
    queuedRunOldestAgeGauge: queuedRunOldestAge,
    queuedRunOldestClaimableAgeGauge: queuedRunOldestClaimableAge,
    routineLastDoneFireAgeGauge: routineLastDoneFireAge,
    routineLastFireStartAgeGauge: routineLastFireStartAge,
    routineFireIntervalGauge: routineFireInterval,
    routineFireGapMetricsRefreshSuccessGauge: routineFireGapMetricsRefreshSuccess,
    deferredIssueExecutionWakeOldestAgeGauge: deferredIssueExecutionWakeOldestAge,
    deferredIssueExecutionWakeAgeMetricsRefreshSuccessGauge:
      deferredIssueExecutionWakeAgeMetricsRefreshSuccess,
    coldInReviewIssueOldestAgeGauge: coldInReviewIssueOldestAge,
    coldInReviewIssueMetricsRefreshSuccessGauge: coldInReviewIssueMetricsRefreshSuccess,
    overdueScheduledRetryOldestAgeGauge: overdueScheduledRetryOldestAge,
    overdueScheduledRetryAgeMetricsRefreshSuccessGauge: overdueScheduledRetryAgeMetricsRefreshSuccess,
    scheduledRetryParkHorizonGauge: scheduledRetryParkHorizon,
    scheduledRetryParkHorizonRefreshSuccessGauge: scheduledRetryParkHorizonRefreshSuccess,
    dbPoolConnectionsGauge: dbPoolConnections,
    dbPoolWaitingQueriesGauge: dbPoolWaitingQueries,
    dbInheritedTimeoutGauge: dbInheritedTimeout,
    processOpenFdsByClassGauge: processOpenFdsByClass,
    processMemoryComponentBytesGauge: processMemoryComponentBytes,
    processV8ContextCountGauge: processV8ContextCount,
    processMappingRssBytesGauge: processMappingRssBytes,
    processMappingCountGauge: processMappingCount,
    processMappingSizeBucketCountGauge: processMappingSizeBucketCount,
    processMappingSizeBucketBytesGauge: processMappingSizeBucketBytes,
    processGlibcSecondaryArenaHeapCountGauge: processGlibcSecondaryArenaHeapCount,
    processMappingScanSecondsGauge: processMappingScanSeconds,
    processMappingScanTimestampGauge: processMappingScanTimestamp,
    processHeapPeakSamplesGauge: processHeapPeakSamples,
    processRssReleaseEventsGauge: processRssReleaseEvents,
    processRssReleaseBytesGauge: processRssReleaseBytes,
    processRssReleaseLastOnsetTimestampGauge: processRssReleaseLastOnsetTimestamp,
    processRssReleaseLastDetectedTimestampGauge: processRssReleaseLastDetectedTimestamp,
    processRssReleaseLastBytesGauge: processRssReleaseLastBytes,
    processRssReleaseSamplesGauge: processRssReleaseSamples,
    processRssReleaseBoundBytesGauge: processRssReleaseBoundBytes,
    cgroupMemoryComponentBytesGauge: cgroupMemoryComponentBytes,
    cgroupMemoryCurrentBytesGauge: cgroupMemoryCurrentBytes,
    cgroupMemoryMaxBytesGauge: cgroupMemoryMaxBytes,
    cgroupMemoryPeakBytesGauge: cgroupMemoryPeakBytes,
    pluginErrorGauge: pluginError,
    crashRecoveryCandidateIndexPresentGauge: crashRecoveryCandidateIndexPresent,
    pluginMetricCounter: pluginMetric,
    pluginMetricDroppedCounter: pluginMetricDropped,
    pluginStatusCollectorLastSuccessGauge: pluginStatusCollectorLastSuccess,
    prReviewQueueWaitHistogram: prReviewQueueWait,
    runDispatchWaitHistogram: runDispatchWait,
    authRequestCounter: authRequest,
    httpRequestsCounter: httpRequests,
    httpEmptyListResponsesCounter: httpEmptyListResponses,
    gbrainRecallCounter: gbrainRecallTotal,
    agentHeartbeatAgeGauge: agentHeartbeatAge,
    agentHeartbeatIntervalGauge: agentHeartbeatInterval,
    agentErrorDurationGauge: agentErrorDuration,
    agentErrorReasonAgentsGauge: agentErrorReasonAgents,
    agentErrorReasonOldestAgeGauge: agentErrorReasonOldestAge,
    projectPrimaryWorkspaceFallbackCounter: projectPrimaryWorkspaceFallback,
    backstopDeferredCandidatesGauge: backstopDeferredCandidates,
    backstopSweepCompletedCounter: backstopSweepCompleted,
    backstopCandidatesSkippedCounter: backstopCandidatesSkipped,
    wakeRedeliverySuppressedCounter: wakeRedeliverySuppressed,
    heartbeatRecoveryChainSkippedCounter: heartbeatRecoveryChainSkipped,
    heartbeatRecoveryChainDurationGauge: heartbeatRecoveryChainDuration,
    heartbeatRecoveryChainInflightGauge: heartbeatRecoveryChainInflight,
    heartbeatRecoveryChainStalledCounter: heartbeatRecoveryChainStalled,
    schedulerLeaseHeldGauge: schedulerLeaseHeld,
    schedulerLeaseRenewedGauge: schedulerLeaseRenewed,
    pluginWebhookDeliveryRejectedCounter: pluginWebhookDeliveryRejected,
    recoveryHorizonExpiredCounter: recoveryHorizonExpired,
    recoveryActionAutoDischargedCounter: recoveryActionAutoDischarged,
    workerTierProxyFailuresCounter: workerTierProxyFailures,
    isolationReaperScannedCounter: isolationReaperScanned,
    isolationReaperDeletedCounter: isolationReaperDeleted,
    isolationReaperSkippedLayoutCounter: isolationReaperSkippedLayout,
    isolationReaperRetainedResurrectedCounter: isolationReaperRetainedResurrected,
    isolationReaperEntriesCounter: isolationReaperEntries,
    isolationReaperSweepsCounter: isolationReaperSweeps,
    isolationReaperLastSweepGauge: isolationReaperLastSweep,
    executionWorkspaceTeardownCounter: executionWorkspaceTeardown,
    executionWorkspaceTeardownDurationHistogram: executionWorkspaceTeardownDuration,
    executionWorkspaceCollectorScannedCounter: executionWorkspaceCollectorScanned,
    executionWorkspaceCollectorCandidatesCounter: executionWorkspaceCollectorCandidates,
    executionWorkspaceCollectorStampedCounter: executionWorkspaceCollectorStamped,
    executionWorkspaceCollectorPassesCounter: executionWorkspaceCollectorPasses,
    executionWorkspaceCollectorLastPassGauge: executionWorkspaceCollectorLastPass,
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

export interface RecordAgentDispatchDeclinedInput {
  /** Agent whose dispatch pass declined. */
  agentId: string | null | undefined;
  /** One of {@link KNOWN_DISPATCH_DECLINE_REASONS}; anything else collapses. */
  reason: string | null | undefined;
  /**
   * Active company agent roster used to bound the `agent_id` label. Pass an
   * empty set for the process-wide guards that fire before the agent row is
   * loaded — the label then collapses to {@link UNKNOWN_AGENT_ID}, which is the
   * honest answer: those refusals are facts about the process, not the agent.
   */
  knownAgentIds: ReadonlySet<string>;
}

/**
 * Increment {@link AGENT_DISPATCH_DECLINED_METRIC}. Call once per dispatch pass
 * that returns without claiming a run, at the site that made that decision.
 * Returns the normalized labels emitted (useful for logging/tests).
 */
export function recordAgentDispatchDeclined(
  input: RecordAgentDispatchDeclinedInput,
): { agent_id: string; reason: string } {
  const labels = {
    agent_id: normalizeAgentId(input.agentId, input.knownAgentIds),
    reason: normalizeDispatchDeclineReason(input.reason),
  };
  ensureRegistry().dispatchDeclinedCounter.inc(labels);
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
  /** Active company agent roster used to bound the `agent_id` label. */
  knownAgentIds: ReadonlySet<string>;
}

/**
 * Increment `paperclip_heartbeat_run_failed_total`. Call once per run that
 * reaches terminal status "failed" in the liveness loop. Returns the
 * normalized labels emitted (useful for logging/tests).
 */
export function recordHeartbeatRunFailed(
  input: RecordHeartbeatRunFailedInput,
): Record<HeartbeatRunFailedLabel, string> {
  // The two source identifiers have COMPLETELY DIFFERENT cardinality cost, so
  // BLO-17953 A1f splits them rather than extending one allow-list code by code:
  //
  //   `issue_id` is UNBOUNDED — it accrues a new permanent series for every
  //   issue that ever fails — so it stays behind the narrow `error_code` gate
  //   below. Keeping it on every terminal failure would retain one counter
  //   series per historical issue for the process lifetime.
  //
  //   `agent_id` is BOUNDED BY THE ROSTER (tens) and is therefore retained for
  //   EVERY error code. That bound is ENFORCED, not asserted: `normalizeAgentId`
  //   collapses any id outside the company roster to `unknown`, exactly as the
  //   seven other `agent_id`-labeled recorders in this module do. The roster is
  //   membership, not runtime status (`agent-roster.ts`), so a paused or retired
  //   agent still reports under its own id. Two ids collapse: one that is not a
  //   real agent (the case worth collapsing), and — rarely — a real one the 30s
  //   roster cache has not yet observed, i.e. an agent's failing runs inside
  //   30s of its creation. Every failing run in that window collapses, not just
  //   the first: nothing invalidates the cache on agent creation, and a miss
  //   does not populate it (`normalizeAgentId` is a pure membership test), so
  //   fast-failing codes can emit several. The second is an accepted,
  //   self-correcting cost that
  //   errs toward `unknown`, so it can never breach the bound. "Which
  //   lane is losing runs to X" is a question worth answering for every failure
  //   mode, and answering it per-code meant relitigating the allow-list each
  //   time (BLO-33441 added exactly one code; A1c proposed another before its
  //   premise was falsified ~1000x).
  //
  // Measured cost before this split (2026-10-03, 7d): 153 of 543 series sat at
  // agent_id="unknown". They now fan out by the agents that actually produce
  // them — bounded above by 153 x roster(~21), and in practice far less. The
  // unbounded dimension is untouched, which is what makes that bound hold.
  //
  // That bound is a SNAPSHOT of today's error-code population, not an enforced
  // ceiling: `error_code` is a raw pass-through. It is safe today because every
  // source stamps a code-literal (`classifyAgentJobFailureErrorCode` returns a
  // 3-value union or null; the setup-failure path stamps constants such as
  // `setup_failed` and `workspace_validation_failed`). Retaining
  // `agent_id` for every code multiplied this dimension's cost by the roster,
  // so the day anything stamps a TEMPLATED or caller-supplied code, gate it
  // through a KNOWN_ERROR_CODES set here before it ships.
  //
  // BLO-17953: this deliberately does NOT gate on `isolationMode === "run"`.
  // `resolveK8sRunIsolationIdentity` returns run | workspace | shared for every
  // k8s adapter and all three are execution pods, so gating on "run" erased
  // both labels together for the majority of the population the alert exists to
  // catch (measured 2026-09-12: 54.1 of 96.2 pod-schedule failures over 24h sat
  // in workspace/shared and were therefore unattributable). Narrowing by
  // isolation mode never added a cardinality bound; the error code already was
  // the bound — and it bounds `issue_id` only.
  const isolationMode = normalizeIsolationMode(input.isolationMode);
  const retainIssueId = input.errorCode === "k8s_pod_schedule_failed";
  const labels = {
    agent_id: normalizeAgentId(input.agentId, input.knownAgentIds),
    issue_id: retainIssueId && typeof input.issueId === "string" && input.issueId.length > 0
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

export interface RecordRetryScheduleOutcomeInput {
  /**
   * The return outcome, or -- for a `not_scheduled` return -- its `errorCode`.
   * Coerced to {@link KNOWN_RETRY_SCHEDULE_OUTCOMES}; anything else is `other`.
   */
  outcome: string | null | undefined;
  /** Retry reason. Coerced to {@link KNOWN_RETRY_SCHEDULE_REASONS}. */
  retryReason: string | null | undefined;
}

/**
 * Increment {@link RETRY_SCHEDULE_OUTCOME_METRIC}. Call once per
 * `scheduleBoundedRetryForRun` return, on every path -- the abandon path
 * especially, since it persists nothing and is otherwise unobservable.
 *
 * Both labels are coerced to their allow-lists, so worst-case series count is
 * `KNOWN_RETRY_SCHEDULE_OUTCOMES.length * KNOWN_RETRY_SCHEDULE_REASONS.length`
 * regardless of what a caller passes. Deliberately carries no `agent_id`:
 * {@link SCHEDULED_RETRY_PARK_HORIZON_METRIC} already holds that axis, and this
 * is a fleet-level rate.
 */
export function recordRetryScheduleOutcome(
  input: RecordRetryScheduleOutcomeInput,
): { outcome: RetryScheduleOutcomeLabel; retry_reason: RetryScheduleReasonLabel } {
  const labels = {
    outcome: (KNOWN_RETRY_SCHEDULE_OUTCOMES as readonly string[]).includes(input.outcome ?? "")
      ? (input.outcome as RetryScheduleOutcomeLabel)
      : ("other" as const),
    retry_reason: coerceRetryScheduleReason(input.retryReason),
  };
  ensureRegistry().retryScheduleOutcomeCounter.inc(labels);
  return labels;
}

/** Observe one {@link ORPHAN_REAP_STAGE_SECONDS_METRIC} sample. Unknown stages are dropped. */
export function recordOrphanReapStage(stage: OrphanReapStageLabel, seconds: number) {
  if (!(KNOWN_ORPHAN_REAP_STAGES as readonly string[]).includes(stage) || !Number.isFinite(seconds)) return;
  ensureRegistry().orphanReapStageSecondsHistogram.observe({ stage }, Math.max(0, seconds));
}

/**
 * Increment {@link AGENT_START_LOCK_REAP_DISPOSITION_METRIC}. Call once per
 * start-lock dispatch pass, from the `finally` that already times the reap, so
 * the throw path is counted as `error` rather than silently dropped.
 *
 * `disposition` is coerced to {@link KNOWN_START_LOCK_REAP_DISPOSITIONS}, so
 * the worst-case series count is that list's length regardless of what a caller
 * passes. An unrecognised value is reported as `error` rather than `other`:
 * every legitimate value is a compile-time literal of the reap's return union,
 * so anything else reaching here is a defect, and the metric should not have a
 * benign-looking bucket to hide one in.
 */
export function recordStartLockReapDisposition(
  disposition: string | null | undefined,
): { disposition: StartLockReapDispositionLabel } {
  const labels = {
    disposition: (KNOWN_START_LOCK_REAP_DISPOSITIONS as readonly string[]).includes(disposition ?? "")
      ? (disposition as StartLockReapDispositionLabel)
      : ("error" as const),
  };
  ensureRegistry().startLockReapDispositionCounter.inc(labels);
  return labels;
}

export interface RecordPenstockAvailabilityGateProbeInput {
  /** Which probe ran. Coerced to the allow-list; anything else is rejected. */
  path: string | null | undefined;
  /** Bounded probe outcome. Coerced to the allow-list. */
  outcome: string | null | undefined;
  /** Penstock provider probed (e.g. "anthropic"). */
  provider: string | null | undefined;
  /** Model probed, from operator-managed adapter config. */
  model: string | null | undefined;
  /**
   * Wall time the probe took, in seconds. Omit when the caller has no
   * measurement; the counter still increments so attempt counts never depend on
   * timing being available.
   */
  durationSeconds?: number | null;
}

/**
 * Longest `model` label accepted verbatim.
 *
 * `model` is operator-managed rather than request-supplied, so this is a
 * backstop against a malformed config value becoming a permanent series, not a
 * defence against a hostile caller. Truncating rather than dropping keeps a
 * genuinely long model id readable and attributable.
 */
const PENSTOCK_PROBE_MODEL_LABEL_MAX_LENGTH = 120;

function normalizePenstockProbeLabel<T extends string>(
  value: string | null | undefined,
  allowed: readonly T[],
  fallback: T,
): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

/**
 * Materialise every {@link KNOWN_PENSTOCK_PROBE_OUTCOMES} child at zero for one
 * `(path, provider, model)` tuple (PEN-4675).
 *
 * A prom-client counter mints a child on its first `inc`, so an outcome that
 * has not fired has **no series at all** rather than a series reading zero.
 * `absent(...)` and `== 0` are then indistinguishable over any window, and the
 * reading fails in the reassuring direction: a healthy quiet hour and an
 * exporter that stopped emitting look identical. Measured on PEN-2514/PEN-4462,
 * `outcome="deny_capacity"` was absent for 80 consecutive hours while the gate
 * was demonstrably probing, and the `deny_temporary` child independently
 * demonstrated the converse — born, flat zero for 16 h, then gone with the pod.
 *
 * Seeding is lazy and per tuple rather than at process start because `model`
 * comes from operator-managed adapter config and `provider` is deliberately
 * uncoerced, so neither is enumerable before the first probe. Cost is bounded
 * by the same tuple space the counter already pays for: six children per
 * observed tuple instead of one, and `path`/`outcome` are fixed allow-lists.
 */
function seedPenstockProbeOutcomes(
  counter: Counter<"path" | "outcome" | "provider" | "model">,
  path: PenstockProbePathLabel,
  provider: string,
  model: string,
): void {
  const key = `${path}|${provider}|${model}`;
  if (penstockGateProbeSeededTuples.has(key)) return;
  penstockGateProbeSeededTuples.add(key);
  for (const outcome of KNOWN_PENSTOCK_PROBE_OUTCOMES) {
    counter.inc({ path, outcome, provider, model }, 0);
  }
}

/**
 * Increment {@link PENSTOCK_AVAILABILITY_GATE_PROBE_METRIC} and observe
 * {@link PENSTOCK_AVAILABILITY_GATE_PROBE_DURATION_METRIC} for one probe.
 *
 * Call once per **network probe**, never on a verdict-cache hit: the fallback
 * share this series exists to measure is a ratio over real re-probes, and
 * counting cache hits in the denominator would understate it by exactly the
 * cache hit rate.
 *
 * An unrecognised `path` collapses to "capacity" and an unrecognised `outcome`
 * to "error". Both fallbacks are deliberately the *pessimistic* reading — an
 * uninstrumented branch shows up as a probe that failed on the cheap path
 * rather than silently inflating the expensive one, so a labelling mistake
 * cannot manufacture evidence that the fallback is hot.
 */
export function recordPenstockAvailabilityGateProbe(
  input: RecordPenstockAvailabilityGateProbeInput,
): { path: PenstockProbePathLabel; outcome: PenstockProbeOutcomeLabel; provider: string; model: string } {
  const path = normalizePenstockProbeLabel(input.path, KNOWN_PENSTOCK_PROBE_PATHS, "capacity");
  const outcome = normalizePenstockProbeLabel(input.outcome, KNOWN_PENSTOCK_PROBE_OUTCOMES, "error");
  const provider = typeof input.provider === "string" && input.provider.length > 0
    ? input.provider
    : "unknown";
  const rawModel = typeof input.model === "string" ? input.model.trim() : "";
  const model = rawModel.length > 0
    ? rawModel.slice(0, PENSTOCK_PROBE_MODEL_LABEL_MAX_LENGTH)
    : "unknown";
  const labels = { path, outcome, provider, model };
  const registryHandles = ensureRegistry();
  seedPenstockProbeOutcomes(registryHandles.penstockGateProbeCounter, path, provider, model);
  registryHandles.penstockGateProbeCounter.inc(labels);
  if (typeof input.durationSeconds === "number" && Number.isFinite(input.durationSeconds)) {
    registryHandles.penstockGateProbeDurationHistogram.observe(
      { path, provider },
      Math.max(0, input.durationSeconds),
    );
  }
  return labels;
}

export function recordModelProfileUnapplied(input: {
  adapter: string;
  requested: string;
  reason: string | null;
}): void {
  ensureRegistry().modelProfileUnappliedCounter.inc({
    adapter: input.adapter || "unknown",
    requested: input.requested,
    reason: input.reason ?? "unknown",
  });
}

export function recordHeartbeatTimerSchedulerExclusion(reason: string | null | undefined): string {
  const normalized = normalizeHeartbeatTimerSchedulerExclusion(reason);
  ensureRegistry().heartbeatTimerSchedulerExclusionCounter.inc({ reason: normalized });
  return normalized;
}

/**
 * BLO-32553: record that a run event was dropped for arriving post-terminalization.
 *
 * `status` is the run's terminal status, narrowed to the mirrored label domain so
 * a caller cannot widen the label set by construction — a new terminal status in
 * `heartbeat.ts` that is not mirrored here fails to typecheck at the callsite
 * instead of silently collapsing to "unknown".
 *
 * `null`/`undefined` is a meaningful input, not just defensive: the guard passes
 * it when the status read itself failed, which records the drop under "unknown"
 * and keeps it distinguishable from a confirmed terminal drop. The runtime
 * membership check is retained for untyped (JS) callers.
 */
export function recordHeartbeatPostTerminalRunEventDropped(
  status: KnownHeartbeatPostTerminalRunStatus | null | undefined,
): string {
  const normalized =
    typeof status === "string"
      && (KNOWN_HEARTBEAT_POST_TERMINAL_RUN_STATUSES as readonly string[]).includes(status)
      ? status
      : "unknown";
  ensureRegistry().heartbeatPostTerminalRunEventDroppedCounter.inc({ status: normalized });
  return normalized;
}

export interface RecordHeartbeatTimerTickInput {
  /** Candidates examined by this pass (the log line's `checked`). */
  checked: number;
  /** Runs enqueued by this pass (the log line's `enqueued`). */
  enqueued: number;
}

/**
 * Record one completed heartbeat timer pass (BLO-32269).
 *
 * Call this on every completed pass, including passes that enqueued nothing —
 * that is precisely the case `HEARTBEAT_TIMER_CHECKED_METRIC` exists to make
 * visible, and it is why this is not hung off the existing log line (which is
 * gated on `enqueued > 0` and so would leave `_checked_total` pinned at zero on
 * a healthy but idle fleet).
 *
 * Non-finite or negative inputs are dropped rather than clamped: a counter must
 * be monotonic, and silently substituting 0 for a bad value would fabricate a
 * "loop ran, found nothing" reading — the healthy signal — out of a bug. The
 * drop is logged because a dropped tick is otherwise indistinguishable from a
 * tick that never ran, which is the precise ambiguity this pair exists to
 * remove. Both inputs are integer accumulators, so this should never fire —
 * which is exactly why it is worth hearing about if it does.
 *
 * The drop is all-or-nothing across the pair, because the reading it protects
 * is a property of the pair rather than of either field. Validating them
 * independently would let a pass with a valid `checked` and a bad `enqueued`
 * move `checked` while leaving `enqueued` flat — which is observationally
 * identical to substituting 0 for the bad value, and lands on exactly the
 * `checked > 0, enqueued = 0` shape documented above as *Healthy*. That is the
 * worst available outcome: a fleet that has stopped enqueuing, reporting
 * healthy-idle on the surface the alert rule reads. `enqueued` is the likelier
 * half to break, since `tickTimers` composes it from a single field
 * (`issueMonitors.triggered`) where `checked` sums three, so a refactor can
 * yield `NaN` on `enqueued` alone. Dropping the pass as a unit leaves both
 * series flat, which reads as dispatch-dark — the direction that alerts.
 */
export function recordHeartbeatTimerTick(input: RecordHeartbeatTimerTickInput): void {
  const metrics = ensureRegistry();
  const checkedValid = Number.isFinite(input.checked) && input.checked >= 0;
  const enqueuedValid = Number.isFinite(input.enqueued) && input.enqueued >= 0;
  if (!checkedValid || !enqueuedValid) {
    logger.warn(
      {
        checked: input.checked,
        enqueued: input.enqueued,
        invalidFields: [
          ...(checkedValid ? [] : ["checked"]),
          ...(enqueuedValid ? [] : ["enqueued"]),
        ],
        metrics: [HEARTBEAT_TIMER_CHECKED_METRIC, HEARTBEAT_TIMER_ENQUEUED_METRIC],
      },
      "heartbeat timer tick metrics dropped as a pair: checked/enqueued must both be non-negative finite numbers",
    );
    return;
  }
  metrics.heartbeatTimerCheckedCounter.inc(input.checked);
  metrics.heartbeatTimerEnqueuedCounter.inc(input.enqueued);
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
 * The label set both queued-run age gauges emit for one agent.
 *
 * Shared rather than inlined twice so the pair can never diverge: the whole
 * point of publishing them together is that `oldest - oldest_claimable` is a
 * well-formed difference, and in PromQL that subtraction only matches when the
 * two sides carry an IDENTICAL label set. Two independent literals would let a
 * later edit to one of them turn that difference silently empty rather than
 * wrong, which is the harder failure to notice.
 */
function queuedRunAgeLabels(agentId: string, identity: QueuedRunAgentIdentity) {
  return { agent_id: agentId, agent_name: identity.agentName, company_id: identity.companyId };
}

/**
 * Publish the oldest queued-run age per known agent. Reset-then-set is
 * deliberate: an agent whose queue drains must read 0 rather than retaining a
 * stale age that would keep the stranded-run alert open forever.
 */
export function setQueuedRunOldestAgeMetrics(
  entries: ReadonlyArray<{ agentId: string | null | undefined; ageSeconds: number }>,
  knownAgents: ReadonlyMap<string, QueuedRunAgentIdentity>,
): void {
  const gauge = ensureRegistry().queuedRunOldestAgeGauge;
  gauge.reset();
  const knownAgentIds = new Set(knownAgents.keys());
  const oldestByAgentId = new Map<string, number>();
  for (const entry of entries) {
    const agentId = normalizeAgentId(entry.agentId, knownAgentIds);
    const ageSeconds = Number.isFinite(entry.ageSeconds) ? Math.max(0, entry.ageSeconds) : 0;
    const current = oldestByAgentId.get(agentId);
    if (current === undefined || ageSeconds > current) oldestByAgentId.set(agentId, ageSeconds);
  }
  for (const [agentId, identity] of knownAgents) {
    gauge.set(queuedRunAgeLabels(agentId, identity), oldestByAgentId.get(agentId) ?? 0);
  }
  const unknownAge = oldestByAgentId.get(UNKNOWN_AGENT_ID);
  if (unknownAge !== undefined) {
    gauge.set(
      queuedRunAgeLabels(UNKNOWN_AGENT_ID, UNKNOWN_QUEUED_RUN_AGENT_IDENTITY),
      unknownAge,
    );
  }
}

/**
 * Publish the oldest CLAIMABLE queued-run age per known agent (PEN-4293).
 *
 * Deliberately a separate function from {@link setQueuedRunOldestAgeMetrics}
 * rather than a flag on it: the two are written from the same refresh and must
 * both be published on every success, so that `original - claimable` is always
 * a well-formed difference. A shared writer with a mode flag would make a
 * half-published pair representable.
 *
 * The zero-floor is load-bearing in the same way as its sibling's, and for a
 * sharper reason here: an agent whose ENTIRE queue is dependency-blocked has no
 * claimable run at all. That must read as an explicit 0 -- "nothing is waiting
 * on dispatch" -- not as an absent series, which on a dashboard is
 * indistinguishable from the collector being dead.
 */
export function setQueuedRunOldestClaimableAgeMetrics(
  entries: ReadonlyArray<{ agentId: string | null | undefined; ageSeconds: number }>,
  knownAgents: ReadonlyMap<string, QueuedRunAgentIdentity>,
): void {
  const gauge = ensureRegistry().queuedRunOldestClaimableAgeGauge;
  gauge.reset();
  const knownAgentIds = new Set(knownAgents.keys());
  const oldestByAgentId = new Map<string, number>();
  for (const entry of entries) {
    const agentId = normalizeAgentId(entry.agentId, knownAgentIds);
    const ageSeconds = Number.isFinite(entry.ageSeconds) ? Math.max(0, entry.ageSeconds) : 0;
    const current = oldestByAgentId.get(agentId);
    if (current === undefined || ageSeconds > current) oldestByAgentId.set(agentId, ageSeconds);
  }
  for (const [agentId, identity] of knownAgents) {
    gauge.set(queuedRunAgeLabels(agentId, identity), oldestByAgentId.get(agentId) ?? 0);
  }
  const unknownAge = oldestByAgentId.get(UNKNOWN_AGENT_ID);
  if (unknownAge !== undefined) {
    gauge.set(
      queuedRunAgeLabels(UNKNOWN_AGENT_ID, UNKNOWN_QUEUED_RUN_AGENT_IDENTITY),
      unknownAge,
    );
  }
}

/** Mark whether the queued-run age gauge was refreshed from the database. */
export function setQueuedRunAgeMetricsRefreshSuccess(success: boolean): void {
  ensureRegistry().queuedRunAgeMetricsRefreshSuccessGauge.set(success ? 1 : 0);
}

/**
 * Publish the fire-gap gauges for every active, schedule-triggered routine
 * (BLO-32638; the firing-age member added by PEN-4647).
 *
 * `company_id` rides along (BLO-46511) because the exporter reads the shared
 * multi-tenant database: without it Alertmanager cannot route a routine's
 * page to the tenant that owns it, and every tenant's gap files into the
 * catch-all company -- whose seats 404 on another tenant's routine. It adds no
 * cardinality: a routine belongs to exactly one company, so the series count is
 * still one per routine. Contrast the per-tenant counters elsewhere in this
 * file, where company_id WOULD multiply series and is deliberately omitted.
 *
 * Reset-then-set for the usual reason, plus one specific to this pair: a
 * routine that is paused, or whose schedule trigger is disabled or deleted,
 * must DROP OUT of the interval gauge rather than keep a stale cadence. If it
 * did not, the alert would keep a right-hand side for a routine that is
 * deliberately not firing and page forever on an intentional pause.
 *
 * All three gauges are written from the same `entries` list and the same
 * clock, so a routine can never have an age without an interval or vice versa
 * -- a half-published set would make `age > 2 * interval` either silently drop
 * a real routine (no RHS) or compare against another routine's cadence. The
 * two age gauges travel together for the same reason: PEN-4647's rule takes
 * the MAX of them, and a routine present in one but not the other would have
 * that max silently fall back to whichever arm happened to be published.
 *
 * `intervalSeconds: null` means "scheduled but no derivable cadence" -- a cron
 * that fires once and never again. That still gets an age series (it is an
 * active scheduled routine, and "no series" must only ever mean "not
 * scheduled") but no interval, so the vector match drops it from the alert.
 */
export function setRoutineFireGapMetrics(
  entries: ReadonlyArray<{
    routineId: string;
    companyId: string;
    ageSeconds: number;
    fireStartAgeSeconds: number;
    intervalSeconds: number | null;
  }>,
): void {
  const metrics = ensureRegistry();
  metrics.routineLastDoneFireAgeGauge.reset();
  metrics.routineLastFireStartAgeGauge.reset();
  metrics.routineFireIntervalGauge.reset();
  for (const entry of entries) {
    const ageSeconds = Number.isFinite(entry.ageSeconds) ? Math.max(0, entry.ageSeconds) : 0;
    // PEN-4647: published from the same `entries` list and the same clock as
    // the completion age, so the alert's `max()` of the two can never compare
    // one routine's firing age against another's completion age, and neither
    // can be present without the other.
    const fireStartAgeSeconds = Number.isFinite(entry.fireStartAgeSeconds)
      ? Math.max(0, entry.fireStartAgeSeconds)
      : 0;
    const labels = { routine_id: entry.routineId, company_id: entry.companyId };
    metrics.routineLastDoneFireAgeGauge.set(labels, ageSeconds);
    metrics.routineLastFireStartAgeGauge.set(labels, fireStartAgeSeconds);
    if (entry.intervalSeconds !== null && Number.isFinite(entry.intervalSeconds) && entry.intervalSeconds > 0) {
      metrics.routineFireIntervalGauge.set(labels, entry.intervalSeconds);
    }
  }
}

/** Mark whether the routine fire-gap gauges were refreshed from the database. */
export function setRoutineFireGapMetricsRefreshSuccess(success: boolean): void {
  ensureRegistry().routineFireGapMetricsRefreshSuccessGauge.set(success ? 1 : 0);
}

/**
 * Publish the oldest pending `deferred_issue_execution` wake age per agent
 * (PEN-3734).
 *
 * Same reset-then-set contract as {@link setQueuedRunOldestAgeMetrics}, and it
 * is load-bearing for the same reason: a deferred wake's defining property is
 * that nothing else reports it, so if a promoted agent's series were merely
 * left alone it would freeze at its last pre-promotion age — permanently above
 * any threshold, so the page would never clear and the one signal for this
 * condition would be the signal nobody trusts. Writing an explicit 0 is what
 * lets the alert resolve.
 *
 * `knownAgentIds` bounds the label the same way, and the unknown-agent bucket
 * is published only when something actually landed in it.
 */
export function setDeferredIssueExecutionWakeOldestAgeMetrics(
  entries: ReadonlyArray<{ agentId: string | null | undefined; ageSeconds: number }>,
  knownAgentIds: ReadonlySet<string>,
): void {
  const gauge = ensureRegistry().deferredIssueExecutionWakeOldestAgeGauge;
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

/** Mark whether the deferred-issue-execution wake age gauge was refreshed from the database. */
export function setDeferredIssueExecutionWakeAgeMetricsRefreshSuccess(success: boolean): void {
  ensureRegistry().deferredIssueExecutionWakeAgeMetricsRefreshSuccessGauge.set(success ? 1 : 0);
}

/**
 * Publish the oldest cold-`in_review` age for each agent (PEN-4652). Same
 * bounded-label and explicit-zero contract as
 * {@link setDeferredIssueExecutionWakeOldestAgeMetrics}: every known agent is
 * written on every refresh so a repaired fleet reads 0 rather than going
 * absent, and an unrecognised assignee folds into the single UNKNOWN_AGENT_ID
 * bucket, published only when something actually landed in it.
 */
export function setColdInReviewIssueOldestAgeMetrics(
  entries: ReadonlyArray<{ agentId: string | null | undefined; ageSeconds: number }>,
  knownAgentIds: ReadonlySet<string>,
): void {
  const gauge = ensureRegistry().coldInReviewIssueOldestAgeGauge;
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

/** Mark whether the cold-`in_review` age gauge was refreshed from the database. */
export function setColdInReviewIssueMetricsRefreshSuccess(success: boolean): void {
  ensureRegistry().coldInReviewIssueMetricsRefreshSuccessGauge.set(success ? 1 : 0);
}

/**
 * Publish the maximum booked park horizon for each live scheduled retry, keyed
 * by agent AND park reason (BLO-31174). Aggregating across reasons was the
 * second defect on this gauge: `max by (agent_id)` over classes whose ceilings
 * span at least 289x (300s to a floored `transient_failure` park's 86,700s; a
 * `provider_quota` floor has no ceiling) can only be thresholded at a value
 * that is simultaneously below one class's designed backoff and above
 * another's clamp.
 *
 * The reason is {@link refineScheduledRetryParkReason}d, not merely coerced:
 * the raw column's `transient_failure` covers three paths with three different
 * ceilings, so the bare column value cannot be bounded either. See that
 * function for the split and for why the quota path carries no bound at all.
 */
export function setScheduledRetryParkHorizonMetrics(
  entries: ReadonlyArray<{
    agentId: string | null | undefined;
    reason: string | null | undefined;
    horizonSeconds: number;
    hasRetryFloor?: boolean | null;
    isProviderQuotaFamily?: boolean | null;
  }>,
  knownAgentIds: ReadonlySet<string>,
): void {
  const gauge = ensureRegistry().scheduledRetryParkHorizonGauge;
  gauge.reset();
  // Every known agent carries a zero placeholder, so a drained agent reads 0
  // rather than vanishing. Emitted unconditionally: `none` is always 0, so it
  // can never win a `max by (agent_id)` over a real park, which is what keeps
  // the pre-BLO-31174 fleet-wide rule reading exactly as it did before.
  for (const agentId of knownAgentIds) {
    gauge.set({ agent_id: agentId, reason: NO_SCHEDULED_RETRY_PARK_REASON }, 0);
  }
  const maxByLabels = new Map<string, { agentId: string; reason: string; horizonSeconds: number }>();
  for (const entry of entries) {
    const agentId = normalizeAgentId(entry.agentId, knownAgentIds);
    const reason = refineScheduledRetryParkReason(entry);
    const horizonSeconds = Number.isFinite(entry.horizonSeconds) ? Math.max(0, entry.horizonSeconds) : 0;
    // Distinct reasons can fold to the same `other` label -- and the three
    // `transient_failure` refinements above split one GROUP BY key into
    // several while several fold back into one -- so re-max here rather than
    // trusting the query's GROUP BY to have produced unique keys.
    const key = `${agentId}\u0000${reason}`;
    const current = maxByLabels.get(key);
    if (current === undefined || horizonSeconds > current.horizonSeconds) {
      maxByLabels.set(key, { agentId, reason, horizonSeconds });
    }
  }
  for (const { agentId, reason, horizonSeconds } of maxByLabels.values()) {
    gauge.set({ agent_id: agentId, reason }, horizonSeconds);
  }
}

export function setScheduledRetryParkHorizonRefreshSuccess(success: boolean): void {
  ensureRegistry().scheduledRetryParkHorizonRefreshSuccessGauge.set(success ? 1 : 0);
}

/** Snapshot of postgres.js pool occupancy (BLO-33243). Plain numbers — reading them touches no socket. */
export interface DbPoolStats {
  max: number;
  idle: number;
  active: number;
  connecting: number;
  waiting: number;
}

/**
 * Publish a pool snapshot (BLO-33243). Called on the `/metrics` request path
 * rather than from the background collector on purpose: the reading costs
 * nothing (it is four in-memory queue lengths, no query, no await) and the
 * moment worth sampling is scrape time. A collector tick blocked waiting for a
 * connection is exactly when the pool is interesting and exactly when it would
 * fail to report.
 */
export function setDbPoolStats(stats: DbPoolStats, pool: "main" | "webhook" = "main"): void {
  const { dbPoolConnectionsGauge, dbPoolWaitingQueriesGauge } = ensureRegistry();
  dbPoolConnectionsGauge.set({ pool, state: "max" }, stats.max);
  dbPoolConnectionsGauge.set({ pool, state: "idle" }, stats.idle);
  dbPoolConnectionsGauge.set({ pool, state: "active" }, stats.active);
  dbPoolConnectionsGauge.set({ pool, state: "connecting" }, stats.connecting);
  dbPoolWaitingQueriesGauge.set({ pool }, stats.waiting);
}

/**
 * One inherited timeout setting, as {@link readInheritedTimeoutSettings}
 * reports it. Declared structurally here, like {@link DbPoolStats}, so the
 * metrics module keeps no dependency on `@paperclip/db`.
 *
 * `valueMs === null` is the probe's encoding for "disabled".
 */
export interface DbInheritedTimeoutSetting {
  readonly name: string;
  readonly valueMs: number | null;
  readonly source: string;
}

/**
 * Publish the inherited timeout environment (PEN-3365).
 *
 * Called once at startup, from the same probe that logs
 * `Database timeout environment: …`, because that log line is unreadable in
 * practice — see {@link DB_INHERITED_TIMEOUT_METRIC} for the measurement.
 *
 * `reset()` first so a re-probe cannot leave a stale `source` series alongside
 * the current one: `source` is a label, so a value moving from `default` to
 * `user` would otherwise publish both, and a reader taking the max or the
 * first would silently get the retired reading.
 *
 * `null` is published as `0`, which is Postgres' own encoding for a disabled
 * timeout and what `pg_settings` returns. That keeps `== 0` meaning "unbounded"
 * for a reader who knows Postgres, rather than inventing a sentinel.
 */
export function setDbInheritedTimeouts(settings: readonly DbInheritedTimeoutSetting[]): void {
  const { dbInheritedTimeoutGauge } = ensureRegistry();
  dbInheritedTimeoutGauge.reset();
  for (const { name, valueMs, source } of settings) {
    dbInheritedTimeoutGauge.set({ setting: name, source }, valueMs === null ? 0 : valueMs / 1000);
  }
}

/**
 * Count one dispatch section cancelled for overrunning the start-lock budget
 * (PEN-3328).
 *
 * Incremented from the lock itself rather than from a scrape-path refresh: an
 * abort is an *event*, and by the time the next scrape arrives the section has
 * released its lock and left nothing behind to sample. Whether the cancellation
 * then landed is not recorded here — see the metric's doc comment; a
 * cancellation that did not land leaves the gauge high, which is the reading
 * that already means "this agent is still not dispatching".
 */
export function recordAgentStartLockAborted(agentId: string): void {
  ensureRegistry().agentStartLockAbortedTotalCounter.inc({ agent_id: agentId });
}

/** Increment {@link HEARTBEAT_DUPLICATE_DISPATCH_SUPPRESSED_METRIC}. Call once per landed cancel. */
export function recordDuplicateDispatchSuppressed(): void {
  ensureRegistry().duplicateDispatchSuppressedCounter.inc();
}

/**
 * Create this agent's aborted-counter series at 0 when it takes the start lock,
 * before any abort has happened (PEN-3328 review).
 *
 * Load-bearing for PaperclipAgentStartLockAborted, not cosmetic. prom-client
 * renders no series at all for a labelled metric that has never been written
 * (confirmed against the pinned 15.1.3), so without this seed the series is
 * BORN AT 1 on the first abort. `increase()` needs two samples in the range and
 * takes `last - first`: at the first evaluation after birth there is one sample
 * and the element is dropped, and at every later one the samples read
 * `[1, 1, …]`, so the result is 0. Prometheus's counter-birth extrapolation in
 * `extrapolatedRate` is gated on `resultValue > 0` and therefore does not
 * rescue it. `increase(...[1h]) > 0` would be permanently false for the FIRST
 * abort of any `agent_id` on any pod — and since the 4h budget is ~1.8x the
 * worst hold ever measured settling on its own, and a deploy resets the series,
 * in practice every real abort is a first abort. The alert would have been
 * silent for all of them, leaving exactly the self-healed-wedge blind spot it
 * was added to close.
 *
 * Seeded at ACQUISITION rather than at process start because that is what keeps
 * the `agent_id` label the alert's annotation reads — a boot-time seed has no
 * agent to name. The gap between this 0 and any increment is LOCK_ABORT_MS (4h),
 * thousands of scrape intervals, so the 0 is always sampled long before the 1;
 * the seed could not be squeezed into a single scrape even deliberately.
 * Cardinality is one series per agent per pod, the same bound the held gauge
 * already accepts while locks are held.
 *
 * Same discipline, and for the same reason, as ALERTING_GITHUB_SUPPRESSION_CAUSES
 * and the unlabeled `heartbeatTimerChecked` above: a series an alert *selects*
 * must exist before its first event, because absent-vs-zero is not a
 * distinction the query language can make after the fact.
 */
export function seedAgentStartLockAbortedSeries(agentId: string): void {
  ensureRegistry().agentStartLockAbortedTotalCounter.inc({ agent_id: agentId }, 0);
}

/**
 * Publish the currently-held agent start locks and their hold ages (PEN-3305).
 *
 * Reset-then-set, but unlike the per-agent reservation gauges this does NOT
 * zero-fill known agents: a held lock is the exception, not a per-agent
 * property, and zero-filling every agent would turn a near-empty series into
 * one row per agent per pod forever. An absent series therefore means "no lock
 * held", and `reset()` is what releases a series when its section finishes —
 * without it a completed hold would keep reporting its final age and hold an
 * alert open permanently.
 *
 * Called from the `/metrics` request path (see `refreshAgentStartLockMetrics`)
 * because the reading is a synchronous in-memory map walk, and because the
 * scenario worth sampling is a section wedged on the database — exactly when a
 * DB-backed background collector would be stuck and publish nothing.
 */
export function setAgentStartLockHeldMetrics(
  held: ReadonlyArray<{ agentId: string; heldMs: number; phase?: string; phaseMs?: number }>,
): void {
  const registry = ensureRegistry();
  const gauge = registry.agentStartLockHeldSecondsGauge;
  const phaseGauge = registry.agentStartLockPhaseSecondsGauge;
  gauge.reset();
  phaseGauge.reset();
  for (const entry of held) {
    const heldMs = Number.isFinite(entry.heldMs) ? Math.max(0, entry.heldMs) : 0;
    gauge.set({ agent_id: entry.agentId }, heldMs / 1000);
    const phase = entry.phase;
    if (!phase) continue;
    const rawPhaseMs = entry.phaseMs ?? 0;
    const phaseMs = Number.isFinite(rawPhaseMs) ? Math.max(0, rawPhaseMs) : 0;
    phaseGauge.set({ agent_id: entry.agentId, phase }, phaseMs / 1000);
  }
}

/**
 * PEN-3314: publish the descriptor-class histogram.
 *
 * Reset-then-set, and the `reset()` is load-bearing rather than hygienic: a
 * class that stops appearing must stop being published, because the question
 * this gauge answers is "which class is *currently* accumulating". Without it,
 * a directory whose descriptors were all closed would keep reporting its final
 * count forever and read as a leak that had plateaued.
 *
 * A `null` snapshot publishes nothing at all, deliberately — see
 * {@link collectFdClassSnapshot}, which returns `null` only where there is no
 * procfs to read (`ENOENT`/`ENOTDIR`). "Cannot measure descriptors here" and
 * "has no descriptors" must not render identically. An *unreadable* procfs is
 * not `null`: it arrives as a lone `table-unreadable`
 * (`FD_CLASS_TABLE_UNREADABLE`) class with value 0, and is published like any
 * other class — the series' presence is the signal, so this loop must not skip
 * zero counts.
 */
export function setFdClassMetrics(snapshot: FdClassSnapshot | null): void {
  const gauge = ensureRegistry().processOpenFdsByClassGauge;
  gauge.reset();
  if (!snapshot) return;
  for (const [fdClass, count] of snapshot.classes) {
    gauge.set({ fd_class: fdClass }, count);
  }
}

/**
 * PEN-3314: publish the native-memory accounting.
 *
 * Reset-then-set for the same reason as {@link setFdClassMetrics}: a component
 * this runtime stops reporting must stop being published, or its last value
 * freezes in place and reads as a pool that stopped growing.
 *
 * A `null` snapshot publishes nothing at all — see
 * {@link collectNativeMemorySnapshot}, which returns `null` only when the
 * readings could not be taken. "Cannot measure" and "measured zero" must not
 * render identically, and that distinction is sharper here than anywhere else in
 * this file: a flat zero line is exactly what the heap gauge was showing while
 * this process leaked 87 MB/h.
 *
 * The loops must not skip zero values. `detached` contexts are 0 in the healthy
 * state, and that 0 is the measurement.
 */
export function setNativeMemoryMetrics(snapshot: NativeMemorySnapshot | null): void {
  const metrics = ensureRegistry();
  metrics.processMemoryComponentBytesGauge.reset();
  metrics.processV8ContextCountGauge.reset();
  // `remove()`, NOT `reset()`, and the difference is the whole point of the
  // series. prom-client renders a LABEL-LESS gauge as `name 0` from the moment
  // it is registered, and `reset()` returns it to that same 0 -- so a sampler
  // that has never run would publish a flat zero, which rate() reads as a
  // permanently stalled event loop. That is the measured-versus-unmeasurable
  // conflation this whole module exists to avoid, and it is reachable here in a
  // way it is not on the labelled gauges above, where `reset()` does drop the
  // series. `remove()` deletes it outright, so absent stays absent.
  //
  // This is NOT what makes the registration-time 0 unobservable -- the gauge is
  // already `remove()`d at construction (see its definition), so the 0 is gone
  // before any scrape, whatever order `/metrics` calls its refreshers in. What
  // this call does is keep it gone on every LATER scrape, once the sampler has
  // stopped reporting a count again.
  metrics.processHeapPeakSamplesGauge.remove();
  if (!snapshot) return;
  for (const [component, bytes] of snapshot.components) {
    metrics.processMemoryComponentBytesGauge.set({ component }, bytes);
  }
  for (const [kind, count] of snapshot.contexts) {
    metrics.processV8ContextCountGauge.set({ kind }, count);
  }
  // `null` means the sampler has never ticked, so publish nothing. Zero is not
  // an available reading here (the tracker returns null until its first
  // sample), which is what keeps "absent" unambiguous.
  if (snapshot.heapPeakSampleCount !== null) {
    metrics.processHeapPeakSamplesGauge.set(snapshot.heapPeakSampleCount);
  }
}

/**
 * PEN-3314: publish the RSS release record.
 *
 * `remove()` on every series, NOT `reset()`, for the reason spelled out on
 * {@link setNativeMemoryMetrics}: these are label-less gauges, `reset()` returns
 * a label-less gauge to a *published* 0, and here each of those zeroes is a
 * specific wrong answer rather than merely a vague one — no release ever
 * happened, nothing was ever returned, the release began in 1970, and a sampler
 * that `rate()` reads as a permanently stalled event loop.
 *
 * The three `last_*` series stay ABSENT until an episode has actually been
 * observed, which is why they are published from a `null` check rather than
 * defaulted. "This process has not released since it started" is a real and
 * interesting reading, and it must not be rendered as a release of zero bytes at
 * epoch 1970 — a reader computing `time() - onset` on that would get 56 years.
 *
 * A `null` reading publishes nothing at all: the sampler has never ticked, and
 * on this row "cannot measure" and "measured zero" must never render identically.
 */
export function setRssReleaseMetrics(reading: RssReleaseReading | null): void {
  const metrics = ensureRegistry();
  metrics.processRssReleaseEventsGauge.remove();
  metrics.processRssReleaseBytesGauge.remove();
  metrics.processRssReleaseLastOnsetTimestampGauge.remove();
  metrics.processRssReleaseLastDetectedTimestampGauge.remove();
  metrics.processRssReleaseLastBytesGauge.remove();
  metrics.processRssReleaseSamplesGauge.remove();
  metrics.processRssReleaseBoundBytesGauge.reset();
  if (!reading) return;

  // Published even at 0, unlike the `last_*` series below: a live sampler that
  // has seen no release is exactly what this series is for, and it is readable
  // as such only because the sample count beside it says the sampler is alive.
  metrics.processRssReleaseEventsGauge.set(reading.releaseCount);
  metrics.processRssReleaseBytesGauge.set(reading.releasedBytesTotal);
  metrics.processRssReleaseSamplesGauge.set(reading.sampleCount);
  // The bounds in force, so every null above is readable as "below this" rather
  // than as "nothing happened". Set from the reading, never from the constants,
  // so an injected threshold cannot be contradicted by its own help text.
  metrics.processRssReleaseBoundBytesGauge.set({ bound: "threshold" }, reading.thresholdBytes);
  metrics.processRssReleaseBoundBytesGauge.set({ bound: "plateau_band" }, reading.plateauBandBytes);

  if (reading.lastOnsetAtMs !== null) {
    metrics.processRssReleaseLastOnsetTimestampGauge.set(reading.lastOnsetAtMs / 1000);
  }
  if (reading.lastDetectedAtMs !== null) {
    metrics.processRssReleaseLastDetectedTimestampGauge.set(reading.lastDetectedAtMs / 1000);
  }
  if (reading.lastReleaseBytes !== null) {
    metrics.processRssReleaseLastBytesGauge.set(reading.lastReleaseBytes);
  }
}

/**
 * PEN-3692: publish the worker cgroup's own memory decomposition.
 *
 * `reset()` on the labelled gauge so a component this kernel stops reporting
 * stops being published rather than freezing its last value.
 *
 * The three scalars use `remove()`, NOT `reset()`, for the reason spelled out on
 * {@link setNativeMemoryMetrics}: `reset()` returns a label-less gauge to a
 * *published* 0. Here each of those zeroes is a specific wrong answer rather
 * than merely a vague one — a zero-byte limit, a cgroup charging nothing, and a
 * high-water mark of nothing ever — and the limit's zero additionally turns any
 * `current / max` headroom expression into a division by zero instead of leaving
 * it with no data.
 *
 * A `null` snapshot publishes NOTHING. That is the module's central property,
 * not housekeeping: `memory.stat` unreadable, or readable but cgroup v1, must
 * never render as a measured `slab_reclaimable 0` — which is precisely the
 * reading someone would cite as refuting PEN-3692's hypothesis.
 */
export function setCgroupMemoryMetrics(snapshot: CgroupMemorySnapshot | null): void {
  const metrics = ensureRegistry();
  metrics.cgroupMemoryComponentBytesGauge.reset();
  metrics.cgroupMemoryCurrentBytesGauge.remove();
  metrics.cgroupMemoryMaxBytesGauge.remove();
  metrics.cgroupMemoryPeakBytesGauge.remove();
  if (!snapshot) return;
  for (const [component, bytes] of snapshot.components) {
    metrics.cgroupMemoryComponentBytesGauge.set({ component }, bytes);
  }
  // `currentBytes` is non-null by construction: the collector refuses the whole
  // snapshot without it, because its absence is how a root-cgroup read is told
  // apart from our own. A non-null snapshot therefore always has a charge.
  metrics.cgroupMemoryCurrentBytesGauge.set(snapshot.currentBytes);
  // The remaining scalars ARE independently optional, and `null` means "this
  // file was not readable" or, for the limit, "this cgroup is unlimited".
  // Publish nothing in either case; see the gauges' help text.
  if (snapshot.maxBytes !== null) {
    metrics.cgroupMemoryMaxBytesGauge.set(snapshot.maxBytes);
  }
  if (snapshot.peakBytes !== null) {
    metrics.cgroupMemoryPeakBytesGauge.set(snapshot.peakBytes);
  }
}

/**
 * PEN-3314: publish the mapping-class attribution.
 *
 * Reset-then-set on the labelled pair for the same reason as
 * {@link setNativeMemoryMetrics}: a class that stops being reported must stop
 * being published rather than freezing its last value.
 *
 * The three label-less gauges use `remove()` instead, for the reason spelled
 * out on {@link setNativeMemoryMetrics}'s `processHeapPeakSamplesGauge` call —
 * `reset()` on a label-less gauge returns it to a *published* 0 rather than
 * deleting it. Here that would be worse than merely ambiguous: a 0 scan
 * timestamp dates the last scan to 1970, so the staleness expression this
 * series exists to support (`time() - timestamp`) would read ~56 years instead
 * of going absent.
 *
 * A `null` snapshot publishes nothing at all — {@link collectProcessMappingSnapshot}
 * returns `null` only when `/proc/self/smaps` could not be read, and "no procfs
 * on this host" must not render as "this process maps nothing".
 *
 * Zero-valued classes ARE published: a readable smaps that contains no
 * secondary arenas is a measurement of zero arenas, which is the control
 * reading the arena hypothesis is tested against.
 */
export function setProcessMappingMetrics(snapshot: ProcessMappingSnapshot | null): void {
  const metrics = ensureRegistry();
  metrics.processMappingRssBytesGauge.reset();
  metrics.processMappingCountGauge.reset();
  metrics.processMappingSizeBucketCountGauge.reset();
  metrics.processMappingSizeBucketBytesGauge.reset();
  metrics.processGlibcSecondaryArenaHeapCountGauge.remove();
  metrics.processMappingScanSecondsGauge.remove();
  metrics.processMappingScanTimestampGauge.remove();
  if (!snapshot) return;
  for (const [mappingClass, bytes] of snapshot.rssByClass) {
    metrics.processMappingRssBytesGauge.set({ mapping_class: mappingClass }, bytes);
  }
  for (const [mappingClass, count] of snapshot.countByClass) {
    metrics.processMappingCountGauge.set({ mapping_class: mappingClass }, count);
  }
  for (const [bucket, count] of snapshot.sizeBucketCount) {
    metrics.processMappingSizeBucketCountGauge.set({ size_bucket: bucket }, count);
  }
  for (const [bucket, bytes] of snapshot.sizeBucketBytes) {
    metrics.processMappingSizeBucketBytesGauge.set({ size_bucket: bucket }, bytes);
  }
  metrics.processGlibcSecondaryArenaHeapCountGauge.set(snapshot.secondaryArenaHeapCount);
  metrics.processMappingScanSecondsGauge.set(snapshot.scanSeconds);
  metrics.processMappingScanTimestampGauge.set(snapshot.scanTimestampSeconds);
}

/**
 * BLO-21460. Set from the residual backlog measured AFTER each reconciliation
 * pass (`reapOrphanedRuns` -> `reconcileReleasePendingExternalRuntimeReservations`),
 * not the pre-pass candidate count — see the metric's doc comment for why 0 is
 * the only healthy steady-state value.
 */
export function setReleasePendingExternalRuntimeReservationMetrics(input: {
  count: number;
  oldestAgeSeconds: number;
}): void {
  const metrics = ensureRegistry();
  metrics.externalRuntimeReservationsReleasePendingGauge.set(Math.max(0, input.count));
  metrics.externalRuntimeReservationReleasePendingOldestAgeGauge.set(Math.max(0, input.oldestAgeSeconds));
}

/** BLO-21460. Same residual-after-reconciliation convention as above, for leases. */
export function setOrphanedEnvironmentLeaseMetrics(input: {
  active: number;
  oldestAgeSeconds: number;
}): void {
  const metrics = ensureRegistry();
  metrics.environmentLeasesOrphanedActiveGauge.set(Math.max(0, input.active));
  metrics.environmentLeasesOrphanedOldestAgeGauge.set(Math.max(0, input.oldestAgeSeconds));
}

/**
 * BLO-21460. Freshness gate for the four backlog gauges above. Set `false`
 * when the reconciliation pass threw before the refresh could run, so the
 * alert can distinguish "measured 0" from "held a stale 0".
 */
export function setOrphanedRuntimeResourceMetricsRefreshSuccess(success: boolean): void {
  ensureRegistry().orphanedRuntimeResourceMetricsRefreshSuccessGauge.set(success ? 1 : 0);
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

/**
 * Publish the per-project-workspace refusal counts for the current window
 * (PEN-3633 item 3).
 *
 * Reset-then-set, and NOT seeded. The companion closed-vocabulary seed that
 * {@link setApprovalQueueMetrics} performs is deliberately not done here: its
 * label set is bounded on every axis, whereas `project_workspace_id` is not, so
 * seeding would mean emitting a zero series for every project workspace that
 * has ever existed. Absence is already unambiguous for this metric because the
 * alert thresholds with `>=`, which no absent series can satisfy, and the
 * companion refresh-success gauge separates "measured none" from "did not
 * measure".
 */
export function setWorkspaceReuseRefusalWindowMetrics(
  entries: ReadonlyArray<{
    projectWorkspaceId: string;
    failureClass: string;
    count: number;
  }>,
): void {
  const gauge = ensureRegistry().workspaceReuseRefusalWindowGauge;
  gauge.reset();
  for (const entry of entries) {
    if (!entry.projectWorkspaceId || !entry.failureClass) continue;
    const count = Number.isFinite(entry.count) ? Math.max(0, entry.count) : 0;
    gauge.set(
      { project_workspace_id: entry.projectWorkspaceId, failure_class: entry.failureClass },
      count,
    );
  }
}

/** Mark whether the workspace-reuse-refusal gauge was refreshed from the database. */
export function setWorkspaceReuseRefusalMetricsRefreshSuccess(success: boolean): void {
  ensureRegistry().workspaceReuseRefusalMetricsRefreshSuccessGauge.set(success ? 1 : 0);
}

/** One project checkout whose git origin disagrees with its workspace's `repo_url` (PEN-4188). */
export type ProjectCheckoutOriginMismatchEntry = {
  projectWorkspaceId: string;
  companyId: string;
  projectId: string;
  cwd: string;
  actualUrl: string;
  expectedRepoUrl: string;
};

/**
 * Publish the origin-mismatch set and the count it was derived from (PEN-4188).
 *
 * The two are set TOGETHER, by one function, on purpose. They are a claim and
 * its positive control, and the failure this guards against is publishing the
 * claim without the control: an empty mismatch set from a pass that compared
 * nothing is indistinguishable from a healthy estate, and reads as recovery on
 * any threshold alert.
 *
 * Reset-then-set and NOT seeded, for the same reason as
 * {@link setWorkspaceReuseRefusalWindowMetrics}: `project_workspace_id` is
 * unbounded, so seeding would emit a zero series for every project workspace
 * that has ever existed. The URLs are deliberately NOT labels -- they are
 * unbounded strings and belong in the log line the reconciler emits beside
 * this, which carries both in full.
 */
export function setProjectCheckoutOriginMismatchMetrics(
  mismatches: ReadonlyArray<ProjectCheckoutOriginMismatchEntry>,
  comparedCount: number,
): void {
  const registry = ensureRegistry();
  const gauge = registry.projectCheckoutOriginMismatchGauge;
  gauge.reset();
  for (const mismatch of mismatches) {
    if (!mismatch.projectWorkspaceId) continue;
    gauge.set(
      {
        project_workspace_id: mismatch.projectWorkspaceId,
        company_id: mismatch.companyId || "unknown",
        project_id: mismatch.projectId || "unknown",
      },
      1,
    );
  }
  registry.projectCheckoutOriginReconcileComparedGauge.set(
    Number.isFinite(comparedCount) ? Math.max(0, comparedCount) : 0,
  );
}

/** Mark whether the most recent project-checkout origin reconcile pass completed. */
export function setProjectCheckoutOriginReconcileMetricsRefreshSuccess(success: boolean): void {
  ensureRegistry().projectCheckoutOriginReconcileMetricsRefreshSuccessGauge.set(success ? 1 : 0);
}

/**
 * Publish board-approval-queue depth, oldest-pending age, and last-board-decision
 * timestamp (BLO-29850). Reset-then-set like
 * {@link setExternalRuntimeReservationStrandedOldestAgeMetrics}, plus one thing
 * that setter cannot do: the pending gauge is SEEDED with 0 for every known
 * `APPROVAL_TYPES` value under every `(company_id, requester)` channel that has
 * any approval history, before the query rows are applied. The query only
 * returns types that have pending rows, so without the seed a drained type (and
 * a drained channel) is absent rather than 0 -- and an absent series is exactly
 * what "never exported" looks like. Cardinality is channels x types, which is
 * small; a row outside the enum still gets its own series.
 *
 * The oldest-pending-age gauge is deliberately NOT seeded: a type with nothing
 * pending has no oldest card, and 0 would read as "a card filed this instant".
 * Its absence is unambiguous because the seeded pending gauge reads 0 alongside.
 *
 * The last-decision gauge is reset every refresh and written for EVERY channel
 * with history, as `0` when that channel has never had a decision. That 0 is the
 * rule contract (BLO-48410): a never-served agent channel must read as maximally
 * stale, not drop out of the vector. Do NOT "restore" leaving it absent. The
 * cold-start false positive is prevented by the rules' gates -- per-channel
 * `paperclip_approvals_pending > 0` plus `refresh_success == 1` -- not here.
 */
export function setApprovalQueuePendingMetrics(input: {
  /** Every (company_id, requester) pair with any approval history; seeded with 0s. */
  channels: ReadonlyArray<{
    companyId: string;
    requester: string;
    lastDecisionTimestampSeconds: number | null;
  }>;
  entries: ReadonlyArray<{
    companyId: string;
    requester: string;
    type: string;
    pending: number;
    oldestAgeSeconds: number;
  }>;
}): void {
  const metrics = ensureRegistry();
  metrics.approvalsPendingGauge.reset();
  metrics.approvalOldestPendingAgeGauge.reset();
  metrics.approvalLastDecisionTimestampGauge.reset();
  for (const channel of input.channels) {
    const labels = { company_id: channel.companyId, requester: channel.requester };
    for (const type of APPROVAL_TYPES) metrics.approvalsPendingGauge.set({ ...labels, type }, 0);
    const at = channel.lastDecisionTimestampSeconds;
    // 0 = never decided. The rule contract needs the series present (BLO-48410).
    metrics.approvalLastDecisionTimestampGauge.set(
      labels,
      at !== null && Number.isFinite(at) ? Math.max(0, at) : 0,
    );
  }
  for (const entry of input.entries) {
    const labels = {
      company_id: entry.companyId,
      requester: entry.requester,
      type: entry.type || "unknown",
    };
    const pending = Number.isFinite(entry.pending) ? Math.max(0, entry.pending) : 0;
    const age = Number.isFinite(entry.oldestAgeSeconds) ? Math.max(0, entry.oldestAgeSeconds) : 0;
    metrics.approvalsPendingGauge.set(labels, pending);
    metrics.approvalOldestPendingAgeGauge.set(labels, age);
  }
}

/** Mark whether the approval-queue gauges were refreshed from the database. */
export function setApprovalQueueMetricsRefreshSuccess(success: boolean): void {
  ensureRegistry().approvalQueueMetricsRefreshSuccessGauge.set(success ? 1 : 0);
}

/**
 * Publish the accepted-interaction outcome buckets (PEN-4409).
 *
 * The COUNT gauge is SEEDED with 0 for all three buckets before the entries are
 * applied, so a bucket that is genuinely empty reads back an explicit 0 rather
 * than vanishing. That matters most for `untracked`: an absent series and a
 * never-exported series are indistinguishable, and "no untracked acceptances"
 * is a claim this family has to be able to make out loud.
 *
 * The OLDEST-AGE gauge is deliberately NOT seeded, for the reason spelled out in
 * {@link setApprovalQueuePendingMetrics}: a bucket with nothing in it has no
 * oldest card, and 0 would read as an acceptance made this instant. Its absence
 * is unambiguous because the seeded count gauge reads 0 beside it.
 */
export function setAcceptedInteractionOutcomeMetrics(input: {
  entries: ReadonlyArray<{
    bucket: string;
    count: number;
    /** Oldest age per owning company id (BLO-48606). */
    oldestAgeSecondsByCompany: Readonly<Record<string, number>>;
    recentCount?: number;
  }>;
}): void {
  const metrics = ensureRegistry();
  metrics.acceptedInteractionOutcomeGauge.reset();
  metrics.acceptedInteractionOutcomeOldestAgeGauge.reset();
  metrics.acceptedInteractionOutcomeRecentGauge.reset();
  for (const bucket of ACCEPTED_INTERACTION_OUTCOME_BUCKETS) {
    metrics.acceptedInteractionOutcomeGauge.set({ bucket }, 0);
    // Seeded, unlike the oldest-age gauge. An empty bucket really does have a
    // recent count of zero, and the untracked alert divides by the sum of these
    // -- a missing series would make that denominator silently drop a bucket.
    metrics.acceptedInteractionOutcomeRecentGauge.set({ bucket }, 0);
  }
  for (const entry of input.entries) {
    const bucket = entry.bucket || "unknown";
    const count = Number.isFinite(entry.count) ? Math.max(0, entry.count) : 0;
    metrics.acceptedInteractionOutcomeGauge.set({ bucket }, count);
    const recent = Number.isFinite(entry.recentCount) ? Math.max(0, entry.recentCount as number) : 0;
    metrics.acceptedInteractionOutcomeRecentGauge.set({ bucket }, recent);
    for (const [companyId, ageSeconds] of Object.entries(entry.oldestAgeSecondsByCompany)) {
      if (!Number.isFinite(ageSeconds)) continue;
      metrics.acceptedInteractionOutcomeOldestAgeGauge.set(
        { bucket, company_id: companyId },
        Math.max(0, ageSeconds),
      );
    }
  }
}

/** Mark whether the accepted-interaction outcome sweep completed. */
/**
 * Distinct `payload_key` label values this process has already published.
 *
 * Kept alongside the counter rather than derived from the registry because
 * prom-client offers no cheap "how many children does this counter have"
 * read, and the budget check sits on the request path. Cleared by
 * {@link __resetMetricsForTest} so a test that exercises the budget does not
 * leak its exhaustion into the next one.
 */
const publishedUnrecognizedPayloadKeys = new Set<string>();

/**
 * Coerce one dropped key name into a bounded `payload_key` label value.
 *
 * Two independent bounds, because they fail differently. The SHAPE bound keeps
 * a key name that is not identifier-shaped out of the exposition entirely:
 * prom-client escapes only `\`, `\n` and `"`, so every other control
 * character reaches the scraper verbatim, and this value is caller-chosen. The
 * BUDGET bound keeps the series count finite: prom-client never retires a
 * label combination, so without it one caller generating key names would grow
 * this metric for the process lifetime.
 *
 * Both degrade to a reserved value rather than dropping the observation. The
 * count is the part an alert thresholds and it stays exact either way; only
 * the per-key breakdown is given up, and only for the keys that forced it.
 */
function unrecognizedPayloadKeyLabel(key: string): string {
  if (!UNRECOGNIZED_PAYLOAD_KEY_REGEX.test(key)) return UNRECOGNIZED_PAYLOAD_KEY_MALFORMED;
  if (publishedUnrecognizedPayloadKeys.has(key)) return key;
  if (publishedUnrecognizedPayloadKeys.size >= UNRECOGNIZED_PAYLOAD_KEY_BUDGET) {
    return UNRECOGNIZED_PAYLOAD_KEY_OVERFLOW;
  }
  publishedUnrecognizedPayloadKeys.add(key);
  return key;
}

/**
 * Record the top-level payload keys an interaction create dropped (PEN-4445).
 *
 * Call this only AFTER the card has actually been created. A request that was
 * refused by authorization or by validation says nothing about schema skew,
 * and counting it would let an unauthorized caller write into the series.
 *
 * Returns the published label values so a caller — in practice the test — can
 * assert what landed on the metric without re-deriving the coercion.
 */
export function recordUnrecognizedInteractionPayloadKeys(
  interactionKind: string,
  keys: readonly string[],
): Array<{ interaction_kind: string; payload_key: string }> {
  if (keys.length === 0) return [];
  const counter = ensureRegistry().interactionPayloadUnrecognizedKeyCounter;
  const recorded: Array<{ interaction_kind: string; payload_key: string }> = [];
  for (const key of keys) {
    const labels = {
      interaction_kind: interactionKind,
      payload_key: unrecognizedPayloadKeyLabel(key),
    };
    counter.inc(labels);
    recorded.push(labels);
  }
  return recorded;
}

export function setAcceptedInteractionOutcomeMetricsRefreshSuccess(success: boolean): void {
  ensureRegistry().acceptedInteractionOutcomeMetricsRefreshSuccessGauge.set(success ? 1 : 0);
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
 * Seconds a run spent queued before it started (BLO-25024).
 *
 * Unlike `computePrReviewQueueWaitSeconds` there is no task-key gate — every
 * run counts. Returns null only when the interval is genuinely unmeasurable
 * (a missing or unparseable timestamp), so an absent observation always means
 * "no sample", never "a sample of zero". Clamped at 0 so clock skew between
 * the inserting and claiming processes cannot emit a negative observation,
 * which would corrupt the histogram sum and therefore any p95 derived from it.
 */
export function computeRunDispatchWaitSeconds(
  queueEnteredAt: Date | string | null | undefined,
  startedAt: Date | string | null | undefined,
): number | null {
  if (!queueEnteredAt || !startedAt) return null;
  const queueEnteredMs = new Date(queueEnteredAt).getTime();
  const startedMs = new Date(startedAt).getTime();
  if (!Number.isFinite(queueEnteredMs) || !Number.isFinite(startedMs)) return null;
  return Math.max(0, (startedMs - queueEnteredMs) / 1000);
}

/**
 * The dispatch-wait clock starts at `coalesce(queuedAt, createdAt)`, the same
 * expression `refreshQueuedRunAgeMetrics` ages off (BLO-21116). `queuedAt` is
 * null for a fresh insert, where `createdAt` already is the queue-entry time,
 * and is stamped by the transitions that put an existing row back into
 * `queued` (`promoteScheduledRetryRun`, `deferRunForK8sIsolationConflict`,
 * `deferRunForBranchClaimConflict`).
 * Measuring from bare `createdAt` would report a promoted retry's whole
 * `scheduled_retry` backoff, or a re-queued run's whole prior execution, as
 * dispatch wait.
 */
export function recordRunDispatchWait(input: {
  invocationSource: string | null | undefined;
  queuedAt: Date | string | null | undefined;
  createdAt: Date | string | null | undefined;
  startedAt: Date | string | null | undefined;
}): number | null {
  const waitSeconds = computeRunDispatchWaitSeconds(input.queuedAt ?? input.createdAt, input.startedAt);
  if (waitSeconds === null) return null;
  const invocation_source = RUN_DISPATCH_WAIT_INVOCATION_SOURCES.includes(
    input.invocationSource as (typeof RUN_DISPATCH_WAIT_INVOCATION_SOURCES)[number],
  )
    ? (input.invocationSource as string)
    : "other";
  ensureRegistry().runDispatchWaitHistogram.observe({ invocation_source }, waitSeconds);
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
 * Record one attempted GitHub API call (PEN-3852).
 *
 * Called from the shared GitHub fetch wrapper immediately BEFORE the request
 * leaves, so the
 * denominator counts attempts rather than successes — see
 * {@link GITHUB_API_REQUESTS_METRIC} for why that distinction is what keeps the
 * signal readable during a network-level outage.
 */
export function recordGithubApiRequest(): void {
  ensureRegistry().githubApiRequestsCounter.inc();
}

/**
 * Record one GitHub refusal, already classified (PEN-3852).
 *
 * Takes the narrow {@link GithubApiRefusalReason} rather than a string, so an
 * unclassifiable response is a compile error at the call site instead of a new
 * label child appearing in production. The shared GitHub fetch wrapper is the
 * only caller; the classification itself lives there, next to the response it
 * reads.
 */
export function recordGithubApiRefusal(reason: GithubApiRefusalReason): void {
  ensureRegistry().githubApiRefusalsCounter.inc({ reason });
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
    const key = `${errorCode}\u0000${scope}`;
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
        normalized.get(`${errorCode}\u0000${scope}`) ?? 0,
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
 * Record one inbound GitHub webhook delivery (BLO-39378). Call exactly once
 * per delivery, on every exit path including signature rejection and
 * unhandled error — a delivery that is counted only when it succeeds cannot
 * distinguish "deliveries stopped" from "deliveries are all being rejected",
 * and both are shape-B faults.
 *
 * `event` is normalized against the allowlist here rather than at the call
 * site, so an untrusted `x-github-event` header can never mint a new series.
 */
export function recordGithubWebhookDelivery(input: {
  event: string | null | undefined;
  outcome: GithubWebhookDeliveryOutcome;
}): string {
  const eventLabel = normalizeGithubWebhookEvent(input.event);
  ensureRegistry().githubWebhookDeliveryCounter.inc({
    event: eventLabel,
    outcome: input.outcome,
  });
  return eventLabel;
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

/**
 * Publish whether the worker-crash recovery candidate index is usable right
 * now (BLO-21526). Called from the periodic probe that already gates the
 * reconciliation scan, so the gauge tracks the same fact the gate acts on
 * instead of a second, independently-drifting catalog read.
 *
 * `present === null` means the probe itself failed, which is not evidence in
 * either direction: the series is cleared so it reads as absent/unknown rather
 * than leaving a stale 1 that would say "healthy" on no information at all.
 */
export function setCrashRecoveryCandidateIndexPresent(present: boolean | null): void {
  const gauge = ensureRegistry().crashRecoveryCandidateIndexPresentGauge;
  if (present === null) {
    gauge.reset();
    return;
  }
  gauge.set({ index: CRASH_RECOVERY_CANDIDATE_INDEX_NAME }, present ? 1 : 0);
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
    // Seeded empty: the ledger key below carries `name`, so repeating it in
    // every combination string adds no discriminating power — only an extra
    // copy of it per combination, up to NAME_BUDGET x CARDINALITY_BUDGET of
    // them per plugin.
    const comboParts: string[] = [];
    let truncatedValue = false;
    let sanitizedValue = false;
    for (const key of PLUGIN_METRIC_PROMOTABLE_TAG_KEYS) {
      const raw = declared.has(key) ? input.tags?.[key] : undefined;
      // Only primitives promote. `String(raw)` on an object yields the constant
      // "[object Object]", which is not a breach (it is low-cardinality) but is
      // a label value that identifies nothing -- worse than an absent label,
      // because a rule author reading the series cannot tell it from a real
      // value. An array would flatten to a comma-joined string of unbounded
      // arity. Both are treated as "not supplied".
      let promoted = "";
      if (
        typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean"
      ) {
        const full = String(raw);
        // Strip control characters BEFORE anything else reads the value, so
        // the same string is what gets published AND what gets keyed -- see
        // PLUGIN_METRIC_CONTROL_CHAR_REGEX for why both matter.
        const cleaned = full.replace(PLUGIN_METRIC_CONTROL_CHAR_REGEX, "");
        if (cleaned.length !== full.length) sanitizedValue = true;
        // Measure in code POINTS, not UTF-16 code units. A bare `.slice(128)`
        // can cut a surrogate pair in half and leave a lone surrogate, which
        // the exposition serialises as U+FFFD -- a label value that differs
        // from the one the plugin sent, for no gain. The outer length check is
        // not redundant: a UTF-16 length is always >= the code-point count, so
        // it proves no truncation is needed without materialising an array for
        // the short values that are the overwhelming majority of writes.
        if (cleaned.length > PLUGIN_METRIC_LABEL_VALUE_MAX_LENGTH) {
          const points = Array.from(cleaned);
          if (points.length > PLUGIN_METRIC_LABEL_VALUE_MAX_LENGTH) {
            promoted = points.slice(0, PLUGIN_METRIC_LABEL_VALUE_MAX_LENGTH).join("");
            truncatedValue = true;
          } else {
            promoted = cleaned;
          }
        } else {
          promoted = cleaned;
        }
      }
      // Published under the `tag_` namespace so a plugin-supplied key cannot
      // collide with a label the alerting engine assigns -- see
      // PLUGIN_METRIC_TAG_LABEL_PREFIX. The combination ledger below keys on
      // the VALUE, not the label name, so the prefix does not perturb it.
      if (promoted.length > 0) labels[pluginMetricTagLabel(key)] = promoted;
      comboParts.push(promoted);
    }

    // Tier 2 — the tag-value axis, over combinations ever observed. NUL-joined,
    // which is injective ONLY because no part can contain a NUL — and that is
    // now enforced here rather than assumed: every part is a promoted value,
    // and each was stripped of control characters a few lines above. See
    // pluginMetricCombinations for why a collision would be a real leak rather
    // than a miscount.
    const combo = comboParts.join("\0");
    // Keyed per (plugin, NAME), not per plugin — see
    // PLUGIN_METRIC_CARDINALITY_BUDGET for why a shared pool starves the rare
    // metric that a page depends on. The join is injective on both components,
    // which now needs stating for both rather than one: `name` cleared tier 1
    // above, so it is one of at most PLUGIN_METRIC_NAME_BUDGET values and
    // cleared PLUGIN_METRIC_NAME_REGEX, which admits no NUL; `pluginId` is a
    // `defaultRandom()` UUID (see pluginMetricCombinations), so it cannot
    // contain one either. It moved from opaque map key to joined key component
    // in BLO-32163, which is what put it inside this argument.
    const ledgerKey = `${pluginId}\0${name}`;
    let seen = pluginMetricCombinations.get(ledgerKey);
    if (!seen) {
      seen = new Set<string>();
      pluginMetricCombinations.set(ledgerKey, seen);
    }
    if (!seen.has(combo)) {
      if (
        seen.size
        >= (PLUGIN_METRIC_CARDINALITY_BUDGET_OVERRIDES.get(name) ?? PLUGIN_METRIC_CARDINALITY_BUDGET)
      ) {
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

    // A truncated value is a real breakdown loss, not a cosmetic one: the
    // combination ledger keys on the TRUNCATED value (deliberately -- see
    // pluginMetricCombinations), so two values sharing a 128-code-point prefix
    // collapse into one series. Counting it here is what keeps this counter's
    // contract universal: every rejection AND every degradation is recorded,
    // so "why is my breakdown wrong" is answerable from the drop series alone
    // and never requires reading host source. Cardinality-safe: `name` already
    // cleared tier 1, so it is one of at most PLUGIN_METRIC_NAME_BUDGET values.
    if (truncatedValue) {
      metrics.pluginMetricDroppedCounter.inc({
        ...identity,
        reason: "value_truncated",
        metric: name,
      });
    }

    // Stripping a control character is the same kind of event as truncation --
    // the published value is not the one the plugin sent -- so it is counted
    // for the same reason, and counting it is what keeps §26.4's claim that
    // every degradation is recorded true rather than nearly true. Reported
    // separately from `value_truncated` because the remedies differ: a
    // truncation says "your value is too long", a strip says "your value
    // carried bytes that cannot appear in an exposition", and a plugin author
    // told the wrong one will look in the wrong place. Same cardinality
    // argument as above: `name` already cleared tier 1.
    if (sanitizedValue) {
      metrics.pluginMetricDroppedCounter.inc({
        ...identity,
        reason: "value_sanitized",
        metric: name,
      });
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
 * Record one served HTTP response (PEN-3702).
 *
 * `emptyList` must be true only when the handler serialized a **bare empty
 * array** -- that is the zero-row signal. It is deliberately not inferred from
 * the status code or from a wrapped body shape: a `{ count: 0 }` or
 * `{ issues: [] }` envelope is a different claim, and guessing would make the
 * one distinction this counter exists to record unreliable.
 *
 * Returns the normalized labels so callers (and tests) can assert what was
 * actually recorded rather than what was passed in.
 */
export function recordHttpRequest(input: {
  route: string | null | undefined;
  method: string | null | undefined;
  status: number | null | undefined;
  emptyList: boolean;
}): { route: string; method: string; status: string } {
  const labels = {
    route: normalizeHttpRoute(input.route),
    method: normalizeHttpMethod(input.method),
    status: normalizeHttpStatus(input.status),
  };
  const registered = ensureRegistry();
  registered.httpRequestsCounter.inc(labels);
  if (input.emptyList) {
    registered.httpEmptyListResponsesCounter.inc(labels);
  }
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
    /**
     * Raw `agents.errorReason`, collapsed to a bounded bucket here rather
     * than by the caller so the classification lives next to the label set it
     * feeds and cannot drift from it (BLO-22498). Only consulted for entries
     * actually in `error` — see the aggregation below.
     */
    errorReason?: string | null;
  }>,
): void {
  const metrics = ensureRegistry();
  metrics.agentHeartbeatAgeGauge.reset();
  metrics.agentHeartbeatIntervalGauge.reset();
  metrics.agentErrorDurationGauge.reset();

  // Zero every bucket up front, then accumulate. `reset()` alone would DELETE
  // the series for a bucket that is currently empty, and an absent series is
  // indistinguishable from a healthy one on a Grafana panel — the precise
  // ambiguity BLO-22498 exists to remove. Recovery must render as a line
  // returning to 0, not as a line that stops existing.
  const bucketCounts = new Map<AgentErrorReasonBucket, number>();
  const bucketOldestAge = new Map<AgentErrorReasonBucket, number>();
  for (const bucket of KNOWN_AGENT_ERROR_REASON_BUCKETS) {
    bucketCounts.set(bucket, 0);
    bucketOldestAge.set(bucket, 0);
  }

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
    const errorDurationSeconds = Number.isFinite(entry.errorDurationSeconds)
      ? Math.max(0, entry.errorDurationSeconds)
      : 0;
    metrics.agentErrorDurationGauge.set({ agent_id: entry.agentId }, errorDurationSeconds);

    // `errorDurationSeconds > 0` is the in-error predicate, matching how the
    // caller derives it (0 for every non-error status). Deliberately NOT
    // keyed on `errorReason` being present: an agent in `error` with no
    // reason recorded belongs in the `none` bucket, not omitted from the
    // count. Note the boundary case this accepts — an agent that entered
    // `error` in the same millisecond as this pass reads 0 and is missed
    // until the next tick, which under-reports for at most one scrape
    // interval and never invents a breach.
    if (errorDurationSeconds > 0) {
      const bucket = classifyAgentErrorReason(entry.errorReason);
      bucketCounts.set(bucket, (bucketCounts.get(bucket) ?? 0) + 1);
      bucketOldestAge.set(bucket, Math.max(bucketOldestAge.get(bucket) ?? 0, errorDurationSeconds));
    }
  }

  for (const bucket of KNOWN_AGENT_ERROR_REASON_BUCKETS) {
    metrics.agentErrorReasonAgentsGauge.set({ error_reason: bucket }, bucketCounts.get(bucket) ?? 0);
    metrics.agentErrorReasonOldestAgeGauge.set(
      { error_reason: bucket },
      bucketOldestAge.get(bucket) ?? 0,
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

/** PEN-3314: one tick's recovery chain was skipped because the previous one was still running. */
export function recordHeartbeatRecoveryChainSkipped(): void {
  ensureRegistry().heartbeatRecoveryChainSkippedCounter.inc();
}

/**
 * PEN-3314: a recovery chain settled (success or failure) after `durationMs`.
 *
 * Clamped here as well as at the call site, matching
 * `recordHeartbeatRecoveryChainInflight`. Both gauges mean "a duration", and
 * both are equally undefined on a backwards clock, so the guarantee belongs to
 * the metric rather than to its one caller.
 */
export function recordHeartbeatRecoveryChainDuration(durationMs: number): void {
  ensureRegistry().heartbeatRecoveryChainDurationGauge.set(Math.max(0, durationMs) / 1000);
}

/**
 * PEN-3314: how long the outstanding recovery chain has been running, or `0`
 * once none is.
 *
 * Call this on settle and on stall as well as on skip. The gauge means "the pass
 * running right now", so leaving a stale non-zero value behind after the pass
 * ends would fire the overlap alert against a worker that has recovered.
 */
export function recordHeartbeatRecoveryChainInflight(elapsedMs: number): void {
  ensureRegistry().heartbeatRecoveryChainInflightGauge.set(Math.max(0, elapsedMs) / 1000);
}

/** PEN-3314: a recovery-chain pass passed the stall threshold without settling. */
export function recordHeartbeatRecoveryChainStalled(): void {
  ensureRegistry().heartbeatRecoveryChainStalledCounter.inc();
}

/**
 * BLO-43292: publish this process's view of one scheduler lease.
 *
 * Both series are written on every renew attempt, successful or not. That is
 * the point: on a failed renewal `held` still reads 1 until the cached
 * deadline passes while `lastRenewedAtMs` stops advancing, so renewal age is
 * what makes a wedged leader visible before the TTL turns it into an outage.
 */
export function recordSchedulerLeaseState(input: {
  lease: string;
  holder: string;
  held: boolean;
  lastRenewedAtMs: number;
}): void {
  const registry = ensureRegistry();
  const labels = { lease: input.lease, holder: input.holder };
  registry.schedulerLeaseHeldGauge.set(labels, input.held ? 1 : 0);
  registry.schedulerLeaseRenewedGauge.set(
    labels,
    input.lastRenewedAtMs > 0 ? input.lastRenewedAtMs / 1000 : 0,
  );
}

export function recordBackstopCandidateSkipped(source: BackstopSource, reason: BackstopSkipReason): void {
  ensureRegistry().backstopCandidatesSkippedCounter.inc({ source, reason });
}

/** BLO-25726: a duplicate wake delivery was declined. See WAKE_REDELIVERY_SUPPRESSED_METRIC. */
export function recordWakeRedeliverySuppressed(cause: WakeRedeliverySuppressedCause): void {
  ensureRegistry().wakeRedeliverySuppressedCounter.inc({ cause });
}

/**
 * Record one completed isolation-workspace reaper sweep (BLO-36814).
 *
 * Every child is materialized on every sweep, **including the zero-valued
 * ones**. That is the point rather than an inefficiency: a tick that deletes
 * nothing must still produce a readable `deleted_total{dry_run="false"} 0`, so
 * "swept and found nothing" is distinguishable from "never swept" — the latter
 * being the absence of the series entirely. A helper that only incremented
 * non-zero fields would make the healthy-idle case look exactly like the dead
 * case, which is the failure this whole module exists to remove.
 *
 * Called on the completion path of a sweep that has already done its
 * irreversible work, so it must not throw: a metrics fault has no business
 * turning a successful delete pass into an error the scheduler logs as a
 * failed sweep.
 */
export function recordIsolationWorkspaceReapSweep(
  result: IsolationWorkspaceReapResult,
  options: {
    dryRun: boolean;
    now: () => number;
    /**
     * Overrides the stop reason derived from `result`. Only the root-absent
     * path needs this: it returns a zero-valued result that is structurally
     * indistinguishable from a clean `complete` sweep.
     */
    stopReason?: (typeof ISOLATION_WORKSPACE_REAPER_STOP_REASONS)[number];
  },
): void {
  try {
    const m = ensureRegistry();
    const dry_run = options.dryRun ? "true" : "false";
    m.isolationReaperScannedCounter.inc({ dry_run }, result.scanned);
    m.isolationReaperDeletedCounter.inc({ dry_run }, result.deleted);
    m.isolationReaperSkippedLayoutCounter.inc({ dry_run }, result.skippedLayout);
    m.isolationReaperRetainedResurrectedCounter.inc({ dry_run }, result.retainedResurrected);

    const byOutcome: Record<(typeof ISOLATION_WORKSPACE_REAPER_ENTRY_OUTCOMES)[number], number> = {
      eligible: result.eligible,
      retained_in_use: result.retainedInUse,
      retained_fresh: result.retainedFresh,
      retained_nested_checkout: result.retainedNestedCheckout,
      vanished: result.vanished,
      failed: result.failed,
    };
    for (const outcome of ISOLATION_WORKSPACE_REAPER_ENTRY_OUTCOMES) {
      m.isolationReaperEntriesCounter.inc({ dry_run, outcome }, byOutcome[outcome]);
    }

    // `lookupFaulted` wins when both are set: it is the stronger statement —
    // capped means a budget stopped an assessed pass, faulted means the
    // remainder was never assessed. Every stop_reason child is materialized so
    // a dashboard can read 0 capped sweeps rather than no data.
    const stopReason =
      options.stopReason ??
      (result.lookupFaulted ? "lookup_faulted" : result.capped ? "capped" : "complete");
    for (const reason of ISOLATION_WORKSPACE_REAPER_STOP_REASONS) {
      m.isolationReaperSweepsCounter.inc({ dry_run, stop_reason: reason }, reason === stopReason ? 1 : 0);
    }

    m.isolationReaperLastSweepGauge.set({ dry_run }, Math.floor(options.now() / 1000));
  } catch (error) {
    logger.error({ err: error }, "failed to record isolation-workspace reaper sweep metrics");
  }
}

/**
 * Record one execution-workspace tree removal (PEN-3692).
 *
 * Called from the completion path of a removal that has already done its
 * irreversible work, so it must not throw — a metrics fault has no business
 * turning a successful teardown into a warning the caller records against the
 * workspace.
 *
 * Deliberately NOT pre-seeded. An absent series means this process has torn
 * down no workspace of that shape; a zero series would mean it tried and the
 * work was free. On a row whose whole question is "how much teardown work is
 * happening", those two must stay distinguishable — the same reasoning the
 * reaper counters above are built on.
 */
export function recordExecutionWorkspaceTeardown(input: {
  trigger: ExecutionWorkspaceTeardownTrigger;
  method: ExecutionWorkspaceTeardownMethod;
  succeeded: boolean;
  durationMs: number;
  /**
   * Why the workspace was eligible. Only the collector has one; every other
   * caller is `not_applicable`. This — not `trigger` — is the run-attribution
   * split, because run end defers its teardown into the collector.
   */
  cleanupReason?: ExecutionWorkspaceCleanupReason;
}): void {
  try {
    const m = ensureRegistry();
    const labels = {
      trigger: input.trigger,
      method: input.method,
      cleanup_reason: input.cleanupReason ?? "not_applicable",
    };
    m.executionWorkspaceTeardownCounter.inc(
      { ...labels, outcome: input.succeeded ? "succeeded" : "failed" },
      1,
    );
    // Observed for failures too: a removal that threw still walked whatever it
    // walked before throwing, and that work is charged to the cgroup either
    // way. Excluding it would bias the integral downward exactly when
    // reclamation is going wrong.
    m.executionWorkspaceTeardownDurationHistogram.observe(labels, input.durationMs / 1000);
  } catch (error) {
    logger.error({ err: error }, "failed to record execution-workspace teardown metrics");
  }
}

/**
 * Observe one `inspectWorktreeReclaimSafety` tree walk into the teardown
 * duration histogram under `method: "inspect_safety"` (PEN-3692).
 *
 * Deliberately observes the histogram but does NOT touch
 * `..._teardown_total`: an inspection is not a removal, and counting it as one
 * would corrupt the removal rate. The per-method `_count` on the histogram
 * already gives the inspection count, so nothing is lost.
 *
 * This lives inside `inspectWorktreeReclaimSafety` rather than at its call
 * sites so a future caller cannot silently omit the walk from the integral —
 * which is exactly the gap Ally's Important #2 found on the first revision of
 * this PR, where the help text claimed a whole integral the measured region
 * did not cover.
 */
export function recordExecutionWorkspaceReclaimInspection(input: {
  trigger: ExecutionWorkspaceTeardownTrigger;
  durationMs: number;
  cleanupReason?: ExecutionWorkspaceCleanupReason;
}): void {
  try {
    const m = ensureRegistry();
    // Observed for failures too, for the same reason the removal path is: an
    // inspection that timed out still walked whatever it walked before giving
    // up, and that work is charged to the cgroup either way. On a wedged mount
    // the abandoned call is precisely the expensive case.
    m.executionWorkspaceTeardownDurationHistogram.observe(
      {
        trigger: input.trigger,
        method: "inspect_safety",
        cleanup_reason: input.cleanupReason ?? "not_applicable",
      },
      input.durationMs / 1000,
    );
  } catch (error) {
    logger.error({ err: error }, "failed to record execution-workspace reclaim inspection metrics");
  }
}

/**
 * Record one periodic execution-workspace collector pass (PEN-3692), including
 * one the entry gate skipped — see {@link EXECUTION_WORKSPACE_COLLECTOR_STOP_REASONS}.
 *
 * Takes the whole result rather than individual fields so a new field added to
 * {@link ExecutionWorkspaceCleanupResult} is a compile error here instead of a
 * silently unrecorded one.
 *
 * Must not throw: it runs after the pass has already archived rows and removed
 * trees, and a metrics fault must not be logged as a failed collection.
 */
export function recordExecutionWorkspaceCollectorPass(
  result: ExecutionWorkspaceCleanupResult,
  options: { stopReason: ExecutionWorkspaceCollectorStopReason; now?: () => number },
): void {
  try {
    const m = ensureRegistry();
    m.executionWorkspaceCollectorScannedCounter.inc(result.scanned);
    m.executionWorkspaceCollectorStampedCounter.inc(result.stamped);
    // Every stop_reason child materialized, as the reaper sweep counter does,
    // so a dashboard reads "0 skipped passes" rather than no data.
    for (const reason of EXECUTION_WORKSPACE_COLLECTOR_STOP_REASONS) {
      m.executionWorkspaceCollectorPassesCounter.inc(
        { stop_reason: reason },
        reason === options.stopReason ? 1 : 0,
      );
    }

    const byOutcome: Record<(typeof EXECUTION_WORKSPACE_COLLECTOR_OUTCOMES)[number], number> = {
      collected: result.collected,
      skipped: result.skipped,
      failed: result.failed,
    };
    // Every child materialized, including the zeros: a dashboard should be able
    // to read "0 failed" rather than no data, which is the state that makes a
    // quiet collector and a broken one look alike.
    for (const outcome of EXECUTION_WORKSPACE_COLLECTOR_OUTCOMES) {
      m.executionWorkspaceCollectorCandidatesCounter.inc({ outcome }, byOutcome[outcome]);
    }

    m.executionWorkspaceCollectorLastPassGauge.set(Math.floor((options.now ?? Date.now)() / 1000));
  } catch (error) {
    logger.error({ err: error }, "failed to record execution-workspace collector pass metrics");
  }
}

/**
 * Record a worker-tier proxy relay failure (BLO-31945).
 *
 * Paired with the existing log line, same division of labour as the webhook
 * rejection counter: the counter answers "how many, of which kind, over what
 * window" from a surface with normal retention, the log keeps the per-request
 * detail (target URL, method, the error itself) that must never be a label.
 *
 * Must not throw — it sits on the error path of a request that is already
 * failing, and a metrics fault has no business turning a considered 502/504
 * into a 500.
 */
export function recordWorkerTierProxyFailure(reason: WorkerTierProxyFailureReason): void {
  try {
    ensureRegistry().workerTierProxyFailuresCounter.inc({ reason });
  } catch (error) {
    logger.error({ err: error, reason }, "failed to record worker-tier proxy failure metric");
  }
}

/**
 * Record a webhook delivery turned away at the ingestion readiness guard
 * (BLO-28803).
 *
 * Two surfaces, deliberately: the counter answers "how many, for which plugin,
 * over what window" from the scraped registry — alertable, and readable long
 * after the fact without sender-side logs — while the paired log line carries
 * the per-request detail (`pluginId` as the caller supplied it, `endpointKey`,
 * the HTTP status actually sent) that must never become a label.
 *
 * Called on the reject path of a public unauthenticated route, so it must not
 * throw: a metrics fault has no business converting a considered 503 into a
 * 500 that the sender reads as something else entirely.
 */
export function recordPluginWebhookDeliveryRejected(input: {
  /** Canonical key from the resolved plugins row — NOT the URL parameter. */
  pluginKey: string | null | undefined;
  /** Identifier as supplied by the caller; logged, never labeled. */
  pluginId: string;
  endpointKey: string;
  pluginStatus: string;
  responseClass: WebhookRejectionResponseClass;
  httpStatus: number;
}): void {
  const pluginKey = boundWebhookRejectionPluginKey(input.pluginKey);
  try {
    ensureRegistry().pluginWebhookDeliveryRejectedCounter.inc({
      plugin_key: pluginKey,
      response_class: input.responseClass,
      plugin_status: input.pluginStatus,
    });
  } catch (error) {
    logger.error(
      { err: error, pluginKey },
      "failed to record plugin webhook delivery rejection metric",
    );
  }
  logPluginWebhookDeliveryRejection({ ...input, pluginKey });
}

/**
 * PEN-3000: count a recovery action retired at its wake horizon, split on delivery.
 *
 * `attemptCount` counts DELIVERED wakes, not sweeps (see
 * {@link RECOVERY_HORIZON_EXPIRED_METRIC}), so 0 is the positive signal that the wake
 * channel refused for the entire window rather than that nothing was ever scheduled.
 */
export function recordRecoveryHorizonExpired(delivery: RecoveryHorizonDeliveryState): void {
  ensureRegistry().recoveryHorizonExpiredCounter.inc({ delivery });
}

export function recordRecoveryActionAutoDischarged(kind: string): void {
  ensureRegistry().recoveryActionAutoDischargedCounter.inc({ kind });
}

export async function renderMetrics(): Promise<{ contentType: string; body: string }> {
  const reg = getMetricsRegistry();
  const depBlockedSnapshot = snapshotDepBlockedMetrics();
  const depBlockedBody = [
    `# HELP ${DEP_BLOCKED_WAKEUP_METRIC} Count of dependency-blocked outcomes, labeled by outcome: the wakeup coalescer's park/promote/expire outcomes, plus dep_blocked_queued_reaped for an already-queued run cancelled out of band by reapUnclaimableQueuedRuns (PEN-4385).`,
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
    `# HELP ${ROUTINE_DISPATCH_METRIC} Count of routine dispatch gating outcomes, labeled by outcome. routine_dispatch_bypassed_parked_execution_issue = a fire proceeded past an execution issue parked on a long-horizon scheduled_retry rather than being silently skipped for the whole park. routine_dispatch_bypassed_stale_execution_issue = a fire proceeded past an execution issue whose run was left queued or running past the run-age horizon. routine_dispatch_bypassed_stale_fire_execution_issue = a fire proceeded past an execution issue whose own fire outlived its cadence, which is what a retry chain looks like: each retry is a fresh run whose age restarts at zero, so every run stays inside the run-age horizon while the fire holds the dispatch lock and takes no measurement. routine_dispatch_superseded_stale_execution_issue = such a predecessor was cancelled so the successor fire could insert; this counts the disposal rather than the detection, and a nonzero value is the receipt that a wedge was cleared instead of merely ignored.`,
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
  cgroupMemoryComponentBytes = null;
  cgroupMemoryCurrentBytes = null;
  cgroupMemoryMaxBytes = null;
  cgroupMemoryPeakBytes = null;
  interactionPayloadUnrecognizedKey = null;
  publishedUnrecognizedPayloadKeys.clear();
  executionWorkspaceTeardown = null;
  executionWorkspaceTeardownDuration = null;
  executionWorkspaceCollectorScanned = null;
  executionWorkspaceCollectorCandidates = null;
  executionWorkspaceCollectorStamped = null;
  executionWorkspaceCollectorPasses = null;
  executionWorkspaceCollectorLastPass = null;
  concurrentRunBlocked = null;
  isolatedRunStarted = null;
  heartbeatRunFailed = null;
  ccrotateCapacityDeferred = null;
  retryScheduleOutcome = null;
  startLockReapDisposition = null;
  orphanReapStageSeconds = null;
  penstockGateProbe = null;
  penstockGateProbeDuration = null;
  penstockGateProbeSeededTuples.clear();
  heartbeatTimerSchedulerExclusion = null;
  modelProfileUnapplied = null;
  heartbeatPostTerminalRunEventDropped = null;
  heartbeatTimerChecked = null;
  heartbeatTimerEnqueued = null;
  agentZeroTokenCompletedRunStreak = null;
  zeroTokenStreakAdapterByAgentId.clear();
  externalRuntimeReservationEvents = null;
  externalRuntimeReservationsActive = null;
  externalRuntimeReservationOldestAge = null;
  queuedRunAgeMetricsRefreshSuccess = null;
  externalRuntimeReservationsReleasePending = null;
  externalRuntimeReservationReleasePendingOldestAge = null;
  environmentLeasesOrphanedActive = null;
  environmentLeasesOrphanedOldestAge = null;
  orphanedRuntimeResourceMetricsRefreshSuccess = null;
  externalRuntimeReservationStrandedOldestAge = null;
  workspaceReuseRefusalWindow = null;
  workspaceReuseRefusalMetricsRefreshSuccess = null;
  projectCheckoutOriginMismatch = null;
  projectCheckoutOriginReconcileCompared = null;
  projectCheckoutOriginReconcileMetricsRefreshSuccess = null;
  externalRuntimeReservationStrandMetricsRefreshSuccess = null;
  approvalsPending = null;
  approvalOldestPendingAge = null;
  approvalLastDecisionTimestamp = null;
  approvalQueueMetricsRefreshSuccess = null;
  agentStartLockHeldSeconds = null;
  agentStartLockPhaseSeconds = null;
  agentStartLockAbortedTotal = null;
  duplicateDispatchSuppressedTotal = null;
  processOpenFdsByClass = null;
  processMemoryComponentBytes = null;
  processV8ContextCount = null;
  processMappingRssBytes = null;
  processMappingCount = null;
  processMappingSizeBucketCount = null;
  processMappingSizeBucketBytes = null;
  processGlibcSecondaryArenaHeapCount = null;
  processMappingScanSeconds = null;
  processMappingScanTimestamp = null;
  processHeapPeakSamples = null;
  processRssReleaseEvents = null;
  processRssReleaseBytes = null;
  processRssReleaseLastOnsetTimestamp = null;
  processRssReleaseLastDetectedTimestamp = null;
  processRssReleaseLastBytes = null;
  processRssReleaseSamples = null;
  processRssReleaseBoundBytes = null;
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
  githubWebhookDelivery = null;
  queuedRunOldestAge = null;
  queuedRunOldestClaimableAge = null;
  routineLastDoneFireAge = null;
  routineLastFireStartAge = null;
  routineFireInterval = null;
  routineFireGapMetricsRefreshSuccess = null;
  deferredIssueExecutionWakeOldestAge = null;
  deferredIssueExecutionWakeAgeMetricsRefreshSuccess = null;
  coldInReviewIssueOldestAge = null;
  coldInReviewIssueMetricsRefreshSuccess = null;
  overdueScheduledRetryOldestAge = null;
  overdueScheduledRetryAgeMetricsRefreshSuccess = null;
  scheduledRetryParkHorizon = null;
  scheduledRetryParkHorizonRefreshSuccess = null;
  pluginError = null;
  crashRecoveryCandidateIndexPresent = null;
  pluginMetric = null;
  pluginMetricDropped = null;
  pluginMetricCombinations.clear();
  pluginMetricNames.clear();
  pluginStatusCollectorLastSuccess = null;
  prReviewQueueWait = null;
  runDispatchWait = null;
  authRequest = null;
  httpRequests = null;
  httpEmptyListResponses = null;
  seenHttpRouteLabels.clear();
  agentHeartbeatAge = null;
  agentHeartbeatInterval = null;
  agentErrorDuration = null;
  agentErrorReasonAgents = null;
  agentErrorReasonOldestAge = null;
  projectPrimaryWorkspaceFallback = null;
  backstopDeferredCandidates = null;
  backstopSweepCompleted = null;
  backstopCandidatesSkipped = null;
  wakeRedeliverySuppressed = null;
  heartbeatRecoveryChainSkipped = null;
  heartbeatRecoveryChainDuration = null;
  heartbeatRecoveryChainInflight = null;
  heartbeatRecoveryChainStalled = null;
  schedulerLeaseHeld = null;
  schedulerLeaseRenewed = null;
  recoveryHorizonExpired = null;
  gbrainRecallTotal = null;
  pluginWebhookDeliveryRejected = null;
  workerTierProxyFailures = null;
  trackedWebhookRejectionPluginKeys.clear();
  webhookRejectionLogState.clear();
  resetDepBlockedMetrics();
  resetBlockerResolvedWakeMetrics();
  resetRoutineDispatchMetrics();
}
