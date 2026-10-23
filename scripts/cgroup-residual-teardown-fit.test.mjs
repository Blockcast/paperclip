import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MIN_FIT_POINTS,
  buildSegmentFits,
  cumulativeSum,
  fitOls,
  formatFitTable,
  parseMatrix,
  residualQuery,
  restartQuery,
  segmentsFromRestarts,
  sliceWindow,
  summarizeDiscrimination,
  teardownQuery,
} from "./cgroup-residual-teardown-fit.mjs";

const GIB = 1024 ** 3;

describe("fitOls", () => {
  it("recovers an exact line", () => {
    const fit = fitOls([
      { x: 0, y: 1 },
      { x: 1, y: 3 },
      { x: 2, y: 5 },
      { x: 3, y: 7 },
    ]);
    assert.equal(fit.n, 4);
    assert.ok(Math.abs(fit.slope - 2) < 1e-12);
    assert.ok(Math.abs(fit.intercept - 1) < 1e-12);
    assert.ok(Math.abs(fit.r2 - 1) < 1e-12);
  });

  it("refuses fewer than MIN_FIT_POINTS rather than reporting a two-point slope", () => {
    const fit = fitOls([
      { x: 0, y: 0 },
      { x: 1, y: 1 },
    ]);
    assert.equal(fit.n, 2);
    assert.equal(fit.slope, null);
    assert.ok(MIN_FIT_POINTS > 2);
  });

  it("returns r2 null, not 0, when y never varies", () => {
    // Degenerate rather than "fitted and explains nothing". Collapsing the two
    // would hide a flat segment inside a table of real ones.
    const fit = fitOls([
      { x: 0, y: 5 },
      { x: 1, y: 5 },
      { x: 2, y: 5 },
    ]);
    assert.equal(fit.r2, null);
    assert.equal(fit.slope, 0);
  });

  it("refuses a segment that did no teardown work", () => {
    // x constant: the segment cannot speak to a teardown slope at all.
    const fit = fitOls([
      { x: 7, y: 1 },
      { x: 7, y: 2 },
      { x: 7, y: 3 },
    ]);
    assert.equal(fit.slope, null);
    assert.equal(fit.r2, null);
  });

  it("ignores non-finite points instead of propagating NaN", () => {
    const fit = fitOls([
      { x: 0, y: 1 },
      { x: 1, y: Number.NaN },
      { x: 2, y: 5 },
      { x: 3, y: 7 },
    ]);
    assert.equal(fit.n, 3);
    assert.ok(Number.isFinite(fit.slope));
  });
});

describe("segmentsFromRestarts (trap 2: segment on restart, not deploy)", () => {
  it("splits where container_start_time_seconds changes value", () => {
    const segments = segmentsFromRestarts([
      { t: 100, value: 10 },
      { t: 200, value: 10 },
      { t: 300, value: 10 },
      { t: 400, value: 99 },
      { t: 500, value: 99 },
      { t: 600, value: 99 },
    ]);
    assert.equal(segments.length, 2);
    assert.deepEqual(
      segments.map((s) => [s.startEpoch, s.fromT, s.toT]),
      [
        [10, 100, 300],
        [99, 400, 600],
      ],
    );
  });

  it("drops a single-sample segment, which has no interior to fit", () => {
    const segments = segmentsFromRestarts([
      { t: 100, value: 1 },
      { t: 200, value: 2 },
      { t: 300, value: 3 },
    ]);
    assert.deepEqual(segments, []);
  });

  it("sorts unordered input before segmenting", () => {
    const segments = segmentsFromRestarts([
      { t: 300, value: 10 },
      { t: 100, value: 10 },
      { t: 200, value: 10 },
    ]);
    assert.equal(segments.length, 1);
    assert.equal(segments[0].fromT, 100);
    assert.equal(segments[0].toT, 300);
  });
});

describe("cumulativeSum", () => {
  it("accumulates in order and treats non-finite as zero", () => {
    assert.deepEqual(cumulativeSum([1, 2, 3]), [1, 3, 6]);
    assert.deepEqual(cumulativeSum([1, Number.NaN, 3]), [1, 1, 4]);
    assert.deepEqual(cumulativeSum([]), []);
  });
});

