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

// BLO-33279. The launcher's readiness budget defaults to 15000 ms, but measured
// Caveman cold starts reach 11548 ms under concurrency — a 1.3x margin, and the
// retry loop covers only EADDRINUSE, so a readiness timeout kills the run on
// attempt 1. The override lives in worker.extraEnv because the claude_k8s
// adapter copies the worker container's literal env into every agent Job via
// selfPod.inheritedEnv; that is what makes one committed line a fleet-wide
// default instead of N hand-edited adapterConfig records.
const LAUNCHER_DEFAULT_READY_TIMEOUT_MS = 15_000;
const LAUNCHER_MAX_READY_TIMEOUT_MS = 300_000;

test("worker exports an inheritable Caveman readiness budget above the launcher default", () => {
  const rendered = render("templates/statefulset.yaml");
  const match = rendered.match(/- name: PENSTOCK_READY_TIMEOUT_MS\s+value: "(\d+)"/);

  // A literal value, not valueFrom: the adapter only reaches inheritedEnv for
  // literals, and this is a tunable rather than a credential.
  assert.ok(match, "worker must export PENSTOCK_READY_TIMEOUT_MS as a quoted literal");

  // The launcher's positiveInteger() silently falls back to the 15000 ms default
  // on anything unparseable or out of range. That failure is invisible — the
  // manifest still renders the typo — so assert the bounds the launcher applies
  // rather than merely that the name is present.
  const budgetMs = Number(match[1]);
  assert.ok(
    budgetMs > LAUNCHER_DEFAULT_READY_TIMEOUT_MS,
    `budget ${budgetMs}ms must exceed the ${LAUNCHER_DEFAULT_READY_TIMEOUT_MS}ms default it exists to raise`,
  );
  assert.ok(
    budgetMs <= LAUNCHER_MAX_READY_TIMEOUT_MS,
    `budget ${budgetMs}ms exceeds the launcher cap of ${LAUNCHER_MAX_READY_TIMEOUT_MS}ms and would be ignored`,
  );
});

test("API Deployment does not receive the worker-only readiness budget", () => {
  const rendered = render("templates/deployment-api.yaml", [
    "--set",
    "api.enabled=true",
    "--set",
    "persistence.existingClaim=paperclip-shared",
  ]);
  assert.doesNotMatch(rendered, /PENSTOCK_READY_TIMEOUT_MS/);
});
