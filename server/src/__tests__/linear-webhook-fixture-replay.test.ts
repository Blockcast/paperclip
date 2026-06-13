import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  companies,
  createDb,
  pluginWebhookDeliveries,
  plugins,
} from "@paperclipai/db";
import { pluginRoutes } from "../routes/plugins.js";
import { errorHandler } from "../middleware/index.js";
import { loadLinearWebhookFixtures } from "../services/linear-webhook-fixtures.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping Linear webhook fixture replay tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("Linear webhook fixture replay harness", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-linear-webhook-fixtures-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(pluginWebhookDeliveries);
    await db.delete(plugins);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createReplayApp() {
    const pluginId = randomUUID();
    const companyId = randomUUID();
    const workerManager = {
      call: vi.fn().mockResolvedValue(undefined),
    };

    await db.insert(companies).values({
      id: companyId,
      name: "Fixture Replay Co",
      issuePrefix: "FIX",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "paperclip.linear-fixture-replay",
      packageName: "@paperclipai/plugin-linear-fixture-replay",
      version: "0.0.0-test",
      status: "ready",
      manifestJson: {
        id: "paperclip.linear-fixture-replay",
        apiVersion: 1,
        version: "0.0.0-test",
        displayName: "Linear Fixture Replay",
        description: "Test plugin for replaying sanitized Linear webhook fixtures",
        author: "Paperclip",
        categories: ["connector"],
        capabilities: ["webhooks.receive"],
        entrypoints: { worker: "dist/worker.js" },
        webhooks: [
          {
            endpointKey: "linear",
            displayName: "Linear webhook",
            description: "Receives sanitized Linear webhook fixtures",
          },
        ],
      },
    });

    const app = express();
    app.use(express.json({
      verify: (req, _res, buf) => {
        (req as typeof req & { rawBody?: Buffer }).rawBody = Buffer.from(buf);
      },
    }));
    app.use("/api", pluginRoutes(
      db,
      { installPlugin: vi.fn() } as never,
      undefined,
      { workerManager } as never,
    ));
    app.use(errorHandler);

    return { app, pluginId, workerManager };
  }

  it("replays committed sanitized fixtures through the plugin webhook delivery path", async () => {
    const fixtures = await loadLinearWebhookFixtures();
    expect(fixtures.length).toBeGreaterThanOrEqual(2);
    expect(fixtures.map((fixture) => `${fixture.expect.eventType}:${fixture.expect.action}`)).toContain("Issue:update");
    expect(fixtures.some((fixture) => fixture.expect.paperclipSideEffects.some((effect) => effect.includes("duplicate")))).toBe(true);

    const { app, pluginId, workerManager } = await createReplayApp();

    for (const fixture of fixtures) {
      const response = await request(app)
        .post("/api/plugins/paperclip.linear-fixture-replay/webhooks/linear")
        .set(fixture.headers)
        .send(fixture.body);

      expect(response.status, fixture.name).toBe(200);
      expect(response.body).toMatchObject({ status: "success" });
    }

    expect(workerManager.call).toHaveBeenCalledTimes(fixtures.length);
    for (const [index, fixture] of fixtures.entries()) {
      expect(workerManager.call).toHaveBeenNthCalledWith(
        index + 1,
        pluginId,
        "handleWebhook",
        expect.objectContaining({
          endpointKey: "linear",
          parsedBody: fixture.body,
          rawBody: JSON.stringify(fixture.body),
        }),
      );
    }

    const deliveries = await db
      .select()
      .from(pluginWebhookDeliveries)
      .where(eq(pluginWebhookDeliveries.pluginId, pluginId));
    expect(deliveries).toHaveLength(fixtures.length);
    expect(deliveries.every((delivery) => delivery.status === "success")).toBe(true);

    console.log(
      `Linear webhook fixture replay: replayed ${fixtures.length} fixtures; asserted issue/comment/link side-effect expectations and ${deliveries.length} successful delivery rows.`,
    );
  });
});
