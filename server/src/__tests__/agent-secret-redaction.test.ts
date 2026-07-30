import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentRoutes, stripRedactedEnvBindingsFromAdapterConfig } from "../routes/agents.js";
import { errorHandler } from "../middleware/index.js";

const agentId = "11111111-1111-4111-8111-111111111111";
const companyId = "22222222-2222-4222-8222-222222222222";

const baseAgent = {
  id: agentId,
  companyId,
  name: "Builder",
  urlKey: "builder",
  role: "engineer",
  title: "Builder",
  icon: null,
  status: "idle",
  reportsTo: null,
  capabilities: null,
  adapterType: "claude_local",
  adapterConfig: {
    cwd: "/workspace",
    mcpServers: {
      gbrain: {
        type: "http",
        url: "http://gbrain-mcp-admin.paperclip.svc.cluster.local:3130/mcp",
        headers: {
          Authorization: "Bearer gbrain_at_secret_12345",
          "x-safe-routing-header": "paperclip",
        },
      },
    },
    env: {
      OPENAI_API_KEY: "sk-secret-key-12345",
      ANTHROPIC_API_KEY: "sk-ant-secret-67890",
      DATABASE_URL: "postgres://user:pass@host/db",
      PAPERCLIP_API_URL: "http://localhost:3100",
    },
  },
  runtimeConfig: {},
  budgetMonthlyCents: 0,
  spentMonthlyCents: 0,
  pauseReason: null,
  pausedAt: null,
  permissions: { canCreateAgents: false },
  lastHeartbeatAt: null,
  metadata: null,
  createdAt: new Date("2026-03-19T00:00:00.000Z"),
  updatedAt: new Date("2026-03-19T00:00:00.000Z"),
};

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  updatePermissions: vi.fn(),
  getChainOfCommand: vi.fn(),
  resolveByReference: vi.fn(),
  orgForCompany: vi.fn(),
  listConfigRevisions: vi.fn(),
  getConfigRevision: vi.fn(),
  rollbackConfigRevision: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  terminate: vi.fn(),
  remove: vi.fn(),
  listKeys: vi.fn(),
  createApiKey: vi.fn(),
  revokeKey: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
  decide: vi.fn(),
  getMembership: vi.fn(),
  ensureMembership: vi.fn(),
  listPrincipalGrants: vi.fn(),
  setPrincipalPermission: vi.fn(),
}));

const mockApprovalService = vi.hoisted(() => ({
  create: vi.fn(),
  getById: vi.fn(),
  findOpenHireApprovalForAgent: vi.fn(),
  reject: vi.fn(),
}));

const mockBudgetService = vi.hoisted(() => ({
  upsertPolicy: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  listTaskSessions: vi.fn(),
  resetRuntimeSession: vi.fn(),
  cancelActiveForAgent: vi.fn(),
  cancelInvocationsForAgents: vi.fn(),
}));

const mockIssueApprovalService = vi.hoisted(() => ({
  linkManyForApproval: vi.fn(),
}));

const mockSecretService = vi.hoisted(() => ({
  normalizeAdapterConfigForPersistence: vi.fn(),
  resolveAdapterConfigForRuntime: vi.fn(),
}));

const mockAgentInstructionsService = vi.hoisted(() => ({
  materializeManagedBundle: vi.fn(),
}));

const mockCompanySkillService = vi.hoisted(() => ({
  listRuntimeSkillEntries: vi.fn(),
  resolveRequestedSkillKeys: vi.fn(),
}));

const mockWorkspaceOperationService = vi.hoisted(() => ({}));
const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  agentService: () => mockAgentService,
  agentInstructionsService: () => mockAgentInstructionsService,
  accessService: () => mockAccessService,
  approvalService: () => mockApprovalService,
  companySkillService: () => mockCompanySkillService,
  budgetService: () => mockBudgetService,
  heartbeatService: () => mockHeartbeatService,
  issueApprovalService: () => mockIssueApprovalService,
  issueService: () => ({}),
  logActivity: mockLogActivity,
  secretService: () => mockSecretService,
  syncInstructionsBundleConfigFromFilePath: vi.fn((_agent, config) => config),
  workspaceOperationService: () => mockWorkspaceOperationService,
}));

function createDbStub() {
  const rows = [{
    id: companyId,
    name: "Paperclip",
    requireBoardApprovalForNewAgents: false,
  }];
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        // A real thenable: `await db.select()...where()` must resolve. A mock
        // that merely *returns* a promise from `then` never calls the awaiting
        // continuation, so the request hangs instead of failing.
        where: vi.fn().mockReturnValue({
          then: (resolve: (value: unknown) => unknown) => Promise.resolve(resolve(rows)),
        }),
      }),
    }),
  };
}

