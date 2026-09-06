import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  approvals,
  budgetIncidents,
  budgetPolicies,
  companies,
  costEvents,
  createDb,
  projects,
} from "@paperclipai/db";
import { budgetService, buildApprovalPayload } from "../services/budgets.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/activity-log.js", () => ({
  logActivity: mockLogActivity,
}));

type SelectResult = unknown[];

function createDbStub(selectResults: SelectResult[]) {
  const pendingSelects = [...selectResults];
  const selectWhere = vi.fn(async () => pendingSelects.shift() ?? []);
  const selectThen = vi.fn((resolve: (value: unknown[]) => unknown) => Promise.resolve(resolve(pendingSelects.shift() ?? [])));
  const selectOrderBy = vi.fn(async () => pendingSelects.shift() ?? []);
  const selectFrom = vi.fn(() => ({
    where: selectWhere,
    then: selectThen,
    orderBy: selectOrderBy,
  }));
  const select = vi.fn(() => ({
    from: selectFrom,
  }));

  const insertValues = vi.fn();
  const insertReturning = vi.fn(async () => pendingInserts.shift() ?? []);
  const insert = vi.fn(() => ({
    values: insertValues.mockImplementation(() => ({
      returning: insertReturning,
    })),
  }));

  const updateSet = vi.fn();
  const updateWhere = vi.fn(async () => pendingUpdates.shift() ?? []);
  const update = vi.fn(() => ({
    set: updateSet.mockImplementation(() => ({
      where: updateWhere,
    })),
  }));

  const pendingInserts: unknown[][] = [];
  const pendingUpdates: unknown[][] = [];

  return {
    db: {
      select,
      insert,
      update,
    },
    queueInsert: (rows: unknown[]) => {
      pendingInserts.push(rows);
    },
    queueUpdate: (rows: unknown[] = []) => {
      pendingUpdates.push(rows);
    },
    selectWhere,
    insertValues,
    updateSet,
  };
}

