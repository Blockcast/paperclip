import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb } from "@paperclipai/db";
import { buildHostServices } from "../services/plugin-host-services.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping plugin host issue status default tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const eventBusStub = {
  forPlugin() {
    return { emit: vi.fn(), subscribe: vi.fn(), clear: vi.fn() };
  },
} as any;

// BLO-40673: the alertmanager bridge creates assigned rows without a status.
// POST /api/issues defaults those to `todo`; the plugin host path used to fall
// through to the column default `backlog`, which no inbox dispatches.
describeEmbeddedPostgres("plugin host issues.create status default", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId = "";
  let agentId = "";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-issue-status-");
    db = createDb(tempDb.connectionString);
    const [company] = await db
      .insert(companies)
      .values({
        name: `Paperclip ${randomUUID()}`,
        issuePrefix: `P${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      })
      .returning();
    companyId = company!.id;
    agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "AlertOwner",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
    });
  }, 120_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function create(input: Record<string, unknown>) {
    const services = buildHostServices(db, "plugin-record-id", "paperclip-plugin-alertmanager", eventBusStub);
    try {
      return await services.issues.create({ companyId, title: `alert ${randomUUID()}`, ...input } as any);
    } finally {
      services.dispose();
    }
  }

  it("defaults an assigned row with no status to todo", async () => {
    expect((await create({ assigneeAgentId: agentId })).status).toBe("todo");
  });

  it("keeps an explicit status", async () => {
    expect((await create({ assigneeAgentId: agentId, status: "backlog" })).status).toBe("backlog");
  });

  it("leaves an unassigned row in backlog", async () => {
    expect((await create({})).status).toBe("backlog");
  });
});
