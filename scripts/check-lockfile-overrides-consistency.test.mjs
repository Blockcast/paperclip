import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { findLockfileOverrideMismatches } from "./check-lockfile-overrides-consistency.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function minimalPackageJson(overrides, patchedDependencies) {
  return JSON.stringify({
    name: "fixture",
    pnpm: { overrides, patchedDependencies },
  });
}

function minimalLockfile({ overrides, patches }) {
  // Values are inserted as raw YAML scalars (already quoted by the caller
  // when needed), matching how pnpm actually emits pnpm-lock.yaml — not
  // JS-string-encoded, which would double-quote an already-quoted scalar.
  const overrideLines = Object.entries(overrides)
    .map(([key, value]) => `  ${key}: ${value}`)
    .join("\n");
  const patchLines = Object.entries(patches)
    .map(([key, { hash, path: patchPath }]) => `  ${key}:\n    hash: ${hash}\n    path: ${patchPath}`)
    .join("\n");
  return [
    "lockfileVersion: '9.0'",
    "",
    "overrides:",
    overrideLines,
    "",
    "patchedDependencies:",
    patchLines,
    "",
    "importers:",
    "  .:",
    "    dependencies: {}",
    "",
  ].join("\n");
}

test("reports no mismatches when package.json and pnpm-lock.yaml agree", () => {
  const packageJson = minimalPackageJson(
    { "brace-expansion": "5.0.9" },
    { "brace-expansion@5.0.9": "patches/brace-expansion@5.0.9.patch" },
  );
  const lockfile = minimalLockfile({
    overrides: { "brace-expansion": "5.0.9" },
    patches: {
      "brace-expansion@5.0.9": { hash: "abc123", path: "patches/brace-expansion@5.0.9.patch" },
    },
  });

  assert.deepEqual(findLockfileOverrideMismatches(packageJson, lockfile), []);
});

// BLO-24169: `08b6f44916103b624744dff6453997f85e67265b` bumped
// pnpm.overrides["brace-expansion"] to 5.0.9 in package.json without
// regenerating pnpm-lock.yaml, which still recorded 5.0.8. Every
// `pnpm install --frozen-lockfile` on the resulting tree failed with
// ERR_PNPM_LOCKFILE_CONFIG_MISMATCH. This reproduces that exact drift.
test("flags a bumped override that was never regenerated in the lockfile (BLO-24169 reproduction)", () => {
  const packageJson = minimalPackageJson(
    { "brace-expansion": "5.0.9" },
    { "brace-expansion@5.0.9": "patches/brace-expansion@5.0.9.patch" },
  );
  const lockfile = minimalLockfile({
    overrides: { "brace-expansion": "5.0.8" },
    patches: {
      "brace-expansion@5.0.8": { hash: "abc123", path: "patches/brace-expansion@5.0.8.patch" },
    },
  });

  const mismatches = findLockfileOverrideMismatches(packageJson, lockfile);
  assert.ok(
    mismatches.some((m) => m.includes('pnpm.overrides["brace-expansion"]') && m.includes("5.0.9") && m.includes("5.0.8")),
    `expected an override-value mismatch, got: ${JSON.stringify(mismatches)}`,
  );
  assert.ok(
    mismatches.some((m) => m.includes("brace-expansion@5.0.9") && m.includes("no matching entry")),
    `expected a missing-patch mismatch, got: ${JSON.stringify(mismatches)}`,
  );
});

test("flags an override present only in the lockfile, not in package.json", () => {
  const packageJson = minimalPackageJson({}, {});
  const lockfile = minimalLockfile({ overrides: { rollup: ">=4.59.0" }, patches: {} });

  const mismatches = findLockfileOverrideMismatches(packageJson, lockfile);
  assert.ok(mismatches.some((m) => m.includes("rollup") && m.includes("no matching pnpm.overrides entry")));
});

test("handles quoted keys and values the same as unquoted ones", () => {
  const packageJson = minimalPackageJson({ "@anthropic-ai/sdk": ">=0.91.1 <6" }, {});
  const lockfile = minimalLockfile({
    overrides: { "'@anthropic-ai/sdk'": "'>=0.91.1 <6'" },
    patches: {},
  });

  assert.deepEqual(findLockfileOverrideMismatches(packageJson, lockfile), []);
});

test("the repo's own package.json and pnpm-lock.yaml are consistent right now", () => {
  const packageJson = readFileSync(path.join(repoRoot, "package.json"), "utf8");
  const lockfile = readFileSync(path.join(repoRoot, "pnpm-lock.yaml"), "utf8");

  assert.deepEqual(findLockfileOverrideMismatches(packageJson, lockfile, { repoRoot }), []);
});

// Reviewer follow-up on BLO-24169 (#1273): the checks above only compare the
// *path* recorded for a patch, not the hash. Editing an existing patch
// file's content — without touching package.json or renaming the patch —
// changes what pnpm must apply but leaves every field these checks look at
// unchanged, so the drift was previously invisible until `pnpm install
// --frozen-lockfile` rejected the stale hash on master.
test("flags a patch file whose content no longer matches the lockfile's recorded hash", () => {
  const fixtureDir = mkdtempSync(path.join(tmpdir(), "lockfile-patch-hash-"));
  try {
    writeFileSync(path.join(fixtureDir, "some-package@1.0.0.patch"), "diff --git a/index.js b/index.js\n");

    const packageJson = minimalPackageJson({}, { "some-package@1.0.0": "some-package@1.0.0.patch" });
    const lockfile = minimalLockfile({
      overrides: {},
      patches: {
        "some-package@1.0.0": { hash: "thishashisstale00000000000", path: "some-package@1.0.0.patch" },
      },
    });

    const mismatches = findLockfileOverrideMismatches(packageJson, lockfile, { repoRoot: fixtureDir });
    assert.ok(
      mismatches.some((m) => m.includes('patchedDependencies["some-package@1.0.0"].hash') && m.includes("doesn't match")),
      `expected a stale patch-hash mismatch, got: ${JSON.stringify(mismatches)}`,
    );
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test("does not flag patch hashes when repoRoot is omitted (path-only fixtures with no files on disk)", () => {
  const packageJson = minimalPackageJson({}, { "some-package@1.0.0": "some-package@1.0.0.patch" });
  const lockfile = minimalLockfile({
    overrides: {},
    patches: {
      "some-package@1.0.0": { hash: "whatever-not-checked-here00", path: "some-package@1.0.0.patch" },
    },
  });

  assert.deepEqual(findLockfileOverrideMismatches(packageJson, lockfile), []);
});
