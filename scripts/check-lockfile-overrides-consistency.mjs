#!/usr/bin/env node
// BLO-24169: pnpm's `--frozen-lockfile` install refuses to proceed when
// package.json's `pnpm.overrides` (or `pnpm.patchedDependencies`) disagrees
// with the `overrides:` / `patchedDependencies:` blocks recorded in
// pnpm-lock.yaml. That mismatch is invisible to the `pull_request` lane today
// because `policy` only regenerates a lockfile in-memory for jobs to consume;
// it never fails the check or asserts the committed lockfile itself is
// consistent. A batched merge-queue run can then land a `package.json` bump
// next to a lockfile that predates it, breaking every `pnpm install
// --frozen-lockfile` on master until someone notices. This script makes that
// drift a deterministic, dependency-free, pre-merge failure instead.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function unquoteYamlScalar(raw) {
  const trimmed = raw.trim();
  if (trimmed.length >= 2 && trimmed[0] === "'" && trimmed[trimmed.length - 1] === "'") {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  if (trimmed.length >= 2 && trimmed[0] === '"' && trimmed[trimmed.length - 1] === '"') {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function unquoteYamlKey(raw) {
  return unquoteYamlScalar(raw);
}

// Extracts a flat, 2-space-indented `<blockName>:\n  key: value` mapping from
// pnpm-lock.yaml. Sufficient for `overrides:` — pnpm never nests values there.
function parseFlatYamlBlock(lockfileText, blockName) {
  const lines = lockfileText.split("\n");
  const startIndex = lines.findIndex((line) => line === `${blockName}:`);
  if (startIndex === -1) return null;

  const entries = new Map();
  for (let i = startIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === "" || line.startsWith("  # ")) continue;
    if (!line.startsWith("  ") || line.startsWith("   ")) break;
    const separatorIndex = line.indexOf(": ");
    if (separatorIndex === -1) break;
    const key = unquoteYamlKey(line.slice(2, separatorIndex));
    const value = unquoteYamlScalar(line.slice(separatorIndex + 2));
    entries.set(key, value);
  }
  return entries;
}

// `patchedDependencies:` nests a `hash:`/`path:` pair per package under a
// 2-space key, at 4-space indent — one level deeper than `overrides:`.
function parsePatchedDependenciesBlock(lockfileText) {
  const lines = lockfileText.split("\n");
  const startIndex = lines.findIndex((line) => line === "patchedDependencies:");
  if (startIndex === -1) return null;

  const entries = new Map();
  let currentKey = null;
  for (let i = startIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === "") continue;
    if (!line.startsWith("  ")) break;

    if (line.startsWith("    ")) {
      if (currentKey === null) break;
      const separatorIndex = line.indexOf(": ");
      if (separatorIndex === -1) continue;
      const field = line.slice(4, separatorIndex).trim();
      const value = unquoteYamlScalar(line.slice(separatorIndex + 2));
      entries.get(currentKey)[field] = value;
      continue;
    }

    if (line.startsWith("   ")) break; // 3-space: not a shape we expect.
    const key = unquoteYamlKey(line.slice(2, -1));
    currentKey = key;
    entries.set(key, {});
  }
  return entries;
}

/**
 * Compares package.json's `pnpm.overrides` / `pnpm.patchedDependencies`
 * against the corresponding blocks in pnpm-lock.yaml. Returns a list of
 * human-readable mismatch descriptions; an empty list means consistent.
 */
export function findLockfileOverrideMismatches(packageJsonText, lockfileText) {
  const packageJson = JSON.parse(packageJsonText);
  const declaredOverrides = packageJson.pnpm?.overrides ?? {};
  const declaredPatches = packageJson.pnpm?.patchedDependencies ?? {};

  const mismatches = [];

  const lockedOverrides = parseFlatYamlBlock(lockfileText, "overrides") ?? new Map();
  const declaredOverrideKeys = new Set(Object.keys(declaredOverrides));
  const lockedOverrideKeys = new Set(lockedOverrides.keys());

  for (const key of declaredOverrideKeys) {
    const declaredValue = String(declaredOverrides[key]);
    if (!lockedOverrides.has(key)) {
      mismatches.push(
        `pnpm.overrides["${key}"] = "${declaredValue}" in package.json has no matching entry in pnpm-lock.yaml's overrides: block`,
      );
      continue;
    }
    const lockedValue = lockedOverrides.get(key);
    if (lockedValue !== declaredValue) {
      mismatches.push(
        `pnpm.overrides["${key}"] = "${declaredValue}" in package.json but pnpm-lock.yaml records "${lockedValue}" — run "pnpm install --lockfile-only" and commit the result`,
      );
    }
  }

  for (const key of lockedOverrideKeys) {
    if (!declaredOverrideKeys.has(key)) {
      mismatches.push(
        `pnpm-lock.yaml's overrides: block has "${key}": "${lockedOverrides.get(key)}" with no matching pnpm.overrides entry in package.json`,
      );
    }
  }

  const lockedPatches = parsePatchedDependenciesBlock(lockfileText) ?? new Map();
  const declaredPatchKeys = new Set(Object.keys(declaredPatches));
  const lockedPatchKeys = new Set(lockedPatches.keys());

  for (const key of declaredPatchKeys) {
    const declaredPath = declaredPatches[key];
    if (!lockedPatches.has(key)) {
      mismatches.push(
        `pnpm.patchedDependencies["${key}"] in package.json has no matching entry in pnpm-lock.yaml's patchedDependencies: block`,
      );
      continue;
    }
    const lockedPath = lockedPatches.get(key).path;
    if (lockedPath !== declaredPath) {
      mismatches.push(
        `pnpm.patchedDependencies["${key}"] = "${declaredPath}" in package.json but pnpm-lock.yaml records path "${lockedPath}"`,
      );
    }
  }

  for (const key of lockedPatchKeys) {
    if (!declaredPatchKeys.has(key)) {
      mismatches.push(
        `pnpm-lock.yaml's patchedDependencies: block has "${key}" with no matching pnpm.patchedDependencies entry in package.json`,
      );
    }
  }

  return mismatches;
}

function main() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const packageJsonText = readFileSync(path.join(repoRoot, "package.json"), "utf8");
  const lockfileText = readFileSync(path.join(repoRoot, "pnpm-lock.yaml"), "utf8");

  const mismatches = findLockfileOverrideMismatches(packageJsonText, lockfileText);
  if (mismatches.length === 0) {
    console.log("pnpm-lock.yaml overrides/patchedDependencies match package.json.");
    return;
  }

  console.error("pnpm-lock.yaml is out of sync with package.json's pnpm.overrides/patchedDependencies:");
  for (const mismatch of mismatches) {
    console.error(`  - ${mismatch}`);
  }
  console.error('\nRun "pnpm install --lockfile-only" and commit the regenerated pnpm-lock.yaml.');
  process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
