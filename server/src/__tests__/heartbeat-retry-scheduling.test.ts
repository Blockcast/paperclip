import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  activityLog,
  budgetPolicies,
  companies,
  createDb,
  executionWorkspaces,
  githubCommitStatusDeliveries,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueRelations,
  issues,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { cleanupHeartbeatTestState } from "./helpers/cleanup-heartbeat-test-state.js";
import { registerServerAdapter, runningProcesses, unregisterServerAdapter } from "../adapters/index.ts";
import { subscribeCompanyLiveEvents } from "../services/live-events.js";
import {
  BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS,
  CAPACITY_BLOCKED_HEARTBEAT_RETRY_MAX_ATTEMPTS,
  INTERACTION_CONTINUATION_INFRA_RETRY_REASON,
  INTERACTION_CONTINUATION_INFRA_WAKE_REASON,
  JOB_FAILED_HEARTBEAT_RETRY_MAX_ATTEMPTS,
  MAX_TURN_CONTINUATION_RETRY_REASON,
  MAX_TURN_CONTINUATION_WAKE_REASON,
  heartbeatService,
  isRetryableInteractionContinuationInfrastructureFailure,
  probeStaleKillReviewEvidence,
  SESSION_UNAVAILABLE_HEARTBEAT_RETRY_DELAY_MS,
  SESSION_UNAVAILABLE_HEARTBEAT_RETRY_MAX_ATTEMPTS,
  shouldScheduleAutomaticRunRetry,
} from "../services/heartbeat.js";
import {
  MAX_TRANSIENT_RETRY_HORIZON_MS,
  TRANSIENT_HORIZON_CLAMP_MIN_ATTEMPTS,
} from "../services/ccrotate-capacity-retry.js";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 1,
    signal: null,
    timedOut: false,
    errorMessage: "Adapter failed",
    errorCode: "adapter_failed",
    summary: "failed",
    resultJson: {} as Record<string, unknown>,
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => ({ track: vi.fn() }),
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return {
    ...actual,
    trackAgentFirstHeartbeat: vi.fn(),
  };
});

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn((type: string) =>
      type === "provider_quota_test" || type === "zero_turn_transient_test"
        ? actual.getServerAdapter(type)
        : {
            supportsLocalAgentJwt: false,
            execute: mockAdapterExecute,
          },
    ),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const PROVIDER_QUOTA_TEST_ADAPTER = "provider_quota_test";
