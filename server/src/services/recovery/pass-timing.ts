/**
 * Per-pass phase accounting for the stranded-issue recovery sweep (PEN-3636).
 *
 * WHY THIS EXISTS, AND WHY NO EXISTING SIGNAL SUBSTITUTES FOR IT
 *
 * Two measurement runs feed this comment. They are tagged separately because
 * their figures are NOT interchangeable, and a reader re-checking one should
 * know which query to re-run:
 *
 *   (A) 88 consecutive production passes, Loki only (`{pod="paperclip-0"}`,
 *       2026-09-28..30). Source of: pass 1 ran 5.5-86.3 min, while
 *       `candidatesScanned` moved only +/-9% (2095..2284) and `suppressed`
 *       only +/-12% (941..1050).
 *   (B) 84 pass-1 windows, Loki joined to Prometheus at 30 s step
 *       (2026-09-30). A SECOND EXTRACTION PIPELINE reaching the same dispersion
 *       -- 146.9..2305.6 ms per candidate, a 15.7x spread -- and the SOLE source
 *       of every correlation below. n = 84 throughout.
 *
 *       That agreement corroborates the INSTRUMENT, not the sample. By 1. below
 *       this is the same variable as (A)'s 5.5..86.3 min, over windows that
 *       overlap, and the two ratios agree to three significant figures (15.69x
 *       against 15.70x) because one quantity was measured twice. What it buys is
 *       real but narrower than independence: the spread is not an artifact of
 *       the first query.
 *
 * From (B). These are against ms-per-candidate rather than the raw pass wall
 * clock; by 1. below the two are the same variable here, so the ranking is
 * identical either way:
 *
 *   r(ms-per-candidate, candidatesScanned)  = -0.029  (workload: nothing)
 *   r(ms-per-candidate, concurrent runs)    = +0.368  (direct gauge)
 *   r(ms-per-candidate, worker pool queue)  = +0.444
 *   r(ms-per-candidate, api-pod pool queue) = +0.388  (a DIFFERENT process)
 *
 * Two things follow, and both are the reason this module is aggregate timing
 * rather than a fix:
 *
 * 1. The cost is NOT a property of the candidate set. A mean "ms per candidate"
 *    computed from a pass total is a mean over a 15.7x-dispersed quantity, so it
 *    is not a coefficient of this code and cannot be compared across dates to
 *    establish a regression. `r(pass duration, ms-per-candidate)` is 1.000 --
 *    with the candidate count near-constant, those are the same variable.
 * 2. No SINGLE externally observable driver explains MOST of the spread (best
 *    R^2 ~ 0.20), and the leading suspect is not externally observable at all.
 *    Read that precisely: the drivers above are real, and the `⚠` corollary
 *    below tells you to go and read one of them. What no external signal
 *    supplies is a DOMINANT explanation -- so external attribution is
 *    exhausted, not useless.
 *
 *    An earlier revision of this comment claimed the advisory-lock hypothesis's
 *    "scales with fleet concurrency" form was DISCARDED, on r = -0.059 against
 *    namespace log-line rate. That was overstated: log-line rate is a weak
 *    proxy for DB contention, and the direct gauge reads +0.368 --
 *    `paperclip_external_lifecycle_running_runs`, which nobody had enumerated.
 *    The form is WEAKENED, not refuted -- though it saturates rather than
 *    scaling (terciles, from (B): 27 runs -> 507 ms, 37 -> 744 ms, 44 -> 736 ms).
 *
 *    Controlling each candidate driver for the others leaves all of them in
 *    +0.27..+0.43 with none dominant. Two independent reasons to read that band
 *    as a finding rather than measurement noise, doing different jobs: the join
 *    and windowing CAN resolve a strong relationship when one exists (positive
 *    control, same 84 windows: `r(pool wait, pool active)` = +0.733), and at
 *    n = 84 the band is significant on its own terms (r = 0.27 -> p = 0.013,
 *    falling below p = 0.001 at r = 0.353 -- r = 0.35 is p = 0.0011, just the
 *    wrong side). A positive control establishes the instrument works; it does
 *    NOT bound a false-positive rate, which is what the p-values are for. Note
 *    the floor is marginal: four drivers were tested, so Bonferroni at
 *    alpha = 0.05 wants p < 0.0125 and r = 0.27 just misses it. The body of the
 *    band clears that comfortably; its bottom edge does not.
 *
 *    Lock wait scoped to one hot issue or company appears in NO external
 *    signal, which is why the two lock acquisitions below are timed SEPARATELY
 *    rather than folded into one "transaction" bucket -- separating them is the
 *    whole point.
 *
 * No log query could have answered this: the sweep emits no phase timing at all,
 * and a query cannot return data the code never emitted.
 *
 * AGGREGATE-ONLY BY CONSTRUCTION
 *
 * BLO-32668 replaced one INFO line per suppressed issue with one line per pass,
 * and that removal stands -- at ~1000 suppressed issues per pass, per-issue
 * logging is what it was removed for. This module therefore accumulates in
 * memory and emits nothing itself; the sweep emits one line from `summary()`.
 * The bounded slowest-candidate list is the one per-issue detail that survives,
 * capped at a handful of rows, because a 15.7x dispersion is the signature of a
 * heavy tail and a mean alone cannot locate one.
 *
 * `performance.now()` rather than `Date.now()`: these are durations, and a
 * wall-clock step (NTP, container migration) would otherwise land as a negative
 * or absurd phase total. Note this measures AWAIT-to-RESOLVE latency, not
 * database execution time -- time queued behind the connection pool, or behind a
 * blocked event loop, is included. That is deliberate: the question is where the
 * pass's wall clock goes, and pool wait is one of the candidate answers.
 *
 * ⚠ The corollary is a real limit on what these numbers can settle on their own.
 * A large `escalate.*` total is equally consistent with lock contention and with
 * pool starvation, and the pool is measurably queued during exactly the passes
 * worth diagnosing: worker pool queue depth rises 1.31 -> 1.89 -> 4.23 from the
 * fastest to the slowest third of passes (terciles, from (B)), and the api pods
 * -- a separate process with its own size-10 pool, which this sweep cannot
 * consume -- queue alongside.
 * So read these totals against `paperclip_db_pool_waiting_queries`, which is an
 * INDEPENDENT instrument, before attributing them to locks. High phase totals
 * with a flat pool queue is contention; high totals tracking a deep pool queue
 * is starvation. BLO-32668 and `packages/db/src/client.ts:96` record that the
 * two also cause each other, so "which one" can be the wrong question.
 */

