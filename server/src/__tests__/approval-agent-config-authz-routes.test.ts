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
// `approvalRoutes` builds `issueService(db)` for the approval-link evaluator
// (`assertIssueLinksAllowed`); no case here links an issue, so the stub only
// needs to exist. Same shape as approval-create-issue-link-authorization.test.ts.
const mockIssueService = vi.hoisted(() => ({ getById: vi.fn() }));
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
    issueService: () => mockIssueService,
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
const PROVISION_COMMAND = "FOO_TOKEN=prov_secret_13579 ./provision.sh";
const TEARDOWN_COMMAND = "FOO_TOKEN=tear_secret_24680 ./teardown.sh";
const WORKTREE_PARENT_DIR = "/srv/operator/worktrees";

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
    // PEN-5225: host-executed strings, on the SHARED fixture so every case in this file
    // carries them and a future projection change cannot quietly re-disclose them on a path
    // whose own test did not think to look.
    workspaceStrategy: {
      type: "git_worktree",
      baseRef: "main",
      provisionCommand: PROVISION_COMMAND,
      teardownCommand: TEARDOWN_COMMAND,
      worktreeParentDir: WORKTREE_PARENT_DIR,
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
  decideBy({ "agent_config:read": allowed });
}

/**
 * Resolves each action INDEPENDENTLY, defaulting to allow.
 *
 * PEN-5225: `agent_config:read` and `workspace_runtime:read` are separate verdicts pointing
 * opposite ways for the reader that matters — `agents:configure` clears the first and no agent
 * can hold the second at all. A mock that answers one boolean for every action makes them move
 * together and is structurally unable to observe the disclosure this file now pins.
 */
