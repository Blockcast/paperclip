import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const workflow = readFileSync(new URL("../.github/workflows/docker.yml", import.meta.url), "utf8");
const imageHelper = readFileSync(
  new URL("../deploy/helm/paperclip/templates/_helpers.tpl", import.meta.url),
  "utf8",
);

function getDeployJobBlock(source = workflow) {
  const marker = "\n  deploy:\n";
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, "docker.yml must define a deploy job");
  const remainder = source.slice(start + marker.length);
  const nextJob = remainder.search(/^  [A-Za-z0-9_-]+:\s*$/m);
  return nextJob === -1 ? remainder : remainder.slice(0, nextJob);
}

function getBuildJobBlock() {
  const startMarker = "\n  build-and-push:\n";
  const endMarker = "\n  deploy:\n";
  const start = workflow.indexOf(startMarker);
  const end = workflow.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, "docker.yml must define a build-and-push job");
  assert.notEqual(end, -1, "docker.yml must define a deploy job after build-and-push");
  return workflow.slice(start + startMarker.length, end);
}

test("Docker deploy job timeout covers every sequential rollout wait", () => {
  const deployJob = getDeployJobBlock();
  const jobTimeoutMatch = deployJob.match(/^    timeout-minutes:\s*(\d+)\s*$/m);
  const helmTimeoutMatch = deployJob.match(/--wait --timeout\s+(\d+)m\b/);
  const rolloutTimeoutMatch = deployJob.match(
    /rollout status deployment\/paperclip-api --timeout=(\d+)m\b/,
  );

  assert.ok(jobTimeoutMatch, "deploy job must declare timeout-minutes");
  assert.ok(helmTimeoutMatch, "deploy job must set helm upgrade --wait --timeout");
  assert.ok(rolloutTimeoutMatch, "deploy job must bound the post-reconcile rollout wait");

  const jobTimeoutMinutes = Number(jobTimeoutMatch[1]);
  const helmTimeoutMinutes = Number(helmTimeoutMatch[1]);
  const rolloutTimeoutMinutes = Number(rolloutTimeoutMatch[1]);

  assert.ok(
    jobTimeoutMinutes >= helmTimeoutMinutes + rolloutTimeoutMinutes + 10,
    `job timeout (${jobTimeoutMinutes}m) must cover Helm (${helmTimeoutMinutes}m) + rollout (${rolloutTimeoutMinutes}m) + 10m margin`,
  );
});

test("manual Docker deploys carry one full immutable SHA between jobs", () => {
  const buildJob = getBuildJobBlock();
  const deployJob = getDeployJobBlock();

  assert.match(buildJob, /\^\[0-9a-fA-F\]\{40\}\$/);
  assert.match(buildJob, /target_sha: \$\{\{ steps\.target\.outputs\.full \}\}/);
  assert.match(buildJob, /ref: \$\{\{ steps\.target\.outputs\.full \}\}/);
  assert.match(deployJob, /needs\.build-and-push\.outputs\.target_sha/);
  assert.match(deployJob, /\[ "\$\{full\}" != "\$\{expected\}" \]/);
});

test("master pushes cannot cancel protected manual deploy builds", () => {
  const buildJob = getBuildJobBlock();

  assert.match(
    buildJob,
    /group: docker-\$\{\{ github\.ref \}\}-\$\{\{ github\.event_name == 'workflow_dispatch' && 'deploy' \|\| 'publish' \}\}/,
  );
  assert.match(
    buildJob,
    /cancel-in-progress: \$\{\{ github\.event_name != 'workflow_dispatch' \}\}/,
  );
});

test("Docker deploy job verifies registry tooling before inspecting the artifact", () => {
  const deployJob = getDeployJobBlock();
  const setup = deployJob.indexOf("uses: docker/setup-buildx-action@v4");
  const toolCheck = deployJob.indexOf("name: Verify Docker registry tooling");
  const buildxVersion = deployJob.indexOf("docker buildx version");
  const inspect = deployJob.indexOf("docker buildx imagetools inspect");

  assert.equal(setup, -1, "deploy job must not boot a BuildKit builder");
  assert.notEqual(toolCheck, -1, "deploy job must verify Docker registry tooling");
  assert.notEqual(buildxVersion, -1, "deploy job must verify docker buildx is available");
  assert.notEqual(inspect, -1, "deploy job must inspect the deploy artifact");
  assert.ok(buildxVersion < inspect, "deploy job must verify buildx before artifact inspection");
});

test("deploy job assertions cannot match a later job", () => {
  const deployJob = getDeployJobBlock(`${workflow}\n  later-job:\n    name: later-job-only\n`);

  assert.doesNotMatch(deployJob, /later-job-only/);
});

