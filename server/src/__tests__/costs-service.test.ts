import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { afterAll, afterEach, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  createDb,
  companies,
  agents,
  activityLog,
  costEvents,
  financeEvents,
  heartbeatRuns,
  issues,
  projects,
} from "@paperclipai/db";
import { costService } from "../services/costs.js";
import { financeService } from "../services/finance.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

function makeDb(overrides: Record<string, unknown> = {}) {
  const selectChain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    leftJoin: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    groupBy: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    // `PATCH /agents/:id/budgets` takes a `SELECT … FOR UPDATE` on the agent's
    // budget policies before it touches `agents` (BLO-32796 lock ordering).
    for: vi.fn().mockReturnThis(),
    then: vi.fn().mockResolvedValue([]),
  };

  const thenableChain = Object.assign(Promise.resolve([]), selectChain);

  const db = {
    select: vi.fn().mockReturnValue(thenableChain),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([]) }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
    }),
    ...overrides,
  };
  return {
    ...db,
    transaction: vi.fn(async (callback) => callback(db)),
  };
}

const mockCompanyService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
}));
const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
}));
const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  getByIdentifier: vi.fn(),
}));
const mockHeartbeatService = vi.hoisted(() => ({
  cancelBudgetScopeWork: vi.fn().mockResolvedValue(undefined),
}));
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockFetchAllQuotaWindows = vi.hoisted(() => vi.fn());
const mockCostService = vi.hoisted(() => ({
  createEvent: vi.fn(),
  summary: vi.fn().mockResolvedValue({ spendCents: 0 }),
  byAgent: vi.fn().mockResolvedValue([]),
  byAgentModel: vi.fn().mockResolvedValue([]),
  byProvider: vi.fn().mockResolvedValue([]),
  byBiller: vi.fn().mockResolvedValue([]),
  issueTreeSummary: vi.fn().mockResolvedValue({
    issueId: "issue-1",
    issueCount: 1,
    includeDescendants: true,
    costCents: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    runCount: 0,
    runtimeMs: 0,
  }),
  windowSpend: vi.fn().mockResolvedValue([]),
  byProject: vi.fn().mockResolvedValue([]),
}));
const mockFinanceService = vi.hoisted(() => ({
  createEvent: vi.fn(),
  summary: vi.fn().mockResolvedValue({ debitCents: 0, creditCents: 0, netCents: 0, estimatedDebitCents: 0, eventCount: 0 }),
  byBiller: vi.fn().mockResolvedValue([]),
  byKind: vi.fn().mockResolvedValue([]),
  list: vi.fn().mockResolvedValue([]),
}));
const mockBudgetService = vi.hoisted(() => ({
  overview: vi.fn().mockResolvedValue({
    companyId: "company-1",
    policies: [],
    activeIncidents: [],
    pausedAgentCount: 0,
    pausedProjectCount: 0,
    pendingApprovalCount: 0,
  }),
  upsertPolicy: vi.fn(),
  resolveIncident: vi.fn(),
}));
const mockAccessService = vi.hoisted(() => ({
  decide: vi.fn(),
}));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    budgetService: () => mockBudgetService,
    costService: () => mockCostService,
    financeService: () => mockFinanceService,
    companyService: () => mockCompanyService,
    agentService: () => mockAgentService,
    issueService: () => mockIssueService,
    heartbeatService: () => mockHeartbeatService,
    logActivity: mockLogActivity,
  }));

  vi.doMock("../services/quota-windows.js", () => ({
    fetchAllQuotaWindows: mockFetchAllQuotaWindows,
  }));
}

async function createApp() {
  const [{ costRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/costs.js")>("../routes/costs.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = { type: "board", userId: "board-user", source: "local_implicit" };
    next();
  });
  app.use("/api", costRoutes(makeDb() as any));
  app.use(errorHandler);
  return app;
}

