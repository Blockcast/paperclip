import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * PEN-3582 (carried from Ally's non-blocking review 1 on PR #2003).
 *
 * `resumeQueuedRuns` completes its per-agent pass and then rethrows, by design —
 * the BLO-12990 contract is that the function rejects when a dispatch fails, and
 * swallowing would blind the caller's failure log. That rethrow is safe in the
 * PERIODIC chain: `resumeQueuedRuns` sits in a `.then()` whose only tail is
 * logging, and `reconcileStrandedAssignedIssues` is a separately scheduled
 * `trackHeartbeatSchedulerWork` call, so a rejection cannot reach it.
 *
 * The STARTUP sequence is the opposite shape. It is a single serial async IIFE
 * with one terminal `.catch()`, so an unwrapped rejection anywhere in it skips
 * every later pass. `promoteDueScheduledRetries` / `resumeQueuedRuns` /
 * `reconcileStrandedAssignedIssues` ran unwrapped there while BOTH of their
 * immediate predecessors — `sweepStaleIssueLocks` and
 * `reconcileDetachedQueuedRuns` — carried their own `try`/`catch`, the first
 * with the explicit rationale "Lock cleanup must not be starved by failures in
 * the broader recovery sequence."
 *
 * That asymmetry is the defect: a dispatch failure for one agent suppressed
 * stranded-issue repair for the whole estate, at exactly the moment a
 * just-restarted control plane is most likely to be holding strandings — and
 * then seven further passes behind it.
 *
 * Source-text assertion rather than a behavioural one, deliberately: `index.ts`
 * is the process entrypoint and this block has no seam a unit test can drive
 * without standing up the whole server. The precedent is
 * `stranded-recovery-drain-metering.test.ts`, which guards a call site in the
 * same file the same way, and `startup-filesystem-io.test.ts` before it. This is
 * weaker than a type — it cannot prove a rejection is actually contained — but
 * it is the only thing that fails when someone deletes the guard or slides the
 * reconcile call back inside it, which is the regression that matters.
 */
const repoRoot = join(import.meta.dirname, "../../..");
const serverSource = readFileSync(join(repoRoot, "server/src/index.ts"), "utf8");

// The last line of the preceding (already-guarded) startup step. Everything this
// file cares about is between it and the next startup pass.
const START_ANCHOR = '"startup detached-queued-run sweeper failed"';
const END_ANCHOR = "heartbeat.reconcileIssueGraphLiveness()";

describe("startup heartbeat dispatch cannot suppress stranded-issue reconciliation (PEN-3582)", () => {
  const startIndex = serverSource.indexOf(START_ANCHOR);
  // Searched FORWARD from the start anchor: `reconcileIssueGraphLiveness` also
  // appears in the periodic chain later in the file, and an unanchored
  // `indexOf` would be a coin flip on which one it found if the two blocks were
  // ever reordered.
  const endIndex = startIndex > -1 ? serverSource.indexOf(END_ANCHOR, startIndex) : -1;

  // Both anchors fail in opposite directions, so neither may go unchecked:
  //
  //   - START missing => `slice(-1, endIndex)` is "", and every positive
  //     assertion below passes against an empty string.
  //   - END missing   => `slice(startIndex, -1)` is nearly the whole rest of the
  //     file. That is the dangerous one: the ordering chain below would then be
  //     satisfied by unrelated scheduler blocks and this file would read green
  //     having lost the call site it exists to pin.
  //
  // Collapsing to "" on either failure makes both modes loud.
  const region = startIndex > -1 && endIndex > startIndex
    ? serverSource.slice(startIndex, endIndex)
    : "";

  it("has a locatable, unambiguous startup region", () => {
    expect(startIndex).toBeGreaterThan(-1);
    // A second occurrence of the start anchor would mean the slice could be
    // taken from the wrong block.
    expect(serverSource.indexOf(START_ANCHOR)).toBe(serverSource.lastIndexOf(START_ANCHOR));
    expect(endIndex).toBeGreaterThan(startIndex);
    expect(region).toContain("heartbeat.reconcileStrandedAssignedIssues()");
  });

  it("wraps the dispatch pair and leaves stranded reconciliation outside the guard", () => {
    const promoteIndex = region.indexOf("heartbeat.promoteDueScheduledRetries()");
    const resumeIndex = region.indexOf("heartbeat.resumeQueuedRuns()");
    const catchIndex = region.indexOf('"startup heartbeat dispatch resumption failed"');
    const reconcileIndex = region.indexOf("heartbeat.reconcileStrandedAssignedIssues()");
    // Nearest `try {` preceding the dispatch pair. The region begins after the
    // detached-queued-run sweeper's own `try {`, so there is no earlier one to
    // match by accident — if the guard is deleted this is -1.
    const tryIndex = promoteIndex > -1 ? region.lastIndexOf("try {", promoteIndex) : -1;

    expect(tryIndex).toBeGreaterThan(-1);
    expect(promoteIndex).toBeGreaterThan(tryIndex);
    expect(resumeIndex).toBeGreaterThan(promoteIndex);
    // The catch handler exists AND closes after the pair. Deleting the guard
    // drops this to -1.
    expect(catchIndex).toBeGreaterThan(resumeIndex);
    // ...and the pass whose suppression was the defect runs after it.
    expect(reconcileIndex).toBeGreaterThan(catchIndex);
  });

  it("does not hide the reconcile call inside the catch handler", () => {
    // Ordering alone cannot tell "after the catch block" from "inside it", and
    // inside would reinstate the exact suppression this guard exists to remove:
    // the pass would then run ONLY when dispatch failed.
    //
    // Between the handler's message literal and the reconcile call there must be
    // exactly one brace — the one closing the handler — and no opening brace.
    const catchIndex = region.indexOf('"startup heartbeat dispatch resumption failed"');
    const reconcileIndex = region.indexOf("heartbeat.reconcileStrandedAssignedIssues()");
    expect(catchIndex).toBeGreaterThan(-1);
    expect(reconcileIndex).toBeGreaterThan(catchIndex);

    const between = region.slice(catchIndex, reconcileIndex);

    // Exactly one brace closes the handler, and it closes BEFORE the reconcile
    // call. If the call were moved inside the handler the handler's `}` would
    // fall after it, so `between` would contain no `}` at all — which is why
    // this is asserted explicitly rather than left to the slice below.
    expect(between).toContain("}");
    expect(between.match(/\}/g)).toHaveLength(1);

    // PEN-3810 (carried from Ally's non-blocking review 1 on PR #2234). This
    // case previously also asserted `not.toContain("{")`. That assertion was
    // REMOVED, not lost: PEN-3810 wraps each following recovery pass in its own
    // `try`/`catch`, so there is now a legitimate `try {` between this handler
    // and the reconcile call and the assertion would fail on correct code. What
    // it was really pinning — that the reconcile call is after the handler
    // CLOSES rather than nested inside it — is pinned more tightly below.
    //
    // Ally named `throw err;` specifically: adding it after the log reinstates
    // the exact defect this file exists to pin, and it contains no brace, so
    // every assertion above passes. "Surface this failure upstream" is the most
    // plausible innocent edit to a catch that currently only logs.
    //
    // Kept as its own assertion rather than folded into the regex below: it is
    // the single likeliest mutation, and `not.toContain` names it in the
    // failure output where a regex mismatch would not.
    expect(between).not.toContain("throw");

    // `throw` is not the only escape, and enumerating keywords would only ever
    // close the ones we thought of — verified by mutation: `return;` and
    // `process.exit(1);` both reinstate the same suppression and both survive
    // the `throw` check above. So assert the shape instead of blacklisting:
    // between the handler's message literal and its closing brace there may be
    // nothing but the tail of that logger call. Any added statement fails, and
    // so does moving the reconcile call inside the handler (no `}` in
    // `between` then, so this collapses to "" and the match fails loudly).
    //
    // The optional comma and loose whitespace keep an innocent multi-line
    // reformat of the `logger.error(...)` call passing; only an added
    // statement breaks it.
    const handlerTail = between.slice(0, between.indexOf("}") + 1);
    expect(handlerTail.trim()).toMatch(
      /^"startup heartbeat dispatch resumption failed",?\s*\)\s*;\s*\}$/,
    );
  });

  it("reports an unmeasured promotion count as null rather than a fabricated zero", () => {
    // When the guarded pair rejects, `promotion` is never assigned. Logging 0
    // there would render "dispatch was measured and promoted nothing"
    // identically to "dispatch never ran" — the same class of defect BLO-30303
    // fixed one block further down this file.
    expect(region).toMatch(/promotedScheduledRetries:\s*promotion\?\.promoted\s*\?\?\s*null/);
    expect(region).not.toMatch(/promotedScheduledRetries:\s*promotion\?\.promoted\s*\?\?\s*0/);
  });
});

