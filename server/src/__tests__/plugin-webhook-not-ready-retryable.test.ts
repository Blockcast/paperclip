/**
 * Webhook ingestion must answer 503 (retryable) — never 4xx — when a plugin is
 * not ready.
 *
 * Regression guard for BLO-28659. During the 2026-08-18 alert-delivery outage
 * the readiness guard on this route answered 400. Alertmanager treats 4xx as
 * permanent:
 *
 *   notify retry canceled due to unrecoverable error after 1 attempts:
 *     unexpected status code 400: {"error":"Plugin is not ready (...)"}
 *
 * so every alert batch sent across the 5.8h window was discarded at the sender
 * rather than retried. Readiness is a transient server-side condition; the
 * request is well-formed. A dead plugin must delay alerts, never destroy them.
 *
 * The second half of this file pins the genuine 4xx rejections on the same
 * route, so a future "make webhooks retryable" change cannot quietly convert
 * real client errors into infinite sender retry loops.
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
const ENDPOINT_KEY = "alerts";

const READY_MANIFEST = {
  capabilities: ["webhooks.receive"],
  webhooks: [{ endpointKey: ENDPOINT_KEY }],
};

function mockPlugin(overrides: Record<string, unknown>) {
  mockRegistry.listConfigCompanyIds.mockResolvedValue([COMPANY_ID]);
  mockRegistry.getById.mockResolvedValue({
    id: PLUGIN_ID,
    pluginKey: "paperclip-plugin-alertmanager",
    version: "1.0.0",
    status: "ready",
    manifestJson: READY_MANIFEST,
    ...overrides,
  });
}

async function createApp() {
  const [{ pluginRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/plugins.js"),
    import("../middleware/index.js"),
  ]);

  const workerManager = {
    call: vi.fn(),
    isRunning: vi.fn(() => true),
  };

  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { (req as { rawBody?: Buffer }).rawBody = buf; } }));
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
    {} as never,
    { installPlugin: vi.fn() } as never,
    undefined,
    { workerManager } as never,
    undefined,
    undefined,
  ));
  app.use(errorHandler);

  return { app, workerManager };
}

function postAlert(app: express.Express, endpointKey = ENDPOINT_KEY) {
  return request(app)
    .post(`/api/plugins/${PLUGIN_ID}/webhooks/${endpointKey}`)
    .send({ alerts: [{ labels: { alertname: "TestAlert" } }] });
}

describe("webhook ingestion: plugin-not-ready is retryable", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // "error" is the status the alertmanager plugin latched into during the
  // outage, so it is the exact case that caused the data loss.
  for (const status of ["error", "installed", "disabled", "starting"]) {
    it(`answers 503 with Retry-After when plugin status is "${status}"`, async () => {
      mockPlugin({ status });
      const { app, workerManager } = await createApp();

      const res = await postAlert(app);

      expect(res.status).toBe(503);
      expect(res.body.error).toContain(`current status: ${status}`);
      // Without Retry-After a backing-off sender is free to hot-loop a plugin
      // that may stay down for hours.
      expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
      expect(workerManager.call).not.toHaveBeenCalled();
    }, 20_000);
  }

  it("never answers 4xx for a not-ready plugin, even when the manifest is also bad", async () => {
    // Readiness is checked before manifest/capability validation. A dead plugin
    // whose manifest is missing must still be retryable — if this ordering ever
    // flips, a down plugin resumes destroying payloads via the manifest 400.
    mockPlugin({ status: "error", manifestJson: null });
    const { app } = await createApp();

    const res = await postAlert(app);

    expect(res.status).toBe(503);
    expect(res.status).not.toBe(400);
  }, 20_000);
});

describe("webhook ingestion: genuine client errors stay 4xx", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("404s an unknown plugin", async () => {
    mockRegistry.getById.mockResolvedValue(null);
    mockRegistry.getByKey.mockResolvedValue(null);
    const { app } = await createApp();

    expect((await postAlert(app)).status).toBe(404);
  }, 20_000);

  it("400s a ready plugin with a missing manifest", async () => {
    mockPlugin({ manifestJson: null });
    const { app } = await createApp();

    const res = await postAlert(app);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("manifest");
  }, 20_000);

  it("400s a ready plugin lacking the webhooks.receive capability", async () => {
    mockPlugin({ manifestJson: { capabilities: [], webhooks: [{ endpointKey: ENDPOINT_KEY }] } });
    const { app } = await createApp();

    const res = await postAlert(app);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("webhooks.receive");
  }, 20_000);

  it("404s an endpointKey the manifest does not declare", async () => {
    mockPlugin({});
    const { app } = await createApp();

    const res = await postAlert(app, "not-declared");
    expect(res.status).toBe(404);
    expect(res.body.error).toContain("not-declared");
  }, 20_000);

  it("400s a ready plugin not yet configured for any company", async () => {
    mockPlugin({});
    mockRegistry.listConfigCompanyIds.mockResolvedValue([]);
    const { app } = await createApp();

    const res = await postAlert(app);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("configured for a company");
  }, 20_000);
});
