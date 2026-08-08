import crypto from "node:crypto";

import type { Db } from "@paperclipai/db";
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { activateGithubReviewGateDelivery, enqueueGithubReviewGateDelivery } = vi.hoisted(() => ({
  activateGithubReviewGateDelivery: vi.fn(),
  enqueueGithubReviewGateDelivery: vi.fn(),
}));

vi.mock("../services/github-review-gate-authority.js", () => ({
  activateGithubReviewGateDelivery,
  enqueueGithubReviewGateDelivery,
}));

import { githubWebhookRoutes } from "../routes/github-webhook.js";

const webhookSecret = "review-gate-route-test-secret";
const reviewGateAuthority = {
  repositories: ["Blockcast/penstock-llm-proxy-core"],
  statusContext: "review/ally-complete",
  expectedAppId: "3966421",
  expectedInstallationId: "138085375",
} as const;
const db = {} as Db;

function buildApp(routeDb: Db = db) {
  const app = express();
  app.use(
    express.json({
      verify: (req, _res, buffer) => {
        (req as unknown as { rawBody: Buffer }).rawBody = buffer;
      },
    }),
  );
  app.use(
    "/api/webhooks/github",
    githubWebhookRoutes(routeDb, {
      webhookSecret,
      reviewGateAuthority,
    }),
  );
  return app;
}

function signedRequest(payload: Record<string, unknown>) {
  const body = JSON.stringify(payload);
  const signature = `sha256=${crypto
    .createHmac("sha256", webhookSecret)
    .update(Buffer.from(body, "utf8"))
    .digest("hex")}`;
  return { body, signature };
}

async function postWebhook(input: {
  eventName: string;
  deliveryId: string;
  payload: Record<string, unknown>;
  signature?: string;
  routeDb?: Db;
}) {
  const signed = signedRequest(input.payload);
  return request(buildApp(input.routeDb))
    .post("/api/webhooks/github")
    .set("content-type", "application/json")
    .set("x-github-event", input.eventName)
    .set("x-github-delivery", input.deliveryId)
    .set("x-hub-signature-256", input.signature ?? signed.signature)
    .send(signed.body);
}

