import { beforeEach, describe, expect, it } from "vitest";
import {
  AGENT_START_LOCK_REAP_DISPOSITION_METRIC,
  KNOWN_START_LOCK_REAP_DISPOSITIONS,
  __resetMetricsForTest,
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
    // the ONLY path that skips `awaitStartLockSweepBounded`, so it is the only
    // disposition whose `phase="reap"` hold can exceed the bound at all.
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
});
