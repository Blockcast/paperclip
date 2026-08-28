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
  it("PATCH /agents/:id redacts secrets on a patch touching no credential field", async () => {
    mockAgentService.update.mockResolvedValue({ ...baseAgent, spentMonthlyCents: 123_456 });

    const app = createApp(boardActor);
    const res = await request(app).patch(`/api/agents/${agentId}`).send({ spentMonthlyCents: 123_456 });

    expect(res.status).toBe(200);
    // The patch itself still has to work.
    expect(res.body.spentMonthlyCents).toBe(123_456);
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
    const res = await request(app).patch(`/api/agents/${agentId}`).send({ spentMonthlyCents: 1 });

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
    mockAgentService.update.mockResolvedValue({ ...nestedAgent, spentMonthlyCents: 42 });

    const app = createApp(boardActor);
    const res = await request(app).patch(`/api/agents/${agentId}`).send({ spentMonthlyCents: 42 });

    expect(res.status).toBe(200);
    expect(res.body.spentMonthlyCents).toBe(42);
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
    const res = await request(app).patch(`/api/agents/${agentId}`).send({ spentMonthlyCents: 1 });

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
    const res = await request(app).patch(`/api/agents/${agentId}`).send({ spentMonthlyCents: 1 });

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
    const res = await request(app).patch(`/api/agents/${agentId}`).send({ spentMonthlyCents: 1 });

    expect(res.status).toBe(200);
    expect(res.body.runtimeConfig.modelProfiles.cheap.adapterConfig.env.FOO).toEqual({
      type: "secret_ref",
      secretId: "44444444-4444-4444-8444-444444444444",
      projectionClass: "unclassified",
    });
    expect(JSON.stringify(res.body)).not.toContain(ORDINARY_KEY_SECRET);
  });

  it("restores recursive runtimeConfig sentinels before persisting PATCH updates", async () => {
    const runtimeSecretAgent = {
      ...baseAgent,
      runtimeConfig: {
        credentials: { type: "plain", value: ORDINARY_KEY_SECRET },
        mode: "production",
      },
    };
    mockAgentService.getById.mockResolvedValue(runtimeSecretAgent);
    mockAgentService.update.mockImplementation(async (_id, patch) => ({
      ...runtimeSecretAgent,
      ...(patch as Record<string, unknown>),
    }));

    const app = createApp(boardActor);
    const res = await request(app)
      .patch(`/api/agents/${agentId}`)
      .send({
        runtimeConfig: {
          credentials: { type: "plain", value: "***REDACTED***" },
          mode: "maintenance",
        },
      });

    expect(res.status).toBe(200);
    expect(mockAgentService.update).toHaveBeenCalledWith(
      agentId,
      expect.objectContaining({
        runtimeConfig: {
          credentials: { type: "plain", value: ORDINARY_KEY_SECRET },
          mode: "maintenance",
        },
      }),
      expect.anything(),
    );
    expect(res.body.runtimeConfig.credentials).toEqual({
      type: "plain",
      value: "***REDACTED***",
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

  it("drops nested plain binding sentinels that have no existing value", () => {
    const incoming = {
      credentials: { type: "plain", value: "***REDACTED***" },
      model: "openai/gpt-5.6-sol",
    };

    expect(stripRedactedEnvBindingsFromAdapterConfig(incoming, null)).toEqual({
      model: "openai/gpt-5.6-sol",
    });
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

// BLO-27991: `PATCH /agents/:id` carrying only `adapterConfig` takes the weak
// authorization branch (`allow_self`), and the sync path behind it authorizes a
// binding on same-company membership alone. Without a route guard any agent can
// bind any company secret to itself. `decide` is mocked allow throughout, so
// these assert the guard specifically and not the surrounding authorization.
describe("agent self-service secret binding guard", () => {
  const otherSecretId = "33333333-3333-4333-8333-333333333333";

  const secretRefBinding = {
    type: "secret_ref",
    secretId: otherSecretId,
    version: "latest",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockAgentService.getById.mockResolvedValue(baseAgent);
    mockAgentService.update.mockResolvedValue(baseAgent);
    mockAgentService.create.mockResolvedValue(baseAgent);
    mockAgentService.getChainOfCommand.mockResolvedValue([]);
    mockAgentService.resolveByReference.mockResolvedValue({ ambiguous: false, agent: baseAgent });
    mockAccessService.getMembership.mockResolvedValue(null);
    mockAccessService.listPrincipalGrants.mockResolvedValue([]);
    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.decide.mockResolvedValue({ allowed: true });
    mockApprovalService.findOpenHireApprovalForAgent.mockResolvedValue(null);
    mockCompanySkillService.listRuntimeSkillEntries.mockResolvedValue([]);
    mockSecretService.normalizeAdapterConfigForPersistence.mockImplementation(async (_companyId, config) => config);
    mockSecretService.resolveAdapterConfigForRuntime.mockImplementation(async (_companyId, config) => ({ config }));
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("refuses an agent self-PATCH of adapterConfig.env carrying a secret_ref", async () => {
    const app = createApp(agentActor);
    const res = await request(app)
      .patch(`/api/agents/${agentId}`)
      .send({ adapterConfig: { env: { GITHUB_MERGE_TOKEN: secretRefBinding } } });

    expect(res.status).toBe(403);
    // Refused, not silently ignored: nothing may reach the service, because the
    // service is what writes the company_secret_bindings row.
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  // The guard is actor-conditional, so the identical request from a board actor
  // must get past it. It cannot reach 200 in this harness: routes/agents.ts
  // imports secretService directly rather than through ../services/index.js, so
  // the real service runs against a db stub that cannot model a company secret
  // and fails downstream with "Secret must belong to same company". That
  // downstream failure is itself the evidence — it is only reachable after the
  // guard has allowed the request through. The board path actually creating a
  // binding row is covered DB-backed in agents-service-secret-bindings.test.ts.
  it("does not apply the guard to a board actor making the same request", async () => {
    const app = createApp(boardActor);
    const res = await request(app)
      .patch(`/api/agents/${agentId}`)
      .send({ adapterConfig: { env: { GITHUB_MERGE_TOKEN: secretRefBinding } } });

    // 422 specifically: the downstream company check, not a 403 from the guard
    // and not a 500. `not.toBe(403)` alone would also pass on a crash.
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).not.toContain("cannot create, modify, or remove secret bindings");
  });

  it("refuses an agent self-PATCH carrying a user_secret_ref", async () => {
    const app = createApp(agentActor);
    const res = await request(app)
      .patch(`/api/agents/${agentId}`)
      .send({ adapterConfig: { env: { GITHUB_TOKEN: { type: "user_secret_ref", key: "github_token" } } } });

    expect(res.status).toBe(403);
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  it("refuses an agent plain schema-secret value after mediated normalization", async () => {
    mockAgentService.getById.mockResolvedValue({ ...baseAgent, adapterType: "hermes_gateway" });
    mockSecretService.normalizeAdapterConfigForPersistence.mockImplementation(async (_companyId, config) => ({
      ...config,
      apiKey: secretRefBinding,
    }));

    const app = createApp(agentActor);
    const res = await request(app)
      .patch(`/api/agents/${agentId}`)
      .send({ adapterConfig: { apiKey: "plain-api-key" } });

    expect(res.status).toBe(403);
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  it("passes the agent actor when normalizing a model-profile schema secret", async () => {
    mockAgentService.getById.mockResolvedValue({ ...baseAgent, adapterType: "hermes_gateway" });
    mockSecretService.normalizeAdapterConfigForPersistence.mockImplementation(
      async (_companyId, config, options) => {
        if (options?.actor?.agentId === agentId) {
          const error = new Error("agent-authored schema secret refused");
          (error as Error & { status?: number }).status = 403;
          throw error;
        }
        return config;
      },
    );

    const app = createApp(agentActor);
    const res = await request(app)
      .patch(`/api/agents/${agentId}`)
      .send({
        runtimeConfig: {
          modelProfiles: {
            cheap: { adapterConfig: { apiKey: "plain-api-key" } },
          },
        },
      });

    expect(res.status).toBe(403);
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  it("refuses a secret_ref smuggled in outside env", async () => {
    const app = createApp(agentActor);
    const res = await request(app)
      .patch(`/api/agents/${agentId}`)
      .send({ adapterConfig: { apiKey: secretRefBinding } });

    expect(res.status).toBe(403);
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  // The guard must not break the honest path. A GET masks the top-level `env`
  // map to the sentinel, which `stripRedactedEnvBindingsFromAdapterConfig`
  // restores from stored state.
  it("allows an agent self-PATCH that round-trips the redacted sentinel", async () => {
    const app = createApp(agentActor);
    const res = await request(app)
      .patch(`/api/agents/${agentId}`)
      .send({ adapterConfig: { env: { OPENAI_API_KEY: "***" }, cwd: "/workspace" } });

    expect(res.status).toBe(200);
    expect(mockAgentService.update).toHaveBeenCalled();
  });

  // The sentinel is not the only shape an honest round-trip sends back. A
  // `secret_ref` outside the top-level `env` map is NOT masked — redaction
  // keeps pointers readable by design — so the agent echoes the literal
  // binding. Refusing that 403s a caller who changed nothing about it, and
  // leaves dropping the key as the only way to get a 200, which is itself an
  // unauthorized deletion. So the guard diffs rather than pattern-matches.
  it("allows an agent self-PATCH that echoes an unchanged non-env secret_ref", async () => {
    const boundAgent = {
      ...baseAgent,
      adapterConfig: { ...baseAgent.adapterConfig, apiKey: secretRefBinding },
    };
    mockAgentService.getById.mockResolvedValue(boundAgent);
    mockAgentService.update.mockResolvedValue(boundAgent);

    const app = createApp(agentActor);
    const res = await request(app)
      .patch(`/api/agents/${agentId}`)
      .send({ adapterConfig: { apiKey: secretRefBinding, cwd: "/workspace2" } });

    expect(res.status).toBe(200);
    expect(mockAgentService.update).toHaveBeenCalled();
  });

  it("allows an agent self-PATCH that echoes an unchanged env secret_ref", async () => {
    // redactAgentConfiguration does not flatten `env`, so this shape is
    // reachable from a real read too, not only from a hand-written body.
    //
    // Asserted the same way as the board-actor control above, and for the same
    // harness reason: an `env` secret_ref reaches the real secretService, whose
    // company check (`secrets.ts`, "Secret must belong to same company") cannot
    // pass against a db stub. 422 is therefore the evidence — it is only
    // reachable once the route guard has allowed the request through. The
    // non-env case above touches no env binding and so reaches 200.
    const boundAgent = {
      ...baseAgent,
      adapterConfig: { cwd: "/workspace", env: { GITHUB_MERGE_TOKEN: secretRefBinding } },
    };
    mockAgentService.getById.mockResolvedValue(boundAgent);
    mockAgentService.update.mockResolvedValue(boundAgent);

    const app = createApp(agentActor);
    const res = await request(app)
      .patch(`/api/agents/${agentId}`)
      .send({ adapterConfig: { cwd: "/workspace3", env: { GITHUB_MERGE_TOKEN: secretRefBinding } } });

    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).not.toContain("cannot create, modify, or remove secret bindings");
  });

  // Modifying an existing binding to point somewhere else is a mutation even
  // though the config path is unchanged.
  it("refuses an agent self-PATCH that repoints an existing binding at another secret", async () => {
    const boundAgent = {
      ...baseAgent,
      adapterConfig: { cwd: "/workspace", env: { GITHUB_MERGE_TOKEN: secretRefBinding } },
    };
    mockAgentService.getById.mockResolvedValue(boundAgent);

    const app = createApp(agentActor);
    const res = await request(app)
      .patch(`/api/agents/${agentId}`)
      .send({
        adapterConfig: {
          env: {
            GITHUB_MERGE_TOKEN: { ...secretRefBinding, secretId: "55555555-5555-4555-8555-555555555555" },
          },
        },
      });

    expect(res.status).toBe(403);
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  // `syncSecretRefsForTarget` runs `replaceAll: true`, so an env key the request
  // omits has its binding row deleted. A guard that only inspects what the
  // request carries cannot see that.
  it("refuses an agent self-PATCH that drops an existing env binding", async () => {
    const boundAgent = {
      ...baseAgent,
      adapterConfig: { cwd: "/workspace", env: { GITHUB_MERGE_TOKEN: secretRefBinding } },
    };
    mockAgentService.getById.mockResolvedValue(boundAgent);

    const app = createApp(agentActor);
    const res = await request(app)
      .patch(`/api/agents/${agentId}`)
      .send({ adapterConfig: { env: { PAPERCLIP_API_URL: "http://localhost:3100" } } });

    expect(res.status).toBe(403);
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  it("refuses an agent self-PATCH that drops a non-env binding via replaceAdapterConfig", async () => {
    const boundAgent = {
      ...baseAgent,
      adapterConfig: { cwd: "/workspace", apiKey: secretRefBinding },
    };
    mockAgentService.getById.mockResolvedValue(boundAgent);

    const app = createApp(agentActor);
    const res = await request(app)
      .patch(`/api/agents/${agentId}`)
      .send({ replaceAdapterConfig: true, adapterConfig: { cwd: "/workspace" } });

    expect(res.status).toBe(403);
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  // A shallow merge preserves a key the request omits, so the same omission
  // without `replaceAdapterConfig` removes nothing and must be allowed.
  it("allows an agent self-PATCH that merely omits a non-env binding without replace", async () => {
    const boundAgent = {
      ...baseAgent,
      adapterConfig: { cwd: "/workspace", apiKey: secretRefBinding },
    };
    mockAgentService.getById.mockResolvedValue(boundAgent);
    mockAgentService.update.mockResolvedValue(boundAgent);

    const app = createApp(agentActor);
    const res = await request(app)
      .patch(`/api/agents/${agentId}`)
      .send({ adapterConfig: { cwd: "/workspace4" } });

    expect(res.status).toBe(200);
    expect(mockAgentService.update).toHaveBeenCalled();
  });

  // Same missing check, reached without a self-PATCH: an agent holding
  // canCreateAgents can bind a secret into an agent it creates.
  it("refuses an agent-authored create that carries a secret_ref", async () => {
    const app = createApp(agentActor);
    const res = await request(app)
      .post(`/api/companies/${companyId}/agents`)
      .send({
        name: "Exfil",
        role: "engineer",
        adapterType: "claude_local",
        adapterConfig: { env: { GITHUB_MERGE_TOKEN: secretRefBinding } },
      });

    expect(res.status).toBe(403);
    expect(mockAgentService.create).not.toHaveBeenCalled();
  });
});
