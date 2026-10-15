import type { Express } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

// BLO-46694. `plugin-job-scheduler.ts` has no lock, claim or lease of its own,
// so every worker that starts it runs every due plugin job. createApp must
// start it only on the scheduler lease holder.
const schedulerSpy = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn() }));
vi.mock("../services/plugin-job-scheduler.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/plugin-job-scheduler.js")>()),
  createPluginJobScheduler: vi.fn(() => ({
    start: schedulerSpy.start,
    stop: schedulerSpy.stop,
    triggerJob: vi.fn(),
    diagnostics: vi.fn(),
  })),
}));

// BLO-46711: the event outbox starts only after loadAll() resolves, so it is
// stubbed to resolve on demand and the outbox itself is a spy.
const outbox = vi.hoisted(() => ({
  stop: vi.fn(),
  start: vi.fn(),
  releaseLoadAll: null as null | (() => void),
}));
vi.mock("../services/plugin-event-outbox.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/plugin-event-outbox.js")>()),
  startPluginEventOutbox: vi.fn(() => {
    outbox.start();
    return outbox.stop;
  }),
}));
vi.mock("../services/plugin-loader.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/plugin-loader.js")>();
  return {
    ...actual,
    pluginLoader: vi.fn((...args: Parameters<typeof actual.pluginLoader>) => ({
      ...actual.pluginLoader(...args),
      loadAll: () =>
        new Promise((resolve) => {
          outbox.releaseLoadAll = () => resolve({ results: [] } as never);
        }),
    })),
  };
});

import { createApp } from "../app.js";

async function boot(shouldRunWorkerSingletons: () => boolean): Promise<Express> {
  return createApp({} as never, {
    uiMode: "none",
    serverPort: 0,
    storageService: {} as never,
    deploymentMode: "local_trusted",
    deploymentExposure: "private",
    allowedHostnames: [],
    bindHost: "127.0.0.1",
    authReady: false,
    companyDeletionEnabled: false,
    shouldRunWorkerSingletons,
  } as never);
}

describe("createApp plugin job scheduler lease gate (BLO-46694)", () => {
  let app: Express | null = null;

  afterEach(async () => {
    await (app?.locals?.paperclipShutdown as undefined | (() => Promise<void>))?.();
    app = null;
    outbox.releaseLoadAll = null;
    vi.clearAllMocks();
  });

  it("a follower does not start the plugin job scheduler", async () => {
    app = await boot(() => false);
    expect(schedulerSpy.start).not.toHaveBeenCalled();
  }, 120_000);

  it("the lease holder starts it, and stops it on shutdown", async () => {
    app = await boot(() => true);
    expect(schedulerSpy.start).toHaveBeenCalledTimes(1);
    await (app.locals.paperclipShutdown as () => Promise<void>)();
    app = null;
    expect(schedulerSpy.stop).toHaveBeenCalled();
  }, 120_000);
  it("stopWorkerSingletons stops the scheduler and the outbox without the rest of shutdown (BLO-46711)", async () => {
    app = await boot(() => true);
    await vi.waitFor(() => expect(outbox.releaseLoadAll).not.toBeNull());
    outbox.releaseLoadAll?.();
    await vi.waitFor(() => expect(outbox.start).toHaveBeenCalledTimes(1));

    (app.locals.stopWorkerSingletons as () => void)();
    expect(schedulerSpy.stop).toHaveBeenCalledTimes(1);
    expect(outbox.stop).toHaveBeenCalledTimes(1);
  }, 120_000);

  it("a loadAll() that resolves after stopWorkerSingletons does not start the outbox (BLO-46711)", async () => {
    app = await boot(() => true);
    await vi.waitFor(() => expect(outbox.releaseLoadAll).not.toBeNull());
    (app.locals.stopWorkerSingletons as () => void)();
    outbox.releaseLoadAll?.();
    for (let i = 0; i < 25; i += 1) await Promise.resolve();
    expect(outbox.start).not.toHaveBeenCalled();
  }, 120_000);
});
