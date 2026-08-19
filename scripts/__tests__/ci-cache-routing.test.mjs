import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const prWorkflowPath = ".github/workflows/pr.yml";
const dockerWorkflowPath = ".github/workflows/docker.yml";
const dockerAgentWorkflowPath = ".github/workflows/docker-agent.yml";
const refreshLockfileWorkflowPath = ".github/workflows/refresh-lockfile.yml";

test("PR jobs do not install an ineffective compiler cache", async () => {
  const workflow = await readFile(prWorkflowPath, "utf8");

  assert.doesNotMatch(workflow, /sccache|SCCACHE|RUSTC_WRAPPER/);
});

test("Docker builds use persistent remote BuildKit, exact-SHA cache, and bounded compression", async () => {
  const workflow = await readFile(dockerWorkflowPath, "utf8");
  const agentWorkflow = await readFile(dockerAgentWorkflowPath, "utf8");
  const buildJob = workflow.match(/\n  build-and-push:\n([\s\S]*?)\n  deploy:\n/)?.[1];

  assert.ok(buildJob, "build-and-push job is missing");
  assert.match(buildJob, /\n    runs-on: arc-paperclip-buildkit\n/);
  assert.match(
    buildJob,
    /PREFERRED_ORDINAL: \$\{\{ github\.event_name == 'workflow_dispatch' && '1' \|\| '0' \}\}/,
  );
  assert.match(
    buildJob,
    /preferred="buildkit-amd64-\$\{PREFERRED_ORDINAL\}\.buildkit-amd64-headless\.ci\.svc\.cluster\.local"/,
  );
  assert.match(buildJob, /fallback="buildkit-amd64\.ci\.svc\.cluster\.local"/);
  assert.match(
    buildJob,
    /timeout "\$\{timeout_seconds\}" nc -z -w "\$\{timeout_seconds\}" "\$\{host\}" 1234/,
  );
  assert.match(
    buildJob,
    /uses: docker\/setup-buildx-action@v4\n        with:\n          driver: remote\n          endpoint: \$\{\{ steps\.buildkit-endpoint\.outputs\.endpoint \}\}\n/,
  );
  assert.match(agentWorkflow, /PREFERRED_ORDINAL: "1"/);
  assert.match(
    agentWorkflow,
    /preferred="buildkit-amd64-\$\{PREFERRED_ORDINAL\}\.buildkit-amd64-headless\.ci\.svc\.cluster\.local"/,
  );
  assert.match(agentWorkflow, /fallback="buildkit-amd64\.ci\.svc\.cluster\.local"/);
  assert.match(
    agentWorkflow,
    /timeout "\$\{timeout_seconds\}" nc -z -w "\$\{timeout_seconds\}" "\$\{host\}" 1234/,
  );
  assert.match(
    agentWorkflow,
    /uses: docker\/setup-buildx-action@v4\n        with:\n          driver: remote\n          endpoint: \$\{\{ steps\.buildkit-endpoint\.outputs\.endpoint \}\}\n/,
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
  assert.match(
    buildJob,
    /outputs: type=image,push=true,compression=gzip,compression-level=1/,
  );
  assert.doesNotMatch(buildJob, /outputs: [^\n]*force-compression/);
});

test("Refresh Lockfile populates the setup-node-compatible pnpm cache before saving", async () => {
  const workflow = await readFile(refreshLockfileWorkflowPath, "utf8");
  const setupNode = workflow.match(
    /\n      - name: Setup Node\.js\n([\s\S]*?)(?=\n      - name:)/,
  )?.[1];

  assert.ok(setupNode, "Refresh Lockfile Setup Node.js step is missing");
  assert.doesNotMatch(setupNode, /\n\s+cache: pnpm\n/);

  const cacheKey =
    /key: node-cache-\$\{\{ runner\.os \}\}-\$\{\{ steps\.pnpm-cache\.outputs\.arch \}\}-pnpm-\$\{\{ hashFiles\('pnpm-lock\.yaml'\) \}\}/g;
  assert.equal(
    [...workflow.matchAll(cacheKey)].length,
    2,
    "restore and save must use setup-node's exact PNPM cache key shape",
  );
  assert.match(
    workflow,
    /- name: Resolve pnpm store cache\n        id: pnpm-cache[\s\S]*echo "path=\$\(pnpm store path --silent\)"[\s\S]*echo "arch=\$\(node -p 'process\.arch'\)"/,
  );
  assert.match(
    workflow,
    /- name: Restore pnpm store\n        id: pnpm-cache-restore\n        uses: actions\/cache\/restore@v4\n        with:\n          path: \$\{\{ steps\.pnpm-cache\.outputs\.path \}\}/,
  );
  assert.match(workflow, /- name: Populate pnpm store\n        run: pnpm fetch --frozen-lockfile/);
  assert.match(
    workflow,
    /- name: Save populated pnpm store\n        if: success\(\) && steps\.pnpm-cache-restore\.outputs\.cache-hit != 'true'\n        uses: actions\/cache\/save@v4\n        with:\n          path: \$\{\{ steps\.pnpm-cache\.outputs\.path \}\}/,
  );

  const orderedSteps = [
    "- name: Refresh pnpm lockfile",
    "- name: Resolve pnpm store cache",
    "- name: Restore pnpm store",
    "- name: Populate pnpm store",
    "- name: Save populated pnpm store",
    "- name: Fail on unexpected file changes",
  ].map((step) => workflow.indexOf(step));
  assert.ok(orderedSteps.every((index) => index >= 0), "cache seeding steps are incomplete");
  assert.deepEqual(
    [...orderedSteps].sort((left, right) => left - right),
    orderedSteps,
    "the refreshed lockfile must be restored, fetched, and saved in order",
  );
});
