import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  CI_CONTROL_PATHS,
  KILL_SWITCH_VARIABLE,
  MAX_RESULT_AGE_HOURS,
  TRIM_LANES,
  decideTrim,
  formatOutputs,
  gatherFacts,
  parseQueueRef,
  patchId,
  repoRoot,
} from "../merge-group-trim.mjs";

// Contract for the merge-group heavy-lane trim (owner directives 2026-10-07 /
// 2026-10-09). Two modes, both pinned here: TRIM (merge_group, kill switch
// unset, the PR head passed the lane, the queue applies exactly the tested
// change set) and FULL SUITE (kill switch PAPERCLIP_CI_MERGE_GROUP_FULL_SUITE
// =true, any pull_request run, or any fact that cannot be established). Also
// pinned: master-health.yml no longer reads a trimmed merge group as proof that
// the server suites ran on the landed tree.

const workflow = readFileSync(new URL("../../.github/workflows/pr.yml", import.meta.url), "utf8");
const masterHealth = readFileSync(new URL("../../.github/workflows/master-health.yml", import.meta.url), "utf8");
const script = fileURLToPath(new URL("../merge-group-trim.mjs", import.meta.url));

const PARENT = "171f10266fa8f0f78bb8f22f4555e37db9f30461";
const GROUP_HEAD = "2e15ab79c3b64c52decfec9a979918b13a75224c";
const PR_HEAD = "d1447769793dcc320eae4593c4cc856c3a4fbfb7";
const NOW = Date.parse("2026-10-09T12:00:00Z");
const DONE = "2026-10-09T08:00:00Z";
const LANES = Object.keys(TRIM_LANES);

const step = (name, conclusion = "success") => ({ name, conclusion });
const SETUP = [step("Set up job"), step("Checkout repository"), step("Restore regenerated PR lockfile (if policy uploaded one)", "skipped")];
function job(name, conclusion = "success", completed_at = DONE, proof) {
  const lane = Object.values(TRIM_LANES).find((l) => (l.matrix ? l.matrix.test(name) : l.name === name));
  const steps = [...SETUP, ...(proof ?? lane?.proofSteps ?? []).map((s) => step(s, conclusion === "success" ? "success" : conclusion))];
  return { name, status: "completed", conclusion, completed_at, steps };
}
const greenJobs = (completed_at = DONE) => [
  ...Array.from({ length: 6 }, (_, i) => job(`General tests (server ${i + 1}/6)`, "success", completed_at)),
  job("General tests (workspaces-a)", "success", completed_at),
  job("Worktree install (NODE_ENV=production)", "success", completed_at),
  job("OpenCode Responses replay", "success", completed_at),
  job("k8s-ro seed transport cold start", "success", completed_at),
  job("e2e", "success", completed_at),
  job("Canary Dry Run", "success", completed_at),
  job("verify", "success", completed_at),
];
const GREEN_PR_HEAD = greenJobs();

function facts(overrides = {}) {
  return {
    eventName: "merge_group",
    killSwitch: "",
    headRef: `refs/heads/gh-readonly-queue/master/pr-2346-${PARENT}`,
    baseRef: "refs/heads/master",
    baseSha: PARENT,
    headSha: GROUP_HEAD,
    defaultBranch: "master",
    pullRequest: { number: 2346, state: "open", baseRef: "master", headSha: PR_HEAD },
    changedPaths: ["server/src/services/heartbeat.ts"],
    patchIdMatch: true,
    treeMatch: true,
    prHeadJobs: GREEN_PR_HEAD,
    ...overrides,
  };
}
const trimmed = (d) => LANES.filter((k) => d.lanes[k].trim);
const allOutputs = (value) => LANES.map((k) => `merge_group_trim_${k}=${value}`).join("\n") + "\n";

// ---------------------------------------------------------------------------
// Decision: the two modes.
// ---------------------------------------------------------------------------

test("TRIM mode: a merge group whose PR head passed every heavy lane skips all of them", () => {
  const d = decideTrim(facts(), NOW);
  assert.deepEqual(trimmed(d), LANES);
  assert.equal(formatOutputs(d), allOutputs("true"));
});

for (const value of ["true", "TRUE", " true\n"]) {
  test(`FULL SUITE mode: kill switch ${KILL_SWITCH_VARIABLE}=${JSON.stringify(value)} runs every lane`, () => {
    const d = decideTrim(facts({ killSwitch: value }), NOW);
    assert.deepEqual(trimmed(d), []);
    assert.match(d.reason, /kill switch/);
    assert.equal(formatOutputs(d), allOutputs("false"));
  });
}

test("the kill switch is opt-in: unset, empty or any other value leaves TRIM mode on", () => {
  for (const killSwitch of [undefined, "", "false", "0", "no"]) {
    assert.deepEqual(trimmed(decideTrim(facts({ killSwitch }), NOW)), LANES, String(killSwitch));
  }
});

test("FULL SUITE mode: pull_request never trims, whatever else is true", () => {
  assert.deepEqual(trimmed(decideTrim(facts({ eventName: "pull_request" }), NOW)), []);
});

test("the merge-sensitive lanes are not trimmable at all", () => {
  for (const name of ["policy", "build", "typecheck_release_registry", "helm_chart", "vendor_claude_k8s", "verify"]) {
    assert.ok(!(name in TRIM_LANES), `${name} must always run on the merged tree`);
    assert.ok(!Object.values(TRIM_LANES).some((l) => l.job === name), `${name} must always run on the merged tree`);
  }
  for (const name of ["General tests (workspaces-a)", "General tests (workspaces-b)"]) {
    assert.ok(!Object.values(TRIM_LANES).some((l) => (l.matrix ? l.matrix.test(name) : l.name === name)), name);
  }
});

// ---------------------------------------------------------------------------
// Fail-open: every unestablished fact means "run the lane".
// ---------------------------------------------------------------------------

