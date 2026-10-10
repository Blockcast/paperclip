import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

function renderApiDeployment() {
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
      "--show-only",
      "templates/deployment-api.yaml",
      "--set",
      "api.enabled=true",
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
}

test("Blockcast enables the PR-review duplicate guard now compatibility pods have drained", () => {
  const rendered = renderApiDeployment();

  assert.match(
    rendered,
    /- name: PAPERCLIP_DISABLE_PR_REVIEW_DUPLICATE_GUARD\n\s+value: "false"/,
  );
});

// Separate from the value assertion on purpose: the live admission policy pins an
// exact container env-list length, so DELETING the var is inadmissible even though
// an absent var and `"false"` are equivalent to the guard's own parser. This assert
// fails on removal while the one above passes, and vice versa on a wrong value.
test("Blockcast keeps the PR-review guard kill switch present in the env list", () => {
  assert.match(renderApiDeployment(), /- name: PAPERCLIP_DISABLE_PR_REVIEW_DUPLICATE_GUARD\n/);
});
