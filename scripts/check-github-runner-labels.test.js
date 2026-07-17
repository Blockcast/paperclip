import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./check-github-runner-labels.mjs", import.meta.url));

test("runner-label guard accepts only ARC workflows", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-runner-labels-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  await t.test("allows the three ARC runner scales", async () => {
    await mkdir(path.join(root, ".github/workflows"), { recursive: true });
    await writeFile(
      path.join(root, ".github/workflows/arc.yml"),
      "jobs:\n  check:\n    runs-on: default\n  image:\n    runs-on: arc-dind\n  release:\n    runs-on: arc-deploy\n",
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
});
