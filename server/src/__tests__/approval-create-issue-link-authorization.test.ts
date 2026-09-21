import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * BLO-23763: `POST /companies/:companyId/approvals` accepted an `issueIds` array
 * and linked it with no issue-scoped authorization, so any agent could attach a
 * board approval to any issue in its company — including issues it does not own,
 * is not in the manager chain of, and has never been mentioned on. The dedicated
 * link route `POST /issues/:id/approvals` did run that boundary, so the boundary
 * was bypassable by choosing the other entry point.
 *
 * These tests fail against `master` at the time of the fix: without
 * `assertIssueLinksAllowed` the create route returns 201 for every case below.
 */

const COMPANY_ID = "company-1";
const ACTOR_AGENT_ID = "agent-1";
const PEER_AGENT_ID = "agent-2";
const OWN_ISSUE_ID = "11111111-1111-4111-8111-111111111111";
const PEER_ISSUE_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_PEER_ISSUE_ID = "33333333-3333-4333-8333-333333333333";
const REVIEWED_ISSUE_ID = "44444444-4444-4444-8444-444444444444";

const mockApprovalService = vi.hoisted(() => ({
  list: vi.fn(),
  listSummary: vi.fn(),
  countBy: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  createWithIdempotency: vi.fn(),
  approve: vi.fn(),
  reject: vi.fn(),
  requestRevision: vi.fn(),
  resubmit: vi.fn(),
  listComments: vi.fn(),
  addComment: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({ wakeup: vi.fn() }));
const mockIssueApprovalService = vi.hoisted(() => ({
  listIssuesForApproval: vi.fn(),
  linkManyForApproval: vi.fn(),
}));
const mockIssueService = vi.hoisted(() => ({ getById: vi.fn() }));
const mockSecretService = vi.hoisted(() => ({
  normalizeHireApprovalPayloadForPersistence: vi.fn(),
}));
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockAccessService = vi.hoisted(() => ({ decide: vi.fn() }));
const mockTaskWatchdogService = vi.hoisted(() => ({
  revalidateMutationScope: vi.fn(),
}));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    approvalService: () => mockApprovalService,
    heartbeatService: () => mockHeartbeatService,
    issueApprovalService: () => mockIssueApprovalService,
    issueService: () => mockIssueService,
    logActivity: mockLogActivity,
    secretService: () => mockSecretService,
    taskWatchdogService: () => mockTaskWatchdogService,
  }));
}

const WATCHDOG_ID = "55555555-5555-4555-8555-555555555555";
const WATCHDOG_ISSUE_ID = "66666666-6666-4666-8666-666666666666";
const STOP_FINGERPRINT = "task_watchdog_stop:test";

/** The run-context shape `resolveTaskWatchdogMutationScope` reads. */
const watchdogContext = (watchedIssueId: string) => ({
  taskWatchdog: { watchedIssueId, stopFingerprint: STOP_FINGERPRINT },
});

/**
 * The route's only direct `db` use is the `heartbeatRuns` lookup inside
 * `assertApprovalMutationAllowedByRunContext`, keyed on the selection containing
 * `contextSnapshot`. Everything else goes through the mocked services.
 *
 * The watchdog gate adds two more reads, both reached only when the run context
 * actually carries `taskWatchdog` — the `issueWatchdogs` row (keyed on
 * `watchdogAgentId`) and the ancestry walk (keyed on `parentId`). Serving them
 * unconditionally is safe: a non-watchdog run resolves scope `none` and never
 * gets that far.
 */
