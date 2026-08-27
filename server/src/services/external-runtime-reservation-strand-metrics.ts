import { and, eq, inArray, isNull, not, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, externalRuntimeReservations, heartbeatRuns } from "@paperclipai/db";
import {
  setExternalRuntimeReservationStrandMetricsRefreshSuccess,
  setExternalRuntimeReservationStrandedOldestAgeMetrics,
} from "./metrics.js";

/**
 * BLO-28865. Terminal heartbeat-run statuses, mirroring
 * `TERMINAL_RUN_STATUSES` in `heartbeat.ts`. Duplicated rather than imported
 * because `heartbeat.ts` is a ~30k-line module that pulls in the kube client;
 * a metrics refresh that runs on every /metrics scrape must not drag that in.
 */
const TERMINAL_RUN_STATUSES = ["succeeded", "interrupted", "failed", "cancelled", "timed_out"] as const;

/**
 * Silence floor before a NON-terminal run's held reservation counts as
 * stranded. Matches `EXTERNAL_LIFECYCLE_HARD_STALE_MS` in `heartbeat.ts` (45
 * min), which is the point at which the reaper itself gives up and force-kills
 * the Job. Aligning them is deliberate: below this floor the platform still
 * believes the run may be alive, so alerting would be second-guessing the
 * reaper. At and above it, the reaper's own intervention is overdue.
 */
export const EXTERNAL_RUNTIME_RESERVATION_STRAND_SILENCE_MS = 45 * 60 * 1000;

/**
 * Refresh the per-agent oldest-STRANDED-reservation-age gauge (BLO-28865),
 * following the `refreshQueuedRunAgeMetrics` shape (BLO-21116) exactly:
 * recomputed live on every scrape, reset-then-set, with a companion freshness
 * gauge so a failed refresh cannot be read as "nothing stuck".
 *
 * The strand predicate is the entire point of this gauge, and it is why this
 * is not simply an alert threshold over the pre-existing
 * `paperclip_external_runtime_reservation_oldest_age_seconds`. That gauge is a
 * single unlabelled global measuring reservation AGE only. A stranded row and
 * a legitimately long-running run are indistinguishable on it -- measured 7d
 * spread across healthy replicas ran from ~93 min to ~9.0h -- so any threshold
 * either misses real wedges or pages on healthy long runs, and either way
 * cannot say WHICH agent is affected.
 *
 * A reservation counts as stranded when it is unreleased AND either:
 *
 *  - its run is already terminal. Unambiguous: the run is over, so the
 *    reservation must not outlive it. This is the adapter-type-change shape
 *    once the fix cancels the in-flight run, and it is also the generic
 *    "release never landed" shape.
 *  - its run is non-terminal but has emitted nothing (no useful action, no
 *    output, nothing since it started) for longer than the hard-stale floor.
 *    This is the pre-fix wedge: the run looks alive, the Job is gone or hung,
 *    and the unreleased row holds the agent's slot so nothing else dispatches.
 *
 * A healthy long run is non-terminal AND recently noisy, so it matches
 * neither branch and reports 0.
 *
 * Ages off `reserved_at`, matching `refreshExternalRuntimeReservationMetrics`
 * and the partial index `external_runtime_reservations_active_age_idx`.
 */
export async function refreshExternalRuntimeReservationStrandMetrics(
  db: Db,
  now = new Date(),
): Promise<void> {
  try {
    const silenceCutoff = new Date(now.getTime() - EXTERNAL_RUNTIME_RESERVATION_STRAND_SILENCE_MS);

    const [agentRows, strandedByAgent] = await Promise.all([
      db.select({ id: agents.id }).from(agents),
      db
        .select({
          agentId: externalRuntimeReservations.agentId,
          oldestReservedAt: sql<
            Date | string | null
          >`min(${externalRuntimeReservations.reservedAt})`,
        })
        .from(externalRuntimeReservations)
        .innerJoin(heartbeatRuns, eq(heartbeatRuns.id, externalRuntimeReservations.runId))
        .where(
          and(
            isNull(externalRuntimeReservations.releasedAt),
            or(
              inArray(heartbeatRuns.status, [...TERMINAL_RUN_STATUSES]),
              and(
                not(inArray(heartbeatRuns.status, [...TERMINAL_RUN_STATUSES])),
                // COALESCE order mirrors the reaper's own silence reference:
                // last useful action is the strongest liveness signal, last
                // output is the weaker fallback, and started_at covers a run
                // that has produced nothing at all since dispatch. created_at
                // is the final backstop so a never-started row cannot evade
                // the cutoff by having every other column null.
                //
                // The cutoff is passed as an ISO string with an explicit
                // ::timestamptz cast rather than a bare JS Date: inside a raw
                // sql`` fragment there is no column on the left of the
                // comparison for the driver to infer a parameter type from
                // (the left side is a COALESCE expression), so an unadorned
                // Date binds untyped and Postgres rejects the comparison.
                sql`coalesce(
                  ${heartbeatRuns.lastUsefulActionAt},
                  ${heartbeatRuns.lastOutputAt},
                  ${heartbeatRuns.startedAt},
                  ${heartbeatRuns.createdAt}
                ) < ${silenceCutoff.toISOString()}::timestamptz`,
              ),
            ),
          ),
        )
        .groupBy(externalRuntimeReservations.agentId),
    ]);

    const knownAgentIds = new Set(agentRows.map((row) => row.id));
    const entries = strandedByAgent
      .filter((row) => row.agentId !== null && row.oldestReservedAt)
      .map((row) => ({
        agentId: row.agentId,
        ageSeconds: Math.max(
          0,
          (now.getTime() - new Date(row.oldestReservedAt as Date | string).getTime()) / 1000,
        ),
      }));

    setExternalRuntimeReservationStrandedOldestAgeMetrics(entries, knownAgentIds);
    setExternalRuntimeReservationStrandMetricsRefreshSuccess(true);
  } catch (error) {
    // Same contract as refreshQueuedRunAgeMetrics: do NOT overwrite the last
    // snapshot with synthetic zeros, because that would hide a real strand.
    // The freshness gauge makes the stale data ineligible for the strand alert
    // and pages its own failure instead.
    setExternalRuntimeReservationStrandMetricsRefreshSuccess(false);
    throw error;
  }
}
