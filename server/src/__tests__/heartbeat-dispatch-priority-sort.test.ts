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
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { cleanupHeartbeatTestState } from "./helpers/cleanup-heartbeat-test-state.js";
import { heartbeatService } from "../services/heartbeat.js";
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

vi.mock("../services/k8s-job-liveness.ts", () => ({
  listLiveAgentJobRunIds: vi.fn(async () => null),
  listAgentJobRunStatuses: vi.fn(async () => null),
  readAgentJobRunStatusByName: vi.fn(async () => null),
  deleteAgentJobsForRun: vi.fn(async () => 1),
  hasActiveJobForAgent: vi.fn(async () => false),
}));

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
  timeoutMs = 3_000,
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
    });

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
    });

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
    });

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
});
