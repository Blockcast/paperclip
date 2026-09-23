import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// The repo declares its Vitest projects twice, in two files that no tooling
// reconciles:
//
//   1. vitest.config.ts        -- `projects`, as DIRECTORY paths.
//   2. scripts/run-vitest-stable.mjs -- `nonServerProjects`, as PACKAGE names.
//
// CI never runs (1). Both CI lanes go through (2): `--mode general` invokes
// `--project <name>` once per name in `nonServerProjects`, and `--mode
// serialized` only ever touches the server project. So a package listed in (1)
// but missing from (2) is never executed by CI, and its suite reports green
// because nothing ran it -- indistinguishable, from the outside, from a suite
// that passed.
//
// That is not hypothetical: packages/mcp-server sat in neither list and its
// suites never ran (BLO-20076), and six adapter packages sit in (1) but not (2)
// with 18 tests failing on master unnoticed (BLO-20172).
//
// This test fails when the two lists diverge.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const script = path.join(repoRoot, "scripts", "run-vitest-stable.mjs");
const vitestConfig = path.join(repoRoot, "vitest.config.ts");

// Packages that are in vitest.config.ts but deliberately NOT yet run by CI.
// Every entry needs a tracking issue; keep this empty unless a package has an
// explicit, temporary exception.
const KNOWN_UNCOVERED = new Map();

function readConfiguredProjectDirs() {
  const source = readFileSync(vitestConfig, "utf8");
  const block = /projects:\s*\[([\s\S]*?)\]/.exec(source);
  assert.ok(block, `could not locate the \`projects\` array in ${vitestConfig}`);
  const dirs = [...block[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  assert.ok(dirs.length > 0, "expected vitest.config.ts to declare at least one project");
  return dirs;
}

function packageNameFor(projectDir) {
  const manifest = path.join(repoRoot, projectDir, "package.json");
  return JSON.parse(readFileSync(manifest, "utf8")).name;
}

function driverProjects() {
  const result = spawnSync(process.execPath, [script, "--mode", "general", "--dry-run"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `dry run failed: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

// The serialized lane and the general-server group both run this project; it is
// never enumerated in nonServerProjects.
const SERVER_PROJECT = "@paperclipai/server";

test("every project in vitest.config.ts is actually executed by the CI driver", () => {
  const dryRun = driverProjects();
  const executed = new Set([...dryRun.nonServerProjects, SERVER_PROJECT]);

  const uncovered = readConfiguredProjectDirs()
    .map((dir) => ({ dir, name: packageNameFor(dir) }))
    .filter(({ name }) => !executed.has(name) && !KNOWN_UNCOVERED.has(name));

  assert.deepEqual(
    uncovered,
    [],
    `These packages are declared in vitest.config.ts but no CI lane runs them, so their ` +
      `tests silently never execute. Add each package name to \`nonServerProjects\` in ` +
      `scripts/run-vitest-stable.mjs, or record it in KNOWN_UNCOVERED with a tracking issue:\n` +
      uncovered.map(({ dir, name }) => `  - ${name} (${dir})`).join("\n"),
  );
});

test("packages/mcp-server is wired into both lists", () => {
  // Regression lock for BLO-20076. Asserted by name rather than left to the
  // generic sweep above so that a future edit to KNOWN_UNCOVERED cannot quietly
  // re-exempt the package this test was written for.
  const dirs = readConfiguredProjectDirs();
  assert.ok(
    dirs.includes("packages/mcp-server"),
    "packages/mcp-server must stay in the vitest.config.ts projects array",
  );
  assert.ok(
    driverProjects().nonServerProjects.includes("@paperclipai/mcp-server"),
    "@paperclipai/mcp-server must stay in nonServerProjects; without it CI runs nothing",
  );
  assert.ok(
    !KNOWN_UNCOVERED.has("@paperclipai/mcp-server"),
    "@paperclipai/mcp-server must not be added to KNOWN_UNCOVERED",
  );
});

test("KNOWN_UNCOVERED has no stale entries", () => {
  const dryRun = driverProjects();
  const configured = new Set(readConfiguredProjectDirs().map(packageNameFor));

  for (const [name, issue] of KNOWN_UNCOVERED) {
    assert.ok(
      configured.has(name),
      `${name} is exempted in KNOWN_UNCOVERED but is no longer in vitest.config.ts -- drop the entry (${issue})`,
    );
    assert.ok(
      !dryRun.nonServerProjects.includes(name),
      `${name} is now executed by CI -- remove it from KNOWN_UNCOVERED and close ${issue}`,
    );
  }
});

test("every driver project name resolves to a real workspace package", () => {
  const dryRun = driverProjects();
  const configured = new Set(readConfiguredProjectDirs().map(packageNameFor));

  // A typo'd or renamed entry in nonServerProjects makes `--project <name>`
  // match nothing. Vitest treats that as a hard error today, but only if the
  // lane happens to run -- assert it up front instead.
  const unknown = dryRun.nonServerProjects.filter((name) => !configured.has(name));
  assert.deepEqual(
    unknown,
    [],
    `nonServerProjects names no project declared in vitest.config.ts: ${unknown.join(", ")}`,
  );
});

// ---------------------------------------------------------------------------
// The sweep above reconciles two hand-maintained lists against each other. That
// closes the "declared in (1), missing from (2)" spelling of the bug -- but not
// the bug. A package in NEITHER list is invisible to it, because the sweep only
// ever iterates over vitest.config.ts. That is the exact shape BLO-20076 was
// filed for ("packages/mcp-server sat in neither list") and the exact shape
// that recurred: packages/mcp-gateway sat in neither list, so no CI lane ran a
// single one of the 4 suites / 106 tests it owns on this tree (circuit-breaker,
// server, session-keepalive, upstreams -- verified executing as of this commit).
//
// The k8s MCP secret scrubber's own suite is NOT among them: response-scrub.ts
// and its test land with #1449 and are not on master yet. Wiring the package
// here is precisely what makes that suite execute the moment it merges, rather
// than arriving into the same silence. Do not read this test as evidence the
// scrubber is currently covered -- it is not, and PEN-2491 stays open for the
// separate reason that pr.yml is `pull_request: branches: [master]`, so #1449
// itself still merges into its stack branch with no package tests run at all.
//
// So the authority for "does this package need to be executed?" cannot be
// either list. It has to be the filesystem: a package that owns test files is
// a package whose tests must run. This test walks the workspace and holds that
// line, which makes the invariant closed under adding a new package rather
// than closed under one remembered spelling.
// ---------------------------------------------------------------------------

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  ".vite",
]);