const FAIL_OPEN = {
  "unrecognised queue ref": { headRef: "refs/heads/feature/x" },
  "queue of a non-default branch": {
    headRef: `refs/heads/gh-readonly-queue/release/pr-2346-${PARENT}`,
    baseRef: "refs/heads/release",
    pullRequest: { number: 2346, state: "open", baseRef: "release", headSha: PR_HEAD },
  },
  "default branch unreadable": { defaultBranch: undefined },
  "parent is not merge_group.base_sha": { baseSha: PR_HEAD },
  "merge-group head SHA missing": { headSha: undefined },
  "PR unreadable": { pullRequest: undefined },
  "PR closed": { pullRequest: { number: 2346, state: "closed", baseRef: "master", headSha: PR_HEAD } },
  "PR targets another branch": { pullRequest: { number: 2346, state: "open", baseRef: "release", headSha: PR_HEAD } },
  "PR number mismatch": { pullRequest: { number: 9, state: "open", baseRef: "master", headSha: PR_HEAD } },
  "PR head SHA malformed": { pullRequest: { number: 2346, state: "open", baseRef: "master", headSha: "d1447769" } },
  "change set unavailable": { changedPaths: undefined },
  "empty change set": { changedPaths: [] },
  "change set touches pr.yml": { changedPaths: ["a.ts", ".github/workflows/pr.yml"] },
  "change set touches a composite action": { changedPaths: [".github/actions/setup-pnpm/action.yml"] },
  "change set touches the trim script": { changedPaths: ["scripts/merge-group-trim.mjs"] },
  "patch-id differs": { patchIdMatch: false },
  "patch-id unknown": { patchIdMatch: undefined },
  "merge-group tree is not git's merge of the PR head": { treeMatch: false },
  "merge-tree identity unknown": { treeMatch: undefined },
  "PR-head jobs unreadable": { prHeadJobs: undefined },
};
for (const [label, override] of Object.entries(FAIL_OPEN)) {
  test(`fails open (runs every lane) when ${label}`, () => {
    assert.deepEqual(trimmed(decideTrim(facts(override), NOW)), []);
  });
}

test("CI-control paths are exactly pr.yml, composite actions, this script and master-health.yml", () => {
  assert.equal(CI_CONTROL_PATHS.length, 4);
  assert.ok(CI_CONTROL_PATHS.some((re) => re.test(".github/workflows/pr.yml")));
  // The trim is safe only because master-health.yml re-runs the server suites
  // on master; a landing that changes that backstop must not itself be trimmed.
  assert.ok(CI_CONTROL_PATHS.some((re) => re.test(".github/workflows/master-health.yml")));
  assert.ok(!CI_CONTROL_PATHS.some((re) => re.test(".github/workflows/e2e.yml")));
  assert.ok(!CI_CONTROL_PATHS.some((re) => re.test("scripts/__tests__/merge-group-trim.test.mjs")));
});

// ---------------------------------------------------------------------------
// Per-lane verdicts read off the PR head's own pull_request pr.yml jobs.
// ---------------------------------------------------------------------------

test("one red server shard keeps every server shard running, and only those", () => {
  const jobs = GREEN_PR_HEAD.map((j) => (j.name === "General tests (server 4/6)" ? job(j.name, "failure") : j));
  const d = decideTrim(facts({ prHeadJobs: jobs }), NOW);
  assert.equal(d.lanes.general_server.trim, false);
  assert.match(d.lanes.general_server.why, /server 4\/6\) concluded failure/);
  assert.deepEqual(trimmed(d), LANES.filter((k) => k !== "general_server"));
});

test("a missing server leg is not a pass: the whole 1..N matrix must be on the PR head", () => {
  const jobs = GREEN_PR_HEAD.filter((j) => j.name !== "General tests (server 5/6)");
  const d = decideTrim(facts({ prHeadJobs: jobs }), NOW);
  assert.equal(d.lanes.general_server.trim, false);
  assert.match(d.lanes.general_server.why, /leg 5\/6/);
});

test("a complete matrix under an older shard count still counts, a broken one does not", () => {
  const four = Array.from({ length: 4 }, (_, i) => job(`General tests (server ${i + 1}/4)`));
  const others = GREEN_PR_HEAD.filter((j) => !j.name.startsWith("General tests (server"));
  assert.equal(decideTrim(facts({ prHeadJobs: [...others, ...four] }), NOW).lanes.general_server.trim, true);
  const mixed = [...GREEN_PR_HEAD, ...four.slice(0, 3)];
  assert.equal(decideTrim(facts({ prHeadJobs: mixed }), NOW).lanes.general_server.trim, false);
});

test("a PR-head job that skipped its proof steps (path selector) is not a pass", () => {
  const skippedSuites = (j) =>
    j.name.startsWith("General tests (server")
      ? { ...j, steps: j.steps.map((s) => (TRIM_LANES.general_server.proofSteps.includes(s.name) ? { ...s, conclusion: "skipped" } : s)) }
      : j;
  const d = decideTrim(facts({ prHeadJobs: GREEN_PR_HEAD.map(skippedSuites) }), NOW);
  assert.equal(d.lanes.general_server.trim, false);
  assert.match(d.lanes.general_server.why, /did not run "Run grouped general test suites" to success/);
  const noSteps = GREEN_PR_HEAD.map((j) => (j.name === "e2e" ? { ...j, steps: undefined } : j));
  assert.equal(decideTrim(facts({ prHeadJobs: noSteps }), NOW).lanes.e2e.trim, false);
});

for (const conclusion of ["skipped", "cancelled", "failure", null]) {
  test(`a PR-head e2e that concluded ${conclusion} is not a pass`, () => {
    const jobs = GREEN_PR_HEAD.map((j) => (j.name === "e2e" ? { ...j, conclusion } : j));
    assert.equal(decideTrim(facts({ prHeadJobs: jobs }), NOW).lanes.e2e.trim, false);
  });
}

test("a lane absent from the PR head run is not a pass", () => {
  const jobs = GREEN_PR_HEAD.filter((j) => j.name !== "Canary Dry Run" && !j.name.startsWith("General tests (server"));
  const d = decideTrim(facts({ prHeadJobs: jobs }), NOW);
  assert.equal(d.lanes.canary_dry_run.trim, false);
  assert.equal(d.lanes.general_server.trim, false);
});

test("a job that has not completed is no verdict, and the newest completed verdict per job wins", () => {
  const inProgress = { ...job("e2e"), status: "in_progress", conclusion: null, completed_at: null };
  const withoutE2e = GREEN_PR_HEAD.filter((j) => j.name !== "e2e");
  assert.equal(decideTrim(facts({ prHeadJobs: [...withoutE2e, inProgress] }), NOW).lanes.e2e.trim, false);
  const redThenGreen = [...withoutE2e, job("e2e", "failure", "2026-10-09T07:00:00Z"), job("e2e")];
  assert.equal(decideTrim(facts({ prHeadJobs: redThenGreen }), NOW).lanes.e2e.trim, true);
  const greenThenRed = [...withoutE2e, job("e2e"), job("e2e", "failure", "2026-10-09T09:00:00Z")];
  assert.equal(decideTrim(facts({ prHeadJobs: greenThenRed }), NOW).lanes.e2e.trim, false);
});

