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

test("Blockcast defers the PR-review duplicate guard until compatibility pods drain", () => {
  const rendered = renderApiDeployment();

  assert.match(
    rendered,
    /- name: PAPERCLIP_DISABLE_PR_REVIEW_DUPLICATE_GUARD\n\s+value: "true"/,
  );
});
