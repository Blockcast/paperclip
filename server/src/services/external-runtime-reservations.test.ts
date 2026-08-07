import { randomUUID } from "node:crypto";
import { eq, inArray, isNull } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  externalRuntimeReservations,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import {
  bindExternalRuntimeReservationIsolation,
  claimRunWithExternalRuntimeSlot,
  claimRunWithExternalRuntimeSlotPool,
  ExternalRuntimeIsolationConflictError,
  externalRuntimeReservationCanRelease,
  markExternalRuntimeReservationLaunching,
  rearmExternalRuntimeReservationForRetry,
  recordExpectedExternalRuntimeJobName,
  recordExternalRuntimeJobIdentity,
  releaseExternalRuntimeReservation,
  requireExternalRuntimeExecutionOwnership,
  requireExternalRuntimeLaunchOwnership,
} from "./external-runtime-reservations.js";
import { parseExpectedExternalRuntimeJobNameFromMetaCommand } from "./heartbeat.js";
import {
  EXTERNAL_RUNTIME_RESERVATION_EVENTS_METRIC,
  EXTERNAL_RUNTIME_RESERVATIONS_ACTIVE_METRIC,
  __resetMetricsForTest,
  renderMetrics,
} from "./metrics.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("external runtime reservations", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;
  let agentId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-external-runtime-reservations-");
    db = createDb(tempDb.connectionString);
  });

  afterEach(async () => {
    await db.delete(externalRuntimeReservations);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
    __resetMetricsForTest();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedQueuedRuns(count: number): Promise<string[]> {
    companyId = randomUUID();
    agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "External Runtime Test",
      issuePrefix: `ER${companyId.replaceAll("-", "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "External Agent",
      role: "engineer",
      status: "idle",
      adapterType: "opencode_k8s",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const runIds = Array.from({ length: count }, () => randomUUID());
    await db.insert(heartbeatRuns).values(runIds.map((id) => ({
      id,
      companyId,
      agentId,
      status: "queued",
      contextSnapshot: {},
    })));
    return runIds;
  }

  it("atomically gives one slot to only one concurrent dispatcher", async () => {
    const [firstRunId, secondRunId] = await seedQueuedRuns(2);
    const now = new Date("2026-07-13T12:00:00.000Z");

    const results = await Promise.all([
      claimRunWithExternalRuntimeSlot(db, firstRunId, now),
      claimRunWithExternalRuntimeSlot(db, secondRunId, now),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    const runs = await db
      .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(inArray(heartbeatRuns.id, [firstRunId, secondRunId]));
    expect(runs.filter((run) => run.status === "running")).toHaveLength(1);
    expect(runs.filter((run) => run.status === "queued")).toHaveLength(1);
    expect(await db.select().from(externalRuntimeReservations)).toHaveLength(1);

    const metrics = await renderMetrics();
    expect(metrics.body).toContain(`${EXTERNAL_RUNTIME_RESERVATIONS_ACTIVE_METRIC} 1`);
    expect(metrics.body).toContain(`${EXTERNAL_RUNTIME_RESERVATION_EVENTS_METRIC}{event="reserved"} 1`);
    expect(metrics.body).toContain(`${EXTERNAL_RUNTIME_RESERVATION_EVENTS_METRIC}{event="contended"} 1`);
  });

  function eventCount(body: string, event: string): number {
    const match = new RegExp(
      `^${EXTERNAL_RUNTIME_RESERVATION_EVENTS_METRIC}\\{event="${event}"\\} (\\d+)`,
      "m",
    ).exec(body);
    return match ? Number(match[1]) : 0;
  }

  // BLO-23009: the pool walks slots 0..maxSlots-1 to find a free one, so a probe
  // losing to an occupied slot is an inner step of one dispatch attempt -- not an
  // independent contention event. Booking it per probe made `contended` a
  // scan-depth counter that over-reported by up to maxSlots x (observed
  // contended:reserved ~ 1340:1 on a merely-saturated fleet) and fired one
  // full-table metrics aggregate per probe under the agent start lock.
  it("books exactly one claim event per dispatch attempt, not one per slot probe", async () => {
    const runIds = await seedQueuedRuns(4);
    const now = new Date("2026-08-07T21:00:00.000Z");

    // Fill all three slots.
    for (const runId of runIds.slice(0, 3)) {
      expect(await claimRunWithExternalRuntimeSlotPool(db, runId, now, 3)).not.toBeNull();
    }

    __resetMetricsForTest();
    // A fourth attempt probes all 3 occupied slots and loses.
    expect(await claimRunWithExternalRuntimeSlotPool(db, runIds[3], now, 3)).toBeNull();

    const exhausted = (await renderMetrics()).body;
    expect(eventCount(exhausted, "contended")).toBe(1);
    expect(eventCount(exhausted, "reserved")).toBe(0);
  });

  it("books a single reserved event when a claim wins a later slot in the pool", async () => {
    const runIds = await seedQueuedRuns(3);
    const now = new Date("2026-08-07T21:05:00.000Z");

    // Occupy slots 0 and 1 so the third claim only wins after probing both.
    for (const runId of runIds.slice(0, 2)) {
      expect(await claimRunWithExternalRuntimeSlotPool(db, runId, now, 3)).not.toBeNull();
    }

    __resetMetricsForTest();
    expect(await claimRunWithExternalRuntimeSlotPool(db, runIds[2], now, 3)).not.toBeNull();

    const won = (await renderMetrics()).body;
    expect(eventCount(won, "reserved")).toBe(1);
    // The two losing probes are internal to a successful claim.
    expect(eventCount(won, "contended")).toBe(0);
  });

  // BLO-23009: the reconcile loop re-observes every running Job every cycle. The
  // steady-state no-op path returned the reservation unchanged but still booked a
  // `launched` event plus a count(*) aggregate -- measured at 25.8/s on an
  // otherwise idle fleet.
  it("does not re-book a launched event when re-observing an unchanged running Job", async () => {
    const [runId] = await seedQueuedRuns(1);
    await claimRunWithExternalRuntimeSlot(db, runId, new Date());
    await markExternalRuntimeReservationLaunching(db, runId);
    await recordExpectedExternalRuntimeJobName(db, { runId, jobName: "agent-opencode-run-1" });

    const first = await recordExternalRuntimeJobIdentity(db, {
      runId,
      jobName: "agent-opencode-run-1",
      jobUid: "uid-1",
    });
    expect(first?.state).toBe("launched");
    expect(eventCount((await renderMetrics()).body, "launched")).toBe(1);

    __resetMetricsForTest();
    const reobserved = await recordExternalRuntimeJobIdentity(db, {
      runId,
      jobName: "agent-opencode-run-1",
      jobUid: "uid-1",
    });

    // Still resolves to the same reservation -- callers rely on non-null here.
    expect(reobserved?.id).toBe(first?.id);
    expect(reobserved?.state).toBe("launched");
    expect(eventCount((await renderMetrics()).body, "launched")).toBe(0);

    // The run row still carries the stamp; it just is not rewritten each cycle.
    const run = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0]);
    expect(run.externalRunId).toBe("agent-opencode-run-1");
  });

  it("atomically fills a bounded slot pool without over-claiming", async () => {
    const runIds = await seedQueuedRuns(3);
    const now = new Date("2026-07-14T12:00:00.000Z");

    const results = await Promise.all(
      runIds.map((runId) => claimRunWithExternalRuntimeSlotPool(db, runId, now, 2)),
    );

    expect(results.filter(Boolean)).toHaveLength(2);
    const reservations = await db
      .select({ runId: externalRuntimeReservations.runId, slotId: externalRuntimeReservations.slotId })
      .from(externalRuntimeReservations);
    expect(reservations.map((reservation) => reservation.slotId).sort()).toEqual([0, 1]);

    const runs = await db
      .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(inArray(heartbeatRuns.id, runIds));
    expect(runs.filter((run) => run.status === "running")).toHaveLength(2);
    expect(runs.filter((run) => run.status === "queued")).toHaveLength(1);
  });

  it("does not claim a PR review task already running on another reviewer", async () => {
    const [followUpRunId] = await seedQueuedRuns(1);
    const ownerAgentId = randomUUID();
    const taskKey = "pr_review:Blockcast/paperclip:1014";
    const now = new Date("2026-08-04T12:00:00.000Z");

    await db.insert(agents).values({
      id: ownerAgentId,
      companyId,
      name: "Existing Review Owner",
      role: "engineer",
      status: "running",
      adapterType: "opencode_k8s",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db
      .update(heartbeatRuns)
      .set({ contextSnapshot: { taskKey, reviewKind: "pr_review" } })
      .where(eq(heartbeatRuns.id, followUpRunId));
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId: ownerAgentId,
      status: "running",
      contextSnapshot: { taskKey, reviewKind: "pr_review" },
      startedAt: now,
    });

    const claim = await claimRunWithExternalRuntimeSlotPool(db, followUpRunId, now, 3, {
      exclusivePrReviewTaskKey: taskKey,
    });

    expect(claim).toBeNull();
    expect(await db.select().from(externalRuntimeReservations)).toHaveLength(0);
    const followUp = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, followUpRunId))
      .then((rows) => rows[0] ?? null);
    expect(followUp?.status).toBe("queued");
  });

  it("atomically serializes concurrent PR review claims across reviewers", async () => {
    const [firstRunId, secondRunId] = await seedQueuedRuns(2);
    const secondReviewerId = randomUUID();
    const taskKey = "pr_review:Blockcast/paperclip:1015";
    const now = new Date("2026-08-04T12:05:00.000Z");

    await db.insert(agents).values({
      id: secondReviewerId,
      companyId,
      name: "Second Review Claimant",
      role: "engineer",
      status: "idle",
      adapterType: "opencode_k8s",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db
      .update(heartbeatRuns)
      .set({ contextSnapshot: { taskKey, reviewKind: "pr_review" } })
      .where(eq(heartbeatRuns.id, firstRunId));
    await db
      .update(heartbeatRuns)
      .set({
        agentId: secondReviewerId,
        contextSnapshot: { taskKey, reviewKind: "pr_review" },
      })
      .where(eq(heartbeatRuns.id, secondRunId));

    const claims = await Promise.all([
      claimRunWithExternalRuntimeSlotPool(db, firstRunId, now, 2, {
        exclusivePrReviewTaskKey: taskKey,
      }),
      claimRunWithExternalRuntimeSlotPool(db, secondRunId, now, 2, {
        exclusivePrReviewTaskKey: taskKey,
      }),
    ]);

    expect(claims.filter(Boolean)).toHaveLength(1);
    const runs = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(inArray(heartbeatRuns.id, [firstRunId, secondRunId]));
    expect(runs.filter((run) => run.status === "running")).toHaveLength(1);
    expect(runs.filter((run) => run.status === "queued")).toHaveLength(1);
    expect(await db.select().from(externalRuntimeReservations)).toHaveLength(1);
  });

  it("clears parked retry error metadata when an external runtime run is claimed", async () => {
    const [runId] = await seedQueuedRuns(1);
    const claimedAt = new Date("2026-07-14T12:30:00.000Z");
    await db
      .update(heartbeatRuns)
      .set({
        error: "provider capacity retry parked",
        errorCode: "rate_limit_exhausted",
        scheduledRetryAt: claimedAt,
        scheduledRetryAttempt: 2,
        scheduledRetryReason: "ccrotate_capacity",
      })
      .where(eq(heartbeatRuns.id, runId));

    const claim = await claimRunWithExternalRuntimeSlotPool(db, runId, claimedAt, 1);

    expect(claim?.run).toMatchObject({
      status: "running",
      error: null,
      errorCode: null,
      scheduledRetryAt: claimedAt,
      scheduledRetryAttempt: 2,
      scheduledRetryReason: "ccrotate_capacity",
    });
  });

  it("keeps two same-agent runs progressing through intentionally skewed launches", async () => {
    const [slowRunId, fastRunId] = await seedQueuedRuns(2);
    const claimedAt = new Date("2026-07-15T12:00:00.000Z");
    const [slowClaim, fastClaim] = await Promise.all([
      claimRunWithExternalRuntimeSlotPool(db, slowRunId, claimedAt, 2),
      claimRunWithExternalRuntimeSlotPool(db, fastRunId, claimedAt, 2),
    ]);

    expect(slowClaim).not.toBeNull();
    expect(fastClaim).not.toBeNull();
    expect(slowClaim!.reservation.slotId).not.toBe(fastClaim!.reservation.slotId);

    // Launch the second claimant first to preserve the pre-Job skew that used
    // to make the slower sibling look lost.
    await bindExternalRuntimeReservationIsolation(db, {
      runId: fastRunId,
      reservationId: fastClaim!.reservation.id,
      isolationMode: "run",
      isolationKey: `run:${fastRunId}`,
    });
    await markExternalRuntimeReservationLaunching(db, fastRunId);
    await recordExpectedExternalRuntimeJobName(db, { runId: fastRunId, jobName: "agent-fast" });
    await recordExternalRuntimeJobIdentity(db, {
      runId: fastRunId,
      jobName: "agent-fast",
      jobUid: "uid-fast",
    });

    const slowBeforeLaunch = await db
      .select()
      .from(externalRuntimeReservations)
      .where(eq(externalRuntimeReservations.runId, slowRunId))
      .then((rows) => rows[0]);
    expect(slowBeforeLaunch).toMatchObject({ state: "reserved", releasedAt: null });

    await bindExternalRuntimeReservationIsolation(db, {
      runId: slowRunId,
      reservationId: slowClaim!.reservation.id,
      isolationMode: "run",
      isolationKey: `run:${slowRunId}`,
    });
    await markExternalRuntimeReservationLaunching(db, slowRunId);
    await recordExpectedExternalRuntimeJobName(db, { runId: slowRunId, jobName: "agent-slow" });
    await recordExternalRuntimeJobIdentity(db, {
      runId: slowRunId,
      jobName: "agent-slow",
      jobUid: "uid-slow",
    });

    const active = await db
      .select()
      .from(externalRuntimeReservations)
      .where(isNull(externalRuntimeReservations.releasedAt));
    expect(active).toHaveLength(2);
    expect(active.map((reservation) => reservation.state).sort()).toEqual(["launched", "launched"]);

    await releaseExternalRuntimeReservation(db, { runId: slowRunId, reason: "succeeded" });
    await releaseExternalRuntimeReservation(db, { runId: fastRunId, reason: "succeeded" });
    expect(await db
      .select()
      .from(externalRuntimeReservations)
      .where(isNull(externalRuntimeReservations.releasedAt))).toHaveLength(0);
  });

  it("contains pre-launch sibling failure and releases only the failed slot", async () => {
    const [failedRunId, healthyRunId] = await seedQueuedRuns(2);
    const failedClaim = await claimRunWithExternalRuntimeSlotPool(db, failedRunId, new Date(), 2);
    const healthyClaim = await claimRunWithExternalRuntimeSlotPool(db, healthyRunId, new Date(), 2);

    await bindExternalRuntimeReservationIsolation(db, {
      runId: healthyRunId,
      reservationId: healthyClaim!.reservation.id,
      isolationMode: "run",
      isolationKey: `run:${healthyRunId}`,
    });
    await markExternalRuntimeReservationLaunching(db, healthyRunId);
    await recordExpectedExternalRuntimeJobName(db, { runId: healthyRunId, jobName: "healthy-job" });
    await recordExternalRuntimeJobIdentity(db, {
      runId: healthyRunId,
      jobName: "healthy-job",
      jobUid: "healthy-uid",
    });

    await db
      .update(heartbeatRuns)
      .set({ status: "failed", errorCode: "launch_failed", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, failedRunId));

    const [failedReservation, healthyReservation] = await Promise.all([
      db.select().from(externalRuntimeReservations)
        .where(eq(externalRuntimeReservations.id, failedClaim!.reservation.id))
        .then((rows) => rows[0]),
      db.select().from(externalRuntimeReservations)
        .where(eq(externalRuntimeReservations.id, healthyClaim!.reservation.id))
        .then((rows) => rows[0]),
    ]);
    expect(failedReservation).toMatchObject({ state: "released", releaseReason: "launch_failed" });
    expect(healthyReservation).toMatchObject({ state: "launched", releasedAt: null });

    await releaseExternalRuntimeReservation(db, { runId: healthyRunId, reason: "succeeded" });
    expect(await db
      .select()
      .from(externalRuntimeReservations)
      .where(isNull(externalRuntimeReservations.releasedAt))).toHaveLength(0);
  });

  it("reattaches exact sibling Jobs idempotently and cleans up cancellation independently", async () => {
    const [cancelledRunId, healthyRunId] = await seedQueuedRuns(2);
    const cancelledClaim = await claimRunWithExternalRuntimeSlotPool(db, cancelledRunId, new Date(), 2);
    const healthyClaim = await claimRunWithExternalRuntimeSlotPool(db, healthyRunId, new Date(), 2);

    for (const [runId, claim, jobName, jobUid] of [
      [cancelledRunId, cancelledClaim!, "cancelled-job", "cancelled-uid"],
      [healthyRunId, healthyClaim!, "healthy-job", "healthy-uid"],
    ] as const) {
      await bindExternalRuntimeReservationIsolation(db, {
        runId,
        reservationId: claim.reservation.id,
        isolationMode: "run",
        isolationKey: `run:${runId}`,
      });
      await markExternalRuntimeReservationLaunching(db, runId);
      await recordExpectedExternalRuntimeJobName(db, { runId, jobName });
      await recordExternalRuntimeJobIdentity(db, { runId, jobName, jobUid });
    }

    // A restarted server observes the same identities again. Reattachment is
    // idempotent and cannot replace one sibling's Job with the other's UID.
    const reattached = await Promise.all([
      recordExternalRuntimeJobIdentity(db, {
        runId: cancelledRunId,
        jobName: "cancelled-job",
        jobUid: "cancelled-uid",
      }),
      recordExternalRuntimeJobIdentity(db, {
        runId: healthyRunId,
        jobName: "healthy-job",
        jobUid: "healthy-uid",
      }),
    ]);
    expect(reattached.map((reservation) => reservation?.id).sort()).toEqual(
      [cancelledClaim!.reservation.id, healthyClaim!.reservation.id].sort(),
    );

    await db
      .update(heartbeatRuns)
      .set({ status: "cancelled", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, cancelledRunId));
    expect(await db.select().from(externalRuntimeReservations)
      .where(eq(externalRuntimeReservations.runId, cancelledRunId))
      .then((rows) => rows[0])).toMatchObject({ state: "release_pending" });
    expect(await requireExternalRuntimeExecutionOwnership(db, {
      runId: healthyRunId,
      reservationId: healthyClaim!.reservation.id,
      jobName: "healthy-job",
      jobUid: "healthy-uid",
    })).toMatchObject({ state: "launched" });

    await releaseExternalRuntimeReservation(db, { runId: cancelledRunId, reason: "job_missing" });
    await releaseExternalRuntimeReservation(db, { runId: healthyRunId, reason: "succeeded" });
    expect(await db
      .select()
      .from(externalRuntimeReservations)
      .where(isNull(externalRuntimeReservations.releasedAt))).toHaveLength(0);
  });

  it("enforces RWX logical isolation, RWO writer fencing, and shared-mode serialization", async () => {
    const runIds = await seedQueuedRuns(6);
    const [rwxFirstRunId, rwxSecondRunId, rwoFirstRunId, rwoSecondRunId, sharedFirstRunId, sharedSecondRunId] = runIds;
    const claims = new Map<string, NonNullable<Awaited<ReturnType<typeof claimRunWithExternalRuntimeSlotPool>>>>();
    for (const runId of runIds) {
      const claim = await claimRunWithExternalRuntimeSlotPool(db, runId, new Date(), 6);
      expect(claim).not.toBeNull();
      claims.set(runId, claim!);
    }

    // RWX only makes the volume mountable by multiple Jobs. Mutable state is
    // still isolated by distinct run keys.
    for (const runId of [rwxFirstRunId, rwxSecondRunId]) {
      await expect(bindExternalRuntimeReservationIsolation(db, {
        runId,
        reservationId: claims.get(runId)!.reservation.id,
        isolationMode: "run",
        isolationKey: `run:${runId}`,
      })).resolves.toMatchObject({ isolationKey: `run:${runId}` });
    }

    const rwoKey = "workspace:rwo-backed-workspace";
    await bindExternalRuntimeReservationIsolation(db, {
      runId: rwoFirstRunId,
      reservationId: claims.get(rwoFirstRunId)!.reservation.id,
      isolationMode: "workspace",
      isolationKey: rwoKey,
    });
    await expect(bindExternalRuntimeReservationIsolation(db, {
      runId: rwoSecondRunId,
      reservationId: claims.get(rwoSecondRunId)!.reservation.id,
      isolationMode: "workspace",
      isolationKey: rwoKey,
    })).rejects.toMatchObject({ code: "external_runtime_isolation_conflict" });

    const sharedKey = `agent-shared:${agentId}`;
    await bindExternalRuntimeReservationIsolation(db, {
      runId: sharedFirstRunId,
      reservationId: claims.get(sharedFirstRunId)!.reservation.id,
      isolationMode: "shared",
      isolationKey: sharedKey,
    });
    await expect(bindExternalRuntimeReservationIsolation(db, {
      runId: sharedSecondRunId,
      reservationId: claims.get(sharedSecondRunId)!.reservation.id,
      isolationMode: "shared",
      isolationKey: sharedKey,
    })).rejects.toMatchObject({ code: "external_runtime_isolation_conflict" });

    for (const runId of claims.keys()) {
      await releaseExternalRuntimeReservation(db, { runId, reason: "scenario_cleanup" });
    }
    expect(await db
      .select()
      .from(externalRuntimeReservations)
      .where(isNull(externalRuntimeReservations.releasedAt))).toHaveLength(0);
  });

  it("rotates reservation identity when a deferred run retries", async () => {
    const [runId] = await seedQueuedRuns(1);
    const firstClaim = await claimRunWithExternalRuntimeSlotPool(db, runId, new Date(), 2);
    expect(firstClaim).not.toBeNull();
    await bindExternalRuntimeReservationIsolation(db, {
      runId,
      reservationId: firstClaim!.reservation.id,
      isolationMode: "shared",
      isolationKey: `agent-shared:${agentId}`,
    });
    await releaseExternalRuntimeReservation(db, { runId, reason: "external_runtime_isolation_conflict" });
    await db
      .update(heartbeatRuns)
      .set({ status: "queued", startedAt: null, updatedAt: new Date() })
      .where(eq(heartbeatRuns.id, runId));

    const retryClaim = await claimRunWithExternalRuntimeSlotPool(db, runId, new Date(), 2);

    expect(retryClaim?.reservation).toMatchObject({
      state: "reserved",
      isolationMode: "pending",
      isolationKey: `pending:${runId}`,
      releasedAt: null,
      releaseReason: null,
    });
    expect(retryClaim?.reservation.id).not.toBe(firstClaim?.reservation.id);
    expect(retryClaim?.reservation.isolationBoundAt).not.toBeNull();
    expect(retryClaim?.run.status).toBe("running");
  });

  it("binds writer ownership idempotently for the same run and isolation key", async () => {
    const [runId] = await seedQueuedRuns(1);
    const claim = await claimRunWithExternalRuntimeSlot(db, runId, new Date("2026-07-14T00:00:00.000Z"));

    const first = await bindExternalRuntimeReservationIsolation(db, {
      runId,
      reservationId: claim!.reservation.id,
      isolationMode: "workspace",
      isolationKey: "workspace:workspace-1",
      now: new Date("2026-07-14T00:00:01.000Z"),
    });
    const retry = await bindExternalRuntimeReservationIsolation(db, {
      runId,
      reservationId: claim!.reservation.id,
      isolationMode: "workspace",
      isolationKey: "workspace:workspace-1",
      now: new Date("2026-07-14T00:00:02.000Z"),
    });

    expect(first).toMatchObject({
      isolationMode: "workspace",
      isolationKey: "workspace:workspace-1",
      isolationBoundAt: new Date("2026-07-14T00:00:01.000Z"),
    });
    expect(retry.id).toBe(first.id);
    expect(retry.isolationBoundAt).toEqual(first.isolationBoundAt);
  });

  it("marks new claims pending until workspace identity is known", async () => {
    const [runId] = await seedQueuedRuns(1);
    const claim = await claimRunWithExternalRuntimeSlot(db, runId, new Date("2026-07-14T00:00:00.000Z"));

    expect(claim?.reservation).toMatchObject({
      isolationMode: "pending",
      isolationKey: `pending:${runId}`,
      isolationBoundAt: new Date("2026-07-14T00:00:00.000Z"),
    });
  });

  it("marks reservations inserted by a rolling-upgrade legacy server", async () => {
    const [runId] = await seedQueuedRuns(1);
    const reservation = await db
      .insert(externalRuntimeReservations)
      .values({
        companyId,
        agentId,
        runId,
        slotId: 0,
        state: "reserved",
      })
      .returning()
      .then((rows) => rows[0]);

    expect(reservation).toMatchObject({
      isolationMode: "legacy",
      isolationKey: `legacy:${runId}`,
    });
    expect(reservation.isolationBoundAt).not.toBeNull();
  });

  it("defers durable writers until rolling-upgrade legacy reservations drain", async () => {
    const [legacyRunId, newRunId] = await seedQueuedRuns(2);
    const legacyClaim = await claimRunWithExternalRuntimeSlot(db, legacyRunId, new Date(), 0);
    const newClaim = await claimRunWithExternalRuntimeSlot(db, newRunId, new Date(), 1);
    await db
      .update(externalRuntimeReservations)
      .set({
        isolationMode: "legacy",
        isolationKey: `legacy:${legacyRunId}`,
      })
      .where(eq(externalRuntimeReservations.id, legacyClaim!.reservation.id));

    await expect(bindExternalRuntimeReservationIsolation(db, {
      runId: newRunId,
      reservationId: newClaim!.reservation.id,
      isolationMode: "workspace",
      isolationKey: "workspace:workspace-1",
    })).rejects.toMatchObject({
      code: "external_runtime_isolation_conflict",
      conflictingRunId: legacyRunId,
    });

    await releaseExternalRuntimeReservation(db, { runId: legacyRunId, reason: "legacy_drained" });
    await expect(bindExternalRuntimeReservationIsolation(db, {
      runId: newRunId,
      reservationId: newClaim!.reservation.id,
      isolationMode: "workspace",
      isolationKey: "workspace:workspace-1",
    })).resolves.toMatchObject({ isolationMode: "workspace" });
  });

  it("atomically fences a rolling legacy insert against a durable bind", async () => {
    const [legacyRunId, newRunId] = await seedQueuedRuns(2);
    const newClaim = await claimRunWithExternalRuntimeSlot(db, newRunId, new Date(), 1);

    const results = await Promise.allSettled([
      db.insert(externalRuntimeReservations).values({
        companyId,
        agentId,
        runId: legacyRunId,
        slotId: 0,
        state: "reserved",
      }),
      bindExternalRuntimeReservationIsolation(db, {
        runId: newRunId,
        reservationId: newClaim!.reservation.id,
        isolationMode: "workspace",
        isolationKey: "workspace:workspace-race",
      }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });

  it("rejects a second active writer for the same workspace key with a typed conflict", async () => {
    const [firstRunId, secondRunId] = await seedQueuedRuns(2);
    const firstClaim = await claimRunWithExternalRuntimeSlot(db, firstRunId, new Date(), 0);
    const secondClaim = await claimRunWithExternalRuntimeSlot(db, secondRunId, new Date(), 1);
    expect(firstClaim).not.toBeNull();
    expect(secondClaim).not.toBeNull();

    await bindExternalRuntimeReservationIsolation(db, {
      runId: firstRunId,
      reservationId: firstClaim!.reservation.id,
      isolationMode: "workspace",
      isolationKey: "workspace:shared-workspace",
    });

    let conflict: unknown;
    try {
      await bindExternalRuntimeReservationIsolation(db, {
        runId: secondRunId,
        reservationId: secondClaim!.reservation.id,
        isolationMode: "workspace",
        isolationKey: "workspace:shared-workspace",
      });
    } catch (error) {
      conflict = error;
    }
    expect(conflict).toBeInstanceOf(ExternalRuntimeIsolationConflictError);
    expect(conflict).toMatchObject({
      code: "external_runtime_isolation_conflict",
      runId: secondRunId,
      isolationKey: "workspace:shared-workspace",
      conflictingRunId: firstRunId,
    });
  });

  it("keeps the launching transition idempotent across realization and adapter dispatch", async () => {
    const [runId] = await seedQueuedRuns(1);
    const claim = await claimRunWithExternalRuntimeSlot(db, runId, new Date());
    await bindExternalRuntimeReservationIsolation(db, {
      runId,
      reservationId: claim!.reservation.id,
      isolationMode: "workspace",
      isolationKey: "workspace:workspace-1",
    });

    const realizing = await markExternalRuntimeReservationLaunching(db, runId);
    const dispatching = await markExternalRuntimeReservationLaunching(db, runId);

    expect(realizing?.state).toBe("launching");
    expect(dispatching?.id).toBe(realizing?.id);
  });

  it("rejects the same workspace key across different agents", async () => {
    const [firstRunId] = await seedQueuedRuns(1);
    const firstClaim = await claimRunWithExternalRuntimeSlot(db, firstRunId, new Date());
    const [secondRunId] = await seedQueuedRuns(1);
    const secondClaim = await claimRunWithExternalRuntimeSlot(db, secondRunId, new Date());
    const isolationKey = "workspace:globally-owned-workspace";

    await bindExternalRuntimeReservationIsolation(db, {
      runId: firstRunId,
      reservationId: firstClaim!.reservation.id,
      isolationMode: "workspace",
      isolationKey,
    });
    await expect(bindExternalRuntimeReservationIsolation(db, {
      runId: secondRunId,
      reservationId: secondClaim!.reservation.id,
      isolationMode: "workspace",
      isolationKey,
    })).rejects.toMatchObject({
      code: "external_runtime_isolation_conflict",
      conflictingRunId: firstRunId,
    });
  });

  it("allows one agent to own distinct run and workspace isolation keys", async () => {
    const [firstRunId, secondRunId] = await seedQueuedRuns(2);
    const firstClaim = await claimRunWithExternalRuntimeSlot(db, firstRunId, new Date(), 0);
    const secondClaim = await claimRunWithExternalRuntimeSlot(db, secondRunId, new Date(), 1);

    await expect(bindExternalRuntimeReservationIsolation(db, {
      runId: firstRunId,
      reservationId: firstClaim!.reservation.id,
      isolationMode: "run",
      isolationKey: `run:${firstRunId}`,
    })).resolves.toMatchObject({ isolationKey: `run:${firstRunId}` });
    await expect(bindExternalRuntimeReservationIsolation(db, {
      runId: secondRunId,
      reservationId: secondClaim!.reservation.id,
      isolationMode: "workspace",
      isolationKey: "workspace:workspace-2",
    })).resolves.toMatchObject({ isolationKey: "workspace:workspace-2" });
  });

  it("frees writer ownership when the reservation is released", async () => {
    const [firstRunId, secondRunId] = await seedQueuedRuns(2);
    const firstClaim = await claimRunWithExternalRuntimeSlot(db, firstRunId, new Date(), 0);
    const secondClaim = await claimRunWithExternalRuntimeSlot(db, secondRunId, new Date(), 1);
    const isolationKey = "workspace:reusable-workspace";

    await bindExternalRuntimeReservationIsolation(db, {
      runId: firstRunId,
      reservationId: firstClaim!.reservation.id,
      isolationMode: "workspace",
      isolationKey,
    });
    await releaseExternalRuntimeReservation(db, { runId: firstRunId, reason: "completed" });

    await expect(bindExternalRuntimeReservationIsolation(db, {
      runId: secondRunId,
      reservationId: secondClaim!.reservation.id,
      isolationMode: "workspace",
      isolationKey,
    })).resolves.toMatchObject({ runId: secondRunId, isolationKey });
  });

  it("rejects isolation key drift and released ownership", async () => {
    const [runId] = await seedQueuedRuns(1);
    const claim = await claimRunWithExternalRuntimeSlot(db, runId, new Date());
    await bindExternalRuntimeReservationIsolation(db, {
      runId,
      reservationId: claim!.reservation.id,
      isolationMode: "workspace",
      isolationKey: "workspace:workspace-1",
    });

    await expect(bindExternalRuntimeReservationIsolation(db, {
      runId,
      reservationId: claim!.reservation.id,
      isolationMode: "workspace",
      isolationKey: "workspace:workspace-2",
    })).rejects.toThrow(/binding drift/);

    await releaseExternalRuntimeReservation(db, { runId, reason: "cancelled" });
    await expect(bindExternalRuntimeReservationIsolation(db, {
      runId,
      reservationId: claim!.reservation.id,
      isolationMode: "workspace",
      isolationKey: "workspace:workspace-1",
    })).rejects.toThrow(/no longer owns isolation binding/);
  });

  it("keeps launched capacity owned until its exact Job is terminal or missing", () => {
    const launched = {
      state: "release_pending",
      jobName: "agent-opencode-run-1",
      expectedJobName: "agent-opencode-run-1",
    } as const;
    expect(externalRuntimeReservationCanRelease(launched, null)).toBe(false);
    expect(externalRuntimeReservationCanRelease(launched, "active")).toBe(false);
    expect(externalRuntimeReservationCanRelease(launched, "succeeded")).toBe(true);
    expect(externalRuntimeReservationCanRelease(launched, "missing")).toBe(true);
    expect(externalRuntimeReservationCanRelease({
      state: "release_pending",
      jobName: null,
      expectedJobName: null,
    }, null)).toBe(false);
    expect(externalRuntimeReservationCanRelease({
      state: "release_pending",
      jobName: null,
      expectedJobName: null,
    }, null, true)).toBe(true);
  });

  it("persists launch identity idempotently and rejects a different Job", async () => {
    const [runId] = await seedQueuedRuns(1);
    await claimRunWithExternalRuntimeSlot(db, runId, new Date());
    await markExternalRuntimeReservationLaunching(db, runId);
    await recordExpectedExternalRuntimeJobName(db, {
      runId,
      jobName: "agent-opencode-run-1",
    });

    const first = await recordExternalRuntimeJobIdentity(db, {
      runId,
      jobName: "agent-opencode-run-1",
      jobUid: "uid-1",
    });
    const retry = await recordExternalRuntimeJobIdentity(db, {
      runId,
      jobName: "agent-opencode-run-1",
      jobUid: "uid-1",
    });
    const missingUidObservation = await recordExternalRuntimeJobIdentity(db, {
      runId,
      jobName: "agent-opencode-run-1",
    });

    expect(first?.state).toBe("launched");
    expect(first?.expectedJobName).toBe("agent-opencode-run-1");
    expect(retry?.id).toBe(first?.id);
    expect(missingUidObservation?.jobUid).toBe("uid-1");
    const run = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0]);
    expect(run.externalRunId).toBe("agent-opencode-run-1");
    await expect(requireExternalRuntimeExecutionOwnership(db, {
      runId,
      reservationId: first!.id,
      jobName: "agent-opencode-run-1",
      jobUid: "uid-1",
    })).resolves.toMatchObject({ state: "launched", slotId: first!.slotId });
    await expect(requireExternalRuntimeExecutionOwnership(db, {
      runId,
      reservationId: first!.id,
      jobName: "agent-opencode-run-1",
      jobUid: "replacement-uid",
    })).rejects.toThrow(/no exact executable Job/);
    await expect(recordExternalRuntimeJobIdentity(db, {
      runId,
      jobName: "agent-opencode-run-2",
      jobUid: "uid-2",
    })).rejects.toThrow(/identity mismatch/);
  });

  it("re-arms a launched reservation for a replacement Job", async () => {
    const [runId] = await seedQueuedRuns(1);
    const claim = await claimRunWithExternalRuntimeSlot(db, runId, new Date());
    await markExternalRuntimeReservationLaunching(db, runId);
    await recordExpectedExternalRuntimeJobName(db, {
      runId,
      jobName: "agent-opencode-run-1",
    });
    await recordExternalRuntimeJobIdentity(db, {
      runId,
      jobName: "agent-opencode-run-1",
      jobUid: "uid-1",
    });

    const rearmed = await rearmExternalRuntimeReservationForRetry(db, {
      runId,
      reservationId: claim!.reservation.id,
    });

    expect(rearmed).toMatchObject({
      state: "launching",
      expectedJobName: null,
      jobName: null,
      jobUid: null,
      launchedAt: null,
    });
    await recordExpectedExternalRuntimeJobName(db, {
      runId,
      jobName: "agent-opencode-run-2",
    });
    const replacement = await recordExternalRuntimeJobIdentity(db, {
      runId,
      jobName: "agent-opencode-run-2",
      jobUid: "uid-2",
    });
    expect(replacement).toMatchObject({
      state: "launched",
      expectedJobName: "agent-opencode-run-2",
      jobName: "agent-opencode-run-2",
      jobUid: "uid-2",
    });
  });

  it("re-arms a retry when throttling happens before Job acknowledgment", async () => {
    const [runId] = await seedQueuedRuns(1);
    const claim = await claimRunWithExternalRuntimeSlot(db, runId, new Date());
    await markExternalRuntimeReservationLaunching(db, runId);
    await recordExpectedExternalRuntimeJobName(db, {
      runId,
      jobName: "agent-opencode-unacknowledged",
    });

    const rearmed = await rearmExternalRuntimeReservationForRetry(db, {
      runId,
      reservationId: claim!.reservation.id,
    });

    expect(rearmed).toMatchObject({
      state: "launching",
      expectedJobName: null,
      jobName: null,
      jobUid: null,
    });
  });

  it("rejects launch identity after the run has lost its reservation", async () => {
    const [runId] = await seedQueuedRuns(1);
    await claimRunWithExternalRuntimeSlot(db, runId, new Date());
    await markExternalRuntimeReservationLaunching(db, runId);
    await recordExpectedExternalRuntimeJobName(db, {
      runId,
      jobName: "agent-opencode-run-1",
    });
    await db
      .update(heartbeatRuns)
      .set({ status: "cancelled", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, runId));

    await expect(recordExternalRuntimeJobIdentity(db, {
      runId,
      jobName: "agent-opencode-run-1",
      jobUid: "uid-after-cancel",
    })).rejects.toThrow(/not launchable from release_pending/);
  });

  it("releases a not-yet-launched reservation for every terminal run status", async () => {
    const runIds = await seedQueuedRuns(4);
    const statuses = ["succeeded", "failed", "cancelled", "timed_out"] as const;

    for (const [index, status] of statuses.entries()) {
      const runId = runIds[index];
      expect(await claimRunWithExternalRuntimeSlot(db, runId, new Date())).not.toBeNull();
      await db
        .update(heartbeatRuns)
        .set({ status, finishedAt: new Date() })
        .where(eq(heartbeatRuns.id, runId));
      const reservation = await db
        .select()
        .from(externalRuntimeReservations)
        .where(eq(externalRuntimeReservations.runId, runId))
        .then((rows) => rows[0]);
      expect(reservation.state).toBe("released");
      expect(reservation.releasedAt).not.toBeNull();
    }
  });

  it("releases only the failed run slot and allows the queued retry to reuse it", async () => {
    const [failedRunId, retryRunId] = await seedQueuedRuns(2);
    const firstClaim = await claimRunWithExternalRuntimeSlot(db, failedRunId, new Date());
    expect(firstClaim).not.toBeNull();
    await markExternalRuntimeReservationLaunching(db, failedRunId);

    await db
      .update(heartbeatRuns)
      .set({ status: "failed", errorCode: "adapter_failed", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, failedRunId));

    const released = await db
      .select()
      .from(externalRuntimeReservations)
      .where(eq(externalRuntimeReservations.runId, failedRunId))
      .then((rows) => rows[0]);
    expect(released).toMatchObject({
      state: "release_pending",
      releaseReason: "adapter_failed",
    });
    expect(released.releasedAt).toBeNull();
    await expect(requireExternalRuntimeLaunchOwnership(db, {
      runId: failedRunId,
      reservationId: firstClaim!.reservation.id,
    })).rejects.toThrow(/no longer owns launch/);
    await expect(recordExpectedExternalRuntimeJobName(db, {
      runId: failedRunId,
      jobName: "late-job",
    })).rejects.toThrow(/no longer launchable/);

    expect(await claimRunWithExternalRuntimeSlot(db, retryRunId, new Date())).toBeNull();
    await releaseExternalRuntimeReservation(db, {
      runId: failedRunId,
      reason: "adapter_failed",
    });

    const retryClaim = await claimRunWithExternalRuntimeSlot(db, retryRunId, new Date());
    expect(retryClaim?.reservation.slotId).toBe(firstClaim?.reservation.slotId);
    const active = await db
      .select()
      .from(externalRuntimeReservations)
      .where(eq(externalRuntimeReservations.runId, retryRunId));
    expect(active).toHaveLength(1);
    expect(active[0].releasedAt).toBeNull();
  });

  it("drives the real meta.command dispatch path: valid metadata records the expected name, drifted metadata fails closed", async () => {
    // Exercises the exact chain heartbeat.ts's onAdapterMeta ->
    // onExternalRuntimeLaunched callbacks run, using the shared parser
    // instead of a re-typed regex, closing the gap flagged on PR #656 where
    // every test called recordExpectedExternalRuntimeJobName directly with a
    // hardcoded name and never proved the meta.command parse itself worked.
    // Two separate agents so both reservations can hold slot 0 concurrently.
    const [validRunId] = await seedQueuedRuns(1);
    const [driftedRunId] = await seedQueuedRuns(1);

    await claimRunWithExternalRuntimeSlot(db, validRunId, new Date());
    await markExternalRuntimeReservationLaunching(db, validRunId);
    const parsedValid = parseExpectedExternalRuntimeJobNameFromMetaCommand("kubectl job/agent-opencode-run-9");
    expect(parsedValid).toBe("agent-opencode-run-9");
    await recordExpectedExternalRuntimeJobName(db, { runId: validRunId, jobName: parsedValid! });
    const acked = await recordExternalRuntimeJobIdentity(db, {
      runId: validRunId,
      jobName: "agent-opencode-run-9",
      jobUid: "uid-valid",
    });
    expect(acked?.state).toBe("launched");
    expect(acked?.expectedJobName).toBe("agent-opencode-run-9");

    await claimRunWithExternalRuntimeSlot(db, driftedRunId, new Date());
    await markExternalRuntimeReservationLaunching(db, driftedRunId);
    // Drifted adapter metadata: reports the real invoked command instead of
    // the "kubectl job/<name>" sentinel, so nothing matches and no expected
    // name is ever persisted.
    const parsedDrifted = parseExpectedExternalRuntimeJobNameFromMetaCommand(
      "kubectl apply -f /tmp/agent-opencode-run-10.yaml",
    );
    expect(parsedDrifted).toBeNull();
    // The post-create identity ack must fail closed instead of silently
    // adopting an unexpected Job.
    await expect(
      recordExternalRuntimeJobIdentity(db, { runId: driftedRunId, jobName: "agent-opencode-run-10", jobUid: "uid-drifted" }),
    ).rejects.toThrow(/observed before an expected name was persisted/);
  });
});

describe("parseExpectedExternalRuntimeJobNameFromMetaCommand", () => {
  it("extracts the Job name from a well-formed kubectl job sentinel", () => {
    expect(parseExpectedExternalRuntimeJobNameFromMetaCommand("kubectl job/agent-opencode-run-1")).toBe(
      "agent-opencode-run-1",
    );
    expect(parseExpectedExternalRuntimeJobNameFromMetaCommand("kubectl job/a")).toBe("a");
  });

  it("rejects commands that don't match the exact sentinel format", () => {
    expect(parseExpectedExternalRuntimeJobNameFromMetaCommand("kubectl apply -f job.yaml")).toBeNull();
    expect(parseExpectedExternalRuntimeJobNameFromMetaCommand("kubectl Job/agent-run-1")).toBeNull();
    expect(parseExpectedExternalRuntimeJobNameFromMetaCommand("kubectl job/Agent-Run-1")).toBeNull();
    expect(parseExpectedExternalRuntimeJobNameFromMetaCommand("kubectl job/agent-run-1 ")).toBeNull();
    expect(parseExpectedExternalRuntimeJobNameFromMetaCommand(" kubectl job/agent-run-1")).toBeNull();
    expect(parseExpectedExternalRuntimeJobNameFromMetaCommand("kubectl job/-agent-run-1")).toBeNull();
    expect(parseExpectedExternalRuntimeJobNameFromMetaCommand("kubectl job/agent-run-1-")).toBeNull();
    expect(parseExpectedExternalRuntimeJobNameFromMetaCommand("kubectl job/agent/run-1")).toBeNull();
    expect(parseExpectedExternalRuntimeJobNameFromMetaCommand("kubectl job/")).toBeNull();
  });

  it("rejects a Job name longer than the 63-character Kubernetes label limit", () => {
    const tooLong = `agent-${"a".repeat(60)}`;
    expect(tooLong.length).toBeGreaterThan(63);
    expect(parseExpectedExternalRuntimeJobNameFromMetaCommand(`kubectl job/${tooLong}`)).toBeNull();
  });
});