const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

// Packages whose tests DO run, just not through the Vitest project lane this
// file governs. Verified, not assumed -- see PEN-2491.
const EXECUTED_BY_ANOTHER_LANE = new Map([
  // Deliberately outside the pnpm workspace; pr.yml's `Vendored claude_k8s
  // adapter` job installs it and runs `npm test` on its own.
  ["paperclip-adapter-claude-k8s", "pr.yml :: vendor_claude_k8s"],
  // The root package owns ~96 node:test files under scripts/, .github/scripts/
  // and deploy/helm/. Those run through the enumerated `node --test` steps in
  // pr.yml's policy job, not through Vitest. NOTE: this sweep does not verify
  // that enumeration is complete -- it only declines to claim the root package
  // is untested.
  ["paperclip", "pr.yml :: policy (node --test steps)"],
]);

// Packages that own test files but that no CI lane executes. This list is a
// RATCHET, not an allowlist: it records pre-existing debt so that no NEW
// package can join the invisible set silently. Entries may be removed (by
// wiring the package up) but adding one is a deliberate, reviewable act and
// needs a tracking issue.
//
// Every entry below is tracked by PEN-2506. The highest-value subset is
// @paperclipai/plugin-kubernetes, whose unexecuted suites include
// secret-manager, sensitive-env-guard, image-allowlist and network-policy --
// controls whose whole job is containing agent workloads.
const UNEXECUTED_WITH_TESTS = new Map(
  [
    "@kkroo/paperclip-plugin-gbrain",
    "@kkroo/paperclip-plugin-linear",
    "@paperclipai/adapter-acpx-local",
    "@paperclipai/adapter-openclaw-gateway",
    "@paperclipai/google-sheets-mcp-server",
    "@paperclipai/kv-demo-mcp-server",
    "@paperclipai/plugin-authoring-smoke-example",
    "@paperclipai/plugin-cloudflare-sandbox",
    "@paperclipai/plugin-daytona",
    "@paperclipai/plugin-e2b",
    "@paperclipai/plugin-exe-dev",
    "@paperclipai/plugin-fake-sandbox",
    "@paperclipai/plugin-kubernetes",
    "@paperclipai/plugin-llm-wiki",
    "@paperclipai/plugin-modal",
    "@paperclipai/plugin-novita-sandbox",
    "@paperclipai/plugin-orchestration-smoke-example",
    "@paperclipai/plugin-workspace-diff",
    "@paperclipai/teams-catalog",
    "paperclip-cloudflare-sandbox-bridge-template",
    "paperclip-plugin-alertmanager",
    "paperclip-plugin-slack",
  ].map((name) => [name, "PEN-2506"]),
);

