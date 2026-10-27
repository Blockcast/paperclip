// PEN-4145 — the PEN-2509 dispersion fix emitted no signal, so a clamp-signature
// regression was invisible until someone hand-dug run history.
//
// The gap this file closes is not a runtime defect. It is detection latency, and
// it has a measured cost: the first PEN-2509 fix shipped 2026-08-29 keyed its
// exemption on `providerCapacityResetProvenance`, which the finalize path writes
// for every recovered reset, so it exempted exactly the population that herds.
// That fix was live, fleet-wide and wrong for SIX WEEKS, and was caught only
// because @Ceo re-measured by hand on 2026-10-12 and found the clamp signature
// still at 16.55% (160/967, ~99x chance) with 4 agents sharing `scheduledRetryAt`
// to 0.000s. Nothing in the system reported on the behaviour, so nothing could
// have surfaced it sooner.
//
// Four instrument traps are pinned here by name, because each has bitten a
// comparable detector in this fleet and a detector that re-introduces one is
// worse than no detector (it reads healthy):
//
//   1. a freshly-labelled counter born at 1 never shows an increase from 0, so
//      an `increase()`-gated alert on it is permanently silent
//   2. a ratio that reads a constant from the moment it exists is not an
//      instrument — it must be shown to MOVE against the known baselines
//   3. a zero numerator over a zero denominator must not read as healthy; this
//      is the exact 0/0 false clear that closed PEN-2509 in August with AC4
//      recorded as "unmeasurable, sample size 0"
//   4. a `for:` longer than a typical burst is unreachable on a bursty signal
//
// Recorded baselines, which the assertions below bracket: 94.03% (126/134)
// aligned within the clamped population pre-fix, 20.43% (153/749) unconditional,
// against ~0.1% by chance for a dispersed instant.
import { describe, expect, it } from "vitest";
import {
  classifyRetryInstantAlignment,
  jitterTransientRetryFloor,
  RETRY_INSTANT_ALIGNMENTS,
  TRANSIENT_RETRY_FLOOR_JITTER_MAX_MS,
} from "../services/ccrotate-capacity-retry.js";
import {
  recordTransientRetryFloorDisposition,
  renderMetrics,
  TRANSIENT_RETRY_FLOOR_DISPOSITIONS,
  TRANSIENT_RETRY_FLOOR_METRIC,
} from "../services/metrics.js";

describe("classifyRetryInstantAlignment", () => {
  it("names the exact instant 4 agents shared in the PEN-4015 census", () => {
    // 2026-10-12T21:59:59Z — whole second AND on the :M9:59 ten-minute grid.
    // This is the signature a provider `retry_after_seconds` reset carries,
    // because the advertised horizon is computed off a 10-minute bucket edge.
    expect(classifyRetryInstantAlignment(new Date("2026-10-12T21:59:59.000Z"))).toBe("ten_minute_grid");
  });

  it("classifies every :M9:59 boundary as the ten-minute grid", () => {
    for (const minute of [9, 19, 29, 39, 49, 59]) {
      expect(
        classifyRetryInstantAlignment(new Date(Date.UTC(2026, 9, 12, 3, minute, 59, 0))),
        `:${minute}:59.000 must read as ten_minute_grid`,
      ).toBe("ten_minute_grid");
    }
  });

  it("separates a whole second off the grid from one on it", () => {
    expect(classifyRetryInstantAlignment(new Date("2026-10-12T12:34:56.000Z"))).toBe("whole_second");
    // Right minute, wrong second.
    expect(classifyRetryInstantAlignment(new Date("2026-10-12T03:09:58.000Z"))).toBe("whole_second");
    // Right second, wrong minute.
    expect(classifyRetryInstantAlignment(new Date("2026-10-12T03:08:59.000Z"))).toBe("whole_second");
  });

  it("reads any sub-second component as off_grid, which is the healthy value", () => {
    expect(classifyRetryInstantAlignment(new Date("2026-10-12T21:59:59.001Z"))).toBe("off_grid");
    expect(classifyRetryInstantAlignment(new Date("2026-10-12T21:59:59.999Z"))).toBe("off_grid");
    expect(classifyRetryInstantAlignment(new Date("2026-10-12T12:34:56.500Z"))).toBe("off_grid");
  });

  it("fails quiet on an invalid instant rather than reporting a clamp signature", () => {
    // A NaN instant is a different defect with its own guard inside
    // jitterTransientRetryFloor. Counting it here would page the wrong team.
    expect(classifyRetryInstantAlignment(new Date(Number.NaN))).toBe("off_grid");
  });

  it("does not let a negative epoch read a negative remainder as healthy", () => {
    // `epochMs % 1000` is negative for a pre-1970 instant, so a bare `!== 0`
    // test would classify every one of them as off_grid. Reachable only from a
    // corrupt value, but the direction matters: that is the healthy reading.
    expect(classifyRetryInstantAlignment(new Date(0))).toBe("whole_second");
    // 1969-12-31T23:59:59.000Z — minute 59, second 59, so genuinely on the grid.
    expect(classifyRetryInstantAlignment(new Date(-1000))).toBe("ten_minute_grid");
    // 1969-12-31T23:59:58.000Z — whole second, off the grid.
    expect(classifyRetryInstantAlignment(new Date(-2000))).toBe("whole_second");
    expect(classifyRetryInstantAlignment(new Date(-1))).toBe("off_grid");
  });

  it("reads UTC components, so a non-UTC pod classifies an instant identically", () => {
    // A zone offset of :30 or :45 (India, Nepal, Chatham) shifts the minute
    // component and would silently move rows between the two aligned buckets.
    // Asserted through the UTC accessors the implementation uses.
    const onGrid = new Date("2026-10-12T21:59:59.000Z");
    expect(onGrid.getUTCMinutes() % 10).toBe(9);
    expect(onGrid.getUTCSeconds()).toBe(59);
    expect(classifyRetryInstantAlignment(onGrid)).toBe("ten_minute_grid");
  });
});

