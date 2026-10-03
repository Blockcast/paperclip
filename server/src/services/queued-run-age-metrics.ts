import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, agentWakeupRequests, heartbeatRuns } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { CCROTATE_CAPACITY_ADVERTISED_RESUME_AT_KEY } from "./ccrotate-capacity-retry.js";
import {
  setDeferredIssueExecutionWakeAgeMetricsRefreshSuccess,
  setDeferredIssueExecutionWakeOldestAgeMetrics,
  setOverdueScheduledRetryAgeMetrics,
  setOverdueScheduledRetryAgeMetricsRefreshSuccess,
  setQueuedRunAgeMetricsRefreshSuccess,
  setQueuedRunOldestAgeMetrics,
  setScheduledRetryParkHorizonMetrics,
  setScheduledRetryParkHorizonRefreshSuccess,
} from "./metrics.js";

/**
 * Refresh the per-agent oldest-`queued`-run-age gauge (BLO-21116). Recomputed
 * from a MIN(coalesce(queued_at, created_at)) aggregate over `heartbeatRuns`
 * status='queued', the same "recompute, never trust a stale cache" shape as
 * {@link refreshExternalRuntimeReservationMetrics}. Driven by the background
 * collector in `scrape-metrics-collector.ts`, not by the scrape itself: it ran
 * inline until BLO-33243, where the summed DB latency of five such refreshes
 * pushed whole scrapes past their 10 s timeout and lost every sample. `heartbeatRuns`
 * is the correct table for this: a `queued` row is a run Paperclip has
 * already decided to dispatch and is waiting on a concurrency slot or the
 * scheduler tick to pick it up, which is exactly the "invisible strand" this
 * issue reports -- not a run that failed to enqueue in the first place.
 *
 * Ages off `coalesce(queued_at, created_at)`, not bare `created_at` (Ally
 * review, onprem-k8s#2013): `queued_at` is null for a fresh `queued` insert,
 * where `created_at` already IS the queue-entry time, but gets stamped with
 * `now()` by the specific transitions that put an *existing* row back into
 * `queued` after it was something else (`promoteScheduledRetryRun`,
 * `deferRunForK8sIsolationConflict`). Without the coalesce target, a run
 * promoted after hours in `scheduled_retry` backoff would instantly report
 * that entire backoff as queued-dispatch wait -- the false-stranded-run alert
 * this gauge exists to prevent.
 *
 * Queries every agent id (not just ones with an active company/heartbeat
 * enabled) so a genuinely idle agent reads back an explicit 0 rather than an
 * absent series -- an absent series and "nothing stuck" render identically on
 * a dashboard, which is exactly the failure mode BLO-21092 already named for
 * a sibling gauge.
 */
export async function refreshQueuedRunAgeMetrics(db: Db, now = new Date()): Promise<void> {
  try {
    const [agentRows, oldestByAgent] = await Promise.all([
      db.select({ id: agents.id }).from(agents),
      // Keep this predicate in the same simple form as the queue-only age
      // index from migration 0217 so scrapes never scan heartbeat history.
      db
        .select({
          agentId: heartbeatRuns.agentId,
          oldestQueuedAt: sql<Date | string | null>`min(coalesce(${heartbeatRuns.queuedAt}, ${heartbeatRuns.createdAt}))`,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.status, "queued"))
        .groupBy(heartbeatRuns.agentId),
    ]);

    const knownAgentIds = new Set(agentRows.map((row) => row.id));
    const entries = oldestByAgent
      .filter((row) => row.agentId !== null && row.oldestQueuedAt)
      .map((row) => ({
        agentId: row.agentId,
        ageSeconds: Math.max(0, (now.getTime() - new Date(row.oldestQueuedAt as Date | string).getTime()) / 1000),
      }));

    setQueuedRunOldestAgeMetrics(entries, knownAgentIds);
    setQueuedRunAgeMetricsRefreshSuccess(true);
  } catch (error) {
    // Do not replace the last age snapshot with synthetic zeros: that would
    // hide a real strand. The companion freshness gauge makes the stale data
    // ineligible for the stranded-run alert and pages its own failure alert.
    setQueuedRunAgeMetricsRefreshSuccess(false);
    throw error;
  }
}

