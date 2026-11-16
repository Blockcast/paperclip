import { describe, expect, it, vi } from "vitest";

vi.mock("../middleware/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  msUntilPhase,
  superviseWorkerSingleton,
  type WorkerSingletonStartPhase,
} from "../services/worker-singleton-supervisor.js";

// BLO-46694. A hand-driven scheduler: `fire()` runs one lease re-check.
// PEN-6750 added the timeout half, so a deferred first tick is driven the same
// way: `elapsePhase()` runs whatever the supervisor parked on `setTimeout`.
function harness(leader: boolean, options: { startPhase?: WorkerSingletonStartPhase } = {}) {
  const lease = { leader };
  const clock = { nowMs: 0 };
  let check: (() => void) | null = null;
  let pending: { cb: () => void; delayMs: number } | null = null;
  const scheduler = {
    setInterval: vi.fn((cb: () => void) => {
      check = cb;
      return 1 as unknown as ReturnType<typeof setInterval>;
    }),
    clearInterval: vi.fn(),
    setTimeout: vi.fn((cb: () => void, delayMs: number) => {
      pending = { cb, delayMs };
      return 2 as unknown as ReturnType<typeof setTimeout>;
    }),
    clearTimeout: vi.fn(() => {
      pending = null;
    }),
  };
  const stopLoop = vi.fn();
  const start = vi.fn(() => stopLoop);
  const stopSupervision = superviseWorkerSingleton("test-loop", () => lease.leader, start, {
    scheduler,
    startPhase: options.startPhase ?? null,
    now: () => clock.nowMs,
  });
  return {
    lease,
    clock,
    start,
    stopLoop,
    stopSupervision,
    scheduler,
    fire: () => check?.(),
    pendingDelayMs: () => pending?.delayMs ?? null,
    elapsePhase: () => {
      const p = pending;
      pending = null;
      p?.cb();
    },
  };
}

describe("superviseWorkerSingleton", () => {
  it("never starts the loop on a follower", () => {
    const h = harness(false);
    h.fire();
    h.fire();
    expect(h.start).not.toHaveBeenCalled();
  });

  it("starts once on the holder and does not restart it on every check", () => {
    const h = harness(true);
    h.fire();
    h.fire();
    expect(h.start).toHaveBeenCalledTimes(1);
  });

  it("a follower that takes the lease over starts the loop", () => {
    const h = harness(false);
    h.lease.leader = true;
    h.fire();
    expect(h.start).toHaveBeenCalledTimes(1);
  });

  it("a holder that loses the lease stops the loop, and restarts it on re-acquisition", () => {
    const h = harness(true);
    h.lease.leader = false;
    h.fire();
    expect(h.stopLoop).toHaveBeenCalledTimes(1);
    h.lease.leader = true;
    h.fire();
    expect(h.start).toHaveBeenCalledTimes(2);
  });

  it("retries a start that threw on the next check", () => {
    const h = harness(false);
    h.start.mockImplementationOnce(() => {
      throw new Error("boom");
    });
    h.lease.leader = true;
    h.fire();
    h.fire();
    expect(h.start).toHaveBeenCalledTimes(2);
  });

  it("treats a throwing lease check as follower", () => {
    const start = vi.fn();
    superviseWorkerSingleton(
      "throwing-check",
      () => {
        throw new Error("lease unreadable");
      },
      start,
      {
        scheduler: {
          setInterval: vi.fn(() => 1 as never),
          clearInterval: vi.fn(),
          setTimeout: vi.fn(() => 2 as never),
          clearTimeout: vi.fn(),
        },
      },
    );
    expect(start).not.toHaveBeenCalled();
  });

  it("stopping supervision stops the running loop and the re-check timer", () => {
    const h = harness(true);
    h.stopSupervision();
    expect(h.stopLoop).toHaveBeenCalledTimes(1);
    expect(h.scheduler.clearInterval).toHaveBeenCalledTimes(1);
  });

  // PEN-6750.
  it("with no phase the holder still starts immediately and schedules no timeout", () => {
    const h = harness(true);
    expect(h.start).toHaveBeenCalledTimes(1);
    expect(h.scheduler.setTimeout).not.toHaveBeenCalled();
  });
});