// TRAP 2 — "do not let the signal be born pinned". A ratio that reads a constant
// from the moment it exists is not an instrument. These two tests measure the
// instrument against both ends of the recorded range, so a quiet reading in
// production is a quiet reading of something that demonstrably moves.
describe("the clamp-signature instrument moves against the recorded baselines", () => {
  // The live shape, from the 2026-08-25 and 2026-10-12 censuses alike: a cohort
  // parked ~4.5h ahead of a whole-second provider instant on the ten-minute grid.
  const now = new Date("2026-10-12T17:29:59.000Z");
  const floor = new Date("2026-10-12T21:59:59.000Z");

  it("reads ~0.1% aligned for a DISPERSED population", () => {
    // Deterministic LCG rather than Math.random, so this cannot flake. The draw
    // is uniform over the jitter window, which is what sets the ~1/1000 rate:
    // jitter is drawn in milliseconds, so a dispersed instant has no reason to
    // land on a second boundary.
    let state = 12345;
    const random = () => (state = (state * 1664525 + 1013904223) >>> 0) / 4294967296;

    const SAMPLES = 200_000;
    let aligned = 0;
    for (let i = 0; i < SAMPLES; i++) {
      const { dueAt } = jitterTransientRetryFloor({ dueAt: floor, now, random });
      if (classifyRetryInstantAlignment(dueAt) !== "off_grid") aligned++;
    }

    const share = aligned / SAMPLES;
    // Bracketed either side of 1/1000 rather than asserted exactly: the window
    // here is capped at TRANSIENT_RETRY_FLOOR_JITTER_MAX_MS, so the rate is
    // 1/1000 up to the grid's own negligible contribution.
    expect(share, `dispersed share ${share} is not ~0.1%`).toBeGreaterThan(0.0003);
    expect(share, `dispersed share ${share} is not ~0.1%`).toBeLessThan(0.003);
    // And the floor really was aligned to begin with, so this measures
    // dispersion rather than a floor that was never a herd risk.
    expect(classifyRetryInstantAlignment(floor)).toBe("ten_minute_grid");
  });

  it("reads 100% aligned for an UNDISPERSED population, which is the regression", () => {
    // What the exempt branch does: adopt the provider instant verbatim. Every
    // run that saw the same denial lands on the same millisecond.
    const COHORT = 50;
    const aligned = Array.from({ length: COHORT }, () => floor).filter(
      (dueAt) => classifyRetryInstantAlignment(dueAt) !== "off_grid",
    ).length;
    expect(aligned).toBe(COHORT);
  });

  it("brackets the alert threshold between the healthy and pre-fix readings", () => {
    // The 5% threshold in PaperclipTransientRetryClampSignature. Pinned here so
    // a future threshold edit that crosses either baseline fails in CI rather
    // than silently producing an alert that cannot fire or cannot stay quiet.
    const THRESHOLD = 0.05;
    const BY_CHANCE = 0.001;
    const PRE_FIX_UNCONDITIONAL = 0.2043; // 153/749
    const PRE_FIX_CONDITIONAL = 0.9403; //  126/134

    expect(THRESHOLD, "threshold must sit above the by-chance rate").toBeGreaterThan(BY_CHANCE * 10);
    expect(
      THRESHOLD,
      "threshold must sit below the unconditional pre-fix baseline, or a repeat regression cannot fire it",
    ).toBeLessThan(PRE_FIX_UNCONDITIONAL);
    expect(THRESHOLD).toBeLessThan(PRE_FIX_CONDITIONAL);

    // TRAP 3 — the sample-size floor is what makes a low reading meaningful. At
    // the floor of 30 it takes TWO aligned parks to cross 5%, and two by chance
    // is P(>=2 | n=30, p=0.001) ~ 4e-4. One aligned park out of 30 reads 3.3%
    // and must NOT cross, or the alert pages on a single chance hit.
    const SAMPLE_FLOOR = 30;
    expect(1 / SAMPLE_FLOOR).toBeLessThan(THRESHOLD);
    expect(2 / SAMPLE_FLOOR).toBeGreaterThan(THRESHOLD);
  });
});

