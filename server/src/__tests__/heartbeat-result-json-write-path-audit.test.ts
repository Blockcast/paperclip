import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * PEN-3153 write-path guard.
 *
 * The scrub for `heartbeat_runs.resultJson` / `.error` cannot live at a single
 * DB-layer chokepoint: both columns are written by direct `UPDATE`/`INSERT`
 * statements that never pass through `setRunStatus` /
 * `setRunStatusIfCurrentStatus`. Four `resultJson` writes were missed by the
 * first version of this fix — two named by a reviewer, and two more found only
 * by running this audit (#1746 review, Important):
 *
 *   - `reconcileHotRestartAdoption`      (heartbeat.ts)   [reviewer]
 *   - stale-kill review-evidence follow-up (heartbeat.ts) [reviewer]
 *   - `foldSourceResolvedStaleRun`       (recovery/service.ts) [audit]
 *   - pipeline stage-exit cancellation   (pipelines.ts)        [audit]
 *
 * That last one is the argument for executing the audit rather than asserting
 * it: it lives in a third file, in a service the reviewer never named, and no
 * amount of re-reading the two reported sites would have surfaced it.
 *
 * A prose claim of "every write path is covered" is worth nothing against the
 * next contributor adding another. So the audit runs here: every `resultJson`
 * and `error` assignment inside a `heartbeatRuns` write must call the scrub,
 * be an inert literal (`error` only), or carry an explicit exemption marker
 * naming a reason. There is deliberately no line-number allowlist — those
 * drift and go stale silently.
 *
 * KNOWN BOUND: this is a regex over source text, not a TypeScript parse, so it
 * is a second oracle for "what is a write statement". It is tuned to
 * over-report rather than under-report (the capture window stops at the first
 * terminator), because a false offender is a visible test failure while a
 * missed one is a silent hole. It cannot see a write assembled dynamically or
 * one that reaches the column through a helper it does not know by name.
 */

/**
 * Opt-out marker. Must appear inside the write statement, with a reason:
 *   // pen3153-scrub-exempt: <why this write cannot carry unscrubbed material>
 */
const EXEMPT_RE = /pen3153-scrub-exempt:\s*(\S.*)/;

const REPO_SRC_ROOTS = ["server/src", "packages"];

function repoRoot() {
  // .../server/src/__tests__/<this file> -> repo root
  return join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");
}

function walkTypeScriptFiles(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === "dist" || entry === "build" || entry === ".git") continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walkTypeScriptFiles(full, out);
      continue;
    }
    if (!entry.endsWith(".ts") && !entry.endsWith(".tsx")) continue;
    // Test fixtures write rows directly on purpose and are not a production
    // exposure surface.
    if (entry.includes(".test.") || full.includes("__tests__")) continue;
    out.push(full);
  }
  return out;
}

/**
 * Extract the statement text following each `.update(heartbeatRuns)` /
 * `.insert(heartbeatRuns)`, up to the terminator that ends the payload
 * (`.where(`, `.returning(`, `.onConflict(`, `.execute(`) or a blank-line
 * fallback. Deliberately conservative: over-capturing risks a false PASS, so
 * the window stops at the first terminator.
 */
function extractWriteStatements(source: string): Array<{ line: number; text: string }> {
  const lines = source.split("\n");
  const statements: Array<{ line: number; text: string }> = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!/\.(update|insert)\(heartbeatRuns\)/.test(lines[i])) continue;
    const collected: string[] = [lines[i]];
    for (let j = i + 1; j < Math.min(i + 80, lines.length); j += 1) {
      collected.push(lines[j]);
      if (/^\s*\.(where|returning|onConflict|execute)\(/.test(lines[j])) break;
    }
    statements.push({ line: i + 1, text: collected.join("\n") });
  }
  return statements;
}

