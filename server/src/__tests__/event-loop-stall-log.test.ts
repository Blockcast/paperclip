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
      // The histogram only measures once the loop has iterated after enable(),
      // so yield first — blocking in the same tick records nothing.
      await sleep(60);
      blockEventLoop(400);
      await sleep(150);

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
      await sleep(60);
      blockEventLoop(400);
      await sleep(150);
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
