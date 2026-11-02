import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  fastUriAdvisoriesFor,
  fastUriLockfileVersions,
  isVulnerableFastUri,
} from "./fast-uri-advisory.js";

const execFileAsync = promisify(execFile);
const repoRoot = new URL("..", import.meta.url);

function assertIncludes(haystack, needle, label) {
  assert.ok(haystack.includes(needle), `${label} missing ${needle}`);
}

// pnpm.overrides writes every undici floor as ">=X.Y.Z <MAJOR". Parse that
// shape instead of hand-copying the numbers into an assertion: a hand-copied
// literal is exactly how this file came to name an unreachable version.
// 76b5fc78 bumped the override to 6.29.1 and transcribed "undici@6.29.1:"
// here, and nothing tied the two together afterwards.
const FLOOR = /^>=(\d+)\.(\d+)\.(\d+) <(\d+)$/;

function parseFloor(range, label) {
  const match = FLOOR.exec(String(range ?? ""));
  assert.ok(
    match,
    `${label} is not declared as ">=X.Y.Z <MAJOR" (got ${range})`,
  );
  return {
    raw: range,
    min: [Number(match[1]), Number(match[2]), Number(match[3])],
    majorBelow: Number(match[4]),
  };
}

function compareVersions(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

// Every version `pattern` matches in the lockfile, read off the two-space
// resolution keys rather than the deeper dependency edges nested under each
// parent, so a package resolved once is counted once per lockfile section.
// `pattern` must be a global regex capturing major, minor and patch.
function lockfileResolutions(lockfile, pattern) {
  return Array.from(lockfile.matchAll(pattern), ([, major, minor, patch]) => [
    Number(major),
    Number(minor),
    Number(patch),
  ]);
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
      [
        "install",
        "--lockfile-only",
        "--frozen-lockfile=false",
        "--ignore-scripts",
      ],
      fixtureRoot,
    );

    const packageJson = JSON.parse(
      await readFile(join(fixtureRoot, "package.json"), "utf8"),
    );
    assert.equal(packageJson.pnpm.overrides["fast-uri"], "^3.1.6");

    const lockfile = await readFile(
      join(fixtureRoot, "pnpm-lock.yaml"),
      "utf8",
    );
    // Scan + count cross-check live in fast-uri-advisory.js, where the CI-run
    // test pins every key shape. This file is referenced by no workflow.
    const fastUriEntries = fastUriLockfileVersions(lockfile);
    assert.ok(
      fastUriEntries.length > 0,
      "lockfile missing fast-uri resolution",
    );
    for (const version of fastUriEntries) {
      assert.ok(
        !isVulnerableFastUri(version),
        `lockfile resolved fast-uri ${version}, vulnerable per ${fastUriAdvisoriesFor(version).join(", ")}`,
      );
    }

    const designerLockfile = JSON.parse(
      await readFile(
        join(fixtureRoot, "packages/services/designer/package-lock.json"),
        "utf8",
      ),
    );
    // Enumerate every nested resolution, not just the top-level node — a
    // second copy under a transitive dependency is exactly what a floor guard
    // exists to catch. Asserting the set is non-empty keeps a dropped
    // dependency from reading as "nothing vulnerable found".
    const designerResolutions = Object.entries(
      designerLockfile.packages,
    ).filter(
      ([path]) =>
        path === "node_modules/fast-uri" ||
        path.endsWith("/node_modules/fast-uri"),
    );
    assert.ok(
      designerResolutions.length > 0,
      "designer lockfile missing fast-uri resolution",
    );
    for (const [path, fastUri] of designerResolutions) {
      assert.ok(
        !isVulnerableFastUri(fastUri.version),
        `designer lockfile ${path} resolved fast-uri ${fastUri.version}, vulnerable per ${fastUriAdvisoriesFor(fastUri.version).join(", ")}`,
      );
    }
    // PEN-5277: @cursor/sdk 1.0.40 replaced @connectrpc/connect-node (an
    // undici transport) with @connectrpc/connect-web (which uses fetch), so
    // no undici 6.x path remains in the graph. The
    // `@connectrpc/connect-node>undici` override and its
    // securityAuditRemediations entry are KEPT: an override for an absent
    // path is dormant, not dead, and re-arms the floor the moment anything
    // pulls that subtree back in.
    //
    // So assert the PROPERTY that override enforces rather than a literal
    // version string. The two pins this replaces failed in both directions:
    // `undici@6.29.1:` went red when the path legitimately left (this
    // ticket), and the companion regex required the parent to be
    // `@connectrpc/connect-node@1.7.0` exactly, so it would have matched
    // NOTHING -- and therefore asserted nothing -- had the subtree come back
    // at any other version. Checking every 6.x resolution instead binds the
    // floor to the dependency whose version it is about, from any parent.
    const connectNodeUndiciFloor = parseFloor(
      packageJson.pnpm.overrides["@connectrpc/connect-node>undici"],
      "pnpm.overrides['@connectrpc/connect-node>undici']",
    );
    const undiciResolutions = lockfileResolutions(
      lockfile,
      /^  undici@(\d+)\.(\d+)\.(\d+)(?=[:(])/gm,
    );
    // Non-emptiness is the anti-rot anchor, and it is the assertion this file
    // was missing. A bare "no vulnerable version found" loop reads a
    // dependency vanishing out of the tree as success, which is the precise
    // way the pin above rotted unnoticed.
    assert.ok(
      undiciResolutions.length > 0,
      "lockfile missing undici resolution",
    );
    for (const version of undiciResolutions) {
      const governedByFloor =
        version[0] >= connectNodeUndiciFloor.min[0] &&
        version[0] < connectNodeUndiciFloor.majorBelow;
      if (!governedByFloor) continue;
      assert.ok(
        compareVersions(version, connectNodeUndiciFloor.min) >= 0,
        `lockfile resolved undici ${version.join(".")}, below the declared ${connectNodeUndiciFloor.raw} floor`,
      );
    }
    assertIncludes(lockfile, "undici@7.30.1:", "lockfile");
    assertIncludes(lockfile, "multer@2.5.0:", "lockfile");
    assertIncludes(lockfile, "'@babel/core@7.29.7':", "lockfile");
    assertIncludes(lockfile, "esbuild@0.28.1:", "lockfile");
    assertIncludes(lockfile, "js-yaml@4.3.2:", "lockfile");
    const uiViteConfig = await readFile(
      join(fixtureRoot, "ui/vite.config.ts"),
      "utf8",
    );
    assertIncludes(
      uiViteConfig,
      'const UI_ESBUILD_TARGET = "es2022";',
      "ui vite config",
    );
    assertIncludes(uiViteConfig, "optimizeDeps", "ui vite config");
    assert.match(
      lockfile,
      /^  jsdom@28\.1\.0(?:\([^\n]*\))?:\n(?: {4,}[^\n]*\n)*?      undici: 7\.30\.1$/m,
      "jsdom must resolve undici 7.30.1",
    );

    const audit = await runPnpm(
      ["audit", "--prod", "--json"],
      fixtureRoot,
      true,
    );
    const auditJson = JSON.parse(audit.stdout);
    assert.equal(auditJson.metadata.vulnerabilities.moderate, 0);
    assert.equal(auditJson.metadata.vulnerabilities.high, 0);
    assert.equal(auditJson.metadata.vulnerabilities.critical, 0);
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
}

await main();