describe("budgetService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("buildApprovalPayload", () => {
    const policy = {
      id: "policy-1",
      companyId: "company-1",
      scopeType: "agent",
      scopeId: "agent-1",
      metric: "billed_cents",
      windowKind: "calendar_month_utc",
      amount: 10000,
      warnPercent: 80,
      hardStopEnabled: true,
      notifyEnabled: false,
      isActive: true,
    };

    it("returns a non-empty title naming the scope and the breach (BLO-22705)", () => {
      const payload = buildApprovalPayload({
        policy: policy as any,
        scopeName: "Budget Agent",
        thresholdType: "hard",
        amountObserved: 15000,
        windowStart: new Date("2026-08-01T00:00:00Z"),
        windowEnd: new Date("2026-09-01T00:00:00Z"),
      });

      expect(typeof payload.title).toBe("string");
      expect(payload.title.trim().length).toBeGreaterThan(0);
      expect(payload.title).toContain("Budget Agent");
      expect(payload.title).toContain("billed_cents");
      expect(payload.title).toContain("$150.00");
      expect(payload.title).toContain("$100.00");
    });
  });

  it("creates a hard-stop incident and pauses an agent when spend exceeds a budget", async () => {
    const policy = {
      id: "policy-1",
      companyId: "company-1",
      scopeType: "agent",
      scopeId: "agent-1",
      metric: "billed_cents",
      windowKind: "calendar_month_utc",
      amount: 100,
      warnPercent: 80,
      hardStopEnabled: true,
      notifyEnabled: false,
      isActive: true,
    };

    const dbStub = createDbStub([
      [policy],
      [{ total: 150 }],
      // resolveOpenSoftIncidents() reads the open soft rows so it can withdraw
      // any superseded soft card (BLO-28793); there are none here.
      [],
      [],
      [{
        companyId: "company-1",
        name: "Budget Agent",
        status: "running",
        pauseReason: null,
      }],
      // computeWindowBurn(): first cost event in the window.
      [{ firstEventAt: new Date("2026-08-01T00:00:00Z") }],
    ]);

    dbStub.queueInsert([{
      id: "approval-1",
      companyId: "company-1",
      status: "pending",
    }]);
    dbStub.queueInsert([{
      id: "incident-1",
      companyId: "company-1",
      policyId: "policy-1",
      approvalId: "approval-1",
    }]);
    dbStub.queueUpdate([]);
    const cancelWorkForScope = vi.fn().mockResolvedValue(undefined);

    const service = budgetService(dbStub.db as any, { cancelWorkForScope });
    await service.evaluateCostEvent({
      companyId: "company-1",
      agentId: "agent-1",
      projectId: null,
    } as any);

    expect(dbStub.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: "company-1",
        type: "budget_override_required",
        status: "pending",
        payload: expect.objectContaining({
          title: expect.stringMatching(/\S/),
        }),
      }),
    );
    expect(dbStub.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: "company-1",
        policyId: "policy-1",
        thresholdType: "hard",
        amountLimit: 100,
        amountObserved: 150,
        approvalId: "approval-1",
      }),
    );
    expect(dbStub.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "paused",
        pauseReason: "budget",
        pausedAt: expect.any(Date),
      }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "budget.hard_threshold_crossed",
        entityId: "incident-1",
      }),
    );
    expect(cancelWorkForScope).toHaveBeenCalledWith({
      companyId: "company-1",
      scopeType: "agent",
      scopeId: "agent-1",
    });
  });

  it("blocks new work when an agent hard-stop remains exceeded even if the agent is not paused yet", async () => {
    const agentPolicy = {
      id: "policy-agent-1",
      companyId: "company-1",
      scopeType: "agent",
      scopeId: "agent-1",
      metric: "billed_cents",
      windowKind: "calendar_month_utc",
      amount: 100,
      warnPercent: 80,
      hardStopEnabled: true,
      notifyEnabled: true,
      isActive: true,
    };

    const dbStub = createDbStub([
      [{
        status: "running",
        pauseReason: null,
        companyId: "company-1",
        name: "Budget Agent",
      }],
      [{
        status: "active",
        name: "Paperclip",
      }],
      [],
      [agentPolicy],
      [{ total: 120 }],
    ]);

    const service = budgetService(dbStub.db as any);
    const block = await service.getInvocationBlock("company-1", "agent-1");

    expect(block).toEqual({
      scopeType: "agent",
      scopeId: "agent-1",
      scopeName: "Budget Agent",
      reason: "Agent cannot start because its budget hard-stop is still exceeded.",
    });
  });

  it("surfaces a budget-owned company pause distinctly from a manual pause", async () => {
    const dbStub = createDbStub([
      [{
        status: "idle",
        pauseReason: null,
        companyId: "company-1",
        name: "Budget Agent",
      }],
      [{
        status: "paused",
        pauseReason: "budget",
        name: "Paperclip",
      }],
    ]);

    const service = budgetService(dbStub.db as any);
    const block = await service.getInvocationBlock("company-1", "agent-1");

    expect(block).toEqual({
      scopeType: "company",
      scopeId: "company-1",
      scopeName: "Paperclip",
      reason: "Company is paused because its budget hard-stop was reached.",
    });
  });

  it("uses live observed spend when raising a budget incident", async () => {
    const dbStub = createDbStub([
      [{
        id: "incident-1",
        companyId: "company-1",
        policyId: "policy-1",
        amountObserved: 120,
        approvalId: "approval-1",
      }],
      [{
        id: "policy-1",
        companyId: "company-1",
        scopeType: "company",
        scopeId: "company-1",
        metric: "billed_cents",
        windowKind: "calendar_month_utc",
      }],
      [{ total: 150 }],
    ]);

    const service = budgetService(dbStub.db as any);

    await expect(
      service.resolveIncident(
        "company-1",
        "incident-1",
        { action: "raise_budget_and_resume", amount: 140 },
        "board-user",
      ),
    ).rejects.toThrow("New budget must exceed current observed spend");
  });

  it("syncs company monthly budget when raising and resuming a company incident", async () => {
    const now = new Date();
    const dbStub = createDbStub([
      [{
        id: "incident-1",
        companyId: "company-1",
        policyId: "policy-1",
        scopeType: "company",
        scopeId: "company-1",
        metric: "billed_cents",
        windowKind: "calendar_month_utc",
        windowStart: now,
        windowEnd: now,
        thresholdType: "hard",
        amountLimit: 100,
        amountObserved: 120,
        status: "open",
        approvalId: "approval-1",
        resolvedAt: null,
        createdAt: now,
        updatedAt: now,
      }],
      [{
        id: "policy-1",
        companyId: "company-1",
        scopeType: "company",
        scopeId: "company-1",
        metric: "billed_cents",
        windowKind: "calendar_month_utc",
        amount: 100,
      }],
      [{ total: 120 }],
      // resolveIncident() reads the *other* open incidents for the policy so it
      // can withdraw their cards when the raise closes them (BLO-28793); none here.
      [],
      [{ id: "approval-1", status: "approved" }],
      [{
        companyId: "company-1",
        name: "Paperclip",
        status: "paused",
        pauseReason: "budget",
        pausedAt: now,
      }],
    ]);

    const service = budgetService(dbStub.db as any);
    await service.resolveIncident(
      "company-1",
      "incident-1",
      { action: "raise_budget_and_resume", amount: 175 },
      "board-user",
    );

    expect(dbStub.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        budgetMonthlyCents: 175,
        updatedAt: expect.any(Date),
      }),
    );
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("budgetService release gate enforcement", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-budgets-service-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(budgetIncidents);
    await db.delete(approvals);
    await db.delete(budgetPolicies);
    await db.delete(costEvents);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
    mockLogActivity.mockClear();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createBudgetFixture() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `B${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Budget Agent SECRET_TOKEN_SHOULD_NOT_LEAK",
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
      name: "Budget Project",
      status: "in_progress",
    });

    return { companyId, agentId, projectId };
  }

  async function insertCostEvent(input: {
    companyId: string;
    agentId: string;
    projectId?: string | null;
    costCents: number;
    occurredAt?: Date;
  }) {
    const [event] = await db
      .insert(costEvents)
      .values({
        companyId: input.companyId,
        agentId: input.agentId,
        projectId: input.projectId ?? null,
        provider: "openai",
        biller: "openai",
        billingType: "metered_api",
        model: "gpt-5-release-gate",
        inputTokens: 100,
        cachedInputTokens: 10,
        outputTokens: 20,
        costCents: input.costCents,
        occurredAt: input.occurredAt ?? new Date(),
      })
      .returning();

    return event!;
  }

  it("raises one soft incident per window before hard-stopping and safely logging agent telemetry", async () => {
    const { companyId, agentId } = await createBudgetFixture();
    const cancelWorkForScope = vi.fn().mockResolvedValue(undefined);
    const service = budgetService(db, { cancelWorkForScope });
    const [policy] = await db
      .insert(budgetPolicies)
      .values({
        companyId,
        scopeType: "agent",
        scopeId: agentId,
        metric: "billed_cents",
        windowKind: "calendar_month_utc",
        amount: 100,
        warnPercent: 80,
        hardStopEnabled: true,
        notifyEnabled: true,
        isActive: true,
      })
      .returning();

    const softEvent = await insertCostEvent({ companyId, agentId, costCents: 80 });
    await service.evaluateCostEvent(softEvent);
    await service.evaluateCostEvent(softEvent);

    let incidentRows = await db
      .select()
      .from(budgetIncidents);
    expect(incidentRows.filter((incident) => incident.thresholdType === "soft")).toHaveLength(1);
    const softIncident = incidentRows.find((incident) => incident.thresholdType === "soft")!;
    expect(softIncident).toMatchObject({
      companyId,
      policyId: policy!.id,
      scopeType: "agent",
      scopeId: agentId,
      thresholdType: "soft",
      amountLimit: 100,
      amountObserved: 80,
      status: "open",
    });

    // BLO-28793: the warn threshold now files the board card, while the scope is
    // still running and there is still cap left to raise. Two evaluations, one card.
    expect(softIncident.approvalId).toBeTruthy();
    const softApprovals = await db.select().from(approvals);
    expect(softApprovals).toHaveLength(1);
    const softApproval = softApprovals[0]!;
    expect(softApproval).toMatchObject({
      companyId,
      type: "budget_override_required",
      status: "pending",
      idempotencyKey: `budget:${policy!.id}:soft:${softIncident.windowStart.toISOString()}`,
    });
    const softPayload = softApproval.payload as Record<string, unknown>;
    expect(String(softPayload.title ?? "").trim().length).toBeGreaterThan(0);
    expect(softPayload).toMatchObject({
      thresholdType: "soft",
      budgetAmount: 100,
      observedAmount: 80,
      remainingAmount: 20,
    });
    // Burn and runway are what make the card decidable: 80 spent, 20 left.
    expect(softPayload.observedDailyBurn).toBeGreaterThan(0);
    expect(typeof softPayload.projectedExhaustionAt).toBe("string");
    expect(Date.parse(softPayload.projectedExhaustionAt as string)).toBeGreaterThan(Date.now());
    expect(softPayload.projectedDaysRemaining).toBeGreaterThan(0);

    const [agentBeforeHardStop] = await db
      .select({ status: agents.status, pauseReason: agents.pauseReason })
      .from(agents);
    expect(agentBeforeHardStop).toEqual({ status: "active", pauseReason: null });

    const hardEvent = await insertCostEvent({ companyId, agentId, costCents: 25 });
    await service.evaluateCostEvent(hardEvent);
    await service.evaluateCostEvent(hardEvent);

    incidentRows = await db
      .select()
      .from(budgetIncidents);
    expect(incidentRows.filter((incident) => incident.thresholdType === "soft")).toHaveLength(1);
    expect(incidentRows.filter((incident) => incident.thresholdType === "hard")).toHaveLength(1);
    expect(incidentRows.find((incident) => incident.thresholdType === "soft")).toMatchObject({
      status: "resolved",
    });
    expect(incidentRows.find((incident) => incident.thresholdType === "hard")).toMatchObject({
      amountLimit: 100,
      amountObserved: 105,
      status: "open",
    });

    // Crossing 100% is unchanged: a hard card is filed and the scope pauses. What
    // is new is that the now-superseded soft card is withdrawn rather than left
    // pending forever -- nothing resolves it once its incident is closed, because
    // resolveOpenIncidentsForPolicy() only touches *open* incidents (BLO-28793).
    const allApprovals = await db.select().from(approvals);
    expect(allApprovals).toHaveLength(2);
    const approval = allApprovals.find(
      (row) => (row.payload as Record<string, unknown>).thresholdType === "hard",
    );
    expect(approval).toMatchObject({
      companyId,
      type: "budget_override_required",
      status: "pending",
    });
    expect(String((approval!.payload as Record<string, unknown>).title ?? "").trim().length)
      .toBeGreaterThan(0);

    const supersededSoft = allApprovals.find((row) => row.id === softApproval.id)!;
    expect(supersededSoft).toMatchObject({ status: "withdrawn" });
    expect(supersededSoft.decisionNote).toMatch(/[Ss]uperseded/);

    const [agentAfterHardStop] = await db
      .select({ status: agents.status, pauseReason: agents.pauseReason, pausedAt: agents.pausedAt })
      .from(agents);
    expect(agentAfterHardStop).toMatchObject({ status: "paused", pauseReason: "budget" });
    expect(agentAfterHardStop?.pausedAt).toBeInstanceOf(Date);
    expect(cancelWorkForScope).toHaveBeenCalledTimes(2);
    expect(cancelWorkForScope).toHaveBeenCalledWith({ companyId, scopeType: "agent", scopeId: agentId });

    const block = await service.getInvocationBlock(companyId, agentId);
    expect(block).toEqual({
      scopeType: "agent",
      scopeId: agentId,
      scopeName: "Budget Agent SECRET_TOKEN_SHOULD_NOT_LEAK",
      reason: "Agent is paused because its budget hard-stop was reached.",
    });

    const telemetryCalls = mockLogActivity.mock.calls.map(([, input]) => input);
    expect(telemetryCalls.filter((call) => call.action === "budget.soft_threshold_crossed")).toHaveLength(1);
    expect(telemetryCalls.filter((call) => call.action === "budget.hard_threshold_crossed")).toHaveLength(1);
    expect(telemetryCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "budget.soft_threshold_crossed",
          entityType: "budget_incident",
          details: expect.objectContaining({
            scopeType: "agent",
            scopeId: agentId,
            amountObserved: 80,
            amountLimit: 100,
          }),
        }),
        expect.objectContaining({
          action: "budget.hard_threshold_crossed",
          entityType: "budget_incident",
          details: expect.objectContaining({
            scopeType: "agent",
            scopeId: agentId,
            amountObserved: 105,
            amountLimit: 100,
            approvalId: approval!.id,
          }),
        }),
      ]),
    );
    for (const call of telemetryCalls) {
      expect(JSON.stringify(call.details)).not.toContain("SECRET_TOKEN_SHOULD_NOT_LEAK");
      expect(call.details).not.toHaveProperty("prompt");
      expect(call.details).not.toHaveProperty("message");
    }
  });

  it("files the override card at warnPercent with multi-day runway, once, while the scope is still running (BLO-28793)", async () => {
    const { companyId, agentId } = await createBudgetFixture();
    const cancelWorkForScope = vi.fn().mockResolvedValue(undefined);
    const service = budgetService(db, { cancelWorkForScope });

    // The 2026-08-18 CTO wall, to scale: a $56,000 cap, warn at 80% = $44,800,
    // leaving $11,200. A `lifetime` window is deliberate -- its windowStart is the
    // 1970 epoch, so a burn rate measured against the nominal window would spread
    // this spend over 56 years and report centuries of runway on the day before
    // the wall. Burn is measured from the first counted cost event instead.
    const capCents = 5_600_000;
    const [policy] = await db
      .insert(budgetPolicies)
      .values({
        companyId,
        scopeType: "agent",
        scopeId: agentId,
        metric: "billed_cents",
        windowKind: "lifetime",
        amount: capCents,
        warnPercent: 80,
        hardStopEnabled: true,
        notifyEnabled: true,
        isActive: true,
      })
      .returning();

    const fortyDaysAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    await insertCostEvent({ companyId, agentId, costCents: 4_479_999, occurredAt: fortyDaysAgo });
    // Crosses warn ($44,800) and stops there -- still $11,200 under the cap.
    const warnEvent = await insertCostEvent({ companyId, agentId, costCents: 1 });
    await service.evaluateCostEvent(warnEvent);

    const incidentRows = await db
      .select()
      .from(budgetIncidents)
      .where(eq(budgetIncidents.companyId, companyId));
    expect(incidentRows).toHaveLength(1);
    expect(incidentRows[0]).toMatchObject({ thresholdType: "soft", status: "open" });

    const cards = await db.select().from(approvals).where(eq(approvals.companyId, companyId));
    expect(cards).toHaveLength(1);
    const payload = cards[0]!.payload as Record<string, unknown>;

    expect(cards[0]).toMatchObject({ type: "budget_override_required", status: "pending" });
    expect(String(payload.title ?? "").trim().length).toBeGreaterThan(0);
    expect(payload.title).toContain("warn threshold");
    expect(payload).toMatchObject({
      thresholdType: "soft",
      budgetAmount: capCents,
      observedAmount: 4_480_000,
      remainingAmount: 1_120_000,
    });

    // ~$1,120/day over 40 days, so ~10 days of runway -- against a measured ~5h
    // board decision latency. That margin is the entire point of the change.
    expect(payload.observedDailyBurn).toBeCloseTo(112_000, -3);
    expect(payload.projectedDaysRemaining as number).toBeGreaterThanOrEqual(9);
    expect(payload.projectedDaysRemaining as number).toBeLessThan(11);
    const projectedAt = Date.parse(payload.projectedExhaustionAt as string);
    expect(projectedAt).toBeGreaterThan(Date.now() + 8 * 24 * 60 * 60 * 1000);

    // The scope keeps running: this is a warning, not the hard stop.
    const [agentRow] = await db
      .select({ status: agents.status, pauseReason: agents.pauseReason })
      .from(agents)
      .where(eq(agents.id, agentId));
    expect(agentRow).toMatchObject({ status: "active", pauseReason: null });
    expect(cancelWorkForScope).not.toHaveBeenCalled();

    // Idempotency: re-evaluating the same policy in the same window files nothing
    // more, including after further spend that stays inside the warn band.
    await service.evaluateCostEvent(warnEvent);
    await service.evaluateCostEvent(warnEvent);
    const moreSpend = await insertCostEvent({ companyId, agentId, costCents: 500_000 });
    await service.evaluateCostEvent(moreSpend);

    const cardsAfter = await db.select().from(approvals).where(eq(approvals.companyId, companyId));
    expect(cardsAfter).toHaveLength(1);
    expect(cardsAfter[0]!.id).toBe(cards[0]!.id);
    expect(cardsAfter[0]!.status).toBe("pending");
    expect(cardsAfter[0]!.idempotencyKey).toBe(
      `budget:${policy!.id}:soft:${incidentRows[0]!.windowStart.toISOString()}`,
    );
  });

  it("settles the warn card on every path that closes its incident, and never rewrites a decided card (BLO-28793 review)", async () => {
    const { companyId, agentId } = await createBudgetFixture();
    const cancelWorkForScope = vi.fn().mockResolvedValue(undefined);
    const service = budgetService(db, { cancelWorkForScope });

    const [policy] = await db
      .insert(budgetPolicies)
      .values({
        companyId,
        scopeType: "agent",
        scopeId: agentId,
        metric: "billed_cents",
        windowKind: "calendar_month_utc",
        amount: 100_000,
        warnPercent: 80,
        hardStopEnabled: true,
        notifyEnabled: true,
        isActive: true,
      })
      .returning();

    const warnEvent = await insertCostEvent({ companyId, agentId, costCents: 85_000 });
    await service.evaluateCostEvent(warnEvent);

    const softCards = await db.select().from(approvals).where(eq(approvals.companyId, companyId));
    expect(softCards).toHaveLength(1);
    expect(softCards[0]).toMatchObject({ status: "pending" });

    // A non-board caller reaches upsertPolicy with actorUserId === null -- the
    // agent-update route in routes/costs.ts passes it literally. That branch
    // resolves every open incident for the policy, so before this fix it closed
    // the incident and returned before touching the card, stranding a `pending`
    // approval that no remaining open incident could ever resolve.
    await service.upsertPolicy(
      companyId,
      {
        scopeType: "agent",
        scopeId: agentId,
        metric: "billed_cents",
        windowKind: "calendar_month_utc",
        amount: 500_000,
        warnPercent: 80,
        hardStopEnabled: true,
        notifyEnabled: true,
        isActive: true,
      } as any,
      null,
    );

    const afterUpsert = await db.select().from(approvals).where(eq(approvals.companyId, companyId));
    expect(afterUpsert).toHaveLength(1);
    expect(afterUpsert[0]).toMatchObject({ status: "withdrawn" });
    expect(afterUpsert[0]!.decisionNote).toMatch(/policy was updated/);
    const [resolvedSoft] = await db
      .select()
      .from(budgetIncidents)
      .where(eq(budgetIncidents.companyId, companyId));
    expect(resolvedSoft).toMatchObject({ status: "resolved" });
  });

  it("does not rewrite a withdrawn card when a stale client decides its closed incident (BLO-28793 review)", async () => {
    const { companyId, agentId } = await createBudgetFixture();
    const cancelWorkForScope = vi.fn().mockResolvedValue(undefined);
    const service = budgetService(db, { cancelWorkForScope });

    await db.insert(budgetPolicies).values({
      companyId,
      scopeType: "agent",
      scopeId: agentId,
      metric: "billed_cents",
      windowKind: "calendar_month_utc",
      amount: 100_000,
      warnPercent: 80,
      hardStopEnabled: true,
      notifyEnabled: true,
      isActive: true,
    });

    // Warn first, then the hard cap: the soft card is withdrawn as superseded and
    // the hard card takes its place.
    const warnEvent = await insertCostEvent({ companyId, agentId, costCents: 85_000 });
    await service.evaluateCostEvent(warnEvent);
    const hardEvent = await insertCostEvent({ companyId, agentId, costCents: 30_000 });
    await service.evaluateCostEvent(hardEvent);

    const allCards = await db.select().from(approvals).where(eq(approvals.companyId, companyId));
    expect(allCards).toHaveLength(2);
    const supersededSoft = allCards.find(
      (row) => (row.payload as Record<string, unknown>).thresholdType === "soft",
    )!;
    expect(supersededSoft).toMatchObject({ status: "withdrawn" });
    expect(supersededSoft.decisionNote).toMatch(/[Ss]uperseded/);
    const supersededAt = supersededSoft.decidedAt;
    const hardCard = allCards.find(
      (row) => (row.payload as Record<string, unknown>).thresholdType === "hard",
    )!;
    expect(hardCard).toMatchObject({ status: "pending" });

    const staleSoftIncident = (await db
      .select()
      .from(budgetIncidents)
      .where(eq(budgetIncidents.companyId, companyId)))
      .find((row) => row.thresholdType === "soft")!;
    expect(staleSoftIncident).toMatchObject({ status: "resolved" });

    // A stale client submits a decision against the already-resolved soft
    // incident. resolveIncident fetches by id with no status filter, so this
    // still runs -- but it must not rewrite the withdrawn card as `approved`.
    await service.resolveIncident(
      companyId,
      staleSoftIncident.id,
      { action: "raise_budget_and_resume", amount: 900_000, decisionNote: "stale submit" } as any,
      "user-stale",
    );

    const afterStale = await db.select().from(approvals).where(eq(approvals.companyId, companyId));
    const softAfterStale = afterStale.find((row) => row.id === supersededSoft.id)!;
    expect(softAfterStale.status).toBe("withdrawn");
    expect(softAfterStale.decisionNote).toMatch(/[Ss]uperseded/);
    expect(softAfterStale.decisionNote).not.toMatch(/stale submit/);
    expect(softAfterStale.decidedAt).toEqual(supersededAt);

    // The raise closed the open hard incident as a side effect, so its card is
    // withdrawn rather than left pending against a resolved incident. No
    // undecidable card survives on any path.
    const hardAfterStale = afterStale.find((row) => row.id === hardCard.id)!;
    expect(hardAfterStale.status).toBe("withdrawn");
    expect(afterStale.filter((row) => row.status === "pending")).toHaveLength(0);
  });

  it("files no warn card when one cost event jumps straight past the hard cap (BLO-28793 review)", async () => {
    const { companyId, agentId } = await createBudgetFixture();
    const cancelWorkForScope = vi.fn().mockResolvedValue(undefined);
    const service = budgetService(db, { cancelWorkForScope });

    await db.insert(budgetPolicies).values({
      companyId,
      scopeType: "agent",
      scopeId: agentId,
      metric: "billed_cents",
      windowKind: "calendar_month_utc",
      amount: 100_000,
      warnPercent: 80,
      hardStopEnabled: true,
      notifyEnabled: true,
      isActive: true,
    });

    // Zero to over-cap in a single event: the warn threshold is crossed in the
    // same evaluation that trips the hard stop. Filing a warn card here would
    // only be withdrawn two statements later, leaving an approvals row and a
    // pair of activity entries for a card no board member could ever see.
    const jumpEvent = await insertCostEvent({ companyId, agentId, costCents: 150_000 });
    await service.evaluateCostEvent(jumpEvent);

    const cards = await db.select().from(approvals).where(eq(approvals.companyId, companyId));
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ type: "budget_override_required", status: "pending" });
    expect((cards[0]!.payload as Record<string, unknown>).thresholdType).toBe("hard");

    const incidents = await db
      .select()
      .from(budgetIncidents)
      .where(eq(budgetIncidents.companyId, companyId));
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({ thresholdType: "hard", status: "open" });

    const [agentRow] = await db
      .select({ status: agents.status, pauseReason: agents.pauseReason })
      .from(agents)
      .where(eq(agents.id, agentId));
    expect(agentRow).toMatchObject({ status: "paused", pauseReason: "budget" });
  });

  it("still files the warn card over cap when the hard stop is disabled (BLO-28793 review)", async () => {
    const { companyId, agentId } = await createBudgetFixture();
    const service = budgetService(db, { cancelWorkForScope: vi.fn().mockResolvedValue(undefined) });

    await db.insert(budgetPolicies).values({
      companyId,
      scopeType: "agent",
      scopeId: agentId,
      metric: "billed_cents",
      windowKind: "calendar_month_utc",
      amount: 100_000,
      warnPercent: 80,
      hardStopEnabled: false,
      notifyEnabled: true,
      isActive: true,
    });

    // The skip above is gated on "the hard branch will fire", not on
    // "observed >= amount". With hardStopEnabled false nothing else notifies,
    // so the warn card is the only signal that this scope blew its cap.
    const overCapEvent = await insertCostEvent({ companyId, agentId, costCents: 150_000 });
    await service.evaluateCostEvent(overCapEvent);

    const cards = await db.select().from(approvals).where(eq(approvals.companyId, companyId));
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ status: "pending" });
    expect((cards[0]!.payload as Record<string, unknown>).thresholdType).toBe("soft");

    const [agentRow] = await db
      .select({ status: agents.status, pauseReason: agents.pauseReason })
      .from(agents)
      .where(eq(agents.id, agentId));
    expect(agentRow).toMatchObject({ status: "active", pauseReason: null });
  });

  it("hard-stops project work until a valid budget raise resumes it and overview reconciles ledger spend", async () => {
    const { companyId, agentId, projectId } = await createBudgetFixture();
    const cancelWorkForScope = vi.fn().mockResolvedValue(undefined);
    const service = budgetService(db, { cancelWorkForScope });
    await db.insert(budgetPolicies).values({
      companyId,
      scopeType: "project",
      scopeId: projectId,
      metric: "billed_cents",
      windowKind: "lifetime",
      amount: 100,
      warnPercent: 75,
      hardStopEnabled: true,
      notifyEnabled: true,
      isActive: true,
    });

    const event = await insertCostEvent({ companyId, agentId, projectId, costCents: 125 });
    await service.evaluateCostEvent(event);
    await service.evaluateCostEvent(event);

    const incidentRows = await db
      .select()
      .from(budgetIncidents);
    expect(incidentRows.filter((incident) => incident.thresholdType === "hard")).toHaveLength(1);
    const hardIncident = incidentRows.find((incident) => incident.thresholdType === "hard")!;
    expect(hardIncident).toMatchObject({
      companyId,
      scopeType: "project",
      scopeId: projectId,
      amountLimit: 100,
      amountObserved: 125,
      status: "open",
    });

    const [projectAfterHardStop] = await db
      .select({ pauseReason: projects.pauseReason, pausedAt: projects.pausedAt })
      .from(projects);
    expect(projectAfterHardStop?.pauseReason).toBe("budget");
    expect(projectAfterHardStop?.pausedAt).toBeInstanceOf(Date);
    expect(cancelWorkForScope).toHaveBeenCalledWith({ companyId, scopeType: "project", scopeId: projectId });

    const overviewWhileBlocked = await service.overview(companyId);
    expect(overviewWhileBlocked.pausedProjectCount).toBe(1);
    expect(overviewWhileBlocked.pendingApprovalCount).toBe(1);
    expect(overviewWhileBlocked.policies[0]).toMatchObject({
      scopeType: "project",
      scopeId: projectId,
      amount: 100,
      observedAmount: 125,
      remainingAmount: 0,
      utilizationPercent: 125,
      status: "hard_stop",
      paused: true,
      pauseReason: "budget",
    });
    expect(overviewWhileBlocked.activeIncidents).toHaveLength(1);

    await expect(
      service.resolveIncident(
        companyId,
        hardIncident.id,
        { action: "raise_budget_and_resume", amount: 125 },
        "board-user",
      ),
    ).rejects.toThrow("New budget must exceed current observed spend");

    expect(await service.getInvocationBlock(companyId, agentId, { projectId })).toEqual({
      scopeType: "project",
      scopeId: projectId,
      scopeName: "Budget Project",
      reason: "Project cannot start work because its budget hard-stop is still exceeded.",
    });

    const resolved = await service.resolveIncident(
      companyId,
      hardIncident.id,
      { action: "raise_budget_and_resume", amount: 175, decisionNote: "Approved release-gate budget raise." },
      "board-user",
    );
    expect(resolved).toMatchObject({ status: "resolved", approvalStatus: "approved" });

    const [projectAfterResume] = await db
      .select({ pauseReason: projects.pauseReason, pausedAt: projects.pausedAt })
      .from(projects);
    expect(projectAfterResume).toEqual({ pauseReason: null, pausedAt: null });
    expect(await service.getInvocationBlock(companyId, agentId, { projectId })).toBeNull();

    const overviewAfterResume = await service.overview(companyId);
    expect(overviewAfterResume.pausedProjectCount).toBe(0);
    expect(overviewAfterResume.pendingApprovalCount).toBe(0);
    expect(overviewAfterResume.policies[0]).toMatchObject({
      scopeType: "project",
      scopeId: projectId,
      amount: 175,
      observedAmount: 125,
      remainingAmount: 50,
      utilizationPercent: expect.closeTo(71.43, 2),
      status: "ok",
      paused: false,
      pauseReason: null,
    });
    expect(overviewAfterResume.activeIncidents).toHaveLength(0);
  });
});
