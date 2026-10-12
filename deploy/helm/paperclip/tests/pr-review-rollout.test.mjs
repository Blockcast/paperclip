import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const VALUES_FILE = "deploy/helm/paperclip/values.blockcast.yaml";
const GUARD_ENTRY =
  '    - name: PAPERCLIP_DISABLE_PR_REVIEW_DUPLICATE_GUARD\n      value: "false"\n';
const VALUE_PATTERN = /- name: PAPERCLIP_DISABLE_PR_REVIEW_DUPLICATE_GUARD\n\s+value: "false"/;
const PRESENCE_PATTERN = /- name: PAPERCLIP_DISABLE_PR_REVIEW_DUPLICATE_GUARD\n/;

function renderApiDeployment(valuesFile = VALUES_FILE) {
  return execFileSync(
    "helm",
    [
      "template",
      "paperclip",
      "deploy/helm/paperclip",
      "--namespace",
      "paperclip",
      "-f",
      valuesFile,
      "--show-only",
      "templates/deployment-api.yaml",
      "--set",
      "api.enabled=true",
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
}

const rendered = renderApiDeployment();

test("Blockcast enables the PR-review duplicate guard now compatibility pods have drained", () => {
  assert.match(rendered, VALUE_PATTERN);
});

// Separate from the value assertion on purpose: the live admission policy pins an
// exact container env-list length, so DELETING the var is inadmissible even though
// an absent var and `"false"` are equivalent to the guard's own parser. Both asserts
// fail if the var is removed (this pattern is a strict prefix of the one above); this
// one additionally pins presence independently of the expected value, so a later
// change to that value cannot silently also drop the var the admission policy
// requires. The next test executes that split against mutated values files.
test("Blockcast keeps the PR-review guard kill switch present in the env list", () => {
  assert.match(rendered, PRESENCE_PATTERN);
});

test("the value and presence asserts split exactly as documented above", () => {
  const source = fs.readFileSync(path.join(repoRoot, VALUES_FILE), "utf8");
  assert.ok(source.includes(GUARD_ENTRY), "guard entry moved in values.blockcast.yaml; update GUARD_ENTRY");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pr-review-rollout-"));
  try {
    const renderMutated = (name, body) => {
      const file = path.join(dir, name);
      fs.writeFileSync(file, body);
      return renderApiDeployment(file);
    };

    // Removal: both asserts fail; there is no removal the value assert misses.
    const removed = renderMutated("removed.yaml", source.replace(GUARD_ENTRY, ""));
    assert.doesNotMatch(removed, VALUE_PATTERN);
    assert.doesNotMatch(removed, PRESENCE_PATTERN);

    // Value rollback: only the value assert fails; presence still holds.
    const rolledBack = renderMutated(
      "rolled-back.yaml",
      source.replace(GUARD_ENTRY, GUARD_ENTRY.replace('"false"', '"true"')),
    );
    assert.doesNotMatch(rolledBack, VALUE_PATTERN);
    assert.match(rolledBack, PRESENCE_PATTERN);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
