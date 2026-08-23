import { and, eq, lt, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, heartbeatRuns } from "@paperclipai/db";
import {
  setOverdueScheduledRetryAgeMetrics,
  setOverdueScheduledRetryAgeMetricsRefreshSuccess,
  setQueuedRunAgeMetricsRefreshSuccess,
  setQueuedRunOldestAgeMetrics,
} from "./metrics.js";

/**
 * Refresh the per-agent oldest-`queued`-run-age gauge (BLO-21116). Recomputed
 * live on every scrape from a MIN(coalesce(queued_at, created_at)) aggregate over `heartbeatRuns`
 * status='queued', the same "compute on scrape, never trust a stale cache"
 * shape as {@link refreshExternalRuntimeReservationMetrics}. `heartbeatRuns`
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
 * on-call reader needs to see overrun. Only rows already past due
 * (`scheduled_retry_at < now`) count -- a run still backing off toward a
 * future due time is working as designed and must contribute nothing, or
 * this gauge would page on ordinary retry backoff instead of a stuck
 * promotion sweep.
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
          oldestDueAt: sql<Date | string | null>`min(${heartbeatRuns.scheduledRetryAt})`,
        })
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.status, "scheduled_retry"), lt(heartbeatRuns.scheduledRetryAt, now)))
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
