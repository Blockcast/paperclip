import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, asc, eq, or, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  PROCESS_LOST_LIVENESS_NULL_METRIC,
  PROCESS_LOST_TOTAL_METRIC,
  __resetMetricsForTest,
  renderMetrics,
} from "../services/metrics.js";
import {
  activityLog,
  agents,
  agentTaskSessions,
  agentWakeupRequests,
  budgetPolicies,
  companySecretBindings,
  companySecrets,
  companySkills,
  companies,
  costEvents,
  documentAnnotationAnchorSnapshots,
  documentAnnotationComments,
  documentAnnotationThreads,
  createDb,
  documentRevisions,
  documents,
  environmentLeases,
  environments,
  executionWorkspaces,
  externalRuntimeReservations,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issueLabels,
  issuePlanDecompositions,
  issueRecoveryActions,
  issueRelations,
  issueThreadInteractions,
  issueTreeHoldMembers,
  issueTreeHolds,
  issueWorkProducts,
  issues,
  labels,
  projects,
  projectWorkspaces,
  workspaceOperations,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { runningProcesses } from "../adapters/index.js";
import { cleanupHeartbeatTestState } from "./helpers/cleanup-heartbeat-test-state.js";
const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
const mockTrackAgentFirstHeartbeat = vi.hoisted(() => vi.fn());
const mockTerminateLocalService = vi.hoisted(() => vi.fn());
const mockGithubHasReviewerEvidenceForPr = vi.hoisted(() => vi.fn());
const mockAdapterExecute = vi.hoisted(() =>
  vi.fn<
    (ctx: {
      runId: string;
      externalRuntime?: {
        reservationId: string;
        slotId: number;
        jobName?: string | null;
        jobUid?: string | null;
      };
      onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
    }) => Promise<{
      exitCode: number;
      signal: string | null;
      timedOut: boolean;
      errorCode?: string;
      errorFamily?: string;
      errorMessage: string | null;
      summary?: string;
      provider: string;
      model: string;
      resultJson?: Record<string, unknown>;
    }>
  >(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Recovered stranded heartbeat work.",
    resultJson: { summary: "Recovered stranded heartbeat work." },
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => mockTelemetryClient,
}));

vi.mock("../services/github-app-auth.ts", async () => {
  const actual = await vi.importActual<typeof import("../services/github-app-auth.ts")>(
    "../services/github-app-auth.ts",
  );
  return {
    ...actual,
    githubHasReviewerEvidenceForPr: mockGithubHasReviewerEvidenceForPr,
  };
});

const mockListLiveAgentJobRunIds = vi.hoisted(() =>
  vi.fn<() => Promise<Set<string> | null>>(async () => null),
);
const mockDeleteAgentJobsForRun = vi.hoisted(() =>
  vi.fn<(identity: { runId: string; agentId: string; name: string; uid: string }) => Promise<"deleted" | "missing" | "mismatch" | null>>(
    async () => "deleted",
  ),
);
const mockDeleteAgentJobsByRunId = vi.hoisted(() =>
  vi.fn<(runId: string) => Promise<number | null>>(async () => 1),
);
const mockListManagedAgentJobs = vi.hoisted(() =>
  vi.fn<() => Promise<Array<{
    phase: "active" | "succeeded" | "failed";
    reason: string | null;
    message: string | null;
    runId: string | null;
    agentId: string | null;
    name: string;
    uid: string;
    createdAt: Date | null;
  }> | null>>(async () => null),
);
const mockHasActiveJobForAgent = vi.hoisted(() =>
  vi.fn<(agentId: string) => Promise<boolean>>(async () => false),
);
const mockListAgentJobRunStatuses = vi.hoisted(() =>
  vi.fn<
    () => Promise<
      Map<
        string,
        {
          phase: "active" | "succeeded" | "failed";
          reason?: string | null;
          message?: string | null;
          name?: string | null;
          uid?: string | null;
        }
      > | null
    >
  >(async () => null),
);
const mockReadAgentJobRunStatusByName = vi.hoisted(() =>
  vi.fn<
    (name: string) => Promise<
      | {
          phase: "active" | "succeeded" | "failed";
          reason?: string | null;
          message?: string | null;
          name?: string | null;
          uid?: string | null;
        }
      | {
          phase: "missing";
          reason: "NotFound";
          message?: string | null;
          name: string;
        }
      | null
    >
  >(async () => null),
);
const mockListManagedAgentPods = vi.hoisted(() =>
  vi.fn<() => Promise<Array<Record<string, unknown>> | null>>(async () => null),
);
const mockDeleteAgentPodExact = vi.hoisted(() =>
  vi.fn<(identity: { name: string; uid: string; runId: string; agentId: string }) =>
    Promise<"deleted" | "missing" | "mismatch" | null>>(async () => "deleted"),
);
vi.mock("../services/k8s-job-liveness.ts", () => ({
  listLiveAgentJobRunIds: mockListLiveAgentJobRunIds,
  listAgentJobRunStatuses: mockListAgentJobRunStatuses,
  listManagedAgentJobs: mockListManagedAgentJobs,
  listManagedAgentPods: mockListManagedAgentPods,
  deleteAgentPodExact: mockDeleteAgentPodExact,
  indexUniqueAgentJobRunStatuses: (jobs: Array<{
    runId: string | null;
    name: string;
    uid: string;
  }>) => {
    const grouped = new Map<string, typeof jobs>();
    for (const job of jobs) {
      if (!job.runId) continue;
      grouped.set(job.runId, [...(grouped.get(job.runId) ?? []), job]);
    }
    return new Map(
      [...grouped.entries()]
        .filter(([, candidates]) => candidates.length === 1)
        .map(([runId, candidates]) => [runId, candidates[0]]),
    );
  },
  matchExactAgentJob: (jobs: Array<{
    runId: string | null;
    agentId: string | null;
    name: string;
    uid: string;
  }>, identity: { runId: string; agentId: string; name: string; uid: string }) => {
    const candidates = jobs.filter((job) => job.runId === identity.runId);
    const exact = candidates.filter((job) =>
      job.agentId === identity.agentId && job.name === identity.name && job.uid === identity.uid
    );
    if (candidates.length === 1 && exact.length === 1) return { kind: "exact", job: exact[0] };
    if (candidates.length === 0) return { kind: "missing" };
    return { kind: "ambiguous", jobs: candidates };
  },
  readAgentJobRunStatusByName: mockReadAgentJobRunStatusByName,
  deleteAgentJobExact: mockDeleteAgentJobsForRun,
  deleteAgentJobsForRun: mockDeleteAgentJobsByRunId,
  hasActiveJobForAgent: mockHasActiveJobForAgent,
}));
vi.mock("../services/local-service-supervisor.js", async () => {
  const actual = await vi.importActual<typeof import("../services/local-service-supervisor.js")>(
    "../services/local-service-supervisor.js",
  );
  mockTerminateLocalService.mockImplementation(actual.terminateLocalService);
  return {
    ...actual,
    terminateLocalService: mockTerminateLocalService,
  };
});

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return {
    ...actual,
    trackAgentFirstHeartbeat: mockTrackAgentFirstHeartbeat,
  };
});

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

import {
  INTERACTION_CONTINUATION_INFRA_RETRY_REASON,
  INTERACTION_CONTINUATION_INFRA_WAKE_REASON,
  heartbeatService,
  redactDetectedSuccessfulRunProgressSummaryForBoard,
} from "../services/heartbeat.ts";
import { setPluginEventBus, setPluginEventOutboxDb } from "../services/activity-log.js";
import { pollOnce as drainPluginEventOutbox } from "../services/plugin-event-outbox.js";
import {
  readHotRestartIntent,
  resolveHotRestartReportPath,
  writeHotRestartIntent,
} from "../services/hot-restart.ts";
import { secretService } from "../services/secrets.ts";
import {
  STRANDED_RECOVERY_MAX_OWNER_WAKE_ATTEMPTS,
  SUCCESSFUL_RUN_HANDOFF_EXHAUSTED_NOTICE_BODY,
  SUCCESSFUL_RUN_HANDOFF_REQUIRED_NOTICE_BODY,
  SUCCESSFUL_RUN_MISSING_STATE_REASON,
} from "../services/recovery/index.ts";
import type { PluginEventBus, ScopedPluginEventBus } from "../services/plugin-event-bus.js";
import type { PluginEvent } from "@paperclipai/plugin-sdk";
import {
  UNMANAGED_BACKGROUND_TASK_LIVENESS_REASON,
  UNMANAGED_BACKGROUND_TASK_STOP_REASON,
} from "@paperclipai/adapter-utils/server-utils";
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const allowPenstockGate = {
  checkAdapter: async () => ({ allow: true as const }),
  _resetForTesting: () => {},
};

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat recovery tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function spawnAliveProcess() {
  return spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
}

