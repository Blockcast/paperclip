import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  approvals,
  companies,
  createDb,
  executionWorkspaces,
  heartbeatRuns,
  issueApprovals,
  issueRelations,
  issueThreadInteractions,
  issues,
  projects,
  workspaceOperations,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";
import type { IssueBlockerAttention } from "@paperclipai/shared";
import { buildIssueGraphLivenessIncidentKey, RECOVERY_ORIGIN_KINDS } from "../services/recovery/origins.js";

type IssueListItem = Awaited<ReturnType<ReturnType<typeof issueService>["list"]>>[number] & {
  blockerAttention?: IssueBlockerAttention;
};

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue blocker attention tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue blocker attention", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-blocker-attention-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  }, 120_000);

  afterEach(async () => {
    await db.delete(workspaceOperations);
    await db.delete(issueThreadInteractions);
    await db.delete(issueApprovals);
    await db.delete(approvals);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createCompany(prefix = "PBA") {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const pausedAgentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Company ${prefix}`,
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: agentId,
        companyId,
        name: `${prefix} Agent`,
        role: "engineer",
        status: "idle",
      },
      {
        id: pausedAgentId,
        companyId,
        name: `${prefix} Paused`,
        role: "engineer",
        status: "paused",
      },
    ]);
    return { companyId, agentId, pausedAgentId };
  }

  async function insertIssue(input: {
    companyId: string;
    id?: string;
    identifier: string;
    title: string;
    status: string;
    parentId?: string | null;
    assigneeAgentId?: string | null;
    assigneeUserId?: string | null;
    originKind?: string | null;
    originId?: string | null;
    originFingerprint?: string | null;
    executionState?: Record<string, unknown> | null;
    executionWorkspaceId?: string | null;
    description?: string | null;
    monitorNextCheckAt?: Date | null;
    monitorAttemptCount?: number | null;
    executionPolicy?: unknown;
    parkedUntil?: Date | null;
    lastActivityAt?: Date | null;
  }) {
    const id = input.id ?? randomUUID();
    await db.insert(issues).values({
      id,
      companyId: input.companyId,
      identifier: input.identifier,
      title: input.title,
      status: input.status,
      priority: "medium",
      parentId: input.parentId ?? null,
      assigneeAgentId: input.assigneeAgentId ?? null,
      assigneeUserId: input.assigneeUserId ?? null,
      originKind: input.originKind ?? "manual",
      originId: input.originId ?? null,
      originFingerprint: input.originFingerprint ?? "default",
      executionState: input.executionState ?? null,
      executionWorkspaceId: input.executionWorkspaceId ?? null,
      description: input.description ?? null,
      // Migration 0076's BEFORE INSERT trigger mirrors `updated_at` into
      // `last_activity_at` only when the caller passes nothing, which is exactly so
      // fixtures can establish a historical activity baseline. PEN-5105 uses that.
      ...(input.lastActivityAt != null ? { lastActivityAt: input.lastActivityAt } : {}),
      ...(input.parkedUntil != null ? { parkedUntil: input.parkedUntil } : {}),
      ...(input.monitorNextCheckAt != null ? { monitorNextCheckAt: input.monitorNextCheckAt } : {}),
      ...(input.monitorAttemptCount != null ? { monitorAttemptCount: input.monitorAttemptCount } : {}),
      ...(input.executionPolicy != null ? { executionPolicy: input.executionPolicy as Record<string, unknown> } : {}),
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

  async function activeRun(input: { companyId: string; agentId: string; issueId: string; status?: string; current?: boolean }) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      status: input.status ?? "running",
      contextSnapshot: { issueId: input.issueId },
    });
    if (input.current !== false) {
      await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, input.issueId));
    }
    return runId;
  }

  it("classifies a blocked parent as covered when its child has a running execution path", async () => {
    const { companyId, agentId } = await createCompany("PBC");
    const parentId = await insertIssue({ companyId, identifier: "PBC-1", title: "Parent", status: "blocked" });
    const childId = await insertIssue({
      companyId,
      identifier: "PBC-2",
      title: "Running child",
      status: "todo",
      parentId,
      assigneeAgentId: agentId,
    });
    await block({ companyId, blockerIssueId: childId, blockedIssueId: parentId });
    await activeRun({ companyId, agentId, issueId: childId });

    const parent = ((await svc.list(companyId, { status: "blocked" })) as IssueListItem[]).find((issue) => issue.id === parentId);

    expect(parent?.blockerAttention).toMatchObject({
      state: "covered",
      reason: "active_child",
      unresolvedBlockerCount: 1,
      coveredBlockerCount: 1,
      attentionBlockerCount: 0,
      sampleBlockerIdentifier: "PBC-2",
    });
  });

  it("classifies a blocked parent as covered when its child has a running path without an explicit blocks row", async () => {
    const { companyId, agentId } = await createCompany("PCN");
    const parentId = await insertIssue({ companyId, identifier: "PCN-1", title: "Parent", status: "blocked" });
    const childId = await insertIssue({
      companyId,
      identifier: "PCN-2",
      title: "Running child",
      status: "todo",
      parentId,
      assigneeAgentId: agentId,
    });
    await activeRun({ companyId, agentId, issueId: childId });

    const parent = ((await svc.list(companyId, { status: "blocked" })) as IssueListItem[]).find((issue) => issue.id === parentId);

    expect(parent?.blockerAttention).toMatchObject({
      state: "covered",
      reason: "active_child",
      unresolvedBlockerCount: 1,
      coveredBlockerCount: 1,
      attentionBlockerCount: 0,
      sampleBlockerIdentifier: "PCN-2",
    });
  });

  it("classifies an assigned backlog blocker leaf without a waiting path as attention-needed", async () => {
    const { companyId, agentId } = await createCompany("PBB");
    const parentId = await insertIssue({ companyId, identifier: "PBB-1", title: "Parent", status: "blocked" });
    const blockerId = await insertIssue({
      companyId,
      identifier: "PBB-2",
      title: "Parked assigned blocker",
      status: "backlog",
      assigneeAgentId: agentId,
    });
    await block({ companyId, blockerIssueId: blockerId, blockedIssueId: parentId });

    const parent = ((await svc.list(companyId, { status: "blocked" })) as IssueListItem[]).find((issue) => issue.id === parentId);

    expect(parent?.blockerAttention).toMatchObject({
      state: "needs_attention",
      reason: "attention_required",
      unresolvedBlockerCount: 1,
      coveredBlockerCount: 0,
      stalledBlockerCount: 0,
      attentionBlockerCount: 1,
      sampleBlockerIdentifier: "PBB-2",
    });
  });

  it("treats a human-owned backlog blocker as a covered waiting path", async () => {
    const { companyId } = await createCompany("PBU");
    const parentId = await insertIssue({ companyId, identifier: "PBU-1", title: "Parent", status: "blocked" });
    const blockerId = await insertIssue({
      companyId,
      identifier: "PBU-2",
      title: "Human-owned parked blocker",
      status: "backlog",
      assigneeUserId: "board-user-1",
    });
    await block({ companyId, blockerIssueId: blockerId, blockedIssueId: parentId });

    const parent = ((await svc.list(companyId, { status: "blocked" })) as IssueListItem[]).find((issue) => issue.id === parentId);

    expect(parent?.blockerAttention).toMatchObject({
      state: "covered",
      reason: "active_dependency",
      unresolvedBlockerCount: 1,
      coveredBlockerCount: 1,
      attentionBlockerCount: 0,
      sampleBlockerIdentifier: "PBU-2",
    });
  });

  it("keeps mixed blockers attention-required when any path lacks active work", async () => {
    const { companyId, agentId } = await createCompany("PBM");
    const parentId = await insertIssue({ companyId, identifier: "PBM-1", title: "Parent", status: "blocked" });
    const activeChildId = await insertIssue({
      companyId,
      identifier: "PBM-2",
      title: "Running child",
      status: "todo",
      parentId,
      assigneeAgentId: agentId,
    });
    const idleBlockerId = await insertIssue({
      companyId,
      identifier: "PBM-3",
      title: "Idle blocker",
      status: "todo",
      assigneeAgentId: agentId,
    });
    await block({ companyId, blockerIssueId: activeChildId, blockedIssueId: parentId });
    await block({ companyId, blockerIssueId: idleBlockerId, blockedIssueId: parentId });
    await activeRun({ companyId, agentId, issueId: activeChildId });

    const parent = ((await svc.list(companyId, { status: "blocked" })) as IssueListItem[]).find((issue) => issue.id === parentId);

    expect(parent?.blockerAttention).toMatchObject({
      state: "needs_attention",
      reason: "attention_required",
      unresolvedBlockerCount: 2,
      coveredBlockerCount: 1,
      attentionBlockerCount: 1,
      sampleBlockerIdentifier: "PBM-3",
    });
  });

  it("ignores cancelled direct children when counting unresolved blocker attention", async () => {
    const { companyId, agentId } = await createCompany("PBD");
    const parentId = await insertIssue({ companyId, identifier: "PBD-1", title: "Parent", status: "blocked" });
    const activeBlockerOneId = await insertIssue({
      companyId,
      identifier: "PBD-2",
      title: "Running dependency one",
      status: "todo",
      assigneeAgentId: agentId,
    });
    const activeBlockerTwoId = await insertIssue({
      companyId,
      identifier: "PBD-3",
      title: "Running dependency two",
      status: "todo",
      assigneeAgentId: agentId,
    });
    await insertIssue({
      companyId,
      identifier: "PBD-4",
      title: "Cancelled child",
      status: "cancelled",
      parentId,
      assigneeAgentId: agentId,
    });
    await block({ companyId, blockerIssueId: activeBlockerOneId, blockedIssueId: parentId });
    await block({ companyId, blockerIssueId: activeBlockerTwoId, blockedIssueId: parentId });
    await activeRun({ companyId, agentId, issueId: activeBlockerOneId });
    await activeRun({ companyId, agentId, issueId: activeBlockerTwoId });

    const parent = (await svc.list(companyId, { status: "blocked" })).find((issue) => issue.id === parentId);

    expect(parent?.blockerAttention).toMatchObject({
      state: "covered",
      reason: "active_dependency",
      unresolvedBlockerCount: 2,
      coveredBlockerCount: 2,
      stalledBlockerCount: 0,
      attentionBlockerCount: 0,
    });
    expect(parent?.blockerAttention?.sampleBlockerIdentifier).not.toBe("PBD-4");
  });

  it("keeps blocker attention and dependency readiness counts in parity across blocker statuses", async () => {
    const { companyId, agentId } = await createCompany("PBP");
    const statuses = ["done", "cancelled", "blocked", "todo"] as const;
    const dependentIds: string[] = [];

    for (const [index, status] of statuses.entries()) {
      const dependentId = await insertIssue({
        companyId,
        identifier: `PBP-${index * 2 + 1}`,
        title: `${status} blocker dependent`,
        status: "todo",
        assigneeAgentId: agentId,
      });
      const blockerId = await insertIssue({
        companyId,
        identifier: `PBP-${index * 2 + 2}`,
        title: `${status} blocker`,
        status,
        assigneeAgentId: agentId,
      });
      await block({ companyId, blockerIssueId: blockerId, blockedIssueId: dependentId });
      dependentIds.push(dependentId);
    }

    const rows = (await svc.list(companyId, { status: "todo" })) as IssueListItem[];
    const readiness = await svc.listDependencyReadiness(companyId, dependentIds);

    for (const [index, dependentId] of dependentIds.entries()) {
      const expectedCount = statuses[index] === "done" ? 0 : 1;
      const row = rows.find((issue) => issue.id === dependentId);
      expect(row?.blockerAttention?.unresolvedBlockerCount).toBe(expectedCount);
      expect(readiness.get(dependentId)?.unresolvedBlockerCount).toBe(expectedCount);
      expect(readiness.get(dependentId)?.isDependencyReady).toBe(expectedCount === 0);
    }

    const cancelledDependent = rows.find((issue) => issue.id === dependentIds[1]);
    expect(cancelledDependent?.blockerAttention).toMatchObject({
      state: "needs_attention",
      reason: "attention_required",
      unresolvedBlockerCount: 1,
      attentionBlockerCount: 1,
    });
  });

  it("counts pending-finalize blockers as covered dependencies", async () => {
    const { companyId, agentId } = await createCompany("PBF");
    const projectId = randomUUID();
    const executionWorkspaceId = randomUUID();
    await db.insert(projects).values({ id: projectId, companyId, name: "Finalize parity" });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "Finalize parity workspace",
    });

    const pendingOnlyDependentId = await insertIssue({
      companyId,
      identifier: "PBF-1",
      title: "Pending-finalize dependent",
      status: "todo",
      assigneeAgentId: agentId,
    });
    const mixedDependentId = await insertIssue({
      companyId,
      identifier: "PBF-2",
      title: "Mixed blocker dependent",
      status: "todo",
      assigneeAgentId: agentId,
    });
    const doneBlockerId = await insertIssue({
      companyId,
      identifier: "PBF-3",
      title: "Done blocker awaiting finalize",
      status: "done",
      executionWorkspaceId,
    });
    const openBlockerId = await insertIssue({
      companyId,
      identifier: "PBF-4",
      title: "Open blocker",
      status: "todo",
      assigneeAgentId: agentId,
    });
    await block({ companyId, blockerIssueId: doneBlockerId, blockedIssueId: pendingOnlyDependentId });
    await block({ companyId, blockerIssueId: doneBlockerId, blockedIssueId: mixedDependentId });
    await block({ companyId, blockerIssueId: openBlockerId, blockedIssueId: mixedDependentId });
    await db.insert(workspaceOperations).values({
      companyId,
      executionWorkspaceId,
      issueId: doneBlockerId,
      phase: "worktree_prepare",
      status: "succeeded",
    });

    const rows = (await svc.list(companyId, { status: "todo" })) as IssueListItem[];
    const readiness = await svc.listDependencyReadiness(companyId, [pendingOnlyDependentId, mixedDependentId]);
    const pendingOnly = rows.find((issue) => issue.id === pendingOnlyDependentId);
    const mixed = rows.find((issue) => issue.id === mixedDependentId);

    expect(pendingOnly?.blockerAttention).toMatchObject({
      state: "covered",
      reason: "active_dependency",
      unresolvedBlockerCount: 1,
      coveredBlockerCount: 1,
      attentionBlockerCount: 0,
    });
    expect(pendingOnly?.blockerAttention?.unresolvedBlockerCount).toBe(
      readiness.get(pendingOnlyDependentId)?.unresolvedBlockerCount,
    );
    expect(mixed?.blockerAttention).toMatchObject({
      state: "needs_attention",
      unresolvedBlockerCount: 2,
      coveredBlockerCount: 1,
      attentionBlockerCount: 1,
    });
    expect(mixed?.blockerAttention?.unresolvedBlockerCount).toBe(
      readiness.get(mixedDependentId)?.unresolvedBlockerCount,
    );
  });

  it("does not surface terminal dependents with unresolved blockers as attention roots", async () => {
    const { companyId, agentId } = await createCompany("PBT");
    const blockerId = await insertIssue({
      companyId,
      identifier: "PBT-1",
      title: "Open blocker",
      status: "todo",
      assigneeAgentId: agentId,
    });
    const doneDependentId = await insertIssue({
      companyId,
      identifier: "PBT-2",
      title: "Done dependent",
      status: "done",
      assigneeAgentId: agentId,
    });
    const cancelledDependentId = await insertIssue({
      companyId,
      identifier: "PBT-3",
      title: "Cancelled dependent",
      status: "cancelled",
      assigneeAgentId: agentId,
    });
    await block({ companyId, blockerIssueId: blockerId, blockedIssueId: doneDependentId });
    await block({ companyId, blockerIssueId: blockerId, blockedIssueId: cancelledDependentId });

    const rows = (await svc.list(companyId, { status: "done,cancelled" })) as IssueListItem[];
    const doneDependent = rows.find((issue) => issue.id === doneDependentId);
    const cancelledDependent = rows.find((issue) => issue.id === cancelledDependentId);

    expect(doneDependent?.blockerAttention).toMatchObject({
      state: "none",
      unresolvedBlockerCount: 0,
      attentionBlockerCount: 0,
    });
    expect(cancelledDependent?.blockerAttention).toMatchObject({
      state: "none",
      unresolvedBlockerCount: 0,
      attentionBlockerCount: 0,
    });
  });

  it("covers recursive blocker chains when the downstream leaf has active work", async () => {
    const { companyId, agentId } = await createCompany("PBR");
    const parentId = await insertIssue({ companyId, identifier: "PBR-1", title: "Parent", status: "blocked" });
    const blockerId = await insertIssue({ companyId, identifier: "PBR-2", title: "Blocked dependency", status: "blocked" });
    const leafId = await insertIssue({
      companyId,
      identifier: "PBR-3",
      title: "Running leaf",
      status: "todo",
      assigneeAgentId: agentId,
    });
    await block({ companyId, blockerIssueId: blockerId, blockedIssueId: parentId });
    await block({ companyId, blockerIssueId: leafId, blockedIssueId: blockerId });
    await activeRun({ companyId, agentId, issueId: leafId });

    const parent = ((await svc.list(companyId, { status: "blocked" })) as IssueListItem[]).find((issue) => issue.id === parentId);

    expect(parent?.blockerAttention).toMatchObject({
      state: "covered",
      reason: "active_dependency",
      unresolvedBlockerCount: 1,
      coveredBlockerCount: 1,
      attentionBlockerCount: 0,
      sampleBlockerIdentifier: "PBR-3",
    });
  });

  it("does not let another company's active run cover the blocker", async () => {
    const { companyId, agentId } = await createCompany("PBS");
    const other = await createCompany("PBT");
    const parentId = await insertIssue({ companyId, identifier: "PBS-1", title: "Parent", status: "blocked" });
    const blockerId = await insertIssue({
      companyId,
      identifier: "PBS-2",
      title: "Same-company blocker",
      status: "todo",
      assigneeAgentId: agentId,
    });
    await block({ companyId, blockerIssueId: blockerId, blockedIssueId: parentId });
    await activeRun({ companyId: other.companyId, agentId: other.agentId, issueId: blockerId });

    const parent = ((await svc.list(companyId, { status: "blocked" })) as IssueListItem[]).find((issue) => issue.id === parentId);

    expect(parent?.blockerAttention).toMatchObject({
      state: "needs_attention",
      reason: "attention_required",
      unresolvedBlockerCount: 1,
      coveredBlockerCount: 0,
      attentionBlockerCount: 1,
      sampleBlockerIdentifier: "PBS-2",
    });
  });

  it("does not cover a blocker from a stale run the issue no longer owns", async () => {
    const { companyId, agentId } = await createCompany("PBX");
    const parentId = await insertIssue({ companyId, identifier: "PBX-1", title: "Parent", status: "blocked" });
    const blockerId = await insertIssue({
      companyId,
      identifier: "PBX-2",
      title: "Previously running blocker",
      status: "blocked",
      assigneeAgentId: agentId,
    });
    await block({ companyId, blockerIssueId: blockerId, blockedIssueId: parentId });
    await activeRun({ companyId, agentId, issueId: blockerId, current: false });

    const parent = ((await svc.list(companyId, { status: "blocked" })) as IssueListItem[]).find((issue) => issue.id === parentId);

    expect(parent?.blockerAttention).toMatchObject({
      state: "needs_attention",
      reason: "attention_required",
      unresolvedBlockerCount: 1,
      coveredBlockerCount: 0,
      attentionBlockerCount: 1,
      sampleBlockerIdentifier: "PBX-2",
    });
  });

  it("flags a chain whose leaf is in_review without an action path as stalled", async () => {
    const { companyId, agentId } = await createCompany("PBV");
    const parentId = await insertIssue({ companyId, identifier: "PBV-1", title: "Parent", status: "blocked" });
    const reviewLeafId = await insertIssue({
      companyId,
      identifier: "PBV-2",
      title: "Stalled review leaf",
      status: "in_review",
      assigneeAgentId: agentId,
    });
    await block({ companyId, blockerIssueId: reviewLeafId, blockedIssueId: parentId });

    const parent = ((await svc.list(companyId, { status: "blocked" })) as IssueListItem[]).find((issue) => issue.id === parentId);

    expect(parent?.blockerAttention).toMatchObject({
      state: "stalled",
      reason: "stalled_review",
      unresolvedBlockerCount: 1,
      coveredBlockerCount: 0,
      stalledBlockerCount: 1,
      attentionBlockerCount: 0,
      sampleBlockerIdentifier: "PBV-2",
      sampleStalledBlockerIdentifier: "PBV-2",
    });
  });

  it("does not flag an in_review leaf as stalled when an active run is still progressing it", async () => {
    const { companyId, agentId } = await createCompany("PBW");
    const parentId = await insertIssue({ companyId, identifier: "PBW-1", title: "Parent", status: "blocked" });
    const reviewLeafId = await insertIssue({
      companyId,
      identifier: "PBW-2",
      title: "Active review leaf",
      status: "in_review",
      assigneeAgentId: agentId,
    });
    await block({ companyId, blockerIssueId: reviewLeafId, blockedIssueId: parentId });
    await activeRun({ companyId, agentId, issueId: reviewLeafId });

    const parent = ((await svc.list(companyId, { status: "blocked" })) as IssueListItem[]).find((issue) => issue.id === parentId);

    expect(parent?.blockerAttention).toMatchObject({
      state: "covered",
      stalledBlockerCount: 0,
    });
  });

  it("flags a deep chain whose leaf is stalled in_review through multiple layers", async () => {
    const { companyId, agentId } = await createCompany("PBZ");
    const rootId = await insertIssue({ companyId, identifier: "PBZ-1", title: "Root", status: "blocked" });
    const midId = await insertIssue({ companyId, identifier: "PBZ-2", title: "Mid blocker", status: "blocked" });
    const leafId = await insertIssue({
      companyId,
      identifier: "PBZ-3",
      title: "Stalled leaf",
      status: "in_review",
      assigneeAgentId: agentId,
    });
    await block({ companyId, blockerIssueId: midId, blockedIssueId: rootId });
    await block({ companyId, blockerIssueId: leafId, blockedIssueId: midId });

    const root = ((await svc.list(companyId, { status: "blocked" })) as IssueListItem[]).find((issue) => issue.id === rootId);

    expect(root?.blockerAttention).toMatchObject({
      state: "stalled",
      reason: "stalled_review",
      stalledBlockerCount: 1,
      sampleStalledBlockerIdentifier: "PBZ-3",
    });
  });

  it("prefers needs_attention over stalled when the chain also has a hard attention case", async () => {
    const { companyId, agentId } = await createCompany("PBQ");
    const parentId = await insertIssue({ companyId, identifier: "PBQ-1", title: "Parent", status: "blocked" });
    const reviewLeafId = await insertIssue({
      companyId,
      identifier: "PBQ-2",
      title: "Stalled review leaf",
      status: "in_review",
      assigneeAgentId: agentId,
    });
    const cancelledLeafId = await insertIssue({
      companyId,
      identifier: "PBQ-3",
      title: "Cancelled blocker",
      status: "cancelled",
      assigneeAgentId: agentId,
    });
    await block({ companyId, blockerIssueId: reviewLeafId, blockedIssueId: parentId });
    await block({ companyId, blockerIssueId: cancelledLeafId, blockedIssueId: parentId });

    const parent = ((await svc.list(companyId, { status: "blocked" })) as IssueListItem[]).find((issue) => issue.id === parentId);

    expect(parent?.blockerAttention).toMatchObject({
      state: "needs_attention",
      reason: "attention_required",
      coveredBlockerCount: 0,
      stalledBlockerCount: 1,
      attentionBlockerCount: 1,
      sampleStalledBlockerIdentifier: "PBQ-2",
    });
  });

  it("treats open liveness escalation blockers as covered waiting paths", async () => {
    const { companyId, agentId } = await createCompany("PBL");
    const parentId = await insertIssue({ companyId, identifier: "PBL-1", title: "Parent", status: "blocked" });
    const cancelledLeafId = await insertIssue({
      companyId,
      identifier: "PBL-2",
      title: "Cancelled blocker",
      status: "cancelled",
      assigneeAgentId: agentId,
    });
    const incidentKey = buildIssueGraphLivenessIncidentKey({
      companyId,
      issueId: parentId,
      state: "blocked_by_cancelled_issue",
      blockerIssueId: cancelledLeafId,
    });
    const escalationId = await insertIssue({
      companyId,
      identifier: "PBL-3",
      title: "Liveness escalation",
      status: "todo",
      assigneeAgentId: agentId,
      originKind: RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation,
      originId: incidentKey,
      originFingerprint: [
        "harness_liveness_leaf",
        companyId,
        "blocked_by_cancelled_issue",
        cancelledLeafId,
      ].join(":"),
    });
    await block({ companyId, blockerIssueId: cancelledLeafId, blockedIssueId: parentId });
    await block({ companyId, blockerIssueId: escalationId, blockedIssueId: parentId });

    const parent = ((await svc.list(companyId, { status: "blocked,todo" })) as IssueListItem[]).find((issue) => issue.id === parentId);

    expect(parent?.blockerAttention).toMatchObject({
      state: "covered",
      reason: "active_dependency",
      unresolvedBlockerCount: 2,
      coveredBlockerCount: 2,
      attentionBlockerCount: 0,
    });
  });

  it("does not treat cancelled liveness escalation issues as covered waiting paths", async () => {
    const { companyId, agentId } = await createCompany("PBLX");
    const parentId = await insertIssue({ companyId, identifier: "PBLX-1", title: "Parent", status: "blocked" });
    const cancelledLeafId = await insertIssue({
      companyId,
      identifier: "PBLX-2",
      title: "Cancelled blocker",
      status: "cancelled",
      assigneeAgentId: agentId,
    });
    await insertIssue({
      companyId,
      identifier: "PBLX-3",
      title: "Cancelled liveness escalation",
      status: "cancelled",
      assigneeAgentId: agentId,
      originKind: "harness_liveness_escalation",
      originId: [
        "harness_liveness",
        companyId,
        parentId,
        "blocked_by_cancelled_issue",
        cancelledLeafId,
      ].join(":"),
    });
    await block({ companyId, blockerIssueId: cancelledLeafId, blockedIssueId: parentId });

    const parent = (await svc.list(companyId, { attention: "blocked" })).find((issue) => issue.id === parentId);

    expect(parent?.blockedInboxAttention).toMatchObject({
      state: "needs_attention",
      reason: "blocked_by_cancelled_issue",
      leafIssue: { id: cancelledLeafId, identifier: "PBLX-2" },
    });
  });

  it("does not treat a scheduled retry as actively covered work", async () => {
    const { companyId, agentId } = await createCompany("PBY");
    const parentId = await insertIssue({ companyId, identifier: "PBY-1", title: "Parent", status: "blocked" });
    const blockerId = await insertIssue({
      companyId,
      identifier: "PBY-2",
      title: "Retrying blocker",
      status: "blocked",
      assigneeAgentId: agentId,
    });
    await block({ companyId, blockerIssueId: blockerId, blockedIssueId: parentId });
    await activeRun({ companyId, agentId, issueId: blockerId, status: "scheduled_retry" });

    const parent = ((await svc.list(companyId, { status: "blocked" })) as IssueListItem[]).find((issue) => issue.id === parentId);

    expect(parent?.blockerAttention).toMatchObject({
      state: "needs_attention",
      reason: "attention_required",
      unresolvedBlockerCount: 1,
      coveredBlockerCount: 0,
      attentionBlockerCount: 1,
      sampleBlockerIdentifier: "PBY-2",
    });
  });
  it("returns blocked inbox attention for an unassigned blocker leaf and supports count/search", async () => {
    const { companyId } = await createCompany("BIA");
    const parentId = await insertIssue({ companyId, identifier: "BIA-1", title: "Blocked source", status: "blocked" });
    const blockerId = await insertIssue({
      companyId,
      identifier: "BIA-2",
      title: "Unassigned leaf",
      status: "todo",
    });
    await block({ companyId, blockerIssueId: blockerId, blockedIssueId: parentId });

    const rows = await svc.list(companyId, { attention: "blocked", q: "BIA-2" });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(parentId);
    expect(rows[0]?.blockedBy).toEqual([
      expect.objectContaining({ id: blockerId, identifier: "BIA-2" }),
    ]);
    expect(rows[0]?.blockedInboxAttention).toMatchObject({
      kind: "blocked",
      state: "needs_attention",
      reason: "blocked_by_unassigned_issue",
      severity: "critical",
      owner: { type: "unknown", agentId: null, userId: null },
      action: { label: "Assign blocker" },
      leafIssue: { id: blockerId, identifier: "BIA-2" },
      redaction: { secretFieldsOmitted: true },
    });
    await expect(svc.count(companyId, { attention: "blocked" })).resolves.toBe(1);
  });

  it("surfaces cancelled-blocker attention on an assigned todo source", async () => {
    const { companyId, agentId } = await createCompany("BICX");
    const sourceId = await insertIssue({
      companyId,
      identifier: "BICX-1",
      title: "Dispatch-suppressed source",
      status: "todo",
      assigneeAgentId: agentId,
    });
    const blockerId = await insertIssue({
      companyId,
      identifier: "BICX-2",
      title: "Cancelled dependency",
      status: "cancelled",
      assigneeAgentId: agentId,
    });
    await block({ companyId, blockerIssueId: blockerId, blockedIssueId: sourceId });

    const rows = await svc.list(companyId, { attention: "blocked" });
    const source = rows.find((issue) => issue.id === sourceId);

    expect(source?.blockedInboxAttention).toMatchObject({
      kind: "blocked",
      state: "needs_attention",
      reason: "blocked_by_cancelled_issue",
      owner: { type: "agent", agentId },
      action: { label: "Replace blocker" },
      leafIssue: { id: blockerId, identifier: "BICX-2" },
    });
  });

  it("redacts external wait details from blocked inbox payloads and search", async () => {
    const { companyId } = await createCompany("BIX");
    const owner = "Private Vendor Security Team";
    const action = "Send the confidential access token for customer Alpha";
    const issueId = await insertIssue({
      companyId,
      identifier: "BIX-1",
      title: "Blocked on vendor",
      status: "blocked",
      description: [
        "Public context stays visible.",
        `external owner: ${owner}`,
        `external action: ${action}`,
        "Continue after the vendor confirms receipt.",
      ].join("\n"),
    });

    const rows = await svc.list(companyId, { attention: "blocked" });
    const issue = rows.find((row) => row.id === issueId);

    expect(issue?.description).toContain("Public context stays visible.");
    expect(issue?.description).toContain("Continue after the vendor confirms receipt.");
    expect(issue?.description).not.toContain(owner);
    expect(issue?.description).not.toContain(action);
    expect(issue?.blockedInboxAttention).toMatchObject({
      state: "external_wait",
      reason: "external_owner_action",
      owner: { type: "external", label: null },
      action: { label: "External owner action", detail: null },
      redaction: { externalDetailsRedacted: true, secretFieldsOmitted: true },
    });
    expect(JSON.stringify(issue?.blockedInboxAttention)).not.toContain(owner);
    expect(JSON.stringify(issue?.blockedInboxAttention)).not.toContain(action);

    await expect(svc.list(companyId, { attention: "blocked", q: owner })).resolves.toEqual([]);
    await expect(svc.count(companyId, { attention: "blocked", q: action })).resolves.toBe(0);
    await expect(svc.count(companyId, { attention: "blocked", q: "Public context" })).resolves.toBe(1);
  });

  it("excludes healthy active blockers from blocked inbox attention", async () => {
    const { companyId, agentId } = await createCompany("BIB");
    const parentId = await insertIssue({ companyId, identifier: "BIB-1", title: "Blocked source", status: "blocked" });
    const blockerId = await insertIssue({
      companyId,
      identifier: "BIB-2",
      title: "Running leaf",
      status: "todo",
      assigneeAgentId: agentId,
    });
    await block({ companyId, blockerIssueId: blockerId, blockedIssueId: parentId });
    await activeRun({ companyId, agentId, issueId: blockerId });

    expect(await svc.list(companyId, { attention: "blocked" })).toEqual([]);
  });

  it("batches blocked-inbox blocker attention across independent roots", async () => {
    const { companyId, agentId } = await createCompany("BIBQ");
    const firstParentId = await insertIssue({
      companyId,
      identifier: "BIBQ-1",
      title: "First blocked source",
      status: "blocked",
    });
    const firstBlockerId = await insertIssue({
      companyId,
      identifier: "BIBQ-2",
      title: "First running leaf",
      status: "todo",
      assigneeAgentId: agentId,
    });
    await block({ companyId, blockerIssueId: firstBlockerId, blockedIssueId: firstParentId });
    await activeRun({ companyId, agentId, issueId: firstBlockerId });

    const selectSpy = vi.spyOn(db, "select");
    let oneRootSelectCount = 0;
    try {
      expect(await svc.list(companyId, { attention: "blocked" })).toEqual([]);
      oneRootSelectCount = selectSpy.mock.calls.length;
    } finally {
      selectSpy.mockRestore();
    }

    const secondParentId = await insertIssue({
      companyId,
      identifier: "BIBQ-3",
      title: "Second blocked source",
      status: "blocked",
    });
    const secondBlockerId = await insertIssue({
      companyId,
      identifier: "BIBQ-4",
      title: "Second running leaf",
      status: "todo",
      assigneeAgentId: agentId,
    });
    await block({ companyId, blockerIssueId: secondBlockerId, blockedIssueId: secondParentId });
    await activeRun({ companyId, agentId, issueId: secondBlockerId });

    const secondSelectSpy = vi.spyOn(db, "select");
    let twoRootSelectCount = 0;
    try {
      expect(await svc.list(companyId, { attention: "blocked" })).toEqual([]);
      twoRootSelectCount = secondSelectSpy.mock.calls.length;
    } finally {
      secondSelectSpy.mockRestore();
    }

    expect(twoRootSelectCount).toBe(oneRootSelectCount);
  });

  it("isolates traversal truncation to the oversized blocked-inbox root", async () => {
    const { companyId } = await createCompany("BIBN");
    const oversizedParentId = await insertIssue({
      companyId,
      identifier: "BIBN-1",
      title: "Oversized blocked source",
      status: "blocked",
    });

    const childRows = Array.from({ length: 2_000 }, (_, index) => ({
      id: randomUUID(),
      companyId,
      identifier: `BIBN-${index + 2}`,
      title: `Human-owned blocker ${index + 2}`,
      status: "backlog",
      priority: "medium",
      parentId: oversizedParentId,
      assigneeUserId: "board-user-1",
      originKind: "manual",
      originFingerprint: "default",
    }));

    await db.insert(issues).values(childRows);

    const coveredParentId = await insertIssue({
      companyId,
      identifier: "BIBN-2002",
      title: "Small covered blocked source",
      status: "blocked",
    });
    await block({
      companyId,
      blockerIssueId: childRows[0]!.id,
      blockedIssueId: coveredParentId,
    });

    const rows = await svc.list(companyId, { attention: "blocked" });

    expect(rows.map((row) => row.id)).toContain(oversizedParentId);
    expect(rows.map((row) => row.id)).not.toContain(coveredParentId);
  }, 120_000);

  it("classifies assigned backlog and invalid review leaves for blocked inbox attention", async () => {
    const { companyId, agentId, pausedAgentId } = await createCompany("BIC");
    const backlogParentId = await insertIssue({ companyId, identifier: "BIC-1", title: "Blocked by parked work", status: "blocked" });
    const backlogLeafId = await insertIssue({
      companyId,
      identifier: "BIC-2",
      title: "Parked blocker",
      status: "backlog",
      assigneeAgentId: agentId,
    });
    await block({ companyId, blockerIssueId: backlogLeafId, blockedIssueId: backlogParentId });

    const reviewId = await insertIssue({
      companyId,
      identifier: "BIC-3",
      title: "Invalid review",
      status: "in_review",
      assigneeAgentId: agentId,
      executionState: {
        status: "pending",
        currentStageId: null,
        currentStageIndex: null,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: pausedAgentId },
        returnAssignee: null,
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    });

    const rows = await svc.list(companyId, { attention: "blocked" });
    const byId = new Map(rows.map((row) => [row.id, row]));

    expect(byId.get(backlogParentId)?.blockedInboxAttention).toMatchObject({
      reason: "blocked_by_assigned_backlog_issue",
      severity: "high",
      owner: { type: "agent", agentId },
      leafIssue: { id: backlogLeafId },
    });
    expect(byId.get(reviewId)?.blockedInboxAttention).toMatchObject({
      reason: "invalid_review_participant",
      severity: "critical",
      action: { label: "Repair review participant" },
    });
  });

  // BLO-22660: the blocked-inbox map is the OPERATOR-FACING producer of the same classifier
  // the recovery sweep drives, and it selected `createdAt` and then dropped it building the
  // input, so a 32-day card read as a live waiting path here forever while the sweep aged the
  // identical card out. Tests are not typechecked in this package (see tsconfig.typecheck.json),
  // so the required-key guard on `IssueLivenessPendingInteractionInput` binds the production
  // producers but cannot bind this file -- which is exactly why the behavioural pin lives here.
  // Both arms are asserted: without the fresh arm the stale arm passes vacuously on a producer
  // that never suppressed anything.
  it("ages a stale pending interaction out of blocked-inbox attention (BLO-22660)", async () => {
    const { companyId, agentId } = await createCompany("BIS");

    const cardAge = async (createdAt: Date) => {
      const reviewId = await insertIssue({
        companyId,
        identifier: `BIS-${createdAt.getTime()}`,
        title: "Review behind a card",
        status: "in_review",
        assigneeAgentId: agentId,
        executionState: null,
      });
      const interactionId = randomUUID();
      await db.insert(issueThreadInteractions).values({
        id: interactionId,
        companyId,
        issueId: reviewId,
        kind: "request_confirmation",
        status: "pending",
        continuationPolicy: "wake_assignee",
        createdAt,
        payload: { version: 1, prompt: "Accept?" },
      });
      const rows = await svc.list(companyId, { attention: "blocked" });
      return { attention: rows.find((row) => row.id === reviewId)?.blockedInboxAttention ?? null, interactionId };
    };

    const { attention: fresh, interactionId: freshCardId } = await cardAge(new Date(Date.now() - 60_000));
    const { attention: stale, interactionId: staleCardId } = await cardAge(new Date(Date.now() - 25 * 60 * 60 * 1000));

    // A fresh card genuinely does own the next action, and the board is genuinely the owner.
    expect(fresh).toMatchObject({
      state: "awaiting_decision",
      reason: "pending_board_decision",
      severity: "medium",
      owner: { type: "board" },
    });
    expect(fresh?.interactionId).toBe(freshCardId);
    // A card nobody has answered in 25h does not. The row must stop naming the board as the
    // owner of a next action it has not taken.
    expect(stale).toMatchObject({
      state: "needs_attention",
      reason: "in_review_without_action_path",
      severity: "high",
    });
    expect(stale?.owner.type).not.toBe("board");
    // The stale row's recommended action is "resolve or withdraw the card", so the card it
    // means must be named. Dropping the row from the loop left this null while the action
    // text still told the operator to go withdraw something it declined to identify.
    expect(stale?.interactionId).toBe(staleCardId);
    // PEN-4193: the same stale card is also reported in its own field, which is what makes
    // "is anything overdue on this row?" answerable without re-deriving the 24h cutoff.
    // The fresh arm must be null: a card inside the window is not overdue, and without this
    // arm the stale assertion passes vacuously on an implementation that stamps every row.
    expect(stale?.overdueInteractionId).toBe(staleCardId);
    expect(fresh?.overdueInteractionId).toBeNull();
  });

  // BLO-22660: the pin above is the SELF form -- the stale card sits on the row being
  // listed, so keying the lookup on the source id happens to work. Every dependency-path
  // form evaluates staleness on the recovery issue instead, which is a different row, and
  // `blocked_by_assigned_backlog_issue` is never self-form at all: a blocker cannot be its
  // own blocked issue, so that state missed 100% of the time while the self-form test stayed
  // green. Pin the cross-row shape: card on the blocker, finding on the source.
  it("names a stale card that sits on the blocker, not the listed row (BLO-22660)", async () => {
    const { companyId, agentId } = await createCompany("BIX");
    const sourceId = await insertIssue({
      companyId,
      identifier: "BIX-1",
      title: "Blocked by a blocker holding a stale card",
      status: "blocked",
    });
    const blockerId = await insertIssue({
      companyId,
      identifier: "BIX-2",
      title: "Parked blocker behind a stale card",
      status: "backlog",
      assigneeAgentId: agentId,
    });
    await block({ companyId, blockerIssueId: blockerId, blockedIssueId: sourceId });

    const staleCardId = randomUUID();
    await db.insert(issueThreadInteractions).values({
      id: staleCardId,
      companyId,
      issueId: blockerId,
      kind: "request_confirmation",
      status: "pending",
      continuationPolicy: "wake_assignee",
      createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
      payload: { version: 1, prompt: "Accept?" },
    });

    const rows = await svc.list(companyId, { attention: "blocked" });
    const attention = rows.find((row) => row.id === sourceId)?.blockedInboxAttention ?? null;

    expect(attention).toMatchObject({
      state: "needs_attention",
      reason: "blocked_by_assigned_backlog_issue",
      recoveryIssue: { id: blockerId },
    });
    // The card the action text tells the operator to withdraw lives on the blocker. Keying
    // the lookup on the listed row's id returned null here while the prose still said
    // "resolve or withdraw its stale interaction".
    expect(attention?.interactionId).toBe(staleCardId);
    // PEN-4193: the two fields answer different questions and are keyed on different rows.
    // `interactionId` names the card the finding's recommended action refers to (on the
    // blocker); `overdueInteractionId` names an overdue card on the LISTED row, and there is
    // none here. Pinning null is what stops the new field from silently becoming an alias.
    expect(attention?.overdueInteractionId).toBeNull();
  });

  // BLO-22660: the ageing rule is deliberately asymmetric -- interactions age, approvals do
  // not -- and that asymmetry is only correct while the classifier and this ladder agree
  // about which paths age. Pin the pairing: a row carrying BOTH a stale card and a pending
  // approval is still owned by the board via the approval, so it must not fall through to
  // the stale-card finding. This fails if a later change ages approvals in one half only,
  // which is the precise shape of the defect this PR fixed twice.
  it("keeps a row with a stale card but a live approval on the approval path (BLO-22660)", async () => {
    const { companyId, agentId } = await createCompany("BIA");
    const reviewId = await insertIssue({
      companyId,
      identifier: "BIA-1",
      title: "Review with a stale card and a live approval",
      status: "in_review",
      assigneeAgentId: agentId,
      executionState: null,
    });
    const staleCardId = randomUUID();
    await db.insert(issueThreadInteractions).values({
      id: staleCardId,
      companyId,
      issueId: reviewId,
      kind: "request_confirmation",
      status: "pending",
      continuationPolicy: "wake_assignee",
      createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
      payload: { version: 1, prompt: "Accept?" },
    });
    const approvalId = randomUUID();
    await db.insert(approvals).values({
      id: approvalId,
      companyId,
      type: "request_board_approval",
      status: "pending",
      requestedByAgentId: agentId,
      payload: { title: "Decide this" },
    });
    await db.insert(issueApprovals).values({ companyId, issueId: reviewId, approvalId });

    const rows = await svc.list(companyId, { attention: "blocked" });
    const attention = rows.find((row) => row.id === reviewId)?.blockedInboxAttention ?? null;

    expect(attention).toMatchObject({
      state: "awaiting_decision",
      reason: "pending_board_decision",
      owner: { type: "board" },
      approvalId,
    });
    // PEN-4193 regression. This is the measured shape: PEN-3256 carried a 31.8-day
    // unanswered card AND a pending approval, and the approval branch -- which runs before
    // the finding branch that was the ONLY carrier of a stale card id -- claimed the row, so
    // the surface reported "Decide approval" and named no card at all. Whoever read it
    // concluded an approval was the only thing outstanding. The approval still legitimately
    // owns the next action (pinned above, BLO-22660); what must not happen is the question
    // going unreported because of it. `interactionId` stays null on this branch by design:
    // it means "the live card to answer", and this card is not live.
    expect(attention?.interactionId).toBeNull();
    expect(attention?.overdueInteractionId).toBe(staleCardId);
  });

  // BLO-47469: a `revision_requested` card waits on its requester (resubmit or withdraw), not
  // the board. Reporting it as "Board / Decide approval" sent operators to a queue with nothing
  // in it while the requester never learned the card was theirs.
  it("routes a revision_requested approval to its requester, and prefers a pending one (BLO-47469)", async () => {
    const { companyId, agentId } = await createCompany("BIR");
    const reviewId = await insertIssue({
      companyId,
      identifier: "BIR-1",
      title: "Review whose card was sent back",
      status: "in_review",
      assigneeAgentId: agentId,
      executionState: null,
    });
    const revisionId = randomUUID();
    await db.insert(approvals).values({
      id: revisionId,
      companyId,
      type: "request_board_approval",
      status: "revision_requested",
      requestedByAgentId: agentId,
      payload: { title: "Sent back" },
    });
    await db.insert(issueApprovals).values({ companyId, issueId: reviewId, approvalId: revisionId });

    const attentionOf = async () => (await svc.list(companyId, { attention: "blocked" }))
      .find((row) => row.id === reviewId)?.blockedInboxAttention ?? null;

    const revision = await attentionOf();
    expect(revision).toMatchObject({
      state: "awaiting_decision",
      reason: "pending_approval_revision",
      owner: { type: "agent", agentId, label: null },
      action: { label: "Resubmit or withdraw approval" },
      approvalId: revisionId,
    });
    expect(revision?.owner.type).not.toBe("board");

    const pendingId = randomUUID();
    await db.insert(approvals).values({
      id: pendingId,
      companyId,
      type: "request_board_approval",
      status: "pending",
      requestedByAgentId: agentId,
      payload: { title: "Live" },
    });
    await db.insert(issueApprovals).values({ companyId, issueId: reviewId, approvalId: pendingId });

    expect(await attentionOf()).toMatchObject({
      reason: "pending_board_decision",
      owner: { type: "board", label: "Board" },
      action: { label: "Decide approval" },
      approvalId: pendingId,
    });
  });

  it("classifies recovery issues and missing successful-run dispositions", async () => {
    const { companyId, agentId } = await createCompany("BID");
    const sourceId = await insertIssue({ companyId, identifier: "BID-1", title: "Stopped source", status: "blocked" });
    const leafId = await insertIssue({ companyId, identifier: "BID-2", title: "Stopped leaf", status: "todo" });
    const recoveryId = await insertIssue({
      companyId,
      identifier: "BID-3",
      title: "Recovery issue",
      status: "todo",
      assigneeAgentId: agentId,
      originKind: RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation,
      originId: buildIssueGraphLivenessIncidentKey({
        companyId,
        issueId: sourceId,
        state: "blocked_by_unassigned_issue",
        blockerIssueId: leafId,
      }),
    });
    const productivityReviewId = await insertIssue({
      companyId,
      identifier: "BID-5",
      title: "Productivity review issue",
      status: "todo",
      assigneeAgentId: agentId,
      originKind: RECOVERY_ORIGIN_KINDS.issueProductivityReview,
      originId: sourceId,
    });
    const handoffId = await insertIssue({
      companyId,
      identifier: "BID-4",
      title: "Needs disposition",
      status: "in_progress",
      assigneeAgentId: agentId,
    });
    await db.insert(activityLog).values({
      companyId,
      actorType: "system",
      actorId: "system",
      action: "issue.successful_run_handoff_required",
      entityType: "issue",
      entityId: handoffId,
      agentId,
      details: { sourceRunId: randomUUID(), detectedProgressSummary: "Progress was made" },
    });

    const rows = await svc.list(companyId, { attention: "blocked" });
    const byId = new Map(rows.map((row) => [row.id, row]));

    expect(byId.get(recoveryId)?.blockedInboxAttention).toMatchObject({
      state: "recovery_open",
      reason: "open_recovery_issue",
      sourceIssue: { id: sourceId },
      leafIssue: { id: leafId },
      recoveryIssue: { id: recoveryId },
    });
    expect(byId.get(productivityReviewId)?.blockedInboxAttention).toMatchObject({
      state: "recovery_open",
      reason: "open_recovery_issue",
      sourceIssue: { id: sourceId },
      recoveryIssue: { id: productivityReviewId },
    });
    expect(byId.get(handoffId)?.blockedInboxAttention).toMatchObject({
      state: "missing_disposition",
      reason: "missing_successful_run_disposition",
      owner: { type: "agent", agentId },
      action: { label: "Choose disposition" },
    });

    const handoffRunId = await activeRun({ companyId, agentId, issueId: handoffId, current: false });
    const liveRows = await svc.list(companyId, { attention: "blocked" });
    expect(liveRows.some((row) => row.id === handoffId)).toBe(false);

    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, handoffRunId));
    const stoppedRows = await svc.list(companyId, { attention: "blocked" });
    expect(stoppedRows.find((row) => row.id === handoffId)?.blockedInboxAttention).toMatchObject({
      state: "missing_disposition",
      reason: "missing_successful_run_disposition",
    });

    const scheduledRetryRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: scheduledRetryRunId,
      companyId,
      agentId,
      status: "scheduled_retry",
      contextSnapshot: { taskId: handoffId },
      scheduledRetryAt: new Date(Date.now() + 60_000),
      scheduledRetryAttempt: 1,
    });
    const scheduledRows = await svc.list(companyId, { attention: "blocked" });
    expect(scheduledRows.some((row) => row.id === handoffId)).toBe(false);

    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, scheduledRetryRunId));
    const exhaustedRows = await svc.list(companyId, { attention: "blocked" });
    expect(exhaustedRows.find((row) => row.id === handoffId)?.blockedInboxAttention).toMatchObject({
      state: "missing_disposition",
      reason: "missing_successful_run_disposition",
    });
  });

  it("covers an in_review blocker that has a valid scheduled monitor (BLO-8072)", async () => {
    const { companyId, agentId } = await createCompany("PBV");
    const parentId = await insertIssue({ companyId, identifier: "PBV-1", title: "Parent", status: "blocked" });
    const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const blockerId = await insertIssue({
      companyId,
      identifier: "PBV-2",
      title: "Monitored wait",
      status: "in_review",
      assigneeAgentId: agentId,
      monitorNextCheckAt: futureDate,
      monitorAttemptCount: 0,
    });
    await block({ companyId, blockerIssueId: blockerId, blockedIssueId: parentId });

    const parent = (await svc.list(companyId, { status: "blocked" })).find((issue) => issue.id === parentId);

    expect(parent?.blockerAttention).toMatchObject({
      state: "covered",
      unresolvedBlockerCount: 1,
      coveredBlockerCount: 1,
      stalledBlockerCount: 0,
    });
  });

  it("stalls an in_review blocker whose monitor has already fired (past nextCheckAt) (BLO-8072)", async () => {
    const { companyId, agentId } = await createCompany("PBS");
    const parentId = await insertIssue({ companyId, identifier: "PBS-1", title: "Parent", status: "blocked" });
    const pastDate = new Date(Date.now() - 60 * 1000);
    const blockerId = await insertIssue({
      companyId,
      identifier: "PBS-2",
      title: "Expired monitor wait",
      status: "in_review",
      assigneeAgentId: agentId,
      monitorNextCheckAt: pastDate,
      monitorAttemptCount: 0,
    });
    await block({ companyId, blockerIssueId: blockerId, blockedIssueId: parentId });

    const parent = (await svc.list(companyId, { status: "blocked" })).find((issue) => issue.id === parentId);

    expect(parent?.blockerAttention).toMatchObject({
      state: "stalled",
      reason: "stalled_review",
      stalledBlockerCount: 1,
    });
  });

  it("stalls an in_review blocker whose monitor has exhausted maxAttempts (BLO-8072)", async () => {
    const { companyId, agentId } = await createCompany("PBX");
    const parentId = await insertIssue({ companyId, identifier: "PBX-1", title: "Parent", status: "blocked" });
    const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const blockerId = await insertIssue({
      companyId,
      identifier: "PBX-2",
      title: "Exhausted monitor wait",
      status: "in_review",
      assigneeAgentId: agentId,
      monitorNextCheckAt: futureDate,
      monitorAttemptCount: 3,
      executionPolicy: { monitor: { maxAttempts: 3 } },
    });
    await block({ companyId, blockerIssueId: blockerId, blockedIssueId: parentId });

    const parent = (await svc.list(companyId, { status: "blocked" })).find((issue) => issue.id === parentId);

    expect(parent?.blockerAttention).toMatchObject({
      state: "stalled",
      reason: "stalled_review",
      stalledBlockerCount: 1,
    });
  });


  // PEN-5021: `blockerAttention` read status and monitor but never the park, so a blocker
  // deliberately stood down with a release wake owed to it classified `stalled` exactly like
  // one nobody had touched. Measured live twice in one sweep (PEN-4969 via PEN-4874,
  // PEN-4931 via PEN-4656); five times across three sweeps with the same missing term.
  it("covers an in_review blocker parked on a live deliberate park (PEN-5021)", async () => {
    const { companyId, agentId } = await createCompany("PPK");
    const parentId = await insertIssue({ companyId, identifier: "PPK-1", title: "Parent", status: "blocked" });
    const blockerId = await insertIssue({
      companyId,
      identifier: "PPK-2",
      title: "Parked review blocker",
      status: "in_review",
      assigneeAgentId: agentId,
      parkedUntil: new Date(Date.now() + 6 * 60 * 60 * 1000),
    });
    await block({ companyId, blockerIssueId: blockerId, blockedIssueId: parentId });

    const parent = ((await svc.list(companyId, { status: "blocked" })) as IssueListItem[]).find((issue) => issue.id === parentId);

    expect(parent?.blockerAttention).toMatchObject({
      state: "covered",
      unresolvedBlockerCount: 1,
      coveredBlockerCount: 1,
      stalledBlockerCount: 0,
      attentionBlockerCount: 0,
    });
  });

  // The negation, and the reason suppression cannot decay into permanent silence: expiry is
  // the default, so a park nobody restates stops covering on its own.
  it("stalls an in_review blocker whose deliberate park has lapsed (PEN-5021)", async () => {
    const { companyId, agentId } = await createCompany("PPL");
    const parentId = await insertIssue({ companyId, identifier: "PPL-1", title: "Parent", status: "blocked" });
    const blockerId = await insertIssue({
      companyId,
      identifier: "PPL-2",
      title: "Lapsed park review blocker",
      status: "in_review",
      assigneeAgentId: agentId,
      parkedUntil: new Date(Date.now() - 60 * 60 * 1000),
    });
    await block({ companyId, blockerIssueId: blockerId, blockedIssueId: parentId });

    const parent = ((await svc.list(companyId, { status: "blocked" })) as IssueListItem[]).find((issue) => issue.id === parentId);

    expect(parent?.blockerAttention).toMatchObject({
      state: "stalled",
      reason: "stalled_review",
      stalledBlockerCount: 1,
      sampleStalledBlockerIdentifier: "PPL-2",
    });
  });

  // A park only covers when it owes a release wake. `issueParkOwesReleaseWake` needs an agent
  // to wake, so an unassigned parked blocker must NOT be covered -- covering it would open a
  // quiet hole of exactly the kind PEN-5021's second half is about. It keeps the `stalled`
  // verdict the `in_review` arm already gave it, which is the correct reading: nothing is
  // going to wake it. The assertion that matters here is `coveredBlockerCount: 0`.
  it("does not cover an unassigned parked blocker, which is owed no release wake (PEN-5021)", async () => {
    const { companyId } = await createCompany("PPM");
    const parentId = await insertIssue({ companyId, identifier: "PPM-1", title: "Parent", status: "blocked" });
    const blockerId = await insertIssue({
      companyId,
      identifier: "PPM-2",
      title: "Unassigned parked blocker",
      status: "in_review",
      parkedUntil: new Date(Date.now() + 6 * 60 * 60 * 1000),
    });
    await block({ companyId, blockerIssueId: blockerId, blockedIssueId: parentId });

    const parent = ((await svc.list(companyId, { status: "blocked" })) as IssueListItem[]).find((issue) => issue.id === parentId);

    expect(parent?.blockerAttention).toMatchObject({
      state: "stalled",
      reason: "stalled_review",
      coveredBlockerCount: 0,
      stalledBlockerCount: 1,
      sampleStalledBlockerIdentifier: "PPM-2",
    });
  });

  // `blocked` is deliberately absent from ISSUE_PARK_EXPIRY_WAKE_STATUSES, so the park sweep
  // never wakes a blocked row and a park on one must not cover -- on the status conjunct and,
  // since the term is now scoped to the `in_review` arm, on the call site too.
  it("does not cover a parked blocker whose status the park sweep never wakes (PEN-5021)", async () => {
    const { companyId, agentId } = await createCompany("PPN");
    const parentId = await insertIssue({ companyId, identifier: "PPN-1", title: "Parent", status: "blocked" });
    const blockerId = await insertIssue({
      companyId,
      identifier: "PPN-2",
      title: "Parked blocked blocker",
      status: "blocked",
      assigneeAgentId: agentId,
      parkedUntil: new Date(Date.now() + 6 * 60 * 60 * 1000),
    });
    await block({ companyId, blockerIssueId: blockerId, blockedIssueId: parentId });

    const parent = ((await svc.list(companyId, { status: "blocked" })) as IssueListItem[]).find((issue) => issue.id === parentId);

    expect(parent?.blockerAttention).toMatchObject({
      state: "needs_attention",
      reason: "attention_required",
      coveredBlockerCount: 0,
      attentionBlockerCount: 1,
    });
  });

  // A park is owed a release wake only if some agent can take it. A paused assignee cannot,
  // so the park is not attendance and the blocker must keep its `stalled` verdict. Pins the
  // invokability conjunct, which `issueParkOwesReleaseWake` itself does not carry: that
  // function decides whether to ENQUEUE a wake, this one whether the wake will be SERVED.
  it("does not cover an in_review blocker parked to a paused assignee (PEN-5021)", async () => {
    const { companyId, pausedAgentId } = await createCompany("PPP");
    const parentId = await insertIssue({ companyId, identifier: "PPP-1", title: "Parent", status: "blocked" });
    const blockerId = await insertIssue({
      companyId,
      identifier: "PPP-2",
      title: "Parked review blocker owned by a paused agent",
      status: "in_review",
      assigneeAgentId: pausedAgentId,
      parkedUntil: new Date(Date.now() + 6 * 60 * 60 * 1000),
    });
    await block({ companyId, blockerIssueId: blockerId, blockedIssueId: parentId });

    const parent = ((await svc.list(companyId, { status: "blocked" })) as IssueListItem[]).find((issue) => issue.id === parentId);

    expect(parent?.blockerAttention).toMatchObject({
      state: "stalled",
      reason: "stalled_review",
      coveredBlockerCount: 0,
      stalledBlockerCount: 1,
      sampleStalledBlockerIdentifier: "PPP-2",
    });
  });

  // Scoping control. All five measured PEN-5021 instances are `in_review`; a `todo` blocker
  // reaches the leaf arm instead and must keep reading `needs_attention`. A status-agnostic
  // park check placed ahead of that arm would silently cover this row.
  it("does not cover a parked todo blocker: the park term is scoped to in_review (PEN-5021)", async () => {
    const { companyId, agentId } = await createCompany("PPQ");
    const parentId = await insertIssue({ companyId, identifier: "PPQ-1", title: "Parent", status: "blocked" });
    const blockerId = await insertIssue({
      companyId,
      identifier: "PPQ-2",
      title: "Parked todo blocker",
      status: "todo",
      assigneeAgentId: agentId,
      parkedUntil: new Date(Date.now() + 6 * 60 * 60 * 1000),
    });
    await block({ companyId, blockerIssueId: blockerId, blockedIssueId: parentId });

    const parent = ((await svc.list(companyId, { status: "blocked" })) as IssueListItem[]).find((issue) => issue.id === parentId);

    expect(parent?.blockerAttention).toMatchObject({
      state: "needs_attention",
      reason: "attention_required",
      coveredBlockerCount: 0,
      attentionBlockerCount: 1,
    });
  });

  // The expensive direction, pinned: a park must never stop the walk before the recursion
  // runs, or a real attention item deeper in the chain goes quiet with nothing announcing it.
  // The cancelled grandchild is hard attention and has to surface THROUGH the parked blocker.
  it("surfaces a hard-attention descendant through a parked in_progress blocker (PEN-5021)", async () => {
    const { companyId, agentId } = await createCompany("PPR");
    const parentId = await insertIssue({ companyId, identifier: "PPR-1", title: "Parent", status: "blocked" });
    const blockerId = await insertIssue({
      companyId,
      identifier: "PPR-2",
      title: "Parked in_progress blocker",
      status: "in_progress",
      assigneeAgentId: agentId,
      parkedUntil: new Date(Date.now() + 6 * 60 * 60 * 1000),
    });
    const cancelledLeafId = await insertIssue({
      companyId,
      identifier: "PPR-3",
      title: "Cancelled grandchild blocker",
      status: "cancelled",
      assigneeAgentId: agentId,
    });
    await block({ companyId, blockerIssueId: blockerId, blockedIssueId: parentId });
    await block({ companyId, blockerIssueId: cancelledLeafId, blockedIssueId: blockerId });

    const parent = ((await svc.list(companyId, { status: "blocked" })) as IssueListItem[]).find((issue) => issue.id === parentId);

    expect(parent?.blockerAttention).toMatchObject({
      state: "needs_attention",
      reason: "attention_required",
      coveredBlockerCount: 0,
      attentionBlockerCount: 1,
      sampleBlockerIdentifier: "PPR-3",
    });
  });

  // ---------------------------------------------------------------------------------
  // PEN-5105: the `assigneeUserId` arm covers unconditionally -- no staleness term, no
  // upper bound on how long it holds. PEN-5021 and PEN-5105 carry the sweeps attributing
  // the false-`covered` population to this arm; the figures stay on those rows rather than
  // being inlined here, where a snapshot would go stale silently.
  //
  // What the count below measures is an UPPER BOUND, not an exact delta: this arm returns
  // ahead of the `in_review` arm, the downstream recursion and the leaf monitor/run/park
  // checks, so a blocker failing a future staleness conjunct could still be covered by one
  // of those. It can only overstate the flood, which is the safe direction for sizing it.
  //
  // Taking the conjunct un-covers every human-assigned blocker company-wide at once, which
  // is the flood shape the CEO flagged on PEN-5021. So this ships the MEASUREMENT only.
  // Every test below therefore asserts the observation AND that `state` is untouched --
  // the second half is the point, not boilerplate: the moment one of these flips a `state`
  // the change has silently become the flood it exists to size.
  // ---------------------------------------------------------------------------------
  const HOUR_MS = 60 * 60 * 1000;

  it("counts a human-assigned covered blocker and reports its idle span (PEN-5105)", async () => {
    const { companyId } = await createCompany("PHA");
    const parentId = await insertIssue({ companyId, identifier: "PHA-1", title: "Parent", status: "blocked" });
    const blockerId = await insertIssue({
      companyId,
      identifier: "PHA-2",
      title: "Human-assigned blocker",
      status: "todo",
      assigneeUserId: "user-pha",
      lastActivityAt: new Date(Date.now() - 30 * HOUR_MS),
    });
    await block({ companyId, blockerIssueId: blockerId, blockedIssueId: parentId });

    const parent = ((await svc.list(companyId, { status: "blocked" })) as IssueListItem[]).find((issue) => issue.id === parentId);

    // Behaviour control: unchanged from before PEN-5105.
    expect(parent?.blockerAttention).toMatchObject({
      state: "covered",
      coveredBlockerCount: 1,
      stalledBlockerCount: 0,
      attentionBlockerCount: 0,
    });
    // Observation.
    expect(parent?.blockerAttention?.humanAssignedCoveredBlockerCount).toBe(1);
    expect(parent?.blockerAttention?.oldestHumanAssignedCoveredIdleHours).toBeGreaterThanOrEqual(29.9);
    expect(parent?.blockerAttention?.oldestHumanAssignedCoveredIdleHours).toBeLessThan(31);
  });

  // Negative control for "count every covered blocker". A live run covers through a
  // DIFFERENT arm, which has its own liveness term and is not what PEN-5105 sizes. Mutating
  // the root filter to `entry.result.covered` alone turns this 0 into a 1.
  it("does not count a blocker covered by a live run as human-assigned (PEN-5105)", async () => {
    const { companyId, agentId } = await createCompany("PHB");
    const parentId = await insertIssue({ companyId, identifier: "PHB-1", title: "Parent", status: "blocked" });
    const blockerId = await insertIssue({
      companyId,
      identifier: "PHB-2",
      title: "Agent-run blocker",
      status: "in_progress",
      assigneeAgentId: agentId,
      lastActivityAt: new Date(Date.now() - 300 * HOUR_MS),
    });
    await block({ companyId, blockerIssueId: blockerId, blockedIssueId: parentId });
    await activeRun({ companyId, agentId, issueId: blockerId });

    const parent = ((await svc.list(companyId, { status: "blocked" })) as IssueListItem[]).find((issue) => issue.id === parentId);

    expect(parent?.blockerAttention).toMatchObject({ state: "covered", coveredBlockerCount: 1 });
    // Stale by 300h, yet not this arm's population: it must not be counted.
    expect(parent?.blockerAttention?.humanAssignedCoveredBlockerCount).toBe(0);
    expect(parent?.blockerAttention?.oldestHumanAssignedCoveredIdleHours).toBeNull();
  });

  // Negative control for the `status !== "cancelled"` half of the arm. A cancelled blocker
  // has a human assignee but falls THROUGH the arm to the cancelled arm, which does not
  // cover. Nothing to un-cover, so nothing to count. Mutating that half of the arm to
  // `node.assigneeUserId` alone turns this 0 into a 1.
  //
  // ⚠ Measured, so it is not claimed falsely: this test does NOT discriminate the root
  // filter's `entry.result.covered` conjunct. Dropping that conjunct leaves this test
  // GREEN, because a cancelled blocker never sets `humanAssignedCovered` in the first
  // place -- today `humanAssignedCovered: true` is only ever emitted beside
  // `covered: true`, so the conjunct is currently implied. It is kept anyway, and the
  // reason is specific rather than defensive: propagating the flag through the
  // `hardAttention`/`stalled` branches is a plausible widening (to measure stale
  // human-assigned blockers on attention paths too), and under it an unguarded filter
  // would start counting edges that never covered -- silently inflating the very
  // blast-radius number the PEN-5105 threshold decision rests on.
  it("does not count a cancelled human-assigned blocker, which never covered (PEN-5105)", async () => {
    const { companyId } = await createCompany("PHC");
    const parentId = await insertIssue({ companyId, identifier: "PHC-1", title: "Parent", status: "blocked" });
    const blockerId = await insertIssue({
      companyId,
      identifier: "PHC-2",
      title: "Cancelled human-assigned blocker",
      status: "cancelled",
      assigneeUserId: "user-phc",
      lastActivityAt: new Date(Date.now() - 200 * HOUR_MS),
    });
    await block({ companyId, blockerIssueId: blockerId, blockedIssueId: parentId });

    const parent = ((await svc.list(companyId, { status: "blocked" })) as IssueListItem[]).find((issue) => issue.id === parentId);

    expect(parent?.blockerAttention?.humanAssignedCoveredBlockerCount).toBe(0);
    expect(parent?.blockerAttention?.oldestHumanAssignedCoveredIdleHours).toBeNull();
  });

  // Propagation control, and the reason the path carries the flag at all. PEN-5021's sweep
  // established the covering verdict can originate a level deeper and be carried up by the
  // recursion -- attributing it from the root's own `blockedBy` misattributes it, which was
  // the methodological error PEN-5105 had to correct mid-measurement. Deleting the
  // `humanAssignedCovered` term from the recursion's all-covered branch turns this 1 into 0.
  it("propagates human-assigned coverage up through the recursion (PEN-5105)", async () => {
    const { companyId } = await createCompany("PHD");
    const parentId = await insertIssue({ companyId, identifier: "PHD-1", title: "Parent", status: "blocked" });
    const midId = await insertIssue({ companyId, identifier: "PHD-2", title: "Mid chain", status: "blocked" });
    const leafId = await insertIssue({
      companyId,
      identifier: "PHD-3",
      title: "Deep human-assigned leaf",
      status: "todo",
      assigneeUserId: "user-phd",
      lastActivityAt: new Date(Date.now() - 48 * HOUR_MS),
    });
    await block({ companyId, blockerIssueId: midId, blockedIssueId: parentId });
    await block({ companyId, blockerIssueId: leafId, blockedIssueId: midId });

    const parent = ((await svc.list(companyId, { status: "blocked" })) as IssueListItem[]).find((issue) => issue.id === parentId);

    expect(parent?.blockerAttention).toMatchObject({ state: "covered", coveredBlockerCount: 1 });
    expect(parent?.blockerAttention?.humanAssignedCoveredBlockerCount).toBe(1);
    expect(parent?.blockerAttention?.oldestHumanAssignedCoveredIdleHours).toBeGreaterThanOrEqual(47.9);
  });

  // Reducer control: `max`, not `min` and not first-wins. A path's covered verdict collapses
  // as soon as ANY node in it stops covering, so the STALEST node sets the lowest threshold
  // at which the path flips. Swapping `Math.max` for `Math.min` at either the recursion or
  // the root turns this ~120 into ~6, which would under-report the blast radius by 20x --
  // and under-reporting it is what makes a threshold look safe when it is not.
  it("reports the stalest human-assigned blocker, not the freshest (PEN-5105)", async () => {
    const { companyId } = await createCompany("PHE");
    const parentId = await insertIssue({ companyId, identifier: "PHE-1", title: "Parent", status: "blocked" });
    const freshId = await insertIssue({
      companyId,
      identifier: "PHE-2",
      title: "Fresh human-assigned blocker",
      status: "todo",
      assigneeUserId: "user-phe-a",
      lastActivityAt: new Date(Date.now() - 6 * HOUR_MS),
    });
    const staleId = await insertIssue({
      companyId,
      identifier: "PHE-3",
      title: "Stale human-assigned blocker",
      status: "todo",
      assigneeUserId: "user-phe-b",
      lastActivityAt: new Date(Date.now() - 120 * HOUR_MS),
    });
    await block({ companyId, blockerIssueId: freshId, blockedIssueId: parentId });
    await block({ companyId, blockerIssueId: staleId, blockedIssueId: parentId });

    const parent = ((await svc.list(companyId, { status: "blocked" })) as IssueListItem[]).find((issue) => issue.id === parentId);

    expect(parent?.blockerAttention).toMatchObject({ state: "covered", coveredBlockerCount: 2 });
    // Two TOP-LEVEL edges, so two -- the count is per edge, which is what "how many
    // blockers would stop reading covered" actually asks.
    expect(parent?.blockerAttention?.humanAssignedCoveredBlockerCount).toBe(2);
    expect(parent?.blockerAttention?.oldestHumanAssignedCoveredIdleHours).toBeGreaterThanOrEqual(119.9);
  });

  // Per-edge, not per-node. A chain holding two stale human-assigned nodes still flips
  // exactly once, because the single top-level edge is what un-covers. Summing nodes
  // instead of counting edges turns this 1 into a 2 and inflates the blast radius.
  it("counts top-level edges, not human-assigned nodes in the chain (PEN-5105)", async () => {
    const { companyId } = await createCompany("PHF");
    const parentId = await insertIssue({ companyId, identifier: "PHF-1", title: "Parent", status: "blocked" });
    const midId = await insertIssue({
      companyId,
      identifier: "PHF-2",
      title: "Human-assigned mid",
      status: "blocked",
      assigneeUserId: "user-phf-a",
      lastActivityAt: new Date(Date.now() - 10 * HOUR_MS),
    });
    const leafId = await insertIssue({
      companyId,
      identifier: "PHF-3",
      title: "Human-assigned leaf",
      status: "todo",
      assigneeUserId: "user-phf-b",
      lastActivityAt: new Date(Date.now() - 90 * HOUR_MS),
    });
    await block({ companyId, blockerIssueId: midId, blockedIssueId: parentId });
    await block({ companyId, blockerIssueId: leafId, blockedIssueId: midId });

    const parent = ((await svc.list(companyId, { status: "blocked" })) as IssueListItem[]).find((issue) => issue.id === parentId);

    expect(parent?.blockerAttention?.humanAssignedCoveredBlockerCount).toBe(1);
  });

  // The whole-change control. A row with no blocker attention at all must still carry the
  // fields, explicitly 0/null rather than absent. This codebase has repeatedly paid for
  // optional observational fields whose ABSENCE reads as a legitimate value on an older
  // deployment, always in the fail-open direction; `createIssueBlockerAttention` emits
  // these unconditionally so a consumer can never confuse "none" with "not deployed".
  it("always emits the observation fields, even on a non-root row (PEN-5105)", async () => {
    const { companyId, agentId } = await createCompany("PHG");
    const soloId = await insertIssue({
      companyId,
      identifier: "PHG-1",
      title: "Unblocked row",
      status: "todo",
      assigneeAgentId: agentId,
    });

    const solo = ((await svc.list(companyId, {})) as IssueListItem[]).find((issue) => issue.id === soloId);

    expect(solo?.blockerAttention).toMatchObject({ state: "none" });
    expect(solo?.blockerAttention).toHaveProperty("humanAssignedCoveredBlockerCount", 0);
    expect(solo?.blockerAttention).toHaveProperty("oldestHumanAssignedCoveredIdleHours", null);
  });

  it("applies assigneeAgentId='null' as an IS NULL filter on the blocked-inbox path", async () => {
    const { companyId, agentId } = await createCompany("BAN");
    const unassignedParentId = await insertIssue({
      companyId,
      identifier: "BAN-1",
      title: "Unassigned blocked parent",
      status: "blocked",
    });
    const unassignedLeafId = await insertIssue({
      companyId,
      identifier: "BAN-2",
      title: "Unassigned leaf",
      status: "todo",
    });
    await block({ companyId, blockerIssueId: unassignedLeafId, blockedIssueId: unassignedParentId });

    const assignedParentId = await insertIssue({
      companyId,
      identifier: "BAN-3",
      title: "Assigned blocked parent",
      status: "blocked",
      assigneeAgentId: agentId,
    });
    const assignedLeafId = await insertIssue({
      companyId,
      identifier: "BAN-4",
      title: "Unassigned leaf for assigned parent",
      status: "todo",
    });
    await block({ companyId, blockerIssueId: assignedLeafId, blockedIssueId: assignedParentId });

    const rows = await svc.list(companyId, { attention: "blocked", assigneeAgentId: "null" });
    expect(rows.map((row) => row.id)).toEqual([unassignedParentId]);

    await expect(svc.count(companyId, { attention: "blocked", assigneeAgentId: "null" })).resolves.toBe(1);
  });

  it("applies a UUID assigneeAgentId filter on the blocked-inbox path", async () => {
    const { companyId, agentId } = await createCompany("BAU");
    const unassignedParentId = await insertIssue({
      companyId,
      identifier: "BAU-1",
      title: "Unassigned blocked parent",
      status: "blocked",
    });
    const unassignedLeafId = await insertIssue({
      companyId,
      identifier: "BAU-2",
      title: "Unassigned leaf",
      status: "todo",
    });
    await block({ companyId, blockerIssueId: unassignedLeafId, blockedIssueId: unassignedParentId });

    const assignedParentId = await insertIssue({
      companyId,
      identifier: "BAU-3",
      title: "Assigned blocked parent",
      status: "blocked",
      assigneeAgentId: agentId,
    });
    const assignedLeafId = await insertIssue({
      companyId,
      identifier: "BAU-4",
      title: "Unassigned leaf for assigned parent",
      status: "todo",
    });
    await block({ companyId, blockerIssueId: assignedLeafId, blockedIssueId: assignedParentId });

    const rows = await svc.list(companyId, { attention: "blocked", assigneeAgentId: agentId });
    expect(rows.map((row) => row.id)).toEqual([assignedParentId]);

    await expect(svc.count(companyId, { attention: "blocked", assigneeAgentId: agentId })).resolves.toBe(1);
  });

  it("rejects malformed assigneeAgentId filter values on the blocked-inbox path", async () => {
    const { companyId } = await createCompany("BAM");
    await expect(
      svc.list(companyId, { attention: "blocked", assigneeAgentId: "not-a-uuid" }),
    ).rejects.toThrow(/assigneeAgentId/i);
    await expect(
      svc.count(companyId, { attention: "blocked", assigneeAgentId: "not-a-uuid" }),
    ).rejects.toThrow(/assigneeAgentId/i);
  });
});
