import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  approvals,
  companies,
  companySkills,
  createDb,
  documents,
  documentRevisions,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issueExecutionDecisions,
  issueReadStates,
  issues,
  pluginEventOutbox,
  routines,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.js";
import { approvalService } from "../services/approvals.js";
import { companyService } from "../services/companies.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping cleanup removal service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("cleanup removal services", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-cleanup-removal-");
    db = createDb(tempDb.connectionString);
  });

  afterEach(async () => {
    await db.delete(heartbeatRunEvents);
    await db.delete(activityLog);
    // Withdrawal enqueues its plugin event through the caller's transaction, so
    // these fixtures now leave real outbox rows behind. This teardown deletes
    // tables directly rather than going through companyService.remove, which
    // does purge the outbox (companies.ts) -- so it has to purge it too, or the
    // company delete below trips the outbox FK.
    await db.delete(pluginEventOutbox);
    await db.delete(issueReadStates);
    await db.delete(issueComments);
    await db.delete(issueExecutionDecisions);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(companySkills);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(routines);
    await db.delete(approvals);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedFixture() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
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

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Regression fixture",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      createdByUserId: "user-1",
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "completed",
      contextSnapshot: { issueId },
    });

    return { agentId, companyId, issueId, runId };
  }

  it("removes agent-owned issue comments and run-linked activity before deleting the agent", async () => {
    const { agentId, companyId, issueId, runId } = await seedFixture();

    await db.insert(issueComments).values({
      id: randomUUID(),
      companyId,
      issueId,
      authorAgentId: agentId,
      body: "Agent-authored comment",
    });

    await db.insert(activityLog).values({
      id: randomUUID(),
      companyId,
      actorType: "agent",
      actorId: agentId,
      action: "heartbeat.completed",
      entityType: "issue",
      entityId: issueId,
      runId,
      details: {},
    });

    await db.insert(issueExecutionDecisions).values({
      id: randomUUID(),
      companyId,
      issueId,
      stageId: randomUUID(),
      stageType: "review",
      actorAgentId: agentId,
      outcome: "approved",
      body: "Looks good",
      createdByRunId: runId,
    });

    const removed = await agentService(db).remove(agentId);

    expect(removed?.id).toBe(agentId);
    await expect(db.select().from(agents).where(eq(agents.id, agentId))).resolves.toHaveLength(0);
    await expect(db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId))).resolves.toHaveLength(0);
    await expect(db.select().from(issueComments).where(eq(issueComments.issueId, issueId))).resolves.toHaveLength(0);
    await expect(db.select().from(activityLog).where(eq(activityLog.companyId, companyId))).resolves.toHaveLength(0);
  });

  it("clears approval agent bindings before deleting the referenced agent", async () => {
    const { agentId, companyId } = await seedFixture();
    const approvalId = randomUUID();

    await db.insert(approvals).values({
      id: approvalId,
      companyId,
      type: "hire_agent",
      linkedAgentId: agentId,
      requestedByAgentId: agentId,
      requestedByUserId: null,
      status: "approved",
      payload: { agentId, name: "CodexCoder" },
    });

    const removed = await agentService(db).remove(agentId);

    expect(removed?.id).toBe(agentId);
    await expect(db.select().from(agents).where(eq(agents.id, agentId))).resolves.toHaveLength(0);

    const [approval] = await db
      .select({
        linkedAgentId: approvals.linkedAgentId,
        requestedByAgentId: approvals.requestedByAgentId,
      })
      .from(approvals)
      .where(eq(approvals.id, approvalId));
    expect(approval).toEqual({ linkedAgentId: null, requestedByAgentId: null });
  });

  it("leaves an open hire approval withdrawable after its pending agent is deleted", async () => {
    // Nulling `linked_agent_id` alone strands the caller-supplied
    // `payload.agentId`, and the strict binding check then refuses the
    // withdrawal with a 409 that no retry can satisfy -- the approval would be
    // stuck open forever with no agent left to decide it against.
    const { agentId, companyId } = await seedFixture();
    const approvalId = randomUUID();

    await db.insert(approvals).values({
      id: approvalId,
      companyId,
      type: "hire_agent",
      linkedAgentId: agentId,
      requestedByAgentId: null,
      requestedByUserId: null,
      status: "pending",
      payload: { agentId, name: "CodexCoder" },
    });

    await agentService(db).remove(agentId);

    const [neutralised] = await db
      .select({ linkedAgentId: approvals.linkedAgentId, payload: approvals.payload })
      .from(approvals)
      .where(eq(approvals.id, approvalId));
    expect(neutralised.linkedAgentId).toBeNull();
    expect(neutralised.payload).not.toHaveProperty("agentId");
    // The rest of the payload is preserved -- only the dangling id is dropped.
    expect(neutralised.payload).toMatchObject({ name: "CodexCoder" });

    const withdrawn = await approvalService(db).withdraw(approvalId, "hire agent was deleted", {
      userId: "user-1",
      activity: { actorType: "user", actorId: "user-1", agentId: null },
    });
    expect(withdrawn.status).toBe("withdrawn");
  });

  it("does not touch a foreign company's approval that names the removed agent in its payload", async () => {
    // `payload.agentId` is caller-controlled free-form JSON. Without a company
    // predicate on the neutralisation update, company B could plant company A's
    // agent id in its own approval payload and have that row rewritten when A
    // deletes the agent -- a tenant-isolation break, and an existence oracle:
    // B learns when a foreign agent it cannot otherwise observe was deleted.
    const { agentId, companyId } = await seedFixture();
    const foreign = await seedFixture();
    const sameCompanyApprovalId = randomUUID();
    const foreignApprovalId = randomUUID();

    await db.insert(approvals).values({
      id: sameCompanyApprovalId,
      companyId,
      type: "hire_agent",
      linkedAgentId: agentId,
      requestedByAgentId: null,
      requestedByUserId: null,
      status: "pending",
      payload: { agentId, name: "CodexCoder" },
    });

    // Same shape, different tenant, and deliberately NOT linked -- the only
    // thing tying it to the removed agent is the untrusted payload id.
    await db.insert(approvals).values({
      id: foreignApprovalId,
      companyId: foreign.companyId,
      type: "hire_agent",
      linkedAgentId: null,
      requestedByAgentId: null,
      requestedByUserId: null,
      status: "pending",
      payload: { agentId, name: "PlantedByOtherTenant" },
    });

    const [foreignBefore] = await db
      .select()
      .from(approvals)
      .where(eq(approvals.id, foreignApprovalId));

    await agentService(db).remove(agentId);

    const [foreignAfter] = await db
      .select()
      .from(approvals)
      .where(eq(approvals.id, foreignApprovalId));
    // Byte-for-byte: payload keeps the planted id, and no column moved
    // (including `updated_at`, which would itself leak that a write occurred).
    expect(foreignAfter).toEqual(foreignBefore);
    expect(foreignAfter.payload).toMatchObject({ agentId, name: "PlantedByOtherTenant" });

    // ...while the removed agent's own company is still cleaned up and withdrawable.
    const [neutralised] = await db
      .select({ linkedAgentId: approvals.linkedAgentId, payload: approvals.payload })
      .from(approvals)
      .where(eq(approvals.id, sameCompanyApprovalId));
    expect(neutralised.linkedAgentId).toBeNull();
    expect(neutralised.payload).not.toHaveProperty("agentId");

    const withdrawn = await approvalService(db).withdraw(sameCompanyApprovalId, "hire agent was deleted", {
      userId: "user-1",
      activity: { actorType: "user", actorId: "user-1", agentId: null },
    });
    expect(withdrawn.status).toBe("withdrawn");
  });

  it("removes issue read states and activity rows before deleting the company", async () => {
    const { companyId, issueId, runId } = await seedFixture();
    const documentId = randomUUID();
    const revisionId = randomUUID();

    await db.insert(issueReadStates).values({
      id: randomUUID(),
      companyId,
      issueId,
      userId: "user-1",
    });

    await db.insert(companySkills).values({
      id: randomUUID(),
      companyId,
      key: "paperclipai/paperclip/paperclip",
      slug: "paperclip",
      name: "Paperclip",
      markdown: "# Paperclip",
    });

    await db.insert(activityLog).values({
      id: randomUUID(),
      companyId,
      actorType: "system",
      actorId: "system",
      action: "run.created",
      entityType: "run",
      entityId: runId,
      runId,
      details: {},
    });

    await db.insert(documents).values({
      id: documentId,
      companyId,
      title: "Run summary",
      latestBody: "body",
      latestRevisionId: revisionId,
      latestRevisionNumber: 1,
      createdByAgentId: null,
      createdByUserId: "user-1",
      updatedByAgentId: null,
      updatedByUserId: "user-1",
    });

    await db.insert(issueDocuments).values({
      id: randomUUID(),
      companyId,
      issueId,
      documentId,
      key: "summary",
    });

    await db.insert(documentRevisions).values({
      id: revisionId,
      companyId,
      documentId,
      revisionNumber: 1,
      title: "Run summary",
      format: "markdown",
      body: "body",
      createdByAgentId: null,
      createdByUserId: "user-1",
      createdByRunId: runId,
    });

    const removed = await companyService(db).remove(companyId);

    expect(removed?.id).toBe(companyId);
    await expect(db.select().from(companies).where(eq(companies.id, companyId))).resolves.toHaveLength(0);
    await expect(db.select().from(issues).where(eq(issues.id, issueId))).resolves.toHaveLength(0);
    await expect(db.select().from(documents).where(eq(documents.id, documentId))).resolves.toHaveLength(0);
    await expect(db.select().from(documentRevisions).where(eq(documentRevisions.id, revisionId))).resolves.toHaveLength(0);
    await expect(db.select().from(issueReadStates).where(eq(issueReadStates.companyId, companyId))).resolves.toHaveLength(0);
    await expect(db.select().from(activityLog).where(eq(activityLog.companyId, companyId))).resolves.toHaveLength(0);
  });

  it("removes heartbeat events by run id before deleting company-owned runs", async () => {
    const { agentId, companyId, runId } = await seedFixture();
    const otherCompanyId = randomUUID();

    await db.insert(companies).values({
      id: otherCompanyId,
      name: "Other Company",
      issuePrefix: `O${otherCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(heartbeatRunEvents).values({
      companyId: otherCompanyId,
      runId,
      agentId,
      seq: 1,
      eventType: "output",
      message: "event with mismatched company scope",
    });

    const removed = await companyService(db).remove(companyId);

    expect(removed?.id).toBe(companyId);
    await expect(db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId))).resolves.toHaveLength(0);
    await expect(db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, runId))).resolves.toHaveLength(0);
    await expect(db.select().from(companies).where(eq(companies.id, otherCompanyId))).resolves.toHaveLength(1);
  });

  it("removes routines before deleting company agents", async () => {
    const { agentId, companyId } = await seedFixture();
    const routineId = randomUUID();

    await db.insert(routines).values({
      id: routineId,
      companyId,
      title: "Daily cleanup",
      assigneeAgentId: agentId,
    });

    const removed = await companyService(db).remove(companyId);

    expect(removed?.id).toBe(companyId);
    await expect(db.select().from(routines).where(eq(routines.id, routineId))).resolves.toHaveLength(0);
    await expect(db.select().from(agents).where(eq(agents.id, agentId))).resolves.toHaveLength(0);
    await expect(db.select().from(companies).where(eq(companies.id, companyId))).resolves.toHaveLength(0);
  });
});
