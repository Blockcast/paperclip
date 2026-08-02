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
 * not hold a dispatch slot hostage. A run is stale when its most-recent signal
 * (lastUsefulActionAt > lastOutputAt > startedAt) is older than
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
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
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
import { issueService } from "../services/issues.js";
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

  it("claims an assigned todo issue through auto-checkout (BLO-20088 regression)", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const wakeId = randomUUID();
    const runId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "TestCo",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });

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

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Assigned todo work",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
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

    let releaseAdapter: (() => void) | null = null;
    const adapterStarted = new Promise<void>((resolve) => {
      mockAdapterExecute.mockImplementationOnce(async () => {
        resolve();
        await new Promise<void>((release) => {
          releaseAdapter = release;
        });
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
    });

    const resumePromise = heartbeat.resumeQueuedRuns();
    try {
      await adapterStarted;

      const lockedIssue = await db
        .select({
          status: issues.status,
          executionRunId: issues.executionRunId,
        })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null);

      expect(lockedIssue).toEqual({
        status: "in_progress",
        executionRunId: runId,
      });
    } finally {
      releaseAdapter?.();
      await resumePromise;
      await heartbeat.drainInFlightExecutions(10_000);
    }
  });

  it("does not claim an assigned todo issue when a blocker is added while claim waits", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = "00000000-0000-4000-8000-000000000001";
    const blockerIssueId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    const wakeId = randomUUID();
    const runId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Claim blocker race",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "BlockedClaimAgent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    await db.insert(issues).values([
      {
        id: issueId,
        companyId,
        title: "Assigned work gains blocker",
        status: "todo",
        priority: "high",
        assigneeAgentId: agentId,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
      },
      {
        id: blockerIssueId,
        companyId,
        title: "Late blocker",
        status: "done",
        priority: "high",
        issueNumber: 2,
        identifier: `${issuePrefix}-2`,
      },
    ]);
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerIssueId,
      relatedIssueId: issueId,
      type: "blocks",
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

    let releaseIssueLock!: () => void;
    let issueLockHeld!: () => void;
    const issueLockHeldPromise = new Promise<void>((resolve) => { issueLockHeld = resolve; });
    const releaseIssueLockPromise = new Promise<void>((resolve) => { releaseIssueLock = resolve; });
    const lockTransaction = db.transaction(async (tx) => {
      await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, issueId)).for("update");
      issueLockHeld();
      await releaseIssueLockPromise;
    });

    await issueLockHeldPromise;
    const resumePromise = heartbeat.resumeQueuedRuns();
    let runReachedRunning = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const status = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0]?.status);
      if (status === "running") {
        runReachedRunning = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(runReachedRunning).toBe(true);

    await db.update(issues).set({ status: "todo" }).where(eq(issues.id, blockerIssueId));
    releaseIssueLock();
    await lockTransaction;
    await resumePromise;

    const [run, issue] = await Promise.all([
      db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null),
      db.select({ status: issues.status, executionRunId: issues.executionRunId }).from(issues)
        .where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null),
    ]);
    expect(run?.status).toBe("cancelled");
    expect(issue).toEqual({ status: "todo", executionRunId: null });
    expect(mockAdapterExecute.mock.calls.some(([input]) => input.runId === runId)).toBe(false);
  });

  it("does not deadlock claim against blocker relation replacement in reverse UUID order", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const blockerIssueId = "00000000-0000-4000-8000-000000000001";
    const issueId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    const wakeId = randomUUID();
    const runId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Claim relation lock order",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "RelationRaceAgent",
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
        title: "Pre-existing blocker",
        status: "todo",
        priority: "high",
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
      },
      {
        id: issueId,
        companyId,
        title: "Assigned work with relation race",
        status: "todo",
        priority: "high",
        assigneeAgentId: agentId,
        issueNumber: 2,
        identifier: `${issuePrefix}-2`,
      },
    ]);
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerIssueId,
      relatedIssueId: issueId,
      type: "blocks",
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

    let releaseRelationWriter!: () => void;
    let blockerLockHeld!: () => void;
    const blockerLockHeldPromise = new Promise<void>((resolve) => {
      blockerLockHeld = resolve;
    });
    const releaseRelationWriterPromise = new Promise<void>((resolve) => {
      releaseRelationWriter = resolve;
    });
    const relationWriter = db.transaction(async (tx) => {
      await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, blockerIssueId)).for("update");
      blockerLockHeld();
      await releaseRelationWriterPromise;
      await issueService(db).update(issueId, { blockedByIssueIds: [blockerIssueId] }, tx);
    });

    await blockerLockHeldPromise;
    const resumePromise = heartbeat.resumeQueuedRuns();
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const status = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0]?.status);
      if (status === "running") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    releaseRelationWriter();

    await expect(relationWriter).resolves.toBeUndefined();
    await expect(resumePromise).resolves.toBeUndefined();
    const [run, issue] = await Promise.all([
      db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null),
      db.select({ executionRunId: issues.executionRunId }).from(issues).where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null),
    ]);
    expect(run?.status).toBe("cancelled");
    expect(issue?.executionRunId).toBeNull();
    expect(mockAdapterExecute.mock.calls.some(([input]) => input.runId === runId)).toBe(false);
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
});
