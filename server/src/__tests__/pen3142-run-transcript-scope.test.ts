import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PEN-3142 — run *transcript* reads are scoped to own-run + manager chain +
 * human operators + an explicit `runs:read_transcript` grant, on BOTH transcript
 * routes. Run *state* is deliberately untouched and this file pins that too:
 * `denies-nothing-extra` below fails if the narrowing overshoots into state,
 * which the PEN-3140 decision calls out as wrong.
 *
 * The decider itself is pinned against the real service in
 * `authorization-service.test.ts`; `access.decide` is stubbed here so each route
 * arm can be exercised independently of how the decision was reached.
 */

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  buildRunOutputSilence: vi.fn(),
  decorateActiveRunStatus: vi.fn(),
  getRetryExhaustedReason: vi.fn(),
  getRetrySuccessor: vi.fn(),
  getRun: vi.fn(),
  getRunLogAccess: vi.fn(),
  listEvents: vi.fn(),
  readLog: vi.fn(),
}));

const mockWorkspaceOperationService = vi.hoisted(() => ({
  listForRun: vi.fn(),
  getById: vi.fn(),
  readLog: vi.fn(),
}));

const mockInstanceSettingsService = vi.hoisted(() => ({
  get: vi.fn(),
  getExperimental: vi.fn(),
  getGeneral: vi.fn(),
  listCompanyIds: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());
const mockDecide = vi.hoisted(() => vi.fn());

const runOwnerAgentId = "22222222-2222-4222-8222-222222222222";
const peerAgentId = "33333333-3333-4333-8333-333333333333";

function registerModuleMocks() {
  vi.doMock("../routes/authz.js", async () => vi.importActual("../routes/authz.js"));

  vi.doMock("../services/agents.js", () => ({
    agentService: () => mockAgentService,
  }));

  vi.doMock("../services/heartbeat.js", () => ({
    heartbeatService: () => mockHeartbeatService,
    derivePaperclipPrReview: () => null,
  }));

  vi.doMock("../services/instance-settings.js", () => ({
    instanceSettingsService: () => mockInstanceSettingsService,
  }));

  vi.doMock("../services/issues.js", () => ({
    issueService: () => ({ getById: vi.fn(), getByIdentifier: vi.fn() }),
  }));

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
    issueService: () => ({ getById: vi.fn(), getByIdentifier: vi.fn() }),
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

const boardActor = {
  type: "board",
  userId: "local-board",
  companyIds: ["company-1"],
  source: "local_implicit",
  isInstanceAdmin: false,
};

const peerAgentActor = {
  type: "agent",
  agentId: peerAgentId,
  companyId: "company-1",
  source: "agent_key",
  runId: "actor-run-1",
};

async function createApp(actor: Record<string, unknown> = boardActor) {
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
  app.use("/api", agentRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

async function requestApp<T>(app: express.Express, run: (baseUrl: string) => Promise<T> | T) {
  const server = app.listen(0);
  try {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

function auditCallsFor(action: string) {
  return mockLogActivity.mock.calls.filter((call) => call[1]?.action === action);
}

describe("run transcript scoping (PEN-3142)", () => {
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
    registerModuleMocks();
    vi.clearAllMocks();

    mockLogActivity.mockResolvedValue(undefined);
    // Default to DENIED so a test that means to exercise an allow has to say so.
    // A default-allow stub would make every withhold assertion below pass for
    // the wrong reason.
    mockDecide.mockImplementation(async (input: { action?: string }) => ({
      allowed: false,
      action: input.action,
      reason: "deny_missing_grant",
      explanation: "Missing permission: runs:read_transcript.",
    }));

    mockInstanceSettingsService.get.mockResolvedValue({
      id: "instance-settings-1",
      general: { censorUsernameInLogs: false, feedbackDataSharingPreference: "prompt" },
    });
    mockInstanceSettingsService.getExperimental.mockResolvedValue({});
    mockInstanceSettingsService.getGeneral.mockResolvedValue({
      censorUsernameInLogs: false,
      feedbackDataSharingPreference: "prompt",
    });
    mockInstanceSettingsService.listCompanyIds.mockResolvedValue(["company-1"]);

    mockHeartbeatService.getRun.mockResolvedValue({
      id: "run-1",
      companyId: "company-1",
      agentId: runOwnerAgentId,
      status: "failed",
      error: "Run hit provider throttle before any token usage",
      errorCode: "rate_limit_exhausted",
      scheduledRetryAt: new Date("2026-09-10T04:00:00.000Z"),
      scheduledRetryReason: "transient_failure",
      lastActivityAt: new Date("2026-09-10T03:59:00.000Z"),
      contextSnapshot: { executionWorkspaceId: "workspace-1" },
    });
    mockHeartbeatService.getRunLogAccess.mockResolvedValue({
      id: "run-1",
      companyId: "company-1",
      agentId: runOwnerAgentId,
      logStore: "local_file",
      logRef: "logs/run-1.ndjson",
    });
    mockHeartbeatService.readLog.mockResolvedValue({
      runId: "run-1",
      store: "local_file",
      logRef: "logs/run-1.ndjson",
      content: "ANTHROPIC_API_KEY=sk-live-not-a-real-key",
      nextOffset: 40,
    });
    mockHeartbeatService.getRetryExhaustedReason.mockResolvedValue(null);
    mockHeartbeatService.getRetrySuccessor.mockResolvedValue({ state: "retried", runId: "run-2" });
    mockHeartbeatService.buildRunOutputSilence.mockResolvedValue(null);
    mockHeartbeatService.decorateActiveRunStatus.mockImplementation((run: Record<string, unknown>) => ({
      ...run,
      currentStatusMessage: null,
      currentStatusUpdatedAt: null,
    }));
    mockHeartbeatService.listEvents.mockResolvedValue([
      {
        id: "1",
        companyId: "company-1",
        runId: "run-1",
        agentId: runOwnerAgentId,
        seq: 7,
        eventType: "lifecycle",
        stream: "system",
        level: "warn",
        color: null,
        message: "Bounded retry exhausted for the vendor call",
        payload: { nextAction: "agent-authored continuation prose" },
        createdAt: new Date("2026-09-10T03:58:00.000Z"),
      },
      {
        id: "2",
        companyId: "company-1",
        runId: "run-1",
        agentId: runOwnerAgentId,
        seq: 8,
        eventType: "adapter.invoke",
        stream: "system",
        level: "info",
        color: null,
        message: "adapter invocation",
        payload: { command: "claude --model opus", cwd: "/workspace" },
        createdAt: new Date("2026-09-10T03:59:00.000Z"),
      },
    ]);

    mockWorkspaceOperationService.listForRun.mockResolvedValue([
      { id: "op-1", companyId: "company-1", kind: "clone", status: "succeeded" },
    ]);
  });

  describe("GET /heartbeat-runs/:runId/log", () => {
    it("denies a same-company peer with no transcript entitlement, and audits it", async () => {
      const res = await requestApp(
        await createApp(peerAgentActor),
        (baseUrl) => request(baseUrl).get("/api/heartbeat-runs/run-1/log?offset=0&limitBytes=64"),
      );

      expect(res.status, JSON.stringify(res.body)).toBe(403);
      // Named boundary vocabulary, not a new error string: a client can tell
      // this apart from a cross-tenant 404 and from a missing run. Asserted
      // under `details` because that is where `authorizationDeniedDetails`
      // puts it on every other denied route in the codebase — the point of
      // reusing the decider is that this response is shaped like the rest.
      expect(res.body.details).toMatchObject({
        reason: "deny_missing_grant",
        boundary: "grant",
      });
      // The point of the gate: the log is never read on a denied request, so no
      // transcript reaches the response or an error message.
      expect(mockHeartbeatService.readLog).not.toHaveBeenCalled();
      expect(JSON.stringify(res.body)).not.toContain("sk-live-not-a-real-key");

      const audits = auditCallsFor("heartbeat.run_log_accessed");
      expect(audits).toHaveLength(1);
      expect(audits[0]?.[1]).toMatchObject({
        companyId: "company-1",
        actorType: "agent",
        agentId: peerAgentId,
        entityId: "run-1",
        details: expect.objectContaining({ result: "denied", actorRunId: "actor-run-1" }),
      });
    });

    it("allows the run's own agent", async () => {
      mockDecide.mockImplementation(async (input: { action?: string }) => ({
        allowed: true,
        action: input.action,
        reason: "allow_self",
        explanation: "Allowed because the actor owns the run whose transcript it is reading.",
      }));

      const res = await requestApp(
        await createApp({ ...peerAgentActor, agentId: runOwnerAgentId }),
        (baseUrl) => request(baseUrl).get("/api/heartbeat-runs/run-1/log"),
      );

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toMatchObject({ runId: "run-1", nextOffset: 40 });
      expect(auditCallsFor("heartbeat.run_log_accessed")[0]?.[1]?.details).toMatchObject({
        result: "allowed",
      });
    });

    it("asks the decider about the run's OWNING agent, not the caller", async () => {
      await requestApp(
        await createApp(peerAgentActor),
        (baseUrl) => request(baseUrl).get("/api/heartbeat-runs/run-1/log"),
      );

      // Scoping to the caller would make every read self-authorizing.
      expect(mockDecide).toHaveBeenCalledWith(expect.objectContaining({
        action: "runs:read_transcript",
        resource: { type: "agent", companyId: "company-1", agentId: runOwnerAgentId },
      }));
    });

    it("keeps the cross-tenant 404 posture rather than exposing the new 403", async () => {
      const res = await requestApp(
        await createApp({ ...peerAgentActor, companyId: "company-2" }),
        (baseUrl) => request(baseUrl).get("/api/heartbeat-runs/run-1/log"),
      );

      // A 403 here would turn the transcript gate into an existence oracle for
      // another tenant's run ids.
      expect(res.status).toBe(404);
      expect(mockDecide).not.toHaveBeenCalled();
    });

    it("keeps the read for a human operator without consulting the grant", async () => {
      const res = await requestApp(
        await createApp(boardActor),
        (baseUrl) => request(baseUrl).get("/api/heartbeat-runs/run-1/log"),
      );

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(mockDecide).not.toHaveBeenCalled();
    });
  });

  describe("GET /heartbeat-runs/:runId/events", () => {
    it("withholds message and payload from an unentitled peer while keeping the envelope", async () => {
      const res = await requestApp(
        await createApp(peerAgentActor),
        (baseUrl) => request(baseUrl).get("/api/heartbeat-runs/run-1/events"),
      );

      // 200, not 403: the envelope is run shape, which stays company-readable.
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toHaveLength(2);
      for (const event of res.body) {
        expect(event.message).toBeNull();
        expect(event.payload).toBeNull();
        // Without this a client cannot tell "not entitled" from "no content".
        expect(event.withheldFields).toEqual(["message", "payload"]);
      }
      // `seq` is the pagination cursor every consumer depends on.
      expect(res.body.map((event: { seq: number }) => event.seq)).toEqual([7, 8]);
      expect(res.body[0]).toMatchObject({ eventType: "lifecycle", stream: "system", level: "warn" });
      expect(JSON.stringify(res.body)).not.toContain("agent-authored continuation prose");
      expect(JSON.stringify(res.body)).not.toContain("claude --model opus");
    });

    it("audits the denied events read, which had no audit at all before", async () => {
      await requestApp(
        await createApp(peerAgentActor),
        (baseUrl) => request(baseUrl).get("/api/heartbeat-runs/run-1/events?afterSeq=6&limit=50"),
      );

      const audits = auditCallsFor("heartbeat.run_events_accessed");
      expect(audits).toHaveLength(1);
      expect(audits[0]?.[1]).toMatchObject({
        companyId: "company-1",
        actorType: "agent",
        agentId: peerAgentId,
        entityType: "heartbeat_run",
        entityId: "run-1",
        runId: "run-1",
        details: expect.objectContaining({
          result: "denied",
          actorSource: "agent_key",
          actorRunId: "actor-run-1",
          afterSeq: 6,
          limit: 50,
        }),
      });
      // Same discipline as the /log audit: never record the content itself.
      expect(JSON.stringify(audits[0]?.[1]?.details)).not.toContain("continuation prose");
    });

    it("returns full content and an allowed audit to an entitled reader", async () => {
      mockDecide.mockImplementation(async (input: { action?: string }) => ({
        allowed: true,
        action: input.action,
        reason: "allow_manager_chain",
        explanation: "Allowed because the actor manages the run's owning agent in the reporting chain.",
      }));

      const res = await requestApp(
        await createApp(peerAgentActor),
        (baseUrl) => request(baseUrl).get("/api/heartbeat-runs/run-1/events"),
      );

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body[0]).toMatchObject({ message: "Bounded retry exhausted for the vendor call" });
      expect(res.body[0].payload).toMatchObject({ nextAction: "agent-authored continuation prose" });
      expect(res.body[0]).not.toHaveProperty("withheldFields");
      expect(auditCallsFor("heartbeat.run_events_accessed")[0]?.[1]?.details).toMatchObject({
        result: "allowed",
        eventCount: 2,
      });
    });

    // Fail-closed proof. Adapters choose their own `eventType` string and the
    // server only length-clamps it, so a type allowlist would leak the first
    // time an adapter emitted an unrecognized (or a deliberately state-looking)
    // label. Withholding by default is what makes that impossible.
    it("withholds content from an event type it has never seen", async () => {
      mockHeartbeatService.listEvents.mockResolvedValue([
        {
          id: "9",
          companyId: "company-1",
          runId: "run-1",
          agentId: runOwnerAgentId,
          seq: 99,
          eventType: "vendor.brand_new_stream",
          stream: "stdout",
          level: "info",
          color: null,
          message: "AWS_SECRET_ACCESS_KEY=not-a-real-secret",
          payload: { toolResult: "raw tool output" },
          createdAt: new Date("2026-09-10T04:01:00.000Z"),
        },
      ]);

      const res = await requestApp(
        await createApp(peerAgentActor),
        (baseUrl) => request(baseUrl).get("/api/heartbeat-runs/run-1/events"),
      );

      expect(res.status).toBe(200);
      expect(res.body[0]).toMatchObject({ eventType: "vendor.brand_new_stream", seq: 99 });
      expect(res.body[0].message).toBeNull();
      expect(res.body[0].payload).toBeNull();
      expect(JSON.stringify(res.body)).not.toContain("not-a-real-secret");
      expect(JSON.stringify(res.body)).not.toContain("raw tool output");
    });
  });

  // The overshoot guard the PEN-3140 decision asks for by name: "If a peer can
  // no longer see that a run parked, failed, or was retried, the change has
  // overshot and is wrong." This fails if run STATE gets narrowed along with
  // transcript content.
  describe("run state stays company-readable for an unentitled peer", () => {
    it("returns status, error text, and the retry edge from the run route", async () => {
      const res = await requestApp(
        await createApp(peerAgentActor),
        (baseUrl) => request(baseUrl).get("/api/heartbeat-runs/run-1"),
      );

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toMatchObject({
        id: "run-1",
        status: "failed",
        error: "Run hit provider throttle before any token usage",
        errorCode: "rate_limit_exhausted",
        scheduledRetryReason: "transient_failure",
        retrySuccessor: { state: "retried", runId: "run-2" },
      });
      expect(res.body.lastActivityAt).toBeTruthy();
      // The state route must not be routed through the transcript gate.
      expect(mockDecide).not.toHaveBeenCalled();
    });

    it("returns workspace operations", async () => {
      const res = await requestApp(
        await createApp(peerAgentActor),
        (baseUrl) => request(baseUrl).get("/api/heartbeat-runs/run-1/workspace-operations"),
      );

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0]).toMatchObject({ id: "op-1", status: "succeeded" });
    });
  });
});
