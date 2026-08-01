import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
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
// Every entry needs a tracking issue. Shrinking this to empty is the goal;
// adding to it requires a conscious decision, which is the entire point.
//
// BLO-20172: all six are red on master today, so wiring them into CI without
// repairing them first would just turn every PR red. Tracked, not forgotten.
const KNOWN_UNCOVERED = new Map([
  ["@paperclipai/adapter-claude-local", "BLO-20172"],
  ["@paperclipai/adapter-cursor-cloud", "BLO-20172"],
  ["@paperclipai/adapter-cursor-local", "BLO-20172"],
  ["@paperclipai/adapter-gemini-local", "BLO-20172"],
  ["@paperclipai/adapter-grok-local", "BLO-20172"],
  ["@paperclipai/adapter-pi-local", "BLO-20172"],
]);

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
