import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  compareDistTrees,
  hashTree,
  listJs,
} from "../check-penstock-publish-drift.mjs";

const dirs = [];
function fixture(files) {
  const root = mkdtempSync(path.join(tmpdir(), "drift-fixture-"));
  dirs.push(root);
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(root, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  return root;
}

test.after(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

test("identical trees are in sync", () => {
  const a = fixture({ "index.js": "export const x = 1;\n", "ui/panel.js": "export const p = 2;\n" });
  const b = fixture({ "index.js": "export const x = 1;\n", "ui/panel.js": "export const p = 2;\n" });
  const r = compareDistTrees(a, b);
  assert.equal(r.inSync, true);
  assert.deepEqual(r.changed, []);
  assert.equal(r.workspaceFileCount, 2);
});

test("changed emit is reported per file, not as a whole-tree failure", () => {
  const ws = fixture({ "index.js": "export const x = 2;\n", "stable.js": "export const s = 0;\n" });
  const pub = fixture({ "index.js": "export const x = 1;\n", "stable.js": "export const s = 0;\n" });
  const r = compareDistTrees(ws, pub);
  assert.equal(r.inSync, false);
  // Only the file that actually differs — a reviewer needs to know *which*
  // export moved, not merely that something did.
  assert.deepEqual(r.changed, ["index.js"]);
  assert.deepEqual(r.onlyInWorkspace, []);
});

test("a file added on master but absent from npm is drift", () => {
  const ws = fixture({ "index.js": "a\n", "fencing.js": "export const f = 1;\n" });
  const pub = fixture({ "index.js": "a\n" });
  const r = compareDistTrees(ws, pub);
  assert.equal(r.inSync, false);
  assert.deepEqual(r.onlyInWorkspace, ["fencing.js"]);
  assert.deepEqual(r.changed, []);
});

test("a file npm still ships but master deleted is drift", () => {
  // The removed-file direction matters: `fs.cp` merges rather than replaces, so
  // a stale file surviving in the store is exactly how the plugin store ended up
  // running a union of two package lineages (see PR #1589).
  const ws = fixture({ "index.js": "a\n" });
  const pub = fixture({ "index.js": "a\n", "ui/clipboard.js": "export const c = 1;\n" });
  const r = compareDistTrees(ws, pub);
  assert.equal(r.inSync, false);
  assert.deepEqual(r.onlyInPublished, ["ui/clipboard.js"]);
});

test("a rename is reported as both sides, never as a silent match", () => {
  const ws = fixture({ "new-name.js": "same bytes\n" });
  const pub = fixture({ "old-name.js": "same bytes\n" });
  const r = compareDistTrees(ws, pub);
  assert.equal(r.inSync, false, "identical bytes under a different path must not count as in sync");
  assert.deepEqual(r.onlyInWorkspace, ["new-name.js"]);
  assert.deepEqual(r.onlyInPublished, ["old-name.js"]);
});

test("sourcemaps and type declarations are ignored", () => {
  // Load-bearing: .js.map and .d.ts.map embed absolute source paths that differ
  // between a CI checkout and the release runner. Including them would report
  // drift on literally every run and train people to ignore the check.
  const ws = fixture({
    "index.js": "same\n",
    "index.js.map": '{"sources":["/home/runner/work/a.ts"]}',
    "index.d.ts": "export declare const x: number;\n",
  });
  const pub = fixture({
    "index.js": "same\n",
    "index.js.map": '{"sources":["/build/release/b.ts"]}',
    "index.d.ts": "export declare const x: string;\n",
  });
  const r = compareDistTrees(ws, pub);
  assert.equal(r.inSync, true, "only emitted .js should be compared");
});

test("listJs walks nested directories and returns sorted posix paths", () => {
  const root = fixture({
    "b.js": "1\n",
    "a.js": "1\n",
    "ui/z.js": "1\n",
    "ui/nested/deep.js": "1\n",
    "ignored.d.ts": "1\n",
  });
  assert.deepEqual(listJs(root), ["a.js", "b.js", "ui/nested/deep.js", "ui/z.js"]);
});

test("hashTree binds content to path, so moving bytes changes the hash", () => {
  const a = fixture({ "one.js": "payload\n" });
  const b = fixture({ "two.js": "payload\n" });
  assert.notEqual(hashTree(a, listJs(a)), hashTree(b, listJs(b)));
});

test("importing the module does not execute the CLI", () => {
  // The CLI shells out to `npm pack` and calls process.exit; if the main guard
  // regressed, importing it here would hit the network and kill the test run.
  assert.equal(typeof compareDistTrees, "function");
});
