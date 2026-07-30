import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockApprovalService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  approve: vi.fn(),
  reject: vi.fn(),
  requestRevision: vi.fn(),
  resubmit: vi.fn(),
  withdraw: vi.fn(),
  listComments: vi.fn(),
  addComment: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(),
}));

const mockIssueApprovalService = vi.hoisted(() => ({
  listIssuesForApproval: vi.fn(),
  linkManyForApproval: vi.fn(),
}));

const mockSecretService = vi.hoisted(() => ({
  normalizeHireApprovalPayloadForPersistence: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());
const mockAccessService = vi.hoisted(() => ({
  decide: vi.fn(),
}));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    approvalService: () => mockApprovalService,
    heartbeatService: () => mockHeartbeatService,
    issueApprovalService: () => mockIssueApprovalService,
    logActivity: mockLogActivity,
    secretService: () => mockSecretService,
  }));
}

/** Minimal db stub: the routes only read heartbeat_runs for the cheap-recovery guard. */
function createRouteDb() {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          then: async (resolve: (rows: unknown[]) => unknown) => resolve([]),
        })),
      })),
    })),
  } as any;
}

async function createAppWithActor(actor: Record<string, unknown>) {
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
  app.use("/api", approvalRoutes(createRouteDb()));
  app.use(errorHandler);
  return app;
}

const REQUESTER_AGENT_ID = "agent-requester";
const OTHER_AGENT_ID = "agent-bystander";

const agentActor = (agentId: string) => ({
  type: "agent",
  agentId,
  companyId: "company-1",
  runId: "run-1",
  source: "api_key",
  isInstanceAdmin: false,
});

const boardActor = {
  type: "board",
  userId: "user-1",
  companyIds: ["company-1"],
  source: "session",
  isInstanceAdmin: false,
};

function pendingApproval(overrides: Record<string, unknown> = {}) {
  return {
    id: "approval-1",
    companyId: "company-1",
    type: "budget_override_required",
    status: "pending",
    payload: {},
    requestedByAgentId: REQUESTER_AGENT_ID,
    ...overrides,
  };
}