test("production deploy is manual-only and environment-protected", () => {
  const deployJob = getDeployJobBlock();
  const conditionMatch = deployJob.match(/^    if:\s*\$\{\{\s*(.*?)\s*\}\}\s*$/m);
  assert.ok(conditionMatch, "deploy job must declare an if condition");
  assert.equal(
    conditionMatch[1].replace(/\s+/g, " "),
    "github.event_name == 'workflow_dispatch' && vars.PAPERCLIP_CI_DEPLOY == 'true' && github.ref == 'refs/heads/master' && needs.build-and-push.result == 'success'",
  );
  assert.match(deployJob, /environment:\n\s+name: paperclip-production/);
  assert.doesNotMatch(workflow, /^  schedule:/m);
});

test("Docker deploy binds Helm to the digest built for the approved SHA", () => {
  const buildJob = getBuildJobBlock();
  const deployJob = getDeployJobBlock();

  assert.match(buildJob, /image_digest: \$\{\{ steps\.build\.outputs\.digest \}\}/);
  assert.match(deployJob, /BUILD_RESULT: \$\{\{ needs\.build-and-push\.result \}\}/);
  assert.match(deployJob, /EXPECTED_DIGEST: \$\{\{ needs\.build-and-push\.outputs\.image_digest \}\}/);
  assert.match(deployJob, /BUILD_RESULT[^]*!= "success"/);
  assert.match(deployJob, /EXPECTED_DIGEST[^]*\^sha256:/);
  assert.match(deployJob, /\[ "\$\{digest\}" != "\$\{EXPECTED_DIGEST\}" \]/);
  assert.match(deployJob, /DIGEST: \$\{\{ steps\.artifact\.outputs\.digest \}\}/);
  const render = deployJob.indexOf('rendered=$(helm template');
  const upgrade = deployJob.indexOf('helm upgrade "${RELEASE}"');
  assert.notEqual(render, -1, "deploy job must render the selected chart before upgrade");
  assert.ok(render < upgrade, "deploy job must validate rendered images before upgrade");
  assert.match(deployJob, /grep -Fvx "\$\{expected_image\}"/);
  assert.match(deployJob, /--set-string image\.digest="\$\{DIGEST\}"/);
  assert.match(imageHelper, /if \.Values\.image\.digest/);
  assert.match(imageHelper, /printf "%s@%s" \.Values\.image\.repository \.Values\.image\.digest/);
});

test("Docker deploy approves the exact stamped plan before Helm mutates production", () => {
  const deployJob = getDeployJobBlock();
  const tooling = deployJob.indexOf("name: Checkout release tooling at trusted revision");
  const plan = deployJob.indexOf("name: Render, stamp, and validate deploy plan");
  const approve = deployJob.indexOf("name: Approve exact deploy plan at admission time");
  const upgrade = deployJob.indexOf("name: helm upgrade");

  assert.ok(tooling >= 0 && tooling < plan, "trusted approval tooling must be resolved first");
  assert.ok(plan < approve, "the side-effect-free stamped plan must validate before approval");
  assert.ok(approve < upgrade, "admission approval must complete before Helm upgrade");
  assert.match(deployJob, /ref: \$\{\{ github\.workflow_sha \}\}/);
  assert.match(deployJob, /--show-only templates\/deployment-api\.yaml/);
  assert.match(deployJob, /PAPERCLIP_APPROVAL_PLAN_SHA256="\$\{marker\}" "\$\{STAMP_SCRIPT\}"/);
  assert.match(deployJob, /DEPLOY_PLAN: \$\{\{ steps\.plan\.outputs\.path \}\}/);
  assert.match(
    deployJob,
    /"\$\{APPROVE_SCRIPT\}" "\$\{DIGEST\}" "\$\{DEPLOY_PLAN\}"/,
  );
  assert.match(
    deployJob,
    /PAPERCLIP_DEPLOY_KUBECONFIG="\$\{deploy_kubeconfig\}"/,
  );
  assert.match(
    deployJob,
    /PAPERCLIP_DEPLOY_NAMESPACE="\$\{NS\}"/,
  );
  assert.match(deployJob, /PAPERCLIP_APPROVED_SERVER_PLAN_OUT="\$\{approved_server_plan\}"/);
  assert.match(deployJob, /PAPERCLIP_DEPLOY_NAMESPACE="\$\{NS\}"[\s\\]+PAPERCLIP_APPROVAL_PLAN_SHA256/);
  assert.match(deployJob, /PAPERCLIP_DEPLOY_NAMESPACE: \$\{\{ vars\.PAPERCLIP_NAMESPACE \|\| 'paperclip' \}\}/);
  assert.match(deployJob, /--post-renderer "\$\{STAMP_SCRIPT\}"/);
  assert.equal(
    deployJob.match(/reconcile_approved_api_plan/g)?.length,
    3,
    "the exact-plan helper must cover both the live Helm wait and its exit race",
  );
  assert.ok(
    deployJob.indexOf("helm upgrade \"${RELEASE}\"") <
      deployJob.lastIndexOf("reconcile_approved_api_plan"),
    "Helm must apply release dependencies before exact API reconciliation",
  );
  assert.match(deployJob, /--wait --timeout 30m &\n          helm_pid=\$!/);
  assert.match(deployJob, /while kill -0 "\$\{helm_pid\}"/);
  assert.ok(
    deployJob.lastIndexOf("reconcile_approved_api_plan") <
      deployJob.indexOf('if [ "${helm_status}" -ne 0 ]'),
    "a marker-bearing Deployment must be reconciled before Helm failure is propagated",
  );
  assert.match(deployJob, /kubectl -n "\$\{NS\}" replace -f "\$\{reconciled\}"/);
  assert.match(deployJob, /for attempt in \$\(seq 1 5\)/);
  assert.match(deployJob, /grep -qiE 'conflict\|object has been modified'/);
  assert.match(deployJob, /Exact API reconciliation remained conflicted after 5 attempts/);
  assert.match(deployJob, /with_entries\(select\(\(\.key \| release_controlled_metadata_key\) \| not\)\)/);
  assert.match(deployJob, /BEGIN CANONICAL_DEPLOYMENT_JQ/);
  assert.match(deployJob, /live_server_plan_sha256.*approved_server_plan_sha256/s);
  assert.match(deployJob, /\.spec\.template\.metadata\.annotations\["paperclip\.blockcast\.net\/approval-plan-sha256"\] == \$marker/);
});