/** One phase's accumulated cost across every candidate in a pass. */
export type PhaseStat = {
  /** Summed await-to-resolve latency, milliseconds. */
  totalMs: number;
  /** How many times the phase ran. Zero-call phases are omitted from the summary. */
  calls: number;
  /** Worst single observation. A phase whose max approaches its total is one slow call, not a slow phase. */
  maxMs: number;
};

export type PassTimingSummary = {
  /** Wall clock from timer creation to `summary()`, so phase totals can be read as a share of it. */
  elapsedMs: number;
  /**
   * Per-phase totals, ordered most-expensive-first so the dominant term is the
   * first key an operator reads rather than something to be hunted for.
   *
   * These are NESTED SPANS, not a partition: `escalate.*` is recorded inside a
   * `candidate()` span, so phase totals overlap one another and their sum can
   * exceed `elapsedMs`. Read a phase as "how much of the pass was spent inside
   * this call", never as a slice of a pie — the most-expensive-first ordering
   * otherwise invites exactly that misreading.
   */
  phases: Record<string, PhaseStat>;
  /**
   * Distribution of whole-candidate cost. The percentiles are the load-bearing
   * fields: given the measured dispersion, a mean is expected to be
   * unrepresentative, and p50-vs-p99 is what distinguishes "every candidate got
   * slower" from "a few candidates are pathological".
   */
  candidates: {
    count: number;
    totalMs: number;
    meanMs: number;
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
    maxMs: number;
  };
  /** Slowest individual candidates, worst first. Bounded; see the class note above. */
  slowest: Array<{ issueId: string; ms: number }>;
};

export type PassTimer = {
  /**
   * Time one phase. Re-entrant across different phase names; the same name may
   * be timed once per candidate and accumulates.
   *
   * The timing is recorded in a `finally`, so a throwing phase still reports the
   * time it burned. Without that, the per-issue error boundary in the sweep
   * would make exactly the failing-and-slow candidates invisible here.
   *
   * `PromiseLike` rather than `Promise` because several of the timed call sites
   * hand over a Drizzle query builder directly. A builder is a thenable that only
   * issues its statement when awaited, which is exactly what makes it safe to wrap
   * here — but it is not a `Promise`, and requiring one would force every such
   * site to allocate a wrapper just to be measured.
   */
  time<T>(phase: string, fn: () => PromiseLike<T>): Promise<T>;
  /** Time one whole candidate, attributed to its issue id for the slowest list. */
  candidate<T>(issueId: string, fn: () => PromiseLike<T>): Promise<T>;
  summary(): PassTimingSummary;
};

