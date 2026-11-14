import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./check-github-runner-labels.mjs", import.meta.url));
const repoRoot = path.resolve(path.dirname(script), "..");
const prE2eRunnerPattern = /\n  e2e:\n(?:(?!\n  [A-Za-z0-9_-]+:)[\s\S])*?\n    runs-on: \$\{\{ github\.event_name == 'merge_group' && 'arc-merge-queue' \|\| 'arc-paperclip-e2e' \}\}\n/;

test("runner-label guard accepts only ARC workflows", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-runner-labels-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  await t.test("allows the ARC runner scales", async () => {
    await mkdir(path.join(root, ".github/workflows"), { recursive: true });
    await writeFile(
      path.join(root, ".github/workflows/arc.yml"),
      "jobs:\n  check:\n    runs-on: default\n  quoted:\n    runs-on: \"default\"\n  aggregate:\n    runs-on: [arc-paperclip-light, arc-dind]\n  release:\n    runs-on:\n      group: arc-deploy\n  browser:\n    runs-on:\n      - arc-paperclip-e2e\n  image:\n    runs-on:\n      group: arc-paperclip-buildkit\n      labels: arc-paperclip-buildkit\n  merge_group_style:\n    runs-on: ${{ github.event_name == 'merge_group' && 'arc-merge-queue' || 'arc-paperclip-general' }}\n",
    );

    const result = spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  });

  await t.test("rejects hosted and legacy generic labels", async () => {
    await writeFile(
      path.join(root, ".github/workflows/hosted.yml"),
      "jobs:\n  linux:\n    runs-on: ubuntu-latest\n  legacy:\n    runs-on: self-hosted\n",
    );

    const result = spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /hosted\.yml:3: runs-on: ubuntu-latest/);
    assert.match(result.stderr, /hosted\.yml:5: runs-on: self-hosted/);
  });

  await t.test("rejects forbidden labels in YAML block forms", async () => {
    await writeFile(
      path.join(root, ".github/workflows/block.yml"),
      "jobs:\n  hosted:\n    runs-on:\n      - self-hosted\n      - linux\n  grouped:\n    runs-on:\n      group: ubuntu-hosted\n",
    );

    const result = spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /block\.yml:4: - self-hosted/);
    assert.match(result.stderr, /block\.yml:5: - linux/);
    assert.match(result.stderr, /block\.yml:8: group: ubuntu-hosted/);
  });

  await t.test("rejects unknown runner labels", async () => {
    await writeFile(
      path.join(root, ".github/workflows/unknown.yml"),
      "jobs:\n  typo:\n    runs-on: arc-e2ee\n",
    );

    const result = spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unknown\.yml:3: runs-on: arc-e2ee/);
  });

  await t.test("rejects a ternary whose branch is not an allowed runner", async () => {
    await writeFile(
      path.join(root, ".github/workflows/ternary-bad.yml"),
      "jobs:\n  heavy:\n    runs-on: ${{ github.event_name == 'merge_group' && 'arc-merge-queue' || 'ubuntu-latest' }}\n",
    );

    const result = spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /ternary-bad\.yml:3:/);
  });

  await t.test("rejects a chained expression with an earlier forbidden runner", async () => {
    await writeFile(
      path.join(root, ".github/workflows/ternary-chained.yml"),
      "jobs:\n  heavy:\n    runs-on: ${{ cond && 'ubuntu-latest' || github.event_name == 'merge_group' && 'arc-merge-queue' || 'arc-paperclip-general' }}\n",
    );

    const result = spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /ternary-chained\.yml:3:/);
  });

  await t.test("rejects an opaque expression that isn't the recognized ternary shape", async () => {
    await writeFile(
      path.join(root, ".github/workflows/expr-opaque.yml"),
      "jobs:\n  heavy:\n    runs-on: ${{ fromJSON(vars.RUNNER_LABEL) }}\n",
    );

    const result = spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /expr-opaque\.yml:3:/);
  });
});

test("group-pinned pools must name their runner group", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-runner-group-pin-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workflows = path.join(root, ".github/workflows");
  await mkdir(workflows, { recursive: true });
  const fixture = path.join(workflows, "pinned.yml");
  const run = () => spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });

  await t.test("accepts the two-key group form", async () => {
    await writeFile(
      fixture,
      "jobs:\n  image:\n    runs-on:\n      group: arc-paperclip-buildkit\n      labels: arc-paperclip-buildkit\n",
    );

    const result = run();
    assert.equal(result.status, 0, result.stderr);
  });

  await t.test("rejects the bare label, which two runner groups answer", async () => {
    await writeFile(fixture, "jobs:\n  image:\n    runs-on: arc-paperclip-buildkit\n");

    const result = run();
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /answers these pools[\s\S]*pinned\.yml:3: runs-on: arc-paperclip-buildkit/,
    );
  });

  await t.test("rejects a sequence entry and a ternary branch", async () => {
    await writeFile(
      fixture,
      "jobs:\n  seq:\n    runs-on:\n      - arc-paperclip-buildkit\n  ternary:\n    runs-on: ${{ github.event_name == 'merge_group' && 'arc-merge-queue' || 'arc-paperclip-buildkit' }}\n",
    );

    const result = run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /pinned\.yml:4: - arc-paperclip-buildkit/);
    assert.match(result.stderr, /pinned\.yml:6:/);
  });

  await t.test("rejects the tools twin named on the group key", async () => {
    await writeFile(
      fixture,
      "jobs:\n  image:\n    runs-on:\n      group: arc-paperclip-buildkit-tools\n      labels: arc-paperclip-buildkit\n",
    );

    const result = run();
    assert.equal(result.status, 1);
    // Both rules fire, and each names the line that trips it: `-tools` is not an
    // allowed label, and the `labels:` entry reaches a group-pinned pool whose
    // group was not declared. The second is the one that survives the allowlist
    // being widened to admit `-tools`.
    assert.match(
      result.stderr,
      /Runner labels must use one of[\s\S]*pinned\.yml:4: group: arc-paperclip-buildkit-tools/,
    );
    assert.match(
      result.stderr,
      /answers these pools[\s\S]*pinned\.yml:5: labels: arc-paperclip-buildkit/,
    );
  });
});

test("PR e2e workflow isolates pull requests and merge groups", async () => {
  const workflow = await readFile(path.join(repoRoot, ".github/workflows/pr.yml"), "utf8");
  assert.match(
    workflow,
    prE2eRunnerPattern,
    "expected PR e2e on arc-paperclip-e2e and merge-group e2e on arc-merge-queue",
  );

  const driftedWorkflow = `${workflow.replace(
    "\n    runs-on: ${{ github.event_name == 'merge_group' && 'arc-merge-queue' || 'arc-paperclip-e2e' }}\n",
    "\n    runs-on: arc-paperclip-e2e\n",
  )}\n  later-job:\n    runs-on: arc-paperclip-e2e\n`;
  assert.doesNotMatch(
    driftedWorkflow,
    prE2eRunnerPattern,
    "a later job must not satisfy the PR e2e runner assertion",
  );
});

test("PR workflow does not route jobs to the shared default pool", async () => {
  const workflow = await readFile(path.join(repoRoot, ".github/workflows/pr.yml"), "utf8");
  assert.doesNotMatch(
    workflow,
    /^\s*runs-on:\s*default\s*$/m,
    "PR and merge-group jobs must use repository-scoped ARC pools",
  );
});
