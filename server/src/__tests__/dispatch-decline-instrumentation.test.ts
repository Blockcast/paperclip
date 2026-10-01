import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AGENT_DISPATCH_DECLINED_METRIC,
  KNOWN_DISPATCH_DECLINE_REASONS,
  UNKNOWN_AGENT_ID,
  UNKNOWN_DISPATCH_DECLINE_REASON,
  normalizeDispatchDeclineReason,
  recordAgentDispatchDeclined,
  renderMetrics,
} from "../services/metrics.js";

/**
 * PEN-3607. Agent `bcba1cc7` held four `queued` runs for 73.6 h with no
 * `startedAt` while the periodic sweep reached it on every scheduler tick and
 * declined it. Nothing recorded the refusal: of the fifteen `return []` sites in
 * `startNextQueuedRunForAgent`, exactly one wrote a metric, and none wrote to the
 * run row or logged above `debug`. Two independent code-trace localizations of
 * the bail were both wrong, because narrowing by elimination is the only tool a
 * silent path leaves you and it is a bad one.
 *
 * The guard below is the durable half of the fix. The counter can be added once;
 * what has to hold over time is that a NEW decline path cannot be introduced
 * silently — which is precisely how the fifteen accumulated.
 */

const HEARTBEAT_SOURCE = readFileSync(
  fileURLToPath(new URL("../services/heartbeat.ts", import.meta.url)),
  "utf8",
);

/**
 * Slice `startNextQueuedRunForAgent` out of the service closure. Bounded at the
 * next same-indent declaration rather than by brace matching: the body contains
 * template literals and regexes, so a naive brace counter mis-terminates.
 */
function readDispatchFunctionSource(source: string): string {
  const start = source.indexOf("async function startNextQueuedRunForAgent(");
  expect(start, "startNextQueuedRunForAgent not found — was it renamed?").toBeGreaterThan(-1);
  const rest = source.slice(start + 1);
  const nextDecl = rest.search(/\n {2}(?:async )?function /);
  expect(nextDecl, "no following declaration — the slice would run to EOF").toBeGreaterThan(-1);
  return rest.slice(0, nextDecl);
}

/**
 * Every `return []` in the slice that does not record a decline on the same
 * line or the one immediately above it.
 *
 * The match is deliberately a SUBSTRING, not a whole-line anchor. An anchored
 * `/^\s*return \[\];\s*$/` cannot see `if (cond) return [];` — and that is the
 * repo's own prior idiom, not a hypothetical: the first guard this PR rewrote
 * was `if (options.skipQueuedRunDispatch || dispatchStopped) return [];`. An
 * anchored scanner therefore has a hole shaped exactly like the defect it
 * exists to catch, and would report clean on it. The counter is the disposable
 * half of this change; this scanner is the durable half.
 *
 * Widening is free here rather than merely cheap: against `heartbeat.ts` the
 * substring form matches the same 15 sites the anchored form did, and it does
 * NOT match the `flatMap` ternary `return issue ? [{ run, issue }] : [];`,
 * which is the only nearby line that could have collided.
 *
 * The lookback is exactly one line on purpose. A wider window was written first
 * and the negative control below refuted it: with a ~12-line window, a newly
 * added silent `return []` sitting a few lines under an instrumented one is
 * masked by its neighbour, so the scan reports clean on the exact defect it
 * exists to catch. One line makes the convention unambiguous and the guard
 * sound — put the record immediately above the return, with logging above that,
 * or inline on the same line for a single-line guard.
 */
const RETURN_EMPTY = /\breturn \[\];/;

