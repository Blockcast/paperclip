import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  computeIssueMonitorGateFingerprint,
  normalizeIssueExecutionPolicy,
} from "../services/issue-execution-policy.js";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  update: vi.fn(),
  createChild: vi.fn(),
  addComment: vi.fn(),
  listAttachments: vi.fn(),
  remove: vi.fn(),
  findMentionedAgents: vi.fn(),
  getRelationSummaries: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  lockPendingInReviewRunOwnership: vi.fn(async () => ({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" })),
  // BLO-18294: the monitor convergence guard reads live blocker edges on every arm.
  listDependencyReadiness: vi.fn(async () => new Map()),
  getWakeableParentAfterChildCompletion: vi.fn(),
  // Destructive path, mocked so the authorization boundary tests can assert it
  // is never reached rather than relying on an incidental undefined-method throw.
  listAttachments: vi.fn(async () => []),
  remove: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  triggerIssueMonitor: vi.fn(async () => ({ outcome: "triggered" as const })),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(async () => false),
  decide: vi.fn(),
  hasPermission: vi.fn(async () => false),
}));
const mockDbSelectWhere = vi.hoisted(() => vi.fn(() => ({
  then: (onFulfilled: (rows: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
    Promise.resolve([{
      companyId: "company-1",
      agentId: "33333333-3333-4333-8333-333333333333",
      contextSnapshot: null,
      permissions: null,
    }]).then(onFulfilled, onRejected),
})));
// BLO-18294: the convergence escalation resolves unblock owners through a
// leftJoin, which no other route in this file uses — give it its own stub so a
// test can seed blocker rows without disturbing the auth lookups above.
const mockDbLeftJoinWhere = vi.hoisted(() => vi.fn(async () => [] as unknown[]));
const mockDbSelectFrom = vi.hoisted(() => vi.fn(() => ({
  where: mockDbSelectWhere,
  leftJoin: vi.fn(() => ({ where: mockDbLeftJoinWhere })),
})));
const mockDbSelect = vi.hoisted(() => vi.fn(() => ({ from: mockDbSelectFrom })));
const mockDbInsertValues = vi.hoisted(() => vi.fn(async () => undefined));
const mockDbInsert = vi.hoisted(() => vi.fn(() => ({ values: mockDbInsertValues })));
const mockDb = vi.hoisted(() => {
  const db: any = {
    select: mockDbSelect,
    insert: mockDbInsert,
    transaction: async (cb: (tx: unknown) => unknown) => cb(db),
  };
  return db;
});

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
const mockIssueThreadInteractionService = vi.hoisted(() => ({
  listForIssue: vi.fn(async () => []),
  expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
}));
const mockIssueApprovalService = vi.hoisted(() => ({
  listApprovalsForIssue: vi.fn(async () => []),
}));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    companyService: () => ({
      getById: vi.fn(async () => ({ id: "company-1", attachmentMaxBytes: 10 * 1024 * 1024 })),
    }),
    accessService: () => mockAccessService,
    agentService: () => ({
      getById: vi.fn(async (agentId: string) => ({
        id: agentId,
        companyId: "company-1",
        permissions: null,
      })),
      resolveByReference: vi.fn(async (_companyId: string, reference: string) => ({
        ambiguous: false,
        agent: {
          id: reference,
          companyId: "company-1",
          status: "idle",
          orgChainHealth: { status: "healthy" },
        },
      })),
    }),
    companySkillService: () => ({
      completeTestRunForIssue: vi.fn(async () => null),
    }),
    documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
    documentService: () => ({}),
    executionWorkspaceService: () => ({}),
    feedbackService: () => ({
      listIssueVotesForUser: vi.fn(async () => []),
      saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
    }),
    goalService: () => ({}),
    heartbeatService: () => mockHeartbeatService,
    environmentService: () => ({
      getById: vi.fn(async () => null),
    }),
    instanceSettingsService: () => ({
      get: vi.fn(async () => ({
        id: "instance-settings-1",
        general: {
          censorUsernameInLogs: false,
          feedbackDataSharingPreference: "prompt",
        },
      })),
      listCompanyIds: vi.fn(async () => ["company-1"]),
    }),
    issueApprovalService: () => mockIssueApprovalService,
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
    issueService: () => mockIssueService,
    issueThreadInteractionService: () => mockIssueThreadInteractionService,
    logActivity: mockLogActivity,
    projectService: () => ({}),
    routineService: () => ({
      syncRunStatusForIssue: vi.fn(async () => undefined),
    }),
    workProductService: () => ({}),
  }));
}

type TestActor =
  | {
      type: "board";
      userId: string;
      companyIds: string[];
      source: "local_implicit";
      isInstanceAdmin: boolean;
    }
  | {
      type: "agent";
      agentId: string;
      companyId: string;
      runId: string | null;
    };

