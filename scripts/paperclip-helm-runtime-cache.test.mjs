import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

const chart = "deploy/helm/paperclip";
const values = "deploy/helm/paperclip/values.blockcast.yaml";

function render(...args) {
  return execFileSync(
    "helm",
    [
      "template",
      "paperclip",
      chart,
      "--namespace",
      "paperclip",
      "-f",
      values,
      "--show-only",
      "templates/statefulset.yaml",
      ...args,
    ],
    { encoding: "utf8" },
  );
}

test("paperclip StatefulSet routes regenerable caches to runtime emptyDir", () => {
  const output = render();

  for (const [name, value] of [
    ["XDG_CACHE_HOME", "/runtime-cache/xdg"],
    ["GOCACHE", "/runtime-cache/go-build"],
    ["GOMODCACHE", "/runtime-cache/gomod"],
    ["npm_config_cache", "/runtime-cache/npm"],
    ["BUN_INSTALL_CACHE", "/runtime-cache/bun"],
    ["PIP_CACHE_DIR", "/runtime-cache/pip"],
    ["PLAYWRIGHT_BROWSERS_PATH", "/runtime-cache/ms-playwright"],
  ]) {
    assert.match(output, new RegExp(`name: ${name}\\n\\s+value: "?${value}"?`));
  }

  assert.match(output, /name: runtime-cache\n\s+mountPath: "?\/runtime-cache"?/);
  assert.match(output, /name: runtime-cache\n\s+emptyDir:\n\s+sizeLimit: "20Gi"/);
  assert.match(output, /name: data\n\s+mountPath: \/paperclip/);
});

test("runtime cache can be disabled for rollback", () => {
  const output = render("--set", "runtimeCache.enabled=false");

  assert.doesNotMatch(output, /name: runtime-cache/);
  assert.doesNotMatch(output, /XDG_CACHE_HOME/);
  assert.match(output, /name: data\n\s+mountPath: \/paperclip/);
});
