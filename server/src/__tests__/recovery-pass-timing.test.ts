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
    const timer = createPassTimer();
    await timer.time("cheap", () => sleep(1));
    await timer.time("expensive", () => sleep(30));
    await timer.time("middling", () => sleep(12));

    expect(Object.keys(timer.summary().phases)).toEqual(["expensive", "middling", "cheap"]);
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
    const timer = createPassTimer();
    // 40 fast candidates and one pathological one: the shape the dispersion implies.
    for (let i = 0; i < 40; i++) {
      await timer.candidate(`fast-${i}`, () => sleep(1));
    }
    await timer.candidate("pathological", () => sleep(60));

    const { candidates, slowest } = timer.summary();
    expect(candidates.count).toBe(41);
    // The load-bearing assertion: the median stays low while the max does not, which
    // is precisely what a mean alone cannot show. If percentiles were ever replaced
    // by means this fails.
    expect(candidates.p50Ms).toBeLessThan(15);
    expect(candidates.maxMs).toBeGreaterThanOrEqual(50);
    expect(candidates.maxMs).toBeGreaterThan(candidates.p50Ms * 3);
    // ...and the tail is identifiable, not merely countable.
    expect(slowest[0]?.issueId).toBe("pathological");
  });

  it("keeps the slowest list worst-first and bounded regardless of arrival order", async () => {
    const timer = createPassTimer();
    const timer2 = createPassTimer({ slowestTracked: 2 });
    // Arrival order deliberately puts a slow candidate FIRST, so a list that simply
    // kept the first N entries would still contain it and could look correct.
    await timer.candidate("slow-first", () => sleep(40));
    for (let i = 0; i < 6; i++) await timer.candidate(`mid-${i}`, () => sleep(1));
    await timer.candidate("slowest-last", () => sleep(70));

    const { slowest } = timer.summary();
    expect(slowest).toHaveLength(5); // default bound
    expect(slowest[0]?.issueId).toBe("slowest-last");
    expect(slowest[1]?.issueId).toBe("slow-first");
    expect(slowest.map((entry) => entry.ms)).toEqual([...slowest.map((e) => e.ms)].sort((a, b) => b - a));

    await timer2.candidate("a", () => sleep(1));
    await timer2.candidate("b", () => sleep(1));
    await timer2.candidate("c", () => sleep(1));
    expect(timer2.summary().slowest).toHaveLength(2);
  });

  it("reports an empty pass without dividing by zero", () => {
    const summary = createPassTimer().summary();
    expect(summary.phases).toEqual({});
    expect(summary.candidates).toMatchObject({ count: 0, totalMs: 0, meanMs: 0, p50Ms: 0, maxMs: 0 });
    expect(summary.slowest).toEqual([]);
  });
});
