import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

function render(template) {
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
      `templates/${template}`,
      "--set",
      "api.enabled=true",
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
}

function allowlistOf(manifest) {
  const match = manifest.match(
    /name: PAPERCLIP_OPENCODE_MODEL_ALLOWLIST\s+value: "?([^"\n]+)"?/,
  );
  assert.ok(match, "manifest does not set PAPERCLIP_OPENCODE_MODEL_ALLOWLIST");
  return match[1].split(",").map((id) => id.trim());
}

// The adapter's own list is what the picker shows before the allowlist filters it, so an
// allowlisted id that is missing here is one an agent can never select.
function adapterModelIds() {
  const source = readFileSync(
    path.join(repoRoot, "vendor/paperclip-adapter-opencode-k8s/src/server/models.ts"),
    "utf8",
  );
  const block = source.slice(
    source.indexOf("STATIC_MODELS"),
    source.indexOf("];", source.indexOf("STATIC_MODELS")),
  );
  return new Set([...block.matchAll(/id: "([^"]+)"/g)].map((m) => m[1]));
}

for (const template of ["statefulset.yaml", "deployment-api.yaml"]) {
  test(`${template} lets agents pick GPT-6.2 Sol and Astra`, () => {
    const ids = allowlistOf(render(template));
    assert.ok(ids.includes("openai/gpt-6.2-sol"), "openai/gpt-6.2-sol is not allowlisted");
    assert.ok(ids.includes("openai/gpt-6.2-astra"), "openai/gpt-6.2-astra is not allowlisted");
  });

  test(`${template} allowlists no duplicate and no id the adapter does not offer`, () => {
    const ids = allowlistOf(render(template));
    assert.equal(new Set(ids).size, ids.length, `duplicate in allowlist: ${ids.join(",")}`);
    const offered = adapterModelIds();
    assert.ok(offered.size > 0, "parsed no ids from the adapter's STATIC_MODELS");
    for (const id of ids) {
      assert.ok(offered.has(id), `${id} is allowlisted but the opencode_k8s adapter does not offer it`);
    }
  });
}