test(`a PR-head pass older than ${MAX_RESULT_AGE_HOURS}h is stale and re-runs`, () => {
  const old = new Date(NOW - (MAX_RESULT_AGE_HOURS + 1) * 3_600_000).toISOString();
  const jobs = GREEN_PR_HEAD.map((j) => (j.name === "Worktree install (NODE_ENV=production)" ? job(j.name, "success", old) : j));
  const d = decideTrim(facts({ prHeadJobs: jobs }), NOW);
  assert.equal(d.lanes.worktree_install.trim, false);
  assert.match(d.lanes.worktree_install.why, /old/);
  assert.equal(d.lanes.e2e.trim, true);
});

test("queue refs parse only for the readonly queue of the base branch", () => {
  assert.deepEqual(parseQueueRef(`refs/heads/gh-readonly-queue/master/pr-12-${PARENT}`), { pr: 12, parentSha: PARENT, baseBranch: "master" });
  assert.equal(parseQueueRef(`refs/heads/gh-readonly-queue/main/pr-12-${PARENT}`), null);
  assert.equal(parseQueueRef(`refs/heads/gh-readonly-queue/master/pr-12-${PARENT.slice(0, 8)}`), null);
  assert.equal(parseQueueRef(undefined), null);
});

// ---------------------------------------------------------------------------
// The script itself never fails the job and never trims what it cannot prove.
// ---------------------------------------------------------------------------

function runScript(env) {
  const dir = mkdtempSync(join(tmpdir(), "mg-trim-"));
  const out = join(dir, "output");
  try {
    const r = spawnSync(process.execPath, [script], {
      env: { PATH: process.env.PATH, GITHUB_OUTPUT: out, GH_TOKEN: "", GITHUB_API_URL: "http://127.0.0.1:9", ...env },
      encoding: "utf8",
      timeout: 30_000,
    });
    let output = "";
    try {
      output = readFileSync(out, "utf8");
    } catch {}
    return { status: r.status, output };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const QUEUE_ENV = {
  GITHUB_EVENT_NAME: "merge_group",
  MERGE_GROUP_HEAD_REF: `refs/heads/gh-readonly-queue/master/pr-1-${PARENT}`,
  MERGE_GROUP_BASE_REF: "refs/heads/master",
  MERGE_GROUP_BASE_SHA: PARENT,
  MERGE_GROUP_HEAD_SHA: GROUP_HEAD,
  MERGE_GROUP_DEFAULT_BRANCH: "master",
  GITHUB_REPOSITORY: "o/r",
};
for (const [label, env] of [
  ["the kill switch is set", { ...QUEUE_ENV, MERGE_GROUP_FULL_SUITE: "true" }],
  ["the GitHub API is unreachable", QUEUE_ENV],
  ["the event is pull_request", { GITHUB_EVENT_NAME: "pull_request" }],
]) {
  test(`the script exits 0 and emits all-false outputs when ${label}`, () => {
    const r = runScript(env);
    assert.equal(r.status, 0);
    assert.equal(r.output, allOutputs("false"));
  });
}

// The decision is made by the merge group BASE's copy of the script (design
// §3.3: trusted code), never the queued PR's copy: a PR that edits the script
// must not decide its own trim. The step's shell runs here as written.
function runDecideStep(t, { baseHasScript }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mg-trim-decide-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  const temp = join(root, "runner-temp");
  mkdirSync(join(repo, "scripts"), { recursive: true });
  mkdirSync(temp);
  const g = (...args) => execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd: repo, env: GIT_ENV }).toString().trim();
  const stub = (who) =>
    `import { appendFileSync } from "node:fs";\nappendFileSync(process.env.GITHUB_OUTPUT, "copy=${who}\\nroot=" + process.env.MERGE_GROUP_TRIM_REPO_ROOT + "\\n");\n`;
  g("init", "-q", "-b", "master");
  writeFileSync(join(repo, "README"), "base\n");
  if (baseHasScript) writeFileSync(join(repo, "scripts", "merge-group-trim.mjs"), stub("base"));
  g("add", "-A");
  g("commit", "-q", "-m", "base");
  const base = g("rev-parse", "HEAD");
  writeFileSync(join(repo, "scripts", "merge-group-trim.mjs"), stub("queued-pr"));
  g("add", "-A");
  g("commit", "-q", "-m", "queued PR edits the trim script");
  const out = join(root, "output");
  writeFileSync(out, "");
  const decide = jobRegion("policy").slice(jobRegion("policy").indexOf("- name: Decide merge-group heavy-lane trim\n"));
  const r = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", stepRun(decide, "Decide merge-group heavy-lane trim")], {
    cwd: repo,
    env: { PATH: process.env.PATH, GITHUB_OUTPUT: out, RUNNER_TEMP: temp, MERGE_GROUP_BASE_SHA: base, ...GIT_ENV },
    encoding: "utf8",
  });
  return { status: r.status, stdout: r.stdout, output: readFileSync(out, "utf8"), repo };
}

test("the decide step runs the merge group base's copy of the script, not the queued PR's", (t) => {
  const r = runDecideStep(t, { baseHasScript: true });
  assert.equal(r.status, 0, r.stdout);
  assert.equal(r.output, `copy=base\nroot=${r.repo}\n`);
});

test("with no script at the merge group base the decide step trims nothing and stays green", (t) => {
  const r = runDecideStep(t, { baseHasScript: false });
  assert.equal(r.status, 0, r.stdout);
  assert.equal(r.output, "", "no outputs: every consumer reads a missing output as run");
  assert.match(r.stdout, /::warning title=merge-group trim fell back to the full suite::/);
});

test("the repo root is MERGE_GROUP_TRIM_REPO_ROOT when set, else the script's parent directory", () => {
  assert.equal(repoRoot({ MERGE_GROUP_TRIM_REPO_ROOT: "/work/checkout" }), "/work/checkout");
  assert.equal(repoRoot({}), fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, ""));
  assert.equal(repoRoot({}, "file:///runner/_temp/merge-group-trim.base.mjs"), "/runner");
});

