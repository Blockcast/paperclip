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

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RFC4648_BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

// Reproduces @pnpm/crypto.base32-hash's createBase32HashFromFile, which is
// what pnpm 9.x uses to compute a patchedDependencies[*].hash: normalize
// CRLF to LF, MD5 the content, RFC4648 base32-encode the digest, strip
// padding, lowercase. Verified against this repo's own committed patch
// hashes (e.g. patches/brace-expansion@5.0.9.patch -> the hash already
// recorded for it in pnpm-lock.yaml) so the check stays dependency-free —
// no `pnpm install` is needed to catch a stale hash.
function computePnpmPatchHash(content) {
  const digest = createHash("md5")
    .update(content.split("\r\n").join("\n"), "utf8")
    .digest();

  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of digest) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += RFC4648_BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += RFC4648_BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output.toLowerCase();
}

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

// BLO-27241: a parser that `break`s out of a block on an unrecognised line
// returns a *partial* Map that is structurally indistinguishable from a
// complete parse, and an entry that was never parsed can never mismatch — so
// the caller reports green on a lockfile it only partly read. Every
// unexpected shape therefore throws instead of truncating: for a guard,
// "I could not read this" must never be reported as "this agrees".
function malformedBlock(blockName, lineNumber, reason) {
  throw new Error(
    `Malformed ${blockName}: block at pnpm-lock.yaml line ${lineNumber} ${reason}. ` +
      `Refusing to report consistency from a partially-parsed lockfile.`,
  );
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
    if (!line.startsWith("  ")) {
      // A non-indented line ends the block legitimately; a 1-space-indented
      // one is a shape we do not understand, not a terminator.
      if (line.startsWith(" ")) malformedBlock(blockName, i + 1, "has unexpected indentation");
      break;
    }
    if (line.startsWith("   ")) malformedBlock(blockName, i + 1, "has unexpected indentation");
    const separatorIndex = line.indexOf(": ");
    if (separatorIndex === -1) malformedBlock(blockName, i + 1, "has no `: ` key/value separator");
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
    if (!line.startsWith("  ")) {
      if (line.startsWith(" ")) malformedBlock("patchedDependencies", i + 1, "has unexpected indentation");
      break;
    }

    if (line.startsWith("    ")) {
      if (currentKey === null) {
        malformedBlock("patchedDependencies", i + 1, "carries metadata before any package key");
      }
      // Match `field:` followed by end-of-line or a space, rather than the
      // literal `": "`. The old `indexOf(": ")` treated `hash:x` — and any
      // future serialisation pnpm might adopt — as a line to skip, which
      // silently left `hash` undefined and disabled content verification.
      const separatorIndex = line.indexOf(":");
      const afterSeparator = separatorIndex === -1 ? undefined : line[separatorIndex + 1];
      if (separatorIndex === -1 || (afterSeparator !== undefined && afterSeparator !== " ")) {
        malformedBlock("patchedDependencies", i + 1, "has no `: ` field/value separator");
      }
      const field = line.slice(4, separatorIndex).trim();
      const value = unquoteYamlScalar(line.slice(separatorIndex + 1));
      entries.get(currentKey)[field] = value;
      continue;
    }

    if (line.startsWith("   ")) malformedBlock("patchedDependencies", i + 1, "has unexpected indentation");
    if (!line.endsWith(":")) {
      malformedBlock("patchedDependencies", i + 1, "is a package key with no trailing `:`");
    }
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
 *
 * Throws when either block cannot be parsed in full (BLO-27241). An empty
 * mismatch list is only meaningful if the whole lockfile was read: callers
 * must let the throw propagate rather than treating it as "no mismatches".
 *
 * When `repoRoot` is given, also verifies each patch file on disk hashes to
 * the value pnpm-lock.yaml recorded for it — catching a patch-content-only
 * edit that leaves the declared `path` (and therefore the override/patch
 * key comparisons above) unchanged. Omitted in tests that only exercise the
 * path/override comparisons against synthetic fixtures with no files on disk.
 */
export function findLockfileOverrideMismatches(packageJsonText, lockfileText, { repoRoot } = {}) {
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
    const lockedEntry = lockedPatches.get(key);
    if (lockedEntry.path !== declaredPath) {
      mismatches.push(
        `pnpm.patchedDependencies["${key}"] = "${declaredPath}" in package.json but pnpm-lock.yaml records path "${lockedEntry.path}"`,
      );
      continue;
    }

    // Path matches, so a stale hash is invisible to every check above —
    // this is the gap a patch-content-only edit falls through (BLO-24169
    // review follow-up).
    //
    // BLO-27241: both of the checks below used to sit behind
    // `if (repoRoot && lockedEntry.hash)`, so an absent, empty, or unparsed
    // hash silently skipped *and* disabled the missing-file check, and the
    // guard reported green. A missing hash is now itself a mismatch, and
    // file existence is verified independently of it.
    if (!lockedEntry.hash) {
      mismatches.push(
        `pnpm-lock.yaml's patchedDependencies["${key}"] records no non-empty hash, so the content of "${declaredPath}" cannot be verified — run "pnpm install --lockfile-only" and commit the result`,
      );
    }

    // Only checkable when we have a repoRoot to read the actual patch file
    // from. Omitted in tests that only exercise the path/override
    // comparisons against synthetic fixtures with no files on disk.
    if (repoRoot) {
      const patchFilePath = path.join(repoRoot, declaredPath);
      let patchContent;
      try {
        patchContent = readFileSync(patchFilePath, "utf8");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        mismatches.push(
          `pnpm.patchedDependencies["${key}"] points to "${declaredPath}", which does not exist in the repository`,
        );
        continue;
      }
      if (lockedEntry.hash) {
        const actualHash = computePnpmPatchHash(patchContent);
        if (actualHash !== lockedEntry.hash) {
          mismatches.push(
            `pnpm-lock.yaml's patchedDependencies["${key}"].hash ("${lockedEntry.hash}") doesn't match the content hash of the committed "${declaredPath}" ("${actualHash}") — run "pnpm install --lockfile-only" and commit the result`,
          );
        }
      }
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

  let mismatches;
  try {
    mismatches = findLockfileOverrideMismatches(packageJsonText, lockfileText, { repoRoot });
  } catch (error) {
    // BLO-27241: a shape this parser cannot read is a hard failure, not a
    // pass. Reported distinctly from a drift mismatch, because the fix is
    // different: the parser needs to learn the new shape pnpm emits.
    console.error("Could not fully parse pnpm-lock.yaml, so consistency could not be verified:");
    console.error(`  - ${error.message}`);
    console.error(
      "\nThis is a guard failure, not a lockfile drift. If pnpm changed how it serialises these blocks, update scripts/check-lockfile-overrides-consistency.mjs to parse the new shape.",
    );
    process.exitCode = 1;
    return;
  }

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
