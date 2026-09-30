/**
 * BLO-29312: `heartbeat.getRetrySuccessor` resolves a run's OUTBOUND retry edge
 * — the park created because that run ended.
 *
 * Every persisted `scheduledRetry*` column on `heartbeat_runs` points the other
 * way (it describes the park that produced the row), so before this helper the
 * only way to answer "was this failed run retried?" was to scan the whole table
 * for a matching `retryOfRunId`. Two agents instead read the answer off
 * `scheduledRetryAt` and got it wrong in opposite directions — BLO-28734 was
 * filed, root-caused, prescribed, and cancelled on that misreading.
 *
 * These tests are deliberately written against real Postgres rather than a
 * mocked service: the whole point of the helper is the reverse `retryOfRunId`
 * lookup, and a mock would assert only that a stub was called.
 */
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { cleanupHeartbeatTestState } from "./helpers/cleanup-heartbeat-test-state.js";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";
import { heartbeatService } from "../services/heartbeat.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres retry-successor tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("heartbeat run retry successor (BLO-29312)", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-retry-successor-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  });

  afterEach(async () => {
    await cleanupHeartbeatTestState(db, heartbeat, { errorLabel: "retry successor test cleanup" });
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "PlatformSREEngineer",
      role: "engineer",
      status: "active",
      adapterType: "claude_k8s",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function insertRun(
    values: Partial<typeof heartbeatRuns.$inferInsert> & { companyId: string; agentId: string },
  ) {
    const [row] = await db
      .insert(heartbeatRuns)
      .values({
        id: randomUUID(),
        invocationSource: "automation",
        triggerDetail: "system",
        status: "failed",
        ...values,
      })
      .returning();
    return row;
  }

  it("reports the successor park, with the successor's own due time", async () => {
    const { companyId, agentId } = await seedAgent();
    const failed = await insertRun({
      companyId,
      agentId,
      status: "failed",
      errorCode: "rate_limit_exhausted",
      error: "Run hit provider throttle/deadline before any token usage; scheduled for transient retry",
      createdAt: new Date("2026-08-18T18:07:00.000Z"),
    });
    const park = await insertRun({
      companyId,
      agentId,
      status: "scheduled_retry",
      retryOfRunId: failed.id,
      scheduledRetryAt: new Date("2026-08-18T22:59:59.000Z"),
      scheduledRetryAttempt: 1,
      scheduledRetryReason: "transient_failure",
      createdAt: new Date("2026-08-18T18:07:05.000Z"),
    });

    expect(await heartbeat.getRetrySuccessor(failed)).toEqual({
      state: "retried",
      runId: park.id,
      status: "scheduled_retry",
      scheduledRetryAt: new Date("2026-08-18T22:59:59.000Z"),
      scheduledRetryAttempt: 1,
      scheduledRetryReason: "transient_failure",
      createdAt: new Date("2026-08-18T18:07:05.000Z"),
    });
  });

  /**
   * The exact BLO-28734 confusion, pinned. A first-attempt run has
   * `scheduledRetryAt: null` because it was not itself born of a park — which
   * reads as "the system declined to retry it" and is the opposite of the
   * truth when a successor exists. Both halves are asserted together so a
   * future change cannot quietly reintroduce the ambiguity by, say, copying the
   * successor's due time onto the predecessor.
   */
  it("populates the forward pointer on a first-attempt run whose own scheduledRetryAt is null", async () => {
    const { companyId, agentId } = await seedAgent();
    const firstAttempt = await insertRun({ companyId, agentId, status: "failed" });
    const park = await insertRun({
      companyId,
      agentId,
      status: "scheduled_retry",
      retryOfRunId: firstAttempt.id,
      scheduledRetryAt: new Date("2026-08-18T22:59:59.000Z"),
      scheduledRetryAttempt: 1,
      scheduledRetryReason: "transient_failure",
    });

    expect(firstAttempt.scheduledRetryAt).toBeNull();
    expect(firstAttempt.scheduledRetryReason).toBeNull();
    expect(firstAttempt.scheduledRetryAttempt).toBe(0);

    const successor = await heartbeat.getRetrySuccessor(firstAttempt);
    expect(successor.state).toBe("retried");
    expect(successor.runId).toBe(park.id);
    expect(successor.scheduledRetryAt).toEqual(new Date("2026-08-18T22:59:59.000Z"));
  });

  it("asserts not_retried — rather than returning a bare null — for a terminal run with no successor", async () => {
    const { companyId, agentId } = await seedAgent();
    for (const status of ["failed", "succeeded", "cancelled", "timed_out"] as const) {
      const run = await insertRun({ companyId, agentId, status });
      expect(await heartbeat.getRetrySuccessor(run)).toEqual({
        state: "not_retried",
        runId: null,
        status: null,
        scheduledRetryAt: null,
        scheduledRetryAttempt: null,
        scheduledRetryReason: null,
        createdAt: null,
      });
    }
  });

  /**
   * "Nothing has been retried from this run yet" and "this run was not retried"
   * are different facts, and collapsing them is how a live run reads as a
   * failure that the platform declined to recover.
   */
  it("distinguishes a still-running run from one that was not retried", async () => {
    const { companyId, agentId } = await seedAgent();
    for (const status of ["queued", "running", "scheduled_retry"] as const) {
      const run = await insertRun({ companyId, agentId, status });
      expect((await heartbeat.getRetrySuccessor(run)).state).toBe("not_applicable");
    }
  });

  it("takes the first successor when a run somehow has more than one", async () => {
    const { companyId, agentId } = await seedAgent();
    const failed = await insertRun({ companyId, agentId, status: "failed" });
    const first = await insertRun({
      companyId,
      agentId,
      status: "cancelled",
      retryOfRunId: failed.id,
      createdAt: new Date("2026-08-18T18:07:05.000Z"),
    });
    await insertRun({
      companyId,
      agentId,
      status: "scheduled_retry",
      retryOfRunId: failed.id,
      createdAt: new Date("2026-08-18T18:09:05.000Z"),
    });

    expect((await heartbeat.getRetrySuccessor(failed)).runId).toBe(first.id);
  });

  it("does not resolve a successor across a company boundary", async () => {
    const own = await seedAgent();
    const other = await seedAgent();
    const failed = await insertRun({ companyId: own.companyId, agentId: own.agentId, status: "failed" });
    await insertRun({
      companyId: other.companyId,
      agentId: other.agentId,
      status: "scheduled_retry",
      retryOfRunId: failed.id,
      scheduledRetryAt: new Date("2026-08-18T22:59:59.000Z"),
    });

    expect((await heartbeat.getRetrySuccessor(failed)).state).toBe("not_retried");
  });

  /**
   * The acceptance criterion is specifically that one read of the run answers
   * the question, with no paging of the company run list — so it is asserted
   * against the real route, real service, and real SQL rather than a mock.
   */
  describe("GET /api/heartbeat-runs/:runId", () => {
    function createApp(companyId: string) {
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        req.actor = {
          type: "board",
          userId: "board-user",
          companyIds: [companyId],
          memberships: [{ companyId, membershipRole: "admin", status: "active" }],
          isInstanceAdmin: false,
          source: "session",
        };
        next();
      });
      app.use("/api", agentRoutes(db));
      app.use(errorHandler);
      return app;
    }

    it("answers 'was this failed run retried?' in a single read", async () => {
      const { companyId, agentId } = await seedAgent();
      const failed = await insertRun({
        companyId,
        agentId,
        status: "failed",
        errorCode: "rate_limit_exhausted",
      });
      const park = await insertRun({
        companyId,
        agentId,
        status: "scheduled_retry",
        retryOfRunId: failed.id,
        scheduledRetryAt: new Date("2026-08-18T22:59:59.000Z"),
        scheduledRetryAttempt: 1,
        scheduledRetryReason: "transient_failure",
      });

      const res = await request(createApp(companyId)).get(`/api/heartbeat-runs/${failed.id}`);

      expect(res.status).toBe(200);
      // Inbound field unchanged — this run was a first attempt, so it is
      // correctly null and must stay null.
      expect(res.body.scheduledRetryAt).toBeNull();
      expect(res.body.retrySuccessor).toMatchObject({
        state: "retried",
        runId: park.id,
        status: "scheduled_retry",
        scheduledRetryAt: "2026-08-18T22:59:59.000Z",
        scheduledRetryAttempt: 1,
        scheduledRetryReason: "transient_failure",
      });
    });

    it("states not_retried on a failed run that was never parked", async () => {
      const { companyId, agentId } = await seedAgent();
      const failed = await insertRun({ companyId, agentId, status: "failed" });

      const res = await request(createApp(companyId)).get(`/api/heartbeat-runs/${failed.id}`);

      expect(res.status).toBe(200);
      expect(res.body.retrySuccessor).toMatchObject({ state: "not_retried", runId: null });
    });
  });
});
