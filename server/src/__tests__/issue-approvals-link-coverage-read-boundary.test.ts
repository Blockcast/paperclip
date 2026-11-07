import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PEN-5511 follow-up. `GET /issues/:id/approvals` is gated on reading the ISSUE.
 * The linked list it returns is in scope for that gate, because those cards hang
 * off a row the caller can read — which is why the route has never needed the
 * approval-read half that the `POST` door 25 lines below enforces with
 * `assertApprovalReadAllowed`.
 *
 * `includeLinkCoverage=true` changed that, and this file is the boundary it
 * changed it at. The candidate count scans every UNDECIDED card in the COMPANY
 * that is NOT linked to this row, so without a second gate an actor that may read
 * an issue but not approvals learns how many pending cards elsewhere in the
 * company name it — a small cross-row oracle, reachable from a read-only route,
 * in a change whose purpose was relaxing authorization. The classes that separates
 * are real: task-bridge keys and skill-test tokens are denied `company_scope:read`
 * outright while still holding `issue:read`.
 *
 * Two properties, and the second is as load-bearing as the first:
 *
 *  1. The route hands the probe the `company_scope:read` verdict, so a denied
 *     actor's coverage reads `approval_read_unavailable` with NULL counts — never
 *     `false`, which would assert a completeness nobody measured.
 *  2. It still answers 200. `paperclipListIssueApprovals` sends the flag on every
 *     call, so 403ing here would turn a read those actors are entitled to into an
 *     error for every agent reader this defect was found by.
 */

const ROUTE_IMPORT_TIMEOUT_MS = 120_000;

const COMPANY_ID = "company-1";
const ACTOR_AGENT_ID = "agent-1";
const ISSUE_ID = "11111111-1111-4111-8111-111111111111";

const mockAccessService = vi.hoisted(() => ({
  decide: vi.fn(),
  getMembership: vi.fn(),
  listPrincipalGrants: vi.fn(),
}));
const mockIssueService = vi.hoisted(() => ({ getById: vi.fn() }));
const mockIssueApprovalService = vi.hoisted(() => ({
  listApprovalsForIssue: vi.fn(async () => []),
  linkCoverageForIssue: vi.fn(async () => ({
    linkedCount: 0,
    unlinkedMentionCandidateCount: null,
    potentiallyUnlinkedCards: null,
    basis: "approval_read_unavailable" as const,
  })),
  getApprovalLinkSubject: vi.fn(async () => null),
  link: vi.fn(),
  unlink: vi.fn(),
  listIssuesForApproval: vi.fn(),
  linkManyForApproval: vi.fn(),
}));
const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
}));
const mockAgentService = vi.hoisted(() => ({ getById: vi.fn() }));
const mockLogActivity = vi.hoisted(() => vi.fn());

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    agentService: () => mockAgentService,
    heartbeatService: () => mockHeartbeatService,
    issueApprovalService: () => mockIssueApprovalService,
    issueService: () => mockIssueService,
    logActivity: mockLogActivity,
    companyService: () => ({ getById: vi.fn(async () => ({ id: COMPANY_ID })) }),
    companySkillService: () => ({}),
    documentService: () => ({}),
    documentAnnotationService: () => ({}),
    executionWorkspaceService: () => ({}),
    goalService: () => ({}),
    instanceSettingsService: () => ({
      getGeneral: vi.fn(async () => ({ censorUsernameInLogs: false })),
    }),
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

function createRouteDb() {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          then: async (resolve: (rows: unknown[]) => unknown) =>
            resolve([{ companyId: COMPANY_ID, permissions: null }]),
        })),
      })),
    })),
  } as any;
}

