import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  GROUP_NAMES,
  UNIT_GROUP_A_ROOTS,
  buildContext,
  decide,
  formatOutputs,
  listWorkspaces,
  referencedPaths,
  vitestProjectDirs,
} from "../select-ci-suites.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// ---------------------------------------------------------------------------
// Synthetic repository: every rule is exercised on a tree small enough to read.
// ---------------------------------------------------------------------------

function writeTree(root, files) {
  for (const [name, body] of Object.entries(files)) {
    const abs = path.join(root, name);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
}

function pkg(name, deps = {}) {
  return JSON.stringify({ name, version: "0.0.0", dependencies: deps });
}

function makeRepo(extra = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "select-ci-suites-"));
  writeTree(root, {
    "pnpm-workspace.yaml": "packages:\n  - packages/*\n  - server\n  - ui\n  - cli\n  - '!packages/excluded'\n",
    "package.json": JSON.stringify({
      name: "root",
      scripts: {
        "test:run": "pnpm run preflight && node scripts/run-vitest-stable.mjs",
        "test:run:general": "node scripts/run-vitest-stable.mjs --mode general",
        "test:run:serialized": "node scripts/run-vitest-stable.mjs --mode serialized",
        preflight: "node scripts/ensure-links.ts",
        "check:docs": "node scripts/check-docs-only.mjs",
      },
    }),
    "vitest.config.ts": 'export default { test: { projects: ["packages/shared", "packages/lone", "server", "ui", "cli"] } };\n',
    "server/package.json": pkg("@x/server", { "@x/shared": "workspace:*" }),
    "server/src/app.ts": "export const app = 1;\n",
    "server/src/__tests__/doc-pin.test.ts":
      'import path from "node:path";\nconst repoRoot = path.resolve(import.meta.dirname, "../../..");\nexport const doc = path.join(repoRoot, "doc", "pinned.md");\nexport const wf = path.join(repoRoot, ".github", "workflows", "pinned.yml");\nexport const dir = "../../../deploy/pinned-chart";\n',
    "packages/shared/package.json": pkg("@x/shared"),
    "packages/shared/src/index.ts": "export const shared = 1;\n",
    "packages/lone/package.json": pkg("@x/lone"),
    "packages/lone/src/index.ts": "export const lone = 1;\n",
    "packages/excluded/package.json": pkg("@x/excluded"),
    "ui/package.json": pkg("@x/ui", { "@x/shared": "workspace:*" }),
    "ui/src/main.ts": "export const ui = 1;\n",
    "cli/package.json": pkg("@x/cli", { "@x/server": "workspace:*" }),
    "cli/src/main.ts": 'import "../../packages/lone/src/index.ts";\n',
    "scripts/run-vitest-stable.mjs": 'import "./helper.mjs";\n',
    "scripts/helper.mjs": 'export const marker = "scripts/data/seed.json";\n',
    "scripts/ensure-links.ts": "export {};\n",
    "scripts/data/seed.json": "{}\n",
    "scripts/check-docs-only.mjs": "export {};\n",
    "scripts/unrelated.mjs": "export {};\n",
    "scripts/select-ci-suites.mjs": "export {};\n",
    "docs/guide.md": "# guide\n",
    "doc/pinned.md": "# pinned\n",
    "doc/free.md": "# free\n",
    ".planning/STATE.md": "state\n",
    ".github/workflows/pr.yml": "name: PR\n",
    ".github/workflows/pinned.yml": "name: pinned\n",
    ".github/workflows/other.yml": "name: other\n",
    ".github/actions/setup/action.yml": "name: a\n",
    "deploy/pinned-chart/values.yaml": "a: 1\n",
    "deploy/other-chart/values.yaml": "a: 1\n",
    "vendor/adapter/src/a.ts": "export {};\n",
    "tests/e2e/a.spec.ts": "export {};\n",
    "mystery/file.txt": "?\n",
    "README.md": "readme\n",
    "Dockerfile": "FROM x\n",
    ...extra,
  });
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init", "-q");
  git("add", "-A");
  return root;
}

function needed(root, changed) {
  const decisions = decide({ root, changed });
  return Object.fromEntries(GROUP_NAMES.map((name) => [name, decisions[name].needed]));
}

const ALL = Object.fromEntries(GROUP_NAMES.map((n) => [n, true]));
const NONE = Object.fromEntries(GROUP_NAMES.map((n) => [n, false]));

