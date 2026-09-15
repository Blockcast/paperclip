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

/** The `value:` line that follows each occurrence of the env name. */
function values(rendered) {
  const lines = rendered.split("\n");
  return lines.flatMap((line, i) =>
    line.includes(`name: ${ENV}`) ? [lines[i + 1].trim()] : [],
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
