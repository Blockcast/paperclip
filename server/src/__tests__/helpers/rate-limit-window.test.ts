import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitRateLimitWindow } from "./rate-limit-window.js";

/**
 * Regression cover for BLO-33257.
 *
 * The flake this guards is a race, but its *failure* is a deterministic
 * function of where in the fixed 60s window the pair of calls starts. So rather
 * than trying to lose a race on a loaded host, pin the clock to the boundary
 * tail and assert the guard leaves enough headroom that a pair cannot straddle.
 */
describe("awaitRateLimitWindow", () => {
  const windowMs = 60_000;
  const marginMs = 5_000;
  // An exact window boundary, so offsets below read as ":SS.mmm" into the window.
  const windowBoundary = Date.UTC(2026, 0, 1, 12, 0, 0);

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits out the window tail so a following pair shares one counter", async () => {
    vi.setSystemTime(windowBoundary + 59_900);

    const guard = awaitRateLimitWindow(windowMs, marginMs);
    // `runAllTimersAsync` advances the clock only as far as the guard's own
    // pending timer. Advancing by a fixed amount instead would move the clock
    // out of the tail on its own and the assertion below would hold even with
    // the guard removed.
    await vi.runAllTimersAsync();
    await guard;

    // Without the guard this is 100ms — far too little for a pair to land in
    // one counter, which is exactly how the three call sites flaked.
    expect(windowMs - (Date.now() % windowMs)).toBeGreaterThanOrEqual(marginMs);
  });

  it("does not wait when the window still has headroom", async () => {
    vi.setSystemTime(windowBoundary + 30_000);

    // No timer advance: if the guard scheduled a sleep here it would never
    // settle, and this test would fail on timeout.
    await awaitRateLimitWindow(windowMs, marginMs);

    expect(Date.now()).toBe(windowBoundary + 30_000);
  });
});