/**
 * How old a pending deferred wake must be before the refresh names it in the
 * log (PEN-3734). The gauge carries the age; this threshold decides when the
 * *identity* is worth writing down.
 *
 * Thirty minutes is deliberately well below any alert threshold. The gauge can
 * only ever say "agent X is waiting"; the thing a responder actually needs is
 * WHICH issue is holding the lock, and `issue_id` cannot be a label without
 * unbounded cardinality. Logging it from here is the bridge, and it has to be
 * written *before* the page so the record already exists when someone goes
 * looking — the entire defect being fixed is that this state was unobservable
 * after the fact.
 */
const DEFERRED_WAKE_DETAIL_LOG_AGE_MS = 30 * 60 * 1000;

/**
 * Row cap on ONE detail emission. Bounds the width of a single record, not the
 * rate — see {@link DEFERRED_WAKE_DETAIL_LOG_INTERVAL_MS} for that.
 *
 * The query asks for one row more than this so `capped` can distinguish
 * "exactly this many matched" from "more matched than we printed". A bare
 * `length === LIMIT` reports truncation at the exact boundary where nothing was
 * truncated, which is the same shown-equals-matched ambiguity the field exists
 * to remove.
 */
const DEFERRED_WAKE_DETAIL_LOG_LIMIT = 20;

/**
 * Minimum gap between detail emissions, process-wide.
 *
 * The collector ticks every 15s and the detail pass fires on every tick where
 * anything is past 30m, so without this the motivating 10h53m case emits ~2,600
 * near-identical `warn` records — ~840 of them before the 4h alert even fires.
 * That buries the forensic record inside copies of itself, in exactly the log
 * the runbook tells a responder to grep.
 *
 * A global throttle rather than a per-wake one, because each emission is a
 * *snapshot* of every current offender rather than a per-row event: a wake that
 * starts deferring between emissions appears in the next one with its true age.
 * So the throttle delays the record by at most this interval and never drops a
 * row from it. 15 minutes keeps a full hour of deferral to four records while
 * still landing the first one well inside the 30m-to-4h window.
 */
const DEFERRED_WAKE_DETAIL_LOG_INTERVAL_MS = 15 * 60 * 1000;

/** Unix ms of the last detail emission, or null if none has been written yet. */
let lastDeferredWakeDetailLogMs: number | null = null;

/** Test seam: forget the throttle so each test starts from a clean slate. */
export function __resetDeferredWakeDetailLogThrottleForTest(): void {
  lastDeferredWakeDetailLogMs = null;
}

/**
 * Refresh the per-agent oldest-pending-`deferred_issue_execution`-wake-age
 * gauge (PEN-3734).
 *
 * A wake is parked in `deferred_issue_execution` while another run holds the
 * issue's execution lock. It is promoted only when a run on that issue
 * finalizes, one per finalization, and the lock is held globally across
 * agents, so an agent's wait is bounded below by the queue wait of every other
 * agent's run ahead of it on that row. Measured 2026-10-02 on PEN-3164: one
 * wake waited 10h53m, of which 10h35m was a single foreign run sitting
 * `queued` before it ever started.
 *
 * Neither sibling above can see it, and not by a near miss:
 * {@link refreshQueuedRunAgeMetrics} and
 * {@link refreshOverdueScheduledRetryAgeMetrics} both read `heartbeatRuns`,
 * and a deferred wake deliberately creates NO run row — that is the
 * documented contract of the deferral, which is why `heartbeat_runs` is not
 * the wake ledger and a seat-side search for the wake returns nothing *by
 * design*. Every non-metric surface is blind too: the issue's
 * `lastActivityAt` is ADVANCED by each undelivered comment, so staleness
 * sweeps read a starving row as freshly healthy. This gauge reads the one
 * table that knows.
 *
 * Ages off `requested_at`, not `updated_at`. Later wakes on the same issue
 * MERGE into a pending request (`coalescedCount++`) rather than creating their
 * own, and that merge bumps `updated_at` without resetting `requested_at`. So
 * `requested_at` is the wait of the EARLIEST undelivered comment, which is the
 * quantity that cost 10h53m; `updated_at` would reset on every new comment and
 * report a starving row as young — the exact `lastActivityAt` failure mode one
 * table over.
 *
 * No issue-status filter, and the omission is deliberate. A deferred wake
 * whose issue has since gone terminal will never be promoted (no run will
 * finalize on it) and is stranded forever — a real strand, correctly paged,
 * and clearable by cancelling the row. Excluding it would make this detector
 * quiet in a case where nothing is coming, which is the failure direction this
 * whole class of gauge exists to avoid.
 *
 * Same "query every agent id, reset-then-set" shape as the siblings so an
 * agent with nothing deferred reads back an explicit 0 rather than an absent
 * series, and the same freshness-gauge contract on failure: the reset-then-set
 * only runs on the success path, so a throw leaves the previous per-agent
 * values frozen while `/metrics` still returns 200 — and the frozen value is
 * almost always 0, the healthy reading.
 */
