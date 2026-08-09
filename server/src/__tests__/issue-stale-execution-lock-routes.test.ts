import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  companyMemberships,
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
import { issueService } from "../services/issues.js";

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
    await db.delete(issueExecutionDecisions);
    await db.delete(issueRelations);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agents);
    await db.delete(companyMemberships);
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

  async function seedUnlockedAssignedReview() {
    const { companyId, agentId, currentRunId } = await seedCompanyAgentAndRuns();
    const competingRunId = randomUUID();
    const issueId = randomUUID();
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
      title: "Unlocked assigned review",
      status: "in_review",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: null,
      executionRunId: null,
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

  it("rejects an ordinary unlocked in_review delete after another run checks out", async () => {
    const seeded = await seedUnlockedAssignedReview();
    const authorized = deferred();
    const continueWrite = deferred();
    const staleDelete = request(createApp(
      agentActor(seeded.companyId, seeded.agentId, seeded.currentRunId),
      {
        pendingInReviewMutationBeforeGuardHook: async () => {
          authorized.resolve();
          await continueWrite.promise;
        },
      },
    ))
      .delete(`/api/issues/${seeded.issueId}`)
      .then((response) => response);

    await authorized.promise;
    const checkout = await request(createApp(
      agentActor(seeded.companyId, seeded.agentId, seeded.competingRunId),
    ))
      .post(`/api/issues/${seeded.issueId}/checkout`)
      .send({ agentId: seeded.agentId, expectedStatuses: ["in_review"] });
    expect(checkout.status, JSON.stringify(checkout.body)).toBe(200);

    continueWrite.resolve();
    const deleted = await staleDelete;
    expect(deleted.status, JSON.stringify(deleted.body)).toBe(409);
    expect(deleted.body.error).toBe("Issue run ownership conflict");

    const row = await db
      .select({
        status: issues.status,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, seeded.issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({
      status: "in_progress",
      checkoutRunId: seeded.competingRunId,
      executionRunId: seeded.competingRunId,
    });
  });

  it("allows an ordinary unlocked in_review PATCH when its ownership receipt still matches", async () => {
    const seeded = await seedUnlockedAssignedReview();

    const patch = await request(createApp(
      agentActor(seeded.companyId, seeded.agentId, seeded.currentRunId),
    ))
      .patch(`/api/issues/${seeded.issueId}`)
      .send({ title: "Ordinary review updated by its assignee" });

    expect(patch.status, JSON.stringify(patch.body)).toBe(200);
    expect(patch.body.title).toBe("Ordinary review updated by its assignee");

    const row = await db
      .select({
        title: issues.title,
        assigneeAgentId: issues.assigneeAgentId,
        assigneeUserId: issues.assigneeUserId,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, seeded.issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({
      title: "Ordinary review updated by its assignee",
      assigneeAgentId: seeded.agentId,
      assigneeUserId: null,
      checkoutRunId: null,
      executionRunId: null,
    });
  });

  it("rejects a stale ordinary in_review PATCH after the board reassigns both owners", async () => {
    const seeded = await seedUnlockedAssignedReview();
    const reassigneeUserId = randomUUID();
    await db.insert(companyMemberships).values([
      {
        companyId: seeded.companyId,
        principalType: "user",
        principalId: "board-user",
        status: "active",
        membershipRole: "admin",
      },
      {
        companyId: seeded.companyId,
        principalType: "user",
        principalId: reassigneeUserId,
        status: "active",
        membershipRole: "member",
      },
    ]);
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
      .send({ title: "Stale assignee update" })
      .then((response) => response);

    await authorized.promise;
    const reassignment = await request(createApp(boardActor(seeded.companyId)))
      .patch(`/api/issues/${seeded.issueId}`)
      .send({ assigneeAgentId: null, assigneeUserId: reassigneeUserId });
    expect(reassignment.status, JSON.stringify(reassignment.body)).toBe(200);

    continueWrite.resolve();
    const patch = await stalePatch;
    expect(patch.status, JSON.stringify(patch.body)).toBe(409);
    expect(patch.body.error).toBe("Issue run ownership conflict");

    const row = await db
      .select({
        title: issues.title,
        assigneeAgentId: issues.assigneeAgentId,
        assigneeUserId: issues.assigneeUserId,
      })
      .from(issues)
      .where(eq(issues.id, seeded.issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({
      title: "Unlocked assigned review",
      assigneeAgentId: null,
      assigneeUserId: reassigneeUserId,
    });
  });

  it("atomically rejects a bundled PATCH when checkout wins before its ownership transaction", async () => {
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
      .send({ title: "Updated before checkout", comment: "Bundled stale comment" })
      .then((response) => response);

    await authorized.promise;
    const checkout = await request(createApp(
      agentActor(seeded.companyId, seeded.agentId, seeded.competingRunId),
    ))
      .post(`/api/issues/${seeded.issueId}/checkout`)
      .send({ agentId: seeded.agentId, expectedStatuses: ["in_review"] });
    expect(checkout.status, JSON.stringify(checkout.body)).toBe(200);

    continueWrite.resolve();
    const patch = await stalePatch;
    expect(patch.status, JSON.stringify(patch.body)).toBe(409);
    expect(patch.body.error).toBe("Issue run ownership conflict");
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, seeded.issueId))).toEqual([]);

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

  it("rejects a post-adoption stale PATCH when ownership transfers before the final write", async () => {
    const { companyId, agentId, failedRunId, currentRunId } = await seedCompanyAgentAndRuns();
    const nextRunId = randomUUID();
    const issueId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: nextRunId,
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
      title: "Post-adoption transfer",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: failedRunId,
      executionRunId: failedRunId,
      executionAgentNameKey: "codexcoder",
      executionLockedAt: new Date(),
    });

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS test_post_adoption_transfer_config (
        issue_id uuid PRIMARY KEY,
        next_run_id uuid NOT NULL
      )
    `);
    await db.execute(sql`
      INSERT INTO test_post_adoption_transfer_config (issue_id, next_run_id)
      VALUES (${issueId}, ${nextRunId})
      ON CONFLICT (issue_id) DO UPDATE SET next_run_id = EXCLUDED.next_run_id
    `);
    await db.execute(sql`
      CREATE OR REPLACE FUNCTION test_transfer_issue_after_adoption()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      DECLARE
        configured_next_run_id uuid;
      BEGIN
        SELECT next_run_id
        INTO configured_next_run_id
        FROM test_post_adoption_transfer_config
        WHERE issue_id = NEW.id;

        IF configured_next_run_id IS NOT NULL
           AND NEW.checkout_run_id IS DISTINCT FROM configured_next_run_id THEN
          UPDATE issues
          SET checkout_run_id = configured_next_run_id,
              execution_run_id = configured_next_run_id,
              execution_locked_at = now(),
              updated_at = now()
          WHERE id = NEW.id;
        END IF;

        RETURN NEW;
      END;
      $$;
    `);
    await db.execute(sql`
      DROP TRIGGER IF EXISTS test_transfer_issue_after_adoption ON issues
    `);
    await db.execute(sql`
      CREATE TRIGGER test_transfer_issue_after_adoption
      AFTER UPDATE OF checkout_run_id ON issues
      FOR EACH ROW
      WHEN (OLD.checkout_run_id IS DISTINCT FROM NEW.checkout_run_id)
      EXECUTE FUNCTION test_transfer_issue_after_adoption()
    `);

    try {
      const res = await request(createApp(agentActor(companyId, agentId, currentRunId)))
        .patch(`/api/issues/${issueId}`)
        .send({ title: "Stale post-adoption write" });

      expect(res.status, JSON.stringify(res.body)).toBe(409);

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
        title: "Post-adoption transfer",
        checkoutRunId: nextRunId,
        executionRunId: nextRunId,
      });
    } finally {
      await db.execute(sql`DROP TRIGGER IF EXISTS test_transfer_issue_after_adoption ON issues`);
      await db.execute(sql`DROP FUNCTION IF EXISTS test_transfer_issue_after_adoption()`);
      await db.execute(sql`DROP TABLE IF EXISTS test_post_adoption_transfer_config`);
    }
  });

  it("allows an assigned agent PATCH while another wake is only queued", async () => {
    const { companyId, agentId, currentRunId } = await seedCompanyAgentAndRuns();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Queued wake without execution ownership",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
      executionRunId: null,
    });
    const queuedWakeupId = randomUUID();
    const queuedRunId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: queuedWakeupId,
      companyId,
      agentId,
      source: "assignment",
      status: "queued",
      runId: queuedRunId,
    });
    await db.insert(heartbeatRuns).values({
      id: queuedRunId,
      companyId,
      agentId,
      status: "queued",
      invocationSource: "assignment",
      wakeupRequestId: queuedWakeupId,
      contextSnapshot: { issueId },
    });

    const res = await request(createApp(agentActor(companyId, agentId, currentRunId)))
      .patch(`/api/issues/${issueId}`)
      .send({ title: "Assignee can still update" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.title).toBe("Assignee can still update");
    const queuedRun = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, queuedRunId))
      .then((rows) => rows[0] ?? null);
    expect(queuedRun?.status).not.toBe("running");
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
    const { companyId, failedRunId } = await seedCompanyAgentAndRuns();
    const issueId = randomUUID();
    const otherAgentId = randomUUID();
    const otherRunId = randomUUID();
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
    await db.insert(heartbeatRuns).values({
      id: otherRunId,
      companyId,
      agentId: otherAgentId,
      status: "running",
      invocationSource: "on_demand",
      triggerDetail: "manual",
      contextSnapshot: { issueId },
      startedAt: new Date(),
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

    const res = await request(createApp(agentActor(companyId, otherAgentId, otherRunId)))
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
      checkoutRunId: otherRunId,
      executionRunId: otherRunId,
    });
  });

  it("does not stamp executionRunId when checkout's actor run finalizes while waiting on the issue row", async () => {
    const { companyId, agentId, currentRunId } = await seedCompanyAgentAndRuns();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Checkout run finalized while waiting",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: null,
      executionRunId: null,
      executionAgentNameKey: null,
      executionLockedAt: null,
    });

    let releaseIssueLock!: () => void;
    let issueLockHeld!: () => void;
    const issueLockHeldPromise = new Promise<void>((resolve) => {
      issueLockHeld = resolve;
    });
    const releaseIssueLockPromise = new Promise<void>((resolve) => {
      releaseIssueLock = resolve;
    });
    const lockTransaction = db.transaction(async (tx) => {
      await tx
        .select({ id: issues.id })
        .from(issues)
        .where(eq(issues.id, issueId))
        .for("update");
      issueLockHeld();
      await releaseIssueLockPromise;
    });

    await issueLockHeldPromise;
    const checkoutPromise = issueService(db).checkout(
      issueId,
      agentId,
      ["todo", "backlog", "blocked"],
      currentRunId,
    );

    await new Promise((resolve) => setTimeout(resolve, 100));
    await db
      .update(heartbeatRuns)
      .set({
        status: "succeeded",
        finishedAt: new Date(),
      })
      .where(eq(heartbeatRuns.id, currentRunId));

    releaseIssueLock();
    await expect(checkoutPromise).rejects.toMatchObject({ status: 409 });
    await lockTransaction;

    const issue = await db
      .select({ status: issues.status, checkoutRunId: issues.checkoutRunId, executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue).toEqual({
      status: "todo",
      checkoutRunId: null,
      executionRunId: null,
    });
  });

  it("does not return idempotent checkout success when the existing owner run finalizes", async () => {
    const { companyId, agentId, currentRunId } = await seedCompanyAgentAndRuns();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Existing checkout owner finalized while waiting",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: currentRunId,
      executionRunId: currentRunId,
      executionAgentNameKey: "test-agent",
      executionLockedAt: new Date(),
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
    const checkoutPromise = issueService(db).checkout(
      issueId,
      agentId,
      ["todo", "backlog", "blocked"],
      currentRunId,
    );

    await new Promise((resolve) => setTimeout(resolve, 100));
    await db
      .update(heartbeatRuns)
      .set({ status: "succeeded", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, currentRunId));

    releaseIssueLock();
    await expect(checkoutPromise).rejects.toMatchObject({ status: 409 });
    await lockTransaction;
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
  // checkout and execution locks both name a never-started scheduled retry,
  // without waiting for a board user or a manual reconciler.
  it("lets the assignee transition after reaping a scheduled_retry lock (BLO-19848)", async () => {
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

    const recovered = await request(createApp(agentActor(companyId, agentId, currentRunId)))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "done" });
    expect(recovered.status, JSON.stringify(recovered.body)).toBe(200);
    expect(recovered.body.status).toBe("done");

    // Reaping prevents the never-started owner from later starting against a
    // status that the assignee has already transitioned.
    const run = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, wedgedRunId))
      .then((rows) => rows[0]);
    expect(run?.status).toBe("cancelled");
  });

  // BLO-20321: a run that exists but has never executed (`queued` /
  // `scheduled_retry`, startedAt null) is non-terminal, so the old
  // terminal-only staleness test treated it as a live owner and answered the
  // assignee's own write with 409. That made WIP monotonic — checkout adds WIP
  // without a lock, parking or closing needs one, and the lock was held by the
  // very queue backlog being drained.
  describe("never-started execution lock owners (BLO-20321)", () => {
    async function seedIssueOwnedByRun(input: {
      companyId: string;
      agentId: string;
      ownerRunId: string;
      title: string;
    }) {
      const issueId = randomUUID();
      await db.insert(issues).values({
        id: issueId,
        companyId: input.companyId,
        title: input.title,
        status: "in_progress",
        priority: "high",
        assigneeAgentId: input.agentId,
        checkoutRunId: input.ownerRunId,
        executionRunId: input.ownerRunId,
        executionAgentNameKey: "codexcoder",
        executionLockedAt: new Date(),
      });
      return issueId;
    }

    async function seedNeverStartedOwnerRun(input: {
      companyId: string;
      agentId: string;
      status: "queued" | "scheduled_retry";
    }) {
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId: input.companyId,
        agentId: input.agentId,
        status: input.status,
        invocationSource: "assignment",
        // The defining property: dispatched but never executed.
        startedAt: null,
        scheduledRetryAt:
          input.status === "scheduled_retry" ? new Date(Date.now() + 60_000) : undefined,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      });
      return runId;
    }

    it("lets the assignee PATCH an issue whose execution lock is held by a queued run", async () => {
      const { companyId, agentId, currentRunId } = await seedCompanyAgentAndRuns();
      const queuedOwnerRunId = await seedNeverStartedOwnerRun({
        companyId,
        agentId,
        status: "queued",
      });
      const issueId = await seedIssueOwnedByRun({
        companyId,
        agentId,
        ownerRunId: queuedOwnerRunId,
        title: "Queued owner blocks its own assignee",
      });

      const res = await request(createApp(agentActor(companyId, agentId, currentRunId)))
        .patch(`/api/issues/${issueId}`)
        .send({ status: "todo" });

      expect(res.status, JSON.stringify(res.body)).toBe(200);

      const row = await db
        .select({ status: issues.status, executionRunId: issues.executionRunId })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0]);
      expect(row?.status).toBe("todo");
      // The lock moved to the acting run rather than staying with the queued one.
      expect(row?.executionRunId).not.toBe(queuedOwnerRunId);
    });

    it("cancels the superseded queued run so it cannot start against the new status", async () => {
      const { companyId, agentId, currentRunId } = await seedCompanyAgentAndRuns();
      const queuedOwnerRunId = await seedNeverStartedOwnerRun({
        companyId,
        agentId,
        status: "queued",
      });
      const issueId = await seedIssueOwnedByRun({
        companyId,
        agentId,
        ownerRunId: queuedOwnerRunId,
        title: "Superseded queued owner is reaped",
      });
      // cancelStaleIssueContextRuns targets runs by contextSnapshot.issueId.
      await db
        .update(heartbeatRuns)
        .set({ contextSnapshot: { issueId } })
        .where(eq(heartbeatRuns.id, queuedOwnerRunId));

      await request(createApp(agentActor(companyId, agentId, currentRunId)))
        .patch(`/api/issues/${issueId}`)
        .send({ status: "todo" })
        .expect(200);

      const ownerRun = await db
        .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, queuedOwnerRunId))
        .then((rows) => rows[0]);
      expect(ownerRun?.status).toBe("cancelled");
      // Reaped by whichever adoption path won; both cancel the superseded run.
      expect(["issue_checkout_adopted", "issue_execution_lock_adopted"]).toContain(
        ownerRun?.errorCode,
      );
    });

    it("lets the assignee PATCH an issue whose execution lock is held by a scheduled_retry run", async () => {
      const { companyId, agentId, currentRunId } = await seedCompanyAgentAndRuns();
      const retryOwnerRunId = await seedNeverStartedOwnerRun({
        companyId,
        agentId,
        status: "scheduled_retry",
      });
      const issueId = await seedIssueOwnedByRun({
        companyId,
        agentId,
        ownerRunId: retryOwnerRunId,
        title: "Retry-scheduled owner blocks its own assignee",
      });

      const res = await request(createApp(agentActor(companyId, agentId, currentRunId)))
        .patch(`/api/issues/${issueId}`)
        .send({ status: "cancelled" });

      expect(res.status, JSON.stringify(res.body)).toBe(200);

      const row = await db
        .select({ status: issues.status })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0]);
      expect(row?.status).toBe("cancelled");
    });

    it("lets the assignee release an issue whose checkout run never started", async () => {
      const { companyId, agentId, currentRunId } = await seedCompanyAgentAndRuns();
      const queuedOwnerRunId = await seedNeverStartedOwnerRun({
        companyId,
        agentId,
        status: "queued",
      });
      const issueId = await seedIssueOwnedByRun({
        companyId,
        agentId,
        ownerRunId: queuedOwnerRunId,
        title: "Release past a queued owner",
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
        })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0]);
      expect(row).toEqual({
        status: "todo",
        assigneeAgentId: null,
        checkoutRunId: null,
        executionRunId: null,
      });
    });

    it.each(["todo", "blocked", "in_review", "backlog"] as const)(
      "reaps a divergent queued execution owner when releasing a %s issue",
      async (status) => {
        const { companyId, agentId, failedRunId, currentRunId } = await seedCompanyAgentAndRuns();
        const queuedExecutionRunId = await seedNeverStartedOwnerRun({
          companyId,
          agentId,
          status: "queued",
        });
        const issueId = randomUUID();
        await db.insert(issues).values({
          id: issueId,
          companyId,
          title: `Release ${status} with divergent owners`,
          status,
          priority: "high",
          assigneeAgentId: agentId,
          checkoutRunId: failedRunId,
          executionRunId: queuedExecutionRunId,
          executionAgentNameKey: "codexcoder",
          executionLockedAt: new Date(),
        });

        const response = await request(createApp(agentActor(companyId, agentId, currentRunId)))
          .post(`/api/issues/${issueId}/release`)
          .send();
        expect(response.status, JSON.stringify(response.body)).toBe(200);

        const issue = await db
          .select({
            status: issues.status,
            assigneeAgentId: issues.assigneeAgentId,
            checkoutRunId: issues.checkoutRunId,
            executionRunId: issues.executionRunId,
          })
          .from(issues)
          .where(eq(issues.id, issueId))
          .then((rows) => rows[0]);
        expect(issue).toEqual({
          status: "todo",
          assigneeAgentId: null,
          checkoutRunId: null,
          executionRunId: null,
        });

        const executionOwner = await db
          .select({
            status: heartbeatRuns.status,
            contextSnapshot: heartbeatRuns.contextSnapshot,
            errorCode: heartbeatRuns.errorCode,
          })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, queuedExecutionRunId))
          .then((rows) => rows[0]);
        expect(executionOwner).toEqual({
          status: "cancelled",
          contextSnapshot: null,
          errorCode: "issue_released",
        });
      },
    );

    it("reaps a context-less queued execution owner when a board user releases the issue", async () => {
      const { companyId, agentId, failedRunId } = await seedCompanyAgentAndRuns();
      const queuedExecutionRunId = await seedNeverStartedOwnerRun({
        companyId,
        agentId,
        status: "queued",
      });
      const issueId = randomUUID();
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "Board release with divergent owners",
        status: "todo",
        priority: "high",
        assigneeAgentId: agentId,
        checkoutRunId: failedRunId,
        executionRunId: queuedExecutionRunId,
        executionAgentNameKey: "codexcoder",
        executionLockedAt: new Date(),
      });

      const response = await request(createApp(boardActor(companyId)))
        .post(`/api/issues/${issueId}/release`)
        .send();
      expect(response.status, JSON.stringify(response.body)).toBe(200);

      const issue = await db
        .select({
          status: issues.status,
          assigneeAgentId: issues.assigneeAgentId,
          checkoutRunId: issues.checkoutRunId,
          executionRunId: issues.executionRunId,
        })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0]);
      expect(issue).toEqual({
        status: "todo",
        assigneeAgentId: null,
        checkoutRunId: null,
        executionRunId: null,
      });

      const executionOwner = await db
        .select({
          status: heartbeatRuns.status,
          contextSnapshot: heartbeatRuns.contextSnapshot,
          errorCode: heartbeatRuns.errorCode,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, queuedExecutionRunId))
        .then((rows) => rows[0]);
      expect(executionOwner).toEqual({
        status: "cancelled",
        contextSnapshot: null,
        errorCode: "issue_released",
      });
    });

    it("does not let a non-assignee release a non-in-progress issue", async () => {
      const { companyId, agentId, failedRunId, currentRunId } = await seedCompanyAgentAndRuns();
      const peerAgentId = randomUUID();
      await db.insert(agents).values({
        id: peerAgentId,
        companyId,
        name: "PeerAgent",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
      const issueId = randomUUID();
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "Non-assignee release remains forbidden",
        status: "todo",
        priority: "high",
        assigneeAgentId: agentId,
        checkoutRunId: failedRunId,
        executionRunId: failedRunId,
      });

      const response = await request(createApp(agentActor(companyId, peerAgentId, currentRunId)))
        .post(`/api/issues/${issueId}/release`)
        .send();
      expect(response.status, JSON.stringify(response.body)).toBe(403);

      const issue = await db
        .select({
          status: issues.status,
          assigneeAgentId: issues.assigneeAgentId,
          checkoutRunId: issues.checkoutRunId,
          executionRunId: issues.executionRunId,
        })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0]);
      expect(issue).toEqual({
        status: "todo",
        assigneeAgentId: agentId,
        checkoutRunId: failedRunId,
        executionRunId: failedRunId,
      });
    });

    it("still refuses when the owning run is genuinely running under a different run id", async () => {
      const { companyId, agentId, currentRunId } = await seedCompanyAgentAndRuns();
      const runningOwnerRunId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: runningOwnerRunId,
        companyId,
        agentId,
        status: "running",
        invocationSource: "assignment",
        // Started — this is a real owner, and the race protection must hold.
        startedAt: new Date(),
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      });
      const issueId = await seedIssueOwnedByRun({
        companyId,
        agentId,
        ownerRunId: runningOwnerRunId,
        title: "Live owner still conflicts",
      });

      const res = await request(createApp(agentActor(companyId, agentId, currentRunId)))
        .patch(`/api/issues/${issueId}`)
        .send({ status: "todo" });

      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(res.body.error).toBe("Issue run ownership conflict");
    });

    it("does not widen the authorization boundary for a non-assignee peer", async () => {
      const { companyId, agentId, currentRunId } = await seedCompanyAgentAndRuns();
      const peerAgentId = randomUUID();
      await db.insert(agents).values({
        id: peerAgentId,
        companyId,
        name: "PeerAgent",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
      const queuedOwnerRunId = await seedNeverStartedOwnerRun({
        companyId,
        agentId,
        status: "queued",
      });
      const issueId = await seedIssueOwnedByRun({
        companyId,
        agentId,
        ownerRunId: queuedOwnerRunId,
        title: "Peer cannot ride the reap path",
      });

      const res = await request(createApp(agentActor(companyId, peerAgentId, currentRunId)))
        .patch(`/api/issues/${issueId}`)
        .send({ status: "todo" });

      // Reaping happens strictly downstream of authorization, so a peer without a
      // grant is refused before it is ever reached.
      expect(res.status, JSON.stringify(res.body)).not.toBe(200);
      expect([403, 409]).toContain(res.status);

      const row = await db
        .select({ status: issues.status, assigneeAgentId: issues.assigneeAgentId })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0]);
      expect(row).toEqual({ status: "in_progress", assigneeAgentId: agentId });
    });

    it.each(["queued", "scheduled_retry"] as const)(
      "keeps dispatch claim and %s-owner adoption mutually exclusive",
      async (ownerStatus) => {
        for (let attempt = 0; attempt < 8; attempt += 1) {
          const { companyId, agentId, currentRunId } = await seedCompanyAgentAndRuns();
          const ownerRunId = await seedNeverStartedOwnerRun({ companyId, agentId, status: ownerStatus });
          const issueId = await seedIssueOwnedByRun({
            companyId,
            agentId,
            ownerRunId,
            title: `${ownerStatus} dispatch race ${attempt}`,
          });

          const [patchResponse, claimed] = await Promise.all([
            request(createApp(agentActor(companyId, agentId, currentRunId)))
              .patch(`/api/issues/${issueId}`)
              .send({ title: `attempt ${attempt}` }),
            db
              .update(heartbeatRuns)
              .set({ status: "running", startedAt: new Date(), updatedAt: new Date() })
              .where(
                and(
                  eq(heartbeatRuns.id, ownerRunId),
                  eq(heartbeatRuns.status, ownerStatus),
                  isNull(heartbeatRuns.startedAt),
                ),
              )
              .returning({ id: heartbeatRuns.id }),
          ]);

          const owner = await db
            .select({ status: heartbeatRuns.status })
            .from(heartbeatRuns)
            .where(eq(heartbeatRuns.id, ownerRunId))
            .then((rows) => rows[0]);
          if (patchResponse.status === 200) {
            expect(claimed).toHaveLength(0);
            expect(owner?.status).toBe("cancelled");
          } else {
            expect(patchResponse.status, JSON.stringify(patchResponse.body)).toBe(409);
            expect(claimed).toHaveLength(1);
            expect(owner?.status).toBe("running");
          }

          await db.delete(issues).where(eq(issues.id, issueId));
          await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, ownerRunId));
        }
      },
    );

    it("does not replace a divergent live execution owner during checkout adoption or release", async () => {
      const { companyId, agentId, currentRunId } = await seedCompanyAgentAndRuns();
      const queuedCheckoutRunId = await seedNeverStartedOwnerRun({ companyId, agentId, status: "queued" });
      const liveExecutionRunId = randomUUID();
      const issueId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: liveExecutionRunId,
        companyId,
        agentId,
        status: "running",
        invocationSource: "assignment",
        startedAt: new Date(),
      });
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "Divergent owner protection",
        status: "in_progress",
        priority: "high",
        assigneeAgentId: agentId,
        checkoutRunId: queuedCheckoutRunId,
        executionRunId: liveExecutionRunId,
        executionAgentNameKey: "codexcoder",
        executionLockedAt: new Date(),
      });

      const app = createApp(agentActor(companyId, agentId, currentRunId));
      const patchResponse = await request(app)
        .patch(`/api/issues/${issueId}`)
        .send({ title: "Must not land" });
      expect(patchResponse.status, JSON.stringify(patchResponse.body)).toBe(409);

      const releaseResponse = await request(app)
        .post(`/api/issues/${issueId}/release`)
        .send();
      expect(releaseResponse.status, JSON.stringify(releaseResponse.body)).toBe(409);

      const row = await db
        .select({ checkoutRunId: issues.checkoutRunId, executionRunId: issues.executionRunId })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0]);
      expect(row).toEqual({
        checkoutRunId: queuedCheckoutRunId,
        executionRunId: liveExecutionRunId,
      });
    });

    it("does not clear a reapable execution owner behind a divergent live checkout owner", async () => {
      const { companyId, agentId, currentRunId } = await seedCompanyAgentAndRuns();
      const liveCheckoutRunId = randomUUID();
      const queuedExecutionRunId = await seedNeverStartedOwnerRun({
        companyId,
        agentId,
        status: "queued",
      });
      const issueId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: liveCheckoutRunId,
        companyId,
        agentId,
        status: "running",
        invocationSource: "assignment",
        startedAt: new Date(),
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      });
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "Live checkout owner protection",
        status: "in_progress",
        priority: "high",
        assigneeAgentId: agentId,
        checkoutRunId: liveCheckoutRunId,
        executionRunId: queuedExecutionRunId,
        executionAgentNameKey: "codexcoder",
        executionLockedAt: new Date(),
      });
      await db
        .update(heartbeatRuns)
        .set({ contextSnapshot: { issueId } })
        .where(eq(heartbeatRuns.id, currentRunId));

      const response = await request(createApp(agentActor(companyId, agentId, currentRunId)))
        .patch(`/api/issues/${issueId}`)
        .send({ title: "Must not land" });
      expect(response.status, JSON.stringify(response.body)).toBe(409);

      const row = await db
        .select({ checkoutRunId: issues.checkoutRunId, executionRunId: issues.executionRunId })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0]);
      expect(row).toEqual({
        checkoutRunId: liveCheckoutRunId,
        executionRunId: queuedExecutionRunId,
      });

      const owners = await db
        .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(inArray(heartbeatRuns.id, [liveCheckoutRunId, queuedExecutionRunId]));
      expect(new Map(owners.map((owner) => [owner.id, owner.status]))).toEqual(
        new Map([
          [liveCheckoutRunId, "running"],
          [queuedExecutionRunId, "queued"],
        ]),
      );
    });

    it("does not replace a divergent live checkout owner behind a terminal execution owner", async () => {
      const { companyId, agentId, currentRunId, failedRunId } = await seedCompanyAgentAndRuns();
      const liveCheckoutRunId = randomUUID();
      const issueId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: liveCheckoutRunId,
        companyId,
        agentId,
        status: "running",
        invocationSource: "assignment",
        startedAt: new Date(),
      });
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "Terminal execution owner behind live checkout owner",
        status: "in_progress",
        priority: "high",
        assigneeAgentId: agentId,
        checkoutRunId: liveCheckoutRunId,
        executionRunId: failedRunId,
        executionAgentNameKey: "codexcoder",
        executionLockedAt: new Date(),
      });

      const response = await request(createApp(agentActor(companyId, agentId, currentRunId)))
        .post(`/api/issues/${issueId}/checkout`)
        .send({ agentId, expectedStatuses: ["in_progress"] });
      expect(response.status, JSON.stringify(response.body)).toBe(409);

      const row = await db
        .select({ checkoutRunId: issues.checkoutRunId, executionRunId: issues.executionRunId })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0]);
      expect(row).toEqual({
        checkoutRunId: liveCheckoutRunId,
        executionRunId: null,
      });
    });

    it("does not accept same-run checkout ownership behind a divergent live execution owner", async () => {
      const { companyId, agentId, currentRunId } = await seedCompanyAgentAndRuns();
      const liveExecutionRunId = randomUUID();
      const issueId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: liveExecutionRunId,
        companyId,
        agentId,
        status: "running",
        invocationSource: "assignment",
        startedAt: new Date(),
      });
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "Same checkout owner behind live execution owner",
        status: "in_progress",
        priority: "high",
        assigneeAgentId: agentId,
        checkoutRunId: currentRunId,
        executionRunId: liveExecutionRunId,
        executionAgentNameKey: "codexcoder",
        executionLockedAt: new Date(),
      });

      const app = createApp(agentActor(companyId, agentId, currentRunId));
      const checkoutResponse = await request(app)
        .post(`/api/issues/${issueId}/checkout`)
        .send({ agentId, expectedStatuses: ["in_progress"] });
      expect(checkoutResponse.status, JSON.stringify(checkoutResponse.body)).toBe(409);

      const patchResponse = await request(app)
        .patch(`/api/issues/${issueId}`)
        .send({ title: "Must not land" });
      expect(patchResponse.status, JSON.stringify(patchResponse.body)).toBe(409);

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
        title: "Same checkout owner behind live execution owner",
        checkoutRunId: currentRunId,
        executionRunId: liveExecutionRunId,
      });
    });

    it("reaps divergent never-started owners when checking out a todo issue", async () => {
      const { companyId, agentId, currentRunId } = await seedCompanyAgentAndRuns();
      const queuedCheckoutRunId = await seedNeverStartedOwnerRun({
        companyId,
        agentId,
        status: "queued",
      });
      const queuedExecutionRunId = await seedNeverStartedOwnerRun({
        companyId,
        agentId,
        status: "queued",
      });
      const issueId = randomUUID();
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "Divergent never-started owner recovery",
        status: "todo",
        priority: "high",
        assigneeAgentId: agentId,
        checkoutRunId: queuedCheckoutRunId,
        executionRunId: queuedExecutionRunId,
        executionAgentNameKey: "codexcoder",
        executionLockedAt: new Date(),
      });

      const response = await request(createApp(agentActor(companyId, agentId, currentRunId)))
        .post(`/api/issues/${issueId}/checkout`)
        .send({ agentId, expectedStatuses: ["todo"] });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body).toMatchObject({
        status: "in_progress",
        checkoutRunId: currentRunId,
        executionRunId: currentRunId,
      });

      const owners = await db
        .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(inArray(heartbeatRuns.id, [queuedCheckoutRunId, queuedExecutionRunId]));
      expect(new Map(owners.map((owner) => [owner.id, owner.status]))).toEqual(
        new Map([
          [queuedCheckoutRunId, "cancelled"],
          [queuedExecutionRunId, "cancelled"],
        ]),
      );
    });

    it("reaps a queued execution owner behind a terminal checkout owner on todo checkout", async () => {
      const { companyId, agentId, failedRunId, currentRunId } = await seedCompanyAgentAndRuns();
      const queuedExecutionRunId = await seedNeverStartedOwnerRun({
        companyId,
        agentId,
        status: "queued",
      });
      const issueId = randomUUID();
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "Terminal checkout with divergent queued execution owner",
        status: "todo",
        priority: "high",
        assigneeAgentId: agentId,
        checkoutRunId: failedRunId,
        executionRunId: queuedExecutionRunId,
        executionAgentNameKey: "codexcoder",
        executionLockedAt: new Date(),
      });

      const response = await request(createApp(agentActor(companyId, agentId, currentRunId)))
        .post(`/api/issues/${issueId}/checkout`)
        .send({ agentId, expectedStatuses: ["todo"] });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body).toMatchObject({
        status: "in_progress",
        checkoutRunId: currentRunId,
        executionRunId: currentRunId,
      });

      const owners = await db
        .select({
          id: heartbeatRuns.id,
          status: heartbeatRuns.status,
          errorCode: heartbeatRuns.errorCode,
        })
        .from(heartbeatRuns)
        .where(inArray(heartbeatRuns.id, [failedRunId, queuedExecutionRunId]));
      expect(new Map(owners.map((owner) => [owner.id, {
        status: owner.status,
        errorCode: owner.errorCode,
      }]))).toEqual(
        new Map([
          [failedRunId, { status: "failed", errorCode: null }],
          [queuedExecutionRunId, {
            status: "cancelled",
            errorCode: "issue_execution_lock_reaped",
          }],
        ]),
      );
    });
  });

  it("allows only one concurrent decision from a participant whose assignee drifted", async () => {
    const { companyId, agentId, currentRunId } = await seedCompanyAgentAndRuns();
    const divergedAssigneeAgentId = randomUUID();
    const stageId = randomUUID();
    const issueId = randomUUID();
    await db.insert(agents).values({
      id: divergedAssigneeAgentId,
      companyId,
      name: "DivergedAssignee",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const executionState = {
      status: "pending",
      currentStageId: stageId,
      currentStageIndex: 0,
      currentStageType: "review",
      currentParticipant: { type: "agent", agentId },
      returnAssignee: { type: "agent", agentId: divergedAssigneeAgentId },
      completedStageIds: [],
      lastDecisionId: null,
      lastDecisionOutcome: null,
    };
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Concurrent participant decision",
      status: "in_review",
      priority: "high",
      assigneeAgentId: divergedAssigneeAgentId,
      checkoutRunId: currentRunId,
      executionRunId: currentRunId,
      executionAgentNameKey: "codexcoder",
      executionLockedAt: new Date(),
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [{
          id: stageId,
          type: "review",
          approvalsNeeded: 1,
          participants: [{ type: "agent", agentId }],
        }],
      },
      executionState,
    });

    const app = createApp(agentActor(companyId, agentId, currentRunId));
    const [first, second] = await Promise.all([
      request(app).patch(`/api/issues/${issueId}`).send({ status: "done", comment: "Approve one" }),
      request(app).patch(`/api/issues/${issueId}`).send({ status: "done", comment: "Approve two" }),
    ]);
    expect(
      [first.status, second.status].sort(),
      JSON.stringify([first.body, second.body]),
    ).toEqual([200, 409]);

    const decisions = await db
      .select({ id: issueExecutionDecisions.id })
      .from(issueExecutionDecisions)
      .where(eq(issueExecutionDecisions.issueId, issueId));
    expect(decisions).toHaveLength(1);
  });

  it("rejects a decision update derived from a stale execution policy", async () => {
    const { companyId, agentId } = await seedCompanyAgentAndRuns();
    const issueId = randomUUID();
    const originalPolicy = {
      mode: "normal",
      commentRequired: true,
      stages: [],
    };
    const revisedPolicy = {
      ...originalPolicy,
      stages: [{
        id: randomUUID(),
        type: "review",
        approvalsNeeded: 1,
        participants: [{ type: "agent", agentId }],
      }],
    };
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Policy CAS",
      status: "in_review",
      priority: "high",
      assigneeAgentId: agentId,
      executionPolicy: originalPolicy,
      executionState: { status: "idle" },
    });
    await db.update(issues).set({ executionPolicy: revisedPolicy }).where(eq(issues.id, issueId));

    await expect(issueService(db).update(issueId, {
      status: "done",
      expectedCurrentExecutionState: { status: "idle" },
      expectedCurrentExecutionPolicy: originalPolicy,
    })).rejects.toMatchObject({ status: 409 });

    const row = await db
      .select({ status: issues.status, executionPolicy: issues.executionPolicy })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({ status: "in_review", executionPolicy: revisedPolicy });
  });

  it("rejects a stale current-run ordinary update after run ownership transfers", async () => {
    const { companyId, agentId, currentRunId } = await seedCompanyAgentAndRuns();
    const nextRunId = randomUUID();
    const issueId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: nextRunId,
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
      title: "Current-run ordinary snapshot",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: currentRunId,
      executionRunId: currentRunId,
      executionAgentNameKey: "codexcoder",
      executionLockedAt: new Date(),
    });
    await db
      .update(issues)
      .set({ checkoutRunId: nextRunId, executionRunId: nextRunId })
      .where(eq(issues.id, issueId));

    await expect(issueService(db).update(issueId, {
      title: "Stale ordinary write",
      expectedCurrentCheckoutRunId: currentRunId,
      expectedCurrentExecutionRunId: currentRunId,
    })).rejects.toMatchObject({ status: 409 });

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
      title: "Current-run ordinary snapshot",
      checkoutRunId: nextRunId,
      executionRunId: nextRunId,
    });
  });

  it("rejects a stale current-run execution-state update after run ownership transfers", async () => {
    const { companyId, agentId, currentRunId } = await seedCompanyAgentAndRuns();
    const nextRunId = randomUUID();
    const issueId = randomUUID();
    const stageId = randomUUID();
    const executionPolicy = {
      mode: "normal",
      commentRequired: true,
      stages: [{
        id: stageId,
        type: "review",
        approvalsNeeded: 1,
        participants: [{ type: "agent", agentId }],
      }],
    };
    const executionState = {
      status: "pending",
      currentStageId: stageId,
      currentStageIndex: 0,
      currentStageType: "review",
      currentParticipant: { type: "agent", agentId },
      returnAssignee: { type: "agent", agentId },
      completedStageIds: [],
      lastDecisionId: null,
      lastDecisionOutcome: null,
      reviewRequest: null,
    };
    await db.insert(heartbeatRuns).values({
      id: nextRunId,
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
      title: "Current-run execution-state snapshot",
      status: "in_review",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: currentRunId,
      executionRunId: currentRunId,
      executionAgentNameKey: "codexcoder",
      executionLockedAt: new Date(),
      executionPolicy,
      executionState,
    });
    const snapshot = await db
      .select({
        status: issues.status,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
        executionPolicy: issues.executionPolicy,
        executionState: issues.executionState,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] as {
        status: string;
        checkoutRunId: string;
        executionRunId: string;
        executionPolicy: Record<string, unknown>;
        executionState: Record<string, unknown>;
      });
    const nextState = {
      ...snapshot.executionState,
      reviewRequest: { instructions: "Review after ownership transfer." },
    };
    await db
      .update(issues)
      .set({ checkoutRunId: nextRunId, executionRunId: nextRunId })
      .where(eq(issues.id, issueId));

    await expect(issueService(db).update(issueId, {
      executionState: nextState,
      expectedCurrentStatus: snapshot.status,
      expectedCurrentExecutionState: snapshot.executionState,
      expectedCurrentExecutionPolicy: snapshot.executionPolicy,
      expectedCurrentCheckoutRunId: snapshot.checkoutRunId,
      expectedCurrentExecutionRunId: snapshot.executionRunId,
    })).rejects.toMatchObject({ status: 409 });

    const row = await db
      .select({
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
        executionState: issues.executionState,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({
      checkoutRunId: nextRunId,
      executionRunId: nextRunId,
      executionState: snapshot.executionState,
    });
  });

  it.each(["review_request", "decision"] as const)(
    "rejects the stale writer when %s commits first from a shared snapshot",
    async (firstWriter) => {
      const { companyId, agentId } = await seedCompanyAgentAndRuns();
      const issueId = randomUUID();
      const stageId = randomUUID();
      const executionPolicy = {
        mode: "normal",
        commentRequired: true,
        stages: [{
          id: stageId,
          type: "review",
          approvalsNeeded: 1,
          participants: [{ type: "agent", agentId }],
        }],
      };
      const executionState = {
        status: "pending",
        currentStageId: stageId,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId },
        returnAssignee: { type: "agent", agentId },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
        reviewRequest: null,
      };
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: `Review request and decision race: ${firstWriter}`,
        status: "in_review",
        priority: "high",
        assigneeAgentId: agentId,
        executionPolicy,
        executionState,
      });

      const persistedSnapshot = await db
        .select({
          status: issues.status,
          executionState: issues.executionState,
          executionPolicy: issues.executionPolicy,
        })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] as {
          status: string;
          executionState: typeof executionState;
          executionPolicy: typeof executionPolicy;
        });
      const reviewRequestState = {
        ...persistedSnapshot.executionState,
        reviewRequest: { instructions: "Review the concurrent update." },
      };
      const decisionState = {
        ...persistedSnapshot.executionState,
        status: "completed",
        currentStageId: null,
        currentStageIndex: null,
        currentStageType: null,
        currentParticipant: null,
        returnAssignee: null,
        completedStageIds: [stageId],
        lastDecisionId: randomUUID(),
        lastDecisionOutcome: "approved",
        reviewRequest: null,
      };

      const svc = issueService(db);
      const firstState = firstWriter === "review_request" ? reviewRequestState : decisionState;
      const secondState = firstWriter === "review_request" ? decisionState : reviewRequestState;
      await svc.update(issueId, {
        executionState: firstState,
        expectedCurrentStatus: persistedSnapshot.status,
        expectedCurrentExecutionState: persistedSnapshot.executionState,
        expectedCurrentExecutionPolicy: persistedSnapshot.executionPolicy,
      });
      await expect(svc.update(issueId, {
        executionState: secondState,
        expectedCurrentStatus: persistedSnapshot.status,
        expectedCurrentExecutionState: persistedSnapshot.executionState,
        expectedCurrentExecutionPolicy: persistedSnapshot.executionPolicy,
      })).rejects.toMatchObject({ status: 409 });

      const row = await db
        .select({ executionState: issues.executionState })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0]);
      expect(row?.executionState).toEqual(firstState);
    },
  );

  async function seedPendingReviewStageIssue(title: string) {
    const { companyId, agentId } = await seedCompanyAgentAndRuns();
    const issueId = randomUUID();
    const stageId = randomUUID();
    const executionPolicy = {
      mode: "normal",
      commentRequired: true,
      stages: [{
        id: stageId,
        type: "review",
        approvalsNeeded: 1,
        participants: [{ type: "agent", agentId }],
      }],
    };
    const executionState = {
      status: "pending",
      currentStageId: stageId,
      currentStageIndex: 0,
      currentStageType: "review",
      currentParticipant: { type: "agent", agentId },
      returnAssignee: { type: "agent", agentId },
      completedStageIds: [],
      lastDecisionId: null,
      lastDecisionOutcome: null,
      reviewRequest: null,
    };
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title,
      status: "in_review",
      priority: "high",
      assigneeAgentId: agentId,
      executionPolicy,
      executionState,
    });
    return { agentId, issueId, stageId, executionPolicy, executionState };
  }

  it.each(["review_request", "decision"] as const)(
    "rejects a stale %s write after release commits first",
    async (writer) => {
      const seeded = await seedPendingReviewStageIssue(`Release wins before ${writer}`);
      const persistedSnapshot = await db
        .select({
          status: issues.status,
          executionState: issues.executionState,
          executionPolicy: issues.executionPolicy,
        })
        .from(issues)
        .where(eq(issues.id, seeded.issueId))
        .then((rows) => rows[0] as {
          status: string;
          executionState: typeof seeded.executionState;
          executionPolicy: typeof seeded.executionPolicy;
        });
      const nextState = writer === "review_request"
        ? {
            ...persistedSnapshot.executionState,
            reviewRequest: { instructions: "Review after release." },
          }
        : {
            ...persistedSnapshot.executionState,
            status: "completed",
            currentStageId: null,
            currentStageIndex: null,
            currentStageType: null,
            currentParticipant: null,
            returnAssignee: null,
            completedStageIds: [seeded.stageId],
            lastDecisionId: randomUUID(),
            lastDecisionOutcome: "approved",
            reviewRequest: null,
          };

      const svc = issueService(db);
      await svc.release(seeded.issueId, seeded.agentId);

      await expect(svc.update(seeded.issueId, {
        ...(writer === "decision" ? { status: "done" as const } : {}),
        executionState: nextState,
        expectedCurrentStatus: persistedSnapshot.status,
        expectedCurrentExecutionState: persistedSnapshot.executionState,
        expectedCurrentExecutionPolicy: persistedSnapshot.executionPolicy,
      })).rejects.toMatchObject({ status: 409 });

      const row = await db
        .select({
          status: issues.status,
          assigneeAgentId: issues.assigneeAgentId,
          executionState: issues.executionState,
        })
        .from(issues)
        .where(eq(issues.id, seeded.issueId))
        .then((rows) => rows[0]);
      expect(row).toEqual({
        status: "todo",
        assigneeAgentId: null,
        executionState: persistedSnapshot.executionState,
      });
    },
  );

  it.each(["review_request", "decision"] as const)(
    "keeps the issue released when release follows a current %s write",
    async (writer) => {
      const seeded = await seedPendingReviewStageIssue(`Release follows ${writer}`);
      const persistedSnapshot = await db
        .select({
          status: issues.status,
          executionState: issues.executionState,
          executionPolicy: issues.executionPolicy,
        })
        .from(issues)
        .where(eq(issues.id, seeded.issueId))
        .then((rows) => rows[0] as {
          status: string;
          executionState: typeof seeded.executionState;
          executionPolicy: typeof seeded.executionPolicy;
        });
      const nextState = writer === "review_request"
        ? {
            ...persistedSnapshot.executionState,
            reviewRequest: { instructions: "Review before release." },
          }
        : {
            ...persistedSnapshot.executionState,
            status: "completed",
            currentStageId: null,
            currentStageIndex: null,
            currentStageType: null,
            currentParticipant: null,
            returnAssignee: null,
            completedStageIds: [seeded.stageId],
            lastDecisionId: randomUUID(),
            lastDecisionOutcome: "approved",
            reviewRequest: null,
          };

      const svc = issueService(db);
      await svc.update(seeded.issueId, {
        ...(writer === "decision" ? { status: "done" as const } : {}),
        executionState: nextState,
        expectedCurrentStatus: persistedSnapshot.status,
        expectedCurrentExecutionState: persistedSnapshot.executionState,
        expectedCurrentExecutionPolicy: persistedSnapshot.executionPolicy,
      });
      await svc.release(seeded.issueId, seeded.agentId);

      const row = await db
        .select({
          status: issues.status,
          assigneeAgentId: issues.assigneeAgentId,
          executionState: issues.executionState,
        })
        .from(issues)
        .where(eq(issues.id, seeded.issueId))
        .then((rows) => rows[0]);
      expect(row).toEqual({
        status: "todo",
        assigneeAgentId: null,
        executionState: nextState,
      });
    },
  );

});
