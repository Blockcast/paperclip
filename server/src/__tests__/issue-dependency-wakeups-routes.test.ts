import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockWakeup = vi.hoisted(() => vi.fn(async () => undefined));
const mockIssueService = vi.hoisted(() => ({
  getAncestors: vi.fn(),
  getById: vi.fn(),
  getByIdentifier: vi.fn(async () => null),
  getComment: vi.fn(),
  getCommentCursor: vi.fn(),
  getRelationSummaries: vi.fn(),
  update: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
  findMentionedAgents: vi.fn(async () => []),
}));

vi.mock("../services/index.js", () => ({
  companyService: () => ({
    getById: vi.fn(async () => ({ id: "company-1", attachmentMaxBytes: 10 * 1024 * 1024 })),
  }),
  accessService: () => ({
    canUser: vi.fn(),
    hasPermission: vi.fn(),
    decide: vi.fn(async (input: { action?: string }) => ({
      allowed: true,
      action: input.action,
      reason: "allow_explicit_grant",
      explanation: "Allowed by test grant.",
    })),
  }),
  agentService: () => ({
    getById: vi.fn(),
  }),
  documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
  documentService: () => ({
    getIssueDocumentPayload: vi.fn(async () => ({})),
  }),
  executionWorkspaceService: () => ({
    getById: vi.fn(),
  }),
  feedbackService: () => ({}),
  goalService: () => ({
    getById: vi.fn(),
    getDefaultCompanyGoal: vi.fn(),
  }),
  heartbeatService: () => ({
    wakeup: mockWakeup,
    reportRunActivity: vi.fn(async () => undefined),
  }),
  getIssueContinuationSummaryDocument: vi.fn(async () => null),
  instanceSettingsService: () => ({
    get: vi.fn(),
    listCompanyIds: vi.fn(),
  }),
  issueApprovalService: () => ({}),
  issueReferenceService: () => ({
    deleteDocumentSource: async () => undefined,
    diffIssueReferenceSummary: () => ({
      addedReferencedIssues: [],
      removedReferencedIssues: [],
      currentReferencedIssues: [],
    }),
    emptySummary: () => ({ outbound: [], inbound: [] }),
    listIssueReferenceSummary: async () => ({ outbound: [], inbound: [] }),
    syncComment: async () => undefined,
    syncDocument: async () => undefined,
    syncIssue: async () => undefined,
  }),
  issueRecoveryActionService: () => ({
    getActiveForIssue: vi.fn(async () => null),
    listActiveForIssues: vi.fn(async () => new Map()),
  }),
  issueThreadInteractionService: () => ({
    listForIssue: vi.fn(async () => []),
    expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
    expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
  }),
  issueService: () => mockIssueService,
  logActivity: vi.fn(async () => undefined),
  projectService: () => ({
    getById: vi.fn(),
    listByIds: vi.fn(async () => []),
  }),
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => ({
    listForIssue: vi.fn(async () => []),
  }),
}));

