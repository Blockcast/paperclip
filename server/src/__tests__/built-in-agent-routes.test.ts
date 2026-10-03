import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const companyId = "22222222-2222-4222-8222-222222222222";
const agentId = "11111111-1111-4111-8111-111111111111";

const mockAccessService = vi.hoisted(() => ({
  decide: vi.fn(),
  canUser: vi.fn(),
}));

const mockInstanceSettingsService = vi.hoisted(() => ({
  getExperimental: vi.fn(),
}));

const mockBuiltInAgentService = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  ensure: vi.fn(),
  provision: vi.fn(),
  reset: vi.fn(),
  enableRoutineSchedule: vi.fn(),
  disableRoutineSchedule: vi.fn(),
  runRoutine: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

function allowDecision() {
  return {
    allowed: true,
    action: "agents:create",
    reason: "allow_explicit_grant",
    explanation: "Allowed.",
  };
}

function denyDecision() {
  return {
    allowed: false,
    action: "agents:create",
    reason: "deny_missing_grant",
    explanation: "Missing permission: agents:create.",
  };
}

function builtInState(overrides: Record<string, unknown> = {}) {
  return {
    definition: {
      key: "briefs",
      displayName: "Briefs Agent",
      featureKeys: ["briefs"],
      shortPurpose: "Prepares concise operational briefs.",
      defaultInstructions: "Write briefs.",
      defaultRole: "general",
      allowedAdapterTypes: ["codex_local"],
    },
    status: "ready",
    agentId,
    agent: {
      id: agentId,
      companyId,
      name: "Briefs Agent",
      role: "general",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: { model: "gpt-5.4" },
    },
    pauseReason: null,
    ...overrides,
  };
}

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    instanceSettingsService: () => mockInstanceSettingsService,
    logActivity: mockLogActivity,
  }));
  vi.doMock("../services/built-in-agents.js", () => ({
    builtInAgentService: () => mockBuiltInAgentService,
  }));
}

