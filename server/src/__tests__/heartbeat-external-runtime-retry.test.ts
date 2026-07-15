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
  releaseExternalRuntimeReservation,
} from "../services/external-runtime-reservations.js";

const mockAdapterExecute = vi.hoisted(() => vi.fn());
const mockListAgentJobRunStatuses = vi.hoisted(() => vi.fn(async () => null));
const mockListLiveAgentJobRunIds = vi.hoisted(() => vi.fn(async () => null));
const mockListManagedAgentJobs = vi.hoisted(() => vi.fn(async () => null));
const mockReadAgentJobRunStatusByName = vi.hoisted(() => vi.fn(async () => null));
const mockDeleteAgentJobExact = vi.hoisted(() => vi.fn(async () => "deleted" as const));
const mockHasActiveJobForAgent = vi.hoisted(() => vi.fn(async () => false));
// Passthrough by default -- only the reconciliation-loop race test below
// overrides this once to inject a release between the reservation read and
// the identity stamp, mirroring the production race this module documents.
const mockGetActiveExternalRuntimeReservation = vi.hoisted(() => vi.fn());

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => ({ track: vi.fn() }),
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return { ...actual, trackAgentFirstHeartbeat: vi.fn() };
});

vi.mock("../services/k8s-job-liveness.ts", async () => {
  // Spread actual so pure helpers (indexUniqueAgentJobRunStatuses,
  // matchExactAgentJob) stay real -- the reconciliation-loop race test below
  // needs them to index/match a synthetic managedJobs list.
  const actual = await vi.importActual<typeof import("../services/k8s-job-liveness.ts")>(
    "../services/k8s-job-liveness.ts",
  );
  return {
    ...actual,
    listAgentJobRunStatuses: mockListAgentJobRunStatuses,
    listLiveAgentJobRunIds: mockListLiveAgentJobRunIds,
    listManagedAgentJobs: mockListManagedAgentJobs,
    readAgentJobRunStatusByName: mockReadAgentJobRunStatusByName,
    deleteAgentJobExact: mockDeleteAgentJobExact,
    hasActiveJobForAgent: mockHasActiveJobForAgent,
  };
});

