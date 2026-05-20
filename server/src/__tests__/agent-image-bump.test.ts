import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { selectEligibleAgentsForImageBump } from "../services/agent-image-bump.js";

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