/**
 * Returns of the result ACCUMULATOR, which `return []`-keyed scanning cannot
 * see at all.
 *
 * This is the second hole, found in review of `b45b277f` after the first was
 * closed. The emergency-continuation branch exited with `return claimedRuns;`
 * while `claimedRuns` was empty — a decline in every respect that matters,
 * invisible to {@link RETURN_EMPTY}. It was invisible to the count equality
 * below too, and in the worst way: adding neither a `return []` nor a
 * `noteDispatchDeclined`, it left `returnCount === used.length` green while
 * the path stayed dark. A scanner that only knows one syntactic form of
 * "return nothing" is one refactor away from blind.
 *
 * So the rule is widened from "every `return []` is instrumented" to "every
 * return that CAN be empty is instrumented, or is provably not empty". The
 * proof is deliberately syntactic and narrow — the nearest preceding
 * `claimedRuns.length` COMPARISON, read against the guard's BLOCK (its close is
 * the first non-blank line after it at the guard's indent or shallower):
 *
 *   - `if (claimedRuns.length > 0) {`: this return sits strictly inside that
 *     block, i.e. inside the non-empty branch.
 *   - `if (claimedRuns.length === 0) {`: this return sits at or after the
 *     block's close without control having left the guard's enclosing scope,
 *     so the empty case already returned and control reaching here is
 *     non-empty.
 *
 * Indentation alone is not a proof (review of `884c2705`): it let a
 * `> 0` guard whose block had already CLOSED vouch for a deeper return in a
 * later, unrelated block — a neighbouring guard vouching for a return it does
 * not dominate, the same masking the one-line window above exists to kill.
 *
 * Anything else is unproven and must be instrumented. Requiring a COMPARISON
 * rather than any mention of `claimedRuns.length` is load-bearing: the real
 * function calls `advanceOrClearResumeCursor(claimedRuns.length)` between the
 * `=== 0` guard and the final return, and a looser pattern would latch onto
 * that and read a non-comparison as a proof.
 */
const RETURN_ACCUMULATOR = /\breturn claimedRuns;/;
const CLAIMED_LENGTH_GUARD = /claimedRuns\.length\s*(===\s*0|>\s*0)/;

/**
 * Blank out comment-only lines, preserving line NUMBERING so reported
 * offenders still point at the real source.
 *
 * Not hygiene — this scanner reads prose as code without it, and that was
 * demonstrated rather than imagined. Writing the comment that explains the
 * emergency-continuation fix broke both scans at once: it quotes the literals
 * `return claimedRuns;` and `claimedRuns.length === 0`, so it inflated the
 * return count past the `used.length` equality AND, far worse, was accepted as
 * a non-emptiness PROOF for the return below it. A scanner that a comment can
 * satisfy is a scanner that documentation can silently disarm — and the
 * failure is invisible, because the prose that disarms it is the prose that
 * says the path is handled.
 *
 * Whole-line only, deliberately: this avoids trying to find `//` inside string
 * and regex literals, which this file's body is full of. But a line that CLOSES
 * a block comment can carry code after the closing delimiter, and such a line
 * still begins with an asterisk — it is not a comment line. Blanking it
 * wholesale would hand the scanner a false NEGATIVE, which is the failure mode
 * this whole test exists to prevent, so on an asterisk-leading line that
 * contains a close delimiter we keep everything after the last one.
 * (`Blockcast/paperclip`'s no-remote-push policy scanner has the mirror-image
 * bug — it strips only `//`, so JSDoc prose reds a required gate. Same seam,
 * opposite sign; PEN-3267.)
 */
function withoutCommentLines(source: string): string[] {
  return source.split("\n").map((line) => {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("//")) return "";
    if (!trimmed.startsWith("*") && !trimmed.startsWith("/*")) return line;
    const close = line.lastIndexOf("*/");
    if (close < 0) return "";
    const tail = line.slice(close + 2);
    // Preserve column positions so indentation-based proofs stay honest.
    return tail.trim().length > 0 ? " ".repeat(close + 2) + tail : "";
  });
}

