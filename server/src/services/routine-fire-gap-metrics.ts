import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { routineRuns, routineTriggers, routines } from "@paperclipai/db";
import {
  setRoutineFireGapMetrics,
  setRoutineFireGapMetricsRefreshSuccess,
} from "./metrics.js";
import { deriveRoutineFireIntervalMs } from "./routines.js";

/**
 * Refresh the routine fire-gap gauge pair (BLO-32638).
 *
 * The question these answer is "has this routine stopped taking
 * measurements?", and nothing else on the metrics surface can answer it. A
 * routine's receipt for a measurement is a `done` issue row in the database;
 * `paperclip_routine_dispatch_total` counts dispatch-GATING outcomes, all of
 * which require a fire to have attempted dispatch, so a routine that simply
 * stops producing completed fires moves none of them. Measured on the
 * alert-delivery bridge watchdog (BLO-31881): 11 gaps over 12h, largest 47.5h,
 * one of them a 30.7h window during which a real bridge outage destroyed 22 of
 * 42 alerts while cadence, run-status tallies and every dispatch counter read
 * green.
 *
 * Published as an age and its own denominator rather than an age and a fixed
 * threshold, so ONE alert rule (`age > 2 * interval`) covers every routine. A
 * per-routine threshold list is the thing that rots silently the next time
 * someone edits a cron.
 *
 * Follows the `refreshQueuedRunAgeMetrics` shape (BLO-21116 / BLO-22094) and
 * inherits its two load-bearing properties: reset-then-set, and never zeroing
 * the gauges on refresh failure -- a synthetic 0 age reads as "fired just now",
 * which is the healthy state, and would hide the exact fault this exists to
 * catch.
 */
export async function refreshRoutineFireGapMetrics(db: Db, now = new Date()): Promise<void> {
  try {
    const [scheduledRoutines, lastCompletedByRoutine] = await Promise.all([
      // One row per enabled schedule trigger on an active routine, so a
      // routine with several triggers is reduced below rather than here --
      // SQL cannot derive the cron cadence.
      //
      // `status = 'active'` is the whole paused-routine carve-out: a routine
      // an operator deliberately paused is not a fault, and must emit no
      // series at all rather than an ever-growing age.
      db
        .select({
          routineId: routines.id,
          createdAt: routines.createdAt,
          triggerKind: routineTriggers.kind,
          cronExpression: routineTriggers.cronExpression,
          timezone: routineTriggers.timezone,
        })
        .from(routines)
        .innerJoin(routineTriggers, eq(routineTriggers.routineId, routines.id))
        .where(
          and(
            eq(routines.status, "active"),
            eq(routineTriggers.kind, "schedule"),
            eq(routineTriggers.enabled, true),
          ),
        ),
      // `status = 'completed'` and not `completed_at is not null`: the
      // `skipped`, `coalesced` and `failed` paths all stamp `completed_at`
      // too, and a coalesced fire took no measurement of its own. `completed`
      // is written in exactly one place -- syncRunStatusForIssue, when the
      // execution issue reaches `done` -- which is precisely the receipt this
      // gauge is reporting the age of.
      db
        .select({
          routineId: routineRuns.routineId,
          lastCompletedAt: sql<Date | string | null>`max(${routineRuns.completedAt})`,
        })
        .from(routineRuns)
        .where(eq(routineRuns.status, "completed"))
        .groupBy(routineRuns.routineId),
    ]);

    const lastCompletedAtByRoutineId = new Map<string, Date>();
    for (const row of lastCompletedByRoutine) {
      if (!row.lastCompletedAt) continue;
      lastCompletedAtByRoutineId.set(row.routineId, new Date(row.lastCompletedAt));
    }

    // Reduce the per-trigger rows to one entry per routine, taking the
    // TIGHTEST cadence across its enabled schedule triggers: fires arrive from
    // all of them, so the shortest interval is the one a healthy routine
    // should be meeting.
    const byRoutineId = new Map<string, { routineId: string; ageSeconds: number; intervalSeconds: number | null }>();
    for (const row of scheduledRoutines) {
      const intervalMs = deriveRoutineFireIntervalMs(
        { kind: row.triggerKind, cronExpression: row.cronExpression, timezone: row.timezone },
        now,
      );
      const intervalSeconds = intervalMs === null ? null : intervalMs / 1000;
      const existing = byRoutineId.get(row.routineId);
      if (existing) {
        if (
          intervalSeconds !== null
          && (existing.intervalSeconds === null || intervalSeconds < existing.intervalSeconds)
        ) {
          existing.intervalSeconds = intervalSeconds;
        }
        continue;
      }
      // A routine that has never completed a fire ages from its own
      // created_at. It must NOT be an absent series: absent and "nothing is
      // wrong" render identically on a dashboard, and a routine that was
      // broken from the day it was created is exactly the case worth
      // catching. BLO-21092 already named this for a sibling gauge.
      const since = lastCompletedAtByRoutineId.get(row.routineId) ?? row.createdAt;
      byRoutineId.set(row.routineId, {
        routineId: row.routineId,
        ageSeconds: Math.max(0, (now.getTime() - new Date(since).getTime()) / 1000),
        intervalSeconds,
      });
    }

    setRoutineFireGapMetrics([...byRoutineId.values()]);
    setRoutineFireGapMetricsRefreshSuccess(true);
  } catch (error) {
    // Leave the last snapshot intact. Replacing it with zeros would publish
    // "every routine fired just now" -- the healthy reading -- over a fault.
    // The companion freshness gauge makes the stale data ineligible for the
    // fire-gap alert and pages its own failure alert.
    setRoutineFireGapMetricsRefreshSuccess(false);
    throw error;
  }
}
