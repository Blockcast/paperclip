import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
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
  // Awaitable for `await db.select().from().where()`, and also `.orderBy()`-able
  // for `.from().where().orderBy()` -- one query either way, so `.orderBy()`
  // replays the rows this `.where()` already shifted rather than consuming a
  // second queued result.
  const selectWhere = vi.fn(() => {
    const rows = pendingSelects.shift() ?? [];
    const result = Promise.resolve(rows) as Promise<unknown[]> & {
      orderBy: () => Promise<unknown[]>;
    };
    result.orderBy = async () => rows;
    return result;
  });
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
      // createIncidentIfNeeded claims the incident row with onConflictDoNothing so the
      // partial unique index serializes concurrent passes (BLO-37275).
      onConflictDoNothing: () => ({ returning: insertReturning }),
    })),
  }));

  const updateSet = vi.fn();
  // Awaitable for `await db.update().set().where()`, and also `.returning()`-able for
  // the approval-linking update in createIncidentIfNeeded.
  const updateWhere = vi.fn(() => {
    const rows = pendingUpdates.shift() ?? [];
    const result = Promise.resolve(rows) as Promise<unknown[]> & { returning: () => Promise<unknown[]> };
    result.returning = async () => rows;
    return result;
  });
  const update = vi.fn(() => ({
    set: updateSet.mockImplementation(() => ({
      where: updateWhere,
    })),
  }));

  const pendingInserts: unknown[][] = [];
  const pendingUpdates: unknown[][] = [];

  const db: Record<string, unknown> = {
    select,
    insert,
    update,
  };
  // createIncidentIfNeeded writes the incident and its card in one transaction; the
  // stub runs the callback inline against itself, which is all these tests observe.
  db.transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(db));

  return {
    db,
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

    it("tells the board that a kept pause lifts itself when the cap stops binding (PEN-1972)", () => {
      // Since PEN-1972 a budget pause clears at the next invocation check once
      // the hard stop stops binding, so "keep the scope paused" is a decision
      // about the current condition, not an indefinite one. The board is the
      // party choosing it, so the card has to disclose the difference rather
      // than let the click imply a durability it does not have.
      const hard = buildApprovalPayload({
        policy: policy as any,
        scopeName: "Budget Agent",
        thresholdType: "hard",
        amountObserved: 15000,
        windowStart: new Date("2026-08-01T00:00:00Z"),
        windowEnd: new Date("2026-09-01T00:00:00Z"),
      });

      expect(hard.guidance).toContain("keep the scope paused");
      expect(hard.guidance).toContain("only while the cap still binds");
      expect(hard.guidance).toContain("falls back under it");
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
      // hardStopForgivenSince(): no board has resumed this scope without
      // raising its cap in this window, so no grant and the hard stop is
      // measured against the full window total (PEN-4742).
      [],
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

    // Incident first, then its card: createIncidentIfNeeded claims the incident row
    // up front so the partial unique index serializes concurrent passes, and links
    // the card to it afterwards (BLO-37275).
    dbStub.queueInsert([{
      id: "incident-1",
      companyId: "company-1",
      policyId: "policy-1",
      approvalId: null,
    }]);
    dbStub.queueInsert([{
      id: "approval-1",
      companyId: "company-1",
      status: "pending",
    }]);
    // The linking update, then the agent pause.
    dbStub.queueUpdate([{
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
        // Claimed before the card exists; the link is the update asserted below.
        approvalId: null,
      }),
    );
    expect(dbStub.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ approvalId: "approval-1" }),
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
      // hardStopForgivenSince(): no board has resumed this scope without
      // raising its cap in this window, so no grant and the hard stop is
      // measured against the full window total (PEN-4742).
      [],
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
    const companyPolicy = {
      id: "policy-company-1",
      companyId: "company-1",
      scopeType: "company",
      scopeId: "company-1",
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
      [companyPolicy],
      // hardStopForgivenSince(): no board has resumed this scope without
      // raising its cap in this window, so no grant and the hard stop is
      // measured against the full window total (PEN-4742).
      [],
      // Still over cap in the current window, so the pause is still earned.
      [{ total: 120 }],
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

  it("keeps blocking a manually paused company without re-checking its budget", async () => {
    // A manual pause is not the budget service's to lift, so it must never reach
    // the re-evaluation path -- hence no policy or observed-spend rows stubbed.
    const dbStub = createDbStub([
      [{
        status: "idle",
        pauseReason: null,
        companyId: "company-1",
        name: "Budget Agent",
      }],
      [{
        status: "paused",
        pauseReason: "manual",
        name: "Paperclip",
      }],
    ]);

    const service = budgetService(dbStub.db as any);

    expect(await service.getInvocationBlock("company-1", "agent-1")).toEqual({
      scopeType: "company",
      scopeId: "company-1",
      scopeName: "Paperclip",
      reason: "Company is paused and cannot start new work.",
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
        // NOT NULL DEFAULT true in the schema, so a row without it is not a
        // state the database can produce. It became load-bearing here with
        // PEN-4742: the guard is now skipped where it cannot bite, and a cap
        // with no hard stop behind it is exactly such a case.
        hardStopEnabled: true,
        amount: 100,
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
  });

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

  it("files exactly one card when two passes cross the same threshold concurrently (BLO-37275)", async () => {
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
        // Warn only: the hard path resolves and re-files incidents, which would
        // measure a different race than the one this pins.
        hardStopEnabled: false,
        notifyEnabled: true,
        isActive: true,
      })
      .returning();

    const softEvent = await insertCostEvent({ companyId, agentId, costCents: 80 });

    // Concurrent, NOT sequential -- the sequential double-evaluate above already
    // passes on the unfixed code, because the unlocked `existing` read catches the
    // second pass. Two passes in flight together both clear that read before either
    // writes, which is the 126 ms production race (cards 1b2264ec / 3c254101).
    // `allSettled` so the unfixed failure reads as the count assertion below rather
    // than as an opaque unique-violation rejection: unfixed, both passes commit a
    // card and the loser then dies on budget_incidents_policy_window_threshold_idx.
    const outcomes = await Promise.allSettled([
      service.evaluateCostEvent(softEvent),
      service.evaluateCostEvent(softEvent),
    ]);

    // Card count first: the defect is the duplicate CARD, and the rejection asserted
    // below is only its side effect. Unfixed, this reads "expected 2 to be 1" -- a
    // server-filed card has both requester columns null, so withdraw (requester-scoped)
    // is board-only and a duplicate here is unclearable by any agent, not just untidy.
    const approvalRows = await db.select().from(approvals).where(eq(approvals.companyId, companyId));
    expect(approvalRows).toHaveLength(1);
    expect(approvalRows[0]).toMatchObject({
      type: "budget_override_required",
      status: "pending",
      requestedByAgentId: null,
      requestedByUserId: null,
    });

    const incidentRows = await db
      .select()
      .from(budgetIncidents)
      .where(eq(budgetIncidents.companyId, companyId));
    expect(incidentRows).toHaveLength(1);
    expect(incidentRows[0]).toMatchObject({ thresholdType: "soft", status: "open" });
    expect(approvalRows[0]!.idempotencyKey).toBe(
      `budget:${policy!.id}:soft:${incidentRows[0]!.windowStart.toISOString()}`,
    );
    // The surviving incident still points at the surviving card: the losing pass
    // must not leave the winner's incident unlinked.
    expect(incidentRows[0]!.approvalId).toBe(approvalRows[0]!.id);

    // Unfixed, the loser commits its card and only then collides on
    // budget_incidents_policy_window_threshold_idx, so this reads ["fulfilled","rejected"].
    expect(outcomes.map((outcome) => outcome.status)).toEqual(["fulfilled", "fulfilled"]);
  });

  it("claims a fresh incident when the threshold is re-crossed after a dismissal (BLO-37275)", async () => {
    const { companyId, agentId } = await createBudgetFixture();
    const cancelWorkForScope = vi.fn().mockResolvedValue(undefined);
    const service = budgetService(db, { cancelWorkForScope });
    await db.insert(budgetPolicies).values({
      companyId,
      scopeType: "agent",
      scopeId: agentId,
      metric: "billed_cents",
      windowKind: "calendar_month_utc",
      amount: 100,
      warnPercent: 80,
      hardStopEnabled: false,
      notifyEnabled: true,
      isActive: true,
    });

    const softEvent = await insertCostEvent({ companyId, agentId, costCents: 80 });
    await service.evaluateCostEvent(softEvent);

    // The board dismisses it, the scope keeps burning, and the threshold is crossed
    // again. `budget_incidents_policy_window_threshold_idx` is partial on
    // `status <> 'dismissed'`, so the dismissed row sits outside it and must not
    // arbitrate the next claim. The claim's ON CONFLICT restates that predicate, so
    // this is the one path where the two copies drifting apart would show up: a
    // predicate that dropped the `<> 'dismissed'` term would match the dismissed row,
    // swallow the insert, and leave the re-crossing permanently uncarded.
    //
    // Driven through `resolveIncident` rather than a raw status write: the handler
    // also rejects the card, and that coupling is the point -- a raw write reaches a
    // state production cannot (see the card-status assertion below).
    const [dismissed] = await db
      .select()
      .from(budgetIncidents)
      .where(eq(budgetIncidents.companyId, companyId));
    await service.resolveIncident(
      companyId,
      dismissed!.id,
      { action: "keep_paused", decisionNote: "not this one" },
      "user-board",
    );
    await service.evaluateCostEvent(softEvent);

    const incidentRows = await db
      .select()
      .from(budgetIncidents)
      .where(eq(budgetIncidents.companyId, companyId));
    expect(incidentRows.map((row) => row.status).sort()).toEqual(["dismissed", "open"]);

    // A fresh incident means a fresh card: the dismissal is the board saying "not
    // this one", not "stop telling me about this policy for the rest of the window".
    const cards = await db.select().from(approvals).where(eq(approvals.companyId, companyId));
    expect(cards).toHaveLength(2);
    // Count alone does not say the two cards are *safe*. Both carry the same
    // idempotencyKey and both have a null requester, so if both were pending the
    // board would hold two identical, agent-unwithdrawable cards for one
    // policy-window -- the BLO-37275 defect re-entering through the dismissal path.
    // What makes two rows correct here is that exactly one is outstanding.
    expect(new Set(cards.map((card) => card.idempotencyKey)).size).toBe(1);
    expect(cards.map((card) => card.status).sort()).toEqual(["pending", "rejected"]);
    // Pin *which* card, not just that it is one of the two: `toContain` would also
    // pass if the reopened incident still pointed at the rejected card, which is the
    // precise state the paragraph above says must not happen.
    const reopened = incidentRows.find((row) => row.status === "open");
    expect(reopened!.approvalId).toBe(cards.find((card) => card.status === "pending")!.id);
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

    // Mirror direction (#2190 review): the same stale client submits `keep_paused`
    // against that same resolved incident. The dismiss branch used to update by id
    // with no status filter, so this rewrote a decided crossing to `dismissed` and
    // overwrote its `resolvedAt` -- while the `pending` guard in `markApprovalStatus`
    // left the card as it was, producing a dismissed incident with a non-rejected
    // card for a scope the dismiss branch never paused.
    const resolvedAtBeforeKeepPaused = (await db
      .select()
      .from(budgetIncidents)
      .where(eq(budgetIncidents.id, staleSoftIncident.id))
      .then((rows) => rows[0]!)).resolvedAt;
    const afterKeepPaused = await service.resolveIncident(
      companyId,
      staleSoftIncident.id,
      { action: "keep_paused", decisionNote: "stale keep_paused" },
      "user-stale",
    );
    expect(afterKeepPaused).toMatchObject({ id: staleSoftIncident.id, status: "resolved" });
    const softRowAfterKeepPaused = await db
      .select()
      .from(budgetIncidents)
      .where(eq(budgetIncidents.id, staleSoftIncident.id))
      .then((rows) => rows[0]!);
    expect(softRowAfterKeepPaused.status).toBe("resolved");
    expect(softRowAfterKeepPaused.resolvedAt).toEqual(resolvedAtBeforeKeepPaused);
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

  // BLO-28908. `createIncidentIfNeeded` used to suppress on any non-`dismissed`
  // row for the (policy, window, threshold) triple, and `raise_budget_and_resume`
  // sets exactly `resolved` -- so the healthy response to a card silenced that
  // policy for the rest of the window on both thresholds. A `lifetime` window is
  // used throughout so `windowStart` is a fixed value for the whole test and the
  // suppression key cannot roll over mid-run.

  it("re-arms the warn card after a cap raise inside the same window (BLO-28908)", async () => {
    const { companyId, agentId } = await createBudgetFixture();
    const cancelWorkForScope = vi.fn().mockResolvedValue(undefined);
    const service = budgetService(db, { cancelWorkForScope });
    await db.insert(budgetPolicies).values({
      companyId,
      scopeType: "agent",
      scopeId: agentId,
      metric: "billed_cents",
      windowKind: "lifetime",
      amount: 1000,
      warnPercent: 80,
      hardStopEnabled: true,
      notifyEnabled: true,
      isActive: true,
    });

    // Cross the first warn threshold (80% of 1000) and stop short of the cap.
    const firstWarn = await insertCostEvent({ companyId, agentId, costCents: 800 });
    await service.evaluateCostEvent(firstWarn);

    const firstIncident = await db.select().from(budgetIncidents).then((rows) => rows[0]!);
    expect(firstIncident).toMatchObject({ thresholdType: "soft", status: "open", amountLimit: 1000 });
    const firstCards = await db.select().from(approvals).where(eq(approvals.companyId, companyId));
    expect(firstCards).toHaveLength(1);
    expect(firstCards[0]).toMatchObject({ status: "pending" });

    // The board does the intended thing: raises the cap. This resolves the
    // incident and approves its card.
    const resolved = await service.resolveIncident(
      companyId,
      firstIncident.id,
      { action: "raise_budget_and_resume", amount: 2000, decisionNote: "Raised to clear the burst." },
      "board-user",
    );
    expect(resolved).toMatchObject({ status: "resolved", approvalStatus: "approved" });

    // Cross the *new* warn threshold (80% of 2000 = 1600), still under the new cap.
    const secondWarn = await insertCostEvent({ companyId, agentId, costCents: 800 });
    await service.evaluateCostEvent(secondWarn);

    const softRows = await db
      .select()
      .from(budgetIncidents)
      .where(eq(budgetIncidents.thresholdType, "soft"));
    expect(softRows).toHaveLength(2);
    const reArmed = softRows.find((row) => row.status === "open")!;
    expect(reArmed).toMatchObject({ amountLimit: 2000, amountObserved: 1600 });
    expect(reArmed.id).not.toBe(firstIncident.id);

    const cardsAfterRaise = await db.select().from(approvals).where(eq(approvals.companyId, companyId));
    expect(cardsAfterRaise).toHaveLength(2);
    const secondCard = cardsAfterRaise.find((card) => card.id === reArmed.approvalId)!;
    expect(secondCard).toMatchObject({ type: "budget_override_required", status: "pending" });
    // The card carries the *new* cap, not the one the board already acted on.
    expect(secondCard.payload as Record<string, unknown>).toMatchObject({
      thresholdType: "soft",
      budgetAmount: 2000,
      observedAmount: 1600,
      remainingAmount: 400,
    });

    // The scope keeps running -- this is still the warn threshold.
    const [agentRow] = await db
      .select({ status: agents.status, pauseReason: agents.pauseReason })
      .from(agents)
      .where(eq(agents.id, agentId));
    expect(agentRow).toMatchObject({ status: "active", pauseReason: null });

    // Re-arming must not become re-filing: with nothing changed since the second
    // card, further evaluations add nothing (BLO-28793's idempotency AC).
    await service.evaluateCostEvent(secondWarn);
    await service.evaluateCostEvent(secondWarn);
    const cardsAfterIdle = await db.select().from(approvals).where(eq(approvals.companyId, companyId));
    expect(cardsAfterIdle).toHaveLength(2);
    expect(cardsAfterIdle.filter((card) => card.status === "pending")).toHaveLength(1);
    const openAfterIdle = await db
      .select()
      .from(budgetIncidents)
      .where(eq(budgetIncidents.status, "open"));
    expect(openAfterIdle).toHaveLength(1);
    expect(openAfterIdle[0]!.id).toBe(reArmed.id);
  });

  it("files a card for the second hard wall in a window instead of pausing silently (BLO-28908)", async () => {
    const { companyId, agentId } = await createBudgetFixture();
    const cancelWorkForScope = vi.fn().mockResolvedValue(undefined);
    const service = budgetService(db, { cancelWorkForScope });
    await db.insert(budgetPolicies).values({
      companyId,
      scopeType: "agent",
      scopeId: agentId,
      metric: "billed_cents",
      windowKind: "lifetime",
      amount: 1000,
      warnPercent: 80,
      hardStopEnabled: true,
      notifyEnabled: true,
      isActive: true,
    });

    // Wall one.
    const firstWall = await insertCostEvent({ companyId, agentId, costCents: 1000 });
    await service.evaluateCostEvent(firstWall);

    const firstHard = await db.select().from(budgetIncidents).then((rows) => rows[0]!);
    expect(firstHard).toMatchObject({ thresholdType: "hard", status: "open", amountLimit: 1000 });
    const [pausedOnce] = await db
      .select({ status: agents.status, pauseReason: agents.pauseReason })
      .from(agents)
      .where(eq(agents.id, agentId));
    expect(pausedOnce).toMatchObject({ status: "paused", pauseReason: "budget" });

    // The board raises the cap and the scope resumes.
    await service.resolveIncident(
      companyId,
      firstHard.id,
      { action: "raise_budget_and_resume", amount: 2000, decisionNote: "Raised past the first wall." },
      "board-user",
    );
    const [resumed] = await db
      .select({ status: agents.status, pauseReason: agents.pauseReason })
      .from(agents)
      .where(eq(agents.id, agentId));
    // `resumeScopeFromBudget` returns the agent to `idle`, not `active`.
    expect(resumed).toMatchObject({ status: "idle", pauseReason: null });

    // Wall two, same window. This is the case the issue was filed on: the
    // suppression check matched the resolved first-wall row and returned
    // `created: false`, while `pauseAndCancelScopeForBudget` -- which is not gated
    // on the card -- ran anyway. The scope went down with nothing on the board.
    const secondWall = await insertCostEvent({ companyId, agentId, costCents: 1000 });
    await service.evaluateCostEvent(secondWall);

    // The invariant, asserted before any row-shape detail because it is the whole
    // point: no scope is paused for budget without a live card naming the cap it
    // hit. Read as one state, because either half alone is passable -- a card with
    // no pause, or the silent pause this fixes.
    const [pausedTwice] = await db
      .select({ status: agents.status, pauseReason: agents.pauseReason })
      .from(agents)
      .where(eq(agents.id, agentId));
    const liveCards = await db
      .select()
      .from(approvals)
      .where(eq(approvals.companyId, companyId));
    const pendingCards = liveCards.filter((card) => card.status === "pending");
    expect({
      agentStatus: pausedTwice?.status,
      pauseReason: pausedTwice?.pauseReason,
      pendingCardCount: pendingCards.length,
    }).toEqual({ agentStatus: "paused", pauseReason: "budget", pendingCardCount: 1 });

    const hardRows = await db
      .select()
      .from(budgetIncidents)
      .where(eq(budgetIncidents.thresholdType, "hard"));
    expect(hardRows).toHaveLength(2);
    const secondHard = hardRows.find((row) => row.status === "open")!;
    expect(secondHard).toMatchObject({ amountLimit: 2000, amountObserved: 2000 });
    expect(secondHard.id).not.toBe(firstHard.id);

    expect(pendingCards[0]!.id).toBe(secondHard.approvalId);
    expect(pendingCards[0]!.payload as Record<string, unknown>).toMatchObject({
      thresholdType: "hard",
      budgetAmount: 2000,
      observedAmount: 2000,
    });
    expect(cancelWorkForScope).toHaveBeenCalledTimes(2);
  });

  it("keeps dismissed semantics and reports the incident it actually changed (BLO-28908)", async () => {
    const { companyId, agentId } = await createBudgetFixture();
    const cancelWorkForScope = vi.fn().mockResolvedValue(undefined);
    const service = budgetService(db, { cancelWorkForScope });
    await db.insert(budgetPolicies).values({
      companyId,
      scopeType: "agent",
      scopeId: agentId,
      metric: "billed_cents",
      windowKind: "lifetime",
      amount: 1000,
      warnPercent: 80,
      hardStopEnabled: true,
      notifyEnabled: true,
      isActive: true,
    });

    const wall = await insertCostEvent({ companyId, agentId, costCents: 1000 });
    await service.evaluateCostEvent(wall);
    const firstHard = await db.select().from(budgetIncidents).then((rows) => rows[0]!);

    // `keep_paused` dismisses the incident and rejects its card. A dismissed row
    // never held the suppression slot, and still does not.
    const dismissed = await service.resolveIncident(
      companyId,
      firstHard.id,
      { action: "keep_paused", decisionNote: "Staying paused." },
      "board-user",
    );
    expect(dismissed).toMatchObject({ status: "dismissed", approvalStatus: "rejected" });

    await service.evaluateCostEvent(wall);
    const afterDismiss = await db
      .select()
      .from(budgetIncidents)
      .where(eq(budgetIncidents.status, "open"));
    expect(afterDismiss).toHaveLength(1);
    expect(afterDismiss[0]!.id).not.toBe(firstHard.id);

    // A stale submit against the dismissed incident id. The side effects are
    // correct -- it resolves whatever is open, resumes the scope, withdraws the
    // other card -- but the response used to claim it had resolved *this*
    // incident, which it never touched. It reports the row's real state now.
    const stale = await service.resolveIncident(
      companyId,
      firstHard.id,
      { action: "raise_budget_and_resume", amount: 3000, decisionNote: "Late raise." },
      "board-user",
    );
    expect(stale).toMatchObject({ id: firstHard.id, status: "dismissed", approvalStatus: "rejected" });

    const [afterStaleRaise] = await db
      .select({ status: agents.status, pauseReason: agents.pauseReason })
      .from(agents)
      .where(eq(agents.id, agentId));
    expect(afterStaleRaise).toMatchObject({ status: "idle", pauseReason: null });
    const openAfterStale = await db
      .select()
      .from(budgetIncidents)
      .where(eq(budgetIncidents.status, "open"));
    expect(openAfterStale).toHaveLength(0);
    const cardsAfterStale = await db.select().from(approvals).where(eq(approvals.companyId, companyId));
    expect(cardsAfterStale.filter((card) => card.status === "pending")).toHaveLength(0);
    expect(cardsAfterStale.map((card) => card.status).sort()).toEqual(["rejected", "withdrawn"]);
  });

  // --- PEN-1972: the budget pause is a latch, not a thermostat -------------
  //
  // Observed spend is window-scoped and the pause flag is not, so at the window
  // roll the condition that set the flag evaporates while the flag survives. A
  // paused scope emits no cost events, so evaluateCostEvent can never re-fire
  // for it either -- before this, only an explicit human resume could clear it.

  async function rollWindowBackwards(companyId: string) {
    // Move every cost event into the previous calendar month. That is what a
    // window roll looks like to computeObservedAmount, which filters on
    // occurredAt, and it is the only part of the roll that matters here.
    const now = new Date();
    const previousWindow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15));
    await db
      .update(costEvents)
      .set({ occurredAt: previousWindow })
      .where(eq(costEvents.companyId, companyId));
  }

  async function latchAgentOnBudget(amount = 100, spend = 125) {
    const fixture = await createBudgetFixture();
    const cancelWorkForScope = vi.fn().mockResolvedValue(undefined);
    const service = budgetService(db, { cancelWorkForScope });
    const [policy] = await db
      .insert(budgetPolicies)
      .values({
        companyId: fixture.companyId,
        scopeType: "agent",
        scopeId: fixture.agentId,
        metric: "billed_cents",
        windowKind: "calendar_month_utc",
        amount,
        warnPercent: 80,
        hardStopEnabled: true,
        notifyEnabled: true,
        isActive: true,
      })
      .returning();

    const event = await insertCostEvent({
      companyId: fixture.companyId,
      agentId: fixture.agentId,
      costCents: spend,
    });
    await service.evaluateCostEvent(event);

    const [agentRow] = await db
      .select({ status: agents.status, pauseReason: agents.pauseReason })
      .from(agents);
    expect(agentRow).toMatchObject({ status: "paused", pauseReason: "budget" });

    return { ...fixture, service, policy: policy! };
  }

  it("clears a budget pause whose window has rolled, on the next invocation check (PEN-1972)", async () => {
    const { companyId, agentId, service } = await latchAgentOnBudget();

    const blockedWhileOverCap = await service.getInvocationBlock(companyId, agentId);
    expect(blockedWhileOverCap).toMatchObject({
      scopeType: "agent",
      reason: "Agent is paused because its budget hard-stop was reached.",
    });

    await rollWindowBackwards(companyId);
    mockLogActivity.mockClear();

    // The same call that used to report the latch forever is the one that lifts
    // it: no scheduler, no human, just the next time anything asks whether this
    // agent may run.
    expect(await service.getInvocationBlock(companyId, agentId)).toBeNull();

    const [resumed] = await db
      .select({ status: agents.status, pauseReason: agents.pauseReason, pausedAt: agents.pausedAt })
      .from(agents);
    expect(resumed).toMatchObject({ status: "idle", pauseReason: null, pausedAt: null });

    // The incident and its card asked the board to choose between raising the
    // budget and staying paused. Neither branch means anything now, so the card
    // must not be left pending against a condition that no longer exists.
    const incidentRows = await db.select().from(budgetIncidents);
    expect(incidentRows.filter((incident) => incident.status === "open")).toHaveLength(0);
    const [card] = await db.select().from(approvals);
    expect(card).toMatchObject({ status: "withdrawn" });

    // A resume is a fiscal event and has to leave a trace, the same way the
    // pause did -- otherwise a scope that came back on its own is
    // indistinguishable from one that was never stopped.
    expect(mockLogActivity.mock.calls.map(([, input]) => input)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "budget.pause_auto_cleared",
          details: expect.objectContaining({ scopeType: "agent", scopeId: agentId }),
        }),
      ]),
    );
  });

  it("keeps a budget pause that is still earned in the current window (PEN-1972)", async () => {
    const { companyId, agentId, service } = await latchAgentOnBudget();

    // No window roll: the spend that caused the pause is still inside the
    // window, so re-evaluating must reach the same verdict rather than treating
    // every check as an excuse to resume.
    expect(await service.getInvocationBlock(companyId, agentId)).toMatchObject({
      scopeType: "agent",
      scopeId: agentId,
      reason: "Agent is paused because its budget hard-stop was reached.",
    });

    const [stillPaused] = await db
      .select({ status: agents.status, pauseReason: agents.pauseReason })
      .from(agents);
    expect(stillPaused).toMatchObject({ status: "paused", pauseReason: "budget" });
    expect(
      (await db.select().from(budgetIncidents)).filter((incident) => incident.status === "open"),
    ).toHaveLength(1);
  });

  it("clears a budget pause left behind by a policy that is no longer active (PEN-1972)", async () => {
    const { companyId, agentId, service, policy } = await latchAgentOnBudget();

    // Deactivating the policy removes the cap that justified the flag. Nothing
    // else would ever clear it: the scope emits no cost events while paused, and
    // the policy it was filed against no longer governs anything.
    await db
      .update(budgetPolicies)
      .set({ isActive: false })
      .where(eq(budgetPolicies.id, policy.id));

    expect(await service.getInvocationBlock(companyId, agentId)).toBeNull();

    const [resumed] = await db
      .select({ status: agents.status, pauseReason: agents.pauseReason })
      .from(agents);
    expect(resumed).toMatchObject({ status: "idle", pauseReason: null });
  });

  it("never lifts a pause it does not own (PEN-1972)", async () => {
    const { companyId, agentId, service } = await latchAgentOnBudget();
    await db.update(agents).set({ pauseReason: "manual" }).where(eq(agents.id, agentId));

    await rollWindowBackwards(companyId);
    await service.getInvocationBlock(companyId, agentId);

    // The window rolled and the budget condition is gone, but this pause was
    // never the budget service's to lift.
    const [stillPaused] = await db
      .select({ status: agents.status, pauseReason: agents.pauseReason })
      .from(agents);
    expect(stillPaused).toMatchObject({ status: "paused", pauseReason: "manual" });
  });

  it("clears a rolled-over budget pause on a project scope too (PEN-1972)", async () => {
    const { companyId, agentId, projectId } = await createBudgetFixture();
    const cancelWorkForScope = vi.fn().mockResolvedValue(undefined);
    const service = budgetService(db, { cancelWorkForScope });
    await db.insert(budgetPolicies).values({
      companyId,
      scopeType: "project",
      scopeId: projectId,
      metric: "billed_cents",
      windowKind: "calendar_month_utc",
      amount: 100,
      warnPercent: 80,
      hardStopEnabled: true,
      notifyEnabled: true,
      isActive: true,
    });

    const event = await insertCostEvent({ companyId, agentId, projectId, costCents: 125 });
    await service.evaluateCostEvent(event);
    expect(await service.getInvocationBlock(companyId, agentId, { projectId })).toMatchObject({
      scopeType: "project",
      scopeId: projectId,
    });

    await rollWindowBackwards(companyId);

    expect(await service.getInvocationBlock(companyId, agentId, { projectId })).toBeNull();
    const [resumedProject] = await db
      .select({ pauseReason: projects.pauseReason, pausedAt: projects.pausedAt })
      .from(projects);
    expect(resumedProject).toMatchObject({ pauseReason: null, pausedAt: null });
  });

  it("resumes on a disabled hard stop without destroying the live soft warning (PEN-1972, #3019 review)", async () => {
    const { companyId, agentId, service, policy } = await latchAgentOnBudget();

    // Turn the hard stop off while spend is still over cap. `upsertPolicy` takes
    // its `observedAmount >= amount` branch: `hardStopWillFire` is false, so it
    // files a *soft* warn card and leaves the scope paused.
    await service.upsertPolicy(
      companyId,
      {
        scopeType: "agent",
        scopeId: agentId,
        metric: "billed_cents",
        windowKind: "calendar_month_utc",
        amount: policy.amount,
        warnPercent: 80,
        hardStopEnabled: false,
        notifyEnabled: true,
      },
      null,
    );

    const softBefore = (await db.select().from(budgetIncidents))
      .filter((incident) => incident.thresholdType === "soft" && incident.status === "open");
    expect(softBefore).toHaveLength(1);

    // The hard stop no longer binds, so the resume is correct...
    expect(await service.getInvocationBlock(companyId, agentId)).toBeNull();
    const [resumed] = await db
      .select({ status: agents.status, pauseReason: agents.pauseReason })
      .from(agents);
    expect(resumed).toMatchObject({ status: "idle", pauseReason: null });

    // ...but it must not take the warn card with it. The window did not roll and
    // spend is still over cap, so that warning is live: closing it would delete
    // the board's only notice of an overspend the scope is still carrying.
    const incidentsAfter = await db.select().from(budgetIncidents);
    const [soft] = incidentsAfter.filter((incident) => incident.thresholdType === "soft");
    expect(soft).toMatchObject({ status: "open" });
    const [softCard] = await db
      .select()
      .from(approvals)
      .where(eq(approvals.id, soft!.approvalId!));
    expect(softCard).toMatchObject({ status: "pending" });

    // The hard incident is the pause decision, so it still dies with the pause.
    expect(
      incidentsAfter.filter((incident) => incident.thresholdType === "hard" && incident.status === "open"),
    ).toHaveLength(0);

    // And the audit trail must name the cause that actually fired. "The budget
    // window rolled" was false here on both counts, and it was written for a
    // deactivated policy and a zeroed cap too.
    const allCards = await db.select().from(approvals);
    const withdrawn = allCards.filter((card) => card.status === "withdrawn");
    expect(withdrawn).toHaveLength(1);
    expect(withdrawn[0]!.decisionNote).toContain("the hard stop is disabled on the governing policy");
    expect(withdrawn[0]!.decisionNote).not.toContain("window rolled");

    expect(mockLogActivity.mock.calls.map(([, input]) => input)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "budget.pause_auto_cleared",
          details: expect.objectContaining({
            reason: "the hard stop is disabled on the governing policy",
          }),
        }),
      ]),
    );
  });

  it("writes one auto-clear per resume when two callers race the same latch (PEN-1972, #3019 review)", async () => {
    const { companyId, agentId, service } = await latchAgentOnBudget();
    await rollWindowBackwards(companyId);
    mockLogActivity.mockClear();

    // Both calls start before either writes, so in the usual interleaving both
    // read the row as paused and both reach the resume. That write is guarded on
    // `pauseReason = "budget"`, so exactly one UPDATE returns a row and the
    // loser's guard matches nothing. The loser resumed nothing, so it must not
    // also claim an auto-clear in the ledger -- a resume is a fiscal event, and
    // double-counting one is a false trace.
    //
    // The assertion holds under either interleaving: if the second call happens
    // to read the row after the first already resumed it, it skips the clear
    // entirely and still logs nothing. So this cannot fail spuriously, and in
    // the racing interleaving -- the one it is here to cover -- it is the
    // `.returning()` guard in `resumeScopeFromBudget` that keeps the count at 1.
    const [first, second] = await Promise.all([
      service.getInvocationBlock(companyId, agentId),
      service.getInvocationBlock(companyId, agentId),
    ]);
    expect(first).toBeNull();
    expect(second).toBeNull();

    const cleared = mockLogActivity.mock.calls
      .map(([, input]) => input)
      .filter((input: any) => input.action === "budget.pause_auto_cleared");
    expect(cleared).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // PEN-4742: resuming without ratcheting the cap up to observed-plus-epsilon.
  //
  // `raise_budget_and_resume` refuses any amount at or below observed spend, so
  // mid-window it FORCES the cap above whatever has accrued. The cap stops being
  // a chosen figure and becomes a function of one window's overshoot -- which is
  // how a $1.63 breach produced a $20,011.63 cap, and how the warn band shipped
  // in BLO-28793 got hollowed out, since a band on a cap nobody can reach warns
  // on nothing.
  //
  // The fix is not to delete the guard: resuming under a cap you have already
  // blown re-latches on the next cost event. It is to separate "what the cap is"
  // from "may this scope run for the rest of this window".
  // ---------------------------------------------------------------------------

  async function resolveHardIncident(
    service: ReturnType<typeof budgetService>,
    companyId: string,
    input: { action: "keep_paused" | "raise_budget_and_resume" | "resume_without_raise"; amount?: number },
  ) {
    const [hard] = await db
      .select()
      .from(budgetIncidents)
      .where(eq(budgetIncidents.thresholdType, "hard"));
    return service.resolveIncident(companyId, hard!.id, input, "board-user");
  }

  it("resumes a mid-window pause without lifting the cap over observed spend (PEN-4742)", async () => {
    // $1.00 cap, $1.25 spent: the exact shape of the June breach.
    const { companyId, agentId, service, policy } = await latchAgentOnBudget(100, 125);

    // What the ratchet used to force. The board has no way to say "the cap is
    // fine, I have looked at the overshoot, let it run".
    await expect(
      resolveHardIncident(service, companyId, { action: "raise_budget_and_resume", amount: 100 }),
    ).rejects.toThrow(/must exceed current observed spend/);

    await resolveHardIncident(service, companyId, { action: "resume_without_raise" });

    // The cap is still exactly what a human chose. Not observed-plus-epsilon,
    // not touched at all.
    const [capAfter] = await db.select().from(budgetPolicies).where(eq(budgetPolicies.id, policy.id));
    expect(capAfter!.amount).toBe(100);
    expect(capAfter!.amountUpdatedAt).toEqual(policy.amountUpdatedAt);

    const [resumed] = await db
      .select({ status: agents.status, pauseReason: agents.pauseReason })
      .from(agents);
    expect(resumed).toMatchObject({ status: "idle", pauseReason: null });
    expect(await service.getInvocationBlock(companyId, agentId)).toBeNull();

    // The grant is the incident row, and nothing else. No new policy state, so
    // nothing has to be cleaned up by hand.
    const [hard] = await db
      .select()
      .from(budgetIncidents)
      .where(eq(budgetIncidents.thresholdType, "hard"));
    expect(hard).toMatchObject({ status: "resolved", resolutionAction: "resume_without_raise" });
  });

  it("does not re-latch on the next cost event after a keep-the-cap resume (PEN-4742)", async () => {
    const { companyId, agentId, service } = await latchAgentOnBudget(100, 125);
    await resolveHardIncident(service, companyId, { action: "resume_without_raise" });

    // This is the event that used to put the scope straight back down: window
    // spend is $1.26 against a $1.00 cap, so the old `observed >= amount` test
    // fires on the first dollar of new work.
    const next = await insertCostEvent({ companyId, agentId, costCents: 1 });
    await service.evaluateCostEvent(next);

    const [stillRunning] = await db
      .select({ status: agents.status, pauseReason: agents.pauseReason })
      .from(agents);
    expect(stillRunning).toMatchObject({ status: "idle", pauseReason: null });
    expect(await service.getInvocationBlock(companyId, agentId)).toBeNull();

    // And no fresh card either. A warn card filed here would be the same churn
    // the action exists to prevent, relabelled: total window spend is over the
    // cap by construction, so it is over warnPercent of it too.
    expect(
      (await db.select().from(budgetIncidents)).filter((incident) => incident.status === "open"),
    ).toHaveLength(0);
  });

  it("re-latches once post-decision spend reaches the cap, not before (PEN-4742)", async () => {
    const { companyId, agentId, service } = await latchAgentOnBudget(100, 125);
    await resolveHardIncident(service, companyId, { action: "resume_without_raise" });

    // One cent short of the cap, measured from the decision. The grant bounds
    // the tail at exactly one cap's worth -- it does not switch the hard stop
    // off for the window, which would let a scope resumed at $1.26 burn
    // arbitrarily and be worse in the tail than the ratchet it replaces.
    const justUnder = await insertCostEvent({ companyId, agentId, costCents: 99 });
    await service.evaluateCostEvent(justUnder);
    expect(await service.getInvocationBlock(companyId, agentId)).toBeNull();

    const overTheLine = await insertCostEvent({ companyId, agentId, costCents: 1 });
    await service.evaluateCostEvent(overTheLine);

    const [relatched] = await db
      .select({ status: agents.status, pauseReason: agents.pauseReason })
      .from(agents);
    expect(relatched).toMatchObject({ status: "paused", pauseReason: "budget" });
    expect(await service.getInvocationBlock(companyId, agentId)).toMatchObject({
      scopeType: "agent",
      reason: "Agent is paused because its budget hard-stop was reached.",
    });

    // The fresh card reports TRUE window spend ($2.25), not the rebaselined
    // figure. The grant changes what the hard stop is measured against; it does
    // not change what the scope actually spent, and a card claiming "$1.00
    // against a limit of $1.00" would mislead the next board member to read it.
    const [freshHard] = await db
      .select()
      .from(budgetIncidents)
      .where(and(eq(budgetIncidents.thresholdType, "hard"), eq(budgetIncidents.status, "open")));
    expect(freshHard!.amountObserved).toBe(225);
    expect(freshHard!.amountLimit).toBe(100);
  });

  it("binds at the human's cap again once the window has rolled (PEN-4742)", async () => {
    const { companyId, agentId, service, policy } = await latchAgentOnBudget(100, 125);
    await resolveHardIncident(service, companyId, { action: "resume_without_raise" });
    expect(await service.getInvocationBlock(companyId, agentId)).toBeNull();

    await rollWindowBackwards(companyId);
    const freshWindowSpend = await insertCostEvent({ companyId, agentId, costCents: 100 });
    await service.evaluateCostEvent(freshWindowSpend);

    // $1.00 of new-window spend against the $1.00 cap the human kept: the cap
    // is enforced normally again, with no residue from last window's decision.
    const [pausedAgain] = await db
      .select({ status: agents.status, pauseReason: agents.pauseReason })
      .from(agents);
    expect(pausedAgain).toMatchObject({ status: "paused", pauseReason: "budget" });

    const [capAfter] = await db.select().from(budgetPolicies).where(eq(budgetPolicies.id, policy.id));
    expect(capAfter!.amount).toBe(100);

    // ⚠ Be precise about what this proves, because the obvious reading is wrong.
    // `rollWindowBackwards` moves cost EVENTS, not incidents, so the grant row
    // still names the current window at this point -- this case does NOT
    // exercise the `windowStart` filter, and an assertion here that "the grant
    // would have kept it running" would be false.
    //
    // The scope stops because expiry is STRUCTURAL: `computeObservedAmount`
    // ANDs the `since` floor with the window bounds, and any grant from an
    // earlier window has `resolvedAt` before the window start, so its floor is
    // strictly weaker than the clamp and subtracts nothing. A stale grant is
    // inert however it is read. The `windowStart` filter is belt-and-braces on
    // top of that, and the next case pins it on its own.
  });

  it("does not read a previous window's grant as live (PEN-4742)", async () => {
    const { companyId, service, policy } = await latchAgentOnBudget(100, 125);
    await resolveHardIncident(service, companyId, { action: "resume_without_raise" });

    // The grant surfaces on the policy summary, which is what makes the
    // `windowStart` filter observable at all. Age the incident into the
    // previous window -- the one thing `rollWindowBackwards` cannot simulate,
    // because it moves cost events and leaves incidents where they are.
    const now = new Date();
    const lastWindowStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    await db
      .update(budgetIncidents)
      .set({ windowStart: lastWindowStart, resolvedAt: lastWindowStart });

    const overview = await service.overview(companyId);
    const summary = overview.policies.find((entry) => entry.policyId === policy.id);
    expect(summary!.hardStopForgivenSince).toBeNull();
  });

  it("keeps reporting true window spend while a grant is live (PEN-4742)", async () => {
    const { companyId, service, policy } = await latchAgentOnBudget(100, 125);
    await resolveHardIncident(service, companyId, { action: "resume_without_raise" });

    // Enforcement rebaselines; reporting must not. A forgiven scope that
    // rendered as healthy would be PEN-1972 defect 3 in a new costume -- the
    // gauge going quiet exactly when it has something to say.
    const overview = await service.overview(companyId);
    const summary = overview.policies.find((entry) => entry.policyId === policy.id);
    expect(summary).toMatchObject({
      observedAmount: 125,
      utilizationPercent: 125,
      status: "hard_stop",
      paused: false,
    });
    // ...and the card is given the one fact that explains an over-cap scope that
    // is nonetheless running, so it reads as a decision rather than a bug.
    expect(summary!.hardStopForgivenSince).toBeInstanceOf(Date);
  });

  it("does not grant a window rebaseline when the board raises the cap instead (PEN-4742)", async () => {
    const { companyId, agentId, service } = await latchAgentOnBudget(100, 125);

    // The ordinary path, untouched: raise $1.00 -> $2.00, clear of observed.
    await resolveHardIncident(service, companyId, { action: "raise_budget_and_resume", amount: 200 });
    expect(await service.getInvocationBlock(companyId, agentId)).toBeNull();

    // A raise must NOT confer forgiveness. Deriving the grant from "any resolved
    // hard incident in this window" would do exactly that, and buy this scope
    // immunity at $2.00 for the rest of the month -- an enforcement regression on
    // the common path, introduced to fix the uncommon one. $0.75 more takes total
    // spend to $2.00 and must stop it.
    const toTheNewCap = await insertCostEvent({ companyId, agentId, costCents: 75 });
    await service.evaluateCostEvent(toTheNewCap);

    const [pausedAtNewCap] = await db
      .select({ status: agents.status, pauseReason: agents.pauseReason })
      .from(agents);
    expect(pausedAtNewCap).toMatchObject({ status: "paused", pauseReason: "budget" });
  });

  it("cannot be handed a grant by lowering the cap after an ordinary raise (PEN-4742)", async () => {
    const { companyId, agentId, service, policy } = await latchAgentOnBudget(100, 125);
    await resolveHardIncident(service, companyId, { action: "raise_budget_and_resume", amount: 1000 });

    // Deriving the grant from live state -- `policy.amount <= incident.amountObserved`
    // -- is retroactively forgeable exactly here: lower the cap back under observed
    // and the predicate flips to true, conferring a suppression no board decided.
    // Lowering a cap must tighten enforcement, never loosen it.
    await service.upsertPolicy(
      companyId,
      { scopeType: "agent", scopeId: agentId, amount: 110, metric: "billed_cents", windowKind: "calendar_month_utc" },
      "board-user",
    );

    const [pausedByTheLowerCap] = await db
      .select({ status: agents.status, pauseReason: agents.pauseReason })
      .from(agents);
    expect(pausedByTheLowerCap).toMatchObject({ status: "paused", pauseReason: "budget" });

    const [reread] = await db.select().from(budgetPolicies).where(eq(budgetPolicies.id, policy.id));
    expect(reread!.amount).toBe(110);
  });

  it("lets a resume keep the cap once the window has already rolled (PEN-4742, option 1)", async () => {
    const { companyId, agentId, service, policy } = await latchAgentOnBudget(100, 125);
    await rollWindowBackwards(companyId);

    // Post-roll, observed has fallen below the cap, so keeping the cap already
    // satisfies `nextAmount > currentObserved` and needs no grant at all. Pinned
    // because it is the case the original guard was accused of blocking and does
    // not: the bug is mid-window only.
    await resolveHardIncident(service, companyId, { action: "raise_budget_and_resume", amount: 100 });

    const [capAfter] = await db.select().from(budgetPolicies).where(eq(budgetPolicies.id, policy.id));
    expect(capAfter!.amount).toBe(100);
    expect(await service.getInvocationBlock(companyId, agentId)).toBeNull();

    const [hard] = await db
      .select()
      .from(budgetIncidents)
      .where(eq(budgetIncidents.thresholdType, "hard"));
    // No grant: the window rolled, so there was nothing to forgive.
    expect(hard).toMatchObject({ status: "resolved", resolutionAction: "raise_budget_and_resume" });
  });

  it("stops refusing a raise the cap could never enforce anyway (PEN-4742, option 1)", async () => {
    const { companyId, service, policy } = await latchAgentOnBudget(100, 125);
    await db
      .update(budgetPolicies)
      .set({ hardStopEnabled: false })
      .where(eq(budgetPolicies.id, policy.id));

    // With the hard stop off the cap pauses nothing, so there is no re-latch to
    // protect against and the guard is pure friction. Same for amount 0, which
    // means "no cap" everywhere else in this file and was unreachable purely
    // because 0 is never greater than observed.
    await resolveHardIncident(service, companyId, { action: "raise_budget_and_resume", amount: 50 });
    const [lowered] = await db.select().from(budgetPolicies).where(eq(budgetPolicies.id, policy.id));
    expect(lowered!.amount).toBe(50);

    await db
      .update(budgetPolicies)
      .set({ hardStopEnabled: true })
      .where(eq(budgetPolicies.id, policy.id));
    const [hard] = await db
      .select()
      .from(budgetIncidents)
      .where(eq(budgetIncidents.thresholdType, "hard"));
    await service.resolveIncident(companyId, hard!.id, { action: "raise_budget_and_resume", amount: 0 }, "board-user");
    const [uncapped] = await db.select().from(budgetPolicies).where(eq(budgetPolicies.id, policy.id));
    expect(uncapped!.amount).toBe(0);
  });

  it("refuses a keep-the-cap resume on a lifetime budget, which never rolls (PEN-4742)", async () => {
    const { companyId, service, policy } = await latchAgentOnBudget(100, 125);
    await db
      .update(budgetPolicies)
      .set({ windowKind: "lifetime" })
      .where(eq(budgetPolicies.id, policy.id));

    // A lifetime window has no roll, so the grant would never expire -- permanent
    // state, which is the one thing this design refuses. Raise it, disable the
    // hard stop, or stay paused.
    await expect(
      resolveHardIncident(service, companyId, { action: "resume_without_raise" }),
    ).rejects.toThrow(/lifetime-scoped/);
  });

  it("writes the cap a board types on a keep-the-cap resume, even below observed (PEN-4742)", async () => {
    const { companyId, agentId, service, policy } = await latchAgentOnBudget(100, 125);

    // The cap is whatever the human chose. Lowering it below observed is a
    // legitimate decision -- "this window got away from us, next window is
    // tighter" -- and is precisely what the old guard made unexpressible.
    await resolveHardIncident(service, companyId, { action: "resume_without_raise", amount: 60 });

    const [capAfter] = await db.select().from(budgetPolicies).where(eq(budgetPolicies.id, policy.id));
    expect(capAfter!.amount).toBe(60);
    expect(await service.getInvocationBlock(companyId, agentId)).toBeNull();

    // And the grant is measured against that lower cap, not the old one.
    const underTheLowerCap = await insertCostEvent({ companyId, agentId, costCents: 59 });
    await service.evaluateCostEvent(underTheLowerCap);
    expect(await service.getInvocationBlock(companyId, agentId)).toBeNull();

    const overTheLowerCap = await insertCostEvent({ companyId, agentId, costCents: 1 });
    await service.evaluateCostEvent(overTheLowerCap);
    const [relatched] = await db
      .select({ status: agents.status, pauseReason: agents.pauseReason })
      .from(agents);
    expect(relatched).toMatchObject({ status: "paused", pauseReason: "budget" });
  });

  it("does not let an unrelated policy edit re-pause a forgiven scope (PEN-4742)", async () => {
    const { companyId, agentId, service } = await latchAgentOnBudget(100, 125);
    await resolveHardIncident(service, companyId, { action: "resume_without_raise" });

    // `upsertPolicy` is the third site that can pause a scope. Leaving it
    // unaware of the grant would make a notification toggle silently undo a
    // board decision.
    await service.upsertPolicy(
      companyId,
      {
        scopeType: "agent",
        scopeId: agentId,
        amount: 100,
        metric: "billed_cents",
        windowKind: "calendar_month_utc",
        notifyEnabled: false,
      },
      "board-user",
    );

    const [stillRunning] = await db
      .select({ status: agents.status, pauseReason: agents.pauseReason })
      .from(agents);
    expect(stillRunning).toMatchObject({ status: "idle", pauseReason: null });
  });

  it("never confers a grant from an incident resolved before the column existed (PEN-4742)", async () => {
    const { companyId, agentId, service } = await latchAgentOnBudget(100, 125);
    await resolveHardIncident(service, companyId, { action: "resume_without_raise" });

    // Every row predating the migration reads `resolution_action = null`, and
    // null must never confer a grant -- otherwise shipping this would
    // retroactively un-cap every scope with a resolved incident in the current
    // window. Simulate one by clearing the column.
    await db.update(budgetIncidents).set({ resolutionAction: null });

    const next = await insertCostEvent({ companyId, agentId, costCents: 1 });
    await service.evaluateCostEvent(next);

    const [pausedByTheFallback] = await db
      .select({ status: agents.status, pauseReason: agents.pauseReason })
      .from(agents);
    expect(pausedByTheFallback).toMatchObject({ status: "paused", pauseReason: "budget" });
  });

});
