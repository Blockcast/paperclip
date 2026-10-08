import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
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
import {
  locklessDeferredWakeDisposition,
  locklessDeferredWakeTerminalError,
  LOCKLESS_DEFERRED_WAKE_DEPENDENCY_BLOCKED_ERROR,
  LOCKLESS_DEFERRED_WAKE_PROMOTED_ERROR,
} from "../services/deferred-wake-reopen.js";

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

  it(
    "attributes each lockless-drain verb distinctly, and distinguishes all three from a finalizer promotion",
    async () => {
      const company = await seedCompany(db);
      const agent = await seedAgent(db, company.id);
      const project = await seedProject(db, company.id, "Core");
      const issue = await seedIssue(db, {
        companyId: company.id,
        projectId: project.id,
        title: "Drained issue",
        status: "todo",
        assigneeAgentId: agent.id,
      });
      const [actorRun] = await db.insert(heartbeatRuns).values({
        companyId: company.id,
        agentId: agent.id,
        status: "running",
        contextSnapshot: { issueId: issue.id },
      }).returning();

      // Exactly what `drainLocklessDeferredIssueWakes` leaves behind on each of
      // its three ACTING verbs: the row it selected goes `cancelled` carrying
      // the verb's literal. The promote arm ALSO enqueues a fresh row, which is
      // what makes it structurally distinct from the finalizer below.
      const base = {
        companyId: company.id,
        agentId: agent.id,
        source: "automation",
        status: "cancelled",
        payload: { issueId: issue.id },
      };
      await db.insert(agentWakeupRequests).values([
        {
          ...base,
          reason: "issue_execution_deferred",
          error: LOCKLESS_DEFERRED_WAKE_PROMOTED_ERROR,
          requestedAt: new Date(Date.now() - 40_000),
          finishedAt: new Date(Date.now() - 39_000),
        },
        {
          ...base,
          reason: "issue_execution_deferred",
          error: LOCKLESS_DEFERRED_WAKE_DEPENDENCY_BLOCKED_ERROR,
          requestedAt: new Date(Date.now() - 30_000),
          finishedAt: new Date(Date.now() - 29_000),
        },
        {
          ...base,
          reason: "issue_execution_deferred",
          error: locklessDeferredWakeTerminalError("done"),
          requestedAt: new Date(Date.now() - 20_000),
          finishedAt: new Date(Date.now() - 19_000),
        },
        // The finalizer, `releaseIssueExecutionAndPromote`: promotes the SAME
        // row IN PLACE to `queued` with `error: null`. It writes the identical
        // `reason`, deliberately — which is precisely why `reason` cannot
        // attribute a promotion and `disposition` must.
        {
          ...base,
          status: "queued",
          reason: "issue_execution_promoted",
          error: null,
          requestedAt: new Date(Date.now() - 10_000),
        },
      ]);

      // At the privilege level an agent seat actually has — NOT board. The
      // `includeInternalIds` gate gives a board user `agentId`/`runId` and
      // nothing else, so attribution has to survive without it.
      const res = await request(createApp(db, agentActor(company, agent, actorRun!.id)))
        .get(`/api/issues/${issue.id}/diagnostics/wakes`);

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const wakes = res.body.events.filter((event: { kind: string }) => event.kind === "wake_request");
      expect(wakes).toHaveLength(4);
      // Newest-first, so the finalizer row leads.
      expect(wakes.map((event: { disposition: string | null }) => event.disposition)).toEqual([
        null,
        "lockless_drain_cancelled_terminal",
        "lockless_drain_cancelled_dependency_blocked",
        "lockless_drain_promoted",
      ]);
      // All three drain verbs are distinguishable from each other.
      expect(new Set(wakes.slice(1).map((event: { disposition: string }) => event.disposition)).size)
        .toBe(3);

      // PEN-3877's second defect: the promoted row is the drain SUCCEEDING, and
      // it reported `failed` because the drain stamps its string precisely then.
      const promoted = wakes[3];
      expect(promoted.disposition).toBe("lockless_drain_promoted");
      expect(promoted.failureClass).not.toBe("failed");
      expect(promoted.failureClass).toBe("cancelled");

      // The raw column stays off the wire — it is not uniformly server-authored.
      const serialized = JSON.stringify(res.body);
      expect(serialized).not.toContain("\"error\"");
      expect(serialized).not.toContain("lockless drain");
      expect(serialized).not.toContain("PEN-3739");

      // ...and again with `includeInternalIds` CLOSED. An ordinary agent seat in
      // its own company reads internal ids, so the request above does not
      // exercise the gate at all; a boundary-scoped seat does. `disposition` is
      // deliberately outside that gate — it is a closed set of server-authored
      // literals about an action taken on this issue's own wake, not an internal
      // identifier — and asserting it here is what stops a later revision
      // "tidying" it inside the gate and taking the evidence dark for exactly
      // the caller least able to get it elsewhere.
      await db.update(agents).set({
        permissions: {
          trustPreset: LOW_TRUST_REVIEW_PRESET,
          authorizationPolicy: {
            trustBoundary: {
              mode: LOW_TRUST_REVIEW_PRESET,
              companyId: company.id,
              projectIds: [project.id],
              rootIssueId: issue.id,
              issueIds: [issue.id],
              allowedAgentIds: [],
            },
          },
        },
      }).where(eq(agents.id, agent.id));

      const scoped = await request(createApp(db, agentActor(company, agent, actorRun!.id)))
        .get(`/api/issues/${issue.id}/diagnostics/wakes`);

      expect(scoped.status, JSON.stringify(scoped.body)).toBe(200);
      const scopedWakes = scoped.body.events
        .filter((event: { kind: string }) => event.kind === "wake_request");
      // The gate is genuinely closed on this request — otherwise this assertion
      // passes for the same reason the one above did and proves nothing.
      expect(scopedWakes.every((event: { agentId: null; runId: null }) =>
        event.agentId === null && event.runId === null)).toBe(true);
      expect(scopedWakes.map((event: { disposition: string | null }) => event.disposition))
        .toEqual([
          null,
          "lockless_drain_cancelled_terminal",
          "lockless_drain_cancelled_dependency_blocked",
          "lockless_drain_promoted",
        ]);
    },
  );

  it("classifies a cancelled wake carrying an explanatory string as cancelled, not failed", async () => {
    const company = await seedCompany(db);
    const agent = await seedAgent(db, company.id);
    const project = await seedProject(db, company.id, "Core");
    const issue = await seedIssue(db, {
      companyId: company.id,
      projectId: project.id,
      title: "Explained cancellation",
      status: "todo",
      assigneeAgentId: agent.id,
    });

    // Predates the drain and is unrelated to it: this shape was already
    // mis-reporting, because `rawError` truthiness outranked the status the
    // column states outright. Keeps the fix honest as a general correction
    // rather than a special case carved out for the drain.
    await db.insert(agentWakeupRequests).values({
      companyId: company.id,
      agentId: agent.id,
      source: "automation",
      reason: "issue_dependencies_blocked",
      status: "cancelled",
      payload: { issueId: issue.id },
      error: "Cancelled because the dependency-blocked park exceeded its maximum age",
      requestedAt: new Date(Date.now() - 5_000),
      finishedAt: new Date(Date.now() - 4_000),
    });

    const res = await request(createApp(db, boardActor(company)))
      .get(`/api/issues/${issue.id}/diagnostics/wakes`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.events[0]).toMatchObject({
      kind: "wake_request",
      status: "cancelled",
      failureClass: "cancelled",
      // Not the drain — a string the drain never writes must not be attributed
      // to it, or the discriminator is worthless.
      disposition: null,
    });
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

// In the reason-allowlist scan below, `reason:` is not always an inline literal.
// Two writers pass a `SCREAMING_SNAKE` const instead -- one declared in
// `heartbeat.ts`, one imported -- and the first revision of this scan skipped
// both as "cannot be resolved statically". It can:
// that shape is a module-level binding to a string literal, and skipping it is what
// let `workspace_worktree_requires_project` reach "other" through the very suite
// added to stop that. A lowercase identifier (`wakeReason`, `skipReason`,
// `dailyCapBlock.reason`, `opts.reason`) is the genuinely unresolvable shape and
// stays the documented, narrower gap.
//
// Lazy on purpose: only a name the scan actually meets is resolved, so this reads
// two files rather than all 43 of `heartbeat.ts`'s relative imports. Module scope
// because the PEN-3877 drain scan uses it too, to bind each `cancelWake` site in
// `recovery/service.ts` to the constant it passes.
function resolveConstLiteral(name: string, source: string, sourceUrl: URL): string | null {
  const local = source.match(
    new RegExp(`(?:^|\\n)\\s*(?:export\\s+)?const\\s+${name}\\s*(?::[^=]+)?=\\s*"([^"]+)"`),
  );
  if (local) return local[1];

  for (const imported of source.matchAll(
    /import\s*\{([^}]*)\}\s*from\s*"(\.\.?\/[^"]+)"/g,
  )) {
    if (!new RegExp(`(^|[\\s,])${name}([\\s,]|$)`).test(imported[1])) continue;
    let moduleSource: string;
    try {
      moduleSource = readFileSync(
        fileURLToPath(new URL(imported[2].replace(/\.js$/, ".ts"), sourceUrl)),
        "utf8",
      );
    } catch {
      // A barrel or extensionless specifier this narrow resolver cannot follow
      // (PEN-3855: the reason-allowlist scan now resolves against every writer
      // module, not only `heartbeat.ts`). Skip the candidate rather than throwing:
      // both callers fail loudly on a `null` -- the drain scan's `not.toBeNull()`
      // and the allowlist scan's `unresolvedConsts` -- with the name attached.
      continue;
    }
    const exported = moduleSource.match(
      new RegExp(`(?:^|\\n)\\s*export\\s+const\\s+${name}\\s*(?::[^=]+)?=\\s*"([^"]+)"`),
    );
    if (exported) return exported[1];
  }
  return null;
}

