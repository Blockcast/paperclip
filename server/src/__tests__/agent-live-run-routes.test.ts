import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  buildRunOutputSilence: vi.fn(),
  decorateActiveRunStatus: vi.fn(),
  getRunIssueSummary: vi.fn(),
  getActiveRunIssueSummaryForAgent: vi.fn(),
  getRunLogAccess: vi.fn(),
  readLog: vi.fn(),
  wakeup: vi.fn(),
}));

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  getByIdentifier: vi.fn(),
}));

const mockInstanceSettingsService = vi.hoisted(() => ({
  get: vi.fn(),
  getExperimental: vi.fn(),
  getGeneral: vi.fn(),
  listCompanyIds: vi.fn(),
}));
const mockLogActivity = vi.hoisted(() => vi.fn());

const routeAgentId = "11111111-1111-4111-8111-111111111111";

function registerModuleMocks() {
  vi.doMock("../routes/authz.js", async () => vi.importActual("../routes/authz.js"));

  vi.doMock("../services/agents.js", () => ({
    agentService: () => mockAgentService,
  }));

  vi.doMock("../services/heartbeat.js", () => ({
    heartbeatService: () => mockHeartbeatService,
    derivePaperclipPrReview: (context: Record<string, unknown> | null) => {
      if (!context || context.reviewKind !== "pr_review") return null;
      const prNumber = Number(context.githubPrNumber);
      if (!Number.isFinite(prNumber)) return null;
      return {
        repoFullName: context.githubRepoFullName ?? null,
        prNumber,
        headSha: context.githubHeadSha ?? null,
      };
    },
  }));

  vi.doMock("../services/instance-settings.js", () => ({
    instanceSettingsService: () => mockInstanceSettingsService,
  }));

  vi.doMock("../services/issues.js", () => ({
    issueService: () => mockIssueService,
  }));

  vi.doMock("../services/index.js", () => ({
    agentService: () => mockAgentService,
    agentInstructionsService: () => ({}),
    accessService: () => ({
      canUser: vi.fn(async () => true),
      decide: vi.fn(async (input: { action?: string }) => ({
        allowed: true,
        action: input.action,
        reason: "allow_explicit_grant",
        explanation: "Allowed by test grant.",
      })),
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
    syncInstructionsBundleConfigFromFilePath: vi.fn((_agent, config) => config),
    workspaceOperationService: () => ({}),
  }));

  vi.doMock("../adapters/index.js", () => ({
    findServerAdapter: vi.fn(),
    listAdapterModels: vi.fn(),
    detectAdapterModel: vi.fn(),
    findActiveServerAdapter: vi.fn(),
    requireServerAdapter: vi.fn(),
  }));
}

async function createApp(
  db: Record<string, unknown> = {},
  actor: Record<string, unknown> = {
    type: "board",
    userId: "local-board",
    companyIds: ["company-1"],
    source: "local_implicit",
    isInstanceAdmin: false,
  },
) {
  const [{ agentRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/agents.js")>("../routes/agents.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      ...actor,
      companyIds: Array.isArray(actor.companyIds) ? [...actor.companyIds] : actor.companyIds,
    };
    next();
  });
  app.use("/api", agentRoutes(db as any));
  app.use(errorHandler);
  return app;
}

function createLiveRunsDbStub(rows: Array<Record<string, unknown>>) {
  const limit = vi.fn<(value: number) => unknown>();
  const offset = vi.fn<(value: number) => unknown>();

  return {
    db: {
      select: vi.fn().mockImplementation(() => {
        let queryLimit: number | undefined;
        let queryOffset = 0;
        const orderedQuery = {
          limit: (value: number) => {
            limit(value);
            queryLimit = value;
            return orderedQuery;
          },
          offset: (value: number) => {
            offset(value);
            queryOffset = value;
            return orderedQuery;
          },
          then: (resolve: (value: Array<Record<string, unknown>>) => unknown) => Promise.resolve(
            rows.slice(queryOffset, queryLimit === undefined ? undefined : queryOffset + queryLimit),
          ).then(resolve),
        };
        return {
          from: vi.fn().mockReturnThis(),
          innerJoin: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          orderBy: vi.fn().mockReturnValue(orderedQuery),
        };
      }),
    },
    limit,
    offset,
  };
}

async function requestApp(
  app: express.Express,
  buildRequest: (baseUrl: string) => request.Test,
) {
  const { createServer } = await vi.importActual<typeof import("node:http")>("node:http");
  const server = createServer(app);
  try {
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected HTTP server to listen on a TCP port");
    }
    return await buildRequest(`http://127.0.0.1:${address.port}`);
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  }
}