function isPidAlive(pid: number | null | undefined) {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPidExit(pid: number, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !isPidAlive(pid);
}

async function waitForRunToSettle(
  heartbeat: ReturnType<typeof heartbeatService>,
  runId: string,
  timeoutMs = 10_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await heartbeat.getRun(runId);
    if (!run || (run.status !== "queued" && run.status !== "running")) {
      await heartbeat.drainInFlightExecutions(timeoutMs);
      return run;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return heartbeat.getRun(runId);
}

async function waitForValue<T>(
  read: () => Promise<T | null | undefined>,
  timeoutMs = 3_000,
) {
  const deadline = Date.now() + timeoutMs;
  let latest: T | null | undefined = null;
  while (Date.now() < deadline) {
    latest = await read();
    if (latest) return latest;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return latest ?? null;
}

async function waitForHeartbeatIdle(
  db: ReturnType<typeof createDb>,
  timeoutMs = 3_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const runs = await db
      .select({
        status: heartbeatRuns.status,
      })
      .from(heartbeatRuns);
    if (!runs.some((run) => run.status === "queued" || run.status === "running")) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function spawnOrphanedProcessGroup() {
  const leader = spawn(
    process.execPath,
    [
      "-e",
      [
        "const { spawn } = require('node:child_process');",
        "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
        "process.stdout.write(String(child.pid));",
        "setTimeout(() => process.exit(0), 25);",
      ].join(" "),
    ],
    {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    },
  );

  let stdout = "";
  leader.stdout?.on("data", (chunk) => {
    stdout += String(chunk);
  });

  await new Promise<void>((resolve, reject) => {
    leader.once("error", reject);
    leader.once("exit", () => resolve());
  });

  const descendantPid = Number.parseInt(stdout.trim(), 10);
  if (!Number.isInteger(descendantPid) || descendantPid <= 0) {
    throw new Error(`Failed to capture orphaned descendant pid from detached process group: ${stdout}`);
  }

  return {
    processPid: leader.pid ?? null,
    processGroupId: leader.pid ?? null,
    descendantPid,
  };
}

describeEmbeddedPostgres("heartbeat orphaned process recovery", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  const heartbeatServices = new Set<ReturnType<typeof heartbeatService>>();
  const createHeartbeat = (options?: Parameters<typeof heartbeatService>[1]) => {
    const service = heartbeatService(db, options);
    heartbeatServices.add(service);
    return service;
  };
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let emittedPluginEvents: PluginEvent[] = [];
  let fakeEventBus!: PluginEventBus;
  const drainOutbox = async () => {
    // publishPluginDomainEvent enqueues to the outbox; drain it through the
    // fake bus so emittedPluginEvents reflects what plugins would receive.
    while ((await drainPluginEventOutbox(db, fakeEventBus)) > 0) {
      /* keep draining */
    }
  };
  const childProcesses = new Set<ChildProcess>();
  const cleanupPids = new Set<number>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-recovery-");
    db = createDb(tempDb.connectionString);
    heartbeat = createHeartbeat({ penstockAvailabilityGate: allowPenstockGate });
    const noopScopedBus: ScopedPluginEventBus = {
      subscribe: vi.fn(),
      emit: vi.fn(async () => ({ errors: [] })),
      clear: vi.fn(),
    };
    fakeEventBus = {
      emit: vi.fn(async (event: PluginEvent) => {
        emittedPluginEvents.push(event);
        return { errors: [] };
      }),
      forPlugin: vi.fn(() => noopScopedBus),
      clearPlugin: vi.fn(),
      subscriptionCount: vi.fn(() => 0),
    } satisfies PluginEventBus;
    setPluginEventBus(fakeEventBus);
    // Plugin domain events are now enqueued to the outbox; the worker-tier
    // poller is the sole emitter. Wire the outbox db so publishPluginDomainEvent
    // persists, and drain via pollOnce() before asserting emitted events.
    setPluginEventOutboxDb(db);
  });

  afterEach(async () => {
    vi.clearAllMocks();
    emittedPluginEvents = [];
    const localServiceSupervisor = await vi.importActual<typeof import("../services/local-service-supervisor.js")>(
      "../services/local-service-supervisor.js",
    );
    mockTerminateLocalService.mockImplementation(localServiceSupervisor.terminateLocalService);
    mockHasActiveJobForAgent.mockImplementation(async () => false);
    mockGithubHasReviewerEvidenceForPr.mockResolvedValue({ found: false });
    mockAdapterExecute.mockImplementation(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      summary: "Recovered stranded heartbeat work.",
      resultJson: { summary: "Recovered stranded heartbeat work." },
      provider: "test",
      model: "test-model",
    }));
    runningProcesses.clear();
    for (const child of childProcesses) {
      child.kill("SIGKILL");
    }
    childProcesses.clear();
    for (const pid of cleanupPids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Ignore already-dead cleanup targets.
      }
    }
    cleanupPids.clear();
    const servicesToDrain = [...heartbeatServices];
    await cleanupHeartbeatTestState(db, {
      async drainInFlightExecutions(timeoutMs) {
        await Promise.all(servicesToDrain.map((service) => service.drainInFlightExecutions(timeoutMs)));
      },
    });
    heartbeatServices.clear();
    heartbeatServices.add(heartbeat);
  });

  afterAll(async () => {
    for (const child of childProcesses) {
      child.kill("SIGKILL");
    }
    childProcesses.clear();
    for (const pid of cleanupPids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Ignore already-dead cleanup targets.
      }
    }
    cleanupPids.clear();
    runningProcesses.clear();
    await tempDb?.cleanup();
  }, 120_000);

  async function seedRunFixture(input?: {
    adapterType?: string;
    agentStatus?: "paused" | "idle" | "running";
    runStatus?: "running" | "queued" | "interrupted" | "failed";
    processPid?: number | null;
    processGroupId?: number | null;
    processLossRetryCount?: number;
    includeIssue?: boolean;
    runErrorCode?: string | null;
    runError?: string | null;
    externalRunId?: string | null;
    lastOutputAt?: Date | null;
    contextSnapshot?: Record<string, unknown>;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    const issueId = randomUUID();
    const now = new Date("2026-03-19T00:00:00.000Z");
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      defaultResponsibleUserId: "responsible-user",
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: input?.agentStatus ?? "paused",
      adapterType: input?.adapterType ?? "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: input?.includeIssue === false ? {} : { issueId },
      status: "claimed",
      runId,
      claimedAt: now,
    });

    // Default lastOutputAt to "real now" so external-lifecycle staleness
    // checks (15-min window in heartbeat.ts) treat the seeded run as
    // currently active. Tests that want to exercise the staleness path can
    // pass an older Date explicitly.
    const lastOutputAt = input?.lastOutputAt === undefined ? new Date() : input.lastOutputAt;

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: input?.runStatus ?? "running",
      wakeupRequestId,
      contextSnapshot: input?.includeIssue === false
        ? input?.contextSnapshot ?? {}
        : { ...(input?.contextSnapshot ?? {}), issueId },
      processPid: input?.processPid ?? null,
      processGroupId: input?.processGroupId ?? null,
      processLossRetryCount: input?.processLossRetryCount ?? 0,
      errorCode: input?.runErrorCode ?? null,
      error: input?.runError ?? null,
      externalRunId: input?.externalRunId ?? null,
      startedAt: now,
      createdAt: now,
      updatedAt: new Date("2026-03-19T00:00:00.000Z"),
      lastOutputAt,
    });

    if (input?.includeIssue !== false) {
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "Recover local adapter after lost process",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: agentId,
        checkoutRunId: runId,
        executionRunId: runId,
        responsibleUserId: "responsible-user",
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
      });
    }

    return { companyId, agentId, runId, wakeupRequestId, issueId };
  }

  async function seedAdapterInvokeEvent(input: {
    companyId: string;
    agentId: string;
    runId: string;
  }) {
    await db.insert(heartbeatRunEvents).values({
      companyId: input.companyId,
      agentId: input.agentId,
      runId: input.runId,
      seq: 1,
      eventType: "adapter.invoke",
      stream: "system",
      level: "info",
      message: "adapter invocation",
      payload: {},
    });
  }

  async function seedLaunchedReservation(input: {
    companyId: string;
    agentId: string;
    runId: string;
    slotId?: number;
    jobName?: string;
    jobUid?: string;
  }) {
    const jobName = input.jobName ?? `agent-job-${input.runId.slice(0, 8)}`;
    const jobUid = input.jobUid ?? `uid-${input.runId}`;
    const now = new Date("2026-03-19T00:01:00.000Z");
    return db
      .insert(externalRuntimeReservations)
      .values({
        companyId: input.companyId,
        agentId: input.agentId,
        runId: input.runId,
        slotId: input.slotId ?? 0,
        state: "launched",
        expectedJobName: jobName,
        jobName,
        jobUid,
        isolationMode: "shared",
        isolationKey: `agent-shared:${input.agentId}`,
        isolationBoundAt: now,
        reservedAt: now,
        launchingAt: now,
        launchedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .then((rows) => rows[0]);
  }

  async function seedEnvironmentLeaseFixture(input: {
    companyId: string;
    runId: string;
    issueId: string;
    provider?: string;
  }) {
    const leaseId = randomUUID();
    const now = new Date("2026-03-19T00:00:00.000Z");
    const existingLocalEnvironment = await db
      .select({ id: environments.id })
      .from(environments)
      .where(eq(environments.driver, "local"))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    const environmentId = existingLocalEnvironment?.id ?? randomUUID();

    if (!existingLocalEnvironment) {
      await db.insert(environments).values({
        id: environmentId,
        name: "Local test environment",
        driver: "local",
        status: "active",
        config: {},
        metadata: null,
      });
    }

    await db.insert(environmentLeases).values({
      id: leaseId,
      companyId: input.companyId,
      environmentId,
      issueId: input.issueId,
      heartbeatRunId: input.runId,
      status: "active",
      leasePolicy: "ephemeral",
      provider: input.provider ?? "local",
      providerLeaseId: null,
      acquiredAt: now,
      lastUsedAt: now,
      metadata: {
        driver: "local",
      },
      createdAt: now,
      updatedAt: now,
    });

    return { environmentId, leaseId };
  }

  it("does not reap active adapter executions started by another heartbeat service instance", async () => {
    let releaseAdapter: (() => void) | null = null;
    const adapterStarted = new Promise<void>((resolve) => {
      mockAdapterExecute.mockImplementationOnce(async () => {
        resolve();
        await new Promise<void>((release) => {
          releaseAdapter = release;
        });
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          errorMessage: null,
          summary: "Remote run completed.",
          resultJson: { summary: "Remote run completed." },
          provider: "test",
          model: "test-model",
        };
      });
    });

    const { runId, wakeupRequestId } = await seedRunFixture({
      adapterType: "openclaw_gateway",
      agentStatus: "idle",
      runStatus: "queued",
      processPid: null,
      processGroupId: null,
      includeIssue: false,
    });
    const executorHeartbeat = createHeartbeat();
    const reaperHeartbeat = createHeartbeat();

    await executorHeartbeat.resumeQueuedRuns();
    await Promise.race([
      adapterStarted,
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("Timed out waiting for adapter execution to start")), 3_000);
      }),
    ]);

    await db
      .update(heartbeatRuns)
      .set({
        updatedAt: new Date("2026-03-19T00:00:00.000Z"),
      })
      .where(eq(heartbeatRuns.id, runId));

    const result = await reaperHeartbeat.reapOrphanedRuns({ staleThresholdMs: 1 });
    expect(result).toEqual({ reaped: 0, runIds: [] });

    const activeRun = await reaperHeartbeat.getRun(runId);
    expect(activeRun?.status).toBe("running");
    expect(activeRun?.errorCode).toBeNull();

    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeupRequestId))
      .then((rows) => rows[0] ?? null);
    expect(wakeup?.status).toBe("claimed");

    if (!releaseAdapter) throw new Error("Adapter release handle was not captured");
    releaseAdapter();
    const settledRun = await waitForRunToSettle(executorHeartbeat, runId, 5_000);
    expect(settledRun?.status).toBe("succeeded");
  });

  async function seedPrelaunchReservation(input: {
    companyId: string;
    agentId: string;
    runId: string;
    state?: "reserved" | "launching";
    isolationMode?: "pending" | "shared";
    expectedJobName?: string | null;
    reservedAt: Date;
  }) {
    const isolationMode = input.isolationMode ?? "pending";
    return db
      .insert(externalRuntimeReservations)
      .values({
        companyId: input.companyId,
        agentId: input.agentId,
        runId: input.runId,
        slotId: 0,
        state: input.state ?? "reserved",
        isolationMode,
        isolationKey:
          isolationMode === "shared" ? `agent-shared:${input.agentId}` : `pending:${input.runId}`,
        isolationBoundAt: input.reservedAt,
        reservedAt: input.reservedAt,
        launchingAt: input.state === "launching" ? input.reservedAt : null,
        expectedJobName: input.expectedJobName ?? null,
        createdAt: input.reservedAt,
        updatedAt: input.reservedAt,
      })
      .returning()
      .then((rows) => rows[0]);
  }

  async function seedStrandedIssueFixture(input: {
    status: "todo" | "in_progress";
    runStatus: "failed" | "timed_out" | "cancelled" | "succeeded";
    retryReason?: "assignment_recovery" | "issue_continuation_needed" | "execution_review_participant_recovery" | null;
    runSource?: string | null;
    assignToUser?: boolean;
    activePauseHold?: boolean;
    livenessState?: "completed" | "advanced" | "plan_only" | "empty_response" | "blocked" | "failed" | "needs_followup" | null;
    runErrorCode?: string | null;
    runError?: string | null;
    resultJson?: Record<string, unknown> | null;
    monitorNextCheckAt?: Date | null;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    const rootIssueId = randomUUID();
    const issueId = randomUUID();
    const now = new Date("2026-03-19T00:00:00.000Z");
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      defaultResponsibleUserId: "responsible-user",
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: input.retryReason === "assignment_recovery" ? "issue_assignment_recovery" : "issue_assigned",
      payload: { issueId },
      status: input.runStatus === "cancelled" ? "cancelled" : "failed",
      runId,
      claimedAt: now,
      finishedAt: new Date("2026-03-19T00:05:00.000Z"),
      error: input.runStatus === "succeeded"
        ? null
        : ("runError" in input ? input.runError : "run failed before issue advanced"),
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: input.runStatus,
      wakeupRequestId,
      contextSnapshot: {
        issueId,
        taskId: issueId,
        wakeReason: input.retryReason === "assignment_recovery"
          ? "issue_assignment_recovery"
          : input.retryReason ?? "issue_assigned",
        ...(input.retryReason ? { retryReason: input.retryReason } : {}),
        ...(input.runSource ? { source: input.runSource } : {}),
      },
      startedAt: now,
      finishedAt: new Date("2026-03-19T00:05:00.000Z"),
      updatedAt: new Date("2026-03-19T00:05:00.000Z"),
      errorCode: input.runStatus === "succeeded"
        ? null
        : ("runErrorCode" in input ? input.runErrorCode : "process_lost"),
      error: input.runStatus === "succeeded"
        ? null
        : ("runError" in input ? input.runError : "run failed before issue advanced"),
      livenessState: input.livenessState ?? null,
      resultJson: input.resultJson ?? null,
    });

    await db.insert(issues).values([
      ...(input.activePauseHold
        ? [{
          id: rootIssueId,
          companyId,
          title: "Paused recovery root",
          status: "todo",
          priority: "medium",
          responsibleUserId: "responsible-user",
          issueNumber: 1,
          identifier: `${issuePrefix}-1`,
        }]
        : []),
      {
        id: issueId,
        companyId,
        parentId: input.activePauseHold ? rootIssueId : null,
        title: "Recover stranded assigned work",
        status: input.status,
        priority: "medium",
        assigneeAgentId: input.assignToUser ? null : agentId,
        assigneeUserId: input.assignToUser ? "user-1" : null,
        checkoutRunId: input.status === "in_progress" ? runId : null,
        executionRunId: null,
        monitorNextCheckAt: input.monitorNextCheckAt ?? null,
        responsibleUserId: "responsible-user",
        issueNumber: input.activePauseHold ? 2 : 1,
        identifier: `${issuePrefix}-${input.activePauseHold ? 2 : 1}`,
        startedAt: input.status === "in_progress" ? now : null,
      },
    ]);

    if (input.activePauseHold) {
      await db.insert(issueTreeHolds).values({
        companyId,
        rootIssueId,
        mode: "pause",
        status: "active",
        reason: "pause recovery subtree",
        releasePolicy: { strategy: "manual" },
      });
    }

    return { companyId, agentId, runId, wakeupRequestId, issueId, rootIssueId };
  }

  async function seedInReviewParticipantRunFixture(input?: {
    wakeReason?: string;
    retryReason?: string | null;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    const issueId = randomUUID();
    const stageId = randomUUID();
    const now = new Date("2026-03-19T00:00:00.000Z");
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const wakeReason = input?.wakeReason ?? "execution_review_requested";

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      defaultResponsibleUserId: "responsible-user",
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexReviewer",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: wakeReason,
      payload: {
        issueId,
        ...(input?.retryReason ? { retryReason: input.retryReason } : {}),
      },
      status: "queued",
      runId,
      requestedAt: now,
      updatedAt: now,
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: {
        issueId,
        taskId: issueId,
        wakeReason,
        ...(input?.retryReason ? { retryReason: input.retryReason } : {}),
      },
      updatedAt: now,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Review participant stayed pending",
      status: "in_review",
      priority: "medium",
      assigneeAgentId: agentId,
      assigneeUserId: null,
      executionRunId: runId,
      executionAgentNameKey: "codexreviewer",
      executionLockedAt: now,
      responsibleUserId: "responsible-user",
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      executionState: {
        status: "pending",
        currentStageId: stageId,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId, userId: null },
        returnAssignee: { type: "agent", agentId, userId: null },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    });

    return { companyId, agentId, runId, wakeupRequestId, issueId, stageId };
  }

  async function seedAssignedTodoNoRunFixture(input?: {
    agentStatus?: "paused" | "idle" | "running";
    adapterType?: string;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      defaultResponsibleUserId: "responsible-user",
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: input?.agentStatus ?? "idle",
      adapterType: input?.adapterType ?? "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Assigned todo work that never received a heartbeat",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      assigneeUserId: null,
      responsibleUserId: "responsible-user",
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    return { companyId, agentId, issueId };
  }

  async function seedIdleTimerAgentFixture() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          enabled: true,
          intervalSec: 60,
          wakeOnDemand: true,
          skipTimerWhenNoActionableWork: true,
        },
      },
      permissions: {},
    });

    return { companyId, agentId };
  }

  async function expectStrandedRecoveryArtifacts(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    runId: string;
    previousStatus: "todo" | "in_progress";
    // "unknown" is what the recovery artifact description shows when the
    // failed source run carried no retryReason in its contextSnapshot — i.e.
    // the very first failure (BLO-1498 short-circuit case), not a retry.
    retryReason: "assignment_recovery" | "issue_continuation_needed" | "unknown";
    cause?: "stranded_assigned_issue" | "process_lost";
  }) {
    const expectedCause = input.cause ?? "stranded_assigned_issue";
    const action = await waitForValue(async () =>
      db.select().from(issueRecoveryActions).where(
        and(
          eq(issueRecoveryActions.companyId, input.companyId),
          eq(issueRecoveryActions.sourceIssueId, input.issueId),
          eq(issueRecoveryActions.status, "active"),
        ),
      ).then((rows) => rows[0] ?? null),
    );
    if (!action) throw new Error("Expected source-scoped stranded recovery action to be created");

    expect(action).toMatchObject({
      companyId: input.companyId,
      sourceIssueId: input.issueId,
      recoveryIssueId: null,
      kind: "stranded_assigned_issue",
      status: "active",
      ownerType: "agent",
      ownerAgentId: input.agentId,
      previousOwnerAgentId: input.agentId,
      returnOwnerAgentId: input.agentId,
      cause: expectedCause,
    });

    expect(action.evidence).toMatchObject({
      sourceIssueId: input.issueId,
      previousStatus: input.previousStatus,
      latestRunId: input.runId,
      recoveryCause: expectedCause,
      retryReason: input.retryReason === "unknown" ? null : input.retryReason,
    });

    const recoveryIssueRows = await db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, input.companyId),
          eq(issues.originKind, "stranded_issue_recovery"),
          eq(issues.originId, input.issueId),
        ),
      );
    expect(recoveryIssueRows).toHaveLength(0);

    const wakeups = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, input.agentId));
    const recoveryWakeup = wakeups.find((wakeup) => {
      const payload = wakeup.payload as Record<string, unknown> | null;
      return payload?.issueId === input.issueId &&
        payload?.sourceIssueId === input.issueId &&
        payload?.strandedRunId === input.runId &&
        payload?.recoveryActionId === action.id;
    });
    expect(recoveryWakeup).toMatchObject({
      companyId: input.companyId,
      reason: "source_scoped_recovery_action",
      source: "assignment",
      payload: expect.objectContaining({
        modelProfile: "cheap",
        allowDeliverableWork: false,
        allowDocumentUpdates: false,
        resumeRequiresNormalModel: true,
      }),
    });

    const recoveryRun = recoveryWakeup?.runId
      ? await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, recoveryWakeup.runId))
        .then((rows) => rows[0] ?? null)
      : null;
    expect(recoveryRun?.contextSnapshot).toMatchObject({
      issueId: input.issueId,
      taskId: input.issueId,
      source: "issue_recovery_action",
      recoveryActionId: action.id,
      sourceIssueId: input.issueId,
      strandedRunId: input.runId,
      modelProfile: "cheap",
      allowDeliverableWork: false,
      allowDocumentUpdates: false,
      resumeRequiresNormalModel: true,
    });

    return action;
  }

  async function expectSourceScopedStrandedRecoveryAction(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    runId: string;
    previousStatus: "todo" | "in_progress" | "in_review";
    retryReason?: "assignment_recovery" | "issue_continuation_needed" | "execution_review_participant_recovery" | null;
    cause?: string;
    kind?: string;
    previousOwnerAgentId?: string | null;
    returnOwnerAgentId?: string | null;
  }) {
    const action = await waitForValue(async () =>
      db.select().from(issueRecoveryActions).where(
        and(
          eq(issueRecoveryActions.companyId, input.companyId),
          eq(issueRecoveryActions.sourceIssueId, input.issueId),
        ),
      ).then((rows) => rows[0] ?? null),
    );
    if (!action) throw new Error("Expected source-scoped stranded recovery action to be created");

    expect(action).toMatchObject({
      companyId: input.companyId,
      sourceIssueId: input.issueId,
      recoveryIssueId: null,
      kind: input.kind ?? "stranded_assigned_issue",
      status: "active",
      ownerType: "agent",
      ownerAgentId: input.agentId,
      previousOwnerAgentId: input.previousOwnerAgentId ?? input.agentId,
      returnOwnerAgentId: input.returnOwnerAgentId ?? input.agentId,
      cause: input.cause ?? "stranded_assigned_issue",
      attemptCount: 1,
      // BLO-18996: owner-wake recovery actions now carry a wake budget so a named owner
      // who cannot discharge the action stops being re-woken forever. Only the causes
      // that never wake an owner (provider-quota waits, manual-repair holds) stay null.
      maxAttempts: STRANDED_RECOVERY_MAX_OWNER_WAKE_ATTEMPTS,
    });

    expect(action.evidence).toMatchObject({
      sourceIssueId: input.issueId,
      previousStatus: input.previousStatus,
      latestRunId: input.runId,
      retryReason: input.retryReason ?? null,
      recoveryCause: input.cause ?? "stranded_assigned_issue",
    });
    if (input.cause === "execution_review_participant_recovery") {
      expect(action.nextAction).toContain("failed review participant path");
    } else if (input.cause === "process_lost") {
      expect(action.nextAction).toContain("Retry the original assignee from durable progress");
    } else {
      expect(action.nextAction).toContain(
        input.kind === "missing_disposition" ? "valid issue disposition" : "Restore a live execution path",
      );
    }

    const recoveryIssueRows = await db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, input.companyId),
          eq(issues.originKind, "stranded_issue_recovery"),
          eq(issues.originId, input.issueId),
        ),
      );
    expect(recoveryIssueRows).toHaveLength(0);

    const recoveryWakeup = await waitForValue(async () => {
      const wakeups = await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.agentId, input.agentId));
      return wakeups.find((wakeup) => {
        const payload = wakeup.payload as Record<string, unknown> | null;
        return payload?.issueId === input.issueId &&
          payload?.sourceIssueId === input.issueId &&
          payload?.strandedRunId === input.runId &&
          payload?.recoveryActionId === action.id;
      }) ?? null;
    });
    expect(recoveryWakeup).toMatchObject({
      companyId: input.companyId,
      reason: "source_scoped_recovery_action",
      source: "assignment",
      payload: expect.objectContaining({
        modelProfile: "cheap",
        allowDeliverableWork: false,
        allowDocumentUpdates: false,
        resumeRequiresNormalModel: true,
      }),
    });

    const recoveryRun = recoveryWakeup?.runId
      ? await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, recoveryWakeup.runId))
        .then((rows) => rows[0] ?? null)
      : null;
    expect(recoveryRun?.contextSnapshot).toMatchObject({
      issueId: input.issueId,
      taskId: input.issueId,
      source: "issue_recovery_action",
      recoveryActionId: action.id,
      sourceIssueId: input.issueId,
      strandedRunId: input.runId,
      modelProfile: "cheap",
      allowDeliverableWork: false,
      allowDocumentUpdates: false,
      resumeRequiresNormalModel: true,
    });
    await waitForHeartbeatIdle(db);

    const sourceIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, input.issueId))
      .then((rows) => rows[0] ?? null);
    expect(sourceIssue?.status).toBe("blocked");

    return action;
  }

  async function sourceBlockerIssueIds(companyId: string, sourceIssueId: string) {
    return db
      .select({ blockerIssueId: issueRelations.issueId })
      .from(issueRelations)
      .where(
        and(
          eq(issueRelations.companyId, companyId),
          eq(issueRelations.relatedIssueId, sourceIssueId),
          eq(issueRelations.type, "blocks"),
        ),
      )
      .then((rows) => rows.map((row) => row.blockerIssueId));
  }

  async function seedQueuedIssueRunFixture() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    const issueId = randomUUID();
    const now = new Date("2026-03-19T00:00:00.000Z");
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      defaultResponsibleUserId: "responsible-user",
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });

    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      status: "queued",
      runId,
      requestedAt: now,
      updatedAt: now,
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: {
        issueId,
        taskId: issueId,
        wakeReason: "issue_assigned",
      },
      updatedAt: now,
      createdAt: now,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Retry transient Codex failure without blocking",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      checkoutRunId: runId,
      executionRunId: runId,
      responsibleUserId: "responsible-user",
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      startedAt: now,
    });

    return { companyId, agentId, runId, wakeupRequestId, issueId };
  }

  it("keeps a local run active when the recorded pid is still alive", async () => {
    const child = spawnAliveProcess();
    childProcesses.add(child);
    expect(child.pid).toBeTypeOf("number");

    const { runId, wakeupRequestId } = await seedRunFixture({
      processPid: child.pid ?? null,
      includeIssue: false,
    });

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(0);

    const run = await heartbeat.getRun(runId);
    expect(run?.status).toBe("running");
    expect(run?.errorCode).toBe("process_detached");
    expect(run?.error).toContain(String(child.pid));

    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeupRequestId))
      .then((rows) => rows[0] ?? null);
    expect(wakeup?.status).toBe("claimed");
  });

  it("skips generic timer wakes without invoking an adapter when no assigned work is actionable", async () => {
    const { companyId, agentId } = await seedIdleTimerAgentFixture();
    const heartbeat = createHeartbeat();

    const run = await heartbeat.wakeup(agentId, {
      source: "timer",
      triggerDetail: "system",
      reason: "heartbeat_timer",
      requestedByActorType: "system",
      requestedByActorId: "heartbeat_scheduler",
      contextSnapshot: {
        source: "scheduler",
        reason: "interval_elapsed",
        now: "2026-03-19T00:00:00.000Z",
      },
    });

    expect(run).toBeNull();
    expect(mockAdapterExecute).not.toHaveBeenCalled();

    const requests = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      companyId,
      source: "timer",
      reason: "heartbeat.timer.no_actionable_work",
      status: "skipped",
      error: null,
    });

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(0);
  });

  it.each(["reserved", "launching"] as const)(
    "keeps a six-minute-old pre-adapter run while its %s reservation still owns launch",
    async (state) => {
      // Workspace realization and preRun hooks execute after the run/slot claim
      // but before adapter.invoke. A setup that crosses the five-minute run-row
      // grace must not lose its still-active reservation just before it launches.
      const reservedAt = new Date(Date.now() - 6 * 60 * 1000);
      const { companyId, agentId, runId } = await seedRunFixture({
        adapterType: "opencode_k8s",
        processPid: null,
        processGroupId: null,
        includeIssue: false,
        lastOutputAt: null,
      });
      const reservation = await seedPrelaunchReservation({
        companyId,
        agentId,
        runId,
        state,
        reservedAt,
      });

      const result = await heartbeat.reapOrphanedRuns({ suppressDispatchAfterReap: true });

      expect(result.runIds).not.toContain(runId);
      const run = await heartbeat.getRun(runId);
      expect(run?.status).toBe("running");
      expect(run?.errorCode).toBeNull();
      const persistedReservation = await db
        .select()
        .from(externalRuntimeReservations)
        .where(eq(externalRuntimeReservations.id, reservation.id))
        .then((rows) => rows[0]);
      expect(persistedReservation?.releasedAt).toBeNull();
    },
  );

  it("still reaps a pre-adapter run whose reservation-only launch ownership is older than the bounded grace", async () => {
    const reservedAt = new Date(Date.now() - 16 * 60 * 1000);
    const { companyId, agentId, runId } = await seedRunFixture({
      adapterType: "opencode_k8s",
      processPid: null,
      processGroupId: null,
      includeIssue: false,
      lastOutputAt: null,
    });
    await seedPrelaunchReservation({
      companyId,
      agentId,
      runId,
      state: "reserved",
      reservedAt,
    });

    const result = await heartbeat.reapOrphanedRuns({ suppressDispatchAfterReap: true });

    expect(result.runIds).toContain(runId);
    const run = await heartbeat.getRun(runId);
    expect(run?.status).toBe("failed");
    expect(run?.errorCode).toBe("process_lost");
  });

  it("immediately reaps a fresh exact-missing Job after restart when no adapter owner remains", async () => {
    const jobName = "agent-opencode-restart-missing";
    const { companyId, agentId, runId } = await seedRunFixture({
      adapterType: "opencode_k8s",
      processPid: null,
      processGroupId: null,
      includeIssue: false,
      externalRunId: jobName,
      lastOutputAt: new Date(),
    });
    await seedAdapterInvokeEvent({ companyId, agentId, runId });
    const reservation = await seedLaunchedReservation({
      companyId,
      agentId,
      runId,
      jobName,
    });
    mockListManagedAgentJobs.mockResolvedValueOnce([]);
    mockReadAgentJobRunStatusByName.mockResolvedValueOnce({
      phase: "missing",
      reason: "NotFound",
      name: jobName,
    });

    const result = await heartbeat.reapOrphanedRuns({ suppressDispatchAfterReap: true });

    expect(result.runIds).toContain(runId);
    expect(await heartbeat.getRun(runId)).toMatchObject({
      status: "failed",
      errorCode: "job_missing",
    });
    const persistedReservation = await db
      .select()
      .from(externalRuntimeReservations)
      .where(eq(externalRuntimeReservations.id, reservation.id))
      .then((rows) => rows[0]);
    expect(persistedReservation).toMatchObject({
      state: "released",
      releaseReason: "job_missing",
    });
  });

  it("preserves an exact-head GitHub review when its external Job disappears", async () => {
    const jobName = "agent-opencode-review-posted";
    const headSha = "075a9aeff53a229199ab0583e916f33c22459983";
    const { companyId, agentId, runId, issueId } = await seedRunFixture({
      adapterType: "opencode_k8s",
      agentStatus: "idle",
      externalRunId: jobName,
      contextSnapshot: {
        reviewKind: "pr_review",
        taskKey: `pr_review:Blockcast/onprem-k8s:1648:${headSha}`,
        githubRepoFullName: "Blockcast/onprem-k8s",
        githubPrNumber: 1648,
        githubHeadSha: headSha,
      },
    });
    await seedAdapterInvokeEvent({ companyId, agentId, runId });
    await seedLaunchedReservation({ companyId, agentId, runId, jobName });
    await db
      .update(heartbeatRuns)
      .set({
        resultJson: {
          summary: `Posted the consolidated Ally review on #1648 at ${headSha}.`,
        },
      })
      .where(eq(heartbeatRuns.id, runId));
    mockGithubHasReviewerEvidenceForPr.mockResolvedValueOnce({ found: true, via: "review" });
    await db.insert(issueComments).values({
      companyId,
      issueId,
      authorAgentId: agentId,
      createdByRunId: runId,
      body: "Submitted GitHub review 4781882116 and recorded the terminal outcome.",
    });
    mockListManagedAgentJobs.mockResolvedValueOnce([]);
    mockReadAgentJobRunStatusByName.mockResolvedValueOnce({
      phase: "missing",
      reason: "NotFound",
      name: jobName,
    });

    const result = await heartbeat.reapOrphanedRuns({ suppressDispatchAfterReap: true });

    expect(result.runIds).toContain(runId);
    expect(mockGithubHasReviewerEvidenceForPr).toHaveBeenCalledWith({
      repoFullName: "Blockcast/onprem-k8s",
      prNumber: 1648,
      headSha,
    });
    expect(mockGithubHasReviewerEvidenceForPr).toHaveBeenCalledTimes(1);
    expect(await heartbeat.getRun(runId)).toMatchObject({
      status: "succeeded",
      errorCode: null,
      resultJson: expect.objectContaining({
        externalLifecycleRecovery: expect.objectContaining({
          reason: "job_missing_recorded_outcome_preserved",
        }),
      }),
    });
    const retries = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.retryOfRunId, runId));
    expect(retries).toHaveLength(0);
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments.filter((comment) => comment.body.includes("Submitted GitHub review 4781882116")))
      .toHaveLength(1);
    expect(comments.map((comment) => comment.body)).toContain(SUCCESSFUL_RUN_HANDOFF_REQUIRED_NOTICE_BODY);
    const dispositionWakeups = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(dispositionWakeups.some((wakeup) => wakeup.reason === "finish_successful_run_handoff"))
      .toBe(true);
  });

  it("does not preserve a local review claim without trusted-App GitHub evidence", async () => {
    const jobName = "agent-opencode-untrusted-review-claim";
    const headSha = "075a9aeff53a229199ab0583e916f33c22459983";
    const { companyId, agentId, runId } = await seedRunFixture({
      adapterType: "opencode_k8s",
      agentStatus: "idle",
      externalRunId: jobName,
      contextSnapshot: {
        reviewKind: "pr_review",
        taskKey: `pr_review:Blockcast/onprem-k8s:1648:${headSha}`,
        githubRepoFullName: "Blockcast/onprem-k8s",
        githubPrNumber: 1648,
        githubHeadSha: headSha,
      },
    });
    await seedAdapterInvokeEvent({ companyId, agentId, runId });
    await seedLaunchedReservation({ companyId, agentId, runId, jobName });
    await db
      .update(heartbeatRuns)
      .set({ resultJson: { summary: `Posted the consolidated Ally review on #1648 at ${headSha}.` } })
      .where(eq(heartbeatRuns.id, runId));
    mockGithubHasReviewerEvidenceForPr.mockResolvedValueOnce({ found: false });
    mockListManagedAgentJobs.mockResolvedValueOnce([]);
    mockReadAgentJobRunStatusByName.mockResolvedValueOnce({
      phase: "missing",
      reason: "NotFound",
      name: jobName,
    });

    const result = await heartbeat.reapOrphanedRuns({ suppressDispatchAfterReap: true });

    expect(result.runIds).toContain(runId);
    expect(mockGithubHasReviewerEvidenceForPr).toHaveBeenCalledWith({
      repoFullName: "Blockcast/onprem-k8s",
      prNumber: 1648,
      headSha,
    });
    expect(await heartbeat.getRun(runId)).toMatchObject({
      status: "failed",
      errorCode: "pr_review_output_missing",
    });
    const retries = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.retryOfRunId, runId));
    expect(retries).toHaveLength(1);
  });

  async function recoverClaimedReviewWithUnavailableVerification(kind: "result" | "throw") {
    const jobName = `agent-opencode-review-verification-${kind}`;
    const headSha = "075a9aeff53a229199ab0583e916f33c22459983";
    const { companyId, agentId, runId } = await seedRunFixture({
      adapterType: "opencode_k8s",
      agentStatus: "idle",
      externalRunId: jobName,
      contextSnapshot: {
        reviewKind: "pr_review",
        taskKey: `pr_review:Blockcast/onprem-k8s:1648:${headSha}`,
        githubRepoFullName: "Blockcast/onprem-k8s",
        githubPrNumber: 1648,
        githubHeadSha: headSha,
      },
    });
    await seedAdapterInvokeEvent({ companyId, agentId, runId });
    await seedLaunchedReservation({ companyId, agentId, runId, jobName });
    await db
      .update(heartbeatRuns)
      .set({ resultJson: { summary: `Posted the consolidated Ally review on #1648 at ${headSha}.` } })
      .where(eq(heartbeatRuns.id, runId));
    if (kind === "throw") {
      mockGithubHasReviewerEvidenceForPr.mockRejectedValueOnce(new Error("GitHub unavailable"));
    } else {
      mockGithubHasReviewerEvidenceForPr.mockResolvedValueOnce({ error: "reviews_http_503" });
    }
    mockListManagedAgentJobs.mockResolvedValueOnce([]);
    mockReadAgentJobRunStatusByName.mockResolvedValueOnce({
      phase: "missing",
      reason: "NotFound",
      name: jobName,
    });

    await heartbeat.reapOrphanedRuns({ suppressDispatchAfterReap: true });
    return heartbeat.getRun(runId);
  }

  it("keeps a missing-Job review claim fail-closed when GitHub returns an error", async () => {
    await expect(recoverClaimedReviewWithUnavailableVerification("result")).resolves.toMatchObject({
      status: "failed",
      errorCode: "pr_review_verification_unavailable",
      error: expect.stringContaining("reviews_http_503"),
    });
  });

  it("keeps a missing-Job review claim fail-closed when GitHub verification throws", async () => {
    await expect(recoverClaimedReviewWithUnavailableVerification("throw")).resolves.toMatchObject({
      status: "failed",
      errorCode: "pr_review_verification_unavailable",
      error: expect.stringContaining("verification_threw"),
    });
  });

  it("fails and retries once when a PR-review request comment is not outcome evidence", async () => {
    const jobName = "agent-opencode-review-lost";
    const headSha = "075a9aeff53a229199ab0583e916f33c22459983";
    const { companyId, agentId, runId } = await seedRunFixture({
      adapterType: "opencode_k8s",
      agentStatus: "idle",
      externalRunId: jobName,
      contextSnapshot: {
        reviewKind: "pr_review",
        taskKey: `pr_review:Blockcast/onprem-k8s:1648:${headSha}`,
        githubRepoFullName: "Blockcast/onprem-k8s",
        githubPrNumber: 1648,
        githubHeadSha: headSha,
      },
    });
    await seedAdapterInvokeEvent({ companyId, agentId, runId });
    await seedLaunchedReservation({ companyId, agentId, runId, jobName });
    await db
      .update(heartbeatRuns)
      .set({ resultJson: { summary: `@ally review exact head ${headSha}` } })
      .where(eq(heartbeatRuns.id, runId));
    mockGithubHasReviewerEvidenceForPr.mockResolvedValueOnce({ found: false });
    mockListManagedAgentJobs.mockResolvedValueOnce([]);
    mockReadAgentJobRunStatusByName.mockResolvedValueOnce({
      phase: "missing",
      reason: "NotFound",
      name: jobName,
    });

    const result = await heartbeat.reapOrphanedRuns({ suppressDispatchAfterReap: true });

    expect(result.runIds).toContain(runId);
    expect(mockGithubHasReviewerEvidenceForPr).toHaveBeenCalledWith({
      repoFullName: "Blockcast/onprem-k8s",
      prNumber: 1648,
      headSha,
    });
    expect(mockGithubHasReviewerEvidenceForPr).toHaveBeenCalledTimes(1);
    expect(await heartbeat.getRun(runId)).toMatchObject({
      status: "failed",
      errorCode: "pr_review_output_missing",
    });
    const retries = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.retryOfRunId, runId));
    expect(retries).toHaveLength(1);
    expect(retries[0]).toMatchObject({ status: "scheduled_retry", scheduledRetryAttempt: 1 });
  });

  it("does not treat generic run artifacts as a completed missing-Job outcome", async () => {
    const jobName = "agent-opencode-progress-only";
    const { companyId, agentId, runId, issueId } = await seedRunFixture({
      adapterType: "opencode_k8s",
      agentStatus: "idle",
      externalRunId: jobName,
    });
    await seedAdapterInvokeEvent({ companyId, agentId, runId });
    await seedLaunchedReservation({ companyId, agentId, runId, jobName });
    await db.insert(issueComments).values({
      companyId,
      issueId,
      authorAgentId: agentId,
      createdByRunId: runId,
      body: "Progress update written before the lifecycle Job disappeared.",
    });
    const documentId = randomUUID();
    const revisionId = randomUUID();
    await db.insert(documents).values({
      id: documentId,
      companyId,
      title: "Incomplete recovery notes",
      format: "markdown",
      latestBody: "# Incomplete recovery notes",
      latestRevisionId: revisionId,
      latestRevisionNumber: 1,
      createdByAgentId: agentId,
      updatedByAgentId: agentId,
    });
    await db.insert(documentRevisions).values({
      id: revisionId,
      companyId,
      documentId,
      revisionNumber: 1,
      title: "Incomplete recovery notes",
      format: "markdown",
      body: "# Incomplete recovery notes",
      createdByAgentId: agentId,
      createdByRunId: runId,
    });
    await db.insert(issueDocuments).values({
      companyId,
      issueId,
      documentId,
      key: "progress",
    });
    await db.insert(issueWorkProducts).values({
      companyId,
      issueId,
      type: "report",
      provider: "test",
      externalId: "incomplete-recovery-notes",
      title: "Incomplete recovery notes",
      status: "draft",
      createdByRunId: runId,
    });
    mockListManagedAgentJobs.mockResolvedValueOnce([]);
    mockReadAgentJobRunStatusByName.mockResolvedValueOnce({
      phase: "missing",
      reason: "NotFound",
      name: jobName,
    });

    const result = await heartbeat.reapOrphanedRuns({ suppressDispatchAfterReap: true });

    expect(result.runIds).toContain(runId);
    expect(mockGithubHasReviewerEvidenceForPr).not.toHaveBeenCalled();
    expect(await heartbeat.getRun(runId)).toMatchObject({
      status: "failed",
      errorCode: "job_missing",
    });
    const handoffWakeups = await db
      .select()
      .from(agentWakeupRequests)
      .where(and(
        eq(agentWakeupRequests.agentId, agentId),
        eq(agentWakeupRequests.reason, "finish_successful_run_handoff"),
      ));
    expect(handoffWakeups).toHaveLength(0);
  });

  it("keeps a fresh ownerless run when the exact Job lookup is inconclusive", async () => {
    const jobName = "agent-opencode-inventory-inconclusive";
    const { companyId, agentId, runId } = await seedRunFixture({
      adapterType: "opencode_k8s",
      processPid: null,
      processGroupId: null,
      includeIssue: false,
      externalRunId: jobName,
      lastOutputAt: new Date(),
    });
    await seedAdapterInvokeEvent({ companyId, agentId, runId });
    await seedLaunchedReservation({ companyId, agentId, runId, jobName });
    mockListManagedAgentJobs.mockResolvedValueOnce([]);
    mockReadAgentJobRunStatusByName.mockResolvedValueOnce(null);

    const result = await heartbeat.reapOrphanedRuns({ suppressDispatchAfterReap: true });

    expect(result.runIds).not.toContain(runId);
    expect((await heartbeat.getRun(runId))?.status).toBe("running");
  });

  it("keeps a fresh exact-missing Job while the local adapter owner may still finalize it", async () => {
    const jobName = "agent-opencode-owner-finalizing";
    const { companyId, agentId, runId } = await seedRunFixture({
      adapterType: "opencode_k8s",
      processPid: null,
      processGroupId: null,
      includeIssue: false,
      externalRunId: jobName,
      lastOutputAt: new Date(),
    });
    await seedAdapterInvokeEvent({ companyId, agentId, runId });
    await seedLaunchedReservation({ companyId, agentId, runId, jobName });
    heartbeat.__test_unsafelyTrackActiveRunExecution(runId);
    mockListManagedAgentJobs.mockResolvedValueOnce([]);
    mockReadAgentJobRunStatusByName.mockResolvedValueOnce({
      phase: "missing",
      reason: "NotFound",
      name: jobName,
    });

    const freshResult = await heartbeat.reapOrphanedRuns({ suppressDispatchAfterReap: true });

    expect(freshResult.runIds).not.toContain(runId);
    expect((await heartbeat.getRun(runId))?.status).toBe("running");

    await db
      .update(heartbeatRuns)
      .set({ lastOutputAt: new Date(Date.now() - 16 * 60 * 1000) })
      .where(eq(heartbeatRuns.id, runId));
    mockListManagedAgentJobs.mockResolvedValueOnce([]);
    mockReadAgentJobRunStatusByName.mockResolvedValueOnce({
      phase: "missing",
      reason: "NotFound",
      name: jobName,
    });

    const staleResult = await heartbeat.reapOrphanedRuns({ suppressDispatchAfterReap: true });

    expect(staleResult.runIds).toContain(runId);
    expect(await heartbeat.getRun(runId)).toMatchObject({
      status: "failed",
      errorCode: "job_missing",
    });
  });

  it("releases an old prelaunch reservation left behind by a terminal run so the next queued run can start", async () => {
    const reservedAt = new Date(Date.now() - 16 * 60 * 1000);
    const { companyId, agentId, runId } = await seedRunFixture({
      adapterType: "opencode_k8s",
      agentStatus: "idle",
      runStatus: "interrupted",
      processPid: null,
      processGroupId: null,
      includeIssue: false,
      lastOutputAt: null,
    });
    const reservation = await seedPrelaunchReservation({
      companyId,
      agentId,
      runId,
      state: "launching",
      isolationMode: "shared",
      reservedAt,
    });
    const queuedRunId = randomUUID();
    const queuedWakeupRequestId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: queuedWakeupRequestId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: {},
      status: "queued",
      runId: queuedRunId,
    });
    await db.insert(heartbeatRuns).values({
      id: queuedRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId: queuedWakeupRequestId,
      contextSnapshot: {},
    });
    mockListManagedAgentJobs.mockResolvedValueOnce([]);

    await heartbeat.reapOrphanedRuns({ suppressDispatchAfterReap: true });

    const releasedReservation = await db
      .select()
      .from(externalRuntimeReservations)
      .where(eq(externalRuntimeReservations.id, reservation.id))
      .then((rows) => rows[0]);
    expect(releasedReservation).toMatchObject({
      state: "released",
      releaseReason: "terminal_prelaunch_orphan",
    });
    expect(releasedReservation?.releasedAt).not.toBeNull();

    await heartbeat.resumeQueuedRuns();
    const settledRun = await waitForRunToSettle(heartbeat, queuedRunId, 5_000);
    expect(settledRun?.status).toBe("succeeded");
  });

  it("does not release an old prelaunch reservation while its heartbeat run is non-terminal", async () => {
    const reservedAt = new Date(Date.now() - 16 * 60 * 1000);
    const { companyId, agentId, runId } = await seedRunFixture({
      adapterType: "opencode_k8s",
      agentStatus: "idle",
      runStatus: "queued",
      processPid: null,
      processGroupId: null,
      includeIssue: false,
      lastOutputAt: null,
    });
    const reservation = await seedPrelaunchReservation({
      companyId,
      agentId,
      runId,
      state: "launching",
      isolationMode: "shared",
      reservedAt,
    });
    mockListManagedAgentJobs.mockResolvedValueOnce([]);

    await heartbeat.reapOrphanedRuns({ suppressDispatchAfterReap: true });

    expect((await heartbeat.getRun(runId))?.status).toBe("queued");
    const persistedReservation = await db
      .select()
      .from(externalRuntimeReservations)
      .where(eq(externalRuntimeReservations.id, reservation.id))
      .then((rows) => rows[0]);
    expect(persistedReservation?.state).toBe("launching");
    expect(persistedReservation?.releasedAt).toBeNull();
  });

  it("does not treat expected Job ownership as a terminal prelaunch orphan", async () => {
    const reservedAt = new Date(Date.now() - 16 * 60 * 1000);
    const expectedJobName = "agent-opencode-expected-job";
    const { companyId, agentId, runId } = await seedRunFixture({
      adapterType: "opencode_k8s",
      agentStatus: "idle",
      runStatus: "failed",
      processPid: null,
      processGroupId: null,
      includeIssue: false,
      lastOutputAt: null,
    });
    const reservation = await seedPrelaunchReservation({
      companyId,
      agentId,
      runId,
      state: "launching",
      isolationMode: "shared",
      expectedJobName,
      reservedAt,
    });
    mockListManagedAgentJobs.mockResolvedValueOnce([]);
    mockReadAgentJobRunStatusByName.mockResolvedValueOnce({
      phase: "missing",
      reason: "NotFound",
      name: expectedJobName,
    });

    await heartbeat.reapOrphanedRuns({ suppressDispatchAfterReap: true });

    const persistedReservation = await db
      .select()
      .from(externalRuntimeReservations)
      .where(eq(externalRuntimeReservations.id, reservation.id))
      .then((rows) => rows[0]);
    expect(persistedReservation?.state).toBe("launching");
    expect(persistedReservation?.releasedAt).toBeNull();
    expect(mockReadAgentJobRunStatusByName).not.toHaveBeenCalled();
  });

  it("keeps a recent shared prelaunch reservation while terminal execution teardown may still be unwinding", async () => {
    const reservedAt = new Date(Date.now() - 60 * 1000);
    const { companyId, agentId, runId } = await seedRunFixture({
      adapterType: "opencode_k8s",
      agentStatus: "idle",
      runStatus: "failed",
      processPid: null,
      processGroupId: null,
      includeIssue: false,
      lastOutputAt: null,
    });
    const reservation = await seedPrelaunchReservation({
      companyId,
      agentId,
      runId,
      state: "launching",
      isolationMode: "shared",
      reservedAt,
    });
    mockListManagedAgentJobs.mockResolvedValueOnce([]);

    await heartbeat.reapOrphanedRuns({ suppressDispatchAfterReap: true });

    const persistedReservation = await db
      .select()
      .from(externalRuntimeReservations)
      .where(eq(externalRuntimeReservations.id, reservation.id))
      .then((rows) => rows[0]);
    expect(persistedReservation?.state).toBe("launching");
    expect(persistedReservation?.releasedAt).toBeNull();
  });

  it("queues exactly one retry when the recorded local pid is dead", async () => {
    const { agentId, runId, issueId } = await seedRunFixture({
      agentStatus: "idle",
      processPid: 999_999_999,
      contextSnapshot: {
        reviewKind: "pr_review",
        taskKey: "pr_review:paperclipai/paperclip:123",
        modelProfile: "cheap",
        allowDeliverableWork: false,
        allowDocumentUpdates: false,
        resumeRequiresNormalModel: true,
      },
    });

    const result = await heartbeat.reapOrphanedRuns({ suppressDispatchAfterReap: true });
    expect(result.reaped).toBe(1);
    expect(result.runIds).toEqual([runId]);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(2);

    const failedRun = runs.find((row) => row.id === runId);
    const retryRuns = runs.filter((row) => row.retryOfRunId === runId);
    expect(retryRuns).toHaveLength(1);
    const retryRun = retryRuns[0];
    expect(failedRun?.status).toBe("failed");
    expect(failedRun?.errorCode).toBe("process_lost");
    expect(failedRun?.livenessState).toBe("failed");
    expect(failedRun?.livenessReason).toContain("process_lost");
    expect(failedRun?.resultJson).toMatchObject({
      stopReason: "process_lost",
      timeoutConfigured: false,
      timeoutFired: false,
    });
    expect(["queued", "running"]).toContain(retryRun?.status);
    expect(retryRun?.retryOfRunId).toBe(runId);
    expect(retryRun?.processLossRetryCount).toBe(1);
    expect(retryRun?.contextSnapshot as Record<string, unknown>).not.toHaveProperty("modelProfile");

    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.executionRunId).toBe(retryRun?.id ?? null);
    expect(issue?.checkoutRunId).toBeNull();
  });

  it("restores one lost monitor dispatch before escalating a second process loss", async () => {
    const { companyId, agentId, runId, issueId } = await seedRunFixture({
      adapterType: "openclaw_gateway",
      agentStatus: "idle",
      processPid: null,
      processGroupId: null,
      contextSnapshot: {
        wakeReason: "issue_monitor_due",
        nextCheckAt: "2026-03-19T00:00:00.000Z",
      },
    });
    const heartbeat = createHeartbeat();

    const firstLoss = await heartbeat.reapOrphanedRuns();
    expect(firstLoss).toEqual({ reaped: 1, runIds: [runId] });

    const firstRetry = await db
      .select()
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.retryOfRunId, runId)))
      .then((rows) => rows[0] ?? null);
    expect(firstRetry).toMatchObject({ processLossRetryCount: 1 });
    expect(firstRetry?.contextSnapshot).toMatchObject({
      wakeReason: "process_lost_retry",
      retryReason: "issue_continuation_needed",
      retryOfRunId: runId,
    });

    const secondAttempt = await seedRunFixture({
      adapterType: "openclaw_gateway",
      agentStatus: "idle",
      processPid: null,
      processGroupId: null,
      processLossRetryCount: 1,
      contextSnapshot: {
        wakeReason: "process_lost_retry",
        retryReason: "issue_continuation_needed",
        retryOfRunId: runId,
      },
    });

    const secondLoss = await heartbeat.reapOrphanedRuns();
    expect(secondLoss).toEqual({ reaped: 1, runIds: [secondAttempt.runId] });

    const secondAttemptRuns = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, secondAttempt.agentId));
    expect(secondAttemptRuns.find((run) => run.id === secondAttempt.runId)).toMatchObject({
      id: secondAttempt.runId,
      status: "failed",
      errorCode: "process_lost",
      processLossRetryCount: 1,
    });
    expect(secondAttemptRuns.some((run) => run.processLossRetryCount > 1)).toBe(false);

    const issue = await waitForValue(async () =>
      db.select().from(issues).where(eq(issues.id, secondAttempt.issueId)).then((rows) => {
        const row = rows[0] ?? null;
        return row?.status === "blocked" ? row : null;
      })
    );
    expect(issue?.monitorNextCheckAt).toBeNull();

    await expectSourceScopedStrandedRecoveryAction({
      companyId: secondAttempt.companyId,
      agentId: secondAttempt.agentId,
      issueId: secondAttempt.issueId,
      runId: secondAttempt.runId,
      previousStatus: "in_progress",
      retryReason: "issue_continuation_needed",
      cause: "process_lost",
    });
  });

  it("does not retry a lost monitor dispatch while another monitor wake remains scheduled", async () => {
    const { companyId, runId, issueId } = await seedRunFixture({
      adapterType: "openclaw_gateway",
      agentStatus: "idle",
      processPid: null,
      processGroupId: null,
      contextSnapshot: {
        wakeReason: "issue_monitor_due",
      },
    });
    await db
      .update(issues)
      .set({ monitorNextCheckAt: new Date("2099-03-19T00:00:00.000Z") })
      .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)));

    const heartbeat = createHeartbeat();
    const result = await heartbeat.reapOrphanedRuns();

    expect(result).toEqual({ reaped: 1, runIds: [runId] });
    const retries = await db
      .select()
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.retryOfRunId, runId)));
    expect(retries).toHaveLength(0);
  });

  async function withTempPaperclipHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-hot-restart-"));
    const previousHome = process.env.PAPERCLIP_HOME;
    process.env.PAPERCLIP_HOME = home;
    try {
      return await fn(home);
    } finally {
      if (previousHome === undefined) delete process.env.PAPERCLIP_HOME;
      else process.env.PAPERCLIP_HOME = previousHome;
      await fs.rm(home, { recursive: true, force: true });
    }
  }

  it("captures a hot-restart shutdown snapshot without interrupting running runs", async () => {
    const child = spawnAliveProcess();
    childProcesses.add(child);
    expect(child.pid).toBeGreaterThan(0);
    const { runId, wakeupRequestId } = await seedRunFixture({
      agentStatus: "running",
      processPid: child.pid ?? null,
      processGroupId: null,
    });

    await withTempPaperclipHome(async () => {
      await writeHotRestartIntent({
        previousServerPid: process.pid,
        previousServerVersion: "old-version",
        requestedAt: new Date("2026-03-19T00:05:00.000Z"),
      });
      const heartbeat = createHeartbeat();

      const result = await heartbeat.prepareHotRestartShutdown(
        "SIGTERM",
        new Date("2026-03-19T00:06:00.000Z"),
      );

      expect(result).toEqual({
        mode: "hot_restart",
        skipDrain: true,
        activeRunIds: [runId],
      });
      expect(isPidAlive(child.pid)).toBe(true);
      const run = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      expect(run).toMatchObject({
        status: "running",
        errorCode: null,
      });
      const wakeup = await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, wakeupRequestId))
        .then((rows) => rows[0] ?? null);
      expect(wakeup?.status).toBe("claimed");
      const intent = await readHotRestartIntent();
      expect(intent?.shutdownSnapshot).toMatchObject({
        capturedAt: "2026-03-19T00:06:00.000Z",
        signal: "SIGTERM",
        activeRuns: [
          {
            runId,
            adapterType: "codex_local",
            status: "running",
            processPid: child.pid,
          },
        ],
      });
    });
  });

  it("reports adopted hot-restart runs before startup reap can mark them process_lost", async () => {
    const child = spawnAliveProcess();
    childProcesses.add(child);
    expect(child.pid).toBeGreaterThan(0);
    const { runId } = await seedRunFixture({
      agentStatus: "running",
      processPid: child.pid ?? null,
      processGroupId: null,
    });

    await withTempPaperclipHome(async (home) => {
      const heartbeat = createHeartbeat();
      await writeHotRestartIntent({
        previousServerPid: process.pid,
        previousServerVersion: "old-version",
        requestedAt: new Date("2026-03-19T00:05:00.000Z"),
      });
      await heartbeat.prepareHotRestartShutdown(
        "SIGTERM",
        new Date("2026-03-19T00:06:00.000Z"),
      );

      const adoption = await heartbeat.reconcileHotRestartAdoption(
        new Date("2026-03-19T00:07:00.000Z"),
      );
      expect(adoption).toMatchObject({
        mode: "reported",
        adoptedRunIds: [runId],
        finalizedWhileDownRunIds: [],
        lostRunIds: [],
        skippedRunIds: [],
      });

      const report = JSON.parse(
        await fs.readFile(resolveHotRestartReportPath(home), "utf8"),
      ) as Record<string, unknown>;
      expect(report).toMatchObject({
        previousServerPid: process.pid,
        newServerPid: process.pid,
        previousServerVersion: "old-version",
        adoptedRunIds: [runId],
        finalizedWhileDownRunIds: [],
        lostRunIds: [],
      });
      expect(typeof report.newServerVersion).toBe("string");

      const reap = await heartbeat.reapOrphanedRuns();
      expect(reap).toEqual({ reaped: 0, runIds: [] });
      const adopted = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      expect(adopted?.status).toBe("running");
      expect(adopted?.errorCode).not.toBe("process_lost");
      expect(adopted?.resultJson).toMatchObject({
        hotRestart: {
          adopted: true,
          adoptedAt: "2026-03-19T00:07:00.000Z",
          previousServerPid: process.pid,
          newServerPid: process.pid,
          previousServerVersion: "old-version",
          processPid: child.pid,
        },
      });
    });
  });

  it.skipIf(process.platform === "win32")("keeps process-group-only hot-restart adoptions out of process_lost reaping", async () => {
    const orphan = await spawnOrphanedProcessGroup();
    cleanupPids.add(orphan.descendantPid);
    expect(isPidAlive(orphan.descendantPid)).toBe(true);
    const { runId } = await seedRunFixture({
      agentStatus: "running",
      processPid: orphan.processPid,
      processGroupId: orphan.processGroupId,
    });

    await withTempPaperclipHome(async () => {
      const heartbeat = createHeartbeat();
      await writeHotRestartIntent({
        previousServerPid: process.pid,
        previousServerVersion: "old-version",
        requestedAt: new Date("2026-03-19T00:05:00.000Z"),
      });
      await heartbeat.prepareHotRestartShutdown(
        "SIGTERM",
        new Date("2026-03-19T00:06:00.000Z"),
      );

      const adoption = await heartbeat.reconcileHotRestartAdoption(
        new Date("2026-03-19T00:07:00.000Z"),
      );
      expect(adoption).toMatchObject({
        mode: "reported",
        adoptedRunIds: [runId],
        finalizedWhileDownRunIds: [],
        lostRunIds: [],
        skippedRunIds: [],
      });

      const reap = await heartbeat.reapOrphanedRuns();
      expect(reap).toEqual({ reaped: 0, runIds: [] });
      expect(isPidAlive(orphan.descendantPid)).toBe(true);
      const adopted = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      expect(adopted?.status).toBe("running");
      expect(adopted?.errorCode).not.toBe("process_lost");
      expect(adopted?.resultJson).toMatchObject({
        hotRestart: {
          adopted: true,
          processPid: orphan.processPid,
          processGroupId: orphan.processGroupId,
        },
      });
    });
  });

  it("interrupts running runs on graceful shutdown and queues restart recovery without recording a failure", async () => {
    const { agentId, runId, issueId, wakeupRequestId } = await seedRunFixture({
      agentStatus: "running",
      contextSnapshot: {
        modelProfile: "cheap",
        allowDeliverableWork: false,
        allowDocumentUpdates: false,
        resumeRequiresNormalModel: true,
      },
    });
    const heartbeat = createHeartbeat();

    const result = await heartbeat.drainRunningRunsForShutdown(
      "SIGTERM",
      new Date("2026-03-19T00:06:00.000Z"),
    );
    expect(result.interrupted).toBe(1);
    expect(result.interruptedRunIds).toEqual([runId]);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(2);

    const interruptedRun = runs.find((row) => row.id === runId);
    const retryRun = runs.find((row) => row.retryOfRunId === runId);
    expect(interruptedRun).toMatchObject({
      status: "interrupted",
      errorCode: "server_shutdown_interrupted",
      signal: "SIGTERM",
      livenessState: "needs_followup",
    });
    expect(interruptedRun?.resultJson).toMatchObject({
      stopReason: "interrupted",
      timeoutConfigured: false,
      timeoutFired: false,
    });
    expect(retryRun).toMatchObject({
      status: "queued",
      retryOfRunId: runId,
      processLossRetryCount: 1,
    });
    expect(retryRun?.contextSnapshot as Record<string, unknown>).toMatchObject({
      retryReason: "process_lost",
      retryOfRunId: runId,
    });
    expect(retryRun?.contextSnapshot as Record<string, unknown>).not.toHaveProperty("modelProfile");

    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeupRequestId))
      .then((rows) => rows[0] ?? null);
    expect(wakeup?.status).toBe("cancelled");

    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.checkoutRunId).toBeNull();
    expect(issue?.executionRunId).toBe(retryRun?.id);
  });

  it("does not overwrite a run that is no longer running during graceful shutdown drain", async () => {
    const { runId, wakeupRequestId } = await seedRunFixture({
      agentStatus: "running",
    });
    const heartbeat = createHeartbeat();

    await db
      .update(heartbeatRuns)
      .set({
        status: "succeeded",
        finishedAt: new Date("2026-03-19T00:05:30.000Z"),
        updatedAt: new Date("2026-03-19T00:05:30.000Z"),
      })
      .where(eq(heartbeatRuns.id, runId));

    const result = await heartbeat.drainRunningRunsForShutdown(
      "SIGTERM",
      new Date("2026-03-19T00:06:00.000Z"),
    );

    expect(result).toMatchObject({
      interrupted: 0,
      interruptedRunIds: [],
      retryRunIds: [],
    });
    const run = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    expect(run).toMatchObject({
      status: "succeeded",
      errorCode: null,
      signal: null,
    });
    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeupRequestId))
      .then((rows) => rows[0] ?? null);
    expect(wakeup?.status).toBe("claimed");
  });

  it("does not enqueue duplicate restart recovery for the same interrupted run", async () => {
    const { agentId, runId, issueId, wakeupRequestId } = await seedRunFixture({
      agentStatus: "running",
    });
    const heartbeat = createHeartbeat();

    await heartbeat.drainRunningRunsForShutdown("SIGTERM", new Date("2026-03-19T00:06:00.000Z"));
    const firstRetry = await db
      .select()
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.retryOfRunId, runId)))
      .then((rows) => rows[0] ?? null);
    expect(firstRetry?.id).toBeTruthy();

    await db
      .update(heartbeatRuns)
      .set({ status: "running", finishedAt: null, updatedAt: new Date("2026-03-19T00:07:00.000Z") })
      .where(eq(heartbeatRuns.id, runId));
    await db
      .update(agentWakeupRequests)
      .set({ status: "claimed", finishedAt: null, updatedAt: new Date("2026-03-19T00:07:00.000Z") })
      .where(eq(agentWakeupRequests.id, wakeupRequestId));
    await db
      .update(issues)
      .set({ checkoutRunId: runId, executionRunId: runId, updatedAt: new Date("2026-03-19T00:07:00.000Z") })
      .where(eq(issues.id, issueId));

    const secondDrain = await heartbeat.drainRunningRunsForShutdown(
      "SIGTERM",
      new Date("2026-03-19T00:08:00.000Z"),
    );
    expect(secondDrain.retryRunIds).toEqual([firstRetry?.id]);

    const retryRuns = await db
      .select()
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.retryOfRunId, runId)));
    expect(retryRuns).toHaveLength(1);
    expect(retryRuns[0]?.id).toBe(firstRetry?.id);
  });

  it("chains a single retry when restart recovery is interrupted by a second graceful shutdown", async () => {
    const { agentId, runId, issueId } = await seedRunFixture({
      agentStatus: "running",
    });
    const heartbeat = createHeartbeat();

    await heartbeat.drainRunningRunsForShutdown("SIGTERM", new Date("2026-03-19T00:06:00.000Z"));
    const firstRetry = await db
      .select()
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.retryOfRunId, runId)))
      .then((rows) => rows[0] ?? null);
    expect(firstRetry?.id).toBeTruthy();

    await db
      .update(heartbeatRuns)
      .set({ status: "running", startedAt: new Date("2026-03-19T00:07:00.000Z"), updatedAt: new Date("2026-03-19T00:07:00.000Z") })
      .where(eq(heartbeatRuns.id, firstRetry!.id));
    await db
      .update(agentWakeupRequests)
      .set({ status: "claimed", claimedAt: new Date("2026-03-19T00:07:00.000Z"), updatedAt: new Date("2026-03-19T00:07:00.000Z") })
      .where(eq(agentWakeupRequests.id, firstRetry!.wakeupRequestId));
    await db
      .update(issues)
      .set({ checkoutRunId: firstRetry!.id, executionRunId: firstRetry!.id, updatedAt: new Date("2026-03-19T00:07:00.000Z") })
      .where(eq(issues.id, issueId));

    const secondDrain = await heartbeat.drainRunningRunsForShutdown(
      "SIGTERM",
      new Date("2026-03-19T00:08:00.000Z"),
    );
    expect(secondDrain.interruptedRunIds).toEqual([firstRetry!.id]);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(3);
    expect(runs.find((row) => row.id === runId)?.status).toBe("interrupted");
    expect(runs.find((row) => row.id === firstRetry!.id)?.status).toBe("interrupted");

    const originalRetries = runs.filter((row) => row.retryOfRunId === runId);
    expect(originalRetries).toHaveLength(1);
    const secondRetry = runs.find((row) => row.retryOfRunId === firstRetry!.id);
    expect(secondRetry).toMatchObject({
      status: "queued",
      processLossRetryCount: 2,
    });

    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.checkoutRunId).toBeNull();
    expect(issue?.executionRunId).toBe(secondRetry?.id);
  });

  it("releases active environment leases when an orphaned run is reaped", async () => {
    const { runId, issueId, companyId } = await seedRunFixture({
      processPid: 999_999_999,
    });
    const { leaseId } = await seedEnvironmentLeaseFixture({
      companyId,
      runId,
      issueId,
    });
    const heartbeat = createHeartbeat();

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(1);
    expect(result.runIds).toEqual([runId]);

    const lease = await db
      .select()
      .from(environmentLeases)
      .where(eq(environmentLeases.id, leaseId))
      .then((rows) => rows[0] ?? null);
    expect(lease?.status).toBe("failed");
    expect(lease?.releasedAt).toBeTruthy();
  });

  it.skipIf(process.platform === "win32")("reaps orphaned descendant process groups when the parent pid is already gone", async () => {
    const orphan = await spawnOrphanedProcessGroup();
    cleanupPids.add(orphan.descendantPid);
    expect(isPidAlive(orphan.descendantPid)).toBe(true);

    const { agentId, runId, issueId } = await seedRunFixture({
      agentStatus: "idle",
      processPid: orphan.processPid,
      processGroupId: orphan.processGroupId,
      contextSnapshot: {
        reviewKind: "pr_review",
        taskKey: "pr_review:paperclipai/paperclip:124",
      },
    });

    const result = await heartbeat.reapOrphanedRuns({ suppressDispatchAfterReap: true });
    expect(result.reaped).toBe(1);
    expect(result.runIds).toEqual([runId]);

    expect(await waitForPidExit(orphan.descendantPid, 2_000)).toBe(true);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(2);

    const failedRun = runs.find((row) => row.id === runId);
    expect(failedRun?.status).toBe("failed");
    expect(failedRun?.errorCode).toBe("process_lost");
    expect(failedRun?.error).toContain("descendant process group");
    expect(failedRun?.resultJson).toMatchObject({
      stopReason: UNMANAGED_BACKGROUND_TASK_STOP_REASON,
      unmanagedBackgroundTask: {
        kind: "orphaned_process_group_cleanup",
        stopped: true,
        stopReason: UNMANAGED_BACKGROUND_TASK_STOP_REASON,
        reason: UNMANAGED_BACKGROUND_TASK_LIVENESS_REASON,
        processPid: orphan.processPid,
        processGroupId: orphan.processGroupId,
      },
    });

    const retryRun = runs.find((row) => row.id !== runId);
    expect(["queued", "running"]).toContain(retryRun?.status);

    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.executionRunId).toBe(retryRun?.id ?? null);
  });

  it("blocks the issue when process-loss retry is exhausted and the immediate continuation recovery also fails", async () => {
    mockAdapterExecute.mockRejectedValueOnce(new Error("continuation recovery failed"));

    const { companyId, agentId, runId, issueId } = await seedRunFixture({
      agentStatus: "idle",
      processPid: 999_999_999,
      processLossRetryCount: 1,
    });
    const resolvedBlockerId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(issues).values({
      id: resolvedBlockerId,
      companyId,
      title: "Already completed prerequisite",
      status: "done",
      priority: "medium",
      issueNumber: 2,
      identifier: `${issuePrefix}-2`,
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId: resolvedBlockerId,
      relatedIssueId: issueId,
      type: "blocks",
    });

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(1);
    expect(result.runIds).toEqual([runId]);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(2);
    expect(runs.find((row) => row.id === runId)?.status).toBe("failed");
    const continuationRun = runs.find((row) => row.id !== runId);
    expect(continuationRun?.contextSnapshot as Record<string, unknown> | undefined).toMatchObject({
      retryReason: "issue_continuation_needed",
      retryOfRunId: runId,
    });
    if (!continuationRun?.id) throw new Error("Expected continuation recovery run to exist");

    const settledContinuationRun = await waitForRunToSettle(heartbeat, continuationRun.id, 10_000);
    expect(settledContinuationRun?.status).toBe("failed");

    const blockedIssue = await waitForValue(
      async () => db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => {
        const issue = rows[0] ?? null;
        return issue?.status === "blocked" ? issue : null;
      }),
      10_000,
    );
    expect(blockedIssue?.status).toBe("blocked");
    expect(blockedIssue?.executionRunId).toBeNull();
    expect(blockedIssue?.checkoutRunId).toBeNull();

    const recovery = await expectStrandedRecoveryArtifacts({
      companyId,
      agentId,
      issueId,
      runId: continuationRun.id,
      previousStatus: "in_progress",
      retryReason: "issue_continuation_needed",
    });

    const blockerRelations = await db
      .select()
      .from(issueRelations)
      .where(
        and(
          eq(issueRelations.companyId, companyId),
          eq(issueRelations.relatedIssueId, issueId),
          eq(issueRelations.type, "blocks"),
        ),
      );
    expect(blockerRelations.map((relation) => relation.issueId)).toEqual([]);

    const comments = await waitForValue(async () => {
      const rows = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
      return rows.length > 0 ? rows : null;
    });
    expect(comments).toHaveLength(1);
    expect(comments![0]?.body).toContain("retried continuation");
    expect(comments![0]?.body).toContain(`Recovery action: \`${recovery.id}\``);
  });

  it("blocks failed recovery work in place during immediate terminal-run cleanup", async () => {
    const sourceIssueId = randomUUID();
    const { companyId, agentId, runId, issueId } = await seedRunFixture({
      agentStatus: "idle",
      processPid: 999_999_999,
      processLossRetryCount: 1,
      runErrorCode: "process_lost",
      runError: "Authorization: Bearer sk-test-recovery-secret",
    });
    await db
      .update(issues)
      .set({
        title: "Recover stalled issue PAP-1",
        originKind: "stranded_issue_recovery",
        originId: sourceIssueId,
      })
      .where(eq(issues.id, issueId));
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(issues).values({
      id: sourceIssueId,
      companyId,
      title: "Original stranded source",
      status: "blocked",
      priority: "medium",
      issueNumber: 2,
      identifier: `${issuePrefix}-2`,
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId,
      relatedIssueId: sourceIssueId,
      type: "blocks",
    });

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(1);
    expect(result.runIds).toEqual([runId]);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("failed");

    const recoveryIssue = await waitForValue(async () =>
      db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => {
        const issue = rows[0] ?? null;
        return issue?.status === "blocked" ? issue : null;
      })
    );
    expect(recoveryIssue?.assigneeAgentId).toBe(agentId);
    expect(recoveryIssue?.originKind).toBe("stranded_issue_recovery");
    expect(recoveryIssue?.originId).toBe(sourceIssueId);
    expect(recoveryIssue?.executionRunId).toBeNull();

    const nestedRecoveries = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stranded_issue_recovery"), eq(issues.originId, issueId)));
    expect(nestedRecoveries).toHaveLength(0);

    const comments = await waitForValue(async () => {
      const rows = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
      return rows.length > 0 ? rows : null;
    });
    expect(comments).toHaveLength(1);
    expect(comments![0]?.body).toContain("stopped automatic stranded-work recovery");
    expect(comments![0]?.body).toContain("recovery issues do not create nested `stranded_issue_recovery` issues");
    // Failure summary surfaces the errorCode (and a redacted error message
    // when present) so the recovery agent can see WHY the original assignee
    // failed without inspecting the linked run. Secrets are still scrubbed
    // — see the explicit `not.toContain` assertion above where applicable.
    expect(comments![0]?.body).toContain("Latest retry failure:");
    expect(comments![0]?.body).not.toContain("sk-test-recovery-secret");
    await expect(sourceBlockerIssueIds(companyId, sourceIssueId)).resolves.toEqual([issueId]);
  });

  it("does not block paused-tree work when immediate continuation recovery is suppressed by the hold", async () => {
    const { companyId, agentId, runId, issueId } = await seedRunFixture({
      agentStatus: "idle",
      processPid: 999_999_999,
      processLossRetryCount: 1,
    });
    await db.insert(issueTreeHolds).values({
      companyId,
      rootIssueId: issueId,
      mode: "pause",
      status: "active",
      reason: "pause immediate recovery subtree",
      releasePolicy: { strategy: "manual" },
    });

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(1);
    expect(result.runIds).toEqual([runId]);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("failed");

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("in_progress");
    expect(issue?.executionRunId).toBeNull();
    // Terminal run cleanup releases the checkout lock even when paused-tree recovery is suppressed.
    expect(issue?.checkoutRunId).toBeNull();

    const recoveryIssues = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stranded_issue_recovery")));
    expect(recoveryIssues).toHaveLength(0);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(0);
  });

  it("does not treat synthetic k8s keepalive chunks as run output progress", async () => {
    const readOutputProgress = async (runId: string) =>
      db
        .select({
          lastOutputAt: heartbeatRuns.lastOutputAt,
          lastOutputSeq: heartbeatRuns.lastOutputSeq,
          lastOutputStream: heartbeatRuns.lastOutputStream,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);

    let progressBeforeKeepalive: Awaited<ReturnType<typeof readOutputProgress>> = null;
    let progressAfterKeepalive: Awaited<ReturnType<typeof readOutputProgress>> = null;

    mockAdapterExecute.mockImplementationOnce(async (ctx) => {
      progressBeforeKeepalive = await readOutputProgress(ctx.runId);
      await ctx.onLog?.(
        "stdout",
        "[paperclip] keepalive — job ac-agent-123 running (713s since last output)\n",
      );
      progressAfterKeepalive = await readOutputProgress(ctx.runId);
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        summary: "Completed after a synthetic keepalive.",
        provider: "test",
        model: "test-model",
        resultJson: { result: "done" },
      };
    });

    const { runId } = await seedQueuedIssueRunFixture();

    await heartbeat.resumeQueuedRuns();
    const settledRun = await waitForRunToSettle(heartbeat, runId);

    expect(settledRun?.status).toBe("succeeded");
    expect(settledRun?.logBytes ?? 0).toBeGreaterThan(0);
    expect(progressAfterKeepalive).not.toBeNull();
    expect(progressAfterKeepalive?.lastOutputAt?.toISOString() ?? null).toBe(
      progressBeforeKeepalive?.lastOutputAt?.toISOString() ?? null,
    );
    expect(progressAfterKeepalive?.lastOutputSeq).toBe(progressBeforeKeepalive?.lastOutputSeq);
    expect(progressAfterKeepalive?.lastOutputStream).toBe(progressBeforeKeepalive?.lastOutputStream);
    expect(settledRun?.stdoutExcerpt ?? "").not.toContain("[paperclip] keepalive");
  });

  async function settleClaimedPrReview(
    verification:
      | { kind: "result"; value: { found: true; via: "review" | "comment" } | { found: false } | { error: string } }
      | { kind: "throw" },
  ) {
    const headSha = "075a9aeff53a229199ab0583e916f33c22459983";
    const summary = `Posted the consolidated Ally review on #1648 at ${headSha}.`;
    mockAdapterExecute.mockResolvedValueOnce({
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      summary,
      resultJson: { summary },
      provider: "test",
      model: "test-model",
    });
    if (verification.kind === "throw") {
      mockGithubHasReviewerEvidenceForPr.mockRejectedValueOnce(new Error("GitHub unavailable"));
    } else {
      mockGithubHasReviewerEvidenceForPr.mockResolvedValueOnce(verification.value);
    }
    const { runId } = await seedQueuedIssueRunFixture();
    await db
      .update(heartbeatRuns)
      .set({
        contextSnapshot: {
          reviewKind: "pr_review",
          taskKey: `pr_review:Blockcast/onprem-k8s:1648:${headSha}`,
          githubRepoFullName: "Blockcast/onprem-k8s",
          githubPrNumber: 1648,
          githubHeadSha: headSha,
        },
      })
      .where(eq(heartbeatRuns.id, runId));

    await heartbeat.resumeQueuedRuns();
    const settledRun = await waitForRunToSettle(heartbeat, runId);

    return { headSha, runId, settledRun };
  }

  it("completes a claimed PR review only after trusted exact-head App evidence is found", async () => {
    const { headSha, settledRun } = await settleClaimedPrReview({
      kind: "result",
      value: { found: true, via: "comment" },
    });

    expect(mockGithubHasReviewerEvidenceForPr).toHaveBeenCalledWith({
      repoFullName: "Blockcast/onprem-k8s",
      prNumber: 1648,
      headSha,
    });
    expect(settledRun).toMatchObject({
      status: "succeeded",
      errorCode: null,
    });
  });

  it("fails a completed PR-review run whose local claim has no trusted-App evidence", async () => {
    const { headSha, settledRun } = await settleClaimedPrReview({
      kind: "result",
      value: { found: false },
    });

    expect(mockGithubHasReviewerEvidenceForPr).toHaveBeenCalledWith({
      repoFullName: "Blockcast/onprem-k8s",
      prNumber: 1648,
      headSha,
    });
    expect(settledRun).toMatchObject({
      status: "failed",
      errorCode: "pr_review_output_missing",
    });
  });

  it("classifies a GitHub evidence API error separately from missing review output", async () => {
    const { settledRun } = await settleClaimedPrReview({
      kind: "result",
      value: { error: "reviews_http_503" },
    });

    expect(settledRun).toMatchObject({
      status: "failed",
      errorCode: "pr_review_verification_unavailable",
      error: expect.stringContaining("reviews_http_503"),
    });
  });

  it("classifies a thrown GitHub evidence check separately from missing review output", async () => {
    const { settledRun } = await settleClaimedPrReview({ kind: "throw" });

    expect(settledRun).toMatchObject({
      status: "failed",
      errorCode: "pr_review_verification_unavailable",
      error: expect.stringContaining("verification_threw"),
    });
  });

  it("materializes missing opencode_k8s shared docs before adapter dispatch", async () => {
    const instructionsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-k8s-docs-"));
    await fs.writeFile(
      path.join(instructionsRoot, "AGENTS.md"),
      "Read: docs/architecture-template.md\n",
      "utf8",
    );

    try {
      const { agentId, runId } = await seedQueuedIssueRunFixture();
      await db
        .update(agents)
        .set({
          adapterType: "opencode_k8s",
          adapterConfig: {
            instructionsBundleMode: "external",
            instructionsRootPath: instructionsRoot,
            instructionsFilePath: path.join(instructionsRoot, "AGENTS.md"),
            instructionsEntryFile: "AGENTS.md",
          },
        })
        .where(eq(agents.id, agentId));

      await heartbeat.resumeQueuedRuns();
      await waitForRunToSettle(heartbeat, runId);

      const adapterCall = mockAdapterExecute.mock.calls.find(([ctx]) => ctx.runId === runId)?.[0] as
        | { context?: { paperclipWorkspace?: { cwd?: unknown } } }
        | undefined;
      const workspaceCwd = adapterCall?.context?.paperclipWorkspace?.cwd;
      expect(workspaceCwd).toBeTypeOf("string");
      const materialized = await fs.readFile(
        path.join(workspaceCwd as string, "docs", "architecture-template.md"),
        "utf8",
      );
      expect(materialized).toContain("# Missing Shared Documentation: docs/architecture-template.md");
      expect(materialized).toContain("Continue the run without failing");
    } finally {
      await fs.rm(instructionsRoot, { recursive: true, force: true });
    }
  });

  it("does not materialize opencode_k8s shared docs when instructions do not reference them", async () => {
    const instructionsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-k8s-docs-"));
    await fs.writeFile(path.join(instructionsRoot, "AGENTS.md"), "No shared docs referenced here.\n", "utf8");

    try {
      const { agentId, runId } = await seedQueuedIssueRunFixture();
      await db
        .update(agents)
        .set({
          adapterType: "opencode_k8s",
          adapterConfig: {
            instructionsBundleMode: "external",
            instructionsRootPath: instructionsRoot,
            instructionsFilePath: path.join(instructionsRoot, "AGENTS.md"),
            instructionsEntryFile: "AGENTS.md",
          },
        })
        .where(eq(agents.id, agentId));

      await heartbeat.resumeQueuedRuns();
      await waitForRunToSettle(heartbeat, runId);

      const adapterCall = mockAdapterExecute.mock.calls.find(([ctx]) => ctx.runId === runId)?.[0] as
        | { context?: { paperclipWorkspace?: { cwd?: unknown } } }
        | undefined;
      const workspaceCwd = adapterCall?.context?.paperclipWorkspace?.cwd;
      expect(workspaceCwd).toBeTypeOf("string");
      await expect(fs.stat(path.join(workspaceCwd as string, "docs"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(instructionsRoot, { recursive: true, force: true });
    }
  });

  it("logs non-missing opencode_k8s instructions read failures", async () => {
    const instructionsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-k8s-docs-"));
    await fs.mkdir(path.join(instructionsRoot, "AGENTS.md"));

    try {
      const { agentId, runId } = await seedQueuedIssueRunFixture();
      await db
        .update(agents)
        .set({
          adapterType: "opencode_k8s",
          adapterConfig: {
            instructionsBundleMode: "external",
            instructionsRootPath: instructionsRoot,
            instructionsFilePath: path.join(instructionsRoot, "AGENTS.md"),
            instructionsEntryFile: "AGENTS.md",
          },
        })
        .where(eq(agents.id, agentId));

      await heartbeat.resumeQueuedRuns();
      const settledRun = await waitForRunToSettle(heartbeat, runId);

      expect(settledRun?.stderrExcerpt ?? "").toContain(
        "Skipped opencode_k8s shared docs materialization: failed to read instructions entry",
      );
      expect(settledRun?.stderrExcerpt ?? "").toContain("EISDIR");
    } finally {
      await fs.rm(instructionsRoot, { recursive: true, force: true });
    }
  });

  it("schedules a bounded retry for codex transient upstream failures instead of blocking the issue immediately", async () => {
    mockAdapterExecute.mockResolvedValueOnce({
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "adapter_failed",
      errorFamily: "transient_upstream",
      errorMessage:
        "Error running remote compact task: We're currently experiencing high demand, which may cause temporary errors.",
      provider: "openai",
      model: "gpt-5.4",
      resultJson: {
        errorFamily: "transient_upstream",
      },
    });

    const { agentId, runId, issueId } = await seedQueuedIssueRunFixture();

    await heartbeat.resumeQueuedRuns();
    await waitForRunToSettle(heartbeat, runId);

    const runs = await waitForValue(async () => {
      const rows = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, agentId));
      return rows.length >= 2 ? rows : null;
    });
    expect(runs).toHaveLength(2);

    const failedRun = runs?.find((row) => row.id === runId);
    const retryRun = runs?.find((row) => row.id !== runId);
    expect(failedRun?.status).toBe("failed");
    expect(failedRun?.errorCode).toBe("adapter_failed");
    expect((failedRun?.resultJson as Record<string, unknown> | null)?.errorFamily).toBe("transient_upstream");
    expect(retryRun?.status).toBe("scheduled_retry");
    expect(retryRun?.scheduledRetryReason).toBe("transient_failure");
    expect(retryRun?.contextSnapshot).toMatchObject({
      codexTransientFallbackMode: "same_session",
    });
    expect(retryRun?.contextSnapshot as Record<string, unknown>).not.toHaveProperty("modelProfile");

    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("in_progress");
    expect(issue?.executionRunId).toBe(retryRun?.id ?? null);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(0);
  });

  it("schedules bounded retries for failed accepted interaction continuation wakes", async () => {
    const { companyId, agentId, runId, wakeupRequestId, issueId } = await seedQueuedIssueRunFixture();
    const interactionId = randomUUID();

    await db.insert(issueThreadInteractions).values({
      id: interactionId,
      companyId,
      issueId,
      kind: "request_confirmation",
      status: "accepted",
      continuationPolicy: "wake_assignee_on_accept",
      createdByAgentId: agentId,
      resolvedByUserId: "responsible-user",
      resolvedAt: new Date("2026-03-19T00:00:00.000Z"),
      payload: {
        version: 1,
        prompt: "Approve the plan?",
        target: {
          type: "issue_document",
          issueId,
          key: "plan",
          revisionId: randomUUID(),
        },
      },
      result: { version: 1, outcome: "accepted" },
    });

    await db
      .update(agentWakeupRequests)
      .set({
        source: "automation",
        reason: "issue_commented",
        payload: {
          issueId,
          interactionId,
          interactionKind: "request_confirmation",
          interactionStatus: "accepted",
          mutation: "interaction",
        },
      })
      .where(eq(agentWakeupRequests.id, wakeupRequestId));
    await db
      .update(heartbeatRuns)
      .set({
        invocationSource: "automation",
        contextSnapshot: {
          issueId,
          taskId: issueId,
          wakeReason: "issue_commented",
          mutation: "interaction",
          interactionId,
          interactionKind: "request_confirmation",
          interactionStatus: "accepted",
        },
      })
      .where(eq(heartbeatRuns.id, runId));
    await db
      .update(issues)
      .set({ status: "in_review" })
      .where(eq(issues.id, issueId));

    mockAdapterExecute.mockRejectedValueOnce(
      new Error('Failed to start command "codex" in "/workspace". Verify adapter command, working directory, and PATH.'),
    );

    const heartbeat = createHeartbeat();
    await heartbeat.resumeQueuedRuns();

    const runs = await waitForValue(async () => {
      const rows = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, agentId));
      return rows.length >= 2 ? rows : null;
    });
    expect(runs).toHaveLength(2);

    const failedRun = runs?.find((row) => row.id === runId);
    const retryRun = runs?.find((row) => row.id !== runId);
    expect(failedRun).toMatchObject({
      status: "failed",
      errorCode: "adapter_failed",
    });
    expect(retryRun).toMatchObject({
      status: "scheduled_retry",
      retryOfRunId: runId,
      scheduledRetryAttempt: 1,
      scheduledRetryReason: INTERACTION_CONTINUATION_INFRA_RETRY_REASON,
    });
    expect(retryRun?.contextSnapshot).toMatchObject({
      issueId,
      interactionId,
      interactionStatus: "accepted",
      retryReason: INTERACTION_CONTINUATION_INFRA_RETRY_REASON,
      wakeReason: INTERACTION_CONTINUATION_INFRA_WAKE_REASON,
      scheduledRetryAttempt: 1,
    });

    const wakeups = await db
      .select({
        id: agentWakeupRequests.id,
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        runId: agentWakeupRequests.runId,
        payload: agentWakeupRequests.payload,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakeups.find((row) => row.id === wakeupRequestId)).toMatchObject({
      status: "failed",
      reason: "issue_commented",
      runId,
    });
    expect(wakeups.find((row) => row.runId === retryRun?.id)).toMatchObject({
      status: "queued",
      reason: INTERACTION_CONTINUATION_INFRA_WAKE_REASON,
      payload: expect.objectContaining({
        issueId,
        interactionId,
        retryOfRunId: runId,
        retryReason: INTERACTION_CONTINUATION_INFRA_RETRY_REASON,
        scheduledRetryAttempt: 1,
      }),
    });

    const issue = await db
      .select({ status: issues.status, executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue).toEqual({
      status: "in_review",
      executionRunId: retryRun?.id ?? null,
    });

    const comments = await waitForValue(async () => {
      const rows = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
      return rows.length > 0 ? rows : null;
    });
    expect(comments).toHaveLength(1);
    expect(comments?.[0]).toMatchObject({
      authorType: "system",
      createdByRunId: runId,
      body: "Agent failed to resume after approval: `adapter_failed` — retrying (attempt 1/3)",
    });

    const interaction = await waitForValue(async () => {
      const row = await db
        .select({ result: issueThreadInteractions.result })
        .from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.id, interactionId))
        .then((rows) => rows[0] ?? null);
      const result = row?.result;
      return result && typeof result === "object" && "resumeFailure" in result ? row : null;
    });
    expect(interaction?.result).toMatchObject({
      version: 1,
      outcome: "accepted",
      resumeFailure: {
        status: "retrying",
        errorCode: "adapter_failed",
        attempt: 1,
        maxAttempts: 3,
        runId,
        retryRunId: retryRun?.id ?? null,
      },
    });
    mockAdapterExecute.mockClear();
  });

  it("escalates exhausted plan approval resume failures with a system comment and recovery action", async () => {
    const { companyId, agentId, runId, issueId } = await seedQueuedIssueRunFixture();
    const interactionId = randomUUID();

    await db.insert(issueThreadInteractions).values({
      id: interactionId,
      companyId,
      issueId,
      kind: "request_confirmation",
      status: "accepted",
      continuationPolicy: "wake_assignee_on_accept",
      createdByAgentId: agentId,
      resolvedByUserId: "responsible-user",
      resolvedAt: new Date("2026-03-19T00:00:00.000Z"),
      payload: {
        version: 1,
        prompt: "Approve the plan?",
        target: {
          type: "issue_document",
          issueId,
          key: "plan",
          revisionId: randomUUID(),
        },
      },
      result: { version: 1, outcome: "accepted" },
    });
    await db
      .update(heartbeatRuns)
      .set({
        status: "failed",
        error: "Failed to start command",
        errorCode: "adapter_failed",
        scheduledRetryAttempt: 3,
        scheduledRetryReason: INTERACTION_CONTINUATION_INFRA_RETRY_REASON,
        contextSnapshot: {
          issueId,
          taskId: issueId,
          wakeReason: INTERACTION_CONTINUATION_INFRA_WAKE_REASON,
          retryReason: INTERACTION_CONTINUATION_INFRA_RETRY_REASON,
          mutation: "interaction",
          interactionId,
          interactionKind: "request_confirmation",
          interactionStatus: "accepted",
        },
        finishedAt: new Date("2026-03-19T00:10:00.000Z"),
      })
      .where(eq(heartbeatRuns.id, runId));
    await db
      .update(issues)
      .set({ status: "in_review", executionRunId: runId })
      .where(eq(issues.id, issueId));

    const heartbeat = createHeartbeat();
    const result = await heartbeat.scheduleBoundedRetry(runId, {
      retryReason: INTERACTION_CONTINUATION_INFRA_RETRY_REASON,
      wakeReason: INTERACTION_CONTINUATION_INFRA_WAKE_REASON,
      maxAttempts: 3,
    });

    expect(result).toMatchObject({
      outcome: "retry_exhausted",
      maxAttempts: 3,
    });

    const issue = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("blocked");

    const recoveryAction = await db
      .select({ id: issueRecoveryActions.id, status: issueRecoveryActions.status, sourceIssueId: issueRecoveryActions.sourceIssueId })
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, issueId))
      .then((rows) => rows[0] ?? null);
    expect(recoveryAction).toMatchObject({
      status: "active",
      sourceIssueId: issueId,
    });

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({
      authorType: "system",
      body: expect.stringContaining("Agent failed to resume after approval: `adapter_failed` — needs attention"),
    });
    expect(comments[0]?.body).toContain("Recovery action:");

    const interaction = await db
      .select({ result: issueThreadInteractions.result })
      .from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, interactionId))
      .then((rows) => rows[0] ?? null);
    expect(interaction?.result).toMatchObject({
      version: 1,
      outcome: "accepted",
      resumeFailure: {
        status: "needs_attention",
        errorCode: "adapter_failed",
        attempt: 3,
        maxAttempts: 3,
        runId,
        recoveryActionId: recoveryAction?.id ?? null,
      },
    });
  });

  // Scenario 4: `process_lost` before the agent started is retried like
  // other infrastructure failures. Distinct from the pid-based process-loss retry
  // ("queues exactly one retry when the recorded local pid is dead"): here no pid was ever
  // recorded (the process died before producing output), so the reaper falls through to the
  // accepted-interaction infra-retry path. Pre-P1 `process_lost` was not retry-eligible there.
  it("retries a plan-approval continuation lost as process_lost before agent start as an infrastructure failure", async () => {
    const { companyId, agentId, runId, wakeupRequestId, issueId } = await seedQueuedIssueRunFixture();
    const interactionId = randomUUID();

    await db.insert(issueThreadInteractions).values({
      id: interactionId,
      companyId,
      issueId,
      kind: "request_confirmation",
      status: "accepted",
      continuationPolicy: "wake_assignee_on_accept",
      createdByAgentId: agentId,
      resolvedByUserId: "responsible-user",
      resolvedAt: new Date("2026-03-19T00:00:00.000Z"),
      payload: {
        version: 1,
        prompt: "Approve the plan?",
        target: { type: "issue_document", issueId, key: "plan", revisionId: randomUUID() },
      },
      result: { version: 1, outcome: "accepted" },
    });

    // The continuation wake was claimed and a run spawned, but the process was lost before
    // the agent produced any output — no pid/process-group was ever recorded.
    await db
      .update(agentWakeupRequests)
      .set({
        source: "automation",
        reason: "issue_commented",
        status: "claimed",
        payload: {
          issueId,
          interactionId,
          interactionKind: "request_confirmation",
          interactionStatus: "accepted",
          mutation: "interaction",
        },
      })
      .where(eq(agentWakeupRequests.id, wakeupRequestId));
    await db
      .update(heartbeatRuns)
      .set({
        status: "running",
        invocationSource: "automation",
        processPid: null,
        processGroupId: null,
        contextSnapshot: {
          issueId,
          taskId: issueId,
          wakeReason: "issue_commented",
          mutation: "interaction",
          interactionId,
          interactionKind: "request_confirmation",
          interactionStatus: "accepted",
        },
        startedAt: new Date("2026-03-19T00:00:00.000Z"),
        updatedAt: new Date("2026-03-19T00:00:00.000Z"),
      })
      .where(eq(heartbeatRuns.id, runId));
    await db.update(issues).set({ status: "in_review" }).where(eq(issues.id, issueId));

    const heartbeat = createHeartbeat();
    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(1);
    expect(result.runIds).toEqual([runId]);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(2);

    const failedRun = runs.find((row) => row.id === runId);
    const retryRun = runs.find((row) => row.id !== runId);
    expect(failedRun).toMatchObject({ status: "failed", errorCode: "process_lost" });
    expect(retryRun).toMatchObject({
      status: "scheduled_retry",
      retryOfRunId: runId,
      scheduledRetryAttempt: 1,
      scheduledRetryReason: INTERACTION_CONTINUATION_INFRA_RETRY_REASON,
    });
    expect(retryRun?.contextSnapshot).toMatchObject({
      issueId,
      interactionId,
      interactionStatus: "accepted",
      retryReason: INTERACTION_CONTINUATION_INFRA_RETRY_REASON,
      wakeReason: INTERACTION_CONTINUATION_INFRA_WAKE_REASON,
      scheduledRetryAttempt: 1,
    });

    const retryWakeup = await db
      .select({ reason: agentWakeupRequests.reason, status: agentWakeupRequests.status })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.runId, retryRun?.id ?? ""))
      .then((rows) => rows[0] ?? null);
    expect(retryWakeup?.reason).toBe(INTERACTION_CONTINUATION_INFRA_WAKE_REASON);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({
      authorType: "system",
      body: "Agent failed to resume after approval: `process_lost` — retrying (attempt 1/3)",
    });

    const interaction = await db
      .select({ result: issueThreadInteractions.result })
      .from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, interactionId))
      .then((rows) => rows[0] ?? null);
    expect(interaction?.result).toMatchObject({
      version: 1,
      outcome: "accepted",
      resumeFailure: {
        status: "retrying",
        errorCode: "process_lost",
        attempt: 1,
        maxAttempts: 3,
        runId,
        retryRunId: retryRun?.id ?? null,
      },
    });
    mockAdapterExecute.mockClear();
  });

  it("blocks a git-sensitive local adapter before launch when a project-workspace-linked issue is missing its project id", async () => {
    mockAdapterExecute.mockClear();
    const { companyId, agentId, runId, issueId } = await seedQueuedIssueRunFixture();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Paperclip App",
      status: "in_progress",
    });
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary workspace",
      sourceType: "local_path",
      cwd: `/tmp/paperclip-missing-workspace-${randomUUID()}`,
      isPrimary: true,
    });
    await db
      .update(issues)
      .set({
        title: "Launch from linked workspace without project id",
        identifier: `${issuePrefix}-1`,
        projectId: null,
        projectWorkspaceId,
      })
      .where(eq(issues.id, issueId));

    heartbeat = createHeartbeat({ penstockAvailabilityGate: allowPenstockGate });

    await heartbeat.resumeQueuedRuns();
    await waitForRunToSettle(heartbeat, runId, 15_000);

    expect(mockAdapterExecute).not.toHaveBeenCalled();

    const failedRun = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    expect(failedRun).toMatchObject({
      status: "failed",
      errorCode: "workspace_validation_failed",
    });
    expect(failedRun?.error).toContain("linked to a project workspace but has no project id");
    expect(failedRun?.resultJson).toMatchObject({
      workspaceValidation: {
        reason: "missing_project_id",
        adapterType: "codex_local",
        issueId,
        issueProjectId: null,
        issueProjectWorkspaceId: projectWorkspaceId,
      },
    });

    const issue = await waitForValue(async () =>
      db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => {
        const row = rows[0] ?? null;
        return row?.status === "blocked" ? row : null;
      }),
    );
    expect(issue?.executionRunId).toBeNull();

    const recoveryAction = await db
      .select()
      .from(issueRecoveryActions)
      .where(and(eq(issueRecoveryActions.companyId, companyId), eq(issueRecoveryActions.sourceIssueId, issueId)))
      .then((rows) => rows[0] ?? null);
    expect(recoveryAction).toMatchObject({
      kind: "workspace_validation",
      cause: "workspace_validation_failed",
      status: "active",
      ownerAgentId: agentId,
      recoveryIssueId: null,
    });
    expect(recoveryAction?.evidence).toMatchObject({
      sourceIssueId: issueId,
      latestRunId: runId,
      latestRunErrorCode: "workspace_validation_failed",
      recoveryCause: "workspace_validation_failed",
    });
    expect(recoveryAction?.nextAction).toContain("Repair the source issue workspace link");

    const validationComment = await waitForValue(async () => {
      const rows = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
      return rows.find((comment) => comment.body.includes("workspace failed validation")) ?? null;
    });
    expect(validationComment).toBeTruthy();
  });

  it("blocks before dispatch when a declared secret ref has no binding instead of emitting an opaque setup failure", async () => {
    const { companyId, agentId, runId, issueId } = await seedQueuedIssueRunFixture();
    const svc = secretService(db);
    const secretName = `unbound-runtime-${randomUUID()}`;
    const secret = await svc.create(companyId, {
      name: secretName,
      provider: "local_encrypted",
      value: "never-resolved",
    });
    // Declare the secret ref on the agent env WITHOUT creating a binding so the
    // pre-dispatch gate short-circuits to a configuration-incomplete blocker.
    await db
      .update(agents)
      .set({
        adapterConfig: {
          env: {
            UNBOUND_API_KEY: { type: "secret_ref", secretId: secret.id, version: "latest" },
          },
        },
      })
      .where(eq(agents.id, agentId));

    heartbeat = createHeartbeat({ penstockAvailabilityGate: allowPenstockGate });
    await heartbeat.resumeQueuedRuns();
    await waitForRunToSettle(heartbeat, runId, 5_000);

    expect(mockAdapterExecute).not.toHaveBeenCalled();

    const failedRun = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    expect(failedRun).toMatchObject({
      status: "failed",
      errorCode: "configuration_incomplete",
    });
    expect(failedRun?.error).toContain("configuration incomplete");
    expect(failedRun?.error).toContain(secretName);
    expect(failedRun?.error).toContain("env.UNBOUND_API_KEY");
    expect(failedRun?.resultJson).toMatchObject({
      configurationIncomplete: {
        reason: "secret_binding_missing",
        missingBindings: [
          {
            consumerType: "agent",
            consumerId: agentId,
            configPath: "env.UNBOUND_API_KEY",
            envKey: "UNBOUND_API_KEY",
            secretId: secret.id,
            secretName,
          },
        ],
      },
    });
    // Value-free gate: no secret access events were recorded.
    expect(await svc.listAccessEvents(companyId, secret.id)).toHaveLength(0);

    const issue = await waitForValue(async () =>
      db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => {
        const row = rows[0] ?? null;
        return row?.status === "blocked" ? row : null;
      }),
    );
    expect(issue?.executionRunId).toBeNull();

    const recoveryAction = await db
      .select()
      .from(issueRecoveryActions)
      .where(and(eq(issueRecoveryActions.companyId, companyId), eq(issueRecoveryActions.sourceIssueId, issueId)))
      .then((rows) => rows[0] ?? null);
    expect(recoveryAction).toMatchObject({
      kind: "configuration_validation",
      cause: "configuration_incomplete",
      status: "active",
      ownerAgentId: agentId,
      recoveryIssueId: null,
    });
    expect(recoveryAction?.nextAction).toContain("Bind the missing secret");

    const configurationComment = await waitForValue(async () => {
      const rows = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
      return rows.find((comment) => comment.body.includes("secret/env bindings are missing")) ?? null;
    });
    expect(configurationComment).toBeTruthy();
  });

  it("queues one finish-handoff wake when a successful run leaves in-progress work without a next action", async () => {
    const { companyId, agentId, runId, issueId } = await seedQueuedIssueRunFixture();
    mockAdapterExecute.mockImplementationOnce(async (ctx: { runId: string }) => {
      await db.insert(issueComments).values({
        companyId,
        issueId,
        authorAgentId: agentId,
        createdByRunId: ctx.runId,
        body: "Implemented the backend detector, but did not choose a final issue state.",
      });
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        summary: "Implemented the backend detector, but did not choose a final issue state.",
        resultJson: { summary: "Implemented the backend detector, but did not choose a final issue state." },
        provider: "test",
        model: "test-model",
      };
    });
    heartbeat = createHeartbeat({ penstockAvailabilityGate: allowPenstockGate });

    await heartbeat.resumeQueuedRuns();
    await waitForRunToSettle(heartbeat, runId, 5_000);

    const handoffWakeups = await waitForValue(async () => {
      const rows = await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.agentId, agentId));
      const matches = rows.filter((wakeup) => wakeup.reason === "finish_successful_run_handoff");
      return matches.length > 0 ? matches : null;
    }, 120_000);
    await waitForHeartbeatIdle(db, 5_000);

    expect(handoffWakeups).toHaveLength(1);
    expect(handoffWakeups[0]?.idempotencyKey).toBe(`finish_successful_run_handoff:${issueId}:${runId}:1`);
    expect(handoffWakeups[0]?.payload).toMatchObject({
      issueId,
      sourceRunId: runId,
      handoffRequired: true,
      handoffReason: "successful_run_missing_state",
      handoffAttempt: 1,
      maxHandoffAttempts: 1,
      resumeIntent: true,
      resumeFromRunId: runId,
    });

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    const handoffComment = comments.find((comment) => comment.body === SUCCESSFUL_RUN_HANDOFF_REQUIRED_NOTICE_BODY);
    expect(handoffComment).toBeTruthy();
    expect(handoffComment?.authorType).toBe("system");
    expect(handoffComment?.presentation).toMatchObject({
      kind: "system_notice",
      tone: "warning",
      detailsDefaultOpen: false,
    });
    expect(handoffComment?.metadata).toMatchObject({
      version: 1,
      sections: expect.arrayContaining([
        expect.objectContaining({
          title: "Required action",
          rows: expect.arrayContaining([
            expect.objectContaining({ type: "key_value", label: "Missing disposition", value: "clear_next_step" }),
          ]),
        }),
        expect.objectContaining({
          title: "Run evidence",
          rows: expect.arrayContaining([
            expect.objectContaining({ type: "run_link", runId }),
            expect.objectContaining({ type: "key_value", label: "Normalized cause", value: SUCCESSFUL_RUN_MISSING_STATE_REASON }),
          ]),
        }),
      ]),
    });

    const activity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId));
    expect(activity.some((event) => event.action === "issue.successful_run_handoff_required")).toBe(true);
  });

  it("requeues a missing-disposition handoff when the previous corrective wake was cancelled", async () => {
    const { companyId, agentId, runId, issueId } = await seedQueuedIssueRunFixture();
    const idempotencyKey = `finish_successful_run_handoff:${issueId}:${runId}:1`;
    await db.insert(agentWakeupRequests).values({
      id: randomUUID(),
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "finish_successful_run_handoff",
      payload: {
        issueId,
        sourceRunId: runId,
        handoffRequired: true,
        handoffReason: SUCCESSFUL_RUN_MISSING_STATE_REASON,
      },
      status: "cancelled",
      idempotencyKey,
      requestedAt: new Date("2026-03-19T00:00:01.000Z"),
      finishedAt: new Date("2026-03-19T00:00:02.000Z"),
      updatedAt: new Date("2026-03-19T00:00:02.000Z"),
    });
    mockAdapterExecute.mockImplementationOnce(async (ctx: { runId: string }) => {
      await db.insert(issueComments).values({
        companyId,
        issueId,
        authorAgentId: agentId,
        createdByRunId: ctx.runId,
        body: "Implemented recovery handling, but did not choose a final issue state.",
      });
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        summary: "Implemented recovery handling, but did not choose a final issue state.",
        resultJson: { summary: "Implemented recovery handling, but did not choose a final issue state." },
        provider: "test",
        model: "test-model",
      };
    });
    heartbeat = createHeartbeat({ penstockAvailabilityGate: allowPenstockGate });

    await heartbeat.resumeQueuedRuns();
    await waitForRunToSettle(heartbeat, runId, 5_000);

    const handoffWakeups = await waitForValue(async () => {
      const rows = await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.idempotencyKey, idempotencyKey));
      const requeued = rows.filter((wakeup) => wakeup.reason === "finish_successful_run_handoff");
      return requeued.length > 1 ? requeued : null;
    }, 120_000);
    await waitForHeartbeatIdle(db, 5_000);

    expect(handoffWakeups).toHaveLength(2);
    expect(handoffWakeups.filter((wakeup) => wakeup.status === "cancelled")).toHaveLength(1);
    expect(handoffWakeups.some((wakeup) => wakeup.status !== "cancelled")).toBe(true);
  });

  it("queues one missing-disposition handoff for artifact-producing successful runs left in progress", async () => {
    const { companyId, agentId, runId, issueId } = await seedQueuedIssueRunFixture();
    mockAdapterExecute.mockImplementationOnce(async (ctx: { runId: string }) => {
      const documentId = randomUUID();
      const revisionId = randomUUID();
      await db.insert(issueComments).values({
        companyId,
        issueId,
        authorAgentId: agentId,
        createdByRunId: ctx.runId,
        body: "Drafted the Phase 3 test plan but did not choose a final issue disposition.",
      });
      await db.insert(documents).values({
        id: documentId,
        companyId,
        title: "Regression test plan",
        format: "markdown",
        latestBody: "# Regression test plan\n\n- Cover artifact-producing successful runs",
        latestRevisionId: revisionId,
        latestRevisionNumber: 1,
        createdByAgentId: agentId,
        updatedByAgentId: agentId,
      });
      await db.insert(documentRevisions).values({
        id: revisionId,
        companyId,
        documentId,
        revisionNumber: 1,
        title: "Regression test plan",
        format: "markdown",
        body: "# Regression test plan\n\n- Cover artifact-producing successful runs",
        createdByAgentId: agentId,
        createdByRunId: ctx.runId,
      });
      await db.insert(issueDocuments).values({
        companyId,
        issueId,
        documentId,
        key: "plan",
      });
      await db.insert(issueWorkProducts).values({
        companyId,
        issueId,
        type: "report",
        provider: "test",
        externalId: "phase-3-report",
        title: "Phase 3 regression notes",
        status: "ready",
        summary: "Successful run produced a visible artifact.",
        createdByRunId: ctx.runId,
      });
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        summary: "Created comments, a plan document, and a work product without choosing a disposition.",
        resultJson: {
          summary: "Created comments, a plan document, and a work product without choosing a disposition.",
        },
        provider: "test",
        model: "test-model",
      };
    });
    heartbeat = createHeartbeat({ penstockAvailabilityGate: allowPenstockGate });

    await heartbeat.resumeQueuedRuns();
    const settledRun = await waitForRunToSettle(heartbeat, runId, 5_000);

    const handoffWakeups = await waitForValue(async () => {
      const rows = await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.agentId, agentId));
      const matches = rows.filter((wakeup) => wakeup.reason === "finish_successful_run_handoff");
      return matches.length > 0 ? matches : null;
    }, 120_000);
    await waitForHeartbeatIdle(db, 5_000);
    const classifiedRun = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);

    expect(classifiedRun?.status ?? settledRun?.status).toBe("succeeded");
    expect(classifiedRun?.livenessState).toBe("advanced");
    expect(handoffWakeups).toHaveLength(1);
    expect(handoffWakeups[0]?.idempotencyKey).toBe(`finish_successful_run_handoff:${issueId}:${runId}:1`);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("in_progress");
    await expect(sourceBlockerIssueIds(companyId, issueId)).resolves.toEqual([]);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments.filter((comment) => comment.body === SUCCESSFUL_RUN_HANDOFF_REQUIRED_NOTICE_BODY)).toHaveLength(1);
    expect(comments.some((comment) => comment.body.startsWith("Drafted the Phase 3 test plan"))).toBe(true);

    const workProducts = await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.issueId, issueId));
    expect(workProducts).toHaveLength(1);
    const recoveryIssues = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stranded_issue_recovery")));
    expect(recoveryIssues).toHaveLength(0);
  });

  it("redacts secret-bearing successful-run detected progress before handoff disclosure", async () => {
    const { agentId, runId, issueId } = await seedQueuedIssueRunFixture();
    const bearerSecret = "live-bearer-token-value";
    const apiKeySecret = "sk-testsuccessfulhandoffsecret";
    const redactedDetectedSummary = redactDetectedSuccessfulRunProgressSummaryForBoard(
      `Next action noted: Authorization: Bearer ${bearerSecret} OPENAI_API_KEY=${apiKeySecret}`,
      { enabled: false },
    );
    expect(redactedDetectedSummary).toContain("***REDACTED***");
    expect(redactedDetectedSummary).not.toContain(bearerSecret);
    expect(redactedDetectedSummary).not.toContain(apiKeySecret);

    mockAdapterExecute.mockResolvedValueOnce({
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      summary: "Made progress but left the issue open.",
      resultJson: {
        message: `Next action: Authorization: Bearer ${bearerSecret} OPENAI_API_KEY=${apiKeySecret}`,
      },
      provider: "test",
      model: "test-model",
    });
    heartbeat = createHeartbeat({ penstockAvailabilityGate: allowPenstockGate });

    await heartbeat.resumeQueuedRuns();
    await waitForRunToSettle(heartbeat, runId, 5_000);

    const handoffWakeups = await waitForValue(async () => {
      const rows = await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.agentId, agentId));
      const matches = rows.filter((wakeup) => wakeup.reason === "finish_successful_run_handoff");
      return matches.length > 0 ? matches : null;
    }, 120_000);
    await waitForHeartbeatIdle(db, 5_000);

    expect(handoffWakeups).toHaveLength(1);
    const wakeupPayloadText = JSON.stringify(handoffWakeups[0]?.payload ?? {});
    expect(wakeupPayloadText).not.toContain(bearerSecret);
    expect(wakeupPayloadText).not.toContain(apiKeySecret);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    const handoffComment = comments.find((comment) => comment.body === SUCCESSFUL_RUN_HANDOFF_REQUIRED_NOTICE_BODY);
    expect(handoffComment).toBeTruthy();
    expect(handoffComment?.body).not.toContain(bearerSecret);
    expect(handoffComment?.body).not.toContain(apiKeySecret);
    expect(JSON.stringify(handoffComment?.metadata ?? {})).not.toContain(bearerSecret);
    expect(JSON.stringify(handoffComment?.metadata ?? {})).not.toContain(apiKeySecret);

    const activity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId));
    const handoffActivity = activity.find((event) => event.action === "issue.successful_run_handoff_required");
    expect(handoffActivity).toBeTruthy();
    const activityDetailsText = JSON.stringify(handoffActivity?.details ?? {});
    expect(activityDetailsText).not.toContain(bearerSecret);
    expect(activityDetailsText).not.toContain(apiKeySecret);
  });

  it("escalates an exhausted failed successful-run handoff without using generic continuation recovery first", async () => {
    const { companyId, agentId, runId, issueId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "failed",
      runErrorCode: "adapter_failed",
      runError: "Authorization: Bearer sk-test-successful-handoff-secret",
    });
    const sourceRunId = randomUUID();
    await db
      .update(heartbeatRuns)
      .set({
        contextSnapshot: {
          issueId,
          taskId: issueId,
          wakeReason: "finish_successful_run_handoff",
          sourceRunId,
          resumeFromRunId: sourceRunId,
          handoffRequired: true,
          handoffReason: "successful_run_missing_state",
          missingDisposition: "clear_next_step",
          handoffAttempt: 1,
          maxHandoffAttempts: 1,
        },
      })
      .where(eq(heartbeatRuns.id, runId));
    heartbeat = createHeartbeat({ penstockAvailabilityGate: allowPenstockGate });

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.continuationRequeued).toBe(0);
    expect(result.escalated).toBe(0);
    expect(result.successfulRunHandoffEscalated).toBe(1);
    expect(result.issueIds).toEqual([issueId]);

    const recoveryAction = await expectSourceScopedStrandedRecoveryAction({
      companyId,
      agentId,
      issueId,
      runId,
      previousStatus: "in_progress",
      retryReason: null,
      cause: SUCCESSFUL_RUN_MISSING_STATE_REASON,
      kind: "missing_disposition",
    });
    expect(recoveryAction.evidence).toMatchObject({
      sourceRunId,
      missingDisposition: "clear_next_step",
      latestRunStatus: "failed",
      latestRunErrorCode: "adapter_failed",
      recoveryCause: SUCCESSFUL_RUN_MISSING_STATE_REASON,
    });
    expect(JSON.stringify(recoveryAction.evidence)).not.toContain("sk-test-successful-handoff-secret");

    const sourceIssue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(sourceIssue?.status).toBe("blocked");
    await expect(sourceBlockerIssueIds(companyId, issueId)).resolves.toEqual([]);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments[0]?.body).toBe(SUCCESSFUL_RUN_HANDOFF_EXHAUSTED_NOTICE_BODY);
    expect(comments[0]?.authorType).toBe("system");
    expect(comments[0]?.presentation).toMatchObject({
      kind: "system_notice",
      tone: "danger",
      detailsDefaultOpen: false,
    });
    expect(comments[0]?.metadata).toMatchObject({
      version: 1,
      sections: expect.arrayContaining([
        expect.objectContaining({
          title: "Recovery owner",
          rows: expect.arrayContaining([
            expect.objectContaining({ type: "key_value", label: "Recovery action", value: recoveryAction.id }),
            expect.objectContaining({ type: "agent_link", label: "Recovery owner", name: "CodexCoder" }),
          ]),
        }),
        expect.objectContaining({
          title: "Run evidence",
          rows: expect.arrayContaining([
            expect.objectContaining({ type: "key_value", label: "Normalized cause", value: SUCCESSFUL_RUN_MISSING_STATE_REASON }),
            expect.objectContaining({ type: "key_value", label: "Missing disposition", value: "clear_next_step" }),
          ]),
        }),
      ]),
    });
    expect(comments[0]?.body).not.toContain("sk-test-successful-handoff-secret");
    expect(JSON.stringify(comments[0]?.metadata ?? {})).not.toContain("sk-test-successful-handoff-secret");

    const activity = await db.select().from(activityLog).where(eq(activityLog.entityId, issueId));
    expect(activity.some((event) => event.action === "issue.successful_run_handoff_escalated")).toBe(true);
  });

  it("escalates an exhausted successful handoff run that still leaves no disposition", async () => {
    const { companyId, agentId, runId, issueId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "succeeded",
      livenessState: "advanced",
    });
    const sourceRunId = randomUUID();
    await db
      .update(heartbeatRuns)
      .set({
        contextSnapshot: {
          issueId,
          taskId: issueId,
          wakeReason: "finish_successful_run_handoff",
          sourceRunId,
          resumeFromRunId: sourceRunId,
          handoffRequired: true,
          handoffReason: "successful_run_missing_state",
          missingDisposition: "clear_next_step",
          handoffAttempt: 1,
          maxHandoffAttempts: 1,
        },
      })
      .where(eq(heartbeatRuns.id, runId));
    heartbeat = createHeartbeat({ penstockAvailabilityGate: allowPenstockGate });

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.continuationRequeued).toBe(0);
    expect(result.successfulContinuationObserved).toBe(0);
    expect(result.successfulRunHandoffEscalated).toBe(1);

    const recoveryAction = await expectSourceScopedStrandedRecoveryAction({
      companyId,
      agentId,
      issueId,
      runId,
      previousStatus: "in_progress",
      retryReason: null,
      cause: SUCCESSFUL_RUN_MISSING_STATE_REASON,
      kind: "missing_disposition",
    });
    expect(recoveryAction.evidence).toMatchObject({
      sourceRunId,
      latestRunStatus: "succeeded",
      missingDisposition: "clear_next_step",
    });
  });

  it("converts a continuation parked for review into a dependency wait on its open sub-tasks", async () => {
    const { companyId, agentId, issueId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "cancelled",
      retryReason: "issue_continuation_needed",
      runErrorCode: "issue_continuation_waiting_on_review",
      runError: "Continuation parked: issue is waiting on review/approval",
    });
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const openChildTodoId = randomUUID();
    const openChildInProgressId = randomUUID();
    const doneChildId = randomUUID();

    await db.insert(issues).values([
      {
        id: openChildTodoId,
        companyId,
        parentId: issueId,
        title: "Sub-task still to do",
        status: "todo",
        priority: "medium",
        issueNumber: 10,
        identifier: `${issuePrefix}-10`,
      },
      {
        id: openChildInProgressId,
        companyId,
        parentId: issueId,
        title: "Sub-task in progress",
        status: "in_progress",
        priority: "medium",
        issueNumber: 11,
        identifier: `${issuePrefix}-11`,
      },
      {
        id: doneChildId,
        companyId,
        parentId: issueId,
        title: "Sub-task already finished",
        status: "done",
        priority: "medium",
        issueNumber: 12,
        identifier: `${issuePrefix}-12`,
      },
    ]);

    heartbeat = createHeartbeat({ penstockAvailabilityGate: allowPenstockGate });
    const result = await heartbeat.reconcileStrandedAssignedIssues();

    expect(result.waitingOnReviewResolved).toBe(1);
    expect(result.escalated).toBe(0);
    expect(result.issueIds).toEqual([issueId]);

    const umbrella = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(umbrella?.status).toBe("blocked");
    // Original assignee is preserved — no reassignment to a recovery owner.
    expect(umbrella?.assigneeAgentId).toBe(agentId);

    // Only the open children become first-class blockers; the done child is excluded.
    const blockers = await sourceBlockerIssueIds(companyId, issueId);
    expect(blockers.sort()).toEqual([openChildTodoId, openChildInProgressId].sort());

    // No stranded-recovery action/issue is opened for a deliberate wait.
    const recoveryIssues = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stranded_issue_recovery")));
    expect(recoveryIssues).toHaveLength(0);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.authorType).toBe("system");
    expect(comments[0]?.body).toContain("This task is waiting on");
    expect(comments[0]?.body).toContain("continue automatically");
    expect(comments[0]?.body).toContain(`${issuePrefix}-10`);
    expect(comments[0]?.body).toContain(`${issuePrefix}-11`);
    expect(comments[0]?.body).not.toContain(`${issuePrefix}-12`);
    // Plain language — the raw machine error code never leaks into the thread.
    expect(comments[0]?.body).not.toContain("issue_continuation_waiting_on_review");

    const activity = await db.select().from(activityLog).where(eq(activityLog.entityId, issueId));
    expect(
      activity.some(
        (event) =>
          event.action === "issue.updated" &&
          (event.details as { source?: string } | null)?.source ===
            "recovery.reconcile_continuation_waiting_on_review",
      ),
    ).toBe(true);
  });

  it("parks a review-waiting continuation when an open child blocker would create a cycle", async () => {
    const { companyId, agentId, issueId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "cancelled",
      retryReason: "issue_continuation_needed",
      runErrorCode: "issue_continuation_waiting_on_review",
      runError: "Continuation parked: issue is waiting on review/approval",
    });
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const openChildId = randomUUID();

    await db.insert(issues).values({
      id: openChildId,
      companyId,
      parentId: issueId,
      title: "Child already blocked by parent",
      status: "todo",
      priority: "medium",
      issueNumber: 10,
      identifier: `${issuePrefix}-10`,
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId,
      relatedIssueId: openChildId,
      type: "blocks",
    });

    heartbeat = createHeartbeat({ penstockAvailabilityGate: allowPenstockGate });
    const result = await heartbeat.reconcileStrandedAssignedIssues();

    expect(result.waitingOnReviewResolved).toBe(0);
    expect(result.reviewWaitingParked).toBe(1);
    expect(result.escalated).toBe(0);
    expect(result.issueIds).toEqual([issueId]);

    const parked = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(parked?.status).toBe("in_review");
    expect(parked?.assigneeAgentId).toBe(agentId);

    await expect(sourceBlockerIssueIds(companyId, issueId)).resolves.toEqual([]);
    await expect(sourceBlockerIssueIds(companyId, openChildId)).resolves.toEqual([issueId]);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.authorType).toBe("system");
    expect(comments[0]?.body).toContain("review/approval");
    expect(comments[0]?.body).not.toContain(`${issuePrefix}-10`);
    expect(comments[0]?.body).not.toContain("issue_continuation_waiting_on_review");
  });

  it("parks a review-waiting continuation in_review when the blocker write races a concurrent cycle-forming relation", async () => {
    const { companyId, agentId, issueId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "cancelled",
      retryReason: "issue_continuation_needed",
      runErrorCode: "issue_continuation_waiting_on_review",
      runError: "Continuation parked: issue is waiting on review/approval",
    });
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const openChildId = randomUUID();

    await db.insert(issues).values({
      id: openChildId,
      companyId,
      parentId: issueId,
      title: "Child not yet blocked by parent",
      status: "todo",
      priority: "medium",
      issueNumber: 10,
      identifier: `${issuePrefix}-10`,
    });
    // No reverse `blocks` relation is seeded, so the recovery reachability check
    // (findCycleFormingBlockerIssueIds) will not flag openChildId as cycle-forming - it
    // only sees a cycle at write time, simulating a relation update that lands between
    // the check and the write. The real write-time check (assertNoBlockingCycles) runs
    // inside issuesSvc.update's db.transaction(), so the fault is injected on the first
    // transaction the reconcile pass opens rather than on db.update directly (that
    // transaction's tx.update/tx.select calls are a separate client, invisible to a
    // db.update spy).
    const transactionSpy = vi.spyOn(db, "transaction");
    let cycleErrorThrown = false;
    transactionSpy.mockImplementationOnce(async () => {
      cycleErrorThrown = true;
      throw new Error("Blocking relations cannot contain cycles");
    });

    heartbeat = createHeartbeat({ penstockAvailabilityGate: allowPenstockGate });
    let result: Awaited<ReturnType<typeof heartbeat.reconcileStrandedAssignedIssues>>;
    try {
      result = await heartbeat.reconcileStrandedAssignedIssues();
    } finally {
      transactionSpy.mockRestore();
    }

    expect(cycleErrorThrown).toBe(true);
    expect(result.waitingOnReviewResolved).toBe(0);
    expect(result.reviewWaitingParked).toBe(1);
    expect(result.escalated).toBe(0);
    expect(result.issueIds).toEqual([issueId]);

    const parked = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(parked?.status).toBe("in_review");
    expect(parked?.assigneeAgentId).toBe(agentId);

    await expect(sourceBlockerIssueIds(companyId, issueId)).resolves.toEqual([]);
  });

  it("converts a continuation parked for review into a dependency wait on its existing blockers", async () => {
    const { companyId, agentId, issueId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "cancelled",
      retryReason: "issue_continuation_needed",
      runErrorCode: "issue_continuation_waiting_on_review",
      runError: "Continuation parked: issue is waiting on review/approval",
    });
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const openBlockerId = randomUUID();
    const doneBlockerId = randomUUID();

    await db.insert(issues).values([
      {
        id: openBlockerId,
        companyId,
        title: "Blocking issue still open",
        status: "in_progress",
        priority: "medium",
        issueNumber: 20,
        identifier: `${issuePrefix}-20`,
      },
      {
        id: doneBlockerId,
        companyId,
        title: "Blocking issue already finished",
        status: "done",
        priority: "medium",
        issueNumber: 21,
        identifier: `${issuePrefix}-21`,
      },
    ]);
    await db.insert(issueRelations).values([
      { companyId, issueId: openBlockerId, relatedIssueId: issueId, type: "blocks" },
      { companyId, issueId: doneBlockerId, relatedIssueId: issueId, type: "blocks" },
    ]);

    heartbeat = createHeartbeat({ penstockAvailabilityGate: allowPenstockGate });
    const result = await heartbeat.reconcileStrandedAssignedIssues();

    expect(result.waitingOnReviewResolved).toBe(1);
    expect(result.escalated).toBe(0);
    expect(result.issueIds).toEqual([issueId]);

    const blocked = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(blocked?.status).toBe("blocked");
    expect(blocked?.assigneeAgentId).toBe(agentId);

    // Only the still-open blocker is carried over; the resolved one is excluded.
    const blockers = await sourceBlockerIssueIds(companyId, issueId);
    expect(blockers).toEqual([openBlockerId]);

    const recoveryIssues = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stranded_issue_recovery")));
    expect(recoveryIssues).toHaveLength(0);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.authorType).toBe("system");
    expect(comments[0]?.body).toContain("This task is waiting on");
    expect(comments[0]?.body).toContain("continue automatically");
    // The blocker's real identifier is linked — not the "another open issue" fallback.
    expect(comments[0]?.body).toContain(`${issuePrefix}-20`);
    expect(comments[0]?.body).not.toContain("another open issue");
    expect(comments[0]?.body).not.toContain(`${issuePrefix}-21`);
    expect(comments[0]?.body).not.toContain("issue_continuation_waiting_on_review");
  });

  it("parks a review-waiting continuation in_review when no open dependency remains", async () => {
    const { companyId, agentId, issueId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "cancelled",
      retryReason: "issue_continuation_needed",
      runErrorCode: "issue_continuation_waiting_on_review",
      runError: "Continuation parked: issue is waiting on review/approval",
    });

    heartbeat = createHeartbeat({ penstockAvailabilityGate: allowPenstockGate });
    const result = await heartbeat.reconcileStrandedAssignedIssues();

    // BLO-16146: a deliberate review/approval wait with no dependency to point a
    // `blocked` state at and no active monitor path must be parked `in_review` — the
    // designated "waiting on a reviewer/approver" status — not escalated to `blocked`
    // as if its live execution were lost, and not converted into a dependency wait
    // (there is nothing to depend on). The dependency-wait conversion must not fire.
    expect(result.waitingOnReviewResolved).toBe(0);
    expect(result.reviewWaitingParked).toBe(1);
    expect(result.escalated).toBe(0);
    expect(result.issueIds).toEqual([issueId]);

    const parked = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(parked?.status).toBe("in_review");
    // Original assignee is preserved — no reassignment to a recovery owner.
    expect(parked?.assigneeAgentId).toBe(agentId);

    // No blockers are fabricated for a dependency-less wait.
    await expect(sourceBlockerIssueIds(companyId, issueId)).resolves.toEqual([]);

    // No stranded-recovery issue is opened for a deliberate wait.
    const recoveryIssues = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stranded_issue_recovery")));
    expect(recoveryIssues).toHaveLength(0);

    // A plain-language system comment explains the wait; the raw machine error code
    // never leaks into the thread.
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.authorType).toBe("system");
    expect(comments[0]?.body).toContain("review/approval");
    expect(comments[0]?.body).not.toContain("issue_continuation_waiting_on_review");

    const activity = await db.select().from(activityLog).where(eq(activityLog.entityId, issueId));
    expect(
      activity.some(
        (event) =>
          event.action === "issue.updated" &&
          (event.details as { source?: string } | null)?.source ===
            "recovery.reconcile_review_waiting_no_dependency_park",
      ),
    ).toBe(true);
  });

  it(
    "BLO-18643: does not re-escalate a review-waiting park to blocked when its monitor already " +
      "fired and was never rescheduled",
    async () => {
      const { companyId, agentId, issueId } = await seedStrandedIssueFixture({
        status: "in_progress",
        runStatus: "cancelled",
        retryReason: "issue_continuation_needed",
        runErrorCode: "issue_continuation_waiting_on_review",
        runError: "Continuation parked: issue is waiting on review/approval",
      });

      // Replay BLO-18614's exact monitor shape: the monitor already fired
      // (`status: "triggered"`) and was never rescheduled (`monitorNextCheckAt: null`).
      await db
        .update(issues)
        .set({
          monitorNextCheckAt: null,
          monitorLastTriggeredAt: new Date("2026-07-29T03:52:37.000Z"),
          monitorAttemptCount: 1,
          monitorScheduledBy: "assignee",
          monitorNotes: "PR #806 (Blockcast/paperclip): watching for CI green + Ally review decision before merge.",
        })
        .where(eq(issues.id, issueId));

      heartbeat = createHeartbeat({ penstockAvailabilityGate: allowPenstockGate });

      const firstResult = await heartbeat.reconcileStrandedAssignedIssues();
      expect(firstResult.reviewWaitingParked).toBe(1);
      expect(firstResult.escalated).toBe(0);
      expect(firstResult.issueIds).toEqual([issueId]);

      const parked = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
      expect(parked?.status).toBe("in_review");
      expect(parked?.assigneeAgentId).toBe(agentId);

      // Simulate the next sweep tick (BLO-18614 recurred 21s later) finding the same
      // now-`in_review` issue with the same cancelled/waiting-on-review latest run: it
      // must be a no-op, not a second, clobbering escalation to `blocked`.
      const secondResult = await heartbeat.reconcileStrandedAssignedIssues();
      expect(secondResult.escalated).toBe(0);
      expect(secondResult.reviewWaitingParked).toBe(0);
      expect(secondResult.issueIds).not.toContain(issueId);

      const stillParked = await db
        .select()
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null);
      expect(stillParked?.status).toBe("in_review");
      await expect(sourceBlockerIssueIds(companyId, issueId)).resolves.toEqual([]);

      // No recovery action or recovery issue was ever created for this deliberate wait.
      const recoveryActions = await db
        .select()
        .from(issueRecoveryActions)
        .where(and(eq(issueRecoveryActions.companyId, companyId), eq(issueRecoveryActions.sourceIssueId, issueId)));
      expect(recoveryActions).toHaveLength(0);

      const recoveryIssues = await db
        .select()
        .from(issues)
        .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stranded_issue_recovery")));
      expect(recoveryIssues).toHaveLength(0);

      // The monitor is now recognized as an active watch, so the park goes through the
      // monitor-path branch (which relies on the monitor's own visible notes rather than
      // posting a redundant comment) -- not the no-monitor fallback. Either way, no
      // escalation comment ever lands on the thread.
      const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
      for (const comment of comments) {
        expect(comment.body).not.toContain("Moving it to `blocked`");
      }

      const activity = await db.select().from(activityLog).where(eq(activityLog.entityId, issueId));
      expect(
        activity.some(
          (event) =>
            event.action === "issue.updated" &&
            (event.details as { source?: string } | null)?.source ===
              "recovery.reconcile_review_waiting_continuation",
        ),
      ).toBe(true);
      expect(
        activity.some((event) => (event.details as { status?: string } | null)?.status === "blocked"),
      ).toBe(false);
    },
  );

  it(
    "BLO-18669: a genuine review-park failure still escalates to blocked",
    async () => {
      const { companyId, issueId } = await seedStrandedIssueFixture({
        status: "in_progress",
        runStatus: "cancelled",
        retryReason: "issue_continuation_needed",
        runErrorCode: "issue_continuation_waiting_on_review",
        runError: "Continuation parked: issue is waiting on review/approval",
      });

      // The "pr" evidence shape requires a PR link. Leaving it absent makes the
      // `in_review` transition throw from the evidence gate; this is a true
      // park failure, not the already-parked race.
      const labelId = randomUUID();
      await db.insert(labels).values({ id: labelId, companyId, name: "pr", color: "#000000" });
      await db.insert(issueLabels).values({ issueId, labelId, companyId });

      heartbeat = createHeartbeat({ penstockAvailabilityGate: allowPenstockGate });

      const result = await heartbeat.reconcileStrandedAssignedIssues();
      expect(result.reviewWaitingParked).toBe(0);
      expect(result.escalated).toBe(1);
      expect(result.issueIds).toEqual([issueId]);

      const escalated = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
      expect(escalated?.status).toBe("blocked");

      const recoveryActions = await db
        .select()
        .from(issueRecoveryActions)
        .where(and(eq(issueRecoveryActions.companyId, companyId), eq(issueRecoveryActions.sourceIssueId, issueId)));
      expect(recoveryActions).toHaveLength(1);
    },
  );

  // BLO-16182: process_lost is reclassified as transient_infra (3 attempts +
  // 60s backoff). These two guard the COMBINED attempt cap end-to-end through
  // reconcileStrandedAssignedIssues: the continuation sweep and the in-reaper
  // enqueueProcessLossRetry must share one budget.
  async function seedPriorProcessLostRun(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    retryReason: "issue_continuation_needed" | "process_lost";
    createdAt: Date;
    processLossRetryCount?: number;
  }) {
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "failed",
      errorCode: "process_lost",
      error: "Process lost before external adapter invocation -- server may have restarted",
      contextSnapshot: { issueId: input.issueId, retryReason: input.retryReason },
      processLossRetryCount: input.processLossRetryCount ?? 0,
      createdAt: input.createdAt,
      startedAt: input.createdAt,
      finishedAt: new Date(input.createdAt.getTime() + 1_000),
      updatedAt: new Date(input.createdAt.getTime() + 1_000),
    });
  }

  it("escalates a process_lost issue at the COMBINED budget: 2 continuation + 1 in-reaper retry (BLO-16182)", async () => {
    // Latest run is a continuation retry (the sweep classifies it); history adds
    // one earlier continuation retry + one in-reaper process_lost retry. All three
    // process_lost. Combined = 3 >= maxAttempts(3) → escalate, NOT a fresh 3.
    const { companyId, agentId, issueId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "failed",
      retryReason: "issue_continuation_needed",
      runErrorCode: "process_lost",
      runError: "Process lost before external adapter invocation -- server may have restarted",
    });
    await seedPriorProcessLostRun({
      companyId,
      agentId,
      issueId,
      retryReason: "issue_continuation_needed",
      createdAt: new Date("2026-03-18T00:02:00.000Z"),
    });
    await seedPriorProcessLostRun({
      companyId,
      agentId,
      issueId,
      retryReason: "process_lost", // in-reaper enqueueProcessLossRetry (engine B)
      processLossRetryCount: 1,
      createdAt: new Date("2026-03-18T00:00:00.000Z"),
    });

    heartbeat = createHeartbeat({ penstockAvailabilityGate: allowPenstockGate });
    const result = await heartbeat.reconcileStrandedAssignedIssues();

    expect(result.escalated).toBe(1);
    expect(result.continuationRequeued).toBe(0);
    const issue = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("blocked");
  });

  it("still grants process_lost its full transient budget before escalating: 2 continuation retries → requeue (BLO-16182)", async () => {
    // Reclassify gives 3 attempts; with only 2 consecutive continuation retries
    // (and no in-reaper retry) the sweep must re-dispatch, not escalate.
    const { companyId, agentId, issueId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "failed",
      retryReason: "issue_continuation_needed",
      runErrorCode: "process_lost",
      runError: "Process lost before external adapter invocation -- server may have restarted",
    });
    await seedPriorProcessLostRun({
      companyId,
      agentId,
      issueId,
      retryReason: "issue_continuation_needed",
      createdAt: new Date("2026-03-18T00:00:00.000Z"),
    });

    heartbeat = createHeartbeat({ penstockAvailabilityGate: allowPenstockGate });
    const result = await heartbeat.reconcileStrandedAssignedIssues();

    expect(result.escalated).toBe(0);
    expect(result.continuationRequeued).toBe(1);
    const issue = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("in_progress");
  });

  it("escalates when the LATEST terminal run is the in-reaper (engine B) process_lost retry (BLO-16182)", async () => {
    // The combined cap must ENTER even when the newest run is engine B's retry
    // (retryReason 'process_lost'), not only when a continuation run is latest —
    // otherwise that interleaving skips the cap and re-dispatches uncapped.
    const { companyId, agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "failed",
      retryReason: "issue_continuation_needed",
      runErrorCode: "process_lost",
      runError: "Process lost before external adapter invocation -- server may have restarted",
    });
    // Re-anchor the fixture's continuation run as the OLDEST in the chain.
    await db
      .update(heartbeatRuns)
      .set({
        createdAt: new Date("2026-03-18T00:00:00.000Z"),
        finishedAt: new Date("2026-03-18T00:00:30.000Z"),
      })
      .where(eq(heartbeatRuns.id, runId));
    // A middle continuation retry, then the in-reaper engine-B retry as the NEWEST.
    await seedPriorProcessLostRun({
      companyId,
      agentId,
      issueId,
      retryReason: "issue_continuation_needed",
      createdAt: new Date("2026-03-18T00:01:00.000Z"),
    });
    await seedPriorProcessLostRun({
      companyId,
      agentId,
      issueId,
      retryReason: "process_lost", // engine B; newest → becomes latestRun
      processLossRetryCount: 1,
      createdAt: new Date("2026-03-18T00:02:00.000Z"),
    });

    heartbeat = createHeartbeat({ penstockAvailabilityGate: allowPenstockGate });
    const result = await heartbeat.reconcileStrandedAssignedIssues();

    // Combined budget = 3 (2 continuation + 1 engine-B) → escalate, not a fresh 3.
    expect(result.escalated).toBe(1);
    expect(result.continuationRequeued).toBe(0);
    const issue = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("blocked");
  });

  it("defers a process_lost continuation still inside its 60s backoff window instead of re-dispatching (BLO-16182)", async () => {
    // One continuation attempt (consecutive=1 < 3) that JUST finished: the
    // transient 60s backoff must hold the re-dispatch, proving the reclassify's
    // backoff half actually throttles (not merely caps) the storm.
    const { issueId, runId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "failed",
      retryReason: "issue_continuation_needed",
      runErrorCode: "process_lost",
      runError: "Process lost before external adapter invocation -- server may have restarted",
    });
    await db
      .update(heartbeatRuns)
      .set({ finishedAt: new Date(Date.now() - 5_000) })
      .where(eq(heartbeatRuns.id, runId));

    heartbeat = createHeartbeat({ penstockAvailabilityGate: allowPenstockGate });
    const result = await heartbeat.reconcileStrandedAssignedIssues();

    // Deferred by backoff — neither escalated nor re-dispatched this tick.
    expect(result.escalated).toBe(0);
    expect(result.continuationRequeued).toBe(0);
    const issue = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("in_progress");
  });

  it("clears the detached warning when the run reports activity again", async () => {
    const { runId } = await seedRunFixture({
      includeIssue: false,
      runErrorCode: "process_detached",
      runError: "Lost in-memory process handle, but child pid 123 is still alive",
    });

    const updated = await heartbeat.reportRunActivity(runId);
    expect(updated?.errorCode).toBeNull();
    expect(updated?.error).toBeNull();

    const run = await heartbeat.getRun(runId);
    expect(run?.errorCode).toBeNull();
    expect(run?.error).toBeNull();
  });

  it("tracks the first heartbeat with the agent role instead of adapter type", async () => {
    const { agentId, runId } = await seedRunFixture({
      agentStatus: "running",
      includeIssue: false,
    });

    await heartbeat.cancelRun(runId);

    expect(mockTrackAgentFirstHeartbeat).toHaveBeenCalledWith(
      mockTelemetryClient,
      expect.objectContaining({
        agentRole: "engineer",
        agentId,
      }),
    );
  });

  it("terminates the in-memory process before persisting cancellation status", async () => {
    const { runId } = await seedRunFixture({
      agentStatus: "running",
      includeIssue: false,
    });
    heartbeat = createHeartbeat({ penstockAvailabilityGate: allowPenstockGate });
    runningProcesses.set(runId, {
      child: { pid: 12345 } as ChildProcess,
      graceSec: 1,
      processGroupId: null,
    });
    mockTerminateLocalService.mockResolvedValueOnce(undefined);
    const updateSpy = vi.spyOn(db, "update");
    updateSpy.mockImplementationOnce((() => {
      throw new Error("db update unavailable");
    }) as typeof db.update);

    try {
      await expect(heartbeat.cancelRun(runId)).rejects.toThrow("db update unavailable");
      expect(mockTerminateLocalService).toHaveBeenCalledWith(
        expect.objectContaining({ pid: 12345, processGroupId: null }),
        { forceAfterMs: 1000 },
      );
      expect(runningProcesses.has(runId)).toBe(false);
    } finally {
      updateSpy.mockRestore();
    }
  });

  it("records manual cancellation stop metadata", async () => {
    const { runId } = await seedRunFixture({
      agentStatus: "running",
      includeIssue: false,
    });

    const cancelled = await heartbeat.cancelRun(runId);
    expect(cancelled?.status).toBe("cancelled");
    expect(cancelled?.resultJson).toMatchObject({
      stopReason: "cancelled",
      effectiveTimeoutSec: 0,
      timeoutConfigured: false,
      timeoutFired: false,
    });
  });

  it("cancelRun cascades Job deletion for claude_k8s (RCA 2026-05-06)", async () => {
    // The reaper-driven path got cascade-delete in PR #108; this is the
    // sibling path for explicit operator/board cancel. Without this,
    // UPDATE'ing status='cancelled' still left the Job alive and the
    // next dispatch hit "Concurrent run blocked".
    const { companyId, agentId, runId } = await seedRunFixture({
      adapterType: "claude_k8s",
      processPid: null,
      processGroupId: null,
      agentStatus: "running",
      includeIssue: false,
    });
    await seedLaunchedReservation({ companyId, agentId, runId });

    const cancelled = await heartbeat.cancelRun(runId);
    expect(cancelled?.status).toBe("cancelled");
    expect(mockDeleteAgentJobsForRun).toHaveBeenCalledWith(expect.objectContaining({ runId }));
  });

  it("reaper deletes stale live external-lifecycle Jobs whose heartbeat run is already terminal", async () => {
    const stale = new Date(Date.now() - 6 * 60 * 1000);
    const { companyId, agentId, runId } = await seedRunFixture({
      adapterType: "opencode_k8s",
      runStatus: "failed",
      processPid: null,
      processGroupId: null,
      includeIssue: false,
      runErrorCode: "process_lost",
      runError: "Historical terminal run still has a live Job",
      lastOutputAt: stale,
    });
    const reservation = await seedLaunchedReservation({ companyId, agentId, runId });
    mockListAgentJobRunStatuses.mockResolvedValueOnce(
      new Map([
        [runId, {
          phase: "active",
          reason: null,
          message: null,
          name: reservation.jobName,
          uid: reservation.jobUid,
        }],
      ]),
    );

    const result = await heartbeat.reapOrphanedRuns();
    expect(result.reaped).toBe(1);
    expect(result.runIds).toEqual([runId]);
    expect(mockDeleteAgentJobsForRun).toHaveBeenCalledWith(expect.objectContaining({ runId }));

    const run = await heartbeat.getRun(runId);
    expect(run?.status).toBe("failed");
    expect(run?.errorCode).toBe("process_lost");
  });

  it("cancelRun does not cascade Job deletion for local adapters", async () => {
    const { runId } = await seedRunFixture({
      adapterType: "codex_local",
      agentStatus: "running",
      includeIssue: false,
    });

    const cancelled = await heartbeat.cancelRun(runId);
    expect(cancelled?.status).toBe("cancelled");
    expect(mockDeleteAgentJobsForRun).not.toHaveBeenCalled();
  });

  it("records operator interrupt cancellation metadata without changing terminal status", async () => {
    const { runId, issueId } = await seedRunFixture({
      agentStatus: "running",
      includeIssue: true,
    });
    heartbeat = createHeartbeat({ penstockAvailabilityGate: allowPenstockGate });

    const cancelled = await heartbeat.cancelRun(runId, "Interrupted by board comment", {
      errorCode: "operator_interrupted",
      resultJson: {
        operatorInterrupted: true,
        interruptionSource: "issue_comment_interrupt",
        interruptedIssueId: issueId,
      },
      eventMessage: "run interrupted by board comment",
      eventPayload: {
        issueId,
        source: "issue_comment_interrupt",
      },
    });

    expect(cancelled?.status).toBe("cancelled");
    expect(cancelled?.errorCode).toBe("operator_interrupted");
    expect(cancelled?.error).toBe("Interrupted by board comment");
    expect(cancelled?.resultJson).toMatchObject({
      stopReason: "cancelled",
      operatorInterrupted: true,
      interruptionSource: "issue_comment_interrupt",
      interruptedIssueId: issueId,
    });

    const events = await db
      .select()
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, runId));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: "lifecycle",
      stream: "system",
      level: "warn",
      message: "run interrupted by board comment",
      payload: expect.objectContaining({
        issueId,
        source: "issue_comment_interrupt",
      }),
    });
  });

  it("dispatches assigned todo work with no prior run as a normal assignment wake", async () => {
    const { companyId, agentId, issueId } = await seedAssignedTodoNoRunFixture();

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.assignmentDispatched).toBe(1);
    expect(result.dispatchRequeued).toBe(0);
    expect(result.continuationRequeued).toBe(0);
    expect(result.escalated).toBe(0);
    expect(result.issueIds).toEqual([issueId]);

    const wakeups = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakeups).toHaveLength(1);
    expect(wakeups[0]).toMatchObject({
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: expect.objectContaining({
        issueId,
        mutation: "assigned_todo_liveness_dispatch",
      }),
    });
    expect(wakeups[0]?.payload as Record<string, unknown>).not.toHaveProperty("modelProfile");

    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.retryOfRunId).toBeNull();
    expect(runs[0]?.contextSnapshot).toMatchObject({
      issueId,
      taskId: issueId,
      wakeReason: "issue_assigned",
      source: "issue.assigned_todo_liveness_dispatch",
    });
    expect(runs[0]?.contextSnapshot as Record<string, unknown>).not.toHaveProperty("modelProfile");
    expect((runs[0]?.contextSnapshot as Record<string, unknown>)?.retryReason).toBeUndefined();

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("todo");

    const recoveryIssues = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stranded_issue_recovery")));
    expect(recoveryIssues).toHaveLength(0);
    await expect(sourceBlockerIssueIds(companyId, issueId)).resolves.toEqual([]);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(0);

    if (runs[0]?.id) {
      await waitForRunToSettle(heartbeat, runs[0].id);
    }
  });

  it("does not duplicate initial assigned todo dispatch when a queued wake already exists", async () => {
    const { companyId, agentId, issueId } = await seedAssignedTodoNoRunFixture();
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId, mutation: "assigned_todo_liveness_dispatch" },
      status: "queued",
    });

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.assignmentDispatched).toBe(0);
    expect(result.dispatchRequeued).toBe(0);
    expect(result.continuationRequeued).toBe(0);
    expect(result.escalated).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.issueIds).toEqual([]);

    const wakeups = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakeups).toHaveLength(1);
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(0);
  });

  // BLO-3220 double-dispatch fix: two wakeup paths can each insert a queued
  // heartbeat_run for the same (agent, issue) on the same tick (user-clicked
  // Retry + scheduled tick + dependency fanout, etc.). Pre-fix, the dispatcher
  // claimed and dispatched both; the second lost the k8s Job creation race
  // and surfaced as `Concurrent run blocked: orphaned Job ...` in the UI.
  it("collapses duplicate queued runs for the same (agent, issue) to one dispatch", async () => {
    const { companyId, agentId, issueId } = await seedAssignedTodoNoRunFixture();
    const olderRunId = randomUUID();
    const newerRunId = randomUUID();
    const olderWakeupId = randomUUID();
    const newerWakeupId = randomUUID();
    const olderTime = new Date(Date.now() - 1_000);
    const newerTime = new Date();

    await db.insert(agentWakeupRequests).values([
      {
        id: olderWakeupId,
        companyId,
        agentId,
        source: "assignment",
        triggerDetail: "first",
        reason: "issue_assigned",
        payload: { issueId },
        status: "queued",
      },
      {
        id: newerWakeupId,
        companyId,
        agentId,
        source: "assignment",
        triggerDetail: "second",
        reason: "issue_assigned",
        payload: { issueId },
        status: "queued",
      },
    ]);

    await db.insert(heartbeatRuns).values([
      {
        id: olderRunId,
        companyId,
        agentId,
        invocationSource: "assignment",
        triggerDetail: "first",
        status: "queued",
        wakeupRequestId: olderWakeupId,
        contextSnapshot: { issueId },
        createdAt: olderTime,
        updatedAt: olderTime,
      },
      {
        id: newerRunId,
        companyId,
        agentId,
        invocationSource: "assignment",
        triggerDetail: "second",
        status: "queued",
        wakeupRequestId: newerWakeupId,
        contextSnapshot: { issueId },
        createdAt: newerTime,
        updatedAt: newerTime,
      },
    ]);

    await heartbeat.resumeQueuedRuns();
    await waitForRunToSettle(heartbeat, olderRunId);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId))
      .orderBy(asc(heartbeatRuns.createdAt));

    const winner = runs.find((r) => r.id === olderRunId);
    const loser = runs.find((r) => r.id === newerRunId);
    // Older row wins per startNextQueuedRunForAgent's createdAt-ASC tie-break.
    // We only assert the winner was claimed past `queued` — the dedupe gate's
    // job is to ensure exactly one row leaves the queued state per (agent,
    // issue). Where the winner's mocked-adapter run ultimately lands is
    // executeRun-setup territory covered by other tests.
    //
    // Don't assert `runs.length` (BLO-6119): the file-level mock-adapter
    // response includes `summary`, which makes `isProductiveSuccessfulRun`
    // true on the winner's completion. That fires `handleSuccessfulRunHandoff`
    // and `finalizeIssueCommentPolicy` (wakeReason was issue_assigned with
    // no comment posted by the mock) as fire-and-forget corrective wakes,
    // each of which can enqueue a 3rd row before the test reads the table.
    // Per-row assertions on (winner, loser) independently of total count is
    // the proven pattern from 6a056f8f. Local repro is flaky (passes ~50%
    // of runs); CI surfaces it more consistently.
    expect(winner).toBeDefined();
    expect(loser).toBeDefined();
    expect(winner?.status).not.toBe("queued");
    expect(winner?.status).not.toBe("cancelled");
    expect(loser?.status).toBe("cancelled");
    expect(loser?.errorCode).toBe("duplicate_dispatch_suppressed");
    expect(loser?.error).toContain("sibling run is already dispatched");
    expect(loser?.resultJson).toMatchObject({
      stopReason: "duplicate_dispatch_suppressed",
      timeoutSource: "duplicate_dispatch_gate",
      timeoutFired: false,
    });

    const loserWakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, newerWakeupId))
      .then((rows) => rows[0] ?? null);
    expect(loserWakeup?.status).toBe("skipped");
  });

  it("defers external-lifecycle queued dispatch while a terminating k8s pod still holds the agent slot", async () => {
    const { companyId, agentId, issueId } = await seedAssignedTodoNoRunFixture({
      adapterType: "opencode_k8s",
    });
    const queuedWakeupId = randomUUID();
    const queuedRunId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: queuedWakeupId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      status: "queued",
    });
    await db.insert(heartbeatRuns).values({
      id: queuedRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId: queuedWakeupId,
      contextSnapshot: { issueId },
      createdAt: new Date("2026-06-11T19:45:40.000Z"),
      updatedAt: new Date("2026-06-11T19:45:40.000Z"),
    });
    mockHasActiveJobForAgent.mockResolvedValueOnce(true);
    mockAdapterExecute.mockClear();

    await heartbeat.resumeQueuedRuns();

    const run = await heartbeat.getRun(queuedRunId);
    expect(mockHasActiveJobForAgent).toHaveBeenCalledWith(agentId);
    expect(run?.status).toBe("queued");
    expect(mockAdapterExecute.mock.calls.some(([ctx]) => ctx.runId === queuedRunId)).toBe(false);
  });

  it("reaps orphaned k8s runs before dispatching queued work for the same issue", async () => {
    const stale = new Date(Date.now() - 16 * 60 * 1000);
    const { companyId, agentId, issueId, runId: orphanRunId } = await seedRunFixture({
      adapterType: "claude_k8s",
      agentStatus: "running",
      includeIssue: true,
      lastOutputAt: stale,
    });
    await seedAdapterInvokeEvent({ companyId, agentId, runId: orphanRunId });
    mockListLiveAgentJobRunIds.mockResolvedValueOnce(new Set());

    const queuedWakeupId = randomUUID();
    const queuedRunId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: queuedWakeupId,
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_continuation_needed",
      payload: { issueId },
      status: "queued",
    });
    await db.insert(heartbeatRuns).values({
      id: queuedRunId,
      companyId,
      agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId: queuedWakeupId,
      contextSnapshot: {
        issueId,
        taskId: issueId,
        wakeReason: "issue_continuation_needed",
        retryReason: "issue_continuation_needed",
      },
      createdAt: new Date("2026-03-19T00:10:00.000Z"),
      updatedAt: new Date("2026-03-19T00:10:00.000Z"),
    });

    await heartbeat.resumeQueuedRuns();
    await waitForValue(async () => {
      const run = await heartbeat.getRun(queuedRunId);
      return run && run.status !== "queued" ? run : null;
    });

    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    const orphanRun = runs.find((run) => run.id === orphanRunId);
    const queuedRun = runs.find((run) => run.id === queuedRunId);
    expect(orphanRun).toMatchObject({
      status: "failed",
      errorCode: "process_lost",
    });
    expect(queuedRun?.status).not.toBe("queued");
    expect(queuedRun?.errorCode).not.toBe("duplicate_dispatch_suppressed");
    await heartbeat.cancelRun(queuedRunId);
  });

  it("cancels a queued stale routine duplicate when another open issue owns the execution lock", async () => {
    const { companyId, agentId, issueId: duplicateIssueId } = await seedAssignedTodoNoRunFixture();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const ownerIssueId = randomUUID();
    const ownerRunId = randomUUID();
    const duplicateRunId = randomUUID();
    const duplicateWakeupId = randomUUID();
    const routineId = randomUUID();
    const dispatchFingerprint = "routine-dispatch-fingerprint";

    await db.insert(heartbeatRuns).values({
      id: ownerRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "owner",
      status: "queued",
      contextSnapshot: { issueId: ownerIssueId, wakeReason: "issue_assigned" },
    });

    await db.insert(issues).values({
      id: ownerIssueId,
      companyId,
      title: "Owner routine execution",
      status: "blocked",
      priority: "medium",
      assigneeAgentId: agentId,
      executionRunId: ownerRunId,
      originKind: "routine_execution",
      originId: routineId,
      originFingerprint: dispatchFingerprint,
      issueNumber: 2,
      identifier: `${issuePrefix}-2`,
    });

    await db
      .update(issues)
      .set({
        title: "Stale duplicate routine execution",
        status: "todo",
        assigneeAgentId: agentId,
        originKind: "routine_execution",
        originId: routineId,
        originFingerprint: dispatchFingerprint,
        executionRunId: null,
      })
      .where(eq(issues.id, duplicateIssueId));

    await db.insert(agentWakeupRequests).values({
      id: duplicateWakeupId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "duplicate",
      reason: "issue_assigned",
      payload: { issueId: duplicateIssueId },
      status: "queued",
      runId: duplicateRunId,
    });
    await db.insert(heartbeatRuns).values({
      id: duplicateRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "duplicate",
      status: "queued",
      wakeupRequestId: duplicateWakeupId,
      contextSnapshot: { issueId: duplicateIssueId, wakeReason: "issue_assigned" },
    });

    await heartbeat.__test_executeRunForTesting(duplicateRunId);

    const duplicateRun = await heartbeat.getRun(duplicateRunId);
    expect(duplicateRun).toMatchObject({
      status: "cancelled",
      errorCode: "routine_execution_duplicate_suppressed",
    });
    expect(duplicateRun?.resultJson).toMatchObject({
      stopReason: "routine_execution_duplicate_suppressed",
      timeoutSource: "routine_execution_duplicate_gate",
    });

    const duplicateWakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, duplicateWakeupId))
      .then((rows) => rows[0] ?? null);
    expect(duplicateWakeup?.status).toBe("skipped");

    const duplicateIssue = await db
      .select({ executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, duplicateIssueId))
      .then((rows) => rows[0] ?? null);
    expect(duplicateIssue?.executionRunId).toBeNull();

    const ownerIssue = await db
      .select({ executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, ownerIssueId))
      .then((rows) => rows[0] ?? null);
    expect(ownerIssue?.executionRunId).toBe(ownerRunId);
  });

  it("skips budget-blocked assigned todo work with no prior run and continues the sweep", async () => {
    const blocked = await seedAssignedTodoNoRunFixture();
    const unblocked = await seedAssignedTodoNoRunFixture();
    await db.insert(budgetPolicies).values({
      companyId: blocked.companyId,
      scopeType: "agent",
      scopeId: blocked.agentId,
      metric: "billed_cents",
      windowKind: "calendar_month_utc",
      amount: 1,
      hardStopEnabled: true,
      isActive: true,
    });
    await db.insert(costEvents).values({
      companyId: blocked.companyId,
      agentId: blocked.agentId,
      issueId: blocked.issueId,
      provider: "test",
      biller: "test",
      billingType: "tokens",
      model: "test-model",
      costCents: 1,
      occurredAt: new Date(),
    });

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.assignmentDispatched).toBe(1);
    expect(result.dispatchRequeued).toBe(0);
    expect(result.continuationRequeued).toBe(0);
    expect(result.escalated).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.issueIds).toEqual([unblocked.issueId]);

    const blockedWakeups = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, blocked.agentId));
    expect(blockedWakeups).toHaveLength(0);
    const blockedRuns = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, blocked.agentId));
    expect(blockedRuns).toHaveLength(0);

    const blockedIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, blocked.issueId))
      .then((rows) => rows[0] ?? null);
    expect(blockedIssue?.status).toBe("todo");

    const unblockedWakeups = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, unblocked.agentId));
    expect(unblockedWakeups).toHaveLength(1);
    expect(unblockedWakeups[0]).toMatchObject({
      reason: "issue_assigned",
      payload: expect.objectContaining({
        issueId: unblocked.issueId,
        mutation: "assigned_todo_liveness_dispatch",
      }),
    });
    expect(unblockedWakeups[0]?.payload as Record<string, unknown>).not.toHaveProperty("modelProfile");
    const unblockedRuns = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, unblocked.agentId));
    expect(unblockedRuns).toHaveLength(1);
    if (unblockedRuns[0]?.id) {
      await waitForRunToSettle(heartbeat, unblockedRuns[0].id);
    }
  });

  it("does not dispatch assigned todo work with no prior run when the agent is paused", async () => {
    const { agentId, issueId } = await seedAssignedTodoNoRunFixture({ agentStatus: "paused" });

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.assignmentDispatched).toBe(0);
    expect(result.dispatchRequeued).toBe(0);
    expect(result.continuationRequeued).toBe(0);
    expect(result.escalated).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.issueIds).toEqual([]);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("todo");
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(0);
  });

  it("re-enqueues assigned todo work when the last issue run died and no wake remains", async () => {
    const { companyId, agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "todo",
      runStatus: "failed",
    });

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.assignmentDispatched).toBe(0);
    expect(result.dispatchRequeued).toBe(1);
    expect(result.continuationRequeued).toBe(0);
    expect(result.escalated).toBe(0);
    expect(result.issueIds).toEqual([issueId]);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(2);

    const retryRun = runs.find((row) => row.id !== runId);
    expect(retryRun?.id).toBeTruthy();
    expect((retryRun?.contextSnapshot as Record<string, unknown>)?.retryReason).toBe("assignment_recovery");
    expect(retryRun?.contextSnapshot as Record<string, unknown>).not.toHaveProperty("modelProfile");
    if (retryRun) {
      await waitForRunToSettle(heartbeat, retryRun.id);
    }
  });

  it("re-enqueues an already stranded execution-review participant during reconciliation", async () => {
    const { agentId, issueId, runId, wakeupRequestId, stageId } = await seedInReviewParticipantRunFixture();
    const finishedAt = new Date("2026-03-19T00:05:00.000Z");
    await db
      .update(heartbeatRuns)
      .set({
        status: "succeeded",
        startedAt: new Date("2026-03-19T00:00:00.000Z"),
        finishedAt,
        updatedAt: finishedAt,
      })
      .where(eq(heartbeatRuns.id, runId));
    await db
      .update(agentWakeupRequests)
      .set({
        status: "completed",
        finishedAt,
        updatedAt: finishedAt,
      })
      .where(eq(agentWakeupRequests.id, wakeupRequestId));
    const heartbeat = createHeartbeat();

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.reviewParticipantRequeued).toBe(1);
    expect(result.escalated).toBe(0);
    expect(result.issueIds).toEqual([issueId]);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    const retryRun = runs.find((row) => row.id !== runId);
    expect(["queued", "running"]).toContain(retryRun?.status);
    expect(retryRun).toMatchObject({
      retryOfRunId: runId,
    });
    expect(retryRun?.contextSnapshot).toMatchObject({
      issueId,
      taskId: issueId,
      wakeReason: "execution_review_participant_recovery",
      retryReason: "execution_review_participant_recovery",
      source: "issue.execution_review_recovery",
      retryOfRunId: runId,
      currentStageId: stageId,
      currentStageType: "review",
      reviewRecoveryInstruction: expect.stringContaining("Submit the review decision now"),
    });
    expect(retryRun?.contextSnapshot as Record<string, unknown>).not.toHaveProperty("modelProfile");
  });

  it("re-enqueues a stranded execution-review participant when another agent has the latest issue run", async () => {
    const { companyId, agentId, issueId, runId, wakeupRequestId, stageId } =
      await seedInReviewParticipantRunFixture();
    const otherAgentId = randomUUID();
    const otherRunId = randomUUID();
    const finishedAt = new Date("2026-03-19T00:05:00.000Z");

    await db
      .update(heartbeatRuns)
      .set({
        status: "succeeded",
        startedAt: new Date("2026-03-19T00:00:00.000Z"),
        finishedAt,
        updatedAt: finishedAt,
      })
      .where(eq(heartbeatRuns.id, runId));
    await db
      .update(agentWakeupRequests)
      .set({
        status: "completed",
        finishedAt,
        updatedAt: finishedAt,
      })
      .where(eq(agentWakeupRequests.id, wakeupRequestId));

    await db.insert(agents).values({
      id: otherAgentId,
      companyId,
      name: "CodexImplementor",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: otherRunId,
      companyId,
      agentId: otherAgentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "succeeded",
      contextSnapshot: {
        issueId,
        taskId: issueId,
        wakeReason: "issue_commented",
      },
      startedAt: new Date("2026-03-19T00:10:00.000Z"),
      finishedAt: new Date("2026-03-19T00:15:00.000Z"),
      createdAt: new Date(Date.now() + 1_000),
      updatedAt: new Date("2026-03-19T00:15:00.000Z"),
    });

    const heartbeat = createHeartbeat();
    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.reviewParticipantRequeued).toBe(1);
    expect(result.escalated).toBe(0);
    expect(result.issueIds).toEqual([issueId]);

    const retryRun = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId))
      .then((runs) =>
        runs.find((row) =>
          row.id !== runId &&
          (row.contextSnapshot as Record<string, unknown> | null)?.retryReason ===
            "execution_review_participant_recovery"
        ) ?? null
      );
    expect(retryRun).toMatchObject({
      retryOfRunId: runId,
    });
    expect(retryRun?.contextSnapshot).toMatchObject({
      issueId,
      currentStageId: stageId,
      currentStageType: "review",
    });
  });

  it("re-enqueues a stranded execution-review participant when another agent has a queued issue wake", async () => {
    const { companyId, agentId, issueId, runId, wakeupRequestId } =
      await seedInReviewParticipantRunFixture();
    const otherAgentId = randomUUID();
    const otherWakeId = randomUUID();
    const finishedAt = new Date("2026-03-19T00:05:00.000Z");

    await db
      .update(heartbeatRuns)
      .set({
        status: "succeeded",
        startedAt: new Date("2026-03-19T00:00:00.000Z"),
        finishedAt,
        updatedAt: finishedAt,
      })
      .where(eq(heartbeatRuns.id, runId));
    await db
      .update(agentWakeupRequests)
      .set({
        status: "completed",
        finishedAt,
        updatedAt: finishedAt,
      })
      .where(eq(agentWakeupRequests.id, wakeupRequestId));

    await db.insert(agents).values({
      id: otherAgentId,
      companyId,
      name: "CodexImplementor",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(agentWakeupRequests).values({
      id: otherWakeId,
      companyId,
      agentId: otherAgentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId },
      status: "queued",
    });

    const heartbeat = createHeartbeat();
    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.reviewParticipantRequeued).toBe(1);
    expect(result.escalated).toBe(0);
    expect(result.issueIds).toEqual([issueId]);

    const wakeups = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakeups.some((wakeup) =>
      wakeup.reason === "execution_review_participant_recovery" &&
        wakeup.status !== "skipped"
    )).toBe(true);
  });

  it("retries a pending execution-review participant when another agent has an active issue run", async () => {
    const { companyId, agentId, issueId, runId } = await seedInReviewParticipantRunFixture();
    const otherAgentId = randomUUID();
    const otherRunId = randomUUID();
    await db.insert(agents).values({
      id: otherAgentId,
      companyId,
      name: "CodexImplementor",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: otherRunId,
      companyId,
      agentId: otherAgentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "running",
      contextSnapshot: {
        issueId,
        taskId: issueId,
        wakeReason: "issue_commented",
      },
      startedAt: new Date("2026-03-19T00:01:00.000Z"),
      updatedAt: new Date("2026-03-19T00:01:00.000Z"),
    });

    const heartbeat = createHeartbeat();
    await heartbeat.resumeQueuedRuns();
    const reviewRecoveryRun = await waitForValue(async () => {
      const runs = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, agentId));
      return runs.find((row) =>
        (row.contextSnapshot as Record<string, unknown> | null)?.retryReason ===
          "execution_review_participant_recovery"
      ) ?? null;
    }, 8_000);

    expect(reviewRecoveryRun).toMatchObject({
      companyId,
      agentId,
      retryOfRunId: runId,
    });
  });

  it("does not immediately recover a generic on-demand run used for an in-review agent API update", async () => {
    const { agentId, issueId, runId } = await seedInReviewParticipantRunFixture({
      wakeReason: "manual",
    });
    const heartbeat = createHeartbeat();

    await heartbeat.resumeQueuedRuns();
    const settledRun = await waitForRunToSettle(heartbeat, runId, 8_000);
    expect(settledRun?.status).toBe("succeeded");

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs.some((row) =>
      (row.contextSnapshot as Record<string, unknown> | null)?.retryReason ===
        "execution_review_participant_recovery"
    )).toBe(false);

    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("in_review");
    expect(issue?.assigneeAgentId).toBe(agentId);
  });

  it("retries a pending execution-review participant once before blocking with a recovery action", async () => {
    const { companyId, agentId, issueId, runId, stageId } = await seedInReviewParticipantRunFixture();
    const heartbeat = createHeartbeat();

    await heartbeat.resumeQueuedRuns();
    const reviewRecoveryRun = await waitForValue(async () => {
      const runs = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, agentId));
      return runs.find((row) =>
        (row.contextSnapshot as Record<string, unknown> | null)?.retryReason ===
          "execution_review_participant_recovery" &&
        row.status !== "queued" &&
        row.status !== "running"
      ) ?? null;
    }, 8_000);
    expect(reviewRecoveryRun).toBeTruthy();
    expect(reviewRecoveryRun).toMatchObject({
      companyId,
      agentId,
      retryOfRunId: runId,
      status: "succeeded",
    });
    expect(reviewRecoveryRun?.contextSnapshot).toMatchObject({
      issueId,
      taskId: issueId,
      wakeReason: "execution_review_participant_recovery",
      retryReason: "execution_review_participant_recovery",
      source: "issue.execution_review_recovery",
      retryOfRunId: runId,
      currentStageId: stageId,
      currentStageType: "review",
      reviewRecoveryInstruction: expect.stringContaining("Submit the review decision now"),
    });
    expect(reviewRecoveryRun?.contextSnapshot as Record<string, unknown>).not.toHaveProperty("modelProfile");

    const sourceIssue = await waitForValue(async () => {
      const row = await db
        .select()
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null);
      return row?.status === "blocked" ? row : null;
    }, 8_000);
    expect(sourceIssue).toMatchObject({
      status: "blocked",
      assigneeAgentId: agentId,
      executionRunId: null,
    });

    const recoveryAction = await expectSourceScopedStrandedRecoveryAction({
      companyId,
      agentId,
      issueId,
      runId: reviewRecoveryRun!.id,
      previousStatus: "in_review",
      retryReason: "execution_review_participant_recovery",
      cause: "execution_review_participant_recovery",
    });
    expect(recoveryAction.evidence).toMatchObject({
      latestRunId: reviewRecoveryRun?.id,
      latestRunStatus: "succeeded",
      latestRunErrorCode: null,
      recoveryCause: "execution_review_participant_recovery",
    });

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    const recoveryComment = comments.find((comment) =>
      comment.body.includes("pending execution-review participant once") &&
        comment.body.includes(`Recovery action: \`${recoveryAction.id}\``),
    );
    expect(recoveryComment).toBeTruthy();

    const activity = await db.select().from(activityLog).where(eq(activityLog.entityId, issueId));
    expect(activity.some((event) =>
      (event.details as Record<string, unknown> | null)?.source ===
        "recovery.reconcile_execution_review_participant",
    )).toBe(true);
  });

  it("blocks failed execution-review recovery under the reviewer when the source assignee differs", async () => {
    const { companyId, agentId, issueId, runId, wakeupRequestId, stageId } =
      await seedInReviewParticipantRunFixture({
        wakeReason: "execution_review_participant_recovery",
        retryReason: "execution_review_participant_recovery",
      });
    const sourceAssigneeAgentId = randomUUID();
    const finishedAt = new Date("2026-03-19T00:05:00.000Z");

    await db.insert(agents).values({
      id: sourceAssigneeAgentId,
      companyId,
      name: "CodexImplementor",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db
      .update(issues)
      .set({
        assigneeAgentId: sourceAssigneeAgentId,
        executionState: {
          status: "pending",
          currentStageId: stageId,
          currentStageIndex: 0,
          currentStageType: "review",
          currentParticipant: { type: "agent", agentId, userId: null },
          returnAssignee: { type: "agent", agentId: sourceAssigneeAgentId, userId: null },
          reviewRequest: null,
          completedStageIds: [],
          lastDecisionId: null,
          lastDecisionOutcome: null,
        },
      })
      .where(eq(issues.id, issueId));
    await db
      .update(heartbeatRuns)
      .set({
        status: "failed",
        startedAt: new Date("2026-03-19T00:00:00.000Z"),
        finishedAt,
        updatedAt: finishedAt,
        errorCode: "adapter_failed",
        error: "review recovery failed before submitting a decision",
      })
      .where(eq(heartbeatRuns.id, runId));
    await db
      .update(agentWakeupRequests)
      .set({
        status: "failed",
        claimedAt: new Date("2026-03-19T00:00:00.000Z"),
        finishedAt,
        updatedAt: finishedAt,
        error: "review recovery failed before submitting a decision",
      })
      .where(eq(agentWakeupRequests.id, wakeupRequestId));
    const heartbeat = createHeartbeat();

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.reviewParticipantRequeued).toBe(0);
    expect(result.escalated).toBe(1);
    expect(result.issueIds).toEqual([issueId]);

    const sourceIssue = await waitForValue(async () => {
      const row = await db
        .select()
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null);
      return row?.status === "blocked" ? row : null;
    });
    expect(sourceIssue).toMatchObject({
      status: "blocked",
      assigneeAgentId: agentId,
    });

    const recoveryAction = await expectSourceScopedStrandedRecoveryAction({
      companyId,
      agentId,
      issueId,
      runId,
      previousStatus: "in_review",
      retryReason: "execution_review_participant_recovery",
      cause: "execution_review_participant_recovery",
      previousOwnerAgentId: sourceAssigneeAgentId,
      returnOwnerAgentId: sourceAssigneeAgentId,
    });
    expect(recoveryAction.evidence).toMatchObject({
      latestRunId: runId,
      latestRunStatus: "failed",
      latestRunErrorCode: "adapter_failed",
      recoveryCause: "execution_review_participant_recovery",
    });
  });

  it.each([
    ["failed", "adapter_failed"],
    ["failed", "process_lost"],
    ["timed_out", "adapter_timed_out"],
  ] as const)(
    "re-enqueues stranded in-progress work after a %s/%s run before escalating",
    async (runStatus, runErrorCode) => {
      const { companyId, agentId, issueId, runId } = await seedStrandedIssueFixture({
        status: "in_progress",
        runStatus,
        runErrorCode,
      });

      const result = await heartbeat.reconcileStrandedAssignedIssues();
      expect(result.dispatchRequeued).toBe(0);
      expect(result.continuationRequeued).toBe(1);
      expect(result.escalated).toBe(0);
      expect(result.issueIds).toEqual([issueId]);

      const runs = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, agentId));
      expect(runs).toHaveLength(2);

      const retryRun = runs.find((row) => row.id !== runId);
      expect(retryRun?.contextSnapshot as Record<string, unknown> | undefined).toMatchObject({
        issueId,
        taskId: issueId,
        retryReason: "issue_continuation_needed",
        retryOfRunId: runId,
        source: "issue.continuation_recovery",
      });
      expect(retryRun?.contextSnapshot as Record<string, unknown>).not.toHaveProperty("modelProfile");

      const recoveries = await db
        .select()
        .from(issues)
        .where(
          and(
            eq(issues.companyId, companyId),
            eq(issues.originKind, "stranded_issue_recovery"),
            eq(issues.originId, issueId),
          ),
        );
      expect(recoveries).toHaveLength(0);

      if (retryRun?.id) {
        await waitForRunToSettle(heartbeat, retryRun.id);
      }
    },
  );

  it.each([
    "wake_assignee",
    "wake_assignee_on_accept",
  ] as const)("skips stranded recovery when a pending %s interaction exists", async (continuationPolicy) => {
    const { companyId, agentId, issueId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "failed",
    });

    await db.insert(issueThreadInteractions).values({
      companyId,
      issueId,
      kind: "request_confirmation",
      status: "pending",
      continuationPolicy,
      createdByAgentId: agentId,
      payload: { version: 1, prompt: "Approve the plan?" },
    });

    heartbeat = createHeartbeat({ penstockAvailabilityGate: allowPenstockGate });
    const result = await heartbeat.reconcileStrandedAssignedIssues();

    expect(result.continuationRequeued).toBe(0);
    expect(result.escalated).toBe(0);
    expect(result.skipped).toBeGreaterThanOrEqual(1);

    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("in_progress");
  });

  it("requeues accepted interaction continuations stranded in_review without execution state", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const interactionId = randomUUID();
    const resolvedAt = new Date("2026-03-19T00:05:00.000Z");
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      defaultResponsibleUserId: "responsible-user",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Accepted plan never resumed",
      status: "in_review",
      priority: "medium",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });
    await db.insert(issueThreadInteractions).values({
      id: interactionId,
      companyId,
      issueId,
      kind: "request_confirmation",
      status: "accepted",
      continuationPolicy: "wake_assignee_on_accept",
      createdByAgentId: agentId,
      resolvedByUserId: "responsible-user",
      resolvedAt,
      updatedAt: resolvedAt,
      payload: { version: 1, prompt: "Approve the plan?" },
      result: { outcome: "accepted" },
    });

    const heartbeat = createHeartbeat();
    const result = await heartbeat.reconcileStrandedAssignedIssues();

    expect(result.continuationRequeued).toBe(1);
    expect(result.issueIds).toEqual([issueId]);

    const run = await db
      .select({
        agentId: heartbeatRuns.agentId,
        contextSnapshot: heartbeatRuns.contextSnapshot,
        retryOfRunId: heartbeatRuns.retryOfRunId,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId))
      .then((rows) => rows[0] ?? null);
    expect(run?.agentId).toBe(agentId);
    expect(run?.retryOfRunId).toBeNull();
    expect(run?.contextSnapshot).toMatchObject({
      issueId,
      taskId: issueId,
      wakeReason: "issue_continuation_needed",
      retryReason: "issue_continuation_needed",
      source: "issue.interaction_continuation_recovery",
      interactionId,
      interactionKind: "request_confirmation",
      interactionStatus: "accepted",
      interactionContinuationPolicy: "wake_assignee_on_accept",
      interactionResolvedAt: resolvedAt.toISOString(),
    });
  });

  it("escalates accepted interaction continuation recovery after three review-park cancellations", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const interactionId = randomUUID();
    const resolvedAt = new Date("2026-03-19T00:05:00.000Z");
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      defaultResponsibleUserId: "responsible-user",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Accepted plan cancellation loop",
      status: "in_review",
      priority: "medium",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });
    await db.insert(issueThreadInteractions).values({
      id: interactionId,
      companyId,
      issueId,
      kind: "request_confirmation",
      status: "accepted",
      continuationPolicy: "wake_assignee_on_accept",
      createdByAgentId: agentId,
      resolvedByUserId: "responsible-user",
      resolvedAt,
      updatedAt: resolvedAt,
      payload: { version: 1, prompt: "Approve the plan?" },
      result: { outcome: "accepted" },
    });
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const finishedAt = new Date(resolvedAt.getTime() + attempt * 60_000);
      await db.insert(heartbeatRuns).values({
        id: randomUUID(),
        companyId,
        agentId,
        invocationSource: "automation",
        triggerDetail: "system",
        status: "cancelled",
        errorCode: "issue_continuation_waiting_on_review",
        error: "Continuation summary still says to wait for review",
        contextSnapshot: {
          issueId,
          taskId: issueId,
          wakeReason: "issue_continuation_needed",
          retryReason: "issue_continuation_needed",
          mutation: "interaction",
          interactionId,
          interactionResolvedAt: resolvedAt.toISOString(),
        },
        createdAt: finishedAt,
        startedAt: finishedAt,
        finishedAt,
        updatedAt: finishedAt,
      });
    }

    const heartbeat = createHeartbeat();
    const result = await heartbeat.reconcileStrandedAssignedIssues();

    expect(result.continuationRequeued).toBe(0);
    expect(result.waitingOnReviewResolved).toBe(0);
    expect(result.escalated).toBe(1);
    expect(result.issueIds).toContain(issueId);

    const [issue, continuationRuns, comments] = await Promise.all([
      db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null),
      db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(and(
          eq(heartbeatRuns.companyId, companyId),
          eq(heartbeatRuns.agentId, agentId),
          sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`,
          sql`${heartbeatRuns.contextSnapshot} ->> 'retryReason' = 'issue_continuation_needed'`,
        )),
      db.select({ body: issueComments.body }).from(issueComments).where(eq(issueComments.issueId, issueId)),
    ]);
    expect(issue?.status).toBe("blocked");
    expect(continuationRuns).toHaveLength(3);
    expect(comments.some((comment) => comment.body.includes(interactionId))).toBe(true);
  });

  it("skips accepted interaction recovery after its continuation succeeds", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const interactionId = randomUUID();
    const resolvedAt = new Date("2026-03-19T00:05:00.000Z");
    const succeededAt = new Date("2026-03-19T00:06:00.000Z");
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      defaultResponsibleUserId: "responsible-user",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Accepted plan already resumed",
      status: "in_review",
      priority: "medium",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });
    await db.insert(issueThreadInteractions).values({
      id: interactionId,
      companyId,
      issueId,
      kind: "request_confirmation",
      status: "accepted",
      continuationPolicy: "wake_assignee_on_accept",
      createdByAgentId: agentId,
      resolvedByUserId: "responsible-user",
      resolvedAt,
      updatedAt: resolvedAt,
      payload: { version: 1, prompt: "Approve the plan?" },
      result: { outcome: "accepted" },
    });
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "succeeded",
      contextSnapshot: {
        issueId,
        taskId: issueId,
        wakeReason: "issue_continuation_needed",
        retryReason: "issue_continuation_needed",
        mutation: "interaction",
        interactionId,
        interactionResolvedAt: resolvedAt.toISOString(),
      },
      createdAt: succeededAt,
      startedAt: succeededAt,
      finishedAt: succeededAt,
      updatedAt: succeededAt,
    });

    const heartbeat = createHeartbeat();
    const result = await heartbeat.reconcileStrandedAssignedIssues();

    expect(result.continuationRequeued).toBe(0);
    expect(result.escalated).toBe(0);
    expect(result.skipped).toBeGreaterThanOrEqual(1);
    const runs = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(1);
  });

  it("requeues accepted interaction continuations even when a later successful run is unrelated", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const interactionId = randomUUID();
    const resolvedAt = new Date("2026-03-19T00:05:00.000Z");
    const unrelatedRunAt = new Date("2026-03-19T00:06:00.000Z");
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      defaultResponsibleUserId: "responsible-user",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Accepted plan masked by unrelated run",
      status: "in_review",
      priority: "medium",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });
    await db.insert(issueThreadInteractions).values({
      id: interactionId,
      companyId,
      issueId,
      kind: "request_confirmation",
      status: "accepted",
      continuationPolicy: "wake_assignee_on_accept",
      createdByAgentId: agentId,
      resolvedByUserId: "responsible-user",
      resolvedAt,
      updatedAt: resolvedAt,
      payload: { version: 1, prompt: "Approve the plan?" },
      result: { outcome: "accepted" },
    });
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "succeeded",
      contextSnapshot: {
        issueId,
        taskId: issueId,
        wakeReason: "issue_assigned",
        source: "unrelated_followup",
      },
      startedAt: unrelatedRunAt,
      finishedAt: unrelatedRunAt,
      createdAt: unrelatedRunAt,
      updatedAt: unrelatedRunAt,
    });

    const heartbeat = createHeartbeat();
    const result = await heartbeat.reconcileStrandedAssignedIssues();

    expect(result.continuationRequeued).toBe(1);
    expect(result.issueIds).toEqual([issueId]);

    const runs = await db
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    const recoveryRun = runs.find(
      (row) => (row.contextSnapshot as Record<string, unknown> | null)?.source === "issue.interaction_continuation_recovery",
    );
    expect(recoveryRun?.contextSnapshot).toMatchObject({
      issueId,
      interactionId,
      interactionStatus: "accepted",
      source: "issue.interaction_continuation_recovery",
    });
  });

  // Scenario 5: enqueue-failure at accept time is no longer a silent permanent
  // stall. When the accept-time continuation wake is dropped (routes/issues.ts fire-and-forget
  // enqueue swallowed the error), the issue is left in_review with an accepted interaction but
  // *no* wake request and *no* run at all. Pre-P1 the recovery sweep skipped in_review issues
  // lacking an execution policy, so this limbo persisted forever. The sweep now requeues it.
  it("recovers a plan approval whose accept-time continuation wake enqueue was silently dropped", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const interactionId = randomUUID();
    const resolvedAt = new Date("2026-03-19T00:05:00.000Z");
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      defaultResponsibleUserId: "responsible-user",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Approved plan whose wake enqueue was dropped",
      status: "in_review",
      priority: "medium",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });
    await db.insert(issueThreadInteractions).values({
      id: interactionId,
      companyId,
      issueId,
      kind: "request_confirmation",
      status: "accepted",
      continuationPolicy: "wake_assignee_on_accept",
      createdByAgentId: agentId,
      resolvedByUserId: "responsible-user",
      resolvedAt,
      updatedAt: resolvedAt,
      payload: { version: 1, prompt: "Approve the plan?" },
      result: { outcome: "accepted" },
    });

    // Precondition of the silent-enqueue-drop bug: the accept produced no wake and no run.
    const priorWakeups = await db
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.companyId, companyId));
    expect(priorWakeups).toHaveLength(0);
    const priorRuns = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.companyId, companyId));
    expect(priorRuns).toHaveLength(0);

    const heartbeat = createHeartbeat();
    const result = await heartbeat.reconcileStrandedAssignedIssues();

    expect(result.continuationRequeued).toBe(1);
    expect(result.issueIds).toEqual([issueId]);

    const run = await db
      .select({ agentId: heartbeatRuns.agentId, contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId))
      .then((rows) => rows[0] ?? null);
    expect(run?.agentId).toBe(agentId);
    expect(run?.contextSnapshot).toMatchObject({
      issueId,
      interactionId,
      interactionStatus: "accepted",
      source: "issue.interaction_continuation_recovery",
    });

    const wakeup = await db
      .select({ payload: agentWakeupRequests.payload })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .then((rows) => rows[0] ?? null);
    expect(wakeup).not.toBeNull();
    expect((wakeup?.payload as Record<string, unknown> | null)?.issueId).toBe(issueId);
  });

  // Scenario 3 (restart durability): a bounded continuation retry scheduled
  // before a server restart survives it. Promotion is DB-driven (scheduled_retry rows +
  // promoteDueScheduledRetries), not an in-memory setTimeout — so a brand-new heartbeat
  // service instance with empty in-memory state still promotes the due retry.
  it("promotes a scheduled plan-approval continuation retry after a simulated server restart", async () => {
    const { companyId, agentId, runId, issueId } = await seedQueuedIssueRunFixture();
    const interactionId = randomUUID();
    const now = new Date("2026-03-19T00:10:00.000Z");

    await db.insert(issueThreadInteractions).values({
      id: interactionId,
      companyId,
      issueId,
      kind: "request_confirmation",
      status: "accepted",
      continuationPolicy: "wake_assignee_on_accept",
      createdByAgentId: agentId,
      resolvedByUserId: "responsible-user",
      resolvedAt: now,
      payload: {
        version: 1,
        prompt: "Approve the plan?",
        target: { type: "issue_document", issueId, key: "plan", revisionId: randomUUID() },
      },
      result: { version: 1, outcome: "accepted" },
    });
    await db
      .update(heartbeatRuns)
      .set({
        status: "failed",
        error: "workspace validation failed before dispatch",
        errorCode: "workspace_validation_failed",
        resultJson: {},
        finishedAt: now,
        contextSnapshot: {
          issueId,
          taskId: issueId,
          wakeReason: INTERACTION_CONTINUATION_INFRA_WAKE_REASON,
          retryReason: INTERACTION_CONTINUATION_INFRA_RETRY_REASON,
          mutation: "interaction",
          interactionId,
          interactionKind: "request_confirmation",
          interactionStatus: "accepted",
        },
      })
      .where(eq(heartbeatRuns.id, runId));
    await db
      .update(issues)
      .set({ status: "in_review", executionRunId: runId })
      .where(eq(issues.id, issueId));

    // Service instance that scheduled the retry (pre-restart).
    const preRestart = createHeartbeat();
    const scheduled = await preRestart.scheduleBoundedRetry(runId, {
      now,
      retryReason: INTERACTION_CONTINUATION_INFRA_RETRY_REASON,
      wakeReason: INTERACTION_CONTINUATION_INFRA_WAKE_REASON,
      maxAttempts: 3,
    });
    expect(scheduled.outcome).toBe("scheduled");
    if (scheduled.outcome !== "scheduled") return;

    const beforePromotion = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, scheduled.run.id))
      .then((rows) => rows[0] ?? null);
    expect(beforePromotion?.status).toBe("scheduled_retry");

    // Simulate a server restart: no in-memory process/timer state carries over.
    runningProcesses.clear();
    const restarted = createHeartbeat();
    const promotion = await restarted.promoteDueScheduledRetries(scheduled.dueAt);
    expect(promotion).toEqual({ promoted: 1, runIds: [scheduled.run.id] });

    const promoted = await db
      .select({ status: heartbeatRuns.status, retryOfRunId: heartbeatRuns.retryOfRunId })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, scheduled.run.id))
      .then((rows) => rows[0] ?? null);
    expect(promoted).toMatchObject({ status: "queued", retryOfRunId: runId });
  });

  it("still re-enqueues stranded assigned todo recovery when an old queued wake exists", async () => {
    const { companyId, agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "todo",
      runStatus: "failed",
    });
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      status: "queued",
    });

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.assignmentDispatched).toBe(0);
    expect(result.dispatchRequeued).toBe(1);
    expect(result.continuationRequeued).toBe(0);
    expect(result.escalated).toBe(0);
    expect(result.issueIds).toEqual([issueId]);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(2);

    const retryRun = runs.find((row) => row.id !== runId);
    expect((retryRun?.contextSnapshot as Record<string, unknown>)?.retryReason).toBe("assignment_recovery");
    expect(retryRun?.contextSnapshot as Record<string, unknown>).not.toHaveProperty("modelProfile");
    if (retryRun) {
      await waitForRunToSettle(heartbeat, retryRun.id);
    }
  });

  it("blocks assigned todo work after the one automatic dispatch recovery was already used", async () => {
    const { companyId, agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "todo",
      runStatus: "failed",
      retryReason: "assignment_recovery",
      runErrorCode: "process_lost",
      runError: "Authorization: Bearer sk-test-recovery-secret",
    });

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.dispatchRequeued).toBe(0);
    expect(result.escalated).toBe(1);
    expect(result.issueIds).toEqual([issueId]);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("blocked");

    const recovery = await expectStrandedRecoveryArtifacts({
      companyId,
      agentId,
      issueId,
      runId,
      previousStatus: "todo",
      retryReason: "assignment_recovery",
      cause: "process_lost",
    });
    expect(JSON.stringify(recovery.evidence)).not.toContain("sk-test-recovery-secret");
    // Positive: errorCode is surfaced (it's a stable classifier, not
    // sensitive). Redacted message text follows it so the recovery agent
    // can see what happened without leaking the embedded bearer token.
    expect(String(recovery.evidence.latestRunFailureSummary)).toContain("`process_lost`");
    expect(String(recovery.evidence.latestRunFailureSummary)).toContain("Authorization: Bearer ***REDACTED***");

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("retried dispatch");
    // Failure summary surfaces the errorCode (and a redacted error message
    // when present) so the recovery agent can see WHY the original assignee
    // failed without inspecting the linked run. Secrets are still scrubbed
    // — see the explicit `not.toContain` assertion above where applicable.
    expect(comments[0]?.body).toContain("Latest retry failure:");
    expect(comments[0]?.body).toContain(`Recovery action: \`${recovery.id}\``);
  });

  it("assigns open unassigned blockers back to their creator agent", async () => {
    const companyId = randomUUID();
    const creatorAgentId = randomUUID();
    const blockedAssigneeAgentId = randomUUID();
    const blockerIssueId = randomUUID();
    const blockedIssueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      defaultResponsibleUserId: "responsible-user",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: creatorAgentId,
        companyId,
        name: "SecurityEngineer",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: blockedAssigneeAgentId,
        companyId,
        name: "CodexCoder",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(issues).values([
      {
        id: blockerIssueId,
        companyId,
        title: "Fix blocker",
        status: "todo",
        priority: "high",
        createdByAgentId: creatorAgentId,
        responsibleUserId: "responsible-user",
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
      },
      {
        id: blockedIssueId,
        companyId,
        title: "Blocked work",
        status: "blocked",
        priority: "high",
        assigneeAgentId: blockedAssigneeAgentId,
        responsibleUserId: "responsible-user",
        issueNumber: 2,
        identifier: `${issuePrefix}-2`,
      },
    ]);
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerIssueId,
      relatedIssueId: blockedIssueId,
      type: "blocks",
      createdByAgentId: creatorAgentId,
    });

    const result = await heartbeat.reconcileStrandedAssignedIssues();

    expect(result.orphanBlockersAssigned).toBe(1);
    expect(result.issueIds).toContain(blockerIssueId);

    const blocker = await db
      .select()
      .from(issues)
      .where(eq(issues.id, blockerIssueId))
      .then((rows) => rows[0] ?? null);
    expect(blocker?.assigneeAgentId).toBe(creatorAgentId);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, blockerIssueId));
    expect(comments[0]?.body).toContain("Assigned Orphan Blocker");
    expect(comments[0]?.body).toContain(`[${issuePrefix}-2](/${issuePrefix}/issues/${issuePrefix}-2)`);

    const wakeups = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, creatorAgentId));
    expect(wakeups).toEqual([
      expect.objectContaining({
        reason: "issue_assigned",
        payload: expect.objectContaining({
          issueId: blockerIssueId,
          mutation: "unassigned_blocker_recovery",
        }),
      }),
    ]);

    const runId = wakeups[0]?.runId;
    if (runId) {
      await waitForRunToSettle(heartbeat, runId);
    }
  });

  it("re-enqueues continuation for stranded in-progress work with no active run", async () => {
    const { companyId, agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "failed",
    });

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.dispatchRequeued).toBe(0);
    expect(result.continuationRequeued).toBe(1);
    expect(result.escalated).toBe(0);
    expect(result.issueIds).toEqual([issueId]);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(2);

    const retryRun = runs.find((row) => row.id !== runId);
    expect(retryRun?.id).toBeTruthy();
    expect((retryRun?.contextSnapshot as Record<string, unknown>)?.retryReason).toBe("issue_continuation_needed");
    expect(retryRun?.contextSnapshot as Record<string, unknown>).not.toHaveProperty("modelProfile");
    if (retryRun) {
      await waitForRunToSettle(heartbeat, retryRun.id);
    }
  });

  it("does not continue seeded in-progress work that has no run linkage", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      defaultResponsibleUserId: "responsible-user",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Seeded in-flight work",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      checkoutRunId: null,
      executionRunId: null,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      startedAt: new Date("2026-03-19T00:00:00.000Z"),
    });

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.dispatchRequeued).toBe(0);
    expect(result.continuationRequeued).toBe(0);
    expect(result.escalated).toBe(0);
    expect(result.skipped).toBe(1);

    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(0);
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue?.status).toBe("in_progress");
    expect(issue?.executionRunId).toBeNull();
  });

  it("classifies actionable plan-only recovery and enqueues one liveness continuation", async () => {
    mockAdapterExecute.mockResolvedValueOnce({
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      summary: "I will inspect the repo next and then implement the fix.",
      provider: "test",
      model: "test-model",
      resultJson: { summary: "I will inspect the repo next and then implement the fix." },
    });
    const { agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "failed",
    });

    await heartbeat.reconcileStrandedAssignedIssues();

    const livenessWake = await waitForValue(async () => {
      const rows = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
      return rows.find((row) => row.reason === "run_liveness_continuation") ?? null;
    });
    expect(livenessWake).toBeTruthy();
    expect(livenessWake?.payload).toMatchObject({
      issueId,
      livenessState: "plan_only",
      continuationAttempt: 1,
    });

    const sourceRunId = (livenessWake?.payload as Record<string, unknown> | null)?.sourceRunId;
    expect(sourceRunId).toBeTruthy();
    const sourceRun = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, String(sourceRunId)))
      .then((rows) => rows[0] ?? null);
    if (sourceRun?.id) {
      await waitForRunToSettle(heartbeat, sourceRun.id, 5_000);
    }
    expect(sourceRun?.id).not.toBe(runId);
    expect(sourceRun?.livenessState).toBe("plan_only");
  });

  it("treats a plan document update as progress and does not enqueue liveness continuation", async () => {
    const { agentId, companyId, issueId, runId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "failed",
    });
    mockAdapterExecute.mockImplementationOnce(async (ctx: { runId: string }) => {
      const documentId = randomUUID();
      const revisionId = randomUUID();
      await db.insert(documents).values({
        id: documentId,
        companyId,
        title: "Plan",
        format: "markdown",
        latestBody: "# Plan\n\n- Inspect files\n- Implement fix",
        latestRevisionId: revisionId,
        latestRevisionNumber: 1,
        createdByAgentId: agentId,
        updatedByAgentId: agentId,
      });
      await db.insert(documentRevisions).values({
        id: revisionId,
        companyId,
        documentId,
        revisionNumber: 1,
        title: "Plan",
        format: "markdown",
        body: "# Plan\n\n- Inspect files\n- Implement fix",
        createdByAgentId: agentId,
        createdByRunId: ctx.runId,
      });
      await db.insert(issueDocuments).values({
        companyId,
        issueId,
        documentId,
        key: "plan",
      });
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        summary: "Plan:\n- Inspect files\n- Implement fix",
        provider: "test",
        model: "test-model",
        resultJson: { summary: "Plan:\n- Inspect files\n- Implement fix" },
      };
    });

    await heartbeat.reconcileStrandedAssignedIssues();

    const retryRun = await waitForValue(async () => {
      const rows = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
      return rows.find((row) => row.id !== runId && row.livenessState === "advanced") ?? null;
    }, 120_000);
    if (retryRun?.id) {
      await waitForRunToSettle(heartbeat, retryRun.id, 5_000);
    }
    expect(retryRun?.livenessState).toBe("advanced");

    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakes.some((row) => row.reason === "run_liveness_continuation")).toBe(false);
  });
  it("blocks stranded in-progress work after the continuation retry was already used", async () => {
    const { companyId, agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "failed",
      retryReason: "issue_continuation_needed",
      // BLO-16182: default-classified code — escalates at one attempt
      // (process_lost is now transient / 3-attempt).
      runErrorCode: "adapter_exit_code",
    });

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.continuationRequeued).toBe(0);
    expect(result.escalated).toBe(1);
    expect(result.issueIds).toEqual([issueId]);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("blocked");

    const recovery = await expectStrandedRecoveryArtifacts({
      companyId,
      agentId,
      issueId,
      runId,
      previousStatus: "in_progress",
      retryReason: "issue_continuation_needed",
    });

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("retried continuation");
    // Failure summary surfaces the errorCode (and a redacted error message
    // when present) so the recovery agent can see WHY the original assignee
    // failed without inspecting the linked run. Secrets are still scrubbed
    // — see the explicit `not.toContain` assertion above where applicable.
    expect(comments[0]?.body).toContain("Latest retry failure:");
    expect(comments[0]?.body).toContain(`Recovery action: \`${recovery.id}\``);
  });

  it("emits issue.escalation.needs_human_decision once when stranded assigned recovery blocks the issue", async () => {
    const { companyId, agentId, issueId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "failed",
      retryReason: "issue_continuation_needed",
      // BLO-16182: default-classified code — escalates at one attempt
      // (process_lost is now transient / 3-attempt).
      runErrorCode: "adapter_exit_code",
    });

    const firstResult = await heartbeat.reconcileStrandedAssignedIssues();
    expect(firstResult.escalated).toBe(1);

    const event = await waitForValue(async () => {
      await drainOutbox();
      return emittedPluginEvents.find(
        (item) => item.eventType === "issue.escalation.needs_human_decision" && item.entityId === issueId,
      ) ?? null;
    });

    expect(event).toMatchObject({
      eventType: "issue.escalation.needs_human_decision",
      actorType: "system",
      actorId: "system",
      entityType: "issue",
      entityId: issueId,
      companyId,
      payload: expect.objectContaining({
        issueId,
        identifier: expect.stringMatching(/^T[A-F0-9]{6}-1$/),
        title: "Recover stranded assigned work",
        assigneeAgentId: agentId,
        assigneeAgentName: "CodexCoder",
        blockedByIssueIds: [],
        originSweep: "recovery.reconcile_stranded_assigned_issue",
        transitionedAt: expect.any(String),
      }),
    });
    expect(new Date(String((event?.payload as { transitionedAt?: string } | undefined)?.transitionedAt)).toString()).not.toBe("Invalid Date");

    for (let index = 0; index < 2; index += 1) {
      const repeatResult = await heartbeat.reconcileStrandedAssignedIssues();
      expect(repeatResult.escalated).toBe(0);
    }

    await drainOutbox();
    const matchingEvents = emittedPluginEvents.filter(
      (item) => item.eventType === "issue.escalation.needs_human_decision" && item.entityId === issueId,
    );
    expect(matchingEvents).toHaveLength(1);
  });

  // BLO-1498/BLO-5691: when an in-progress run fails with a non-retryable
  // workspace precondition, the recovery sweep must escalate to `blocked` on
  // the FIRST failure. Retrying would re-hit the same precondition and produce
  // another doomed run.
  it.each(["workspace_import_conflict", "workspace_repo_mismatch"])(
    "blocks stranded in-progress work immediately on non-retryable %s (no retry burnt)",
    async (runErrorCode) => {
    const { companyId, agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "failed",
      // Crucially: no retryReason, so didAutomaticRecoveryFail() is FALSE.
      // The non-retryable errorCode is what must trigger escalation.
      runErrorCode,
      runError: "Workspace import into /srv/paperclip/workspace hit 1 path conflict: release-eng-tmp/magma-blo-1475/orc8r/cloud/go/serde/doc.go",
    });

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.continuationRequeued).toBe(0);
    expect(result.escalated).toBe(1);
    expect(result.issueIds).toEqual([issueId]);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("blocked");

    // Recovery artifact still gets created so the recovery owner has somewhere
    // to act, but no continuation wake is queued for the source agent.
    await expectStrandedRecoveryArtifacts({
      companyId,
      agentId,
      issueId,
      runId,
      previousStatus: "in_progress",
      retryReason: "unknown",
    });
    const wakeRows = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakeRows.some((row) => row.reason === "issue_continuation_needed")).toBe(false);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain(`non-retryable code \`${runErrorCode}\``);
    expect(comments[0]?.body).toContain("Retrying would re-hit the same environment precondition");
  });

  // BLO-1498: same non-retryable rule applies to assigned `todo` work that
  // failed in dispatch. We must not burn the single dispatch retry against a
  // precondition that won't change.
  it.each(["workspace_import_conflict", "workspace_repo_mismatch"])(
    "blocks assigned todo work immediately on non-retryable %s (no retry burnt)",
    async (runErrorCode) => {
    const { companyId, agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "todo",
      runStatus: "failed",
      runErrorCode,
      runError: "Workspace import into /srv/paperclip/workspace hit 1 path conflict",
    });

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.dispatchRequeued).toBe(0);
    expect(result.escalated).toBe(1);
    expect(result.issueIds).toEqual([issueId]);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("blocked");

    await expectStrandedRecoveryArtifacts({
      companyId,
      agentId,
      issueId,
      runId,
      previousStatus: "todo",
      retryReason: "unknown",
    });

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain(`non-retryable code \`${runErrorCode}\``);
  });

  // BLO-5681 / BLO-10889 (BLO-10866 WS2): when a stranded source issue's
  // latest terminal failure is a structural zero-token pre-model startup
  // wedge (context_overflow / context_length_exceeded / startup_error_pre_model),
  // do NOT spawn a stranded_issue_recovery wrapper — a wrapper inherits the
  // same wedged session and produces another zero-token failed run. Instead
  // of escalating straight to `blocked` on the FIRST occurrence, clear the
  // agent's persisted task session and retry ONCE (BLO-10889) — a fresh
  // session breaks the BLO-5378 → BLO-5676-style loop when the wedge really
  // was session-poisoning, without giving up the same-agent self-heal that
  // BLO-10866 identified as missing.
  it("resets the task session and retries once on a zero-token context_overflow startup failure, instead of blocking immediately (BLO-10889)", async () => {
    const { companyId, agentId, issueId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "failed",
      retryReason: "issue_continuation_needed",
      runErrorCode: "context_overflow",
      runError: "Context window exceeded before first model turn",
      runUsageJson: { inputTokens: 0, outputTokens: 0 },
    });

    // Simulate a persisted task session for this issue so we can prove it
    // gets cleared rather than resumed by the retry.
    await db.insert(agentTaskSessions).values({
      companyId,
      agentId,
      adapterType: "codex_local",
      taskKey: issueId,
      sessionParamsJson: { sessionId: "poisoned-session-1" },
      sessionDisplayId: "poisoned-session-1",
    });

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.continuationRequeued).toBe(0);
    expect(result.escalated).toBe(0);
    expect(result.zeroTokenStartupFailureBlocked).toBe(0);
    expect(result.zeroTokenSessionResetRetried).toBe(1);
    expect(result.issueIds).toEqual([issueId]);

    // Issue stays in_progress — this is a retry, not an escalation.
    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("in_progress");

    // No stranded_issue_recovery wrapper — same rationale as BLO-5681, the
    // retry is a direct wake on the same agent/issue, not a sub-issue.
    const recoveryWrappers = await db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, "stranded_issue_recovery"),
          eq(issues.originId, issueId),
        ),
      );
    expect(recoveryWrappers).toHaveLength(0);

    // The poisoned task session was cleared.
    const remainingSessions = await db
      .select()
      .from(agentTaskSessions)
      .where(and(eq(agentTaskSessions.companyId, companyId), eq(agentTaskSessions.agentId, agentId)));
    expect(remainingSessions).toHaveLength(0);

    // A fresh retry wake WAS dispatched (unlike BLO-5681's no-wrapper case,
    // which suppresses the wake entirely because a reset makes the retry safe).
    const wakeRows = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakeRows.some((row) => row.reason === "issue_zero_token_session_reset")).toBe(true);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("zero-token startup wedge");
    expect(comments[0]?.body).toContain("reset");
  });

  // BLO-10889: if the reset-and-retry attempt ALSO fails with the same
  // zero-token signature, the wedge isn't session-poisoning (or the reset
  // didn't help) — fall back to the original BLO-5681 blocked-escalation
  // instead of resetting forever.
  it("escalates to blocked when the reset-and-retry attempt itself fails with zero tokens again (BLO-10889)", async () => {
    const { companyId, agentId, issueId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "failed",
      retryReason: "zero_token_session_reset",
      runErrorCode: "context_overflow",
      runError: "Context window exceeded before first model turn",
      runUsageJson: { inputTokens: 0, outputTokens: 0 },
    });

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.continuationRequeued).toBe(0);
    expect(result.zeroTokenSessionResetRetried).toBe(0);
    expect(result.escalated).toBe(1);
    expect(result.zeroTokenStartupFailureBlocked).toBe(1);
    expect(result.issueIds).toEqual([issueId]);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("blocked");

    const recoveryWrappers = await db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, "stranded_issue_recovery"),
          eq(issues.originId, issueId),
        ),
      );
    expect(recoveryWrappers).toHaveLength(0);

    // No further retry wake — the one-shot reset already happened.
    const wakeRows = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakeRows.some((row) => row.reason === "issue_continuation_needed")).toBe(false);
    expect(wakeRows.some((row) => row.reason === "issue_zero_token_session_reset")).toBe(false);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("context_overflow");
    expect(comments[0]?.body).toContain("burned zero tokens");
    expect(comments[0]?.body).toContain("BLO-5681");
  });

  // BLO-5681 / BLO-10889: same reset-and-retry-then-escalate shape fires in
  // the assigned-todo branch. An absent usage blob counts as zero work, so a
  // startup_error_pre_model failure with no usageJson at all still routes
  // through the reset-and-retry path on its first occurrence.
  it("resets the task session and retries once on a zero-token startup_error_pre_model failure for an assigned todo issue (BLO-10889)", async () => {
    const { companyId, issueId } = await seedStrandedIssueFixture({
      status: "todo",
      runStatus: "failed",
      runErrorCode: "startup_error_pre_model",
      runError: "Adapter crashed before the first model turn",
    });

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.dispatchRequeued).toBe(0);
    expect(result.escalated).toBe(0);
    expect(result.zeroTokenStartupFailureBlocked).toBe(0);
    expect(result.zeroTokenSessionResetRetried).toBe(1);
    expect(result.issueIds).toEqual([issueId]);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("todo");

    const recoveryWrappers = await db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, "stranded_issue_recovery"),
          eq(issues.originId, issueId),
        ),
      );
    expect(recoveryWrappers).toHaveLength(0);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("zero-token startup wedge");
    expect(comments[0]?.body).toContain("reset");
  });

  it("blocks assigned todo work when the reset-and-retry attempt itself fails with zero tokens again (BLO-10889)", async () => {
    const { companyId, issueId } = await seedStrandedIssueFixture({
      status: "todo",
      runStatus: "failed",
      retryReason: "zero_token_session_reset",
      runErrorCode: "startup_error_pre_model",
      runError: "Adapter crashed before the first model turn",
    });

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.dispatchRequeued).toBe(0);
    expect(result.zeroTokenSessionResetRetried).toBe(0);
    expect(result.escalated).toBe(1);
    expect(result.zeroTokenStartupFailureBlocked).toBe(1);
    expect(result.issueIds).toEqual([issueId]);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("blocked");

    const recoveryWrappers = await db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, "stranded_issue_recovery"),
          eq(issues.originId, issueId),
        ),
      );
    expect(recoveryWrappers).toHaveLength(0);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("startup_error_pre_model");
    expect(comments[0]?.body).toContain("skipped automatic dispatch recovery");
  });

  // BLO-5681 counterfactual: a transient `rate_limit_exhausted` retry
  // failure must STILL create a source-scoped recovery action. The zero-token
  // gate must not over-trigger on transient failure codes that happen to
  // report zero usage on the failing attempt.
  it("still creates a recovery action for a transient rate_limit_exhausted continuation retry, even at zero tokens (BLO-5681 counterfactual)", async () => {
    const { companyId, agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "failed",
      retryReason: "issue_continuation_needed",
      runErrorCode: "rate_limit_exhausted",
      runError: "Provider rate limit exhausted",
      runUsageJson: { inputTokens: 0, outputTokens: 0 },
    });

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.escalated).toBe(1);
    expect(result.zeroTokenStartupFailureBlocked).toBe(0);
    expect(result.issueIds).toEqual([issueId]);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("blocked");

    // Source-scoped recovery action path is unchanged: the action still exists,
    // but no issue-backed wrapper is created for the source.
    await expectStrandedRecoveryArtifacts({
      companyId,
      agentId,
      issueId,
      runId,
      previousStatus: "in_progress",
      retryReason: "issue_continuation_needed",
    });
  });

  it("redacts error-code-only stranded recovery failures in issue copy", async () => {
    const { companyId, agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "failed",
      retryReason: "issue_continuation_needed",
      runErrorCode: "adapter_exit_code",
      runError: null,
    });

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.escalated).toBe(1);

    const recovery = await expectStrandedRecoveryArtifacts({
      companyId,
      agentId,
      issueId,
      runId,
      previousStatus: "in_progress",
      retryReason: "issue_continuation_needed",
    });
    expect(String(recovery.evidence.latestRunFailureSummary)).toContain("Latest retry failure:");
    expect(String(recovery.evidence.latestRunFailureSummary)).toContain("`adapter_exit_code`");
    expect(String(recovery.evidence.latestRunFailureSummary)).not.toContain("- Failure: none recorded");

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(1);
    // Failure summary surfaces the errorCode (and a redacted error message
    // when present) so the recovery agent can see WHY the original assignee
    // failed without inspecting the linked run. Secrets are still scrubbed
    // — see the explicit `not.toContain` assertion above where applicable.
    expect(comments[0]?.body).toContain("Latest retry failure:");
    expect(comments[0]?.body).not.toContain("- Failure: none recorded");
  });

  it("renders the original assignee's MCPs and capability blurb in the recovery prompt", async () => {
    // BLO-3182 reproducer: original assignee has MCPs (figma, webflow) the
    // recovery agent doesn't. The prompt must surface these so the recovery
    // agent doesn't reflexively reassign.
    const { companyId, agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "failed",
      retryReason: "issue_continuation_needed",
      runErrorCode: "adapter_exit_code",
      runError: null,
    });
    // Decorate the seeded agent with mcpServers + a capability blurb,
    // mirroring the live UXDesigner config that BLO-3182 was originally
    // assigned to.
    await db
      .update(agents)
      .set({
        capabilities: "Owns frontend execution + Webflow CMS edits.",
        adapterConfig: {
          mcpServers: {
            figma: { url: "http://figma-mcp.example", type: "http" },
            webflow: { url: "http://webflow-mcp.example", type: "http" },
          },
        },
      })
      .where(eq(agents.id, agentId));

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.escalated).toBe(1);

    const recovery = await expectStrandedRecoveryArtifacts({
      companyId,
      agentId,
      issueId,
      runId,
      previousStatus: "in_progress",
      retryReason: "issue_continuation_needed",
    });
    expect(recovery.evidence.originalAssigneeMcpKeys).toEqual(["figma", "webflow"]);
    expect(recovery.evidence.originalAssigneeCapabilities).toContain("Owns frontend execution + Webflow CMS edits.");
    // Reminder line nudges the recovery agent to compare capabilities
    // before reassigning.
    expect(recovery.nextAction).toContain("Restore a live execution path");
  });

  it("keeps retrying transient adapter_failed continuation runs before the cap", async () => {
    const { agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "failed",
      retryReason: "issue_continuation_needed",
      runErrorCode: "adapter_failed",
      runError: "ssh: connection reset",
    });
    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.continuationRequeued).toBe(1);
    expect(result.escalated).toBe(0);
    expect(result.issueIds).toEqual([issueId]);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("in_progress");

    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(2);
    const retryRun = runs.find((row) => row.id !== runId);
    expect(retryRun?.contextSnapshot as Record<string, unknown> | undefined).toMatchObject({
      issueId,
      retryReason: "issue_continuation_needed",
      source: "issue.continuation_recovery",
    });
    if (retryRun) {
      await waitForRunToSettle(heartbeat, retryRun.id);
    }
  });

  it("reuses the raced stranded recovery action when duplicate active recovery creation conflicts", async () => {
    const { companyId, issueId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "failed",
      retryReason: "issue_continuation_needed",
      // BLO-16182: default-classified code — escalates at one attempt
      // (process_lost is now transient / 3-attempt).
      runErrorCode: "adapter_exit_code",
    });

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => heartbeat.reconcileStrandedAssignedIssues()),
    );
    expect(results.every((result) => result.status === "fulfilled")).toBe(true);

    const actions = await db
      .select()
      .from(issueRecoveryActions)
      .where(and(
        eq(issueRecoveryActions.companyId, companyId),
        eq(issueRecoveryActions.sourceIssueId, issueId),
        eq(issueRecoveryActions.status, "active"),
      ));
    expect(actions).toHaveLength(1);
    expect(actions[0]?.attemptCount).toBe(8);
    await expect(sourceBlockerIssueIds(companyId, issueId)).resolves.toEqual([]);
  });

  it("blocks stranded recovery issues in place instead of creating nested recovery issues", async () => {
    const sourceIssueId = randomUUID();
    const { companyId, agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "failed",
    });
    await db
      .update(issues)
      .set({
        title: "Recover stalled issue PAP-1",
        originKind: "stranded_issue_recovery",
        originId: sourceIssueId,
      })
      .where(eq(issues.id, issueId));
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(issues).values({
      id: sourceIssueId,
      companyId,
      title: "Original stranded source",
      status: "blocked",
      priority: "medium",
      issueNumber: 2,
      identifier: `${issuePrefix}-2`,
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId,
      relatedIssueId: sourceIssueId,
      type: "blocks",
    });

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.dispatchRequeued).toBe(0);
    expect(result.continuationRequeued).toBe(0);
    expect(result.escalated).toBe(1);
    expect(result.issueIds).toEqual([issueId]);

    const recoveryIssue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(recoveryIssue?.status).toBe("blocked");
    expect(recoveryIssue?.assigneeAgentId).toBe(agentId);
    expect(recoveryIssue?.originKind).toBe("stranded_issue_recovery");
    expect(recoveryIssue?.originId).toBe(sourceIssueId);

    const nestedRecoveries = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stranded_issue_recovery"), eq(issues.originId, issueId)));
    expect(nestedRecoveries).toHaveLength(0);

    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.id).toBe(runId);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("stopped automatic stranded-work recovery");
    // Failure summary surfaces the errorCode (and a redacted error message
    // when present) so the recovery agent can see WHY the original assignee
    // failed without inspecting the linked run. Secrets are still scrubbed
    // — see the explicit `not.toContain` assertion above where applicable.
    expect(comments[0]?.body).toContain("Latest retry failure:");
    expect(comments[0]?.body).toContain("recovery issues do not create nested `stranded_issue_recovery` issues");
    await expect(sourceBlockerIssueIds(companyId, sourceIssueId)).resolves.toEqual([issueId]);
  });

  it("does not create recovery blockers for provider quota exhaustion", async () => {
    const { companyId, issueId, runId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "failed",
      retryReason: "issue_continuation_needed",
      runErrorCode: "provider_quota_exhausted",
      runError: "provider quota exhausted; resets later",
    });
    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.dispatchRequeued).toBe(0);
    expect(result.continuationRequeued).toBe(0);
    expect(result.escalated).toBe(0);
    expect(result.skipped).toBeGreaterThanOrEqual(1);
    expect(result.issueIds).not.toContain(issueId);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("in_progress");
    expect(issue?.checkoutRunId).toBe(runId);

    const recoveryIssues = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stranded_issue_recovery"), eq(issues.originId, issueId)));
    expect(recoveryIssues).toHaveLength(0);

    await expect(sourceBlockerIssueIds(companyId, issueId)).resolves.toEqual([]);
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(0);
  });

  it("keeps repeated recovery failures on the same canonical recovery issue", async () => {
    const sourceIssueId = randomUUID();
    const { companyId, agentId, issueId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "failed",
    });
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(issues).values({
      id: sourceIssueId,
      companyId,
      title: "Original stranded source",
      status: "blocked",
      priority: "medium",
      issueNumber: 2,
      identifier: `${issuePrefix}-2`,
    });
    await db
      .update(issues)
      .set({
        title: "Recover stalled issue PAP-1",
        originKind: "stranded_issue_recovery",
        originId: sourceIssueId,
      })
      .where(eq(issues.id, issueId));
    await db.insert(issueRelations).values({
      companyId,
      issueId,
      relatedIssueId: sourceIssueId,
      type: "blocks",
    });

    const firstResult = await heartbeat.reconcileStrandedAssignedIssues();
    expect(firstResult.escalated).toBe(1);
    expect(firstResult.issueIds).toEqual([issueId]);

    const secondRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: secondRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "failed",
      contextSnapshot: {
        issueId,
        taskId: issueId,
        wakeReason: "issue_assigned",
        source: "stranded_issue_recovery",
      },
      startedAt: new Date("2030-03-19T00:10:00.000Z"),
      finishedAt: new Date("2030-03-19T00:15:00.000Z"),
      createdAt: new Date("2030-03-19T00:10:00.000Z"),
      updatedAt: new Date("2030-03-19T00:15:00.000Z"),
      errorCode: "adapter_failed",
      error: "adapter failed while retrying recovery issue",
    });
    await db
      .update(issues)
      .set({
        status: "in_progress",
        checkoutRunId: secondRunId,
        executionRunId: null,
      })
      .where(eq(issues.id, issueId));

    const secondResult = await heartbeat.reconcileStrandedAssignedIssues();
    expect(secondResult.dispatchRequeued).toBe(0);
    expect(secondResult.continuationRequeued).toBe(0);
    expect(secondResult.escalated).toBe(1);
    expect(secondResult.issueIds).toEqual([issueId]);

    const recoveryIssuesForSource = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stranded_issue_recovery"), eq(issues.originId, sourceIssueId)));
    expect(recoveryIssuesForSource.map((issue) => issue.id)).toEqual([issueId]);

    const nestedRecoveries = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stranded_issue_recovery"), eq(issues.originId, issueId)));
    expect(nestedRecoveries).toHaveLength(0);
    await expect(sourceBlockerIssueIds(companyId, sourceIssueId)).resolves.toEqual([issueId]);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(2);
    expect(comments[1]?.body).toContain("Latest retry failure:");
  });

  it("does not escalate paused-tree recovery when the automatic continuation retry was cancelled by the hold", async () => {
    const { companyId, agentId, issueId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "cancelled",
      retryReason: "issue_continuation_needed",
      activePauseHold: true,
    });

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.dispatchRequeued).toBe(0);
    expect(result.continuationRequeued).toBe(0);
    expect(result.escalated).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.issueIds).toEqual([]);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("in_progress");
    expect(issue?.checkoutRunId).toBeTruthy();

    const recoveryIssues = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stranded_issue_recovery")));
    expect(recoveryIssues).toHaveLength(0);

    const blockerRelations = await db
      .select()
      .from(issueRelations)
      .where(
        and(
          eq(issueRelations.companyId, companyId),
          eq(issueRelations.relatedIssueId, issueId),
          eq(issueRelations.type, "blocks"),
        ),
      );
    expect(blockerRelations).toHaveLength(0);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(0);

    const wakeups = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakeups).toHaveLength(1);
  });

  it("records productive continuation instead of recovery when the latest automatic continuation succeeded", async () => {
    const { agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "succeeded",
      retryReason: "issue_continuation_needed",
      livenessState: "advanced",
    });

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.continuationRequeued).toBe(0);
    expect(result.productiveContinuationObserved).toBe(1);
    expect(result.successfulContinuationObserved).toBe(0);
    expect(result.escalated).toBe(0);
    expect(result.issueIds).toEqual([]);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("in_progress");

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(0);

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(2);
    const retryRun = runs.find((row) => row.id !== runId);
    expect(retryRun?.contextSnapshot as Record<string, unknown> | undefined).toMatchObject({
      issueId,
      taskId: issueId,
      retryReason: "issue_continuation_needed",
      retryOfRunId: runId,
      source: "issue.productive_terminal_continuation_recovery",
    });
    expect(retryRun?.contextSnapshot as Record<string, unknown>).not.toHaveProperty("modelProfile");

    const wakeups = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakeups).toHaveLength(2);
  });


  it("does not accept unmanaged local-background wait evidence as a live continuation path", async () => {
    const localWaitEvidence = {
      summary: "Started a local polling watcher and will check the log later.",
      externalWait: {
        kind: "local_background",
        pid: 12345,
        logPath: "run/watch.log",
        durable: false,
      },
    };
    const { agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "succeeded",
      livenessState: "advanced",
      resultJson: localWaitEvidence,
    });
    const heartbeat = createHeartbeat();

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.continuationRequeued).toBe(1);
    expect(result.escalated).toBe(0);
    expect(result.issueIds).toEqual([issueId]);

    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    const retryRun = runs.find((row) => row.id !== runId);
    expect(retryRun?.contextSnapshot as Record<string, unknown> | undefined).toMatchObject({
      issueId,
      retryReason: "issue_continuation_needed",
      retryOfRunId: runId,
      source: "issue.productive_terminal_continuation_recovery",
    });
    expect(retryRun?.contextSnapshot as Record<string, unknown>).not.toHaveProperty("modelProfile");
  });

  it("escalates repeated unmanaged local-background waits instead of retrying forever", async () => {
    const localWaitEvidence = {
      summary: "Still waiting on the local background watcher.",
      externalWait: {
        kind: "local_background",
        pid: 12345,
        logPath: "run/watch.log",
        durable: false,
      },
    };
    const { companyId, agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "succeeded",
      retryReason: "issue_continuation_needed",
      runSource: "issue.productive_terminal_continuation_recovery",
      livenessState: "advanced",
      resultJson: localWaitEvidence,
    });
    const heartbeat = createHeartbeat();

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.continuationRequeued).toBe(0);
    expect(result.escalated).toBe(1);
    expect(result.issueIds).toEqual([issueId]);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("blocked");

    await expectSourceScopedStrandedRecoveryAction({
      companyId,
      agentId,
      issueId,
      runId,
      previousStatus: "in_progress",
      retryReason: "issue_continuation_needed",
    });

    const followupRuns = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    expect(followupRuns).toHaveLength(2);
  });

  it("preserves a persisted issue monitor as the durable external-wait path", async () => {
    const { companyId, agentId, issueId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "succeeded",
      livenessState: "advanced",
      monitorNextCheckAt: new Date("2026-03-19T01:00:00.000Z"),
      resultJson: {
        summary: "Waiting for the deploy to settle; monitor is scheduled.",
        externalWait: { kind: "issue_monitor", durable: true },
      },
    });
    const heartbeat = createHeartbeat();

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.continuationRequeued).toBe(0);
    expect(result.escalated).toBe(0);
    expect(result.skipped).toBe(1);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("in_progress");
    expect(issue?.monitorNextCheckAt?.toISOString()).toBe("2026-03-19T01:00:00.000Z");

    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(1);
    const recoveryIssues = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stranded_issue_recovery")));
    expect(recoveryIssues).toHaveLength(0);
  });

  it("preserves a delegated blocker edge as the durable external-wait path", async () => {
    const { companyId, agentId, issueId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "succeeded",
      livenessState: "advanced",
      resultJson: {
        summary: "Delegated the external account check to a child task.",
        externalWait: { kind: "delegated_child", durable: true },
      },
    });
    const blockerIssueId = randomUUID();
    await db.insert(issues).values({
      id: blockerIssueId,
      companyId,
      parentId: issueId,
      title: "Check external account approval",
      status: "todo",
      priority: "medium",
      assigneeUserId: "external-owner",
      responsibleUserId: "responsible-user",
      issueNumber: 2,
      identifier: "PAP-2",
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerIssueId,
      relatedIssueId: issueId,
      type: "blocks",
    });
    const heartbeat = createHeartbeat();

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.continuationRequeued).toBe(0);
    expect(result.escalated).toBe(0);
    expect(result.skipped).toBe(1);

    const source = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(source?.status).toBe("in_progress");
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(1);
  });

  it("blocks stranded in-progress work after a productive continuation retry was already used", async () => {
    const { companyId, agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "succeeded",
      retryReason: "issue_continuation_needed",
      livenessState: null,
    });
    // Seed 4 additional non-productive succeeded runs (5 total counting
    // the fixture's run). createdAt offsets so the lookback orders them
    // most-recent-first and walks them all before bailing.
    const baseTs = new Date("2026-03-19T00:05:00.000Z");
    for (let i = 0; i < 4; i++) {
      const ts = new Date(baseTs.getTime() + (i + 1) * 60_000);
      await db.insert(heartbeatRuns).values({
        id: randomUUID(),
        companyId,
        agentId,
        invocationSource: "automation",
        triggerDetail: "system",
        status: "succeeded",
        contextSnapshot: { issueId, taskId: issueId },
        startedAt: ts,
        finishedAt: ts,
        createdAt: ts,
        updatedAt: ts,
        livenessState: null,
      });
    }

    const result = await heartbeat.reconcileStrandedAssignedIssues();

    expect(result.escalated).toBe(1);
    expect(result.issueIds).toEqual([issueId]);
    expect(result.continuationRequeued).toBe(0);
    expect(result.productiveContinuationObserved).toBe(0);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("blocked");

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("consecutive succeeded heartbeat runs producing no actionable output");
    expect(comments[0]?.body).toContain("No response requested.");
    expect(comments[0]?.body).toContain("`blocked`");
  });

  it("escalates when liveness reads `advanced` but the run summary admits no change (BLO-3182 RCA #2)", async () => {
    // 2026-05-06 RCA: UXDesigner waking on heartbeat-timer for BLO-3182
    // had livenessState=advanced ("Run produced concrete action evidence:
    // 1 activity event(s)") because the agent fetched the inbox or read
    // a comment, but the run's own resultJson.summary said "No change.
    // Exiting." The pre-RCA streak counter trusted liveness as the
    // oracle, so the streak never accumulated and the no-op loop
    // escalation never fired. Override: explicit no-op summaries count
    // as non-productive even when liveness disagrees.
    const { companyId, agentId, issueId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "succeeded",
      retryReason: "issue_continuation_needed",
      livenessState: "advanced",
      resultJson: { summary: "No change. Exiting.", result: "No change. Exiting." },
    });
    const baseTs = new Date("2026-03-19T00:05:00.000Z");
    for (let i = 0; i < 4; i++) {
      const ts = new Date(baseTs.getTime() + (i + 1) * 60_000);
      await db.insert(heartbeatRuns).values({
        id: randomUUID(),
        companyId,
        agentId,
        invocationSource: "automation",
        triggerDetail: "system",
        status: "succeeded",
        contextSnapshot: { issueId, taskId: issueId },
        startedAt: ts,
        finishedAt: ts,
        createdAt: ts,
        updatedAt: ts,
        livenessState: "advanced",
        resultJson: { summary: "No change. Exiting.", result: "No change. Exiting." },
      });
    }

    const result = await heartbeat.reconcileStrandedAssignedIssues();

    expect(result.escalated).toBe(1);
    expect(result.issueIds).toEqual([issueId]);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("blocked");
  });

  it("does NOT escalate when one productive run breaks the non-productive streak", async () => {
    // Same setup as above but the most-recent run is productive
    // (livenessState=advanced) — the no-op detector should treat the
    // streak as broken and skip without escalation, even if older runs
    // were non-productive.
    const { companyId, agentId, issueId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "succeeded",
      retryReason: "issue_continuation_needed",
      livenessState: "advanced",
    });
    // Seed 4 older non-productive succeeded runs at earlier timestamps.
    const earlyTs = new Date("2026-03-18T00:00:00.000Z");
    for (let i = 0; i < 4; i++) {
      const ts = new Date(earlyTs.getTime() + i * 60_000);
      await db.insert(heartbeatRuns).values({
        id: randomUUID(),
        companyId,
        agentId,
        invocationSource: "automation",
        triggerDetail: "system",
        status: "succeeded",
        contextSnapshot: { issueId, taskId: issueId },
        startedAt: ts,
        finishedAt: ts,
        createdAt: ts,
        updatedAt: ts,
        livenessState: null,
      });
    }

    const result = await heartbeat.reconcileStrandedAssignedIssues();

    expect(result.escalated).toBe(0);
    expect(result.productiveContinuationObserved).toBe(1);
    expect(result.successfulContinuationObserved).toBe(0);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("in_progress");

  });

  it("BLO-7521: does NOT re-escalate after a manual blocked->todo unblock, even with 5 pre-unblock non-productive runs", async () => {
    // BLO-7521 reproducer: CEO/operator manually flips an issue from
    // `blocked` to `todo` (or `in_progress`). The pre-unblock history
    // already contains >= NON_PRODUCTIVE_RUN_NOOP_THRESHOLD consecutive
    // non-productive succeeded runs from the prior wedge. Before the fix,
    // the next sweep cycle read all of those historical runs and re-blocked
    // the issue within ~45-90 seconds of the operator flip, defeating the
    // manual recovery. Fix: scope the lookback to runs created AFTER the
    // most recent `previousStatus=blocked` transition recorded in
    // activity_log.
    const { companyId, agentId, issueId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "succeeded",
      retryReason: "issue_continuation_needed",
      livenessState: null,
    });
    // Seed 4 additional pre-unblock non-productive succeeded runs (5 total
    // counting the fixture's run). Same timestamps as the BLO-3182 test.
    const baseTs = new Date("2026-03-19T00:05:00.000Z");
    for (let i = 0; i < 4; i++) {
      const ts = new Date(baseTs.getTime() + (i + 1) * 60_000);
      await db.insert(heartbeatRuns).values({
        id: randomUUID(),
        companyId,
        agentId,
        invocationSource: "automation",
        triggerDetail: "system",
        status: "succeeded",
        contextSnapshot: { issueId, taskId: issueId },
        startedAt: ts,
        finishedAt: ts,
        createdAt: ts,
        updatedAt: ts,
        livenessState: null,
      });
    }
    // Operator unblock landed AFTER all 5 non-productive runs. The
    // activity_log entry has `previousStatus: blocked` from the manual
    // flip back to `todo` / `in_progress`.
    const unblockedAt = new Date(baseTs.getTime() + 10 * 60_000);
    await db.insert(activityLog).values({
      id: randomUUID(),
      companyId,
      actorType: "user",
      actorId: "operator",
      action: "issue.updated",
      entityType: "issue",
      entityId: issueId,
      details: { previousStatus: "blocked", status: "in_progress" },
      createdAt: unblockedAt,
    });

    const result = await heartbeat.reconcileStrandedAssignedIssues();

    // The scoped lookback finds zero runs after `unblockedAt`, so the streak
    // count is 0, well below the threshold. No escalation. The sweep falls
    // through to the normal continuation-recovery path instead.
    expect(result.escalated).toBe(0);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("in_progress");
  });

  it("BLO-7521: in-place recovery escalator skips when the failed run predates the manual unblock", async () => {
    // BLO-7521 reproducer arm 2: a `stranded_issue_recovery` origin issue
    // whose latest run is an unsuccessful terminal failure. Before the fix,
    // the in-place escalator (`escalateStrandedRecoveryIssueInPlace`) had
    // no gate — any recovery-origin issue with a failed latest run got
    // instant-re-blocked, even if an operator had just unblocked it and
    // the failed run predates the unblock. Fix: skip escalation when the
    // latest run's createdAt <= the most recent unblock timestamp.
    const sourceIssueId = randomUUID();
    const { companyId, issueId, runId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "failed",
    });
    await db
      .update(issues)
      .set({
        title: "Recover stalled issue PAP-1",
        originKind: "stranded_issue_recovery",
        originId: sourceIssueId,
      })
      .where(eq(issues.id, issueId));
    // Pin the failed run's createdAt to a fixed instant so we can place the
    // operator unblock strictly after it. The fixture relies on the schema's
    // defaultNow() for createdAt, which would otherwise race against our
    // unblockedAt comparison.
    const failedRunCreatedAt = new Date("2026-03-19T00:00:00.000Z");
    await db
      .update(heartbeatRuns)
      .set({ createdAt: failedRunCreatedAt })
      .where(eq(heartbeatRuns.id, runId));
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(issues).values({
      id: sourceIssueId,
      companyId,
      title: "Original stranded source",
      status: "done",
      priority: "medium",
      issueNumber: 2,
      identifier: `${issuePrefix}-2`,
    });
    // Operator unblock recorded AFTER the failed run createdAt above.
    const unblockedAt = new Date("2026-03-19T01:00:00.000Z");
    await db.insert(activityLog).values({
      id: randomUUID(),
      companyId,
      actorType: "user",
      actorId: "operator",
      action: "issue.updated",
      entityType: "issue",
      entityId: issueId,
      details: { previousStatus: "blocked", status: "in_progress" },
      createdAt: unblockedAt,
    });

    const result = await heartbeat.reconcileStrandedAssignedIssues();

    // Latest failed run (createdAt 2026-03-19T00:00Z by the fixture) predates
    // the unblock (01:00Z), so the in-place escalator should skip — not
    // re-block — giving the agent a fresh run window.
    expect(result.escalated).toBe(0);
    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("in_progress");
  });

  // BLO-8050: generalize the BLO-7521 "operator-just-unblocked" gate to all
  // six escalation callsites. Without these gates, an issue with a stale
  // failing run gets re-flipped to `blocked` on the next sweep even though
  // the operator's unblock was supposed to grant a fresh run window.
  // Each row exercises one (status × escalation predicate) combination.
  it.each([
    {
      label: "todo + non-retryable terminal run",
      issueStatus: "todo" as const,
      runStatus: "failed" as const,
      runErrorCode: "workspace_import_conflict",
      retryReason: null,
      runUsageJson: null,
    },
    {
      label: "todo + zero-token startup failure run",
      issueStatus: "todo" as const,
      runStatus: "failed" as const,
      runErrorCode: "context_overflow",
      retryReason: null,
      runUsageJson: { inputTokens: 0, outputTokens: 0 },
    },
    {
      label: "todo + automatic-recovery-failed run",
      issueStatus: "todo" as const,
      runStatus: "failed" as const,
      runErrorCode: "process_lost",
      retryReason: "assignment_recovery" as const,
      runUsageJson: null,
    },
    {
      label: "in_progress + non-retryable terminal run",
      issueStatus: "in_progress" as const,
      runStatus: "failed" as const,
      runErrorCode: "workspace_import_conflict",
      retryReason: null,
      runUsageJson: null,
    },
    {
      label: "in_progress + zero-token startup failure run",
      issueStatus: "in_progress" as const,
      runStatus: "failed" as const,
      runErrorCode: "context_overflow",
      retryReason: null,
      runUsageJson: { inputTokens: 0, outputTokens: 0 },
    },
    {
      label: "in_progress + automatic-recovery-failed run",
      issueStatus: "in_progress" as const,
      runStatus: "failed" as const,
      runErrorCode: "process_lost",
      retryReason: "issue_continuation_needed" as const,
      runUsageJson: null,
    },
  ])(
    "BLO-8050: $label — skips re-escalation when failed run predates the manual unblock",
    async ({ issueStatus, runStatus, runErrorCode, retryReason, runUsageJson }) => {
      const { companyId, issueId, runId } = await seedStrandedIssueFixture({
        status: issueStatus,
        runStatus,
        runErrorCode,
        retryReason: retryReason ?? undefined,
        runUsageJson: runUsageJson ?? undefined,
      });
      // Pin failed run timestamp so the operator unblock can be placed strictly
      // after it. Without this the fixture's defaultNow() would race the
      // unblockedAt comparison and the gate wouldn't fire deterministically.
      const failedRunCreatedAt = new Date("2026-03-19T00:00:00.000Z");
      await db
        .update(heartbeatRuns)
        .set({ createdAt: failedRunCreatedAt })
        .where(eq(heartbeatRuns.id, runId));
      const unblockedAt = new Date("2026-03-19T01:00:00.000Z");
      await db.insert(activityLog).values({
        id: randomUUID(),
        companyId,
        actorType: "user",
        actorId: "operator",
        action: "issue.updated",
        entityType: "issue",
        entityId: issueId,
        details: { previousStatus: "blocked", status: issueStatus },
        createdAt: unblockedAt,
      });

      const result = await heartbeat.reconcileStrandedAssignedIssues();

      // Pre-fix: this branch would call escalateStrandedAssignedIssue (or
      // escalateZeroTokenStartupFailureIssue) and flip the issue back to
      // `blocked`, defeating the manual unblock. Post-fix: the gate sees
      // latestRun.createdAt <= unblockedAt and skips.
      expect(result.escalated).toBe(0);
      expect(result.zeroTokenStartupFailureBlocked).toBe(0);
      const issue = await db
        .select()
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null);
      expect(issue?.status).toBe(issueStatus);
    },
  );

  it("does not treat a productive terminal run as healthy when in-progress work has no live path", async () => {
    const { companyId, agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "succeeded",
      livenessState: "advanced",
    });
    const sourceIssue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(sourceIssue).toMatchObject({
      status: "in_progress",
      assigneeAgentId: agentId,
      assigneeUserId: null,
      executionRunId: null,
    });

    const activeRuns = await db
      .select()
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, companyId), inArray(heartbeatRuns.status, ["queued", "running"])));
    expect(activeRuns).toHaveLength(0);

    const liveWakeups = await db
      .select()
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, companyId), inArray(agentWakeupRequests.status, ["queued", "deferred_issue_execution"])));
    expect(liveWakeups).toHaveLength(0);

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.productiveContinuationObserved).toBe(0);
    expect(result.continuationRequeued + result.escalated).toBe(1);
    expect(result.issueIds).toEqual([issueId]);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    const recoveryIssues = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stranded_issue_recovery")));
    const followupRuns = await db
      .select()
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agentId)));
    expect(comments).toHaveLength(0);
    expect(recoveryIssues).toHaveLength(0);
    expect(followupRuns).toHaveLength(2);
    const retryRun = followupRuns.find((row) => row.id !== runId);
    expect(retryRun?.contextSnapshot as Record<string, unknown> | undefined).toMatchObject({
      issueId,
      taskId: issueId,
      retryReason: "issue_continuation_needed",
      retryOfRunId: runId,
      source: "issue.productive_terminal_continuation_recovery",
    });
    expect(retryRun?.contextSnapshot as Record<string, unknown>).not.toHaveProperty("modelProfile");
  });

  it("exempts stranded-recovery escalation when assignee posted a recent comment (GGU-809)", async () => {
    const { companyId, agentId, issueId, runId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "succeeded",
      retryReason: "issue_continuation_needed",
      runSource: "issue.productive_terminal_continuation_recovery",
      livenessState: "advanced",
    });
    // Recent agent-authored comment should suppress the repeat-productive
    // escalation and let the normal continuation-retry path proceed.
    await db.insert(issueComments).values({
      companyId,
      issueId,
      authorAgentId: agentId,
      body: "frame 02/08 generated, attaching shortly",
    });
    heartbeat = createHeartbeat({ penstockAvailabilityGate: allowPenstockGate });

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.escalated).toBe(0);
    expect(result.recentProgressExempted).toBe(1);
    expect(result.continuationRequeued).toBe(1);
    expect(result.issueIds).toEqual([issueId]);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("in_progress");

    const recoveryIssues = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stranded_issue_recovery")));
    expect(recoveryIssues).toHaveLength(0);

    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    expect(runs).toHaveLength(2);
    const retryRun = runs.find((row) => row.id !== runId);
    expect(retryRun?.contextSnapshot as Record<string, unknown> | undefined).toMatchObject({
      issueId,
      retryReason: "issue_continuation_needed",
      source: "issue.productive_terminal_continuation_recovery",
    });
  });

  it("still escalates stranded-recovery work when the recent comment is older than the exemption window (GGU-809)", async () => {
    const { companyId, agentId, issueId } = await seedStrandedIssueFixture({
      status: "in_progress",
      runStatus: "succeeded",
      retryReason: "issue_continuation_needed",
      runSource: "issue.productive_terminal_continuation_recovery",
      livenessState: "advanced",
    });
    // Comment older than the exemption window must NOT suppress escalation.
    const stale = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await db.insert(issueComments).values({
      companyId,
      issueId,
      authorAgentId: agentId,
      body: "old progress note",
      createdAt: stale,
      updatedAt: stale,
    });
    heartbeat = createHeartbeat({ penstockAvailabilityGate: allowPenstockGate });

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.escalated).toBe(1);
    expect(result.recentProgressExempted).toBe(0);
    expect(result.continuationRequeued).toBe(0);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("blocked");
  });

  it("does not reconcile user-assigned work through the agent stranded-work recovery path", async () => {
    const { issueId, runId } = await seedStrandedIssueFixture({
      status: "todo",
      runStatus: "failed",
      assignToUser: true,
    });

    const result = await heartbeat.reconcileStrandedAssignedIssues();
    expect(result.dispatchRequeued).toBe(0);
    expect(result.continuationRequeued).toBe(0);
    expect(result.escalated).toBe(0);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issue?.status).toBe("todo");

    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(runs).toHaveLength(1);
  });

  // BLO-16850: the orphaned-managed-pod sweep force-deletes still-Running
  // external-lifecycle agent pods whose heartbeat run has finalized
  // (terminal/absent) with no live Job. Default-safe: when listManagedAgentPods
  // is kube-blind (null), the sweep is a no-op (all other recovery tests leave
  // mockListManagedAgentPods at its null default).
  describe("reapOrphanedRuns: orphaned managed-pod sweep (BLO-16850)", () => {
    function orphanPod(over: Partial<{
      name: string; uid: string; runId: string; agentId: string;
      adapterType: string; phase: string; isActiveOrTerminating: boolean;
      deletionTimestamp: Date | null; createdAt: Date | null;
    }>) {
      const sixMinAgo = new Date(Date.now() - 6 * 60 * 1000);
      return {
        name: over.name ?? "agent-opencode-orphan-xyz",
        uid: over.uid ?? "orphan-pod-uid",
        runId: over.runId ?? randomUUID(),
        agentId: over.agentId ?? randomUUID(),
        adapterType: over.adapterType ?? "opencode_k8s",
        phase: over.phase ?? "Running",
        isActiveOrTerminating: over.isActiveOrTerminating ?? true,
        deletionTimestamp: over.deletionTimestamp ?? null,
        createdAt: over.createdAt === undefined ? sixMinAgo : over.createdAt,
      };
    }

    it("force-deletes a Running managed pod whose run has finalized (terminal) and has no live Job", async () => {
      const { runId, agentId } = await seedRunFixture({
        adapterType: "opencode_k8s",
        runStatus: "failed",
        includeIssue: false,
      });
      mockListManagedAgentPods.mockResolvedValueOnce([
        orphanPod({ runId, agentId, name: "agent-opencode-x", uid: "u1" }),
      ]);

      await heartbeat.reapOrphanedRuns();

      expect(mockDeleteAgentPodExact).toHaveBeenCalledWith({
        name: "agent-opencode-x", uid: "u1", runId, agentId,
      });
    });

    it("does NOT reap a pod whose run is still running", async () => {
      const { runId, agentId } = await seedRunFixture({
        adapterType: "opencode_k8s",
        runStatus: "running",
        includeIssue: false,
      });
      mockListManagedAgentPods.mockResolvedValueOnce([orphanPod({ runId, agentId })]);
      // A running external-lifecycle run makes hasExternalCandidates true, so the
      // reaper consults the listLiveAgentJobRunIds fallback; return an empty set
      // so liveJobRunIds is a real (empty) set rather than null.
      mockListLiveAgentJobRunIds.mockResolvedValueOnce(new Set());

      await heartbeat.reapOrphanedRuns();

      expect(mockDeleteAgentPodExact).not.toHaveBeenCalled();
    });

    it("does NOT reap a pod whose run id is in liveJobRunIds (live Job)", async () => {
      const { runId, agentId } = await seedRunFixture({
        adapterType: "opencode_k8s",
        runStatus: "failed",
        includeIssue: false,
      });
      mockListManagedAgentPods.mockResolvedValueOnce([
        orphanPod({ runId, agentId, name: "agent-opencode-live", uid: "u3" }),
      ]);
      // The run is terminal in the DB, but a live Job still exists for it. A
      // terminal run is not in activeRuns, so hasExternalCandidates is false and
      // the listLiveAgentJobRunIds fallback never fires; surface the live Job
      // through the primary jobRunStatuses path instead (an "active" entry =>
      // liveJobRunIds contains runId). Same protection branch, reliable trigger.
      mockListAgentJobRunStatuses.mockResolvedValueOnce(
        new Map([[runId, { phase: "active" as const, name: "agent-opencode-live", uid: "u3" }]]),
      );

      await heartbeat.reapOrphanedRuns();

      expect(mockDeleteAgentPodExact).not.toHaveBeenCalled();
    });

    it("does NOT reap a pod younger than the grace window", async () => {
      const { runId, agentId } = await seedRunFixture({
        adapterType: "opencode_k8s",
        runStatus: "failed",
        includeIssue: false,
      });
      mockListManagedAgentPods.mockResolvedValueOnce([
        orphanPod({ runId, agentId, createdAt: new Date() }), // just created
      ]);

      await heartbeat.reapOrphanedRuns();

      expect(mockDeleteAgentPodExact).not.toHaveBeenCalled();
    });

    it("is a no-op when the managed-pod list is unavailable (kube-blind)", async () => {
      mockListManagedAgentPods.mockResolvedValueOnce(null);

      await heartbeat.reapOrphanedRuns();

      expect(mockDeleteAgentPodExact).not.toHaveBeenCalled();
    });

    it("also reaps an orphaned pod whose run ROW is entirely gone", async () => {
      // No heartbeatRuns row inserted -> run absent -> terminal-or-absent branch.
      // Use real UUIDs so the inArray(heartbeatRuns.id, ...) lookup does not fail
      // the uuid column cast; the absent row is what exercises the branch.
      const ghostRunId = randomUUID();
      const ghostAgentId = randomUUID();
      mockListManagedAgentPods.mockResolvedValueOnce([
        orphanPod({ runId: ghostRunId, agentId: ghostAgentId, name: "agent-opencode-ghost", uid: "gu" }),
      ]);

      await heartbeat.reapOrphanedRuns();

      expect(mockDeleteAgentPodExact).toHaveBeenCalledWith({
        name: "agent-opencode-ghost", uid: "gu", runId: ghostRunId, agentId: ghostAgentId,
      });
    });
  });

  // BLO-8677: suppression of repeated non-assignee (CTO/manager) wakes when
  // no new issue activity has occurred since the last recovery attempt.
  describe("source-scoped stranded recovery: non-assignee wake suppression (BLO-8677)", () => {
    async function seedWithCto(input?: {
      existingAction?: { lastAttemptAt: Date; attemptCount?: number };
      issueLastActivityAt?: Date;
    }) {
      const fixture = await seedStrandedIssueFixture({
        status: "in_progress",
        runStatus: "failed",
        retryReason: "issue_continuation_needed",
        // BLO-16182: exercises generic escalation/wake routing, not process_lost's
        // transient budget — use a default-classified code so it escalates at one
        // attempt (process_lost is now transient / 3-attempt).
        runErrorCode: "adapter_exit_code",
      });
      const { companyId, agentId, issueId } = fixture;

      const ctoAgentId = randomUUID();
      await db.insert(agents).values({
        id: ctoAgentId,
        companyId,
        name: "CTO",
        role: "cto",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });

      if (input?.existingAction) {
        await db.insert(issueRecoveryActions).values({
          companyId,
          sourceIssueId: issueId,
          kind: "stranded_assigned_issue",
          status: "active",
          ownerType: "agent",
          ownerAgentId: ctoAgentId,
          previousOwnerAgentId: agentId,
          returnOwnerAgentId: agentId,
          cause: "stranded_assigned_issue",
          fingerprint: `source_scoped_recovery:${companyId}:${issueId}:stranded_assigned_issue:${agentId}`,
          evidence: {},
          nextAction:
            "Restore a live execution path, fix the runtime/adapter failure, or record an intentional manual resolution.",
          attemptCount: input.existingAction.attemptCount ?? 1,
          lastAttemptAt: input.existingAction.lastAttemptAt,
        });
      }

      if (input?.issueLastActivityAt !== undefined) {
        await db.update(issues).set({ lastActivityAt: input.issueLastActivityAt }).where(eq(issues.id, issueId));
      }

      return { ...fixture, ctoAgentId };
    }

    async function getRecoveryWakeups(agentId: string) {
      return db
        .select()
        .from(agentWakeupRequests)
        .where(
          and(
            eq(agentWakeupRequests.agentId, agentId),
            eq(agentWakeupRequests.reason, "source_scoped_recovery_action"),
          ),
        );
    }

    it("first attempt: always wakes the CTO owner without suppression", async () => {
      const { agentId, issueId, ctoAgentId } = await seedWithCto();

      const result = await heartbeat.reconcileStrandedAssignedIssues();
      expect(result.escalated).toBe(1);
      expect(result.issueIds).toEqual([issueId]);

      const ctoWakeups = await getRecoveryWakeups(ctoAgentId);
      expect(ctoWakeups).toHaveLength(1);
      const ctoPayload = ctoWakeups[0]?.payload as Record<string, unknown> | null;
      expect(ctoPayload).not.toMatchObject({ suppressedNonAssigneeWake: true });

      const assigneeWakeups = await getRecoveryWakeups(agentId);
      expect(assigneeWakeups).toHaveLength(0);
    });

    it("second attempt with no new issue activity: suppresses CTO wake and routes to assignee", async () => {
      const now = Date.now();
      const lastAttemptAt = new Date(now - 60_000); // 1 min ago
      const issueLastActivityAt = new Date(now - 300_000); // 5 min ago (before lastAttemptAt → no new activity)

      const { companyId, agentId, issueId, ctoAgentId } = await seedWithCto({
        existingAction: { lastAttemptAt },
        issueLastActivityAt,
      });

      const result = await heartbeat.reconcileStrandedAssignedIssues();
      expect(result.escalated).toBe(1);
      expect(result.issueIds).toEqual([issueId]);

      const ctoWakeups = await getRecoveryWakeups(ctoAgentId);
      expect(ctoWakeups).toHaveLength(0);

      const assigneeWakeups = await getRecoveryWakeups(agentId);
      expect(assigneeWakeups).toHaveLength(1);
      const assigneePayload = assigneeWakeups[0]?.payload as Record<string, unknown> | null;
      expect(assigneePayload).toMatchObject({ suppressedNonAssigneeWake: true });

      const action = await db
        .select()
        .from(issueRecoveryActions)
        .where(
          and(eq(issueRecoveryActions.companyId, companyId), eq(issueRecoveryActions.sourceIssueId, issueId)),
        )
        .then((rows) => rows[0] ?? null);
      expect(action?.attemptCount).toBe(2);
    });

    it("second attempt with new issue activity since last attempt: allows CTO wake", async () => {
      const now = Date.now();
      const lastAttemptAt = new Date(now - 300_000); // 5 min ago
      const issueLastActivityAt = new Date(now - 60_000); // 1 min ago (after lastAttemptAt → new activity)

      const { agentId, issueId, ctoAgentId } = await seedWithCto({
        existingAction: { lastAttemptAt },
        issueLastActivityAt,
      });

      const result = await heartbeat.reconcileStrandedAssignedIssues();
      expect(result.escalated).toBe(1);
      expect(result.issueIds).toEqual([issueId]);

      const ctoWakeups = await getRecoveryWakeups(ctoAgentId);
      expect(ctoWakeups).toHaveLength(1);
      const ctoPayload = ctoWakeups[0]?.payload as Record<string, unknown> | null;
      expect(ctoPayload).not.toMatchObject({ suppressedNonAssigneeWake: true });

      const assigneeWakeups = await getRecoveryWakeups(agentId);
      expect(assigneeWakeups).toHaveLength(0);
    });

    it("owner-is-assignee: no suppression even at high attemptCount and no new activity", async () => {
      // When no manager/CTO exists, the owner falls back to the assignee itself.
      // ownerIsNonAssignee is false in that case, so suppression must not fire.
      const now = Date.now();
      const lastAttemptAt = new Date(now - 300_000);
      const issueLastActivityAt = new Date(now - 600_000);

      const fixture = await seedStrandedIssueFixture({
        status: "in_progress",
        runStatus: "failed",
        retryReason: "issue_continuation_needed",
        // BLO-16182: default-classified code so it escalates at one attempt
        // (process_lost is now transient / 3-attempt); this test targets wake
        // suppression, not the transient budget.
        runErrorCode: "adapter_exit_code",
      });
      const { agentId, issueId, companyId } = fixture;

      await db.insert(issueRecoveryActions).values({
        companyId,
        sourceIssueId: issueId,
        kind: "stranded_assigned_issue",
        status: "active",
        ownerType: "agent",
        ownerAgentId: agentId,
        previousOwnerAgentId: agentId,
        returnOwnerAgentId: agentId,
        cause: "stranded_assigned_issue",
        fingerprint: `source_scoped_recovery:${companyId}:${issueId}:stranded_assigned_issue:${agentId}`,
        evidence: {},
        nextAction: "Restore a live execution path.",
        attemptCount: 3,
        lastAttemptAt,
      });
      await db.update(issues).set({ lastActivityAt: issueLastActivityAt }).where(eq(issues.id, issueId));

      const result = await heartbeat.reconcileStrandedAssignedIssues();
      expect(result.escalated).toBe(1);

      const assigneeWakeups = await getRecoveryWakeups(agentId);
      expect(assigneeWakeups).toHaveLength(1);
      const payload = assigneeWakeups[0]?.payload as Record<string, unknown> | null;
      expect(payload).not.toMatchObject({ suppressedNonAssigneeWake: true });
    });

    it("parks review-waiting continuation cancellations in_review and clears active recovery", async () => {
      const { companyId, agentId, issueId } = await seedStrandedIssueFixture({
        status: "in_progress",
        runStatus: "cancelled",
        retryReason: "issue_continuation_needed",
        runErrorCode: "issue_continuation_waiting_on_review",
      });
      const recoveryActionId = randomUUID();
      await db.update(issues)
        .set({ monitorNextCheckAt: new Date(Date.now() + 60_000) })
        .where(eq(issues.id, issueId));
      await db.insert(issueRecoveryActions).values({
        id: recoveryActionId,
        companyId,
        sourceIssueId: issueId,
        kind: "stranded_assigned_issue",
        status: "active",
        ownerType: "agent",
        ownerAgentId: agentId,
        previousOwnerAgentId: agentId,
        returnOwnerAgentId: agentId,
        cause: "stranded_assigned_issue",
        fingerprint: `source_scoped_recovery:${companyId}:${issueId}:stranded_assigned_issue:${agentId}`,
        evidence: {},
        nextAction: "Restore a live execution path.",
        attemptCount: 1,
        lastAttemptAt: new Date(Date.now() - 60_000),
      });

      const result = await heartbeat.reconcileStrandedAssignedIssues();
      expect(result.reviewWaitingParked).toBe(1);
      expect(result.escalated).toBe(0);
      expect(result.issueIds).toEqual([issueId]);

      const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
      expect(issue?.status).toBe("in_review");

      const [action] = await db
        .select()
        .from(issueRecoveryActions)
        .where(eq(issueRecoveryActions.id, recoveryActionId));
      expect(action).toMatchObject({
        status: "resolved",
        outcome: "restored",
      });

      const recoveryWakeups = await getRecoveryWakeups(agentId);
      expect(recoveryWakeups).toHaveLength(0);
    });

    it("does not park non-continuation failures with the review-waiting error code", async () => {
      const { issueId } = await seedStrandedIssueFixture({
        status: "in_progress",
        runStatus: "failed",
        runErrorCode: "issue_continuation_waiting_on_review",
      });
      await db.update(issues)
        .set({ monitorNextCheckAt: new Date(Date.now() + 60_000) })
        .where(eq(issues.id, issueId));

      const result = await heartbeat.reconcileStrandedAssignedIssues();
      expect(result.reviewWaitingParked).toBe(0);

      const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
      expect(issue?.status).not.toBe("in_review");
    });
  });
});