const actualExternalRuntimeReservationsRef = vi.hoisted(() => ({
  current: null as unknown as typeof import("../services/external-runtime-reservations.ts"),
}));
vi.mock("../services/external-runtime-reservations.ts", async () => {
  actualExternalRuntimeReservationsRef.current = await vi.importActual<
    typeof import("../services/external-runtime-reservations.ts")
  >("../services/external-runtime-reservations.ts");
  return {
    ...actualExternalRuntimeReservationsRef.current,
    getActiveExternalRuntimeReservation: (...args: Parameters<
      typeof actualExternalRuntimeReservationsRef.current.getActiveExternalRuntimeReservation
    >) => mockGetActiveExternalRuntimeReservation(...args),
  };
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
    // afterEach only re-arms the passthrough for the *next* test -- without
    // this, the very first test in the file runs with
    // mockGetActiveExternalRuntimeReservation unconfigured (resolves
    // undefined instead of delegating), which silently starves every
    // production call site of that function, not just the reconciliation
    // loop this mock exists for.
    mockGetActiveExternalRuntimeReservation.mockImplementation((...args: Parameters<
      typeof actualExternalRuntimeReservationsRef.current.getActiveExternalRuntimeReservation
    >) => actualExternalRuntimeReservationsRef.current.getActiveExternalRuntimeReservation(...args));
  }, 30_000);

  afterEach(async () => {
    mockAdapterExecute.mockReset();
    mockListAgentJobRunStatuses.mockReset().mockResolvedValue(null);
    mockListLiveAgentJobRunIds.mockReset().mockResolvedValue(null);
    mockListManagedAgentJobs.mockReset().mockResolvedValue(null);
    mockReadAgentJobRunStatusByName.mockReset().mockResolvedValue(null);
    mockDeleteAgentJobExact.mockReset().mockResolvedValue("deleted");
    mockHasActiveJobForAgent.mockReset().mockResolvedValue(false);
    mockGetActiveExternalRuntimeReservation
      .mockReset()
      .mockImplementation((...args: Parameters<
        typeof actualExternalRuntimeReservationsRef.current.getActiveExternalRuntimeReservation
      >) => actualExternalRuntimeReservationsRef.current.getActiveExternalRuntimeReservation(...args));
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

    let allowReplacementLaunch!: () => void;
    const replacementLaunchGate = new Promise<void>((resolve) => { allowReplacementLaunch = resolve; });
    mockAdapterExecute.mockImplementation(async (ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> => {
      const attempt = mockAdapterExecute.mock.calls.length;
      if (attempt === 2) await replacementLaunchGate;
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
          resultJson: { api_error_status: 429, retry_after_seconds: 2 },
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

    const execution = heartbeat.__test_executeRunForTesting(runId);
    let retryReservation: typeof externalRuntimeReservations.$inferSelect | undefined;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      retryReservation = await db
        .select()
        .from(externalRuntimeReservations)
        .where(eq(externalRuntimeReservations.runId, runId))
        .then((rows) => rows[0]);
      if (
        mockAdapterExecute.mock.calls.length === 1 &&
        retryReservation?.state === "launching" &&
        retryReservation.expectedJobName === null &&
        retryReservation.jobName === null &&
        retryReservation.jobUid === null
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(retryReservation).toMatchObject({
      state: "launching",
      expectedJobName: null,
      jobName: null,
      jobUid: null,
    });

    // Simulate the periodic watcher holding a stale snapshot of the failed
    // first Job while executeRun is intentionally waiting to launch attempt 2.
    mockListAgentJobRunStatuses.mockResolvedValue(new Map([
      [runId, {
        phase: "failed" as const,
        reason: "BackoffLimitExceeded",
        message: "Job has reached the specified backoff limit",
        name: jobName,
        uid: "job-uid-1",
      }],
    ]));
    const reaped = await heartbeat.reapOrphanedRuns();
    const runDuringRetry = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0]);
    const reservationDuringRetry = await db
      .select()
      .from(externalRuntimeReservations)
      .where(eq(externalRuntimeReservations.runId, runId))
      .then((rows) => rows[0]);
    expect(reaped).not.toContain(runId);
    expect(runDuringRetry?.status).toBe("running");
    expect(reservationDuringRetry).toMatchObject({
      state: "launching",
      jobName: null,
      jobUid: null,
    });

    allowReplacementLaunch();
    await execution;

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
          // BLO-15959: this test exercises isolation-key serialization across
          // two slots (not just the fallback one-run cap), so it must opt
          // into concurrency to reach the isolation-conflict path.
          concurrencyEnabled: true,
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
    expect(reusedReservation.id).not.toBe(contenderReservation?.id);
    expect(reusedReservation.isolationKey).toBe(`agent-shared:${agentId}`);
  }, 30_000);

  // BLO-16269: `createNamespacedJob` happens inside the bundled k8s adapter
  // (outside this repo) and can land in-cluster even after the reservation
  // gating it has been reaped/released -- observed live as two same-agent
  // runs finalized `process_lost` (`pre_adapter_job_unstamped`) right before
  // Kubernetes created their Jobs, leaving one Job leaked because the later
  // cleanup pass could not reconcile it against an already-released
  // reservation ("refusing terminal Job cleanup ... reservationId:null").
  it("compensates by deleting the exact Job when its reservation is reaped before the launched identity arrives", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const jobName = "agent-claude-race-lost";

    await db.insert(companies).values({
      id: companyId,
      name: "External Runtime Race Co",
      issuePrefix: "ERX",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Claude K8s Race",
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

    let allowStampToProceed!: () => void;
    const stampGate = new Promise<void>((resolve) => { allowStampToProceed = resolve; });
    mockAdapterExecute.mockImplementation(async (ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> => {
      await ctx.onMeta?.({ adapterType: "claude_k8s", command: `kubectl job/${jobName}` });
      // createNamespacedJob has already succeeded in-cluster at this point;
      // hold before reporting it back so the test can reap/release the
      // reservation out from under the in-flight launch.
      await stampGate;
      await ctx.onExternalRuntimeLaunched?.({ jobName, jobUid: "race-lost-uid" });
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        summary: "job launched after its reservation was reaped",
        resultJson: { ok: true },
        usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 },
        provider: "test",
        model: "test-model",
      };
    });

    const execution = heartbeat.__test_executeRunForTesting(runId);

    let reservationBeforeReap: typeof externalRuntimeReservations.$inferSelect | undefined;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      reservationBeforeReap = await db
        .select()
        .from(externalRuntimeReservations)
        .where(eq(externalRuntimeReservations.runId, runId))
        .then((rows) => rows[0]);
      if (reservationBeforeReap?.state === "launching" && reservationBeforeReap.expectedJobName === jobName) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(reservationBeforeReap).toMatchObject({
      state: "launching",
      expectedJobName: jobName,
      jobName: null,
      jobUid: null,
    });

    // Simulate the reap tick: mint process_lost on the run and release its
    // reservation -- the exact "pre_adapter_job_unstamped" path from
    // BLO-16269 -- while createNamespacedJob is still in flight for it.
    await db
      .update(heartbeatRuns)
      .set({ status: "failed", errorCode: "process_lost", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, runId));
    await releaseExternalRuntimeReservation(db, { runId, reason: "process_lost" });

    allowStampToProceed();
    await execution;

    expect(mockDeleteAgentJobExact).toHaveBeenCalledWith({
      runId,
      agentId,
      name: jobName,
      uid: "race-lost-uid",
    });

    const reservation = await db
      .select()
      .from(externalRuntimeReservations)
      .where(eq(externalRuntimeReservations.runId, runId))
      .then((rows) => rows[0]);
    expect(reservation.state).toBe("released");
    expect(reservation.jobName).toBeNull();
    expect(reservation.jobUid).toBeNull();

    const run = await db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0]);
    expect(run).toMatchObject({ status: "failed", errorCode: "process_lost" });
  }, 30_000);

  it("does not touch a sibling run's live Job when only one run's create/stamp race is lost", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const losingRunId = randomUUID();
    const siblingRunId = randomUUID();
    const losingJobName = "agent-claude-race-lost-sibling";
    const siblingJobName = "agent-claude-race-survivor-sibling";

    await db.insert(companies).values({
      id: companyId,
      name: "External Runtime Sibling Co",
      issuePrefix: "ERS",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Claude K8s Sibling",
      role: "engineer",
      status: "active",
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
        id: losingRunId,
        companyId,
        agentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "queued",
        // Stateless PR-review runs get "run" isolation (independent per run
        // id) instead of the default single-writer-per-agent "shared" mode --
        // matching the production BLO-16269 repro of two run-isolated
        // heartbeats for the same agent. prRole: "author" keeps this out of
        // the reviewer-evidence gate (BLO-8215), which is irrelevant here.
        contextSnapshot: {
          wakeReason: "github_pr_review_requested",
          reviewKind: "pr_review",
          githubPrNumber: 501,
          prRole: "author",
        },
      },
      {
        id: siblingRunId,
        companyId,
        agentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "queued",
        contextSnapshot: {
          wakeReason: "github_pr_review_requested",
          reviewKind: "pr_review",
          githubPrNumber: 502,
          prRole: "author",
        },
      },
    ]);

    let allowLosingStampToProceed!: () => void;
    const losingStampGate = new Promise<void>((resolve) => { allowLosingStampToProceed = resolve; });
    let allowSiblingStampToProceed!: () => void;
    const siblingStampGate = new Promise<void>((resolve) => { allowSiblingStampToProceed = resolve; });

    mockAdapterExecute.mockImplementation(async (ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> => {
      const isLosingRun = ctx.runId === losingRunId;
      const jobName = isLosingRun ? losingJobName : siblingJobName;
      await ctx.onMeta?.({ adapterType: "claude_k8s", command: `kubectl job/${jobName}` });
      await (isLosingRun ? losingStampGate : siblingStampGate);
      await ctx.onExternalRuntimeLaunched?.({
        jobName,
        jobUid: isLosingRun ? "race-lost-uid-sibling" : "survivor-uid-sibling",
      });
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        summary: isLosingRun ? "reaped run's job launched after the race" : "sibling job launched normally",
        resultJson: { ok: true },
        usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 },
        provider: "test",
        model: "test-model",
      };
    });

    const losingExecution = heartbeat.__test_executeRunForTesting(losingRunId);
    const siblingExecution = heartbeat.__test_executeRunForTesting(siblingRunId);

    let losingReservation: typeof externalRuntimeReservations.$inferSelect | undefined;
    let siblingReservation: typeof externalRuntimeReservations.$inferSelect | undefined;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      [losingReservation, siblingReservation] = await Promise.all([
        db.select().from(externalRuntimeReservations).where(eq(externalRuntimeReservations.runId, losingRunId)).then((rows) => rows[0]),
        db.select().from(externalRuntimeReservations).where(eq(externalRuntimeReservations.runId, siblingRunId)).then((rows) => rows[0]),
      ]);
      if (
        losingReservation?.state === "launching" && losingReservation.expectedJobName === losingJobName &&
        siblingReservation?.state === "launching" && siblingReservation.expectedJobName === siblingJobName
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(losingReservation).toMatchObject({ state: "launching", expectedJobName: losingJobName });
    expect(siblingReservation).toMatchObject({ state: "launching", expectedJobName: siblingJobName });
    expect(losingReservation?.id).not.toBe(siblingReservation?.id);

    // Only the losing run gets reaped and its reservation released; the
    // sibling's reservation is left completely alone.
    await db
      .update(heartbeatRuns)
      .set({ status: "failed", errorCode: "process_lost", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, losingRunId));
    await releaseExternalRuntimeReservation(db, { runId: losingRunId, reason: "process_lost" });

    allowLosingStampToProceed();
    await losingExecution;

    // The sibling's Job identity hasn't landed yet -- its reservation must
    // still be intact and unreleased while the losing run's compensation runs.
    const siblingReservationMidRace = await db
      .select()
      .from(externalRuntimeReservations)
      .where(eq(externalRuntimeReservations.runId, siblingRunId))
      .then((rows) => rows[0]);
    expect(siblingReservationMidRace.releasedAt).toBeNull();
    expect(siblingReservationMidRace.state).toBe("launching");

    allowSiblingStampToProceed();
    await siblingExecution;

    expect(mockDeleteAgentJobExact).toHaveBeenCalledWith({
      runId: losingRunId,
      agentId,
      name: losingJobName,
      uid: "race-lost-uid-sibling",
    });
    expect(mockDeleteAgentJobExact).not.toHaveBeenCalledWith(expect.objectContaining({ runId: siblingRunId }));
    expect(mockDeleteAgentJobExact).not.toHaveBeenCalledWith(expect.objectContaining({ name: siblingJobName }));
    expect(mockDeleteAgentJobExact).not.toHaveBeenCalledWith(expect.objectContaining({ uid: "survivor-uid-sibling" }));

    const losingReservationFinal = await db
      .select()
      .from(externalRuntimeReservations)
      .where(eq(externalRuntimeReservations.runId, losingRunId))
      .then((rows) => rows[0]);
    expect(losingReservationFinal.state).toBe("released");
    expect(losingReservationFinal.jobName).toBeNull();
    expect(losingReservationFinal.jobUid).toBeNull();

    const siblingReservationFinal = await db
      .select()
      .from(externalRuntimeReservations)
      .where(eq(externalRuntimeReservations.runId, siblingRunId))
      .then((rows) => rows[0]);
    // The sibling completed on its own (unrelated to the losing run's race) and
    // is progressing through its own normal launched -> release_pending -> released
    // lifecycle; what matters here is that its Job identity was never disturbed
    // and it was never released/deleted by the losing run's compensation.
    expect(siblingReservationFinal).toMatchObject({
      state: "release_pending",
      jobName: siblingJobName,
      jobUid: "survivor-uid-sibling",
    });
    expect(siblingReservationFinal.releasedAt).toBeNull();

    const siblingRun = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, siblingRunId))
      .then((rows) => rows[0]);
    expect(siblingRun?.status).toBe("succeeded");
  }, 30_000);

  it("compensates by deleting the exact Job when the periodic reconciliation loop loses the create/stamp race", async () => {
    // Ally review on PR #690 (BLO-16269) flagged that both new race tests above
    // drive ctx.onExternalRuntimeLaunched directly, covering only the primary
    // stamp path -- the periodic external-runtime reconciliation loop (the
    // "secondary stamp path" over already-observed live Jobs, heartbeat.ts
    // ~line 11448) had the identical compensating-delete branch but no direct
    // coverage. This exercises that loop by calling reapOrphanedRuns directly
    // with a synthetic managedJobs snapshot (the Job the adapter already
    // created in-cluster) while getActiveExternalRuntimeReservation is
    // intercepted once to release the reservation between the loop's read and
    // its stamp attempt -- reproducing the exact race window without needing
    // real concurrency.
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const jobName = "agent-claude-race-lost-reconcile";
    const jobUid = "reconcile-race-uid";

    await db.insert(companies).values({
      id: companyId,
      name: "External Runtime Reconcile Co",
      issuePrefix: "ERC",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Claude K8s Reconcile",
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
      status: "running",
      startedAt: new Date(),
      contextSnapshot: {},
    });
    // Mirrors the state left behind once onMeta has parsed the expected Job
    // name but before the adapter has reported the launched identity back
    // in-process -- exactly the window createNamespacedJob's success can race
    // against a reap/release from elsewhere.
    await db.insert(externalRuntimeReservations).values({
      companyId,
      agentId,
      runId,
      slotId: 0,
      state: "launching",
      expectedJobName: jobName,
      isolationMode: "run",
      isolationKey: `run:${runId}`,
      isolationBoundAt: new Date(),
      reservedAt: new Date(),
      launchingAt: new Date(),
    });

    mockListManagedAgentJobs.mockResolvedValue([
      {
        phase: "active",
        reason: null,
        message: null,
        runId,
        agentId,
        name: jobName,
        uid: jobUid,
        createdAt: new Date(),
      },
    ]);
    mockGetActiveExternalRuntimeReservation.mockImplementationOnce(async (dbArg, runIdArg) => {
      const reservation = await actualExternalRuntimeReservationsRef.current.getActiveExternalRuntimeReservation(
        dbArg,
        runIdArg,
      );
      // Simulate a concurrent reap tick releasing the reservation in the
      // window between this read and the loop's subsequent stamp attempt.
      await releaseExternalRuntimeReservation(db, { runId: runIdArg, reason: "process_lost" });
      return reservation;
    });

    await heartbeat.reapOrphanedRuns();

    expect(mockDeleteAgentJobExact).toHaveBeenCalledWith({ runId, agentId, name: jobName, uid: jobUid });

    const reservation = await db
      .select()
      .from(externalRuntimeReservations)
      .where(eq(externalRuntimeReservations.runId, runId))
      .then((rows) => rows[0]);
    expect(reservation.state).toBe("released");
    expect(reservation.jobName).toBeNull();
    expect(reservation.jobUid).toBeNull();
  }, 30_000);
});
