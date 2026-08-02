import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

async function createApp(actorOverrides: Record<string, unknown> = {}) {
  const [{ errorHandler }, { approvalRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/approvals.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "user-1",
      companyIds: ["company-1"],
      source: "session",
      isInstanceAdmin: false,
      ...actorOverrides,
    };
    next();
  });
  app.use("/api", approvalRoutes(createRouteDb()));
  app.use(errorHandler);
  return app;
}

function createRouteDb(contextSnapshot: Record<string, unknown> = {}, runId = "run-1", agentId = "agent-1") {
  const runRows = [{
    id: runId,
    companyId: "company-1",
    agentId,
    contextSnapshot,
  }];
  return {
    select: vi.fn((selection: Record<string, unknown> = {}) => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          then: async (resolve: (rows: unknown[]) => unknown) => resolve(
            Object.keys(selection).includes("contextSnapshot") ? runRows : [],
          ),
        })),
      })),
    })),
  } as any;
}

async function createAgentApp(options: { runId?: string; contextSnapshot?: Record<string, unknown> } = {}) {
  const [{ errorHandler }, { approvalRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/approvals.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      runId: options.runId ?? "run-1",
      source: "api_key",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", approvalRoutes(createRouteDb(options.contextSnapshot, options.runId ?? "run-1")));
  app.use(errorHandler);
  return app;
}

describe("approval routes idempotent retries", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/approvals.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockApprovalService.list.mockReset();
    mockApprovalService.listSummary.mockReset();
    mockApprovalService.countBy.mockReset();
    mockApprovalService.getById.mockReset();
    mockApprovalService.create.mockReset();
    mockApprovalService.createWithIdempotency.mockReset();
    // The route calls createWithIdempotency; the non-dedupe branch is behaviourally
    // identical to the old create, so delegate. Existing assertions on `create` — the
    // args the route builds — keep working unchanged, and tests that exercise a replay
    // override this implementation.
    mockApprovalService.createWithIdempotency.mockImplementation(
      async (companyId: string, data: Record<string, unknown>) => ({
        approval: await mockApprovalService.create(companyId, data),
        deduplicated: false,
      }),
    );
    mockApprovalService.approve.mockReset();
    mockApprovalService.reject.mockReset();
    mockApprovalService.requestRevision.mockReset();
    mockApprovalService.resubmit.mockReset();
    mockApprovalService.listComments.mockReset();
    mockApprovalService.addComment.mockReset();
    mockHeartbeatService.wakeup.mockReset();
    mockIssueApprovalService.listIssuesForApproval.mockReset();
    mockIssueApprovalService.linkManyForApproval.mockReset();
    mockSecretService.normalizeHireApprovalPayloadForPersistence.mockReset();
    mockLogActivity.mockReset();
    mockAccessService.decide.mockReset();
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      action: "company_scope:read",
      reason: "allow_test",
      explanation: "Allowed by test mock.",
    });
    mockHeartbeatService.wakeup.mockResolvedValue({ id: "wake-1" });
    mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([{ id: "issue-1" }]);
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("does not emit duplicate approval side effects when approve is already resolved", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-1",
      companyId: "company-1",
      type: "hire_agent",
      status: "approved",
      payload: {},
      requestedByAgentId: "agent-1",
    });
    mockApprovalService.approve.mockResolvedValue({
      approval: {
        id: "approval-1",
        companyId: "company-1",
        type: "hire_agent",
        status: "approved",
        payload: {},
        requestedByAgentId: "agent-1",
      },
      applied: false,
    });

    const res = await request(await createApp())
      .post("/api/approvals/approval-1/approve")
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(false);
    expect(mockIssueApprovalService.listIssuesForApproval).not.toHaveBeenCalled();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("does not emit duplicate rejection logs when reject is already resolved", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-1",
      companyId: "company-1",
      type: "hire_agent",
      status: "rejected",
      payload: {},
    });
    mockApprovalService.reject.mockResolvedValue({
      approval: {
        id: "approval-1",
        companyId: "company-1",
        type: "hire_agent",
        status: "rejected",
        payload: {},
      },
      applied: false,
    });

    const res = await request(await createApp())
      .post("/api/approvals/approval-1/reject")
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(false);
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("rejects approval decisions for companies outside the caller scope", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-2",
      companyId: "company-2",
      type: "hire_agent",
      status: "pending",
      payload: {},
    });

    const res = await request(await createApp())
      .post("/api/approvals/approval-2/approve")
      .send({});

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Approval not found");
    expect(mockApprovalService.approve).not.toHaveBeenCalled();
  });

  it("rejects approval revision requests for companies outside the caller scope", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-3",
      companyId: "company-2",
      type: "hire_agent",
      status: "pending",
      payload: {},
    });

    const res = await request(await createApp())
      .post("/api/approvals/approval-3/request-revision")
      .send({ decisionNote: "Need changes" });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Approval not found");
    expect(mockApprovalService.requestRevision).not.toHaveBeenCalled();
  });

  it("derives approval attribution from the authenticated actor on approve", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-4",
      companyId: "company-1",
      type: "hire_agent",
      status: "pending",
      payload: {},
      requestedByAgentId: null,
    });
    mockApprovalService.approve.mockResolvedValue({
      approval: {
        id: "approval-4",
        companyId: "company-1",
        type: "hire_agent",
        status: "approved",
        payload: {},
        requestedByAgentId: null,
      },
      applied: true,
    });

    const res = await request(await createApp())
      .post("/api/approvals/approval-4/approve")
      .send({ decidedByUserId: "forged-user", decisionNote: "ship it" });

    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(true);
    expect(mockApprovalService.approve).toHaveBeenCalledWith("approval-4", "user-1", "ship it");
  });

  it("derives approval attribution from the authenticated actor on reject", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-5",
      companyId: "company-1",
      type: "hire_agent",
      status: "pending",
      payload: {},
    });
    mockApprovalService.reject.mockResolvedValue({
      approval: {
        id: "approval-5",
        companyId: "company-1",
        type: "hire_agent",
        status: "rejected",
        payload: {},
      },
      applied: true,
    });

    const res = await request(await createApp())
      .post("/api/approvals/approval-5/reject")
      .send({ decidedByUserId: "forged-user", decisionNote: "not now" });

    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(true);
    expect(mockApprovalService.reject).toHaveBeenCalledWith("approval-5", "user-1", "not now");
  });

  it("derives approval attribution from the authenticated actor on request revision", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-6",
      companyId: "company-1",
      type: "hire_agent",
      status: "pending",
      payload: {},
    });
    mockApprovalService.requestRevision.mockResolvedValue({
      id: "approval-6",
      companyId: "company-1",
      type: "hire_agent",
      status: "revision_requested",
      payload: {},
    });

    const res = await request(await createApp())
      .post("/api/approvals/approval-6/request-revision")
      .send({ decidedByUserId: "forged-user", decisionNote: "Need changes" });

    expect(res.status).toBe(200);
    expect(mockApprovalService.requestRevision).toHaveBeenCalledWith(
      "approval-6",
      "user-1",
      "Need changes",
    );
  });

  it("lets agents create generic issue-linked board approval requests", async () => {
    const payload = {
      title: "Approve hosting spend",
      env: { target: "production" },
      colorChoice: { type: "plain", value: "blue" },
    };
    mockApprovalService.create.mockResolvedValue({
      id: "approval-1",
      companyId: "company-1",
      type: "request_board_approval",
      requestedByAgentId: "agent-1",
      requestedByUserId: null,
      status: "pending",
      payload,
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      createdAt: new Date("2026-04-06T00:00:00.000Z"),
      updatedAt: new Date("2026-04-06T00:00:00.000Z"),
    });

    const res = await request(await createAgentApp())
      .post("/api/companies/company-1/approvals")
      .send({
        type: "request_board_approval",
        issueIds: ["00000000-0000-0000-0000-000000000001"],
        payload,
      });

    expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
    expect(res.body).toMatchObject({
      companyId: "company-1",
      type: "request_board_approval",
      requestedByAgentId: "agent-1",
      requestedByUserId: null,
      status: "pending",
      payload,
    });
    expect(mockApprovalService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ type: "request_board_approval", payload }),
    );
    expect(mockSecretService.normalizeHireApprovalPayloadForPersistence).not.toHaveBeenCalled();
    expect(mockIssueApprovalService.linkManyForApproval).toHaveBeenCalledWith(
      "approval-1",
      ["00000000-0000-0000-0000-000000000001"],
      { agentId: "agent-1", userId: null },
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: "company-1",
        actorType: "agent",
        actorId: "agent-1",
        action: "approval.created",
        // The approval's payload title + id must reach `details` so the plugin
        // domain event (built from details) carries them to the Slack card.
        // Without this every board-approval card renders only `Type`.
        details: expect.objectContaining({
          type: "request_board_approval",
          approvalId: "approval-1",
          title: "Approve hosting spend",
          issueIds: ["00000000-0000-0000-0000-000000000001"],
        }),
      }),
    );
  });

  it("carries the payload `note` into details as description (note alias)", async () => {
    mockApprovalService.create.mockResolvedValue({
      id: "approval-note",
      companyId: "company-1",
      type: "request_board_approval",
      requestedByAgentId: "agent-1",
      requestedByUserId: null,
      status: "pending",
      payload: { title: "Spend approval", note: "needs board sign-off" },
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      createdAt: new Date("2026-04-06T00:00:00.000Z"),
      updatedAt: new Date("2026-04-06T00:00:00.000Z"),
    });

    const res = await request(await createAgentApp())
      .post("/api/companies/company-1/approvals")
      .send({
        type: "request_board_approval",
        payload: { title: "Spend approval", note: "needs board sign-off" },
      });

    expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "approval.created",
        details: expect.objectContaining({
          approvalId: "approval-note",
          title: "Spend approval",
          // `note` is mapped to `description` (the field the formatter reads).
          description: "needs board sign-off",
        }),
      }),
    );
  });

  // `requestedByAgentId` is an attribution signal other subsystems reason about, so an agent must
  // not be able to nominate someone else as the requester of an approval it filed.
  it("ignores a body-supplied requestedByAgentId from an agent actor", async () => {
    mockApprovalService.create.mockResolvedValue({
      id: "approval-attr",
      companyId: "company-1",
      type: "request_board_approval",
      requestedByAgentId: "agent-1",
      requestedByUserId: null,
      status: "pending",
      payload: { title: "Approve hosting spend" },
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      createdAt: new Date("2026-04-06T00:00:00.000Z"),
      updatedAt: new Date("2026-04-06T00:00:00.000Z"),
    });

    const res = await request(await createAgentApp())
      .post("/api/companies/company-1/approvals")
      .send({
        type: "request_board_approval",
        requestedByAgentId: "00000000-0000-0000-0000-0000000000ff",
        payload: { title: "Approve hosting spend" },
      });

    expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
    expect(mockApprovalService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ requestedByAgentId: "agent-1", requestedByUserId: null }),
    );
  });

  it("honours a body-supplied requestedByAgentId from a user actor", async () => {
    mockApprovalService.create.mockResolvedValue({
      id: "approval-attr-user",
      companyId: "company-1",
      type: "request_board_approval",
      requestedByAgentId: "00000000-0000-0000-0000-0000000000ff",
      requestedByUserId: "user-1",
      status: "pending",
      payload: { title: "Approve hosting spend" },
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      createdAt: new Date("2026-04-06T00:00:00.000Z"),
      updatedAt: new Date("2026-04-06T00:00:00.000Z"),
    });

    const res = await request(await createApp({ type: "user", userId: "user-1" }))
      .post("/api/companies/company-1/approvals")
      .send({
        type: "request_board_approval",
        requestedByAgentId: "00000000-0000-0000-0000-0000000000ff",
        payload: { title: "Approve hosting spend" },
      });

    expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
    expect(mockApprovalService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        requestedByAgentId: "00000000-0000-0000-0000-0000000000ff",
        requestedByUserId: "user-1",
      }),
    );
  });

  // ---------------------------------------------------------------------------
  // BLO-19132: create-side dedupe and the cheap existence check.
  //
  // The defect these cover: filing a duplicate approval was cheaper than checking
  // whether one already existed, and a pending approval emitted nothing back to its
  // requester, so retrying was the only way to learn anything. Three asks for one PR
  // review landed inside 73 minutes because of it.
  // ---------------------------------------------------------------------------

  it("replays the original approval when an agent reuses an idempotency key", async () => {
    const existing = {
      id: "approval-original",
      companyId: "company-1",
      type: "request_board_approval",
      requestedByAgentId: "agent-1",
      requestedByUserId: null,
      status: "pending",
      payload: { title: "Trigger exact-head human review for MOQtail PR #312" },
      idempotencyKey: "moqtail-312-exact-head-review",
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      createdAt: new Date(Date.now() - 73 * 60 * 1000),
      updatedAt: new Date(),
    };
    mockApprovalService.createWithIdempotency.mockResolvedValue({
      approval: existing,
      deduplicated: true,
    });

    const res = await request(await createAgentApp())
      .post("/api/companies/company-1/approvals")
      .send({
        type: "request_board_approval",
        issueIds: ["00000000-0000-0000-0000-000000000001"],
        payload: { title: "Trigger exact-head human review for MOQtail PR #312" },
        idempotencyKey: "moqtail-312-exact-head-review",
      });

    // 200, not 201: nothing was created.
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      id: "approval-original",
      deduplicated: true,
      deduplicationReason: "idempotency_key",
    });
    // The readback is the signal that makes retrying unnecessary.
    expect(res.body.statusReadback).toContain("still pending");
    expect(res.body.statusReadback).toContain("No duplicate was created");
    expect(res.body.pendingForMs).toBeGreaterThan(60 * 60 * 1000);

    // Issue links are idempotent (onConflictDoNothing), so applying the caller's links
    // to the ORIGINAL approval is correct — a retry naming a new issue still attaches
    // it. What must not repeat is the board notification.
    expect(mockIssueApprovalService.linkManyForApproval).toHaveBeenCalledWith(
      "approval-original",
      ["00000000-0000-0000-0000-000000000001"],
      { agentId: "agent-1", userId: null },
    );
    // Re-logging would put a second card in front of a human for an ask they have
    // already been shown — the exact harm this ticket is about.
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("forwards the idempotency key to the service on a first filing", async () => {
    mockApprovalService.create.mockResolvedValue({
      id: "approval-first",
      companyId: "company-1",
      type: "request_board_approval",
      requestedByAgentId: "agent-1",
      requestedByUserId: null,
      status: "pending",
      payload: { title: "Rotate credentials" },
      idempotencyKey: "rotate-creds-blo-18969",
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      createdAt: new Date("2026-08-02T00:00:00.000Z"),
      updatedAt: new Date("2026-08-02T00:00:00.000Z"),
    });

    const res = await request(await createAgentApp())
      .post("/api/companies/company-1/approvals")
      .send({
        type: "request_board_approval",
        payload: { title: "Rotate credentials" },
        idempotencyKey: "rotate-creds-blo-18969",
      });

    expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
    expect(res.body.deduplicated).toBeUndefined();
    expect(mockApprovalService.createWithIdempotency).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ idempotencyKey: "rotate-creds-blo-18969" }),
    );
    // A genuinely new filing still notifies.
    expect(mockLogActivity).toHaveBeenCalled();
  });

  it("serves a count-only listing without touching the payload-bearing list", async () => {
    mockApprovalService.countBy.mockResolvedValue(63);

    const res = await request(await createApp())
      .get("/api/companies/company-1/approvals?view=count&status=pending");

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ count: 63 });
    expect(mockApprovalService.countBy).toHaveBeenCalledWith("company-1", {
      status: "pending",
      type: undefined,
      requestedByAgentId: undefined,
    });
    // The expensive path must not run.
    expect(mockApprovalService.list).not.toHaveBeenCalled();
  });

  it("serves a summary listing that omits payload and filters by linked issue", async () => {
    mockApprovalService.listSummary.mockResolvedValue([
      {
        id: "approval-1",
        type: "request_board_approval",
        status: "pending",
        requestedByAgentId: "agent-1",
        requestedByUserId: null,
        idempotencyKey: "k1",
        createdAt: new Date("2026-08-02T00:00:00.000Z"),
        decidedAt: null,
        label: "Rotate credentials",
      },
    ]);

    const res = await request(await createApp())
      .get(
        "/api/companies/company-1/approvals?view=summary&status=pending&issueId=00000000-0000-0000-0000-000000000001",
      );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].label).toBe("Rotate credentials");
    // The payload body is what makes the full listing expensive; it must be absent.
    expect(res.body[0]).not.toHaveProperty("payload");
    expect(mockApprovalService.listSummary).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        status: "pending",
        issueId: "00000000-0000-0000-0000-000000000001",
      }),
    );
    expect(mockApprovalService.list).not.toHaveBeenCalled();
  });

  it("rejects an unknown view rather than silently falling back to the expensive listing", async () => {
    const res = await request(await createApp())
      .get("/api/companies/company-1/approvals?view=everything");

    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(mockApprovalService.list).not.toHaveBeenCalled();
    expect(mockApprovalService.listSummary).not.toHaveBeenCalled();
  });

  it("keeps the default listing unchanged when no view is given", async () => {
    mockApprovalService.list.mockResolvedValue([
      {
        id: "approval-1",
        companyId: "company-1",
        type: "request_board_approval",
        status: "pending",
        payload: { title: "Approve hosting spend" },
        requestedByAgentId: "agent-1",
        requestedByUserId: null,
        decisionNote: null,
        decidedByUserId: null,
        decidedAt: null,
        createdAt: new Date("2026-08-02T00:00:00.000Z"),
        updatedAt: new Date("2026-08-02T00:00:00.000Z"),
      },
    ]);

    const res = await request(await createApp())
      .get("/api/companies/company-1/approvals?status=pending");

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body[0]).toHaveProperty("payload");
    expect(mockApprovalService.list).toHaveBeenCalledWith("company-1", "pending");
  });

  it("blocks status-only recovery runs from creating approvals", async () => {
    const res = await request(await createAgentApp({
      contextSnapshot: {
        modelProfile: "cheap",
        recoveryIntent: "status_only",
        allowDeliverableWork: false,
        allowDocumentUpdates: false,
        resumeRequiresNormalModel: true,
      },
    }))
      .post("/api/companies/company-1/approvals")
      .send({
        type: "request_board_approval",
        payload: { title: "Approve hosting spend" },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toContain("Cheap status-only recovery runs cannot create or modify approvals");
    expect(mockApprovalService.create).not.toHaveBeenCalled();
    expect(mockIssueApprovalService.linkManyForApproval).not.toHaveBeenCalled();
  });

  it("blocks status-only recovery runs from resubmitting approvals", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-7",
      companyId: "company-1",
      type: "request_board_approval",
      status: "revision_requested",
      payload: {},
      requestedByAgentId: "agent-1",
    });

    const res = await request(await createAgentApp({
      contextSnapshot: {
        modelProfile: "cheap",
        recoveryIntent: "status_only",
        allowDeliverableWork: false,
        allowDocumentUpdates: false,
        resumeRequiresNormalModel: true,
      },
    }))
      .post("/api/approvals/approval-7/resubmit")
      .send({ payload: { title: "Retry" } });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toContain("Cheap status-only recovery runs cannot create or modify approvals");
    expect(mockApprovalService.resubmit).not.toHaveBeenCalled();
  });

  it("blocks status-only recovery runs from commenting on approvals", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-8",
      companyId: "company-1",
      type: "request_board_approval",
      status: "pending",
      payload: {},
      requestedByAgentId: "agent-1",
    });

    const res = await request(await createAgentApp({
      contextSnapshot: {
        modelProfile: "cheap",
        recoveryIntent: "status_only",
        allowDeliverableWork: false,
        allowDocumentUpdates: false,
        resumeRequiresNormalModel: true,
      },
    }))
      .post("/api/approvals/approval-8/comments")
      .send({ body: "please approve" });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toContain("Cheap status-only recovery runs cannot create or modify approvals");
    expect(mockApprovalService.addComment).not.toHaveBeenCalled();
  });
});
