import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  approvals,
  budgetIncidents,
  budgetPolicies,
  companies,
  costEvents,
  createDb,
} from "@paperclipai/db";
import { agentService } from "../services/agents.ts";
import { budgetService } from "../services/budgets.ts";
import { companyService } from "../services/companies.ts";
import { costService } from "../services/costs.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

vi.mock("../services/activity-log.js", () => ({
  logActivity: vi.fn(),
}));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

/**
 * PEN-4466. The invariant these tests hold is the ORDERING CONSTRAINT documented above
 * `computeObservedAmount` in `services/budgets.ts`: the metric a `hardStopEnabled` policy
 * enforces on must be a CONSUMPTION quantity that `normalizeBilledCostCents` cannot zero.
 *
 * Deliberately synthetic. The tempting form -- "assert observed spend > 0 for each live
 * policy" -- would flap, because at least one real lane sits at $0.00 legitimately. These
 * fixtures assert the shape of the reader, not the state of the ledger.
 */
describeEmbeddedPostgres("budget control reads consumption, not the zeroable cash column", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-budget-consumption-");
    db = createDb(tempDb.connectionString);
  });

  afterEach(async () => {
    await db.delete(budgetIncidents);
    await db.delete(approvals);
    await db.delete(budgetPolicies);
    await db.delete(costEvents);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createFixture() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Consumption Metric Co",
      issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Consumption Agent",
      role: "engineer",
      status: "active",
      adapterType: "claude_k8s",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function insertHardStopPolicy(scope: { companyId: string; agentId: string; amount: number }) {
    const [policy] = await db
      .insert(budgetPolicies)
      .values({
        companyId: scope.companyId,
        scopeType: "agent",
        scopeId: scope.agentId,
        metric: "billed_cents",
        windowKind: "calendar_month_utc",
        amount: scope.amount,
        warnPercent: 80,
        hardStopEnabled: true,
        notifyEnabled: false,
        isActive: true,
      })
      .returning();
    return policy!;
  }

  async function insertLedgerRow(input: {
    companyId: string;
    agentId: string;
    billingType: string;
    costCents: number;
    consumptionCents: number | null;
  }) {
    await db.insert(costEvents).values({
      companyId: input.companyId,
      agentId: input.agentId,
      provider: "anthropic",
      biller: "anthropic",
      billingType: input.billingType,
      model: "claude-opus-5",
      inputTokens: 1_000,
      outputTokens: 200,
      costCents: input.costCents,
      consumptionCents: input.consumptionCents,
      occurredAt: new Date(),
    });
  }

  /**
   * `overview()` is the public reader that surfaces `computeObservedAmount`; asserting
   * through it rather than against the private function means a future refactor that
   * bypasses the helper still has to keep this invariant.
   */
  async function readObservedAmount(scope: { companyId: string; agentId: string }) {
    const service = budgetService(db, {});
    const overview = await service.overview(scope.companyId);
    const policy = overview.policies.find((row) => row.scopeId === scope.agentId);
    expect(policy, "the fixture's agent policy must be present in the overview").toBeDefined();
    return policy!.observedAmount;
  }

  /**
   * The headline invariant: a `subscription_included` row is what a CORRECTLY classifying
   * adapter writes, and `normalizeBilledCostCents` books it at `costCents: 0`. If the gate
   * read that column, this would be 0 and the hard stop would be unreachable.
   */
  it("counts a subscription_included row at full list price even though its cash column is zero", async () => {
    const { companyId, agentId } = await createFixture();
    await insertHardStopPolicy({ companyId, agentId, amount: 10_000 });
    await insertLedgerRow({
      companyId,
      agentId,
      billingType: "subscription_included",
      costCents: 0,
      consumptionCents: 2_500,
    });

    expect(await readObservedAmount({ companyId, agentId })).toBe(2_500);
  });

  /**
   * Pins "step 2 moves no lane": for the only billing type the ledger has ever actually
   * contained, the repointed metric must equal `cost_cents` exactly.
   */
  it("equals cost_cents for a metered_api row, so no existing lane moves", async () => {
    const { companyId, agentId } = await createFixture();
    await insertHardStopPolicy({ companyId, agentId, amount: 10_000 });
    await insertLedgerRow({
      companyId,
      agentId,
      billingType: "metered_api",
      costCents: 1_337,
      consumptionCents: 1_337,
    });

    expect(await readObservedAmount({ companyId, agentId })).toBe(1_337);
  });

  /**
   * Rows written before migration 0263 carry NULL. They must fall back to `cost_cents`,
   * which for every such row IS list price -- this is what makes the repoint a no-op over
   * the ~20 days of the current window that predate it.
   */
  it("falls back to cost_cents for pre-migration rows with a null consumption column", async () => {
    const { companyId, agentId } = await createFixture();
    await insertHardStopPolicy({ companyId, agentId, amount: 10_000 });
    await insertLedgerRow({
      companyId,
      agentId,
      billingType: "metered_api",
      costCents: 4_200,
      consumptionCents: null,
    });

    expect(await readObservedAmount({ companyId, agentId })).toBe(4_200);
  });

  /**
   * The negative control for choosing a nullable column over NOT NULL DEFAULT 0: a
   * genuinely-free run must read 0, not silently re-derive from `cost_cents`. This is the
   * assertion that fails if anyone "simplifies" the reader to
   * `coalesce(nullif(consumption_cents, 0), cost_cents)`.
   */
  it("keeps a genuinely zero-consumption row at zero rather than re-reading cost_cents", async () => {
    const { companyId, agentId } = await createFixture();
    await insertHardStopPolicy({ companyId, agentId, amount: 10_000 });
    await insertLedgerRow({
      companyId,
      agentId,
      billingType: "subscription_included",
      costCents: 9_999,
      consumptionCents: 0,
    });

    expect(await readObservedAmount({ companyId, agentId })).toBe(0);
  });

  /**
   * End-to-end: the hard stop actually fires on subscription-only consumption. Without the
   * repoint this scope would sit at 0 forever with the policy reading healthy.
   */
  it("hard-stops a scope whose entire spend is subscription_included", async () => {
    const { companyId, agentId } = await createFixture();
    const cancelWorkForScope = vi.fn().mockResolvedValue(undefined);
    const service = budgetService(db, { cancelWorkForScope });
    await insertHardStopPolicy({ companyId, agentId, amount: 1_000 });

    const [event] = await db
      .insert(costEvents)
      .values({
        companyId,
        agentId,
        provider: "anthropic",
        biller: "anthropic",
        billingType: "subscription_included",
        model: "claude-opus-5",
        inputTokens: 1_000,
        outputTokens: 200,
        costCents: 0,
        consumptionCents: 1_500,
        occurredAt: new Date(),
      })
      .returning();

    await service.evaluateCostEvent(event!);

    const [pausedAgent] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(pausedAgent?.pausedAt).not.toBeNull();
    expect(cancelWorkForScope).toHaveBeenCalled();

    const incidents = await db.select().from(budgetIncidents);
    expect(incidents.some((incident) => incident.thresholdType === "hard")).toBe(true);
  });

  /**
   * The SERVED monthly burn, which is a different number from the stored one.
   * `hydrateAgentSpend` / `hydrateCompanySpend` overwrite `spent_monthly_cents` with a live
   * re-sum on every read, so repointing `getMonthlySpendTotal` alone fixes what is WRITTEN
   * and not what is SERVED. Without these two assertions the hydration paths could be
   * reverted to `cost_cents` with the rest of this suite still green — which is exactly how
   * they were missed on the first pass.
   */
  it("serves agent and company monthly spend from consumption, not the zeroed cash column", async () => {
    const { companyId, agentId } = await createFixture();
    await insertLedgerRow({
      companyId,
      agentId,
      billingType: "subscription_included",
      costCents: 0,
      consumptionCents: 3_100,
    });

    const servedAgent = await agentService(db).getById(agentId);
    expect(servedAgent?.spentMonthlyCents).toBe(3_100);

    const servedCompany = await companyService(db).getById(companyId);
    expect(servedCompany?.spentMonthlyCents).toBe(3_100);
  });

  /**
   * `getMonthlySpendTotal` writes the STORED column on every cost event. Asserted through
   * `costService.createEvent`, which is the only writer.
   */
  it("stores agent and company monthly spend from consumption on a subscription cost event", async () => {
    const { companyId, agentId } = await createFixture();

    await costService(db, {}).createEvent(companyId, {
      agentId,
      provider: "anthropic",
      biller: "anthropic",
      billingType: "subscription_included",
      model: "claude-opus-5",
      inputTokens: 1_000,
      outputTokens: 200,
      costCents: 0,
      consumptionCents: 2_200,
      occurredAt: new Date(),
    });

    const [storedAgent] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(storedAgent?.spentMonthlyCents).toBe(2_200);

    const [storedCompany] = await db.select().from(companies).where(eq(companies.id, companyId));
    expect(storedCompany?.spentMonthlyCents).toBe(2_200);
  });
});
