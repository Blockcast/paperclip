import type { Express } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

// BLO-47803. A follower keeps its boot-time plugin set as a warm standby, but
// every lifecycle change since then was served by the old holder and reached
// only that process. On lease takeover the new holder reloads from the database
// when plugin state moved since it loaded, and only then.
const loader = vi.hoisted(() => ({
  loadAll: vi.fn(async () => ({ results: [] })),
  unloadSingle: vi.fn(async () => {}),
}));
vi.mock("../services/plugin-loader.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/plugin-loader.js")>();
  return {
    ...actual,
    pluginLoader: vi.fn((...args: Parameters<typeof actual.pluginLoader>) => ({
      ...actual.pluginLoader(...args),
      loadAll: loader.loadAll,
      unloadSingle: loader.unloadSingle,
    })),
  };
});
vi.mock("../services/plugin-event-outbox.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/plugin-event-outbox.js")>()),
  startPluginEventOutbox: vi.fn(() => () => {}),
}));

import { createApp } from "../app.js";

const state = { fingerprint: "1/t0|0/" };
const BOOT_ROWS = [
  { id: "p-running", pluginKey: "acme.running" },
  { id: "p-stopped", pluginKey: "acme.stopped" },
];
let pluginRows = [...BOOT_ROWS];
/** In-memory worker handles, whatever their status. */
let handleIds: string[] = [];
const stopWorker = vi.fn(async () => {});

/** Just enough of a Db for the fingerprint read and the plugin listing. */
const fakeDb = {
  execute: vi.fn(async () => [{ fp: state.fingerprint }]),
  select: () => ({ from: async () => [...pluginRows] }),
};

async function boot(): Promise<Express> {
  return createApp(fakeDb as never, {
    uiMode: "none",
    serverPort: 0,
    storageService: {} as never,
    deploymentMode: "local_trusted",
    deploymentExposure: "private",
    allowedHostnames: [],
    bindHost: "127.0.0.1",
    authReady: false,
    companyDeletionEnabled: false,
    shouldRunWorkerSingletons: () => false,
    pluginWorkerManager: {
      isRunning: (id: string) => id === "p-running",
      getWorker: (id: string) => (handleIds.includes(id) ? {} : undefined),
      stopWorker,
      stopAll: async () => {},
      diagnostics: () => handleIds.map((pluginId) => ({ pluginId })),
    } as never,
  } as never);
}

const resync = (app: Express) => (app.locals.resyncPluginsOnTakeover as () => Promise<void>)();

describe("plugin resync on scheduler lease takeover (BLO-47803)", () => {
  let app: Express | null = null;

  afterEach(async () => {
    await (app?.locals?.paperclipShutdown as undefined | (() => Promise<void>))?.();
    app = null;
    state.fingerprint = "1/t0|0/";
    pluginRows = [...BOOT_ROWS];
    handleIds = [];
    vi.clearAllMocks();
  });

  async function bootLoaded(): Promise<Express> {
    const booted = await boot();
    await vi.waitFor(() => expect(loader.loadAll).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(fakeDb.execute).toHaveBeenCalled());
    // Let the boot chain record its fingerprint.
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    loader.loadAll.mockClear();
    return booted;
  }

  it("does nothing when plugin state is unchanged since this process loaded it", async () => {
    app = await bootLoaded();
    await resync(app);
    expect(loader.unloadSingle).not.toHaveBeenCalled();
    expect(loader.loadAll).not.toHaveBeenCalled();
  }, 120_000);

  it("reloads every plugin from the database when another holder changed plugin state", async () => {
    app = await bootLoaded();
    state.fingerprint = "1/t1|1/t1"; // e.g. a config saved on the old holder

    await resync(app);
    // Not gated on isRunning: a crashed or starting handle must be cleared too.
    expect(loader.unloadSingle).toHaveBeenCalledTimes(2);
    expect(loader.unloadSingle).toHaveBeenCalledWith("p-running", "acme.running");
    expect(loader.unloadSingle).toHaveBeenCalledWith("p-stopped", "acme.stopped");
    expect(loader.loadAll).toHaveBeenCalledTimes(1);

    // Applied: the next takeover with no further change is a no-op.
    await resync(app);
    expect(loader.loadAll).toHaveBeenCalledTimes(1);
  }, 120_000);

  it("unloads a plugin hard-deleted on the old holder, which has no row left to list", async () => {
    app = await bootLoaded();
    pluginRows = [BOOT_ROWS[1]]; // DELETE /plugins/p-running with removeData
    state.fingerprint = "1/t1|0/";

    await resync(app);
    expect(loader.unloadSingle).toHaveBeenCalledWith("p-running", "acme.running");
    expect(loader.loadAll).toHaveBeenCalledTimes(1);
  }, 120_000);

  it("stops a worker handle this process knows no key for", async () => {
    app = await bootLoaded();
    handleIds = ["p-orphan"];
    state.fingerprint = "changed";

    await resync(app);
    expect(stopWorker).toHaveBeenCalledWith("p-orphan");
    expect(loader.loadAll).toHaveBeenCalledTimes(1);
  }, 120_000);

  it("reloads on takeover after a boot load that threw, and retries a reload that threw", async () => {
    loader.loadAll.mockRejectedValueOnce(new Error("boot load failed"));
    app = await boot();
    await vi.waitFor(() => expect(loader.loadAll).toHaveBeenCalledTimes(1));
    for (let i = 0; i < 10; i += 1) await Promise.resolve();

    // Fingerprint unchanged, yet the failed boot load was never applied.
    loader.loadAll.mockRejectedValueOnce(new Error("reload failed"));
    await expect(resync(app)).rejects.toThrow("reload failed");
    expect(loader.loadAll).toHaveBeenCalledTimes(2);

    await resync(app);
    expect(loader.loadAll).toHaveBeenCalledTimes(3);
    await resync(app); // now applied
    expect(loader.loadAll).toHaveBeenCalledTimes(3);
  }, 120_000);

  it("retries a takeover reload that threw, even with no further state change", async () => {
    app = await bootLoaded();
    state.fingerprint = "changed";
    loader.loadAll.mockRejectedValueOnce(new Error("reload failed"));
    await expect(resync(app)).rejects.toThrow("reload failed");

    await resync(app);
    expect(loader.loadAll).toHaveBeenCalledTimes(2);
  }, 120_000);

  it("does nothing before the boot load has finished, so it cannot race it", async () => {
    let releaseBoot!: () => void;
    loader.loadAll.mockImplementationOnce(
      () => new Promise((resolve) => { releaseBoot = () => resolve({ results: [] }); }),
    );
    app = await boot();
    await vi.waitFor(() => expect(releaseBoot).toBeDefined());
    state.fingerprint = "changed";
    await resync(app);
    expect(loader.unloadSingle).not.toHaveBeenCalled();
    expect(loader.loadAll).toHaveBeenCalledTimes(1); // the boot one only
    releaseBoot();
  }, 120_000);
});
