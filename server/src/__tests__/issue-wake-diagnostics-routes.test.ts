import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueRelations,
  issues,
  projects,
} from "@paperclipai/db";
import { LOW_TRUST_REVIEW_PRESET } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes, ISSUE_WAKE_DIAGNOSTIC_KNOWN_REASONS } from "../routes/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres wake diagnostic route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

type Db = ReturnType<typeof createDb>;
type CompanyRow = typeof companies.$inferSelect;
type AgentRow = typeof agents.$inferSelect;
type ProjectRow = typeof projects.$inferSelect;
type IssueRow = typeof issues.$inferSelect;

function createApp(db: Db, actor: Express.Request["actor"]) {
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

function boardActor(company: CompanyRow): Express.Request["actor"] {
  return {
    type: "board",
    userId: "board-user",
    companyIds: [company.id],
    memberships: [{ companyId: company.id, membershipRole: "operator", status: "active" }],
    isInstanceAdmin: true,
    source: "local_implicit",
  };
}

function agentActor(company: CompanyRow, agent: AgentRow, runId: string): Express.Request["actor"] {
  return {
    type: "agent",
    agentId: agent.id,
    companyId: company.id,
    runId,
    source: "agent_jwt",
  };
}

async function seedCompany(db: Db, label = "Wake Diagnostics") {
  const nonce = randomUUID().slice(0, 8);
  const [company] = await db.insert(companies).values({
    name: `${label} ${nonce}`,
    issuePrefix: `WD${nonce.slice(0, 4).toUpperCase()}`,
    defaultResponsibleUserId: "board-user",
  }).returning();
  return company!;
}

async function seedAgent(db: Db, companyId: string, permissions: Record<string, unknown> = {}) {
  const [agent] = await db.insert(agents).values({
    companyId,
    name: `Agent ${randomUUID().slice(0, 6)}`,
    role: "engineer",
    adapterType: "process",
    adapterConfig: {},
    runtimeConfig: {},
    permissions,
  }).returning();
  return agent!;
}

async function seedProject(db: Db, companyId: string, name: string) {
  const [project] = await db.insert(projects).values({
    companyId,
    name,
    status: "in_progress",
  }).returning();
  return project!;
}

async function seedIssue(
  db: Db,
  input: {
    companyId: string;
    projectId?: string | null;
    title: string;
    status?: string;
    assigneeAgentId?: string | null;
    parentId?: string | null;
  },
) {
  const [issue] = await db.insert(issues).values({
    companyId: input.companyId,
    projectId: input.projectId ?? null,
    parentId: input.parentId ?? null,
    title: input.title,
    status: input.status ?? "todo",
    priority: "medium",
    assigneeAgentId: input.assigneeAgentId ?? null,
    responsibleUserId: "board-user",
  }).returning();
  return issue!;
}

async function blockIssue(db: Db, companyId: string, blockerIssueId: string, blockedIssueId: string) {
  await db.insert(issueRelations).values({
    companyId,
    issueId: blockerIssueId,
    relatedIssueId: blockedIssueId,
    type: "blocks",
  });
}

async function attachLowTrustRun(db: Db, fixture: {
  company: CompanyRow;
  agent: AgentRow;
  allowedProject: ProjectRow;
  root: IssueRow;
  visibleBlocker: IssueRow;
}) {
  const executionPolicy = {
    authorizationPolicy: {
      trustBoundary: {
        mode: LOW_TRUST_REVIEW_PRESET,
        companyId: fixture.company.id,
        projectIds: [fixture.allowedProject.id],
        rootIssueId: fixture.root.id,
        issueIds: [fixture.root.id, fixture.visibleBlocker.id],
        allowedAgentIds: [],
      },
    },
  };
  await db.update(agents).set({
    permissions: {
      trustPreset: LOW_TRUST_REVIEW_PRESET,
      authorizationPolicy: executionPolicy.authorizationPolicy,
    },
  }).where(eq(agents.id, fixture.agent.id));
  fixture.agent.permissions = {
    trustPreset: LOW_TRUST_REVIEW_PRESET,
    authorizationPolicy: executionPolicy.authorizationPolicy,
  };

  const [run] = await db.insert(heartbeatRuns).values({
    companyId: fixture.company.id,
    agentId: fixture.agent.id,
    status: "running",
    contextSnapshot: {
      issueId: fixture.root.id,
      executionPolicy,
    },
  }).returning();
  await db.update(issues).set({
    assigneeAgentId: fixture.agent.id,
    checkoutRunId: run!.id,
    executionRunId: run!.id,
    executionPolicy,
  }).where(eq(issues.id, fixture.root.id));
  return run!;
}

describeEmbeddedPostgres("issue wake diagnostics route", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-wake-diagnostics-");
    db = createDb(tempDb.connectionString);
  });

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(agentWakeupRequests);
    await db.delete(issueRelations);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(projects);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("returns recent wake rows newest-first with a deterministic diagnosis", async () => {
    const company = await seedCompany(db);
    const agent = await seedAgent(db, company.id);
    const project = await seedProject(db, company.id, "Core");
    const issue = await seedIssue(db, {
      companyId: company.id,
      projectId: project.id,
      title: "Wake target",
      status: "todo",
      assigneeAgentId: agent.id,
    });
    const wakeRunId = randomUUID();

    await db.insert(agentWakeupRequests).values({
      companyId: company.id,
      agentId: agent.id,
      source: "automation",
      reason: "issue_blockers_resolved",
      status: "completed",
      coalescedCount: 2,
      payload: { issueId: issue.id, rawMarker: "SHOULD_NOT_LEAK" },
      runId: wakeRunId,
      requestedAt: new Date(Date.now() - 10_000),
      claimedAt: new Date(Date.now() - 9_000),
      finishedAt: new Date(Date.now() - 1_000),
    });

    const res = await request(createApp(db, boardActor(company)))
      .get(`/api/issues/${issue.id}/diagnostics/wakes`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      diagnosis: expect.stringContaining("completed for issue_blockers_resolved"),
      likelyReason: expect.stringContaining("completed for issue_blockers_resolved"),
      wakeRequestCount: 1,
      activityRecordCount: 0,
      truncated: false,
      caps: { maxWakeRequests: 50, maxActivityRecords: 50, lookbackDays: 14 },
    });
    expect(res.body.events).toHaveLength(1);
    expect(res.body.events[0]).toMatchObject({
      kind: "wake_request",
      agentId: agent.id,
      runId: wakeRunId,
      source: "automation",
      reason: "issue_blockers_resolved",
      status: "completed",
      coalescedCount: 2,
      failureClass: null,
    });
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain("SHOULD_NOT_LEAK");
    expect(serialized).not.toContain("\"payload\"");
    expect(serialized).not.toContain("\"details\"");
    expect(serialized).not.toContain("\"triggerDetail\"");
    expect(serialized).not.toContain("\"error\"");
  });

  // PEN-3727: the wake that produced no run row is the one an operator comes here to
  // explain, and `issue_execution_deferred` used to project to "other" -- so the row
  // that held the whole answer reported the same reason as a row holding none.
  it("names the suppression reason for a wake deferred behind the issue execution lock", async () => {
    const company = await seedCompany(db);
    const agent = await seedAgent(db, company.id);
    const project = await seedProject(db, company.id, "Core");
    const issue = await seedIssue(db, {
      companyId: company.id,
      projectId: project.id,
      title: "Comment wake with no run row",
      status: "in_review",
      assigneeAgentId: agent.id,
    });

    await db.insert(agentWakeupRequests).values({
      companyId: company.id,
      agentId: agent.id,
      source: "automation",
      reason: "issue_execution_deferred",
      status: "deferred_issue_execution",
      coalescedCount: 3,
      payload: { issueId: issue.id },
      runId: null,
      requestedAt: new Date(Date.now() - 10_000),
    });

    const res = await request(createApp(db, boardActor(company)))
      .get(`/api/issues/${issue.id}/diagnostics/wakes`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.events).toHaveLength(1);
    expect(res.body.events[0]).toMatchObject({
      kind: "wake_request",
      reason: "issue_execution_deferred",
      status: "deferred_issue_execution",
      coalescedCount: 3,
      runId: null,
      claimedAt: null,
    });
    expect(res.body.diagnosis).toContain("deferred for issue_execution_deferred");
  });

  // The other no-run-row family, and the one whose spelling the first revision of this
  // change got wrong: `writeSkippedHeartbeatRequest` writes the DOTTED literal to the
  // `reason` column while the bare form lives only in nested `payload.heartbeatSkip`.
  // Serve the row end to end so the column spelling is exercised, not just asserted.
  it("names the suppression reason for a wake skipped by the worktree execution cutoff", async () => {
    const company = await seedCompany(db);
    const agent = await seedAgent(db, company.id);
    const project = await seedProject(db, company.id, "Core");
    const issue = await seedIssue(db, {
      companyId: company.id,
      projectId: project.id,
      title: "Wake skipped before any run",
      status: "in_review",
      assigneeAgentId: agent.id,
    });

    await db.insert(agentWakeupRequests).values({
      companyId: company.id,
      agentId: agent.id,
      source: "automation",
      reason: "heartbeat.worktree_execution_cutoff",
      status: "skipped",
      payload: {
        issueId: issue.id,
        heartbeatSkip: { reason: "worktree_execution_cutoff", issueId: issue.id },
      },
      runId: null,
      requestedAt: new Date(Date.now() - 10_000),
    });

    const res = await request(createApp(db, boardActor(company)))
      .get(`/api/issues/${issue.id}/diagnostics/wakes`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.events).toHaveLength(1);
    expect(res.body.events[0]).toMatchObject({
      kind: "wake_request",
      reason: "heartbeat.worktree_execution_cutoff",
      status: "skipped",
      runId: null,
    });
  });

  // PEN-3727 review follow-up. The third no-run-row family, and the one the
  // writer-derived scan could not see: this writer passes a const identifier, not an
  // inline literal, so it reached "other" through the very suite added to stop that.
  // Its payload already carries `code` / `reason` / `remediation`, which this route
  // does not expose -- so projecting the reason to "other" discarded the only part of
  // the answer an operator could read. Serve it end to end rather than only anchoring
  // the scan: the scan proves the spelling, this proves the route returns it.
  it("names the suppression reason for a wake skipped by the worktree pre-flight", async () => {
    const company = await seedCompany(db);
    const agent = await seedAgent(db, company.id);
    const project = await seedProject(db, company.id, "Core");
    const issue = await seedIssue(db, {
      companyId: company.id,
      projectId: project.id,
      title: "Wake blocked by unrunnable workspace settings",
      status: "blocked",
      assigneeAgentId: agent.id,
    });

    await db.insert(agentWakeupRequests).values({
      companyId: company.id,
      agentId: agent.id,
      source: "automation",
      reason: "workspace_worktree_requires_project",
      status: "skipped",
      payload: {
        issueId: issue.id,
        heartbeatSkip: {
          code: "workspace_worktree_requires_project",
          reason: "Worktree execution requires a project workspace.",
          remediation: "Attach the issue to a project or switch it off worktree mode.",
        },
      },
      runId: null,
      requestedAt: new Date(Date.now() - 10_000),
    });

    const res = await request(createApp(db, boardActor(company)))
      .get(`/api/issues/${issue.id}/diagnostics/wakes`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.events).toHaveLength(1);
    expect(res.body.events[0]).toMatchObject({
      kind: "wake_request",
      reason: "workspace_worktree_requires_project",
      status: "skipped",
      runId: null,
    });
    // The payload stays redacted -- admitting the reason must not widen the response.
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain("\"payload\"");
    expect(serialized).not.toContain("remediation");
  });

  it("returns null diagnosis for an unblocked issue with no wake history", async () => {
    const company = await seedCompany(db);
    const project = await seedProject(db, company.id, "Core");
    const issue = await seedIssue(db, {
      companyId: company.id,
      projectId: project.id,
      title: "Quiet issue",
      status: "todo",
    });

    const res = await request(createApp(db, boardActor(company)))
      .get(`/api/issues/${issue.id}/diagnostics/wakes`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.diagnosis).toBeNull();
    expect(res.body.likelyReason).toBeNull();
    expect(res.body.events).toEqual([]);
    expect(res.body.wakeRequestCount).toBe(0);
    expect(res.body.activityRecordCount).toBe(0);
  });

  it("infers Case-B never-enqueued blockers-resolved wake from visible blocker state", async () => {
    const company = await seedCompany(db);
    const agent = await seedAgent(db, company.id);
    const project = await seedProject(db, company.id, "Core");
    const root = await seedIssue(db, {
      companyId: company.id,
      projectId: project.id,
      title: "Blocked root",
      status: "blocked",
      assigneeAgentId: agent.id,
    });
    const blocker = await seedIssue(db, {
      companyId: company.id,
      projectId: project.id,
      title: "Unfinished blocker",
      status: "in_progress",
    });
    await blockIssue(db, company.id, blocker.id, root.id);

    const res = await request(createApp(db, boardActor(company)))
      .get(`/api/issues/${root.id}/diagnostics/wakes`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.events).toEqual([]);
    expect(res.body.diagnosis).toContain("No wake row exists");
    expect(res.body.diagnosis).toContain("Unfinished blocker");
    expect(res.body.diagnosis).toContain("in_progress");
    expect(res.body.diagnosis).toContain("issue_blockers_resolved has not fired");
  });

  it("omits hidden blocker state from Case-B diagnosis for boundary-scoped agents", async () => {
    const company = await seedCompany(db);
    const agent = await seedAgent(db, company.id);
    const allowedProject = await seedProject(db, company.id, "Allowed");
    const hiddenProject = await seedProject(db, company.id, "Hidden");
    const hiddenMarker = `HIDDEN-WAKE-BLOCKER-${randomUUID()}`;
    const root = await seedIssue(db, {
      companyId: company.id,
      projectId: allowedProject.id,
      title: "Scoped root",
      status: "blocked",
    });
    const visibleBlocker = await seedIssue(db, {
      companyId: company.id,
      projectId: allowedProject.id,
      title: "Visible blocker",
      status: "in_progress",
    });
    const hiddenBlocker = await seedIssue(db, {
      companyId: company.id,
      projectId: hiddenProject.id,
      title: hiddenMarker,
      status: "cancelled",
    });
    await blockIssue(db, company.id, visibleBlocker.id, root.id);
    await blockIssue(db, company.id, hiddenBlocker.id, root.id);
    const run = await attachLowTrustRun(db, { company, agent, allowedProject, root, visibleBlocker });

    const res = await request(createApp(db, agentActor(company, agent, run.id)))
      .get(`/api/issues/${root.id}/diagnostics/wakes`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.diagnosis).toContain("authorization boundary");
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain(hiddenBlocker.id);
    expect(serialized).not.toContain(hiddenMarker);
    expect(serialized).not.toContain("cancelled");

    const hiddenAgent = await seedAgent(db, company.id);
    const wakeRunId = randomUUID();
    const [activityRun] = await db.insert(heartbeatRuns).values({
      companyId: company.id,
      agentId: hiddenAgent.id,
      status: "succeeded",
    }).returning();
    const activityRunId = activityRun!.id;
    const holdId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      companyId: company.id,
      agentId: hiddenAgent.id,
      source: "automation",
      reason: "issue_blockers_resolved",
      status: "completed",
      coalescedCount: 0,
      payload: { issueId: root.id },
      runId: wakeRunId,
      requestedAt: new Date(Date.now() - 5_000),
      claimedAt: new Date(Date.now() - 4_000),
      finishedAt: new Date(Date.now() - 3_000),
    });
    await db.insert(activityLog).values({
      companyId: company.id,
      actorType: "system",
      actorId: "system",
      action: "issue.tree_hold_wakeup_deferred",
      entityType: "issue",
      entityId: root.id,
      agentId: hiddenAgent.id,
      runId: activityRunId,
      details: {
        rootIssueId: root.id,
        agentId: hiddenAgent.id,
        holdId,
        source: "automation",
        requestedReason: "issue_blockers_resolved",
      },
      createdAt: new Date(Date.now() - 1_000),
    });

    const resWithEvents = await request(createApp(db, agentActor(company, agent, run.id)))
      .get(`/api/issues/${root.id}/diagnostics/wakes`);

    expect(resWithEvents.status, JSON.stringify(resWithEvents.body)).toBe(200);
    expect(resWithEvents.body.events).toHaveLength(2);
    const activityEvent = resWithEvents.body.events.find((event: { kind: string }) => event.kind === "activity");
    const wakeEvent = resWithEvents.body.events.find((event: { kind: string }) => event.kind === "wake_request");
    expect(activityEvent).toMatchObject({
      kind: "activity",
      agentId: null,
      runId: null,
      holdId: null,
    });
    expect(wakeEvent).toMatchObject({
      kind: "wake_request",
      agentId: null,
      runId: null,
    });
    const serializedWithEvents = JSON.stringify(resWithEvents.body);
    expect(serializedWithEvents).not.toContain(hiddenBlocker.id);
    expect(serializedWithEvents).not.toContain(hiddenMarker);
    expect(serializedWithEvents).not.toContain(hiddenAgent.id);
    expect(serializedWithEvents).not.toContain(wakeRunId);
    expect(serializedWithEvents).not.toContain(activityRunId);
    expect(serializedWithEvents).not.toContain(holdId);
  });

  it("denies cross-company issue reads", async () => {
    const companyA = await seedCompany(db, "Company A");
    const companyB = await seedCompany(db, "Company B");
    const agentB = await seedAgent(db, companyB.id);
    const projectA = await seedProject(db, companyA.id, "A");
    const issueA = await seedIssue(db, {
      companyId: companyA.id,
      projectId: projectA.id,
      title: "Company A issue",
      status: "blocked",
    });
    const [runB] = await db.insert(heartbeatRuns).values({
      companyId: companyB.id,
      agentId: agentB.id,
      status: "running",
      contextSnapshot: { issueId: issueA.id },
    }).returning();

    const res = await request(createApp(db, agentActor(companyB, agentB, runB!.id)))
      .get(`/api/issues/${issueA.id}/diagnostics/wakes`);

    // Uniform 404 so cross-tenant ids are indistinguishable from missing ones.
    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(res.body.error).toBe("Issue not found");
  });

  it("projects activity records and wake failures without raw blobs", async () => {
    const company = await seedCompany(db);
    const agent = await seedAgent(db, company.id);
    const project = await seedProject(db, company.id, "Core");
    const issue = await seedIssue(db, {
      companyId: company.id,
      projectId: project.id,
      title: "Held issue",
      status: "todo",
      assigneeAgentId: agent.id,
    });
    const rawMarker = `RAW-DETAIL-${randomUUID()}`;
    const [activityRun] = await db.insert(heartbeatRuns).values({
      companyId: company.id,
      agentId: agent.id,
      status: "succeeded",
    }).returning();
    const activityRunId = activityRun!.id;

    await db.insert(agentWakeupRequests).values({
      companyId: company.id,
      agentId: agent.id,
      source: "automation",
      reason: "unknown-private-reason",
      status: "failed",
      payload: { issueId: issue.id, privateValue: rawMarker },
      error: `secret stack ${rawMarker}`,
      requestedAt: new Date(Date.now() - 60_000),
    });
    await db.insert(activityLog).values({
      companyId: company.id,
      actorType: "system",
      actorId: "system",
      action: "issue.tree_hold_wakeup_deferred",
      entityType: "issue",
      entityId: issue.id,
      agentId: agent.id,
      runId: activityRunId,
      details: {
        rootIssueId: issue.id,
        holdId: "hold-safe",
        source: "automation",
        requestedReason: "issue_commented",
        triggerDetail: rawMarker,
        secret: rawMarker,
      },
      createdAt: new Date(Date.now() - 1_000),
    });

    const res = await request(createApp(db, boardActor(company)))
      .get(`/api/issues/${issue.id}/diagnostics/wakes`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.diagnosis).toContain("deferred by an active issue-tree hold");
    expect(res.body.events).toHaveLength(2);
    expect(res.body.events[0]).toMatchObject({
      kind: "activity",
      action: "issue.tree_hold_wakeup_deferred",
      source: "automation",
      requestedReason: "issue_commented",
      agentId: agent.id,
      runId: activityRunId,
      holdId: "hold-safe",
      summary: "Wake was deferred because an active issue-tree hold was present.",
    });
    expect(res.body.events[1]).toMatchObject({
      kind: "wake_request",
      reason: "other",
      status: "failed",
      failureClass: "failed",
    });
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain(rawMarker);
    expect(serialized).not.toContain("\"payload\"");
    expect(serialized).not.toContain("\"details\"");
    expect(serialized).not.toContain("\"triggerDetail\"");
    expect(serialized).not.toContain("\"error\"");
  });

  it("caps wake output and reports truncation", async () => {
    const company = await seedCompany(db);
    const agent = await seedAgent(db, company.id);
    const project = await seedProject(db, company.id, "Core");
    const issue = await seedIssue(db, {
      companyId: company.id,
      projectId: project.id,
      title: "Noisy issue",
      status: "todo",
      assigneeAgentId: agent.id,
    });
    const wakeRows = [];
    for (let index = 0; index < 51; index += 1) {
      wakeRows.push({
        companyId: company.id,
        agentId: agent.id,
        source: "automation",
        reason: "issue_commented",
        status: "completed",
        payload: { issueId: issue.id },
        requestedAt: new Date(Date.now() - index * 1_000),
      });
    }
    await db.insert(agentWakeupRequests).values(wakeRows);

    const res = await request(createApp(db, boardActor(company)))
      .get(`/api/issues/${issue.id}/diagnostics/wakes`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.events).toHaveLength(50);
    expect(res.body.wakeRequestCount).toBe(50);
    expect(res.body.truncated).toBe(true);
    expect(res.body.truncatedSections).toEqual({ wakeRequests: true, activityRecords: false });
    expect(res.body.diagnosis).toContain("truncated to 50 wake requests");
    expect(res.body.caps).toEqual({ maxWakeRequests: 50, maxActivityRecords: 50, lookbackDays: 14 });
  });
});

