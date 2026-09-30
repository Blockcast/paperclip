import { describe, expect, it } from "vitest";
import { createPassTimer } from "../services/recovery/pass-timing.js";

/**
 * PEN-3636. These tests pin the properties the sweep's phase-timing line is READ
 * for, not merely that it emits something.
 *
 * The distinction matters here specifically. The measurement this module exists to
 * support found pass-1 wall clock varying 15.7x on a workload varying 9%, so the
 * question it has to answer is "uniformly slower, or a thin heavy tail?". A test
 * that only asserted "a summary is produced" would pass just as happily against a
 * summary whose percentiles were means and whose slowest list was the FIRST five
 * candidates — either of which answers that question wrongly while looking healthy.
 */

/** Resolve after at least `ms`, so a phase records a duration a real clock can see. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A fed clock. Tests that pin ORDERING or PERCENTILE behaviour use this rather than
 * real sleeps: those properties are about how the module arranges numbers, not about
 * whether a timer fires on schedule, so racing `setTimeout` under a loaded CI runner
 * only buys flakiness. Tests that pin "a real duration is observed at all" keep
 * `sleep` and one-directional bounds, because a fed clock could not fail those.
 */
function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    /** Advance inside a timed fn, so the span sees exactly this much elapse. */
    advance: (ms: number) => async () => {
      t += ms;
    },
  };
}

describe("recovery sweep pass timing", () => {
  it("accumulates a phase across calls and reports its worst single observation", async () => {
    const timer = createPassTimer();
    await timer.time("prologue.getAgent", () => sleep(20));
    await timer.time("prologue.getAgent", () => sleep(1));
    await timer.time("prologue.getAgent", () => sleep(1));

    const { phases } = timer.summary();
    expect(phases["prologue.getAgent"]?.calls).toBe(3);
    // The point of `maxMs`: a phase whose max is most of its total is ONE slow call,
    // not a slow phase, and those two want different fixes.
    expect(phases["prologue.getAgent"]!.maxMs).toBeGreaterThanOrEqual(15);
    expect(phases["prologue.getAgent"]!.totalMs)
      .toBeGreaterThanOrEqual(phases["prologue.getAgent"]!.maxMs);
  });

  it("orders phases most-expensive-first so the dominant term is the first key read", async () => {
    const clock = fakeClock();
    const timer = createPassTimer({ now: clock.now });
    await timer.time("cheap", clock.advance(1));
    await timer.time("expensive", clock.advance(30));
    await timer.time("middling", clock.advance(12));

    expect(Object.keys(timer.summary().phases)).toEqual(["expensive", "middling", "cheap"]);
    // Pin the values too, not just the order: fed durations make this exact, where a
    // real clock could only support a one-directional bound.
    expect(timer.summary().phases).toMatchObject({
      expensive: { totalMs: 30, calls: 1 },
      middling: { totalMs: 12, calls: 1 },
      cheap: { totalMs: 1, calls: 1 },
    });
  });

  it("records a phase that threw, because failing candidates are the slow ones", async () => {
    const timer = createPassTimer();
    await expect(
      timer.time("prologue.explodes", async () => {
        await sleep(15);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    // Without the `finally`, the sweep's per-issue error boundary would make exactly
    // the candidates that failed slowly invisible in the timing line.
    const stat = timer.summary().phases["prologue.explodes"];
    expect(stat?.calls).toBe(1);
    expect(stat!.totalMs).toBeGreaterThanOrEqual(10);
  });

  it("separates a heavy tail from a uniform slowdown", async () => {
    const clock = fakeClock();
    const timer = createPassTimer({ now: clock.now });
    // 40 fast candidates and one pathological one: the shape the dispersion implies.
    for (let i = 0; i < 40; i++) {
      await timer.candidate(`fast-${i}`, clock.advance(1));
    }
    await timer.candidate("pathological", clock.advance(60));

    const { candidates, slowest } = timer.summary();
    expect(candidates.count).toBe(41);
    // The load-bearing assertion: the median stays low while the max does not, which
    // is precisely what a mean alone cannot show. Exact under a fed clock — p50 is the
    // 1 ms body, max is the 60 ms outlier, and the mean (≈2 ms) sits close to p50 and
    // would hide the tail entirely. If percentiles were ever replaced by means, or the
    // max collapsed into an average, this fails on the numbers rather than on a margin.
    expect(candidates.p50Ms).toBe(1);
    expect(candidates.p95Ms).toBe(1);
    expect(candidates.maxMs).toBe(60);
    expect(candidates.meanMs).toBeLessThan(candidates.maxMs / 10);
    // ...and the tail is identifiable, not merely countable.
    expect(slowest[0]?.issueId).toBe("pathological");
  });

  it("keeps the slowest list worst-first and bounded regardless of arrival order", async () => {
    const clock = fakeClock();
    const timer = createPassTimer({ now: clock.now });
    const timer2 = createPassTimer({ slowestTracked: 2, now: clock.now });
    // Arrival order deliberately puts a slow candidate FIRST, so a list that simply
    // kept the first N entries would still contain it and could look correct.
    await timer.candidate("slow-first", clock.advance(40));
    for (let i = 0; i < 6; i++) await timer.candidate(`mid-${i}`, clock.advance(1));
    await timer.candidate("slowest-last", clock.advance(70));

    const { slowest } = timer.summary();
    expect(slowest).toHaveLength(5); // default bound
    expect(slowest[0]).toEqual({ issueId: "slowest-last", ms: 70 });
    expect(slowest[1]).toEqual({ issueId: "slow-first", ms: 40 });
    expect(slowest.map((entry) => entry.ms)).toEqual([...slowest.map((e) => e.ms)].sort((a, b) => b - a));

    await timer2.candidate("a", clock.advance(1));
    await timer2.candidate("b", clock.advance(1));
    await timer2.candidate("c", clock.advance(1));
    expect(timer2.summary().slowest).toHaveLength(2);
  });

  it("still reports a usable summary when a candidate threw mid-pass", async () => {
    // The pass-level counterpart of the throwing-PHASE case above, and the property the
    // sweep's emit-from-`finally` depends on: a pass that dies part-way still has to
    // yield a readable total. Those are the passes most worth diagnosing — a pool
    // timeout during a pass already measured at up to 86 minutes unwinds out of the
    // sweep, and the summary is the only record of where that time went.
    const clock = fakeClock();
    const timer = createPassTimer({ now: clock.now });
    await timer.candidate("ok", clock.advance(5));
    await expect(
      timer.candidate("exploded", async () => {
        await clock.advance(50)();
        throw new Error("pool timeout");
      }),
    ).rejects.toThrow("pool timeout");

    const { candidates, slowest } = timer.summary();
    // The throwing candidate is COUNTED and attributed, not dropped. `count` is the
    // processed-candidate count, which on a truncated pass is the honest number —
    // the scanned population is reported separately by the sweep.
    expect(candidates.count).toBe(2);
    expect(candidates.maxMs).toBe(50);
    expect(slowest[0]).toEqual({ issueId: "exploded", ms: 50 });
  });

  it("reports an empty pass without dividing by zero", () => {
    const summary = createPassTimer().summary();
    expect(summary.phases).toEqual({});
    expect(summary.candidates).toMatchObject({ count: 0, totalMs: 0, meanMs: 0, p50Ms: 0, maxMs: 0 });
    expect(summary.slowest).toEqual([]);
  });
});
