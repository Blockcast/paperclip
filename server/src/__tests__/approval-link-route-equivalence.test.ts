import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * BLO-24699: the two doors to a row in `issue_approvals` must reach the same
 * allow/deny verdict for the same (actor, issue) pair.
 *
 * BLO-23763 / PR #1271 gave `POST /companies/:companyId/approvals` an issue-scoped
 * boundary, but left `POST /issues/:id/approvals` additionally gated by
 * `assertCanManageIssueApprovalLinks` — a company-scoped
 * `role === "ceo" || permissions.canCreateAgents` check that never looks at the
 * issue. On this company's roster that gate admits 2 of 16 agents on the link route
 * while excluding none of the other 14 from the create route, so the "boundary" was
 * really just a question of which door an agent picked. BLO-24699 resolved that by
 * relaxing the link route onto the shared evaluator rather than by copying the
 * privileged gate onto create, which would have broken the BLO-23036 escalation
 * path for those 14 agents.
 *
 * BLO-23763 declared it could not deliver this signal because it needs both routers
 * mounted in one harness. That is what this file is: the union of the two routers'
 * service mocks over one app, so a divergence between the doors fails a test rather
 * than surviving as prose.
 *
 * The equivalence cases fail against PR #1271's head: the link route returns 403
 * `Missing permission to link approvals` where create returns 201.
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

describe("approval-link authorization is the same at both doors (BLO-24699)", () => {
  it("allows an unprivileged agent to attach an approval to its own issue through EITHER door", async () => {
    mockIssueService.getById.mockImplementation(async (id: string) =>
      id === OWN_ISSUE_ID ? makeIssue() : null,
    );

    const link = await attachViaLinkRoute(agentActor(), OWN_ISSUE_ID);
    const create = await attachViaCreateRoute(agentActor(), OWN_ISSUE_ID);

    // Pins the decision against option 3 (copying the privileged gate onto create):
    // an agent with `canCreateAgents: false` must keep the BLO-23036 escalation path.
    expect(verdictOf(create.status), JSON.stringify(create.body)).toBe("allow");
    // Fails on PR #1271's head, where `assertCanManageIssueApprovalLinks` 403s here.
    expect(verdictOf(link.status), JSON.stringify(link.body)).toBe("allow");
    expect(verdictOf(link.status)).toBe(verdictOf(create.status));
  }, ROUTE_IMPORT_TIMEOUT_MS);

  it("refuses an unprivileged agent on a peer's issue through EITHER door", async () => {
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

    const link = await attachViaLinkRoute(agentActor(), PEER_ISSUE_ID);
    const create = await attachViaCreateRoute(agentActor(), PEER_ISSUE_ID);

    expect(verdictOf(link.status), JSON.stringify(link.body)).toBe(403);
    expect(verdictOf(create.status), JSON.stringify(create.body)).toBe(403);
    expect(verdictOf(link.status)).toBe(verdictOf(create.status));
  }, ROUTE_IMPORT_TIMEOUT_MS);

  it("reports a peer's in_progress checkout as the same retryable 409 at both doors", async () => {
    // A plain grant clears the boundary so the evaluator reaches the assignee
    // mismatch rather than short-circuiting on a permanent refusal.
    mockAccessService.decide.mockImplementation(async (input: any) => {
      if (input.action === "tasks:manage_active_checkouts") {
        return { allowed: false, action: input.action, reason: "deny_missing_grant", explanation: "" };
      }
      return { allowed: true, action: input.action, reason: "allow_explicit_grant", explanation: "" };
    });
    mockIssueService.getById.mockImplementation(async (id: string) =>
      id === PEER_ISSUE_ID
        ? makeIssue({
            id: PEER_ISSUE_ID,
            assigneeAgentId: PEER_AGENT_ID,
            createdByAgentId: PEER_AGENT_ID,
            status: "in_progress",
          })
        : null,
    );

    const link = await attachViaLinkRoute(agentActor(), PEER_ISSUE_ID);
    const create = await attachViaCreateRoute(agentActor(), PEER_ISSUE_ID);

    expect(verdictOf(link.status), JSON.stringify(link.body)).toBe(409);
    expect(verdictOf(create.status), JSON.stringify(create.body)).toBe(409);
    expect(verdictOf(link.status)).toBe(verdictOf(create.status));
  }, ROUTE_IMPORT_TIMEOUT_MS);

  it("refuses an own-issue actor denied company_scope:read through EITHER door", async () => {
    // The gap Ally found in review of PR #1293: relaxing the link route onto the
    // issue-scoped evaluator dropped the *approval*-side check that create has
    // always run, so the doors were equivalent only for actors holding both.
    // `authorization.ts` denies `company_scope:read` outright to task-bridge keys,
    // skill-test run tokens, and low-trust-preset agents while still allowing
    // `issue:mutate` on their own issue — exactly this actor. Since
    // `GET /issues/:id/approvals` returns linked approvals to anyone who can read
    // the issue, an allow here would let such an actor attach a guessed approval id
    // to its own issue and read the row back: an approval-read bypass, not a link.
    //
    // Fails against 51b6297 with `expected 'allow' to be 403` on the link door —
    // the create door already refused, which is what made it a divergence.
    mockAccessService.decide.mockImplementation(async (input: any) => {
      if (input.action === "company_scope:read") {
        return { allowed: false, action: input.action, reason: "deny_scope", explanation: "" };
      }
      if (input.action === "tasks:manage_active_checkouts") {
        return { allowed: false, action: input.action, reason: "deny_missing_grant", explanation: "" };
      }
      return { allowed: true, action: input.action, reason: "allow_assignee", explanation: "" };
    });
    mockIssueService.getById.mockImplementation(async (id: string) =>
      id === OWN_ISSUE_ID ? makeIssue() : null,
    );

    const link = await attachViaLinkRoute(agentActor(), OWN_ISSUE_ID);
    const create = await attachViaCreateRoute(agentActor(), OWN_ISSUE_ID);

    expect(verdictOf(link.status), JSON.stringify(link.body)).toBe(403);
    expect(verdictOf(create.status), JSON.stringify(create.body)).toBe(403);
    expect(verdictOf(link.status)).toBe(verdictOf(create.status));
    // Not merely the right status: no `issue_approvals` row may exist afterwards,
    // since the row is what makes the approval readable via the issue.
    expect(mockIssueApprovalService.link).not.toHaveBeenCalled();
    expect(mockIssueApprovalService.linkManyForApproval).not.toHaveBeenCalled();
    // Both doors must refuse for the *approval* reason, not incidentally on the
    // issue boundary — otherwise this passes for the wrong reason if the issue-side
    // check ever tightens.
    expect(link.body.error).toBe("Approvals are outside this actor's authorization boundary");
    expect(create.body.error).toBe(link.body.error);
  }, ROUTE_IMPORT_TIMEOUT_MS);

  it("keeps the privileged gate on unlink, which has no second door to agree with", async () => {
    mockIssueService.getById.mockImplementation(async (id: string) =>
      id === OWN_ISSUE_ID ? makeIssue() : null,
    );

    const res = await request(await createApp(agentActor())).delete(
      `/api/issues/${OWN_ISSUE_ID}/approvals/${APPROVAL_ID}`,
    );

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(mockIssueApprovalService.unlink).not.toHaveBeenCalled();
  }, ROUTE_IMPORT_TIMEOUT_MS);
});
