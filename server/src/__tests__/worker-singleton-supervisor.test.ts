import { describe, expect, it, vi } from "vitest";

vi.mock("../middleware/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { superviseWorkerSingleton } from "../services/worker-singleton-supervisor.js";

// BLO-46694. A hand-driven scheduler: `fire()` runs one lease re-check.
function harness(leader: boolean) {
  const lease = { leader };
  let check: (() => void) | null = null;
  const scheduler = {
    setInterval: vi.fn((cb: () => void) => {
      check = cb;
      return 1 as unknown as ReturnType<typeof setInterval>;
    }),
    clearInterval: vi.fn(),
  };
  const stopLoop = vi.fn();
  const start = vi.fn(() => stopLoop);
  const stopSupervision = superviseWorkerSingleton("test-loop", () => lease.leader, start, {
    scheduler,
  });
  return { lease, start, stopLoop, stopSupervision, scheduler, fire: () => check?.() };
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
      { scheduler: { setInterval: vi.fn(() => 1 as never), clearInterval: vi.fn() } },
    );
    expect(start).not.toHaveBeenCalled();
  });

  it("stopping supervision stops the running loop and the re-check timer", () => {
    const h = harness(true);
    h.stopSupervision();
    expect(h.stopLoop).toHaveBeenCalledTimes(1);
    expect(h.scheduler.clearInterval).toHaveBeenCalledTimes(1);
  });
});
