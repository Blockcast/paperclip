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
const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  create: vi.fn(),
  listByCompany: vi.fn(),
}));
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
const mockTaskWatchdogService = vi.hoisted(() => ({
  revalidateMutationScope: vi.fn(),
}));

const WATCHDOG_ID = "55555555-5555-4555-8555-555555555555";
const WATCHDOG_ISSUE_ID = "66666666-6666-4666-8666-666666666666";
const STOP_FINGERPRINT = "task_watchdog_stop:test";

/**
 * The hire route's own `db` use is the single company lookup (no explicit
 * selection). A watchdog run adds three keyed reads; serving them only when the
 * caller asks for a watchdog context keeps the default db exactly as it was.
 */
function createDb(requireBoardApprovalForNewAgents: boolean, watchedIssueId: string | null) {
  const companyRows = [{ id: COMPANY_ID, requireBoardApprovalForNewAgents }];
  const rowsForSelection = (selection: Record<string, unknown> | undefined) => {
    const keys = Object.keys(selection ?? {});
    if (!watchedIssueId) return companyRows;
    if (keys.includes("contextSnapshot")) {
      return [{
        id: "run-1",
        companyId: COMPANY_ID,
        agentId: ACTOR_AGENT_ID,
        contextSnapshot: { taskWatchdog: { watchedIssueId, stopFingerprint: STOP_FINGERPRINT } },
      }];
    }
    if (keys.includes("watchdogAgentId")) {
      return [{
        id: WATCHDOG_ID,
        companyId: COMPANY_ID,
        issueId: watchedIssueId,
        watchdogAgentId: ACTOR_AGENT_ID,
        watchdogIssueId: WATCHDOG_ISSUE_ID,
        status: "active",
      }];
    }
    // Ancestry probe: the walk terminates on `currentId === watchedIssueId`.
    if (keys.includes("parentId")) {
      return [{ id: watchedIssueId, companyId: COMPANY_ID, parentId: null, originKind: null }];
    }
    return companyRows;
  };
  return {
    select: vi.fn((selection?: Record<string, unknown>) => ({
      from: vi.fn(() => ({
        where: vi.fn(() => {
          const rows = rowsForSelection(selection);
          return Object.assign(Promise.resolve(rows), {
            then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve(resolve(rows)),
          });
        }),
      })),
    })),
  };
}

async function createApp(
  requireBoardApprovalForNewAgents = true,
  watchedIssueId: string | null = null,
) {
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
    taskWatchdogService: () => mockTaskWatchdogService,
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

  const db = createDb(requireBoardApprovalForNewAgents, watchedIssueId);

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
  mockAgentService.create.mockImplementation(async (companyId: string, input: Record<string, unknown>) => ({
    ...input,
    companyId,
    permissions: null,
    adapterConfig: {},
    runtimeConfig: {},
  }));
  mockAgentService.listByCompany.mockResolvedValue([]);
  mockAccessService.ensureMembership.mockResolvedValue(undefined);
  mockAccessService.setPrincipalPermission.mockResolvedValue(undefined);
  mockAccessService.getMembership.mockResolvedValue(null);
  mockAccessService.listPrincipalGrants.mockResolvedValue([]);
  mockTaskWatchdogService.revalidateMutationScope.mockResolvedValue({
    allowed: true,
    classification: { state: "stopped", stopFingerprint: STOP_FINGERPRINT },
  });
});

/** Peer's issue, `in_progress`: the evaluator's retryable refusal, not a permanent one. */
function decideClearingBoundary() {
  mockAccessService.decide.mockImplementation(async (input: any) => {
    if (input.action === "tasks:manage_active_checkouts") {
      return { allowed: false, action: input.action, reason: "deny_missing_grant", explanation: "" };
    }
    return { allowed: true, action: input.action, reason: "allow_explicit_grant", explanation: "" };
  });
}

function peerIssue(overrides: Record<string, unknown> = {}) {
  return {
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
    ...overrides,
  };
}

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

  it("reports a peer's in_progress checkout as a retryable 409, matching the other two doors", async () => {
    // The status, not just the verdict, has to agree across the three doors: a
    // checkout conflict clears once the other agent's run ends, so collapsing it to
    // 403 would tell the caller its hire can never succeed.
    decideClearingBoundary();
    mockIssueService.getById.mockImplementation(async (id: string) =>
      id === PEER_ISSUE_ID ? peerIssue({ status: "in_progress" }) : null,
    );

    const res = await request(await createApp())
      .post(`/api/companies/${COMPANY_ID}/agent-hires`)
      .send(hireBody([PEER_ISSUE_ID]));

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error).toContain(PEER_ISSUE_ID);
    expect(mockIssueApprovalService.linkManyForApproval).not.toHaveBeenCalled();
  }, ROUTE_IMPORT_TIMEOUT_MS);

  it("does NOT refuse when the company requires no board approval, since nothing is linked", async () => {
    // `linkManyForApproval` only runs inside the `requiresApproval` branch. With
    // approvals off, `sourceIssueIds` are discarded and no `issue_approvals` row is
    // created — refusing here would deny a legitimate hire over a link that was
    // never going to happen.
    mockIssueService.getById.mockImplementation(async (id: string) =>
      id === PEER_ISSUE_ID ? peerIssue() : null,
    );

    const res = await request(await createApp(false))
      .post(`/api/companies/${COMPANY_ID}/agent-hires`)
      .send(hireBody([PEER_ISSUE_ID]));

    expect(res.status, JSON.stringify(res.body)).not.toBe(403);
    expect(res.status, JSON.stringify(res.body)).not.toBe(409);
    // Proves the hire actually proceeded rather than merely failing some other way.
    expect(mockAgentService.create).toHaveBeenCalled();
    expect(mockIssueApprovalService.linkManyForApproval).not.toHaveBeenCalled();
  }, ROUTE_IMPORT_TIMEOUT_MS);

  it("refuses a stale task-watchdog source link with 409, matching the link route", async () => {
    // PR #1271 review: the shared evaluator reproduced watchdog subtree
    // confinement but not freshness, so this door allowed a link that
    // `POST /issues/:id/approvals` refused. The boundary is cleared here, so a
    // 403 would mean the refusal came from somewhere else.
    decideClearingBoundary();
    mockTaskWatchdogService.revalidateMutationScope.mockResolvedValue({
      allowed: false,
      reason: "Task-watchdog review is stale because the watched subtree now has a live, waiting, already-reviewed, or not-applicable path; refresh the source state before mutating it.",
      classification: { state: "live", stopFingerprint: null },
    });
    mockIssueService.getById.mockImplementation(async (id: string) =>
      id === PEER_ISSUE_ID ? peerIssue() : null,
    );

    const res = await request(await createApp(true, PEER_ISSUE_ID))
      .post(`/api/companies/${COMPANY_ID}/agent-hires`)
      .send(hireBody([PEER_ISSUE_ID]));

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error).toContain(PEER_ISSUE_ID);
    expect(mockIssueApprovalService.linkManyForApproval).not.toHaveBeenCalled();
    expect(mockApprovalService.create).not.toHaveBeenCalled();
  }, ROUTE_IMPORT_TIMEOUT_MS);
});
