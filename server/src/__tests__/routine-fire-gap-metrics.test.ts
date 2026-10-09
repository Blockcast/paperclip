/**
 * BLO-32638 — the routine fire-gap gauge pair.
 *
 * A routine's receipt that it took a measurement is a `done` issue row in the
 * database, which Prometheus cannot see. So a routine silently disabled for
 * intervals is indistinguishable, on every other metrics surface, from a
 * healthy quiet one. Measured on the alert-delivery bridge watchdog
 * (BLO-31881): 11 gaps over 12h, largest 47.5h, one of them a 30.7h window in
 * which a real bridge outage destroyed 22 of 42 alerts while cadence,
 * run-status tallies and every `paperclip_routine_dispatch_total` label read
 * green.
 *
 * Five properties, each of which silently reproduces that invisibility if it
 * regresses:
 *   - a routine that has NEVER completed a fire gets a value, not an absent
 *     series: absent and "nothing is wrong" render identically on a dashboard,
 *   - a paused routine and a webhook/api-only routine emit NO interval, so the
 *     alert's vector match drops them rather than paging on a deliberate stop,
 *   - the age comes off a `completed` run and not merely a stamped
 *     `completed_at`: `skipped`, `coalesced` and `failed` all stamp that
 *     column, and a coalesced fire took no measurement of its own,
 *   - a failed refresh leaves the last snapshot alone and flips the freshness
 *     gauge, rather than publishing a healthy-looking synthetic zero,
 *   - the pair is always published together, so `age > 2 * interval` can never
 *     compare one routine's age against another's cadence.
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { companies, createDb, routineRuns, routineTriggers, routines } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  __resetMetricsForTest,
  ROUTINE_FIRE_GAP_METRICS_REFRESH_SUCCESS_METRIC,
  ROUTINE_FIRE_INTERVAL_METRIC,
  ROUTINE_LAST_DONE_FIRE_AGE_METRIC,
  renderMetrics,
} from "../services/metrics.js";
import { refreshRoutineFireGapMetrics } from "../services/routine-fire-gap-metrics.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres routine-fire-gap tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

/** A Wednesday, so a `* * * * 1-5` weekday cron is mid-week rather than at a weekend edge. */
const NOW = new Date("2026-10-07T12:00:00.000Z");
const HOUR_S = 3600;

/**
 * Read one gauge series EXACTLY.
 *
 * `toContain('…} 600')` is substring matching, so it also passes on `600000`
 * — i.e. it is vacuous against the single most likely regression in an age
 * gauge, a dropped `/ 1000`. The alert thresholds raw seconds against raw
 * seconds, so a 1000x unit error on either side pages permanently (or never)
 * with every test green. Parse the line and compare the value.
 */
async function gaugeValue(metric: string, routineId: string): Promise<string | undefined> {
  const { body } = await renderMetrics();
  const prefix = `${metric}{routine_id="${routineId}"} `;
  return body.split("\n").find((line) => line.startsWith(prefix))?.slice(prefix.length).trim();
}

