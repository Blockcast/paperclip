import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = new URL("..", import.meta.url);

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    const difference = left[index] - right[index];
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

function isBetweenInclusive(version, minimum, maximum) {
  return compareVersions(version, minimum) >= 0 && compareVersions(version, maximum) <= 0;
}

function isVulnerableBraceExpansionVersion(version) {
  const [major, minor, patch] = version;
  return (
    compareVersions(version, [1, 1, 18]) < 0 ||
    isBetweenInclusive(version, [2, 0, 0], [2, 1, 3]) ||
    isBetweenInclusive(version, [3, 0, 0], [3, 0, 5]) ||
    major === 4 ||
    (major === 5 && minor === 0 && patch <= 8)
  );
}

test("brace-expansion resolves at the GHSA-rgw5-rvv9-x895 patched floor", async () => {
  const tmpRoot = await mkdtemp(join(tmpdir(), "paperclip-brace-expansion-"));
  const fixtureRoot = join(tmpRoot, "repo");

  try {
    await cp(new URL(".", repoRoot), fixtureRoot, {
      recursive: true,
      filter: (source) =>
        !source.includes("/node_modules") &&
        !source.includes("/.git") &&
        !source.includes("/data/pglite"),
    });

    // Human and agent PRs do not commit pnpm-lock.yaml. Recreate the exact
    // policy-job artifact in a disposable fixture before asserting resolution.
    await execFileAsync(
      "pnpm",
      ["install", "--lockfile-only", "--ignore-scripts", "--no-frozen-lockfile"],
      { cwd: fixtureRoot, maxBuffer: 1024 * 1024 * 20 },
    );

    const packageJson = JSON.parse(
      await readFile(join(fixtureRoot, "package.json"), "utf8"),
    );
    const lockfile = await readFile(join(fixtureRoot, "pnpm-lock.yaml"), "utf8");

    assert.equal(packageJson.pnpm.overrides["brace-expansion"], "5.0.9");
    assert.equal(
      packageJson.pnpm.patchedDependencies["brace-expansion@5.0.9"],
      "patches/brace-expansion@5.0.9.patch",
    );
    assert.match(
      lockfile,
      /^  brace-expansion@5\.0\.9:\n    resolution: \{integrity: .+\}$/m,
    );
    assert.match(
      lockfile,
      /^  brace-expansion@5\.0\.9:\n    hash: \S+\n    path: patches\/brace-expansion@5\.0\.9\.patch$/m,
    );
    assert.match(lockfile, /^  brace-expansion@5\.0\.9\(patch_hash=[^)]+\):$/m);

    const vulnerableVersions = Array.from(
      lockfile.matchAll(/^  brace-expansion@(\d+)\.(\d+)\.(\d+)(?=[:(])/gm),
      ([, major, minor, patch]) => [Number(major), Number(minor), Number(patch)],
    )
      .filter(isVulnerableBraceExpansionVersion)
      .map((version) => version.join("."));
    assert.deepEqual(
      vulnerableVersions,
      [],
      "the regenerated lockfile must not resolve vulnerable brace-expansion versions",
    );
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
});
