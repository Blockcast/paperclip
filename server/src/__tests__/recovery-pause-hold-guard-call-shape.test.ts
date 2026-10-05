import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Static guard on the shape of the stranded sweep's pause-hold call (PEN-3636).
 *
 * Two changes landed on the same statement: #2128 wrapped the guard in
 * `passTimer.time("prologue.pauseHoldGuard", …)` with the 4-arg signature, and
 * this change REPLACES that call with the 6-arg prefiltered form. The merge
 * resolution is replace-then-re-wrap, never "take both" — and git does not mark
 * it, because #2128's version sits as unconflicted context above the `<<<<<<<`.
 *
 * Keeping both calls runs the pause-hold guard twice per candidate, cancelling
 * the entire saving, while `prologue.pauseHoldGuard` goes on reporting a timing
 * that confirms a fix which did not land. Nothing else catches it (all measured):
 *
 *   - `tsc` — error sets are byte-identical across the correct resolution, the
 *     duplicated one, and the unmodified control.
 *   - The feature's own assertion — `pauseHoldPrefilterLiveReads === 1` still
 *     passes, because the duplicate is the un-prefiltered 4-arg form that never
 *     enters the prefilter closure.
 *   - A full suite run — the recovery suite is green with the duplicate present.
 *
 * This head is well behind `master`, so that merge has to be performed again at
 * least once more against a base it has not been tested against. These
 * assertions are what make the merge note at the call site an enforced
 * invariant rather than a warning a future resolver has to happen to read.
 *
 * Deliberately asserted on CALL SITES (`symbol` followed by `(`) rather than on
 * a raw occurrence count of the symbol: the merge note is prose that names the
 * hazard, and a count would turn any edit to that comment into a false red.
 */

const SERVICE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "services",
  "recovery",
  "service.ts",
);

const GUARD = "isAutomaticRecoverySuppressedByPauseHold";

/** Every `symbol(...)` call in `src`, returned whole via balanced-paren scan. */
function callSites(src: string, symbol: string): string[] {
  const sites: string[] = [];
  const re = new RegExp(`\\b${symbol}\\s*\\(`, "g");
  let match: RegExpExecArray | null;
  while ((match = re.exec(src)) !== null) {
    let depth = 1;
    let i = match.index + match[0].length;
    for (; i < src.length && depth > 0; i += 1) {
      if (src[i] === "(") depth += 1;
      else if (src[i] === ")") depth -= 1;
    }
    expect(depth, `unbalanced parentheses in ${symbol} call at offset ${match.index}`).toBe(0);
    sites.push(src.slice(match.index, i));
  }
  return sites;
}

describe("recovery pause-hold guard call shape", () => {
  const source = readFileSync(SERVICE_PATH, "utf8");

  it("reads a source file that actually contains the guard", () => {
    // Positive control: a scan that silently matched nothing would make every
    // assertion below vacuous.
    expect(source.length).toBeGreaterThan(1000);
    expect(source).toContain(GUARD);
  });

  it("calls the pause-hold guard exactly 5 times: 1 prefiltered in-loop + 4 sweeps", () => {
    // A "take both" merge adds a sixth — the un-prefiltered 4-arg duplicate.
    expect(callSites(source, GUARD)).toHaveLength(5);
  });

  it("passes the prefilter at exactly one call site", () => {
    const prefiltered = callSites(source, GUARD).filter((site) =>
      site.includes("activePauseHoldPrefilter"),
    );
    // 0 ⇒ the prefilter argument was dropped and the saving is gone.
    // 2+ ⇒ a second prefiltered call entered the per-candidate path.
    expect(prefiltered).toHaveLength(1);
  });

  it("wraps the prefiltered call in the prologue.pauseHoldGuard phase timer", () => {
    const timed = callSites(source, "passTimer\\.time").filter((site) =>
      site.includes('"prologue.pauseHoldGuard"'),
    );
    // Exactly one phase bears this name, and the prefiltered guard is what it
    // measures. Left on a duplicate or an un-prefiltered call, the phase would
    // report a timing for a fix that did not land.
    expect(timed).toHaveLength(1);
    expect(timed[0]).toContain(GUARD);
    expect(timed[0]).toContain("activePauseHoldPrefilter");
  });
});
