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
import { issueService } from "../services/issues.js";
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
    const blockerLockKey = `paperclip:issue-blockers:${companyId}:${issueId}`;

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
        status: "done",
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
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${blockerLockKey}, 0))`);
      await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, blockerIssueId)).for("update");
      await tx.update(issues).set({ status: "todo" }).where(eq(issues.id, blockerIssueId));
      blockerLockHeld();
      await releaseRelationWriterPromise;
      await issueService(db).update(issueId, { blockedByIssueIds: [blockerIssueId] }, tx);
    });

    await blockerLockHeldPromise;
    const resumePromise = heartbeat.resumeQueuedRuns();
    let claimWaitedForIssueLock = false;
    try {
      const lockWaitDeadline = Date.now() + 60_000;
      while (Date.now() < lockWaitDeadline) {
        const waitingRows = await db.execute(sql<{ waiting: boolean }>`
          select exists (
            select 1
            from pg_stat_activity
            where datname = current_database()
              and pid <> pg_backend_pid()
              and wait_event_type = 'Lock'
          ) as waiting
        `);
        if (Array.from(waitingRows)[0]?.waiting) {
          claimWaitedForIssueLock = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(claimWaitedForIssueLock).toBe(true);
    } finally {
      releaseRelationWriter();
    }

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

  it("waits for an in-flight blocker insertion before claiming issue execution", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const blockerIssueId = randomUUID();
    const issueId = randomUUID();
    const wakeId = randomUUID();
    const runId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const blockerLockKey = `paperclip:issue-blockers:${companyId}:${issueId}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Claim blocker insertion race",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "BlockerInsertionRaceAgent",
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
        title: "Uncommitted new blocker",
        status: "todo",
        priority: "high",
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
      },
      {
        id: issueId,
        companyId,
        title: "Assigned work awaiting blocker insertion",
        status: "todo",
        priority: "high",
        assigneeAgentId: agentId,
        issueNumber: 2,
        identifier: `${issuePrefix}-2`,
      },
    ]);
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
    let relationWriterReady!: () => void;
    const relationWriterReadyPromise = new Promise<void>((resolve) => {
      relationWriterReady = resolve;
    });
    const releaseRelationWriterPromise = new Promise<void>((resolve) => {
      releaseRelationWriter = resolve;
    });
    const relationWriter = db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${blockerLockKey}, 0))`);
      await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, blockerIssueId)).for("update");
      relationWriterReady();
      await releaseRelationWriterPromise;
      await issueService(db).update(issueId, { blockedByIssueIds: [blockerIssueId] }, tx);
    });

    await relationWriterReadyPromise;
    const resumePromise = heartbeat.resumeQueuedRuns();
    let claimWaitedForRelationWriter = false;
    try {
      const lockWaitDeadline = Date.now() + 60_000;
      while (Date.now() < lockWaitDeadline) {
        const waitingRows = await db.execute(sql<{ waiting: boolean }>`
          select exists (
            select 1
            from pg_stat_activity
            where datname = current_database()
              and pid <> pg_backend_pid()
              and wait_event_type = 'Lock'
          ) as waiting
        `);
        if (Array.from(waitingRows)[0]?.waiting) {
          claimWaitedForRelationWriter = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(claimWaitedForRelationWriter).toBe(true);
    } finally {
      releaseRelationWriter();
    }

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

  it("dispatches a non-critical run past the absolute starvation floor ahead of fresh critical work (BLO-21792)", async () => {
    // Regression for BLO-21792, and the deliberate inverse of the BLO-16554
    // case directly above. That test pins the ROUTINE floor: a 3h-starved
    // non-critical run escalates to rank 2 and must still yield to fresh
    // critical work (ranks 0-1).
    //
    // Rank 2 never beats rank 0/1, so on an agent with a SUSTAINED supply of
    // fresh critical work the routine escalation is necessary but not
    // sufficient — the aged run loses every tick, with no upper bound on the
    // wait. BLO-21116 measured that class stranded 5-16h in `queued`.
    //
    // Past STARVATION_ABSOLUTE_ESCALATION_MS (6h) a ready run of any priority
    // escalates to -1 and takes the slot first. Same three-row shape and the
    // same single effective slot as BLO-16554; only the starved run's age
    // changes (3h -> 7h), and with it the expected dispatch order.
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runningIssueId = randomUUID();
    const starvedIssueId = randomUUID();
    const freshIssueId = randomUUID();
    const issuePrefix = `X${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "AbsoluteStarvationFloorCo",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "SustainedCriticalPressureAgent",
      role: "engineer",
      status: "idle",
      adapterType: "claude_k8s",
      adapterConfig: {},
      // Same as BLO-16554: concurrencyEnabled omitted -> effective slots = 1,
      // so dispatch order is directly observable from the claim sequence.
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
        title: "Non-critical work starved past the absolute floor",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: agentId,
        issueNumber: 2,
        identifier: `${issuePrefix}-2`,
        startedAt: new Date(Date.now() - 7 * 60 * 60 * 1000),
      },
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
    // 7h > STARVATION_ABSOLUTE_ESCALATION_MS (6h). Deliberately NOT a recovery
    // wake (no recoveryActionId / issue_recovery_action source): the point is
    // that ordinary backlog work gets the bound, not just the fast-tracked
    // recovery lane.
    const starvedCreatedAt = new Date(Date.now() - 7 * 60 * 60 * 1000);
    const freshCreatedAt = new Date();

    await db.insert(heartbeatRuns).values([
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

    // The single effective slot is occupied, so nothing may dispatch yet.
    await heartbeat.resumeQueuedRuns();
    const stillQueued = await db
      .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(inArray(heartbeatRuns.id, [starvedRunId, freshRunId]));
    expect(stillQueued.every((row) => row.status === "queued")).toBe(true);
    expect(dispatchedRunIds).toHaveLength(0);

    await db
      .update(heartbeatRuns)
      .set({ status: "succeeded", finishedAt: new Date(), updatedAt: new Date() })
      .where(eq(heartbeatRuns.id, runningRunId));

    await heartbeat.resumeQueuedRuns();
    await waitForRunToSettle(heartbeat, starvedRunId);
    await waitForRunToSettle(heartbeat, freshRunId);

    // The inversion: past the absolute floor the starved run goes FIRST, ahead
    // of the fresh critical row that would win at any age below 6h.
    expect(dispatchedRunIds[0]).toBe(starvedRunId);
    // Critical work is delayed by one slot, never dropped.
    expect(dispatchedRunIds).toContain(freshRunId);
    expect(dispatchedRunIds.indexOf(freshRunId)).toBeGreaterThan(0);

    const settledRuns = await db
      .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(inArray(heartbeatRuns.id, [starvedRunId, freshRunId]));
    expect(settledRuns.every((row) => row.status !== "queued")).toBe(true);
  });

  it("keeps the absolute starvation floor ahead of fresh critical work across bounded scan windows (BLO-21792 review follow-up)", async () => {
    // The test above proves the floor holds INSIDE one candidate window. This
    // one proves it holds ACROSS windows, which is where the first cut of
    // BLO-21792 leaked.
    //
    // The rank is computed over the rows a pass scanned, but the pass then
    // stored its resume cursor at the END of that whole window. So when a
    // window held more absolute-floor rows than the agent had free slots, every
    // aged row the claim loop never reached ended up BEHIND the cursor, while
    // the critical lane — which restarts from its own head every pass — kept
    // merging in fresh rank-0 rows from beyond that cursor and dispatching
    // them. The skipped aged rows only came back when the forward scan
    // exhausted and triggered a head rescan, so under arrivals that keep it
    // non-exhausted the wait was unbounded again: the exact defect the floor
    // exists to cap.
    //
    // Geometry (scanLimit 2, one free slot, six queued rows):
    //
    //   window:  [ agedA (-1) , agedB (-1) ]   <- 2 aged rows, 1 slot
    //   beyond:  [ freshCritical (0) , filler x3 ]
    //
    // agedA takes the slot; agedB is never examined. The fillers are what make
    // this the non-exhausted case — without rows behind freshCritical the scan
    // would exhaust, clear the cursor, and mask the bug.
    //
    // Pre-fix dispatch order: agedA, freshCritical, ... , agedB.
    // Post-fix: agedA, agedB, freshCritical — global FIFO among aged rows, with
    // critical work delayed by a bounded number of slots rather than jumping
    // ahead of a row that has already waited past the absolute floor.
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issuePrefix = `A${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const agedAt = new Date(Date.now() - 7 * 60 * 60 * 1000);
    const freshAt = new Date();

    // scanLimit 2 + maxScanBatches 1 makes the first pass stop after exactly
    // two rows with the cursor set and the scan NOT exhausted.
    const boundedHeartbeat = heartbeatService(db, {
      penstockGate: allowPenstockGate,
      queuedRunDispatchBounds: { scanLimit: 2, maxScanBatches: 1, maxResumePasses: 8 },
    });

    try {
      await db.insert(companies).values({
        id: companyId,
        name: "AbsoluteFloorAcrossWindowsCo",
        issuePrefix,
        requireBoardApprovalForNewAgents: false,
        defaultResponsibleUserId: "responsible-user",
      });

      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "BoundedWindowAgent",
        role: "engineer",
        status: "idle",
        // codex_local is NOT external-lifecycle, so maxConcurrentRuns is used
        // verbatim: exactly one slot, making the claim order observable.
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
        permissions: {},
      });

      // Ordered by createdAt, which is the scan's keyset order.
      const rows = [
        { key: "agedA", priority: "medium", createdAt: agedAt },
        { key: "agedB", priority: "medium", createdAt: new Date(agedAt.getTime() + 1) },
        { key: "freshCritical", priority: "critical", createdAt: freshAt },
        { key: "filler1", priority: "low", createdAt: new Date(freshAt.getTime() + 1) },
        { key: "filler2", priority: "low", createdAt: new Date(freshAt.getTime() + 2) },
        { key: "filler3", priority: "low", createdAt: new Date(freshAt.getTime() + 3) },
      ].map((row, index) => ({
        ...row,
        issueId: randomUUID(),
        runId: randomUUID(),
        issueNumber: index + 1,
      }));
      const runIdByKey = new Map(rows.map((row) => [row.key, row.runId]));

      await db.insert(issues).values(rows.map((row) => ({
        id: row.issueId,
        companyId,
        title: `Queued ${row.key}`,
        status: "in_progress" as const,
        priority: row.priority,
        assigneeAgentId: agentId,
        issueNumber: row.issueNumber,
        identifier: `${issuePrefix}-${row.issueNumber}`,
        startedAt: row.createdAt,
      })));

      for (const row of rows) {
        const wakeId = randomUUID();
        await db.insert(agentWakeupRequests).values({
          id: wakeId,
          companyId,
          agentId,
          source: "assignment",
          triggerDetail: "system",
          reason: "issue_assigned",
          payload: { issueId: row.issueId },
          status: "queued",
          runId: row.runId,
          requestedAt: row.createdAt,
          updatedAt: row.createdAt,
        });
        await db.insert(heartbeatRuns).values({
          id: row.runId,
          companyId,
          agentId,
          invocationSource: "assignment",
          triggerDetail: "system",
          status: "queued",
          wakeupRequestId: wakeId,
          contextSnapshot: {
            issueId: row.issueId,
            taskId: row.issueId,
            wakeReason: "issue_assigned",
          },
          createdAt: row.createdAt,
          updatedAt: row.createdAt,
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

      // Each completion re-triggers dispatch, so one resumeQueuedRuns drains
      // the queue through as many bounded passes as it takes. Wait for the
      // three rows whose relative order is the assertion.
      await boundedHeartbeat.resumeQueuedRuns();
      const watched = ["agedA", "agedB", "freshCritical"].map((key) => runIdByKey.get(key)!);
      const deadline = Date.now() + 60_000;
      while (
        Date.now() < deadline
        && !watched.every((runId) => dispatchedRunIds.includes(runId))
      ) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await boundedHeartbeat.drainInFlightExecutions(60_000);

      const orderOf = (key: string) => dispatchedRunIds.indexOf(runIdByKey.get(key)!);
      // The oldest absolute-floor row still goes first, as within one window.
      expect(orderOf("agedA")).toBe(0);
      // The regression: the second aged row must NOT be overtaken by the fresh
      // critical row that the critical lane pulls in from beyond the cursor.
      expect(orderOf("agedB")).toBeGreaterThanOrEqual(0);
      expect(orderOf("freshCritical")).toBeGreaterThanOrEqual(0);
      expect(orderOf("agedB")).toBeLessThan(orderOf("freshCritical"));

      // Critical work is delayed by the two aged rows, never dropped.
      const settled = await db
        .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(inArray(heartbeatRuns.id, watched));
      expect(settled.every((row) => row.status !== "queued")).toBe(true);
    } finally {
      await boundedHeartbeat.drainInFlightExecutions(60_000);
    }
  }, 180_000);

  it("dispatches a row that crosses the absolute starvation floor AFTER the scan cursor passed it (BLO-21792 second review follow-up)", async () => {
    // The test above proves the floor holds for rows that were ALREADY absolute
    // when a pass ranked them. This one proves it holds for a row that becomes
    // absolute later, which is where the first follow-up's cursor rewind leaked.
    //
    // That rewind keyed on the rank a row already had. A ready row scanned at
    // 5h59m ranks 2, not ABSOLUTE_STARVATION_DISPATCH_RANK, so no rewind fired
    // and the pass stored its cursor past the row. A minute later the row
    // crossed the floor — but it now sat BEHIND the cursor, so no later pass
    // re-read it, re-ranked it, or dispatched it. The absolute-starvation lane
    // closes this by re-reading `createdAt <= now - 6h` from its own head every
    // pass, so crossing the floor is sufficient on its own and where the cursor
    // sits stops mattering.
    //
    // Geometry (scanLimit 2, one free slot, six queued rows):
    //
    //   window:  [ nearFloor (rank 2) , freshCriticalA (rank 0) ]
    //   beyond:  [ freshCriticalB (0) , filler x3 ]
    //
    // freshCriticalA takes the only slot; nearFloor is never examined and the
    // cursor advances past it. The adapter is then held open so no further pass
    // can run until the test has slept nearFloor across the six-hour boundary.
    //
    // Pre-fix: nearFloor is invisible to every later pass until the forward scan
    // runs off the end of the queue, so freshCriticalB overtakes it.
    // Post-fix: the next pass finds nearFloor at rank -1 and dispatches it
    // before freshCriticalB.
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issuePrefix = `X${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
    // Margin sized for insert + first-pass latency: nearFloor must still be
    // UNDER the floor when pass 1 ranks it, or the geometry under test never
    // forms. The precondition assertion below fails loudly if it is not.
    const CROSSING_MARGIN_MS = 8_000;
    const baseNow = Date.now();
    const nearFloorCreatedAt = new Date(baseNow - SIX_HOURS_MS + CROSSING_MARGIN_MS);
    const freshAt = new Date(baseNow);

    const boundedHeartbeat = heartbeatService(db, {
      penstockGate: allowPenstockGate,
      queuedRunDispatchBounds: { scanLimit: 2, maxScanBatches: 1, maxResumePasses: 8 },
    });

    try {
      await db.insert(companies).values({
        id: companyId,
        name: "AbsoluteFloorThresholdCrossingCo",
        issuePrefix,
        requireBoardApprovalForNewAgents: false,
        defaultResponsibleUserId: "responsible-user",
      });

      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "ThresholdCrossingAgent",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
        permissions: {},
      });

      const rows = [
        { key: "nearFloor", priority: "medium", createdAt: nearFloorCreatedAt },
        { key: "freshCriticalA", priority: "critical", createdAt: freshAt },
        { key: "freshCriticalB", priority: "critical", createdAt: new Date(baseNow + 1) },
        { key: "filler1", priority: "low", createdAt: new Date(baseNow + 2) },
        { key: "filler2", priority: "low", createdAt: new Date(baseNow + 3) },
        { key: "filler3", priority: "low", createdAt: new Date(baseNow + 4) },
      ].map((row, index) => ({
        ...row,
        issueId: randomUUID(),
        runId: randomUUID(),
        issueNumber: index + 1,
      }));
      const runIdByKey = new Map(rows.map((row) => [row.key, row.runId]));

      await db.insert(issues).values(rows.map((row) => ({
        id: row.issueId,
        companyId,
        title: `Queued ${row.key}`,
        status: "in_progress" as const,
        priority: row.priority,
        assigneeAgentId: agentId,
        issueNumber: row.issueNumber,
        identifier: `${issuePrefix}-${row.issueNumber}`,
        startedAt: row.createdAt,
      })));

      for (const row of rows) {
        const wakeId = randomUUID();
        await db.insert(agentWakeupRequests).values({
          id: wakeId,
          companyId,
          agentId,
          source: "assignment",
          triggerDetail: "system",
          reason: "issue_assigned",
          payload: { issueId: row.issueId },
          status: "queued",
          runId: row.runId,
          requestedAt: row.createdAt,
          updatedAt: row.createdAt,
        });
        await db.insert(heartbeatRuns).values({
          id: row.runId,
          companyId,
          agentId,
          invocationSource: "assignment",
          triggerDetail: "system",
          status: "queued",
          wakeupRequestId: wakeId,
          contextSnapshot: {
            issueId: row.issueId,
            taskId: row.issueId,
            wakeReason: "issue_assigned",
          },
          createdAt: row.createdAt,
          updatedAt: row.createdAt,
        });
      }

      const dispatchedRunIds: string[] = [];
      // Hold the FIRST dispatched run open. Completions are what re-trigger
      // dispatch, so this pins the queue at exactly one elapsed pass and lets
      // the test control what the clock reads when the second one runs.
      let releaseFirstRun: (() => void) | null = null;
      let announceFirstDispatch: (() => void) | null = null;
      const firstRunGate = new Promise<void>((resolve) => { releaseFirstRun = resolve; });
      const firstDispatch = new Promise<void>((resolve) => { announceFirstDispatch = resolve; });
      mockAdapterExecute.mockImplementation(async (args: { runId: string }) => {
        dispatchedRunIds.push(args.runId);
        if (dispatchedRunIds.length === 1) {
          announceFirstDispatch?.();
          await firstRunGate;
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

      await boundedHeartbeat.resumeQueuedRuns();
      await firstDispatch;

      // Precondition, not the assertion under test: pass 1 must have ranked
      // nearFloor at 2 and given the slot to critical work. If this fails the
      // row crossed the floor too early and the geometry never formed.
      expect(dispatchedRunIds[0]).toBe(runIdByKey.get("freshCriticalA"));

      // Cross the floor while nearFloor sits behind the stored resume cursor.
      // Absolute deadline rather than a fixed sleep, so however long pass 1
      // took, the row is unambiguously past six hours before the next pass.
      const crossedAt = nearFloorCreatedAt.getTime() + SIX_HOURS_MS + 500;
      while (Date.now() < crossedAt) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      releaseFirstRun?.();

      const watched = ["nearFloor", "freshCriticalB"].map((key) => runIdByKey.get(key)!);
      const deadline = Date.now() + 60_000;
      while (
        Date.now() < deadline
        && !watched.every((runId) => dispatchedRunIds.includes(runId))
      ) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await boundedHeartbeat.drainInFlightExecutions(60_000);

      const orderOf = (key: string) => dispatchedRunIds.indexOf(runIdByKey.get(key)!);
      expect(orderOf("nearFloor")).toBeGreaterThanOrEqual(0);
      expect(orderOf("freshCriticalB")).toBeGreaterThanOrEqual(0);
      // The regression: having crossed the floor behind the cursor, nearFloor
      // must still beat critical work the lanes pull in from beyond it.
      expect(orderOf("nearFloor")).toBeLessThan(orderOf("freshCriticalB"));

      const settled = await db
        .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(inArray(heartbeatRuns.id, watched));
      expect(settled.every((row) => row.status !== "queued")).toBe(true);
    } finally {
      await boundedHeartbeat.drainInFlightExecutions(60_000);
    }
  }, 180_000);

  it("dispatches an aged row that a dependency-blocked prefix masked in the absolute-starvation lane (BLO-21792 third review follow-up)", async () => {
    // The two tests above prove the absolute floor holds for rows the cursored
    // main scan can still reach. This one covers the lane's own blind spot.
    //
    // Lane C used to read a single oldest page and assume it would drain,
    // because blocked rows "are cancelled by the claim gate". They are not: the
    // claim loop breaks the moment it fills the last slot, and a
    // dependency-blocked row ranks 12+ — below fresh critical work — so under
    // sustained critical arrivals it is never examined and never drains. It
    // stays queued, keeps occupying the lane's only page, and masks every aged
    // row behind it. A ready aged row past the page boundary that is ALSO
    // behind the main resume cursor is then invisible to every code path, and
    // its wait is unbounded again.
    //
    // Geometry (scanLimit 2, one batch per pass, one free slot):
    //
    //   aged, blocked forever : blockedA, blockedB, blockedC
    //   aged, blocked -> ready: target        (unblocked only AFTER the main
    //                                          resume cursor has passed it)
    //   fresh critical        : a sustained supply, so slots never idle
    //
    // The main scan walks the aged prefix over the first passes while `target`
    // is still blocked, leaving it behind the resume cursor. Unblocking it then
    // makes it a six-hour-aged, dependency-ready row that only the lane can
    // reach. Pre-fix the lane re-reads [blockedA, blockedB] forever and
    // `target` never dispatches. Post-fix the lane pages past the blocked
    // prefix, and resets to its head on exhaustion, so it reaches `target`.
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issuePrefix = `Y${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const SEVEN_HOURS_MS = 7 * 60 * 60 * 1000;
    const baseNow = Date.now();

    const boundedHeartbeat = heartbeatService(db, {
      penstockGate: allowPenstockGate,
      queuedRunDispatchBounds: { scanLimit: 2, maxScanBatches: 1, maxResumePasses: 64 },
    });

    // Execution gate. Ally's review of this branch (PR #1022 comment
    // 5191176696, Important finding 2) showed phase 2 below was
    // timing-dependent: the mock resolved immediately, so a completion could
    // trigger further dispatch passes that drained the arrivals the loop had
    // just inserted before its next iteration ran. The forward scan could then
    // reach the end of the queued set, `scanExhausted` would latch, the resume
    // cursor would clear, and the MAIN scan would rediscover `target` via a
    // head rescan -- with Lane C never paging at all. The case could therefore
    // pass against pre-fix source, which makes it worthless as this issue's
    // verifying signal.
    //
    // Holding each execution open makes slot release explicit rather than
    // incidental, which is what removes the timing dependence. See phase 2.
    //
    // Declared OUTSIDE the try so the finally block can still release
    // everything; `const` in the try block is not in scope there.
    const heldExecutions = new Map<string, () => void>();
    let gateExecutions = false;
    const releaseOneExecution = () => {
      for (const [runId, release] of heldExecutions) {
        heldExecutions.delete(runId);
        release();
        return true;
      }
      return false;
    };
    const releaseAllExecutions = () => {
      // Unblock everything, so the finally-block drain can never hang.
      let released = releaseOneExecution();
      while (released) {
        released = releaseOneExecution();
      }
    };
    const waitForHeldExecution = async (timeoutMs = 10_000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline && heldExecutions.size === 0) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return heldExecutions.size > 0;
    };
    const countQueuedRuns = async () => {
      const queued = await db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(and(
          eq(heartbeatRuns.companyId, companyId),
          eq(heartbeatRuns.status, "queued"),
        ));
      return queued.length;
    };

    try {
      await db.insert(companies).values({
        id: companyId,
        name: "AbsoluteLaneMaskedPrefixCo",
        issuePrefix,
        requireBoardApprovalForNewAgents: false,
        defaultResponsibleUserId: "responsible-user",
      });

      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "MaskedPrefixAgent",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
        permissions: {},
      });

      // One open blocker issue backs every dependency-blocked row. Leaving it
      // open is what keeps those rows unclaimable; resolving it is how `target`
      // becomes ready mid-test.
      const blockerIssueId = randomUUID();
      const aged = (offsetMs: number) => new Date(baseNow - SEVEN_HOURS_MS + offsetMs);
      const rows = [
        { key: "blockedA", priority: "medium" as const, createdAt: aged(0), blocked: true },
        { key: "blockedB", priority: "medium" as const, createdAt: aged(1), blocked: true },
        { key: "blockedC", priority: "medium" as const, createdAt: aged(2), blocked: true },
        { key: "target", priority: "medium" as const, createdAt: aged(3), blocked: true },
        ...Array.from({ length: 12 }, (_, index) => ({
          key: `freshCritical${index}`,
          priority: "critical" as const,
          createdAt: new Date(baseNow + index),
          blocked: false,
        })),
      ].map((row, index) => ({
        ...row,
        issueId: randomUUID(),
        runId: randomUUID(),
        issueNumber: index + 2,
      }));
      const runIdByKey = new Map(rows.map((row) => [row.key, row.runId]));
      const targetRunId = runIdByKey.get("target")!;
      const targetIssueId = rows.find((row) => row.key === "target")!.issueId;
      // The aged prefix is ordered blockedA < blockedB < blockedC < target, so
      // a resume cursor strictly past this timestamp is proof the forward scan
      // walked beyond `target` rather than stalling on the prefix.
      const targetCreatedAt = rows.find((row) => row.key === "target")!.createdAt;
      let nextIssueNumber = rows.length + 2;

      await db.insert(issues).values([
        {
          id: blockerIssueId,
          companyId,
          title: "Blocker",
          status: "in_progress" as const,
          priority: "medium" as const,
          issueNumber: 1,
          identifier: `${issuePrefix}-1`,
          responsibleUserId: "responsible-user",
        },
        ...rows.map((row) => ({
          id: row.issueId,
          companyId,
          title: `Queued ${row.key}`,
          status: "in_progress" as const,
          priority: row.priority,
          assigneeAgentId: agentId,
          issueNumber: row.issueNumber,
          identifier: `${issuePrefix}-${row.issueNumber}`,
          startedAt: row.createdAt,
          responsibleUserId: "responsible-user",
        })),
      ]);

      await db.insert(issueRelations).values(
        rows.filter((row) => row.blocked).map((row) => ({
          companyId,
          issueId: blockerIssueId,
          relatedIssueId: row.issueId,
          type: "blocks" as const,
        })),
      );

      for (const row of rows) {
        const wakeId = randomUUID();
        await db.insert(agentWakeupRequests).values({
          id: wakeId,
          companyId,
          agentId,
          source: "assignment",
          triggerDetail: "system",
          reason: "issue_assigned",
          payload: { issueId: row.issueId },
          status: "queued",
          runId: row.runId,
          requestedAt: row.createdAt,
          updatedAt: row.createdAt,
        });
        await db.insert(heartbeatRuns).values({
          id: row.runId,
          companyId,
          agentId,
          invocationSource: "assignment",
          triggerDetail: "system",
          status: "queued",
          wakeupRequestId: wakeId,
          contextSnapshot: {
            issueId: row.issueId,
            taskId: row.issueId,
            wakeReason: "issue_assigned",
          },
          createdAt: row.createdAt,
          updatedAt: row.createdAt,
        });
      }

      const dispatchedRunIds: string[] = [];
      mockAdapterExecute.mockImplementation(async (args: { runId: string }) => {
        dispatchedRunIds.push(args.runId);
        if (gateExecutions) {
          await new Promise<void>((resolve) => {
            heldExecutions.set(args.runId, resolve);
          });
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

      // A fresh critical arrival, inserted mid-test. Two of these per pass is
      // what keeps the main forward scan permanently non-exhausted; see phase 2.
      const arriveFreshCritical = async () => {
        const issueId = randomUUID();
        const runId = randomUUID();
        const wakeId = randomUUID();
        const issueNumber = nextIssueNumber++;
        const createdAt = new Date(Date.now());
        await db.insert(issues).values({
          id: issueId,
          companyId,
          title: `Arrival ${issueNumber}`,
          status: "in_progress" as const,
          priority: "critical" as const,
          assigneeAgentId: agentId,
          issueNumber,
          identifier: `${issuePrefix}-${issueNumber}`,
          startedAt: createdAt,
          responsibleUserId: "responsible-user",
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
      };

      // Phase 1 — walk the main forward scan past the aged blocked prefix so
      // `target` ends up BEHIND the resume cursor, and keep it there.
      //
      // This phase used to run ungated, waiting only for three dispatches. That
      // was the same unsound shape Ally found in phase 2 (PR #1022 review at
      // f7aa2df7, Important finding 2): with the mock resolving immediately,
      // completion-triggered passes could keep dispatching through the finite
      // backlog between iterations. If the queued set drained to within the
      // forward scan's reach, `scanExhausted` latched, the resume cursor
      // cleared, and phase 2 then found `target` from a head rescan on the MAIN
      // scan -- with Lane C never paging. The case would pass against pre-fix
      // source, which makes it worthless as this issue's verifying signal.
      //
      // So phase 1 now uses the SAME gated 2-in/<=1-out protocol as phase 2:
      // two fresh criticals are inserted while the single slot is occupied and
      // held, then exactly one execution is released, so at most one row can be
      // consumed per iteration. Arrivals are stamped `now`, i.e. strictly after
      // the cursor, so the rows ahead of the cursor grow monotonically and the
      // bounded scan cannot reach its end. The geometry is established by
      // construction rather than by racing a completion.
      gateExecutions = true;
      await boundedHeartbeat.resumeQueuedRuns();
      expect(await waitForHeldExecution()).toBe(true);
      const phaseOneDeadline = Date.now() + 60_000;
      while (Date.now() < phaseOneDeadline && dispatchedRunIds.length < 3) {
        // (a) replacements land while the slot is still occupied
        await arriveFreshCritical();
        await arriveFreshCritical();
        // (b) free exactly one slot
        releaseOneExecution();
        // (c) let the freed slot be refilled, by our pass or a completion's
        await boundedHeartbeat.resumeQueuedRuns();
        await waitForHeldExecution(2_000);
      }
      // Precondition, not the assertion under test: the blocked rows must NOT
      // have dispatched. If one did, the fixture failed to block them and the
      // masking geometry never formed.
      expect(dispatchedRunIds).not.toContain(targetRunId);
      expect(dispatchedRunIds.length).toBeGreaterThanOrEqual(3);

      // The geometry itself, asserted rather than argued. Queue depth alone
      // cannot distinguish "deep queue" from "cursor still advanced past the
      // target", and only the latter is the condition under which this case's
      // question is well-posed. A null cursor means the forward scan exhausted
      // and the next pass rescans from the head -- which would rescue `target`
      // through the main scan and prove nothing about Lane C.
      const phaseOneCursor = boundedHeartbeat.__test_getDispatchResumeCursor(agentId);
      expect(phaseOneCursor).not.toBeNull();
      expect(new Date(phaseOneCursor!.createdAt).getTime())
        .toBeGreaterThan(targetCreatedAt.getTime());

      // Phase 2 — `target` becomes dependency-ready while sitting behind the
      // main cursor and behind the lane's first page. Only a lane that pages
      // past the blocked prefix can still see it.
      await db
        .delete(issueRelations)
        .where(and(
          eq(issueRelations.companyId, companyId),
          eq(issueRelations.relatedIssueId, targetIssueId),
        ));

      // SUSTAINED arrivals are load-bearing, not flavour. A pass consumes
      // `scanLimit` (2) rows of forward scan; if the queued set ever drains to
      // within that window, `scanExhausted` latches, the resume cursor clears,
      // and the head rescan rediscovers `target` through the MAIN scan -- which
      // makes the case pass against the unfixed source and proves nothing.
      //
      // An earlier version of this loop tried to arrange that by inserting two
      // rows per iteration and sleeping. That was not sound: with the mock
      // resolving immediately, completion-triggered passes could consume rows
      // between iterations, so the arrival rate was never actually guaranteed
      // to outrun the drain rate. Ally caught it; the fix is to stop relying on
      // rates at all, and phase 1 above now runs under the same protocol for
      // the same reason.
      //
      // Gated protocol -- one slot, one held execution, so the accounting is
      // exact rather than statistical:
      //
      //   a. two fresh criticals are inserted while the only slot is OCCUPIED
      //      and held, so no dispatch can consume them yet;
      //   b. exactly one execution is then released, freeing exactly one slot;
      //   c. whichever pass fills that slot -- ours below, or one triggered by
      //      the completion itself -- can dispatch at most one row, because
      //      maxConcurrentRuns is 1 and the new occupant is held too.
      //
      // Two rows in, at most one row out, per iteration. The queued set is
      // therefore monotonically non-decreasing by construction, independent of
      // any timing, so the bounded forward scan cannot reach its end. That is
      // the precondition the assertion below records.
      //
      // The gate is already on and a slot already held, carried over from phase
      // one -- deliberately, so there is no ungated window between the two
      // phases in which the queue could drain and clear the cursor this case
      // just asserted.
      expect(gateExecutions).toBe(true);
      expect(heldExecutions.size).toBeGreaterThan(0);

      let minQueuedDuringPhaseTwo = await countQueuedRuns();
      // The direct form of the same precondition: did the main forward scan
      // ever exhaust and clear its resume cursor while phase 2 was running? If
      // it did, a head rescan could have rediscovered `target` on the main scan
      // and the dispatch below would not implicate Lane C at all. Queue depth
      // is a proxy for this; the cursor is the thing itself.
      let mainCursorClearedDuringPhaseTwo = false;
      const sampleQueuedDepth = async () => {
        minQueuedDuringPhaseTwo = Math.min(minQueuedDuringPhaseTwo, await countQueuedRuns());
        if (!boundedHeartbeat.__test_getDispatchResumeCursor(agentId)) {
          mainCursorClearedDuringPhaseTwo = true;
        }
      };
      // 90s, not 120s. Phase 1 (60s) + phase 2 + the finally drain (60s) must
      // fit inside the `it` timeout with room to spare, or a REGRESSION fails
      // as an opaque "Test timed out" instead of reporting which assertion
      // broke -- which is exactly what the pre-fix run below did at the old
      // 60+120+60 = 240s budget. Measured post-fix the target dispatches within
      // seconds (~16s for the whole case locally), so this is pure headroom.
      const targetDeadline = Date.now() + 90_000;
      while (Date.now() < targetDeadline && !dispatchedRunIds.includes(targetRunId)) {
        // Sample at the TROUGH -- after the previous iteration's dispatch has
        // consumed a row and before this one's replacements land. Sampling
        // after the inserts would measure the peak and flatter the assertion.
        await sampleQueuedDepth();
        // (a) replacements land while the slot is still occupied
        await arriveFreshCritical();
        await arriveFreshCritical();
        // (b) free exactly one slot
        releaseOneExecution();
        // (c) let the freed slot be refilled, by our pass or a completion's
        await boundedHeartbeat.resumeQueuedRuns();
        await waitForHeldExecution(2_000);
        await sampleQueuedDepth();
      }
      // Capture the verdict BEFORE any teardown. This is load-bearing and was
      // measured, not reasoned: releasing the gates lets the queue drain
      // freely, and a drained queue is precisely the condition under which the
      // main forward scan exhausts, clears its cursor, and rescues `target` on
      // a head rescan -- with Lane C never paging. Asserting after the drain
      // therefore passes against PRE-FIX source (observed: pre-fix passed in
      // 215s once the `it` budget was raised enough to reach the assertion).
      // The sustained-pressure window is the only interval in which the
      // question this case exists to ask is even well-posed.
      const targetDispatchedUnderSustainedPressure = dispatchedRunIds.includes(targetRunId);

      releaseAllExecutions();
      gateExecutions = false;
      await boundedHeartbeat.drainInFlightExecutions(60_000);

      // The precondition, now asserted rather than assumed: the queued set
      // never fell within the forward scan's reach, so `target` cannot have
      // been rescued by a head rescan after exhaustion. Without this the
      // assertion below does not distinguish the lane from the main scan.
      expect(minQueuedDuringPhaseTwo).toBeGreaterThan(2);
      // ...and the direct form of it. Depth is circumstantial; a resume cursor
      // that survived every sample is the geometry itself.
      expect(mainCursorClearedDuringPhaseTwo).toBe(false);

      // The regression: masked behind a dependency-blocked page AND behind the
      // main resume cursor, the aged row must still be dispatched -- while the
      // pressure is still on.
      expect(targetDispatchedUnderSustainedPressure).toBe(true);

      // Secondary, and deliberately NOT the discriminating assertion: this runs
      // after the drain, where pre-fix source also settles the row. It only
      // guards against `target` being counted as dispatched while its run row
      // was left stuck in `queued`. Do not promote it to the regression check.
      const [settled] = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, targetRunId));
      expect(settled?.status).not.toBe("queued");
    } finally {
      releaseAllExecutions();
      await boundedHeartbeat.drainInFlightExecutions(60_000);
    }
    // 300s so the worst case -- phase 1 (60s) + phase 2 (90s) + drain (60s) --
    // still leaves headroom for the assertions to run and REPORT. At the old
    // 240s this case failed as "Test timed out" against pre-fix source, which
    // discriminates but says nothing about what broke.
  }, 300_000);

  it("dispatches an aged interaction wake whose issue is dependency-blocked, since the claim path accepts it, while a non-interaction blocked row still waits (BLO-21792 fourth review follow-up)", async () => {
    // Ally's review of PR #1022 at f7aa2df7 (Important finding 1): dispatch and
    // the claim path disagreed about what "dependency-blocked" disqualifies.
    //
    //   claimQueuedRun    : cancels a queued run whose issue has unresolved
    //                       blockers *unless* it is an issue-interaction wake
    //                       carrying a comment id — those are allowed to run,
    //                       so a human can talk to the assignee mid-block.
    //   dispatch (before) : ranked ANY blocked row at 12+, below every routine
    //                       row, and the starvation lanes paged past it as
    //                       "not ready".
    //
    // So an interaction wake the claim path would have run immediately was
    // ranked last and skipped by the lane. Under sustained critical arrivals
    // that is unbounded — the exact starvation shape the absolute floor exists
    // to cap, reappearing through a readiness definition rather than through
    // the aging formula. Both sides now read
    // `isEffectivelyDependencyReadyForDispatch`.
    //
    // The `blockedControl` row is what keeps this honest: it is aged and
    // blocked identically but its wake is a plain `issue_assigned`, which the
    // claim path WOULD cancel. It must still not dispatch. Without it, this
    // case would also pass if the fix had simply stopped honouring blockers.
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issuePrefix = `Z${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const SEVEN_HOURS_MS = 7 * 60 * 60 * 1000;
    const baseNow = Date.now();

    const boundedHeartbeat = heartbeatService(db, {
      penstockGate: allowPenstockGate,
      queuedRunDispatchBounds: { scanLimit: 2, maxScanBatches: 1, maxResumePasses: 64 },
    });

    // Same gated protocol as the case above: two arrivals in, at most one row
    // out per iteration, so the queued set cannot drain and the pressure the
    // question depends on is maintained by construction rather than by timing.
    const heldExecutions = new Map<string, () => void>();
    let gateExecutions = false;
    const releaseOneExecution = () => {
      for (const [runId, release] of heldExecutions) {
        heldExecutions.delete(runId);
        release();
        return true;
      }
      return false;
    };
    const releaseAllExecutions = () => {
      let released = releaseOneExecution();
      while (released) {
        released = releaseOneExecution();
      }
    };
    const waitForHeldExecution = async (timeoutMs = 10_000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline && heldExecutions.size === 0) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return heldExecutions.size > 0;
    };

    try {
      await db.insert(companies).values({
        id: companyId,
        name: "BlockedInteractionWakeCo",
        issuePrefix,
        requireBoardApprovalForNewAgents: false,
        defaultResponsibleUserId: "responsible-user",
      });

      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "BlockedInteractionWakeAgent",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
        permissions: {},
      });

      const blockerIssueId = randomUUID();
      const aged = (offsetMs: number) => new Date(baseNow - SEVEN_HOURS_MS + offsetMs);
      const rows = [
        // Aged, blocked, and an interaction wake: claimable, so dispatch must
        // treat it as runnable.
        {
          key: "interactionWake",
          priority: "medium" as const,
          createdAt: aged(0),
          blocked: true,
          wakeReason: "issue_commented",
          wakeCommentId: randomUUID(),
        },
        // Aged, blocked, NOT an interaction wake: the claim path would cancel
        // it, so dispatch must keep ranking it last.
        {
          key: "blockedControl",
          priority: "medium" as const,
          createdAt: aged(1),
          blocked: true,
          wakeReason: "issue_assigned",
          wakeCommentId: null as string | null,
        },
        ...Array.from({ length: 12 }, (_, index) => ({
          key: `freshCritical${index}`,
          priority: "critical" as const,
          createdAt: new Date(baseNow + index),
          blocked: false,
          wakeReason: "issue_assigned",
          wakeCommentId: null as string | null,
        })),
      ].map((row, index) => ({
        ...row,
        issueId: randomUUID(),
        runId: randomUUID(),
        issueNumber: index + 2,
      }));
      const runIdByKey = new Map(rows.map((row) => [row.key, row.runId]));
      const interactionRunId = runIdByKey.get("interactionWake")!;
      const controlRunId = runIdByKey.get("blockedControl")!;
      let nextIssueNumber = rows.length + 2;

      await db.insert(issues).values([
        {
          id: blockerIssueId,
          companyId,
          title: "Blocker",
          status: "in_progress" as const,
          priority: "medium" as const,
          issueNumber: 1,
          identifier: `${issuePrefix}-1`,
          responsibleUserId: "responsible-user",
        },
        ...rows.map((row) => ({
          id: row.issueId,
          companyId,
          title: `Queued ${row.key}`,
          status: "in_progress" as const,
          priority: row.priority,
          assigneeAgentId: agentId,
          issueNumber: row.issueNumber,
          identifier: `${issuePrefix}-${row.issueNumber}`,
          startedAt: row.createdAt,
          responsibleUserId: "responsible-user",
        })),
      ]);

      // The blocker stays OPEN for the whole case. Nothing here ever becomes
      // dependency-ready in the raw sense; the interaction wake dispatches
      // because it is *effectively* claimable, which is the whole point.
      await db.insert(issueRelations).values(
        rows.filter((row) => row.blocked).map((row) => ({
          companyId,
          issueId: blockerIssueId,
          relatedIssueId: row.issueId,
          type: "blocks" as const,
        })),
      );

      for (const row of rows) {
        const wakeId = randomUUID();
        await db.insert(agentWakeupRequests).values({
          id: wakeId,
          companyId,
          agentId,
          source: "assignment",
          triggerDetail: "system",
          reason: row.wakeReason,
          payload: { issueId: row.issueId },
          status: "queued",
          runId: row.runId,
          requestedAt: row.createdAt,
          updatedAt: row.createdAt,
        });
        await db.insert(heartbeatRuns).values({
          id: row.runId,
          companyId,
          agentId,
          invocationSource: "assignment",
          triggerDetail: "system",
          status: "queued",
          wakeupRequestId: wakeId,
          contextSnapshot: {
            issueId: row.issueId,
            taskId: row.issueId,
            wakeReason: row.wakeReason,
            ...(row.wakeCommentId ? { wakeCommentId: row.wakeCommentId } : {}),
          },
          createdAt: row.createdAt,
          updatedAt: row.createdAt,
        });
      }

      const dispatchedRunIds: string[] = [];
      mockAdapterExecute.mockImplementation(async (args: { runId: string }) => {
        dispatchedRunIds.push(args.runId);
        if (gateExecutions) {
          await new Promise<void>((resolve) => {
            heldExecutions.set(args.runId, resolve);
          });
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

      const arriveFreshCritical = async () => {
        const issueId = randomUUID();
        const runId = randomUUID();
        const wakeId = randomUUID();
        const issueNumber = nextIssueNumber++;
        const createdAt = new Date(Date.now());
        await db.insert(issues).values({
          id: issueId,
          companyId,
          title: `Arrival ${issueNumber}`,
          status: "in_progress" as const,
          priority: "critical" as const,
          assigneeAgentId: agentId,
          issueNumber,
          identifier: `${issuePrefix}-${issueNumber}`,
          startedAt: createdAt,
          responsibleUserId: "responsible-user",
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
      };

      gateExecutions = true;
      await boundedHeartbeat.resumeQueuedRuns();
      expect(await waitForHeldExecution()).toBe(true);

      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline && !dispatchedRunIds.includes(interactionRunId)) {
        await arriveFreshCritical();
        await arriveFreshCritical();
        releaseOneExecution();
        await boundedHeartbeat.resumeQueuedRuns();
        await waitForHeldExecution(2_000);
      }
      // Read both verdicts BEFORE teardown, for the same reason the case above
      // does: releasing the gates drains the queue, and a drained queue is
      // exactly the condition under which pre-fix source also gets around to
      // the aged rows. The sustained-pressure window is the only interval in
      // which this question is well-posed.
      const interactionDispatchedUnderPressure = dispatchedRunIds.includes(interactionRunId);
      const controlDispatchedUnderPressure = dispatchedRunIds.includes(controlRunId);

      releaseAllExecutions();
      gateExecutions = false;
      await boundedHeartbeat.drainInFlightExecutions(60_000);

      // The regression. Pre-fix this row ranks 12+ behind an endless supply of
      // fresh critical arrivals and never dispatches.
      expect(interactionDispatchedUnderPressure).toBe(true);
      // The guard against over-correcting: a genuinely unclaimable blocked row
      // must still lose. If this ever flips, the exemption has widened from
      // "interaction wakes" to "blocked rows", and the claim path would cancel
      // whatever dispatch just started.
      expect(controlDispatchedUnderPressure).toBe(false);
    } finally {
      releaseAllExecutions();
      await boundedHeartbeat.drainInFlightExecutions(60_000);
    }
  }, 300_000);

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

  it("advances the recovery lane through fully deferred admission-refusal pages", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const staleSlotRunId = randomUUID();
    const issuePrefix = `D${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const baseCreatedAt = new Date(Date.now() - 5 * 60 * 1000);
    const recoveryRunIds = Array.from({ length: 5 }, () => randomUUID());
    const recoveryIssueIds = Array.from({ length: recoveryRunIds.length }, () => randomUUID());
    let recoveryContinuationSchedules = 0;
    let refusalStatusReads = 0;
    let releasedStaleSlot = false;
    let sawFullyDeferredRecoveryPage = false;

    const boundedHeartbeat = heartbeatService(db, {
      penstockGate: allowPenstockGate,
      queuedRunDispatchBounds: { scanLimit: 2, maxScanBatches: 1, maxResumePasses: 12 },
      beforeQueuedDispatchRefusalStatusReadForTest: async () => {
        refusalStatusReads += 1;
      },
      afterQueuedDispatchContinuationScheduledForTest: async (event) => {
        if (event.reason !== "resume_recovery_lane" || releasedStaleSlot) return;
        recoveryContinuationSchedules += 1;
        if (recoveryContinuationSchedules <= refusalStatusReads) return;
        sawFullyDeferredRecoveryPage = true;
        releasedStaleSlot = true;
        await db
          .update(externalRuntimeReservations)
          .set({
            state: "released",
            releasedAt: new Date(),
            releaseReason: "test_slot_released_after_deferred_page",
            updatedAt: new Date(),
          })
          .where(eq(externalRuntimeReservations.runId, staleSlotRunId));
      },
    });

    await db.insert(companies).values({
      id: companyId,
      name: "RecoveryLaneDeferredPagesCo",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "RecoveryLaneDeferredPagesAgent",
      role: "engineer",
      status: "idle",
      adapterType: "claude_k8s",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: true, wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    await db.insert(issues).values(
      recoveryIssueIds.map((issueId, index) => ({
        id: issueId,
        companyId,
        title: `Recovery lane candidate ${index + 1}`,
        status: "todo" as const,
        priority: "medium" as const,
        assigneeAgentId: agentId,
        issueNumber: index + 1,
        identifier: `${issuePrefix}-${index + 1}`,
      })),
    );

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

    for (const [index, runId] of recoveryRunIds.entries()) {
      const wakeId = randomUUID();
      const recoveryActionId = randomUUID();
      const issueId = recoveryIssueIds[index]!;
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
    await waitForRunToSettle(boundedHeartbeat, recoveryRunIds[2]!, 60_000);

    expect(sawFullyDeferredRecoveryPage).toBe(true);
    expect(releasedStaleSlot).toBe(true);
    expect(refusalStatusReads).toBe(2);
    // The first successful dispatch must come from beyond the fully deferred
    // page. Earlier refused work may settle asynchronously after that point.
    expect(dispatchedRunIds).toContain(recoveryRunIds[2]);
    expect(dispatchedRunIds[0]).toBe(recoveryRunIds[2]);
    await boundedHeartbeat.drainInFlightExecutions(60_000);
  }, 180_000);

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
