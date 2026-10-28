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
 * routine's two fire receipts: its most recent COMPLETED fire, and (PEN-4647)
 * its most recent DISPATCHED one.
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
 * PEN-4647 adds a SECOND correlated probe for the age of the most recent
 * FIRING, which is a different question with a different answer whenever a
 * wedged execution row is eating fires. `triggered_at`, not `completed_at`:
 * that is the instant the fire began, and nothing a late completion does can
 * move it.
 *
 * ⚠ Its predicate is the load-bearing part, and the obvious shorter version is
 * WRONG. `skip_if_active` and `coalesce_if_active` both finalize their run with
 * `linkedIssueId` set to the HELD issue they stood down behind (see
 * `coalesceOnto` in routines.ts), so `linked_issue_id is not null` ALONE would
 * be reset by every eaten firing -- reproducing PEN-4647's fail-open one layer
 * down, in the exact scenario it exists to catch. Excluding those two statuses
 * is what makes this probe mean "a fire that produced its OWN execution issue".
 *
 * Stated as an exclusion rather than `status in ('issue_created','completed',
 * 'failed')` so a newly-added status cannot silently fall out of the gauge and
 * freeze an age that should be climbing. The null test still carries its own
 * weight on top: a dispatch that fails BEFORE issue creation books `failed`
 * with a null link (BLO-40337) and produced no work, so it must not count.
 *
 * Backed by `routine_runs_routine_dispatched_idx` (migration 0266), a sibling
 * of 0254 -- which cannot serve this probe, since it holds only
 * `status = 'completed'` rows.
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
function selectScheduledRoutinesWithFireReceipts(db: Db) {
  return db
    .select({
      routineId: routines.id,
      companyId: routines.companyId,
      createdAt: routines.createdAt,
      triggerKind: routineTriggers.kind,
      cronExpression: routineTriggers.cronExpression,
      timezone: routineTriggers.timezone,
      lastCompletedAt: sql<Date | string | null>`(
        select max(${routineRuns.completedAt}) from ${routineRuns}
        where ${routineRuns.routineId} = ${routines.id} and ${routineRuns.status} = 'completed'
      )`,
      lastDispatchedAt: sql<Date | string | null>`(
        select max(${routineRuns.triggeredAt}) from ${routineRuns}
        where ${routineRuns.routineId} = ${routines.id}
          and ${routineRuns.linkedIssueId} is not null
          and ${routineRuns.status} <> 'skipped'
          and ${routineRuns.status} <> 'coalesced'
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
 * PEN-4647: TWO ages share that denominator, and the rule takes the max of
 * them. Completion age alone fails OPEN on the dominant failure mode -- a
 * wedged long-open execution row eats the fires behind it, and the moment that
 * row finally reaches `done` the completion age resets to ~0 and the alert
 * resolves mid-outage with no fire having occurred. Firing age alone is blind
 * to the opposite fault, fires that dispatch and then die before reaching
 * `done`. Each covers the other's blind spot, so both are published and
 * neither is retired.
 *
 * Follows the `refreshQueuedRunAgeMetrics` shape (BLO-21116 / BLO-22094) and
 * inherits its two load-bearing properties: reset-then-set, and never zeroing
 * the gauges on refresh failure -- a synthetic 0 age reads as "fired just now",
 * which is the healthy state, and would hide the exact fault this exists to
 * catch.
 */
export async function refreshRoutineFireGapMetrics(db: Db, now = new Date()): Promise<void> {
  try {
    const scheduledRoutines = await selectScheduledRoutinesWithFireReceipts(db);

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
    const byRoutineId = new Map<
      string,
      {
        routineId: string;
        companyId: string;
        ageSeconds: number;
        fireStartAgeSeconds: number;
        intervalSeconds: number | null;
      }
    >();
    const ageSecondsSince = (value: Date | string) =>
      Math.max(0, (now.getTime() - new Date(value).getTime()) / 1000);
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
      // PEN-4647: the firing age falls back to created_at on the same rule and
      // for the same reason. A routine that has never DISPATCHED is the
      // strictly worse case of one that has never completed, so it must not
      // report a healthier number than its sibling -- and it must not be
      // absent, since absent renders as "nothing is wrong".
      const dispatchedSince = row.lastDispatchedAt ?? row.createdAt;
      byRoutineId.set(row.routineId, {
        routineId: row.routineId,
        companyId: row.companyId,
        ageSeconds: ageSecondsSince(since),
        fireStartAgeSeconds: ageSecondsSince(dispatchedSince),
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
