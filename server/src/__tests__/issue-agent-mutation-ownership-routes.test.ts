import { Readable } from "node:stream";
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const issueId = "11111111-1111-4111-8111-111111111111";
const companyId = "22222222-2222-4222-8222-222222222222";
const ownerAgentId = "33333333-3333-4333-8333-333333333333";
const peerAgentId = "44444444-4444-4444-8444-444444444444";
const staleAgentId = "66666666-1111-4666-8666-666666666666";
const ownerRunId = "55555555-5555-4555-8555-555555555555";
const recoveryActionId = "77777777-7777-4777-8777-777777777777";

const mockIssueService = vi.hoisted(() => ({
  addComment: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  checkout: vi.fn(),
  create: vi.fn(),
  createChild: vi.fn(),
  decomposeAcceptedPlan: vi.fn(),
  getAttachmentById: vi.fn(),
  getByIdentifier: vi.fn(),
  getById: vi.fn(),
  getDependencyReadiness: vi.fn(),
  getComment: vi.fn(),
  getRelationSummaries: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
  list: vi.fn(),
  listAttachments: vi.fn(),
  listComments: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  remove: vi.fn(),
  removeAttachment: vi.fn(),
  update: vi.fn(),
  findMentionedAgents: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  decide: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  list: vi.fn(),
  resolveByReference: vi.fn(),
}));

const mockCompanyService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockDocumentService = vi.hoisted(() => ({
  upsertIssueDocument: vi.fn(),
}));

const mockWorkProductService = vi.hoisted(() => ({
  createForIssue: vi.fn(),
  getById: vi.fn(),
  remove: vi.fn(),
  update: vi.fn(),
}));

const mockStorageService = vi.hoisted(() => ({
  provider: "local_disk",
  putFile: vi.fn(),
  getObject: vi.fn(),
  headObject: vi.fn(),
  deleteObject: vi.fn(),
}));
const mockIssueThreadInteractionService = vi.hoisted(() => ({
  expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
  expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
  expireRequestConfirmationsSupersededByHistoricalComments: vi.fn(async () => []),
  listForIssue: vi.fn(async () => []),
}));
const mockIssueApprovalService = vi.hoisted(() => ({
  link: vi.fn(),
  unlink: vi.fn(),
  listApprovalsForIssue: vi.fn(async () => []),
}));
const mockIssueRecoveryActionService = vi.hoisted(() => ({
  getActiveForIssue: vi.fn(async () => null),
  listActiveForIssues: vi.fn(async () => new Map()),
  resolveActiveForIssue: vi.fn(async () => null),
}));
const mockTaskWatchdogService = vi.hoisted(() => ({
  getActiveForIssue: vi.fn(async () => null),
  revalidateMutationScope: vi.fn(async () => ({
    allowed: true,
    classification: { state: "stopped", stopFingerprint: "task_watchdog_stop:test" },
  })),
  reconcileForIssueAndAncestors: vi.fn(async () => ({
    checked: 0,
    triggered: 0,
    skipped: 0,
    watchdogIssueIds: [],
  })),
  upsertForIssue: vi.fn(),
  disableForIssue: vi.fn(async () => null),
}));
const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
}));
const mockExternalObjectService = vi.hoisted(() => ({
  getIssueSummaries: vi.fn(async () => new Map()),
  getIssueSummary: vi.fn(async () => ({
    authRequiredCount: 0,
    byLiveness: {},
    byStatusCategory: {},
    highestSeverity: "muted",
    objects: [],
    staleCount: 0,
    total: 0,
    unreachableCount: 0,
  })),
  getProjectSummary: vi.fn(async () => ({
    authRequiredCount: 0,
    byLiveness: {},
    byStatusCategory: {},
    highestSeverity: "muted",
    objects: [],
    staleCount: 0,
    total: 0,
    unreachableCount: 0,
  })),
  listForIssue: vi.fn(async () => []),
  refreshIssueObjects: vi.fn(async () => []),
  syncCommentSafely: vi.fn(async () => undefined),
  syncDocumentSafely: vi.fn(async () => undefined),
  syncIssueSafely: vi.fn(async () => undefined),
}));
const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

function registerRouteMocks() {
  vi.doMock("@paperclipai/shared/telemetry", () => ({
    trackAgentTaskCompleted: vi.fn(),
    trackErrorHandlerCrash: vi.fn(),
  }));

  vi.doMock("../telemetry.js", () => ({
    getTelemetryClient: vi.fn(() => ({ track: vi.fn() })),
  }));

  vi.doMock("../services/access.js", () => ({
    accessService: () => mockAccessService,
  }));

  vi.doMock("../services/agents.js", () => ({
    agentService: () => mockAgentService,
  }));

  vi.doMock("../services/documents.js", () => ({
    documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
    documentService: () => mockDocumentService,
  }));

  vi.doMock("../services/issues.js", () => ({
    issueService: () => mockIssueService,
  }));

  vi.doMock("../services/work-products.js", () => ({
    workProductService: () => mockWorkProductService,
  }));

  vi.doMock("../services/external-objects.js", () => ({
    externalObjectService: () => mockExternalObjectService,
  }));

  vi.doMock("../services/activity-log.js", () => ({
    logActivity: mockLogActivity,
  }));

  vi.doMock("../services/index.js", () => ({
    ISSUE_LIST_DEFAULT_LIMIT: 100,
    ISSUE_LIST_MAX_LIMIT: 500,
    accessService: () => mockAccessService,
    companySearchService: () => ({}),
    agentService: () => mockAgentService,
    clampIssueListLimit: (value: number) => Math.min(Math.max(value, 1), 500),
    companySkillService: () => ({
      completeTestRunForIssue: vi.fn(async () => null),
    }),
    companyService: () => mockCompanyService,
    documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
    documentService: () => mockDocumentService,
    executionWorkspaceService: () => ({}),
    feedbackService: () => ({
      listIssueVotesForUser: vi.fn(async () => []),
      saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
    }),
    goalService: () => ({}),
    heartbeatService: () => mockHeartbeatService,
    instanceSettingsService: () => ({
      get: vi.fn(async () => ({
        id: "instance-settings-1",
        general: {
          censorUsernameInLogs: false,
          feedbackDataSharingPreference: "prompt",
        },
      })),
      listCompanyIds: vi.fn(async () => [companyId]),
    }),
    issueApprovalService: () => mockIssueApprovalService,
    issueRecoveryActionService: () => mockIssueRecoveryActionService,
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
    issueService: () => mockIssueService,
    issueThreadInteractionService: () => mockIssueThreadInteractionService,
    taskWatchdogService: () => mockTaskWatchdogService,
    logActivity: mockLogActivity,
    projectService: () => ({}),
    routineService: () => ({
      syncRunStatusForIssue: vi.fn(async () => undefined),
    }),
    workProductService: () => mockWorkProductService,
  }));
}

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: issueId,
    companyId,
    status: "in_progress",
    priority: "high",
    projectId: null,
    goalId: null,
    parentId: null,
    assigneeAgentId: ownerAgentId,
    assigneeUserId: null,
    createdByUserId: "board-user",
    identifier: "PAP-1649",
    title: "Owned active issue",
    executionPolicy: null,
    executionState: null,
    hiddenAt: null,
    originKind: "manual",
    originId: null,
    ...overrides,
  };
}

function makeAgent(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    companyId,
    role: "engineer",
    status: "active",
    reportsTo: null,
    permissions: { canCreateAgents: false },
    ...overrides,
  };
}

function makeRecoveryAction(overrides: Record<string, unknown> = {}) {
  return {
    id: recoveryActionId,
    companyId,
    sourceIssueId: issueId,
    recoveryIssueId: null,
    kind: "stranded_assigned_issue",
    status: "active",
    ownerType: "agent",
    ownerAgentId: peerAgentId,
    ownerUserId: null,
    previousOwnerAgentId: ownerAgentId,
    returnOwnerAgentId: ownerAgentId,
    cause: "stranded_assigned_issue",
    fingerprint: "source-scoped:test",
    evidence: {},
    nextAction: "Restore a live execution path.",
    wakePolicy: null,
    monitorPolicy: null,
    attemptCount: 1,
    maxAttempts: null,
    timeoutAt: null,
    lastAttemptAt: new Date("2026-05-13T18:00:00.000Z"),
    outcome: null,
    resolutionNote: null,
    resolvedAt: null,
    createdAt: new Date("2026-05-13T17:55:00.000Z"),
    updatedAt: new Date("2026-05-13T17:55:00.000Z"),
    ...overrides,
  };
}

function createRunContextDb(
  contextSnapshot: Record<string, unknown> = {},
  runAgentOrRows: string | Record<string, unknown>[] = ownerAgentId,
  runId: string = ownerRunId,
) {
  const runRows = Array.isArray(runAgentOrRows)
    ? runAgentOrRows
    : [{
        id: runId,
        companyId,
        agentId: runAgentOrRows,
        agentCompanyId: companyId,
        contextSnapshot,
      }];
  const firstRun = runRows[0] ?? {};
  const runAgentId = typeof firstRun.agentId === "string" ? firstRun.agentId : ownerAgentId;
  const runAgentCompanyId = typeof firstRun.agentCompanyId === "string" ? firstRun.agentCompanyId : companyId;
  const rowsForSelection = (selection: Record<string, unknown>) => {
    const keys = Object.keys(selection);
    if (keys.includes("entityId")) return [];
    if (keys.includes("contextSnapshot")) return runRows;
    if (keys.includes("agentCompanyId")) return runRows;
    return [{ id: runAgentId, companyId: runAgentCompanyId, permissions: {}, role: "engineer", reportsTo: null }];
  };
  const buildQuery = (selection: Record<string, unknown>) => {
    const whereResult = {
      orderBy: vi.fn(async () => []),
      then: async (resolve: (rows: unknown[]) => unknown) => resolve(rowsForSelection(selection)),
    };
    const query = {
      innerJoin: vi.fn(() => query),
      where: vi.fn(() => whereResult),
    };
    return query;
  };
  return {
    transaction: async (callback: (tx: Record<string, never>) => Promise<unknown>) => callback({}),
    select: vi.fn((selection: Record<string, unknown> = {}) => ({
      from: vi.fn(() => buildQuery(selection)),
    })),
  };
}

