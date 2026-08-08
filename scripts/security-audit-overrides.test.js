import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = new URL("..", import.meta.url);

function assertIncludes(haystack, needle, label) {
  assert.ok(haystack.includes(needle), `${label} missing ${needle}`);
}

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

async function runPnpm(args, cwd, allowFailure = false) {
  try {
    return await execFileAsync("pnpm", args, {
      cwd,
      maxBuffer: 1024 * 1024 * 20,
    });
  } catch (error) {
    if (allowFailure && (error.stdout || error.stderr)) {
      return { stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
    }
    throw error;
  }
}

async function main() {
  const tmpRoot = await mkdtemp(join(tmpdir(), "pen-1198-audit-"));
  const fixtureRoot = join(tmpRoot, "repo");

  try {
    await cp(new URL(".", repoRoot), fixtureRoot, {
      recursive: true,
      filter: (source) =>
        !source.includes("/node_modules") &&
        !source.includes("/.git") &&
        !source.includes("/data/pglite"),
    });

    await runPnpm(
      ["install", "--lockfile-only", "--frozen-lockfile=false", "--ignore-scripts"],
      fixtureRoot,
    );

    const packageJson = JSON.parse(
      await readFile(join(fixtureRoot, "package.json"), "utf8"),
    );
    assert.equal(packageJson.pnpm.overrides["fast-uri"], "^3.1.5");
    assert.equal(packageJson.pnpm.overrides["brace-expansion"], "5.0.9");

    const lockfile = await readFile(join(fixtureRoot, "pnpm-lock.yaml"), "utf8");
    assertIncludes(lockfile, "brace-expansion@5.0.9:", "lockfile");
    const vulnerableBraceExpansionVersions = Array.from(
      lockfile.matchAll(/^  brace-expansion@(\d+)\.(\d+)\.(\d+)(?=[:(])/gm),
      ([, major, minor, patch]) => [Number(major), Number(minor), Number(patch)],
    )
      .filter(isVulnerableBraceExpansionVersion)
      .map((version) => version.join("."));
    assert.deepEqual(
      vulnerableBraceExpansionVersions,
      [],
      "lockfile must not resolve any vulnerable brace-expansion version",
    );
    const fastUriResolution = lockfile.match(
      /^  fast-uri@(\d+)\.(\d+)\.(\d+):$/m,
    );
    assert.ok(fastUriResolution, "lockfile missing fast-uri resolution");
    const [, major, minor, patch] = fastUriResolution.map(Number);
    assert.ok(
      major > 3 || (major === 3 && (minor > 1 || (minor === 1 && patch >= 5))),
      `lockfile resolved vulnerable fast-uri ${major}.${minor}.${patch}`,
    );
    const designerLockfile = JSON.parse(
      await readFile(
        join(fixtureRoot, "packages/services/designer/package-lock.json"),
        "utf8",
      ),
    );
    const [designerMajor, designerMinor, designerPatch] = designerLockfile.packages[
      "node_modules/fast-uri"
    ].version
      .split(".")
      .map(Number);
    assert.ok(
      designerMajor > 3 ||
        (designerMajor === 3 &&
          (designerMinor > 1 || (designerMinor === 1 && designerPatch >= 5))),
      "designer lockfile resolved vulnerable fast-uri",
    );
    assertIncludes(lockfile, "undici@6.27.0:", "lockfile");
    assertIncludes(lockfile, "undici@7.29.0:", "lockfile");
    assertIncludes(lockfile, "multer@2.2.0:", "lockfile");
    assertIncludes(lockfile, "'@babel/core@7.29.7':", "lockfile");
    assertIncludes(lockfile, "esbuild@0.28.1:", "lockfile");
    assertIncludes(lockfile, "js-yaml@4.3.0:", "lockfile");
    const uiViteConfig = await readFile(join(fixtureRoot, "ui/vite.config.ts"), "utf8");
    assertIncludes(uiViteConfig, 'const UI_ESBUILD_TARGET = "es2022";', "ui vite config");
    assertIncludes(uiViteConfig, "optimizeDeps", "ui vite config");
    assert.match(
      lockfile,
      /@connectrpc\/connect-node@1\.7\.0[\s\S]*?undici: 6\.27\.0/,
      "@connectrpc/connect-node must resolve undici 6.27.0",
    );
    assert.match(
      lockfile,
      /^  jsdom@28\.1\.0(?:\([^\n]*\))?:\n(?: {4,}[^\n]*\n)*?      undici: 7\.29\.0$/m,
      "jsdom must resolve undici 7.29.0",
    );

    const audit = await runPnpm(["audit", "--prod", "--json"], fixtureRoot, true);
    const auditJson = JSON.parse(audit.stdout);
    assert.equal(auditJson.metadata.vulnerabilities.moderate, 0);
    assert.equal(auditJson.metadata.vulnerabilities.high, 0);
    assert.equal(auditJson.metadata.vulnerabilities.critical, 0);
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
}

await main();
