import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Static guard on the recovery chain's per-pass timing wiring (PEN-4381).
 *
 * The chain in `index.ts` is eight sequential `.then()` passes, and its own
 * comment already records that it is written as a block rather than an early
 * `return` precisely so that "a pass appended after it still runs". That is the
 * hazard this file exists for: a NINTH pass can be appended, work correctly, and
 * be silently absent from the timing — which is exactly the state this row found
 * the chain in, with passes 2-8 unmeasured while pass 1 and the chain total were
 * both instrumented. The failure is invisible to everything else:
 *
 *   - `tsc` is happy; an untimed `.then(async () => …)` is well-typed.
 *   - The unit tests for `chain-pass-timing.ts` pass; the module is correct, it
 *     is simply not called for the new pass.
 *   - Production looks healthy; the settle line just reports one fewer pass, and
 *     `unaccountedMs` absorbs the difference without anything going red.
 *
 * So the invariant is asserted on the source: every pass in the chain is timed,
 * the indices are 1..N contiguous and unique, and the names on the lines match
 * the methods actually called. A new pass makes this file fail until it is
 * given an index, which is the whole point.
 *
 * Also pinned here: the `recoveryChainId` hand-off into pass 1. Pass 1 emits its
 * own `stranded assigned issue sweep phase timing` line from inside the recovery
 * service, and the chain id is threaded through two wrappers so that line joins
 * the chain by KEY rather than by falling inside pass 1's window. Three files
 * have to agree for that to work, no type error results if any one of them drops
 * it, and the symptom is a join quietly degrading back to timestamp containment.
 */

const here = dirname(fileURLToPath(import.meta.url));
const read = (...parts: string[]) => readFileSync(join(here, "..", ...parts), "utf8");

const indexSrc = read("index.ts");
const heartbeatSrc = read("services", "heartbeat.ts");
const recoverySrc = read("services", "recovery", "service.ts");

/**
 * The chain body: from the `chainTimer` construction to the `.catch` that closes
 * the chain. Scoped so a `.then(` anywhere else in this very large file cannot
 * leak in and turn an unrelated edit red.
 */
function chainBody(): string {
  const start = indexSrc.indexOf("const chainTimer = createRecoveryChainTimer(");
  expect(start, "chain timer construction not found in index.ts").toBeGreaterThan(-1);
  const end = indexSrc.indexOf('"periodic heartbeat recovery failed"', start);
  expect(end, "chain .catch not found after the chain timer").toBeGreaterThan(start);
  return indexSrc.slice(start, end);
}

describe("recovery chain per-pass timing wiring (PEN-4381)", () => {
  it("times every pass in the chain, with contiguous unique indices from 1", () => {
    const body = chainBody();

    // Not anchored on `chainTimer.` — pass 1 is the chain HEAD, so its receiver
    // sits on the `trackHeartbeatSchedulerWork(chainTimer` line with a comment
    // between, and an anchored pattern silently matches only passes 2-8. The
    // slice is already scoped to the chain, so the bare `.time(`/`.pass(` is
    // unambiguous here.
    const timed = [...body.matchAll(/\.(?:time|pass)\(\s*(\d+)\s*,\s*"([A-Za-z]+)"/g)]
      .map((m) => ({ index: Number(m[1]), name: m[2] }));

    expect(timed.length).toBe(8);
    expect(timed.map((t) => t.index)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(timed.map((t) => t.name)).toEqual([
      "reconcileStrandedAssignedIssues",
      "reconcileIssueGraphLiveness",
      "reconcileTaskWatchdogs",
      "scanSilentActiveRuns",
      "reconcileProductivityReviews",
      "reconcileResolvedBlockerDependents",
      "reconcileFailedWakeDispatches",
      "reconcileContendedPrReviewerWakes",
    ]);
  });

  it("leaves no pass in the chain untimed", () => {
    const body = chainBody();
    // Every `.then(` opening a pass must hand off to the timer. The chain's own
    // passes are the only `.then(`s in this slice; a bare `.then(async` is a
    // pass someone appended without an index.
    const thens = [...body.matchAll(/\.then\(\s*(chainTimer\.pass\(|async\b)/g)].map((m) => m[1]);
    const untimed = thens.filter((t) => !t.startsWith("chainTimer.pass("));

    // Pass 1 is the chain HEAD (`chainTimer.time(1, …)`), so its result-reporting
    // `.then(async (reconciled) => …)` is the one legitimate bare `.then` here.
    expect(untimed.length, `untimed .then passes in the recovery chain: ${untimed.length}`).toBe(1);
  });

  it("settles the chain so the per-pass lines reconcile against the total", () => {
    // Must be inside the chain's `finally`, after the in-flight latch is cleared
    // — the latch clear must precede anything that could throw, and the settle
    // line must still be emitted when the metric recorders fail.
    //
    // Scoped to the `finally` body rather than searched over the whole file. An
    // earlier revision anchored the latch clear with
    // `indexSrc.indexOf("heartbeatRecoveryChainStartedAt = 0;")`, which matches
    // the `let heartbeatRecoveryChainStartedAt = 0;` DECLARATION ~1200 lines
    // above — so `settle > latchClear` held no matter where `settle()` sat, and
    // the assertion was vacuous. A mutant that moved `settle()` to before the
    // clear passed all four tests. Keep the slice.
    const finallyStart = indexSrc.indexOf("const elapsedMs = Math.max(0, Date.now() - heartbeatRecoveryChainStartedAt);");
    expect(finallyStart, "chain finally not found").toBeGreaterThan(-1);
    const finallyEnd = indexSrc.indexOf("chain latch already cleared", finallyStart);
    expect(finallyEnd).toBeGreaterThan(finallyStart);
    const body = indexSrc.slice(finallyStart, finallyEnd);

    const latchClear = body.indexOf("heartbeatRecoveryChainStartedAt = 0;");
    const settle = body.indexOf("chainTimer.settle(elapsedMs);");
    const recordDuration = body.indexOf("recordHeartbeatRecoveryChainDuration(elapsedMs);");

    expect(latchClear).toBeGreaterThan(-1);
    expect(settle).toBeGreaterThan(-1);
    expect(recordDuration).toBeGreaterThan(-1);
    expect(settle).toBeGreaterThan(latchClear);
    expect(settle).toBeLessThan(recordDuration);
  });

  it("threads the chain id through to pass 1's own phase-timing line", () => {
    // index.ts hands it to the heartbeat wrapper...
    expect(indexSrc).toContain("recoveryChainId: chainTimer.chainId,");
    // ...the wrapper forwards it to the recovery service...
    expect(heartbeatSrc).toMatch(
      /async function reconcileStrandedAssignedIssues\(opts\?: \{ recoveryChainId\?: string \}\)/,
    );
    expect(heartbeatSrc).toContain("recoveryChainId: opts?.recoveryChainId,");
    // ...and the service puts it on the line that the join actually needs.
    const logStart = recoverySrc.indexOf("recoveryChainId: opts?.recoveryChainId,");
    const message = recoverySrc.indexOf('"stranded assigned issue sweep phase timing"');
    expect(logStart).toBeGreaterThan(-1);
    expect(message).toBeGreaterThan(logStart);
  });
});
