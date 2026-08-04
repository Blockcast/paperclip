import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

function renderApi(extraArgs = []) {
  return execFileSync(
    "helm",
    [
      "template",
      "paperclip",
      "deploy/helm/paperclip",
      "--namespace",
      "paperclip",
      "--show-only",
      "templates/deployment-api.yaml",
      "--set",
      "api.enabled=true",
      "--set",
      "persistence.existingClaim=paperclip-data",
      ...extraArgs,
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
}

test("API node spreading remains soft by default", () => {
  const rendered = renderApi();

  assert.match(rendered, /preferredDuringSchedulingIgnoredDuringExecution:/);
  assert.doesNotMatch(rendered, /requiredDuringSchedulingIgnoredDuringExecution:/);
});

test("required API separation does not depend on soft spreading", () => {
  const rendered = renderApi([
    "--set",
    "api.spreadAcrossNodes=false",
    "--set",
    "api.requireDifferentNodes=true",
  ]);

  assert.match(rendered, /requiredDuringSchedulingIgnoredDuringExecution:/);
  assert.doesNotMatch(rendered, /preferredDuringSchedulingIgnoredDuringExecution:/);
});

test("Blockcast API replicas require distinct hostnames", () => {
  const rendered = execFileSync(
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
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );

  assert.match(rendered, /requiredDuringSchedulingIgnoredDuringExecution:/);
  assert.match(rendered, /topologyKey: kubernetes\.io\/hostname/);
  assert.doesNotMatch(rendered, /preferredDuringSchedulingIgnoredDuringExecution:/);
});
