import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issueExecutionDecisions,
  issueRelations,
  issueWorkProducts,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres stale execution lock route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("stale issue execution lock routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-stale-execution-lock-routes-");
    db = createDb(tempDb.connectionString);
  });

  afterEach(async () => {
    await db.delete(issueWorkProducts);
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(
    actor: Express.Request["actor"],
    opts: Parameters<typeof issueRoutes>[2] = {},
  ) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api", issueRoutes(db, {} as any, opts));
    app.use(errorHandler);
    return app;
  }

  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((resolvePromise) => {
      resolve = resolvePromise;
    });
    return { promise, resolve };
  }

  async function seedUnlockedPendingReview() {
    const { companyId, agentId, currentRunId } = await seedCompanyAgentAndRuns();
    const competingRunId = randomUUID();
    const issueId = randomUUID();
    const stageId = randomUUID();
    const participant = { type: "agent" as const, agentId, userId: null };
    await db.insert(heartbeatRuns).values({
      id: competingRunId,
      companyId,
      agentId,
      status: "running",
      invocationSource: "manual",
      startedAt: new Date(),
      createdAt: new Date("2026-01-01T00:02:00.000Z"),
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Unlocked pending review",
      status: "in_review",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: null,
      executionRunId: null,
      executionState: {
        status: "pending",
        currentStageId: stageId,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: participant,
        returnAssignee: participant,
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
        monitor: null,
      },
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [{
          id: stageId,
          type: "review",
          approvalsNeeded: 1,
          participants: [{ id: randomUUID(), ...participant }],
        }],
      },
    });
    return { companyId, agentId, currentRunId, competingRunId, issueId };
  }

  async function seedCompanyAgentAndRuns(options: { staleRunStatus?: string } = {}) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const failedRunId = randomUUID();
    const currentRunId = randomUUID();
    const staleRunStatus = options.staleRunStatus ?? "failed";
    const staleRunCreatedAt = new Date("2026-01-01T00:00:00.000Z");
    const currentRunCreatedAt = new Date("2026-01-01T00:01:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
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
        status: staleRunStatus,
        invocationSource: "manual",
        finishedAt: new Date(),
        createdAt: staleRunCreatedAt,
      },
      {
        id: currentRunId,
        companyId,
        agentId,
        status: "running",
        invocationSource: "manual",
        startedAt: new Date(),
        createdAt: currentRunCreatedAt,
      },
    ]);

    return { companyId, agentId, failedRunId, currentRunId };
  }

  async function seedQueuedIssueContextRuns(input: {
    companyId: string;
    agentId: string;
    issueId: string;
  }) {
    const queuedWakeupId = randomUUID();
    const scheduledWakeupId = randomUUID();
    const queuedRunId = randomUUID();
    const scheduledRunId = randomUUID();
    const runningRunId = randomUUID();

    await db.insert(agentWakeupRequests).values([
      {
        id: queuedWakeupId,
        companyId: input.companyId,
        agentId: input.agentId,
        source: "assignment",
        status: "queued",
      },
      {
        id: scheduledWakeupId,
        companyId: input.companyId,
        agentId: input.agentId,
        source: "timer",
        status: "queued",
      },
    ]);
    await db.insert(heartbeatRuns).values([
      {
        id: queuedRunId,
        companyId: input.companyId,
        agentId: input.agentId,
        status: "queued",
        invocationSource: "assignment",
        wakeupRequestId: queuedWakeupId,
        contextSnapshot: { issueId: input.issueId },
      },
      {
        id: scheduledRunId,
        companyId: input.companyId,
        agentId: input.agentId,
        status: "scheduled_retry",
        invocationSource: "timer",
        wakeupRequestId: scheduledWakeupId,
        scheduledRetryAt: new Date(Date.now() + 60_000),
        contextSnapshot: { issueId: input.issueId },
      },
      {
        id: runningRunId,
        companyId: input.companyId,
        agentId: input.agentId,
        status: "running",
        invocationSource: "assignment",
        startedAt: new Date(),
        contextSnapshot: { issueId: input.issueId },
      },
    ]);

    return { queuedWakeupId, scheduledWakeupId, queuedRunId, scheduledRunId, runningRunId };
  }

  it("rejects an unlocked pending-review PATCH after another run checks out", async () => {
    const seeded = await seedUnlockedPendingReview();
    const authorized = deferred();
    const continueWrite = deferred();
    const stalePatch = request(createApp(
      agentActor(seeded.companyId, seeded.agentId, seeded.currentRunId),
      {
        pendingInReviewMutationBeforeGuardHook: async () => {
          authorized.resolve();
          await continueWrite.promise;
        },
      },
    ))
      .patch(`/api/issues/${seeded.issueId}`)
      .send({ title: "Stale run edit" })
      .then((response) => response);

    await authorized.promise;
    const checkout = await request(createApp(
      agentActor(seeded.companyId, seeded.agentId, seeded.competingRunId),
    ))
      .post(`/api/issues/${seeded.issueId}/checkout`)
      .send({
        agentId: seeded.agentId,
        expectedStatuses: ["in_review"],
      });
    expect(checkout.status, JSON.stringify(checkout.body)).toBe(200);

    continueWrite.resolve();
    const patch = await stalePatch;
    expect(patch.status, JSON.stringify(patch.body)).toBe(409);
    expect(patch.body.error).toBe("Issue run ownership conflict");

    const row = await db
      .select({
        title: issues.title,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, seeded.issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({
      title: "Unlocked pending review",
      checkoutRunId: seeded.competingRunId,
      executionRunId: seeded.competingRunId,
    });
  });

  it("rejects an unlocked pending-review comment after another run checks out", async () => {
    const seeded = await seedUnlockedPendingReview();
    const authorized = deferred();
    const continueWrite = deferred();
    const staleComment = request(createApp(
      agentActor(seeded.companyId, seeded.agentId, seeded.currentRunId),
      {
        pendingInReviewMutationBeforeGuardHook: async () => {
          authorized.resolve();
          await continueWrite.promise;
        },
      },
    ))
      .post(`/api/issues/${seeded.issueId}/comments`)
      .send({ body: "Plain evidence from the stale run" })
      .then((response) => response);

    await authorized.promise;
    const checkout = await request(createApp(
      agentActor(seeded.companyId, seeded.agentId, seeded.competingRunId),
    ))
      .post(`/api/issues/${seeded.issueId}/checkout`)
      .send({ agentId: seeded.agentId, expectedStatuses: ["in_review"] });
    expect(checkout.status, JSON.stringify(checkout.body)).toBe(200);

    continueWrite.resolve();
    const comment = await staleComment;
    expect(comment.status, JSON.stringify(comment.body)).toBe(409);
    expect(comment.body.error).toBe("Issue run ownership conflict");
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, seeded.issueId))).toEqual([]);
  });

  it("rejects a non-PATCH pending-review write after another run checks out", async () => {
    const seeded = await seedUnlockedPendingReview();
    const authorized = deferred();
    const continueWrite = deferred();
    const staleWorkProduct = request(createApp(
      agentActor(seeded.companyId, seeded.agentId, seeded.currentRunId),
      {
        pendingInReviewMutationBeforeGuardHook: async () => {
          authorized.resolve();
          await continueWrite.promise;
        },
      },
    ))
      .post(`/api/issues/${seeded.issueId}/work-products`)
      .send({
        type: "artifact",
        provider: "test",
        title: "Stale artifact",
        status: "active",
      })
      .then((response) => response);

    await authorized.promise;
    const checkout = await request(createApp(
      agentActor(seeded.companyId, seeded.agentId, seeded.competingRunId),
    ))
      .post(`/api/issues/${seeded.issueId}/checkout`)
      .send({ agentId: seeded.agentId, expectedStatuses: ["in_review"] });
    expect(checkout.status, JSON.stringify(checkout.body)).toBe(200);

    continueWrite.resolve();
    const workProduct = await staleWorkProduct;
    expect(workProduct.status, JSON.stringify(workProduct.body)).toBe(409);
    expect(workProduct.body.error).toBe("Issue run ownership conflict");
    expect(await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.issueId, seeded.issueId))).toEqual([]);
  });

  function agentActor(companyId: string, agentId: string, runId: string): Express.Request["actor"] {
    return {
      type: "agent",
      agentId,
      companyId,
      runId,
      source: "agent_jwt",
    };
  }

  function boardActor(companyId: string): Express.Request["actor"] {
    return {
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "admin", status: "active" }],
      isInstanceAdmin: false,
      source: "session",
    };
  }

  it("allows an assigned agent PATCH to recover a terminal stale executionRunId", async () => {
    const { companyId, agentId, failedRunId, currentRunId } = await seedCompanyAgentAndRuns();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Stale execution lock",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: null,
      executionRunId: failedRunId,
      executionAgentNameKey: "codexcoder",
      executionLockedAt: new Date(),
    });
    const staleContext = await seedQueuedIssueContextRuns({ companyId, agentId, issueId });

    const res = await request(createApp(agentActor(companyId, agentId, currentRunId)))
      .patch(`/api/issues/${issueId}`)
      .send({ title: "Recovered execution lock" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.title).toBe("Recovered execution lock");

    const row = await db
      .select({
        title: issues.title,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({
      title: "Recovered execution lock",
      checkoutRunId: currentRunId,
      executionRunId: currentRunId,
    });

    const runs = await db
      .select({
        id: heartbeatRuns.id,
        status: heartbeatRuns.status,
        errorCode: heartbeatRuns.errorCode,
      })
      .from(heartbeatRuns)
      .where(inArray(heartbeatRuns.id, [
        staleContext.queuedRunId,
        staleContext.scheduledRunId,
        staleContext.runningRunId,
      ]));
    expect(Object.fromEntries(runs.map((run) => [run.id, {
      status: run.status,
      errorCode: run.errorCode,
    }]))).toEqual({
      [staleContext.queuedRunId]: {
        status: "cancelled",
        errorCode: "issue_checkout_adopted",
      },
      [staleContext.scheduledRunId]: {
        status: "cancelled",
        errorCode: "issue_checkout_adopted",
      },
      [staleContext.runningRunId]: {
        status: "running",
        errorCode: null,
      },
    });
  });

  it("allows a same-agent current run to close an issue owned by a stale adapter_failed checkout run", async () => {
    const { companyId, agentId, failedRunId, currentRunId } = await seedCompanyAgentAndRuns({
      staleRunStatus: "adapter_failed",
    });
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Routine close after adapter wedge",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: failedRunId,
      executionRunId: failedRunId,
      executionAgentNameKey: "codexcoder",
      executionLockedAt: new Date(),
    });

    const res = await request(createApp(agentActor(companyId, agentId, currentRunId)))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "done" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe("done");

    const row = await db
      .select({
        status: issues.status,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({
      status: "done",
      checkoutRunId: null,
      executionRunId: null,
    });
  });

  it("allows a same-agent active issue-scoped run to adopt mismatched live run ownership", async () => {
    const { companyId, agentId, failedRunId, currentRunId } = await seedCompanyAgentAndRuns({
      staleRunStatus: "running",
    });
    const issueId = randomUUID();
    await db
      .update(heartbeatRuns)
      .set({ contextSnapshot: { issueId } })
      .where(eq(heartbeatRuns.id, currentRunId));
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Routine close from active scoped run",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: failedRunId,
      executionRunId: failedRunId,
      executionAgentNameKey: "codexcoder",
      executionLockedAt: new Date(),
    });

    const res = await request(createApp(agentActor(companyId, agentId, currentRunId)))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "done" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe("done");

    const row = await db
      .select({
        status: issues.status,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({
      status: "done",
      checkoutRunId: null,
      executionRunId: null,
    });
  });

  it("rejects stale output after a newer active issue-scoped run adopts ownership", async () => {
    const { companyId, agentId, failedRunId, currentRunId } = await seedCompanyAgentAndRuns({
      staleRunStatus: "running",
    });
    const issueId = randomUUID();
    await db
      .update(heartbeatRuns)
      .set({ contextSnapshot: { issueId } })
      .where(inArray(heartbeatRuns.id, [failedRunId, currentRunId]));
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Active run adoption race",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: failedRunId,
      executionRunId: failedRunId,
      executionAgentNameKey: "codexcoder",
      executionLockedAt: new Date(),
    });

    const newerRunRes = await request(createApp(agentActor(companyId, agentId, currentRunId)))
      .patch(`/api/issues/${issueId}`)
      .send({ title: "claimed by newer run" });

    expect(newerRunRes.status, JSON.stringify(newerRunRes.body)).toBe(200);
    expect(newerRunRes.body.title).toBe("claimed by newer run");

    const staleRunRes = await request(createApp(agentActor(companyId, agentId, failedRunId)))
      .patch(`/api/issues/${issueId}`)
      .send({ title: "older stale output" });

    expect(staleRunRes.status, JSON.stringify(staleRunRes.body)).toBe(409);
    expect(staleRunRes.body.error).toBe("Issue run ownership conflict");

    const row = await db
      .select({
        title: issues.title,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({
      title: "claimed by newer run",
      checkoutRunId: currentRunId,
      executionRunId: currentRunId,
    });
  });

  it("lets an active issue-scoped routine publish a sweep comment then close its run issue", async () => {
    const { companyId, agentId, failedRunId, currentRunId } = await seedCompanyAgentAndRuns({
      staleRunStatus: "running",
    });
    const routineIssueId = randomUUID();
    const sweepTargetIssueId = randomUUID();
    await db
      .update(heartbeatRuns)
      .set({ contextSnapshot: { issueId: routineIssueId } })
      .where(eq(heartbeatRuns.id, currentRunId));
    await db.insert(issues).values([
      {
        id: routineIssueId,
        companyId,
        title: "Agent health & stalled-issue check",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: agentId,
        checkoutRunId: failedRunId,
        executionRunId: failedRunId,
        executionAgentNameKey: "codexcoder",
        executionLockedAt: new Date(),
      },
      {
        id: sweepTargetIssueId,
        companyId,
        title: "[Sweep] Agent health & stalled-issue alerts",
        status: "done",
        priority: "medium",
        assigneeAgentId: agentId,
      },
    ]);

    const app = createApp(agentActor(companyId, agentId, currentRunId));
    const commentRes = await request(app)
      .post(`/api/issues/${sweepTargetIssueId}/comments`)
      .send({ body: "sweep complete" });
    expect(commentRes.status, JSON.stringify(commentRes.body)).toBe(201);

    const closeRes = await request(app)
      .patch(`/api/issues/${routineIssueId}`)
      .send({ status: "done" });
    expect(closeRes.status, JSON.stringify(closeRes.body)).toBe(200);
    expect(closeRes.body.status).toBe("done");

    const comment = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, sweepTargetIssueId))
      .then((rows) => rows[0]);
    expect(comment?.body).toBe("sweep complete");
  });

  it("keeps live different-run ownership protected", async () => {
    const { companyId, agentId, failedRunId, currentRunId } = await seedCompanyAgentAndRuns({
      staleRunStatus: "running",
    });
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Live run conflict",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: failedRunId,
      executionRunId: failedRunId,
      executionAgentNameKey: "codexcoder",
      executionLockedAt: new Date(),
    });

    const res = await request(createApp(agentActor(companyId, agentId, currentRunId)))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "done" });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error).toBe("Issue run ownership conflict");
  });

  it("allows the rightful assignee to release after the owning run failed", async () => {
    const { companyId, agentId, failedRunId, currentRunId } = await seedCompanyAgentAndRuns();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Failed run release",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: failedRunId,
      executionRunId: failedRunId,
      executionAgentNameKey: "codexcoder",
      executionLockedAt: new Date(),
    });

    const res = await request(createApp(agentActor(companyId, agentId, currentRunId)))
      .post(`/api/issues/${issueId}/release`)
      .send();

    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const row = await db
      .select({
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
        executionLockedAt: issues.executionLockedAt,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({
      status: "todo",
      assigneeAgentId: null,
      checkoutRunId: null,
      executionRunId: null,
      executionLockedAt: null,
    });
  });

  it("cancels queued and scheduled issue-context runs when releasing an issue", async () => {
    const { companyId, agentId, currentRunId } = await seedCompanyAgentAndRuns();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Release stale queue cleanup",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: currentRunId,
      executionRunId: currentRunId,
      executionAgentNameKey: "codexcoder",
      executionLockedAt: new Date(),
    });
    const staleContext = await seedQueuedIssueContextRuns({ companyId, agentId, issueId });

    const res = await request(createApp(agentActor(companyId, agentId, currentRunId)))
      .post(`/api/issues/${issueId}/release`)
      .send();

    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const runs = await db
      .select({
        id: heartbeatRuns.id,
        status: heartbeatRuns.status,
        errorCode: heartbeatRuns.errorCode,
      })
      .from(heartbeatRuns)
      .where(inArray(heartbeatRuns.id, [
        staleContext.queuedRunId,
        staleContext.scheduledRunId,
        staleContext.runningRunId,
      ]));
    expect(Object.fromEntries(runs.map((run) => [run.id, {
      status: run.status,
      errorCode: run.errorCode,
    }]))).toEqual({
      [staleContext.queuedRunId]: {
        status: "cancelled",
        errorCode: "issue_released",
      },
      [staleContext.scheduledRunId]: {
        status: "cancelled",
        errorCode: "issue_released",
      },
      [staleContext.runningRunId]: {
        status: "running",
        errorCode: null,
      },
    });

    const wakeups = await db
      .select({
        id: agentWakeupRequests.id,
        status: agentWakeupRequests.status,
        error: agentWakeupRequests.error,
      })
      .from(agentWakeupRequests)
      .where(inArray(agentWakeupRequests.id, [
        staleContext.queuedWakeupId,
        staleContext.scheduledWakeupId,
      ]));
    expect(Object.fromEntries(wakeups.map((wakeup) => [wakeup.id, {
      status: wakeup.status,
      error: wakeup.error,
    }]))).toEqual({
      [staleContext.queuedWakeupId]: {
        status: "skipped",
        error: "Cancelled because the issue was released",
      },
      [staleContext.scheduledWakeupId]: {
        status: "skipped",
        error: "Cancelled because the issue was released",
      },
    });
  });

  it("lets the current assignee recover a timed_out stale checkout owner during PATCH", async () => {
    const { companyId, agentId, currentRunId } = await seedCompanyAgentAndRuns();
    const timedOutRunId = randomUUID();
    const issueId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: timedOutRunId,
      companyId,
      agentId,
      status: "timed_out",
      invocationSource: "manual",
      finishedAt: new Date(),
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Stale checkout lock",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: timedOutRunId,
      executionRunId: timedOutRunId,
      executionAgentNameKey: "codexcoder",
      executionLockedAt: new Date(),
    });

    const res = await request(createApp(agentActor(companyId, agentId, currentRunId)))
      .patch(`/api/issues/${issueId}`)
      .send({ title: "Recovered stale checkout lock" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const row = await db
      .select({
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({
      checkoutRunId: currentRunId,
      executionRunId: currentRunId,
    });
  });

  it("still returns 409 when a different live checkout owner is active", async () => {
    const { companyId, agentId, failedRunId } = await seedCompanyAgentAndRuns();
    const liveOwnerRunId = randomUUID();
    const issueId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: liveOwnerRunId,
      companyId,
      agentId,
      status: "running",
      invocationSource: "manual",
      startedAt: new Date(),
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Live checkout lock",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: liveOwnerRunId,
      executionRunId: liveOwnerRunId,
      executionAgentNameKey: "codexcoder",
      executionLockedAt: new Date(),
    });

    const res = await request(createApp(agentActor(companyId, agentId, failedRunId)))
      .patch(`/api/issues/${issueId}`)
      .send({ title: "Should fail" });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body?.error).toBe("Issue run ownership conflict");
  });

  it("preserves live checkout ownership on checkout conflicts without retry side effects", async () => {
    const { companyId, agentId, currentRunId } = await seedCompanyAgentAndRuns();
    const contenderRunId = randomUUID();
    const issueId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: contenderRunId,
      companyId,
      agentId,
      status: "running",
      invocationSource: "assignment",
      startedAt: new Date(),
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Live checkout race",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: currentRunId,
      executionRunId: currentRunId,
      executionAgentNameKey: "codexcoder",
      executionLockedAt: new Date(),
    });

    const res = await request(createApp(agentActor(companyId, agentId, contenderRunId)))
      .post(`/api/issues/${issueId}/checkout`)
      .send({
        agentId,
        expectedStatuses: ["todo", "backlog", "blocked", "in_review"],
      });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body).toMatchObject({
      error: "Issue checkout conflict",
    });

    const row = await db
      .select({
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({
      status: "in_progress",
      assigneeAgentId: agentId,
      checkoutRunId: currentRunId,
      executionRunId: currentRunId,
    });

    const checkoutActivity = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "issue.checked_out"));
    expect(checkoutActivity).toHaveLength(0);
  });

  it("restricts admin force-release to board users with company access and writes an audit event", async () => {
    const { companyId, agentId, failedRunId, currentRunId } = await seedCompanyAgentAndRuns();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Admin force release",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: currentRunId,
      executionRunId: failedRunId,
      executionAgentNameKey: "codexcoder",
      executionLockedAt: new Date(),
    });

    await request(createApp(agentActor(companyId, agentId, currentRunId)))
      .post(`/api/issues/${issueId}/admin/force-release`)
      .expect(403);
    await request(createApp({
      type: "board",
      userId: "outside-user",
      companyIds: [],
      memberships: [],
      isInstanceAdmin: false,
      source: "session",
    }))
      .post(`/api/issues/${issueId}/admin/force-release`)
      .expect(404);

    const res = await request(createApp(boardActor(companyId)))
      .post(`/api/issues/${issueId}/admin/force-release?clearAssignee=true`)
      .send();

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.issue).toMatchObject({
      id: issueId,
      assigneeAgentId: null,
      checkoutRunId: null,
      executionRunId: null,
      executionLockedAt: null,
    });
    expect(res.body.previous).toEqual({
      checkoutRunId: currentRunId,
      executionRunId: failedRunId,
    });

    const audit = await db
      .select({
        action: activityLog.action,
        actorType: activityLog.actorType,
        actorId: activityLog.actorId,
        details: activityLog.details,
      })
      .from(activityLog)
      .where(eq(activityLog.action, "issue.admin_force_release"))
      .then((rows) => rows[0]);
    expect(audit).toMatchObject({
      action: "issue.admin_force_release",
      actorType: "user",
      actorId: "board-user",
      details: {
        issueId,
        actorUserId: "board-user",
        prevCheckoutRunId: currentRunId,
        prevExecutionRunId: failedRunId,
        clearAssignee: true,
      },
    });
  });

  it("self-heals a stale checkoutRunId via clearCheckoutRunIfTerminal on checkout (Fix B path)", async () => {
    // Reproduces the recurrence pattern: prior owning run died, executionRunId
    // was cleared by releaseIssueExecutionAndPromote, but checkoutRunId stayed
    // pinned to the dead run. The new agent's POST /checkout would 409 forever
    // without the clearCheckoutRunIfTerminal helper in svc.checkout.
    const { companyId, agentId, failedRunId, currentRunId } = await seedCompanyAgentAndRuns();
    const issueId = randomUUID();
    const otherAgentId = randomUUID();
    await db.insert(agents).values({
      id: otherAgentId,
      companyId,
      name: "OtherAgent",
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
      title: "Stale checkout lock after reassignment",
      // Status off in_progress + checkoutRunId still set — adoptStaleCheckoutRun
      // cannot recover from this; only clearCheckoutRunIfTerminal can.
      status: "todo",
      priority: "high",
      assigneeAgentId: otherAgentId,
      checkoutRunId: failedRunId,
      executionRunId: null,
      executionAgentNameKey: null,
      executionLockedAt: null,
    });

    const res = await request(createApp(agentActor(companyId, otherAgentId, currentRunId)))
      .post(`/api/issues/${issueId}/checkout`)
      .send({
        agentId: otherAgentId,
        expectedStatuses: ["todo", "backlog", "blocked", "in_review"],
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const row = await db
      .select({
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({
      status: "in_progress",
      assigneeAgentId: otherAgentId,
      checkoutRunId: currentRunId,
      executionRunId: currentRunId,
    });
  });

  it("atomically checks out an unlocked assigned in_review issue (BLO-18858)", async () => {
    const { companyId, agentId, currentRunId } = await seedCompanyAgentAndRuns();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Review follow-up needs edits",
      status: "in_review",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: null,
      executionRunId: null,
      executionAgentNameKey: null,
      executionLockedAt: null,
    });

    const res = await request(createApp(agentActor(companyId, agentId, currentRunId)))
      .post(`/api/issues/${issueId}/checkout`)
      .send({
        agentId,
        expectedStatuses: ["todo", "backlog", "blocked", "in_review"],
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe("in_progress");
    expect(res.body.checkoutRunId).toBe(currentRunId);
    expect(res.body.executionRunId).toBe(currentRunId);

    const row = await db
      .select({
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({
      status: "in_progress",
      assigneeAgentId: agentId,
      checkoutRunId: currentRunId,
      executionRunId: currentRunId,
    });
  });

  it("does not let agent checkout seize an in_review issue assigned to a human reviewer", async () => {
    const { companyId, agentId, currentRunId } = await seedCompanyAgentAndRuns();
    const issueId = randomUUID();
    const reviewerUserId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Human review handoff",
      status: "in_review",
      priority: "high",
      assigneeAgentId: null,
      assigneeUserId: reviewerUserId,
      checkoutRunId: null,
      executionRunId: null,
      executionAgentNameKey: null,
      executionLockedAt: null,
    });

    const res = await request(createApp(agentActor(companyId, agentId, currentRunId)))
      .post(`/api/issues/${issueId}/checkout`)
      .send({
        agentId,
        expectedStatuses: ["todo", "backlog", "blocked", "in_review"],
      });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error).toBe("Issue checkout conflict");

    const row = await db
      .select({
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        assigneeUserId: issues.assigneeUserId,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({
      status: "in_review",
      assigneeAgentId: null,
      assigneeUserId: reviewerUserId,
      checkoutRunId: null,
      executionRunId: null,
    });
  });

  it("clears but does not adopt a stale execution lock on an in_review issue assigned to a human reviewer", async () => {
    const { companyId, agentId, failedRunId, currentRunId } = await seedCompanyAgentAndRuns();
    const issueId = randomUUID();
    const reviewerUserId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Human review stale execution lock",
      status: "in_review",
      priority: "high",
      assigneeAgentId: null,
      assigneeUserId: reviewerUserId,
      checkoutRunId: null,
      executionRunId: failedRunId,
      executionAgentNameKey: "codexcoder",
      executionLockedAt: new Date("2026-01-01T00:00:30.000Z"),
    });

    const res = await request(createApp(agentActor(companyId, agentId, currentRunId)))
      .post(`/api/issues/${issueId}/checkout`)
      .send({
        agentId,
        expectedStatuses: ["todo", "backlog", "blocked", "in_review"],
      });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error).toBe("Issue checkout conflict");

    const row = await db
      .select({
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        assigneeUserId: issues.assigneeUserId,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({
      status: "in_review",
      assigneeAgentId: null,
      assigneeUserId: reviewerUserId,
      checkoutRunId: null,
      executionRunId: null,
    });
  });

  it("lets a drifted pending-stage participant claim the lock and excludes other runs", async () => {
    const { companyId, agentId, currentRunId } = await seedCompanyAgentAndRuns();
    const issueId = randomUUID();
    const stageId = randomUUID();
    const driftedAssigneeAgentId = randomUUID();
    const driftedAssigneeRunId = randomUUID();
    const competingRunId = randomUUID();
    const participant = { type: "agent" as const, agentId, userId: null };
    await db.insert(agents).values({
      id: driftedAssigneeAgentId,
      companyId,
      name: "DriftedAssignee",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values([
      {
        id: competingRunId,
        companyId,
        agentId,
        status: "running",
        invocationSource: "manual",
        startedAt: new Date(),
        createdAt: new Date("2026-01-01T00:02:00.000Z"),
      },
      {
        id: driftedAssigneeRunId,
        companyId,
        agentId: driftedAssigneeAgentId,
        status: "running",
        invocationSource: "manual",
        startedAt: new Date(),
        createdAt: new Date("2026-01-01T00:03:00.000Z"),
      },
    ]);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Review stage awaiting approval",
      status: "in_review",
      priority: "high",
      assigneeAgentId: driftedAssigneeAgentId,
      checkoutRunId: null,
      executionRunId: null,
      executionAgentNameKey: null,
      executionLockedAt: null,
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [
          {
            id: stageId,
            type: "review",
            approvalsNeeded: 1,
            participants: [{ id: randomUUID(), ...participant }],
          },
        ],
      },
      executionState: {
        status: "pending",
        currentStageId: stageId,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: participant,
        returnAssignee: participant,
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
        monitor: null,
      },
    });

    const assigneeCheckout = await request(
      createApp(agentActor(companyId, driftedAssigneeAgentId, driftedAssigneeRunId)),
    )
      .post(`/api/issues/${issueId}/checkout`)
      .send({
        agentId: driftedAssigneeAgentId,
        expectedStatuses: ["todo", "backlog", "blocked", "in_review"],
      });
    expect(assigneeCheckout.status, JSON.stringify(assigneeCheckout.body)).toBe(409);

    const checkout = await request(createApp(agentActor(companyId, agentId, currentRunId)))
      .post(`/api/issues/${issueId}/checkout`)
      .send({
        agentId,
        expectedStatuses: ["todo", "backlog", "blocked", "in_review"],
      });

    expect(checkout.status, JSON.stringify(checkout.body)).toBe(200);
    expect(checkout.body.status).toBe("in_review");
    expect(checkout.body.assigneeAgentId).toBe(driftedAssigneeAgentId);
    expect(checkout.body.checkoutRunId).toBe(currentRunId);
    expect(checkout.body.executionRunId).toBe(currentRunId);

    const competingPatch = await request(createApp(agentActor(companyId, agentId, competingRunId)))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "done", comment: "Approve from the wrong run" });
    expect(competingPatch.status, JSON.stringify(competingPatch.body)).toBe(409);
    expect(competingPatch.body.error).toBe("Issue run ownership conflict");

    const competingApproval = await request(createApp(agentActor(companyId, agentId, competingRunId)))
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "kind: review\ndecision: approved" });
    expect(competingApproval.status, JSON.stringify(competingApproval.body)).toBe(409);
    expect(competingApproval.body.error).toBe("Issue run ownership conflict");

    const prematureDecisions = await db
      .select({ id: issueExecutionDecisions.id })
      .from(issueExecutionDecisions)
      .where(eq(issueExecutionDecisions.issueId, issueId));
    expect(prematureDecisions).toEqual([]);

    const approval = await request(createApp(agentActor(companyId, agentId, currentRunId)))
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "kind: review\ndecision: approved" });

    expect(approval.status, JSON.stringify(approval.body)).toBe(201);

    const row = await db
      .select({
        status: issues.status,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
        executionState: issues.executionState,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row?.status).toBe("done");
    expect(row?.checkoutRunId).toBeNull();
    expect(row?.executionRunId).toBeNull();
    expect(row?.executionState).toMatchObject({
      status: "completed",
      completedStageIds: [stageId],
      lastDecisionOutcome: "approved",
    });

    const decisions = await db
      .select({
        issueId: issueExecutionDecisions.issueId,
        stageId: issueExecutionDecisions.stageId,
        outcome: issueExecutionDecisions.outcome,
        actorAgentId: issueExecutionDecisions.actorAgentId,
        createdByRunId: issueExecutionDecisions.createdByRunId,
      })
      .from(issueExecutionDecisions)
      .where(eq(issueExecutionDecisions.issueId, issueId));
    expect(decisions).toEqual([
      {
        issueId,
        stageId,
        outcome: "approved",
        actorAgentId: agentId,
        createdByRunId: currentRunId,
      },
    ]);
  });

  it("409s a second live run of the SAME agent checking out an in_review issue (BLO-18858)", async () => {
    // The duplicate-work incident: two concurrent runs of one agent worked the same
    // in_review issue because the second run never called checkout. Assert the guard it
    // skipped actually fires — the execution lock is run-scoped, so a live run of the
    // *same* agent conflicts exactly like a foreign agent would, and in_review does not
    // exempt the issue from that lock.
    const { companyId, agentId, failedRunId: liveOwnerRunId, currentRunId } = await seedCompanyAgentAndRuns({
      staleRunStatus: "running",
    });
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Wireframes for NMS",
      status: "in_review",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: liveOwnerRunId,
      executionRunId: liveOwnerRunId,
      executionAgentNameKey: "codexcoder",
      executionLockedAt: new Date(),
    });

    const res = await request(createApp(agentActor(companyId, agentId, currentRunId)))
      .post(`/api/issues/${issueId}/checkout`)
      .send({
        agentId,
        expectedStatuses: ["todo", "backlog", "blocked", "in_review"],
      });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error).toBe("Issue checkout conflict");

    // The live owner keeps the lock; the losing run must not have stolen or cleared it.
    const row = await db
      .select({
        status: issues.status,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({
      status: "in_review",
      checkoutRunId: liveOwnerRunId,
      executionRunId: liveOwnerRunId,
    });
  });

  // BLO-19848 end-to-end: the assignee must be able to transition an issue whose
  // executionRunId is pinned by a non-live run, without a board user or a manual
  // reconciler. This is the BLO-18307 shape — checkout and execution both name
  // one run parked at `scheduled_retry` — which returned 409 to three close
  // attempts over ~1d7h while the issue's fix was already merged.
  it("lets the assignee transition after the sweeper reclaims a scheduled_retry lock (BLO-19848)", async () => {
    const { companyId, agentId, currentRunId } = await seedCompanyAgentAndRuns();
    const wedgedRunId = randomUUID();
    const issueId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: wedgedRunId,
      companyId,
      agentId,
      status: "scheduled_retry",
      invocationSource: "automation",
      startedAt: null,
      // Retry deadline itself went stale 7h ago, past the 6h pre-claim bound.
      scheduledRetryAt: new Date(Date.now() - 7 * 60 * 60 * 1000),
      scheduledRetryAttempt: 1,
      scheduledRetryReason: "ccrotate_capacity",
      createdAt: new Date("2026-01-01T00:00:30.000Z"),
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Wedged behind a scheduled retry",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: wedgedRunId,
      executionRunId: wedgedRunId,
      executionAgentNameKey: "codexcoder",
      executionLockedAt: new Date(Date.now() - 31 * 60 * 60 * 1000),
    });

    // Before the reconcile window elapses the lock is honoured, which is the
    // intended behaviour — a parked retry is not reclaimed on sight.
    const wedged = await request(createApp(agentActor(companyId, agentId, currentRunId)))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "done" });
    expect(wedged.status).toBe(409);
    expect(wedged.body?.error ?? wedged.body?.message).toContain("Issue run ownership conflict");

    const { heartbeatService } = await import("../services/heartbeat.ts");
    const sweep = await heartbeatService(db).sweepStaleIssueLocks();
    expect(sweep.cleared).toBe(1);

    const recovered = await request(createApp(agentActor(companyId, agentId, currentRunId)))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "done" });
    expect(recovered.status, JSON.stringify(recovered.body)).toBe(200);
    expect(recovered.body.status).toBe("done");

    // The wedged run row is left alone — reclaiming the lock must not cancel it.
    const run = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, wedgedRunId))
      .then((rows) => rows[0]);
    expect(run?.status).toBe("scheduled_retry");
  });
});