async function createApp(actor?: TestActor) {
  const [{ errorHandler }, { issueRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/issues.js"),
  ]);
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

describe("issue execution policy routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockIssueService.listAttachments.mockResolvedValue([]);
    mockIssueService.remove.mockResolvedValue(null);
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockIssueService.addComment.mockResolvedValue({
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      issueId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      body: "test comment",
    });
    mockIssueThreadInteractionService.listForIssue.mockResolvedValue([]);
    mockIssueThreadInteractionService.expireRequestConfirmationsSupersededByComment.mockResolvedValue([]);
    mockIssueApprovalService.listApprovalsForIssue.mockResolvedValue([]);
    mockDbSelect.mockImplementation(() => ({ from: mockDbSelectFrom }));
    mockDbSelectFrom.mockImplementation(() => ({
      where: mockDbSelectWhere,
      leftJoin: vi.fn(() => ({ where: mockDbLeftJoinWhere })),
    }));
    mockDbLeftJoinWhere.mockResolvedValue([]);
    mockIssueService.listDependencyReadiness.mockResolvedValue(new Map());
    mockDbSelectWhere.mockImplementation(() => ({
      then: (onFulfilled: (rows: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
        Promise.resolve([{
          companyId: "company-1",
          agentId: "33333333-3333-4333-8333-333333333333",
          contextSnapshot: null,
          permissions: null,
        }]).then(onFulfilled, onRejected),
    }));
    mockIssueService.createChild.mockResolvedValue({
      issue: {
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        companyId: "company-1",
        identifier: "PAP-1002",
        title: "Child issue",
      },
      parentBlockerAdded: false,
    });
    mockAccessService.canUser.mockResolvedValue(false);
    mockAccessService.decide.mockImplementation(async (input: { actor?: { type?: string; source?: string }; action?: string }) => {
      const allowed = input.actor?.type === "board" && input.actor.source === "local_implicit"
        ? true
        : input.actor?.type === "agent" && [
            "company_scope:read",
            "issue:read",
            "issue:mutate",
            "runtime:manage",
          ].includes(input.action ?? "")
          ? true
          : Boolean(await mockAccessService.canUser() || await mockAccessService.hasPermission());
      return {
        allowed,
        action: input.action,
        reason: allowed ? "allow_explicit_grant" : "deny_missing_grant",
        explanation: allowed ? "Allowed by test grant." : `Missing permission: ${input.action ?? "action"}`,
      };
    });
    mockAccessService.hasPermission.mockResolvedValue(false);
  });

  it("rejects an agent-authored in_review transition without a review path", async () => {
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "todo",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1003",
      title: "Missing review path",
      executionPolicy: null,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);

    const res = await request(await createApp({
      type: "agent",
      agentId: "33333333-3333-4333-8333-333333333333",
      companyId: "company-1",
      runId: "run-1",
    }))
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "in_review" });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("invalid_issue_disposition");
    expect(res.body.error).toContain("request_confirmation");
    expect(res.body.details).toMatchObject({
      code: "invalid_issue_disposition",
      missing: "review_path",
    });
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("allows an agent-authored in_review transition with a pending confirmation interaction", async () => {
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "todo",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1004",
      title: "Pending confirmation",
      executionPolicy: null,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueThreadInteractionService.listForIssue.mockResolvedValue([
/* @ts-ignore - test fixture wider than narrowed type */
      { id: "interaction-1", kind: "request_confirmation", status: "pending" },
    ]);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp({
      type: "agent",
      agentId: "33333333-3333-4333-8333-333333333333",
      companyId: "company-1",
      runId: "run-1",
    }))
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "in_review" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.objectContaining({ status: "in_review" }),
    );
  });

  it("allows an agent-authored in_review transition with a pending checkbox confirmation interaction", async () => {
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "todo",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1008",
      title: "Pending checkbox confirmation",
      executionPolicy: null,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueThreadInteractionService.listForIssue.mockResolvedValue([
/* @ts-ignore - test fixture wider than narrowed type */
      { id: "interaction-2", kind: "request_checkbox_confirmation", status: "pending" },
    ]);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp({
      type: "agent",
      agentId: "33333333-3333-4333-8333-333333333333",
      companyId: "company-1",
      runId: "run-1",
    }))
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "in_review" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.objectContaining({ status: "in_review" }),
    );
  });

  it("rejects an agent-authored in_review transition with only a non-review pending interaction", async () => {
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "todo",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1006",
      title: "Pending non-review interaction",
      executionPolicy: null,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueThreadInteractionService.listForIssue.mockResolvedValue([
/* @ts-ignore - test fixture wider than narrowed type */
      { id: "interaction-1", kind: "background_liveness", status: "pending" },
    ]);

    const res = await request(await createApp({
      type: "agent",
      agentId: "33333333-3333-4333-8333-333333333333",
      companyId: "company-1",
      runId: "run-1",
    }))
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "in_review" });

    expect(res.status).toBe(422);
    expect(res.body.details).toMatchObject({
      code: "invalid_issue_disposition",
      missing: "review_path",
    });
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("allows a non-PR issue with prior checklist evidence to return to in_review for pending confirmation", async () => {
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_progress",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1007",
      title: "Runbook evidence confirmation",
      description:
        "## Acceptance criteria\n- Runbook evidence is ready\n\n## Verifying signal\n- Pending confirmation accepts the runbook evidence",
      executionPolicy: null,
      executionState: null,
      labels: [],
      lastEvidenceVerdict: {
        verdict: "pass",
        missing: [],
        evidenceFound: ["checklist:done-when"],
        unlabeledFallback: true,
        evaluatedAt: "2026-06-12T00:00:00.000Z",
      },
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueThreadInteractionService.listForIssue.mockResolvedValue([
/* @ts-ignore - test fixture wider than narrowed type */
      {
        id: "94bcd166-0000-4000-8000-000000000000",
        kind: "request_confirmation",
        status: "pending",
      },
    ]);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp({
      type: "agent",
      agentId: "33333333-3333-4333-8333-333333333333",
      companyId: "company-1",
      runId: "run-1",
    }))
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "in_review" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.objectContaining({ status: "in_review" }),
    );
    expect(res.body.lastEvidenceVerdict).toMatchObject({
      verdict: "pass",
      evidenceFound: ["checklist:done-when"],
    });
  });

  it("allows an agent-authored in_review transition with a typed execution participant", async () => {
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "todo",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1005",
      title: "Execution participant",
      executionPolicy: null,
      executionState: null,
    };
    const policy = normalizeIssueExecutionPolicy({
      stages: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          type: "review",
          participants: [{ type: "agent", agentId: "44444444-4444-4444-8444-444444444444" }],
        },
      ],
    })!;
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp({
      type: "agent",
      agentId: "33333333-3333-4333-8333-333333333333",
      companyId: "company-1",
      runId: "run-1",
    }))
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "in_review", executionPolicy: policy });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.objectContaining({
        status: "in_review",
        executionState: expect.objectContaining({
          status: "pending",
          currentParticipant: expect.objectContaining({
            type: "agent",
            agentId: "44444444-4444-4444-8444-444444444444",
          }),
        }),
      }),
    );
  });

  it("allows an agent-authored in_review transition with a scheduled monitor", async () => {
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "todo",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1006",
      title: "External review monitor",
      executionPolicy: null,
      executionState: null,
      monitorAttemptCount: 0,
      monitorNextCheckAt: null,
      monitorLastTriggeredAt: null,
      monitorNotes: null,
      monitorScheduledBy: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp({
      type: "agent",
      agentId: "33333333-3333-4333-8333-333333333333",
      companyId: "company-1",
      runId: "run-1",
    }))
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({
        status: "in_review",
        executionPolicy: {
          monitor: {
            nextCheckAt: "2026-12-01T12:00:00.000Z",
            scheduledBy: "assignee",
            notes: "Wait for external QA report.",
          },
        },
      });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.objectContaining({
        status: "in_review",
        monitorNextCheckAt: new Date("2026-12-01T12:00:00.000Z"),
      }),
    );
  });

  it("lets a checked-out execution agent re-arm a board-scheduled monitor", async () => {
    const previousPolicy = normalizeIssueExecutionPolicy({
      monitor: {
        nextCheckAt: "2099-12-01T12:00:00.000Z",
        scheduledBy: "board",
        notes: "signature=unchanged; next=old",
        kind: "external_service",
        serviceName: "github-pr",
        externalRef: "https://github.com/paperclipai/paperclip/pull/411",
      },
    });
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_review",
      assigneeAgentId: null,
      assigneeUserId: null,
      checkoutRunId: "run-1",
      executionRunId: "run-1",
      createdByUserId: "local-board",
      identifier: "PAP-1008",
      title: "PR monitor wait",
      executionPolicy: previousPolicy,
      executionState: null,
      monitorAttemptCount: 1,
      monitorNextCheckAt: new Date("2099-12-01T12:00:00.000Z"),
      monitorLastTriggeredAt: new Date("2026-06-15T03:00:00.000Z"),
      monitorNotes: "signature=unchanged; next=old",
      monitorScheduledBy: "board",
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp({
      type: "agent",
      agentId: "33333333-3333-4333-8333-333333333333",
      companyId: "company-1",
      runId: "run-1",
    }))
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({
        status: "in_review",
        executionPolicy: {
          monitor: {
            nextCheckAt: "2099-12-01T13:00:00.000Z",
            scheduledBy: "board",
            notes: "signature=unchanged; next=2099-12-01T13:00:00.000Z",
            kind: "external_service",
            serviceName: "github-pr",
            externalRef: "https://github.com/paperclipai/paperclip/pull/411",
          },
        },
      });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.objectContaining({
        status: "in_review",
        assigneeAgentId: "33333333-3333-4333-8333-333333333333",
        assigneeUserId: null,
        monitorNextCheckAt: new Date("2099-12-01T13:00:00.000Z"),
        monitorScheduledBy: "assignee",
      }),
      expect.anything(),
    );
  });

  it("keeps a checked-out review-waiting monitor scheduled on status-only in_review return", async () => {
    const policy = normalizeIssueExecutionPolicy({
      monitor: {
        nextCheckAt: "2099-12-01T12:00:00.000Z",
        scheduledBy: "board",
        notes: "signature=unchanged",
        kind: "external_service",
        serviceName: "github-pr",
        externalRef: "https://github.com/paperclipai/paperclip/pull/411",
      },
    });
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_progress",
      assigneeAgentId: null,
      assigneeUserId: null,
      checkoutRunId: "run-1",
      executionRunId: "run-1",
      createdByUserId: "local-board",
      identifier: "PAP-1009",
      title: "Status-only monitor wait",
      executionPolicy: policy,
      executionState: null,
      monitorAttemptCount: 1,
      monitorNextCheckAt: new Date("2099-12-01T12:00:00.000Z"),
      monitorLastTriggeredAt: null,
      monitorNotes: "signature=unchanged",
      monitorScheduledBy: "board",
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp({
      type: "agent",
      agentId: "33333333-3333-4333-8333-333333333333",
      companyId: "company-1",
      runId: "run-1",
    }))
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "in_review" });

    expect(res.status).toBe(200);
    const updatePatch = mockIssueService.update.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(updatePatch).toEqual(expect.objectContaining({
      status: "in_review",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      monitorNextCheckAt: new Date("2099-12-01T12:00:00.000Z"),
    }));
    expect(updatePatch.executionPolicy).not.toBeNull();
    expect(updatePatch.executionState).toBeUndefined();
  });

  it("allows board-authored in_review repair updates without a review path", async () => {
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "todo",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1007",
      title: "Board repair",
      executionPolicy: null,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp())
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "in_review" });

    expect(res.status).toBe(200);
    expect(mockIssueThreadInteractionService.listForIssue).not.toHaveBeenCalled();
    expect(mockIssueApprovalService.listApprovalsForIssue).not.toHaveBeenCalled();
  });

  it("does not auto-start execution review when reviewers are added to an already in_review issue", async () => {
    const policy = normalizeIssueExecutionPolicy({
      stages: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          type: "review",
          participants: [{ type: "agent", agentId: "33333333-3333-4333-8333-333333333333" }],
        },
      ],
    })!;
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_review",
      assigneeAgentId: null,
      assigneeUserId: "local-board",
      createdByUserId: "local-board",
      identifier: "PAP-999",
      title: "Execution policy edit",
      executionPolicy: null,
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp())
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ executionPolicy: policy });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.objectContaining({
        executionPolicy: policy,
        actorAgentId: null,
        actorUserId: "local-board",
      }),
    );
    const updatePatch = mockIssueService.update.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(updatePatch.status).toBeUndefined();
    expect(updatePatch.assigneeAgentId).toBeUndefined();
    expect(updatePatch.assigneeUserId).toBeUndefined();
    expect(updatePatch.executionState).toBeUndefined();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  // BLO-18790 / BLO-18782 / BLO-18783 / BLO-18168 (same defect, filed four times).
  // The monitor on BLO-12852 sat dead for ~4h across three runs because writes shaped as
  // top-level `monitor` / `monitorNextCheckAt` were stripped by the non-strict body schema:
  // HTTP 200, `updatedAt` bumped, nothing persisted. A `triggered` monitor was never the cause.
  describe("monitor re-arm on a triggered monitor (BLO-18790)", () => {
    // Mirrors BLO-12852's observed row exactly: triggered, no nextCheckAt, 18 attempts burned,
    // maxAttempts null, and executionPolicy null (the monitor lives only in the columns + state).
    const wedgedIssue = () => ({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_progress",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      checkoutRunId: "run-1",
      executionRunId: "run-1",
      createdByUserId: "local-board",
      identifier: "PAP-12852",
      title: "Wedged triggered monitor",
      executionPolicy: null,
      executionState: {
        status: "idle",
        monitor: {
          status: "triggered",
          nextCheckAt: null,
          lastTriggeredAt: "2026-07-29T18:51:23.137Z",
          attemptCount: 18,
          maxAttempts: null,
          notes: "stale signature written at 18:51Z",
          scheduledBy: "assignee",
          clearedAt: null,
          clearReason: null,
        },
      },
      monitorAttemptCount: 18,
      monitorNextCheckAt: null,
      monitorLastTriggeredAt: new Date("2026-07-29T18:51:23.137Z"),
      monitorNotes: "stale signature written at 18:51Z",
      monitorScheduledBy: "assignee",
    });

    // Same row, but carrying policy fields that a monitor write must not take down with it.
    // `reviewPreset`/`authorizationPolicy` ride along with `stages` so the assertions below cover
    // every field an `executionPolicy` replacement can drop, not just the one that is easiest to see.
    const REVIEWER_AGENT_ID = "44444444-4444-4444-8444-444444444444";
    const stagedIssue = () => ({
      ...wedgedIssue(),
      executionPolicy: normalizeIssueExecutionPolicy({
        mode: "normal",
        commentRequired: true,
        stages: [
          { type: "review", participants: [{ type: "agent", agentId: REVIEWER_AGENT_ID }] },
        ],
        reviewPreset: { id: "low_trust_review", version: 1, rawOutputDisposition: "quarantine" },
        // The security-sensitive one: a trust boundary that confines the issue's agents and tools.
        // Losing this to a monitor write silently widens what the assignee is allowed to do, so it
        // gets the same drop/preserve assertions as `stages` and `reviewPreset` below.
        authorizationPolicy: {
          trustPreset: "low_trust_review",
          trustBoundary: {
            mode: "low_trust_review",
            allowedAgentIds: [REVIEWER_AGENT_ID],
            allowedToolClasses: ["read"],
          },
        },
        monitor: {
          nextCheckAt: "2099-11-01T13:00:00.000Z",
          notes: "armed",
          scheduledBy: "assignee",
        },
      }),
    });

    const patchIssue = async (body: unknown) => {
      const app = await createApp({
        type: "agent",
        agentId: "33333333-3333-4333-8333-333333333333",
        companyId: "company-1",
        runId: "run-1",
      });
      return request(app).patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa").send(body);
    };

    it("persists a re-arm through executionPolicy.monitor despite triggered state and 18 burned attempts", async () => {
      const issue = wedgedIssue();
      mockIssueService.getById.mockResolvedValue(issue);
      mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
        ...issue,
        ...patch,
        updatedAt: new Date(),
      }));

      const res = await request(await createApp({
        type: "agent",
        agentId: "33333333-3333-4333-8333-333333333333",
        companyId: "company-1",
        runId: "run-1",
      }))
        .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
        .send({
          executionPolicy: {
            monitor: {
              nextCheckAt: "2099-12-01T13:00:00.000Z",
              notes: "signature=unchanged; next=2099-12-01T13:00:00.000Z",
              scheduledBy: "assignee",
            },
          },
        });

      expect(res.status).toBe(200);
      // The exact bug was 200-with-unchanged-row, so assert the row actually moved rather than
      // just that the request succeeded.
      const patch = mockIssueService.update.mock.calls.at(-1)?.[1] as Record<string, unknown>;
      expect(patch.monitorNextCheckAt).toEqual(new Date("2099-12-01T13:00:00.000Z"));
      expect(patch.monitorNotes).toBe("signature=unchanged; next=2099-12-01T13:00:00.000Z");
      expect(patch.monitorNextCheckAt).not.toBeNull();
      expect(patch.monitorNotes).not.toBe(issue.monitorNotes);
      expect((patch.executionState as { monitor: { status: string } }).monitor.status).toBe("scheduled");
    });

    it.each([
      ["monitor", { nextCheckAt: "2099-12-01T13:00:00.000Z", notes: "sig", scheduledBy: "assignee" }],
      ["monitorNextCheckAt", "2099-12-01T13:00:00.000Z"],
      ["monitorNotes", "sig"],
    ])("rejects a misplaced top-level `%s` instead of accepting and ignoring it", async (key, value) => {
      const issue = wedgedIssue();
      mockIssueService.getById.mockResolvedValue(issue);
      mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
        ...issue,
        ...patch,
        updatedAt: new Date(),
      }));

      const res = await request(await createApp({
        type: "agent",
        agentId: "33333333-3333-4333-8333-333333333333",
        companyId: "company-1",
        runId: "run-1",
      }))
        .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
        .send({ [key]: value });

      // A 200 here is the regression: it means the key was silently dropped again. Constrain the
      // upper end too — a 500 from a schema or middleware exception is not "rejected the key".
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
      expect(JSON.stringify(res.body)).toContain("executionPolicy.monitor");
      // Nothing may be written when the body is rejected.
      expect(mockIssueService.update).not.toHaveBeenCalled();
    });


    // Why the schema guidance tells callers to re-send the COMPLETE policy with only `monitor`
    // omitted, rather than the shorter-looking `{"executionPolicy":{}}`: the update replaces the
    // whole policy, so the terse form silently drops the review stages too.
    it("drops unrelated policy fields when a monitor clear sends a bare executionPolicy", async () => {
      const issue = stagedIssue();
      mockIssueService.getById.mockResolvedValue(issue);
      mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
        ...issue,
        ...patch,
        updatedAt: new Date(),
      }));

      expect(issue.executionPolicy?.stages).toHaveLength(1);

      const res = await patchIssue({ executionPolicy: {} });

      expect(res.status).toBe(200);
      const patch = mockIssueService.update.mock.calls.at(-1)?.[1] as Record<string, unknown>;
      // The monitor clear lands...
      expect(patch.monitorNextCheckAt).toBeNull();
      // ...but it takes the whole policy with it: normalizeIssueExecutionPolicy collapses a
      // stage-less, monitor-less policy to null, so the review stage asserted above is gone.
      // This is why the schema guidance says to re-send the COMPLETE policy minus `monitor`.
      expect("executionPolicy" in patch).toBe(true);
      expect(patch.executionPolicy).toBeNull();
    });

    // The same replacement rule bites arming/re-arming, not just clearing — a monitor-only body
    // is a policy that happens to have no stages, so it erases them. This is the destructive case
    // the guidance has to steer callers away from, so pin it: if the server ever starts merging
    // monitor-only writes, this test fails and the guidance must be rewritten to match.
    it("drops unrelated policy fields when a re-arm sends a monitor-only executionPolicy", async () => {
      const issue = stagedIssue();
      mockIssueService.getById.mockResolvedValue(issue);
      mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
        ...issue,
        ...patch,
        updatedAt: new Date(),
      }));

      expect(issue.executionPolicy?.stages).toHaveLength(1);
      expect(issue.executionPolicy?.reviewPreset).toBeTruthy();
      expect(issue.executionPolicy?.authorizationPolicy).toBeTruthy();

      const res = await patchIssue({
        executionPolicy: {
          monitor: {
            nextCheckAt: "2099-12-01T13:00:00.000Z",
            notes: "signature=unchanged",
            scheduledBy: "assignee",
          },
        },
      });

      expect(res.status).toBe(200);
      const patch = mockIssueService.update.mock.calls.at(-1)?.[1] as Record<string, unknown>;
      const nextPolicy = patch.executionPolicy as {
        stages?: unknown[];
        reviewPreset?: unknown;
        authorizationPolicy?: unknown;
      } | null;
      // The monitor is armed as asked...
      expect(patch.monitorNextCheckAt).toEqual(new Date("2099-12-01T13:00:00.000Z"));
      // ...and the review stage, preset and trust boundary the caller never mentioned are gone
      // with it. The `authorizationPolicy` loss is the one with teeth: it silently un-confines the
      // issue rather than just skipping a review.
      expect(nextPolicy?.stages ?? []).toHaveLength(0);
      expect(nextPolicy?.reviewPreset ?? null).toBeNull();
      expect(nextPolicy?.authorizationPolicy ?? null).toBeNull();
    });

    // ...and the pattern the guidance actually prescribes: read the current policy, re-send it
    // complete with `monitor` swapped in. Same arm, no collateral damage.
    it("preserves unrelated policy fields when a re-arm re-sends the complete policy", async () => {
      const issue = stagedIssue();
      mockIssueService.getById.mockResolvedValue(issue);
      mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
        ...issue,
        ...patch,
        updatedAt: new Date(),
      }));

      const res = await patchIssue({
        executionPolicy: {
          ...issue.executionPolicy,
          monitor: {
            nextCheckAt: "2099-12-01T13:00:00.000Z",
            notes: "signature=unchanged",
            scheduledBy: "assignee",
          },
        },
      });

      expect(res.status).toBe(200);
      const patch = mockIssueService.update.mock.calls.at(-1)?.[1] as Record<string, unknown>;
      const nextPolicy = patch.executionPolicy as {
        stages: Array<{ type: string; participants: Array<{ agentId: string | null }> }>;
        reviewPreset?: { id: string } | null;
        authorizationPolicy?: {
          trustPreset?: string;
          trustBoundary?: { mode?: string; allowedAgentIds?: string[]; allowedToolClasses?: string[] };
        } | null;
      };
      expect(patch.monitorNextCheckAt).toEqual(new Date("2099-12-01T13:00:00.000Z"));
      expect(patch.monitorNotes).toBe("signature=unchanged");
      expect(nextPolicy.stages).toHaveLength(1);
      expect(nextPolicy.stages[0]?.participants[0]?.agentId).toBe(REVIEWER_AGENT_ID);
      expect(nextPolicy.reviewPreset?.id).toBe("low_trust_review");
      // The trust boundary survives intact, nested fields included — a re-arm must not quietly
      // relax it, so assert the contents rather than mere presence.
      expect(nextPolicy.authorizationPolicy?.trustPreset).toBe("low_trust_review");
      expect(nextPolicy.authorizationPolicy?.trustBoundary).toEqual({
        mode: "low_trust_review",
        allowedAgentIds: [REVIEWER_AGENT_ID],
        allowedToolClasses: ["read"],
      });
    });
  });


  it("triggers a scheduled monitor immediately from the dedicated route", async () => {
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_progress",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1001",
      title: "Manual monitor trigger",
      executionPolicy: normalizeIssueExecutionPolicy({
        monitor: {
          nextCheckAt: "2026-04-11T12:30:00.000Z",
          notes: "Check deployment",
          scheduledBy: "board",
        },
      }),
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);

    const res = await request(await createApp())
      .post("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/monitor/check-now")
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(mockHeartbeatService.triggerIssueMonitor).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expect.objectContaining({
        actorType: "user",
        actorId: "local-board",
        agentId: null,
      }),
    );
  });

  it("lets a board user create a child issue with a scheduled monitor", async () => {
    mockIssueService.getById.mockResolvedValue({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_progress",
      assigneeAgentId: "11111111-1111-4111-8111-111111111111",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1001",
      title: "Parent issue",
      executionPolicy: null,
      executionState: null,
    });

    const res = await request(await createApp())
      .post("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/children")
      .send({
        title: "Child monitor",
        status: "in_review",
        assigneeAgentId: "33333333-3333-4333-8333-333333333333",
        executionPolicy: {
          monitor: {
            nextCheckAt: "2026-04-11T12:30:00.000Z",
            scheduledBy: "assignee",
          },
        },
      });

    expect(res.status).toBe(201);
    const createPayload = mockIssueService.createChild.mock.calls[0]?.[1] as {
      executionPolicy: { monitor: { scheduledBy: string } };
    };
    expect(createPayload.executionPolicy.monitor.scheduledBy).toBe("board");
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.monitor_scheduled",
        details: expect.objectContaining({
          scheduledBy: "board",
        }),
      }),
    );
  });

  it("rejects child monitor scheduling by a non-assignee agent even with task assignment permission", async () => {
    mockAccessService.hasPermission.mockResolvedValue(true);
    mockIssueService.getById.mockResolvedValue({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_progress",
      assigneeAgentId: "11111111-1111-4111-8111-111111111111",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1001",
      title: "Parent issue",
      executionPolicy: null,
      executionState: null,
    });

    const res = await request(await createApp({
      type: "agent",
      agentId: "22222222-2222-4222-8222-222222222222",
      companyId: "company-1",
      runId: "run-1",
    }))
      .post("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/children")
      .send({
        title: "Child monitor",
        status: "in_review",
        assigneeAgentId: "33333333-3333-4333-8333-333333333333",
        executionPolicy: {
          monitor: {
            nextCheckAt: "2026-04-11T12:30:00.000Z",
            scheduledBy: "board",
          },
        },
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Only the assignee agent or a board user can manage issue monitors");
    expect(mockIssueService.createChild).not.toHaveBeenCalled();
  });

  it("normalizes spoofed child monitor scheduledBy to the assignee actor", async () => {
    mockAccessService.hasPermission.mockResolvedValue(true);
    mockIssueService.getById.mockResolvedValue({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_progress",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1001",
      title: "Parent issue",
      executionPolicy: null,
      executionState: null,
    });

    const res = await request(await createApp({
      type: "agent",
      agentId: "33333333-3333-4333-8333-333333333333",
      companyId: "company-1",
      runId: "run-1",
    }))
      .post("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/children")
      .send({
        title: "Child monitor",
        status: "in_review",
        assigneeAgentId: "33333333-3333-4333-8333-333333333333",
        executionPolicy: {
          monitor: {
            nextCheckAt: "2026-04-11T12:30:00.000Z",
            scheduledBy: "board",
            externalRef: "https://example.test/deploy?token=secret",
          },
        },
      });

    expect(res.status).toBe(201);
    const createPayload = mockIssueService.createChild.mock.calls[0]?.[1] as {
      executionPolicy: { monitor: { scheduledBy: string; externalRef: string | null } };
    };
    expect(createPayload.executionPolicy.monitor.scheduledBy).toBe("assignee");
    expect(createPayload.executionPolicy.monitor.externalRef).toBe("[redacted]");
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.monitor_scheduled",
        entityId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        details: expect.not.objectContaining({ externalRef: expect.anything() }),
      }),
    );
  });

  // BLO-9316: agent must be able to correct an in_review issue to blocked
  // when unresolved first-class blockers already exist, even when an execution
  // policy review stage is active and the actor is the current participant.
  describe("in_review → blocked correction with active execution stage (BLO-9316)", () => {
    const reviewStageId = "55555555-5555-4555-8555-555555555555";
    const reviewerAgentId = "44444444-4444-4444-8444-444444444444";
    const implementerAgentId = "33333333-3333-4333-8333-333333333333";
    const unrelatedAgentId = "66666666-6666-4666-8666-666666666666";

    function makeInReviewIssue(overrides: Record<string, unknown> = {}) {
      const policy = normalizeIssueExecutionPolicy({
        stages: [
          {
            id: reviewStageId,
            type: "review",
            participants: [{ type: "agent", agentId: reviewerAgentId }],
          },
        ],
      })!;
      return {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        companyId: "company-1",
        status: "in_review",
        assigneeAgentId: reviewerAgentId,
        assigneeUserId: null,
        createdByUserId: "local-board",
        identifier: "PAP-4382",
        title: "Issue with active review + unresolved blocker",
        executionPolicy: policy,
        executionState: {
          status: "pending",
          currentStageId: reviewStageId,
          currentStageIndex: 0,
          currentStageType: "review",
          currentParticipant: { type: "agent", agentId: reviewerAgentId },
          returnAssignee: { type: "agent", agentId: implementerAgentId },
          completedStageIds: [],
          lastDecisionId: null,
          lastDecisionOutcome: null,
        },
        ...overrides,
      };
    }

    it("allows the reviewer (current participant) to transition to blocked: does not override to in_progress", async () => {
      const issue = makeInReviewIssue();
      mockIssueService.getById.mockResolvedValue(issue);
      mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
        ...issue,
        ...patch,
        updatedAt: new Date(),
      }));

      const res = await request(await createApp({
        type: "agent",
        agentId: reviewerAgentId,
        companyId: "company-1",
        runId: "run-blo-9316",
      }))
        .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
        .send({ status: "blocked", comment: "Blocked by BLO-9270, cannot review until resolved." });

      expect(res.status).toBe(200);
      const updateCall = mockIssueService.update.mock.calls[0]?.[1] as Record<string, unknown>;
      expect(updateCall.status).toBe("blocked");
      expect(updateCall.executionState).toBeNull();
    });

    it("allows the implementer (non-participant) to transition to blocked without a stage-advance error", async () => {
      const issue = makeInReviewIssue({ assigneeAgentId: reviewerAgentId });
      mockIssueService.getById.mockResolvedValue(issue);
      mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
        ...issue,
        ...patch,
        updatedAt: new Date(),
      }));

      const res = await request(await createApp({
        type: "agent",
        agentId: implementerAgentId,
        companyId: "company-1",
        runId: "run-blo-9316b",
      }))
        .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
        .send({ status: "blocked" });

      expect(res.status).toBe(200);
      const updateCall = mockIssueService.update.mock.calls[0]?.[1] as Record<string, unknown>;
      expect(updateCall.status).toBe("blocked");
      expect(updateCall.executionState).toBeNull();
    });

    it("rejects blocked correction payloads with unrelated issue mutations", async () => {
      const issue = makeInReviewIssue({ assigneeAgentId: reviewerAgentId });
      mockIssueService.getById.mockResolvedValue(issue);

      const res = await request(await createApp({
        type: "agent",
        agentId: implementerAgentId,
        companyId: "company-1",
        runId: "run-blo-9316-extra-fields",
      }))
        .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
        .send({ status: "blocked", title: "pwned" });

      expect(res.status).toBe(403);
      expect(mockIssueService.update).not.toHaveBeenCalled();
    });

    it("rejects an unrelated agent so blocked correction does not bypass issue ownership broadly", async () => {
      const issue = makeInReviewIssue({ assigneeAgentId: reviewerAgentId });
      mockIssueService.getById.mockResolvedValue(issue);

      const res = await request(await createApp({
        type: "agent",
        agentId: unrelatedAgentId,
        companyId: "company-1",
        runId: "run-blo-9316c",
      }))
        .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
        .send({ status: "blocked" });

      expect(res.status).toBe(403);
      expect(mockIssueService.update).not.toHaveBeenCalled();
    });
  });

  describe("execution-stage deadlock override (BLO-15942)", () => {
    const reviewStageId = "77777777-7777-4777-8777-777777777777";
    // Stands in for a mandate-bound reviewer (e.g. Ally) whose mandate excludes
    // advancing issue stages — only tasks:override_execution_stage lets another
    // actor unstick the stage.
    const mandateBoundParticipantAgentId = "88888888-8888-4888-8888-888888888888";
    const implementerAgentId = "33333333-3333-4333-8333-333333333333";
    const unrelatedAgentId = "99999999-9999-4999-8999-999999999999";

    function makeStuckReviewIssue() {
      const policy = normalizeIssueExecutionPolicy({
        stages: [
          {
            id: reviewStageId,
            type: "review",
            participants: [{ type: "agent", agentId: mandateBoundParticipantAgentId }],
          },
        ],
      })!;
      return {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        companyId: "company-1",
        status: "in_review",
        assigneeAgentId: mandateBoundParticipantAgentId,
        assigneeUserId: null,
        createdByUserId: "local-board",
        identifier: "PAP-15942",
        title: "Deadlocked review stage",
        executionPolicy: policy,
        executionState: {
          status: "pending",
          currentStageId: reviewStageId,
          currentStageIndex: 0,
          currentStageType: "review",
          currentParticipant: { type: "agent", agentId: mandateBoundParticipantAgentId },
          returnAssignee: { type: "agent", agentId: implementerAgentId },
          completedStageIds: [],
          lastDecisionId: null,
          lastDecisionOutcome: null,
        },
      };
    }

    it("an authorized operator override force-completes a stage the mandate-bound participant cannot act on", async () => {
      const issue = makeStuckReviewIssue();
      mockIssueService.getById.mockResolvedValue(issue);
      mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
        ...issue,
        ...patch,
        updatedAt: new Date(),
      }));

      // Board/local_implicit is always allowed by the real authorization
      // service (allow_local_board) and is mirrored here by the mock.
      const res = await request(await createApp({
        type: "board",
        userId: "local-board",
        companyIds: ["company-1"],
        source: "local_implicit",
        isInstanceAdmin: false,
      }))
        .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
        .send({
          status: "done",
          comment: "Overriding: reviewer's mandate excludes stage decisions; verified independently.",
        });

      expect(res.status).toBe(200);
      expect(mockIssueService.update).toHaveBeenCalledWith(
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        expect.objectContaining({
          status: "done",
          executionState: expect.objectContaining({
            status: "completed",
            completedStageIds: [reviewStageId],
            lastDecisionOutcome: "approved",
            lastDecisionId: expect.any(String),
          }),
          expectedCurrentStatus: "in_review",
          expectedCurrentExecutionState: issue.executionState,
          expectedCurrentExecutionPolicy: issue.executionPolicy,
        }),
        expect.anything(),
      );
    });

    it("lets the active stage participant decide even when the assignee field diverged", async () => {
      const divergedAssigneeAgentId = "44444444-4444-4444-8444-444444444444";
      const issue = {
        ...makeStuckReviewIssue(),
        assigneeAgentId: divergedAssigneeAgentId,
      };
      mockIssueService.getById.mockResolvedValue(issue);
      mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
        ...issue,
        ...patch,
        updatedAt: new Date(),
      }));

      const res = await request(await createApp({
        type: "agent",
        agentId: mandateBoundParticipantAgentId,
        companyId: "company-1",
        runId: "run-blo-20321-participant-drift",
      }))
        .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
        .send({
          status: "done",
          comment: "Approving as the active execution-stage participant.",
        });

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(mockIssueService.update).toHaveBeenCalledWith(
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        expect.objectContaining({
          status: "done",
          executionState: expect.objectContaining({
            status: "completed",
            completedStageIds: [reviewStageId],
            lastDecisionOutcome: "approved",
            lastDecisionId: expect.any(String),
          }),
        }),
        expect.anything(),
      );
    });

    it("does not let a diverged stage participant smuggle unrelated edits through the decision path", async () => {
      const issue = {
        ...makeStuckReviewIssue(),
        assigneeAgentId: "44444444-4444-4444-8444-444444444444",
      };
      mockIssueService.getById.mockResolvedValue(issue);

      const res = await request(await createApp({
        type: "agent",
        agentId: mandateBoundParticipantAgentId,
        companyId: "company-1",
        runId: "run-blo-20321-participant-drift-smuggle",
      }))
        .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
        .send({
          status: "done",
          title: "Unauthorized rewrite",
          comment: "Trying to approve and rewrite task content.",
        });

      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body.error).toBe("Agent cannot mutate another agent's issue");
      expect(mockIssueService.update).not.toHaveBeenCalled();
    });

    it("still rejects an unrelated, unauthorized agent (regression: override does not open the stage to anyone)", async () => {
      const issue = makeStuckReviewIssue();
      mockIssueService.getById.mockResolvedValue(issue);

      const res = await request(await createApp({
        type: "agent",
        agentId: unrelatedAgentId,
        companyId: "company-1",
        runId: "run-blo-15942",
      }))
        .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
        .send({ status: "done", comment: "Trying to bypass review" });

      // Rejected at the assignee-ownership boundary (403) before the
      // execution-stage transition is even evaluated — an unrelated agent
      // with no tasks:manage_active_checkouts / tasks:override_execution_stage
      // grant never gets far enough to hit the stage's own "only the active
      // reviewer or approver can advance" 422.
      expect(res.status).toBe(403);
      expect(res.body.error).toBe("Agent cannot mutate another agent's issue");
      expect(mockIssueService.update).not.toHaveBeenCalled();
    });

    it("lets the current execution participant approve even when the issue assignee drifted", async () => {
      const divergedAssigneeAgentId = "44444444-4444-4444-8444-444444444444";
      const issue = {
        ...makeStuckReviewIssue(),
        assigneeAgentId: divergedAssigneeAgentId,
      };
      mockIssueService.getById.mockResolvedValue(issue);
      mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
        ...issue,
        ...patch,
        updatedAt: new Date(),
      }));

      const res = await request(await createApp({
        type: "agent",
        agentId: mandateBoundParticipantAgentId,
        companyId: "company-1",
        runId: "run-current-participant-diverged-assignee",
      }))
        .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
        .send({
          status: "done",
          comment: "Approving as the active execution-stage participant.",
        });

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(mockIssueService.update).toHaveBeenCalledWith(
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        expect.objectContaining({
          status: "done",
          executionState: expect.objectContaining({
            status: "completed",
            completedStageIds: [reviewStageId],
            lastDecisionOutcome: "approved",
            lastDecisionId: expect.any(String),
          }),
        }),
        expect.anything(),
      );
    });

    // Boundary tests for the participant grant above (BLO-19081 review finding).
    // The grant is double-narrowed — opt-in via options.allowExecutionStageDecision
    // and restricted to a stage-decision body — because assertAgentIssueMutationAllowed
    // backs 25 routes. Without these, a re-widening would pass the suite silently.
    it("does not let the execution participant reach a destructive route on the drifted issue", async () => {
      const divergedAssigneeAgentId = "44444444-4444-4444-8444-444444444444";
      const issue = {
        ...makeStuckReviewIssue(),
        assigneeAgentId: divergedAssigneeAgentId,
      };
      mockIssueService.getById.mockResolvedValue(issue);

      // DELETE /issues/:id calls assertAgentIssueMutationAllowed with no options,
      // so the stage-decision grant must not be consulted there at all.
      const res = await request(await createApp({
        type: "agent",
        agentId: mandateBoundParticipantAgentId,
        companyId: "company-1",
        runId: "run-participant-tries-delete",
      })).delete("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");

      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body.error).toBe("Agent cannot mutate another agent's issue");
      expect(mockIssueService.remove).not.toHaveBeenCalled();
    });

    it("does not let the execution participant ride the stage grant into a non-decision patch", async () => {
      const divergedAssigneeAgentId = "44444444-4444-4444-8444-444444444444";
      const issue = {
        ...makeStuckReviewIssue(),
        assigneeAgentId: divergedAssigneeAgentId,
      };
      mockIssueService.getById.mockResolvedValue(issue);

      // Same actor, same issue, same route as the passing approve test — the only
      // difference is that the body carries a field beyond {status, comment}, so
      // it is not a stage decision and falls back to the ownership path. `title`
      // is chosen deliberately: it has no permission gate of its own, so the
      // ownership boundary is the only thing that can reject this request and the
      // assertion cannot pass for an unrelated reason.
      const res = await request(await createApp({
        type: "agent",
        agentId: mandateBoundParticipantAgentId,
        companyId: "company-1",
        runId: "run-participant-overreaches",
      }))
        .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
        .send({
          status: "done",
          comment: "Approving.",
          title: "Retitled while I was here",
        });

      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body.error).toBe("Agent cannot mutate another agent's issue");
      expect(mockIssueService.update).not.toHaveBeenCalled();
    });

    it("still rejects a non-participant agent on the drifted issue", async () => {
      const divergedAssigneeAgentId = "44444444-4444-4444-8444-444444444444";
      const issue = {
        ...makeStuckReviewIssue(),
        assigneeAgentId: divergedAssigneeAgentId,
      };
      mockIssueService.getById.mockResolvedValue(issue);

      // Drift is not a general-purpose opening: only the pinned participant gets
      // the stage decision, not any agent that happens to send the right body.
      const res = await request(await createApp({
        type: "agent",
        agentId: unrelatedAgentId,
        companyId: "company-1",
        runId: "run-unrelated-on-drifted-issue",
      }))
        .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
        .send({ status: "done", comment: "Trying to bypass review" });

      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body.error).toBe("Agent cannot mutate another agent's issue");
      expect(mockIssueService.update).not.toHaveBeenCalled();
    });

    it("resolves the override grant against the stage's currentParticipant, not a diverged issue assignee", async () => {
      // Regression for the Ally review finding on this PR: the issue's
      // assigneeAgentId and the stage's currentParticipant can diverge (e.g. a
      // prior reassignment that didn't walk through the execution-policy
      // transition). The override must authorize against the participant a
      // manager is trying to unstick, not whoever the issue happens to be
      // assigned to.
      const divergedAssigneeAgentId = "44444444-4444-4444-8444-444444444444";
      const managerOfParticipantAgentId = "55555555-5555-4555-8555-555555555555";
      const issue = {
        ...makeStuckReviewIssue(),
        assigneeAgentId: divergedAssigneeAgentId,
      };
      mockIssueService.getById.mockResolvedValue(issue);
      mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
        ...issue,
        ...patch,
        updatedAt: new Date(),
      }));

      const decideCalls: Array<{ action?: string; resource?: { assigneeAgentId?: string | null } }> = [];
      mockAccessService.decide.mockImplementation(async (input: {
        actor?: { type?: string; agentId?: string; source?: string };
        action?: string;
        resource?: { assigneeAgentId?: string | null };
      }) => {
        decideCalls.push({ action: input.action, resource: input.resource });
        const isTestActor = input.actor?.type === "agent" && input.actor.agentId === managerOfParticipantAgentId;
        // Mirror the suite-wide default mock's blanket allow for the general
        // read/mutate actions every PATCH exercises, so only the two override
        // grants below are actually under test.
        const isGenerallyAllowedAction =
          isTestActor &&
          ["company_scope:read", "issue:read", "issue:mutate", "runtime:manage"].includes(input.action ?? "");
        // Grant the pre-existing tasks:manage_active_checkouts boundary check
        // broadly (unrelated to this fix) so the request reaches the
        // execution-stage override decision below. Only a manager of the
        // *participant* (not the diverged assignee) is granted
        // tasks:override_execution_stage — proving the resource passed to
        // access.decide for that action targets the participant, not the
        // issue's assignee.
        const allowed =
          isGenerallyAllowedAction ||
          (input.action === "tasks:manage_active_checkouts" && isTestActor) ||
          (input.action === "tasks:override_execution_stage" &&
            isTestActor &&
            input.resource?.assigneeAgentId === mandateBoundParticipantAgentId);
        return {
          allowed,
          action: input.action,
          reason: allowed ? "allow_manager_chain" : "deny_missing_grant",
          explanation: allowed ? "Allowed by test grant." : `Missing permission: ${input.action ?? "action"}`,
        };
      });

      const res = await request(await createApp({
        type: "agent",
        agentId: managerOfParticipantAgentId,
        companyId: "company-1",
        runId: "run-blo-15942-divergence",
      }))
        .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
        .send({
          status: "done",
          comment: "Overriding as manager of the mandate-bound participant.",
        });

      expect(res.status).toBe(200);
      const overrideCall = decideCalls.find((call) => call.action === "tasks:override_execution_stage");
      expect(overrideCall?.resource?.assigneeAgentId).toBe(mandateBoundParticipantAgentId);
      expect(overrideCall?.resource?.assigneeAgentId).not.toBe(divergedAssigneeAgentId);
    });
  });

  it("pins the execution snapshot when updating a pending stage review request", async () => {
    const executionPolicy = normalizeIssueExecutionPolicy({
      stages: [{
        id: "11111111-1111-4111-8111-111111111111",
        type: "review",
        participants: [{ type: "agent", agentId: "33333333-3333-4333-8333-333333333333" }],
      }],
    })!;
    const executionState = {
      status: "pending",
      currentStageId: "11111111-1111-4111-8111-111111111111",
      currentStageIndex: 0,
      currentStageType: "review",
      currentParticipant: { type: "agent", agentId: "33333333-3333-4333-8333-333333333333" },
      returnAssignee: { type: "agent", agentId: "33333333-3333-4333-8333-333333333333" },
      completedStageIds: [],
      lastDecisionId: null,
      lastDecisionOutcome: null,
      reviewRequest: null,
    };
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      status: "in_review",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-1054",
      title: "Concurrent review request",
      executionPolicy,
      executionState,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp({
      type: "agent",
      agentId: "33333333-3333-4333-8333-333333333333",
      companyId: "company-1",
      runId: "run-1",
    }))
      .patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ reviewRequest: { instructions: "Check the concurrency behavior." } });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      issue.id,
      expect.objectContaining({
        executionState: expect.objectContaining({
          reviewRequest: { instructions: "Check the concurrency behavior." },
        }),
        expectedCurrentStatus: "in_review",
        expectedCurrentExecutionState: executionState,
        expectedCurrentExecutionPolicy: executionPolicy,
      }),
      expect.anything(),
    );
  });

  describe("monitor convergence guard (BLO-18294)", () => {
    const CONVERGED_ISSUE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const BLOCKER_ISSUE_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const ACTING_AGENT_ID = "33333333-3333-4333-8333-333333333333";
    const BLOCKER_OWNER_AGENT_ID = "44444444-4444-4444-8444-444444444444";

    function armedMonitor(nextCheckAt: string) {
      return {
        nextCheckAt,
        notes: "still waiting on the donor host drain",
        scheduledBy: "assignee" as const,
      };
    }

    function issueWithTriggeredMonitor(input: {
      blockerIssueIds?: string[];
      notes?: string;
      convergenceCount?: number;
    } = {}) {
      const blockerIssueIds = input.blockerIssueIds ?? [BLOCKER_ISSUE_ID];
      const notes = input.notes ?? "still waiting on the donor host drain";
      const { fingerprint, source } = computeIssueMonitorGateFingerprint({
        unresolvedBlockerIssueIds: blockerIssueIds,
      });
      return {
        id: CONVERGED_ISSUE_ID,
        companyId: "company-1",
        status: "in_progress",
        assigneeAgentId: ACTING_AGENT_ID,
        assigneeUserId: null,
        checkoutRunId: "run-1",
        executionRunId: "run-1",
        createdByUserId: "local-board",
        identifier: "PAP-13266",
        title: "Donor host extraction",
        // A monitor that has already fired has been stripped from the policy by
        // `buildIssueMonitorTriggeredPatch`; only executionState still describes it.
        executionPolicy: null,
        executionState: {
          status: "idle",
          currentStageId: null,
          currentStageIndex: null,
          currentStageType: null,
          currentParticipant: null,
          returnAssignee: null,
          reviewRequest: null,
          completedStageIds: [],
          lastDecisionId: null,
          lastDecisionOutcome: null,
          monitor: {
            status: "triggered",
            nextCheckAt: null,
            lastTriggeredAt: "2026-07-23T12:00:00.000Z",
            attemptCount: 3,
            notes,
            scheduledBy: "assignee",
            gateFingerprint: fingerprint,
            gateSource: source,
            convergenceCount: input.convergenceCount ?? 3,
            clearedAt: null,
            clearReason: null,
          },
        },
        monitorAttemptCount: 3,
        monitorNextCheckAt: null,
        monitorLastTriggeredAt: new Date("2026-07-23T12:00:00.000Z"),
        monitorNotes: notes,
        monitorScheduledBy: "assignee",
      };
    }

    function issueWithClearedStalledMonitor() {
      const issue = issueWithTriggeredMonitor({ convergenceCount: 4 });
      return {
        ...issue,
        executionState: {
          ...issue.executionState,
          monitor: {
            ...(issue.executionState.monitor as Record<string, unknown>),
            status: "cleared",
            convergenceStallCount: 1,
            convergenceStalledAssigneeAgentId: ACTING_AGENT_ID,
            clearedAt: "2026-07-23T12:05:00.000Z",
            clearReason: "convergence_stalled",
          },
        },
      };
    }

    it("refuses the re-arm, blocks the issue, and names the unblock owners", async () => {
      // Three prior re-checks already reported this exact blocker set.
      const issue = issueWithTriggeredMonitor();

      mockIssueService.getById.mockResolvedValue(issue);
      mockIssueService.listDependencyReadiness.mockResolvedValue(
        new Map([[CONVERGED_ISSUE_ID, { issueId: CONVERGED_ISSUE_ID, unresolvedBlockerIssueIds: [BLOCKER_ISSUE_ID] }]]),
      );
      mockDbLeftJoinWhere.mockResolvedValue([
        {
          issueId: BLOCKER_ISSUE_ID,
          identifier: "PAP-9001",
          title: "Grant Proxmox migration window",
          status: "todo",
          assigneeAgentId: BLOCKER_OWNER_AGENT_ID,
          assigneeUserId: null,
          assigneeAgentName: "Platform SRE",
        },
      ]);
      mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
        ...issue,
        ...patch,
        updatedAt: new Date(),
      }));

      const res = await request(await createApp({
        type: "agent",
        agentId: ACTING_AGENT_ID,
        companyId: "company-1",
        runId: "run-1",
      }))
        .patch(`/api/issues/${CONVERGED_ISSUE_ID}`)
        .send({ executionPolicy: { monitor: armedMonitor("2099-12-01T12:30:00.000Z") } });

      expect(res.status).toBe(200);

      const patch = mockIssueService.update.mock.calls.at(-1)?.[1] as Record<string, unknown>;
      expect(patch.status).toBe("blocked");
      expect(patch.monitorNextCheckAt).toBeNull();

      const commentCall = mockIssueService.addComment.mock.calls
        .find((call) => call[0] === CONVERGED_ISSUE_ID && String(call[1]).includes("Monitor stopped re-arming"));
      expect(commentCall).toBeDefined();
      expect(commentCall![1]).toContain("Unblock owners:");
      expect(commentCall![1]).toContain("PAP-9001");
      expect(commentCall![1]).toContain(`agent://${BLOCKER_OWNER_AGENT_ID}`);
      expect(commentCall![2]).toEqual({ runId: "run-1" });
      expect(commentCall![3]).toMatchObject({ authorType: "system" });

      const activity = mockLogActivity.mock.calls
        .map((call) => call[1] as { action?: string; details?: Record<string, unknown> })
        .find((value) => value?.action === "issue.monitor_convergence_stalled");
      expect(activity).toBeDefined();
      expect(activity!.details).toMatchObject({
        gateSource: "gates",
        convergenceCount: 4,
        threshold: 3,
        unresolvedBlockerIssueIds: [BLOCKER_ISSUE_ID],
      });
    });

    it("leaves a re-arm alone while the blocker set is still narrowing", async () => {
      const issue = issueWithTriggeredMonitor({
        blockerIssueIds: [BLOCKER_ISSUE_ID, "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"],
        notes: "still waiting",
      });

      mockIssueService.getById.mockResolvedValue(issue);
      mockIssueService.listDependencyReadiness.mockResolvedValue(
        new Map([[CONVERGED_ISSUE_ID, { issueId: CONVERGED_ISSUE_ID, unresolvedBlockerIssueIds: [BLOCKER_ISSUE_ID] }]]),
      );
      mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
        ...issue,
        ...patch,
        updatedAt: new Date(),
      }));

      const res = await request(await createApp({
        type: "agent",
        agentId: ACTING_AGENT_ID,
        companyId: "company-1",
        runId: "run-1",
      }))
        .patch(`/api/issues/${CONVERGED_ISSUE_ID}`)
        .send({ executionPolicy: { monitor: armedMonitor("2099-12-01T12:30:00.000Z") } });

      expect(res.status).toBe(200);
      const patch = mockIssueService.update.mock.calls.at(-1)?.[1] as Record<string, unknown>;
      expect(patch.status).toBeUndefined();
      expect(patch.monitorNextCheckAt).toEqual(new Date("2099-12-01T12:30:00.000Z"));
      expect(
        mockLogActivity.mock.calls.some((call) => (call[1] as { action?: string })?.action === "issue.monitor_convergence_stalled"),
      ).toBe(false);
    });

    it("skips convergence scoring when blocker readiness lookup fails", async () => {
      const issue = issueWithTriggeredMonitor();
      const previousMonitor = (issue.executionState.monitor as Record<string, unknown>);

      mockIssueService.getById.mockResolvedValue(issue);
      mockIssueService.listDependencyReadiness.mockRejectedValueOnce(new Error("readiness unavailable"));
      mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
        ...issue,
        ...patch,
        updatedAt: new Date(),
      }));

      const res = await request(await createApp({
        type: "agent",
        agentId: ACTING_AGENT_ID,
        companyId: "company-1",
        runId: "run-1",
      }))
        .patch(`/api/issues/${CONVERGED_ISSUE_ID}`)
        .send({ executionPolicy: { monitor: armedMonitor("2099-12-01T12:30:00.000Z") } });

      expect(res.status).toBe(200);
      const patch = mockIssueService.update.mock.calls.at(-1)?.[1] as Record<string, unknown>;
      expect(patch.status).toBeUndefined();
      expect(patch.monitorNextCheckAt).toEqual(new Date("2099-12-01T12:30:00.000Z"));
      expect((patch.executionState as { monitor?: Record<string, unknown> }).monitor).toMatchObject({
        gateFingerprint: previousMonitor.gateFingerprint,
        gateSource: previousMonitor.gateSource,
        convergenceCount: previousMonitor.convergenceCount,
      });
      expect(
        mockLogActivity.mock.calls.some((call) => (call[1] as { action?: string })?.action === "issue.monitor_convergence_stalled"),
      ).toBe(false);
      expect(
        mockIssueService.addComment.mock.calls.some(
          (call) => call[0] === CONVERGED_ISSUE_ID && String(call[1]).includes("Monitor stopped re-arming"),
        ),
      ).toBe(false);
    });

    it("returns 422 when the stalled assignee re-arms by naming a new assignee", async () => {
      const successorAgentId = "55555555-5555-4555-8555-555555555555";
      const issue = issueWithClearedStalledMonitor();

      mockIssueService.getById.mockResolvedValue(issue);

      const res = await request(await createApp({
        type: "agent",
        agentId: ACTING_AGENT_ID,
        companyId: "company-1",
        runId: "run-1",
      }))
        .patch(`/api/issues/${CONVERGED_ISSUE_ID}`)
        .send({
          status: "in_progress",
          assigneeAgentId: successorAgentId,
          executionPolicy: { monitor: armedMonitor("2099-12-01T12:30:00.000Z") },
        });

      expect(res.status).toBe(422);
      expect(res.body.error).toBe("A monitor cleared for convergence_stalled must be re-armed by a non-assignee actor");
      expect(mockIssueService.update).not.toHaveBeenCalled();
    });

    it("does not fail the PATCH when convergence side-effect comments fail", async () => {
      const issue = issueWithTriggeredMonitor();

      mockIssueService.getById.mockResolvedValue(issue);
      mockIssueService.listDependencyReadiness.mockResolvedValue(
        new Map([[CONVERGED_ISSUE_ID, { issueId: CONVERGED_ISSUE_ID, unresolvedBlockerIssueIds: [BLOCKER_ISSUE_ID] }]]),
      );
      mockIssueService.addComment.mockRejectedValueOnce(new Error("comment write failed"));
      mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
        ...issue,
        ...patch,
        updatedAt: new Date(),
      }));

      const res = await request(await createApp({
        type: "agent",
        agentId: ACTING_AGENT_ID,
        companyId: "company-1",
        runId: "run-1",
      }))
        .patch(`/api/issues/${CONVERGED_ISSUE_ID}`)
        .send({ executionPolicy: { monitor: armedMonitor("2099-12-01T12:30:00.000Z") } });

      expect(res.status).toBe(200);
      const patch = mockIssueService.update.mock.calls.at(-1)?.[1] as Record<string, unknown>;
      expect(patch.status).toBe("blocked");
      expect(mockIssueService.addComment).toHaveBeenCalledWith(
        CONVERGED_ISSUE_ID,
        expect.stringContaining("Monitor stopped re-arming"),
        { runId: "run-1" },
        expect.objectContaining({ authorType: "system" }),
      );
    });
  });
});
