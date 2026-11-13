import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ASSIGNEE_AGENT_ID = "11111111-1111-4111-8111-111111111111";
const PREVIOUS_AGENT_ID = "22222222-2222-4222-8222-222222222222";
const MENTIONED_AGENT_ID = "33333333-3333-4333-8333-333333333333";
const MANAGER_AGENT_ID = "44444444-4444-4444-8444-444444444444";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
  addComment: vi.fn(),
  getCommentByIdempotencyKey: vi.fn(),
  markCommentIdempotencyProcessed: vi.fn(),
  findMentionedAgents: vi.fn(),
  getRelationSummaries: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
  getCurrentScheduledRetry: vi.fn(),
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
// PEN-5682: the effect path calls `logActivity(tx, payload, { deferPublish:
// true, enlistPluginOutbox: true })` and then INVOKES what it returns —
// durable delivery is enlisted in the transaction, the live fan-out happens
// after commit. A mock resolving `undefined` makes `publish()` a TypeError, so
// the whole effect chain dies before the wake effects that follow it.
const mockPublishActivity = vi.hoisted(() => vi.fn(() => undefined));
const mockLogActivity = vi.hoisted(() => vi.fn(async () => mockPublishActivity));
const mockGetActiveCompanyMembership = vi.hoisted(() => vi.fn(async () => ({ id: "membership-1" })));
// PEN-5682: an in-memory stand-in for the `issue_comment_effects` ledger, so
// the route's own `executeKeyedCommentEffect` actually RUNS in this harness.
// An eligible UNKEYED comment now commits its effect intents with the insert
// instead of running its side effects inline, so with `processCommentEffects`
// stubbed to resolve `true` the intents were enqueued and nothing ever drained
// them — and every behavioural assertion in this file (the assignee was woken,
// the mentioned agent was woken) failed with `Number of calls: 0`. The
// behaviour had not regressed; the harness stopped one layer short of it.
// Mirrors `issue-comment-reopen-routes.test.ts`, which proved the shape.
const commentEffectLedger = vi.hoisted(() => new Map<string, Array<Record<string, unknown>>>());
const ledgerRows = vi.hoisted(() => (commentId: string) => commentEffectLedger.get(commentId) ?? []);
const mockCommentEffects = vi.hoisted(() => ({
  enqueueCommentEffects: vi.fn(
    async (
      _handle: unknown,
      input: {
        companyId: string;
        issueId: string;
        commentId: string;
        effects: ReadonlyArray<{ effectKind: string; effectKey: string; payload: unknown }>;
      },
    ) => {
      const rows = commentEffectLedger.get(input.commentId) ?? [];
      for (const effect of input.effects) {
        // The real table conflicts on `(comment_id, effect_key)`; a replay must
        // not duplicate an intent.
        if (rows.some((row) => row.effectKey === effect.effectKey)) continue;
        rows.push({
          id: `effect-${input.commentId}-${effect.effectKey}`,
          companyId: input.companyId,
          issueId: input.issueId,
          commentId: input.commentId,
          effectKind: effect.effectKind,
          effectKey: effect.effectKey,
          payload: effect.payload,
          status: "queued",
        });
      }
      commentEffectLedger.set(input.commentId, rows);
    },
  ),
  getEffectResult: vi.fn(async (_db: unknown, commentId: string, effectKey: string) =>
    ledgerRows(commentId).find((row) => row.effectKey === effectKey) ?? null,
  ),
  hasCommentEffects: vi.fn(async (_db: unknown, commentId: string) => ledgerRows(commentId).length > 0),
  // Invokes the executor the ROUTE passed in, so what runs here is the real
  // `executeKeyedCommentEffect` rather than a re-implementation of it.
  processCommentEffects: vi.fn(
    async (_db: unknown, commentId: string, execute: (row: unknown) => Promise<unknown>) => {
      for (const row of ledgerRows(commentId)) {
        if (row.status === "processed") continue;
        row.result = await execute(row);
        row.status = "processed";
      }
      return true;
    },
  ),
}));
// PEN-5682: `select()` has to be TABLE-AWARE, and that is not a tidiness
// preference. `executeKeyedCommentEffect` loads the comment with
// `select().from(issueComments).where(eq(id)).limit(1)`, and
// `findWakeIdempotencyReceipt` uses the IDENTICAL `.limit(1)` shape on
// `agent_wakeup_requests`. A blanket non-empty return therefore makes every
// wake effect find a receipt and report `wakeSkipped: "already_accepted"` —
// silently deleting the very behaviour this file is about, while every status
// assertion still passes. Keyed on the table, each read answers for itself and
// an unregistered table still answers `[]`.
const drizzleTableName = vi.hoisted(() => (table: unknown): string => {
  const named = table as Record<symbol, unknown> | null | undefined;
  const name = named?.[Symbol.for("drizzle:Name")];
  return typeof name === "string" ? name : "";
});
const selectRowsByTable = vi.hoisted(() => new Map<string, () => Promise<unknown[]>>());
const lastSelectedTable = vi.hoisted(() => ({ name: "" }));
const selectedRows = vi.hoisted(() => async (): Promise<unknown[]> => {
  const source = selectRowsByTable.get(lastSelectedTable.name);
  return source ? await source() : [];
});

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
}));
const mockIssueThreadInteractionService = vi.hoisted(() => ({
  expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
  expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
}));

