// PEN-4282: hold the k8s-ro coverage register and its documentation in step.
//
// `packages/mcp-gateway/src/k8s-ro-coverage.test.ts` is the executable register
// of what the k8s-ro response scrubber removes from each tool's output.
// `docs/AGENT-VISIBLE-CONFIG-EGRESS.md` §1 is the human-readable table of the
// same thing — and it is the one people actually read. This asserts the two
// name the same set of tools, so neither can be updated alone: a tool added to
// the register without a doc row, or a doc row added without a coverage
// decision, is a red build rather than a silent divergence.
//
// WHY THIS LIVES HERE AND NOT IN THE VITEST SUITE
//
// It was written there first, as a `readFileSync` of the doc. That broke
// `select-ci-suites.test.mjs`'s "a prose-only diff skips every suite" invariant:
// the selector resolves file references, so a vitest suite that reads `docs/…`
// makes editing that doc *select* the suite, and a typo fix starts paying for a
// test run. That invariant is a real CI-cost property of this repo and the fix
// is not to weaken it.
//
// The `policy` job runs unconditionally, carries no suite selection, and already
// hosts this family of `node --test` cross-artifact checks. A string comparison
// between two files belongs in exactly that lane — it costs milliseconds and
// never needs to be selected. Only the *behavioural* assertions (pushing bodies
// through the real scrubber) need the vitest suite.
//
// ⚠️ Both sides are parsed out of files rather than imported, because this lane
// has no TypeScript toolchain. Each parser throws with a pointer rather than
// returning an empty set when its anchor moves: an extractor that silently
// yields `[]` would make this assert `[] === []` and pass while checking
// nothing, which is the shape of failure this whole ticket is about.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const registerPath = path.join(repoRoot, "packages/mcp-gateway/src/k8s-ro-coverage.test.ts");
const docPath = path.join(repoRoot, "docs/AGENT-VISIBLE-CONFIG-EGRESS.md");

const DOC_TABLE_HEADER = "| tool | returns | verdict |";

/** The `K8S_RO_TOOLS` array literal in the register. */
function toolsInRegister() {
  const source = readFileSync(registerPath, "utf8");
  const match = source.match(/const K8S_RO_TOOLS:[^=]*=\s*\[([\s\S]*?)\]/);
  if (!match) {
    throw new Error(
      `Could not find the K8S_RO_TOOLS array in ${registerPath}. If it was renamed or ` +
        "reshaped, point this check at its new form rather than deleting it — PEN-4282 " +
        "exists because this classification could not fail.",
    );
  }
  const tools = [...match[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
  assert.ok(tools.length > 0, "K8S_RO_TOOLS parsed to an empty list; the extractor is broken, not the register");
  return tools;
}

/** Tool names in the first column of the k8s-ro coverage table in the doc. */
function toolsInDoc() {
  const doc = readFileSync(docPath, "utf8");
  const tableAt = doc.indexOf(DOC_TABLE_HEADER);
  if (tableAt < 0) {
    throw new Error(
      `Could not find the k8s-ro coverage table (${DOC_TABLE_HEADER}) in ${docPath}. ` +
        "If it moved, point this check at its new home rather than deleting the assertion.",
    );
  }
  const rest = doc.slice(tableAt);
  const end = rest.indexOf("\n\n");
  const table = end < 0 ? rest : rest.slice(0, end);

  const tools = new Set();
  // `.slice(2)` drops the header row and the `|---|` separator.
  for (const line of table.split("\n").slice(2)) {
    const firstCell = line.split("|")[1];
    if (!firstCell) continue;
    for (const m of firstCell.matchAll(/`([a-z_]+)`/g)) tools.add(m[1]);
  }
  assert.ok(tools.size > 0, "the doc table parsed to an empty tool set; the extractor is broken, not the doc");
  return [...tools];
}

test("the k8s-ro coverage register and its doc table name the same tools", () => {
  assert.deepEqual(
    toolsInDoc().sort(),
    toolsInRegister().sort(),
    "docs/AGENT-VISIBLE-CONFIG-EGRESS.md §1 and K8S_RO_TOOLS disagree. Add the tool to BOTH — " +
      "a tool in the doc with no coverage decision, or a decision nobody can read, is the " +
      "PEN-4282 gap reopening.",
  );
});

test("both extractors fail loudly rather than returning an empty set", () => {
  // The assertion above compares two parsed sets, so a parser that quietly
  // yielded `[]` on both sides would pass while checking nothing. Pin that each
  // one throws on a missing anchor instead.
  for (const [name, fn] of [
    ["register", () => readFileSync(registerPath, "utf8")],
    ["doc", () => readFileSync(docPath, "utf8")],
  ]) {
    assert.ok(fn().length > 0, `${name} source is empty`);
  }
  assert.ok(toolsInRegister().includes("pods_log"), "register lost a known tool");
  assert.ok(toolsInDoc().includes("pods_log"), "doc table lost a known tool");
});
