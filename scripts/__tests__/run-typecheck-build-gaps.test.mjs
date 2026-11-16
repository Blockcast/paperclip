import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const script = new URL("../run-typecheck-build-gaps.mjs", import.meta.url).pathname;

function createFixtureRepo() {
  return mkdtempSync(path.join(tmpdir(), "run-typecheck-build-gaps-test-"));
}

function writeFixtureFile(root, relativePath, body = "fixture") {
  const filePath = path.join(root, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, body);
}

function runRuntimeAssetGuard(root) {
  return spawnSync(process.execPath, [script, "--runtime-assets-only"], {
    cwd: root,
    encoding: "utf8",
  });
}

test("passes when all source runtime assets are present in dist", () => {
  const root = createFixtureRepo();
  try {
    writeFixtureFile(root, "server/src/built-ins/agents/default.md");
    writeFixtureFile(root, "server/dist/built-ins/agents/default.md");
    writeFixtureFile(root, "server/src/onboarding-assets/welcome.txt");
    writeFixtureFile(root, "server/dist/onboarding-assets/welcome.txt");
    writeFixtureFile(root, "server/src/built-ins/ignored.ts");

    const result = runRuntimeAssetGuard(root);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /server runtime assets present in dist: 2 file\(s\)/);
    assert.equal(result.stderr, "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails with the missing source asset and expected dist path", () => {
  const root = createFixtureRepo();
  try {
    writeFixtureFile(root, "server/src/built-ins/agents/default.md");

    const result = runRuntimeAssetGuard(root);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Missing server runtime asset\(s\) in dist/);
    assert.match(result.stderr, /source: server\/src\/built-ins\/agents\/default\.md/);
    assert.match(result.stderr, /expected dist: server\/dist\/built-ins\/agents\/default\.md/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- build-gap loop fixtures -------------------------------------------------
//
// The script shells out to `pnpm` by name, so these tests put a shim earlier on
// PATH than any real pnpm. The shim answers the two invocations the script
// makes -- `ls -r --depth -1 --json` and `--filter <name> <script>` -- and
// records a start/end event per typecheck so the test can measure how many ran
// at once. That overlap is the only direct evidence of concurrency; asserting
// on wall-clock totals would be flaky on a loaded runner.

const PNPM_SHIM = `#!/usr/bin/env node
// CommonJS on purpose: this file has no extension, so ESM here would rely on
// Node's module-syntax detection rather than on anything guaranteed.
const { appendFileSync, readFileSync } = require("node:fs");

const config = JSON.parse(readFileSync(process.env.FIXTURE_CONFIG, "utf8"));
const argv = process.argv.slice(2);

function record(event) {
  appendFileSync(config.eventLog, JSON.stringify(event) + "\\n");
}

if (argv[0] === "ls") {
  process.stdout.write(JSON.stringify(config.workspaces));
  process.exit(0);
}

const name = argv[1];
const script = argv[2];

if (script === "ensure-build-deps") {
  record({ kind: "ensure-build-deps", at: Date.now() });
  process.exit(0);
}

record({ kind: "typecheck", phase: "start", name, at: Date.now() });
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, config.sleepMs);
record({ kind: "typecheck", phase: "end", name, at: Date.now() });

process.stdout.write("typechecked " + name + "\\n");

const failures = config.failures ?? {};
if (failures[name]) {
  process.stderr.write("type error in " + name + "\\n");
  process.exit(failures[name]);
}
process.exit(0);
`;

function createLoopFixture(root, { packages, failures = {}, sleepMs = 120 }) {
  const binDir = path.join(root, "fixture-bin");
  mkdirSync(binDir, { recursive: true });
  const shimPath = path.join(binDir, "pnpm");
  writeFileSync(shimPath, PNPM_SHIM);
  chmodSync(shimPath, 0o755);

  const workspaces = [{ name: "fixture-root", path: root }];
  for (const name of packages) {
    const packageDir = path.join(root, "packages", name);
    mkdirSync(packageDir, { recursive: true });
    // `build` must exist and must not mention tsc, or the package is not a
    // build-gap candidate; `typecheck` must exist or the script fails fast.
    writeFileSync(
      path.join(packageDir, "package.json"),
      JSON.stringify({ name, scripts: { build: "node ./esbuild.config.mjs", typecheck: "tsc --noEmit" } }),
    );
    workspaces.push({ name, path: packageDir });
  }

  const eventLog = path.join(root, "events.ndjson");
  writeFileSync(eventLog, "");
  const configPath = path.join(root, "fixture.json");
  writeFileSync(configPath, JSON.stringify({ workspaces, failures, sleepMs, eventLog }));

  return { binDir, configPath, eventLog };
}

function runBuildGapLoop(root, fixture, extraEnv = {}) {
  return spawnSync(process.execPath, [script], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fixture.binDir}${path.delimiter}${process.env.PATH}`,
      FIXTURE_CONFIG: fixture.configPath,
      // Inherited from an outer CI run this would silently steer the tests.
      TYPECHECK_BUILD_GAPS_CONCURRENCY: undefined,
      ...extraEnv,
    },
  });
}

function readEvents(fixture) {
  return readFileSync(fixture.eventLog, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

// Replays the start/end events in time order and returns the high-water mark of
// simultaneously-running typechecks.
function maxObservedConcurrency(events) {
  const points = events
    .filter((event) => event.kind === "typecheck")
    .sort((left, right) => left.at - right.at || (left.phase === "end" ? -1 : 1));

  let running = 0;
  let peak = 0;
  for (const point of points) {
    running += point.phase === "start" ? 1 : -1;
    peak = Math.max(peak, running);
  }
  return peak;
}

test("typechecks every build-gap workspace and reports each under its own header", () => {
  const root = createFixtureRepo();
  try {
    const fixture = createLoopFixture(root, { packages: ["pkg-a", "pkg-b", "pkg-c"] });

    const result = runBuildGapLoop(root, fixture, { TYPECHECK_BUILD_GAPS_CONCURRENCY: "3" });

    assert.equal(result.status, 0, result.stderr);
    for (const name of ["pkg-a", "pkg-b", "pkg-c"]) {
      assert.match(result.stdout, new RegExp(`----- ${name}: ok in `));
      assert.match(result.stdout, new RegExp(`typechecked ${name}`));
    }

    const events = readEvents(fixture);
    assert.equal(events.filter((event) => event.kind === "typecheck" && event.phase === "start").length, 3);

    // The plugin-sdk warm-up must precede every typecheck: it is what lets each
    // member take ensure-plugin-build-deps' lock-free fresh path.
    const warmUp = events.find((event) => event.kind === "ensure-build-deps");
    const firstTypecheck = events.find((event) => event.kind === "typecheck");
    assert.ok(warmUp, "expected the hoisted ensure-build-deps to run");
    assert.ok(warmUp.at <= firstTypecheck.at, "ensure-build-deps must run before any typecheck");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runs build-gap typechecks concurrently", () => {
  const root = createFixtureRepo();
  try {
    const fixture = createLoopFixture(root, { packages: ["pkg-a", "pkg-b", "pkg-c", "pkg-d"] });

    const result = runBuildGapLoop(root, fixture, { TYPECHECK_BUILD_GAPS_CONCURRENCY: "4" });

    assert.equal(result.status, 0, result.stderr);
    assert.ok(
      maxObservedConcurrency(readEvents(fixture)) > 1,
      "expected at least two workspace typechecks to overlap in time",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TYPECHECK_BUILD_GAPS_CONCURRENCY=1 restores fully serial execution", () => {
  const root = createFixtureRepo();
  try {
    const fixture = createLoopFixture(root, { packages: ["pkg-a", "pkg-b", "pkg-c"] });

    const result = runBuildGapLoop(root, fixture, { TYPECHECK_BUILD_GAPS_CONCURRENCY: "1" });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      maxObservedConcurrency(readEvents(fixture)),
      1,
      "expected no two typechecks to overlap at concurrency 1",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reports every failing workspace and exits with the first failure in workspace order", () => {
  const root = createFixtureRepo();
  try {
    const fixture = createLoopFixture(root, {
      packages: ["pkg-a", "pkg-b", "pkg-c"],
      failures: { "pkg-b": 2, "pkg-c": 3 },
    });

    const result = runBuildGapLoop(root, fixture, { TYPECHECK_BUILD_GAPS_CONCURRENCY: "3" });

    // pkg-b fails first in workspace order, so its exit status is the one used.
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stderr, /2 of 3 workspace typecheck\(s\) failed: pkg-b, pkg-c/);
    assert.match(result.stdout, /----- pkg-b: FAILED \(exit 2\)/);
    assert.match(result.stdout, /----- pkg-c: FAILED \(exit 3\)/);
    // A later failure must not stop earlier ones being reported.
    assert.match(result.stdout, /----- pkg-a: ok in /);
    // Each child's own output is attributed, not interleaved.
    assert.match(result.stdout, /type error in pkg-b/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a non-numeric concurrency setting instead of silently defaulting", () => {
  const root = createFixtureRepo();
  try {
    const fixture = createLoopFixture(root, { packages: ["pkg-a"] });

    const result = runBuildGapLoop(root, fixture, { TYPECHECK_BUILD_GAPS_CONCURRENCY: "all" });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /TYPECHECK_BUILD_GAPS_CONCURRENCY must be a positive integer/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
