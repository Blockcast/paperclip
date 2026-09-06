import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PEN-2777 — `hire_agent` approval cards embed the hire's `adapterConfig`.
 * `redactAgentConfigPayload` masks the credential *values* inside it but
 * deliberately keeps the config diagnosable, so `mcpServers.*.url` keeps its
 * scheme, principal, host, port and path. That residue is the agent's MCP
 * upstream topology, and `GET /agents/:id` withholds it from a caller lacking
 * `agent_config:read`. These approval read paths reached the same material
 * under `company_scope:read`, which every same-company agent is auto-allowed.
 */

const mockApprovalService = vi.hoisted(() => ({
  list: vi.fn(),
  countBy: vi.fn(),
  listSummary: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  approve: vi.fn(),
  reject: vi.fn(),
  requestRevision: vi.fn(),
  resubmit: vi.fn(),
  withdraw: vi.fn(),
  listComments: vi.fn(),
  addComment: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({ wakeup: vi.fn() }));
const mockIssueApprovalService = vi.hoisted(() => ({
  listIssuesForApproval: vi.fn(),
  linkManyForApproval: vi.fn(),
}));
const mockSecretService = vi.hoisted(() => ({
  normalizeHireApprovalPayloadForPersistence: vi.fn(),
}));
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockAccessService = vi.hoisted(() => ({ decide: vi.fn() }));
const mockResolveApprovalWithSideEffects = vi.hoisted(() => vi.fn());

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    approvalService: () => mockApprovalService,
    heartbeatService: () => mockHeartbeatService,
    issueApprovalService: () => mockIssueApprovalService,
    logActivity: mockLogActivity,
    secretService: () => mockSecretService,
  }));
  vi.doMock("../services/approval-resolution.js", () => ({
    resolveApprovalWithSideEffects: mockResolveApprovalWithSideEffects,
  }));
}

/** Minimal db stub: the routes only read heartbeat_runs for the cheap-recovery guard. */
function createRouteDb() {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          then: async (resolve: (rows: unknown[]) => unknown) => resolve([]),
        })),
      })),
    })),
  } as any;
}

