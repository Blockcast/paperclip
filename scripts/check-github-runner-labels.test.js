import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./check-github-runner-labels.mjs", import.meta.url));
const repoRoot = path.resolve(path.dirname(script), "..");
const prE2eRunnerPattern = /\n  e2e:\n(?:(?!\n  [A-Za-z0-9_-]+:)[\s\S])*?\n    runs-on: arc-e2e\n/;

test("runner-label guard accepts only ARC workflows", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-runner-labels-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  await t.test("allows the ARC runner scales", async () => {
    await mkdir(path.join(root, ".github/workflows"), { recursive: true });
    await writeFile(
      path.join(root, ".github/workflows/arc.yml"),
      "jobs:\n  check:\n    runs-on: default\n  quoted:\n    runs-on: \"default\"\n  aggregate:\n    runs-on: [arc-light, arc-dind]\n  release:\n    runs-on:\n      group: arc-deploy\n  browser:\n    runs-on:\n      - arc-e2e\n",
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
});

test("PR e2e workflow uses the dedicated ARC e2e runner", async () => {
  const workflow = await readFile(path.join(repoRoot, ".github/workflows/pr.yml"), "utf8");
  assert.match(
    workflow,
    prE2eRunnerPattern,
    "expected the PR e2e job to run on arc-e2e",
  );

  const driftedWorkflow = `${workflow.replace(
    "\n    runs-on: arc-e2e\n",
    "\n    runs-on: default\n",
  )}\n  later-job:\n    runs-on: arc-e2e\n`;
  assert.doesNotMatch(
    driftedWorkflow,
    prE2eRunnerPattern,
    "a later job must not satisfy the PR e2e runner assertion",
  );
});
