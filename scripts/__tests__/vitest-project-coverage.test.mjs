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
  // Same arrangement, added by PEN-3916 when this adapter was vendored in-tree.
  // EXECUTED_BY_ANOTHER_LANE, not UNEXECUTED_WITH_TESTS: the lane really does
  // install it and run `npm test` (674 tests), so this is a true statement
  // about where the suite runs, not debt parked on the ratchet.
  ["paperclip-adapter-opencode-k8s", "pr.yml :: vendor_opencode_k8s"],
  // The root package owns ~96 node:test files under scripts/, .github/scripts/
  // and deploy/helm/. Those run through the enumerated `node --test` steps in
  // pr.yml's policy job, not through Vitest. NOTE: this sweep does not verify
  // that enumeration is complete -- it only declines to claim the root package
  // is untested.
  ["paperclip", "pr.yml :: policy (node --test steps)"],
  // PEN-2506. The nine packages below are the two pnpm-workspace.yaml `!`
  // plugin exclusions -- `sandbox-providers/**` and
  // plugin-orchestration-smoke-example. They are NOT workspace members, so
  // root `pnpm install` never installs their deps and a root Vitest project
  // pointed at them cannot resolve those imports: the two-list fix that closed
  // BLO-20076 and PEN-2491 is structurally unavailable here, which is why they
  // were parked as debt rather than wired up.
  //
  // They stopped being debt on 2026-09-19. BLO-34222 added
  // .github/workflows/sandbox-provider-tests.yml, which discovers every
  // package under both roots (not an enumerated list) and runs each one's
  // `test` script after building the SDK they import. Verified executing, not
  // assumed: run 40229751677 reports "Ran 9 package(s); 0 failed", with
  // kubernetes at 18 test files and cloudflare/bridge-template at 4.
  //
  // They sat in UNEXECUTED_WITH_TESTS for the five weeks after that anyway,
  // because nothing reconciles this list against workflows other than pr.yml.
  // A false "no lane runs this" is not harmless: it is an open invitation to
  // build the lane that already exists, which is exactly what it cost before
  // this correction landed.
  ["@paperclipai/plugin-kubernetes", "sandbox-provider-tests.yml :: tests"],
  ["@paperclipai/plugin-cloudflare-sandbox", "sandbox-provider-tests.yml :: tests"],
  ["paperclip-cloudflare-sandbox-bridge-template", "sandbox-provider-tests.yml :: tests"],
  ["@paperclipai/plugin-daytona", "sandbox-provider-tests.yml :: tests"],
  ["@paperclipai/plugin-e2b", "sandbox-provider-tests.yml :: tests"],
  ["@paperclipai/plugin-exe-dev", "sandbox-provider-tests.yml :: tests"],
  ["@paperclipai/plugin-modal", "sandbox-provider-tests.yml :: tests"],
  ["@paperclipai/plugin-novita-sandbox", "sandbox-provider-tests.yml :: tests"],
  ["@paperclipai/plugin-orchestration-smoke-example", "sandbox-provider-tests.yml :: tests"],
]);

// Packages that own test files but that no CI lane executes. This list is a
// RATCHET, not an allowlist: it records pre-existing debt so that no NEW
// package can join the invisible set silently. Entries may be removed (by
// wiring the package up) but adding one is a deliberate, reviewable act and
// needs a tracking issue.
//
// PEN-2506 drained this list to EMPTY. The twelve that left were ordinary
// pnpm workspace members, so the two-list fix (vitest.config.ts +
// `nonServerProjects`) was available for each, and every one was run before
// being claimed -- through the root `--project` path the CI driver uses, not
// standalone. Eleven of them (53 test files / 640 tests) were confirmed in CI
// run 40696778970, `General tests (workspaces-b)`, by reading the package
// names out of the lane log. The twelfth, @paperclipai/plugin-llm-wiki
// (3 files / 101 tests), was verified locally through that same `--project`
// path; its first CI run is this change.
//
// The security-relevant ones among them were NOT the kubernetes set that row
// was filed about. They were paperclip-plugin-slack --
// signature-verification.test.ts (HMAC over the original bytes, stale
// timestamps, length mismatch, fail-closed on an unreadable secret) and
// interaction-tenant-scope.test.ts (BLO-21083: a delivery is never served
// under another company's token or signing secret) -- plus
// paperclip-plugin-gbrain's oauth-client-manager.test.ts. Those are
// inbound-request authentication and cross-tenant isolation controls, and
// nothing ran them.
//
// The nine workspace-EXCLUDED packages that used to sit here -- the sandbox
// providers and plugin-orchestration-smoke-example, including the
// @paperclipai/plugin-kubernetes set -- have moved to
// EXECUTED_BY_ANOTHER_LANE. They were never unexecuted debt after 2026-09-19,
// and this list said otherwise for five weeks. See the note there.
//
// The last entry to leave was @paperclipai/plugin-llm-wiki, and the reason
// recorded here for keeping it was WRONG in a way worth preserving. It read
// "there is no DOM, and neither jsdom nor happy-dom is declared". The second
// half was TRUE and the conclusion drawn from it was not:
// tests/wiki-route-sidebar-ui.spec.ts carries its own
// `// @vitest-environment jsdom` docblock, and jsdom resolves anyway -- as a
// phantom dependency, hoisted into node_modules/.pnpm/node_modules off
// `server`'s declaration -- so `document` was defined the whole time. That is
// PEN-4930, tracked separately in #3072: that PR declares jsdom on the two
// packages whose tests request it and adds a sweep to this file for any
// package that requests a non-node environment without declaring what
// provides it. Whether that has landed here is answered by those packages'
// package.json files and by whether that sweep is present below -- not by
// this note, which deliberately does not assert it, because the merge order
// of this branch and #3072 is not fixed and a note tracking it would be
// wrong half the time. The 16 failures were "TypeError: act is not a
// function" because React only exports `act` from
// cjs/react.development.js and react/index.js selects the production build
// when process.env.NODE_ENV === "production" -- which is ambient in an agent
// sandbox, but is NOT what CI does: runVitest in run-vitest-stable.mjs sets
// NODE_ENV: "test" for every child. The suite passes 101/101 under NODE_ENV
// of test, development, or unset. Pinned in the package's own vitest.config.ts
// so a direct `pnpm test` cannot inherit production and reproduce the ghost.
//
// The lesson for this file: an entry here is a claim about CI, so verify it
// the way CI runs it. A failure reproduced only in an agent shell is evidence
// about the shell.
//
// Keep this empty. A new entry is a [packageName, trackingIssue] pair -- the
// issue is not optional, and the sweep below prints it in the failure message:
//   const UNEXECUTED_WITH_TESTS = new Map([["@scope/pkg", "ABC-123"]]);
const UNEXECUTED_WITH_TESTS = new Map([]);

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

