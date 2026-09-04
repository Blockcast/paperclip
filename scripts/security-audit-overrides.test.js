import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { FAST_URI_ADVISORY, isVulnerableFastUri } from "./fast-uri-advisory.js";

const execFileAsync = promisify(execFile);
const repoRoot = new URL("..", import.meta.url);

function assertIncludes(haystack, needle, label) {
  assert.ok(haystack.includes(needle), `${label} missing ${needle}`);
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
    assert.equal(packageJson.pnpm.overrides["fast-uri"], "^3.1.6");

    const lockfile = await readFile(join(fixtureRoot, "pnpm-lock.yaml"), "utf8");
    const fastUriResolutions = [
      ...lockfile.matchAll(/^  fast-uri@(\d+\.\d+\.\d+):$/gm),
    ].map((match) => match[1]);
    assert.ok(
      fastUriResolutions.length > 0,
      "lockfile missing fast-uri resolution",
    );
    for (const version of fastUriResolutions) {
      assert.ok(
        !isVulnerableFastUri(version),
        `lockfile resolved fast-uri ${version}, vulnerable per ${FAST_URI_ADVISORY}`,
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
        `designer lockfile ${path} resolved fast-uri ${fastUri.version}, vulnerable per ${FAST_URI_ADVISORY}`,
      );
    }
    assertIncludes(lockfile, "undici@6.27.0:", "lockfile");
    assertIncludes(lockfile, "undici@7.29.0:", "lockfile");
    assertIncludes(lockfile, "multer@2.2.0:", "lockfile");
    assertIncludes(lockfile, "'@babel/core@7.29.7':", "lockfile");
    assertIncludes(lockfile, "esbuild@0.28.1:", "lockfile");
    assertIncludes(lockfile, "js-yaml@4.3.1:", "lockfile");
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
