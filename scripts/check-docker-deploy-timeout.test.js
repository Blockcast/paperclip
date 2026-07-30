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

test("Docker deploy job timeout exceeds Helm wait timeout", () => {
  const deployJob = getDeployJobBlock();
  const jobTimeoutMatch = deployJob.match(/^    timeout-minutes:\s*(\d+)\s*$/m);
  const helmTimeoutMatch = deployJob.match(/--wait --timeout\s+(\d+)m\b/);

  assert.ok(jobTimeoutMatch, "deploy job must declare timeout-minutes");
  assert.ok(helmTimeoutMatch, "deploy job must set helm upgrade --wait --timeout");

  const jobTimeoutMinutes = Number(jobTimeoutMatch[1]);
  const helmTimeoutMinutes = Number(helmTimeoutMatch[1]);

  assert.ok(
    jobTimeoutMinutes >= helmTimeoutMinutes + 5,
    `job timeout (${jobTimeoutMinutes}m) must leave cleanup margin after Helm timeout (${helmTimeoutMinutes}m)`,
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

test("Docker deploy job provisions Buildx before inspecting the artifact", () => {
  const deployJob = getDeployJobBlock();
  const setup = deployJob.indexOf("uses: docker/setup-buildx-action@v4");
  const inspect = deployJob.indexOf("docker buildx imagetools inspect");

  assert.notEqual(setup, -1, "deploy job must provision Buildx");
  assert.notEqual(inspect, -1, "deploy job must inspect the deploy artifact");
  assert.ok(setup < inspect, "deploy job must provision Buildx before artifact inspection");
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
