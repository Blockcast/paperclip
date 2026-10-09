import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";

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

/**
 * PEN-3810. Bounds the whole startup recovery IIFE, not just the dispatch pair
 * above.
 *
 * Asserted as a PROPERTY of the whole IIFE rather than as a list of the passes.
 * A list would go stale the moment another pass is appended — and a pass
 * appended unguarded is exactly the regression this exists to catch, so the
 * stale-list version would be silent on the only case that matters.
 *
 * PEN-3897 (carried from Ally's non-blocking review on PR #2339). That review
 * left three suggestions on this block, and all three were artefacts of
 * matching source TEXT. They are answered by one mechanism rather than three
 * patches: parse `index.ts` and assert the property against the syntax tree.
 * The precedent for reaching for the compiler API in a guard test is
 * `approval-payload-title-guard.test.ts`.
 *
 * What that buys, suggestion by suggestion:
 *
 *   - A `try` is only a guard if it CATCHES, and only if its handler does not
 *     re-raise. The previous brace walk's entire guard test was
 *     `openTryDepths.length === 0`; it never looked at the handler. So
 *     `catch (err) { logger.error(...); throw err; }` read as guarded while
 *     reinstating the exact cascade this file exists to pin — Ally confirmed
 *     that by mutation on `reconcileTaskWatchdogs`, and it is re-confirmed by
 *     mutation against THIS implementation. A handler is now checked for the
 *     closed set of ways control leaves a function body — `throw` and `return`
 *     — plus the one runtime escape that is neither (`process.exit`). That is a
 *     closed set, not a keyword blacklist: there is no third syntactic way out
 *     of a function. A `try`/`finally` carrying no `catch` does not contain a
 *     rejection either, and is now rejected as well.
 *   - Awaited passes are found by SHAPE, not by name, so a pass that is not a
 *     `heartbeat.*` method is covered the moment one is added. Measured at
 *     8bcb44c1: the previous `heartbeat.`-anchored regex, Ally's tolerant
 *     variant of it, and an unanchored widening all match the identical 16
 *     calls, and none of the 16 is a non-`heartbeat` call. So this closes a
 *     PROSPECTIVE hole, and needs no allowlist — there is nothing to allow.
 *   - The `>= 16` positive control can no longer be tripped by reformatting.
 *     Splitting `await heartbeat.reconcileFailedWakeDispatches()` across lines
 *     dropped the old regex's count to 15 and fired a control whose message
 *     blamed the anchors; it does not change the tree.
 *
 * Out of scope deliberately: a promise that is TRACKED rather than awaited
 * (`trackHeartbeatSchedulerWork(executionWorkspaceCleanup...)` at the tail of
 * this IIFE) is not part of the serial flow and so cannot cascade into it, and
 * it already carries its own `.catch()`. It is the correct pattern here, not an
 * unguarded pass — which is why it is absent from the 16 above rather than an
 * exception to them.
 */
const RECOVERY_IIFE_BINDING = "startupHeartbeatRecovery";

// The closed set of ways a catch handler ends the startup sequence without
// re-raising syntactically. `throw`/`return` are handled structurally below.
const ESCAPE_CALLS = new Set(["process.exit", "process.abort"]);

