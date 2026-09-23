import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

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

const reviewGateEnvNames = [
  "PAPERCLIP_GITHUB_REVIEW_GATE_CAPTURE_ENABLED",
  "PAPERCLIP_GITHUB_REVIEW_GATE_ENABLED",
  "PAPERCLIP_GITHUB_REVIEW_GATE_REPOSITORIES",
  "PAPERCLIP_GITHUB_REVIEW_GATE_EXPECTED_APP_ID",
  "PAPERCLIP_GITHUB_REVIEW_GATE_EXPECTED_INSTALLATION_ID",
];

test("Blockcast rollout keeps review-gate capture and authority disabled", () => {
  for (const template of ["templates/statefulset.yaml", "templates/deployment-api.yaml"]) {
    const extraArgs = template.endsWith("deployment-api.yaml")
      ? ["--set", "api.enabled=true"]
      : [];
    const rendered = render(template, extraArgs);
    for (const name of reviewGateEnvNames) assert.doesNotMatch(rendered, new RegExp(name));
  }
});

test("capture rollout renders durable inbox configuration without authority", () => {
  const rendered = render("templates/deployment-api.yaml", [
    "--set",
    "api.enabled=true",
    "--set",
    "githubApp.reviewGateCaptureEnabled=true",
  ]);

  assert.match(rendered, /- name: PAPERCLIP_GITHUB_REVIEW_GATE_CAPTURE_ENABLED\n\s+value: "true"/);
  assert.doesNotMatch(rendered, /- name: PAPERCLIP_GITHUB_REVIEW_GATE_ENABLED/);
  assert.match(rendered, /strategy:\n\s+type: RollingUpdate/);
  assert.match(
    rendered,
    /- name: PAPERCLIP_GITHUB_REVIEW_GATE_REPOSITORIES\n\s+value: "Blockcast\/penstock-llm-proxy-core"/,
  );
});

test("later authority rollout renders the pinned producer identity", () => {
  const rendered = render("templates/deployment-api.yaml", [
    "--set",
    "api.enabled=true",
    "--set",
    "githubApp.reviewGateCaptureEnabled=true",
    "--set",
    "githubApp.reviewGateEnabled=true",
  ]);

  assert.match(rendered, /- name: PAPERCLIP_GITHUB_REVIEW_GATE_CAPTURE_ENABLED\n\s+value: "true"/);
  assert.match(rendered, /- name: PAPERCLIP_GITHUB_REVIEW_GATE_ENABLED\n\s+value: "true"/);
  assert.match(rendered, /strategy:\n\s+type: RollingUpdate/);
  assert.match(
    rendered,
    /- name: PAPERCLIP_GITHUB_REVIEW_GATE_REPOSITORIES\n\s+value: "Blockcast\/penstock-llm-proxy-core"/,
  );
  assert.match(
    rendered,
    /- name: PAPERCLIP_GITHUB_REVIEW_GATE_EXPECTED_APP_ID\n\s+value: "3966421"/,
  );
  assert.match(
    rendered,
    /- name: PAPERCLIP_GITHUB_REVIEW_GATE_EXPECTED_INSTALLATION_ID\n\s+value: "138085375"/,
  );
});

test("incomplete or out-of-order review-gate enablement fails the Helm render", () => {
  assert.throws(
    () => render("templates/statefulset.yaml", [
      "--set",
      "githubApp.enabled=false",
      "--set",
      "githubApp.reviewGateCaptureEnabled=true",
    ]),
    /reviewGateCaptureEnabled requires githubApp.enabled=true/,
  );
  assert.throws(
    () => render("templates/statefulset.yaml", [
      "--set",
      "githubApp.reviewGateEnabled=true",
    ]),
    /reviewGateEnabled requires githubApp.reviewGateCaptureEnabled=true/,
  );
  assert.throws(
    () => render("templates/statefulset.yaml", [
      "--set",
      "githubApp.reviewGateCaptureEnabled=true",
      "--set-json",
      "githubApp.reviewGateRepositories=[]",
    ]),
    /requires at least one githubApp.reviewGateRepositories entry/,
  );
});