async function createAppWithActor(actor: Record<string, unknown>) {
  const [{ errorHandler }, { approvalRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/approvals.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", approvalRoutes(createRouteDb()));
  app.use(errorHandler);
  return app;
}

const COMPANY_ID = "company-1";
const ADMIN_UPSTREAM = "https://svc-account@k8s-mcp-admin.internal:8443/mcp";

const peerAgentActor = {
  type: "agent",
  agentId: "agent-peer",
  companyId: COMPANY_ID,
  runId: "run-1",
  source: "api_key",
  isInstanceAdmin: false,
};

const boardActor = {
  type: "board",
  userId: "user-1",
  companyIds: [COMPANY_ID],
  source: "session",
  isInstanceAdmin: false,
};

function hireApproval(overrides: Record<string, unknown> = {}) {
  const adapterConfig = {
    image: "harbor.example.net/agent:sha-1234",
    env: { TOKEN: { type: "plain", value: "super-secret" } },
    mcpServers: {
      k8s: { url: ADMIN_UPSTREAM, headers: { Authorization: "Bearer live-token" } },
    },
  };
  return {
    id: "approval-1",
    companyId: COMPANY_ID,
    type: "hire_agent",
    status: "pending",
    requestedByAgentId: "agent-hirer",
    requestedByUserId: null,
    decisionNote: null,
    decidedByUserId: null,
    decidedAt: null,
    createdAt: new Date("2026-08-31T00:00:00.000Z"),
    updatedAt: new Date("2026-08-31T00:00:00.000Z"),
    payload: {
      name: "New Worker",
      role: "engineer",
      adapterType: "claude_k8s",
      adapterConfig,
      runtimeConfig: { heartbeat: { enabled: true } },
      requestedConfigurationSnapshot: {
        adapterType: "claude_k8s",
        adapterConfig,
        runtimeConfig: { heartbeat: { enabled: true } },
      },
    },
    ...overrides,
  };
}

/**
 * `company_scope:read` is auto-allowed to every same-company agent; only the
 * `agent_config:read` verdict varies between these actors.
 */
function decideWithAgentConfigRead(allowed: boolean) {
  mockAccessService.decide.mockImplementation(async (input: { action: string }) => ({
    allowed: input.action === "agent_config:read" ? allowed : true,
    action: input.action,
    reason: allowed ? "allow_test" : "deny_missing_grant",
    explanation: "Decided by test mock.",
  }));
}

/** Every place the raw upstream could surface, flattened. */
function serializedBody(body: unknown) {
  return JSON.stringify(body);
}

describe("hire_agent approval reads withhold agent config without agent_config:read (PEN-2777)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../services/approval-resolution.js");
    vi.doUnmock("../routes/approvals.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("hides the MCP upstream topology from GET /approvals/:id for an agent without agent_config:read", async () => {
    decideWithAgentConfigRead(false);
    mockApprovalService.getById.mockResolvedValue(hireApproval());

    const res = await request(await createAppWithActor(peerAgentActor)).get("/api/approvals/approval-1");

    expect(res.status).toBe(200);
    expect(serializedBody(res.body)).not.toContain("k8s-mcp-admin.internal");
    expect(res.body.payload.adapterConfig).toEqual({});
    expect(res.body.payload.runtimeConfig).toEqual({});
    expect(res.body.payload.requestedConfigurationSnapshot.adapterConfig).toEqual({});
    expect(res.body.payload.requestedConfigurationSnapshot.runtimeConfig).toEqual({});
    // The card itself stays readable — the queue is not what is being gated.
    expect(res.body.payload.name).toBe("New Worker");
    expect(res.body.payload.requestedConfigurationSnapshot.adapterType).toBe("claude_k8s");
    expect(res.body.status).toBe("pending");
    expect(res.body.withheldFields).toEqual([
      "adapterConfig",
      "runtimeConfig",
      "requestedConfigurationSnapshot.adapterConfig",
      "requestedConfigurationSnapshot.runtimeConfig",
    ]);
  }, 15000);

  it("hides the MCP upstream topology from the company approvals list for the same agent", async () => {
    decideWithAgentConfigRead(false);
    mockApprovalService.list.mockResolvedValue([hireApproval()]);

    const res = await request(await createAppWithActor(peerAgentActor))
      .get(`/api/companies/${COMPANY_ID}/approvals`);

    expect(res.status).toBe(200);
    expect(serializedBody(res.body)).not.toContain("k8s-mcp-admin.internal");
    expect(res.body).toHaveLength(1);
    expect(res.body[0].payload.adapterConfig).toEqual({});
    expect(res.body[0].payload.requestedConfigurationSnapshot.adapterConfig).toEqual({});
  }, 15000);

  it("hides the topology when the config arrives in a non-object shape", async () => {
    // Cards filed through `POST /companies/:companyId/approvals` carry whatever
    // the filer sent: `approvalPayloadSchema` is a `.catchall(z.unknown())` and
    // `normalizeHireApprovalPayloadForPersistence` only normalizes a record, so
    // these keys can hold an array or a JSON string in a persisted hire payload.
    // Both carry the upstream, so entitlement must not depend on the shape.
    decideWithAgentConfigRead(false);
    mockApprovalService.getById.mockResolvedValue(
      hireApproval({
        payload: {
          name: "New Worker",
          adapterType: "claude_k8s",
          adapterConfig: [{ mcpServers: { k8s: { url: ADMIN_UPSTREAM } } }],
          runtimeConfig: JSON.stringify({ mcpServers: { k8s: { url: ADMIN_UPSTREAM } } }),
        },
      }),
    );

    const res = await request(await createAppWithActor(peerAgentActor)).get("/api/approvals/approval-1");

    expect(res.status).toBe(200);
    expect(serializedBody(res.body)).not.toContain("k8s-mcp-admin.internal");
    expect(res.body.payload.adapterConfig).toEqual({});
    expect(res.body.payload.runtimeConfig).toEqual({});
    expect(res.body.payload.name).toBe("New Worker");
    expect(res.body.withheldFields).toEqual(["adapterConfig", "runtimeConfig"]);
  }, 15000);

  it("still shows the config to an agent that does hold agent_config:read", async () => {
    decideWithAgentConfigRead(true);
    mockApprovalService.getById.mockResolvedValue(hireApproval());

    const res = await request(await createAppWithActor(peerAgentActor)).get("/api/approvals/approval-1");

    expect(res.status).toBe(200);
    expect(res.body.payload.adapterConfig.mcpServers.k8s.url).toContain("k8s-mcp-admin.internal");
    expect(res.body.withheldFields).toEqual([]);
    // The pre-existing credential redaction is unaffected by the new gate.
    expect(res.body.payload.adapterConfig.env.TOKEN).toEqual({ type: "plain", value: "***REDACTED***" });
  }, 15000);

  it("keeps the board approval queue whole: a board reader still gets the config and can decide the card", async () => {
    decideWithAgentConfigRead(false);
    mockApprovalService.list.mockResolvedValue([hireApproval()]);
    mockApprovalService.getById.mockResolvedValue(hireApproval());

    const app = await createAppWithActor(boardActor);

    const list = await request(app).get(`/api/companies/${COMPANY_ID}/approvals`);
    expect(list.status).toBe(200);
    expect(list.body[0].payload.adapterConfig.mcpServers.k8s.url).toContain("k8s-mcp-admin.internal");
    expect(list.body[0].withheldFields).toEqual([]);

    const detail = await request(app).get("/api/approvals/approval-1");
    expect(detail.status).toBe(200);
    expect(detail.body.payload.adapterConfig.mcpServers.k8s.url).toContain("k8s-mcp-admin.internal");

    // A board decision on the same card still round-trips the full payload.
    const decided = hireApproval({ status: "approved", decidedByUserId: "user-1" });
    mockResolveApprovalWithSideEffects.mockResolvedValue({ approval: decided, applied: true });
    const approved = await request(app)
      .post("/api/approvals/approval-1/approve")
      .send({ decisionNote: "looks right" });
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe("approved");
    expect(approved.body.payload.adapterConfig.mcpServers.k8s.url).toContain("k8s-mcp-admin.internal");
  }, 15000);

  it("leaves non-hire approval payloads untouched", async () => {
    decideWithAgentConfigRead(false);
    mockApprovalService.getById.mockResolvedValue(
      hireApproval({
        type: "request_board_approval",
        payload: { title: "Ship it", adapterConfig: { note: "not a hire card" } },
      }),
    );

    const res = await request(await createAppWithActor(peerAgentActor)).get("/api/approvals/approval-1");

    expect(res.status).toBe(200);
    expect(res.body.payload).toEqual({ title: "Ship it", adapterConfig: { note: "not a hire card" } });
    expect(res.body.withheldFields).toEqual([]);
  }, 15000);
});