async function createApp(actor: Record<string, unknown>, db?: unknown) {
  const routeDb = db ?? createRunContextDb(
    {},
    typeof actor.agentId === "string" ? actor.agentId : ownerAgentId,
    typeof actor.runId === "string" ? actor.runId : ownerRunId,
  );
  const [{ errorHandler }, { issueRoutes }] = await Promise.all([
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    vi.importActual<typeof import("../routes/issues.js")>("../routes/issues.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", issueRoutes(routeDb as any, mockStorageService as any));
  app.use(errorHandler);
  return app;
}

function peerActor(overrides: Record<string, unknown> = {}) {
  return {
    type: "agent",
    agentId: peerAgentId,
    companyId,
    source: "agent_key",
    runId: "66666666-6666-4666-8666-666666666666",
    ...overrides,
  };
}

function ownerActor() {
  return {
    type: "agent",
    agentId: ownerAgentId,
    companyId,
    source: "agent_key",
    runId: ownerRunId,
  };
}

function ownerActorFromSweepRun() {
  return {
    ...ownerActor(),
    runId: "88888888-8888-4888-8888-888888888888",
  };
}

function boardActor() {
  return {
    type: "board",
    userId: "board-user",
    companyIds: [companyId],
    source: "local_implicit",
    isInstanceAdmin: false,
  };
}

function allowStandardAgentRootIssueCreation() {
  mockAccessService.decide.mockImplementation(async (input: { action: string }) => ({
    allowed:
      input.action === "tasks:assign" ||
      input.action === "issue:read" ||
      input.action === "issue:mutate" ||
      input.action === "company_scope:read",
    action: input.action,
    reason: "allow_test_default",
    explanation: "Allowed by test default.",
  }));
}

function createAuthorizationDecisionDb(input: { actor?: { agentId?: string | null } }, agentRows: Record<string, unknown>[]) {
  const rowsForSelection = (selection: Record<string, unknown>) => {
    const keys = Object.keys(selection);
    if (keys.includes("contextSnapshot")) return [];
    if (keys.includes("reportsTo") && keys.length <= 2) return agentRows;
    if (keys.includes("role") && keys.includes("permissions")) {
      return agentRows.filter((agent) => agent.id === input.actor?.agentId);
    }
    return [];
  };
  return {
    select: vi.fn((selection: Record<string, unknown> = {}) => ({
      from: vi.fn(() => ({
        where: vi.fn(() => {
          const settle = (
            onFulfilled: (rows: unknown[]) => unknown,
            onRejected?: (reason: unknown) => unknown,
          ) => Promise.resolve(rowsForSelection(selection)).then(onFulfilled, onRejected);
          // BLO-19094: the productivity-review source grant terminates its
          // query with `.limit(1)` rather than awaiting the where() thenable
          // directly, so the double has to offer both endings. Without this the
          // whole issue:mutate branch throws "limit is not a function" and every
          // route test using this double reports 500 instead of its real status.
          return {
            then: settle,
            limit: vi.fn(() => ({ then: settle })),
          };
        }),
      })),
    })),
  };
}

function useProductionIssueAuthorization(agentRows: Record<string, unknown>[]) {
  mockAccessService.decide.mockImplementation(async (input: { actor?: { agentId?: string | null }; action: string }) => {
    const { authorizationService } =
      await vi.importActual<typeof import("../services/authorization.js")>("../services/authorization.js");
    return authorizationService(createAuthorizationDecisionDb(input, agentRows) as never).decide(input as never);
  });
}

async function makePendingReviewIssueForAgent(agentId: string, overrides: Record<string, unknown> = {}) {
  const { normalizeIssueExecutionPolicy } = await vi.importActual<typeof import("../services/issue-execution-policy.js")>(
    "../services/issue-execution-policy.js",
  );
  const policy = normalizeIssueExecutionPolicy({
    stages: [
      {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        type: "review",
        participants: [{ type: "agent", agentId }],
      },
    ],
  })!;
  return makeIssue({
    status: "in_review",
    executionPolicy: policy,
    executionState: {
      status: "pending",
      currentStageId: policy.stages[0].id,
      currentStageIndex: 0,
      currentStageType: "review",
      currentParticipant: { type: "agent", agentId },
      returnAssignee: null,
      completedStageIds: [],
      lastDecisionId: null,
      lastDecisionOutcome: null,
    },
    ...overrides,
  });
}

describe("agent issue mutation checkout ownership", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("@paperclipai/shared/telemetry");
    vi.doUnmock("../telemetry.js");
    vi.doUnmock("../services/access.js");
    vi.doUnmock("../services/activity-log.js");
    vi.doUnmock("../services/agents.js");
    vi.doUnmock("../services/documents.js");
    vi.doUnmock("../services/external-objects.js");
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../services/issues.js");
    vi.doUnmock("../services/work-products.js");
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerRouteMocks();
    vi.clearAllMocks();
    mockAccessService.canUser.mockReset();
    mockAccessService.decide.mockReset();
    mockAccessService.decide.mockImplementation(async (input: { action: string }) => ({
      allowed: input.action === "tasks:assign" || input.action === "issue:read" || input.action === "issue:mutate",
      action: input.action,
      reason:
        input.action === "tasks:assign"
          ? "allow_explicit_grant"
          : input.action === "issue:read" || input.action === "issue:mutate"
          ? "allow_company_agent"
          : "deny_missing_grant",
      explanation:
        input.action === "tasks:assign"
          ? "Allowed by test assignment default."
          : input.action === "issue:read" || input.action === "issue:mutate"
          ? "Allowed by test issue boundary."
          : "Missing permission.",
    }));
    mockAccessService.hasPermission.mockReset();
    mockAgentService.getById.mockReset();
    mockAgentService.list.mockReset();
    mockAgentService.resolveByReference.mockReset();
    mockCompanyService.getById.mockReset();
    mockIssueService.addComment.mockReset();
    mockIssueService.assertCheckoutOwner.mockReset();
    mockIssueService.checkout.mockReset();
    mockIssueService.checkout.mockResolvedValue(makeIssue({
      status: "in_progress",
      assigneeAgentId: peerAgentId,
      checkoutRunId: "66666666-6666-4666-8666-666666666666",
      executionRunId: "66666666-6666-4666-8666-666666666666",
    }));
    mockIssueService.create.mockReset();
    mockIssueService.createChild.mockReset();
    mockIssueService.decomposeAcceptedPlan.mockReset();
    mockIssueService.getAttachmentById.mockReset();
    mockIssueService.getByIdentifier.mockReset();
    mockIssueService.getById.mockReset();
    mockIssueService.getDependencyReadiness.mockReset();
    mockIssueService.getComment.mockReset();
    mockIssueService.getRelationSummaries.mockReset();
    mockIssueService.list.mockReset();
    mockIssueService.getWakeableParentAfterChildCompletion.mockReset();
    mockIssueService.list.mockReset();
    mockIssueService.listAttachments.mockReset();
    mockIssueService.listComments.mockReset();
    mockIssueService.listWakeableBlockedDependents.mockReset();
    mockIssueThreadInteractionService.expireRequestConfirmationsSupersededByComment.mockReset();
    mockIssueThreadInteractionService.expireRequestConfirmationsSupersededByComment.mockResolvedValue([]);
    mockIssueThreadInteractionService.expireStaleRequestConfirmationsForIssueDocument.mockReset();
    mockIssueThreadInteractionService.expireStaleRequestConfirmationsForIssueDocument.mockResolvedValue([]);
    mockIssueThreadInteractionService.expireRequestConfirmationsSupersededByHistoricalComments.mockReset();
    mockIssueThreadInteractionService.expireRequestConfirmationsSupersededByHistoricalComments.mockResolvedValue([]);
    mockIssueThreadInteractionService.listForIssue.mockReset();
    mockIssueThreadInteractionService.listForIssue.mockResolvedValue([]);
    mockIssueRecoveryActionService.getActiveForIssue.mockReset();
    mockIssueRecoveryActionService.getActiveForIssue.mockResolvedValue(null);
    mockIssueRecoveryActionService.listActiveForIssues.mockReset();
    mockIssueRecoveryActionService.listActiveForIssues.mockResolvedValue(new Map());
    mockIssueRecoveryActionService.resolveActiveForIssue.mockReset();
    mockIssueRecoveryActionService.resolveActiveForIssue.mockResolvedValue({
      id: recoveryActionId,
      companyId,
      sourceIssueId: issueId,
      recoveryIssueId: null,
      kind: "issue_graph_liveness",
      status: "resolved",
      ownerType: "agent",
      ownerAgentId,
      ownerUserId: null,
      previousOwnerAgentId: null,
      returnOwnerAgentId: null,
      cause: "issue_graph_liveness",
      fingerprint: "graph-liveness:test",
      evidence: {},
      nextAction: "Restore a live execution path.",
      wakePolicy: null,
      monitorPolicy: null,
      attemptCount: 1,
      maxAttempts: null,
      timeoutAt: null,
      lastAttemptAt: new Date("2026-05-13T18:00:00.000Z"),
      outcome: "restored",
      resolutionNote: "Resolved by recovery owner",
      resolvedAt: new Date("2026-05-13T18:05:00.000Z"),
      createdAt: new Date("2026-05-13T17:55:00.000Z"),
      updatedAt: new Date("2026-05-13T18:05:00.000Z"),
    } as never);
    mockHeartbeatService.wakeup.mockReset();
    mockHeartbeatService.wakeup.mockResolvedValue(undefined);
    mockHeartbeatService.reportRunActivity.mockReset();
    mockHeartbeatService.reportRunActivity.mockResolvedValue(undefined);
    mockHeartbeatService.getRun.mockReset();
    mockHeartbeatService.getRun.mockResolvedValue(null);
    mockHeartbeatService.getActiveRunForAgent.mockReset();
    mockHeartbeatService.getActiveRunForAgent.mockResolvedValue(null);
    mockHeartbeatService.cancelRun.mockReset();
    mockHeartbeatService.cancelRun.mockResolvedValue(null);
    mockIssueApprovalService.link.mockReset();
    mockIssueApprovalService.unlink.mockReset();
    mockIssueApprovalService.listApprovalsForIssue.mockReset();
    mockIssueApprovalService.listApprovalsForIssue.mockResolvedValue([]);
    mockIssueThreadInteractionService.listForIssue.mockReset();
    mockIssueThreadInteractionService.listForIssue.mockResolvedValue([]);
    mockIssueService.remove.mockReset();
    mockIssueService.removeAttachment.mockReset();
    mockIssueService.update.mockReset();
    mockIssueService.findMentionedAgents.mockReset();
    mockLogActivity.mockClear();
    mockDocumentService.upsertIssueDocument.mockReset();
    mockWorkProductService.createForIssue.mockReset();
    mockExternalObjectService.getIssueSummaries.mockClear();
    mockExternalObjectService.getIssueSummary.mockClear();
    mockExternalObjectService.getProjectSummary.mockClear();
    mockExternalObjectService.listForIssue.mockClear();
    mockExternalObjectService.refreshIssueObjects.mockClear();
    mockExternalObjectService.syncCommentSafely.mockClear();
    mockExternalObjectService.syncDocumentSafely.mockClear();
    mockExternalObjectService.syncIssueSafely.mockClear();
    mockWorkProductService.getById.mockReset();
    mockWorkProductService.remove.mockReset();
    mockWorkProductService.update.mockReset();
    mockStorageService.putFile.mockReset();
    mockStorageService.getObject.mockReset();
    mockStorageService.headObject.mockReset();
    mockStorageService.deleteObject.mockReset();
    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.hasPermission.mockResolvedValue(false);
    mockAgentService.getById.mockImplementation(async (id: string) => {
      if (id === ownerAgentId) return makeAgent(ownerAgentId);
      if (id === peerAgentId) return makeAgent(peerAgentId);
      return null;
    });
    mockAgentService.list.mockResolvedValue([
      makeAgent(ownerAgentId),
      makeAgent(peerAgentId),
    ]);
    mockAgentService.resolveByReference.mockResolvedValue({ ambiguous: false, agent: null });
    mockCompanyService.getById.mockResolvedValue({ id: companyId, issuePrefix: "PAP" });
    mockIssueService.getById.mockResolvedValue(makeIssue());
    mockIssueService.getByIdentifier.mockResolvedValue(null);
    mockIssueService.getDependencyReadiness.mockResolvedValue({
      issueId,
      blockerIssueIds: [],
      unresolvedBlockerCount: 0,
      unresolvedBlockerIssueIds: [],
      pendingFinalizeBlockerIssueIds: [],
      allBlockersDone: true,
      isDependencyReady: true,
    });
    mockIssueService.getComment.mockResolvedValue({
      id: "comment-1",
      issueId,
      companyId,
      body: "Mentioned reply context.",
    });
    mockIssueService.list.mockResolvedValue([makeIssue()]);
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockIssueService.create.mockImplementation(async (_companyId: string, input: Record<string, unknown>) => ({
      ...makeIssue({
        id: "88888888-8888-4888-8888-888888888888",
        status: "todo",
        assigneeAgentId: null,
      }),
      ...input,
      companyId,
    }));
    mockIssueService.createChild.mockImplementation(async (_parentId: string, input: Record<string, unknown>) => ({
      issue: {
        ...makeIssue({
          id: "99999999-9999-4999-8999-999999999999",
          status: "todo",
          parentId: issueId,
          assigneeAgentId: null,
        }),
        ...input,
        companyId,
      },
      parentBlockerAdded: false,
    }));
    mockIssueService.decomposeAcceptedPlan.mockImplementation(async (_sourceIssueId: string, input: Record<string, unknown>) => {
      const children = input.children as Record<string, unknown>[];
      return {
        decomposition: {
          id: "decomposition-1",
          status: "completed",
          childIssueIds: children.map((child) => child.id),
        },
        childIssueIds: children.map((child) => child.id),
        newlyCreatedIssues: children.map((child) => ({
          ...makeIssue({
            id: child.id,
            parentId: issueId,
            status: child.status,
            assigneeAgentId: child.assigneeAgentId ?? null,
          }),
          ...child,
          companyId,
        })),
      };
    });
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeIssue(),
      ...patch,
    }));
    mockIssueService.addComment.mockResolvedValue({
      id: "77777777-7777-4777-8777-777777777777",
      issueId,
      companyId,
      body: "comment",
    });
    mockIssueService.listAttachments.mockResolvedValue([]);
    mockIssueService.listComments.mockResolvedValue([
      {
        id: "comment-1",
        issueId,
        companyId,
        body: "Mentioned reply context.",
      },
    ]);
    mockIssueService.remove.mockResolvedValue(makeIssue({ status: "cancelled" }));
    mockIssueService.getAttachmentById.mockResolvedValue({
      id: "attachment-1",
      issueId,
      companyId,
      objectKey: "issues/attachment-1/report.txt",
      contentType: "text/plain",
      byteSize: 6,
      originalFilename: "report.txt",
    });
    mockIssueService.removeAttachment.mockResolvedValue({
      id: "attachment-1",
      issueId,
      companyId,
      objectKey: "issues/attachment-1/report.txt",
    });
    mockDocumentService.upsertIssueDocument.mockResolvedValue({
      created: false,
      document: {
        id: "document-1",
        key: "plan",
        title: "Plan",
        format: "markdown",
        latestRevisionNumber: 2,
      },
    });
    mockWorkProductService.createForIssue.mockResolvedValue({
      id: "product-2",
      issueId,
      companyId,
      type: "artifact",
      provider: "test",
      title: "Artifact",
    });
    mockWorkProductService.getById.mockResolvedValue({
      id: "product-1",
      issueId,
      companyId,
      type: "artifact",
    });
    mockWorkProductService.update.mockResolvedValue({
      id: "product-1",
      issueId,
      companyId,
      type: "artifact",
      title: "Updated",
    });
    mockWorkProductService.remove.mockResolvedValue({
      id: "product-1",
      issueId,
      companyId,
      type: "artifact",
    });
    mockStorageService.putFile.mockResolvedValue({
      provider: "local_disk",
      objectKey: "issues/upload.txt",
      contentType: "text/plain",
      byteSize: 6,
      sha256: "sha256",
      originalFilename: "upload.txt",
    });
    mockStorageService.getObject.mockResolvedValue({
      stream: Readable.from(Buffer.from("report")),
      contentLength: 6,
    });
    mockStorageService.deleteObject.mockResolvedValue(undefined);
  });

  it("denies company-wide issue list routes for task bridge keys", async () => {
    const app = await createApp(peerActor({
      keyId: "99999999-9999-4999-8999-999999999999",
      keyScope: {
        kind: "task_bridge",
        parentIssueId: issueId,
      },
    }));

    const res = await request(app).get(`/api/companies/${companyId}/issues`);

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Task bridge keys cannot use company-wide issue list APIs");
    expect(mockIssueService.list).not.toHaveBeenCalled();
  });

  it("uses the company-scope fast path on the issue list route", async () => {
    mockAccessService.decide.mockImplementation(async (input: { action: string }) => {
      if (input.action === "company_scope:read") {
        return {
          allowed: true,
          action: input.action,
          reason: "allow_explicit_grant",
          explanation: "Allowed by test company scope.",
        };
      }
      if (input.action === "issue:read") {
        throw new Error("issue:read should not be evaluated for company-scope readers");
      }
      return {
        allowed: true,
        action: input.action,
        reason: "allow_test_default",
        explanation: "Allowed by test default.",
      };
    });

    const app = await createApp(boardActor());
    const res = await request(app).get(`/api/companies/${companyId}/issues`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual([expect.objectContaining({ id: issueId })]);
    expect(mockAccessService.decide).toHaveBeenCalledWith(expect.objectContaining({
      action: "company_scope:read",
      resource: { type: "company", companyId },
    }));
    expect(mockAccessService.decide).not.toHaveBeenCalledWith(expect.objectContaining({
      action: "issue:read",
    }));
  });

  it.each([
    ["patch", (app: express.Express) => request(app).patch(`/api/issues/${issueId}`).send({ title: "Blocked" })],
    ["delete", (app: express.Express) => request(app).delete(`/api/issues/${issueId}`)],
    [
      "document upsert",
      (app: express.Express) =>
        request(app).put(`/api/issues/${issueId}/documents/plan`).send({ format: "markdown", body: "# blocked" }),
    ],
    ["work product update", (app: express.Express) => request(app).patch("/api/work-products/product-1").send({ title: "Blocked" })],
    [
      "low-trust promotion",
      (app: express.Express) =>
        request(app).post(`/api/issues/${issueId}/low-trust/promotions`).send({
          sourceArtifactKind: "comment",
          sourceArtifactId: recoveryActionId,
          title: "Promoted artifact",
          summary: "Sanitized output",
        }),
    ],
    [
      "attachment upload",
      (app: express.Express) =>
        request(app)
          .post(`/api/companies/${companyId}/issues/${issueId}/attachments`)
          .attach("file", Buffer.from("report"), { filename: "report.txt", contentType: "text/plain" }),
    ],
    ["attachment delete", (app: express.Express) => request(app).delete("/api/attachments/attachment-1")],
  ])("rejects peer agent %s on another agent's active checkout", async (_name, sendRequest) => {
    const res = await sendRequest(await createApp(peerActor()));

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error).toBe("Issue is checked out by another agent");
    expect(mockIssueService.assertCheckoutOwner).not.toHaveBeenCalled();
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
    expect(mockDocumentService.upsertIssueDocument).not.toHaveBeenCalled();
    expect(mockWorkProductService.createForIssue).not.toHaveBeenCalled();
    expect(mockWorkProductService.update).not.toHaveBeenCalled();
    expect(mockStorageService.putFile).not.toHaveBeenCalled();
    expect(mockStorageService.deleteObject).not.toHaveBeenCalled();
  });

  it("allows a source-scoped recovery owner to clear a stale blocked source issue", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue({ status: "blocked", assigneeAgentId: ownerAgentId }));
    mockIssueRecoveryActionService.getActiveForIssue.mockResolvedValue(makeRecoveryAction() as never);

    const res = await request(await createApp(peerActor()))
      .patch(`/api/issues/${issueId}`)
      .send({
        status: "todo",
        blockedByIssueIds: [],
        comment: "Restoring the original owner after stale recovery block cleared.",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockIssueService.assertCheckoutOwner).not.toHaveBeenCalled();
    expect(mockIssueService.update).toHaveBeenCalledWith(
      issueId,
      expect.objectContaining({
        status: "todo",
        blockedByIssueIds: [],
        actorAgentId: peerAgentId,
      }),
    );
  });

  it("rejects source-scoped recovery owner blocker clearing when blockers remain unresolved", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue({ status: "blocked", assigneeAgentId: ownerAgentId }));
    mockIssueRecoveryActionService.getActiveForIssue.mockResolvedValue(makeRecoveryAction() as never);
    mockIssueService.getDependencyReadiness.mockResolvedValue({
      unresolvedBlockerCount: 1,
      unresolvedBlockerIssueIds: ["99999999-9999-4999-8999-999999999999"],
    });

    const res = await request(await createApp(peerActor()))
      .patch(`/api/issues/${issueId}`)
      .send({
        status: "todo",
        blockedByIssueIds: [],
        comment: "Attempting to clear an active blocker.",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error).toBe("Issue recovery restore blocked by unresolved blockers");
    expect(mockIssueService.getDependencyReadiness).toHaveBeenCalledWith(issueId);
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("allows a source-scoped recovery owner to return assignment without tasks:assign", async () => {
    mockAccessService.decide.mockImplementation(async (input: { action: string }) => ({
      allowed: input.action === "issue:read" || input.action === "issue:mutate",
      action: input.action,
      reason: input.action === "tasks:assign" ? "deny_policy_restricted" : "allow_test_default",
      explanation: input.action === "tasks:assign"
        ? "Recovery owner does not have broad assignment permission."
        : "Allowed by test default.",
    }));
    mockIssueService.getById.mockResolvedValue(makeIssue({ status: "blocked", assigneeAgentId: staleAgentId }));
    mockIssueRecoveryActionService.getActiveForIssue.mockResolvedValue(makeRecoveryAction({
      previousOwnerAgentId: ownerAgentId,
      returnOwnerAgentId: ownerAgentId,
    }) as never);
    mockAgentService.resolveByReference.mockResolvedValue({
      ambiguous: false,
      agent: makeAgent(ownerAgentId),
    });

    const res = await request(await createApp(peerActor()))
      .patch(`/api/issues/${issueId}`)
      .send({
        status: "todo",
        blockedByIssueIds: [],
        assigneeAgentId: ownerAgentId,
        assigneeUserId: null,
        comment: "Returning the recovered issue to its previous owner.",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockIssueService.assertCheckoutOwner).not.toHaveBeenCalled();
    expect(mockIssueService.update).toHaveBeenCalledWith(
      issueId,
      expect.objectContaining({
        status: "todo",
        blockedByIssueIds: [],
        assigneeAgentId: ownerAgentId,
        assigneeUserId: null,
        actorAgentId: peerAgentId,
      }),
    );
    expect(mockAccessService.decide).not.toHaveBeenCalledWith(expect.objectContaining({
      action: "tasks:assign",
    }));
  });

  it("does not let a source-scoped recovery owner edit normal issue content", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue({ status: "todo", assigneeAgentId: ownerAgentId }));
    mockIssueRecoveryActionService.getActiveForIssue.mockResolvedValue(makeRecoveryAction() as never);

    const res = await request(await createApp(peerActor()))
      .patch(`/api/issues/${issueId}`)
      .send({ title: "Unauthorized content edit" });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toBe("Agent cannot mutate another agent's issue");
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("allows mentioned peer agents to post comments without ownership of an active checkout", async () => {
    mockAccessService.decide.mockImplementation(async (input: { action: string }) => ({
      allowed: input.action === "issue:comment",
      action: input.action,
      reason: input.action === "issue:comment" ? "allow_issue_mention_grant" : "deny_missing_grant",
      explanation:
        input.action === "issue:comment"
          ? "Allowed by a mention-scoped issue comment grant."
          : "Missing permission.",
    }));

    const res = await request(await createApp(peerActor()))
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "I can respond here." });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockIssueService.addComment).toHaveBeenCalledWith(
      issueId,
      "I can respond here.",
      expect.any(Object),
      expect.any(Object),
    );
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  // BLO-18906: recovery escalation reassigns the issue away from the previous
  // owner, which costs it allow_self mid-run. The handoff grant restores exactly
  // one capability — posting a comment — and nothing that changes issue state.
  const recoveryHandoffDecide = async (input: { action: string }) => ({
    allowed: input.action === "issue:comment",
    action: input.action,
    reason: input.action === "issue:comment" ? "allow_recovery_handoff_grant" : "deny_missing_grant",
    explanation:
      input.action === "issue:comment"
        ? "Allowed by a recovery-handoff issue comment grant for the reassigned previous owner."
        : "Missing permission.",
  });

  it("lets a recovery-transferred previous owner post its handoff comment", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue({ status: "blocked", assigneeAgentId: peerAgentId }));
    mockAccessService.decide.mockImplementation(recoveryHandoffDecide);

    const res = await request(await createApp(ownerActor()))
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "Handoff: root cause is X, next step is Y." });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockIssueService.addComment).toHaveBeenCalledWith(
      issueId,
      "Handoff: root cause is X, next step is Y.",
      expect.any(Object),
      expect.any(Object),
    );
    // The comment must not drag the blocked issue back to todo.
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("refuses reopen/resume from a recovery handoff grant instead of transitioning a blocked issue", async () => {
    for (const transition of [{ reopen: true }, { resume: true }]) {
      mockIssueService.getById.mockResolvedValue(makeIssue({ status: "blocked", assigneeAgentId: peerAgentId }));
      mockAccessService.decide.mockImplementation(recoveryHandoffDecide);

      const res = await request(await createApp(ownerActor()))
        .post(`/api/issues/${issueId}/comments`)
        .send({ body: "Handoff plus a status grab.", ...transition });

      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body.error).toBe("Recovery handoff grant is comment-only");
      expect(res.body.details).toMatchObject({ reason: "allow_recovery_handoff_grant" });
      expect(mockIssueService.addComment).not.toHaveBeenCalled();
      expect(mockIssueService.update).not.toHaveBeenCalled();
    }
  });

  it("keeps mutation and deletion denied for a recovery handoff grant holder", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue({ status: "blocked", assigneeAgentId: peerAgentId }));
    mockAccessService.decide.mockImplementation(recoveryHandoffDecide);

    const patchRes = await request(await createApp(ownerActor()))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "todo" });
    expect(patchRes.status, JSON.stringify(patchRes.body)).toBe(403);
    expect(patchRes.body.details).toMatchObject({ reason: "deny_missing_grant", boundary: "grant" });
    expect(mockIssueService.update).not.toHaveBeenCalled();

    mockIssueService.getById.mockResolvedValue(makeIssue({ status: "blocked", assigneeAgentId: peerAgentId }));
    mockAccessService.decide.mockImplementation(recoveryHandoffDecide);

    const deleteRes = await request(await createApp(ownerActor()))
      .delete(`/api/issues/${issueId}`);
    expect(deleteRes.status, JSON.stringify(deleteRes.body)).toBe(403);
    expect(mockIssueService.remove).not.toHaveBeenCalled();
  });

  // BLO-19094: a productivity review is assigned to a reviewer, but every
  // remedy it can order (block / cancel / reassign / snooze) is a mutation of
  // the SOURCE issue. Unlike the recovery handoff above, this grant therefore
  // has to cover issue:mutate as well as issue:comment — a comment-only grant
  // leaves the review able to detect and never able to fix.
  const productivityReviewDecide = async (input: { action: string }) => ({
    allowed: input.action === "issue:comment"
      || input.action === "issue:mutate"
      || input.action === "issue:read"
      || input.action === "tasks:assign",
    action: input.action,
    reason: input.action === "issue:comment" || input.action === "issue:mutate"
      ? "allow_productivity_review_grant"
      : "allow_test_default",
    explanation: "Allowed by an open productivity review the actor owns for this issue.",
  });
  const productivitySourceMutationAuditCalls = () =>
    mockLogActivity.mock.calls.filter(([, entry]) =>
      (entry as { action?: string }).action === "issue.productivity_review_source_mutation"
    );

  it("lets a productivity-review owner reassign a source issue pinned open by a paused assignee", async () => {
    // The exact condition the review exists to catch: in_progress, held by an
    // agent that will never run again to release it. Without the route-layer
    // override this returns 409 "checked out by another agent" even once the
    // authorization boundary allows the actor through.
    //
    // The paused assignee is mocked rather than merely asserted about because
    // the point is that the route reaches the mutation WITHOUT the assignee
    // ever running or being consulted for liveness. The DB-level paused/error
    // coverage of the grant predicate itself lives in
    // authorization-service.test.ts.
    mockIssueService.getById.mockResolvedValue(makeIssue({
      status: "in_progress",
      assigneeAgentId: peerAgentId,
    }));
    mockAccessService.decide.mockImplementation(productivityReviewDecide);
    mockAgentService.getById.mockResolvedValue(makeAgent(peerAgentId, { status: "paused" }));
    mockAgentService.resolveByReference.mockResolvedValue({
      ambiguous: false,
      agent: makeAgent(ownerAgentId),
    });

    const res = await request(await createApp(ownerActor()))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "todo", assigneeAgentId: ownerAgentId });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      issueId,
      expect.objectContaining({ status: "todo", assigneeAgentId: ownerAgentId }),
    );
    expect(productivitySourceMutationAuditCalls()).toHaveLength(1);
    expect(productivitySourceMutationAuditCalls()[0]?.[1]).toMatchObject({
      action: "issue.productivity_review_source_mutation",
      entityId: issueId,
      details: {
        reviewerAgentId: ownerAgentId,
        previousAssigneeAgentId: peerAgentId,
        issueStatus: "in_progress",
        changedFields: expect.arrayContaining(["status", "assigneeAgentId"]),
      },
    });
    const auditCallIndex = mockLogActivity.mock.calls.findIndex(([, entry]) =>
      (entry as { action?: string }).action === "issue.productivity_review_source_mutation"
    );
    expect(mockLogActivity.mock.invocationCallOrder[auditCallIndex]).toBeGreaterThan(
      mockIssueService.update.mock.invocationCallOrder[0]!,
    );
  });

  it("does not audit a productivity-review source mutation when the PATCH changes no issue fields", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue({
      status: "in_progress",
      assigneeAgentId: peerAgentId,
      title: "Owned active issue",
    }));
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeIssue({
        status: "in_progress",
        assigneeAgentId: peerAgentId,
        title: "Owned active issue",
      }),
      ...patch,
    }));
    mockAccessService.decide.mockImplementation(productivityReviewDecide);

    const res = await request(await createApp(ownerActor()))
      .patch(`/api/issues/${issueId}`)
      .send({ title: "Owned active issue" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalled();
    expect(productivitySourceMutationAuditCalls()).toHaveLength(0);
  });

  it("does not audit a productivity-review source mutation when the PATCH fails after authorization", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue({
      status: "in_progress",
      assigneeAgentId: peerAgentId,
    }));
    mockIssueService.update.mockRejectedValueOnce(new Error("update failed"));
    mockAccessService.decide.mockImplementation(productivityReviewDecide);

    const res = await request(await createApp(ownerActor()))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "todo" });

    expect(res.status).toBe(500);
    expect(productivitySourceMutationAuditCalls()).toHaveLength(0);
  });

  it("keeps destructive routes closed to a productivity-review owner", async () => {
    // Only PATCH /issues/:id opts into the reviewer override. DELETE shares the
    // same mutation helper and must stay denied — an early return above the
    // helper's per-route options is the bypass that sank PR #814.
    mockIssueService.getById.mockResolvedValue(makeIssue({
      status: "in_progress",
      assigneeAgentId: peerAgentId,
    }));
    mockAccessService.decide.mockImplementation(productivityReviewDecide);

    const deleteRes = await request(await createApp(ownerActor()))
      .delete(`/api/issues/${issueId}`);

    expect(deleteRes.status, JSON.stringify(deleteRes.body)).toBe(409);
    expect(mockIssueService.remove).not.toHaveBeenCalled();
  });

  // The comment route's current-execution-run short-circuit returns a bare
  // `true`, discarding the decision reason. A previous owner whose stale
  // execution lock still matches therefore reaches the route WITHOUT an
  // allow_recovery_handoff_grant decision to key off, so the comment-only
  // contract has to be resolved from the recovery row instead.
  it("keeps the handoff comment-only when a stale execution lock bypasses the boundary decision", async () => {
    const staleLockIssue = () => makeIssue({
      status: "blocked",
      assigneeAgentId: peerAgentId,
      // Recovery moved the assignee to peerAgentId, but this run id is the
      // previous owner's — the shape the current-run bypass matches on.
      executionRunId: ownerRunId,
      checkoutRunId: ownerRunId,
    });
    // Deny every boundary action: the ONLY way through is the current-run bypass.
    const denyEverything = async (input: { action: string }) => ({
      allowed: false,
      action: input.action,
      reason: "deny_missing_grant",
      explanation: "Missing permission.",
    });

    mockIssueService.getById.mockResolvedValue(staleLockIssue());
    mockAccessService.decide.mockImplementation(denyEverything);
    mockIssueRecoveryActionService.getActiveForIssue.mockResolvedValue(makeRecoveryAction() as never);

    const commentRes = await request(await createApp(ownerActor()))
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "Handoff evidence from the run that just lost the issue." });
    expect(commentRes.status, JSON.stringify(commentRes.body)).toBe(201);
    expect(mockIssueService.addComment).toHaveBeenCalledTimes(1);
    expect(mockIssueService.update).not.toHaveBeenCalled();

    for (const transition of [{ reopen: true }, { resume: true }]) {
      mockIssueService.addComment.mockClear();
      mockIssueService.update.mockClear();
      mockIssueService.getById.mockResolvedValue(staleLockIssue());
      mockAccessService.decide.mockImplementation(denyEverything);
      mockIssueRecoveryActionService.getActiveForIssue.mockResolvedValue(makeRecoveryAction() as never);

      const res = await request(await createApp(ownerActor()))
        .post(`/api/issues/${issueId}/comments`)
        .send({ body: "Handoff plus a status grab.", ...transition });

      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body.error).toBe("Recovery handoff grant is comment-only");
      expect(mockIssueService.addComment).not.toHaveBeenCalled();
      expect(mockIssueService.update).not.toHaveBeenCalled();
    }
  });

  // A comment-only grant must not become a review decision by another route:
  // the in_review auto-approval branch transitions the issue to `done` and
  // records an execution decision without ever consulting issue:mutate.
  it("does not let a recovery handoff comment auto-approve an in_review issue", async () => {
    const { normalizeIssueExecutionPolicy } = await import("../services/issue-execution-policy.js");
    // The stage still names the previous owner as its reviewer, so the actor
    // matches currentParticipant even though recovery moved the assignee away.
    const policy = normalizeIssueExecutionPolicy({
      stages: [
        {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          type: "review",
          participants: [{ type: "agent", agentId: ownerAgentId }],
        },
      ],
    })!;
    const inReviewIssue = makeIssue({
      status: "in_review",
      assigneeAgentId: peerAgentId,
      executionPolicy: policy,
      executionState: {
        status: "pending",
        currentStageId: policy.stages[0].id,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: ownerAgentId },
        returnAssignee: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    });
    const reviewBody = "## Review: APPROVED";
    mockIssueService.getById.mockResolvedValue(inReviewIssue);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-recovery-handoff-approval",
      issueId,
      companyId,
      body: reviewBody,
      createdAt: new Date(),
      updatedAt: new Date(),
      authorAgentId: ownerAgentId,
      authorUserId: null,
    });
    mockAccessService.decide.mockImplementation(recoveryHandoffDecide);
    mockIssueRecoveryActionService.getActiveForIssue.mockResolvedValue(makeRecoveryAction() as never);

    const res = await request(await createApp(ownerActor()))
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: reviewBody });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockIssueService.addComment).toHaveBeenCalledTimes(1);
    // The comment lands; the state transition does not.
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  // A transient lookup failure must not become a way to keep the transition:
  // the comment still lands, the state change does not.
  it("fails closed on a recovery-action lookup error, keeping the comment but refusing reopen", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue({ status: "blocked", assigneeAgentId: peerAgentId }));
    mockAccessService.decide.mockImplementation(recoveryHandoffDecide);
    mockIssueRecoveryActionService.getActiveForIssue.mockRejectedValue(new Error("database timeout"));

    const commentRes = await request(await createApp(ownerActor()))
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "Handoff evidence." });
    expect(commentRes.status, JSON.stringify(commentRes.body)).toBe(201);
    expect(mockIssueService.update).not.toHaveBeenCalled();

    mockIssueService.addComment.mockClear();
    mockIssueService.getById.mockResolvedValue(makeIssue({ status: "blocked", assigneeAgentId: peerAgentId }));
    mockAccessService.decide.mockImplementation(recoveryHandoffDecide);
    mockIssueRecoveryActionService.getActiveForIssue.mockRejectedValue(new Error("database timeout"));

    const reopenRes = await request(await createApp(ownerActor()))
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "Handoff plus a status grab.", reopen: true });
    expect(reopenRes.status, JSON.stringify(reopenRes.body)).toBe(403);
    expect(reopenRes.body.error).toBe("Recovery handoff grant is comment-only");
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("rejects non-mentioned peer agents from posting comments", async () => {
    mockAccessService.decide.mockImplementation(async (input: { action: string }) => ({
      allowed: input.action === "issue:read",
      action: input.action,
      reason: input.action === "issue:read" ? "allow_explicit_grant" : "deny_missing_grant",
      explanation: input.action === "issue:read" ? "Allowed by test read grant." : "Missing permission.",
    }));

    const res = await request(await createApp(peerActor()))
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "I was not mentioned." });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toBe("Issue is outside this actor's authorization boundary (grant)");
    expect(res.body.details).toMatchObject({ reason: "deny_missing_grant", boundary: "grant" });
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });

  // BLO-18996: the reported deadlock. A `stranded_assigned_issue` action named an owner
  // who is not the source issue's assignee and whose run is checked out elsewhere, so
  // `issue:comment` denied and the owner could not discharge the action it was woken
  // for. The action stayed `active` and the sweep re-fired it indefinitely.
  describe("source-scoped recovery owner comment grant (BLO-18996)", () => {
    // The ordinary peer-agent fall-through: every allow-path missed, so `issue:comment`
    // ends at `deny_missing_grant`. That is the one denial the recovery-owner grant may
    // override; `denyCommentWithReason` below covers the ones it may not.
    function denyCommentGrantEverywhere() {
      denyCommentWithReason("deny_missing_grant");
    }

    // The owner's run id deliberately does not match the issue's checkout/execution run:
    // that is the "checked out against a different issue" half of the reported shape, and
    // it is what makes `isCurrentIssueExecutionRun` fall through to the boundary check.
    const recoveryOwnerActor = () => peerActor({ runId: "9a9a9a9a-9a9a-4a9a-8a9a-9a9a9a9a9a9a" });

    it("lets the owner of an active recovery action comment on its source issue", async () => {
      denyCommentGrantEverywhere();
      mockIssueService.getById.mockResolvedValue(makeIssue({
        checkoutRunId: ownerRunId,
        executionRunId: ownerRunId,
      }) as never);
      mockIssueRecoveryActionService.getActiveForIssue.mockResolvedValue(
        makeRecoveryAction({ ownerAgentId: peerAgentId }) as never,
      );

      const res = await request(await createApp(recoveryOwnerActor()))
        .post(`/api/issues/${issueId}/comments`)
        .send({ body: "I cannot restore this; escalating." });

      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(mockIssueService.addComment).toHaveBeenCalledWith(
        issueId,
        "I cannot restore this; escalating.",
        expect.any(Object),
        expect.any(Object),
      );
      expect(mockIssueService.update).not.toHaveBeenCalled();
    });

    it("still rejects an agent who is not the named recovery owner", async () => {
      denyCommentGrantEverywhere();
      mockIssueService.getById.mockResolvedValue(makeIssue({
        checkoutRunId: ownerRunId,
        executionRunId: ownerRunId,
      }) as never);
      mockIssueRecoveryActionService.getActiveForIssue.mockResolvedValue(
        makeRecoveryAction({ ownerAgentId: staleAgentId }) as never,
      );

      const res = await request(await createApp(recoveryOwnerActor()))
        .post(`/api/issues/${issueId}/comments`)
        .send({ body: "Not my recovery action." });

      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body.error).toBe("Issue is outside this actor's authorization boundary (grant)");
      expect(mockIssueService.addComment).not.toHaveBeenCalled();
    });

    it("does not admit a recovery action whose owner is unset", async () => {
      denyCommentGrantEverywhere();
      mockIssueService.getById.mockResolvedValue(makeIssue({
        checkoutRunId: ownerRunId,
        executionRunId: ownerRunId,
      }) as never);
      mockIssueRecoveryActionService.getActiveForIssue.mockResolvedValue(
        makeRecoveryAction({ ownerAgentId: null, ownerType: "board" }) as never,
      );

      const res = await request(await createApp(recoveryOwnerActor()))
        .post(`/api/issues/${issueId}/comments`)
        .send({ body: "Board-owned action; not mine." });

      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(mockIssueService.addComment).not.toHaveBeenCalled();
    });

    // Ally's review of PR #837 (suggestion 2): the lookup ran unguarded inside the
    // denial branch, so a transient failure surfaced as an unlabelled 500 instead of
    // the ordinary 403 the caller would have received anyway. It must fail CLOSED —
    // an unreadable action grants nothing — and stay diagnosable in logs via the
    // `recovery_lookup_failed` discriminator the sibling checkout path already uses.
    it("fails closed with a plain 403 when the recovery-action lookup errors", async () => {
      denyCommentGrantEverywhere();
      mockIssueService.getById.mockResolvedValue(makeIssue({
        checkoutRunId: ownerRunId,
        executionRunId: ownerRunId,
      }) as never);
      mockIssueRecoveryActionService.getActiveForIssue.mockRejectedValue(new Error("database timeout"));

      const res = await request(await createApp(recoveryOwnerActor()))
        .post(`/api/issues/${issueId}/comments`)
        .send({ body: "Owner comment during a lookup outage." });

      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body.error).toBe("Issue is outside this actor's authorization boundary (grant)");
      expect(mockIssueService.addComment).not.toHaveBeenCalled();
      expect(mockIssueService.update).not.toHaveBeenCalled();
    });

    // Ally's review of PR #837: the admission originally sat in a bare
    // `if (!boundaryDecision.allowed)`, so it overrode EVERY denial reason — a low-trust
    // actor scoped to an explicit trust boundary could step outside it just by being the
    // named owner of an active recovery action. The grant is now gated on the single
    // ordinary peer-agent fall-through reason (`deny_missing_grant`), so a hard denial
    // stays terminal. Each of these actors IS the named owner; only the reason differs.
    function denyCommentWithReason(reason: string) {
      mockAccessService.decide.mockImplementation(async (input: { action: string }) => ({
        allowed: input.action === "issue:read",
        action: input.action,
        reason: input.action === "issue:read" ? "allow_explicit_grant" : reason,
        explanation: input.action === "issue:read" ? "Allowed by test read grant." : "Denied by test.",
      }));
    }

    it.each([
      ["deny_low_trust_boundary", "trust-boundary"],
      ["deny_policy_restricted", "trust-boundary"],
      ["deny_scope", "scope"],
      ["deny_missing_membership", "membership"],
      ["deny_company_boundary", "company-mismatch"],
    ])("does not let the recovery owner grant override a %s denial", async (reason, label) => {
      denyCommentWithReason(reason);
      mockIssueService.getById.mockResolvedValue(makeIssue({
        checkoutRunId: ownerRunId,
        executionRunId: ownerRunId,
      }) as never);
      mockIssueRecoveryActionService.getActiveForIssue.mockResolvedValue(
        makeRecoveryAction({ ownerAgentId: peerAgentId }) as never,
      );

      const res = await request(await createApp(recoveryOwnerActor()))
        .post(`/api/issues/${issueId}/comments`)
        .send({ body: "Owner of the action, but denied for a harder reason." });

      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body.error).toBe(`Issue is outside this actor's authorization boundary (${label})`);
      expect(mockIssueService.addComment).not.toHaveBeenCalled();
    });

    // The complement of the case above: the grant must still do its job for the ordinary
    // missing-grant denial, which is the deadlock this whole change exists to break.
    it("still admits the recovery owner on the ordinary missing-grant denial", async () => {
      denyCommentWithReason("deny_missing_grant");
      mockIssueService.getById.mockResolvedValue(makeIssue({
        checkoutRunId: ownerRunId,
        executionRunId: ownerRunId,
      }) as never);
      mockIssueRecoveryActionService.getActiveForIssue.mockResolvedValue(
        makeRecoveryAction({ ownerAgentId: peerAgentId }) as never,
      );

      const res = await request(await createApp(recoveryOwnerActor()))
        .post(`/api/issues/${issueId}/comments`)
        .send({ body: "Discharging the recovery action." });

      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(mockIssueService.addComment).toHaveBeenCalled();
    });

    // The grant is comment-only on EVERY status, not just closed ones. `blocked` is the
    // case that matters: it is what a source-scoped recovery action normally leaves its
    // source issue in, `isExplicitResumeCapableStatus` accepts it, and the only guard that
    // used to stand between the grant and a `blocked` -> `todo` transition was
    // `assertExplicitResumeIntentAllowed` — a state/intent check, not an authorization one.
    // `getDependencyReadiness` is pinned to zero unresolved blockers on purpose, so the
    // refusal has to come from authorization rather than from the dependency 409
    // incidentally covering for it. Asserting the consequence (no move to `todo`) rather
    // than only the status code.
    it.each([["blocked"], ["done"], ["cancelled"], ["todo"], ["in_progress"]])(
      "does not let the recovery owner reopen a %s source issue via the comment grant",
      async (status) => {
        denyCommentGrantEverywhere();
        mockIssueService.getById.mockResolvedValue(makeIssue({
          status,
          checkoutRunId: ownerRunId,
          executionRunId: ownerRunId,
        }) as never);
        mockIssueService.getDependencyReadiness.mockResolvedValue({
          unresolvedBlockerCount: 0,
          unresolvedBlockerIssueIds: [],
        } as never);
        mockIssueRecoveryActionService.getActiveForIssue.mockResolvedValue(
          makeRecoveryAction({ ownerAgentId: peerAgentId }) as never,
        );

        const res = await request(await createApp(recoveryOwnerActor()))
          .post(`/api/issues/${issueId}/comments`)
          .send({ body: "Reopening this.", reopen: true });

        expect(res.status, JSON.stringify(res.body)).toBe(403);
        expect(res.body.error).toBe("Recovery owner grant is comment-only");
        expect(res.body.details?.reason).toBe("allow_source_scoped_recovery_owner");
        expect(mockIssueService.addComment).not.toHaveBeenCalled();
        // The consequence the guard exists to prevent: the issue must not be carried to `todo`.
        expect(mockIssueService.update).not.toHaveBeenCalled();
      },
    );

    // THE test that proves the hole rather than the error string. The peer refusal inside
    // `assertExplicitResumeIntentAllowed` ("Agent cannot request follow-up for another
    // agent's issue", routes/issues.ts:4613) is what stopped the plain-peer cases above, so
    // those only ever proved a message change. It is short-circuited by
    // `hasActiveCheckoutManagementOverride` -> `tasks:manage_active_checkouts`, which is
    // exactly the action `allow_manager_chain` is wired to — and the reported BLO-18996
    // instance named the assignee's *manager* (the CEO) as recovery owner. Manager comments
    // now receive that production grant before the recovery-owner fallback is considered, so
    // this case must exercise the creator/manager comment-only guard. The plain-peer case above
    // remains the end-to-end regression for `allow_source_scoped_recovery_owner`.
    it("does not let a manager recovery owner reopen a blocked source issue to todo", async () => {
      mockAccessService.decide.mockImplementation(async (input: { action: string }) => {
        const allowed =
          input.action === "issue:read" ||
          input.action === "issue:comment" ||
          input.action === "tasks:manage_active_checkouts";
        return {
          allowed,
          action: input.action,
          reason: input.action === "issue:comment" || input.action === "tasks:manage_active_checkouts"
            ? "allow_manager_chain"
            : allowed
              ? "allow_explicit_grant"
              : "deny_missing_grant",
          explanation: allowed ? "Allowed by test manager override." : "Denied by test.",
        };
      });
      mockIssueService.getById.mockResolvedValue(makeIssue({
        status: "blocked",
        checkoutRunId: ownerRunId,
        executionRunId: ownerRunId,
      }) as never);
      mockIssueService.getDependencyReadiness.mockResolvedValue({
        unresolvedBlockerCount: 0,
        unresolvedBlockerIssueIds: [],
      } as never);
      mockIssueRecoveryActionService.getActiveForIssue.mockResolvedValue(
        makeRecoveryAction({ ownerAgentId: peerAgentId }) as never,
      );

      const res = await request(await createApp(recoveryOwnerActor()))
        .post(`/api/issues/${issueId}/comments`)
        .send({ body: "Reopening this.", reopen: true });

      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body.error).toBe("Creator/manager comment grant is comment-only");
      expect(res.body.details?.reason).toBe("allow_manager_chain");
      // The consequence: the source issue must never be carried to `todo` by the grant.
      expect(mockIssueService.update).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ status: "todo" }),
      );
    });

    // `resume` is the other half of the same door; neutering only `reopen` would leave it open.
    it("does not let the recovery owner resume a blocked source issue via the comment grant", async () => {
      denyCommentGrantEverywhere();
      mockIssueService.getById.mockResolvedValue(makeIssue({
        status: "blocked",
        checkoutRunId: ownerRunId,
        executionRunId: ownerRunId,
      }) as never);
      mockIssueService.getDependencyReadiness.mockResolvedValue({
        unresolvedBlockerCount: 0,
        unresolvedBlockerIssueIds: [],
      } as never);
      mockIssueRecoveryActionService.getActiveForIssue.mockResolvedValue(
        makeRecoveryAction({ ownerAgentId: peerAgentId }) as never,
      );

      const res = await request(await createApp(recoveryOwnerActor()))
        .post(`/api/issues/${issueId}/comments`)
        .send({ body: "Resuming this.", resume: true });

      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body.error).toBe("Recovery owner grant is comment-only");
      expect(mockIssueService.addComment).not.toHaveBeenCalled();
      expect(mockIssueService.update).not.toHaveBeenCalled();
    });

    // The refusal must not swallow the grant's actual purpose: a plain comment on a
    // `blocked` source issue — the exact discharge path BLO-18996 exists to restore —
    // still has to land.
    it("still lets the recovery owner comment on a blocked source issue without reopen", async () => {
      denyCommentGrantEverywhere();
      mockIssueService.getById.mockResolvedValue(makeIssue({
        status: "blocked",
        checkoutRunId: ownerRunId,
        executionRunId: ownerRunId,
      }) as never);
      mockIssueRecoveryActionService.getActiveForIssue.mockResolvedValue(
        makeRecoveryAction({ ownerAgentId: peerAgentId }) as never,
      );

      const res = await request(await createApp(recoveryOwnerActor()))
        .post(`/api/issues/${issueId}/comments`)
        .send({ body: "I cannot restore this; escalating." });

      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(mockIssueService.addComment).toHaveBeenCalled();
    });

    // Company isolation fires earlier than the grant (the issue is not even resolvable
    // for a foreign-company actor), so the grant can never be the thing that admits one.
    it("does not admit a cross-company actor through the recovery owner grant", async () => {
      denyCommentGrantEverywhere();
      mockIssueService.getById.mockResolvedValue(makeIssue({
        checkoutRunId: ownerRunId,
        executionRunId: ownerRunId,
      }) as never);
      mockIssueRecoveryActionService.getActiveForIssue.mockResolvedValue(
        makeRecoveryAction({ ownerAgentId: peerAgentId }) as never,
      );

      const res = await request(await createApp(peerActor({
        companyId: "88888888-8888-4888-8888-888888888888",
        runId: "9a9a9a9a-9a9a-4a9a-8a9a-9a9a9a9a9a9a",
      })))
        .post(`/api/issues/${issueId}/comments`)
        .send({ body: "Different company." });

      expect(res.status, JSON.stringify(res.body)).toBe(404);
      expect(mockIssueService.addComment).not.toHaveBeenCalled();
    });
  });

  // BLO-19087: an @-mention fires an `issue_comment_mentioned` wake with no gate
  // on who authored it, but the grant only lands when the mention's author is
  // the issue's own assignee. The mentioned agent was therefore invited onto a
  // thread it could not post to, and the 403 named the boundary ("grant")
  // without naming the one act that clears it. These pin the deny as
  // *actionable* rather than widening it.
  describe("mention-wake reply guidance (BLO-19087)", () => {
    const denyCommentGrant = async (input: { action: string }) => ({
      allowed: input.action === "issue:read",
      action: input.action,
      reason: input.action === "issue:read" ? "allow_explicit_grant" : "deny_missing_grant",
      explanation: input.action === "issue:read" ? "Allowed by test read grant." : "Missing permission.",
    });

    it("tells a mentioned non-assignee agent who can grant the reply and how", async () => {
      mockAccessService.decide.mockImplementation(denyCommentGrant);

      const res = await request(await createApp(peerActor()))
        .post(`/api/issues/${issueId}/comments`)
        .send({ body: "Replying to the FYI that woke me." });

      expect(res.status, JSON.stringify(res.body)).toBe(403);
      const remediation = res.body.details?.remediation;
      expect(remediation, JSON.stringify(res.body)).toBeTruthy();
      // Names the assignee as the only agent who can grant...
      expect(remediation).toContain(`agent://${ownerAgentId}`);
      // ...and the exact token they must write to do it.
      expect(remediation).toContain(`agent://${peerAgentId}`);
      // Corrects the specific false inference that caused the loop.
      expect(remediation).toMatch(/does not grant you comment access/i);
      // Names somewhere to respond instead, so the wake is not a dead end.
      expect(remediation).toMatch(/respond on an issue you are assigned to/i);
      expect(mockIssueService.addComment).not.toHaveBeenCalled();
    });

    // The manager-chain case. `allow_manager_chain` is gated to
    // `tasks:manage_active_checkouts`/`tasks:override_execution_stage`, so
    // managing the assignee confers no `issue:comment` right. That is the
    // intended least-privilege posture — assert the deny, and assert it still
    // arrives with guidance rather than silently.
    it("denies a managing agent the same way, but with actionable guidance", async () => {
      mockAccessService.decide.mockImplementation(denyCommentGrant);
      mockIssueService.getById.mockResolvedValue(makeIssue({ assigneeAgentId: ownerAgentId }));

      const managerActor = peerActor({ agentId: staleAgentId });
      const res = await request(await createApp(managerActor))
        .post(`/api/issues/${issueId}/comments`)
        .send({ body: "I manage the assignee." });

      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body.details).toMatchObject({ reason: "deny_missing_grant", boundary: "grant" });
      expect(res.body.details.remediation).toContain(`agent://${staleAgentId}`);
      expect(mockIssueService.addComment).not.toHaveBeenCalled();
    });

    // Guidance must not be attached to denials it cannot explain. A
    // trust-boundary rejection is not fixed by getting mentioned, and saying so
    // would send the agent chasing a grant that would not help.
    it("omits mention guidance when a different boundary fired", async () => {
      mockAccessService.decide.mockImplementation(async (input: { action: string }) => ({
        allowed: false,
        action: input.action,
        reason: "deny_low_trust_boundary",
        explanation: "Issue is outside this low-trust boundary.",
      }));

      const res = await request(await createApp(peerActor()))
        .post(`/api/issues/${issueId}/comments`)
        .send({ body: "Wrong boundary." });

      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body.details).not.toHaveProperty("remediation");
    });

    // The mention grant genuinely works when the assignee is the author; this
    // change must not narrow it.
    it("still allows the comment when the mention grant does apply", async () => {
      mockAccessService.decide.mockImplementation(async (input: { action: string }) => ({
        allowed: input.action === "issue:read" || input.action === "issue:comment",
        action: input.action,
        reason: input.action === "issue:comment" ? "allow_issue_mention_grant" : "allow_explicit_grant",
        explanation: "Allowed by a mention-scoped issue comment grant.",
      }));

      const res = await request(await createApp(peerActor()))
        .post(`/api/issues/${issueId}/comments`)
        .send({ body: "Mentioned by the assignee, so this lands." });

      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(mockIssueService.addComment).toHaveBeenCalledTimes(1);
    });
  });

  it("rejects peer agents from listing comments when issue read is outside their boundary", async () => {
    mockAccessService.decide.mockImplementation(async (input: { action: string }) => ({
      allowed: false,
      action: input.action,
      reason: "deny_low_trust_boundary",
      explanation: "Issue is outside this low-trust boundary.",
    }));

    const res = await request(await createApp(peerActor()))
      .get(`/api/issues/${issueId}/comments`);

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toBe("Issue is outside this actor's authorization boundary (trust-boundary)");
    expect(mockAccessService.decide).toHaveBeenCalledWith(expect.objectContaining({ action: "issue:read" }));
  });

  it("rejects peer agents from listing interactions when issue read is outside their boundary", async () => {
    mockAccessService.decide.mockImplementation(async (input: { action: string }) => ({
      allowed: false,
      action: input.action,
      reason: "deny_low_trust_boundary",
      explanation: "Issue is outside this low-trust boundary.",
    }));

    const res = await request(await createApp(peerActor()))
      .get(`/api/issues/${issueId}/interactions`);

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toBe("Issue is outside this actor's authorization boundary (trust-boundary)");
    expect(mockAccessService.decide).toHaveBeenCalledWith(expect.objectContaining({ action: "issue:read" }));
    expect(mockIssueThreadInteractionService.listForIssue).not.toHaveBeenCalled();
  });

  it("allows mentioned peer agents to list comments through an issue read grant", async () => {
    mockAccessService.decide.mockImplementation(async (input: { action: string }) => ({
      allowed: input.action === "issue:read",
      action: input.action,
      reason: input.action === "issue:read" ? "allow_issue_mention_grant" : "deny_missing_grant",
      explanation:
        input.action === "issue:read"
          ? "Allowed by a mention-scoped issue comment grant."
          : "Missing permission.",
    }));

    const res = await request(await createApp(peerActor()))
      .get(`/api/issues/${issueId}/comments`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual([
      expect.objectContaining({
        id: "comment-1",
        body: "Mentioned reply context.",
      }),
    ]);
    expect(mockAccessService.decide).toHaveBeenCalledWith(expect.objectContaining({ action: "issue:read" }));
    expect(mockIssueService.listComments).toHaveBeenCalledWith(issueId, {
      afterCommentId: null,
      order: "desc",
      limit: null,
    });
  });

  it("rejects peer agents from reading a specific comment when issue read is outside their boundary", async () => {
    mockAccessService.decide.mockImplementation(async (input: { action: string }) => ({
      allowed: false,
      action: input.action,
      reason: "deny_low_trust_boundary",
      explanation: "Issue is outside this low-trust boundary.",
    }));

    const res = await request(await createApp(peerActor()))
      .get(`/api/issues/${issueId}/comments/comment-1`);

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toBe("Issue is outside this actor's authorization boundary (trust-boundary)");
    expect(mockAccessService.decide).toHaveBeenCalledWith(expect.objectContaining({ action: "issue:read" }));
    expect(mockIssueService.getComment).not.toHaveBeenCalled();
  });

  it("keeps true issue mutations denied for mentioned peer agents", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue({ status: "todo", assigneeAgentId: ownerAgentId }));
    mockAccessService.decide.mockImplementation(async (input: { action: string }) => ({
      allowed: input.action === "issue:comment" || input.action === "issue:mutate",
      action: input.action,
      reason:
        input.action === "issue:comment"
          ? "allow_issue_mention_grant"
          : input.action === "issue:mutate"
            ? "allow_explicit_grant"
            : "deny_missing_grant",
      explanation:
        input.action === "issue:comment"
          ? "Allowed by a mention-scoped issue comment grant."
          : input.action === "issue:mutate"
            ? "Allowed by test boundary default."
            : "Missing permission.",
    }));

    const res = await request(await createApp(peerActor()))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "done" });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toBe("Agent cannot mutate another agent's issue");
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("falls back to task assignment authorization when recovery checkout authorization lookup fails", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue({ status: "blocked", assigneeAgentId: ownerAgentId }));
    mockIssueRecoveryActionService.getActiveForIssue.mockRejectedValue(new Error("database timeout"));

    const actor = peerActor();
    const res = await request(await createApp(actor))
      .post(`/api/issues/${issueId}/checkout`)
      .send({ agentId: peerAgentId, expectedStatuses: ["blocked"] });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAccessService.decide).toHaveBeenCalledWith(expect.objectContaining({ action: "tasks:assign" }));
    expect(mockIssueService.checkout).toHaveBeenCalledWith(
      issueId,
      peerAgentId,
      ["blocked"],
      actor.runId,
      { allowSourceScopedRecoveryOwner: false, recoveryActionId: null, recoveryActionStatus: null },
    );
  });

  it("returns a contextual 500 when recovery checkout lookup fails and assignment fallback is denied", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue({ status: "blocked", assigneeAgentId: ownerAgentId }));
    mockIssueRecoveryActionService.getActiveForIssue.mockRejectedValue(new Error("database timeout"));
    mockAccessService.decide.mockImplementation(async (input: { action: string }) => ({
      allowed: input.action !== "tasks:assign",
      action: input.action,
      reason: input.action === "tasks:assign" ? "deny_missing_grant" : "allow_test_default",
      explanation: input.action === "tasks:assign" ? "Missing assignment grant." : "Allowed by test default.",
    }));

    const res = await request(await createApp(peerActor()))
      .post(`/api/issues/${issueId}/checkout`)
      .send({ agentId: peerAgentId, expectedStatuses: ["blocked"] });

    expect(res.status, JSON.stringify(res.body)).toBe(500);
    expect(res.body.error).toBe("Failed to verify recovery checkout authorization");
    expect(res.body.reason).toBe("recovery_lookup_failed");
    expect(mockIssueService.checkout).not.toHaveBeenCalled();
  });

  it.each(["active", "escalated"])(
    "allows source-scoped recovery owner checkout when recovery action is %s",
    async (status) => {
      mockIssueService.getById.mockResolvedValue(makeIssue({ status: "blocked", assigneeAgentId: ownerAgentId }));
      mockIssueRecoveryActionService.getActiveForIssue.mockResolvedValue(makeRecoveryAction({ status }));

      const actor = peerActor();
      const res = await request(await createApp(actor))
        .post(`/api/issues/${issueId}/checkout`)
        .send({ agentId: peerAgentId, expectedStatuses: ["blocked"] });

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.assigneeAgentId).toBe(peerAgentId);
      expect(mockAccessService.decide).not.toHaveBeenCalledWith(expect.objectContaining({ action: "tasks:assign" }));
      expect(mockIssueService.checkout).toHaveBeenCalledWith(
        issueId,
        peerAgentId,
        ["blocked"],
        actor.runId,
        { allowSourceScopedRecoveryOwner: true, recoveryActionId, recoveryActionStatus: status },
      );
    },
  );

  it("rejects source-scoped recovery checkout for non-active recovery action status", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue({ status: "blocked", assigneeAgentId: ownerAgentId }));
    mockIssueRecoveryActionService.getActiveForIssue.mockResolvedValue(makeRecoveryAction({ status: "resolved" }));
    mockAccessService.decide.mockImplementation(async (input: { action: string }) => ({
      allowed: input.action !== "tasks:assign",
      action: input.action,
      reason: input.action === "tasks:assign" ? "deny_missing_grant" : "allow_test_default",
      explanation: input.action === "tasks:assign" ? "Missing assignment grant." : "Allowed by test default.",
    }));

    const res = await request(await createApp(peerActor()))
      .post(`/api/issues/${issueId}/checkout`)
      .send({ agentId: peerAgentId, expectedStatuses: ["blocked"] });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toBe("Missing assignment grant.");
    expect(mockIssueService.checkout).not.toHaveBeenCalled();
  });

  it("denies cross-company agents before comment authorization is evaluated", async () => {
    const res = await request(await createApp(peerActor({ companyId: "99999999-9999-4999-8999-999999999999" })))
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "Wrong company." });

    // Cross-tenant requests return 404 (not 403) so the response is
    // indistinguishable from a nonexistent issue — no existence oracle.
    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(res.body.error).toBe("Issue not found");
    expect(mockAccessService.decide).not.toHaveBeenCalledWith(expect.objectContaining({ action: "issue:comment" }));
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });

  it("rejects the checked-out owner without a run id on attachment upload (401)", async () => {
    // Regression: an agent-authenticated client (e.g. the CLI's attachment:upload)
    // that fails to send X-Paperclip-Run-Id must be rejected — mutating your own
    // in-progress checkout requires proving run ownership.
    const app = await createApp({
      type: "agent",
      agentId: ownerAgentId,
      companyId,
      source: "agent_key",
      // intentionally no runId
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/issues/${issueId}/attachments`)
      .attach("file", Buffer.from("report"), { filename: "report.html", contentType: "text/html" });

    expect(res.status, JSON.stringify(res.body)).toBe(401);
    expect(res.body.error).toBe("Agent run id required");
    expect(mockStorageService.putFile).not.toHaveBeenCalled();
  });

  it("allows the checked-out owner with the matching run id to patch and update documents", async () => {
    const app = await createApp(ownerActor());

    await request(app).patch(`/api/issues/${issueId}`).send({ title: "Updated" }).expect(200);
    await request(app)
      .put(`/api/issues/${issueId}/documents/plan`)
      .send({ format: "markdown", body: "# updated" })
      .expect(200);

    expect(mockIssueService.assertCheckoutOwner).toHaveBeenCalledWith(issueId, ownerAgentId, ownerRunId);
    expect(mockIssueService.update).toHaveBeenCalled();
    expect(mockDocumentService.upsertIssueDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        issueId,
        key: "plan",
        createdByAgentId: ownerAgentId,
        createdByRunId: ownerRunId,
        lockedDocumentStrategy: "create_new_document",
      }),
    );
  });

  it("allows the assignee to append evidence comments from a different sweep run", async () => {
    mockAccessService.decide.mockImplementation(async (input: { action: string }) => ({
      allowed: input.action === "issue:comment" || input.action === "issue:read",
      action: input.action,
      reason: "allow_test_default",
      explanation: "Allowed by same-assignee comment regression test.",
    }));
    const app = await createApp(ownerActorFromSweepRun());
    const { HttpError } = await vi.importActual<typeof import("../errors.js")>("../errors.js");
    const runLockError = new HttpError(409, "Issue run ownership conflict");
    mockIssueService.assertCheckoutOwner.mockRejectedValue(runLockError);

    const res = await request(app)
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "recurrence evidence" });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockIssueService.assertCheckoutOwner).not.toHaveBeenCalled();
    expect(mockIssueService.addComment).toHaveBeenCalledWith(
      issueId,
      "recurrence evidence",
      expect.objectContaining({ agentId: ownerAgentId, runId: "88888888-8888-4888-8888-888888888888" }),
      expect.any(Object),
    );
  });

  it("requires an agent run id before bypassing checkout ownership for same-assignee comments", async () => {
    mockAccessService.decide.mockImplementation(async (input: { action: string }) => ({
      allowed: input.action === "issue:comment" || input.action === "issue:read",
      action: input.action,
      reason: "allow_test_default",
      explanation: "Allowed by same-assignee comment regression test.",
    }));
    const app = await createApp({ ...ownerActor(), runId: undefined });

    const res = await request(app)
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "unaudited evidence" });

    expect(res.status, JSON.stringify(res.body)).toBe(401);
    expect(res.body.error).toBe("Agent run id required");
    expect(mockIssueService.assertCheckoutOwner).not.toHaveBeenCalled();
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });

  it("still enforces checkout run ownership for same-assignee state mutations", async () => {
    const app = await createApp(ownerActorFromSweepRun());
    const { HttpError } = await vi.importActual<typeof import("../errors.js")>("../errors.js");
    const runLockError = new HttpError(409, "Issue run ownership conflict");
    mockIssueService.assertCheckoutOwner.mockRejectedValue(runLockError);

    const res = await request(app)
      .patch(`/api/issues/${issueId}`)
      .send({ title: "Unsafe sweep update" });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error).toBe("Issue run ownership conflict");
    expect(mockIssueService.assertCheckoutOwner).toHaveBeenCalledWith(
      issueId,
      ownerAgentId,
      "88888888-8888-4888-8888-888888888888",
    );
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("stores the authenticated agent run id when creating work products", async () => {
    const app = await createApp(ownerActor());

    await request(app).post(`/api/issues/${issueId}/work-products`).send({
      type: "artifact",
      provider: "test",
      title: "Artifact",
    }).expect(201);

    expect(mockWorkProductService.createForIssue).toHaveBeenCalledWith(
      issueId,
      companyId,
      expect.objectContaining({ createdByRunId: ownerRunId }),
    );
  });

  it("rejects agent-created work products with a forged run id", async () => {
    const app = await createApp(ownerActor());

    const res = await request(app).post(`/api/issues/${issueId}/work-products`).send({
      type: "artifact",
      provider: "test",
      title: "Artifact",
      createdByRunId: "66666666-6666-4666-8666-666666666666",
    });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toBe("createdByRunId must match the authenticated agent run");
    expect(mockWorkProductService.createForIssue).not.toHaveBeenCalled();
  });

  it("rejects work product updates with a forged agent run id", async () => {
    const app = await createApp(ownerActor());

    const res = await request(app).patch("/api/work-products/product-1").send({
      createdByRunId: "66666666-6666-4666-8666-666666666666",
    });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toBe("createdByRunId must match the authenticated agent run");
    expect(mockWorkProductService.update).not.toHaveBeenCalled();
  });

  it("rejects board-created work products with a foreign-company run id", async () => {
    const app = await createApp(
      boardActor(),
      createRunContextDb({}, [{
        id: "66666666-6666-4666-8666-666666666666",
        companyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        agentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        agentCompanyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        contextSnapshot: {},
      }]),
    );

    const res = await request(app).post(`/api/issues/${issueId}/work-products`).send({
      type: "artifact",
      provider: "test",
      title: "Artifact",
      createdByRunId: "66666666-6666-4666-8666-666666666666",
    });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toBe("createdByRunId is not valid for this company");
    expect(mockWorkProductService.createForIssue).not.toHaveBeenCalled();
  });

  it.each([
    [
      "work product create",
      (app: express.Express) =>
        request(app).post(`/api/issues/${issueId}/work-products`).send({
          type: "artifact",
          provider: "test",
          title: "Artifact",
        }),
      "Cheap status-only recovery runs cannot update issue documents",
    ],
    [
      "work product update",
      (app: express.Express) => request(app).patch("/api/work-products/product-1").send({ title: "Blocked" }),
      "Cheap status-only recovery runs cannot update issue documents",
    ],
    [
      "work product delete",
      (app: express.Express) => request(app).delete("/api/work-products/product-1"),
      "Cheap status-only recovery runs cannot update issue documents",
    ],
    [
      "low-trust promotion",
      (app: express.Express) =>
        request(app).post(`/api/issues/${issueId}/low-trust/promotions`).send({
          sourceArtifactKind: "comment",
          sourceArtifactId: recoveryActionId,
          title: "Promoted artifact",
          summary: "Sanitized output",
        }),
      "Cheap status-only recovery runs cannot update issue documents",
    ],
    [
      "attachment upload",
      (app: express.Express) =>
        request(app)
          .post(`/api/companies/${companyId}/issues/${issueId}/attachments`)
          .attach("file", Buffer.from("report"), { filename: "report.txt", contentType: "text/plain" }),
      "Cheap status-only recovery runs cannot update issue documents",
    ],
    [
      "attachment delete",
      (app: express.Express) => request(app).delete("/api/attachments/attachment-1"),
      "Cheap status-only recovery runs cannot update issue documents",
    ],
    [
      "issue approval link",
      (app: express.Express) =>
        request(app).post(`/api/issues/${issueId}/approvals`).send({
          approvalId: "88888888-8888-4888-8888-888888888888",
        }),
      "Cheap status-only recovery runs cannot create or modify approvals",
    ],
    [
      "issue approval unlink",
      (app: express.Express) =>
        request(app).delete(`/api/issues/${issueId}/approvals/88888888-8888-4888-8888-888888888888`),
      "Cheap status-only recovery runs cannot create or modify approvals",
    ],
  ])("blocks cheap status-only recovery runs from %s", async (_name, sendRequest, expectedError) => {
    const app = await createApp(
      ownerActor(),
      createRunContextDb({
        modelProfile: "cheap",
        recoveryIntent: "status_only",
        allowDeliverableWork: false,
        allowDocumentUpdates: false,
        resumeRequiresNormalModel: true,
      }),
    );

    const res = await sendRequest(app);

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toContain(expectedError);
    expect(mockIssueService.assertCheckoutOwner).toHaveBeenCalledWith(issueId, ownerAgentId, ownerRunId);
    expect(mockWorkProductService.createForIssue).not.toHaveBeenCalled();
    expect(mockWorkProductService.update).not.toHaveBeenCalled();
    expect(mockWorkProductService.remove).not.toHaveBeenCalled();
    expect(mockStorageService.putFile).not.toHaveBeenCalled();
    expect(mockStorageService.deleteObject).not.toHaveBeenCalled();
    expect(mockIssueService.removeAttachment).not.toHaveBeenCalled();
    expect(mockIssueApprovalService.link).not.toHaveBeenCalled();
    expect(mockIssueApprovalService.unlink).not.toHaveBeenCalled();
  });

  it.each([
    [
      "issue create",
      (app: express.Express) =>
        request(app).post(`/api/companies/${companyId}/issues`).send({
          title: "Downstream source work",
          assigneeAdapterOverrides: { modelProfile: "cheap" },
        }),
      "Low-trust agents must create child issues inside their assigned boundary",
    ],
    [
      "child issue create",
      (app: express.Express) =>
        request(app).post(`/api/issues/${issueId}/children`).send({
          title: "Downstream child source work",
          assigneeAdapterOverrides: { modelProfile: "cheap" },
        }),
      "cannot assign downstream issue work to the cheap model profile",
    ],
    [
      "issue update",
      (app: express.Express) =>
        request(app).patch(`/api/issues/${issueId}`).send({
          assigneeAdapterOverrides: { modelProfile: "cheap" },
        }),
      "cannot assign downstream issue work to the cheap model profile",
    ],
  ])("blocks cheap status-only recovery runs from propagating cheap profile through %s", async (_name, sendRequest, expectedError) => {
    const app = await createApp(
      ownerActor(),
      createRunContextDb({
        modelProfile: "cheap",
        recoveryIntent: "status_only",
        allowDeliverableWork: false,
        allowDocumentUpdates: false,
        resumeRequiresNormalModel: true,
      }),
    );

    const res = await sendRequest(app);

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toContain(expectedError);
    expect(mockIssueService.create).not.toHaveBeenCalled();
    expect(mockIssueService.createChild).not.toHaveBeenCalled();
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("defaults agent-created root follow-up issues to inherit the current run workspace", async () => {
    allowStandardAgentRootIssueCreation();
    const app = await createApp(
      ownerActor(),
      createRunContextDb({
        issueId,
        executionWorkspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      }),
    );

    const res = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Follow-up in same worktree",
        projectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockIssueService.create).toHaveBeenCalledWith(
      companyId,
      expect.objectContaining({
        title: "Follow-up in same worktree",
        inheritExecutionWorkspaceFromIssueId: issueId,
      }),
    );
  });

  it("preserves explicit workspace choices on agent-created root issues", async () => {
    allowStandardAgentRootIssueCreation();
    const app = await createApp(
      ownerActor(),
      createRunContextDb({
        issueId,
        executionWorkspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      }),
    );

    const explicitExecutionWorkspaceId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const res = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Explicit different workspace",
        executionWorkspaceId: explicitExecutionWorkspaceId,
        executionWorkspacePreference: "reuse_existing",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockIssueService.create).toHaveBeenCalledWith(
      companyId,
      expect.objectContaining({
        title: "Explicit different workspace",
        executionWorkspaceId: explicitExecutionWorkspaceId,
        executionWorkspacePreference: "reuse_existing",
      }),
    );
    expect(mockIssueService.create).toHaveBeenCalledWith(
      companyId,
      expect.not.objectContaining({
        inheritExecutionWorkspaceFromIssueId: issueId,
      }),
    );
  });

  it("rejects agent-created issues that supply responsibleUserId", async () => {
    const app = await createApp(ownerActor());

    const res = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Spoof responsible user",
        responsibleUserId: "spoofed-user",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toContain("responsibleUserId");
    expect(mockIssueService.create).not.toHaveBeenCalled();
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId,
        actorType: "agent",
        actorId: ownerAgentId,
        action: "issue.attribution_spoof_rejected",
        entityType: "company",
        details: expect.objectContaining({
          surface: "issues.create",
          field: "responsibleUserId",
          requestedValue: "spoofed-user",
        }),
      }),
    );
  });

  it("strips agent-supplied createdByUserId and derives attribution from the authenticated actor", async () => {
    allowStandardAgentRootIssueCreation();
    const app = await createApp(ownerActor());

    const res = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Spoof creator",
        createdByUserId: "spoofed-user",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockIssueService.create).toHaveBeenCalledWith(
      companyId,
      expect.objectContaining({
        title: "Spoof creator",
        createdByAgentId: ownerAgentId,
        createdByUserId: null,
        actorRunId: ownerRunId,
      }),
    );
    expect(mockIssueService.create).toHaveBeenCalledWith(
      companyId,
      expect.not.objectContaining({
        createdByUserId: "spoofed-user",
      }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId,
        actorType: "agent",
        actorId: ownerAgentId,
        action: "issue.attribution_spoof_stripped",
        details: expect.objectContaining({
          surface: "issues.create",
          field: "createdByUserId",
          requestedValue: "spoofed-user",
        }),
      }),
    );
  });

  it("allows board-created issues to pass explicit responsibleUserId as trusted attribution", async () => {
    const app = await createApp(boardActor());

    const res = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Board-owned work",
        responsibleUserId: "responsible-board-user",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockIssueService.create).toHaveBeenCalledWith(
      companyId,
      expect.objectContaining({
        title: "Board-owned work",
        responsibleUserId: "responsible-board-user",
        createdByUserId: "board-user",
        trustExplicitResponsibleUserId: true,
      }),
    );
  });

  it("rejects agent-created child issues that supply responsibleUserId", async () => {
    const app = await createApp(ownerActor());

    const res = await request(app)
      .post(`/api/issues/${issueId}/children`)
      .send({
        title: "Spoof child responsible user",
        responsibleUserId: "spoofed-user",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(mockIssueService.createChild).not.toHaveBeenCalled();
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId,
        action: "issue.attribution_spoof_rejected",
        entityType: "issue",
        entityId: issueId,
        details: expect.objectContaining({
          surface: "issues.children.create",
          field: "responsibleUserId",
        }),
      }),
    );
  });

  it("rejects accepted-plan child creation when an agent child body supplies responsibleUserId", async () => {
    const app = await createApp(ownerActor());

    const res = await request(app)
      .post(`/api/issues/${issueId}/accepted-plan-decompositions`)
      .send({
        acceptedPlanRevisionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        children: [
          {
            title: "Spoof plan child responsible user",
            responsibleUserId: "spoofed-user",
          },
        ],
      });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(mockIssueService.decomposeAcceptedPlan).not.toHaveBeenCalled();
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId,
        action: "issue.attribution_spoof_rejected",
        entityType: "issue",
        entityId: issueId,
        details: expect.objectContaining({
          surface: "issues.accepted_plan_decomposition",
          field: "responsibleUserId",
        }),
      }),
    );
  });

  it("allows board users to set explicit cheap issue assignee profile overrides", async () => {
    const app = await createApp(boardActor());

    await request(app)
      .patch(`/api/issues/${issueId}`)
      .send({ assigneeAdapterOverrides: { modelProfile: "cheap" } })
      .expect(200);

    expect(mockIssueService.update).toHaveBeenCalledWith(
      issueId,
      expect.objectContaining({
        assigneeAdapterOverrides: { modelProfile: "cheap" },
      }),
    );
  });

  it("preserves committed issue updates, comments, documents, and work product writes when recovery revalidation fails", async () => {
    mockAccessService.decide.mockImplementation(async (input: { action: string }) => ({
      allowed:
        input.action === "issue:comment" ||
        input.action === "issue:mutate" ||
        input.action === "issue:read",
      action: input.action,
      reason: "allow_test_default",
      explanation: "Allowed by recovery revalidation regression test.",
    }));
    const app = await createApp(ownerActor());

    mockIssueRecoveryActionService.getActiveForIssue.mockRejectedValueOnce(new Error("revalidation read failed"));
    await request(app)
      .patch(`/api/issues/${issueId}`)
      .send({ title: "Updated after commit" })
      .expect(200);

    mockIssueRecoveryActionService.getActiveForIssue.mockRejectedValueOnce(new Error("revalidation read failed"));
    await request(app)
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "progress update" })
      .expect(201);

    mockIssueRecoveryActionService.getActiveForIssue.mockRejectedValueOnce(new Error("revalidation read failed"));
    await request(app)
      .put(`/api/issues/${issueId}/documents/plan`)
      .send({ format: "markdown", body: "# updated" })
      .expect(200);

    mockIssueRecoveryActionService.getActiveForIssue.mockRejectedValueOnce(new Error("revalidation read failed"));
    await request(app)
      .patch("/api/work-products/product-1")
      .send({ title: "Updated product" })
      .expect(200);

    expect(mockIssueService.update).toHaveBeenCalledWith(
      issueId,
      expect.objectContaining({ title: "Updated after commit" }),
    );
    expect(mockIssueService.addComment).toHaveBeenCalledWith(
      issueId,
      "progress update",
      expect.any(Object),
      expect.any(Object),
    );
    expect(mockDocumentService.upsertIssueDocument).toHaveBeenCalled();
    expect(mockWorkProductService.update).toHaveBeenCalledWith("product-1", { title: "Updated product" });
  });

  it("preserves board mutations on active checkouts", async () => {
    const app = await createApp(boardActor());

    await request(app).patch(`/api/issues/${issueId}`).send({ title: "Board update" }).expect(200);
    await request(app)
      .put(`/api/issues/${issueId}/documents/plan`)
      .send({ format: "markdown", body: "# board" })
      .expect(200);

    expect(mockIssueService.assertCheckoutOwner).not.toHaveBeenCalled();
    expect(mockIssueService.update).toHaveBeenCalled();
    expect(mockDocumentService.upsertIssueDocument).toHaveBeenCalled();
  });

  it("allows agents with the active-checkout management grant to mutate active checkouts", async () => {
    mockAccessService.decide.mockImplementation(async (input: { action: string }) => ({
      allowed: input.action === "tasks:manage_active_checkouts" || input.action === "issue:mutate",
      action: input.action,
      reason:
        input.action === "tasks:manage_active_checkouts"
          ? "allow_explicit_grant"
          : input.action === "issue:mutate"
          ? "allow_company_agent"
          : "deny_missing_grant",
      explanation:
        input.action === "tasks:manage_active_checkouts"
          ? "Allowed by checkout management grant."
          : input.action === "issue:mutate"
          ? "Allowed by test issue boundary."
          : "Missing permission.",
    }));

    const res = await request(await createApp(peerActor())).patch(`/api/issues/${issueId}`).send({ title: "Managed update" });

    expect(res.status).toBe(200);
    expect(mockIssueService.assertCheckoutOwner).not.toHaveBeenCalled();
    expect(mockIssueService.update).toHaveBeenCalled();
  });

  it("allows the creator of a delegated child issue to post comments through production authorization (BLO-18113)", async () => {
    useProductionIssueAuthorization([
      makeAgent(peerAgentId),
      makeAgent(ownerAgentId),
    ]);
    mockIssueService.getById.mockResolvedValue(makeIssue({ assigneeAgentId: ownerAgentId, createdByAgentId: peerAgentId }));

    const res = await request(await createApp(peerActor()))
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "Correction from the delegating creator" });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockIssueService.addComment).toHaveBeenCalledWith(
      issueId,
      "Correction from the delegating creator",
      expect.any(Object),
      expect.any(Object),
    );
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("allows a manager-chain agent to post comments through production authorization (BLO-18113)", async () => {
    useProductionIssueAuthorization([
      makeAgent(peerAgentId),
      makeAgent(ownerAgentId, { reportsTo: peerAgentId }),
    ]);
    mockIssueService.getById.mockResolvedValue(makeIssue({ assigneeAgentId: ownerAgentId, createdByAgentId: ownerAgentId }));

    const res = await request(await createApp(peerActor()))
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "Manager guidance for the delegated issue" });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockIssueService.addComment).toHaveBeenCalledWith(
      issueId,
      "Manager guidance for the delegated issue",
      expect.any(Object),
      expect.any(Object),
    );
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  const commentOnlyAutoApprovalCases: Array<[string, Record<string, unknown>[], Record<string, unknown>]> = [
    ["creator", [makeAgent(peerAgentId), makeAgent(ownerAgentId)], { createdByAgentId: peerAgentId }],
    ["manager-chain", [makeAgent(peerAgentId), makeAgent(ownerAgentId, { reportsTo: peerAgentId })], { createdByAgentId: ownerAgentId }],
  ];

  it.each(commentOnlyAutoApprovalCases)(
    "does not let a %s comment grant auto-approve an in_review issue",
    async (_kind, agentRows, issueOverrides) => {
      const reviewBody = "## Review: APPROVED";
      useProductionIssueAuthorization(agentRows);
      mockIssueService.getById.mockResolvedValue(
        await makePendingReviewIssueForAgent(peerAgentId, {
          assigneeAgentId: ownerAgentId,
          ...issueOverrides,
        }),
      );
      mockIssueService.addComment.mockResolvedValue({
        id: "comment-comment-grant-approval",
        issueId,
        companyId,
        body: reviewBody,
        createdAt: new Date(),
        updatedAt: new Date(),
        authorAgentId: peerAgentId,
        authorUserId: null,
      });

      const res = await request(await createApp(peerActor()))
        .post(`/api/issues/${issueId}/comments`)
        .send({ body: reviewBody });

      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(mockIssueService.addComment).toHaveBeenCalledTimes(1);
      expect(mockIssueService.update).not.toHaveBeenCalled();
    },
  );

  const commentOnlyTransitionCases: Array<[
    string,
    Record<string, unknown>[],
    Record<string, unknown>,
    "done" | "blocked",
    Record<string, boolean>,
    string,
  ]> = [
    [
      "creator",
      [makeAgent(peerAgentId), makeAgent(ownerAgentId)],
      { createdByAgentId: peerAgentId },
      "done",
      { reopen: true },
      "allow_issue_creator",
    ],
    [
      "creator",
      [makeAgent(peerAgentId), makeAgent(ownerAgentId)],
      { createdByAgentId: peerAgentId },
      "done",
      { resume: true },
      "allow_issue_creator",
    ],
    [
      "creator",
      [makeAgent(peerAgentId), makeAgent(ownerAgentId)],
      { createdByAgentId: peerAgentId },
      "blocked",
      { reopen: true },
      "allow_issue_creator",
    ],
    [
      "creator",
      [makeAgent(peerAgentId), makeAgent(ownerAgentId)],
      { createdByAgentId: peerAgentId },
      "blocked",
      { resume: true },
      "allow_issue_creator",
    ],
    [
      "manager-chain",
      [makeAgent(peerAgentId), makeAgent(ownerAgentId, { reportsTo: peerAgentId })],
      { createdByAgentId: ownerAgentId },
      "done",
      { reopen: true },
      "allow_manager_chain",
    ],
    [
      "manager-chain",
      [makeAgent(peerAgentId), makeAgent(ownerAgentId, { reportsTo: peerAgentId })],
      { createdByAgentId: ownerAgentId },
      "done",
      { resume: true },
      "allow_manager_chain",
    ],
    [
      "manager-chain",
      [makeAgent(peerAgentId), makeAgent(ownerAgentId, { reportsTo: peerAgentId })],
      { createdByAgentId: ownerAgentId },
      "blocked",
      { reopen: true },
      "allow_manager_chain",
    ],
    [
      "manager-chain",
      [makeAgent(peerAgentId), makeAgent(ownerAgentId, { reportsTo: peerAgentId })],
      { createdByAgentId: ownerAgentId },
      "blocked",
      { resume: true },
      "allow_manager_chain",
    ],
  ];

  it.each(commentOnlyTransitionCases)(
    "refuses %s comment grants with %s transition flags on %s issues",
    async (_kind, agentRows, issueOverrides, status, transition, expectedReason) => {
      useProductionIssueAuthorization(agentRows);
      mockIssueService.getById.mockResolvedValue(
        makeIssue({ status, assigneeAgentId: ownerAgentId, ...issueOverrides }),
      );

      const res = await request(await createApp(peerActor()))
        .post(`/api/issues/${issueId}/comments`)
        .send({ body: "Delegated guidance plus an attempted status transition.", ...transition });

      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body.error).toBe("Creator/manager comment grant is comment-only");
      expect(res.body.details).toMatchObject({ reason: expectedReason });
      expect(mockIssueService.addComment).not.toHaveBeenCalled();
      expect(mockIssueService.update).not.toHaveBeenCalled();
    },
  );

  const commentGrantMutationDenialCases: Array<[string, Record<string, unknown>[], Record<string, unknown>]> = [
    ["creator", [makeAgent(peerAgentId), makeAgent(ownerAgentId)], { createdByAgentId: peerAgentId }],
    ["manager-chain", [makeAgent(peerAgentId), makeAgent(ownerAgentId, { reportsTo: peerAgentId })], { createdByAgentId: ownerAgentId }],
  ];

  it.each(commentGrantMutationDenialCases)("keeps generic issue mutations denied for a %s comment grant holder", async (_kind, agentRows, issueOverrides) => {
    useProductionIssueAuthorization(agentRows);
    mockIssueService.getById.mockResolvedValue(makeIssue({ assigneeAgentId: ownerAgentId, ...issueOverrides }));

    const patchRes = await request(await createApp(peerActor()))
      .patch(`/api/issues/${issueId}`)
      .send({ title: "Not just a comment" });

    expect(patchRes.status, JSON.stringify(patchRes.body)).toBe(403);
    expect(patchRes.body.details).toMatchObject({ reason: "deny_missing_grant", boundary: "grant" });
    expect(mockIssueService.update).not.toHaveBeenCalled();

    mockIssueService.getById.mockResolvedValue(makeIssue({ assigneeAgentId: ownerAgentId, ...issueOverrides }));

    const deleteRes = await request(await createApp(peerActor()))
      .delete(`/api/issues/${issueId}`);

    expect(deleteRes.status, JSON.stringify(deleteRes.body)).toBe(403);
    expect(deleteRes.body.details).toMatchObject({ reason: "deny_missing_grant", boundary: "grant" });
    expect(mockIssueService.remove).not.toHaveBeenCalled();
  });

  it.each(commentGrantMutationDenialCases)(
    "lets an exact blocked-to-todo delegate recovery patch proceed for a %s comment grant holder",
    async (_kind, agentRows, issueOverrides) => {
      useProductionIssueAuthorization(agentRows);
      const stored = makeIssue({
        status: "blocked",
        assigneeAgentId: ownerAgentId,
        ...issueOverrides,
      });
      mockIssueService.getById.mockResolvedValue(stored);
      mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
        ...stored,
        ...patch,
      }));

      const res = await request(await createApp(peerActor()))
        .patch(`/api/issues/${issueId}`)
        .send({ status: "todo", blockedByIssueIds: [] });

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(mockIssueService.assertCheckoutOwner).not.toHaveBeenCalled();
      expect(mockIssueService.update).toHaveBeenCalled();
      const [, patch] = mockIssueService.update.mock.calls.at(-1) as [string, Record<string, unknown>];
      expect(patch).toMatchObject({
        status: "todo",
        expectedCurrentStatus: "blocked",
        expectedCurrentAssigneeAgentId: ownerAgentId,
      });
      expect(patch.blockedByIssueIds).toEqual([]);
    },
  );

  it.each([
    { status: "done", blockedByIssueIds: [] },
    { status: "cancelled", blockedByIssueIds: [] },
    { status: "todo", blockedByIssueIds: ["99999999-9999-4999-8999-999999999999"] },
    { status: "todo", blockedByIssueIds: [], description: "Too broad" },
  ])("keeps non-exact delegate recovery patches denied: %o", async (body) => {
    useProductionIssueAuthorization([
      makeAgent(peerAgentId),
      makeAgent(ownerAgentId, { reportsTo: peerAgentId }),
    ]);
    mockIssueService.getById.mockResolvedValue(
      makeIssue({ status: "blocked", assigneeAgentId: ownerAgentId, createdByAgentId: ownerAgentId }),
    );

    const res = await request(await createApp(peerActor()))
      .patch(`/api/issues/${issueId}`)
      .send(body);

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.details).toMatchObject({ reason: "deny_missing_grant", boundary: "grant" });
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  // BLO-20385: the patch shape mandates `blockedByIssueIds: []` and that empty
  // array is applied, so admitting it on an issue with live blockers deletes
  // dependency edges the actor could not otherwise remove. Probed in production
  // on BLO-18946: a 200 silently dropped a live edge to a still-blocked issue.
  it.each(commentGrantMutationDenialCases)(
    "refuses the delegate recovery patch when blockers are unresolved, for a %s comment grant holder",
    async (_kind, agentRows, issueOverrides) => {
      useProductionIssueAuthorization(agentRows);
      mockIssueService.getById.mockResolvedValue(
        makeIssue({ status: "blocked", assigneeAgentId: ownerAgentId, ...issueOverrides }),
      );
      const liveBlockerId = "11111111-1111-4111-8111-111111111111";
      mockIssueService.getDependencyReadiness.mockResolvedValue({
        issueId,
        blockerIssueIds: [liveBlockerId],
        unresolvedBlockerCount: 1,
        unresolvedBlockerIssueIds: [liveBlockerId],
        pendingFinalizeBlockerIssueIds: [],
        allBlockersDone: false,
        isDependencyReady: false,
      });

      const res = await request(await createApp(peerActor()))
        .patch(`/api/issues/${issueId}`)
        .send({ status: "todo", blockedByIssueIds: [] });

      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(res.body.details).toMatchObject({
        reason: "delegate_recovery_unresolved_blockers",
        unresolvedBlockerCount: 1,
        unresolvedBlockerIssueIds: [liveBlockerId],
      });
      // The edge must survive: no write may reach the service at all.
      expect(mockIssueService.update).not.toHaveBeenCalled();
    },
  );

  it.each(commentGrantMutationDenialCases)(
    "still unparks past stale terminal blocker edges for a %s comment grant holder",
    async (_kind, agentRows, issueOverrides) => {
      useProductionIssueAuthorization(agentRows);
      const stored = makeIssue({ status: "blocked", assigneeAgentId: ownerAgentId, ...issueOverrides });
      mockIssueService.getById.mockResolvedValue(stored);
      mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
        ...stored,
        ...patch,
      }));
      // Edges exist but every one is terminal: clearing these is the whole point
      // of the recovery patch and must keep working.
      mockIssueService.getDependencyReadiness.mockResolvedValue({
        issueId,
        blockerIssueIds: ["22222222-2222-4222-8222-222222222222"],
        unresolvedBlockerCount: 0,
        unresolvedBlockerIssueIds: [],
        pendingFinalizeBlockerIssueIds: [],
        allBlockersDone: true,
        isDependencyReady: true,
      });

      const res = await request(await createApp(peerActor()))
        .patch(`/api/issues/${issueId}`)
        .send({ status: "todo", blockedByIssueIds: [] });

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const [, patch] = mockIssueService.update.mock.calls.at(-1) as [string, Record<string, unknown>];
      expect(patch).toMatchObject({ status: "todo", expectedCurrentStatus: "blocked" });
      expect(patch.blockedByIssueIds).toEqual([]);
    },
  );

  it("surfaces 409 when the issue stops being blocked before the delegate recovery write lands", async () => {
    useProductionIssueAuthorization([
      makeAgent(peerAgentId),
      makeAgent(ownerAgentId, { reportsTo: peerAgentId }),
    ]);
    mockIssueService.getById.mockResolvedValue(
      makeIssue({
        status: "blocked",
        assigneeAgentId: ownerAgentId,
        createdByAgentId: ownerAgentId,
      }),
    );
    const { conflict } = await vi.importActual<typeof import("../errors.js")>("../errors.js");
    mockIssueService.update.mockRejectedValue(
      conflict("Issue status changed before the update could be applied", {
        issueId,
        expectedStatus: "blocked",
        currentStatus: "in_progress",
      }),
    );

    const res = await request(await createApp(peerActor()))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "todo", blockedByIssueIds: [] });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error).toContain("status changed");
  });

  it("does not pin expectedCurrentStatus on an ordinary assignee patch", async () => {
    mockAccessService.decide.mockImplementation(async (input: { action: string }) => ({
      allowed: true,
      action: input.action,
      reason: "allow_self",
      explanation: "Assignee.",
    }));
    const stored = makeIssue({ status: "blocked", assigneeAgentId: ownerAgentId });
    mockIssueService.getById.mockResolvedValue(stored);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...stored,
      ...patch,
    }));

    const res = await request(await createApp(ownerActor()))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "todo", blockedByIssueIds: [] });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const [, patch] = mockIssueService.update.mock.calls.at(-1) as [string, Record<string, unknown>];
    expect(patch.expectedCurrentStatus).toBeUndefined();
    expect(patch.expectedCurrentAssigneeAgentId).toBeUndefined();
  });

  it.each([
    ["todo", "patch", (app: express.Express) => request(app).patch(`/api/issues/${issueId}`).send({ title: "Todo update" })],
    ["blocked", "patch", (app: express.Express) => request(app).patch(`/api/issues/${issueId}`).send({ title: "Blocked update" })],
  ])("rejects peer agent %s issue %s mutations outside active checkout ownership", async (status, _kind, sendRequest) => {
    mockIssueService.getById.mockResolvedValue(makeIssue({ status: status as "todo" | "blocked", assigneeAgentId: ownerAgentId }));

    const res = await sendRequest(await createApp(peerActor()));

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toBe("Agent cannot mutate another agent's issue");
    expect(mockIssueService.assertCheckoutOwner).not.toHaveBeenCalled();
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });

  it("allows same-company agent mutations on unassigned in-progress issues", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue({ assigneeAgentId: null }));
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeIssue({ assigneeAgentId: null }),
      ...patch,
    }));

    const res = await request(await createApp(peerActor())).patch(`/api/issues/${issueId}`).send({ title: "Claimable update" });

    expect(res.status).toBe(200);
    expect(mockIssueService.assertCheckoutOwner).not.toHaveBeenCalled();
    expect(res.body).toMatchObject({
      id: issueId,
      assigneeAgentId: null,
      title: "Claimable update",
    });
  });

  it("rejects peer-agent status updates that would clear a recovery action they do not own", async () => {
    mockIssueService.getById.mockResolvedValue(
      makeIssue({ status: "blocked", assigneeAgentId: null, assigneeUserId: "board-user" }),
    );
    mockIssueRecoveryActionService.getActiveForIssue.mockResolvedValue({
      id: recoveryActionId,
      ownerAgentId,
    } as never);

    const res = await request(await createApp(peerActor())).patch(`/api/issues/${issueId}`).send({ status: "todo" });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toBe("Agent cannot resolve another owner's recovery action");
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("blocks peer-agent source mutations while another agent owns the active recovery action", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue({ status: "blocked", assigneeAgentId: null }));
    mockIssueRecoveryActionService.getActiveForIssue.mockResolvedValue(makeRecoveryAction({
      ownerAgentId,
    }) as never);

    const res = await request(await createApp(peerActor()))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "todo" });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toBe("Agent cannot resolve another owner's recovery action");
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("allows the recovery owner to mutate their active recovery source issue", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue({ status: "blocked", assigneeAgentId: null }));
    mockIssueRecoveryActionService.getActiveForIssue.mockResolvedValue(makeRecoveryAction({
      ownerAgentId,
    }) as never);

    const res = await request(await createApp(ownerActor()))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "todo" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      issueId,
      expect.objectContaining({ status: "todo", actorAgentId: ownerAgentId }),
    );
  });

  it("lets board users mutate source issues regardless of active recovery action ownership", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue({ status: "blocked", assigneeAgentId: null }));
    mockIssueRecoveryActionService.getActiveForIssue.mockResolvedValue(makeRecoveryAction({
      ownerAgentId,
    }) as never);

    const res = await request(await createApp(boardActor()))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "todo" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      issueId,
      expect.objectContaining({ status: "todo", actorAgentId: null }),
    );
  });

  it("rejects peer-agent recovery resolution on a board-owned source issue", async () => {
    mockIssueService.getById.mockResolvedValue(
      makeIssue({ status: "blocked", assigneeAgentId: null, assigneeUserId: "board-user" }),
    );
    mockIssueRecoveryActionService.getActiveForIssue.mockResolvedValue({
      id: recoveryActionId,
      ownerAgentId,
    } as never);

    const res = await request(await createApp(peerActor()))
      .post(`/api/issues/${issueId}/recovery-actions/resolve`)
      .send({
        actionId: recoveryActionId,
        outcome: "restored",
        sourceIssueStatus: "done",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toBe("Agent cannot resolve another owner's recovery action");
    expect(mockIssueRecoveryActionService.resolveActiveForIssue).not.toHaveBeenCalled();
  });

  it("allows the named recovery owner to resolve a board-owned source issue", async () => {
    mockIssueService.getById.mockResolvedValue(
      makeIssue({ status: "blocked", assigneeAgentId: null, assigneeUserId: "board-user" }),
    );
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeIssue({ status: "blocked", assigneeAgentId: null, assigneeUserId: "board-user" }),
      ...patch,
    }));
    mockIssueRecoveryActionService.getActiveForIssue.mockResolvedValue({
      id: recoveryActionId,
      ownerAgentId,
    } as never);

    const res = await request(await createApp(ownerActor()))
      .post(`/api/issues/${issueId}/recovery-actions/resolve`)
      .send({
        actionId: recoveryActionId,
        outcome: "restored",
        sourceIssueStatus: "done",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalled();
    expect(mockIssueRecoveryActionService.resolveActiveForIssue).toHaveBeenCalled();
  });

  it("wakes the assigned agent when recovery resolution restores a source issue to todo", async () => {
    mockIssueService.getById.mockResolvedValue(
      makeIssue({ status: "blocked", assigneeAgentId: ownerAgentId }),
    );
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeIssue({ status: "blocked", assigneeAgentId: ownerAgentId }),
      ...patch,
    }));
    mockIssueRecoveryActionService.getActiveForIssue.mockResolvedValue({
      id: recoveryActionId,
      ownerAgentId,
    } as never);

    const res = await request(await createApp(ownerActor()))
      .post(`/api/issues/${issueId}/recovery-actions/resolve`)
      .send({
        actionId: recoveryActionId,
        outcome: "restored",
        sourceIssueStatus: "todo",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      ownerAgentId,
      expect.objectContaining({
        reason: "issue_recovery_action_restored",
        payload: expect.objectContaining({
          issueId,
          recoveryActionId,
          mutation: "recovery_action_resolution",
        }),
      }),
    );
  });

  it("uses the authorization decision path for assignment changes", async () => {
    const decide = vi.fn(async (input: { action: string }) => ({
      allowed: input.action === "issue:mutate",
      action: input.action,
      reason: input.action === "issue:mutate" ? "allow_company_agent" : "deny_policy_restricted",
      explanation:
        input.action === "issue:mutate"
          ? "Allowed by test issue boundary."
          : "Target agent requires approval before task assignment.",
    }));
    decide.mockImplementation(async (input: { action: string }) => ({
      allowed: input.action === "issue:mutate",
      action: input.action,
      reason: input.action === "issue:mutate" ? "allow_self" : "deny_policy_restricted",
      explanation:
        input.action === "issue:mutate"
          ? "Allowed because the actor owns the assigned issue."
          : "Target agent requires approval before task assignment.",
    }));
    (mockAccessService as any).decide = decide;
    mockIssueService.getById.mockResolvedValue(makeIssue({ assigneeAgentId: ownerAgentId }));
    mockAgentService.resolveByReference.mockResolvedValue({
      ambiguous: false,
      agent: makeAgent(peerAgentId),
    });

    const app = await createApp(ownerActor());
    const res = await request(app)
      .patch(`/api/issues/${issueId}`)
      .send({ assigneeAgentId: peerAgentId });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("requires approval");
    expect(decide).toHaveBeenCalledWith(expect.objectContaining({
      action: "tasks:assign",
      resource: expect.objectContaining({
        type: "issue",
        companyId,
        issueId,
        assigneeAgentId: peerAgentId,
      }),
    }));
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("uses the company-scope fast path on the issue list route", async () => {
    mockAccessService.decide.mockImplementation(async (input: { action: string }) => {
      if (input.action === "company_scope:read") {
        return {
          allowed: true,
          action: input.action,
          reason: "allow_explicit_grant",
          explanation: "Allowed by test company scope.",
        };
      }
      if (input.action === "issue:read") {
        throw new Error("issue:read should not be evaluated for company-scope readers");
      }
      return {
        allowed: true,
        action: input.action,
        reason: "allow_test_default",
        explanation: "Allowed by test default.",
      };
    });

    const app = await createApp(boardActor());
    const res = await request(app).get(`/api/companies/${companyId}/issues`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual([expect.objectContaining({ id: issueId })]);
    expect(mockAccessService.decide).toHaveBeenCalledWith(expect.objectContaining({
      action: "company_scope:read",
      resource: { type: "company", companyId },
    }));
    expect(mockAccessService.decide).not.toHaveBeenCalledWith(expect.objectContaining({
      action: "issue:read",
    }));
  });

  it("rejects the checked-out owner without a run id on attachment upload (401)", async () => {
    // Regression: an agent-authenticated client (e.g. the CLI's attachment:upload)
    // that fails to send X-Paperclip-Run-Id must be rejected — mutating your own
    // in-progress checkout requires proving run ownership.
    const app = await createApp({
      type: "agent",
      agentId: ownerAgentId,
      companyId,
      source: "agent_key",
      // intentionally no runId
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/issues/${issueId}/attachments`)
      .attach("file", Buffer.from("report"), { filename: "report.html", contentType: "text/html" });

    expect(res.status, JSON.stringify(res.body)).toBe(401);
    expect(res.body.error).toBe("Agent run id required");
    expect(mockStorageService.putFile).not.toHaveBeenCalled();
  });

  it("stores the authenticated agent run id when creating work products", async () => {
    const app = await createApp(ownerActor());

    await request(app).post(`/api/issues/${issueId}/work-products`).send({
      type: "artifact",
      provider: "test",
      title: "Artifact",
    }).expect(201);

    expect(mockWorkProductService.createForIssue).toHaveBeenCalledWith(
      issueId,
      companyId,
      expect.objectContaining({ createdByRunId: ownerRunId }),
    );
  });

  it("rejects agent-created work products with a forged run id", async () => {
    const app = await createApp(ownerActor());

    const res = await request(app).post(`/api/issues/${issueId}/work-products`).send({
      type: "artifact",
      provider: "test",
      title: "Artifact",
      createdByRunId: "66666666-6666-4666-8666-666666666666",
    });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toBe("createdByRunId must match the authenticated agent run");
    expect(mockWorkProductService.createForIssue).not.toHaveBeenCalled();
  });

  it("rejects work product updates with a forged agent run id", async () => {
    const app = await createApp(ownerActor());

    const res = await request(app).patch("/api/work-products/product-1").send({
      createdByRunId: "66666666-6666-4666-8666-666666666666",
    });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toBe("createdByRunId must match the authenticated agent run");
    expect(mockWorkProductService.update).not.toHaveBeenCalled();
  });

  it("rejects board-created work products with a foreign-company run id", async () => {
    const app = await createApp(
      boardActor(),
      createRunContextDb({}, [{
        id: "66666666-6666-4666-8666-666666666666",
        companyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        agentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        agentCompanyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        contextSnapshot: {},
      }]),
    );

    const res = await request(app).post(`/api/issues/${issueId}/work-products`).send({
      type: "artifact",
      provider: "test",
      title: "Artifact",
      createdByRunId: "66666666-6666-4666-8666-666666666666",
    });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toBe("createdByRunId is not valid for this company");
    expect(mockWorkProductService.createForIssue).not.toHaveBeenCalled();
  });

  it("defaults agent-created root follow-up issues to inherit the current run workspace", async () => {
    // Root creates by agents pass the low-trust boundary guard only with
    // company-scope read; grant it here so the workspace-inheritance path
    // (the test subject) is what's exercised.
    mockAccessService.decide.mockImplementation(async (input: { action: string }) => ({
      allowed:
        input.action === "tasks:assign" ||
        input.action === "issue:read" ||
        input.action === "issue:mutate" ||
        input.action === "company_scope:read",
      action: input.action,
      reason: "allow_test_default",
      explanation: "Allowed by test default.",
    }));
    const app = await createApp(
      ownerActor(),
      createRunContextDb({
        issueId,
        executionWorkspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      }),
    );

    const res = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Follow-up in same worktree",
        projectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockIssueService.create).toHaveBeenCalledWith(
      companyId,
      expect.objectContaining({
        title: "Follow-up in same worktree",
        inheritExecutionWorkspaceFromIssueId: issueId,
      }),
    );
  });

  it("preserves explicit workspace choices on agent-created root issues", async () => {
    mockAccessService.decide.mockImplementation(async (input: { action: string }) => ({
      allowed:
        input.action === "tasks:assign" ||
        input.action === "issue:read" ||
        input.action === "issue:mutate" ||
        input.action === "company_scope:read",
      action: input.action,
      reason: "allow_test_default",
      explanation: "Allowed by test default.",
    }));
    const app = await createApp(
      ownerActor(),
      createRunContextDb({
        issueId,
        executionWorkspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      }),
    );

    const explicitExecutionWorkspaceId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const res = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Explicit different workspace",
        executionWorkspaceId: explicitExecutionWorkspaceId,
        executionWorkspacePreference: "reuse_existing",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockIssueService.create).toHaveBeenCalledWith(
      companyId,
      expect.objectContaining({
        title: "Explicit different workspace",
        executionWorkspaceId: explicitExecutionWorkspaceId,
        executionWorkspacePreference: "reuse_existing",
      }),
    );
    expect(mockIssueService.create).toHaveBeenCalledWith(
      companyId,
      expect.not.objectContaining({
        inheritExecutionWorkspaceFromIssueId: issueId,
      }),
    );
  });

  describe("task watchdog scope grants", () => {
    const watchdogRunId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab";
    const watchdogReportIssueId = "cccccccc-cccc-4ccc-8ccc-cccccccccccd";

    // The watchdog agent (peerAgentId) is NOT the assignee of the watched issue
    // (ownerAgentId), so the base authorization boundary (issue:mutate) denies.
    // The watchdog scope must grant the mutation regardless.
    function watchdogActor(runId: string = watchdogRunId) {
      return {
        type: "agent",
        agentId: peerAgentId,
        companyId,
        source: "agent_key",
        runId,
      };
    }

    function createWatchdogDb(options: {
      watchedIssueId?: string;
      watchdogIssueId?: string | null;
      ancestryParentId?: string | null;
      watchdogRows?: Record<string, unknown>[];
    } = {}) {
      const watchedIssueId = options.watchedIssueId ?? issueId;
      const runRows = [{
        id: watchdogRunId,
        companyId,
        agentId: peerAgentId,
        contextSnapshot: { taskWatchdog: { watchedIssueId, stopFingerprint: "task_watchdog_stop:test" } },
      }];
      const watchdogRows = options.watchdogRows ?? [{
        id: "dddddddd-dddd-4ddd-8ddd-ddddddddddde",
        companyId,
        issueId: watchedIssueId,
        watchdogAgentId: peerAgentId,
        watchdogIssueId: options.watchdogIssueId ?? watchdogReportIssueId,
        status: "active",
      }];
      const ancestryRows = [{
        id: "ancestry",
        companyId,
        parentId: options.ancestryParentId ?? null,
      }];
      const rowsForSelection = (selection: Record<string, unknown>) => {
        const keys = Object.keys(selection);
        if (keys.includes("entityId")) return [];
        if (keys.includes("contextSnapshot")) return runRows;
        if (keys.includes("watchdogAgentId")) return watchdogRows;
        if (keys.includes("parentId")) return ancestryRows;
        if (keys.includes("status")) return [];
        if (keys.includes("agentCompanyId")) return runRows;
        return [{ id: peerAgentId, companyId, permissions: {}, role: "engineer", reportsTo: null }];
      };
      const buildQuery = (selection: Record<string, unknown>) => {
        const whereResult = {
          orderBy: vi.fn(async () => []),
          then: async (resolve: (rows: unknown[]) => unknown) => resolve(rowsForSelection(selection)),
        };
        const query = {
          innerJoin: vi.fn(() => query),
          where: vi.fn(() => whereResult),
        };
        return query;
      };
      return {
        transaction: async (callback: (tx: Record<string, never>) => Promise<unknown>) => callback({}),
        select: vi.fn((selection: Record<string, unknown> = {}) => ({
          from: vi.fn(() => buildQuery(selection)),
        })),
      };
    }

    // The base boundary always denies a cross-agent issue:mutate; only the
    // watchdog scope can widen access. Denying it here proves the grant works.
    function denyBaseBoundary() {
      mockAccessService.decide.mockImplementation(async (input: { action: string }) => ({
        allowed: input.action === "company_scope:read" || input.action === "issue:read" || input.action === "tasks:assign",
        action: input.action,
        reason:
          input.action === "company_scope:read" || input.action === "issue:read" || input.action === "tasks:assign"
            ? "allow_explicit_grant"
            : "deny_missing_grant",
        explanation: "Watchdog test boundary default.",
      }));
    }

    it("allows both POST comments and PATCH {comment} for a valid watchdog-scoped current run", async () => {
      denyBaseBoundary();
      const watchedIssue = makeIssue({
        assigneeAgentId: ownerAgentId,
        executionRunId: watchdogRunId,
      });
      mockIssueService.getById.mockResolvedValue(watchedIssue);
      mockIssueService.update.mockResolvedValue(watchedIssue);

      const app = await createApp(watchdogActor(), createWatchdogDb());
      const postRes = await request(app).post(`/api/issues/${issueId}/comments`).send({ body: "Watchdog finding" });
      expect(postRes.status, JSON.stringify(postRes.body)).toBe(201);
      expect(mockIssueService.addComment).toHaveBeenCalledTimes(1);

      mockIssueService.addComment.mockClear();
      mockIssueService.update.mockClear();

      const patchRes = await request(app).patch(`/api/issues/${issueId}`).send({ comment: "Watchdog finding" });
      expect(patchRes.status, JSON.stringify(patchRes.body)).toBe(200);
      expect(mockIssueService.addComment).toHaveBeenCalledTimes(1);
      expect(mockIssueService.update).toHaveBeenCalledTimes(1);
    });

    it.each([
      ["in_progress"],
      ["blocked"],
      ["todo"],
    ])("lets a watchdog run transition a watched issue to %s", async (status) => {
      denyBaseBoundary();
      mockIssueService.getById.mockResolvedValue(makeIssue({ status: "in_progress", assigneeAgentId: ownerAgentId }));
      mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
        ...makeIssue({ assigneeAgentId: ownerAgentId }),
        ...patch,
      }));

      const app = await createApp(watchdogActor(), createWatchdogDb());
      const res = await request(app).patch(`/api/issues/${issueId}`).send({ status });

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(mockIssueService.update).toHaveBeenCalledWith(issueId, expect.objectContaining({ status }));
    });

    it("lets a watchdog run transition a watched issue to in_review with a live review path", async () => {
      denyBaseBoundary();
      mockIssueService.getById.mockResolvedValue(makeIssue({ status: "in_progress", assigneeAgentId: ownerAgentId }));
      mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
        ...makeIssue({ assigneeAgentId: ownerAgentId }),
        ...patch,
      }));
      // A pending interaction is a valid review path, so the agent in_review guard
      // is satisfied — this isolates the test to the watchdog boundary grant.
      mockIssueThreadInteractionService.listForIssue.mockResolvedValue([
        { kind: "request_confirmation", status: "pending" },
      ] as never);

      const app = await createApp(watchdogActor(), createWatchdogDb());
      const res = await request(app).patch(`/api/issues/${issueId}`).send({ status: "in_review" });

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(mockIssueService.update).toHaveBeenCalledWith(issueId, expect.objectContaining({ status: "in_review" }));
    });

    it("rejects stale watchdog source mutations when revalidation finds a live path", async () => {
      denyBaseBoundary();
      mockIssueService.getById.mockResolvedValue(makeIssue({ status: "in_progress", assigneeAgentId: ownerAgentId }));
      mockTaskWatchdogService.revalidateMutationScope.mockResolvedValueOnce({
        allowed: false,
        reason:
          "Task-watchdog review is stale because the watched subtree now has a live, waiting, already-reviewed, or not-applicable path; refresh the source state before mutating it.",
        classification: { state: "live", liveIssueIds: [issueId] },
      });

      const app = await createApp(watchdogActor(), createWatchdogDb());
      const res = await request(app).patch(`/api/issues/${issueId}`).send({ status: "blocked" });

      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(res.body.error).toContain("Task-watchdog review is stale");
      expect(mockIssueService.update).not.toHaveBeenCalled();
    });

    it("suppresses watchdog follow-up creation when current source revalidation is live", async () => {
      denyBaseBoundary();
      mockIssueService.getById.mockResolvedValue(makeIssue({ assigneeAgentId: ownerAgentId }));
      mockTaskWatchdogService.revalidateMutationScope.mockResolvedValueOnce({
        allowed: false,
        reason:
          "Task-watchdog review is stale because the watched subtree now has a live, waiting, already-reviewed, or not-applicable path; refresh the source state before mutating it.",
        classification: { state: "live", liveIssueIds: [issueId] },
      });

      const app = await createApp(watchdogActor(), createWatchdogDb());
      const res = await request(app)
        .post(`/api/issues/${issueId}/children`)
        .send({ title: "Stale follow-up", status: "todo" });

      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(res.body.error).toContain("Task-watchdog review is stale");
      expect(mockIssueService.createChild).not.toHaveBeenCalled();
    });

    it("serializes watchdog accepted-plan follow-ups behind one active child lane", async () => {
      denyBaseBoundary();
      mockIssueService.list.mockResolvedValue([]);
      mockAgentService.resolveByReference.mockImplementation(async (_companyId: string, reference: string) => ({
        ambiguous: false,
        agent: reference === ownerAgentId ? makeAgent(ownerAgentId) : null,
      }));
      mockIssueService.getById.mockImplementation(async (id: string) => {
        if (id === watchdogReportIssueId) {
          return makeIssue({
            id: watchdogReportIssueId,
            originKind: "task_watchdog",
            status: "in_progress",
            assigneeAgentId: peerAgentId,
          });
        }
        return makeIssue({ assigneeAgentId: ownerAgentId });
      });

      const app = await createApp(watchdogActor(), createWatchdogDb());
      const res = await request(app)
        .post(`/api/issues/${issueId}/accepted-plan-decompositions`)
        .send({
          acceptedPlanRevisionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          children: [
            { title: "Fix watchdog authorization", assigneeAgentId: ownerAgentId },
            { title: "Fix watchdog startup race", assigneeAgentId: ownerAgentId },
          ],
        });

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const decompositionInput = mockIssueService.decomposeAcceptedPlan.mock.calls[0]?.[1];
      const children = decompositionInput.children as Array<Record<string, unknown>>;
      expect(children).toHaveLength(2);
      expect(children[0]).toEqual(expect.objectContaining({
        title: "Fix watchdog authorization",
        status: "todo",
        assigneeAgentId: ownerAgentId,
      }));
      expect(children[1]).toEqual(expect.objectContaining({
        title: "Fix watchdog startup race",
        status: "blocked",
        assigneeAgentId: ownerAgentId,
        blockedByIssueIds: [children[0]?.id],
      }));
      expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(1);
      expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
        ownerAgentId,
        expect.objectContaining({
          payload: expect.objectContaining({ issueId: children[0]?.id }),
        }),
      );
      expect(mockIssueService.update).toHaveBeenCalledWith(
        watchdogReportIssueId,
        expect.objectContaining({
          status: "blocked",
          blockedByIssueIds: [children[0]?.id],
          actorAgentId: peerAgentId,
        }),
      );
    });

    it("preserves normal accepted-plan decomposition parallel wakeups outside watchdog context", async () => {
      mockAgentService.resolveByReference.mockImplementation(async (_companyId: string, reference: string) => ({
        ambiguous: false,
        agent: reference === ownerAgentId ? makeAgent(ownerAgentId) : null,
      }));
      const app = await createApp(ownerActor());
      const res = await request(app)
        .post(`/api/issues/${issueId}/accepted-plan-decompositions`)
        .send({
          acceptedPlanRevisionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          children: [
            { title: "Implement backend", assigneeAgentId: ownerAgentId },
            { title: "Implement frontend", assigneeAgentId: ownerAgentId },
          ],
        });

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const decompositionInput = mockIssueService.decomposeAcceptedPlan.mock.calls[0]?.[1];
      const children = decompositionInput.children as Array<Record<string, unknown>>;
      expect(children).toHaveLength(2);
      expect(children[0]).toEqual(expect.objectContaining({ status: "todo" }));
      expect(children[1]).toEqual(expect.objectContaining({ status: "todo" }));
      expect(children[1]?.blockedByIssueIds).toBeUndefined();
      expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(2);
      expect(mockHeartbeatService.wakeup).toHaveBeenNthCalledWith(
        1,
        ownerAgentId,
        expect.objectContaining({
          payload: expect.objectContaining({ issueId: children[0]?.id }),
        }),
      );
      expect(mockHeartbeatService.wakeup).toHaveBeenNthCalledWith(
        2,
        ownerAgentId,
        expect.objectContaining({
          payload: expect.objectContaining({ issueId: children[1]?.id }),
        }),
      );
      expect(mockIssueService.update).not.toHaveBeenCalledWith(
        watchdogReportIssueId,
        expect.anything(),
      );
    });

    it("lets a watchdog run reassign a watched issue to an active same-company agent", async () => {
      denyBaseBoundary();
      mockIssueService.getById.mockResolvedValue(makeIssue({ assigneeAgentId: ownerAgentId }));
      mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
        ...makeIssue({ assigneeAgentId: ownerAgentId }),
        ...patch,
      }));
      mockAgentService.resolveByReference.mockResolvedValue({ ambiguous: false, agent: makeAgent(peerAgentId) });

      const app = await createApp(watchdogActor(), createWatchdogDb());
      const res = await request(app).patch(`/api/issues/${issueId}`).send({ assigneeAgentId: peerAgentId });

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(mockIssueService.update).toHaveBeenCalledWith(
        issueId,
        expect.objectContaining({ assigneeAgentId: peerAgentId }),
      );
    });

    it("still denies a watchdog run mutating an issue outside the watched subtree", async () => {
      denyBaseBoundary();
      mockIssueService.getById.mockResolvedValue(makeIssue({ assigneeAgentId: ownerAgentId }));

      // The watched issue is a different issue, and the target's ancestry chain
      // (parentId === null) never reaches it, so it is outside the subtree.
      const outsideWatched = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeef";
      const app = await createApp(
        watchdogActor(),
        createWatchdogDb({ watchedIssueId: outsideWatched, ancestryParentId: null }),
      );
      const res = await request(app).patch(`/api/issues/${issueId}`).send({ status: "blocked" });

      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body.error).toBe("Task-watchdog runs can only mutate the watched issue subtree.");
      expect(mockIssueService.update).not.toHaveBeenCalled();
    });

    it("still enforces normal assignment guards for watchdog reassignment", async () => {
      // Base boundary denied AND tasks:assign denied: the watchdog grant lets the
      // mutation past the ownership boundary, but the assignment guard must still bite.
      mockAccessService.decide.mockImplementation(async (input: { action: string }) => ({
        allowed: input.action === "company_scope:read",
        action: input.action,
        reason: input.action === "company_scope:read" ? "allow_explicit_grant" : "deny_policy_restricted",
        explanation:
          input.action === "tasks:assign"
            ? "Target agent requires approval before task assignment."
            : "Watchdog test boundary default.",
      }));
      mockIssueService.getById.mockResolvedValue(makeIssue({ assigneeAgentId: ownerAgentId }));
      mockAgentService.resolveByReference.mockResolvedValue({ ambiguous: false, agent: makeAgent(peerAgentId) });

      const app = await createApp(watchdogActor(), createWatchdogDb());
      const res = await request(app).patch(`/api/issues/${issueId}`).send({ assigneeAgentId: peerAgentId });

      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body.error).toContain("requires approval");
      expect(mockIssueService.update).not.toHaveBeenCalled();
    });

    it("denies both POST comments and PATCH {comment} for an invalid watchdog-scoped current run", async () => {
      // Run context claims a watched issue, but no active persisted watchdog backs it.
      const app = await createApp(
        watchdogActor(),
        createWatchdogDb({ watchdogRows: [] }),
      );
      mockIssueService.getById.mockResolvedValue(makeIssue({
        assigneeAgentId: peerAgentId,
        executionRunId: watchdogRunId,
      }));

      const postRes = await request(app).post(`/api/issues/${issueId}/comments`).send({ body: "Invalid watchdog" });
      const patchRes = await request(app).patch(`/api/issues/${issueId}`).send({ comment: "Invalid watchdog" });

      expect(postRes.status, JSON.stringify(postRes.body)).toBe(403);
      expect(patchRes.status, JSON.stringify(patchRes.body)).toBe(403);
      expect(postRes.body.error).toBe("Task-watchdog run context is not backed by an active persisted watchdog.");
      expect(patchRes.body.error).toBe("Task-watchdog run context is not backed by an active persisted watchdog.");
      expect(mockIssueService.addComment).not.toHaveBeenCalled();
      expect(mockIssueService.update).not.toHaveBeenCalled();
    });
  });

  // BLO-18289 (decision on BLO-18163). A tasks:assign holder who manages the
  // assignee may PATCH coordination metadata — blocker edges, priority,
  // project, parent, milestone — on an issue assigned to someone else, so the
  // agent who curates the dependency graph is not structurally locked out of
  // it. Work content and `status` stay behind the original boundary.
  describe("coordination-metadata allowlist", () => {
    // The real grant+manager-chain logic lives in decideBase and is covered in
    // authorization-service.test.ts; here we drive the route wiring, so
    // issue:coordination_metadata is mocked as the authorization outcome.
    function coordinationHolderDecide(allowed: boolean) {
      return async (input: { action: string }) => ({
        allowed: input.action === "issue:read"
          || (input.action === "issue:coordination_metadata" && allowed),
        action: input.action,
        reason: input.action === "issue:coordination_metadata" && allowed
          ? "allow_explicit_grant"
          : input.action === "issue:read"
          ? "allow_company_agent"
          : "deny_missing_grant",
        explanation: "Coordination-metadata allowlist test decision.",
      });
    }

    // Assigned to ownerAgentId, parked (not checked out), so the only thing
    // that can let peerAgentId through is the coordination-metadata path.
    function otherAgentsParkedIssue(overrides: Record<string, unknown> = {}) {
      return makeIssue({ status: "todo", assigneeAgentId: ownerAgentId, ...overrides });
    }

    it("lets a tasks:assign holder clear a blocker edge on another agent's issue", async () => {
      mockIssueService.getById.mockResolvedValue(otherAgentsParkedIssue());
      mockAccessService.decide.mockImplementation(coordinationHolderDecide(true));

      const res = await request(await createApp(peerActor()))
        .patch(`/api/issues/${issueId}`)
        .send({ blockedByIssueIds: [] });

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(mockIssueService.update).toHaveBeenCalledWith(
        issueId,
        expect.objectContaining({ blockedByIssueIds: [] }),
      );
    });

    it("emits an audit record naming the actor and the coordination path", async () => {
      mockIssueService.getById.mockResolvedValue(otherAgentsParkedIssue());
      mockAccessService.decide.mockImplementation(coordinationHolderDecide(true));

      await request(await createApp(peerActor()))
        .patch(`/api/issues/${issueId}`)
        .send({ blockedByIssueIds: [], priority: "low" })
        .expect(200);

      expect(mockLogActivity).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: "issue.coordination_metadata_updated",
          entityId: issueId,
          agentId: peerAgentId,
          details: expect.objectContaining({
            path: "coordination_metadata_allowlist",
            fields: expect.arrayContaining(["blockedByIssueIds", "priority"]),
            assigneeAgentId: ownerAgentId,
          }),
        }),
      );
    });

    it("still denies an agent that does not hold tasks:assign", async () => {
      mockIssueService.getById.mockResolvedValue(otherAgentsParkedIssue());
      mockAccessService.decide.mockImplementation(coordinationHolderDecide(false));

      const res = await request(await createApp(peerActor()))
        .patch(`/api/issues/${issueId}`)
        .send({ blockedByIssueIds: [] });

      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(mockIssueService.update).not.toHaveBeenCalled();
    });

    it("does not let a holder rewrite another agent's description", async () => {
      mockIssueService.getById.mockResolvedValue(otherAgentsParkedIssue());
      mockAccessService.decide.mockImplementation(coordinationHolderDecide(true));

      const res = await request(await createApp(peerActor()))
        .patch(`/api/issues/${issueId}`)
        .send({ description: "Rewritten by a coordinator." });

      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(mockIssueService.update).not.toHaveBeenCalled();
    });

    it("does not let a holder retitle another agent's issue", async () => {
      mockIssueService.getById.mockResolvedValue(otherAgentsParkedIssue());
      mockAccessService.decide.mockImplementation(coordinationHolderDecide(true));

      const res = await request(await createApp(peerActor()))
        .patch(`/api/issues/${issueId}`)
        .send({ title: "Retitled by a coordinator." });

      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(mockIssueService.update).not.toHaveBeenCalled();
    });

    // `status` is excluded so no allowlisted field can terminate another
    // agent's run — that exclusion is what makes bypassing the in_progress
    // guard safe for the rest of the list.
    it("does not let a holder change status on another agent's issue", async () => {
      mockIssueService.getById.mockResolvedValue(otherAgentsParkedIssue());
      mockAccessService.decide.mockImplementation(coordinationHolderDecide(true));

      const res = await request(await createApp(peerActor()))
        .patch(`/api/issues/${issueId}`)
        .send({ status: "cancelled" });

      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(mockIssueService.update).not.toHaveBeenCalled();
    });

    // No partial application: the allowlisted half must not land either.
    it("rejects a mixed allowlisted + non-allowlisted PATCH as a whole", async () => {
      mockIssueService.getById.mockResolvedValue(otherAgentsParkedIssue());
      mockAccessService.decide.mockImplementation(coordinationHolderDecide(true));

      const res = await request(await createApp(peerActor()))
        .patch(`/api/issues/${issueId}`)
        .send({ blockedByIssueIds: [], description: "Smuggled in alongside a blocker edit." });

      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(mockIssueService.update).not.toHaveBeenCalled();
      expect(mockLogActivity).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: "issue.coordination_metadata_updated" }),
      );
    });

    it("allows a workspace rebind while the issue is parked", async () => {
      mockIssueService.getById.mockResolvedValue(otherAgentsParkedIssue());
      mockAccessService.decide.mockImplementation(coordinationHolderDecide(true));

      const res = await request(await createApp(peerActor()))
        .patch(`/api/issues/${issueId}`)
        .send({ projectWorkspaceId: "99999999-9999-4999-8999-999999999999" });

      expect(res.status, JSON.stringify(res.body)).toBe(200);
    });

    // Rebinding where a live run executes would repoint work in flight, so the
    // coordination path declines and the request falls through to ordinary
    // authorization — which denies a non-assignee at the boundary. The
    // invariant under test is that the rebind does not land and takes no
    // audit record, not the particular refusal code.
    it("refuses a workspace rebind while another agent holds the issue in_progress", async () => {
      mockIssueService.getById.mockResolvedValue(
        makeIssue({ status: "in_progress", assigneeAgentId: ownerAgentId, executionRunId: ownerRunId }),
      );
      mockAccessService.decide.mockImplementation(coordinationHolderDecide(true));

      const res = await request(await createApp(peerActor()))
        .patch(`/api/issues/${issueId}`)
        .send({ projectWorkspaceId: "99999999-9999-4999-8999-999999999999" });

      expect(res.status, JSON.stringify(res.body)).toBeGreaterThanOrEqual(400);
      expect(mockIssueService.update).not.toHaveBeenCalled();
      expect(mockLogActivity).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: "issue.coordination_metadata_updated" }),
      );
    });

    it("refuses a workspace rebind while another agent holds the issue in_review", async () => {
      mockIssueService.getById.mockResolvedValue(
        makeIssue({ status: "in_review", assigneeAgentId: ownerAgentId, executionRunId: ownerRunId }),
      );
      mockAccessService.decide.mockImplementation(coordinationHolderDecide(true));

      const res = await request(await createApp(peerActor()))
        .patch(`/api/issues/${issueId}`)
        .send({ projectWorkspaceId: "99999999-9999-4999-8999-999999999999" });

      expect(res.status, JSON.stringify(res.body)).toBeGreaterThanOrEqual(400);
      expect(mockIssueService.update).not.toHaveBeenCalled();
      expect(mockLogActivity).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: "issue.coordination_metadata_updated" }),
      );
    });

    it("refuses a project rebind while another agent holds an execution lock", async () => {
      mockIssueService.getById.mockResolvedValue(
        makeIssue({
          status: "in_progress",
          assigneeAgentId: ownerAgentId,
          executionRunId: ownerRunId,
          projectId: "88888888-8888-4888-8888-888888888888",
        }),
      );
      mockAccessService.decide.mockImplementation(coordinationHolderDecide(true));

      const res = await request(await createApp(peerActor()))
        .patch(`/api/issues/${issueId}`)
        .send({ projectId: "99999999-9999-4999-8999-999999999999" });

      expect(res.status, JSON.stringify(res.body)).toBeGreaterThanOrEqual(400);
      expect(mockIssueService.update).not.toHaveBeenCalled();
      expect(mockLogActivity).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: "issue.coordination_metadata_updated" }),
      );
    });

    it("refuses a parent rebind while another agent holds an execution lock", async () => {
      mockIssueService.getById.mockResolvedValue(
        makeIssue({ status: "in_progress", assigneeAgentId: ownerAgentId, executionRunId: ownerRunId }),
      );
      mockAccessService.decide.mockImplementation(coordinationHolderDecide(true));

      const res = await request(await createApp(peerActor()))
        .patch(`/api/issues/${issueId}`)
        .send({ parentId: "99999999-9999-4999-8999-999999999999" });

      expect(res.status, JSON.stringify(res.body)).toBeGreaterThanOrEqual(400);
      expect(mockIssueService.update).not.toHaveBeenCalled();
      expect(mockLogActivity).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: "issue.coordination_metadata_updated" }),
      );
    });

    // Cutting a stale blocker edge is the BLO-18163 use case and cannot
    // disturb a live run. Adding a new blocker is execution-sensitive because
    // queued continuations cancel when unresolved blockers are present.
    it("still allows blocker removal while the issue has an execution lock", async () => {
      const blockerId = "99999999-9999-4999-8999-999999999999";
      mockIssueService.getById.mockResolvedValue(
        makeIssue({
          status: "in_progress",
          assigneeAgentId: ownerAgentId,
          executionRunId: ownerRunId,
        }),
      );
      mockIssueService.getRelationSummaries.mockResolvedValue({
        blockedBy: [{ id: blockerId }],
        blocks: [],
      });
      mockAccessService.decide.mockImplementation(coordinationHolderDecide(true));

      const res = await request(await createApp(peerActor()))
        .patch(`/api/issues/${issueId}`)
        .send({ blockedByIssueIds: [] });

      expect(res.status, JSON.stringify(res.body)).toBe(200);
    });

    it("allows partial blocker removal while the issue has an execution lock", async () => {
      const keptBlockerId = "88888888-8888-4888-8888-888888888888";
      const removedBlockerId = "99999999-9999-4999-8999-999999999999";
      mockIssueService.getById.mockResolvedValue(
        makeIssue({
          status: "in_progress",
          assigneeAgentId: ownerAgentId,
          executionRunId: ownerRunId,
        }),
      );
      mockIssueService.getRelationSummaries.mockResolvedValue({
        blockedBy: [{ id: keptBlockerId }, { id: removedBlockerId }],
        blocks: [],
      });
      mockAccessService.decide.mockImplementation(coordinationHolderDecide(true));

      const res = await request(await createApp(peerActor()))
        .patch(`/api/issues/${issueId}`)
        .send({ blockedByIssueIds: [keptBlockerId] });

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(mockIssueService.update).toHaveBeenCalled();
    });

    it("refuses blocker addition while another agent holds an execution lock", async () => {
      mockIssueService.getById.mockResolvedValue(
        makeIssue({
          status: "in_progress",
          assigneeAgentId: ownerAgentId,
          executionRunId: ownerRunId,
        }),
      );
      mockAccessService.decide.mockImplementation(coordinationHolderDecide(true));

      const res = await request(await createApp(peerActor()))
        .patch(`/api/issues/${issueId}`)
        .send({ blockedByIssueIds: ["99999999-9999-4999-8999-999999999999"] });

      expect(res.status, JSON.stringify(res.body)).toBeGreaterThanOrEqual(400);
      expect(mockIssueService.update).not.toHaveBeenCalled();
      expect(mockLogActivity).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: "issue.coordination_metadata_updated" }),
      );
    });

    // The audit record must describe a write that happened. Emitting it next
    // to the authorization decision would log a mutation for every request
    // that clears the coordination check and is then rejected downstream.
    it("does not emit an audit record when the write itself fails", async () => {
      mockIssueService.getById.mockResolvedValue(otherAgentsParkedIssue());
      mockAccessService.decide.mockImplementation(coordinationHolderDecide(true));
      mockIssueService.update.mockRejectedValue(new Error("write rejected downstream"));

      await request(await createApp(peerActor()))
        .patch(`/api/issues/${issueId}`)
        .send({ blockedByIssueIds: [] });

      expect(mockLogActivity).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: "issue.coordination_metadata_updated" }),
      );
    });

    // PR #814's lesson: the shared mutation helper backs ~two dozen routes, so
    // the allowlist must not have widened anything but PATCH.
    it("does not extend coordination authority to issue deletion", async () => {
      mockIssueService.getById.mockResolvedValue(otherAgentsParkedIssue());
      mockAccessService.decide.mockImplementation(coordinationHolderDecide(true));

      const res = await request(await createApp(peerActor())).delete(`/api/issues/${issueId}`);

      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(mockIssueService.remove).not.toHaveBeenCalled();
    });
  });
});
