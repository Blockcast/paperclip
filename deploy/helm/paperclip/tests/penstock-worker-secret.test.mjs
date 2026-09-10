import { execFileSync, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { test } from "node:test";

const repoRoot = new URL("../../../..", import.meta.url).pathname;
const chartDir = "deploy/helm/paperclip";
const blockcastValues = `${chartDir}/values.blockcast.yaml`;

function render(template, extraArgs = []) {
  return execFileSync(
    "helm",
    [
      "template",
      "paperclip",
      chartDir,
      "--namespace",
      "paperclip",
      "-f",
      blockcastValues,
      ...extraArgs,
      "--show-only",
      template,
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
}

function renderExpectingFailure(extraArgs) {
  const result = spawnSync(
    "helm",
    [
      "template",
      "paperclip",
      chartDir,
      "--namespace",
      "paperclip",
      ...extraArgs.flatMap((entry) => ["--set", entry]),
      "--show-only",
      "templates/statefulset.yaml",
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
  assert.notEqual(result.status, 0, "expected Helm rendering to fail closed");
  return result.stderr;
}

test("worker StatefulSet receives the required Penstock Secret reference", () => {
  const rendered = render("templates/statefulset.yaml");
  const match = rendered.match(
    /- name: PENSTOCK_API_KEY\s+valueFrom:\s+secretKeyRef:\s+key: token\s+name: paperclip-penstock-org-key/s,
  );
  assert.ok(match, "worker must bind PENSTOCK_API_KEY from paperclip-penstock-org-key/token");
  assert.doesNotMatch(rendered, /- name: PENSTOCK_API_KEY\s+value:/);
});

test("API Deployment does not receive the worker-only Penstock key", () => {
  const rendered = render("templates/deployment-api.yaml", [
    "--set",
    "api.enabled=true",
    "--set",
    "persistence.existingClaim=paperclip-shared",
  ]);
  assert.doesNotMatch(rendered, /PENSTOCK_API_KEY/);
});

test("shared env.extra rejects the Penstock key instead of exposing it to API pods", () => {
  const stderr = renderExpectingFailure([
    "env.extra[0].name=PENSTOCK_API_KEY",
    "env.extra[0].value=unexpected",
  ]);
  assert.match(stderr, /env\.extra must not define PENSTOCK_API_KEY/);
});

test("worker Penstock key rejects a literal value", () => {
  const stderr = renderExpectingFailure([
    "worker.extraEnv[0].name=PENSTOCK_API_KEY",
    "worker.extraEnv[0].value=unexpected",
  ]);
  assert.match(stderr, /worker\.extraEnv PENSTOCK_API_KEY must use valueFrom\.secretKeyRef/);
});

test("worker Penstock key requires a Secret name and key", () => {
  const missingName = renderExpectingFailure([
    "worker.extraEnv[0].name=PENSTOCK_API_KEY",
    "worker.extraEnv[0].valueFrom.secretKeyRef.key=token",
  ]);
  assert.match(missingName, /requires valueFrom\.secretKeyRef\.name/);

  const missingKey = renderExpectingFailure([
    "worker.extraEnv[0].name=PENSTOCK_API_KEY",
    "worker.extraEnv[0].valueFrom.secretKeyRef.name=paperclip-penstock-org-key",
  ]);
  assert.match(missingKey, /requires valueFrom\.secretKeyRef\.key/);
});
