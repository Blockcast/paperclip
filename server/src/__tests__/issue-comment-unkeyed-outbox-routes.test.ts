import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ASSIGNEE_AGENT_ID = "11111111-1111-4111-8111-111111111111";
const MENTIONED_AGENT_ID = "33333333-3333-4333-8333-333333333333";
const ISSUE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const COMMENT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

type LedgerRow = { effectKind: string; effectKey: string; status: "queued" | "processed" };

/**
 * PEN-5682 — routing the UNKEYED comment write onto the effect outbox.
 *
 * Split from `issue-comment-effect-outbox-routes.test.ts` (which covers the
 * KEYED path) rather than appended to it: that file re-imports the whole route
 * module per test via `vi.resetModules()`, and nine such rebuilds exceed the
 * 8 GB sandbox's worker address space, so the combined file could not be run
 * end-to-end locally. Two files each run clean.
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

describe("issue comment unkeyed outbox routing", () => {
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

  // ───────────────────────── PEN-5682 ─────────────────────────
  // The UNKEYED comment write now takes this same outbox when it is eligible.
  // `idempotencyKey` is optional on the public API, so the default fleet call
  // landed in the branch where the INSERT autocommits and the side effects then
  // ran bare and inline: a failure between them lost work the caller was told
  // had landed. These pin the routing itself, in both directions.

  it("commits an eligible UNKEYED comment's effect intents in the same transaction as the insert", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue());
    const { app, db } = await createApp();

    const res = await request(app)
      .post(`/api/issues/${ISSUE_ID}/comments`)
      .send({ body: "plain comment" });

    expect(res.status).toBe(201);
    expect(db.transaction).toHaveBeenCalledTimes(1);
    // The TRANSACTION handle, not the default db handle. That is the whole
    // claim: comment and intents commit together, so no crash between them can
    // leave a persisted comment owing side effects nobody recorded.
    expect(mockCommentEffects.enqueueCommentEffects).toHaveBeenCalledWith(
      TX_HANDLE,
      expect.objectContaining({ commentId: COMMENT_ID, issueId: ISSUE_ID, companyId: "company-1" }),
    );
    // And it owes the same effect set the keyed path does — the unkeyed branch
    // reuses `buildKeyedCommentEffectIntents` rather than a parallel builder.
    expect(ledgerRows(COMMENT_ID).map((row) => row.effectKey)).toEqual(
      expect.arrayContaining([
        "references_sync",
        "comment_activity",
        "interaction_expiry",
        "recovery_revalidation",
        `wake:${ASSIGNEE_AGENT_ID}:${ISSUE_ID}`,
      ]),
    );
    // No caller-supplied key, so the COMMENT stays non-replayable. The effect
    // keys are derived from the effect kind and were never the caller's.
    expect(mockIssueService.addComment).toHaveBeenCalledWith(
      ISSUE_ID,
      "plain comment",
      expect.anything(),
      expect.objectContaining({ idempotencyKey: null }),
      TX_HANDLE,
    );
  });

  it("drains an eligible unkeyed comment's effects inline, so the wake still fires on the request", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue());
    const { app } = await createApp();

    const res = await request(app)
      .post(`/api/issues/${ISSUE_ID}/comments`)
      .send({ body: "plain comment" });

    expect(res.status).toBe(201);
    // Behaviour, not mechanism: the point of the migration is that the same
    // things happen, not that a ledger row exists. A row that is enqueued and
    // never drained would satisfy the test above and regress the product.
    expect(mockCommentEffects.processCommentEffects).toHaveBeenCalledWith(
      expect.anything(),
      COMMENT_ID,
      expect.any(Function),
    );
    expect(ledgerRows(COMMENT_ID).every((row) => row.status === "processed")).toBe(true);
  });

  // PEN-5682 done-when 3. BEHAVIOUR-PRESERVING ON CLOSED ROWS.
  //
  // ⛔ This test is NOT retired by PEN-5846 landing. PEN-5846 ruled on the
  // MENTION WAKE and has since given `buildKeyedCommentEffectIntents` the
  // closed guard its inline siblings carry — but this asserts something else:
  // that closed-row traffic never reaches the outbox AT ALL. Equivalence
  // between the inline tail and the intent set on a closed row has never been
  // measured for the other effect kinds, and routing that traffic is a separate
  // decision nobody has taken. The exclusion lives in one `&&` in the eligible
  // predicate, and without this test it is one edit away from being lost
  // silently — the divergence exists only on closed rows, so a reviewer
  // comparing before/after wake counts on an open row sees nothing.
  //
  // This row does not decide whether the suppression is RIGHT. That is
  // PEN-5846's. It decides only that this migration does not change it.
  it("keeps a comment on a CLOSED row on the inline path, with its mention wake still suppressed", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue({ status: "done" }));
    mockIssueService.findMentionedAgents.mockResolvedValue([MENTIONED_AGENT_ID]);
    // The assignee commenting on its own terminal issue: a closing handoff
    // note. `isAssigneeSelfCommentOnTerminalIssue` keeps it from implicitly
    // reopening, so the row is still `done` when eligibility is judged — which
    // is the case this term exists for.
    const { app } = await createApp({
      type: "agent",
      agentId: ASSIGNEE_AGENT_ID,
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    });

    const res = await request(app)
      .post(`/api/issues/${ISSUE_ID}/comments`)
      .send({ body: `handing off, see [@peer](agent://${MENTIONED_AGENT_ID})` });

    expect(res.status).toBe(201);
    // Ineligible ⇒ no intents, no outbox, inline path verbatim.
    expect(mockCommentEffects.enqueueCommentEffects).not.toHaveBeenCalled();
    expect(ledgerRows(COMMENT_ID)).toHaveLength(0);
    // Inserted on the default handle: four arguments, no transaction.
    expect(mockIssueService.addComment).toHaveBeenCalledTimes(1);
    expect(mockIssueService.addComment.mock.calls[0]).toHaveLength(4);
    // And the suppression the inline path has always applied still applies.
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalledWith(
      MENTIONED_AGENT_ID,
      expect.anything(),
    );
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ reason: "issue_comment_mentioned" }),
    );
  });

  it("keeps a REOPENING comment on the inline path", async () => {
    // `reopened` swaps the assignee wake for `issue_reopened_via_comment` and
    // adds `reopened`/`reopenedFrom` to the activity details, none of which
    // `buildKeyedCommentEffectIntents` can express — and the reopen itself is a
    // second durable write, so the comment is no longer the only one. Excluded
    // rather than silently losing those fields.
    mockIssueService.getById.mockResolvedValue(makeIssue({ status: "done" }));
    mockIssueService.update.mockResolvedValue(makeIssue({ status: "todo" }));
    const { app } = await createApp();

    const res = await request(app)
      .post(`/api/issues/${ISSUE_ID}/comments`)
      .send({ body: "picking this back up", reopen: true });

    expect(res.status).toBe(201);
    expect(mockIssueService.update).toHaveBeenCalledWith(ISSUE_ID, { status: "todo" });
    expect(mockCommentEffects.enqueueCommentEffects).not.toHaveBeenCalled();
    // Inserted on the default handle: four arguments, no transaction.
    expect(mockIssueService.addComment.mock.calls[0]).toHaveLength(4);
  });

  // PEN-6645 item 2. `!interruptRequested` is the ONE remaining conjunct that
  // is INDEPENDENTLY reachable — i.e. the only one a request can falsify while
  // leaving all six others true, so the only one a test can pin without the
  // pin being satisfied by a sibling term.
  //
  // The reachability of the other four was settled by reading the route, and
  // the finding is recorded here because a conjunct nobody can isolate is a
  // result, not a gap:
  //
  //  - `!resumeRequested` and `!effectiveMoveToTodoRequested` CO-FIRE on the
  //    case the route's own comment names (`resume: true` on an already-`todo`
  //    issue): `explicitMoveToTodoRequested = effectiveReopenRequested ||
  //    effectiveResumeRequested`, so an effective resume makes BOTH false.
  //    They separate only for a `commentOnlyGrantedPeerAgent`, where
  //    `effectiveResumeRequested` is forced false while `resumeRequested` —
  //    the term the predicate actually reads — stays true. That is a real
  //    independent case and it is NOT pinned here; it needs the comment-only
  //    peer-grant fixture, which this suite does not build.
  //  - `!scheduledRetrySupersededByComment` is a COMPENSATING term, not an
  //    independently reachable one: it is assigned only inside the
  //    `effectiveMoveToTodoRequested && (isClosed || isBlocked || shouldResume)`
  //    block, which unconditionally runs `svc.update(id, { status: "todo" })`.
  //    So whenever it is true, `effectiveMoveToTodoRequested` is true AND
  //    `currentIssue.status === issue.status` is false. No request can falsify
  //    it alone, and a test claiming to pin it would really be pinning one of
  //    those two.
  //  - `currentIssue.status === issue.status` is the re-read concurrency guard
  //    and moves only through that same block, so it inherits the same
  //    entanglement.
  it("keeps an INTERRUPTING comment on the inline path", async () => {
    // `interruptedRunId` rides the activity row and every wake payload, and
    // `buildKeyedCommentEffectIntents` carries neither — so the interrupt is
    // excluded rather than silently losing the field. Board-only by the route's
    // own 403, which is why this uses the default board actor.
    mockIssueService.getById.mockResolvedValue(makeIssue());
    const { app } = await createApp();

    const res = await request(app)
      .post(`/api/issues/${ISSUE_ID}/comments`)
      .send({ body: "stop what you are doing", interrupt: true });

    expect(res.status).toBe(201);
    // No status moved and nothing was reopened — the ONLY conjunct this
    // request falsifies is `!interruptRequested`, which is what makes the
    // assertion below a pin on that term rather than on a neighbour.
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockCommentEffects.enqueueCommentEffects).not.toHaveBeenCalled();
    // Inserted on the default handle: four arguments, no transaction.
    expect(mockIssueService.addComment.mock.calls[0]).toHaveLength(4);
  });

});
