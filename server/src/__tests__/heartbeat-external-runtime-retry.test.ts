import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  createDb,
  executionWorkspaces,
  externalRuntimeReservations,
  heartbeatRuns,
  issues,
  projects,
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
  ExternalRuntimeIsolationConflictError,
  markExternalRuntimeReservationLaunching,
  recordExpectedExternalRuntimeJobName,
  recordExternalRuntimeJobIdentity,
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
  }, 120_000);

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
  }, 120_000);

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
      defaultResponsibleUserId: "responsible-user",
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
    let markReplacementLaunchStarted!: () => void;
    const replacementLaunchStarted = new Promise<void>((resolve) => {
      markReplacementLaunchStarted = resolve;
    });
    mockAdapterExecute.mockImplementation(async (ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> => {
      const attempt = mockAdapterExecute.mock.calls.length;
      if (attempt === 2) {
        markReplacementLaunchStarted();
        await replacementLaunchGate;
      }
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
    // Wait for attempt 2 to enter the explicit gate. This proves the retry
    // reservation has been re-armed and prevents scheduler/ARC timing from
    // deciding whether the reaper samples attempt 1 or the replacement.
    await replacementLaunchStarted;
    const retryReservation = await db
      .select()
      .from(externalRuntimeReservations)
      .where(eq(externalRuntimeReservations.runId, runId))
      .then((rows) => rows[0]);
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
  }, 120_000);

  it("defers a workspace-scope contender without failing or invoking its adapter", async () => {
    // BLO-16842 repurposed this case. Pre-fix, a concurrency-enabled k8s agent's
    // plain coding runs all shared the single `agent-shared:<agentId>` writer key,
    // so a second admitted slot collided and deferred. Post-fix, each such run
    // resolves to its own `run:<runId>` key, so that shared-key collision is
    // unreachable by design. The isolation-conflict deferral + retry + resume flow
    // is STILL live, however, whenever two runs resolve to the same NON-run key --
    // realistically the same `workspace:<id>` (two runs reusing one persisted
    // execution workspace). This test drives that workspace-key collision: the
    // owner reservation is manually pinned to `workspace:<SHARED_WORKSPACE_ID>`,
    // and the contender -- a plain (non-PR) run whose issue reuses that same
    // persisted execution workspace -- resolves (via resolveK8sRunIsolationIdentity)
    // to the identical key, so it defers on the active-isolation-writer lock.
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    const sharedWorkspaceId = randomUUID();
    const contenderIssueId = randomUUID();
    const ownerRunId = randomUUID();
    const contenderRunId = randomUUID();
    const sharedWorkspaceCwd = await fs.mkdtemp(path.join(os.tmpdir(), "blo-16842-workspace-"));

    await db.insert(companies).values({
      id: companyId,
      name: "External Runtime Isolation Co",
      issuePrefix: "ERI",
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
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
          // BLO-16842: the workspace-key deferral path is only reachable once a
          // second run is admitted, so the agent must opt into concurrency (with
          // effective concurrency > 1 the fix keeps `workspace:<id>` for
          // workspace-isolated runs but hands plain runs a per-run key).
          concurrencyEnabled: true,
        },
      },
      permissions: {},
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Shared Workspace Project",
    });
    // One persisted execution workspace that both the owner reservation and the
    // contender run resolve to. `mode: "isolated_workspace"` makes the contender's
    // run workspace-isolated (so resolveK8sRunIsolationIdentity returns
    // `workspace:<sharedWorkspaceId>`); `strategyType: "project_primary"` keeps
    // reuse a pure metadata operation -- ensurePersistedExecutionWorkspaceAvailable
    // returns the realized workspace from this row without any git/worktree disk
    // I/O -- so the contender can run to completion on resume without a real repo.
    await db.insert(executionWorkspaces).values({
      id: sharedWorkspaceId,
      companyId,
      projectId,
      mode: "isolated_workspace",
      strategyType: "project_primary",
      name: "Shared execution workspace",
      status: "active",
      cwd: sharedWorkspaceCwd,
    });
    // The contender's issue reuses the shared execution workspace
    // (executionWorkspacePreference: "reuse_existing"), which is what makes
    // executeRun's plannedExecutionWorkspaceId equal sharedWorkspaceId (rather than
    // a fresh random id) so the resolved writer key collides with the owner's.
    // assigneeAgentId must be this agent (else the queued run is cancelled as
    // "issue_assignee_changed" before it can reach the isolation bind); projectId
    // stays null so workspace resolution uses the agent-home fallback rather than
    // realizing a managed project workspace.
    await db.insert(issues).values({
      id: contenderIssueId,
      companyId,
      title: "Reuse the shared execution workspace",
      identifier: "ERI-1",
      status: "in_progress",
      assigneeAgentId: agentId,
      executionWorkspaceId: sharedWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
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
        contextSnapshot: { issueId: contenderIssueId },
      },
    ]);

    const ownerClaim = await claimRunWithExternalRuntimeSlot(db, ownerRunId, new Date(), 0);
    expect(ownerClaim).not.toBeNull();
    await bindExternalRuntimeReservationIsolation(db, {
      runId: ownerRunId,
      reservationId: ownerClaim!.reservation.id,
      isolationMode: "workspace",
      isolationKey: `workspace:${sharedWorkspaceId}`,
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
    expect(contender.queuedAt).not.toBeNull();
    expect(contender.queuedAt!.getTime()).toBeGreaterThanOrEqual(contender.createdAt.getTime());
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
    // The contender resumed and ran to completion once the owner freed the
    // workspace writer key. Unlike the old issue-less setup, this run is linked to
    // an issue, so its successful completion promotes the issue and dispatches a
    // follow-up continuation run (a DISTINCT runId) -- expected issue behaviour,
    // not a deferral property -- so we assert the adapter fired rather than pin an
    // exact global count. The load-bearing proof is that the contender's OWN run
    // succeeded on a fresh reservation bound to the same workspace key it had
    // deferred on.
    expect(mockAdapterExecute).toHaveBeenCalled();
    expect(completedContender.status).toBe("succeeded");
    expect(reusedReservation.id).not.toBe(contenderReservation?.id);
    expect(reusedReservation.isolationMode).toBe("workspace");
    expect(reusedReservation.isolationKey).toBe(`workspace:${sharedWorkspaceId}`);
  }, 120_000);

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
      defaultResponsibleUserId: "responsible-user",
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
    let markMetaRecorded!: () => void;
    const metaRecorded = new Promise<void>((resolve) => { markMetaRecorded = resolve; });
    mockAdapterExecute.mockImplementation(async (ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> => {
      await ctx.onMeta?.({ adapterType: "claude_k8s", command: `kubectl job/${jobName}` });
      markMetaRecorded();
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
    await metaRecorded;
    const reservationBeforeReap = await db
      .select()
      .from(externalRuntimeReservations)
      .where(eq(externalRuntimeReservations.runId, runId))
      .then((rows) => rows[0]);
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
  }, 120_000);

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
      defaultResponsibleUserId: "responsible-user",
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
          // This case requires two independent run-isolated reservations.
          concurrencyEnabled: true,
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
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
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
  }, 120_000);

  it("gives two concurrent non-PR coding runs independent run-isolated reservations", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runIdA = randomUUID();
    const runIdB = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "External Runtime Concurrency Co",
      issuePrefix: "ERC",
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Opencode K8s Concurrent",
      role: "engineer",
      status: "active",
      adapterType: "opencode_k8s",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          enabled: true,
          wakeOnDemand: true,
          maxConcurrentRuns: 2,
          concurrencyEnabled: true,
        },
      },
      permissions: {},
    });
    // Plain assignment runs -- NO pr_review context -- so isolation must come
    // from the concurrency branch, not the stateless-PR-review branch.
    await db.insert(heartbeatRuns).values([
      {
        id: runIdA,
        companyId,
        agentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "queued",
        contextSnapshot: { wakeReason: "assignment" },
      },
      {
        id: runIdB,
        companyId,
        agentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "queued",
        contextSnapshot: { wakeReason: "assignment" },
      },
    ]);

    mockAdapterExecute.mockImplementation(
      async (ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> => {
        const jobName = `agent-opencode-${ctx.runId.slice(0, 8)}`;
        await ctx.onMeta?.({ adapterType: "opencode_k8s", command: `kubectl job/${jobName}` });
        await ctx.onExternalRuntimeLaunched?.({
          jobName,
          jobUid: `uid-${ctx.runId.slice(0, 8)}`,
        });
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          errorMessage: null,
          summary: "coding run launched",
          resultJson: { ok: true },
          usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 },
          provider: "test",
          model: "test-model",
        };
      },
    );

    await Promise.all([
      heartbeat.__test_executeRunForTesting(runIdA),
      heartbeat.__test_executeRunForTesting(runIdB),
    ]);

    const [reservationA, reservationB] = await Promise.all([
      db.select().from(externalRuntimeReservations)
        .where(eq(externalRuntimeReservations.runId, runIdA)).then((rows) => rows[0]),
      db.select().from(externalRuntimeReservations)
        .where(eq(externalRuntimeReservations.runId, runIdB)).then((rows) => rows[0]),
    ]);

    expect(reservationA?.isolationMode).toBe("run");
    expect(reservationB?.isolationMode).toBe("run");
    expect(reservationA?.isolationKey).toBe(`run:${runIdA}`);
    expect(reservationB?.isolationKey).toBe(`run:${runIdB}`);
    expect(reservationA?.isolationKey).not.toBe(reservationB?.isolationKey);
    // The whole point of BLO-16842: neither sibling serialized on the shared
    // writer lock, i.e. neither reservation was deferred for an isolation
    // conflict. Distinct run:<id> keys make that impossible; assert it directly.
    expect(reservationA?.releaseReason).not.toBe("external_runtime_isolation_conflict");
    expect(reservationB?.releaseReason).not.toBe("external_runtime_isolation_conflict");
  }, 120_000);

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
      defaultResponsibleUserId: "responsible-user",
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
  }, 120_000);

  // BLO-18995: `drainRunningRunsForShutdown` marks in-flight runs `interrupted`
  // on SIGTERM but never releases their runtime slot reservation. The row keeps
  // `released_at IS NULL`, and the partial unique index
  // `external_runtime_reservations_active_slot_idx (agent_id, slot_id) WHERE
  // released_at IS NULL` then blocks that slot permanently — so every worker
  // restart with a run in flight ratchets the agent's effective concurrency
  // down by one, silently and cumulatively. Found in production with four
  // agents each holding a dead slot for 1-5 days (Ally 4/5 slots, Release
  // Engineer 1/2).
  //
  // The reconcile sweeper could not see these rows: its WHERE matched only
  // `release_pending`, or `reserved`/`launching` with a NULL job name. A
  // shutdown-interrupted reservation is `launched` WITH a job name.
  async function seedLaunchedReservationForTerminalRun(input: {
    runStatus: "interrupted" | "failed" | "cancelled";
    slotId?: number;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const jobName = `agent-claude-shutdown-leak-${runId.slice(0, 8)}`;
    const jobUid = `uid-${runId.slice(0, 8)}`;
    const issuePrefix = `L${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "ShutdownSlotLeakCo",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "ShutdownSlotLeakAgent",
      role: "engineer",
      status: "idle",
      adapterType: "claude_k8s",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 5, concurrencyEnabled: true } },
      permissions: {},
    });

    const finishedAt = new Date(Date.now() - 60 * 60 * 1000);
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: input.runStatus,
      startedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      finishedAt,
      error: "Interrupted by graceful server shutdown (SIGTERM); retry queued for restart recovery",
      errorCode: "server_shutdown_interrupted",
      contextSnapshot: {},
      createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      updatedAt: finishedAt,
    });

    // Exactly the shape SIGTERM leaves behind: launched, identified, unreleased.
    await db.insert(externalRuntimeReservations).values({
      id: randomUUID(),
      companyId,
      agentId,
      runId,
      slotId: input.slotId ?? 1,
      state: "launched",
      expectedJobName: jobName,
      jobName,
      jobUid,
      reservedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      launchedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      releasedAt: null,
      // external_runtime_reservations_isolation_binding_check requires all three
      // isolation columns to be set together, or all three NULL.
      isolationMode: "run",
      isolationKey: `run:${runId}`,
      isolationBoundAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
    });

    return { companyId, agentId, runId, jobName, jobUid };
  }

  it("releases a launched reservation left behind by a shutdown-interrupted run once its Job is gone (BLO-18995)", async () => {
    const { runId, jobName, jobUid } = await seedLaunchedReservationForTerminalRun({
      runStatus: "interrupted",
    });

    // The Job is genuinely gone (the k8s NotFound path returns phase "missing").
    mockReadAgentJobRunStatusByName.mockImplementation(async (name: string) => ({
      phase: "missing" as const,
      reason: "NotFound",
      message: `Kubernetes Job ${name} was not found`,
      name,
    }));

    await heartbeat.reapOrphanedRuns();

    const reservation = await db
      .select()
      .from(externalRuntimeReservations)
      .where(eq(externalRuntimeReservations.runId, runId))
      .then((rows) => rows[0]);

    // REGRESSION GUARD: the slot must be reclaimed, not held forever.
    expect(reservation.releasedAt).not.toBeNull();
    expect(reservation.state).toBe("released");
    expect(reservation.releaseReason).toBe("job_terminal_or_missing");
    expect(mockReadAgentJobRunStatusByName).toHaveBeenCalledWith(jobName);
    expect(jobUid).toBeTruthy();
  }, 120_000);

  it("keeps the slot reserved while a shutdown-interrupted run's Job is still active (BLO-18995)", async () => {
    // The other half of the fix: widening the sweeper's WHERE must not release
    // a slot whose Job outlived the worker, or the agent would over-allocate
    // and two Jobs could share one slot. Selection is not release — the
    // per-row Job-phase check still has to gate it.
    const { runId } = await seedLaunchedReservationForTerminalRun({
      runStatus: "interrupted",
      slotId: 2,
    });

    mockReadAgentJobRunStatusByName.mockImplementation(async (name: string) => ({
      phase: "active" as const,
      reason: null,
      message: null,
      name,
    }));

    await heartbeat.reapOrphanedRuns();

    const reservation = await db
      .select()
      .from(externalRuntimeReservations)
      .where(eq(externalRuntimeReservations.runId, runId))
      .then((rows) => rows[0]);

    expect(reservation.releasedAt).toBeNull();
    expect(reservation.state).toBe("launched");
  }, 120_000);

  // BLO-21256: audit of whether ExternalRuntimeIsolationConflictError -- the
  // sole trigger for deferRunForK8sIsolationConflict() (heartbeat.ts's outer
  // catch reacts only to that type) -- can be raised for a run after its own
  // Job has already been created. It cannot, by construction:
  // bindExternalRuntimeReservationIsolation only reaches the
  // legacyWriter-check/UPDATE code that can throw the conflict error while the
  // reservation's isolationMode is still the "pending"/"legacy" placeholder
  // (the `replaceableBinding` gate). Once a real isolationMode/isolationKey is
  // bound -- which happens strictly before Job identity is ever stamped, since
  // markExternalRuntimeReservationLaunching/recordExpectedExternalRuntimeJobName/
  // recordExternalRuntimeJobIdentity all require state to have already left
  // "reserved" via a successful (non-throwing) bind -- any further bind
  // attempt on that same reservation either no-ops (exact key match) or throws
  // a plain drift Error, never ExternalRuntimeIsolationConflictError. This
  // test pins both halves: the conflict mechanism is real (a still-pending
  // contender loses to an active writer), and it is categorically unreachable
  // once the run's own Job has been created. If a future refactor weakens the
  // `replaceableBinding` gate (e.g. moves isolation binding to after Job
  // creation, or lets an already-bound reservation re-enter the throw path),
  // this test fails.
  it("cannot raise ExternalRuntimeIsolationConflictError for a run whose Job has already been created (BLO-21256)", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const jobHolderRunId = randomUUID();
    const contenderRunId = randomUUID();
    const sharedIsolationKey = `workspace:${randomUUID()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "External Runtime Post-Launch Conflict Co",
      issuePrefix: "EPL",
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Claude K8s Post-Launch",
      role: "engineer",
      status: "active",
      adapterType: "claude_k8s",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: { enabled: true, wakeOnDemand: true, maxConcurrentRuns: 2, concurrencyEnabled: true },
      },
      permissions: {},
    });
    await db.insert(heartbeatRuns).values([
      {
        id: jobHolderRunId,
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

    // Take the job-holder run all the way through the real production
    // sequence: claim -> bind -> launching -> expected name -> Job identity
    // stamped. This is "createNamespacedJob has already been issued" for it.
    const jobHolderClaim = await claimRunWithExternalRuntimeSlot(db, jobHolderRunId, new Date(), 0);
    expect(jobHolderClaim).not.toBeNull();
    await bindExternalRuntimeReservationIsolation(db, {
      runId: jobHolderRunId,
      reservationId: jobHolderClaim!.reservation.id,
      isolationMode: "workspace",
      isolationKey: sharedIsolationKey,
    });
    const launching = await markExternalRuntimeReservationLaunching(db, jobHolderRunId);
    expect(launching).not.toBeNull();
    await recordExpectedExternalRuntimeJobName(db, {
      runId: jobHolderRunId,
      jobName: "already-created-job",
      reservationId: launching!.id,
      slotId: launching!.slotId,
    });
    const launched = await recordExternalRuntimeJobIdentity(db, {
      runId: jobHolderRunId,
      reservationId: launching!.id,
      slotId: launching!.slotId,
      jobName: "already-created-job",
      jobUid: "already-created-job-uid",
    });
    expect(launched).toMatchObject({ state: "launched", jobName: "already-created-job" });

    // Control case: the conflict mechanism is real. A second, still-pending
    // reservation contending for the SAME key against the now-active writer
    // above throws ExternalRuntimeIsolationConflictError, as designed.
    const contenderClaim = await claimRunWithExternalRuntimeSlot(db, contenderRunId, new Date(), 1);
    expect(contenderClaim).not.toBeNull();
    let contenderError: unknown;
    try {
      await bindExternalRuntimeReservationIsolation(db, {
        runId: contenderRunId,
        reservationId: contenderClaim!.reservation.id,
        isolationMode: "workspace",
        isolationKey: sharedIsolationKey,
      });
    } catch (err) {
      contenderError = err;
    }
    expect(contenderError).toBeInstanceOf(ExternalRuntimeIsolationConflictError);
    expect((contenderError as InstanceType<typeof ExternalRuntimeIsolationConflictError>).conflictingRunId).toBe(
      jobHolderRunId,
    );

    // The load-bearing assertion: re-binding the JOB-HOLDER's own reservation
    // to a different key (e.g. a resumed/duplicate dispatch pass recomputing
    // isolation identity) must NEVER raise ExternalRuntimeIsolationConflictError.
    // If it did, deferRunForK8sIsolationConflict() would push this run back to
    // queued/started_at:null with external_run_id nulled while the Job stamped
    // above keeps running -- exactly the stranding this issue audited for.
    let rebindError: unknown;
    try {
      await bindExternalRuntimeReservationIsolation(db, {
        runId: jobHolderRunId,
        reservationId: launching!.id,
        isolationMode: "run",
        isolationKey: `run:${jobHolderRunId}`,
      });
    } catch (err) {
      rebindError = err;
    }
    expect(rebindError).not.toBeInstanceOf(ExternalRuntimeIsolationConflictError);
    expect(rebindError).toBeInstanceOf(Error);
    expect((rebindError as Error).message).toMatch(/isolation binding drift/);

    // And the reservation/run backing the live Job were left untouched by the
    // rejected re-bind attempt -- no stranding.
    const jobHolderReservationAfter = await db
      .select()
      .from(externalRuntimeReservations)
      .where(eq(externalRuntimeReservations.runId, jobHolderRunId))
      .then((rows) => rows[0]);
    expect(jobHolderReservationAfter).toMatchObject({
      state: "launched",
      isolationMode: "workspace",
      isolationKey: sharedIsolationKey,
      jobName: "already-created-job",
      jobUid: "already-created-job-uid",
      releasedAt: null,
    });
    const jobHolderRunAfter = await db
      .select({
        status: heartbeatRuns.status,
        startedAt: heartbeatRuns.startedAt,
        externalRunId: heartbeatRuns.externalRunId,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, jobHolderRunId))
      .then((rows) => rows[0]);
    expect(jobHolderRunAfter?.status).toBe("running");
    expect(jobHolderRunAfter?.startedAt).not.toBeNull();
  }, 120_000);
});
