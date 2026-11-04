import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IssueApprovalLinkSubject } from "../routes/issue-approval-link-authorization.js";

/**
 * PEN-5511: a board card filed by a non-assignee could never be linked to the row
 * it is about, so `paperclipListApprovals(issueId=…)` silently undercounted every
 * multi-agent incident.
 *
 * Linking authorized on relations that answer "what is this actor to the ISSUE" —
 * `[assignee, unassigned_issue, productivity_review]` — and none that answer "this
 * actor filed the card". So on any row worked by agent A, a card filed by agent B
 * was unlinkable by B, the one party that knows the card exists at filing time.
 * The issue-scoped approval query reads only LINKED cards, so those rows
 * under-report, in the direction that understates board exposure. Measured on
 * PEN-5379: three returned against four standing asks, with no marker saying so.
 *
 * `requested_by_self` admits exactly one new relation: the actor filed this card
 * AND the actor is a participant in this row (`issue:comment`). Both halves are
 * pinned here, in both directions:
 *
 *  - the allow case fails against 0e757f4 with 403 `deny_missing_grant`;
 *  - the three refusal cases PASS against 0e757f4 and must keep passing, because
 *    they are what stops this becoming "any company member may link any card to any
 *    row" — which PEN-5511 explicitly asks to be rejected.
 *
 * Every case was mutation-controlled: disabling the override, dropping either half
 * of the relation, or widening the overridable reason set each turns exactly the
 * corresponding case red.
 *
 * ## Why this is a separate file from `approval-link-route-equivalence.test.ts`
 *
 * Same harness, same reason it exists — the verdict has to be observed at BOTH
 * doors over one app, and `routes/issues.ts` alone is ~13k lines re-imported per
 * test by `vi.resetModules()`. Appending these cases to that file pushed it past
 * what a 8 GiB container can run in one process (the worker died with "Failed to
 * reserve virtual memory for CodeRange" partway through). Splitting keeps each file
 * inside the budget; the duplicated harness is the cost of that.
 */
/**
 * `vi.resetModules()` per test means every case re-imports both route modules;
 * `routes/issues.ts` alone is ~13k lines. Cold CI caches make that import, not the
 * assertions, the dominant cost.
 */
const ROUTE_IMPORT_TIMEOUT_MS = 120_000;

const COMPANY_ID = "company-1";
const ACTOR_AGENT_ID = "agent-1";
const PEER_AGENT_ID = "agent-2";
const OWN_ISSUE_ID = "11111111-1111-4111-8111-111111111111";
const PEER_ISSUE_ID = "22222222-2222-4222-8222-222222222222";
const APPROVAL_ID = "99999999-9999-4999-8999-999999999999";

const mockAccessService = vi.hoisted(() => ({ decide: vi.fn(), getMembership: vi.fn(), listPrincipalGrants: vi.fn() }));
const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  // The unlink route still runs `assertAgentIssueMutationAllowed`, whose
  // `in_progress` path ends here. Clean ownership, so the request reaches the
  // privileged gate under test rather than stopping at the checkout boundary.
  assertCheckoutOwner: vi.fn(async () => ({ checkoutRunId: "run-1", executionRunId: "run-1", adoptedFromRunId: null })),
}));
const mockAgentService = vi.hoisted(() => ({ getById: vi.fn() }));
const mockIssueApprovalService = vi.hoisted(() => ({
  link: vi.fn(),
  unlink: vi.fn(),
  listApprovalsForIssue: vi.fn(),
  // PEN-5511: the link route reads the card's requester to decide the
  // `requested_by_self` relation. `null` is the no-subject case, i.e. exactly
  // the pre-PEN-5511 verdict, so existing cases are unaffected.
  getApprovalLinkSubject: vi.fn(
    async (_approvalId: string): Promise<IssueApprovalLinkSubject | null> => null,
  ),
  listIssuesForApproval: vi.fn(),
  linkManyForApproval: vi.fn(),
}));
const mockApprovalService = vi.hoisted(() => ({
  getById: vi.fn(),
  createWithIdempotency: vi.fn(),
}));
const mockSecretService = vi.hoisted(() => ({
  normalizeHireApprovalPayloadForPersistence: vi.fn(),
}));
const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
}));
const mockLogActivity = vi.hoisted(() => vi.fn());

/**
 * The union of what `issueRoutes` and `approvalRoutes` each pull from
 * `../services/index.js`. Neither router's existing test harness is sufficient on
 * its own — that incompatibility is why this equivalence signal did not exist
 * before.
 */
