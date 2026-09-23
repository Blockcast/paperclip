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
 *
 * "Not ready" is a partition, not a negation. `uninstalled` survives soft
 * delete for 30 days and still resolves on this route, so it answers 410 —
 * retrying a removed plugin could never succeed, and telling senders to do so
 * would swap dropped payloads for an unclearable alarm. The partition is a
 * terminal *denylist*, so a status this build does not recognise falls to the
 * retryable side and is delayed rather than destroyed; that fallback is pinned
 * explicitly, because a matrix driven off the enum can only ever exercise the
 * values that are already handled.
 *
 * The final block pins BLO-28803: whichever answer the guard gives, it must
 * leave a bounded, scrape-visible record of the delivery it turned away.
 */
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PLUGIN_STATUSES } from "@paperclipai/shared";
import {
  MAX_TRACKED_WEBHOOK_REJECTION_PLUGIN_KEYS,
  OVERFLOW_WEBHOOK_REJECTION_PLUGIN_KEY,
  PLUGIN_WEBHOOK_DELIVERY_REJECTED_METRIC,
  __resetMetricsForTest,
  boundWebhookRejectionPluginKey,
  renderMetrics,
} from "../services/metrics.js";
import { logger } from "../middleware/logger.js";

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

// The production terminal set, read through the same dynamic import the app
// under test uses so module mocking still applies. Asserting against this
// rather than against the enum is what makes the drift guard below real.
const { WEBHOOK_TERMINAL_PLUGIN_STATUSES } = await import("../routes/plugins.js");

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

/**
 * Parse the rejection counter out of the *rendered* exposition rather than
 * reading the registry object.
 *
 * The point of BLO-28803 is that an operator can answer "how many did we turn
 * away" from a Prometheus scrape. A counter that exists in the process but
 * never reaches `/metrics` would satisfy an in-memory assertion and fail the
 * actual requirement, so this goes through the same rendering path the scrape
 * does.
 */
async function rejectionSeries(): Promise<
  { labels: Record<string, string>; value: number }[]
> {
  const { body } = await renderMetrics();
  return body
    .split("\n")
    .filter((line) => line.startsWith(`${PLUGIN_WEBHOOK_DELIVERY_REJECTED_METRIC}{`))
    .map((line) => {
      const [, labelBlob, rawValue] = /^[^{]+\{(.*)\}\s+(\S+)$/.exec(line) ?? [];
      const labels: Record<string, string> = {};
      for (const [, key, value] of (labelBlob ?? "").matchAll(/(\w+)="([^"]*)"/g)) {
        labels[key] = value;
      }
      return { labels, value: Number(rawValue) };
    });
}

describe("webhook ingestion: plugin-not-ready is retryable", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Derived from the real enum *and* the real production set, so the matrix
  // cannot drift from either: add a PluginStatus and it lands in this loop and
  // is asserted retryable; move a status to terminal and it leaves this loop
  // and must be covered below. ("error" is the status the alertmanager plugin
  // latched into during the outage, so it is the exact case that caused the
  // data loss.)
  const RETRYABLE_STATUSES = PLUGIN_STATUSES.filter(
    (status) => status !== "ready" && !WEBHOOK_TERMINAL_PLUGIN_STATUSES.has(status),
  );

  it("treats uninstalled as the only terminal status", () => {
    // Pins the production denylist itself, not the enum against itself. Every
    // status added here converts delayed alerts into destroyed ones, which is
    // the BLO-28659 regression direction — so widening it has to be a
    // deliberate edit to this assertion, never a silent one.
    expect([...WEBHOOK_TERMINAL_PLUGIN_STATUSES]).toEqual(["uninstalled"]);
  });

  for (const status of RETRYABLE_STATUSES) {
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
  }, 20_000);

  it("answers 503, not 410, for a status outside PluginStatus entirely", async () => {
    // Deliberately off-enum, and that is the contract under test rather than a
    // pretend domain value: `plugins.status` is `text().$type<PluginStatus>()`
    // with no PG enum and no CHECK, so the column can hold a string this build
    // does not know — a rolling deploy where a newer pod writes a status the
    // older image has never heard of is enough. The parameterized loop above
    // iterates PLUGIN_STATUSES and so can only ever cover values that are
    // already handled; this is the one case that pins the *fallback* side of
    // the partition. It must delay alerts, not destroy them.
    mockPlugin({ status: "quiescing-from-a-future-release" });
    const { app, workerManager } = await createApp();

    const res = await postAlert(app);

    expect(res.status).toBe(503);
    expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
    expect(res.body.error).not.toContain("uninstalled");
    expect(workerManager.call).not.toHaveBeenCalled();
  }, 20_000);
});