test("the real script still decides when run from a copy outside the checkout", (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "mg-trim-copy-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const copy = join(dir, "merge-group-trim.base.mjs");
  copyFileSync(script, copy);
  const out = join(dir, "output");
  const r = spawnSync(process.execPath, [copy], {
    env: { PATH: process.env.PATH, GITHUB_OUTPUT: out, GITHUB_EVENT_NAME: "pull_request", MERGE_GROUP_TRIM_REPO_ROOT: dir },
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(out, "utf8"), allOutputs("false"), "the main guard must fire for a copied script");
});

// ---------------------------------------------------------------------------
// Fact gathering on real git objects. A bare "origin" carries the PR head at
// refs/pull/7/head; the work tree is checked out at the merge-group head G,
// exactly as policy's checkout leaves it; a local HTTP server stands in for
// the GitHub API.
// ---------------------------------------------------------------------------

// A fixture must inherit none of the runner's own GITHUB_*, RUNNER_* or MERGE_GROUP_* variables. These tests aim
// GITHUB_OUTPUT and RUNNER_TEMP at files of their own, and an env spread that came after those keys let the
// runner's values win: the decide-step test wrote its outputs into policy's real step-output file and read an
// empty one back, red on ARC and green on a laptop where those variables do not exist.
const RUNNER_ENV_PREFIXES = ["GITHUB_", "RUNNER_", "MERGE_GROUP_"];
function withoutRunnerEnv(env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !RUNNER_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))));
}

test("fixtures inherit none of the runner's own GITHUB_*, RUNNER_* or MERGE_GROUP_* variables", () => {
  const inherited = withoutRunnerEnv({
    PATH: "/usr/bin",
    HOME: "/home/runner",
    GITHUB_OUTPUT: "/home/runner/_work/_temp/_runner_file_commands/set_output_1",
    GITHUB_EVENT_NAME: "pull_request",
    RUNNER_TEMP: "/home/runner/_work/_temp",
    MERGE_GROUP_BASE_SHA: "base",
  });
  assert.deepEqual(inherited, { PATH: "/usr/bin", HOME: "/home/runner" });
});

const GIT_ENV = {
  ...withoutRunnerEnv(process.env),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
};
const BLOCK =["c1", "c2", "c3", "x = 1", "c4", "c5", "c6"];

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "mg-trim-git-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const work = join(root, "work");
  const g = (...args) => execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd: work, env: GIT_ENV }).toString().trim();
  execFileSync("git", ["init", "-q", "--bare", "-b", "master", join(root, "origin.git")], { env: GIT_ENV });
  execFileSync("git", ["init", "-q", "-b", "master", work], { env: GIT_ENV });
  g("remote", "add", "origin", join(root, "origin.git"));
  const write = (file, lines) => writeFileSync(join(work, file), `${lines.join("\n")}\n`);
  const commit = (message) => {
    g("add", "-A");
    g("commit", "-q", "-m", message);
    return g("rev-parse", "HEAD");
  };
  // Base: a.txt holds two identical blocks, so a hunk can apply to either one.
  write("a.txt", [...BLOCK, ...BLOCK]);
  write("b.txt", ["b1", "b2", "b3", "b4", "b5", "b6", "b7", "b8"]);
  const B = commit("base");
  // PR head: two commits, edit block 1 of a.txt and add c.txt.
  g("checkout", "-q", "-b", "pr");
  write("a.txt", [...BLOCK.map((l) => (l === "x = 1" ? "x = 2" : l)), ...BLOCK]);
  commit("pr: bump x");
  write("c.txt", ["new"]);
  const H = commit("pr: add c");
  g("push", "-q", "origin", `${H}:refs/pull/7/head`);
  // Queue parent: master moved on with an unrelated change.
  g("checkout", "-q", "master");
  write("b.txt", ["b1", "b2", "b3", "b4", "b5", "b6", "b7", "B8"]);
  const P = commit("master: unrelated");
  return { root, work, g, write, commit, B, H, P };
}

// The merge-group head G: the PR's commits replayed onto P (a clean rebase), or
// a hand-built G for the adversarial cases.
function queueHead(fx, build) {
  fx.g("checkout", "-q", "-B", "queue", fx.P);
  if (build) build(fx);
  else fx.g("cherry-pick", "--allow-empty", `${fx.B}..${fx.H}`);
  return fx.g("rev-parse", "HEAD");
}

async function withApi(t, H, jobs) {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization });
    const send = (body) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.url === "/repos/o/r/pulls/7") return send({ number: 7, state: "open", base: { ref: "master" }, head: { sha: H } });
    if (req.url === `/repos/o/r/actions/workflows/pr.yml/runs?event=pull_request&head_sha=${H}&per_page=10`) {
      return send({ workflow_runs: [{ id: 101 }] });
    }
    if (req.url === "/repos/o/r/actions/runs/101/jobs?filter=latest&per_page=100") return send({ jobs });
    res.writeHead(404);
    res.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return { url: `http://127.0.0.1:${server.address().port}`, seen };
}

async function gather(t, fx, G, apiHead = fx.H) {
  const fresh = greenJobs(new Date(Date.now() - 3_600_000).toISOString());
  const api = await withApi(t, apiHead, fresh);
  const env = {
    GITHUB_EVENT_NAME: "merge_group",
    MERGE_GROUP_HEAD_REF: `refs/heads/gh-readonly-queue/master/pr-7-${fx.P}`,
    MERGE_GROUP_BASE_REF: "refs/heads/master",
    MERGE_GROUP_BASE_SHA: fx.P,
    MERGE_GROUP_HEAD_SHA: G,
    MERGE_GROUP_DEFAULT_BRANCH: "master",
    GITHUB_API_URL: api.url,
    GITHUB_REPOSITORY: "o/r",
    GH_TOKEN: "token-x",
  };
  return { facts: await gatherFacts(env, fx.work), seen: api.seen };
}

test("a clean rebase of the tested PR head is trimmed: patch-id and merge-tree both match", async (t) => {
  const fx = fixture(t);
  const G = queueHead(fx);
  const { facts: f, seen } = await gather(t, fx, G);
  assert.deepEqual(f.notes, []);
  assert.deepEqual([...f.changedPaths].sort(), ["a.txt", "c.txt"]);
  assert.equal(f.patchIdMatch, true);
  assert.equal(f.treeMatch, true);
  assert.equal(f.pullRequest.headSha, fx.H);
  assert.deepEqual(trimmed(decideTrim(f)), LANES);
  assert.ok(seen.every((r) => r.auth === "Bearer token-x"));
});

