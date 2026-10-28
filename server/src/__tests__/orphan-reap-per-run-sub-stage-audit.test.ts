import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { KNOWN_ORPHAN_REAP_STAGES } from "../services/metrics.js";

/**
 * PEN-4781 exhaustiveness guard for the `per_run` sub-stage partition.
 *
 * `per_run` is one lap over ~28 awaits spread through nested branches across
 * ~700 lines, so for two separate sweep-slow episodes -- 2026-10-19 (kube flat
 * at x1.04 while `per_run` went x1088) and 2026-10-25 (`list_jobs` x96.6 in
 * lockstep with `per_run` x90.8) -- the metric named the same stage for two
 * different faults and localization stopped there. The split exists to end
 * that.
 *
 * WHY THIS IS AN AUDIT AND NOT A LABEL ASSERTION. The split's whole value
 * rests on being EXHAUSTIVE: a partition that misses an await puts that time
 * in no bucket, and a responder then reads four small numbers and concludes
 * nothing is slow. That is a FALSE NEGATIVE, strictly worse than the honest
 * dead end it replaces, and -- unlike a deleted label -- it is invisible. The
 * way it arrives is not deletion but ordinary growth: the next contributor
 * adds an `await` to that loop and nothing anywhere objects. Asserting the
 * five labels exist cannot catch that; only reading the loop can.
 *
 * KNOWN BOUND: this is a regex over source text, not a TypeScript parse, so it
 * is a second oracle for "what is an awaited call". It is tuned to over-report
 * -- a false offender is a visible failure, a missed one is the silent hole
 * above. Two shapes it cannot see, named so nobody reads a pass as stronger
 * than it is: a call reached through a dynamically-selected callee, and
 * `const p = slowThing(); await p;`, which awaits a variable rather than a
 * call. Neither occurs in the loop today. It deliberately carries no
 * line-number allowlist, which would drift and go stale without saying so.
 */

const HEARTBEAT_SOURCE = join(
  fileURLToPath(new URL("../services/heartbeat.ts", import.meta.url)),
);
const LOOP_START = "for (const { run, adapterType, adapterConfig } of activeRuns) {";
// Matched WITHOUT the closing paren so the marker survives an added argument
// (PEN-4783 passes the lap's instant in, so the call now reads
// `lapOrphanReap("per_run", perRunEndedAt)`). Still pins the call itself, so a
// rename or deletion fails loudly below rather than matching nothing and making
// every assertion here vacuously pass.
const LOOP_END = 'lapOrphanReap("per_run"';

/** Blank out comments so prose mentioning `await` is not read as a call. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (line) => " ".repeat(line.length));
}

function readPerRunLoop(): string {
  const source = stripComments(readFileSync(HEARTBEAT_SOURCE, "utf8"));
  const start = source.indexOf(LOOP_START);
  const end = source.indexOf(LOOP_END, start);
  // A rename that moves either marker must fail loudly here. Silently matching
  // nothing would make every assertion below vacuously pass -- the same
  // retire-the-gate-at-constant-length failure the test-typecheck allowlist
  // guards against.
  expect(start, `per_run loop start marker not found: ${LOOP_START}`).toBeGreaterThan(-1);
  expect(end, `per_run lap marker not found after the loop: ${LOOP_END}`).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("per_run sub-stage partition (PEN-4781)", () => {
  it("declares all five sub-stages, including the residual", () => {
    // Named one by one rather than looped: the risk these carry is deletion,
    // and `per_run_other` in particular looks like an afterthought bucket to
    // anyone who has not read why it is the one that makes the sum assertable.
    for (const stage of [
      "per_run_liveness",
      "per_run_finalize",
      "per_run_dispatch",
      "per_run_cleanup",
      "per_run_other",
    ] as const) {
      expect(KNOWN_ORPHAN_REAP_STAGES).toContain(stage);
    }
  });

  it("attributes every awaited call in the per_run loop to a timed bucket", () => {
    const loop = readPerRunLoop();
    const unattributed = [...loop.matchAll(/await\s+([A-Za-z_$][\w$.]*)\s*\(/g)]
      .map((match) => match[1])
      .filter((callee) => !callee.startsWith("timed"));
    expect(
      unattributed,
      "Every awaited call inside the per_run loop must go through a timedPerRunCall "
        + "alias, or its time lands in no sub-stage and the partition stops summing to "
        + "`per_run`. Wrap the new call in the bucket it belongs to (see the alias block "
        + "above the loop); do not add a label for it.",
    ).toEqual([]);
  });

  it("wires every timed alias the loop uses to one of the four buckets", () => {
    // Closes the obvious way to satisfy the audit above without satisfying its
    // intent: naming an untimed helper `timedSomething`.
    const source = stripComments(readFileSync(HEARTBEAT_SOURCE, "utf8"));
    const declared = new Set(
      [...source.matchAll(/const\s+(timed[A-Za-z_$][\w$]*)\s*=\s*timedPerRunCall\(/g)].map(
        (match) => match[1],
      ),
    );
    const used = new Set(
      [...readPerRunLoop().matchAll(/await\s+(timed[A-Za-z_$][\w$]*)\s*\(/g)].map(
        (match) => match[1],
      ),
    );
    expect(used.size, "the loop should still be using timed aliases").toBeGreaterThan(0);
    expect([...used].filter((alias) => !declared.has(alias))).toEqual([]);
  });

  it("emits the whole partition before the lap that would advance the cursor", () => {
    const source = stripComments(readFileSync(HEARTBEAT_SOURCE, "utf8"));
    const lapAt = source.indexOf(LOOP_END, source.indexOf(LOOP_START));
    for (const stage of [
      "per_run_liveness",
      "per_run_finalize",
      "per_run_dispatch",
      "per_run_cleanup",
      "per_run_other",
    ] as const) {
      const recordAt = source.indexOf(`recordOrphanReapStage(\n      "${stage}"`) >= 0
        ? source.indexOf(`recordOrphanReapStage(\n      "${stage}"`)
        : source.indexOf(`recordOrphanReapStage("${stage}"`);
      expect(recordAt, `${stage} is never recorded`).toBeGreaterThan(-1);
      // Reading after the lap would measure a span of zero: `lapOrphanReap`
      // advances `orphanReapLapAt` to now.
      expect(recordAt, `${stage} must be recorded before lapOrphanReap("per_run")`).toBeLessThan(
        lapAt,
      );
    }
  });
});
