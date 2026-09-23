import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentRoutes } from "../routes/agents.js";
import { agentService } from "../services/agents.js";
import { errorHandler } from "../middleware/index.js";

// BLO-27626. `agents.budget_monthly_cents` is a display mirror; the value that
// actually stops an agent is the row in `budget_policies` that
// `pauseScopeForBudget` reads. `PATCH /agents/:id` wrote the mirror alone and
// returned 200, so a cap raise made through it was indistinguishable from one
// that took effect — and it is the only budget write an ordinary agent can
// reach. Two real raises landed there and silently did not apply.

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
  adapterConfig: {},
  runtimeConfig: {},
  budgetMonthlyCents: 1_300_000,
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

const mockBudgetService = vi.hoisted(() => ({
  upsertPolicy: vi.fn(),
}));

const mockSecretService = vi.hoisted(() => ({
  normalizeAdapterConfigForPersistence: vi.fn(),
  resolveAdapterConfigForRuntime: vi.fn(),
}));

const mockCompanySkillService = vi.hoisted(() => ({
  listRuntimeSkillEntries: vi.fn(),
  resolveRequestedSkillKeys: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  listTaskSessions: vi.fn(),
  resetRuntimeSession: vi.fn(),
  cancelActiveForAgent: vi.fn(),
  cancelInvocationsForAgents: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  agentService: () => mockAgentService,
  agentInstructionsService: () => ({ materializeManagedBundle: vi.fn() }),
  accessService: () => mockAccessService,
  approvalService: () => ({
    create: vi.fn(),
    getById: vi.fn(),
    findOpenHireApprovalForAgent: vi.fn(),
    reject: vi.fn(),
  }),
  companySkillService: () => mockCompanySkillService,
  budgetService: () => mockBudgetService,
  heartbeatService: () => mockHeartbeatService,
  issueApprovalService: () => ({ linkManyForApproval: vi.fn() }),
  issueService: () => ({}),
  logActivity: mockLogActivity,
  secretService: () => mockSecretService,
  syncInstructionsBundleConfigFromFilePath: vi.fn((_agent, config) => config),
  workspaceOperationService: () => ({}),
}));

