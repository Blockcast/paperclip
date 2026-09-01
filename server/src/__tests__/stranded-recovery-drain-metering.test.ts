import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { NUMERIC_SETTING_BOUNDS } from "../config.js";

/**
 * BLO-19123. The hand-back drain's *rate* is a separate invariant from its behaviour, and it
 * lives at a seam no behavioural test reaches: `reconcileStrandedRecoveryHandBacks` honours
 * `opts.limit` correctly (asserted in `issue-recovery-actions.test.ts`), and the config value
 * is bounded correctly (asserted in `numeric-env-bounds.test.ts`), but the call site in
 * `index.ts` sat between them passing no argument at all — so both guards read green while the
 * scheduler ran with the service-side default of 500.
 *
 * That is the exact defect this file exists to prevent recurring. 500 is a bound on candidates
 * a pass *works*, not a rate: it let the first tick after the drain flag flipped return the
 * entire mis-owned backlog in one sweep (~89 rows on a single agent, ~360 estate-wide when
 * this was written) onto a destination queue that had no say in the timing.
 *
 * Source-text assertion rather than a behavioural one, deliberately: `index.ts` is the process
 * entrypoint and its scheduler tick has no seam a unit test can drive without standing up the
 * whole server. The precedent is `startup-filesystem-io.test.ts`, which guards startup ordering
 * the same way. This is weaker than a type — it cannot prove the value flows — but it is the
 * only thing that can fail when someone drops the argument, which is what actually happened.
 */
const repoRoot = join(import.meta.dirname, "../../..");
const serverSource = readFileSync(join(repoRoot, "server/src/index.ts"), "utf8");

const START_ANCHOR = "config.strandedRecoveryHandBackDrainEnabled";
const END_ANCHOR = "stranded-recovery hand-back pass failed";

describe("stranded-recovery hand-back drain is metered per tick (BLO-19123)", () => {
  const startIndex = serverSource.indexOf(START_ANCHOR);
  const endIndex = serverSource.indexOf(END_ANCHOR);

  // The two anchors fail in *opposite* directions, which is why neither may be left unchecked
  // and why the slice is conditional rather than direct:
  //
  //   - START missing => `slice(-1, endIndex)` yields "", and every positive `toContain` below
  //     asserts nothing.
  //   - END missing   => `slice(startIndex, -1)` yields nearly the whole remaining file. That
  //     is the dangerous one: the assertions keep passing, against a scope that now spans
  //     unrelated scheduler blocks, so this file would still read green while having lost the
  //     bounded call site it exists to pin.
  //
  // Collapsing to "" on either failure makes both modes loud, and the ordering check (END must
  // follow START) also catches the anchors being reordered into a backwards slice.
  const callSite =
    startIndex > -1 && endIndex > startIndex ? serverSource.slice(startIndex, endIndex) : "";

  it("has a locatable call site", () => {
    expect(startIndex).toBeGreaterThan(-1);
    expect(endIndex).toBeGreaterThan(startIndex);
    expect(callSite).toContain("reconcileStrandedRecoveryHandBacks");
  });

  it("passes an explicit per-pass limit rather than falling through to the service default", () => {
    expect(callSite).toMatch(
      /reconcileStrandedRecoveryHandBacks\(\s*\{[^}]*limit:\s*config\.strandedRecoveryHandBackMaxPerPass/,
    );
    // The argumentless form is the regression itself, not merely a different spelling.
    expect(callSite).not.toMatch(/reconcileStrandedRecoveryHandBacks\(\s*\)/);
  });

  it("meters at a rate an operator can observe a tick at a time", () => {
    const { fallback, min, max } = NUMERIC_SETTING_BOUNDS.strandedRecoveryHandBackMaxPerPass;

    // The point of the meter is reversibility: a bad call costs one tick of rows, not the
    // whole backlog. A default anywhere near the population it drains would defeat that while
    // still technically being "bounded".
    expect(fallback).toBeLessThanOrEqual(25);
    expect(min).toBeGreaterThanOrEqual(1);

    // A ceiling above the service-side candidate default would let an operator override
    // restore a wider sweep than the unmetered code ever performed.
    expect(max).toBeLessThanOrEqual(500);
  });

  it("gates the pass on elapsed time, because a per-tick count is not a rate", () => {
    // The regression this catches is subtle and was nearly shipped: bounding the pass at 10
    // rows looks like metering, but this block runs on the heartbeat tick (30s default), so
    // the count alone drains ~90 rows in under five minutes. Without the elapsed-time gate the
    // meter is nominal — it satisfies "bounded per pass" while delivering a bulk return.
    expect(callSite).toContain("lastStrandedRecoveryHandBackAt");
    expect(callSite).toMatch(/config\.strandedRecoveryHandBackIntervalMinutes\s*\*\s*60_000/);
  });

  it("stamps the interval before the pass starts, not after it finishes", () => {
    // Stamping on completion would let the next tick (30s away) start a second pass while the
    // first is still running, collapsing the interval back to the tick period under exactly
    // the slow-pass conditions where the meter matters most.
    const gateIndex = callSite.indexOf("lastStrandedRecoveryHandBackAt = Date.now()");
    const callIndex = callSite.indexOf("reconcileStrandedRecoveryHandBacks(");

    expect(gateIndex).toBeGreaterThan(-1);
    expect(gateIndex).toBeLessThan(callIndex);
  });

  it("cannot be configured down to the per-tick behaviour it replaces", () => {
    const { fallback, min } = NUMERIC_SETTING_BOUNDS.strandedRecoveryHandBackIntervalMinutes;

    // A floor of 0 would let an operator restore the unmetered cadence through a setting whose
    // name suggests it only slows things down.
    expect(min).toBeGreaterThanOrEqual(1);
    // Default must be far enough above the ~30s scheduler tick that the gate actually binds.
    expect(fallback).toBeGreaterThanOrEqual(15);
  });
});
