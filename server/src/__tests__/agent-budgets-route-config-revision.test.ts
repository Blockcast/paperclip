import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentConfigRevisions,
  agents,
  budgetPolicies,
  companies,
  createDb,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { costRoutes } from "../routes/costs.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres budgets-route revision tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

type Db = ReturnType<typeof createDb>;
type CompanyRow = typeof companies.$inferSelect;

function issuePrefix(id: string) {
  return `T${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
}

function boardActor(company: CompanyRow): Express.Request["actor"] {
  return {
    type: "board",
    userId: "board-user",
    companyIds: [company.id],
    memberships: [{ companyId: company.id, membershipRole: "operator", status: "active" }],
    isInstanceAdmin: true,
    source: "local_implicit",
  };
}

function createApp(db: Db, actor: Express.Request["actor"]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", costRoutes(db));
  app.use(errorHandler);
  return app;
}

/**
 * Regression cover for BLO-20121: `PATCH /api/agents/:agentId/budgets` used to
 * call `agents.update` without `recordRevision`, so every cap set through it was
 * invisible to `agent_config_revisions`. That silently under-reported the
 * cap-raise audit from BLO-19934 — the audit could see *that* a cap moved but
 * had no actor for it, and the revision chain showed gaps where a row's
 * `before` did not match the previous row's `after`.
 */
describeEmbeddedPostgres("PATCH /agents/:agentId/budgets records a config revision", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-budgets-route-revision-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(agentConfigRevisions);
    await db.delete(budgetPolicies);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed(budgetMonthlyCents = 500_000) {
    const companyId = randomUUID();
    const [company] = await db
      .insert(companies)
      .values({ id: companyId, name: "Paperclip", issuePrefix: issuePrefix(companyId) })
      .returning();
    const [agent] = await db
      .insert(agents)
      .values({
        companyId,
        name: "MulticastEngineer",
        role: "engineer",
        title: "Software Engineer",
        capabilities: "Delivers multicast work",
        adapterType: "process",
        adapterConfig: { command: "echo safe" },
        budgetMonthlyCents,
      })
      .returning();
    return { company: company!, agent: agent! };
  }

  function revisionsFor(agentId: string) {
    return db
      .select()
      .from(agentConfigRevisions)
      .where(eq(agentConfigRevisions.agentId, agentId));
  }

  function chainFrom(
    revisions: Awaited<ReturnType<typeof revisionsFor>>,
    initialBudgetMonthlyCents: number,
  ) {
    const chain = [];
    const visited = new Set<string>();
    let budgetMonthlyCents = initialBudgetMonthlyCents;
    while (true) {
      const revision = revisions.find(
        (row) =>
          !visited.has(row.id)
          && row.beforeConfig.budgetMonthlyCents === budgetMonthlyCents,
      );
      if (!revision) return chain;
      visited.add(revision.id);
      chain.push(revision);
      budgetMonthlyCents = revision.afterConfig.budgetMonthlyCents as number;
    }
  }

  it("writes exactly one attributed budgetMonthlyCents revision per cap change", async () => {
    const { company, agent } = await seed(500_000);
    const app = createApp(db, boardActor(company));

    expect(await revisionsFor(agent.id)).toHaveLength(0);

    const res = await request(app)
      .patch(`/api/agents/${agent.id}/budgets`)
      .send({ budgetMonthlyCents: 800_000 });

    expect(res.status).toBe(200);
    expect(res.body.budgetMonthlyCents).toBe(800_000);

    const revisions = await revisionsFor(agent.id);
    expect(revisions).toHaveLength(1);
    const [revision] = revisions;
    expect(revision!.changedKeys).toEqual(["budgetMonthlyCents"]);
    expect(revision!.beforeConfig.budgetMonthlyCents).toBe(500_000);
    expect(revision!.afterConfig.budgetMonthlyCents).toBe(800_000);
    // The audit needs an actor, not just a delta. This route is assertBoard-gated,
    // so the actor is always a board user and createdByAgentId is always null.
    expect(revision!.createdByUserId).toBe("board-user");
    expect(revision!.createdByAgentId).toBeNull();
    // Distinct from the "patch" source used by PATCH /agents/:id, so the audit
    // can tell which route moved a cap.
    expect(revision!.source).toBe("budgets-patch");
    expect(revision!.companyId).toBe(company.id);

    const policies = await db
      .select()
      .from(budgetPolicies)
      .where(eq(budgetPolicies.scopeId, agent.id));
    expect(policies).toHaveLength(1);
    expect(policies[0]).toMatchObject({
      companyId: company.id,
      scopeType: "agent",
      amount: 800_000,
      isActive: true,
    });
  });

  it("leaves a contiguous chain across successive cap changes", async () => {
    const { company, agent } = await seed(0);
    const app = createApp(db, boardActor(company));

    for (const cap of [500_000, 800_000, 1_100_000]) {
      const res = await request(app)
        .patch(`/api/agents/${agent.id}/budgets`)
        .send({ budgetMonthlyCents: cap });
      expect(res.status).toBe(200);
    }

    const revisions = await revisionsFor(agent.id);
    expect(revisions).toHaveLength(3);
    const chain = chainFrom(revisions, 0);
    expect(chain.map((row) => row.beforeConfig.budgetMonthlyCents)).toEqual([0, 500_000, 800_000]);
    expect(chain.map((row) => row.afterConfig.budgetMonthlyCents)).toEqual([
      500_000,
      800_000,
      1_100_000,
    ]);
    // Every row's `before` equals the prior row's `after` — the property whose
    // absence is how the gap was originally detected.
    for (let i = 1; i < chain.length; i += 1) {
      expect(chain[i]!.beforeConfig.budgetMonthlyCents).toBe(
        chain[i - 1]!.afterConfig.budgetMonthlyCents,
      );
    }
    expect(chain.every((row) => row.source === "budgets-patch")).toBe(true);
    expect(chain.every((row) => row.createdByUserId === "board-user")).toBe(true);
  });

  it("serializes concurrent cap changes across the mirror, policy, and revision chain", async () => {
    const { company, agent } = await seed(500_000);
    const app = createApp(db, boardActor(company));

    const responses = await Promise.all(
      [800_000, 1_100_000].map((budgetMonthlyCents) =>
        request(app)
          .patch(`/api/agents/${agent.id}/budgets`)
          .send({ budgetMonthlyCents }),
      ),
    );

    expect(responses.map((response) => response.status)).toEqual([200, 200]);

    const [storedAgent] = await db.select().from(agents).where(eq(agents.id, agent.id));
    const [policy] = await db
      .select()
      .from(budgetPolicies)
      .where(eq(budgetPolicies.scopeId, agent.id));
    const revisions = await revisionsFor(agent.id);

    expect(revisions).toHaveLength(2);
    const chain = chainFrom(revisions, 500_000);
    expect(chain).toHaveLength(2);
    expect(chain[1]!.beforeConfig.budgetMonthlyCents).toBe(
      chain[0]!.afterConfig.budgetMonthlyCents,
    );
    expect(chain[1]!.afterConfig.budgetMonthlyCents).toBe(storedAgent!.budgetMonthlyCents);
    expect(policy!.amount).toBe(storedAgent!.budgetMonthlyCents);
  });

  it("does not record a revision when the cap is rewritten to its current value", async () => {
    const { company, agent } = await seed(500_000);
    const app = createApp(db, boardActor(company));

    const res = await request(app)
      .patch(`/api/agents/${agent.id}/budgets`)
      .send({ budgetMonthlyCents: 500_000 });

    expect(res.status).toBe(200);
    // A no-op write must not inflate the chain, or the audit reads repeated
    // idempotent writes as repeated cap raises.
    expect(await revisionsFor(agent.id)).toHaveLength(0);
  });
});
