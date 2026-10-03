#!/usr/bin/env node
/**
 * check-no-raw-nul.mjs
 *
 * Fails if a tracked source file contains a raw NUL (0x00) byte.
 *
 * Why this is a hard error and not a style nit: a single NUL byte makes the
 * whole file read as *binary* to the agent toolchain. Claude Code shadows
 * `grep` with `ugrep -I` (skip binary files), so such a file is silently
 * skipped — `grep -c` prints nothing at all and exits 1, which is
 * indistinguishable from "the symbol is not in this file". That is a
 * false-absence reading: it terminates the search instead of failing loudly.
 * Measured on BLO-39632: five files, 799 matching lines, all invisible.
 *
 * Write the escape (`\u0000`) instead of the byte. It is the identical string
 * at runtime and is already this repo's dominant convention.
 */

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Allowlist, not a binary denylist: an unknown new extension is skipped rather
// than flagged, so this can only ever miss a file — never fail a real asset.
export const SOURCE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json", ".md", ".mdx",
  ".yml", ".yaml", ".sh", ".bash", ".sql", ".css", ".scss", ".html", ".toml",
  ".py", ".go", ".svg",
]);

export function isSourcePath(relative) {
  return SOURCE_EXTENSIONS.has(path.extname(relative).toLowerCase());
}

/** Pure core: given tracked paths and a byte reader, list every NUL offense. */
export function findRawNulOffenses({ files, read }) {
  const offenses = [];

  for (const relative of files) {
    if (!isSourcePath(relative)) continue;

    let buffer;
    try {
      buffer = read(relative);
    } catch (err) {
      // Only the deleted-file race is benign. EACCES/EISDIR/EMFILE must be
      // loud: a guard against silent skips cannot itself skip silently.
      if (err?.code === "ENOENT") continue;
      // Name the guard, or the operator sees a bare errno with no idea which
      // check failed or why an unreadable file is fatal here.
      const wrapped = new Error(
        `check-no-raw-nul (BLO-39632): cannot read tracked source file ${relative}, so it` +
          ` could not be cleared of NUL bytes: ${err?.message ?? err}`,
        { cause: err },
      );
      wrapped.code = err?.code;
      throw wrapped;
    }

    let index = buffer.indexOf(0);
    while (index !== -1) {
      offenses.push({
        relative,
        lineNumber: buffer.subarray(0, index).filter((byte) => byte === 0x0a).length + 1,
      });
      index = buffer.indexOf(0, index + 1);
    }
  }

  return offenses;
}

export function runCheck({
  repoRoot,
  exec = execSync,
  read = (relative) => readFileSync(path.join(repoRoot, relative)),
  log = console.log,
  error = console.error,
}) {
  const files = exec("git ls-files -z", { encoding: "buffer", cwd: repoRoot })
    .toString("utf8")
    .split("\0")
    .filter(Boolean);

  const offenses = findRawNulOffenses({ files, read });

  if (offenses.length > 0) {
    error("ERROR: raw NUL (0x00) byte found in tracked source files:\n");
    for (const offense of offenses) {
      error(`  ${offense.relative}:${offense.lineNumber}`);
    }
    error(
      "\nA NUL byte makes the file read as binary, so the agent `grep` (ugrep -I) skips it" +
        " silently — every search of that file returns a false absence. Replace the byte with" +
        " the `\\u0000` escape; it is the identical string at runtime. See BLO-39632.",
    );
    return 1;
  }

  log("  ✓  No raw NUL bytes in tracked source files.");
  return 0;
}

function isMainModule() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  process.exit(runCheck({ repoRoot: process.cwd() }));
}
