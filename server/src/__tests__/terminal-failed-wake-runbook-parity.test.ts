// BLO-35668: `KNOWN_TERMINAL_FAILED_WAKE_ERROR_CODES` and the Step 2 action
// table in `runbooks/agent-wakeup-terminal-failed.md` are two halves of one
// contract, and until now nothing held them together — the set's own doc
// comment said so in as many words ("Nothing asserts the two match — the drift
// is silent").
//
// Both directions of the drift are operator-visible and neither fails loudly:
//
//   - a code in the set with no runbook row pages an operator with a label the
//     runbook does not explain, AND removes it from the `other` escape hatch
//     that would otherwise have told them what to do;
//   - a runbook row for a code not in the set is an instruction for a label the
//     gauge can never emit, because an unlisted code collapses to `other`.
//
// The instance that produced this test is the first kind:
// `skill_materialization_pending` (BLO-32055 / #1669) renamed `adapter_failed`
// at the claude-k8s skill-source emit site and was enrolled at neither place.
//
// Deliberately a pure text test: no DB, no metrics registry. It reads the two
// artifacts and compares sets, which is the whole invariant.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  KNOWN_TERMINAL_FAILED_WAKE_ERROR_CODES,
  TERMINAL_FAILED_WAKE_ERROR_CODE_NONE,
  UNKNOWN_TERMINAL_FAILED_WAKE_ERROR_CODE,
} from "../services/metrics.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const RUNBOOK_PATH = "runbooks/agent-wakeup-terminal-failed.md";

// Anchored on the table's own header row rather than on a heading or a line
// number: the header is the most stable unique token here, and its COUNT is
// asserted below so a reshape that duplicates or removes the table fails
// rather than silently parsing a different one.
const TABLE_HEADER = "| `error_code` | what happened | usual action |";

function readRunbookStep2Codes(markdown: string): string[] {
  const headerCount = markdown.split(TABLE_HEADER).length - 1;
  expect(
    headerCount,
    `${RUNBOOK_PATH}: expected exactly one Step 2 action table keyed on ${TABLE_HEADER}`,
  ).toBe(1);

  // Leading newlines are stripped so the loop starts ON the separator row.
  // Without this the first split element is "" and the loop breaks before
  // reading a single row — caught by the parser control below, which is the
  // whole reason that control is here.
  const body = markdown
    .slice(markdown.indexOf(TABLE_HEADER) + TABLE_HEADER.length)
    .replace(/^\n+/, "");
  const codes: string[] = [];
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) break; // table ends at the first non-row line
    const firstCell = trimmed.split("|")[1]?.trim() ?? "";
    if (/^-+$/.test(firstCell)) continue; // the |---|---|---| separator
    // One cell can carry several codes, e.g. "`adapter_failed` / `process_lost`".
    for (const match of firstCell.matchAll(/`([a-z0-9_]+)`/g)) codes.push(match[1]);
  }
  return codes;
}

describe("BLO-35668: terminal-failed wake error codes match their runbook rows", () => {
  const markdown = readFileSync(resolve(REPO_ROOT, RUNBOOK_PATH), "utf8");
  const runbookCodes = readRunbookStep2Codes(markdown);

  it("documents every label the gauge can emit, and no label it cannot", () => {
    // `other` and `none` are emitted labels too, and the runbook rows for them
    // are what make the escape hatch usable — so they belong in the comparison
    // rather than being excused from it.
    const emitted = [
      ...KNOWN_TERMINAL_FAILED_WAKE_ERROR_CODES,
      UNKNOWN_TERMINAL_FAILED_WAKE_ERROR_CODE,
      TERMINAL_FAILED_WAKE_ERROR_CODE_NONE,
    ].sort();

    expect(
      [...runbookCodes].sort(),
      `${RUNBOOK_PATH} Step 2 and KNOWN_TERMINAL_FAILED_WAKE_ERROR_CODES have drifted. ` +
        "A code in the set with no row pages an operator with no instruction; " +
        "a row with no code documents a label the gauge cannot emit.",
    ).toEqual(emitted);
  });

  it("lists each code exactly once", () => {
    const duplicates = runbookCodes.filter((code, i) => runbookCodes.indexOf(code) !== i);
    expect(duplicates, `${RUNBOOK_PATH}: duplicate Step 2 rows`).toEqual([]);
  });

  // Negative control for the parser itself. Without it the test above passes
  // vacuously the day someone reshapes the table into prose and both sides
  // parse to nothing — the exact silent-drift shape this file exists to kill.
  it("actually parses rows (parser is not returning an empty set)", () => {
    expect(runbookCodes.length).toBeGreaterThan(5);
    expect(runbookCodes).toContain("adapter_failed");
    expect(runbookCodes).toContain("process_lost");
  });
});
