import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
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

// BLO-33279, second half. Rendering the value onto the worker is necessary and
// NOT sufficient: the claude_k8s adapter filters every inherited literal
// through AGENT_ENV_ALLOWLIST (BLO-22514, k8s-client.ts), so a worker.extraEnv
// literal whose name is not listed there reaches no agent pod at all. That is
// how PENSTOCK_READY_TIMEOUT_MS shipped green on 2026-09-12 and changed
// nothing — the test above passed, the sts carried the value, and every agent
// Job still ran the 15000 ms default. The runbook asserted "there is no name
// allowlist", which had been false since BLO-22514.
//
// ponytail: text-scrape of the allowlist rather than importing it — the module
// is TypeScript in a vendored package and this is a dependency-free node:test
// file. Upgrade to a real import if these tests ever gain a TS pipeline.
test("every literal worker.extraEnv name is inheritable by agent Jobs", () => {
  const values = readFileSync(`${repoRoot}/${blockcastValues}`, "utf8");
  const workerBlock = values.match(/^worker:\n((?:[ \t].*\n|\n)*)/m)?.[1];
  assert.ok(workerBlock, "worker: block not found in values.blockcast.yaml");

  // Literals only. valueFrom entries travel a separate path.
  const literals = [...workerBlock.matchAll(/- name: (\S+)\n\s+value:/g)].map((m) => m[1]);
  assert.ok(literals.length > 0, "expected at least one literal in worker.extraEnv");

  const allowlistSrc = readFileSync(
    `${repoRoot}/vendor/paperclip-adapter-claude-k8s/src/server/inherit-allowlist.ts`,
    "utf8",
  );
  const exactNames = allowlistSrc.match(/AGENT_ENV_ALLOWLIST[\s\S]*?\n\]\);/)?.[0];
  const prefixes = allowlistSrc.match(/AGENT_ENV_ALLOWED_PREFIXES[\s\S]*?\n\];/)?.[0];
  assert.ok(exactNames && prefixes, "could not locate the adapter allowlist declarations");

  for (const name of literals) {
    const inheritable =
      exactNames.includes(`"${name}"`) ||
      [...prefixes.matchAll(/"([A-Z_]+_)"/g)].some((m) => name.startsWith(m[1]));
    assert.ok(
      inheritable,
      `worker.extraEnv sets ${name}, but AGENT_ENV_ALLOWLIST does not admit it — ` +
        `the adapter will drop it and no agent pod will ever see the value`,
    );
  }
});
