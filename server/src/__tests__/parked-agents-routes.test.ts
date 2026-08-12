import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  companyMemberships,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres parked-agents route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

/**
 * BLO-24011 acceptance criterion: "which agents are currently unable to run, and
 * until when?" must be answerable without invoking a heartbeat on each agent to
 * find out.
 */
describeEmbeddedPostgres("parked agents route", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-parked-agents-routes-");
    db = createDb(tempDb.connectionString);
  });

  afterEach(async () => {
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companyMemberships);
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
    app.use("/api", agentRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
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

  function agentActor(companyId: string, agentId: string): Express.Request["actor"] {
    return {
      type: "agent",
      agentId,
      companyId,
      runId: randomUUID(),
      source: "agent_jwt",
    };
  }

  async function seedCompany(): Promise<string> {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    // The authorization policy reads membership from the DB, not from the actor
    // object, so a board actor without this row is denied every agent:read.
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "board-user",
      status: "active",
      membershipRole: "admin",
    });
    return companyId;
  }

  async function seedAgent(companyId: string, name: string): Promise<string> {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name,
      role: "engineer",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return agentId;
  }

  async function seedRun(input: {
    companyId: string;
    agentId: string;
    status: string;
    scheduledRetryAt?: Date | null;
    scheduledRetryReason?: string | null;
    scheduledRetryAttempt?: number;
    resultJson?: Record<string, unknown>;
  }) {
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: input.status,
      scheduledRetryAt: input.scheduledRetryAt ?? null,
      scheduledRetryReason: input.scheduledRetryReason ?? null,
      scheduledRetryAttempt: input.scheduledRetryAttempt ?? 0,
      errorCode: input.status === "scheduled_retry" ? "rate_limit_exhausted" : null,
      resultJson: input.resultJson ?? {},
    });
  }

  it("reports who is parked, until when, and why — soonest due first", async () => {
    const companyId = await seedCompany();
    const soonAgent = await seedAgent(companyId, "PlatformSREEngineer");
    const laterAgent = await seedAgent(companyId, "BackendEngineer");
    const runningAgent = await seedAgent(companyId, "FrontendEngineer");

    const soonDue = new Date(Date.now() + 5 * 60_000);
    const laterDue = new Date(Date.now() + 60 * 60_000);
    await seedRun({
      companyId,
      agentId: laterAgent,
      status: "scheduled_retry",
      scheduledRetryAt: laterDue,
      scheduledRetryReason: "ccrotate_capacity",
      scheduledRetryAttempt: 1,
      resultJson: {
        penstockProvider: "anthropic",
        penstockModel: "claude-sonnet-5[1m]",
        penstockRetryAfterSeconds: 3834,
      },
    });
    await seedRun({
      companyId,
      agentId: soonAgent,
      status: "scheduled_retry",
      scheduledRetryAt: soonDue,
      scheduledRetryReason: "ccrotate_capacity",
      scheduledRetryAttempt: 2,
    });
    // A healthy agent must not appear — the endpoint answers "cannot run", not
    // "has runs".
    await seedRun({ companyId, agentId: runningAgent, status: "running" });

    const res = await request(createApp(boardActor(companyId)))
      .get(`/api/companies/${companyId}/parked-agents`)
      .expect(200);

    expect(res.body.parkedCount).toBe(2);
    expect(res.body.agents.map((entry: { agentName: string }) => entry.agentName)).toEqual([
      "PlatformSREEngineer",
      "BackendEngineer",
    ]);

    const [soon, later] = res.body.agents;
    expect(soon.reason).toBe("ccrotate_capacity");
    expect(soon.attempt).toBe(2);
    expect(new Date(soon.scheduledRetryAt).toISOString()).toBe(soonDue.toISOString());
    expect(soon.retryInMs).toBeGreaterThan(0);
    expect(soon.overdueMs).toBe(0);

    // The provider's own claim travels with the row, so a park can be compared
    // against what was asked for without opening the run.
    expect(later.penstockProvider).toBe("anthropic");
    expect(later.penstockRetryAfterSeconds).toBe(3834);
  });

  it("flags a park whose due time has already passed", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId, "PlatformSREEngineer");
    await seedRun({
      companyId,
      agentId,
      status: "scheduled_retry",
      scheduledRetryAt: new Date(Date.now() - 90 * 60_000),
      scheduledRetryReason: "ccrotate_capacity",
      scheduledRetryAttempt: 1,
    });

    const res = await request(createApp(boardActor(companyId)))
      .get(`/api/companies/${companyId}/parked-agents`)
      .expect(200);

    // Due-but-still-parked is a different failure from a long park: the sweep is
    // not draining it. Distinguishing the two is the point of overdueMs.
    expect(res.body.overdueCount).toBe(1);
    expect(res.body.agents[0].overdueMs).toBeGreaterThan(60 * 60_000);
    expect(res.body.agents[0].retryInMs).toBe(0);
  });

  it("filters by retry reason", async () => {
    const companyId = await seedCompany();
    const capacityAgent = await seedAgent(companyId, "PlatformSREEngineer");
    const depAgent = await seedAgent(companyId, "BackendEngineer");
    await seedRun({
      companyId,
      agentId: capacityAgent,
      status: "scheduled_retry",
      scheduledRetryAt: new Date(Date.now() + 60_000),
      scheduledRetryReason: "ccrotate_capacity",
    });
    await seedRun({
      companyId,
      agentId: depAgent,
      status: "scheduled_retry",
      scheduledRetryAt: new Date(Date.now() + 60_000),
      scheduledRetryReason: "dep_blocked",
    });

    const res = await request(createApp(boardActor(companyId)))
      .get(`/api/companies/${companyId}/parked-agents?reason=ccrotate_capacity`)
      .expect(200);

    expect(res.body.parkedCount).toBe(1);
    expect(res.body.agents[0].agentName).toBe("PlatformSREEngineer");
    expect(res.body.reason).toBe("ccrotate_capacity");
  });

  it("is readable by a same-company agent actor, which is how the MCP tool calls it", async () => {
    // The whole point of the AC is that an agent can ask "who is parked?" instead
    // of waking each peer to discover it. Board-only gating would defeat that.
    const companyId = await seedCompany();
    const callerId = await seedAgent(companyId, "CTO");
    const parkedId = await seedAgent(companyId, "PlatformSREEngineer");
    await seedRun({
      companyId,
      agentId: parkedId,
      status: "scheduled_retry",
      scheduledRetryAt: new Date(Date.now() + 60_000),
      scheduledRetryReason: "ccrotate_capacity",
    });

    const res = await request(createApp(agentActor(companyId, callerId)))
      .get(`/api/companies/${companyId}/parked-agents`)
      .expect(200);

    expect(res.body.parkedCount).toBe(1);
    expect(res.body.agents[0].agentName).toBe("PlatformSREEngineer");
  });

  it("does not leak parked agents from another company", async () => {
    const companyId = await seedCompany();
    const otherCompanyId = await seedCompany();
    const otherAgent = await seedAgent(otherCompanyId, "OtherCompanyEngineer");
    await seedRun({
      companyId: otherCompanyId,
      agentId: otherAgent,
      status: "scheduled_retry",
      scheduledRetryAt: new Date(Date.now() + 60_000),
      scheduledRetryReason: "ccrotate_capacity",
    });

    const res = await request(createApp(boardActor(companyId)))
      .get(`/api/companies/${companyId}/parked-agents`)
      .expect(200);

    expect(res.body.parkedCount).toBe(0);
    expect(res.body.agents).toEqual([]);
  });
});
