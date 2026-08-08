/**
 * BLO-12990: high-priority `todo` starved behind low-priority `in_progress`.
 *
 * Covers two independent fixes:
 *
 * Fix #3 (priority sort): verifies that startNextQueuedRunForAgent selects a
 * high-priority `todo` run ahead of a low-priority `in_progress` run when a
 * slot opens. The old sort made status the primary key (in_progress always won
 * regardless of priority gap); the new sort uses priority * 2 + statusBonus so
 * priority can cross the status boundary.
 *
 * Fix #1 (stale-run exclusion): verifies that a stale/silent running run does
 * not hold a dispatch slot hostage. A run is stale when its newest valid activity
 * stamp is older than
 * EXTERNAL_LIFECYCLE_STALE_MS (15 min). Before the fix, stale runs counted as
 * "running" and blocked all dispatch for external-lifecycle agents via the hard
 * early-return gate — even when the k8s Job was already gone.
 *
 * BLO-16554: extends the escalation-floor coverage below to the
 * effectiveMaxConcurrentRuns = 1 external-lifecycle case (BLO-15959
 * concurrencyEnabled default-off) -- a long-starved queued run must advance
 * as soon as critical work releases the agent's single slot, not just dispatch
 * because it was the only candidate in the queue.
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  externalRuntimeReservations,
  heartbeatRuns,
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { cleanupHeartbeatTestState } from "./helpers/cleanup-heartbeat-test-state.js";
import { heartbeatService } from "../services/heartbeat.js";
import { _settleDetachedAgentStartLockWorkForTesting } from "../services/agent-start-lock.js";
import { runningProcesses } from "../adapters/index.js";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null as string | null,
    timedOut: false,
    errorMessage: null as string | null,
    resultJson: { exitCode: 0 },
    provider: "test",
    model: "test-model",
  })),
);

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

vi.mock("../services/k8s-job-liveness.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/k8s-job-liveness.ts")>();
  return {
    ...actual,
    listLiveAgentJobRunIds: vi.fn(async () => null),
    listAgentJobRunStatuses: vi.fn(async () => null),
    listManagedAgentJobs: vi.fn(async () => null),
    readAgentJobRunStatusByName: vi.fn(async () => null),
    deleteAgentJobsForRun: vi.fn(async () => 1),
    deleteAgentJobExact: vi.fn(async () => "deleted" as const),
    hasActiveJobForAgent: vi.fn(async () => false),
  };
});

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => ({ track: vi.fn() }),
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return { ...actual, trackAgentFirstHeartbeat: vi.fn() };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping dispatch-priority-sort tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
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

describeEmbeddedPostgres("heartbeat dispatch priority sort (BLO-12990)", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  const allowPenstockGate = {
    checkAdapter: async () => ({ allow: true as const }),
    _resetForTesting: () => {},
  };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-dispatch-priority-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db, { penstockGate: allowPenstockGate });
  });

  afterEach(async () => {
    vi.clearAllMocks();
    runningProcesses.clear();
    await cleanupHeartbeatTestState(db, heartbeat);
  });

  afterAll(async () => {
    runningProcesses.clear();
    await tempDb?.cleanup();
  });

  it("dispatches high-priority todo ahead of low-priority in_progress (BLO-12990 regression)", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const inProgressIssueId = randomUUID();
    const todoIssueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "TestCo",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "TestAgent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });

    // Issue A: in_progress, low priority — should LOSE under the new sort
    await db.insert(issues).values([
      {
        id: inProgressIssueId,
        companyId,
        title: "Low priority in-progress work",
        status: "in_progress",
        priority: "low",
        assigneeAgentId: agentId,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
        startedAt: new Date(),
      },
      // Issue B: todo, high priority — should WIN under the new sort
      {
        id: todoIssueId,
        companyId,
        title: "High priority new work",
        status: "todo",
        priority: "high",
        assigneeAgentId: agentId,
        issueNumber: 2,
        identifier: `${issuePrefix}-2`,
      },
    ]);

    // Insert two queued runs. The in_progress run is OLDER (createdAt) so it
    // would win the old sort's createdAt-ASC tie-break within its status rank.
    // With the new priority-first sort the todo/high run should still win.
    // Both timestamps are recent (well under the BLO-16253 starvation-aging
    // thresholds) so this test isolates priority ordering — see the
    // dedicated BLO-16253 test below for the aging behavior itself.
    const olderTime = new Date(Date.now() - 2 * 60 * 1000);
    const newerTime = new Date(Date.now() - 60 * 1000);

    const inProgressWakeId = randomUUID();
    const inProgressRunId = randomUUID();
    const todoWakeId = randomUUID();
    const todoRunId = randomUUID();

    await db.insert(agentWakeupRequests).values([
      {
        id: inProgressWakeId,
        companyId,
        agentId,
        source: "heartbeat",
        triggerDetail: "timer",
        reason: "heartbeat_timer",
        payload: { issueId: inProgressIssueId },
        status: "queued",
        runId: inProgressRunId,
        requestedAt: olderTime,
        updatedAt: olderTime,
      },
      {
        id: todoWakeId,
        companyId,
        agentId,
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: { issueId: todoIssueId },
        status: "queued",
        runId: todoRunId,
        requestedAt: newerTime,
        updatedAt: newerTime,
      },
    ]);

    await db.insert(heartbeatRuns).values([
      {
        id: inProgressRunId,
        companyId,
        agentId,
        invocationSource: "heartbeat",
        triggerDetail: "timer",
        status: "queued",
        wakeupRequestId: inProgressWakeId,
        contextSnapshot: { issueId: inProgressIssueId, wakeReason: "heartbeat_timer" },
        createdAt: olderTime,
        updatedAt: olderTime,
      },
      {
        id: todoRunId,
        companyId,
        agentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "queued",
        wakeupRequestId: todoWakeId,
        contextSnapshot: { issueId: todoIssueId, wakeReason: "issue_assigned" },
        createdAt: newerTime,
        updatedAt: newerTime,
      },
    ]);

    // Track which runIds are dispatched and in what order.
    // The "issue_assigned" wakeReason triggers a missing-comment-retry cascade
    // after todoRun completes, so there will be more than 1 execute call total.
    // The regression guard is ORDER: high-priority todo must be first.
    const dispatchedRunIds: string[] = [];
    mockAdapterExecute.mockImplementation(async (args: { runId: string }) => {
      dispatchedRunIds.push(args.runId);
      return {
        exitCode: 0,
        signal: null as string | null,
        timedOut: false,
        errorMessage: null as string | null,
        resultJson: { exitCode: 0 },
        provider: "test",
        model: "test-model",
      };
    });

    // Dispatch: only 1 slot available (maxConcurrentRuns: 1, 0 running).
    await heartbeat.resumeQueuedRuns();

    // Wait for the todo run to settle and drain all cascaded follow-up dispatches.
    await waitForRunToSettle(heartbeat, todoRunId);

    // REGRESSION GUARD: the high-priority todo run must be the FIRST dispatch.
    // The old sort always picked in_progress ahead regardless of priority gap.
    expect(dispatchedRunIds[0]).toBe(todoRunId);

    // The low-priority in_progress run must have been dispatched AFTER the todo run.
    const inProgressDispatchIdx = dispatchedRunIds.indexOf(inProgressRunId);
    expect(inProgressDispatchIdx).toBeGreaterThan(0);

    const todoRun = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, todoRunId))
      .then((rows) => rows[0] ?? null);

    // todo/high should have been dispatched (left the queued state).
    expect(todoRun?.status).not.toBe("queued");
  });

  it("dispatches queued run despite a stale silent running run (BLO-12990 Fix #1)", async () => {
    // A running run that has been silent for > EXTERNAL_LIFECYCLE_STALE_MS (15 min)
    // must NOT consume a concurrency slot. With maxConcurrentRuns: 2 and 2 stale
    // "running" runs in the DB, the old code saw runningCount = 2 = maxConcurrentRuns
    // and returned availableSlots = 0 (no dispatch). Fix #1 excludes stale runs from
    // the count so nonStaleRunningRuns = 0, runningCount = 0, availableSlots = 2, and
    // the queued run dispatches.
    //
    // codex_local is intentionally used here: for non-external-lifecycle adapters
    // reapOrphanedRuns is NOT called inside startNextQueuedRunForAgent, so the stale
    // runs remain "running" in the DB untouched during the dispatch cycle, isolating
    // the stale-exclusion logic cleanly without reaper interference.
    const companyId = randomUUID();
    const agentId = randomUUID();
    const staleIssueId1 = randomUUID();
    const staleIssueId2 = randomUUID();
    const todoIssueId = randomUUID();
    const issuePrefix = `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "StaleTestCo",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "StaleTestAgent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 2 } },
      permissions: {},
    });

    await db.insert(issues).values([
      {
        id: staleIssueId1,
        companyId,
        title: "Stale in-flight issue 1",
        status: "in_progress",
        priority: "low",
        assigneeAgentId: agentId,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
        startedAt: new Date(),
      },
      {
        id: staleIssueId2,
        companyId,
        title: "Stale in-flight issue 2",
        status: "in_progress",
        priority: "low",
        assigneeAgentId: agentId,
        issueNumber: 2,
        identifier: `${issuePrefix}-2`,
        startedAt: new Date(),
      },
      {
        id: todoIssueId,
        companyId,
        title: "New high-priority work",
        status: "todo",
        priority: "high",
        assigneeAgentId: agentId,
        issueNumber: 3,
        identifier: `${issuePrefix}-3`,
      },
    ]);

    // Two stale running runs: lastOutputAt = 20 minutes ago (> EXTERNAL_LIFECYCLE_STALE_MS = 15 min).
    // These fill maxConcurrentRuns: 2 under the old code, leaving availableSlots = 0.
    const staleOutputAt = new Date(Date.now() - 20 * 60 * 1000);
    await db.insert(heartbeatRuns).values([
      {
        id: randomUUID(),
        companyId,
        agentId,
        invocationSource: "heartbeat",
        triggerDetail: "timer",
        status: "running",
        contextSnapshot: { issueId: staleIssueId1, wakeReason: "heartbeat_timer" },
        startedAt: staleOutputAt,
        lastOutputAt: staleOutputAt,
        createdAt: staleOutputAt,
        updatedAt: staleOutputAt,
      },
      {
        id: randomUUID(),
        companyId,
        agentId,
        invocationSource: "heartbeat",
        triggerDetail: "timer",
        status: "running",
        contextSnapshot: { issueId: staleIssueId2, wakeReason: "heartbeat_timer" },
        startedAt: staleOutputAt,
        lastOutputAt: staleOutputAt,
        createdAt: staleOutputAt,
        updatedAt: staleOutputAt,
      },
    ]);

    // The queued high-priority run.
    const todoWakeId = randomUUID();
    const todoRunId = randomUUID();
    const queuedTime = new Date();
    await db.insert(agentWakeupRequests).values({
      id: todoWakeId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId: todoIssueId },
      status: "queued",
      runId: todoRunId,
      requestedAt: queuedTime,
      updatedAt: queuedTime,
    });
    await db.insert(heartbeatRuns).values({
      id: todoRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId: todoWakeId,
      contextSnapshot: { issueId: todoIssueId, wakeReason: "issue_assigned" },
      createdAt: queuedTime,
      updatedAt: queuedTime,
    });

    const dispatchedRunIds: string[] = [];
    mockAdapterExecute.mockImplementation(async (args: { runId: string }) => {
      dispatchedRunIds.push(args.runId);
      return {
        exitCode: 0,
        signal: null as string | null,
        timedOut: false,
        errorMessage: null as string | null,
        resultJson: { exitCode: 0 },
        provider: "test",
        model: "test-model",
      };
    });

    await heartbeat.resumeQueuedRuns();
    await waitForRunToSettle(heartbeat, todoRunId);

    // REGRESSION GUARD (Fix #1): the stale running runs must NOT block dispatch.
    // The todo/high-priority run must have been dispatched despite filling both slots.
    expect(dispatchedRunIds[0]).toBe(todoRunId);

    // The todo run should have left the queued state.
    const todoRun = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, todoRunId))
      .then((rows) => rows[0] ?? null);
    expect(todoRun?.status).not.toBe("queued");
  });

  it("keeps a slot occupied when output is newer than stale useful activity (BLO-20775)", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runningIssueId = randomUUID();
    const queuedIssueId = randomUUID();
    const issuePrefix = `N${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const stale = new Date(Date.now() - 20 * 60 * 1000);
    const recentOutput = new Date(Date.now() - 60 * 1000);

    await db.insert(companies).values({
      id: companyId,
      name: "NewestActivityCo",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "NewestActivityAgent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    await db.insert(issues).values([
      {
        id: runningIssueId,
        companyId,
        title: "In-flight work with recent output",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: agentId,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
        startedAt: stale,
      },
      {
        id: queuedIssueId,
        companyId,
        title: "Queued work",
        status: "todo",
        priority: "high",
        assigneeAgentId: agentId,
        issueNumber: 2,
        identifier: `${issuePrefix}-2`,
      },
    ]);
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      invocationSource: "heartbeat",
      triggerDetail: "timer",
      status: "running",
      contextSnapshot: { issueId: runningIssueId, wakeReason: "heartbeat_timer" },
      startedAt: stale,
      lastUsefulActionAt: stale,
      lastOutputAt: recentOutput,
      createdAt: stale,
      updatedAt: recentOutput,
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
      payload: { issueId: queuedIssueId },
      status: "queued",
      runId: queuedRunId,
      requestedAt: recentOutput,
      updatedAt: recentOutput,
    });
    await db.insert(heartbeatRuns).values({
      id: queuedRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId: queuedWakeupId,
      contextSnapshot: { issueId: queuedIssueId, wakeReason: "issue_assigned" },
      createdAt: recentOutput,
      updatedAt: recentOutput,
    });

    await heartbeat.resumeQueuedRuns();

    expect(mockAdapterExecute).not.toHaveBeenCalled();
    const queuedRun = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, queuedRunId))
      .then((rows) => rows[0] ?? null);
    expect(queuedRun?.status).toBe("queued");
  });

  it("suppresses a queued same-issue retry even when the running row is stale", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `D${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "StaleSameIssueCo",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "StaleSameIssueAgent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 2 } },
      permissions: {},
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Issue with quiet owner",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      startedAt: new Date(),
    });

    const staleOutputAt = new Date(Date.now() - 20 * 60 * 1000);
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      invocationSource: "heartbeat",
      triggerDetail: "timer",
      status: "running",
      contextSnapshot: { issueId, wakeReason: "heartbeat_timer" },
      startedAt: staleOutputAt,
      lastOutputAt: staleOutputAt,
      createdAt: staleOutputAt,
      updatedAt: staleOutputAt,
    });

    const queuedWakeupId = randomUUID();
    const queuedRunId = randomUUID();
    const queuedTime = new Date();
    await db.insert(agentWakeupRequests).values({
      id: queuedWakeupId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      status: "queued",
      runId: queuedRunId,
      requestedAt: queuedTime,
      updatedAt: queuedTime,
    });
    await db.insert(heartbeatRuns).values({
      id: queuedRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId: queuedWakeupId,
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
      createdAt: queuedTime,
      updatedAt: queuedTime,
    });

    mockAdapterExecute.mockClear();
    await heartbeat.resumeQueuedRuns();

    const queuedRun = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, queuedRunId))
      .then((rows) => rows[0] ?? null);
    expect(queuedRun).toMatchObject({
      status: "cancelled",
      errorCode: "duplicate_dispatch_suppressed",
    });
    expect(mockAdapterExecute.mock.calls.some(([ctx]) => ctx.runId === queuedRunId)).toBe(false);
  });

  it("keeps a same-PR review follow-up queued while another review task is running", async () => {
    const companyId = randomUUID();
    const runningReviewerId = randomUUID();
    const queuedReviewerId = randomUUID();
    const blockedTaskKey = "pr_review:Blockcast/paperclip:123";
    const otherTaskKey = "pr_review:Blockcast/paperclip:124";

    await db.insert(companies).values({
      id: companyId,
      name: "ReviewDispatchCo",
      issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values([
      {
        id: runningReviewerId,
        companyId,
        name: "RunningReviewAgent",
        role: "engineer",
        status: "running",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 3 } },
        permissions: {},
      },
      {
        id: queuedReviewerId,
        companyId,
        name: "QueuedReviewAgent",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 3 } },
        permissions: {},
      },
    ]);

    const now = new Date();
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId: runningReviewerId,
      invocationSource: "automation",
      triggerDetail: "github_webhook",
      status: "running",
      contextSnapshot: {
        taskKey: blockedTaskKey,
        reviewKind: "pr_review",
        wakeReason: "github_pr_review_requested",
      },
      startedAt: now,
      lastOutputAt: now,
      createdAt: now,
      updatedAt: now,
    });

    const blockedWakeId = randomUUID();
    const blockedRunId = randomUUID();
    const otherWakeId = randomUUID();
    const otherRunId = randomUUID();
    await db.insert(agentWakeupRequests).values([
      {
        id: blockedWakeId,
        companyId,
        agentId: queuedReviewerId,
        source: "automation",
        triggerDetail: "github_webhook",
        reason: "github_pr_review_requested",
        status: "queued",
        runId: blockedRunId,
      },
      {
        id: otherWakeId,
        companyId,
        agentId: queuedReviewerId,
        source: "automation",
        triggerDetail: "github_webhook",
        reason: "github_pr_review_requested",
        status: "queued",
        runId: otherRunId,
      },
    ]);
    await db.insert(heartbeatRuns).values([
      {
        id: blockedRunId,
        companyId,
        agentId: queuedReviewerId,
        invocationSource: "automation",
        triggerDetail: "github_webhook",
        status: "queued",
        wakeupRequestId: blockedWakeId,
        contextSnapshot: {
          taskKey: blockedTaskKey,
          reviewKind: "pr_review",
          wakeReason: "github_pr_review_requested",
        },
      },
      {
        id: otherRunId,
        companyId,
        agentId: queuedReviewerId,
        invocationSource: "automation",
        triggerDetail: "github_webhook",
        status: "queued",
        wakeupRequestId: otherWakeId,
        contextSnapshot: {
          taskKey: otherTaskKey,
          reviewKind: "pr_review",
          wakeReason: "github_pr_review_requested",
        },
      },
    ]);

    mockAdapterExecute.mockClear();
    await heartbeat.resumeQueuedRuns();
    await waitForRunToSettle(heartbeat, otherRunId);

    const blockedRun = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, blockedRunId))
      .then((rows) => rows[0] ?? null);
    expect(blockedRun?.status).toBe("queued");
    expect(mockAdapterExecute.mock.calls.some(([ctx]) => ctx.runId === blockedRunId)).toBe(false);
    expect(mockAdapterExecute.mock.calls.some(([ctx]) => ctx.runId === otherRunId)).toBe(true);
  });

  it("dispatches a long-starved low-priority todo run ahead of a fresh in_progress run (BLO-16253)", async () => {
    // Regression for BLO-16253: dispatchRank had no time component, so a
    // `todo` queued run could be starved forever behind a busy agent's
    // constantly-refreshed `in_progress` follow-up dispatches, even at equal
    // or lower priority — external-lifecycle agents dispatch exactly one
    // winner per tick, so a perpetual loser never got a turn. Observed live
    // on BLO-15871 (low priority, todo): its queued run sat unpromoted for
    // 4+ hours because the same agent's in_progress issues kept winning the
    // single dispatch slot every tick. Without the STARVATION_* aging term,
    // the fresh low-priority in_progress run below (rank 6) would always
    // beat the old low-priority todo run (rank 7), no matter how long it
    // waited.
    const companyId = randomUUID();
    const agentId = randomUUID();
    const starvedTodoIssueId = randomUUID();
    const freshInProgressIssueId = randomUUID();
    const issuePrefix = `V${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "StarvationTestCo",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "StarvationTestAgent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });

    await db.insert(issues).values([
      // Starved issue: low priority, todo — same tier the aging term must rescue.
      {
        id: starvedTodoIssueId,
        companyId,
        title: "Long-starved low priority todo work",
        status: "todo",
        priority: "low",
        assigneeAgentId: agentId,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
      },
      // Fresh issue: low priority, in_progress — wins on the un-aged formula
      // (rank 6 vs rank 7) despite being queued far more recently.
      {
        id: freshInProgressIssueId,
        companyId,
        title: "Fresh low priority in-progress work",
        status: "in_progress",
        priority: "low",
        assigneeAgentId: agentId,
        issueNumber: 2,
        identifier: `${issuePrefix}-2`,
        startedAt: new Date(),
      },
    ]);

    // Starved run's createdAt is well past STARVATION_FULL_ESCALATION_MS (2h).
    const starvedCreatedAt = new Date(Date.now() - 3 * 60 * 60 * 1000);
    const freshCreatedAt = new Date();

    const starvedWakeId = randomUUID();
    const starvedRunId = randomUUID();
    const freshWakeId = randomUUID();
    const freshRunId = randomUUID();

    await db.insert(agentWakeupRequests).values([
      {
        id: starvedWakeId,
        companyId,
        agentId,
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: { issueId: starvedTodoIssueId },
        status: "queued",
        runId: starvedRunId,
        requestedAt: starvedCreatedAt,
        updatedAt: starvedCreatedAt,
      },
      {
        id: freshWakeId,
        companyId,
        agentId,
        source: "heartbeat",
        triggerDetail: "timer",
        reason: "heartbeat_timer",
        payload: { issueId: freshInProgressIssueId },
        status: "queued",
        runId: freshRunId,
        requestedAt: freshCreatedAt,
        updatedAt: freshCreatedAt,
      },
    ]);

    await db.insert(heartbeatRuns).values([
      {
        id: starvedRunId,
        companyId,
        agentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "queued",
        wakeupRequestId: starvedWakeId,
        contextSnapshot: { issueId: starvedTodoIssueId, wakeReason: "issue_assigned" },
        createdAt: starvedCreatedAt,
        updatedAt: starvedCreatedAt,
      },
      {
        id: freshRunId,
        companyId,
        agentId,
        invocationSource: "heartbeat",
        triggerDetail: "timer",
        status: "queued",
        wakeupRequestId: freshWakeId,
        contextSnapshot: { issueId: freshInProgressIssueId, wakeReason: "heartbeat_timer" },
        createdAt: freshCreatedAt,
        updatedAt: freshCreatedAt,
      },
    ]);

    const dispatchedRunIds: string[] = [];
    mockAdapterExecute.mockImplementation(async (args: { runId: string }) => {
      dispatchedRunIds.push(args.runId);
      return {
        exitCode: 0,
        signal: null as string | null,
        timedOut: false,
        errorMessage: null as string | null,
        resultJson: { exitCode: 0 },
        provider: "test",
        model: "test-model",
      };
    });

    // Dispatch: only 1 slot available (maxConcurrentRuns: 1, 0 running).
    await heartbeat.resumeQueuedRuns();
    await waitForRunToSettle(heartbeat, starvedRunId);

    // REGRESSION GUARD: the long-starved todo run must win the single slot
    // despite being lower-ranked than the fresh in_progress run under the
    // un-aged formula.
    expect(dispatchedRunIds[0]).toBe(starvedRunId);

    const starvedRun = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, starvedRunId))
      .then((rows) => rows[0] ?? null);
    expect(starvedRun?.status).not.toBe("queued");
  });

  it("dispatches a recovery/wake_owner run ahead of a fresh in_progress run well before the routine starvation floor (BLO-16253 follow-up)", async () => {
    // Follow-up regression: a recovery-sourced queued run (contextSnapshot.
    // recoveryActionId set — see recovery/service.ts enqueueWakeup calls for
    // stranded_assigned_issue) represents an already-detected failure that
    // needs the owner's attention now, not routine backlog. Before this fix
    // it used the same STARVATION_FULL_ESCALATION_MS (2h) floor as ordinary
    // `todo` work. Observed live: BLO-15871's stranded_assigned_issue
    // recovery (owner CTO) sat unacted for ~2h48m because it only escalated
    // once it crossed that routine 2h floor. This test queues a recovery
    // run for 15 minutes (well past the new 10-minute
    // STARVATION_RECOVERY_ESCALATION_MS floor, but far short of the routine
    // 2h floor or even the 30-minute status-boost tier) against a fresh
    // in_progress run that would otherwise win outright.
    const companyId = randomUUID();
    const agentId = randomUUID();
    const recoveryIssueId = randomUUID();
    const freshInProgressIssueId = randomUUID();
    const issuePrefix = `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "RecoveryTestCo",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "RecoveryTestAgent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });

    await db.insert(issues).values([
      // Recovery-target issue: low priority, blocked (as stranded_assigned_issue
      // recovery leaves the source issue) — same disadvantaged tier a routine
      // todo run would occupy under the un-aged formula.
      {
        id: recoveryIssueId,
        companyId,
        title: "Stranded issue awaiting recovery",
        status: "blocked",
        priority: "low",
        assigneeAgentId: agentId,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
      },
      // Fresh issue: low priority, in_progress — wins on the un-aged formula
      // and would still win under the routine (non-recovery) aging curve for
      // another ~1h45m.
      {
        id: freshInProgressIssueId,
        companyId,
        title: "Fresh low priority in-progress work",
        status: "in_progress",
        priority: "low",
        assigneeAgentId: agentId,
        issueNumber: 2,
        identifier: `${issuePrefix}-2`,
        startedAt: new Date(),
      },
    ]);

    // Recovery run's createdAt is past STARVATION_RECOVERY_ESCALATION_MS (10 min)
    // but nowhere near STARVATION_STATUS_BOOST_MS (30 min) or
    // STARVATION_FULL_ESCALATION_MS (2h).
    const recoveryCreatedAt = new Date(Date.now() - 15 * 60 * 1000);
    const freshCreatedAt = new Date();

    const recoveryWakeId = randomUUID();
    const recoveryRunId = randomUUID();
    const freshWakeId = randomUUID();
    const freshRunId = randomUUID();

    await db.insert(agentWakeupRequests).values([
      {
        id: recoveryWakeId,
        companyId,
        agentId,
        source: "assignment",
        triggerDetail: "system",
        reason: "source_scoped_recovery_action",
        payload: { issueId: recoveryIssueId, recoveryActionId: randomUUID() },
        status: "queued",
        runId: recoveryRunId,
        requestedAt: recoveryCreatedAt,
        updatedAt: recoveryCreatedAt,
      },
      {
        id: freshWakeId,
        companyId,
        agentId,
        source: "heartbeat",
        triggerDetail: "timer",
        reason: "heartbeat_timer",
        payload: { issueId: freshInProgressIssueId },
        status: "queued",
        runId: freshRunId,
        requestedAt: freshCreatedAt,
        updatedAt: freshCreatedAt,
      },
    ]);

    await db.insert(heartbeatRuns).values([
      {
        id: recoveryRunId,
        companyId,
        agentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "queued",
        wakeupRequestId: recoveryWakeId,
        contextSnapshot: {
          issueId: recoveryIssueId,
          wakeReason: "source_scoped_recovery_action",
          source: "issue_recovery_action",
          recoveryActionId: randomUUID(),
        },
        createdAt: recoveryCreatedAt,
        updatedAt: recoveryCreatedAt,
      },
      {
        id: freshRunId,
        companyId,
        agentId,
        invocationSource: "heartbeat",
        triggerDetail: "timer",
        status: "queued",
        wakeupRequestId: freshWakeId,
        contextSnapshot: { issueId: freshInProgressIssueId, wakeReason: "heartbeat_timer" },
        createdAt: freshCreatedAt,
        updatedAt: freshCreatedAt,
      },
    ]);

    const dispatchedRunIds: string[] = [];
    mockAdapterExecute.mockImplementation(async (args: { runId: string }) => {
      dispatchedRunIds.push(args.runId);
      return {
        exitCode: 0,
        signal: null as string | null,
        timedOut: false,
        errorMessage: null as string | null,
        resultJson: { exitCode: 0 },
        provider: "test",
        model: "test-model",
      };
    });

    // Dispatch: only 1 slot available (maxConcurrentRuns: 1, 0 running).
    await heartbeat.resumeQueuedRuns();
    await waitForRunToSettle(heartbeat, recoveryRunId);

    // REGRESSION GUARD: the recovery wake must win the single slot far
    // sooner than a routine `todo` run would, despite being ranked worse
    // than the fresh in_progress run under the un-aged formula.
    expect(dispatchedRunIds[0]).toBe(recoveryRunId);

    const recoveryRun = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, recoveryRunId))
      .then((rows) => rows[0] ?? null);
    expect(recoveryRun?.status).not.toBe("queued");
  });

  it("keeps critical work ahead of a long-starved non-critical run without stranding the aged run (BLO-16554, BLO-19337)", async () => {
    // Regression for BLO-16554: MulticastEngineer (opencode_k8s, external
    // lifecycle) had a queued retry sit `startedAt: null` for ~9.5h despite
    // being far past STARVATION_FULL_ESCALATION_MS (2h) and the agent's
    // single slot cycling other work in that window. External-lifecycle
    // agents default to effectiveMaxConcurrentRuns = 1 regardless of the
    // configured maxConcurrentRuns (BLO-15959, concurrencyEnabled defaults
    // false).
    //
    // This pins the "one non-stale running run holds the only slot" shape
    // AND exercises the bounded aging floor: a second, fresher queued run at
    // critical priority (the best possible un-aged rank, 0) is queued
    // alongside the starved run. The critical run must retain the emergency
    // lane, then the aged run must dispatch as soon as that slot frees.
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runningIssueId = randomUUID();
    const starvedIssueId = randomUUID();
    const freshIssueId = randomUUID();
    const issuePrefix = `X${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "ExternalSlotStarvationCo",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "ExternalLifecycleAgent",
      role: "engineer",
      status: "idle",
      adapterType: "claude_k8s",
      adapterConfig: {},
      // maxConcurrentRuns is intentionally > 1 to prove effectiveMaxConcurrentRuns
      // collapses to 1 anyway (concurrencyEnabled omitted -> defaults false).
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 3 } },
      permissions: {},
    });

    await db.insert(issues).values([
      {
        id: runningIssueId,
        companyId,
        title: "Other backlog work currently occupying the single slot",
        status: "in_progress",
        priority: "high",
        assigneeAgentId: agentId,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
        startedAt: new Date(),
      },
      {
        id: starvedIssueId,
        companyId,
        title: "Long-starved retry work",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: agentId,
        issueNumber: 2,
        identifier: `${issuePrefix}-2`,
        startedAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
      },
      // Fresh contender: critical priority (un-aged rank 0, the best possible
      // score) and just queued. Aging non-critical work must not erase this
      // explicit emergency lane.
      {
        id: freshIssueId,
        companyId,
        title: "Fresh critical-priority contender",
        status: "in_progress",
        priority: "critical",
        assigneeAgentId: agentId,
        issueNumber: 3,
        identifier: `${issuePrefix}-3`,
        startedAt: new Date(),
      },
    ]);

    const runningRunId = randomUUID();
    const starvedRunId = randomUUID();
    const freshRunId = randomUUID();
    const starvedCreatedAt = new Date(Date.now() - 3 * 60 * 60 * 1000);
    const freshCreatedAt = new Date();

    await db.insert(heartbeatRuns).values([
      // Occupies the agent's one effective slot: fresh (non-stale) running run.
      {
        id: runningRunId,
        companyId,
        agentId,
        invocationSource: "heartbeat",
        triggerDetail: "timer",
        status: "running",
        contextSnapshot: { issueId: runningIssueId, wakeReason: "heartbeat_timer" },
        startedAt: new Date(),
        lastOutputAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      // Retry/continuation run, well past STARVATION_FULL_ESCALATION_MS (2h).
      {
        id: starvedRunId,
        companyId,
        agentId,
        invocationSource: "automation",
        triggerDetail: "system",
        status: "queued",
        contextSnapshot: {
          issueId: starvedIssueId,
          wakeReason: "issue_continuation_needed",
          source: "issue.continuation_recovery",
        },
        createdAt: starvedCreatedAt,
        updatedAt: starvedCreatedAt,
      },
      // Fresh critical-priority contender queued alongside the starved run.
      {
        id: freshRunId,
        companyId,
        agentId,
        invocationSource: "heartbeat",
        triggerDetail: "timer",
        status: "queued",
        contextSnapshot: { issueId: freshIssueId, wakeReason: "heartbeat_timer" },
        createdAt: freshCreatedAt,
        updatedAt: freshCreatedAt,
      },
    ]);

    const dispatchedRunIds: string[] = [];
    mockAdapterExecute.mockImplementation(async (args: { runId: string }) => {
      dispatchedRunIds.push(args.runId);
      return {
        exitCode: 0,
        signal: null as string | null,
        timedOut: false,
        errorMessage: null as string | null,
        resultJson: { exitCode: 0 },
        provider: "test",
        model: "test-model",
      };
    });

    // First tick: the single effective slot is occupied by the fresh running
    // run, so neither queued contender must be dispatched yet.
    await heartbeat.resumeQueuedRuns();
    const stillQueued = await db
      .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(inArray(heartbeatRuns.id, [starvedRunId, freshRunId]));
    expect(stillQueued.every((row) => row.status === "queued")).toBe(true);
    expect(dispatchedRunIds).toHaveLength(0);

    // The occupying run finishes, freeing the agent's one effective slot.
    await db
      .update(heartbeatRuns)
      .set({ status: "succeeded", finishedAt: new Date(), updatedAt: new Date() })
      .where(eq(heartbeatRuns.id, runningRunId));

    // Next slot-available tick: critical work must win first. The mock adapter
    // resolves instantly, so the aged run must then consume the next slot
    // during queue drain rather than being stranded again.
    await heartbeat.resumeQueuedRuns();
    await waitForRunToSettle(heartbeat, freshRunId);
    await waitForRunToSettle(heartbeat, starvedRunId);

    expect(dispatchedRunIds[0]).toBe(freshRunId);
    expect(dispatchedRunIds.indexOf(starvedRunId)).toBeGreaterThan(0);

    const starvedRun = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, starvedRunId))
      .then((rows) => rows[0] ?? null);
    expect(starvedRun?.status).not.toBe("queued");
  });

  it("dispatches critical issue work before an aged issue-less run without starving routine issue work (BLO-19337)", async () => {
    // Regression for BLO-18995: dispatchRank returned a flat `10` for any run
    // without an issueId *above* the STARVATION_* aging escalation, so that
    // entire class had no anti-starvation path at all. Every dependency-ready
    // issue-bound run ranks `priorityRank * 2 + statusBonus` ∈ [0,9], so even a
    // `low`-priority `todo` (rank 7) permanently outranked an arbitrarily old
    // issue-less run. Rank 0 fixed that starvation but also put the entire aged
    // webhook backlog ahead of fresh critical issue work. The bounded rank 2
    // must preserve both sides: critical first, aged issue-less second, routine
    // medium work third.
    //
    // The starved run here deliberately carries NO `reviewKind`/`taskKey`
    // pr_review markers, so selectAgedPrReviewRunForFairDispatch cannot promote
    // it. That isolates the aging fix: without it, nothing in the scheduler can
    // rescue this run.
    const companyId = randomUUID();
    const agentId = randomUUID();
    const criticalIssueId = randomUUID();
    const freshIssueId = randomUUID();
    const issuePrefix = `W${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "IssuelessStarvationTestCo",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "IssuelessStarvationTestAgent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });

    await db.insert(issues).values([
      {
        // Fresh, dependency-ready, critical todo => rank 1.
        id: criticalIssueId,
        companyId,
        title: "Critical exact-head review",
        status: "todo",
        priority: "critical",
        assigneeAgentId: agentId,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
      },
      {
        // Fresh, dependency-ready, in_progress, medium priority => rank 4.
        id: freshIssueId,
        companyId,
        title: "Fresh medium priority in-progress work",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: agentId,
        issueNumber: 2,
        identifier: `${issuePrefix}-2`,
        startedAt: new Date(),
      },
    ]);

    // Well past STARVATION_FULL_ESCALATION_MS (2h).
    const starvedCreatedAt = new Date(Date.now() - 3 * 60 * 60 * 1000);
    const freshCreatedAt = new Date();

    const starvedWakeId = randomUUID();
    const starvedRunId = randomUUID();
    const criticalWakeId = randomUUID();
    const criticalRunId = randomUUID();
    const freshWakeId = randomUUID();
    const freshRunId = randomUUID();

    await db.insert(agentWakeupRequests).values([
      {
        id: starvedWakeId,
        companyId,
        agentId,
        source: "automation",
        triggerDetail: "system",
        reason: "github_pr_ready_for_review",
        payload: {},
        status: "queued",
        runId: starvedRunId,
        requestedAt: starvedCreatedAt,
        updatedAt: starvedCreatedAt,
      },
      {
        id: criticalWakeId,
        companyId,
        agentId,
        source: "assignment",
        triggerDetail: "system",
        reason: "heartbeat_timer",
        payload: { issueId: criticalIssueId },
        status: "queued",
        runId: criticalRunId,
        requestedAt: freshCreatedAt,
        updatedAt: freshCreatedAt,
      },
      {
        id: freshWakeId,
        companyId,
        agentId,
        source: "heartbeat",
        triggerDetail: "timer",
        reason: "heartbeat_timer",
        payload: { issueId: freshIssueId },
        status: "queued",
        runId: freshRunId,
        requestedAt: freshCreatedAt,
        updatedAt: freshCreatedAt,
      },
    ]);

    await db.insert(heartbeatRuns).values([
      {
        id: starvedRunId,
        companyId,
        agentId,
        invocationSource: "automation",
        triggerDetail: "system",
        status: "queued",
        wakeupRequestId: starvedWakeId,
        // No issueId, and no pr_review markers.
        contextSnapshot: { wakeReason: "github_pr_ready_for_review" },
        createdAt: starvedCreatedAt,
        updatedAt: starvedCreatedAt,
      },
      {
        id: criticalRunId,
        companyId,
        agentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "queued",
        wakeupRequestId: criticalWakeId,
        contextSnapshot: { issueId: criticalIssueId, wakeReason: "heartbeat_timer" },
        createdAt: freshCreatedAt,
        updatedAt: freshCreatedAt,
      },
      {
        id: freshRunId,
        companyId,
        agentId,
        invocationSource: "heartbeat",
        triggerDetail: "timer",
        status: "queued",
        wakeupRequestId: freshWakeId,
        contextSnapshot: { issueId: freshIssueId, wakeReason: "heartbeat_timer" },
        createdAt: freshCreatedAt,
        updatedAt: freshCreatedAt,
      },
    ]);

    const dispatchedRunIds: string[] = [];
    mockAdapterExecute.mockImplementation(async (args: { runId: string }) => {
      dispatchedRunIds.push(args.runId);
      return {
        exitCode: 0,
        signal: null as string | null,
        timedOut: false,
        errorMessage: null as string | null,
        resultJson: { exitCode: 0 },
        provider: "test",
        model: "test-model",
      };
    });

    await heartbeat.resumeQueuedRuns();
    await waitForRunToSettle(heartbeat, starvedRunId);

    // REGRESSION GUARD: critical work keeps the emergency lane, while the aged
    // issue-less run still advances ahead of routine issue work.
    expect(dispatchedRunIds[0]).toBe(criticalRunId);
    const starvedDispatchIdx = dispatchedRunIds.indexOf(starvedRunId);
    expect(starvedDispatchIdx).toBeGreaterThan(0);
    const freshDispatchIdx = dispatchedRunIds.indexOf(freshRunId);
    if (freshDispatchIdx !== -1) {
      expect(freshDispatchIdx).toBeGreaterThan(starvedDispatchIdx);
    }

    const starvedRun = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, starvedRunId))
      .then((rows) => rows[0] ?? null);
    expect(starvedRun?.status).not.toBe("queued");
  });

  it("keeps a fresh issue-less run behind issue work (BLO-18995 does not invert normal order)", async () => {
    // Guard the other side of the BLO-18995 change: the escalation must be an
    // aging floor, not a blanket promotion. A *fresh* issue-less run still
    // ranks 10 and must lose to dependency-ready issue work, otherwise every
    // PR-review wake would preempt issue execution on arrival.
    const companyId = randomUUID();
    const agentId = randomUUID();
    const freshIssueId = randomUUID();
    const issuePrefix = `X${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "IssuelessFreshTestCo",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "IssuelessFreshTestAgent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });

    await db.insert(issues).values({
      id: freshIssueId,
      companyId,
      title: "Fresh medium priority in-progress work",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      startedAt: new Date(),
    });

    // Both fresh: the issue-less run is a few minutes old, nowhere near the
    // 2h floor, and carries no pr_review markers (so the 10-minute PR-review
    // fairness valve cannot promote it either).
    const issuelessCreatedAt = new Date(Date.now() - 3 * 60 * 1000);
    const freshCreatedAt = new Date(Date.now() - 60 * 1000);

    const issuelessWakeId = randomUUID();
    const issuelessRunId = randomUUID();
    const freshWakeId = randomUUID();
    const freshRunId = randomUUID();

    await db.insert(agentWakeupRequests).values([
      {
        id: issuelessWakeId,
        companyId,
        agentId,
        source: "automation",
        triggerDetail: "system",
        reason: "github_pr_ready_for_review",
        payload: {},
        status: "queued",
        runId: issuelessRunId,
        requestedAt: issuelessCreatedAt,
        updatedAt: issuelessCreatedAt,
      },
      {
        id: freshWakeId,
        companyId,
        agentId,
        source: "heartbeat",
        triggerDetail: "timer",
        reason: "heartbeat_timer",
        payload: { issueId: freshIssueId },
        status: "queued",
        runId: freshRunId,
        requestedAt: freshCreatedAt,
        updatedAt: freshCreatedAt,
      },
    ]);

    await db.insert(heartbeatRuns).values([
      {
        id: issuelessRunId,
        companyId,
        agentId,
        invocationSource: "automation",
        triggerDetail: "system",
        status: "queued",
        wakeupRequestId: issuelessWakeId,
        contextSnapshot: { wakeReason: "github_pr_ready_for_review" },
        createdAt: issuelessCreatedAt,
        updatedAt: issuelessCreatedAt,
      },
      {
        id: freshRunId,
        companyId,
        agentId,
        invocationSource: "heartbeat",
        triggerDetail: "timer",
        status: "queued",
        wakeupRequestId: freshWakeId,
        contextSnapshot: { issueId: freshIssueId, wakeReason: "heartbeat_timer" },
        createdAt: freshCreatedAt,
        updatedAt: freshCreatedAt,
      },
    ]);

    const dispatchedRunIds: string[] = [];
    mockAdapterExecute.mockImplementation(async (args: { runId: string }) => {
      dispatchedRunIds.push(args.runId);
      return {
        exitCode: 0,
        signal: null as string | null,
        timedOut: false,
        errorMessage: null as string | null,
        resultJson: { exitCode: 0 },
        provider: "test",
        model: "test-model",
      };
    });

    await heartbeat.resumeQueuedRuns();
    await waitForRunToSettle(heartbeat, freshRunId);

    expect(dispatchedRunIds[0]).toBe(freshRunId);
  });

  it("continues after the resume cap so deep dependency-blocked queues do not strand later runnable work", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const blockerIssueId = randomUUID();
    const runnableIssueId = randomUUID();
    const runnableWakeId = randomUUID();
    const runnableRunId = randomUUID();
    const issuePrefix = `D${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const baseCreatedAt = new Date(Date.now() - 90 * 60 * 1000);
    // BLO-20396: reaching the resume cap costs
    // `scanLimit * maxScanBatches * maxResumePasses` queued rows. With the
    // production bounds (200 * 10 * 10) that is 20,000 runs plus their issues,
    // wakes and dependency rows — ~80k inserts, which blew this test past its
    // 180s budget and made the serialized shard the slowest job in CI.
    //
    // A dedicated service with narrowed bounds reproduces the SAME geometry at
    // 1/250th the size: `blockedCount` is still exactly the cap product, so the
    // runnable row still sits immediately past the boundary the cap forces the
    // chain to yield at. Shrinking the world rather than raising the timeout
    // keeps the cap arithmetic itself under test.
    const dispatchBounds = { scanLimit: 20, maxScanBatches: 2, maxResumePasses: 2 };
    const dispatchEvents: string[] = [];
    const blockedCount =
      dispatchBounds.scanLimit * dispatchBounds.maxScanBatches * dispatchBounds.maxResumePasses;
    const cappedHeartbeat = heartbeatService(db, {
      penstockGate: allowPenstockGate,
      queuedRunDispatchBounds: dispatchBounds,
      onQueuedDispatchScheduledForTest: ({ reason }) => {
        dispatchEvents.push(reason);
      },
    });

    await db.insert(companies).values({
      id: companyId,
      name: "DeepBlockedQueueCo",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "DeepBlockedQueueAgent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });

    await db.insert(issues).values({
      id: blockerIssueId,
      companyId,
      title: "Unresolved blocker",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      startedAt: baseCreatedAt,
    });

    const chunkSize = 500;
    for (let offset = 0; offset < blockedCount; offset += chunkSize) {
      const issueRows: Array<typeof issues.$inferInsert> = [];
      const relationRows: Array<typeof issueRelations.$inferInsert> = [];
      const wakeRows: Array<typeof agentWakeupRequests.$inferInsert> = [];
      const runRows: Array<typeof heartbeatRuns.$inferInsert> = [];
      for (let index = offset; index < Math.min(offset + chunkSize, blockedCount); index += 1) {
        const issueId = randomUUID();
        const wakeId = randomUUID();
        const runId = randomUUID();
        const createdAt = new Date(baseCreatedAt.getTime() + index);
        issueRows.push({
          id: issueId,
          companyId,
          title: `Dependency-blocked queued issue ${index}`,
          status: "todo",
          priority: "low",
          assigneeAgentId: agentId,
          issueNumber: index + 2,
          identifier: `${issuePrefix}-${index + 2}`,
        });
        relationRows.push({
          companyId,
          issueId: blockerIssueId,
          relatedIssueId: issueId,
          type: "blocks",
        });
        wakeRows.push({
          id: wakeId,
          companyId,
          agentId,
          source: "assignment",
          triggerDetail: "system",
          reason: "issue_assigned",
          payload: { issueId },
          status: "queued",
          runId,
          requestedAt: createdAt,
          updatedAt: createdAt,
        });
        runRows.push({
          id: runId,
          companyId,
          agentId,
          invocationSource: "assignment",
          triggerDetail: "system",
          status: "queued",
          wakeupRequestId: wakeId,
          contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
          createdAt,
          updatedAt: createdAt,
        });
      }
      await db.insert(issues).values(issueRows);
      await db.insert(issueRelations).values(relationRows);
      await db.insert(agentWakeupRequests).values(wakeRows);
      await db.insert(heartbeatRuns).values(runRows);
    }

    const runnableCreatedAt = new Date(baseCreatedAt.getTime() + blockedCount);
    await db.insert(issues).values({
      id: runnableIssueId,
      companyId,
      title: "Runnable work behind the resume cap",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: blockedCount + 2,
      identifier: `${issuePrefix}-${blockedCount + 2}`,
    });
    await db.insert(agentWakeupRequests).values({
      id: runnableWakeId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId: runnableIssueId },
      status: "queued",
      runId: runnableRunId,
      requestedAt: runnableCreatedAt,
      updatedAt: runnableCreatedAt,
    });
    await db.insert(heartbeatRuns).values({
      id: runnableRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId: runnableWakeId,
      contextSnapshot: { issueId: runnableIssueId, taskId: runnableIssueId, wakeReason: "issue_assigned" },
      createdAt: runnableCreatedAt,
      updatedAt: runnableCreatedAt,
    });

    const dispatchedRunIds: string[] = [];
    mockAdapterExecute.mockImplementation(async (args: { runId: string }) => {
      dispatchEvents.push(`dispatch:${args.runId}`);
      dispatchedRunIds.push(args.runId);
      return {
        exitCode: 0,
        signal: null as string | null,
        timedOut: false,
        errorMessage: null as string | null,
        resultJson: { exitCode: 0 },
        provider: "test",
        model: "test-model",
      };
    });

    await cappedHeartbeat.resumeQueuedRuns();
    const runnableRun = await waitForRunToSettle(cappedHeartbeat, runnableRunId, 120_000);

    expect(dispatchedRunIds).toContain(runnableRunId);
    expect(runnableRun?.status).not.toBe("queued");
    expect(dispatchEvents).toContain("resume_bounded_scan_after_cap");
    expect(dispatchEvents.indexOf("resume_bounded_scan_after_cap")).toBeLessThan(
      dispatchEvents.indexOf(`dispatch:${runnableRunId}`),
    );

    // Scoped instance: drain it here so its in-flight work cannot outlive the
    // test and race the shared afterEach cleanup.
    await cappedHeartbeat.drainInFlightExecutions(60_000);
  }, 180_000);

  it("continues the bounded scan when a pass claims fewer runs than it has slots", async () => {
    // BLO-20396 (review follow-up): a PARTIALLY filled dispatch pass used to
    // abandon its continuation. advanceOrClearResumeCursor stored the forward
    // cursor and returned false whenever anything was claimed, and the caller
    // scheduled nothing, on the reasoning that "a claim re-triggers dispatch
    // when it completes".
    //
    // That reasoning only covers the slot the claim occupied. The geometry
    // below is the case it misses, and it is the one this fleet actually hits:
    //
    //   slots:  2 free
    //   window: [ claimable-but-long-running , dependency-blocked ]
    //   beyond: [ runnable ]                       <- never examined
    //
    // The pass claims one run, refuses the other, and stops with a slot still
    // free — not because it ran out of capacity, but because it ran out of
    // candidates IN THIS WINDOW. Nothing then looks past the cursor: no
    // completion fires for a slot that never started, and nothing was pruned,
    // so the prune follow-up does not fire either. The runnable row waits for
    // the long-running claim to finish, which on Ally means a ~50-minute
    // review.
    //
    // The hold below is what makes this a real regression test rather than a
    // coincidence: run #1 never completes during the test, so the only thing
    // that can dispatch the third run is the continuation itself.
    const companyId = randomUUID();
    const agentId = randomUUID();
    const blockerIssueId = randomUUID();
    const holdIssueId = randomUUID();
    const blockedIssueId = randomUUID();
    const beyondIssueId = randomUUID();
    const holdRunId = randomUUID();
    const blockedRunId = randomUUID();
    const beyondRunId = randomUUID();
    const issuePrefix = `P${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const baseCreatedAt = new Date(Date.now() - 90 * 60 * 1000);

    // A two-row window with a third row behind it. maxScanBatches: 1 makes the
    // first pass stop after exactly two rows with the cursor set and the scan
    // NOT exhausted, which is the state that owes a continuation.
    const dispatchBounds = { scanLimit: 2, maxScanBatches: 1, maxResumePasses: 5 };
    const partialHeartbeat = heartbeatService(db, {
      penstockGate: allowPenstockGate,
      queuedRunDispatchBounds: dispatchBounds,
    });

    let releaseHold = () => {};
    const holdReleased = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });

    try {
      await db.insert(companies).values({
        id: companyId,
        name: "PartialPassCo",
        issuePrefix,
        requireBoardApprovalForNewAgents: false,
        defaultResponsibleUserId: "responsible-user",
      });

      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "PartialPassAgent",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        // Two slots is the whole point: one claim must leave one free.
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 2 } },
        permissions: {},
      });

      await db.insert(issues).values([
        {
          id: blockerIssueId,
          companyId,
          title: "Unresolved blocker",
          status: "in_progress",
          priority: "high",
          assigneeAgentId: agentId,
          issueNumber: 1,
          identifier: `${issuePrefix}-1`,
          startedAt: baseCreatedAt,
        },
        {
          id: holdIssueId,
          companyId,
          title: "Long-running claim that occupies one slot",
          status: "todo",
          priority: "medium",
          assigneeAgentId: agentId,
          issueNumber: 2,
          identifier: `${issuePrefix}-2`,
        },
        {
          id: blockedIssueId,
          companyId,
          title: "Dependency-blocked row that fills the rest of the window",
          status: "todo",
          priority: "medium",
          assigneeAgentId: agentId,
          issueNumber: 3,
          identifier: `${issuePrefix}-3`,
        },
        {
          id: beyondIssueId,
          companyId,
          title: "Runnable work beyond the scan cursor",
          status: "todo",
          priority: "medium",
          assigneeAgentId: agentId,
          issueNumber: 4,
          identifier: `${issuePrefix}-4`,
        },
      ]);

      // Only the middle row is blocked, so it is refused without being claimed.
      await db.insert(issueRelations).values({
        companyId,
        issueId: blockerIssueId,
        relatedIssueId: blockedIssueId,
        type: "blocks",
      });

      const queued: Array<{ runId: string; issueId: string; offset: number }> = [
        { runId: holdRunId, issueId: holdIssueId, offset: 0 },
        { runId: blockedRunId, issueId: blockedIssueId, offset: 1 },
        { runId: beyondRunId, issueId: beyondIssueId, offset: 2 },
      ];
      for (const { runId, issueId, offset } of queued) {
        const wakeId = randomUUID();
        const createdAt = new Date(baseCreatedAt.getTime() + offset);
        await db.insert(agentWakeupRequests).values({
          id: wakeId,
          companyId,
          agentId,
          source: "assignment",
          triggerDetail: "system",
          reason: "issue_assigned",
          payload: { issueId },
          status: "queued",
          runId,
          requestedAt: createdAt,
          updatedAt: createdAt,
        });
        await db.insert(heartbeatRuns).values({
          id: runId,
          companyId,
          agentId,
          invocationSource: "assignment",
          triggerDetail: "system",
          status: "queued",
          wakeupRequestId: wakeId,
          contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
          createdAt,
          updatedAt: createdAt,
        });
      }

      const dispatchedRunIds: string[] = [];
      mockAdapterExecute.mockImplementation(async (args: { runId: string }) => {
        dispatchedRunIds.push(args.runId);
        // Hold the first slot open for the whole test.
        if (args.runId === holdRunId) await holdReleased;
        return {
          exitCode: 0,
          signal: null as string | null,
          timedOut: false,
          errorMessage: null as string | null,
          resultJson: { exitCode: 0 },
          provider: "test",
          model: "test-model",
        };
      });

      await partialHeartbeat.resumeQueuedRuns();

      // Wait for the run BEYOND the cursor to be dispatched. Deliberately not
      // waitForRunToSettle: that drains in-flight executions, and the held run
      // is in-flight by construction.
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline && !dispatchedRunIds.includes(beyondRunId)) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      // The claim that occupied slot 1 happened...
      expect(dispatchedRunIds).toContain(holdRunId);
      // ...and it is still running, so nothing it did could have re-triggered
      // dispatch. Any dispatch of the third run came from the continuation.
      expect((await partialHeartbeat.getRun(holdRunId))?.status).toBe("running");
      // The pre-fix failure: this row sat queued behind a slot that was free.
      expect(dispatchedRunIds).toContain(beyondRunId);
      expect((await partialHeartbeat.getRun(beyondRunId))?.status).not.toBe("queued");
    } finally {
      releaseHold();
      await partialHeartbeat.drainInFlightExecutions(60_000);
    }
  }, 180_000);

  it("pages past blocked and isolation-deferred critical rows before lower-priority work", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const blockerIssueId = randomUUID();
    const lowIssueId = randomUUID();
    const blockedCriticalIssueIds = [randomUUID(), randomUUID()];
    const deferredCriticalIssueIds = [randomUUID(), randomUUID()];
    const runnableCriticalIssueId = randomUUID();
    const runnableCriticalRunId = randomUUID();
    const issuePrefix = `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const baseCreatedAt = new Date(Date.now() - 5 * 60 * 1000);
    let criticalResumePasses = 0;
    let criticalResumePassesAtDispatch = Number.POSITIVE_INFINITY;
    const criticalContinuationSchedules: Array<{
      reason: string;
      suppressCriticalLaneHeadRescanDemand: boolean;
    }> = [];
    const criticalContinuationCoalesced: Array<{
      reason: string;
      resumeContinuation: boolean;
      suppressCriticalLaneHeadRescanDemand: boolean;
    }> = [];
    let releaseSchedulingPass = () => {};
    const schedulingPassHeld = new Promise<void>((resolve) => {
      releaseSchedulingPass = resolve;
    });
    let observeCoalescedContinuation = () => {};
    const coalescedContinuationObserved = new Promise<void>((resolve) => {
      observeCoalescedContinuation = resolve;
    });
    let boundedHeartbeat!: ReturnType<typeof heartbeatService>;
    boundedHeartbeat = heartbeatService(db, {
      penstockGate: allowPenstockGate,
      queuedRunDispatchBounds: { scanLimit: 2, maxScanBatches: 1, maxResumePasses: 5 },
      beforeQueuedDispatchPassForTest: async (event) => {
        if (event.reason !== "resume_critical_lane") return;
        criticalResumePasses += 1;
        // External wakes arriving while the continuation owns the lock must
        // request one eventual head rescan without erasing forward progress.
        if (criticalResumePasses <= 2) await boundedHeartbeat.resumeQueuedRuns();
      },
      onQueuedDispatchScheduledForTest: (event) => {
        if (event.reason === "resume_critical_lane") {
          criticalContinuationSchedules.push({
            reason: event.reason,
            suppressCriticalLaneHeadRescanDemand:
              event.suppressCriticalLaneHeadRescanDemand,
          });
        }
      },
      afterQueuedDispatchContinuationScheduledForTest: async (event) => {
        if (event.reason === "resume_critical_lane") await schedulingPassHeld;
      },
      onQueuedDispatchCoalescedDemandForTest: (event) => {
        if (event.reason !== "resume_critical_lane") return;
        criticalContinuationCoalesced.push({
          reason: event.reason,
          resumeContinuation: event.resumeContinuation,
          suppressCriticalLaneHeadRescanDemand:
            event.suppressCriticalLaneHeadRescanDemand,
        });
        observeCoalescedContinuation();
      },
    });

    await db.insert(companies).values({
      id: companyId,
      name: "CriticalLanePagingCo",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CriticalLanePagingAgent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    await db.insert(issues).values([
      {
        id: blockerIssueId,
        companyId,
        title: "Unresolved blocker",
        status: "in_progress",
        priority: "high",
        assigneeAgentId: agentId,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
        startedAt: baseCreatedAt,
      },
      {
        id: lowIssueId,
        companyId,
        title: "Older runnable low-priority work",
        status: "todo",
        priority: "low",
        assigneeAgentId: agentId,
        issueNumber: 2,
        identifier: `${issuePrefix}-2`,
      },
      ...blockedCriticalIssueIds.map((id, index) => ({
        id,
        companyId,
        title: `Blocked critical ${index + 1}`,
        status: "todo" as const,
        priority: "critical" as const,
        assigneeAgentId: agentId,
        issueNumber: index + 3,
        identifier: `${issuePrefix}-${index + 3}`,
      })),
      ...deferredCriticalIssueIds.map((id, index) => ({
        id,
        companyId,
        title: `Isolation-deferred critical ${index + 1}`,
        status: "todo" as const,
        priority: "critical" as const,
        assigneeAgentId: agentId,
        issueNumber: index + 5,
        identifier: `${issuePrefix}-${index + 5}`,
      })),
      {
        id: runnableCriticalIssueId,
        companyId,
        title: "Runnable critical beyond first lane page",
        status: "todo",
        priority: "critical",
        assigneeAgentId: agentId,
        issueNumber: 7,
        identifier: `${issuePrefix}-7`,
      },
    ]);
    await db.insert(issueRelations).values(blockedCriticalIssueIds.map((relatedIssueId) => ({
      companyId,
      issueId: blockerIssueId,
      relatedIssueId,
      type: "blocks" as const,
    })));

    const queuedIssues = [
      lowIssueId,
      ...blockedCriticalIssueIds,
      ...deferredCriticalIssueIds,
      runnableCriticalIssueId,
    ];
    for (const [index, issueId] of queuedIssues.entries()) {
      const runId = issueId === runnableCriticalIssueId ? runnableCriticalRunId : randomUUID();
      const wakeId = randomUUID();
      const createdAt = new Date(baseCreatedAt.getTime() + index);
      await db.insert(agentWakeupRequests).values({
        id: wakeId,
        companyId,
        agentId,
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: { issueId },
        status: "queued",
        runId,
        requestedAt: createdAt,
        updatedAt: createdAt,
      });
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "queued",
        wakeupRequestId: wakeId,
        contextSnapshot: {
          issueId,
          taskId: issueId,
          wakeReason: "issue_assigned",
          ...(deferredCriticalIssueIds.includes(issueId)
            ? { paperclipK8sIsolationRetryAt: new Date(Date.now() + 60 * 60_000).toISOString() }
            : {}),
        },
        createdAt,
        updatedAt: createdAt,
      });
    }

    const dispatchedRunIds: string[] = [];
    mockAdapterExecute.mockImplementation(async (args: { runId: string }) => {
      dispatchedRunIds.push(args.runId);
      if (args.runId === runnableCriticalRunId) {
        criticalResumePassesAtDispatch = criticalResumePasses;
      }
      return {
        exitCode: 0,
        signal: null as string | null,
        timedOut: false,
        errorMessage: null as string | null,
        resultJson: { exitCode: 0 },
        provider: "test",
        model: "test-model",
      };
    });

    const initialDispatch = boundedHeartbeat.resumeQueuedRuns();
    await coalescedContinuationObserved;
    releaseSchedulingPass();
    await initialDispatch;
    await waitForRunToSettle(boundedHeartbeat, runnableCriticalRunId, 60_000);

    expect(dispatchedRunIds[0]).toBe(runnableCriticalRunId);
    expect(criticalResumePassesAtDispatch).toBeLessThanOrEqual(2);
    expect((await boundedHeartbeat.getRun(runnableCriticalRunId))?.status).not.toBe("queued");
    expect(criticalContinuationSchedules.length).toBeGreaterThan(0);
    expect(criticalContinuationSchedules).toEqual(
      criticalContinuationSchedules.map(() => ({
        reason: "resume_critical_lane",
        suppressCriticalLaneHeadRescanDemand: true,
      })),
    );
    expect(criticalContinuationCoalesced).toContainEqual({
      reason: "resume_critical_lane",
      resumeContinuation: true,
      suppressCriticalLaneHeadRescanDemand: true,
    });
    await boundedHeartbeat.drainInFlightExecutions(60_000);
  }, 120_000);

  it("pages past invalid, blocked, and isolation-deferred recovery rows before ordinary work", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const blockerIssueId = randomUUID();
    const terminalIssueId = randomUUID();
    const blockedIssueId = randomUUID();
    const deferredIssueIds = [randomUUID(), randomUUID()];
    const recoveryIssueId = randomUUID();
    const ordinaryIssueId = randomUUID();
    const recoveryRunId = randomUUID();
    const ordinaryRunId = randomUUID();
    const issuePrefix = `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const baseCreatedAt = new Date(Date.now() - 5 * 60 * 1000);
    const boundedHeartbeat = heartbeatService(db, {
      penstockGate: allowPenstockGate,
      queuedRunDispatchBounds: { scanLimit: 2, maxScanBatches: 1, maxResumePasses: 5 },
    });

    await db.insert(companies).values({
      id: companyId,
      name: "RecoveryLanePagingCo",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "RecoveryLanePagingAgent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    await db.insert(issues).values([
      {
        id: blockerIssueId,
        companyId,
        title: "Unresolved blocker",
        status: "in_progress",
        priority: "high",
        assigneeAgentId: agentId,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
        startedAt: baseCreatedAt,
      },
      {
        id: terminalIssueId,
        companyId,
        title: "Terminal recovery target",
        status: "done",
        priority: "critical",
        assigneeAgentId: agentId,
        issueNumber: 2,
        identifier: `${issuePrefix}-2`,
      },
      {
        id: blockedIssueId,
        companyId,
        title: "Blocked recovery target",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
        issueNumber: 3,
        identifier: `${issuePrefix}-3`,
      },
      ...deferredIssueIds.map((id, index) => ({
        id,
        companyId,
        title: `Isolation-deferred recovery ${index + 1}`,
        status: "todo" as const,
        priority: "medium" as const,
        assigneeAgentId: agentId,
        issueNumber: index + 4,
        identifier: `${issuePrefix}-${index + 4}`,
      })),
      {
        id: recoveryIssueId,
        companyId,
        title: "Runnable recovery beyond invalid pages",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
        issueNumber: 6,
        identifier: `${issuePrefix}-6`,
      },
      {
        id: ordinaryIssueId,
        companyId,
        title: "Ordinary work visible to the main scan",
        status: "todo",
        priority: "low",
        assigneeAgentId: agentId,
        issueNumber: 7,
        identifier: `${issuePrefix}-7`,
      },
    ]);
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerIssueId,
      relatedIssueId: blockedIssueId,
      type: "blocks",
    });

    const recoveryIssueIds = [
      "persisted-not-a-uuid",
      randomUUID(),
      terminalIssueId,
      blockedIssueId,
      ...deferredIssueIds,
      recoveryIssueId,
    ];
    for (const [index, issueId] of recoveryIssueIds.entries()) {
      const runId = issueId === recoveryIssueId ? recoveryRunId : randomUUID();
      const wakeId = randomUUID();
      const recoveryActionId = randomUUID();
      const createdAt = new Date(baseCreatedAt.getTime() + index);
      await db.insert(agentWakeupRequests).values({
        id: wakeId,
        companyId,
        agentId,
        source: "assignment",
        triggerDetail: "system",
        reason: "source_scoped_recovery_action",
        payload: { issueId, recoveryActionId },
        status: "queued",
        runId,
        requestedAt: createdAt,
        updatedAt: createdAt,
      });
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "queued",
        wakeupRequestId: wakeId,
        contextSnapshot: {
          issueId,
          wakeReason: "source_scoped_recovery_action",
          source: "issue_recovery_action",
          recoveryActionId,
          ...(deferredIssueIds.includes(issueId)
            ? { paperclipK8sIsolationRetryAt: new Date(Date.now() + 60 * 60_000).toISOString() }
            : {}),
        },
        createdAt,
        updatedAt: createdAt,
      });
    }

    const ordinaryWakeId = randomUUID();
    const ordinaryCreatedAt = new Date(baseCreatedAt.getTime() - 1);
    await db.insert(agentWakeupRequests).values({
      id: ordinaryWakeId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId: ordinaryIssueId },
      status: "queued",
      runId: ordinaryRunId,
      requestedAt: ordinaryCreatedAt,
      updatedAt: ordinaryCreatedAt,
    });
    await db.insert(heartbeatRuns).values({
      id: ordinaryRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId: ordinaryWakeId,
      contextSnapshot: { issueId: ordinaryIssueId, wakeReason: "issue_assigned" },
      createdAt: ordinaryCreatedAt,
      updatedAt: ordinaryCreatedAt,
    });

    const dispatchedRunIds: string[] = [];
    mockAdapterExecute.mockImplementation(async (args: { runId: string }) => {
      dispatchedRunIds.push(args.runId);
      return {
        exitCode: 0,
        signal: null as string | null,
        timedOut: false,
        errorMessage: null as string | null,
        resultJson: { exitCode: 0 },
        provider: "test",
        model: "test-model",
      };
    });

    await boundedHeartbeat.resumeQueuedRuns();
    await waitForRunToSettle(boundedHeartbeat, recoveryRunId, 60_000);

    expect(dispatchedRunIds[0]).toBe(recoveryRunId);
    await boundedHeartbeat.drainInFlightExecutions(60_000);
  }, 120_000);

  it.each([
    { lane: "critical" },
    { lane: "recovery" },
  ] as const)(
    "resumes the $lane lane past an external slot claim refusal",
    async ({ lane }) => {
      const companyId = randomUUID();
      const agentId = randomUUID();
      const staleSlotRunId = randomUUID();
      const refusedIssueId = randomUUID();
      const olderEmergencyIssueId = randomUUID();
      const ordinaryIssueId = randomUUID();
      const deeperIssueId = randomUUID();
      const refusedRunId = randomUUID();
      const olderEmergencyRunId = randomUUID();
      const ordinaryRunId = randomUUID();
      const deeperRunId = randomUUID();
      const issuePrefix = `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
      const baseCreatedAt = new Date(Date.now() - 5 * 60 * 1000);
      let releasedStaleSlot = false;

      const boundedHeartbeat = heartbeatService(db, {
        penstockGate: allowPenstockGate,
        queuedRunDispatchBounds: { scanLimit: 4, maxScanBatches: 1, maxResumePasses: 5 },
        afterQueuedDispatchContinuationScheduledForTest: async (event) => {
          if (
            (event.reason !== "resume_critical_lane" && event.reason !== "resume_recovery_lane")
            || releasedStaleSlot
          ) return;
          releasedStaleSlot = true;
          await db
            .update(externalRuntimeReservations)
            .set({
              state: "released",
              releasedAt: new Date(),
              releaseReason: "test_slot_released",
              updatedAt: new Date(),
            })
            .where(eq(externalRuntimeReservations.runId, staleSlotRunId));
        },
      });

      await db.insert(companies).values({
        id: companyId,
        name: `ExternalSlot${lane}Co`,
        issuePrefix,
        requireBoardApprovalForNewAgents: false,
        defaultResponsibleUserId: "responsible-user",
      });
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: `ExternalSlot${lane}Agent`,
        role: "engineer",
        status: "idle",
        adapterType: "claude_k8s",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { enabled: true, wakeOnDemand: true, maxConcurrentRuns: 1 } },
        permissions: {},
      });

      await db.insert(issues).values([
        {
          id: refusedIssueId,
          companyId,
          title: `Slot-refused ${lane} work`,
          status: "in_progress",
          priority: "critical",
          assigneeAgentId: agentId,
          issueNumber: 1,
          identifier: `${issuePrefix}-1`,
        },
        {
          id: olderEmergencyIssueId,
          companyId,
          title: "Older lower-ranked critical work",
          status: "todo",
          priority: "critical",
          assigneeAgentId: agentId,
          issueNumber: 2,
          identifier: `${issuePrefix}-2`,
        },
        {
          id: ordinaryIssueId,
          companyId,
          title: "Ordinary work between emergency candidates",
          status: "todo",
          priority: "low",
          assigneeAgentId: agentId,
          issueNumber: 3,
          identifier: `${issuePrefix}-3`,
        },
        {
          id: deeperIssueId,
          companyId,
          title: `Deeper ${lane} work`,
          status: "todo",
          priority: lane === "critical" ? "critical" : "medium",
          assigneeAgentId: agentId,
          issueNumber: 4,
          identifier: `${issuePrefix}-4`,
        },
      ]);

      await db.insert(heartbeatRuns).values({
        id: staleSlotRunId,
        companyId,
        agentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "succeeded",
        contextSnapshot: {},
        startedAt: new Date(baseCreatedAt.getTime() - 60_000),
        finishedAt: new Date(baseCreatedAt.getTime() - 30_000),
        createdAt: new Date(baseCreatedAt.getTime() - 60_000),
        updatedAt: new Date(baseCreatedAt.getTime() - 30_000),
      });
      await db.insert(externalRuntimeReservations).values({
        companyId,
        agentId,
        runId: staleSlotRunId,
        slotId: 0,
        state: "launched",
        jobName: `paperclip-agent-${staleSlotRunId}`,
        jobUid: randomUUID(),
        isolationMode: "run",
        isolationKey: `run:${staleSlotRunId}`,
        isolationBoundAt: new Date(baseCreatedAt.getTime() - 60_000),
        reservedAt: new Date(baseCreatedAt.getTime() - 60_000),
        launchingAt: new Date(baseCreatedAt.getTime() - 60_000),
        launchedAt: new Date(baseCreatedAt.getTime() - 30_000),
        createdAt: new Date(baseCreatedAt.getTime() - 60_000),
        updatedAt: new Date(baseCreatedAt.getTime() - 30_000),
      });

      const queued = [
        { runId: olderEmergencyRunId, issueId: olderEmergencyIssueId, offset: 0, emergency: false },
        { runId: refusedRunId, issueId: refusedIssueId, offset: 1, emergency: true },
        { runId: ordinaryRunId, issueId: ordinaryIssueId, offset: 2, emergency: false },
        { runId: deeperRunId, issueId: deeperIssueId, offset: 3, emergency: true },
      ];
      for (const { runId, issueId, offset, emergency } of queued) {
        const wakeId = randomUUID();
        const recoveryActionId = randomUUID();
        const createdAt = new Date(baseCreatedAt.getTime() + offset);
        const isRecovery = lane === "recovery" && emergency;
        await db.insert(agentWakeupRequests).values({
          id: wakeId,
          companyId,
          agentId,
          source: "assignment",
          triggerDetail: "system",
          reason: isRecovery ? "source_scoped_recovery_action" : "issue_assigned",
          payload: isRecovery ? { issueId, recoveryActionId } : { issueId },
          status: "queued",
          runId,
          requestedAt: createdAt,
          updatedAt: createdAt,
        });
        await db.insert(heartbeatRuns).values({
          id: runId,
          companyId,
          agentId,
          invocationSource: "assignment",
          triggerDetail: "system",
          status: "queued",
          wakeupRequestId: wakeId,
          contextSnapshot: {
            issueId,
            wakeReason: isRecovery ? "source_scoped_recovery_action" : "issue_assigned",
            ...(isRecovery
              ? { source: "issue_recovery_action", recoveryActionId }
              : {}),
          },
          createdAt,
          updatedAt: createdAt,
        });
      }

      const dispatchedRunIds: string[] = [];
      mockAdapterExecute.mockImplementation(async (args: { runId: string }) => {
        dispatchedRunIds.push(args.runId);
        return {
          exitCode: 0,
          signal: null as string | null,
          timedOut: false,
          errorMessage: null as string | null,
          resultJson: { exitCode: 0 },
          provider: "test",
          model: "test-model",
        };
      });

      await boundedHeartbeat.resumeQueuedRuns();
      await waitForRunToSettle(boundedHeartbeat, olderEmergencyRunId, 60_000);
      await waitForRunToSettle(boundedHeartbeat, deeperRunId, 60_000);

      expect(releasedStaleSlot).toBe(true);
      expect(dispatchedRunIds[0]).toBe(olderEmergencyRunId);
      expect((await boundedHeartbeat.getRun(olderEmergencyRunId))?.status).not.toBe("queued");
      expect((await boundedHeartbeat.getRun(deeperRunId))?.status).not.toBe("queued");
      await boundedHeartbeat.drainInFlightExecutions(60_000);
    },
    180_000,
  );

  it("retries a lone emergency run after atomic admission refusal", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const wakeId = randomUUID();
    const staleSlotRunId = randomUUID();
    const issuePrefix = `L${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const scheduledReasons: string[] = [];
    let releasedSlot = false;
    const boundedHeartbeat = heartbeatService(db, {
      penstockGate: allowPenstockGate,
      queuedRunDispatchBounds: { scanLimit: 1, maxScanBatches: 1, maxResumePasses: 5 },
      onQueuedDispatchScheduledForTest: ({ reason }) => scheduledReasons.push(reason),
      beforeQueuedDispatchPassForTest: async ({ reason }) => {
        if (reason !== "retry_emergency_admission_refusal" || releasedSlot) return;
        releasedSlot = true;
        await db
          .update(externalRuntimeReservations)
          .set({ state: "released", releasedAt: new Date(), updatedAt: new Date() })
          .where(eq(externalRuntimeReservations.runId, staleSlotRunId));
      },
    });

    await db.insert(companies).values({
      id: companyId,
      name: "LoneAdmissionRetryCo",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "LoneAdmissionRetryAgent",
      role: "engineer",
      status: "idle",
      adapterType: "claude_k8s",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: true, wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Lone refused critical work",
      status: "todo",
      priority: "critical",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });
    await db.insert(heartbeatRuns).values({
      id: staleSlotRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "succeeded",
      contextSnapshot: {},
      startedAt: new Date(Date.now() - 60_000),
      finishedAt: new Date(Date.now() - 30_000),
    });
    await db.insert(externalRuntimeReservations).values({
      companyId,
      agentId,
      runId: staleSlotRunId,
      slotId: 0,
      state: "launched",
      jobName: `paperclip-agent-${staleSlotRunId}`,
      jobUid: randomUUID(),
      isolationMode: "run",
      isolationKey: `run:${staleSlotRunId}`,
      isolationBoundAt: new Date(Date.now() - 60_000),
      reservedAt: new Date(Date.now() - 60_000),
      launchingAt: new Date(Date.now() - 60_000),
      launchedAt: new Date(Date.now() - 30_000),
    });
    await db.insert(agentWakeupRequests).values({
      id: wakeId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      status: "queued",
      runId,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId: wakeId,
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
    });

    const dispatchedRunIds: string[] = [];
    mockAdapterExecute.mockImplementation(async (args: { runId: string }) => {
      dispatchedRunIds.push(args.runId);
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        resultJson: { exitCode: 0 },
        provider: "test",
        model: "test-model",
      };
    });

    await boundedHeartbeat.resumeQueuedRuns();
    await waitForRunToSettle(boundedHeartbeat, runId, 60_000);

    expect(releasedSlot).toBe(true);
    expect(scheduledReasons).toContain("retry_emergency_admission_refusal");
    expect(dispatchedRunIds).toContain(runId);
    await boundedHeartbeat.drainInFlightExecutions(60_000);
  }, 120_000);

  it("launches earlier claims when a later refusal status read fails", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const firstIssueId = randomUUID();
    const secondIssueId = randomUUID();
    const firstRunId = randomUUID();
    const secondRunId = randomUUID();
    const issuePrefix = `F${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    let injectedFailure = false;
    const boundedHeartbeat = heartbeatService(db, {
      penstockGate: allowPenstockGate,
      beforeQueuedDispatchRefusalStatusReadForTest: (run) => {
        if (run.id !== secondRunId || injectedFailure) return;
        injectedFailure = true;
        throw new Error("injected refusal status read failure");
      },
    });

    await db.insert(companies).values({
      id: companyId,
      name: "ClaimLaunchFailureCo",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "ClaimLaunchFailureAgent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: true, wakeOnDemand: true, maxConcurrentRuns: 2 } },
      permissions: {},
    });
    await db.insert(issues).values([
      {
        id: firstIssueId,
        companyId,
        title: "First claim",
        status: "in_progress",
        priority: "critical",
        assigneeAgentId: agentId,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
      },
      {
        id: secondIssueId,
        companyId,
        title: "Later refused claim",
        status: "todo",
        priority: "critical",
        assigneeAgentId: agentId,
        issueNumber: 2,
        identifier: `${issuePrefix}-2`,
      },
    ]);
    for (const [index, [runId, issueId]] of [[firstRunId, firstIssueId], [secondRunId, secondIssueId]].entries()) {
      const wakeId = randomUUID();
      const createdAt = new Date(Date.now() + index);
      await db.insert(agentWakeupRequests).values({
        id: wakeId,
        companyId,
        agentId,
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: { issueId },
        status: "queued",
        runId,
        requestedAt: createdAt,
        updatedAt: createdAt,
      });
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "queued",
        wakeupRequestId: wakeId,
        contextSnapshot: {
          issueId,
          wakeReason: "issue_assigned",
          ...(runId === secondRunId
            ? { paperclipK8sIsolationRetryAt: new Date(Date.now() + 60 * 60_000).toISOString() }
            : {}),
        },
        createdAt,
        updatedAt: createdAt,
      });
    }

    const dispatchedRunIds: string[] = [];
    mockAdapterExecute.mockImplementation(async (args: { runId: string }) => {
      dispatchedRunIds.push(args.runId);
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        resultJson: { exitCode: 0 },
        provider: "test",
        model: "test-model",
      };
    });

    await expect(boundedHeartbeat.resumeQueuedRuns()).rejects.toThrow(
      "injected refusal status read failure",
    );
    await waitForRunToSettle(boundedHeartbeat, firstRunId, 60_000);

    expect(injectedFailure).toBe(true);
    expect(dispatchedRunIds.filter((runId) => runId === firstRunId)).toEqual([firstRunId]);
    await boundedHeartbeat.drainInFlightExecutions(60_000);
  }, 120_000);

  it("advances emergency keysets past default-generated sub-millisecond timestamps", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const blockerIssueId = randomUUID();
    const blockedIssueId = randomUUID();
    const runnableIssueId = randomUUID();
    const blockedRunId = randomUUID();
    const runnableRunId = randomUUID();
    const blockedWakeId = randomUUID();
    const runnableWakeId = randomUUID();
    const issuePrefix = `U${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const cursorEvents: string[] = [];
    const boundedHeartbeat = heartbeatService(db, {
      penstockGate: allowPenstockGate,
      queuedRunDispatchBounds: { scanLimit: 1, maxScanBatches: 1, maxResumePasses: 5 },
      onQueuedDispatchScheduledForTest: ({ reason }) => cursorEvents.push(reason),
    });

    await db.insert(companies).values({
      id: companyId,
      name: "SubmillisecondCursorCo",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "SubmillisecondCursorAgent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    await db.insert(issues).values([
      {
        id: blockerIssueId,
        companyId,
        title: "Unresolved blocker",
        status: "in_progress",
        priority: "critical",
        assigneeAgentId: agentId,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
      },
      {
        id: blockedIssueId,
        companyId,
        title: "Blocked critical head",
        status: "todo",
        priority: "critical",
        assigneeAgentId: agentId,
        issueNumber: 2,
        identifier: `${issuePrefix}-2`,
      },
      {
        id: runnableIssueId,
        companyId,
        title: "Runnable critical tail",
        status: "todo",
        priority: "critical",
        assigneeAgentId: agentId,
        issueNumber: 3,
        identifier: `${issuePrefix}-3`,
      },
    ]);
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerIssueId,
      relatedIssueId: blockedIssueId,
      type: "blocks",
    });

    await db.insert(agentWakeupRequests).values({
      id: blockedWakeId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId: blockedIssueId },
      status: "queued",
      runId: blockedRunId,
    });
    await db.insert(heartbeatRuns).values({
      id: blockedRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId: blockedWakeId,
      contextSnapshot: { issueId: blockedIssueId, wakeReason: "issue_assigned" },
    });
    await new Promise((resolve) => setTimeout(resolve, 2));
    await db.insert(agentWakeupRequests).values({
      id: runnableWakeId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId: runnableIssueId },
      status: "queued",
      runId: runnableRunId,
    });
    await db.insert(heartbeatRuns).values({
      id: runnableRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId: runnableWakeId,
      contextSnapshot: { issueId: runnableIssueId, wakeReason: "issue_assigned" },
    });

    const timestampRows = await db.execute(sql<{ createdAtText: string }>`
      select created_at::text as "createdAtText"
      from ${heartbeatRuns}
      where id = ${blockedRunId}::uuid
    `);
    expect(timestampRows[0]?.createdAtText).toMatch(/\.\d{4,}/);

    await boundedHeartbeat.resumeQueuedRuns();
    const runnableRun = await waitForRunToSettle(boundedHeartbeat, runnableRunId, 60_000);

    expect(cursorEvents).toContain("resume_critical_lane");
    expect(runnableRun?.status).not.toBe("queued");
    await boundedHeartbeat.drainInFlightExecutions(60_000);
  }, 120_000);

  it("skips malformed persisted issue ids in UUID batch lookups", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const validIssueId = randomUUID();
    const malformedRunId = randomUUID();
    const validRunId = randomUUID();
    const issuePrefix = `M${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    let releaseValid = () => {};
    const validReleased = new Promise<void>((resolve) => {
      releaseValid = resolve;
    });

    await db.insert(companies).values({
      id: companyId,
      name: "MalformedIssueIdCo",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "MalformedIssueIdAgent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    await db.insert(issues).values({
      id: validIssueId,
      companyId,
      title: "Valid runnable issue",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      startedAt: new Date(),
    });
    await db.insert(heartbeatRuns).values([
      {
        id: malformedRunId,
        companyId,
        agentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "queued",
        contextSnapshot: { issueId: "persisted-not-a-uuid", wakeReason: "issue_assigned" },
        createdAt: new Date(Date.now() - 1_000),
        updatedAt: new Date(Date.now() - 1_000),
      },
      {
        id: validRunId,
        companyId,
        agentId,
        invocationSource: "heartbeat",
        triggerDetail: "timer",
        status: "queued",
        contextSnapshot: { issueId: validIssueId, wakeReason: "heartbeat_timer" },
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    const dispatchedRunIds: string[] = [];
    mockAdapterExecute.mockImplementation(async (args: { runId: string }) => {
      dispatchedRunIds.push(args.runId);
      if (args.runId === validRunId) await validReleased;
      return {
        exitCode: 0,
        signal: null as string | null,
        timedOut: false,
        errorMessage: null as string | null,
        resultJson: { exitCode: 0 },
        provider: "test",
        model: "test-model",
      };
    });

    try {
      await heartbeat.resumeQueuedRuns();
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline && !dispatchedRunIds.includes(validRunId)) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(dispatchedRunIds[0]).toBe(validRunId);
      expect((await heartbeat.getRun(validRunId))?.status).toBe("running");
      await db
        .update(heartbeatRuns)
        .set({ status: "cancelled", finishedAt: new Date(), updatedAt: new Date() })
        .where(eq(heartbeatRuns.id, malformedRunId));
    } finally {
      releaseValid();
      await heartbeat.drainInFlightExecutions(60_000);
    }
  }, 120_000);

  it("claims at most 15 available slots across concurrent dispatch attempts", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issuePrefix = `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    let releaseExecutions!: () => void;
    const executionGate = new Promise<void>((resolve) => {
      releaseExecutions = resolve;
    });
    const runIds = Array.from({ length: 20 }, () => randomUUID());
    const now = new Date();

    await db.insert(companies).values({
      id: companyId,
      name: "ConcurrentDispatchTestCo",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "ConcurrentDispatchTestAgent",
      role: "engineer",
      status: "idle",
      adapterType: "opencode_k8s",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 15,
          concurrencyEnabled: true,
        },
      },
      permissions: {},
    });
    await db.insert(heartbeatRuns).values(runIds.map((id, index) => ({
      id,
      companyId,
      agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "queued" as const,
      contextSnapshot: { wakeReason: "concurrency_regression" },
      createdAt: new Date(now.getTime() + index),
      updatedAt: now,
    })));

    mockAdapterExecute.mockImplementation(async () => {
      await executionGate;
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        resultJson: { exitCode: 0 },
        provider: "test",
        model: "test-model",
      };
    });

    try {
      await Promise.all(Array.from({ length: 20 }, () => heartbeat.resumeQueuedRuns()));

      const activeRuns = await db
        .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(inArray(heartbeatRuns.id, runIds));
      const activeReservations = await db
        .select({ runId: externalRuntimeReservations.runId })
        .from(externalRuntimeReservations)
        .where(and(
          inArray(externalRuntimeReservations.runId, runIds),
          isNull(externalRuntimeReservations.releasedAt),
        ));
      expect(activeRuns.filter((run) => run.status === "running")).toHaveLength(15);
      expect(activeRuns.filter((run) => run.status === "queued")).toHaveLength(5);
      expect(activeReservations).toHaveLength(15);
    } finally {
      releaseExecutions();
      await heartbeat.drainInFlightExecutions(10_000);
      await _settleDetachedAgentStartLockWorkForTesting();
      await heartbeat.drainInFlightExecutions(10_000);
    }
  });
});