function collectWorkspace(dir, packageDirs, testFiles) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      collectWorkspace(path.join(dir, entry.name), packageDirs, testFiles);
    } else if (entry.isFile()) {
      if (entry.name === "package.json") packageDirs.add(dir);
      else if (TEST_FILE.test(entry.name)) testFiles.push(path.join(dir, entry.name));
    }
  }
}

// Attribute each test file to the nearest enclosing package.json, so a suite
// under packages/foo/test/unit/ counts for packages/foo and a nested template
// package counts for itself.
function packagesOwningTests() {
  const packageDirs = new Set();
  const testFiles = [];
  collectWorkspace(repoRoot, packageDirs, testFiles);

  const owners = new Set();
  for (const file of testFiles) {
    let dir = path.dirname(file);
    while (dir.startsWith(repoRoot)) {
      if (packageDirs.has(dir)) {
        owners.add(dir);
        break;
      }
      dir = path.dirname(dir);
    }
  }

  return [...owners]
    .map((dir) => {
      let name;
      try {
        name = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")).name;
      } catch {
        return null;
      }
      return name ? { name, dir: path.relative(repoRoot, dir) } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
}

test("every workspace package that owns test files is executed by a CI lane", () => {
  const executed = new Set([...driverProjects().nonServerProjects, SERVER_PROJECT]);

  const invisible = packagesOwningTests().filter(
    ({ name }) =>
      !executed.has(name) &&
      !UNEXECUTED_WITH_TESTS.has(name) &&
      !EXECUTED_BY_ANOTHER_LANE.has(name),
  );

  assert.deepEqual(
    invisible,
    [],
    `These packages own test files but no CI lane runs them, so their suites report ` +
      `green because nothing executed them:\n` +
      invisible.map(({ name, dir }) => `  - ${name} (${dir})`).join("\n") +
      `\n\nWire each one into BOTH vitest.config.ts and \`nonServerProjects\` in ` +
      `scripts/run-vitest-stable.mjs. If it genuinely cannot run in CI yet, add it to ` +
      `UNEXECUTED_WITH_TESTS with a tracking issue -- but that is debt, not a fix.`,
  );
});

test("packages/mcp-gateway is wired into both lists", () => {
  // Regression lock for PEN-2491, mirroring the BLO-20076 lock above. The
  // gateway is the agent-facing k8s MCP proxy, and the incoming
  // response-scrub.test.ts (#1449) will test a secret-redaction control, so
  // "green but never executed" is a security signal failure here, not just a
  // coverage gap. This lock keeps the package wired so that suite runs on
  // arrival.
  assert.ok(
    readConfiguredProjectDirs().includes("packages/mcp-gateway"),
    "packages/mcp-gateway must stay in the vitest.config.ts projects array",
  );
  assert.ok(
    driverProjects().nonServerProjects.includes("@paperclipai/mcp-gateway"),
    "@paperclipai/mcp-gateway must stay in nonServerProjects; without it CI runs nothing",
  );
  assert.ok(
    !UNEXECUTED_WITH_TESTS.has("@paperclipai/mcp-gateway"),
    "@paperclipai/mcp-gateway must not be exempted in UNEXECUTED_WITH_TESTS",
  );
});

test("UNEXECUTED_WITH_TESTS has no stale entries", () => {
  const executed = new Set([...driverProjects().nonServerProjects, SERVER_PROJECT]);
  const owning = new Set(packagesOwningTests().map(({ name }) => name));

  for (const [name, issue] of UNEXECUTED_WITH_TESTS) {
    assert.ok(
      owning.has(name),
      `${name} is exempted but no longer owns test files -- drop the entry (${issue})`,
    );
    assert.ok(
      !executed.has(name),
      `${name} is now executed by CI -- remove it from UNEXECUTED_WITH_TESTS and close ${issue}`,
    );
  }
});
