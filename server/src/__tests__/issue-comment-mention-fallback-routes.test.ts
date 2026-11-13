import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ASSIGNEE_AGENT_ID = "11111111-1111-4111-8111-111111111111";
const MENTIONED_AGENT_ID = "33333333-3333-4333-8333-333333333333";
const ISSUE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const COMMENT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

type LedgerRow = { effectKind: string; effectKey: string; status: "queued" | "processed" };

/**
 * PEN-5682 — the mention-lookup FALLBACK on the eligible unkeyed comment path.
 *
 * Third file in the same split, and split for the same measured reason. Each
 * test here re-imports the whole route module via `vi.resetModules()`, and
 * EXACTLY FIVE such rebuilds fit the 8 GB sandbox's worker address space: a
 * sixth dies in `v8::base::FatalOOM` inside `NewIsolate`, identically at
 * `--max-old-space-size=3072` and at `1536`, so it is address space and not
 * heap and there is no flag that buys another one. `issue-comment-unkeyed-
 * outbox-routes.test.ts` is already at five, so these three could not be
 * appended to it without making that file unrunnable end-to-end.
 *
 * What it covers: the eligible branch resolves mentions BEFORE opening the
 * insert transaction, and `resolveCommentMentionContext` lets
 * `findMentionedAgents` throw. Unguarded, that turns a 201 into a 500 and
 * loses the comment — a refusal the inline path has never made. The branch
 * that prevents it had NO test until Ally's review of `bf4cff5a` said so, and
 * the commit message claiming otherwise was wrong.
 *
 * In-memory stand-in for `issue_comment_effects`, faithful on the two
 * properties this file is about: a failed drain leaves every unfinished row
 * `queued` (what `releaseEffect` writes before `processCommentEffects`
 * rethrows), and re-enqueueing the same `(comment_id, effect_key)` is a no-op.
 */
