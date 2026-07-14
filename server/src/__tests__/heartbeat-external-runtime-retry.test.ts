import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  createDb,
  externalRuntimeReservations,
  heartbeatRuns,
} from "@paperclipai/db";
import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
} from "@paperclipai/adapter-utils";
import { heartbeatService } from "../services/heartbeat.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { cleanupHeartbeatTestState } from "./helpers/cleanup-heartbeat-test-state.js";
import {
  bindExternalRuntimeReservationIsolation,
  claimRunWithExternalRuntimeSlot,
} from "../services/external-runtime-reservations.js";

const mockAdapterExecute = vi.hoisted(() => vi.fn());

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => ({ track: vi.fn() }),
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return { ...actual, trackAgentFirstHeartbeat: vi.fn() };
});

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      type: "claude_k8s",
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres external-runtime retry tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat external-runtime retry ownership", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-external-runtime-retry-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db, {
      penstockAvailabilityGate: {
        checkAdapter: async () => ({ allow: true }),
        _resetForTesting() {},
      },
    });
  }, 30_000);

  afterEach(async () => {
    mockAdapterExecute.mockReset();
    await cleanupHeartbeatTestState(db, heartbeat);
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("re-arms ownership and persists metadata for a replacement Job after ccrotate throttle", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const jobName = "agent-claude-external-runtime-retry";

    await db.insert(companies).values({
      id: companyId,
      name: "External Runtime Retry Co",
      issuePrefix: "ERR",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Claude K8s",
      role: "engineer",
      status: "active",
      adapterType: "claude_k8s",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          enabled: true,
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      contextSnapshot: {},
    });

    mockAdapterExecute.mockImplementation(async (ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> => {
      const attempt = mockAdapterExecute.mock.calls.length;
      await ctx.onMeta?.({
        adapterType: "claude_k8s",
        command: `kubectl job/${jobName}`,
      });
      await ctx.onExternalRuntimeLaunched?.({
        jobName,
        jobUid: `job-uid-${attempt}`,
      });

      if (attempt === 1) {
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          errorMessage: null,
          summary: "provider throttled before progress",
          resultJson: { api_error_status: 429, retry_after_seconds: 0 },
          usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
          provider: "test",
          model: "test-model",
        };
      }

      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        summary: "replacement Job completed",
        resultJson: { ok: true },
        usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 },
        provider: "test",
        model: "test-model",
      };
    });

    await heartbeat.__test_executeRunForTesting(runId);

    const run = await db
      .select({ status: heartbeatRuns.status, error: heartbeatRuns.error })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0]);
    const reservation = await db
      .select()
      .from(externalRuntimeReservations)
      .where(eq(externalRuntimeReservations.runId, runId))
      .then((rows) => rows[0]);

    expect(mockAdapterExecute).toHaveBeenCalledTimes(2);
    expect(run).toMatchObject({ status: "succeeded", error: null });
    expect(reservation).toMatchObject({
      expectedJobName: jobName,
      jobName,
      jobUid: "job-uid-2",
    });
    const reservationIds = mockAdapterExecute.mock.calls.map(
      ([ctx]) => (ctx as AdapterExecutionContext).externalRuntime?.reservationId,
    );
    expect(new Set(reservationIds)).toEqual(new Set([reservation.id]));
  }, 30_000);

  it("defers a same-scope contender without failing or invoking its adapter", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const ownerRunId = randomUUID();
    const contenderRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "External Runtime Isolation Co",
      issuePrefix: "ERI",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Shared Claude K8s",
      role: "engineer",
      status: "running",
      adapterType: "claude_k8s",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          enabled: true,
          wakeOnDemand: true,
          maxConcurrentRuns: 2,
        },
      },
      permissions: {},
    });
    await db.insert(heartbeatRuns).values([
      {
        id: ownerRunId,
        companyId,
        agentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "queued",
        contextSnapshot: {},
      },
      {
        id: contenderRunId,
        companyId,
        agentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "queued",
        contextSnapshot: {},
      },
    ]);

    const ownerClaim = await claimRunWithExternalRuntimeSlot(db, ownerRunId, new Date(), 0);
    expect(ownerClaim).not.toBeNull();
    await bindExternalRuntimeReservationIsolation(db, {
      runId: ownerRunId,
      reservationId: ownerClaim!.reservation.id,
      isolationMode: "shared",
      isolationKey: `agent-shared:${agentId}`,
    });

    await heartbeat.__test_executeRunForTesting(contenderRunId);

    const contender = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, contenderRunId))
      .then((rows) => rows[0]);
    const reservations = await db
      .select()
      .from(externalRuntimeReservations)
      .where(eq(externalRuntimeReservations.agentId, agentId));
    const contenderReservation = reservations.find((reservation) => reservation.runId === contenderRunId);

    expect(mockAdapterExecute).not.toHaveBeenCalled();
    expect(contender.status).toBe("queued");
    expect(contender.error).toBeNull();
    expect(contender.errorCode).toBeNull();
    expect(contender.contextSnapshot).toMatchObject({
      paperclipK8sIsolationRetryAttempt: 1,
    });
    expect(new Date(String(contender.contextSnapshot?.paperclipK8sIsolationRetryAt)).getTime()).toBeGreaterThan(
      Date.now(),
    );
    expect(contenderReservation).toMatchObject({
      state: "released",
      releaseReason: "external_runtime_isolation_conflict",
    });
    expect(reservations.find((reservation) => reservation.runId === ownerRunId)?.releasedAt).toBeNull();

    await db
      .update(heartbeatRuns)
      .set({ status: "succeeded", finishedAt: new Date(), updatedAt: new Date() })
      .where(eq(heartbeatRuns.id, ownerRunId));
    await db
      .update(heartbeatRuns)
      .set({
        contextSnapshot: {
          ...contender.contextSnapshot,
          paperclipK8sIsolationRetryAt: new Date(Date.now() - 1_000).toISOString(),
        },
        updatedAt: new Date(),
      })
      .where(eq(heartbeatRuns.id, contenderRunId));
    mockAdapterExecute.mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      summary: "serialized contender completed",
      resultJson: { ok: true },
      usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 },
      provider: "test",
      model: "test-model",
    });

    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainInFlightExecutions(10_000);

    const completedContender = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, contenderRunId))
      .then((rows) => rows[0]);
    const reusedReservation = await db
      .select()
      .from(externalRuntimeReservations)
      .where(eq(externalRuntimeReservations.runId, contenderRunId))
      .then((rows) => rows[0]);
    expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
    expect(completedContender.status).toBe("succeeded");
    expect(reusedReservation.id).toBe(contenderReservation?.id);
    expect(reusedReservation.isolationKey).toBe(`agent-shared:${agentId}`);
  }, 30_000);
});
