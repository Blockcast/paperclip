import { createHmac } from "node:crypto";

import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { registerBodyParsers } from "../http/body-parsers.js";
import { COMPANY_IMPORT_API_PATH } from "../routes/company-import-paths.js";

const mockRegistry = vi.hoisted(() => ({
  getById: vi.fn(),
  getByKey: vi.fn(),
  upsertConfig: vi.fn(),
}));

const mockLifecycle = vi.hoisted(() => ({
  load: vi.fn(),
  upgrade: vi.fn(),
  unload: vi.fn(),
  enable: vi.fn(),
  disable: vi.fn(),
}));

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => mockRegistry,
}));

vi.mock("../services/plugin-lifecycle.js", () => ({
  pluginLifecycleManager: () => mockLifecycle,
}));

vi.mock("../services/activity-log.js", () => ({ logActivity: vi.fn() }));
vi.mock("../services/live-events.js", () => ({ publishGlobalLiveEvent: vi.fn() }));

const PLUGIN_ID = "11111111-1111-4111-8111-111111111111";

function readyPluginWithSlackEvents() {
  mockRegistry.getById.mockResolvedValue({
    id: PLUGIN_ID,
    pluginKey: "paperclip-plugin-slack",
    version: "1.0.0",
    status: "ready",
    manifestJson: {
      capabilities: ["webhooks.receive"],
      // Both Events API and interactivity endpoints are declared so the
      // webhook route accepts deliveries on either key.
      webhooks: [
        { endpointKey: "slack-events" },
        { endpointKey: "slack-interactivity" },
      ],
    },
  });
}

/**
 * Minimal chainable Drizzle stub: supports the
 * `insert().values().returning()` and `update().set().where()` chains the
 * webhook route uses to record the delivery. Returning a real delivery id lets
 * the route proceed past the DB write and reach the worker dispatch, so tests
 * can assert on the forwarded `handleWebhook` payload.
 */
function deliveryRecordingDbStub() {
  return {
    insert: () => ({
      values: () => ({
        returning: async () => [{ id: "delivery-test-1" }],
      }),
    }),
    update: () => ({
      set: () => ({
        where: async () => undefined,
      }),
    }),
  } as never;
}

async function createApp(db: unknown = {}) {
  const [{ pluginRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/plugins.js"),
    import("../middleware/index.js"),
  ]);

  const workerManager = {
    call: vi.fn(),
    isRunning: vi.fn(() => true),
  };
  const webhookDeps = { workerManager } as never;

  const app = express();
  // Use the real production body-parser registration so this test guards the
  // actual wiring — in particular that `application/x-www-form-urlencoded`
  // requests (Slack interactivity / slash commands) capture `req.rawBody` and
  // populate `req.body`. See registerBodyParsers (BLO-8857).
  registerBodyParsers(app, { companyImportPath: COMPANY_IMPORT_API_PATH });
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = {
      type: "board",
      userId: "admin-1",
      source: "session",
      isInstanceAdmin: true,
      companyIds: [],
    };
    next();
  });
  app.use("/api", pluginRoutes(
    db as never,
    { installPlugin: vi.fn() } as never,
    undefined,
    webhookDeps,
    undefined,
    undefined,
  ));
  app.use(errorHandler);

  return { app, workerManager };
}

// Mirrors verifySlackSignature() in the Slack plugin worker
// (packages/plugins/paperclip-plugin-slack/src/worker.ts): the base string is
// `v0:<timestamp>:<rawBody>` and the signature is `v0=<hmac-sha256-hex>`.
const SLACK_SIGNING_SECRET = "test-slack-signing-secret";
function slackSignature(timestamp: string, rawBody: string): string {
  const hmac = createHmac("sha256", SLACK_SIGNING_SECRET)
    .update(`v0:${timestamp}:${rawBody}`)
    .digest("hex");
  return `v0=${hmac}`;
}

