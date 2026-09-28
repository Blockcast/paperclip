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

/**
 * BLO-34631. `/workspace-operations/:operationId/log` was the only one of the four run/operation
 * log surfaces with neither a read-time projection nor an access audit — it answered with the
 * stored chunk verbatim and wrote nothing. These cover both, plus the entitled control.
 *
 * Every value below is invented; no real credential, command or path is quoted, per the parent
 * series' standing prohibition.
 */
const mockWorkspaceOperationService = vi.hoisted(() => ({
  getById: vi.fn(),
  readLog: vi.fn(),
}));

/**
 * Flippable so the entitled and unentitled readers are separate cases. The default allows
 * everything, which models the board actor the rest of this file drives with; denying only
 * `workspace_runtime:read` models a standard same-company agent, which holds `company_scope:read`
 * and `runtime:manage` but deliberately NOT this one (PEN-2852, `allow_company_agent`).
 */
const mockAccessDecide = vi.hoisted(() => vi.fn());

const routeAgentId = "11111111-1111-4111-8111-111111111111";

const WORKSPACE_OPERATION_LOG_SENTINEL =
  "TOKEN_FIXTURE=sentinel-operation-log-not-a-real-credential ./deploy.sh";

/**
 * BLO-35509. Source of truth: `server/src/routes/agents.ts` (`logRunLogAccessAudit`). Declared
 * once because two of the uses below are `not.toHaveBeenCalledWith` absence guards, and an
 * absence guard keyed on a literal nobody emits passes vacuously — a typo confined to that one
 * site is silent, since the positives hold their own copies and keep passing. Verified on
 * `master`: typo `:637` or `:780` alone and all 35 still pass. Sharing the const makes that
 * shape a reference error instead.
 */
const HEARTBEAT_RUN_LOG_ACCESSED = "heartbeat.run_log_accessed";
const WORKSPACE_OPERATION_LOG_ACCESSED = "workspace_operation.log_accessed";

function workspaceOperationLogFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "operation-1",
    companyId: "company-1",
    heartbeatRunId: "run-1",
    logStore: "local_file",
    logRef: "logs/operation-1.ndjson",
    ...overrides,
  };
}

function allowEveryAction() {
  mockAccessDecide.mockImplementation(async (input: { action?: string }) => ({
    allowed: true,
    action: input.action,
    reason: "allow_explicit_grant",
    explanation: "Allowed by test grant.",
  }));
}

