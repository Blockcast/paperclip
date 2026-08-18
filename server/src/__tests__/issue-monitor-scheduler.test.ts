import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PROVIDER_QUOTA_MONITOR_SERVICE_NAME } from "@paperclipai/shared";
import {
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  companies,
  companySkills,
  createDb,
  documentRevisions,
  documents,
  environmentLeases,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issues,
  workspaceOperations,
  workspaceRuntimeServices,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService, ISSUE_MONITOR_DISPATCH_LAPSE_MS } from "../services/heartbeat.js";
import {
  DEFAULT_ISSUE_MONITOR_MAX_ATTEMPTS,
  normalizeIssueExecutionPolicy,
  parseIssueExecutionState,
} from "../services/issue-execution-policy.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue monitor scheduler tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue monitor scheduler", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const seededAgentIds = new Set<string>();
  const heartbeatServices = new Set<ReturnType<typeof heartbeatService>>();
  const createHeartbeat = () => {
    const service = heartbeatService(db);
    heartbeatServices.add(service);
    return service;
  };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-monitor-");
    db = createDb(tempDb.connectionString);
  });

  async function waitForHeartbeatIdle(timeoutMs = 3_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const active = await db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(sql`${heartbeatRuns.status} in ('queued', 'running', 'scheduled_retry')`);
      if (active.length === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("Timed out waiting for issue monitor heartbeat runs to settle");
  }

  async function heartbeatSideEffectFingerprint() {
    const [active, events, activity, leases, runtimeServices] = await Promise.all([
      db
        .select({ count: sql<number>`count(*)` })
        .from(heartbeatRuns)
        .where(sql`${heartbeatRuns.status} in ('queued', 'running', 'scheduled_retry')`),
      db.select({ count: sql<number>`count(*)` }).from(heartbeatRunEvents),
      db.select({ count: sql<number>`count(*)` }).from(activityLog),
      db.select({ count: sql<number>`count(*)` }).from(environmentLeases),
      db.select({ count: sql<number>`count(*)` }).from(workspaceRuntimeServices),
    ]);

    return [
      active[0]?.count ?? 0,
      events[0]?.count ?? 0,
      activity[0]?.count ?? 0,
      leases[0]?.count ?? 0,
      runtimeServices[0]?.count ?? 0,
    ].join(":");
  }

  async function waitForHeartbeatSideEffectsSettled(timeoutMs = 5_000, quietMs = 500) {
    const deadline = Date.now() + timeoutMs;
    let previous = "";
    let stableSince = Date.now();
    while (Date.now() < deadline) {
      const current = await heartbeatSideEffectFingerprint();
      const activeCount = Number(current.split(":")[0] ?? 0);
      if (current !== previous || activeCount > 0) {
        previous = current;
        stableSince = Date.now();
      } else if (Date.now() - stableSince >= quietMs) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("Timed out waiting for issue monitor heartbeat side effects to settle");
  }

  async function cleanupRows() {
    await waitForHeartbeatSideEffectsSettled();
    await db.delete(heartbeatRunEvents);
    await db.delete(issueComments);
    await db.delete(documentRevisions);
    await db.delete(issueDocuments);
    await db.delete(documents);
    await db.delete(activityLog);
    await db.delete(environmentLeases);
    await db.delete(workspaceRuntimeServices);
    await db.delete(workspaceOperations);
    await db.delete(executionWorkspaces);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(companies);
  }

  afterEach(async () => {
    const servicesToDrain = [...heartbeatServices];
    try {
      await Promise.all(servicesToDrain.map((service) => service.drainInFlightExecutions(60_000)));
    } finally {
      heartbeatServices.clear();
    }
    seededAgentIds.clear();
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await cleanupRows();
        return;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    throw lastError;
  }, 120_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedFixture(input?: {
    agentStatus?: "active" | "paused";
    issueStatus?: "in_progress" | "in_review";
    monitorAttemptCount?: number;
    monitor?: Record<string, unknown>;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const nextCheckAt = new Date("2026-04-11T12:30:00.000Z");
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    const monitorAttemptCount = input?.monitorAttemptCount ?? 0;
    const monitor: Record<string, unknown> = {
      nextCheckAt: nextCheckAt.toISOString(),
      notes: "Check deploy",
      scheduledBy: "assignee",
      ...(input?.monitor ?? {}),
    };

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
      name: "Monitor Bot",
      role: "engineer",
      status: input?.agentStatus ?? "active",
      adapterType: "process",
      adapterConfig: {
        command: process.execPath,
        args: ["-e", ""],
        cwd: process.cwd(),
      },
      runtimeConfig: {
        heartbeat: {
          enabled: false,
          wakeOnDemand: true,
        },
      },
      permissions: {},
    });
    seededAgentIds.add(agentId);

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Watch external deploy",
      status: input?.issueStatus ?? "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [],
        monitor,
      },
      executionState: {
        status: "idle",
        currentStageId: null,
        currentStageIndex: null,
        currentStageType: null,
        currentParticipant: null,
        returnAssignee: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
        monitor: {
          status: "scheduled",
          nextCheckAt: nextCheckAt.toISOString(),
          lastTriggeredAt: null,
          attemptCount: monitorAttemptCount,
          notes: "Check deploy",
          scheduledBy: "assignee",
          serviceName: typeof monitor.serviceName === "string" ? monitor.serviceName : null,
          externalRef: typeof monitor.externalRef === "string" ? monitor.externalRef : null,
          timeoutAt: typeof monitor.timeoutAt === "string" ? monitor.timeoutAt : null,
          maxAttempts: typeof monitor.maxAttempts === "number" ? monitor.maxAttempts : null,
          recoveryPolicy: typeof monitor.recoveryPolicy === "string" ? monitor.recoveryPolicy : null,
          clearedAt: null,
          clearReason: null,
        },
      },
      monitorNextCheckAt: nextCheckAt,
      monitorAttemptCount,
      monitorNotes: "Check deploy",
      monitorScheduledBy: "assignee",
    });

    return { companyId, agentId, issueId, nextCheckAt };
  }

  // BLO-25865: seeds the exact live state observed on BLO-21020/BLO-22798 — a
  // monitor that already fired (status "triggered", monitorNextCheckAt null,
  // executionPolicy.monitor already stripped per buildIssueMonitorTriggeredPatch)
  // whose woken run never called back to re-arm or clear it, so its `timeoutAt`
  // sails past with nothing scheduled to notice.
  async function seedExpiredTriggeredFixture(input?: {
    agentStatus?: "active" | "paused";
    issueStatus?: "in_progress" | "in_review";
    attemptCount?: number;
    monitorStateOverrides?: Record<string, unknown>;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const lastTriggeredAt = new Date("2026-04-10T00:00:00.000Z");
    const timeoutAt = new Date("2026-04-11T00:00:00.000Z");
    const attemptCount = input?.attemptCount ?? 3;

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
      name: "Monitor Bot",
      role: "engineer",
      status: input?.agentStatus ?? "active",
      adapterType: "process",
      adapterConfig: {
        command: process.execPath,
        args: ["-e", ""],
        cwd: process.cwd(),
      },
      runtimeConfig: {
        heartbeat: {
          enabled: false,
          wakeOnDemand: true,
        },
      },
      permissions: {},
    });
    seededAgentIds.add(agentId);

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Watch external deploy",
      status: input?.issueStatus ?? "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      executionPolicy: null,
      executionState: {
        status: "idle",
        currentStageId: null,
        currentStageIndex: null,
        currentStageType: null,
        currentParticipant: null,
        returnAssignee: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
        monitor: {
          status: "triggered",
          nextCheckAt: null,
          lastTriggeredAt: lastTriggeredAt.toISOString(),
          attemptCount,
          notes: "Check deploy",
          scheduledBy: "assignee",
          serviceName: "Deploy provider",
          externalRef: null,
          timeoutAt: timeoutAt.toISOString(),
          maxAttempts: null,
          recoveryPolicy: "wake_owner",
          clearedAt: null,
          clearReason: null,
          ...(input?.monitorStateOverrides ?? {}),
        },
      },
      monitorNextCheckAt: null,
      monitorWakeRequestedAt: null,
      monitorLastTriggeredAt: lastTriggeredAt,
      monitorAttemptCount: attemptCount,
      monitorNotes: "Check deploy",
      monitorScheduledBy: "assignee",
    });

    return { companyId, agentId, issueId, timeoutAt, lastTriggeredAt };
  }

  it("triggers due issue monitors once and clears the one-shot schedule", async () => {
    const { issueId, agentId } = await seedFixture();
    const heartbeat = createHeartbeat();
    const tickAt = new Date("2026-04-11T12:31:00.000Z");

    const result = await heartbeat.tickTimers(tickAt);

    expect(result.enqueued).toBe(1);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    expect(issue.monitorNextCheckAt).toBeNull();
    expect(issue.monitorAttemptCount).toBe(1);
    expect(issue.monitorLastTriggeredAt?.toISOString()).toBe(tickAt.toISOString());
    expect(normalizeIssueExecutionPolicy(issue.executionPolicy ?? null)?.monitor ?? null).toBeNull();
    expect(parseIssueExecutionState(issue.executionState)?.monitor).toMatchObject({
      status: "triggered",
      lastTriggeredAt: tickAt.toISOString(),
      attemptCount: 1,
    });

    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .then((rows) => rows[0] ?? null);
    expect(wakeup?.reason).toBe("issue_monitor_due");

    const activity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId))
      .then((rows) => rows.map((row) => row.action));
    expect(activity).toContain("issue.monitor_triggered");
  });

  it("re-arms a triggered monitor when its wake-carrying run does not dispatch", async () => {
    const { issueId } = await seedFixture();
    const heartbeat = heartbeatService(db, { skipQueuedRunDispatch: true });
    heartbeatServices.add(heartbeat);
    const triggeredAt = new Date("2026-04-11T12:31:00.000Z");

    await heartbeat.tickTimers(triggeredAt);
    const queuedRun = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.status, "queued"))
      .then((rows) => rows[0]!);
    await db
      .update(heartbeatRuns)
      .set({ createdAt: new Date(triggeredAt.getTime() - ISSUE_MONITOR_DISPATCH_LAPSE_MS) })
      .where(eq(heartbeatRuns.id, queuedRun.id));
    await db
      .update(issues)
      .set({ executionRunId: queuedRun.id })
      .where(eq(issues.id, issueId));

    const lapseDetectedAt = new Date(triggeredAt.getTime() + ISSUE_MONITOR_DISPATCH_LAPSE_MS);
    await heartbeat.tickTimers(lapseDetectedAt);
    await db
      .update(heartbeatRuns)
      .set({ status: "cancelled", finishedAt: lapseDetectedAt })
      .where(eq(heartbeatRuns.id, queuedRun.id));

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    expect(issue.monitorNextCheckAt?.getTime()).toBeGreaterThan(lapseDetectedAt.getTime());
    expect(normalizeIssueExecutionPolicy(issue.executionPolicy)?.monitor).toMatchObject({
      serviceName: "paperclip_monitor_dispatch",
      gateSignals: [`heartbeat_run:${queuedRun.id}`],
    });
    expect(parseIssueExecutionState(issue.executionState)?.monitor).toMatchObject({ status: "scheduled" });
    expect(issue.monitorAttemptCount, "a wake that never dispatched does not consume an attempt").toBe(0);

    const activity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId));
    expect(activity.map((row) => row.action)).toContain("issue.monitor_rearmed_after_dispatch_lapse");

  });

  it("re-dispatches and re-arms when the watchdog fires on a run that is still queued", async () => {
    // Regression for BLO-22860: the watchdog re-armed a monitor but left the
    // stale run queued. When it fired, enqueueWakeup coalesced into that same
    // queued run without dispatching, and the triggered patch cleared
    // monitorNextCheckAt — so the issue re-lapsed with the same undeliverable
    // run, forever. skipQueuedRunDispatch keeps the run queued across the
    // watchdog fire, which is exactly the stuck-dispatcher case.
    const { issueId } = await seedFixture();
    const heartbeat = heartbeatService(db, { skipQueuedRunDispatch: true });
    heartbeatServices.add(heartbeat);
    const triggeredAt = new Date("2026-04-11T12:31:00.000Z");

    await heartbeat.tickTimers(triggeredAt);
    const queuedRun = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.status, "queued"))
      .then((rows) => rows[0]!);
    await db
      .update(heartbeatRuns)
      .set({ createdAt: new Date(triggeredAt.getTime() - ISSUE_MONITOR_DISPATCH_LAPSE_MS) })
      .where(eq(heartbeatRuns.id, queuedRun.id));
    await db.update(issues).set({ executionRunId: queuedRun.id }).where(eq(issues.id, issueId));

    // Pass 1: the tick detects the lapse and arms the watchdog monitor.
    const lapseDetectedAt = new Date(triggeredAt.getTime() + ISSUE_MONITOR_DISPATCH_LAPSE_MS);
    await heartbeat.tickTimers(lapseDetectedAt);
    const armed = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    expect(armed.monitorNextCheckAt, "watchdog armed").not.toBeNull();
    const watchdogDueAt = armed.monitorNextCheckAt!;

    // Pass 2: the watchdog fires while the watched run is STILL queued.
    await heartbeat.tickTimers(new Date(watchdogDueAt.getTime() + 1000));

    // Settle the deliberately-stuck run before asserting, so a failing
    // expectation cannot strand afterEach's drain (which waits for zero
    // queued/running runs) and cascade into the rest of the file.
    await db
      .update(heartbeatRuns)
      .set({ status: "cancelled", finishedAt: watchdogDueAt })
      .where(eq(heartbeatRuns.id, queuedRun.id));

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    expect(
      issue.monitorNextCheckAt,
      "the watchdog must not consume the timer while the run is still stuck",
    ).not.toBeNull();
    expect(issue.monitorNextCheckAt!.getTime()).toBeGreaterThan(watchdogDueAt.getTime());
    expect(parseIssueExecutionState(issue.executionState)?.monitor).toMatchObject({
      status: "scheduled",
      serviceName: "paperclip_monitor_dispatch",
    });
    expect(
      issue.monitorAttemptCount,
      "a watchdog fire that did dispatch work consumes an attempt, so the retry loop is bounded",
    ).toBeGreaterThan(armed.monitorAttemptCount ?? 0);

    const activity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId))
      .then((rows) => rows.map((row) => row.action));
    expect(activity).toContain("issue.monitor_dispatch_watchdog_redispatched");
  });

  it("clears the watchdog once the watched run leaves the dispatch queue", async () => {
    const { issueId } = await seedFixture();
    const heartbeat = heartbeatService(db, { skipQueuedRunDispatch: true });
    heartbeatServices.add(heartbeat);
    const triggeredAt = new Date("2026-04-11T12:31:00.000Z");

    await heartbeat.tickTimers(triggeredAt);
    const queuedRun = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.status, "queued"))
      .then((rows) => rows[0]!);
    await db
      .update(heartbeatRuns)
      .set({ createdAt: new Date(triggeredAt.getTime() - ISSUE_MONITOR_DISPATCH_LAPSE_MS) })
      .where(eq(heartbeatRuns.id, queuedRun.id));
    await db.update(issues).set({ executionRunId: queuedRun.id }).where(eq(issues.id, issueId));

    const lapseDetectedAt = new Date(triggeredAt.getTime() + ISSUE_MONITOR_DISPATCH_LAPSE_MS);
    await heartbeat.tickTimers(lapseDetectedAt);
    const armed = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    const watchdogDueAt = armed.monitorNextCheckAt!;

    // The run finally starts before the watchdog fires.
    await db
      .update(heartbeatRuns)
      .set({ status: "running", startedAt: new Date(watchdogDueAt.getTime() - 1000) })
      .where(eq(heartbeatRuns.id, queuedRun.id));

    await heartbeat.tickTimers(new Date(watchdogDueAt.getTime() + 1000));

    // Settle the run before the assertions so afterEach's drain can proceed.
    await db
      .update(heartbeatRuns)
      .set({ status: "completed", finishedAt: new Date(watchdogDueAt.getTime() + 2000) })
      .where(eq(heartbeatRuns.id, queuedRun.id));

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    expect(issue.monitorNextCheckAt, "watchdog stands down once dispatch happened").toBeNull();
    expect(parseIssueExecutionState(issue.executionState)?.monitor).toMatchObject({
      status: "cleared",
      clearReason: "dispatch_skipped",
    });

    const activity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId))
      .then((rows) => rows.map((row) => row.action));
    expect(activity).toContain("issue.monitor_dispatch_watchdog_recovered");
  });

  it("wakes a cross-agent review participant for provider quota monitors", async () => {
    const { companyId, issueId, agentId: assigneeAgentId } = await seedFixture({
      issueStatus: "in_review",
      monitor: { serviceName: PROVIDER_QUOTA_MONITOR_SERVICE_NAME },
    });
    const participantAgentId = randomUUID();
    await db.insert(agents).values({
      id: participantAgentId,
      companyId,
      name: "Quota-limited reviewer",
      role: "engineer",
      status: "active",
      adapterType: "process",
      adapterConfig: {
        command: process.execPath,
        args: ["-e", ""],
        cwd: process.cwd(),
      },
      runtimeConfig: {
        heartbeat: {
          enabled: false,
          wakeOnDemand: true,
        },
      },
      permissions: {},
    });
    seededAgentIds.add(participantAgentId);
    const monitorState = await db
      .select({ executionState: issues.executionState })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => parseIssueExecutionState(rows[0]?.executionState ?? null)?.monitor ?? null);
    await db.update(issues).set({
      executionState: {
        status: "pending",
        currentStageId: randomUUID(),
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: participantAgentId, userId: null },
        returnAssignee: { type: "agent", agentId: assigneeAgentId, userId: null },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
        monitor: monitorState,
      },
    }).where(eq(issues.id, issueId));
    const heartbeat = createHeartbeat();

    const result = await heartbeat.tickTimers(new Date("2026-04-11T12:31:00.000Z"));

    expect(result.enqueued).toBe(1);
    const wakeups = await db.select().from(agentWakeupRequests);
    expect(wakeups).toHaveLength(1);
    expect(wakeups[0]).toMatchObject({
      agentId: participantAgentId,
      reason: "execution_review_participant_recovery",
    });
    await waitForHeartbeatIdle();
    const participantRuns = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, participantAgentId));
    expect(participantRuns).toHaveLength(1);
    expect(participantRuns[0]?.errorCode).not.toBe("issue_assignee_changed");
  });

  it("lets the board trigger a scheduled issue monitor immediately", async () => {
    const { issueId, agentId, nextCheckAt } = await seedFixture();
    const heartbeat = createHeartbeat();
    const triggeredAt = new Date("2026-04-11T12:00:00.000Z");

    const result = await heartbeat.triggerIssueMonitor(issueId, {
      now: triggeredAt,
      actorType: "user",
      actorId: "local-board",
    });

    expect(result.outcome).toBe("triggered");

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    expect(issue.monitorNextCheckAt).toBeNull();
    expect(issue.monitorLastTriggeredAt?.toISOString()).toBe(triggeredAt.toISOString());
    expect(issue.monitorAttemptCount).toBe(1);
    expect(normalizeIssueExecutionPolicy(issue.executionPolicy ?? null)?.monitor ?? null).toBeNull();

    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .then((rows) => rows[0] ?? null);
    expect(wakeup?.reason).toBe("issue_monitor_due");
    expect(wakeup?.payload).toMatchObject({
      issueId,
      nextCheckAt: nextCheckAt.toISOString(),
      source: "manual",
    });

    const activity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId))
      .orderBy(activityLog.createdAt);
    expect(activity.map((row) => row.action)).toContain("issue.monitor_triggered");
    const triggerEvent = activity.find((row) => row.action === "issue.monitor_triggered");
    expect(triggerEvent?.actorType).toBe("user");
    expect(triggerEvent?.actorId).toBe("local-board");
    expect(triggerEvent?.details).toMatchObject({
      nextCheckAt: nextCheckAt.toISOString(),
      source: "manual",
    });
  });

  it("clears due monitors that cannot be dispatched and records a skip", async () => {
    const { issueId } = await seedFixture({ agentStatus: "paused" });
    const heartbeat = createHeartbeat();
    const tickAt = new Date("2026-04-11T12:31:00.000Z");

    const result = await heartbeat.tickTimers(tickAt);

    expect(result.skipped).toBe(1);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    expect(issue.monitorNextCheckAt).toBeNull();
    expect(parseIssueExecutionState(issue.executionState)?.monitor).toMatchObject({
      status: "cleared",
      clearReason: "dispatch_skipped",
    });

    const activity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId))
      .then((rows) => rows.map((row) => row.action));
    expect(activity).toContain("issue.monitor_skipped");
  });

  // BLO-23061: a monitor armed WITHOUT an explicit maxAttempts is unbounded, so
  // `exhaustedMonitorClearReason` never returns "max_attempts_exhausted" and the
  // configured `recoveryPolicy: "wake_owner"` can never fire. Observed live on
  // BLO-22305: 19 agent runs in 31 hours, each re-arming with an unchanged
  // signature, no escalation, no human ever notified. The escalation machinery
  // is complete and tested (see the test below) — it is simply unreachable
  // without a default ceiling.
  it("bounds a monitor armed without an explicit maxAttempts so owner recovery can still fire", async () => {
    const { issueId, agentId } = await seedFixture({
      monitorAttemptCount: DEFAULT_ISSUE_MONITOR_MAX_ATTEMPTS,
      monitor: {
        // Deliberately NO maxAttempts — this is the live shape on BLO-22305 and
        // BLO-22361, both of which carry recoveryPolicy but maxAttempts: null.
        recoveryPolicy: "wake_owner",
      },
    });
    const heartbeat = createHeartbeat();
    const tickAt = new Date("2026-04-11T12:31:00.000Z");

    const result = await heartbeat.tickTimers(tickAt);

    expect(result.enqueued).toBe(0);
    expect(result.skipped).toBe(1);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    expect(issue.monitorNextCheckAt).toBeNull();
    expect(parseIssueExecutionState(issue.executionState)?.monitor).toMatchObject({
      status: "cleared",
      clearReason: "max_attempts_exhausted",
    });

    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .then((rows) => rows[0] ?? null);
    expect(wakeup?.reason).toBe("issue_monitor_recovery");
  });

  // Characterization test pinning the exact exhaustion boundary, so the shared
  // limit helper cannot silently shift it by one. The scheduler compares
  // `nextAttemptCount > maxAttempts` where `nextAttemptCount = prior + 1`, which
  // is equivalent to `prior >= maxAttempts`. One attempt below the ceiling must
  // still dispatch normally.
  it("still dispatches one attempt below the default monitor ceiling", async () => {
    const { issueId } = await seedFixture({
      monitorAttemptCount: DEFAULT_ISSUE_MONITOR_MAX_ATTEMPTS - 1,
      monitor: {
        recoveryPolicy: "wake_owner",
      },
    });
    const heartbeat = createHeartbeat();

    const result = await heartbeat.tickTimers(new Date("2026-04-11T12:31:00.000Z"));

    expect(result.enqueued).toBe(1);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    expect(parseIssueExecutionState(issue.executionState)?.monitor).toMatchObject({
      status: "triggered",
      attemptCount: DEFAULT_ISSUE_MONITOR_MAX_ATTEMPTS,
    });
  });

  it("clears exhausted monitors and queues bounded owner recovery instead of another due check", async () => {
    const { issueId, agentId } = await seedFixture({
      monitorAttemptCount: 1,
      monitor: {
        maxAttempts: 1,
        recoveryPolicy: "wake_owner",
      },
    });
    const heartbeat = createHeartbeat();
    const tickAt = new Date("2026-04-11T12:31:00.000Z");

    const result = await heartbeat.tickTimers(tickAt);

    expect(result.enqueued).toBe(0);
    expect(result.skipped).toBe(1);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    expect(issue.monitorNextCheckAt).toBeNull();
    expect(parseIssueExecutionState(issue.executionState)?.monitor).toMatchObject({
      status: "cleared",
      clearReason: "max_attempts_exhausted",
    });

    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .then((rows) => rows[0] ?? null);
    expect(wakeup?.reason).toBe("issue_monitor_recovery");
    expect(wakeup?.payload).toMatchObject({
      issueId,
      clearReason: "max_attempts_exhausted",
      maxAttempts: 1,
      modelProfile: "cheap",
    });

    const activity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId))
      .then((rows) => rows.map((row) => row.action));
    expect(activity).toContain("issue.monitor_exhausted");
    expect(activity).toContain("issue.monitor_recovery_wake_queued");
    expect(activity).not.toContain("issue.monitor_triggered");
  });

  it("clears timed-out monitors and creates a visible recovery issue when requested", async () => {
    const { issueId, companyId } = await seedFixture({
      monitor: {
        timeoutAt: "2026-04-11T12:00:00.000Z",
        recoveryPolicy: "create_recovery_issue",
      },
    });
    const heartbeat = createHeartbeat();
    const tickAt = new Date("2026-04-11T12:31:00.000Z");

    const result = await heartbeat.tickTimers(tickAt);

    expect(result.enqueued).toBe(0);
    expect(result.skipped).toBe(1);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    expect(issue.monitorNextCheckAt).toBeNull();
    expect(parseIssueExecutionState(issue.executionState)?.monitor).toMatchObject({
      status: "cleared",
      clearReason: "timeout_exceeded",
    });

    const recoveryIssue = await db
      .select()
      .from(issues)
      .where(eq(issues.originId, issueId))
      .then((rows) => rows.find((row) => row.companyId === companyId && row.originKind === "stranded_issue_recovery") ?? null);
    expect(recoveryIssue).toMatchObject({
      parentId: issueId,
      priority: "high",
      assigneeAdapterOverrides: { modelProfile: "cheap" },
    });
    expect(["todo", "in_progress"]).toContain(recoveryIssue?.status);
  });

  it("omits external monitor refs from wake payloads and activity details", async () => {
    const { issueId, agentId } = await seedFixture({
      monitor: {
        serviceName: "Deploy provider",
        externalRef: "https://provider.example/deploy/123?token=secret",
      },
    });
    const heartbeat = createHeartbeat();
    const tickAt = new Date("2026-04-11T12:31:00.000Z");

    await heartbeat.tickTimers(tickAt);

    const wakeup = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .then((rows) => rows[0] ?? null);
    expect(JSON.stringify(wakeup?.payload)).not.toContain("provider.example");
    expect(wakeup?.payload).not.toHaveProperty("externalRef");

    const activity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId));
    expect(JSON.stringify(activity.map((row) => row.details))).not.toContain("provider.example");
    expect(activity.find((row) => row.action === "issue.monitor_triggered")?.details).not.toHaveProperty("externalRef");
  });

  // BLO-25865: a monitor that fired and whose woken run never called back to
  // re-arm or clear it is invisible to tickDueIssueMonitors forever, because
  // that sweep only claims rows where monitorNextCheckAt is non-null. Nothing
  // else evaluated `timeoutAt`, so clearedAt/clearReason stayed null and the
  // configured wake_owner recovery never ran. This is the missing sweep.
  it("recovers a monitor stuck triggered past its timeout with a null nextCheckAt", async () => {
    const { issueId, agentId, timeoutAt } = await seedExpiredTriggeredFixture();
    const heartbeat = createHeartbeat();
    const tickAt = new Date(timeoutAt.getTime() + 60 * 60 * 1000);

    const result = await heartbeat.tickTimers(tickAt);

    expect(result.skipped).toBeGreaterThanOrEqual(1);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    expect(issue.monitorNextCheckAt).toBeNull();
    const monitorState = parseIssueExecutionState(issue.executionState)?.monitor;
    expect(monitorState).toMatchObject({
      status: "cleared",
      clearReason: "timeout_exceeded",
    });
    expect(monitorState?.clearedAt).not.toBeNull();

    const recoveryWakeups = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .then((rows) => rows.filter((row) => row.reason === "issue_monitor_recovery"));
    expect(recoveryWakeups).toHaveLength(1);
    expect(recoveryWakeups[0]?.payload).toMatchObject({
      issueId,
      clearReason: "timeout_exceeded",
    });

    const activity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId))
      .then((rows) => rows.map((row) => row.action));
    expect(activity).toContain("issue.monitor_exhausted");
    expect(activity).toContain("issue.monitor_recovery_wake_queued");
  });

  it("does not recover the same expired monitor twice across repeated ticks", async () => {
    const { issueId, agentId, timeoutAt } = await seedExpiredTriggeredFixture();
    const heartbeat = createHeartbeat();
    const tickAt = new Date(timeoutAt.getTime() + 60 * 60 * 1000);

    await heartbeat.tickTimers(tickAt);
    await heartbeat.tickTimers(new Date(tickAt.getTime() + 60 * 1000));

    const recoveryWakeups = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .then((rows) => rows.filter((row) => row.reason === "issue_monitor_recovery"));
    expect(recoveryWakeups).toHaveLength(1);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    expect(parseIssueExecutionState(issue.executionState)?.monitor).toMatchObject({
      status: "cleared",
      clearReason: "timeout_exceeded",
    });
  });

  // Control: a monitor that already reached a normal terminal `cleared` state
  // (the gate resolved and something explicitly cleared it) must not be
  // re-touched or trigger a spurious recovery wake, even past its timeoutAt.
  it("does not recover a monitor that already cleared normally", async () => {
    const { issueId, agentId, timeoutAt } = await seedExpiredTriggeredFixture({
      monitorStateOverrides: {
        status: "cleared",
        clearedAt: new Date("2026-04-10T12:00:00.000Z").toISOString(),
        clearReason: "manual",
      },
    });
    const heartbeat = createHeartbeat();
    const tickAt = new Date(timeoutAt.getTime() + 60 * 60 * 1000);

    await heartbeat.tickTimers(tickAt);

    const recoveryWakeups = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .then((rows) => rows.filter((row) => row.reason === "issue_monitor_recovery"));
    expect(recoveryWakeups).toHaveLength(0);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    expect(parseIssueExecutionState(issue.executionState)?.monitor).toMatchObject({
      status: "cleared",
      clearReason: "manual",
    });
  });

  // Control: a triggered monitor whose timeoutAt has not yet passed is not a
  // BLO-25865 instance — it is simply mid-flight, waiting on its woken run.
  it("leaves a triggered monitor alone until its timeout actually passes", async () => {
    const { issueId, timeoutAt } = await seedExpiredTriggeredFixture();
    const heartbeat = createHeartbeat();
    const tickAt = new Date(timeoutAt.getTime() - 60 * 60 * 1000);

    await heartbeat.tickTimers(tickAt);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    expect(parseIssueExecutionState(issue.executionState)?.monitor).toMatchObject({
      status: "triggered",
      clearReason: null,
    });
  });

  it.each([
    ["user reassignment", { assigneeUserId: "board-user" }],
    ["terminal status", { status: "done" }],
  ])("does not recover an expired monitor when %s races the claim", async (_label, mutation) => {
    const { issueId, agentId, timeoutAt } = await seedExpiredTriggeredFixture();
    const heartbeat = createHeartbeatWithClaimRace(issueId, mutation);
    const tickAt = new Date(timeoutAt.getTime() + 60 * 60 * 1000);

    await heartbeat.tickTimers(tickAt);

    const recoveryWakeups = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .then((rows) => rows.filter((row) => row.reason === "issue_monitor_recovery"));
    expect(recoveryWakeups).toHaveLength(0);

    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
    expect(issue.monitorWakeRequestedAt).toBeNull();
    expect(parseIssueExecutionState(issue.executionState)?.monitor).toMatchObject({
      status: "triggered",
      clearReason: null,
    });
  });

  function createHeartbeatWithClaimRace(
    issueId: string,
    mutation: { assigneeUserId?: string; status?: "done" },
  ) {
    const service = heartbeatService(db, {
      issueMonitorClaimHook: async () => {
        await db.update(issues).set(mutation).where(eq(issues.id, issueId));
      },
    });
    heartbeatServices.add(service);
    return service;
  }
});
