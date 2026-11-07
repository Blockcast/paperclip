import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ASSIGNEE_AGENT_ID = "11111111-1111-4111-8111-111111111111";
const MENTIONED_AGENT_ID = "33333333-3333-4333-8333-333333333333";
const ISSUE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const COMMENT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

type LedgerRow = { effectKind: string; effectKey: string; status: "queued" | "processed" };

/**
 * In-memory stand-in for `issue_comment_effects`, faithful on the two
 * properties this file is about: a failed drain leaves every unfinished row
 * `queued` (what `releaseEffect` writes before `processCommentEffects`
 * rethrows), and re-enqueueing the same `(comment_id, effect_key)` is a no-op.
 */
const ledger = new Map<string, LedgerRow[]>();
let drainFailuresRemaining = 0;

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
  addComment: vi.fn(),
  getCommentByIdempotencyKey: vi.fn(),
  findMentionedAgents: vi.fn(),
  getRelationSummaries: vi.fn(),
  getDependencyReadiness: vi.fn(),
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
const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
const mockGetActiveCompanyMembership = vi.hoisted(() => vi.fn(async () => ({ id: "membership-1" })));
const mockCommentEffects = vi.hoisted(() => ({
  enqueueCommentEffects: vi.fn(),
  getEffectResult: vi.fn(async () => null),
  hasCommentEffects: vi.fn(),
  processCommentEffects: vi.fn(),
}));
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

const BOARD_ACTOR = {
  type: "board",
  userId: "local-board",
  companyIds: ["company-1"],
  source: "local_implicit",
  isInstanceAdmin: false,
};

type CommentEffectProcessor = (commentId: string) => Promise<unknown>;

/** The transaction handle the route is handed, so a test can prove a call ran inside it. */
const TX_HANDLE = { tx: true } as const;

async function createApp(actor: Record<string, unknown> = BOARD_ACTOR) {
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
    transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(TX_HANDLE)),
  };
  let registeredProcessor: CommentEffectProcessor | null = null;
  app.use("/api", issueRoutes(db as any, {} as any, {
    registerCommentEffectProcessor: (processor: CommentEffectProcessor) => {
      registeredProcessor = processor;
    },
  } as any));
  app.use(errorHandler);
  return {
    app,
    db,
    /** What `startIssueCommentEffectReconciler` is wired to in `app.ts`. */
    reconcile: (commentId: string) => {
      if (!registeredProcessor) throw new Error("route registered no comment effect processor");
      return (registeredProcessor as CommentEffectProcessor)(commentId);
    },
  };
}

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: ISSUE_ID,
    companyId: "company-1",
    status: "in_progress",
    priority: "medium",
    projectId: null,
    goalId: null,
    parentId: null,
    assigneeAgentId: ASSIGNEE_AGENT_ID,
    assigneeUserId: null,
    createdByUserId: "local-board",
    identifier: "PAP-5669",
    title: "Outbox",
    executionPolicy: null,
    executionState: null,
    checkoutRunId: null,
    executionRunId: null,
    hiddenAt: null,
    ...overrides,
  };
}

function makeComment(overrides: Record<string, unknown> = {}) {
  return {
    id: COMMENT_ID,
    issueId: ISSUE_ID,
    companyId: "company-1",
    body: "plain comment",
    authorType: "user",
    idempotencyKey: null,
    idempotencyProcessedAt: null,
    ...overrides,
  };
}

function ledgerRows(commentId: string) {
  return ledger.get(commentId) ?? [];
}

