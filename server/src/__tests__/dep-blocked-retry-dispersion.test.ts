// PEN-5307 — `dependency_blocked` retries clamp to a shared wake instant.
//
// The dep-blocked backoff curve is `f(attempt)` with nothing per-run in it, and
// `promoteDueScheduledRetries` binds ONE `now` and loops up to 50 due runs
// against it (`promoteScheduledRetryRun(dueRun, now)`). So every run re-parked
// in a single sweep pass was handed a byte-identical `scheduledRetryAt` — and
// because 5 x 2^4 = 80 min exceeds DEP_BLOCKED_MAX_DELAY_MS, attempts 4..12 are
// a flat 60 min, so the attempt term stopped discriminating too. Measured
// 2026-11-02: two runs, two agents, both attempt 10, parked 25.1 s apart,
// sharing `2026-11-02T17:18:01.457Z` to the millisecond across two independent
// reads; a three-run tie across three agents 45 min earlier.
//
// This is PEN-2509's defect in the lane PEN-2509 did not cover, and the lane
// that now carries 100% of the live park population. The remedy reuses that
// lane's `jitterTransientRetryFloor` rather than growing a second
// implementation of it.
//
// Pure unit tests on purpose: the property is "two CALLS under one `now` differ",
// which does not need a database to observe, and the arithmetic bound below must
// be cheap enough that nobody is tempted to skip it.
import { describe, expect, it } from "vitest";
import {
  computeDepBlockedRetryDueAt,
  depBlockedRetryJitterWorstCaseMs,
  DEP_BLOCKED_BASE_DELAY_MS,
  DEP_BLOCKED_MAX_DELAY_MS,
  DEP_BLOCKED_MAX_PARK_AGE_MS,
  DEP_BLOCKED_MAX_RETRY_ATTEMPTS,
  DEP_BLOCKED_RETRY_JITTER_MAX_MS,
  DEP_BLOCKED_RETRY_JITTER_RATIO,
} from "../services/heartbeat.js";
import {
  DEP_BLOCKED_RETRY_DISPERSION_DISPOSITIONS,
  DEP_BLOCKED_RETRY_DISPERSION_METRIC,
  recordDepBlockedRetryDispersion,
  renderMetrics,
} from "../services/metrics.js";

const MIN = 60 * 1000;