// Everything from a top-level `jobs:` key up to the next top-level key, or
// null when the file declares none. Bounded rather than "rest of file" so a
// workflow that puts another top-level key after `jobs:` cannot smuggle a
// match back in.
function jobsSectionOf(source) {
  const start = source.match(/^jobs:[ \t]*$/m);
  if (!start) return null;
  const rest = source.slice(start.index + start[0].length);
  const next = rest.match(/^[A-Za-z_][A-Za-z0-9_-]*:/m);
  return next ? rest.slice(0, next.index) : rest;
}

// A job key is interpolated into a RegExp below; YAML permits characters that
// are regex metacharacters, and an unescaped one would silently change what
// the guard accepts.
function escapeForRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("every EXECUTED_BY_ANOTHER_LANE claim names a job that exists", () => {
  // EXECUTED_BY_ANOTHER_LANE is the one list in this file that asserts
  // coverage rather than its absence, and nothing checked it. That asymmetry
  // is not academic: for five weeks UNEXECUTED_WITH_TESTS claimed nine
  // packages were run by no lane while sandbox-provider-tests.yml was running
  // all nine, because no test reconciles either list against a workflow other
  // than pr.yml. A wrong entry here is worse than a wrong entry there -- it
  // exempts a package from the sweep above, so a renamed or deleted job
  // silently stops running its tests and this file reports clean.
  //
  // This asserts the job KEY is declared in the workflow the entry names,
  // which is what makes the claim falsifiable at review time. It cannot prove
  // the job ran, or that it ran this package's tests -- only that the lane
  // being cited exists.
  const workflows = path.join(repoRoot, ".github", "workflows");

  for (const [name, lane] of EXECUTED_BY_ANOTHER_LANE) {
    const [file, job] = lane.split(" :: ");
    assert.ok(file && job, `${name}: lane must read "<workflow>.yml :: <job key>", got "${lane}"`);

    let source;
    try {
      source = readFileSync(path.join(workflows, file), "utf8");
    } catch {
      assert.fail(
        `${name} is exempted from the unexecuted-package sweep on the claim that ` +
          `${file} runs it, but .github/workflows/${file} does not exist.`,
      );
    }

    // Strip any parenthetical detail, e.g. "policy (node --test steps)".
    const jobKey = job.replace(/\s*\(.*$/, "").trim();

    // Scope the search to the `jobs:` block. Matching `^  <key>:$` against the
    // whole file also accepts any OTHER two-space-indented mapping key -- most
    // damagingly the trigger names under `on:`, so a claim of
    // "pr.yml :: pull_request" or ":: merge_group" would pass and exempt a
    // package from the sweep above on the strength of something that is not a
    // job at all. Verified against pr.yml, where `pull_request:` sits at
    // exactly two spaces (line 4).
    const jobsBlock = jobsSectionOf(source);
    assert.ok(
      jobsBlock !== null,
      `${name} cites ${file}, but that workflow has no top-level \`jobs:\` block.`,
    );
    assert.match(
      jobsBlock,
      new RegExp(`^  ${escapeForRegExp(jobKey)}:$`, "m"),
      `${name} is exempted from the unexecuted-package sweep on the claim that ` +
        `\`${jobKey}\` in ${file} runs it, but that workflow declares no such job. ` +
        `Either the job was renamed or removed -- in which case this package's tests ` +
        `are silently not running -- or the claim was never true.`,
    );
  }
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

// ---------------------------------------------------------------------------
// The sweeps above answer "does this package's suite run at all?". This one
// answers the next question: does it run with a timeout budget anyone chose?
//
// Under Vitest 4 `projects`, a root CLI `--testTimeout` reaches a project's
// resolved config but `--hookTimeout` does not. Measured on vitest 4.1.8
// against packages/db, which declares neither (BLO-37184, 2026-09-27):
//
//   --testTimeout=30000  -> a 7s test passes
//   --testTimeout=1000   -> "Test timed out in 1000ms."
//   (no flag)            -> "Test timed out in 5000ms."
//   --hookTimeout=60000  -> "Hook timed out in 10000ms."
//   --hookTimeout=2000   -> "Hook timed out in 10000ms."   <- tightening ignored too
//   (no flag)            -> "Hook timed out in 10000ms."
//
// run-vitest-stable.mjs passed both flags to every general-workspaces-b
// project for months, so the hook half was inert the whole time and the
// packages it appeared to cover looked handled while running on the bare 10s
// default. That is what made BLO-36739's alertmanager flake hard to diagnose,
// and it is why a flag that READS as protection is worse than no flag.
//
// A hook budget only binds from the package's own vitest.config.ts (verified:
// `hookTimeout: 30_000` there makes a 12s hook pass under `--project`). A
// package that boots a real or WASM Postgres without one is a merge-queue
// ejection waiting to happen -- BLO-37114 measured 6 of 12 `merge_group`
// failures as one package's `beforeEach` missing the 10s deadline, each
// ejection costing a full re-traverse of a ~64-deep queue.
//
// So: boot embedded Postgres in a test file, declare a budget. Both halves are
// required, not just the hook one, so this stays correct if the root
// `--testTimeout` is ever dropped as well.
// ---------------------------------------------------------------------------

const EMBEDDED_POSTGRES = /startEmbeddedPostgresTestDatabase|@electric-sql\/pglite|\bPGlite\b/;

function testFilesUnder(dir) {
  const packageDirs = new Set();
  const testFiles = [];
  collectWorkspace(dir, packageDirs, testFiles);
  return testFiles;
}

function bootsEmbeddedPostgres(projectDir) {
  return testFilesUnder(path.join(repoRoot, projectDir)).some((file) =>
    EMBEDDED_POSTGRES.test(readFileSync(file, "utf8")),
  );
}

function declaredTimeouts(projectDir) {
  let source;
  try {
    source = readFileSync(path.join(repoRoot, projectDir, "vitest.config.ts"), "utf8");
  } catch {
    return { testTimeout: false, hookTimeout: false, config: false };
  }
  // Strip `//` comments first, as the sibling guard in
  // run-vitest-stable-shard.test.mjs does. These configs carry long comments
  // that name both knobs, so a commented-out `// testTimeout: 5_000,` -- or
  // prose merely discussing one -- would otherwise register as declared. That
  // is a fail-open inside a test whose whole purpose is catching fail-open
  // protection.
  const code = source.replace(/^\s*\/\/.*$/gm, "");
  return {
    config: true,
    testTimeout: /\btestTimeout\s*:/.test(code),
    hookTimeout: /\bhookTimeout\s*:/.test(code),
  };
}

test("every project that boots embedded Postgres sets its own test/hook timeouts", () => {
  const offenders = readConfiguredProjectDirs()
    .filter(bootsEmbeddedPostgres)
    .map((dir) => ({ dir, ...declaredTimeouts(dir) }))
    .filter(({ testTimeout, hookTimeout }) => !testTimeout || !hookTimeout);

  assert.deepEqual(
    offenders,
    [],
    `These Vitest projects boot embedded Postgres but declare no timeout budget of their own, ` +
      `so they run on Vitest's 5s test / 10s hook defaults. A root CLI --hookTimeout cannot fix ` +
      `this -- it is inert under Vitest 4 \`projects\` (BLO-37184). Set both in the package's own ` +
      `vitest.config.ts, as server/vitest.config.ts does:\n` +
      offenders
        .map(
          ({ dir, config, testTimeout, hookTimeout }) =>
            `  - ${dir} (${config ? `missing ${[!testTimeout && "testTimeout", !hookTimeout && "hookTimeout"].filter(Boolean).join(" + ")}` : "no vitest.config.ts"})`,
        )
        .join("\n"),
  );
});

test("the embedded-Postgres detector is not vacuous", () => {
  // Positive control. Without it, a rename of `startEmbeddedPostgresTestDatabase`
  // or a move of the PGlite import would make the sweep above pass by matching
  // nothing at all -- the same fail-open shape the inert CLI flags had.
  //
  // Both alternation branches need an anchor, because they are matched by
  // disjoint sets of packages. `server` and `packages/db` match solely via
  // `startEmbeddedPostgresTestDatabase`; `paperclip-plugin-alertmanager` has
  // zero hits on that name and is found only by the PGlite branch. Asserting
  // the first two alone would leave the PGlite branch uncontrolled, so
  // alertmanager could silently drop out of the sweep -- and it is the package
  // responsible for most of the merge-queue ejections this guard exists for.
  const boots = readConfiguredProjectDirs().filter(bootsEmbeddedPostgres);
  assert.ok(
    boots.includes("server") &&
      boots.includes("packages/db") &&
      boots.includes("packages/plugins/paperclip-plugin-alertmanager"),
    `expected the detector to find server, packages/db and ` +
      `packages/plugins/paperclip-plugin-alertmanager (the latter pins the PGlite ` +
      `branch), got: ${boots.join(", ") || "(none)"}`,
  );
});

// ---------------------------------------------------------------------------
// PEN-4930: a test file may opt itself into a non-`node` Vitest environment
// with a `// @vitest-environment <name>` docblock, or a package may set
// `environment:` in its own vitest.config.ts. Either way Vitest then imports
// the package that implements that environment -- `jsdom` for jsdom. That
// import is satisfied by whatever is reachable from the package's
// node_modules, which under pnpm includes anything hoisted into
// node_modules/.pnpm/node_modules by some *other* importer.
//
// So a package can run its whole DOM suite green while declaring nothing. That
// is what @paperclipai/plugin-llm-wiki and @paperclipai/ui were doing: 215
// jsdom docblocks between them, and the only importer declaring `jsdom` was
// `server`. Two costs, and the second is the one that justifies a guard here:
//
//   1. Fragility. `server` dropping jsdom, or a second version arriving and
//      stopping the hoist, turns these lanes red with nothing in their own
//      diff to explain it -- and the lane names a package the author never
//      touched.
//   2. Audit fidelity. Per-package CVE audit and SBOM generation enumerate
//      DECLARED dependencies. A package that loads jsdom without declaring it
//      does not carry jsdom in its dependency set, so a jsdom advisory does
//      not attribute to it. jsdom is an HTML/CSS/URL parser with a non-trivial
//      advisory history; this repo already pins `jsdom>undici` in the root
//      package.json overrides, which is precisely the kind of remediation that
//      has to be able to find every package it applies to.
//
// Neither cost is an exploitable vulnerability -- the package is pinned and
// integrity-hashed in pnpm-lock.yaml, and the hoist introduces no substitution
// vector. This is Low-severity hygiene, and the reason it is mechanical rather
// than a one-time fix is that the one-time fix does not survive: the next
// plugin to add a DOM spec reintroduces it silently, exactly as these two did.
// The sweep is the whole point. Fixing the two packages without it would be
// closing the instance and leaving the class open.

const ENVIRONMENT_PROVIDERS = new Map([
  ["jsdom", "jsdom"],
  ["happy-dom", "happy-dom"],
  ["edge-runtime", "@edge-runtime/vm"],
]);

const ENVIRONMENT_DOCBLOCK = /^\s*\/\/\s*@vitest-environment\s+([\w-]+)/m;
const ENVIRONMENT_CONFIG = /\benvironment:\s*["']([\w-]+)["']/;

// Attribute every test file to its nearest enclosing package.json, the same
// way packagesOwningTests() does, but keep the files so each environment
// request can be reported against the package that has to declare it.
function environmentRequestsByPackage() {
  const packageDirs = new Set();
  const testFiles = [];
  collectWorkspace(repoRoot, packageDirs, testFiles);

  const requests = new Map();
  const record = (dir, environment, source) => {
    if (!dir || environment === "node") return;
    if (!requests.has(dir)) requests.set(dir, new Map());
    const perDir = requests.get(dir);
    if (!perDir.has(environment)) perDir.set(environment, path.relative(repoRoot, source));
  };
  const ownerOf = (file) => {
    let dir = path.dirname(file);
    while (dir.startsWith(repoRoot)) {
      if (packageDirs.has(dir)) return dir;
      dir = path.dirname(dir);
    }
    return null;
  };

  for (const file of testFiles) {
    const match = ENVIRONMENT_DOCBLOCK.exec(readFileSync(file, "utf8"));
    if (match) record(ownerOf(file), match[1], file);
  }

  // The second opt-in door: a package-level default in its own vitest.config.
  for (const dir of packageDirs) {
    for (const name of ["vitest.config.ts", "vitest.config.mts", "vitest.config.js"]) {
      const config = path.join(dir, name);
      let source;
      try {
        source = readFileSync(config, "utf8");
      } catch {
        continue;
      }
      const match = ENVIRONMENT_CONFIG.exec(source);
      if (match) record(dir, match[1], config);
    }
  }

  return requests;
}

function declaredDependencies(dir) {
  const manifest = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
  return new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
  ]);
}

test("every package requesting a non-node Vitest environment declares the package providing it", () => {
  const offenders = [];
  const unknown = [];

  for (const [dir, environments] of environmentRequestsByPackage()) {
    const declared = declaredDependencies(dir);
    for (const [environment, source] of environments) {
      const provider = ENVIRONMENT_PROVIDERS.get(environment);
      if (!provider) {
        unknown.push({ environment, source });
        continue;
      }
      if (!declared.has(provider)) {
        offenders.push({ dir: path.relative(repoRoot, dir), environment, provider, source });
      }
    }
  }

  // Fail closed on an environment this map has never seen rather than waving
  // it through. A new environment is a deliberate act by someone who is right
  // here in this file's failure message; an unrecognised name silently scoring
  // as "fine" is the exact fail-open shape the sweep exists to remove.
  assert.deepEqual(
    unknown,
    [],
    `Unrecognised Vitest environment(s). Add the package that implements each one to ` +
      `ENVIRONMENT_PROVIDERS above so this sweep can check it is declared:\n` +
      unknown.map(({ environment, source }) => `  - "${environment}" requested by ${source}`).join("\n"),
  );

  assert.deepEqual(
    offenders,
    [],
    `These packages run tests in a non-node Vitest environment but do not declare the package ` +
      `that provides it. Today it resolves only because pnpm hoists some other importer's copy ` +
      `into node_modules/.pnpm/node_modules -- a phantom dependency, which breaks when that ` +
      `other importer changes and which hides the package from per-package CVE audit and SBOM ` +
      `output. Add it to the package's own devDependencies and regenerate pnpm-lock.yaml:\n` +
      offenders
        .map(
          ({ dir, environment, provider, source }) =>
            `  - ${dir} requests "${environment}" (${source}) but does not declare "${provider}"`,
        )
        .join("\n"),
  );
});

test("the Vitest-environment detector is not vacuous", () => {
  // Positive control, same reasoning as the embedded-Postgres one above. Both
  // regexes are load-bearing and neither is exercised by the assertion when
  // the repo is clean -- a passing sweep is equally consistent with "every
  // package declares its environment" and "the docblock regex matches
  // nothing". These two packages are the repo's only jsdom consumers, so
  // naming them pins the docblock branch against a silent rename.
  const requests = environmentRequestsByPackage();
  const jsdomConsumers = [...requests]
    .filter(([, environments]) => environments.has("jsdom"))
    .map(([dir]) => path.relative(repoRoot, dir))
    .sort();

  assert.deepEqual(
    jsdomConsumers,
    ["packages/plugins/plugin-llm-wiki", "ui"],
    `expected the sweep to find the two packages whose tests request jsdom; if a package ` +
      `legitimately gained or lost jsdom specs, update this control -- do not delete it`,
  );
});

// ---------------------------------------------------------------------------
// The sweep above asks "did anyone CHOOSE a budget?" -- a boolean. PEN-6254 is
// the next question, and a declared budget does not answer it: does the budget
// that actually binds the embedded-Postgres startup EXCEED it?
//
// #3530 was evicted from the merge queue on 2026-11-09 by
// `cost-events-company-issue-index-migration.test.ts` reporting "Test timed out
// in 60000ms" -- in a package that passes the sweep above, on a suite unchanged
// on master since 2026-10-20, at a head that had passed the same suite 19 h
// earlier. Nothing about the diff was involved.
//
// Two facts compose into that, and neither is visible from the config alone:
//
//   1. BLO-17026 measured embedded-Postgres startup at ~40 s on the contended
//      ARC pool, and server/vitest.config.ts records the remedy -- lift the
//      baseline AND "the tight per-test overrides in the embedded-postgres
//      suites are raised alongside this lift, since Vitest honors a per-test
//      timeout over the global".
//   2. WHICH budget carries that startup depends on WHERE the boot sits.
//      Counted 2026-11-09 over every body/hook that constructs one: server
//      boots in a HOOK 315 times against 41 bodies, so its 120 s `hookTimeout`
//      carries it; packages/db is the mirror image at 133 bodies against 2
//      hooks, so there it lands in `testTimeout`.
//
// packages/db had copied server's 60 s/120 s pair without copying server's
// SHAPE, and 63 per-test overrides then re-pinned the binding budget to 60 s
// one level below the config -- the same defeat PEN-6181 found in CI job
// budgets, where a step-level `timeout-minutes` undercut a guard that only read
// job-level ones. A guard that reads the config and stops is defeated by an
// override it never looks at.
//
// So this sweep resolves the EFFECTIVE budget of every booting test body --
// the per-test override where one exists, the project config otherwise -- and
// holds it to the floor `cli` already reached by measurement for exactly this
// shape ("embedded-postgres startup + reseed can take ~40s under load -- well
// past the previous 60s ceiling").
//
// This is NOT a hang detector and must not be re-tuned as one: pr.yml's job
// `timeout-minutes` is the hang detector (BLO-35615). A per-test budget's only
// job is to exceed the fixed setup cost inside it, so that a red here means the
// code is wrong rather than the pool is busy.
// ---------------------------------------------------------------------------

const EMBEDDED_POSTGRES_BODY_FLOOR_MS = 120_000;

// Deliberately narrower than EMBEDDED_POSTGRES above, which answers "does this
// file mention embedded Postgres at all?". Here the question is "does this body
// START one?", so it matches a CONSTRUCTION call only. An earlier draft of this
// guard reused the broad pattern and scored every helper taking a `pg: PGlite`
// PARAMETER as a booting one, which inflated one package from 7 booting bodies
// to 77 and would have raised budgets on tests that boot nothing -- the
// unjustified-raise this guard exists to make unnecessary.
const BOOTS_EMBEDDED_POSTGRES = /startEmbeddedPostgresTestDatabase\s*\(|new\s+PGlite\s*\(/;

function matchingParen(code, openIndex) {
  let depth = 0;
  for (let index = openIndex; index < code.length; index += 1) {
    if (code[index] === "(") depth += 1;
    else if (code[index] === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

// File-local helpers whose own source reaches a boot. The suite that evicted
// #3530 calls `startDatabase(...)` -- a four-line wrapper -- not the helper
// directly, so a detector that only matches the direct call MISSES the exact
// test this guard exists for. That was measured, not imagined: the first draft
// scored that file clean. Three passes resolve a wrapper calling a wrapper.
function bootingHelperNames(code) {
  const names = new Set();
  for (let pass = 0; pass < 3; pass += 1) {
    const declarations =
      /(?:async\s+)?function\s+([A-Za-z0-9_$]+)|(?:const|let)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?\(/g;
    let match;
    while ((match = declarations.exec(code))) {
      const name = match[1] ?? match[2];
      if (names.has(name)) continue;
      const open = code.indexOf("{", match.index);
      if (open === -1) continue;
      let depth = 0;
      let end = open;
      for (; end < code.length; end += 1) {
        if (code[end] === "{") depth += 1;
        else if (code[end] === "}") {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      const body = code.slice(match.index, end + 1);
      if (BOOTS_EMBEDDED_POSTGRES.test(body) || [...names].some((known) => callsHelper(body, known))) {
        names.add(name);
      }
    }
  }
  return names;
}

function callsHelper(code, name) {
  return new RegExp(`\\b${name}\\s*\\(`).test(code);
}

// Every `it`/`test` body in `code` that reaches a boot, with the per-test
// budget attached to it (null when it inherits the project config). Split from
// the file-reading wrapper below so the discrimination control can feed it a
// synthetic source -- a sweep that cannot be shown to REJECT is not a sweep.
function bootingTestBodiesInSource(code, label) {
  if (!BOOTS_EMBEDDED_POSTGRES.test(code)) return [];

  const helpers = bootingHelperNames(code);
  const reachesBoot = (body) =>
    BOOTS_EMBEDDED_POSTGRES.test(body) || [...helpers].some((name) => callsHelper(body, name));

  const bodies = [];
  const openers =
    /\b(?:it|test)(?:\.each\([\s\S]*?\))?(?:\.(?:only|skip|concurrent|sequential))?\s*\(/g;
  let match;
  while ((match = openers.exec(code))) {
    const close = matchingParen(code, openers.lastIndex - 1);
    if (close === -1) continue;
    const body = code.slice(match.index, close + 1);
    if (reachesBoot(body)) {
      // The budget is the trailing numeric argument of the call.
      const budget = /,(\s*)([0-9_]+)(\s*,?\s*)\)$/.exec(body.slice(-40));
      const title = /["'`](.+?)["'`]/.exec(body.slice(0, 300));
      bodies.push({
        file: label,
        line: code.slice(0, match.index).split("\n").length,
        budgetMs: budget ? Number(budget[2].replace(/_/g, "")) : null,
        title: title ? title[1] : "(untitled)",
      });
    }
    openers.lastIndex = close + 1;
  }
  return bodies;
}

function bootingTestBodies(file) {
  return bootingTestBodiesInSource(readFileSync(file, "utf8"), path.relative(repoRoot, file));
}

function configuredTestTimeout(projectDir) {
  let source;
  try {
    source = readFileSync(path.join(repoRoot, projectDir, "vitest.config.ts"), "utf8");
  } catch {
    return null;
  }
  // Same comment strip as declaredTimeouts above, and for the same reason:
  // these configs discuss `testTimeout` in prose at length.
  const code = source.replace(/^\s*\/\/.*$/gm, "");
  const declared = /\btestTimeout\s*:\s*([0-9_]+)/.exec(code);
  return declared ? Number(declared[1].replace(/_/g, "")) : null;
}

// Packages whose CONFIG-INHERITED booting bodies are known to sit under the
// floor and are deliberately not moved by PEN-6254. Per-test OVERRIDES are
// never excused here, in any package: an override is a local statement that
// this body needs something other than what its package chose, and one set
// below the floor on a booting body is the defect this guard exists for.
//
// Counted 2026-11-09. Both entries are real instances of the same shape, held
// back for want of evidence rather than because they are safe:
//
//   server -- 41 booting bodies against 315 booting HOOKS. The hooks are
//     covered by its 120s hookTimeout, and no server body appears in any
//     merge-queue timeout sample, so the measured failure PEN-6254 fixes is
//     not here. Raising this package's testTimeout touches the 6-shard,
//     110-minute lane that is the PR critical path, which is not a change to
//     make on a population with no observed failure.
//   paperclip-plugin-alertmanager -- 7 booting bodies. BLO-37114 measured this
//     package's ejections as HOOK timeouts (`beforeEach`), already fixed by
//     its 120s hookTimeout; its bodies construct PGlite (WASM), a different
//     and cheaper startup than the embedded cluster BLO-17026 timed at ~40s.
//
// WHAT WOULD SETTLE EITHER: a `Test timed out` in one of these bodies in a
// merge_group run, or a measurement of copyEmbeddedPostgresTemplate's per-suite
// cost on the contended pool. The template path (one migrated cluster per job,
// copied per suite) is why a later boot is cheaper than the first, and nobody
// has timed the copy -- so "these are fine" is unproven, not established.
const BOOTING_BODY_CONFIG_FLOOR_EXCEPTIONS = new Map([
  ["server", "PEN-6254: 41 bodies vs 315 hooks; no observed body timeout; lane is the PR critical path"],
  [
    "packages/plugins/paperclip-plugin-alertmanager",
    "PEN-6254: BLO-37114 ejections were hook timeouts, already covered; bodies are PGlite/WASM",
  ],
]);

// Effective budget = per-test override, else the project's configured
// testTimeout, else Vitest's bare 5s default.
function underBudgetedBootingBodies({ includeExcepted = false } = {}) {
  const offenders = [];
  for (const projectDir of readConfiguredProjectDirs()) {
    const configured = configuredTestTimeout(projectDir) ?? 5_000;
    const excepted = BOOTING_BODY_CONFIG_FLOOR_EXCEPTIONS.has(projectDir);
    for (const file of testFilesUnder(path.join(repoRoot, projectDir))) {
      for (const body of bootingTestBodies(file)) {
        const effectiveMs = body.budgetMs ?? configured;
        if (effectiveMs >= EMBEDDED_POSTGRES_BODY_FLOOR_MS) continue;
        const source = body.budgetMs === null ? "config" : "per-test";
        // The exception covers the inherited arm only.
        if (!includeExcepted && excepted && source === "config") continue;
        offenders.push({ ...body, projectDir, effectiveMs, source });
      }
    }
  }
  return offenders;
}

test("every test body that boots embedded Postgres budgets above the ARC startup cost", () => {
  const offenders = underBudgetedBootingBodies();

  assert.deepEqual(
    offenders.map(({ file, line, effectiveMs, source }) => `${file}:${line} ${effectiveMs}ms (${source})`),
    [],
    `These test bodies START an embedded Postgres inside a budget smaller than ` +
      `${EMBEDDED_POSTGRES_BODY_FLOOR_MS}ms, and BLO-17026 measured that startup at ~40s on the ` +
      `contended ARC pool. They do not fail on their own merits -- they fail when the pool is ` +
      `busy, and on merge_group that ejects the candidate and costs a full re-traverse of the ` +
      `queue (PEN-6254, #3530).\n` +
      `Raise the per-test budget, or move the boot into a hook so the project's hookTimeout ` +
      `carries it (server/vitest.config.ts is the worked example of the second):\n` +
      offenders
        .map(({ file, line, title, effectiveMs, source }) => `  - ${file}:${line} ${effectiveMs}ms from ${source} -- ${title}`)
        .join("\n"),
  );
});

test("every booting-body floor exception is still needed", () => {
  // Self-retiring, same contract as UNEXECUTED_WITH_TESTS above. If a package
  // raises its testTimeout to the floor, or its last booting body goes away,
  // the exception becomes a permanent hole nobody is watching -- so the sweep
  // fails until the stale entry is deleted.
  const stillUnderFloor = new Set(
    underBudgetedBootingBodies({ includeExcepted: true })
      .filter(({ source }) => source === "config")
      .map(({ projectDir }) => projectDir),
  );
  const stale = [...BOOTING_BODY_CONFIG_FLOOR_EXCEPTIONS.keys()].filter(
    (dir) => !stillUnderFloor.has(dir),
  );

  assert.deepEqual(
    stale,
    [],
    `These packages no longer have config-inherited booting bodies under ` +
      `${EMBEDDED_POSTGRES_BODY_FLOOR_MS}ms, so their entries in ` +
      `BOOTING_BODY_CONFIG_FLOOR_EXCEPTIONS are dead text that would silently excuse a future ` +
      `regression. Delete them: ${stale.join(", ")}`,
  );
});

test("the booting-body detector sees through a file-local wrapper", () => {
  // Positive control, and it pins the specific miss that let PEN-6254 land.
  // `cost-events-company-issue-index-migration.test.ts` reaches the boot only
  // through its own `startDatabase()` wrapper; a detector matching the direct
  // helper call scores it clean, which is what the first draft of this guard
  // did. Without this assertion that regression is silent -- the sweep above
  // would pass by finding nothing, the same fail-open shape as the inert CLI
  // flags documented further up this file.
  const file = path.join(repoRoot, "packages/db/src/cost-events-company-issue-index-migration.test.ts");
  const bodies = bootingTestBodies(file);
  assert.ok(
    bodies.length >= 3,
    `expected the wrapper-reached bodies in ${path.relative(repoRoot, file)} to be detected, got ` +
      `${bodies.length}. If that suite was renamed or removed, re-point this control at another ` +
      `body that reaches its boot through a helper -- do not simply delete it.`,
  );
  assert.ok(
    bodies.every(({ budgetMs }) => budgetMs === null || budgetMs >= EMBEDDED_POSTGRES_BODY_FLOOR_MS),
    `the control suite itself is under-budgeted: ${JSON.stringify(bodies)}`,
  );
});

test("the booting-body floor actually discriminates", () => {
  // A sweep is only as good as its ability to REJECT, and a floor nothing can
  // fail reads exactly like a clean repo. Feed it a body that boots inside a
  // 60s budget -- the precise shape that evicted #3530 -- and require a hit.
  const underBudgeted = bootingTestBodiesInSource(
    `it("boots inside too small a budget", async () => {
       const database = await startEmbeddedPostgresTestDatabase("probe-");
       expect(database).toBeTruthy();
     }, 60_000);`,
    "<synthetic>",
  );
  assert.equal(underBudgeted.length, 1, "the detector missed a direct boot in a test body");
  assert.equal(underBudgeted[0].budgetMs, 60_000);
  assert.ok(
    underBudgeted[0].budgetMs < EMBEDDED_POSTGRES_BODY_FLOOR_MS,
    "the floor no longer rejects the 60s budget that evicted #3530",
  );

  // And the wrapper arm, which is the one that actually failed in production.
  const viaWrapper = bootingTestBodiesInSource(
    `async function startDatabase(prefix) {
       return startEmbeddedPostgresTestDatabase(prefix);
     }
     it("boots through a wrapper", async () => {
       const { sql } = await startDatabase("probe-");
       expect(sql).toBeTruthy();
     }, 60_000);`,
    "<synthetic-wrapper>",
  );
  assert.equal(viaWrapper.length, 1, "the detector cannot see through a file-local wrapper");

  // Negative control: a body that merely RECEIVES a handle must not be scored
  // as booting, or this guard starts demanding budgets for setup that is not
  // there. This is the over-match that inflated one package 7 -> 77.
  const receivesOnly = bootingTestBodiesInSource(
    `let db;
     beforeEach(async () => { db = new PGlite(); });
     async function countRows(pg, table) { return pg.query(table); }
     it("uses an already-booted handle", async () => {
       expect(await countRows(db, "issues")).toBeTruthy();
     }, 20_000);`,
    "<synthetic-receives>",
  );
  assert.deepEqual(
    receivesOnly.map(({ title }) => title),
    [],
    "a body that only uses an existing handle was scored as booting one",
  );
});

// ---------------------------------------------------------------------------
// The sweep above answers "does a package that boots embedded Postgres declare
// a budget?". This one answers the question that guard's PREDICATE could not:
// does a package whose hooks do real I/O of ANY kind declare one?
//
// PEN-6455. `@paperclipai/adapter-utils` evicted #3583 from the merge queue on
// 2026-11-10 with `Hook timed out in 10000ms` in the file-level `afterAll` of
// github-git-egress-runtime.test.ts, which removes every git fixture repo the
// file created. Its fixtures are git repos, not Postgres, so EMBEDDED_POSTGRES
// matched it 0 times, the guard above never asked it for a budget, and it
// declared none -- the package had no vitest.config.ts at all. Every test in
// the file passed; only the teardown crossed the deadline, and the whole
// ~50 min `merge_group` run was discarded.
//
// The guard above encodes the hazard INSTANCE that prompted it (embedded
// Postgres) while its own comment states the general RULE: a package whose
// hooks do real work on a budget nobody declared is a merge-queue ejection
// waiting to happen. Git fixtures, process spawns and large recursive removals
// are the same hazard. So this predicate is the hazard SHAPE -- real I/O inside
// a hook -- rather than any one technology that happens to cause it. Widening
// the regex to name git too would just move the same narrow-predicate defect
// one notch out and wait for the next unlisted technology.
//
// This demands `hookTimeout` ONLY, where the Postgres guard demands both, and
// that asymmetry is deliberate. A root CLI `--testTimeout` demonstrably reaches
// a project's resolved config and `--hookTimeout` demonstrably does not
// (BLO-37184, re-measured first-hand on vitest 4.1.8 for PEN-6455:
// `--hookTimeout=60000` on a package with no config still reported "Hook timed
// out in 10000ms", while the same 12s hook PASSED once the package declared its
// own `hookTimeout: 60_000`). The hook knob is the one no flag can supply, so
// it is the only one this sweep can usefully demand -- and demanding only what
// is load-bearing is what keeps the offender list small enough to fix rather
// than silence.
// ---------------------------------------------------------------------------

// Both the sync and the `fs/promises` spellings of each call. Listing only the
// `*Sync` forms was the first draft of this very guard, and it missed five
// packages that use `await rm(...)` / `await mkdtemp(...)` -- i.e. it had
// reproduced, inside the fix, the exact narrow-predicate defect it exists to
// correct. Bounded single-file calls (`writeFile`, `readdir`) are deliberately
// NOT here: they appear in almost every hook, so including them would put every
// project on the list and turn this guard into an exemption file.
const HOOK_IO =
  /\b(?:execFileSync|execSync|spawnSync|execFile|exec|spawn|mkdtempSync|mkdtemp|rmSync|rm|cpSync|cp|startEmbeddedPostgresTestDatabase)\s*\(|\bnew\s+PGlite\s*\(/;

/** The names of every hook in `code` whose body reaches real I/O. */
function hooksWithRealIo(code) {
  const hooks = [];
  const openers = /\b(?:beforeAll|afterAll|beforeEach|afterEach)\s*\(/g;
  let match;
  while ((match = openers.exec(code))) {
    const close = matchingParen(code, openers.lastIndex - 1);
    if (close === -1) continue;
    if (HOOK_IO.test(code.slice(match.index, close + 1))) {
      hooks.push(match[0].replace(/\s*\($/, ""));
    }
  }
  return hooks;
}

function projectsWithRealIoHooks() {
  return readConfiguredProjectDirs().filter((dir) =>
    testFilesUnder(path.join(repoRoot, dir)).some(
      (file) => hooksWithRealIo(readFileSync(file, "utf8")).length > 0,
    ),
  );
}

test("every project whose hooks do real I/O declares its own hookTimeout", () => {
  const offenders = projectsWithRealIoHooks()
    .map((dir) => ({ dir, ...declaredTimeouts(dir) }))
    .filter(({ hookTimeout }) => !hookTimeout);

  assert.deepEqual(
    offenders,
    [],
    `These Vitest projects run hooks that spawn processes, create temp trees or remove them ` +
      `recursively, but declare no hookTimeout of their own, so those hooks run on Vitest's bare ` +
      `10s default -- a budget nobody chose. A root CLI --hookTimeout cannot supply one; it is ` +
      `inert under Vitest 4 \`projects\` (BLO-37184). That is how PEN-6455 evicted #3583 from the ` +
      `merge queue. Set \`hookTimeout\` in the package's own vitest.config.ts:\n` +
      offenders
        .map(({ dir, config }) => `  - ${dir} (${config ? "config, no hookTimeout" : "no vitest.config.ts"})`)
        .join("\n"),
  );
});

test("the real-I/O hook detector is not vacuous", () => {
  // Positive control. Without it, a rename of the fs/child_process calls -- or
  // a change to how hook bodies are sliced -- would make the sweep above pass
  // by matching nothing at all, the same fail-open shape the inert CLI flags
  // had. The anchors deliberately span distinct branches of HOOK_IO:
  // adapter-utils is found via the git/temp-tree branch (it is the package
  // PEN-6455 was filed for), packages/db and server via embedded Postgres.
  const found = projectsWithRealIoHooks();
  for (const anchor of ["packages/adapter-utils", "packages/db", "server", "cli"]) {
    assert.ok(
      found.includes(anchor),
      `expected the real-I/O hook detector to find ${anchor}, got: ${found.join(", ") || "(none)"}`,
    );
  }
});

test("the real-I/O hook detector discriminates", () => {
  // A sweep that cannot be shown to REJECT is not a sweep. Must-accept:
  assert.deepEqual(
    hooksWithRealIo(`afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true }); });`),
    ["afterAll"],
    "a hook that removes trees recursively was not detected",
  );
  assert.deepEqual(
    hooksWithRealIo(`beforeEach(() => { execFileSync("git", ["init", tmp]); });`),
    ["beforeEach"],
    "a hook that spawns a process was not detected",
  );
  // The `fs/promises` spelling, which the first draft of this guard missed.
  assert.deepEqual(
    hooksWithRealIo(`afterEach(async () => { await rm(tmp, { recursive: true, force: true }); });`),
    ["afterEach"],
    "the fs/promises removal spelling was not detected",
  );

  // Must-reject: a purely in-memory hook needs no budget, and widening the
  // predicate until it matches one of these would put every project on the
  // list and turn the fix into an exemption file.
  assert.deepEqual(
    hooksWithRealIo(`afterEach(() => { vi.restoreAllMocks(); state.clear(); });`),
    [],
    "an in-memory hook was scored as doing real I/O",
  );
  // I/O in a TEST body is a different hazard on a different knob -- the
  // booting-body floor above owns that one, and `--testTimeout` can reach it.
  assert.deepEqual(
    hooksWithRealIo(`it("removes the tree", () => { rmSync(dir, { recursive: true }); });`),
    [],
    "I/O in a test body was scored against the hook budget",
  );
});
