import { describe, expect, it, vi } from "vitest";
import { closeServerBounded, coordinateHeartbeatSchedulerShutdown } from "./shutdown.js";

describe("coordinateHeartbeatSchedulerShutdown", () => {
  it("captures a hot-restart snapshot without waiting for active scheduler work", async () => {
    let snapshotCaptured = false;
    const waitForHeartbeatSchedulerIdle = vi.fn(() => new Promise<void>(() => undefined));

    const result = await coordinateHeartbeatSchedulerShutdown({
      signal: "SIGTERM",
      prepareHotRestartShutdown: vi.fn(async () => {
        snapshotCaptured = true;
        return { mode: "prepared" as const, skipDrain: true };
      }),
      waitForHeartbeatSchedulerIdle,
    });

    expect(snapshotCaptured).toBe(true);
    expect(waitForHeartbeatSchedulerIdle).not.toHaveBeenCalled();
    expect(result).toEqual({
      hotRestart: { mode: "prepared", skipDrain: true },
      preparationError: null,
      waitedForSchedulerIdle: false,
      idleWaitTimedOut: false,
    });
  });

  it("preserves the scheduler idle wait for normal graceful shutdown", async () => {
    let releaseScheduler!: () => void;
    const schedulerIdle = new Promise<void>((resolve) => {
      releaseScheduler = resolve;
    });
    const waitForHeartbeatSchedulerIdle = vi.fn(() => schedulerIdle);
    let settled = false;

    const shutdown = coordinateHeartbeatSchedulerShutdown({
      signal: "SIGTERM",
      prepareHotRestartShutdown: vi.fn(async () => ({
        mode: "not_requested" as const,
        skipDrain: false,
      })),
      waitForHeartbeatSchedulerIdle,
    }).finally(() => {
      settled = true;
    });

    await vi.waitFor(() => expect(waitForHeartbeatSchedulerIdle).toHaveBeenCalledOnce());
    expect(settled).toBe(false);

    releaseScheduler();

    await expect(shutdown).resolves.toEqual({
      hotRestart: { mode: "not_requested", skipDrain: false },
      preparationError: null,
      waitedForSchedulerIdle: true,
      idleWaitTimedOut: false,
    });
  });

  it("waits for scheduler idle when hot-restart preparation is unavailable", async () => {
    const waitForHeartbeatSchedulerIdle = vi.fn(async () => undefined);

    const result = await coordinateHeartbeatSchedulerShutdown({
      signal: "SIGTERM",
      prepareHotRestartShutdown: null,
      waitForHeartbeatSchedulerIdle,
    });

    expect(waitForHeartbeatSchedulerIdle).toHaveBeenCalledOnce();
    expect(result).toEqual({
      hotRestart: null,
      preparationError: null,
      waitedForSchedulerIdle: true,
      idleWaitTimedOut: false,
    });
  });

  it("falls back to the scheduler idle wait when hot-restart preparation fails", async () => {
    const preparationError = new Error("snapshot failed");
    const waitForHeartbeatSchedulerIdle = vi.fn(async () => undefined);

    const result = await coordinateHeartbeatSchedulerShutdown({
      signal: "SIGTERM",
      prepareHotRestartShutdown: vi.fn(async () => {
        throw preparationError;
      }),
      waitForHeartbeatSchedulerIdle,
    });

    expect(waitForHeartbeatSchedulerIdle).toHaveBeenCalledOnce();
    expect(result).toEqual({
      hotRestart: null,
      preparationError,
      waitedForSchedulerIdle: true,
      idleWaitTimedOut: false,
    });
  });

  it("stops waiting at idleWaitTimeoutMs so the lease is released inside the grace (BLO-49596)", async () => {
    vi.useFakeTimers();
    try {
      const shutdown = coordinateHeartbeatSchedulerShutdown({
        signal: "SIGTERM",
        prepareHotRestartShutdown: null,
        waitForHeartbeatSchedulerIdle: () => new Promise<void>(() => undefined),
        idleWaitTimeoutMs: 20_000,
      });
      await vi.advanceTimersByTimeAsync(20_000);
      await expect(shutdown).resolves.toEqual({
        hotRestart: null,
        preparationError: null,
        waitedForSchedulerIdle: false,
        idleWaitTimedOut: true,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("closeServerBounded (BLO-49139)", () => {
  function fakeServer() {
    let closeCb: ((err?: Error) => void) | undefined;
    const server = {
      close: vi.fn((cb: (err?: Error) => void) => { closeCb = cb; }),
      closeIdleConnections: vi.fn(),
      closeAllConnections: vi.fn(() => closeCb?.()),
    };
    return { server, finishClose: (err?: Error) => closeCb?.(err) };
  }

  it("force-closes all connections when close outlives the cap", async () => {
    vi.useFakeTimers();
    try {
      const { server } = fakeServer();
      const onForceClose = vi.fn();
      const done = closeServerBounded(server, 10_000, onForceClose);
      expect(server.closeIdleConnections).toHaveBeenCalled();
      expect(server.closeAllConnections).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(onForceClose).toHaveBeenCalledTimes(1);
      expect(server.closeAllConnections).toHaveBeenCalledTimes(1);
      await expect(done).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not force-close when close finishes in time, and returns its error", async () => {
    vi.useFakeTimers();
    try {
      const { server, finishClose } = fakeServer();
      const onForceClose = vi.fn();
      const done = closeServerBounded(server, 10_000, onForceClose);
      const err = new Error("not listening");
      finishClose(err);
      await expect(done).resolves.toBe(err);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(onForceClose).not.toHaveBeenCalled();
      expect(server.closeAllConnections).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
