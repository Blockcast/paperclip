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


// PEN-2073 step 3 taken 2026-10-04 (BLO-38934): capture is ON in
// values.blockcast.yaml, the authority is still OFF. Capture-only performs a
// database insert and makes no GitHub call, so this asserts the live rollout
// state rather than the pre-step-3 "both off".
test("Blockcast rollout captures deliveries with the authority still disabled", () => {
  for (const template of ["templates/statefulset.yaml", "templates/deployment-api.yaml"]) {
    const extraArgs = template.endsWith("deployment-api.yaml")
      ? ["--set", "api.enabled=true"]
      : [];
    const rendered = render(template, extraArgs);
    assert.match(
      rendered,
      /- name: PAPERCLIP_GITHUB_REVIEW_GATE_CAPTURE_ENABLED\n\s+value: "true"/,
    );
    // The step-5 flag. Nothing in this repo writes a GitHub status until it is set.
    assert.doesNotMatch(rendered, /- name: PAPERCLIP_GITHUB_REVIEW_GATE_ENABLED/);
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
      // Explicit: capture is true in values.blockcast.yaml since step 3, so the
      // out-of-order case has to turn it back off to be the out-of-order case.
      "--set",
      "githubApp.reviewGateCaptureEnabled=false",
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
  assert.throws(
    () => render("templates/statefulset.yaml", [
      "--set",
      "githubApp.reviewGateCaptureEnabled=true",
      "--set",
      "githubApp.reviewGateExpectedAppId=not-a-number",
    ]),
    /requires a numeric githubApp.reviewGateExpectedAppId/,
  );
  assert.throws(
    () => render("templates/statefulset.yaml", [
      "--set",
      "githubApp.reviewGateCaptureEnabled=true",
      "--set",
      "githubApp.reviewGateExpectedInstallationId=not-a-number",
    ]),
    /requires a numeric githubApp.reviewGateExpectedInstallationId/,
  );
  // config.ts throws on a missing GITHUB_WEBHOOK_SECRET when capture is on, and
  // the chart binds it from env.extra rather than from the githubApp block — so
  // the guard has to read the place the value actually comes from.
  assert.throws(
    () => render("templates/statefulset.yaml", [
      "--set",
      "githubApp.reviewGateCaptureEnabled=true",
      "--set-json",
      "env.extra=[]",
    ]),
    /requires a GITHUB_WEBHOOK_SECRET entry in env\.extra/,
  );
});
