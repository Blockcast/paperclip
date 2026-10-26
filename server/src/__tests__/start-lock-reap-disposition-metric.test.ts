import { beforeEach, describe, expect, it } from "vitest";
import {
  AGENT_START_LOCK_PHASE_SECONDS_METRIC,
  AGENT_START_LOCK_REAP_DISPOSITION_METRIC,
  KNOWN_ORPHAN_REAP_STAGES,
  KNOWN_START_LOCK_REAP_DISPOSITIONS,
  ORPHAN_REAP_STAGE_SECONDS_METRIC,
  __resetMetricsForTest,
  recordOrphanReapStage,
  recordStartLockReapDisposition,
  renderMetrics,
} from "../services/metrics.js";

/**
 * BLO-42010: the start-lock orphan-reap bail rate must be countable.
 *
 * BLO-41036 bounded the wait so a caller gives up at 120s and dispatches on
 * stale orphan state, and instrumented that bail LOG-ONLY. Measured over 6h of
 * production on 2026-10-10, that leaves the rate uncomputable rather than
 * merely awkward to read: the per-disposition `logger.debug` line emitted 0
 * lines (below the deployed level), and the surviving warn line is gated on
 * `reapMs >= LOCK_HELD_WARN_MS`, which `timed_out` clears by construction and
 * `ran`/`joined` clear only when slow. So logs carry a complete `timed_out`
 * numerator against no denominator, and the logged mix (1499/247/74) is biased
 * by the gate itself. This counter supplies the denominator.
 */
/**
 * One counter series out of the Prometheus exposition.
 *
 * Returns `null` for an ABSENT series and a number for a present one, and that
 * distinction is the point rather than tidiness. Collapsing both to `0` -- the
 * obvious way to write this -- makes "never incremented" and "pre-seeded to
 * zero" indistinguishable *inside the test*, so the not-pre-seeded assertion
 * below passes against a build that pre-seeds. Caught by mutation-testing that
 * guard: seeding every series at registration left the suite green until this
 * helper learned the difference. Same misreading the metric's own help text
 * warns operators about, reproduced one level down in its own test.
 */
async function readDispositionCount(disposition: string): Promise<number | null> {
  const { body } = await renderMetrics();
  const line = body
    .split("\n")
    .find(
      (candidate) =>
        candidate.startsWith(`${AGENT_START_LOCK_REAP_DISPOSITION_METRIC}{`) &&
        candidate.includes(`disposition="${disposition}"`),
    );
  if (!line) return null;
  return Number(line.trim().split(/\s+/).pop());
}

