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
    // Every arm is the STRICTEST floor of the whole advisory set for that major,
    // not the floor of whichever advisory prompted the last bump. Re-derive with:
    //   gh api 'advisories?ecosystem=npm&affects=brace-expansion&per_page=50'
    // and take the highest first_patched_version per major. Ten advisories affect
    // this package as of 2026-09-30; eight of them carry a v5 range.
    compareVersions(version, [1, 1, 21]) < 0 || // GHSA-q2hr-2g5m-vwhr
    isBetweenInclusive(version, [2, 0, 0], [2, 1, 6]) || // GHSA-q2hr-2g5m-vwhr, < 2.1.7
    // No v3 or v4 release is patched for GHSA-3jxr-9vmj-r5cp: its range is
    // >= 3.0.0, < 5.0.7 and its only fix is 5.0.7, so both majors are vulnerable
    // in full. v3 is NOT bounded at 3.0.9 (GHSA-q2hr's v3 floor) for that reason.
    major === 3 ||
    major === 4 ||
    // GHSA-q2hr-2g5m-vwhr is the binding v5 constraint at >= 4.0.0, < 5.0.12 —
    // stricter than GHSA-qhr7-859c-m2p7 / CVE-2026-102278 (BLO-38294, < 5.0.11),
    // which is the advisory this pin was originally raised for. 5.0.12 clears the
    // set, and is what `dependency-review-action` enforces on this PR.
    (major === 5 && minor === 0 && patch <= 11)
  );
}

test("the vulnerability predicate matches the advisory floors it claims", () => {
  // Boundary pairs: last vulnerable version, then first clean one. The v1/v2/v3
  // arms sat three advisories stale behind the v5 arm until BLO-38294 because
  // nothing exercised them — the lockfile only ever resolves v5 under the
  // override, so the other arms are dead weight in the live assertion below.
  for (const version of [
    [1, 1, 20], [2, 1, 6], [3, 0, 9], [3, 9, 9], [4, 0, 1], [5, 0, 11],
  ]) {
    assert.equal(
      isVulnerableBraceExpansionVersion(version),
      true,
      `${version.join(".")} is inside a live advisory range`,
    );
  }
  for (const version of [[1, 1, 21], [2, 1, 7], [5, 0, 12], [5, 1, 0], [6, 0, 0]]) {
    assert.equal(
      isVulnerableBraceExpansionVersion(version),
      false,
      `${version.join(".")} is outside every advisory range`,
    );
  }
});

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