function createRouteDb(contextSnapshot: Record<string, unknown> = {}, runId = "run-1") {
  const runRows = [{ id: runId, companyId: COMPANY_ID, agentId: ACTOR_AGENT_ID, contextSnapshot }];
  const watchedIssueId = (contextSnapshot as any)?.taskWatchdog?.watchedIssueId ?? PEER_ISSUE_ID;
  const watchdogRows = [{
    id: WATCHDOG_ID,
    companyId: COMPANY_ID,
    issueId: watchedIssueId,
    watchdogAgentId: ACTOR_AGENT_ID,
    watchdogIssueId: WATCHDOG_ISSUE_ID,
    status: "active",
  }];
  // One row for every ancestry probe: the walk terminates on
  // `currentId === watchedIssueId`, so a self-parented row keeps the target
  // inside the watched subtree without modelling a real tree.
  const ancestryRows = [{ id: watchedIssueId, companyId: COMPANY_ID, parentId: null, originKind: null }];
  const rowsForSelection = (selection: Record<string, unknown>) => {
    const keys = Object.keys(selection);
    if (keys.includes("contextSnapshot")) return runRows;
    if (keys.includes("watchdogAgentId")) return watchdogRows;
    if (keys.includes("parentId")) return ancestryRows;
    return [];
  };
  return {
    select: vi.fn((selection: Record<string, unknown> = {}) => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          then: async (resolve: (rows: unknown[]) => unknown) => resolve(rowsForSelection(selection)),
        })),
      })),
    })),
  } as any;
}

async function createApp(actor: Record<string, unknown>, contextSnapshot: Record<string, unknown> = {}) {
  const [{ errorHandler }, { approvalRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/approvals.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", approvalRoutes(createRouteDb(contextSnapshot)));
  app.use(errorHandler);
  return app;
}

const agentActor = (overrides: Record<string, unknown> = {}) => ({
  type: "agent",
  agentId: ACTOR_AGENT_ID,
  companyId: COMPANY_ID,
  runId: "run-1",
  source: "api_key",
  isInstanceAdmin: false,
  ...overrides,
});

const boardActor = () => ({
  type: "board",
  userId: "user-1",
  companyIds: [COMPANY_ID],
  source: "session",
  isInstanceAdmin: false,
});

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: OWN_ISSUE_ID,
    companyId: COMPANY_ID,
    projectId: null,
    parentId: null,
    status: "in_progress",
    assigneeAgentId: ACTOR_AGENT_ID,
    assigneeUserId: null,
    createdByAgentId: ACTOR_AGENT_ID,
    originKind: null,
    originId: null,
    checkoutRunId: null,
    executionRunId: null,
    ...overrides,
  };
}

const createBody = (issueIds: string[]) => ({
  type: "request_board_approval",
  issueIds,
  payload: { title: "Escalation" },
});

/** Denies the peer issues, allows everything else — the ordinary boundary shape. */
function decideByAssignee() {
  mockAccessService.decide.mockImplementation(async (input: any) => {
    if (input.action === "tasks:manage_active_checkouts") {
      return { allowed: false, action: input.action, reason: "deny_missing_grant", explanation: "" };
    }
    if (input.action === "company_scope:read") {
      return { allowed: true, action: input.action, reason: "allow_explicit_grant", explanation: "" };
    }
    const assignee = input.resource?.assigneeAgentId;
    if (assignee && assignee !== ACTOR_AGENT_ID) {
      return { allowed: false, action: input.action, reason: "deny_missing_grant", explanation: "" };
    }
    return { allowed: true, action: input.action, reason: "allow_assignee", explanation: "" };
  });
}

/**
 * Clears the boundary with a plain grant, so the evaluator reaches the
 * assignee-mismatch branch instead of short-circuiting on `!decision.allowed`.
 * This is the only way to reach the 409 checkout-conflict verdict: a boundary
 * refusal is permanent, so it is a 403 and never a conflict.
 */
function decideAllowingBoundary() {
  mockAccessService.decide.mockImplementation(async (input: any) => {
    if (input.action === "tasks:manage_active_checkouts") {
      return { allowed: false, action: input.action, reason: "deny_missing_grant", explanation: "" };
    }
    return { allowed: true, action: input.action, reason: "allow_explicit_grant", explanation: "" };
  });
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  registerModuleMocks();
  mockApprovalService.createWithIdempotency.mockImplementation(async (_companyId: string, input: any, hooks: any) => {
    const approval = { id: "approval-1", companyId: COMPANY_ID, type: input.type, payload: input.payload, createdAt: new Date() };
    await hooks?.afterCreate?.({}, approval);
    return { approval, deduplicated: false };
  });
  mockLogActivity.mockResolvedValue(() => {});
  mockIssueService.getById.mockResolvedValue(null);
  mockTaskWatchdogService.revalidateMutationScope.mockResolvedValue({
    allowed: true,
    classification: { state: "stopped", stopFingerprint: STOP_FINGERPRINT },
  });
  decideByAssignee();
});