export async function refreshDeferredIssueExecutionWakeAgeMetrics(db: Db, now = new Date()): Promise<void> {
  let oldestAgeSeconds = 0;
  try {
    const [agentRows, oldestByAgent] = await Promise.all([
      db.select({ id: agents.id }).from(agents),
      // Predicate kept in exactly the form migration 0248's partial index is
      // built on, so this never scans the largest table in the schema.
      db
        .select({
          agentId: agentWakeupRequests.agentId,
          oldestRequestedAt: sql<Date | string | null>`min(${agentWakeupRequests.requestedAt})`,
        })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.status, "deferred_issue_execution"))
        .groupBy(agentWakeupRequests.agentId),
    ]);

    const knownAgentIds = new Set(agentRows.map((row) => row.id));
    const entries = oldestByAgent
      .filter((row) => row.agentId !== null && row.oldestRequestedAt)
      .map((row) => ({
        agentId: row.agentId,
        ageSeconds: Math.max(
          0,
          (now.getTime() - new Date(row.oldestRequestedAt as Date | string).getTime()) / 1000,
        ),
      }));

    setDeferredIssueExecutionWakeOldestAgeMetrics(entries, knownAgentIds);
    setDeferredIssueExecutionWakeAgeMetricsRefreshSuccess(true);
    oldestAgeSeconds = entries.reduce((max, entry) => Math.max(max, entry.ageSeconds), 0);
  } catch (error) {
    // Do not zero the gauge here: synthetic zeros would read as "nothing
    // deferred", the healthy state, and hide a real wait. Leave the last
    // snapshot in place and let the freshness gauge disqualify it.
    setDeferredIssueExecutionWakeAgeMetricsRefreshSuccess(false);
    throw error;
  }

  // The detail pass sits OUTSIDE the try above, and that placement is the whole
  // point rather than a formatting choice. Inside it, any failure of this
  // second query would reach the catch and flip the freshness gauge to 0 — on
  // data that was fetched and published correctly one statement earlier. The
  // alert is gated on that gauge, so a timeout here would silently hold
  // PaperclipDeferredIssueExecutionWakeOverdue off while the value in memory
  // was fresh and above threshold. And the correlation makes that the likely
  // case, not a remote one: this query only ever runs when something is
  // ALREADY overdue, so the entire extra failure surface is bolted onto the
  // unhealthy path. A diagnostic must not be able to disable the detector it
  // is diagnosing.
  await logOverdueDeferredWakes(db, now, oldestAgeSeconds).catch((error: unknown) => {
    logger.warn({ error }, "deferred-wake detail log failed; the age gauge is unaffected (PEN-3734)");
  });
}

/**
 * Name the overdue deferred wakes in the log (PEN-3734).
 *
 * The gauge can only ever say "agent X is waiting" — `issue_id` is unbounded
 * cardinality and cannot be a label — so this is the only bridge from the alert
 * to the row that is actually stuck. It is written at 30m, far below the alert
 * threshold, so the record already exists by the time anyone goes looking;
 * being unobservable after the fact is the defect being fixed.
 *
 * Returns without querying when nothing is overdue, so a healthy fleet costs
 * one query per tick rather than two.
 */