describe("buildSegmentFits", () => {
  // Two segments either side of a restart. Within each, residual rises with
  // cumulative teardown work; ACROSS the restart residual drops back, because
  // the cgroup was destroyed and rebuilt.
  const restarts = [
    { t: 1000, value: 500 },
    { t: 2000, value: 500 },
    { t: 3000, value: 500 },
    { t: 4000, value: 500 },
    { t: 5000, value: 900 },
    { t: 6000, value: 900 },
    { t: 7000, value: 900 },
    { t: 8000, value: 900 },
  ];
  const residual = [
    { t: 1000, value: 1 * GIB },
    { t: 2000, value: 2 * GIB },
    { t: 3000, value: 3 * GIB },
    { t: 4000, value: 4 * GIB },
    { t: 5000, value: 1 * GIB },
    { t: 6000, value: 2 * GIB },
    { t: 7000, value: 3 * GIB },
    { t: 8000, value: 4 * GIB },
  ];
  const teardown = Array.from({ length: 8 }, (_, i) => ({
    t: (i + 1) * 1000,
    value: 100,
  }));

  it("produces one fit per restart-delimited segment", () => {
    const fits = buildSegmentFits({ residual, teardown, restarts });
    assert.equal(fits.length, 2);
    assert.deepEqual(
      fits.map((f) => f.startEpoch),
      [500, 900],
    );
  });

  it("excludes the boundary bucket, which straddles the reset", () => {
    const fits = buildSegmentFits({ residual, teardown, restarts });
    // Segment 1 spans t=1000..4000 but t=1000 is its own opening boundary.
    assert.equal(fits[0].n, 3);
    assert.ok(Math.abs(fits[0].residualStartGib - 2) < 1e-9);
    assert.ok(Math.abs(fits[0].residualEndGib - 4) < 1e-9);
  });

  it("never carries cumulative teardown work across a restart", () => {
    const fits = buildSegmentFits({ residual, teardown, restarts });
    // Each segment contributes 3 interior buckets x 100 s. If work leaked
    // across the boundary the second segment would read 600, not 300.
    assert.equal(fits[0].teardownSeconds, 300);
    assert.equal(fits[1].teardownSeconds, 300);
  });

  it("REGRESSION (trap 1): the whole-window fit is not the segmented one", () => {
    // The point of the script. Fitting across the reset regresses a sawtooth
    // and yields a slope near zero with no explanatory power, while each
    // segment on its own is a clean positive line. A reader who skipped
    // segmentation would read the first number as "weak support".
    const segmented = buildSegmentFits({ residual, teardown, restarts });
    const whole = fitOls(
      residual.map((r, i) => ({ x: (i + 1) * 100, y: r.value / GIB })),
    );
    for (const fit of segmented) {
      assert.ok(fit.r2 > 0.99, "each segment is a clean line");
      assert.ok(fit.slope > 0);
    }
    const worstSegment = Math.min(...segmented.map((f) => f.r2));
    // The assertion is relative, not a magic threshold: the whole-window fit
    // keeps a POSITIVE slope -- which is what makes it read as weak support --
    // while its explanatory power collapses against every segment's.
    assert.ok(whole.slope > 0, "the artifact still points the wrong way");
    assert.ok(
      whole.r2 < worstSegment / 2,
      `whole-window r2 ${whole.r2} should collapse against segment r2 ${worstSegment}`,
    );
  });
});

