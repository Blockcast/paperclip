import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

const ENV = "PAPERCLIP_EVIDENCE_UNLABELED_BLOCK";

function render(extraArgs = []) {
  return execFileSync(
    "helm",
    [
      "template",
      "paperclip",
      "deploy/helm/paperclip",
      "--namespace",
      "paperclip",
      "-f",
      "deploy/helm/paperclip/values.blockcast.yaml",
      ...extraArgs,
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
}

/**
 * The `value:` line that follows each occurrence of the env name.
 *
 * Anchored, not `includes`: a future `PAPERCLIP_EVIDENCE_UNLABELED_BLOCK_MODE`
 * would otherwise be counted as this flag and break the exactly-two assertion
 * for a reason that has nothing to do with the flag. And `?? ""` keeps a name
 * on the last rendered line a clean assertion failure rather than a TypeError.
 */
function values(rendered) {
  const lines = rendered.split("\n");
  return lines.flatMap((line, i) =>
    line.trim() === `- name: ${ENV}` || line.trim() === `name: ${ENV}`
      ? [(lines[i + 1] ?? "").trim()]
      : [],
  );
}

test("both workloads carry the flag, defaulted off", () => {
  // Exactly two: the API Deployment and the worker StatefulSet. The evidence
  // gate runs in the API, the landing/scorecard consumers in the workers, so a
  // one-sided render would give the two tiers different verdicts.
  assert.deepEqual(values(render()), ['value: "0"', 'value: "0"']);
});

test("the flip is a values change, not a template change", () => {
  const flipped = values(render(["--set", "evidenceGate.unlabeledTruthBlock=1"]));
  assert.deepEqual(flipped, ['value: "1"', 'value: "1"']);
});

test("an absent evidenceGate block still renders the flag off", () => {
  // `((.Values.evidenceGate).unlabeledTruthBlock)` must be nil-safe: a values
  // file predating this key must not fail the render or emit an empty value,
  // which the server would read as unset rather than as explicitly off.
  const rendered = render(["--set", "evidenceGate=null"]);
  assert.deepEqual(values(rendered), ['value: "0"', 'value: "0"']);
});

test("an unquoted YAML bool fails the render instead of silently reading as off", () => {
  // `unlabeledTruthBlock: true` renders "true", and the server reads the var as
  // `=== "1"` — so without this guard the flip appears to have happened and the
  // gate stays off, which is indistinguishable from a quiet week of measurement.
  assert.throws(
    () => render(["--set", "evidenceGate.unlabeledTruthBlock=true"]),
    /must be the string "0" or "1"/,
  );
});

test("the guard is an allow-list, not a bool-specific check", () => {
  // `2` is neither a bool nor a recognised value. Pinning a non-bool string
  // keeps the guard honest: a future edit that special-cases "true"/"false"
  // instead of validating against the list would pass the test above and let
  // this through as a quoted "2" the server reads as off.
  assert.throws(
    () => render(["--set", "evidenceGate.unlabeledTruthBlock=2"]),
    /must be the string "0" or "1"/,
  );
});

test("false is rejected as loudly as true", () => {
  // Defaulting before validating made `false` collapse to "0" silently while
  // `true` failed — one unquoted bool loud, the other silent. Both are now
  // the same class of mistake and both say so.
  assert.throws(
    () => render(["--set", "evidenceGate.unlabeledTruthBlock=false"]),
    /must be the string "0" or "1"/,
  );
});
