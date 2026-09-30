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
    // Two advisories bound v5 and the later one is the binding constraint:
    // GHSA-qhr7-859c-m2p7 / CVE-2026-102278 (BLO-38294) covers >= 4.0.0, < 5.0.11,
    // and GHSA-q2hr-2g5m-vwhr covers >= 4.0.0, < 5.0.12. 5.0.12 is the floor that
    // clears both — and the one `dependency-review-action` enforces on this PR.
    (major === 5 && minor === 0 && patch <= 11)
  );
}

test("brace-expansion resolves at the GHSA-qhr7-859c-m2p7 + GHSA-q2hr-2g5m-vwhr patched floor", async () => {
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

    assert.equal(packageJson.pnpm.overrides["brace-expansion"], "5.0.12");
    assert.equal(
      packageJson.pnpm.patchedDependencies["brace-expansion@5.0.12"],
      "patches/brace-expansion@5.0.12.patch",
    );
    assert.match(
      lockfile,
      /^  brace-expansion@5\.0\.12:\n    resolution: \{integrity: .+\}$/m,
    );
    assert.match(
      lockfile,
      /^  brace-expansion@5\.0\.12:\n    hash: \S+\n    path: patches\/brace-expansion@5\.0\.12\.patch$/m,
    );
    assert.match(lockfile, /^  brace-expansion@5\.0\.12\(patch_hash=[^)]+\):$/m);

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