function countInCode(source: string, pattern: RegExp): number {
  return withoutCommentLines(source).filter((line) => pattern.test(line)).length;
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function findUnprovenAccumulatorReturns(functionSource: string): number[] {
  const lines = withoutCommentLines(functionSource);
  const isCode = (candidate: string) => candidate.trim().length > 0;
  const offenders: number[] = [];
  for (const [index, line] of lines.entries()) {
    if (!RETURN_ACCUMULATOR.test(line)) continue;
    if (line.includes("noteDispatchDeclined(")) continue;
    const previous = index > 0 ? lines[index - 1]! : "";
    if (previous.includes("noteDispatchDeclined(") && !RETURN_ACCUMULATOR.test(previous)) continue;
    let proven = false;
    for (let back = index - 1; back >= 0; back -= 1) {
      const candidate = lines[back]!;
      const guard = CLAIMED_LENGTH_GUARD.exec(candidate);
      if (!guard) continue;
      const guardIndent = indentOf(candidate);
      // The guard's block closes at the first code line after it that is not
      // deeper than the guard; blank and comment lines carry no structure.
      let close = back + 1;
      while (close < lines.length && !(isCode(lines[close]!) && indentOf(lines[close]!) <= guardIndent)) {
        close += 1;
      }
      proven = guard[1]!.startsWith(">")
        ? index < close
        : index >= close
          && !lines.slice(close, index + 1).some((l) => isCode(l) && indentOf(l) < guardIndent)
          // An `=== 0` guard proves nothing unless its block actually exits;
          // one that falls through vouches for the return beneath it.
          && lines.slice(back, close).some((l) => /\b(?:return|throw)\b/.test(l));
      break;
    }
    if (!proven) offenders.push(index + 1);
  }
  return offenders;
}

function findUninstrumentedReturns(functionSource: string): number[] {
  const lines = withoutCommentLines(functionSource);
  const offenders: number[] = [];
  for (const [index, line] of lines.entries()) {
    if (!RETURN_EMPTY.test(line)) continue;
    // A record on the same line instruments this return (single-line guard).
    if (line.includes("noteDispatchDeclined(")) continue;
    const previous = index > 0 ? lines[index - 1]! : "";
    // A record on the line above instruments this return ONLY if it is not
    // already spent on a return of its own. Without that second clause a
    // single-line instrumented guard would vouch for the silent guard beneath
    // it — reintroducing, for the single-line idiom, the exact masking the
    // one-line window exists to prevent. The `[3]` control below is this case.
    if (previous.includes("noteDispatchDeclined(") && !RETURN_EMPTY.test(previous)) continue;
    offenders.push(index + 1);
  }
  return offenders;
}

describe("recordAgentDispatchDeclined", () => {
  it("emits a bounded agent_id and reason, and appears in the Prometheus exposition", async () => {
    const agentId = "11111111-2222-3333-4444-555555555555";
    const labels = recordAgentDispatchDeclined({
      agentId,
      reason: "no_claimable_run",
      knownAgentIds: new Set([agentId]),
    });

    expect(labels).toEqual({ agent_id: agentId, reason: "no_claimable_run" });

    const { body } = await renderMetrics();
    expect(body).toMatch(
      new RegExp(
        `${AGENT_DISPATCH_DECLINED_METRIC}[^\\n]*agent_id="${agentId}"[^\\n]*reason="no_claimable_run"`,
      ),
    );
  });

  it("collapses an agent outside the known roster, so a stale id cannot inflate cardinality", () => {
    const labels = recordAgentDispatchDeclined({
      agentId: "99999999-9999-9999-9999-999999999999",
      reason: "agent_not_invokable",
      knownAgentIds: new Set(),
    });
    expect(labels.agent_id).toBe(UNKNOWN_AGENT_ID);
    expect(labels.reason).toBe("agent_not_invokable");
  });

  it("collapses a reason outside the allow-list rather than minting a new series", () => {
    expect(normalizeDispatchDeclineReason("not_a_real_reason")).toBe(
      UNKNOWN_DISPATCH_DECLINE_REASON,
    );
    expect(normalizeDispatchDeclineReason(null)).toBe(UNKNOWN_DISPATCH_DECLINE_REASON);
    for (const reason of KNOWN_DISPATCH_DECLINE_REASONS) {
      expect(normalizeDispatchDeclineReason(reason)).toBe(reason);
    }
  });
});

describe("startNextQueuedRunForAgent decline instrumentation", () => {
  const functionSource = readDispatchFunctionSource(HEARTBEAT_SOURCE);
  const returnCount = countInCode(functionSource, RETURN_EMPTY);

  it("records a reason at every path that returns without claiming a run", () => {
    // Guards the slice itself: if this drops to 0 the scan below passes
    // vacuously, which is the failure mode a source-level test must not have.
    expect(returnCount).toBeGreaterThanOrEqual(16);
    expect(findUninstrumentedReturns(functionSource)).toEqual([]);
  });

  it("proves every accumulator return is non-empty, which a `return []` scan cannot", () => {
    // The second hole, from review of b45b277f: `return claimedRuns;` with an
    // empty accumulator is a decline that the literal-keyed scan above is
    // structurally unable to see.
    const accumulatorReturns = countInCode(functionSource, RETURN_ACCUMULATOR);
    // Same anti-vacuity guard as above: were the accumulator renamed, this scan
    // would match nothing and report clean.
    expect(accumulatorReturns).toBeGreaterThanOrEqual(2);
    expect(findUnprovenAccumulatorReturns(functionSource)).toEqual([]);
  });

  it("would catch an accumulator return that is not provably non-empty (negative control)", () => {
    // Three shapes. Only the first is proven; the other two are the live defect
    // and its near-miss, and both must be flagged.
    const body = [
      "  async function fake() {",
      "    if (flag) {",
      "      if (claimedRuns.length > 0) {",
      "        return claimedRuns;", // 4: inside the > 0 branch — proven
      "      }",
      "      return claimedRuns;", // 6: the b45b277f defect — empty here
      "    }",
      "    return claimedRuns;", // 8: no guard at all — unproven
      "  }",
    ].join("\n");
    expect(findUnprovenAccumulatorReturns(body)).toEqual([6, 8]);
  });

  it("accepts an accumulator return dominated by an `=== 0` early exit", () => {
    // The shape the real function ends in, including the intervening
    // non-comparison use of `claimedRuns.length` that a looser pattern would
    // mistake for the proof.
    const body = [
      "  async function fake() {",
      "    if (claimedRuns.length === 0) {",
      "      return [];",
      "    }",
      "    advanceOrClearResumeCursor(claimedRuns.length);",
      "    return claimedRuns;",
      "  }",
    ].join("\n");
    expect(findUnprovenAccumulatorReturns(body)).toEqual([]);
  });

  it("does not let a CLOSED `> 0` block vouch for a later, deeper return (negative control)", () => {
    // Review of 884c2705: an indent-only proof accepted line 6, because it is
    // deeper than the guard — but the guard's block closed on line 4, so
    // nothing here establishes the accumulator is non-empty.
    const body = [
      "  async function fake() {",
      "    if (claimedRuns.length > 0) {",
      "      launchClaimedRuns();",
      "    }",
      "    if (somethingElse) {",
      "      return claimedRuns;",
      "    }",
      "  }",
    ].join("\n");
    expect(findUnprovenAccumulatorReturns(body)).toEqual([6]);
  });

  it("accepts a deeper return after an `=== 0` early exit, and flags one past the guard's scope", () => {
    // The mirror of the control above: the empty case returned on line 3, so a
    // return nested in a later sibling block is dominated and must not be
    // flagged. An indent-only proof flagged it.
    const nested = [
      "  async function fake() {",
      "    if (claimedRuns.length === 0) {",
      "      return [];",
      "    }",
      "    if (x) {",
      "      return claimedRuns;",
      "    }",
      "  }",
    ].join("\n");
    expect(findUnprovenAccumulatorReturns(nested)).toEqual([]);

    // But a guard inside a conditional proves nothing once control leaves that
    // conditional: when `flag` is false, line 8 runs with the guard never
    // evaluated.
    const escaped = [
      "  async function fake() {",
      "    if (flag) {",
      "      if (claimedRuns.length === 0) {",
      "        return [];",
      "      }",
      "    }",
      "    if (x) {",
      "      return claimedRuns;",
      "    }",
      "  }",
    ].join("\n");
    expect(findUnprovenAccumulatorReturns(escaped)).toEqual([8]);
  });

  it("does not let an `=== 0` guard that falls through vouch for the return below it (negative control)", () => {
    // Review of ce5f7334: the `=== 0` arm checked scope but not exit, so a guard
    // whose block records and falls through let an empty accumulator reach line 6.
    const body = [
      "  async function fake() {",
      "    if (claimedRuns.length === 0) {",
      "      await noteDispatchDeclined(agentId, \"no_claimable_run\", companyId);",
      "    }",
      "    advanceOrClearResumeCursor(claimedRuns.length);",
      "    return claimedRuns;",
      "  }",
    ].join("\n");
    expect(findUnprovenAccumulatorReturns(body)).toEqual([6]);
  });

  it("flags an accumulator return INSIDE an `=== 0` branch", () => {
    // Same guard, opposite side: returning the accumulator from the branch that
    // proved it empty is the defect, not the proof.
    const body = [
      "  async function fake() {",
      "    if (claimedRuns.length === 0) {",
      "      return claimedRuns;",
      "    }",
      "  }",
    ].join("\n");
    expect(findUnprovenAccumulatorReturns(body)).toEqual([3]);
  });

  it("is not satisfied by a COMMENT quoting the guard or the return", () => {
    // Regression control for a defect this scanner caught in the very commit
    // that added it: the explanatory comment quotes both literals, and before
    // comment-stripping it both inflated the counts and vouched for the return
    // underneath it. Documentation must not be able to disarm the check that
    // the documentation describes.
    const body = [
      "  async function fake() {",
      "    // guarded above by `claimedRuns.length > 0`, so this is safe",
      "    return claimedRuns;",
      "  }",
    ].join("\n");
    expect(findUnprovenAccumulatorReturns(body)).toEqual([3]);

    const silent = [
      "  async function fake() {",
      "    // instrumented via noteDispatchDeclined(agentId, \"dispatch_stopped\", null)",
      "    return [];",
      "  }",
    ].join("\n");
    expect(findUninstrumentedReturns(silent)).toEqual([3]);

    // And a commented-out return is not a return site.
    expect(countInCode('    // return [];\n    const x = 1;', RETURN_EMPTY)).toBe(0);
  });

  it("still sees code sharing a line with a block-comment close", () => {
    // The false-NEGATIVE risk that comment-stripping introduces, and the exact
    // hazard the no-remote-push policy scanner hit from the other side (PEN-3267): a line
    // that closes a block comment begins with an asterisk but is not a comment
    // line. Built by concatenation so this file does not contain the delimiter
    // in prose.
    const close = "*" + "/";
    const body = [
      "  async function fake() {",
      "    /* why",
      `     ${close} return [];`,
      "  }",
    ].join("\n");
    // The return survives stripping and is correctly flagged as uninstrumented.
    expect(countInCode(body, RETURN_EMPTY)).toBe(1);
    expect(findUninstrumentedReturns(body)).toEqual([3]);
  });

  it("would catch a newly added silent decline path (negative control)", () => {
    // Same scanner, run against a body carrying one instrumented and one silent
    // decline. Without this, a scan that silently matched nothing would look
    // identical to a clean pass.
    const withSilentPath = [
      "  async function fake() {",
      "    if (a) {",
      '      await noteDispatchDeclined(agentId, "dispatch_stopped", null);',
      "      return [];",
      "    }",
      "    if (b) {",
      "      return [];",
      "    }",
      "  }",
    ].join("\n");
    expect(findUninstrumentedReturns(withSilentPath)).toHaveLength(1);
  });

  it("catches a silent single-line decline, which an anchored scan could not", () => {
    // The specific hole the anchored `^\s*return \[\];\s*$` left open: this is
    // the idiom the first guard in this change was written in, so a scanner
    // blind to it is blind to the next regression of the same shape.
    const singleLine = [
      "  async function fake() {",
      '    if (a) { await noteDispatchDeclined(agentId, "dispatch_stopped", null); return []; }',
      "    if (b) return [];",
      "  }",
    ].join("\n");
    // Line 3 only — the inline-instrumented guard on line 2 is accepted.
    expect(findUninstrumentedReturns(singleLine)).toEqual([3]);
  });

  it("does not flag a ternary that returns an empty array as a branch", () => {
    // False-positive control for the widened match.
    const ternary = ["  async function fake() {", "    return issue ? [{ run, issue }] : [];", "  }"].join(
      "\n",
    );
    expect(findUninstrumentedReturns(ternary)).toEqual([]);
  });

  it("uses only allow-listed reasons at the call sites", () => {
    const used = [...withoutCommentLines(functionSource)
      .join("\n")
      .matchAll(/noteDispatchDeclined\(\s*agentId,\s*"([a-z_]+)"/g)]
      .map((match) => match[1]!);
    // Tied to `returnCount` rather than asserted independently: a bare
    // `>= 15` on each is satisfiable by an instrumented site whose early exit
    // is not literally `return [];`, which would leave a real gap open. Equality
    // makes the two counts mutually load-bearing.
    expect(used.length).toBe(returnCount);
    for (const reason of used) {
      expect(KNOWN_DISPATCH_DECLINE_REASONS as readonly string[]).toContain(reason);
    }
  });
});
