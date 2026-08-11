import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * BLO-24699 AC #4: `POST /companies/:companyId/agent-hires` is the third door to a
 * row in `issue_approvals`. It links its `sourceIssueIds` through the same
 * `linkManyForApproval` as the other two routes, which validates only that each id
 * exists in the approval's company — the BLO-23763 hole, a third time.
 *
 * Its `agents:create` gate bounds the exposure to the population that could already
 * reach the old privileged link gate (2 of 16 agents on this company's roster), but
 * bounding is not closing: nothing stopped a hire approval from being attached to an
 * issue its filer has no authority over. This pins the issue-scoped check.
 *
 * The denial path is what is worth pinning here — it is the security-relevant
 * direction, it is reached before the hire flow's heavier machinery, and the
 * allow path is already exercised by the existing agent-hires suites (whose board
 * actor this check deliberately does not apply to).
 */

/**
 * `vi.resetModules()` per test means every case re-imports `routes/agents.ts`, which
 * is large enough that a cold CI cache pushes a single case past vitest's 60s
 * default. The work is import cost, not test cost.
 */
const ROUTE_IMPORT_TIMEOUT_MS = 120_000;

const COMPANY_ID = "company-1";
const ACTOR_AGENT_ID = "agent-1";
const PEER_AGENT_ID = "agent-2";
const PEER_ISSUE_ID = "22222222-2222-4222-8222-222222222222";

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  decide: vi.fn(),
  hasPermission: vi.fn(),
  getMembership: vi.fn(),
  listPrincipalGrants: vi.fn(),
  ensureMembership: vi.fn(),
  setPrincipalPermission: vi.fn(),
}));
const mockAgentService = vi.hoisted(() => ({ getById: vi.fn() }));
const mockIssueService = vi.hoisted(() => ({ getById: vi.fn() }));
const mockIssueApprovalService = vi.hoisted(() => ({ linkManyForApproval: vi.fn() }));
const mockApprovalService = vi.hoisted(() => ({ create: vi.fn() }));
const mockSecretService = vi.hoisted(() => ({
  resolveAdapterConfigForRuntime: vi.fn(),
  normalizeAdapterConfigForPersistence: vi.fn(
    async (_companyId: string, config: Record<string, unknown>) => config,
  ),
}));
const mockLogActivity = vi.hoisted(() => vi.fn());

async function createApp() {
  vi.doMock("../services/index.js", () => ({
    agentService: () => mockAgentService,
    agentInstructionsService: () => ({}),
    accessService: () => mockAccessService,
    approvalService: () => mockApprovalService,
    companySkillService: () => ({ listRuntimeSkillEntries: vi.fn(), resolveRequestedSkillEntries: vi.fn() }),
    budgetService: () => ({}),
    environmentService: () => ({ getById: vi.fn() }),
    heartbeatService: () => ({}),
    issueApprovalService: () => mockIssueApprovalService,
    issueService: () => mockIssueService,
    logActivity: mockLogActivity,
    secretService: () => mockSecretService,
    syncInstructionsBundleConfigFromFilePath: vi.fn(
      (_agent: unknown, config: Record<string, unknown>) => config,
    ),
    workspaceOperationService: () => ({}),
  }));
  vi.doMock("../services/secrets.js", () => ({ secretService: () => mockSecretService }));
  vi.doMock("../adapters/index.js", () => ({
    findServerAdapter: vi.fn((type: string) => ({ type })),
    findActiveServerAdapter: vi.fn((type: string) => ({ type })),
    listAdapterModels: vi.fn(),
    detectAdapterModel: vi.fn(),
  }));

  const [{ agentRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/agents.js")>("../routes/agents.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);

  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async () => [{ id: COMPANY_ID, requireBoardApprovalForNewAgents: true }]),
      })),
    })),
  };

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "agent",
      agentId: ACTOR_AGENT_ID,
      companyId: COMPANY_ID,
      runId: "run-1",
      source: "api_key",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", agentRoutes(db as any));
  app.use(errorHandler);
  return app;
}