async function createApp(actor: Record<string, unknown>) {
  const [{ errorHandler }, { issueRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/issues.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", issueRoutes(createRouteDb(), {} as any));
  app.use(errorHandler);
  return app;
}

const agentActor = {
  type: "agent",
  agentId: ACTOR_AGENT_ID,
  companyId: COMPANY_ID,
  runId: "run-1",
  source: "api_key",
  isInstanceAdmin: false,
};

/**
 * Allow everything except the one action under test, so the request reaches the
 * coverage call rather than stopping at an unrelated gate. `companyScopeRead` is
 * the single variable.
 */
function decideWith({ companyScopeRead }: { companyScopeRead: boolean }) {
  mockAccessService.decide.mockImplementation(async (input: any) => {
    if (input.action === "company_scope:read") {
      return companyScopeRead
        ? { allowed: true, action: input.action, reason: "allow_explicit_grant", explanation: "" }
        : { allowed: false, action: input.action, reason: "deny_scope", explanation: "" };
    }
    return { allowed: true, action: input.action, reason: "allow_assignee", explanation: "" };
  });
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  for (const specifier of [
    "../services/index.js",
    "../routes/issues.js",
    "../routes/authz.js",
    "../middleware/index.js",
  ]) {
    vi.doUnmock(specifier);
  }
  registerModuleMocks();
  mockIssueApprovalService.listApprovalsForIssue.mockResolvedValue([]);
  mockIssueService.getById.mockResolvedValue({
    id: ISSUE_ID,
    companyId: COMPANY_ID,
    identifier: "PEN-5379",
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
  });
});

describe("GET /issues/:id/approvals link coverage read boundary (PEN-5511)", () => {
  it(
    "measures coverage for an actor that may read this company's approvals",
    async () => {
      decideWith({ companyScopeRead: true });

      const res = await request(await createApp(agentActor)).get(
        `/api/issues/${ISSUE_ID}/approvals?includeLinkCoverage=true`,
      );

      expect(res.status).toBe(200);
      expect(mockIssueApprovalService.linkCoverageForIssue).toHaveBeenCalledWith(
        COMPANY_ID,
        { id: ISSUE_ID, identifier: "PEN-5379" },
        { approvalReadAllowed: true },
      );
    },
    ROUTE_IMPORT_TIMEOUT_MS,
  );

  it(
    "withholds the company-wide probe from an actor that may read the issue but not approvals",
    async () => {
      // The leak this test exists for: `issue:read` holds, `company_scope:read`
      // does not — the task-bridge / skill-test / low-trust shape.
      decideWith({ companyScopeRead: false });

      const res = await request(await createApp(agentActor)).get(
        `/api/issues/${ISSUE_ID}/approvals?includeLinkCoverage=true`,
      );

      // Not a 403: the MCP tool sends this flag on every call, so refusing would
      // break a read these actors are entitled to.
      expect(res.status).toBe(200);
      expect(mockIssueApprovalService.linkCoverageForIssue).toHaveBeenCalledWith(
        COMPANY_ID,
        { id: ISSUE_ID, identifier: "PEN-5379" },
        { approvalReadAllowed: false },
      );
      // NULL, never `false` — the probe was not permitted, which is not the same
      // answer as "it ran and found nothing".
      expect(res.body.linkCoverage.basis).toBe("approval_read_unavailable");
      expect(res.body.linkCoverage.potentiallyUnlinkedCards).toBeNull();
      expect(res.body.linkCoverage.unlinkedMentionCandidateCount).toBeNull();
    },
    ROUTE_IMPORT_TIMEOUT_MS,
  );

  it(
    "runs no coverage probe at all when the flag is absent",
    async () => {
      // The array shape every existing consumer indexes — unchanged, and it must
      // not pay for a probe nobody asked for.
      decideWith({ companyScopeRead: true });

      const res = await request(await createApp(agentActor)).get(
        `/api/issues/${ISSUE_ID}/approvals`,
      );

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(mockIssueApprovalService.linkCoverageForIssue).not.toHaveBeenCalled();
    },
    ROUTE_IMPORT_TIMEOUT_MS,
  );
});
