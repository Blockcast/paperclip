import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// BLO-18858: paperclipInboxLite's tool description claimed it returned in_review work while the
// route filtered to todo/in_progress/blocked. An agent with only in_review assignments therefore
// read the (correct) empty response as a platform failure, hand-rolled a checkout-lock-blind
// issue-list sweep, and duplicated a concurrent run's work. The filter is deliberate — review
// waits resume via comment/interaction/monitor wakes — so lock the status set here to keep the
// route and its documented contract from drifting apart again.
const EXPECTED_INBOX_LITE_STATUS_FILTER = "todo,in_progress,blocked";

const mockIssueService = vi.hoisted(() => ({
  list: vi.fn(),
  listDependencyReadiness: vi.fn(),
}));

const mockRecoveryActionService = vi.hoisted(() => ({
  listActiveForIssues: vi.fn(),
}));

function registerModuleMocks() {
  vi.doMock("../routes/authz.js", async () => vi.importActual("../routes/authz.js"));
  vi.doMock("../services/index.js", () => ({
    agentService: () => ({}),
    agentInstructionsService: () => ({}),
    accessService: () => ({
      canUser: vi.fn(async () => true),
      hasPermission: vi.fn(async () => true),
      decide: vi.fn(async () => ({ allowed: true, reason: "allow_explicit_grant" })),
    }),
    approvalService: () => ({}),
    budgetService: () => ({}),
    companySkillService: () => ({ listRuntimeSkillEntries: vi.fn() }),
    heartbeatService: () => ({}),
    ISSUE_LIST_DEFAULT_LIMIT: 100,
    issueApprovalService: () => ({}),
    issueRecoveryActionService: () => mockRecoveryActionService,
    issueService: () => mockIssueService,
    logActivity: vi.fn(),
    syncInstructionsBundleConfigFromFilePath: vi.fn((_agent, config) => config),
    workspaceOperationService: () => ({}),
  }));
  vi.doMock("../adapters/index.js", () => ({
    findServerAdapter: vi.fn(),
    findActiveServerAdapter: vi.fn(),
    listAdapterModels: vi.fn(),
    detectAdapterModel: vi.fn(),
    requireServerAdapter: vi.fn(),
  }));
}

async function createApp() {
  const [{ agentRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/agents.js")>("../routes/agents.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      runId: "run-1",
      source: "agent_jwt",
    };
    next();
  });
  app.use("/api", agentRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("GET /api/agents/me/inbox-lite status contract", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../adapters/index.js");
    vi.doUnmock("../routes/agents.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockIssueService.list.mockResolvedValue([]);
    mockIssueService.listDependencyReadiness.mockResolvedValue(new Map());
    mockRecoveryActionService.listActiveForIssues.mockResolvedValue(new Map());
  });

  it("queries only todo, in_progress, and blocked for the calling agent", async () => {
    const res = await request(await createApp()).get("/api/agents/me/inbox-lite");

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockIssueService.list).toHaveBeenCalledTimes(1);
    const [companyId, filters] = mockIssueService.list.mock.calls[0]!;
    expect(companyId).toBe("company-1");
    expect(filters.assigneeAgentId).toBe("agent-1");
    expect(filters.status).toBe(EXPECTED_INBOX_LITE_STATUS_FILTER);
    // The load-bearing assertion: in_review must not leak into the routine heartbeat inbox.
    expect(filters.status.split(",")).not.toContain("in_review");
  });

  it("returns an empty array — not an error — when the agent only has in_review work", async () => {
    // The exact shape that misled the incident run. Empty here means "nothing actionable",
    // and callers must treat it as a clean exit rather than a reason to sweep.
    mockIssueService.list.mockResolvedValue([]);

    const res = await request(await createApp()).get("/api/agents/me/inbox-lite");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("surfaces activeRun and dependency readiness so callers can skip run-owned work", async () => {
    mockIssueService.list.mockResolvedValue([
      {
        id: "issue-1",
        identifier: "BLO-1",
        title: "Owned by another run",
        status: "in_progress",
        priority: "high",
        projectId: null,
        goalId: null,
        parentId: null,
        updatedAt: "2026-07-30T01:41:56.125Z",
        activeRun: { id: "run-other", status: "running" },
      },
    ]);
    mockIssueService.listDependencyReadiness.mockResolvedValue(
      new Map([["issue-1", { isDependencyReady: false, unresolvedBlockerCount: 2, unresolvedBlockerIssueIds: ["b1", "b2"] }]]),
    );

    const res = await request(await createApp()).get("/api/agents/me/inbox-lite");

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      id: "issue-1",
      activeRun: { id: "run-other", status: "running" },
      dependencyReady: false,
      unresolvedBlockerCount: 2,
      unresolvedBlockerIssueIds: ["b1", "b2"],
    });
  });

  it("rejects non-agent actors", async () => {
    const [{ agentRoutes }, { errorHandler }] = await Promise.all([
      vi.importActual<typeof import("../routes/agents.js")>("../routes/agents.js"),
      vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    ]);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = { type: "board", userId: "board-user", companyIds: ["company-1"] };
      next();
    });
    app.use("/api", agentRoutes({} as any));
    app.use(errorHandler);

    const res = await request(app).get("/api/agents/me/inbox-lite");

    expect(res.status).toBe(401);
    expect(mockIssueService.list).not.toHaveBeenCalled();
  });
});
