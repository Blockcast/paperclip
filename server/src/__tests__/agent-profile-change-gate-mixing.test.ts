import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// BLO-27751 — the agent profile-change consent gate must fail CLOSED on
// mixing.
//
// `PATCH /api/agents/:id` chooses between two authorization asserts:
//
//   assertCanApplyAgentProfileChange  (STRONG — scope {requiresChangeGrant:true},
//                                      so `allow_self` is skipped and the caller
//                                      needs agents:configure, or
//                                      agents:suggest-changes plus recorded consent)
//   assertCanUpdateAgent              (WEAK  — no scope, so a self-PATCH reaches
//                                      `allow_self` and is allowed with NO grant)
//
// The branch used to be selected by `profileOnlyChange`, which required
// *every* key in the body to be a profile field.  A body mixing a profile
// field with any non-profile key therefore fell through to the WEAK branch,
// letting an agent write its own `role` / `name` / `title` / `capabilities`
// with no grant and no consent.
//
// These tests pin the fail-closed semantics.  `accessService.decide` is
// mocked to reproduce the real decision function for an agent holding NO
// relevant grants (the common case on this fleet — most agents hold only
// `tasks:assign`): allow when the actor is patching itself and
// `requiresChangeGrant` is not set, deny otherwise.

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
  resolveByReference: vi.fn(),
}));

const mockBuiltInAgentService = vi.hoisted(() => ({
  ensureCompanyDefaultAgentGrants: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  decide: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockSecretService = vi.hoisted(() => ({
  resolveAdapterConfigForRuntime: vi.fn(),
  normalizeAdapterConfigForPersistence: vi.fn(
    async (_companyId: string, config: Record<string, unknown>) => config,
  ),
}));

const mockEnvironmentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());
const mockSyncInstructionsBundleConfigFromFilePath = vi.hoisted(() => vi.fn());
const mockFindServerAdapter = vi.hoisted(() => vi.fn());

function serviceModuleMocks() {
  return {
    agentService: () => mockAgentService,
    agentInstructionsService: () => ({}),
    accessService: () => mockAccessService,
    approvalService: () => ({}),
    builtInAgentService: () => mockBuiltInAgentService,
    companySkillService: () => ({ listRuntimeSkillEntries: vi.fn() }),
    budgetService: () => ({}),
    environmentService: () => mockEnvironmentService,
    heartbeatService: () => ({}),
    issueApprovalService: () => ({}),
    issueService: () => ({}),
    logActivity: mockLogActivity,
    secretService: () => mockSecretService,
    syncInstructionsBundleConfigFromFilePath: mockSyncInstructionsBundleConfigFromFilePath,
    workspaceOperationService: () => ({}),
  };
}

vi.mock("../services/index.js", () => serviceModuleMocks());
vi.mock("../services/secrets.js", () => ({ secretService: () => mockSecretService }));
vi.mock("../services/environments.js", () => ({ environmentService: () => mockEnvironmentService }));
vi.mock("../adapters/index.js", () => ({
  findServerAdapter: mockFindServerAdapter,
  listAdapterModels: vi.fn(),
}));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => serviceModuleMocks());
  vi.doMock("../services/secrets.js", () => ({ secretService: () => mockSecretService }));
  vi.doMock("../services/environments.js", () => ({ environmentService: () => mockEnvironmentService }));
  vi.doMock("../adapters/index.js", () => ({
    findServerAdapter: mockFindServerAdapter,
    listAdapterModels: vi.fn(),
  }));
}

const AGENT_ID = "11111111-1111-4111-8111-111111111111";

function selfAgentActor() {
  return {
    type: "agent",
    agentId: AGENT_ID,
    companyId: "company-1",
    source: "agent_key",
  };
}

function makeAgent() {
  return {
    id: AGENT_ID,
    companyId: "company-1",
    name: "Agent",
    role: "engineer",
    title: "Engineer",
    status: "active",
    reportsTo: null,
    capabilities: null,
    adapterType: "codex_local",
    adapterConfig: {},
    runtimeConfig: {},
    defaultEnvironmentId: null,
    permissions: null,
    updatedAt: new Date(),
  };
}