// PEN-3727 review follow-up. Deliberately OUTSIDE `describeEmbeddedPostgres`: these
// assert a static registry against its writer, need no database, and must not go
// silently green on a host where embedded Postgres is unavailable.
describe("issue wake diagnostic reason allowlist", () => {
  const heartbeatUrl = new URL("../services/heartbeat.ts", import.meta.url);
  const heartbeatSource = readFileSync(fileURLToPath(heartbeatUrl), "utf8");

  // The two timer-scheduler skips this route cannot return. Hoisted so the positive
  // scan below and the negative test at the bottom carve out the SAME two names: if
  // one list grows and the other does not, the pair contradicts rather than drifts.
  const AGENT_SCOPED_UNREACHABLE = ["provider_capacity_deferred", "no_in_flight_work"];

  // `reason:` is not always an inline literal. Two writers pass a `SCREAMING_SNAKE`
  // const instead -- one declared in `heartbeat.ts`, one imported -- and the first
  // revision of this scan skipped both as "cannot be resolved statically". It can:
  // that shape is a module-level binding to a string literal, and skipping it is what
  // let `workspace_worktree_requires_project` reach "other" through the very suite
  // added to stop that. A lowercase identifier (`wakeReason`, `skipReason`,
  // `dailyCapBlock.reason`, `opts.reason`) is the genuinely unresolvable shape and
  // stays the documented, narrower gap.
  //
  // Lazy on purpose: only a name the scan actually meets is resolved, so this reads
  // two files rather than all 43 of `heartbeat.ts`'s relative imports.
  function resolveConstLiteral(name: string): string | null {
    const local = heartbeatSource.match(
      new RegExp(`(?:^|\\n)\\s*(?:export\\s+)?const\\s+${name}\\s*(?::[^=]+)?=\\s*"([^"]+)"`),
    );
    if (local) return local[1];

    for (const imported of heartbeatSource.matchAll(
      /import\s*\{([^}]*)\}\s*from\s*"(\.\.?\/[^"]+)"/g,
    )) {
      if (!new RegExp(`(^|[\\s,])${name}([\\s,]|$)`).test(imported[1])) continue;
      const moduleSource = readFileSync(
        fileURLToPath(new URL(imported[2].replace(/\.js$/, ".ts"), heartbeatUrl)),
        "utf8",
      );
      const exported = moduleSource.match(
        new RegExp(`(?:^|\\n)\\s*export\\s+const\\s+${name}\\s*(?::[^=]+)?=\\s*"([^"]+)"`),
      );
      if (exported) return exported[1];
    }
    return null;
  }

  // `reason:` appears TWICE in most of these insert blocks -- once at the top level
  // (the `agent_wakeup_requests.reason` COLUMN) and once nested inside
  // `payload.heartbeatSkip`, which `projectWakeDiagnosticReason` never reads. Reading
  // the nested one is precisely the mistake that put bare `worktree_execution_cutoff`
  // in the allowlist, so a regex that cannot tell them apart would re-seed this
  // change's own defect into the test meant to catch it. Hence brace-depth tracking:
  // take `reason:` only at depth 1 of the `.values({ ... })` object.
  function columnReasonLiteralsFromDirectInserts() {
    const sites: { line: number; reasons: string[] }[] = [];
    const unresolvedConsts: string[] = [];
    const openers = /insert\(agentWakeupRequests\)\s*\n?\s*\.?\s*values\(\{/g;
    let opener: RegExpExecArray | null;
    while ((opener = openers.exec(heartbeatSource))) {
      const open = opener.index + opener[0].length - 1;
      let depth = 1;
      let end = open + 1;
      while (end < heartbeatSource.length && depth > 0) {
        const ch = heartbeatSource[end];
        if (ch === "{") depth++;
        else if (ch === "}") depth--;
        end++;
      }
      const block = heartbeatSource.slice(open, end);

      let blockDepth = 0;
      for (let i = 0; i < block.length; i++) {
        const ch = block[i];
        if (ch === "{") {
          blockDepth++;
          continue;
        }
        if (ch === "}") {
          blockDepth--;
          continue;
        }
        if (blockDepth !== 1 || !block.startsWith("reason:", i)) continue;
        const tail = block.slice(i + "reason:".length, i + 400);
        const literal = tail.match(/^\s*"([^"]+)"/);
        const ternary = tail.match(/^[^,]*?\?\s*\n?\s*"([^"]+)"\s*\n?\s*:\s*\n?\s*"([^"]+)"/);
        const constIdentifier = tail.match(/^\s*([A-Z][A-Z0-9_]*)\s*,/);
        // A lowercase/member-expression `reason:` is skipped: it cannot be resolved
        // statically. That is a known, narrower gap -- see the floor assertions.
        if (literal) sites.push({ line: lineOf(opener.index), reasons: [literal[1]] });
        else if (ternary)
          sites.push({ line: lineOf(opener.index), reasons: [ternary[1], ternary[2]] });
        else if (constIdentifier) {
          const resolved = resolveConstLiteral(constIdentifier[1]);
          // Fail loudly rather than widening the skip: a `SCREAMING_SNAKE` const the
          // resolver cannot follow means the resolver broke, not that the site is
          // dynamic. Silently skipping it is the exact failure this revision fixes.
          if (resolved) sites.push({ line: lineOf(opener.index), reasons: [resolved] });
          else unresolvedConsts.push(`${constIdentifier[1]} (heartbeat.ts:${lineOf(opener.index)})`);
        }
        break;
      }
    }
    return { sites, unresolvedConsts };
  }

  function lineOf(index: number) {
    return heartbeatSource.slice(0, index).split("\n").length;
  }

  // The first revision of the allowlist carried bare `worktree_execution_cutoff`,
  // which matches no row: every write of that suppression to the `reason` COLUMN uses
  // the dotted `heartbeat.worktree_execution_cutoff`, and the bare string exists only
  // as nested `payload.heartbeatSkip.reason`, which `projectWakeDiagnosticReason`
  // never reads. The entry was inert while looking admitted -- leaving exactly the
  // defect this route change exists to fix, in the route that exists to explain it.
  //
  // So derive the expected literals from the writer rather than restating them: a
  // rename or a spelling drift on either side fails here instead of quietly
  // projecting a real suppression to "other".
  it("admits every reason `writeSkippedHeartbeatRequest` writes to the reason column", () => {
    const written = [
      ...heartbeatSource.matchAll(/writeSkippedHeartbeatRequest\(\s*"([^"]+)"/g),
    ].map((match) => match[1]);

    // Guard against the scan itself going vacuous: if the helper is renamed, this
    // fails loudly rather than passing over an empty set.
    expect(written.length, "no writeSkippedHeartbeatRequest call sites found").toBeGreaterThan(0);

    for (const reason of written) {
      expect(
        ISSUE_WAKE_DIAGNOSTIC_KNOWN_REASONS.has(reason),
        `${reason} is written to agent_wakeup_requests.reason on an issue-scoped skip path but projects to "other"`,
      ).toBe(true);
    }
  });

  // The scan above covers the `writeSkippedHeartbeatRequest` family only -- three call
  // sites. Most reasons reach the column through a direct `insert(agentWakeupRequests)`
  // instead, including the coalesce ternary that writes
  // `github_state_change_queued_coalesced` / `issue_execution_same_name`, so a rename
  // at any of those would still have reached "other" undetected.
  it("admits every statically resolvable reason a direct `insert(agentWakeupRequests)` writes to the column", () => {
    const { sites, unresolvedConsts } = columnReasonLiteralsFromDirectInserts();

    // A `SCREAMING_SNAKE` const the resolver cannot follow is a broken resolver, not a
    // dynamic site. Assert it before the floor: a resolver that silently returns null
    // would otherwise just shrink the site count and read as a drifted floor.
    expect(unresolvedConsts, "const-identifier reasons the resolver could not follow").toEqual([]);

    // Vacuity floors. `toBeGreaterThan(0)` would not catch the failure mode that
    // matters here -- a depth walk desynced by an unbalanced brace inside a string
    // still yields *some* sites while silently dropping others. So pin a count floor
    // and name the specific pair this test was added for.
    expect(sites.length, "direct-insert reason scan found too few sites").toBeGreaterThanOrEqual(
      17,
    );
    const found = new Set(sites.flatMap((site) => site.reasons));
    for (const anchor of [
      "github_state_change_queued_coalesced",
      "issue_execution_same_name",
      "issue_execution_deferred",
      "heartbeat.worktree_execution_cutoff",
      // The two const-identifier sites. Anchored by their RESOLVED values, so this
      // fails if the resolver regresses to skipping them -- which is how
      // `workspace_worktree_requires_project` survived the previous revision.
      "workspace_worktree_requires_project",
      "execution_review_participant_recovery",
    ]) {
      expect(found.has(anchor), `direct-insert scan lost its anchor ${anchor}`).toBe(true);
    }
    // The nested `payload.heartbeatSkip.reason` sibling of the anchor above. Its
    // presence here would mean the depth walk is reading payloads as columns.
    expect(
      found.has("worktree_execution_cutoff"),
      "scan read a nested payload.heartbeatSkip.reason as a column write",
    ).toBe(false);

    for (const site of sites) {
      for (const reason of site.reasons) {
        if (AGENT_SCOPED_UNREACHABLE.includes(reason)) continue;
        expect(
          ISSUE_WAKE_DIAGNOSTIC_KNOWN_REASONS.has(reason),
          `${reason} (heartbeat.ts:${site.line}) is written to agent_wakeup_requests.reason but projects to "other"`,
        ).toBe(true);
      }
    }
  });

  // The converse, and the reason these two were dropped rather than corrected: both
  // are written only by the timer scheduler, onto agent-scoped rows whose payload
  // carries no `issueId`, `taskId` or `_paperclipWakeContext`. `wakeRequestTargetsIssue`
  // cannot return them, so admitting them would assert a reachability this route does
  // not have. If either writer ever gains issue scope, re-add it with a route test.
  it("does not admit timer-scheduler skips this route cannot return", () => {
    for (const reason of AGENT_SCOPED_UNREACHABLE) {
      expect(
        ISSUE_WAKE_DIAGNOSTIC_KNOWN_REASONS.has(reason),
        `${reason} is agent-scoped and unreachable on this route`,
      ).toBe(false);
    }
  });
});
