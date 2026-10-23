// PEN-3692: fit cgroup residual against measured workspace-teardown work.
//
// This row's closing criterion (b) asks whether "the slope of cgroup residual
// against measured teardown work falls materially". That slope is NOT something
// you can read off a dashboard, and every naive way of computing it is wrong in
// a way that still produces a confident-looking number. This script exists
// because the procedure was validated once, by hand, against live data, and the
// window it must be re-run in is PERISHABLE.
//
// ## Why it is perishable, and why that forces a script
//
// Prometheus retention here is ~7 days. The independent variable
// (`paperclip_execution_workspace_teardown_duration_seconds`) was only
// introduced by #2175 on 2026-10-05, so it did not exist during the 09-25..09-28
// excursion this row is about -- no excursion-regime slope was ever recorded.
// Ruling §3 says the load that produces one cannot be scheduled. So the fit can
// only ever be made in the ~7 days following an unscheduled failure storm, by
// whoever happens to wake then. A procedure that lives only in an issue comment
// gets re-derived under time pressure, and this row has already had to withdraw
// two separate published peak tables to mis-measurement.
//
// ## The four traps, each measured rather than assumed
//
//  1. DO NOT fit the whole window. The cgroup is destroyed and rebuilt on every
//     container restart, so a whole-window fit regresses ACROSS resets. Measured
//     2026-10-22 over 164 hourly buckets: slope +2.79e-07 GiB/teardown-s at
//     r2 = 0.0032. Read carelessly that is "weak support for the hypothesis". It
//     is an artifact of the resets.
//
//  2. SEGMENT ON `container_start_time_seconds`, NOT ON DEPLOYS. Restarts are a
//     strict superset of deploys -- the 2026-10-19T00:30:18Z restart matched no
//     deploy at all. Deploy-based segmentation yielded 7 segments and silently
//     merged a reset into the longest one; restart-based yielded 9. The reset
//     key must be the thing that actually destroys the cgroup.
//
//  3. SUM TEARDOWN OVER EVERY LABEL DIMENSION, not just the removal methods.
//     `inspect_safety` (the collector's `git status` safety walks) is 85.6% of
//     the 7-day integral, 5.92x the `worktree_remove` term. The series is also
//     split by `cleanup_reason` and `trigger`, so an integral keyed on `method`
//     alone is a different variable. Dropping the dominant term would reproduce
//     exactly the mis-attribution this row exists to replace.
//
//  4. `max()` EVERY cAdvisor TERM BEFORE SUBTRACTING. `container_memory_*` for
//     this pod returns TWO series differing only in a node label that flaps; the
//     minority series carries a handful of samples and can be returned first.
//
// And one more that is about reading the output rather than computing it:
// in the QUIET regime this fit does not discriminate. Measured across 7
// restart-delimited segments: 4 negative slopes, 3 positive, spanning -0.0094 to
// +0.0264 GiB per 1000 teardown-s, max r2 = 0.473. Quiet-regime data CANNOT
// supply a baseline, so the script reports sign-stability explicitly rather than
// leaving a reader to average seven contradictory slopes into one.
//
// The counters are per-process and reset on restart, so teardown work is taken
// as `increase(...)` per bucket and accumulated WITHIN a segment, never across.
//
// Usage:
//   node scripts/cgroup-residual-teardown-fit.mjs \
//     --prometheus-url http://prometheus.monitoring.svc.cluster.local:9090 \
//     --start 2026-10-16T00:00:00Z --end 2026-10-22T20:00:00Z
//
// Exit status is 0 whenever the fit ran; a non-discriminating window is a
// RESULT, not an error. It exits non-zero only when it could not measure.

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

const DEFAULT_POD = "paperclip-0";
const DEFAULT_CONTAINER = "paperclip";
const DEFAULT_STEP_SECONDS = 3600;
const GIB = 1024 ** 3;

/** Minimum points before a slope is reported at all. */
export const MIN_FIT_POINTS = 3;

/**
 * Prometheus range queries over a full retention window time out at 30 s, so
 * every range read is sliced. Three days was measured to complete comfortably.
 */
export const MAX_SLICE_SECONDS = 3 * 24 * 3600;

/**
 * Residual = usage - rss - cache, each `max()`-ed first (trap 4).
 *
 * This is the same quantity the CTO's original r = 0.9802 correlation was built
 * on. It is NOT `working_set`: a `working_set`-keyed variant was shown to be
 * silent on 09-25, the worst day of the excursion.
 */
export function residualQuery(pod = DEFAULT_POD, container = DEFAULT_CONTAINER) {
  const sel = `{pod="${pod}",container="${container}"}`;
  return (
    `max(container_memory_usage_bytes${sel})` +
    ` - max(container_memory_rss${sel})` +
    ` - max(container_memory_cache${sel})`
  );
}

