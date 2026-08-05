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
  issueRelations,
  issues,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { cleanupHeartbeatTestState } from "./helpers/cleanup-heartbeat-test-state.js";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.ts";
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
  shouldScheduleAutomaticRunRetry,
} from "../services/heartbeat.js";

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
      type === "provider_quota_test"
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
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, scheduled.run.id))
      .then((rows) => rows[0] ?? null);
    expect(promotedRun?.status).toBe("queued");
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
          taskKey: "pr_review:Blockcast/paperclip:976",
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
    expect(issue?.executionRunId).toBe(scheduled.run.id);
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
      executionRunId: scheduled.run.id,
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
      executionRunId: scheduled.run.id,
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
      executionRunId: scheduled.run.id,
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
        contextSnapshot: { taskKey: "pr_review:Blockcast/pim-multicast-gateway:1656" },
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
        contextSnapshot: { taskKey: "pr_review:Blockcast/onprem-k8s:1817" },
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
        contextSnapshot: { taskKey: "pr_review:Blockcast/ally:888" },
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
        contextSnapshot: { taskKey: "pr_review:Blockcast/ally:100" },
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

  it("retries job_failed only when durable evidence proves adapter invocation never began", () => {
    expect(
      shouldScheduleAutomaticRunRetry({
        errorCode: "job_failed",
        resultJson: { externalLifecycleRecovery: { adapterInvocationStarted: false } },
        contextSnapshot: { issueId: randomUUID(), wakeReason: "issue_assigned" },
      }),
    ).toBe(true);
    expect(
      shouldScheduleAutomaticRunRetry({
        errorCode: "job_failed",
        resultJson: { externalLifecycleRecovery: { adapterInvocationStarted: true } },
        contextSnapshot: { issueId: randomUUID(), wakeReason: "issue_assigned" },
      }),
    ).toBe(false);
    expect(
      shouldScheduleAutomaticRunRetry({
        errorCode: "job_failed",
        resultJson: {},
        contextSnapshot: { issueId: randomUUID(), wakeReason: "issue_assigned" },
      }),
    ).toBe(false);
    expect(
      shouldScheduleAutomaticRunRetry({
        errorCode: "job_failed",
        resultJson: {},
        contextSnapshot: { wakeReason: "heartbeat_timer" },
      }),
    ).toBe(false);
    expect(
      shouldScheduleAutomaticRunRetry({
        errorCode: "job_failed",
        resultJson: {},
        contextSnapshot: null,
      }),
    ).toBe(false);
    expect(JOB_FAILED_HEARTBEAT_RETRY_MAX_ATTEMPTS).toBe(4);
  });

  it("BLO-9147 AC2: CAPACITY_BLOCKED_HEARTBEAT_RETRY_MAX_ATTEMPTS exceeds rate-limit cap (12)", () => {
    expect(CAPACITY_BLOCKED_HEARTBEAT_RETRY_MAX_ATTEMPTS).toBeGreaterThan(12);
  });

  // BLO-10448 — scheduler-level transient infra failures retry gate
  it.each(["k8s_pod_schedule_failed", "job_missing"])(
    "BLO-10448: retries %s on a pr_review wake (work never ran)",
    (errorCode) => {
      expect(
        shouldScheduleAutomaticRunRetry({
          errorCode,
          resultJson: {},
          contextSnapshot: { wakeReason: "github_pr_opened", reviewKind: "pr_review", githubPrNumber: 408 },
        }),
      ).toBe(true);
      // thin snapshot (taskKey-only) — webhook-driven reviewer wakes get trimmed
      expect(
        shouldScheduleAutomaticRunRetry({
          errorCode,
          resultJson: {},
          contextSnapshot: { taskKey: "pr_review:Blockcast/Network-Operator-Portal:408" },
        }),
      ).toBe(true);
    },
  );

  it.each(["k8s_pod_schedule_failed", "job_missing"])(
    "BLO-10448: does NOT retry %s on non-PR wakes (BLO-7913 leak guard)",
    (errorCode) => {
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
          contextSnapshot: {},
        }),
      ).toBe(false);
    },
  );

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
        outcome: "not_scheduled",
        errorCode: "issue_execution_lock_changed",
        issueId: staleLockFixture.issueId,
      });
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
});