describe("POST /approvals/:id/withdraw", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/approvals.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      action: "company_scope:read",
      reason: "allow_test",
      explanation: "Allowed by test mock.",
    });
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("lets the requesting agent withdraw its own pending approval", async () => {
    mockApprovalService.getById.mockResolvedValue(pendingApproval());
    mockApprovalService.withdraw.mockResolvedValue(
      pendingApproval({ status: "withdrawn", decisionNote: "cap already raised past the ask" }),
    );

    const res = await request(await createAppWithActor(agentActor(REQUESTER_AGENT_ID)))
      .post("/api/approvals/approval-1/withdraw")
      .send({ reason: "cap already raised past the ask" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("withdrawn");
    expect(mockApprovalService.withdraw).toHaveBeenCalledWith(
      "approval-1",
      "cap already raised past the ask",
      { userId: null },
    );
  }, 15000);

  it("returns 403 when a different agent tries to withdraw someone else's approval", async () => {
    mockApprovalService.getById.mockResolvedValue(pendingApproval());

    const res = await request(await createAppWithActor(agentActor(OTHER_AGENT_ID)))
      .post("/api/approvals/approval-1/withdraw")
      .send({ reason: "not mine to rescind" });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Only requesting agent can withdraw this approval");
    expect(mockApprovalService.withdraw).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  }, 15000);

  it("lets a board actor withdraw an agent-filed approval", async () => {
    mockApprovalService.getById.mockResolvedValue(pendingApproval());
    mockApprovalService.withdraw.mockResolvedValue(
      pendingApproval({ status: "withdrawn", decisionNote: "superseded" }),
    );

    const res = await request(await createAppWithActor(boardActor))
      .post("/api/approvals/approval-1/withdraw")
      .send({ reason: "superseded" });

    expect(res.status).toBe(200);
    expect(mockApprovalService.withdraw).toHaveBeenCalledWith("approval-1", "superseded", {
      userId: "user-1",
    });
  }, 15000);

  it("propagates 409 when the approval is no longer pending and leaves status untouched", async () => {
    const { conflict } = await import("../errors.js");
    mockApprovalService.getById.mockResolvedValue(pendingApproval({ status: "approved" }));
    mockApprovalService.withdraw.mockRejectedValue(
      conflict("Only pending approvals can be withdrawn", {
        approvalId: "approval-1",
        status: "approved",
      }),
    );

    const res = await request(await createAppWithActor(agentActor(REQUESTER_AGENT_ID)))
      .post("/api/approvals/approval-1/withdraw")
      .send({ reason: "too late" });

    expect(res.status).toBe(409);
    expect(mockLogActivity).not.toHaveBeenCalled();
  }, 15000);

  it("writes an approval.withdrawn activity record carrying actor, approval id, and reason", async () => {
    mockApprovalService.getById.mockResolvedValue(pendingApproval());
    mockApprovalService.withdraw.mockResolvedValue(
      pendingApproval({ status: "withdrawn", decisionNote: "obsolete ask" }),
    );

    await request(await createAppWithActor(agentActor(REQUESTER_AGENT_ID)))
      .post("/api/approvals/approval-1/withdraw")
      .send({ reason: "obsolete ask" });

    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: "company-1",
        action: "approval.withdrawn",
        entityType: "approval",
        entityId: "approval-1",
        actorType: "agent",
        agentId: REQUESTER_AGENT_ID,
        details: expect.objectContaining({
          type: "budget_override_required",
          reason: "obsolete ask",
        }),
      }),
    );
  }, 15000);

  it("requires a non-empty reason", async () => {
    mockApprovalService.getById.mockResolvedValue(pendingApproval());

    const missing = await request(await createAppWithActor(agentActor(REQUESTER_AGENT_ID)))
      .post("/api/approvals/approval-1/withdraw")
      .send({});
    const blank = await request(await createAppWithActor(agentActor(REQUESTER_AGENT_ID)))
      .post("/api/approvals/approval-1/withdraw")
      .send({ reason: "   " });

    expect(missing.status).toBe(400);
    expect(blank.status).toBe(400);
    expect(mockApprovalService.withdraw).not.toHaveBeenCalled();
  }, 15000);

  it("stores the reason trimmed so the audit trail carries no stray whitespace", async () => {
    mockApprovalService.getById.mockResolvedValue(pendingApproval());
    mockApprovalService.withdraw.mockResolvedValue(
      pendingApproval({ status: "withdrawn", decisionNote: "superseded by BLO-18967" }),
    );

    await request(await createAppWithActor(agentActor(REQUESTER_AGENT_ID)))
      .post("/api/approvals/approval-1/withdraw")
      .send({ reason: "  superseded by BLO-18967\n  " });

    expect(mockApprovalService.withdraw).toHaveBeenCalledWith(
      "approval-1",
      "superseded by BLO-18967",
      { userId: null },
    );
  }, 15000);

  it("refuses an approval outside the caller's company scope", async () => {
    mockApprovalService.getById.mockResolvedValue(
      pendingApproval({ id: "approval-2", companyId: "company-2" }),
    );

    const res = await request(await createAppWithActor(agentActor(REQUESTER_AGENT_ID)))
      .post("/api/approvals/approval-2/withdraw")
      .send({ reason: "wrong company" });

    // getAccessibleResource answers 404 rather than 403 so a cross-company
    // caller cannot use the status code to probe whether the id exists.
    expect(res.status).toBe(404);
    expect(mockApprovalService.withdraw).not.toHaveBeenCalled();
  }, 15000);

  it("still refuses to let an agent reject an approval (board authority unchanged)", async () => {
    mockApprovalService.getById.mockResolvedValue(pendingApproval());

    const reject = await request(await createAppWithActor(agentActor(REQUESTER_AGENT_ID)))
      .post("/api/approvals/approval-1/reject")
      .send({});
    const approve = await request(await createAppWithActor(agentActor(REQUESTER_AGENT_ID)))
      .post("/api/approvals/approval-1/approve")
      .send({});
    const revision = await request(await createAppWithActor(agentActor(REQUESTER_AGENT_ID)))
      .post("/api/approvals/approval-1/request-revision")
      .send({});

    expect(reject.status).toBe(403);
    expect(approve.status).toBe(403);
    expect(revision.status).toBe(403);
    expect(mockApprovalService.reject).not.toHaveBeenCalled();
    expect(mockApprovalService.approve).not.toHaveBeenCalled();
    expect(mockApprovalService.requestRevision).not.toHaveBeenCalled();
  }, 15000);
});