// PEN-3877, same discipline and the same reason as the reason-allowlist scans
// below: outside `describeEmbeddedPostgres`, because this is a static assertion
// against the writer and must not go silently green where embedded Postgres is
// unavailable.
//
// `disposition` is the ONLY durable, attributable evidence the lockless drain
// emits — its `logger.warn` goes to pod stdout with no central log store, and
// `reason` is written deliberately identically to the finalizer's. So a verb
// that gained a fourth literal, or reworded an existing one, would take that
// evidence dark while the route kept answering `200` with `disposition: null`.
// The constants are shared rather than restated, so a reword cannot desync; this
// scan is what catches a NEW string the classifier has never been taught.
describe("lockless deferred-wake drain evidence is readable from its writer", () => {
  const recoveryUrl = new URL("../services/recovery/service.ts", import.meta.url);
  const recoverySource = readFileSync(fileURLToPath(recoveryUrl), "utf8");

  it("classifies every string the drain stamps on an acting verb", () => {
    // `cancelWake` is the drain's single write path to `agent_wakeup_requests.error`
    // (it sets `status`/`finishedAt`/`error`), so every acting verb goes through it.
    // Matched on the callee, not the receiver expression, so a verb added outside
    // the candidate loop still counts. The definition (`const cancelWake = async (`)
    // does not match `cancelWake(`. The optional trailing group captures the list
    // the site records its wake into on success (`if (await cancelWake(...)) {
    // <list>.push(`), which is what binds a site to its meaning below.
    const openers = recoverySource.match(/\bcancelWake\(/g) ?? [];
    const calls = [
      ...recoverySource.matchAll(
        /\bcancelWake\(\s*[^,()]+,\s*((?:[^()\n]|\([^()\n]*\))+?)\s*,?\s*\)(?:\s*\)\s*\{\s*(\w+)\.push\()?/g,
      ),
    ];
    expect(calls.length, "a `cancelWake(` site whose argument the scan cannot read").toBe(openers.length);
    expect(calls.length, "the drain's three acting-verb `cancelWake(...)` sites").toBe(3);

    const sites = calls.map(([, rawArg, recordedInto]) => {
      const arg = rawArg!.trim();
      // A bare string literal would mean the writer stopped sharing the constant,
      // which is the desync this module exists to prevent. Fail loudly on it
      // rather than silently classifying `null`.
      expect(arg.startsWith("\"") || arg.startsWith("`") || arg.startsWith("'"), `inline literal at a drain cancelWake site: ${arg}`).toBe(false);
      // Bind the site to the string it writes: a shared const resolves through the
      // writer's own import; the terminal builder is the one call shape the drain uses.
      const stamped = /^[A-Z][A-Z0-9_]*$/.test(arg)
        ? resolveConstLiteral(arg, recoverySource, recoveryUrl)
        : arg.startsWith("locklessDeferredWakeTerminalError(")
          ? locklessDeferredWakeTerminalError("done")
          : null;
      expect(stamped, `unresolvable drain cancelWake argument: ${arg}`).not.toBeNull();
      return { arg, disposition: locklessDeferredWakeDisposition(stamped), recordedInto };
    });
    const siteDispositions = sites.map((site) => site.disposition);
    // Three sites, three distinct verbs.
    expect(siteDispositions).not.toContain(null);
    expect(new Set(siteDispositions).size).toBe(3);
    // Distinctness binds each site to A constant, not to the RIGHT one: swap the
    // dependency-blocked and promote sites' constants and all three still resolve,
    // distinctly, while the route answers `200` labelling a dependency-blocked
    // cancellation `lockless_drain_promoted` — and the route-level test seeds the
    // literals directly, so it cannot see that either. The writer's own bookkeeping
    // is the independent signal: only the promote arm records into
    // `promotedWakeIds`, both cancel arms into `cancelledWakeIds`. The terminal arm
    // is pinned by its call shape above, so dependency-blocked is bound as the
    // remainder. Checked per site rather than as an ordered list, so a legitimate
    // reordering of the arms stays green.
    for (const site of sites) {
      expect(site.recordedInto, `drain cancelWake(${site.arg}) records its wake into the wrong (or no) list`).toBe(
        site.disposition === "lockless_drain_promoted" ? "promotedWakeIds" : "cancelledWakeIds",
      );
    }

    // Every literal the drain can write must classify to a non-null disposition.
    const written = [
      LOCKLESS_DEFERRED_WAKE_PROMOTED_ERROR,
      LOCKLESS_DEFERRED_WAKE_DEPENDENCY_BLOCKED_ERROR,
      locklessDeferredWakeTerminalError("done"),
      locklessDeferredWakeTerminalError("cancelled"),
    ];
    for (const value of written) {
      expect(locklessDeferredWakeDisposition(value), `unclassified drain string: ${value}`)
        .not.toBeNull();
    }
    // Distinct verbs stay distinct — a classifier collapsing them would satisfy
    // the loop above and still fail the attribution this exists for.
    expect(new Set(written.map(locklessDeferredWakeDisposition)).size).toBe(3);
  });

  it("attributes nothing it did not write", () => {
    // The finalizer nulls `error` on the row it promotes in place; an exception
    // message from `github-webhook.ts` is the reason the raw column is not
    // exposed at all. Neither may be read as drain evidence.
    expect(locklessDeferredWakeDisposition(null)).toBeNull();
    expect(locklessDeferredWakeDisposition("")).toBeNull();
    expect(locklessDeferredWakeDisposition("Cancelled due to budget pause")).toBeNull();
    // The real near-misses: every sibling writer sharing the `Deferred wake ` prefix
    // as of this writing (`recovery/service.ts`, `heartbeat.ts`). The self-authored
    // one interpolates the issue status much as the terminal arm does.
    expect(
      locklessDeferredWakeDisposition("Deferred wake superseded by persisted external-service wait"),
    ).toBeNull();
    expect(
      locklessDeferredWakeDisposition("Deferred wake suppressed by active subtree pause hold"),
    ).toBeNull();
    expect(
      locklessDeferredWakeDisposition("Deferred wake could not be promoted: agent is not invokable"),
    ).toBeNull();
    expect(
      locklessDeferredWakeDisposition(
        "Deferred wake suppressed: self-authored comment waking its own author on an issue already done",
      ),
    ).toBeNull();
  });
});

// PEN-3727 review follow-up. Deliberately OUTSIDE `describeEmbeddedPostgres`: these
// assert a static registry against its writer, need no database, and must not go
// silently green on a host where embedded Postgres is unavailable.
describe("issue wake diagnostic reason allowlist", () => {
  // PEN-3855: this scan used to read `heartbeat.ts` and nothing else, which made
  // its own title ("account for every wake writer") true by measurement rather
  // than by construction -- and the measurement was already wrong. A writer in
  // `services/recovery/service.ts` was writing `provider_quota_recovery` onto an
  // issue-scoped row that this route selects and projected to "other", one file
  // outside the scan's whole domain.
  //
  // So discover the writers from the repo instead of naming one file. Everything
  // below is keyed off `WRITER_FILES`, so a writer landing in a new module joins
  // the scan by existing rather than by someone remembering to add it.
  const SERVER_SRC = new URL("../", import.meta.url);

  // Exclusion is by `.test.ts` SUFFIX, not by `__tests__/` directory, and that is
  // load-bearing in both directions. `services/wake-idempotency.test.ts` is a
  // co-located test holding a real `insert(agentWakeupRequests)`, so a
  // directory-only rule would scan it and derive expectations from fixture data.
  // The directory is excluded as well because a non-`.test.ts` helper under
  // `__tests__/` would otherwise slip through the suffix rule for the same reason.
  function isProductionSource(path: string) {
    if (!path.endsWith(".ts")) return false;
    if (path.endsWith(".test.ts") || path.endsWith(".d.ts")) return false;
    return !path.includes("/__tests__/");
  }

  function collectWriterFiles(dir: URL): { path: string; source: string; url: URL }[] {
    const found: { path: string; source: string; url: URL }[] = [];
    for (const entry of readdirSync(fileURLToPath(dir), { withFileTypes: true })) {
      const child = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") continue;
        found.push(...collectWriterFiles(child));
        continue;
      }
      const path = fileURLToPath(child);
      if (!isProductionSource(path)) continue;
      const source = readFileSync(path, "utf8");
      if (!source.includes("insert(agentWakeupRequests)")) continue;
      found.push({ path: path.slice(path.indexOf("server/src/")), source, url: child });
    }
    return found;
  }

  const WRITER_FILES = collectWriterFiles(SERVER_SRC).sort((a, b) => a.path.localeCompare(b.path));
  const heartbeatFile = WRITER_FILES.find((file) => file.path.endsWith("services/heartbeat.ts"));
  const heartbeatSource = heartbeatFile?.source ?? "";

  // The glob is the whole control here, so prove it is live before anything reads
  // it. A walker that silently returns [] would make every assertion below vacuous
  // -- and vacuous is exactly the failure mode this change exists to remove.
  it("discovers every production wake writer in the repo, not one hand-named file", () => {
    expect(WRITER_FILES.length, "writer-file walk found nothing").toBeGreaterThan(0);
    const paths = WRITER_FILES.map((file) => file.path);

    // Anchored on the two files that carry the point: `heartbeat.ts` is the scan's
    // historical domain, `recovery/service.ts` is the file whose writer reached
    // "other" while invisible to it. Losing either silently is the regression.
    expect(paths, `writer files: ${paths.join(", ")}`).toContain("server/src/services/heartbeat.ts");
    expect(paths, `writer files: ${paths.join(", ")}`).toContain(
      "server/src/services/recovery/service.ts",
    );
    // ...and the scan must reach beyond the one file it used to read.
    expect(paths.filter((path) => !path.endsWith("services/heartbeat.ts")).length).toBeGreaterThan(0);

    // No test fixture may enter the scan: those build wake rows from invented
    // reasons, so admitting them would derive the allowlist from the tests that
    // check it. `wake-idempotency.test.ts` is the co-located case the suffix rule
    // exists for, so name it rather than only asserting the general shape.
    for (const path of paths) {
      expect(path.endsWith(".test.ts"), `${path} is a test fixture and must not be scanned`).toBe(
        false,
      );
    }
    expect(paths).not.toContain("server/src/services/wake-idempotency.test.ts");
  });

  // The timer-scheduler skips this route cannot return. Hoisted so the positive scan
  // below and the negative test at the bottom carve out the SAME names: if one list
  // grows and the other does not, the pair contradicts rather than drifts.
  //
  // PEN-3765: this used to name two families and silently omit a third.
  // `writeTimerCircuitBreakerSkip` (`heartbeat.ts`) is excluded for the identical
  // reason as the other two -- it writes `payload: { heartbeatSkip: { reason,
  // ...evidence } }` onto an agent-scoped row with no `issueId`, `taskId` or
  // `_paperclipWakeContext`. Its `reason` is a parameter typed as a two-member string
  // union, so the scan below can never resolve it to a literal and the positive scan
  // would not have caught its admission either. Naming both members here makes the
  // negative test cover all three families, so this is one list rather than two plus
  // an omission.
  //
  // PEN-3855: carries a `why` per entry now that the scan spans several files and
  // the exclusions no longer share one justification. The list stays single-sourced:
  // the positive scan's carve-out and the negative test below both read it, so an
  // entry added for one and not the other contradicts rather than drifts.
  const UNREACHABLE_BY_CONSTRUCTION: { reason: string; why: string }[] = [
    { reason: "provider_capacity_deferred", why: "agent-scoped timer skip, payload has no issue binding" },
    { reason: "no_in_flight_work", why: "agent-scoped timer skip, payload has no issue binding" },
    { reason: "idle_circuit_breaker", why: "agent-scoped timer skip, payload has no issue binding" },
    {
      reason: "adapter_failed_circuit_breaker",
      why: "agent-scoped timer skip, payload has no issue binding",
    },
    // PEN-3855. Doubly unreachable, which is why it stays out even though it sits
    // in the same file as the reason this change admits: the insert carries no
    // `payload` at all, AND the row is deleted unconditionally in a `finally`
    // (`recovery/service.ts`). It is an ephemeral capacity token, not a durable
    // wake record -- adding a payload alone would not make it a diagnostic row.
    {
      reason: "issue_assignment_recovery_capacity_reservation",
      why: "ephemeral capacity token: no payload, and deleted in a finally",
    },
  ];
  const UNREACHABLE_REASONS = UNREACHABLE_BY_CONSTRUCTION.map((entry) => entry.reason);

  // `reason:` appears TWICE in most of these insert blocks -- once at the top level
  // (the `agent_wakeup_requests.reason` COLUMN) and once nested inside
  // `payload.heartbeatSkip`, which `projectWakeDiagnosticReason` never reads. Reading
  // the nested one is precisely the mistake that put bare `worktree_execution_cutoff`
  // in the allowlist, so a regex that cannot tell them apart would re-seed this
  // change's own defect into the test meant to catch it. Hence brace-depth tracking:
  // take `reason:` only at depth 1 of the `.values({ ... })` object.
  //
  // PEN-3765: every opener lands in exactly ONE of four buckets, and the caller
  // asserts the partition is TOTAL. Before that, a block the walk could not read
  // simply produced nothing, which made "this writer passes a runtime variable"
  // byte-identical to "this writer has no reason column" -- and to "the depth walk
  // desynced and lost the site". `unaccounted` is what tells those apart.
  function columnReasonLiteralsFromDirectInserts(file: { path: string; source: string; url: URL }) {
    const source = file.source;
    const lineOf = (index: number) => source.slice(0, index).split("\n").length;
    const at = (index: number) => `${file.path}:${lineOf(index)}`;
    const sites: { site: string; reasons: string[] }[] = [];
    const unresolvedConsts: string[] = [];
    // Depth-1 `reason` column present, value not statically resolvable. Named, not
    // dropped, so a site cannot hide here.
    const dynamic: { site: string; expr: string }[] = [];
    // No depth-1 `reason` key found at all. Must stay empty — but NOT because the
    // column is NOT NULL. It is nullable: `reason: text("reason")` carries no
    // `.notNull()` (`packages/db/src/schema/agent_wakeup_requests.ts`, where `source`
    // and `status` on the same table do), and `heartbeat.ts` writes
    // `reason: opts.reason ?? null`, which a NOT NULL column would reject. An earlier
    // revision of this comment asserted the constraint and built the invariant on it;
    // that was false, and it was false in a test whose whole job is telling "the scan
    // went blind" apart from "nothing was there".
    //
    // The invariant that actually holds is weaker and empirical: every writer that
    // exists TODAY sets the column at depth 1. So an entry here has two possible
    // causes and the assertion cannot tell them apart — either the scan failed to read
    // the block (desynced depth walk -- opener regex drift never reaches this bucket,
    // see the `openerCount` check in the caller), or a new writer genuinely
    // omits the key and must be classified here deliberately. The failure message
    // names both, so the next engineer checks the writer as well as the scanner.
    const unaccounted: string[] = [];
    let openerCount = 0;
    const openers = /insert\(agentWakeupRequests\)\s*\n?\s*\.?\s*values\(\{/g;
    let opener: RegExpExecArray | null;
    while ((opener = openers.exec(source))) {
      openerCount++;
      const open = opener.index + opener[0].length - 1;
      let depth = 1;
      let end = open + 1;
      while (end < source.length && depth > 0) {
        const ch = source[end];
        if (ch === "{") depth++;
        else if (ch === "}") depth--;
        end++;
      }
      const block = source.slice(open, end);

      let blockDepth = 0;
      let classified = false;
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
        if (blockDepth !== 1) continue;
        if (!block.startsWith("reason", i)) continue;
        // PEN-3765: `reason` reaches the column in TWO syntactic shapes, and matching
        // only the first is why four writers -- including the `status: "coalesced"`
        // one -- were invisible here. `reason:` is the explicit-value form; `reason,`
        // is ES6 property shorthand forwarding a binding of the same name. The
        // explicit form is tried first, which is what makes a future
        // `reason: "some_literal"` at one of those four sites resolve normally.
        //
        // Both forms must be in KEY position. Walking back over whitespace to a `{`
        // or `,` rejects the common shape of a *string value* that happens to contain
        // "reason," (`triggerDetail: "some reason, here"` -- the back-walk lands on a
        // letter) before it can pre-empt the real key further down the block. A false
        // positive there would classify a resolvable site as dynamic, which is the
        // same silence this change removes.
        //
        // ⚠️ It is a heuristic, not a guarantee, and an earlier revision of this
        // comment claimed the stronger thing. A string containing `", reason,"` puts a
        // real comma immediately before the match, so the back-walk accepts it and the
        // shorthand branch fires on a string body. No such literal exists in
        // `heartbeat.ts` today -- that is a measurement, not a property, and the
        // honest fix if one ever lands is to skip string spans rather than to widen
        // this walk.
        let back = i - 1;
        while (back >= 0 && /\s/.test(block[back]!)) back--;
        if (back >= 0 && block[back] !== "{" && block[back] !== ",") continue;
        // The window is wide enough to clear the deepest indentation in this file, so
        // a shorthand written as the LAST property (no trailing comma, newline, then
        // `}`) still matches -- a tight window there would silently reopen the gap.
        const shorthand = /^reason\s*[,}]/.test(block.slice(i, i + 64));
        if (!block.startsWith("reason:", i) && !shorthand) continue;
        if (shorthand) {
          // A binding forwarded by shorthand is a runtime value by construction.
          dynamic.push({ site: at(opener.index), expr: "reason (ES6 shorthand)" });
          classified = true;
          break;
        }
        const tail = block.slice(i + "reason:".length, i + 400);
        const literal = tail.match(/^\s*"([^"]+)"/);
        const ternary = tail.match(/^[^,]*?\?\s*\n?\s*"([^"]+)"\s*\n?\s*:\s*\n?\s*"([^"]+)"/);
        const constIdentifier = tail.match(/^\s*([A-Z][A-Z0-9_]*)\s*,/);
        classified = true;
        if (literal) sites.push({ site: at(opener.index), reasons: [literal[1]] });
        else if (ternary)
          sites.push({ site: at(opener.index), reasons: [ternary[1], ternary[2]] });
        else if (constIdentifier) {
          const resolved = resolveConstLiteral(constIdentifier[1], source, file.url);
          // Fail loudly rather than widening the skip: a `SCREAMING_SNAKE` const the
          // resolver cannot follow means the resolver broke, not that the site is
          // dynamic. Silently skipping it is the exact failure this revision fixes.
          if (resolved) sites.push({ site: at(opener.index), reasons: [resolved] });
          else unresolvedConsts.push(`${constIdentifier[1]} (${at(opener.index)})`);
        } else {
          // A lowercase/member-expression `reason:` cannot be resolved statically.
          // Named rather than dropped, so it is distinguishable from a block that
          // carries no `reason` column at all -- see `unaccounted` below.
          dynamic.push({
            site: at(opener.index),
            expr: (tail.match(/^\s*([^,\n]{0,60})/)?.[1] ?? "").trim(),
          });
        }
        break;
      }
      if (!classified) unaccounted.push(at(opener.index));
    }
    const rawOpeners = (source.match(/insert\(agentWakeupRequests\)/g) ?? []).length;
    return { sites, unresolvedConsts, dynamic, unaccounted, openerCount, rawOpeners };
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
  //
  // PEN-3855: runs over every discovered writer file, not `heartbeat.ts` alone.
  it("admits every statically resolvable reason a direct `insert(agentWakeupRequests)` writes to the column", () => {
    const scans = WRITER_FILES.map((file) => columnReasonLiteralsFromDirectInserts(file));
    const sites = scans.flatMap((scan) => scan.sites);
    const unresolvedConsts = scans.flatMap((scan) => scan.unresolvedConsts);
    const dynamic = scans.flatMap((scan) => scan.dynamic);
    const unaccounted = scans.flatMap((scan) => scan.unaccounted);
    const openerCount = scans.reduce((total, scan) => total + scan.openerCount, 0);
    const rawOpeners = scans.reduce((total, scan) => total + scan.rawOpeners, 0);

    // A `SCREAMING_SNAKE` const the resolver cannot follow is a broken resolver, not a
    // dynamic site. Assert it before the floor: a resolver that silently returns null
    // would otherwise just shrink the site count and read as a drifted floor.
    expect(unresolvedConsts, "const-identifier reasons the resolver could not follow").toEqual([]);

    // PEN-3765: the partition must be TOTAL -- this, together with the `openerCount`
    // check below, is the anti-vacuity control that replaces a hardcoded count floor.
    // A depth walk desynced by an unbalanced brace, or a reason spelling the classifier
    // cannot read, lands here instead of silently shrinking the resolved set. The
    // partition covers unreadable BLOCKS, not unmatched OPENERS: a writer the opener
    // regex stops matching never enters the scan loop, so it drops out of
    // `openerCount` and `unaccounted` alike and the identity below still holds.
    //
    // `reason` is nullable (see the `unaccounted` declaration), so a hit here does NOT
    // prove the scan broke — a new writer may legitimately omit the key. Both causes
    // are named in the message because they have opposite remedies: fix the scanner,
    // or classify the new writer here on purpose.
    expect(
      unaccounted,
      "direct-insert openers with no depth-1 `reason` key the scan could read. " +
        "Two causes, opposite fixes: (a) the scan went blind — depth walk desynced by an unbalanced " +
        "brace in a string property (a writer the opener regex stops matching cannot land here; the " +
        "`openerCount` assertion below catches that); or (b) a new " +
        "writer genuinely omits the column, which is schema-valid because `reason` is nullable — " +
        "classify it here deliberately. Check the named writer before assuming the scanner",
    ).toEqual([]);
    expect(
      sites.length + dynamic.length,
      `every opener must classify as resolved or dynamic; resolved=${sites.length} dynamic=${dynamic.length} of ${openerCount}. Dynamic sites: ${
        dynamic.map((site) => `${site.site} (${site.expr})`).join(", ") || "none"
      }`,
    ).toBe(openerCount);
    // ...and the partition must be non-vacuous: zero openers would satisfy the
    // identity above trivially.
    expect(openerCount, "no direct `insert(agentWakeupRequests)` openers found").toBeGreaterThan(0);
    // ...and the denominator must be checked, not trusted. A writer the opener regex
    // misses shrinks both sides of the identity above and leaves it true, so count
    // every raw `insert(agentWakeupRequests)` and require the regex to have matched all.
    expect(
      openerCount,
      "opener regex stopped matching a writer — `.values(<identifier>)`, or a reformatted `values({`",
    ).toBe(rawOpeners);

    const ANCHORS = [
      "github_state_change_queued_coalesced",
      "issue_execution_same_name",
      "issue_execution_deferred",
      "heartbeat.worktree_execution_cutoff",
      // The two const-identifier sites. Anchored by their RESOLVED values, so this
      // fails if the resolver regresses to skipping them -- which is how
      // `workspace_worktree_requires_project` survived the previous revision.
      "workspace_worktree_requires_project",
      "execution_review_participant_recovery",
      // PEN-3855: the out-of-file anchor. This one is written by
      // `services/recovery/service.ts`, so it is reachable by this scan ONLY while
      // the walk spans more than `heartbeat.ts`. If the glob ever narrows back to a
      // single hand-named file, this anchor is what goes red -- which is the whole
      // point of keying the scan off the repo rather than off a filename.
      "provider_quota_recovery",
    ];
    // PEN-3765: keyed off the anchors rather than the live site count, which was `17`
    // against an actual 18. At one site of slack, deleting any single writer turned a
    // legitimate refactor into a red test pointing at the SCAN rather than at the
    // removal. The anchors above plus the total-partition assertion now carry the
    // vacuity guarantee, so this floor only has to stay below them.
    expect(sites.length, "direct-insert reason scan found too few sites").toBeGreaterThanOrEqual(
      ANCHORS.length,
    );
    const found = new Set(sites.flatMap((site) => site.reasons));
    for (const anchor of ANCHORS) {
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
        if (UNREACHABLE_REASONS.includes(reason)) continue;
        expect(
          ISSUE_WAKE_DIAGNOSTIC_KNOWN_REASONS.has(reason),
          `${reason} (${site.site}) is written to agent_wakeup_requests.reason but projects to "other"`,
        ).toBe(true);
      }
    }
  });

  // The converse, and the reason these were dropped rather than corrected. Each is
  // unreachable on this route by construction, so admitting it would assert a
  // reachability the route does not have. If any writer ever gains issue scope,
  // re-add it with a route test.
  //
  // PEN-3765: `idle_circuit_breaker` / `adapter_failed_circuit_breaker` are the third
  // such family (`writeTimerCircuitBreakerSkip`). They reach the column through a
  // typed parameter, so the positive scan classifies that writer as dynamic and would
  // never have caught their admission -- this negative test is the only guard on them.
  //
  // PEN-3855: `issue_assignment_recovery_capacity_reservation` is the first entry
  // here from outside `heartbeat.ts`. Unlike the four above, the positive scan DOES
  // resolve it to a literal, so without the carve-out the scan would demand its
  // admission -- making this test the thing that stops a widened glob from
  // over-admitting.
  it("does not admit wake reasons this route cannot return", () => {
    for (const { reason, why } of UNREACHABLE_BY_CONSTRUCTION) {
      expect(
        ISSUE_WAKE_DIAGNOSTIC_KNOWN_REASONS.has(reason),
        `${reason} is unreachable on this route (${why})`,
      ).toBe(false);
    }
  });
});