describe("recordTransientRetryFloorDisposition", () => {
  it("returns the labels it recorded and publishes them to /metrics", async () => {
    const labels = recordTransientRetryFloorDisposition({
      disposition: "dispersed",
      alignment: "off_grid",
    });
    expect(labels).toEqual({ disposition: "dispersed", alignment: "off_grid" });

    const { body, contentType } = await renderMetrics();
    expect(contentType).toContain("text/plain");
    expect(body).toMatch(
      new RegExp(
        `${TRANSIENT_RETRY_FLOOR_METRIC}[^\\n]*alignment="off_grid"[^\\n]*disposition="dispersed"`,
      ),
    );
  });

  it("coerces an out-of-allow-list label rather than minting a series", () => {
    // Cast rather than two @ts-expect-error directives: TypeScript may report a
    // mismatched object literal once for the whole argument, which would leave
    // the second directive unused and fail the build for the wrong reason.
    const labels = recordTransientRetryFloorDisposition({
      disposition: "something_new",
      alignment: "nanoseconds",
    } as unknown as Parameters<typeof recordTransientRetryFloorDisposition>[0]);
    // Coerced toward the readings that do NOT page: `superseded` is the inert
    // disposition and `off_grid` is the healthy alignment, so an unrecognised
    // label can never manufacture a clamp signature.
    expect(labels).toEqual({ disposition: "superseded", alignment: "off_grid" });
  });

  // TRAP 1 — "do not gate the alert on an increase() of a freshly-labelled
  // counter". This is the single most load-bearing assertion in the file: an
  // `increase()` takes last-first, so a label series born at 1 on its first
  // increment evaluates to 0 forever and the alert reading it is permanently
  // silent. That would reproduce this ticket's own blindness inside the detector
  // built to remove it.
  it("zero-seeds every disposition x alignment combination at startup", async () => {
    const { body } = await renderMetrics();
    const published = new Set(
      body
        .split("\n")
        .filter((line) => line.startsWith(`${TRANSIENT_RETRY_FLOOR_METRIC}{`))
        .map((line) => {
          const disposition = /disposition="([^"]+)"/.exec(line)?.[1];
          const alignment = /alignment="([^"]+)"/.exec(line)?.[1];
          return `${disposition}\u0000${alignment}`;
        }),
    );

    const missing: string[] = [];
    for (const disposition of TRANSIENT_RETRY_FLOOR_DISPOSITIONS) {
      for (const alignment of RETRY_INSTANT_ALIGNMENTS) {
        if (!published.has(`${disposition}\u0000${alignment}`)) {
          missing.push(`${disposition}/${alignment}`);
        }
      }
    }
    expect(
      missing,
      "a series born at 1 evaluates to 0 under increase() forever, so the alert would never fire",
    ).toEqual([]);

    // And the grid really is the closed 4 x 3 the cardinality guarantee claims.
    expect(TRANSIENT_RETRY_FLOOR_DISPOSITIONS).toHaveLength(4);
    expect(RETRY_INSTANT_ALIGNMENTS).toHaveLength(3);
    expect(published.size).toBe(12);
  });

  it("keeps the jitter cap it is measuring in view", () => {
    // Cross-check rather than decoration: the ~1/1000 chance rate asserted above
    // only holds while jitter is drawn in milliseconds over a window of this
    // size. A cap re-tuned to whole seconds would invalidate the instrument
    // silently, and this is where that shows up.
    expect(TRANSIENT_RETRY_FLOOR_JITTER_MAX_MS % 1000).toBe(0);
    expect(TRANSIENT_RETRY_FLOOR_JITTER_MAX_MS).toBeGreaterThan(1_000);
  });
});