test("an extra edit inside the merge-group commit (an evil merge) is not trimmed", async (t) => {
  const fx = fixture(t);
  const G = queueHead(fx, (q) => {
    q.g("cherry-pick", `${q.B}..${q.H}`);
    q.write("c.txt", ["new", "smuggled"]);
    q.commit("queue: smuggled edit");
  });
  const { facts: f } = await gather(t, fx, G);
  assert.equal(f.patchIdMatch, false);
  assert.equal(f.treeMatch, false);
  assert.deepEqual(trimmed(decideTrim(f)), []);
});

test("the same hunk applied to the other identical block passes patch-id but not merge-tree", async (t) => {
  const fx = fixture(t);
  const G = queueHead(fx, (q) => {
    q.write("a.txt", [...BLOCK, ...BLOCK.map((l) => (l === "x = 1" ? "x = 2" : l))]);
    q.write("c.txt", ["new"]);
    q.commit("queue: relocated hunk");
  });
  const { facts: f } = await gather(t, fx, G);
  assert.equal(f.patchIdMatch, true, "patch-id ignores hunk line numbers, which is why merge-tree is also required");
  assert.equal(f.treeMatch, false);
  assert.deepEqual(trimmed(decideTrim(f)), []);
});

test("base drift inside the PR's hunk context merges cleanly but still refuses the trim", async (t) => {
  const fx = fixture(t);
  fx.write("a.txt", [...BLOCK.map((l) => (l === "c2" ? "C2" : l)), ...BLOCK]);
  const P2 = fx.commit("master: touches the PR hunk's context");
  fx.P = P2;
  const G = queueHead(fx);
  const { facts: f } = await gather(t, fx, G);
  assert.equal(f.treeMatch, true, "git merges it cleanly");
  assert.equal(f.patchIdMatch, false, "but the change the queue applies is not the one PR CI tested");
  assert.deepEqual(trimmed(decideTrim(f)), []);
});

test("an API head that is not the fetched refs/pull/N/head refuses the trim, even when its change is identical", async (t) => {
  const fx = fixture(t);
  // X carries H's exact tree and patch under a different message, so every git
  // identity check would pass on X: only the ref/API consistency check refuses.
  fx.g("checkout", "-q", "-b", "amended", fx.H);
  fx.g("commit", "-q", "--amend", "-m", "pr: add c (amended)");
  const X = fx.g("rev-parse", "HEAD");
  assert.notEqual(X, fx.H);
  const G = queueHead(fx);
  const { facts: f } = await gather(t, fx, G, X);
  assert.ok(
    f.notes.some((n) => n === `refs/pull/7/head is ${fx.H}, API says ${X}`),
    `expected the ref/API mismatch note, got ${JSON.stringify(f.notes)}`,
  );
  assert.notEqual(f.patchIdMatch, true);
  assert.notEqual(f.treeMatch, true);
  assert.deepEqual(trimmed(decideTrim(f)), []);
});

test("patch-id is whitespace-sensitive (--verbatim): an indentation-only change is a different patch", (t) => {
  const fx = fixture(t);
  fx.g("checkout", "-q", "-b", "ws", fx.B);
  fx.write("a.txt", [...BLOCK.map((l) => (l === "x = 1" ? "  x = 2" : l)), ...BLOCK]);
  fx.write("c.txt", ["new"]);
  const W = fx.commit("indented");
  assert.notEqual(patchId(fx.work, fx.B, W), patchId(fx.work, fx.B, fx.H));
  assert.equal(patchId(fx.work, fx.B, fx.H), patchId(fx.work, fx.B, fx.H));
});

// ---------------------------------------------------------------------------
// pr.yml wiring.
// ---------------------------------------------------------------------------

function jobRegion(key, source = workflow) {
  const start = source.indexOf(`\n  ${key}:\n`);
  assert.notEqual(start, -1, `workflow must define ${key}`);
  const next = source.slice(start + 1).search(/\n  [a-z_0-9]+:\n/);
  return next === -1 ? source.slice(start) : source.slice(start, start + 1 + next);
}

function stepRun(region, stepName) {
  const at = region.indexOf(`- name: ${stepName}\n`);
  assert.notEqual(at, -1, `missing step ${stepName}`);
  const run = region.indexOf("        run: |\n", at);
  const lines = [];
  for (const line of region.slice(run + "        run: |\n".length).split("\n")) {
    if (line !== "" && !line.startsWith("          ")) break;
    lines.push(line.slice(10));
  }
  return lines.join("\n");
}