const ledger = new Map<string, LedgerRow[]>();
let drainFailuresRemaining = 0;

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  // PEN-5682: reached only by an AGENT actor, which this file did not exercise
  // until the closed-row and interrupt routing tests below.
  assertCheckoutOwner: vi.fn(async () => undefined),
  cancelStaleIssueContextRuns: vi.fn(async () => []),
  getActiveRun: vi.fn(async () => null),
  clearExecutionRunIfTerminal: vi.fn(async () => undefined),
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
  // PEN-5682: an AGENT actor reaches `resolveTaskWatchdogMutationScope`, which
  // reads the database directly, so the handle needs a select chain as well as
  // a transaction. Every table answers `[]` — none of these tests turn on a
  // row being found, and an empty watchdog scope is the permissive answer.
  const selectChain: Record<string, unknown> = {};
  Object.assign(selectChain, {
    from: () => selectChain,
    where: () => selectChain,
    innerJoin: () => selectChain,
    leftJoin: () => selectChain,
    orderBy: () => selectChain,
    limit: () => selectChain,
    then: (onFulfilled: (rows: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
      Promise.resolve([]).then(onFulfilled, onRejected),
  });
  const db = {
    select: vi.fn(() => selectChain),
    selectDistinct: vi.fn(() => selectChain),
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

describe("issue comment mention-lookup fallback", () => {
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


  // ── PEN-5682 / Ally review at bf4cff5a: the mention-lookup FALLBACK ──
  //
  // The `bf4cff5a` commit message claimed "Three tests pin it" and it was
  // FALSE — the branch had no test at all, and `findMentionedAgents` was only
  // ever stubbed with `mockResolvedValue`. These are the tests that message
  // described. The claim mattered because the branch is the only thing between
  // a mention-lookup failure and a 500 that loses the comment: the eligible
  // path resolves mentions BEFORE the insert transaction, so an unguarded
  // throw refuses a write the inline path has always accepted.
  //
  // NEGATIVE CONTROL, run on this head, BOTH arms, failures quoted verbatim.
  //
  //  (a) `try`/`catch` removed so the throw propagates: ALL THREE fail,
  //      every one with `AssertionError: expected 500 to be 201`.
  //
  //  (b) The cheaper fix the route comment refuses — substituting an EMPTY
  //      mention context in the catch rather than falling back — is caught by
  //      the first two and NOT by the third:
  //        1 fails `expected [ …(5) ] to have a length of 4 but got 5`
  //          (the write went to the outbox on a transaction handle);
  //        2 fails `expected "vi.fn()" to be called with arguments: [ …(2) ]`
  //          (the mention wake the empty context dropped);
  //        3 PASSES — the inline tail's own lookup still throws either way, so
  //          the response reports the unbound name under both implementations.
  //
  // That is the argument for keeping all three rather than the third alone:
  // reporting the unbound name does NOT discriminate a fallback from a
  // silently-emptied context, and the silently-emptied context is the one that
  // lands the write while dropping the wakes it owed.

  it("falls back to the inline path when the mention lookup fails, instead of losing the comment", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue());
    mockIssueService.findMentionedAgents.mockRejectedValue(new Error("mention lookup exploded"));
    const { app, db } = await createApp();

    const res = await request(app)
      .post(`/api/issues/${ISSUE_ID}/comments`)
      .send({ body: `please look, [@peer](agent://${MENTIONED_AGENT_ID})` });

    // 201, not 500: the caller keeps the comment they were told had landed.
    expect(res.status).toBe(201);
    // Inserted on the default handle: four arguments, no transaction.
    expect(mockIssueService.addComment).toHaveBeenCalledTimes(1);
    expect(mockIssueService.addComment.mock.calls[0]).toHaveLength(4);
    expect(db.transaction).not.toHaveBeenCalled();
    // Nothing was enqueued, so nothing is owed to a drain that will never run.
    expect(mockCommentEffects.enqueueCommentEffects).not.toHaveBeenCalled();
    expect(ledgerRows(COMMENT_ID)).toHaveLength(0);
    // And the inline tail owns the side effects, as it did before the hoist.
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      ASSIGNEE_AGENT_ID,
      expect.objectContaining({ reason: "issue_commented" }),
    );
  });

  it("re-resolves the mention on the fallback path, so the wake an empty context would have dropped still fires", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue());
    // Only the HOIST fails. The inline tail's own lookup — inside its own
    // catch — succeeds, which is why falling back restores the full behaviour
    // and an empty-context substitution would not.
    mockIssueService.findMentionedAgents
      .mockRejectedValueOnce(new Error("mention lookup exploded"))
      .mockResolvedValue([MENTIONED_AGENT_ID]);
    const { app } = await createApp();

    const res = await request(app)
      .post(`/api/issues/${ISSUE_ID}/comments`)
      .send({ body: `please look, [@peer](agent://${MENTIONED_AGENT_ID})` });

    expect(res.status).toBe(201);
    // The wake first, deliberately: it is what this test is about, so it is
    // what the failure message should name.
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      MENTIONED_AGENT_ID,
      expect.objectContaining({ reason: "issue_comment_mentioned" }),
    );
    expect(mockCommentEffects.enqueueCommentEffects).not.toHaveBeenCalled();
    // Exactly two lookups: the hoist that threw, and the inline tail's, which
    // is memoized and shared by the wake loop and the response body.
    expect(mockIssueService.findMentionedAgents).toHaveBeenCalledTimes(2);
    expect(res.body.boundMentions).toEqual(["peer"]);
    expect(res.body.unboundMentions).toEqual([]);
  });

  it("still reports the mention it could not bind when the lookup fails outright", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue());
    mockIssueService.findMentionedAgents.mockRejectedValue(new Error("mention lookup exploded"));
    const { app } = await createApp();

    const res = await request(app)
      .post(`/api/issues/${ISSUE_ID}/comments`)
      .send({ body: `please look, [@peer](agent://${MENTIONED_AGENT_ID})` });

    expect(res.status).toBe(201);
    // Degrade and SAY SO. A false "this may not have reached anyone" costs a
    // re-send; a false silence costs a day. The wake really was dropped, and
    // the response is the only place that is visible.
    expect(res.body.unboundMentions).toEqual(["peer"]);
    expect(res.body.boundMentions).toEqual([]);
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalledWith(
      MENTIONED_AGENT_ID,
      expect.anything(),
    );
  });

});
