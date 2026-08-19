// BLO-29008 — the worker tier's deployed-commit stamp.
//
// `paperclip` runs two tiers off one image: `deployment/paperclip-api`
// (PAPERCLIP_NODE_ROLE=api, HTTP only, no scheduler) and
// `statefulset/paperclip` (PAPERCLIP_NODE_ROLE=worker, the singleton that
// drives heartbeat dispatch and hosts the plugin workers).
//
// Until this stamp existed the worker carried NO build annotation at all, so
// there was no assertable signal for what commit the heartbeat-dispatch tier
// was running. In BLO-28920 the api reached the fix commit while the worker sat
// on a 32h-old image; the stated acceptance criterion ("paperclip-api
// deployed-commit is at or past X") was satisfied the entire time, the deploy
// path reported success, and the bug stayed 100% live at 41 failures/hr.
//
// These tests pin two things:
//
//   1. `worker.deployedCommit` renders onto the WORKER pod template, with the
//      same reserved-key guard and 40-hex validation as `api.deployedCommit`.
//   2. Setting it does not perturb the API render. That is not cosmetic: the
//      release job hashes the unstamped API Deployment to produce
//      `paperclip.blockcast.net/approval-plan-sha256`, and
//      approve-paperclip-api-digest.sh recomputes that hash from the stamped
//      render. If a worker-only value moved the API render by even one byte,
//      every production release would die at the approval gate. Test 2 is the
//      guard that lets the worker stamp be added without touching that path.
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

const DEPLOYED_COMMIT = "paperclip.blockcast.net/deployed-commit";
const SAMPLE_COMMIT = "0123456789abcdef0123456789abcdef01234567";
const OTHER_COMMIT = "fedcba9876543210fedcba9876543210fedcba98";

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
      `templates/${template}`,
      ...extraArgs,
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
}

function renderFails(template, extraArgs) {
  try {
    render(template, extraArgs);
  } catch (error) {
    return `${error.stdout ?? ""}${error.stderr ?? ""}`;
  }
  throw new Error("expected helm template to fail, but it succeeded");
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

test("worker.deployedCommit stamps the worker pod template", () => {
  const rendered = render("statefulset.yaml", [
    "--set-string",
    `worker.deployedCommit=${SAMPLE_COMMIT}`,
  ]);
  assert.match(
    rendered,
    new RegExp(`${DEPLOYED_COMMIT.replace(/\./g, "\\.")}: ${SAMPLE_COMMIT}`),
    "worker pod template must carry the deployed-commit annotation",
  );
});

test("unset worker.deployedCommit renders no annotation", () => {
  const rendered = render("statefulset.yaml");
  assert.ok(
    !rendered.includes(DEPLOYED_COMMIT),
    "local and non-Blockcast renders must not gain a deployed-commit annotation",
  );
});

test("worker.deployedCommit is the ONLY thing the stamp changes in the worker render", () => {
  // Same reasoning as the API marker invariant: confine the stamp to one merged
  // key so the two tiers' values can be compared directly by the deploy job.
  const unstamped = render("statefulset.yaml");
  const stamped = render("statefulset.yaml", [
    "--set-string",
    `worker.deployedCommit=${SAMPLE_COMMIT}`,
  ]);
  const added = stamped
    .split("\n")
    .filter((line) => !unstamped.split("\n").includes(line));
  assert.deepEqual(
    added.map((line) => line.trim()),
    ["annotations:", `${DEPLOYED_COMMIT}: ${SAMPLE_COMMIT}`],
    "stamping the worker must add exactly the annotations block and nothing else",
  );
});

test("worker.deployedCommit does not perturb the API render (approval-plan hash safety)", () => {
  // If this fails, production releases break at the admission approval gate —
  // see the header comment. It is the reason the worker stamp is a separate
  // value rather than a change to the API template.
  const apiOnly = render("deployment-api.yaml", [
    "--set-string",
    `api.deployedCommit=${SAMPLE_COMMIT}`,
  ]);
  const apiPlusWorker = render("deployment-api.yaml", [
    "--set-string",
    `api.deployedCommit=${SAMPLE_COMMIT}`,
    "--set-string",
    `worker.deployedCommit=${SAMPLE_COMMIT}`,
  ]);
  assert.equal(
    sha256(apiPlusWorker),
    sha256(apiOnly),
    "setting worker.deployedCommit must leave the API Deployment byte-identical",
  );

  // Even a worker value that DISAGREES with the API value must not move the API
  // render — the divergence is caught at deploy time against the live objects,
  // not by silently reshaping the approved plan.
  const apiPlusDivergentWorker = render("deployment-api.yaml", [
    "--set-string",
    `api.deployedCommit=${SAMPLE_COMMIT}`,
    "--set-string",
    `worker.deployedCommit=${OTHER_COMMIT}`,
  ]);
  assert.equal(sha256(apiPlusDivergentWorker), sha256(apiOnly));
});

test("worker.deployedCommit rejects a non-40-hex value", () => {
  const output = renderFails("statefulset.yaml", [
    "--set-string",
    "worker.deployedCommit=sha-not-a-full-commit",
  ]);
  assert.match(output, /worker\.deployedCommit must be 40 lowercase hex/);
});

test("pod.annotations must not set the reserved deployed-commit key on the worker", () => {
  const output = renderFails("statefulset.yaml", [
    "--set-string",
    `pod.annotations.paperclip\\.blockcast\\.net/deployed-commit=${SAMPLE_COMMIT}`,
  ]);
  assert.match(
    output,
    /must not set reserved key paperclip\.blockcast\.net\/deployed-commit/,
  );
});
