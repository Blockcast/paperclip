import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createContext, Script } from "node:vm";

const prWorkflowPath = ".github/workflows/pr.yml";
const dockerWorkflowPath = ".github/workflows/docker.yml";
const dockerAgentWorkflowPath = ".github/workflows/docker-agent.yml";
const refreshLockfileWorkflowPath = ".github/workflows/refresh-lockfile.yml";
const playwrightCachePrimeWorkflowPath = ".github/workflows/playwright-cache-prime.yml";
const actionlintCachePrimeWorkflowPath = ".github/workflows/actionlint-cache-prime.yml";
const setupActionlintActionPath = ".github/actions/setup-actionlint/action.yml";
const masterHealthWorkflowPath = ".github/workflows/master-health.yml";
const restorePnpmStoreActionPath = ".github/actions/restore-pnpm-store/action.yml";
const pluginBuildDepsActionPath = ".github/actions/plugin-build-deps/action.yml";
const ensurePluginBuildDepsPath = "scripts/ensure-plugin-build-deps.mjs";

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
  // BLO-55269: dispatch defaults to ordinal 1 but an operator can pick 0; push stays on 0.
  assert.match(workflow, /\n      buildkit_ordinal:\n[\s\S]*?type: choice\n        default: "1"\n        options:\n          - "1"\n          - "0"\n/);
  assert.match(buildJob, /INPUT_ORDINAL: \$\{\{ inputs\.buildkit_ordinal \}\}/);
  assert.match(
    buildJob,
    /if \[\[ "\$\{EVENT_NAME\}" == "workflow_dispatch" \]\]; then\n\s+PREFERRED_ORDINAL="\$\{INPUT_ORDINAL:-1\}"\n\s+else\n\s+PREFERRED_ORDINAL=0\n\s+fi/,
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

// setup-node's `cache: pnpm` and the combined actions/cache save in a post-step
// on every event. From a pull_request or merge_group run that save lands in a
// refs/pull/N/merge or single-use gh-readonly-queue/* scope no later run reads,
// and on a failed restore it re-uploaded the ~0.8 GB store after the job's work
// (3 of 14 sampled heavy jobs were cancelled inside it). Refresh Lockfile and
// Playwright cache prime seed `master`, which every scope reads.
test("PR and master-health jobs only restore caches; every pnpm install restores the store first", async () => {
  for (const [workflowPath, minimumInstalls] of [[prWorkflowPath, 6], [masterHealthWorkflowPath, 2]]) {
    const workflow = await readFile(workflowPath, "utf8");
    // Input lines only: comments in pr.yml still name `cache: pnpm`.
    assert.doesNotMatch(workflow, /^\s*cache: pnpm\s*$/m, `${workflowPath} must not use setup-node's saving pnpm cache`);
    assert.doesNotMatch(workflow, /uses: actions\/cache\/save@/, `${workflowPath} must not save a cache directly`);
    assert.doesNotMatch(workflow, /uses: actions\/cache@/, `${workflowPath} must use actions/cache/restore, which has no post-step save`);

    const steps = workflow.split("\n      - name: ");
    let installs = 0;
    for (let index = 1; index < steps.length; index += 1) {
      if (!steps[index].startsWith("Install dependencies\n")) continue;
      installs += 1;
      assert.match(
        steps[index - 1],
        /^Restore pnpm store\n(?: {8}if: [^\n]*\n)? {8}uses: \.\/\.github\/actions\/restore-pnpm-store\n/,
        `${workflowPath}: every \`Install dependencies\` must follow the restore-only pnpm store step`,
      );
      assert.match(steps[index - 2], /^Setup Node\.js\n/, `${workflowPath}: the store restore needs node, so it follows Setup Node.js`);
    }
    assert.ok(installs >= minimumInstalls, `${workflowPath}: found ${installs} pnpm installs; slicing broke?`);
  }
});

test("the restore-only pnpm action reads exactly the entry Refresh Lockfile saves", async () => {
  const action = await readFile(restorePnpmStoreActionPath, "utf8");
  const refresh = await readFile(refreshLockfileWorkflowPath, "utf8");

  assert.doesNotMatch(action, /actions\/cache\/save|uses: actions\/cache@/, "the action must never save");
  // actions/cache versions an entry by its path string and compression, so the
  // path, the arch and the key must resolve exactly as Refresh Lockfile's do.
  const resolve = (text) =>
    text
      .match(/echo "path=\$\(pnpm store path --silent\)" >> "\$GITHUB_OUTPUT"\n\s*echo "arch=\$\(node -p 'process\.arch'\)" >> "\$GITHUB_OUTPUT"/)?.[0]
      .replace(/\n\s*/, "\n");
  assert.ok(resolve(action), "the action must resolve the store path like Refresh Lockfile");
  assert.equal(resolve(action), resolve(refresh));
  const values = (text, name) => [...text.matchAll(new RegExp(`^\\s*${name}: (.+)$`, "gm"))].map((match) => match[1]);
  const [refreshPath] = values(refresh, "path");
  const [refreshKey] = values(refresh, "key");
  assert.deepEqual(values(action, "path"), [refreshPath, refreshPath]);
  assert.deepEqual(values(action, "key"), [refreshKey, refreshKey]);
  assert.match(
    action,
    /- name: Retry pnpm store restore\n\s+if: steps\.pnpm-cache-restore\.outputs\.cache-matched-key == ''\n\s+uses: actions\/cache\/restore@v4\n/,
    "the retry must fire only when nothing was restored",
  );
  // A prefix match in the job's own scope beats master's exact entry, so only
  // the retry may fall back to an older store.
  assert.equal([...action.matchAll(/^\s*restore-keys:/gm)].length, 1, "restore-keys belongs on the retry only");
  assert.match(action, /- name: Retry pnpm store restore\n[\s\S]*restore-keys:/);
  // `pnpm store path` differs across pnpm majors (v3 store in pnpm 9, v10 in
  // pnpm 10). Lanes run package.json's packageManager through setup-pnpm, and
  // Refresh Lockfile pins its own copy, so a bump must move both.
  const packageManager = JSON.parse(await readFile("package.json", "utf8")).packageManager;
  const refreshPnpm = refresh.match(/uses: pnpm\/action-setup@[^\n]+\n\s+with:\n\s+version: ([^\s]+)\n/)?.[1];
  assert.equal(`pnpm@${refreshPnpm}`, packageManager, "Refresh Lockfile must seed the store with the pnpm the lanes run");
});

// The restored dist is touched to look fresh, so ensure-plugin-build-deps.mjs
// skips its compile. That is safe only while the key hashes every compile input.
test("plugin build deps: the key hashes every build target, and only a master push saves", async () => {
  const action = await readFile(pluginBuildDepsActionPath, "utf8");
  const script = await readFile(ensurePluginBuildDepsPath, "utf8");
  const masterHealth = await readFile(masterHealthWorkflowPath, "utf8");

  const key = action.match(/\n {8}key: plugin-build-deps-\$\{\{ runner\.os \}\}-\$\{\{ hashFiles\((.+)\) \}\}\n/)?.[1];
  assert.ok(key, "plugin build deps restore key is missing");
  const inputs = [...key.matchAll(/'([^']+)'/g)].map((match) => match[1]);
  const targets = [...script.matchAll(/(sourceDir|tsconfig): path\.join\(rootDir, "([^"]+)"\)/g)];
  assert.ok(targets.length >= 4, "buildTargets moved; re-point this test at them");
  for (const [, field, file] of targets) {
    const wanted = field === "sourceDir" ? [`${file}/**`] : [file, `${path.posix.dirname(file)}/package.json`];
    for (const input of wanted) assert.ok(inputs.includes(input), `plugin build deps key must hash ${input}`);
  }
  for (const input of ["tsconfig.base.json", "tsconfig.json", "pnpm-lock.yaml", ensurePluginBuildDepsPath]) {
    assert.ok(inputs.includes(input), `plugin build deps key must hash ${input}`);
  }
  assert.doesNotMatch(action, /^\s*restore-keys:/m, "a near match would be touched into looking fresh");
  assert.match(action, /- name: Mark restored plugin build deps fresh\n\s+if: steps\.restore\.outputs\.cache-hit == 'true'\n/);

  const gate = action.match(/- name: Save plugin build deps\n\s+if: ([^\n]+)\n\s+uses: actions\/cache\/save@v4\n/)?.[1];
  assert.ok(gate, "plugin build deps save step is missing");
  // GitHub's `a.b-c` property syntax is not JavaScript; everything else here is.
  const expression = gate.replace(/\.([A-Za-z_]\w*-[\w-]*)/g, '["$1"]');
  const cases = [
    ["push", "refs/heads/master", "true", "", true],
    ["push", "refs/heads/master", "true", "true", false],
    ["push", "refs/heads/master", "false", "", false],
    ["push", "refs/heads/feature/test", "true", "", false],
    ["pull_request", "refs/pull/123/merge", "true", "", false],
    ["merge_group", "refs/heads/gh-readonly-queue/master/pr-1-abc", "true", "", false],
    ["schedule", "refs/heads/master", "true", "", false],
    ["workflow_dispatch", "refs/heads/master", "true", "", false],
  ];
  // One reused context and a compile-once Script, as the shared-image-cache test
  // below does (PEN-5667): the timeout is a hang guard, not a performance bound.
  const sandbox = {};
  const context = createContext(sandbox);
  const gateScript = new Script(expression);
  for (const [event_name, ref, save, hit, allowed] of cases) {
    Object.assign(sandbox, {
      github: { event_name, ref },
      inputs: { save },
      steps: { restore: { outputs: { "cache-hit": hit } } },
    });
    const result = gateScript.runInContext(context, { timeout: 5_000 });
    assert.equal(Boolean(result), allowed, `${event_name} ${ref} save=${save} cache-hit=${hit}`);
  }
  // Nothing else seeds this key, so losing this input would turn every restore
  // into a miss without failing anything.
  assert.match(
    masterHealth,
    /- name: Restore or seed plugin build deps\n {8}uses: \.\/\.github\/actions\/plugin-build-deps\n {8}with:\n {10}save: \$\{\{ matrix\.shard_index == 0 \}\}\n/,
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
  // PEN-5667: the per-script timeout below is a hang guard, not a performance
  // assertion. It was 100 ms around a `runInNewContext` call that built a fresh
  // V8 context per evaluation -- 6 workflows x 8 events x N expressions = 96
  // contexts -- so the bound covered context construction and the GC pressure
  // those contexts created rather than the microsecond boolean comparison it
  // was meant to bound. Measured on a 4-CPU runner: p100 70.94 ms while idle
  // (71% of the old budget) and ERR_SCRIPT_EXECUTION_TIMEOUT under load, which
  // took the required `policy` context down with it and ejected #3376 from the
  // merge queue. One reused context plus a compile-once Script keeps the timed
  // region to the expression itself; 5 s still catches a genuine infinite loop
  // well inside this step's `timeout-minutes: 1`, which is the real hang guard.
  const scriptTimeoutMs = 5_000;
  const sandbox = { github: undefined };
  const context = createContext(sandbox);
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
    const compiled = expressions.map((expression) => [expression, new Script(expression)]);
    for (const [event_name, ref, head_branch, allowed] of events) {
      sandbox.github = { event_name, ref, event: { workflow_run: { head_branch } } };
      for (const [expression, script] of compiled) {
        const result = script.runInContext(context, { timeout: scriptTimeoutMs });
        assert.equal(Boolean(result), allowed,
          `${name}: ${event_name} ${ref} ${head_branch} :: ${expression}`);
      }
    }
    if (name === "docker-figma-bot" || name === "docker-webflow-bot") {
      assert.match(workflow, /value=buildcache-inline,enable=\$\{\{ github\.ref == 'refs\/heads\/master'/);
    }
  }
});

// PEN-6132. `policy`'s last unconditional external draw is the actionlint
// release-asset fetch, and `policy` is what every other lane `needs:` -- a
// failed fetch reds the run and, in a merge_group, ejects the entry. The
// restore removes the draw; these assertions keep the two halves able to find
// each other, because every way they can drift apart looks correct in
// isolation and shows up only as a permanent, silent cache miss.
test("setup-actionlint restores the pinned tarball and never saves", async () => {
  const action = await readFile(setupActionlintActionPath, "utf8");

  // Restore-only, for the same two reasons pr.yml is: a save from a
  // merge_group lands in a single-use `gh-readonly-queue/*` scope no later run
  // reads, and the post-step upload is itself a lane-killer (PEN-5032
  // cancelled 3 of 14 sampled heavy jobs inside one).
  assert.match(action, /uses: actions\/cache\/restore@v4\n/);
  assert.doesNotMatch(action, /uses: actions\/cache\/save@/);
  assert.doesNotMatch(action, /uses: actions\/cache@/);

  // The digest, not just the version, is in the key: a pin bump must be a
  // different key or a warm cache serves the superseded binary.
  const version = action.match(/\n {8}VERSION: "([^"]+)"\n/)?.[1];
  const sha256 = action.match(/\n {8}SHA256: "([0-9a-f]{64})"\n/)?.[1];
  assert.ok(version && sha256, "setup-actionlint must pin a version and a SHA256");
  assert.match(action, /echo "cache_key=actionlint-\$\{RUNNER_OS\}-\$\{arch\}-\$\{VERSION\}-\$\{SHA256\}"/);

  // The checksum is the trust anchor on BOTH paths, so the cache stores the
  // TARBALL and the same `sha256sum --check` gates it. Caching the extracted
  // binary instead would leave the restore path unverified.
  assert.match(action, /if \[ -f "\$tarball" \] && echo "\$\{SHA256\}  \$\{tarball\}" \| sha256sum --check --status; then/);
  assert.equal((action.match(/sha256sum --check --status/g) || []).length, 2,
    "both the restore path and the download path must run the checksum");
});

test("the actionlint cache prime saves exactly what setup-actionlint restores, only on master", async () => {
  const action = await readFile(setupActionlintActionPath, "utf8");
  const prime = await readFile(actionlintCachePrimeWorkflowPath, "utf8");

  // actions/cache versions an entry by the literal path STRING, so a prime
  // that saved `/home/runner/.cache/actionlint` while the action restores
  // `~/.cache/actionlint` would write an entry that can never be restored.
  // The prime consumes the action's outputs rather than repeating the
  // literals, which makes that drift unrepresentable instead of merely caught.
  assert.match(action, /\n {8}path: ~\/\.cache\/actionlint\n/);
  assert.match(action, /\n {4}value: \$\{\{ steps\.pin\.outputs\.cache_path \}\}\n/);
  assert.match(prime, /\n {10}path: \$\{\{ steps\.actionlint\.outputs\.cache_path \}\}\n/);
  assert.match(prime, /\n {10}key: \$\{\{ steps\.actionlint\.outputs\.cache_key \}\}\n/);
  assert.match(prime, /\n {8}id: actionlint\n {8}uses: \.\/\.github\/actions\/setup-actionlint\n/);

  // Only `master` is readable from every scope, which is the whole point of
  // priming; and the key only changes when the action file does, so that path
  // must stay in the trigger or a pin bump ships an unseeded key.
  assert.match(prime, /\n {2}push:\n {4}branches: \[master\]\n/);
  assert.match(prime, /\n {6}- \.github\/actions\/setup-actionlint\/action\.yml\n/);
  assert.doesNotMatch(prime, /\n {2}pull_request:/);

  // Re-downloading on a hit would defeat the prime's own purpose and re-upload
  // bytes already in the scope.
  assert.match(prime, /\n {8}if: steps\.actionlint\.outputs\.cache_hit != 'true'\n/);
});
