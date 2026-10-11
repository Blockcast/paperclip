import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Static guards on the stranded sweep's attendance preflight (PEN-3636).
 *
 * Two failure modes motivate this file, and BOTH are silent — they produce correct
 * answers and a green suite while removing the entire saving:
 *
 *  1. **Unwired.** If the sweep's two attendance checks revert to the bare
 *     `hasActiveExecutionPath` / `hasPendingWakeInteraction`, every candidate pays three
 *     serialized round-trips again. Nothing fails: the predicates are equivalent, so the
 *     sweep's behaviour is unchanged and only its cost regresses. The feature's own
 *     counters cannot catch it either — an unwired prefetch reports
 *     `attendancePrefetchLiveReads: 0`, which is the SAME reading a prefetch wired into
 *     a degraded database produces (see the stats note in
 *     `stranded-attendance-prefetch.ts`).
 *
 *  2. **Drifted.** If a term is added to one of the single-issue predicates and not to
 *     the batched one, the batch answers "unattended" for real attendance — the harmful
 *     direction, because that is the direction that ends in a mutation rather than a
 *     deferral. `tsc` cannot see it, and no behavioural test would unless it happened to
 *     cover the new term. The structural control is that both compose the same shared
 *     terms; these assertions are what keep that from being quietly inlined away.
 *
 * Deliberately asserted on CALL SITES (`symbol` followed by `(`) rather than on raw
 * occurrence counts: the comments around these call sites name the symbols in prose, and
 * a bare count would turn any edit to that prose into a false red.
 */

const SERVICE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "services",
  "recovery",
  "service.ts",
);

const SERVICE_SRC = readFileSync(SERVICE_PATH, "utf8");

/**
 * Count of call sites matching `pattern` immediately followed by `(`.
 *
 * `pattern` is a regex fragment, not a literal, so a caller can express "this symbol,
 * but not as a property access" — which is the distinction the duplicate-call assertion
 * below turns on.
 */
function callSiteCount(src: string, pattern: string): number {
  return src.match(new RegExp(`${pattern}\\s*\\(`, "g"))?.length ?? 0;
}

/**
 * The body of `reconcileStrandedAssignedIssues`, bounded by two markers that are
 * load-bearing in their own right: the prefetch construction and the funnel log line.
 * Either marker disappearing is itself a signal worth failing on, which is why the
 * assertions below check both were found.
 */
function strandedSweepBody(): string {
  const start = SERVICE_SRC.indexOf("const attendancePrefetch = createStrandedAttendancePrefetch(");
  const end = SERVICE_SRC.indexOf('"stranded assigned issue sweep completed"');
  expect(start, "prefetch construction not found in reconcileStrandedAssignedIssues").toBeGreaterThan(-1);
  expect(end, "sweep funnel log line not found").toBeGreaterThan(start);
  return SERVICE_SRC.slice(start, end);
}

/**
 * The body of one nested function in `service.ts`, from its declaration to the next
 * sibling declaration at the same indent.
 *
 * The three attendance predicates are adjacent `  async function` declarations inside
 * `recoveryService`, so the next `\n  async function ` is a sound terminator: anything
 * nested within the body is indented deeper and cannot match. Asserting the marker was
 * found matters as much as the slice — a renamed predicate would otherwise silently
 * yield an empty region and pass every count below vacuously.
 */
function regionBody(declaration: string): string {
  const start = SERVICE_SRC.indexOf(declaration);
  expect(start, `${declaration} not found in service.ts`).toBeGreaterThan(-1);
  const end = SERVICE_SRC.indexOf("\n  async function ", start + declaration.length);
  expect(end, `no sibling declaration terminates ${declaration}`).toBeGreaterThan(start);
  return SERVICE_SRC.slice(start, end);
}

