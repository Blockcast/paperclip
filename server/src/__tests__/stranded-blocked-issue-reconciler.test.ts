import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  approvals,
  companies,
  createDb,
  executionWorkspaces,
  issueApprovals,
  issueComments,
  issueRecoveryActions,
  issueRelations,
  issueThreadInteractions,
  issues,
  projects,
  projectWorkspaces,
  workspaceOperations,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { reconcileStrandedBlockedIssues } from "../services/stranded-blocked-issue-reconciler.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres stranded-blocked-issue reconciler tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// BLO-21523 phase 1: clearing an issue's last blocker never recomputes
// `status`, so it stays permanently `blocked` with zero unresolved blockers.
// This reconciler drains that population while leaving two other legitimate
// zero-unresolved-blocker `blocked` populations untouched (see the module
// doc comment on stranded-blocked-issue-reconciler.ts for why each exists).
describeEmbeddedPostgres("reconcileStrandedBlockedIssues", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-stranded-blocked-reconciler-");
    db = createDb(tempDb.connectionString);
  }, 120_000);

  afterEach(async () => {
    await db.delete(issueApprovals);
    await db.delete(approvals);
    await db.delete(issueThreadInteractions);
    await db.delete(issueComments);
    await db.delete(activityLog);
    await db.delete(workspaceOperations);
    await db.delete(issueRecoveryActions);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createCompany(prefix = "SBR") {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Company ${prefix}`,
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `${prefix} Agent`,
      role: "engineer",
      status: "idle",
    });
    return { companyId, agentId };
  }

  async function insertIssue(input: {
    companyId: string;
    identifier: string;
    status: string;
    assigneeAgentId?: string | null;
    executionState?: Record<string, unknown> | null;
  }) {
    const id = randomUUID();
    await db.insert(issues).values({
      id,
      companyId: input.companyId,
      identifier: input.identifier,
      title: input.identifier,
      status: input.status,
      priority: "medium",
      assigneeAgentId: input.assigneeAgentId ?? null,
      originKind: "manual",
      originFingerprint: "default",
      executionState: input.executionState ?? null,
    });
    return id;
  }

  async function block(input: { companyId: string; blockerIssueId: string; blockedIssueId: string }) {
    await db.insert(issueRelations).values({
      companyId: input.companyId,
      issueId: input.blockerIssueId,
      relatedIssueId: input.blockedIssueId,
      type: "blocks",
    });
  }

  async function statusOf(issueId: string) {
    const row = await db.select({ status: issues.status }).from(issues).where(eq(issues.id, issueId));
    return row[0]?.status ?? null;
  }

  async function createExecutionWorkspace(companyId: string) {
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const executionWorkspaceId = randomUUID();
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: `Project ${projectId}`,
      status: "in_progress",
    });
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: `Workspace ${projectWorkspaceId}`,
      sourceType: "local_path",
      visibility: "default",
      isPrimary: true,
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      projectWorkspaceId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: `Execution workspace ${executionWorkspaceId}`,
      status: "active",
      providerType: "git_worktree",
    });
    return { projectId, executionWorkspaceId };
  }

  function defer<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  it("drains an issue whose blockedByIssueIds edge was cleared directly (empty edges, no monitor)", async () => {
    const { companyId } = await createCompany("SB1");
    const stranded = await insertIssue({ companyId, identifier: "SB1-1", status: "blocked" });

    const result = await reconcileStrandedBlockedIssues(db);

    expect(result.reconciled).toBe(1);
    expect(await statusOf(stranded)).toBe("todo");
  });

  it("drains an issue whose sole blocker closed done but the edge was never cleared", async () => {
    const { companyId } = await createCompany("SB2");
    const blocker = await insertIssue({ companyId, identifier: "SB2-1", status: "done" });
    const dependent = await insertIssue({ companyId, identifier: "SB2-2", status: "blocked" });
    await block({ companyId, blockerIssueId: blocker, blockedIssueId: dependent });

    const result = await reconcileStrandedBlockedIssues(db);

    expect(result.reconciled).toBe(1);
    expect(await statusOf(dependent)).toBe("todo");
  });

  it("leaves a done-blocker dependent blocked until the blocker's workspace finalizes", async () => {
    const { companyId } = await createCompany("SBF");
    const { projectId, executionWorkspaceId } = await createExecutionWorkspace(companyId);
    const blocker = await insertIssue({
      companyId,
      identifier: "SBF-1",
      status: "done",
      executionState: null,
    });
    await db
      .update(issues)
      .set({ projectId, executionWorkspaceId })
      .where(eq(issues.id, blocker));
    const dependent = await insertIssue({ companyId, identifier: "SBF-2", status: "blocked" });
    await block({ companyId, blockerIssueId: blocker, blockedIssueId: dependent });
    await db.insert(workspaceOperations).values({
      companyId,
      executionWorkspaceId,
      issueId: blocker,
      phase: "worktree_prepare",
      status: "succeeded",
      startedAt: new Date("2026-08-06T10:00:00.000Z"),
    });

    const gated = await reconcileStrandedBlockedIssues(db);

    expect(gated.reconciled).toBe(0);
    expect(await statusOf(dependent)).toBe("blocked");

    await db.insert(workspaceOperations).values({
      companyId,
      executionWorkspaceId,
      issueId: blocker,
      phase: "workspace_finalize",
      status: "succeeded",
      startedAt: new Date("2026-08-06T10:05:00.000Z"),
    });

    const ready = await reconcileStrandedBlockedIssues(db);

    expect(ready.reconciled).toBe(1);
    expect(await statusOf(dependent)).toBe("todo");
  });

  it("leaves a genuinely blocked issue alone: blocker is not done", async () => {
    const { companyId } = await createCompany("SB3");
    const blocker = await insertIssue({ companyId, identifier: "SB3-1", status: "todo" });
    const dependent = await insertIssue({ companyId, identifier: "SB3-2", status: "blocked" });
    await block({ companyId, blockerIssueId: blocker, blockedIssueId: dependent });

    const result = await reconcileStrandedBlockedIssues(db);

    expect(result.reconciled).toBe(0);
    expect(await statusOf(dependent)).toBe("blocked");
  });

  it("leaves a cancelled-blocker dependent blocked (cancelled is not resolved, per existing system semantics)", async () => {
    const { companyId } = await createCompany("SB4");
    const blocker = await insertIssue({ companyId, identifier: "SB4-1", status: "cancelled" });
    const dependent = await insertIssue({ companyId, identifier: "SB4-2", status: "blocked" });
    await block({ companyId, blockerIssueId: blocker, blockedIssueId: dependent });

    const result = await reconcileStrandedBlockedIssues(db);

    expect(result.reconciled).toBe(0);
    expect(await statusOf(dependent)).toBe("blocked");
  });

  it("does not sweep an issue the convergence-stall guard deliberately blocked", async () => {
    const { companyId } = await createCompany("SB5");
    const guarded = await insertIssue({
      companyId,
      identifier: "SB5-1",
      status: "blocked",
      executionState: {
        monitor: {
          status: "cleared",
          clearReason: "convergence_stalled",
          convergenceStallCount: 1,
        },
      },
    });

    const result = await reconcileStrandedBlockedIssues(db);

    expect(result.reconciled).toBe(0);
    expect(await statusOf(guarded)).toBe("blocked");
  });

  it("does not sweep an issue blocked directly on a live monitor gate (no blockedBy edge ever existed)", async () => {
    const { companyId } = await createCompany("SB6");
    const gated = await insertIssue({
      companyId,
      identifier: "SB6-1",
      status: "blocked",
      executionState: {
        monitor: {
          status: "triggered",
          gateSignals: ["pr:example/repo#1:review"],
        },
      },
    });

    const result = await reconcileStrandedBlockedIssues(db);

    expect(result.reconciled).toBe(0);
    expect(await statusOf(gated)).toBe("blocked");
  });

  it("does not sweep an issue with an active stranded-run recovery action pointing at itself", async () => {
    const { companyId, agentId } = await createCompany("SB7");
    const stranded = await insertIssue({ companyId, identifier: "SB7-1", status: "blocked" });
    await db.insert(issueRecoveryActions).values({
      companyId,
      sourceIssueId: stranded,
      kind: "stranded_assigned_issue",
      status: "active",
      ownerAgentId: agentId,
      cause: "stranded_assigned_issue",
      fingerprint: `source_scoped_recovery:${companyId}:${stranded}:stranded_assigned_issue:${agentId}`,
      nextAction: "Restore a live execution path.",
    });

    const result = await reconcileStrandedBlockedIssues(db);

    expect(result.reconciled).toBe(0);
    expect(await statusOf(stranded)).toBe("blocked");
  });

  it("does not sweep edge-less blocked issues with explicit pending interactions or approvals", async () => {
    const { companyId, agentId } = await createCompany("SBI");
    const waitingOnInteraction = await insertIssue({
      companyId,
      identifier: "SBI-1",
      status: "blocked",
      assigneeAgentId: agentId,
    });
    const waitingOnApproval = await insertIssue({
      companyId,
      identifier: "SBI-2",
      status: "blocked",
      assigneeAgentId: agentId,
    });
    await db.insert(issueThreadInteractions).values({
      companyId,
      issueId: waitingOnInteraction,
      kind: "request_confirmation",
      status: "pending",
      payload: { version: 1, prompt: "Confirm before resuming" },
    });
    const approvalId = randomUUID();
    await db.insert(approvals).values({
      id: approvalId,
      companyId,
      type: "issue_review",
      status: "pending",
      payload: {},
    });
    await db.insert(issueApprovals).values({
      companyId,
      issueId: waitingOnApproval,
      approvalId,
      linkedByAgentId: agentId,
    });

    const result = await reconcileStrandedBlockedIssues(db);

    expect(result.reconciled).toBe(0);
    expect(await statusOf(waitingOnInteraction)).toBe("blocked");
    expect(await statusOf(waitingOnApproval)).toBe("blocked");
  });

  it("does not sweep latest-agent-comment waits or active executive holds", async () => {
    const { companyId, agentId } = await createCompany("SBC");
    const ctoAgentId = randomUUID();
    await db.insert(agents).values({
      id: ctoAgentId,
      companyId,
      name: "CTO",
      role: "cto",
      status: "active",
    });
    const awaitingUser = await insertIssue({
      companyId,
      identifier: "SBC-1",
      status: "blocked",
      assigneeAgentId: agentId,
    });
    const executiveHold = await insertIssue({
      companyId,
      identifier: "SBC-2",
      status: "blocked",
      assigneeAgentId: agentId,
    });
    await db.insert(issueComments).values({
      companyId,
      issueId: awaitingUser,
      authorAgentId: agentId,
      body: "Please pick an option before work resumes.",
      createdAt: new Date("2026-08-06T10:00:00.000Z"),
      updatedAt: new Date("2026-08-06T10:00:00.000Z"),
    });
    await db.insert(issueComments).values({
      companyId,
      issueId: executiveHold,
      authorAgentId: ctoAgentId,
      body: "Pausing this - do not retry before 2099-01-01T00:00:00Z.",
      createdAt: new Date("2026-08-06T10:01:00.000Z"),
      updatedAt: new Date("2026-08-06T10:01:00.000Z"),
    });

    const result = await reconcileStrandedBlockedIssues(db);

    expect(result.reconciled).toBe(0);
    expect(await statusOf(awaitingUser)).toBe("blocked");
    expect(await statusOf(executiveHold)).toBe("blocked");
  });

  it("does not sweep workspace-preflight-blocked issues, and continues scanning past suppressed rows", async () => {
    const { companyId, agentId } = await createCompany("SBP");
    const preflightBlocked = await insertIssue({
      companyId,
      identifier: "SBP-1",
      status: "blocked",
      assigneeAgentId: agentId,
    });
    const stranded = await insertIssue({
      companyId,
      identifier: "SBP-2",
      status: "blocked",
      assigneeAgentId: agentId,
    });
    await db
      .update(issues)
      .set({ updatedAt: new Date("2026-08-06T10:00:00.000Z") })
      .where(eq(issues.id, preflightBlocked));
    await db
      .update(issues)
      .set({ updatedAt: new Date("2026-08-06T10:01:00.000Z") })
      .where(eq(issues.id, stranded));
    await db.insert(activityLog).values({
      companyId,
      actorType: "system",
      actorId: "system",
      action: "issue.workspace_preflight_blocked",
      entityType: "issue",
      entityId: preflightBlocked,
      details: { code: "workspace_worktree_requires_project" },
      createdAt: new Date("2026-08-06T10:00:00.000Z"),
    });

    const result = await reconcileStrandedBlockedIssues(db, { batchSize: 1, maxIterations: 3 });

    expect(result.reconciled).toBe(1);
    expect(await statusOf(preflightBlocked)).toBe("blocked");
    expect(await statusOf(stranded)).toBe("todo");
  });

  it("sweeps a workspace-preflight-blocked issue once a project is attached (repaired, not permanent)", async () => {
    const { companyId, agentId } = await createCompany("SBW");
    const { projectId } = await createExecutionWorkspace(companyId);
    const preflightBlocked = await insertIssue({
      companyId,
      identifier: "SBW-1",
      status: "blocked",
      assigneeAgentId: agentId,
    });
    await db.insert(activityLog).values({
      companyId,
      actorType: "system",
      actorId: "system",
      action: "issue.workspace_preflight_blocked",
      entityType: "issue",
      entityId: preflightBlocked,
      details: { code: "workspace_worktree_requires_project" },
      createdAt: new Date("2026-08-06T10:00:00.000Z"),
    });

    const beforeRepair = await reconcileStrandedBlockedIssues(db);
    expect(beforeRepair.reconciled).toBe(0);
    expect(await statusOf(preflightBlocked)).toBe("blocked");

    await db.update(issues).set({ projectId }).where(eq(issues.id, preflightBlocked));

    const afterRepair = await reconcileStrandedBlockedIssues(db);
    expect(afterRepair.reconciled).toBe(1);
    expect(await statusOf(preflightBlocked)).toBe("todo");
  });

  it("is idempotent: a second sweep reconciles nothing further", async () => {
    const { companyId } = await createCompany("SB8");
    await insertIssue({ companyId, identifier: "SB8-1", status: "blocked" });

    const first = await reconcileStrandedBlockedIssues(db);
    const second = await reconcileStrandedBlockedIssues(db);

    expect(first.reconciled).toBe(1);
    expect(second.reconciled).toBe(0);
  });

  it("batches across multiple iterations when the backlog exceeds one batch", async () => {
    const { companyId } = await createCompany("SB9");
    for (let i = 0; i < 5; i += 1) {
      await insertIssue({ companyId, identifier: `SB9-${i}`, status: "blocked" });
    }

    const result = await reconcileStrandedBlockedIssues(db, { batchSize: 2 });

    expect(result.reconciled).toBe(5);
    expect(result.iterations).toBe(3);
  });

  it("does not clobber a concurrent status change after candidate selection", async () => {
    const { companyId } = await createCompany("SBR");
    const issueId = await insertIssue({ companyId, identifier: "SBR-1", status: "blocked" });
    const lockAcquired = defer();
    const releaseLock = defer();
    const holder = db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM issues WHERE id = ${issueId}::uuid FOR UPDATE`);
      lockAcquired.resolve();
      await releaseLock.promise;
      await tx.update(issues).set({ status: "in_progress" }).where(eq(issues.id, issueId));
    });
    await lockAcquired.promise;

    const reconcile = reconcileStrandedBlockedIssues(db, { batchSize: 1 });
    await new Promise((resolve) => setTimeout(resolve, 25));
    releaseLock.resolve();
    await holder;

    const result = await reconcile;

    expect(result.reconciled).toBe(0);
    expect(await statusOf(issueId)).toBe("in_progress");
  });
});