describe("plugin webhook url_verification handshake", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("echoes Slack's challenge token without invoking the worker", async () => {
    readyPluginWithSlackEvents();
    const { app, workerManager } = await createApp();

    const res = await request(app)
      .post(`/api/plugins/${PLUGIN_ID}/webhooks/slack-events`)
      .send({ type: "url_verification", token: "fake", challenge: "abc-123-xyz" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ challenge: "abc-123-xyz" });
    expect(workerManager.call).not.toHaveBeenCalled();
  }, 20_000);

  it("still dispatches non-verification webhook bodies to the worker", async () => {
    readyPluginWithSlackEvents();
    const { app, workerManager } = await createApp();

    const res = await request(app)
      .post(`/api/plugins/${PLUGIN_ID}/webhooks/slack-events`)
      .send({ type: "event_callback", event: { type: "app_mention" } });

    // The route writes to a real db; with our `{}` stub it will fail on the
    // delivery insert, returning 502 but only AFTER reaching the dispatch path
    // (proving we did not short-circuit on a non-verification body).
    expect(workerManager.call).not.toHaveBeenCalledWith(
      PLUGIN_ID,
      expect.anything(),
      expect.objectContaining({ parsedBody: expect.objectContaining({ type: "url_verification" }) }),
    );
    expect(res.status).not.toBe(200);
  }, 20_000);
});

describe("plugin webhook raw-body capture for HMAC verification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("forwards exact raw bytes + parsed payload for form-urlencoded Slack interactivity (BLO-8857)", async () => {
    readyPluginWithSlackEvents();
    const { app, workerManager } = await createApp(deliveryRecordingDbStub());

    // A Block Kit Approve button click: Slack POSTs
    // `application/x-www-form-urlencoded` with a single `payload` field whose
    // value is the URL-encoded JSON interaction payload.
    const interactionPayload = {
      type: "block_actions",
      user: { id: "U123APPROVER" },
      response_url: "https://hooks.slack.test/actions/xyz",
      actions: [{ action_id: "approval_approve", value: "approval-42" }],
    };
    const rawBody = `payload=${encodeURIComponent(JSON.stringify(interactionPayload))}`;
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = slackSignature(timestamp, rawBody);

    const res = await request(app)
      .post(`/api/plugins/${PLUGIN_ID}/webhooks/slack-interactivity`)
      .set("Content-Type", "application/x-www-form-urlencoded")
      .set("X-Slack-Request-Timestamp", timestamp)
      .set("X-Slack-Signature", signature)
      .send(rawBody);

    expect(res.status).toBe(200);
    expect(workerManager.call).toHaveBeenCalledTimes(1);

    const [pluginIdArg, methodArg, payloadArg] = workerManager.call.mock.calls[0];
    expect(pluginIdArg).toBe(PLUGIN_ID);
    expect(methodArg).toBe("handleWebhook");

    // (1) The exact signed bytes are forwarded — NOT an empty string. Before the
    // urlencoded parser was registered, `rawBody` was `""` here, so the worker
    // computed the HMAC over an empty body and rejected with `hmac_mismatch`.
    expect(payloadArg.rawBody).toBe(rawBody);
    expect(payloadArg.rawBody.length).toBeGreaterThan(0);

    // (2) The form field is parsed so the worker can read `body.payload`.
    expect(payloadArg.parsedBody).toEqual({
      payload: JSON.stringify(interactionPayload),
    });

    // (3) Raw-body HMAC validation passes: recomputing the Slack v0 signature
    // over the forwarded rawBody reproduces the signature header, which is
    // exactly what the worker's verifySlackSignature() checks.
    expect(slackSignature(timestamp, payloadArg.rawBody)).toBe(signature);
  }, 20_000);

  it("forwards exact JSON raw bytes for Slack Events API webhooks (regression)", async () => {
    readyPluginWithSlackEvents();
    const { app, workerManager } = await createApp(deliveryRecordingDbStub());

    // Exact JSON bytes Slack signs — sent verbatim so re-serialization can't
    // mask a raw-body drift. (No spaces, to match a typical compact payload.)
    const rawBody =
      '{"type":"event_callback","event":{"type":"app_mention","text":"hi"}}';
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = slackSignature(timestamp, rawBody);

    const res = await request(app)
      .post(`/api/plugins/${PLUGIN_ID}/webhooks/slack-events`)
      .set("Content-Type", "application/json")
      .set("X-Slack-Request-Timestamp", timestamp)
      .set("X-Slack-Signature", signature)
      .send(rawBody);

    expect(res.status).toBe(200);
    expect(workerManager.call).toHaveBeenCalledTimes(1);

    const [, , payloadArg] = workerManager.call.mock.calls[0];
    // Exact JSON bytes preserved and the JSON body parsed unchanged.
    expect(payloadArg.rawBody).toBe(rawBody);
    expect(payloadArg.parsedBody).toEqual({
      type: "event_callback",
      event: { type: "app_mention", text: "hi" },
    });
    // JSON raw-body HMAC still validates against the original bytes.
    expect(slackSignature(timestamp, payloadArg.rawBody)).toBe(signature);
  }, 20_000);
});