describe("webhook ingestion: uninstalled is terminal, not retryable", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("answers 410 (not 503) for an uninstalled plugin, with no Retry-After", async () => {
    // Soft delete keeps the row for 30 days and the resolution path does not
    // filter by status, so a catch-all `!== "ready"` would tell senders to
    // retry a deliberately removed plugin until the purge. Alertmanager would
    // requeue forever and AlertmanagerWebhookNotificationsFailing (BLO-20813)
    // would stay lit with no operator action able to clear it — trading
    // dropped payloads for an unclearable alarm.
    mockPlugin({ status: "uninstalled" });
    const { app, workerManager } = await createApp();

    const res = await postAlert(app);

    expect(res.status).toBe(410);
    expect(res.headers["retry-after"]).toBeUndefined();
    expect(workerManager.call).not.toHaveBeenCalled();
  }, 20_000);

  it("reports uninstalled as gone rather than as a readiness problem", async () => {
    mockPlugin({ status: "uninstalled" });
    const { app } = await createApp();

    const res = await postAlert(app);

    expect(res.body.error).toContain("uninstalled");
    expect(res.body.error).not.toContain("not ready");
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

  it("503s a ready plugin not yet configured for any company", async () => {
    mockPlugin({});
    mockRegistry.listConfigCompanyIds.mockResolvedValue([]);
    const { app } = await createApp();

    const res = await postAlert(app);
    expect(res.status).toBe(503);
    expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
    expect(res.body.error).toContain("configured for a company");
  }, 20_000);

  it("400s a ready multi-company plugin when companyId is omitted", async () => {
    mockPlugin({});
    mockRegistry.listConfigCompanyIds.mockResolvedValue([COMPANY_ID, "33333333-3333-4333-8333-333333333333"]);
    const { app } = await createApp();

    const res = await postAlert(app);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('"companyId" query parameter is required');
  }, 20_000);
});

/**
 * A rejected delivery must leave a server-side trace (BLO-28803).
 *
 * The readiness guard returns long before the `plugin_webhook_deliveries`
 * insert, so a bounced delivery used to leave no row, no counter and no log.
 * When the alertmanager plugin latched into `error` on 2026-08-18 the only
 * surviving evidence that ~15h of alert batches had been turned away lived in
 * Alertmanager's logs — Paperclip, the system of record for alerting, could
 * not answer "how many, and for which plugin?" (BLO-20813).
 *
 * Deferral (BLO-28659) makes this sharper, not softer: senders now retry
 * instead of failing loudly, so a plugin bouncing every batch for hours looks
 * exactly like one receiving none. Silence is not health.
 */
describe("webhook ingestion: rejected deliveries are recorded", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetMetricsForTest();
  });

  it("records a not-ready rejection as retryable, alongside the 503", async () => {
    mockPlugin({ status: "error" });
    const { app } = await createApp();

    const res = await postAlert(app);
    expect(res.status).toBe(503);

    const series = await rejectionSeries();
    expect(series).toHaveLength(1);
    expect(series[0]!.labels).toMatchObject({
      plugin_key: "paperclip-plugin-alertmanager",
      response_class: "retryable",
      plugin_status: "error",
    });
    expect(series[0]!.value).toBe(1);
  }, 20_000);

  it("records an uninstalled rejection as terminal, alongside the 410", async () => {
    mockPlugin({ status: "uninstalled" });
    const { app } = await createApp();

    const res = await postAlert(app);
    expect(res.status).toBe(410);

    const series = await rejectionSeries();
    expect(series).toHaveLength(1);
    expect(series[0]!.labels).toMatchObject({
      response_class: "terminal",
      plugin_status: "uninstalled",
    });
  }, 20_000);

  it("keeps deferred and dropped deliveries on separate series", async () => {
    // The two mean different things operationally — one says "the payloads are
    // coming back", the other says "they are gone". Summing them would hide
    // the only distinction that matters during a reconstruction.
    mockPlugin({ status: "error" });
    const { app: retryableApp } = await createApp();
    await postAlert(retryableApp);

    mockPlugin({ status: "uninstalled" });
    const { app: terminalApp } = await createApp();
    await postAlert(terminalApp);

    const byClass = Object.fromEntries(
      (await rejectionSeries()).map((s) => [s.labels.response_class, s.value]),
    );
    expect(byClass).toEqual({ retryable: 1, terminal: 1 });
  }, 20_000);

  it("counts every bounced delivery, so the volume is recoverable after the fact", async () => {
    // The question BLO-20813 could not answer from Paperclip: given a window,
    // how many batches did we turn away for this plugin?
    mockPlugin({ status: "error" });
    const { app } = await createApp();

    for (let i = 0; i < 5; i += 1) await postAlert(app);

    const series = await rejectionSeries();
    expect(series).toHaveLength(1);
    expect(series[0]!.value).toBe(5);
  }, 20_000);

  it("mints no series for a plugin that does not exist", async () => {
    // The abuse bound. `:pluginId` is caller-controlled on a public
    // unauthenticated route; an unknown one is rejected 404 a step earlier and
    // must never reach the guard, so hammering nonexistent ids cannot grow the
    // registry at all.
    mockRegistry.getById.mockResolvedValue(null);
    mockRegistry.getByKey.mockResolvedValue(null);
    const { app } = await createApp();

    for (let i = 0; i < 10; i += 1) {
      expect((await postAlert(app)).status).toBe(404);
    }

    expect(await rejectionSeries()).toHaveLength(0);
  }, 30_000);

  it("labels from the resolved row, not from the URL parameter", async () => {
    // PLUGIN_ID is a uuid; the label must be the row's pluginKey. If this ever
    // reads req.params the series count becomes attacker-controlled.
    mockPlugin({ status: "error", pluginKey: "resolved-key" });
    const { app } = await createApp();

    await postAlert(app);

    const series = await rejectionSeries();
    expect(series[0]!.labels.plugin_key).toBe("resolved-key");
    expect(series[0]!.labels.plugin_key).not.toBe(PLUGIN_ID);
  }, 20_000);

  it("caps distinct plugin_key values and collapses the overflow", async () => {
    // Second line of defence behind the resolved-row rule: even if a future
    // change let an unbounded identifier through, the series count stays flat.
    for (let i = 0; i < MAX_TRACKED_WEBHOOK_REJECTION_PLUGIN_KEYS; i += 1) {
      expect(boundWebhookRejectionPluginKey(`plugin-${i}`)).toBe(`plugin-${i}`);
    }

    expect(boundWebhookRejectionPluginKey("one-too-many")).toBe(
      OVERFLOW_WEBHOOK_REJECTION_PLUGIN_KEY,
    );
    // Already-admitted keys keep their slot rather than being evicted.
    expect(boundWebhookRejectionPluginKey("plugin-0")).toBe("plugin-0");
    // A missing key is bucketed rather than becoming an empty label value.
    expect(boundWebhookRejectionPluginKey(null)).toBe(OVERFLOW_WEBHOOK_REJECTION_PLUGIN_KEY);
  });

  it("coalesces repeated rejection logs while retaining the metric count", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => logger);
    vi.useFakeTimers();
    try {
      mockPlugin({ status: "error" });
      const { app } = await createApp();

      await postAlert(app);
      await postAlert(app);
      await postAlert(app);

      expect(warn).toHaveBeenCalledTimes(1);
      expect((await rejectionSeries())[0]!.value).toBe(3);

      vi.advanceTimersByTime(60_000);
      await postAlert(app);

      expect(warn).toHaveBeenCalledTimes(3);
      expect(warn.mock.calls[1]![1]).toBe("plugin webhook rejection log summary");
      expect(warn.mock.calls[1]![0]).toMatchObject({ suppressedCount: 2 });
    } finally {
      vi.useRealTimers();
      warn.mockRestore();
    }
  }, 20_000);
});
