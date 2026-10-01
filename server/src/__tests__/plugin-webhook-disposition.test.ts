/**
 * Webhook ingestion must tell the SENDER whether its payload was ingested or
 * dropped — in the 200 response body, synchronously.
 *
 * Regression guard for BLO-38643. The route has always answered
 * `{deliveryId, status: "success"}` on every non-throwing delivery, and the
 * plugin acknowledges a deliberate drop (malformed body, unsupported schema
 * version) by returning normally. That 200 is correct and must stay: it is what
 * stops Alertmanager retrying a body that can never parse. But it made the two
 * outcomes byte-identical at the sender, and `status: "success"` is worse than
 * silence — it affirmatively claims success over a destroyed payload.
 *
 * Cost: the Prometheus liveness checker shipped a malformed payload on
 * 2026-08-25 and every page it sent was dropped here and reported delivered,
 * for 36 days, discovered only when someone noticed during an outage that no
 * issue had ever been filed.
 *
 * Alerting on the `alertmanager.webhook.malformed` counter is not an
 * alternative: plugin metrics do not reach Prometheus (BLO-32163), and that
 * sender only ever transmits while Prometheus is down. The signal has to be
 * in-band on the response the sender already receives.
 */
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRegistry = vi.hoisted(() => ({
  getById: vi.fn(),
  getByKey: vi.fn(),
  listConfigCompanyIds: vi.fn(),
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
const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const DELIVERY_ID = "33333333-3333-4333-8333-333333333333";
const ENDPOINT_KEY = "alertmanager";

/**
 * A real Alertmanager v4 batch. Used unmodified by the "must not change for the
 * real producer" test, so that assertion cannot drift into testing a synthetic
 * shape the actual sender never emits.
 */
const ALERTMANAGER_V4_PAYLOAD = {
  version: "4",
  status: "firing",
  receiver: "paperclip",
  groupKey: '{}:{alertname="CiliumPolicyDropsHigh"}',
  truncatedAlerts: 0,
  groupLabels: { alertname: "CiliumPolicyDropsHigh" },
  commonLabels: { alertname: "CiliumPolicyDropsHigh", severity: "critical" },
  commonAnnotations: {},
  externalURL: "http://alertmanager.monitoring.svc:9093",
  alerts: [
    {
      status: "firing",
      labels: { alertname: "CiliumPolicyDropsHigh", severity: "critical", team: "platform" },
      annotations: { summary: "drops" },
      startsAt: "2026-09-30T08:00:00Z",
      endsAt: "0001-01-01T00:00:00Z",
      generatorURL: "http://prometheus-0:9090/graph",
      fingerprint: "9a3b1e4c5f6d7890",
    },
  ],
};

/** Minimal chainable stub for the two statements the success path runs. */
function stubDb() {
  return {
    insert: () => ({
      values: () => ({ returning: async () => [{ id: DELIVERY_ID }] }),
    }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
  };
}

async function createApp() {
  const [{ pluginRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/plugins.js"),
    import("../middleware/index.js"),
  ]);

  mockRegistry.listConfigCompanyIds.mockResolvedValue([COMPANY_ID]);
  mockRegistry.getById.mockResolvedValue({
    id: PLUGIN_ID,
    pluginKey: "paperclip-plugin-alertmanager",
    version: "1.0.0",
    status: "ready",
    manifestJson: {
      capabilities: ["webhooks.receive"],
      webhooks: [{ endpointKey: ENDPOINT_KEY }],
    },
  });

  const workerManager = { call: vi.fn(), isRunning: vi.fn(() => true) };

  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { (req as { rawBody?: Buffer }).rawBody = buf; } }));
  app.use("/api", pluginRoutes(
    stubDb() as never,
    { installPlugin: vi.fn() } as never,
    undefined,
    { workerManager } as never,
    undefined,
    undefined,
  ));
  app.use(errorHandler);

  return { app, workerManager };
}

function post(app: express.Express, body: unknown) {
  return request(app).post(`/api/plugins/${PLUGIN_ID}/webhooks/${ENDPOINT_KEY}`).send(body);
}

describe("webhook ingestion: delivery disposition in the response body", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("echoes the ingested count so a sender can confirm its page landed", async () => {
    const { app, workerManager } = await createApp();
    workerManager.call.mockResolvedValue({ accepted: 1 });

    const res = await post(app, ALERTMANAGER_V4_PAYLOAD);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deliveryId: DELIVERY_ID, status: "success", accepted: 1 });
  });

  // The three drop dispositions. Each answers 200 — that is the point — so the
  // body is the only thing distinguishing them from the case above.
  it.each(["malformed", "unsupported_version", "unknown_endpoint"])(
    "reports rejected=%s alongside the 200",
    async (rejected) => {
      const { app, workerManager } = await createApp();
      workerManager.call.mockResolvedValue({ accepted: 0, rejected });

      const res = await post(app, { not: "an alertmanager payload" });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        deliveryId: DELIVERY_ID,
        status: "success",
        accepted: 0,
        rejected,
      });
    },
  );

  /**
   * The constraint from the issue's blast-radius section: this route carries all
   * real Alertmanager traffic, and the change must be invisible to it.
   *
   * Asserted two ways on purpose — that the response still parses as the 200 a
   * producer expects, AND that the payload reached the worker byte-for-byte.
   * A response-only assertion would still pass if the route had started
   * rewriting the body it forwards.
   */
  it("does not change ingestion or the 200 for an unmodified Alertmanager v4 payload", async () => {
    const { app, workerManager } = await createApp();
    workerManager.call.mockResolvedValue({ accepted: 1 });

    const res = await post(app, ALERTMANAGER_V4_PAYLOAD);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("success");
    expect(res.body.deliveryId).toBe(DELIVERY_ID);
    expect(workerManager.call).toHaveBeenCalledTimes(1);
    const [pluginId, method, input] = workerManager.call.mock.calls[0]!;
    expect(pluginId).toBe(PLUGIN_ID);
    expect(method).toBe("handleWebhook");
    expect(input.parsedBody).toEqual(ALERTMANAGER_V4_PAYLOAD);
    expect(JSON.parse(input.rawBody)).toEqual(ALERTMANAGER_V4_PAYLOAD);
  });

  /**
   * A plugin that reports nothing must leave its senders exactly as informed as
   * before this change — not newly told "accepted: 0".
   *
   * This is the direction that matters. Every other plugin on this host returns
   * void from `onWebhook`, so defaulting a missing disposition to 0 would report
   * every one of their deliveries as dropped. Absent means unknown; it must
   * never mean delivered, and it must never mean destroyed either.
   */
  it("omits the fields entirely when the plugin reports no disposition", async () => {
    const { app, workerManager } = await createApp();
    workerManager.call.mockResolvedValue(undefined);

    const res = await post(app, ALERTMANAGER_V4_PAYLOAD);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deliveryId: DELIVERY_ID, status: "success" });
  });
});