function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    // Shared by both routers.
    accessService: () => mockAccessService,
    heartbeatService: () => mockHeartbeatService,
    issueApprovalService: () => mockIssueApprovalService,
    issueService: () => mockIssueService,
    logActivity: mockLogActivity,
    // approvalRoutes only.
    approvalService: () => mockApprovalService,
    secretService: () => mockSecretService,
    // issueRoutes only.
    agentService: () => mockAgentService,
    companyService: () => ({ getById: vi.fn(async () => ({ id: COMPANY_ID })) }),
    companySkillService: () => ({}),
    documentService: () => ({}),
    documentAnnotationService: () => ({}),
    executionWorkspaceService: () => ({}),
    goalService: () => ({}),
    instanceSettingsService: () => ({ getGeneral: vi.fn(async () => ({ censorUsernameInLogs: false })) }),
    issueRecoveryActionService: () => ({
      listActiveForIssues: vi.fn(async () => new Map()),
      getActiveForIssue: vi.fn(async () => null),
    }),
    issueReferenceService: () => ({
      emptySummary: () => ({}),
      diffIssueReferenceSummary: () => ({}),
      listIssueReferenceSummary: vi.fn(async () => ({})),
      syncIssueReferences: vi.fn(async () => undefined),
      syncCommentReferences: vi.fn(async () => undefined),
    }),
    issueThreadInteractionService: () => ({ listForIssue: vi.fn(async () => []) }),
    projectService: () => ({}),
    routineService: () => ({ syncRunStatusForIssue: vi.fn(async () => undefined) }),
    workProductService: () => ({}),
    clampIssueListLimit: (n: number) => Math.min(1000, Math.max(1, Math.floor(n))),
    ISSUE_LIST_DEFAULT_LIMIT: 500,
    ISSUE_LIST_MAX_LIMIT: 1000,
  }));
}

/**
 * Selection-aware, because the only direct `db` reads on these paths are the
 * `heartbeatRuns` lookup in `assertApprovalMutationAllowedByRunContext` (keyed on
 * a selection containing `contextSnapshot`) and an agent-permissions probe.
 */
function createRouteDb(runId = "run-1") {
  const runRows = [{ id: runId, companyId: COMPANY_ID, agentId: ACTOR_AGENT_ID, contextSnapshot: {} }];
  return {
    select: vi.fn((selection: Record<string, unknown> = {}) => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          then: async (resolve: (rows: unknown[]) => unknown) =>
            resolve(
              Object.keys(selection).includes("contextSnapshot")
                ? runRows
                : [{ companyId: COMPANY_ID, permissions: null }],
            ),
        })),
      })),
    })),
  } as any;
}

