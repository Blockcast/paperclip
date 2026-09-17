import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  approvals,
  budgetPolicies,
  companies,
  createDb,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.ts";
import { approvalService } from "../services/approvals.ts";
import { budgetService } from "../services/budgets.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres hire lock-order tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

function issuePrefix(id: string) {
  return `T${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
}

/**
 * BLO-34422. BLO-32796 put every in-transaction writer of the
 * (budget_policies, agents) pair on one lock order — policies first — and the
 * `hire_agent` decision path was the writer it missed. `approvals.approve`
 * opens a transaction, calls `activatePendingApproval` (which opens with
 * `select … from agents … for update`) and only then reaches
 * `txBudgets.upsertPolicy`. Against a concurrent `PATCH
 * /agents/:agentId/budgets` on the same agent that is the same agents→policies
 * vs policies→agents cycle, with the same consequence: Postgres aborts one side
 * with 40P01, which is not an `HttpError`, so `withRefusalLogged` neither logs
 * nor maps it and the loser gets an unhandled 500 with no retry.
 *
 * Asserted as the invariant rather than by racing the two paths: while the
 * policy row is held by someone else, the decision must not yet have locked
 * `agents`.
 */
describeEmbeddedPostgres("hire_agent approval takes the budget_policies lock first", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-hire-lock-order-");
    db = createDb(tempDb.connectionString);
  });

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(budgetPolicies);
    await db.delete(approvals);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await db?.$client.end();
    await tempDb?.cleanup();
  });

  async function seedPendingHire(budgetMonthlyCents = 500_000) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: issuePrefix(companyId),
      requireBoardApprovalForNewAgents: true,
    });
    const pending = await agentService(db).create(companyId, {
      name: "Pending Coder",
      role: "engineer",
      title: "Software Engineer",
      capabilities: "Writes code",
      adapterType: "process",
      adapterConfig: { command: "echo safe" },
      budgetMonthlyCents,
      status: "pending_approval",
      spentMonthlyCents: 0,
      permissions: {},
      lastHeartbeatAt: null,
    });
    const approval = await approvalService(db).create(companyId, {
      type: "hire_agent",
      requestedByAgentId: null,
      requestedByUserId: "board-user",
      status: "pending",
      payload: {
        name: "Pending Coder",
        role: "engineer",
        title: "Software Engineer",
        reportsTo: null,
        capabilities: "Writes code",
        adapterType: "process",
        adapterConfig: { command: "echo safe" },
        budgetMonthlyCents,
        agentId: pending.id,
      },
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      updatedAt: new Date(),
    });
    // The narrow precondition this bug needs: a *pending* agent that already
    // carries an agent-scoped policy row, so there is a row for a board cap
    // change to be holding at the moment the hire is decided.
    await budgetService(db).upsertPolicy(
      companyId,
      {
        scopeType: "agent",
        scopeId: pending.id,
        amount: budgetMonthlyCents,
        windowKind: "calendar_month_utc",
      },
      "board-user",
    );
    return { companyId, pending, approval };
  }

  it("does not touch the agents row while the policy row is held", async () => {
    const { pending, approval } = await seedPendingHire();

    const holder = createDb(tempDb!.connectionString);
    const prober = createDb(tempDb!.connectionString);
    let release!: () => void;
    let acquired!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    // The holder must actually hold the policy lock before the decision fires,
    // or the decision wins the race and the probe measures nothing.
    const holding = new Promise<void>((resolve) => { acquired = resolve; });

    const held = holder.transaction(async (tx) => {
      await tx
        .select({ id: budgetPolicies.id })
        .from(budgetPolicies)
        .where(eq(budgetPolicies.scopeId, pending.id))
        .for("update");
      acquired();
      await released;
    });
    await holding;

    const decision = approvalService(db).approve(approval.id, "board-user", "Approved");
    // The probe window is time-based, so it fails toward green: if the decision
    // had already settled, every probe would succeed for the wrong reason —
    // there would be no transaction left to be holding anything. Tracking
    // settlement is what turns that into a failure instead of a pass.
    let settled = false;
    void decision.then(() => { settled = true; }, () => { settled = true; });

    try {
      // Pre-fix the decision grabs `agents` immediately and holds it for the
      // whole window, so every probe fails with 55P03; post-fix it is parked on
      // the policy lock having touched nothing, so every probe succeeds.
      for (let i = 0; i < 5; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        await prober.transaction(async (tx) => {
          await tx
            .select({ id: agents.id })
            .from(agents)
            .where(eq(agents.id, pending.id))
            .for("update", { noWait: true });
        });
      }
      expect(settled).toBe(false);
    } finally {
      release();
      await held;
      await holder.$client.end();
      await prober.$client.end();
    }

    await expect(decision).resolves.toMatchObject({ applied: true });
    await expect(agentService(db).getById(pending.id)).resolves.toMatchObject({ status: "idle" });
  });
});