async function logOverdueDeferredWakes(db: Db, now: Date, oldestAgeSeconds: number): Promise<void> {
  if (oldestAgeSeconds * 1000 < DEFERRED_WAKE_DETAIL_LOG_AGE_MS) return;
  if (
    lastDeferredWakeDetailLogMs !== null
    && now.getTime() - lastDeferredWakeDetailLogMs < DEFERRED_WAKE_DETAIL_LOG_INTERVAL_MS
  ) {
    return;
  }

  const cutoff = new Date(now.getTime() - DEFERRED_WAKE_DETAIL_LOG_AGE_MS);
  const matched = await db
    .select({
      wakeId: agentWakeupRequests.id,
      agentId: agentWakeupRequests.agentId,
      companyId: agentWakeupRequests.companyId,
      issueId: sql<string | null>`${agentWakeupRequests.payload} ->> 'issueId'`,
      reason: agentWakeupRequests.reason,
      coalescedCount: agentWakeupRequests.coalescedCount,
      requestedAt: agentWakeupRequests.requestedAt,
    })
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.status, "deferred_issue_execution"),
        sql`${agentWakeupRequests.requestedAt} < ${cutoff.toISOString()}::timestamptz`,
      ),
    )
    .orderBy(asc(agentWakeupRequests.requestedAt))
    // One over the cap, so `capped` below reports real truncation rather than
    // firing at the exact cardinality where nothing was truncated.
    .limit(DEFERRED_WAKE_DETAIL_LOG_LIMIT + 1);

  // The aggregate and this query are separate round-trips, so a promotion
  // between them can legitimately leave nothing to print.
  if (matched.length === 0) return;
  const stale = matched.slice(0, DEFERRED_WAKE_DETAIL_LOG_LIMIT);
  lastDeferredWakeDetailLogMs = now.getTime();

  logger.warn(
    {
      thresholdSeconds: Math.floor(DEFERRED_WAKE_DETAIL_LOG_AGE_MS / 1000),
      oldestAgeSeconds: Math.floor(oldestAgeSeconds),
      // Truncation is stated, not implied: `shown < matched` is impossible to
      // distinguish from "that was all of them" otherwise, and a silent cap
      // reads as full coverage.
      shown: stale.length,
      capped: matched.length > DEFERRED_WAKE_DETAIL_LOG_LIMIT,
      wakes: stale.map((row) => ({
        wakeId: row.wakeId,
        agentId: row.agentId,
        companyId: row.companyId,
        issueId: row.issueId,
        reason: row.reason,
        coalescedCount: row.coalescedCount,
        requestedAt: row.requestedAt,
        ageSeconds: Math.floor(
          Math.max(0, (now.getTime() - new Date(row.requestedAt).getTime()) / 1000),
        ),
      })),
    },
    "wake deferred behind an issue execution lock is overdue for promotion (PEN-3734)",
  );
}

/**
 * The `result_json` key carrying the provider's advertised resume instant,
 * named through its TS binding so a rename cannot silently desync the gauge
 * from the writer (BLO-35263). The YAML triage query's copy is pinned by
 * `prometheusrule-result-json-keys.test.ts`.
 */
const advertisedResumeAt = sql`${heartbeatRuns.resultJson}->>${CCROTATE_CAPACITY_ADVERTISED_RESUME_AT_KEY}`;

