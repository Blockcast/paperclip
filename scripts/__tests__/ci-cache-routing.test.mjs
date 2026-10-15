import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

const prWorkflowPath = ".github/workflows/pr.yml";
const dockerWorkflowPath = ".github/workflows/docker.yml";
const dockerAgentWorkflowPath = ".github/workflows/docker-agent.yml";
const refreshLockfileWorkflowPath = ".github/workflows/refresh-lockfile.yml";
const playwrightCachePrimeWorkflowPath = ".github/workflows/playwright-cache-prime.yml";

test("PR jobs do not install an ineffective compiler cache", async () => {
  const workflow = await readFile(prWorkflowPath, "utf8");

  assert.doesNotMatch(workflow, /sccache|SCCACHE|RUSTC_WRAPPER/);
});

test("Docker builds use persistent remote BuildKit, master cache, and bounded compression", async () => {
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
  assert.doesNotMatch(buildJob, /buildcache-\$\{\{ steps\.target\.outputs\.full \}\}/);
  assert.match(buildJob, /type=raw,value=\$\{\{ steps\.image_tag\.outputs\.value \}\}/);
  assert.match(
    buildJob,
    /type=raw,value=latest-k8s-vendored,enable=\$\{\{ github\.ref == 'refs\/heads\/master' && github\.event_name != 'workflow_dispatch' \}\}/,
  );
  assert.match(
    buildJob,
    /cache-from: \|\n            type=registry,ref=harbor\.blockcast\.net\/paperclip\/paperclip:latest-k8s-vendored\n            type=registry,ref=harbor\.blockcast\.net\/paperclip\/paperclip:buildcache-v6\n/,
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

test("Playwright cache prime runs its cold-store install on a 16 GiB pool, not arc-light", async () => {
  const workflow = await readFile(playwrightCachePrimeWorkflowPath, "utf8");
  const primeJob = workflow.match(/\n  prime:\n([\s\S]*?)(?=\n  [A-Za-z0-9_-]+:\n|$)/)?.[1];

  assert.ok(primeJob, "Playwright cache prime job is missing");
  // A pnpm-lock.yaml push gives setup-node a store key nothing has saved on
  // master yet, so this install is cold-store: 5.1-5.6 GiB of anonymous memory
  // measured, and OOMKilled at arc-light's 4 GiB on both attempts of run
  // 38695349021. arc-paperclip-general (16 GiB) already runs the same install
  // for master-health.yml. See the comment on the job's runs-on.
  assert.match(workflow, /\n    paths:\n      - pnpm-lock\.yaml\n/);
  assert.match(primeJob, /\n      - name: Install dependencies\n        run: pnpm install --frozen-lockfile\n/);
  assert.match(primeJob, /\n    runs-on: arc-paperclip-general\n/);
});


test("shared image cache exports accept only default-branch sources", async () => {
  const names = ["docker-agent", "docker-designer", "docker-mcp-external",
    "docker-mcp-gateway", "docker-figma-bot", "docker-webflow-bot"];
  for (const name of names) {
    const workflow = await readFile(`.github/workflows/${name}.yml`, "utf8");
    const blocks = [...workflow.matchAll(/cache-to: (\$\{\{.+?\}\}|\|\n(?: {12}.+\n)+)/g)];
    const expressions = blocks.flatMap((block) =>
      [...block[1].matchAll(/\$\{\{ (.+?) \}\}/g)].map((match) => match[1]));
    assert.ok(expressions.length, `${name}: cache export declaration missing`);
    assert.doesNotMatch(workflow, /cache-to: type=|^ {12}type=.+mode=(max|min)/m);
    const events = [
      ["push", "refs/heads/master", "", name !== "docker-agent"],
      ["push", "refs/heads/feature/test", "", false],
      ["push", "refs/tags/v1.0", "", false],
      ["pull_request", "refs/pull/123/merge", "", false],
      ["workflow_dispatch", "refs/heads/master", "", true],
      ["workflow_dispatch", "refs/heads/feature/test", "", false],
      ["workflow_run", "refs/heads/master", "master", name === "docker-agent"],
      ["workflow_run", "refs/heads/master", "feature/test", false],
    ];
    for (const [event_name, ref, head_branch, allowed] of events) {
      for (const expression of expressions) {
        const result = runInNewContext(expression, {
          github: { event_name, ref, event: { workflow_run: { head_branch } } },
        }, { timeout: 100 });
        assert.equal(Boolean(result), allowed, `${name}: ${event_name} ${ref} ${head_branch}`);
      }
    }
    if (name === "docker-figma-bot" || name === "docker-webflow-bot") {
      assert.match(workflow, /value=buildcache-inline,enable=\$\{\{ github\.ref == 'refs\/heads\/master'/);
    }
  }
});