describe("PEN-3153: every heartbeatRuns resultJson write is scrubbed", () => {
  const root = repoRoot();
  const files = REPO_SRC_ROOTS.flatMap((rel) => walkTypeScriptFiles(join(root, rel)));

  it("finds the source tree it is supposed to be auditing", () => {
    // Guards against the whole check passing vacuously because the path
    // resolution broke — an empty sweep must never read as "all clear".
    expect(files.length).toBeGreaterThan(50);
    const withWrites = files.filter((f) => /\.(update|insert)\(heartbeatRuns\)/.test(readFileSync(f, "utf8")));
    expect(withWrites.length).toBeGreaterThan(0);
  });

  it.each([
    {
      column: "resultJson",
      scrubs: ["sanitizeRunResultJsonForStorage", "redactRunResultJson", "sanitizeRunPatchForStorage"],
      // A `resultJson` literal would be a hand-authored object, not adapter
      // output, but there is no safe literal shape worth carving out here.
      allowLiteral: false,
      fix: "sanitizeRunResultJsonForStorage() / redactRunResultJson()",
    },
    {
      column: "error",
      scrubs: ["sanitizeRunErrorForStorage", "redactRunError", "sanitizeRunPatchForStorage"],
      // `error` is overwhelmingly written as `null` or a hand-authored constant
      // describing why the control plane cancelled a run. Those carry no
      // adapter- or provider-derived text by construction, so requiring a
      // scrub call on them would be noise that trains readers to ignore this
      // guard. Anything NOT a literal must scrub — that is the case that can
      // silently start carrying provider text later.
      allowLiteral: true,
      fix: "sanitizeRunErrorForStorage() / redactRunError()",
    },
  ])("has no unscrubbed $column write", ({ column, scrubs, allowLiteral, fix }) => {
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      if (!source.includes("heartbeatRuns")) continue;
      for (const statement of extractWriteStatements(source)) {
        // Match THIS column's assignment and judge only its own right-hand
        // side. Checking the whole statement for a scrub call would let a
        // write that scrubs `error` vouch for an unscrubbed `resultJson`
        // sitting two lines below it — a half-covered write reading green.
        const assignment = statement.text.match(new RegExp(String.raw`\b${column}\s*:\s*([^\n]*)`));
        const shorthand = new RegExp(String.raw`\b${column}\s*,`).test(statement.text);
        if (!assignment && !shorthand) continue;
        // Capture to end of line, not to the next comma: a multi-line template
        // literal contains commas, and truncating at the first one would drop
        // the scrub call from the captured text and report a false offender.
        const rhs = (assignment?.[1] ?? "").trim().replace(/,\s*$/, "");
        if (scrubs.some((call) => rhs.includes(call))) continue;
        if (allowLiteral && /^(null|"[^"]*"|'[^']*')$/.test(rhs)) continue;
        const exemption = statement.text.match(EXEMPT_RE);
        if (exemption && exemption[1].trim().length > 0) continue;
        // The value may be a variable scrubbed a few lines above the write
        // (`const next = sanitizeRunResultJsonForStorage(...)`). Resolve that
        // ONE indirection by name rather than widening the capture window,
        // which would let an unrelated nearby scrub call mask a real hole.
        const resolved = shorthand && rhs.length === 0 ? column : rhs;
        const identifier = /^[A-Za-z_$][\w$]*$/.test(resolved) ? resolved : null;
        if (
          identifier
          && scrubs.some((call) =>
            new RegExp(String.raw`\b(?:const|let|var)\s+${identifier}\s*=\s*(?:await\s+)?${call}\s*\(`).test(source)
          )
        ) {
          continue;
        }
        offenders.push(`${file.slice(root.length + 1)}:${statement.line}`);
      }
    }
    expect(
      offenders,
      `These heartbeatRuns writes assign \`${column}\` without the PEN-3153 scrub.\n`
        + `Wrap the value in ${fix}, or add\n`
        + "`// pen3153-scrub-exempt: <reason>` inside the statement if it genuinely cannot\n"
        + "carry adapter- or provider-derived text.",
    ).toEqual([]);
  });
});