/**
 * The instant a parked retry is genuinely due (BLO-34782): the LATER of the
 * booked `scheduled_retry_at` and the resume instant the provider advertised.
 *
 * A `ccrotate_capacity` park does not book what the provider asked for. The
 * scheduler *clamps* it — `CCROTATE_CAPACITY_MAX_PARK_MS` caps the horizon at
 * 15 minutes — so a pool that will not serve until 3.5 days out is booked to
 * re-probe in ~15 minutes. Fifteen minutes later the row satisfies
 * `scheduled_retry_at < now()` and keeps satisfying it for the entire
 * remaining quota window, while the run is still, correctly, backing off.
 * That defeats BLO-22094's own acceptance criterion ("a run that is merely
 * backing off contributes nothing") in intent while meeting it in letter, and
 * it does so fleet-wide at once: one shared quota bucket means every agent
 * clamps together. Measured 2026-09-20, 13 of 16 capacity parks were "overdue"
 * and five separate episodes put 10-14 agents over threshold simultaneously.
 *
 * Taking the later of the two restores the intent without trading away the
 * detector. A capacity park still contributes once it runs past the instant
 * the provider itself advertised -- which is the wedged promotion path this
 * gauge exists to catch, not the clamp working as designed. Every other park
 * reason writes no `penstockAdvertisedResumeAt`, so `greatest` (which ignores
 * NULLs) collapses to the bare due time and their arithmetic is unchanged.
 *
 * Note the asymmetry this creates, because it is not obvious: the advertised
 * instant is persisted *unclamped*, so the suppression window is
 * provider-controlled even though the *booked* park deliberately distrusts it
 * (`CCROTATE_CAPACITY_MAX_PARK_MS` exists because a long advertised horizon is
 * not credible enough to schedule against). A provider returning an
 * implausible resume instant therefore silences this gauge for that row until
 * it passes. The backstop is `CAPACITY_ESCALATION_AFTER_MS`, which ends
 * the chain on wall-clock regardless of what was advertised; the park itself
 * also stays visible on `paperclipListParkedAgents`, which is non-paging.
 *
 * The regex guard is deliberate, and so is its failure direction. Both
 * `result_json` writers of this field go through
 * `applyCcrotateCapacityDecision` and emit `Date.toISOString()`, so anything
 * else is corrupt. The one write that invalidates the field without replacing
 * it, `retryScheduledRetryNow` booking `scheduled_retry_at` to `now`, clears it
 * through `clearCcrotateCapacityDecision` in the same statement, so a due time
 * an actor forced cannot be out-voted here by a provider horizon that no longer
 * describes the row. An unparseable value degrades to the pre-BLO-34782 reading
 * (the row stays eligible and may page) rather than to silence. A detector
 * that fails loud is recoverable; one that fails quiet is the
 * invisible-strand mode this metric was built to remove.
 *
 * Scope bound, so nobody reads the exclusion as total: a third write site puts
 * the key in `context_snapshot`, not `result_json` (`heartbeat.ts:34311`), and
 * `coalescePendingTaskScopeWake` merges only `context_snapshot`. So a capacity
 * denial coalesced onto an existing park leaves the advertised instant
 * invisible to this query and the row keeps counting -- failing loud, the
 * right direction, and the likely reason 11 of 46 parks in the BLO-34782 live
 * sample carried no `result_json` key at all.
 */
const effectiveRetryDueAt = sql`greatest(
  ${heartbeatRuns.scheduledRetryAt},
  case
    when ${advertisedResumeAt}
         ~ '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?Z$'
    then (${advertisedResumeAt})::timestamptz
  end
)`;

/**
 * Refresh the per-agent oldest-overdue-`scheduled_retry`-row-age gauge
 * (BLO-22094). {@link refreshQueuedRunAgeMetrics} above only ever sees
 * `status='queued'` rows -- a parked retry is `status: "scheduled_retry"`, a
 * distinct value, so it never enters that aggregate at any age. That
 * exclusion is intentional (it is what stops a promoted retry from replaying
 * its whole backoff as queued-dispatch wait, onprem-k8s#2013), but it leaves
 * a retry that is parked and never promoted invisible to any gauge, forever
 * -- the exact gap this metric closes.
 *
 * Ages off `scheduled_retry_at`, not `created_at`: a parked row's `due` time
 * is what a wedged promotion path fails to act on, and that is what an
 * on-call reader needs to see overrun. Only rows already past due count -- a
 * run still backing off toward a future due time is working as designed and
 * must contribute nothing, or this gauge would page on ordinary retry backoff
 * instead of a stuck promotion sweep. "Past due" reads
 * {@link effectiveRetryDueAt}, not the bare column, because a capacity-clamped
 * park books a due time far nearer than the one it is actually waiting on.
 *
 * Same "query every agent id, reset-then-set" shape as
 * {@link refreshQueuedRunAgeMetrics} so an agent with no overdue parked row
 * reads back an explicit 0 rather than an absent series.
 *
 * Failure handling mirrors the sibling, and matters more here (Ally review,
 * #1184): the reset-then-set only runs on the success path, so a throw leaves
 * the previous per-agent values frozen while `/metrics` still returns 200.
 * The frozen value is almost always `0` -- the healthy reading -- so without
 * the companion freshness gauge a dead refresh is indistinguishable from a
 * quiet fleet, which is the exact invisible-failure mode this detector exists
 * to eliminate.
 */
