import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockWakeup = vi.hoisted(() => vi.fn(async () => undefined));
const mockFindExistingIssueBlockersResolvedWake = vi.hoisted(() => vi.fn(async () => null));
const mockListBlockedDependentIssueIds = vi.hoisted(() => vi.fn(async () => []));
const mockRecomputeBlockedIssuesStatusIfReady = vi.hoisted(() => vi.fn(async () => []));
const mockIssueService = vi.hoisted(() => ({
  getAncestors: vi.fn(),
  getById: vi.fn(),
  getByIdentifier: vi.fn(async () => null),
  getComment: vi.fn(),
  getCommentCursor: vi.fn(),
  getRelationSummaries: vi.fn(),
  update: vi.fn(),
  addComment: vi.fn(),
  getDependencyReadiness: vi.fn(),
  getCurrentScheduledRetry: vi.fn(async () => null),
  listWakeableBlockedDependents: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
  findMentionedAgents: vi.fn(async () => []),
}));

// The POST /issues/:id/comments auto-approval path persists the comment and the
// status transition in one `db.transaction`, so that route needs a db that can
// actually run the executor (the PATCH tests below are happy with `{}`).
const mockTxInsertValues = vi.hoisted(() => vi.fn(async () => undefined));
const mockTx = vi.hoisted(() => ({
  insert: vi.fn(() => ({ values: mockTxInsertValues })),
  execute: vi.fn(async () => undefined),
  select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(async () => []) })) })),
}));
const mockDb = vi.hoisted(() => ({
  select: mockTx.select,
  transaction: vi.fn(async (fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx)),
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
  companySkillService: () => ({
    completeTestRunForIssue: vi.fn(async () => null),
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

vi.mock("../services/issue-dependency-wakeups.js", async () => {
  const actual = await vi.importActual<typeof import("../services/issue-dependency-wakeups.js")>(
    "../services/issue-dependency-wakeups.js",
  );
  return {
    ...actual,
    findExistingIssueBlockersResolvedWake: mockFindExistingIssueBlockersResolvedWake,
  };
});

// BLO-21523 phase 2: routes/issues.ts calls these two directly against the
// real `db` (not through the mocked issueService above), so this suite stubs
// them and asserts on them as the observable edge of the eager-recompute
// fan-out — see "hands every blocked dependent to the status recompute…"
// below for the POST /comments path and the PATCH cases above it. Stubbing is
// also load-bearing: the PATCH tests pass a fake db, so leaving these
// un-mocked would throw inside the fire-and-forget wake dispatch block.
vi.mock("../services/issues.js", async () => {
  const actual = await vi.importActual<typeof import("../services/issues.js")>("../services/issues.js");
  return {
    ...actual,
    listBlockedDependentIssueIds: mockListBlockedDependentIssueIds,
    recomputeBlockedIssuesStatusIfReady: mockRecomputeBlockedIssuesStatusIfReady,
  };
});

async function createApp(opts: { db?: unknown; actor?: Record<string, unknown> } = {}) {
  const [{ issueRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/issues.js")>("../routes/issues.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = opts.actor ?? {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", issueRoutes((opts.db ?? {}) as any, {} as any));
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
    mockFindExistingIssueBlockersResolvedWake.mockResolvedValue(null);
    mockListBlockedDependentIssueIds.mockResolvedValue([]);
    mockRecomputeBlockedIssuesStatusIfReady.mockResolvedValue([]);
    mockIssueService.getAncestors.mockResolvedValue([]);
    mockIssueService.getComment.mockResolvedValue(null);
    mockIssueService.getCommentCursor.mockResolvedValue({
      totalComments: 0,
      latestCommentId: null,
      latestCommentAt: null,
    });
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.getDependencyReadiness.mockResolvedValue({
      issueId: "issue-1",
      blockerIssueIds: [],
      unresolvedBlockerIssueIds: [],
      unresolvedBlockerCount: 0,
      pendingFinalizeBlockerIssueIds: [],
      allBlockersDone: true,
      isDependencyReady: true,
    });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockIssueService.getCurrentScheduledRetry.mockResolvedValue(null);
    mockDb.transaction.mockImplementation(async (fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx));
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
    expect(res.status, JSON.stringify(res.body)).toBe(200);
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

  // BLO-21523 phase 2. The PATCH /issues/:id blocker-close path is covered
  // above; this is the *other* way an issue reaches `done` — an approval-shaped
  // comment resolving a pending execution-policy review stage. That route has
  // its own becameDone fan-out, and it is the one an agent reviewer actually
  // takes, so it needs its own assertion rather than inheriting confidence
  // from the PATCH case.
  it("hands every blocked dependent to the status recompute when a comment closes the blocker", async () => {
    const { normalizeIssueExecutionPolicy } = await vi.importActual<
      typeof import("../services/issue-execution-policy.js")
    >("../services/issue-execution-policy.js");
    const reviewerAgentId = "33333333-3333-4333-8333-333333333333";
    const blockerIssueId = "11111111-1111-4111-8111-111111111111";
    const policy = normalizeIssueExecutionPolicy({
      stages: [
        {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          type: "review",
          participants: [{ type: "agent", agentId: reviewerAgentId }],
        },
      ],
    })!;
    const blocker = {
      id: blockerIssueId,
      companyId: "company-1",
      identifier: "PAP-300",
      title: "Blocker under review",
      description: null,
      status: "in_review",
      priority: "medium",
      parentId: null,
      assigneeAgentId: reviewerAgentId,
      assigneeUserId: null,
      createdByAgentId: null,
      createdByUserId: null,
      executionWorkspaceId: null,
      labels: [],
      labelIds: [],
      executionPolicy: policy,
      executionState: {
        status: "pending",
        currentStageId: policy.stages[0].id,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: reviewerAgentId },
        returnAssignee: { type: "agent", agentId: "22222222-2222-4222-8222-222222222222" },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    };
    const reviewBody = "## Review: PAP-300 - APPROVED\n\nShip it.";
    mockIssueService.getById.mockResolvedValue(blocker);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-review-1",
      issueId: blocker.id,
      companyId: blocker.companyId,
      body: reviewBody,
      createdAt: new Date(),
      updatedAt: new Date(),
      authorAgentId: reviewerAgentId,
      authorUserId: null,
    });
    mockIssueService.update.mockImplementation(
      async (_id: string, patch: Record<string, unknown>) => ({
        ...blocker,
        ...patch,
        status: "done",
      }),
    );
    // The unassigned dependent is the point: no wake ever targets it, so the
    // recompute is the only thing that can make it dispatchable again.
    mockListBlockedDependentIssueIds.mockResolvedValue(["dependent-assigned", "dependent-unassigned"]);
    mockRecomputeBlockedIssuesStatusIfReady.mockResolvedValue(["dependent-unassigned"]);

    const res = await request(
      await createApp({
        db: mockDb,
        actor: {
          type: "agent",
          agentId: reviewerAgentId,
          companyId: "company-1",
          source: "agent_key",
          runId: "run-review-1",
        },
      }),
    )
      .post(`/api/issues/${blockerIssueId}/comments`)
      .send({ body: reviewBody });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    // This fan-out is awaited before the response is sent, so unlike the PATCH
    // route's fire-and-forget dispatch these need no vi.waitFor. Asserting
    // synchronously is what pins that difference in place.
    expect(mockListBlockedDependentIssueIds).toHaveBeenCalledWith(mockDb, "company-1", blockerIssueId);
    expect(mockRecomputeBlockedIssuesStatusIfReady).toHaveBeenCalledWith(
      mockDb,
      "company-1",
      ["dependent-assigned", "dependent-unassigned"],
      { triggerPath: "eager_status_recompute" },
    );
  });

  it("does not recompute dependents when a comment leaves the blocker open", async () => {
    mockIssueService.getById.mockResolvedValue({
      id: "issue-1",
      companyId: "company-1",
      identifier: "PAP-301",
      title: "Still open",
      description: null,
      status: "in_progress",
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
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-plain-1",
      issueId: "issue-1",
      companyId: "company-1",
      body: "Just a progress note.",
      createdAt: new Date(),
      updatedAt: new Date(),
      authorAgentId: "agent-1",
      authorUserId: null,
    });

    const res = await request(
      await createApp({
        db: mockDb,
        actor: {
          type: "agent",
          agentId: "agent-1",
          companyId: "company-1",
          source: "agent_key",
          runId: "run-plain-1",
        },
      }),
    )
      .post("/api/issues/issue-1/comments")
      .send({ body: "Just a progress note." });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockListBlockedDependentIssueIds).not.toHaveBeenCalled();
    expect(mockRecomputeBlockedIssuesStatusIfReady).not.toHaveBeenCalled();
  });

  it("wakes an assigned blocked issue when blockers are applied after the blocker is already done", async () => {
    const parentIssueId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const childIssueId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    mockIssueService.getById.mockResolvedValue({
      id: parentIssueId,
      companyId: "company-1",
      identifier: "PAP-200",
      title: "Blocked after completion",
      description: null,
      status: "todo",
      priority: "medium",
      parentId: null,
      assigneeAgentId: "agent-2",
      assigneeUserId: null,
      createdByAgentId: null,
      createdByUserId: null,
      executionWorkspaceId: null,
      labels: [],
      labelIds: [],
    });
    mockIssueService.update.mockResolvedValue({
      id: parentIssueId,
      companyId: "company-1",
      identifier: "PAP-200",
      title: "Blocked after completion",
      description: null,
      status: "blocked",
      priority: "medium",
      parentId: null,
      assigneeAgentId: "agent-2",
      assigneeUserId: null,
      createdByAgentId: null,
      createdByUserId: null,
      executionWorkspaceId: null,
      labels: [],
      labelIds: [],
    });
    mockIssueService.getDependencyReadiness.mockResolvedValue({
      issueId: parentIssueId,
      blockerIssueIds: [childIssueId],
      unresolvedBlockerIssueIds: [],
      unresolvedBlockerCount: 0,
      pendingFinalizeBlockerIssueIds: [],
      allBlockersDone: true,
      isDependencyReady: true,
    });

    const res = await request(await createApp())
      .patch(`/api/issues/${parentIssueId}`)
      .send({ status: "blocked", blockedByIssueIds: [childIssueId] });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    await vi.waitFor(() => {
      expect(mockWakeup).toHaveBeenCalledWith(
        "agent-2",
        expect.objectContaining({
          reason: "issue_blockers_resolved",
          payload: expect.objectContaining({
            issueId: parentIssueId,
            resolvedBlockerIssueId: childIssueId,
            mutation: "blocked_dependency_restored",
          }),
          contextSnapshot: expect.objectContaining({
            source: "issue.blockers_restored",
          }),
        }),
      );
    });
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
    expect(res.status, JSON.stringify(res.body)).toBe(200);
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
