import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const workflow = readFileSync(new URL("../.github/workflows/docker.yml", import.meta.url), "utf8");

function getDeployJobBlock() {
  const marker = "\n  deploy:\n";
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1, "docker.yml must define a deploy job");
  return workflow.slice(start + marker.length);
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