describe("summarizeDiscrimination", () => {
  it("REGRESSION: reports sign-unstable rather than averaging contradictory slopes", () => {
    // Encodes the measured 2026-10-22 quiet-regime result: 4 negative and 3
    // positive slopes, max r2 0.473. That is an absence of a result, and
    // criterion (b) compares a slope against a baseline, so a window whose
    // segments disagree on sign can supply neither side.
    const verdict = summarizeDiscrimination([
      { slope: -0.000025, r2: 0.0 },
      { slope: -0.000616, r2: 0.001 },
      { slope: 0.026387, r2: 0.473 },
      { slope: 0.003355, r2: 0.298 },
      { slope: 0.003465, r2: 0.162 },
      { slope: -0.009404, r2: 0.077 },
      { slope: -0.005125, r2: 0.027 },
    ]);
    assert.equal(verdict.discriminating, false);
    assert.equal(verdict.reason, "sign-unstable");
    assert.equal(verdict.positive, 3);
    assert.equal(verdict.negative, 4);
  });

  it("declines a sign-stable window whose explanatory power is low", () => {
    const verdict = summarizeDiscrimination([
      { slope: 0.01, r2: 0.1 },
      { slope: 0.02, r2: 0.2 },
    ]);
    assert.equal(verdict.discriminating, false);
    assert.equal(verdict.reason, "low-explanatory-power");
  });

  it("accepts a sign-stable, well-explained window", () => {
    const verdict = summarizeDiscrimination([
      { slope: 0.21, r2: 0.967 },
      { slope: 0.19, r2: 0.8 },
    ]);
    assert.equal(verdict.discriminating, true);
    assert.equal(verdict.fitted, 2);
  });

  it("reports no-fittable-segment rather than claiming discrimination on an empty set", () => {
    assert.equal(summarizeDiscrimination([]).reason, "no-fittable-segment");
    assert.equal(
      summarizeDiscrimination([{ slope: null, r2: null }]).reason,
      "no-fittable-segment",
    );
  });
});

describe("queries", () => {
  it("REGRESSION (trap 4): max() wraps every cAdvisor term before subtracting", () => {
    // The pod returns two series differing only in a flapping node label.
    const query = residualQuery();
    assert.match(query, /max\(container_memory_usage_bytes/);
    assert.match(query, /max\(container_memory_rss/);
    assert.match(query, /max\(container_memory_cache/);
  });

  it("REGRESSION (trap 3): teardown sums every label dimension", () => {
    const query = teardownQuery(3600);
    assert.match(query, /^sum\(increase\(/);
    // A `by (method)` clause here would drop `inspect_safety`'s sibling
    // dimensions and silently change the variable; `inspect_safety` alone is
    // 85.6% of the integral.
    assert.doesNotMatch(query, /\bby\s*\(/);
    assert.doesNotMatch(query, /without\s*\(/);
    // increase(), not a raw _sum read: the counter resets on restart.
    assert.match(query, /_sum\[3600s\]/);
  });

  it("segments on container_start_time_seconds, never on a deploy commit", () => {
    const query = restartQuery();
    assert.match(query, /container_start_time_seconds/);
    assert.doesNotMatch(query, /deploy/);
  });
});

describe("sliceWindow", () => {
  it("splits a window that would time out, and covers it exactly", () => {
    const slices = sliceWindow(0, 10 * 24 * 3600);
    assert.ok(slices.length > 1);
    assert.equal(slices[0].from, 0);
    assert.equal(slices[slices.length - 1].to, 10 * 24 * 3600);
    for (let i = 1; i < slices.length; i += 1) {
      assert.equal(slices[i].from, slices[i - 1].to);
    }
  });

  it("leaves a short window as one slice", () => {
    assert.deepEqual(sliceWindow(0, 3600), [{ from: 0, to: 3600 }]);
  });
});

describe("parseMatrix", () => {
  it("flattens and sorts a matrix response", () => {
    const samples = parseMatrix({
      data: {
        result: [
          { metric: {}, values: [[200, "2"], [100, "1"]] },
          { metric: {}, values: [[300, "3"]] },
        ],
      },
    });
    assert.deepEqual(samples, [
      { t: 100, value: 1 },
      { t: 200, value: 2 },
      { t: 300, value: 3 },
    ]);
  });

  it("drops NaN strings and tolerates an empty body", () => {
    assert.deepEqual(parseMatrix({ data: { result: [{ values: [[1, "NaN"]] }] } }), []);
    assert.deepEqual(parseMatrix({}), []);
    assert.deepEqual(parseMatrix(null), []);
  });
});

describe("formatFitTable", () => {
  it("renders a dash where a slope was refused rather than a zero", () => {
    const table = formatFitTable([
      {
        fromT: 0,
        toT: 3600,
        n: 2,
        uptimeHours: 1,
        teardownSeconds: 0,
        residualStartGib: null,
        residualEndGib: null,
        slope: null,
        r2: null,
      },
    ]);
    const row = table.split("\n")[1];
    assert.match(row, /\| - \| -$/);
  });
});