/**
 * Teardown work per bucket, summed over EVERY label dimension (trap 3).
 *
 * A bare `sum(...)` with no `by` clause is load-bearing here: it collapses
 * `method`, `cleanup_reason` and `trigger` together. `increase()` rather than a
 * raw `_sum` read because the counter resets on restart.
 */
export function teardownQuery(stepSeconds = DEFAULT_STEP_SECONDS) {
  return `sum(increase(paperclip_execution_workspace_teardown_duration_seconds_sum[${stepSeconds}s]))`;
}

/** The segmentation key (trap 2). Never deploy commits. */
export function restartQuery(pod = DEFAULT_POD, container = DEFAULT_CONTAINER) {
  return `max(container_start_time_seconds{pod="${pod}",container="${container}"})`;
}

/**
 * Ordinary least squares, reported with the two numbers that make a slope
 * readable. A slope without `n` and `r2` is not a result -- in the quiet regime
 * this fit returns slopes of either sign at r2 ~ 0, and reporting only the
 * slope would make noise look like a finding.
 *
 * `r2` is `null`, not 0, when it is undefined (no variance in x or in y):
 * 0 means "fitted, explains nothing", null means "not computable". Collapsing
 * them hides a degenerate segment inside a table of real ones.
 */
export function fitOls(points) {
  const usable = points.filter(
    (p) => Number.isFinite(p.x) && Number.isFinite(p.y),
  );
  const n = usable.length;
  if (n < MIN_FIT_POINTS) return { n, slope: null, intercept: null, r2: null };

  let sx = 0;
  let sy = 0;
  for (const p of usable) {
    sx += p.x;
    sy += p.y;
  }
  const mx = sx / n;
  const my = sy / n;

  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const p of usable) {
    const dx = p.x - mx;
    const dy = p.y - my;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }

  // x never varies: the segment did no teardown work, so it cannot speak to a
  // teardown slope at all. Refuse rather than divide.
  if (sxx === 0) return { n, slope: null, intercept: null, r2: null };

  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  // y never varies: the fit is exact and flat. Degenerate, not explanatory.
  const r2 = syy === 0 ? null : (sxy * sxy) / (sxx * syy);
  return { n, slope, intercept, r2 };
}

/**
 * Split a `container_start_time_seconds` series into restart-delimited segments
 * (trap 2).
 *
 * A change in VALUE is a restart. The bucket in which the value changes is
 * dropped from the segment it BEGINS, not from the one it ends (`t > fromT`,
 * `t <= toT`): that bucket straddles the reset, so its `increase()` counts
 * post-restart work against pre-restart residual. The old segment's last
 * bucket is wholly pre-restart and is kept.
 */
export function segmentsFromRestarts(samples) {
  const ordered = [...samples]
    .filter((s) => Number.isFinite(s.t) && Number.isFinite(s.value))
    .sort((a, b) => a.t - b.t);

  const segments = [];
  let current = null;
  for (const sample of ordered) {
    if (current === null || sample.value !== current.startEpoch) {
      if (current !== null) segments.push(current);
      current = { startEpoch: sample.value, fromT: sample.t, toT: sample.t };
      continue;
    }
    current.toT = sample.t;
  }
  if (current !== null) segments.push(current);
  // A single-sample segment has no interior and cannot be fitted.
  return segments.filter((s) => s.toT > s.fromT);
}