// PEN-3810. Bounds the whole startup recovery IIFE, not just the dispatch pair
// above: the terminal `.catch()` message is the last thing in it.
const IIFE_ANCHOR = "const startupHeartbeatRecovery = (async () => {";
const TERMINAL_CATCH = '"startup heartbeat recovery failed"';

describe("every startup recovery pass is isolated from its siblings (PEN-3810)", () => {
  /**
   * Carried from Ally's non-blocking review 2 on PR #2234. PR #2234 guarded the
   * dispatch pair; the passes behind it were still bare `await`s under the one
   * terminal `.catch()`, so the first rejection skipped all of the rest. Ally
   * named five; re-measuring found eight — `reconcileResolvedBlockerDependents`,
   * `reconcileUndeliverableIssueMonitors` and `reconcileFailedWakeDispatches`
   * were not in the review.
   *
   * Asserted as a PROPERTY of the whole IIFE rather than as a list of the eight.
   * A list would go stale the moment a ninth pass is appended — and a pass
   * appended unguarded is exactly the regression this exists to catch, so the
   * stale-list version would be silent on the only case that matters.
   */
  const iifeStart = serverSource.indexOf(IIFE_ANCHOR);
  const iifeEnd = iifeStart > -1 ? serverSource.indexOf(TERMINAL_CATCH, iifeStart) : -1;

  // Comments are stripped before the brace walk: a `{` inside a comment would
  // shift the depth counter and silently misclassify every pass after it.
  const body = iifeStart > -1 && iifeEnd > iifeStart
    ? serverSource
      .slice(iifeStart, iifeEnd)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "")
    : "";

  it("has a locatable, unambiguous startup recovery IIFE", () => {
    expect(iifeStart).toBeGreaterThan(-1);
    expect(serverSource.indexOf(IIFE_ANCHOR)).toBe(serverSource.lastIndexOf(IIFE_ANCHOR));
    expect(iifeEnd).toBeGreaterThan(iifeStart);
  });

  it("runs every heartbeat recovery pass inside a failure guard", () => {
    // Index of the `{` that opens each `try` block, so the brace walk below can
    // tell a try-brace from any other brace at the same depth.
    const tryBraces = new Set<number>();
    const tryRe = /\btry\s*\{/g;
    for (let m = tryRe.exec(body); m !== null; m = tryRe.exec(body)) {
      tryBraces.add(m.index + m[0].length - 1);
    }

    const passes: { index: number; name: string }[] = [];
    const awaitRe = /await\s+(heartbeat\.[A-Za-z0-9_$]+)\(/g;
    for (let m = awaitRe.exec(body); m !== null; m = awaitRe.exec(body)) {
      passes.push({ index: m.index, name: m[1] });
    }

    // Positive control: if the anchors or the regex ever stop matching, this
    // case must fail rather than pass vacuously against an empty pass list.
    expect(passes.length).toBeGreaterThanOrEqual(16);

    const unguarded: string[] = [];
    const openTryDepths: number[] = [];
    let depth = 0;
    let cursor = 0;
    for (const pass of passes) {
      for (; cursor < pass.index; cursor += 1) {
        const ch = body[cursor];
        if (ch === "{") {
          depth += 1;
          if (tryBraces.has(cursor)) openTryDepths.push(depth);
        } else if (ch === "}") {
          if (openTryDepths[openTryDepths.length - 1] === depth) openTryDepths.pop();
          depth -= 1;
        }
      }
      if (openTryDepths.length === 0) unguarded.push(pass.name);
    }

    // Named rather than counted: the failure output should say WHICH pass lost
    // its guard, not just that one did.
    expect(unguarded).toEqual([]);
  });
});
