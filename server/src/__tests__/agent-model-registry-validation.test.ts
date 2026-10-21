import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// PEN-4447 — `PATCH /api/agents/:id` must refuse a model id the TARGET agent's
// adapter does not register, instead of returning 200 and killing the lane at
// its next pod boot.
//
// Scope split, on purpose: `adapters/model-validation.test.ts` owns the
// verdicts (which id is admissible for which adapter, the Bedrock branch, every
// fail-open arm) against the real registry. This file owns the WIRING — that
// the route consults the validator at all, with the stored adapter type and the
// merged effective config rather than the raw patch body, and that a finding
// becomes a 422 naming the valid set instead of a write.
//
// So `findUnregisteredAdapterModel` is mocked here and the arguments it
// receives are asserted; `describeUnregisteredModel` is the real formatter, so
// the response body is the one production emits.

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
const mockFindUnregisteredAdapterModel = vi.hoisted(() => vi.fn());

/** Stand-in registries, deliberately the real divergence from PEN-4447. */
const REGISTRIES: Record<string, string[]> = {
  claude_k8s: ["claude-opus-5", "claude-haiku-4-6", "claude-haiku-4-5-20251001"],
  claude_local: ["claude-opus-5", "claude-haiku-4-5"],
};

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

async function modelValidationMocks() {
  const actual = await vi.importActual<typeof import("../adapters/model-validation.js")>(
    "../adapters/model-validation.js",
  );
  return {
    ...actual,
    findUnregisteredAdapterModel: mockFindUnregisteredAdapterModel,
  };
}

vi.mock("../services/index.js", () => serviceModuleMocks());
vi.mock("../services/secrets.js", () => ({ secretService: () => mockSecretService }));
vi.mock("../services/environments.js", () => ({ environmentService: () => mockEnvironmentService }));
vi.mock("../adapters/index.js", () => ({
  findServerAdapter: mockFindServerAdapter,
  listAdapterModels: vi.fn(),
  listAdapterModelProfiles: vi.fn(async () => []),
}));
vi.mock("../adapters/model-validation.js", () => modelValidationMocks());

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => serviceModuleMocks());
  vi.doMock("../services/secrets.js", () => ({ secretService: () => mockSecretService }));
  vi.doMock("../services/environments.js", () => ({ environmentService: () => mockEnvironmentService }));
  vi.doMock("../adapters/index.js", () => ({
    findServerAdapter: mockFindServerAdapter,
    listAdapterModels: vi.fn(),
    listAdapterModelProfiles: vi.fn(async () => []),
  }));
  vi.doMock("../adapters/model-validation.js", () => modelValidationMocks());
}

const AGENT_ID = "22222222-2222-4222-8222-222222222222";

function boardUserActor() {
  return {
    type: "user",
    userId: "user-1",
    companyIds: ["company-1"],
    source: "session",
    isBoard: true,
  };
}

function makeAgent(overrides: Record<string, unknown> = {}) {
  return {
    id: AGENT_ID,
    companyId: "company-1",
    name: "Agent",
    role: "engineer",
    title: "Engineer",
    status: "active",
    reportsTo: null,
    capabilities: null,
    adapterType: "claude_k8s",
    adapterConfig: { model: "claude-opus-5", env: { CLAUDE_CONFIG_DIR: "/tmp/claude" } },
    runtimeConfig: {},
    defaultEnvironmentId: null,
    permissions: null,
    updatedAt: new Date(),
    ...overrides,
  };
}

