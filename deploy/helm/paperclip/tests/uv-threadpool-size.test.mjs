import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

// BLO-54721: the worker runs with a larger libuv threadpool, and the api
// Deployment must not get it, because its admission policy rejects
// non-PAPERCLIP_ env names that are not on its allowlist.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

function render(template) {
  return execFileSync(
    "helm",
    ["template", "paperclip", "deploy/helm/paperclip", "--namespace", "paperclip",
      "-f", "deploy/helm/paperclip/values.blockcast.yaml", "--show-only", template],
    { cwd: repoRoot, encoding: "utf8" },
  );
}

test("worker StatefulSet sets UV_THREADPOOL_SIZE=16", () => {
  assert.match(render("templates/statefulset.yaml"), /- name: UV_THREADPOOL_SIZE\n\s+value: "16"/);
});

test("api Deployment does not carry UV_THREADPOOL_SIZE", () => {
  assert.doesNotMatch(render("templates/deployment-api.yaml"), /UV_THREADPOOL_SIZE/);
});
