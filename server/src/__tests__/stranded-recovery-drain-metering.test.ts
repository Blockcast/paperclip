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

describe("stranded-recovery hand-back drain is metered per tick (BLO-19123)", () => {
  const callSite = serverSource.slice(
    serverSource.indexOf("config.strandedRecoveryHandBackDrainEnabled"),
    serverSource.indexOf("stranded-recovery hand-back pass failed"),
  );

  it("has a locatable call site", () => {
    // Guards the two slice anchors above: if either string is renamed, every assertion in this
    // file would silently pass against an empty string. `indexOf` returning -1 is the specific
    // failure mode — `slice(-1, n)` yields "" and every `toContain` below would then be
    // asserting nothing.
    expect(serverSource.indexOf("config.strandedRecoveryHandBackDrainEnabled")).toBeGreaterThan(-1);
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