export async function refreshOverdueScheduledRetryAgeMetrics(db: Db, now = new Date()): Promise<void> {
  try {
    const [agentRows, oldestByAgent] = await Promise.all([
      db.select({ id: agents.id }).from(agents),
      db
        .select({
          agentId: heartbeatRuns.agentId,
          oldestDueAt: sql<Date | string | null>`min(${effectiveRetryDueAt})`,
        })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.status, "scheduled_retry"),
            // Kept explicit. `greatest` ignores NULLs, so without this a row
            // with a null due time but a past advertised resume would start
            // contributing where `scheduled_retry_at < now` had excluded it.
            isNotNull(heartbeatRuns.scheduledRetryAt),
            // `now.toISOString()`, not the bare Date: drizzle's `lt()` helper
            // applies the column's type mapper, but a raw `sql` fragment binds
            // the value straight through and postgres.js cannot serialize a
            // Date there (ERR_INVALID_ARG_TYPE at bind time).
            sql`${effectiveRetryDueAt} < ${now.toISOString()}::timestamptz`,
          ),
        )
        .groupBy(heartbeatRuns.agentId),
    ]);

    const knownAgentIds = new Set(agentRows.map((row) => row.id));
    const entries = oldestByAgent
      .filter((row) => row.agentId !== null && row.oldestDueAt)
      .map((row) => ({
        agentId: row.agentId,
        ageSeconds: Math.max(0, (now.getTime() - new Date(row.oldestDueAt as Date | string).getTime()) / 1000),
      }));

    setOverdueScheduledRetryAgeMetrics(entries, knownAgentIds);
    setOverdueScheduledRetryAgeMetricsRefreshSuccess(true);
  } catch (error) {
    // Do not zero the gauge here: synthetic zeros would read as "no overdue
    // parked rows", the healthy state, and hide a real wedge. Leave the last
    // snapshot in place and let the freshness gauge disqualify it -- the alert
    // is gated on that gauge, and its own refresh-failed alert pages instead.
    setOverdueScheduledRetryAgeMetricsRefreshSuccess(false);
    throw error;
  }
}

