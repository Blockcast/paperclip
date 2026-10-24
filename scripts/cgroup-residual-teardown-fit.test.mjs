import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  MIN_FIT_POINTS,
  assertMeasurable,
  buildSegmentFits,
  cumulativeSum,
  fitOls,
  formatFitTable,
  parseMatrix,
  parseSeriesPods,
  residualQuery,
  restartQuery,
  segmentsFromRestarts,
  median,
  sliceWindow,
  summarizeDiscrimination,
  TEARDOWN_METRIC,
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
    // The `\{...\}` is required, not incidental: a bare `/_sum\[3600s\]/`
    // silently stops matching the moment a selector sits before the range,
    // which is exactly the shape trap 5 below requires.
    assert.match(query, /_sum\{[^}]*\}\[3600s\]/);
  });

  // ⛔ THE TRAP-5 PIN. The worker StatefulSet runs 2 replicas and the collector
  // migrates between them on a pod replacement (measured 2026-10-24 ~07:48Z).
  // An unscoped teardown sum therefore charges BOTH pods' work against ONE
  // pod's residual, and nothing downstream can catch it: `teardownCovered`
  // counts samples, and a sample from the wrong pod is still a sample, so the
  // table reported 7/7 coverage and r2 0.589 on a pairing where the measured
  // pod had done 23 s of the 746 s being regressed against it.
  it("REGRESSION (trap 5): all three queries select the SAME pod", () => {
    const pod = "paperclip-7";
    const sel = `pod="${pod}"`;
    for (const query of [residualQuery(pod), restartQuery(pod), teardownQuery(3600, pod)]) {
      assert.ok(
        query.includes(sel),
        `query is not scoped to ${pod}, so it cannot be paired with one: ${query}`,
      );
    }
    // And they agree by default, which is the case main() actually runs.
    for (const query of [residualQuery(), restartQuery(), teardownQuery(3600)]) {
      assert.match(query, /pod="paperclip-0"/);
    }
  });

  it("segments on container_start_time_seconds, never on a deploy commit", () => {
    const query = restartQuery();
    assert.match(query, /container_start_time_seconds/);
    assert.doesNotMatch(query, /deploy/);
  });
});