function createDbStub() {
  const rows = [{ id: companyId, name: "Paperclip", requireBoardApprovalForNewAgents: false }];
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
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

const agentActor = {
  type: "agent",
  agentId,
  companyId,
  companyIds: [companyId],
};

describe("PATCH /agents/:id rejects mirror-only budget writes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAgentService.getById.mockResolvedValue(baseAgent);
    mockAgentService.getChainOfCommand.mockResolvedValue([]);
    mockAccessService.getMembership.mockResolvedValue({ status: "active", membershipRole: "admin" });
    mockAccessService.hasPermission.mockResolvedValue(true);
    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.decide.mockResolvedValue({ allowed: true });
    mockCompanySkillService.listRuntimeSkillEntries.mockResolvedValue([]);
    mockSecretService.normalizeAdapterConfigForPersistence.mockImplementation(
      async (_companyId: string, config: unknown) => config,
    );
    mockLogActivity.mockResolvedValue(undefined);
  });

  // The core acceptance criterion: no 2xx for a write that cannot change
  // enforcement, and neither surface is touched.
  it.each([
    ["an agent actor", agentActor],
    ["a board actor", boardActor],
  ])("returns 422 for %s and writes neither the mirror nor the policy", async (_label, actor) => {
    const app = createApp(actor);
    const res = await request(app)
      .patch(`/api/agents/${agentId}`)
      .send({ budgetMonthlyCents: 2_300_000 });

    expect(res.status).toBe(422);
    // Both surfaces untouched. The mirror is written through `svc.update`; the
    // enforcing policy through `budgets.upsertPolicy`. Neither may run.
    expect(mockAgentService.update).not.toHaveBeenCalled();
    expect(mockBudgetService.upsertPolicy).not.toHaveBeenCalled();
    // No config revision either — the old behaviour recorded one, which is what
    // made the no-op look like a durable change in the audit trail.
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  // The error has to name a route that actually works, or the caller retries
  // against the same non-binding surface.
  it("names the budgets route that writes both surfaces", async () => {
    const app = createApp(boardActor);
    const res = await request(app)
      .patch(`/api/agents/${agentId}`)
      .send({ budgetMonthlyCents: 2_300_000 });

    expect(res.body.error).toContain("PATCH /api/agents/:agentId/budgets");
  });

  // Rejection is on the presence of the key, not on whether the value differs.
  // A patch that re-sends the current mirror still cannot be honoured: when the
  // mirror has drifted, echoing it back reports a cap that does not enforce.
  it("rejects a no-op write that merely re-sends the current mirror", async () => {
    const app = createApp(boardActor);
    const res = await request(app)
      .patch(`/api/agents/${agentId}`)
      .send({ budgetMonthlyCents: baseAgent.budgetMonthlyCents });

    expect(res.status).toBe(422);
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  // Regression guard: the rejection must be scoped to the budget field only.
  it("still applies a patch that does not touch the budget", async () => {
    mockAgentService.update.mockResolvedValue({ ...baseAgent, spentMonthlyCents: 7 });
    const app = createApp(boardActor);
    const res = await request(app)
      .patch(`/api/agents/${agentId}`)
      .send({ spentMonthlyCents: 7 });

    expect(res.status).toBe(200);
    expect(mockAgentService.update).toHaveBeenCalled();
  });
});

// Each entry in `results` is one query's row-set, popped FIFO as the chain's
// then() resolves — same stub shape as monthly-spend-service.test.ts, which
// covers the sibling `spentMonthlyCents` hydration.
function createSelectSequenceDb(results: unknown[][]) {
  const pending = [...results];
  const chain = {
    from: vi.fn(() => chain),
    where: vi.fn(() => chain),
    leftJoin: vi.fn(() => chain),
    groupBy: vi.fn(() => chain),
    then: vi.fn((resolve: (value: unknown[]) => unknown) => Promise.resolve(resolve(pending.shift() ?? []))),
  };
  return { select: vi.fn(() => chain) };
}

const agentRow = {
  id: agentId,
  companyId,
  name: "Budget Agent",
  role: "general",
  title: null,
  reportsTo: null,
  capabilities: null,
  adapterType: "claude_local",
  adapterConfig: {},
  runtimeConfig: {},
  // Drifted mirror: the number the UI and every agent-facing read returned.
  budgetMonthlyCents: 2_300_000,
  spentMonthlyCents: 0,
  metadata: null,
  permissions: null,
  status: "idle",
  pauseReason: null,
  pausedAt: null,
  createdAt: new Date("2026-03-19T00:00:00.000Z"),
  updatedAt: new Date("2026-03-19T00:00:00.000Z"),
};

describe("agent read model exposes the enforcing budget policy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports the policy amount, not the drifted mirror", async () => {
    const db = createSelectSequenceDb([
      [agentRow], // getById: the agent row
      [agentRow], // listCompanyAgentRows
      [], // monthly spend
      [{ scopeId: agentId, amount: 1_300_000 }], // the enforcing policy
    ]);

    const agent = await agentService(db as any).getById(agentId);

    // The mirror is still reported, unchanged — config revisions snapshot it.
    expect(agent?.budgetMonthlyCents).toBe(2_300_000);
    // ...but the enforcing value is now readable alongside it, so a consumer
    // never has to guess which of the two it is holding.
    expect(agent?.enforcedBudgetMonthlyCents).toBe(1_300_000);
  });

  it("reports null when no active policy enforces a cap", async () => {
    const db = createSelectSequenceDb([
      [agentRow],
      [agentRow],
      [],
      [], // no policy row
    ]);

    const agent = await agentService(db as any).getById(agentId);

    // null, not 0: "uncapped" must not be confused with "capped at zero".
    expect(agent?.enforcedBudgetMonthlyCents).toBeNull();
  });

  it("hydrates the enforcing amount for every agent in a company listing", async () => {
    const other = { ...agentRow, id: "33333333-3333-4333-8333-333333333333", name: "Other" };
    const db = createSelectSequenceDb([
      [agentRow, other], // list rows
      [agentRow, other], // listCompanyAgentRows
      [], // monthly spend
      [{ scopeId: other.id, amount: 400_000 }], // only one agent carries a policy
    ]);

    const listed = await agentService(db as any).list(companyId);

    expect(listed.map((a) => [a.name, a.enforcedBudgetMonthlyCents])).toEqual([
      ["Budget Agent", null],
      ["Other", 400_000],
    ]);
  });
});
