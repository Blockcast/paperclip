import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

function render(template, extraArgs = []) {
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
      template,
      ...extraArgs,
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
}

// `env.extra` feeds both tiers; render each once and pin both against a future split.
const tiers = {
  api: render("templates/deployment-api.yaml", ["--set", "api.enabled=true"]),
  workers: render("templates/statefulset.yaml"),
};

for (const [tier, rendered] of Object.entries(tiers)) {
  test(`Blockcast enables the PR-review duplicate guard (${tier} tier)`, () => {
    assert.match(
      rendered,
      /- name: PAPERCLIP_DISABLE_PR_REVIEW_DUPLICATE_GUARD\n\s+value: "false"/,
    );
  });

  // Both asserts fail if the var is removed. This one additionally pins presence
  // independently of the expected value, so a later change to that value cannot
  // silently drop the var: the live admission policy pins an exact container
  // env-list length, so DELETING it is inadmissible even though an absent var and
  // `"false"` are equivalent to the guard's own parser.
  test(`Blockcast keeps the PR-review guard kill switch present (${tier} tier)`, () => {
    assert.match(rendered, /- name: PAPERCLIP_DISABLE_PR_REVIEW_DUPLICATE_GUARD\n/);
  });
}