test("pure prose, unpinned workflows and unreachable scripts skip every suite or the unit suites", () => {
  const root = makeRepo();
  try {
    assert.deepEqual(needed(root, ["docs/guide.md"]), NONE);
    assert.deepEqual(needed(root, ["doc/free.md", ".planning/STATE.md", "README.md"]), NONE);
    assert.deepEqual(needed(root, [".github/workflows/other.yml"]), NONE);
    assert.deepEqual(needed(root, ["deploy/other-chart/values.yaml"]), NONE);
    assert.deepEqual(needed(root, ["vendor/adapter/src/a.ts"]), NONE);
    // scripts: inert for the unit suites when no test command reaches them, but
    // inputs of e2e and the release dry run (release.sh/e2e harness shell out).
    assert.deepEqual(needed(root, ["scripts/unrelated.mjs"]), {
      ...NONE,
      ui_e2e_needed: true,
      release_dry_run_needed: true,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a test that reads a path keeps that exact path relevant", () => {
  const root = makeRepo();
  try {
    for (const pinned of ["doc/pinned.md", ".github/workflows/pinned.yml", "deploy/pinned-chart/values.yaml"]) {
      const result = needed(root, [pinned]);
      assert.equal(result.server_tests_needed, true, `${pinned} is read by a server test`);
      assert.equal(result.workspaces_a_tests_needed, true, `${pinned}: cli reaches server, which reads it`);
    }
    assert.equal(needed(root, ["doc/free.md"]).server_tests_needed, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workspace closure follows package.json dependencies and relative imports", () => {
  const root = makeRepo();
  try {
    // shared is a dependency of server, ui and (through server) cli.
    assert.deepEqual(needed(root, ["packages/shared/src/index.ts"]), ALL);
    // lone is not a dependency of server, but cli imports it by relative path, so
    // the workspaces-a group (ui, cli) must run; server and group b need not.
    const lone = needed(root, ["packages/lone/src/index.ts"]);
    assert.equal(lone.workspaces_a_tests_needed, true);
    assert.equal(lone.workspaces_b_tests_needed, true, "lone is itself a group-b vitest project");
    assert.equal(lone.server_tests_needed, false, "server neither depends on nor imports lone");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a workspace outside every closure skips the unit suites but not the release dry run", () => {
  const root = makeRepo();
  try {
    writeTree(root, { "packages/orphan/package.json": pkg("@x/orphan"), "packages/orphan/src/a.ts": "export {};\n" });
    execFileSync("git", ["add", "-A"], { cwd: root });
    assert.deepEqual(needed(root, ["packages/orphan/src/a.ts"]), {
      ...NONE,
      release_dry_run_needed: true,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("server-only changes reach server, cli and e2e, not an unrelated group", () => {
  const root = makeRepo();
  try {
    const result = needed(root, ["server/src/app.ts"]);
    assert.equal(result.server_tests_needed, true);
    assert.equal(result.ui_e2e_needed, true);
    assert.equal(result.release_dry_run_needed, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("always-relevant paths run everything", () => {
  const root = makeRepo();
  try {
    for (const file of [
      ".github/workflows/pr.yml",
      ".github/actions/setup/action.yml",
      "scripts/select-ci-suites.mjs",
      "scripts/run-vitest-stable.mjs",
      "scripts/helper.mjs",
      "package.json",
      "pnpm-workspace.yaml",
      "vitest.config.ts",
      "Dockerfile",
    ]) {
      const result = needed(root, [file]);
      assert.equal(result.server_tests_needed, true, `${file} must run the server suite`);
      assert.equal(result.release_dry_run_needed, true, `${file} must run the release dry run`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scripts reachable from a test command stay relevant, transitively", () => {
  const root = makeRepo();
  try {
    // run-vitest-stable.mjs (named by `test:run`) imports ./helper.mjs which names scripts/data/seed.json.
    assert.equal(needed(root, ["scripts/data/seed.json"]).server_tests_needed, true);
    assert.equal(needed(root, ["scripts/ensure-links.ts"]).server_tests_needed, true);
    // check:docs is a root script no test command names.
    assert.equal(needed(root, ["scripts/check-docs-only.mjs"]).server_tests_needed, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unknown top-level directories and unknown root files run everything", () => {
  const root = makeRepo();
  try {
    assert.deepEqual(needed(root, ["mystery/file.txt"]), ALL);
    assert.deepEqual(needed(root, ["brand-new-dir/x.ts"]), ALL);
    assert.deepEqual(needed(root, [".some-new-root-config"]), ALL);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a mixed diff runs a suite when any single path reaches it", () => {
  const root = makeRepo();
  try {
    const result = needed(root, ["docs/guide.md", ".github/workflows/other.yml", "server/src/app.ts"]);
    assert.equal(result.server_tests_needed, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fail open: empty diff, missing SHAs, a bad workspace file and a crash all run everything", () => {
  const root = makeRepo();
  try {
    assert.deepEqual(needed(root, []), ALL);
    assert.deepEqual(Object.fromEntries(GROUP_NAMES.map((n) => [n, decide({ root, base: "", head: "" })[n].needed])), ALL);
    assert.deepEqual(
      Object.fromEntries(GROUP_NAMES.map((n) => [n, decide({ root, base: "nope", head: "nope2" })[n].needed])),
      ALL,
    );
    writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages:\n  - 'packages/**/x*'\n");
    assert.deepEqual(needed(root, ["docs/guide.md"]), ALL, "an unsupported workspace pattern must not skip");
    writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages:\n");
    assert.deepEqual(needed(root, ["docs/guide.md"]), ALL, "no workspaces must not skip");
    rmSync(path.join(root, "vitest.config.ts"));
    writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages:\n  - server\n");
    assert.deepEqual(needed(root, ["docs/guide.md"]), ALL, "a missing vitest project list must not skip");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the diff is read as base...head and renames count both paths", () => {
  const root = makeRepo();
  try {
    const git = (...args) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: root, encoding: "utf8" }).trim();
    git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD");
    git("mv", "server/src/app.ts", "docs/app-moved.md");
    git("commit", "-qm", "rename out of the server");
    const head = git("rev-parse", "HEAD");
    const decisions = decide({ root, base, head });
    assert.equal(decisions.server_tests_needed.needed, true, "the old server path must still count");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("formatOutputs emits one literal true/false line per group", () => {
  const lines = formatOutputs(decide({ root: repoRoot, changed: [] })).trim().split("\n");
  assert.deepEqual(lines, GROUP_NAMES.map((n) => `${n}=true`));
});

test("reference extraction: whole-path literals, joins, shell tokens; not prose or comments", () => {
  const tops = ["doc", "docs", "scripts", "deploy", ".github", "server"];
  const refs = (text, dir = "server/src/__tests__", opts) => referencedPaths(text, dir, tops, opts);
  assert.ok(refs('path.join(root, "doc", "x.md")').has("doc/x.md"));
  assert.ok(refs('"../../../deploy/helm/a.yaml"').has("deploy/helm/a.yaml"));
  assert.ok(refs('execSync("node scripts/run.mjs --flag")').has("scripts/run.mjs"));
  assert.ok(refs("`${root}/x`").size === 0);
  assert.ok(refs("`docs/sub/${name}.md`").has("docs/sub"));
  assert.equal(refs('// see docs/guide.md for details\nconst a = 1;').size, 0, "comments are not references");
  assert.equal(refs('const m = "see docs/guide for details";').size, 0, "a directory mentioned in prose is not a read");
  assert.equal(refs('const m = "COPY deploy/chart /dst";').size, 0, "a directory argument is not a read");
  assert.ok(refs('const m = "cat docs/guide.md";').has("docs/guide.md"));
  assert.ok(refs('source "$(dirname "$0")/x.sh"', "scripts", { shell: true }).size === 0);
  assert.equal(refs('# docs/commented.md\necho hi', "scripts", { shell: true }).size, 0);
});

// ---------------------------------------------------------------------------
// The real repository: pin the properties the derivation relies on.
// ---------------------------------------------------------------------------

test("real repo: vitest projects are exactly the server group plus the two workspace groups", () => {
  const dirs = vitestProjectDirs(repoRoot);
  const runner = readFileSync(path.join(repoRoot, "scripts/run-vitest-stable.mjs"), "utf8");
  const names = [...runner.match(/generalWorkspacesAProjects = \[([^\]]*)\]/)[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const ctx = buildContext(repoRoot);
  const aDirs = names.map((name) => ctx.byName.get(name)?.dir);
  assert.deepEqual([...aDirs].sort(), [...UNIT_GROUP_A_ROOTS].sort(), "UNIT_GROUP_A_ROOTS must mirror run-vitest-stable.mjs");
  assert.ok(dirs.includes("server"));
  for (const dir of dirs) assert.ok(ctx.workspaces.some((w) => w.dir === dir), `${dir} must be a pnpm workspace`);
  assert.ok(listWorkspaces(repoRoot, ctx.files).length >= dirs.length);
});

test("real repo: paths that tests read, or that define what runs, are never skipped", () => {
  const mustRun = [
    ".github/workflows/pr.yml",
    ".github/actions/setup-pnpm/action.yml",
    "scripts/select-ci-suites.mjs",
    "scripts/run-vitest-stable.mjs",
    "scripts/general-server-shard-durations.json",
    "pnpm-lock.yaml",
    "package.json",
    "vitest.config.ts",
    "Dockerfile",
    "server/src/app.ts",
    "packages/shared/src/index.ts",
    "ui/src/main.tsx",
    "patches/postgres@3.4.9.patch",
  ];
  const ctx = buildContext(repoRoot);
  for (const file of mustRun) {
    const decisions = decide({ root: repoRoot, changed: [file], ctx });
    assert.equal(decisions.server_tests_needed.needed, true, `${file} must run the server shards`);
  }
});

test("real repo: files that server tests read by path stay relevant to the server shards", () => {
  const ctx = buildContext(repoRoot);
  const present = (file) => ctx.files.includes(file);
  const pinned = [
    "doc/execution-semantics.md",
    "runbooks/agent-wakeup-terminal-failed.md",
    "deploy/helm/paperclip/templates/prometheusrule.yaml",
    ".github/workflows/docker.yml",
    "vendor/paperclip-adapter-claude-k8s/src/server/job-manifest.ts",
  ].filter(present);
  assert.ok(pinned.length > 0, "none of the pinned fixtures exist; update this list");
  for (const file of pinned) {
    assert.equal(
      decide({ root: repoRoot, changed: [file], ctx }).server_tests_needed.needed,
      true,
      `${file} is read by a server test and must run the server shards`,
    );
  }
});

test("real repo: a prose-only diff skips every suite", () => {
  const ctx = buildContext(repoRoot);
  const prose = ctx.files.filter((f) => f.startsWith("docs/") && f.endsWith(".md")).slice(0, 1);
  assert.equal(prose.length, 1, "expected at least one docs/*.md file");
  const decisions = decide({ root: repoRoot, changed: prose, ctx });
  for (const name of GROUP_NAMES) {
    assert.equal(decisions[name].needed, false, `${prose[0]} must not run ${name}: ${JSON.stringify(decisions[name].trigger)}`);
  }
});

// ---------------------------------------------------------------------------
// pr.yml wiring: a skipped suite must never read as a failed or absent check,
// and a failed suite must never be masked as skipped.
// ---------------------------------------------------------------------------

const workflow = readFileSync(path.join(repoRoot, ".github/workflows/pr.yml"), "utf8");

function jobBlock(name) {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  assert.notEqual(start, -1, `pr.yml must define ${name}`);
  const next = workflow.slice(start + 1).search(/\n  [a-z_0-9]+:\n/);
  return workflow.slice(start, next === -1 ? undefined : start + 1 + next);
}

test("policy publishes one output per group, from a continue-on-error selector step", () => {
  const policy = jobBlock("policy");
  for (const name of GROUP_NAMES) {
    assert.match(policy, new RegExp(`      ${name}: \\$\\{\\{ steps\\.select_suites\\.outputs\\.${name} \\}\\}`));
  }
  assert.match(
    policy,
    /- name: Select suites reachable from this diff\n        id: select_suites\n        continue-on-error: true\n        run: node \.\/scripts\/select-ci-suites\.mjs\n        timeout-minutes: 3/,
  );
  assert.match(policy, /- name: Test CI suite selector\n        if: \$\{\{ !cancelled\(\) \}\}\n        run: node --test \.\/scripts\/__tests__\/select-ci-suites\.test\.mjs/);
});

test("every consumer skips only on the literal 'false' (fail open)", () => {
  const uses = [...workflow.matchAll(/needs\.policy\.outputs\.(\w+_needed)\b[^\n]*/g)];
  assert.ok(uses.length >= 5);
  for (const [line, output] of uses) {
    assert.ok(GROUP_NAMES.includes(output), `${output} is not a selector output`);
    assert.doesNotMatch(line, /== 'true'|== "true"|== true/, `${line} would fail closed on an empty output`);
  }
});

test("general_tests keeps its jobs (names, matrix) and gates only steps, never the job", () => {
  const general = jobBlock("general_tests");
  assert.doesNotMatch(general, /\n    if:/, "a job-level if would drop matrix check names and read as absent");
  assert.match(general, /name: General tests \(\$\{\{ matrix\.group_label \}\}\)/);
  const select = general.indexOf("id: select\n");
  assert.ok(select > 0 && select < general.indexOf("- name: Checkout repository"), "selection must precede the heavy steps");
  const heavy = [
    "Checkout repository",
    "Setup pnpm",
    "Restore regenerated PR lockfile (if policy uploaded one)",
    "Setup Node.js",
    "Install dependencies",
    "Run grouped general test suites",
    "Run serialized server test shard",
  ];
  for (const stepName of heavy) {
    const start = general.indexOf(`- name: ${stepName}\n`);
    assert.notEqual(start, -1, `missing step ${stepName}`);
    const end = general.indexOf("\n      - name:", start + 1);
    const step = general.slice(start, end === -1 ? undefined : end);
    assert.match(step, /\n        if: [^\n]*steps\.select\.outputs\.run == 'true'/, `${stepName} must be gated on the selection`);
  }
  // The flake-ledger upload must keep running after a FAILED suite.
  const upload = general.slice(general.indexOf("- name: Upload vitest JSON reports (flake ledger)"));
  assert.match(upload, /if: always\(\)/);
});

test("the selection shell step skips on the literal 'false' only, per group", () => {
  const general = jobBlock("general_tests");
  const script = general.match(/id: select\n[\s\S]*?run: \|\n((?:          [^\n]*\n|\n)+)/)[1].replace(/^ {10}/gm, "");
  const run = (group, env) => {
    const dir = mkdtempSync(path.join(tmpdir(), "select-step-"));
    const out = path.join(dir, "out");
    writeFileSync(out, "");
    const result = spawnSync("bash", ["-c", script], {
      env: { PATH: process.env.PATH, GROUP: group, GITHUB_OUTPUT: out, ...env },
      encoding: "utf8",
    });
    const output = readFileSync(out, "utf8").trim();
    rmSync(dir, { recursive: true, force: true });
    assert.equal(result.status, 0, result.stderr);
    return output;
  };
  const all = (v) => ({ SERVER_TESTS_NEEDED: v, WORKSPACES_A_TESTS_NEEDED: v, WORKSPACES_B_TESTS_NEEDED: v });
  assert.equal(run("general-server", all("false")), "run=false");
  assert.equal(run("general-workspaces-a", all("false")), "run=false");
  assert.equal(run("general-workspaces-b", all("false")), "run=false");
  for (const value of ["true", "", "TRUE", "0", "null"]) {
    assert.equal(run("general-server", all(value)), "run=true", `'${value}' must run the suite`);
  }
  assert.equal(run("general-server", { ...all("true"), SERVER_TESTS_NEEDED: "false" }), "run=false");
  assert.equal(
    run("general-workspaces-a", { ...all("true"), SERVER_TESTS_NEEDED: "false" }),
    "run=true",
    "skipping the server shards must not skip a workspaces shard",
  );
  assert.equal(run("some-future-group", all("false")), "run=true", "an unknown group always runs");
});

test("e2e and canary are skipped at job level, and verify neither needs nor reclassifies them", () => {
  assert.match(jobBlock("canary_dry_run"), /\n    if: \$\{\{ needs\.policy\.outputs\.release_dry_run_needed != 'false' \}\}\n/);
  assert.match(jobBlock("e2e"), /\n    if: \$\{\{ needs\.policy\.outputs\.ui_e2e_needed != 'false' \}\}\n/);
  const verify = jobBlock("verify");
  assert.doesNotMatch(verify, /\n        (?:e2e|canary_dry_run),/);
  // verify still treats a skipped required lane as not-passed, so a lane that never
  // ran because policy failed cannot turn green. general_tests itself never skips.
  assert.match(verify, /skipped\) skipped_lanes\+=\("\$lane"\) ;;/);
  assert.match(verify, /\n    needs:\n      \[\n        helm_chart,\n        typecheck_release_registry,\n        general_tests,/);
});
