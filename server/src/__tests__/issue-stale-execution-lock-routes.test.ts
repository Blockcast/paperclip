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
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueExecutionDecisions,
  issueRecoveryActions,
  issueRelations,
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
    await db.delete(issueComments);
    await db.delete(issueExecutionDecisions);
    await db.delete(issueRelations);
    await db.delete(activityLog);
    await db.delete(issues);
    // Must precede heartbeatRuns: any test that cancels a RUNNING run writes
    // heartbeat_run_events, whose FK then blocks the heartbeatRuns delete and
    // fails every subsequent test in the file rather than just its own.
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(actor: Express.Request["actor"]) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
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
        ...(staleRunStatus === "running" ? { startedAt: new Date() } : { finishedAt: new Date() }),
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

  // BLO-46114: before this, being newer was enough to take the lock from a still
  // running owner, stranding its in-flight work. A live owner now keeps it.
  it("does not let a newer active issue-scoped run take ownership from a live older run", async () => {
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

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error).toBe("Issue run ownership conflict");

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
      status: "in_progress",
      checkoutRunId: failedRunId,
      executionRunId: failedRunId,
    });
  });

  it("keeps a live older issue-scoped owner writing when a newer same-agent run starts", async () => {
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

    expect(newerRunRes.status, JSON.stringify(newerRunRes.body)).toBe(409);
    expect(newerRunRes.body.error).toBe("Issue run ownership conflict");

    const ownerRes = await request(createApp(agentActor(companyId, agentId, failedRunId)))
      .patch(`/api/issues/${issueId}`)
      .send({ title: "owner output" });

    expect(ownerRes.status, JSON.stringify(ownerRes.body)).toBe(200);

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
      title: "owner output",
      checkoutRunId: failedRunId,
      executionRunId: failedRunId,
    });
  });

  it("lets an active issue-scoped routine publish a sweep comment then close its run issue", async () => {
    const { companyId, agentId, failedRunId, currentRunId } = await seedCompanyAgentAndRuns({
      staleRunStatus: "failed",
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

  // BLO-28219: the conflict body used to carry only the two run ids, which cannot
  // distinguish "a live sibling run of my own agent holds this" (working as
  // designed — yield) from "the lock outlived a dead run" (a wedge worth
  // escalating). BLO-28219 was filed as the second and was in fact the first.
  it("reports live-sibling liveness and an unblock path on an ownership conflict", async () => {
    const { companyId, agentId, failedRunId: liveHolderRunId, currentRunId } =
      await seedCompanyAgentAndRuns({ staleRunStatus: "running" });
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Live sibling conflict diagnostics",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: liveHolderRunId,
      executionRunId: liveHolderRunId,
      executionAgentNameKey: "codexcoder",
      executionLockedAt: new Date(),
    });

    const res = await request(createApp(agentActor(companyId, agentId, currentRunId)))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "done" });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error).toBe("Issue run ownership conflict");

    // The holder is `running` and belongs to the actor's own agent, so this is
    // the concurrency fence, not a stale lock.
    expect(res.body.details?.holderLiveness, JSON.stringify(res.body)).toBe("live");
    expect(res.body.details?.concurrentSiblingRun).toBe(true);
    // `remediation` is hoisted to the top level by the error handler, so the fix
    // path is visible without digging into `details`.
    expect(res.body.remediation, JSON.stringify(res.body)).toContain(
      "concurrent run of your own agent",
    );
    // Must steer the caller away from the two responses that wasted runs.
    expect(res.body.remediation).toContain("Do NOT retry or re-file");
    // PEN-5342: this branch already attributes the holder in prose ("your own
    // agent"), and the label must agree with it rather than contradict it.
    expect(res.body.remediation).toContain(`${liveHolderRunId} — agent CodexCoder`);

    const holder = (res.body.details?.lockHolders ?? []).find(
      (entry: { runId: string }) => entry.runId === liveHolderRunId,
    );
    expect(holder, JSON.stringify(res.body)).toBeTruthy();
    expect(holder.live).toBe(true);
    expect(holder.status).toBe("running");
    expect(holder.sameAgentAsActor).toBe(true);
    expect(holder.agentName).toBe("CodexCoder");
  });

  // PEN-5342: the foreign-agent branch of the same 409 named the holder as a
  // bare run id. The reader has to supply the missing half from somewhere, and
  // the only sibling relationship the framing suggests is "another run of
  // mine" — which is exactly the reading this branch exists to refute.
  // Measured on PEN-5082 cmt `e87c9e8b`: a DevOps run read a foreign holder id
  // off the in-pod push guard and reported, in good faith, "another DevOps run
  // is on this row right now". The holder was an Engineer run.
  it("names WHICH agent holds the lock when the holder is a different agent (PEN-5342)", async () => {
    const { companyId, agentId, currentRunId } = await seedCompanyAgentAndRuns();
    const otherAgentId = randomUUID();
    const otherAgentRunId = randomUUID();
    await db.insert(agents).values({
      id: otherAgentId,
      companyId,
      name: "Devops",
      role: "devops",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: otherAgentRunId,
      companyId,
      agentId: otherAgentId,
      status: "running",
      invocationSource: "manual",
      startedAt: new Date(),
      createdAt: new Date("2026-01-01T00:00:30.000Z"),
    });

    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Foreign-agent lock holder attribution",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: otherAgentRunId,
      executionRunId: otherAgentRunId,
      executionAgentNameKey: "devops",
      executionLockedAt: new Date(),
    });

    const res = await request(createApp(agentActor(companyId, agentId, currentRunId)))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "done" });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.details?.holderLiveness, JSON.stringify(res.body)).toBe("live");
    expect(res.body.details?.concurrentSiblingRun).toBe(false);

    // The assertion that matters: `remediation` is the string hoisted to the
    // top level and read by the agent. The run id alone is what produced the
    // misread, so the agent must appear in the same breath as the id it
    // qualifies — not merely as a field somewhere in `details`.
    expect(res.body.remediation, JSON.stringify(res.body)).toContain(
      `${otherAgentRunId} — agent Devops`,
    );
    expect(res.body.remediation).toContain("Another agent's live run");
    // The pre-PEN-5342 rendering: a bare id with nothing attached.
    expect(res.body.remediation).not.toContain(`(${otherAgentRunId})`);

    const holder = (res.body.details?.lockHolders ?? []).find(
      (entry: { runId: string }) => entry.runId === otherAgentRunId,
    );
    expect(holder, JSON.stringify(res.body)).toBeTruthy();
    expect(holder.agentId).toBe(otherAgentId);
    expect(holder.agentName).toBe("Devops");
    expect(holder.sameAgentAsActor).toBe(false);
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

  // BLO-23206. The cancel path used to end at most ONE run — the running one,
  // via resolveActiveIssueRun — so queued and scheduled_retry rows for the same
  // issue survived the close and were claimed against it on the next scheduler
  // tick. This is the cancel-path analogue of the release test above.
  it("cancels queued and scheduled issue-context runs when an issue is cancelled", async () => {
    const { companyId, agentId, currentRunId } = await seedCompanyAgentAndRuns();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Cancelled duplicate with queued runs behind it",
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
      .patch(`/api/issues/${issueId}`)
      .send({ status: "cancelled", comment: "Cancelling as a duplicate." });

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
      ]));
    expect(Object.fromEntries(runs.map((run) => [run.id, {
      status: run.status,
      errorCode: run.errorCode,
    }]))).toEqual({
      [staleContext.queuedRunId]: {
        status: "cancelled",
        errorCode: "issue_terminal_status",
      },
      [staleContext.scheduledRunId]: {
        status: "cancelled",
        errorCode: "issue_terminal_status",
      },
    });

    const wakeups = await db
      .select({ id: agentWakeupRequests.id, status: agentWakeupRequests.status })
      .from(agentWakeupRequests)
      .where(inArray(agentWakeupRequests.id, [
        staleContext.queuedWakeupId,
        staleContext.scheduledWakeupId,
      ]));
    for (const wakeup of wakeups) {
      expect(wakeup.status).toBe("skipped");
    }

    // The execution lock does not outlive the drained runs.
    const [issueAfter] = await db
      .select({
        status: issues.status,
        executionRunId: issues.executionRunId,
        executionLockedAt: issues.executionLockedAt,
      })
      .from(issues)
      .where(eq(issues.id, issueId));
    expect(issueAfter.status).toBe("cancelled");
    expect(issueAfter.executionRunId).toBeNull();
    expect(issueAfter.executionLockedAt).toBeNull();
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

    // PEN-6282: the `in_review` fence (assertPendingReviewRunOwnership, forked
    // off assertCheckoutOwner by BLO-22666) inherited the TERMINAL-only lock
    // clear and never gained a liveness test, so it disagreed with
    // `isReapableHeartbeatRunRow` on exactly the case the predicate above was
    // written for: a holder that exists but has never executed. Measured on a
    // live row 2026-11-08 — the 409 body carried `holderLiveness: "not_live"`
    // while refusing the assignee's own document write, and the longest
    // same-shape dispatch stall observed was 11h 00m 44.7s queued, never
    // started.
    //
    // These tests pin the invariant at BOTH entry points on purpose. The
    // predicate's own doc comment says the implementations "must not drift",
    // and a test that covers only the `in_progress` ladder is what let this
    // fork ship with the terminal-only clear in the first place.
    describe("the in_review fence agrees with the reapable predicate (PEN-6282)", () => {
      const svc = () => issueService(db);

      function pendingReviewExecutionState(agentId: string, stageId: string) {
        return {
          status: "pending" as const,
          currentStageId: stageId,
          currentStageIndex: 0,
          currentStageType: "review" as const,
          currentParticipant: { type: "agent" as const, agentId },
          returnAssignee: null,
          completedStageIds: [],
          lastDecisionId: null,
          lastDecisionOutcome: null,
        };
      }

      async function seedPendingReviewIssueOwnedByRun(input: {
        companyId: string;
        agentId: string;
        ownerRunId: string;
        title: string;
      }) {
        const issueId = randomUUID();
        const stageId = randomUUID();
        await db.insert(issues).values({
          id: issueId,
          companyId: input.companyId,
          title: input.title,
          status: "in_review",
          priority: "high",
          assigneeAgentId: input.agentId,
          checkoutRunId: input.ownerRunId,
          executionRunId: input.ownerRunId,
          executionAgentNameKey: "codexcoder",
          executionLockedAt: new Date(),
          executionPolicy: {
            stages: [{
              id: stageId,
              type: "review",
              participants: [{ type: "agent", agentId: input.agentId }],
            }],
          },
          executionState: pendingReviewExecutionState(input.agentId, stageId),
        });
        return issueId;
      }

      async function seedLiveForeignOwnerRun(input: { companyId: string; agentId: string }) {
        const runId = randomUUID();
        await db.insert(heartbeatRuns).values({
          id: runId,
          companyId: input.companyId,
          agentId: input.agentId,
          status: "running",
          invocationSource: "assignment",
          // The discriminator against the never-started holder: this one ran.
          startedAt: new Date(),
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
        });
        return runId;
      }

      for (const holderStatus of ["queued", "scheduled_retry"] as const) {
        it(`lets the assignee's own run write a pending review held by a ${holderStatus} run that never started`, async () => {
          const { companyId, agentId, currentRunId } = await seedCompanyAgentAndRuns();
          const neverStartedOwnerRunId = await seedNeverStartedOwnerRun({
            companyId,
            agentId,
            status: holderStatus,
          });
          const issueId = await seedPendingReviewIssueOwnedByRun({
            companyId,
            agentId,
            ownerRunId: neverStartedOwnerRunId,
            title: `Never-started ${holderStatus} owner must not fence the pending review`,
          });

          await expect(
            svc().assertPendingReviewRunOwnership(issueId, agentId, currentRunId),
          ).resolves.toEqual({ owned: true, fenced: false });
        });
      }

      it("writes the document the reported 409 refused, with a queued never-started holder", async () => {
        const { companyId, agentId, currentRunId } = await seedCompanyAgentAndRuns();
        const neverStartedOwnerRunId = await seedNeverStartedOwnerRun({
          companyId,
          agentId,
          status: "queued",
        });
        const issueId = await seedPendingReviewIssueOwnedByRun({
          companyId,
          agentId,
          ownerRunId: neverStartedOwnerRunId,
          title: "Queued owner must not shut the document surface",
        });

        const res = await request(createApp(agentActor(companyId, agentId, currentRunId)))
          .put(`/api/issues/${issueId}/documents/plan`)
          .send({ format: "markdown", body: "# Plan\n\nWritten past a never-started holder." });

        // 201: the upsert CREATED the document. Before this fix the same
        // request was answered 409 `pending_review_stage_locked_by_another_run`.
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        expect(res.body).toMatchObject({ key: "plan", latestRevisionNumber: 1 });
      });

      // The must-fail input. A fence that opens for a never-started holder is
      // only correct if it still shuts for a live one — the two-runs-of-one
      // -agent case BLO-22666 AC2 exists to refuse.
      it("still fences a pending review held by a live running run of the same agent", async () => {
        const { companyId, agentId, currentRunId } = await seedCompanyAgentAndRuns();
        const liveOwnerRunId = await seedLiveForeignOwnerRun({ companyId, agentId });
        const issueId = await seedPendingReviewIssueOwnedByRun({
          companyId,
          agentId,
          ownerRunId: liveOwnerRunId,
          title: "Live sibling owner still fences the pending review",
        });

        const res = await request(createApp(agentActor(companyId, agentId, currentRunId)))
          .put(`/api/issues/${issueId}/documents/plan`)
          .send({ format: "markdown", body: "# Plan" });

        expect(res.status, JSON.stringify(res.body)).toBe(409);
        expect(res.body.details).toMatchObject({
          reason: "pending_review_stage_locked_by_another_run",
          holderLiveness: "live",
          concurrentSiblingRun: true,
        });
      });

      // Ally on #3607: the second must-fail input, and the one the first
      // version of this fix got wrong. The four tests above vary the HOLDER and
      // hold the actor live; this holds the holder at the exact shape they open
      // the fence for and varies the ACTOR, so the actor's run status is the
      // only discriminator between this 409 and their 201.
      //
      // It matters because a run the server has marked terminal keeps executing
      // for ~10 more minutes (BLO-28441) and cannot discover that its writes are
      // refused, and because the two early-returns past this fence let it decide
      // another run's review stage. `failedRunId` is the shape BLO-28441
      // describes; the holder is a successor that is merely queued behind it.
      it("still fences a never-started holder when the actor's own run is already terminal", async () => {
        const { companyId, agentId, failedRunId } = await seedCompanyAgentAndRuns();
        const neverStartedOwnerRunId = await seedNeverStartedOwnerRun({
          companyId,
          agentId,
          status: "queued",
        });
        const issueId = await seedPendingReviewIssueOwnedByRun({
          companyId,
          agentId,
          ownerRunId: neverStartedOwnerRunId,
          title: "Terminal actor must not be granted a reaped holder's lock",
        });

        const res = await request(createApp(agentActor(companyId, agentId, failedRunId)))
          .put(`/api/issues/${issueId}/documents/plan`)
          .send({ format: "markdown", body: "# Plan" });

        expect(res.status, JSON.stringify(res.body)).toBe(409);
        // The holder really is reaped — this is the opening case — and the
        // refusal is attributable to the caller instead, which is what the
        // remediation string needs to say.
        expect(res.body.details).toMatchObject({
          reason: "pending_review_stage_locked_by_another_run",
          holderLiveness: "not_live",
          actorRunStatus: "failed",
        });
      });

      // The parity claim the gate above rests on, measured rather than
      // asserted: the `in_progress` ladder refuses a terminal actor too
      // (`adoptStaleCheckoutRun`'s `actorLive`, and
      // `runningCheckoutExecutionPatch`, which grants only an exactly-`running`
      // run). Same holder shape as the drift guard below, same actor, so the
      // pair of tests brackets the actor axis at both entry points the way that
      // one brackets the holder axis.
      it("answers a terminal actor identically at the in_progress and in_review entry points", async () => {
        const { companyId, agentId, failedRunId } = await seedCompanyAgentAndRuns();
        const inProgressOwnerRunId = await seedNeverStartedOwnerRun({
          companyId,
          agentId,
          status: "queued",
        });
        const inReviewOwnerRunId = await seedNeverStartedOwnerRun({
          companyId,
          agentId,
          status: "queued",
        });
        const inProgressIssueId = await seedIssueOwnedByRun({
          companyId,
          agentId,
          ownerRunId: inProgressOwnerRunId,
          title: "in_progress entry point, terminal actor",
        });
        const inReviewIssueId = await seedPendingReviewIssueOwnedByRun({
          companyId,
          agentId,
          ownerRunId: inReviewOwnerRunId,
          title: "in_review entry point, terminal actor",
        });

        const actor = agentActor(companyId, agentId, failedRunId);
        const inProgressRes = await request(createApp(actor))
          .patch(`/api/issues/${inProgressIssueId}`)
          .send({ status: "todo" });
        const inReviewRes = await request(createApp(actor))
          .put(`/api/issues/${inReviewIssueId}/documents/plan`)
          .send({ format: "markdown", body: "# Plan" });

        expect(
          { in_progress: inProgressRes.status, in_review: inReviewRes.status },
          JSON.stringify({ inProgress: inProgressRes.body, inReview: inReviewRes.body }),
        ).toEqual({ in_progress: 409, in_review: 409 });
      });

      // The drift guard proper: one never-started holder shape, both entry
      // points, one verdict. `assertCheckoutOwner` reaches
      // `isReapableHeartbeatRunRow` through adoptStaleExecutionLock;
      // `assertPendingReviewRunOwnership` reaches the same answer through the
      // liveness gate. If a later fork of either re-inherits the terminal-only
      // clear, exactly one half of this test fails.
      it("answers the never-started holder identically at the in_progress and in_review entry points", async () => {
        const { companyId, agentId, currentRunId } = await seedCompanyAgentAndRuns();
        const inProgressOwnerRunId = await seedNeverStartedOwnerRun({
          companyId,
          agentId,
          status: "queued",
        });
        const inReviewOwnerRunId = await seedNeverStartedOwnerRun({
          companyId,
          agentId,
          status: "queued",
        });
        const inProgressIssueId = await seedIssueOwnedByRun({
          companyId,
          agentId,
          ownerRunId: inProgressOwnerRunId,
          title: "in_progress entry point, never-started holder",
        });
        const inReviewIssueId = await seedPendingReviewIssueOwnedByRun({
          companyId,
          agentId,
          ownerRunId: inReviewOwnerRunId,
          title: "in_review entry point, never-started holder",
        });

        const actor = agentActor(companyId, agentId, currentRunId);
        const inProgressRes = await request(createApp(actor))
          .patch(`/api/issues/${inProgressIssueId}`)
          .send({ status: "todo" });
        const inReviewRes = await request(createApp(actor))
          .put(`/api/issues/${inReviewIssueId}/documents/plan`)
          .send({ format: "markdown", body: "# Plan" });

        // Compared as one object so a failure names WHICH entry point drifted,
        // rather than stopping at the first assertion.
        expect(
          { in_progress: inProgressRes.status, in_review: inReviewRes.status },
          JSON.stringify({ inProgress: inProgressRes.body, inReview: inReviewRes.body }),
        ).toEqual({ in_progress: 200, in_review: 201 });
      });
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

  // PEN-5940. The two cases above are refused by `unassignedAgentCheckoutCondition`,
  // which tests `assigneeUserId` directly. The recovery owner does not go through
  // that term — it gets its own `activeRecoveryOwnerCondition` — and it is the one
  // claimant that reaches `svc.checkout` having skipped BOTH route-level gates:
  // `assertCanAssignTasks` and the BLO-22856 `issue:mutate` boundary are each
  // deliberately exempted for it, on the stated grounds that the claim predicate
  // re-validates atomically. So the predicate is the only thing standing here, and
  // until this test it was not carrying the human-hold term: the UPDATE sets
  // `assigneeUserId: null`, so the claim did not merely take the row, it blanked
  // the person off it.
  it("does not let a source-scoped recovery owner check out a row a person holds", async () => {
    const { companyId, agentId, currentRunId } = await seedCompanyAgentAndRuns();
    const issueId = randomUUID();
    const reviewerUserId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Human-held row under an active recovery action",
      status: "in_review",
      priority: "high",
      assigneeAgentId: null,
      assigneeUserId: reviewerUserId,
      checkoutRunId: null,
      executionRunId: null,
      executionAgentNameKey: null,
      executionLockedAt: null,
    });
    // The exact shape the route's `allowSourceScopedRecoveryOwnerCheckout` accepts:
    // active, owned by this agent, and source-scoped to this very issue.
    await db.insert(issueRecoveryActions).values({
      companyId,
      sourceIssueId: issueId,
      kind: "stranded_assigned_issue",
      status: "active",
      ownerType: "agent",
      ownerAgentId: agentId,
      cause: "stranded_assigned_issue",
      fingerprint: `fingerprint-${randomUUID()}`,
      nextAction: "Diagnose the stranded row.",
    });

    const res = await request(createApp(agentActor(companyId, agentId, currentRunId)))
      .post(`/api/issues/${issueId}/checkout`)
      .send({
        agentId,
        expectedStatuses: ["todo", "backlog", "blocked", "in_review"],
      });

    expect(res.status, JSON.stringify(res.body)).toBe(409);

    const row = await db
      .select({
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        assigneeUserId: issues.assigneeUserId,
        checkoutRunId: issues.checkoutRunId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    // `assigneeUserId` is the assertion that matters: a successful claim would
    // have nulled it, which is the row silently ceasing to be human-held.
    expect(row).toEqual({
      status: "in_review",
      assigneeAgentId: null,
      assigneeUserId: reviewerUserId,
      checkoutRunId: null,
    });
  });

  it("preserves pending execution-policy review status through checkout so approval comments apply", async () => {
    const { companyId, agentId, currentRunId } = await seedCompanyAgentAndRuns();
    const issueId = randomUUID();
    const stageId = randomUUID();
    const participant = { type: "agent" as const, agentId, userId: null };
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Review stage awaiting approval",
      status: "in_review",
      priority: "high",
      assigneeAgentId: agentId,
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

    const checkout = await request(createApp(agentActor(companyId, agentId, currentRunId)))
      .post(`/api/issues/${issueId}/checkout`)
      .send({
        agentId,
        expectedStatuses: ["todo", "backlog", "blocked", "in_review"],
      });

    expect(checkout.status, JSON.stringify(checkout.body)).toBe(200);
    expect(checkout.body.status).toBe("in_review");
    expect(checkout.body.checkoutRunId).toBe(currentRunId);
    expect(checkout.body.executionRunId).toBe(currentRunId);

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
    // Must NOT fall into the issue_in_review_not_checkoutable 422 — that branch is only for
    // an unlocked in_review issue, and returning it here would read as "go ahead and work it".
    expect(res.body.code).not.toBe("issue_in_review_not_checkoutable");

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

});