function decideBy(overrides: Record<string, boolean>) {
  mockAccessService.decide.mockImplementation(async (input: { action: string }) => {
    const allowed = overrides[input.action] ?? true;
    return {
      allowed,
      action: input.action,
      reason: allowed ? "allow_test" : "deny_missing_grant",
      explanation: "Decided by test mock.",
    };
  });
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
    // Scoped to gate 1 only. `decideWithAgentConfigRead` leaves every other action allowed, so
    // this actor also clears `workspace_runtime:read` — a state no real agent can reach
    // (PEN-2852). The realistic agent case, which clears gate 1 and fails gate 2, is the
    // PEN-5225 describe below; do not read this test as evidence that an agent sees commands.
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

/**
 * PEN-5225 round 2 — the approval card is the second exit onto the same bytes.
 *
 * `maskAgentWorkspaceStrategyCommands` closed the agent-config admission gate, which shut
 * `GET /api/agents/:id`. It did not reach here: `routes/agents.ts` writes the hire's
 * `adapterConfig` into this payload twice through `redactEventPayload` alone, and these read
 * paths gated only on `agent_config:read` — the verdict `agents:configure` /
 * `agents:suggest-changes` CLEAR. So a peer holding either read `provisionCommand` in the clear
 * from the card while every other route withheld it. Two exits, one answer (PEN-4775).
 *
 * The reader under test passes gate 1 and fails gate 2, which is the only configuration that can
 * see the bug — hence `decideBy` rather than one boolean for both.
 */
describe("hire_agent approval reads withhold host-executed workspace commands (PEN-5225)", () => {
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

  /** The peer that clears `agent_config:read` and can never hold `workspace_runtime:read`. */
  function decideAsConfiguringPeer() {
    decideBy({ "agent_config:read": true, "workspace_runtime:read": false });
  }

  function expectCommandsWithheld(payload: any) {
    expect(serializedBody(payload)).not.toContain("prov_secret_13579");
    expect(serializedBody(payload)).not.toContain("tear_secret_24680");
    expect(serializedBody(payload)).not.toContain(WORKTREE_PARENT_DIR);

    for (const config of [payload.adapterConfig, payload.requestedConfigurationSnapshot?.adapterConfig]) {
      if (!config) continue;
      expect(config.workspaceStrategy.provisionCommand).toBe("***REDACTED***");
      expect(config.workspaceStrategy.teardownCommand).toBe("***REDACTED***");
      expect(config.workspaceStrategy.worktreeParentDir).toBe("***REDACTED***");
      // Withheld-is-not-absent, and unrelated strategy keys ride through untouched.
      expect(config.workspaceStrategy.type).toBe("git_worktree");
      expect(config.workspaceStrategy.baseRef).toBe("main");
    }
  }

  it("withholds them from GET /approvals/:id for a peer that DOES hold agent_config:read", async () => {
    decideAsConfiguringPeer();
    mockApprovalService.getById.mockResolvedValue(hireApproval());

    const res = await request(await createAppWithActor(peerAgentActor)).get("/api/approvals/approval-1");

    expect(res.status).toBe(200);
    expectCommandsWithheld(res.body.payload);
    // Gate 1 passed, so the card's config is still readable — the two gates stay independent and
    // distinguishable, rather than one collapsing into the other.
    expect(res.body.payload.adapterConfig.mcpServers.k8s.url).toContain("k8s-mcp-admin.internal");
    expect(res.body.withheldFields).toEqual([]);
  }, 15000);

  it("withholds them from the company approvals list for the same peer", async () => {
    decideAsConfiguringPeer();
    mockApprovalService.list.mockResolvedValue([hireApproval()]);

    const res = await request(await createAppWithActor(peerAgentActor))
      .get(`/api/companies/${COMPANY_ID}/approvals`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expectCommandsWithheld(res.body[0].payload);
  }, 15000);

  it("still discloses them to a board reader, who clears workspace_runtime:read", async () => {
    // The other direction, and the reason this is a viewer gate rather than an unconditional
    // mask: the board decides the hire and must see what it is approving.
    decideBy({});
    mockApprovalService.getById.mockResolvedValue(hireApproval());

    const res = await request(await createAppWithActor(boardActor)).get("/api/approvals/approval-1");

    expect(res.status).toBe(200);
    expect(res.body.payload.adapterConfig.workspaceStrategy.provisionCommand).toBe(PROVISION_COMMAND);
    expect(res.body.payload.adapterConfig.workspaceStrategy.teardownCommand).toBe(TEARDOWN_COMMAND);
    expect(res.body.payload.adapterConfig.workspaceStrategy.worktreeParentDir).toBe(WORKTREE_PARENT_DIR);
  }, 15000);

  it("withholds them from the resolution response, which is a fourth serializer", async () => {
    // `approvalResolutionResponse` spreads `redactApprovalPayload` and adds `applied`. It shares
    // the projection rather than restating it, and this pins that it does.
    //
    // Driven by `boardActor` with the second verdict forced OFF, not by the configuring peer.
    // `/approve` is `assertBoard`-gated, so that peer is refused 403 before any payload is
    // serialized: the previous version of this case asserted `not.toContain` against an error
    // body and therefore passed whether the mask was wired into this serializer or removed
    // entirely. A test that cannot fail is worse than no test, because it reports the path as
    // pinned. Caught by Ally reviewing `68f772d`.
    //
    // Forcing the verdict rather than the actor is the honest way to reach the withheld branch
    // on a response only a board actor can obtain: this route reads the VIEWER, and the viewer is
    // exactly what the mask consumes. The reachable-by-a-real-agent half is the next case.
    decideAsConfiguringPeer();
    const decided = hireApproval({ status: "approved", decidedByUserId: "user-1" });
    mockApprovalService.getById.mockResolvedValue(hireApproval());
    mockResolveApprovalWithSideEffects.mockResolvedValue({ approval: decided, applied: true });

    const res = await request(await createAppWithActor(boardActor))
      .post("/api/approvals/approval-1/approve")
      .send({ decisionNote: "looks right" });

    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(true);
    expect(res.body.status).toBe("approved");
    expectCommandsWithheld(res.body.payload);
  }, 15000);

  it("withholds them from `/withdraw`, the resolution-shaped route an agent CAN reach", async () => {
    // The threat-model half. `approve`/`reject`/`requestRevision` are board-only, but `withdraw`
    // is requester-scoped (`routes/approvals.ts:1050`) — a requesting agent may rescind its own
    // card and gets a 200 carrying that card's payload back. So this is the one resolution-shaped
    // response the PEN-5225 reader reaches for real, with its own actual verdicts rather than a
    // forced viewer, and it is a different serializer call site from the read routes above.
    decideAsConfiguringPeer();
    const ownCard = hireApproval({ requestedByAgentId: peerAgentActor.agentId });
    mockApprovalService.getById.mockResolvedValue(ownCard);
    mockApprovalService.withdraw.mockResolvedValue(
      hireApproval({ requestedByAgentId: peerAgentActor.agentId, status: "withdrawn" }),
    );

    const res = await request(await createAppWithActor(peerAgentActor))
      .post("/api/approvals/approval-1/withdraw")
      .send({ reason: "superseded" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("withdrawn");
    expectCommandsWithheld(res.body.payload);
  }, 15000);
});