test("Docker deploy accepts an approved create plan without resourceVersion", () => {
  const deployJob = getDeployJobBlock();

  assert.match(
    deployJob,
    /\(\(\.metadata\.resourceVersion == null\) or\s+\(\.metadata\.resourceVersion \| type == "string" and length > 0\)\)/,
  );
  assert.match(
    deployJob,
    /\.metadata\.resourceVersion = \$live\.metadata\.resourceVersion/,
    "post-create reconciliation must bind the newly created live resourceVersion",
  );
});

test("Docker deploy confines and cleans up the release-approver credential", () => {
  const deployJob = getDeployJobBlock();
  const write = deployJob.indexOf('printf \'%s\' "${APPROVER_KUBECONFIG}"');
  const unset = deployJob.indexOf("unset APPROVER_KUBECONFIG");
  const invoke = deployJob.indexOf('"${APPROVE_SCRIPT}" "${DIGEST}" "${DEPLOY_PLAN}"');

  assert.match(deployJob, /approver_dir="\$\(mktemp -d/);
  assert.match(deployJob, /trap 'rm -rf "\$\{approver_dir\}"' EXIT/);
  assert.ok(write >= 0 && write < unset, "the secret must be materialized before its env value is unset");
  assert.ok(unset < invoke, "the raw secret must not be inherited by the approval script");
});

test("Docker deploy reconciles marker-bearing drift before propagating Helm failure", () => {
  const deployJob = getDeployJobBlock();
  const helmStart = deployJob.indexOf('helm upgrade "${RELEASE}"');
  const markerObserved = deployJob.indexOf('if [ "${live_marker}" = "${PLAN_MARKER}" ]');
  const reconcile = deployJob.indexOf("reconcile_approved_api_plan", markerObserved);
  const helmWait = deployJob.indexOf('wait "${helm_pid}" || helm_status=$?');
  const postWait = deployJob.indexOf('api_plan_reconciled=""', helmWait);
  const postWaitMarker = deployJob.indexOf(
    'if [ "${live_marker}" = "${PLAN_MARKER}" ]',
    postWait,
  );
  const postWaitReconcile = deployJob.indexOf("reconcile_approved_api_plan", postWaitMarker);
  const failedStatus = deployJob.indexOf('if [ "${helm_status}" -ne 0 ]');

  assert.ok(helmStart >= 0 && helmStart < markerObserved);
  assert.ok(markerObserved < reconcile, "the approved marker must gate exact reconciliation");
  assert.ok(reconcile < helmWait, "live-only drift must be removed while Helm is still waiting");
  assert.ok(helmWait < failedStatus, "Helm failure must be captured instead of exiting immediately");
  assert.ok(helmWait < postWait && postWait < postWaitMarker);
  assert.ok(
    postWaitMarker < postWaitReconcile && postWaitReconcile < failedStatus,
    "an identical pre-existing marker must not suppress post-Helm reconciliation",
  );
  assert.doesNotMatch(
    deployJob.slice(helmWait, postWaitMarker),
    /if \[ -z "\$\{api_plan_reconciled\}" \]/,
  );
});