/**
 * The RPC result crosses a process boundary from a worker, so it is narrowed
 * rather than trusted. Every rejected shape must fall back to "unreported" —
 * the one outcome that cannot mislead a sender in either direction.
 */
describe("webhookDisposition — narrowing an untrusted worker result", () => {
  it("accepts a well-formed disposition", async () => {
    const { webhookDisposition } = await import("../routes/plugins.js");
    expect(webhookDisposition({ accepted: 3 })).toEqual({ accepted: 3 });
    expect(webhookDisposition({ accepted: 0, rejected: "malformed" })).toEqual({
      accepted: 0,
      rejected: "malformed",
    });
  });

  it("drops a non-string rejected reason but keeps the count", async () => {
    const { webhookDisposition } = await import("../routes/plugins.js");
    expect(webhookDisposition({ accepted: 0, rejected: { code: 7 } })).toEqual({ accepted: 0 });
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a string", "accepted"],
    ["a missing count", { rejected: "malformed" }],
    ["a non-numeric count", { accepted: "1" }],
    ["a negative count", { accepted: -1 }],
    ["NaN", { accepted: Number.NaN }],
    ["Infinity", { accepted: Number.POSITIVE_INFINITY }],
  ])("reports nothing for %s", async (_label, input) => {
    const { webhookDisposition } = await import("../routes/plugins.js");
    expect(webhookDisposition(input)).toEqual({});
  });
});