/**
 * Refresh the per-agent maximum booked `scheduled_retry` park horizon
 * (BLO-25036). Unlike the overdue sibling above, this measures the selected
 * due time itself, including future due times, so it catches an implausibly
 * distant retry before the run becomes overdue.
 *
 * The subtrahend is `updated_at`, NOT `created_at` (BLO-31174). A park is
 * re-decided IN PLACE: both re-park paths in `heartbeat.ts` UPDATE the same row
 * with `scheduledRetryAt = now + backoff`, a bumped `scheduledRetryAttempt`, and
 * `updatedAt = now`, while `created_at` stays pinned at the FIRST park. Measured
 * against `created_at` the gauge therefore reports how long a row has been
 * re-parking rather than how far out any decision booked: it climbs by one
 * backoff interval per re-check, without bound, and crosses a 5400s threshold
 * after ~2 re-checks no matter how sane each individual booking was. That is a
 * breach guaranteed by construction rather than a diagnostic one, and no
 * threshold value fixes it — 9 agents were firing this way on 2026-09-03, all
 * of them booking a correct ~1h `dependency_blocked` backoff.
 *
 * `updated_at` is bumped at exactly the moment the due time is chosen, so the
 * difference recovers the booked interval itself — which is the quantity the
 * alert is named for and the one its body tells the responder to inspect. A
 * fresh park writes `updated_at == created_at`, so single-shot parks (including
 * the 518,000s capacity park that motivated BLO-25036) read identically to
 * before and the detector keeps its original sensitivity.
 *
 * Known limit: a writer that touches a still-parked row without re-deciding the
 * due time also bumps `updated_at`. The paths known today are
 * `coalesceGithubReviewDelivery` and the run-liveness backfill in
 * `services/activity.ts`, whose update guards only on `id` +
 * `isNull(liveness_state)` while its row selector admits parked rows
 * (`status not in ('queued', 'running')`); that one is one-shot per run, since
 * `classifyRunLiveness` always sets a non-null state. This is the set known
 * today, not a proof that no other writer exists. Either way the reading
 * degrades to the REMAINING horizon rather than zeroing it, so an implausibly
 * distant park stays far above threshold and is still caught; it is a mild
 * understatement, not a blind spot.
 *
 * `queued_at` represents a later promotion back to queued and must not be used.
 *
 * The result is grouped by `scheduled_retry_reason` as well as agent, and the
 * reason is published as a gauge label (BLO-31174, second defect). The classes
 * this column selects among have legitimate maxima that differ by at least
 * 289x -- 300s for `max_turns_continuation` and k8s isolation, 1,080s for
 * `ccrotate_capacity` (`CCROTATE_CAPACITY_MAX_PARK_MS` plus 20% forward jitter
 * on the clamped value), 3,600s for `dependency_blocked`
 * (`Math.min(..., 3_600_000)`), 9,000s for the `transient_failure` ladder's
 * final 2h hop plus 25% jitter, and 86,700s for a `transient_failure` park that
 * adopts an upstream `retryNotBefore` floor (`MAX_TRANSIENT_RETRY_HORIZON_MS`
 * plus `TRANSIENT_RETRY_FLOOR_JITTER_MAX_MS`; a `provider_quota` floor is never
 * clamped, so it has no ceiling) -- so a single threshold aggregated over all
 * of them is wrong in both directions at once. At
 * the 5,400s bound the alert shipped with, every run reaching transient attempt
 * 4 breaches BY DESIGN (1,016 breaching samples across 12 agents in the 7 days
 * to 2026-09-28, every one inside [5590, 8978], i.e. below the transient
 * ladder ceiling), while a capacity park sitting at 3.3x its own 1,080s ceiling -- the writer
 * bug BLO-28919 fixed -- stays invisible. Bound each reason against its own
 * constant instead of retuning one number.
 */
export async function refreshScheduledRetryParkHorizonMetrics(db: Db): Promise<void> {
  try {
    const [agentRows, horizonByAgent] = await Promise.all([
      db.select({ id: agents.id }).from(agents),
      db
        .select({
          agentId: heartbeatRuns.agentId,
          reason: heartbeatRuns.scheduledRetryReason,
          horizonSeconds: sql<number | string>`max(extract(epoch from ${heartbeatRuns.scheduledRetryAt} - ${heartbeatRuns.updatedAt}))`,
        })
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.status, "scheduled_retry"), isNotNull(heartbeatRuns.scheduledRetryAt)))
        .groupBy(heartbeatRuns.agentId, heartbeatRuns.scheduledRetryReason),
    ]);

    const knownAgentIds = new Set(agentRows.map((row) => row.id));
    setScheduledRetryParkHorizonMetrics(
      horizonByAgent.map((row) => ({
        agentId: row.agentId,
        reason: row.reason,
        // Clamp as the overdue sibling does: a row whose due time has already
        // passed can be touched again (see the known limit above), which would
        // otherwise surface a negative horizon. Lateness is BLO-22094's gauge.
        horizonSeconds: Math.max(0, Number(row.horizonSeconds)),
      })),
      knownAgentIds,
    );
    setScheduledRetryParkHorizonRefreshSuccess(true);
  } catch (error) {
    setScheduledRetryParkHorizonRefreshSuccess(false);
    throw error;
  }
}