describe("msUntilPhase (PEN-6750)", () => {
  const hourly17 = { periodMs: 3_600_000, offsetMs: 17 * 60_000 };

  it("is zero when the clock already sits on the phase", () => {
    expect(msUntilPhase(17 * 60_000, hourly17)).toBe(0);
    expect(msUntilPhase(3_600_000 + 17 * 60_000, hourly17)).toBe(0);
  });

  it("waits almost a whole period when the phase has just passed", () => {
    expect(msUntilPhase(17 * 60_000 + 1, hourly17)).toBe(3_600_000 - 1);
  });

  it("waits the remainder when the phase is still ahead in this period", () => {
    // 10 minutes past the hour, aiming at 17 past.
    expect(msUntilPhase(10 * 60_000, hourly17)).toBe(7 * 60_000);
  });

  it("degrades to start-now on a non-positive period rather than never starting", () => {
    expect(msUntilPhase(123_456, { periodMs: 0, offsetMs: 0 })).toBe(0);
    expect(msUntilPhase(123_456, { periodMs: -1, offsetMs: 0 })).toBe(0);
  });
});

describe("superviseWorkerSingleton start phase (PEN-6750)", () => {
  const tenMinutesAt2 = { periodMs: 10 * 60_000, offsetMs: 2 * 60_000 };

  it("defers the first tick to the next instant matching the phase", () => {
    const h = harness(true, { startPhase: tenMinutesAt2 });
    expect(h.start).not.toHaveBeenCalled();
    // Clock starts at epoch 0, so the next :02-of-ten is 2 minutes out.
    expect(h.pendingDelayMs()).toBe(2 * 60_000);
    h.elapsePhase();
    expect(h.start).toHaveBeenCalledTimes(1);
  });

  it("does not schedule a second deferred start while one is pending", () => {
    const h = harness(true, { startPhase: tenMinutesAt2 });
    h.fire();
    h.fire();
    expect(h.scheduler.setTimeout).toHaveBeenCalledTimes(1);
    expect(h.start).not.toHaveBeenCalled();
  });

  it("does not start when the lease lapsed while the phase was being waited out", () => {
    const h = harness(true, { startPhase: tenMinutesAt2 });
    h.lease.leader = false;
    h.elapsePhase();
    expect(h.start).not.toHaveBeenCalled();
  });

  it("cancels a pending deferred start when a re-check finds the lease lost", () => {
    const h = harness(true, { startPhase: tenMinutesAt2 });
    h.lease.leader = false;
    h.fire();
    expect(h.scheduler.clearTimeout).toHaveBeenCalledTimes(1);
    expect(h.pendingDelayMs()).toBeNull();
    expect(h.start).not.toHaveBeenCalled();
    expect(h.stopLoop).not.toHaveBeenCalled();
  });

  it("stopping supervision cancels a pending deferred start", () => {
    const h = harness(true, { startPhase: tenMinutesAt2 });
    h.stopSupervision();
    expect(h.scheduler.clearTimeout).toHaveBeenCalledTimes(1);
    h.elapsePhase();
    expect(h.start).not.toHaveBeenCalled();
  });

  it("starts immediately when the clock already sits exactly on the phase", () => {
    const h = harness(false, { startPhase: tenMinutesAt2 });
    h.clock.nowMs = 12 * 60_000;
    h.lease.leader = true;
    h.fire();
    expect(h.start).toHaveBeenCalledTimes(1);
    expect(h.scheduler.setTimeout).not.toHaveBeenCalled();
  });

  it("re-aligns on re-acquisition rather than inheriting the hand-over minute", () => {
    const h = harness(true, { startPhase: tenMinutesAt2 });
    h.elapsePhase();
    expect(h.start).toHaveBeenCalledTimes(1);
    h.lease.leader = false;
    h.fire();
    expect(h.stopLoop).toHaveBeenCalledTimes(1);
    // Lease comes back 3 minutes past a :02 boundary; the next tick is still
    // pinned to :02, not to the minute the lease was re-acquired at.
    h.clock.nowMs = 5 * 60_000;
    h.lease.leader = true;
    h.fire();
    expect(h.start).toHaveBeenCalledTimes(1);
    expect(h.pendingDelayMs()).toBe(7 * 60_000);
    h.elapsePhase();
    expect(h.start).toHaveBeenCalledTimes(2);
  });
});