vi.mock("../services/index.js", () => ({
  companyService: () => ({
    getById: vi.fn(async () => ({ id: "company-1", attachmentMaxBytes: 10 * 1024 * 1024 })),
  }),
  accessService: () => ({
    canUser: vi.fn(async () => true),
    decide: vi.fn(async (input: { action?: string }) => ({
      allowed: true,
      action: input.action,
      reason: "allow_explicit_grant",
      explanation: "Allowed by test grant.",
    })),
    hasPermission: vi.fn(async () => true),
  }),
  agentService: () => ({
    getById: vi.fn(async () => null),
    resolveByReference: vi.fn(async (_companyId: string, raw: string) => ({
      ambiguous: false,
      agent: { id: raw },
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
  issueApprovalService: () => ({}),
  issueReferenceService: () => mockIssueReferenceService,
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

function registerModuleMocks() {
  vi.doMock("../services/authorization.js", async () => ({
    ...await vi.importActual<typeof import("../services/authorization.js")>("../services/authorization.js"),
    getActiveCompanyMembership: mockGetActiveCompanyMembership,
  }));
  vi.doMock("../services/source-trust.js", async () => ({
    ...await vi.importActual<typeof import("../services/source-trust.js")>("../services/source-trust.js"),
    resolveActorSourceTrustForIssue: vi.fn(async () => null),
  }));
  vi.doMock("../services/issue-comment-effects.js", () => mockCommentEffects);
  vi.doMock("../services/index.js", () => ({
    companyService: () => ({
      getById: vi.fn(async () => ({ id: "company-1", attachmentMaxBytes: 10 * 1024 * 1024 })),
    }),
    accessService: () => ({
      canUser: vi.fn(async () => true),
      decide: vi.fn(async (input: { action?: string }) => ({
        allowed: true,
        action: input.action,
        reason: "allow_explicit_grant",
        explanation: "Allowed by test grant.",
      })),
      hasPermission: vi.fn(async () => true),
    }),
    agentService: () => ({
      getById: vi.fn(async () => null),
      resolveByReference: vi.fn(async (_companyId: string, raw: string) => ({
        ambiguous: false,
        agent: { id: raw },
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
    issueApprovalService: () => ({}),
    issueReferenceService: () => mockIssueReferenceService,
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

async function createApp(actor: Record<string, unknown> = {
  type: "board",
  userId: "local-board",
  companyIds: ["company-1"],
  source: "local_implicit",
  isInstanceAdmin: false,
}) {
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
  const db = {
    transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback({})),
    // PEN-5682: see `selectRowsByTable`. Safe to stash the table on the chain
    // rather than thread it: `select().from().where().limit()` is built and
    // consumed with no await in between.
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => {
        lastSelectedTable.name = drizzleTableName(table);
        const result = {
          where: vi.fn(() => result),
          limit: vi.fn(() => ({
            then: (
              onFulfilled: (rows: unknown[]) => unknown,
              onRejected?: (reason: unknown) => unknown,
            ) => selectedRows().then(onFulfilled, onRejected),
          })),
          then: (
            onFulfilled: (rows: unknown[]) => unknown,
            onRejected?: (reason: unknown) => unknown,
          ) => selectedRows().then(onFulfilled, onRejected),
        };
        return result;
      }),
    })),
  };
  app.use("/api", issueRoutes(db as any, {} as any));
  app.use(errorHandler);
  return app;
}

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    companyId: "company-1",
    status: "todo",
    priority: "medium",
    projectId: null,
    goalId: null,
    parentId: null,
    assigneeAgentId: null,
    assigneeUserId: "local-board",
    createdByUserId: "local-board",
    identifier: "PAP-999",
    title: "Wake test",
    executionPolicy: null,
    executionState: null,
    hiddenAt: null,
    ...overrides,
  };
}

describe("issue update comment wakeups", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockIssueService.getCommentByIdempotencyKey.mockResolvedValue(null);
    mockIssueService.markCommentIdempotencyProcessed.mockResolvedValue(undefined);
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockIssueService.getCurrentScheduledRetry.mockResolvedValue(null);
    mockGetActiveCompanyMembership.mockResolvedValue({ id: "membership-1" });
    mockIssueReferenceService.diffIssueReferenceSummary.mockReturnValue({
      addedReferencedIssues: [],
      removedReferencedIssues: [],
      currentReferencedIssues: [],
    });
    mockIssueReferenceService.emptySummary.mockReturnValue({ outbound: [], inbound: [] });
    mockIssueReferenceService.listIssueReferenceSummary.mockResolvedValue({ outbound: [], inbound: [] });
    mockIssueReferenceService.syncComment.mockResolvedValue(undefined);
    mockIssueReferenceService.syncDocument.mockResolvedValue(undefined);
    mockIssueReferenceService.syncIssue.mockResolvedValue(undefined);
    // PEN-5682: `vi.clearAllMocks()` above clears calls but keeps
    // implementations, so the ledger-backed bodies declared with the mock
    // survive and must NOT be replaced here with constant resolutions — doing
    // that is what left the intents undrained in the first place. Only the
    // per-test state is reset.
    commentEffectLedger.clear();
    mockPublishActivity.mockReset();
    // Still a publish function after the reset: see `mockPublishActivity`.
    mockLogActivity.mockResolvedValue(mockPublishActivity as never);
    // The effect executor re-reads the comment from the database rather than
    // trusting the payload, so the one table that must answer is
    // `issue_comments`. Resolved from whatever `addComment` returned for this
    // test, so a test that customises the persisted row needs no extra wiring —
    // and, critically, `agent_wakeup_requests` is NOT registered, so
    // `findWakeIdempotencyReceipt` still answers `[]` and the wake really runs.
    selectRowsByTable.clear();
    lastSelectedTable.name = "";
    selectRowsByTable.set("issue_comments", async () => {
      const results = mockIssueService.addComment.mock.results;
      for (let i = results.length - 1; i >= 0; i -= 1) {
        const settled = results[i];
        if (settled.type !== "return") continue;
        const value = await settled.value;
        if (value) return [value];
      }
      return [];
    });
  });

  it("includes the new comment in assignment wakes from issue updates", async () => {
    const existing = makeIssue();
    const updated = makeIssue({
      assigneeAgentId: ASSIGNEE_AGENT_ID,
      assigneeUserId: null,
    });
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockResolvedValue(updated);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-1",
      issueId: existing.id,
      companyId: existing.companyId,
      body: "write the whole thing",
    });

    const res = await request(await createApp())
      .patch(`/api/issues/${existing.id}`)
      .send({
        assigneeAgentId: ASSIGNEE_AGENT_ID,
        assigneeUserId: null,
        comment: "write the whole thing",
      });

    expect(res.status).toBe(200);
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(1);
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      ASSIGNEE_AGENT_ID,
      expect.objectContaining({
        source: "assignment",
        reason: "issue_assigned",
        payload: expect.objectContaining({
          issueId: existing.id,
          commentId: "comment-1",
          mutation: "update",
        }),
        contextSnapshot: expect.objectContaining({
          issueId: existing.id,
          taskId: existing.id,
          commentId: "comment-1",
          wakeCommentId: "comment-1",
          source: "issue.update",
        }),
      }),
    );
  });

  it.each(["done", "cancelled"] as const)("does not wake an agent assigned to a %s issue", async (status) => {
    const existing = makeIssue({
      status,
      assigneeAgentId: PREVIOUS_AGENT_ID,
      assigneeUserId: null,
    });
    const updated = makeIssue({
      status,
      assigneeAgentId: ASSIGNEE_AGENT_ID,
      assigneeUserId: null,
    });
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockResolvedValue(updated);
    mockIssueService.addComment.mockResolvedValue({
      id: `comment-terminal-assignment-${status}`,
      issueId: existing.id,
      companyId: existing.companyId,
      body: "recording the closed-work handoff",
    });

    const res = await request(await createApp())
      .patch(`/api/issues/${existing.id}`)
      .send({
        assigneeAgentId: ASSIGNEE_AGENT_ID,
        assigneeUserId: null,
        comment: "recording the closed-work handoff",
      });

    expect(res.status).toBe(200);
    // The wakeups run in a detached task. This lookup occurs after assignment-wake
    // selection, so waiting for it makes the negative assertion non-vacuous.
    await vi.waitFor(() => expect(mockIssueService.findMentionedAgents).toHaveBeenCalled());
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalledWith(
      ASSIGNEE_AGENT_ID,
      expect.objectContaining({ reason: "issue_assigned" }),
    );
  });

  it("interrupts the active run and wakes the newly assigned agent with handoff context", async () => {
    const existing = makeIssue({
      assigneeAgentId: PREVIOUS_AGENT_ID,
      assigneeUserId: null,
      executionRunId: "run-1",
      status: "in_progress",
    });
    const updated = makeIssue({
      assigneeAgentId: ASSIGNEE_AGENT_ID,
      assigneeUserId: null,
      executionRunId: "run-1",
      status: "in_progress",
    });
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockResolvedValue(updated);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-interrupt-agent",
      issueId: existing.id,
      companyId: existing.companyId,
      body: "stop and hand this to CodexCoder",
    });
    mockHeartbeatService.getRun.mockResolvedValue({
      id: "run-1",
      companyId: existing.companyId,
      agentId: PREVIOUS_AGENT_ID,
      status: "running",
      contextSnapshot: { issueId: existing.id },
    });
    mockHeartbeatService.cancelRun.mockResolvedValue({
      id: "run-1",
      companyId: existing.companyId,
      agentId: PREVIOUS_AGENT_ID,
      status: "cancelled",
    });

    const res = await request(await createApp())
      .patch(`/api/issues/${existing.id}`)
      .send({
        assigneeAgentId: ASSIGNEE_AGENT_ID,
        assigneeUserId: null,
        comment: "stop and hand this to CodexCoder",
        interrupt: true,
      });

    expect(res.status).toBe(200);
    expect(mockHeartbeatService.cancelRun).toHaveBeenCalledWith(
      "run-1",
      "Interrupted by board comment",
      expect.objectContaining({
        errorCode: "operator_interrupted",
        resultJson: expect.objectContaining({
          operatorInterrupted: true,
          interruptionSource: "issue_comment_interrupt",
          interruptedIssueId: existing.id,
        }),
        eventMessage: "run interrupted by board comment",
        eventPayload: expect.objectContaining({
          issueId: existing.id,
          source: "issue_comment_interrupt",
        }),
      }),
    );
    await vi.waitFor(() => expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(1));
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      ASSIGNEE_AGENT_ID,
      expect.objectContaining({
        source: "assignment",
        reason: "issue_assigned",
        payload: expect.objectContaining({
          issueId: existing.id,
          commentId: "comment-interrupt-agent",
          interruptedRunId: "run-1",
          mutation: "update",
        }),
        contextSnapshot: expect.objectContaining({
          issueId: existing.id,
          taskId: existing.id,
          commentId: "comment-interrupt-agent",
          wakeCommentId: "comment-interrupt-agent",
          interruptedRunId: "run-1",
          source: "issue.update",
        }),
      }),
    );
  });

  it("interrupts the active run without waking an agent when the handoff assigns a user", async () => {
    const existing = makeIssue({
      assigneeAgentId: PREVIOUS_AGENT_ID,
      assigneeUserId: null,
      executionRunId: "run-2",
      status: "in_progress",
    });
    const updated = makeIssue({
      assigneeAgentId: null,
      assigneeUserId: "local-board",
      executionRunId: "run-2",
      status: "in_progress",
    });
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockResolvedValue(updated);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-interrupt-user",
      issueId: existing.id,
      companyId: existing.companyId,
      body: "stop here, I will take it",
    });
    mockHeartbeatService.getRun.mockResolvedValue({
      id: "run-2",
      companyId: existing.companyId,
      agentId: PREVIOUS_AGENT_ID,
      status: "running",
      contextSnapshot: { issueId: existing.id },
    });
    mockHeartbeatService.cancelRun.mockResolvedValue({
      id: "run-2",
      companyId: existing.companyId,
      agentId: PREVIOUS_AGENT_ID,
      status: "cancelled",
    });

    const res = await request(await createApp())
      .patch(`/api/issues/${existing.id}`)
      .send({
        assigneeAgentId: null,
        assigneeUserId: "local-board",
        comment: "stop here, I will take it",
        interrupt: true,
      });

    expect(res.status).toBe(200);
    expect(mockHeartbeatService.cancelRun).toHaveBeenCalledWith(
      "run-2",
      "Interrupted by board comment",
      expect.objectContaining({
        errorCode: "operator_interrupted",
        resultJson: expect.objectContaining({
          operatorInterrupted: true,
          interruptionSource: "issue_comment_interrupt",
          interruptedIssueId: existing.id,
        }),
        eventMessage: "run interrupted by board comment",
      }),
    );
    await vi.waitFor(() => expect(mockIssueService.findMentionedAgents).toHaveBeenCalledWith(
      existing.companyId,
      "stop here, I will take it",
    ));
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("wakes the assignee on comment-only issue updates", async () => {
    const existing = makeIssue({
      assigneeAgentId: ASSIGNEE_AGENT_ID,
      assigneeUserId: null,
      status: "in_progress",
    });
    const updated = { ...existing };
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockResolvedValue(updated);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-2",
      issueId: existing.id,
      companyId: existing.companyId,
      body: "please revise this",
    });

    const res = await request(await createApp())
      .patch(`/api/issues/${existing.id}`)
      .send({
        comment: "please revise this",
      });

    expect(res.status).toBe(200);
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(1);
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      ASSIGNEE_AGENT_ID,
      expect.objectContaining({
        source: "automation",
        reason: "issue_commented",
        payload: expect.objectContaining({
          issueId: existing.id,
          commentId: "comment-2",
          mutation: "comment",
        }),
        contextSnapshot: expect.objectContaining({
          issueId: existing.id,
          taskId: existing.id,
          commentId: "comment-2",
          wakeCommentId: "comment-2",
          wakeReason: "issue_commented",
          source: "issue.comment",
        }),
      }),
    );
  });

  it("does not wake the assignee when another agent closes the issue with a comment in one PATCH", async () => {
    const existing = makeIssue({
      assigneeAgentId: ASSIGNEE_AGENT_ID,
      assigneeUserId: null,
      status: "in_progress",
    });
    const updated = makeIssue({
      assigneeAgentId: ASSIGNEE_AGENT_ID,
      assigneeUserId: null,
      status: "cancelled",
    });
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockResolvedValue(updated);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-close-agent",
      issueId: existing.id,
      companyId: existing.companyId,
      body: "cancelling as a duplicate",
    });

    const res = await request(await createApp({
      type: "agent",
      agentId: MANAGER_AGENT_ID,
      companyId: existing.companyId,
      source: "agent_key",
    }))
      .patch(`/api/issues/${existing.id}`)
      .send({ status: "cancelled", comment: "cancelling as a duplicate" });

    expect(res.status).toBe(200);
    // The wakeup block is a detached `void (async () => {...})` in the route, so the
    // response resolves before it runs. Anchor on `findMentionedAgents`, which is called
    // unconditionally *after* the assignee-wake decision inside that same IIFE — without
    // it this negative assertion can pass simply by racing ahead of the code it guards.
    await vi.waitFor(() => expect(mockIssueService.findMentionedAgents).toHaveBeenCalled());
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalledWith(
      ASSIGNEE_AGENT_ID,
      expect.objectContaining({ reason: "issue_commented" }),
    );
  });

  it("does not wake the assignee when a user closes the issue with a comment in one PATCH", async () => {
    const existing = makeIssue({
      assigneeAgentId: ASSIGNEE_AGENT_ID,
      assigneeUserId: null,
      status: "in_progress",
    });
    const updated = makeIssue({
      assigneeAgentId: ASSIGNEE_AGENT_ID,
      assigneeUserId: null,
      status: "done",
    });
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockResolvedValue(updated);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-close-user",
      issueId: existing.id,
      companyId: existing.companyId,
      body: "shipped, closing this out",
    });

    const res = await request(await createApp())
      .patch(`/api/issues/${existing.id}`)
      .send({ status: "done", comment: "shipped, closing this out" });

    expect(res.status).toBe(200);
    // See the note on the agent-closer case above: the negative assertion is only
    // meaningful once the detached wakeup IIFE has passed the assignee-wake decision.
    await vi.waitFor(() => expect(mockIssueService.findMentionedAgents).toHaveBeenCalled());
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalledWith(
      ASSIGNEE_AGENT_ID,
      expect.objectContaining({ reason: "issue_commented" }),
    );
  });

  it("still wakes the assignee when a comment reopens a closed issue", async () => {
    const existing = makeIssue({
      assigneeAgentId: ASSIGNEE_AGENT_ID,
      assigneeUserId: null,
      status: "done",
    });
    const updated = makeIssue({
      assigneeAgentId: ASSIGNEE_AGENT_ID,
      assigneeUserId: null,
      status: "todo",
    });
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockResolvedValue(updated);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-reopen",
      issueId: existing.id,
      companyId: existing.companyId,
      body: "this regressed, please pick it back up",
    });

    const res = await request(await createApp())
      .patch(`/api/issues/${existing.id}`)
      .send({ comment: "this regressed, please pick it back up", reopen: true });

    expect(res.status).toBe(200);
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      ASSIGNEE_AGENT_ID,
      expect.objectContaining({ reason: "issue_reopened_via_comment" }),
    );
  });

  it("wakes the assignee when a comment moves a closed issue back to an open status", async () => {
    // BLO-29821 widening, pinned deliberately: the guard now keys on the post-update
    // status, so a PATCH that lifts an issue out of a terminal status and comments on it
    // wakes the assignee. Previously `isClosed` (pre-update) suppressed this whenever the
    // transition did not land exactly on `todo`, which left the assignee unaware that
    // reopened work was waiting on them.
    const existing = makeIssue({
      assigneeAgentId: ASSIGNEE_AGENT_ID,
      assigneeUserId: null,
      status: "done",
    });
    const updated = makeIssue({
      assigneeAgentId: ASSIGNEE_AGENT_ID,
      assigneeUserId: null,
      status: "in_progress",
    });
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockResolvedValue(updated);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-unclose",
      issueId: existing.id,
      companyId: existing.companyId,
      body: "reopening, the fix regressed",
    });

    const res = await request(await createApp())
      .patch(`/api/issues/${existing.id}`)
      .send({ status: "in_progress", comment: "reopening, the fix regressed" });

    expect(res.status).toBe(200);
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      ASSIGNEE_AGENT_ID,
      expect.objectContaining({ reason: "issue_commented" }),
    );
  });

  it("wakes the assignee on top-level board issue comments", async () => {
    const existing = makeIssue({
      assigneeAgentId: ASSIGNEE_AGENT_ID,
      assigneeUserId: null,
      status: "in_progress",
    });
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-3",
      issueId: existing.id,
      companyId: existing.companyId,
      body: "please handle this top-level thread comment",
    });

    const res = await request(await createApp())
      .post(`/api/issues/${existing.id}/comments`)
      .send({
        body: "please handle this top-level thread comment",
      });

    expect(res.status).toBe(201);
    await vi.waitFor(() => expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(1));
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      ASSIGNEE_AGENT_ID,
      expect.objectContaining({
        source: "automation",
        reason: "issue_commented",
        payload: expect.objectContaining({
          issueId: existing.id,
          commentId: "comment-3",
          mutation: "comment",
        }),
        contextSnapshot: expect.objectContaining({
          issueId: existing.id,
          taskId: existing.id,
          commentId: "comment-3",
          wakeCommentId: "comment-3",
          wakeReason: "issue_commented",
          source: "issue.comment",
        }),
      }),
    );
  });

  it.each(["done", "cancelled"] as const)(
    "does not wake a mentioned agent from a terminal %s issue",
    async (status) => {
      const existing = makeIssue({
        status,
        assigneeAgentId: null,
        assigneeUserId: "local-board",
      });
      mockIssueService.getById.mockResolvedValue(existing);
      mockIssueService.addComment.mockResolvedValue({
        id: `comment-terminal-mention-${status}`,
        issueId: existing.id,
        companyId: existing.companyId,
        body: "@mentioned please take another look",
      });
      mockIssueService.findMentionedAgents.mockResolvedValue([MENTIONED_AGENT_ID]);

      const res = await request(await createApp())
        .post(`/api/issues/${existing.id}/comments`)
        .send({ body: "@mentioned please take another look" });

      expect(res.status).toBe(201);
      await vi.waitFor(() => expect(mockIssueService.findMentionedAgents).toHaveBeenCalled());
      expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
    },
  );

  it.each(["done", "cancelled"] as const)(
    "does not emit an execution-stage approver wake for terminal %s issues",
    async (status) => {
      const existing = makeIssue({
        status: "in_review",
        assigneeAgentId: ASSIGNEE_AGENT_ID,
        assigneeUserId: null,
        executionState: {
          status: "pending",
          currentStageId: "stage-1",
          currentStageIndex: 0,
          currentStageType: "approval",
          currentParticipant: { type: "agent", agentId: MENTIONED_AGENT_ID },
          returnAssignee: { type: "agent", agentId: ASSIGNEE_AGENT_ID },
          completedStageIds: [],
          lastDecisionId: null,
          lastDecisionOutcome: "changes_requested",
        },
      });
      const updated = makeIssue({
        ...existing,
        status,
        executionState: existing.executionState,
      });
      mockIssueService.getById.mockResolvedValue(existing);
      mockIssueService.update.mockResolvedValue(updated);

      const res = await request(await createApp())
        .patch(`/api/issues/${existing.id}`)
        .send({ status });

      expect(res.status).toBe(200);
      expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
    },
  );

  it("replays an unprocessed idempotent top-level comment through post-insert side effects", async () => {
    const existing = makeIssue({
      assigneeAgentId: ASSIGNEE_AGENT_ID,
      assigneeUserId: null,
      status: "in_progress",
    });
    const comment = {
      id: "comment-idempotent",
      issueId: existing.id,
      companyId: existing.companyId,
      authorType: "user",
      authorAgentId: null,
      authorUserId: "local-board",
      body: "please handle this idempotently",
      presentation: null,
      metadata: null,
      idempotencyKey: "health:window:fingerprint",
      idempotencyProcessedAt: null,
      createdAt: new Date("2026-07-30T12:00:00.000Z"),
      updatedAt: new Date("2026-07-30T12:00:00.000Z"),
    };
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.getCommentByIdempotencyKey
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(comment);
    mockIssueService.addComment.mockResolvedValue(comment);
    mockCommentEffects.processCommentEffects
      .mockRejectedValueOnce(new Error("sync failed after insert"))
      .mockResolvedValueOnce(true);

    const app = await createApp();
    const first = await request(app)
      .post(`/api/issues/${existing.id}/comments`)
      .send({
        body: "please handle this idempotently",
        idempotencyKey: "health:window:fingerprint",
      });
    const second = await request(app)
      .post(`/api/issues/${existing.id}/comments`)
      .send({
        body: "please handle this idempotently",
        idempotencyKey: "health:window:fingerprint",
      });

    // PEN-5669: the inline drain threw, but the comment and the full set of
    // effect intents it owes had already committed together, so the response
    // reports the create. `releaseEffect` writes the unfinished effect back as
    // `queued`/`failed` with a backoff BEFORE `processCommentEffects` rethrows,
    // and the reconciler owns it from there. This asserted 500 until PEN-5669:
    // a failed-write verdict on a write that had landed and was visible to
    // everyone else.
    expect(first.status).toBe(201);
    // The replay runs while those effects are still unsettled, which is the
    // case most likely to break: `idempotencyProcessedAt` is still null, so the
    // early 200-and-return does NOT fire. The request falls through, finds the
    // intents already enqueued, re-drains, and answers 200 `deduplicated: true`
    // without inserting a second comment or a second intent.
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ id: "comment-idempotent", deduplicated: true });
    expect(mockIssueService.addComment).toHaveBeenCalledTimes(1);
    expect(mockCommentEffects.enqueueCommentEffects).toHaveBeenCalledTimes(1);
    expect(mockCommentEffects.processCommentEffects).toHaveBeenCalledTimes(2);
    expect(mockIssueService.markCommentIdempotencyProcessed).not.toHaveBeenCalled();
  });

  it("does not enqueue a keyed mention wake when an agent cannot grant reply access", async () => {
    const existing = makeIssue({
      assigneeAgentId: ASSIGNEE_AGENT_ID,
      assigneeUserId: null,
      status: "in_progress",
    });
    const comment = {
      id: "comment-keyed-non-assignee-mention",
      issueId: existing.id,
      companyId: existing.companyId,
      authorType: "agent",
      authorAgentId: PREVIOUS_AGENT_ID,
      authorUserId: null,
      body: `[@QA](agent://${MENTIONED_AGENT_ID}) please inspect this`,
      presentation: null,
      metadata: null,
      idempotencyKey: "mention:unauthorized",
      idempotencyProcessedAt: null,
      createdAt: new Date("2026-08-11T00:00:00.000Z"),
      updatedAt: new Date("2026-08-11T00:00:00.000Z"),
    };
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.addComment.mockResolvedValue(comment);
    mockIssueService.findMentionedAgents.mockResolvedValue([MENTIONED_AGENT_ID]);

    const res = await request(await createApp({
      type: "agent",
      agentId: PREVIOUS_AGENT_ID,
      companyId: existing.companyId,
      source: "agent_key",
    }))
      .post(`/api/issues/${existing.id}/comments`)
      .send({ body: comment.body, idempotencyKey: comment.idempotencyKey });

    expect(res.status).toBe(201);
    expect(mockCommentEffects.enqueueCommentEffects).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        effects: expect.not.arrayContaining([
          expect.objectContaining({
            effectKind: "wake",
            payload: expect.objectContaining({ agentId: MENTIONED_AGENT_ID }),
          }),
        ]),
      }),
    );
  });

  it("enqueues a keyed mention wake when an active member grants reply access", async () => {
    const existing = makeIssue({
      assigneeAgentId: null,
      assigneeUserId: "active-user",
      status: "in_progress",
    });
    const comment = {
      id: "comment-keyed-member-mention",
      issueId: existing.id,
      companyId: existing.companyId,
      authorType: "user",
      authorAgentId: null,
      authorUserId: "active-user",
      body: `[@QA](agent://${MENTIONED_AGENT_ID}) please inspect this`,
      presentation: null,
      metadata: null,
      idempotencyKey: "mention:authorized",
      idempotencyProcessedAt: null,
      createdAt: new Date("2026-08-11T00:00:00.000Z"),
      updatedAt: new Date("2026-08-11T00:00:00.000Z"),
    };
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.addComment.mockResolvedValue(comment);
    mockIssueService.findMentionedAgents.mockResolvedValue([MENTIONED_AGENT_ID]);

    const res = await request(await createApp({
      type: "board",
      userId: "active-user",
      companyIds: [existing.companyId],
      source: "session",
      isInstanceAdmin: false,
    }))
      .post(`/api/issues/${existing.id}/comments`)
      .send({ body: comment.body, idempotencyKey: comment.idempotencyKey });

    expect(res.status).toBe(201);
    expect(mockCommentEffects.enqueueCommentEffects).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        effects: expect.arrayContaining([
          expect.objectContaining({
            effectKind: "wake",
            payload: expect.objectContaining({ agentId: MENTIONED_AGENT_ID }),
          }),
        ]),
      }),
    );
  });

  it("does not route a plain-text agent name on a human-owned issue comment", async () => {
    const existing = makeIssue({
      assigneeAgentId: null,
      assigneeUserId: "local-board",
      status: "in_progress",
    });
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-plain-agent-name",
      issueId: existing.id,
      companyId: existing.companyId,
      body: "QA please take the screenshot",
    });
    mockIssueService.findMentionedAgents.mockResolvedValue([]);

    const res = await request(await createApp())
      .post(`/api/issues/${existing.id}/comments`)
      .send({
        body: "QA please take the screenshot",
      });

    expect(res.status).toBe(201);
    await vi.waitFor(() => expect(mockIssueService.findMentionedAgents).toHaveBeenCalledWith(
      existing.companyId,
      "QA please take the screenshot",
    ));
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("does not wake a structured mentioned agent for a local implicit actor without membership", async () => {
    const existing = makeIssue({
      assigneeAgentId: null,
      assigneeUserId: "local-board",
      status: "in_progress",
    });
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-structured-mention",
      issueId: existing.id,
      companyId: existing.companyId,
      body: "[@QA](/agents/33333333-3333-4333-8333-333333333333) please inspect this",
    });
    mockIssueService.findMentionedAgents.mockResolvedValue([MENTIONED_AGENT_ID]);
    mockGetActiveCompanyMembership.mockResolvedValue(null);

    const res = await request(await createApp())
      .post(`/api/issues/${existing.id}/comments`)
      .send({
        body: "[@QA](/agents/33333333-3333-4333-8333-333333333333) please inspect this",
      });

    expect(res.status).toBe(201);
    await vi.waitFor(() => expect(mockIssueService.findMentionedAgents).toHaveBeenCalled());
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalledWith(
      MENTIONED_AGENT_ID,
      expect.objectContaining({ reason: "issue_comment_mentioned" }),
    );
  });

  it("routes a structured mentioned agent when the author has an active membership", async () => {
    const existing = makeIssue({
      assigneeAgentId: null,
      assigneeUserId: "active-user",
      status: "in_progress",
    });
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-structured-mention",
      issueId: existing.id,
      companyId: existing.companyId,
      body: `[@QA](agent://${MENTIONED_AGENT_ID}) please inspect this`,
    });
    mockIssueService.findMentionedAgents.mockResolvedValue([MENTIONED_AGENT_ID]);

    const res = await request(await createApp({
      type: "board",
      userId: "active-user",
      companyIds: [existing.companyId],
      source: "session",
      isInstanceAdmin: false,
    }))
      .post(`/api/issues/${existing.id}/comments`)
      .send({ body: `[@QA](agent://${MENTIONED_AGENT_ID}) please inspect this` });

    expect(res.status).toBe(201);
    await vi.waitFor(() => expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(1));
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      MENTIONED_AGENT_ID,
      expect.objectContaining({
        source: "automation",
        reason: "issue_comment_mentioned",
        payload: {
          issueId: existing.id,
          commentId: "comment-structured-mention",
        },
        contextSnapshot: expect.objectContaining({
          issueId: existing.id,
          taskId: existing.id,
          commentId: "comment-structured-mention",
          wakeCommentId: "comment-structured-mention",
          wakeReason: "issue_comment_mentioned",
          source: "comment.mention",
        }),
      }),
    );
  });

  it("applies mention grant wake eligibility to PATCH comments", async () => {
    const existing = makeIssue({
      assigneeAgentId: null,
      assigneeUserId: "active-user",
      status: "in_progress",
    });
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockResolvedValue(existing);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-patch-assignee-mention",
      issueId: existing.id,
      companyId: existing.companyId,
      body: `[@QA](agent://${MENTIONED_AGENT_ID}) please inspect this`,
    });
    mockIssueService.findMentionedAgents.mockResolvedValue([MENTIONED_AGENT_ID]);

    const res = await request(await createApp({
      type: "board",
      userId: "active-user",
      companyIds: [existing.companyId],
      source: "session",
      isInstanceAdmin: false,
    }))
      .patch(`/api/issues/${existing.id}`)
      .send({ comment: `[@QA](agent://${MENTIONED_AGENT_ID}) please inspect this` });

    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      MENTIONED_AGENT_ID,
      expect.objectContaining({ reason: "issue_comment_mentioned" }),
    ));
  });

  it("preserves the POST assignee wake when mention membership lookup fails", async () => {
    const existing = makeIssue({
      assigneeAgentId: ASSIGNEE_AGENT_ID,
      assigneeUserId: null,
      status: "in_progress",
    });
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-post-membership-failure",
      issueId: existing.id,
      companyId: existing.companyId,
      body: `[@QA](agent://${MENTIONED_AGENT_ID}) please inspect this`,
    });
    mockIssueService.findMentionedAgents.mockResolvedValue([MENTIONED_AGENT_ID]);
    mockGetActiveCompanyMembership.mockRejectedValue(new Error("membership unavailable"));

    const res = await request(await createApp({
      type: "board",
      userId: "active-user",
      companyIds: [existing.companyId],
      source: "session",
      isInstanceAdmin: false,
    }))
      .post(`/api/issues/${existing.id}/comments`)
      .send({ body: `[@QA](agent://${MENTIONED_AGENT_ID}) please inspect this` });

    expect(res.status).toBe(201);
    await vi.waitFor(() => expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      ASSIGNEE_AGENT_ID,
      expect.objectContaining({ reason: "issue_commented" }),
    ));
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalledWith(
      MENTIONED_AGENT_ID,
      expect.objectContaining({ reason: "issue_comment_mentioned" }),
    );
  });

  it("preserves the PATCH assignee wake when mention membership lookup fails", async () => {
    const existing = makeIssue({
      assigneeAgentId: ASSIGNEE_AGENT_ID,
      assigneeUserId: null,
      status: "in_progress",
    });
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockResolvedValue(existing);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-patch-membership-failure",
      issueId: existing.id,
      companyId: existing.companyId,
      body: `[@QA](agent://${MENTIONED_AGENT_ID}) please inspect this`,
    });
    mockIssueService.findMentionedAgents.mockResolvedValue([MENTIONED_AGENT_ID]);
    mockGetActiveCompanyMembership.mockRejectedValue(new Error("membership unavailable"));

    const res = await request(await createApp({
      type: "board",
      userId: "active-user",
      companyIds: [existing.companyId],
      source: "session",
      isInstanceAdmin: false,
    }))
      .patch(`/api/issues/${existing.id}`)
      .send({ comment: `[@QA](agent://${MENTIONED_AGENT_ID}) please inspect this` });

    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      ASSIGNEE_AGENT_ID,
      expect.objectContaining({ reason: "issue_commented" }),
    ));
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalledWith(
      MENTIONED_AGENT_ID,
      expect.objectContaining({ reason: "issue_comment_mentioned" }),
    );
  });

  it("does not wake a mentioned agent when an agent comment cannot grant reply access", async () => {
    const existing = makeIssue({
      assigneeAgentId: ASSIGNEE_AGENT_ID,
      assigneeUserId: null,
      status: "in_progress",
    });
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-non-assignee-mention",
      issueId: existing.id,
      companyId: existing.companyId,
      body: `[@QA](agent://${MENTIONED_AGENT_ID}) please inspect this`,
    });
    mockIssueService.findMentionedAgents.mockResolvedValue([MENTIONED_AGENT_ID]);

    const res = await request(await createApp({
      type: "agent",
      agentId: PREVIOUS_AGENT_ID,
      companyId: existing.companyId,
      source: "agent_key",
    }))
      .post(`/api/issues/${existing.id}/comments`)
      .send({ body: `[@QA](agent://${MENTIONED_AGENT_ID}) please inspect this` });

    expect(res.status).toBe(201);
    await vi.waitFor(() => expect(mockIssueService.findMentionedAgents).toHaveBeenCalled());
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalledWith(
      MENTIONED_AGENT_ID,
      expect.objectContaining({ reason: "issue_comment_mentioned" }),
    );
  });

  it("wakes a mentioned agent when the issue assignee grants reply access", async () => {
    const existing = makeIssue({
      assigneeAgentId: ASSIGNEE_AGENT_ID,
      assigneeUserId: null,
      status: "todo",
    });
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-assignee-mention",
      issueId: existing.id,
      companyId: existing.companyId,
      body: `[@QA](agent://${MENTIONED_AGENT_ID}) please inspect this`,
    });
    mockIssueService.findMentionedAgents.mockResolvedValue([MENTIONED_AGENT_ID]);

    const res = await request(await createApp({
      type: "agent",
      agentId: ASSIGNEE_AGENT_ID,
      companyId: existing.companyId,
      source: "agent_key",
    }))
      .post(`/api/issues/${existing.id}/comments`)
      .send({ body: `[@QA](agent://${MENTIONED_AGENT_ID}) please inspect this` });

    expect(res.status).toBe(201);
    await vi.waitFor(() => expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      MENTIONED_AGENT_ID,
      expect.objectContaining({ reason: "issue_comment_mentioned" }),
    ));
  });

  // PEN-5846. Three sites in `routes/issues.ts` raise an
  // `issue_comment_mentioned` wake. Two suppressed on closed status and the
  // `idempotencyKey` path did not, so passing a DEDUPE key was what decided
  // whether a mention on a `done` row reached anybody — same row, same body,
  // same author, same mentioned agent, opposite outcomes, and a create response
  // that looked identical either way.
  //
  // These cases are DIFFERENTIAL on purpose, and that is the whole reason they
  // exist. The entitlement cases above are a careful per-path pair, one for the
  // inline path and one for the keyed path, each asserting against a constant.
  // A per-path pair is structurally blind to a divergence BETWEEN the paths:
  // both passed throughout, on every day this defect was live. So the assertion
  // below is that the two wake sets equal EACH OTHER. Adding a third per-path
  // pair here would reproduce the blind spot rather than close it.
  describe("closed-row mention wakes do not depend on `idempotencyKey` (PEN-5846)", () => {
    const MENTION_BODY = `[@QA](agent://${MENTIONED_AGENT_ID}) over to you`;

    // Every agent this request would wake with `issue_comment_mentioned`,
    // whichever transport the path chose: the inline paths dispatch straight
    // through `heartbeatService.wakeup`, the keyed path enqueues `wake` effect
    // intents for the outbox to drain. Unioning the two is what makes the
    // comparison cross-path — read off one transport only and the keyed path is
    // invisible, which is the shape of the original miss.
    function wokenMentionTargets(): string[] {
      const dispatched = mockHeartbeatService.wakeup.mock.calls
        .filter(([, wakeup]: any[]) => wakeup?.reason === "issue_comment_mentioned")
        .map(([agentId]: any[]) => String(agentId));
      const enqueued = mockCommentEffects.enqueueCommentEffects.mock.calls
        .flatMap(([, args]: any[]) => (args?.effects ?? []) as any[])
        .filter((effect: any) =>
          effect?.effectKind === "wake" &&
          effect?.payload?.wakeup?.reason === "issue_comment_mentioned")
        .map((effect: any) => String(effect.payload.agentId));
      return [...new Set([...dispatched, ...enqueued])].sort();
    }

    // The author is a board user with an active membership and the row has no
    // agent assignee, so `commentAuthorCanGrantIssueMention` passes on both
    // paths. The status term is then the only thing left that can differ, which
    // is what isolates the axis under test from the entitlement axis.
    async function postMention(status: string, idempotencyKey?: string) {
      const existing = makeIssue({
        status,
        assigneeAgentId: null,
        assigneeUserId: "active-user",
      });
      mockIssueService.getById.mockResolvedValue(existing);
      // Returned, not left undefined, so an unexpected implicit move-to-todo
      // shows up as the explicit `update` assertion below failing rather than as
      // a 404 nobody reads back to this cause.
      mockIssueService.update.mockResolvedValue(existing);
      mockIssueService.addComment.mockResolvedValue({
        id: `comment-${status}-${idempotencyKey ? "keyed" : "unkeyed"}`,
        issueId: existing.id,
        companyId: existing.companyId,
        body: MENTION_BODY,
        ...(idempotencyKey ? { idempotencyKey, idempotencyProcessedAt: null } : {}),
      });
      mockIssueService.findMentionedAgents.mockResolvedValue([MENTIONED_AGENT_ID]);

      const res = await request(await createApp({
        type: "board",
        userId: "active-user",
        companyIds: [existing.companyId],
        source: "session",
        isInstanceAdmin: false,
      }))
        .post(`/api/issues/${existing.id}/comments`)
        .send({ body: MENTION_BODY, ...(idempotencyKey ? { idempotencyKey } : {}) });

      expect(res.status).toBe(201);
      // Precondition, not decoration: "suppressed on a closed row" says nothing
      // if the request quietly reopened the row first.
      expect(mockIssueService.update).not.toHaveBeenCalled();
      // The inline wake block is a detached async IIFE, so the response resolves
      // before it runs. `findMentionedAgents` is awaited inside it, after the
      // assignee-wake decision — without this anchor a negative assertion can
      // pass by racing ahead of the code it is guarding.
      await vi.waitFor(() => expect(mockIssueService.findMentionedAgents).toHaveBeenCalled());
      return wokenMentionTargets();
    }

    function clearWakeObservations() {
      mockHeartbeatService.wakeup.mockClear();
      mockCommentEffects.enqueueCommentEffects.mockClear();
      mockIssueService.update.mockClear();
      mockIssueService.findMentionedAgents.mockClear();
    }

    it.each(["done", "cancelled"] as const)(
      "suppresses the mention wake on a terminal %s row on both paths",
      async (status) => {
        const unkeyed = await postMention(status);
        clearWakeObservations();
        const keyed = await postMention(status, `pen-5846:${status}`);

        expect(keyed).toEqual(unkeyed);
        expect(unkeyed).toEqual([]);
      },
    );

    // POSITIVE CONTROL, and it is load-bearing twice over. Without it, two paths
    // that both stopped waking anyone would satisfy the equality above: the
    // instrument has to be shown capable of reporting a wake before its silence
    // means anything. It also pins that the suppression is the STATUS term and
    // not the author predicate, since only `status` differs from the cases above.
    it("POSITIVE CONTROL: wakes the mentioned agent on an open row on both paths", async () => {
      const unkeyed = await postMention("in_progress");
      clearWakeObservations();
      const keyed = await postMention("in_progress", "pen-5846:open");

      expect(keyed).toEqual(unkeyed);
      expect(unkeyed).toEqual([MENTIONED_AGENT_ID]);
    });
  });

  // PEN-5846: the third site. The two POST paths are covered by the differential
  // cases above; this pins the `router.patch("/issues/:id", ...)` comment arm, in
  // the shape that arm actually meets a closed row — one PATCH that both closes
  // the issue and posts the closing mention, so the guard has to read the
  // POST-update status (BLO-29821) to see it. Its positive control is "applies
  // mention grant wake eligibility to PATCH comments" above, which is the same
  // request on an open row.
  it.each(["done", "cancelled"] as const)(
    "does not wake a mentioned agent when one PATCH both %s the issue and posts the mention",
    async (status) => {
      const existing = makeIssue({
        assigneeAgentId: null,
        assigneeUserId: "active-user",
        status: "in_progress",
      });
      const updated = makeIssue({
        assigneeAgentId: null,
        assigneeUserId: "active-user",
        status,
      });
      const body = `[@QA](agent://${MENTIONED_AGENT_ID}) over to you`;
      mockIssueService.getById.mockResolvedValue(existing);
      mockIssueService.update.mockResolvedValue(updated);
      mockIssueService.addComment.mockResolvedValue({
        id: `comment-patch-close-mention-${status}`,
        issueId: existing.id,
        companyId: existing.companyId,
        body,
      });
      mockIssueService.findMentionedAgents.mockResolvedValue([MENTIONED_AGENT_ID]);

      const res = await request(await createApp({
        type: "board",
        userId: "active-user",
        companyIds: [existing.companyId],
        source: "session",
        isInstanceAdmin: false,
      }))
        .patch(`/api/issues/${existing.id}`)
        .send({ status, comment: body });

      expect(res.status).toBe(200);
      // See the note on the agent-closer case above: the negative assertion is
      // only meaningful once the detached wakeup IIFE has reached the mention loop.
      await vi.waitFor(() => expect(mockIssueService.findMentionedAgents).toHaveBeenCalled());
      expect(mockHeartbeatService.wakeup).not.toHaveBeenCalledWith(
        MENTIONED_AGENT_ID,
        expect.objectContaining({ reason: "issue_comment_mentioned" }),
      );
    },
  );

  // PEN-5180. The defect of record: a body containing a plain `@Ceo` matches no
  // mention extractor, binds to nobody and raises no wake, yet the write
  // returned a bare 200 with nothing the author could read saying so. The
  // author's only evidence of failure was the absence of a reply, which is
  // indistinguishable from a busy recipient. These assert the create response
  // now carries that signal — and the POSITIVE CONTROL asserts a correctly
  // formed `agent://` mention does NOT, which is what keeps the field a signal
  // rather than constant noise an author learns to skip.
  describe("unbound @-mention reporting on the create response (PEN-5180)", () => {
    it("reports a plain @Name that bound to nobody", async () => {
      const existing = makeIssue({ status: "in_progress" });
      const body = "@Ceo please rule on the scope question above";
      mockIssueService.getById.mockResolvedValue(existing);
      mockIssueService.addComment.mockResolvedValue({
        id: "comment-unbound-plain-name",
        issueId: existing.id,
        companyId: existing.companyId,
        body,
      });
      mockIssueService.findMentionedAgents.mockResolvedValue([]);

      const res = await request(await createApp())
        .post(`/api/issues/${existing.id}/comments`)
        .send({ body });

      expect(res.status).toBe(201);
      expect(res.body.unboundMentions).toEqual(["Ceo"]);
      // The drop itself is unchanged and intentional: the remedy is the signal,
      // not name matching in the extractor.
      expect(mockHeartbeatService.wakeup).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ reason: "issue_comment_mentioned" }),
      );
    });

    it("POSITIVE CONTROL: a correctly-formed agent:// mention reports nothing", async () => {
      const existing = makeIssue({ assigneeUserId: "active-user", status: "in_progress" });
      const body = `[@QA](agent://${MENTIONED_AGENT_ID}) please inspect this`;
      mockIssueService.getById.mockResolvedValue(existing);
      mockIssueService.addComment.mockResolvedValue({
        id: "comment-bound-mention",
        issueId: existing.id,
        companyId: existing.companyId,
        body,
      });
      mockIssueService.findMentionedAgents.mockResolvedValue([MENTIONED_AGENT_ID]);

      const res = await request(await createApp({
        type: "board",
        userId: "active-user",
        companyIds: [existing.companyId],
        source: "session",
        isInstanceAdmin: false,
      }))
        .post(`/api/issues/${existing.id}/comments`)
        .send({ body });

      expect(res.status).toBe(201);
      // Present and empty, never absent: an absent key cannot be told apart
      // from a server that predates this report.
      expect(res.body).toHaveProperty("unboundMentions");
      expect(res.body.unboundMentions).toEqual([]);
      await vi.waitFor(() => expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
        MENTIONED_AGENT_ID,
        expect.objectContaining({ reason: "issue_comment_mentioned" }),
      ));
    });

    it("reports only the unbound token when a body carries both forms", async () => {
      const existing = makeIssue({ assigneeUserId: "active-user", status: "in_progress" });
      const body = `[@QA](agent://${MENTIONED_AGENT_ID}) please inspect, and @Ceo should rule`;
      mockIssueService.getById.mockResolvedValue(existing);
      mockIssueService.addComment.mockResolvedValue({
        id: "comment-mixed-mentions",
        issueId: existing.id,
        companyId: existing.companyId,
        body,
      });
      mockIssueService.findMentionedAgents.mockResolvedValue([MENTIONED_AGENT_ID]);

      const res = await request(await createApp({
        type: "board",
        userId: "active-user",
        companyIds: [existing.companyId],
        source: "session",
        isInstanceAdmin: false,
      }))
        .post(`/api/issues/${existing.id}/comments`)
        .send({ body });

      expect(res.status).toBe(201);
      expect(res.body.unboundMentions).toEqual(["Ceo"]);
    });

    it("reports a well-formed agent link whose target resolved to nobody", async () => {
      // Same silent drop as a plain name: the href parses, the wake still
      // reaches no one, so the author needs the same signal.
      const existing = makeIssue({ status: "in_progress" });
      const body = "[@Ghost](agent://99999999-9999-4999-8999-999999999999) are you there";
      mockIssueService.getById.mockResolvedValue(existing);
      mockIssueService.addComment.mockResolvedValue({
        id: "comment-unresolved-href",
        issueId: existing.id,
        companyId: existing.companyId,
        body,
      });
      mockIssueService.findMentionedAgents.mockResolvedValue([]);

      const res = await request(await createApp())
        .post(`/api/issues/${existing.id}/comments`)
        .send({ body });

      expect(res.status).toBe(201);
      expect(res.body.unboundMentions).toEqual(["Ghost"]);
    });

    it("reports nothing for a body with no @ tokens at all", async () => {
      const existing = makeIssue({ status: "in_progress" });
      const body = "Recording the measurement here for the next reader.";
      mockIssueService.getById.mockResolvedValue(existing);
      mockIssueService.addComment.mockResolvedValue({
        id: "comment-no-mentions",
        issueId: existing.id,
        companyId: existing.companyId,
        body,
      });
      mockIssueService.findMentionedAgents.mockResolvedValue([]);

      const res = await request(await createApp())
        .post(`/api/issues/${existing.id}/comments`)
        .send({ body });

      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty("unboundMentions");
      expect(res.body.unboundMentions).toEqual([]);
    });

    // PEN-5364. `unboundMentions` dedupes on the token text, not the
    // occurrence, so the mixed-form body — one `agent://` link plus loose prose
    // for the same name — produced a receipt byte-identical to a body that only
    // ever wrote the bare form. One raised the wake, the other dropped it, and
    // the author could not tell which. Reading the first as the second costs a
    // redundant re-send; reading the second as the first costs the whole wake,
    // which is the 24h loss PEN-5180 was filed to end. `boundMentions` is the
    // half that separates them.
    describe("boundMentions disambiguates a mixed-form body (PEN-5364)", () => {
      const MIXED_FORM_NAME = "QA";

      it("mixed form: the same name in BOTH lists means the link bound", async () => {
        const existing = makeIssue({ assigneeUserId: "active-user", status: "in_progress" });
        const body = `[@${MIXED_FORM_NAME}](agent://${MENTIONED_AGENT_ID}) please inspect — `
          + `@${MIXED_FORM_NAME} also owns the fixture question`;
        mockIssueService.getById.mockResolvedValue(existing);
        mockIssueService.addComment.mockResolvedValue({
          id: "comment-mixed-form-same-name",
          issueId: existing.id,
          companyId: existing.companyId,
          body,
        });
        mockIssueService.findMentionedAgents.mockResolvedValue([MENTIONED_AGENT_ID]);

        const res = await request(await createApp({
          type: "board",
          userId: "active-user",
          companyIds: [existing.companyId],
          source: "session",
          isInstanceAdmin: false,
        }))
          .post(`/api/issues/${existing.id}/comments`)
          .send({ body });

        expect(res.status).toBe(201);
        expect(res.body.unboundMentions).toEqual([MIXED_FORM_NAME]);
        expect(res.body.boundMentions).toEqual([MIXED_FORM_NAME]);
        // The wake really was raised, which is what makes the bare token noise.
        await vi.waitFor(() => expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
          MENTIONED_AGENT_ID,
          expect.objectContaining({ reason: "issue_comment_mentioned" }),
        ));
      });

      it("bare only: the SAME unboundMentions, but boundMentions is empty", async () => {
        // Byte-identical `unboundMentions` to the case above. Only
        // `boundMentions` says the wake was dropped.
        const existing = makeIssue({ status: "in_progress" });
        const body = `@${MIXED_FORM_NAME} please inspect — @${MIXED_FORM_NAME} owns this`;
        mockIssueService.getById.mockResolvedValue(existing);
        mockIssueService.addComment.mockResolvedValue({
          id: "comment-bare-only-same-name",
          issueId: existing.id,
          companyId: existing.companyId,
          body,
        });
        mockIssueService.findMentionedAgents.mockResolvedValue([]);

        const res = await request(await createApp())
          .post(`/api/issues/${existing.id}/comments`)
          .send({ body });

        expect(res.status).toBe(201);
        expect(res.body.unboundMentions).toEqual([MIXED_FORM_NAME]);
        expect(res.body.boundMentions).toEqual([]);
        expect(mockHeartbeatService.wakeup).not.toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({ reason: "issue_comment_mentioned" }),
        );
      });

      it("link only: boundMentions carries the name, unboundMentions is empty", async () => {
        const existing = makeIssue({ assigneeUserId: "active-user", status: "in_progress" });
        const body = `[@${MIXED_FORM_NAME}](agent://${MENTIONED_AGENT_ID}) please inspect this`;
        mockIssueService.getById.mockResolvedValue(existing);
        mockIssueService.addComment.mockResolvedValue({
          id: "comment-link-only",
          issueId: existing.id,
          companyId: existing.companyId,
          body,
        });
        mockIssueService.findMentionedAgents.mockResolvedValue([MENTIONED_AGENT_ID]);

        const res = await request(await createApp({
          type: "board",
          userId: "active-user",
          companyIds: [existing.companyId],
          source: "session",
          isInstanceAdmin: false,
        }))
          .post(`/api/issues/${existing.id}/comments`)
          .send({ body });

        expect(res.status).toBe(201);
        expect(res.body.unboundMentions).toEqual([]);
        expect(res.body.boundMentions).toEqual([MIXED_FORM_NAME]);
      });

      it("is unconditional, so an absent key cannot mean an older server", async () => {
        const existing = makeIssue({ status: "in_progress" });
        const body = "Recording the measurement here for the next reader.";
        mockIssueService.getById.mockResolvedValue(existing);
        mockIssueService.addComment.mockResolvedValue({
          id: "comment-no-mentions-bound-half",
          issueId: existing.id,
          companyId: existing.companyId,
          body,
        });
        mockIssueService.findMentionedAgents.mockResolvedValue([]);

        const res = await request(await createApp())
          .post(`/api/issues/${existing.id}/comments`)
          .send({ body });

        expect(res.status).toBe(201);
        expect(res.body).toHaveProperty("boundMentions");
        expect(res.body.boundMentions).toEqual([]);
      });

      it("fails toward 'nothing bound' when mention resolution throws", async () => {
        // A false re-send costs one round trip; a false all-clear costs the
        // wake. The resolver failing must never produce the latter.
        const existing = makeIssue({ status: "in_progress" });
        const body = `[@${MIXED_FORM_NAME}](agent://${MENTIONED_AGENT_ID}) and @${MIXED_FORM_NAME}`;
        mockIssueService.getById.mockResolvedValue(existing);
        mockIssueService.addComment.mockResolvedValue({
          id: "comment-bound-half-resolution-failure",
          issueId: existing.id,
          companyId: existing.companyId,
          body,
        });
        mockIssueService.findMentionedAgents.mockRejectedValue(new Error("resolution exploded"));

        const res = await request(await createApp())
          .post(`/api/issues/${existing.id}/comments`)
          .send({ body });

        expect(res.status).toBe(201);
        expect(res.body.boundMentions).toEqual([]);
        expect(res.body.unboundMentions).toEqual([MIXED_FORM_NAME]);
      });
    });

    // PEN-5812. Mention BINDING and mention ENTITLEMENT are different
    // mechanisms, evaluated in different places, and until this field only
    // binding was reported. `boundMentions` is derived from
    // `findMentionedAgents` alone and never consults
    // `commentAuthorCanGrantIssueMention`, so there is NO pair of inputs — one
    // grantable mention, one not — that makes it differ. That is why the proof
    // is the predicate and not a measurement, and why the control arm below has
    // to assert on the THIRD list: it is the only output that can vary.
    //
    // The 14:22Z PEN-5793 experiment that prompted this row was NOT a control
    // arm. Both of its mentions were on the same side of the predicate (the
    // author was not the assignee, so neither could grant), and its identical
    // output demonstrated nothing about entitlement. It is evidence that an
    // author MISREAD an affirmative `boundMentions` as delivery — real, and a
    // different claim. These tests are the control arm that experiment was not.
    describe("mentionsWithoutGrant separates an inert mention from a live one (PEN-5812)", () => {
      const GRANTED_NAME = "QA";
      const SELF_NAME = "Self";

      it("CONTROL ARM: one body, two resolved mentions, only the non-grantable one is reported", async () => {
        // The two arms differ on exactly one axis — the predicate's verdict.
        // Same body, same call, both resolve, both are therefore in
        // `boundMentions`. The author IS the assignee, so the peer mention
        // grants; the self-mention never can (`authorAgentId ===
        // mentionedAgentId`), so it wakes nobody.
        const existing = makeIssue({
          assigneeAgentId: ASSIGNEE_AGENT_ID,
          assigneeUserId: null,
          status: "todo",
        });
        const body = `[@${GRANTED_NAME}](agent://${MENTIONED_AGENT_ID}) please inspect — `
          + `[@${SELF_NAME}](agent://${ASSIGNEE_AGENT_ID}) is tracking it`;
        mockIssueService.getById.mockResolvedValue(existing);
        mockIssueService.addComment.mockResolvedValue({
          id: "comment-without-grant-control-arm",
          issueId: existing.id,
          companyId: existing.companyId,
          body,
        });
        mockIssueService.findMentionedAgents.mockResolvedValue([
          MENTIONED_AGENT_ID,
          ASSIGNEE_AGENT_ID,
        ]);

        const res = await request(await createApp({
          type: "agent",
          agentId: ASSIGNEE_AGENT_ID,
          companyId: existing.companyId,
          source: "agent_key",
        }))
          .post(`/api/issues/${existing.id}/comments`)
          .send({ body });

        expect(res.status).toBe(201);
        // Both resolved, so `boundMentions` cannot tell them apart. This is the
        // defect, asserted directly.
        expect(res.body.boundMentions).toEqual([GRANTED_NAME, SELF_NAME]);
        expect(res.body.unboundMentions).toEqual([]);
        // The third list does tell them apart.
        expect(res.body.mentionsWithoutGrant).toEqual([SELF_NAME]);

        // And the wakes match the report: the peer was woken, the author was not.
        await vi.waitFor(() => expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
          MENTIONED_AGENT_ID,
          expect.objectContaining({ reason: "issue_comment_mentioned" }),
        ));
        expect(mockHeartbeatService.wakeup).not.toHaveBeenCalledWith(
          ASSIGNEE_AGENT_ID,
          expect.objectContaining({ reason: "issue_comment_mentioned" }),
        );
      });

      it("names the mention an author wrote on a row they are not assigned", async () => {
        // The PEN-5793 shape, and the reason this row exists: the mention
        // resolves, is reported as bound, wakes nobody and grants nothing.
        const existing = makeIssue({
          assigneeAgentId: ASSIGNEE_AGENT_ID,
          assigneeUserId: null,
          status: "in_progress",
        });
        const body = `[@${GRANTED_NAME}](agent://${MENTIONED_AGENT_ID}) you have the grant now`;
        mockIssueService.getById.mockResolvedValue(existing);
        mockIssueService.addComment.mockResolvedValue({
          id: "comment-without-grant-non-assignee",
          issueId: existing.id,
          companyId: existing.companyId,
          body,
        });
        mockIssueService.findMentionedAgents.mockResolvedValue([MENTIONED_AGENT_ID]);

        const res = await request(await createApp({
          type: "agent",
          agentId: PREVIOUS_AGENT_ID,
          companyId: existing.companyId,
          source: "agent_key",
        }))
          .post(`/api/issues/${existing.id}/comments`)
          .send({ body });

        expect(res.status).toBe(201);
        // The affirmative signal that misled the author at 14:22Z...
        expect(res.body.boundMentions).toEqual([GRANTED_NAME]);
        // ...now paired with the one that corrects it.
        expect(res.body.mentionsWithoutGrant).toEqual([GRANTED_NAME]);
        await vi.waitFor(() => expect(mockIssueService.findMentionedAgents).toHaveBeenCalled());
        expect(mockHeartbeatService.wakeup).not.toHaveBeenCalledWith(
          MENTIONED_AGENT_ID,
          expect.objectContaining({ reason: "issue_comment_mentioned" }),
        );
      });

      it("POSITIVE CONTROL: stays empty when the assignee makes the mention", async () => {
        // Without this the field could be constant noise and still pass above.
        const existing = makeIssue({
          assigneeAgentId: ASSIGNEE_AGENT_ID,
          assigneeUserId: null,
          status: "todo",
        });
        const body = `[@${GRANTED_NAME}](agent://${MENTIONED_AGENT_ID}) please inspect this`;
        mockIssueService.getById.mockResolvedValue(existing);
        mockIssueService.addComment.mockResolvedValue({
          id: "comment-without-grant-positive-control",
          issueId: existing.id,
          companyId: existing.companyId,
          body,
        });
        mockIssueService.findMentionedAgents.mockResolvedValue([MENTIONED_AGENT_ID]);

        const res = await request(await createApp({
          type: "agent",
          agentId: ASSIGNEE_AGENT_ID,
          companyId: existing.companyId,
          source: "agent_key",
        }))
          .post(`/api/issues/${existing.id}/comments`)
          .send({ body });

        expect(res.status).toBe(201);
        expect(res.body.boundMentions).toEqual([GRANTED_NAME]);
        expect(res.body.mentionsWithoutGrant).toEqual([]);
        await vi.waitFor(() => expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
          MENTIONED_AGENT_ID,
          expect.objectContaining({ reason: "issue_comment_mentioned" }),
        ));
      });

      it("reports a user author whose company membership is not active", async () => {
        // The other arm of the predicate. Same body, same row, the only change
        // is that the author's membership no longer resolves.
        mockGetActiveCompanyMembership.mockResolvedValue(null);
        const existing = makeIssue({ assigneeUserId: "active-user", status: "in_progress" });
        const body = `[@${GRANTED_NAME}](agent://${MENTIONED_AGENT_ID}) please inspect this`;
        mockIssueService.getById.mockResolvedValue(existing);
        mockIssueService.addComment.mockResolvedValue({
          id: "comment-without-grant-inactive-user",
          issueId: existing.id,
          companyId: existing.companyId,
          body,
        });
        mockIssueService.findMentionedAgents.mockResolvedValue([MENTIONED_AGENT_ID]);

        const res = await request(await createApp({
          type: "board",
          userId: "active-user",
          companyIds: [existing.companyId],
          source: "session",
          isInstanceAdmin: false,
        }))
          .post(`/api/issues/${existing.id}/comments`)
          .send({ body });

        expect(res.status).toBe(201);
        expect(res.body.boundMentions).toEqual([GRANTED_NAME]);
        expect(res.body.mentionsWithoutGrant).toEqual([GRANTED_NAME]);
      });

      it("is unconditional, so an absent key cannot mean an older server", async () => {
        const existing = makeIssue({ status: "in_progress" });
        const body = "No mentions at all in this body.";
        mockIssueService.getById.mockResolvedValue(existing);
        mockIssueService.addComment.mockResolvedValue({
          id: "comment-without-grant-unconditional",
          issueId: existing.id,
          companyId: existing.companyId,
          body,
        });
        mockIssueService.findMentionedAgents.mockResolvedValue([]);

        const res = await request(await createApp())
          .post(`/api/issues/${existing.id}/comments`)
          .send({ body });

        expect(res.status).toBe(201);
        expect(res.body).toHaveProperty("mentionsWithoutGrant");
        expect(res.body.mentionsWithoutGrant).toEqual([]);
      });

      it("is present on the idempotent-replay response too", async () => {
        // A replay returns 200 from a different branch. An author who retried
        // must read the same verdict, or the retry is the one call that still
        // reports an inert mention as delivered.
        const existing = makeIssue({
          assigneeAgentId: ASSIGNEE_AGENT_ID,
          assigneeUserId: null,
          status: "in_progress",
        });
        const body = `[@${GRANTED_NAME}](agent://${MENTIONED_AGENT_ID}) you have the grant now`;
        mockIssueService.getById.mockResolvedValue(existing);
        mockIssueService.addComment.mockResolvedValue({
          id: "comment-without-grant-replay",
          issueId: existing.id,
          companyId: existing.companyId,
          body,
          deduplicated: true,
          idempotencyProcessedAt: new Date().toISOString(),
        });
        mockIssueService.findMentionedAgents.mockResolvedValue([MENTIONED_AGENT_ID]);

        const res = await request(await createApp({
          type: "agent",
          agentId: PREVIOUS_AGENT_ID,
          companyId: existing.companyId,
          source: "agent_key",
        }))
          .post(`/api/issues/${existing.id}/comments`)
          .send({ body, idempotencyKey: "pen5812-replay" });

        expect(res.status).toBe(200);
        expect(res.body.boundMentions).toEqual([GRANTED_NAME]);
        expect(res.body.mentionsWithoutGrant).toEqual([GRANTED_NAME]);
      });

      it("fails toward 'nothing bound' when mention resolution throws", async () => {
        // All three lists degrade together. `mentionsWithoutGrant` only ever
        // names something that resolved, so with nothing resolved there is
        // nothing it can honestly name — and `unboundMentions` still carries
        // the token, so the author is told to re-send rather than told all is
        // well.
        const existing = makeIssue({
          assigneeAgentId: ASSIGNEE_AGENT_ID,
          assigneeUserId: null,
          status: "in_progress",
        });
        const body = `[@${GRANTED_NAME}](agent://${MENTIONED_AGENT_ID}) and @${GRANTED_NAME}`;
        mockIssueService.getById.mockResolvedValue(existing);
        mockIssueService.addComment.mockResolvedValue({
          id: "comment-without-grant-resolution-failure",
          issueId: existing.id,
          companyId: existing.companyId,
          body,
        });
        mockIssueService.findMentionedAgents.mockRejectedValue(new Error("resolution exploded"));

        const res = await request(await createApp({
          type: "agent",
          agentId: PREVIOUS_AGENT_ID,
          companyId: existing.companyId,
          source: "agent_key",
        }))
          .post(`/api/issues/${existing.id}/comments`)
          .send({ body });

        expect(res.status).toBe(201);
        expect(res.body.boundMentions).toEqual([]);
        expect(res.body.mentionsWithoutGrant).toEqual([]);
        expect(res.body.unboundMentions).toEqual([GRANTED_NAME]);
      });

      it("an empty mentionsWithoutGrant is not proof of a wake: a closed row suppresses every mention wake", async () => {
        // The limit of the field, pinned so the copy on the two description
        // surfaces cannot drift back to "nothing happened".
        //
        // `mentionsWithoutGrant` models `commentAuthorCanGrantIssueMention` and
        // nothing else. The wake loop carries an EARLIER term it does not model:
        // `isClosedIssueStatus(currentIssue.status) && !reopened`. Here the
        // author IS the assignee, so entitlement passes and the name is rightly
        // absent from the list — and the row is `done` and not reopened, so the
        // wake is skipped anyway. Affirmative empty array, comment reached no
        // one. The field's NAME survives this: `agentHasMentionGrantOnIssue`
        // re-derives the grant at decision time from the persisted comment rows,
        // which the wake loop never writes to, so the grant attaches on a closed
        // row — and would under any term the wake loop later grows, not just this
        // one. "Without grant" stays accurate; it is "nothing happened" that does
        // not follow.
        // PEN-5846 tracks the three sites disagreeing on the closed term.
        const existing = makeIssue({
          assigneeAgentId: ASSIGNEE_AGENT_ID,
          assigneeUserId: null,
          status: "done",
        });
        const body = `[@${GRANTED_NAME}](agent://${MENTIONED_AGENT_ID}) please pick this back up`;
        mockIssueService.getById.mockResolvedValue(existing);
        mockIssueService.addComment.mockResolvedValue({
          id: "comment-without-grant-closed-row",
          issueId: existing.id,
          companyId: existing.companyId,
          body,
        });
        mockIssueService.findMentionedAgents.mockResolvedValue([MENTIONED_AGENT_ID]);

        const res = await request(await createApp({
          type: "agent",
          agentId: ASSIGNEE_AGENT_ID,
          companyId: existing.companyId,
          source: "agent_key",
        }))
          .post(`/api/issues/${existing.id}/comments`)
          .send({ body });

        expect(res.status).toBe(201);
        expect(res.body.boundMentions).toEqual([GRANTED_NAME]);
        // Entitlement passed, so the list is empty...
        expect(res.body.mentionsWithoutGrant).toEqual([]);
        // ...and yet nobody was woken. This is the pair the copy must not merge.
        await vi.waitFor(() => expect(mockIssueService.findMentionedAgents).toHaveBeenCalled());
        expect(mockHeartbeatService.wakeup).not.toHaveBeenCalledWith(
          MENTIONED_AGENT_ID,
          expect.objectContaining({ reason: "issue_comment_mentioned" }),
        );
      });
    });

    it("still reports the signal when mention resolution throws", async () => {
      // Fail toward reporting: a false "this may not have reached anyone" costs
      // a re-send, a false silence costs a day.
      const existing = makeIssue({ status: "in_progress" });
      const body = "@Ceo please rule on this";
      mockIssueService.getById.mockResolvedValue(existing);
      mockIssueService.addComment.mockResolvedValue({
        id: "comment-resolution-failure",
        issueId: existing.id,
        companyId: existing.companyId,
        body,
      });
      mockIssueService.findMentionedAgents.mockRejectedValue(new Error("resolution exploded"));

      const res = await request(await createApp())
        .post(`/api/issues/${existing.id}/comments`)
        .send({ body });

      expect(res.status).toBe(201);
      expect(res.body.unboundMentions).toEqual(["Ceo"]);
    });
  });
});
