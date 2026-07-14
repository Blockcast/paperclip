import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
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
  claimRunWithExternalRuntimeSlot,
  externalRuntimeReservationCanRelease,
  markExternalRuntimeReservationLaunching,
  rearmExternalRuntimeReservationForRetry,
  recordExpectedExternalRuntimeJobName,
  recordExternalRuntimeJobIdentity,
  releaseExternalRuntimeReservation,
  requireExternalRuntimeLaunchOwnership,
} from "./external-runtime-reservations.js";
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
    })).rejects.toThrow(/identity mismatch/);
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
});