describe("POST /companies/:companyId/approvals — issueIds authorization (BLO-23763)", () => {
  it("refuses an issueIds entry the acting agent is not authorized on, naming the refused id", async () => {
    mockIssueService.getById.mockImplementation(async (id: string) =>
      id === PEER_ISSUE_ID
        ? makeIssue({ id: PEER_ISSUE_ID, assigneeAgentId: PEER_AGENT_ID, createdByAgentId: PEER_AGENT_ID, status: "todo" })
        : null,
    );

    const res = await request(await createApp(agentActor()))
      .post(`/api/companies/${COMPANY_ID}/approvals`)
      .send(createBody([PEER_ISSUE_ID]));

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toContain(PEER_ISSUE_ID);
    expect(res.body.details.refusedIssueIds).toEqual([PEER_ISSUE_ID]);
    // The approval must not exist at all — refusing the link but keeping the card
    // would leave an unattributed approval behind.
    expect(mockApprovalService.createWithIdempotency).not.toHaveBeenCalled();
    expect(mockIssueApprovalService.linkManyForApproval).not.toHaveBeenCalled();
  });

  it("names every refused id, not just the first", async () => {
    mockIssueService.getById.mockImplementation(async (id: string) =>
      id === OWN_ISSUE_ID
        ? makeIssue()
        : makeIssue({ id, assigneeAgentId: PEER_AGENT_ID, createdByAgentId: PEER_AGENT_ID, status: "todo" }),
    );

    const res = await request(await createApp(agentActor()))
      .post(`/api/companies/${COMPANY_ID}/approvals`)
      .send(createBody([PEER_ISSUE_ID, OWN_ISSUE_ID, OTHER_PEER_ISSUE_ID]));

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.details.refusedIssueIds).toEqual([PEER_ISSUE_ID, OTHER_PEER_ISSUE_ID]);
  });

  it("allows an agent that is authorized on the issue", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue());

    const res = await request(await createApp(agentActor()))
      .post(`/api/companies/${COMPANY_ID}/approvals`)
      .send(createBody([OWN_ISSUE_ID]));

    expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
    expect(mockIssueApprovalService.linkManyForApproval).toHaveBeenCalledWith(
      "approval-1",
      [OWN_ISSUE_ID],
      { agentId: ACTOR_AGENT_ID, userId: null },
    );
  });

  it("allows the run that currently owns the issue's execution even when the boundary would deny", async () => {
    // Mirrors `isCurrentIssueExecutionRun`, which short-circuits ahead of the
    // boundary decision on both entry points.
    mockAccessService.decide.mockImplementation(async (input: any) => ({
      allowed: input.action === "company_scope:read",
      action: input.action,
      reason: input.action === "company_scope:read" ? "allow_explicit_grant" : "deny_missing_grant",
      explanation: "",
    }));
    mockIssueService.getById.mockResolvedValue(
      makeIssue({ assigneeAgentId: PEER_AGENT_ID, executionRunId: "run-1" }),
    );

    const res = await request(await createApp(agentActor()))
      .post(`/api/companies/${COMPANY_ID}/approvals`)
      .send(createBody([OWN_ISSUE_ID]));

    expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
  });

  it("keeps the productivity-review escalation working: the reviewer may link the issue under review", async () => {
    // AC #4. `agentHasProductivityReviewGrantOnIssue` returns this reason for the
    // reviewed source issue; without honouring it, a review whose verdict is
    // "block with an unblock owner" could state a gate it cannot escalate
    // (BLO-23036).
    mockAccessService.decide.mockImplementation(async (input: any) => {
      if (input.action === "tasks:manage_active_checkouts") {
        return { allowed: false, action: input.action, reason: "deny_missing_grant", explanation: "" };
      }
      if (input.action === "company_scope:read") {
        return { allowed: true, action: input.action, reason: "allow_explicit_grant", explanation: "" };
      }
      return { allowed: true, action: input.action, reason: "allow_productivity_review_grant", explanation: "" };
    });
    mockIssueService.getById.mockResolvedValue(
      makeIssue({ id: REVIEWED_ISSUE_ID, assigneeAgentId: PEER_AGENT_ID, createdByAgentId: PEER_AGENT_ID }),
    );

    const res = await request(await createApp(agentActor()))
      .post(`/api/companies/${COMPANY_ID}/approvals`)
      .send(createBody([REVIEWED_ISSUE_ID]));

    expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
    expect(mockIssueApprovalService.linkManyForApproval).toHaveBeenCalled();
  });

  it("returns 409, not 403, when the only refusal is another agent's active checkout", async () => {
    // The evaluator distinguishes a retryable checkout conflict from a permanent
    // boundary refusal, matching the contract `assertAgentIssueMutationAllowed`
    // establishes on `POST /issues/:id/approvals`. Collapsing it to 403 would tell
    // the caller its request can never succeed when it succeeds once the other
    // agent's checkout ends.
    decideAllowingBoundary();
    mockIssueService.getById.mockResolvedValue(
      makeIssue({ id: PEER_ISSUE_ID, assigneeAgentId: PEER_AGENT_ID, status: "in_progress" }),
    );

    const res = await request(await createApp(agentActor()))
      .post(`/api/companies/${COMPANY_ID}/approvals`)
      .send(createBody([PEER_ISSUE_ID]));

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error).toContain(PEER_ISSUE_ID);
    expect(res.body.details.refusals[0]).toMatchObject({
      issueId: PEER_ISSUE_ID,
      status: 409,
      reason: "deny_active_checkout",
      boundary: "checkout",
    });
    expect(mockApprovalService.createWithIdempotency).not.toHaveBeenCalled();
  });

  it("takes the stricter 403 when a set mixes a checkout conflict with a boundary refusal", async () => {
    // "Retry this" is only true if every refusal clears on its own, and a set
    // containing one permanent refusal never does. Per-entry `status` still lets a
    // caller splitting the batch see which id was merely conflicting.
    decideAllowingBoundary();
    mockIssueService.getById.mockImplementation(async (id: string) =>
      id === PEER_ISSUE_ID
        ? makeIssue({ id: PEER_ISSUE_ID, assigneeAgentId: PEER_AGENT_ID, status: "in_progress" })
        : makeIssue({ id, assigneeAgentId: PEER_AGENT_ID, createdByAgentId: PEER_AGENT_ID, status: "todo" }),
    );

    const res = await request(await createApp(agentActor()))
      .post(`/api/companies/${COMPANY_ID}/approvals`)
      .send(createBody([PEER_ISSUE_ID, OTHER_PEER_ISSUE_ID]));

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.details.refusedIssueIds).toEqual([PEER_ISSUE_ID, OTHER_PEER_ISSUE_ID]);
    expect(res.body.details.refusals.map((refusal: { status: number }) => refusal.status)).toEqual([
      409, 403,
    ]);
  });

  it("refuses a creator/manager-chain grant, which is comment-only", async () => {
    mockAccessService.decide.mockImplementation(async (input: any) => {
      if (input.action === "company_scope:read") {
        return { allowed: true, action: input.action, reason: "allow_explicit_grant", explanation: "" };
      }
      if (input.action === "tasks:manage_active_checkouts") {
        return { allowed: false, action: input.action, reason: "deny_missing_grant", explanation: "" };
      }
      return { allowed: true, action: input.action, reason: "allow_manager_chain", explanation: "" };
    });
    mockIssueService.getById.mockResolvedValue(
      makeIssue({ id: PEER_ISSUE_ID, assigneeAgentId: PEER_AGENT_ID, status: "todo" }),
    );

    const res = await request(await createApp(agentActor()))
      .post(`/api/companies/${COMPANY_ID}/approvals`)
      .send(createBody([PEER_ISSUE_ID]));

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.details.refusedIssueIds).toEqual([PEER_ISSUE_ID]);
  });

  it("leaves board actors unaffected", async () => {
    // AC #3. A board user may link any issue in the company; the guard must not
    // even load the issues for a non-agent actor.
    mockIssueService.getById.mockResolvedValue(
      makeIssue({ id: PEER_ISSUE_ID, assigneeAgentId: PEER_AGENT_ID }),
    );

    const res = await request(await createApp(boardActor()))
      .post(`/api/companies/${COMPANY_ID}/approvals`)
      .send(createBody([PEER_ISSUE_ID]));

    expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
    expect(mockIssueService.getById).not.toHaveBeenCalled();
  });

  it("leaves unknown and cross-company ids to linkManyForApproval rather than masking them as 403", async () => {
    // Existence and tenancy are not authorization questions, and the service
    // already rejects both (404 / 422). Turning them into a 403 here would tell a
    // caller "you are not authorized on this" about an id that does not exist.
    mockIssueService.getById.mockImplementation(async (id: string) =>
      id === PEER_ISSUE_ID ? makeIssue({ id: PEER_ISSUE_ID, companyId: "company-2" }) : null,
    );

    const res = await request(await createApp(agentActor()))
      .post(`/api/companies/${COMPANY_ID}/approvals`)
      .send(createBody([PEER_ISSUE_ID, OTHER_PEER_ISSUE_ID]));

    expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
    expect(mockIssueApprovalService.linkManyForApproval).toHaveBeenCalled();
  });
});

