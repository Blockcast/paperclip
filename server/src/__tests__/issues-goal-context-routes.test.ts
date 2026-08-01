import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  getAncestors: vi.fn(),
  getRelationSummaries: vi.fn(),
  findMentionedProjectIds: vi.fn(),
  getCommentCursor: vi.fn(),
  getComment: vi.fn(),
  listBlockerAttention: vi.fn(),
  listProductivityReviews: vi.fn(),
  getCurrentScheduledRetry: vi.fn(),
  getActiveInboxArchiveFields: vi.fn(),
  getActiveRun: vi.fn(),
  listAttachments: vi.fn(),
}));

const mockProjectService = vi.hoisted(() => ({
  getById: vi.fn(),
  listByIds: vi.fn(),
}));

const mockGoalService = vi.hoisted(() => ({
  getById: vi.fn(),
  getDefaultCompanyGoal: vi.fn(),
}));

const mockDocumentsService = vi.hoisted(() => ({
  getIssueDocumentPayload: vi.fn(),
  getIssueDocumentByKey: vi.fn(),
}));

const mockExecutionWorkspaceService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  decide: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockFeedbackService = vi.hoisted(() => ({
  listIssueVotesForUser: vi.fn(async () => []),
  saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
}));

const mockIssueRecoveryActionService = vi.hoisted(() => ({
  getActiveForIssue: vi.fn(async () => null),
  listActiveForIssues: vi.fn(async () => new Map()),
}));

const mockInstanceSettingsService = vi.hoisted(() => ({
  get: vi.fn(async () => ({
    id: "instance-settings-1",
    general: {
      censorUsernameInLogs: false,
      feedbackDataSharingPreference: "prompt",
    },
  })),
  listCompanyIds: vi.fn(async () => ["company-1"]),
}));