/** Median of an ASCENDING-sorted numeric array. Even length averages the pair. */
export function median(sorted) {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Running total, in order. Used to accumulate teardown work WITHIN a segment. */
export function cumulativeSum(values) {
  const out = [];
  let total = 0;
  for (const v of values) {
    total += Number.isFinite(v) ? v : 0;
    out.push(total);
  }
  return out;
}

/** Index a sample list by timestamp for aligning two series bucket-by-bucket. */
function byTimestamp(samples) {
  const map = new Map();
  for (const s of samples) map.set(s.t, s.value);
  return map;
}

/**
 * Build one fit per restart-delimited segment.
 *
 * `residual` is in bytes and reported in GiB; `teardown` is per-bucket seconds
 * and accumulated, so the slope is GiB per teardown-second. The table also
 * reports it per 1000 teardown-s, which is the scale the measured numbers live
 * at.
 */
export function buildSegmentFits({ residual, teardown, restarts }) {
  const residualAt = byTimestamp(residual);
  const teardownAt = byTimestamp(teardown);
  const segments = segmentsFromRestarts(restarts);

  return segments.map((segment) => {
    // Strictly interior: the boundary buckets straddle the reset.
    const timestamps = [...residualAt.keys()]
      .filter((t) => t > segment.fromT && t <= segment.toT)
      .sort((a, b) => a - b);

    // `?? 0` cannot tell "no teardown work in this bucket" from "no teardown
    // sample for this bucket". Count the latter so an absent independent
    // variable is visible in the table instead of reading as zero work.
    const covered = timestamps.filter((t) => teardownAt.has(t)).length;
    const work = cumulativeSum(timestamps.map((t) => teardownAt.get(t) ?? 0));
    const points = timestamps.map((t, i) => ({
      x: work[i],
      y: (residualAt.get(t) ?? Number.NaN) / GIB,
    }));

    const fit = fitOls(points);
    const ys = points.map((p) => p.y).filter(Number.isFinite);
    return {
      startEpoch: segment.startEpoch,
      fromT: segment.fromT,
      toT: segment.toT,
      uptimeHours: (segment.toT - segment.fromT) / 3600,
      teardownSeconds: work.length > 0 ? work[work.length - 1] : 0,
      teardownCovered: covered,
      teardownBuckets: timestamps.length,
      residualStartGib: ys.length > 0 ? ys[0] : null,
      residualEndGib: ys.length > 0 ? ys[ys.length - 1] : null,
      ...fit,
    };
  });
}

/**
 * Say whether this window can establish a slope at all.
 *
 * The quiet-regime measurement is the reason this exists: 4 negative and 3
 * positive slopes at max r2 = 0.473 is not a weak result, it is an absence of
 * one, and the difference matters because criterion (b) compares a slope
 * against a baseline. A window whose segments disagree on SIGN cannot supply
 * either side of that comparison.
 */
export function summarizeDiscrimination(fits, { minR2 = 0.5 } = {}) {
  const fitted = fits.filter((f) => f.slope !== null && f.r2 !== null);
  if (fitted.length === 0) {
    return { discriminating: false, reason: "no-fittable-segment", fitted: 0 };
  }
  const positive = fitted.filter((f) => f.slope > 0).length;
  const negative = fitted.filter((f) => f.slope < 0).length;
  if (positive > 0 && negative > 0) {
    return {
      discriminating: false,
      reason: "sign-unstable",
      fitted: fitted.length,
      positive,
      negative,
    };
  }
  // The gate is max(r2): ONE well-explained segment can carry the verdict even
  // when its same-sign siblings are r2~0. That is deliberate -- a single clean
  // segment is evidence -- but it must not read as "every segment agrees", so
  // the spread is reported alongside the figure that actually gates.
  const r2s = fitted.map((f) => f.r2).sort((a, b) => a - b);
  const best = r2s[r2s.length - 1];
  const spread = { maxR2: best, minR2: r2s[0], medianR2: median(r2s) };
  if (best < minR2) {
    return {
      discriminating: false,
      reason: "low-explanatory-power",
      fitted: fitted.length,
      ...spread,
    };
  }
  return { discriminating: true, fitted: fitted.length, ...spread };
}

const iso = (t) => new Date(t * 1000).toISOString().replace(".000", "");
const num = (v, digits) => (v === null || v === undefined ? "-" : v.toFixed(digits));

export function formatFitTable(fits) {
  const header = [
    "segment start (restart)",
    "n",
    "uptime h",
    "teardown s",
    "cov",
    "residual GiB start->end",
    "slope GiB/1000s",
    "r2",
  ].join(" | ");
  const rows = fits.map((f) =>
    [
      iso(f.fromT),
      String(f.n),
      num(f.uptimeHours, 1),
      num(f.teardownSeconds, 0),
      `${f.teardownCovered}/${f.teardownBuckets}`,
      `${num(f.residualStartGib, 4)}->${num(f.residualEndGib, 4)}`,
      f.slope === null ? "-" : (f.slope * 1000).toFixed(6),
      num(f.r2, 3),
    ].join(" | "),
  );
  return [header, ...rows].join("\n");
}

/**
 * Refuse to report a verdict when an input series is absent.
 *
 * ⛔ The distinction this enforces is the whole point of the script: a window
 * that CANNOT be measured must not be reported as a window that measured
 * nothing. Both inputs fail silently in the same direction if unguarded:
 *
 * - `residual`/`restarts` empty -> no segments at all.
 * - `teardown` empty -> `teardownAt.get(t) ?? 0` makes every bucket zero work,
 *   so every segment is degenerate (`sxx === 0`), `summarizeDiscrimination`
 *   returns `no-fittable-segment`, and the script exits 0 announcing "NOT
 *   discriminating". The absent independent variable reads as "the quiet
 *   regime does not discriminate", which is a confident wrong answer.
 *
 * `teardown` is introduced by #2175, so a window predating it, a renamed
 * metric, or an unscraped `_sum` all land here.
 */
export function assertMeasurable({ residual, teardown, restarts, start, end }) {
  const window = `${iso(start)}..${iso(end)}`;
  if (residual.length === 0 || restarts.length === 0) {
    // Retention is ~7 days. An empty window is almost always the window having
    // aged out, which is NOT the same as the excursion being absent.
    throw new Error(
      `no samples in ${window} -- past retention, or wrong pod/container`,
    );
  }
  if (teardown.length === 0) {
    throw new Error(
      `no teardown samples in ${window} -- the independent variable is absent ` +
        "(window predates #2175, metric renamed, or `_sum` not scraped). " +
        "This is a measurement failure, not a non-result.",
    );
  }
}

/** Split a window so no single range query exceeds the server's timeout. */
export function sliceWindow(startSeconds, endSeconds, maxSliceSeconds = MAX_SLICE_SECONDS) {
  const slices = [];
  for (let from = startSeconds; from < endSeconds; from += maxSliceSeconds) {
    slices.push({ from, to: Math.min(from + maxSliceSeconds, endSeconds) });
  }
  return slices;
}

/** Flatten a Prometheus `matrix` response into `{t, value}`, newest last. */
export function parseMatrix(body) {
  const result = body?.data?.result ?? [];
  const out = [];
  for (const series of result) {
    for (const [t, v] of series.values ?? []) {
      const value = Number.parseFloat(v);
      if (Number.isFinite(value)) out.push({ t: Number(t), value });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

async function queryRange(baseUrl, query, from, to, step, fetchImpl) {
  const samples = [];
  for (const slice of sliceWindow(from, to)) {
    const url = new URL("/api/v1/query_range", baseUrl);
    url.searchParams.set("query", query);
    url.searchParams.set("start", String(slice.from));
    url.searchParams.set("end", String(slice.to));
    url.searchParams.set("step", String(step));
    const response = await fetchImpl(url, { headers: { accept: "application/json" } });
    if (!response.ok) {
      throw new Error(`prometheus ${response.status} for ${query}`);
    }
    samples.push(...parseMatrix(await response.json()));
  }
  // Slices share a boundary instant; de-duplicate so it is not double-counted.
  const seen = new Map();
  for (const s of samples) seen.set(s.t, s.value);
  return [...seen.entries()].map(([t, value]) => ({ t, value })).sort((a, b) => a.t - b.t);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      args[key] = "true";
      continue;
    }
    args[key] = next;
    i += 1;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl =
    args["prometheus-url"] ??
    process.env.PROMETHEUS_URL ??
    "http://prometheus.monitoring.svc.cluster.local:9090";
  const pod = args.pod ?? DEFAULT_POD;
  const container = args.container ?? DEFAULT_CONTAINER;
  const step = Number.parseInt(args.step ?? String(DEFAULT_STEP_SECONDS), 10);
  const end = args.end ? Math.floor(Date.parse(args.end) / 1000) : Math.floor(Date.now() / 1000);
  const start = args.start
    ? Math.floor(Date.parse(args.start) / 1000)
    : end - 7 * 24 * 3600;

  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
    throw new Error("--start must parse and precede --end");
  }

  const [residual, teardown, restarts] = await Promise.all([
    queryRange(baseUrl, residualQuery(pod, container), start, end, step, fetch),
    queryRange(baseUrl, teardownQuery(step), start, end, step, fetch),
    queryRange(baseUrl, restartQuery(pod, container), start, end, step, fetch),
  ]);

  assertMeasurable({ residual, teardown, restarts, start, end });

  const fits = buildSegmentFits({ residual, teardown, restarts });
  const verdict = summarizeDiscrimination(fits);

  console.log(`window     ${iso(start)} .. ${iso(end)}  step ${step}s`);
  console.log(`pod        ${pod}/${container}`);
  console.log(`samples    residual ${residual.length}, teardown ${teardown.length}`);
  console.log("");
  console.log(formatFitTable(fits));
  console.log("");
  if (verdict.discriminating) {
    console.log(`VERDICT discriminating (${verdict.fitted} fitted segments, max r2 ${verdict.maxR2.toFixed(3)})`);
  } else {
    console.log(`VERDICT NOT discriminating: ${verdict.reason} (${JSON.stringify(verdict)})`);
    console.log(
      "This window cannot establish a teardown slope. Per PEN-3692 ruling §3 that is",
    );
    console.log(
      "a result, not a failure -- do not average these segments into one number.",
    );
  }
}

// `file://${process.argv[1]}` misses when the path holds URL-encoded characters
// (spaces, `%`) or is reached through a symlink -- and the failure is silent:
// the script would do nothing and exit 0.
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
