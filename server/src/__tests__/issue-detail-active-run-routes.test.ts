import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, companyMemberships, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { isIssueHeldByForeignRun } from "../services/issue-run-holding.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue-detail active-run route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

/**
 * BLO-19001 follow-up. `skills/paperclip/SKILL.md` tells every agent to compare
 * its own `$PAPERCLIP_RUN_ID` against the issue's holder before touching a
 * shared worktree, and to cede when the holder is a *different* run that is
 * still `running`. It points at `GET /api/issues/{issueId}` for both halves of
 * that comparison.
 *
 * `executionRunId` alone cannot answer it — a finished run leaves the column
 * set — so the response has to carry the run's lifecycle status too. These
 * tests pin that contract at the route, not just at the predicate: the shape
 * the instructions promise is the shape the endpoint returns.
 */
describeEmbeddedPostgres("GET /api/issues/:id — active run holder", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-detail-active-run-");
    db = createDb(tempDb.connectionString);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(companyId: string) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        userId: "cloud-user-1",
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "owner", status: "active" }],
        source: "cloud_tenant",
        isInstanceAdmin: true,
      };
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  let prefixCounter = 0;

  async function seedCompanyAndAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    prefixCounter += 1;
    const prefix = `AR${prefixCounter}`;
    await db.insert(companies).values({
      id: companyId,
      name: `Active-run tenant ${prefixCounter}`,
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "cloud-user-1",
      membershipRole: "owner",
      status: "active",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `Worker ${prefixCounter}`,
      role: "engineer",
      status: "idle",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId, prefix };
  }

  async function seedRun(input: {
    companyId: string;
    agentId: string;
    status: string;
    startedAt?: Date | null;
    finishedAt?: Date | null;
  }) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      status: input.status,
      startedAt: input.startedAt ?? new Date(),
      finishedAt: input.finishedAt ?? null,
    });
    return runId;
  }

  async function seedIssue(input: {
    companyId: string;
    prefix: string;
    issueNumber: number;
    agentId: string;
    executionRunId: string | null;
  }) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId: input.companyId,
      issueNumber: input.issueNumber,
      identifier: `${input.prefix}-${input.issueNumber}`,
      title: `Issue ${input.issueNumber}`,
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: input.agentId,
      executionRunId: input.executionRunId,
      createdByUserId: "cloud-user-1",
    });
    return issueId;
  }

  it("returns executionRunId AND activeRun.status for a live holder", async () => {
    const { companyId, agentId, prefix } = await seedCompanyAndAgent();
    const runId = await seedRun({ companyId, agentId, status: "running" });
    const issueId = await seedIssue({
      companyId,
      prefix,
      issueNumber: 1,
      agentId,
      executionRunId: runId,
    });

    const res = await request(createApp(companyId)).get(`/api/issues/${issueId}`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // Both halves of the documented comparison must be present.
    expect(res.body.executionRunId).toBe(runId);
    expect(res.body.activeRun).toBeTruthy();
    expect(res.body.activeRun.id).toBe(runId);
    expect(res.body.activeRun.status).toBe("running");

    // The response is sufficient to drive the skill's cede decision: a run that
    // is not this one must be told to back off.
    expect(
      isIssueHeldByForeignRun({
        activeRun: res.body.activeRun,
        callerRunId: randomUUID(),
        nowMs: Date.now(),
      }),
    ).toBe(true);
    // ...and the holder itself must not be told to cede from its own issue.
    expect(
      isIssueHeldByForeignRun({
        activeRun: res.body.activeRun,
        callerRunId: runId,
        nowMs: Date.now(),
      }),
    ).toBe(false);
  });

  it("reports a silent-but-running holder as still holding", async () => {
    // A healthy run can be quiet far longer than the 15-minute slot-accounting
    // window; silence is not a release of the worktree.
    const { companyId, agentId, prefix } = await seedCompanyAndAgent();
    const runId = await seedRun({
      companyId,
      agentId,
      status: "running",
      startedAt: new Date(Date.now() - 40 * 60 * 1000),
    });
    const issueId = await seedIssue({
      companyId,
      prefix,
      issueNumber: 2,
      agentId,
      executionRunId: runId,
    });

    const res = await request(createApp(companyId)).get(`/api/issues/${issueId}`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.activeRun?.status).toBe("running");
    expect(
      isIssueHeldByForeignRun({
        activeRun: res.body.activeRun,
        callerRunId: randomUUID(),
        nowMs: Date.now(),
      }),
    ).toBe(true);
  });

  it("returns a queued activeRun without treating it as a worktree holder", async () => {
    const { companyId, agentId, prefix } = await seedCompanyAndAgent();
    const runId = await seedRun({ companyId, agentId, status: "queued" });
    const issueId = await seedIssue({
      companyId,
      prefix,
      issueNumber: 3,
      agentId,
      executionRunId: runId,
    });

    const res = await request(createApp(companyId)).get(`/api/issues/${issueId}`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.executionRunId).toBe(runId);
    expect(res.body.activeRun?.id).toBe(runId);
    expect(res.body.activeRun?.status).toBe("queued");
    expect(
      isIssueHeldByForeignRun({
        activeRun: res.body.activeRun,
        callerRunId: randomUUID(),
        nowMs: Date.now(),
      }),
    ).toBe(false);
  });

  it("returns activeRun null when the recorded run has terminalized", async () => {
    // `executionRunId` outlives the run, so a stale pointer must not read as held.
    for (const [index, status] of ["completed", "failed", "cancelled"].entries()) {
      const { companyId, agentId, prefix } = await seedCompanyAndAgent();
      const runId = await seedRun({
        companyId,
        agentId,
        status,
        finishedAt: new Date(),
      });
      const issueId = await seedIssue({
        companyId,
        prefix,
        issueNumber: 10 + index,
        agentId,
        executionRunId: runId,
      });

      const res = await request(createApp(companyId)).get(`/api/issues/${issueId}`);

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.executionRunId, `status=${status}`).toBe(runId);
      expect(res.body.activeRun, `status=${status}`).toBeNull();
      expect(
        isIssueHeldByForeignRun({
          activeRun: res.body.activeRun,
          callerRunId: randomUUID(),
          nowMs: Date.now(),
        }),
        `status=${status}`,
      ).toBe(false);
    }
  });

  it("returns activeRun null when executionRunId points at another company", async () => {
    const owner = await seedCompanyAndAgent();
    const foreign = await seedCompanyAndAgent();
    const foreignRunId = await seedRun({
      companyId: foreign.companyId,
      agentId: foreign.agentId,
      status: "running",
    });
    const issueId = await seedIssue({
      companyId: owner.companyId,
      prefix: owner.prefix,
      issueNumber: 19,
      agentId: owner.agentId,
      executionRunId: foreignRunId,
    });

    const res = await request(createApp(owner.companyId)).get(`/api/issues/${issueId}`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.executionRunId).toBe(foreignRunId);
    expect(res.body.activeRun).toBeNull();
    expect(JSON.stringify(res.body)).not.toContain(foreign.agentId);
  });

  it("returns activeRun null when no run is recorded", async () => {
    const { companyId, agentId, prefix } = await seedCompanyAndAgent();
    const issueId = await seedIssue({
      companyId,
      prefix,
      issueNumber: 20,
      agentId,
      executionRunId: null,
    });

    const res = await request(createApp(companyId)).get(`/api/issues/${issueId}`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.executionRunId).toBeNull();
    expect(res.body.activeRun).toBeNull();
  });

  it("serves the same shape when the issue is fetched by identifier", async () => {
    // Agents routinely dereference `BLO-1234` rather than a UUID; the holder
    // fields must not depend on which lookup form was used.
    const { companyId, agentId, prefix } = await seedCompanyAndAgent();
    const runId = await seedRun({ companyId, agentId, status: "running" });
    await seedIssue({ companyId, prefix, issueNumber: 30, agentId, executionRunId: runId });

    const res = await request(createApp(companyId)).get(`/api/issues/${prefix}-30`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.executionRunId).toBe(runId);
    expect(res.body.activeRun?.id).toBe(runId);
    expect(res.body.activeRun?.status).toBe("running");
  });
});