async function createApp(actor: Record<string, unknown> = boardUserActor()) {
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

describe("PATCH /agents/:id refuses an unregistered model (PEN-4447)", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.doUnmock("../routes/agents.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockBuiltInAgentService.ensureCompanyDefaultAgentGrants.mockResolvedValue(0);
    mockSyncInstructionsBundleConfigFromFilePath.mockImplementation((_agent: unknown, config: unknown) => config);
    mockFindServerAdapter.mockImplementation((type: string) => ({ type }));
    mockAccessService.decide.mockResolvedValue({ allowed: true, reason: "allow_grant" });
    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.hasPermission.mockResolvedValue(true);
    mockAgentService.getById.mockResolvedValue(makeAgent());
    mockAgentService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeAgent(),
      ...patch,
    }));
    const { findUnregisteredModel } = await vi.importActual<
      typeof import("../adapters/model-validation.js")
    >("../adapters/model-validation.js");
    mockFindUnregisteredAdapterModel.mockImplementation(
      async (
        adapterType: string | null | undefined,
        adapterConfig: Record<string, unknown>,
        previous?: { adapterType?: string | null; adapterConfig?: Record<string, unknown> | null } | null,
      ) =>
        findUnregisteredModel({
          adapterType: adapterType ?? "",
          model: adapterConfig.model,
          registry: (REGISTRIES[adapterType ?? ""] ?? []).map((id) => ({ id })),
          registryIsClosed: Boolean(REGISTRIES[adapterType ?? ""]),
          previous: previous
            ? { adapterType: previous.adapterType, model: previous.adapterConfig?.model }
            : null,
          env: {},
        }),
    );
  });

  // THE REGRESSION. Pre-fix this was a 200 and the lane died at its next boot.
  it("refuses a model absent from the target adapter's registry with 422 and the valid set", async () => {
    const res = await requestApp(await createApp(), (baseUrl) => request(baseUrl)
      .patch(`/api/agents/${AGENT_ID}?companyId=company-1`)
      .send({ adapterConfig: { model: "claude-haiku-4-5" } }));

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(String(res.body.error)).toContain('Unknown model "claude-haiku-4-5"');
    expect(String(res.body.error)).toContain("claude_k8s");
    expect(String(res.body.error)).toContain("claude-haiku-4-6");
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  it("accepts a model the target adapter does register", async () => {
    const res = await requestApp(await createApp(), (baseUrl) => request(baseUrl)
      .patch(`/api/agents/${AGENT_ID}?companyId=company-1`)
      .send({ adapterConfig: { model: "claude-haiku-4-6" } }));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAgentService.update).toHaveBeenCalled();
  });

  it("validates against the agent's STORED adapter type and the MERGED config", async () => {
    await requestApp(await createApp(), (baseUrl) => request(baseUrl)
      .patch(`/api/agents/${AGENT_ID}?companyId=company-1`)
      .send({ adapterConfig: { model: "claude-haiku-4-6" } }));

    // The patch body names neither the adapter type nor `env`; both have to
    // come from the stored agent, or a config-dependent registry (the Bedrock
    // branch) would be resolved against the wrong lane.
    expect(mockFindUnregisteredAdapterModel).toHaveBeenCalledWith(
      "claude_k8s",
      expect.objectContaining({
        model: "claude-haiku-4-6",
        env: expect.objectContaining({ CLAUDE_CONFIG_DIR: "/tmp/claude" }),
      }),
      // ...and the stored pair, so the check can tell an id this write
      // INTRODUCES from the one the agent already had.
      expect.objectContaining({
        adapterType: "claude_k8s",
        adapterConfig: expect.objectContaining({ model: "claude-opus-5" }),
      }),
    );
  });

  it("refuses a move to an adapter that does not register the model already stored", async () => {
    // The stored model is valid where it sits. Re-pointing the lane at an
    // adapter whose registry lacks it is the same brick, reached by a patch
    // that never mentions `model`.
    mockAgentService.getById.mockResolvedValue(
      makeAgent({ adapterType: "claude_local", adapterConfig: { model: "claude-haiku-4-5" } }),
    );

    const res = await requestApp(await createApp(), (baseUrl) => request(baseUrl)
      .patch(`/api/agents/${AGENT_ID}?companyId=company-1`)
      .send({ adapterType: "claude_k8s" }));

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(String(res.body.error)).toContain('Unknown model "claude-haiku-4-5"');
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  it("leaves a patch that touches no adapter configuration alone", async () => {
    mockAgentService.getById.mockResolvedValue(
      makeAgent({ adapterConfig: { model: "retired-model-id" } }),
    );

    const res = await requestApp(await createApp(), (baseUrl) => request(baseUrl)
      .patch(`/api/agents/${AGENT_ID}?companyId=company-1`)
      .send({ title: "Staff Engineer" }));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockFindUnregisteredAdapterModel).not.toHaveBeenCalled();
  });


  it("lets an agent already on an unregistered model take an unrelated adapterConfig write", async () => {
    // Ally's finding on #2901: validating the stored id too would 422 every
    // repair on a lane whose model has since left the registry.
    mockAgentService.getById.mockResolvedValue(
      makeAgent({ adapterConfig: { model: "claude-haiku-4-5" } }),
    );

    const res = await requestApp(await createApp(), (baseUrl) => request(baseUrl)
      .patch(`/api/agents/${AGENT_ID}?companyId=company-1`)
      .send({ adapterConfig: { model: "claude-haiku-4-5", cwd: "/repaired/path" } }));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAgentService.update).toHaveBeenCalled();
  });

  it("still refuses a CHANGE away from that stored model to another unregistered one", async () => {
    mockAgentService.getById.mockResolvedValue(
      makeAgent({ adapterConfig: { model: "claude-haiku-4-5" } }),
    );

    const res = await requestApp(await createApp(), (baseUrl) => request(baseUrl)
      .patch(`/api/agents/${AGENT_ID}?companyId=company-1`)
      .send({ adapterConfig: { model: "claude-mythos-5" } }));

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  it("refuses an unregistered model inside a runtimeConfig model profile", async () => {
    const res = await requestApp(await createApp(), (baseUrl) => request(baseUrl)
      .patch(`/api/agents/${AGENT_ID}?companyId=company-1`)
      .send({
        runtimeConfig: {
          modelProfiles: { cheap: { adapterConfig: { model: "claude-haiku-4-5" } } },
        },
      }));

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(String(res.body.error)).toContain('Unknown model "claude-haiku-4-5"');
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });
});