// BLO-24166: an adapter that fails the way the 2026-08-08 streak did — a
// transient upstream error that burned a whole run without producing a single
// model token. Drives the real executeRun finalizer so the slot-release
// ordering is observed on the production path, not hand-arranged by the test.
const ZERO_TURN_TRANSIENT_ADAPTER = "zero_turn_transient_test";

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat retry scheduling tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function waitForRunToFinish(
  heartbeat: ReturnType<typeof heartbeatService>,
  runId: string,
  timeoutMs = 5_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await heartbeat.getRun(runId);
    if (run && !["queued", "running"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return await heartbeat.getRun(runId);
}

describeEmbeddedPostgres("heartbeat bounded retry scheduling", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-retry-scheduling-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    registerServerAdapter({
      type: PROVIDER_QUOTA_TEST_ADAPTER,
      execute: async () => ({
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: "You've hit your session limit - resets at 4pm (America/Chicago).",
        errorCode: "provider_quota",
        errorFamily: "provider_quota",
        retryNotBefore: "2030-04-22T21:00:00.000Z",
        resultJson: {
          errorFamily: "provider_quota",
          retryNotBefore: "2030-04-22T21:00:00.000Z",
          providerQuotaRetryNotBefore: "2030-04-22T21:00:00.000Z",
        },
      }),
      testEnvironment: async () => ({
        adapterType: PROVIDER_QUOTA_TEST_ADAPTER,
        status: "pass",
        checks: [],
        testedAt: new Date().toISOString(),
      }),
    });
    registerServerAdapter({
      type: ZERO_TURN_TRANSIENT_ADAPTER,
      execute: async () => ({
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: "upstream connection reset",
        errorCode: "adapter_failed",
        errorFamily: "transient_upstream",
        summary: "failed",
        // Zero model turns: the run held a slot and produced nothing.
        usage: { inputTokens: 0, outputTokens: 0 },
        resultJson: {
          errorFamily: "transient_upstream",
          usage: { inputTokens: 0, outputTokens: 0 },
        },
        provider: "test",
        model: "test-model",
      }),
      testEnvironment: async () => ({
        adapterType: ZERO_TURN_TRANSIENT_ADAPTER,
        status: "pass",
        checks: [],
        testedAt: new Date().toISOString(),
      }),
    });
  }, 60_000);

  afterEach(async () => {
    mockAdapterExecute.mockReset();
    mockAdapterExecute.mockImplementation(async () => ({
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: "Adapter failed",
      errorCode: "adapter_failed",
      summary: "failed",
      resultJson: {},
      provider: "test",
      model: "test-model",
    }));
    await cleanupRetryFixture();
  });

  afterAll(async () => {
    unregisterServerAdapter(PROVIDER_QUOTA_TEST_ADAPTER);
    unregisterServerAdapter(ZERO_TURN_TRANSIENT_ADAPTER);
    await tempDb?.cleanup();
  });

  async function cleanupRetryFixture() {
    await cleanupHeartbeatTestState(db, heartbeat, {
      errorLabel: "heartbeat retry scheduling cleanup",
      drainTimeoutMs: 30_000,
    });
  }

  async function seedRetryFixture(input: {
    runId: string;
    companyId: string;
    agentId: string;
    now: Date;
    errorCode: string;
    errorFamily?: "transient_upstream" | "provider_quota" | null;
    retryNotBefore?: string | null;
    scheduledRetryAttempt?: number;
    resultJson?: Record<string, unknown> | null;
    adapterType?: string;
    agentName?: string;
    contextSnapshot?: Record<string, unknown>;
  }) {
    const adapterType = input.adapterType ?? "codex_local";
    const agentName = input.agentName ?? (adapterType === "claude_local" ? "ClaudeCoder" : "CodexCoder");
    await db.insert(companies).values({
      id: input.companyId,
      name: "Paperclip",
      issuePrefix: `T${input.companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });

    await db.insert(agents).values({
      id: input.agentId,
      companyId: input.companyId,
      name: agentName,
      role: "engineer",
      status: "active",
      adapterType,
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: input.runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "assignment",
      status: "failed",
      error: "upstream overload",
      errorCode: input.errorCode,
      finishedAt: input.now,
      scheduledRetryAttempt: input.scheduledRetryAttempt ?? 0,
      scheduledRetryReason: input.scheduledRetryAttempt ? "transient_failure" : null,
      resultJson: input.resultJson ?? {
        ...(input.errorFamily ? { errorFamily: input.errorFamily } : {}),
        ...(input.retryNotBefore
          ? {
              retryNotBefore: input.retryNotBefore,
              transientRetryNotBefore: input.retryNotBefore,
            }
          : {}),
      },
      contextSnapshot: input.contextSnapshot ?? {
        issueId: randomUUID(),
        wakeReason: "issue_assigned",
      },
      updatedAt: input.now,
      createdAt: input.now,
    });
  }

  it("records provider quota failures, schedules the reset-time retry, and leaves the agent idle", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Quota Test",
      role: "engineer",
      status: "idle",
      adapterType: PROVIDER_QUOTA_TEST_ADAPTER,
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });

    const run = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect(run).not.toBeNull();

    const failedRun = await waitForRunToFinish(heartbeat, run!.id);
    expect(failedRun?.status).toBe("failed");
    expect(failedRun?.errorCode).toBe("provider_quota");
    expect((failedRun?.resultJson as Record<string, unknown> | null)?.errorFamily).toBe("provider_quota");

    await expect
      .poll(
        () =>
          db
            .select({ id: heartbeatRuns.id })
            .from(heartbeatRuns)
            .where(eq(heartbeatRuns.retryOfRunId, run!.id))
            .then((rows) => rows.length),
        { timeout: 5_000, interval: 50 },
      )
      .toBe(1);

    const retryRun = await db
      .select({
        id: heartbeatRuns.id,
        status: heartbeatRuns.status,
        scheduledRetryAt: heartbeatRuns.scheduledRetryAt,
        scheduledRetryReason: heartbeatRuns.scheduledRetryReason,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.retryOfRunId, run!.id))
      .then((rows) => rows[0] ?? null);
    expect(retryRun?.status).toBe("scheduled_retry");
    expect(retryRun?.scheduledRetryReason).toBe("transient_failure");
    expect(retryRun?.scheduledRetryAt?.toISOString()).toBe("2030-04-22T21:00:00.000Z");
    expect((retryRun?.contextSnapshot as Record<string, unknown> | null)?.errorFamily).toBe("provider_quota");
    expect((retryRun?.contextSnapshot as Record<string, unknown> | null)?.providerQuotaRetryNotBefore).toBe(
      "2030-04-22T21:00:00.000Z",
    );
    expect((retryRun?.contextSnapshot as Record<string, unknown> | null)?.codexTransientFallbackMode ?? null).toBeNull();

    await expect
      .poll(
        () =>
          db
            .select({ status: agents.status, errorReason: agents.errorReason })
            .from(agents)
            .where(eq(agents.id, agentId))
            .then((rows) => rows[0] ?? null),
        { timeout: 5_000, interval: 50 },
      )
      .toEqual({ status: "idle", errorReason: null });
  });

  it("coalesces bounded retries by agent, work identity, and reason", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const now = new Date("2030-04-22T20:00:00.000Z");
    const firstRunId = randomUUID();
    const secondRunId = randomUUID();

    await seedRetryFixture({
      companyId,
      agentId,
      runId: firstRunId,
      now,
      errorCode: "adapter_failed",
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
    });
    await db.insert(heartbeatRuns).values({
      id: secondRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "failed",
      error: "upstream overload",
      errorCode: "adapter_failed",
      finishedAt: new Date(now.getTime() + 1_000),
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
      updatedAt: new Date(now.getTime() + 1_000),
      createdAt: new Date(now.getTime() + 1_000),
    });

    const first = await heartbeat.scheduleBoundedRetry(firstRunId, { now, delayMs: 60_000 });
    const second = await heartbeat.scheduleBoundedRetry(secondRunId, {
      now: new Date(now.getTime() + 30_000),
      delayMs: 120_000,
    });

    expect(first.outcome).toBe("scheduled");
    expect(second.outcome).toBe("scheduled");
    if (first.outcome !== "scheduled" || second.outcome !== "scheduled") return;
    expect(second.run.id).toBe(first.run.id);
    expect(second.run.retryOfRunId).toBe(firstRunId);

    const retryRows = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.status, "scheduled_retry")));
    expect(retryRows).toEqual([{ id: first.run.id }]);

    const wakeup = await db
      .select({ coalescedCount: agentWakeupRequests.coalescedCount })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, first.run.wakeupRequestId!))
      .then((rows) => rows[0] ?? null);
    expect(wakeup?.coalescedCount).toBe(1);
  });

  async function seedQueuedRunFixture(input: {
    companyId: string;
    agentId: string;
    runId: string;
    now: Date;
    contextSnapshot?: Record<string, unknown>;
  }) {
    await db.insert(companies).values({
      id: input.companyId,
      name: "Paperclip",
      issuePrefix: `T${input.companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });

    await db.insert(agents).values({
      id: input.agentId,
      companyId: input.companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
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

    await db.insert(heartbeatRuns).values({
      id: input.runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "assignment",
      status: "queued",
      triggerDetail: "github_pr_review_requested",
      contextSnapshot: input.contextSnapshot ?? {},
      updatedAt: input.now,
      createdAt: input.now,
    });

    const issueId = typeof input.contextSnapshot?.issueId === "string" ? input.contextSnapshot.issueId : null;
    if (issueId) {
      await db.insert(issues).values({
        id: issueId,
        companyId: input.companyId,
        title: "Queued run retry fixture",
        status: "in_progress",
        priority: "high",
        assigneeAgentId: input.agentId,
        executionRunId: input.runId,
        executionAgentNameKey: "codexcoder",
        executionLockedAt: input.now,
        issueNumber: 1,
        identifier: `T${input.companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}-1`,
      });
    }
  }

  async function getScheduledTransientRetryForRun(runId: string) {
    return db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.retryOfRunId, runId))
      .then((rows) => rows.find((row) => row.scheduledRetryReason === "transient_failure") ?? null);
  }

  it("clears parked retry error metadata when claiming a queued local run", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const issueId = randomUUID();
    const now = new Date("2026-07-30T03:30:00.000Z");

    await seedQueuedRunFixture({
      companyId,
      agentId,
      runId,
      now,
      contextSnapshot: {
        issueId,
        wakeReason: "issue_assigned",
      },
    });
    await db
      .update(heartbeatRuns)
      .set({
        error: "provider capacity retry parked",
        errorCode: "rate_limit_exhausted",
        scheduledRetryAt: now,
        scheduledRetryAttempt: 2,
        scheduledRetryReason: "ccrotate_capacity",
      })
      .where(eq(heartbeatRuns.id, runId));
    await db
      .update(agents)
      .set({ status: "error", errorReason: "stale failure from the previous run" })
      .where(eq(agents.id, agentId));

    let observedClaim = false;
    mockAdapterExecute.mockImplementationOnce(async () => {
      const [claimed] = await db
        .select({
          status: heartbeatRuns.status,
          error: heartbeatRuns.error,
          errorCode: heartbeatRuns.errorCode,
          scheduledRetryAt: heartbeatRuns.scheduledRetryAt,
          scheduledRetryAttempt: heartbeatRuns.scheduledRetryAttempt,
          scheduledRetryReason: heartbeatRuns.scheduledRetryReason,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId));

      expect(claimed).toMatchObject({
        status: "running",
        error: null,
        errorCode: null,
        scheduledRetryAt: now,
        scheduledRetryAttempt: 2,
        scheduledRetryReason: "ccrotate_capacity",
      });
      const [runningAgent] = await db
        .select({ status: agents.status, errorReason: agents.errorReason })
        .from(agents)
        .where(eq(agents.id, agentId));
      expect(runningAgent).toEqual({ status: "running", errorReason: null });
      observedClaim = true;

      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        summary: "ok",
        resultJson: { summary: "ok", result: "ok" },
        provider: "test",
        model: "test-model",
      };
    });

    await heartbeat.__test_executeRunForTesting(runId);
    expect(observedClaim).toBe(true);

    const finished = await heartbeat.getRun(runId);
    expect(finished).toMatchObject({
      status: "succeeded",
      error: null,
      errorCode: null,
      scheduledRetryAttempt: 2,
      scheduledRetryReason: "ccrotate_capacity",
    });
  });

  async function expectPlainPrReviewFailureSchedulesRetry(errorCode: "adapter_failed" | "process_lost") {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const sourceRunId = randomUUID();
    const now = new Date("2026-05-25T08:00:00.000Z");

    await seedQueuedRunFixture({
      companyId,
      agentId,
      runId: sourceRunId,
      now,
      contextSnapshot: {
        issueId: randomUUID(),
        wakeReason: "github_pr_review_requested",
        reviewKind: "pr_review",
        githubRepoFullName: "Blockcast/paperclip",
        githubPrNumber: 7457,
      },
    });
    mockAdapterExecute.mockResolvedValueOnce({
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: errorCode === "process_lost" ? "Process lost" : "Adapter failed",
      errorCode,
      summary: "failed",
      resultJson: {},
      provider: "test",
      model: "test-model",
    });

    await heartbeat.__test_executeRunForTesting(sourceRunId);

    const sourceRun = await db
      .select({
        status: heartbeatRuns.status,
        errorCode: heartbeatRuns.errorCode,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, sourceRunId))
      .then((rows) => rows[0] ?? null);
    expect(sourceRun).toMatchObject({
      status: "failed",
      errorCode,
    });
    expect(sourceRun?.contextSnapshot as Record<string, unknown>).toMatchObject({
      reviewKind: "pr_review",
    });

    const retryRun = await getScheduledTransientRetryForRun(sourceRunId);
    expect(retryRun).toMatchObject({
      status: "scheduled_retry",
      retryOfRunId: sourceRunId,
      scheduledRetryAttempt: 1,
      scheduledRetryReason: "transient_failure",
    });
    expect(retryRun?.contextSnapshot as Record<string, unknown>).toMatchObject({
      wakeReason: "transient_failure_retry",
      retryReason: "transient_failure",
      reviewKind: "pr_review",
      githubPrNumber: 7457,
    });
  }

  async function seedMaxTurnFixture(input?: {
    companyId?: string;
    agentId?: string;
    issueId?: string;
    runId?: string;
    now?: Date;
    scheduledRetryAttempt?: number;
    runtimeConfig?: Record<string, unknown>;
    issueStatus?: string;
  }) {
    const companyId = input?.companyId ?? randomUUID();
    const agentId = input?.agentId ?? randomUUID();
    const issueId = input?.issueId ?? randomUUID();
    const runId = input?.runId ?? randomUUID();
    const now = input?.now ?? new Date("2026-04-20T12:00:00.000Z");
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "ClaudeCoder",
      role: "engineer",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: input?.runtimeConfig ?? {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
          maxTurnContinuation: {
            enabled: true,
            maxAttempts: 2,
            delayMs: 1_000,
          },
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
      status: "failed",
      error: "Maximum turns reached",
      errorCode: "adapter_failed",
      finishedAt: now,
      scheduledRetryAttempt: input?.scheduledRetryAttempt ?? 0,
      scheduledRetryReason: input?.scheduledRetryAttempt ? MAX_TURN_CONTINUATION_RETRY_REASON : null,
      resultJson: {
        stopReason: "max_turns_exhausted",
      },
      contextSnapshot: {
        issueId,
        wakeReason: "issue_assigned",
      },
      updatedAt: now,
      createdAt: now,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Continue after max turns",
      status: input?.issueStatus ?? "in_progress",
      priority: "medium",
      responsibleUserId: "responsible-user",
      assigneeAgentId: agentId,
      executionRunId: runId,
      executionAgentNameKey: "claudecoder",
      executionLockedAt: now,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    return { companyId, agentId, issueId, runId, now };
  }

  it("schedules a bounded retry for PR-review adapter_failed without adapter recovery metadata", async () => {
    await expectPlainPrReviewFailureSchedulesRetry("adapter_failed");
  });

  it("schedules a bounded retry for PR-review process_lost without adapter recovery metadata", async () => {
    await expectPlainPrReviewFailureSchedulesRetry("process_lost");
  });

  it.each(["adapter_failed", "process_lost"] as const)(
    "does not schedule a bounded retry for non-PR %s without adapter recovery metadata",
    async (errorCode) => {
      const companyId = randomUUID();
      const agentId = randomUUID();
      const sourceRunId = randomUUID();
      const now = new Date("2026-05-25T08:05:00.000Z");

      await seedQueuedRunFixture({
        companyId,
        agentId,
        runId: sourceRunId,
        now,
        contextSnapshot: {
          issueId: randomUUID(),
          wakeReason: "issue_assigned",
        },
      });
      mockAdapterExecute.mockResolvedValueOnce({
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: errorCode === "process_lost" ? "Process lost" : "Adapter failed",
        errorCode,
        summary: "failed",
        resultJson: {},
        provider: "test",
        model: "test-model",
      });

      await heartbeat.__test_executeRunForTesting(sourceRunId);

      expect(await getScheduledTransientRetryForRun(sourceRunId)).toBeNull();
    },
  );

  it("schedules a retry with durable metadata and only promotes it when due", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const sourceRunId = randomUUID();
    const now = new Date("2026-04-20T12:00:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
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

    await db.insert(heartbeatRuns).values({
      id: sourceRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "failed",
      error: "upstream overload",
      errorCode: "adapter_failed",
      finishedAt: now,
      contextSnapshot: {
        issueId: randomUUID(),
        wakeReason: "issue_assigned",
      },
      updatedAt: now,
      createdAt: now,
    });

    const scheduled = await heartbeat.scheduleBoundedRetry(sourceRunId, {
      now,
      random: () => 0.5,
    });

    expect(scheduled.outcome).toBe("scheduled");
    if (scheduled.outcome !== "scheduled") return;

    const expectedDueAt = new Date(now.getTime() + BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS[0]);
    expect(scheduled.attempt).toBe(1);
    expect(scheduled.dueAt.toISOString()).toBe(expectedDueAt.toISOString());

    const retryRun = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, scheduled.run.id))
      .then((rows) => rows[0] ?? null);

    expect(retryRun).toMatchObject({
      status: "scheduled_retry",
      retryOfRunId: sourceRunId,
      scheduledRetryAttempt: 1,
      scheduledRetryReason: "transient_failure",
    });
    expect(retryRun?.contextSnapshot as Record<string, unknown>).not.toHaveProperty("modelProfile");
    expect(retryRun?.scheduledRetryAt?.toISOString()).toBe(expectedDueAt.toISOString());

    // BLO-17456 follow-up: the scheduled-retry event carries the failing
    // errorCode so a recurring code-specific failure is distinguishable from a
    // generic transient blip in the retry event alone.
    const scheduledEvent = await db
      .select({ message: heartbeatRunEvents.message, payload: heartbeatRunEvents.payload })
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, sourceRunId))
      .orderBy(sql`${heartbeatRunEvents.id} desc`)
      .then((rows) => rows.find((row) => row.message.includes("Scheduled bounded retry")) ?? null);
    expect(scheduledEvent?.payload).toMatchObject({
      retryReason: "transient_failure",
      errorCode: "adapter_failed",
    });

    const earlyPromotion = await heartbeat.promoteDueScheduledRetries(new Date("2026-04-20T12:01:59.000Z"));
    expect(earlyPromotion).toEqual({ promoted: 0, runIds: [] });

    const stillScheduled = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, scheduled.run.id))
      .then((rows) => rows[0] ?? null);
    expect(stillScheduled?.status).toBe("scheduled_retry");

    const duePromotion = await heartbeat.promoteDueScheduledRetries(expectedDueAt);
    expect(duePromotion).toEqual({ promoted: 1, runIds: [scheduled.run.id] });

    const promotedRun = await db
      .select({ status: heartbeatRuns.status, queuedAt: heartbeatRuns.queuedAt, createdAt: heartbeatRuns.createdAt })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, scheduled.run.id))
      .then((rows) => rows[0] ?? null);
    expect(promotedRun?.status).toBe("queued");
    // BLO-21116 (Ally review, onprem-k8s#2013): promotion out of
    // scheduled_retry must reset the queued-age clock to the promotion
    // instant, not leave the gauge reading this row's original createdAt --
    // otherwise the queued-run-age gauge reports this run's full retry
    // backoff as dispatch-queue wait the moment it is promoted. (createdAt
    // itself isn't compared here: this test's synthetic clock predates the
    // sandbox's real wall clock, and the retry row's createdAt defaults to
    // the latter at insert time -- an artifact of the test harness, not of
    // the promotion logic under test.)
    expect(promotedRun?.queuedAt?.toISOString()).toBe(expectedDueAt.toISOString());
  });

  // BLO-24166 (split from BLO-23699 AC3): a provider blip on 2026-08-08 burned
  // 606 zero-model-turn runs on one agent, and the open question was whether
  // each one kept holding its concurrency slot across its whole retry chain —
  // which would convert a short upstream outage directly into hours of queue
  // latency for unrelated work on that agent.
  //
  // It does not, and this test pins the two independent reasons so a refactor
  // cannot silently reintroduce the double-count:
  //
  //   1. Ordering — the terminal compare-and-swap (`setRunStatusIfRunning`,
  //      heartbeat.ts, which moves the row out of `running` and stamps
  //      `finishedAt` in one UPDATE) runs BEFORE `scheduleBoundedRetryForRun`
  //      on both finalize paths.
  //   2. Structure — a retry row is inserted `scheduled_retry` and promoted to
  //      `queued`, while a slot is counted ONLY for `status = 'running'`
  //      (`countRunningRunsForAgent` / `listRunningRunsForAgent`). A retry
  //      therefore holds no slot at any point before it wins one itself.
  //
  // Reason 2 is the load-bearing one: it holds even if reason 1 is violated,
  // so the second half of this test deliberately enqueues a retry while the
  // parent is still `running` and asserts the slot count still does not grow.
  it("BLO-24166: a zero-model-turn liveness failure releases its concurrency slot before its retry is enqueued", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const failedRunId = randomUUID();
    const now = new Date("2026-08-08T11:11:09.000Z");

    const countSlotHoldingRuns = () =>
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.status, "running")))
        .then((rows) => rows[0]?.count ?? 0);

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "PlatformSREEngineer",
      role: "engineer",
      status: "active",
      adapterType: "claude_k8s",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 3,
          concurrencyEnabled: true,
        },
      },
      permissions: {},
    });

    // The run as it looked while executing: occupying a slot, and — the case
    // under test — having produced not a single model token.
    await db.insert(heartbeatRuns).values({
      id: failedRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "running",
      startedAt: now,
      usageJson: { inputTokens: 0, outputTokens: 0 },
      contextSnapshot: {
        issueId: randomUUID(),
        wakeReason: "issue_assigned",
      },
      updatedAt: now,
      createdAt: now,
    });

    expect(await countSlotHoldingRuns()).toBe(1);

    // Production finalize order: terminal first, retry second.
    await db
      .update(heartbeatRuns)
      .set({
        status: "failed",
        error: "upstream connection reset",
        errorCode: "claude_transient_upstream",
        finishedAt: now,
        livenessState: "failed",
        livenessReason: "Run ended with failed (claude_transient_upstream)",
        updatedAt: now,
      })
      .where(and(eq(heartbeatRuns.id, failedRunId), eq(heartbeatRuns.status, "running")));

    // The slot is already free at this point — before any retry exists.
    expect(await countSlotHoldingRuns()).toBe(0);

    const scheduled = await heartbeat.scheduleBoundedRetry(failedRunId, {
      now,
      random: () => 0.5,
    });
    expect(scheduled.outcome).toBe("scheduled");
    if (scheduled.outcome !== "scheduled") return;

    const retryRun = await db
      .select({ status: heartbeatRuns.status, retryOfRunId: heartbeatRuns.retryOfRunId })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, scheduled.run.id))
      .then((rows) => rows[0] ?? null);

    // The retry is parked, not running: enqueuing it allocates no slot, so the
    // agent's full concurrency is available to unrelated work immediately.
    expect(retryRun).toMatchObject({ status: "scheduled_retry", retryOfRunId: failedRunId });
    expect(await countSlotHoldingRuns()).toBe(0);

    // Promotion moves it to `queued` — still not a slot. It must win one
    // through the ordinary dispatch gate like any other queued run.
    const promotion = await heartbeat.promoteDueScheduledRetries(
      new Date(now.getTime() + BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS[0]),
    );
    expect(promotion).toEqual({ promoted: 1, runIds: [scheduled.run.id] });
    expect(await countSlotHoldingRuns()).toBe(0);

    // Structural guarantee, independent of ordering: even when a retry is
    // enqueued against a parent that is STILL `running`, the retry does not
    // add a slot-holding row. Only the parent's own single slot is counted.
    const stillRunningId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: stillRunningId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "running",
      startedAt: now,
      usageJson: { inputTokens: 0, outputTokens: 0 },
      contextSnapshot: {
        issueId: randomUUID(),
        wakeReason: "issue_assigned",
      },
      updatedAt: now,
      createdAt: now,
    });
    expect(await countSlotHoldingRuns()).toBe(1);

    const racedRetry = await heartbeat.scheduleBoundedRetry(stillRunningId, {
      now,
      random: () => 0.5,
    });
    expect(racedRetry.outcome).toBe("scheduled");
    if (racedRetry.outcome !== "scheduled") return;

    expect(await countSlotHoldingRuns()).toBe(1);
  });

  it("BLO-24166: the real zero-model-turn failure path leaves the parent terminal at the moment its retry row is inserted", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();

    // The test above hand-performs the terminal transition, so it pins the
    // structural guarantee (a retry row is never `running`) but CANNOT catch a
    // regression that moves retry scheduling ahead of `setRunStatusIfRunning`
    // in executeRun — it would observe the pre-arranged terminal row and pass.
    // This one drives the genuine failure through the production finalizer and
    // observes the ordering from inside the retry INSERT itself, via an AFTER
    // INSERT trigger that records the parent's status at that instant. That is
    // the invariant stated in the issue title, asserted causally rather than by
    // comparing timestamps written by two different clocks.
    await db.execute(sql`
      create table if not exists blo24166_retry_insert_observations (
        retry_run_id uuid primary key,
        parent_run_id uuid not null,
        parent_status text not null,
        retry_status text not null
      )
    `);
    await db.execute(sql`
      create or replace function blo24166_observe_retry_insert() returns trigger as $$
      begin
        insert into blo24166_retry_insert_observations
          (retry_run_id, parent_run_id, parent_status, retry_status)
        select new.id, new.retry_of_run_id, parent.status, new.status
        from heartbeat_runs parent
        where parent.id = new.retry_of_run_id
        on conflict (retry_run_id) do nothing;
        return null;
      end;
      $$ language plpgsql
    `);
    // `retry_of_run_id <> id` excludes the in-place process_lost retry, which
    // points at its own row and is not a parent/child pair at all.
    await db.execute(sql`
      create or replace trigger blo24166_observe_retry_insert
      after insert on heartbeat_runs
      for each row when (new.retry_of_run_id is not null and new.retry_of_run_id <> new.id)
      execute function blo24166_observe_retry_insert()
    `);

    try {
      await db.insert(companies).values({
        id: companyId,
        name: "Paperclip",
        issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
        defaultResponsibleUserId: "responsible-user",
      });

      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "PlatformSREEngineer",
        role: "engineer",
        status: "idle",
        adapterType: ZERO_TURN_TRANSIENT_ADAPTER,
        adapterConfig: {},
        runtimeConfig: {
          heartbeat: {
            wakeOnDemand: true,
            maxConcurrentRuns: 3,
            concurrencyEnabled: true,
          },
        },
        permissions: {},
      });

      const run = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
      expect(run).not.toBeNull();

      const failedRun = await waitForRunToFinish(heartbeat, run!.id);
      expect(failedRun?.status).toBe("failed");
      // The case under test: a full run consumed, not one model token produced.
      const usage = (failedRun?.usageJson as Record<string, unknown> | null) ?? {};
      expect(Number(usage.outputTokens ?? 0)).toBe(0);

      await expect
        .poll(
          () =>
            db
              .select({ id: heartbeatRuns.id })
              .from(heartbeatRuns)
              .where(eq(heartbeatRuns.retryOfRunId, run!.id))
              .then((rows) => rows.length),
          { timeout: 10_000, interval: 50 },
        )
        .toBe(1);

      const observations = await db
        .execute(
          sql`select parent_run_id, parent_status, retry_status
              from blo24166_retry_insert_observations
              where parent_run_id = ${run!.id}`,
        )
        .then((result) => (result as unknown as { rows?: Record<string, unknown>[] }).rows ?? result);

      const rows = observations as Record<string, unknown>[];
      expect(rows).toHaveLength(1);
      // The assertion that the hand-arranged test cannot make: when the retry
      // row came into existence, the parent had ALREADY left `running`, so its
      // slot was free. Reordering executeRun to schedule the retry before
      // setRunStatusIfRunning turns this into "running" and fails the test.
      expect(rows[0].parent_status).not.toBe("running");
      expect(rows[0].parent_status).toBe("failed");
      expect(rows[0].retry_status).toBe("scheduled_retry");

      const slotHolders = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.status, "running")))
        .then((r) => r[0]?.count ?? 0);
      expect(slotHolders).toBe(0);
    } finally {
      await db.execute(sql`drop trigger if exists blo24166_observe_retry_insert on heartbeat_runs`);
      await db.execute(sql`drop function if exists blo24166_observe_retry_insert()`);
      await db.execute(sql`drop table if exists blo24166_retry_insert_observations`);
    }
  });

  it("treats idempotent GitHub PR-review adapter failures as retry-eligible", () => {
    expect(
      shouldScheduleAutomaticRunRetry({
        errorCode: "adapter_failed",
        resultJson: {},
        contextSnapshot: {
          wakeReason: "github_pr_opened",
          reviewKind: "pr_review",
          githubPrNumber: 976,
        },
      }),
    ).toBe(true);

    expect(
      shouldScheduleAutomaticRunRetry({
        errorCode: "process_lost",
        resultJson: {},
        contextSnapshot: {
          wakeReason: "github_pr_review_submitted",
          reviewKind: "pr_review",
          githubPrNumber: 976,
        },
      }),
    ).toBe(true);

    expect(
      shouldScheduleAutomaticRunRetry({
        errorCode: "process_lost",
        resultJson: {},
        contextSnapshot: {
          taskKey: "pr_review:blockcast/paperclip:976",
          wakeReason: "process_lost_retry",
        },
      }),
    ).toBe(true);
  });

  it("schedules accepted interaction continuation infra retries while the issue is in_review", async () => {
    const { issueId, runId, now } = await seedMaxTurnFixture({ issueStatus: "in_review" });
    const interactionId = randomUUID();

    await db
      .update(heartbeatRuns)
      .set({
        error: "workspace validation failed before dispatch",
        errorCode: "workspace_validation_failed",
        resultJson: {},
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

    const scheduled = await heartbeat.scheduleBoundedRetry(runId, {
      now,
      random: () => 0.5,
      retryReason: INTERACTION_CONTINUATION_INFRA_RETRY_REASON,
      wakeReason: INTERACTION_CONTINUATION_INFRA_WAKE_REASON,
      maxAttempts: 3,
    });

    expect(scheduled.outcome).toBe("scheduled");
    if (scheduled.outcome !== "scheduled") return;
    expect(scheduled.attempt).toBe(1);
    expect(scheduled.maxAttempts).toBe(3);

    const retryRun = await db
      .select({
        retryOfRunId: heartbeatRuns.retryOfRunId,
        status: heartbeatRuns.status,
        scheduledRetryAttempt: heartbeatRuns.scheduledRetryAttempt,
        scheduledRetryReason: heartbeatRuns.scheduledRetryReason,
        contextSnapshot: heartbeatRuns.contextSnapshot,
        wakeupRequestId: heartbeatRuns.wakeupRequestId,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, scheduled.run.id))
      .then((rows) => rows[0] ?? null);

    expect(retryRun).toMatchObject({
      retryOfRunId: runId,
      status: "scheduled_retry",
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

    const wakeupRequest = await db
      .select({ reason: agentWakeupRequests.reason, payload: agentWakeupRequests.payload })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, retryRun?.wakeupRequestId ?? ""))
      .then((rows) => rows[0] ?? null);
    expect(wakeupRequest?.reason).toBe(INTERACTION_CONTINUATION_INFRA_WAKE_REASON);
    expect(wakeupRequest?.payload).toMatchObject({
      issueId,
      interactionId,
      retryOfRunId: runId,
      retryReason: INTERACTION_CONTINUATION_INFRA_RETRY_REASON,
      scheduledRetryAttempt: 1,
    });

    const issue = await db
      .select({ executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.executionRunId).toBeNull();
  });

  it("does not retry the permanent claude_k8s agent-home workspace failure", () => {
    expect(
      isRetryableInteractionContinuationInfrastructureFailure({
        error: "workspace validation failed before dispatch",
        errorCode: "workspace_validation_failed",
        resultJson: {
          workspaceValidation: {
            reason: "k8s_agent_home_git_bootstrap_unsupported",
          },
        },
      }),
    ).toBe(false);
  });

  it("coalesces duplicate accepted interaction continuation infra retry schedules", async () => {
    const { issueId, runId, now } = await seedMaxTurnFixture({ issueStatus: "in_review" });
    const interactionId = randomUUID();
    await db
      .update(heartbeatRuns)
      .set({
        error: "workspace validation failed before dispatch",
        errorCode: "workspace_validation_failed",
        resultJson: {},
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

    const retryOptions = {
      now,
      retryReason: INTERACTION_CONTINUATION_INFRA_RETRY_REASON,
      wakeReason: INTERACTION_CONTINUATION_INFRA_WAKE_REASON,
      maxAttempts: 3,
    };
    const [first, second] = await Promise.all([
      heartbeat.scheduleBoundedRetry(runId, retryOptions),
      heartbeat.scheduleBoundedRetry(runId, retryOptions),
    ]);

    expect(first.outcome).toBe("scheduled");
    expect(second.outcome).toBe("scheduled");
    if (first.outcome !== "scheduled" || second.outcome !== "scheduled") return;
    expect(new Set([first.run.id, second.run.id]).size).toBe(1);

    const retryRuns = await db
      .select({ id: heartbeatRuns.id, wakeupRequestId: heartbeatRuns.wakeupRequestId })
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.retryOfRunId, runId),
        eq(heartbeatRuns.scheduledRetryReason, INTERACTION_CONTINUATION_INFRA_RETRY_REASON),
        eq(heartbeatRuns.scheduledRetryAttempt, 1),
      ));
    expect(retryRuns).toHaveLength(1);

    const wakeups = await db
      .select({
        id: agentWakeupRequests.id,
        coalescedCount: agentWakeupRequests.coalescedCount,
        idempotencyKey: agentWakeupRequests.idempotencyKey,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.reason, INTERACTION_CONTINUATION_INFRA_WAKE_REASON));
    expect(wakeups).toHaveLength(1);
    expect(wakeups[0]).toMatchObject({
      id: retryRuns[0]?.wakeupRequestId,
      coalescedCount: 1,
    });
    expect(wakeups[0]?.idempotencyKey).toContain(`:${issueId}:${runId}:1`);
  });

  it("does not coalesce distinct interaction continuation attempts", async () => {
    const { companyId, agentId, issueId, runId, now } = await seedMaxTurnFixture({ issueStatus: "in_review" });
    const firstInteractionId = randomUUID();
    const secondSourceRunId = randomUUID();

    await db
      .update(heartbeatRuns)
      .set({
        error: "workspace validation failed before dispatch",
        errorCode: "workspace_validation_failed",
        resultJson: {},
        contextSnapshot: {
          issueId,
          taskId: issueId,
          wakeReason: "issue_commented",
          mutation: "interaction",
          interactionId: firstInteractionId,
          interactionKind: "request_confirmation",
          interactionStatus: "accepted",
        },
      })
      .where(eq(heartbeatRuns.id, runId));

    const retryOptions = {
      retryReason: INTERACTION_CONTINUATION_INFRA_RETRY_REASON,
      wakeReason: INTERACTION_CONTINUATION_INFRA_WAKE_REASON,
      maxAttempts: 3,
      random: () => 0.5,
    };
    const first = await heartbeat.scheduleBoundedRetry(runId, { now, ...retryOptions });
    expect(first.outcome).toBe("scheduled");
    if (first.outcome !== "scheduled") return;

    await db.insert(heartbeatRuns).values({
      id: secondSourceRunId,
      companyId,
      agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "failed",
      error: "workspace validation failed before dispatch",
      errorCode: "workspace_validation_failed",
      scheduledRetryAttempt: 1,
      scheduledRetryReason: INTERACTION_CONTINUATION_INFRA_RETRY_REASON,
      contextSnapshot: {
        issueId,
        taskId: issueId,
        wakeReason: "issue_commented",
        mutation: "interaction",
        interactionId: randomUUID(),
        interactionKind: "request_confirmation",
        interactionStatus: "accepted",
      },
      finishedAt: new Date(now.getTime() + 1_000),
      updatedAt: new Date(now.getTime() + 1_000),
      createdAt: new Date(now.getTime() + 1_000),
    });

    const second = await heartbeat.scheduleBoundedRetry(secondSourceRunId, {
      now: new Date(now.getTime() + 1_000),
      ...retryOptions,
    });
    expect(second.outcome).toBe("scheduled");
    if (second.outcome !== "scheduled") return;
    expect(second.run.id).not.toBe(first.run.id);
    expect(second.run.retryOfRunId).toBe(secondSourceRunId);
    expect(second.run.scheduledRetryAttempt).toBe(2);

    const retries = await db
      .select({ id: heartbeatRuns.id, retryOfRunId: heartbeatRuns.retryOfRunId, attempt: heartbeatRuns.scheduledRetryAttempt })
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.companyId, companyId),
        eq(heartbeatRuns.scheduledRetryReason, INTERACTION_CONTINUATION_INFRA_RETRY_REASON),
        inArray(heartbeatRuns.retryOfRunId, [runId, secondSourceRunId]),
      ));
    expect(retries).toHaveLength(2);
    expect(retries.map((retry) => retry.attempt).sort()).toEqual([1, 2]);
    expect(retries.map((retry) => retry.retryOfRunId)).toEqual([runId, secondSourceRunId]);
  });

  it.each([
    {
      name: "renamed branch",
      workspaceValidation: (workspaceId: string) => ({
        reason: "git_worktree_branch_incoherence",
        fingerprint: "workspace_incoherence:v1:sha256:renamed",
        executionWorkspaceId: workspaceId,
        expectedBranch: "stale-plan-approval-workspace",
        actualBranch: "feat/skill-studio-test-runs",
        cleanliness: "clean",
      }),
    },
    {
      name: "dirty worktree",
      workspaceValidation: (workspaceId: string) => ({
        reason: "git_worktree_branch_incoherence",
        fingerprint: "workspace_incoherence:v1:sha256:dirty",
        executionWorkspaceId: workspaceId,
        expectedBranch: "stale-plan-approval-workspace",
        actualBranch: "feat/skill-studio-test-runs",
        cleanliness: "dirty",
        safeRepair: {
          eligible: false,
          attempted: false,
          succeeded: false,
          reason: "worktree is not clean",
        },
      }),
    },
  ])("quarantines a failed $name workspace before scheduling the accepted interaction retry", async ({ workspaceValidation }) => {
    const { companyId, agentId, issueId, runId, now } = await seedMaxTurnFixture({ issueStatus: "in_review" });
    const projectId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const validation = workspaceValidation(executionWorkspaceId);

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Paperclip App",
      status: "in_progress",
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      sourceIssueId: issueId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "stale-plan-approval-workspace",
      status: "active",
      cwd: "/workspace/stale-plan-approval-workspace",
      baseRef: "origin/master",
      branchName: "stale-plan-approval-workspace",
      providerType: "git_worktree",
      providerRef: "/workspace/stale-plan-approval-workspace",
      metadata: { existing: true },
    });
    await db
      .update(issues)
      .set({
        projectId,
        executionWorkspaceId,
        executionWorkspacePreference: "reuse_existing",
        executionWorkspaceSettings: { mode: "isolated_workspace" },
      })
      .where(eq(issues.id, issueId));

    const interactionId = randomUUID();
    await db
      .update(heartbeatRuns)
      .set({
        error: "workspace validation failed before dispatch",
        errorCode: "workspace_validation_failed",
        resultJson: { workspaceValidation: validation },
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

    const scheduled = await heartbeat.scheduleBoundedRetry(runId, {
      now,
      random: () => 0.5,
      retryReason: INTERACTION_CONTINUATION_INFRA_RETRY_REASON,
      wakeReason: INTERACTION_CONTINUATION_INFRA_WAKE_REASON,
      maxAttempts: 3,
    });

    expect(scheduled.outcome).toBe("scheduled");
    if (scheduled.outcome !== "scheduled") return;

    const issue = await db
      .select({
        executionRunId: issues.executionRunId,
        executionWorkspaceId: issues.executionWorkspaceId,
        executionWorkspacePreference: issues.executionWorkspacePreference,
        executionWorkspaceSettings: issues.executionWorkspaceSettings,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue).toMatchObject({
      executionRunId: null,
      executionWorkspaceId: null,
      executionWorkspacePreference: null,
      executionWorkspaceSettings: { mode: "isolated_workspace" },
    });

    const workspace = await db
      .select({
        status: executionWorkspaces.status,
        closedAt: executionWorkspaces.closedAt,
        cleanupEligibleAt: executionWorkspaces.cleanupEligibleAt,
        cleanupReason: executionWorkspaces.cleanupReason,
        metadata: executionWorkspaces.metadata,
      })
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, executionWorkspaceId))
      .then((rows) => rows[0] ?? null);
    expect(workspace).toMatchObject({
      status: "archived",
      cleanupEligibleAt: null,
      cleanupReason: "workspace_validation_failed",
    });
    expect(workspace?.closedAt?.toISOString()).toBe(now.toISOString());
    expect(workspace?.metadata).toMatchObject({
      existing: true,
      workspaceValidationQuarantine: {
        reason: "workspace_validation_failed",
        retryReason: INTERACTION_CONTINUATION_INFRA_RETRY_REASON,
        sourceRunId: runId,
        retryRunId: scheduled.run.id,
        issueId,
        sourceIssueId: issueId,
        workspaceValidation: validation,
      },
    });

    const retryRun = await db
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, scheduled.run.id))
      .then((rows) => rows[0] ?? null);
    expect(retryRun?.contextSnapshot).toMatchObject({
      workspaceValidationRecovery: {
        strategy: "quarantine_failed_workspace_and_retry_clean",
        sourceRunId: runId,
        reason: "git_worktree_branch_incoherence",
        fingerprint: validation.fingerprint,
        failedExecutionWorkspaceId: executionWorkspaceId,
      },
    });

    const activity = await db
      .select({ action: activityLog.action, entityId: activityLog.entityId, details: activityLog.details })
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.action, "execution_workspace.workspace_validation_quarantined"),
      ))
      .then((rows) => rows[0] ?? null);
    expect(activity).toMatchObject({
      action: "execution_workspace.workspace_validation_quarantined",
      entityId: executionWorkspaceId,
      details: expect.objectContaining({
        retryRunId: scheduled.run.id,
        workspaceValidation: validation,
      }),
    });

    const agent = await db
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0] ?? null);
    expect(agent?.id).toBe(agentId);
  });

  // BLO-21605: the workspace-quarantine branch of `scheduleBoundedRetry` used
  // to fire `logActivity` from inside its `db.transaction` callback, so a
  // consumer could receive `activity.logged` before the workspace's
  // `archived` status committed, and a rolled-back transaction still emitted
  // an event for a quarantine that never took effect.
  async function seedQuarantineFixture(workspaceId: string, workspaceName: string) {
    const { companyId, agentId, issueId, runId, now } = await seedMaxTurnFixture({ issueStatus: "in_review" });
    const projectId = randomUUID();
    const validation = {
      reason: "git_worktree_branch_incoherence",
      fingerprint: `workspace_incoherence:v1:sha256:${workspaceName}`,
      executionWorkspaceId: workspaceId,
      expectedBranch: workspaceName,
      actualBranch: "feat/skill-studio-test-runs",
      cleanliness: "clean" as const,
    };

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Paperclip App",
      status: "in_progress",
    });
    await db.insert(executionWorkspaces).values({
      id: workspaceId,
      companyId,
      projectId,
      sourceIssueId: issueId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: workspaceName,
      status: "active",
      cwd: `/workspace/${workspaceName}`,
      baseRef: "origin/master",
      branchName: workspaceName,
      providerType: "git_worktree",
      providerRef: `/workspace/${workspaceName}`,
      metadata: { existing: true },
    });
    await db
      .update(issues)
      .set({
        projectId,
        executionWorkspaceId: workspaceId,
        executionWorkspacePreference: "reuse_existing",
        executionWorkspaceSettings: { mode: "isolated_workspace" },
      })
      .where(eq(issues.id, issueId));

    const interactionId = randomUUID();
    await db
      .update(heartbeatRuns)
      .set({
        error: "workspace validation failed before dispatch",
        errorCode: "workspace_validation_failed",
        resultJson: { workspaceValidation: validation },
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

    return { companyId, agentId, issueId, runId, now };
  }

  // Subscribes to `activity.logged` for the given action and, at the moment
  // each event fires, kicks off a `snapshot()` read on a connection outside
  // the transaction that logged it. Whether that read observes the committed
  // effect is what distinguishes "published after commit" from "published
  // from inside the transaction".
  function captureActivityEvents<T>(companyId: string, action: string, snapshot: () => Promise<T>) {
    const seen: { valueAtPublish: Promise<T> }[] = [];
    const unsubscribe = subscribeCompanyLiveEvents(companyId, (event) => {
      if (event.type !== "activity.logged") return;
      const payload = event.payload as Record<string, unknown>;
      if (payload.action !== action) return;
      seen.push({ valueAtPublish: snapshot() });
    });
    return { seen, stop: unsubscribe };
  }

  it("emits no activity.logged event when the workspace-quarantine transaction fails to commit", async () => {
    const workspaceId = randomUUID();
    const { companyId, runId, now } = await seedQuarantineFixture(workspaceId, "rollback-workspace");

    // Runs the real transaction -- workspace archival and the activity_log
    // insert both succeed -- then aborts it, standing in for a commit-time
    // failure.
    const rollbackDb = new Proxy(db, {
      get(target, property, receiver) {
        if (property === "transaction") {
          return (callback: (tx: unknown) => Promise<unknown>, ...rest: unknown[]) =>
            (target.transaction as unknown as (
              cb: (tx: unknown) => Promise<unknown>,
              ...args: unknown[]
            ) => Promise<unknown>)(async (tx) => {
              await callback(tx);
              throw new Error("simulated commit failure after insert");
            }, ...rest);
        }
        return Reflect.get(target, property, receiver);
      },
    }) as typeof db;
    const rollbackHeartbeat = heartbeatService(rollbackDb);

    const events = captureActivityEvents(
      companyId,
      "execution_workspace.workspace_validation_quarantined",
      () => db
        .select({ status: executionWorkspaces.status })
        .from(executionWorkspaces)
        .where(eq(executionWorkspaces.id, workspaceId))
        .then((rows) => rows[0]?.status ?? null),
    );
    try {
      await expect(rollbackHeartbeat.scheduleBoundedRetry(runId, {
        now,
        random: () => 0.5,
        retryReason: INTERACTION_CONTINUATION_INFRA_RETRY_REASON,
        wakeReason: INTERACTION_CONTINUATION_INFRA_WAKE_REASON,
        maxAttempts: 3,
      })).rejects.toBeDefined();
    } finally {
      events.stop();
    }

    expect(
      events.seen,
      "a rolled-back quarantine must not publish a phantom activity event",
    ).toHaveLength(0);
    const workspace = await db
      .select({ status: executionWorkspaces.status })
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, workspaceId))
      .then((rows) => rows[0] ?? null);
    expect(workspace?.status).toBe("active");
    const activity = await db
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(eq(activityLog.entityId, workspaceId));
    expect(activity).toHaveLength(0);
  });

  it("publishes execution_workspace.workspace_validation_quarantined only once the archived status is visible", async () => {
    const workspaceId = randomUUID();
    const { companyId, runId, now } = await seedQuarantineFixture(workspaceId, "visible-workspace");

    const events = captureActivityEvents(
      companyId,
      "execution_workspace.workspace_validation_quarantined",
      () => db
        .select({ status: executionWorkspaces.status })
        .from(executionWorkspaces)
        .where(eq(executionWorkspaces.id, workspaceId))
        .then((rows) => rows[0]?.status ?? null),
    );
    try {
      const scheduled = await heartbeat.scheduleBoundedRetry(runId, {
        now,
        random: () => 0.5,
        retryReason: INTERACTION_CONTINUATION_INFRA_RETRY_REASON,
        wakeReason: INTERACTION_CONTINUATION_INFRA_WAKE_REASON,
        maxAttempts: 3,
      });
      expect(scheduled.outcome).toBe("scheduled");
    } finally {
      events.stop();
    }

    expect(events.seen).toHaveLength(1);
    // Read taken from inside the event listener, on a connection outside the
    // quarantining transaction: the "archived" status is only visible there
    // after commit, so a pre-commit publication would observe the stale
    // "active" status instead.
    await expect(
      events.seen[0]!.valueAtPublish,
      "the archived status must already be visible to other connections when the event fires",
    ).resolves.toBe("archived");
  });

  it("does not quarantine another issue's workspace when validation payload is stale", async () => {
    const { companyId, issueId, runId, now } = await seedMaxTurnFixture({ issueStatus: "in_review" });
    const projectId = randomUUID();
    const currentWorkspaceId = randomUUID();
    const foreignIssueId = randomUUID();
    const foreignWorkspaceId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const validation = {
      reason: "git_worktree_branch_incoherence",
      fingerprint: "workspace_incoherence:v1:sha256:stale",
      executionWorkspaceId: foreignWorkspaceId,
      expectedBranch: "current-issue-branch",
      actualBranch: "foreign-issue-branch",
      cleanliness: "clean",
    };

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Paperclip App",
      status: "in_progress",
    });
    await db.insert(issues).values({
      id: foreignIssueId,
      companyId,
      title: "Other active issue",
      status: "in_progress",
      priority: "medium",
      responsibleUserId: "responsible-user",
      issueNumber: 2,
      identifier: `${issuePrefix}-2`,
    });
    await db.insert(executionWorkspaces).values([
      {
        id: currentWorkspaceId,
        companyId,
        projectId,
        sourceIssueId: issueId,
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        name: "current-issue-branch",
        status: "active",
        cwd: "/workspace/current-issue-branch",
        baseRef: "origin/master",
        branchName: "current-issue-branch",
        providerType: "git_worktree",
        providerRef: "/workspace/current-issue-branch",
        metadata: { current: true },
      },
      {
        id: foreignWorkspaceId,
        companyId,
        projectId,
        sourceIssueId: foreignIssueId,
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        name: "foreign-issue-branch",
        status: "active",
        cwd: "/workspace/foreign-issue-branch",
        baseRef: "origin/master",
        branchName: "foreign-issue-branch",
        providerType: "git_worktree",
        providerRef: "/workspace/foreign-issue-branch",
        metadata: { foreign: true },
      },
    ]);
    await db
      .update(issues)
      .set({
        projectId,
        executionWorkspaceId: foreignWorkspaceId,
        executionWorkspacePreference: "reuse_existing",
        executionWorkspaceSettings: { mode: "isolated_workspace" },
      })
      .where(eq(issues.id, issueId));

    const interactionId = randomUUID();
    await db
      .update(heartbeatRuns)
      .set({
        error: "workspace validation failed before dispatch",
        errorCode: "workspace_validation_failed",
        resultJson: { workspaceValidation: validation },
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

    const scheduled = await heartbeat.scheduleBoundedRetry(runId, {
      now,
      random: () => 0.5,
      retryReason: INTERACTION_CONTINUATION_INFRA_RETRY_REASON,
      wakeReason: INTERACTION_CONTINUATION_INFRA_WAKE_REASON,
      maxAttempts: 3,
    });

    expect(scheduled.outcome).toBe("scheduled");
    if (scheduled.outcome !== "scheduled") return;

    const issue = await db
      .select({
        executionRunId: issues.executionRunId,
        executionWorkspaceId: issues.executionWorkspaceId,
        executionWorkspacePreference: issues.executionWorkspacePreference,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue).toMatchObject({
      executionRunId: null,
      executionWorkspaceId: foreignWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
    });

    const workspaces = await db
      .select({ id: executionWorkspaces.id, status: executionWorkspaces.status, metadata: executionWorkspaces.metadata })
      .from(executionWorkspaces)
      .where(inArray(executionWorkspaces.id, [currentWorkspaceId, foreignWorkspaceId]));
    expect(workspaces).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: currentWorkspaceId, status: "active", metadata: { current: true } }),
      expect.objectContaining({ id: foreignWorkspaceId, status: "active", metadata: { foreign: true } }),
    ]));

    const activity = await db
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.action, "execution_workspace.workspace_validation_quarantined"),
      ));
    expect(activity).toHaveLength(0);
  });

  it("does not quarantine an owned workspace that is no longer attached to the issue", async () => {
    const { companyId, issueId, runId, now } = await seedMaxTurnFixture({ issueStatus: "in_review" });
    const projectId = randomUUID();
    const staleWorkspaceId = randomUUID();
    const currentWorkspaceId = randomUUID();
    const validation = {
      reason: "git_worktree_branch_incoherence",
      fingerprint: "workspace_incoherence:v1:sha256:stale-owned",
      executionWorkspaceId: staleWorkspaceId,
      expectedBranch: "old-plan-approval-workspace",
      actualBranch: "current-plan-approval-workspace",
      cleanliness: "clean",
    };

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Paperclip App",
      status: "in_progress",
    });
    await db.insert(executionWorkspaces).values([
      {
        id: staleWorkspaceId,
        companyId,
        projectId,
        sourceIssueId: issueId,
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        name: "old-plan-approval-workspace",
        status: "active",
        cwd: "/workspace/old-plan-approval-workspace",
        baseRef: "origin/master",
        branchName: "old-plan-approval-workspace",
        providerType: "git_worktree",
        providerRef: "/workspace/old-plan-approval-workspace",
        metadata: { stale: true },
      },
      {
        id: currentWorkspaceId,
        companyId,
        projectId,
        sourceIssueId: issueId,
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        name: "current-plan-approval-workspace",
        status: "active",
        cwd: "/workspace/current-plan-approval-workspace",
        baseRef: "origin/master",
        branchName: "current-plan-approval-workspace",
        providerType: "git_worktree",
        providerRef: "/workspace/current-plan-approval-workspace",
        metadata: { current: true },
      },
    ]);
    await db
      .update(issues)
      .set({
        projectId,
        executionWorkspaceId: currentWorkspaceId,
        executionWorkspacePreference: "reuse_existing",
        executionWorkspaceSettings: { mode: "isolated_workspace" },
      })
      .where(eq(issues.id, issueId));

    const interactionId = randomUUID();
    await db
      .update(heartbeatRuns)
      .set({
        error: "workspace validation failed before dispatch",
        errorCode: "workspace_validation_failed",
        resultJson: { workspaceValidation: validation },
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

    const scheduled = await heartbeat.scheduleBoundedRetry(runId, {
      now,
      random: () => 0.5,
      retryReason: INTERACTION_CONTINUATION_INFRA_RETRY_REASON,
      wakeReason: INTERACTION_CONTINUATION_INFRA_WAKE_REASON,
      maxAttempts: 3,
    });

    expect(scheduled.outcome).toBe("scheduled");
    if (scheduled.outcome !== "scheduled") return;

    const issue = await db
      .select({
        executionRunId: issues.executionRunId,
        executionWorkspaceId: issues.executionWorkspaceId,
        executionWorkspacePreference: issues.executionWorkspacePreference,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue).toMatchObject({
      executionRunId: null,
      executionWorkspaceId: currentWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
    });

    const workspaces = await db
      .select({ id: executionWorkspaces.id, status: executionWorkspaces.status, metadata: executionWorkspaces.metadata })
      .from(executionWorkspaces)
      .where(inArray(executionWorkspaces.id, [staleWorkspaceId, currentWorkspaceId]));
    expect(workspaces).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: staleWorkspaceId, status: "active", metadata: { stale: true } }),
      expect.objectContaining({ id: currentWorkspaceId, status: "active", metadata: { current: true } }),
    ]));

    const activity = await db
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.action, "execution_workspace.workspace_validation_quarantined"),
      ));
    expect(activity).toHaveLength(0);
  });

  it("does not schedule accepted interaction continuation infra retries after terminal issue status", async () => {
    const { issueId, runId, now } = await seedMaxTurnFixture({ issueStatus: "done" });

    await db
      .update(heartbeatRuns)
      .set({
        error: "workspace validation failed before dispatch",
        errorCode: "workspace_validation_failed",
        resultJson: {},
        contextSnapshot: {
          issueId,
          taskId: issueId,
          wakeReason: "issue_commented",
          mutation: "interaction",
          interactionId: randomUUID(),
          interactionKind: "request_confirmation",
          interactionStatus: "accepted",
        },
      })
      .where(eq(heartbeatRuns.id, runId));

    const scheduled = await heartbeat.scheduleBoundedRetry(runId, {
      now,
      retryReason: INTERACTION_CONTINUATION_INFRA_RETRY_REASON,
      wakeReason: INTERACTION_CONTINUATION_INFRA_WAKE_REASON,
      maxAttempts: 3,
    });

    expect(scheduled).toMatchObject({
      outcome: "not_scheduled",
      errorCode: "issue_terminal_status",
      issueId,
    });
  });

  it("BLO-8215: retries a pr_review_auth_expired run in a PR-review context", () => {
    expect(
      shouldScheduleAutomaticRunRetry({
        errorCode: "pr_review_auth_expired",
        resultJson: {},
        contextSnapshot: { wakeReason: "github_pr_review_submitted", reviewKind: "pr_review", githubPrNumber: 230 },
      }),
    ).toBe(true);
  });

  it("BLO-8215: does not retry a pr_review_auth_expired code outside a PR-review context", () => {
    expect(
      shouldScheduleAutomaticRunRetry({
        errorCode: "pr_review_auth_expired",
        resultJson: {},
        contextSnapshot: { issueId: randomUUID(), wakeReason: "issue_assigned" },
      }),
    ).toBe(false);
  });

  it("BLO-17456: retries a pr_review_output_missing run, including a taskKey-only persisted snapshot", () => {
    // Mirrors the BLO-8215 pr_review_auth_expired gate: a run that left no
    // durable review/skip evidence must still get a bounded automatic retry
    // instead of stranding the exact-head gate on a terminal failure.
    expect(
      shouldScheduleAutomaticRunRetry({
        errorCode: "pr_review_output_missing",
        resultJson: {},
        contextSnapshot: { taskKey: "pr_review:blockcast/pim-multicast-gateway:1656" },
      }),
    ).toBe(true);

    expect(
      shouldScheduleAutomaticRunRetry({
        errorCode: "pr_review_output_missing",
        resultJson: {},
        contextSnapshot: { wakeReason: "github_pr_review_requested", reviewKind: "pr_review", githubPrNumber: 1656 },
      }),
    ).toBe(true);
  });

  it("BLO-17456: does not retry a pr_review_output_missing code outside a PR-review context", () => {
    expect(
      shouldScheduleAutomaticRunRetry({
        errorCode: "pr_review_output_missing",
        resultJson: {},
        contextSnapshot: { issueId: randomUUID(), wakeReason: "issue_assigned" },
      }),
    ).toBe(false);

    // Guards the gate specifically, not the fall-through: a taskKey that is
    // present but NOT `pr_review:`-prefixed must still be rejected, so a future
    // weakening of isPrReviewRetryContext to "any taskKey present" is caught.
    expect(
      shouldScheduleAutomaticRunRetry({
        errorCode: "pr_review_output_missing",
        resultJson: {},
        contextSnapshot: { taskKey: `issue:${randomUUID()}:42`, wakeReason: "issue_assigned" },
      }),
    ).toBe(false);

    // Null/malformed snapshot must not throw and must stay terminal (parseObject
    // collapses non-objects to {}, isPrReviewRetryContext then returns false).
    expect(
      shouldScheduleAutomaticRunRetry({
        errorCode: "pr_review_output_missing",
        resultJson: {},
        contextSnapshot: null,
      }),
    ).toBe(false);
  });

  it("retries reviewer-verification outages only in a PR-review context", () => {
    expect(
      shouldScheduleAutomaticRunRetry({
        errorCode: "pr_review_verification_unavailable",
        resultJson: {},
        contextSnapshot: { taskKey: "pr_review:blockcast/onprem-k8s:1817" },
      }),
    ).toBe(true);

    expect(
      shouldScheduleAutomaticRunRetry({
        errorCode: "pr_review_verification_unavailable",
        resultJson: {},
        contextSnapshot: { issueId: randomUUID(), wakeReason: "issue_assigned" },
      }),
    ).toBe(false);
  });

  // BLO-18030 — external_lifecycle_stale_killed retry gate.
  //
  // The 2026-07-25 PR #1758 incident: a pr_review wake was claimed, went silent,
  // and was force-killed at EXTERNAL_LIFECYCLE_HARD_STALE_MS. The run was left
  // terminal with NO bounded retry (this predicate returned false), and its
  // agent_wakeup_requests row was set to `failed`, which
  // reconcileFailedWakeDispatches never selects. The review simply never
  // happened. These tests pin the retry on, and pin the double-review guard that
  // makes it safe.
  it("BLO-18030: retries a stale-killed pr_review run once the probe proved no review landed", () => {
    expect(
      shouldScheduleAutomaticRunRetry({
        errorCode: "external_lifecycle_stale_killed",
        resultJson: { externalLifecycleRecovery: { reviewEvidenceFound: false } },
        contextSnapshot: { taskKey: "pr_review:Blockcast/pim-multicast-gateway:1758" },
      }),
    ).toBe(true);

    expect(
      shouldScheduleAutomaticRunRetry({
        errorCode: "external_lifecycle_stale_killed",
        resultJson: { externalLifecycleRecovery: { reviewEvidenceFound: false } },
        contextSnapshot: {
          wakeReason: "github_pr_synchronized",
          reviewKind: "pr_review",
          githubPrNumber: 1758,
        },
      }),
    ).toBe(true);
  });

  it("BLO-18030: never retries a stale-killed run that may already have posted a review", () => {
    // A review WAS found at this head -- retrying would double-review.
    expect(
      shouldScheduleAutomaticRunRetry({
        errorCode: "external_lifecycle_stale_killed",
        resultJson: { externalLifecycleRecovery: { reviewEvidenceFound: true } },
        contextSnapshot: { taskKey: "pr_review:Blockcast/pim-multicast-gateway:1758" },
      }),
    ).toBe(false);

    // Probe errored or no PR context => no flag recorded at all. Absence must be
    // read as "unproven", NOT as "safe to retry": a stale-killed run really was
    // running and may have posted. This is the case that distinguishes this gate
    // from job_missing/k8s_pod_schedule_failed, where the pod provably never ran.
    expect(
      shouldScheduleAutomaticRunRetry({
        errorCode: "external_lifecycle_stale_killed",
        resultJson: { externalLifecycleRecovery: { reason: "external_lifecycle_stale_killed" } },
        contextSnapshot: { taskKey: "pr_review:Blockcast/pim-multicast-gateway:1758" },
      }),
    ).toBe(false);

    expect(
      shouldScheduleAutomaticRunRetry({
        errorCode: "external_lifecycle_stale_killed",
        resultJson: {},
        contextSnapshot: { taskKey: "pr_review:Blockcast/pim-multicast-gateway:1758" },
      }),
    ).toBe(false);
  });

  it("BLO-18030: does not retry a stale-killed run outside a PR-review context", () => {
    // Leak guard, matching k8s_concurrent_run_blocked / job_missing: a proven-no-
    // review issue run must stay terminal rather than re-queueing arbitrary work.
    expect(
      shouldScheduleAutomaticRunRetry({
        errorCode: "external_lifecycle_stale_killed",
        resultJson: { externalLifecycleRecovery: { reviewEvidenceFound: false } },
        contextSnapshot: { issueId: randomUUID(), wakeReason: "issue_assigned" },
      }),
    ).toBe(false);

    // A present-but-not-pr_review taskKey must also be rejected, so a future
    // weakening of isPrReviewRetryContext is caught here too.
    expect(
      shouldScheduleAutomaticRunRetry({
        errorCode: "external_lifecycle_stale_killed",
        resultJson: { externalLifecycleRecovery: { reviewEvidenceFound: false } },
        contextSnapshot: { taskKey: `issue:${randomUUID()}:42`, wakeReason: "issue_assigned" },
      }),
    ).toBe(false);

    // Malformed snapshot must not throw and must stay terminal.
    expect(
      shouldScheduleAutomaticRunRetry({
        errorCode: "external_lifecycle_stale_killed",
        resultJson: { externalLifecycleRecovery: { reviewEvidenceFound: false } },
        contextSnapshot: null,
      }),
    ).toBe(false);
  });

  // BLO-18030 review (Important): the stale-kill gate must be evaluated BEFORE
  // readTransientRecoveryContractFromRun's unconditional `return true`.
  // Stale-kill finalization merges into the run's PRIOR resultJson, so a run
  // that hit a transient upstream error earlier in its life keeps that
  // errorFamily on the record. With the gate ordered after the transient check,
  // that retained family authorized the retry before the review-evidence gate
  // ran at all — reintroducing exactly the double-review the gate exists to
  // prevent, and only for runs carrying stale transient metadata (which is why
  // the original ordering looked correct in every other test above).
  it("BLO-18030: a retained transient errorFamily cannot bypass the stale-kill evidence gate", () => {
    for (const errorFamily of ["transient_upstream", "rate_limit_exhausted", "provider_quota"]) {
      // Unproven evidence + retained transient family => still terminal.
      expect(
        shouldScheduleAutomaticRunRetry({
          errorCode: "external_lifecycle_stale_killed",
          resultJson: {
            errorFamily,
            externalLifecycleRecovery: { reason: "external_lifecycle_stale_killed" },
          },
          contextSnapshot: { taskKey: "pr_review:Blockcast/pim-multicast-gateway:1758" },
        }),
      ).toBe(false);

      // A review WAS found + retained transient family => still terminal.
      expect(
        shouldScheduleAutomaticRunRetry({
          errorCode: "external_lifecycle_stale_killed",
          resultJson: {
            errorFamily,
            externalLifecycleRecovery: { reviewEvidenceFound: true },
          },
          contextSnapshot: { taskKey: "pr_review:Blockcast/pim-multicast-gateway:1758" },
        }),
      ).toBe(false);

      // Proven-no-review still retries: hoisting the gate must not disable it.
      expect(
        shouldScheduleAutomaticRunRetry({
          errorCode: "external_lifecycle_stale_killed",
          resultJson: {
            errorFamily,
            externalLifecycleRecovery: { reviewEvidenceFound: false },
          },
          contextSnapshot: { taskKey: "pr_review:Blockcast/pim-multicast-gateway:1758" },
        }),
      ).toBe(true);
    }

    // Non-stale-kill runs must keep the transient fast-path untouched.
    expect(
      shouldScheduleAutomaticRunRetry({
        errorCode: "adapter_failed",
        resultJson: { errorFamily: "transient_upstream" },
        contextSnapshot: { issueId: randomUUID(), wakeReason: "issue_assigned" },
      }),
    ).toBe(true);
  });

  // BLO-18030 review (Important): the stale-kill probe must require the wake's
  // EXACT head. githubHasReviewerEvidenceForPr keys its comment-mode pass on a
  // head prefix and falls back to fetching the PR's current head when the wake
  // carried none; if that fetch fails there is no prefix, the comment-mode pass
  // is skipped, and the probe can answer `{found: false}` while a comment-mode
  // review exists. Everywhere else that false negative is merely additive —
  // here it authorizes a retry, i.e. a double review. An unresolved head must
  // therefore read as unproven (null), never false.
  //
  // Each case below returns before any network call, so this pins the guard
  // itself rather than GitHub behaviour.
  it("BLO-18030: the stale-kill probe reports an unresolved head as unproven, never as no-review", async () => {
    // pr_review context, resolvable repo + PR, but the wake carried no head SHA.
    await expect(
      probeStaleKillReviewEvidence({
        contextSnapshot: {
          reviewKind: "pr_review",
          githubRepoFullName: "Blockcast/pim-multicast-gateway",
          githubPrNumber: 1758,
        },
      }),
    ).resolves.toBeNull();

    // Present-but-blank head SHA must not be treated as resolved.
    await expect(
      probeStaleKillReviewEvidence({
        contextSnapshot: {
          reviewKind: "pr_review",
          githubRepoFullName: "Blockcast/pim-multicast-gateway",
          githubPrNumber: 1758,
          githubHeadSha: "   ",
        },
      }),
    ).resolves.toBeNull();

    // No repo => nothing to probe against.
    await expect(
      probeStaleKillReviewEvidence({
        contextSnapshot: {
          reviewKind: "pr_review",
          githubPrNumber: 1758,
          githubHeadSha: "448bff43a1b2c3d4e5f60718293a4b5c6d7e8f90",
        },
      }),
    ).resolves.toBeNull();

    // Not a PR-review wake at all.
    await expect(
      probeStaleKillReviewEvidence({
        contextSnapshot: { wakeReason: "issue_assigned", issueId: randomUUID() },
      }),
    ).resolves.toBeNull();

    // Malformed snapshot must not throw.
    await expect(probeStaleKillReviewEvidence({ contextSnapshot: null })).resolves.toBeNull();
  });

  it("does not retry plain adapter failures when the wake is not an idempotent PR review", () => {
    expect(
      shouldScheduleAutomaticRunRetry({
        errorCode: "adapter_failed",
        resultJson: {},
        contextSnapshot: {
          issueId: randomUUID(),
          wakeReason: "issue_assigned",
        },
      }),
    ).toBe(false);

    expect(
      shouldScheduleAutomaticRunRetry({
        errorCode: "process_lost",
        resultJson: {},
        contextSnapshot: {
          issueId: randomUUID(),
          wakeReason: "issue_assigned",
        },
      }),
    ).toBe(false);
  });

  it("retries session-unavailable failures independent of the heartbeat interval", () => {
    expect(
      shouldScheduleAutomaticRunRetry({
        errorCode: "session_unavailable",
        resultJson: {},
        contextSnapshot: { issueId: randomUUID(), wakeReason: "issue_assigned" },
      }),
    ).toBe(true);
    expect(SESSION_UNAVAILABLE_HEARTBEAT_RETRY_DELAY_MS).toBeLessThanOrEqual(2 * 60 * 1000);
    expect(SESSION_UNAVAILABLE_HEARTBEAT_RETRY_MAX_ATTEMPTS).toBe(2);
  });

  it("preserves the zero-token reset marker on a session-unavailable retry", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const issueId = randomUUID();
    const now = new Date();
    await seedQueuedRunFixture({
      companyId,
      agentId,
      runId,
      now,
      contextSnapshot: {
        issueId,
        wakeReason: "issue_zero_token_session_reset",
        retryReason: "zero_token_session_reset",
      },
    });
    mockAdapterExecute.mockResolvedValueOnce({
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: "Session unavailable",
      errorCode: "session_unavailable",
      summary: "failed",
      resultJson: {},
      provider: "test",
      model: "test-model",
    });

    await heartbeat.__test_executeRunForTesting(runId);

    const failedRun = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    const retryRun = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.retryOfRunId, runId))
      .then((rows) => rows[0] ?? null);
    expect(retryRun?.scheduledRetryReason).toBe("zero_token_session_reset");
    expect(retryRun?.contextSnapshot).toMatchObject({
      retryReason: "zero_token_session_reset",
      wakeReason: "session_unavailable_retry",
      scheduledRetryAttempt: 1,
    });
    expect(failedRun?.contextSnapshot).toMatchObject({ adapterType: "codex_local" });
  });

  it("keeps session reset retries separate from ordinary retries with the same parent and attempt", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const rootRunId = randomUUID();
    const activeRunId = randomUUID();
    const issueId = randomUUID();
    const now = new Date();
    await seedQueuedRunFixture({
      companyId,
      agentId,
      runId: activeRunId,
      now,
      contextSnapshot: {
        issueId,
        taskKey: issueId,
        wakeReason: "session_unavailable_retry",
        retryReason: "session_unavailable",
      },
    });
    await db.insert(heartbeatRuns).values({
      id: rootRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "failed",
      errorCode: "session_unavailable",
      error: "Session unavailable",
      finishedAt: new Date(now.getTime() - 1_000),
      contextSnapshot: { issueId, taskKey: issueId },
      createdAt: new Date(now.getTime() - 1_000),
      updatedAt: new Date(now.getTime() - 1_000),
    });
    await db
      .update(heartbeatRuns)
      .set({
        status: "running",
        startedAt: now,
        retryOfRunId: rootRunId,
        scheduledRetryAttempt: 1,
        scheduledRetryReason: "session_unavailable",
      })
      .where(eq(heartbeatRuns.id, activeRunId));
    runningProcesses.set(activeRunId, {
      child: {} as never,
      graceSec: 0,
      processGroupId: null,
    });

    try {
      await heartbeat.wakeup(agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_zero_token_session_reset",
        payload: { issueId },
        contextSnapshot: {
          issueId,
          taskKey: issueId,
          retryOfRunId: rootRunId,
          retryReason: "zero_token_session_reset",
          scheduledRetryAttempt: 1,
        },
        retryOfRunId: rootRunId,
        scheduledRetryAttempt: 1,
      });

      const wakeRows = await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.agentId, agentId));
      expect(wakeRows.some((row) => row.reason === "retry_execution_duplicate")).toBe(false);
      const deferredReset = wakeRows.find((row) => row.status === "deferred_issue_execution");
      expect(deferredReset).not.toBeNull();
      const deferredContext = (
        deferredReset?.payload as {
          _paperclipWakeContext?: { retryReason?: string };
        } | null
      )?._paperclipWakeContext;
      expect(deferredContext?.retryReason).toBe("zero_token_session_reset");
    } finally {
      runningProcesses.delete(activeRunId);
    }
  });

  it("partitions deferred retries by family while coalescing exact duplicates", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const rootRunId = randomUUID();
    const activeRunId = randomUUID();
    const issueId = randomUUID();
    const now = new Date();
    await seedQueuedRunFixture({
      companyId,
      agentId,
      runId: activeRunId,
      now,
      contextSnapshot: { issueId, taskKey: issueId, wakeReason: "issue_assigned" },
    });
    await db.insert(heartbeatRuns).values({
      id: rootRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "failed",
      errorCode: "session_unavailable",
      error: "Session unavailable",
      finishedAt: new Date(now.getTime() - 1_000),
      contextSnapshot: { issueId, taskKey: issueId },
      createdAt: new Date(now.getTime() - 1_000),
      updatedAt: new Date(now.getTime() - 1_000),
    });
    await db
      .update(heartbeatRuns)
      .set({ status: "running", startedAt: now })
      .where(eq(heartbeatRuns.id, activeRunId));
    runningProcesses.set(activeRunId, {
      child: {} as never,
      graceSec: 0,
      processGroupId: null,
    });

    const enqueueRetry = (retryReason: "session_unavailable" | "zero_token_session_reset") =>
      heartbeat.wakeup(agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: `${retryReason}_retry`,
        payload: { issueId },
        contextSnapshot: {
          issueId,
          taskKey: issueId,
          retryOfRunId: rootRunId,
          retryReason,
          scheduledRetryAttempt: 1,
        },
        retryOfRunId: rootRunId,
        scheduledRetryAttempt: 1,
      });

    try {
      await enqueueRetry("session_unavailable");
      await enqueueRetry("session_unavailable");
      await enqueueRetry("zero_token_session_reset");

      const deferredRows = await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.status, "deferred_issue_execution"));
      expect(deferredRows).toHaveLength(2);
      const deferredByReason = new Map(
        deferredRows.map((row) => {
          const context = (
            row.payload as {
              _paperclipWakeContext?: { retryReason?: string };
            } | null
          )?._paperclipWakeContext;
          return [context?.retryReason, row] as const;
        }),
      );
      expect(deferredByReason.get("session_unavailable")?.coalescedCount).toBe(1);
      expect(deferredByReason.get("zero_token_session_reset")?.coalescedCount).toBe(0);
    } finally {
      runningProcesses.delete(activeRunId);
    }
  });

  it("does not queue generic recovery after the final session-unavailable attempt fails", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const issueId = randomUUID();
    const now = new Date();
    await seedQueuedRunFixture({
      companyId,
      agentId,
      runId,
      now,
      contextSnapshot: {
        issueId,
        taskKey: issueId,
        wakeReason: "session_unavailable_retry",
        retryReason: "session_unavailable",
      },
    });
    await db
      .update(heartbeatRuns)
      .set({ scheduledRetryAttempt: 2, scheduledRetryReason: "session_unavailable" })
      .where(eq(heartbeatRuns.id, runId));
    mockAdapterExecute.mockResolvedValueOnce({
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: "Session unavailable",
      errorCode: "session_unavailable",
      summary: "failed",
      resultJson: {},
      provider: "test",
      model: "test-model",
    });

    await heartbeat.__test_executeRunForTesting(runId);

    const followupRuns = await db
      .select()
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, companyId), sql`${heartbeatRuns.id} <> ${runId}`));
    expect(followupRuns).toHaveLength(0);
    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]);
    expect(issue?.executionRunId).toBeNull();
  });

  it("keeps a deferred comment wake separate when a stale session reset is cancelled", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const rootRunId = randomUUID();
    const activeRunId = randomUUID();
    const issueId = randomUUID();
    const commentId = randomUUID();
    const now = new Date();
    await seedQueuedRunFixture({
      companyId,
      agentId,
      runId: activeRunId,
      now,
      contextSnapshot: { issueId, taskKey: issueId, wakeReason: "issue_assigned" },
    });
    await db.insert(heartbeatRuns).values({
      id: rootRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "failed",
      errorCode: "session_unavailable",
      error: "Session unavailable",
      finishedAt: new Date(now.getTime() - 1_000),
      contextSnapshot: { issueId, taskKey: issueId },
      createdAt: new Date(now.getTime() - 1_000),
      updatedAt: new Date(now.getTime() - 1_000),
    });
    await db.insert(issueComments).values({
      id: commentId,
      companyId,
      issueId,
      body: "Please continue with the new information.",
    });
    await db
      .update(heartbeatRuns)
      .set({ status: "running", startedAt: now })
      .where(eq(heartbeatRuns.id, activeRunId));
    runningProcesses.set(activeRunId, {
      child: {} as never,
      graceSec: 0,
      processGroupId: null,
    });

    try {
      await heartbeat.wakeup(agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_zero_token_session_reset",
        payload: { issueId },
        contextSnapshot: {
          issueId,
          taskKey: issueId,
          retryOfRunId: rootRunId,
          retryReason: "zero_token_session_reset",
          scheduledRetryAttempt: 1,
        },
        retryOfRunId: rootRunId,
        scheduledRetryAttempt: 1,
      });
      await heartbeat.wakeup(agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_commented",
        payload: { issueId, commentId },
        contextSnapshot: { issueId, taskKey: issueId, wakeCommentId: commentId },
      });

      const deferredBeforeRelease = await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.status, "deferred_issue_execution"));
      expect(deferredBeforeRelease).toHaveLength(2);
    } finally {
      runningProcesses.delete(activeRunId);
    }

    await heartbeat.cancelRun(activeRunId, "test release");

    const deferredAfterRelease = await db.select().from(agentWakeupRequests);
    expect(deferredAfterRelease.some((row) => row.error?.includes("superseded"))).toBe(true);
    const promotedCommentRun = await db
      .select()
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, companyId), sql`${heartbeatRuns.id} <> ${activeRunId}`, sql`${heartbeatRuns.id} <> ${rootRunId}`))
      .then((rows) => rows.find((row) => row.contextSnapshot?.wakeCommentId === commentId) ?? null);
    expect(promotedCommentRun).not.toBeNull();
  });

  // BLO-9147 AC1 — thin-snapshot adapter_failed retry gate
  it("BLO-9147 AC1: retries adapter_failed on pr_review run with thin snapshot (no githubPrNumber)", () => {
    // The persisted contextSnapshot only carries reviewKind (no githubPrNumber).
    // derivePaperclipPrReview would return null; isPrReviewRetryContext must match.
    expect(
      shouldScheduleAutomaticRunRetry({
        errorCode: "adapter_failed",
        resultJson: {},
        contextSnapshot: { wakeReason: "github_pr_opened", reviewKind: "pr_review" },
      }),
    ).toBe(true);

    expect(
      shouldScheduleAutomaticRunRetry({
        errorCode: "process_lost",
        resultJson: {},
        contextSnapshot: { reviewKind: "pr_review" },
      }),
    ).toBe(true);

    // taskKey-only snapshot (trimmed to 3 keys, BLO-7457 form)
    expect(
      shouldScheduleAutomaticRunRetry({
        errorCode: "adapter_failed",
        resultJson: {},
        contextSnapshot: { taskKey: "pr_review:blockcast/ally:888" },
      }),
    ).toBe(true);
  });

  it("BLO-9147 AC1: does not retry adapter_failed on non-PR wakes even with thin snapshot", () => {
    expect(
      shouldScheduleAutomaticRunRetry({
        errorCode: "adapter_failed",
        resultJson: {},
        contextSnapshot: { issueId: randomUUID(), wakeReason: "issue_assigned" },
      }),
    ).toBe(false);

    // taskKey that does not start with "pr_review:"
    expect(
      shouldScheduleAutomaticRunRetry({
        errorCode: "adapter_failed",
        resultJson: {},
        contextSnapshot: { taskKey: "issue:somecompany:123" },
      }),
    ).toBe(false);
  });

  // BLO-9147 AC2 — k8s_concurrent_run_blocked retry gate
  it("BLO-9147 AC2: retries k8s_concurrent_run_blocked on pr_review wake", () => {
    expect(
      shouldScheduleAutomaticRunRetry({
        errorCode: "k8s_concurrent_run_blocked",
        resultJson: {},
        contextSnapshot: { wakeReason: "github_pr_opened", reviewKind: "pr_review", githubPrNumber: 42 },
      }),
    ).toBe(true);

    expect(
      shouldScheduleAutomaticRunRetry({
        errorCode: "k8s_concurrent_run_blocked",
        resultJson: {},
        contextSnapshot: { reviewKind: "pr_review" },
      }),
    ).toBe(true);

    expect(
      shouldScheduleAutomaticRunRetry({
        errorCode: "k8s_concurrent_run_blocked",
        resultJson: {},
        contextSnapshot: { taskKey: "pr_review:blockcast/ally:100" },
      }),
    ).toBe(true);
  });

  it("retries k8s_concurrent_run_blocked for issue-backed runs", () => {
    expect(
      shouldScheduleAutomaticRunRetry({
        errorCode: "k8s_concurrent_run_blocked",
        resultJson: {},
        contextSnapshot: { issueId: randomUUID(), wakeReason: "issue_assigned" },
      }),
    ).toBe(true);
  });

  it("does not retry k8s_concurrent_run_blocked without an issue or PR-review context", () => {
    expect(
      shouldScheduleAutomaticRunRetry({
        errorCode: "k8s_concurrent_run_blocked",
        resultJson: {},
        contextSnapshot: {},
      }),
    ).toBe(false);
  });

  it.each(["job_failed", "oom_killed", "exit_137"])(
    "retries %s only when durable evidence proves adapter invocation never began",
    (errorCode) => {
      expect(
        shouldScheduleAutomaticRunRetry({
          errorCode,
          resultJson: { externalLifecycleRecovery: { adapterInvocationStarted: false } },
          contextSnapshot: { issueId: randomUUID(), wakeReason: "issue_assigned" },
        }),
      ).toBe(true);
      expect(
        shouldScheduleAutomaticRunRetry({
          errorCode,
          resultJson: { externalLifecycleRecovery: { adapterInvocationStarted: true } },
          contextSnapshot: { issueId: randomUUID(), wakeReason: "issue_assigned" },
        }),
      ).toBe(false);
      expect(
        shouldScheduleAutomaticRunRetry({
          errorCode,
          resultJson: {},
          contextSnapshot: { issueId: randomUUID(), wakeReason: "issue_assigned" },
        }),
      ).toBe(false);
      expect(
        shouldScheduleAutomaticRunRetry({
          errorCode,
          resultJson: {},
          contextSnapshot: { wakeReason: "heartbeat_timer" },
        }),
      ).toBe(false);
      expect(
        shouldScheduleAutomaticRunRetry({
          errorCode,
          resultJson: {},
          contextSnapshot: null,
        }),
      ).toBe(false);
      expect(JOB_FAILED_HEARTBEAT_RETRY_MAX_ATTEMPTS).toBe(4);
    },
  );

  it("does not retry job_missing even with synthetic never-invoked evidence", () => {
    expect(
      shouldScheduleAutomaticRunRetry({
        errorCode: "job_missing",
        resultJson: { externalLifecycleRecovery: { adapterInvocationStarted: false } },
        contextSnapshot: { issueId: randomUUID(), wakeReason: "issue_assigned" },
      }),
    ).toBe(false);
  });

  it.each(["job_missing", "k8s_pod_schedule_failed"])(
    "does not let stale transient metadata replay %s",
    (errorCode) => {
      expect(
        shouldScheduleAutomaticRunRetry({
          errorCode,
          resultJson: { errorFamily: "transient_upstream" },
          contextSnapshot: { issueId: randomUUID(), wakeReason: "issue_assigned" },
        }),
      ).toBe(false);
    },
  );

  it("BLO-9147 AC2: CAPACITY_BLOCKED_HEARTBEAT_RETRY_MAX_ATTEMPTS exceeds rate-limit cap (12)", () => {
    expect(CAPACITY_BLOCKED_HEARTBEAT_RETRY_MAX_ATTEMPTS).toBeGreaterThan(12);
  });

  it("does not retry ambiguous k8s_pod_schedule_failed outcomes", () => {
    for (const contextSnapshot of [
      { wakeReason: "github_pr_opened", reviewKind: "pr_review", githubPrNumber: 408 },
      { taskKey: "pr_review:blockcast/network-operator-portal:408" },
      { issueId: randomUUID(), wakeReason: "issue_assigned" },
      {},
    ]) {
      expect(
        shouldScheduleAutomaticRunRetry({
          errorCode: "k8s_pod_schedule_failed",
          resultJson: {},
          contextSnapshot,
        }),
      ).toBe(false);
    }
  });

  // BLO-17456: when a PR-review chain exhausts, the reviewer never posts its
  // required status, so the PR sits on "Expected — waiting for status" forever.
  // These drive the real exhaustion path (no mocks): loadConfig() reads
  // process.env at call time, so setting the context here exercises the wiring
  // end to end. The GitHub write itself is now handled by a durable outbox so
  // the heartbeat only needs to prove that the delivery request was persisted.
  describe("exhausted PR-review gate status", () => {
    const GATE_CONTEXT_ENV = "PAPERCLIP_PR_REVIEW_GATE_STATUS_CONTEXT";
    const HEAD_SHA = "45eb633e348a826f43dc68b0c25fe83a96300cea";
    let priorGateContext: string | undefined;

    beforeEach(() => {
      priorGateContext = process.env[GATE_CONTEXT_ENV];
    });

    afterEach(() => {
      if (priorGateContext === undefined) delete process.env[GATE_CONTEXT_ENV];
      else process.env[GATE_CONTEXT_ENV] = priorGateContext;
    });

    async function exhaustPrReviewRun(contextSnapshot: Record<string, unknown>) {
      const runId = randomUUID();
      const now = new Date();
      await seedRetryFixture({
        runId,
        companyId: randomUUID(),
        agentId: randomUUID(),
        now,
        errorCode: "pr_review_output_missing",
        scheduledRetryAttempt: 2,
        contextSnapshot,
      });
      const outcome = await heartbeat.scheduleBoundedRetry(runId, {
        now,
        retryReason: "transient_failure",
        wakeReason: "github_pr_synchronized",
        maxAttempts: 2,
        delayMs: 1_000,
      });
      expect(outcome).toMatchObject({ outcome: "retry_exhausted" });
      const events = await db
        .select({ message: heartbeatRunEvents.message, payload: heartbeatRunEvents.payload })
        .from(heartbeatRunEvents)
        .where(eq(heartbeatRunEvents.runId, runId))
        .orderBy(sql`${heartbeatRunEvents.id} asc`);
      return { events, runId };
    }

    const prReviewSnapshot = {
      wakeReason: "github_pr_synchronized",
      githubPrNumber: 7,
      githubRepoFullName: "Blockcast/hang",
      githubHeadSha: HEAD_SHA,
      githubPrUrl: "https://github.com/Blockcast/hang/pull/7",
    };

    it("queues the gate-status delivery on exhaustion when a context is configured", async () => {
      process.env[GATE_CONTEXT_ENV] = "review/ally-complete";
      const { events, runId } = await exhaustPrReviewRun(prReviewSnapshot);
      const [delivery] = await db
        .select()
        .from(githubCommitStatusDeliveries)
        .where(eq(githubCommitStatusDeliveries.context, "review/ally-complete"));

      expect(events.at(-2)?.message).toContain("Bounded retry exhausted");
      const statusEvent = events.at(-1);
      expect(statusEvent?.message).toContain("Queued PR-review gate status failure delivery for review/ally-complete");
      expect(statusEvent?.payload).toMatchObject({
        deliveryId: delivery?.id,
        deliveryStatus: "queued",
        statusContext: "review/ally-complete",
        repoFullName: "Blockcast/hang",
        prNumber: 7,
        headSha: HEAD_SHA,
      });
      expect(delivery).toMatchObject({
        sourceRunId: runId,
        repoFullName: "Blockcast/hang",
        sha: HEAD_SHA,
        status: "queued",
      });
    });

    it("writes no gate-status event when no context is configured (ships inert)", async () => {
      delete process.env[GATE_CONTEXT_ENV];
      const { events } = await exhaustPrReviewRun(prReviewSnapshot);

      expect(events.at(-1)?.message).toContain("Bounded retry exhausted");
      expect(events.some((e) => e.message.includes("gate status"))).toBe(false);
    });

    it("writes no gate-status event for a non-PR-review run even when configured", async () => {
      process.env[GATE_CONTEXT_ENV] = "review/ally-complete";
      const { events } = await exhaustPrReviewRun({ issueId: randomUUID(), wakeReason: "issue_assigned" });

      expect(events.at(-1)?.message).toContain("Bounded retry exhausted");
      expect(events.some((e) => e.message.includes("gate status"))).toBe(false);
    });

    it("writes no gate-status event when the wake carried no head SHA", async () => {
      process.env[GATE_CONTEXT_ENV] = "review/ally-complete";
      const { events } = await exhaustPrReviewRun({ ...prReviewSnapshot, githubHeadSha: undefined });

      expect(events.at(-1)?.message).toContain("Bounded retry exhausted");
      expect(events.some((e) => e.message.includes("gate status"))).toBe(false);
    });
  });

  it.each([
    {
      errorCode: "k8s_concurrent_run_blocked",
      retryReason: "capacity_blocked",
      wakeReason: "capacity_blocked_retry",
      maxAttempts: CAPACITY_BLOCKED_HEARTBEAT_RETRY_MAX_ATTEMPTS,
    },
    {
      errorCode: "job_failed",
      retryReason: "job_failed",
      wakeReason: "job_failed_retry",
      maxAttempts: JOB_FAILED_HEARTBEAT_RETRY_MAX_ATTEMPTS,
    },
  ] as const)(
    "schedules and finitely exhausts $errorCode issue retries",
    async ({ errorCode, retryReason, wakeReason, maxAttempts }) => {
      const scheduledFixture = await seedMaxTurnFixture();
      await db
        .update(heartbeatRuns)
        .set({ errorCode, resultJson: {} })
        .where(eq(heartbeatRuns.id, scheduledFixture.runId));

      const scheduled = await heartbeat.scheduleBoundedRetry(scheduledFixture.runId, {
        now: scheduledFixture.now,
        retryReason,
        wakeReason,
        maxAttempts,
        delayMs: 1_000,
      });
      expect(scheduled).toMatchObject({ outcome: "scheduled", attempt: 1 });

      const retryRun = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.retryOfRunId, scheduledFixture.runId))
        .then((rows) => rows[0] ?? null);
      expect(retryRun).toMatchObject({
        status: "scheduled_retry",
        scheduledRetryAttempt: 1,
        scheduledRetryReason: retryReason,
      });
      expect(retryRun?.contextSnapshot as Record<string, unknown>).toMatchObject({
        wakeReason,
        retryReason,
      });

      const replacementRunId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: replacementRunId,
        companyId: scheduledFixture.companyId,
        agentId: scheduledFixture.agentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "running",
        contextSnapshot: {
          issueId: scheduledFixture.issueId,
          wakeReason: "issue_continuation_needed",
        },
        startedAt: scheduledFixture.now,
        updatedAt: scheduledFixture.now,
        createdAt: scheduledFixture.now,
      });
      await db
        .update(issues)
        .set({ executionRunId: replacementRunId })
        .where(eq(issues.id, scheduledFixture.issueId));
      const stalePromotion = await heartbeat.promoteDueScheduledRetries(scheduled.dueAt);
      expect(stalePromotion).toEqual({ promoted: 0, runIds: [] });

      const cancelledRetry = await db
        .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, retryRun!.id))
        .then((rows) => rows[0] ?? null);
      expect(cancelledRetry).toEqual({
        status: "cancelled",
        errorCode: "issue_execution_lock_changed",
      });
      const retainedIssueLock = await db
        .select({ executionRunId: issues.executionRunId })
        .from(issues)
        .where(eq(issues.id, scheduledFixture.issueId))
        .then((rows) => rows[0]?.executionRunId ?? null);
      expect(retainedIssueLock).toBe(replacementRunId);

      const exhaustedFixture = await seedMaxTurnFixture({ scheduledRetryAttempt: maxAttempts });
      await db
        .update(heartbeatRuns)
        .set({ errorCode, resultJson: {} })
        .where(eq(heartbeatRuns.id, exhaustedFixture.runId));

      const exhausted = await heartbeat.scheduleBoundedRetry(exhaustedFixture.runId, {
        now: exhaustedFixture.now,
        retryReason,
        wakeReason,
        maxAttempts,
        delayMs: 1_000,
      });
      expect(exhausted).toEqual({
        outcome: "retry_exhausted",
        attempt: maxAttempts + 1,
        maxAttempts,
      });

      const exhaustionEvent = await db
        .select({ message: heartbeatRunEvents.message, payload: heartbeatRunEvents.payload })
        .from(heartbeatRunEvents)
        .where(eq(heartbeatRunEvents.runId, exhaustedFixture.runId))
        .orderBy(sql`${heartbeatRunEvents.id} desc`)
        .then((rows) => rows[0] ?? null);
      expect(exhaustionEvent?.message).toContain("Bounded retry exhausted");
      expect(exhaustionEvent?.payload).toMatchObject({
        retryReason,
        errorCode,
        scheduledRetryAttempt: maxAttempts,
        maxAttempts,
      });

      const terminalFixture = await seedMaxTurnFixture({ issueStatus: "done" });
      const terminal = await heartbeat.scheduleBoundedRetry(terminalFixture.runId, {
        now: terminalFixture.now,
        retryReason,
        wakeReason,
        maxAttempts,
        delayMs: 1_000,
      });
      expect(terminal).toMatchObject({
        outcome: "not_scheduled",
        errorCode: "issue_terminal_status",
        issueId: terminalFixture.issueId,
      });

      const staleLockFixture = await seedMaxTurnFixture();
      await db
        .update(issues)
        .set({ executionRunId: null })
        .where(eq(issues.id, staleLockFixture.issueId));
      const staleLock = await heartbeat.scheduleBoundedRetry(staleLockFixture.runId, {
        now: staleLockFixture.now,
        retryReason,
        wakeReason,
        maxAttempts,
        delayMs: 1_000,
      });
      expect(staleLock).toMatchObject({
        outcome: "scheduled",
      });
      if (staleLock.outcome !== "scheduled") return;
      const staleLockIssue = await db
        .select({ executionRunId: issues.executionRunId })
        .from(issues)
        .where(eq(issues.id, staleLockFixture.issueId))
        .then((rows) => rows[0] ?? null);
      expect(staleLockIssue?.executionRunId).toBeNull();
    },
  );

  it.each(["capacity_blocked", "job_failed"] as const)(
    "suppresses %s retries when the issue entered a waiting posture",
    async (retryReason) => {
      for (const issueStatus of ["backlog", "blocked", "in_review"]) {
        const fixture = await seedMaxTurnFixture({ issueStatus });
        const scheduled = await heartbeat.scheduleBoundedRetry(fixture.runId, {
          now: fixture.now,
          retryReason,
          wakeReason: `${retryReason}_retry`,
          maxAttempts: 4,
          delayMs: 1_000,
        });
        expect(scheduled).toMatchObject({
          outcome: "not_scheduled",
          errorCode: "issue_not_in_progress",
          issueId: fixture.issueId,
        });
      }
    },
  );

  it.each(["session_unavailable", "zero_token_session_reset"] as const)(
    "schedules %s retries for an assigned todo issue while leaving its execution lock free until claim",
    async (retryReason) => {
      const fixture = await seedMaxTurnFixture({ issueStatus: "todo" });
      const scheduled = await heartbeat.scheduleBoundedRetry(fixture.runId, {
        now: fixture.now,
        retryReason,
        wakeReason: `${retryReason}_retry`,
        maxAttempts: 2,
        delayMs: 1_000,
      });

      expect(scheduled.outcome).toBe("scheduled");
      if (scheduled.outcome !== "scheduled") return;
      expect(scheduled.run).toMatchObject({
        status: "scheduled_retry",
        scheduledRetryAttempt: 1,
        scheduledRetryReason: retryReason,
      });
      const issue = await db
        .select({ executionRunId: issues.executionRunId, status: issues.status })
        .from(issues)
        .where(eq(issues.id, fixture.issueId))
        .then((rows) => rows[0] ?? null);
      expect(issue).toEqual({ executionRunId: null, status: "todo" });
    },
  );

  it("rechecks the issue under lock in the same transaction that promotes an infrastructure retry", async () => {
    const fixture = await seedMaxTurnFixture();
    const scheduled = await heartbeat.scheduleBoundedRetry(fixture.runId, {
      now: fixture.now,
      retryReason: "capacity_blocked",
      wakeReason: "capacity_blocked_retry",
      maxAttempts: 4,
      delayMs: 1_000,
    });
    expect(scheduled.outcome).toBe("scheduled");
    if (scheduled.outcome !== "scheduled") return;

    let releaseIssueLock!: () => void;
    let reportIssueLockAcquired!: () => void;
    const issueLockAcquired = new Promise<void>((resolve) => {
      reportIssueLockAcquired = resolve;
    });
    const holdIssueLock = new Promise<void>((resolve) => {
      releaseIssueLock = resolve;
    });
    const statusTransition = db.transaction(async (tx) => {
      await tx
        .select({ id: issues.id })
        .from(issues)
        .where(eq(issues.id, fixture.issueId))
        .for("update");
      reportIssueLockAcquired();
      await holdIssueLock;
      await tx.update(issues).set({ status: "blocked" }).where(eq(issues.id, fixture.issueId));
    });

    await issueLockAcquired;
    const promotion = heartbeat.promoteDueScheduledRetries(scheduled.dueAt);
    await new Promise((resolve) => setTimeout(resolve, 50));
    releaseIssueLock();
    await statusTransition;

    await expect(promotion).resolves.toEqual({ promoted: 0, runIds: [] });
    const retry = await db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, scheduled.run.id))
      .then((rows) => rows[0] ?? null);
    expect(retry).toEqual({ status: "cancelled", errorCode: "issue_not_in_progress" });
  });

  it("does not queue max-turn continuations after the configured cap", async () => {
    const { runId, now } = await seedMaxTurnFixture({ scheduledRetryAttempt: 2 });

    const exhausted = await heartbeat.scheduleBoundedRetry(runId, {
      now,
      retryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
      wakeReason: MAX_TURN_CONTINUATION_WAKE_REASON,
      maxAttempts: 2,
      delayMs: 1_000,
    });

    expect(exhausted).toEqual({
      outcome: "retry_exhausted",
      attempt: 3,
      maxAttempts: 2,
    });

    const runCount = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(heartbeatRuns)
      .then((rows) => rows[0]?.count ?? 0);
    expect(runCount).toBe(1);

    const exhaustionEvent = await db
      .select({ message: heartbeatRunEvents.message, payload: heartbeatRunEvents.payload })
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, runId))
      .orderBy(sql`${heartbeatRunEvents.id} desc`)
      .then((rows) => rows[0] ?? null);
    expect(exhaustionEvent?.message).toContain("Bounded retry exhausted");
    expect(exhaustionEvent?.payload).toMatchObject({
      retryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
      maxAttempts: 2,
      // BLO-17456 follow-up: the failing errorCode is carried on the exhaustion
      // event so a code-specific failure surfaces its cause directly.
      errorCode: "adapter_failed",
    });
  });

  it("suppresses max-turn continuation scheduling when budget or dependencies block the issue", async () => {
    const budgetBlocked = await seedMaxTurnFixture({ now: new Date("2026-04-20T16:00:00.000Z") });
    await db.insert(budgetPolicies).values({
      companyId: budgetBlocked.companyId,
      scopeType: "agent",
      scopeId: budgetBlocked.agentId,
      windowKind: "monthly",
      metric: "billed_cents",
      amount: 0,
      hardStopEnabled: true,
      isActive: true,
    });
    await db
      .update(agents)
      .set({ status: "paused", pauseReason: "budget" })
      .where(eq(agents.id, budgetBlocked.agentId));

    const budgetResult = await heartbeat.scheduleBoundedRetry(budgetBlocked.runId, {
      now: budgetBlocked.now,
      retryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
      wakeReason: MAX_TURN_CONTINUATION_WAKE_REASON,
      maxAttempts: 2,
      delayMs: 1_000,
    });
    expect(budgetResult).toMatchObject({
      outcome: "not_scheduled",
      errorCode: "budget_blocked",
      issueId: budgetBlocked.issueId,
    });

    await cleanupRetryFixture();

    const dependencyBlocked = await seedMaxTurnFixture({ now: new Date("2026-04-20T17:00:00.000Z") });
    const blockerId = randomUUID();
    await db.insert(issues).values({
      id: blockerId,
      companyId: dependencyBlocked.companyId,
      title: "Blocker",
      status: "todo",
      priority: "medium",
      responsibleUserId: "responsible-user",
      issueNumber: 2,
      identifier: `T${dependencyBlocked.companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}-2`,
    });
    await db.insert(issueRelations).values({
      companyId: dependencyBlocked.companyId,
      issueId: blockerId,
      relatedIssueId: dependencyBlocked.issueId,
      type: "blocks",
    });

    const dependencyResult = await heartbeat.scheduleBoundedRetry(dependencyBlocked.runId, {
      now: dependencyBlocked.now,
      retryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
      wakeReason: MAX_TURN_CONTINUATION_WAKE_REASON,
      maxAttempts: 2,
      delayMs: 1_000,
    });
    expect(dependencyResult).toMatchObject({
      outcome: "not_scheduled",
      errorCode: "issue_dependencies_blocked",
      issueId: dependencyBlocked.issueId,
    });

    const retryRuns = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.retryOfRunId, dependencyBlocked.runId))
      .then((rows) => rows[0]?.count ?? 0);
    expect(retryRuns).toBe(0);
  });

  it("does not defer a new assignee behind the previous assignee's scheduled retry", async () => {
    const companyId = randomUUID();
    const oldAgentId = randomUUID();
    const newAgentId = randomUUID();
    const issueId = randomUUID();
    const sourceRunId = randomUUID();
    const now = new Date("2026-04-20T13:00:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });

    await db.insert(agents).values([
      {
        id: oldAgentId,
        companyId,
        name: "ClaudeCoder",
        role: "engineer",
        status: "active",
        adapterType: "claude_local",
        adapterConfig: {},
        runtimeConfig: {
          heartbeat: {
            wakeOnDemand: true,
            maxConcurrentRuns: 1,
          },
        },
        permissions: {},
      },
      {
        id: newAgentId,
        companyId,
        name: "CodexCoder",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {
          heartbeat: {
            wakeOnDemand: true,
            maxConcurrentRuns: 1,
          },
        },
        permissions: {},
      },
    ]);

    await db.insert(heartbeatRuns).values({
      id: sourceRunId,
      companyId,
      agentId: oldAgentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "failed",
      error: "upstream overload",
      errorCode: "adapter_failed",
      finishedAt: now,
      contextSnapshot: {
        issueId,
        wakeReason: "issue_assigned",
      },
      updatedAt: now,
      createdAt: now,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Retry reassignment",
      status: "todo",
      priority: "medium",
      responsibleUserId: "responsible-user",
      assigneeAgentId: oldAgentId,
      executionRunId: sourceRunId,
      executionAgentNameKey: "claudecoder",
      executionLockedAt: now,
      issueNumber: 1,
      identifier: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}-1`,
    });

    const scheduled = await heartbeat.scheduleBoundedRetry(sourceRunId, {
      now,
      random: () => 0.5,
    });
    expect(scheduled.outcome).toBe("scheduled");
    if (scheduled.outcome !== "scheduled") return;

    await db.update(issues).set({
      assigneeAgentId: newAgentId,
      updatedAt: now,
    }).where(eq(issues.id, issueId));

    // Keep the new agent's queue from auto-claiming/executing during this unit test.
    await db.insert(heartbeatRuns).values(
      Array.from({ length: 5 }, () => ({
        id: randomUUID(),
        companyId,
        agentId: newAgentId,
        invocationSource: "automation",
        triggerDetail: "system",
        status: "running",
        contextSnapshot: {
          wakeReason: "test_busy_slot",
        },
        startedAt: now,
        updatedAt: now,
        createdAt: now,
      })),
    );

    const newAssigneeRun = await heartbeat.wakeup(newAgentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: {
        issueId,
        mutation: "update",
      },
      contextSnapshot: {
        issueId,
        source: "issue.update",
      },
      requestedByActorType: "user",
      requestedByActorId: "local-board",
    });

    expect(newAssigneeRun).not.toBeNull();
    expect(newAssigneeRun?.agentId).toBe(newAgentId);
    expect(newAssigneeRun?.status).toBe("queued");

    const oldRetry = await db
      .select({
        status: heartbeatRuns.status,
        errorCode: heartbeatRuns.errorCode,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, scheduled.run.id))
      .then((rows) => rows[0] ?? null);
    expect(oldRetry).toEqual({
      status: "cancelled",
      errorCode: "issue_reassigned",
    });

    const deferredWakeups = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.status, "deferred_issue_execution"))
      .then((rows) => rows[0]?.count ?? 0);
    expect(deferredWakeups).toBe(0);
  });

  it("does not promote a scheduled retry after issue ownership changes", async () => {
    const companyId = randomUUID();
    const oldAgentId = randomUUID();
    const newAgentId = randomUUID();
    const issueId = randomUUID();
    const sourceRunId = randomUUID();
    const now = new Date("2026-04-20T14:00:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });

    await db.insert(agents).values([
      {
        id: oldAgentId,
        companyId,
        name: "ClaudeCoder",
        role: "engineer",
        status: "active",
        adapterType: "claude_local",
        adapterConfig: {},
        runtimeConfig: {
          heartbeat: {
            wakeOnDemand: true,
            maxConcurrentRuns: 1,
          },
        },
        permissions: {},
      },
      {
        id: newAgentId,
        companyId,
        name: "CodexCoder",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {
          heartbeat: {
            wakeOnDemand: true,
            maxConcurrentRuns: 1,
          },
        },
        permissions: {},
      },
    ]);

    await db.insert(heartbeatRuns).values({
      id: sourceRunId,
      companyId,
      agentId: oldAgentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "failed",
      error: "upstream overload",
      errorCode: "adapter_failed",
      finishedAt: now,
      contextSnapshot: {
        issueId,
        wakeReason: "issue_assigned",
      },
      updatedAt: now,
      createdAt: now,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Retry promotion reassignment",
      status: "todo",
      priority: "medium",
      responsibleUserId: "responsible-user",
      assigneeAgentId: oldAgentId,
      executionRunId: sourceRunId,
      executionAgentNameKey: "claudecoder",
      executionLockedAt: now,
      issueNumber: 1,
      identifier: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}-2`,
    });

    const scheduled = await heartbeat.scheduleBoundedRetry(sourceRunId, {
      now,
      random: () => 0.5,
    });
    expect(scheduled.outcome).toBe("scheduled");
    if (scheduled.outcome !== "scheduled") return;

    await db.update(issues).set({
      assigneeAgentId: newAgentId,
      updatedAt: now,
    }).where(eq(issues.id, issueId));

    const promotion = await heartbeat.promoteDueScheduledRetries(scheduled.dueAt);
    expect(promotion).toEqual({ promoted: 0, runIds: [] });

    const oldRetry = await db
      .select({
        status: heartbeatRuns.status,
        errorCode: heartbeatRuns.errorCode,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, scheduled.run.id))
      .then((rows) => rows[0] ?? null);
    expect(oldRetry).toEqual({
      status: "cancelled",
      errorCode: "issue_reassigned",
    });

    const issue = await db
      .select({ executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.executionRunId).toBeNull();
  });

  it("does not promote a scheduled retry after the issue is handed to a human owner", async () => {
    const companyId = randomUUID();
    const oldAgentId = randomUUID();
    const issueId = randomUUID();
    const sourceRunId = randomUUID();
    const now = new Date("2026-04-20T14:30:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });

    await db.insert(agents).values({
      id: oldAgentId,
      companyId,
      name: "ClaudeCoder",
      role: "engineer",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: sourceRunId,
      companyId,
      agentId: oldAgentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "failed",
      error: "upstream overload",
      errorCode: "adapter_failed",
      finishedAt: now,
      contextSnapshot: {
        issueId,
        wakeReason: "issue_assigned",
      },
      updatedAt: now,
      createdAt: now,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Retry human handoff",
      status: "in_progress",
      priority: "medium",
      responsibleUserId: "responsible-user",
      assigneeAgentId: oldAgentId,
      executionRunId: sourceRunId,
      executionAgentNameKey: "claudecoder",
      executionLockedAt: now,
      issueNumber: 1,
      identifier: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}-3`,
    });

    const scheduled = await heartbeat.scheduleBoundedRetry(sourceRunId, {
      now,
      random: () => 0.5,
    });
    expect(scheduled.outcome).toBe("scheduled");
    if (scheduled.outcome !== "scheduled") return;

    await db.update(issues).set({
      assigneeAgentId: null,
      assigneeUserId: "local-board",
      updatedAt: now,
    }).where(eq(issues.id, issueId));

    const promotion = await heartbeat.promoteDueScheduledRetries(scheduled.dueAt);
    expect(promotion).toEqual({ promoted: 0, runIds: [] });

    const oldRetry = await db
      .select({
        status: heartbeatRuns.status,
        errorCode: heartbeatRuns.errorCode,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, scheduled.run.id))
      .then((rows) => rows[0] ?? null);
    expect(oldRetry).toEqual({
      status: "cancelled",
      errorCode: "issue_reassigned",
    });

    const issue = await db
      .select({
        assigneeAgentId: issues.assigneeAgentId,
        assigneeUserId: issues.assigneeUserId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue).toMatchObject({
      assigneeAgentId: null,
      assigneeUserId: "local-board",
      executionRunId: null,
    });
  });

  it("does not promote a scheduled retry after the issue is cancelled", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const sourceRunId = randomUUID();
    const now = new Date("2026-04-20T15:00:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
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

    await db.insert(heartbeatRuns).values({
      id: sourceRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "failed",
      error: "upstream overload",
      errorCode: "adapter_failed",
      finishedAt: now,
      contextSnapshot: {
        issueId,
        wakeReason: "issue_assigned",
      },
      updatedAt: now,
      createdAt: now,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Retry promotion cancellation",
      status: "todo",
      priority: "medium",
      responsibleUserId: "responsible-user",
      assigneeAgentId: agentId,
      executionRunId: sourceRunId,
      executionAgentNameKey: "codexcoder",
      executionLockedAt: now,
      issueNumber: 1,
      identifier: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}-3`,
    });

    const scheduled = await heartbeat.scheduleBoundedRetry(sourceRunId, {
      now,
      random: () => 0.5,
    });
    expect(scheduled.outcome).toBe("scheduled");
    if (scheduled.outcome !== "scheduled") return;

    await db.update(issues).set({
      status: "cancelled",
      updatedAt: now,
    }).where(eq(issues.id, issueId));

    const promotion = await heartbeat.promoteDueScheduledRetries(scheduled.dueAt);
    expect(promotion).toEqual({ promoted: 0, runIds: [] });

    const oldRetry = await db
      .select({
        status: heartbeatRuns.status,
        errorCode: heartbeatRuns.errorCode,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, scheduled.run.id))
      .then((rows) => rows[0] ?? null);
    expect(oldRetry).toEqual({
      status: "cancelled",
      errorCode: "issue_cancelled",
    });

    const issue = await db
      .select({ executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.executionRunId).toBeNull();
  });

  it("exhausts bounded retries after the hard cap", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const cappedRunId = randomUUID();
    const now = new Date("2026-04-20T18:00:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
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

    await db.insert(heartbeatRuns).values({
      id: cappedRunId,
      companyId,
      agentId,
      invocationSource: "automation",
      status: "failed",
      error: "still transient",
      errorCode: "adapter_failed",
      finishedAt: now,
      scheduledRetryAttempt: BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS.length,
      scheduledRetryReason: "transient_failure",
      contextSnapshot: {
        wakeReason: "transient_failure_retry",
      },
      updatedAt: now,
      createdAt: now,
    });

    const exhausted = await heartbeat.scheduleBoundedRetry(cappedRunId, {
      now,
      random: () => 0.5,
    });

    expect(exhausted).toEqual({
      outcome: "retry_exhausted",
      attempt: BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS.length + 1,
      maxAttempts: BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS.length,
    });

    const runCount = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.companyId, companyId))
      .then((rows) => rows[0]?.count ?? 0);
    expect(runCount).toBe(1);

    const exhaustionEvent = await db
      .select({
        message: heartbeatRunEvents.message,
        payload: heartbeatRunEvents.payload,
      })
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, cappedRunId))
      .orderBy(sql`${heartbeatRunEvents.id} desc`)
      .then((rows) => rows[0] ?? null);

    expect(exhaustionEvent?.message).toContain("Bounded retry exhausted");
    expect(exhaustionEvent?.payload).toMatchObject({
      retryReason: "transient_failure",
      scheduledRetryAttempt: BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS.length,
      maxAttempts: BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS.length,
    });
  });

  it("advances codex transient fallback stages across bounded retry attempts", async () => {
    const fallbackModes = [
      "same_session",
      "safer_invocation",
      "fresh_session",
      "fresh_session_safer_invocation",
    ] as const;

    for (const [index, expectedMode] of fallbackModes.entries()) {
      const companyId = randomUUID();
      const agentId = randomUUID();
      const runId = randomUUID();
      const now = new Date(`2026-04-20T1${index}:00:00.000Z`);

      await seedRetryFixture({
        runId,
        companyId,
        agentId,
        now,
        errorCode: "adapter_failed",
        errorFamily: "transient_upstream",
        scheduledRetryAttempt: index,
      });

      const scheduled = await heartbeat.scheduleBoundedRetry(runId, {
        now,
        random: () => 0.5,
      });

      expect(scheduled.outcome).toBe("scheduled");
      if (scheduled.outcome !== "scheduled") continue;

      const retryRun = await db
        .select({
          contextSnapshot: heartbeatRuns.contextSnapshot,
          wakeupRequestId: heartbeatRuns.wakeupRequestId,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, scheduled.run.id))
        .then((rows) => rows[0] ?? null);
      expect((retryRun?.contextSnapshot as Record<string, unknown> | null)?.codexTransientFallbackMode).toBe(expectedMode);

      const wakeupRequest = await db
        .select({ payload: agentWakeupRequests.payload })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, retryRun?.wakeupRequestId ?? ""))
        .then((rows) => rows[0] ?? null);
      expect((wakeupRequest?.payload as Record<string, unknown> | null)?.codexTransientFallbackMode).toBe(expectedMode);

      await cleanupRetryFixture();
    }
  });

  it("honors codex retry-not-before timestamps when they exceed the default bounded backoff", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const now = new Date(2026, 3, 22, 22, 29, 0);
    const retryNotBefore = new Date(2026, 3, 22, 23, 31, 0);

    await seedRetryFixture({
      runId,
      companyId,
      agentId,
      now,
      errorCode: "adapter_failed",
      errorFamily: "transient_upstream",
      retryNotBefore: retryNotBefore.toISOString(),
    });

    const scheduled = await heartbeat.scheduleBoundedRetry(runId, {
      now,
      random: () => 0.5,
    });

    expect(scheduled.outcome).toBe("scheduled");
    if (scheduled.outcome !== "scheduled") return;
    expect(scheduled.dueAt.getTime()).toBe(retryNotBefore.getTime());

    const retryRun = await db
      .select({
        contextSnapshot: heartbeatRuns.contextSnapshot,
        scheduledRetryAt: heartbeatRuns.scheduledRetryAt,
        wakeupRequestId: heartbeatRuns.wakeupRequestId,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, scheduled.run.id))
      .then((rows) => rows[0] ?? null);

    expect(retryRun?.scheduledRetryAt?.getTime()).toBe(retryNotBefore.getTime());
    expect((retryRun?.contextSnapshot as Record<string, unknown> | null)?.transientRetryNotBefore).toBe(
      retryNotBefore.toISOString(),
    );

    const wakeupRequest = await db
      .select({ payload: agentWakeupRequests.payload })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, retryRun?.wakeupRequestId ?? ""))
      .then((rows) => rows[0] ?? null);

    expect((wakeupRequest?.payload as Record<string, unknown> | null)?.transientRetryNotBefore).toBe(
      retryNotBefore.toISOString(),
    );
  });

  it("schedules bounded retries for claude_transient_upstream and honors its retry-not-before hint", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const now = new Date(2026, 3, 22, 10, 0, 0);
    const retryNotBefore = new Date(2026, 3, 22, 16, 0, 0);

    await seedRetryFixture({
      runId,
      companyId,
      agentId,
      now,
      errorCode: "adapter_failed",
      errorFamily: "transient_upstream",
      adapterType: "claude_local",
      retryNotBefore: retryNotBefore.toISOString(),
    });

    const scheduled = await heartbeat.scheduleBoundedRetry(runId, {
      now,
      random: () => 0.5,
    });

    expect(scheduled.outcome).toBe("scheduled");
    if (scheduled.outcome !== "scheduled") return;
    expect(scheduled.dueAt.getTime()).toBe(retryNotBefore.getTime());

    const retryRun = await db
      .select({
        contextSnapshot: heartbeatRuns.contextSnapshot,
        scheduledRetryAt: heartbeatRuns.scheduledRetryAt,
        wakeupRequestId: heartbeatRuns.wakeupRequestId,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, scheduled.run.id))
      .then((rows) => rows[0] ?? null);

    expect(retryRun?.scheduledRetryAt?.getTime()).toBe(retryNotBefore.getTime());
    const contextSnapshot = (retryRun?.contextSnapshot as Record<string, unknown> | null) ?? {};
    expect(contextSnapshot.transientRetryNotBefore).toBe(retryNotBefore.toISOString());
    // Claude does not participate in the Codex fallback-mode ladder.
    expect(contextSnapshot.codexTransientFallbackMode ?? null).toBeNull();

    const wakeupRequest = await db
      .select({ payload: agentWakeupRequests.payload })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, retryRun?.wakeupRequestId ?? ""))
      .then((rows) => rows[0] ?? null);

    expect((wakeupRequest?.payload as Record<string, unknown> | null)?.transientRetryNotBefore).toBe(
      retryNotBefore.toISOString(),
    );
  });

  // BLO-23525: the prose-parser path (parseProviderCapacityResetHorizon ->
  // resultJson.retryNotBefore -> this scheduler's transientRetryNotBefore
  // override) used to honor an advertised horizon verbatim. It now shares
  // clampTransientRetryHorizon with the capacity-gate path (BLO-23438), with
  // its own attempt ceiling raised so the clamp cannot silently reintroduce
  // BLO-23438's exhaustion trap on this route.
  it("BLO-23525: clamps a transient_upstream retry-not-before beyond the horizon ceiling instead of parking for the full advertised window", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const now = new Date("2026-08-09T00:00:00.000Z");
    // 130h out: beyond both the 24h per-attempt cap and BLO-22844's 124.8h
    // worst case, so a single attempt must not be able to honor it verbatim.
    const advertisedRetryNotBefore = new Date(now.getTime() + 130 * 60 * 60 * 1000);

    await seedRetryFixture({
      runId,
      companyId,
      agentId,
      now,
      errorCode: "adapter_failed",
      errorFamily: "transient_upstream",
      retryNotBefore: advertisedRetryNotBefore.toISOString(),
    });

    const scheduled = await heartbeat.scheduleBoundedRetry(runId, {
      now,
      random: () => 0.5,
    });

    expect(scheduled.outcome).toBe("scheduled");
    if (scheduled.outcome !== "scheduled") return;
    // Clamped to the ceiling, not the (later) advertised horizon.
    expect(scheduled.dueAt.getTime()).toBe(now.getTime() + MAX_TRANSIENT_RETRY_HORIZON_MS);
    expect(scheduled.attempt).toBe(1);
    // The family's ceiling was raised so 24h-per-attempt re-probing has
    // enough attempts left to reach BLO-22844's 124.8h worst case.
    expect(scheduled.maxAttempts).toBe(TRANSIENT_HORIZON_CLAMP_MIN_ATTEMPTS);
    expect(scheduled.maxAttempts).toBeGreaterThan(BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS.length);

    const retryRun = await db
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot, scheduledRetryAt: heartbeatRuns.scheduledRetryAt })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, scheduled.run.id))
      .then((rows) => rows[0] ?? null);

    expect(retryRun?.scheduledRetryAt?.getTime()).toBe(now.getTime() + MAX_TRANSIENT_RETRY_HORIZON_MS);
    const contextSnapshot = (retryRun?.contextSnapshot as Record<string, unknown> | null) ?? {};
    // The clamped instant is what downstream retry logic acts on...
    expect(contextSnapshot.transientRetryNotBefore).toBe(advertisedRetryNotBefore.toISOString());
    // ...but the declined advertised horizon stays legible on the row.
    expect(contextSnapshot.transientRetryHorizonClampedFrom).toBe(advertisedRetryNotBefore.toISOString());
  });

  it("BLO-23525: keeps re-probing a clamped transient_upstream horizon across attempts, and only exhausts past the raised ceiling", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const now = new Date("2026-08-09T00:00:00.000Z");
    const advertisedRetryNotBefore = new Date(now.getTime() + 200 * 60 * 60 * 1000);

    // Seed as the run that just failed on the *last* attempt the raised
    // ceiling allows, still carrying the same far-future advertised horizon
    // (the provider outage has not resolved).
    await seedRetryFixture({
      runId,
      companyId,
      agentId,
      now,
      errorCode: "adapter_failed",
      errorFamily: "transient_upstream",
      retryNotBefore: advertisedRetryNotBefore.toISOString(),
      scheduledRetryAttempt: TRANSIENT_HORIZON_CLAMP_MIN_ATTEMPTS - 1,
    });

    const lastAllowedAttempt = await heartbeat.scheduleBoundedRetry(runId, {
      now,
      random: () => 0.5,
    });

    expect(lastAllowedAttempt.outcome).toBe("scheduled");
    if (lastAllowedAttempt.outcome !== "scheduled") return;
    expect(lastAllowedAttempt.attempt).toBe(TRANSIENT_HORIZON_CLAMP_MIN_ATTEMPTS);
    expect(lastAllowedAttempt.dueAt.getTime()).toBe(now.getTime() + MAX_TRANSIENT_RETRY_HORIZON_MS);

    await cleanupRetryFixture();

    // One attempt further — still the same unresolved outage — must exhaust
    // rather than clamp-and-park again indefinitely.
    const exhaustedRunId = randomUUID();
    await seedRetryFixture({
      runId: exhaustedRunId,
      companyId: randomUUID(),
      agentId: randomUUID(),
      now,
      errorCode: "adapter_failed",
      errorFamily: "transient_upstream",
      retryNotBefore: advertisedRetryNotBefore.toISOString(),
      scheduledRetryAttempt: TRANSIENT_HORIZON_CLAMP_MIN_ATTEMPTS,
    });

    const exhausted = await heartbeat.scheduleBoundedRetry(exhaustedRunId, {
      now,
      random: () => 0.5,
    });

    expect(exhausted).toEqual({
      outcome: "retry_exhausted",
      attempt: TRANSIENT_HORIZON_CLAMP_MIN_ATTEMPTS + 1,
      maxAttempts: TRANSIENT_HORIZON_CLAMP_MIN_ATTEMPTS,
    });
  });

  it("BLO-23525: leaves the ordinary hintless transient_upstream ceiling (no retry-not-before) untouched at 4 attempts", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const now = new Date("2026-08-09T00:00:00.000Z");

    await seedRetryFixture({
      runId,
      companyId,
      agentId,
      now,
      errorCode: "adapter_failed",
      errorFamily: "transient_upstream",
      scheduledRetryAttempt: BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS.length - 1,
    });

    const lastHintlessAttempt = await heartbeat.scheduleBoundedRetry(runId, {
      now,
      random: () => 0.5,
    });

    expect(lastHintlessAttempt.outcome).toBe("scheduled");
    if (lastHintlessAttempt.outcome !== "scheduled") return;
    expect(lastHintlessAttempt.maxAttempts).toBe(BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS.length);
  });
});
