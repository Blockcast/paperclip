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
});
