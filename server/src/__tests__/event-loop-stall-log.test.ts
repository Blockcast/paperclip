import { describe, expect, it } from "vitest";

import {
  resolveStallThresholdMs,
  startEventLoopStallLogging,
} from "../event-loop-stall-log.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function blockEventLoop(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    /* deliberate synchronous block */
  }
}

/**
 * Blocks until the sampler reports a stall, or `attempts` blocks have missed.
 *
 * A single block is a coin flip at these settings, and waiting longer cannot
 * recover a lost one. After the block, our sampler's timer and the histogram's
 * own timer are both overdue; whichever libuv runs first wins, and if ours does
 * the histogram is re-armed before it can record, so `max` reads 0 and the
 * stall is gone for good. Production samples at 1000ms, where the histogram is
 * overdue by nearly a full second more than the sampler and always wins — 0
 * misses in 26 blocks of 1100ms and 3000ms — which is why this is a test-only
 * concern and the module is unchanged.
 *
 * The retry budget is a COUNT, not a wall-clock deadline (BLO-22985). It was
 * `5_000ms`, which buys ~8 blocks at ~610ms each on a quiet host and fewer on a
 * loaded one — i.e. it spent its retries fastest exactly when each retry was
 * likeliest to miss. Measured per-block miss rate at `sampleMs: 50`: ~20% on an
 * idle host (19-40 misses per 120-150 blocks — the figure this helper was
 * originally sized against), but 60.7% and 70.0% on a 4-core cgroup at load ~12
 * (150 and 80 blocks). At 8 blocks and p=0.70 the helper misses 5.8% of the
 * time, which is what failed `:124` and ejected merge_group run 35539993034 on
 * 2026-09-20.
 *
 * 25 blocks holds that at 0.70^25 = 1.3e-4 and costs ~15s of the 60s
 * testTimeout (3.9x margin) — and only on a genuine regression, since a working
 * sampler returns after one or two blocks (~1.5s even at p=0.70).
 *
 * Do not "fix" this by tuning `sampleMs` instead: the race is phase-dependent,
 * not monotone. Same host, same load, 80 blocks each — 50ms: 0.70, 100ms: 0.00,
 * 200ms: 0.125, 400ms: 0.00. A value that measures clean today is not a bound.
 */
async function blockUntilStallObserved(
  observed: ReadonlyArray<unknown>,
  attempts = 25,
): Promise<void> {
  for (let i = 0; i < attempts && observed.length === 0; i++) {
    // The histogram only measures once the loop has iterated after enable(),
    // so yield first — blocking in the same tick records nothing.
    await sleep(60);
    blockEventLoop(400);
    await sleep(150);
  }
}

describe("resolveStallThresholdMs", () => {
  it("defaults to 1000ms and treats 0 as disabled", () => {
    expect(resolveStallThresholdMs(undefined)).toBe(1_000);
    expect(resolveStallThresholdMs("  ")).toBe(1_000);
    expect(resolveStallThresholdMs("nonsense")).toBe(1_000);
    expect(resolveStallThresholdMs("-5")).toBe(1_000);
    expect(resolveStallThresholdMs("0")).toBe(0);
    expect(resolveStallThresholdMs("250")).toBe(250);
  });

  it("starts nothing when disabled", () => {
    const lines: Array<Record<string, number>> = [];
    const stop = startEventLoopStallLogging({
      thresholdMs: 0,
      sampleMs: 5,
      log: (fields) => lines.push(fields),
    });
    stop();
    expect(lines).toHaveLength(0);
  });
});

describe("startEventLoopStallLogging", () => {
  it("logs a synchronous block and never logs below the threshold", async () => {
    const lines: Array<Record<string, number>> = [];
    const stop = startEventLoopStallLogging({
      thresholdMs: 200,
      sampleMs: 50,
      log: (fields) => lines.push(fields),
    });
    try {
      await blockUntilStallObserved(lines);

      expect(lines.length).toBeGreaterThan(0);
      expect(lines[0].stallMs).toBeGreaterThanOrEqual(200);
      // The guard is the whole point: nothing under the threshold is ever
      // emitted, however busy the test worker happens to be.
      expect(lines.every((line) => line.stallMs >= 200)).toBe(true);
      expect(lines.every((line) => line.windowMs > 0)).toBe(true);
    } finally {
      stop();
    }
  });

  it("stops sampling after the returned stop function runs", async () => {
    const lines: Array<Record<string, number>> = [];
    const stop = startEventLoopStallLogging({
      thresholdMs: 200,
      sampleMs: 50,
      log: (fields) => lines.push(fields),
    });
    stop();
    await sleep(60);
    blockEventLoop(400);
    await sleep(150);
    expect(lines).toHaveLength(0);
  });

  it("is idempotent across repeated starts, and one stop releases them", async () => {
    // `startServer()` is called repeatedly in-process by the suite and never
    // shuts down, so a sampler per call would leave every prior histogram and
    // interval live for the worker's lifetime (BLO-32668 review).
    const first: Array<Record<string, number>> = [];
    const second: Array<Record<string, number>> = [];
    const stopFirst = startEventLoopStallLogging({
      thresholdMs: 200,
      sampleMs: 50,
      log: (fields) => first.push(fields),
    });
    const stopSecond = startEventLoopStallLogging({
      thresholdMs: 200,
      sampleMs: 50,
      log: (fields) => second.push(fields),
    });

    try {
      // Only one sampler exists, so the second start never wired its own log.
      expect(stopSecond).toBe(stopFirst);
      await blockUntilStallObserved(first);
      expect(first.length).toBeGreaterThan(0);
      expect(second).toHaveLength(0);
    } finally {
      stopFirst();
    }

    // A single stop must release everything: a leaked second interval would
    // still be firing here.
    first.length = 0;
    await sleep(60);
    blockEventLoop(400);
    await sleep(150);
    expect(first).toHaveLength(0);
    expect(second).toHaveLength(0);
  });
});