describe("module import is independent of argv[1]", () => {
  // ⛔ A module-scope `realpathSync(process.argv[1])` throws ENOENT when
  // argv[1] is SET but missing, which turns a plain `import` of this file into
  // a throw -- so the runner cannot even load the suite. Reproduced on the
  // pre-fix head: `IMPORT THREW -> ENOENT`. Needs a subprocess, because argv
  // cannot be rewritten once this module is in the cache.
  it("imports cleanly when argv[1] is set but does not exist", () => {
    const target = fileURLToPath(
      new URL("./cgroup-residual-teardown-fit.mjs", import.meta.url),
    );
    const probe = [
      'process.argv[1] = "/nonexistent-" + process.pid;',
      `await import(${JSON.stringify(target)});`,
      'console.log("ok");',
    ].join("\n");
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", probe], {
      encoding: "utf8",
    });
    assert.equal(out.trim(), "ok");
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

describe("assertMeasurable (an UNMEASURABLE window is not a non-result)", () => {
  const ok = {
    residual: [{ t: 1000, value: 1 }],
    teardown: [{ t: 1000, value: 1 }],
    restarts: [{ t: 1000, value: 500 }],
    start: 1000,
    end: 2000,
  };

  it("passes when all three series carry samples", () => {
    assert.doesNotThrow(() => assertMeasurable(ok));
  });

  // ⛔ THE REGRESSION PIN. Without the guard this window does not throw: it
  // flows into buildSegmentFits, every bucket becomes zero work, and the
  // script exits 0 reporting "NOT discriminating" -- announcing a property of
  // the REGIME when in truth the independent variable was never measured.
  it("refuses an empty teardown series rather than reporting a non-result", () => {
    assert.throws(
      () => assertMeasurable({ ...ok, teardown: [] }),
      /independent variable is absent.*measurement failure, not a non-result/s,
    );
  });

  it("refuses an empty residual or restart series as retention loss", () => {
    assert.throws(() => assertMeasurable({ ...ok, residual: [] }), /past retention/);
    assert.throws(() => assertMeasurable({ ...ok, restarts: [] }), /past retention/);
  });

  // The two causes get DIFFERENT messages on purpose: "past retention" sends
  // the reader to the window, "independent variable is absent" to #2175.
  it("distinguishes the absent-variable cause from retention loss", () => {
    assert.throws(
      () => assertMeasurable({ ...ok, teardown: [] }),
      (e) => !/past retention/.test(e.message),
    );
  });
});

describe("parseSeriesPods (naming the replica that HAS the data)", () => {
  const body = (data) => ({ status: "success", data });

  it("returns distinct pods, sorted", () => {
    assert.deepEqual(
      parseSeriesPods(
        body([
          { __name__: TEARDOWN_METRIC, pod: "paperclip-1", method: "worktree_remove" },
          { __name__: TEARDOWN_METRIC, pod: "paperclip-1", method: "inspect_safety" },
          { __name__: TEARDOWN_METRIC, pod: "paperclip-0", method: "inspect_safety" },
        ]),
      ),
      ["paperclip-0", "paperclip-1"],
    );
  });

  // Discovery runs on a path that has ALREADY failed, so a malformed or error
  // body must degrade to "I cannot name one", never to a throw that would
  // replace the real measurement failure with a parse error.
  it("degrades to [] on an error, malformed or pod-less body", () => {
    assert.deepEqual(parseSeriesPods({ status: "error", error: "boom" }), []);
    assert.deepEqual(parseSeriesPods({ status: "success", data: "not-an-array" }), []);
    assert.deepEqual(parseSeriesPods(undefined), []);
    assert.deepEqual(parseSeriesPods(body([{ __name__: TEARDOWN_METRIC }, null, { pod: "" }])), []);
  });
});

describe("assertMeasurable names the replica (collector migrates between pods)", () => {
  const broken = {
    residual: [{ t: 1000, value: 1 }],
    teardown: [],
    restarts: [{ t: 1000, value: 500 }],
    start: 1000,
    end: 2000,
    pod: "paperclip-0",
  };
  const messageOf = (input) => {
    try {
      assertMeasurable(input);
    } catch (error) {
      return error.message;
    }
    throw new Error("expected assertMeasurable to throw");
  };
  // Everything after the stable sentence is the enrichment.
  const hintOf = (input) => messageOf(input).split("not a non-result.")[1] ?? "";

  it("names the OTHER replicas and the flag that re-points the pairing", () => {
    const hint = hintOf({ ...broken, teardownPods: ["paperclip-0", "paperclip-1"] });
    assert.match(hint, /paperclip-1/);
    assert.match(hint, /--pod/);
    // The queried pod is the one WITHOUT data; listing it would send the
    // reader straight back to the replica that just failed them.
    assert.ok(!/paperclip-0/.test(hint));
  });

  // ⛔ DEGRADATION PIN. Discovery is best-effort: a 404, a timeout or a
  // Prometheus without the series all yield []. That path must reproduce the
  // previous message EXACTLY, so a failed enrichment can never be mistaken for
  // a different diagnosis.
  it("reproduces the pre-enrichment message byte for byte when discovery found nothing", () => {
    const omitted = messageOf({ ...broken });
    const empty = messageOf({ ...broken, teardownPods: [] });
    assert.equal(empty, omitted);
    assert.equal(hintOf({ ...broken, teardownPods: [] }), "");
    assert.ok(!/Replicas that DID export/.test(empty));
  });

  // Series present but no samples is a WINDOW problem. Sending that reader to
  // the sibling costs them the retention they are racing.
  it("distinguishes a window/step problem from the wrong replica", () => {
    const hint = hintOf({ ...broken, teardownPods: ["paperclip-0"] });
    assert.match(hint, /window or step/);
    assert.ok(!/Replicas that DID export/.test(hint));
  });

  // ⛔ The hint must not out-claim its instrument. `/api/v1/series` resolves
  // against every block OVERLAPPING [start,end], so an index hit does NOT prove
  // a sample inside the window: a replica whose series ended just before
  // `--start` still comes back "present". Excluding that replica would be a
  // confident wrong answer handed to someone mid-incident -- the exact failure
  // this script exists to refuse. Hedge language is load-bearing, not padding.
  it("hedges the window/step reading instead of excluding the replica", () => {
    const hint = hintOf({ ...broken, teardownPods: ["paperclip-0"] });
    assert.match(hint, /LIKELY/);
    assert.match(hint, /overlapping/i);
    assert.match(hint, /unconfirmed, not excluded/);
    // The retired wording asserted the replica was ruled out.
    assert.ok(!/not the wrong replica\./.test(hint));
    assert.ok(!/DOES exist/.test(hint));
  });

  // ⛔ PRECEDENCE PIN. Both signals can be true at once: the index matched the
  // queried pod AND a sibling. The sibling must win (it is the actionable
  // lead), but the window signal must not vanish -- otherwise a reader whose
  // `--pod` re-run also comes back empty has been told nothing about the window.
  it("prefers the sibling lead but keeps the window signal when both apply", () => {
    const hint = hintOf({ ...broken, teardownPods: ["paperclip-0", "paperclip-1"] });
    assert.match(hint, /Replicas that DID export/);
    assert.match(hint, /paperclip-1/);
    assert.match(hint, /stronger lead/);
    assert.match(hint, /suspect the window/);
    // Still must not name the replica that just failed them as a destination.
    assert.ok(!/paperclip-0/.test(hint));
  });

  // The enrichment must not soften the failure into a non-result.
  it("still throws, and still reads as a measurement failure", () => {
    assert.throws(
      () => assertMeasurable({ ...broken, teardownPods: ["paperclip-1"] }),
      /independent variable is absent.*measurement failure, not a non-result/s,
    );
  });

  // Retention loss is a different cause and must not acquire a replica hint.
  it("leaves the retention message alone", () => {
    assert.throws(
      () => assertMeasurable({ ...broken, residual: [], teardownPods: ["paperclip-1"] }),
      (e) => /past retention/.test(e.message) && !/Replicas that DID export/.test(e.message),
    );
  });
});

describe("teardown coverage (`?? 0` must not be silent)", () => {
  const restarts = Array.from({ length: 6 }, (_, i) => ({
    t: (i + 1) * 1000,
    value: 500,
  }));
  const residual = Array.from({ length: 6 }, (_, i) => ({
    t: (i + 1) * 1000,
    value: (i + 1) * GIB,
  }));

  it("reports how many interior buckets actually carried a teardown sample", () => {
    const teardown = [
      { t: 2000, value: 100 },
      { t: 3000, value: 100 },
    ];
    const [fit] = buildSegmentFits({ residual, teardown, restarts });
    assert.equal(fit.teardownCovered, 2);
    assert.equal(fit.teardownBuckets, 5);
  });

  it("reports zero coverage rather than zero work when teardown is empty", () => {
    const [fit] = buildSegmentFits({ residual, teardown: [], restarts });
    assert.equal(fit.teardownCovered, 0);
    assert.ok(fit.teardownBuckets > 0);
    assert.equal(fit.teardownSeconds, 0);
  });

  it("surfaces coverage in the table", () => {
    const teardown = [{ t: 2000, value: 100 }];
    const table = formatFitTable(buildSegmentFits({ residual, teardown, restarts }));
    assert.match(table.split("\n")[0], /\| cov \|/);
    assert.match(table.split("\n")[1], /\| 1\/5 \|/);
  });
});

describe("median", () => {
  it("returns the middle element for odd length", () => {
    assert.equal(median([1, 2, 3]), 2);
  });
  it("averages the middle pair for even length", () => {
    assert.equal(median([1, 2, 3, 4]), 2.5);
  });
  it("returns null for an empty array", () => {
    assert.equal(median([]), null);
  });
});

describe("summarizeDiscrimination r2 spread", () => {
  // max(r2) gates the verdict, so ONE clean segment can carry it. That is
  // intended -- but the spread must be reported so it cannot be misread as
  // "every segment agrees".
  const fits = [
    { slope: 1, r2: 0.9 },
    { slope: 1, r2: 0.01 },
    { slope: 1, r2: 0.02 },
  ];

  it("still discriminates on one well-explained segment", () => {
    assert.equal(summarizeDiscrimination(fits).discriminating, true);
  });

  it("reports min and median alongside the max that gates", () => {
    const v = summarizeDiscrimination(fits);
    assert.equal(v.maxR2, 0.9);
    assert.equal(v.minR2, 0.01);
    assert.equal(v.medianR2, 0.02);
  });

  it("reports the spread on a low-explanatory-power refusal too", () => {
    const v = summarizeDiscrimination([
      { slope: 1, r2: 0.1 },
      { slope: 1, r2: 0.3 },
    ]);
    assert.equal(v.reason, "low-explanatory-power");
    assert.equal(v.maxR2, 0.3);
    assert.equal(v.minR2, 0.1);
  });
});