describe("stranded sweep attendance prefetch wiring", () => {
  it("routes both of the sweep's attendance checks through the prefetch", () => {
    const body = strandedSweepBody();
    expect(callSiteCount(body, "attendancePrefetch\\.hasActiveExecutionPath")).toBe(1);
    expect(callSiteCount(body, "attendancePrefetch\\.hasPendingWakeInteraction")).toBe(1);
  });

  it("leaves no un-prefetched attendance read inside the sweep", () => {
    // The duplicate-call hazard: a merge that keeps both the prefetched call and the
    // bare one type-checks, answers identically, and silently restores the per-candidate
    // round-trips. `attendancePrefetch.has…(` does not match these patterns, because the
    // word boundary falls after the `.`.
    const body = strandedSweepBody();
    expect(callSiteCount(body, "(?<![.\\w])hasActiveExecutionPath\\b")).toBe(0);
    expect(callSiteCount(body, "(?<![.\\w])hasPendingWakeInteraction\\b")).toBe(0);
  });

  it("composes the batched window and the single-issue predicates from the same terms", () => {
    // Each shared symbol must appear on BOTH sides of the equivalence: in the
    // single-issue predicate that owns it, and in `readStrandedAttendanceWindow`.
    // Inlining either side is what lets the two queries drift.
    //
    // ⚠️ Asserted per REGION, at >= 1 each, rather than as one whole-file count at >= 2.
    // A whole-file count is blind on exactly the symbols it most needs to cover: the two
    // JSONB expression helpers have THREE call sites each — one single-issue, two inside
    // the batch (a select and a where) — so the batch's own two satisfy a >= 2 threshold
    // alone, and inlining the single-issue site leaves the guard green. Mutation-tested,
    // not reasoned: under the old assertion that edit left the three `*Terms` helpers at
    // 1 (fired) and both expression helpers at 2 (passed, drift undetected). Raising the
    // threshold to 3 for those two would work today and rot on the next edit to the
    // batch; the region split does not.
    const singleIssueRegions = {
      hasActiveExecutionPath: regionBody("async function hasActiveExecutionPath("),
      hasPendingWakeInteraction: regionBody("async function hasPendingWakeInteraction("),
    };
    const batch = regionBody("async function readStrandedAttendanceWindow(");

    // Which single-issue predicate each shared symbol belongs to. Listing them rather
    // than searching both regions keeps the assertion specific: a term that migrated to
    // the other predicate is itself a change worth failing on.
    const shared: [symbol: string, singleIssueRegion: keyof typeof singleIssueRegions][] = [
      ["executionPathRunTerms", "hasActiveExecutionPath"],
      ["deferredExecutionWakeTerms", "hasActiveExecutionPath"],
      ["heartbeatRunIssueIdExpr", "hasActiveExecutionPath"],
      ["deferredExecutionWakeIssueIdExpr", "hasActiveExecutionPath"],
      ["pendingWakeInteractionTerms", "hasPendingWakeInteraction"],
    ];

    for (const [symbol, region] of shared) {
      const pattern = `\\b${symbol}\\b`;
      expect(
        callSiteCount(singleIssueRegions[region], pattern),
        `${symbol} is no longer called in ${region} — the single-issue side was inlined`,
      ).toBeGreaterThanOrEqual(1);
      expect(
        callSiteCount(batch, pattern),
        `${symbol} is no longer called in readStrandedAttendanceWindow — the batch drifted`,
      ).toBeGreaterThanOrEqual(1);
    }
  });

  it("keeps the batched window free of a LIMIT", () => {
    // A `LIMIT` on a window query truncates it and reports "unattended" for the issues
    // that fell off the end — the harmful direction, and invisible to every other check.
    const start = SERVICE_SRC.indexOf("async function readStrandedAttendanceWindow(");
    expect(start, "readStrandedAttendanceWindow not found").toBeGreaterThan(-1);
    const end = SERVICE_SRC.indexOf("\n  }\n", start);
    expect(end).toBeGreaterThan(start);
    expect(SERVICE_SRC.slice(start, end)).not.toMatch(/\.limit\s*\(/);
  });
});
