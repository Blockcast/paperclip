import { eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, heartbeatRuns } from "@paperclipai/db";
import { setQueuedRunOldestAgeMetrics } from "./metrics.js";

/**
 * Refresh the per-agent oldest-`queued`-run-age gauge (BLO-21116). Recomputed
 * live on every scrape from a MIN(created_at) aggregate over `heartbeatRuns`
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
  const [agentRows, oldestByAgent] = await Promise.all([
    db.select({ id: agents.id }).from(agents),
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
}