function createApp(actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", agentRoutes(createDbStub() as any));
  app.use(errorHandler);
  return app;
}

const boardActor = {
  type: "board",
  userId: "board-user",
  source: "local_implicit",
  isInstanceAdmin: true,
  companyIds: [companyId],
};

const nonAdminBoardActor = {
  type: "board",
  userId: "board-user-2",
  source: "web",
  isInstanceAdmin: false,
  companyIds: [companyId],
};

const agentActor = {
  type: "agent",
  agentId,
  companyId,
  companyIds: [companyId],
};

describe("agent secret redaction in API responses", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAgentService.getById.mockResolvedValue(baseAgent);
    mockAgentService.list.mockResolvedValue([baseAgent]);
    mockAgentService.getChainOfCommand.mockResolvedValue([]);
    mockAgentService.resolveByReference.mockResolvedValue({ ambiguous: false, agent: baseAgent });
    mockAccessService.getMembership.mockResolvedValue({
      id: "membership-1",
      companyId,
      principalType: "agent",
      principalId: agentId,
      status: "active",
      membershipRole: "member",
      createdAt: new Date("2026-03-19T00:00:00.000Z"),
      updatedAt: new Date("2026-03-19T00:00:00.000Z"),
    });
    mockAccessService.listPrincipalGrants.mockResolvedValue([]);
    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.decide.mockResolvedValue({ allowed: true });
    mockCompanySkillService.listRuntimeSkillEntries.mockResolvedValue([]);
    mockSecretService.normalizeAdapterConfigForPersistence.mockImplementation(async (_companyId, config) => config);
    mockSecretService.resolveAdapterConfigForRuntime.mockImplementation(async (_companyId, config) => ({ config }));
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("GET /companies/:companyId/agents redacts env values for board users", async () => {
    const app = createApp(boardActor);
    const res = await request(app).get(`/api/companies/${companyId}/agents`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    const agent = res.body[0];
    expect(agent.adapterConfig.cwd).toBe("/workspace");
    expect(agent.adapterConfig.env).toEqual({
      OPENAI_API_KEY: "***",
      ANTHROPIC_API_KEY: "***",
      DATABASE_URL: "***",
      PAPERCLIP_API_URL: "***",
    });
  });

  it("GET /agents/me redacts env values", async () => {
    const app = createApp(agentActor);
    const res = await request(app).get("/api/agents/me");

    expect(res.status).toBe(200);
    expect(res.body.adapterConfig.env).toEqual({
      OPENAI_API_KEY: "***",
      ANTHROPIC_API_KEY: "***",
      DATABASE_URL: "***",
      PAPERCLIP_API_URL: "***",
    });
  });

  it("GET /agents/me redacts nested MCP authorization headers", async () => {
    const app = createApp(agentActor);
    const res = await request(app).get("/api/agents/me");

    expect(res.status).toBe(200);
    expect(res.body.adapterConfig.mcpServers.gbrain).toEqual({
      type: "http",
      url: "http://gbrain-mcp-admin.paperclip.svc.cluster.local:3130/mcp",
      headers: {
        Authorization: "***REDACTED***",
        "x-safe-routing-header": "paperclip",
      },
    });
  });

  it("GET /agents/:id redacts env values", async () => {
    const app = createApp(boardActor);
    const res = await request(app).get(`/api/agents/${agentId}`);

    expect(res.status).toBe(200);
    expect(res.body.adapterConfig.env).toEqual({
      OPENAI_API_KEY: "***",
      ANTHROPIC_API_KEY: "***",
      DATABASE_URL: "***",
      PAPERCLIP_API_URL: "***",
    });
  });

  it("preserves non-env adapterConfig fields", async () => {
    const app = createApp(boardActor);
    const res = await request(app).get(`/api/companies/${companyId}/agents`);

    expect(res.status).toBe(200);
    expect(res.body[0].adapterConfig.cwd).toBe("/workspace");
  });

  it("GET /companies/:companyId/agents redacts env values for non-admin board users", async () => {
    mockAccessService.canUser.mockResolvedValue(false);
    const app = createApp(nonAdminBoardActor);
    const res = await request(app).get(`/api/companies/${companyId}/agents`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    const agent = res.body[0];
    expect(agent.adapterConfig.cwd).toBe("/workspace");
    expect(agent.adapterConfig.env).toEqual({
      OPENAI_API_KEY: "***",
      ANTHROPIC_API_KEY: "***",
      DATABASE_URL: "***",
      PAPERCLIP_API_URL: "***",
    });
  });

  it("redacts sensitive runtimeConfig values", async () => {
    mockAgentService.list.mockResolvedValue([{
      ...baseAgent,
      runtimeConfig: { auth_token: "tok_secret_abc123", mode: "production" },
    }]);

    const app = createApp(boardActor);
    const res = await request(app).get(`/api/companies/${companyId}/agents`);

    expect(res.status).toBe(200);
    const agent = res.body[0];
    expect(agent.runtimeConfig.auth_token).toBe("***REDACTED***");
    expect(agent.runtimeConfig.mode).toBe("production");
  });

  it("handles agents with no env in adapterConfig", async () => {
    mockAgentService.list.mockResolvedValue([{
      ...baseAgent,
      adapterConfig: {
        cwd: "/workspace",
        mcpServers: {
          gbrain: { headers: { Authorization: "Bearer nested-secret" } },
        },
      },
    }]);

    const app = createApp(boardActor);
    const res = await request(app).get(`/api/companies/${companyId}/agents`);

    expect(res.status).toBe(200);
    expect(res.body[0].adapterConfig).toEqual({
      cwd: "/workspace",
      mcpServers: {
        gbrain: { headers: { Authorization: "***REDACTED***" } },
      },
    });
  });
});

// BLO-18969 (2026-07-30): the redaction above was applied only on the read
// paths. Every mutating route returned the agent row verbatim, so a budget-only
// `PATCH /api/agents/:id` handed the caller the agent's entire credential set —
// plaintext env bindings plus `Bearer …` in mcpServers headers. Those responses
// land in agent transcripts and run logs, which are read far more widely than
// the secret store. A CEO cap-adjustment pass harvested ~9 credential
// categories, including a wallet private key, from 12 such patches.
describe("agent secret redaction on mutating responses", () => {
  const SECRET_STRINGS = [
    "sk-secret-key-12345",
    "sk-ant-secret-67890",
    "postgres://user:pass@host/db",
    "gbrain_at_secret_12345",
  ];

  function expectNoPlaintextSecrets(body: unknown) {
    const serialized = JSON.stringify(body);
    for (const secret of SECRET_STRINGS) {
      expect(serialized).not.toContain(secret);
    }
    // The shapes that carry them, per the BLO-18969 acceptance criteria.
    expect(serialized).not.toContain("Bearer ");
    expect(serialized).not.toMatch(/"type":"plain","value":"(?!\*\*\*)/);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockAgentService.getById.mockResolvedValue(baseAgent);
    mockAgentService.update.mockResolvedValue(baseAgent);
    mockAgentService.updatePermissions.mockResolvedValue(baseAgent);
    mockAgentService.pause.mockResolvedValue({ ...baseAgent, status: "paused" });
    mockAgentService.resume.mockResolvedValue({ ...baseAgent, status: "idle" });
    mockAgentService.terminate.mockResolvedValue({ ...baseAgent, status: "terminated" });
    mockAgentService.rollbackConfigRevision.mockResolvedValue(baseAgent);
    mockAgentService.getChainOfCommand.mockResolvedValue([]);
    mockAgentService.resolveByReference.mockResolvedValue({ ambiguous: false, agent: baseAgent });
    mockAccessService.getMembership.mockResolvedValue(null);
    mockAccessService.listPrincipalGrants.mockResolvedValue([]);
    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.decide.mockResolvedValue({ allowed: true });
    mockApprovalService.findOpenHireApprovalForAgent.mockResolvedValue(null);
    mockHeartbeatService.cancelActiveForAgent.mockResolvedValue(undefined);
    mockHeartbeatService.cancelInvocationsForAgents.mockResolvedValue({
      agentIds: [agentId],
      runsCancelled: 0,
      wakeupsCancelled: 0,
    });
    mockCompanySkillService.listRuntimeSkillEntries.mockResolvedValue([]);
    mockSecretService.normalizeAdapterConfigForPersistence.mockImplementation(async (_companyId, config) => config);
    mockSecretService.resolveAdapterConfigForRuntime.mockImplementation(async (_companyId, config) => ({ config }));
    mockLogActivity.mockResolvedValue(undefined);
  });

  // The reported case: a patch that touches no credential field at all.
  it("PATCH /agents/:id redacts secrets on a budget-only patch", async () => {
    mockAgentService.update.mockResolvedValue({ ...baseAgent, budgetMonthlyCents: 123_456 });

    const app = createApp(boardActor);
    const res = await request(app).patch(`/api/agents/${agentId}`).send({ budgetMonthlyCents: 123_456 });

    expect(res.status).toBe(200);
    // The patch itself still has to work.
    expect(res.body.budgetMonthlyCents).toBe(123_456);
    expect(res.body.adapterConfig.env).toEqual({
      OPENAI_API_KEY: "***",
      ANTHROPIC_API_KEY: "***",
      DATABASE_URL: "***",
      PAPERCLIP_API_URL: "***",
    });
    expect(res.body.adapterConfig.mcpServers.gbrain.headers.Authorization).toBe("***REDACTED***");
    expectNoPlaintextSecrets(res.body);
  });

  it("PATCH /agents/:id/permissions redacts secrets", async () => {
    const app = createApp(boardActor);
    const res = await request(app)
      .patch(`/api/agents/${agentId}/permissions`)
      .send({ canCreateAgents: true, canAssignTasks: false });

    expect(res.status).toBe(200);
    expectNoPlaintextSecrets(res.body);
  });

  for (const route of ["pause", "resume", "terminate"] as const) {
    it(`POST /agents/:id/${route} redacts secrets`, async () => {
      const app = createApp(boardActor);
      const res = await request(app).post(`/api/agents/${agentId}/${route}`).send({});

      // Assert the success path explicitly — an early 4xx would let this pass
      // vacuously and hide a live leak.
      expect(res.status).toBe(200);
      expectNoPlaintextSecrets(res.body);
    });
  }

  it("POST /agents/:id/config-revisions/:revisionId/rollback redacts secrets", async () => {
    const app = createApp(boardActor);
    const res = await request(app)
      .post(`/api/agents/${agentId}/config-revisions/33333333-3333-4333-8333-333333333333/rollback`)
      .send({});

    expect(res.status).toBe(200);
    expectNoPlaintextSecrets(res.body);
  });

  // secret_ref bindings are pointers, never plaintext. They must not gain a
  // resolved `value` on any response regardless of projectionClass.
  it("never serializes a resolved value for a secret_ref env binding", async () => {
    const refAgent = {
      ...baseAgent,
      adapterConfig: {
        env: {
          WALLET_PRIVATE_KEY: {
            type: "secret_ref",
            secretId: "44444444-4444-4444-8444-444444444444",
            projectionClass: "unclassified",
          },
        },
      },
    };
    mockAgentService.getById.mockResolvedValue(refAgent);
    mockAgentService.update.mockResolvedValue(refAgent);

    const app = createApp(boardActor);
    const res = await request(app).patch(`/api/agents/${agentId}`).send({ budgetMonthlyCents: 1 });

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain("\"value\"");
  });

  // Redaction used to be decided by the key's *name*. Everything below uses
  // keys that no secret-name regex matches, so each of these leaked plaintext
  // before the redactor became structural.
  const ORDINARY_KEY_SECRET = "s3cret-material-not-in-any-key-name";

  it("redacts a nested runtimeConfig model-profile env binding under an ordinary key", async () => {
    const nestedAgent = {
      ...baseAgent,
      runtimeConfig: {
        modelProfiles: {
          cheap: {
            adapterConfig: {
              model: "openai/gpt-5.6-sol",
              env: {
                // Neither key matches SECRET_PAYLOAD_KEY_RE.
                SIGNING_MATERIAL: { type: "plain", value: ORDINARY_KEY_SECRET },
                FOO: { type: "plain", value: ORDINARY_KEY_SECRET },
              },
            },
          },
        },
      },
    };
    mockAgentService.getById.mockResolvedValue(nestedAgent);
    mockAgentService.update.mockResolvedValue({ ...nestedAgent, budgetMonthlyCents: 42 });

    const app = createApp(boardActor);
    const res = await request(app).patch(`/api/agents/${agentId}`).send({ budgetMonthlyCents: 42 });

    expect(res.status).toBe(200);
    expect(res.body.budgetMonthlyCents).toBe(42);
    const profile = res.body.runtimeConfig.modelProfiles.cheap.adapterConfig;
    // Non-credential config stays readable; only the bindings are masked.
    expect(profile.model).toBe("openai/gpt-5.6-sol");
    expect(profile.env).toEqual({
      SIGNING_MATERIAL: { type: "plain", value: "***REDACTED***" },
      FOO: { type: "plain", value: "***REDACTED***" },
    });
    expect(JSON.stringify(res.body)).not.toContain(ORDINARY_KEY_SECRET);
  });

  it("redacts a legacy bare-string env value under an ordinary key at any depth", async () => {
    const nestedAgent = {
      ...baseAgent,
      runtimeConfig: {
        modelProfiles: {
          cheap: { adapterConfig: { env: { FOO: ORDINARY_KEY_SECRET } } },
        },
      },
    };
    mockAgentService.getById.mockResolvedValue(nestedAgent);
    mockAgentService.update.mockResolvedValue(nestedAgent);

    const app = createApp(boardActor);
    const res = await request(app).patch(`/api/agents/${agentId}`).send({ budgetMonthlyCents: 1 });

    expect(res.status).toBe(200);
    expect(res.body.runtimeConfig.modelProfiles.cheap.adapterConfig.env).toEqual({
      FOO: "***REDACTED***",
    });
  });

  it("redacts a plain binding under an ordinary key outside env", async () => {
    const nestedAgent = {
      ...baseAgent,
      adapterConfig: {
        cwd: "/workspace",
        // Not under `env`, not a secret-shaped key name.
        signingMaterial: { type: "plain", value: ORDINARY_KEY_SECRET },
      },
    };
    mockAgentService.getById.mockResolvedValue(nestedAgent);
    mockAgentService.update.mockResolvedValue(nestedAgent);

    const app = createApp(boardActor);
    const res = await request(app).patch(`/api/agents/${agentId}`).send({ budgetMonthlyCents: 1 });

    expect(res.status).toBe(200);
    expect(res.body.adapterConfig.cwd).toBe("/workspace");
    expect(res.body.adapterConfig.signingMaterial).toEqual({ type: "plain", value: "***REDACTED***" });
    expect(JSON.stringify(res.body)).not.toContain(ORDINARY_KEY_SECRET);
  });

  it("strips a resolved value smuggled onto a secret_ref binding", async () => {
    // envBindingSecretRefSchema has no `value` field, so its presence can only
    // mean a resolved secret rode along — projectionClass must not matter.
    const refAgent = {
      ...baseAgent,
      runtimeConfig: {
        modelProfiles: {
          cheap: {
            adapterConfig: {
              env: {
                FOO: {
                  type: "secret_ref",
                  secretId: "44444444-4444-4444-8444-444444444444",
                  projectionClass: "unclassified",
                  value: ORDINARY_KEY_SECRET,
                },
              },
            },
          },
        },
      },
    };
    mockAgentService.getById.mockResolvedValue(refAgent);
    mockAgentService.update.mockResolvedValue(refAgent);

    const app = createApp(boardActor);
    const res = await request(app).patch(`/api/agents/${agentId}`).send({ budgetMonthlyCents: 1 });

    expect(res.status).toBe(200);
    expect(res.body.runtimeConfig.modelProfiles.cheap.adapterConfig.env.FOO).toEqual({
      type: "secret_ref",
      secretId: "44444444-4444-4444-8444-444444444444",
      projectionClass: "unclassified",
    });
    expect(JSON.stringify(res.body)).not.toContain(ORDINARY_KEY_SECRET);
  });
});

describe("stripRedactedEnvBindingsFromAdapterConfig — round-trip guard", () => {
  // BLO-5xxx (2026-05-15): redactAgentSecrets() replaces every
  // adapter_config.env value with "***" on GET responses. A naive UI/operator
  // round-trip (read agent, edit, save) would persist the sentinel as the
  // real value. That broke Staff Engineer's opencode_k8s pods — PATH was
  // saved as "***", every spawn died with
  //   `exec: "sh": executable file not found in $PATH`.
  // The PATCH/POST routes pre-process the incoming adapterConfig through this
  // helper, so a redacted view saved unchanged is effectively a no-op for
  // those keys.

  it("preserves the existing binding when the incoming value is the redacted sentinel string", () => {
    const incoming = {
      cwd: "/workspace",
      env: {
        OPENAI_API_KEY: "***",
        ANTHROPIC_API_KEY: "***",
        DATABASE_URL: "sk-newvalue-789",
      },
    };
    const existing = {
      env: {
        OPENAI_API_KEY: "sk-secret-key-12345",
        ANTHROPIC_API_KEY: "sk-ant-secret-67890",
        DATABASE_URL: "postgres://user:pass@host/db",
      },
    };
    const result = stripRedactedEnvBindingsFromAdapterConfig(incoming, existing);
    expect(result).toEqual({
      cwd: "/workspace",
      env: {
        OPENAI_API_KEY: "sk-secret-key-12345",
        ANTHROPIC_API_KEY: "sk-ant-secret-67890",
        DATABASE_URL: "sk-newvalue-789",
      },
    });
  });

  it("preserves the existing binding for the canonical sentinel object form {type:'plain', value:'***'}", () => {
    // envBindingSchema also accepts the canonical shape; both must be guarded.
    // This is the exact shape we found persisted in the live DB.
    const incoming = {
      env: {
        OPENAI_API_KEY: { type: "plain", value: "***" },
        DATABASE_URL: { type: "plain", value: "sk-newvalue-789" },
      },
    };
    const existing = {
      env: {
        OPENAI_API_KEY: "sk-secret-key-12345",
      },
    };
    const result = stripRedactedEnvBindingsFromAdapterConfig(incoming, existing);
    expect(result.env).toEqual({
      OPENAI_API_KEY: "sk-secret-key-12345",
      DATABASE_URL: { type: "plain", value: "sk-newvalue-789" },
    });
  });

  it("drops the env entry when the sentinel comes in for a key with no prior binding (create flow)", () => {
    const incoming = {
      env: {
        OPENAI_API_KEY: "***",
        DATABASE_URL: "sk-real-value",
      },
    };
    const result = stripRedactedEnvBindingsFromAdapterConfig(incoming, null);
    expect(result.env).toEqual({ DATABASE_URL: "sk-real-value" });
  });

  it("only treats the exact sentinel as the sentinel — '***value' is a real value", () => {
    const incoming = { env: { OPENAI_API_KEY: "***actual_pseudo_redacted_prefix" } };
    const result = stripRedactedEnvBindingsFromAdapterConfig(incoming, null);
    expect(result.env).toEqual({ OPENAI_API_KEY: "***actual_pseudo_redacted_prefix" });
  });

  it("passes through configs that have no env field unchanged", () => {
    const incoming = { cwd: "/workspace", timeoutSec: 30 };
    const result = stripRedactedEnvBindingsFromAdapterConfig(incoming, null);
    expect(result).toBe(incoming);
  });

  it("preserves secret_ref bindings (only plain '***' is the sentinel)", () => {
    const incoming = {
      env: {
        OPENAI_API_KEY: { type: "secret_ref", secretId: "11111111-1111-4111-8111-111111111111" },
      },
    };
    const result = stripRedactedEnvBindingsFromAdapterConfig(incoming, null);
    expect(result.env).toEqual({
      OPENAI_API_KEY: { type: "secret_ref", secretId: "11111111-1111-4111-8111-111111111111" },
    });
  });

  it("preserves nested values returned as the recursive redaction sentinel", () => {
    const incoming = {
      model: "openai/gpt-5.6-sol",
      mcpServers: {
        gbrain: {
          type: "http",
          url: "http://gbrain.example/mcp",
          headers: { Authorization: "***REDACTED***" },
        },
      },
    };
    const existing = {
      model: "openai/gpt-5.5",
      mcpServers: {
        gbrain: {
          type: "http",
          url: "http://gbrain.example/mcp",
          headers: { Authorization: "Bearer gbrain_at_existing" },
        },
      },
    };

    expect(stripRedactedEnvBindingsFromAdapterConfig(incoming, existing)).toEqual({
      model: "openai/gpt-5.6-sol",
      mcpServers: {
        gbrain: {
          type: "http",
          url: "http://gbrain.example/mcp",
          headers: { Authorization: "Bearer gbrain_at_existing" },
        },
      },
    });
  });

  it("preserves nested plain bindings returned with a redacted value", () => {
    const incoming = {
      credentials: { type: "plain", value: "***REDACTED***" },
    };
    const existing = {
      credentials: { type: "plain", value: "existing-secret" },
    };

    expect(stripRedactedEnvBindingsFromAdapterConfig(incoming, existing)).toEqual(existing);
  });

  it("drops recursive redaction sentinels that have no existing value", () => {
    const incoming = {
      model: "openai/gpt-5.6-sol",
      mcpServers: {
        gbrain: { headers: { Authorization: "***REDACTED***" } },
      },
    };

    expect(stripRedactedEnvBindingsFromAdapterConfig(incoming, null)).toEqual({
      model: "openai/gpt-5.6-sol",
      mcpServers: { gbrain: { headers: {} } },
    });
  });
});