async function createApp(actor: Record<string, unknown> = selfAgentActor()) {
  const [{ agentRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/agents.js")>("../routes/agents.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  const db = { update: () => ({ set: () => ({ where: async () => [] }) }) };
  app.use("/api", agentRoutes(db as any));
  app.use(errorHandler);
  return app;
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
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  }
}

/**
 * Reproduces `decideBase` for an agent that holds NEITHER `agents:configure`
 * NOR `agents:suggest-changes` — the shape of most agents on this fleet.
 *
 * `allow_self` (authorization.ts) fires only when `requiresChangeGrant` is
 * absent from the scope, which is exactly what distinguishes the weak branch
 * from the strong one.  `deny_no_grant` (rather than `deny_missing_consent`)
 * keeps the route out of the change-consent-gate fallback, which would need a
 * real database.
 */
function decideAsAgentWithNoGrants({
  action,
  resource,
  scope,
}: {
  action: string;
  resource: { type: string; agentId?: string };
  scope?: Record<string, unknown>;
}) {
  const isSelf = resource.type === "agent" && resource.agentId === AGENT_ID;
  if (action === "agent_config:update" && isSelf && scope?.requiresChangeGrant !== true) {
    return {
      allowed: true,
      reason: "allow_self",
      explanation: "Allowed because the actor is updating its own agent configuration.",
    };
  }
  return {
    allowed: false,
    reason: "deny_no_grant",
    explanation: "Missing permission: agents:configure or agents:suggest-changes.",
  };
}

describe("agent profile-change gate fails closed on mixed patches (BLO-27751)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/agents.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockBuiltInAgentService.ensureCompanyDefaultAgentGrants.mockResolvedValue(0);
    mockSyncInstructionsBundleConfigFromFilePath.mockImplementation((_agent, config) => config);
    mockFindServerAdapter.mockImplementation((type: string) => ({ type }));
    mockAccessService.decide.mockImplementation(async (input: any) => decideAsAgentWithNoGrants(input));
    mockAgentService.getById.mockResolvedValue(makeAgent());
    mockAgentService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeAgent(),
      ...patch,
    }));
  });

  // THE REGRESSION. Pre-fix this returned 200: `profileOnlyChange` was false
  // because `icon` is not a profile field, so the route took the weak branch
  // and `allow_self` let the agent rewrite its own `role`.
  it("refuses a self-PATCH that mixes `role` with a non-profile key", async () => {
    const res = await requestApp(await createApp(), (baseUrl) => request(baseUrl)
      .patch(`/api/agents/${AGENT_ID}?companyId=company-1`)
      .send({ role: "cto", icon: "crown" }));

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(mockAgentService.update).not.toHaveBeenCalled();
    // The strong branch is identified by the scope it decides with.
    expect(mockAccessService.decide).toHaveBeenCalledWith(expect.objectContaining({
      action: "agent_config:update",
      scope: expect.objectContaining({ requiresChangeGrant: true }),
    }));
  });

  it("refuses a self-PATCH that mixes `role` with a nested adapterConfig write", async () => {
    const res = await requestApp(await createApp(), (baseUrl) => request(baseUrl)
      .patch(`/api/agents/${AGENT_ID}?companyId=company-1`)
      .send({ role: "cto", adapterConfig: { model: "gpt-5.4" } }));

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  // `role` is enum-validated before the authorization gate runs, so each field
  // must carry a value that is *valid* — otherwise the request 400s on schema
  // validation and never reaches the branch under test.
  it.each([
    ["name", "Escalated"],
    ["role", "cto"],
    ["title", "Escalated"],
    ["capabilities", "escalated"],
  ])(
    "refuses a self-PATCH mixing the profile field `%s` with a non-profile key",
    async (field, value) => {
      const res = await requestApp(await createApp(), (baseUrl) => request(baseUrl)
        .patch(`/api/agents/${AGENT_ID}?companyId=company-1`)
        .send({ [field]: value, icon: "crown" }));

      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(mockAgentService.update).not.toHaveBeenCalled();
    },
  );

  // Positive control for the gate that already worked — proves the mocked
  // decision function is capable of returning 403 through the pure path too,
  // so the assertions above are not passing for an unrelated reason.
  it("still refuses a profile-only self-PATCH", async () => {
    const res = await requestApp(await createApp(), (baseUrl) => request(baseUrl)
      .patch(`/api/agents/${AGENT_ID}?companyId=company-1`)
      .send({ role: "cto" }));

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  // Negative control — the fix must NOT over-block.  A patch touching no
  // profile field keeps the weak branch, so `allow_self` still lets an agent
  // manage its own non-profile configuration.  Without this, a fix that
  // simply routed everything through the strong branch would also pass.
  it("still allows a self-PATCH that touches no profile field", async () => {
    const res = await requestApp(await createApp(), (baseUrl) => request(baseUrl)
      .patch(`/api/agents/${AGENT_ID}?companyId=company-1`)
      .send({ icon: "crown" }));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAgentService.update).toHaveBeenCalledWith(
      AGENT_ID,
      expect.objectContaining({ icon: "crown" }),
      expect.any(Object),
    );
    // The weak branch decides with no scope at all (the key is absent, not
    // `undefined`), which is precisely what lets `allow_self` fire.
    const updateDecisions = mockAccessService.decide.mock.calls
      .map((call) => call[0] as { action: string; scope?: Record<string, unknown> })
      .filter((input) => input.action === "agent_config:update");
    expect(updateDecisions).not.toHaveLength(0);
    expect(updateDecisions.every((input) => input.scope?.requiresChangeGrant !== true)).toBe(true);
  });
});