describe("every startup recovery pass is isolated from its siblings (PEN-3810)", () => {
  const sourceFile = ts.createSourceFile(
    "index.ts",
    serverSource,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );

  function collect<T extends ts.Node>(root: ts.Node, pred: (node: ts.Node) => node is T): T[] {
    const out: T[] = [];
    const visit = (node: ts.Node): void => {
      if (pred(node)) out.push(node);
      ts.forEachChild(node, visit);
    };
    visit(root);
    return out;
  }

  const isAsyncArrow = (node: ts.Node): node is ts.ArrowFunction =>
    ts.isArrowFunction(node)
    && node.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) === true;

  const bindings = collect(
    sourceFile,
    (node): node is ts.VariableDeclaration =>
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.name.text === RECOVERY_IIFE_BINDING,
  );

  // The async arrow inside that declaration's initializer. The initializer also
  // contains the terminal `.catch((err) => ...)` arrow, but that one is not
  // async — which is what makes this selection unambiguous rather than
  // positional.
  const asyncArrows = bindings.length === 1 ? collect(bindings[0], isAsyncArrow) : [];
  const iife = asyncArrows.length === 1 ? asyncArrows[0] : null;

  const normalize = (node: ts.Node): string => node.getText(sourceFile).replace(/\s+/g, "");

  const enclosingFunction = (node: ts.Node): ts.Node | null => {
    for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
      if (
        ts.isArrowFunction(p) || ts.isFunctionExpression(p)
        || ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p)
      ) return p;
    }
    return null;
  };

  // Only awaits whose nearest enclosing function IS the IIFE are part of its
  // serial flow; one inside a nested callback rejects somewhere else entirely.
  const passes = iife === null
    ? []
    : collect(iife, ts.isAwaitExpression)
      .filter((await_) => enclosingFunction(await_) === iife)
      .filter((await_) => ts.isCallExpression(await_.expression))
      .map((await_) => ({
        node: await_ as ts.Node,
        name: normalize((await_.expression as ts.CallExpression).expression),
      }));

  // Nearest enclosing `try` whose TRY BLOCK contains the pass — a pass sitting
  // in a `catch` or `finally` is not guarded by that statement.
  const guardFor = (node: ts.Node): ts.TryStatement | null => {
    for (let p: ts.Node | undefined = node.parent; p && p !== iife; p = p.parent) {
      if (
        ts.isTryStatement(p)
        && node.getStart(sourceFile) >= p.tryBlock.getStart(sourceFile)
        && node.getEnd() <= p.tryBlock.getEnd()
      ) return p;
    }
    return null;
  };

  const escapesOf = (clause: ts.CatchClause): string[] => {
    const found: string[] = [];
    const visit = (node: ts.Node): void => {
      // A `return` inside a nested callback returns from THAT callback, so a
      // nested function body is not this handler's control flow. Documented
      // limit: an escape hidden inside a synchronously-invoked callback is not
      // seen. Every handler in this IIFE is a bare `logger` call, and the three
      // measured mutations (`throw err;`, `return;`, `process.exit(1);`) are
      // all direct statements, so this costs nothing today.
      if (
        ts.isArrowFunction(node) || ts.isFunctionExpression(node)
        || ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)
      ) return;
      if (ts.isThrowStatement(node)) found.push("throw");
      else if (ts.isReturnStatement(node)) found.push("return");
      else if (ts.isCallExpression(node) && ESCAPE_CALLS.has(normalize(node.expression))) {
        found.push(`${normalize(node.expression)}()`);
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(clause.block, visit);
    return found;
  };

  it("has exactly one locatable startup recovery IIFE", () => {
    expect(bindings).toHaveLength(1);
    expect(asyncArrows).toHaveLength(1);
    expect(iife).not.toBeNull();
  });

  it("runs every awaited startup recovery pass inside a failure guard", () => {
    // Positive control: if the binding or the walk ever stops matching, this
    // case must fail rather than pass vacuously against an empty pass list.
    // Unlike the regex this replaced, the floor cannot be tripped by
    // reformatting a call across lines — only by losing the IIFE or by
    // deleting passes.
    expect(passes.length).toBeGreaterThanOrEqual(16);

    // Named rather than counted: the failure output should say WHICH pass lost
    // its guard, not just that one did.
    const unguarded = passes.filter((pass) => guardFor(pass.node) === null).map((pass) => pass.name);
    expect(unguarded).toEqual([]);
  });

  it("lets no guard re-raise the failure it just caught", () => {
    expect(passes.length).toBeGreaterThanOrEqual(16);

    // Reported as two lists, not one: a handler that escapes and a `try` with
    // no handler at all are different edits with different fixes, and the
    // failure output should not conflate them.
    const uncaught: string[] = [];
    const escaping: string[] = [];
    for (const pass of passes) {
      const guard = guardFor(pass.node);
      if (guard === null) continue; // already reported by the case above
      if (guard.catchClause === undefined) {
        uncaught.push(pass.name);
        continue;
      }
      const escapes = escapesOf(guard.catchClause);
      if (escapes.length > 0) escaping.push(`${pass.name} -> ${escapes.join(", ")}`);
    }

    expect(uncaught).toEqual([]);
    expect(escaping).toEqual([]);
  });
});
