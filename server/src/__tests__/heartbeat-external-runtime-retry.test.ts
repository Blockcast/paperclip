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
import { logger } from "../middleware/logger.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { cleanupHeartbeatTestState } from "./helpers/cleanup-heartbeat-test-state.js";
import {
  bindExternalRuntimeReservationIsolation,
  claimRunWithExternalRuntimeSlot,
  ExternalRuntimeIsolationConflictError,
  ExternalRuntimeJobNameMismatchError,
  markExternalRuntimeReservationLaunching,
  recordExpectedExternalRuntimeJobName,
  recordExternalRuntimeJobIdentity,
  releaseExternalRuntimeReservation,
} from "../services/external-runtime-reservations.js";
import { refreshExternalRuntimeReservationStrandMetrics } from "../services/external-runtime-reservation-strand-metrics.js";
import { renderMetrics } from "../services/metrics.js";

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

  /**
   * Read a single sample out of the rendered exposition rather than reaching
   * into prom-client internals. This is deliberately the same surface
   * Prometheus scrapes, so a gauge that is registered but never exported --
   * the failure mode that would make the alert permanently silent -- fails
   * these tests instead of passing them.
   */
  async function readStrandedGaugeForAgent(agentId: string): Promise<number | null> {
    const { body } = await renderMetrics();
    const line = body
      .split("\n")
      .find((row) =>
        row.startsWith("paperclip_external_runtime_reservation_stranded_oldest_age_seconds{")
        && row.includes(`agent_id="${agentId}"`));
    if (!line) return null;
    const value = Number(line.trim().split(/\s+/).at(-1));
    return Number.isFinite(value) ? value : null;
  }

  async function readStrandRefreshSuccess(): Promise<number | null> {
    const { body } = await renderMetrics();
    const line = body
      .split("\n")
      .find((row) =>
        row.startsWith("paperclip_external_runtime_reservation_strand_metrics_refresh_success "));
    if (!line) return null;
    const value = Number(line.trim().split(/\s+/).at(-1));
    return Number.isFinite(value) ? value : null;
  }

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
    // BLO-21116 (Ally review, onprem-k8s#2013): deferring a running contender
    // back to queued must reset its queued-age clock to the defer instant, not
    // leave the age gauge reading this row's original (pre-run) createdAt.
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

  /**
   * BLO-20482: the cancel cascade calls deleteExactExternalRuntimeJob for every
   * external-lifecycle run, and reaches it with NO active reservation by design
   * (the dispatcher may already have released a terminal run's reservation).
   * That benign path used to log at error ~13x/26min, all with
   * reservationId: null, poisoning the API error rate. Downgrading it must not
   * also silence the genuinely anomalous case, so both directions are pinned.
   */
  async function seedCancellableExternalRun(input: {
    reservation: "none" | "identity_missing";
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const reservationId = randomUUID();
    const issuePrefix = `D${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "DeletionRefusalCo",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "DeletionRefusalAgent",
      role: "engineer",
      status: "running",
      // hasExternalLifecycle(...) is what arms the cancel cascade.
      adapterType: "claude_k8s",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 5, concurrencyEnabled: true } },
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      // Must be in CANCELLABLE_HEARTBEAT_RUN_STATUSES for cancelRun to proceed.
      status: "running",
      startedAt: new Date(Date.now() - 60 * 1000),
      contextSnapshot: {},
    });

    if (input.reservation === "identity_missing") {
      // Reservation persisted and unreleased, but the Job identity stamp never
      // landed -- a Job may be live that we cannot safely target.
      await db.insert(externalRuntimeReservations).values({
        id: reservationId,
        companyId,
        agentId,
        runId,
        slotId: 1,
        state: "launching",
        expectedJobName: `agent-claude-${runId.slice(0, 8)}`,
        jobName: null,
        jobUid: null,
        reservedAt: new Date(Date.now() - 60 * 1000),
        releasedAt: null,
        isolationMode: "run",
        isolationKey: `run:${runId}`,
        isolationBoundAt: new Date(Date.now() - 60 * 1000),
      });
    }

    return { companyId, agentId, runId, reservationId };
  }

  const REFUSAL_MESSAGE = "refusing external-runtime Job deletion without persisted name and UID";
  const SKIP_MESSAGE = "skipping external-runtime Job deletion: no active reservation to target";

  function callsMatching(spy: ReturnType<typeof vi.spyOn>, needle: string) {
    return spy.mock.calls.filter(
      ([, message]) => typeof message === "string" && message.includes(needle),
    );
  }

  it("cancels a run with no active reservation without logging at error (BLO-20482)", async () => {
    const { runId } = await seedCancellableExternalRun({ reservation: "none" });

    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
    const debugSpy = vi.spyOn(logger, "debug").mockImplementation(() => {});
    let refusals: unknown[][] = [];
    let skipped: unknown[][] = [];
    try {
      await heartbeat.cancelRun(runId, "cancelled by test");
      // Snapshot BEFORE restoring: mockRestore() also resets mock.calls, so
      // reading the spy afterwards silently sees an empty array and every
      // "was not logged" assertion passes vacuously.
      refusals = callsMatching(errorSpy, REFUSAL_MESSAGE);
      skipped = callsMatching(debugSpy, SKIP_MESSAGE);
    } finally {
      errorSpy.mockRestore();
      debugSpy.mockRestore();
    }

    // The load-bearing assertion: this benign path contributes nothing to the
    // error rate.
    expect(refusals).toEqual([]);

    // ...but it is still observable at debug, carrying the null reservationId
    // that identified the condition in production.
    expect(skipped).toHaveLength(1);
    expect(skipped[0][0]).toMatchObject({ runId, reservationId: null });

    // Refusal semantics are unchanged: no delete is attempted, so the caller
    // still treats the result as fail-closed.
    expect(mockDeleteAgentJobExact).not.toHaveBeenCalled();

    const runAfter = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0]);
    expect(runAfter?.status).toBe("cancelled");
  }, 120_000);

  it("still logs at error when a persisted reservation has no Job identity (BLO-20482)", async () => {
    const { runId, reservationId } = await seedCancellableExternalRun({
      reservation: "identity_missing",
    });

    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
    let refusals: unknown[][] = [];
    try {
      await heartbeat.cancelRun(runId, "cancelled by test");
      // Snapshot before restoring -- see the sibling test.
      refusals = callsMatching(errorSpy, REFUSAL_MESSAGE);
    } finally {
      errorSpy.mockRestore();
    }

    // Guards the downgrade from being over-broad: a reservation we persisted
    // but never stamped is a real anomaly and must stay loud.
    expect(refusals).toHaveLength(1);
    expect(refusals[0][0]).toMatchObject({ runId, reservationId });

    expect(mockDeleteAgentJobExact).not.toHaveBeenCalled();
  }, 120_000);

  /**
   * BLO-28865 (parent BLO-27700). An agent whose adapterType changes while it
   * holds an in-flight external-lifecycle run used to strand its reservation
   * forever: `recordExpectedExternalRuntimeJobName` matches a `launched` row by
   * exact `expectedJobName` equality, the new adapter presents a
   * differently-prefixed Job name (`agent-opencode-*` -> `ac-*`), zero rows
   * match, and the throw repeats on EVERY launch. The unreleased row keeps
   * holding the agent's slot via
   * `external_runtime_reservations_active_slot_idx`, so all launches stall.
   * Recovery was incidental, arriving only at the 45-minute hard-stale kill.
   *
   * The fix cancels the in-flight run (routes/agents.ts, on adapter-type
   * change) instead of touching the reservation, which is what makes the
   * old-named Job teardown possible at all -- see the AC#2 assertion below.
   */
  async function seedMigratingAgentWithLaunchedReservation() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const reservationId = randomUUID();
    // Deliberately the PRE-migration prefix: this is the identity the
    // reservation holds and the only handle anything has on the live Job.
    const oldJobName = `agent-opencode-${runId.slice(0, 8)}`;
    const oldJobUid = `uid-opencode-${runId.slice(0, 8)}`;
    const issuePrefix = `M${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "AdapterMigrationCo",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "AdapterMigrationAgent",
      role: "engineer",
      status: "running",
      adapterType: "opencode_k8s",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 5, concurrencyEnabled: true } },
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      // In flight, and in CANCELLABLE_HEARTBEAT_RUN_STATUSES.
      status: "running",
      startedAt: new Date(Date.now() - 5 * 60 * 1000),
      contextSnapshot: {},
    });

    await db.insert(externalRuntimeReservations).values({
      id: reservationId,
      companyId,
      agentId,
      runId,
      slotId: 0,
      state: "launched",
      expectedJobName: oldJobName,
      jobName: oldJobName,
      jobUid: oldJobUid,
      reservedAt: new Date(Date.now() - 5 * 60 * 1000),
      launchedAt: new Date(Date.now() - 5 * 60 * 1000),
      releasedAt: null,
      isolationMode: "run",
      isolationKey: `run:${runId}`,
      isolationBoundAt: new Date(Date.now() - 5 * 60 * 1000),
    });

    return { companyId, agentId, runId, reservationId, oldJobName, oldJobUid };
  }

  it("tears down the old-named Job and frees the slot when an agent's adapter type changes mid-run (BLO-28865)", async () => {
    const { agentId, runId, oldJobName, oldJobUid } =
      await seedMigratingAgentWithLaunchedReservation();

    // The committed half of the PATCH: the agent is now codex_local while its
    // reservation still describes the opencode_k8s Job. This is exactly the
    // divergence that wedged production.
    await db
      .update(agents)
      .set({ adapterType: "codex_local", updatedAt: new Date() })
      .where(eq(agents.id, agentId));

    // What routes/agents.ts now invokes from its adapter-type-change block.
    const cancelled = await heartbeat.cancelExternalRuntimeReservationHoldersForAgent(
      agentId,
      "Cancelled because the agent's adapter type changed from opencode_k8s to codex_local",
    );
    expect(cancelled).toBe(1);

    // AC#2 -- the load-bearing one. The orphaned pre-change Job must be torn
    // down, and it can only be targeted by the OLD name/UID. A fix that
    // re-armed the reservation (nulling jobName/jobUid) would have nothing to
    // pass here, which is precisely why re-arming leaks a live pod that can
    // still burn node CPU and make model calls.
    expect(mockDeleteAgentJobExact).toHaveBeenCalledWith(
      expect.objectContaining({ runId, agentId, name: oldJobName, uid: oldJobUid }),
    );
    // Pinned as a negative too: deleting under the post-migration prefix would
    // silently miss the real Job while looking like a successful teardown.
    expect(mockDeleteAgentJobExact).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: expect.stringMatching(/^ac-/) }),
    );

    const runAfter = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0]);
    expect(runAfter?.status).toBe("cancelled");

    // AC#1 -- one reaper cycle, not the 45-minute hard-stale boundary. The Job
    // is gone because the cascade above deleted it.
    mockReadAgentJobRunStatusByName.mockImplementation(async (name: string) => ({
      phase: "missing" as const,
      reason: "NotFound",
      message: `Kubernetes Job ${name} was not found`,
      name,
    }));
    await heartbeat.reapOrphanedRuns();

    const reservationAfter = await db
      .select()
      .from(externalRuntimeReservations)
      .where(eq(externalRuntimeReservations.runId, runId))
      .then((rows) => rows[0]);
    expect(reservationAfter.releasedAt).not.toBeNull();
    expect(reservationAfter.state).toBe("released");

    // AC#3 -- the agent can launch again. This is the assertion that actually
    // proves the wedge is gone: slot 0 is the one the stranded row held via
    // external_runtime_reservations_active_slot_idx, so a successful claim on
    // that exact slot is only possible once the strand is released.
    const nextRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: nextRunId,
      companyId: reservationAfter.companyId,
      agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "queued",
      contextSnapshot: {},
    });
    const nextClaim = await claimRunWithExternalRuntimeSlot(db, nextRunId, new Date(), 0);
    expect(nextClaim).not.toBeNull();
    expect(nextClaim!.reservation.agentId).toBe(agentId);
  }, 120_000);

  it("leaves a queued run alone -- only reservation holders are cancelled (BLO-28865)", async () => {
    const { companyId, agentId, runId } = await seedMigratingAgentWithLaunchedReservation();

    // A second run that was never dispatched: no reservation, no Job. It would
    // launch perfectly well under the new adapter, so the migration must not
    // kill it. This is the difference between this narrow helper and the
    // pause path's cancelActiveForAgent, which cancels every queued/running/
    // scheduled_retry run for the agent.
    const queuedRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: queuedRunId,
      companyId,
      agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "queued",
      contextSnapshot: {},
    });

    await db
      .update(agents)
      .set({ adapterType: "claude_k8s", updatedAt: new Date() })
      .where(eq(agents.id, agentId));

    const cancelled = await heartbeat.cancelExternalRuntimeReservationHoldersForAgent(
      agentId,
      "Cancelled because the agent's adapter type changed from opencode_k8s to claude_k8s",
    );

    // Exactly one: the reservation holder. Not the queued run.
    expect(cancelled).toBe(1);

    const statuses = await db
      .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    const byId = new Map(statuses.map((row) => [row.id, row.status]));
    expect(byId.get(runId)).toBe("cancelled");
    expect(byId.get(queuedRunId)).not.toBe("cancelled");
  }, 120_000);

  it("names a Job-name mismatch distinctly instead of folding it into the generic non-launchable error (BLO-28865)", async () => {
    const { runId, reservationId, oldJobName } =
      await seedMigratingAgentWithLaunchedReservation();

    // Exactly what the post-migration adapter presents on its next launch.
    const newJobName = `ac-${runId.slice(0, 8)}`;

    let caught: unknown;
    try {
      await recordExpectedExternalRuntimeJobName(db, { runId, jobName: newJobName });
    } catch (error) {
      caught = error;
    }

    // AC#4: the mismatch is *named*, not swallowed into one error string. The
    // distinction matters operationally -- a generic non-launchable
    // reservation means the run lost a race and retrying is the answer, while
    // this means the caller's identity changed underneath an intact
    // reservation and retrying can never clear it.
    expect(caught).toBeInstanceOf(ExternalRuntimeJobNameMismatchError);
    const mismatch = caught as ExternalRuntimeJobNameMismatchError;
    expect(mismatch.code).toBe("external_runtime_job_name_mismatch");
    // Structured fields, not just interpolation: this is what lets the
    // condition be counted and correlated rather than grepped out of prose.
    expect(mismatch.runId).toBe(runId);
    expect(mismatch.reservationId).toBe(reservationId);
    expect(mismatch.expectedJobName).toBe(oldJobName);
    expect(mismatch.receivedJobName).toBe(newJobName);

    // The reservation is untouched by the failed launch -- still holding the
    // old identity, so the teardown path above remains available.
    const reservationAfter = await db
      .select()
      .from(externalRuntimeReservations)
      .where(eq(externalRuntimeReservations.runId, runId))
      .then((rows) => rows[0]);
    expect(reservationAfter.jobName).toBe(oldJobName);
    expect(reservationAfter.releasedAt).toBeNull();
  }, 120_000);

  it("leaves an unchanged-adapter launch path alone (BLO-28865 AC#6)", async () => {
    const { runId, oldJobName } = await seedMigratingAgentWithLaunchedReservation();

    // No adapter-type change: the same Job name arrives that the reservation
    // was launched with. The normal reserved -> launching -> launched ->
    // released lifecycle must be completely unaffected by the mismatch branch
    // added above.
    const reservation = await recordExpectedExternalRuntimeJobName(db, {
      runId,
      jobName: oldJobName,
    });
    expect(reservation).not.toBeNull();
    expect(reservation!.state).toBe("launched");
    expect(reservation!.expectedJobName).toBe(oldJobName);

    const released = await releaseExternalRuntimeReservation(db, {
      runId,
      reason: "test_normal_lifecycle",
    });
    expect(released).not.toBeNull();
    expect(released!.releasedAt).not.toBeNull();
  }, 120_000);
  /**
   * BLO-28865 Defect 2. The alert rule is only as good as this predicate: the
   * whole reason the rule is not a threshold over
   * `paperclip_external_runtime_reservation_oldest_age_seconds` is that the
   * strand-versus-long-run distinction is made HERE, in SQL. Both directions
   * are pinned, because a predicate that only ever counts is exactly as
   * useless as one that never does.
   */
  async function seedReservationForStrandMetrics(input: {
    runStatus: string;
    lastUsefulActionAt: Date | null;
    reservedAt: Date;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const jobName = `agent-claude-strand-${runId.slice(0, 8)}`;
    const issuePrefix = `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "StrandMetricsCo",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "StrandMetricsAgent",
      role: "engineer",
      status: "running",
      adapterType: "claude_k8s",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 5, concurrencyEnabled: true } },
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: input.runStatus,
      startedAt: input.reservedAt,
      lastUsefulActionAt: input.lastUsefulActionAt,
      contextSnapshot: {},
      createdAt: input.reservedAt,
    });
    await db.insert(externalRuntimeReservations).values({
      id: randomUUID(),
      companyId,
      agentId,
      runId,
      slotId: 0,
      state: "launched",
      expectedJobName: jobName,
      jobName,
      jobUid: `uid-${runId.slice(0, 8)}`,
      reservedAt: input.reservedAt,
      launchedAt: input.reservedAt,
      releasedAt: null,
      isolationMode: "run",
      isolationKey: `run:${runId}`,
      isolationBoundAt: input.reservedAt,
    });
    return { agentId, runId };
  }

  it("counts a terminal run's unreleased reservation as stranded (BLO-28865 AC#5)", async () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
    const { agentId } = await seedReservationForStrandMetrics({
      runStatus: "cancelled",
      lastUsefulActionAt: threeHoursAgo,
      reservedAt: threeHoursAgo,
    });

    await refreshExternalRuntimeReservationStrandMetrics(db);

    const value = await readStrandedGaugeForAgent(agentId);
    // The run is over; the reservation outliving it is the definition of a
    // strand, regardless of how recently the run was noisy.
    expect(value).toBeGreaterThan(0);
    expect(await readStrandRefreshSuccess()).toBe(1);
  }, 120_000);

  it("counts a silent non-terminal run's reservation as stranded (BLO-28865 AC#5)", async () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
    const { agentId } = await seedReservationForStrandMetrics({
      runStatus: "running",
      // Silent well past EXTERNAL_LIFECYCLE_HARD_STALE_MS -- the pre-fix wedge
      // shape: the run still looks alive, but nothing is coming out of it and
      // the row is holding the agent's only slot.
      lastUsefulActionAt: threeHoursAgo,
      reservedAt: threeHoursAgo,
    });

    await refreshExternalRuntimeReservationStrandMetrics(db);

    expect(await readStrandedGaugeForAgent(agentId)).toBeGreaterThan(0);
  }, 120_000);

  it("counts an interrupted run's recently active reservation as stranded (BLO-28865 AC#5)", async () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
    const { agentId } = await seedReservationForStrandMetrics({
      runStatus: "interrupted",
      // Recent liveness is intentional: the terminal-status branch must win
      // without waiting for the silence cutoff.
      lastUsefulActionAt: new Date(Date.now() - 30 * 1000),
      reservedAt: threeHoursAgo,
    });

    await refreshExternalRuntimeReservationStrandMetrics(db);

    expect(await readStrandedGaugeForAgent(agentId)).toBeGreaterThan(0);
  }, 120_000);

  it("does NOT count a legitimately long-running, still-active run (BLO-28865 AC#5)", async () => {
    const { agentId } = await seedReservationForStrandMetrics({
      runStatus: "running",
      // Nine hours old -- longer than any threshold a naive rule over the raw
      // age gauge could pick, and the actual measured 7d maximum on healthy
      // replicas. But it emitted a useful action seconds ago, so it is
      // working, not wedged.
      reservedAt: new Date(Date.now() - 9 * 60 * 60 * 1000),
      lastUsefulActionAt: new Date(Date.now() - 30 * 1000),
    });

    await refreshExternalRuntimeReservationStrandMetrics(db);

    // This is AC#5's load-bearing half. A rule over
    // paperclip_external_runtime_reservation_oldest_age_seconds would read
    // 9 hours here and page. This gauge reads 0 -- the agent appears because
    // every known agent is published (an absent series and "nothing stuck"
    // render identically), but with no age.
    expect(await readStrandedGaugeForAgent(agentId)).toBe(0);
  }, 120_000);

  it("does NOT count a reservation that has already been released (BLO-28865 AC#5)", async () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
    const { agentId, runId } = await seedReservationForStrandMetrics({
      runStatus: "cancelled",
      lastUsefulActionAt: threeHoursAgo,
      reservedAt: threeHoursAgo,
    });
    await releaseExternalRuntimeReservation(db, { runId, reason: "test_released" });

    await refreshExternalRuntimeReservationStrandMetrics(db);

    // The reset-then-set contract: once the slot is reclaimed the agent must
    // read an explicit 0, or the alert would stay open forever after a
    // successful recovery.
    expect(await readStrandedGaugeForAgent(agentId)).toBe(0);
  }, 120_000);
});
