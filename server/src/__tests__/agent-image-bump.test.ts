import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import { sql } from "drizzle-orm";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { selectEligibleAgentsForImageBump, isAgentInFlight } from "../services/agent-image-bump.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres agent-image-bump tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("selectEligibleAgentsForImageBump", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-image-bump-");
    db = createDb(tempDb.connectionString);
  });

  afterEach(async () => {
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("returns only eligible agents that have an image different from targetImage", async () => {
    const companyId = randomUUID();
    const oldImage = "ghcr.io/paperclip/agent:sha-aabbccdd";
    const newImage = "ghcr.io/paperclip/agent:sha-11223344";

    await db.insert(companies).values({
      id: companyId,
      name: "BumpTest Co",
      issuePrefix: `BT${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const [eligibleClaudeAgent] = await db
      .insert(agents)
      .values({
        companyId,
        name: "EligibleClaudeAgent",
        adapterType: "claude_k8s",
        adapterConfig: { image: oldImage },
        runtimeConfig: {},
        permissions: {},
      })
      .returning();

    const [eligibleOpencodeAgent] = await db
      .insert(agents)
      .values({
        companyId,
        name: "EligibleOpencodeAgent",
        adapterType: "opencode_k8s",
        adapterConfig: { image: oldImage },
        runtimeConfig: {},
        permissions: {},
      })
      .returning();

    const [alreadyOnTarget] = await db
      .insert(agents)
      .values({
        companyId,
        name: "AlreadyOnTarget",
        adapterType: "claude_k8s",
        adapterConfig: { image: newImage },
        runtimeConfig: {},
        permissions: {},
      })
      .returning();

    const [noImageSet] = await db
      .insert(agents)
      .values({
        companyId,
        name: "NoImageSet",
        adapterType: "claude_k8s",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      })
      .returning();

    const [wrongAdapter] = await db
      .insert(agents)
      .values({
        companyId,
        name: "WrongAdapter",
        adapterType: "chatjimmy",
        adapterConfig: { image: oldImage },
        runtimeConfig: {},
        permissions: {},
      })
      .returning();

    const result = await selectEligibleAgentsForImageBump(db, {
      companyId,
      targetImage: newImage,
    });

    const resultIds = result.map((a) => a.id).sort();

    expect(resultIds).toEqual(
      [eligibleClaudeAgent!.id, eligibleOpencodeAgent!.id].sort(),
    );

    const excludedIds = [alreadyOnTarget!.id, noImageSet!.id, wrongAdapter!.id];
    for (const excludedId of excludedIds) {
      expect(resultIds).not.toContain(excludedId);
    }
  });
});

describeEmbeddedPostgres("isAgentInFlight", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-in-flight-");
    db = createDb(tempDb.connectionString);
  });

  afterEach(async () => {
    await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createTestAgent(db: ReturnType<typeof createDb>) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "InFlightTest Co",
      issuePrefix: `IF${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const [agent] = await db
      .insert(agents)
      .values({
        companyId,
        name: "InFlightTestAgent",
        adapterType: "claude_k8s",
        adapterConfig: { image: "harbor.example/a:old" },
        runtimeConfig: {},
        permissions: {},
      })
      .returning();
    return { companyId, agent: agent! };
  }

  it("returns true when agent has a running heartbeat run", async () => {
    const { companyId, agent } = await createTestAgent(db);
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId: agent.id,
      status: "running",
    });
    await expect(isAgentInFlight(db, agent.id)).resolves.toBe(true);
  });

  it("returns true when agent has a queued heartbeat run", async () => {
    const { companyId, agent } = await createTestAgent(db);
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId: agent.id,
      status: "queued",
    });
    await expect(isAgentInFlight(db, agent.id)).resolves.toBe(true);
  });

  it("returns false when agent only has terminal runs", async () => {
    const { companyId, agent } = await createTestAgent(db);
    await db.insert(heartbeatRuns).values([
      { companyId, agentId: agent.id, status: "succeeded" },
      { companyId, agentId: agent.id, status: "failed" },
    ]);
    await expect(isAgentInFlight(db, agent.id)).resolves.toBe(false);
  });

  it("returns false when agent has no heartbeat runs and k8s client unavailable", async () => {
    // Exercises the k8s-confirm fallback path: zero DB rows means we fall
    // through to hasActiveJobForAgent, which in the test environment (no
    // KUBERNETES_SERVICE_HOST) returns false. Together: false || false === false.
    // This guards against regressions in the AGENT_ID_LABEL constant — if it
    // ever stops matching prod label names, the k8s lookup silently returns
    // no Jobs, and this test stays green. The real guard is integration:
    // production verification that the label string matches kubectl output.
    const { agent } = await createTestAgent(db);
    await expect(isAgentInFlight(db, agent.id)).resolves.toBe(false);
  });
});
