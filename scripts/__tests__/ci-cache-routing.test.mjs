import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const prWorkflowPath = ".github/workflows/pr.yml";
const dockerWorkflowPath = ".github/workflows/docker.yml";

test("PR jobs do not install an ineffective compiler cache", async () => {
  const workflow = await readFile(prWorkflowPath, "utf8");

  assert.doesNotMatch(workflow, /sccache|SCCACHE|RUSTC_WRAPPER/);
});

test("Docker builds use persistent remote BuildKit and exact-SHA cache lineage", async () => {
  const workflow = await readFile(dockerWorkflowPath, "utf8");
  const buildJob = workflow.match(/\n  build-and-push:\n([\s\S]*?)\n  deploy:\n/)?.[1];

  assert.ok(buildJob, "build-and-push job is missing");
  assert.match(buildJob, /\n    runs-on: arc-paperclip-buildkit\n/);
  assert.match(
    buildJob,
    /uses: docker\/setup-buildx-action@v4\n        with:\n          driver: remote\n          endpoint: tcp:\/\/buildkit-amd64\.ci\.svc\.cluster\.local:1234\n/,
  );
  assert.match(
    buildJob,
    /type=raw,value=buildcache-\$\{\{ steps\.target\.outputs\.full \}\}-k8s-vendored/,
  );
  assert.match(
    buildJob,
    /cache-from: \|\n            type=registry,ref=harbor\.blockcast\.net\/paperclip\/paperclip:buildcache-\$\{\{ steps\.target\.outputs\.full \}\}-k8s-vendored\n            type=registry,ref=harbor\.blockcast\.net\/paperclip\/paperclip:latest-k8s-vendored\n            type=registry,ref=harbor\.blockcast\.net\/paperclip\/paperclip:buildcache-v6\n/,
  );
  assert.match(buildJob, /cache-to: type=inline/);
});