/**
 * PR #1271 review: the evaluator reproduced the watchdog *subtree* gate but not
 * the *freshness* gate, so a watchdog run whose watched subtree had come back to
 * life could still attach an approval here while `POST /issues/:id/approvals`
 * refused it with a 409. These fail without the freshness half.
 */
describe("POST /companies/:companyId/approvals — task-watchdog freshness (BLO-23763)", () => {
  const staleRevalidation = {
    allowed: false,
    reason: "Task-watchdog review is stale because the watched subtree now has a live, waiting, already-reviewed, or not-applicable path; refresh the source state before mutating it.",
    classification: { state: "live", stopFingerprint: null },
  };

  it("refuses with 409 when the watchdog source is no longer stopped", async () => {
    mockTaskWatchdogService.revalidateMutationScope.mockResolvedValue(staleRevalidation);
    mockIssueService.getById.mockResolvedValue(
      makeIssue({ id: PEER_ISSUE_ID, assigneeAgentId: PEER_AGENT_ID, createdByAgentId: PEER_AGENT_ID, status: "todo" }),
    );

    const res = await request(await createApp(agentActor(), watchdogContext(PEER_ISSUE_ID)))
      .post(`/api/companies/${COMPANY_ID}/approvals`)
      .send(createBody([PEER_ISSUE_ID]));

    // 409, not the 403 the ordinary boundary would give this actor on a peer's
    // issue: staleness is resolved before the boundary, exactly as the link
    // route orders it.
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.details.refusedIssueIds).toEqual([PEER_ISSUE_ID]);
    expect(mockApprovalService.createWithIdempotency).not.toHaveBeenCalled();
    expect(mockIssueApprovalService.linkManyForApproval).not.toHaveBeenCalled();
  });

  it("allows a live watchdog run whose source is still stopped", async () => {
    // The control: proves the 409 above comes from revalidation and not from the
    // watchdog run being refused outright.
    mockIssueService.getById.mockResolvedValue(makeIssue({ id: PEER_ISSUE_ID }));

    const res = await request(await createApp(agentActor(), watchdogContext(PEER_ISSUE_ID)))
      .post(`/api/companies/${COMPANY_ID}/approvals`)
      .send(createBody([PEER_ISSUE_ID]));

    expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
    expect(mockTaskWatchdogService.revalidateMutationScope).toHaveBeenCalled();
  });

  it("exempts the watchdog's own report issue from revalidation", async () => {
    // Mirrors the `scope.watchdogIssueId` exemption in
    // `assertFreshTaskWatchdogSourceMutation`: a watchdog may always annotate the
    // issue it was created to write, even once its source has moved on.
    mockTaskWatchdogService.revalidateMutationScope.mockResolvedValue(staleRevalidation);
    mockIssueService.getById.mockResolvedValue(makeIssue({ id: WATCHDOG_ISSUE_ID }));

    const res = await request(await createApp(agentActor(), watchdogContext(PEER_ISSUE_ID)))
      .post(`/api/companies/${COMPANY_ID}/approvals`)
      .send(createBody([WATCHDOG_ISSUE_ID]));

    expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
    expect(mockTaskWatchdogService.revalidateMutationScope).not.toHaveBeenCalled();
  });
});