describe("github review-gate authority route", () => {
  beforeEach(() => {
    activateGithubReviewGateDelivery.mockReset();
    activateGithubReviewGateDelivery.mockResolvedValue({ ok: true });
    enqueueGithubReviewGateDelivery.mockReset();
  });

  it("passes the verified raw delivery to the durable inbox before acknowledging", async () => {
    enqueueGithubReviewGateDelivery.mockResolvedValue({
      matched: true,
      queued: true,
      duplicate: false,
      requiresRevocation: true,
      deliveryDbId: "durable-row",
      repoFullName: "Blockcast/penstock-llm-proxy-core",
      prNumber: 1085,
    });
    const payload = {
      action: "synchronize",
      repository: { full_name: "Blockcast/penstock-llm-proxy-core" },
    };

    const response = await postWebhook({
      eventName: "pull_request",
      deliveryId: "delivery-durable",
      payload,
    });

    expect(response.status).toBe(202);
    expect(response.body).toEqual({
      ok: true,
      reviewGateDeliveryQueued: true,
      deliveryId: "delivery-durable",
      duplicate: false,
    });
    expect(enqueueGithubReviewGateDelivery).toHaveBeenCalledOnce();
    expect(enqueueGithubReviewGateDelivery).toHaveBeenCalledWith({
      db,
      eventName: "pull_request",
      deliveryId: "delivery-durable",
      rawBody: Buffer.from(JSON.stringify(payload), "utf8"),
      payload,
      config: reviewGateAuthority,
    });
    expect(activateGithubReviewGateDelivery).toHaveBeenCalledWith(db, "durable-row");
  });

  it("returns a retryable failure when the synchronous pending revocation fails", async () => {
    enqueueGithubReviewGateDelivery.mockResolvedValue({
      matched: true,
      queued: true,
      duplicate: false,
      requiresRevocation: true,
      deliveryDbId: "durable-row",
      repoFullName: "Blockcast/penstock-llm-proxy-core",
      prNumber: 1085,
    });
    activateGithubReviewGateDelivery.mockResolvedValue({
      ok: false,
      reason: "review_gate_status_http_503",
    });

    const response = await postWebhook({
      eventName: "pull_request",
      deliveryId: "delivery-revocation-failed",
      payload: {
        action: "edited",
        repository: { full_name: "Blockcast/penstock-llm-proxy-core" },
      },
    });

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      error: "github review-gate pending revocation failed",
      reason: "review_gate_status_http_503",
    });
  });

  it("returns the durable receipt only after legacy wake processing completes", async () => {
    enqueueGithubReviewGateDelivery.mockResolvedValue({
      matched: true,
      queued: true,
      duplicate: false,
      deliveryDbId: "durable-row",
      repoFullName: "Blockcast/penstock-llm-proxy-core",
      prNumber: 1085,
    });
    let releaseLegacyRead!: (rows: unknown[]) => void;
    const legacyRead = new Promise<unknown[]>((resolve) => {
      releaseLegacyRead = resolve;
    });
    const routeDb = {
      select: () => ({ from: () => legacyRead }),
    } as unknown as Db;

    let settled = false;
    const responsePromise = postWebhook({
      eventName: "pull_request",
      deliveryId: "delivery-legacy-complete",
      routeDb,
      payload: {
        action: "synchronize",
        repository: { full_name: "Blockcast/penstock-llm-proxy-core" },
        number: 1085,
        pull_request: {
          number: 1085,
          title: "PEN-2073 durable review gate",
          body: "",
          html_url: "https://github.com/Blockcast/penstock-llm-proxy-core/pull/1085",
          head: {
            ref: "kkroo/pen-2073-review-gate",
            sha: "1111111111111111111111111111111111111111",
          },
          base: { ref: "main" },
        },
      },
    }).then((response) => {
      settled = true;
      return response;
    });

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(settled).toBe(false);
    releaseLegacyRead([]);
    const response = await responsePromise;

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({
      reviewGateDeliveryQueued: true,
      deliveryId: "delivery-legacy-complete",
    });
  });

  it("rejects a duplicate delivery id carrying a conflicting payload", async () => {
    enqueueGithubReviewGateDelivery.mockResolvedValue({
      matched: true,
      queued: false,
      reason: "delivery_id_payload_conflict",
      repoFullName: "Blockcast/penstock-llm-proxy-core",
      prNumber: 1085,
    });

    const response = await postWebhook({
      eventName: "pull_request_review",
      deliveryId: "delivery-conflict",
      payload: { action: "dismissed" },
    });

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      error: "github review-gate delivery was not queued",
      reason: "delivery_id_payload_conflict",
    });
  });

  it("fails closed when a matched authority delivery cannot be queued", async () => {
    enqueueGithubReviewGateDelivery.mockResolvedValue({
      matched: true,
      queued: false,
      reason: "expected_app_id_not_configured",
      repoFullName: "Blockcast/penstock-llm-proxy-core",
      prNumber: 1085,
    });

    const response = await postWebhook({
      eventName: "pull_request_review",
      deliveryId: "delivery-unconfigured",
      payload: { action: "dismissed" },
    });

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      error: "github review-gate delivery was not queued",
      reason: "expected_app_id_not_configured",
    });
  });

  it("never touches the durable inbox for an invalid HMAC", async () => {
    const response = await postWebhook({
      eventName: "pull_request",
      deliveryId: "delivery-invalid-hmac",
      payload: { action: "synchronize" },
      signature: `sha256=${"0".repeat(64)}`,
    });

    expect(response.status).toBe(401);
    expect(enqueueGithubReviewGateDelivery).not.toHaveBeenCalled();
  });

  it("acknowledges a signed event that is outside the authority allowlist", async () => {
    enqueueGithubReviewGateDelivery.mockResolvedValue({
      matched: false,
      reason: "event_not_gate_relevant",
    });

    const response = await postWebhook({
      eventName: "push",
      deliveryId: "delivery-ignored",
      payload: { repository: { full_name: "Blockcast/penstock-llm-proxy-core" } },
    });

    expect(response.status).toBe(200);
    expect(enqueueGithubReviewGateDelivery).toHaveBeenCalledOnce();
  });
});
