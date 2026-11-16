import { describe, expect, it } from "vitest";

import {
  type EventLoopDelayHistogram,
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

const THRESHOLD_MS = 200;
const SAMPLE_MS = 50;

/**
 * Derived, not chosen. The sampler's interval cannot run while the loop is
 * blocked, so a block of D ms sits entirely inside one of its windows: the
 * window it then measures is >= D and the `lagMs` it derives is >= D -
 * SAMPLE_MS. Sizing the block as `SAMPLE_MS + THRESHOLD_MS * HEADROOM` puts
 * that floor at `THRESHOLD_MS * HEADROOM` exactly.
 *
 * The headroom is margin against the arithmetic above being wrong, NOT against
 * load — load can only delay the tick further, i.e. it moves this quantity AWAY
 * from the threshold. That is the whole point of the rewrite: every previous
 * budget on this shard failed in the direction contention pushes it, and this
 * one cannot.
 */
const LAG_FLOOR_HEADROOM = 2;
const STALL_BLOCK_MS = SAMPLE_MS + THRESHOLD_MS * LAG_FLOOR_HEADROOM;
/** The floor the block guarantees, stated once so the assertions share it. */
const GUARANTEED_LAG_MS = STALL_BLOCK_MS - SAMPLE_MS;

/**
 * One block, deliberately not a retry loop.
 *
 * This was `blockUntilStallObserved(observed, attempts = 25)` until PEN-3381.
 * The histogram's reading after a block is a coin flip — when the loop unblocks
 * both the sampler's timer and the histogram's own are overdue, and if libuv
 * runs the sampler first it reads `max` as 0 and `reset()`s the stall away for
 * good (measured: never deferred to the next window, 40 of 40). Miss rate ~27%
 * idle and ~78% on a 4-core cgroup at load ~12. The retry budget bounded the
 * number of chances; it could not make any one chance certain, and at p=0.78 an
 * all-25-miss run is ~1 in 455 per call — which reddened this shard three times
 * on PRs touching no server code.
 *
 * `lagMs` cannot miss, so one block is now enough.
 */
async function stallTheLoop(): Promise<void> {
  // The histogram records nothing until the loop has iterated after enable(),
  // so yield first — blocking in the same tick records nothing.
  await sleep(60);
  blockEventLoop(STALL_BLOCK_MS);
  // The sampler's interval is overdue by the whole block, so libuv runs it in
  // the timers phase ahead of this freshly-scheduled one: by the time this
  // resolves, the tick has fired and its line has been logged.
  await sleep(150);
}

/** The logged contract, asserted on every line every test collects. */
function expectWellFormedLines(lines: ReadonlyArray<Record<string, number>>): void {
  for (const line of lines) {
    // The guard is the whole point: nothing under the threshold is ever
    // emitted, however busy the test worker happens to be.
    expect(line.stallMs).toBeGreaterThanOrEqual(THRESHOLD_MS);
    // ...and every line is attributable to a detector that actually crossed it.
    expect(line.stallMs).toBe(Math.max(line.histogramMs, line.lagMs));
    expect(line.windowMs).toBeGreaterThan(0);
    expect(line.thresholdMs).toBe(THRESHOLD_MS);
  }
}

/**
 * A histogram pinned at `maxMs`. The real one's reading is decided by the libuv
 * race above, so driving a REAL stall cannot deterministically exercise either
 * arm of `stallMs` — pinning it is the only way to cover both without a coin
 * flip.
 */
function stubHistogram(maxMs: number) {
  const calls = { enables: 0, disables: 0, resets: 0 };
  const histogram: EventLoopDelayHistogram = {
    enable: () => {
      calls.enables += 1;
      return true;
    },
    disable: () => {
      calls.disables += 1;
      return true;
    },
    reset: () => {
      calls.resets += 1;
    },
    get max(): number {
      return maxMs * 1e6;
    },
  };
  return { histogram, calls };
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
  it("logs a real synchronous block", async () => {
    const lines: Array<Record<string, number>> = [];
    const stop = startEventLoopStallLogging({
      thresholdMs: THRESHOLD_MS,
      sampleMs: SAMPLE_MS,
      log: (fields) => lines.push(fields),
    });
    try {
      await stallTheLoop();

      expect(lines.length).toBeGreaterThan(0);
      // The deterministic arm. The real histogram may or may not have caught
      // this block; the interval's own lateness cannot have missed it. Taken
      // as a max over the lines because a loaded worker may legitimately have
      // logged a shorter stall of its own before the block.
      expect(Math.max(...lines.map((line) => line.lagMs))).toBeGreaterThanOrEqual(
        GUARANTEED_LAG_MS,
      );
      expectWellFormedLines(lines);
    } finally {
      stop();
    }
  });

  it("reports a stall the histogram saw, with no event-loop block at all", async () => {
    const lines: Array<Record<string, number>> = [];
    const { histogram, calls } = stubHistogram(THRESHOLD_MS * 2);
    const stop = startEventLoopStallLogging({
      thresholdMs: THRESHOLD_MS,
      sampleMs: SAMPLE_MS,
      histogram,
      log: (fields) => lines.push(fields),
    });
    try {
      // At least one tick is guaranteed before this resolves: the sampler's
      // deadlines at +SAMPLE_MS and +2*SAMPLE_MS both precede this timer's.
      await sleep(SAMPLE_MS * 3);

      expect(lines.length).toBeGreaterThan(0);
      expect(lines[0].histogramMs).toBe(THRESHOLD_MS * 2);
      expect(lines[0].stallMs).toBeGreaterThanOrEqual(THRESHOLD_MS * 2);
      expectWellFormedLines(lines);
      // The window is read and cleared every tick, or `max` would accumulate
      // across windows and every later reading would be the running maximum.
      expect(calls.enables).toBe(1);
      expect(calls.resets).toBeGreaterThan(0);
    } finally {
      stop();
    }
    expect(calls.disables).toBe(1);
  });

  it("reports a stall the histogram missed entirely", async () => {
    const lines: Array<Record<string, number>> = [];
    // Pinned silent — this is the histogram's reading on the ~78% of blocks a
    // loaded runner loses to the re-arm race, i.e. exactly the case that used
    // to go unreported in production and unobserved in this test.
    const { histogram } = stubHistogram(0);
    const stop = startEventLoopStallLogging({
      thresholdMs: THRESHOLD_MS,
      sampleMs: SAMPLE_MS,
      histogram,
      log: (fields) => lines.push(fields),
    });
    try {
      await stallTheLoop();

      expect(lines.length).toBeGreaterThan(0);
      expect(lines.every((line) => line.histogramMs === 0)).toBe(true);
      expect(Math.max(...lines.map((line) => line.lagMs))).toBeGreaterThanOrEqual(
        GUARANTEED_LAG_MS,
      );
      expectWellFormedLines(lines);
    } finally {
      stop();
    }
  });

  it("never logs a window the histogram and the lag both scored short", async () => {
    const lines: Array<Record<string, number>> = [];
    // Below the threshold and never blocked: the only lines that may appear are
    // ones the worker's own contention earned, and `expectWellFormedLines`
    // holds them to the same bar.
    const { histogram } = stubHistogram(THRESHOLD_MS - 1);
    const stop = startEventLoopStallLogging({
      thresholdMs: THRESHOLD_MS,
      sampleMs: SAMPLE_MS,
      histogram,
      log: (fields) => lines.push(fields),
    });
    try {
      await sleep(SAMPLE_MS * 3);
      expect(lines.every((line) => line.lagMs >= THRESHOLD_MS)).toBe(true);
      expectWellFormedLines(lines);
    } finally {
      stop();
    }
  });

  it("stops sampling after the returned stop function runs", async () => {
    const lines: Array<Record<string, number>> = [];
    const stop = startEventLoopStallLogging({
      thresholdMs: THRESHOLD_MS,
      sampleMs: SAMPLE_MS,
      log: (fields) => lines.push(fields),
    });
    stop();
    await stallTheLoop();
    expect(lines).toHaveLength(0);
  });

  it("is idempotent across repeated starts, and one stop releases them", async () => {
    // `startServer()` is called repeatedly in-process by the suite and never
    // shuts down, so a sampler per call would leave every prior histogram and
    // interval live for the worker's lifetime (BLO-32668 review).
    const first: Array<Record<string, number>> = [];
    const second: Array<Record<string, number>> = [];
    const stopFirst = startEventLoopStallLogging({
      thresholdMs: THRESHOLD_MS,
      sampleMs: SAMPLE_MS,
      log: (fields) => first.push(fields),
    });
    const stopSecond = startEventLoopStallLogging({
      thresholdMs: THRESHOLD_MS,
      sampleMs: SAMPLE_MS,
      log: (fields) => second.push(fields),
    });

    try {
      // Only one sampler exists, so the second start never wired its own log.
      expect(stopSecond).toBe(stopFirst);
      await stallTheLoop();
      expect(first.length).toBeGreaterThan(0);
      expect(second).toHaveLength(0);
      expectWellFormedLines(first);
    } finally {
      stopFirst();
    }

    // A single stop must release everything: a leaked second interval would
    // still be firing here.
    first.length = 0;
    await stallTheLoop();
    expect(first).toHaveLength(0);
    expect(second).toHaveLength(0);
  });
});
