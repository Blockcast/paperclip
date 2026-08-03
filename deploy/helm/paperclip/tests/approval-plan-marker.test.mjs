// BLO-20733 — the approval plan marker the release channel binds completion to.
//
// scripts/approve-paperclip-api-digest.sh (Blockcast/onprem-k8s, and the
// vendored copy here) refuses any planned Deployment whose POD TEMPLATE lacks
// `paperclip.blockcast.net/approval-plan-sha256`, and computes the value it
// expects as:
//
//   sha256( jq -cS 'del(.spec.template.metadata.annotations[marker])' <plan> )
//
// i.e. the canonical full Deployment with the marker itself removed. The marker
// therefore cannot be produced inside the Helm template — it would have to hash
// a document containing its own value. The release job instead renders the
// chart TWICE: once unstamped to obtain the hash, then again with
// `--set api.approvalPlanSha256=<hash>` to produce the manifest it both hands
// to the approve script and deploys.
//
// That scheme is sound if and only if stamping changes NOTHING ELSE in the
// rendered output. If it did, the hash taken from render #1 would not match the
// hash the approve script recomputes from render #2, and every release would
// die at "planned Deployment pod template must carry ...". These tests pin that
// invariant — they are the "rendered chart output and the manifest the approve
// script hashes are demonstrated to agree" acceptance criterion.
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

const MARKER = "paperclip.blockcast.net/approval-plan-sha256";
// Any 64-hex string exercises the plumbing; the real value is a SHA-256 the
// release job computes from the unstamped render.
const SAMPLE = "a".repeat(64);

function renderApiDeployment(extraArgs = []) {
  const yaml = execFileSync(
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
      ...extraArgs,
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
  // kubectl is the YAML->JSON reader here purely so the comparison below is
  // structural rather than textual; --dry-run=client needs no cluster.
  return JSON.parse(
    execFileSync("kubectl", ["create", "--dry-run=client", "-o", "json", "-f", "-"], {
      input: yaml,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    }),
  );
}

// Mirrors CANONICAL_UNSTAMPED_PLAN in approve-paperclip-api-digest.sh, including
// its empty-map cleanup: after deleting the only annotation, jq's `del` leaves
// `annotations: {}` behind, which is NOT what an unstamped render produces. The
// script prunes it, so the equivalence asserted here is the one it actually
// computes. Keep the two in step.
function stripMarker(deployment) {
  const stripped = structuredClone(deployment);
  const templateMeta = stripped.spec?.template?.metadata;
  if (!templateMeta?.annotations) return stripped;

  delete templateMeta.annotations[MARKER];
  if (Object.keys(templateMeta.annotations).length === 0) {
    delete templateMeta.annotations;
  }
  if (Object.keys(templateMeta).length === 0) {
    delete stripped.spec.template.metadata;
  }
  return stripped;
}

test("no marker is stamped by default (non-Blockcast deploys skip the approval channel)", () => {
  const rendered = renderApiDeployment();

  assert.equal(
    rendered.spec.template.metadata.annotations?.[MARKER],
    undefined,
    "unset api.approvalPlanSha256 must render no marker annotation",
  );
});

test("the marker lands on the POD TEMPLATE, not top-level Deployment metadata", () => {
  const rendered = renderApiDeployment([`--set`, `api.approvalPlanSha256=${SAMPLE}`]);

  assert.equal(
    rendered.spec.template.metadata.annotations[MARKER],
    SAMPLE,
    "the marker must be on spec.template.metadata.annotations so it is part of the rolled-out pod spec",
  );
  // Top-level metadata survives a config-only edit that never rolls pods, which
  // is exactly the evidence ROLLOUT_COMPLETE_JQ must not accept.
  assert.equal(
    rendered.metadata.annotations?.[MARKER],
    undefined,
    "the marker must NOT be stamped on top-level Deployment metadata",
  );
});

// The load-bearing test: without this, a two-pass render is unsound.
test("stamping the marker changes nothing else in the rendered Deployment", () => {
  const unstamped = renderApiDeployment();
  const stamped = renderApiDeployment([`--set`, `api.approvalPlanSha256=${SAMPLE}`]);

  assert.notDeepEqual(
    stamped,
    unstamped,
    "sanity: the stamped render must actually differ, or this test proves nothing",
  );
  assert.deepEqual(
    stripMarker(stamped),
    unstamped,
    "stamped render minus the marker must equal the unstamped render, or the hash " +
      "computed from render #1 cannot match what the approve script recomputes from render #2",
  );
});

test("the invariant also holds when pod.annotations is already non-empty", () => {
  // values.blockcast.yaml currently leaves pod.annotations empty, so the stamp
  // is what creates the annotations map. Pin the other branch too: an operator
  // adding a pod annotation later must not break the release channel, and
  // toYaml's alphabetical ordering must not shift anything.
  const existing = [`--set`, `pod.annotations.example\\.com/team=paperclip`];
  const unstamped = renderApiDeployment(existing);
  const stamped = renderApiDeployment([
    ...existing,
    `--set`,
    `api.approvalPlanSha256=${SAMPLE}`,
  ]);

  assert.equal(
    stamped.spec.template.metadata.annotations["example.com/team"],
    "paperclip",
    "stamping must not clobber pre-existing pod annotations",
  );
  assert.deepEqual(stripMarker(stamped), unstamped);
});

test("a malformed marker fails the render instead of shipping a plan the approver rejects", () => {
  // Fail at render time, where the message names the value, rather than several
  // steps later inside the approve script where it reads as a hash mismatch.
  assert.throws(
    () => renderApiDeployment([`--set`, `api.approvalPlanSha256=not-a-sha`]),
    /approvalPlanSha256 must be 64 lowercase hex/,
  );
});

for (const releaseMarker of [undefined, SAMPLE]) {
  test(`pod.annotations cannot inject the reserved marker when the release marker is ${releaseMarker ? "set" : "unset"}`, () => {
    const args = [
      `--set`,
      `pod.annotations.paperclip\\.blockcast\\.net/approval-plan-sha256=${"b".repeat(64)}`,
    ];
    if (releaseMarker) {
      args.push(`--set`, `api.approvalPlanSha256=${releaseMarker}`);
    }

    assert.throws(
      () => renderApiDeployment(args),
      /pod\.annotations must not set reserved key paperclip\.blockcast\.net\/approval-plan-sha256/,
    );
  });
}
