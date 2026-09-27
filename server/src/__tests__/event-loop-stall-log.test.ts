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
 * Blocks until the sampler reports a stall, or the attempt budget is spent.
 *
 * A single block is a coin flip at these settings, and waiting longer cannot
 * recover a lost one. After the block, our sampler's timer and the histogram's
 * own timer are both overdue; whichever libuv runs first wins, and if ours does
 * the histogram is re-armed before it can record, so `max` reads 0 and the
 * stall is gone for good. At `sampleMs: 50` the two come due within the
 * histogram's 20ms resolution of each other, so ours wins ~20% of the time
 * (measured 19-40 misses per 120-150 blocks, idle host). Production samples at
 * 1000ms, where the histogram is overdue by nearly a full second more than the
 * sampler and always wins — 0 misses in 26 blocks of 1100ms and 3000ms — which
 * is why this is a test-only concern and the module is unchanged.
 *
 * The budget is an ATTEMPT COUNT, not a wall-clock deadline (BLO-37114). It
 * was a 5s deadline, which made the number of coin flips a function of how
 * fast the host was: ~8 attempts on an idle worker (so ~0.2^8, never fails)
 * but 1-2 on a starved merge-queue worker, where 0.2 surfaces as a routine
 * red build. Counting attempts makes the failure probability 0.2^10 ≈ 1e-7
 * on every host. Worst case is 10 × ~610ms ≈ 6.1s of real time, well inside
 * the 60s testTimeout in server/vitest.config.ts.
 */
async function blockUntilStallObserved(
  observed: ReadonlyArray<unknown>,
  attempts = 10,
): Promise<void> {
  for (let i = 0; i < attempts && observed.length === 0; i += 1) {
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
