import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issueRelations,
  issueTreeHolds,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("../telemetry.ts", () => ({ getTelemetryClient: () => mockTelemetryClient }));

import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres stale-lock sweeper tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("recovery sweepStaleIssueLocks", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-stale-lock-sweep-");
    db = createDb(tempDb.connectionString);
  }, 120_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(activityLog);
    await db.delete(issueTreeHolds);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const failedRunId = randomUUID();
    const runningRunId = randomUUID();
    const queuedRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Coder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values([
      {
        id: failedRunId,
        companyId,
        agentId,
        status: "failed",
        invocationSource: "manual",
        finishedAt: new Date(),
      },
      {
        id: runningRunId,
        companyId,
        agentId,
        status: "running",
        invocationSource: "manual",
        startedAt: new Date(),
      },
      {
        // BLO-18995: never-started run — queued, startedAt null.
        id: queuedRunId,
        companyId,
        agentId,
        status: "queued",
        invocationSource: "automation",
        startedAt: null,
      },
    ]);

    return { companyId, agentId, failedRunId, runningRunId, queuedRunId };
  }

  it("clears lock columns when checkoutRunId points at a terminal heartbeat run", async () => {
    const { companyId, agentId, failedRunId } = await seed();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Stale lock — terminal checkoutRunId",
      // Status off in_progress + checkoutRunId still set → exactly the recurrence shape.
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: failedRunId,
      executionRunId: null,
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.sweepStaleIssueLocks();

    expect(result.cleared).toBe(1);
    expect(result.issueIds).toEqual([issueId]);

    const row = await db
      .select({
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
        executionLockedAt: issues.executionLockedAt,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({ checkoutRunId: null, executionRunId: null, executionLockedAt: null });

    const audit = await db
      .select({ action: activityLog.action, details: activityLog.details })
      .from(activityLog)
      .where(eq(activityLog.action, "issue.stale_lock_cleared"))
      .then((rows) => rows[0]);
    expect(audit?.action).toBe("issue.stale_lock_cleared");
    expect((audit?.details as { clearedCheckoutRunId?: string } | null)?.clearedCheckoutRunId).toBe(
      failedRunId,
    );
  });

  it("does not clear locks while the referenced run is still running", async () => {
    const { companyId, agentId, runningRunId } = await seed();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Live lock — must be preserved",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: runningRunId,
      executionRunId: runningRunId,
      executionLockedAt: new Date(),
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.sweepStaleIssueLocks();

    expect(result.cleared).toBe(0);
    const row = await db
      .select({
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({ checkoutRunId: runningRunId, executionRunId: runningRunId });
  });

  it("does not clear when checkoutRunId is terminal but executionRunId is still running", async () => {
    const { companyId, agentId, failedRunId, runningRunId } = await seed();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Mixed lock — preserve",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: failedRunId,
      executionRunId: runningRunId,
      executionLockedAt: new Date(),
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.sweepStaleIssueLocks();

    expect(result.cleared).toBe(0);
    const row = await db
      .select({
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({ checkoutRunId: failedRunId, executionRunId: runningRunId });
  });

  it("is idempotent — second pass finds nothing to clear", async () => {
    const { companyId, agentId, failedRunId } = await seed();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Idempotency",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: failedRunId,
      executionRunId: null,
    });

    const heartbeat = heartbeatService(db);
    const first = await heartbeat.sweepStaleIssueLocks();
    const second = await heartbeat.sweepStaleIssueLocks();
    expect(first.cleared).toBe(1);
    expect(second.cleared).toBe(0);
  });

  // BLO-18995: four enqueue paths stamp executionRunId/executionLockedAt at
  // *enqueue* time next to a freshly-inserted `queued` run instead of lazily at
  // claim time. `queued` is neither missing nor terminal, so isCleanable()
  // returned false forever and this sweeper — the designated backstop — never
  // cleared the lock, while enqueueWakeup parked every later wake for the issue
  // as `deferred_issue_execution` behind a holder that may never start. There
  // was no timeout anywhere in the path. Observed live on BLO-18939.
  it("clears an execution lock held past the timeout by a run that never started (BLO-18995)", async () => {
    const { companyId, agentId, queuedRunId } = await seed();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Pre-claim lock held by a never-started run",
      status: "in_progress",
      priority: "critical",
      assigneeAgentId: agentId,
      checkoutRunId: null,
      executionRunId: queuedRunId,
      // Past STALE_PRE_CLAIM_ISSUE_LOCK_MS (6h).
      executionLockedAt: new Date(Date.now() - 7 * 60 * 60 * 1000),
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.sweepStaleIssueLocks();

    expect(result.cleared).toBe(1);
    expect(result.issueIds).toEqual([issueId]);

    const row = await db
      .select({
        executionRunId: issues.executionRunId,
        executionLockedAt: issues.executionLockedAt,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({ executionRunId: null, executionLockedAt: null });

    // The run itself is untouched — clearing the lock must not cancel queued
    // work; claimQueuedRun re-acquires the lock if the run is later claimed.
    const run = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, queuedRunId))
      .then((rows) => rows[0]);
    expect(run?.status).toBe("queued");

    const audit = await db
      .select({ details: activityLog.details })
      .from(activityLog)
      .where(eq(activityLog.action, "issue.stale_lock_cleared"))
      .then((rows) => rows[0]);
    expect((audit?.details as { reason?: string } | null)?.reason).toBe("pre_claim_lock_expired");
  });

  it("preserves a pre-claim execution lock that is still within the timeout (BLO-18995)", async () => {
    // The timeout must be a real bound, not an immediate release: a queued run
    // legitimately waits behind a backlog, and clearing its lock early would
    // let duplicate wakes queue for the same issue.
    const { companyId, agentId, queuedRunId } = await seed();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Pre-claim lock still fresh",
      status: "in_progress",
      priority: "critical",
      assigneeAgentId: agentId,
      checkoutRunId: null,
      executionRunId: queuedRunId,
      executionLockedAt: new Date(Date.now() - 60 * 60 * 1000),
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.sweepStaleIssueLocks();

    expect(result.cleared).toBe(0);
    const row = await db
      .select({ executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row?.executionRunId).toBe(queuedRunId);
  });

  it("preserves a future scheduled retry even when its lock is older than the timeout", async () => {
    const { companyId, agentId } = await seed();
    const retryRunId = randomUUID();
    const issueId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: retryRunId,
      companyId,
      agentId,
      status: "scheduled_retry",
      invocationSource: "automation",
      startedAt: null,
      scheduledRetryAt: new Date(Date.now() + 60 * 60 * 1000),
      scheduledRetryAttempt: 0,
      scheduledRetryReason: "ccrotate_capacity",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Future scheduled retry",
      status: "in_progress",
      priority: "critical",
      assigneeAgentId: agentId,
      checkoutRunId: null,
      executionRunId: retryRunId,
      executionLockedAt: new Date(Date.now() - 7 * 60 * 60 * 1000),
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.sweepStaleIssueLocks();

    expect(result.cleared).toBe(0);
    const row = await db
      .select({
        executionRunId: issues.executionRunId,
        executionLockedAt: issues.executionLockedAt,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row?.executionRunId).toBe(retryRunId);
    expect(row?.executionLockedAt).not.toBeNull();
  });

  it("does not clear a live checkout lock just because the execution lock expired (BLO-18995)", async () => {
    // The sweeper nulls checkoutRunId and executionRunId in one UPDATE, so the
    // new pre-claim-expiry allowance must not become a blanket bypass of the
    // checkout check. An issue whose checkoutRunId points at a live run keeps
    // its checkout lock no matter how stale the execution lock is.
    const { companyId, agentId, runningRunId, queuedRunId } = await seed();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Expired execution lock, live checkout lock",
      status: "in_progress",
      priority: "critical",
      assigneeAgentId: agentId,
      checkoutRunId: runningRunId,
      executionRunId: queuedRunId,
      executionLockedAt: new Date(Date.now() - 7 * 60 * 60 * 1000),
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.sweepStaleIssueLocks();

    expect(result.cleared).toBe(0);
    const row = await db
      .select({
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({ checkoutRunId: runningRunId, executionRunId: queuedRunId });
  });

  it("does not clear a stale pre-claim lock if a claim refreshes executionLockedAt after scan", async () => {
    const { companyId, agentId, queuedRunId } = await seed();
    const issueId = randomUUID();
    const staleLockedAt = new Date(Date.now() - 7 * 60 * 60 * 1000);
    const refreshedLockedAt = new Date();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Pre-claim lock claimed during sweep",
      status: "in_progress",
      priority: "critical",
      assigneeAgentId: agentId,
      checkoutRunId: null,
      executionRunId: queuedRunId,
      executionLockedAt: staleLockedAt,
    });

    const heartbeat = heartbeatService(db);
    let sweepPromise: ReturnType<typeof heartbeat.sweepStaleIssueLocks> | null = null;

    await db.transaction(async (tx) => {
      await tx.execute(sql`select id from issues where id = ${issueId} for update`);
      sweepPromise = heartbeat.sweepStaleIssueLocks();
      await new Promise((resolve) => setTimeout(resolve, 100));
      await tx
        .update(issues)
        .set({ executionLockedAt: refreshedLockedAt, updatedAt: refreshedLockedAt })
        .where(eq(issues.id, issueId));
    });

    expect(sweepPromise).not.toBeNull();
    const result = await sweepPromise!;

    expect(result.cleared).toBe(0);
    const row = await db
      .select({
        executionRunId: issues.executionRunId,
        executionLockedAt: issues.executionLockedAt,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row?.executionRunId).toBe(queuedRunId);
    expect(row?.executionLockedAt?.getTime()).toBe(refreshedLockedAt.getTime());
  });

  it("promotes the oldest eligible deferred issue wake after clearing an expired pre-claim lock", async () => {
    const { companyId, agentId, queuedRunId } = await seed();
    const issueId = randomUUID();
    const deferredWakeId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Expired holder with deferred follow-up",
      status: "in_progress",
      priority: "critical",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
      checkoutRunId: null,
      executionRunId: queuedRunId,
      executionLockedAt: new Date(Date.now() - 7 * 60 * 60 * 1000),
    });
    await db.insert(agentWakeupRequests).values({
      id: deferredWakeId,
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_execution_deferred",
      payload: {
        issueId,
        commentId: "comment-1",
        _paperclipWakeContext: {
          issueId,
          taskId: issueId,
          wakeReason: "issue_comment_followup",
        },
      },
      status: "deferred_issue_execution",
      requestedByActorType: "system",
      requestedByActorId: null,
      requestedAt: new Date(Date.now() - 5 * 60 * 1000),
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.sweepStaleIssueLocks();

    expect(result.cleared).toBe(1);
    expect(result.issueIds).toEqual([issueId]);

    const wake = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        runId: agentWakeupRequests.runId,
        error: agentWakeupRequests.error,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, deferredWakeId))
      .then((rows) => rows[0]);
    expect(wake).toMatchObject({
      status: "queued",
      reason: "issue_execution_promoted",
      error: null,
    });
    expect(wake?.runId).toBeTruthy();
    expect(wake?.runId).not.toBe(queuedRunId);

    const promotedRun = await db
      .select({
        id: heartbeatRuns.id,
        status: heartbeatRuns.status,
        wakeupRequestId: heartbeatRuns.wakeupRequestId,
        contextSnapshot: heartbeatRuns.contextSnapshot,
        responsibleUserId: heartbeatRuns.responsibleUserId,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, wake!.runId!))
      .then((rows) => rows[0]);
    expect(promotedRun).toMatchObject({
      id: wake?.runId,
      status: "queued",
      wakeupRequestId: deferredWakeId,
      responsibleUserId: "responsible-user",
    });
    expect(promotedRun?.contextSnapshot).toMatchObject({
      issueId,
      taskId: issueId,
      wakeReason: "issue_comment_followup",
      wakeSource: "automation",
      wakeTriggerDetail: "system",
      commentId: "comment-1",
    });

    const issue = await db
      .select({
        executionRunId: issues.executionRunId,
        executionAgentNameKey: issues.executionAgentNameKey,
        executionLockedAt: issues.executionLockedAt,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(issue?.executionRunId).toBe(wake?.runId);
    expect(issue?.executionAgentNameKey).toBe("coder");
    expect(issue?.executionLockedAt).not.toBeNull();

    const originalRun = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, queuedRunId))
      .then((rows) => rows[0]);
    expect(originalRun?.status).toBe("queued");
  });

  it("promotes a deferred issue-scoped wake for a non-assignee without taking the issue lock", async () => {
    const { companyId, agentId, queuedRunId } = await seed();
    const mentionedAgentId = randomUUID();
    const issueId = randomUUID();
    const deferredWakeId = randomUUID();
    await db.insert(agents).values({
      id: mentionedAgentId,
      companyId,
      name: "Mentioned Coder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Expired holder with cross-agent mention",
      status: "in_progress",
      priority: "critical",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
      checkoutRunId: null,
      executionRunId: queuedRunId,
      executionLockedAt: new Date(Date.now() - 7 * 60 * 60 * 1000),
    });
    await db.insert(agentWakeupRequests).values({
      id: deferredWakeId,
      companyId,
      agentId: mentionedAgentId,
      source: "comment",
      triggerDetail: "issue_comment_mentioned",
      reason: "issue_execution_deferred",
      payload: {
        issueId,
        commentId: "comment-mention",
        _paperclipWakeContext: {
          issueId,
          taskId: issueId,
          wakeReason: "issue_comment_mentioned",
        },
      },
      status: "deferred_issue_execution",
      requestedByActorType: "user",
      requestedByActorId: "board-user",
      requestedAt: new Date(Date.now() - 5 * 60 * 1000),
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.sweepStaleIssueLocks();

    expect(result.cleared).toBe(1);
    const wake = await db
      .select({
        status: agentWakeupRequests.status,
        runId: agentWakeupRequests.runId,
        error: agentWakeupRequests.error,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, deferredWakeId))
      .then((rows) => rows[0]);
    expect(wake).toMatchObject({
      status: "queued",
      error: null,
    });
    expect(wake?.runId).toBeTruthy();

    const promotedRun = await db
      .select({
        agentId: heartbeatRuns.agentId,
        wakeupRequestId: heartbeatRuns.wakeupRequestId,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, wake!.runId!))
      .then((rows) => rows[0]);
    expect(promotedRun).toMatchObject({
      agentId: mentionedAgentId,
      wakeupRequestId: deferredWakeId,
    });
    expect(promotedRun?.contextSnapshot).toMatchObject({
      issueId,
      taskId: issueId,
      wakeReason: "issue_comment_mentioned",
      commentId: "comment-mention",
    });

    const issue = await db
      .select({
        executionRunId: issues.executionRunId,
        executionAgentNameKey: issues.executionAgentNameKey,
        executionLockedAt: issues.executionLockedAt,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(issue).toEqual({
      executionRunId: null,
      executionAgentNameKey: null,
      executionLockedAt: null,
    });
  });

  it("fails non-invokable deferred wakes and promotes the next eligible wake", async () => {
    const { companyId, agentId, queuedRunId } = await seed();
    const pausedAgentId = randomUUID();
    const issueId = randomUUID();
    const pausedWakeId = randomUUID();
    const activeWakeId = randomUUID();
    await db.insert(agents).values({
      id: pausedAgentId,
      companyId,
      name: "Paused Coder",
      role: "engineer",
      status: "paused",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Expired holder with mixed deferred wakes",
      status: "in_progress",
      priority: "critical",
      assigneeAgentId: agentId,
      checkoutRunId: null,
      executionRunId: queuedRunId,
      executionLockedAt: new Date(Date.now() - 7 * 60 * 60 * 1000),
    });
    await db.insert(agentWakeupRequests).values([
      {
        id: pausedWakeId,
        companyId,
        agentId: pausedAgentId,
        source: "automation",
        triggerDetail: "system",
        reason: "issue_execution_deferred",
        payload: { issueId, _paperclipWakeContext: { issueId, taskId: issueId } },
        status: "deferred_issue_execution",
        requestedAt: new Date(Date.now() - 10 * 60 * 1000),
      },
      {
        id: activeWakeId,
        companyId,
        agentId,
        source: "automation",
        triggerDetail: "system",
        reason: "issue_execution_deferred",
        payload: { issueId, _paperclipWakeContext: { issueId, taskId: issueId } },
        status: "deferred_issue_execution",
        requestedAt: new Date(Date.now() - 5 * 60 * 1000),
      },
    ]);

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.sweepStaleIssueLocks();

    expect(result.cleared).toBe(1);
    const wakes = await db
      .select({
        id: agentWakeupRequests.id,
        status: agentWakeupRequests.status,
        runId: agentWakeupRequests.runId,
        error: agentWakeupRequests.error,
      })
      .from(agentWakeupRequests)
      .where(sql`${agentWakeupRequests.id} in (${pausedWakeId}, ${activeWakeId})`);
    const byId = new Map(wakes.map((wake) => [wake.id, wake]));
    expect(byId.get(pausedWakeId)).toMatchObject({
      status: "failed",
      runId: null,
      error: "Deferred wake could not be promoted: agent is not invokable",
    });
    expect(byId.get(activeWakeId)?.status).toBe("queued");
    expect(byId.get(activeWakeId)?.runId).toBeTruthy();
  });

  it("cancels deferred wake promotion when a subtree pause hold is active", async () => {
    const { companyId, agentId, queuedRunId } = await seed();
    const issueId = randomUUID();
    const deferredWakeId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Expired holder under pause hold",
      status: "in_progress",
      priority: "critical",
      assigneeAgentId: agentId,
      checkoutRunId: null,
      executionRunId: queuedRunId,
      executionLockedAt: new Date(Date.now() - 7 * 60 * 60 * 1000),
    });
    await db.insert(issueTreeHolds).values({
      companyId,
      rootIssueId: issueId,
      mode: "pause",
      status: "active",
      reason: "manual pause",
      releasePolicy: { strategy: "manual" },
      createdByActorType: "user",
      createdByUserId: "board-user",
    });
    await db.insert(agentWakeupRequests).values({
      id: deferredWakeId,
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_execution_deferred",
      payload: { issueId, _paperclipWakeContext: { issueId, taskId: issueId } },
      status: "deferred_issue_execution",
      requestedByActorType: "system",
      requestedByActorId: null,
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.sweepStaleIssueLocks();

    expect(result.cleared).toBe(1);
    const wake = await db
      .select({
        status: agentWakeupRequests.status,
        runId: agentWakeupRequests.runId,
        error: agentWakeupRequests.error,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, deferredWakeId))
      .then((rows) => rows[0]);
    expect(wake).toMatchObject({
      status: "cancelled",
      runId: null,
      error: "Deferred wake suppressed by active subtree pause hold",
    });

    const issue = await db
      .select({
        executionRunId: issues.executionRunId,
        executionLockedAt: issues.executionLockedAt,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(issue).toEqual({ executionRunId: null, executionLockedAt: null });
  });
});
