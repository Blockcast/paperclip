// PEN-4902: the company run-list route's silently-dropped query parameters.
//
// `GET /companies/:companyId/heartbeat-runs?from=…&to=…&countOnly=true`
// returned 200 with the newest rows in the company and ignored all three
// parameters -- the route read `companyId`, `agentId`, `limit` and `summary`
// and nothing else. The failure mode is the one this row has now catalogued
// four times: an instrument that cannot say "I ignored you" answers
// confidently in a shape the caller cannot distinguish from a correct one.
//
// The window SEMANTICS are pinned against a real database in
// `pen4902-heartbeat-run-window.test.ts`. What is pinned here is the thing
// that was actually broken: the route passing the parameters on at all, and
// refusing rather than guessing when it cannot parse one.
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockAgentService = vi.hoisted(() => ({ getById: vi.fn() }));
const mockHeartbeatService = vi.hoisted(() => ({
  buildRunOutputSilence: vi.fn(),
  decorateActiveRunStatus: vi.fn(),
  getRetryExhaustedReason: vi.fn(),
  getRetrySuccessor: vi.fn(),
  cancelRun: vi.fn(),
  getRun: vi.fn(),
  getRunIssueSummary: vi.fn(),
  getActiveRunIssueSummaryForAgent: vi.fn(),
  getRunLogAccess: vi.fn(),
  list: vi.fn(),
  countRuns: vi.fn(),
  listEvents: vi.fn(),
  readLog: vi.fn(),
}));
const mockWorkspaceOperationService = vi.hoisted(() => ({
  listForRun: vi.fn(),
  listForExecutionWorkspace: vi.fn(),
  getById: vi.fn(),
  readLog: vi.fn(),
  owningAgentIdsByRunId: vi.fn(),
}));
const mockExecutionWorkspaceService = vi.hoisted(() => ({ getById: vi.fn() }));
const mockInstanceSettingsService = vi.hoisted(() => ({
  get: vi.fn(),
  getExperimental: vi.fn(),
  getGeneral: vi.fn(),
  listCompanyIds: vi.fn(),
}));
const mockIssueService = vi.hoisted(() => ({ getById: vi.fn(), getByIdentifier: vi.fn() }));
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockDecide = vi.hoisted(() => vi.fn());

function registerModuleMocks() {
  vi.doMock("../routes/authz.js", async () => vi.importActual("../routes/authz.js"));
  vi.doMock("../services/agents.js", () => ({ agentService: () => mockAgentService }));
  vi.doMock("../services/heartbeat.js", () => ({
    heartbeatService: () => mockHeartbeatService,
    derivePaperclipPrReview: () => null,
  }));
  vi.doMock("../services/instance-settings.js", () => ({
    instanceSettingsService: () => mockInstanceSettingsService,
  }));
  vi.doMock("../services/issues.js", () => ({ issueService: () => mockIssueService }));
  vi.doMock("../services/index.js", () => ({
    agentService: () => mockAgentService,
    agentInstructionsService: () => ({}),
    accessService: () => ({
      canUser: vi.fn(async () => true),
      decide: mockDecide,
      hasPermission: vi.fn(async () => true),
    }),
    approvalService: () => ({}),
    builtInAgentService: () => ({ ensureCompanyDefaultAgentGrants: vi.fn() }),
    companySkillService: () => ({ listRuntimeSkillEntries: vi.fn() }),
    budgetService: () => ({}),
    heartbeatService: () => mockHeartbeatService,
    issueApprovalService: () => ({}),
    issueService: () => mockIssueService,
    logActivity: mockLogActivity,
    secretService: () => ({}),
    syncInstructionsBundleConfigFromFilePath: vi.fn((_agent: unknown, config: unknown) => config),
    workspaceOperationService: () => mockWorkspaceOperationService,
    executionWorkspaceService: () => mockExecutionWorkspaceService,
  }));
  vi.doMock("../adapters/index.js", () => ({
    findServerAdapter: vi.fn(),
    listAdapterModels: vi.fn(),
    detectAdapterModel: vi.fn(),
    findActiveServerAdapter: vi.fn(),
    requireServerAdapter: vi.fn(),
  }));
}

const boardActor = {
  type: "board",
  userId: "local-board",
  companyIds: ["company-1"],
  source: "local_implicit",
  isInstanceAdmin: false,
};

async function createApp() {
  const [{ agentRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/agents.js")>("../routes/agents.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = { ...boardActor, companyIds: [...boardActor.companyIds] };
    next();
  });
  app.use("/api", agentRoutes({} as never, {} as never));
  app.use(errorHandler);
  return app;
}

describe("heartbeat-run list query parameters (PEN-4902)", () => {
  beforeEach(() => {
    vi.resetModules();
    for (const mod of [
      "../services/agents.js",
      "../services/heartbeat.js",
      "../services/index.js",
      "../services/instance-settings.js",
      "../services/issues.js",
      "../adapters/index.js",
      "../routes/agents.js",
      "../routes/authz.js",
    ]) {
      vi.doUnmock(mod);
    }
    registerModuleMocks();
    vi.clearAllMocks();
    mockLogActivity.mockResolvedValue(undefined);
    mockDecide.mockResolvedValue({
      allowed: true,
      action: "run:read_transcript",
      reason: "allow_test",
      explanation: "Allowed by test mock.",
    });
    mockHeartbeatService.list.mockResolvedValue([]);
    mockHeartbeatService.countRuns.mockResolvedValue(0);
  });

  it("passes `from` and `to` through to the run list", async () => {
    const app = await createApp();
    const res = await request(app)
      .get("/api/companies/company-1/heartbeat-runs")
      .query({ from: "2026-11-02T00:00:00.000Z", to: "2026-11-03T00:00:00.000Z" });

    expect(res.status).toBe(200);
    expect(mockHeartbeatService.list).toHaveBeenCalledTimes(1);
    expect(mockHeartbeatService.list.mock.calls[0]?.[3]).toMatchObject({
      from: new Date("2026-11-02T00:00:00.000Z"),
      to: new Date("2026-11-03T00:00:00.000Z"),
    });
  });

  it("leaves the window unset when neither bound is supplied", async () => {
    const app = await createApp();
    const res = await request(app).get("/api/companies/company-1/heartbeat-runs");

    expect(res.status).toBe(200);
    const options = mockHeartbeatService.list.mock.calls[0]?.[3] as Record<string, unknown>;
    expect(options.from).toBeUndefined();
    expect(options.to).toBeUndefined();
  });

  it("answers `countOnly` with a count for the window instead of the rows", async () => {
    mockHeartbeatService.countRuns.mockResolvedValue(42);
    const app = await createApp();
    const res = await request(app)
      .get("/api/companies/company-1/heartbeat-runs")
      .query({ agentId: "agent-9", from: "2026-11-02T00:00:00.000Z", countOnly: "true" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ count: 42 });
    expect(mockHeartbeatService.countRuns).toHaveBeenCalledWith(
      "company-1",
      "agent-9",
      expect.objectContaining({ from: new Date("2026-11-02T00:00:00.000Z") }),
    );
    // The whole point of `countOnly` is not paying for the rows.
    expect(mockHeartbeatService.list).not.toHaveBeenCalled();
  });

  it("rejects an unparseable bound rather than silently reading the whole table", async () => {
    const app = await createApp();
    const res = await request(app)
      .get("/api/companies/company-1/heartbeat-runs")
      .query({ from: "last tuesday" });

    expect(res.status).toBe(400);
    expect(mockHeartbeatService.list).not.toHaveBeenCalled();
  });
});
