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
      // PEN-2747: the three shapes that carried a credential straight past the
      // key-name denylist. They live on the SHARED fixture on purpose, so every
      // `expectNoPlaintextSecrets` case below sweeps them rather than only the
      // one route someone remembered to write a bespoke test for — the original
      // `gbrain` entry is credential-free, which is exactly why a test asserting
      // its `url` unmasked read as correct for so long.
      k8s_admin: {
        type: "http",
        url: "https://svcacct:k8s_userinfo_secret_24680@k8s-mcp-admin.internal:3130/mcp",
      },
      k8s_query: {
        type: "http",
        url: "https://k8s-mcp.internal/mcp?token=k8s_query_secret_13579",
        headers: { "X-Tenant-Signature": "tenant_sig_secret_97531" },
      },
      stdio_local: {
        command: "npx",
        args: ["-y", "some-mcp-server", "--api-key", "stdio_args_secret_86420"],
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

function createDbStub(requireBoardApprovalForNewAgents = false) {
  const rows = [{
    id: companyId,
    name: "Paperclip",
    requireBoardApprovalForNewAgents,
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

function createApp(actor: Record<string, unknown>, requireBoardApprovalForNewAgents = false) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", agentRoutes(createDbStub(requireBoardApprovalForNewAgents) as any));
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
      // Credential-free, so it must round-trip byte-identical: the fix masks
      // the credential component of a URL, never the whole URL. Knowing which
      // upstream an agent is pointed at is the diagnostic value this read path
      // exists for.
      url: "http://gbrain-mcp-admin.paperclip.svc.cluster.local:3130/mcp",
      headers: {
        Authorization: "***REDACTED***",
        // PEN-2747: headers are now masked allowlist-style, the way the
        // variable map already was. `Authorization` had been masked only
        // incidentally (the "auth" Tier-1 stem), so every differently-spelled
        // credential header went out in the clear. A denylist over header
        // names has no bounded vocabulary to enumerate, so anything outside a
        // short content-negotiation exemption list masks -- including this
        // benign routing header. Over-masking a response is recoverable;
        // `restoreRedactedAdapterValue` puts the stored value back if a caller
        // PATCHes the redacted config in.
        "x-safe-routing-header": "***REDACTED***",
      },
    });
  });

  // PEN-2747. Each case below is a route around the key-name denylist that
  // `redactAgentConfigPayload` used to fail open on. `adapterConfig.mcpServers`
  // is where an agent's k8s MCP upstream is swapped for a privileged `ns-rw` or
  // `admin` tier, so a credential surfacing here is a privilege-escalation
  // shape, not a hygiene one.
  it("GET /agents/me masks the credential in a userinfo URL but keeps the upstream readable", async () => {
    const app = createApp(agentActor);
    const res = await request(app).get("/api/agents/me");

    expect(res.status).toBe(200);
    expect(res.body.adapterConfig.mcpServers.k8s_admin.url).toBe(
      "https://svcacct:***REDACTED***@k8s-mcp-admin.internal:3130/mcp",
    );
  });

  it("GET /agents/me masks a query-borne credential but keeps the upstream readable", async () => {
    const app = createApp(agentActor);
    const res = await request(app).get("/api/agents/me");

    expect(res.status).toBe(200);
    expect(res.body.adapterConfig.mcpServers.k8s_query.url).toBe(
      "https://k8s-mcp.internal/mcp?token=***REDACTED***",
    );
  });

  it("GET /agents/me masks a credential header that is not spelled Authorization", async () => {
    const app = createApp(agentActor);
    const res = await request(app).get("/api/agents/me");

    expect(res.status).toBe(200);
    expect(res.body.adapterConfig.mcpServers.k8s_query.headers).toEqual({
      "X-Tenant-Signature": "***REDACTED***",
    });
  });

  it("GET /agents/me masks a secret passed through mcpServers args", async () => {
    const app = createApp(agentActor);
    const res = await request(app).get("/api/agents/me");

    expect(res.status).toBe(200);
    // The flag name survives so the config stays diagnosable; only the value
    // it introduces is masked.
    expect(res.body.adapterConfig.mcpServers.stdio_local.args).toEqual([
      "-y",
      "some-mcp-server",
      "--api-key",
      "***REDACTED***",
    ]);
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
    // PEN-2747. Every one of these is credential material that a key-name
    // denylist waves through: userinfo and query components of a URL, a
    // credential header that is not spelled `Authorization`, and a secret
    // passed as an `args` element (the spelling real MCP stdio configs use --
    // `argv` and `commandArgs` were masked, `args` was not).
    "k8s_userinfo_secret_24680",
    "k8s_query_secret_13579",
    "tenant_sig_secret_97531",
    "stdio_args_secret_86420",
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
    // `clearAllMocks` clears calls but KEEPS implementations, so a fixture set
    // inside a helper outlives the test that needed it. `hire()` is the only
    // setter of these two in this block, and `mockApprovalService.create` has
    // no other setter in the file — so reset them rather than seeding a value:
    // a test added later that reaches a create path should fail loudly on an
    // unset mock instead of silently inheriting a hire-shaped row.
    mockAgentService.create.mockReset();
    mockApprovalService.create.mockReset();
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

  // `redactRevisionSnapshot` spread the stored snapshot and then overrode three
  // named fields — `adapterConfig`, `runtimeConfig`, `metadata`. That list is
  // complete for `buildConfigSnapshot`'s current shape, so the surface does not
  // leak today; it leaks the moment a config-bearing field is added to the
  // snapshot and this list is not extended in the same commit. Doors #12 and
  // #13 on PEN-2370 were both exactly that drift (`workspaceRuntime` added to a
  // projection whose withholding list nobody revisited), so the class is pinned
  // here rather than the three spellings.
  //
  // The revisions are also the one config surface stored *pre-redaction* by a
  // name-based sanitizer, which is why an ordinary-keyed value reaches the row.
  const SNAPSHOT_DRIFT_SECRET = "revision-snapshot-secret-under-an-ordinary-key";
  const revisionId = "33333333-3333-4333-8333-333333333333";

  function snapshotWithUnnamedConfigField() {
    return {
      name: "Builder",
      role: "engineer",
      // `title` and `icon` are the two other string-valued fields
      // `buildConfigSnapshot` emits. They are pinned as READABLE below because
      // passing the whole record to `sanitizeRecord` subjects the snapshot's top
      // level to every gate in it — not just `classifyKeyTier` but the
      // `env`/`headers` special cases, `^args$`, and the dotted-value rule — so
      // an over-redaction here would blank the revision diff in the UI.
      // (Boundary, stated so it is not mistaken for a guarantee: a *dotted*
      // three-segment value in one of these fields would be blanked by the
      // dotted-value rule. No caller produces one; this pins the realistic
      // shape, not every possible string.)
      title: "Staff Engineer",
      icon: "wrench",
      adapterType: "claude_local",
      adapterConfig: { env: { FOO: { type: "plain", value: SNAPSHOT_DRIFT_SECRET } } },
      runtimeConfig: {},
      metadata: null,
      // Stands in for any field a future `buildConfigSnapshot` adds. It is not
      // in the override list, so the spread used to carry it out verbatim.
      sidecarConfig: { env: { BAR: { type: "plain", value: SNAPSHOT_DRIFT_SECRET } } },
    };
  }

  function revisionRow() {
    return {
      id: revisionId,
      agentId,
      companyId,
      source: "patch",
      changedKeys: ["adapterConfig"],
      beforeConfig: snapshotWithUnnamedConfigField(),
      afterConfig: snapshotWithUnnamedConfigField(),
    };
  }

  it("GET /agents/:id/config-revisions/:revisionId contains a snapshot field the override list does not name", async () => {
    mockAgentService.getConfigRevision.mockResolvedValue(revisionRow());

    const app = createApp(boardActor);
    const res = await request(app).get(`/api/agents/${agentId}/config-revisions/${revisionId}`);

    // Assert the success path explicitly — a 403/404 would pass every negative
    // assertion below vacuously.
    expect(res.status).toBe(200);
    // The named field still works, so a regression here is not what fails.
    expect(res.body.afterConfig.adapterConfig.env.FOO).toEqual({
      type: "plain",
      value: "***REDACTED***",
    });
    // The unnamed one is the point.
    expect(res.body.afterConfig.sidecarConfig.env.BAR).toEqual({
      type: "plain",
      value: "***REDACTED***",
    });
    expect(res.body.beforeConfig.sidecarConfig.env.BAR).toEqual({
      type: "plain",
      value: "***REDACTED***",
    });
    // Non-credential snapshot fields stay readable — containment must not turn
    // the revision diff into an unreadable wall of sentinels.
    expect(res.body.afterConfig.name).toBe("Builder");
    expect(res.body.afterConfig.role).toBe("engineer");
    expect(res.body.afterConfig.title).toBe("Staff Engineer");
    expect(res.body.afterConfig.icon).toBe("wrench");
    expect(res.body.afterConfig.adapterType).toBe("claude_local");
    // The response-shape contract the three overrides used to guarantee.
    expect(res.body.afterConfig.runtimeConfig).toEqual({});
    expect(res.body.afterConfig.metadata).toBeNull();
    expect(JSON.stringify(res.body)).not.toContain(SNAPSHOT_DRIFT_SECRET);
    expectNoPlaintextSecrets(res.body);
  });

  it("GET /agents/:id/config-revisions contains the same field on the list route", async () => {
    mockAgentService.listConfigRevisions.mockResolvedValue([revisionRow()]);

    const app = createApp(boardActor);
    const res = await request(app).get(`/api/agents/${agentId}/config-revisions`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].afterConfig.sidecarConfig.env.BAR).toEqual({
      type: "plain",
      value: "***REDACTED***",
    });
    expect(JSON.stringify(res.body)).not.toContain(SNAPSHOT_DRIFT_SECRET);
    expectNoPlaintextSecrets(res.body);
  });

  // The old `metadata` branch gated on `typeof x === "object" && x !== null`,
  // which is TRUE for an array, and the redactor returns a non-plain-object
  // argument unchanged — so an array-valued `metadata` went out verbatim. This
  // is the third instance of that `isPlainObject` hole on PEN-2370.
  //
  // Pinned rather than argued: the containment change closes it because
  // `sanitizeValue` maps arrays element-wise, but nothing in this file exercised
  // an array-shaped `metadata`, so the fix rested on the PR description alone.
  it("masks a plain binding carried in an ARRAY-valued metadata field", async () => {
    const snapshot = {
      ...snapshotWithUnnamedConfigField(),
      metadata: [{ type: "plain", value: SNAPSHOT_DRIFT_SECRET }],
    };
    mockAgentService.getConfigRevision.mockResolvedValue({
      ...revisionRow(),
      beforeConfig: snapshot,
      afterConfig: snapshot,
    });

    const app = createApp(boardActor);
    const res = await request(app).get(`/api/agents/${agentId}/config-revisions/${revisionId}`);

    expect(res.status).toBe(200);
    // The array SHAPE must survive — coercing it to `null` would hide the leak
    // by destroying the field, which is not the same fix and would break the
    // diff view. It must arrive as an array whose elements are masked.
    expect(Array.isArray(res.body.afterConfig.metadata)).toBe(true);
    expect(res.body.afterConfig.metadata).toEqual([
      { type: "plain", value: "***REDACTED***" },
    ]);
    expect(res.body.beforeConfig.metadata).toEqual([
      { type: "plain", value: "***REDACTED***" },
    ]);
    expect(JSON.stringify(res.body)).not.toContain(SNAPSHOT_DRIFT_SECRET);
    expectNoPlaintextSecrets(res.body);
  });

  // The admit gate and the sanitize gate must be the same predicate. The
  // redactor sanitizes only `isPlainObject` values and otherwise returns its
  // argument BY REFERENCE, so admitting on a wider "is it an object" test made
  // the containment a no-op for a foreign-prototype snapshot: the spread would
  // emit the raw record and the sub-field lines would only reshape it.
  //
  // Not reachable from today's callers — `jsonb` columns arrive via `JSON.parse`
  // and always carry `Object.prototype`. Pinned because an unstated assumption
  // about the shape a containment function is handed is the defect class this
  // whole projection exists to close, and because failing OPEN is the wrong
  // direction for the one mask standing over at-rest plaintext.
  it("contains a snapshot whose prototype is not Object.prototype", async () => {
    const foreignPrototype = Object.assign(
      Object.create({ inherited: true }),
      snapshotWithUnnamedConfigField(),
    );
    mockAgentService.getConfigRevision.mockResolvedValue({
      ...revisionRow(),
      beforeConfig: foreignPrototype,
      afterConfig: foreignPrototype,
    });

    const app = createApp(boardActor);
    const res = await request(app).get(`/api/agents/${agentId}/config-revisions/${revisionId}`);

    expect(res.status).toBe(200);
    // Fails closed: an un-sanitizable shape is withheld entirely rather than
    // spread out uncontained.
    expect(res.body.afterConfig).toEqual({});
    expect(res.body.beforeConfig).toEqual({});
    expect(JSON.stringify(res.body)).not.toContain(SNAPSHOT_DRIFT_SECRET);
    expectNoPlaintextSecrets(res.body);
  });

  // Same hole, one level down and one key over. `metadata` matches no tier and
  // no special case in `sanitizeRecord`, so it goes to `sanitizeValue`, which
  // returns a non-plain non-array object BY REFERENCE — `contained.metadata`
  // was the caller's object, unsanitized, and `?? null` emitted it verbatim.
  // `adapterConfig` and `runtimeConfig` beside it already failed closed on this
  // exact shape; `metadata` failed open.
  //
  // Asserted as a pair, because the two halves can regress independently: the
  // array case must SURVIVE as a masked array (above) and the foreign-prototype
  // case must be WITHHELD. A fix that collapses either into the other passes one
  // assertion and fails the other.
  it("contains a metadata field whose prototype is not Object.prototype", async () => {
    const foreignMetadata = Object.assign(Object.create({ inherited: true }), {
      leaked: { type: "plain", value: SNAPSHOT_DRIFT_SECRET },
    });
    const snapshot = { ...snapshotWithUnnamedConfigField(), metadata: foreignMetadata };
    mockAgentService.getConfigRevision.mockResolvedValue({
      ...revisionRow(),
      beforeConfig: snapshot,
      afterConfig: snapshot,
    });

    const app = createApp(boardActor);
    const res = await request(app).get(`/api/agents/${agentId}/config-revisions/${revisionId}`);

    expect(res.status).toBe(200);
    expect(res.body.afterConfig.metadata).toBeNull();
    expect(res.body.beforeConfig.metadata).toBeNull();
    // The rest of the snapshot is a plain object, so it must still project —
    // this is containment of the one un-sanitizable field, not of the response.
    expect(res.body.afterConfig.name).toBe("Builder");
    expect(JSON.stringify(res.body)).not.toContain(SNAPSHOT_DRIFT_SECRET);
    expectNoPlaintextSecrets(res.body);
  });

  // `redactAgentSecrets` is the primary agent serializer — its own doc comment
  // says every agent-serializing response must go through it — and it gated on
  // `asRecord`, which admits a foreign-prototype object the redactor then hands
  // straight back by reference.
  //
  // Note what does NOT fix this: swapping the gate to `isPlainObject`. The
  // assignment is inside the `if`, so a failing gate leaves the RAW value on the
  // `{ ...agent }` spread — same value on the wire, by a different route. The
  // contained value has to be written back, which is why the fix is a helper
  // rather than a one-word predicate change.
  it("PATCH /agents/:id contains an adapterConfig whose prototype is not Object.prototype", async () => {
    const foreignConfig = Object.assign(Object.create({ inherited: true }), {
      // The top-level `env` is masked by its own loop over `asRecord(config.env)`
      // regardless of the parent's prototype, so it would hide the leak. The
      // secret has to sit OUTSIDE `env` to exercise the by-reference return:
      // `redactedConfig` is the raw object, and the spread carries this out.
      env: { FOO: { type: "plain", value: "unrelated" } },
      sidecarConfig: { env: { BAZ: { type: "plain", value: SNAPSHOT_DRIFT_SECRET } } },
    });
    const foreignAgent = { ...baseAgent, adapterConfig: foreignConfig };
    mockAgentService.getById.mockResolvedValue(foreignAgent);
    mockAgentService.update.mockResolvedValue(foreignAgent);

    const app = createApp(boardActor);
    const res = await request(app).patch(`/api/agents/${agentId}`).send({ spentMonthlyCents: 1 });

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(SNAPSHOT_DRIFT_SECRET);
    expect(res.body.adapterConfig).toEqual({});
    expectNoPlaintextSecrets(res.body);
  });

  it("PATCH /agents/:id contains a runtimeConfig whose prototype is not Object.prototype", async () => {
    const foreignRuntime = Object.assign(Object.create({ inherited: true }), {
      modelProfiles: { main: { adapterConfig: { env: { BAR: SNAPSHOT_DRIFT_SECRET } } } },
    });
    const foreignAgent = { ...baseAgent, runtimeConfig: foreignRuntime };
    mockAgentService.getById.mockResolvedValue(foreignAgent);
    mockAgentService.update.mockResolvedValue(foreignAgent);

    const app = createApp(boardActor);
    const res = await request(app).patch(`/api/agents/${agentId}`).send({ spentMonthlyCents: 1 });

    expect(res.status).toBe(200);
    expect(res.body.runtimeConfig).toEqual({});
    expect(JSON.stringify(res.body)).not.toContain(SNAPSHOT_DRIFT_SECRET);
    // Only `runtimeConfig` is replaced here, so `adapterConfig` is still the
    // shared fixture's — every PEN-2747 shape rides this response and the sweep
    // is what pins them.
    expectNoPlaintextSecrets(res.body);
  });

  // `redactAgentConfiguration` passes the value in with no plain-object gate at
  // all, so the redactor's own by-reference return was the only thing between a
  // foreign-prototype config and the wire. Both of its config fields, because
  // they are two separate call sites that can regress independently.
  it("GET /agents/:id/configuration contains configs whose prototype is not Object.prototype", async () => {
    const foreignAgent = {
      ...baseAgent,
      adapterConfig: Object.assign(Object.create({ inherited: true }), {
        env: { FOO: { type: "plain", value: SNAPSHOT_DRIFT_SECRET } },
      }),
      runtimeConfig: Object.assign(Object.create({ inherited: true }), {
        env: { BAR: { type: "plain", value: SNAPSHOT_DRIFT_SECRET } },
      }),
    };
    mockAgentService.getById.mockResolvedValue(foreignAgent);

    const app = createApp(boardActor);
    const res = await request(app).get(`/api/agents/${agentId}/configuration`);

    expect(res.status).toBe(200);
    expect(res.body.adapterConfig).toEqual({});
    expect(res.body.runtimeConfig).toEqual({});
    // The enumerated readable fields still project — containment is scoped to
    // the two config fields, not to the whole response.
    expect(res.body.name).toBe("Builder");
    expect(JSON.stringify(res.body)).not.toContain(SNAPSHOT_DRIFT_SECRET);
    expectNoPlaintextSecrets(res.body);
  });

  // The fifth converted site, and the last one this suite did not reach. The
  // hire approval payload is the one place the *stored* value is deliberately
  // left credential-bearing — `activatePendingApproval` replays it verbatim
  // over the agent row, so redacting it on the way in would write masks back
  // over live credentials. Containment on the way out is therefore the only
  // control here, not a second layer behind one.
  //
  // Both cases drive the real route rather than calling the helper: the value
  // being contained is whatever `approvalsSvc.create` RESOLVES, so a test that
  // asserted on the object literal the route builds would pass while the
  // returned row went out uncontained.
  async function hire(payload: unknown) {
    // `instructionsRootPath` takes the early return in
    // `materializeDefaultInstructionsBundleForNewAgent`, so the hire lands
    // without dragging bundle materialization (and its disk reads) into a test
    // about response containment.
    mockAgentService.create.mockResolvedValue({
      ...baseAgent,
      adapterConfig: { ...baseAgent.adapterConfig, instructionsRootPath: "/workspace/instructions" },
    });
    mockApprovalService.create.mockResolvedValue({
      id: "44444444-4444-4444-8444-444444444444",
      type: "hire_agent",
      status: "pending",
      payload,
    });

    return request(createApp(boardActor, true))
      .post(`/api/companies/${companyId}/agent-hires`)
      .send({ name: "Hire", role: "engineer", adapterType: "claude_local" });
  }

  it("POST /companies/:companyId/agent-hires contains an approval payload whose prototype is not Object.prototype", async () => {
    // `asRecord` admits any non-array object, so the old expression handed a
    // foreign-prototype payload to a redactor that returns it BY REFERENCE.
    // The secret sits outside `env` for the reason given at the adapterConfig
    // case above: the top-level `env` loop would mask it either way and hide
    // the by-reference return that is actually under test.
    const res = await hire(
      Object.assign(Object.create({ inherited: true }), {
        adapterConfig: { sidecarConfig: { env: { BAZ: { type: "plain", value: SNAPSHOT_DRIFT_SECRET } } } },
      }),
    );

    expect(res.status).toBe(201);
    // Plaintext first, deliberately: the shape assertion below also fails on
    // the pre-fix expression, so leading with it would let this test report a
    // changed shape when what it exists to catch is a credential on the wire.
    expect(JSON.stringify(res.body)).not.toContain(SNAPSHOT_DRIFT_SECRET);
    expect(res.body.approval.payload).toEqual({});
    // The rest of the approval row still projects — containment is scoped to
    // `payload`, not to the whole response.
    expect(res.body.approval.type).toBe("hire_agent");
    // `SNAPSHOT_DRIFT_SECRET` lives only in the payload this test builds, so the
    // assertion above says nothing about the OTHER half of this response.
    // `POST /agent-hires` returns `{ agent: redactAgentSecrets(agent), approval }`
    // and `hire()` resolves a `baseAgent`-derived row, so an edit that serialized
    // `agent` directly would leave every PEN-2747 shape on the wire with all
    // three hire tests still green. The shared-fixture sweep is what catches it.
    expectNoPlaintextSecrets(res.body);
  });

  // Not a leak on either side of the change, and pinned for exactly that
  // reason: it is the one converted line whose output shape moved for a
  // plausible input, so leaving it unasserted means the next reader cannot
  // tell the delta was intended. `asRecord` rejects arrays and mapped this to
  // `null`; `containAgentConfig` withholds it as `{}`.
  it("POST /companies/:companyId/agent-hires withholds an ARRAY-valued approval payload as {}, not null", async () => {
    const res = await hire([{ type: "plain", value: SNAPSHOT_DRIFT_SECRET }]);

    expect(res.status).toBe(201);
    expect(res.body.approval.payload).toEqual({});
    expect(JSON.stringify(res.body)).not.toContain(SNAPSHOT_DRIFT_SECRET);
    expectNoPlaintextSecrets(res.body);
  });

  // The masking arm — the one every REAL hire takes, since a hire payload is an
  // ordinary plain object. The two cases above both land on the withholding arm
  // (`{}`), so without this the production path at agents.ts:3177 is unpinned.
  //
  // ⚠️ This is a characterization test, NOT a fail-first leak guard: the pre-fix
  // expression `redactAgentConfigPayload(asRecord(payload) ?? null)` masks a
  // plain object identically, so it passes on both sides of the change. Its job
  // is to hold the arm still — a future edit to `containAgentConfig` that turned
  // masking into withholding would satisfy every other test in this block while
  // silently blanking the payload the board reads to approve a hire. Proven able
  // to fail by mutating that branch to `return {}`.
  //
  // Both keys carry the secret on purpose: the payload embeds the requested
  // adapterConfig twice, the second time under `requestedConfigurationSnapshot`,
  // so masking only the first would leave the same credential one key over
  // (BLO-18969) — which is the concern the route comment at :3171 states.
  it("POST /companies/:companyId/agent-hires MASKS a plain approval payload and still projects it", async () => {
    const binding = { type: "plain", value: SNAPSHOT_DRIFT_SECRET };
    const res = await hire({
      adapterConfig: { env: { API_KEY: { ...binding } } },
      requestedConfigurationSnapshot: { adapterConfig: { env: { API_KEY: { ...binding } } } },
    });

    expect(res.status).toBe(201);
    // Plaintext first, for the reason given at the foreign-prototype case above.
    expect(JSON.stringify(res.body)).not.toContain(SNAPSHOT_DRIFT_SECRET);

    // Masked AND projected — this is what distinguishes this arm from the
    // withholding one. An assertion that only checked for absence of the secret
    // would also pass if the whole payload were blanked to `{}`. The mask is
    // spelled literally, per this file's convention: asserting against the
    // exported constant would still pass if the constant itself became "".
    const masked = { type: "plain", value: "***REDACTED***" };
    expect(res.body.approval.payload.adapterConfig.env.API_KEY).toEqual(masked);
    expect(res.body.approval.payload.requestedConfigurationSnapshot.adapterConfig.env.API_KEY).toEqual(masked);
    expectNoPlaintextSecrets(res.body);
  });

  // `secret_ref` bindings are pointers, never plaintext, so they survive the
  // redactor by design — but a resolved `value` riding along on one is a secret
  // that leaked in, and the schema has no field for it.
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