async function createApp(actorOverride?: Record<string, unknown>) {
  const [{ issueRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/issues.js")>("../routes/issues.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actorOverride ?? {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

describe("issue dependency wakeups in issue routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    vi.clearAllMocks();
    mockIssueService.getAncestors.mockResolvedValue([]);
    mockIssueService.getComment.mockResolvedValue(null);
    mockIssueService.getCommentCursor.mockResolvedValue({
      totalComments: 0,
      latestCommentId: null,
      latestCommentAt: null,
    });
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
  });

  it("wakes dependents when the final blocker transitions to done", async () => {
    mockIssueService.getById.mockResolvedValue({
      id: "issue-1",
      companyId: "company-1",
      identifier: "PAP-100",
      title: "Finish blocker",
      description: null,
      status: "blocked",
      priority: "medium",
      parentId: null,
      assigneeAgentId: "agent-1",
      assigneeUserId: null,
      createdByAgentId: null,
      createdByUserId: null,
      executionWorkspaceId: null,
      labels: [],
      labelIds: [],
    });
    mockIssueService.update.mockResolvedValue({
      id: "issue-1",
      companyId: "company-1",
      identifier: "PAP-100",
      title: "Finish blocker",
      description: null,
      status: "done",
      priority: "medium",
      parentId: null,
      assigneeAgentId: "agent-1",
      assigneeUserId: null,
      createdByAgentId: null,
      createdByUserId: null,
      executionWorkspaceId: null,
      labels: [],
      labelIds: [],
    });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([
      {
        id: "issue-2",
        assigneeAgentId: "agent-2",
        blockerIssueIds: ["issue-1", "issue-3"],
      },
    ]);

    const res = await request(await createApp()).patch("/api/issues/issue-1").send({ status: "done" });
    expect(res.status).toBe(200);
    await vi.waitFor(() => {
      expect(mockWakeup).toHaveBeenCalledWith(
        "agent-2",
        expect.objectContaining({
          reason: "issue_blockers_resolved",
          payload: expect.objectContaining({
            issueId: "issue-2",
            resolvedBlockerIssueId: "issue-1",
          }),
        }),
      );
    });
  });

  // BLO-13250: a single blocker completion woke exactly one of four sibling
  // dependents in production. Assert every dependent in a fan-out gets its
  // own wake — including two dependents that share the same assignee agent,
  // the shape most likely to collide if the wake dispatch coalesced by
  // agent instead of by (blocker, dependent) pair.
  it("wakes every dependent in a fan-out (N>=3, including two sharing an assignee) via REST PATCH", async () => {
    const blockerIssue = {
      id: "blocker-1",
      companyId: "company-1",
      identifier: "PAP-200",
      title: "Founder-GO canary gate",
      description: null,
      status: "in_progress",
      priority: "critical",
      parentId: null,
      assigneeAgentId: "gate-agent",
      assigneeUserId: null,
      createdByAgentId: null,
      createdByUserId: null,
      executionWorkspaceId: null,
      labels: [],
      labelIds: [],
    };
    mockIssueService.getById.mockResolvedValue(blockerIssue);
    mockIssueService.update.mockResolvedValue({ ...blockerIssue, status: "done" });

    const dependents = [
      { id: "dep-1", assigneeAgentId: "agent-a", blockerIssueIds: ["blocker-1"] },
      { id: "dep-2", assigneeAgentId: "agent-b", blockerIssueIds: ["blocker-1"] },
      // Shares assignee "agent-a" with dep-1 — the suspected collision shape.
      { id: "dep-3", assigneeAgentId: "agent-a", blockerIssueIds: ["blocker-1"] },
      { id: "dep-4", assigneeAgentId: "agent-c", blockerIssueIds: ["blocker-1"] },
    ];
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue(dependents);

    const res = await request(await createApp()).patch("/api/issues/blocker-1").send({ status: "done" });
    expect(res.status).toBe(200);

    await vi.waitFor(() => {
      expect(mockWakeup).toHaveBeenCalledTimes(dependents.length);
    });

    const idempotencyKeys = new Set<string>();
    for (const dependent of dependents) {
      const call = mockWakeup.mock.calls.find(([agentId, wakeup]) =>
        agentId === dependent.assigneeAgentId
        && (wakeup as { payload?: { issueId?: string } }).payload?.issueId === dependent.id);
      expect(call, `expected a wake for dependent ${dependent.id}`).toBeTruthy();
      const wakeup = call![1] as {
        reason: string;
        payload: { issueId: string; resolvedBlockerIssueId: string };
        idempotencyKey?: string | null;
      };
      expect(wakeup.reason).toBe("issue_blockers_resolved");
      expect(wakeup.payload.resolvedBlockerIssueId).toBe("blocker-1");
      // Idempotency key MUST include the dependent id so sibling dependents
      // of the same resolved blocker can never coalesce into one wake.
      expect(wakeup.idempotencyKey).toBe(`blockers_resolved:blocker-1:${dependent.id}`);
      idempotencyKeys.add(wakeup.idempotencyKey!);
    }
    // Every dependent's key is unique — none collided with a sibling's.
    expect(idempotencyKeys.size).toBe(dependents.length);
  });

  // Same fan-out, but the blocker is completed by its own assignee agent
  // (the "agent run-complete" path from the incident report) rather than an
  // operator/board actor, via the same PATCH /issues/:id endpoint agents use
  // to report completion.
  it("wakes every dependent in a fan-out when the blocker is completed by its assignee agent", async () => {
    const agentRunId = "77777777-7777-4777-8777-777777777777";
    const blockerIssue = {
      id: "blocker-2",
      companyId: "company-1",
      identifier: "PAP-201",
      title: "Founder-GO canary gate",
      description: null,
      status: "in_progress",
      priority: "critical",
      parentId: null,
      assigneeAgentId: "gate-agent",
      assigneeUserId: null,
      createdByAgentId: null,
      createdByUserId: null,
      executionWorkspaceId: null,
      // Matches the acting agent's runId below so
      // assertAgentIssueMutationAllowed's isCurrentIssueExecutionRun
      // fast-path applies (the agent completing its own checked-out run).
      checkoutRunId: agentRunId,
      executionRunId: agentRunId,
      labels: [],
      labelIds: [],
    };
    mockIssueService.getById.mockResolvedValue(blockerIssue);
    mockIssueService.update.mockResolvedValue({ ...blockerIssue, status: "done" });

    const dependents = [
      { id: "dep-5", assigneeAgentId: "agent-d", blockerIssueIds: ["blocker-2"] },
      { id: "dep-6", assigneeAgentId: "agent-d", blockerIssueIds: ["blocker-2"] },
      { id: "dep-7", assigneeAgentId: "agent-e", blockerIssueIds: ["blocker-2"] },
    ];
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue(dependents);

    const agentActor = {
      type: "agent",
      agentId: "gate-agent",
      companyId: "company-1",
      source: "agent_key",
      runId: agentRunId,
    };

    const res = await request(await createApp(agentActor))
      .patch("/api/issues/blocker-2")
      .send({ status: "done" });
    if (res.status !== 200) console.error("DEBUG res.body", res.body);
    expect(res.status).toBe(200);

    await vi.waitFor(() => {
      expect(mockWakeup).toHaveBeenCalledTimes(dependents.length);
    });
    for (const dependent of dependents) {
      expect(mockWakeup).toHaveBeenCalledWith(
        dependent.assigneeAgentId,
        expect.objectContaining({
          reason: "issue_blockers_resolved",
          payload: expect.objectContaining({ issueId: dependent.id, resolvedBlockerIssueId: "blocker-2" }),
          idempotencyKey: `blockers_resolved:blocker-2:${dependent.id}`,
        }),
      );
    }
  });

  it("wakes the parent when all direct children become terminal", async () => {
    mockIssueService.getById.mockResolvedValue({
      id: "child-1",
      companyId: "company-1",
      identifier: "PAP-101",
      title: "Last child",
      description: null,
      status: "in_progress",
      priority: "medium",
      parentId: "parent-1",
      assigneeAgentId: "agent-1",
      assigneeUserId: null,
      createdByAgentId: null,
      createdByUserId: null,
      executionWorkspaceId: null,
      labels: [],
      labelIds: [],
    });
    mockIssueService.update.mockResolvedValue({
      id: "child-1",
      companyId: "company-1",
      identifier: "PAP-101",
      title: "Last child",
      description: null,
      status: "done",
      priority: "medium",
      parentId: "parent-1",
      assigneeAgentId: "agent-1",
      assigneeUserId: null,
      createdByAgentId: null,
      createdByUserId: null,
      executionWorkspaceId: null,
      labels: [],
      labelIds: [],
    });
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue({
      id: "parent-1",
      assigneeAgentId: "agent-9",
      childIssueIds: ["child-0", "child-1"],
      childIssueSummaries: [
        {
          id: "child-0",
          identifier: "PAP-100",
          title: "First child",
          status: "done",
          priority: "medium",
          assigneeAgentId: "agent-1",
          assigneeUserId: null,
          updatedAt: new Date("2026-04-18T12:00:00.000Z"),
          summary: "First child finished.",
        },
        {
          id: "child-1",
          identifier: "PAP-101",
          title: "Last child",
          status: "done",
          priority: "medium",
          assigneeAgentId: "agent-1",
          assigneeUserId: null,
          updatedAt: new Date("2026-04-18T12:05:00.000Z"),
          summary: "Last child finished.",
        },
      ],
      childIssueSummaryTruncated: false,
    });

    const res = await request(await createApp()).patch("/api/issues/child-1").send({ status: "done" });
    expect(res.status).toBe(200);
    await vi.waitFor(() => {
      expect(mockWakeup).toHaveBeenCalledWith(
        "agent-9",
        expect.objectContaining({
          reason: "issue_children_completed",
          payload: expect.objectContaining({
            issueId: "parent-1",
            completedChildIssueId: "child-1",
            childIssueSummaries: expect.arrayContaining([
              expect.objectContaining({ identifier: "PAP-101", summary: "Last child finished." }),
            ]),
          }),
          contextSnapshot: expect.objectContaining({
            childIssueSummaries: expect.arrayContaining([
              expect.objectContaining({ identifier: "PAP-100", summary: "First child finished." }),
            ]),
          }),
        }),
      );
    });
  });
});
