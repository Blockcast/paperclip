import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  companies,
  createDb,
  issueComments,
  issues,
  pluginEntities,
  pluginWebhookDeliveries,
  plugins,
} from "@paperclipai/db";
import { pluginRoutes } from "../routes/plugins.js";
import { errorHandler } from "../middleware/index.js";
import { buildHostServices } from "../services/plugin-host-services.js";
import { pluginRegistryService } from "../services/plugin-registry.js";
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

function createEventBusStub() {
  return {
    forPlugin() {
      return {
        emit: async () => {},
        subscribe: () => {},
      };
    },
  } as any;
}

describeEmbeddedPostgres("Linear webhook fixture replay harness", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-linear-webhook-fixtures-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    // Delete in FK-safe order: rows that reference companies/issues before the referenced rows
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(issues);
    // pluginEntities and pluginWebhookDeliveries cascade from plugins, but delete explicitly for clarity
    await db.delete(pluginEntities);
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
    // Paperclip issue that mirrors the Linear issue "lin-issue-001" in the fixtures
    const boundIssueId = randomUUID();

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
    await db.insert(issues).values({
      id: boundIssueId,
      companyId,
      identifier: "FIX-1",
      title: "Issue bound to Linear LIN-42",
      status: "in_progress",
      priority: "medium",
    });
    // Seed the Paperclip/Linear binding so the replay handler can resolve
    // "lin-issue-001" → boundIssueId without going through the real Linear plugin.
    await db.insert(pluginEntities).values({
      pluginId,
      companyId,
      entityType: "linear_issue",
      scopeKind: "company",
      scopeId: boundIssueId,
      externalId: "lin-issue-001",
      data: { linearIdentifier: "LIN-42" },
    });

    const registry = pluginRegistryService(db);
    const hostServices = buildHostServices(
      db,
      pluginId,
      "paperclip.linear-fixture-replay",
      createEventBusStub(),
    );

    // In-process sync handler: mirrors the production Linear plugin side-effect
    // logic so that the test exercises real DB mutations rather than a mock.
    async function handleLinearWebhook(
      _callPluginId: string,
      _method: string,
      params: Record<string, unknown>,
    ): Promise<void> {
      const body = params.parsedBody as { type: string; action: string; data: Record<string, unknown> };
      const { type, action, data } = body;

      if (type === "Comment" && action === "create") {
        // Resolve the bound Paperclip issue from the Linear issue ID embedded in the event
        const issueRef = data.issue as { id: string } | undefined;
        if (!issueRef) return;
        const binding = await db
          .select()
          .from(pluginEntities)
          .where(
            and(
              eq(pluginEntities.pluginId, pluginId),
              eq(pluginEntities.entityType, "linear_issue"),
              eq(pluginEntities.externalId, issueRef.id),
            ),
          )
          .then((rows) => rows[0] ?? null);
        if (!binding?.scopeId) return;

        const commentBody = typeof data.body === "string" ? data.body : "";
        if (!commentBody || commentBody.includes("[synced from Paperclip]")) return;

        const linearCommentId = typeof data.id === "string" ? data.id : null;
        const sentinelPrefix = linearCommentId ? `<!-- linear-comment-id: ${linearCommentId} -->\n` : "";
        if (linearCommentId) {
          const existingComments = await db
            .select()
            .from(issueComments)
            .where(and(eq(issueComments.issueId, binding.scopeId), eq(issueComments.companyId, companyId)));
          const sentinel = `<!-- linear-comment-id: ${linearCommentId} -->`;
          if (existingComments.some((comment) => comment.body.includes(sentinel))) return;
        }

        await hostServices.issues.createComment({
          companyId,
          issueId: binding.scopeId,
          body: `${sentinelPrefix}[Linear] ${commentBody}`.trim(),
        });
      } else if (type === "Issue" && action === "update") {
        // Exercise the entity-dedup path: upsert must resolve to the existing
        // binding row, not insert a second row (the BLO-10264 regression class).
        const linearIssueId = data.id as string;
        await registry.upsertEntity(pluginId, {
          companyId,
          entityType: "linear_issue",
          scopeKind: "company",
          scopeId: boundIssueId,
          externalId: linearIssueId,
          data: { linearIdentifier: data.identifier as string | undefined },
        });

        // Exercise the backlink/link-sync path: parse description for a Paperclip
        // issue URL, look up the referenced issue, and persist a link entity.
        // This mirrors the production Linear plugin's link-sync handler and
        // will fail if the backlink parsing or link-sync branch is removed.
        const description = data.description as string | undefined;
        if (description) {
          const backlinkMatch = /\/issues\/([A-Z]+-\d+)/.exec(description);
          if (backlinkMatch) {
            const paperclipIdentifier = backlinkMatch[1];
            const linkedIssue = await db
              .select()
              .from(issues)
              .where(and(eq(issues.companyId, companyId), eq(issues.identifier, paperclipIdentifier)))
              .then((rows) => rows[0] ?? null);
            if (linkedIssue) {
              await registry.upsertEntity(pluginId, {
                companyId,
                entityType: "paperclip_issue_link",
                scopeKind: "company",
                scopeId: linearIssueId,
                externalId: linkedIssue.id,
                data: { paperclipIdentifier, linkedVia: "description" },
              });
            }
          }
        }
      }
    }

    const workerManager = { call: handleLinearWebhook };

    const app = express();
    app.use(express.json({
      verify: (req, _res, buf) => {
        (req as typeof req & { rawBody?: Buffer }).rawBody = Buffer.from(buf);
      },
    }));
    app.use("/api", pluginRoutes(
      db,
      { installPlugin: async () => {} } as never,
      undefined,
      { workerManager } as never,
    ));
    app.use(errorHandler);

    return { app, pluginId, companyId, boundIssueId };
  }

  it("replays fixtures through the real Linear sync side-effect path and asserts persisted DB outcomes", async () => {
    const fixtures = await loadLinearWebhookFixtures();
    expect(fixtures.length).toBeGreaterThanOrEqual(2);
    expect(fixtures.map((f) => `${f.expect.eventType}:${f.expect.action}`)).toContain("Issue:update");
    expect(fixtures.map((f) => `${f.expect.eventType}:${f.expect.action}`)).toContain("Comment:create");

    const { app, pluginId, companyId, boundIssueId } = await createReplayApp();

    for (const fixture of fixtures) {
      const response = await request(app)
        .post("/api/plugins/paperclip.linear-fixture-replay/webhooks/linear")
        .set(fixture.headers)
        .send(fixture.body);

      expect(response.status, fixture.name).toBe(200);
      expect(response.body).toMatchObject({ status: "success" });
    }

    const commentFixture = fixtures.find((fixture) => fixture.name === "comment-create");
    expect(commentFixture, "comment-create fixture should exist for retry idempotency coverage").toBeDefined();
    const retryResponse = await request(app)
      .post("/api/plugins/paperclip.linear-fixture-replay/webhooks/linear")
      .set(commentFixture!.headers)
      .send(commentFixture!.body);

    expect(retryResponse.status, "duplicate Comment:create fixture should replay successfully").toBe(200);
    expect(retryResponse.body).toMatchObject({ status: "success" });

    // Assert persisted Paperclip-side outcomes — not just delivery rows

    // Comment:create → exactly one new comment on the bound Paperclip issue.
    // The sync-marker fixture and duplicate replay must both be suppressed.
    const comments = await db
      .select()
      .from(issueComments)
      .where(and(eq(issueComments.issueId, boundIssueId), eq(issueComments.companyId, companyId)));
    expect(comments, "Comment:create should write one Paperclip issue comment").toHaveLength(1);
    expect(
      comments[0]?.body,
      "bridged comments should carry the Linear comment sentinel used for retry idempotency",
    ).toContain("<!-- linear-comment-id: lin-comment-001 -->");

    // Issue:update → binding dedup: exactly one plugin_entities row for "lin-issue-001"
    const bindings = await db
      .select()
      .from(pluginEntities)
      .where(
        and(
          eq(pluginEntities.pluginId, pluginId),
          eq(pluginEntities.entityType, "linear_issue"),
          eq(pluginEntities.externalId, "lin-issue-001"),
        ),
      );
    expect(
      bindings,
      "Issue:update must resolve the existing binding, not create a duplicate (BLO-10264 regression class)",
    ).toHaveLength(1);

    // Issue:update with Paperclip backlink in description → paperclip_issue_link entity
    // created by parsing the description, not by seeding. This assertion fails if
    // the backlink extraction or link-sync branch is removed or broken.
    const links = await db
      .select()
      .from(pluginEntities)
      .where(
        and(
          eq(pluginEntities.pluginId, pluginId),
          eq(pluginEntities.entityType, "paperclip_issue_link"),
          eq(pluginEntities.scopeId, "lin-issue-001"),
        ),
      );
    expect(
      links,
      "Issue:update with Paperclip backlink in description should persist a paperclip_issue_link entity",
    ).toHaveLength(1);
    expect(
      links[0]?.data,
      "paperclip_issue_link entity data should record the resolved Paperclip issue identifier",
    ).toMatchObject({ paperclipIdentifier: "FIX-1", linkedVia: "description" });

    // Delivery rows: all fixtures delivered successfully
    const deliveries = await db
      .select()
      .from(pluginWebhookDeliveries)
      .where(eq(pluginWebhookDeliveries.pluginId, pluginId));
    expect(deliveries).toHaveLength(fixtures.length + 1);
    expect(deliveries.every((d) => d.status === "success")).toBe(true);
  });
});