describe("dependency-blocked retry dispersion (PEN-5307)", () => {
  const now = new Date("2026-11-02T16:18:01.457Z");

  it("gives two runs re-parked under one `now` at the same attempt different instants", () => {
    // The reported signature verbatim: one sweep `now`, one attempt, two runs.
    const a = computeDepBlockedRetryDueAt({ now, nextAttempt: 10, random: () => 0.25 });
    const b = computeDepBlockedRetryDueAt({ now, nextAttempt: 10, random: () => 0.75 });
    expect(a.dueAt.getTime()).not.toBe(b.dueAt.getTime());
    // Both still derive from the same base, so this is dispersion and not a
    // different schedule being handed to one of them.
    expect(a.baseDueAt.getTime()).toBe(b.baseDueAt.getTime());
  });

  it("disperses a whole sweep cohort instead of stacking it on one millisecond", () => {
    // 50 runs is the sweep's own `.limit(50)`, so this is the largest cohort one
    // pass can produce. Deterministic draws, evenly spaced, so the assertion is
    // on the mechanism rather than on a sampled `Math.random`.
    const cohort = Array.from({ length: 50 }, (_, i) =>
      computeDepBlockedRetryDueAt({
        now,
        nextAttempt: 10,
        random: () => i / 50,
      }).dueAt.getTime(),
    );
    expect(new Set(cohort).size).toBe(50);
    expect(Math.max(...cohort) - Math.min(...cohort)).toBeGreaterThan(2 * MIN);
  });

  it("is additive only — never earlier than the curve it disperses", () => {
    for (let attempt = 1; attempt <= DEP_BLOCKED_MAX_RETRY_ATTEMPTS; attempt += 1) {
      for (const sample of [0, 0.5, 1]) {
        const { dueAt, baseDueAt } = computeDepBlockedRetryDueAt({
          now,
          nextAttempt: attempt,
          random: () => sample,
        });
        // Pulling a re-check in FRONT of the curve would spend an attempt
        // sooner than the backoff intends, which is the one direction this
        // must never take.
        expect(dueAt.getTime()).toBeGreaterThanOrEqual(baseDueAt.getTime());
      }
    }
  });

  it("keeps the base curve itself unchanged", () => {
    // The ladder DEP_BLOCKED_MAX_PARK_AGE_MS is derived from. A zero draw yields
    // it verbatim, which is what makes the re-derivation below an addition to a
    // known quantity rather than a replacement of it.
    const base = (attempt: number) =>
      computeDepBlockedRetryDueAt({ now, nextAttempt: attempt, random: () => 0 }).dueAt.getTime()
      - now.getTime();
    expect(base(1)).toBe(10 * MIN);
    expect(base(2)).toBe(20 * MIN);
    expect(base(3)).toBe(40 * MIN);
    expect(base(4)).toBe(DEP_BLOCKED_MAX_DELAY_MS);
    expect(base(DEP_BLOCKED_MAX_RETRY_ATTEMPTS)).toBe(DEP_BLOCKED_MAX_DELAY_MS);
  });

  it("never adds more than the declared per-attempt ceiling", () => {
    for (let attempt = 1; attempt <= DEP_BLOCKED_MAX_RETRY_ATTEMPTS; attempt += 1) {
      const { jitterMs } = computeDepBlockedRetryDueAt({
        now,
        nextAttempt: attempt,
        random: () => 1,
      });
      expect(jitterMs).toBeLessThanOrEqual(DEP_BLOCKED_RETRY_JITTER_MAX_MS);
      expect(jitterMs).toBeLessThanOrEqual(
        depBlockedRetryDelayMsForTest(attempt) * DEP_BLOCKED_RETRY_JITTER_RATIO,
      );
    }
  });

  it("degrades to the base instant on a non-finite draw rather than writing an Invalid Date", () => {
    // `scheduledRetryAt` is persisted, so a NaN here would be written to the
    // column. The base instant is the safe fallback: it is the value the curve
    // already authorises.
    const { dueAt, jitterMs } = computeDepBlockedRetryDueAt({
      now,
      nextAttempt: 6,
      random: () => Number.NaN,
    });
    expect(Number.isFinite(dueAt.getTime())).toBe(true);
    expect(jitterMs).toBe(0);
    expect(dueAt.getTime()).toBe(now.getTime() + DEP_BLOCKED_MAX_DELAY_MS);
  });

  // The coupling that makes this fix bigger than a one-liner. Every millisecond
  // of jitter is served INSIDE the attempt budget, so it moves the number
  // DEP_BLOCKED_MAX_PARK_AGE_MS has to clear. Pinned against the live constants
  // so a re-tune of the ratio, the jitter ceiling, the delay curve or the attempt
  // count fails here instead of silently eating the margin (BLO-29055's leak).
  describe("DEP_BLOCKED_MAX_PARK_AGE_MS re-derivation", () => {
    const baseBudgetMs = (() => {
      let total = DEP_BLOCKED_BASE_DELAY_MS;
      for (let attempt = 1; attempt <= DEP_BLOCKED_MAX_RETRY_ATTEMPTS; attempt += 1) {
        total += depBlockedRetryDelayMsForTest(attempt);
      }
      return total;
    })();

    it("still strictly exceeds the full attempt budget once jitter is added", () => {
      expect(baseBudgetMs).toBe(615 * MIN);
      expect(depBlockedRetryJitterWorstCaseMs()).toBe(35 * MIN);
      expect(baseBudgetMs + depBlockedRetryJitterWorstCaseMs()).toBeLessThan(
        DEP_BLOCKED_MAX_PARK_AGE_MS,
      );
    });

    it("retains at least an hour of margin, which is what DEP_BLOCKED_RETRY_JITTER_MAX_MS is derived from", () => {
      const marginMs =
        DEP_BLOCKED_MAX_PARK_AGE_MS - (baseBudgetMs + depBlockedRetryJitterWorstCaseMs());
      expect(marginMs).toBeGreaterThanOrEqual(60 * MIN);
      // And the ceiling is the largest whole minute that satisfies that: one
      // minute more would push the worst case past it. This is the assertion
      // that makes the constant derived rather than hand-picked.
      const worstCaseAt = (maxJitterMs: number) => {
        let total = 0;
        for (let attempt = 1; attempt <= DEP_BLOCKED_MAX_RETRY_ATTEMPTS; attempt += 1) {
          total += Math.min(
            depBlockedRetryDelayMsForTest(attempt) * DEP_BLOCKED_RETRY_JITTER_RATIO,
            maxJitterMs,
          );
        }
        return total;
      };
      expect(
        DEP_BLOCKED_MAX_PARK_AGE_MS - (baseBudgetMs + worstCaseAt(DEP_BLOCKED_RETRY_JITTER_MAX_MS + MIN)),
      ).toBeLessThan(60 * MIN);
    });
  });

  describe("recordDepBlockedRetryDispersion", () => {
    it("classifies a moved instant as dispersed and an unmoved one as undispersed", () => {
      expect(recordDepBlockedRetryDispersion({ jitterMs: 1 }).disposition).toBe("dispersed");
      expect(recordDepBlockedRetryDispersion({ jitterMs: 0 }).disposition).toBe("undispersed");
    });

    it("counts a non-finite jitter as undispersed rather than absorbing it", () => {
      // Fail-loud, unlike `classifyRetryInstantAlignment`: a NaN jitter means the
      // persisted instant is suspect, which this lane should surface.
      expect(recordDepBlockedRetryDispersion({ jitterMs: Number.NaN }).disposition).toBe(
        "undispersed",
      );
    });

    // PEN-4145 trap #1, which this lane must not re-introduce one layer down: a
    // series BORN at 1 on its first increment evaluates to 0 under `increase()`
    // forever, so an alert reading it is permanently silent. Both dispositions
    // are seeded at registry construction; this is the assertion that keeps them
    // seeded.
    it("zero-seeds both dispositions at startup so increase() can see a first event", async () => {
      const { body } = await renderMetrics();
      const published = new Set(
        body
          .split("\n")
          .filter((line) => line.startsWith(`${DEP_BLOCKED_RETRY_DISPERSION_METRIC}{`))
          .map((line) => /disposition="([^"]+)"/.exec(line)?.[1])
          .filter((disposition): disposition is string => disposition !== undefined),
      );
      for (const disposition of DEP_BLOCKED_RETRY_DISPERSION_DISPOSITIONS) {
        expect(
          published.has(disposition),
          `${DEP_BLOCKED_RETRY_DISPERSION_METRIC} is missing the ${disposition} series; an unseeded series reads 0 under increase() forever`,
        ).toBe(true);
      }
    });

    // The denominator is the whole point: without it this lane reads 0/0, which
    // is an empty lane and not a healthy scheduler (PEN-4145 trap #3). Before
    // this metric the lane had no denominator at all while carrying 100% of the
    // live park population.
    it("publishes a denominator covering every re-park, not only the undispersed ones", async () => {
      const before = await totalDispersionDecisions();
      recordDepBlockedRetryDispersion({ jitterMs: 1234 });
      expect(await totalDispersionDecisions()).toBe(before + 1);
    });
  });
});

/** Sum of every published `disposition` series, i.e. the alert expression's denominator. */
async function totalDispersionDecisions(): Promise<number> {
  const { body } = await renderMetrics();
  return body
    .split("\n")
    .filter((line) => line.startsWith(`${DEP_BLOCKED_RETRY_DISPERSION_METRIC}{`))
    .reduce((sum, line) => sum + Number(line.slice(line.lastIndexOf("}") + 1).trim()), 0);
}

/** The curve under test, re-stated here so the assertions above do not assert a function against itself. */
function depBlockedRetryDelayMsForTest(attempt: number): number {
  return Math.min(DEP_BLOCKED_BASE_DELAY_MS * Math.pow(2, attempt), DEP_BLOCKED_MAX_DELAY_MS);
}
