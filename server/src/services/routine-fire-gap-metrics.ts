import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { routineRuns, routineTriggers, routines } from "@paperclipai/db";
import {
  setRoutineFireGapMetrics,
  setRoutineFireGapMetricsRefreshSuccess,
} from "./metrics.js";
import { deriveRoutineFireGapsMs } from "./routines.js";

/**
 * One row per enabled schedule trigger on an active routine, carrying that
 * routine's most recent COMPLETED fire.
 *
 * `status = 'active'` is the whole paused-routine carve-out: a routine an
 * operator deliberately paused is not a fault, and must emit no series at all
 * rather than an ever-growing age. Several triggers per routine are reduced in
 * the caller -- SQL cannot derive the cron cadence.
 *
 * `status = 'completed'` and not `completed_at is not null`: the `skipped`,
 * `coalesced` and `failed` paths all stamp `completed_at` too, and a coalesced
 * fire took no measurement of its own. `completed` is written in exactly one
 * place -- syncRunStatusForIssue, when the execution issue reaches `done` --
 * which is precisely the receipt this gauge is reporting the age of.
 *
 * A correlated `max()` per routine, not a `group by` over the whole table:
 * with the partial index `routine_runs_routine_completed_idx` (migration 0254,
 * its own PR so this branch's migration journal cannot collide with master's)
 * each probe is a one-row backward index scan, so a refresh costs
 * O(scheduled routines) rather than a scan of every completed fire ever
 * recorded -- a set that only grows, four times a minute on every replica
 * (Ally on #2352). That migration's test EXPLAINs this probe by hand. The
 * status is a LITERAL, not a bind parameter, so a cached generic plan can
 * still prove the partial index's predicate.
 */
function selectScheduledRoutinesWithLastCompletedFire(db: Db) {
  return db
    .select({
      routineId: routines.id,
      createdAt: routines.createdAt,
      triggerKind: routineTriggers.kind,
      cronExpression: routineTriggers.cronExpression,
      timezone: routineTriggers.timezone,
      lastCompletedAt: sql<Date | string | null>`(
        select max(${routineRuns.completedAt}) from ${routineRuns}
        where ${routineRuns.routineId} = ${routines.id} and ${routineRuns.status} = 'completed'
      )`,
    })
    .from(routines)
    .innerJoin(routineTriggers, eq(routineTriggers.routineId, routines.id))
    .where(
      and(
        eq(routines.status, "active"),
        eq(routineTriggers.kind, "schedule"),
        eq(routineTriggers.enabled, true),
      ),
    );
}

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
    const scheduledRoutines = await selectScheduledRoutinesWithLastCompletedFire(db);

    // Per trigger, the interval is the LONGEST gap its cron legitimately
    // schedules (maxMs, not the dispatch horizon's minMs): the alert is
    // `age > 2 * interval`, and a minimum pages on every healthy long gap of
    // an irregular cron -- `0 15 * * 1-5` would page each weekend.
    //
    // Across a routine's enabled schedule triggers take the TIGHTEST of those:
    // fires arrive from all of them, so no healthy gap between fires can exceed
    // any single trigger's longest gap. The minimum over triggers is therefore
    // still an upper bound on the true gap (never a false page), and the
    // tightest one available.
    const byRoutineId = new Map<string, { routineId: string; ageSeconds: number; intervalSeconds: number | null }>();
    for (const row of scheduledRoutines) {
      const gaps = deriveRoutineFireGapsMs(
        { kind: row.triggerKind, cronExpression: row.cronExpression, timezone: row.timezone },
        now,
      );
      const intervalSeconds = gaps === null ? null : gaps.maxMs / 1000;
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
      const since = row.lastCompletedAt ?? row.createdAt;
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
