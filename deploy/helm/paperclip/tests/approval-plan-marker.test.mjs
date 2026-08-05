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
// chart TWICE: once unstamped to obtain the hash, then again through a trusted
// post-renderer that adds the marker. The post-renderer works for historical
// target charts that predate api.approvalPlanSha256.
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
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

const MARKER = "paperclip.blockcast.net/approval-plan-sha256";
const DEPLOYED_COMMIT = "paperclip.blockcast.net/deployed-commit";
// Any 64-hex string exercises the plumbing; the real value is a SHA-256 the
// release job computes from the unstamped render.
const SAMPLE = "a".repeat(64);
const SAMPLE_COMMIT = "0123456789abcdef0123456789abcdef01234567";

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

function stampApiDeployment(deployment, marker = SAMPLE) {
  const yaml = execFileSync(
    "bash",
    ["scripts/stamp-paperclip-api-approval-plan.sh"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      input: JSON.stringify(deployment),
      env: { ...process.env, PAPERCLIP_APPROVAL_PLAN_SHA256: marker },
    },
  );
  return JSON.parse(
    execFileSync("kubectl", ["create", "--dry-run=client", "-o", "json", "-f", "-"], {
      input: yaml,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    }),
  );
}

function markerFor(deployment) {
  const canonical = execFileSync("jq", ["-cS", "."], {
    input: JSON.stringify(stripMarker(deployment)),
    encoding: "utf8",
  }).trimEnd();
  return execFileSync("sha256sum", [], {
    input: canonical,
    encoding: "utf8",
  }).split(" ")[0];
}

// Mirrors CANONICAL_UNSTAMPED_PLAN in approve-paperclip-api-digest.sh, including
// its empty-map cleanup: after deleting the only annotation, jq's `del` leaves
// `annotations: {}` behind, which is NOT what an unstamped render produces. The
// script prunes it, so the equivalence asserted here is the one it actually
// computes. Keep the two in step.
function stripMarker(deployment) {
  return stripTemplateAnnotation(deployment, MARKER);
}

function stripTemplateAnnotation(deployment, key) {
  const stripped = structuredClone(deployment);
  const templateMeta = stripped.spec?.template?.metadata;
  if (!templateMeta?.annotations) return stripped;

  delete templateMeta.annotations[key];
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

test("no deployed commit is stamped by default", () => {
  const rendered = renderApiDeployment();

  assert.equal(
    rendered.spec.template.metadata.annotations?.[DEPLOYED_COMMIT],
    undefined,
    "unset api.deployedCommit must render no deployed-commit annotation",
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

test("the deployed commit lands on the POD TEMPLATE, not top-level Deployment metadata", () => {
  const rendered = renderApiDeployment([`--set-string`, `api.deployedCommit=${SAMPLE_COMMIT}`]);

  assert.equal(
    rendered.spec.template.metadata.annotations[DEPLOYED_COMMIT],
    SAMPLE_COMMIT,
    "the deployed commit must be on spec.template.metadata.annotations so drift checks read the rolled-out pod spec",
  );
  assert.equal(
    rendered.metadata.annotations?.[DEPLOYED_COMMIT],
    undefined,
    "the deployed commit must NOT be stamped on top-level Deployment metadata",
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

test("stamping the deployed commit changes nothing else in the rendered Deployment", () => {
  const unstamped = renderApiDeployment();
  const stamped = renderApiDeployment([`--set-string`, `api.deployedCommit=${SAMPLE_COMMIT}`]);

  assert.notDeepEqual(
    stamped,
    unstamped,
    "sanity: the deployed-commit render must actually differ, or this test proves nothing",
  );
  assert.deepEqual(
    stripTemplateAnnotation(stamped, DEPLOYED_COMMIT),
    unstamped,
    "deployed-commit render minus the annotation must equal the unstamped render",
  );
});

test("trusted post-renderer stamps an unstamped legacy chart without other changes", () => {
  const unstamped = renderApiDeployment();
  const marker = markerFor(unstamped);
  const stamped = stampApiDeployment(unstamped, marker);

  assert.equal(stamped.spec.template.metadata.annotations[MARKER], marker);
  assert.deepEqual(stripMarker(stamped), unstamped);
});

test("trusted post-renderer rejects a Helm render that differs from the approved plan", () => {
  const approved = renderApiDeployment();
  const changed = structuredClone(approved);
  changed.spec.replicas += 1;

  assert.throws(
    () => stampApiDeployment(changed, markerFor(approved)),
    /does not match approved plan/,
  );
});

test("trusted post-renderer rejects a conflicting marker", () => {
  const chartStamped = renderApiDeployment([`--set`, `api.approvalPlanSha256=${SAMPLE}`]);
  assert.throws(
    () => stampApiDeployment(chartStamped, "b".repeat(64)),
    /already carries a different approval-plan marker/,
  );
});

test("approval cleanup stays armed until the server-normalized plan handoff succeeds", () => {
  const script = readFileSync(
    path.join(repoRoot, "scripts/approve-paperclip-api-digest.sh"),
    "utf8",
  );
  const handoff = script.indexOf('printf \'%s\\n\' "$server_plan_json" >"$PAPERCLIP_APPROVED_SERVER_PLAN_OUT"');
  const disarm = script.indexOf('lock_cleanup_armed=""', handoff);

  assert.notEqual(handoff, -1, "approval script must write the server-normalized plan");
  assert.ok(disarm > handoff, "cleanup must remain armed until the plan handoff succeeds");
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
    `--set-string`,
    `api.deployedCommit=${SAMPLE_COMMIT}`,
  ]);

  assert.equal(
    stamped.spec.template.metadata.annotations["example.com/team"],
    "paperclip",
    "stamping must not clobber pre-existing pod annotations",
  );
  assert.deepEqual(stripTemplateAnnotation(stripMarker(stamped), DEPLOYED_COMMIT), unstamped);
});

test("a malformed marker fails the render instead of shipping a plan the approver rejects", () => {
  // Fail at render time, where the message names the value, rather than several
  // steps later inside the approve script where it reads as a hash mismatch.
  assert.throws(
    () => renderApiDeployment([`--set`, `api.approvalPlanSha256=not-a-sha`]),
    /approvalPlanSha256 must be 64 lowercase hex/,
  );
});

test("a malformed deployed commit fails the render instead of stamping unverifiable drift evidence", () => {
  assert.throws(
    () => renderApiDeployment([`--set-string`, `api.deployedCommit=sha-not-a-full-commit`]),
    /deployedCommit must be 40 lowercase hex/,
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

for (const releaseCommit of [undefined, SAMPLE_COMMIT]) {
  test(`pod.annotations cannot inject the reserved deployed-commit when the release commit is ${releaseCommit ? "set" : "unset"}`, () => {
    const args = [
      `--set`,
      `pod.annotations.paperclip\\.blockcast\\.net/deployed-commit=${SAMPLE_COMMIT}`,
    ];
    if (releaseCommit) {
      args.push(`--set-string`, `api.deployedCommit=${releaseCommit}`);
    }

    assert.throws(
      () => renderApiDeployment(args),
      /pod\.annotations must not set reserved key paperclip\.blockcast\.net\/deployed-commit/,
    );
  });
}