function runStep(shell, env) {
  const dir = mkdtempSync(join(tmpdir(), "mg-trim-step-"));
  try {
    const out = join(dir, "out");
    const r = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", shell], {
      env: { PATH: process.env.PATH, GITHUB_OUTPUT: out, ...env },
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
    return readFileSync(out, "utf8").trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("policy decides the trim once, fails open, and reads the kill switch and the default branch", () => {
  const policy = jobRegion("policy");
  const decide = policy.slice(policy.indexOf("- name: Decide merge-group heavy-lane trim\n"));
  assert.match(
    decide,
    /^- name: Decide merge-group heavy-lane trim\n        id: merge_group_trim\n        if: \$\{\{ !cancelled\(\) && github\.event_name == 'merge_group' \}\}\n        continue-on-error: true\n/,
  );
  assert.match(decide, /MERGE_GROUP_FULL_SUITE: \$\{\{ vars\.PAPERCLIP_CI_MERGE_GROUP_FULL_SUITE \}\}/);
  assert.match(decide, /MERGE_GROUP_DEFAULT_BRANCH: \$\{\{ github\.event\.repository\.default_branch \}\}/);
  assert.match(decide, /\n        run: \|\n[\s\S]*git show "\$\{MERGE_GROUP_BASE_SHA\}:scripts\/merge-group-trim\.mjs"[\s\S]*\n        timeout-minutes: \d+\n/);
  assert.doesNotMatch(decide.slice(0, decide.indexOf("timeout-minutes:")), /node \.\/scripts\/merge-group-trim\.mjs/, "never the merge group's own copy");
  assert.ok(
    policy.indexOf("- name: Decide merge-group heavy-lane trim\n") > policy.indexOf("- name: Checkout repository\n"),
    "the decision needs policy's full-depth checkout",
  );
  assert.match(policy, /\n {6}pull-requests: read\n/, "the step reads /pulls/{n}");
  for (const key of LANES) {
    assert.match(policy, new RegExp(`\\n      merge_group_trim_${key}: \\$\\{\\{ steps\\.merge_group_trim\\.outputs\\.merge_group_trim_${key} \\}\\}\\n`));
  }
  assert.match(
    policy,
    /- name: Test merge-group heavy-lane trim and its kill switch\n        if: \$\{\{ !cancelled\(\) \}\}\n        run: node --test \.\/scripts\/__tests__\/merge-group-trim\.test\.mjs\n/,
  );
});

test("every lane's check name and proof steps exist in pr.yml, under the job that consumes its output", () => {
  for (const [key, lane] of Object.entries(TRIM_LANES)) {
    const region = jobRegion(lane.job);
    if (lane.matrix) {
      assert.match(region, /\n    name: General tests \(\$\{\{ matrix\.group_label \}\}\)\n/);
      const labels = [...region.matchAll(/\n {12}group_label: (server \d+\/\d+)\n/g)].map((m) => `General tests (${m[1]})`);
      assert.ok(labels.length > 0 && labels.every((n) => lane.matrix.test(n)), `${key}: every server leg matches the lane`);
    } else if (lane.name === lane.job) {
      assert.doesNotMatch(region.split("\n    steps:\n")[0], /\n    name: /, `${key}: the check name is the job id`);
    } else {
      assert.ok(region.includes(`\n    name: ${lane.name}\n`), `${key}: check name ${lane.name}`);
    }
    for (const proof of lane.proofSteps) assert.ok(region.includes(`- name: ${proof}\n`), `${key}: proof step ${proof}`);
    assert.ok(region.includes(`merge_group_trim_${key}`), `${key}: ${lane.job} must read its trim output`);
  }
});

const STEP_LANES = ["worktree_install", "opencode_responses_replay", "opencode_k8s_seed_cold_start"];

for (const key of STEP_LANES) {
  test(`${key} stays a reporting verify lane and gates every step on the trim`, () => {
    const region = jobRegion(key);
    assert.doesNotMatch(region, /\n    if: /, "a job-level skip would read as a skipped lane in verify");
    assert.match(region, /runs-on: \$\{\{ github\.event_name == 'merge_group' && 'arc-merge-queue' \|\| /);
    const steps = region.split("\n    steps:\n")[1].split(/\n(?=      - name: )/).filter((s) => s.trimStart().startsWith("- name:"));
    assert.match(steps[0], /- name: Resolve merge-group trim for this lane\n        id: trim\n/);
    assert.match(steps[0], new RegExp(`LANE_TRIM: \\$\\{\\{ needs\\.policy\\.outputs\\.merge_group_trim_${key} \\}\\}`));
    for (const s of steps.slice(1)) {
      assert.match(s, /\n        if: [^\n]*steps\.trim\.outputs\.run == 'true'/, `ungated step: ${s.split("\n")[0]}`);
    }
  });
}

const LANE_ENV = { EVENT_NAME: "merge_group", MERGE_GROUP_FULL_SUITE: "", LANE_TRIM: "true" };
for (const [label, env, expected] of [
  ["TRIM mode skips", LANE_ENV, "run=false"],
  ["kill switch runs", { ...LANE_ENV, MERGE_GROUP_FULL_SUITE: "true" }, "run=true"],
  ["pull_request runs", { ...LANE_ENV, EVENT_NAME: "pull_request" }, "run=true"],
  ["an empty policy output runs", { ...LANE_ENV, LANE_TRIM: "" }, "run=true"],
  ["a 'false' policy output runs", { ...LANE_ENV, LANE_TRIM: "false" }, "run=true"],
]) {
  test(`lane trim step: ${label}`, () => {
    for (const key of STEP_LANES) {
      assert.equal(runStep(stepRun(jobRegion(key), "Resolve merge-group trim for this lane"), env), expected, key);
    }
  });
}

const SELECT_ENV = {
  SERVER_TESTS_NEEDED: "true",
  WORKSPACES_A_TESTS_NEEDED: "true",
  WORKSPACES_B_TESTS_NEEDED: "true",
  EVENT_NAME: "merge_group",
  MERGE_GROUP_FULL_SUITE: "",
  MERGE_GROUP_TRIM_SERVER: "true",
};
for (const [label, env, expected] of [
  ["TRIM mode skips a server shard", { GROUP: "general-server" }, "run=false"],
  ["TRIM mode still runs workspaces-a", { GROUP: "general-workspaces-a" }, "run=true"],
  ["TRIM mode still runs workspaces-b", { GROUP: "general-workspaces-b" }, "run=true"],
  ["kill switch runs a server shard", { GROUP: "general-server", MERGE_GROUP_FULL_SUITE: "true" }, "run=true"],
  ["pull_request runs a server shard", { GROUP: "general-server", EVENT_NAME: "pull_request" }, "run=true"],
  ["an empty trim output runs a server shard", { GROUP: "general-server", MERGE_GROUP_TRIM_SERVER: "" }, "run=true"],
  ["the path selector still skips on its own", { GROUP: "general-server", SERVER_TESTS_NEEDED: "false", MERGE_GROUP_TRIM_SERVER: "" }, "run=false"],
]) {
  test(`general_tests selection: ${label}`, () => {
    const shell = stepRun(jobRegion("general_tests"), "Resolve whether this diff can reach this suite group");
    assert.equal(runStep(shell, { ...SELECT_ENV, ...env }), expected);
  });
}

test("general_tests reads the trim output and the kill switch in its selection step, and gates its suites on it", () => {
  const region = jobRegion("general_tests");
  assert.match(region, /MERGE_GROUP_TRIM_SERVER: \$\{\{ needs\.policy\.outputs\.merge_group_trim_general_server \}\}/);
  assert.match(region, /MERGE_GROUP_FULL_SUITE: \$\{\{ vars\.PAPERCLIP_CI_MERGE_GROUP_FULL_SUITE \}\}/);
  for (const proof of TRIM_LANES.general_server.proofSteps) {
    const at = region.indexOf(`- name: ${proof}\n`);
    assert.match(region.slice(at, region.indexOf("\n      - name: ", at + 1)), /\n        if: [^\n]*steps\.select\.outputs\.run == 'true'/, proof);
  }
});

for (const [key, selector] of [
  ["e2e", "ui_e2e_needed"],
  ["canary_dry_run", "release_dry_run_needed"],
]) {
  test(`${key} job-level skip needs merge_group AND kill switch unset AND the literal 'true'`, () => {
    const region = jobRegion(key);
    const expected =
      `    if: >-\n      \${{ needs.policy.outputs.${selector} != 'false' &&\n` +
      "      !(github.event_name == 'merge_group' &&\n" +
      "        vars.PAPERCLIP_CI_MERGE_GROUP_FULL_SUITE != 'true' &&\n" +
      `        needs.policy.outputs.merge_group_trim_${key} == 'true') }}\n`;
    assert.ok(region.includes(expected), `${key} must carry exactly the three-way trim gate`);
    assert.doesNotMatch(jobRegion("verify").split("\n    runs-on:")[0], new RegExp(`\\b${key}\\b`), `${key} must stay out of verify's needs`);
  });
}

test("verify, its lane list and the merge-sensitive lanes are untouched by the trim", () => {
  const verify = jobRegion("verify");
  for (const lane of ["helm_chart", "typecheck_release_registry", "general_tests", "worktree_install", "opencode_responses_replay", "opencode_k8s_seed_cold_start", "build", "vendor_claude_k8s"]) {
    assert.match(verify.split("\n    runs-on:")[0], new RegExp(`\\n {8}${lane},\\n`), `verify must still need ${lane}`);
  }
  assert.match(verify, /\n    if: \$\{\{ always\(\) && !cancelled\(\) \}\}\n/);
  assert.match(verify, /skipped\) skipped_lanes\+=\("\$lane"\) ;;/, "a skipped required lane still fails verify");
  for (const key of ["verify", "build", "typecheck_release_registry", "helm_chart", "vendor_claude_k8s"]) {
    assert.doesNotMatch(jobRegion(key), /merge_group_trim|PAPERCLIP_CI_MERGE_GROUP_FULL_SUITE/, `${key} must always run`);
  }
});

test("the arc-merge-queue admission pin still holds: every job stays inside pr.yml on merge_group", () => {
  assert.match(workflow, /\n  merge_group:\n    types:\n      - checks_requested\n/);
  assert.doesNotMatch(workflow, /\n    uses: /, "a reusable-workflow job would not be pr.yml@<queue ref> and is refused by the pool");
  for (const key of ["policy", "helm_chart", "typecheck_release_registry", "worktree_install", "opencode_responses_replay", "opencode_k8s_seed_cold_start", "general_tests", "verify", "build", "canary_dry_run", "e2e"]) {
    assert.match(jobRegion(key), /runs-on: \$\{\{ github\.event_name == 'merge_group' && 'arc-merge-queue' \|\| '[a-z0-9-]+' \}\}/, key);
  }
});

// ---------------------------------------------------------------------------
// master-health.yml: a trimmed merge group is NOT proof that the server suites
// ran on the landed tree. Its gate step is executed here as written, with a
// stand-in `gh` that answers from fixtures through the real `jq`.
// ---------------------------------------------------------------------------

function foldedEnv(region, name) {
  const at = region.indexOf(`          ${name}: >-\n`);
  assert.notEqual(at, -1, `missing env ${name}`);
  const lines = [];
  for (const line of region.slice(at).split("\n").slice(1)) {
    if (!line.startsWith("            ")) break;
    lines.push(line.trim());
  }
  return lines.join(" ");
}

const GATE = jobRegion("gate", masterHealth);
const SERVER_SUITES_RAN = foldedEnv(GATE, "SERVER_SUITES_RAN");
const WORKSPACES_SUITES_RAN = foldedEnv(GATE, "WORKSPACES_SUITES_RAN");
const GATE_RUN = stepRun(GATE, "Look for a successful merge_group build at this exact SHA");
const hasJq = spawnSync("jq", ["--version"]).status === 0;

const FAKE_GH = `#!/usr/bin/env bash
set -u
[ "$1" = api ] || exit 2
path="$2"; shift 2; filter=""
while [ $# -gt 0 ]; do case "$1" in --jq) filter="$2"; shift 2 ;; *) shift ;; esac; done
case "$path" in
  *"/actions/runs?event=merge_group&head_sha="*) f="$FIXTURES/runs.json" ;;
  *"/actions/runs/"*"/jobs?filter=latest&per_page=100") id="\${path#*/actions/runs/}"; f="$FIXTURES/jobs-\${id%%/*}.json" ;;
  *) exit 3 ;;
esac
[ -f "$f" ] || { echo "gh: HTTP 502" >&2; exit 1; }
exec jq -r "$filter" "$f"
`;

// One stand-in `gh` for every case (a fresh executable per case is slow to
// launch on some hosts); each case gets its own fixture directory.
const fakeBin = mkdtempSync(join(tmpdir(), "mg-trim-gh-"));
after(() => rmSync(fakeBin, { recursive: true, force: true }));
writeFileSync(join(fakeBin, "gh"), FAKE_GH);
chmodSync(join(fakeBin, "gh"), 0o755);

function runGate(t, fixtures) {
  const dir = mkdtempSync(join(tmpdir(), "mg-trim-gate-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [file, body] of Object.entries(fixtures)) writeFileSync(join(dir, file), JSON.stringify(body));
  const out = join(dir, "out");
  const r = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", GATE_RUN], {
    env: {
      PATH: `${fakeBin}:${process.env.PATH}`,
      FIXTURES: dir,
      GITHUB_OUTPUT: out,
      GH_TOKEN: "x",
      HEAD_SHA: GROUP_HEAD,
      REPO: "o/r",
      SERVER_SUITES_RAN,
      WORKSPACES_SUITES_RAN,
    },
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  return readFileSync(out, "utf8").trim();
}

const prRun = (id) => ({ id, path: ".github/workflows/pr.yml", conclusion: "success" });
const reviewRun = { id: 12, path: ".github/workflows/commitperclip-review.yml", conclusion: "success" };
const wsJob = (name, stepConclusion = "success") => ({
  ...job(name),
  steps: [...SETUP, step("Run grouped general test suites", stepConclusion)],
});
const WS = [wsJob("General tests (workspaces-a)"), wsJob("General tests (workspaces-b)")];
const serverJobs = (proof, ws = WS) => ({
  jobs: [
    ...Array.from({ length: 6 }, (_, i) => job(`General tests (server ${i + 1}/6)`, "success", DONE, proof)),
    ...ws,
    job("verify"),
  ],
});
const RAN = serverJobs();
const CARRIED = {
  jobs: serverJobs().jobs.map((j) =>
    j.name.startsWith("General tests (server")
      ? { ...j, steps: j.steps.map((s) => (TRIM_LANES.general_server.proofSteps.includes(s.name) ? { ...s, conclusion: "skipped" } : s)) }
      : j,
  ),
};

const one = (jobs) => ({ "runs.json": { workflow_runs: [prRun(11)] }, "jobs-11.json": jobs });
const serverFailedStepsGreen = {
  jobs: RAN.jobs.map((j) => (j.name === "General tests (server 3/6)" ? { ...j, conclusion: "failure" } : j)),
};
const ONLY_WS = { jobs: [...WS, job("verify")] };

// [server legs proven, workspaces legs proven]: each group is gated on its own
// proof, so a landing whose server shards were carried forward re-runs only
// the server legs here.
for (const [label, fixtures, [server, workspaces]] of [
  ["a merge group that RAN every shard proves both groups", one(RAN), [1, 1]],
  ["a merge group that CARRIED the server shards forward re-runs only the server legs", one(CARRIED), [0, 1]],
  ["a shard missing one suite step is not server proof", one(serverJobs(["Run grouped general test suites"])), [0, 1]],
  ["a server job that concluded failure is not proof, even with both suite steps green", one(serverFailedStepsGreen), [0, 1]],
  ["a build with no server jobs proves only what it ran", one(ONLY_WS), [0, 1]],
  ["a path-skipped workspaces suite step is not workspaces proof", one(serverJobs(undefined, [WS[0], wsJob("General tests (workspaces-b)", "skipped")])), [1, 0]],
  ["one workspaces group alone is not workspaces proof", one(serverJobs(undefined, [WS[0]])), [1, 0]],
  ["a build with neither group is no proof", one({ jobs: [job("verify")] }), [0, 0]],
  ["any one proving build among several is enough", { "runs.json": { workflow_runs: [prRun(11), prRun(13)] }, "jobs-11.json": CARRIED, "jobs-13.json": RAN }, [1, 1]],
  ["each group may be proven by a different build of this exact SHA", { "runs.json": { workflow_runs: [prRun(11), prRun(13)] }, "jobs-11.json": serverJobs(undefined, []), "jobs-13.json": ONLY_WS }, [1, 1]],
  ["a green review workflow is never proof", { "runs.json": { workflow_runs: [reviewRun] }, "jobs-12.json": RAN }, [0, 0]],
  ["no merge_group build at all (landed outside the queue)", { "runs.json": { workflow_runs: [] } }, [0, 0]],
  ["an unreadable run list fails closed", {}, [0, 0]],
  ["an unreadable job list fails closed", { "runs.json": { workflow_runs: [prRun(11)] } }, [0, 0]],
]) {
  test(`master-health gate: ${label}`, { skip: hasJq ? false : "jq is not installed" }, (t) => {
    assert.equal(runGate(t, fixtures), `pretested=${server}\npretested_workspaces=${workspaces}`);
  });
}

test("master-health never cancels a push run in flight; dispatch and schedule still supersede", () => {
  const block = masterHealth.slice(masterHealth.indexOf("\nconcurrency:\n"), masterHealth.indexOf("\npermissions:\n"));
  assert.match(block, /\n  group: master-health-\$\{\{ github\.ref \}\}-\$\{\{ github\.event_name \}\}\n/);
  assert.match(block, /\n  cancel-in-progress: \$\{\{ github\.event_name != 'push' \}\}\n/);
});

test("master-health gates its server and workspaces legs on separate proofs", () => {
  const server = jobRegion("general_tests", masterHealth);
  const ws = jobRegion("workspaces_tests", masterHealth);
  const bypass = " || github.event_name == 'workflow_dispatch' || github.event_name == 'schedule') }}\n";
  assert.ok(server.includes(`    if: \${{ !cancelled() && (needs.gate.outputs.pretested != '1'${bypass}`));
  assert.ok(ws.includes(`    if: \${{ !cancelled() && (needs.gate.outputs.pretested_workspaces != '1'${bypass}`));
  const groups = (region) => [...region.matchAll(/- group: (\S+)/g)].map((m) => m[1]);
  assert.deepEqual(groups(server), Array(4).fill("general-server"));
  assert.deepEqual(groups(ws), ["general-workspaces-a", "general-workspaces-b"]);
  assert.ok(GATE.includes("      pretested_workspaces: ${{ steps.check.outputs.pretested_workspaces }}\n"));
  for (const region of [server, ws]) assert.match(region, /\n    needs: \[gate\]\n/);
  assert.match(ws, /- name: Run grouped general test suites\n        run: pnpm test:run:general -- --group '\$\{\{ matrix\.group \}\}'\n/);
});

test("master-health's proof filter names exactly the general-server lane's proof steps", () => {
  assert.ok(SERVER_SUITES_RAN.includes('startswith("General tests (server ")'));
  assert.ok(TRIM_LANES.general_server.matrix.test("General tests (server 1/6)"));
  const named = [...SERVER_SUITES_RAN.matchAll(/\.name == "([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(named, TRIM_LANES.general_server.proofSteps);
  assert.match(GATE_RUN, /--jq "\$SERVER_SUITES_RAN"/);
  assert.match(GATE_RUN, /--jq "\$WORKSPACES_SUITES_RAN"/);
  const wsNamed = [...WORKSPACES_SUITES_RAN.matchAll(/\.name == "([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(wsNamed, ["General tests (workspaces-a)", "General tests (workspaces-b)", "Run grouped general test suites"]);
  assert.ok(!Object.values(TRIM_LANES).some((l) => (l.matrix ? l.matrix.test("General tests (workspaces-a)") || l.matrix.test("General tests (workspaces-b)") : /workspaces/.test(l.name))),
    "a trimmed workspaces lane would make WORKSPACES_SUITES_RAN accept carried-forward results");
  assert.match(GATE_RUN, /select\(\.path == "\.github\/workflows\/pr\.yml"\n\s+and \.conclusion == "success"\)/);
});
