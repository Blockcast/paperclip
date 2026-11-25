import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRunRuntimePrompts,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import { readRuntimePrompt, stageRuntimePrompt } from "./runtime-prompt.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("readRuntimePrompt database semantics", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;
  let agentId: string;
  let runId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-runtime-prompt-");
    db = createDb(tempDb.connectionString);
  });

  afterEach(async () => {
    await db.delete(heartbeatRunRuntimePrompts);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedRunningRun() {
    companyId = randomUUID();
    agentId = randomUUID();
    runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Runtime Prompt Test",
      issuePrefix: `RP${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Runtime Prompt Agent",
      role: "engineer",
      adapterType: "opencode_k8s",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      contextSnapshot: {},
    });
  }

  it("atomically consumes a staged prompt, including concurrent reads", async () => {
    await seedRunningRun();
    const identity = { runId, companyId, agentId };
    const now = new Date("2026-11-25T00:00:00.000Z");

    await expect(stageRuntimePrompt(db, { ...identity, prompt: "rendered prompt" })).resolves.toBe(
      `/api/heartbeat-runs/${runId}/runtime-prompt`,
    );
    await expect(readRuntimePrompt(db, identity, now)).resolves.toEqual(Buffer.from("rendered prompt"));
    await expect(readRuntimePrompt(db, identity, now)).resolves.toBeNull();

    await stageRuntimePrompt(db, { ...identity, prompt: "concurrent prompt" });
    const concurrentReads = await Promise.all([
      readRuntimePrompt(db, identity, now),
      readRuntimePrompt(db, identity, now),
    ]);
    expect(concurrentReads.filter((prompt) => prompt !== null)).toEqual([
      Buffer.from("concurrent prompt"),
    ]);
    expect(concurrentReads.filter((prompt) => prompt === null)).toHaveLength(1);
  });
});