describe("recordStartLockReapDisposition", () => {
  beforeEach(() => {
    __resetMetricsForTest();
  });

  it("counts every disposition of the reap's return union under its own label", async () => {
    // `nested` is the load-bearing one and must not be folded into `ran`: it is
    // the only disposition that WAITS on a sweep without
    // `awaitStartLockSweepBounded`, so while the bound is enabled it is the only
    // one whose `phase="reap"` hold can exceed it. (`skipped_fresh` also skips
    // the bound but returns synchronously; `AGENT_START_LOCK_REAP_WAIT_BOUND_MS=0`
    // removes the guarantee for every disposition.)
    // Measured 2026-10-10 over 24h, exactly 2 agents exceeded 121s in that
    // phase while 8 more sat pinned at 119.8-119.97s -- the bimodality that
    // separates an unbounded leader from a bailing waiter. Collapsing the label
    // destroys the only metric-side signal for it.
    for (const disposition of KNOWN_START_LOCK_REAP_DISPOSITIONS) {
      expect(recordStartLockReapDisposition(disposition)).toEqual({ disposition });
    }
    for (const disposition of KNOWN_START_LOCK_REAP_DISPOSITIONS) {
      expect(await readDispositionCount(disposition)).toBe(1);
    }
    expect(KNOWN_START_LOCK_REAP_DISPOSITIONS).toContain("nested");
    expect(KNOWN_START_LOCK_REAP_DISPOSITIONS).toContain("timed_out");
  });

  it("reports the throw path as 'error' rather than dropping it", async () => {
    // The call site increments from the `finally` that already times the reap,
    // so when `reapOrphanedRunsForStartLock` throws, `reapDisposition` is still
    // `undefined`. Without this coercion that pass is the one failure mode the
    // counter cannot see -- the same invisible-failure shape the counter exists
    // to remove, reintroduced at its own call site.
    expect(recordStartLockReapDisposition(undefined)).toEqual({ disposition: "error" });
    expect(recordStartLockReapDisposition(null)).toEqual({ disposition: "error" });
    expect(await readDispositionCount("error")).toBe(2);
  });

  it("coerces an unrecognised disposition to 'error' so cardinality stays bounded", async () => {
    // Deliberately `error`, not a benign `other`: every legitimate value is a
    // compile-time literal of the reap's return union, so anything else getting
    // here is a defect and must not have a healthy-looking bucket to hide in.
    expect(recordStartLockReapDisposition("not_a_real_disposition")).toEqual({
      disposition: "error",
    });
    expect(await readDispositionCount("error")).toBe(1);
    expect(await readDispositionCount("not_a_real_disposition")).toBeNull();
  });

  it("is not pre-seeded, so an absent series means never incremented", async () => {
    // Asserted because the help text claims it and because a zero that is
    // really a missing scrape is the standing misreading on this fleet: a
    // pre-seeded 0 would make "no bails" and "no collection" identical.
    // `toBeNull` is load-bearing -- `toBe(0)` passes against a pre-seeding
    // build, which is how this guard was found to be inert.
    expect(await readDispositionCount("timed_out")).toBeNull();
    recordStartLockReapDisposition("timed_out");
    expect(await readDispositionCount("timed_out")).toBe(1);
  });

  it("renders a /metrics exposition whose HELP text cannot be mistaken for a sample", async () => {
    // Exposition-level, not metric-local: a HELP line is rendered whether or
    // not the metric has series, so help text added to ONE metric can break an
    // assertion about ANOTHER. This counter's help once read
    // `<phase metric>{phase="reap"}`, which failed the
    // `not.toContain(\`${AGENT_START_LOCK_PHASE_SECONDS_METRIC}{\`)` check in
    // agent-start-lock-liveness.test.ts with zero phase series present, and no
    // metric-local assertion could see it. Parse the same body the /metrics
    // route serves (renderMetrics).
    //
    // ponytail: scoped to this metric's HELP line. The registry-wide form of
    // the second check currently flags 3 pre-existing HELP lines owned by other
    // metrics (github_review_request_*, isolation_workspace_reaper_deleted);
    // widen it once those are rewritten.
    const { body } = await renderMetrics();
    const lines = body.split("\n");
    const names = lines.flatMap((line) => /^# TYPE (\S+) /.exec(line)?.[1] ?? []);
    // Positive controls, so an empty result is not the parser seeing nothing.
    expect(names).toContain(AGENT_START_LOCK_REAP_DISPOSITION_METRIC);
    expect(names).toContain(AGENT_START_LOCK_PHASE_SECONDS_METRIC);
    const help = lines.filter((line) =>
      line.startsWith(`# HELP ${AGENT_START_LOCK_REAP_DISPOSITION_METRIC} `),
    );
    expect(help).toHaveLength(1);
    expect(help[0]).toContain(AGENT_START_LOCK_PHASE_SECONDS_METRIC);
    // An operator who set the kill switch must not be told a long reap hold can
    // only be `nested`: with the bound off, `ran`/`joined` are unbounded too.
    expect(help[0]).toContain("AGENT_START_LOCK_REAP_WAIT_BOUND_MS=0 disables the bound");

    // No phase series exists in this test, so the selector must appear nowhere.
    expect(body).not.toContain(`${AGENT_START_LOCK_PHASE_SECONDS_METRIC}{`);
    expect(names.filter((name) => help[0].includes(`${name}{`))).toEqual([]);
  });
});

describe("recordOrphanReapStage", () => {
  beforeEach(() => {
    __resetMetricsForTest();
  });

  async function stageCount(stage: string): Promise<number | null> {
    const { body } = await renderMetrics();
    const line = body
      .split("\n")
      .find((c) => c.startsWith(`${ORPHAN_REAP_STAGE_SECONDS_METRIC}_count{`) && c.includes(`stage="${stage}"`));
    return line ? Number(line.trim().split(/\s+/).pop()) : null;
  }

  it("observes every allow-listed stage under its own label", async () => {
    for (const stage of KNOWN_ORPHAN_REAP_STAGES) recordOrphanReapStage(stage, 1.5);
    for (const stage of KNOWN_ORPHAN_REAP_STAGES) expect(await stageCount(stage)).toBe(1);
  });

  it("drops an unknown stage and a non-finite duration instead of minting a series", async () => {
    recordOrphanReapStage("bogus" as never, 1);
    recordOrphanReapStage("total", Number.NaN);
    expect(await stageCount("bogus")).toBeNull();
    expect(await stageCount("total")).toBeNull();
  });

  /**
   * PEN-4380 pass 2. These three decompose `reconcile_release_pending`, which
   * pass 1 left as the deepest label and which turned out to name a function
   * rather than a wait: on 2026-10-21 two excursions of 211.209 s and 132.107 s
   * were measured there while the largest per-call exec time of ANY of the 200
   * statements `pg_stat_statements` tracks, in a 12-minute bracket around each,
   * was 13.19 s and 10.94 s. The pool never had a waiter and event-loop lag
   * peaked at 1.223 s, so the time is in neither SQL, nor a connection wait,
   * nor the event loop -- it is in one of the loop's two awaits, and only this
   * split can say which.
   *
   * Asserted by name rather than left to the loop above because the risk here
   * is deletion, not mis-recording: re-merging them restores exactly the blind
   * spot that cost this investigation two wrong attributions.
   */
  it("keeps the release_pending decomposition separable", async () => {
    for (const stage of ["release_pending_select", "release_pending_job_reads", "release_pending_act"] as const) {
      expect(KNOWN_ORPHAN_REAP_STAGES).toContain(stage);
      recordOrphanReapStage(stage, 0.25);
      expect(await stageCount(stage)).toBe(1);
    }
  });

  /**
   * PEN-4781. Unlike the two splits above, this one is a PARTITION of `per_run`
   * rather than a selection out of it, and `per_run_other` is what makes it
   * one. The named four cover the awaits; the residual covers the glue, the
   * iterations that `continue` before reaching any of them, and anything a
   * later contributor adds without wiring it up.
   *
   * Asserted by name for the same reason the three above are -- the risk is
   * deletion -- but with one addition specific to the residual: it is the
   * bucket most likely to be read as an afterthought and dropped, and dropping
   * it does not break the four. It makes them lie. Four small numbers with no
   * residual read as "nothing is slow" while the time sits somewhere unnamed,
   * which is a false negative where today's single `per_run` label is merely a
   * dead end. The structural half of this guarantee -- that no awaited call in
   * the loop escapes the four -- is enforced in
   * `orphan-reap-per-run-sub-stage-audit.test.ts`.
   */
  it("keeps the per_run partition separable, residual included", async () => {
    for (const stage of [
      "per_run_liveness",
      "per_run_finalize",
      "per_run_dispatch",
      "per_run_cleanup",
      "per_run_other",
    ] as const) {
      expect(KNOWN_ORPHAN_REAP_STAGES).toContain(stage);
      recordOrphanReapStage(stage, 0.25);
      expect(await stageCount(stage)).toBe(1);
    }
  });
});