describeEmbeddedPostgres("refreshRoutineFireGapMetrics (BLO-32638)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-routine-fire-gap-");
    db = createDb(tempDb.connectionString);
  }, 120_000);

  afterEach(async () => {
    await db.execute(sql`TRUNCATE TABLE routine_runs, routine_triggers, routines, companies CASCADE`);
    __resetMetricsForTest();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function insertCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Routine Gap Co",
      issuePrefix: "RGC",
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    return companyId;
  }

  async function insertRoutine(opts: {
    companyId: string;
    status?: string;
    createdAt?: Date;
    triggers?: Array<{
      kind?: string;
      enabled?: boolean;
      cronExpression?: string | null;
      timezone?: string | null;
    }>;
  }) {
    const routineId = randomUUID();
    await db.insert(routines).values({
      id: routineId,
      companyId: opts.companyId,
      title: "Watchdog",
      status: opts.status ?? "active",
      createdAt: opts.createdAt ?? NOW,
      updatedAt: opts.createdAt ?? NOW,
    });
    for (const trigger of opts.triggers ?? [{}]) {
      await db.insert(routineTriggers).values({
        id: randomUUID(),
        companyId: opts.companyId,
        routineId,
        kind: trigger.kind ?? "schedule",
        enabled: trigger.enabled ?? true,
        cronExpression: trigger.cronExpression === undefined ? "0 * * * *" : trigger.cronExpression,
        timezone: trigger.timezone === undefined ? "UTC" : trigger.timezone,
      });
    }
    return routineId;
  }

  async function insertRun(opts: {
    companyId: string;
    routineId: string;
    status: string;
    completedAt: Date | null;
  }) {
    await db.insert(routineRuns).values({
      id: randomUUID(),
      companyId: opts.companyId,
      routineId: opts.routineId,
      source: "schedule",
      status: opts.status,
      triggeredAt: opts.completedAt ?? NOW,
      completedAt: opts.completedAt,
    });
  }

  it("ages off the most recent completed fire and publishes the derived cadence", async () => {
    const companyId = await insertCompany();
    const routineId = await insertRoutine({ companyId });
    await insertRun({
      companyId,
      routineId,
      status: "completed",
      completedAt: new Date(NOW.getTime() - 5 * HOUR_S * 1000),
    });
    // An older completed fire must not win: the gauge reports the gap since
    // the LAST measurement, which is the thing the alert thresholds.
    await insertRun({
      companyId,
      routineId,
      status: "completed",
      completedAt: new Date(NOW.getTime() - 40 * HOUR_S * 1000),
    });

    await refreshRoutineFireGapMetrics(db, NOW);

    expect(await gaugeValue(ROUTINE_LAST_DONE_FIRE_AGE_METRIC, routineId)).toBe(String(5 * HOUR_S));
    expect(await gaugeValue(ROUTINE_FIRE_INTERVAL_METRIC, routineId)).toBe(String(HOUR_S));
    // The incident replay, as one assertion: at a 1h cadence a 5h silence is
    // over 2 * interval, so the rule the AC asks for fires. The 30.7h window
    // on a 1h-cadence watchdog is the same comparison 30x over.
    expect(5 * HOUR_S).toBeGreaterThan(2 * HOUR_S);
  });

  it("stays below the alert threshold across a healthy interval (negative control)", async () => {
    const companyId = await insertCompany();
    const routineId = await insertRoutine({ companyId });
    // A fire 40 minutes into a 1h cadence: normal, and the rule must be silent
    // here or it is a noise generator rather than a signal.
    await insertRun({
      companyId,
      routineId,
      status: "completed",
      completedAt: new Date(NOW.getTime() - 40 * 60 * 1000),
    });

    await refreshRoutineFireGapMetrics(db, NOW);

    const age = Number(await gaugeValue(ROUTINE_LAST_DONE_FIRE_AGE_METRIC, routineId));
    const interval = Number(await gaugeValue(ROUTINE_FIRE_INTERVAL_METRIC, routineId));
    expect(age).toBe(40 * 60);
    expect(age).toBeLessThanOrEqual(2 * interval);
  });

  it("ages a never-fired routine from its creation, with a value rather than an absent series", async () => {
    const companyId = await insertCompany();
    const routineId = await insertRoutine({
      companyId,
      createdAt: new Date(NOW.getTime() - 9 * HOUR_S * 1000),
    });

    await refreshRoutineFireGapMetrics(db, NOW);

    // The load-bearing half is that this is DEFINED. A routine broken from the
    // day it was created is exactly the case an absent series would hide.
    expect(await gaugeValue(ROUTINE_LAST_DONE_FIRE_AGE_METRIC, routineId)).toBe(String(9 * HOUR_S));
    expect(await gaugeValue(ROUTINE_FIRE_INTERVAL_METRIC, routineId)).toBe(String(HOUR_S));
  });

  it("ignores skipped, coalesced and failed runs even though they stamp completedAt", async () => {
    const companyId = await insertCompany();
    const routineId = await insertRoutine({
      companyId,
      createdAt: new Date(NOW.getTime() - 9 * HOUR_S * 1000),
    });
    for (const status of ["skipped", "coalesced", "failed"]) {
      await insertRun({
        companyId,
        routineId,
        status,
        completedAt: new Date(NOW.getTime() - 60 * 1000),
      });
    }

    await refreshRoutineFireGapMetrics(db, NOW);

    // None of those three took a measurement, so the routine is still
    // never-fired and reads its full age from creation. Keying on
    // `completed_at is not null` instead would read 60s here -- healthy --
    // over a routine whose every fire was skipped.
    expect(await gaugeValue(ROUTINE_LAST_DONE_FIRE_AGE_METRIC, routineId)).toBe(String(9 * HOUR_S));
  });

  it("emits no series at all for a paused routine", async () => {
    const companyId = await insertCompany();
    const routineId = await insertRoutine({ companyId, status: "paused" });

    await refreshRoutineFireGapMetrics(db, NOW);

    expect(await gaugeValue(ROUTINE_LAST_DONE_FIRE_AGE_METRIC, routineId)).toBeUndefined();
    expect(await gaugeValue(ROUTINE_FIRE_INTERVAL_METRIC, routineId)).toBeUndefined();
  });

  it("emits no series for a routine whose only triggers are webhook/api or disabled", async () => {
    const companyId = await insertCompany();
    const webhookOnly = await insertRoutine({
      companyId,
      triggers: [{ kind: "webhook", cronExpression: null, timezone: null }, { kind: "api", cronExpression: null, timezone: null }],
    });
    const disabledSchedule = await insertRoutine({
      companyId,
      triggers: [{ enabled: false }],
    });

    await refreshRoutineFireGapMetrics(db, NOW);

    for (const routineId of [webhookOnly, disabledSchedule]) {
      expect(await gaugeValue(ROUTINE_FIRE_INTERVAL_METRIC, routineId)).toBeUndefined();
      expect(await gaugeValue(ROUTINE_LAST_DONE_FIRE_AGE_METRIC, routineId)).toBeUndefined();
    }
  });

  it("takes the tightest cadence when a routine has several enabled schedule triggers", async () => {
    const companyId = await insertCompany();
    const routineId = await insertRoutine({
      companyId,
      triggers: [{ cronExpression: "0 0 * * *" }, { cronExpression: "*/15 * * * *" }],
    });

    await refreshRoutineFireGapMetrics(db, NOW);

    // Fires arrive from both, so the shortest interval is the cadence a
    // healthy routine should be meeting. Taking the daily one would let a
    // 15-minute watchdog go silent for most of a day before paging.
    expect(await gaugeValue(ROUTINE_FIRE_INTERVAL_METRIC, routineId)).toBe(String(15 * 60));
  });

  it("drops a routine out of the interval gauge once it is paused, rather than latching", async () => {
    const companyId = await insertCompany();
    const routineId = await insertRoutine({ companyId });
    await refreshRoutineFireGapMetrics(db, NOW);
    expect(await gaugeValue(ROUTINE_FIRE_INTERVAL_METRIC, routineId)).toBe(String(HOUR_S));

    await db.update(routines).set({ status: "paused" }).where(sql`${routines.id} = ${routineId}`);
    await refreshRoutineFireGapMetrics(db, NOW);

    // Reset-then-set, and it is load-bearing: a retained cadence would keep a
    // right-hand side for a routine that is deliberately not firing, and page
    // forever on an intentional pause.
    expect(await gaugeValue(ROUTINE_FIRE_INTERVAL_METRIC, routineId)).toBeUndefined();
    expect(await gaugeValue(ROUTINE_LAST_DONE_FIRE_AGE_METRIC, routineId)).toBeUndefined();
  });

  it("keeps the previous snapshot and flips the freshness gauge when the refresh fails", async () => {
    const companyId = await insertCompany();
    const routineId = await insertRoutine({ companyId });
    await insertRun({
      companyId,
      routineId,
      status: "completed",
      completedAt: new Date(NOW.getTime() - 30 * HOUR_S * 1000),
    });

    await refreshRoutineFireGapMetrics(db, NOW);
    expect(await gaugeValue(ROUTINE_LAST_DONE_FIRE_AGE_METRIC, routineId)).toBe(String(30 * HOUR_S));
    expect((await renderMetrics()).body).toContain(`${ROUTINE_FIRE_GAP_METRICS_REFRESH_SUCCESS_METRIC} 1`);

    const broken = {
      select: () => {
        throw new Error("database is on fire");
      },
    } as unknown as typeof db;
    await expect(refreshRoutineFireGapMetrics(broken, NOW)).rejects.toThrow("database is on fire");

    // The stale 30h age survives. Publishing a synthetic 0 here would read as
    // "fired just now" -- the healthy state -- over a dead refresh, which is
    // the same class of fault this whole gauge family exists to catch.
    expect(await gaugeValue(ROUTINE_LAST_DONE_FIRE_AGE_METRIC, routineId)).toBe(String(30 * HOUR_S));
    expect((await renderMetrics()).body).toContain(`${ROUTINE_FIRE_GAP_METRICS_REFRESH_SUCCESS_METRIC} 0`);
  });
});