describe("issue comment effect outbox routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    ledger.clear();
    drainFailuresRemaining = 0;

    mockIssueService.getCommentByIdempotencyKey.mockResolvedValue(null);
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.getDependencyReadiness.mockResolvedValue({ unresolvedBlockerCount: 0 });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockIssueService.getCurrentScheduledRetry.mockResolvedValue(null);
    // Echo the request body, as a real first-write insert does. The route now
    // reuses its pre-resolved mention context only when `accepted.body` matches
    // what it resolved from, so a fixture that returns a FIXED body would quietly
    // exercise the dedup fallback on every test.
    mockIssueService.addComment.mockImplementation(async (_issueId: string, body: string) =>
      makeComment({ body }),
    );
    mockGetActiveCompanyMembership.mockResolvedValue({ id: "membership-1" });
    mockIssueReferenceService.diffIssueReferenceSummary.mockReturnValue({
      addedReferencedIssues: [],
      removedReferencedIssues: [],
      currentReferencedIssues: [],
    });
    mockIssueReferenceService.emptySummary.mockReturnValue({ outbound: [], inbound: [] });
    mockIssueReferenceService.listIssueReferenceSummary.mockResolvedValue({ outbound: [], inbound: [] });
    mockIssueReferenceService.syncComment.mockResolvedValue(undefined);

    mockCommentEffects.enqueueCommentEffects.mockImplementation(
      async (_handle: unknown, input: { commentId: string; effects: Array<{ effectKind: string; effectKey: string }> }) => {
        const rows = ledger.get(input.commentId) ?? [];
        for (const effect of input.effects) {
          if (rows.some((row) => row.effectKey === effect.effectKey)) continue;
          rows.push({ effectKind: effect.effectKind, effectKey: effect.effectKey, status: "queued" });
        }
        ledger.set(input.commentId, rows);
      },
    );
    mockCommentEffects.hasCommentEffects.mockImplementation(
      async (_db: unknown, commentId: string) => ledgerRows(commentId).length > 0,
    );
    mockCommentEffects.processCommentEffects.mockImplementation(async (_db: unknown, commentId: string) => {
      if (drainFailuresRemaining > 0) {
        drainFailuresRemaining -= 1;
        // `releaseEffect` has already written the row back as `queued` with a
        // backoff by the time the rethrow escapes, so the ledger is left
        // unfinished rather than lost.
        throw new Error('{"code":"40P01","message":"deadlock detected"}');
      }
      for (const row of ledgerRows(commentId)) row.status = "processed";
      return true;
    });
  });

  it("resolves the @-mention fan-out before opening the insert transaction", async () => {
    // The insert fires `issue_comments_bump_issue_last_activity_at`, which takes
    // `FOR NO KEY UPDATE` on the parent `issues` row and holds it to commit
    // (migration 0229). These lookups used to run inside the transaction, so
    // every keyed comment held a write lock on the hot `issues` row across them.
    mockIssueService.getById.mockResolvedValue(makeIssue());
    mockIssueService.findMentionedAgents.mockResolvedValue([MENTIONED_AGENT_ID]);
    const order: string[] = [];
    mockIssueService.findMentionedAgents.mockImplementation(async () => {
      order.push("findMentionedAgents");
      return [MENTIONED_AGENT_ID];
    });
    const { app, db } = await createApp();
    db.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => {
      order.push("transaction:open");
      try {
        return await callback(TX_HANDLE);
      } finally {
        order.push("transaction:commit");
      }
    });

    const res = await request(app)
      .post(`/api/issues/${ISSUE_ID}/comments`)
      .send({ body: `ping [@Peer](agent://${MENTIONED_AGENT_ID})`, idempotencyKey: "hoist" });

    expect(res.status).toBe(201);
    // The resolution the intent builder needs happens first, and the builder
    // reuses it rather than querying again from inside the transaction.
    expect(order[0]).toBe("findMentionedAgents");
    const opened = order.indexOf("transaction:open");
    const committed = order.indexOf("transaction:commit");
    expect(opened).toBeGreaterThan(-1);
    expect(committed).toBeGreaterThan(opened);
    // Nothing queries mentions while the row lock is held. The route does
    // resolve them a second time AFTER the commit, for `unboundMentions` on the
    // response — that one asks about the PERSISTED body and is deliberately a
    // separate lookup, so assert placement rather than a call count.
    expect(order.slice(opened, committed + 1)).toEqual(["transaction:open", "transaction:commit"]);
    // ...and the mention still produces its wake intent, committed with the comment.
    expect(mockCommentEffects.enqueueCommentEffects).toHaveBeenCalledWith(
      TX_HANDLE,
      expect.objectContaining({ commentId: COMMENT_ID }),
    );
    expect(ledgerRows(COMMENT_ID).map((row) => row.effectKey)).toContain(
      `wake:${MENTIONED_AGENT_ID}:${ISSUE_ID}`,
    );
  });

  it("commits a keyed comment's effect intents in the same transaction as the insert", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue());
    const { app, db } = await createApp();

    const res = await request(app)
      .post(`/api/issues/${ISSUE_ID}/comments`)
      .send({ body: "plain comment", idempotencyKey: "first-write" });

    expect(res.status).toBe(201);
    expect(db.transaction).toHaveBeenCalledTimes(1);
    // The insert and the intent enqueue both received the transaction handle,
    // which is the whole claim: there is no window where an accepted comment
    // has no durable record of the work it still owes.
    expect(mockIssueService.addComment).toHaveBeenCalledWith(
      ISSUE_ID,
      "plain comment",
      expect.anything(),
      expect.objectContaining({ idempotencyKey: "first-write" }),
      TX_HANDLE,
    );
    expect(mockCommentEffects.enqueueCommentEffects).toHaveBeenCalledWith(
      TX_HANDLE,
      expect.objectContaining({ commentId: COMMENT_ID, issueId: ISSUE_ID }),
    );
    expect(ledgerRows(COMMENT_ID).map((row) => row.effectKey)).toEqual(
      expect.arrayContaining([
        "references_sync",
        "comment_activity",
        "interaction_expiry",
        "recovery_revalidation",
        `wake:${ASSIGNEE_AGENT_ID}:${ISSUE_ID}`,
        "watchdog_evaluation",
      ]),
    );
    expect(ledgerRows(COMMENT_ID).every((row) => row.status === "processed")).toBe(true);
  });

  it("returns the created comment when the inline drain fails, and the reconciler settles it afterwards", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue());
    drainFailuresRemaining = 1;
    const { app, reconcile } = await createApp();

    const res = await request(app)
      .post(`/api/issues/${ISSUE_ID}/comments`)
      .send({ body: "plain comment", idempotencyKey: "drain-fails" });

    // 1. the caller gets a success, not the 503 a bare rethrow produced...
    expect(res.status).toBe(201);
    // 2. ...about a comment that is durable, and whose intents are durable with it.
    expect(res.body.id).toBe(COMMENT_ID);
    expect(mockIssueService.addComment).toHaveBeenCalledTimes(1);
    expect(ledgerRows(COMMENT_ID).length).toBeGreaterThan(0);
    expect(ledgerRows(COMMENT_ID).every((row) => row.status === "queued")).toBe(true);

    // 3. and the reconciler — the same entry point `app.ts` polls every second —
    //    finishes the pipeline afterwards.
    await reconcile(COMMENT_ID);
    expect(ledgerRows(COMMENT_ID).every((row) => row.status === "processed")).toBe(true);
  });

  it("ignores the hoisted mention context when the insert deduplicated onto another request's comment", async () => {
    // Two concurrent same-key requests can both miss the out-of-transaction
    // pre-check and both enter the transaction branch. The loser's
    // `svc.addComment` hits `onConflictDoNothing` and returns the WINNER's
    // persisted row with `deduplicated: true` — so the hoisted context, which
    // was resolved from THIS request's body, describes text that was never
    // stored. Its wake keys would not collide with the winner's, so the
    // `(comment_id, effect_key)` dedup cannot catch them, and the result would
    // be a wake for a mention nobody can read.
    mockIssueService.getById.mockResolvedValue(makeIssue());
    mockIssueService.findMentionedAgents.mockImplementation(async (_companyId: string, body: string) =>
      body.includes(MENTIONED_AGENT_ID) ? [MENTIONED_AGENT_ID] : [],
    );
    // What the race persisted: the winner's comment, which mentions nobody.
    mockIssueService.addComment.mockResolvedValue({
      ...makeComment({ body: "the winner's text" }),
      deduplicated: true,
    });
    const { app } = await createApp();

    const res = await request(app)
      .post(`/api/issues/${ISSUE_ID}/comments`)
      .send({ body: `loser [@Peer](agent://${MENTIONED_AGENT_ID})`, idempotencyKey: "raced" });

    // 200, not 201: `deduplicated` on the insert marks this request a replay.
    expect(res.status).toBe(200);
    expect(res.body.deduplicated).toBe(true);
    // The builder fell back to resolving from the PERSISTED body, so the
    // request-only mention produces no intent.
    expect(ledgerRows(COMMENT_ID).map((row) => row.effectKey)).not.toContain(
      `wake:${MENTIONED_AGENT_ID}:${ISSUE_ID}`,
    );
    // The assignee wake, which does not depend on the body, is still there.
    expect(ledgerRows(COMMENT_ID).map((row) => row.effectKey)).toContain(
      `wake:${ASSIGNEE_AGENT_ID}:${ISSUE_ID}`,
    );
  });

  it("answers a same-key replay 200 while its effects are still queued, without inserting a second comment", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue());
    drainFailuresRemaining = 1;
    const first = await createApp();
    const created = await request(first.app)
      .post(`/api/issues/${ISSUE_ID}/comments`)
      .send({ body: "plain comment", idempotencyKey: "replay-me" });
    expect(created.status).toBe(201);
    expect(ledgerRows(COMMENT_ID).every((row) => row.status === "queued")).toBe(true);
    const intentCountAfterFirstWrite = ledgerRows(COMMENT_ID).length;

    // The replay finds the comment with `idempotency_processed_at` still null,
    // so the early 200-and-return does not fire; it falls through, finds the
    // intents already enqueued, and re-drains.
    mockIssueService.addComment.mockClear();
    mockIssueService.getCommentByIdempotencyKey.mockResolvedValue(
      makeComment({ idempotencyKey: "replay-me", idempotencyProcessedAt: null }),
    );
    const replay = await request(first.app)
      .post(`/api/issues/${ISSUE_ID}/comments`)
      .send({ body: "plain comment", idempotencyKey: "replay-me" });

    expect(replay.status).toBe(200);
    expect(replay.body.deduplicated).toBe(true);
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
    expect(ledgerRows(COMMENT_ID)).toHaveLength(intentCountAfterFirstWrite);
    expect(ledgerRows(COMMENT_ID).every((row) => row.status === "processed")).toBe(true);
  });

});
