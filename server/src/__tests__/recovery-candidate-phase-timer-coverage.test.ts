import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Static guard on which per-candidate round-trips the stranded sweep times (PEN-3636).
 *
 * #2128 instrumented the sweep's PROLOGUE only. The 2026-10-09 post-deploy reading of 8
 * production passes showed that is not enough: the named phases summed to 36-65% of
 * `elapsedMs`, and the share FELL as the pass slowed (64.6% on a 265 s pass, 35.8% on a
 * 1,266 s one). Nearly all pass time sits inside candidate spans, so the unattributed
 * remainder is real per-candidate work - ~350 ms/candidate on the slow passes, larger
 * than every named phase combined - and no instrument could see it.
 *
 * This file pins the round-trips added to close that gap. It is a SOURCE-SHAPE test on
 * purpose, for the reason its sibling `recovery-pause-hold-guard-call-shape.test.ts`
 * records: on this file `tsc` is close to blind (its error sets were measured
 * byte-identical across a correct resolution, a duplicated one, and an unmodified
 * control), and a timer that is silently dropped in a future merge does not fail any
 * behavioural assertion - it just stops emitting a phase, which reads exactly like
 * "that branch did not run this pass". The failure mode is a phase quietly going
 * missing, so the assertion has to be on the wrapping itself.
 *
 * `getLatestUnblockedAt` is wrapped at its DEFINITION rather than at its call sites:
 * `latestRunPredatesLatestUnblock` reaches it from 13 branches, so a per-call-site wrap
 * is both a larger diff and one a future branch can silently miss.
 */

const SERVICE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "services",
  "recovery",
  "service.ts",
);

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

/**
 * The phase name each newly-timed round-trip must report under, and the symbol that
 * must appear inside that wrapper. Asserting the inner symbol is the part that matters:
 * a wrapper kept but re-pointed at a different call reports a plausible number for the
 * wrong thing, which is strictly worse than the phase being absent.
 */
const TIMED_ROUND_TRIPS: ReadonlyArray<{ phase: string; inner: string; sites: number }> = [
  { phase: "candidate.getLatestUnblockedAt", inner: "activityLog", sites: 1 },
  { phase: "candidate.invocationBudgetBlock", inner: "budgets.getInvocationBlock", sites: 1 },
  {
    phase: "candidate.resolveCheckoutAdoptionHandover",
    inner: "resolveCheckoutAdoptionHandover",
    sites: 1,
  },
  { phase: "candidate.getDependencyReadiness", inner: "issuesSvc.getDependencyReadiness", sites: 1 },
  { phase: "candidate.listDependencyReadiness", inner: "listDependencyReadiness", sites: 2 },
];

describe("recovery candidate phase timer coverage", () => {
  const source = readFileSync(SERVICE_PATH, "utf8");

  it("reads a source file that actually contains the sweep", () => {
    // Positive control: a scan that silently matched nothing would make every
    // assertion below vacuous, which is the failure this whole file exists to catch.
    expect(source.length).toBeGreaterThan(1000);
    expect(source).toContain("reconcileStrandedCandidate");
    expect(source).toContain("function timePassPhase");
  });

  it("routes the helper through the in-flight pass and is a pass-through without one", () => {
    // The helper must stay null-tolerant: these round-trips are also reachable from
    // request paths, which have no pass to attribute to. A helper that assumed a pass
    // would turn every non-sweep caller into a crash.
    expect(source).toContain("function timePassPhase<T>(phase: string, fn: () => Promise<T>)");
    expect(source).toContain("return activePassTimer ? activePassTimer.time(phase, fn) : fn();");
  });

  for (const { phase, inner, sites } of TIMED_ROUND_TRIPS) {
    it(`times ${phase} around ${inner}`, () => {
      const wrappers = callSites(source, "timePassPhase").filter((site) =>
        site.includes(`"${phase}"`),
      );
      expect(wrappers, `expected ${sites} wrapper(s) naming ${phase}`).toHaveLength(sites);
      for (const wrapper of wrappers) {
        expect(wrapper, `${phase} wrapper must enclose ${inner}`).toContain(inner);
      }
    });
  }

  it("leaves no newly-timed phase unaccounted for", () => {
    // Counts the wrappers rather than trusting the per-phase assertions above to be
    // exhaustive: a wrapper added later under a name nobody pinned would otherwise be
    // invisible here, and the phase budget this file documents would quietly drift.
    //
    // The declaration itself is NOT in this count and must not be added to it: the scan
    // matches `name(`, and the generic parameter in `timePassPhase<T>(` means the
    // declaration never matches. Asserted above by its own literal instead.
    const expected = TIMED_ROUND_TRIPS.reduce((acc, entry) => acc + entry.sites, 0);
    expect(callSites(source, "timePassPhase")).toHaveLength(expected);
  });
});