const mockIssueReferenceService = vi.hoisted(() => ({
  deleteDocumentSource: vi.fn(async () => undefined),
  diffIssueReferenceSummary: vi.fn(() => ({
    addedReferencedIssues: [],
    removedReferencedIssues: [],
    currentReferencedIssues: [],
  })),
  emptySummary: vi.fn(() => ({ outbound: [], inbound: [] })),
  listIssueReferenceSummary: vi.fn(async () => ({ outbound: [], inbound: [] })),
  syncComment: vi.fn(async () => undefined),
  syncDocument: vi.fn(async () => undefined),
  syncIssue: vi.fn(async () => undefined),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

const mockRoutineService = vi.hoisted(() => ({
  syncRunStatusForIssue: vi.fn(async () => undefined),
}));

const mockWorkProductService = vi.hoisted(() => ({
  listForIssue: vi.fn(async () => []),
}));

const mockEnvironmentService = vi.hoisted(() => ({}));

const mockDb = vi.hoisted(() => ({
  select: vi.fn(),
  execute: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  companyService: () => ({
    getById: vi.fn(async () => ({ id: "company-1", attachmentMaxBytes: 10 * 1024 * 1024 })),
  }),
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  companySkillService: () => ({
    completeTestRunForIssue: vi.fn(async () => null),
  }),
  documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
  documentService: () => mockDocumentsService,
  environmentService: () => mockEnvironmentService,
  executionWorkspaceService: () => mockExecutionWorkspaceService,
  feedbackService: () => mockFeedbackService,
  goalService: () => mockGoalService,
  heartbeatService: () => mockHeartbeatService,
  instanceSettingsService: () => mockInstanceSettingsService,
  issueApprovalService: () => ({}),
  issueRecoveryActionService: () => mockIssueRecoveryActionService,
  issueThreadInteractionService: () => ({
    listForIssue: vi.fn(async () => []),
    expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
    expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
  }),
  issueReferenceService: () => mockIssueReferenceService,
  issueService: () => mockIssueService,
  logActivity: mockLogActivity,
  projectService: () => mockProjectService,
  routineService: () => mockRoutineService,
  workProductService: () => mockWorkProductService,
}));

vi.mock("../services/execution-workspaces.js", () => ({
  executionWorkspaceService: () => mockExecutionWorkspaceService,
}));

function createApp(actor?: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor ?? {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", issueRoutes(mockDb as any, {} as any));
  app.use(errorHandler);
  return app;
}

const legacyProjectLinkedIssue = {
  id: "11111111-1111-4111-8111-111111111111",
  companyId: "company-1",
  identifier: "PAP-581",
  title: "Legacy onboarding task",
  description: "Seed the first CEO task",
  status: "todo",
  workMode: "planning",
  priority: "medium",
  projectId: "22222222-2222-4222-8222-222222222222",
  goalId: null,
  parentId: null,
  assigneeAgentId: "33333333-3333-4333-8333-333333333333",
  assigneeUserId: null,
  updatedAt: new Date("2026-03-24T12:00:00Z"),
  executionWorkspaceId: null,
  labels: [],
  labelIds: [],
};

const projectGoal = {
  id: "44444444-4444-4444-8444-444444444444",
  companyId: "company-1",
  title: "Launch the company",
  description: null,
  level: "company",
  status: "active",
  parentId: null,
  ownerAgentId: null,
  createdAt: new Date("2026-03-20T00:00:00Z"),
  updatedAt: new Date("2026-03-20T00:00:00Z"),
};

describe.sequential("issue goal context routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      action: "issue:read",
      reason: "allow_test",
      explanation: "Allowed by test mock.",
    });
    mockIssueService.getById.mockResolvedValue(legacyProjectLinkedIssue);
    mockIssueService.getAncestors.mockResolvedValue([]);
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.findMentionedProjectIds.mockResolvedValue([]);
    mockIssueService.getCommentCursor.mockResolvedValue({
      totalComments: 0,
      latestCommentId: null,
      latestCommentAt: null,
    });
    mockIssueService.getComment.mockResolvedValue(null);
    mockIssueService.listBlockerAttention.mockResolvedValue(new Map());
    mockIssueService.listProductivityReviews.mockResolvedValue(new Map());
    mockIssueService.getCurrentScheduledRetry.mockResolvedValue(null);
    mockIssueService.getActiveInboxArchiveFields.mockResolvedValue({});
    mockIssueService.getActiveRun.mockResolvedValue(null);
    mockIssueService.listAttachments.mockResolvedValue([]);
    mockIssueRecoveryActionService.getActiveForIssue.mockResolvedValue(null);
    mockIssueRecoveryActionService.listActiveForIssues.mockResolvedValue(new Map());
    mockDocumentsService.getIssueDocumentPayload.mockResolvedValue({});
    mockDocumentsService.getIssueDocumentByKey.mockResolvedValue(null);
    mockExecutionWorkspaceService.getById.mockResolvedValue(null);
    const emptyQuery: any = {};
    emptyQuery.from = vi.fn(() => emptyQuery);
    emptyQuery.innerJoin = vi.fn(() => emptyQuery);
    emptyQuery.where = vi.fn(() => emptyQuery);
    emptyQuery.orderBy = vi.fn(() => emptyQuery);
    emptyQuery.limit = vi.fn(async () => []);
    emptyQuery.then = (resolve: (rows: unknown[]) => unknown, reject?: (error: unknown) => unknown) =>
      Promise.resolve([]).then(resolve, reject);
    mockDb.select.mockReturnValue(emptyQuery);
    mockDb.execute.mockResolvedValue([]);
    mockProjectService.getById.mockResolvedValue({
      id: legacyProjectLinkedIssue.projectId,
      companyId: "company-1",
      urlKey: "onboarding",
      goalId: projectGoal.id,
      goalIds: [projectGoal.id],
      goals: [{ id: projectGoal.id, title: projectGoal.title }],
      name: "Onboarding",
      description: null,
      status: "in_progress",
      leadAgentId: null,
      targetDate: null,
      color: null,
      pauseReason: null,
      pausedAt: null,
      executionWorkspacePolicy: null,
      codebase: {
        workspaceId: null,
        repoUrl: null,
        repoRef: null,
        defaultRef: null,
        repoName: null,
        localFolder: null,
        managedFolder: "/tmp/company-1/project-1",
        effectiveLocalFolder: "/tmp/company-1/project-1",
        origin: "managed_checkout",
      },
      workspaces: [],
      primaryWorkspace: null,
      archivedAt: null,
      createdAt: new Date("2026-03-20T00:00:00Z"),
      updatedAt: new Date("2026-03-20T00:00:00Z"),
    });
    mockProjectService.listByIds.mockResolvedValue([]);
    mockGoalService.getById.mockImplementation(async (id: string) =>
      id === projectGoal.id ? projectGoal : null,
    );
    mockGoalService.getDefaultCompanyGoal.mockResolvedValue(null);
  });

  it("surfaces the project goal from GET /issues/:id when the issue has no direct goal", async () => {
    const res = await request(createApp()).get("/api/issues/11111111-1111-4111-8111-111111111111");

    expect(res.status).toBe(200);
    expect(res.body.goalId).toBe(projectGoal.id);
    expect(res.body.goal).toEqual(
      expect.objectContaining({
        id: projectGoal.id,
        title: projectGoal.title,
      }),
    );
    expect(mockIssueService.findMentionedProjectIds).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      { includeCommentBodies: false },
    );
    expect(mockGoalService.getDefaultCompanyGoal).not.toHaveBeenCalled();
  });

  it("keeps GET /issues/:id project and workspace embeds compact for fast detail loads", async () => {
    const workspaceId = "55555555-5555-4555-8555-555555555555";
    const runtimeServiceBase = {
      companyId: "company-1",
      projectId: legacyProjectLinkedIssue.projectId,
      projectWorkspaceId: "workspace-primary",
      executionWorkspaceId: workspaceId,
      issueId: legacyProjectLinkedIssue.id,
      scopeType: "execution_workspace",
      scopeId: workspaceId,
      serviceName: "Dev server",
      lifecycle: "shared",
      reuseKey: "dev-server",
      command: "pnpm dev",
      cwd: "/tmp/company-1/project-1",
      port: 3100,
      url: "http://localhost:3100",
      provider: "local_process",
      providerRef: "pid:123",
      ownerAgentId: null,
      startedByRunId: null,
      lastUsedAt: new Date("2026-03-24T12:00:00Z"),
      startedAt: new Date("2026-03-24T12:00:00Z"),
      stoppedAt: null,
      healthStatus: "healthy",
      configIndex: 0,
      metadata: { huge: "runtime metadata should not be embedded" },
    };
    mockIssueService.getById.mockResolvedValueOnce({
      ...legacyProjectLinkedIssue,
      executionWorkspaceId: workspaceId,
    });
    mockProjectService.getById.mockResolvedValueOnce({
      ...(await mockProjectService.getById()),
      env: { API_KEY: { type: "plain", value: "should-not-ship" } },
      workspaces: [
        {
          id: "workspace-primary",
          companyId: "company-1",
          projectId: legacyProjectLinkedIssue.projectId,
          name: "Main",
          sourceType: "local_path",
          cwd: "/tmp/company-1/project-1",
          repoUrl: null,
          repoRef: "master",
          defaultRef: "master",
          visibility: "default",
          setupCommand: null,
          cleanupCommand: null,
          remoteProvider: null,
          remoteWorkspaceRef: null,
          sharedWorkspaceKey: null,
          metadata: { huge: "project workspace metadata should not be embedded" },
          runtimeConfig: { services: [{ name: "Dev server", command: "pnpm dev" }] },
          runtimeServices: [{ ...runtimeServiceBase, id: "project-service-stopped", status: "stopped" }],
          isPrimary: true,
          createdAt: new Date("2026-03-20T00:00:00Z"),
          updatedAt: new Date("2026-03-20T00:00:00Z"),
        },
      ],
      primaryWorkspace: {
        id: "workspace-primary",
        companyId: "company-1",
        projectId: legacyProjectLinkedIssue.projectId,
        name: "Main",
        sourceType: "local_path",
        cwd: "/tmp/company-1/project-1",
        repoUrl: null,
        repoRef: "master",
        defaultRef: "master",
        visibility: "default",
        setupCommand: null,
        cleanupCommand: null,
        remoteProvider: null,
        remoteWorkspaceRef: null,
        sharedWorkspaceKey: null,
        metadata: { huge: "primary workspace metadata should not be embedded" },
        runtimeConfig: { services: [{ name: "Dev server", command: "pnpm dev" }] },
        runtimeServices: [{ ...runtimeServiceBase, id: "primary-service-stopped", status: "stopped" }],
        isPrimary: true,
        createdAt: new Date("2026-03-20T00:00:00Z"),
        updatedAt: new Date("2026-03-20T00:00:00Z"),
      },
    });
    mockExecutionWorkspaceService.getById.mockResolvedValue({
      id: workspaceId,
      companyId: "company-1",
      projectId: legacyProjectLinkedIssue.projectId,
      projectWorkspaceId: "workspace-primary",
      sourceIssueId: legacyProjectLinkedIssue.id,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "PAP-581-workspace",
      status: "active",
      cwd: "/tmp/company-1/project-1",
      repoUrl: null,
      baseRef: "master",
      branchName: "PAP-581-workspace",
      providerType: "local",
      providerRef: "/tmp/company-1/project-1",
      derivedFromExecutionWorkspaceId: null,
      lastUsedAt: new Date("2026-03-24T12:00:00Z"),
      openedAt: new Date("2026-03-24T12:00:00Z"),
      closedAt: null,
      cleanupEligibleAt: null,
      cleanupReason: null,
      config: {
        environmentId: "env-1",
        provisionCommand: "bash setup.sh",
        teardownCommand: null,
        cleanupCommand: null,
        workspaceRuntime: { services: [{ name: "Dev server", command: "pnpm dev" }] },
        desiredState: null,
        serviceStates: null,
      },
      metadata: { huge: "execution workspace metadata should not be embedded" },
      runtimeServices: [
        { ...runtimeServiceBase, id: "service-running", status: "running" },
        { ...runtimeServiceBase, id: "service-stopped", status: "stopped" },
      ],
      createdAt: new Date("2026-03-24T12:00:00Z"),
      updatedAt: new Date("2026-03-24T12:00:00Z"),
    });

    const res = await request(createApp()).get("/api/issues/11111111-1111-4111-8111-111111111111");

    expect(res.status).toBe(200);
    expect(res.body.project.env).toBeNull();
    expect(res.body.project.workspaces[0]).not.toHaveProperty("metadata");
    expect(res.body.project.workspaces[0]).not.toHaveProperty("runtimeServices");
    expect(res.body.project.primaryWorkspace).not.toHaveProperty("metadata");
    expect(res.body.project.primaryWorkspace).not.toHaveProperty("runtimeServices");
    expect(res.body.currentExecutionWorkspace.metadata).toBeNull();
    expect(res.body.currentExecutionWorkspace.runtimeServices).toHaveLength(1);
    expect(res.body.currentExecutionWorkspace.runtimeServices[0]).toMatchObject({
      id: "service-running",
      status: "running",
      url: "http://localhost:3100",
    });
    expect(res.body.currentExecutionWorkspace.runtimeServices[0]).not.toHaveProperty("metadata");
  });

  it("surfaces the project goal from GET /issues/:id/heartbeat-context", async () => {
    const res = await request(createApp()).get(
      "/api/issues/11111111-1111-4111-8111-111111111111/heartbeat-context",
    );

    expect(res.status).toBe(200);
    expect(res.body.issue.goalId).toBe(projectGoal.id);
    expect(res.body.issue.workMode).toBe("planning");
    expect(res.body.goal).toEqual(
      expect.objectContaining({
        id: projectGoal.id,
        title: projectGoal.title,
      }),
    );
    expect(mockGoalService.getDefaultCompanyGoal).not.toHaveBeenCalled();
    expect(res.body.attachments).toEqual([]);
  });

  // BLO-19087: the mention wake tells an agent to read this thread and the
  // heartbeat procedure tells it to "respond in comments if useful" — but on an
  // issue assigned to someone else that reply is a 403. heartbeat-context is
  // read at the start of the woken run, so it is the last honest moment to say
  // so before the agent spends a call finding out.
  describe("replyAuthorization (BLO-19087)", () => {
    const mentionedAgentId = "99999999-9999-4999-8999-999999999999";
    const assigneeAgentId = "33333333-3333-4333-8333-333333333333";

    function agentActor(agentId: string, runId: string | null = "run-1") {
      return { type: "agent", agentId, companyId: "company-1", source: "agent_key", runId };
    }

    it("warns a woken non-assignee agent that it cannot reply, and where to go", async () => {
      mockAccessService.decide.mockImplementation(async (input: { action: string }) => ({
        allowed: input.action === "issue:read",
        action: input.action,
        reason: input.action === "issue:read" ? "allow_test" : "deny_missing_grant",
        explanation: "Test.",
      }));

      const res = await request(createApp(agentActor(mentionedAgentId))).get(
        "/api/issues/11111111-1111-4111-8111-111111111111/heartbeat-context",
      );

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.replyAuthorization).toMatchObject({
        canComment: false,
        reason: "deny_missing_grant",
        boundary: "grant",
      });
      expect(res.body.replyAuthorization.remediation).toContain(`agent://${assigneeAgentId}`);
      expect(res.body.replyAuthorization.remediation).toContain(`agent://${mentionedAgentId}`);
    });

    // The advertised verdict must come from the same decision the comment route
    // enforces with — a re-derived copy is exactly how the wake/grant split
    // arose. Assert it reports allow when the authorizer allows.
    it("reports canComment when the authorizer allows the comment", async () => {
      mockAccessService.decide.mockResolvedValue({
        allowed: true,
        action: "issue:comment",
        reason: "allow_issue_mention_grant",
        explanation: "Allowed by a mention-scoped issue comment grant.",
      });

      const res = await request(createApp(agentActor(mentionedAgentId))).get(
        "/api/issues/11111111-1111-4111-8111-111111111111/heartbeat-context",
      );

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.replyAuthorization).toMatchObject({ canComment: true, remediation: null });
    });

    it("reports canComment for an active source-scoped recovery owner", async () => {
      mockAccessService.decide.mockImplementation(async (input: { action: string }) => ({
        allowed: input.action === "issue:read",
        action: input.action,
        reason: input.action === "issue:read" ? "allow_test" : "deny_missing_grant",
        explanation: "Test.",
      }));
      mockIssueRecoveryActionService.getActiveForIssue.mockResolvedValue({
        ownerAgentId: mentionedAgentId,
      });

      const res = await request(createApp(agentActor(mentionedAgentId))).get(
        "/api/issues/11111111-1111-4111-8111-111111111111/heartbeat-context",
      );

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.replyAuthorization).toMatchObject({
        canComment: true,
        reason: "allow_source_scoped_recovery_owner",
        remediation: null,
      });
    });

    it("reports canComment for the current execution run without a comment grant", async () => {
      mockIssueService.getById.mockResolvedValue({
        ...legacyProjectLinkedIssue,
        status: "in_progress",
        assigneeAgentId,
        checkoutRunId: "run-1",
      });
      mockAccessService.decide.mockImplementation(async (input: { action: string }) => ({
        allowed: input.action === "issue:read",
        action: input.action,
        reason: input.action === "issue:read" ? "allow_test" : "deny_missing_grant",
        explanation: "Test.",
      }));

      const res = await request(createApp(agentActor(assigneeAgentId))).get(
        "/api/issues/11111111-1111-4111-8111-111111111111/heartbeat-context",
      );

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.replyAuthorization).toMatchObject({
        canComment: true,
        reason: "allow_current_issue_execution_run",
        remediation: null,
      });
      expect(mockAccessService.decide).not.toHaveBeenCalledWith(expect.objectContaining({ action: "issue:comment" }));
    });

    it("reports the same missing run id denial enforced by comment writes", async () => {
      mockIssueService.getById.mockResolvedValue({
        ...legacyProjectLinkedIssue,
        status: "in_progress",
        assigneeAgentId,
      });
      mockAccessService.decide.mockImplementation(async (input: { action: string }) => ({
        allowed: true,
        action: input.action,
        reason: input.action === "issue:comment" ? "allow_explicit_grant" : "allow_test",
        explanation: "Test.",
      }));

      const res = await request(createApp(agentActor(assigneeAgentId, null))).get(
        "/api/issues/11111111-1111-4111-8111-111111111111/heartbeat-context",
      );

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.replyAuthorization).toMatchObject({
        canComment: false,
        reason: "deny_missing_run_id",
        boundary: "run",
      });
      expect(res.body.replyAuthorization.remediation).toContain("active agent run id");
    });

    it("omits replyAuthorization for board actors, who are not wake targets", async () => {
      const res = await request(createApp()).get(
        "/api/issues/11111111-1111-4111-8111-111111111111/heartbeat-context",
      );

      expect(res.status).toBe(200);
      expect(res.body.replyAuthorization).toBeNull();
    });
  });

  it("preserves direct continuation summary lookup in GET /issues/:id/heartbeat-context", async () => {
    mockDocumentsService.getIssueDocumentByKey.mockResolvedValue({
      key: "continuation-summary",
      title: "Continuation Summary",
      body: "# Handoff",
      latestRevisionId: "revision-1",
      latestRevisionNumber: 1,
      updatedAt: new Date("2026-04-19T12:00:00.000Z"),
    });

    const res = await request(createApp()).get(
      "/api/issues/11111111-1111-4111-8111-111111111111/heartbeat-context",
    );

    expect(res.status).toBe(200);
    expect(mockDocumentsService.getIssueDocumentByKey).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      "continuation-summary",
    );
    expect(res.body.continuationSummary).toEqual(expect.objectContaining({
      key: "continuation-summary",
      body: "# Handoff",
    }));
  });

  it("surfaces blocker summaries on GET /issues/:id/heartbeat-context", async () => {
    mockIssueService.getRelationSummaries.mockResolvedValue({
      blockedBy: [
        {
          id: "55555555-5555-4555-8555-555555555555",
          identifier: "PAP-580",
          title: "Finish wakeup plumbing",
          status: "done",
          priority: "medium",
          assigneeAgentId: null,
          assigneeUserId: null,
        },
      ],
      blocks: [],
    });

    const res = await request(createApp()).get(
      "/api/issues/11111111-1111-4111-8111-111111111111/heartbeat-context",
    );

    expect(res.status).toBe(200);
    expect(res.body.issue.blockedBy).toEqual([
      expect.objectContaining({
        id: "55555555-5555-4555-8555-555555555555",
        identifier: "PAP-580",
      }),
    ]);
  });

  it("surfaces the current execution workspace from GET /issues/:id/heartbeat-context", async () => {
    mockIssueService.getById.mockResolvedValue({
      ...legacyProjectLinkedIssue,
      executionWorkspaceId: "55555555-5555-4555-8555-555555555555",
    });
    mockExecutionWorkspaceService.getById.mockResolvedValue({
      id: "55555555-5555-4555-8555-555555555555",
      name: "PAP-581 workspace",
      mode: "isolated_workspace",
      status: "active",
      cwd: "/tmp/pap-581",
      runtimeServices: [
        {
          id: "service-1",
          serviceName: "web",
          status: "running",
          url: "http://127.0.0.1:5173",
          healthStatus: "healthy",
        },
      ],
    });

    const res = await request(createApp()).get(
      "/api/issues/11111111-1111-4111-8111-111111111111/heartbeat-context",
    );

    expect(res.status).toBe(200);
    expect(mockExecutionWorkspaceService.getById).toHaveBeenCalledWith("55555555-5555-4555-8555-555555555555");
    expect(res.body.currentExecutionWorkspace).toEqual(expect.objectContaining({
      id: "55555555-5555-4555-8555-555555555555",
      mode: "isolated_workspace",
      runtimeServices: [
        expect.objectContaining({
          serviceName: "web",
          url: "http://127.0.0.1:5173",
        }),
      ],
    }));
  });
});