async function createAppWithActor(actor: any) {
  const [{ costRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/costs.js")>("../routes/costs.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", costRoutes(makeDb() as any));
  app.use(errorHandler);
  return app;
}

async function loadCostParsers() {
  const { parseCostDateRange, parseCostLimit, parseCostAgentId } = await import("../routes/costs.js");
  return { parseCostDateRange, parseCostLimit, parseCostAgentId };
}

beforeEach(() => {
  vi.resetModules();
  vi.doUnmock("../services/index.js");
  vi.doUnmock("../services/quota-windows.js");
  vi.doUnmock("../routes/costs.js");
  vi.doUnmock("../middleware/index.js");
  registerModuleMocks();
  vi.clearAllMocks();
  mockAccessService.decide.mockReset();
  mockAccessService.decide.mockResolvedValue({
    allowed: true,
    action: "company_scope:read",
    reason: "allow_test",
    explanation: "Allowed by test mock.",
  });
  mockCompanyService.update.mockResolvedValue({
    id: "company-1",
    name: "Paperclip",
    budgetMonthlyCents: 100,
    spentMonthlyCents: 0,
  });
  mockAgentService.getById.mockResolvedValue({
    id: "agent-1",
    companyId: "company-1",
    name: "Budget Agent",
    budgetMonthlyCents: 100,
    spentMonthlyCents: 0,
  });
  mockAgentService.update.mockResolvedValue({
    id: "agent-1",
    companyId: "company-1",
    name: "Budget Agent",
    budgetMonthlyCents: 100,
    spentMonthlyCents: 0,
  });
  mockIssueService.getById.mockResolvedValue({
    id: "issue-1",
    companyId: "company-1",
    identifier: "PC1A2-1",
  });
  mockIssueService.getByIdentifier.mockResolvedValue({
    id: "issue-1",
    companyId: "company-1",
    identifier: "PC1A2-1",
  });
  mockBudgetService.upsertPolicy.mockResolvedValue(undefined);
});

describe("cost routes", () => {
  it("accepts valid ISO date strings", async () => {
    const { parseCostDateRange } = await loadCostParsers();
    expect(parseCostDateRange({
      from: "2026-01-01T00:00:00.000Z",
      to: "2026-01-31T23:59:59.999Z",
    })).toEqual({
      from: new Date("2026-01-01T00:00:00.000Z"),
      to: new Date("2026-01-31T23:59:59.999Z"),
    });
  });

  it("returns 400 for an invalid 'from' date string", async () => {
    const { parseCostDateRange } = await loadCostParsers();
    expect(() => parseCostDateRange({ from: "not-a-date" })).toThrow(/invalid 'from' date/i);
  });

  it("returns 400 for an invalid 'to' date string", async () => {
    const { parseCostDateRange } = await loadCostParsers();
    expect(() => parseCostDateRange({ to: "banana" })).toThrow(/invalid 'to' date/i);
  });

  // PEN-4902: `?agentId=` was accepted and ignored on the agent-keyed reports,
  // so a per-seat request answered 200 with every seat in the company. The
  // damage is not the extra rows -- it is that `rows[0]`, the natural read of
  // a one-seat request, returns whichever seat sorts first by spend under the
  // requested seat's name, and nothing at the call site can tell.
  it("passes agentId through to the agent-keyed cost reports", async () => {
    const app = await createApp();

    const byAgent = await request(app)
      .get("/api/companies/company-1/costs/by-agent")
      .query({ agentId: "agent-7", from: "2026-11-02T00:00:00.000Z" });
    expect(byAgent.status).toBe(200);
    expect(mockCostService.byAgent.mock.calls[0]?.[2]).toEqual({ agentId: "agent-7" });

    const byAgentModel = await request(app)
      .get("/api/companies/company-1/costs/by-agent-model")
      .query({ agentId: "agent-7" });
    expect(byAgentModel.status).toBe(200);
    expect(mockCostService.byAgentModel.mock.calls[0]?.[2]).toEqual({ agentId: "agent-7" });
  });

  it("leaves the agent filter unset when agentId is omitted", async () => {
    const app = await createApp();
    const res = await request(app).get("/api/companies/company-1/costs/by-agent");
    expect(res.status).toBe(200);
    expect((mockCostService.byAgent.mock.calls[0]?.[2] as { agentId?: string }).agentId).toBeUndefined();
  });

  it("reads the first agentId when the parameter repeats, and rejects a non-string", async () => {
    const { parseCostAgentId } = await loadCostParsers();
    expect(parseCostAgentId({ agentId: "agent-7" })).toBe("agent-7");
    expect(parseCostAgentId({ agentId: ["agent-7", "agent-8"] })).toBe("agent-7");
    expect(parseCostAgentId({})).toBeUndefined();
    expect(parseCostAgentId({ agentId: "" })).toBeUndefined();
    expect(() => parseCostAgentId({ agentId: { nested: "1" } })).toThrow(/invalid 'agentId'/i);
  });

  it("returns finance summary rows for valid requests", async () => {
    const app = await createApp();
    const res = await request(app)
      .get("/api/companies/company-1/costs/finance-summary")
      .query({ from: "2026-02-01T00:00:00.000Z", to: "2026-02-28T23:59:59.999Z" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      debitCents: 0,
      creditCents: 0,
      netCents: 0,
      estimatedDebitCents: 0,
      eventCount: 0,
    });
  });

  it("returns issue subtree cost summaries for issue refs", async () => {
    const app = await createApp();
    const res = await request(app).get("/api/issues/pc1a2-1/cost-summary");

    expect(res.status).toBe(200);
    expect(mockIssueService.getByIdentifier).toHaveBeenCalledWith("PC1A2-1");
    expect(mockCostService.issueTreeSummary).toHaveBeenCalledWith("company-1", "issue-1", {
      excludeRoot: false,
    });
    expect(res.body).toEqual({
      issueId: "issue-1",
      issueCount: 1,
      includeDescendants: true,
      costCents: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      runCount: 0,
      runtimeMs: 0,
    });
  });

  it("returns 400 for invalid finance event list limits", async () => {
    const { parseCostLimit } = await loadCostParsers();
    expect(() => parseCostLimit({ limit: "0" })).toThrow(/invalid 'limit'/i);
  });

  it("accepts valid finance event list limits", async () => {
    const { parseCostLimit } = await loadCostParsers();
    expect(parseCostLimit({ limit: "25" })).toBe(25);
  });

  it("rejects company budget updates for board users outside the company", async () => {
    const app = await createAppWithActor({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-2"],
    });

    const res = await request(app)
      .patch("/api/companies/company-1/budgets")
      .send({ budgetMonthlyCents: 2500 });

    expect(res.status).toBe(403);
    expect(mockCompanyService.update).not.toHaveBeenCalled();
  });

  it("rejects agent budget updates for board users outside the agent company", async () => {
    const app = await createAppWithActor({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-2"],
    });

    const res = await request(app)
      .patch("/api/agents/agent-1/budgets")
      .send({ budgetMonthlyCents: 2500 });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Agent not found");
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  it("rejects agent budget updates from the target agent without changing the budget policy", async () => {
    const app = await createAppWithActor({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      runId: "run-1",
    });

    const res = await request(app)
      .patch("/api/agents/agent-1/budgets")
      .send({ budgetMonthlyCents: 2500 });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Board access required" });
    expect(mockAgentService.update).not.toHaveBeenCalled();
    expect(mockBudgetService.upsertPolicy).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("rejects agent budget updates from another same-company agent without changing the budget policy", async () => {
    const app = await createAppWithActor({
      type: "agent",
      agentId: "agent-2",
      companyId: "company-1",
      runId: "run-2",
    });

    const res = await request(app)
      .patch("/api/agents/agent-1/budgets")
      .send({ budgetMonthlyCents: 2500 });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Board access required" });
    expect(mockAgentService.update).not.toHaveBeenCalled();
    expect(mockBudgetService.upsertPolicy).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("allows authorized board users to update an agent budget and budget policy", async () => {
    mockAgentService.update.mockResolvedValueOnce({
      id: "agent-1",
      companyId: "company-1",
      name: "Budget Agent",
      budgetMonthlyCents: 2500,
      spentMonthlyCents: 0,
    });
    const app = await createAppWithActor({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
      memberships: [{ companyId: "company-1", status: "active", membershipRole: "admin" }],
    });

    const res = await request(app)
      .patch("/api/agents/agent-1/budgets")
      .send({ budgetMonthlyCents: 2500 });

    expect(res.status).toBe(200);
    expect(mockAgentService.update).toHaveBeenCalledWith(
      "agent-1",
      { budgetMonthlyCents: 2500 },
      {
        recordRevision: {
          createdByAgentId: null,
          createdByUserId: "board-user",
          source: "budgets-patch",
        },
      },
    );
    expect(mockBudgetService.upsertPolicy).toHaveBeenCalledWith(
      "company-1",
      {
        scopeType: "agent",
        scopeId: "agent-1",
        amount: 2500,
        windowKind: "calendar_month_utc",
      },
      "board-user",
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: "company-1",
        actorType: "user",
        actorId: "board-user",
        agentId: null,
        action: "agent.budget_updated",
        entityType: "agent",
        entityId: "agent-1",
        details: { budgetMonthlyCents: 2500 },
      }),
    );
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

/**
 * PEN-5585: record the SQL of every drizzle query this db actually executes.
 *
 * A result-preserving change cannot be regression-guarded by its results. Wrapping the
 * handle lets a test assert on the statement the service built rather than on a copy
 * rebuilt in the test, which would only prove the test agrees with itself.
 *
 * The proxy re-wraps anything a builder method returns that still carries `toSQL`, and
 * reads the statement at `then` — the moment the chain is finalised and awaited.
 */
function withSqlCapture<T extends object>(db: T, sink: string[]): T {
  const wrapValue = (value: unknown): unknown => {
    // Builders must be wrapped from the FIRST link in the chain. `db.select({...})` returns
    // a builder that has no `toSQL` until `.from()` is called, so gating the wrap on `toSQL`
    // unwraps the chain at step one and captures nothing. Arrays are the resolved rows.
    if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
    const candidate = value as { toSQL?: () => { sql: string } };
    return new Proxy(candidate, {
      get(target, prop, receiver) {
        const got = Reflect.get(target, prop, receiver);
        if (prop === "then" && typeof got === "function") {
          if (typeof target.toSQL === "function") {
            try {
              sink.push(target.toSQL().sql);
            } catch {
              // Not every thenable is a finalised statement; a capture miss must not fail the query.
            }
          }
          return (got as (...a: unknown[]) => unknown).bind(target);
        }
        if (typeof got === "function") {
          return (...args: unknown[]) =>
            wrapValue((got as (...a: unknown[]) => unknown).apply(target, args));
        }
        return got;
      },
    }) as unknown;
  };

  return new Proxy(db, {
    get(target, prop, receiver) {
      const got = Reflect.get(target, prop, receiver);
      if (typeof got === "function") {
        return (...args: unknown[]) =>
          wrapValue((got as (...a: unknown[]) => unknown).apply(target, args));
      }
      return got;
    },
  }) as T;
}

describeEmbeddedPostgres("cost and finance aggregate overflow handling", () => {
  let db!: ReturnType<typeof createDb>;
  let costs!: ReturnType<typeof costService>;
  let finance!: ReturnType<typeof financeService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-costs-service-");
    db = createDb(tempDb.connectionString);
    costs = costService(db);
    finance = financeService(db);
  });

  afterEach(async () => {
    await db.delete(financeEvents);
    await db.delete(costEvents);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("persists unpriced token usage without inflating monthly spend", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CLI Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const event = await costs.createEvent(companyId, {
      agentId,
      provider: "openai",
      biller: "chatgpt",
      billingType: "subscription_included",
      costStatus: "unpriced",
      model: "gpt-5.6-terra",
      inputTokens: 2_732_577,
      cachedInputTokens: 2_632_998,
      outputTokens: 32_644,
      costCents: 0,
      occurredAt: new Date("2026-07-13T14:22:54.000Z"),
    });

    expect(event.costStatus).toBe("unpriced");
    expect(event.inputTokens).toBe(2_732_577);
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(agent?.spentMonthlyCents).toBe(0);
  });

  // PEN-4902: `apiRunCount` and `subscriptionRunCount` partition only the CLASSIFIED
  // rows, and `unknown` is in neither set. On a fleet whose lanes are all brokered --
  // the live state of this tenant -- both read 0 while runs are happening, and a reader
  // who takes that as a run count concludes the seat is idle and divides by zero. This
  // pins the unbranched `costEventRunCount` that answers the question those two cannot, and the
  // `runlessEventCount` that keeps it from failing the opposite way.
  it("reports an unbranched costEventRunCount when no row is classified and both billing-type counters read zero", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runOneId = randomUUID();
    const runTwoId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Ceo",
      role: "ceo",
      status: "active",
      adapterType: "claude_k8s",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values([
      {
        id: runOneId,
        companyId,
        agentId,
        invocationSource: "automation",
        status: "completed",
        startedAt: new Date("2026-11-03T09:00:00.000Z"),
        finishedAt: new Date("2026-11-03T09:11:00.000Z"),
      },
      {
        id: runTwoId,
        companyId,
        agentId,
        invocationSource: "automation",
        status: "completed",
        startedAt: new Date("2026-11-03T09:15:00.000Z"),
        finishedAt: new Date("2026-11-03T09:30:00.000Z"),
      },
    ]);

    // billingType omitted on purpose: `createEvent` defaults it to "unknown", which is
    // also what `resolveLedgerBillingType` resolves every Penstock-brokered lane to.
    const base = {
      agentId,
      provider: "anthropic",
      biller: "anthropic",
      model: "claude-opus-5",
      inputTokens: 1_000,
      outputTokens: 500,
      costCents: 100,
      occurredAt: new Date("2026-11-03T09:05:00.000Z"),
    } as const;

    // two events on the same run, one on a second run: three events, two runs.
    await costs.createEvent(companyId, { ...base, heartbeatRunId: runOneId });
    await costs.createEvent(companyId, { ...base, heartbeatRunId: runOneId });
    await costs.createEvent(companyId, { ...base, heartbeatRunId: runTwoId });
    // and one row with no run attribution at all, which `POST /cost-events` permits.
    await costs.createEvent(companyId, { ...base, heartbeatRunId: null });

    const [row] = await costs.byAgent(companyId);

    // the defect this field exists for: nothing is classified, so both read 0.
    expect(row?.apiRunCount).toBe(0);
    expect(row?.subscriptionRunCount).toBe(0);

    expect(row?.costEventRunCount).toBe(2);
    expect(row?.runlessEventCount).toBe(1);

    // cash and consumption still agree, because no lane is classified as a subscription.
    expect(row?.consumptionCents).toBe(row?.costCents);
  });

  it("aggregates cost event sums above int32 without raising Postgres integer overflow", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Cost Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Overflow Project",
      status: "active",
    });

    await db.insert(costEvents).values([
      {
        companyId,
        agentId,
        projectId,
        provider: "openai",
        biller: "openai",
        billingType: "metered_api",
        model: "gpt-5",
        inputTokens: 2_000_000_000,
        cachedInputTokens: 0,
        outputTokens: 200_000_000,
        costCents: 2_000_000_000,
        occurredAt: new Date("2026-04-10T00:00:00.000Z"),
      },
      {
        companyId,
        agentId,
        projectId,
        provider: "openai",
        biller: "openai",
        billingType: "metered_api",
        model: "gpt-5",
        inputTokens: 2_000_000_000,
        cachedInputTokens: 10,
        outputTokens: 200_000_000,
        costCents: 2_000_000_000,
        occurredAt: new Date("2026-04-11T00:00:00.000Z"),
      },
    ]);

    const range = {
      from: new Date("2026-04-01T00:00:00.000Z"),
      to: new Date("2026-04-15T23:59:59.999Z"),
    };

    const [byAgentRow] = await costs.byAgent(companyId, range);
    const [byProjectRow] = await costs.byProject(companyId, range);
    const [byAgentModelRow] = await costs.byAgentModel(companyId, range);

    expect(byAgentRow?.costCents).toBe(4_000_000_000);
    expect(byAgentRow?.inputTokens).toBe(4_000_000_000);
    expect(byProjectRow?.costCents).toBe(4_000_000_000);
    expect(byAgentModelRow?.costCents).toBe(4_000_000_000);
  });

  // PEN-5585: `byProject` resolves a project for run-attributed cost events through
  // `run_project_links`, and that subquery is now restricted to the runs appearing in the
  // windowed `cost_events`. The restriction has to prune WITHOUT dropping a real
  // attribution — the failure mode would be silent, because a dropped link does not error,
  // it just moves money out of the project that earned it.
  it("attributes run-linked cost events to their project while ignoring links for runs outside the window", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const inWindowProjectId = randomUUID();
    const outOfWindowProjectId = randomUUID();
    const inWindowIssueId = randomUUID();
    const outOfWindowIssueId = randomUUID();
    const inWindowRunId = randomUUID();
    const outOfWindowRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Link Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(projects).values([
      { id: inWindowProjectId, companyId, name: "In Window Project", status: "active" },
      { id: outOfWindowProjectId, companyId, name: "Out Of Window Project", status: "active" },
    ]);
    await db.insert(issues).values([
      {
        id: inWindowIssueId,
        companyId,
        projectId: inWindowProjectId,
        title: "In window",
        status: "in_progress",
        priority: "medium",
        issueNumber: 1,
        identifier: "LNK-1",
      },
      {
        id: outOfWindowIssueId,
        companyId,
        projectId: outOfWindowProjectId,
        title: "Out of window",
        status: "done",
        priority: "medium",
        issueNumber: 2,
        identifier: "LNK-2",
      },
    ]);
    await db.insert(heartbeatRuns).values([
      {
        id: inWindowRunId,
        companyId,
        agentId,
        invocationSource: "on_demand",
        status: "completed",
        startedAt: new Date("2026-04-10T00:00:00.000Z"),
        finishedAt: new Date("2026-04-10T00:01:00.000Z"),
      },
      {
        id: outOfWindowRunId,
        companyId,
        agentId,
        invocationSource: "on_demand",
        status: "completed",
        startedAt: new Date("2026-01-02T00:00:00.000Z"),
        finishedAt: new Date("2026-01-02T00:01:00.000Z"),
      },
    ]);

    // Both runs have a link row. `created_at` defaults to now() for both, i.e. far outside
    // the requested window for EITHER run — which is why the restriction is keyed on the
    // windowed run ids and not on `activity_log.created_at`.
    await db.insert(activityLog).values([
      {
        companyId,
        runId: inWindowRunId,
        actorType: "agent",
        actorId: agentId,
        agentId,
        action: "issue.checked_out",
        entityType: "issue",
        entityId: inWindowIssueId,
        details: {},
      },
      {
        companyId,
        runId: outOfWindowRunId,
        actorType: "agent",
        actorId: agentId,
        agentId,
        action: "issue.checked_out",
        entityType: "issue",
        entityId: outOfWindowIssueId,
        details: {},
      },
    ]);

    const base = {
      companyId,
      agentId,
      provider: "anthropic",
      biller: "anthropic",
      billingType: "metered_api",
      model: "claude-opus-5",
      inputTokens: 1_000,
      cachedInputTokens: 0,
      outputTokens: 500,
    } as const;

    await db.insert(costEvents).values([
      // no projectId: attribution has to come through run_project_links.
      {
        ...base,
        heartbeatRunId: inWindowRunId,
        costCents: 700,
        occurredAt: new Date("2026-04-10T00:00:30.000Z"),
      },
      {
        ...base,
        heartbeatRunId: outOfWindowRunId,
        costCents: 999,
        occurredAt: new Date("2026-01-02T00:00:30.000Z"),
      },
    ]);

    const capturedSql: string[] = [];
    const costsWithCapture = costService(withSqlCapture(db, capturedSql));

    const rows = await costsWithCapture.byProject(companyId, {
      from: new Date("2026-04-01T00:00:00.000Z"),
      to: new Date("2026-04-15T23:59:59.999Z"),
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.projectId).toBe(inWindowProjectId);
    expect(rows[0]?.costCents).toBe(700);

    // The pruned run is not lost data — ask for its window and it attributes normally.
    const earlierRows = await costsWithCapture.byProject(companyId, {
      from: new Date("2026-01-01T00:00:00.000Z"),
      to: new Date("2026-01-31T23:59:59.999Z"),
    });
    expect(earlierRows).toHaveLength(1);
    expect(earlierRows[0]?.projectId).toBe(outOfWindowProjectId);
    expect(earlierRows[0]?.costCents).toBe(999);

    // PEN-5585: the assertions above guard ATTRIBUTION, not the pruning — the bound is
    // result-preserving by construction, so they pass identically whether the restriction
    // is emitted or silently dropped by a drizzle API mistake. Only the compiled SQL
    // distinguishes those two, so read it off the query the service actually built.
    const emitted = capturedSql.filter((text) => text.includes("run_project_links"));
    expect(emitted.length).toBeGreaterThan(0);
    for (const text of emitted) {
      expect(text).toContain('"activity_log"."run_id" in (');
      expect(text).toContain('select distinct "heartbeat_run_id" from "cost_events"');
    }
  });

  // PEN-5604: `byProject` attributes run-level cost through `run_project_links`, which
  // deduplicated (run_id, project_id) PAIRS rather than runs. A run that touched issues
  // in N projects produced N link rows, the `leftJoin` matched on `run_id` alone, and
  // every cost event of that run was therefore counted N times -- including the rows
  // that already carried a direct `project_id`, which `coalesce` kept mapping back to
  // the same project on each copy. The visible consequence is arithmetic that does not
  // add up: `sum(byProject[].costCents)` exceeded actual spend in the same window.
  //
  // The invariant pinned here is that total, not the split. The per-project assertions
  // below additionally pin the attribution the CTO ruled on: a multi-project run's
  // run-level cost lands on the project it most recently touched, which is what the
  // pre-existing `ORDER BY ... created_at DESC` was written for and what pair-dedup
  // made inert.
  it("does not double-count a multi-project run's cost events across projects", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const earlierProjectId = randomUUID();
    const laterProjectId = randomUUID();
    const earlierIssueId = randomUUID();
    const laterIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Cost Agent",
      role: "engineer",
      status: "active",
      adapterType: "claude_k8s",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(projects).values([
      { id: earlierProjectId, companyId, name: "Earlier Project", status: "active" },
      { id: laterProjectId, companyId, name: "Later Project", status: "active" },
    ]);
    await db.insert(issues).values([
      {
        id: earlierIssueId,
        companyId,
        projectId: earlierProjectId,
        title: "Touched first",
        status: "done",
        priority: "medium",
        issueNumber: 1,
        identifier: "TST-1",
      },
      {
        id: laterIssueId,
        companyId,
        projectId: laterProjectId,
        title: "Touched last",
        status: "done",
        priority: "medium",
        issueNumber: 2,
        identifier: "TST-2",
      },
    ]);
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "automation",
      status: "completed",
      startedAt: new Date("2026-11-04T09:00:00.000Z"),
      finishedAt: new Date("2026-11-04T09:30:00.000Z"),
    });

    // One run, two projects: this is the fan-out source. `created_at` is set explicitly
    // so "most recently touched" is deterministic rather than insertion-order luck.
    await db.insert(activityLog).values([
      {
        companyId,
        runId,
        actorType: "agent",
        actorId: agentId,
        agentId,
        action: "issue.checked_out",
        entityType: "issue",
        entityId: earlierIssueId,
        details: {},
        createdAt: new Date("2026-11-04T09:05:00.000Z"),
      },
      {
        companyId,
        runId,
        actorType: "agent",
        actorId: agentId,
        agentId,
        action: "issue.checked_out",
        entityType: "issue",
        entityId: laterIssueId,
        details: {},
        createdAt: new Date("2026-11-04T09:20:00.000Z"),
      },
    ]);

    // Both populations, so the fix is shown to cover each: one row that needs run
    // attribution (no direct project), one that does not (direct project already set).
    await db.insert(costEvents).values([
      {
        companyId,
        agentId,
        heartbeatRunId: runId,
        projectId: null,
        provider: "anthropic",
        biller: "anthropic",
        billingType: "metered_api",
        model: "claude-opus-5",
        inputTokens: 1_000,
        outputTokens: 500,
        costCents: 100,
        occurredAt: new Date("2026-11-04T09:10:00.000Z"),
      },
      {
        companyId,
        agentId,
        heartbeatRunId: runId,
        projectId: earlierProjectId,
        provider: "anthropic",
        biller: "anthropic",
        billingType: "metered_api",
        model: "claude-opus-5",
        inputTokens: 2_000,
        outputTokens: 800,
        costCents: 250,
        occurredAt: new Date("2026-11-04T09:25:00.000Z"),
      },
    ]);

    const rows = await costs.byProject(companyId);
    const totalReported = rows.reduce((sum, row) => sum + (row.costCents ?? 0), 0);

    // The invariant: by-project totals must equal actual spend over the same window.
    expect(totalReported).toBe(350);

    const byProjectId = new Map(rows.map((row) => [row.projectId, row.costCents]));
    // Direct attribution, counted exactly once despite the run touching two projects.
    expect(byProjectId.get(earlierProjectId)).toBe(250);
    // Run attribution resolves to the project the run most recently touched.
    expect(byProjectId.get(laterProjectId)).toBe(100);
  });

  // PEN-5624: `activity_log.created_at` is `defaultNow()` = `now()` = TRANSACTION start
  // time, so a run's multiple issue touches written in one transaction tie by
  // CONSTRUCTION. With the sort keys equal, `DISTINCT ON (run_id)` keeps whichever row
  // the executor presents first, and attribution can flip between requests over
  // identical data. The `desc(activityLog.id)` tiebreaker makes the pick STABLE -- not
  // recency-correct, since `activity_log.id` is a random v4 UUID with no time component.
  //
  // WHY THIS FIXTURE IS A MIRRORED PAIR. A single tied run cannot falsify the
  // tiebreaker behaviourally: whichever row the untiebroken executor happens to present
  // first, a one-run fixture can be read as agreeing with it, and the earlier version of
  // this test did exactly that -- reverting only the tiebreaker left its behavioural
  // assertions green, so the `order by` string was the lone pin.
  //
  // So the fixture runs the SAME two issues twice, as two runs, swapping only which of
  // the two tied `activity_log` rows carries the HIGH id. Both runs insert alpha's row
  // first and beta's second, so every order-determining input the untiebroken query can
  // see -- heap order, join shape, issue and project ids -- is IDENTICAL across the two
  // groups. The only difference is the id values, which the untiebroken query ignores.
  //
  // That makes the falsification structural rather than lucky. Untiebroken, the executor
  // must present the same POSITION first in both groups, so both runs attribute to the
  // SAME project and the two per-project expectations below cannot both hold. Tiebroken,
  // the HIGH id wins in both, and the runs land on different projects.
  //
  // MEASURED, not assumed. Reverting only `desc(activityLog.id)` on `costs.ts` reds this
  // test 3/3 runs with an identical behavioural failure -- `expected 107 to be 100` on
  // the alpha assertion, i.e. both runs collapsed onto alpha, the first-inserted row of
  // each pair. Restoring the tiebreaker returns the 100/7 split. So unlike the single-run
  // fixture this replaces, the behavioural half IS the pin here; the `order by` assertion
  // below is kept as a cheap guard on the mechanism, not as the only thing that falsifies.
  it("breaks a created_at tie in run attribution deterministically", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();

    // Every id below is fixed, not random. The tiebreaker is `desc(id)`, so the intended
    // winner has to be known up front; and random issue/project ids let the join's row
    // order vary between runs of the test, which would make the falsification flaky
    // rather than structural.
    const alphaProjectId = "a0000000-0000-4000-8000-00000000a1a1";
    const betaProjectId = "b0000000-0000-4000-8000-00000000b1b1";
    const alphaIssueId = "a0000000-0000-4000-8000-00000000a2a2";
    const betaIssueId = "b0000000-0000-4000-8000-00000000b2b2";
    const highIdRunId = "70000000-0000-4000-8000-000000000001";
    const lowIdRunId = "70000000-0000-4000-8000-000000000002";

    // Run 1: alpha's touch carries the HIGH activity id, beta's the LOW one.
    const run1AlphaActivityId = "ffffffff-ffff-4fff-bfff-ffffffffff11";
    const run1BetaActivityId = "00000000-0000-4000-8000-000000000011";
    // Run 2: mirrored -- beta's touch carries the HIGH id, alpha's the LOW one.
    const run2AlphaActivityId = "00000000-0000-4000-8000-000000000022";
    const run2BetaActivityId = "ffffffff-ffff-4fff-bfff-ffffffffff22";

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Tie Agent",
      role: "engineer",
      status: "active",
      adapterType: "claude_k8s",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(projects).values([
      { id: alphaProjectId, companyId, name: "Alpha", status: "active" },
      { id: betaProjectId, companyId, name: "Beta", status: "active" },
    ]);
    await db.insert(issues).values([
      {
        id: alphaIssueId,
        companyId,
        projectId: alphaProjectId,
        title: "Tied touch alpha",
        status: "done",
        priority: "medium",
        issueNumber: 1,
        identifier: "TIE-1",
      },
      {
        id: betaIssueId,
        companyId,
        projectId: betaProjectId,
        title: "Tied touch beta",
        status: "done",
        priority: "medium",
        issueNumber: 2,
        identifier: "TIE-2",
      },
    ]);
    await db.insert(heartbeatRuns).values([
      {
        id: highIdRunId,
        companyId,
        agentId,
        invocationSource: "automation",
        status: "completed",
        startedAt: new Date("2026-11-04T09:00:00.000Z"),
        finishedAt: new Date("2026-11-04T09:30:00.000Z"),
      },
      {
        id: lowIdRunId,
        companyId,
        agentId,
        invocationSource: "automation",
        status: "completed",
        startedAt: new Date("2026-11-04T10:00:00.000Z"),
        finishedAt: new Date("2026-11-04T10:30:00.000Z"),
      },
    ]);

    // IDENTICAL `created_at` within each run -- this is what one transaction's `now()`
    // produces, written explicitly so the tie is a property of the fixture rather than
    // of timing luck. Alpha's row is inserted first in BOTH runs; only the ids mirror.
    const run1TiedAt = new Date("2026-11-04T09:05:00.000Z");
    const run2TiedAt = new Date("2026-11-04T10:05:00.000Z");
    const touch = (
      id: string,
      runId: string,
      entityId: string,
      createdAt: Date,
    ) => ({
      id,
      companyId,
      runId,
      actorType: "agent" as const,
      actorId: agentId,
      agentId,
      action: "issue.checked_out",
      entityType: "issue",
      entityId,
      details: {},
      createdAt,
    });
    await db.insert(activityLog).values([
      touch(run1AlphaActivityId, highIdRunId, alphaIssueId, run1TiedAt),
      touch(run1BetaActivityId, highIdRunId, betaIssueId, run1TiedAt),
      touch(run2AlphaActivityId, lowIdRunId, alphaIssueId, run2TiedAt),
      touch(run2BetaActivityId, lowIdRunId, betaIssueId, run2TiedAt),
    ]);

    // Distinct amounts so the assertions below name WHICH run landed where, rather than
    // only how much landed in total.
    await db.insert(costEvents).values([
      {
        companyId,
        agentId,
        heartbeatRunId: highIdRunId,
        projectId: null,
        provider: "anthropic",
        biller: "anthropic",
        billingType: "metered_api",
        model: "claude-opus-5",
        inputTokens: 1_000,
        outputTokens: 500,
        costCents: 100,
        occurredAt: new Date("2026-11-04T09:10:00.000Z"),
      },
      {
        companyId,
        agentId,
        heartbeatRunId: lowIdRunId,
        projectId: null,
        provider: "anthropic",
        biller: "anthropic",
        billingType: "metered_api",
        model: "claude-opus-5",
        inputTokens: 1_000,
        outputTokens: 500,
        costCents: 7,
        occurredAt: new Date("2026-11-04T10:10:00.000Z"),
      },
    ]);

    const capturedSql: string[] = [];
    const costsWithCapture = costService(withSqlCapture(db, capturedSql));

    const first = await costsWithCapture.byProject(companyId);
    const second = await costsWithCapture.byProject(companyId);

    // Totals are untouched by the tiebreaker -- only WHICH project a tie lands on moves.
    expect(first.reduce((sum, row) => sum + (row.costCents ?? 0), 0)).toBe(107);

    // The mirrored pair. Run 1's HIGH id is alpha's, run 2's is beta's, so the two runs
    // must separate. An untiebroken query presents the same position first in both
    // groups and collapses both runs onto one project -- measured, alpha at 107.
    const firstByProject = new Map(first.map((row) => [row.projectId, row.costCents]));
    expect(firstByProject.get(alphaProjectId)).toBe(100);
    expect(firstByProject.get(betaProjectId)).toBe(7);

    // Stability across repeated calls over identical data -- the flap PEN-5624 names.
    expect(second).toEqual(first);

    const emitted = capturedSql.filter((text) => text.includes("run_project_links"));
    expect(emitted.length).toBeGreaterThan(0);
    for (const text of emitted) {
      expect(text).toContain('order by "activity_log"."run_id", "activity_log"."created_at" desc, "activity_log"."id" desc');
    }
  });

  it("aggregates issue costs across recursive descendants only", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const rootIssueId = randomUUID();
    const childIssueId = randomUUID();
    const grandchildIssueId = randomUUID();
    const harnessIssueId = randomUUID();
    const siblingIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Cost Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values([
      {
        id: rootIssueId,
        companyId,
        title: "Root",
        status: "in_progress",
        priority: "medium",
        issueNumber: 1,
        identifier: "TST-1",
      },
      {
        id: childIssueId,
        companyId,
        parentId: rootIssueId,
        title: "Child",
        status: "done",
        priority: "medium",
        issueNumber: 2,
        identifier: "TST-2",
      },
      {
        id: grandchildIssueId,
        companyId,
        parentId: childIssueId,
        title: "Grandchild",
        status: "done",
        priority: "medium",
        issueNumber: 3,
        identifier: "TST-3",
      },
      {
        id: harnessIssueId,
        companyId,
        parentId: rootIssueId,
        title: "Hidden skill test harness",
        status: "done",
        priority: "medium",
        issueNumber: 5,
        identifier: "TST-5",
        workMode: "skill_test",
        harnessKind: "skill_test",
      },
      {
        id: siblingIssueId,
        companyId,
        title: "Sibling",
        status: "done",
        priority: "medium",
        issueNumber: 4,
        identifier: "TST-4",
      },
    ]);
    await db.insert(costEvents).values([
      {
        companyId,
        agentId,
        issueId: rootIssueId,
        provider: "openai",
        biller: "openai",
        billingType: "metered_api",
        model: "gpt-5",
        inputTokens: 10,
        cachedInputTokens: 1,
        cacheCreationInputTokens: 7,
        outputTokens: 2,
        costCents: 100,
        occurredAt: new Date("2026-04-10T00:00:00.000Z"),
      },
      {
        companyId,
        agentId,
        issueId: childIssueId,
        provider: "openai",
        biller: "openai",
        billingType: "metered_api",
        model: "gpt-5",
        inputTokens: 20,
        cachedInputTokens: 2,
        cacheCreationInputTokens: 8,
        outputTokens: 4,
        costCents: 200,
        occurredAt: new Date("2026-04-10T00:01:00.000Z"),
      },
      {
        companyId,
        agentId,
        issueId: grandchildIssueId,
        provider: "openai",
        biller: "openai",
        billingType: "metered_api",
        model: "gpt-5",
        inputTokens: 30,
        cachedInputTokens: 3,
        cacheCreationInputTokens: 9,
        outputTokens: 6,
        costCents: 300,
        occurredAt: new Date("2026-04-10T00:02:00.000Z"),
      },
      {
        companyId,
        agentId,
        issueId: siblingIssueId,
        provider: "openai",
        biller: "openai",
        billingType: "metered_api",
        model: "gpt-5",
        inputTokens: 40,
        cachedInputTokens: 4,
        cacheCreationInputTokens: 1000,
        outputTokens: 8,
        costCents: 400,
        occurredAt: new Date("2026-04-10T00:03:00.000Z"),
      },
    ]);

    const summary = await costs.issueTreeSummary(companyId, rootIssueId);

    expect(summary).toEqual({
      issueId: rootIssueId,
      issueCount: 3,
      includeDescendants: true,
      costCents: 600,
      // PEN-4515: CONSUMPTION reported beside CASH. These fixtures write no
      // `consumption_cents`, so the column is NULL and the reader's
      // `coalesce(consumption_cents, cost_cents)` fallback must land on the cash figure --
      // which is exactly the pre-migration-0264 row shape this has to keep serving.
      consumptionCents: 600,
      inputTokens: 60,
      cachedInputTokens: 6,
      // BLO-29842: 7+8+9 from the tree; the sibling's 1000 must not leak in, and
      // this total is independent of inputTokens rather than folded into it.
      cacheCreationInputTokens: 24,
      outputTokens: 12,
      runCount: 0,
      runtimeMs: 0,
    });
  });

  it("aggregates run wall-clock duration across the recursive issue tree", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const rootIssueId = randomUUID();
    const childIssueId = randomUUID();
    const grandchildIssueId = randomUUID();
    const harnessIssueId = randomUUID();
    const siblingIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Run Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values([
      {
        id: rootIssueId,
        companyId,
        title: "Root",
        status: "in_progress",
        priority: "medium",
        issueNumber: 1,
        identifier: "TST-1",
      },
      {
        id: childIssueId,
        companyId,
        parentId: rootIssueId,
        title: "Child",
        status: "in_progress",
        priority: "medium",
        issueNumber: 2,
        identifier: "TST-2",
      },
      {
        id: grandchildIssueId,
        companyId,
        parentId: childIssueId,
        title: "Grandchild",
        status: "done",
        priority: "medium",
        issueNumber: 3,
        identifier: "TST-3",
      },
      {
        id: siblingIssueId,
        companyId,
        title: "Sibling",
        status: "done",
        priority: "medium",
        issueNumber: 4,
        identifier: "TST-4",
      },
      {
        id: harnessIssueId,
        companyId,
        parentId: rootIssueId,
        title: "Harness child",
        status: "done",
        priority: "medium",
        workMode: "skill_test",
        harnessKind: "skill_test",
        issueNumber: 5,
        identifier: "TST-5",
      },
    ]);

    const linkedViaContextRunId = randomUUID();
    const linkedViaActivityRunId = randomUUID();
    const grandchildRunId = randomUUID();
    const harnessRunId = randomUUID();
    const siblingRunId = randomUUID();
    const livePartialRunId = randomUUID();

    await db.insert(heartbeatRuns).values([
      // 60s run linked to root via contextSnapshot.issueId
      {
        id: linkedViaContextRunId,
        companyId,
        agentId,
        invocationSource: "on_demand",
        status: "completed",
        startedAt: new Date("2026-04-10T00:00:00.000Z"),
        finishedAt: new Date("2026-04-10T00:01:00.000Z"),
        contextSnapshot: { issueId: rootIssueId },
      },
      // 120s run linked to child via activity_log
      {
        id: linkedViaActivityRunId,
        companyId,
        agentId,
        invocationSource: "on_demand",
        status: "completed",
        startedAt: new Date("2026-04-10T00:05:00.000Z"),
        finishedAt: new Date("2026-04-10T00:07:00.000Z"),
      },
      // 30s run linked to grandchild
      {
        id: grandchildRunId,
        companyId,
        agentId,
        invocationSource: "on_demand",
        status: "completed",
        startedAt: new Date("2026-04-10T00:10:00.000Z"),
        finishedAt: new Date("2026-04-10T00:10:30.000Z"),
        contextSnapshot: { issueId: grandchildIssueId },
      },
      // 45s harness run under root - should be excluded from visible issue tree rollups
      {
        id: harnessRunId,
        companyId,
        agentId,
        invocationSource: "on_demand",
        status: "completed",
        startedAt: new Date("2026-04-10T00:15:00.000Z"),
        finishedAt: new Date("2026-04-10T00:15:45.000Z"),
        contextSnapshot: { issueId: harnessIssueId },
      },
      // sibling run NOT under root – should be excluded
      {
        id: siblingRunId,
        companyId,
        agentId,
        invocationSource: "on_demand",
        status: "completed",
        startedAt: new Date("2026-04-10T00:20:00.000Z"),
        finishedAt: new Date("2026-04-10T00:21:00.000Z"),
        contextSnapshot: { issueId: siblingIssueId },
      },
      // Still-running run on child (no finishedAt) – should contribute (now - startedAt)
      {
        id: livePartialRunId,
        companyId,
        agentId,
        invocationSource: "on_demand",
        status: "running",
        startedAt: new Date(Date.now() - 5_000),
        contextSnapshot: { issueId: childIssueId },
      },
    ]);

    await db.insert(activityLog).values({
      companyId,
      runId: linkedViaActivityRunId,
      actorType: "agent",
      actorId: agentId,
      agentId,
      action: "issue.checked_out",
      entityType: "issue",
      entityId: childIssueId,
      details: {},
    });

    const summary = await costs.issueTreeSummary(companyId, rootIssueId);

    expect(summary.issueCount).toBe(3);
    // 3 finished runs in tree (root, child via activity, grandchild) + 1 live run
    expect(summary.runCount).toBe(4);
    // 60s + 120s + 30s = 210s = 210_000ms from finished runs.
    // Live run adds ~5_000ms; allow some slack so the assertion isn't flaky.
    expect(summary.runtimeMs).toBeGreaterThanOrEqual(210_000 + 4_000);
    expect(summary.runtimeMs).toBeLessThan(210_000 + 60_000);

    // excludeRoot drops the root issue's own runs (the 60s contextSnapshot run)
    // while keeping the child + grandchild runs and any live child run.
    const descendantsOnly = await costs.issueTreeSummary(companyId, rootIssueId, {
      excludeRoot: true,
    });
    expect(descendantsOnly.issueCount).toBe(2);
    expect(descendantsOnly.runCount).toBe(3);
    // 120s + 30s = 150s + ~5s live run
    expect(descendantsOnly.runtimeMs).toBeGreaterThanOrEqual(150_000 + 4_000);
    expect(descendantsOnly.runtimeMs).toBeLessThan(150_000 + 60_000);
  });

  it("aggregates finance event sums above int32 without raising Postgres integer overflow", async () => {
    const companyId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(financeEvents).values([
      {
        companyId,
        biller: "openai",
        eventKind: "invoice",
        amountCents: 2_000_000_000,
        currency: "USD",
        direction: "debit",
        estimated: false,
        occurredAt: new Date("2026-04-10T00:00:00.000Z"),
      },
      {
        companyId,
        biller: "openai",
        eventKind: "invoice",
        amountCents: 2_000_000_000,
        currency: "USD",
        direction: "debit",
        estimated: true,
        occurredAt: new Date("2026-04-11T00:00:00.000Z"),
      },
    ]);

    const range = {
      from: new Date("2026-04-01T00:00:00.000Z"),
      to: new Date("2026-04-15T23:59:59.999Z"),
    };

    const summary = await finance.summary(companyId, range);
    const [byKindRow] = await finance.byKind(companyId, range);

    expect(summary.debitCents).toBe(4_000_000_000);
    expect(summary.estimatedDebitCents).toBe(2_000_000_000);
    expect(byKindRow?.debitCents).toBe(4_000_000_000);
    expect(byKindRow?.netCents).toBe(4_000_000_000);
  });

  // PEN-4902: the route now forwards `agentId`; this is the half that does the
  // filtering. The must-trip control is the unfiltered call in the same test --
  // a filter that was quietly dropped again would make both assertions read
  // the same two rows, and only the comparison catches that.
  it("narrows the agent report to one seat without changing the unfiltered answer", async () => {
    const companyId = randomUUID();
    const agentA = randomUUID();
    const agentB = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    for (const [id, name] of [[agentA, "Seat A"], [agentB, "Seat B"]] as const) {
      await db.insert(agents).values({
        id,
        companyId,
        name,
        role: "engineer",
        status: "active",
        adapterType: "claude_k8s",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
    }

    // B outspends A, so an ignored filter returns B first and `rows[0]` reads
    // as a plausible answer for a request that named A.
    await costs.createEvent(companyId, {
      agentId: agentA,
      provider: "anthropic",
      biller: "anthropic",
      model: "claude-opus-5",
      costCents: 100,
      occurredAt: new Date("2026-11-02T10:00:00.000Z"),
    });
    await costs.createEvent(companyId, {
      agentId: agentB,
      provider: "anthropic",
      biller: "anthropic",
      model: "claude-opus-5",
      costCents: 900,
      occurredAt: new Date("2026-11-02T10:00:00.000Z"),
    });

    const unfiltered = await costs.byAgent(companyId);
    expect(unfiltered).toHaveLength(2);
    expect(unfiltered[0]?.agentId).toBe(agentB);

    const filtered = await costs.byAgent(companyId, undefined, { agentId: agentA });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.agentId).toBe(agentA);
    expect(filtered[0]?.costCents).toBe(100);

    const filteredModel = await costs.byAgentModel(companyId, undefined, { agentId: agentA });
    expect(filteredModel).toHaveLength(1);
    expect(filteredModel[0]?.agentId).toBe(agentA);
  });
});