async function createApp(actor: Record<string, unknown>) {
  const [{ builtInAgentRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/built-in-agents.js")>("../routes/built-in-agents.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", builtInAgentRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("built-in agent routes", () => {
  beforeEach(() => {
    vi.resetModules();
    registerModuleMocks();
    vi.clearAllMocks();
    mockAccessService.decide.mockResolvedValue(allowDecision());
    mockAccessService.canUser.mockResolvedValue(true);
    mockInstanceSettingsService.getExperimental.mockResolvedValue({ enableBuiltInAgents: true });
    mockBuiltInAgentService.list.mockResolvedValue([builtInState()]);
    mockBuiltInAgentService.get.mockResolvedValue(builtInState());
    mockBuiltInAgentService.ensure.mockResolvedValue(builtInState());
    mockBuiltInAgentService.provision.mockResolvedValue({ state: builtInState(), approval: null });
    mockBuiltInAgentService.reset.mockResolvedValue(builtInState());
    mockBuiltInAgentService.enableRoutineSchedule.mockResolvedValue(builtInState());
    mockBuiltInAgentService.disableRoutineSchedule.mockResolvedValue(builtInState());
    mockBuiltInAgentService.runRoutine.mockResolvedValue({ id: "routine-run-1", source: "manual", status: "queued" });
  });

  it("lists built-in agent state for actors with company access", async () => {
    const app = await createApp({
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      source: "session",
      isInstanceAdmin: false,
    });

    const res = await request(app).get(`/api/companies/${companyId}/built-in-agents`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockBuiltInAgentService.list).toHaveBeenCalledWith(companyId);
    expect(res.body).toEqual([expect.objectContaining({ status: "ready", agentId })]);
    expect(res.body[0].agent.adapterConfig).toEqual({});
  });

  it("denies list requests outside the actor company boundary", async () => {
    const app = await createApp({
      type: "board",
      userId: "board-user",
      companyIds: ["33333333-3333-4333-8333-333333333333"],
      source: "session",
      isInstanceAdmin: false,
    });

    const res = await request(app).get(`/api/companies/${companyId}/built-in-agents`);

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(mockBuiltInAgentService.list).not.toHaveBeenCalled();
  });

  it("returns 404 and does not load built-in state when the experimental flag is disabled", async () => {
    mockInstanceSettingsService.getExperimental.mockResolvedValue({ enableBuiltInAgents: false });
    const app = await createApp({
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      source: "session",
      isInstanceAdmin: false,
    });

    const res = await request(app).get(`/api/companies/${companyId}/built-in-agents`);

    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(res.body.error).toContain("Built-in agents are not enabled");
    expect(mockBuiltInAgentService.list).not.toHaveBeenCalled();
  });

  it("provisions through the agents:create gate and passes optional adapter overrides", async () => {
    const app = await createApp({
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      source: "session",
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/built-in-agents/briefs/provision`)
      .send({ adapterType: "codex_local", adapterConfig: { model: "gpt-5.4" }, budgetMonthlyCents: 5000 });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAccessService.decide).toHaveBeenCalledWith({
      actor: expect.objectContaining({ type: "board" }),
      action: "agents:create",
      resource: { type: "company", companyId },
    });
    expect(mockBuiltInAgentService.provision).toHaveBeenCalledWith(
      companyId,
      "briefs",
      {
        adapterType: "codex_local",
        adapterConfig: { model: "gpt-5.4" },
        budgetMonthlyCents: 5000,
      },
      { requestedByAgentId: null, requestedByUserId: "board-user" },
    );
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      companyId,
      actorType: "user",
      actorId: "board-user",
      action: "built_in_agent.provision_requested",
      entityId: agentId,
    }));
  });

  it("denies provision when agents:create is not allowed", async () => {
    mockAccessService.decide.mockResolvedValue(denyDecision());
    const app = await createApp({
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      source: "session",
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/built-in-agents/briefs/provision`)
      .send({ adapterType: "codex_local" });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.details).toMatchObject({ reason: "deny_missing_grant" });
    expect(mockBuiltInAgentService.ensure).not.toHaveBeenCalled();
    expect(mockBuiltInAgentService.provision).not.toHaveBeenCalled();
  });

  it("rejects provision bodies with unknown fields", async () => {
    const app = await createApp({
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      source: "session",
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/built-in-agents/briefs/provision`)
      .send({ adapterType: "codex_local", unexpected: true });

    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(mockBuiltInAgentService.ensure).not.toHaveBeenCalled();
    expect(mockBuiltInAgentService.provision).not.toHaveBeenCalled();
  });

  it("enables a built-in routine schedule through the board tasks:assign gate", async () => {
    const app = await createApp({
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      source: "session",
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/built-in-agents/reflection-coach/routines/recent-agent-reflection/enable`)
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAccessService.canUser).toHaveBeenCalledWith(companyId, "board-user", "tasks:assign");
    expect(mockBuiltInAgentService.enableRoutineSchedule).toHaveBeenCalledWith(
      companyId,
      "reflection-coach",
      "recent-agent-reflection",
      { agentId: null, userId: "board-user", runId: null },
    );
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "built_in_agent.routine_schedule_enabled",
      entityId: agentId,
      details: expect.objectContaining({ routineKey: "recent-agent-reflection" }),
    }));
  });

  it("disables a built-in routine schedule", async () => {
    const app = await createApp({
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      source: "session",
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/built-in-agents/reflection-coach/routines/recent-agent-reflection/disable`)
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockBuiltInAgentService.disableRoutineSchedule).toHaveBeenCalledWith(
      companyId,
      "reflection-coach",
      "recent-agent-reflection",
      { agentId: null, userId: "board-user", runId: null },
    );
  });

  it("triggers a built-in routine manual run", async () => {
    const app = await createApp({
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      source: "session",
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/built-in-agents/reflection-coach/routines/recent-agent-reflection/run`)
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(res.body).toMatchObject({ id: "routine-run-1", source: "manual" });
    expect(mockBuiltInAgentService.runRoutine).toHaveBeenCalledWith(
      companyId,
      "reflection-coach",
      "recent-agent-reflection",
      { agentId: null, userId: "board-user", runId: null },
    );
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "built_in_agent.routine_run_triggered",
      details: expect.objectContaining({ routineRunId: "routine-run-1" }),
    }));
  });

  it("denies built-in routine controls when tasks:assign is not allowed", async () => {
    mockAccessService.canUser.mockResolvedValue(false);
    const app = await createApp({
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      source: "session",
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/built-in-agents/reflection-coach/routines/recent-agent-reflection/run`)
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(mockBuiltInAgentService.runRoutine).not.toHaveBeenCalled();
  });

  it("denies agent actors from controlling built-in routines", async () => {
    const app = await createApp({
      type: "agent",
      agentId: "manager-agent",
      companyId,
      source: "agent_key",
      runId: "55555555-5555-4555-8555-555555555555",
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/built-in-agents/reflection-coach/routines/recent-agent-reflection/run`)
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toContain("Only board operators can control built-in routines.");
    expect(mockAccessService.canUser).not.toHaveBeenCalled();
    expect(mockBuiltInAgentService.runRoutine).not.toHaveBeenCalled();
  });

  it("returns pending hire approvals instead of provisioning immediately when company policy requires it", async () => {
    const approval = {
      id: "approval-1",
      status: "pending",
      type: "hire_agent",
    };
    mockBuiltInAgentService.provision.mockResolvedValue({
      state: builtInState({
        status: "pending_approval",
        agent: { ...builtInState().agent, status: "pending_approval" },
      }),
      approval,
    });
    const app = await createApp({
      type: "agent",
      agentId: "manager-agent",
      companyId,
      source: "agent_key",
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/built-in-agents/briefs/provision`)
      .send({ adapterType: "codex_local", adapterConfig: { model: "gpt-5.4" } });

    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(res.body.status).toBe("pending_approval");
    expect(res.body.approval).toMatchObject({ id: "approval-1", status: "pending", type: "hire_agent" });
    expect(mockBuiltInAgentService.ensure).not.toHaveBeenCalled();
    expect(mockBuiltInAgentService.provision).toHaveBeenCalledWith(
      companyId,
      "briefs",
      { adapterType: "codex_local", adapterConfig: { model: "gpt-5.4" } },
      { requestedByAgentId: "manager-agent", requestedByUserId: null },
    );
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      companyId,
      actorType: "agent",
      actorId: "manager-agent",
      action: "approval.created",
      entityId: "approval-1",
    }));
  });

  it("resets registry defaults through the same agents:create gate", async () => {
    const app = await createApp({
      type: "agent",
      agentId: "manager-agent",
      companyId,
      source: "agent_key",
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/built-in-agents/briefs/reset`)
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockBuiltInAgentService.reset).toHaveBeenCalledWith(companyId, "briefs", {});
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      companyId,
      actorType: "agent",
      actorId: "manager-agent",
      agentId: "manager-agent",
      action: "built_in_agent.reset",
      entityId: agentId,
    }));
  });

  it("denies agent actors from provisioning across company boundaries", async () => {
    const app = await createApp({
      type: "agent",
      agentId: "manager-agent",
      companyId: "33333333-3333-4333-8333-333333333333",
      source: "agent_key",
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/built-in-agents/briefs/reset`)
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(mockAccessService.decide).not.toHaveBeenCalled();
    expect(mockBuiltInAgentService.reset).not.toHaveBeenCalled();
  });
});

/**
 * PEN-3726 follow-up. `redactBuiltInAgentListState` is the SIXTH agent
 * projection — the original issue's census counted five — and it has the same
 * spread-with-an-override-list shape as `redactForRestrictedAgentView`: it
 * blanks `adapterConfig`/`runtimeConfig` and used to pass `metadata` through
 * exactly as stored, across all seven of its response exits.
 *
 * `metadata` is a caller-writable open bag (`jsonb`, validated only as
 * `z.record(z.string(), z.unknown())`) that takes no secret-sentinel pass on
 * write, and the two GET routes below are gated only by `assertCompanyAccess`
 * — so any same-company AGENT principal reads them, which is why the actor
 * here is an agent rather than the board actor the rest of this file uses.
 *
 * The four cases are the same disposition matrix the two helpers in
 * `agent-redaction.ts` are pinned against, so a change to `containAgentMetadata`
 * cannot satisfy one projection and silently regress this one.
 */
describe("built-in agent routes contain agent metadata", () => {
  const METADATA_SECRET = "builtin-metadata-plaintext-secret-24680";

  function sameCompanyAgentActor() {
    return { type: "agent", agentId: "peer-agent", companyId, source: "agent_key" };
  }

  function stateWithMetadata(metadata: unknown) {
    const state = builtInState();
    return { ...state, agent: { ...state.agent, metadata } };
  }

  beforeEach(() => {
    vi.resetModules();
    registerModuleMocks();
    vi.clearAllMocks();
    mockInstanceSettingsService.getExperimental.mockResolvedValue({ enableBuiltInAgents: true });
  });

  it("masks a plain binding planted in metadata on the list route", async () => {
    mockBuiltInAgentService.list.mockResolvedValue([
      stateWithMetadata({ leaked: { type: "plain", value: METADATA_SECRET } }),
    ]);
    const app = await createApp(sameCompanyAgentActor());

    const res = await request(app).get(`/api/companies/${companyId}/built-in-agents`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // Precondition: this really is the redacted projection.
    expect(res.body[0].agent.adapterConfig).toEqual({});
    expect(res.body[0].agent.metadata).toEqual({
      leaked: { type: "plain", value: "***REDACTED***" },
    });
    expect(JSON.stringify(res.body)).not.toContain(METADATA_SECRET);
  });

  it("masks a tier-1 key name nested at depth in metadata on the status route", async () => {
    mockBuiltInAgentService.get.mockResolvedValue(
      stateWithMetadata({ a: { b: { apiKey: METADATA_SECRET } } }),
    );
    const app = await createApp(sameCompanyAgentActor());

    const res = await request(app).get(`/api/companies/${companyId}/built-in-agents/briefs/status`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.agent.adapterConfig).toEqual({});
    expect(res.body.agent.metadata).toEqual({ a: { b: { apiKey: "***REDACTED***" } } });
    expect(JSON.stringify(res.body)).not.toContain(METADATA_SECRET);
  });

  // Asserted as a pair with the foreign-prototype case below: the array must
  // SURVIVE element-wise masked and the foreign prototype must be WITHHELD. A
  // fix collapsing either into the other passes one and fails the other.
  it("keeps an ARRAY-valued metadata as an element-wise-masked array", async () => {
    mockBuiltInAgentService.list.mockResolvedValue([
      stateWithMetadata([{ type: "plain", value: METADATA_SECRET }]),
    ]);
    const app = await createApp(sameCompanyAgentActor());

    const res = await request(app).get(`/api/companies/${companyId}/built-in-agents`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(Array.isArray(res.body[0].agent.metadata)).toBe(true);
    expect(res.body[0].agent.metadata).toEqual([{ type: "plain", value: "***REDACTED***" }]);
    expect(JSON.stringify(res.body)).not.toContain(METADATA_SECRET);
  });

  it("withholds a metadata whose prototype is not Object.prototype", async () => {
    mockBuiltInAgentService.list.mockResolvedValue([
      stateWithMetadata(Object.assign(Object.create({ inherited: true }), {
        leaked: { type: "plain", value: METADATA_SECRET },
      })),
    ]);
    const app = await createApp(sameCompanyAgentActor());

    const res = await request(app).get(`/api/companies/${companyId}/built-in-agents`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body[0].agent.metadata).toBeNull();
    expect(JSON.stringify(res.body)).not.toContain(METADATA_SECRET);
  });

  // Non-regression guard, not a containment assertion: these markers are the
  // intended contents of the column and the reason it cannot simply be dropped.
  // This is the projection where they are LEAST likely to be absent.
  it("leaves the built-in and managed-resource markers readable", async () => {
    mockBuiltInAgentService.list.mockResolvedValue([
      stateWithMetadata({ paperclipBuiltInAgent: "briefs", paperclipManagedResource: true }),
    ]);
    const app = await createApp(sameCompanyAgentActor());

    const res = await request(app).get(`/api/companies/${companyId}/built-in-agents`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body[0].agent.metadata).toEqual({
      paperclipBuiltInAgent: "briefs",
      paperclipManagedResource: true,
    });
  });

  it("leaves a null-agent state untouched", async () => {
    const state = builtInState();
    mockBuiltInAgentService.list.mockResolvedValue([{ ...state, agent: null, agentId: null }]);
    const app = await createApp(sameCompanyAgentActor());

    const res = await request(app).get(`/api/companies/${companyId}/built-in-agents`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body[0].agent).toBeNull();
  });
});
