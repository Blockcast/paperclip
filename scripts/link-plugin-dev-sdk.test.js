import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

import {
  excludedPluginDirs,
  linkSdkInto,
  readPluginsUnder,
  symlinkAcceptingIdenticalRaceWinner,
} from "./link-plugin-dev-sdk.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let workDir;

before(() => {
  workDir = mkdtempSync(join(tmpdir(), "link-plugin-dev-sdk-"));
});

after(() => {
  rmSync(workDir, { force: true, recursive: true });
});

function makePackage(dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), "{}\n");
  return dir;
}

test("readPluginsUnder returns [] for a missing directory", () => {
  assert.deepEqual(readPluginsUnder(join(workDir, "does-not-exist")), []);
});

test("readPluginsUnder finds first-level package directories", () => {
  const parent = join(workDir, "first-level");
  const a = makePackage(join(parent, "a"));
  const b = makePackage(join(parent, "b"));

  assert.deepEqual(readPluginsUnder(parent).sort(), [a, b].sort());
});

test("readPluginsUnder recurses into directories that are not themselves packages", () => {
  // Mirrors the recursive pnpm-workspace exclusion glob: a provider nested
  // deeper than one level must still be discovered.
  const parent = join(workDir, "nested");
  const nested = makePackage(join(parent, "vendor", "my-plugin"));

  assert.deepEqual(readPluginsUnder(parent), [nested]);
});

test("readPluginsUnder stops descending once a package.json is found and skips node_modules", () => {
  const parent = join(workDir, "boundaries");
  const pkg = makePackage(join(parent, "plugin"));
  // A nested package inside an already-matched package must not be returned.
  makePackage(join(pkg, "sub-package"));
  // node_modules must be ignored entirely.
  makePackage(join(parent, "node_modules", "some-dep"));

  assert.deepEqual(readPluginsUnder(parent), [pkg]);
});

test("linkSdkInto creates the plugin-sdk symlink and is idempotent", () => {
  const pkg = makePackage(join(workDir, "link-target"));

  assert.equal(linkSdkInto(pkg), true);

  const link = join(pkg, "node_modules", "@paperclipai", "plugin-sdk");
  assert.ok(lstatSync(link).isSymbolicLink());

  // Second call is a no-op because the link already points at the in-repo SDK.
  assert.equal(linkSdkInto(pkg), false);
});

test("linkSdkInto leaves a real (non-symlink) install in place", () => {
  const pkg = makePackage(join(workDir, "real-install"));
  const scopeDir = join(pkg, "node_modules", "@paperclipai");
  mkdirSync(scopeDir, { recursive: true });
  // Simulate a published-tarball install: a real directory, not a symlink.
  makePackage(join(scopeDir, "plugin-sdk"));

  assert.equal(linkSdkInto(pkg), false);
  assert.ok(!lstatSync(join(scopeDir, "plugin-sdk")).isSymbolicLink());
});

test("linkSdkInto replaces a symlink that points somewhere else", () => {
  const pkg = makePackage(join(workDir, "stale-link"));
  const scopeDir = join(pkg, "node_modules", "@paperclipai");
  mkdirSync(scopeDir, { recursive: true });
  symlinkSync("../somewhere-else", join(scopeDir, "plugin-sdk"), "dir");

  assert.equal(linkSdkInto(pkg), true);
  assert.notEqual(readlinkSync(join(scopeDir, "plugin-sdk")), "../somewhere-else");
  assert.ok(existsSync(scopeDir));
});

test("symlinkAcceptingIdenticalRaceWinner tolerates a concurrent linker that wrote the same link", () => {
  // The lstat probe in linkSdkInto and the symlink call are not atomic, so a
  // concurrent linker can create the link in between. An identical link means
  // our work is already done.
  const scopeDir = join(workDir, "race-identical");
  mkdirSync(scopeDir, { recursive: true });
  const link = join(scopeDir, "plugin-sdk");
  symlinkSync("../../sdk", link, "dir");

  assert.doesNotThrow(() => symlinkAcceptingIdenticalRaceWinner("../../sdk", link));
  assert.equal(readlinkSync(link), "../../sdk");
});

test("symlinkAcceptingIdenticalRaceWinner rethrows when the racing link points elsewhere", () => {
  const scopeDir = join(workDir, "race-divergent");
  mkdirSync(scopeDir, { recursive: true });
  const link = join(scopeDir, "plugin-sdk");
  symlinkSync("../../somewhere-else", link, "dir");

  assert.throws(() => symlinkAcceptingIdenticalRaceWinner("../../sdk", link), { code: "EEXIST" });
});

test("no workspace-member plugin runs the shared linker from its own postinstall", () => {
  // pnpm runs a workspace member's postinstall concurrently with the root one.
  // Both call this script, both walk the same excluded-plugin list, and the
  // loser of the symlink race fails the entire install with EEXIST. The root
  // postinstall already covers every excluded plugin, so a member's own hook is
  // pure duplication. Packages excluded from the workspace are the exception:
  // they never see the root hook when installed standalone.
  const excluded = new Set(excludedPluginDirs());
  const offenders = [];

  for (const packageDir of readPluginsUnder(join(repoRoot, "packages", "plugins"))) {
    if (excluded.has(packageDir)) continue;
    const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
    const postinstall = manifest.scripts?.postinstall ?? "";
    if (postinstall.includes("link-plugin-dev-sdk")) offenders.push(manifest.name);
  }

  assert.deepEqual(offenders, []);
});
