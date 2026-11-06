import crypto, { randomUUID } from "node:crypto";

import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

// BLO-53674: the authority's GitHub calls are stubbed; everything downstream of
// them (the reviewer wake) runs against a real database.
const { activateGithubReviewGateDelivery, enqueueGithubReviewGateDelivery } = vi.hoisted(() => ({
  activateGithubReviewGateDelivery: vi.fn(),
  enqueueGithubReviewGateDelivery: vi.fn(),
}));

vi.mock("../services/github-review-gate-authority.js", () => ({
  activateGithubReviewGateDelivery,
  enqueueGithubReviewGateDelivery,
}));

import { githubWebhookRoutes } from "../routes/github-webhook.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("github review-gate revocation failure (BLO-53674)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;
  const webhookSecret = "review-gate-wake-test-secret";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-review-gate-wake-test-");
    db = createDb(tempDb.connectionString);
  });

  afterAll(async () => {
    await db.execute(sql.raw(
      `UPDATE "heartbeat_runs" SET status='failed', finished_at=NOW() WHERE status IN ('queued','running')`,
    ));
    await tempDb?.cleanup();
  });

  it("still wakes the reviewer for the pushed head, then answers 503", async () => {
    const companyId = randomUUID();
    const reviewerId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Test",
      issuePrefix: "BLO",
      defaultResponsibleUserId: "test-board-user",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: reviewerId,
      companyId,
      name: "Ally",
      role: "engineer",
      status: "idle",
      adapterType: "claude_k8s",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    enqueueGithubReviewGateDelivery.mockResolvedValue({
      matched: true,
      queued: true,
      duplicate: false,
      requiresRevocation: true,
      deliveryDbId: "durable-row",
      repoFullName: "Blockcast/penstock-llm-proxy-core",
      prNumber: 3145,
    });
    activateGithubReviewGateDelivery.mockResolvedValue({
      ok: false,
      reason: "review_gate_pull_http_403",
    });

    const app = express();
    app.use(express.json({
      verify: (req, _res, buf) => {
        (req as unknown as { rawBody: Buffer }).rawBody = buf;
      },
    }));
    app.use("/api/webhooks/github", githubWebhookRoutes(db, {
      webhookSecret,
      prReviewerAgentId: reviewerId,
      resolvePrReviewHeadSha: async () => null,
      resolveCiHeadSettlement: async () => "unknown" as const,
      runPrCommentReviewGateCheck: async () => ({ posted: false as const, reason: "not_configured" as const }),
      heartbeatOptions: {
        penstockAvailabilityGate: { checkAdapter: async () => ({ allow: true }), _resetForTesting: () => {} },
        skipQueuedRunDispatch: true,
      },
      reviewGateAuthority: {
        authorityEnabled: true,
        repositories: ["Blockcast/penstock-llm-proxy-core"],
        statusContext: "review/ally-complete",
        expectedAppId: "3966421",
        expectedInstallationId: "138085375",
      },
    }));

    const body = JSON.stringify({
      action: "synchronize",
      number: 3145,
      pull_request: {
        number: 3145,
        title: "penstock push",
        body: null,
        head: { ref: "fix/some-branch", sha: "c9cddceb00000000000000000000000000000000" },
        base: { ref: "main" },
      },
      repository: { full_name: "Blockcast/penstock-llm-proxy-core" },
    });
    const signature = `sha256=${crypto.createHmac("sha256", webhookSecret).update(body).digest("hex")}`;
    const res = await request(app)
      .post("/api/webhooks/github")
      .set("x-github-event", "pull_request")
      .set("x-github-delivery", "delivery-revocation-403")
      .set("x-hub-signature-256", signature)
      .set("content-type", "application/json")
      .send(body);

    expect(activateGithubReviewGateDelivery).toHaveBeenCalledWith(db, "durable-row");
    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      error: "github review-gate pending revocation failed",
      reason: "review_gate_pull_http_403",
    });
    const runs = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, reviewerId));
    expect(runs).toHaveLength(1);
  });
});