const hireBody = (sourceIssueIds: string[]) => ({
  name: "New Hire",
  role: "engineer",
  adapterType: "claude_local",
  adapterConfig: {},
  sourceIssueIds,
});

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  // The actor clears `agents:create` — this is a hiring-capable agent, i.e. exactly
  // the population the old privileged gate admitted. The point is that clearing the
  // hire gate must not also confer authority over an arbitrary issue.
  mockAccessService.decide.mockImplementation(async (input: any) => {
    if (input.action === "agents:create") {
      return { allowed: true, action: input.action, reason: "allow_explicit_grant", explanation: "" };
    }
    if (input.action === "tasks:manage_active_checkouts") {
      return { allowed: false, action: input.action, reason: "deny_missing_grant", explanation: "" };
    }
    const assignee = input.resource?.assigneeAgentId;
    if (assignee && assignee !== ACTOR_AGENT_ID) {
      return { allowed: false, action: input.action, reason: "deny_missing_grant", explanation: "" };
    }
    return { allowed: true, action: input.action, reason: "allow_assignee", explanation: "" };
  });
  mockAccessService.canUser.mockResolvedValue(true);
  mockAccessService.hasPermission.mockResolvedValue(true);
  mockAgentService.getById.mockResolvedValue({
    id: ACTOR_AGENT_ID,
    companyId: COMPANY_ID,
    role: "agent",
    permissions: { canCreateAgents: true },
  });
  mockIssueService.getById.mockResolvedValue(null);
  mockIssueApprovalService.linkManyForApproval.mockResolvedValue(undefined);
  mockLogActivity.mockResolvedValue(undefined);
});

describe("agent-hires sourceIssueIds authorization (BLO-24699)", () => {
  it("refuses a sourceIssueIds entry the hiring agent is not authorized on, and links nothing", async () => {
    mockIssueService.getById.mockImplementation(async (id: string) =>
      id === PEER_ISSUE_ID
        ? {
            id: PEER_ISSUE_ID,
            companyId: COMPANY_ID,
            projectId: null,
            parentId: null,
            status: "todo",
            assigneeAgentId: PEER_AGENT_ID,
            assigneeUserId: null,
            createdByAgentId: PEER_AGENT_ID,
            originKind: null,
            originId: null,
            checkoutRunId: null,
            executionRunId: null,
          }
        : null,
    );

    const res = await request(await createApp())
      .post(`/api/companies/${COMPANY_ID}/agent-hires`)
      .send(hireBody([PEER_ISSUE_ID]));

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toContain(PEER_ISSUE_ID);
    expect(mockIssueApprovalService.linkManyForApproval).not.toHaveBeenCalled();
    // Refused at the boundary, before the hire itself is persisted.
    expect(mockApprovalService.create).not.toHaveBeenCalled();
  }, ROUTE_IMPORT_TIMEOUT_MS);

  it("passes through ids that resolve into another company, leaving linkManyForApproval to reject them", async () => {
    // Not an authorization question: `linkManyForApproval` already 404/422s these,
    // and duplicating that here would change this route's error semantics.
    mockIssueService.getById.mockImplementation(async (id: string) =>
      id === PEER_ISSUE_ID
        ? {
            id: PEER_ISSUE_ID,
            companyId: "company-2",
            projectId: null,
            parentId: null,
            status: "todo",
            assigneeAgentId: PEER_AGENT_ID,
            assigneeUserId: null,
            createdByAgentId: PEER_AGENT_ID,
            originKind: null,
            originId: null,
            checkoutRunId: null,
            executionRunId: null,
          }
        : null,
    );

    const res = await request(await createApp())
      .post(`/api/companies/${COMPANY_ID}/agent-hires`)
      .send(hireBody([PEER_ISSUE_ID]));

    expect(res.status).not.toBe(403);
  }, ROUTE_IMPORT_TIMEOUT_MS);
});