const DEFAULT_SLOWEST_TRACKED = 5;

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  // Nearest-rank on an ascending array. `min` clamps the p100 case, which would
  // otherwise index one past the end.
  const rank = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1);
  return sorted[Math.max(0, rank)] ?? 0;
}

export function createPassTimer(opts?: { slowestTracked?: number; now?: () => number }): PassTimer {
  const slowestTracked = opts?.slowestTracked ?? DEFAULT_SLOWEST_TRACKED;
  // Injectable purely so tests can pin ordering and percentile behaviour on fed
  // values rather than racing a real timer; production never passes it and gets
  // `performance.now` unchanged. Wrapped in an arrow rather than passed by
  // reference because `performance.now` is not bound to `performance`.
  const now = opts?.now ?? (() => performance.now());
  const startedAt = now();
  const phases = new Map<string, PhaseStat>();
  // One entry per candidate. At the measured ~2250 candidates per pass this is a
  // few tens of KB of numbers held for the pass's lifetime, which is why the
  // durations are kept but the issue ids are not: ids are retained only for the
  // bounded slowest list. The worker already carries a heap-growth investigation
  // (PEN-3314), so this deliberately does not accumulate a per-candidate object
  // graph.
  const candidateDurations: number[] = [];
  let slowest: Array<{ issueId: string; ms: number }> = [];

  function record(phase: string, ms: number) {
    const prev = phases.get(phase);
    if (prev) {
      prev.totalMs += ms;
      prev.calls += 1;
      if (ms > prev.maxMs) prev.maxMs = ms;
      return;
    }
    phases.set(phase, { totalMs: ms, calls: 1, maxMs: ms });
  }

  async function time<T>(phase: string, fn: () => PromiseLike<T>): Promise<T> {
    const t0 = now();
    try {
      return await fn();
    } finally {
      record(phase, now() - t0);
    }
  }

  async function candidate<T>(issueId: string, fn: () => PromiseLike<T>): Promise<T> {
    const t0 = now();
    try {
      return await fn();
    } finally {
      const ms = now() - t0;
      candidateDurations.push(ms);
      // Insertion into a list capped at `slowestTracked` -- an O(k) insert per
      // candidate with k of about 5, rather than sorting ~2250 entries. Kept
      // sorted worst-first so the cheapest element to evict is always the last.
      if (slowest.length < slowestTracked || ms > (slowest[slowest.length - 1]?.ms ?? 0)) {
        slowest.push({ issueId, ms });
        slowest.sort((a, b) => b.ms - a.ms);
        if (slowest.length > slowestTracked) slowest = slowest.slice(0, slowestTracked);
      }
    }
  }

  function summary(): PassTimingSummary {
    const sorted = [...candidateDurations].sort((a, b) => a - b);
    const totalMs = candidateDurations.reduce((acc, ms) => acc + ms, 0);
    const orderedPhases: Record<string, PhaseStat> = {};
    for (const [name, stat] of [...phases.entries()].sort((a, b) => b[1].totalMs - a[1].totalMs)) {
      orderedPhases[name] = {
        totalMs: Math.round(stat.totalMs),
        calls: stat.calls,
        maxMs: Math.round(stat.maxMs),
      };
    }
    return {
      elapsedMs: Math.round(now() - startedAt),
      phases: orderedPhases,
      candidates: {
        count: sorted.length,
        totalMs: Math.round(totalMs),
        meanMs: sorted.length === 0 ? 0 : Math.round(totalMs / sorted.length),
        p50Ms: Math.round(percentile(sorted, 0.5)),
        p95Ms: Math.round(percentile(sorted, 0.95)),
        p99Ms: Math.round(percentile(sorted, 0.99)),
        maxMs: Math.round(sorted[sorted.length - 1] ?? 0),
      },
      slowest: slowest.map((entry) => ({ issueId: entry.issueId, ms: Math.round(entry.ms) })),
    };
  }

  return { time, candidate, summary };
}
