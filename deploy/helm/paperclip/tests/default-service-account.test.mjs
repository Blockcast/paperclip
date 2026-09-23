import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

function renderStatefulSet(extraArgs = []) {
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
      "templates/statefulset.yaml",
      ...extraArgs,
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
}

function renderApiDeployment(extraArgs = []) {
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
      ...extraArgs,
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
}

test("PAPERCLIP_DEFAULT_SERVICE_ACCOUNT_NAME renders on both api and workers containers", () => {
  const renderedStatefulSet = renderStatefulSet();
  const renderedApiDeployment = renderApiDeployment();

  for (const rendered of [renderedStatefulSet, renderedApiDeployment]) {
    assert.match(
      rendered,
      /- name: PAPERCLIP_DEFAULT_SERVICE_ACCOUNT_NAME\n\s+value: ["']?paperclip["']?/,
      "fleet default ServiceAccount env var should render for the claude_k8s adapter's resolveServiceAccountName() fallback",
    );
  }
});

test("PAPERCLIP_DEFAULT_SERVICE_ACCOUNT_NAME does not change the pods' own ServiceAccount", () => {
  // This env var is read by the claude_k8s adapter when it builds an agent
  // Job manifest -- it must not be confused with (or change) the paperclip
  // api/workers pods' own serviceAccountName, which is set independently via
  // the `paperclip.serviceAccountName` helper.
  const renderedStatefulSet = renderStatefulSet();
  const renderedApiDeployment = renderApiDeployment();

  for (const rendered of [renderedStatefulSet, renderedApiDeployment]) {
    assert.match(
      rendered,
      /\n\s+serviceAccountName: paperclip\n/,
      "pod-level serviceAccountName should remain the chart's own service account",
    );
  }
});