/** Both routers over one app — the whole point of this file. */
async function createApp(actor: Record<string, unknown>) {
  const [{ errorHandler }, { issueRoutes }, { approvalRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/issues.js"),
    import("../routes/approvals.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  const db = createRouteDb();
  app.use("/api", issueRoutes(db, {} as any));
  app.use("/api", approvalRoutes(db));
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

/** Allows the actor's own issue, denies a peer's — the ordinary boundary shape. */
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

/** Attach the same approval to the same issue through each door in turn. */
async function attachViaLinkRoute(actor: Record<string, unknown>, issueId: string) {
  return request(await createApp(actor))
    .post(`/api/issues/${issueId}/approvals`)
    .send({ approvalId: APPROVAL_ID });
}

async function attachViaCreateRoute(actor: Record<string, unknown>, issueId: string) {
  return request(await createApp(actor))
    .post(`/api/companies/${COMPANY_ID}/approvals`)
    .send({ type: "request_board_approval", issueIds: [issueId], payload: { title: "Escalation" } });
}

/** 2xx vs the refusal status — the verdict, independent of each route's success shape. */
const verdictOf = (status: number) => (status >= 200 && status < 300 ? "allow" : status);

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  for (const specifier of [
    "../services/index.js",
    "../routes/issues.js",
    "../routes/approvals.js",
    "../routes/authz.js",
    "../middleware/index.js",
  ]) {
    vi.doUnmock(specifier);
  }
  registerModuleMocks();

  mockApprovalService.createWithIdempotency.mockImplementation(
    async (_companyId: string, input: any, hooks: any) => {
      const approval = {
        id: APPROVAL_ID,
        companyId: COMPANY_ID,
        type: input.type,
        payload: input.payload,
        createdAt: new Date(),
      };
      await hooks?.afterCreate?.({}, approval);
      return { approval, deduplicated: false };
    },
  );
  mockApprovalService.getById.mockResolvedValue({ id: APPROVAL_ID, companyId: COMPANY_ID });
  mockIssueApprovalService.listApprovalsForIssue.mockResolvedValue([]);
  // `vi.clearAllMocks()` clears calls but NOT implementations, so a
  // `mockResolvedValue` set by one case would leak into every later one. Reset to
  // the no-subject default, which is the pre-PEN-5511 verdict.
  mockIssueApprovalService.getApprovalLinkSubject.mockResolvedValue(null);
  mockIssueApprovalService.link.mockResolvedValue(undefined);
  mockLogActivity.mockResolvedValue(() => {});
  mockIssueService.getById.mockResolvedValue(null);
  // The roster majority: not CEO, no `canCreateAgents`. This is the agent the old
  // link-route gate refused and the create route admitted.
  mockAgentService.getById.mockResolvedValue({
    id: ACTOR_AGENT_ID,
    companyId: COMPANY_ID,
    role: "agent",
    permissions: { canCreateAgents: false },
  });
  decideByAssignee();
});

/**
 * PEN-5511. The defect: linking authorized on relations that answer "what is this
 * actor to the ISSUE" and none that answer "this actor filed the card". So on any
 * row worked by agent A, a card filed by agent B was unlinkable by B — the one
 * party that knows the card exists. `paperclipListApprovals(issueId=…)` returns
 * only linked cards, so those rows under-report, in the direction that understates
 * board exposure. Measured on PEN-5379: 3 returned against 4 standing asks.
 *
 * These cases pin both halves of the relation. The allow case fails against
 * 0e757f4 with 403 `deny_missing_grant`; the two refusal cases pass there and must
 * keep passing, because they are what stops this from becoming "any company member
 * may link any card to any row" — which PEN-5511 explicitly asks to be rejected.
 */
describe("the requested_by_self relation (PEN-5511)", () => {
  /** Filer is a participant in the row (`issue:comment`) but not its assignee. */
  function decideParticipantButNotAssignee() {
    mockAccessService.decide.mockImplementation(async (input: any) => {
      if (input.action === "company_scope:read") {
        return { allowed: true, action: input.action, reason: "allow_explicit_grant", explanation: "" };
      }
      // The eight-relation set: a manager of the assignee, a mentioned seat, a
      // blocker edge. `issue:mutate` stays denied — that is the whole shape of
      // the cross-seat escalation this relation exists for.
      if (input.action === "issue:comment") {
        return { allowed: true, action: input.action, reason: "allow_manager_of_assignee", explanation: "" };
      }
      return { allowed: false, action: input.action, reason: "deny_missing_grant", explanation: "" };
    });
  }

  beforeEach(() => {
    mockIssueService.getById.mockImplementation(async (id: string) =>
      id === PEER_ISSUE_ID
        ? makeIssue({
            id: PEER_ISSUE_ID,
            assigneeAgentId: PEER_AGENT_ID,
            createdByAgentId: PEER_AGENT_ID,
            status: "todo",
          })
        : null,
    );
  });

  it("lets the filer attach its OWN card to a peer's issue through EITHER door", async () => {
    decideParticipantButNotAssignee();
    // The link door reads the card's requester; the create door derives it from
    // the authenticated actor. Both must reach the same verdict.
    mockIssueApprovalService.getApprovalLinkSubject.mockResolvedValue({
      approvalId: APPROVAL_ID,
      companyId: COMPANY_ID,
      requestedByAgentId: ACTOR_AGENT_ID,
    });

    const link = await attachViaLinkRoute(agentActor(), PEER_ISSUE_ID);
    const create = await attachViaCreateRoute(agentActor(), PEER_ISSUE_ID);

    expect(verdictOf(link.status), JSON.stringify(link.body)).toBe("allow");
    expect(verdictOf(create.status), JSON.stringify(create.body)).toBe("allow");
    // Not merely the right status: the row that makes the card countable on the
    // issue has to actually be written, since the undercount is the defect.
    expect(mockIssueApprovalService.link).toHaveBeenCalled();
    expect(mockIssueApprovalService.linkManyForApproval).toHaveBeenCalled();
  }, ROUTE_IMPORT_TIMEOUT_MS);

  it("still refuses the filer on a row it has NO relation to, at BOTH doors", async () => {
    // The BLO-23763 boundary, which this relation must not reopen. "I filed it"
    // is free at the create doors — every actor is the filer of the card it is
    // creating — so participation is what keeps this least-privilege.
    mockAccessService.decide.mockImplementation(async (input: any) => {
      if (input.action === "company_scope:read") {
        return { allowed: true, action: input.action, reason: "allow_explicit_grant", explanation: "" };
      }
      return { allowed: false, action: input.action, reason: "deny_missing_grant", explanation: "" };
    });
    mockIssueApprovalService.getApprovalLinkSubject.mockResolvedValue({
      approvalId: APPROVAL_ID,
      companyId: COMPANY_ID,
      requestedByAgentId: ACTOR_AGENT_ID,
    });

    const link = await attachViaLinkRoute(agentActor(), PEER_ISSUE_ID);
    const create = await attachViaCreateRoute(agentActor(), PEER_ISSUE_ID);

    expect(verdictOf(link.status), JSON.stringify(link.body)).toBe(403);
    expect(verdictOf(create.status), JSON.stringify(create.body)).toBe(403);
    expect(mockIssueApprovalService.link).not.toHaveBeenCalled();
    expect(mockIssueApprovalService.linkManyForApproval).not.toHaveBeenCalled();
  }, ROUTE_IMPORT_TIMEOUT_MS);

  it("refuses a participant attaching SOMEONE ELSE'S card at the link door", async () => {
    // Participation alone is not the relation. Without this an agent that may
    // comment on a row could attach any approval id in the company to it, which
    // is the arbitrary-card attach BLO-24699 kept shut.
    decideParticipantButNotAssignee();
    mockIssueApprovalService.getApprovalLinkSubject.mockResolvedValue({
      approvalId: APPROVAL_ID,
      companyId: COMPANY_ID,
      requestedByAgentId: PEER_AGENT_ID,
    });

    const link = await attachViaLinkRoute(agentActor(), PEER_ISSUE_ID);

    expect(verdictOf(link.status), JSON.stringify(link.body)).toBe(403);
    expect(mockIssueApprovalService.link).not.toHaveBeenCalled();
  }, ROUTE_IMPORT_TIMEOUT_MS);

  it("keeps the comment-only creator/manager-chain narrowing for a THIRD-PARTY card", async () => {
    // BLO-18113 / BLO-18797 made creator and manager-chain grants comment-only, and
    // the evaluator narrows them rather than letting them carry a link. PEN-5511
    // makes that narrowing unreachable for an actor attaching a card IT FILED — see
    // the note in `approval-create-issue-link-authorization.test.ts` for why that is
    // the coherent outcome. This pins the half that survives: the same grant, on a
    // card the actor did not file, is refused exactly as before.
    mockAccessService.decide.mockImplementation(async (input: any) => {
      if (input.action === "company_scope:read") {
        return { allowed: true, action: input.action, reason: "allow_explicit_grant", explanation: "" };
      }
      if (input.action === "tasks:manage_active_checkouts") {
        return { allowed: false, action: input.action, reason: "deny_missing_grant", explanation: "" };
      }
      return { allowed: true, action: input.action, reason: "allow_manager_chain", explanation: "" };
    });
    mockIssueApprovalService.getApprovalLinkSubject.mockResolvedValue({
      approvalId: APPROVAL_ID,
      companyId: COMPANY_ID,
      requestedByAgentId: PEER_AGENT_ID,
    });

    const link = await attachViaLinkRoute(agentActor(), PEER_ISSUE_ID);

    expect(verdictOf(link.status), JSON.stringify(link.body)).toBe(403);
    expect(link.body.error).toBe(
      "Agent cannot link approvals to another agent's issue outside delegate recovery",
    );
    expect(mockIssueApprovalService.link).not.toHaveBeenCalled();
  }, ROUTE_IMPORT_TIMEOUT_MS);

  it("keeps a hard trust-boundary denial terminal for the filer", async () => {
    // Only the "no relation to this issue" refusals are overridable. A scope,
    // trust, tenancy or membership denial must not be reachable through a card
    // the actor happens to have filed.
    mockAccessService.decide.mockImplementation(async (input: any) => {
      if (input.action === "company_scope:read") {
        return { allowed: true, action: input.action, reason: "allow_explicit_grant", explanation: "" };
      }
      if (input.action === "issue:comment") {
        return { allowed: true, action: input.action, reason: "allow_manager_of_assignee", explanation: "" };
      }
      return { allowed: false, action: input.action, reason: "deny_low_trust_boundary", explanation: "" };
    });
    mockIssueApprovalService.getApprovalLinkSubject.mockResolvedValue({
      approvalId: APPROVAL_ID,
      companyId: COMPANY_ID,
      requestedByAgentId: ACTOR_AGENT_ID,
    });

    const link = await attachViaLinkRoute(agentActor(), PEER_ISSUE_ID);
    const create = await attachViaCreateRoute(agentActor(), PEER_ISSUE_ID);

    expect(verdictOf(link.status), JSON.stringify(link.body)).toBe(403);
    expect(verdictOf(create.status), JSON.stringify(create.body)).toBe(403);
    expect(link.body.details?.boundary).toBe("trust-boundary");
    expect(mockIssueApprovalService.link).not.toHaveBeenCalled();
    expect(mockIssueApprovalService.linkManyForApproval).not.toHaveBeenCalled();
  }, ROUTE_IMPORT_TIMEOUT_MS);
});