function denyWorkspaceRuntimeRead() {
  mockAccessDecide.mockImplementation(async (input: { action?: string }) => ({
    allowed: input.action !== "workspace_runtime:read",
    action: input.action,
    reason: "test",
    explanation: "Allowed by test mock.",
  }));
}

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
      decide: mockAccessDecide,
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
    workspaceOperationService: () => mockWorkspaceOperationService,
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
  const orderBy = vi.fn<(...values: unknown[]) => unknown>();
  let detailQueryCount = 0;

  const db = {
    selectDistinctOn: vi.fn().mockImplementation(() => {
      const oldestQueuedByAgent = [
        ...rows
          .filter((row) => row.status === "queued" || row.status === "scheduled_retry")
          .sort((a, b) =>
            (a.createdAt as Date).getTime() - (b.createdAt as Date).getTime()
            || String(a.id).localeCompare(String(b.id))
          )
          .reduce((byAgent, row) => {
            if (!byAgent.has(String(row.agentId))) byAgent.set(String(row.agentId), row);
            return byAgent;
          }, new Map<string, Record<string, unknown>>())
          .values(),
      ];
      const orderedQuery = {
        then: (resolve: (value: Array<Record<string, unknown>>) => unknown) => Promise.resolve(oldestQueuedByAgent).then(resolve),
      };
      return {
        from: vi.fn().mockReturnThis(),
        innerJoin: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnValue(orderedQuery),
      };
    }),
    select: vi.fn().mockImplementation((columns: Record<string, unknown>) => {
      let queryLimit: number | undefined;
      const isSummary = "queuedCount" in columns;
      const isPrReviewDetail = "scheduledRetryAt" in columns && "contextSnapshot" in columns;
      if (isPrReviewDetail) detailQueryCount += 1;
      const isActiveDetail = isPrReviewDetail && detailQueryCount === 1;
      const parserValid = (row: Record<string, unknown>) => {
        const context = row.contextSnapshot as Record<string, unknown> | null;
        return context?.reviewKind === "pr_review" && Number.isFinite(Number(context.githubPrNumber));
      };
      const detailRows = (isPrReviewDetail
        ? rows
          .filter(parserValid)
          .filter((row) => isActiveDetail
            ? ["queued", "scheduled_retry", "running"].includes(String(row.status))
            : row.finishedAt != null)
        : rows)
        .sort((a, b) =>
          ((isPrReviewDetail && !isActiveDetail ? b.finishedAt : b.createdAt) as Date).getTime()
          - ((isPrReviewDetail && !isActiveDetail ? a.finishedAt : a.createdAt) as Date).getTime()
          || String(b.id).localeCompare(String(a.id))
        );
      const activeSummary = [...new Map(
        rows
          .filter((row) => ["queued", "scheduled_retry", "running"].includes(String(row.status)))
          .filter(parserValid)
          .map((row) => {
            const agentRows = rows.filter((candidate) =>
              candidate.agentId === row.agentId
              && ["queued", "scheduled_retry", "running"].includes(String(candidate.status))
              && Number.isFinite(Number((candidate.contextSnapshot as Record<string, unknown> | null)?.githubPrNumber))
            );
            const queuedRows = agentRows.filter((candidate) =>
              candidate.status === "queued" || candidate.status === "scheduled_retry"
            );
            return [row.agentId, {
              agentId: row.agentId,
              agentName: row.agentName,
              activeCount: agentRows.length,
              queuedCount: queuedRows.length,
              // BLO-20396: the real driver returns this aggregate as a
              // timestamp STRING, not a Date. `sql<Date | null>` only sets the
              // compile-time generic; drizzle's postgres-js mapper runs for
              // column references, not raw expressions. This stub used to hand
              // back a Date — reproducing the declared type instead of the
              // driver's actual output — which is exactly why the endpoint
              // could 500 in production on `oldestQueuedAt.getTime()` while
              // every test here passed.
              oldestQueuedAt: queuedRows.length > 0
                ? new Date(Math.min(...queuedRows.map((candidate) => (candidate.createdAt as Date).getTime())))
                  .toISOString()
                  .replace("T", " ")
                  .replace("Z", "+00")
                : null,
            }];
          }),
      ).values()];
      const orderedQuery = {
        limit: (value: number) => {
          limit(value);
          queryLimit = value;
          return orderedQuery;
        },
        then: (resolve: (value: Array<Record<string, unknown>>) => unknown) => Promise.resolve(
          detailRows.slice(0, queryLimit),
        ).then(resolve),
      };
      const query = {
        from: vi.fn().mockReturnThis(),
        innerJoin: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        groupBy: vi.fn().mockImplementation(() => Promise.resolve(activeSummary)),
        orderBy: (...values: unknown[]) => {
          orderBy(...values);
          return orderedQuery;
        },
      };
      return query;
    }),
  };
  const transaction = vi.fn(async (
    callback: (tx: typeof db) => Promise<unknown>,
  ) => callback(db));

  return {
    db: {
      ...db,
      transaction,
    },
    limit,
    orderBy,
    transaction,
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
    allowEveryAction();
    mockWorkspaceOperationService.getById.mockResolvedValue(workspaceOperationLogFixture());
    mockWorkspaceOperationService.readLog.mockResolvedValue({
      operationId: "operation-1",
      store: "local_file",
      logRef: "logs/operation-1.ndjson",
      content: WORKSPACE_OPERATION_LOG_SENTINEL,
      nextOffset: 9,
    });
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
      action: HEARTBEAT_RUN_LOG_ACCESSED,
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
    // BLO-34738 AC 2: `withheld` is the workspace-operation route's flag. This route applies no
    // read-time projection, so the key stays ABSENT rather than being written `false` — the
    // `...(opts.withheld === undefined ? {} : …)` spread is the contract for existing consumers.
    expect(mockLogActivity.mock.calls[0]?.[1]?.details).not.toHaveProperty("withheld");
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
      action: HEARTBEAT_RUN_LOG_ACCESSED,
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

  /**
   * BLO-34738. `heartbeat.readLog` throws `notFound("Run log not found")` when the run stored no
   * log, and the `allowed` audit sat above that call — so a 404 that disclosed nothing was booked
   * as a read. Control: move `logRunLogAccessAudit(..., "allowed", ...)` back above `readLog` and
   * this fails (verified, not assumed).
   *
   * BLO-34901: no `result` matcher. The invariant is that this 404 records NOTHING — the reader is
   * entitled, so booking it `denied` is equally false, and a matcher pinned to `"allowed"` passes
   * that mutation unchanged. Second control (also verified): make the route write
   * `logRunLogAccessAudit(..., "denied", ...)` on this path and this fails.
   *
   * The `readLog` positive pins the path the absence assertion is about. Without it, any mutation
   * that 404s BEFORE `readLog` writes no audit either, so the absence assertion passes while
   * nothing is exercised — verified: a `return` above `readLog` fails this test, and fails nothing
   * if the positive is removed.
   */
  it("does not audit a run log read at all when the run stored no log", async () => {
    const app = await createApp();
    const { notFound } = await vi.importActual<typeof import("../errors.js")>("../errors.js");
    mockHeartbeatService.readLog.mockRejectedValue(notFound("Run log not found"));

    const res = await requestApp(
      app,
      (baseUrl) => request(baseUrl).get("/api/heartbeat-runs/run-1/log?offset=0&limitBytes=64"),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(mockHeartbeatService.readLog).toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: HEARTBEAT_RUN_LOG_ACCESSED,
    }));
  });

  /**
   * BLO-34631 AC 1/2/3/4. Four cases, one per control, so a pass names which one it proved.
   *
   * The sentinel is the log CONTENT rather than a row field: the route answered with
   * `readLog`'s result unprojected, so a fixture whose content is inert could not show it.
   */
  it("withholds workspace-operation log content from a reader without workspace_runtime:read", async () => {
    denyWorkspaceRuntimeRead();

    const res = await requestApp(
      await createApp({}, {
        type: "agent",
        agentId: routeAgentId,
        companyId: "company-1",
        companyIds: ["company-1"],
        source: "agent_key",
        runId: "actor-run-1",
      }),
      (baseUrl) => request(baseUrl).get("/api/workspace-operations/operation-1/log?offset=0&limitBytes=64"),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(WORKSPACE_OPERATION_LOG_SENTINEL);
    // Masked, not emptied: a withheld reader must still tell "logged nothing" from "withheld".
    expect(res.body.content).toBe("***REDACTED***");
    // The opaque handles stay — the route they point at is the one that now withholds.
    expect(res.body.logRef).toBe("logs/operation-1.ndjson");
    // AC 2 + review: the access check passed, so this is `result: "allowed"` — but nothing was
    // disclosed. Without `withheld` the record is indistinguishable from a real disclosure, and
    // "who read this log" over-reports.
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: WORKSPACE_OPERATION_LOG_ACCESSED,
      details: expect.objectContaining({ result: "allowed", withheld: true }),
    }));
  });

  it("discloses workspace-operation log content to a reader holding workspace_runtime:read", async () => {
    const res = await requestApp(
      await createApp(),
      (baseUrl) => request(baseUrl).get("/api/workspace-operations/operation-1/log?offset=7&limitBytes=64"),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.content).toBe(WORKSPACE_OPERATION_LOG_SENTINEL);
    expect(mockWorkspaceOperationService.readLog).toHaveBeenCalledWith("operation-1", {
      offset: 7,
      limitBytes: 64,
    });
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      companyId: "company-1",
      actorType: "user",
      actorId: "local-board",
      action: WORKSPACE_OPERATION_LOG_ACCESSED,
      entityType: "workspace_operation",
      entityId: "operation-1",
      // The operation's own run, so an audit reader can join back to the run that produced it.
      runId: "run-1",
      details: expect.objectContaining({
        result: "allowed",
        actorSource: "local_implicit",
        offset: 7,
        limitBytes: 64,
        logStore: "local_file",
        // Paired with the withheld case above: the flag is what separates a real disclosure from
        // a masked read, so it has to be asserted on both sides or it proves nothing.
        withheld: false,
      }),
    }));
    expect(mockLogActivity.mock.calls[0]?.[1]?.details).not.toHaveProperty("content");
  });

  it("audits denied workspace-operation log access without reading content", async () => {
    const res = await requestApp(
      await createApp({}, {
        type: "agent",
        agentId: routeAgentId,
        companyId: "company-2",
        companyIds: ["company-2"],
        source: "agent_key",
        runId: "actor-run-1",
      }),
      (baseUrl) => request(baseUrl).get("/api/workspace-operations/operation-1/log?offset=4&limitBytes=32"),
    );

    // Cross-tenant stays a 404 so the route is not an existence oracle, but the attempt is recorded.
    expect(res.status).toBe(404);
    expect(mockWorkspaceOperationService.readLog).not.toHaveBeenCalled();
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      companyId: "company-1",
      actorType: "agent",
      actorId: routeAgentId,
      agentId: routeAgentId,
      action: WORKSPACE_OPERATION_LOG_ACCESSED,
      entityType: "workspace_operation",
      entityId: "operation-1",
      details: expect.objectContaining({
        result: "denied",
        actorSource: "agent_key",
        actorRunId: "actor-run-1",
        offset: 4,
        limitBytes: 32,
      }),
    }));
  });

  /**
   * BLO-34738, the other half. Same defect one URL over: `workspaceOperations.readLog` throws
   * `notFound("Workspace operation log not found")` when `logStore`/`logRef` is unset, and the
   * `allowed` audit sat above it — booking `withheld: true` against a 404, on exactly the flag
   * BLO-34631 added for audit accuracy. Control: move `audit("allowed", ...)` back above
   * `readLog` and this fails (verified, not assumed).
   *
   * `logStore: null` on the fixture rather than only rejecting `readLog`: that is the shape the
   * closure records, and it keeps the audit's own `logStore` field honest if the ordering ever
   * regresses.
   *
   * BLO-34901: no `result` matcher, same reasoning as the heartbeat guard above — and second
   * control verified here too. The `readLog` positive pins the exercised path for the same reason,
   * with its own verified mutation: a `return` above `readLog` fails this test only while that
   * assertion is present.
   */
  it("does not audit a workspace-operation log read at all when the operation stored no log", async () => {
    mockWorkspaceOperationService.getById.mockResolvedValue(
      workspaceOperationLogFixture({ logStore: null, logRef: null }),
    );
    const app = await createApp();
    const { notFound } = await vi.importActual<typeof import("../errors.js")>("../errors.js");
    mockWorkspaceOperationService.readLog.mockRejectedValue(
      notFound("Workspace operation log not found"),
    );

    const res = await requestApp(
      app,
      (baseUrl) => request(baseUrl).get("/api/workspace-operations/operation-1/log?offset=0&limitBytes=64"),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(mockWorkspaceOperationService.readLog).toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: WORKSPACE_OPERATION_LOG_ACCESSED,
    }));
  });

  /**
   * AC 1. Write-time username censoring is not retroactive, so a chunk stored before it landed is
   * in the store uncensored and crossed verbatim on this route only. Paired with the off-case
   * below: the setting is the sole discriminator, so neither passes if the read-time censor is
   * dropped, and neither passes if it is replaced by blanket blanking.
   *
   * `os.homedir()` rather than a literal, because that is the value `defaultHomeDirs` derives its
   * module-cached candidate list from.
   */
  it("censors the current user's home directory in stored log content when the setting is on", async () => {
    const { default: os } = await vi.importActual<typeof import("node:os")>("node:os");
    const homeDir = os.homedir();
    mockInstanceSettingsService.getGeneral.mockResolvedValue({
      censorUsernameInLogs: true,
      feedbackDataSharingPreference: "prompt",
    });
    mockWorkspaceOperationService.readLog.mockResolvedValue({
      operationId: "operation-1",
      store: "local_file",
      logRef: "logs/operation-1.ndjson",
      content: `cloned into ${homeDir}/checkout`,
      nextOffset: 9,
    });

    const res = await requestApp(
      await createApp(),
      (baseUrl) => request(baseUrl).get("/api/workspace-operations/operation-1/log"),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.content).not.toContain(homeDir);
    // Censored, not blanked: the surrounding line survives so the log stays readable.
    expect(res.body.content).toContain("cloned into ");
    expect(res.body.content).toContain("/checkout");
  });

  it("leaves stored log content alone when the censor setting is off", async () => {
    const { default: os } = await vi.importActual<typeof import("node:os")>("node:os");
    const homeDir = os.homedir();
    mockWorkspaceOperationService.readLog.mockResolvedValue({
      operationId: "operation-1",
      store: "local_file",
      logRef: "logs/operation-1.ndjson",
      content: `cloned into ${homeDir}/checkout`,
      nextOffset: 9,
    });

    const res = await requestApp(
      await createApp(),
      (baseUrl) => request(baseUrl).get("/api/workspace-operations/operation-1/log"),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.content).toBe(`cloned into ${homeDir}/checkout`);
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

  it("returns 200 with usable timestamps when the driver hands back a string aggregate (BLO-20396)", async () => {
    // Regression guard for the production 500:
    //   "group.oldestQueuedAt.getTime is not a function"
    // `min(created_at)` is a raw sql<> expression, so drizzle never decodes it
    // to a Date and postgres-js yields the wire string. The stub above now
    // reproduces that, so this fails without the boundary coercion.
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
        id: "queued-1",
        agentId: routeAgentId,
        agentName: "Ally",
        status: "queued",
        errorCode: null,
        contextSnapshot,
        createdAt: new Date("2026-07-25T11:10:00.000Z"),
        startedAt: null,
        finishedAt: null,
      },
    ]);
    const app = await createApp(db);

    const res = await request(app).get("/api/companies/company-1/pr-review-queue");

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.agents[0].oldestQueuedAt).toBe("2026-07-25T11:10:00.000Z");
    expect(res.body.agents[0].oldestQueuedAgeMs).toBe(3_000_000);
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
    const terminal = (id: string, createdAt: string, finishedAt: string, context = contextSnapshot) => ({
      id,
      agentId: routeAgentId,
      agentName: "Ally",
      status: "succeeded",
      errorCode: null,
      contextSnapshot: context,
      createdAt: new Date(createdAt),
      startedAt: new Date(createdAt),
      finishedAt: new Date(finishedAt),
      scheduledRetryAt: null,
    });
    const { db } = createLiveRunsDbStub([
      terminal("malformed", "2026-07-25T11:58:00.000Z", "2026-07-25T11:59:30.000Z", { reviewKind: "pr_review" }),
      terminal("terminal-new", "2026-07-25T11:57:00.000Z", "2026-07-25T11:59:00.000Z"),
      terminal("terminal-old", "2026-07-25T11:56:00.000Z", "2026-07-25T11:58:00.000Z"),
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

  it("filters malformed terminal candidates in SQL and uses one stable bounded query", async () => {
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
    const { db, limit, orderBy } = createLiveRunsDbStub(rows);
    const app = await createApp(db);

    const res = await request(app).get("/api/companies/company-1/pr-review-queue?limit=1");

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.agents[0].runs.map((run: { id: string }) => run.id)).toEqual(["valid"]);
    expect(limit).toHaveBeenCalledTimes(2);
    expect(limit).toHaveBeenNthCalledWith(1, 2);
    expect(limit).toHaveBeenNthCalledWith(2, 2);
    expect(orderBy).toHaveBeenCalledTimes(2);
    expect(orderBy.mock.calls.every((call) => call.length === 2)).toBe(true);
    expect(res.body).toMatchObject({
      detailLimit: 1,
      truncated: false,
      truncatedSections: { activeRuns: false, terminalRuns: false },
    });
  });

  it("bounds terminal history by completion order rather than creation order", async () => {
    const contextSnapshot = {
      reviewKind: "pr_review",
      githubRepoFullName: "Blockcast/paperclip",
      githubPrNumber: 812,
      githubHeadSha: "abcdef123456",
    };
    const terminal = (id: string, createdAt: string, finishedAt: string) => ({
      id,
      agentId: routeAgentId,
      agentName: "Ally",
      status: "succeeded",
      errorCode: null,
      contextSnapshot,
      createdAt: new Date(createdAt),
      startedAt: new Date(createdAt),
      finishedAt: new Date(finishedAt),
      scheduledRetryAt: null,
    });
    const { db } = createLiveRunsDbStub([
      terminal("created-later", "2026-07-25T11:00:00.000Z", "2026-07-25T11:20:00.000Z"),
      terminal("finished-later", "2026-07-25T10:00:00.000Z", "2026-07-25T11:50:00.000Z"),
    ]);
    const app = await createApp(db);

    const res = await request(app).get("/api/companies/company-1/pr-review-queue?limit=1");

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.agents[0].runs.map((run: { id: string }) => run.id)).toEqual(["finished-later"]);
    expect(res.body).toMatchObject({
      truncated: true,
      truncatedSections: { activeRuns: false, terminalRuns: true },
    });
  });

  it("caps recent active detail while preserving each reviewer's oldest queued target", async () => {
    const contextSnapshot = {
      reviewKind: "pr_review",
      githubRepoFullName: "Blockcast/paperclip",
      githubPrNumber: 812,
      githubHeadSha: "abcdef123456",
    };
    const active = (id: string, createdAt: string, agentId = routeAgentId, agentName = "Ally") => ({
      id,
      agentId,
      agentName,
      status: "queued",
      errorCode: null,
      contextSnapshot,
      createdAt: new Date(createdAt),
      startedAt: null,
      finishedAt: null,
      scheduledRetryAt: null,
    });
    const { db } = createLiveRunsDbStub([
      active("same-time-a", "2026-07-25T11:00:00.000Z"),
      active("same-time-b", "2026-07-25T11:00:00.000Z"),
      active("ally-oldest", "2026-07-25T10:00:00.000Z"),
      active(
        "second-oldest",
        "2026-07-25T10:30:00.000Z",
        "22222222-2222-4222-8222-222222222222",
        "Second Reviewer",
      ),
    ]);
    const app = await createApp(db);

    const res = await request(app).get("/api/companies/company-1/pr-review-queue?limit=1");

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.agents[0]).toMatchObject({
      queuedCount: 3,
      oldestQueuedAt: "2026-07-25T10:00:00.000Z",
    });
    expect(res.body.agents[0].runs.map((run: { id: string }) => run.id)).toEqual(["same-time-b", "ally-oldest"]);
    expect(res.body.agents[1]).toMatchObject({
      agentName: "Second Reviewer",
      queuedCount: 1,
    });
    expect(res.body.agents[1].runs.map((run: { id: string }) => run.id)).toEqual(["second-oldest"]);
    expect(res.body).toMatchObject({
      truncated: true,
      truncatedSections: { activeRuns: true, terminalRuns: false },
    });
  });

  it("does not report active truncation when oldest supplementation returns every active run", async () => {
    const contextSnapshot = {
      reviewKind: "pr_review",
      githubRepoFullName: "Blockcast/paperclip",
      githubPrNumber: 812,
      githubHeadSha: "abcdef123456",
    };
    const active = (id: string, agentId: string, agentName: string) => ({
      id,
      agentId,
      agentName,
      status: "queued",
      errorCode: null,
      contextSnapshot,
      createdAt: new Date("2026-07-25T11:00:00.000Z"),
      startedAt: null,
      finishedAt: null,
      scheduledRetryAt: null,
    });
    const { db } = createLiveRunsDbStub([
      active("ally-only", routeAgentId, "Ally"),
      active("second-only", "22222222-2222-4222-8222-222222222222", "Second Reviewer"),
    ]);
    const app = await createApp(db);

    const res = await request(app).get("/api/companies/company-1/pr-review-queue?limit=1");

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.agents.flatMap((agent: { runs: Array<{ id: string }> }) =>
      agent.runs.map((run) => run.id)
    )).toEqual(["ally-only", "second-only"]);
    expect(res.body).toMatchObject({
      truncated: false,
      truncatedSections: { activeRuns: false, terminalRuns: false },
    });
  });

  it("reads queue aggregates and details from one repeatable-read snapshot", async () => {
    const queuedRun = {
      id: "transitioning-run",
      agentId: routeAgentId,
      agentName: "Ally",
      status: "queued",
      errorCode: null,
      contextSnapshot: {
        reviewKind: "pr_review",
        githubRepoFullName: "Blockcast/paperclip",
        githubPrNumber: 812,
        githubHeadSha: "abcdef123456",
      },
      createdAt: new Date("2026-07-25T11:00:00.000Z"),
      startedAt: null,
      finishedAt: null,
      scheduledRetryAt: null,
    };
    const snapshot = createLiveRunsDbStub([{ ...queuedRun }]);
    const live = createLiveRunsDbStub([{
      ...queuedRun,
      status: "succeeded",
      startedAt: new Date("2026-07-25T11:01:00.000Z"),
      finishedAt: new Date("2026-07-25T11:02:00.000Z"),
    }]);
    const transaction = vi.fn(async (
      callback: (tx: typeof snapshot.db) => Promise<unknown>,
      config: Record<string, unknown>,
    ) => {
      expect(config).toEqual({ isolationLevel: "repeatable read", accessMode: "read only" });
      return callback(snapshot.db);
    });
    const app = await createApp({ ...live.db, transaction });

    const res = await request(app).get("/api/companies/company-1/pr-review-queue");

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(transaction).toHaveBeenCalledOnce();
    expect(live.db.select).not.toHaveBeenCalled();
    expect(res.body.agents[0]).toMatchObject({
      queuedCount: 1,
      runs: [expect.objectContaining({ id: "transitioning-run", disposition: "queued" })],
    });
  });

  it.each([
    "?limit=0",
    "?limit=1.5",
    "?limit=1001",
    "?limit=not-a-number",
    "?lookbackHours=0",
    "?lookbackHours=24.5",
    "?lookbackHours=169",
  ])("rejects invalid queue query parameters: %s", async (query) => {
    const { db } = createLiveRunsDbStub([]);
    const app = await createApp(db);
    const res = await request(app).get(`/api/companies/company-1/pr-review-queue${query}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Validation error");
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