describe("agent live run routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/agents.js");
    vi.doUnmock("../services/heartbeat.js");
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../services/instance-settings.js");
    vi.doUnmock("../services/issues.js");
    vi.doUnmock("../adapters/index.js");
    vi.doUnmock("../routes/agents.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockLogActivity.mockResolvedValue(undefined);
    mockIssueService.getByIdentifier.mockResolvedValue({
      id: "issue-1",
      companyId: "company-1",
      executionRunId: "run-1",
      assigneeAgentId: "agent-1",
      status: "in_progress",
    });
    mockIssueService.getById.mockResolvedValue(null);
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      companyId: "company-1",
      name: "Builder",
      adapterType: "codex_local",
    });
    mockInstanceSettingsService.get.mockResolvedValue({
      id: "instance-settings-1",
      general: {
        censorUsernameInLogs: false,
        feedbackDataSharingPreference: "prompt",
      },
    });
    mockInstanceSettingsService.getExperimental.mockResolvedValue({});
    mockInstanceSettingsService.getGeneral.mockResolvedValue({
      censorUsernameInLogs: false,
      feedbackDataSharingPreference: "prompt",
    });
    mockInstanceSettingsService.listCompanyIds.mockResolvedValue(["company-1"]);
    mockHeartbeatService.buildRunOutputSilence.mockResolvedValue(null);
    mockHeartbeatService.decorateActiveRunStatus.mockImplementation((run) => ({
      ...run,
      currentStatusMessage: null,
      currentStatusUpdatedAt: null,
    }));
    mockHeartbeatService.getRunIssueSummary.mockResolvedValue({
      id: "run-1",
      status: "running",
      invocationSource: "on_demand",
      triggerDetail: "manual",
      contextCommentId: "comment-1",
      contextWakeCommentId: "comment-1",
      startedAt: new Date("2026-04-10T09:30:00.000Z"),
      finishedAt: null,
      createdAt: new Date("2026-04-10T09:29:59.000Z"),
      agentId: "agent-1",
      issueId: "issue-1",
    });
    mockHeartbeatService.getActiveRunIssueSummaryForAgent.mockResolvedValue(null);
    mockHeartbeatService.buildRunOutputSilence.mockResolvedValue(null);
    mockHeartbeatService.getRunLogAccess.mockResolvedValue({
      id: "run-1",
      companyId: "company-1",
      logStore: "local_file",
      logRef: "logs/run-1.ndjson",
    });
    mockHeartbeatService.readLog.mockResolvedValue({
      runId: "run-1",
      store: "local_file",
      logRef: "logs/run-1.ndjson",
      content: "chunk",
      nextOffset: 5,
    });
    mockHeartbeatService.wakeup.mockResolvedValue({
      id: "run-1",
      companyId: "company-1",
      agentId: "agent-1",
      status: "queued",
      invocationSource: "on_demand",
      triggerDetail: "manual",
    });
  });

  it("returns a compact active run payload for issue polling", async () => {
    const res = await requestApp(
      await createApp(),
      (baseUrl) => request(baseUrl).get("/api/issues/pc1a2-1295/active-run"),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockIssueService.getByIdentifier).toHaveBeenCalledWith("PC1A2-1295");
    expect(mockHeartbeatService.getRunIssueSummary).toHaveBeenCalledWith("run-1");
    expect(res.body).toMatchObject({
      id: "run-1",
      status: "running",
      invocationSource: "on_demand",
      triggerDetail: "manual",
      contextCommentId: "comment-1",
      contextWakeCommentId: "comment-1",
      startedAt: "2026-04-10T09:30:00.000Z",
      finishedAt: null,
      createdAt: "2026-04-10T09:29:59.000Z",
      agentId: "agent-1",
      issueId: "issue-1",
      agentName: "Builder",
      adapterType: "codex_local",
      outputSilence: null,
      currentStatusMessage: null,
      currentStatusUpdatedAt: null,
    });
    expect(res.body).not.toHaveProperty("resultJson");
    expect(res.body).not.toHaveProperty("contextSnapshot");
    expect(res.body).not.toHaveProperty("logRef");
  }, 60_000);

  it("ignores a stale execution run from another issue and falls back to the assignee's matching run", async () => {
    mockHeartbeatService.getRunIssueSummary.mockResolvedValue({
      id: "run-foreign",
      status: "running",
      invocationSource: "assignment",
      triggerDetail: "callback",
      startedAt: new Date("2026-04-10T10:00:00.000Z"),
      finishedAt: null,
      createdAt: new Date("2026-04-10T09:59:00.000Z"),
      agentId: "agent-1",
      issueId: "issue-2",
    });
    mockHeartbeatService.getActiveRunIssueSummaryForAgent.mockResolvedValue({
      id: "run-1",
      status: "running",
      invocationSource: "on_demand",
      triggerDetail: "manual",
      startedAt: new Date("2026-04-10T09:30:00.000Z"),
      finishedAt: null,
      createdAt: new Date("2026-04-10T09:29:59.000Z"),
      agentId: "agent-1",
      issueId: "issue-1",
    });

    const res = await requestApp(
      await createApp(),
      (baseUrl) => request(baseUrl).get("/api/issues/PC1A2-1295/active-run"),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockHeartbeatService.getRunIssueSummary).toHaveBeenCalledWith("run-1");
    expect(mockHeartbeatService.getActiveRunIssueSummaryForAgent).toHaveBeenCalledWith("agent-1");
    expect(res.body).toMatchObject({
      id: "run-1",
      issueId: "issue-1",
      agentId: "agent-1",
      agentName: "Builder",
      adapterType: "codex_local",
    });
  });

  it("includes ephemeral current status fields on active run polling", async () => {
    mockHeartbeatService.decorateActiveRunStatus.mockImplementation((run) => ({
      ...run,
      currentStatusMessage: "Syncing workspace to sandbox",
      currentStatusUpdatedAt: new Date("2026-04-10T09:30:05.000Z"),
      currentToolName: "bash",
      lastAssistantSnippet: "Inspecting files",
      lastEventAt: new Date("2026-04-10T09:30:06.000Z"),
    }));

    const res = await requestApp(
      await createApp(),
      (baseUrl) => request(baseUrl).get("/api/issues/PC1A2-1295/active-run"),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockHeartbeatService.decorateActiveRunStatus).toHaveBeenCalledWith(
      expect.objectContaining({ id: "run-1", issueId: "issue-1" }),
      { companyId: "company-1", issueId: "issue-1" },
    );
    expect(res.body).toMatchObject({
      currentStatusMessage: "Syncing workspace to sandbox",
      currentStatusUpdatedAt: "2026-04-10T09:30:05.000Z",
      currentToolName: "bash",
      lastAssistantSnippet: "Inspecting files",
      lastEventAt: "2026-04-10T09:30:06.000Z",
    });
  });

  it("uses narrow run log metadata lookups for log polling", async () => {
    const res = await requestApp(
      await createApp(),
      (baseUrl) => request(baseUrl).get("/api/heartbeat-runs/run-1/log?offset=12&limitBytes=64"),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockHeartbeatService.getRunLogAccess).toHaveBeenCalledWith("run-1");
    expect(mockHeartbeatService.readLog).toHaveBeenCalledWith({
      id: "run-1",
      companyId: "company-1",
      logStore: "local_file",
      logRef: "logs/run-1.ndjson",
    }, {
      offset: 12,
      limitBytes: 64,
    });
    expect(res.body).toEqual({
      runId: "run-1",
      store: "local_file",
      logRef: "logs/run-1.ndjson",
      content: "chunk",
      nextOffset: 5,
    });
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      companyId: "company-1",
      actorType: "user",
      actorId: "local-board",
      agentId: null,
      action: "heartbeat.run_log_accessed",
      entityType: "heartbeat_run",
      entityId: "run-1",
      runId: "run-1",
      details: expect.objectContaining({
        result: "allowed",
        actorSource: "local_implicit",
        offset: 12,
        limitBytes: 64,
        logStore: "local_file",
      }),
    }));
    expect(mockLogActivity.mock.calls[0]?.[1]?.details).not.toHaveProperty("content");
    expect(mockLogActivity.mock.calls[0]?.[1]?.details).not.toHaveProperty("logRef");
  });

  it("audits denied run log access without reading content", async () => {
    const res = await requestApp(
      await createApp({}, {
        type: "agent",
        agentId: routeAgentId,
        companyId: "company-2",
        source: "agent_key",
        runId: "actor-run-1",
      }),
      (baseUrl) => request(baseUrl).get("/api/heartbeat-runs/run-1/log?offset=4&limitBytes=32"),
    );

    expect(res.status).toBe(404);
    expect(mockHeartbeatService.readLog).not.toHaveBeenCalled();
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      companyId: "company-1",
      actorType: "agent",
      actorId: routeAgentId,
      agentId: routeAgentId,
      action: "heartbeat.run_log_accessed",
      entityType: "heartbeat_run",
      entityId: "run-1",
      runId: "run-1",
      details: expect.objectContaining({
        result: "denied",
        actorSource: "agent_key",
        actorRunId: "actor-run-1",
        offset: 4,
        limitBytes: 32,
        logStore: "local_file",
      }),
    }));
    expect(mockLogActivity.mock.calls[0]?.[1]?.details).not.toHaveProperty("content");
    expect(mockLogActivity.mock.calls[0]?.[1]?.details).not.toHaveProperty("logRef");
  });

  it("caps company live run polling by default", async () => {
    const rows = Array.from({ length: 75 }, (_, index) => ({
      id: `run-${index}`,
      companyId: "company-1",
      status: "running",
      invocationSource: "on_demand",
      triggerDetail: "manual",
      startedAt: new Date("2026-04-10T09:30:00.000Z"),
      finishedAt: null,
      createdAt: new Date(`2026-04-10T09:${String(index % 60).padStart(2, "0")}:00.000Z`),
      agentId: "agent-1",
      agentName: "Builder",
      adapterType: "codex_local",
      logBytes: 0,
      livenessState: "healthy",
      livenessReason: null,
      continuationAttempt: 0,
      lastUsefulActionAt: null,
      nextAction: null,
      lastOutputAt: null,
      lastOutputSeq: null,
      lastOutputStream: null,
      lastOutputBytes: 0,
      processStartedAt: null,
      issueId: "issue-1",
    }));
    const { db, limit } = createLiveRunsDbStub(rows);

    const res = await requestApp(
      await createApp(db),
      (baseUrl) => request(baseUrl).get("/api/companies/company-1/live-runs"),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(limit).toHaveBeenCalledWith(50);
    expect(res.body).toHaveLength(50);
    expect(mockHeartbeatService.buildRunOutputSilence).toHaveBeenCalledTimes(50);
  });

  it("treats explicit zero or invalid live run limit as the capped default", async () => {
    const rows = Array.from({ length: 75 }, (_, index) => ({
      id: `run-${index}`,
      companyId: "company-1",
      status: "running",
      invocationSource: "on_demand",
      triggerDetail: "manual",
      startedAt: new Date("2026-04-10T09:30:00.000Z"),
      finishedAt: null,
      createdAt: new Date(`2026-04-10T09:${String(index % 60).padStart(2, "0")}:00.000Z`),
      agentId: "agent-1",
      agentName: "Builder",
      adapterType: "codex_local",
      logBytes: 0,
      livenessState: "healthy",
      livenessReason: null,
      continuationAttempt: 0,
      lastUsefulActionAt: null,
      nextAction: null,
      lastOutputAt: null,
      lastOutputSeq: null,
      lastOutputStream: null,
      lastOutputBytes: 0,
      processStartedAt: null,
      issueId: "issue-1",
    }));
    const { db, limit } = createLiveRunsDbStub(rows);

    const res = await requestApp(
      await createApp(db),
      (baseUrl) => request(baseUrl).get("/api/companies/company-1/live-runs?limit=0&minCount=0"),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(limit).toHaveBeenCalledWith(50);
    expect(res.body).toHaveLength(50);
  });

  it("does not pad with recent runs when no minCount is requested", async () => {
    const liveRows = Array.from({ length: 8 }, (_, index) => ({
      id: `run-live-${index}`,
      companyId: "company-1",
      status: "running",
      invocationSource: "on_demand",
      triggerDetail: "manual",
      startedAt: new Date("2026-04-10T09:30:00.000Z"),
      finishedAt: null,
      createdAt: new Date(`2026-04-10T09:${String(index % 60).padStart(2, "0")}:00.000Z`),
      agentId: "agent-1",
      agentName: "Builder",
      adapterType: "codex_local",
      logBytes: 0,
      livenessState: "healthy",
      livenessReason: null,
      continuationAttempt: 0,
      lastUsefulActionAt: null,
      nextAction: null,
      lastOutputAt: null,
      lastOutputSeq: null,
      lastOutputStream: null,
      lastOutputBytes: 0,
      processStartedAt: null,
      issueId: "issue-1",
    }));

    const selectCalls: Array<ReturnType<typeof vi.fn>> = [];
    const db = {
      select: vi.fn().mockImplementation(() => {
        const limitFn = vi.fn(async (value: number) => liveRows.slice(0, value));
        const orderedQuery = {
          limit: limitFn,
          then: (resolve: (value: typeof liveRows) => unknown) =>
            Promise.resolve(liveRows).then(resolve),
        };
        const query = {
          from: vi.fn().mockReturnThis(),
          innerJoin: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          orderBy: vi.fn().mockReturnValue(orderedQuery),
        };
        selectCalls.push(limitFn);
        return query;
      }),
    };

    const res = await requestApp(
      await createApp(db),
      (baseUrl) => request(baseUrl).get("/api/companies/company-1/live-runs"),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toHaveLength(8);
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it("pads with recent runs when minCount is explicitly requested", async () => {
    const liveRows = Array.from({ length: 2 }, (_, index) => ({
      id: `run-live-${index}`,
      companyId: "company-1",
      status: "running",
      invocationSource: "on_demand",
      triggerDetail: "manual",
      startedAt: new Date("2026-04-10T09:30:00.000Z"),
      finishedAt: null,
      createdAt: new Date(`2026-04-10T09:${String(index % 60).padStart(2, "0")}:00.000Z`),
      agentId: "agent-1",
      agentName: "Builder",
      adapterType: "codex_local",
      logBytes: 0,
      livenessState: "healthy",
      livenessReason: null,
      continuationAttempt: 0,
      lastUsefulActionAt: null,
      nextAction: null,
      lastOutputAt: null,
      lastOutputSeq: null,
      lastOutputStream: null,
      lastOutputBytes: 0,
      processStartedAt: null,
      issueId: "issue-1",
    }));
    const recentRows = Array.from({ length: 4 }, (_, index) => ({
      id: `run-recent-${index}`,
      companyId: "company-1",
      status: "succeeded",
      invocationSource: "on_demand",
      triggerDetail: "manual",
      startedAt: new Date("2026-04-09T09:30:00.000Z"),
      finishedAt: new Date("2026-04-09T09:35:00.000Z"),
      createdAt: new Date(`2026-04-09T09:${String(index % 60).padStart(2, "0")}:00.000Z`),
      agentId: "agent-1",
      agentName: "Builder",
      adapterType: "codex_local",
      logBytes: 0,
      livenessState: "healthy",
      livenessReason: null,
      continuationAttempt: 0,
      lastUsefulActionAt: null,
      nextAction: null,
      lastOutputAt: null,
      lastOutputSeq: null,
      lastOutputStream: null,
      lastOutputBytes: 0,
      processStartedAt: null,
      issueId: "issue-1",
    }));

    let selectCallCount = 0;
    const db = {
      select: vi.fn().mockImplementation(() => {
        selectCallCount += 1;
        const rows = selectCallCount === 1 ? liveRows : recentRows;
        const limitFn = vi.fn(async (value: number) => rows.slice(0, value));
        const orderedQuery = {
          limit: limitFn,
          then: (resolve: (value: typeof rows) => unknown) =>
            Promise.resolve(rows).then(resolve),
        };
        return {
          from: vi.fn().mockReturnThis(),
          innerJoin: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          orderBy: vi.fn().mockReturnValue(orderedQuery),
        };
      }),
    };

    const res = await requestApp(
      await createApp(db),
      (baseUrl) => request(baseUrl).get("/api/companies/company-1/live-runs?minCount=4"),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toHaveLength(4);
    expect(db.select).toHaveBeenCalledTimes(2);
  });

  it("passes scoped wake fields through the legacy heartbeat invoke route", async () => {
    const res = await requestApp(
      await createApp(),
      (baseUrl) => request(baseUrl)
        .post(`/api/agents/${routeAgentId}/heartbeat/invoke?companyId=company-1`)
        .send({
          reason: "issue_assigned",
          payload: {
            issueId: "issue-1",
            taskId: "issue-1",
            taskKey: "issue-1",
          },
          forceFreshSession: true,
        }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(202);
    // The legacy /heartbeat/invoke endpoint forwards only the wake fields the
    // caller actually supplied so empty-body callers (e.g. e2e suites) match
    // the original fixed-arg `heartbeat.invoke()` shape exactly. When the
    // caller supplies reason / payload / forceFreshSession those are
    // forwarded; idempotencyKey is omitted unless explicitly set.
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(routeAgentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "issue_assigned",
      payload: {
        issueId: "issue-1",
        taskId: "issue-1",
        taskKey: "issue-1",
      },
      requestedByActorType: "user",
      requestedByActorId: "local-board",
      contextSnapshot: {
        triggeredBy: "board",
        actorId: "local-board",
        forceFreshSession: true,
      },
    });
  });

  it("calls heartbeat.wakeup with the legacy minimal shape when the body is empty", async () => {
    const res = await requestApp(
      await createApp(),
      (baseUrl) => request(baseUrl)
        .post(`/api/agents/${routeAgentId}/heartbeat/invoke?companyId=company-1`)
        .send({}),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(routeAgentId, {
      source: "on_demand",
      triggerDetail: "manual",
      requestedByActorType: "user",
      requestedByActorId: "local-board",
      contextSnapshot: {
        triggeredBy: "board",
        actorId: "local-board",
      },
    });
  });
});

describe("PR review queue observability route", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/agents.js");
    vi.doUnmock("../services/heartbeat.js");
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../services/instance-settings.js");
    vi.doUnmock("../services/issues.js");
    vi.doUnmock("../adapters/index.js");
    vi.doUnmock("../routes/agents.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
  });

  it("groups queued, running, and terminal PR-review runs by reviewer", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-25T12:00:00.000Z"));
    const contextSnapshot = {
      reviewKind: "pr_review",
      githubRepoFullName: "Blockcast/paperclip",
      githubPrNumber: 812,
      githubHeadSha: "abcdef123456",
    };
    const { db } = createLiveRunsDbStub([
      {
        id: "queued-old",
        agentId: routeAgentId,
        agentName: "Ally",
        status: "queued",
        errorCode: null,
        contextSnapshot,
        createdAt: new Date("2026-07-25T11:20:00.000Z"),
        startedAt: null,
        finishedAt: null,
      },
      {
        id: "queued-new",
        agentId: routeAgentId,
        agentName: "Ally",
        status: "queued",
        errorCode: null,
        contextSnapshot,
        createdAt: new Date("2026-07-25T11:50:00.000Z"),
        startedAt: null,
        finishedAt: null,
      },
      {
        id: "running",
        agentId: routeAgentId,
        agentName: "Ally",
        status: "running",
        errorCode: null,
        contextSnapshot,
        createdAt: new Date("2026-07-25T11:40:00.000Z"),
        startedAt: new Date("2026-07-25T11:45:00.000Z"),
        finishedAt: null,
        scheduledRetryAt: null,
      },
      {
        id: "scheduled-retry",
        agentId: routeAgentId,
        agentName: "Ally",
        status: "scheduled_retry",
        errorCode: null,
        contextSnapshot,
        createdAt: new Date("2026-07-25T11:10:00.000Z"),
        startedAt: null,
        finishedAt: null,
        scheduledRetryAt: new Date("2026-07-25T12:10:00.000Z"),
      },
      {
        id: "succeeded",
        agentId: routeAgentId,
        agentName: "Ally",
        status: "succeeded",
        errorCode: null,
        contextSnapshot,
        createdAt: new Date("2026-07-25T10:00:00.000Z"),
        startedAt: new Date("2026-07-25T10:10:00.000Z"),
        finishedAt: new Date("2026-07-25T10:20:00.000Z"),
      },
      {
        id: "missing-output",
        agentId: routeAgentId,
        agentName: "Ally",
        status: "failed",
        errorCode: "pr_review_output_missing",
        contextSnapshot,
        createdAt: new Date("2026-07-25T09:00:00.000Z"),
        startedAt: new Date("2026-07-25T09:05:00.000Z"),
        finishedAt: new Date("2026-07-25T09:30:00.000Z"),
      },
      {
        id: "other-error",
        agentId: "22222222-2222-4222-8222-222222222222",
        agentName: "Second Reviewer",
        status: "failed",
        errorCode: "adapter_failed",
        contextSnapshot: { ...contextSnapshot, githubPrNumber: 813 },
        createdAt: new Date("2026-07-25T08:00:00.000Z"),
        startedAt: new Date("2026-07-25T08:01:00.000Z"),
        finishedAt: new Date("2026-07-25T08:04:00.000Z"),
      },
    ]);
    const app = await createApp(db);

    const res = await request(app).get("/api/companies/company-1/pr-review-queue");

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.generatedAt).toBe("2026-07-25T12:00:00.000Z");
    expect(res.body.agents).toHaveLength(2);
    expect(res.body.agents[0]).toMatchObject({
      agentId: routeAgentId,
      agentName: "Ally",
      queuedCount: 3,
      oldestQueuedAt: "2026-07-25T11:10:00.000Z",
      oldestQueuedAgeMs: 3_000_000,
    });
    expect(res.body.agents[0].runs.map((run: { disposition: string; ageMs: number }) => [run.disposition, run.ageMs]))
      .toEqual([
        ["queued", 600_000],
        ["dispatched", 1_200_000],
        ["queued", 2_400_000],
        ["scheduled_retry", 3_000_000],
        ["succeeded", 1_200_000],
        ["pr_review_output_missing", 1_800_000],
      ]);
    expect(res.body.agents[0].runs[0]).toMatchObject({
      repoFullName: "Blockcast/paperclip",
      prNumber: 812,
      headSha: "abcdef123456",
    });
    expect(res.body.agents[0].runs.find((run: { id: string }) => run.id === "scheduled-retry"))
      .toMatchObject({
        disposition: "scheduled_retry",
        scheduledRetryAt: "2026-07-25T12:10:00.000Z",
      });
    expect(res.body.agents[1]).toMatchObject({
      agentName: "Second Reviewer",
      queuedCount: 0,
      oldestQueuedAgeMs: null,
    });
    expect(res.body.agents[1].runs[0].disposition).toBe("adapter_failed");
    vi.useRealTimers();
  });

  it("does not let capped terminal history evict active runs", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-25T12:00:00.000Z"));
    const contextSnapshot = {
      reviewKind: "pr_review",
      githubRepoFullName: "Blockcast/paperclip",
      githubPrNumber: 812,
      githubHeadSha: "abcdef123456",
    };
    const terminal = (id: string, createdAt: string, context = contextSnapshot) => ({
      id,
      agentId: routeAgentId,
      agentName: "Ally",
      status: "succeeded",
      errorCode: null,
      contextSnapshot: context,
      createdAt: new Date(createdAt),
      startedAt: new Date(createdAt),
      finishedAt: new Date("2026-07-25T11:59:00.000Z"),
      scheduledRetryAt: null,
    });
    const { db } = createLiveRunsDbStub([
      terminal("malformed", "2026-07-25T11:58:00.000Z", { reviewKind: "pr_review" }),
      terminal("terminal-new", "2026-07-25T11:57:00.000Z"),
      terminal("terminal-old", "2026-07-25T11:56:00.000Z"),
      {
        id: "active-oldest",
        agentId: routeAgentId,
        agentName: "Ally",
        status: "queued",
        errorCode: null,
        contextSnapshot,
        createdAt: new Date("2026-07-25T08:00:00.000Z"),
        startedAt: null,
        finishedAt: null,
        scheduledRetryAt: null,
      },
    ]);
    const app = await createApp(db);

    const res = await request(app).get("/api/companies/company-1/pr-review-queue?limit=1");

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.agents[0]).toMatchObject({
      queuedCount: 1,
      oldestQueuedAt: "2026-07-25T08:00:00.000Z",
      oldestQueuedAgeMs: 14_400_000,
    });
    expect(res.body.agents[0].runs.map((run: { id: string }) => run.id))
      .toEqual(["terminal-new", "active-oldest"]);
    vi.useRealTimers();
  });

  it("pages terminal candidates in bounded batches until the limit is filled", async () => {
    const contextSnapshot = {
      reviewKind: "pr_review",
      githubRepoFullName: "Blockcast/paperclip",
      githubPrNumber: 812,
      githubHeadSha: "abcdef123456",
    };
    const terminal = (id: string, context: Record<string, unknown>) => ({
      id,
      agentId: routeAgentId,
      agentName: "Ally",
      status: "succeeded",
      errorCode: null,
      contextSnapshot: context,
      createdAt: new Date("2026-07-25T11:00:00.000Z"),
      startedAt: new Date("2026-07-25T11:01:00.000Z"),
      finishedAt: new Date("2026-07-25T11:02:00.000Z"),
      scheduledRetryAt: null,
    });
    const rows = [
      ...Array.from({ length: 100 }, (_, index) => terminal(`malformed-${index}`, { reviewKind: "pr_review" })),
      terminal("valid", contextSnapshot),
    ];
    const { db, limit, offset } = createLiveRunsDbStub(rows);
    const app = await createApp(db);

    const res = await request(app).get("/api/companies/company-1/pr-review-queue?limit=1");

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.agents[0].runs.map((run: { id: string }) => run.id)).toEqual(["valid"]);
    expect(limit).toHaveBeenCalledTimes(2);
    expect(limit).toHaveBeenNthCalledWith(1, 100);
    expect(limit).toHaveBeenNthCalledWith(2, 100);
    expect(offset.mock.calls).toEqual([[0], [100]]);
  });

  it("rejects agent credentials", async () => {
    const { db } = createLiveRunsDbStub([]);
    const app = await createApp(db, {
      type: "agent",
      agentId: routeAgentId,
      companyId: "company-1",
      source: "agent_jwt",
      runId: "run-1",
    });
    const res = await request(app).get("/api/companies/company-1/pr-review-queue");
    expect(res.status).toBe(403);
  });

  it("rejects board users outside the company boundary", async () => {
    const { db } = createLiveRunsDbStub([]);
    const app = await createApp(db, {
      type: "board",
      userId: "board-user",
      companyIds: ["company-2"],
      source: "session",
      isInstanceAdmin: false,
    });
    const res = await request(app).get("/api/companies/company-1/pr-review-queue");
    expect(res.status).toBe(403);
  });
});
