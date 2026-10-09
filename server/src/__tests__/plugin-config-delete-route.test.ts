/**
 * @fileoverview BLO-19568 / BLO-42285 — `DELETE /api/plugins/:pluginId/config`.
 *
 * `listConfigCompanyIds()` counts `plugin_config` rows, so a row copied onto a
 * company that never installed the plugin makes the install permanently
 * "multi-company": public webhook URLs 400 (a sender such as Slack cannot
 * append `?companyId=`) and the scheduler fans out onto a company whose
 * secrets can never bind. `registry.deleteConfig()` already existed with no
 * caller; this route is the only sanctioned way to reach it.
 *
 * Each test pins one guard, so reverting that guard alone turns the suite red.
 */
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const pluginId = "11111111-1111-4111-8111-111111111111";
const companyA = "22222222-2222-4222-8222-222222222222";
/** In the actor's allowed set, but never given a config row. */
const companyNoConfig = "44444444-4444-4444-8444-444444444444";

const mockSecretService = vi.hoisted(() => ({
  getById: vi.fn(),
  syncSecretRefsForTarget: vi.fn(),
}));

const store = vi.hoisted(() => ({
  plugin: null as Record<string, unknown> | null,
  /** companyId -> config row, mirroring `plugin_config` keyed by (plugin, company). */
  configs: new Map<string, Record<string, unknown>>(),
  deleteCalls: [] as Array<{ pluginId: string; companyId: string }>,
}));

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => ({
    getById: async () => store.plugin,
    getByKey: async () => store.plugin,
    getConfig: async (_p: string, companyId: string) => store.configs.get(companyId) ?? null,
    listConfigCompanyIds: async () => [...store.configs.keys()],
    deleteConfig: async (p: string, companyId: string) => {
      store.deleteCalls.push({ pluginId: p, companyId });
      const row = store.configs.get(companyId) ?? null;
      store.configs.delete(companyId);
      return row;
    },
  }),
}));

vi.mock("../services/plugin-lifecycle.js", () => ({
  pluginLifecycleManager: () => ({ restartWorker: vi.fn() }),
}));
vi.mock("../services/activity-log.js", () => ({ logActivity: vi.fn() }));
vi.mock("../services/secrets.js", () => ({ secretService: () => mockSecretService }));
vi.mock("../services/live-events.js", () => ({ publishGlobalLiveEvent: vi.fn() }));

/** Records every advisory-lock key the handler asks for, in order. */
const lockKeys: string[] = [];

const fakeDb = {
  transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> =>
    fn({
      execute: async (q: unknown) => {
        const serialized = JSON.stringify((q as { queryChunks?: unknown }).queryChunks ?? q);
        const key = serialized.match(/paperclip:plugin-config:[^"]*/)?.[0];
        if (key) lockKeys.push(key);
      },
    }),
};

async function createApp() {
  const [{ pluginRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/plugins.js"),
    import("../middleware/index.js"),
  ]);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = {
      type: "board",
      userId: "admin-1",
      source: "session",
      isInstanceAdmin: true,
      companyIds: [companyA, companyNoConfig],
    } as typeof req.actor;
    next();
  });
  app.use("/api", pluginRoutes(fakeDb as never, { installPlugin: vi.fn() } as never, undefined as never));
  app.use(errorHandler);
  return app;
}

describe("DELETE /api/plugins/:pluginId/config (BLO-19568)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lockKeys.length = 0;
    store.deleteCalls.length = 0;
    store.plugin = {
      id: pluginId,
      pluginKey: "paperclip-plugin-slack",
      version: "2.4.0",
      status: "ready",
      manifestJson: { instanceConfigSchema: { type: "object", properties: {} } },
    };
    store.configs = new Map([
      [companyA, { id: "config-a", pluginId, companyId: companyA, configJson: {} }],
    ]);
    mockSecretService.syncSecretRefsForTarget.mockResolvedValue([]);
  });

  it("deletes only the named company's row, so the install stops being multi-company", async () => {
    const other = "33333333-3333-4333-8333-333333333333";
    store.configs.set(other, { id: "config-b", pluginId, companyId: other, configJson: {} });

    const res = await request(await createApp())
      .delete(`/api/plugins/${pluginId}/config`)
      .query({ companyId: companyA });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: true });
    expect(store.deleteCalls).toEqual([{ pluginId, companyId: companyA }]);
    // The surviving row is untouched — this is a per-company delete, not an uninstall.
    expect([...store.configs.keys()]).toEqual([other]);
  });

  it("drops that company's secret-ref bindings in the same transaction", async () => {
    await request(await createApp())
      .delete(`/api/plugins/${pluginId}/config`)
      .query({ companyId: companyA });

    expect(mockSecretService.syncSecretRefsForTarget).toHaveBeenCalledWith(
      companyA,
      { targetType: "plugin", targetId: pluginId },
      [],
      { replaceAll: true },
    );
  });

  it("serialises against a concurrent save on the same config-scoped lock key", async () => {
    await request(await createApp())
      .delete(`/api/plugins/${pluginId}/config`)
      .query({ companyId: companyA });

    // Same key the POST uses, or a save can interleave and leave its freshly
    // written bindings attached to a row this transaction has deleted.
    expect(lockKeys).toEqual([`paperclip:plugin-config:${pluginId}:${companyA}`]);
  });

  it("404s when that company has no config row, instead of reporting a delete that did nothing", async () => {
    const res = await request(await createApp())
      .delete(`/api/plugins/${pluginId}/config`)
      .query({ companyId: companyNoConfig });

    // `companyNoConfig` is inside the actor's allowed set on purpose: pointing
    // this at a company the actor cannot reach would 403 before the handler
    // ran, and the test would pass against any body at all.
    // Fail-closed: an operator repairing a phantom row must not read
    // `{ deleted: true }` for a row that was never there.
    expect(res.status).toBe(404);
    expect(res.body).not.toEqual({ deleted: true });
  });

  it("refuses a request with no companyId rather than guessing one", async () => {
    const res = await request(await createApp()).delete(`/api/plugins/${pluginId}/config`);

    expect(res.status).toBe(400);
    expect(store.deleteCalls).toEqual([]);
  });

  it("404s for an unknown plugin", async () => {
    store.plugin = null;

    const res = await request(await createApp())
      .delete(`/api/plugins/${pluginId}/config`)
      .query({ companyId: companyA });

    expect(res.status).toBe(404);
    expect(store.deleteCalls).toEqual([]);
  });
});
